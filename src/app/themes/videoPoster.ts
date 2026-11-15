import { useEffect } from 'react';
import type { UiTheme } from '../../ui-themes.js';

/**
 * Gives a video backdrop that has no poster one: its frame at 0.1 s, at most
 * 1920 px wide, saved next to it (themes:savePoster). Then "still" (animation
 * off, reduced motion) shows that image instead of a paused video that keeps
 * a decoder open. Once per theme and video per session; main refuses if the
 * backdrop changed or got a poster meanwhile.
 */
const POSTER_MAX_WIDTH = 1920;
const CAPTURE_TIMEOUT_MS = 20_000;
const attempted = new Set<string>();

const frameToJpeg = (video: HTMLVideoElement) =>
  new Promise<Uint8Array | null>((resolve) => {
    const scale = Math.min(1, POSTER_MAX_WIDTH / Math.max(1, video.videoWidth));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return resolve(null);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return resolve(null);
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), () => resolve(null));
      },
      'image/jpeg',
      0.86
    );
  });

const capturePoster = async (theme: UiTheme, asset: string) => {
  const themes = window.orion?.themes;
  if (!themes?.videoForPoster || !themes.savePoster) return;
  const source = await themes.videoForPoster(theme.id, asset);
  if (!source.ok || !source.value) return;
  const url = URL.createObjectURL(new Blob([source.value]));
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    const frame = await new Promise<Uint8Array | null>((resolve) => {
      const timer = window.setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS);
      const finish = (value: Uint8Array | null) => {
        window.clearTimeout(timer);
        resolve(value);
      };
      video.addEventListener('error', () => finish(null), { once: true });
      video.addEventListener(
        'loadeddata',
        () => {
          video.addEventListener('seeked', () => void frameToJpeg(video).then(finish), { once: true });
          video.currentTime = Math.min(0.1, (video.duration || 0.2) / 2);
        },
        { once: true }
      );
      video.src = url;
    });
    if (frame) await themes.savePoster(theme.id, asset, frame);
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
};

export const useVideoPoster = (theme: UiTheme) => {
  const backdrop = theme.backdrop;
  const asset = backdrop?.type === 'video' && !backdrop.poster && !theme.builtIn ? backdrop.asset : undefined;
  useEffect(() => {
    if (!asset) return;
    const key = `${theme.id}:${asset}`;
    if (attempted.has(key)) return;
    // After the backdrop itself has started, off the critical path.
    const timer = window.setTimeout(() => {
      attempted.add(key);
      void capturePoster(theme, asset).catch(() => {});
    }, 1500);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [theme.id, asset]);
};
