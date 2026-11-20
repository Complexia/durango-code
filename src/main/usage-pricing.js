// API list prices for the Usage view's cost estimates.
//
// The agents Durango Code runs bill through subscriptions (Claude Max,
// ChatGPT plans, SuperGrok…), so no log on disk says what a turn really cost.
// The Usage view prices each API call the way the provider's public API
// would: per-token list prices from the Vercel AI Gateway catalog
// (https://ai-gateway.vercel.sh/v1/models, public, no key). A snapshot ships
// in usage-prices.js (scripts/refresh-usage-prices.mjs rewrites it); the app
// refreshes it at most once a day into userData so new models get prices
// between releases. Every figure built from these prices is labeled an API
// estimate in the UI.

import fs from 'node:fs/promises';
import path from 'node:path';
import bundledPrices from './usage-prices.js';

export const USAGE_PRICES_URL = 'https://ai-gateway.vercel.sh/v1/models';
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PRICED_VENDORS = new Set(['anthropic', 'openai', 'spacexai', 'xai', 'moonshotai']);
const RATE_FIELDS = ['input', 'output', 'input_cache_read', 'input_cache_write'];

const perMillion = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 1e6 * 1e6) / 1e6 : undefined;
};

// Tiers ([{cost, min, max}]) price a request by its prompt size (long context).
const compactTiers = (tiers) =>
  Array.isArray(tiers)
    ? tiers
        .map((tier) => ({ cost: perMillion(tier?.cost), min: Number(tier?.min) || 0 }))
        .filter((tier) => tier.cost !== undefined)
    : undefined;

const compactRates = (pricing) => {
  if (!pricing || typeof pricing !== 'object') return null;
  const rates = {};
  for (const field of RATE_FIELDS) {
    const value = perMillion(pricing[field]);
    if (value !== undefined) rates[field] = value;
    const tiers = compactTiers(pricing[`${field}_tiers`]);
    if (tiers?.length > 1) rates[`${field}_tiers`] = tiers;
  }
  return rates.input === undefined && rates.output === undefined ? null : rates;
};

/** Gateway catalog JSON → { models: { 'anthropic/claude-opus-5.5': rates } } in $ per million tokens. */
export const compactPriceCatalog = (catalog, fetchedAt = new Date().toISOString()) => {
  const models = {};
  for (const entry of Array.isArray(catalog?.data) ? catalog.data : []) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    const vendor = id.split('/')[0];
    if (!PRICED_VENDORS.has(vendor) || /-batch$/.test(id)) continue;
    const rates = compactRates(entry.pricing);
    if (!rates) continue;
    const fast = compactRates(entry.pricing.fast) ?? compactRates(entry.pricing.service_tiers?.priority);
    if (fast) rates.fast = fast;
    models[id] = rates;
  }
  return { source: USAGE_PRICES_URL, fetchedAt, models };
};

let activeCatalog = bundledPrices;
let activeSource = 'bundled';
let refreshPromise = null;

const cachePath = (userDataPath) => path.join(userDataPath, 'usage-prices.json');

export const loadUsagePrices = async (userDataPath) => {
  try {
    const cached = JSON.parse(await fs.readFile(cachePath(userDataPath), 'utf8'));
    if (cached?.models && Date.parse(cached.fetchedAt) > Date.parse(activeCatalog.fetchedAt ?? 0)) {
      activeCatalog = cached;
      activeSource = 'gateway';
    }
  } catch {
    // No refreshed copy yet: the bundled snapshot stands.
  }
  return activeCatalog;
};

/** Refreshes the price list in the background when it is a day old. Never throws. */
export const refreshUsagePrices = (userDataPath, { fetchImpl = globalThis.fetch } = {}) => {
  if (refreshPromise) return refreshPromise;
  const age = Date.now() - (Date.parse(activeCatalog.fetchedAt ?? 0) || 0);
  if (age < REFRESH_INTERVAL_MS || typeof fetchImpl !== 'function') return Promise.resolve(false);
  refreshPromise = (async () => {
    try {
      const response = await fetchImpl(USAGE_PRICES_URL, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return false;
      const next = compactPriceCatalog(await response.json());
      if (Object.keys(next.models).length < 20) return false;
      activeCatalog = next;
      activeSource = 'gateway';
      await fs.writeFile(cachePath(userDataPath), JSON.stringify(next));
      return true;
    } catch {
      return false;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
};

export const usagePricesInfo = () => ({ source: activeSource, fetchedAt: activeCatalog.fetchedAt ?? null });

// --- model id → catalog id ---------------------------------------------------

const VENDOR_BY_PROVIDER = { claude: 'anthropic', codex: 'openai', grok: 'spacexai', kimi: 'moonshotai' };

const candidateIds = (provider, model) => {
  const raw = String(model || '')
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '') // claude-opus-5-5[1m]
    .replace(/^[a-z-]+\//, '');
  if (!raw) return [];
  const names = new Set([raw]);
  // claude-haiku-4-5-20251001 → claude-haiku-4-5; claude-opus-5-5 → claude-opus-5.5
  const undated = raw.replace(/-\d{8}$/, '');
  names.add(undated);
  names.add(undated.replace(/-(\d+)-(\d)$/, '-$1.$2'));
  // grok-4.7-build, gpt-6.2-sol-fast → their base model
  for (const name of [...names]) names.add(name.replace(/-(build|fast|latest|preview)$/, ''));
  const vendor = VENDOR_BY_PROVIDER[provider];
  const ids = [];
  for (const name of names) {
    if (vendor) ids.push(`${vendor}/${name}`);
    if (vendor === 'spacexai') ids.push(`xai/${name}`);
  }
  return ids;
};

const priceCache = new Map();

/** The catalog's rates for a model, or null when it has no list price. */
export const pricesForModel = (provider, model) => {
  const key = `${activeCatalog.fetchedAt}|${provider}|${model}`;
  if (priceCache.has(key)) return priceCache.get(key);
  let found = null;
  for (const id of candidateIds(provider, model)) {
    if (activeCatalog.models?.[id]) {
      found = { id, rates: activeCatalog.models[id] };
      break;
    }
  }
  priceCache.set(key, found);
  return found;
};

const rateFor = (rates, field, promptTokens) => {
  const tiers = rates[`${field}_tiers`];
  if (tiers && promptTokens > 0) {
    let cost = rates[field];
    for (const tier of tiers) if (promptTokens >= tier.min) cost = tier.cost;
    return cost;
  }
  return rates[field];
};

/**
 * Prices one usage record. Tokens are disjoint: `input` is uncached input,
 * cache writes split by TTL (Anthropic bills 1-hour writes at 2× input),
 * `output` includes reasoning. `promptTokens` (whole prompt of a single
 * request) picks long-context tiers when known. Returns null without a price.
 */
export const priceUsage = (provider, model, tokens, { fast = false, promptTokens = 0 } = {}) => {
  const match = pricesForModel(provider, model);
  if (!match) return null;
  const base = match.rates;
  const rates = fast && base.fast ? base.fast : base;
  const input = rateFor(rates, 'input', promptTokens) ?? 0;
  const cacheRead = rateFor(rates, 'input_cache_read', promptTokens) ?? input;
  const cacheWrite5m = rateFor(rates, 'input_cache_write', promptTokens) ?? input * (provider === 'claude' ? 1.25 : 1);
  const cacheWrite1h = provider === 'claude' ? input * 2 : cacheWrite5m;
  const output = rateFor(rates, 'output', promptTokens) ?? 0;
  const parts = {
    input: (tokens.input * input) / 1e6,
    cacheRead: (tokens.cacheRead * cacheRead) / 1e6,
    cacheWrite: (tokens.cacheWrite5m * cacheWrite5m + tokens.cacheWrite1h * cacheWrite1h) / 1e6,
    output: (tokens.output * output) / 1e6,
  };
  // What the cached reads would have cost as plain input.
  const savings = (tokens.cacheRead * Math.max(0, input - cacheRead)) / 1e6;
  return { parts, savings, fastPriced: Boolean(fast && base.fast) };
};
