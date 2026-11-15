import assert from 'node:assert/strict';
import { subagentReportText } from '../src/app/threadLists';

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

console.log('Subagent report tests passed.');
