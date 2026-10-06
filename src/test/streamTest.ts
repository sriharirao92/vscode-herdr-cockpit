// The built-in terminal's pieces without VS Code: mouse/keystroke parsing, selection and painting on a
// headless screen, and the `herdr terminal session control` client against a fake herdr.
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HerdrStream } from '../herdrStream';
import { parseInput, Screen } from '../termScreen';

(async () => {
  // ---------- input ----------
  assert.deepStrictEqual(parseInput('ls\r'), [{ kind: 'data', text: 'ls\r' }]);
  const t = parseInput('a\x1b[<0;5;2M\x1b[<32;9;3M\x1b[<0;9;3mb\x1b[<64;1;1M\x1b[<65;1;1M\x1b[<4;2;2M');
  assert.deepStrictEqual(
    t.map((x) => (x.kind === 'data' ? x.text : `${x.wheel ?? (x.release ? 'up' : x.motion ? 'drag' : 'down')}@${x.x},${x.y}${x.shift ? '+shift' : ''}`)),
    ['a', 'down@4,1', 'drag@8,2', 'up@8,2', 'b', 'up@0,0', 'down@0,0', 'down@1,1+shift'],
  );
  console.log('✓ input: keystrokes and SGR mouse reports (press, drag, release, wheel, modifiers)');

  // ---------- selection ----------
  const s = new Screen(20, 5);
  await s.write('hello world\r\nsecond line here\r\nabcdefghijklmnopqrstuvwxyz'); // the last one wraps at 20 columns
  const drag = (a: [number, number], b: [number, number], now = 0) => {
    s.mouse({ x: a[0], y: a[1], release: false, motion: false }, now);
    const mid = s.mouse({ x: b[0], y: b[1], release: false, motion: true }, now);
    return { mid, end: s.mouse({ x: b[0], y: b[1], release: true, motion: false }, now) };
  };
  let r = drag([6, 0], [5, 1]);
  assert.strictEqual(r.end.copy, 'world\nsecond', 'drag across two rows');
  assert.deepStrictEqual(r.mid.repaint, [0, 1]);
  r = drag([5, 1], [6, 0], 1000);
  assert.strictEqual(r.end.copy, 'world\nsecond', 'dragging backwards selects the same');
  r = drag([18, 2], [3, 3], 2000);
  assert.strictEqual(r.end.copy, 'stuvwx', 'a wrapped line copies without a newline');
  assert.strictEqual(s.mouse({ x: 3, y: 0, release: false, motion: false }, 5000).copy, undefined);
  assert.strictEqual(s.mouse({ x: 3, y: 0, release: true, motion: false }, 5000).copy, undefined, 'a click copies nothing');
  assert.strictEqual(s.hasSelection(), false);
  s.mouse({ x: 8, y: 1, release: false, motion: false }, 9000);
  s.mouse({ x: 8, y: 1, release: true, motion: false }, 9000);
  assert.strictEqual(s.mouse({ x: 8, y: 1, release: false, motion: false }, 9200).copy, 'line', 'double-click: a word');
  s.mouse({ x: 8, y: 1, release: true, motion: false }, 9200);
  assert.strictEqual(s.mouse({ x: 8, y: 1, release: false, motion: false }, 9350).copy, 'second line here', 'triple-click: the line');
  console.log('✓ selection: drag (both ways, across a wrap), click, double-click word, triple-click line');

  // ---------- painting ----------
  const colored = new Screen(10, 2);
  await colored.write('\x1b[1;31mred\x1b[0m plain');
  colored.mouse({ x: 1, y: 0, release: false, motion: false }, 0);
  colored.mouse({ x: 5, y: 0, release: false, motion: true }, 0);
  const p = colored.paint([0]);
  assert.ok(p.startsWith('\x1b[?2026h\x1b7') && p.endsWith('\x1b8\x1b[?2026l'), 'synchronized, cursor restored');
  assert.ok(p.includes('\x1b[0;1;31mr\x1b[0;1;7;31med'), `bold red kept, selection inverted: ${JSON.stringify(p)}`);
  assert.ok(p.includes('\x1b[0;7m pl\x1b[0main'), 'plain cells inverted only inside the selection');
  const toast = new Screen(30, 4).toast('✓ Copied to clipboard');
  assert.strictEqual(toast.row, 3);
  assert.ok(toast.paint.includes('\x1b[4;4H\x1b[0;1;30;42m ✓ Copied to clipboard \x1b[0m'), `toast centered on the bottom row: ${JSON.stringify(toast.paint)}`);
  assert.ok(toast.paint.endsWith('\x1b8\x1b[?2026l'), 'cursor restored');
  console.log('✓ painting: colors and attributes kept, selection inverted, cursor restored; copied toast');

  // ---------- the stream client, against a fake herdr ----------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-stream-'));
  const log = path.join(dir, 'stdin.log');
  const fake = path.join(dir, 'herdr');
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(path.join(dir, 'argv'))}, process.argv.slice(2).join(' '));
const frame = (s, full) => console.log(JSON.stringify({ type: 'terminal.frame', encoding: 'ansi', full, seq: 1, width: 80, height: 24, bytes: Buffer.from(s).toString('base64') }));
frame('\\x1b[2J\\x1b[1;1Hhello', true);
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
    const c = JSON.parse(line);
    if (c.type === 'terminal.input') frame(Buffer.from(c.bytes, 'base64').toString(), false);
    if (c.type === 'terminal.release') { console.log(JSON.stringify({ type: 'terminal.closed', reason: 'detached' })); process.exit(0); }
  }
});
`,
    { mode: 0o755 },
  );
  const frames: string[] = [];
  let closed: { reason?: string; error?: string } | undefined;
  const st = new HerdrStream(fake, 'w1:p2', { cols: 80, rows: 24 }, process.env, {
    onFrame: (b, full) => frames.push(`${full ? 'F' : 'd'}:${b.toString()}`),
    onClose: (i) => (closed = i),
  });
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
  };
  await until(() => frames.length === 1);
  st.input('é\r');
  st.resize(100, 30);
  st.scroll('up', 3);
  st.mouse('down', 'left', 4, 2, 1);
  await until(() => frames.length === 2);
  st.release();
  await until(() => !!closed);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'argv'), 'utf8'), 'terminal session control w1:p2 --takeover --cols 80 --rows 24');
  assert.deepStrictEqual(frames, ['F:\x1b[2J\x1b[1;1Hhello', 'd:é\r']);
  assert.deepStrictEqual(
    fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    [
      { type: 'terminal.input', bytes: Buffer.from('é\r').toString('base64') },
      { type: 'terminal.resize', cols: 100, rows: 30 },
      { type: 'terminal.scroll', direction: 'up', lines: 3 },
      { type: 'terminal.mouse', action: 'down', button: 'left', column: 4, row: 2, modifiers: 1 },
      { type: 'terminal.release' },
    ],
  );
  assert.deepStrictEqual(closed, { reason: 'detached' });
  let failed: { error?: string } | undefined;
  new HerdrStream(path.join(dir, 'missing'), 'w1:p1', { cols: 80, rows: 24 }, process.env, { onFrame: () => {}, onClose: (i) => (failed = i) });
  await until(() => !!failed);
  assert.ok(failed?.error, 'a missing herdr reports an error');
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('✓ stream client: argv, frames, input (UTF-8), resize, scroll, release, missing binary');
  console.log('\nstream tests passed');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
