/**
 * Inline HTML visuals (show_html, src/main/visual-tools.js): pure helpers for
 * the frame (HtmlVisual.tsx) and tests. No DOM access here. Same model as
 * durango.sh chat's sandboxed artifacts.
 *
 * Security (the transcript renders `<iframe sandbox="allow-scripts" srcDoc=…>`):
 * - The sandbox gives the page an opaque origin: no access to the app's DOM,
 *   preload API, cookies or storage; no popups, forms, downloads or top-level
 *   navigation. Electron's preload never runs in sub-frames.
 * - `buildVisualDocument` puts a strict CSP `<meta>` first in `<head>`, before
 *   any agent-authored byte: no network at all (scripts, styles, images,
 *   fonts, fetch, frames).
 * - The agent's HTML is normalized into our document: doctype and html/head
 *   wrappers dropped, and tags that act without script (meta refresh /
 *   http-equiv, base, link) stripped. Defense in depth only; the CSP and the
 *   sandbox are the boundary.
 * - The page cannot navigate: the main process refuses any navigation of an
 *   about:srcdoc sub-frame before its request starts (main.js,
 *   shouldBlockVisualFrameNavigation), since the CSP does not cover it.
 * - http(s) links are not followed in the frame: the bootstrap asks the parent,
 *   which offers to open them in the user's browser only on a click in the app
 *   (page script can send that ask without any click).
 */

export const VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
].join('; ');

export const VISUAL_SANDBOX = 'allow-scripts';
export const VISUAL_MESSAGE_SOURCE = 'durango-visual';

export const VISUAL_AUTO_INITIAL_HEIGHT = 240;
export const VISUAL_MIN_HEIGHT = 80;
export const VISUAL_MAX_HEIGHT = 1600;
/** A content-fitted frame never exceeds this share of the window. */
export const VISUAL_MAX_VIEWPORT_SHARE = 0.85;
export const MAX_VISUAL_ERROR_CHARS = 300;

/**
 * Theme variables a page can use (same names as durango.sh chat), and the
 * Durango Code variable each one reads (src/index.css). Durango Code is
 * dark-only; values are read from the live stylesheet so they follow it.
 */
export const VISUAL_THEME_SOURCES: Readonly<Record<string, string>> = {
  '--background': '--bg-base',
  '--foreground': '--text-primary',
  '--muted': '--bg-elevated',
  '--muted-foreground': '--text-secondary',
  '--card': '--bg-surface',
  '--card-foreground': '--text-primary',
  '--border': '--border-default',
  '--primary': '--accent',
  '--accent': '--bg-hover',
  '--ring': '--accent-glow',
  '--success': '--success',
  '--warning': '--warning',
  '--danger': '--danger',
  '--radius': '--radius-md',
};

/** Fixed theme values: the chart palette (durango.sh chat's dark `--viz-*`). */
export const VISUAL_THEME_CONSTANTS: Readonly<Record<string, string>> = {
  '--viz-1': '#3987e5',
  '--viz-2': '#d95926',
  '--viz-3': '#199e70',
  '--viz-4': '#c98500',
  '--viz-5': '#d55181',
  '--viz-6': '#008300',
  '--viz-7': '#9085e9',
  '--viz-8': '#e66767',
  '--viz-grid': 'rgba(255, 255, 255, 0.06)',
  '--viz-axis': '#a0a0a8',
};

/** Fallbacks if a source variable is missing from the stylesheet. */
const THEME_FALLBACKS: Readonly<Record<string, string>> = {
  '--background': '#101012',
  '--foreground': '#ececef',
  '--muted': '#26262b',
  '--muted-foreground': '#a0a0a8',
  '--card': '#1d1d21',
  '--card-foreground': '#ececef',
  '--border': 'rgb(255 255 255 / 8%)',
  '--primary': '#4d8dff',
  '--accent': '#303036',
  '--ring': 'rgb(77 141 255 / 28%)',
  '--success': '#34d399',
  '--warning': '#f4a261',
  '--danger': '#f87171',
  '--radius': '10px',
};

const VAR_NAME_PATTERN = /^--[a-z][a-z0-9-]{0,40}$/;
// Colors, lengths and simple functions only: no quotes, semicolons, braces or
// angle brackets, so a value can never escape its declaration or <style>.
const VAR_VALUE_PATTERN = /^[#a-zA-Z0-9\s(),.%/+-]{1,80}$/;

/** Keep only well-formed custom properties with inert values. */
export function sanitizeThemeVars(vars: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) return out;
  for (const [name, raw] of Object.entries(vars as Record<string, unknown>)) {
    if (!VAR_NAME_PATTERN.test(name) || typeof raw !== 'string') continue;
    const value = raw.trim();
    if (VAR_VALUE_PATTERN.test(value)) out[name] = value;
  }
  return out;
}

/** The page's theme from a variable reader (getComputedStyle in the app). */
export function resolveVisualTheme(read: (name: string) => string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [name, source] of Object.entries(VISUAL_THEME_SOURCES)) {
    vars[name] = read(source).trim() || THEME_FALLBACKS[name];
  }
  return sanitizeThemeVars({ ...vars, ...VISUAL_THEME_CONSTANTS });
}

// --- agent HTML normalization ------------------------------------------------

// A start/end tag with quoted attribute values (which may contain ">").
const tagPattern = (names: string) => new RegExp(`<\\/?(?:${names})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
const DOCTYPE_PATTERN = /<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const WRAPPER_TAGS = tagPattern('html|head');
const META_TAGS = tagPattern('meta');
const BASE_LINK_TAGS = tagPattern('base|link');

/** The agent's HTML as body content of our document. */
export function normalizeVisualHtml(html: string): string {
  return html
    .replace(/^﻿/, '')
    .replace(DOCTYPE_PATTERN, '')
    .replace(WRAPPER_TAGS, '')
    .replace(META_TAGS, (tag) => (/http-equiv/i.test(tag) ? '' : tag))
    .replace(BASE_LINK_TAGS, '')
    .trim();
}

// --- bootstrap ---------------------------------------------------------------

/**
 * Runs before any page code. Messages (all carry `source`):
 * frame -> parent: `resize {height}`, `error {message}`, `escape`,
 * `link {href}` (an http(s) link the user clicked).
 * Only the parent may message the frame; nothing is accepted from it today.
 * Uncaught errors are reported and suppressed.
 */
export const VISUAL_BOOTSTRAP = `(function(){
"use strict";
var S=${JSON.stringify(VISUAL_MESSAGE_SOURCE)},P=window.parent,sent=0,seen={};
function post(m){try{m.source=S;P.postMessage(m,"*");}catch(e){}}
function report(text){text=String(text||"Script error").slice(0,${MAX_VISUAL_ERROR_CHARS});if(seen[text]||sent>=8)return;seen[text]=1;sent++;post({type:"error",message:text});}
["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel"].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false});}catch(e){}});
window.addEventListener("error",function(e){if(!(e instanceof ErrorEvent))return;report(e.message||"Script error");e.preventDefault();});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;report("Unhandled promise rejection: "+(r&&r.message?r.message:String(r)));e.preventDefault();});
document.addEventListener("securitypolicyviolation",function(e){var u=e.blockedURI||"";report("Blocked by sandbox: "+(e.effectiveDirective||e.violatedDirective||"policy")+(u&&u!=="inline"&&u!=="eval"?" "+u.slice(0,120):""));});
window.addEventListener("keydown",function(e){if(e.key!=="Escape"||e.isComposing)return;setTimeout(function(){if(!e.defaultPrevented)post({type:"escape"});},0);});
document.addEventListener("click",function(e){var t=e.target,a=t&&t.closest?t.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)==="#")return;e.preventDefault();if(/^https?:\\/\\//i.test(h))post({type:"link",href:h.slice(0,2048)});},true);
var last=-1,queued=false;
function measure(){queued=false;var b=document.body,R=document.documentElement;if(!b)return;var rs=getComputedStyle(R),bs=getComputedStyle(b),pad=parseFloat(rs.paddingTop||"0")+parseFloat(rs.paddingBottom||"0");
var h=Math.ceil(Math.max(R.getBoundingClientRect().height,b.getBoundingClientRect().height+parseFloat(bs.marginTop||"0")+parseFloat(bs.marginBottom||"0")+pad,b.scrollHeight+pad));
if(h>0&&Math.abs(h-last)>1){last=h;post({type:"resize",height:h});}}
function schedule(){if(!queued){queued=true;requestAnimationFrame(measure);}}
function start(){schedule();if(typeof ResizeObserver==="function"){var ro=new ResizeObserver(schedule);ro.observe(document.documentElement);if(document.body)ro.observe(document.body);}window.addEventListener("load",schedule);}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start();
})();`;

// No page background: the visual sits on the thread. 8px gutter so focus
// rings and shadows at the edges are not clipped.
const BASE_STYLE = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:dark;--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px}
body{margin:0;background:transparent;color:var(--foreground);font:14px/1.55 var(--font-sans);overflow-wrap:break-word}
img,svg,canvas,video{max-width:100%}
a{color:var(--primary)}
button,input,select,textarea{font:inherit;color:inherit}`;

/**
 * Full srcdoc for a visual. The CSP meta is the first element of <head>;
 * then our head (charset, referrer off, base styles with the theme,
 * bootstrap), then the agent's normalized HTML as body.
 */
export function buildVisualDocument(html: string, themeVars: Record<string, string> = {}): string {
  const vars = sanitizeThemeVars(themeVars);
  const declarations = Object.entries(vars).map(([name, value]) => `${name}:${value}`);
  return [
    '<!DOCTYPE html>',
    '<html lang="en" data-theme="dark">',
    '<head>',
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>:root{${declarations.join(';')}}\n${BASE_STYLE}</style>`,
    `<script>${VISUAL_BOOTSTRAP}</script>`,
    '</head>',
    '<body>',
    normalizeVisualHtml(html),
    '</body>',
    '</html>',
  ].join('\n');
}

// --- messages ----------------------------------------------------------------

export type VisualFrameMessage =
  | { type: 'escape' }
  | { type: 'resize'; height: number }
  | { type: 'error'; message: string }
  | { type: 'link'; href: string };

/**
 * Validate a message from the frame (the caller must already have checked
 * `event.source === iframe.contentWindow`). Anything else is ignored.
 */
export function parseVisualMessage(data: unknown): VisualFrameMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const record = data as Record<string, unknown>;
  if (record.source !== VISUAL_MESSAGE_SOURCE) return null;
  switch (record.type) {
    case 'escape':
      return { type: 'escape' };
    case 'resize': {
      const height = record.height;
      if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null;
      return { type: 'resize', height };
    }
    case 'error': {
      if (typeof record.message !== 'string') return null;
      const message = record.message.replace(/\s+/g, ' ').trim().slice(0, MAX_VISUAL_ERROR_CHARS);
      return message ? { type: 'error', message } : null;
    }
    case 'link': {
      if (typeof record.href !== 'string') return null;
      try {
        const url = new URL(record.href);
        return url.protocol === 'http:' || url.protocol === 'https:' ? { type: 'link', href: url.toString() } : null;
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

/** Frame height for a content-fitted visual reporting `contentHeight`. */
export function clampVisualHeight(contentHeight: number, viewportHeight: number) {
  const viewportCap =
    Number.isFinite(viewportHeight) && viewportHeight > 0
      ? Math.floor(viewportHeight * VISUAL_MAX_VIEWPORT_SHARE)
      : VISUAL_MAX_HEIGHT;
  const max = Math.max(VISUAL_MIN_HEIGHT, Math.min(VISUAL_MAX_HEIGHT, viewportCap));
  const height = Number.isFinite(contentHeight) ? Math.ceil(contentHeight) : VISUAL_AUTO_INITIAL_HEIGHT;
  return Math.min(max, Math.max(VISUAL_MIN_HEIGHT, height));
}
