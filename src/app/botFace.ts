// A bot's face when it has no emoji of its own: a little robot drawn from a
// seed (the project's key for a project bot, else the bot's id), so the same
// bot looks the same everywhere. SVG markup, rendered as an image on the web
// and in Durango Code, and with SvgXml on iOS (copied there by
// chat/mobile/scripts/sync.ts). Durango Code keeps an identical copy
// (code/src/app/botFace.ts, this file there): change both together.

const COLORS: readonly [string, string][] = [
  ["#7c9cff", "#4a63c9"],
  ["#5fd1b5", "#2f9a80"],
  ["#ff9f6e", "#d06a3a"],
  ["#c58cff", "#8e55d6"],
  ["#ffd166", "#c99a2e"],
  ["#ff7aa8", "#cc4677"],
  ["#6ed3ff", "#2f9ccc"],
  ["#a3e36b", "#6aa63a"],
  ["#f2a6ff", "#b86ccc"],
  ["#ffb4a2", "#cc7f6e"],
];

const INK = "#141821";

function hashOf(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** The seed a bot's face is drawn from: its id (distinct per bot, even within the same project), else its project's key. */
export function botFaceSeed(bot: { id: string; project?: { key: string } | null }): string {
  return bot.id || bot.project?.key || "bot";
}

/** A robot face (viewBox 0 0 32 32) for `seed`. */
export function botFaceSvg(seed: string): string {
  const hash = hashOf(seed || "bot");
  const pick = (count: number, shift: number) => (hash >>> shift) % count;
  const [body, shade] = COLORS[pick(COLORS.length, 0)];
  // Squarish heads and always an antenna: robots, not smileys.
  const radius = [3, 4.5, 6][pick(3, 4)];
  const antenna = 1 + pick(3, 7);
  const eyes = pick(5, 10);
  const mouth = pick(4, 14);
  const ears = pick(2, 17) === 1;

  const parts: string[] = [];
  // Antenna.
  if (antenna === 1) {
    parts.push(`<rect x="15" y="3.5" width="2" height="6" rx="1" fill="${shade}"/>`, `<circle cx="16" cy="3.6" r="2.4" fill="${body}" stroke="${shade}" stroke-width="1.2"/>`);
  } else if (antenna === 2) {
    parts.push(
      `<rect x="10.2" y="4.5" width="1.8" height="5.5" rx="0.9" fill="${shade}" transform="rotate(-18 11 9)"/>`,
      `<rect x="20" y="4.5" width="1.8" height="5.5" rx="0.9" fill="${shade}" transform="rotate(18 21 9)"/>`,
      `<circle cx="9.6" cy="4.6" r="1.7" fill="${body}"/>`,
      `<circle cx="22.4" cy="4.6" r="1.7" fill="${body}"/>`,
    );
  } else if (antenna === 3) {
    parts.push(`<path d="M17.2 2.5 L13.8 6.4 H16.4 L14.8 9.6 L18.6 5.6 H16 Z" fill="${body}" stroke="${shade}" stroke-width="0.8" stroke-linejoin="round"/>`);
  }
  // Ears.
  if (ears) {
    parts.push(`<rect x="3" y="14" width="3.5" height="7" rx="1.5" fill="${shade}"/>`, `<rect x="25.5" y="14" width="3.5" height="7" rx="1.5" fill="${shade}"/>`);
  }
  // Head and face plate.
  parts.push(
    `<rect x="5.5" y="9" width="21" height="18.5" rx="${radius}" fill="${body}"/>`,
    `<rect x="8.5" y="12" width="15" height="12.5" rx="${Math.max(2, radius - 2.5)}" fill="#ffffff" fill-opacity="0.22"/>`,
  );
  // Eyes.
  if (eyes === 0) {
    parts.push(`<circle cx="12.6" cy="16.6" r="2.4" fill="#fff"/>`, `<circle cx="19.4" cy="16.6" r="2.4" fill="#fff"/>`, `<circle cx="13" cy="16.9" r="1.15" fill="${INK}"/>`, `<circle cx="19.8" cy="16.9" r="1.15" fill="${INK}"/>`);
  } else if (eyes === 1) {
    parts.push(`<rect x="9.8" y="14.6" width="12.4" height="4.2" rx="2.1" fill="${INK}"/>`, `<rect x="11.2" y="15.6" width="3.6" height="2.2" rx="1.1" fill="#7df9ff"/>`, `<rect x="17.2" y="15.6" width="3.6" height="2.2" rx="1.1" fill="#7df9ff"/>`);
  } else if (eyes === 2) {
    parts.push(`<circle cx="16" cy="16.6" r="3.6" fill="#fff"/>`, `<circle cx="16.5" cy="16.9" r="1.8" fill="${INK}"/>`, `<circle cx="17.1" cy="16.2" r="0.6" fill="#fff"/>`);
  } else if (eyes === 3) {
    parts.push(`<rect x="10.4" y="14.6" width="4.2" height="4.2" rx="1" fill="#fff"/>`, `<rect x="17.4" y="14.6" width="4.2" height="4.2" rx="1" fill="#fff"/>`, `<rect x="11.8" y="16" width="1.6" height="1.6" fill="${INK}"/>`, `<rect x="18.8" y="16" width="1.6" height="1.6" fill="${INK}"/>`);
  } else {
    parts.push(`<path d="M10.6 17.4 Q12.6 14.8 14.6 17.4" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`, `<path d="M17.4 17.4 Q19.4 14.8 21.4 17.4" stroke="${INK}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`);
  }
  // Mouth.
  if (mouth === 0) {
    parts.push(`<path d="M12.6 21.2 Q16 23.8 19.4 21.2" stroke="${INK}" stroke-width="1.5" fill="none" stroke-linecap="round"/>`);
  } else if (mouth === 1) {
    parts.push(`<rect x="11.6" y="20.6" width="8.8" height="2.6" rx="0.8" fill="${INK}" fill-opacity="0.85"/>`, `<rect x="14" y="20.6" width="0.9" height="2.6" fill="${body}"/>`, `<rect x="17.1" y="20.6" width="0.9" height="2.6" fill="${body}"/>`);
  } else if (mouth === 2) {
    parts.push(`<rect x="12.8" y="21.2" width="6.4" height="1.5" rx="0.75" fill="${INK}"/>`);
  } else {
    parts.push(`<circle cx="16" cy="21.8" r="1.3" fill="${INK}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${parts.join("")}</svg>`;
}

/** The face as an image URL (web and Durango Code). */
export function botFaceDataUrl(seed: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(botFaceSvg(seed))}`;
}
