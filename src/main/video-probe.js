// Reads a video's size and frame rate from its MP4/MOV boxes (no decoder, no
// ffmpeg): enough to tell an agent that a theme backdrop will decode more
// than it needs to. Returns null for anything it cannot read (WebM, fragmented
// MP4 without sample tables, truncated files).

const boxes = (buffer, start, end) => {
  const out = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < header || offset + size > end) break;
    out.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return out;
};

const child = (buffer, box, type) => boxes(buffer, box.start, box.end).find((candidate) => candidate.type === type) ?? null;

const handlerType = (buffer, mdia) => {
  const hdlr = child(buffer, mdia, 'hdlr');
  return hdlr && hdlr.end - hdlr.start >= 12 ? buffer.toString('latin1', hdlr.start + 8, hdlr.start + 12) : null;
};

const mdhdTimescale = (buffer, mdia) => {
  const mdhd = child(buffer, mdia, 'mdhd');
  if (!mdhd) return null;
  const version = buffer.readUInt8(mdhd.start);
  const at = mdhd.start + (version === 1 ? 20 : 12);
  return at + 4 <= mdhd.end ? buffer.readUInt32BE(at) : null;
};

/** Average frames per second from the sample-time table. */
const sttsFps = (buffer, stbl, timescale) => {
  const stts = child(buffer, stbl, 'stts');
  if (!stts || !timescale) return null;
  const count = buffer.readUInt32BE(stts.start + 4);
  let samples = 0;
  let ticks = 0;
  for (let index = 0; index < count; index += 1) {
    const at = stts.start + 8 + index * 8;
    if (at + 8 > stts.end) break;
    const sampleCount = buffer.readUInt32BE(at);
    samples += sampleCount;
    ticks += sampleCount * buffer.readUInt32BE(at + 4);
  }
  return samples > 0 && ticks > 0 ? (samples * timescale) / ticks : null;
};

const tkhdSize = (buffer, trak) => {
  const tkhd = child(buffer, trak, 'tkhd');
  if (!tkhd) return null;
  const version = buffer.readUInt8(tkhd.start);
  const at = tkhd.end - 8;
  if (at < tkhd.start + (version === 1 ? 88 : 76)) return null;
  return { width: Math.round(buffer.readUInt32BE(at) / 65536), height: Math.round(buffer.readUInt32BE(at + 4) / 65536) };
};

/** `{ width, height, fps }` of the first video track, or null. */
export const probeVideo = (buffer) => {
  try {
    if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
    const moov = boxes(buffer, 0, buffer.length).find((box) => box.type === 'moov');
    if (!moov) return null;
    for (const trak of boxes(buffer, moov.start, moov.end).filter((box) => box.type === 'trak')) {
      const mdia = child(buffer, trak, 'mdia');
      if (!mdia || handlerType(buffer, mdia) !== 'vide') continue;
      const size = tkhdSize(buffer, trak);
      const minf = child(buffer, mdia, 'minf');
      const stbl = minf ? child(buffer, minf, 'stbl') : null;
      const fps = stbl ? sttsFps(buffer, stbl, mdhdTimescale(buffer, mdia)) : null;
      if (!size?.width || !size?.height) return null;
      return { width: size.width, height: size.height, fps: fps ? Math.round(fps * 100) / 100 : null };
    }
    return null;
  } catch {
    return null;
  }
};

export const BACKDROP_VIDEO_MAX_PIXELS = 1920 * 1080;
export const BACKDROP_VIDEO_MAX_FPS = 30;

/**
 * A note for the agent when a backdrop video decodes more than a backdrop
 * needs (larger than 1080p or faster than 30 fps), or null.
 */
export const backdropVideoNote = (buffer) => {
  const info = probeVideo(buffer);
  if (!info) return null;
  const big = info.width * info.height > BACKDROP_VIDEO_MAX_PIXELS * 1.05;
  const fast = info.fps !== null && info.fps > BACKDROP_VIDEO_MAX_FPS + 0.5;
  if (!big && !fast) return null;
  const what = `${info.width}×${info.height}${info.fps ? ` at ${Math.round(info.fps)} fps` : ''}`;
  return `Performance: this video is ${what}. A backdrop decodes every frame behind the app the whole time it plays, so prefer at most 1920×1080 at 24–30 fps (re-encode it smaller, or generate one with generate_theme_media, which makes 720p).`;
};
