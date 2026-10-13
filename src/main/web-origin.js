// Durango Code web origins. code.durango.sh is canonical after the rebrand;
// orioncode.xyz is the same orion-next service and keeps serving its APIs
// indefinitely (contracts.md §2), so credentials minted against it stay valid.
export const DEFAULT_PACKAGED_WEB_URL = 'https://code.durango.sh';
export const DEFAULT_DEV_WEB_URL = 'http://localhost:3000';
export const DEFAULT_UPDATE_FEED_URL = 'https://code.durango.sh/api/update/macos';

const LEGACY_WEB_ORIGIN_ALIASES = Object.freeze({
  'https://orioncode.xyz': 'https://code.durango.sh',
  'https://www.orioncode.xyz': 'https://code.durango.sh',
});

/** Origin of `value` with legacy aliases folded onto the canonical origin. */
export const canonicalWebOrigin = (value) => {
  try {
    const origin = new URL(String(value ?? '')).origin;
    return LEGACY_WEB_ORIGIN_ALIASES[origin] ?? origin;
  } catch {
    return null;
  }
};

export const isSameWebOrigin = (left, right) => {
  const a = canonicalWebOrigin(left);
  return a !== null && a === canonicalWebOrigin(right);
};
