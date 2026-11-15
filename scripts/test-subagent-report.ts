import assert from 'node:assert/strict';
import { subagentReportText, turnReportsToAgent } from '../src/app/threadLists';

// What a spawn_subagent child reports back to the agent that spawned it.
const user = (content: string) => ({ role: 'user' as const, content });
const agent = (content: string) => ({ role: 'agent' as const, content });

assert.equal(subagentReportText([user('Review the change'), agent('  Found two bugs.  ')]), 'Found two bugs.');
assert.equal(subagentReportText([user('Review the change')]), '', 'no reply is no output');
assert.equal(subagentReportText([user('Review'), agent('   ')]), '');
assert.equal(subagentReportText([user('Review'), agent(''), user('focus on perf')]), '', 'steers alone are not output');

// A steer mid-run splits the reply. A question asked before the steer must
// still reach the parent.
assert.equal(
  subagentReportText([
    user('Check the nine findings'),
    agent('The nine findings are not in my prompt. Please include them.'),
    user('Also check the build'),
    agent('Build passes. Four new bugs found.'),
  ]),
  'The nine findings are not in my prompt. Please include them.\n\n' +
    '[The user steered the subagent: Also check the build]\n\n' +
    'Build passes. Four new bugs found.'
);

// System notes are not part of the reply; the spawn prompt itself is never echoed.
assert.equal(
  subagentReportText([{ role: 'system', content: 'Run started' }, user('Do it'), { role: 'system', content: 'Compacted' }, agent('Done')]),
  'Done'
);

// Whose a turn's non-blocking questions are: the agent that sent it, only in
// a thread an agent created.
const spawnedBy = { machineId: 'm-mac', machineName: 'Mac', threadId: 'mac-thread' };
assert.equal(turnReportsToAgent({ spawnId: 'spawn-1' }), true, 'a spawn_subagent child');
assert.equal(turnReportsToAgent({ spawnedBy }, true), true, 'machine_run_agent in the thread it created');
assert.equal(turnReportsToAgent({ spawnedBy }, false), false, 'the user typing in that thread on the host');
assert.equal(turnReportsToAgent({}, true), false, 'an agent follow-up in a thread the user started');
assert.equal(turnReportsToAgent({}), false, 'an ordinary user turn');

console.log('Subagent report tests passed.');
