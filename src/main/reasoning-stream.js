// Tracks reasoning (thought) activities for one agent run. Each thinking phase
// gets its own keyed activity (`${runId}:reasoning:${seq}`) that stays `running`
// while thought deltas stream and flips to `done` as soon as a new tool call,
// assistant text chunk, or turn end arrives — so a finished thought stops
// occupying the live slot and each thinking stretch stays in chronological
// order beside the actions it led to.
export const createReasoningStream = ({ runId, emit, intervalMs = 150 }) => {
  let seq = 0;
  let active = false;
  let emitted = false;
  let pending = '';
  let timer = null;
  let lastEmitAt = 0;

  const key = () => `${runId}:reasoning:${seq}`;

  const send = (status = 'running') => {
    const detailDelta = pending;
    pending = '';
    if (!detailDelta && !emitted) return;
    emitted = true;
    emit({
      key: key(),
      type: 'thought',
      title: 'Reasoning',
      detailDelta,
      status,
    });
  };

  const push = (delta) => {
    if (typeof delta !== 'string' || !delta) return;
    // Drivers sometimes send a trailing separator (e.g. "\n\n") after a
    // reasoning item closes; don't open a blank thought step for whitespace.
    if (!active && !delta.trim()) return;
    active = true;
    pending = `${pending}${delta}`;
    const elapsed = Date.now() - lastEmitAt;
    if (elapsed >= intervalMs) {
      lastEmitAt = Date.now();
      send('running');
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      lastEmitAt = Date.now();
      send('running');
    }, intervalMs - elapsed);
  };

  const finishStep = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!active && !pending && !emitted) return;
    send('done');
    active = false;
    emitted = false;
    pending = '';
    seq += 1;
  };

  return { push, finishStep };
};
