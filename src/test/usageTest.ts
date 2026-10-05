// Usage readers against a fixture home directory shaped like the real tools' files
// (codex-cli 0.157.0, Claude Code 2.1.289, kiro-cli 2.27.1), plus the opt-in status line script.
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeCaptureFile, claudeStatusLineScript, codexLiveUsage, currentBlock, readUsage } from '../usage';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-usage-'));
const put = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
  fs.writeFileSync(path.join(home, rel), body);
};
const H = 3600_000;
const now = Date.UTC(2026, 9, 5, 18, 30); // 2026-10-05 18:30 UTC
const iso = (t: number) => new Date(t).toISOString();
const sec = (t: number) => Math.floor(t / 1000);

// Codex: an older rollout with rate limits, and a newer one without (newest-first search must skip it).
put('.codex/sessions/2026/10/05/rollout-a.jsonl', [
  JSON.stringify({ timestamp: iso(now - 2 * H), type: 'event_msg', payload: { type: 'token_count', rate_limits: {
    primary: { used_percent: 28, window_minutes: 300, resets_at: sec(now + H) },
    secondary: { used_percent: 23, window_minutes: 10080, resets_at: sec(now - H) }, plan_type: 'team' } } }),
  JSON.stringify({ timestamp: iso(now - H), type: 'response_item', payload: { type: 'message' } }),
].join('\n'));
put('.codex/sessions/2026/10/05/rollout-b.jsonl', JSON.stringify({ type: 'session_meta', payload: {} }) + '\n');
fs.utimesSync(path.join(home, '.codex/sessions/2026/10/05/rollout-a.jsonl'), new Date(now - H), new Date(now - H));

// Claude: one message in an earlier block, two in the current one (one written twice while streaming).
const msg = (t: number, id: string, input: number, output: number, cacheRead = 0) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(t), requestId: `r-${id}`, message: { id, usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 10, cache_read_input_tokens: cacheRead } } });
put('.claude/projects/-p/s1.jsonl', [
  msg(now - 7 * H, 'm0', 1000, 1000),
  msg(now - 2 * H - 10 * 60_000, 'm1', 100, 50, 5000),
  msg(now - 2 * H - 10 * 60_000, 'm1', 100, 50, 5000),
  JSON.stringify({ type: 'user', timestamp: iso(now - H), message: { content: 'hi' } }),
  msg(now - 30 * 60_000, 'm2', 200, 100),
].join('\n'));
put('.herdr-hub/claude-usage.json', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42.5, resets_at: sec(now + 2 * H) }, seven_day: { used_percentage: 11, resets_at: sec(now + 50 * H) } } }));

// Kiro: credits today, earlier this month, and last month (ignored).
const local = (d: number, h: number) => new Date(2026, 9, d, h).getTime();
put('.kiro/sessions/cli/a.json', JSON.stringify({ session_state: { conversation_metadata: { user_turn_metadatas: [
  { end_timestamp: iso(local(5, 9)), metering_usage: [{ value: 0.25, unit: 'credit' }, { value: 0.05, unit: 'credit' }] },
  { end_timestamp: iso(local(2, 9)), metering_usage: [{ value: 1.5, unit: 'credit' }] },
  { end_timestamp: iso(new Date(2026, 8, 30).getTime()), metering_usage: [{ value: 9, unit: 'credit' }] },
] } } }));

(async () => {
  const kiroNow = local(5, 12);
  const usage = await readUsage(home, now);
  const by = (id: string) => usage.find((u) => u.id === id)!;
  assert.deepStrictEqual(usage.map((u) => u.id), ['claude', 'codex', 'kiro']);

  const codex = by('codex');
  assert.strictEqual(codex.plan, 'team');
  assert.deepStrictEqual(codex.windows.map((w) => [w.label, w.usedPercent, !!w.reset]), [['5h', 28, false], ['7d', 0, true]], 'weekly window already reset');
  assert.strictEqual(codex.asOf, now - 2 * H);
  console.log('✓ codex rate limits (5h / 7d, reset windows)');

  const claude = by('claude');
  assert.deepStrictEqual(claude.windows.map((w) => [w.label, w.usedPercent]), [['5h', 42.5], ['7d', 11]]);
  assert.strictEqual(claude.canSetUpLimits, undefined);
  assert.deepStrictEqual(claude.block, { startsAt: now - 3 * H, endsAt: now + 2 * H, tokens: 160 + 310, cacheRead: 5000, exact: true },
    'the real session window (reset time − 5h); streamed duplicate counted once');
  console.log('✓ claude limits from status line capture + current 5-hour block');

  const kiro = (await readUsage(home, kiroNow)).find((u) => u.id === 'kiro')!;
  assert.deepStrictEqual([kiro.credits!.today.toFixed(2), kiro.credits!.month.toFixed(2)], ['0.30', '1.80']);
  assert.deepStrictEqual(kiro.windows, [], 'no allowance set: no bar');
  const kiroLimited = (await readUsage(home, kiroNow, { kiroMonthlyCredits: 50 })).find((u) => u.id === 'kiro')!;
  assert.deepStrictEqual(
    [kiroLimited.credits!.limit, kiroLimited.windows[0].label, kiroLimited.windows[0].usedPercent.toFixed(1), kiroLimited.windows[0].resetsAt],
    [50, 'mo', '3.6', new Date(2026, 10, 1).getTime()],
    'allowance: % of the month used, resets on the 1st',
  );
  console.log('✓ kiro credits today / this month');

  fs.rmSync(claudeCaptureFile(home));
  const noCapture = (await readUsage(home, now))[0];
  assert.strictEqual(noCapture.canSetUpLimits, true, 'offers setup without a capture');
  const est = Math.floor((now - 2 * H - 10 * 60_000) / H) * H;
  assert.deepStrictEqual(noCapture.block, { startsAt: est, endsAt: est + 5 * H, tokens: 470, cacheRead: 5000, exact: false }, 'estimated block from the first message hour');
  const live = { id: 'codex', name: 'Codex', windows: [{ label: '5h', usedPercent: 3 }], live: true };
  assert.strictEqual((await readUsage(home, now, { codexLive: live })).find((u) => u.id === 'codex'), live, 'live Codex numbers win over logs');
  assert.deepStrictEqual((await readUsage(home, now, { only: new Set(['kiro']) })).map((u) => u.id), ['kiro'], 'agents not running are not read');
  assert.strictEqual(currentBlock([{ ts: now - 6 * H, tokens: 1, cacheRead: 0 }], now), undefined, 'no current block after 5h idle');
  console.log('✓ claude without capture offers setup');

  // The status line script: saves only rate_limits (with jq) and prints the limits.
  const script = path.join(home, 'statusline.sh');
  fs.writeFileSync(script, claudeStatusLineScript(claudeCaptureFile(home)));
  const input = JSON.stringify({ cwd: '/secret/path', session_id: 's', rate_limits: { five_hour: { used_percentage: 42.6, resets_at: 1 }, seven_day: { used_percentage: 7, resets_at: 2 } } });
  const hasJq = (() => { try { execFileSync('sh', ['-c', 'command -v jq']); return true; } catch { return false; } })();
  const printed = execFileSync('sh', [script], { input }).toString().trim();
  const saved = JSON.parse(fs.readFileSync(claudeCaptureFile(home), 'utf8'));
  if (hasJq) {
    assert.strictEqual(printed, '5h 42% · 7d 7%');
    assert.deepStrictEqual(Object.keys(saved), ['rate_limits'], 'only rate_limits are kept');
  }
  assert.strictEqual(saved.rate_limits.five_hour.used_percentage, 42.6);
  console.log(`✓ status line script saves rate_limits${hasJq ? ' (jq: only that) and prints them' : ''}`);
  // Live Codex: a fake `codex app-server` speaking the protocol (initialize, then account/rateLimits/read).
  const fake = path.join(home, 'codex');
  fs.writeFileSync(fake, `#!/usr/bin/env node
if (process.argv[2] !== 'app-server') process.exit(2);
require('readline').createInterface({ input: process.stdin }).on('line', (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') console.log(JSON.stringify({ id: m.id, result: { userAgent: 'fake' } }));
  if (m.method === 'account/rateLimits/read') console.log(JSON.stringify({ id: m.id, result: { rateLimits: {
    planType: 'team', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: ${sec(Date.now() + H)} },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: ${sec(Date.now() + 50 * H)} } } } }));
});
`, { mode: 0o755 });
  const lu = await codexLiveUsage(fake);
  assert.deepStrictEqual([lu?.live, lu?.plan, lu?.windows.map((w) => [w.label, w.usedPercent])], [true, 'team', [['5h', 12], ['7d', 40]]]);
  assert.strictEqual(await codexLiveUsage(path.join(home, 'missing-codex'), 2000), undefined, 'no Codex: undefined, no throw');
  console.log('✓ live Codex limits via app-server protocol');

  fs.rmSync(home, { recursive: true, force: true });
  console.log('\nusage tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
