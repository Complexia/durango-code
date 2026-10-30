// Durango web origin. durango.sh serves everything the desktop talks to over
// HTTP: desktop sign-in, repositories, plans, sync, relay tickets, the Durango
// API (/api/v1) and the update/download feeds. Development defaults to the
// local Durango dev server (chat/local-stack.sh, :3000).
export const DEFAULT_PACKAGED_WEB_URL = 'https://durango.sh';
export const DEFAULT_DEV_WEB_URL = 'http://localhost:3000';
// Update feeds are per platform: <base>/macos, <base>/windows, <base>/linux.
export const DEFAULT_UPDATE_FEED_BASE_URL = 'https://durango.sh/api/update';

// Origins that served the same API (and the same Postgres-backed tokens)
// before it moved into durango.sh. Credentials saved under them are still
// valid, so they are reused rather than minted again.
const RETIRED_WEB_ORIGINS = Object.freeze({
  'https://code.durango.sh': DEFAULT_PACKAGED_WEB_URL,
  'https://orioncode.xyz': DEFAULT_PACKAGED_WEB_URL,
  'https://www.orioncode.xyz': DEFAULT_PACKAGED_WEB_URL,
});

/** Origin of `value`, with retired origins folded onto durango.sh. */
export const canonicalWebOrigin = (value) => {
  try {
    const origin = new URL(String(value ?? '')).origin;
    return RETIRED_WEB_ORIGINS[origin] ?? origin;
  } catch {
    return null;
  }
};

export const isSameWebOrigin = (left, right) => {
  const a = canonicalWebOrigin(left);
  return a !== null && a === canonicalWebOrigin(right);
};
