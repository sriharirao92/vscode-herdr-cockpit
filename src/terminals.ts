// Each Herdr agent/pane becomes a native VS Code terminal running
// `herdr agent attach <pane>` (or `herdr terminal attach <terminal_id>`).
// Closing the VS Code terminal only detaches; the process keeps running in Herdr.
import * as vscode from 'vscode';
import * as fs from 'fs';
import type { Pane } from './model';

export { resolveBinary } from './connection';

interface Entry {
  term: vscode.Terminal;
  spaceId: string;
}

/** How a pane's terminal tab looks: same name as its row in the sidebar, agent logo as the icon. */
/** herdr.terminalLocation */
export type TerminalLocationSetting = 'editor' | 'editorSplit' | 'panel';

export interface TerminalLook {
  name: string;
  iconPath: vscode.TerminalOptions['iconPath'];
}

export class AttachTerminals implements vscode.Disposable {
  private byPane = new Map<string, Entry>();
  private sub: vscode.Disposable;

  constructor(
    private binary: () => string,
    private location: () => TerminalLocationSetting,
    /** startingAs: agent kind being started in a pane that is still a plain shell. */
    private look: (pane: Pane, startingAs?: string) => TerminalLook,
    /** Called whenever the set of attached panes changes. */
    private onChange: () => void = () => {},
  ) {
    this.sub = vscode.window.onDidCloseTerminal((t) => {
      for (const [k, e] of this.byPane)
        if (e.term === t) {
          this.byPane.delete(k);
          this.onChange();
        }
    });
  }

  /** A live attach terminal is open for this pane (one whose process exited, e.g. Herdr stopped, doesn't count). */
  has(paneId: string) {
    const e = this.byPane.get(paneId);
    return !!e && e.term.exitStatus === undefined;
  }

  /** Live attach tabs. */
  count(): number {
    return [...this.byPane.values()].filter((e) => e.term.exitStatus === undefined).length;
  }

  /** Spaces that have attach terminals open (live or not), e.g. to reopen them after Herdr restarts. */
  spaces(): string[] {
    return [...new Set([...this.byPane.values()].map((e) => e.spaceId))];
  }

  /** Some attach tab's process has exited (Herdr stopped under it). */
  hasExited(): boolean {
    return [...this.byPane.values()].some((e) => e.term.exitStatus !== undefined);
  }

  /** Close tabs whose attach process has exited (Herdr stopped under them). */
  disposeExited() {
    this.closeWhere((e) => e.term.exitStatus !== undefined);
  }

  attach(pane: Pane, opts: { preserveFocus?: boolean; startingAs?: string } = {}): vscode.Terminal | undefined {
    const existing = this.byPane.get(pane.id);
    if (existing && existing.term.exitStatus === undefined) {
      existing.term.show(opts.preserveFocus);
      return existing.term;
    }
    // Its process exited (Herdr stopped or restarted): replace the dead tab with a fresh attach.
    if (existing) {
      existing.term.dispose();
      this.byPane.delete(pane.id);
    }
    const args = pane.isAgent
      ? ['agent', 'attach', pane.id, '--takeover']
      : pane.terminalId
        ? ['terminal', 'attach', pane.terminalId]
        : undefined;
    if (!args) {
      vscode.window.showWarningMessage(`Herdr: pane ${pane.id} has no terminal id to attach to.`);
      return;
    }
    // editorSplit: agents in the first editor group, shells in the second (VS Code creates it when needed).
    const where = this.location();
    const location =
      where === 'panel'
        ? vscode.TerminalLocation.Panel
        : {
            viewColumn: where === 'editorSplit' ? (pane.isAgent ? vscode.ViewColumn.One : vscode.ViewColumn.Two) : vscode.ViewColumn.Active,
            preserveFocus: !!opts.preserveFocus,
          };
    const { name, iconPath } = this.look(pane, opts.startingAs);
    const term = vscode.window.createTerminal({
      name,
      shellPath: this.binary(),
      shellArgs: args,
      cwd: pane.cwd && fs.existsSync(pane.cwd) ? pane.cwd : undefined,
      iconPath,
      location,
      isTransient: true, // don't try to restore a dead attach on window reload
      // These aren't shells: keystrokes go straight to the agent. Extensions that type into new
      // terminals (Python Environments sends `source .venv/bin/activate`) skip hideFromUser
      // terminals, so mark them; show() below reveals it in its location as usual.
      hideFromUser: true,
    });
    this.byPane.set(pane.id, { term, spaceId: pane.workspaceId });
    this.onChange();
    term.show(opts.preserveFocus);
    return term;
  }

  /**
   * Track a terminal VS Code created itself (the "+" button with a Herdr profile), so it counts as
   * attached, closes on space switch and is reused when you click its row.
   */
  adopt(paneId: string, spaceId: string, term: vscode.Terminal) {
    this.byPane.set(paneId, { term, spaceId });
    this.onChange();
  }

  /** The space of a terminal we track, e.g. the active one. */
  spaceOf(term: vscode.Terminal | undefined): string | undefined {
    for (const e of this.byPane.values()) if (e.term === term) return e.spaceId;
  }

  /** Rename an open tab after its pane was renamed (VS Code can only rename the active terminal). */
  async rename(paneId: string, name: string) {
    const e = this.byPane.get(paneId);
    if (!e) return;
    e.term.show(false);
    await vscode.commands
      .executeCommand('workbench.action.terminal.renameWithArg', { name })
      .then(undefined, () => undefined);
  }

  /** Detach (close) attach terminals belonging to other spaces. */
  closeOtherSpaces(keepSpaceId: string) {
    this.closeWhere((e) => e.spaceId !== keepSpaceId);
  }

  /** Drop terminals whose pane no longer exists in Herdr. */
  prune(livePaneIds: Set<string>) {
    this.closeWhere((_, paneId) => !livePaneIds.has(paneId));
  }

  private closeWhere(pred: (e: Entry, paneId: string) => boolean) {
    let closed = false;
    for (const [k, e] of this.byPane) {
      if (pred(e, k)) {
        e.term.dispose();
        this.byPane.delete(k);
        closed = true;
      }
    }
    if (closed) this.onChange();
  }

  dispose() {
    this.sub.dispose();
  }
}
