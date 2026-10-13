export const RELAY_API_TIMEOUT_MS = 10_000;
export const PAIRING_PROOF_TIMEOUT_MS = 10_000;

/**
 * Fetch one Orion Cloud pairing-proof response with a fixed deadline and the
 * pairing attempt/session lifecycle signal. Keep the deadline armed while the
 * body is read so a server cannot strand the request after sending headers.
 */
export const fetchRemotePairingProofJson = async ({
  url,
  method,
  token,
  body,
  signal,
  timeoutMs = PAIRING_PROOF_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Durango Cloud pairing proof request timed out.'));
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  const cancelForLifecycle = () =>
    controller.abort(signal?.reason ?? new Error('Pairing proof request cancelled.'));
  if (signal?.aborted) cancelForLifecycle();
  else signal?.addEventListener('abort', cancelForLifecycle, { once: true });

  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        timedOut
          ? 'Durango Cloud did not answer the pairing proof request in time.'
          : 'The pairing proof request was cancelled.',
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelForLifecycle);
  }
};

/**
 * Fetch one Orion Cloud relay response with both a fixed application deadline
 * and a caller-owned lifecycle signal. The deadline remains active while the
 * body is read, not only until response headers arrive.
 */
export const fetchRelayApiJson = async ({
  url,
  method = 'POST',
  token,
  body,
  signal,
  timeoutMs = RELAY_API_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) => {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Durango Cloud relay request timed out.'));
  }, Math.max(1, timeoutMs));
  timer.unref?.();
  const cancelForLifecycle = () => controller.abort(signal?.reason ?? new Error('Relay request cancelled.'));
  if (signal?.aborted) cancelForLifecycle();
  else signal?.addEventListener('abort', cancelForLifecycle, { once: true });

  try {
    const response = await fetchImpl(url, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      // Invalid JSON is handled by the caller like an empty response, but an
      // aborted body read must retain its timeout/cancellation meaning.
      if (controller.signal.aborted) throw error;
    }
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        timedOut ? 'Durango Cloud did not answer the relay request in time.' : 'The relay request was cancelled.',
        { cause: error }
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancelForLifecycle);
  }
};
