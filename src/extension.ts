import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HerdrClient, resolveSocketPath, Subscription, subscriptionsFor } from './herdrClient';
import { AgentStatus, attachOrder, Model, normalize, Pane, Space } from './model';
import type { SessionSnapshotResult } from './herdrTypes';
import { HerdrPanel, PanelAction } from './panel';
import { ActivityTarget, ActivityWatcher } from './activity';
import { buildViewState, paneName, ViewConnection } from './viewState';
import { agentLogo } from './agentLogos';
import { gitInfo } from './gitInfo';
import { isMounted, mountSpace, unmountSpace } from './folders';
import { AttachTerminals } from './terminals';
import { backoffDelay, binaryFound, diagnose, Diagnosis, DownReason, herdrEnv, resolveBinary, serverStatus, startServer } from './connection';
import { HERDR_PROTOCOL } from './herdrTypes';
import { reviewChanges } from './review';
import { showHelp } from './help';
import { HerdrActions } from './herdrActions';
import { closeInHerdr, ManageDeps, newSpace, newTab, rename } from './manage';
import { registerProfiles, SHELL_PROFILE_TITLE } from './profiles';
import { codexBinary, codexLiveUsage, ProviderUsage, readUsage } from './usage';
import { setUpClaudeUsage } from './usageSetup';

const MANAGED_KEY = 'herdr.managedWindow';
const REVEALED_KEY = 'herdr.hubViewRevealed';

/** The extension's view of the Herdr server. */
export type Conn =
  | { kind: 'connecting' }
  | { kind: 'connected'; protocol?: number; version?: string }
  | { kind: 'reconnecting'; since: number }
  | { kind: 'starting' }
  | ({ kind: 'down' } & Diagnosis);

/** One line per reason Herdr is unreachable (status bar, menus). */
const DOWN_TEXT: Record<DownReason, string> = {
  'not-installed': "Herdr isn't installed.",
  'not-running': "Herdr isn't running.",
  crashed: 'Herdr stopped unexpectedly.',
  incompatible: "This Herdr version isn't compatible with Herdr Hub.",
  unreachable: "Herdr is running but isn't answering.",
};
/** terminal.integrated.defaultProfile.<key> for this OS. */
const PLATFORM_KEY = process.platform === 'darwin' ? 'osx' : process.platform === 'win32' ? 'windows' : 'linux';
/** Only task terminals get a description; others show just their name. */
const HUB_TAB_DESCRIPTION = '${task}';

/** What a command acts on: from the webview, its context menu, or nothing (then ask). */
type Target = { spaceId?: string; paneId?: string };

/** Webview action -> command id. */
const PANEL_COMMANDS: Record<string, string> = {
  switch: 'herdr.switchSpace',
  pinSpace: 'herdr.pinSpace',
  unmountSpace: 'herdr.unmountSpace',
  attach: 'herdr.attach',
  review: 'herdr.reviewChanges',
  attention: 'herdr.focusAttention',
  toggleShellPanes: 'herdr.toggleShellPanes',
  openSettings: 'herdr.openSettings',
  openHelp: 'herdr.openHelp',
  setupClaudeUsage: 'herdr.setupClaudeUsage',
  setKiroCredits: 'herdr.setKiroCredits',
  newTab: 'herdr.newTab',
  newSpace: 'herdr.newSpace',
  openTui: 'herdr.openTui',
  refresh: 'herdr.refresh',
  setupHub: 'herdr.setupHub',
  startServer: 'herdr.startServer',
  copyDiagnostics: 'herdr.copyDiagnostics',
  openInstallDocs: 'herdr.openInstallDocs',
};

export function activate(ctx: vscode.ExtensionContext) {
  const cfg = () => vscode.workspace.getConfiguration('herdr');
  const log = vscode.window.createOutputChannel('Herdr Hub');
  const client = new HerdrClient(() => resolveSocketPath(cfg().get<string>('socketPath')));
  // When did each agent enter its current state? (observed locally; Herdr exposes only a sequence number)
  const stateSince = new Map<string, { status?: AgentStatus; at: number }>();
  const showShells = () => cfg().get<boolean>('showShellPanes', true);
  const panel = new HerdrPanel(ctx.extensionUri, (a: PanelAction) => {
    const id = PANEL_COMMANDS[a.command];
    if (id) vscode.commands.executeCommand(id, { spaceId: a.spaceId, paneId: a.paneId } satisfies Target);
  });
  const activity = new ActivityWatcher(client);
  const logoUri = (f: string) => vscode.Uri.joinPath(ctx.extensionUri, 'media', 'agent-logos', `${f}.svg`);
  /** The agent's logo as a tab / quick pick icon, or undefined when there's none. */
  const agentIcon = (kind?: string) => {
    const logo = agentLogo(kind);
    return !logo ? undefined : logo.mono ? { light: logoUri(`${logo.file}-light`), dark: logoUri(`${logo.file}-dark`) } : logoUri(logo.file);
  };
  const terms = new AttachTerminals(
    () => resolveBinary(cfg().get<string>('binaryPath')),
    () => cfg().get<'editor' | 'panel'>('terminalLocation', 'editor'),
    (pane, startingAs) => {
      const tab = model?.spaces.flatMap((s) => s.tabs).find((t) => t.id === pane.tabId);
      const kind = pane.isAgent ? pane.agentKind : startingAs;
      return {
        name: paneName(tab, pane),
        iconPath: agentIcon(kind) ?? new vscode.ThemeIcon(pane.isAgent ? 'hubot' : 'terminal'),
      };
    },
    () => scheduleRender(),
  );
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'herdr.focusAttention';
  status.show();

  let model: Model | undefined;
  let eventsLive = false;
  let sub: Subscription | undefined;
  let lastStatus = new Map<string, AgentStatus | undefined>();
  let lastFocusedSpace: string | undefined;
  let firstLoad = true;
  let switching = false;

  // The hub is our own ~/.herdr-hub workspace; a repo's settings claiming `herdr.hubWindow` don't make it one
  // (the hub writes terminal settings into its workspace file).
  const hubFile = path.join(os.homedir(), '.herdr-hub', 'herdr-hub.code-workspace');
  const isHubWindow = () => !!cfg().get<boolean>('hubWindow') && vscode.workspace.workspaceFile?.fsPath === hubFile;
  const isManagedWindow = () => isHubWindow() || ctx.workspaceState.get<boolean>(MANAGED_KEY, false);
  // git reads each repo's own config; only run it once the window is trusted (see gitInfo.ts).
  const git = (cwd?: string) => (vscode.workspace.isTrusted ? gitInfo(cwd, scheduleRender) : undefined);

  // ---------- connection ----------
  // connecting (startup) / connected → request fails → reconnecting: keep the last view, greyed, for a few
  // seconds (Herdr updates hand off live) → down: diagnose why (connection.ts) and keep retrying with backoff.
  const RECONNECT_GRACE_MS = 4000;
  const socketPath = () => resolveSocketPath(cfg().get<string>('socketPath'));
  const binary = () => resolveBinary(cfg().get<string>('binaryPath'));
  const herdrEnvNow = () => herdrEnv(cfg().get<string>('socketPath') || undefined);
  let conn: Conn = { kind: 'connecting' };
  let failures = 0;
  let lastDiagnosis = 0;
  /** The space whose tabs were open when Herdr went away, to offer reopening them. */
  let lostSpace: { id: string; label: string } | undefined;
  let lostNotified = false;
  const isConnected = () => conn.kind === 'connected';

  let inFlight = false;
  let again = false;
  async function refresh() {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    try {
      do {
        again = false;
        const res = await client.request<SessionSnapshotResult>('session.snapshot');
        const next = normalize(res);
        const wasConnected = isConnected();
        conn = { kind: 'connected', protocol: res.snapshot.protocol, version: res.snapshot.version };
        failures = 0;
        apply(next);
        if (!wasConnected) onConnected();
        // Panes came or went: move the live subscription to the new set. (Only a live one: restarting a
        // failed stream is the poll's job, so a stream that keeps failing can't loop through here.)
        if (sub && paneIdsOf(next).join(' ') !== subscribedPanes) startEvents();
      } while (again);
    } catch (e) {
      await onFailure(e);
    } finally {
      inFlight = false;
    }
  }

  function onConnected() {
    log.appendLine(`connected to herdr ${conn.kind === 'connected' ? (conn.version ?? '') : ''}`.trim());
    stopWatchingSocket();
    lostNotified = false;
    const lost = lostSpace;
    lostSpace = undefined;
    if (lost) offerReopen(lost);
  }

  async function onFailure(e: unknown) {
    failures++;
    const now = Date.now();
    if (conn.kind === 'connected') {
      log.appendLine(`lost herdr: ${e instanceof Error ? e.message : e}`);
      const attached = terms.spaces()[0];
      const sp = model?.spaces.find((s) => s.id === attached);
      lostSpace = sp ? { id: sp.id, label: sp.label } : undefined;
      conn = { kind: 'reconnecting', since: now };
      render();
      renderStatus();
      return;
    }
    if (conn.kind === 'starting') return; // startHerdr owns the state until it's done
    if (conn.kind === 'reconnecting' && now - conn.since < RECONNECT_GRACE_MS) return;
    const lost = conn.kind === 'reconnecting';
    // Diagnosing runs `herdr status`; while it stays down, do that at most every 10s.
    if (conn.kind === 'down' && now - lastDiagnosis < 10_000) return;
    lastDiagnosis = now;
    const before = conn.kind === 'down' ? conn.reason : undefined;
    model = undefined;
    conn = { kind: 'down', ...(await diagnose(binary(), socketPath(), !!cfg().get<string>('socketPath'), herdrEnvNow(), e)) };
    if (conn.reason !== before) log.appendLine(`herdr unavailable: ${conn.reason}${conn.detail ? ` (${conn.detail})` : ''}`);
    render();
    renderStatus();
    watchSocket();
    if (lost && !lostNotified) notifyLost();
  }

  /** Herdr was connected and went away: say so once, since the agents stopped with it. */
  async function notifyLost() {
    if (conn.kind !== 'down') return;
    lostNotified = true;
    const msg =
      conn.reason === 'crashed'
        ? 'Herdr stopped unexpectedly. Your agents run inside Herdr, so they stopped too.'
        : conn.reason === 'not-running'
          ? 'Herdr stopped. Your agents run inside Herdr, so they stopped too.'
          : `Lost the connection to Herdr${conn.detail ? `: ${conn.detail}` : ''}.`;
    const pick = await vscode.window.showWarningMessage(msg, ...(conn.reason === 'not-running' || conn.reason === 'crashed' ? ['Start Herdr', 'Open Herdr TUI'] : ['Retry']));
    if (pick === 'Start Herdr') startHerdr();
    else if (pick === 'Open Herdr TUI') vscode.commands.executeCommand('herdr.openTui');
    else if (pick === 'Retry') kick();
  }

  /** Back after an outage: the space's tabs died with Herdr; offer to open them again. */
  async function offerReopen(lost: { id: string; label: string }) {
    if (!terms.hasExited()) return; // a quick handoff: the tabs survived
    const pick = await vscode.window.showInformationMessage(`Herdr is back. Reopen the tabs for ${lost.label}?`, 'Reopen Tabs');
    if (!pick) return;
    terms.disposeExited();
    // Pane (and possibly space) ids change when Herdr restarts; fall back to the name.
    const sp = model?.spaces.find((s) => s.id === lost.id) ?? model?.spaces.find((s) => s.label === lost.label);
    if (sp) await switchTo(sp);
    else vscode.window.showWarningMessage(`Herdr: "${lost.label}" isn't in Herdr anymore.`);
  }

  // Poll: fast without an event stream, slowly as a safety net with one, backing off while Herdr is down.
  let pollTimer: NodeJS.Timeout | undefined;
  function schedulePoll() {
    clearTimeout(pollTimer);
    const delay = isConnected() ? (eventsLive ? 15_000 : 1500) : conn.kind === 'reconnecting' ? 1000 : backoffDelay(failures);
    pollTimer = setTimeout(async () => {
      await refresh();
      startEvents();
      schedulePoll();
    }, delay);
  }
  /** Try right now (Retry, window focus, sidebar shown, socket appeared, Herdr started). */
  async function kick() {
    clearTimeout(pollTimer);
    lastDiagnosis = 0;
    await refresh();
    startEvents();
    schedulePoll();
  }

  // While Herdr is down, reconnect the moment its socket appears.
  let socketWatch: fs.FSWatcher | undefined;
  function watchSocket() {
    if (socketWatch) return;
    try {
      socketWatch = fs.watch(path.dirname(socketPath()), () => {
        if (!isConnected() && !inFlight && fs.existsSync(socketPath())) kick();
      });
    } catch {
      // The folder doesn't exist yet: backoff polling covers it.
    }
  }
  function stopWatchingSocket() {
    socketWatch?.close();
    socketWatch = undefined;
  }

  /** Start the headless server in the background (it outlives VS Code), then connect. */
  async function startHerdr(): Promise<boolean> {
    if (isConnected()) return true;
    const bin = binary();
    if (!binaryFound(bin)) {
      const pick = await vscode.window.showErrorMessage(`Herdr isn't installed (looked for ${bin}).`, 'Install Herdr', 'Settings');
      if (pick === 'Install Herdr') vscode.commands.executeCommand('herdr.openInstallDocs');
      else if (pick === 'Settings') vscode.commands.executeCommand('herdr.openSettings');
      return false;
    }
    const prev = conn;
    conn = { kind: 'starting' };
    render();
    renderStatus();
    const logFile = vscode.Uri.joinPath(ctx.globalStorageUri, 'herdr-server.log').fsPath;
    const r = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Herdr…' }, () =>
      startServer(bin, herdrEnvNow(), logFile),
    );
    conn = prev.kind === 'starting' ? { kind: 'connecting' } : prev;
    if (!r.ok) {
      log.appendLine(`start herdr failed: ${r.error}`);
      render();
      renderStatus();
      const pick = await vscode.window.showErrorMessage(`Herdr: couldn't start the server. ${r.error ?? ''}`, 'Show Log');
      if (pick) vscode.window.showTextDocument(vscode.Uri.file(logFile));
      return false;
    }
    log.appendLine(r.already ? 'herdr was already running' : `started herdr server in the background (log: ${logFile})`);
    await kick();
    return isConnected();
  }

  /** The hub window opened with Herdr stopped: start it, per herdr.startServer (asked once, then remembered). */
  async function maybeAutoStart() {
    if (!isHubWindow() || conn.kind !== 'down' || (conn.reason !== 'not-running' && conn.reason !== 'crashed')) return;
    const mode = cfg().get<'ask' | 'always' | 'never'>('startServer', 'ask');
    if (mode === 'never') return;
    if (mode === 'always') return void startHerdr();
    const pick = await vscode.window.showInformationMessage(
      "Herdr isn't running. Start it in the background whenever the Herdr Hub window opens?",
      'Always Start Herdr',
      'Not Now',
      'Never',
    );
    if (pick === 'Always Start Herdr') {
      await cfg().update('startServer', 'always', vscode.ConfigurationTarget.Global);
      startHerdr();
    } else if (pick === 'Never') await cfg().update('startServer', 'never', vscode.ConfigurationTarget.Global);
  }

  /** Herdr isn't connected: offer to start it. True once connected. */
  async function ensureConnected(): Promise<boolean> {
    if (isConnected()) return true;
    const pick = await vscode.window.showWarningMessage("Herdr isn't running.", 'Start Herdr');
    return pick ? startHerdr() : false;
  }

  let debounce: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  };

  // Agent status events are per pane (see subscriptionsFor), so the subscription follows the pane set.
  const paneIdsOf = (m: Model | undefined) => (m?.spaces ?? []).flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.id)));
  let subscribedPanes = '';
  function startEvents() {
    const panes = paneIdsOf(model);
    const key = panes.join(' ');
    if (sub && key !== subscribedPanes) {
      sub.dispose(); // dispose() doesn't call onEnd: no "ended" log, no fast polling
      sub = undefined;
    }
    if (sub || !isConnected()) return;
    subscribedPanes = key;
    const self: Subscription = client.subscribe(
      subscriptionsFor(panes),
      () => scheduleRefresh(),
      (err) => {
        if (sub !== self) return;
        sub = undefined;
        if (eventsLive || err) log.appendLine(`event stream ended${err ? `: ${err.message}` : ''}; polling`);
        eventsLive = false;
        scheduleRefresh(); // events_lost or reconnect => re-read authoritative state
        schedulePoll(); // poll fast again until the stream is back
      },
    );
    sub = self;
    eventsLive = true;
  }

  // ---------- sidebar ----------
  function render() {
    panel.update(
      buildViewState({
        model,
        showShells: showShells(),
        since: (id) => stateSince.get(id)?.at,
        git,
        mounted: isMounted,
        attached: (id) => terms.has(id),
        activity: (id) => activity.get(id),
        usage,
        connection: { ...(conn as object), kind: conn.kind, expectedProtocol: HERDR_PROTOCOL } as ViewConnection,
      }),
    );
  }
  let renderTimer: NodeJS.Timeout | undefined;
  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 50);
  }

  // What shells are running and what agents last said, polled only while the sidebar is visible.
  async function pollActivity() {
    if (!model || !panel.visible) return;
    const targets: ActivityTarget[] = model.spaces.flatMap((sp) =>
      sp.tabs.flatMap((t) =>
        t.panes
          .filter((p) => p.isAgent || showShells())
          .map((p): ActivityTarget => ({ paneId: p.id, kind: p.isAgent ? 'agent' : 'shell', status: p.status })),
      ),
    );
    if (await activity.poll(targets)) scheduleRender();
  }
  const activityTimer = setInterval(pollActivity, 4000);

  // Agents' plan usage from their local files: once a minute, only while the sidebar is visible.
  let usage: ProviderUsage[] = [];
  // Live Codex limits start a short-lived `codex app-server`, so ask at most every 5 minutes.
  let codexLive: { at: number; data?: ProviderUsage } = { at: 0 };
  /** Agent kinds running in Herdr right now: only their usage is shown (and read). */
  const runningKinds = () => new Set(model?.spaces.flatMap((s) => s.agents.map((a) => (a.agentKind ?? '').toLowerCase())) ?? []);
  async function pollUsage() {
    if (!panel.visible || !model) return;
    const only = runningKinds();
    if (only.has('codex') && Date.now() - codexLive.at > 5 * 60_000) {
      codexLive = { at: Date.now(), data: await codexLiveUsage(codexBinary(os.homedir())) };
      if (!codexLive.data) log.appendLine('usage: live Codex limits unavailable; using its session logs');
    }
    const opts = { codexLive: codexLive.data, only, kiroMonthlyCredits: cfg().get<number>('kiroMonthlyCredits', 0) };
    const next = await readUsage(os.homedir(), Date.now(), opts).catch((e) => {
      log.appendLine(`usage: ${e?.message ?? e}`);
      return usage;
    });
    if (JSON.stringify(next) !== JSON.stringify(usage)) {
      usage = next;
      scheduleRender();
    }
  }
  const usageTimer = setInterval(pollUsage, 60_000);

  // Keep git branch/changes fresh even without Herdr events (gitInfo re-renders when they change).
  const redrawTimer = setInterval(() => model && render(), 15000);

  // ---------- applying a new snapshot ----------
  function apply(next: Model) {
    const prev = model;
    model = next;
    renderStatus();

    // Notifications on agent transitions.
    const notifyOn = new Set(cfg().get<string[]>('notifyOn', ['blocked', 'done']));
    const nextStatus = new Map<string, AgentStatus | undefined>();
    for (const sp of next.spaces)
      for (const a of sp.agents) {
        nextStatus.set(a.id, a.status);
        const seen = stateSince.get(a.id);
        if (!seen || seen.status !== a.status) stateSince.set(a.id, { status: a.status, at: Date.now() });
        const before = lastStatus.get(a.id);
        if (!firstLoad && before && a.status && before !== a.status && notifyOn.has(a.status)) notify(sp, a);
      }
    lastStatus = nextStatus;
    for (const id of [...stateSince.keys()]) if (!nextStatus.has(id)) stateSince.delete(id);

    // Detach VS Code terminals for panes that no longer exist.
    const live = new Set(next.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes.map((p) => p.id))));
    if (live.size > 0) terms.prune(live);

    // Follow mode: Herdr focus moved (e.g. you switched spaces in the Mac terminal).
    const focused = next.focusedSpaceId;
    if (
      !firstLoad &&
      prev &&
      focused &&
      focused !== lastFocusedSpace &&
      !switching &&
      cfg().get<boolean>('followMode', true) &&
      isManagedWindow()
    ) {
      const sp = next.spaces.find((s) => s.id === focused);
      if (sp) {
        log.appendLine(`follow: herdr focused ${sp.label}`);
        switchTo(sp, { fromHerdr: true });
      }
    }
    lastFocusedSpace = focused;
    firstLoad = false;
    render();
    // New panes or a status change deserve fresh activity now, not on the next tick.
    const shape = (m?: Model) => m?.spaces.flatMap((s) => s.agents.map((a) => `${a.id}=${a.status}`).concat(s.tabs.flatMap((t) => t.panes.map((p) => p.id)))).join();
    if (shape(prev) !== shape(next)) pollActivity();
    const kinds = (m?: Model) => [...new Set(m?.spaces.flatMap((s) => s.agents.map((a) => a.agentKind)) ?? [])].sort().join();
    if (kinds(prev) !== kinds(next)) pollUsage();
  }

  async function notify(space: Space, agent: Pane) {
    const msg = `${agent.label} in ${space.label} is ${agent.status}`;
    const actions = agent.status === 'done' ? ['Review changes', 'Attach'] : ['Attach'];
    const show = agent.status === 'blocked' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const pick = await show(`Herdr: ${msg}`, ...actions);
    if (pick === 'Attach') await attachPane(space, agent);
    if (pick === 'Review changes') await reviewChanges(agent.cwd ?? space.cwd, agent.label);
  }

  function renderStatus() {
    if (!isConnected() || !model) {
      // Nothing current to count: no stale badge or "blocked" color while Herdr is away.
      panel.badge = undefined;
      status.backgroundColor = undefined;
      status.text = conn.kind === 'down' ? '$(debug-disconnect) Herdr' : `$(sync~spin) ${conn.kind === 'starting' ? 'Starting Herdr' : 'Herdr'}`;
      status.tooltip =
        conn.kind === 'down' ? `${DOWN_TEXT[conn.reason]} Click for options.` : conn.kind === 'starting' ? 'Starting Herdr…' : 'Connecting to Herdr…';
      status.command = 'herdr.connectionMenu';
      vscode.commands.executeCommand('setContext', 'herdr.connected', false);
      return;
    }
    vscode.commands.executeCommand('setContext', 'herdr.connected', true);
    const agents = model.spaces.flatMap((s) => s.agents);
    const count = (s: AgentStatus) => agents.filter((a) => a.status === s).length;
    const blocked = count('blocked');
    const done = count('done');
    const working = count('working');
    status.text = [
      `$(hubot) ${agents.length}`,
      working ? `$(sync~spin) ${working}` : '',
      blocked ? `$(warning) ${blocked}` : '',
      done ? `$(pass-filled) ${done}` : '',
    ]
      .filter(Boolean)
      .join('  ');
    status.backgroundColor = blocked ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    status.tooltip = `Herdr: ${agents.length} agents, ${working} working, ${blocked} blocked, ${done} done.\nClick to jump to the one that needs you.`;
    status.command = 'herdr.focusAttention';
    panel.badge = blocked + done ? { value: blocked + done, tooltip: `${blocked} blocked, ${done} done` } : undefined;
  }

  // ---------- actions ----------
  async function ensureMounted(space: Space, pin = false): Promise<boolean> {
    const r = await mountSpace(space, pin);
    if (r === 'no-window') {
      const pick = await vscode.window.showWarningMessage(
        'Herdr: open a folder or the Herdr hub window first, so spaces can be mounted next to it.',
        'Set up hub window',
      );
      if (pick) vscode.commands.executeCommand('herdr.setupHub');
      return false;
    }
    if (r === 'no-cwd') {
      vscode.window.showWarningMessage(`Herdr: no working directory known for space "${space.label}".`);
      return false;
    }
    if (r === 'failed') {
      vscode.window.showErrorMessage(`Herdr: VS Code refused to mount ${space.cwd}.`);
      return false;
    }
    await ctx.workspaceState.update(MANAGED_KEY, true);
    render();
    return true;
  }

  async function switchTo(space: Space, opts: { fromHerdr?: boolean; pin?: boolean; autoAttach?: boolean } = {}) {
    switching = true;
    try {
      if (!(await ensureMounted(space, !!opts.pin))) return;
      if (space.cwd) vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(space.cwd)).then(undefined, () => {});
      if (!opts.fromHerdr) {
        await client.request('workspace.focus', { workspace_id: space.id }).catch((e) => log.appendLine(`workspace.focus: ${e.message}`));
        lastFocusedSpace = space.id; // don't let follow-mode bounce us
      }
      if (!opts.pin && cfg().get<boolean>('closeTerminalsOnSwitch', true)) terms.closeOtherSpaces(space.id);
      if (opts.autoAttach ?? cfg().get<boolean>('autoAttachOnSwitch', true)) {
        // Every pane gets its own tab: agents (most urgent first), then shells in Herdr's tab order.
        // Tabs appear in the order they're opened (editor and panel alike): open all, then focus the first.
        const panes = attachOrder(space, cfg().get<boolean>('autoAttachShells', true));
        for (const p of panes) terms.attach(p, { preserveFocus: true });
        if (panes[0]) terms.attach(panes[0]);
      }
    } finally {
      switching = false;
    }
  }

  async function attachPane(space: Space, pane: Pane, startingAs?: string) {
    if (!terms.has(pane.id) && space.cwd) await switchTo(space, { autoAttach: false });
    terms.attach(pane, { startingAs });
    if (pane.isAgent) client.request('agent.focus', { target: pane.id }).catch(() => {});
  }

  const paneOf = (t?: Target): { space: Space; pane: Pane } | undefined => {
    for (const space of model?.spaces ?? [])
      for (const tab of space.tabs) {
        const pane = tab.panes.find((p) => p.id === t?.paneId);
        if (pane) return { space, pane };
      }
  };
  const spaceFrom = async (t?: Target): Promise<Space | undefined> => {
    const hit = model?.spaces.find((s) => s.id === t?.spaceId) ?? paneOf(t)?.space;
    if (hit) return hit;
    if (!isConnected()) {
      if (await ensureConnected()) return spaceFrom(t);
      return;
    }
    if (!model?.spaces.length) {
      vscode.window.showWarningMessage('Herdr: no spaces yet. Create one with the + next to Spaces.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      model.spaces.map((s) => ({ label: s.label, description: [s.status, s.cwd].filter(Boolean).join(' · '), s })),
      { title: 'Switch to Herdr space' },
    );
    return pick?.s;
  };

  // ---------- create / rename / close ----------
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const manage: ManageDeps = {
    actions: new HerdrActions(client),
    async findPane(paneId) {
      for (let i = 0; i < 15; i++) {
        await refresh();
        const hit = paneOf({ paneId });
        if (hit) return hit;
        await sleep(200);
      }
    },
    attach: attachPane,
    agentIcon,
    spaces: () => model?.spaces ?? [],
    branchOf: (cwd) => {
      const g = git(cwd);
      return g && !g.detached ? g.branch : undefined;
    },
    agentNames: () => model?.spaces.flatMap((s) => s.agents.map((a) => a.raw.agent?.name).filter((n): n is string => !!n)) ?? [],
    agents: () => cfg().get<string[]>('agents', ['claude', 'codex', 'kiro', 'cursor']),
    renameTerminal: (paneId, name) => terms.rename(paneId, name),
    ensureConnected: () => ensureConnected(),
    log: (m) => log.appendLine(m),
  };
  /** A space or pane from a sidebar/context-menu target. */
  const itemOf = (t?: Target): { space: Space; pane?: Pane } | undefined => {
    const space = model?.spaces.find((s) => s.id === t?.spaceId);
    return paneOf(t) ?? (space && { space });
  };

  /** Where a "+" terminal goes: the space of the Herdr terminal you're in, the one mounted space, Herdr's focused space, or ask. */
  async function targetSpace(): Promise<Space | undefined> {
    if (!model) await refresh();
    if (!model) return;
    const mounted = model.spaces.filter(isMounted);
    const id = terms.spaceOf(vscode.window.activeTerminal) ?? (mounted.length === 1 ? mounted[0].id : undefined) ?? model.focusedSpaceId;
    return model.spaces.find((s) => s.id === id) ?? (await spaceFrom());
  }

  ctx.subscriptions.push(
    registerProfiles({
      ...manage,
      targetSpace,
      binary: () => resolveBinary(cfg().get<string>('binaryPath')),
      adopt: (paneId, spaceId, term) => terms.adopt(paneId, spaceId, term),
      startHerdr: () => startHerdr(),
    }),
    log,
    panel,
    vscode.window.registerWebviewViewProvider(HerdrPanel.viewId, panel),
    panel.onDidChangeVisibility((visible) => {
      if (!visible) return;
      if (!isConnected()) kick();
      render();
      pollActivity();
      pollUsage();
    }),
    vscode.window.onDidChangeWindowState((w) => w.focused && !isConnected() && kick()),
    status,
    terms,
    { dispose: () => { clearTimeout(pollTimer); clearInterval(redrawTimer); clearInterval(activityTimer); clearInterval(usageTimer); clearTimeout(renderTimer); stopWatchingSocket(); sub?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('herdr')) return;
      render();
      if (e.affectsConfiguration('herdr.showShellPanes')) pollActivity();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => render()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => render()),

    vscode.commands.registerCommand('herdr.refresh', () => kick()),
    vscode.commands.registerCommand('herdr.startServer', () => startHerdr()),
    vscode.commands.registerCommand('herdr.openInstallDocs', () => vscode.env.openExternal(vscode.Uri.parse('https://herdr.dev'))),
    vscode.commands.registerCommand('herdr.copyDiagnostics', async () => {
      const st = await serverStatus(binary(), herdrEnvNow());
      const text = [
        `Herdr Hub ${ctx.extension.packageJSON.version} · VS Code ${vscode.version} · ${process.platform}`,
        `connection: ${JSON.stringify(conn)}`,
        `binary: ${binary()} (${binaryFound(binary()) ? 'found' : 'NOT FOUND'})`,
        `socket: ${socketPath()}${cfg().get<string>('socketPath') ? ' (herdr.socketPath)' : ''} (${fs.existsSync(socketPath()) ? 'exists' : 'missing'})`,
        `herdr status server: ${st ? JSON.stringify(st) : 'no answer'}`,
        `expected protocol: ${HERDR_PROTOCOL}`,
      ].join('\n');
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Herdr Hub: diagnostics copied to the clipboard.');
    }),
    vscode.commands.registerCommand('herdr.connectionMenu', async () => {
      if (isConnected()) return vscode.commands.executeCommand('herdr.focusAttention');
      const down = conn.kind === 'down' ? conn : undefined;
      type Item = vscode.QuickPickItem & { cmd: string };
      const items: Item[] = [
        ...(down?.reason === 'not-installed'
          ? [{ label: '$(link-external) Install Herdr', cmd: 'herdr.openInstallDocs' }]
          : [{ label: '$(play) Start Herdr', description: 'in the background', cmd: 'herdr.startServer' }]),
        { label: '$(window) Open Herdr TUI', cmd: 'herdr.openTui' },
        { label: '$(refresh) Retry', cmd: 'herdr.refresh' },
        { label: '$(copy) Copy Diagnostics', cmd: 'herdr.copyDiagnostics' },
        { label: '$(settings-gear) Settings', cmd: 'herdr.openSettings' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: down ? DOWN_TEXT[down.reason] : 'Connecting to Herdr…' });
      if (pick) vscode.commands.executeCommand(pick.cmd);
    }),

    vscode.commands.registerCommand('herdr.switchSpace', async (t?: Target) => {
      const sp = await spaceFrom(t);
      if (sp) await switchTo(sp);
    }),
    vscode.commands.registerCommand('herdr.pinSpace', async (t?: Target) => {
      const sp = await spaceFrom(t);
      if (sp) await switchTo(sp, { pin: true });
    }),
    vscode.commands.registerCommand('herdr.unmountSpace', async (t?: Target) => {
      const sp = await spaceFrom(t);
      if (sp) {
        await unmountSpace(sp);
        render();
      }
    }),
    vscode.commands.registerCommand('herdr.attach', async (t?: Target) => {
      const hit = paneOf(t);
      if (hit) await attachPane(hit.space, hit.pane);
    }),
    vscode.commands.registerCommand('herdr.reviewChanges', async (t?: Target) => {
      const hit = paneOf(t);
      if (hit) return reviewChanges(hit.pane.cwd ?? hit.space.cwd, hit.pane.label);
      const sp = await spaceFrom(t);
      if (sp) await reviewChanges(sp.cwd, sp.label);
    }),
    vscode.commands.registerCommand('herdr.toggleShellPanes', () =>
      cfg().update('showShellPanes', !showShells(), vscode.ConfigurationTarget.Global),
    ),
    vscode.commands.registerCommand('herdr.openHelp', () => showHelp(ctx)),
    vscode.commands.registerCommand('herdr.setKiroCredits', async () => {
      const current = cfg().get<number>('kiroMonthlyCredits', 0);
      const v = await vscode.window.showInputBox({
        title: 'Kiro monthly credits',
        prompt: "Your plan's monthly credit allowance (Kiro shows it in /usage). 0 hides the bar.",
        value: current ? String(current) : '',
        validateInput: (s) => (s.trim() === '' || (Number.isFinite(Number(s)) && Number(s) >= 0) ? undefined : 'Enter a number'),
      });
      if (v === undefined) return;
      await cfg().update('kiroMonthlyCredits', Number(v) || 0, vscode.ConfigurationTarget.Global);
      pollUsage();
    }),
    vscode.commands.registerCommand('herdr.setupClaudeUsage', async () => {
      if (await setUpClaudeUsage(os.homedir(), (m) => log.appendLine(m))) pollUsage();
    }),
    vscode.commands.registerCommand('herdr.newSpace', () => newSpace(manage)),
    vscode.commands.registerCommand('herdr.newTab', async (t?: Target) => {
      const sp = await spaceFrom(t);
      if (sp) await newTab(manage, sp);
    }),
    vscode.commands.registerCommand('herdr.rename', async (t?: Target) => {
      const it = itemOf(t);
      if (it) await rename(manage, it);
    }),
    vscode.commands.registerCommand('herdr.closeInHerdr', async (t?: Target) => {
      const it = itemOf(t);
      if (it) await closeInHerdr(manage, it);
    }),
    vscode.commands.registerCommand('herdr.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${ctx.extension.id}`),
    ),
    vscode.commands.registerCommand('herdr.showRaw', async (t?: Target) => {
      const hit = paneOf(t);
      const raw = hit ? { pane: hit.pane.raw.pane, agent: hit.pane.raw.agent, activity: activity.get(hit.pane.id) } : model?.spaces.find((s) => s.id === t?.spaceId)?.raw;
      if (!raw) return;
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(raw, null, 2) });
      vscode.window.showTextDocument(doc);
    }),
    vscode.commands.registerCommand('herdr.focusAttention', async () => {
      if (!model) return refresh();
      const rank: AgentStatus[] = ['blocked', 'done'];
      for (const s of rank)
        for (const sp of model.spaces) {
          const a = sp.agents.find((x) => x.status === s);
          if (a) return attachPane(sp, a);
        }
      vscode.window.showInformationMessage('Herdr: no agent needs attention right now.');
    }),
    vscode.commands.registerCommand('herdr.openTui', () => {
      const t = vscode.window.createTerminal({
        name: 'herdr',
        shellPath: resolveBinary(cfg().get<string>('binaryPath')),
        iconPath: new vscode.ThemeIcon('layout-sidebar-left'),
        location: { viewColumn: vscode.ViewColumn.Active },
      });
      t.show();
      setTimeout(() => kick(), 1500);
    }),
    vscode.commands.registerCommand('herdr.toggleFollow', async () => {
      const on = !cfg().get<boolean>('followMode', true);
      await cfg().update('followMode', on, vscode.ConfigurationTarget.Global);
      if (on) await ctx.workspaceState.update(MANAGED_KEY, true);
      vscode.window.setStatusBarMessage(`Herdr follow mode ${on ? 'on' : 'off'}`, 2500);
      render();
    }),
    vscode.commands.registerCommand('herdr.setupHub', async () => {
      const dir = path.join(os.homedir(), '.herdr-hub');
      fs.mkdirSync(dir, { recursive: true });
      const readme = path.join(dir, 'README.md');
      if (!fs.existsSync(readme))
        fs.writeFileSync(
          readme,
          '# Herdr hub\n\nThis folder stays as the first workspace folder so VS Code never restarts extensions when you switch Herdr spaces.\nSpaces are mounted below it as `⬢ <name>` folders.\n',
        );
      const wsFile = path.join(dir, 'herdr-hub.code-workspace');
      if (!fs.existsSync(wsFile))
        fs.writeFileSync(
          wsFile,
          JSON.stringify(
            {
              folders: [{ path: '.', name: '· herdr hub' }],
              settings: {
                'herdr.hubWindow': true,
                'files.exclude': { 'herdr-hub.code-workspace': true },
                // Hub window = editor + Herdr; hide the built-in AI chat here only.
                'chat.disableAIFeatures': true,
                'workbench.secondarySideBar.defaultVisibility': 'visible',
                'terminal.integrated.tabs.description': HUB_TAB_DESCRIPTION,
                [`terminal.integrated.defaultProfile.${PLATFORM_KEY}`]: SHELL_PROFILE_TITLE,
              },
            },
            null,
            2,
          ),
        );
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wsFile), { forceReuseWindow: false });
    }),
    vscode.commands.registerCommand('herdr.dumpSnapshot', async () => {
      try {
        const raw = await client.request('session.snapshot');
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(raw, null, 2) });
        vscode.window.showTextDocument(doc);
      } catch (e: any) {
        vscode.window.showErrorMessage(`Herdr: ${e.message}`);
      }
    }),
  );

  // Hub window: terminal tabs show just their name. VS Code's default tab description adds the cwd
  // folder ("my-project") and can't be set per terminal, so turn it off for this
  // workspace only. Set once; a value you choose later is left alone.
  // Also make "+" create Herdr tabs here: "Herdr Shell" becomes this workspace's default profile.
  // VS Code only applies a workspace default profile in a trusted workspace.
  if (isHubWindow()) {
    const term = vscode.workspace.getConfiguration('terminal.integrated');
    const once = (key: string, value: string) => {
      if (term.inspect(key)?.workspaceValue !== undefined) return;
      term.update(key, value, vscode.ConfigurationTarget.Workspace).then(undefined, (e) =>
        log.appendLine(`could not set terminal.integrated.${key}: ${e?.message ?? e}`),
      );
    };
    once('tabs.description', HUB_TAB_DESCRIPTION);
    once(`defaultProfile.${PLATFORM_KEY}`, SHELL_PROFILE_TITLE);
    if (!vscode.workspace.isTrusted) log.appendLine('hub workspace is not trusted: VS Code ignores its default terminal profile, so "+" opens local shells');
    // Open the sidebar the first time this hub window opens. Editors with a horizontal activity bar (Cursor) hide
    // extension icons behind an overflow menu, so new users can't find it. Once only: after that, wherever the
    // user put (or closed) the view is left alone.
    if (!ctx.workspaceState.get<boolean>(REVEALED_KEY)) {
      ctx.workspaceState.update(REVEALED_KEY, true);
      vscode.commands.executeCommand('herdr.spaces.focus').then(undefined, (e) => log.appendLine(`could not open the sidebar: ${e?.message ?? e}`));
    }
  }

  refresh().then(() => {
    startEvents();
    schedulePoll();
    maybeAutoStart();
  });
}

export function deactivate() {}
