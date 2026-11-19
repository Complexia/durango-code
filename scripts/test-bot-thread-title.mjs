// node --no-warnings scripts/test-bot-thread-title.mjs
import assert from 'node:assert/strict';
import { botThreadTitle } from '../src/main/bot-thread-title.js';

const cases = [
  ['Bots: settle finished threads (bot decides)', 'Durango', 'Settle finished threads (bot decides)'],
  ['Bots: Opus 5.5 for all bots + safe model switching', 'Durango', 'Opus 5.5 for all bots + safe model switching'],
  ['bot - fix the flaky test', 'Durango', 'Fix the flaky test'],
  ['Durango: lean thread prompts', 'Durango', 'Lean thread prompts'],
  ['Durango Code: sidebar tabs', 'Durango', 'Durango Code: sidebar tabs'],
  ['Bot-started threads: normal titles', 'Durango', 'Bot-started threads: normal titles'],
  ['Fix the sidebar dots', 'Durango', 'Fix the sidebar dots'],
  ['Bots:', 'Durango', 'Bots:'],
  ['  Find   5 roles ', '', 'Find 5 roles'],
  [undefined, 'Durango', ''],
  ['C++ (dev): build fix', 'C++ (dev)', 'Build fix'],
  // The full bot name wins over a plain "Bot" prefix.
  ['Bot - QA: fix tests', 'Bot - QA', 'Fix tests'],
  // Letters outside the BMP: matched case-insensitively and capitalized whole.
  ['Bots: \u{10428}eseret input', 'Durango', '\u{10400}eseret input'],
  ['\u{10428}: fix it', '\u{10400}', 'Fix it'],
];
for (const [title, bot, expected] of cases) assert.equal(botThreadTitle(title, bot), expected, `${title} / ${bot}`);
console.log(`bot-thread-title: ${cases.length} cases passed`);
