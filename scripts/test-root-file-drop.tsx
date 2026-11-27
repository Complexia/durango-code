import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  getBotFileDropHandler,
  hasFileDrag,
  hasOpenModalDialog,
  registerBotFileDropHandler,
  resolveRootFileDropTarget,
  rootFileDropOverlayLabel,
  type RootFileDropContext,
} from '../src/app/rootFileDrop';

const base: RootFileDropContext = {
  settingsOpen: false,
  activeTab: 'agents',
  botsTabOpen: false,
  sidebarV3View: 'bot',
  hasModalOpen: false,
  canAttachToThread: true,
  hasBotDropHandler: false,
};

// 1. Normal thread views (Threads tab, or a thread opened from the Bots tab).
assert.equal(resolveRootFileDropTarget(base), 'thread', 'Threads tab with an active composer accepts thread drops');
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'thread' }),
  'thread',
  'A thread opened inside the Bots tab accepts thread drops'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, canAttachToThread: false }),
  'none',
  'Threads tab with no writable composer ignores drops'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'thread', canAttachToThread: false }),
  'none',
  'Bots-tab thread view with an unavailable/read-only thread ignores drops'
);

// 2. Bots conversation view: routes anywhere-in-window drops to the mounted bot composer, never to a hidden thread.
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'bot', hasBotDropHandler: true }),
  'bot',
  'Open bot conversation accepts drops anywhere in the window'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'bot', hasBotDropHandler: false }),
  'none',
  'Bots empty/loading state never leaks drops to a hidden thread'
);

// 3. Other non-thread views must never leak drops to a hidden thread or bot.
assert.equal(
  resolveRootFileDropTarget({ ...base, settingsOpen: true, hasBotDropHandler: true }),
  'none',
  'Settings ignores root file drops even when a thread or bot exists underneath'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, activeTab: 'code', hasBotDropHandler: true }),
  'none',
  'Code tab ignores root file drops instead of leaking to a hidden thread'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'projects', hasBotDropHandler: true }),
  'none',
  'Projects overview ignores root file drops'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'project', hasBotDropHandler: true }),
  'none',
  'Project page ignores root file drops (ProjectLibrary handles its own drop zone)'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, hasModalOpen: true }),
  'none',
  'A blocking modal over a thread ignores root file drops'
);
assert.equal(
  resolveRootFileDropTarget({ ...base, botsTabOpen: true, sidebarV3View: 'bot', hasBotDropHandler: true, hasModalOpen: true }),
  'none',
  'A blocking modal over a bot conversation ignores root file drops'
);

// 4. Overlay copy matches the target on screen.
assert.equal(rootFileDropOverlayLabel('thread'), 'Drop files to attach');
assert.equal(rootFileDropOverlayLabel('bot', 'durango-bots'), 'Drop files to attach to durango-bots');
assert.equal(rootFileDropOverlayLabel('bot', '   '), 'Drop files to attach');
assert.equal(rootFileDropOverlayLabel('none', 'durango-bots'), null);

// 5. File drag & modal detection helpers.
assert.equal(hasFileDrag({ types: ['Files', 'text/plain'] }), true);
assert.equal(hasFileDrag({ types: ['text/plain'] }), false);
assert.equal(hasFileDrag(null), false);
assert.equal(
  hasOpenModalDialog({
    querySelector: (selector: string) => (selector.includes('[aria-modal="true"]') ? ({} as Element) : null),
  } as ParentNode),
  true,
  'detects aria-modal dialogs'
);
assert.equal(
  hasOpenModalDialog({
    querySelector: (selector: string) => (selector.includes('dialog[open]') ? ({} as Element) : null),
  } as ParentNode),
  true,
  'detects open native <dialog> elements'
);
assert.equal(
  hasOpenModalDialog({
    querySelector: (selector: string) => (selector === ':modal' ? ({} as Element) : null),
  } as ParentNode),
  true,
  'detects top-layer :modal elements'
);
assert.equal(
  hasOpenModalDialog({
    querySelector: (selector: string) => {
      if (selector === ':modal') throw new SyntaxError('unsupported pseudo-class');
      return null;
    },
  } as unknown as ParentNode),
  false,
  'tolerates environments without :modal selector support'
);
assert.equal(hasOpenModalDialog({ querySelector: () => null } as unknown as ParentNode), false);

// 6. Bot drop handler registry: safe across rapid switches (stale cleanup cannot clobber the newer bot).
assert.equal(getBotFileDropHandler(), null);
const droppedA: string[] = [];
const droppedB: string[] = [];
const unregisterA = registerBotFileDropHandler({
  botName: 'alpha-bot',
  onDrop: (files) => {
    droppedA.push(...Array.from(files).map((file) => file.name));
  },
});
assert.equal(getBotFileDropHandler()?.botName, 'alpha-bot');

// Simulate Bot B mounting before Bot A's cleanup runs.
const unregisterB = registerBotFileDropHandler({
  botName: 'beta-bot',
  onDrop: (files) => {
    droppedB.push(...Array.from(files).map((file) => file.name));
  },
});
unregisterA();
assert.equal(getBotFileDropHandler()?.botName, 'beta-bot', 'stale bot unregister must not clear a newly mounted bot');

getBotFileDropHandler()?.onDrop([new File(['hello'], 'shot.png', { type: 'image/png' })]);
assert.deepEqual(droppedA, []);
assert.deepEqual(droppedB, ['shot.png']);

unregisterB();
assert.equal(getBotFileDropHandler(), null, 'active bot unregister clears the slot');

// 7. Source-level invariants keeping special targets working and preventing regressions.
const [appSource, botsSource, userActionsSource, htmlVisualSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/BotsWorkspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/UserActions.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/HtmlVisual.tsx', import.meta.url), 'utf8'),
]);

const rootDropMatch = appSource.match(/const handleRootDrop = useCallback\(([\s\S]*?)\n  \);/);
assert.ok(rootDropMatch, 'handleRootDrop must exist in App.tsx');
assert.match(rootDropMatch[1], /if \(event\.defaultPrevented\) return;/, 'handleRootDrop must defer to child drop targets (Needs you, BotComposer)');
assert.match(rootDropMatch[1], /resolveCurrentRootFileDropTarget\(\)/, 'handleRootDrop must resolve the active view target');
assert.match(rootDropMatch[1], /getBotFileDropHandler\(\)\?\.onDrop/, 'handleRootDrop must route Bots-view drops to the registered bot composer');
assert.doesNotMatch(rootDropMatch[1], /\battachFiles\(/, 'handleRootDrop must attach only to the visible thread, never calling resolveComposerTarget via attachFiles');

const rootLeaveMatch = appSource.match(/const handleRootDragLeave = useCallback\(([\s\S]*?)\n  \}, \[\]\);/);
assert.ok(rootLeaveMatch, 'handleRootDragLeave must exist in App.tsx');
assert.match(
  rootLeaveMatch[1],
  /if \(!nextTarget \|\| !event\.currentTarget\.contains\(nextTarget\)\) \{[\s\S]*?dragDepth\.current = 0;[\s\S]*?setDraggingFiles\(false\);/,
  'handleRootDragLeave must unconditionally clear overlay when pointer leaves root (even with empty dataTransfer.types)'
);
assert.match(appSource, /window\.addEventListener\('pointermove', clear, true\)/, 'stuck drag overlay must clear on pointermove');
assert.match(appSource, /window\.addEventListener\('mousedown', clear, true\)/, 'stuck drag overlay must clear on mousedown');
assert.match(appSource, /new MutationObserver\(\(\) => \{\s*if \(hasOpenModalDialog\(\)\) clear\(\);/, 'overlay must clear immediately if a modal opens mid-drag');

assert.match(htmlVisualSource, /aria-modal=\{expanded \? true : undefined\}/, 'expanded HtmlVisual dialog must expose aria-modal');

assert.match(botsSource, /registerBotFileDropHandler\(\{/, 'BotComposer must register its addFiles handler with rootFileDrop');
assert.match(botsSource, /if \(!mountedRef\.current\) \{[\s\S]*?releasePreview\(file\.preview\)[\s\S]*?appendBotDraftFiles\(draftKey, ok, BOT_ATTACHMENTS_MAX\)/, 'BotComposer must persist late-resolving drops to the original draft and release previews on unmount');
assert.match(botsSource, /onDrop=\{\(event\) => \{\s*setDragging\(false\);\s*if \(!event\.dataTransfer\.files\.length\) return;/, 'BotComposer must clear its dragging highlight even on a zero-file drop');
assert.match(botsSource, /onDrop: \(event: React\.DragEvent\) => \{[\s\S]*?event\.stopPropagation\(\);/, 'ProjectLibrary must keep stopping propagation for library drops');
assert.match(userActionsSource, /onDrop=\{\(event\) => \{[\s\S]*?event\.preventDefault\(\);/, 'Needs you replies must keep preventing default on drop so root skips them');

console.log('Root file drop tests passed.');
