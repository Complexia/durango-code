import React from 'react';
import { X } from 'lucide-react';
import type { Project, Thread } from '../store';
import { ProjectIcon } from './ProjectIcon';
import ThemeSlot from './themes/ThemeSlot';

export type ThreadPaneProps = {
  thread: Thread;
  project: Project | null;
  /** The pane the composer lives in and that keyboard shortcuts act on. */
  focused: boolean;
  /**
   * False while a single thread fills the main view: the pane is then the whole
   * view, so it drops its header and focus ring and looks exactly as the
   * unsplit thread view always has.
   */
  split: boolean;
  onFocus: () => void;
  onClose: () => void;
  statusDot?: React.ReactNode;
  children: React.ReactNode;
};

/**
 * One thread in the split view: chrome around a transcript (or terminal) plus
 * the composer, which only the focused pane renders. Focus follows pointer and
 * keyboard focus into the pane, so replying to a background agent is one step.
 */
export const ThreadPane: React.FC<ThreadPaneProps> = ({
  thread,
  project,
  focused,
  split,
  onFocus,
  onClose,
  statusDot,
  children,
}) => (
  <section
    className={`thread-pane${focused ? ' focused' : ''}${split ? ' split' : ''}`}
    // Capture: the press must claim focus before the click reaches a button
    // inside an unfocused pane, so that button acts on its own thread. Closing
    // is the exception: focusing a pane immediately before removing it changes
    // closeThreadPane's fallback selection.
    onPointerDownCapture={
      focused
        ? undefined
        : (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('.thread-pane-close')) return;
            onFocus();
          }
    }
    // Keyboard focus entering a background pane must claim it too, or its
    // composer never renders. Keep close equivalent to the pointer path.
    onFocusCapture={
      focused
        ? undefined
        : (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('.thread-pane-close')) return;
            onFocus();
          }
    }
    aria-label={thread.title}
  >
    {split && (
      <header className="thread-pane-header">
        {statusDot}
        <span className="thread-pane-title" title={thread.title}>
          {thread.title}
        </span>
        {project && (
          <span className="thread-pane-project" title={project.path}>
            <ProjectIcon projectPath={project.path} size={12} />
            <span className="truncate">{project.name}</span>
          </span>
        )}
        <ThemeSlot name="thread-header" />
        <button
          type="button"
          className="thread-pane-close"
          onClick={(event) => {
            // Closing must not first focus the pane being removed.
            event.stopPropagation();
            onClose();
          }}
          title="Close this pane — the thread stays in the sidebar"
          aria-label={`Close ${thread.title}`}
        >
          <X size={14} />
        </button>
      </header>
    )}
    <div className="panel-content">{children}</div>
  </section>
);
