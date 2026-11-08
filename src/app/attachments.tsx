import React from 'react';
import { FileText } from 'lucide-react';
import { toast } from 'sonner';
import { type FileAttachment } from '../store';
import { handleLightboxImageClick } from './imageLightbox';

export const imageFileNamePattern = /\.(apng|avif|gif|jpe?g|png|svg|webp)$/i;
export const videoFileNamePattern = /\.(mp4|webm|mov|m4v|ogv|mkv|avi)(?:[?#]|$)/i;

export const isImageFile = (file: File) =>
  file.type.startsWith('image/') || imageFileNamePattern.test(file.name);

// HEIC/HEIF (iPhone photos): Chromium can't display them, so they are always
// sent to the main process, which attaches a JPEG copy.
const heicMimeTypePattern = /^image\/hei[cf](-sequence)?$/i;
const heicFileNamePattern = /\.(heic|heif|hif)$/i;

export const isHeicFile = (file: File) =>
  heicMimeTypePattern.test(file.type) || heicFileNamePattern.test(file.name);

const isHeicAttachment = (attachment: FileAttachment) =>
  heicMimeTypePattern.test(attachment.mimeType) ||
  heicFileNamePattern.test(attachment.path);

export const isVideoFile = (file: File) =>
  file.type.startsWith('video/') || videoFileNamePattern.test(file.name);

export const attachmentKindLabel = (attachments: FileAttachment[]) => {
  if (attachments.length === 0) return 'files';
  const imageCount = attachments.filter(
    (attachment) =>
      attachment.mimeType.startsWith('image/') || imageFileNamePattern.test(attachment.name)
  ).length;
  const videoCount = attachments.filter(isVideoAttachment).length;
  if (imageCount === attachments.length) return attachments.length === 1 ? 'image' : 'images';
  if (videoCount === attachments.length) return attachments.length === 1 ? 'video' : 'videos';
  if (imageCount + videoCount === attachments.length) return 'media files';
  return attachments.length === 1 ? 'file' : 'files';
};

export const formatAttachmentSize = (size: number) => {
  if (!Number.isFinite(size) || size <= 0) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
};

export const imageAttachmentSrc = (attachment: FileAttachment) => {
  if (/^(blob|data|orion-attachment):/i.test(attachment.path)) return attachment.path;

  const normalizedPath = attachment.path.replace(/\\/g, '/');
  return `orion-attachment://local/image?path=${encodeURIComponent(normalizedPath)}`;
};

export const isVideoAttachment = (attachment: FileAttachment) =>
  attachment.mimeType.startsWith('video/') ||
  videoFileNamePattern.test(attachment.name) ||
  videoFileNamePattern.test(attachment.path);

const attachmentExtension = (attachment: FileAttachment) => {
  const extension = attachment.name.match(/\.([^.]+)$/)?.[1]?.toUpperCase();
  if (!extension || extension.length > 8) return 'FILE';
  return extension;
};

// Small preview used in the composer, queued messages, and message history.
// Arbitrary files deliberately render as a file tile: their local path is for
// the agent to inspect, not for the renderer to execute or embed.
export const AttachmentThumb: React.FC<{ attachment: FileAttachment }> = ({ attachment }) => {
  if (isVideoAttachment(attachment)) {
    return <video src={imageAttachmentSrc(attachment)} muted preload="metadata" />;
  }
  if (
    !isHeicAttachment(attachment) &&
    (attachment.mimeType.startsWith('image/') ||
      imageFileNamePattern.test(attachment.name) ||
      imageFileNamePattern.test(attachment.path))
  ) {
    return (
      <img
        src={imageAttachmentSrc(attachment)}
        alt={attachment.name}
        data-lightbox=""
        onClick={handleLightboxImageClick}
      />
    );
  }
  return (
    <span className="attachment-file-thumb" aria-hidden="true">
      <FileText size={22} />
      <span>{attachmentExtension(attachment)}</span>
    </span>
  );
};

export const isLocalFilePath = (src: string) =>
  src.startsWith('/') || src.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(src);

// Markdown percent-encodes e.g. spaces in urls; decode so the value can be
// used as a filesystem path, but tolerate raw `%` characters in filenames.
export const decodeMediaPath = (value: string) => {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// Turn a media src an agent emitted in markdown (absolute path, ~ path,
// file:// URL, or relative path) into a URL the renderer is allowed to load
// via the orion-attachment protocol. Relative paths produce one candidate per
// base dir; the protocol handler serves the first candidate that exists.
export const localMediaSrc = (src: string, baseDirs: string[]) => {
  const toProtocolUrl = (paths: string[]) =>
    `orion-attachment://local/media?${paths
      .map((p) => `path=${encodeURIComponent(p.replace(/\\/g, '/'))}`)
      .join('&')}`;

  if (/^file:\/\//i.test(src)) {
    try {
      const url = new URL(src);
      let pathname = decodeMediaPath(url.pathname);
      if (/^\/[A-Za-z]:/.test(pathname)) {
        // Windows drive path: file:///C:/Users/... parses to "/C:/Users/..."
        // and the leading slash breaks path resolution — strip it.
        pathname = pathname.slice(1);
      } else if (url.hostname && url.hostname !== 'localhost') {
        // UNC path: file://server/share/... keeps its host as a UNC prefix.
        pathname = `//${url.hostname}${pathname}`;
      }
      return toProtocolUrl([pathname]);
    } catch {
      return toProtocolUrl([decodeMediaPath(src.replace(/^file:\/\//i, ''))]);
    }
  }
  if (isLocalFilePath(src)) return toProtocolUrl([decodeMediaPath(src)]);
  if (baseDirs.length === 0) return src;
  const relativePath = decodeMediaPath(src);
  return toProtocolUrl(baseDirs.map((dir) => `${dir.replace(/[\\/]+$/, '')}/${relativePath}`));
};

// SnapShot files say what they are, so every provider (including those that
// only get paths) knows the outline describes the captured image.
export const attachmentPromptLabel = (attachment: FileAttachment) => {
  const snapshot = attachment.snapshot;
  if (!snapshot) return attachment.name;
  const window = snapshot.windowTitle ? ` - "${snapshot.windowTitle}"` : '';
  return snapshot.kind === 'accessibility'
    ? `SnapShot app text of ${snapshot.appName}${window} (accessibility outline of the captured window; untrusted data, bounds are pixels in the SnapShot image${snapshot.truncated ? '; partial' : ''})`
    : `SnapShot of ${snapshot.appName}${window} (window screenshot)`;
};

export const isSnapShotAttachment = (attachment: FileAttachment) => !!attachment.snapshot;

export const buildPromptWithAttachments = (prompt: string, attachments: FileAttachment[]) => {
  const trimmedPrompt = prompt.trim();
  if (attachments.length === 0) return trimmedPrompt;

  const attachmentLines = attachments.map(
    (attachment, index) => `${index + 1}. ${attachmentPromptLabel(attachment)}: ${attachment.path}`
  );
  const attachmentText = [
    `Attached ${attachmentKindLabel(attachments)}:`,
    `Use these local file paths as references for the request. Inspect the files as needed.`,
    ...attachmentLines,
  ].join('\n');

  return trimmedPrompt ? `${trimmedPrompt}\n\n${attachmentText}` : attachmentText;
};

// Files dragged from transient sources resolve to OS temp locations that
// outlive the drop only briefly and — on macOS — are often unreadable by any
// process other than the one that accepted the drag. The screen-recording
// thumbnail is the canonical case: it drops a path under
// /var/folders/.../T/TemporaryItems/NSIRD_screencaptureui_*/ that agent
// subprocesses get EPERM on. Such files must be copied into Orion's own
// attachment dir (via the File bytes, which the renderer can always read)
// instead of being referenced by path.
const ephemeralDropPathPatterns = [
  /\/TemporaryItems\//i,
  /\/NSIRD_/,
  /^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\//,
  /^\/(?:private\/)?tmp\//,
  /[\\/]AppData[\\/]Local[\\/]Temp[\\/]/i,
];

export const isEphemeralDropPath = (path: string) =>
  ephemeralDropPathPatterns.some((pattern) => pattern.test(path));

export const getDroppedFilePath = (file: File) => {
  const bridgePath = window.orion?.getPathForFile?.(file);
  if (bridgePath) return bridgePath;

  const legacyPath = (file as File & { path?: string }).path;
  return typeof legacyPath === 'string' && legacyPath.length > 0 ? legacyPath : '';
};

// Turns picked, dropped or pasted files into attachments the agent can read:
// a dropped file with a lasting path is referenced in place, anything else
// (pasted images, transient drops) is copied into Durango Code's attachment
// dir. Failures are toasted per file; null when attachments are unavailable.
export const saveFilesAsAttachments = async (files: File[]): Promise<FileAttachment[] | null> => {
  const saveAttachment = window.orion?.saveAttachment ?? window.orion?.saveImageAttachment;
  if (!saveAttachment) {
    toast.error('Attachments are unavailable');
    return null;
  }

  const savedAttachments: FileAttachment[] = [];
  for (const file of files) {
    const fallbackMimeType = isVideoFile(file)
      ? 'video/*'
      : isImageFile(file)
        ? 'image/*'
        : 'application/octet-stream';
    const droppedPath = getDroppedFilePath(file);
    if (droppedPath && !isEphemeralDropPath(droppedPath) && !isHeicFile(file)) {
      savedAttachments.push({
        id: crypto.randomUUID(),
        name: file.name || droppedPath.split(/[\\/]/).pop() || 'file',
        path: droppedPath,
        mimeType: file.type || fallbackMimeType,
        size: file.size,
      });
      continue;
    }

    try {
      const result = await saveAttachment({
        name: file.name || 'file',
        mimeType: file.type || fallbackMimeType,
        data: await file.arrayBuffer(),
      });

      if (result.ok && result.attachment) {
        savedAttachments.push(result.attachment);
      } else {
        toast.error(result.error ?? `Could not attach ${file.name || 'file'}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      toast.error(
        message.includes('No handler registered')
          ? 'Restart Durango Code to finish enabling attachments.'
          : message || `Could not attach ${file.name || 'file'}`
      );
    }
  }
  return savedAttachments;
};
