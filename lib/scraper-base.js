'use strict';

// v10.9.0: Shared primitives voor scraping/external-API modules.
// - safeFetch: timeout + AbortController + SSRF-guard + JSON parse met fail-safe
// - RateLimiter: per-bron throttling zodat we geen rate-limits van upstream triggeren
// - TTLCache: in-memory LRU met TTL (H2H + form data veranderen zelden)
// - ALLOWED_HOSTS per source: URL-allowlist tegen onbedoelde calls
//
// Design keuzes:
// - Module-level state per bron is OK (één proces, geen races tussen bronnen)
// - Alle errors → null/empty return, nooit exception naar caller (scan mag niet breken)
// - Geen credentials of user-input in logs
// - User-Agent polite maar non-identifying

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (compatible; EdgePickrBot/1.0; +https://edgepickr.com)';

// SSRF-bescherming. Lijst van regex patronen die NIET mogen worden geraakt.
const SSRF_BLOCKLIST = [
  /\blocalhost\b/i,
  /\b127\.\d+\.\d+\.\d+\b/,
  /\b10\.\d+\.\d+\.\d+\b/,
  /\b192\.168\.\d+\.\d+\b/,
  /\b172\.(1[6-9]|2[0-9]|3[01])\.\d+\.\d+\b/,
  /\b169\.254\.\d+\.\d+\b/,
  /\b0\.0\.0\.0\b/,
  /\[::1\]/,
  /\[fc00:/i,
  /\[fe80:/i,
];

function isUrlSafe(url, allowedHosts = []) {
  if (typeof url !== 'string' || url.length > 2000) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  if (SSRF_BLOCKLIST.some(re => re.test(u.host))) return false;
  if (allowedHosts.length && !allowedHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return false;
  return true;
}

async function safeFetch(url, {
  timeout = DEFAULT_TIMEOUT_MS,
  headers = {},
  userAgent = DEFAULT_USER_AGENT,
  allowedHosts = [],
  asText = false,
} = {}) {
  if (!isUrlSafe(url, allowedHosts)) return null;
  if (typeof fetch !== 'function') return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': userAgent,
        'Accept': asText ? 'text/html,application/json' : 'application/json',
        ...headers,
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!r.ok) return null;
    if (asText) return await r.text();
    const text = await r.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class RateLimiter {
  constructor(minIntervalMs = 1000) {
    this.minIntervalMs = Math.max(0, minIntervalMs);
    this.last = 0;
    this.queue = Promise.resolve();
  }
  // Serieel: elke acquire wacht tot er minInterval is verstreken sinds de vorige.
  // Gebruik `await rl.acquire()` voor elke fetch-call.
  acquire() {
    const prev = this.queue;
    this.queue = prev.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.last);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      this.last = Date.now();
    });
    return this.queue;
  }
}

class TTLCache {
  constructor(ttlMs = 60 * 60 * 1000, maxEntries = 2000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    // LRU: refresh insertion order
    this.map.delete(key);
    this.map.set(key, e);
    return e.v;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
  set(key, v) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { at: Date.now(), v });
    while (this.map.size > this.maxEntries) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  delete(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

// Normalize team name voor matching: lowercase, trim, strip diacritics + suffix-tokens.
// Used door search-helpers zodat "Bromley FC" en "Bromley" dezelfde key geven.
function normalizeTeamKey(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(fc|cf|afc|sc|sv|sk|bk|ac|as|us|cd|ca|fk|nk|hk|ks|kf|gks|fk|rc|rcd|rs|bsc|bvb)\b/g, '')
    .replace(/\b(united|city|town|club|football|soccer)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function safeName(s) {
  return typeof s === 'string' ? s.slice(0, 200) : '';
}

// v10.9.0: Circuit breaker per source. Na N opeenvolgende failures wordt de
// bron automatisch uitgeschakeld (cooldown) zodat kapotte scraper de scan niet
// doorlopend vertraagt. Herstart zichzelf na cooldown en retry-health-check.
//
// States: 'closed' (healthy) → 'open' (gefaald, cooldown) → 'half-open' (proberen)
// → bij success: closed; bij fail: open (cooldown verdubbeld tot max).
class CircuitBreaker {
  constructor({ name, failureThreshold = 5, successThreshold = 2,
                minCooldownMs = 5 * 60 * 1000, maxCooldownMs = 60 * 60 * 1000 } = {}) {
    this.name = name || 'anonymous';
    this.failureThreshold = failureThreshold;
    this.successThreshold = successThreshold;
    this.minCooldownMs = minCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.state = 'closed';
    this.fails = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.currentCooldownMs = minCooldownMs;
    this.totalCalls = 0;
    this.totalFails = 0;
    this.lastError = null;
    this.lastSuccess = null;
  }
  // Call this BEFORE each fetch. Returns false → skip (bron in cooldown).
  allow() {
    this.totalCalls++;
    if (this.state === 'closed') return true;
    const sinceOpen = Date.now() - this.openedAt;
    if (this.state === 'open' && sinceOpen >= this.currentCooldownMs) {
      this.state = 'half-open';
      this.successes = 0;
      return true;
    }
    return this.state !== 'open';
  }
  // Call this AFTER a successful fetch (non-null response).
  onSuccess() {
    this.lastSuccess = Date.now();
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = 'closed';
        this.fails = 0;
        this.currentCooldownMs = this.minCooldownMs;
      }
    } else if (this.state === 'closed') {
      this.fails = 0;
    }
  }
  // Call this AFTER a failed fetch (null / exception).
  onFailure(err) {
    this.totalFails++;
    this.lastError = err ? String(err).slice(0, 200) : 'unknown';
    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = Date.now();
      this.currentCooldownMs = Math.min(this.maxCooldownMs, this.currentCooldownMs * 2);
      return;
    }
    this.fails++;
    if (this.fails >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = Date.now();
      // Keep current cooldown (reset to min when recently closed)
    }
  }
  status() {
    return {
      name: this.name,
      state: this.state,
      fails: this.fails,
      totalCalls: this.totalCalls,
      totalFails: this.totalFails,
      cooldownMs: this.state === 'open' ? this.currentCooldownMs - (Date.now() - this.openedAt) : 0,
      lastError: this.lastError,
      lastSuccess: this.lastSuccess,
    };
  }
  // Manual override (admin-force reset)
  reset() {
    this.state = 'closed';
    this.fails = 0;
    this.successes = 0;
    this.openedAt = 0;
    this.currentCooldownMs = this.minCooldownMs;
    this.lastError = null;
  }
}

// Registry om alle breakers via naam op te vragen (voor admin endpoint).
const BREAKERS = new Map();
function registerBreaker(breaker) {
  BREAKERS.set(breaker.name, breaker);
  return breaker;
}
function getBreaker(name) { return BREAKERS.get(name); }
function allBreakerStatuses() {
  return Array.from(BREAKERS.values()).map(b => b.status());
}

// Wrapped fetch die circuit breaker respecteert.
// Geeft null terug als breaker open is of fetch faalt. Update breaker state.
async function fetchViaBreaker(url, fetchOpts, breaker) {
  if (breaker && !breaker.allow()) return null;
  try {
    const result = await safeFetch(url, fetchOpts);
    if (result === null || result === undefined) {
      if (breaker) breaker.onFailure('null_response');
      return null;
    }
    if (breaker) breaker.onSuccess();
    return result;
  } catch (e) {
    if (breaker) breaker.onFailure(e && e.message);
    return null;
  }
}

// Runtime-config: per-source enabled flag. Kan via admin endpoint gewijzigd
// zonder redeploy (in-memory). Bij restart reset op DEFAULT_ENABLED.
const _sourceEnabled = new Map();
function isSourceEnabled(name) {
  if (!_sourceEnabled.has(name)) return false;   // default off tot admin aanzet
  return _sourceEnabled.get(name) === true;
}
function setSourceEnabled(name, enabled) {
  _sourceEnabled.set(name, !!enabled);
}
function listSources() {
  return Array.from(_sourceEnabled.entries()).map(([name, enabled]) => ({ name, enabled }));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  isUrlSafe,
  safeFetch,
  fetchViaBreaker,
  RateLimiter,
  TTLCache,
  CircuitBreaker,
  registerBreaker,
  getBreaker,
  allBreakerStatuses,
  isSourceEnabled,
  setSourceEnabled,
  listSources,
  normalizeTeamKey,
  safeName,
};
