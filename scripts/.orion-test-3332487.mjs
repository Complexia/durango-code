// scripts/test-renderer-csp-electron.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { app, BrowserWindow, WebContentsView, protocol } from "electron";

// src/renderer-csp.js
var DEV_CONNECT_FALLBACK = [
  "http://localhost:*",
  "https://localhost:*",
  "http://127.0.0.1:*",
  "https://127.0.0.1:*",
  "http://[::1]:*",
  "https://[::1]:*",
  "ws://localhost:*",
  "wss://localhost:*",
  "ws://127.0.0.1:*",
  "wss://127.0.0.1:*",
  "ws://[::1]:*",
  "wss://[::1]:*"
];
var devConnectOrigins = (input) => {
  const urls = Array.isArray(input) ? input : input ? [input] : [];
  const origins = /* @__PURE__ */ new Set();
  for (const raw of urls) {
    if (!raw) continue;
    try {
      const parsed = new URL(String(raw));
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      const wsProtocol = parsed.protocol === "https:" ? "wss:" : "ws:";
      origins.add(parsed.origin);
      origins.add(`${wsProtocol}//${parsed.host}`);
    } catch {
    }
  }
  return [...origins];
};
var buildRendererCsp = ({
  devServerUrl = null,
  devServerUrls = null,
  devMode = false,
  includeFrameAncestors = false
} = {}) => {
  const explicitDevOrigins = devConnectOrigins([
    ...Array.isArray(devServerUrls) ? devServerUrls : [],
    ...devServerUrl ? [devServerUrl] : []
  ]);
  const extraConnect = explicitDevOrigins.length ? explicitDevOrigins : devMode ? DEV_CONNECT_FALLBACK : [];
  const connectSrc = [
    "'self'",
    "data:",
    "blob:",
    "orion-attachment:",
    "orion-source-attachment:",
    ...extraConnect
  ].join(" ");
  const directives = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: orion-attachment: orion-source-attachment: https:",
    "media-src 'self' data: blob: orion-attachment: orion-source-attachment: https:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "worker-src 'self' blob:",
    "frame-src 'self' orion-attachment:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'"
  ];
  if (includeFrameAncestors) {
    directives.push("frame-ancestors 'none'");
  }
  return directives.join("; ");
};
var RENDERER_CSP_PROD = buildRendererCsp();
var RENDERER_CSP_DEV = buildRendererCsp({ devMode: true });
var rendererCspResponseHeaders = (details, { isMainWindow, devServerUrl = null } = {}) => {
  if (!details || details.resourceType !== "mainFrame") return null;
  if (typeof isMainWindow !== "function" || !isMainWindow(details.webContentsId)) return null;
  const csp = buildRendererCsp({
    devServerUrl,
    includeFrameAncestors: true
  });
  const nextHeaders = {};
  for (const [key, value] of Object.entries(details.responseHeaders ?? {})) {
    if (key.toLowerCase() === "content-security-policy") continue;
    nextHeaders[key] = value;
  }
  nextHeaders["Content-Security-Policy"] = [csp];
  return nextHeaders;
};

// src/t3-theme-format.js
var T3_THEME_ROLES = Object.freeze([
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "searchMatchBackground",
  "searchMatchForeground",
  "searchMatchActiveBackground",
  "searchMatchActiveForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover"
]);
var T3_ROLE_VARIABLES = Object.freeze({
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  toolbar: "--app-theme-toolbar",
  toolbarForeground: "--app-theme-toolbar-foreground",
  toolbarBorder: "--app-theme-toolbar-border",
  toolbarControl: "--app-theme-toolbar-control",
  toolbarControlForeground: "--app-theme-toolbar-control-foreground",
  toolbarControlHover: "--app-theme-toolbar-control-hover",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  searchMatchBackground: "--app-theme-search-match-background",
  searchMatchForeground: "--app-theme-search-match-foreground",
  searchMatchActiveBackground: "--app-theme-search-match-active-background",
  searchMatchActiveForeground: "--app-theme-search-match-active-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover"
});
var T3_STOCK_COLORS = Object.freeze({
  dark: Object.freeze({
    canvas: "#0a0a0a",
    chrome: "#0a0a0a",
    toolbar: "#0a0a0a",
    toolbarForeground: "#f5f5f5",
    toolbarBorder: "#191919",
    toolbarControl: "#111111",
    toolbarControlForeground: "#f5f5f5",
    toolbarControlHover: "#141414",
    surface: "#111111",
    surfaceRaised: "#111111",
    surfaceOverlay: "#111111",
    text: "#f5f5f5",
    textMuted: "#818181",
    border: "#191919",
    input: "#1e1e1e",
    focus: "#346bf1",
    accent: "#346bf1",
    accentForeground: "#ffffff",
    secondary: "#111111",
    secondaryForeground: "#f5f5f5",
    muted: "#111111",
    mutedForeground: "#818181",
    placeholder: "#818181",
    secondaryLabel: "#818181",
    iconMuted: "#818181",
    error: "#fb414a",
    errorForeground: "#ff6467",
    errorSurface: "#301214",
    warning: "#fe9a00",
    warningForeground: "#ffb900",
    warningSurface: "#312108",
    update: "#346bf1",
    updateForeground: "#51a2ff",
    updateSurface: "#121b34",
    accentSurface: "#141414",
    accentSurfaceForeground: "#f5f5f5",
    messageSurface: "#141414",
    messageForeground: "#f5f5f5",
    messageAction: "#346bf1",
    messageActionForeground: "#ffffff",
    messageActionHover: "#3061d9",
    codeBackground: "#111111",
    codeForeground: "#f5f5f5",
    searchMatchBackground: "#8c6c1f",
    searchMatchForeground: "#f5f5f5",
    searchMatchActiveBackground: "#eea52b",
    searchMatchActiveForeground: "#21180a",
    sidebar: "#000000",
    sidebarForeground: "#f1f3f7",
    sidebarMutedForeground: "#a3a3a3",
    sidebarControlSurface: "#0a0a0a",
    sidebarRowHover: "#131313",
    sidebarRowActive: "#1a1b1b",
    sidebarRowSelected: "#111111",
    sidebarBorder: "#141414",
    terminalBackground: "#0a0a0a",
    terminalForeground: "#f5f5f5",
    terminalCursor: "#b4cbff",
    terminalSelection: "#343a47",
    terminalScrollbar: "#222222",
    terminalScrollbarHover: "#363636"
  }),
  light: Object.freeze({
    canvas: "#fcfcfc",
    chrome: "#fcfcfc",
    toolbar: "#fcfcfc",
    toolbarForeground: "#27272a",
    toolbarBorder: "#e4e4e7",
    toolbarControl: "#ffffff",
    toolbarControlForeground: "#27272a",
    toolbarControlHover: "#f4f4f5",
    surface: "#ffffff",
    surfaceRaised: "#fcfcfc",
    surfaceOverlay: "#ffffff",
    text: "#27272a",
    textMuted: "#71717b",
    border: "#e4e4e7",
    input: "#d4d4d8",
    focus: "#1b4ed8",
    accent: "#1b4ed8",
    accentForeground: "#ffffff",
    secondary: "#fafafa",
    secondaryForeground: "#27272a",
    muted: "#fafafa",
    mutedForeground: "#71717b",
    placeholder: "#71717b",
    secondaryLabel: "#71717b",
    iconMuted: "#71717b",
    error: "#fb2c36",
    errorForeground: "#c10007",
    errorSurface: "#fcebec",
    warning: "#fe9a00",
    warningForeground: "#bb4d00",
    warningSurface: "#fcf4e8",
    update: "#1b4ed8",
    updateForeground: "#1b4ed8",
    updateSurface: "#e0e6f7",
    accentSurface: "#f4f4f5",
    accentSurfaceForeground: "#18181b",
    messageSurface: "#f4f4f5",
    messageForeground: "#27272a",
    messageAction: "#1b4ed8",
    messageActionForeground: "#ffffff",
    messageActionHover: "#3160db",
    codeBackground: "#ffffff",
    codeForeground: "#27272a",
    searchMatchBackground: "#ffde8b",
    searchMatchForeground: "#21180a",
    searchMatchActiveBackground: "#eea52b",
    searchMatchActiveForeground: "#21180a",
    sidebar: "#fafafa",
    sidebarForeground: "#27272a",
    sidebarMutedForeground: "#71717b",
    sidebarControlSurface: "#f4f4f5",
    sidebarRowHover: "#fcfcfc",
    sidebarRowActive: "#ffffff",
    sidebarRowSelected: "#ffffff",
    sidebarBorder: "#e4e4e7",
    terminalBackground: "#fcfcfc",
    terminalForeground: "#27272a",
    terminalCursor: "#26384e",
    terminalSelection: "#d0d6dd",
    terminalScrollbar: "#d6d6d6",
    terminalScrollbarHover: "#bdbdbd"
  })
});
var T3_ALIAS_VARIABLES = Object.freeze([
  ["background", "var(--app-theme-canvas)"],
  ["app-chrome-background", "var(--app-theme-chrome)"],
  ["toolbar-background", "var(--app-theme-toolbar)"],
  ["toolbar-foreground", "var(--app-theme-toolbar-foreground)"],
  ["toolbar-border", "var(--app-theme-toolbar-border)"],
  ["toolbar-control", "var(--app-theme-toolbar-control)"],
  ["toolbar-control-foreground", "var(--app-theme-toolbar-control-foreground)"],
  ["toolbar-control-hover", "var(--app-theme-toolbar-control-hover)"],
  ["surface-raised", "var(--app-theme-surface-raised)"],
  ["foreground", "var(--app-theme-text)"],
  ["card", "var(--app-theme-surface)"],
  ["card-foreground", "var(--app-theme-text)"],
  ["popover", "var(--app-theme-surface-overlay)"],
  ["popover-foreground", "var(--app-theme-text)"],
  ["primary", "var(--app-theme-message-action)"],
  ["primary-foreground", "var(--app-theme-message-action-foreground)"],
  ["secondary", "var(--app-theme-secondary)"],
  ["secondary-foreground", "var(--app-theme-secondary-foreground)"],
  ["muted", "var(--app-theme-muted)"],
  ["muted-foreground", "var(--app-theme-muted-foreground)"],
  ["placeholder", "var(--app-theme-placeholder)"],
  ["secondary-label", "var(--app-theme-secondary-label)"],
  ["icon-muted", "var(--app-theme-icon-muted)"],
  ["accent", "var(--app-theme-accent-surface)"],
  ["accent-foreground", "var(--app-theme-accent-surface-foreground)"],
  ["message-surface", "var(--app-theme-message-surface)"],
  ["message-foreground", "var(--app-theme-message-foreground)"],
  ["message-action", "var(--app-theme-message-action)"],
  ["message-action-foreground", "var(--app-theme-message-action-foreground)"],
  ["message-action-hover", "var(--app-theme-message-action-hover)"],
  ["error", "var(--app-theme-error)"],
  ["error-foreground", "var(--app-theme-error-foreground)"],
  ["tool-error-icon", "var(--error-foreground)"],
  ["error-surface", "var(--app-theme-error-surface)"],
  ["destructive", "var(--error)"],
  ["destructive-foreground", "var(--error-foreground)"],
  ["warning", "var(--app-theme-warning)"],
  ["warning-foreground", "var(--app-theme-warning-foreground)"],
  ["warning-surface", "var(--app-theme-warning-surface)"],
  ["update", "var(--app-theme-update)"],
  ["update-foreground", "var(--app-theme-update-foreground)"],
  ["border", "var(--app-theme-border)"],
  ["input", "var(--app-theme-input)"],
  ["ring", "var(--app-theme-focus)"],
  ["sidebar", "var(--app-theme-sidebar)"],
  ["sidebar-foreground", "var(--app-theme-sidebar-foreground)"],
  ["sidebar-muted-foreground", "var(--app-theme-sidebar-muted-foreground)"],
  ["sidebar-control-surface", "var(--app-theme-sidebar-control-surface)"],
  ["sidebar-row-hover", "var(--app-theme-sidebar-row-hover)"],
  ["sidebar-row-active", "var(--app-theme-sidebar-row-active)"],
  ["sidebar-row-selected", "var(--app-theme-sidebar-row-selected)"],
  ["sidebar-border", "var(--app-theme-sidebar-border)"],
  ["sidebar-stage-fade", "var(--app-theme-sidebar)"],
  ["code-background", "var(--app-theme-code-background)"],
  ["code-foreground", "var(--app-theme-code-foreground)"],
  ["terminal-background", "var(--app-theme-terminal-background)"],
  ["terminal-foreground", "var(--app-theme-terminal-foreground)"],
  ["terminal-cursor", "var(--app-theme-terminal-cursor)"],
  ["terminal-selection-background", "var(--app-theme-terminal-selection-background)"]
]);
var T3_ALIAS_NAMES = Object.freeze(T3_ALIAS_VARIABLES.map(([name]) => name));
var T3_ROLE_TOKENS = Object.freeze({
  canvas: "bg-base",
  surface: "bg-surface",
  surfaceRaised: "bg-raised",
  surfaceOverlay: "bg-elevated",
  accentSurface: "bg-hover",
  border: "border-default",
  input: "border-strong",
  text: "text-primary",
  textMuted: "text-secondary",
  placeholder: "text-muted",
  accent: "accent",
  accentForeground: "on-accent",
  warning: "warning",
  error: "danger"
});

// src/ui-themes.js
var THEME_LIMITS = Object.freeze({
  name: 60,
  description: 240,
  // Room for a theme imported from T3 Code (50,000 characters there) after its hooks are rewritten.
  css: 16e4,
  html: 2e5,
  tokenValue: 400,
  values: 24,
  controls: 24,
  variants: 8,
  options: 24,
  svg: 12e3,
  selector: 300
});
var THEME_TOKENS = Object.freeze({
  "bg-base": { stock: "#101012", kind: "color", label: "Window background behind everything" },
  "bg-raised": { stock: "#141416", kind: "color", label: "Sidebar, composer, settings panels" },
  "bg-surface": { stock: "#1d1d21", kind: "color", label: "Cards, inputs, code blocks, menus" },
  "bg-elevated": { stock: "#26262b", kind: "color", label: "Popovers and raised controls" },
  "bg-hover": { stock: "#303036", kind: "color", label: "Hovered rows and buttons" },
  "shell-bg": {
    stock: "linear-gradient(180deg, #141416 0%, #111113 100%)",
    kind: "background",
    label: "Title bar strip across the top (a color or gradient)"
  },
  "settings-sidebar-bg": { stock: "#0c0c0e", kind: "color", label: "Settings navigation column" },
  "border-subtle": { stock: "rgb(255 255 255 / 5.5%)", kind: "color", label: "Faint dividers" },
  "border-default": { stock: "rgb(255 255 255 / 8%)", kind: "color", label: "Panel and card borders" },
  "border-strong": { stock: "rgb(255 255 255 / 13%)", kind: "color", label: "Focused and emphasized borders" },
  "text-primary": { stock: "#ececef", kind: "color", label: "Main text" },
  "text-secondary": { stock: "#a0a0a8", kind: "color", label: "Secondary text, descriptions" },
  "text-muted": { stock: "#6b6b74", kind: "color", label: "Hints, timestamps, placeholders" },
  accent: { stock: "#4d8dff", kind: "color", label: "Links, focus rings, primary buttons, selection" },
  "on-accent": { stock: "#fff", kind: "color", label: "Text and icons on accent fills (your prompt bubbles, send and primary buttons); dark for bright accents" },
  link: { stock: "#4da3ff", kind: "color", label: "Links in replies (follows accent if unset)" },
  "accent-soft": { stock: "rgb(77 141 255 / 14%)", kind: "color", label: "Accent tint behind selected items" },
  "accent-glow": { stock: "rgb(77 141 255 / 28%)", kind: "color", label: "Accent glow and focus halos" },
  "agent-violet": { stock: "#8b7cf6", kind: "color", label: "Agent and subagent highlights" },
  success: { stock: "#34d399", kind: "color", label: "Success, additions, done" },
  warning: { stock: "#f4a261", kind: "color", label: "Warnings, waiting" },
  danger: { stock: "#f87171", kind: "color", label: "Errors, deletions" },
  "font-ui": {
    stock: "'Inter Variable', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif",
    kind: "font",
    label: "Interface font stack (fonts installed on this computer; no web fonts)"
  },
  "font-mono": {
    stock: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    kind: "font",
    label: "Code and terminal font stack"
  },
  "radius-sm": { stock: "6px", kind: "length", label: "Small corner radius (chips, small buttons)" },
  "radius-md": { stock: "10px", kind: "length", label: "Medium corner radius (inputs, cards)" },
  "radius-lg": { stock: "14px", kind: "length", label: "Large corner radius (panels, composer)" },
  "radius-xl": { stock: "18px", kind: "length", label: "Extra large corner radius (dialogs)" }
});
var THEME_TOKEN_NAMES = Object.freeze(Object.keys(THEME_TOKENS));
var SEE_THROUGH_TOKENS = Object.freeze({ "bg-base": 0, "bg-raised": 0, "settings-sidebar-bg": 0, "bg-surface": 0.12 });
var BACKDROP_TYPES = Object.freeze(["css", "image", "video", "html"]);
var THEME_APPEARANCES = Object.freeze(["dark", "light"]);
var THEME_SCENE_EVENTS = Object.freeze({
  working: "An agent started or stopped working in any thread: { working: boolean, count: number }",
  "turn-start": "An agent turn started: { threadId }",
  "turn-end": 'An agent turn ended: { threadId, status: "done" | "error" | "stopped" }; "done" is the moment to celebrate',
  pointer: "The mouse moved over the window: { x, y } from 0 to 1 (throttled to animation frames)",
  focus: "The window gained or lost focus: { focused: boolean }",
  celebrate: "The user pressed Preview celebration in Settings: { }",
  typing: "The user typed in the composer: { }",
  state: "The app state arrived (right after the scene loads, values included) or changed: durango.state",
  value: "One of the theme's values changed (also once at load, with name null) (a control, a scene's durango.set, or the agent): { name, value, values }",
  action: "A theme button (or a scene's durango.action) fired an action: { name, detail }"
});
var THEME_VALUE_TYPES = Object.freeze(["boolean", "number", "choice"]);
var THEME_CONTROL_KINDS = Object.freeze(["toggle", "choice", "slider", "menu", "button", "html"]);
var THEME_CONTROL_POSITIONS = Object.freeze(["start", "end", "before", "after", "float"]);
var THEME_CONTROL_CORNERS = Object.freeze(["top-left", "top-right", "bottom-left", "bottom-right", "center"]);
var THEME_SLOTS = Object.freeze({
  "titlebar-left": "Title bar, next to the Durango Code logo (above the sidebar)",
  "titlebar-center": "Title bar, after the project / thread title",
  "titlebar-right": "Title bar, right side, before the browser and Open with buttons",
  "sidebar-top": "Sidebar, the row with Search and the new thread / folder / history buttons",
  "sidebar-bottom": "Sidebar footer, next to the account and Settings buttons",
  "composer-toolbar": "Prompt box toolbar, before the send button (next to model, effort, access)",
  "composer-top": "Inside the prompt box, a row above the text field",
  "thread-header": "Header of each thread pane when threads are split side by side"
});
var THEME_LOCAL_FIELDS = Object.freeze(["id", "threadId", "saved", "builtIn", "revision", "createdAt", "updatedAt", "published", "origin"]);
var THEME_SCENE_SOURCE = "durango-theme-scene";
var THEME_SCENE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'"
].join("; ");
var THEME_SCENE_BOOTSTRAP = `(function(){
"use strict";
var S=${JSON.stringify(THEME_SCENE_SOURCE)},P=window.parent,sent=0,seen={},L={};
function post(m){try{m.source=S;P.postMessage(m,"*");}catch(e){}}
function report(t){t=String(t||"Script error").slice(0,300);if(seen[t]||sent>=8)return;seen[t]=1;sent++;post({type:"error",message:t});}
["RTCPeerConnection","webkitRTCPeerConnection","RTCDataChannel","WebSocket","EventSource","Worker","SharedWorker"].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false});}catch(e){}});
window.addEventListener("error",function(e){if(!(e instanceof ErrorEvent))return;report(e.message||"Script error");e.preventDefault();});
window.addEventListener("unhandledrejection",function(e){var r=e.reason;report("Unhandled promise rejection: "+(r&&r.message?r.message:String(r)));e.preventDefault();});
var state={working:false,count:0,pointer:{x:0.5,y:0.5},focused:true,reducedMotion:false,paused:false,appearance:"dark",values:{},colors:{}};
var RAF=typeof window.requestAnimationFrame==="function"?window.requestAnimationFrame.bind(window):null,CAF=typeof window.cancelAnimationFrame==="function"?window.cancelAnimationFrame.bind(window):function(){},held=new Map(),sent=new Map(),hn=0,frozen=false,ft=0,vids=[];
if(RAF){window.requestAnimationFrame=function(f){if(!frozen)return RAF(f);hn-=1;held.set(hn,f);return hn;};
window.cancelAnimationFrame=function(id){if(id<0){held.delete(id);if(sent.has(id)){CAF(sent.get(id));sent.delete(id);}}else CAF(id);};}
function flush(){if(!RAF)return;held.forEach(function(f,id){sent.set(id,RAF(function(t){sent.delete(id);f(t);}));});held.clear();}
function hold(v){if(vids.indexOf(v)<0)vids.push(v);v.pause();}
if(typeof document!=="undefined")document.addEventListener("play",function(e){if(frozen&&e.target&&e.target.pause)hold(e.target);},true);
function freeze(on){if(on===frozen||typeof document==="undefined")return;frozen=on;document.documentElement.classList.toggle("durango-paused",on);
if(on){vids=[];document.querySelectorAll("video,audio").forEach(function(v){if(!v.paused)hold(v);});}
else{vids.forEach(function(v){try{var r=v.play();if(r&&r.catch)r.catch(function(){});}catch(e){}});vids=[];flush();}}
function setPaused(p){if(!p){if(ft){clearTimeout(ft);ft=0;}freeze(false);return;}if(!frozen&&!ft)ft=setTimeout(function(){ft=0;freeze(true);},1000);}
addEventListener("resize",function(){if(frozen)flush();});
var api={state:state,on:function(t,f){if(typeof f!=="function")return;(L[t]=L[t]||[]).push(f);},off:function(t,f){var a=L[t];if(!a)return;var i=a.indexOf(f);if(i>=0)a.splice(i,1);},
set:function(n,v){if(typeof n!=="string")return;if(v!==null&&typeof v==="object")return;state.values[n]=v;post({type:"set",name:n,value:v});},
action:function(n,x){if(typeof n!=="string")return;var o=null;try{o=x===undefined?null:JSON.parse(JSON.stringify(x));}catch(e){}post({type:"action",name:n,detail:o});},
resize:function(w,h){post({type:"resize",width:+w||0,height:+h||0});}};
Object.defineProperty(api,"values",{get:function(){return state.values;}});
try{Object.defineProperty(window,"durango",{value:api,writable:false,configurable:false});}catch(e){window.durango=api;}
window.addEventListener("message",function(e){if(e.source!==P)return;var d=e.data;if(!d||d.source!==S||d.type!=="event"||typeof d.event!=="string")return;var x=d.detail&&typeof d.detail==="object"?d.detail:{};
if(d.event==="state"){for(var k in x){if(Object.prototype.hasOwnProperty.call(state,k))state[k]=x[k];}setPaused(!!state.paused);
var s=(L.state||[]).slice().concat((L.value||[]).slice());var vd={name:null,value:null,values:state.values};
for(var j=0;j<s.length;j++){try{s[j](j<(L.state||[]).length?state:vd);}catch(err){report(err&&err.message?err.message:String(err));}}return;}
if(d.event==="working"){state.working=!!x.working;state.count=+x.count||0;}
if(d.event==="pointer"){state.pointer={x:+x.x||0,y:+x.y||0};}
if(d.event==="focus"){state.focused=!!x.focused;}
if(d.event==="value"){if(x.values&&typeof x.values==="object")state.values=x.values;else if(typeof x.name==="string")state.values[x.name]=x.value;}
var a=(L[d.event]||[]).slice();for(var i=0;i<a.length;i++){try{a[i](x);}catch(err){report(err&&err.message?err.message:String(err));}}});
post({type:"ready"});
})();`;
var SCENE_BASE_STYLE = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent}
canvas{display:block}
html.durango-paused *,html.durango-paused *::before,html.durango-paused *::after{animation-play-state:paused!important}`;
var tagPattern = (names) => new RegExp(`<\\/?(?:${names})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
var normalizeSceneHtml = (html) => String(html ?? "").replace(/^﻿/, "").replace(/<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>/gi, "").replace(tagPattern("html|head|body"), "").replace(tagPattern("meta"), (tag) => /http-equiv/i.test(tag) ? "" : tag).replace(tagPattern("base|link|iframe|frame|object|embed"), "").trim();
var buildSceneDocument = (html) => [
  "<!DOCTYPE html>",
  '<html lang="en">',
  "<head>",
  `<meta http-equiv="Content-Security-Policy" content="${THEME_SCENE_CSP}">`,
  '<meta charset="utf-8">',
  '<meta name="referrer" content="no-referrer">',
  '<meta http-equiv="x-dns-prefetch-control" content="off">',
  `<style>${SCENE_BASE_STYLE}</style>`,
  `<script>${THEME_SCENE_BOOTSTRAP}</script>`,
  "</head>",
  "<body>",
  normalizeSceneHtml(html),
  "</body>",
  "</html>"
].join("\n");

// src/app/visualDocument.ts
var VISUAL_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-src 'none'"
].join("; ");
var VISUAL_MESSAGE_SOURCE = "durango-visual";
var MAX_VISUAL_ERROR_CHARS = 300;
var VAR_NAME_PATTERN = /^--[a-z][a-z0-9-]{0,40}$/;
var VAR_VALUE_PATTERN = /^[#a-zA-Z0-9\s(),.%/+-]{1,80}$/;
function sanitizeThemeVars(vars) {
  const out = {};
  if (!vars || typeof vars !== "object" || Array.isArray(vars)) return out;
  for (const [name, raw] of Object.entries(vars)) {
    if (!VAR_NAME_PATTERN.test(name) || typeof raw !== "string") continue;
    const value = raw.trim();
    if (VAR_VALUE_PATTERN.test(value)) out[name] = value;
  }
  return out;
}
var tagPattern2 = (names) => new RegExp(`<\\/?(?:${names})(?=[\\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>`, "gi");
var DOCTYPE_PATTERN = /<!doctype(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
var WRAPPER_TAGS = tagPattern2("html|head");
var META_TAGS = tagPattern2("meta");
var BASE_LINK_TAGS = tagPattern2("base|link");
function normalizeVisualHtml(html) {
  return html.replace(/^﻿/, "").replace(DOCTYPE_PATTERN, "").replace(WRAPPER_TAGS, "").replace(META_TAGS, (tag) => /http-equiv/i.test(tag) ? "" : tag).replace(BASE_LINK_TAGS, "").trim();
}
var VISUAL_BOOTSTRAP = `(function(){
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
var BASE_STYLE = `*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;color-scheme:dark;--font-sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px}
body{margin:0;background:transparent;color:var(--foreground);font:14px/1.55 var(--font-sans);overflow-wrap:break-word}
img,svg,canvas,video{max-width:100%}
a{color:var(--primary)}
button,input,select,textarea{font:inherit;color:inherit}`;
function buildVisualDocument(html, themeVars = {}) {
  const vars = sanitizeThemeVars(themeVars);
  const declarations = Object.entries(vars).map(([name, value]) => `${name}:${value}`);
  return [
    "<!DOCTYPE html>",
    '<html lang="en" data-theme="dark">',
    "<head>",
    `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`,
    '<meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<meta http-equiv="x-dns-prefetch-control" content="off">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>:root{${declarations.join(";")}}
${BASE_STYLE}</style>`,
    `<script>${VISUAL_BOOTSTRAP}</script>`,
    "</head>",
    "<body>",
    normalizeVisualHtml(html),
    "</body>",
    "</html>"
  ].join("\n");
}

// scripts/test-renderer-csp-electron.mjs
protocol.registerSchemesAsPrivileged([
  { scheme: "orion-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  { scheme: "orion-source-attachment", privileges: { standard: true, secure: true, supportFetchAPI: true } }
]);
var minimalPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=",
  "base64"
);
var minimalPdf = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
app.disableHardwareAcceleration();
await app.whenReady();
var tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "orion-csp-electron-"));
var guestServer = http.createServer((req, res) => {
  if (req.url === "/pixel.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(minimalPng);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>Guest</title><script>window.__guestEval = new Function("return 42")();</script>');
});
try {
  await new Promise((resolve) => guestServer.listen(0, "127.0.0.1", resolve));
  const guestOrigin = `http://127.0.0.1:${guestServer.address().port}`;
  protocol.handle("orion-attachment", (req) => {
    if (req.url.includes(".pdf")) {
      return new Response(minimalPdf, { headers: { "content-type": "application/pdf" } });
    }
    return new Response(minimalPng, { headers: { "content-type": "image/png" } });
  });
  protocol.handle(
    "orion-source-attachment",
    () => new Response(minimalPng, { headers: { "content-type": "image/png" } })
  );
  await fs.writeFile(path.join(tempDir, "helper.mjs"), "export const answer = 7;\n");
  await fs.writeFile(
    path.join(tempDir, "module-worker.mjs"),
    "import { answer } from './helper.mjs'; self.postMessage(answer);\n"
  );
  await fs.writeFile(
    path.join(tempDir, "index.html"),
    `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP_PROD}"></head><body><div id="root">ok</div></body></html>`
  );
  const mainIds = /* @__PURE__ */ new Set();
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, plugins: true }
  });
  mainIds.add(win.webContents.id);
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const next = rendererCspResponseHeaders(details, {
      isMainWindow: (id) => mainIds.has(id),
      devServerUrl: null
    });
    callback(next ? { responseHeaders: next } : {});
  });
  await win.loadFile(path.join(tempDir, "index.html"));
  const sceneDoc = buildSceneDocument('<canvas id="c"></canvas><script>window.durango.on("state",()=>{});</script>');
  const visualDoc = buildVisualDocument('<div>hi</div><script>window.parent.postMessage({source:"durango-visual",type:"resize",height:120},"*");</script>', {});
  const res = await win.webContents.executeJavaScript(`(async () => {
    const violations = [];
    window.addEventListener('securitypolicyviolation', (e) => {
      violations.push({ dir: e.violatedDirective, blocked: e.blockedURI });
    });

    // 1. Shiki-style ES module worker ('self')
    const moduleWorkerOk = await new Promise((resolve) => {
      const w = new Worker('./module-worker.mjs', { type: 'module' });
      w.onmessage = (e) => { w.terminate(); resolve(e.data === 7); };
      w.onerror = () => resolve(false);
    });

    // 2. Monaco-style blob: module bootstrap worker importing same-origin ESM
    const helperUrl = new URL('./helper.mjs', location.href).href;
    const blobWorkerOk = await new Promise((resolve) => {
      const blob = new Blob([\`import { answer } from \${JSON.stringify(helperUrl)}; self.postMessage(answer);\`], { type: 'text/javascript' });
      const w = new Worker(URL.createObjectURL(blob), { type: 'module' });
      w.onmessage = (e) => { w.terminate(); resolve(e.data === 7); };
      w.onerror = () => resolve(false);
    });

    // 3. Sandboxed about:srcdoc theme scene and show_html visual
    const sceneReady = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      window.addEventListener('message', (e) => {
        if (e.data?.source === 'durango-theme-scene' && e.data?.type === 'ready') { clearTimeout(t); resolve(true); }
      });
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = ${JSON.stringify(sceneDoc)};
      document.body.appendChild(f);
    });
    const visualReady = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      window.addEventListener('message', (e) => {
        if (e.data?.source === 'durango-visual' && e.data?.type === 'resize') { clearTimeout(t); resolve(true); }
      });
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.srcdoc = ${JSON.stringify(visualDoc)};
      document.body.appendChild(f);
    });

    // 4. orion-attachment:, orion-source-attachment:, data: images + PDF iframe
    const loadImg = (src) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
    const attachImg = await loadImg('orion-attachment://local/media?path=/tmp/a.png');
    const sourceImg = await loadImg('orion-source-attachment://source/o/r/att_1?account=u1');
    const dataImg = await loadImg('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=');
    const pdfLoaded = await new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.onload = () => resolve(true);
      f.onerror = () => resolve(false);
      f.src = 'orion-attachment://local/media?path=/tmp/doc.pdf';
      document.body.appendChild(f);
    });

    const unexpectedViolations = [...violations];

    // 5. Blocked actions: eval, remote fetch, remote CSS @import, data: worker, cleartext http: image
    let evalBlocked = false;
    try { new Function('return 1')(); } catch { evalBlocked = true; }
    let fetchBlocked = false;
    try { await fetch('https://example.com/'); } catch { fetchBlocked = true; }
    let dataWorkerBlocked = false;
    try {
      const dw = new Worker('data:text/javascript,self.postMessage(1)');
      dataWorkerBlocked = await new Promise((resolve) => {
        dw.onerror = () => resolve(true);
        dw.onmessage = () => resolve(false);
        setTimeout(() => resolve(true), 300);
      });
      dw.terminate();
    } catch {
      dataWorkerBlocked = true;
    }
    const httpImgLoaded = await loadImg(${JSON.stringify(`${guestOrigin}/pixel.png`)});
    const style = document.createElement('style');
    style.textContent = '@import url("https://example.com/evil.css");';
    document.head.appendChild(style);
    await new Promise((r) => setTimeout(r, 200));

    return {
      moduleWorkerOk,
      blobWorkerOk,
      sceneReady,
      visualReady,
      attachImg,
      sourceImg,
      dataImg,
      pdfLoaded,
      unexpectedViolations,
      evalBlocked,
      fetchBlocked,
      dataWorkerBlocked,
      httpImgLoaded,
      allViolations: violations,
    };
  })()`);
  assert.equal(res.moduleWorkerOk, true, "ES module worker runs under CSP");
  assert.equal(res.blobWorkerOk, true, "Monaco-style blob: module worker runs under CSP");
  assert.equal(res.sceneReady, true, "ThemeSceneFrame srcdoc runs under CSP");
  assert.equal(res.visualReady, true, "HtmlVisual srcdoc runs under CSP");
  assert.equal(res.attachImg, true, "orion-attachment: image loads");
  assert.equal(res.sourceImg, true, "orion-source-attachment: image loads");
  assert.equal(res.dataImg, true, "data: image loads");
  assert.equal(res.pdfLoaded, true, "orion-attachment: PDF iframe loads");
  assert.deepEqual(res.unexpectedViolations, [], `zero unexpected CSP violations: ${JSON.stringify(res.unexpectedViolations)}`);
  assert.equal(res.evalBlocked, true, "eval / new Function blocked");
  assert.equal(res.fetchBlocked, true, "remote fetch blocked");
  assert.equal(res.dataWorkerBlocked, true, "data: worker blocked");
  assert.equal(res.httpImgLoaded, false, "cleartext http: image blocked in prod CSP");
  assert.ok(
    res.allViolations.some((v) => v.dir.startsWith("style-src") && v.blocked.includes("example.com")),
    "remote CSS @import blocked"
  );
  const guestView = new WebContentsView({
    webPreferences: { partition: "persist:csp-smoke-browser", sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  win.contentView.addChildView(guestView);
  guestView.setBounds({ x: 0, y: 0, width: 320, height: 240 });
  await guestView.webContents.loadURL(`${guestOrigin}/`);
  assert.equal(await guestView.webContents.executeJavaScript("window.__guestEval"), 42);
  win.destroy();
  console.log("Electron runtime CSP smoke checks passed.");
} finally {
  guestServer.close();
  await fs.rm(tempDir, { recursive: true, force: true });
  app.quit();
}
