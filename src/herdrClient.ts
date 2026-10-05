// Minimal Herdr socket API client. No vscode imports, so it can be tested standalone.
// Protocol: newline-delimited JSON over a Unix socket. One request per line,
// responses echo the request id. events.subscribe keeps the connection open.
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

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
  const base = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'herdr');
  const s = session || process.env.HERDR_SESSION;
  return s ? path.join(base, 'sessions', s, 'herdr.sock') : path.join(base, 'herdr.sock');
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
      const sock = net.createConnection(this.socketPath());
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
  subscribe(subscriptions: object[], onEvent: (ev: any) => void, onEnd: (err?: Error) => void): Subscription {
    const id = nextId('sub');
    const sock = net.createConnection(this.socketPath());
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

/** Lifecycle events that should trigger a refresh of our cached model. */
export const DEFAULT_SUBSCRIPTIONS = [
  'workspace.created',
  'workspace.closed',
  'workspace.renamed',
  'workspace.focused',
  'workspace.updated',
  'tab.created',
  'tab.closed',
  'tab.focused',
  'tab.renamed',
  'pane.created',
  'pane.closed',
  'pane.moved',
  'pane.exited',
  'pane.agent_detected',
  'pane.agent_status_changed',
].map((type) => ({ type }));
