import React from 'react';
import type { Project } from '../store';
import { ProjectIcon } from './ProjectIcon';

// A project's mark in sidebar v2 and the project picker: its own icon when
// the repository has one, else a two-letter monogram ("DO" for durango) in a
// colour derived from the name, so a project looks the same everywhere.
// Monogram and colour follow T3 Code's projectIdentity.ts (MIT, T3 Tools Inc.)
// so the same project gets the same mark in both apps.

// Order matters: it is what the name hash indexes into.
const MONOGRAM_COLOR_CLASSES = [
  'text-gray-400',
  'text-red-400',
  'text-orange-400',
  'text-amber-400',
  'text-yellow-400',
  'text-lime-400',
  'text-green-400',
  'text-emerald-400',
  'text-teal-400',
  'text-cyan-400',
  'text-sky-400',
  'text-blue-400',
  'text-indigo-400',
  'text-violet-400',
  'text-purple-400',
  'text-fuchsia-400',
  'text-pink-400',
  'text-rose-400',
];

const normalizeProjectName = (name: string) => name.normalize('NFKC').trim();

export const projectMonogram = (name: string) => {
  const words = normalizeProjectName(name).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return 'PR';
  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? 'P';
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? '')[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join('');
};

export const projectMonogramColorClass = (name: string) => {
  const seed = normalizeProjectName(name).toLocaleLowerCase('en-US') || 'project';
  let index = 0;
  for (const glyph of seed) index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % MONOGRAM_COLOR_CLASSES.length;
  return MONOGRAM_COLOR_CLASSES[index] ?? 'text-blue-400';
};

export const ProjectMonogram: React.FC<{ name: string; size?: number }> = ({ name, size = 16 }) => {
  const text = projectMonogram(name);
  return (
    <span aria-hidden className="inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 16 16"
        className={`h-full w-full select-none overflow-hidden rounded-[25%] font-mono ${projectMonogramColorClass(name)}`}
        style={{ backgroundColor: 'color-mix(in srgb, currentColor 14%, transparent)' }}
      >
        <text
          x="8"
          y="10.8"
          textAnchor="middle"
          fill="currentColor"
          fontSize="8.25"
          fontWeight="700"
          textLength={Array.from(text).length === 1 ? 6 : 12}
          lengthAdjust="spacingAndGlyphs"
          textRendering="geometricPrecision"
        >
          {text}
        </text>
      </svg>
    </span>
  );
};

export const ProjectBadge: React.FC<{ project: Pick<Project, 'name' | 'path'>; size?: number }> = ({
  project,
  size = 16,
}) => (
  <ProjectIcon
    projectPath={project.path}
    size={size}
    className="shrink-0 rounded-[25%] object-contain"
    fallback={<ProjectMonogram name={project.name} size={size} />}
  />
);
