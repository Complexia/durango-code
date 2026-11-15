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
  /** Other looks picked by the theme's values; each is a whole backdrop. */
  variants?: Array<Omit<ThemeBackdrop, 'variants'> & { when: Record<string, ThemeValue> }>;
};

export type ThemeValue = boolean | number | string;

export type ThemeLook = { icon?: string; svg?: string; label?: string };
export type ThemeOption = ThemeLook & { value: string };

export type ThemeValueSpec =
  | { type: 'boolean'; label?: string; default: boolean }
  | { type: 'number'; label?: string; min: number; max: number; step?: number; default: number }
  | { type: 'choice'; label?: string; options: ThemeOption[]; default: string };

export type ThemeSlotName =
  | 'titlebar-left'
  | 'titlebar-center'
  | 'titlebar-right'
  | 'sidebar-top'
  | 'sidebar-bottom'
  | 'composer-toolbar'
  | 'composer-top'
  | 'thread-header';

export type ThemeControlPlacement = {
  slot?: ThemeSlotName;
  selector?: string;
  position: 'start' | 'end' | 'before' | 'after' | 'float';
  corner?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  x?: number;
  y?: number;
  all?: boolean;
  order?: number;
};

export type ThemeControl = ThemeLook & {
  id: string;
  kind: 'toggle' | 'choice' | 'slider' | 'menu' | 'button' | 'html';
  placement: ThemeControlPlacement;
  tooltip?: string;
  showLabel?: boolean;
  value?: string;
  on?: ThemeLook;
  off?: ThemeLook;
  style?: 'cycle' | 'segmented';
  width?: number;
  height?: number;
  action?: string;
  set?: Record<string, ThemeValue>;
  html?: string;
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
  values?: Record<string, ThemeValueSpec>;
  controls?: ThemeControl[];
  css?: string;
};

export type ThemeSnapshot = {
  activeId: string | null;
  /** Animated backdrops and effects on (false = still frames, no overlays). */
  animate?: boolean;
  /** Folder that holds each theme's files: `<dir>/<id>/<asset>`. */
  dir: string;
  themes: UiTheme[];
  /** Each theme's current values (the user's choice, else the default), by theme id. */
  values?: Record<string, Record<string, ThemeValue>>;
};

export type ThemeSummary = {
  id: string;
  name: string;
  revision: number;
  swatches: string[];
  backdrop: ThemeBackdrop['type'] | null;
  overlay: boolean;
  controls?: number;
};

export declare const STOCK_THEME_ID: 'stock';
export declare const THEME_FORMAT_VERSION: number;
export declare const THEME_LIMITS: Readonly<{
  name: number;
  description: number;
  css: number;
  html: number;
  tokenValue: number;
  values: number;
  controls: number;
  variants: number;
  options: number;
  svg: number;
  selector: number;
}>;
export declare const THEME_SLOTS: Readonly<Record<ThemeSlotName, string>>;
export declare const THEME_CONTROL_KINDS: readonly ThemeControl['kind'][];
export declare const THEME_VALUE_TYPES: readonly ThemeValueSpec['type'][];
export declare const THEME_UI_MAP_SCRIPT: string;
export declare function isValueName(name: unknown): boolean;
export declare function valueSpecIn(values: Record<string, ThemeValueSpec> | undefined, name: unknown): ThemeValueSpec | undefined;
export declare function themeValueSpec(theme: UiTheme | null | undefined, name: unknown): ThemeValueSpec | undefined;
export declare function effectiveBackdrop(backdrop: ThemeBackdrop | null | undefined, values: Record<string, ThemeValue> | undefined): ThemeBackdrop | null;
export declare function coerceThemeValue(spec: ThemeValueSpec | undefined, value: unknown): ThemeValue | undefined;
export declare function resolveThemeValues(theme: UiTheme | null | undefined, stored: Record<string, unknown> | undefined): Record<string, ThemeValue>;
export declare function checkThemeValuePatch(theme: UiTheme | null | undefined, patch: unknown): { values: Record<string, ThemeValue>; ignored: string[] };
export declare function sanitizeValueSpec(input: unknown): ThemeValueSpec | null;
export declare function sanitizeControl(input: unknown, values?: Record<string, ThemeValueSpec>): ThemeControl | null;
export declare function themeValuesCss(values: Record<string, ThemeValue> | undefined): string;
export declare function themeValueAttribute(value: ThemeValue): string;
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
export declare function parseSceneMessage(
  data: unknown
):
  | { type: 'ready' }
  | { type: 'error'; message: string }
  | { type: 'set'; name: string; value: ThemeValue }
  | { type: 'action'; name: string; detail: unknown }
  | { type: 'resize'; width: number; height: number }
  | null;
