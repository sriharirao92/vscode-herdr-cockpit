// Minimal Herdr socket API client. No vscode imports, so it can be tested standalone.
// Protocol: newline-delimited JSON over a Unix socket or Windows named pipe. One request per line,
// responses echo the request id. events.subscribe keeps the connection open.
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Subscription as EventSubscription } from './herdrTypes';

export class HerdrError extends Error {
  constructor(public code: string, message: string) {
    super(`${code}: ${message}`);
  }
}

export interface Subscription {
  dispose(): void;
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Mirrors Herdr's resolution order: HERDR_SOCKET_PATH, HERDR_SESSION, default. */
export function resolveSocketPath(override?: string, session?: string): string {
  if (override) return expandHome(override);
  if (process.env.HERDR_SOCKET_PATH) return process.env.HERDR_SOCKET_PATH;
  const configHome = process.platform === 'win32'
    ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const base = path.join(configHome, 'herdr');
  const s = session || process.env.HERDR_SESSION;
  return s ? path.join(base, 'sessions', s, 'herdr.sock') : path.join(base, 'herdr.sock');
}

/** Windows Herdr names its pipe after the full logical socket path. CLI commands still use that path. */
export function transportPath(socket: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32' || socket.startsWith('\\\\.\\pipe\\')) return socket;
  return '\\\\.\\pipe\\' + path.win32.normalize(socket);
}

let seq = 0;
const nextId = (kind: string) => `hb_${kind}_${process.pid}_${++seq}`;

/** Splits a utf8 stream into parsed JSON lines. */
function lineReader(onMsg: (msg: any) => void) {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMsg(JSON.parse(line));
      } catch {
        /* ignore malformed line */
      }
    }
  };
}

export class HerdrClient {
  constructor(private socketPath: () => string) {}

  /** One request on a short-lived connection. */
  request<T = any>(method: string, params: object = {}, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = nextId('req');
      const sock = net.createConnection(transportPath(this.socketPath()));
      sock.setEncoding('utf8');
      let settled = false;
      const finish = (err?: Error, val?: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        err ? reject(err) : resolve(val as T);
      };
      const timer = setTimeout(() => finish(new Error(`herdr ${method} timed out`)), timeoutMs);
      sock.on('connect', () => sock.write(JSON.stringify({ id, method, params }) + '\n'));
      sock.on(
        'data',
        lineReader((msg) => {
          if (msg.id !== id && msg.id !== '') return;
          if (msg.error) finish(new HerdrError(msg.error.code ?? 'error', msg.error.message ?? 'unknown error'));
          else finish(undefined, msg.result);
        }),
      );
      sock.on('error', (e) => finish(e));
      sock.on('close', () => finish(new Error(`herdr socket closed before ${method} responded`)));
    });
  }

  /**
   * Long-lived event subscription. Every pushed event is passed to onEvent;
   * callers should treat events as "something changed, re-read" signals
   * (that's what Herdr's docs recommend). onEnd fires once on close/error.
   */
  subscribe(subscriptions: readonly EventSubscription[], onEvent: (ev: any) => void, onEnd: (err?: Error) => void): Subscription {
    const id = nextId('sub');
    const sock = net.createConnection(transportPath(this.socketPath()));
    sock.setEncoding('utf8');
    let ended = false;
    let acked = false;
    const end = (err?: Error) => {
      if (ended) return;
      ended = true;
      sock.destroy();
      onEnd(err);
    };
    sock.on('connect', () =>
      sock.write(JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions } }) + '\n'),
    );
    sock.on(
      'data',
      lineReader((msg) => {
        if (msg.error) return end(new HerdrError(msg.error.code ?? 'error', msg.error.message ?? ''));
        if (!acked && msg.id === id && msg.result) {
          acked = true;
          return;
        }
        onEvent(msg);
      }),
    );
    sock.on('error', (e) => end(e));
    sock.on('close', () => end());
    return {
      dispose: () => {
        ended = true;
        sock.destroy();
      },
    };
  }
}

/**
 * Lifecycle events that should trigger a refresh of our cached model. These take no parameters.
 * Not `pane.updated`: it fires on every terminal-title change (agents animate their titles) and, on herdr
 * 0.9.3, not on `pane.rename` (which emits no event at all; `tab.rename` emits tab.renamed). Pane renames
 * made in Herdr are picked up by the safety poll (extension.ts).
 */
const LIFECYCLE_EVENTS = [
  'workspace.created',
  'workspace.closed',
  'workspace.renamed',
  'workspace.focused',
  'workspace.updated',
  'workspace.metadata_updated',
  'workspace.moved',
  'workspace.reordered',
  'worktree.created',
  'worktree.opened',
  'worktree.removed',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'tab.moved',
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
] as const;


// Typed against the generated schema: a pane-scoped event here (one that needs a pane_id) fails to compile.
export const DEFAULT_SUBSCRIPTIONS: readonly EventSubscription[] = LIFECYCLE_EVENTS.map((type) => ({ type }));

/**
 * The full events.subscribe list: the lifecycle events plus each pane's agent status. Verified against
 * herdr 0.9.1: status changes fire no global event, `pane.agent_status_changed` requires a `pane_id`, and
 * one unknown pane id rejects the whole request (`pane_not_found`). So subscribe with the panes of the
 * latest snapshot and resubscribe when they change.
 */
export function subscriptionsFor(paneIds: readonly string[]): EventSubscription[] {
  return [...DEFAULT_SUBSCRIPTIONS, ...paneIds.map((pane_id) => ({ type: 'pane.agent_status_changed' as const, pane_id }))];
}
