import * as assert from 'assert';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitInfo, parseStatus } from '../gitInfo';

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
gitInfo(dir, () => {
  const info = gitInfo(dir, () => {})!;
  assert.strictEqual(info.branch, 'main'); assert.strictEqual(info.changes, 2); assert.strictEqual(info.untracked, 2);
  assert.strictEqual(info.lastCommit?.subject, 'init');
  assert.strictEqual(gitInfo('/definitely/not/here', () => {}), undefined);
  console.log('✓ git branch + change count'); process.exit(0);
});
setTimeout(() => { console.error('git test timed out'); process.exit(1); }, 4000);
