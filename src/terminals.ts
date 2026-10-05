// Each Herdr agent/pane becomes a native VS Code terminal running
// `herdr agent attach <pane>` (or `herdr terminal attach <terminal_id>`).
// Closing the VS Code terminal only detaches; the process keeps running in Herdr.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Pane } from './model';

export function resolveBinary(override?: string): string {
  if (override) return override.startsWith('~') ? path.join(os.homedir(), override.slice(1)) : override;
  // GUI-launched VS Code on macOS often lacks Homebrew in PATH, so probe common spots.
  const candidates = [
    '/opt/homebrew/bin/herdr',
    '/usr/local/bin/herdr',
    path.join(os.homedir(), '.local/bin/herdr'),
    path.join(os.homedir(), '.cargo/bin/herdr'),
    path.join(os.homedir(), '.nix-profile/bin/herdr'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? 'herdr';
}

interface Entry {
  term: vscode.Terminal;
  spaceId: string;
}

/** How a pane's terminal tab looks: same name as its row in the sidebar, agent logo as the icon. */
export interface TerminalLook {
  name: string;
  iconPath: vscode.TerminalOptions['iconPath'];
}

export class AttachTerminals implements vscode.Disposable {
  private byPane = new Map<string, Entry>();
  private sub: vscode.Disposable;

  constructor(
    private binary: () => string,
    private location: () => 'editor' | 'panel',
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

  has(paneId: string) {
    return this.byPane.has(paneId);
  }

  attach(pane: Pane, opts: { preserveFocus?: boolean; startingAs?: string } = {}): vscode.Terminal | undefined {
    const existing = this.byPane.get(pane.id);
    if (existing) {
      existing.term.show(opts.preserveFocus);
      return existing.term;
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
    const location =
      this.location() === 'editor'
        ? { viewColumn: vscode.ViewColumn.Active, preserveFocus: !!opts.preserveFocus }
        : vscode.TerminalLocation.Panel;
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
