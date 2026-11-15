import React, { useMemo, useState } from 'react';
import { THEME_TOKENS, buildSceneDocument, type UiTheme } from '../../ui-themes.js';
import { themeAssetUrl, useThemeState } from './themeState';

/**
 * A miniature of the app in a theme's colors (title bar, sidebar, thread,
 * composer) over its backdrop: Settings' gallery cards and the transcript's
 * theme cards. An HTML scene plays live only while hovered, so a gallery of
 * animated themes costs nothing at rest. `theme = null` is Stock.
 */

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

const token = (theme: UiTheme | null, name: string) => theme?.tokens[name] ?? THEME_TOKENS[name].stock;

const seeThrough = (theme: UiTheme | null, name: string, extra = 0) => {
  if (!theme?.backdrop) return token(theme, name);
  const opacity = Math.min(1, (theme.surfaceOpacity ?? 0.72) + extra);
  return `color-mix(in srgb, ${token(theme, name)} ${Math.round(opacity * 100)}%, transparent)`;
};

export const ThemePreview: React.FC<{ theme: UiTheme | null; className?: string; live?: boolean }> = ({
  theme,
  className = '',
  live = false,
}) => {
  const snapshot = useThemeState((state) => state.snapshot);
  // Previews play only when the user lets themes animate at all.
  const animate = useThemeState((state) => state.animate) && !prefersReducedMotion();
  const [hovered, setHovered] = useState(false);
  const backdrop = theme?.backdrop;
  const sceneDoc = useMemo(
    () => (backdrop?.type === 'html' && backdrop.html ? buildSceneDocument(backdrop.html) : null),
    [backdrop]
  );
  const accent = token(theme, 'accent');
  const violet = token(theme, 'agent-violet');
  const base = token(theme, 'bg-base');
  const text = token(theme, 'text-primary');
  const muted = token(theme, 'text-muted');
  const radius = token(theme, 'radius-md');
  // A still stand-in for a scene: the palette's glow.
  const sceneStill = `radial-gradient(120% 90% at 20% 110%, color-mix(in srgb, ${accent} 45%, transparent), transparent 60%), radial-gradient(90% 80% at 90% -10%, color-mix(in srgb, ${violet} 40%, transparent), transparent 60%), ${base}`;
  const playing = animate && (live || hovered);
  const showScene = Boolean(sceneDoc && playing);

  let backdropLayer: React.ReactNode = null;
  if (backdrop?.type === 'image' && backdrop.asset && theme) {
    backdropLayer = <img src={themeAssetUrl(snapshot, theme, backdrop.asset)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />;
  } else if (backdrop?.type === 'video' && backdrop.asset && theme) {
    backdropLayer = backdrop.poster ? (
      <img src={themeAssetUrl(snapshot, theme, backdrop.poster)} alt="" draggable={false} className="absolute inset-0 h-full w-full object-cover" />
    ) : (
      <video
        src={`${themeAssetUrl(snapshot, theme, backdrop.asset)}${playing ? '' : '#t=0.5'}`}
        muted
        loop
        playsInline
        autoPlay={playing}
        preload="metadata"
        className="absolute inset-0 h-full w-full object-cover"
      />
    );
  } else if (backdrop?.type === 'css' && backdrop.css) {
    backdropLayer = <div className="absolute inset-0" style={{ background: backdrop.css }} />;
  } else if (sceneDoc) {
    backdropLayer = showScene ? (
      <iframe
        title=""
        aria-hidden="true"
        tabIndex={-1}
        sandbox="allow-scripts"
        srcDoc={sceneDoc}
        className="pointer-events-none absolute inset-0 h-full w-full border-0"
      />
    ) : (
      <div className="absolute inset-0" style={{ background: sceneStill }} />
    );
  }

  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ background: base, fontFamily: token(theme, 'font-ui') }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      aria-hidden="true"
    >
      {backdropLayer}
      {backdrop?.dim ? <div className="absolute inset-0 bg-black" style={{ opacity: backdrop.dim }} /> : null}
      <div className="absolute inset-0 flex flex-col">
        <div className="h-[11%] shrink-0" style={{ background: theme?.tokens['shell-bg'] ?? seeThrough(theme, 'bg-raised') }} />
        <div className="flex min-h-0 flex-1">
          <div
            className="flex w-[28%] shrink-0 flex-col gap-[6%] px-[4%] pt-[6%]"
            style={{ background: seeThrough(theme, 'bg-raised'), borderRight: `1px solid ${token(theme, 'border-default')}` }}
          >
            <div className="h-[6%] min-h-[3px] w-[80%] rounded-full" style={{ background: accent, opacity: 0.85 }} />
            {[70, 55, 62, 48].map((width) => (
              <div key={width} className="h-[4%] min-h-[2px] rounded-full" style={{ width: `${width}%`, background: muted, opacity: 0.55 }} />
            ))}
          </div>
          <div className="relative flex min-w-0 flex-1 flex-col justify-end gap-[5%] px-[7%] pb-[6%]">
            <div
              className="ml-auto h-[12%] w-[48%]"
              style={{ background: seeThrough(theme, 'bg-surface', 0.12), borderRadius: radius }}
            />
            <div className="flex flex-col gap-[6px]">
              {[88, 72, 80].map((width) => (
                <div key={width} className="h-[3px] rounded-full" style={{ width: `${width}%`, background: text, opacity: 0.7 }} />
              ))}
            </div>
            <div
              className="h-[16%] w-full"
              style={{
                background: seeThrough(theme, 'bg-raised'),
                border: `1px solid ${token(theme, 'border-strong')}`,
                borderRadius: token(theme, 'radius-lg'),
              }}
            >
              <div className="ml-auto mr-[3%] mt-[3%] aspect-square h-[45%] rounded-full" style={{ background: accent }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ThemePreview;
