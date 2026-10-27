// What changed in a Durango Code release: the subjects of the commits under
// this directory since the previous release tag, or the lines of a file passed
// with --notes-file. deploy.mjs bakes them into the build (the app's "What's
// new" notice and Settings) and into the release manifest, which code.durango.sh
// serves as `releaseNotes` in the update feed (the update button's hover card).

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { isPrereleaseVersion, releaseTag } from './release-manifest.mjs';

// The feed sends every note to every client checking for updates; a release
// with more changes than this lists the newest ones.
export const maxReleaseNotes = 40;

// Commits that only move the version number say nothing to users.
const ignoredSubject = /^(?:bump\b.*\bversion\b|release\b|v?\d+\.\d+\.\d+\S*$)/i;

// One note per line; Markdown bullets, headings and blank lines are dropped.
export const parseReleaseNotes = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);

export const releaseNotesFromSubjects = (subjects) => {
  const notes = [];
  for (const subject of subjects) {
    const note = subject.trim();
    if (!note || ignoredSubject.test(note) || notes.includes(note)) continue;
    notes.push(note);
  }
  return notes.slice(0, maxReleaseNotes);
};

function capture(cwd, commandArgs) {
  const result = spawnSync('git', commandArgs, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return result.status === 0 ? result.stdout.trim() : null;
}

// The newest earlier release reachable from HEAD. Tags are v<version> (the
// public repo and releases since the monorepo) or code/v<version> (imported
// with the old repo's history). A stable release lists everything since the
// previous stable one, which is the version its users are updating from.
export function previousReleaseTag(rootDir, version) {
  const args = ['describe', '--tags', '--abbrev=0', '--match', 'v*', '--match', 'code/v*'];
  for (const tag of [releaseTag(version), `code/${releaseTag(version)}`]) args.push('--exclude', tag);
  if (!isPrereleaseVersion(version)) args.push('--exclude', '*-*');
  return capture(rootDir, [...args, 'HEAD']);
}

export async function collectReleaseNotes({ rootDir, version, notesFile }) {
  if (notesFile) return parseReleaseNotes(await fs.readFile(notesFile, 'utf8')).slice(0, maxReleaseNotes);
  const previous = previousReleaseTag(rootDir, version);
  // A shallow clone has no earlier tag to compare against; ship without notes
  // rather than listing the whole history.
  if (!previous) return [];
  const log = capture(rootDir, ['log', '--no-merges', '--format=%s', `${previous}..HEAD`, '--', '.']);
  return log ? releaseNotesFromSubjects(log.split('\n')) : [];
}
