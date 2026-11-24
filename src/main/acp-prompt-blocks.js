import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getMimeTypeForMediaPath } from './media.js';
import { snapShotOutlinePromptText } from './snapshot-format.js';

export const ACP_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const ACP_MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const ACP_MAX_TEXT_BYTES = 128 * 1024;
export const ACP_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const NATIVE_IMAGE_MIME_TYPES = new Set([
  'image/bmp',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

const NATIVE_AUDIO_MIME_TYPES = new Set([
  'audio/aac',
  'audio/flac',
  'audio/mp3',
  'audio/mpeg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
]);

const NATIVE_TEXT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/jsonlines',
  'application/x-ndjson',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/xml',
  'application/xhtml+xml',
  'application/javascript',
  'application/x-javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-typescript',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
  'application/graphql',
]);

const EXTRA_MIME_TYPE_BY_EXTENSION = {
  '.bmp': 'image/bmp',
  '.pdf': 'application/pdf',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.env': 'text/plain',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.md': 'text/markdown',
  '.mdx': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.less': 'text/x-less',
  '.xml': 'application/xml',
  '.json': 'application/json',
  '.jsonl': 'application/json',
  '.ndjson': 'application/json',
  '.jsonc': 'application/json',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.toml': 'application/toml',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.py': 'text/x-python',
  '.pyi': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java-source',
  '.kt': 'text/x-kotlin',
  '.kts': 'text/x-kotlin',
  '.swift': 'text/x-swift',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cc': 'text/x-c++',
  '.cpp': 'text/x-c++',
  '.cxx': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.rb': 'text/x-ruby',
  '.php': 'text/x-php',
  '.sh': 'application/x-sh',
  '.bash': 'application/x-sh',
  '.zsh': 'application/x-sh',
  '.fish': 'text/x-fish',
  '.sql': 'application/sql',
  '.graphql': 'application/graphql',
  '.gql': 'application/graphql',
  '.proto': 'text/plain',
  '.diff': 'text/x-diff',
  '.patch': 'text/x-diff',
  '.vue': 'text/plain',
  '.svelte': 'text/plain',
  '.astro': 'text/plain',
  '.lua': 'text/x-lua',
  '.r': 'text/x-r',
  '.scala': 'text/x-scala',
  '.zig': 'text/plain',
  '.ex': 'text/x-elixir',
  '.exs': 'text/x-elixir',
  '.erl': 'text/x-erlang',
  '.hs': 'text/x-haskell',
  '.ml': 'text/x-ocaml',
  '.tf': 'text/plain',
  '.hcl': 'text/plain',
  '.nix': 'text/plain',
  '.prisma': 'text/plain',
};

const KNOWN_TEXT_EXTENSIONS = new Set(
  Object.entries(EXTRA_MIME_TYPE_BY_EXTENSION)
    .filter(([, mime]) => mime.startsWith('text/') || NATIVE_TEXT_MIME_TYPES.has(mime))
    .map(([ext]) => ext)
);

export const normalizeMimeType = (value) => {
  if (typeof value !== 'string') return '';
  return value.split(';', 1)[0].trim().toLowerCase();
};

const isGenericMimeType = (mimeType) =>
  !mimeType || mimeType === 'application/octet-stream' || mimeType.endsWith('/*');

export const resolveAttachmentMimeType = (attachment, filePath) => {
  const declared = normalizeMimeType(attachment?.mimeType);
  if (!isGenericMimeType(declared)) return declared;

  const targetPath =
    typeof filePath === 'string' && filePath
      ? filePath
      : typeof attachment?.path === 'string' && attachment.path
        ? attachment.path
        : typeof attachment?.name === 'string'
          ? attachment.name
          : '';
  if (!targetPath) return declared;

  const ext = path.extname(targetPath).toLowerCase();
  if (declared === 'audio/*' && ext === '.webm') return 'audio/webm';

  const fromMedia = getMimeTypeForMediaPath(targetPath);
  if (fromMedia && fromMedia !== 'application/octet-stream') return fromMedia;

  return EXTRA_MIME_TYPE_BY_EXTENSION[ext] || declared;
};

const isTextAttachment = (mimeType, filePath) => {
  if (mimeType.startsWith('text/')) return true;
  if (NATIVE_TEXT_MIME_TYPES.has(mimeType)) return true;
  if (mimeType.endsWith('+json') || mimeType.endsWith('+xml')) return true;
  return KNOWN_TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
};

const decodeTextBuffer = (data) => {
  let encoding = 'utf-8';
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    encoding = 'utf-16le';
  } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    encoding = 'utf-16be';
  }
  let decoded;
  try {
    decoded = new TextDecoder(encoding, { fatal: true }).decode(data);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  return decoded;
};

export const buildAcpPromptBlocks = async (
  promptText,
  attachments = [],
  promptCapabilities = { image: true }
) => {
  const caps =
    promptCapabilities && typeof promptCapabilities === 'object'
      ? promptCapabilities
      : { image: true };
  const text = typeof promptText === 'string' ? promptText : '';
  const blocks = [];
  if (text.length > 0) blocks.push({ type: 'text', text });

  const seen = new Set();
  let totalBytes = 0;

  for (const attachment of Array.isArray(attachments) ? attachments : []) {
    const rawPath = typeof attachment?.path === 'string' ? attachment.path.trim() : '';
    if (!rawPath) continue;
    const filePath = path.resolve(rawPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);

    // SnapShot accessibility outlines go inline as framed, untrusted text;
    // the local path stays in the prompt for full inspection.
    if (attachment?.snapshot?.kind === 'accessibility') {
      const outline = await fs.readFile(filePath, 'utf8').catch(() => null);
      if (outline !== null) {
        blocks.push({ type: 'text', text: snapShotOutlinePromptText(attachment, outline) });
      }
      continue;
    }

    // Folded pasted text stays path-only (already referenced in promptText).
    if (attachment?.source?._tag === 'pasted-text' || attachment?.pastedText === true) {
      continue;
    }

    const mimeType = resolveAttachmentMimeType(attachment, filePath);

    if (NATIVE_IMAGE_MIME_TYPES.has(mimeType)) {
      if (caps.image === false) continue;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > ACP_MAX_IMAGE_BYTES || totalBytes + stat.size > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        const data = await fs.readFile(filePath);
        if (data.length > ACP_MAX_IMAGE_BYTES || totalBytes + data.length > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        totalBytes += data.length;
        blocks.push({ type: 'image', data: data.toString('base64'), mimeType });
      } catch {
        // Keep the local path in the prompt so the agent can still inspect it.
      }
      continue;
    }

    if (NATIVE_AUDIO_MIME_TYPES.has(mimeType)) {
      if (caps.audio !== true) continue;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > ACP_MAX_AUDIO_BYTES || totalBytes + stat.size > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        const data = await fs.readFile(filePath);
        if (data.length > ACP_MAX_AUDIO_BYTES || totalBytes + data.length > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        totalBytes += data.length;
        blocks.push({ type: 'audio', data: data.toString('base64'), mimeType });
      } catch {
        // Keep the local path in the prompt so the agent can still inspect it.
      }
      continue;
    }

    if (mimeType === 'application/pdf') {
      if (caps.embeddedContext !== true) continue;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > ACP_MAX_TOTAL_BYTES || totalBytes + stat.size > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        totalBytes += stat.size;
        blocks.push({
          type: 'resource_link',
          uri: pathToFileURL(filePath).href,
          name:
            typeof attachment?.name === 'string' && attachment.name.trim()
              ? attachment.name
              : path.basename(filePath),
          mimeType: 'application/pdf',
          size: stat.size,
        });
      } catch {
        // Keep the local path in the prompt so the agent can still inspect it.
      }
      continue;
    }

    if (isTextAttachment(mimeType, filePath)) {
      if (caps.embeddedContext !== true) continue;
      try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile() || stat.size > ACP_MAX_TEXT_BYTES || totalBytes + stat.size > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        const data = await fs.readFile(filePath);
        if (data.length > ACP_MAX_TEXT_BYTES || totalBytes + data.length > ACP_MAX_TOTAL_BYTES) {
          continue;
        }
        const decoded = decodeTextBuffer(data);
        if (decoded === null) continue;
        totalBytes += data.length;
        blocks.push({
          type: 'resource',
          resource: {
            uri: pathToFileURL(filePath).href,
            mimeType: mimeType && !mimeType.endsWith('/*') ? mimeType : 'text/plain',
            text: decoded,
          },
        });
      } catch {
        // Keep the local path in the prompt so the agent can still inspect it.
      }
    }
  }

  if (blocks.length === 0) blocks.push({ type: 'text', text });
  return blocks;
};
