import { shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

// Managed blocks written into the project's CLAUDE.md / AGENTS.md so the main
// driver of an orchestrator turn knows its role table and how to delegate.
// Everything outside the markers is left untouched.
export const orchestrationBlockStartMarker = '<!-- ORION:ORCHESTRATION:START -->';
export const orchestrationBlockEndMarker = '<!-- ORION:ORCHESTRATION:END -->';

export const orchestrationRoleLabels = {
  mainDriver: 'Main driver',
  computerUse: 'Computer use',
  exploring: 'Exploring',
  implementation: 'Implementation',
  imageVideoGen: 'Image/video generation',
};

export const buildOrchestrationBlock = (orchestration) => {
  const roles = Array.isArray(orchestration?.roles) ? orchestration.roles : [];
  const lines = [
    orchestrationBlockStartMarker,
    '# Durango Code Orchestration',
    '',
    'These instructions apply only when this session is the Durango Code orchestrator (main driver), which is indicated by an `[Orion orchestration]` context block in the user prompt. Otherwise ignore this section entirely.',
    '',
    '## Roles',
    '',
    '| Role | Model | Provider | Model slug |',
    '| --- | --- | --- | --- |',
  ];
  for (const entry of roles) {
    const roleLabel = entry.roleLabel || orchestrationRoleLabels[entry.role] || entry.role || '';
    const suffix = entry.role === 'mainDriver' ? ' (this agent)' : '';
    lines.push(
      `| ${roleLabel}${suffix} | ${entry.modelLabel || entry.modelId || ''} | ${entry.providerId || ''} | ${entry.slug || ''} |`
    );
  }
  lines.push(
    '',
    '## Delegating to subagents',
    '',
    '1. **Preferred — the `spawn_subagent` tool.** Current Durango Code drivers expose a `spawn_subagent` tool from Durango Code\'s `orion` MCP server (the fully-qualified name varies by provider and may be `mcp__orion__spawn_subagent`, `orion.spawn_subagent`, or a plugin-prefixed equivalent). Call it with `{ model, prompt, title?, role?, effort? }`. `model` accepts a model id like `codex:gpt-5.6-sol`, a slug, or a label. `effort` sets the subagent\'s reasoning effort (e.g. `high`); pass it whenever the user asks for a reasoning level, and omit it otherwise. The task runs on that model as a visible subthread in Durango Code, and the call blocks until the subagent finishes, returning its final report. Delegate computer-use tasks to the computerUse model, code exploration to the exploring model, code changes to the implementation model, and image/video generation to the imageVideoGen model — unless the user explicitly says otherwise (e.g. via @model mentions). The companion `stop_subagent` tool (`{ model?, title?, all? }`, same server) kills a running subagent you spawned: use it whenever the user asks to cancel a delegation, or when you abandon a stalled subagent and hand its task to another — never leave the replaced subagent running. The selector must match exactly one running subagent (pass `all: true` to stop every match). Stopping a subagent resolves its pending spawn_subagent call with a stopped notice.',
    '2. **Fallback — run the provider CLI from the shell.** Only if the spawn_subagent tool is genuinely absent from your tool list, run the target provider CLI directly as a blocking one-shot command and read its output. The current `[Orion orchestration]` prompt supplies mandatory access flags; preserve them exactly and never grant a subagent more access than the driver:',
    '   - codex: `codex exec --json --cd <cwd> --skip-git-repo-check --color never --model <slug> <access flags> "<task>"`',
    '   - claude: `claude --print --model <slug> <access flags> "<task>"`',
    '   - cursor: `cursor-agent --print --trust --workspace <cwd> --model <slug> <access flags> "<task>"`',
    '   - grok: `grok --cwd <cwd> --model <slug> <access flags> --single "<task>"`',
    '   - kimi: `kimi -m <slug> -p "<task>"` — prompt mode auto-approves every tool and cannot be sandboxed, so only delegate to kimi when the access mode is Full access.',
    '   - muse: `muse exec --model <slug> <access flags> "<task>"`',
    '',
    '   Iterate: inspect stdout when the command finishes, and follow up with a refined invocation if the result is incomplete.'
  );
  const generalInstructions = String(orchestration?.generalInstructions || '').trim();
  if (generalInstructions) {
    lines.push('', '## General orchestration instructions', '', orchestration.generalInstructions);
  }
  lines.push(orchestrationBlockEndMarker);
  return lines.join('\n');
};

export const syncOrchestrationInstructionFiles = async (projectPath, orchestration) => {
  const block = buildOrchestrationBlock(orchestration);
  for (const fileName of ['CLAUDE.md', 'AGENTS.md']) {
    const filePath = path.join(projectPath, fileName);
    let existing = null;
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    let next;
    if (existing === null) {
      next = `${block}\n`;
    } else {
      const startIndex = existing.indexOf(orchestrationBlockStartMarker);
      // The END marker only counts if it closes this START; an END before the
      // START (or none at all) means the block is corrupt.
      const endIndex =
        startIndex === -1
          ? -1
          : existing.indexOf(
              orchestrationBlockEndMarker,
              startIndex + orchestrationBlockStartMarker.length
            );
      if (startIndex !== -1 && endIndex !== -1) {
        next =
          existing.slice(0, startIndex) +
          block +
          existing.slice(endIndex + orchestrationBlockEndMarker.length);
      } else {
        // Strip any orphaned markers so repeated runs converge on exactly one
        // well-formed block instead of growing the file.
        const stripped = existing
          .split(orchestrationBlockStartMarker)
          .join('')
          .split(orchestrationBlockEndMarker)
          .join('');
        const trimmed = stripped.replace(/\s+$/u, '');
        next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
      }
    }

    if (next !== existing) await fs.writeFile(filePath, next, 'utf-8');
  }
};
