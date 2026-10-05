// "Review changes" for a space/agent: list uncommitted changes in the agent's repo
// and open each as a HEAD <-> working tree diff. Uses VS Code's built-in git extension.
import * as vscode from 'vscode';
import * as path from 'path';

// Subset of the vscode.git API (extensions/git/src/api/git.d.ts) we rely on.
const enum Status {
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  DELETED = 6,
  UNTRACKED = 7,
}
interface Change {
  uri: vscode.Uri;
  status: number;
}
interface Repository {
  rootUri: vscode.Uri;
  state: { indexChanges: Change[]; workingTreeChanges: Change[]; untrackedChanges?: Change[] };
  status(): Promise<void>;
}
interface GitAPI {
  getRepository(uri: vscode.Uri): Repository | null;
  openRepository?(uri: vscode.Uri): Promise<Repository | null>;
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}

async function gitApi(): Promise<GitAPI | undefined> {
  const ext = vscode.extensions.getExtension<any>('vscode.git');
  if (!ext) return;
  const exports = ext.isActive ? ext.exports : await ext.activate();
  return exports?.getAPI?.(1);
}

const LETTER: Record<number, string> = { 0: 'M', 1: 'A', 2: 'D', 3: 'R', 5: 'M', 6: 'D', 7: 'U' };

async function openChange(git: GitAPI, c: Change, preview: boolean) {
  const name = path.basename(c.uri.fsPath);
  if (c.status === Status.UNTRACKED || c.status === Status.INDEX_ADDED) {
    await vscode.commands.executeCommand('vscode.open', c.uri, { preview });
  } else if (c.status === Status.DELETED || c.status === Status.INDEX_DELETED) {
    await vscode.commands.executeCommand('vscode.open', git.toGitUri(c.uri, 'HEAD'), { preview });
  } else {
    await vscode.commands.executeCommand(
      'vscode.diff',
      git.toGitUri(c.uri, 'HEAD'),
      c.uri,
      `${name} (HEAD ↔ agent)`,
      { preview },
    );
  }
}

export async function reviewChanges(cwd: string | undefined, label: string) {
  if (!cwd) {
    vscode.window.showWarningMessage(`Herdr: no working directory known for ${label}.`);
    return;
  }
  const git = await gitApi();
  if (!git) {
    vscode.window.showErrorMessage('Herdr: the built-in Git extension is disabled.');
    return;
  }
  const uri = vscode.Uri.file(cwd);
  const repo = git.getRepository(uri) ?? (await git.openRepository?.(uri)) ?? null;
  if (!repo) {
    vscode.window.showInformationMessage(`Herdr: ${cwd} is not inside a git repository.`);
    return;
  }
  await repo.status();
  const seen = new Set<string>();
  const changes = [
    ...repo.state.indexChanges,
    ...repo.state.workingTreeChanges,
    ...(repo.state.untrackedChanges ?? []),
  ].filter((c) => !seen.has(c.uri.fsPath) && seen.add(c.uri.fsPath));

  if (changes.length === 0) {
    vscode.window.showInformationMessage(`Herdr: no uncommitted changes in ${path.basename(repo.rootUri.fsPath)}.`);
    return;
  }

  type Item = vscode.QuickPickItem & { change?: Change; action?: 'all' | 'scm' };
  const items: Item[] = [
    ...(changes.length <= 20
      ? [{ label: `$(diff-multiple) Open all ${changes.length} diffs`, action: 'all' as const }]
      : []),
    { label: '$(source-control) Open Source Control view', action: 'scm' as const },
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    ...changes.map((c) => ({
      label: path.relative(repo.rootUri.fsPath, c.uri.fsPath),
      description: LETTER[c.status] ?? '•',
      change: c,
    })),
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Changes by ${label} — ${path.basename(repo.rootUri.fsPath)}`,
    matchOnDescription: true,
  });
  if (!pick) return;
  if (pick.action === 'scm') return vscode.commands.executeCommand('workbench.view.scm');
  if (pick.action === 'all') {
    for (const c of changes) await openChange(git, c, false);
    return;
  }
  if (pick.change) await openChange(git, pick.change, true);
}
