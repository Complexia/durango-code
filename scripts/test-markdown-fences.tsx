import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';

// What the markdown renderer hands the diagram block for open and closed fences.
const seen: { code: string; closed: boolean }[] = [];
mock.module('../src/store', () => ({ useOrionStore: create(() => ({ threads: [] })) }));
mock.module('../src/app/MermaidBlock', () => ({
  MermaidBlock: (props: { code: string; closed: boolean }) => {
    seen.push(props);
    return null;
  },
}));
const { MarkdownContent, StreamingMarkdownContent } = await import('../src/app/markdown');

const render = (content: string, streaming = false) => {
  seen.length = 0;
  renderToStaticMarkup(streaming ? <StreamingMarkdownContent content={content} /> : <MarkdownContent content={content} />);
  assert.equal(seen.length, 1);
  return seen[0];
};

// Mid-line: the unfinished last line has no newline, so it isn't drawn yet.
const midLine = render('Intro\n\n```mermaid\nflowchart LR\n  A --> B\n  B --> Cur', true);
assert.equal(midLine.closed, false);
assert.equal(midLine.code, 'flowchart LR\n  A --> B\n  B --> Cur');

// End of a line: every line is complete.
const lineDone = render('```mermaid\nflowchart LR\n  A --> B\n', true);
assert.equal(lineDone.closed, false);
assert.equal(lineDone.code, 'flowchart LR\n  A --> B\n');

// Closed fence.
const closed = render('```mermaid\nflowchart LR\n  A --> B\n```');
assert.equal(closed.closed, true);
assert.equal(closed.code, 'flowchart LR\n  A --> B\n');

// Inside a list item and a blockquote, offsets still find the closing fence.
assert.equal(render('- item\n\n  ```mermaid\n  flowchart LR\n  A --> B\n  ```\n').closed, true);
assert.equal(render('> ```mermaid\n> flowchart LR\n> A --> B\n> ```\n').closed, true);

// Open vs closed, as the parser sees it (the cases a line-by-line guess gets wrong).
const closedness: [string, boolean][] = [
  ['```ts\na\nb\n```', true],
  ['```ts\na\nb', false],
  ['```ts\na\nb\n', false],
  ['```ts\na\n\n\n', false],
  ['```\n```', true],
  ['```\n', false],
  ['````md\n```\ninner\n```\n', false],
  ['````md\n```\ninner\n```\n````\n', true],
  ['- item\n\n  ```js\n  a()\n  ```\n', true],
  ['- item\n\n  ```js\n  a()\n', false],
  ['> ```js\n> a()\n> ```\n', true],
  ['> ```js\n> a()\n', false],
  ['```mermaid\nx\n    ```', false],
  ['```mermaid\nx\n> ```', false],
  ['```mermaid\nx\n```\u00a0', false],
  ['```mermaid\nx\n   ```  ', true],
  ['~~~mermaid\nx\n~~~', true],
  // CR and CRLF line endings count as line endings.
  ['```mermaid\rx\r```', true],
  ['```mermaid\rx\r', false],
  ['```mermaid\r\nx\r\n```\r\n', true],
  ['```mermaid\r\nx\r\n', false],
];
for (const [markdown, expected] of closedness) {
  const fenced = markdown.replace(/^((?:- item\n\n  |> )?)(`{3,}|~{3,})(?:ts|js|md|mermaid)?/, '$1$2mermaid');
  assert.equal(render(fenced).closed, expected, JSON.stringify(fenced));
}

console.log('markdown fences: ok');
