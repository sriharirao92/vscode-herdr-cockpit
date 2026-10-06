// Branch, upstream sync and working-tree state per directory, cached briefly.
// Uses the git CLI directly (fast, works for folders that aren't mounted in VS Code).
import { execFile } from 'child_process';
import { findTool } from './tools';

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

const GIT = findTool('git', ['/usr/bin/git']);
const TTL_MS = 8000;
const cache = new Map<string, { at: number; info?: GitInfo; pending?: Promise<GitInfo | undefined> }>();

/**
 * Git reads each repository's own config, and some settings make even read-only commands run programs.
 * A repo copied from someone else (archive, shared drive) could then run code just by being shown in the
 * sidebar. Defense in depth, on every call (no shell is involved: execFile with an argument list):
 *  - core.fsmonitor=false                  status would run the repo's fsmonitor hook
 *  - every filter.<driver> blanked         status runs clean filters for files whose content it re-checks
 *  - log.showSignature=false               log would run gpg.program on signed commits
 *  - protocol.allow=never                  a partial clone could lazily fetch, running core.sshCommand / ext:: remotes
 *  - core.hooksPath=/dev/null              no repo hooks, should any command reach one
 *  - --ignore-submodules=all (status)      submodules carry their own config
 *  - --no-optional-locks, --no-pager       never write the index; never start a pager
 * This closes the known routes but can't be proven complete, so the real boundary is VS Code's Workspace
 * Trust: callers skip git entirely in untrusted windows (like VS Code's own git support).
 */
const SAFE = [
  '--no-pager',
  '--no-optional-locks',
  '-c', 'core.fsmonitor=false',
  '-c', 'log.showSignature=false',
  '-c', 'protocol.allow=never',
  '-c', 'core.hooksPath=/dev/null',
];

/** Exit code (or -1 when git couldn't run / timed out) and stdout. */
function exec(args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) =>
    execFile(GIT, args, { timeout: 3000, maxBuffer: 4 * 1024 * 1024 }, (err, out) =>
      resolve({ code: !err ? 0 : typeof (err as any).code === 'number' && !(err as any).killed ? (err as any).code : -1, out: out?.toString() ?? '' }),
    ),
  );
}

/**
 * `-c` overrides that disable every filter driver the repo's config defines (reading config runs nothing).
 * Fails closed: undefined (= don't run git) unless the config was read (exit 0, or 1 = no filters at all)
 * and every driver name can be overridden.
 */
export async function filterOverrides(cwd: string): Promise<string[] | undefined> {
  const { code, out } = await exec(['-C', cwd, 'config', '--null', '--get-regexp', '^filter\\.']);
  if (code !== 0 && !(code === 1 && out === '')) return undefined;
  const names = new Set<string>();
  for (const entry of out.split('\0')) {
    const key = entry.split('\n')[0];
    if (!key) continue;
    const m = /^filter\.(.+)\.[^.]+$/.exec(key);
    if (!m) return undefined; // unexpected shape: don't guess
    names.add(m[1]);
  }
  const args: string[] = [];
  for (const name of names) {
    if (/[=\s]/.test(name)) return undefined;
    for (const v of ['clean=', 'smudge=', 'process=', 'required=false']) args.push('-c', `filter.${name}.${v}`);
  }
  return args;
}

async function run(cwd: string, args: string[]): Promise<string | undefined> {
  const filters = await filterOverrides(cwd);
  if (!filters) return undefined;
  const { code, out } = await exec([...SAFE, ...filters, '-C', cwd, ...args]);
  return code === 0 ? out : undefined;
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
    // Submodules carry their own config (and filters); the sidebar doesn't need them.
    run(cwd, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal', '--ignore-submodules=all']),
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
