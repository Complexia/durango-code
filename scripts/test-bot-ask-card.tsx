import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { create } from 'zustand';

// ask_user cards (src/app/BotReplyCards.tsx): preset options, inline free-text
// answer input, and answered states for both preset and custom answers.

const useOrionStore = create(() => ({ threads: [] }));
mock.module('../src/store', () => ({ useOrionStore }));
mock.module('sonner', () => ({ toast: { error: () => {}, info: () => {}, success: () => {} } }));
mock.module('../src/app/HtmlVisual', () => ({ HtmlVisual: () => null }));

const { AskCard, BotCards, botAskAnswer } = await import('../src/app/BotReplyCards');

const handlers = {
  onReply: () => {},
  onOpenThread: () => false,
};

// 1. botAskAnswer normalizes whitespace in the question and trims the answer while keeping newlines.
assert.equal(botAskAnswer('  Which\n  city? ', '  Melbourne\nInner north  '), '> **Answering:** Which city?\n\nMelbourne\nInner north');

// 2. Unanswered card renders options, the Suggested tag, an inline textarea, and a disabled send button.
const unansweredHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0 }}
    handlers={handlers}
  />
);
assert.match(unansweredHtml, /Which environment\?/);
assert.match(unansweredHtml, /Staging/);
assert.match(unansweredHtml, /Suggested/);
assert.match(unansweredHtml, /<textarea[^>]*placeholder="Or type your own answer…"/);
assert.match(unansweredHtml, /<button[^>]*aria-label="Send answer"[^>]*disabled=""/);
assert.doesNotMatch(unansweredHtml, />Or type your own answer\.<\/div>/, 'dead hint text is replaced by the live input');
assert.doesNotMatch(unansweredHtml, /data-ask-custom-answer/);

// 3. Answering with a preset option disables options, highlights the choice, and hides the input.
const presetAnsweredHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0 }}
    handlers={handlers}
    answered="Production"
  />
);
assert.doesNotMatch(presetAnsweredHtml, /<textarea/);
assert.doesNotMatch(presetAnsweredHtml, /Suggested/);
assert.doesNotMatch(presetAnsweredHtml, /data-ask-custom-answer/);
assert.equal((presetAnsweredHtml.match(/<button[^>]*disabled=""/g) ?? []).length, 2, 'every preset option is disabled once answered');
assert.match(presetAnsweredHtml, /bg-sky-500\/10[^"]*ring-sky-400\/40[^>]*><span>Production<\/span><svg/);

// 4. Answering with custom free-text disables preset options, hides the input, and shows the custom answer row.
const customAnsweredHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0 }}
    handlers={handlers}
    answered={'Preview branch\nOnly US-West'}
  />
);
assert.doesNotMatch(customAnsweredHtml, /<textarea/);
assert.equal((customAnsweredHtml.match(/<button[^>]*disabled=""/g) ?? []).length, 2, 'preset options are disabled');
assert.match(customAnsweredHtml, /data-ask-custom-answer=""[^>]*>[\s\S]*Preview branch\nOnly US-West[\s\S]*<svg/);

// 5. BotCards matches answered questions after whitespace normalization.
const fromCardsHtml = renderToStaticMarkup(
  <BotCards
    cards={[{ id: 'ask-1', component: 'bot-ask', props: { question: 'Which  slot?', options: ['Morning', 'Afternoon'] } }]}
    handlers={handlers}
    answeredQuestions={new Map([['Which slot?', 'Friday 3pm']])}
  />
);
assert.match(fromCardsHtml, /data-ask-custom-answer=""[^>]*>[\s\S]*Friday 3pm/);
assert.doesNotMatch(fromCardsHtml, /<textarea/);

console.log('ok  bot ask_user card (options, inline custom answer, answered states)');
