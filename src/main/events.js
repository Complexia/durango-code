import { BrowserWindow } from 'electron';
import { redactSecrets } from './secret-requests.js';

// Taps on agent turn events, so main-process consumers (remote control) can
// follow runs without a renderer in the loop. Listener errors never break the
// renderer path.
const agentEventListeners = new Set();

export const addAgentEventListener = (listener) => {
  agentEventListeners.add(listener);
  return () => agentEventListeners.delete(listener);
};

const notifyAgentEventListeners = (event) => {
  for (const listener of agentEventListeners) {
    try {
      listener(event);
    } catch (error) {
      console.error('agent event listener error', error);
    }
  }
};

// Secret values the user saved through request_secret (secret-requests.js)
// are scrubbed here, before any event reaches the renderer (which saves the
// thread) or remote control.
export const emitAgentEvent = (webContents, rawEvent) => {
  const event = redactSecrets(rawEvent);
  if (!webContents.isDestroyed()) {
    webContents.send('agent:turnEvent', event);
  }
  notifyAgentEventListeners(event);
};

export const sendToAllWindows = (channel, rawPayload) => {
  const payload = channel === 'agent:turnEvent' ? redactSecrets(rawPayload) : rawPayload;
  let delivered = 0;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload);
      delivered += 1;
    }
  }
  if (channel === 'agent:turnEvent') notifyAgentEventListeners(payload);
  return delivered;
};
