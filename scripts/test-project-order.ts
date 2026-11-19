import assert from 'node:assert/strict';
import { sortProjectsByLatestThreadStart } from '../src/app/projectOrder';

const project = (id: string, name = id) => ({ id, name, path: `/tmp/${id}` });
const thread = (projectId: string, createdAt: string) => ({ projectId, createdAt });
const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);

// Store order is newest added first (addProject prepends).
const projects = [project('empty-new'), project('a'), project('b'), project('empty-old'), project('c')];

// Newest thread start wins; last activity doesn't matter, only createdAt.
const threads = [
  thread('a', '2026-11-01T00:00:00Z'),
  thread('a', '2026-11-10T00:00:00Z'),
  thread('b', '2026-11-05T00:00:00Z'),
  thread('c', '2026-11-08T00:00:00Z'),
  thread('gone', '2026-11-30T00:00:00Z'), // a removed project's thread
  thread('b', 'not a date'),
];
assert.deepEqual(ids(sortProjectsByLatestThreadStart(projects, threads)), ['a', 'c', 'b', 'empty-new', 'empty-old']);

// Starting a thread moves its project to the top.
assert.deepEqual(
  ids(sortProjectsByLatestThreadStart(projects, [...threads, thread('b', '2026-11-19T00:00:00Z')])),
  ['b', 'a', 'c', 'empty-new', 'empty-old']
);

// Equal start times break by name, then store order; the input isn't mutated.
const tied = [project('z', 'Zeta'), project('y', 'Alpha'), project('x', 'Alpha')];
const same = '2026-11-19T00:00:00Z';
const before = ids(tied);
assert.deepEqual(ids(sortProjectsByLatestThreadStart(tied, tied.map((entry) => thread(entry.id, same)))), ['y', 'x', 'z']);
assert.deepEqual(ids(tied), before);

// No threads at all: store order.
assert.deepEqual(ids(sortProjectsByLatestThreadStart(projects, [])), ids(projects));

console.log('project order: ok');
