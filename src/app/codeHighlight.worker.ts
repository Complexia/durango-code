/// <reference lib="webworker" />
import { createHighlightEngine, type EngineRequest } from './codeHighlightEngine';

// Shiki tokenizing off the main thread; see codeHighlightEngine.ts.
const scope = self as unknown as DedicatedWorkerGlobalScope;

const engine = createHighlightEngine({
  loadShiki: async () => {
    const [core, engineModule, langs] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/langs'),
    ]);
    return { core, engine: engineModule, langs };
  },
  post: (response) => scope.postMessage(response),
  yieldNow: () => new Promise((resolve) => setTimeout(resolve, 0)),
});

scope.onmessage = (event: MessageEvent<EngineRequest>) => engine.receive(event.data);
