// Durango Source change-description images (`durango-code change attach`)
// live behind durango.sh at /api/source/repos/<owner>/<repo>/attachments/<id>,
// usually written root-relative and readable only by people who can read the
// repository. Agents paste that Markdown into replies too. The renderer can't
// load it (a relative path resolves against the app, and it has no durango.sh
// session), so such images go through the main process
// (src/main/source-attachments.js), which fetches them with the device's
// repository token.
//
// The URL names the signed-in account, and main refuses it for any other, so
// an account change gives every image a new URL: nothing Chromium cached for
// the previous account is reused.

import { useSyncExternalStore } from 'react';

export const SOURCE_ATTACHMENT_PROTOCOL = 'orion-source-attachment';

const ATTACHMENT_PATH = /^\/api\/source\/repos\/([^/?#]+)\/([^/?#]+)\/attachments\/(att_[A-Za-z0-9]+)$/;
// The origins that serve Durango Source attachments. A root-relative path
// means "durango.sh" too: that's where the CLI's Markdown points.
const DURANGO_HOSTS = new Set(['durango.sh', 'www.durango.sh', 'code.durango.sh']);

/**
 * The app URL that loads `src` through the main process for `account` when it
 * is a Durango Source attachment, else null (also when signed out).
 */
export const sourceAttachmentSrc = (src: string, account: string | null): string | null => {
  if (!account) return null;
  let pathname: string;
  if (src.startsWith('/')) {
    if (src.startsWith('//')) return null;
    pathname = src.replace(/[?#].*$/, '');
  } else {
    let url: URL;
    try {
      url = new URL(src);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' || !DURANGO_HOSTS.has(url.hostname)) return null;
    pathname = url.pathname;
  }
  const match = ATTACHMENT_PATH.exec(pathname);
  if (!match) return null;
  const [, owner, name, attachmentId] = match;
  return `${SOURCE_ATTACHMENT_PROTOCOL}://source/${owner}/${name}/${attachmentId}?account=${encodeURIComponent(account)}`;
};

// The signed-in Durango account's id, set by App from the account state.
let currentAccount: string | null = null;
const listeners = new Set<() => void>();

export const setSourceAttachmentAccount = (account: string | null) => {
  if (account === currentAccount) return;
  currentAccount = account;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getAccount = () => currentAccount;

/** The signed-in account for Source image URLs; re-renders when it changes. */
export const useSourceAttachmentAccount = () => useSyncExternalStore(subscribe, getAccount, getAccount);
