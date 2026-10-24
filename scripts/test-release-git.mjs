import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertReleaseSourceCommitted, ciWorkflowUrl, pushReleaseTag } from './release-git.mjs';

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
};
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-release-git-'));
const remote = path.join(root, 'remote.git');
const work = path.join(root, 'work');
const log = console.log;
try {
  console.log = () => {};
  git(root, 'init', '-q', '--bare', remote);
  git(root, 'init', '-q', work);
  git(work, 'config', 'user.email', 'test@example.com');
  git(work, 'config', 'user.name', 'Test');
  git(work, 'remote', 'add', 'origin', remote);
  writeJson(path.join(work, 'package.json'), { name: 'orion', version: '1.0.0', dependencies: { a: '1' } });
  writeJson(path.join(work, 'package-lock.json'), { name: 'orion', version: '1.0.0', packages: { '': { version: '1.0.0' } } });
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'init');

  // A clean tree, and one where only the version was bumped, may release.
  assertReleaseSourceCommitted(work);
  writeJson(path.join(work, 'package.json'), { name: 'orion', version: '1.0.1', dependencies: { a: '1' } });
  writeJson(path.join(work, 'package-lock.json'), { name: 'orion', version: '1.0.1', packages: { '': { version: '1.0.1' } } });
  assertReleaseSourceCommitted(work);

  // Anything else would ship on macOS only.
  writeJson(path.join(work, 'package.json'), { name: 'orion', version: '1.0.1', dependencies: { a: '2' } });
  assert.throws(() => assertReleaseSourceCommitted(work), /M package\.json/);
  writeJson(path.join(work, 'package.json'), { name: 'orion', version: '1.0.1', dependencies: { a: '1' } });
  fs.writeFileSync(path.join(work, 'new.js'), '');
  assert.throws(() => assertReleaseSourceCommitted(work), /\?\? new\.js/);
  fs.rmSync(path.join(work, 'new.js'));
  assertReleaseSourceCommitted(work);

  // The tag is created at HEAD and pushed once.
  const head = git(work, 'rev-parse', 'HEAD');
  assert.deepEqual(pushReleaseTag(work, '1.0.1'), { tag: 'v1.0.1', pushed: true });
  assert.equal(git(remote, 'rev-parse', 'v1.0.1^{commit}'), head);
  assert.deepEqual(pushReleaseTag(work, '1.0.1'), { tag: 'v1.0.1', pushed: false });

  // The same version from a different commit is refused.
  git(work, 'commit', '-q', '--allow-empty', '-m', 'next');
  assert.throws(() => pushReleaseTag(work, '1.0.1'), /already points at/);
  git(work, 'tag', '-d', 'v1.0.1');
  assert.throws(() => pushReleaseTag(work, '1.0.1'), /on origin points at/);

  git(work, 'remote', 'set-url', 'origin', 'https://github.com/Complexia/durango-code.git');
  assert.equal(ciWorkflowUrl(work), 'https://github.com/Complexia/durango-code/actions/workflows/release.yml');
} finally {
  console.log = log;
  fs.rmSync(root, { recursive: true, force: true });
}

console.log('release git tests passed');
