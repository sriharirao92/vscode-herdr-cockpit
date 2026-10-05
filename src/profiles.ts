// Herdr terminal profiles: the VS Code "+" button (and its ∨ dropdown) creating Herdr tabs.
// VS Code asks a profile provider how to launch the terminal; we create the tab in Herdr first and
// answer "attach to it". In the hub window "Herdr Shell" is the default profile, so a plain "+"
// does this; elsewhere the profiles are in the dropdown.
import * as vscode from 'vscode';
import * as path from 'path';
import { agentTitle } from './herdrActions';
import { ManageDeps, pickAgent, startAgent } from './manage';
import type { Space } from './model';

/** Must match package.json contributes.terminal.profiles. */
export const SHELL_PROFILE_TITLE = 'Herdr Shell';
const PROFILES: { id: string; kind?: string; pick?: boolean }[] = [
  { id: 'herdr.shell' },
  { id: 'herdr.agent.claude', kind: 'claude' },
  { id: 'herdr.agent.codex', kind: 'codex' },
  { id: 'herdr.agent.kiro', kind: 'kiro' },
  { id: 'herdr.agent.cursor', kind: 'cursor' },
  { id: 'herdr.agent.other', pick: true },
];

export interface ProfileDeps extends ManageDeps {
  /** Which space a new terminal goes to; undefined when Herdr isn't reachable or none was chosen. */
  targetSpace(): Promise<Space | undefined>;
  binary(): string;
  adopt(paneId: string, spaceId: string, term: vscode.Terminal): void;
}

/** A normal login shell, for when Herdr can't take the terminal. */
function localShell(reason: string): vscode.TerminalProfile {
  vscode.window.showWarningMessage(`Herdr: ${reason} Opened a local shell instead.`);
  const shell = process.env.SHELL || '/bin/zsh';
  return new vscode.TerminalProfile({ name: path.basename(shell), shellPath: shell, shellArgs: ['-l'] });
}

export function registerProfiles(deps: ProfileDeps): vscode.Disposable {
  /** terminal_id -> pane we created for a profile terminal, until VS Code opens that terminal. */
  const pending = new Map<string, { paneId: string; spaceId: string; kind?: string; where: string }>();

  const provide = async (p: (typeof PROFILES)[number]): Promise<vscode.TerminalProfile> => {
    const kind = p.pick ? await pickAgent(deps, 'New agent tab') : p.kind;
    if (p.pick && !kind) return localShell('no agent chosen.');
    const space = await deps.targetSpace();
    if (!space) return localShell("isn't reachable, or no space was chosen.");
    try {
      const { tab, pane } = await deps.actions.createTab({
        workspace_id: space.id,
        cwd: space.cwd,
        label: kind ? agentTitle(kind) : undefined,
      });
      pending.set(pane.terminal_id, { paneId: pane.pane_id, spaceId: space.id, kind, where: space.label });
      return new vscode.TerminalProfile({
        // Same name the sidebar will show for this pane (see paneName()).
        name: kind ? agentTitle(kind) : /^\d+$/.test(tab.label) ? `Tab ${tab.label}` : tab.label,
        shellPath: deps.binary(),
        shellArgs: ['terminal', 'attach', pane.terminal_id],
        cwd: space.cwd,
        iconPath: deps.agentIcon(kind) ?? new vscode.ThemeIcon('terminal'),
        isTransient: true,
        // Keeps Python Environments from typing `source .venv/bin/activate` into it (and into an
        // agent started there). Revealed below once VS Code opens it, where "+" was clicked.
        hideFromUser: true,
      });
    } catch (e) {
      deps.log(`profile ${p.id}: ${e instanceof Error ? e.message : e}`);
      return localShell(`couldn't create a tab in ${space.label}.`);
    }
  };

  return vscode.Disposable.from(
    ...PROFILES.map((p) => vscode.window.registerTerminalProfileProvider(p.id, { provideTerminalProfile: () => provide(p) })),
    vscode.window.onDidOpenTerminal((term) => {
      const args = (term.creationOptions as vscode.TerminalOptions).shellArgs;
      const id = Array.isArray(args) && args[0] === 'terminal' && args[1] === 'attach' ? args[2] : undefined;
      const hit = id && pending.get(id);
      if (!hit) return;
      pending.delete(id);
      deps.adopt(hit.paneId, hit.spaceId, term);
      term.show();
      if (hit.kind) startAgent(deps, hit.paneId, hit.kind, hit.where);
    }),
  );
}
