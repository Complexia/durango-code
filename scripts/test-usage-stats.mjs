// Usage view: log parsing, dedupe, attribution and API-price estimates.
//   node --no-warnings scripts/test-usage-stats.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildUsageReport, createUsageStore, latestCodexLimits } from '../src/main/usage-stats.js';
import { priceUsage, pricesForModel } from '../src/main/usage-pricing.js';
import { claudeRateLimits, configureUsageLimits, recordClaudeRateLimit } from '../src/main/usage-limits.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-stats-'));
const roots = {
  claude: path.join(root, 'claude', 'projects'),
  codex: [path.join(root, 'codex', 'sessions'), path.join(root, 'codex', 'archived_sessions')],
  grok: path.join(root, 'grok', 'sessions'),
};
const now = Date.parse('2026-11-20T12:00:00Z');
const at = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString();
const jsonl = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

const claudeCall = (id, hoursAgo, usage, extra = {}) => ({
  type: 'assistant',
  timestamp: at(hoursAgo),
  requestId: `req_${id}`,
  cwd: extra.cwd ?? '/repo',
  entrypoint: 'sdk-ts',
  isSidechain: Boolean(extra.sidechain),
  message: { id: `msg_${id}`, model: extra.model ?? 'claude-opus-5-5', usage },
});

const base = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_1h_input_tokens: 200, ephemeral_5m_input_tokens: 0 }, output_tokens: 50, speed: 'standard' };
await fs.mkdir(path.join(roots.claude, '-repo', 'sess-a', 'subagents'), { recursive: true });
await fs.writeFile(
  path.join(roots.claude, '-repo', 'sess-a.jsonl'),
  jsonl([
    { type: 'user', timestamp: at(5), cwd: '/repo' },
    claudeCall('1', 5, { ...base, output_tokens: 10 }), // streamed: same call, partial output
    claudeCall('1', 5, base), // final line wins
    claudeCall('2', 4, { ...base, speed: 'fast' }),
    claudeCall('3', 3, base, { sidechain: true }),
    claudeCall('syn', 3, base, { model: '<synthetic>' }),
  ])
);
// A fork copies call 1 into another session: counted once, for sess-a.
await fs.writeFile(path.join(roots.claude, '-repo', 'sess-fork.jsonl'), jsonl([claudeCall('1', 5, base), claudeCall('4', 2, base)]));
await fs.writeFile(path.join(roots.claude, '-repo', 'sess-a', 'subagents', 'agent-x1.jsonl'), jsonl([claudeCall('5', 2, base)]));
await fs.mkdir(path.join(roots.claude, '-bots'), { recursive: true });
await fs.writeFile(
  path.join(roots.claude, '-bots', 'bot-sess.jsonl'),
  jsonl([claudeCall('6', 1, base, { cwd: '/Users/me/Library/Application Support/orion/bots/b1' })])
);
// Old call outside every range but 90d.
await fs.writeFile(path.join(roots.claude, '-repo', 'old.jsonl'), jsonl([claudeCall('7', 24 * 40, base)]));

const codexDir = path.join(roots.codex[0], '2026', '11', '20');
await fs.mkdir(codexDir, { recursive: true });
const limits = { primary: { used_percent: 12, window_minutes: 10080, resets_at: 1795649182 }, plan_type: 'pro', credits: { balance: '100' } };
await fs.writeFile(
  path.join(codexDir, 'rollout-2026-11-20T10-00-00-01a1f660-46e1-71e0-bf1f-0de2c27f4b7f.jsonl'),
  jsonl([
    { timestamp: at(3), type: 'session_meta', payload: { id: '01a1f660-46e1-71e0-bf1f-0de2c27f4b7f', originator: 'orion', cwd: '/repo' } },
    { timestamp: at(3), type: 'turn_context', payload: { model: 'gpt-6.2-sol' } },
    { timestamp: at(3), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 } }, rate_limits: limits } },
    { timestamp: at(3), type: 'token_usage_record', payload: { response_id: 'resp_1', usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5 } } },
    { timestamp: at(2), type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-6.2-sol', service_tier: 'priority' } } },
    { timestamp: at(2), type: 'token_usage_record', payload: { response_id: 'resp_2', usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 40 } } },
  ])
);
// An older Codex version: cumulative token_count only (repeated totals add nothing).
await fs.writeFile(
  path.join(codexDir, 'rollout-2026-11-20T09-00-00-01a1f660-0000-71e0-bf1f-0de2c27f4b7f.jsonl'),
  jsonl([
    { timestamp: at(6), type: 'session_meta', payload: { id: '01a1f660-0000-71e0-bf1f-0de2c27f4b7f', originator: 'codex_cli_rs' } },
    { timestamp: at(6), type: 'turn_context', payload: { model: 'gpt-6-luna' } },
    { timestamp: at(6), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 10 } } } },
    { timestamp: at(6), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 10 } } } },
    { timestamp: at(5), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1500, cached_input_tokens: 400, output_tokens: 30 } } } },
  ])
);

const grokDir = path.join(roots.grok, encodeURIComponent('/repo'), 'grok-1');
await fs.mkdir(grokDir, { recursive: true });
await fs.writeFile(
  path.join(grokDir, 'usage.json'),
  JSON.stringify({
    sessionId: 'grok-1',
    turns: [
      { turnNumber: 1, endedAt: at(1), modelUsage: { 'grok-4.7-build': { inputTokens: 300, cachedReadTokens: 100, cacheCreationTokens: 0, outputTokens: 30, costUsdTicks: 25_000_000 } } },
    ],
  })
);

const cacheFile = path.join(root, 'cache.json');
const store = createUsageStore({ roots, cacheFile });
await store.scan({ force: true });
const links = new Map([['sess-a', 'thread'], ['01a1f660-46e1-71e0-bf1f-0de2c27f4b7f', 'subagent']]);
const report = buildUsageReport(store.entries(), { range: '24h', links, now });

const claude = report.providers.find((row) => row.id === 'claude');
// Calls 1, 2, 3 (sess-a), 4 (fork), 5 (subagent file), 6 (bot); not 7 (old) or synthetic.
assert.equal(claude.tokens.output, 6 * 50, 'claude output: deduplicated, last streamed line wins');
assert.equal(claude.tokens.cacheRead, 6 * 1000);
assert.equal(claude.sessions, 4, 'sess-a, sess-fork, agent x1, bot');

const codex = report.providers.find((row) => row.id === 'codex');
// New format: two responses (token_count ignored). Old format: deltas 500/10 then 1000/20.
assert.equal(codex.tokens.output, 20 + 40 + 10 + 20);
assert.equal(codex.tokens.cacheRead, 800 + 1500 + 0 + 400);
assert.equal(codex.tokens.input, 200 + 500 + 500 + 600);

const grok = report.providers.find((row) => row.id === 'grok');
assert.equal(grok.tokens.input, 200);
assert.ok(Math.abs(grok.cost - 0.0025) < 1e-9, "grok uses its own cost (ticks are 1e-10 USD)");
assert.ok(Math.abs(report.costByType.other - 0.0025) < 1e-9);

// Sources: sess-a is a thread, its sidechain call a subagent; agent-x1's parent is a thread.
const bySource = Object.fromEntries(report.sources.map((row) => [row.id, row]));
assert.equal(bySource.thread.tokens.output, 2 * 50, 'sess-a calls 1 and 2');
assert.equal(bySource.subagent.tokens.output, 50 + 50 + 20 + 40, 'sidechain call, subagent file, linked codex subagent');
assert.equal(bySource.bot.tokens.output, 50);
const durangoOnly = buildUsageReport(store.entries(), { range: '24h', links, now, source: 'durango' });
assert.equal(durangoOnly.sources.some((row) => row.id === 'other'), false);

// Pricing: Opus 5.5 list prices; 1h cache writes at 2× input; fast mode table.
assert.equal(pricesForModel('claude', 'claude-opus-5-5')?.id, 'anthropic/claude-opus-5.5');
assert.equal(pricesForModel('claude', 'claude-haiku-4-5-20251001')?.id, 'anthropic/claude-haiku-4.5');
assert.equal(pricesForModel('codex', 'gpt-6.2-sol')?.id, 'openai/gpt-6.2-sol');
assert.equal(pricesForModel('claude', 'claude-imaginary-1'), null);
const opus = pricesForModel('claude', 'claude-opus-5-5').rates;
const priced = priceUsage('claude', 'claude-opus-5-5', { input: 1e6, cacheRead: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, output: 1e6 });
assert.ok(Math.abs(priced.parts.input - opus.input) < 1e-9);
assert.ok(Math.abs(priced.parts.cacheRead - opus.input_cache_read) < 1e-9);
assert.ok(Math.abs(priced.parts.cacheWrite - (opus.input_cache_write + opus.input * 2)) < 1e-9);
assert.ok(Math.abs(priced.savings - (opus.input - opus.input_cache_read)) < 1e-9);
const fastPriced = priceUsage('claude', 'claude-opus-5-5', { input: 1e6, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 }, { fast: true });
assert.ok(Math.abs(fastPriced.parts.input - opus.fast.input) < 1e-9);
assert.ok(report.costBySpeed.fast > 0 && report.costBySpeed.fastPremium > 0, 'fast claude call and priority codex call');
const typeSum = Object.values(report.costByType).reduce((sum, value) => sum + value, 0);
assert.ok(Math.abs(typeSum - report.totals.cost) < 1e-9, 'cost by type adds up');
assert.ok(Math.abs(report.costBySpeed.standard + report.costBySpeed.fast - report.totals.cost) < 1e-9, 'cost by speed adds up');
const seriesSum = report.series.reduce((sum, bucket) => sum + Object.values(bucket.cost).reduce((a, b) => a + b, 0), 0);
assert.ok(Math.abs(seriesSum - report.totals.cost) < 1e-9, 'chart adds up');
assert.equal(report.series.length, 24);

// Ranges: the 40-day-old call shows only in 90 days.
assert.equal(buildUsageReport(store.entries(), { range: '30d', now }).providers.find((row) => row.id === 'claude').tokens.output, 300);
assert.equal(buildUsageReport(store.entries(), { range: '90d', now }).providers.find((row) => row.id === 'claude').tokens.output, 350);
assert.equal(buildUsageReport(store.entries(), { range: '7d', now }).series.length, 7);

// Limits from Codex logs.
assert.deepEqual(latestCodexLimits(store.entries()).value, limits);

// Incremental: appended lines are read from the saved offset, via the cache.
await fs.appendFile(path.join(roots.claude, '-repo', 'sess-a.jsonl'), jsonl([claudeCall('8', 0.5, base)]));
const reopened = createUsageStore({ roots, cacheFile });
await reopened.scan({ force: true });
const after = buildUsageReport(reopened.entries(), { range: '24h', links, now });
assert.equal(after.providers.find((row) => row.id === 'claude').tokens.output, 7 * 50);
assert.equal(reopened.entries().get(path.join(roots.claude, '-repo', 'sess-a.jsonl')).records.length, 4);

// Claude limits from SDK rate_limit_event messages.
configureUsageLimits(() => root);
recordClaudeRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.82, resetsAt: 1795649182 } }, now);
recordClaudeRateLimit({ type: 'assistant' }, now);
assert.deepEqual(claudeRateLimits().seven_day, { status: 'allowed_warning', utilization: 0.82, resetsAt: 1795649182000, usingOverage: false, overageStatus: null, at: now });
// The shape Claude Code 2.1.329 sends: every window in unifiedWindows.
recordClaudeRateLimit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1795744800, rateLimitType: 'seven_day', overageStatus: 'rejected', isUsingOverage: false, unifiedWindows: { seven_day: { utilization: 0.01, resetsAt: 1795744800 }, five_hour: { utilization: 0.4, resetsAt: 1795000000 } } } }, now + 1);
assert.deepEqual(claudeRateLimits().seven_day, { status: 'allowed', utilization: 0.01, resetsAt: 1795744800000, usingOverage: false, overageStatus: 'rejected', at: now + 1 });
assert.equal(claudeRateLimits().five_hour.utilization, 0.4);
assert.equal(claudeRateLimits().five_hour.status, null);

await fs.rm(root, { recursive: true, force: true });
console.log('usage stats: ok');
