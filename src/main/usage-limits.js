// Plan limits Claude Code reports while it runs. The Claude Agent SDK yields a
// rate_limit_event (status, utilization, reset time per window) during Durango
// Code's Claude runs and bot replies; nothing on disk keeps them, so the
// latest one per window is remembered here (userData/usage-limits.json) for
// the Usage view's Limits tab. Codex limits come from its session logs
// instead (usage-stats.js).

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomicSync } from './atomic-write.js';

let resolveDir = null;
let filePath = null;
let limits = null;
let saveTimer = null;

const load = () => {
  if (limits) return limits;
  limits = {};
  if (!filePath && resolveDir) {
    try {
      filePath = path.join(resolveDir(), 'usage-limits.json');
    } catch {
      filePath = null;
    }
  }
  if (!filePath) return limits;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object') limits = parsed;
  } catch {
    // Nothing recorded yet.
  }
  return limits;
};

/** `userDataDir` returns the directory to keep the file in (resolved on first use). */
export const configureUsageLimits = (userDataDir) => {
  resolveDir = userDataDir;
  filePath = null;
  limits = null;
};

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** Records an SDK rate_limit_event message; ignores anything else. */
export const recordClaudeRateLimit = (message, now = Date.now()) => {
  if (message?.type !== 'rate_limit_event') return;
  const info = message.rate_limit_info;
  if (!info || typeof info !== 'object') return;
  const current = load();
  current.claude ??= {};
  const record = (type, window) => {
    current.claude[type] = {
      status: typeof window.status === 'string' ? window.status : null,
      utilization: finite(window.utilization),
      resetsAt: finite(window.resetsAt) !== null ? window.resetsAt * 1000 : null,
      usingOverage: Boolean(info.isUsingOverage || info.overageInUse),
      overageStatus: typeof info.overageStatus === 'string' ? info.overageStatus : null,
      at: now,
    };
  };
  // Current Claude Code sends every plan window it tracks in unifiedWindows
  // ({ seven_day: { utilization: 0.01, resetsAt } }); the top-level fields
  // describe the window that decided this request.
  const windows = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? Object.entries(info.unifiedWindows) : [];
  const type = typeof info.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType : windows.length ? null : 'unknown';
  for (const [name, window] of windows) {
    if (window && typeof window === 'object') record(name, { ...window, status: name === type ? info.status : null });
  }
  if (type && !windows.some(([name]) => name === type)) record(type, info);
  if (!filePath || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      writeFileAtomicSync(filePath, JSON.stringify(limits));
    } catch {
      // Best effort: the next event writes again.
    }
  }, 1000);
  saveTimer.unref?.();
};

export const claudeRateLimits = () => load().claude ?? {};
