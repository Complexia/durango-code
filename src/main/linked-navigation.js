import path from 'node:path';

const decodePath = (value) => {
  if (!/%[0-9a-f]{2}/i.test(value)) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const stripSourceLocation = (value) => {
  const withoutEditorFragment = value.replace(
    /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i,
    ''
  );
  return withoutEditorFragment.replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, '');
};

const bareSourceLocationPattern = /^(?!(?:javascript|data|vbscript|https?|mailto|tel):)(?:[^:/?#]+[\\/])*[^:/?#]+:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/i;

const fileReferencePath = (reference) => {
  const value = String(reference ?? '').trim();
  if (!value || value.startsWith('#')) return null;

  if (/^file:/i.test(value)) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'file:') return null;
      let pathname = decodePath(url.pathname);
      if (/^\/[A-Za-z]:/.test(pathname)) pathname = pathname.slice(1);
      if (url.hostname && url.hostname !== 'localhost') {
        pathname = `//${url.hostname}${pathname}`;
      }
      return pathname;
    } catch {
      return decodePath(value.replace(/^file:\/\/*/i, '/'));
    }
  }

  // A bare filename plus line/column suffix resembles an unknown URI scheme
  // to URL parsers (for example, app.ts:42 or Makefile:42), but is a local
  // source target. Known browser schemes remain excluded.
  if (bareSourceLocationPattern.test(value)) return decodePath(value);

  // A drive letter is a path, while every other URI scheme belongs outside
  // the Code tab (http(s) is handled by the caller).
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
    return null;
  }
  return decodePath(value);
};

const expandHome = (value, homeDir) =>
  /^~[\\/]/.test(value) ? path.join(homeDir, value.slice(2)) : value;

/**
 * Resolve a Markdown file target without trusting the renderer's URL parser.
 * Both the literal name and its common :line[:column]/#Lline form are tried,
 * so a real filename ending in digits remains openable.
 */
export const linkedFileCandidates = (reference, baseDirs = [], homeDir = '') => {
  const referencedPath = fileReferencePath(reference);
  if (!referencedPath) return [];

  const fragmentlessPath = referencedPath.replace(/#.*$/, '');
  const variants = [...new Set([
    referencedPath,
    stripSourceLocation(referencedPath),
    fragmentlessPath,
    stripSourceLocation(fragmentlessPath),
  ])];
  const expandedVariants = variants.map((variant) => expandHome(variant, homeDir));
  const candidates = [];
  if (expandedVariants.every((variant) => path.isAbsolute(variant) || /^[a-z]:[\\/]/i.test(variant))) {
    for (const variant of expandedVariants) candidates.push(path.normalize(variant));
  } else {
    // Base directories are ordered by likelihood (the active project first),
    // so exhaust both literal/source-location variants within one base before
    // falling through to the next.
    for (const baseDir of baseDirs) {
      if (typeof baseDir !== 'string' || !baseDir.trim()) continue;
      const expandedBaseDir = expandHome(baseDir, homeDir);
      for (const variant of expandedVariants) {
        candidates.push(path.resolve(expandedBaseDir, variant));
      }
    }
  }
  return [...new Set(candidates)];
};

export const externalWebUrl = (value) => {
  if (typeof value !== 'string' && !(value instanceof URL)) return null;
  const rawString = value instanceof URL ? value.toString() : value;
  if (/[\u0000-\u001f\u007f]/.test(rawString)) return null;
  const raw = rawString.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname) return null;
    return parsed.toString();
  } catch {
    return null;
  }
};

export const openExternalWebUrl = async (value, openExternal) => {
  const safeUrl = externalWebUrl(value);
  if (!safeUrl) {
    throw new Error('Only http and https URLs can be opened externally.');
  }
  await openExternal(safeUrl);
  return safeUrl;
};
