'use strict';

// v10.9.0: SofaScore adapter — H2H + recent form voor alle major sports.
// SofaScore heeft een pseudo-public JSON API (api.sofascore.com/api/v1) die
// door veel community-tools wordt gebruikt. Niet officieel ondersteund →
// defensieve parsing, elke error → null return zodat main scan niet breekt.
//
// Endpoints gebruikt:
//   GET /search/suggestions/{query}      → team-lookup
//   GET /team/{id}/h2h/{otherId}/events/last/0  → H2H events (recent)
//   GET /team/{id}/events/last/0         → recent team events (voor form)
//
// Sports:
//   football, basketball, ice-hockey, baseball, handball, volleyball
// (SofaScore "sport.slug" waarde gebruikt voor filtering op search-resultaten)

const {
  fetchViaBreaker, RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled, normalizeTeamKey,
} = require('../scraper-base');

const SOURCE_NAME = 'sofascore';
const HOST = 'api.sofascore.com';
const BASE = `https://${HOST}/api/v1`;
const ALLOWED = [HOST];

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h: H2H/form changes rarely
const RATE_LIMIT_MS = 1200;                  // ~0.83 req/sec

const rl = new RateLimiter(RATE_LIMIT_MS);
const cache = new TTLCache(CACHE_TTL_MS);
const breaker = registerBreaker(new CircuitBreaker({
  name: SOURCE_NAME,
  failureThreshold: 5,
  minCooldownMs: 5 * 60 * 1000,
  maxCooldownMs: 60 * 60 * 1000,
}));

// Sport → SofaScore "sport.slug" used for search-result filtering.
const SPORT_SLUG = {
  football:    'football',
  basketball:  'basketball',
  hockey:      'ice-hockey',
  'ice-hockey':'ice-hockey',
  baseball:    'baseball',
  handball:    'handball',
  volleyball:  'volleyball',
  'american-football': 'american-football',
};

// Per-sport minimum fields check. Defensive parsing guards against SofaScore
// changing response shape mid-season.
function _validEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (!ev.homeTeam?.id || !ev.awayTeam?.id) return false;
  const hs = ev.homeScore?.normaltime ?? ev.homeScore?.current ?? ev.homeScore?.display;
  const as = ev.awayScore?.normaltime ?? ev.awayScore?.current ?? ev.awayScore?.display;
  if (typeof hs !== 'number' || typeof as !== 'number') return false;
  if (hs < 0 || as < 0 || hs > 200 || as > 200) return false;     // sanity bounds
  return true;
}

function _eventScores(ev) {
  const hs = ev.homeScore?.normaltime ?? ev.homeScore?.current ?? ev.homeScore?.display ?? 0;
  const as = ev.awayScore?.normaltime ?? ev.awayScore?.current ?? ev.awayScore?.display ?? 0;
  return { hs, as };
}

function _eventDate(ev) {
  const ts = ev.startTimestamp;
  if (typeof ts === 'number' && ts > 0) return new Date(ts * 1000).toISOString().slice(0, 10);
  return null;
}

async function _get(url) {
  if (!isSourceEnabled(SOURCE_NAME)) return null;
  await rl.acquire();
  return fetchViaBreaker(url, { allowedHosts: ALLOWED }, breaker);
}

// Health-check: pingt search endpoint voor bekende naam.
// Return {healthy, latencyMs, error?}. Admin endpoint gebruikt dit.
async function healthCheck() {
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  const url = `${BASE}/search/suggestions/${encodeURIComponent('Manchester')}`;
  const r = await fetchViaBreaker(url, { allowedHosts: ALLOWED }, breaker);
  const latency = Date.now() - t0;
  const healthy = r && Array.isArray(r.results);
  return { source: SOURCE_NAME, healthy: !!healthy, latencyMs: latency, breaker: breaker.status() };
}

// Find team ID by name + sport. Returns { id, name, slug } or null.
// Uses SofaScore's search-suggestions endpoint which matches team names fuzzy.
async function findTeamId(teamName, sport = 'football') {
  if (!teamName || typeof teamName !== 'string') return null;
  const sportSlug = SPORT_SLUG[sport] || sport;
  const cacheKey = `ss:team:${sportSlug}:${normalizeTeamKey(teamName)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const query = teamName.slice(0, 120);
  const url = `${BASE}/search/suggestions/${encodeURIComponent(query)}`;
  const data = await _get(url);
  if (!data || !Array.isArray(data.results)) {
    cache.set(cacheKey, null);
    return null;
  }

  // Kandidaten: type=team EN sport.slug matcht.
  const normTarget = normalizeTeamKey(teamName);
  const hits = data.results.filter(r => {
    if (r.type !== 'team') return false;
    const e = r.entity;
    if (!e?.id || !e.name) return false;
    const slug = e.sport?.slug || e.category?.sport?.slug;
    if (slug && sportSlug && slug !== sportSlug) return false;
    return true;
  });

  if (!hits.length) {
    cache.set(cacheKey, null);
    return null;
  }

  // Beste match: exact normalized name, anders eerste hit.
  let chosen = null;
  for (const h of hits) {
    if (normalizeTeamKey(h.entity.name) === normTarget) { chosen = h.entity; break; }
  }
  if (!chosen) chosen = hits[0].entity;

  const out = {
    id: chosen.id,
    name: String(chosen.name).slice(0, 200),
    slug: chosen.slug ? String(chosen.slug).slice(0, 200) : null,
  };
  cache.set(cacheKey, out);
  return out;
}

// Raw H2H events array (normalized). Returns [] if geen data.
async function fetchH2HEvents(team1Name, team2Name, sport = 'football') {
  if (!team1Name || !team2Name) return [];
  const sportSlug = SPORT_SLUG[sport] || sport;
  const k1 = normalizeTeamKey(team1Name);
  const k2 = normalizeTeamKey(team2Name);
  if (!k1 || !k2) return [];

  // Cache-key sorted om dezelfde pair onafhankelijk van volgorde te matchen.
  const cacheKey = `ss:h2h:${sportSlug}:${[k1, k2].sort().join('|')}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [t1, t2] = await Promise.all([
    findTeamId(team1Name, sport),
    findTeamId(team2Name, sport),
  ]);
  if (!t1 || !t2) { cache.set(cacheKey, []); return []; }

  const url = `${BASE}/team/${encodeURIComponent(t1.id)}/h2h/${encodeURIComponent(t2.id)}/events/last/0`;
  const data = await _get(url);
  if (!data || !Array.isArray(data.events)) { cache.set(cacheKey, []); return []; }

  const events = [];
  for (const ev of data.events) {
    if (!_validEvent(ev)) continue;
    const { hs, as } = _eventScores(ev);
    const date = _eventDate(ev);
    events.push({
      source: 'sofascore',
      sport: sportSlug,
      date,
      homeTeam: String(ev.homeTeam.name || '').slice(0, 200),
      awayTeam: String(ev.awayTeam.name || '').slice(0, 200),
      homeScore: hs,
      awayScore: as,
      totalGoals: hs + as,
      btts: hs > 0 && as > 0,
    });
  }
  cache.set(cacheKey, events);
  return events;
}

// Recent form events voor één team. Returns [] bij geen data.
async function fetchTeamFormEvents(teamName, sport = 'football', limit = 10) {
  if (!teamName) return [];
  const sportSlug = SPORT_SLUG[sport] || sport;
  const cacheKey = `ss:form:${sportSlug}:${normalizeTeamKey(teamName)}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const team = await findTeamId(teamName, sport);
  if (!team) { cache.set(cacheKey, []); return []; }

  const url = `${BASE}/team/${encodeURIComponent(team.id)}/events/last/0`;
  const data = await _get(url);
  if (!data || !Array.isArray(data.events)) { cache.set(cacheKey, []); return []; }

  const events = [];
  const n = Math.min(limit, data.events.length);
  for (let i = 0; i < n; i++) {
    const ev = data.events[i];
    if (!_validEvent(ev)) continue;
    const { hs, as } = _eventScores(ev);
    const isHome = ev.homeTeam.id === team.id;
    const myScore = isHome ? hs : as;
    const oppScore = isHome ? as : hs;
    let result = 'D';
    if (myScore > oppScore) result = 'W';
    else if (myScore < oppScore) result = 'L';
    events.push({
      source: 'sofascore',
      sport: sportSlug,
      date: _eventDate(ev),
      isHome,
      myScore,
      oppScore,
      result,
      oppName: isHome
        ? String(ev.awayTeam.name || '').slice(0, 200)
        : String(ev.homeTeam.name || '').slice(0, 200),
    });
  }
  cache.set(cacheKey, events);
  return events;
}

// Test hooks
function _clearCache() { cache.clear(); }
function _cacheSize() { return cache.size; }

module.exports = {
  SOURCE_NAME,
  HOST, BASE,
  SPORT_SLUG,
  findTeamId,
  fetchH2HEvents,
  fetchTeamFormEvents,
  healthCheck,
  _clearCache,
  _cacheSize,
  _breaker: breaker,
};
