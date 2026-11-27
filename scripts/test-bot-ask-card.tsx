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
  onDismissAsk: () => true,
};

// 1. botAskAnswer normalizes whitespace in the question and trims the answer while keeping newlines.
assert.equal(botAskAnswer('  Which\n  city? ', '  Melbourne\nInner north  '), '> **Answering:** Which city?\n\nMelbourne\nInner north');

// 2. Unanswered card renders options, the Suggested tag, a top-right dismiss button, an inline textarea, and a disabled send button.
const unansweredHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0 }}
    handlers={handlers}
    messageId="m1"
    partId="ask-1"
  />
);
assert.match(unansweredHtml, /Which environment\?/);
assert.match(unansweredHtml, /Staging/);
assert.match(unansweredHtml, /Suggested/);
assert.match(unansweredHtml, /<button[^>]*title="Dismiss question"[^>]*aria-label="Dismiss question"/);
assert.match(unansweredHtml, /<textarea[^>]*placeholder="Or type your own answer…"/);
assert.match(unansweredHtml, /<button[^>]*aria-label="Send answer"[^>]*disabled=""/);
assert.doesNotMatch(unansweredHtml, />Or type your own answer\.<\/div>/, 'dead hint text is replaced by the live input');
assert.doesNotMatch(unansweredHtml, /data-ask-custom-answer/);
assert.doesNotMatch(unansweredHtml, /data-ask-dismissed/);

// 2b. Read-only card (without onDismissAsk) omits the dismiss button.
const readOnlyHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0 }}
    handlers={{ onReply: () => {}, onOpenThread: () => false }}
  />
);
assert.doesNotMatch(readOnlyHtml, /aria-label="Dismiss question"/);

// 3. Answering with a preset option disables options, highlights the choice, hides the input and dismiss button.
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
assert.doesNotMatch(presetAnsweredHtml, /aria-label="Dismiss question"/);
assert.equal((presetAnsweredHtml.match(/<button[^>]*disabled=""/g) ?? []).length, 2, 'every preset option is disabled once answered');
assert.match(presetAnsweredHtml, /bg-sky-500\/10[^"]*ring-sky-400\/40[^>]*><span>Production<\/span><svg/);

// 4. Answering with custom free-text disables preset options, hides the input and dismiss button, and shows the custom answer row.
const customAnsweredHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0 }}
    handlers={handlers}
    answered={'Preview branch\nOnly US-West'}
  />
);
assert.doesNotMatch(customAnsweredHtml, /<textarea/);
assert.doesNotMatch(customAnsweredHtml, /aria-label="Dismiss question"/);
assert.equal((customAnsweredHtml.match(/<button[^>]*disabled=""/g) ?? []).length, 2, 'preset options are disabled');
assert.match(customAnsweredHtml, /data-ask-custom-answer=""[^>]*>[\s\S]*Preview branch\nOnly US-West[\s\S]*<svg/);

// 5. Dismissed card collapses to a quiet dismissed row without options, input, Suggested tag, or close button.
const dismissedHtml = renderToStaticMarkup(
  <AskCard
    props={{ question: 'Which environment?', options: ['Staging', 'Production'], recommended: 0, dismissed: true }}
    handlers={handlers}
  />
);
assert.match(dismissedHtml, /data-ask-dismissed=""/);
assert.match(dismissedHtml, /Which environment\?/);
assert.match(dismissedHtml, />Dismissed</);
assert.doesNotMatch(dismissedHtml, /<textarea/);
assert.doesNotMatch(dismissedHtml, /Staging/);
assert.doesNotMatch(dismissedHtml, /Suggested/);
assert.doesNotMatch(dismissedHtml, /aria-label="Dismiss question"/);

// 6. BotCards matches answered questions after whitespace normalization and renders dismissed cards cleanly.
const fromCardsHtml = renderToStaticMarkup(
  <BotCards
    cards={[
      { id: 'ask-1', component: 'bot-ask', props: { question: 'Which  slot?', options: ['Morning', 'Afternoon'] } },
      { id: 'ask-2', component: 'bot-ask', props: { question: 'Need a follow-up?', options: ['Yes', 'No'], dismissed: true } },
    ]}
    handlers={handlers}
    answeredQuestions={new Map([['Which slot?', 'Friday 3pm']])}
    messageId="m2"
  />
);
assert.match(fromCardsHtml, /data-ask-custom-answer=""[^>]*>[\s\S]*Friday 3pm/);
assert.match(fromCardsHtml, /data-ask-dismissed=""[^>]*>[\s\S]*Need a follow-up\?[\s\S]*Dismissed/);
assert.doesNotMatch(fromCardsHtml, /<textarea/);

console.log('ok  bot ask_user card (options, inline custom answer, answered & dismissed states)');
