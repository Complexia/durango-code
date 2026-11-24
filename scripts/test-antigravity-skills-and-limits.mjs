// Unit tests for upgraded Antigravity usage limits (provider-usage-limits.js)
// and native Antigravity skills discovery (antigravity-skills.js).
//   node --no-warnings scripts/test-antigravity-skills-and-limits.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  antigravityWindowsFromAvailableModels,
  antigravityWindowsFromQuotaSummary,
  decodeGoKeyringValue,
  readAntigravityLimits,
  readAntigravityToken,
} from '../src/main/provider-usage-limits.js';
import {
  MAX_SCAN_BYTES,
  MAX_SCAN_ENTRIES,
  MAX_SKILL_BYTES,
  discoverAntigravitySkills,
  mergeAntigravitySlashCommands,
  parseAntigravitySkillFrontmatter,
} from '../src/main/antigravity-skills.js';

const check = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    console.error(`  FAIL ${name}`);
    throw error;
  }
};

const writeSkill = async (dir, content) => {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), content, 'utf8');
};

// --- Part 1: Antigravity usage limits ----------------------------------------

await check('decodeGoKeyringValue decodes base64, hex, and plain text', () => {
  assert.equal(decodeGoKeyringValue(`go-keyring-base64:${Buffer.from('{"a":1}').toString('base64')}`), '{"a":1}');
  assert.equal(decodeGoKeyringValue(`go-keyring-encoded:${Buffer.from('{"b":2}').toString('hex')}`), '{"b":2}');
  assert.equal(decodeGoKeyringValue('  plain-text  '), 'plain-text');
});

await check('readAntigravityToken reads Windows Credential Manager via PowerShell CredReadW', async () => {
  const expiry = '2026-12-01T00:00:00Z';
  const payload = `go-keyring-base64:${Buffer.from(JSON.stringify({ token: { access_token: 'win-secret', expiry } })).toString('base64')}`;
  const calls = [];
  const token = await readAntigravityToken({
    platform: 'win32',
    homeDir: '/nonexistent-home-dir-for-test',
    readFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      return Buffer.from(payload, 'utf8').toString('base64');
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'powershell.exe');
  assert.equal(calls[0].args[0], '-NoProfile');
  assert.equal(calls[0].args[1], '-NonInteractive');
  assert.equal(calls[0].args[2], '-Command');
  assert.match(calls[0].args[3], /advapi32\.dll/);
  assert.match(calls[0].args[3], /CredReadW/);
  assert.match(calls[0].args[3], /1168/);
  assert.match(calls[0].args[3], /gemini:antigravity/);
  assert.deepEqual(token, { accessToken: 'win-secret', expiresAt: Date.parse(expiry) });

  // UTF-16LE credential blob also decodes cleanly.
  const utf16Token = await readAntigravityToken({
    platform: 'win32',
    homeDir: '/nonexistent-home-dir-for-test',
    readFile: async () => {
      throw new Error('ENOENT');
    },
    exec: async () => Buffer.from(payload, 'utf16le').toString('base64'),
  });
  assert.equal(utf16Token?.accessToken, 'win-secret');

  // Empty output (ERROR_NOT_FOUND 1168) or exec failure returns null without throwing.
  const missing = await readAntigravityToken({
    platform: 'win32',
    homeDir: '/nonexistent-home-dir-for-test',
    readFile: async () => {
      throw new Error('ENOENT');
    },
    exec: async () => '',
  });
  assert.equal(missing, null);

  const errored = await readAntigravityToken({
    platform: 'win32',
    homeDir: '/nonexistent-home-dir-for-test',
    readFile: async () => {
      throw new Error('ENOENT');
    },
    exec: async () => {
      throw new Error('powershell failed');
    },
  });
  assert.equal(errored, null);
});

await check('antigravityWindowsFromQuotaSummary handles Argon/Carbon families and rolling reset suppression', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const fiveHoursAhead = new Date(now + 300 * 60_000).toISOString();
  const fiveHoursPlus45s = new Date(now + 300 * 60_000 + 45_000).toISOString();
  const fiveHoursPlus2m = new Date(now + 300 * 60_000 + 120_000).toISOString();
  const weeklyAhead = new Date(now + 10080 * 60_000 - 30_000).toISOString();

  const windows = antigravityWindowsFromQuotaSummary(
    {
      buckets: [
        // Untouched 100% bucket with rolling reset ~5h from now -> resetsAt suppressed to null.
        { bucketId: 'gemini-argon-5h', window: '5h', remainingFraction: 1, resetTime: fiveHoursAhead },
        // Untouched 100% bucket within ±60s of weekly window -> suppressed to null.
        { bucketId: 'gemini-carbon-weekly', window: 'weekly', remainingFraction: 1, resetTime: weeklyAhead },
        // Untouched 100% bucket WITH description -> resetTime preserved!
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 1, resetTime: fiveHoursPlus45s, description: 'Active window' },
        // Untouched 100% bucket >60s off from rolling window -> resetTime preserved!
        { bucketId: '3p-5h', window: '5h', remainingFraction: 1, resetTime: fiveHoursPlus2m },
        // Partially used bucket -> resetTime preserved!
        { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.6, resetTime: weeklyAhead },
      ],
    },
    now
  );

  const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
  assert.equal(byId['gemini-argon-5h'].label, 'Gemini Argon · 5-hour');
  assert.equal(byId['gemini-argon-5h'].resetsAt, null);
  assert.equal(byId['gemini-carbon-weekly'].label, 'Gemini Carbon · Weekly');
  assert.equal(byId['gemini-carbon-weekly'].resetsAt, null);
  assert.equal(byId['gemini-5h'].label, 'Gemini · 5-hour');
  assert.equal(byId['gemini-5h'].resetsAt, Date.parse(fiveHoursPlus45s));
  assert.equal(byId['gemini-5h'].detail, 'Active window');
  assert.equal(byId['3p-5h'].label, 'Claude & GPT · 5-hour');
  assert.equal(byId['3p-5h'].resetsAt, Date.parse(fiveHoursPlus2m));
  assert.equal(byId['3p-weekly'].label, 'Claude & GPT · Weekly');
  assert.equal(byId['3p-weekly'].usedPercent, 40);
  assert.equal(byId['3p-weekly'].resetsAt, Date.parse(weeklyAhead));

  // Explicit group displayName overrides default family label.
  const grouped = antigravityWindowsFromQuotaSummary(
    {
      groups: [
        { displayName: 'Custom Argon', buckets: [{ bucketId: 'gemini-argon-5h', window: '5h', remainingFraction: 0.5 }] },
      ],
    },
    now
  );
  assert.equal(grouped[0].label, 'Custom Argon · 5-hour');
});

await check('antigravityWindowsFromAvailableModels aggregates max usedPercent per family and window', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const resetSoon = '2026-11-23T14:00:00Z';
  const rolling5h = new Date(now + 300 * 60_000).toISOString();
  const weeklyReset = '2026-11-29T00:00:00Z';

  const windows = antigravityWindowsFromAvailableModels(
    {
      models: {
        'gemini-2.5-pro': {
          modelProvider: 'MODEL_PROVIDER_GOOGLE',
          quotaInfo: { remainingFraction: 0.8, resetTime: '2026-11-23T16:00:00Z' },
          weeklyQuotaInfo: { remainingFraction: 0.9, resetTime: weeklyReset },
        },
        'gemini-3.8-flash': {
          // Prefix-only detection (no modelProvider) with higher usage -> wins max!
          quotaInfo: { remainingFraction: 0.35, resetTime: resetSoon },
          weeklyQuotaInfo: { remainingFraction: 0.5, resetTime: weeklyReset },
        },
        'claude-opus-4-6-thinking': {
          modelProvider: 'MODEL_PROVIDER_ANTHROPIC',
          quotaInfo: { remainingFraction: 1, resetTime: rolling5h },
          weeklyQuotaInfo: { isExhausted: true, resetTime: weeklyReset },
        },
        'gpt-5': {
          // Lower usage than claude weekly exhausted, higher 5h usage than claude 0% -> 5h becomes 25%
          quotaInfo: { remainingFraction: 0.75, resetTime: resetSoon },
          weeklyQuotaInfo: { remainingFraction: 0.4, resetTime: weeklyReset },
        },
        'gemini-argon-pro': {
          quotaInfo: { remainingFraction: 1, resetTime: rolling5h },
        },
      },
    },
    now
  );

  const byId = Object.fromEntries(windows.map((w) => [w.id, w]));
  assert.equal(byId['gemini-5h'].label, 'Gemini · 5-hour');
  assert.equal(byId['gemini-5h'].usedPercent, 65);
  assert.equal(byId['gemini-5h'].resetsAt, Date.parse(resetSoon));
  assert.equal(byId['gemini-weekly'].usedPercent, 50);
  assert.equal(byId['3p-5h'].label, 'Claude & GPT · 5-hour');
  assert.equal(byId['3p-5h'].usedPercent, 25);
  assert.equal(byId['3p-weekly'].usedPercent, 100);
  assert.equal(byId['gemini-argon-5h'].label, 'Gemini Argon · 5-hour');
  assert.equal(byId['gemini-argon-5h'].usedPercent, 0);
  assert.equal(byId['gemini-argon-5h'].resetsAt, null, 'untouched rolling reset suppressed in fallback too');
});

await check('readAntigravityLimits queries both hosts in parallel, merges with daily priority, and picks first non-null plan/detail', async () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  let inFlightLoad = 0;
  let maxConcurrentLoad = 0;

  const result = await readAntigravityLimits({
    now,
    readToken: async () => ({ accessToken: 'tok', expiresAt: now + 3600_000 }),
    fetchJsonFn: async (url) => {
      if (url.endsWith(':loadCodeAssist')) {
        inFlightLoad += 1;
        maxConcurrentLoad = Math.max(maxConcurrentLoad, inFlightLoad);
        await new Promise((r) => setTimeout(r, 15));
        inFlightLoad -= 1;
        if (url.includes('daily-cloudcode-pa')) {
          return { ok: true, status: 200, body: { cloudaicompanionProject: 'proj-daily', currentTier: null } };
        }
        return { ok: true, status: 200, body: { cloudaicompanionProject: 'proj-prod', currentTier: { id: 'pro', name: 'Google AI Pro' } } };
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        if (url.includes('daily-cloudcode-pa')) {
          return {
            ok: true,
            status: 200,
            body: {
              buckets: [
                { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.7 },
              ],
            },
          };
        }
        return {
          ok: true,
          status: 200,
          body: {
            description: 'Prod quota summary',
            buckets: [
              // Same bucketId as daily -> daily's 30% used must win over prod's 90% used!
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.1 },
              // Unique bucket from prod -> merged in!
              { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.5 },
            ],
          },
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  assert.equal(maxConcurrentLoad, 2, 'both hosts must be queried in parallel');
  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'Google AI Pro', 'falls back to second host plan when first is null');
  assert.equal(result.detail, 'Prod quota summary', 'falls back to second host detail when first is null');
  assert.deepEqual(
    result.windows.map((w) => [w.id, Math.round(w.usedPercent)]),
    [
      ['3p-weekly', 50],
      ['gemini-5h', 30],
    ]
  );
});

await check('readAntigravityLimits falls back to fetchAvailableModels across both hosts when summary has 0 windows', async () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const seenUrls = [];

  const result = await readAntigravityLimits({
    now,
    readToken: async () => ({ accessToken: 'tok', expiresAt: now + 3600_000 }),
    fetchJsonFn: async (url) => {
      seenUrls.push(url);
      if (url.endsWith(':loadCodeAssist')) {
        return { ok: true, status: 200, body: { cloudaicompanionProject: 'proj-1', currentTier: { id: 'free-tier' } } };
      }
      if (url.endsWith(':retrieveUserQuotaSummary')) {
        return { ok: true, status: 200, body: { buckets: [] } };
      }
      if (url.endsWith(':fetchAvailableModels')) {
        if (url.includes('daily-cloudcode-pa')) {
          return {
            ok: true,
            status: 200,
            body: {
              models: {
                'gemini-2.5-pro': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.6 } },
              },
            },
          };
        }
        return {
          ok: true,
          status: 200,
          body: {
            models: {
              'gemini-2.5-pro': { modelProvider: 'MODEL_PROVIDER_GOOGLE', quotaInfo: { remainingFraction: 0.1 } },
              'claude-sonnet-4-5': { modelProvider: 'MODEL_PROVIDER_ANTHROPIC', weeklyQuotaInfo: { remainingFraction: 0.25 } },
            },
          },
        };
      }
      throw new Error(`Unexpected URL ${url}`);
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.plan, 'Free');
  assert.ok(seenUrls.some((u) => u.includes('daily-cloudcode-pa') && u.endsWith(':fetchAvailableModels')));
  assert.ok(seenUrls.some((u) => u.includes('cloudcode-pa.googleapis.com') && !u.includes('daily-') && u.endsWith(':fetchAvailableModels')));
  assert.deepEqual(
    result.windows.map((w) => [w.id, Math.round(w.usedPercent)]),
    [
      ['3p-weekly', 75],
      ['gemini-5h', 40],
    ]
  );
});

// --- Part 2: Antigravity skills discovery ------------------------------------

await check('budget constants match specification', () => {
  assert.equal(MAX_SCAN_BYTES, 8_000_000);
  assert.equal(MAX_SCAN_ENTRIES, 10_000);
  assert.equal(MAX_SKILL_BYTES, 1_000_000);
});

await check('parseAntigravitySkillFrontmatter handles quotes, folded blocks, wrapped lines, and BOM', () => {
  assert.deepEqual(
    parseAntigravitySkillFrontmatter(
      '\uFEFF---\nname: "quoted-skill"\ndescription: >-\n  First line\n  second line.\n---\n# Body\n'
    ),
    { name: 'quoted-skill', description: 'First line second line.' }
  );
  assert.deepEqual(
    parseAntigravitySkillFrontmatter(
      "---\nname: 'single-skill'\ndescription: 'It''s quoted'\n---\n"
    ),
    { name: 'single-skill', description: "It's quoted" }
  );
  assert.deepEqual(
    parseAntigravitySkillFrontmatter(
      '---\nname: plain-wrap\ndescription: Starts here\n  continues here\n---\n'
    ),
    { name: 'plain-wrap', description: 'Starts here continues here' }
  );
});

await check('discoverAntigravitySkills respects root priority order, scopes, and large-file 64 KB head read', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-skills-priority-'));
  try {
    const homeDir = path.join(root, 'home');
    const cwd = path.join(root, 'project');

    // Root 1: <home>/.gemini/config/skills (user) — highest priority
    await writeSkill(path.join(homeDir, '.gemini', 'config', 'skills', 's-collide-1'), '---\nname: collide-1\ndescription: from root 1\n---\n');
    await writeSkill(path.join(homeDir, '.gemini', 'config', 'skills', 'only-root-1'), '---\nname: only-root-1\ndescription: user config\n---\n');

    // Root 2: <cwd>/.gemini/skills (project)
    await writeSkill(path.join(cwd, '.gemini', 'skills', 's-collide-1'), '---\nname: collide-1\ndescription: from root 2\n---\n');
    await writeSkill(path.join(cwd, '.gemini', 'skills', 's-collide-2'), '---\nname: collide-2\ndescription: from root 2\n---\n');

    // Root 3: <home>/.gemini/antigravity-cli/skills (user)
    await writeSkill(path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 's-collide-2'), '---\nname: collide-2\ndescription: from root 3\n---\n');
    await writeSkill(path.join(homeDir, '.gemini', 'antigravity-cli', 'skills', 's-collide-3'), '---\nname: collide-3\ndescription: from root 3\n---\n');

    // Root 4: <cwd>/.agents/skills (project)
    await writeSkill(path.join(cwd, '.agents', 'skills', 's-collide-3'), '---\nname: collide-3\ndescription: from root 4\n---\n');
    await writeSkill(path.join(cwd, '.agents', 'skills', 's-collide-4'), '---\nname: collide-4\ndescription: from root 4\n---\n');

    // Root 5: <cwd>/.agent/skills (project) — includes large (200 KB) SKILL.md and directory-name fallback
    await writeSkill(path.join(cwd, '.agent', 'skills', 's-collide-4'), '---\nname: collide-4\ndescription: from root 5\n---\n');
    await writeSkill(
      path.join(cwd, '.agent', 'skills', 'large-doc'),
      `---\nname: large-doc\ndescription: Leading frontmatter\n---\n${'x'.repeat(200_000)}`
    );
    await writeSkill(path.join(cwd, '.agent', 'skills', 'fallback-dir-name'), '# No frontmatter\n');

    const skills = await discoverAntigravitySkills({ cwd, homeDir });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

    // Sorted alphabetically.
    assert.deepEqual(
      skills.map((s) => s.name),
      [...skills.map((s) => s.name)].sort((a, b) => a.localeCompare(b))
    );

    assert.equal(byName['collide-1'].description, 'from root 1');
    assert.equal(byName['collide-1'].scope, 'user');
    assert.equal(byName['collide-2'].description, 'from root 2');
    assert.equal(byName['collide-2'].scope, 'project');
    assert.equal(byName['collide-3'].description, 'from root 3');
    assert.equal(byName['collide-3'].scope, 'user');
    assert.equal(byName['collide-4'].description, 'from root 4');
    assert.equal(byName['collide-4'].scope, 'project');
    assert.equal(byName['large-doc'].description, 'Leading frontmatter');
    assert.equal(byName['large-doc'].argumentHint, '');
    assert.equal(byName['fallback-dir-name'].description, '');
    assert.equal(byName['fallback-dir-name'].scope, 'project');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check('discoverAntigravitySkills honors skills.json inherits, entries, include_only, exclude, cycle detection, and max depth 10', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-skills-manifest-'));
  try {
    const homeDir = path.join(root, 'home');
    const cwd = path.join(root, 'project');

    // Shared skills referenced via project .agents/skills.json
    await writeSkill(path.join(cwd, 'team-skills', 'lint'), '---\nname: lint\ndescription: Team linter\n---\n');
    await writeSkill(path.join(cwd, 'team-skills', 'experimental-foo'), '---\nname: experimental-foo\ndescription: Excluded by regex\n---\n');

    // Home-relative skills referenced via ~/.gemini/config/skills.json
    await writeSkill(path.join(homeDir, 'my-extra', 'personal-tool'), '---\nname: personal-tool\ndescription: Personal\n---\n');
    await writeSkill(path.join(homeDir, 'my-extra', 'skipped-tool'), '---\nname: skipped-tool\ndescription: Not in include_only\n---\n');

    // Inherited manifest with cycle: shared-a.json -> shared-b.json -> shared-a.json
    await writeSkill(path.join(root, 'shared-skills', 'keep-me'), '---\nname: keep-me\ndescription: Inherited kept\n---\n');
    await writeSkill(path.join(root, 'shared-skills', 'drop-me'), '---\nname: drop-me\ndescription: Inherited dropped\n---\n');
    await writeSkill(path.join(root, 'shared-skills', 'not-listed'), '---\nname: not-listed\ndescription: Outside include_only\n---\n');

    await fs.mkdir(path.join(root, 'manifests'), { recursive: true });
    const manifestA = path.join(root, 'manifests', 'shared-a.json');
    const manifestB = path.join(root, 'manifests', 'shared-b.json');
    await fs.writeFile(
      manifestA,
      JSON.stringify({
        inherits: [{ path: manifestB }],
        entries: [{ path: path.join(root, 'shared-skills') }],
      })
    );
    await fs.writeFile(
      manifestB,
      JSON.stringify({
        inherits: [{ path: manifestA }], // cycle back to A!
      })
    );

    // Depth chain: depth-0 (.agent/skills.json) -> depth-1 -> ... -> depth-10 (included) -> depth-11 (exceeds max depth 10, ignored)
    const chainDir = path.join(root, 'chain');
    await fs.mkdir(chainDir, { recursive: true });
    await writeSkill(path.join(chainDir, 'skill-d10', 'depth-10'), '---\nname: depth-10\ndescription: At max depth 10\n---\n');
    await writeSkill(path.join(chainDir, 'skill-d11', 'depth-11'), '---\nname: depth-11\ndescription: Beyond max depth\n---\n');
    for (let d = 1; d <= 11; d += 1) {
      const next = d < 11 ? [{ path: path.join(chainDir, `m${d + 1}.json`) }] : [];
      const entries =
        d === 10
          ? [{ path: path.join(chainDir, 'skill-d10') }]
          : d === 11
            ? [{ path: path.join(chainDir, 'skill-d11') }]
            : [];
      await fs.writeFile(path.join(chainDir, `m${d}.json`), JSON.stringify({ inherits: next, entries }));
    }

    await fs.mkdir(path.join(cwd, '.agents'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.agents', 'skills.json'),
      JSON.stringify({
        entries: [{ path: 'team-skills', exclude: ['experimental-.*'] }],
        inherits: [{ path: manifestA, include_only: ['keep-me', 'drop-me'], exclude: ['drop-me'] }],
      })
    );

    await fs.mkdir(path.join(cwd, '.agent'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.agent', 'skills.json'),
      JSON.stringify({
        inherits: [{ path: path.join(chainDir, 'm1.json') }],
      })
    );

    await fs.mkdir(path.join(homeDir, '.gemini', 'config'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.gemini', 'config', 'skills.json'),
      JSON.stringify({
        entries: [{ path: '~/my-extra', include_only: ['personal-tool'] }],
      })
    );

    const skills = await discoverAntigravitySkills({ cwd, homeDir });
    const names = skills.map((s) => s.name);
    assert.deepEqual(names, ['depth-10', 'keep-me', 'lint', 'personal-tool']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check('discoverAntigravitySkills discovers enabled plugin skills and skips disabled plugins', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-skills-plugins-'));
  try {
    const homeDir = path.join(root, 'home');
    const geminiHome = path.join(root, 'custom-gemini');
    const pluginsRoot = path.join(geminiHome, 'config', 'plugins');

    await writeSkill(path.join(pluginsRoot, 'enabled-plug', 'skills', 'plug-a'), '---\nname: plug-a\ndescription: Enabled plugin skill\n---\n');
    await writeSkill(path.join(pluginsRoot, 'disabled-plug', 'skills', 'plug-b'), '---\nname: plug-b\ndescription: Disabled via config\n---\n');
    await writeSkill(path.join(pluginsRoot, 'shipped-off', 'skills', 'plug-c'), '---\nname: plug-c\ndescription: Disabled via plugin.json\n---\n');
    await fs.writeFile(path.join(pluginsRoot, 'shipped-off', 'plugin.json'), JSON.stringify({ disabled: true }));
    await writeSkill(path.join(pluginsRoot, 're-enabled', 'skills', 'plug-d'), '---\nname: plug-d\ndescription: Re-enabled via config\n---\n');
    await fs.writeFile(path.join(pluginsRoot, 're-enabled', 'plugin.json'), JSON.stringify({ disabled: true }));

    await fs.writeFile(
      path.join(geminiHome, 'config', 'config.json'),
      JSON.stringify({
        plugins: {
          'disabled-plug': { enabled: false },
          're-enabled': { enabled: true },
        },
      })
    );

    const skills = await discoverAntigravitySkills({ homeDir, geminiHome });
    assert.deepEqual(
      skills.map((s) => [s.name, s.scope]),
      [
        ['plug-a', 'plugin'],
        ['plug-d', 'plugin'],
      ]
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check('discoverAntigravitySkills enforces MAX_SKILL_BYTES and MAX_SCAN_BYTES budgets', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-skills-budget-'));
  try {
    const homeDir = path.join(root, 'home');
    const skillsDir = path.join(homeDir, '.gemini', 'config', 'skills');

    // One skill exceeding MAX_SKILL_BYTES (1 MB) must be skipped.
    await writeSkill(
      path.join(skillsDir, '00-oversized'),
      `---\nname: oversized\ndescription: Too big\n---\n${'a'.repeat(MAX_SKILL_BYTES + 100)}`
    );

    // 10 skills of 900 KB each: total 9 MB > MAX_SCAN_BYTES (8 MB), so only 8 fit (8 * 900 KB = 7.2 MB <= 8 MB).
    const chunk = 'b'.repeat(900_000);
    for (let i = 1; i <= 10; i += 1) {
      const id = String(i).padStart(2, '0');
      await writeSkill(
        path.join(skillsDir, `s-${id}`),
        `---\nname: skill-${id}\ndescription: Bulk ${id}\n---\n${chunk}`
      );
    }

    const skills = await discoverAntigravitySkills({ homeDir });
    assert.equal(skills.some((s) => s.name === 'oversized'), false, 'skill over MAX_SKILL_BYTES must be skipped');
    assert.equal(skills.length, 8, 'scan stops once MAX_SCAN_BYTES budget would be exceeded');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await check('mergeAntigravitySlashCommands lets live commands win, normalizes shape, and sorts alphabetically', () => {
  const merged = mergeAntigravitySlashCommands(
    [
      { name: '/zeta', description: 'Live zeta', input: { hint: '<arg>' } },
      { name: 'deploy', description: 'Live deploy', argumentHint: '[env]' },
    ],
    [
      { name: 'deploy', description: 'Skill deploy (should lose)', argumentHint: '', path: '/x/SKILL.md', scope: 'project' },
      { name: 'alpha', description: 'Skill alpha', argumentHint: '', path: '/y/SKILL.md', scope: 'user' },
    ]
  );

  assert.deepEqual(merged, [
    { name: 'alpha', description: 'Skill alpha', argumentHint: '' },
    { name: 'deploy', description: 'Live deploy', argumentHint: '[env]' },
    { name: 'zeta', description: 'Live zeta', argumentHint: '<arg>' },
  ]);
  assert.deepEqual(mergeAntigravitySlashCommands(null, undefined), []);
});

await check('discoverAntigravitySkills handles pathological ReDoS filter patterns in linear time', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-skills-redos-'));
  try {
    const cwd = path.join(root, 'repo');
    const homeDir = path.join(root, 'home');
    const evilName = `${'a'.repeat(35)}!`;
    await writeSkill(
      path.join(cwd, 'custom-skills', evilName),
      `---\nname: ${evilName}\ndescription: Should not hang\n---\nBody\n`
    );
    await writeSkill(
      path.join(cwd, 'custom-skills', 'good-skill'),
      '---\nname: good-skill\ndescription: Matched cleanly\n---\nBody\n'
    );
    await fs.mkdir(path.join(cwd, '.agents'), { recursive: true });
    await fs.writeFile(
      path.join(cwd, '.agents', 'skills.json'),
      JSON.stringify({
        entries: [{ path: 'custom-skills', include_only: ['(a+)+$', 'good-.*'] }],
      })
    );
    const t0 = Date.now();
    const skills = await discoverAntigravitySkills({ cwd, homeDir });
    const elapsedMs = Date.now() - t0;
    assert.ok(elapsedMs < 500, `expected linear-time match (<500ms), took ${elapsedMs}ms`);
    assert.deepEqual(skills.map((s) => s.name), ['good-skill']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

console.log('antigravity skills and limits: ok');
