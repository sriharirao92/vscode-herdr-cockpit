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
import { AttachTerminals, TerminalLocationSetting } from './terminals';
import { backoffDelay, binaryFound, diagnose, Diagnosis, DownReason, herdrEnv, resolveBinary, serverStatus, sessionOfSocket, startServer } from './connection';
import { editorCli, ensureHubWorkspace, hubDir, hubWorkspaceFile, HubStatus, isInsideRoots, LINK_VERSION, LinkRequest, parseLink, removeHubStatus, takePendingLink, writeEditorRecord, writeHubStatus, writePendingLink } from './hubFiles';
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
/** The user chose to switch spaces in this (non-hub) window rather than the hub window. */
const THIS_WINDOW_KEY = 'herdr.useThisWindow';

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
/** `herdr plugin install` source of the companion plugin (plugin/ in this repository). */
const PLUGIN_SOURCE = 'sriharirao92/herdr-hub/plugin';
/** Quote for a POSIX shell. */
const shellQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
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
    () => cfg().get<TerminalLocationSetting>('terminalLocation', 'editor'),
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
  /** Set further down: write the hub window's status file for the Herdr plugin (debounced). */
  let scheduleHubStatus = () => {};
  let eventsLive = false;
  let sub: Subscription | undefined;
  let lastStatus = new Map<string, AgentStatus | undefined>();
  let lastFocusedSpace: string | undefined;
  let firstLoad = true;
  let switching = false;

  // The hub is our own ~/.herdr-hub workspace; a repo's settings claiming `herdr.hubWindow` don't make it one
  // (the hub writes terminal settings into its workspace file).
  const hubFile = hubWorkspaceFile();
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
        if (sub && [...paneIdsOf(next)].sort().join(' ') !== subscribedPanes) startEvents();
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
    const key = [...panes].sort().join(' ');
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
    scheduleHubStatus();
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
    nameOnlyTabs();
    render();
    return true;
  }

  /**
   * Switching spaces outside the hub window turns the window into an untitled workspace (or adds folders to
   * the user's own workspace). The first time, offer the hub window instead; a window with no folder can't
   * take spaces, so it goes straight to the hub. True: go ahead here.
   */
  async function useThisWindow(space: Space, pane?: Pane): Promise<boolean> {
    if (isHubWindow() || ctx.workspaceState.get<boolean>(THIS_WINDOW_KEY)) return true;
    const toHub = async () => {
      const q = new URLSearchParams({ v: String(LINK_VERSION), space: space.id, label: space.label, ...(pane && { pane: pane.id }) });
      writePendingLink(scheme, '/open', q.toString());
      await openHub();
      return false;
    };
    if (!vscode.workspace.workspaceFolders?.length) return toHub();
    const wsf = vscode.workspace.workspaceFile;
    const why = !wsf
      ? 'Switching spaces here makes this window an untitled workspace.'
      : wsf.scheme === 'untitled'
        ? 'This window is an untitled workspace.'
        : `Switching spaces here adds folders to your workspace "${vscode.workspace.name}".`;
    const pick = await vscode.window.showInformationMessage(
      `${why} Open the Herdr hub window instead?`,
      { modal: true, detail: "The hub window's first folder never changes, so switching spaces there never restarts your extensions. This window remembers your choice." },
      'Open Hub Window',
      'Use This Window',
    );
    if (pick === 'Open Hub Window') return toHub();
    if (pick !== 'Use This Window') return false;
    await ctx.workspaceState.update(THIS_WINDOW_KEY, true);
    return true;
  }

  /** False when the switch didn't happen in this window (handed to the hub window, or cancelled). */
  async function switchTo(space: Space, opts: { fromHerdr?: boolean; pin?: boolean; autoAttach?: boolean; pane?: Pane } = {}): Promise<boolean> {
    if (!opts.fromHerdr && !(await useThisWindow(space, opts.pane))) return false;
    switching = true;
    try {
      if (!(await ensureMounted(space, !!opts.pin))) return true;
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
    return true;
  }

  async function attachPane(space: Space, pane: Pane, startingAs?: string) {
    if (!terms.has(pane.id) && space.cwd && !(await switchTo(space, { autoAttach: false, pane }))) return;
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
      await openHub();
    }),
    vscode.commands.registerCommand('herdr.installPlugin', () => {
      // Herdr previews what the plugin runs and asks before installing; the user confirms in this terminal.
      const t = vscode.window.createTerminal({ name: 'Install Herdr plugin', iconPath: new vscode.ThemeIcon('extensions') });
      t.show();
      t.sendText(`${shellQuote(binary())} plugin install ${PLUGIN_SOURCE}`, true);
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

  // ---------- hub window, deep links, files for the Herdr plugin (hubFiles.ts) ----------
  const scheme = vscode.env.uriScheme;
  const extensionVersion: string = ctx.extension.packageJSON.version;

  /** Create the hub workspace if needed and open it (an editor focuses it if it's already open). */
  async function openHub(newWindow = true) {
    const file = ensureHubWorkspace({
      'herdr.hubWindow': true,
      'files.exclude': { 'herdr-hub.code-workspace': true },
      // Hub window = editor + Herdr; hide the built-in AI chat here only.
      'chat.disableAIFeatures': true,
      'workbench.secondarySideBar.defaultVisibility': 'visible',
      'terminal.integrated.tabs.description': HUB_TAB_DESCRIPTION,
      [`terminal.integrated.defaultProfile.${PLATFORM_KEY}`]: SHELL_PROFILE_TITLE,
    });
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(file), { forceNewWindow: newWindow });
  }

  /** The Herdr session this window talks to; undefined = the default session. */
  const currentSession = () => sessionOfSocket(socketPath());

  /**
   * A link from the Herdr plugin (or anywhere: links are validated in parseLink and can only pick a space,
   * pane or file). Links act in the hub window; another window hands them over and opens the hub.
   */
  async function handleLink(uri: vscode.Uri) {
    let req: LinkRequest;
    try {
      req = parseLink(uri.path, uri.query);
    } catch (e: any) {
      vscode.window.showWarningMessage(`Herdr Hub: can't open this link: ${e.message}.`);
      return;
    }
    if (!isHubWindow()) {
      writePendingLink(scheme, uri.path, uri.query);
      await openHub();
      return;
    }
    await runLink(req);
  }

  async function runLink(req: LinkRequest) {
    log.appendLine(`link: ${req.kind} ${JSON.stringify(req)}`);
    if (req.session !== undefined && req.session !== currentSession()) {
      const pick = await vscode.window.showWarningMessage(
        `This link is for the Herdr session "${req.session}", but Herdr Hub is connected to ${currentSession() ? `"${currentSession()}"` : 'the default session'}.`,
        `Switch to "${req.session}"`,
      );
      if (!pick) return;
      const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'herdr');
      await cfg().update('socketPath', path.join(base, 'sessions', req.session, 'herdr.sock'), vscode.ConfigurationTarget.Global);
      await kick();
    }
    if (req.kind === 'file') {
      // Files in your spaces, panes or open folders open directly; anything else asks.
      const roots = [
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        ...(model?.spaces ?? []).flatMap((s) => [s.cwd, ...s.tabs.flatMap((t) => t.panes.map((p) => p.cwd))]),
      ].filter((r): r is string => !!r && r !== '/' && r !== os.homedir());
      if (!isInsideRoots(req.path, roots)) {
        const ok = await vscode.window.showWarningMessage(
          `A link asks to open ${req.path}, which isn't in a Herdr space or an open folder.`,
          { modal: true },
          'Open',
        );
        if (ok !== 'Open') return;
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(req.path)).then(undefined, () => undefined);
      if (!doc) return void vscode.window.showWarningMessage(`Herdr Hub: can't open ${req.path}.`);
      const pos = new vscode.Position(Math.max(0, (req.line ?? 1) - 1), Math.max(0, (req.col ?? 1) - 1));
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false });
      return;
    }
    if (!isConnected()) await kick();
    if (!isConnected() && !(await ensureConnected())) return;
    const hit = req.pane ? paneOf({ paneId: req.pane }) : undefined;
    const sp = hit?.space ?? model?.spaces.find((s) => s.id === req.space) ?? (req.label ? model?.spaces.find((s) => s.label === req.label) : undefined);
    vscode.commands.executeCommand('herdr.spaces.focus').then(undefined, () => {});
    if (!sp) {
      if (req.space || req.label || req.pane) vscode.window.showWarningMessage(`Herdr Hub: that space or pane isn't in Herdr anymore.`);
      return;
    }
    if (req.kind === 'review') return reviewChanges(hit?.pane.cwd ?? sp.cwd, hit?.pane.label ?? sp.label);
    await ctx.workspaceState.update(MANAGED_KEY, true);
    if (terms.spaces()[0] !== sp.id || !isMounted(sp)) await switchTo(sp);
    if (hit) await attachPane(sp, hit.pane);
  }

  ctx.subscriptions.push(
    vscode.window.registerUriHandler({ handleUri: (uri) => void handleLink(uri).catch((e) => log.appendLine(`link failed: ${e?.message ?? e}`)) }),
  );

  /** A link handed over by another window of this editor. */
  function takeHandoff() {
    if (!isHubWindow()) return;
    const p = takePendingLink(scheme);
    if (!p) return;
    try {
      runLink(parseLink(p.path, p.query)).catch((e) => log.appendLine(`link failed: ${e?.message ?? e}`));
    } catch {
      // validated before it was written; a stale or edited file is ignored
    }
  }
  let handoffWatch: fs.FSWatcher | undefined;
  if (isHubWindow())
    try {
      handoffWatch = fs.watch(hubDir(), (_e, name) => {
        if (name === 'pending-link.json') setTimeout(takeHandoff, 100);
      });
    } catch {
      // no hub folder yet
    }

  // Tell the Herdr plugin this editor has Herdr Hub, and how to start it from a terminal.
  try {
    let applicationName: string | undefined;
    try {
      applicationName = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, 'product.json'), 'utf8')).applicationName;
    } catch {
      // no product.json: fall back to `code`
    }
    writeEditorRecord({
      name: vscode.env.appName,
      scheme,
      cli: editorCli(vscode.env.appRoot, applicationName),
      extensionId: ctx.extension.id,
      extensionVersion,
      linkVersion: LINK_VERSION,
      platform: process.platform,
      updated: Date.now(),
    });
  } catch (e: any) {
    log.appendLine(`could not write the editor record: ${e?.message ?? e}`);
  }

  // The hub window's state, for the plugin's status pane: written on change, plus a heartbeat.
  let lastHubStatus = '';
  let hubStatusAt = 0;
  function writeStatusNow() {
    if (!isHubWindow()) return;
    const counts = { working: 0, blocked: 0, done: 0, idle: 0 };
    for (const sp of model?.spaces ?? [])
      for (const tab of sp.tabs)
        for (const p of tab.panes) if (p.isAgent && p.status && p.status in counts) counts[p.status as keyof typeof counts]++;
    const attached = terms.spaces()[0];
    const s: Omit<HubStatus, 'updated'> = {
      editor: vscode.env.appName,
      scheme,
      pid: process.pid,
      connected: isConnected(),
      state: conn.kind === 'down' ? conn.reason : conn.kind,
      session: currentSession(),
      space: model?.spaces.find((x) => x.id === attached)?.label,
      tabs: terms.count(),
      agents: counts,
      extensionVersion,
    };
    const key = JSON.stringify(s);
    if (key === lastHubStatus && Date.now() - hubStatusAt < 30_000) return;
    lastHubStatus = key;
    hubStatusAt = Date.now();
    try {
      writeHubStatus({ ...s, updated: hubStatusAt });
    } catch {
      // best effort
    }
  }
  let hubStatusTimer: NodeJS.Timeout | undefined;
  scheduleHubStatus = () => {
    clearTimeout(hubStatusTimer);
    hubStatusTimer = setTimeout(writeStatusNow, 500);
  };
  const heartbeat = setInterval(writeStatusNow, 30_000);
  ctx.subscriptions.push({
    dispose: () => {
      clearInterval(heartbeat);
      clearTimeout(hubStatusTimer);
      handoffWatch?.close();
      if (isHubWindow()) removeHubStatus(scheme, process.pid);
    },
  });

  /**
   * Terminal tabs show just their name. The editor's default tab description adds the cwd folder
   * ("my-project") and can't be set per terminal, so turn it off for this workspace: in the hub, and in any
   * window you've switched spaces from that is a saved or untitled workspace (the setting then lives in its
   * workspace file, never in a repository's .vscode/settings.json). Set once; a value you chose is left alone.
   */
  function nameOnlyTabs() {
    const hub = isHubWindow();
    if (!hub && !(isManagedWindow() && vscode.workspace.workspaceFile)) return;
    const term = vscode.workspace.getConfiguration('terminal.integrated');
    const set = term.inspect('tabs.description');
    if (set?.workspaceValue !== undefined || (!hub && set?.globalValue !== undefined)) return;
    term.update('tabs.description', HUB_TAB_DESCRIPTION, vscode.ConfigurationTarget.Workspace).then(undefined, (e) =>
      log.appendLine(`could not set terminal.integrated.tabs.description: ${e?.message ?? e}`),
    );
  }
  nameOnlyTabs();

  // Hub window: make "+" create Herdr tabs here: "Herdr Shell" becomes this workspace's default profile.
  // VS Code only applies a workspace default profile in a trusted workspace.
  if (isHubWindow()) {
    const term = vscode.workspace.getConfiguration('terminal.integrated');
    const once = (key: string, value: string) => {
      if (term.inspect(key)?.workspaceValue !== undefined) return;
      term.update(key, value, vscode.ConfigurationTarget.Workspace).then(undefined, (e) =>
        log.appendLine(`could not set terminal.integrated.${key}: ${e?.message ?? e}`),
      );
    };
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
    takeHandoff();
  });
}

export function deactivate() {}
