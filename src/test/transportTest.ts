import * as assert from 'assert';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { HerdrClient, resolveSocketPath, transportPath } from '../herdrClient';

async function main() {
  const logical = 'C:\\Users\\example\\AppData\\Roaming\\herdr\\herdr.sock';
  const pipe = '\\\\.\\pipe\\' + logical;
  assert.strictEqual(transportPath(logical, 'win32'), pipe);
  assert.strictEqual(transportPath(logical.replace(/\\/g, '/'), 'win32'), pipe);
  assert.strictEqual(transportPath(pipe, 'win32'), pipe);
  assert.strictEqual(transportPath('/tmp/herdr.sock', 'linux'), '/tmp/herdr.sock');
  assert.strictEqual(transportPath('/tmp/herdr.sock', 'darwin'), '/tmp/herdr.sock');

  const savedSocket = process.env.HERDR_SOCKET_PATH;
  const savedSession = process.env.HERDR_SESSION;
  delete process.env.HERDR_SOCKET_PATH;
  delete process.env.HERDR_SESSION;
  try {
    const configHome = process.platform === 'win32'
      ? process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    assert.strictEqual(resolveSocketPath(), path.join(configHome, 'herdr', 'herdr.sock'));
    assert.strictEqual(resolveSocketPath(undefined, 'example'), path.join(configHome, 'herdr', 'sessions', 'example', 'herdr.sock'));
    assert.strictEqual(resolveSocketPath(logical), logical);
  } finally {
    if (savedSocket === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = savedSocket;
    if (savedSession === undefined) delete process.env.HERDR_SESSION;
    else process.env.HERDR_SESSION = savedSession;
  }

  const socket = path.join(os.tmpdir(), `hb-transport-${process.pid}.sock`);
  const connections = new Set<net.Socket>();
  let acknowledged: (() => void) | undefined;
  const server = net.createServer((c) => {
    connections.add(c);
    c.on('close', () => connections.delete(c));
    c.setEncoding('utf8');
    let buffer = '';
    c.on('data', (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        c.write(JSON.stringify({ id: request.id, result: { ok: true } }) + '\n');
        if (request.method === 'events.subscribe') {
          acknowledged?.();
          c.write(JSON.stringify({ event: 'transport.ready' }) + '\n');
        }
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(transportPath(socket), resolve);
  });
  try {
    const client = new HerdrClient(() => socket);
    assert.deepStrictEqual(await client.request('session.snapshot', {}, 2000), { ok: true });
    await new Promise<void>((resolve, reject) => {
      let acked = false;
      acknowledged = () => { acked = true; };
      const timeout = setTimeout(() => { sub.dispose(); reject(new Error('No subscription event')); }, 2000);
      const sub = client.subscribe([], (event) => {
        clearTimeout(timeout);
        sub.dispose();
        try {
          assert.ok(acked, 'server received events.subscribe');
          assert.strictEqual(event.event, 'transport.ready');
          resolve();
        } catch (error) { reject(error); }
      }, (error) => { clearTimeout(timeout); reject(error || new Error('Subscription closed')); });
    });
    console.log('PASS: platform paths, default and named session paths, API request and event subscription');
  } finally {
    for (const c of connections) c.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
