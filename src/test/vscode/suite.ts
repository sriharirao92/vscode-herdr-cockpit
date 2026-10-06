// Runs inside the test editor started by run.ts: the hub window, against the throwaway hb-vsc Herdr session.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const SESSION = process.env.HERDR_HUB_TEST_SESSION ?? '';
const [S1, S2] = (process.env.HERDR_HUB_TEST_SPACES ?? '').split(',');
const BIN = process.env.HERDR_BIN ?? 'herdr';

// The editor runs with a temporary HOME (its hub window); the herdr CLI needs the real one to find the session.
const herdr = (...args: string[]) =>
  JSON.parse(execFileSync(BIN, args, { env: { ...process.env, HOME: process.env.HERDR_HUB_TEST_REAL_HOME, HERDR_SESSION: SESSION }, encoding: 'utf8' }));
const panesOf = (ws: string): string[] =>
  herdr('api', 'snapshot')
    .result.snapshot.panes.filter((p: any) => p.workspace_id === ws)
    .map((p: any) => p.pane_id);
const pane = (id: string): any => herdr('api', 'snapshot').result.snapshot.panes.find((p: any) => p.pane_id === id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await ok()) return;
    } catch {
      // not yet
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for: ${what}`);
}
const hubStatus = () => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.herdr-hub', 'status', `${vscode.env.uriScheme}.json`), 'utf8'));
/** Herdr Hub's tabs: drawn by the extension (a pty), never a shell process. */
const ours = () => vscode.window.terminals.filter((t) => 'pty' in (t.creationOptions as object));
const step = (s: string) => console.log(`[herdr-hub test] ${s}`);

export async function run(): Promise<void> {
  try {
    await steps();
  } catch (e) {
    console.log('folders:', JSON.stringify(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)));
    console.log('terminals:', JSON.stringify(vscode.window.terminals.map((t) => ({ name: t.name, pty: 'pty' in (t.creationOptions as object), opts: Object.keys(t.creationOptions), exit: t.exitStatus }))));
    console.log('active terminal:', vscode.window.activeTerminal?.name);
    for (const t of vscode.window.terminals) console.log(`exit ${t.name}:`, JSON.stringify(t.exitStatus));
    for (const t of ours()) {
      const pty: any = (t.creationOptions as vscode.ExtensionTerminalOptions).pty;
      const b = pty.screen?.term.buffer.active;
      const lines = b ? Array.from({ length: pty.screen.rows }, (_, y) => b.getLine(b.viewportY + y)?.translateToString(true)).filter((l: string) => l?.trim()) : 'no screen';
      console.log(`tab ${t.name}: ended=${pty.ended} stream=${!!pty.stream} size=${pty.screen?.cols}x${pty.screen?.rows} screen=`, JSON.stringify(lines));
    }
    console.log('default profile:', JSON.stringify(vscode.workspace.getConfiguration('terminal.integrated').inspect(`defaultProfile.${process.platform === 'darwin' ? 'osx' : 'linux'}`)));
    try {
      console.log('herdr panes S1:', JSON.stringify(panesOf(S1)), 'status:', JSON.stringify(hubStatus()));
    } catch (x) {
      console.log('status unavailable', x);
    }
    throw e;
  }
}

async function steps(): Promise<void> {
  await vscode.extensions.getExtension('sriharirao.herdr-hub')!.activate();
  assert.strictEqual(vscode.workspace.workspaceFile?.fsPath, path.join(os.homedir(), '.herdr-hub', 'herdr-hub.code-workspace'), 'runs in the hub window');
  await until('connected to Herdr', () => hubStatus().connected === true);
  step('connected');

  // 0. The Welcome page (open in a new window) is closed when a space opens.
  await vscode.commands.executeCommand('workbench.action.openWalkthrough');
  await until('the Welcome page', () => vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Welcome')));

  // 1. Switching to a space opens its pane as a built-in tab.
  await vscode.commands.executeCommand('herdr.switchSpace', { spaceId: S1 });
  try {
    await until('the space tab', () => ours().length === 1);
  } catch (e) {
    console.log('folders:', JSON.stringify(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)));
    console.log('terminals:', JSON.stringify(vscode.window.terminals.map((t) => ({ name: t.name, pty: 'pty' in (t.creationOptions as object), exit: t.exitStatus }))));
    console.log('status:', JSON.stringify(hubStatus()));
    throw e;
  }
  const first = ours()[0];
  assert.strictEqual(vscode.window.terminals.length, 1, 'no other terminals');
  await until('the Welcome page closed', () => !vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => t.label === 'Welcome')), 5000);
  step('switch space: built-in tab opened, Welcome page closed');

  // 2. The editor group's "+" (default profile "Herdr Shell") creates a Herdr tab and a built-in tab, tracked.
  first.show();
  await sleep(300);
  await vscode.commands.executeCommand('workbench.action.createTerminalEditorSameGroup');
  await until('"+" created a Herdr tab and a built-in tab', () => ours().length === 2 && panesOf(S1).length === 2);
  const plus = ours().find((t) => t !== first)!;
  await until('the "+" tab is tracked', () => hubStatus().tabs === 2);
  step('"+": Herdr tab created, built-in tab, tracked');

  // 3. Selecting in it copies (double-click a word).
  const pty: any = (plus.creationOptions as vscode.ExtensionTerminalOptions).pty;
  pty.handleInput('echo SELECT-ME-42\r');
  const rowOf = () => {
    const b = pty.screen.term.buffer.active;
    for (let y = 0; y < pty.screen.rows; y++) if (b.getLine(b.viewportY + y)?.translateToString(true).trimEnd() === 'SELECT-ME-42') return y; // Herdr paints rows with real spaces
    return -1;
  };
  await until('the output row', () => rowOf() >= 0);
  const y = rowOf() + 1;
  const saved = await vscode.env.clipboard.readText();
  try {
    pty.handleInput(`\x1b[<0;3;${y}M\x1b[<0;3;${y}m`);
    pty.handleInput(`\x1b[<0;3;${y}M\x1b[<0;3;${y}m`);
    await until('the word on the clipboard', async () => (await vscode.env.clipboard.readText()) === 'SELECT-ME-42', 5000);
  } finally {
    await vscode.env.clipboard.writeText(saved);
  }
  step('double-click copied the word');

  // 3b. Renaming the tab (its Rename... = renameWithArg on the active terminal) renames the pane in Herdr.
  const plusPane = panesOf(S1).find((id) => id !== panesOf(S1)[0])!;
  plus.show();
  await sleep(300);
  await vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: 'logs here' });
  await until('the pane renamed in Herdr', () => pane(plusPane)?.label === 'logs here');
  step('renaming a tab renamed the pane in Herdr');

  // 3c. A pane renamed in Herdr renames its tab, without taking focus.
  const firstPane = panesOf(S1).find((id) => id !== plusPane)!;
  herdr('pane', 'rename', firstPane, 'from herdr');
  await until('the tab renamed (Herdr sends no rename event: the 5s poll picks it up)', () => first.name === 'from herdr', 12_000);
  assert.strictEqual(vscode.window.activeTerminal, plus, 'focus stayed on the active tab');
  step('a pane renamed in Herdr renamed its tab, focus unchanged');

  // 3d. Split Terminal on a Herdr tab splits that pane in Herdr (same Herdr tab), in a new editor group.
  first.show();
  await sleep(300);
  const groups = vscode.window.tabGroups.all.length;
  await vscode.commands.executeCommand('workbench.action.terminal.split');
  await until('the split pane in Herdr', () => panesOf(S1).length === 3);
  const splitPane = panesOf(S1).find((id) => id !== firstPane && id !== plusPane)!;
  assert.strictEqual(pane(splitPane).tab_id, pane(firstPane).tab_id, 'split into the same Herdr tab');
  await until('a third built-in tab, tracked', () => ours().length === 3 && hubStatus().tabs === 3);
  assert.ok(vscode.window.tabGroups.all.length > groups, 'beside it, in a new editor group');
  step('Split Terminal split the pane in Herdr');

  // 4. Closing the tab yourself (its X: close that exact tab) closes the idle shell in Herdr.
  const plusTab = vscode.window.tabGroups.all.flatMap((g) => g.tabs).find((t) => t.input instanceof vscode.TabInputTerminal && t.label === 'logs here');
  assert.ok(plusTab, 'the tab is in the editor area');
  await vscode.window.tabGroups.close(plusTab);
  await until('the tab closed', () => !ours().includes(plus));
  assert.strictEqual(plus.exitStatus?.reason, vscode.TerminalExitReason.User, 'closed by the user');
  await until('the pane closed in Herdr', () => panesOf(S1).length === 2 && !panesOf(S1).includes(plusPane));
  step('closing the tab closed the shell in Herdr');

  // 5. Switching spaces only detaches: the first space's pane keeps running.
  await vscode.commands.executeCommand('herdr.switchSpace', { spaceId: S2 });
  await until('the other space tab', () => ours().length === 1 && ours()[0] !== first);
  assert.strictEqual(first.exitStatus?.reason, vscode.TerminalExitReason.Extension);
  await sleep(500);
  assert.strictEqual(panesOf(S1).length, 2, 'still running in Herdr');
  step('switching spaces only detached');

  // 6. A pane closed in Herdr closes its tab here (reason Extension: nothing is closed back in Herdr).
  const s2tab = ours()[0];
  herdr('pane', 'close', panesOf(S2)[0]);
  await until('the tab of the closed pane closed', () => !ours().includes(s2tab));
  assert.strictEqual(s2tab.exitStatus?.reason, vscode.TerminalExitReason.Extension);
  assert.strictEqual(panesOf(S1).length, 2, 'other spaces untouched');
  step('a pane closed in Herdr closed its tab');
}
