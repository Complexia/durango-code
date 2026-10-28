import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { RotateCcw, Sparkles } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

// Embedded terminal hosting the interactive `claude` TUI for a thread
// ("Claude Code CLI" overlay on the Claude model picker tab). The PTY lives in the main process
// and survives unmounts (thread switches, tab changes); this view reattaches
// by replaying the scrollback snapshot returned by terminal:ensure, then
// applying only the data events newer than that snapshot (invoke replies and
// pushed events are not strictly ordered, so a per-session seq disambiguates).

// Session-id tracking note: the interactive TUI ignores --session-id, so the
// main process discovers the live session id from claude's on-disk session
// store and pushes it via the terminal:session event, which App.tsx stores on
// the thread (agentSessionIds.claude) for --resume after an app restart.
type TerminalViewProps = {
  threadId: string;
  projectPath: string;
  accessMode: 'read-only' | 'workspace-write' | 'full-access';
  /** Whether this pane currently owns keyboard input. */
  focused: boolean;
  /** Existing claude CLI session id for this thread; resumed on spawn. */
  resumeSessionId?: string;
  /** Fork the inherited resume session instead of appending to it in place. */
  forkSession?: boolean;
  /**
   * Orion's general instructions, appended to the CLI's system prompt at
   * spawn so they bind this session without touching on-disk CLAUDE.md files
   * (which would leak into claude runs outside Orion).
   */
  generalInstructions?: string;
};

const terminalTheme = {
  background: '#101012',
  foreground: '#d6d6dc',
  cursor: '#d6d6dc',
  cursorAccent: '#101012',
  selectionBackground: 'rgba(77, 141, 255, 0.30)',
};

export const TerminalView: React.FC<TerminalViewProps> = ({
  threadId,
  projectPath,
  accessMode,
  focused,
  resumeSessionId,
  forkSession = false,
  generalInstructions,
}) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [exitInfo, setExitInfo] = useState<{ exitCode: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Latest props for the mount-scoped effect and the overlay buttons.
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const resumeSessionIdRef = useRef(resumeSessionId);
  resumeSessionIdRef.current = resumeSessionId;
  // Ref, not an effect dep: edits to the settings field apply to the next
  // spawn instead of killing a live session to restart it.
  const generalInstructionsRef = useRef(generalInstructions);
  generalInstructionsRef.current = generalInstructions;
  const ensureRef = useRef<
    ((options: {
      fresh?: boolean;
      restart?: boolean;
      resumeSessionId?: string;
      forkSession?: boolean;
    }) => void) | null
  >(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !projectPath || !window.orion?.terminalEnsure) return undefined;

    let disposed = false;
    const term = new Terminal({
      fontSize: 12.5,
      fontFamily:
        '"SF Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
      cursorBlink: true,
      macOptionIsMeta: true,
      scrollback: 8000,
      theme: terminalTheme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    terminalRef.current = term;
    try {
      fit.fit();
    } catch {
      // host not measurable yet; the ResizeObserver below will fit it
    }

    // Events arriving before the ensure snapshot resolves are queued and
    // replayed after it, dropping the ones the snapshot already covers.
    let attached = false;
    let ensureAttempt = 0;
    const pending: Array<{ data: string; seq: number }> = [];
    let pendingExit: { exitCode: number | null } | null = null;
    const offData = window.orion.onTerminalData?.((event) => {
      if (event.threadId !== threadId) return;
      if (attached) term.write(event.data);
      else pending.push(event);
    });
    const offExit = window.orion.onTerminalExit?.((event) => {
      if (event.threadId !== threadId) return;
      const nextExit = { exitCode: event.exitCode };
      if (attached) setExitInfo(nextExit);
      else pendingExit = nextExit;
    });

    const ensure = async (options: {
      fresh?: boolean;
      restart?: boolean;
      resumeSessionId?: string;
      forkSession?: boolean;
    }) => {
      const attempt = ++ensureAttempt;
      // Every respawn has the same invoke-vs-push ordering race as the initial
      // mount. Queue its events until the matching snapshot arrives so output
      // included in that snapshot is never written twice.
      attached = false;
      pending.length = 0;
      pendingExit = null;
      setError(null);
      if (options.fresh) term.reset();
      const result = await window.orion.terminalEnsure({
        threadId,
        projectPath,
        accessMode,
        cols: term.cols,
        rows: term.rows,
        ...(options.fresh ? { fresh: true } : {}),
        ...(options.restart ? { restart: true } : {}),
        ...(options.resumeSessionId ? { resumeSessionId: options.resumeSessionId } : {}),
        ...(!options.fresh && (options.forkSession ?? forkSession)
          ? { forkSession: true }
          : {}),
        ...(generalInstructionsRef.current?.trim()
          ? { generalInstructions: generalInstructionsRef.current.trim() }
          : {}),
      });
      if (disposed || attempt !== ensureAttempt) return;
      if (!result.ok) {
        setError(result.error ?? 'Failed to start the Claude Code terminal.');
        return;
      }
      // An exit push can beat the invoke reply just like terminal:data can.
      // Prefer an exit observed during this ensure attempt over the reply's
      // spawn-time snapshot so a fast failure cannot lose its restart UI.
      const observedExit = pendingExit;
      const exited = Boolean(observedExit) || result.exited === true;
      setExitInfo(
        observedExit ?? (result.exited ? { exitCode: result.exitCode ?? null } : null)
      );
      if (result.snapshot) term.write(result.snapshot);
      const snapshotSeq = result.seq ?? 0;
      for (const event of pending) {
        if (event.seq > snapshotSeq) term.write(event.data);
      }
      pending.length = 0;
      pendingExit = null;
      attached = true;
      if (exited) return;
      // The PTY may have spawned at a different size than the fitted view.
      void window.orion.terminalResize?.({ threadId, cols: term.cols, rows: term.rows });
      if (focusedRef.current) term.focus();
    };
    ensureRef.current = (options) => void ensure(options);
    void ensure({ resumeSessionId: resumeSessionIdRef.current, forkSession });

    const inputDisposable = term.onData((data) => {
      void window.orion.terminalInput?.({ threadId, data });
    });

    const observer = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void window.orion.terminalResize?.({ threadId, cols: term.cols, rows: term.rows });
    });
    observer.observe(host);

    return () => {
      disposed = true;
      ensureRef.current = null;
      observer.disconnect();
      inputDisposable.dispose();
      offData?.();
      offExit?.();
      if (terminalRef.current === term) terminalRef.current = null;
      term.dispose();
    };
  }, [threadId, projectPath, accessMode, forkSession]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (focused) terminal?.focus();
    else terminal?.blur();
  }, [focused]);

  if (!projectPath) {
    return (
      <div className="terminal-view">
        <div className="terminal-overlay">
          <div className="terminal-overlay-card">
            <div className="terminal-overlay-title">No project folder</div>
            <div className="terminal-overlay-detail">
              This thread has no project directory to open Claude Code in.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const overlayVisible = Boolean(exitInfo || error);
  return (
    <div className="terminal-view">
      <div className="terminal-host" ref={hostRef} />
      {overlayVisible && (
        <div className="terminal-overlay">
          <div className="terminal-overlay-card">
            <div className="terminal-overlay-title">
              {error
                ? 'Claude Code failed to start'
                : `Claude Code exited${
                    exitInfo?.exitCode != null && exitInfo.exitCode !== 0
                      ? ` (code ${exitInfo.exitCode})`
                      : ''
                  }`}
            </div>
            {error && <div className="terminal-overlay-detail">{error}</div>}
            <div className="terminal-overlay-actions">
              {resumeSessionIdRef.current && (
                <button
                  className="btn"
                  onClick={() =>
                    ensureRef.current?.({
                      restart: true,
                      resumeSessionId: resumeSessionIdRef.current,
                    })
                  }
                >
                  <RotateCcw size={13} /> Resume session
                </button>
              )}
              <button
                className={resumeSessionIdRef.current ? 'btn secondary' : 'btn'}
                onClick={() => ensureRef.current?.({ fresh: true })}
              >
                <Sparkles size={13} /> Start fresh
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default TerminalView;
