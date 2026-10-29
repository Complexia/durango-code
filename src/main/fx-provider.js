import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { execFileAsync, commandPathCache, resolveCommandPath, runShellCommand } from './shell-env.js';

// ---------------------------------------------------------------------------
// fx (Vercel Labs' coding agent harness) model routing. One fx model id is a
// Durango catalog id ("openai/gpt-6-astra", "x-ai/grok-4.7", …); each turn
// picks where its inference runs, in this order:
//   1. a subscription fx is signed in to that serves the model's lab —
//      ChatGPT (fx provider "codex") for openai/*, Grok for x-ai/*;
//   2. the billed provider: Durango inference (default; the signed-in
//      Durango account's usage credits, via the OpenAI-compatible
//      /api/v1/chat/completions) or the user's own Vercel AI Gateway
//      (an API key saved in Durango Code, or fx's own Vercel login).
// The fx driver walks these candidates over ACP and falls back to the next
// one when fx rejects a provider or model (e.g. a model the subscription
// doesn't serve), so subscriptions are always used when they can be.

export const FX_COMMAND = 'fx';
// fx custom connection (top level of ~/.fx/settings.json) that points at
// Durango inference. Its bearer key is read from this variable, which Orion
// sets on each fx process — the key itself is never written to disk.
export const FX_DURANGO_CONNECTION = 'durango';
export const FX_DURANGO_KEY_ENV = 'DURANGO_API_KEY';

const OPENAI_VENDORS = new Set(['openai']);
const GROK_VENDORS = new Set(['x-ai', 'xai', 'spacexai']);

export const fxRouteLabels = {
  codex: 'ChatGPT subscription',
  grok: 'Grok subscription',
  durango: 'Durango credits',
  gateway: 'Vercel AI Gateway',
};

const fxDir = () => path.join(os.homedir(), '.fx');
export const fxSettingsPath = () => path.join(fxDir(), 'settings.json');
// fx's own subscription credential stores, written by `fx login codex|grok`.
const fxSubscriptionFiles = {
  codex: () => path.join(fxDir(), 'chatgpt-auth.json'),
  grok: () => path.join(fxDir(), 'grok-auth.json'),
};

let sources = {
  // () => Promise<{ key, baseUrl }>; throws when the account is signed out.
  getDurangoCredentials: null,
  // () => Promise<boolean> — signed in to a Durango account (no key mint).
  isDurangoSignedIn: async () => false,
  // () => Promise<string | null> — Vercel AI Gateway key saved in Orion.
  readGatewayApiKey: async () => null,
};
export const configureFxProvider = (next) => {
  sources = { ...sources, ...next };
};

const fileExists = async (target) => {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
};

const fxEnv = (extra = {}) => ({
  FX_AUTO_UPGRADE: '0',
  FX_NO_OPEN_BROWSER: '1',
  FX_SKIP_ONBOARDING: '1',
  ...extra,
});

// Whether fx itself can reach AI Gateway (a `fx login vercel` session, a key
// saved with `fx setup`, or AI_GATEWAY_API_KEY in the shell). `fx status`
// reports auth "missing" when no credential source resolves.
const fxGatewayLoginAvailable = async () => {
  try {
    const { stdout } = await runShellCommand(
      `${FX_COMMAND} status --json </dev/null`,
      10000,
      fxEnv({ FX_PROVIDER: 'gateway' })
    );
    const line = stdout
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith('{'));
    const parsed = line ? JSON.parse(line) : null;
    return typeof parsed?.auth === 'string' && parsed.auth !== 'missing';
  } catch {
    return false;
  }
};

export const readFxConnections = async () => {
  const installed = Boolean(await resolveCommandPath(FX_COMMAND));
  const [codex, grok, durango, gatewayApiKey] = await Promise.all([
    fileExists(fxSubscriptionFiles.codex()),
    fileExists(fxSubscriptionFiles.grok()),
    sources.isDurangoSignedIn().catch(() => false),
    sources.readGatewayApiKey().catch(() => null),
  ]);
  const gatewayLogin = installed && !gatewayApiKey ? await fxGatewayLoginAvailable() : false;
  return {
    installed,
    codex,
    grok,
    durango,
    gateway: Boolean(gatewayApiKey) || gatewayLogin,
    gatewaySource: gatewayApiKey ? 'api-key' : gatewayLogin ? 'fx' : null,
  };
};

// Durango's catalog ids follow OpenRouter's namespaces; AI Gateway uses a few
// different ones. Mirrors the exact-namespace rules of Durango's
// getGatewayModelId (chat/andromedus/lib/model-gateway-ids.ts).
export const fxGatewayModelId = (slug) => {
  const separator = slug.indexOf('/');
  if (separator < 0) return slug;
  const vendor = slug.slice(0, separator);
  const model = slug.slice(separator + 1);
  if (vendor === 'qwen') return `alibaba/${model}`;
  if (vendor === 'z-ai' && model.startsWith('glm-')) return `zai/${model}`;
  if (vendor === 'x-ai' && /^grok-4\.[567](?:$|:)/.test(model)) return `spacexai/${model}`;
  return slug;
};

// Ordered inference candidates for one model. `options` are the fx provider
// settings (fxDurangoInference, fxBilledProvider); `connections` comes from
// readFxConnections.
export const resolveFxRoutes = (slug, options = {}, connections = {}) => {
  const separator = slug.indexOf('/');
  const vendor = separator > 0 ? slug.slice(0, separator) : '';
  const bareModel = separator > 0 ? slug.slice(separator + 1) : slug;
  const routes = [];
  if (OPENAI_VENDORS.has(vendor) && connections.codex) {
    routes.push({ provider: 'codex', model: bareModel });
  }
  if (GROK_VENDORS.has(vendor) && connections.grok) {
    routes.push({ provider: 'grok', model: bareModel });
  }
  const durango =
    options.fxDurangoInference !== false && connections.durango
      ? { provider: FX_DURANGO_CONNECTION, model: slug }
      : null;
  const gateway = connections.gateway ? { provider: 'gateway', model: fxGatewayModelId(slug) } : null;
  const billed = options.fxBilledProvider === 'gateway' ? [gateway, durango] : [durango, gateway];
  routes.push(...billed.filter(Boolean));
  return routes.map((route) => ({ ...route, label: fxRouteLabels[route.provider] ?? route.provider }));
};

// --- Durango custom connection -------------------------------------------

// Context limits for compaction, keyed by Durango catalog id. Filled by
// listFxModels from Durango's live catalog.
const fxModelMetadata = new Map();
const FX_SETTINGS_LIMIT_BYTES = 60 * 1024; // fx rejects settings files over 64 KiB.

const durangoConnection = (baseUrl, { withMetadata = true } = {}) => {
  const connection = {
    protocol: 'openai-chat-completions',
    base_url: `${String(baseUrl).replace(/\/+$/, '')}/api/v1`,
    auth: { type: 'bearer', env: FX_DURANGO_KEY_ENV },
    // Durango forwards tool_choice to the upstream gateway.
    tool_choice_mode: 'send',
  };
  if (withMetadata && fxModelMetadata.size > 0) {
    connection.model_metadata = Object.fromEntries(
      [...fxModelMetadata.entries()].sort(([a], [b]) => a.localeCompare(b))
    );
  }
  return connection;
};

let settingsWrites = Promise.resolve();
const serializeSettingsWrite = (operation) => {
  const next = settingsWrites.then(operation, operation);
  settingsWrites = next.catch(() => {});
  return next;
};

// Write (or refresh) the `durango` connection in ~/.fx/settings.json, leaving
// every other setting untouched. Custom connections can only live in the
// user profile — fx ignores them in project .fx.json files.
export const ensureFxDurangoConnection = (baseUrl) =>
  serializeSettingsWrite(async () => {
    const target = fxSettingsPath();
    let settings = {};
    try {
      settings = JSON.parse(await fs.readFile(target, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(
          `Couldn't read ${target} (${error?.message ?? error}). Fix or remove it to use Durango credits with fx.`
        );
      }
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error(`${target} is not a JSON object. Fix or remove it to use Durango credits with fx.`);
    }
    const providers =
      settings.providers && typeof settings.providers === 'object' ? settings.providers : {};
    let connection = durangoConnection(baseUrl);
    let next = { ...settings, providers: { ...providers, [FX_DURANGO_CONNECTION]: connection } };
    if (Buffer.byteLength(JSON.stringify(next, null, 2)) > FX_SETTINGS_LIMIT_BYTES) {
      connection = durangoConnection(baseUrl, { withMetadata: false });
      next = { ...settings, providers: { ...providers, [FX_DURANGO_CONNECTION]: connection } };
    }
    if (JSON.stringify(providers[FX_DURANGO_CONNECTION]) === JSON.stringify(connection)) return;

    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  });

// --- Launch ----------------------------------------------------------------

export class FxConnectionError extends Error {}

// Everything one `fx acp` process needs: its environment (startup provider,
// model, permission mode and credentials) and the ordered route candidates
// the driver pins over ACP.
export const prepareFxLaunch = async ({ slug, providerOptions, accessMode }) => {
  const options = providerOptions && typeof providerOptions === 'object' ? providerOptions : {};
  const connections = await readFxConnections();
  let durangoCredentials = null;
  let durangoProblem = null;
  if (options.fxDurangoInference !== false && connections.durango && sources.getDurangoCredentials) {
    try {
      durangoCredentials = await sources.getDurangoCredentials();
      await ensureFxDurangoConnection(durangoCredentials.baseUrl);
    } catch (error) {
      durangoCredentials = null;
      durangoProblem = error?.message ?? String(error);
    }
  }
  const routes = resolveFxRoutes(slug, options, {
    ...connections,
    durango: Boolean(durangoCredentials),
  });
  if (routes.length === 0) {
    throw new FxConnectionError(
      durangoProblem
        ? `fx couldn't use Durango credits: ${durangoProblem}`
        : 'fx has no model provider for this model. In Settings → Providers → fx, sign in to Durango, connect a ChatGPT or Grok subscription, or add a Vercel AI Gateway key.'
    );
  }

  const env = fxEnv({
    // fx's ACP initialize already requires credentials for its startup
    // provider, so start on the first candidate.
    FX_PROVIDER: routes[0].provider,
    FX_MODEL: routes[0].model,
  });
  if (durangoCredentials && routes.some((route) => route.provider === FX_DURANGO_CONNECTION)) {
    env[FX_DURANGO_KEY_ENV] = durangoCredentials.key;
  }
  if (connections.gatewaySource === 'api-key' && routes.some((route) => route.provider === 'gateway')) {
    const key = await sources.readGatewayApiKey().catch(() => null);
    if (key) env.AI_GATEWAY_API_KEY = key;
  }
  return { env, routes, accessMode };
};

// --- Install -----------------------------------------------------------------

export const FX_INSTALL_SCRIPT_URL = 'https://fx.sh/setup.sh';

// Make a freshly installed fx resolvable by this process and the login
// shells it spawns (macOS path_helper keeps inherited PATH entries). The
// installer also adds its directory to the user's shell rc for terminals.
const addToProcessPath = (directory) => {
  const entries = String(process.env.PATH || '').split(path.delimiter);
  if (!entries.includes(directory)) {
    process.env.PATH = [directory, ...entries.filter(Boolean)].join(path.delimiter);
  }
  commandPathCache.delete(FX_COMMAND);
};

let fxInstallPromise = null;
// Install fx with its official installer, as `grok` falls back to x.ai's:
// it downloads this platform's release into ~/.local/bin and, with no
// terminal attached, prints the installed binary's path as its last line.
export const installFx = () => {
  fxInstallPromise ??= (async () => {
    try {
      const { stdout, stderr } = await runShellCommand(`curl -fsSL ${FX_INSTALL_SCRIPT_URL} | bash`, 180_000);
      const binary = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .reverse()
        .find((line) => path.isAbsolute(line) && path.basename(line) === FX_COMMAND);
      if (!binary) {
        throw new Error(stderr.trim().split(/\r?\n/).at(-1) || 'The fx installer did not report where it installed fx.');
      }
      const { stdout: version } = await execFileAsync(binary, ['--version'], {
        timeout: 10_000,
        env: { ...process.env, FX_AUTO_UPGRADE: '0' },
      });
      addToProcessPath(path.dirname(binary));
      return { ok: true, path: binary, version: version.trim() };
    } catch (error) {
      const output = `${error?.stderr || ''}`.trim().split(/\r?\n/).at(-1);
      return { ok: false, error: output || error?.message || String(error) };
    } finally {
      fxInstallPromise = null;
    }
  })();
  return fxInstallPromise;
};

// --- Models ------------------------------------------------------------------

export const fxPinnedModelIds = [
  'anthropic/claude-sonnet-5.5',
  'openai/gpt-6-astra',
  'anthropic/claude-opus-5.5',
  'openai/gpt-6.1-sol',
  'x-ai/grok-4.7',
  'google/gemini-3.8-flash',
  'moonshotai/kimi-k3',
  'openai/gpt-6-luna',
  'anthropic/claude-haiku-5.5',
];

const fxModelRow = ({ id, label, favorite }, index) => ({
  id: `fx:${id}`,
  providerId: 'fx',
  providerLabel: 'fx',
  label,
  slug: id,
  command: FX_COMMAND,
  ...(index < 9 ? { shortcut: `⌘${index + 1}` } : {}),
  favorite,
});

// fx models are Durango's live chat catalog: every current model with tool
// use (fx is an agent; models without function calling can't drive it).
// Without a Durango account the static fallback block stays in place.
export const listFxModels = async ({ fetchImpl = fetch } = {}) => {
  if (!(await resolveCommandPath(FX_COMMAND))) return [];
  if (!sources.getDurangoCredentials || !(await sources.isDurangoSignedIn().catch(() => false))) return [];
  try {
    const { key, baseUrl } = await sources.getDurangoCredentials();
    const response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/api/v1/models?type=chat`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const payload = await response.json();
    const catalog = (Array.isArray(payload?.data) ? payload.data : []).filter(
      (model) =>
        typeof model?.id === 'string' &&
        model.capabilities?.toolUse === true &&
        model.category !== 'legacy'
    );
    for (const model of catalog) {
      const metadata = { supports_tool_use: true };
      if (Number.isFinite(model.context_length) && model.context_length > 0) {
        metadata.context_window = model.context_length;
      }
      if (model.capabilities?.vision === true) metadata.supports_vision = true;
      fxModelMetadata.set(model.id, metadata);
    }
    const pinRank = (id) => {
      const rank = fxPinnedModelIds.indexOf(id);
      return rank === -1 ? fxPinnedModelIds.length : rank;
    };
    return catalog
      .map((model, order) => ({ model, order }))
      .sort((a, b) => pinRank(a.model.id) - pinRank(b.model.id) || a.order - b.order)
      .map(({ model }, index) =>
        fxModelRow(
          {
            id: model.id,
            label: typeof model.name === 'string' && model.name ? model.name : model.id,
            favorite: fxPinnedModelIds.includes(model.id),
          },
          index
        )
      );
  } catch {
    return [];
  }
};

export const fxFallbackModels = [
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5' },
  { id: 'openai/gpt-6-astra', label: 'GPT-6 Astra' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5' },
  { id: 'openai/gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'x-ai/grok-4.7', label: 'Grok 4.7' },
  { id: 'google/gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5' },
].map((model, index) => fxModelRow({ ...model, favorite: index < 5 }, index));
