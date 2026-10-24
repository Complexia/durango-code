import assert from 'node:assert/strict';
import { createLatestOperationGate } from '../src/app/remote-operation-gate.ts';
import {
  canGenerateRemotePairingCode,
  claimRemoteSideEffect,
  claimRemoteThreadStart,
  mergeSynchronouslyTrackedRuns,
  parseRemotePortDraft,
  persistSuccessfulRemoteCommand,
  remoteAgentSettingsPatch,
  remoteControlIsAuthenticated,
  remoteThreadRunError,
  remoteThreadRuntime,
  reportedSubagentSettingsPatch,
} from '../src/app/remote-control-policy.ts';
import { withThreadStartReservation } from '../src/app/turnStart.ts';

assert.equal(parseRemotePortDraft('47615'), 47615);
assert.equal(parseRemotePortDraft(' 2048 '), 2048);
assert.equal(parseRemotePortDraft(''), null);
assert.equal(parseRemotePortDraft('4'), null);
assert.equal(parseRemotePortDraft('65536'), null);
console.log('ok  remote port drafts validate only when committed');

assert.equal(remoteThreadRuntime('claude:claude-code-cli'), 'terminal');
assert.equal(remoteThreadRuntime('claude:claude-sonnet-4-5'), 'agent');
assert.match(remoteThreadRunError('claude:claude-code-cli'), /output is only available in the host terminal/i);
assert.equal(remoteThreadRunError('claude:claude-sonnet-4-5'), null);
console.log('ok  remote turns reject terminal-only threads before routing');

{
  const emptyThread = {};
  const grokModel = {
    id: 'grok:grok-4.5',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.5',
    slug: 'grok-4.5',
  };
  const grok46Model = {
    id: 'grok:grok-4.6',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.6',
    slug: 'grok-4.6',
  };
  const grok47Model = {
    id: 'grok:grok-4.7',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.7',
    slug: 'grok-4.7',
  };
  const grok47FastModel = {
    id: 'grok:grok-4.7-build-fast',
    providerId: 'grok',
    providerLabel: 'Grok',
    label: 'Grok 4.7 Fast',
    slug: 'grok-4.7-build-fast',
  };
  const claudeModel = {
    id: 'claude:claude-opus-5',
    providerId: 'claude',
    providerLabel: 'Claude',
    label: 'Claude Opus 5',
    slug: 'claude-opus-5',
  };
  const codexModel = {
    id: 'codex:gpt-5.6-sol',
    providerId: 'codex',
    providerLabel: 'Codex',
    label: 'GPT-5.6 Sol',
    slug: 'gpt-5.6-sol',
  };
  const lunaModel = {
    ...codexModel,
    id: 'codex:gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    slug: 'gpt-5.6-luna',
  };
  const gpt6SolModel = {
    ...codexModel,
    id: 'codex:gpt-6-sol',
    label: 'GPT-6 Sol',
    slug: 'gpt-6-sol',
  };
  const gpt6LunaModel = {
    ...codexModel,
    id: 'codex:gpt-6-luna',
    label: 'GPT-6 Luna',
    slug: 'gpt-6-luna',
  };
  const opus55Model = {
    ...claudeModel,
    id: 'claude:claude-opus-5-5',
    label: 'Claude Opus 5.5',
    slug: 'claude-opus-5-5',
  };

  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, grokModel, { reasoningEffort: 'high' }),
    { grokReasoningEffort: 'high' }
  );
  assert.deepEqual(
    remoteAgentSettingsPatch({ grokReasoningEffort: 'high' }, grokModel, { reasoningEffort: 'high' }),
    {}
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, grokModel, { reasoningEffort: 'ultra' }),
    {},
    'grok must not accept codex-only ultra'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, grok46Model, { reasoningEffort: 'xhigh' }),
    { grokReasoningEffort: 'xhigh' },
    'Grok 4.6 accepts its Extra High effort tier'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, grok47Model, { reasoningEffort: 'xhigh' }),
    { grokReasoningEffort: 'xhigh' },
    'Grok 4.7 accepts its Extra High effort tier'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, grok47FastModel, { reasoningEffort: 'xhigh' }),
    { grokReasoningEffort: 'xhigh' },
    'Grok 4.7 Fast accepts its Extra High effort tier'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, grokModel, { reasoningEffort: 'xhigh' }),
    {},
    'older Grok models must not inherit the Grok 4.6+ effort tier'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, claudeModel, {
      reasoningEffort: 'xhigh',
      claudeContextWindow: '200k',
    }),
    // opus-5 is 1M-only, so 200k is clamped up
    { claudeReasoningEffort: 'xhigh', claudeContextWindow: '1m' }
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, codexModel, {
      reasoningEffort: 'ultra',
      codexServiceTier: 'priority',
    }),
    { codexReasoningEffort: 'ultra', codexServiceTier: 'priority' }
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, codexModel, {
      reasoningEffort: 'ultrathink',
      codexServiceTier: 'turbo',
    }),
    {},
    'codex must drop claude-only effort and unknown tiers'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, gpt6SolModel, { reasoningEffort: 'max' }),
    { codexReasoningEffort: 'max' },
    'GPT-6 Sol accepts the GPT-6 Max tier'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, gpt6SolModel, { reasoningEffort: 'ultra' }),
    { codexReasoningEffort: 'ultra' },
    'GPT-6 Sol accepts Ultra'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, gpt6LunaModel, { reasoningEffort: 'max' }),
    { codexReasoningEffort: 'max' },
    'GPT-6 Luna accepts Max'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, gpt6LunaModel, { reasoningEffort: 'ultra' }),
    {},
    'GPT-6 Luna must reject Ultra, which the CLI does not advertise for it'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, codexModel, { reasoningEffort: 'max' }),
    { codexReasoningEffort: 'max' },
    'GPT-5.6 Sol accepts Max like the GPT-6 family'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(
      emptyThread,
      { ...gpt6SolModel, reasoningEfforts: ['low', 'medium', 'high'] },
      { reasoningEffort: 'max' }
    ),
    {},
    'live-catalog tiers replace the static Codex sets'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(
      emptyThread,
      { ...opus55Model, reasoningEfforts: ['low', 'medium', 'high', 'max'] },
      { reasoningEffort: 'ultracode' }
    ),
    {},
    'Ultracode needs a model whose catalog offers Extra High'
  );
  assert.deepEqual(
    remoteAgentSettingsPatch(emptyThread, opus55Model, {
      reasoningEffort: 'xhigh',
      claudeContextWindow: '200k',
    }),
    { claudeReasoningEffort: 'xhigh', claudeContextWindow: '1m' },
    'Opus 5.5 is 1M-only, so 200k is clamped up'
  );
  assert.deepEqual(
    reportedSubagentSettingsPatch(
      { modelId: codexModel.id, codexReasoningEffort: 'high' },
      lunaModel,
      lunaModel.id,
      'low'
    ),
    { modelId: lunaModel.id, codexReasoningEffort: 'low' },
    'reported Codex model and effort must update the canonical thread settings together'
  );
  assert.deepEqual(
    reportedSubagentSettingsPatch({}, lunaModel, lunaModel.id, 'ultra'),
    { modelId: lunaModel.id },
    'reported effort must be valid for the reported model before it reaches thread settings'
  );
  console.log('ok  remote agent settings map onto the right thread fields per provider');
}

// A relay outage must not disable pairing while the LAN listener is up: any
// live inbound route makes a code usable, matching the engine's
// hostAcceptingConnections().
assert.equal(
  canGenerateRemotePairingCode({
    connectionMode: 'relay',
    hostListening: true,
    relayOnline: false,
  }),
  true
);
assert.equal(
  canGenerateRemotePairingCode({
    connectionMode: 'relay',
    hostListening: false,
    relayOnline: true,
  }),
  true
);
assert.equal(
  canGenerateRemotePairingCode({
    connectionMode: 'relay',
    hostListening: false,
    relayOnline: false,
  }),
  false
);
assert.equal(
  canGenerateRemotePairingCode({
    connectionMode: 'direct',
    hostListening: true,
    relayOnline: false,
  }),
  true
);
assert.equal(
  canGenerateRemotePairingCode({
    connectionMode: 'direct',
    hostListening: false,
    relayOnline: true,
  }),
  false
);
console.log('ok  pairing-code readiness follows every live inbound route');

assert.equal(remoteControlIsAuthenticated(true, true), true);
assert.equal(remoteControlIsAuthenticated(true, false), false);
assert.equal(remoteControlIsAuthenticated(true, undefined), false);
assert.equal(remoteControlIsAuthenticated(false, true), false);
console.log('ok  remote UI authorization requires live engine authentication');

const snapshotGate = createLatestOperationGate();
const olderSnapshot = snapshotGate.begin();
const newerSnapshot = snapshotGate.begin();
assert.equal(snapshotGate.isCurrent(olderSnapshot), false);
assert.equal(snapshotGate.isCurrent(newerSnapshot), true);
console.log('ok  a newer same-machine refresh supersedes an older response');

const threadGate = createLatestOperationGate();
const olderThread = threadGate.begin();
const newerThread = threadGate.begin();
assert.equal(threadGate.isCurrent(olderThread), false);
assert.equal(threadGate.isCurrent(newerThread), true);
console.log('ok  a newer same-thread refresh supersedes an older response');

const commandGate = createLatestOperationGate();
const pendingSend = commandGate.begin();
commandGate.invalidate();
assert.equal(commandGate.isCurrent(pendingSend), false);
console.log('ok  changing selection invalidates a pending send completion');

const independentSnapshot = snapshotGate.begin();
threadGate.begin();
assert.equal(snapshotGate.isCurrent(independentSnapshot), true);
console.log('ok  transcript refreshes do not supersede workspace snapshots');

const synchronouslyTrackedRuns = mergeSynchronouslyTrackedRuns(
  { 'settled-thread': 'settled-run' },
  new Map([['just-started-run', { threadId: 'just-started-thread' }]])
);
assert.equal(synchronouslyTrackedRuns.get('settled-thread'), 'settled-run');
assert.equal(synchronouslyTrackedRuns.get('just-started-thread'), 'just-started-run');
console.log('ok  remote Stop sees runs registered before React publishes its active-run ref');

const pendingStarts = new Set();
let finishClaim;
const claimPending = new Promise((resolve) => {
  finishClaim = resolve;
});
const firstStart = withThreadStartReservation(
  pendingStarts,
  'shared-thread',
  async () => {
    await claimPending;
    assert.equal(pendingStarts.has('shared-thread'), true, 'the reservation must span the claim await');
    return true;
  }
);
assert.deepEqual(
  await withThreadStartReservation(pendingStarts, 'shared-thread', async () => true),
  { acquired: false },
  'a concurrent start must be refused while command claiming is pending'
);
finishClaim();
assert.deepEqual(await firstStart, { acquired: true, value: true });
assert.deepEqual(
  await withThreadStartReservation(pendingStarts, 'shared-thread', async () => true),
  { acquired: true, value: true },
  'the reservation should release when startup exits'
);
console.log('ok  per-thread start reservation spans remote command claiming');

let claimedSetting = 'low';
assert.equal(
  await claimRemoteThreadStart(
    async () => false,
    () => {
      claimedSetting = 'high';
    }
  ),
  false
);
assert.equal(
  claimedSetting,
  'low',
  'an expired or revoked run must not apply its requested thread settings'
);
assert.equal(
  await claimRemoteThreadStart(
    async () => true,
    () => {
      claimedSetting = 'high';
    }
  ),
  true
);
assert.equal(claimedSetting, 'high');
console.log('ok  remote run settings apply only after the atomic start claim succeeds');

let claims = 0;
assert.equal(
  await claimRemoteSideEffect(() => false, async () => {
    claims += 1;
    return true;
  }),
  false
);
assert.equal(claims, 0, 'an expired Stop must not attempt to claim or apply effects');
assert.equal(
  await claimRemoteSideEffect(() => true, async () => {
    claims += 1;
    return false;
  }),
  false
);
assert.equal(
  await claimRemoteSideEffect(() => true, async () => {
    claims += 1;
    return true;
  }),
  true
);
assert.equal(claims, 2);
console.log('ok  remote Stop side effects require a live atomic command claim');

let releaseThreadSave;
const threadSavePending = new Promise((resolve) => {
  releaseThreadSave = resolve;
});
let successSettled = false;
const persistedSuccess = persistSuccessfulRemoteCommand(
  { ok: true, threadId: 'new-thread' },
  async () => {
    await threadSavePending;
    return true;
  }
).then((outcome) => {
  successSettled = true;
  return outcome;
});
await Promise.resolve();
assert.equal(successSettled, false, 'command success must wait for the transcript write');
releaseThreadSave();
assert.deepEqual(await persistedSuccess, { ok: true, threadId: 'new-thread' });
assert.deepEqual(
  await persistSuccessfulRemoteCommand({ ok: true, threadId: 'stopped-thread' }, async () => false),
  {
    ok: false,
    threadId: 'stopped-thread',
    error: 'The remote command changed the host, but its thread state could not be saved.',
  }
);
let failedCommandSaveCalls = 0;
const originalFailure = { ok: false, error: 'No running turn on that thread.' };
assert.equal(
  await persistSuccessfulRemoteCommand(originalFailure, async () => {
    failedCommandSaveCalls += 1;
    return true;
  }),
  originalFailure
);
assert.equal(failedCommandSaveCalls, 0, 'non-mutating failures must not force a transcript write');
console.log('ok  successful remote mutations persist before their outcomes are exposed');
