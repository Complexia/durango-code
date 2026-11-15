// The highlighting client's memory bound and block hand-over (no Shiki here).
import assert from 'node:assert/strict';

const { highlightCacheInternals: client } = await import('../src/app/codeHighlight');

// Client: the finished cache is bounded by bytes, not entries.
const bigLines: { content: string; style: number }[][] = [[{ content: 'x'.repeat(50_000), style: 1 }]];
for (let i = 0; i < 400; i += 1) {
  const text = `${i}${'x'.repeat(50_000)}`;
  client.cachePut(text, { language: 'ts', base: text, lines: bigLines, consumed: text.length, done: true, bytes: client.estimateBytes(text, bigLines) });
}
const stats = client.stats();
assert.ok(stats.bytes <= 24 * 1024 * 1024, `cache holds ${stats.bytes} bytes`);
assert.ok(stats.entries < 400);

// Client: a streaming block that unmounts is taken over by its replacement,
// session, requests in flight and lines included.
const streaming = client.createClient();
streaming.sent.set(1, { text: 'a();\nb();\n', final: false, language: 'ts' });
client.apply(streaming, { id: streaming.id, seq: 1, reset: true, lines: [[{ content: 'a();', style: 1 }], [{ content: 'b();', style: 1 }]], consumed: 10, done: false, styles: [] });
client.release(streaming);
assert.equal(client.stats().orphans, 1);
assert.equal(client.adoptOrphan('py', 'a();\nb();', true), undefined, 'another language does not take it');
const adopted = client.adoptOrphan('ts', 'a();\nb();', true);
assert.equal(adopted, streaming);
assert.equal(adopted.block.lines.length, 2);
assert.equal(client.stats().orphans, 0);
client.release(adopted);
assert.equal(client.adoptOrphan('ts', 'something else', true), undefined, 'unrelated text does not take it');

console.log('code highlight client: ok');
