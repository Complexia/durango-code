import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Code2, Eye, FileText } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { toast } from 'sonner';
import { useOrionStore } from '../store';
import { codeFilePreviewSrc, isPdfFilePath, isPreviewFilePath, isVideoFilePath } from './codeFiles';
import { getLanguageFromPath } from './language';
import { MarkdownBaseDirContext, MarkdownContent } from './markdown';

// Keep both @monaco-editor/react and Monaco itself out of the startup graph.
// MonacoEditor configures the bundled Electron-safe loader when the Code
// editor is first rendered.
export const MonacoEditor = React.lazy(() => import('../MonacoEditor'));

export type CodeEditorPaneHandle = {
  flushBuffers: () => void;
};

const VideoPreview = ({ src, name }: { src: string; name: string }) => {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-4 overflow-auto bg-black/20 p-6" role="region" aria-label="Video preview">
      {failed ? (
        <div className="max-w-md text-center text-sm text-[#aaa]" role="alert">
          This video could not be played. Its format or codec may not be supported by Durango Code, or the file may be unavailable.
        </div>
      ) : (
        <video
          className="min-h-0 max-h-full w-full rounded-lg bg-black object-contain"
          src={src}
          aria-label={name}
          controls
          playsInline
          preload="metadata"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
};

/**
 * Keeps Monaco's per-keystroke updates inside the code pane. The shell only
 * observes tab metadata (path/dirty state), so editing no longer re-renders
 * the sidebar, transcript, settings, or composer.
 */
const CodeEditorPaneWithRef = React.forwardRef<CodeEditorPaneHandle>(function CodeEditorPane(_props, ref) {
  const { activeFilePath, activeFile, closeFile, updateOpenFileContent, markFileSaved } =
    useOrionStore(
      useShallow((state) => ({
        activeFilePath: state.activeFilePath,
        activeFile: state.openFiles.find((file) => file.path === state.activeFilePath),
        closeFile: state.closeFile,
        updateOpenFileContent: state.updateOpenFileContent,
        markFileSaved: state.markFileSaved,
      }))
    );
  const openFilePaths = useOrionStore(
    useShallow((state) => state.openFiles.map((file) => file.path))
  );
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const buffersRef = useRef(new Map<string, string>());
  const dirtyPathsRef = useRef(new Set<string>());
  const savedContentsRef = useRef(new Map<string, string>());
  const previousActiveFilePathRef = useRef(activeFilePath);
  const [editorBottomPadding, setEditorBottomPadding] = useState(280);
  const [markdownViews, setMarkdownViews] = useState<Record<string, 'code' | 'preview'>>({});

  if (activeFilePath && activeFile && !buffersRef.current.has(activeFilePath)) {
    buffersRef.current.set(activeFilePath, activeFile.content);
    if (activeFile.isDirty) {
      dirtyPathsRef.current.add(activeFilePath);
    } else {
      savedContentsRef.current.set(activeFilePath, activeFile.content);
    }
  } else if (
    activeFilePath &&
    activeFile &&
    !activeFile.isDirty &&
    !dirtyPathsRef.current.has(activeFilePath) &&
    savedContentsRef.current.get(activeFilePath) !== activeFile.content
  ) {
    // A clean tab changed on disk. Replace Monaco's cached value so the
    // already-open editor updates without requiring the tab to be reopened.
    buffersRef.current.set(activeFilePath, activeFile.content);
    savedContentsRef.current.set(activeFilePath, activeFile.content);
  }

  const flushFileBuffer = useCallback(
    (path: string) => {
      if (!dirtyPathsRef.current.has(path)) return;
      const content = buffersRef.current.get(path);
      if (content === undefined) return;
      const sharedFile = useOrionStore.getState().openFiles.find((file) => file.path === path);
      if (!sharedFile || (sharedFile.isDirty && sharedFile.content === content)) return;
      updateOpenFileContent(path, content);
    },
    [updateOpenFileContent]
  );

  React.useImperativeHandle(
    ref,
    () => ({
      flushBuffers: () => {
        for (const path of dirtyPathsRef.current) flushFileBuffer(path);
      },
    }),
    [flushFileBuffer]
  );

  useEffect(() => {
    const editorContainer = editorContainerRef.current;
    if (!editorContainer) return undefined;

    const updatePadding = () => {
      const nextPadding = Math.round(editorContainer.clientHeight * 0.5);
      if (nextPadding > 0) setEditorBottomPadding(nextPadding);
    };

    updatePadding();
    const resizeObserver = new ResizeObserver(updatePadding);
    resizeObserver.observe(editorContainer);
    return () => resizeObserver.disconnect();
  }, []);

  // Monaco owns the live model while a tab is active. Commit its final buffer
  // to shared state only when the active editor tab changes.
  useLayoutEffect(() => {
    const previousPath = previousActiveFilePathRef.current;
    if (previousPath && previousPath !== activeFilePath) {
      flushFileBuffer(previousPath);
    }
    previousActiveFilePathRef.current = activeFilePath;
  }, [activeFilePath, flushFileBuffer]);

  // Leaving Code unmounts this pane, so flush dirty buffers once before the
  // localized cache disappears. This preserves every unsaved editor tab.
  useEffect(
    () => () => {
      for (const path of dirtyPathsRef.current) flushFileBuffer(path);
    },
    [flushFileBuffer]
  );

  // Closed tabs must not leave a stale unsaved buffer that could be revived if
  // the same path is opened again later in this Code session.
  useEffect(() => {
    const openPaths = new Set(openFilePaths);
    for (const path of buffersRef.current.keys()) {
      if (openPaths.has(path)) continue;
      buffersRef.current.delete(path);
      dirtyPathsRef.current.delete(path);
      savedContentsRef.current.delete(path);
    }
  }, [openFilePaths]);

  const saveActiveFile = useCallback(async () => {
    const path = useOrionStore.getState().activeFilePath;
    if (!path || isPreviewFilePath(path) || !window.orion) return;
    const currentFile = useOrionStore.getState().openFiles.find((file) => file.path === path);
    const content = buffersRef.current.get(path) ?? currentFile?.content;
    if (content === undefined) return;

    const success = await window.orion.writeFile(path, content);
    if (success) {
      savedContentsRef.current.set(path, content);
      const latestContent = buffersRef.current.get(path) ?? content;
      if (latestContent === content) {
        dirtyPathsRef.current.delete(path);
        markFileSaved(path, content);
      } else {
        // Edits made while the write was in flight remain dirty against the
        // content that actually reached disk.
        dirtyPathsRef.current.add(path);
        updateOpenFileContent(path, latestContent);
      }
    } else {
      toast.error('Failed to save file');
    }
  }, [markFileSaved, updateOpenFileContent]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (value === undefined || !activeFilePath) return;
      buffersRef.current.set(activeFilePath, value);

      const wasDirty = dirtyPathsRef.current.has(activeFilePath);
      const hasSavedContent = savedContentsRef.current.has(activeFilePath);
      const isDirty =
        !hasSavedContent || value !== savedContentsRef.current.get(activeFilePath);
      if (isDirty === wasDirty) return;

      if (isDirty) {
        dirtyPathsRef.current.add(activeFilePath);
        updateOpenFileContent(activeFilePath, value);
      } else {
        dirtyPathsRef.current.delete(activeFilePath);
        markFileSaved(activeFilePath, value);
      }
    },
    [activeFilePath, markFileSaved, updateOpenFileContent]
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        if (activeFilePath) void saveActiveFile();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w' && activeFilePath) {
        event.preventDefault();
        closeFile(activeFilePath);
      }
    };
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, [activeFilePath, closeFile, saveActiveFile]);

  const currentLanguage = activeFilePath ? getLanguageFromPath(activeFilePath) : 'plaintext';
  const isMarkdownFile = Boolean(activeFilePath?.toLowerCase().endsWith('.md'));
  const isPdfFile = isPdfFilePath(activeFilePath);
  const isVideoFile = isVideoFilePath(activeFilePath);
  const markdownView = activeFilePath ? (markdownViews[activeFilePath] ?? 'code') : 'code';
  const activeBuffer =
    activeFilePath && activeFile
      ? (buffersRef.current.get(activeFilePath) ?? activeFile.content)
      : undefined;
  const markdownBaseDirs = React.useMemo(() => {
    if (!activeFilePath) return [];
    const lastSeparator = Math.max(activeFilePath.lastIndexOf('/'), activeFilePath.lastIndexOf('\\'));
    return lastSeparator > 0 ? [activeFilePath.slice(0, lastSeparator)] : [];
  }, [activeFilePath]);
  const previewSrc = activeFilePath && (isPdfFile || isVideoFile)
    ? codeFilePreviewSrc(activeFilePath, activeFile?.diskRevision ?? 0)
    : '';

  const setMarkdownView = useCallback(
    (view: 'code' | 'preview') => {
      if (!activeFilePath) return;
      setMarkdownViews((current) =>
        current[activeFilePath] === view ? current : { ...current, [activeFilePath]: view }
      );
    },
    [activeFilePath]
  );

  return (
    <div className="editor-container" ref={editorContainerRef}>
      {activeFilePath && activeFile ? (
        <>
          {isVideoFile ? (
            <VideoPreview
              key={previewSrc}
              src={previewSrc}
              name={activeFilePath.split(/[\\/]/).pop() ?? 'Video preview'}
            />
          ) : isPdfFile ? (
            <div className="pdf-preview" role="document" aria-label="PDF preview">
              <iframe
                key={`${activeFilePath}:${activeFile.diskRevision ?? 0}`}
                src={previewSrc}
                title={activeFilePath.split(/[\\/]/).pop() ?? 'PDF preview'}
              />
            </div>
          ) : isMarkdownFile && markdownView === 'preview' ? (
            <div className="markdown-preview" role="tabpanel" aria-label="Markdown preview">
              <MarkdownBaseDirContext.Provider value={markdownBaseDirs}>
                <MarkdownContent content={activeBuffer ?? ''} />
              </MarkdownBaseDirContext.Provider>
            </div>
          ) : (
            <React.Suspense fallback={<div className="editor-loading" />}>
              <MonacoEditor
                height="100%"
                language={currentLanguage}
                value={activeBuffer}
                onChange={handleEditorChange}
                theme="vs-dark"
                options={{
                  fontSize: 13,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  padding: { bottom: editorBottomPadding },
                  automaticLayout: true,
                  tabSize: 2,
                  wordWrap: 'on',
                }}
              />
            </React.Suspense>
          )}

          {isMarkdownFile && (
            <div className="markdown-view-toggle" role="tablist" aria-label="Markdown view">
              <button
                type="button"
                role="tab"
                aria-selected={markdownView === 'preview'}
                aria-label="Preview Markdown"
                title="Preview Markdown"
                className={markdownView === 'preview' ? 'active' : ''}
                onClick={() => setMarkdownView('preview')}
              >
                <Eye size={15} aria-hidden="true" />
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={markdownView === 'code'}
                aria-label="Show Markdown source"
                title="Show Markdown source"
                className={markdownView === 'code' ? 'active' : ''}
                onClick={() => setMarkdownView('code')}
              >
                <Code2 size={15} aria-hidden="true" />
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="empty-state">
          <FileText size={42} className="opacity-30" />
          <div>Open a file from the explorer</div>
          <div className="text-xs mt-1 text-[#555]">VSCode-powered editor (Monaco)</div>
        </div>
      )}
    </div>
  );
});

export const CodeEditorPane = React.memo(CodeEditorPaneWithRef);
