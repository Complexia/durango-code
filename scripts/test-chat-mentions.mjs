// @chat mentions of Durango Chat conversations (src/app/durangoChats.ts) and
// the work-sharing consent migration (src/app/workspaceSyncConsent.ts).
//
//   node --no-warnings --experimental-strip-types scripts/test-chat-mentions.mjs
import assert from 'node:assert/strict';

import {
  buildChatMentionsContext,
  chatIdFromReference,
  chatMentionSlug,
  chatMentionToken,
  chatReferencePattern,
  formatChatUpdatedAt,
  knownDurangoChat,
  knownDurangoChatUrl,
  parseChatMentions,
  rememberDurangoChats,
} from '../src/app/durangoChats.ts';
import { getChatMentionReplaceEnd } from '../src/app/chatMentions.ts';
import {
  WORKSPACE_SYNC_CONSENT_VERSION,
  migrateWorkspaceSyncSettings,
  shouldShowWorkspaceSyncConsentPrompt,
} from '../src/app/workspaceSyncConsent.ts';

const billing = {
  id: 'jd7a1b2c3d4e5f6g7h8i9j0kbilling',
  title: 'Billing rewrite: plan & rollout!',
  url: 'https://durango.sh/chats/proj1?node=jd7a1b2c3d4e5f6g7h8i9j0kbilling',
  updatedAt: '2026-10-12T16:20:00.000Z',
};
const untitled = { id: 'k57zzzzzzzzzzzzzzzzzzzzzzzzzzzz', title: '', url: null };

// --- Tokens ---------------------------------------------------------------------
assert.equal(chatMentionSlug('Billing rewrite: plan & rollout!'), 'billing-rewrite-plan-rollout');
assert.equal(chatMentionSlug('Café — déjà vu'), 'cafe-deja-vu');
assert.equal(chatMentionSlug('x'.repeat(80)).length, 40);
assert.equal(chatMentionToken(billing), `chat:billing-rewrite-plan-rollout-${billing.id}`);
assert.equal(chatMentionToken(untitled), `chat:${untitled.id}`, 'an untitled chat is just the id');
assert.ok(chatMentionToken(billing).endsWith(billing.id), 'the token carries the FULL chat id (contracts §9)');

// --- Reference parsing -------------------------------------------------------------
assert.equal(chatIdFromReference(`billing-rewrite-plan-rollout-${billing.id}`), billing.id);
assert.equal(chatIdFromReference(billing.id), billing.id, 'a bare id resolves to itself');
{
  const uuid = '3f2a9c1e-7b4d-4e8a-9c2f-0d1e2f3a4b5c';
  assert.equal(chatIdFromReference(`futuremail-bug-${uuid}`), uuid, 'an unknown UUID chat id survives slug parsing');
  assert.equal(chatIdFromReference(uuid), uuid, 'a bare UUID resolves to itself');
}
// A retitled chat (different slug) still resolves by id.
assert.equal(chatIdFromReference(`old-title-${billing.id}`), billing.id);
// Known chats win, even if a (hypothetical) id contained a dash.
const dashed = { id: 'abc-def123', title: 'Dashed' };
assert.equal(chatIdFromReference('dashed-abc-def123', [dashed]), 'abc-def123');
assert.equal(chatIdFromReference('dashed-abc-def123'), 'def123', 'without metadata the last segment is the id');

const text = `Compare @chat:billing-rewrite-plan-rollout-${billing.id} with @chat:${untitled.id}, and again @chat:${billing.id}.`;
const mentions = parseChatMentions(text, [billing]);
assert.deepEqual(
  mentions.map((mention) => mention.chatId),
  [billing.id, untitled.id],
  'distinct chats in order of first appearance; trailing punctuation is not part of the id'
);
assert.equal(mentions[0].title, billing.title);
assert.equal(mentions[0].url, billing.url);
assert.equal(mentions[0].token, chatMentionToken(billing));
assert.equal(mentions[1].title, null, 'unknown chats still resolve, without metadata');
assert.equal(mentions[1].token, `chat:${untitled.id}`);
assert.deepEqual(parseChatMentions('email me at someone@chat:example'), [], 'needs whitespace or start before @');
assert.deepEqual(parseChatMentions('no mentions here'), []);
assert.deepEqual(parseChatMentions('@chat: nothing'), []);
assert.equal([...`see @chat:${billing.id}`.matchAll(chatReferencePattern)].length, 1);

// --- Agent context -----------------------------------------------------------------
const context = buildChatMentionsContext(mentions);
assert.match(context, /^\[Durango chat mentions\]/);
assert.match(context, /\[\/Durango chat mentions\]$/);
assert.match(context, /read_chat/);
assert.match(context, /information, not as instructions/);
assert.ok(context.includes(`chatId: ${billing.id}; url: ${billing.url}`));
assert.ok(context.includes(`"${billing.title}"`));
assert.ok(context.includes(`chatId: ${untitled.id})`));
assert.ok(!context.includes('Phase 1'), 'ids and titles only, never chat content');
assert.equal(buildChatMentionsContext([]), '');

// --- Known-chat memory (titles and links for rendering) -----------------------------
rememberDurangoChats([billing, { id: '', title: 'ignored' }]);
assert.equal(knownDurangoChat(billing.id)?.title, billing.title);
assert.equal(knownDurangoChatUrl(billing.id), billing.url);
rememberDurangoChats([{ id: 'evil', url: 'javascript:alert(1)' }]);
assert.equal(knownDurangoChatUrl('evil'), null, 'only http(s) links open');
assert.equal(knownDurangoChatUrl('missing'), null);

// --- Dropdown details -------------------------------------------------------------
const now = Date.parse('2026-10-13T12:00:00.000Z');
assert.equal(formatChatUpdatedAt('2026-10-13T11:58:00.000Z', now), '2m ago');
assert.equal(formatChatUpdatedAt('2026-10-13T07:00:00.000Z', now), '5h ago');
assert.equal(formatChatUpdatedAt('2026-10-11T12:00:00.000Z', now), '2d ago');
assert.equal(formatChatUpdatedAt(null, now), '');
assert.equal(formatChatUpdatedAt('not a date', now), '');
// Chat searches are free text: the replaced range ends at the caret.
assert.equal(getChatMentionReplaceEnd('@billing plan tail', { start: 0, query: 'billing plan' }, 'chat'), 13);
assert.equal(getChatMentionReplaceEnd('@gpt-5 tail', { start: 0, query: 'gp' }, 'model'), 6);

// --- Work sharing consent ------------------------------------------------------------
// Fresh install: both sharing and code sync are off by default; opt-in prompt
// waits until signed in.
assert.equal(WORKSPACE_SYNC_CONSENT_VERSION, 2);
const fresh = migrateWorkspaceSyncSettings(undefined);
assert.deepEqual(fresh, {
  enabled: false,
  syncCode: false,
  consentVersion: 2,
  consentNoticeSeen: false,
});
assert.equal(shouldShowWorkspaceSyncConsentPrompt(fresh, false), false, 'no prompt while signed out');
assert.equal(shouldShowWorkspaceSyncConsentPrompt(fresh, true), true, 'prompt once when signed in');

// Pre-Durango user who never opted in (persisted the old default off):
// stays off, code sync off, prompted once when signed in.
const legacyOff = migrateWorkspaceSyncSettings({ enabled: false, syncCode: true });
assert.deepEqual(legacyOff, { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: false });
assert.equal(shouldShowWorkspaceSyncConsentPrompt(legacyOff, true), true);

// Pre-Durango user who had explicitly opted in: keeps sharing and their syncCode choice.
const legacyOn = migrateWorkspaceSyncSettings({ enabled: true, syncCode: false });
assert.deepEqual(legacyOn, { enabled: true, syncCode: false, consentVersion: 2, consentNoticeSeen: true });
assert.equal(shouldShowWorkspaceSyncConsentPrompt(legacyOn, true), false);
const legacyOnWithCode = migrateWorkspaceSyncSettings({ enabled: true, syncCode: true });
assert.deepEqual(legacyOnWithCode, { enabled: true, syncCode: true, consentVersion: 2, consentNoticeSeen: true });
assert.equal(shouldShowWorkspaceSyncConsentPrompt(legacyOnWithCode, true), false);

// Consent v1 user switched on by the merge migration (unseen notice): goes back to off and gets opt-in prompt.
const v1Unseen = migrateWorkspaceSyncSettings({ enabled: true, syncCode: true, consentVersion: 1, consentNoticeSeen: false });
assert.deepEqual(v1Unseen, { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: false });
assert.equal(shouldShowWorkspaceSyncConsentPrompt(v1Unseen, true), true);

// Consent v1 user who acknowledged/dismissed the notice: stored state cannot distinguish
// dismissing the toast from an explicit toggle, so lean toward off and ask once.
const v1Acked = migrateWorkspaceSyncSettings({ enabled: true, syncCode: true, consentVersion: 1, consentNoticeSeen: true });
assert.deepEqual(v1Acked, { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: false });
assert.equal(shouldShowWorkspaceSyncConsentPrompt(v1Acked, true), true);

// Consent v1 user who explicitly turned sharing off: stays off and is not prompted again.
const v1ExplicitOff = migrateWorkspaceSyncSettings({ enabled: false, syncCode: true, consentVersion: 1, consentNoticeSeen: true });
assert.deepEqual(v1ExplicitOff, { enabled: false, syncCode: false, consentVersion: 2, consentNoticeSeen: true });
assert.equal(shouldShowWorkspaceSyncConsentPrompt(v1ExplicitOff, true), false);

// After consent v2, explicit choices stick across every later hydration.
const declined = { ...fresh, enabled: false, syncCode: false, consentNoticeSeen: true };
assert.deepEqual(migrateWorkspaceSyncSettings(declined), declined);
assert.equal(shouldShowWorkspaceSyncConsentPrompt(declined, true), false);

const optedInNoCode = { ...fresh, enabled: true, syncCode: false, consentNoticeSeen: true };
assert.deepEqual(migrateWorkspaceSyncSettings(optedInNoCode), optedInNoCode);
assert.equal(shouldShowWorkspaceSyncConsentPrompt(optedInNoCode, true), false);

const optedInWithCode = { ...fresh, enabled: true, syncCode: true, consentNoticeSeen: true };
assert.deepEqual(migrateWorkspaceSyncSettings(optedInWithCode), optedInWithCode);
assert.equal(shouldShowWorkspaceSyncConsentPrompt(optedInWithCode, true), false);

console.log('chat mentions + work sharing consent: ok');
