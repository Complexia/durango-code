import React, { useEffect } from 'react';
import { toast } from 'sonner';
import { onAllThreadsLoaded } from '../store';
import { clearBotRefs, openThreadHere } from './botRefs';

// App-wide half of bot reply refs (./botRefs.tsx): `orion://thread/<id>` links
// from durango.sh, and titles forgotten when the account changes. Kept apart
// from the Markdown renderer so it alone waits on the thread list.

/**
 * App-wide: `orion://thread/<id>` links (a bot reply's thread on durango.sh)
 * open that thread here, and titles are forgotten when the account changes.
 */
export const useBotRefLinks = (account: string | null) => {
  const accountRef = React.useRef(account);
  useEffect(() => {
    if (accountRef.current === account) return;
    accountRef.current = account;
    clearBotRefs();
  }, [account]);
  useEffect(() => {
    const api = window.orion;
    if (!api?.onThreadOpenRequest || !api.takeThreadOpenRequest) return undefined;
    return listenForThreadLinks({ onThreadOpenRequest: api.onThreadOpenRequest, takeThreadOpenRequest: api.takeThreadOpenRequest });
  }, []);
};

/**
 * Opens `orion://thread/<id>` links as they come. A link is taken (and opened,
 * or reported missing) only once every stored thread is in the store: a link
 * that launched the app arrives before the thread list has loaded. Returns
 * the stop.
 */
export const listenForThreadLinks = (api: {
  onThreadOpenRequest: (callback: (threadId: string) => void) => () => void;
  takeThreadOpenRequest: () => Promise<string | null>;
}) => {
  let stopped = false;
  const waiting = new Set<() => void>();
  const take = () => {
    if (stopped) return;
    void api.takeThreadOpenRequest().then((threadId) => {
      // Taken is taken: opened even if the listener stopped meanwhile.
      if (!threadId) return;
      if (!openThreadHere(threadId, { exact: true })) toast.error("That thread isn't on this computer.");
    });
  };
  const takeWhenLoaded = () => waiting.add(onAllThreadsLoaded(take));
  takeWhenLoaded();
  const off = api.onThreadOpenRequest(() => takeWhenLoaded());
  return () => {
    stopped = true;
    for (const stop of waiting) stop();
    off();
  };
};
