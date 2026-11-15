import React, { useEffect, useMemo, useRef, useState } from 'react';
import { codeStyle, hasReadyHighlight, isPlainLanguage, useHighlightedLines, type HighlightedLine } from './codeHighlight';
import { useNearViewport } from './useNearViewport';

/** How long the copy button shows its check mark. */
const COPIED_MS = 1400;

/**
 * A copy action that shows a check mark for a moment. No effect: the reset
 * timer only exists after a click, and a reset after unmount is harmless.
 */
const useCopied = () => {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  const copy = (value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(true);
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => {
          setCopied(false);
          timer.current = null;
        }, COPIED_MS);
      })
      .catch(() => undefined);
  };
  return { copied, copy };
};

const copyButton = (copied: boolean, copy: () => void, title: string) => (
  <button
    type="button"
    className="code-block-action"
    data-copied={copied ? '' : undefined}
    data-icon={copied ? 'check' : 'copy'}
    onClick={copy}
    title={copied ? 'Copied' : title}
    aria-label={copied ? 'Copied' : title}
  />
);

export const CopyCodeButton: React.FC<{ value: string; title?: string }> = ({ value, title = 'Copy code' }) => {
  const { copied, copy } = useCopied();
  return copyButton(copied, () => copy(value), title);
};

/** The shared frame of code-like blocks: a header (label left, actions right) over the body. */
export const CodeFrame: React.FC<{
  label: React.ReactNode;
  actions: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ label, actions, children, className }) => (
  <div className={className ? `code-block ${className}` : 'code-block'}>
    <div className="code-block-header">
      <span className="code-block-label">{label}</span>
      <div className="code-block-actions">{actions}</div>
    </div>
    {children}
  </div>
);

/** Lines per memoized group: a streaming update re-renders the last group, not every line. */
const LINES_PER_GROUP = 16;

/**
 * Lines `start…`: the highlighted ones (`lines`), then the rest of the group
 * as plain text (`plain`). Each part is its own block (`.code-lines`), so
 * coloring or adding lines lays out that group, not the whole code block.
 * Lines within a part are joined by newlines. A part ending in an empty line
 * ends with a `<br>`: a block's final newline starts no line of its own, and
 * Chromium drops it when copying a selection; the `<br>` keeps both the
 * line's height and the copied text right. Highlighted lines are only ever
 * appended, never changed, so the same count and last line means the same
 * lines.
 */
const CodeGroup: React.FC<{ start: number; lines: HighlightedLine[]; plain: string[] }> = React.memo(
  ({ lines, plain }) => (
    <>
      {lines.length ? (
        <span className="code-lines">
          {lines.map((line, index) => (
            <React.Fragment key={index}>
              {index ? '\n' : null}
              {line.map((run, runIndex) =>
                run.style ? (
                  <span key={runIndex} style={codeStyle(run.style)}>
                    {run.content}
                  </span>
                ) : (
                  <React.Fragment key={runIndex}>{run.content}</React.Fragment>
                )
              )}
            </React.Fragment>
          ))}
          {lines[lines.length - 1].length === 0 ? <br /> : null}
        </span>
      ) : null}
      {plain.length ? (
        <span className="code-lines">
          {plain.join('\n')}
          {plain[plain.length - 1] === '' ? <br /> : null}
        </span>
      ) : null}
    </>
  ),
  (previous, next) =>
    previous.start === next.start &&
    previous.lines.length === next.lines.length &&
    previous.lines[previous.lines.length - 1] === next.lines[next.lines.length - 1] &&
    previous.plain.length === next.plain.length &&
    previous.plain.every((line, index) => line === next.plain[index])
);

/** Spans mounted per frame when a block's highlighting arrives all at once (from the cache). */
const RUNS_PER_FRAME = 1_000;
/** The first frame's share: about what a block shows on screen, so it never paints uncolored. */
const FIRST_FRAME_RUNS = 500;

/**
 * How many of `lines` to render highlighted now. Highlighting that arrives
 * all at once (a large block from the cache) mounts over a few frames, about
 * RUNS_PER_FRAME spans at a time, the rest showing as plain text meanwhile,
 * instead of in one long task. Once everything has been shown, lines appended
 * later (streaming, worker steps) render as they come; highlighting that
 * starts over (a different first line) is revealed gradually again.
 */
const useRevealedLineCount = (lines: HighlightedLine[] | undefined) => {
  const first = lines?.[0];
  const [anchor, setAnchor] = useState(first);
  const [budget, setBudget] = useState(FIRST_FRAME_RUNS);
  const [unlimited, setUnlimited] = useState(false);
  const restarted = first !== anchor;
  if (restarted) {
    // Adjusting state while rendering (React re-renders before committing).
    setAnchor(first);
    setBudget(FIRST_FRAME_RUNS);
    setUnlimited(false);
  }
  const currentBudget = restarted ? FIRST_FRAME_RUNS : budget;
  const limited = restarted || !unlimited;
  const total = lines?.length ?? 0;
  let count = total;
  if (limited && lines) {
    let runs = 0;
    count = 0;
    for (const line of lines) {
      runs += line.length;
      if (runs > currentBudget && count > 0) break;
      count += 1;
    }
  }
  useEffect(() => {
    if (!limited || !lines) return;
    if (count >= total) {
      setUnlimited(true);
      return;
    }
    const frame = requestAnimationFrame(() => setBudget((value) => value + RUNS_PER_FRAME));
    return () => cancelAnimationFrame(frame);
    // `budget`: a frame whose budget doesn't fit the next line yet (a very dense
    // line) must still schedule the next, or the reveal would stop there.
  }, [limited, lines, count, total, budget]);
  return count;
};

/** The fence's text with CR/CRLF as LF, and without a final text's parser newline. */
const codeText = (code: string, final: boolean) => {
  const normalized = code.includes('\r') ? code.replace(/\r\n?/g, '\n') : code;
  return final ? normalized.replace(/\n$/, '') : normalized;
};

/**
 * The lines to show: a final text already lost the parser's newline, so a
 * newline left at its end is a real blank last line; a streaming text's final
 * newline only ends its last line.
 */
const displayLines = (text: string, final: boolean) => (final ? text : text.replace(/\n$/, '')).split('\n');

/** The `<code>` children: groups of lines, the first `colored` from `lines`, the rest plain. */
const lineGroupNodes = (lineTexts: string[], lines: HighlightedLine[] | null, colored: number) => {
  const groups: React.ReactNode[] = [];
  for (let start = 0; start < lineTexts.length; start += LINES_PER_GROUP) {
    const end = Math.min(start + LINES_PER_GROUP, lineTexts.length);
    const split = Math.min(Math.max(colored, start), end);
    groups.push(
      <CodeGroup
        key={start}
        start={start}
        lines={lines && split > start ? lines.slice(start, split) : []}
        plain={lineTexts.slice(split, end)}
      />
    );
  }
  return groups;
};

/**
 * Plain lines as group blocks, like `CodeGroup`'s plain part but without a
 * component per group: plain blocks never change line by line.
 */
const plainGroupNodes = (lineTexts: string[]) => {
  const groups: React.ReactNode[] = [];
  for (let start = 0; start < lineTexts.length; start += LINES_PER_GROUP) {
    const part = lineTexts.slice(start, start + LINES_PER_GROUP);
    groups.push(
      <span key={start} className="code-lines">
        {part.join('\n')}
        {part[part.length - 1] === '' ? <br /> : null}
      </span>
    );
  }
  return groups;
};

/** Code that never gets colors (no language, `text`, output): no highlighter, no observer. */
const PlainCode: React.FC<{ code: string; final: boolean; wrap: boolean }> = React.memo(({ code, final, wrap }) => {
  const lineTexts = useMemo(() => displayLines(codeText(code, final), final), [code, final]);
  return (
    <pre className="code-block-pre" data-wrap={wrap ? '' : undefined}>
      <code>{plainGroupNodes(lineTexts)}</code>
    </pre>
  );
});

/**
 * Code colored by the highlighter: plain until its grammar has loaded and it
 * is near the viewport, then colored as lines are tokenized. A streaming
 * block's last line is only highlighted once it has ended.
 */
const ColoredCode: React.FC<{ code: string; language: string; final: boolean; wrap: boolean }> = React.memo(
  ({ code, language, final, wrap }) => {
    const ref = useRef<HTMLPreElement>(null);
    const text = codeText(code, final);
    // Only a block with colors ready to show checks its position before the
    // first paint (that reads layout); the rest wait for the observer. Asked
    // during the commit, after a replaced streaming block has handed over.
    const near = useNearViewport(ref, 800, true, () => hasReadyHighlight(language, text, final));
    const highlight = useHighlightedLines(text, language, final, near);
    const shown = useRevealedLineCount(highlight?.lines);
    const lineTexts = useMemo(() => displayLines(text, final), [text, final]);
    return (
      <pre ref={ref} className="code-block-pre" data-wrap={wrap ? '' : undefined}>
        <code>{lineGroupNodes(lineTexts, highlight?.lines ?? null, Math.min(shown, lineTexts.length))}</code>
      </pre>
    );
  }
);

/**
 * Code in a scrolling `<pre>`. `code` is the fence's text as written so far.
 * CR and CRLF line endings become LF first, so highlighting and display agree
 * on where lines end.
 */
export const HighlightedCode: React.FC<{ code: string; language: string; final?: boolean; wrap?: boolean }> =
  React.memo(({ code, language, final = true, wrap = false }) =>
    isPlainLanguage(language) ? (
      <PlainCode code={code} final={final} wrap={wrap} />
    ) : (
      <ColoredCode code={code} language={language} final={final} wrap={wrap} />
    )
  );

/**
 * A fenced code block: language label, wrap toggle and copy button over the
 * code. The frame is rendered here rather than through `CodeFrame` and
 * `CopyCodeButton`, and plain code inline: a transcript can hold many blocks,
 * and a plain one is then a single component.
 */
export const CodeBlock: React.FC<{ code: string; language: string; final: boolean }> = React.memo(
  ({ code: source, language, final }) => {
    const [wrap, setWrap] = useState(false);
    const { copied, copy } = useCopied();
    const plain = isPlainLanguage(language);
    const plainLines = useMemo(
      () => (plain ? displayLines(codeText(source, final), final) : null),
      [plain, source, final]
    );
    return (
      <div className="code-block">
        {/* The label is drawn from `data-label` (index.css): two fewer elements per block. */}
        <div className="code-block-header" data-label={language || 'text'}>
          <button
            type="button"
            className="code-block-action"
            aria-pressed={wrap}
            onClick={() => setWrap((value) => !value)}
            title={wrap ? 'Scroll long lines' : 'Wrap long lines'}
            aria-label={wrap ? 'Scroll long lines' : 'Wrap long lines'}
            data-icon="wrap"
          />
          {copyButton(copied, () => copy(source.replace(/\n$/, '')), 'Copy code')}
        </div>
        {plainLines ? (
          <pre className="code-block-pre" data-wrap={wrap ? '' : undefined}>
            <code>{plainGroupNodes(plainLines)}</code>
          </pre>
        ) : (
          <ColoredCode code={source} language={language} final={final} wrap={wrap} />
        )}
      </div>
    );
  }
);
