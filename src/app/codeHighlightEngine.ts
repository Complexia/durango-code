import type { GrammarState, HighlighterCore, ThemedToken } from 'shiki/core';

/**
 * The tokenizing side of code highlighting. It runs in a Web Worker
 * (codeHighlight.worker.ts), so Shiki never blocks the transcript: a single
 * Shiki call can't be interrupted, and a dense line or a grammar's first use
 * can take over 100 ms. Pure apart from Shiki, so tests drive it in Node.
 *
 * Each code block on screen has a session: its text, how far it has been
 * tokenized (always to a line boundary) and Shiki's grammar state there. A
 * streaming block only tokenizes lines that ended since its last update. Work
 * is done in short steps, round-robin across blocks, and the newest request
 * for a block replaces any older one still waiting.
 */

export const THEME = 'durango';

/** Longer lines (minified code, data) render as one plain run. */
const MAX_LINE_LENGTH = 1_000;
/** Lines per Shiki call; a step makes calls until its time is up. */
const LINES_PER_CALL = 8;
const STEP_MS = 12;
/** Runs (spans) one block may render, about 50 ms to mount; lines past that stay plain. */
export const MAX_RUNS_PER_BLOCK = 8_000;

/** One run of same-styled text: `[content, style index]`, 0 meaning unstyled. */
export type Run = { content: string; style: number };
export type HighlightedLine = Run[];

export type HighlightRequest = {
  type: 'highlight';
  id: number;
  seq: number;
  language: string;
  text: string;
  final: boolean;
};
export type DropRequest = { type: 'drop'; id: number };
export type EngineRequest = HighlightRequest | DropRequest;

export type HighlightResponse = {
  id: number;
  seq: number;
  /** The lines start over (a new session); otherwise `lines` follow the ones sent before. */
  reset: boolean;
  lines: HighlightedLine[];
  /** Characters of the request's text the lines cover (to a line boundary, or the end when final). */
  consumed: number;
  /** No more lines will come for this text (finished, capped, failed, or no grammar). */
  done: boolean;
  /** Styles referenced by these lines that the client hasn't been sent yet. */
  styles: StyleEntry[];
};

/** `color` (a CSS value, here `var(--code-…)`) and Shiki's fontStyle flags: italic 1, bold 2, underline 4. */
export type StyleEntry = { index: number; color?: string; fontStyle: number };

/** Fence info words that mean "no grammar" rather than an unknown language. */
export const PLAIN_LANGUAGES = new Set(['', 'text', 'txt', 'plain', 'plaintext', 'output', 'console-output', 'log']);

/** Common fence names Shiki doesn't alias itself. */
const EXTRA_ALIASES: Record<string, string> = {
  console: 'shellsession',
  shell: 'shellscript',
  terminal: 'shellsession',
  env: 'dotenv',
  dockerfile: 'docker',
  golang: 'go',
  'c++': 'cpp',
  objc: 'objective-c',
  patch: 'diff',
  conf: 'ini',
};

type LangsModule = typeof import('shiki/langs');

/** Shiki's grammar id for a fence language, or null when there is none to load. */
export const resolveGrammar = (language: string, langs: LangsModule): string | null => {
  const name = language.trim().toLowerCase();
  if (PLAIN_LANGUAGES.has(name)) return null;
  const candidate = EXTRA_ALIASES[name] ?? name;
  const info = langs.bundledLanguagesInfo.find(
    (entry) => entry.id === candidate || entry.aliases?.includes(candidate)
  );
  return info?.id ?? null;
};

/** Where tokenizing may go up to: every line when final, else only lines that have ended. */
export const tokenizableEnd = (text: string, final: boolean) => (final ? text.length : text.lastIndexOf('\n') + 1);

/**
 * Whether work done on `done` (the tokenized prefix of an earlier text)
 * still holds for `text`: the text only grew past a line boundary (a line
 * tokenized as final and then extended must be tokenized again). A fence that
 * closes loses the newline after its last line, so a final text may end one
 * newline short.
 */
export const continuesFrom = (done: string, text: string, final: boolean) => {
  if (text === done || done === '') return true;
  if (!done.endsWith('\n')) return false;
  return text.startsWith(done) || (final && text === done.slice(0, -1));
};

type Session = {
  grammar: string;
  text: string;
  consumed: number;
  lines: number;
  runs: number;
  state: GrammarState | undefined;
  failed: boolean;
  /** Hit MAX_RUNS_PER_BLOCK: the rest stays plain. */
  capped: boolean;
};

const isDone = (session: Session, final: boolean) =>
  session.failed || session.capped || session.consumed >= tokenizableEnd(session.text, final);

export type EngineDeps = {
  loadShiki: () => Promise<{
    core: typeof import('shiki/core');
    engine: typeof import('shiki/engine/javascript');
    langs: LangsModule;
  }>;
  post: (response: HighlightResponse) => void;
  /** Lets queued messages in between steps. */
  yieldNow: () => Promise<void>;
  now?: () => number;
};

export const createHighlightEngine = (deps: EngineDeps) => {
  const now = deps.now ?? (() => performance.now());
  let ready: Promise<{ highlighter: HighlighterCore; langs: LangsModule }> | null = null;
  const loaded = new Map<string, Promise<boolean>>();
  const sessions = new Map<number, Session>();
  const pending = new Map<number, HighlightRequest>();
  /** Blocks still mounted: a drop while a grammar loads must not leave a session behind. */
  const live = new Set<number>();
  const styleIndex = new Map<string, number>();
  let stylesSent = 0;
  let pumping = false;

  const load = () => {
    ready ??= deps.loadShiki().then(async ({ core, engine, langs }) => ({
      langs,
      highlighter: await core.createHighlighterCore({
        themes: [core.createCssVariablesTheme({ name: THEME, variablePrefix: '--code-', fontStyle: true })],
        langs: [],
        engine: engine.createJavaScriptRegexEngine({ forgiving: true }),
      }),
    }));
    return ready;
  };

  const loadGrammar = (grammar: string, highlighter: HighlighterCore, langs: LangsModule) => {
    let load = loaded.get(grammar);
    if (!load) {
      const importer = langs.bundledLanguages[grammar as keyof LangsModule['bundledLanguages']];
      load = importer
        ? highlighter.loadLanguage(importer).then(
            () => true,
            () => false
          )
        : Promise.resolve(false);
      loaded.set(grammar, load);
    }
    return load;
  };

  const styleOf = (token: ThemedToken, fresh: StyleEntry[]) => {
    const fontStyle = token.fontStyle && token.fontStyle > 0 ? token.fontStyle : 0;
    if (!token.color && !fontStyle) return 0;
    const key = `${token.color ?? ''}|${fontStyle}`;
    let index = styleIndex.get(key);
    if (index === undefined) {
      index = styleIndex.size + 1;
      styleIndex.set(key, index);
    }
    if (index > stylesSent) {
      fresh.push({ index, color: token.color, fontStyle });
      stylesSent = index;
    }
    return index;
  };

  /** Same-styled neighbours join; whitespace joins the run before it (its color doesn't show). */
  const compact = (tokens: readonly ThemedToken[], fresh: StyleEntry[]): HighlightedLine => {
    const runs: HighlightedLine = [];
    for (const token of tokens) {
      if (!token.content) continue;
      const style = styleOf(token, fresh);
      const previous = runs[runs.length - 1];
      const underline = ((token.fontStyle ?? 0) & 4) !== 0;
      if (previous && (previous.style === style || (!underline && !token.content.trim()))) {
        previous.content += token.content;
      } else {
        runs.push({ content: token.content, style });
      }
    }
    return runs;
  };

  /** Nothing to show for this request, ever: plain text. */
  const givePlain = (request: HighlightRequest) => {
    sessions.delete(request.id);
    deps.post({ id: request.id, seq: request.seq, reset: true, lines: [], consumed: 0, done: true, styles: [] });
  };

  const work = async (request: HighlightRequest) => {
    let loadedShiki: Awaited<ReturnType<typeof load>>;
    try {
      loadedShiki = await load();
    } catch {
      // Shiki's chunks failed to load: everything stays plain.
      givePlain(request);
      return;
    }
    const { highlighter, langs } = loadedShiki;
    if (!live.has(request.id)) return;
    const grammar = resolveGrammar(request.language, langs);
    if (!grammar || !(await loadGrammar(grammar, highlighter, langs))) {
      givePlain(request);
      return;
    }
    // Dropped, or a newer request for this block arrived, while the grammar loaded.
    if (!live.has(request.id) || pending.has(request.id)) return;

    let session = sessions.get(request.id);
    let reset = false;
    if (
      !session ||
      session.grammar !== grammar ||
      !continuesFrom(session.text.slice(0, session.consumed), request.text, request.final)
    ) {
      session = {
        grammar,
        text: request.text,
        consumed: 0,
        lines: 0,
        runs: 0,
        state: undefined,
        failed: false,
        capped: false,
      };
      sessions.set(request.id, session);
      reset = true;
    }
    session.text = request.text;
    session.consumed = Math.min(session.consumed, request.text.length);

    const fresh: StyleEntry[] = [];
    const lines: HighlightedLine[] = [];
    const end = tokenizableEnd(session.text, request.final);
    const started = now();
    while (!isDone(session, request.final)) {
      let stop = session.consumed;
      for (let count = 0; count < LINES_PER_CALL && stop < end; count += 1) {
        const newline = session.text.indexOf('\n', stop);
        stop = newline === -1 || newline >= end ? end : newline + 1;
      }
      const chunk = session.text.slice(session.consumed, stop).replace(/\n$/, '');
      try {
        const result = highlighter.codeToTokens(chunk, {
          lang: grammar,
          theme: THEME,
          grammarState: session.state,
          tokenizeMaxLineLength: MAX_LINE_LENGTH,
        });
        // Lines are taken until the run budget; past it the session stops
        // (its grammar state no longer matters) and only taken lines count.
        let offset = session.consumed;
        for (const line of result.tokens) {
          const runs = compact(line, fresh);
          if (session.runs + runs.length > MAX_RUNS_PER_BLOCK) {
            session.capped = true;
            break;
          }
          session.runs += runs.length;
          lines.push(runs);
          session.lines += 1;
          const newline = session.text.indexOf('\n', offset);
          offset = newline === -1 || newline >= stop ? stop : newline + 1;
        }
        session.state = result.grammarState;
        session.consumed = session.capped ? offset : stop;
      } catch {
        session.failed = true;
      }
      if (now() - started >= STEP_MS) break;
    }
    const done = isDone(session, request.final);
    deps.post({ id: request.id, seq: request.seq, reset, lines, consumed: session.consumed, done, styles: fresh });
    // More to do and nothing newer queued for this block: continue after the others.
    if (!done && !pending.has(request.id)) pending.set(request.id, request);
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (pending.size) {
        const [id, request] = pending.entries().next().value as [number, HighlightRequest];
        pending.delete(id);
        try {
          await work(request);
        } catch {
          givePlain(request);
        }
        await deps.yieldNow();
      }
    } finally {
      pumping = false;
    }
  };

  return {
    receive(message: EngineRequest) {
      if (message.type === 'drop') {
        live.delete(message.id);
        sessions.delete(message.id);
        pending.delete(message.id);
        return;
      }
      live.add(message.id);
      pending.delete(message.id);
      pending.set(message.id, message);
      void pump();
    },
    /** For tests. */
    sessionCount: () => sessions.size,
  };
};
