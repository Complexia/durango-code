import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Code2, Maximize2, Workflow, X } from 'lucide-react';
import { CodeFrame, CopyCodeButton, HighlightedCode } from './CodeBlock';
import { useNearViewport } from './useNearViewport';

/**
 * Mermaid fences drawn with Pele (https://pele.run), the renderer Durango Chat
 * uses: synchronous and fast enough to redraw while the fence streams in, and
 * themed by the `--pele-*` variables on `.markdown-diagram` (index.css). Only
 * the module and each diagram type's code load lazily.
 */

/** An unclosed fence that hasn't changed for this long is treated as final (stream ended or stalled). */
const UNCLOSED_IDLE_MS = 1500;
const FONT_SIZE = 13;
/** Below this the labels get too small to read; scroll sideways instead. */
const MIN_INLINE_WIDTH = 420;
/** `.markdown-diagram-canvas` padding on each side. */
const DIAGRAM_PADDING = 16;
/** `.markdown-diagram-zoom` inset inside the expanded view. */
const STAGE_INSET = 24;
const EXPANDED_FONT_SIZE = 15;
/** How far the expanded view enlarges a small diagram before the user zooms. */
const MAX_EXPANDED_SCALE = 2;
/** While a pane is being resized the drawn SVG scales; it is laid out again once the width settles. */
const RESIZE_SETTLE_MS = 200;
/** A streaming diagram is laid out again at most this often. */
const STREAM_RENDER_MS = 250;
/** Larger sources stay as code: laying them out would stall the transcript. */
const MAX_SOURCE_CHARS = 20_000;
const MAX_EDGES = 1_000;

type PeleApi = typeof import('pele/lazy');

let peleApi: PeleApi | null = null;
let pelePromise: Promise<PeleApi> | null = null;
const loadPele = (): Promise<PeleApi> => {
  pelePromise ??= import('pele/lazy').then(
    (module) => (peleApi = module),
    (error: unknown) => {
      // Let a later diagram try again (a chunk that failed to load once may load next time).
      pelePromise = null;
      throw error;
    }
  );
  return pelePromise;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Text widths are measured with canvas and cached; drop them once web fonts arrive. */
let fontsPromise: Promise<void> | null = null;
const fontsSettled = (): Promise<void> => {
  fontsPromise ??= (document.fonts?.ready ?? Promise.resolve()).then(() => {
    peleApi?.forgetTextWidths();
  });
  return fontsPromise;
};

type DiagramResult = { ok: true; svg: string; width: number; height: number } | { ok: false; error: string };

type Measure = { width: number; font: string; mono: string };

/** Content width and the diagram fonts (from `--pele-font*`) of the element `ref` points at. */
const useMeasure = (ref: RefObject<HTMLElement | null>, padding: number): Measure | null => {
  const [measure, setMeasure] = useState<Measure | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const read = () => {
      const styles = getComputedStyle(element);
      const width = Math.max(0, Math.floor(element.clientWidth - 2 * padding));
      const font = styles.getPropertyValue('--pele-font').trim() || styles.fontFamily;
      const mono = styles.getPropertyValue('--pele-font-mono').trim() || 'monospace';
      setMeasure((previous) =>
        previous && previous.width === width && previous.font === font && previous.mono === mono
          ? previous
          : { width, font, mono }
      );
    };
    read();
    // Later changes wait until resizing stops: every width means a new layout.
    // A hidden pane (width 0) keeps its last layout.
    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (element.clientWidth > 0) read();
      }, RESIZE_SETTLE_MS);
    });
    observer.observe(element);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, [ref, padding]);
  return measure;
};

/** Renders `source` with Pele once its module, the diagram type and the fonts are ready. */
const useDiagram = (
  source: string,
  measure: Measure | null,
  idPrefix: string,
  fontSize = FONT_SIZE
): DiagramResult | null => {
  const [api, setApi] = useState<PeleApi | null>(peleApi);
  // Bumped when a diagram type's code arrives, so `registered()` is read again.
  const [, setLoadedTypes] = useState(0);
  const [fontsReady, setFontsReady] = useState(false);
  // Pele or a diagram type's code failed to load for this source: show the
  // source instead of waiting forever. A different source tries again.
  // `type` null: Pele itself failed to load; otherwise that diagram type did.
  const [loadError, setLoadError] = useState<{
    source: string;
    type: NonNullable<ReturnType<PeleApi['detectType']>> | null;
    message: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fontsSettled().then(() => {
      if (!cancelled) setFontsReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Until Pele has loaded. The promise is shared while pending and dropped on
  // failure, so running again for a new source is cheap, and retries a failure.
  useEffect(() => {
    if (api) return;
    let cancelled = false;
    loadPele().then(
      (loaded) => {
        if (cancelled) return;
        setApi(loaded);
        // Loaded now: an error from an earlier failed attempt is stale.
        setLoadError(null);
      },
      (error: unknown) => {
        if (!cancelled)
          setLoadError({ source, type: null, message: `Couldn't load the diagram renderer: ${errorText(error)}` });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [api, source]);

  // Detection parses front matter, and malformed front matter throws.
  let type: ReturnType<PeleApi['detectType']> = null;
  let detectError: string | null = null;
  if (api && source.trim()) {
    try {
      type = api.detectType(source);
    } catch (error) {
      detectError = errorText(error);
    }
  }
  const typeReady = Boolean(api && type && api.registered(type));
  // An error shows only for its source, and only while what failed is still
  // missing: another block may since have loaded Pele or that diagram type.
  const currentError =
    loadError && loadError.source === source && (loadError.type === null ? !api : !api?.registered(loadError.type))
      ? loadError.message
      : null;

  useEffect(() => {
    if (!api || !type || typeReady) return;
    let cancelled = false;
    api.load(type).then(
      (loaded) => {
        if (cancelled) return;
        if (loaded) {
          setLoadedTypes((count) => count + 1);
          setLoadError(null);
        } else setLoadError({ source, type, message: `Diagram type "${type}" isn't supported` });
      },
      (error: unknown) => {
        if (!cancelled)
          setLoadError({ source, type, message: `Couldn't load the ${type} diagram: ${errorText(error)}` });
      }
    );
    return () => {
      cancelled = true;
    };
    // `source`: a new source retries a type that failed to load.
  }, [api, type, typeReady, source]);

  return useMemo((): DiagramResult | null => {
    void fontsReady; // re-measure labels once web fonts have loaded
    if (currentError) return { ok: false, error: currentError };
    if (!api || !measure || measure.width <= 0 || !source.trim()) return null;
    if (detectError) return { ok: false, error: detectError };
    if (type && !typeReady) return null;
    try {
      const result = api.render(source, {
        idPrefix,
        fontFamily: measure.font,
        fontFamilyMono: measure.mono,
        fontSize,
        maxWidth: measure.width,
        limit: MAX_SOURCE_CHARS,
        maxEdges: MAX_EDGES,
        // Agent-written source: no outbound links or remote images.
        links: false,
        images: false,
      });
      return { ok: true, svg: result.svg, width: result.width, height: result.height };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }, [api, type, typeReady, detectError, currentError, fontsReady, measure, source, idPrefix, fontSize]);
};

/** `value`, except that it keeps its last value while `frozen`. */
const useFrozenWhile = <T,>(value: T, frozen: boolean): T => {
  // State adjusted during render rather than a ref written during render, so
  // a render React throws away can't change what a later one sees.
  const [kept, setKept] = useState(value);
  if (!frozen && !Object.is(kept, value)) setKept(value);
  return frozen ? kept : value;
};

/** `value`, changing at most once per `ms` while `enabled` (the latest value always arrives). */
const useThrottled = (value: string, ms: number, enabled: boolean): string => {
  const [shown, setShown] = useState(value);
  const shownAt = useRef(0);
  useEffect(() => {
    if (!enabled) return;
    const show = () => {
      shownAt.current = Date.now();
      setShown(value);
    };
    const wait = shownAt.current + ms - Date.now();
    if (wait <= 0) {
      show();
      return;
    }
    const timer = window.setTimeout(show, wait);
    return () => window.clearTimeout(timer);
  }, [value, ms, enabled]);
  return enabled ? shown : value;
};

/** True once `value` has stayed the same for `delayMs`. */
const useSettled = (value: string, delayMs: number, enabled: boolean) => {
  const [settledValue, setSettledValue] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => setSettledValue(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs, enabled]);
  return enabled && settledValue === value;
};

/**
 * While the fence streams, draw only complete lines (a half-written line would
 * show a truncated label), and only once there is more than the header to draw.
 */
export const streamingDiagramSource = (code: string) => {
  const complete = code.slice(0, code.lastIndexOf('\n') + 1);
  const statements = complete.split('\n').filter((line) => line.trim() && !line.trim().startsWith('%%'));
  return statements.length >= 2 ? complete : '';
};

const useIdPrefix = (suffix: string) => `dg${useId().replace(/[^a-zA-Z0-9_-]/g, '')}${suffix}-`;

const DiagramSvg: React.FC<{ svg: string; width: number }> = ({ svg, width }) => (
  <div
    className="markdown-diagram-svg"
    // Fit narrow columns down to MIN_INLINE_WIDTH, then scroll instead of shrinking.
    style={{ maxWidth: width, minWidth: Math.min(width, MIN_INLINE_WIDTH) }}
    // Pele escapes diagram text and emits no scripts or event handlers; links and images are off.
    dangerouslySetInnerHTML={{ __html: svg }}
  />
);

/** Full-window view: the diagram fits the stage; pinch, ⌘/Ctrl-wheel, drag or double-click to zoom and pan. */
const ExpandedDiagram: React.FC<{ code: string; onClose: () => void }> = ({ code, onClose }) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const measure = useMeasure(stageRef, STAGE_INSET);
  const result = useDiagram(code, measure, useIdPrefix('x'), EXPANDED_FONT_SIZE);
  const drawn = result?.ok ? result : null;
  const svg = drawn?.svg ?? null;

  useEffect(() => {
    const element = zoomRef.current;
    const stage = stageRef.current;
    if (!drawn || !element || !stage || !peleApi) return;
    // Scale the drawing up to fill the stage (small diagrams no more than
    // MAX_EXPANDED_SCALE); zooming starts from there.
    const svgElement = element.querySelector('svg');
    if (svgElement && drawn.width > 0 && drawn.height > 0) {
      const scale = Math.min(
        (stage.clientWidth - 2 * STAGE_INSET) / drawn.width,
        (stage.clientHeight - 2 * STAGE_INSET) / drawn.height,
        MAX_EXPANDED_SCALE
      );
      svgElement.style.maxWidth = 'none';
      svgElement.style.width = `${Math.floor(drawn.width * scale)}px`;
      svgElement.style.height = `${Math.floor(drawn.height * scale)}px`;
    }
    const zoom = peleApi.enableZoom(element, { always: true, maxScale: 4, controls: true });
    return () => zoom.destroy();
  }, [drawn]);

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    // Everything behind the dialog is inert while it is open: Tab can't reach
    // it and clicks can't land on it.
    const overlay = overlayRef.current;
    const inerted = Array.from(document.body.children).filter(
      (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay && !element.inert
    );
    for (const element of inerted) element.inert = true;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      for (const element of inerted) element.inert = false;
      restore?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={overlayRef}
      className="markdown-diagram-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Diagram"
      onMouseDown={onClose}
    >
      <div className="markdown-diagram-dialog markdown-diagram" onMouseDown={(event) => event.stopPropagation()}>
        <div className="markdown-diagram-dialog-header">
          <span>Diagram</span>
          <span className="markdown-diagram-hint">Scroll or pinch to zoom · drag to pan</span>
          <button ref={closeRef} type="button" className="code-block-action" onClick={onClose} title="Close (Esc)">
            <X size={14} aria-hidden />
          </button>
        </div>
        <div ref={stageRef} className="markdown-diagram-stage">
          {svg ? <div ref={zoomRef} className="markdown-diagram-zoom" dangerouslySetInnerHTML={{ __html: svg }} /> : null}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const MermaidBlock: React.FC<{
  code: string;
  /** Closing fence present: the block won't change any more. */
  closed: boolean;
}> = React.memo(({ code: source, closed }) => {
  const code = source.replace(/\n$/, '');
  const idle = useSettled(code, UNCLOSED_IDLE_MS, !closed);
  const stable = closed || idle;
  const [view, setView] = useState<'diagram' | 'code'>('diagram');
  const [expanded, setExpanded] = useState(false);
  // Stable, so the dialog's focus and inert effect runs once per opening.
  const closeExpanded = useCallback(() => setExpanded(false), []);
  const bodyRef = useRef<HTMLDivElement>(null);
  const measure = useMeasure(bodyRef, DIAGRAM_PADDING);
  // Laid out only while near the viewport and showing the diagram: opening a
  // long thread doesn't lay out every diagram, and neither a resize nor more
  // streamed source redoes one scrolled away or showing its code (it keeps
  // its drawing, scaled, until it is back). Until first near, the frozen
  // measure is the initial null, so nothing is laid out at all.
  // Once Pele is loaded a diagram can draw before the first paint (a remount
  // during streaming shouldn't flash the skeleton), so check position then.
  const near = useNearViewport(bodyRef, 800, false, peleApi !== null);
  const paused = view === 'code' || !near;
  const diagramMeasure = useFrozenWhile(measure, paused);
  const diagramSource = useFrozenWhile(
    useThrottled(stable ? code : streamingDiagramSource(source), STREAM_RENDER_MS, !stable),
    paused
  );
  const result = useDiagram(diagramSource, diagramMeasure, useIdPrefix('i'));

  // While streaming, keep the last diagram that drew until the next one does.
  const [lastGood, setLastGood] = useState<Extract<DiagramResult, { ok: true }> | null>(null);
  if (result?.ok && result !== lastGood) setLastGood(result);
  const shown = result?.ok ? result : stable ? null : lastGood;
  const failed = stable && result && !result.ok ? result : null;
  const ready = Boolean(shown);

  return (
    <CodeFrame
      className="markdown-diagram-frame"
      label={
        <>
          Mermaid
          {failed ? <span className="code-block-note" title={failed.error}>Couldn’t render diagram</span> : null}
        </>
      }
      actions={
        <>
          {ready ? (
            <div className="code-block-toggle" role="group" aria-label="Diagram view">
              {(['diagram', 'code'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={view === option}
                  onClick={() => setView(option)}
                  title={option === 'diagram' ? 'Show diagram' : 'Show source'}
                >
                  {option === 'diagram' ? <Workflow size={13} aria-hidden /> : <Code2 size={13} aria-hidden />}
                  <span>{option === 'diagram' ? 'Diagram' : 'Code'}</span>
                </button>
              ))}
            </div>
          ) : null}
          <CopyCodeButton value={code} />
          {ready && stable ? (
            <button type="button" className="code-block-action" onClick={() => setExpanded(true)} title="Expand diagram">
              <Maximize2 size={13} aria-hidden />
            </button>
          ) : null}
        </>
      }
    >
      {/* Always mounted so the available width is known before the first render. */}
      <div ref={bodyRef} className="markdown-diagram">
        {shown && view === 'diagram' ? (
          <div className="markdown-diagram-canvas" onDoubleClick={stable ? () => setExpanded(true) : undefined}>
            <DiagramSvg svg={shown.svg} width={shown.width} />
          </div>
        ) : !shown && stable && !failed ? (
          <div className="markdown-diagram-loading" aria-busy="true">
            <div />
            <div />
          </div>
        ) : (
          <HighlightedCode code={source} language="mermaid" final={stable} />
        )}
      </div>
      {expanded ? <ExpandedDiagram code={code} onClose={closeExpanded} /> : null}
    </CodeFrame>
  );
});
