import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_SUBSCRIPTIONS, HerdrClient, resolveSocketPath, Subscription } from './herdrClient';
import { AgentStatus, attachOrder, Model, normalize, Pane, Space } from './model';
import type { SessionSnapshotResult } from './herdrTypes';
import { HerdrPanel, PanelAction } from './panel';
import { ActivityTarget, ActivityWatcher } from './activity';
import { buildViewState, paneName } from './viewState';
import { agentLogo } from './agentLogos';
import { gitInfo } from './gitInfo';
import { isMounted, mountSpace, unmountSpace } from './folders';
import { AttachTerminals, resolveBinary } from './terminals';
import { reviewChanges } from './review';
import { showHelp } from './help';
import { HerdrActions } from './herdrActions';
import { closeInHerdr, ManageDeps, newSpace, newTab, rename } from './manage';
import { registerProfiles, SHELL_PROFILE_TITLE } from './profiles';
import { codexBinary, codexLiveUsage, ProviderUsage, readUsage } from './usage';
import { setUpClaudeUsage } from './usageSetup';

const MANAGED_KEY = 'herdr.managedWindow';
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
  let connected = false;
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

  // ---------- sync loop ----------
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
        apply(normalize(await client.request<SessionSnapshotResult>('session.snapshot')));
        if (!connected) log.appendLine('connected to herdr');
        connected = true;
      } while (again);
    } catch (e: any) {
      if (connected) log.appendLine(`lost herdr: ${e?.message ?? e}`);
      connected = false;
      model = undefined;
      render();
      renderStatus();
    } finally {
      inFlight = false;
    }
  }

  let debounce: NodeJS.Timeout | undefined;
  const scheduleRefresh = () => {
    clearTimeout(debounce);
    debounce = setTimeout(refresh, 120);
  };

  function startEvents() {
    if (sub || !connected) return;
    sub = client.subscribe(
      DEFAULT_SUBSCRIPTIONS,
      () => scheduleRefresh(),
      (err) => {
        sub = undefined;
        if (eventsLive || err) log.appendLine(`event stream ended${err ? `: ${err.message}` : ''}; polling`);
        eventsLive = false;
        scheduleRefresh(); // events_lost or reconnect => re-read authoritative state
      },
    );
    eventsLive = true;
  }

  // Poll fast while there's no event stream, slowly as a safety net when there is.
  let ticks = 0;
  const poller = setInterval(() => {
    ticks++;
    if (!eventsLive || ticks % 10 === 0) refresh().then(startEvents);
  }, 1500);

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
    if (!connected || !model) {
      status.text = '$(debug-disconnect) herdr';
      status.tooltip = 'Herdr server not reachable — click to retry';
      status.command = 'herdr.refresh';
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
    if (!model?.spaces.length) {
      vscode.window.showWarningMessage('Herdr: no spaces (is the server running?)');
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
    }),
    log,
    panel,
    vscode.window.registerWebviewViewProvider(HerdrPanel.viewId, panel),
    panel.onDidChangeVisibility((visible) => visible && (render(), pollActivity(), pollUsage())),
    status,
    terms,
    { dispose: () => { clearInterval(poller); clearInterval(redrawTimer); clearInterval(activityTimer); clearInterval(usageTimer); clearTimeout(renderTimer); sub?.dispose(); } },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('herdr')) return;
      render();
      if (e.affectsConfiguration('herdr.showShellPanes')) pollActivity();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => render()),
    vscode.workspace.onDidGrantWorkspaceTrust(() => render()),

    vscode.commands.registerCommand('herdr.refresh', () => refresh().then(startEvents)),

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
      setTimeout(() => refresh().then(startEvents), 1500);
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
  }

  refresh().then(startEvents);
}

export function deactivate() {}
