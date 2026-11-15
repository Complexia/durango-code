// The highlighting engine (what runs in the worker), under V8. Node and Electron share V8; Bun's JavaScriptCore
// mis-tokenizes some grammars with Shiki's JavaScript regex engine, so this
// runs in Node, importing the TypeScript modules directly.
import assert from 'node:assert/strict';

const { createHighlightEngine, continuesFrom, MAX_RUNS_PER_BLOCK } = await import('../src/app/codeHighlightEngine.ts');

const responses = [];
const styles = new Map();
const engine = createHighlightEngine({
  loadShiki: async () => ({
    core: await import('shiki/core'),
    engine: await import('shiki/engine/javascript'),
    langs: await import('shiki/langs'),
  }),
  post: (response) => {
    for (const entry of response.styles) styles.set(entry.index, entry);
    responses.push(response);
  },
  yieldNow: () => new Promise((resolve) => setImmediate(resolve)),
});

let seq = 0;
/** Sends a request and waits until the block's latest request is done. */
const highlight = async (id, text, final, language = 'ts') => {
  const mine = (seq += 1);
  engine.receive({ type: 'highlight', id, seq: mine, language, text, final });
  for (let i = 0; i < 2000; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const last = responses.findLast((response) => response.id === id && response.seq === mine);
    if (last?.done || (last && !final && last.consumed >= text.lastIndexOf('\n') + 1)) return mine;
  }
  throw new Error('no response');
};
/** The lines a client would show for block `id`, rebuilt from its responses. */
const linesOf = (id) => {
  let lines = [];
  for (const response of responses.filter((r) => r.id === id)) {
    lines = response.reset ? [...response.lines] : lines.concat(response.lines);
  }
  return lines;
};
const textOf = (lines) => lines.map((line) => line.map((run) => run.content).join('')).join('\n');
const colorOf = (lines, needle) => {
  const run = lines.flat().find((candidate) => candidate.content.includes(needle));
  return run?.style ? styles.get(run.style)?.color : undefined;
};

const source = [
  'const a = 1;',
  '/* start',
  '   still comment */',
  'const s = `x ${',
  '  y',
  '} z`;',
  'function f() { return "q"; } // tail',
].join('\n');

// A finished block.
await highlight(1, source, true);
const whole = linesOf(1);
assert.equal(textOf(whole), source, 'runs keep every character');
assert.equal(colorOf(whole, 'const'), 'var(--code-token-keyword)');
assert.equal(colorOf(whole, '// tail'), 'var(--code-token-comment)');
assert.equal(colorOf(whole, 'still comment'), 'var(--code-token-comment)', 'grammar state carries across lines');

// Streaming in small chunks: only ended lines are tokenized, earlier lines are
// never sent again, and the result equals the whole block's.
for (let end = 1; end <= source.length; end += 7) await highlight(2, source.slice(0, end), false);
await highlight(2, source, true);
assert.equal(responses.filter((r) => r.id === 2 && r.reset).length, 1, 'one session for the whole stream');
assert.deepEqual(
  linesOf(2).map((line) => line.map((run) => [run.content, styles.get(run.style)?.color])),
  whole.map((line) => line.map((run) => [run.content, styles.get(run.style)?.color]))
);
for (const response of responses.filter((r) => r.id === 2)) {
  assert.ok(response.consumed === source.length || source[response.consumed - 1] === '\n' || response.consumed === 0);
}

// A streaming text that loses its newline (not a fence closing) starts over,
// instead of gluing the next line onto the old one.
await highlight(3, 'a();\n', false);
await highlight(3, 'a();', false);
await highlight(3, 'a();b();\n', false);
await highlight(3, 'a();b();', true);
assert.equal(textOf(linesOf(3)), 'a();b();');
// The fence closing does keep the work.
await highlight(4, 'x();\ny();\n', false);
const before = responses.filter((r) => r.id === 4).length;
await highlight(4, 'x();\ny();', true);
assert.ok(responses.filter((r) => r.id === 4).slice(before).every((r) => !r.reset));
assert.equal(textOf(linesOf(4)), 'x();\ny();');

// Work comes back in steps, not one long run.
const long = Array.from({ length: 1500 }, (_, i) => `const v${i}: Map<string, Array<{ id: number }>> = make(${i}); // ${i}`).join('\n');
await highlight(5, long, true);
assert.ok(responses.filter((r) => r.id === 5).length > 2, 'a large block arrives in several steps');

// A block stops at the run cap; the rest stays plain.
const dense = Array.from({ length: 1990 }, (_, i) => `a${i}(b, c, d, e, f, g, h, i, j, k, l, m);`).join('\n');
await highlight(6, dense, true);
const capped = linesOf(6);
assert.ok(capped.flat().length <= MAX_RUNS_PER_BLOCK, `${capped.flat().length} runs`);
assert.ok(capped.length < 1990, 'stopped before the end');
const cappedLast = responses.filter((r) => r.id === 6).at(-1);
assert.equal(cappedLast.consumed, dense.split('\n').slice(0, capped.length).join('\n').length + 1, 'consumed ends after the last line taken');

// Unknown and plain languages: done, nothing to show.
await highlight(7, 'whatever', true, 'not-a-language');
assert.deepEqual(linesOf(7), []);

// A dropped block's session goes away.
engine.receive({ type: 'drop', id: 5 });
assert.ok(engine.sessionCount() < 7);

// A last line tokenized as final, then extended, is tokenized again (not glued
// to its old tokens as a new line).
await highlight(8, 'const a = 1', true);
await highlight(8, 'const a = 12;\n', false);
await highlight(8, 'const a = 12;', true);
assert.equal(textOf(linesOf(8)), 'const a = 12;');

// Continuity rule.
assert.ok(continuesFrom('a\n', 'a\nb', false));
assert.ok(!continuesFrom('a\n', 'a', false));
assert.ok(continuesFrom('a\n', 'a', true));
assert.ok(!continuesFrom('a\nb\n', 'a\nc', true));
assert.ok(!continuesFrom('const a = 1', 'const a = 12;\n', false), 'a final last line is not a line boundary');
assert.ok(continuesFrom('const a = 1', 'const a = 1', true));

// Shiki failing to load answers every request as plain instead of leaving it waiting.
const failed = [];
const broken = createHighlightEngine({
  loadShiki: () => Promise.reject(new Error('chunk failed')),
  post: (response) => failed.push(response),
  yieldNow: () => new Promise((resolve) => setImmediate(resolve)),
});
broken.receive({ type: 'highlight', id: 1, seq: 1, language: 'ts', text: 'a', final: true });
broken.receive({ type: 'highlight', id: 2, seq: 2, language: 'ts', text: 'b', final: true });
for (let i = 0; i < 50 && failed.length < 2; i += 1) await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(failed.map((r) => [r.id, r.done, r.lines.length]), [[1, true, 0], [2, true, 0]]);

console.log('code highlight: ok');
process.exit(0);
