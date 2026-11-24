import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, FileText, Folder } from 'lucide-react';
import { toast } from 'sonner';

// Simple recursive file tree component
export interface FileTreeItem {
  name: string;
  path: string;
  isDirectory: boolean;
  gitStatus?: GitStatusKind | null;
  gitStatusLabel?: string | null;
  hasChildGitStatus?: boolean;
}

export type GitStatusKind =
  | 'added'
  | 'copied'
  | 'conflicted'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked';

export const gitStatusTitles: Record<GitStatusKind, string> = {
  added: 'Added',
  copied: 'Copied',
  conflicted: 'Conflicted',
  deleted: 'Deleted',
  modified: 'Modified',
  renamed: 'Renamed',
  untracked: 'Untracked',
};
export const getFileIconMeta = (name: string, isDirectory: boolean) => {
  if (isDirectory) return { kind: 'folder', label: '' };

  const lowerName = name.toLowerCase();
  const ext = lowerName.split('.').pop() || '';

  if (lowerName === '.gitignore' || lowerName === '.gitattributes') {
    return { kind: 'git', label: 'G' };
  }
  if (lowerName === 'package.json' || lowerName === 'package-lock.json') {
    return { kind: 'node', label: 'JS' };
  }
  if (lowerName.includes('tailwind')) return { kind: 'tailwind', label: '~' };
  if (lowerName.includes('vite')) return { kind: 'vite', label: 'V' };
  if (lowerName.includes('postcss')) return { kind: 'config', label: '@' };

  const byExtension: Record<string, { kind: string; label: string }> = {
    css: { kind: 'css', label: '{}' },
    html: { kind: 'html', label: '<>' },
    js: { kind: 'javascript', label: 'JS' },
    json: { kind: 'json', label: '{}' },
    jsx: { kind: 'react', label: 'R' },
    md: { kind: 'markdown', label: 'M' },
    mjs: { kind: 'javascript', label: 'JS' },
    ts: { kind: 'typescript', label: 'TS' },
    tsx: { kind: 'react', label: 'R' },
    yml: { kind: 'yaml', label: 'Y' },
    yaml: { kind: 'yaml', label: 'Y' },
  };

  return byExtension[ext] ?? { kind: 'text', label: '' };
};

// window.prompt() is unsupported in Electron's renderer, so renames happen
// through this inline input instead. Submits on Enter/blur, cancels on Escape.
export const InlineRenameInput: React.FC<{
  initialValue: string;
  className?: string;
  maxLength?: number;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}> = ({ initialValue, className, maxLength, onSubmit, onCancel }) => {
  const [value, setValue] = useState(initialValue);
  const doneRef = useRef(false);

  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = value.trim();
    if (commit && trimmed && trimmed !== initialValue) onSubmit(trimmed);
    else onCancel();
  };

  return (
    <input
      type="text"
      className={className}
      value={value}
      maxLength={maxLength}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      }}
      onBlur={() => finish(true)}
    />
  );
};

export const FileTreeNode: React.FC<{
  item: FileTreeItem;
  depth?: number;
  onFileClick: (path: string) => void;
  activePath?: string | null;
  loadChildren: (path: string) => Promise<FileTreeItem[]>;
  rootPath?: string | null;
  refreshToken?: number;
  onRequestDelete: (item: FileTreeItem) => void;
  onRenamed: (oldPath: string, newPath: string, isDirectory: boolean) => void;
}> = ({
  item,
  depth = 0,
  onFileClick,
  activePath,
  loadChildren,
  rootPath,
  refreshToken = 0,
  onRequestDelete,
  onRenamed,
}) => {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FileTreeItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(item.name);
  const [creating, setCreating] = useState<'file' | 'folder' | null>(null);
  const [createValue, setCreateValue] = useState('');
  const iconMeta = getFileIconMeta(item.name, item.isDirectory);
  const gitStatusTitle = item.gitStatus ? gitStatusTitles[item.gitStatus] : null;

  // All child listings commit through here so only the newest read may set
  // children — an automatic refresh can overlap an expand, a focus refresh,
  // or a post-create re-list, and the older response resolving last would
  // resurrect deleted entries or stale badges (mirrors loadRoot's guard).
  const childrenSeqRef = useRef(0);
  const childrenReadPendingRef = useRef(false);
  const reloadChildren = useCallback(async () => {
    const seq = ++childrenSeqRef.current;
    childrenReadPendingRef.current = true;
    try {
      const kids = await loadChildren(item.path);
      if (childrenSeqRef.current === seq) setChildren(kids);
    } finally {
      if (childrenSeqRef.current === seq) childrenReadPendingRef.current = false;
    }
  }, [loadChildren, item.path]);

  // Re-fetch already-loaded children when the tree is refreshed after a
  // create/rename/delete elsewhere, without collapsing expanded folders. A
  // pending first read counts too: children is still null while an expand's
  // read is in flight, and skipping would let that pre-refresh listing land
  // unsuperseded.
  useEffect(() => {
    if (refreshToken > 0 && (children !== null || childrenReadPendingRef.current)) {
      reloadChildren();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = async () => {
    if (renaming) return;
    if (item.isDirectory) {
      if (!expanded && !children) {
        setLoading(true);
        await reloadChildren();
        setLoading(false);
      }
      setExpanded(!expanded);
    } else {
      onFileClick(item.path);
    }
  };

  const handleContextMenu = async (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!window.orion?.showFileTreeMenu) return;
    const action = await window.orion.showFileTreeMenu({
      path: item.path,
      isDirectory: item.isDirectory,
      rootPath,
    });
    if (action === 'rename') {
      setRenameValue(item.name);
      setRenaming(true);
    } else if (action === 'delete') {
      onRequestDelete(item);
    } else if (action === 'new-file' || action === 'new-folder') {
      setCreating(action === 'new-file' ? 'file' : 'folder');
      setCreateValue('');
      if (!expanded) {
        if (!children) {
          setLoading(true);
          await reloadChildren();
          setLoading(false);
        }
        setExpanded(true);
      }
    }
  };

  const submitRename = async () => {
    const newName = renameValue.trim();
    setRenaming(false);
    if (!newName || newName === item.name || /[/\\]/.test(newName)) return;
    const parentPrefix = item.path.slice(0, item.path.length - item.name.length);
    const newPath = parentPrefix + newName;
    const result = await window.orion.renamePath(item.path, newPath);
    if (!result?.ok) {
      toast.error(result?.error ?? 'Rename failed');
      return;
    }
    onRenamed(item.path, newPath, item.isDirectory);
  };

  const submitCreate = async () => {
    const kind = creating;
    const name = createValue.trim();
    setCreating(null);
    if (!kind || !name || /[/\\]/.test(name)) return;
    const newPath = await window.orion.join(item.path, name);
    const ok =
      kind === 'file'
        ? await window.orion.createFile(newPath)
        : await window.orion.createDirectory(newPath);
    if (!ok) {
      toast.error(`Could not create ${kind === 'file' ? 'file' : 'folder'}`);
      return;
    }
    await reloadChildren();
    if (kind === 'file') onFileClick(newPath);
  };

  return (
    <div>
      <div
        className={`file-item ${activePath === item.path ? 'active' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={item.path}
      >
        {item.isDirectory ? (
          <span className="file-disclosure">
            <ChevronRight
              size={14}
              className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
            />
          </span>
        ) : (
          <span className="file-disclosure" />
        )}
        <span className={`file-tree-icon ${item.isDirectory ? 'folder' : iconMeta.kind}`}>
          {item.isDirectory ? (
            <Folder size={15} />
          ) : iconMeta.label ? (
            <span>{iconMeta.label}</span>
          ) : (
            <FileText size={14} />
          )}
        </span>
        {renaming ? (
          <input
            className="file-rename-input"
            autoFocus
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onFocus={(e) => {
              const dotIndex = e.currentTarget.value.lastIndexOf('.');
              e.currentTarget.setSelectionRange(0, dotIndex > 0 ? dotIndex : e.currentTarget.value.length);
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitRename();
              else if (e.key === 'Escape') setRenaming(false);
            }}
            onBlur={() => setRenaming(false)}
          />
        ) : (
          <span className="file-name truncate">{item.name}</span>
        )}
        {item.gitStatus && (
          item.isDirectory ? (
            <span
              className={`git-status-dot ${item.gitStatus}`}
              title={`${gitStatusTitle} changes inside`}
            />
          ) : (
            <span
              className={`git-status-badge ${item.gitStatus}`}
              title={gitStatusTitle ?? undefined}
            >
              {item.gitStatusLabel}
            </span>
          )
        )}
      </div>

      {item.isDirectory && expanded && (
        <div className="file-children">
          {creating && (
            <div className="file-item" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
              <span className="file-disclosure" />
              <span className={`file-tree-icon ${creating === 'folder' ? 'folder' : 'text'}`}>
                {creating === 'folder' ? <Folder size={15} /> : <FileText size={14} />}
              </span>
              <input
                className="file-rename-input"
                autoFocus
                value={createValue}
                placeholder={creating === 'folder' ? 'Folder name' : 'File name'}
                onChange={(e) => setCreateValue(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitCreate();
                  else if (e.key === 'Escape') setCreating(null);
                }}
                onBlur={() => setCreating(null)}
              />
            </div>
          )}
          {loading && <div className="file-item" style={{ paddingLeft: 20 + depth * 12 }}>Loading...</div>}
          {children?.map((child) => (
            <FileTreeNode
              key={child.path}
              item={child}
              depth={depth + 1}
              onFileClick={onFileClick}
              activePath={activePath}
              loadChildren={loadChildren}
              rootPath={rootPath}
              refreshToken={refreshToken}
              onRequestDelete={onRequestDelete}
              onRenamed={onRenamed}
            />
          ))}
        </div>
      )}
    </div>
  );
};
