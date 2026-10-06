// Deep links, the hub files shared with the Herdr plugin, and tool lookup on macOS/Linux. No VS Code needed.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  editorCli,
  ensureHubWorkspace,
  hubWorkspaceFile,
  LINK_VERSION,
  isInsideRoots,
  parseLink,
  readEditorRecords,
  removeHubStatus,
  takePendingLink,
  writeEditorRecord,
  writeHubStatus,
  writePendingLink,
} from '../hubFiles';
import { findTool, toolDirs } from '../tools';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-hub-'));

// ---------- links ----------
assert.deepStrictEqual(parseLink('/open', 'space=w1&pane=w1:p2&label=api&session=work&v=1'), { kind: 'open', space: 'w1', label: 'api', pane: 'w1:p2', session: 'work' });
assert.deepStrictEqual(parseLink('/review', 'space=w2'), { kind: 'review', space: 'w2', label: undefined, pane: undefined, session: undefined });
assert.deepStrictEqual(parseLink('/file', `path=${encodeURIComponent('/repo/src/a.ts')}&line=42&col=3`), { kind: 'file', path: '/repo/src/a.ts', line: 42, col: 3, session: undefined });
assert.deepStrictEqual(parseLink('/open', ''), { kind: 'open', space: undefined, label: undefined, pane: undefined, session: undefined }, 'just open the hub');
const rejects = (p: string, q: string, re: RegExp) => assert.throws(() => parseLink(p, q), re);
rejects('/open', 'pane=w1:p1;rm -rf', /invalid pane/);
rejects('/open', 'space=../../etc', /invalid space/);
rejects('/open', 'session=a/b', /invalid session/);
rejects('/file', 'path=relative/a.ts', /absolute/);
rejects('/file', `path=${encodeURIComponent('/a\0b')}`, /absolute/);
rejects('/file', 'path=/a.ts&line=-1', /invalid line/);
rejects('/file', `path=${encodeURIComponent('//host/share/x')}`, /local/);
rejects('/file', `path=${encodeURIComponent('\\\\host\\share\\x')}`, /local/);
rejects('/run', 'cmd=ls', /unknown link "run"/);
rejects('/open', `v=${LINK_VERSION + 1}`, /newer Herdr Hub/);
assert.strictEqual(parseLink('/file', `path=${encodeURIComponent('/repo/../etc/x')}`).kind === 'file' && (parseLink('/file', `path=${encodeURIComponent('/repo/../etc/x')}`) as any).path, '/etc/x', 'normalized');
console.log('✓ links parsed and validated (ids, session, absolute file paths, unknown actions, newer versions)');

// ---------- file links: inside a space or open folder, or ask ----------
{
  const space = path.join(home, 'space');
  fs.mkdirSync(path.join(space, 'src'), { recursive: true });
  fs.writeFileSync(path.join(space, 'src', 'a.ts'), '');
  fs.symlinkSync(path.join(home), path.join(space, 'escape'));
  assert.strictEqual(isInsideRoots(path.join(space, 'src', 'a.ts'), [space]), true);
  assert.strictEqual(isInsideRoots(path.join(home, 'secret'), [space]), false);
  assert.strictEqual(isInsideRoots(`${space}-other/x`, [space]), false, 'a sibling with the same prefix');
  assert.strictEqual(isInsideRoots(path.join(space, 'escape', 'secret'), [space]), false, 'a symlink out of the space');
  assert.strictEqual(isInsideRoots(path.join(space, '..', 'secret'), [space]), false);
  assert.strictEqual(isInsideRoots(path.join(space, 'src', 'new.ts'), [space]), true, 'a missing file inside the space');
  assert.strictEqual(isInsideRoots(path.join(fs.realpathSync(space), 'src', 'a.ts'), [space]), true, 'root given via a symlinked temp dir');
  console.log('✓ file links: inside a space, not a sibling, symlink or ../ out of it');
}

// ---------- hub workspace ----------
const ws = ensureHubWorkspace({ 'herdr.hubWindow': true }, home);
assert.strictEqual(ws, hubWorkspaceFile(home));
assert.deepStrictEqual(JSON.parse(fs.readFileSync(ws, 'utf8')).settings, { 'herdr.hubWindow': true });
fs.writeFileSync(ws, '{"folders":[],"settings":{"mine":1}}');
ensureHubWorkspace({ 'herdr.hubWindow': true }, home);
assert.strictEqual(JSON.parse(fs.readFileSync(ws, 'utf8')).settings.mine, 1, 'never overwrites an existing hub workspace');
console.log('✓ hub workspace created once, never overwritten');

// ---------- editor records + CLI lookup ----------
const mac = path.join(home, 'Cursor.app', 'Contents', 'Resources', 'app');
fs.mkdirSync(path.join(mac, 'bin'), { recursive: true });
fs.writeFileSync(path.join(mac, 'bin', 'code'), '');
assert.strictEqual(editorCli(mac, 'cursor'), path.join(mac, 'bin', 'code'), 'falls back to bin/code (Kiro, Positron)');
fs.writeFileSync(path.join(mac, 'bin', 'cursor'), '');
assert.strictEqual(editorCli(mac, 'cursor'), path.join(mac, 'bin', 'cursor'), 'prefers the product name');
const linux = path.join(home, 'usr', 'share', 'code');
fs.mkdirSync(path.join(linux, 'resources', 'app'), { recursive: true });
fs.mkdirSync(path.join(linux, 'bin'));
fs.writeFileSync(path.join(linux, 'bin', 'code'), '');
assert.strictEqual(editorCli(path.join(linux, 'resources', 'app'), 'code'), path.join(linux, 'bin', 'code'), 'Linux layout: <install>/bin');
assert.strictEqual(editorCli(path.join(home, 'nowhere'), 'code'), undefined);
assert.strictEqual(editorCli(mac, '../../evil'), path.join(mac, 'bin', 'code'), 'odd names ignored');

const rec = { name: 'Cursor', scheme: 'cursor', cli: '/x/cursor', extensionId: 'sriharirao.herdr-hub', extensionVersion: '1.0.0', linkVersion: 1, platform: 'darwin', updated: 1 };
writeEditorRecord(rec, home);
writeEditorRecord({ ...rec, scheme: '../evil' }, home);
assert.deepStrictEqual(readEditorRecords(home), [rec], 'one valid record; a bad scheme is never written');
console.log('✓ editor command line found (macOS and Linux layouts), editor records');

// ---------- hub status ----------
const st = { editor: 'Cursor', scheme: 'cursor', pid: 111, connected: true, state: 'connected', tabs: 2, agents: { working: 1, blocked: 0, done: 0, idle: 1 }, extensionVersion: '1', updated: 1 };
writeHubStatus(st, home);
const stFile = path.join(home, '.herdr-hub', 'status', 'cursor.json');
removeHubStatus('cursor', 222, home);
assert.ok(fs.existsSync(stFile), "another window's status is kept");
removeHubStatus('cursor', 111, home);
assert.ok(!fs.existsSync(stFile), 'own status removed');
console.log('✓ hub status written and removed only by its owner');

// ---------- hand-off ----------
writePendingLink('cursor', '/open', 'space=w1', home);
assert.strictEqual(takePendingLink('vscode', 60_000, home), undefined, "another editor's link");
assert.deepStrictEqual(takePendingLink('cursor', 60_000, home), { path: '/open', query: 'space=w1' }, 'left for its own editor, then taken');
assert.strictEqual(takePendingLink('cursor', 60_000, home), undefined, 'taken once');
writePendingLink('cursor', '/open', 'space=w1', home);
assert.strictEqual(takePendingLink('cursor', -1, home), undefined, 'stale links are dropped');
console.log('✓ link hand-off: per editor, taken once, stale dropped');

// ---------- tools ----------
assert.strictEqual(toolDirs('/h', 'darwin')[0], '/opt/homebrew/bin');
assert.strictEqual(toolDirs('/h', 'linux')[0], '/h/.local/bin', "Herdr's installer default on Linux");
assert.ok(toolDirs('/h', 'linux').includes('/home/linuxbrew/.linuxbrew/bin'));
fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
fs.writeFileSync(path.join(home, '.local', 'bin', 'hb-fake-tool'), '');
assert.strictEqual(findTool('hb-fake-tool', [], home, 'linux'), path.join(home, '.local', 'bin', 'hb-fake-tool'));
assert.strictEqual(findTool('hb-missing-tool', [], home, 'linux'), 'hb-missing-tool', 'bare name: PATH lookup');
console.log('✓ tool lookup on macOS and Linux');

fs.rmSync(home, { recursive: true, force: true });
console.log('\nhub tests passed');
