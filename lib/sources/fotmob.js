'use strict';

// v10.9.0: FotMob adapter — football-focused H2H + recent form.
// FotMob exposes www.fotmob.com/api/* endpoints that mobile app and web client
// both consume. Stable-ish over afgelopen jaren maar geen officieel contract.
// Defensieve parsing: elke error → null/empty, geen exceptions naar caller.
//
// Endpoints:
//   GET /api/searchapi/suggest?term={name}  → team-id lookup
//   GET /api/teams?id={teamId}              → team overview incl. last fixtures
//   GET /api/matchDetails?matchId={id}      → H2H in "head2head" subsectie
//
// FotMob geeft H2H als onderdeel van match-details, niet als losse endpoint.
// Strategie: we gebruiken FotMob primair voor team-form (laatste wedstrijden).
// H2H halen we uit SofaScore (primaire bron). FotMob-form dient als 2e signaal
// voor voetbal-specifieke calc.

const {
  fetchViaBreaker, RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled, normalizeTeamKey,
} = require('../scraper-base');

const SOURCE_NAME = 'fotmob';
const HOST = 'www.fotmob.com';
const BASE = `https://${HOST}/api`;
const ALLOWED = [HOST];

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // 12h
const RATE_LIMIT_MS = 1500;

const rl = new RateLimiter(RATE_LIMIT_MS);
const cache = new TTLCache(CACHE_TTL_MS);
const breaker = registerBreaker(new CircuitBreaker({
  name: SOURCE_NAME,
  failureThreshold: 5,
  minCooldownMs: 5 * 60 * 1000,
  maxCooldownMs: 60 * 60 * 1000,
}));

async function _get(url) {
  if (!isSourceEnabled(SOURCE_NAME)) return null;
  await rl.acquire();
  return fetchViaBreaker(url, { allowedHosts: ALLOWED }, breaker);
}

async function healthCheck() {
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  const url = `${BASE}/searchapi/suggest?term=${encodeURIComponent('Arsenal')}`;
  const r = await fetchViaBreaker(url, { allowedHosts: ALLOWED }, breaker);
  const latency = Date.now() - t0;
  const healthy = r && (Array.isArray(r.suggestions) || Array.isArray(r));
  return { source: SOURCE_NAME, healthy: !!healthy, latencyMs: latency, breaker: breaker.status() };
}

async function findTeamId(teamName) {
  if (!teamName || typeof teamName !== 'string') return null;
  const cacheKey = `fm:team:${normalizeTeamKey(teamName)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE}/searchapi/suggest?term=${encodeURIComponent(teamName.slice(0, 120))}`;
  const data = await _get(url);
  // FotMob suggest response: { suggestions: [ { type, id, name, ... }, ... ] }
  // of in oudere versies: { suggestions: [ [ { type, id, name } ] ] }
  let list = [];
  if (Array.isArray(data?.suggestions)) {
    const flat = data.suggestions.flat?.(2) || data.suggestions;
    list = Array.isArray(flat) ? flat : [];
  } else if (Array.isArray(data)) {
    list = data.flat?.(2) || data;
  }

  const teams = list.filter(x => x && (x.type === 'team' || x.type === 'Team' || x.teamId));
  if (!teams.length) { cache.set(cacheKey, null); return null; }

  const norm = normalizeTeamKey(teamName);
  let chosen = null;
  for (const t of teams) {
    if (normalizeTeamKey(t.name || t.teamName || '') === norm) { chosen = t; break; }
  }
  if (!chosen) chosen = teams[0];

  const id = chosen.id || chosen.teamId;
  if (!id) { cache.set(cacheKey, null); return null; }

  const out = {
    id,
    name: String(chosen.name || chosen.teamName || '').slice(0, 200),
  };
  cache.set(cacheKey, out);
  return out;
}

function _parseGoals(s) {
  // "2-1" → { home: 2, away: 1 }; "?" → null
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^\s*(\d+)\s*[-–]\s*(\d+)/);
  if (!m) return null;
  const h = parseInt(m[1], 10), a = parseInt(m[2], 10);
  if (isNaN(h) || isNaN(a) || h > 200 || a > 200) return null;
  return { home: h, away: a };
}

// Fetch team's recent finished fixtures. Returns normalized events array.
async function fetchTeamFormEvents(teamName, limit = 10) {
  if (!teamName) return [];
  const cacheKey = `fm:form:${normalizeTeamKey(teamName)}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const team = await findTeamId(teamName);
  if (!team) { cache.set(cacheKey, []); return []; }

  const url = `${BASE}/teams?id=${encodeURIComponent(team.id)}`;
  const data = await _get(url);
  if (!data) { cache.set(cacheKey, []); return []; }

  // FotMob team-overview bevat "fixtures.allFixtures.fixtures" met home/away/status/score.
  // Structuur kan per versie subtiel anders zijn — defensieve tree-walk.
  const raw = data?.fixtures?.allFixtures?.fixtures
           || data?.fixtures?.fixtures
           || data?.upcomingAndRecent?.items
           || [];
  if (!Array.isArray(raw)) { cache.set(cacheKey, []); return []; }

  const events = [];
  // Eerst finished matches filteren.
  const finished = raw.filter(f => {
    const status = f?.status?.finished || f?.status?.ongoing === false;
    return status || (f?.status && typeof f.status === 'object' && f.status.ongoing === false);
  });

  // Sorteer nieuwste eerst (FotMob kan al in volgorde zijn, maar niet gegarandeerd).
  finished.sort((a, b) => {
    const ta = typeof a.status?.utcTime === 'string' ? Date.parse(a.status.utcTime) : 0;
    const tb = typeof b.status?.utcTime === 'string' ? Date.parse(b.status.utcTime) : 0;
    return tb - ta;
  });

  const n = Math.min(limit, finished.length);
  for (let i = 0; i < n; i++) {
    const f = finished[i];
    const homeId = f?.home?.id || f?.homeTeam?.id;
    const awayId = f?.away?.id || f?.awayTeam?.id;
    if (!homeId || !awayId) continue;
    const goals = _parseGoals(f?.status?.scoreStr || f?.result || f?.score);
    if (!goals) continue;
    const isHome = String(homeId) === String(team.id);
    const myScore = isHome ? goals.home : goals.away;
    const oppScore = isHome ? goals.away : goals.home;
    let result = 'D';
    if (myScore > oppScore) result = 'W';
    else if (myScore < oppScore) result = 'L';

    const dateStr = typeof f?.status?.utcTime === 'string'
      ? f.status.utcTime.slice(0, 10)
      : null;
    const opp = isHome ? (f?.away?.name || f?.awayTeam?.name) : (f?.home?.name || f?.homeTeam?.name);

    events.push({
      source: 'fotmob',
      sport: 'football',
      date: dateStr,
      isHome,
      myScore,
      oppScore,
      result,
      oppName: String(opp || '').slice(0, 200),
    });
  }

  cache.set(cacheKey, events);
  return events;
}

// H2H kan gebouwd worden door twee teams' form-lijsten te kruisen op oppId.
// Robuust want API-structuur van FotMob match-details is variabeler.
async function fetchH2HEvents(team1Name, team2Name) {
  if (!team1Name || !team2Name) return [];
  const cacheKey = `fm:h2h:${[normalizeTeamKey(team1Name), normalizeTeamKey(team2Name)].sort().join('|')}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Haal beide teams' form op (20 games). Kruis ze op oppName-match.
  const [form1, team2] = await Promise.all([
    fetchTeamFormEvents(team1Name, 20),
    findTeamId(team2Name),
  ]);
  if (!team2 || !form1.length) { cache.set(cacheKey, []); return []; }

  const team2Norm = normalizeTeamKey(team2.name);
  const events = [];
  for (const e of form1) {
    if (normalizeTeamKey(e.oppName) !== team2Norm) continue;
    const home = e.isHome ? team1Name : team2Name;
    const away = e.isHome ? team2Name : team1Name;
    const hs = e.isHome ? e.myScore : e.oppScore;
    const as = e.isHome ? e.oppScore : e.myScore;
    events.push({
      source: 'fotmob',
      sport: 'football',
      date: e.date,
      homeTeam: String(home).slice(0, 200),
      awayTeam: String(away).slice(0, 200),
      homeScore: hs,
      awayScore: as,
      totalGoals: hs + as,
      btts: hs > 0 && as > 0,
    });
  }
  cache.set(cacheKey, events);
  return events;
}

function _clearCache() { cache.clear(); }
function _cacheSize() { return cache.size; }

module.exports = {
  SOURCE_NAME,
  HOST, BASE,
  findTeamId,
  fetchH2HEvents,
  fetchTeamFormEvents,
  healthCheck,
  _clearCache,
  _cacheSize,
  _breaker: breaker,
};
