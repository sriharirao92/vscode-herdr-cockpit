import * as assert from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { filterOverrides, gitInfo, parseStatus } from '../gitInfo';

// Parser: staged / modified / untracked / conflicts / upstream / ahead-behind.
const p = parseStatus(
  ['## feat/x...origin/feat/x [ahead 2, behind 1]', 'M  staged.ts', ' M modified.ts', 'MM both.ts', 'A  added.ts', '?? new.txt', 'UU conflict.ts', ''].join('\n'),
);
assert.deepStrictEqual(
  { ...p },
  { branch: 'feat/x', upstream: 'origin/feat/x', detached: false, ahead: 2, behind: 1, staged: 3, modified: 2, untracked: 1, conflicts: 1, changes: 6 },
);
assert.deepStrictEqual([parseStatus('## main\n').branch, parseStatus('## main\n').upstream], ['main', undefined]);
assert.strictEqual(parseStatus('## HEAD (no branch)\n').branch, 'detached HEAD');
assert.strictEqual(parseStatus('## No commits yet on main\n').branch, 'main');
console.log('✓ git status parsing');

// Real repo: branch, counts and last commit.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-'));
execSync('git init -q -b main && git -c user.email=a@b -c user.name=t commit -q --allow-empty -m init', { cwd: dir });
fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); fs.writeFileSync(path.join(dir, 'b.txt'), 'y');
// A repository's core.fsmonitor command must never run (it would execute on every refresh).
const marker = path.join(dir, '..', `fsmonitor-ran-${process.pid}`);
fs.writeFileSync(path.join(dir, 'hook.sh'), `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
execSync(`git config core.fsmonitor "${path.join(dir, 'hook.sh')}"`, { cwd: dir });
// Nor may a clean filter the repo's config defines (status runs it for recently touched files).
const filterMarker = path.join(dir, '..', `filter-ran-${process.pid}`);
fs.writeFileSync(path.join(dir, 'filter.sh'), `#!/bin/sh\ntouch "${filterMarker}"\ncat\n`, { mode: 0o755 });
fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=evil\n');
// A tracked file changed after commit: status passes it through the clean filter.
fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v1\n');
execSync('git -c filter.evil.clean=cat add tracked.txt .gitattributes && git -c user.email=a@b -c user.name=t -c filter.evil.clean=cat commit -q -m tracked', { cwd: dir });
execSync(`git config filter.evil.clean "${path.join(dir, 'filter.sh')}"`, { cwd: dir });
// Same size, new content: git must hash the file, which runs it through the clean filter.
fs.writeFileSync(path.join(dir, 'tracked.txt'), 'v2\n');
// Prove the setup reaches the vulnerable path: plain git status DOES run the repo's filter.
execSync('git -c core.fsmonitor=false status --porcelain', { cwd: dir });
assert.ok(fs.existsSync(filterMarker), 'test setup: plain git status should run the filter');
// Only what the sidebar's git calls do counts from here on (the setup's own git commands may have run the hooks).
fs.rmSync(filterMarker, { force: true });
fs.rmSync(marker, { force: true });
gitInfo(dir, () => {
  assert.ok(!fs.existsSync(marker), 'core.fsmonitor from the repo config was executed');
  assert.ok(!fs.existsSync(filterMarker), 'a filter from the repo config was executed');
  const info = gitInfo(dir, () => {})!;
  assert.strictEqual(info.branch, 'main'); assert.strictEqual(info.changes, 5); assert.strictEqual(info.untracked, 4); assert.strictEqual(info.modified, 1);
  assert.strictEqual(info.lastCommit?.subject, 'tracked');
  assert.strictEqual(gitInfo('/definitely/not/here', () => {}), undefined);
  console.log('✓ git branch + change count; repo fsmonitor/filter commands not executed');
  failClosed().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
});
setTimeout(() => { console.error('git test timed out'); process.exit(1); }, 4000);

// Filter discovery must fail closed: if the repo's config can't be read, or a filter can't be switched off,
// git doesn't run for that folder at all. (Global/system config off, so the user's own setup can't interfere.)
async function failClosed() {
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  assert.strictEqual(await filterOverrides('/definitely/not/here'), undefined, 'unreadable config: fail closed');
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-plain-'));
  execSync('git init -q -b main', { cwd: plain });
  assert.deepStrictEqual(await filterOverrides(plain), [], 'no filters (git config exit 1): proceed with no overrides');
  execSync(`git config "filter.we=ird.clean" cat`, { cwd: plain });
  assert.strictEqual(await filterOverrides(plain), undefined, 'a driver name that -c cannot express: fail closed');
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-git-evil-'));
  execSync('git init -q -b main && git config filter.x.clean cat', { cwd: evil });
  assert.deepStrictEqual(await filterOverrides(evil), ['-c', 'filter.x.clean=', '-c', 'filter.x.smudge=', '-c', 'filter.x.process=', '-c', 'filter.x.required=false']);
  console.log('✓ filter discovery fails closed');
}
