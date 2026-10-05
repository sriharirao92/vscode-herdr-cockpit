// Branch, upstream sync and working-tree state per directory, cached briefly.
// Uses the git CLI directly (fast, works for folders that aren't mounted in VS Code).
import { execFile } from 'child_process';
import * as fs from 'fs';

export interface GitInfo {
  branch?: string;
  /** e.g. "origin/main"; undefined when the branch doesn't track anything. */
  upstream?: string;
  detached?: boolean;
  ahead?: number;
  behind?: number;
  /** Changes in the index (ready to commit). */
  staged: number;
  /** Tracked files changed in the working tree but not staged. */
  modified: number;
  /** Untracked files. */
  untracked: number;
  /** Unmerged paths (merge/rebase conflicts). */
  conflicts: number;
  /** Total changed paths (what "Review changes" will list). */
  changes: number;
  /** Last commit on HEAD. */
  lastCommit?: { at: number; subject: string };
}

const GIT = ['/usr/bin/git', '/opt/homebrew/bin/git', '/usr/local/bin/git'].find((g) => fs.existsSync(g)) ?? 'git';
const TTL_MS = 8000;
const cache = new Map<string, { at: number; info?: GitInfo; pending?: Promise<GitInfo | undefined> }>();

function run(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile(GIT, ['-C', cwd, ...args], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
      resolve(err ? undefined : out.toString()),
    ),
  );
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Parses `git status --porcelain=v1 --branch` output. */
export function parseStatus(out: string): GitInfo {
  const lines = out.split('\n').filter(Boolean);
  // "## main...origin/main [ahead 1, behind 2]" | "## main" | "## HEAD (no branch)" | "## No commits yet on main"
  const head = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '';
  const [refs] = head.split(' [');
  let [branch, upstream] = refs.replace(/^No commits yet on /, '').split('...');
  const detached = branch?.startsWith('HEAD (no branch)');
  if (detached) branch = 'detached HEAD';
  const info: GitInfo = {
    branch: branch || undefined,
    upstream: upstream || undefined,
    detached,
    ahead: Number(/ahead (\d+)/.exec(head)?.[1] ?? 0) || undefined,
    behind: Number(/behind (\d+)/.exec(head)?.[1] ?? 0) || undefined,
    staged: 0,
    modified: 0,
    untracked: 0,
    conflicts: 0,
    changes: lines.length,
  };
  for (const l of lines) {
    const xy = l.slice(0, 2);
    if (xy === '??') info.untracked++;
    else if (UNMERGED.has(xy)) info.conflicts++;
    else {
      if (xy[0] !== ' ') info.staged++;
      if (xy[1] !== ' ') info.modified++;
    }
  }
  return info;
}

async function load(cwd: string): Promise<GitInfo | undefined> {
  const [status, log] = await Promise.all([
    run(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']),
    run(cwd, ['log', '-1', '--format=%ct%x09%s']),
  ]);
  if (status === undefined) return undefined;
  const info = parseStatus(status);
  const [ct, ...subject] = (log ?? '').trim().split('\t');
  if (ct) info.lastCommit = { at: Number(ct) * 1000, subject: subject.join('\t') };
  return info;
}

/** Returns cached info immediately (possibly stale/undefined) and refreshes in the background. */
export function gitInfo(cwd: string | undefined, onUpdate: () => void): GitInfo | undefined {
  if (!cwd) return undefined;
  const now = Date.now();
  const entry = cache.get(cwd);
  if (entry && (now - entry.at < TTL_MS || entry.pending)) return entry.info;
  const e = entry ?? { at: 0 };
  e.pending = load(cwd).then((info) => {
    const changed = JSON.stringify(info) !== JSON.stringify(e.info);
    e.info = info;
    e.at = Date.now();
    e.pending = undefined;
    if (changed) onUpdate();
    return info;
  });
  cache.set(cwd, e);
  return e.info;
}
