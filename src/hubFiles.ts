// Files under ~/.herdr-cockpit that the extension shares with the Herdr plugin (plugin/), and the deep links the
// plugin opens. No vscode imports. (Before the rename to Herdr Cockpit, from Herdr Hub, this was ~/.herdr-hub: its
// workspace is still recognized as the Cockpit window, see legacyHubWorkspaceFile.)
//
//   herdr-cockpit.code-workspace   the Cockpit window's workspace (folder slot 0 = ~/.herdr-cockpit)
//   editors/<scheme>.json      one per editor the extension has run in: how the plugin finds its command line
//   status/<scheme>.json       the Cockpit window's live state, for the plugin's status pane
//   pending-link.json          a link that reached another window, handed to the Cockpit window
//
// Links: <scheme>://<publisher>.herdr-cockpit/<action>?<query>, where <scheme> is the editor's (vscode, cursor,
// kiro, positron, ...). Every field is validated here: a link can come from any web page, so it may only
// pick things the user already has (a space, a pane, a file), never a program or a setting. A file outside
// the user's spaces and open folders needs a confirmation (isInsideRoots); network paths are refused.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Bump when the link format changes incompatibly; the plugin compares it with what it speaks. */
export const LINK_VERSION = 1;

export const hubDir = (home = os.homedir()) => path.join(home, '.herdr-cockpit');
export const hubWorkspaceFile = (home?: string) => path.join(hubDir(home), 'herdr-cockpit.code-workspace');
/** The hub workspace from before the rename (Herdr Hub): a window restored with it is still the Cockpit window. */
/** The name before the rename to Herdr Cockpit, for the legacy paths below. */
export const LEGACY_NAME = ['herdr', 'hub'].join('-');
export const legacyHubWorkspaceFile = (home = os.homedir()) => path.join(home, `.${LEGACY_NAME}`, `${LEGACY_NAME}.code-workspace`);

/** Create ~/.herdr-cockpit and its workspace file if missing (never overwrites). Returns the workspace file. */
export function ensureHubWorkspace(settings: Record<string, unknown>, home?: string): string {
  const dir = hubDir(home);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme))
    fs.writeFileSync(
      readme,
      '# Herdr Cockpit\n\nThis folder stays as the first workspace folder so the editor never restarts extensions when you switch Herdr spaces.\nSpaces are mounted below it as `⬢ <name>` folders.\n',
    );
  const file = hubWorkspaceFile(home);
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ folders: [{ path: '.', name: '· herdr cockpit' }], settings }, null, 2));
  return file;
}

/** Write via a temp file and rename, so a reader never sees half a file. */
function writeJson(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}
function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

const SCHEME = /^[a-z][a-z0-9+.-]{0,31}$/;

// ---------- editors ----------

export interface EditorRecord {
  /** Display name, e.g. "Visual Studio Code", "Cursor". */
  name: string;
  /** URL scheme, e.g. "vscode", "cursor". */
  scheme: string;
  /** The editor's command-line launcher, when found. */
  cli?: string;
  extensionId: string;
  extensionVersion: string;
  linkVersion: number;
  platform: string;
  /** ms since epoch. */
  updated: number;
}

/**
 * The editor's command-line launcher inside its install. macOS: <app>/Contents/Resources/app/bin; Linux:
 * <install>/bin next to resources/app. Named after the product (code, cursor), or `code` in forks that
 * only ship that name (Kiro, Positron).
 */
export function editorCli(appRoot: string, applicationName?: string): string | undefined {
  const names = [...new Set([applicationName, 'code'].filter((n): n is string => !!n && /^[\w.-]+$/.test(n)))];
  const dirs = [path.join(appRoot, 'bin'), path.resolve(appRoot, '..', '..', 'bin')];
  for (const d of dirs) for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
}

export function writeEditorRecord(rec: EditorRecord, home?: string) {
  if (!SCHEME.test(rec.scheme)) return;
  writeJson(path.join(hubDir(home), 'editors', `${rec.scheme}.json`), rec);
}

export function readEditorRecords(home?: string): EditorRecord[] {
  const dir = path.join(hubDir(home), 'editors');
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJson(path.join(dir, n))).filter((r): r is EditorRecord => typeof r?.scheme === 'string' && SCHEME.test(r.scheme));
}

// ---------- hub status ----------

export interface HubStatus {
  editor: string;
  scheme: string;
  /** Extension host process; the plugin treats a dead pid as "not running". */
  pid: number;
  connected: boolean;
  /** Why not connected (connection.ts DownReason, or reconnecting/connecting/starting). */
  state: string;
  /** Herdr session name; undefined = default session. */
  session?: string;
  /** The space whose tabs are open, by label. */
  space?: string;
  /** Live attach tabs. */
  tabs: number;
  agents: { working: number; blocked: number; done: number; idle: number };
  extensionVersion: string;
  updated: number;
}

const statusFile = (scheme: string, home?: string) => path.join(hubDir(home), 'status', `${scheme}.json`);

export function writeHubStatus(s: HubStatus, home?: string) {
  if (SCHEME.test(s.scheme)) writeJson(statusFile(s.scheme, home), s);
}

/**
 * A Cockpit window of this editor is open right now: its status file is fresh (heartbeat every 30s) and its
 * extension host is alive.
 */
export function hubOpen(scheme: string, home?: string, now = Date.now()): boolean {
  if (!SCHEME.test(scheme)) return false;
  const s = readJson(statusFile(scheme, home));
  if (typeof s?.pid !== 'number' || typeof s?.updated !== 'number' || now - s.updated > 90_000) return false;
  try {
    process.kill(s.pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === 'EPERM'; // alive, owned by someone else
  }
}

export type OfferHubSetting = 'emptyWindows' | 'allWindows' | 'never';

/** Whether to ask "Open Herdr Cockpit here?" when a window opens (herdr.offerHubOnStartup). */
export function shouldOfferHub(w: { mode: OfferHubSetting; isHub: boolean; hasFolder: boolean; herdrInstalled: boolean; hubOpenElsewhere: boolean }): boolean {
  if (w.mode === 'never' || w.isHub || !w.herdrInstalled || w.hubOpenElsewhere) return false;
  return w.mode === 'allWindows' || !w.hasFolder;
}

/** Remove this process's status file (a newer Cockpit window of the same editor may have replaced it: keep that). */
export function removeHubStatus(scheme: string, pid: number, home?: string) {
  if (!SCHEME.test(scheme)) return;
  const f = statusFile(scheme, home);
  if (readJson(f)?.pid === pid) fs.rmSync(f, { force: true });
}

// ---------- links ----------

export type LinkRequest =
  | { kind: 'open'; space?: string; label?: string; pane?: string; session?: string }
  | { kind: 'review'; space?: string; label?: string; pane?: string; session?: string }
  | { kind: 'file'; path: string; line?: number; col?: number; session?: string };

const ID = /^[A-Za-z0-9:_-]{1,64}$/;
const SESSION = /^[A-Za-z0-9._-]{1,64}$/;

/** Parse and validate a link's path and query. Throws with a user-facing reason. */
export function parseLink(linkPath: string, query: string): LinkRequest {
  const action = linkPath.replace(/^\/+|\/+$/g, '');
  const q = new URLSearchParams(query);
  const v = Number(q.get('v') ?? LINK_VERSION);
  if (v > LINK_VERSION) throw new Error(`the link needs a newer Herdr Cockpit (link version ${v}, this one understands ${LINK_VERSION})`);
  const id = (k: string) => {
    const x = q.get(k);
    if (x === null || x === '') return undefined;
    if (!ID.test(x)) throw new Error(`invalid ${k}`);
    return x;
  };
  const label = q.get('label')?.slice(0, 200) || undefined;
  const sessionRaw = q.get('session') || undefined;
  if (sessionRaw && !SESSION.test(sessionRaw)) throw new Error('invalid session');
  const session = sessionRaw;
  const num = (k: string) => {
    const x = q.get(k);
    if (!x) return undefined;
    const n = Number(x);
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) throw new Error(`invalid ${k}`);
    return n;
  };
  switch (action) {
    case 'open':
    case 'review':
      return { kind: action, space: id('space'), label, pane: id('pane'), session };
    case 'file': {
      const p = q.get('path');
      // No network paths (\\host\share, //host/share): opening one can send credentials to that host.
      if (!p || !path.isAbsolute(p) || p.includes('\0') || /^[\\/]{2}/.test(p)) throw new Error('the file path must be absolute and local');
      return { kind: 'file', path: path.normalize(p), line: num('line'), col: num('col'), session };
    }
    default:
      throw new Error(`unknown link "${action || '(none)'}"`);
  }
}

/**
 * The file is inside one of `roots` (symlinks resolved), e.g. a Herdr space's folder. A `file` link to
 * anything else asks first: a web page could otherwise put ~/.ssh or .env files on screen.
 */
export function isInsideRoots(file: string, roots: readonly string[]): boolean {
  // Resolve symlinks in the deepest part of the path that exists (the file itself may not): a missing file
  // under a symlinked folder must still resolve to where that folder really is.
  const real = (p: string): string => {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch {
      const parent = path.dirname(abs);
      return parent === abs ? abs : path.join(real(parent), path.basename(abs));
    }
  };
  const f = real(file);
  return roots.some((r) => {
    const root = real(r);
    return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

// ---------- hand-off to the Cockpit window ----------

const pendingFile = (home?: string) => path.join(hubDir(home), 'pending-link.json');

export function writePendingLink(scheme: string, linkPath: string, query: string, home?: string) {
  writeJson(pendingFile(home), { scheme, path: linkPath, query, created: Date.now() });
}

/**
 * Take the pending link for this editor, if fresh. Taking renames the file first, so two windows can't
 * both act on it.
 */
export function takePendingLink(scheme: string, maxAgeMs = 60_000, home?: string): { path: string; query: string } | undefined {
  const f = pendingFile(home);
  if (readJson(f)?.scheme !== scheme) return undefined; // another editor's: leave it
  const mine = `${f}.${process.pid}.taken`;
  try {
    fs.renameSync(f, mine);
  } catch {
    return undefined;
  }
  const p = readJson(mine);
  fs.rmSync(mine, { force: true });
  if (!p || p.scheme !== scheme || typeof p.path !== 'string' || typeof p.query !== 'string') return undefined;
  if (!(Date.now() - p.created < maxAgeMs)) return undefined;
  return { path: p.path, query: p.query };
}
