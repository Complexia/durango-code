// Guards that Durango Code never reads Antigravity's plan limits from Google
// (provider-usage-limits.js), plus unit tests for native Antigravity skills
// discovery (antigravity-skills.js).
//   node --no-warnings scripts/test-antigravity-skills-and-limits.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as providerUsageLimits from '../src/main/provider-usage-limits.js';
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

// --- Part 1: no Antigravity limits from Google --------------------------------
//
// Google exposes Antigravity's quota only through internal Cloud Code
// endpoints, and its terms call using Antigravity's OAuth from other software a
// breach. Durango must not read agy's sign-in or call those endpoints.

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

await check('provider-usage-limits exports no Antigravity reader', () => {
  const names = Object.keys(providerUsageLimits).filter((name) => /antigravity|keyring/i.test(name));
  assert.deepEqual(names, []);
});

await check('readProviderUsageLimits skips Antigravity without touching the network', async () => {
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    throw new Error('network disabled in this test');
  };
  try {
    const only = await providerUsageLimits.readProviderUsageLimits({ force: true, providers: ['antigravity'] });
    assert.deepEqual(only, {});
    assert.deepEqual(urls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

await check('no app source calls Google Cloud Code or reads agy\'s OAuth token', async () => {
  const banned = [
    [/cloudcode-pa|cloudcode\.googleapis|v1internal:/i, 'Google Cloud Code internal API'],
    [/antigravity\/hub/i, 'borrowed Antigravity User-Agent'],
    [/loadCodeAssist|retrieveUserQuotaSummary|fetchAvailableModels/, 'Cloud Code quota call'],
    [/['"]-s['"],\s*['"]gemini['"]|gemini:antigravity|['"]service['"],\s*['"]gemini['"]/, "agy's keyring item"],
  ];
  // provider-sign-in-watch.js only stats the token file (mtime + size) to
  // notice sign-in changes; it never opens it.
  const tokenFileAllowed = new Set([path.join('main', 'provider-sign-in-watch.js')]);
  const hits = [];
  const walk = async (dir) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!/\.(m?js|cjs|tsx?)$/.test(entry.name)) continue;
      const rel = path.relative(srcDir, full);
      const text = await fs.readFile(full, 'utf8');
      for (const [pattern, label] of banned) if (pattern.test(text)) hits.push(`${rel}: ${label}`);
      if (/antigravity-oauth-token/.test(text) && !tokenFileAllowed.has(rel)) hits.push(`${rel}: agy OAuth token file`);
    }
  };
  await walk(srcDir);
  assert.deepEqual(hits, []);
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
