import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';

mock.module('../src/store', () => ({ useOrionStore: create(() => ({ threads: [] })) }));
const { MarkdownContent, StreamingMarkdownContent } = await import('../src/app/markdown');
const { fenceLanguage } = await import('../src/app/codeHighlight');
const { streamingDiagramSource } = await import('../src/app/MermaidBlock');

const html = (content: string) => renderToStaticMarkup(<MarkdownContent content={content} />);

// Tables sit in a scrolling wrapper, keep GFM alignment, and stay real tables.
const table = html(['| # | Severity | Fix |', '|---|:---:|---:|', '| 1 | High | Clean the CSS |'].join('\n'));
assert.match(table, /<div class="markdown-table"><table>/);
assert.match(table, /<th style="text-align:center">Severity<\/th>|<th align="center">Severity<\/th>/);
assert.match(table, /<td[^>]*>Clean the CSS<\/td>/);

// Prose columns (a cell of 40+ characters) are marked for their minimum width, in
// header and body cells alike; short columns are not.
const proseTable = html(['| # | Fix |', '|---|---|', '| 1 | Theme CSS is now cleaned before it is applied to the page. |'].join('\n'));
assert.match(proseTable, /<th data-prose="">Fix<\/th>/);
assert.match(proseTable, /<td data-prose="">Theme CSS/);
assert.match(proseTable, /<th>#<\/th>/);
assert.match(proseTable, /<td>1<\/td>/);
// Tables nested in lists and blockquotes get the wrapper too.
assert.match(html('> | a | b |\n> |---|---|\n> | 1 | 2 |'), /<blockquote>\s*<div class="markdown-table"><table>/);

// Fenced code gets the frame: language label, wrap toggle, copy, and the code text intact.
const code = html(['```ts', 'const a = 1 < 2;', '```'].join('\n'));
assert.match(code, /class="code-block"/);
assert.match(code, /class="code-block-header" data-label="ts"/);
assert.match(code, /aria-label="Copy code"/);
assert.match(code, /aria-label="Wrap long lines"/);
assert.match(code, /<pre class="code-block-pre"><code><span class="code-lines">const a = 1 &lt; 2;<\/span><\/code><\/pre>/);
assert.doesNotMatch(code, /\n<\/code>/, 'the trailing newline is dropped');

// No language: labelled as text. Indented code is a block too.
assert.match(html(['```', 'plain', '```'].join('\n')), /class="code-block-header" data-label="text"/);
assert.match(html('    indented();'), /class="code-block-pre"><code><span class="code-lines">indented\(\);<\/span><\/code>/);

// One block per group of 16 lines, so coloring lines lays out only their group.
// Every line survives, empty ones included; a group ending in an empty line
// ends with <br> (keeps its height and the copied text).
const codeLines = (markup: string) =>
  [...markup.matchAll(/<span class="code-lines">([^<]*)(?:<br\/>)?<\/span>/g)].flatMap((match) => match[1].split('\n'));
assert.deepEqual(codeLines(html(['```js', 'a();', '', 'b();', '```'].join('\n'))), ['a();', '', 'b();']);
// CR and CRLF line endings are lines too (the highlighter gets the same LF text).
assert.deepEqual(codeLines(html('```ts\r\n// hi\r\nconst a = 1;\r\n```')), ['// hi', 'const a = 1;']);
assert.deepEqual(codeLines(html('```ts\r// hi\rconst a = 1;\r```')), ['// hi', 'const a = 1;']);
// A blank last line inside a closed fence stays (only the parser's own newline goes).
assert.deepEqual(codeLines(html(['```text', 'a', '', '```'].join('\n'))), ['a', '']);
assert.deepEqual(codeLines(html(['```text', 'a', '', '', '```'].join('\n'))), ['a', '', '']);
assert.deepEqual(codeLines(html(['```text', 'a', '```'].join('\n'))), ['a']);
// The same in a streaming (open) fence once the blank line has ended.
const openBlank = renderToStaticMarkup(<StreamingMarkdownContent content={'```text\na\n\n'} />);
assert.deepEqual(codeLines(openBlank), ['a', '']);
// Lines past 16 go into further groups without losing or duplicating any.
const many = Array.from({ length: 40 }, (_, i) => `line${i}`);
assert.deepEqual(codeLines(html(['```', ...many, '```'].join('\n'))), many);
assert.equal([...html(['```', ...many, '```'].join('\n')).matchAll(/class="code-lines"/g)].length, 3, '40 lines: 3 groups');
const blankAtBoundary = [...Array.from({ length: 15 }, (_, i) => `l${i}`), '', 'after'];
const blankMarkup = html(['```', ...blankAtBoundary, '```'].join('\n'));
assert.deepEqual(codeLines(blankMarkup), blankAtBoundary);
assert.match(blankMarkup, /<span class="code-lines">l0\n[^<]*l14\n<br\/><\/span><span class="code-lines">after<\/span>/);

// Inline code stays inline.
const inline = html('Use `npm test` here.');
assert.match(inline, /<p>Use <code>npm test<\/code> here\.<\/p>/);
assert.doesNotMatch(inline, /code-block/);

// Mermaid fences become diagram frames (the diagram itself draws in the browser).
const diagram = html(['```mermaid', 'flowchart LR', '  A --> B', '```'].join('\n'));
assert.match(diagram, /class="code-block markdown-diagram-frame"/);
assert.match(diagram, /class="markdown-diagram"/);

// Streaming content renders the same blocks.
const streaming = renderToStaticMarkup(<StreamingMarkdownContent content={'Intro\n\n```py\nprint(1)\n'} />);
assert.match(streaming, /class="code-block-header" data-label="py"/);

// Diagrams draw only complete lines while streaming.
assert.equal(streamingDiagramSource('flowchart LR\n  A --> B\n  B --> C'), 'flowchart LR\n  A --> B\n');
assert.equal(streamingDiagramSource('flowchart LR\n  A -'), '');

// Fence words.
assert.equal(fenceLanguage('language-TS'), 'ts');
assert.equal(fenceLanguage(undefined), '');

console.log('markdown blocks: ok');
