import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [appSource, workspaceSource] = await Promise.all([
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/CodeWorkspace.tsx', import.meta.url), 'utf8'),
]);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const transcriptPage = deferred<{ ok: boolean; value: string }>();
const pageRequested = deferred<void>();
const existingProject = { id: 'repository', name: 'Existing project', path: '/tmp/existing' };
const existingEpic = { id: 'epic', name: 'Existing epic', createdAt: '2026-09-01T00:00:00Z' };
let savedValue = JSON.stringify({
  version: 1,
  state: {
    projects: [existingProject],
    epics: [existingEpic],
    selectedProjectId: existingProject.id,
    workspacePath: existingProject.path,
    // A copied profile must adopt this machine's path after hydration.
    noProject: { id: 'orion:no-project', name: 'No project', path: '/old-machine/chats' },
    deploymentSettings: { preferAgentDeploys: true },
    threads: [],
  },
});
const originalValue = savedValue;
const writes: string[] = [];
let directoryRequests = 0;
const bridge = {
  loadStore: async () => savedValue,
  loadThreadsPage: async () => {
    pageRequested.resolve();
    return transcriptPage.promise;
  },
  saveStore: async (value: string) => {
    writes.push(value);
    savedValue = value;
    return true;
  },
  getNoProjectDir: async () => {
    directoryRequests += 1;
    return '/this-machine/chats';
  },
};
// All storage and IPC are in memory; these checks never touch the user's profile.
Object.assign(globalThis, {
  window: { addEventListener() {}, localStorage: { getItem: () => null }, orion: bridge },
});
const { useOrionStore, flushOrionStoreSave, findProjectById, isNoProjectId, NO_PROJECT_ID } =
  await import('../src/store');
await pageRequested.promise;

// Execute the actual startup effect with the real persisted store. Keeping
// hydration pending beyond the save debounce reproduces the former data loss.
const effectSection = appSource.slice(
  appSource.indexOf('// Resolve (and create) the scratch directory No project agents run in.'),
  appSource.indexOf('// Sync workspace with first project if none set')
);
assert.ok(effectSection.includes('useEffect('));
const effectCallback = effectSection.slice(
  effectSection.indexOf('useEffect(') + 'useEffect('.length,
  effectSection.lastIndexOf(', [setNoProjectPath]')
);
const mount = new Function(
  'useOrionStore', 'setNoProjectPath',
  new Bun.Transpiler({ loader: 'tsx' }).transformSync(`const effect = ${effectCallback};`) + '\nreturn effect;'
)(useOrionStore, useOrionStore.getState().setNoProjectPath);

// Strict Mode's first mount is disposed before hydration; only its replacement
// may initialize the scratch workspace.
const disposeFirst = mount();
disposeFirst();
const disposeActive = mount();
await new Promise((resolve) => setTimeout(resolve, 450));
assert.equal(useOrionStore.persist.hasHydrated(), false);
assert.equal(directoryRequests, 0);
assert.deepEqual(writes, [], 'Startup must not persist an unhydrated default store');
assert.equal(savedValue, originalValue);

const hydrated = new Promise<void>((resolve) => {
  const unsubscribe = useOrionStore.persist.onFinishHydration(() => {
    unsubscribe();
    resolve();
  });
});
transcriptPage.resolve({ ok: true, value: JSON.stringify({
  version: 2, present: true, stale: false, revision: 1,
  offset: 0, total: 0, threads: [], nextOffset: null,
}) });
await hydrated;
await Promise.resolve();
assert.equal(directoryRequests, 1, 'The disposed effect must not initialize after hydration');
assert.equal(useOrionStore.getState().noProject?.path, '/this-machine/chats');
assert.equal(await flushOrionStoreSave(), true);
const savedState = JSON.parse(savedValue).state;
assert.deepEqual(savedState.projects, [existingProject]);
assert.deepEqual(savedState.epics, [existingEpic]);
assert.equal(savedState.deploymentSettings.preferAgentDeploys, true);
assert.equal(savedState.noProject.path, '/this-machine/chats');
disposeActive();

// Already-hydrated mounts can request immediately, but late IPC responses
// must not update the store after unmount.
const lateDirectory = deferred<string>();
bridge.getNoProjectDir = () => lateDirectory.promise;
const disposeLate = mount();
disposeLate();
lateDirectory.resolve('/cancelled/chats');
await Promise.resolve();
assert.equal(useOrionStore.getState().noProject?.path, '/this-machine/chats');

const lookup = workspaceSource.match(/const selectedProject =[\s\S]*?;/)?.[0];
assert.ok(lookup);
const resolveCodeProject = new Function(
  'projects', 'noProject', 'selectedProjectId', 'findProjectById', 'isNoProjectId',
  `${lookup}\nreturn selectedProject;`
);
const noProject = useOrionStore.getState().noProject;
for (const [selectedId, scratch, expected] of [
  [NO_PROJECT_ID, noProject, noProject],
  [NO_PROJECT_ID, null, null],
  [existingProject.id, noProject, existingProject],
  [null, noProject, existingProject],
] as const) {
  assert.equal(
    resolveCodeProject([existingProject], scratch, selectedId, findProjectById, isNoProjectId),
    expected,
    'Code must resolve the selected chat workspace without falling back to an unrelated repository'
  );
}
console.log('No project hydration, cancellation, and Code workspace regressions passed.');
