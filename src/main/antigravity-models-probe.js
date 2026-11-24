import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { killAgentChild } from './run-registry.js';
import { loginShell } from './shell-env.js';
import { removeAntigravitySessionFiles } from './antigravity-session-files.js';

// Dynamic ACP model & thinking-level discovery for Antigravity (`agy acp`).
//
// `agy models` prints flat `<model>-<effort>` text rows, which requires regex
// suffix guessing and misses models whose thinking tiers aren't encoded in the
// slug. Probing `agy acp` via `session/new` + `session/set_config_option`
// (`configId: 'model'`) reads each model's live `thought_level` config option
// directly from the server, then deletes the temporary probe session files so
// `~/.gemini/antigravity-cli` stays clean.

const REASONING_EFFORT_TIERS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const DEFAULT_ANTIGRAVITY_EFFORT = 'high';
const FAVORITE_MODEL_SLUGS = new Set(['gemini-4-neon', 'gemini-3.8-flash']);

const effortRank = (effort) => {
  const rank = REASONING_EFFORT_TIERS.indexOf(effort);
  return rank === -1 ? REASONING_EFFORT_TIERS.length : rank;
};

const flattenSelectOptions = (options) => {
  if (!Array.isArray(options)) return [];
  const out = [];
  for (const entry of options) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.value === 'string') {
      out.push(entry);
    } else if (Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (nested && typeof nested === 'object' && typeof nested.value === 'string') {
          out.push(nested);
        }
      }
    }
  }
  return out;
};

const normalizeEffortValue = (value) => {
  const clean = String(value || '').trim().toLowerCase();
  if (!clean) return null;
  if (clean === 'extra' || clean === 'extra_high' || clean === 'extra-high') return 'xhigh';
  return clean;
};

/**
 * Extracts `{ efforts, defaultEffort }` from ACP `configOptions`'s
 * `thought_level` select option, or `null` when the active model has no
 * thinking-level selector.
 */
export const extractAntigravityThoughtLevelConfig = (configOptions) => {
  if (!Array.isArray(configOptions)) return null;
  const option = configOptions.find(
    (candidate) =>
      candidate &&
      candidate.type === 'select' &&
      (candidate.category === 'thought_level' || candidate.id === 'thought_level')
  );
  if (!option) return null;
    const rawOptions = flattenSelectOptions(option.options);
  const wireValues = {};
  const effortsSet = new Set();
  for (const entry of rawOptions) {
    const raw = entry.value.trim();
    const normalized = normalizeEffortValue(raw);
    if (!normalized) continue;
    if (!effortsSet.has(normalized)) {
      effortsSet.add(normalized);
      if (raw !== normalized) wireValues[normalized] = raw;
    }
  }
  const efforts = [...effortsSet].sort((a, b) => effortRank(a) - effortRank(b));
  if (efforts.length === 0) return null;
  const current = normalizeEffortValue(option.currentValue);
  const defaultEffort =
    current && efforts.includes(current)
      ? current
      : efforts.includes(DEFAULT_ANTIGRAVITY_EFFORT)
        ? DEFAULT_ANTIGRAVITY_EFFORT
        : efforts[0];
  return {
    efforts,
    defaultEffort,
    ...(Object.keys(wireValues).length > 0 ? { wireValues } : {}),
  };
};

/**
 * Extracts `{ currentModel, entries: [{ value, name }] }` from ACP
 * `configOptions`'s `model` select option.
 */
export const extractAntigravityModelSelectConfig = (configOptions) => {
  if (!Array.isArray(configOptions)) return null;
  const option = Array.isArray(configOptions)
    ? configOptions.find(
        (candidate) =>
          candidate &&
          candidate.type === 'select' &&
          (candidate.id === 'model' || candidate.category === 'model')
      )
    : null;
  if (!option) return null;
  const seen = new Set();
  const entries = [];
  for (const raw of flattenSelectOptions(option.options)) {
    const value = raw.value.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : value;
    entries.push({ value, name });
  }
  return {
    currentModel: typeof option.currentValue === 'string' ? option.currentValue.trim() : null,
    entries,
  };
};

/**
 * Converts a `session/new` response plus per-model probed `thought_level`
 * configs into Durango Code's Antigravity model catalog entries.
 *
 * When `configOptions` has a `model` select option, each model gets the exact
 * `reasoningEfforts` and `defaultReasoningEffort` observed from its own
 * `thought_level` config option. On older `agy` builds that only publish flat
 * `models.availableModels`, falls back to `fallbackGroupRows`.
 */
export const buildAntigravityModelsFromAcpProbe = (
  sessionSetup,
  thinkingLevelsByModel = new Map(),
  { fallbackGroupRows } = {}
) => {
  const modelSelect = extractAntigravityModelSelectConfig(sessionSetup?.configOptions);
  if (modelSelect && modelSelect.entries.length > 0) {
    const initialThinking = extractAntigravityThoughtLevelConfig(sessionSetup?.configOptions);
    const seenLabels = new Set();
    return modelSelect.entries.map((entry, index) => {
      const slug = entry.value;
      const baseLabel = entry.name;
      const label = seenLabels.has(baseLabel) ? `${baseLabel} (${slug})` : baseLabel;
      seenLabels.add(baseLabel);

      const observed = thinkingLevelsByModel.has(slug)
        ? thinkingLevelsByModel.get(slug)
        : slug === modelSelect.currentModel
          ? initialThinking
          : null;

      return {
        id: `antigravity:${slug}`,
        providerId: 'antigravity',
        providerLabel: 'Antigravity',
        label,
        slug,
        command: 'agy',
        ...(observed && observed.efforts.length > 0
          ? {
              reasoningEfforts: observed.efforts,
              defaultReasoningEffort: observed.defaultEffort,
              ...(observed.wireValues ? { antigravityThoughtLevelValues: observed.wireValues } : {}),
            }
          : {}),
        ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
        favorite: FAVORITE_MODEL_SLUGS.has(slug),
      };
    });
  }

  const available = Array.isArray(sessionSetup?.models?.availableModels)
    ? sessionSetup.models.availableModels
    : [];
  if (available.length > 0 && typeof fallbackGroupRows === 'function') {
    const rows = [];
    const seen = new Set();
    for (const item of available) {
      const id = typeof item?.modelId === 'string' ? item.modelId.trim() : '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = typeof item?.name === 'string' && item.name.trim() ? item.name.trim() : id;
      rows.push([id, name]);
    }
    return fallbackGroupRows(rows);
  }
  return [];
};

const defaultSpawnProbe = ({ cwd }) =>
  spawn(loginShell, ['-lc', 'agy acp'], {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/**
 * Probes `agy acp` in a temporary directory to discover every model and its
 * live `thought_level` options, then cleans up the temporary session files.
 * Returns `[]` on any error or timeout so callers can fall back to `agy models`.
 */
export const probeAntigravityModelsOverAcp = async ({
  spawnProcess = defaultSpawnProbe,
  terminateProcess = killAgentChild,
  removeSessionFiles = removeAntigravitySessionFiles,
  fallbackGroupRows,
  timeoutMs = 15_000,
} = {}) => {
  let tempCwd = null;
  try {
    tempCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'durango-agy-models-'));
  } catch {
    return [];
  }

  let child = null;
  let capturedSessionId = null;
  let deadlineTimer = null;

  try {
    child = spawnProcess({ cwd: tempCwd });
    const pending = new Map();
    let nextId = 1;
    let closed = false;
    let buffer = '';

    const rejectAll = (reason) => {
      if (closed) return;
      closed = true;
      for (const resolve of pending.values()) resolve({ error: { message: reason } });
      pending.clear();
    };

    deadlineTimer = setTimeout(() => rejectAll('Antigravity model probe timed out.'), Math.max(100, timeoutMs));
    deadlineTimer.unref?.();

    child.stdout?.on?.('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (msg && msg.id !== undefined && !msg.method) {
          const resolve = pending.get(msg.id);
          if (resolve) {
            pending.delete(msg.id);
            resolve(msg);
          }
        }
      }
    });
    child.stderr?.resume?.();
    child.on?.('error', () => rejectAll('Antigravity probe process failed.'));
    child.on?.('close', () => rejectAll('Antigravity probe process closed.'));

    const rpc = (method, params) => {
      if (closed) return Promise.resolve({ error: { message: 'Probe closed.' } });
      const id = nextId++;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        } catch {
          pending.delete(id);
          resolve({ error: { message: 'Could not write to probe stdin.' } });
        }
      });
    };

    const init = await rpc('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'durango-code', version: '1' },
    });
    if (init.error) return [];

    const session = await rpc('session/new', { cwd: tempCwd, mcpServers: [] });
    if (session.error || typeof session.result?.sessionId !== 'string') return [];
    capturedSessionId = session.result.sessionId;

    const sessionSetup = session.result;
    const modelSelect = extractAntigravityModelSelectConfig(sessionSetup.configOptions);
    const thinkingLevelsByModel = new Map();

    if (modelSelect && modelSelect.entries.length > 0) {
      if (modelSelect.currentModel) {
        thinkingLevelsByModel.set(
          modelSelect.currentModel,
          extractAntigravityThoughtLevelConfig(sessionSetup.configOptions)
        );
      }
      for (const entry of modelSelect.entries) {
        if (closed) return [];
        if (entry.value === modelSelect.currentModel) continue;
        const switched = await rpc('session/set_config_option', {
          sessionId: capturedSessionId,
          configId: 'model',
          value: entry.value,
        });
        if (closed || switched.error || !Array.isArray(switched.result?.configOptions)) {
          return [];
        }
        thinkingLevelsByModel.set(
          entry.value,
          extractAntigravityThoughtLevelConfig(switched.result.configOptions)
        );
      }
    }

    if (closed) return [];
    return buildAntigravityModelsFromAcpProbe(sessionSetup, thinkingLevelsByModel, {
      fallbackGroupRows,
    });
  } catch {
    return [];
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (child) {
      await Promise.resolve(terminateProcess(child)).catch(() => {});
    }
    if (capturedSessionId) {
      await Promise.resolve(removeSessionFiles({ sessionId: capturedSessionId, cwd: tempCwd })).catch(() => {});
    }
    if (tempCwd) {
      await fs.rm(tempCwd, { recursive: true, force: true }).catch(() => {});
    }
  }
};
