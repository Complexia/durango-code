import React from 'react';
import { ChevronRight, Columns2, X } from 'lucide-react';
import type { SavedView } from '../store';

// Dragging a sidebar thread onto the main view opens it as an extra pane. The
// payload rides on a private MIME type so the shell's file-drop handling —
// which only looks for 'Files' — stays out of the way, and so a thread dropped
// on anything else (the composer, another app) is simply ignored.
export const THREAD_DRAG_MIME = 'application/x-orion-thread';

export type SavedViewsSectionProps = {
  setActiveTab: (tab: 'agents' | 'code') => void;
  savedViews: SavedView[];
  activeSavedViewId: string | null;
  /** Saved views hold ids only, so the section reads its pane titles from here. */
  threadTitlesById: Map<string, string>;
  openSavedView: (id: string) => void;
  deleteSavedView: (id: string) => void;
  savedViewsSectionOpen: boolean;
  setSavedViewsSectionOpen: React.Dispatch<React.SetStateAction<boolean>>;
};

/** The Saved views section at the top of the Threads tab's list. */
export const SavedViewsSection = ({
  setActiveTab,
  savedViews,
  activeSavedViewId,
  threadTitlesById,
  openSavedView,
  deleteSavedView,
  savedViewsSectionOpen,
  setSavedViewsSectionOpen,
}: SavedViewsSectionProps) => (
  <>
    {/*
      Saved views only exist while there are splits to return to — an empty
      section would be a permanent reminder of a feature the user isn't
      using, so it isn't rendered at all.
    */}
    {savedViews.length > 0 && (
      <div className="recent-agents-section saved-views-section">
        <button
          type="button"
          className="sidebar-section-toggle"
          onClick={() => setSavedViewsSectionOpen((open) => !open)}
          aria-expanded={savedViewsSectionOpen}
        >
          <ChevronRight
            size={12}
            className={`sidebar-section-chevron ${savedViewsSectionOpen ? 'open' : ''}`}
          />
          <span>Saved views</span>
        </button>
        {savedViewsSectionOpen && (
          <div className="threads-list saved-views-list">
            {savedViews.map((view) => {
              const paneTitles = view.threadIds.map(
                (threadId) => threadTitlesById.get(threadId) ?? 'Untitled'
              );
              return (
                <div
                  key={view.id}
                  className={`thread-item saved-view-item${
                    activeSavedViewId === view.id ? ' selected' : ''
                  }`}
                >
                  <button
                    type="button"
                    className="thread-item-select"
                    onClick={() => {
                      openSavedView(view.id);
                      setActiveTab('agents');
                    }}
                    title={paneTitles.join('\n')}
                  >
                    <Columns2 size={13} className="saved-view-icon" />
                    <span className="thread-title">
                      <span className="thread-title-text">{view.name}</span>
                    </span>
                    {/* thread-meta: fades out on hover so the delete
                        button has the row's right edge to itself. */}
                    <span className="sidebar-section-count thread-meta">
                      {view.threadIds.length}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="saved-view-remove"
                    title="Delete this saved view — its threads stay"
                    aria-label={`Delete saved view ${view.name}`}
                    onClick={() => deleteSavedView(view.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    )}
  </>
);
