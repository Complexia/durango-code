// Types for ui-themes.js (shared by the renderer and main's theme store).

export type ThemeBackdrop = {
  type: 'css' | 'image' | 'video' | 'html';
  css?: string;
  html?: string;
  asset?: string;
  poster?: string;
  position?: string;
  fit?: 'cover' | 'contain';
  dim?: number;
  blur?: number;
  saturate?: number;
};

export type UiTheme = {
  id: string;
  version: number;
  name: string;
  description?: string;
  appearance: 'dark' | 'light';
  tokens: Record<string, string>;
  builtIn?: boolean;
  saved: boolean;
  threadId?: string;
  createdAt?: string;
  updatedAt?: string;
  revision: number;
  surfaceOpacity?: number;
  /** Opacity of the main reading area (bg-base) over a backdrop; defaults to surfaceOpacity. */
  baseOpacity?: number;
  panelBlur?: number;
  backdrop?: ThemeBackdrop;
  overlay?: { html: string };
  css?: string;
};

export type ThemeSnapshot = {
  activeId: string | null;
  /** Folder that holds each theme's files: `<dir>/<id>/<asset>`. */
  dir: string;
  themes: UiTheme[];
};

export type ThemeSummary = {
  id: string;
  name: string;
  revision: number;
  swatches: string[];
  backdrop: ThemeBackdrop['type'] | null;
  overlay: boolean;
};

export declare const STOCK_THEME_ID: 'stock';
export declare const THEME_FORMAT_VERSION: number;
export declare const THEME_LIMITS: Readonly<{ name: number; description: number; css: number; html: number; tokenValue: number }>;
export declare const THEME_TOKENS: Readonly<Record<string, { stock: string; kind: 'color' | 'background' | 'font' | 'length'; label: string }>>;
export declare const THEME_TOKEN_NAMES: readonly string[];
export declare const BACKDROP_TYPES: readonly ThemeBackdrop['type'][];
export declare const THEME_APPEARANCES: readonly ('dark' | 'light')[];
export declare const THEME_SCENE_EVENTS: Readonly<Record<string, string>>;
export declare const DEFAULT_SURFACE_OPACITY: number;
export declare const THEME_SCENE_SOURCE: string;
export declare const THEME_SCENE_CSP: string;
export declare const THEME_SCENE_BOOTSTRAP: string;

export declare function sanitizeTokenValue(value: unknown): string | null;
export declare function sanitizeThemeCss(css: unknown): string;
export declare function isThemeAssetName(name: unknown): boolean;
export declare function isVideoAsset(name: string | undefined | null): boolean;
export declare function sanitizeBackdrop(input: unknown): ThemeBackdrop | null;
export declare function isThemeId(id: unknown): boolean;
export declare function sanitizeTheme(input: unknown): UiTheme | null;
export declare function themeToCss(theme: UiTheme | null, options?: { assetUrl?: (name: string) => string }): string;
export declare function mergeTheme(
  base: Partial<UiTheme> | null,
  patch: Record<string, unknown>,
  options?: { id?: string; now?: string; threadId?: string }
): { theme: UiTheme | null; ignored: string[] };
export declare function themeSummary(theme: UiTheme | null): ThemeSummary | null;
export declare function normalizeSceneHtml(html: string): string;
export declare function buildSceneDocument(html: string): string;
export declare function parseSceneMessage(data: unknown): { type: 'ready' } | { type: 'error'; message: string } | null;
