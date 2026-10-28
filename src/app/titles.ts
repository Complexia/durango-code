export const isDefaultTitle = (title: string) =>
  /^Thread \d{1,2}:\d{2}/i.test(title) || /^New thread$/i.test(title.trim());

export const getGoalTitleSeed = (
  thread: { title: string; messages: unknown[] },
  goalAction: { action: 'set' | 'resume'; objective?: string }
): string | null => {
  if (goalAction.action !== 'set' || !goalAction.objective) return null;
  if (thread.messages.length > 0 || !isDefaultTitle(thread.title)) return null;
  return goalAction.objective;
};

export const isPlausibleTitle = (title: string) => {
  if (!title) return false;
  const s = title.trim();
  if (s.length < 3 || s.length > 80) return false;
  if (/^\s*[\{\[]/.test(s)) return false;
  if (/"type"\s*:/i.test(s) || /"data"\s*:/i.test(s)) return false;
  if (/\btype["\s]*:["\s]*thought\b/i.test(s)) return false;
  // Don't let defaults or raw protocol leak in
  if (/^thread\s+\d{1,2}:\d{2}/i.test(s)) return false;
  return true;
};

export const deriveTitle = (prompt: string): string => {
  let t = prompt.trim().replace(/\s+/g, ' ');
  // First line or first sentence
  t = t.split(/[\n.!?]\s/)[0] || t;
  // Strip polite prefixes
  t = t.replace(/^(please\s+|can you\s+|could you\s+|i want (you )?to\s+|i need (you )?to\s+|help me\s+|let's\s+|pls\s+)/i, '');
  t = t.trim();
  const MAX = 58;
  if (t.length > MAX) {
    t = t.slice(0, MAX).trim();
    const lastSpace = t.lastIndexOf(' ');
    if (lastSpace > 18) t = t.slice(0, lastSpace);
    t = t.replace(/[,:;\s]+$/g, '') + '…';
  }
  // Basic title casing
  t = t.replace(/\b\w/g, (c) => c.toUpperCase());
  t = t.replace(/[,:;\.\s…]+$/g, '').trim();
  return t || 'New thread';
};

export const tryGenerateBetterTitle = async (
  threadId: string,
  prompt: string,
  turn: { modelId: string | null; reasoningEffort: string | null },
  projectPath: string,
  update: (id: string, updates: { title: string }) => void,
  expectedTitle: string,
  getCurrentTitle: (id: string) => string | undefined
) => {
  if (!window.orion?.generateThreadTitle || !turn.modelId) return;
  try {
    const title = await window.orion.generateThreadTitle({
      threadId,
      prompt,
      ...turn,
      projectPath,
    });
    if (title && typeof title === 'string') {
      const cleaned = title.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '').trim().split(/[\n\r]/)[0].trim();
      if (isPlausibleTitle(cleaned) && getCurrentTitle(threadId) === expectedTitle) {
        update(threadId, { title: cleaned });
      }
      // If the title is no longer the heuristic we started with, the user
      // renamed it while generation was pending, so preserve their choice.
    }
  } catch {
    // ignore failures, heuristic title remains
  }
};
