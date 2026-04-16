'use strict';

// v10.9.0: NHL officiële API (api-web.nhle.com) adapter.
// Gratis, publiek, relatief stabiel. Endpoints geen auth vereist.
//
// Endpoints gebruikt:
//   GET /v1/standings/now                → huidige standings alle teams
//   GET /v1/team/{tri}/scoreboard        → recent schedule/scores voor team
//
// Output is ingebouwd met team-summary: W/L/OTL, home/road record, form,
// goal-differential, plus streak. Gebruikt als supplementaire input voor
// NHL moneyline/puck-line probability calcs.

const {
  fetchViaBreaker, RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled,
} = require('../scraper-base');

const SOURCE_NAME = 'nhl-api';
const HOST = 'api-web.nhle.com';
const BASE = `https://${HOST}/v1`;
const ALLOWED = [HOST];

const CACHE_TTL_MS = 60 * 60 * 1000;    // 1u
const RATE_LIMIT_MS = 1000;

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

async function fetchStandings() {
  const cacheKey = 'nhl:standings';
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const url = `${BASE}/standings/now`;
  const data = await _get(url);
  if (!data || !Array.isArray(data.standings)) { cache.set(cacheKey, null); return null; }

  const teams = data.standings.map(r => ({
    teamAbbrev: r.teamAbbrev?.default || r.teamAbbrev,
    teamName: r.teamName?.default || r.teamName,
    conference: r.conferenceName,
    division: r.divisionName,
    wins: r.wins,
    losses: r.losses,
    otLosses: r.otLosses,
    points: r.points,
    gamesPlayed: r.gamesPlayed,
    goalDifferential: r.goalDifferential,
    homeWins: r.homeWins, homeLosses: r.homeLosses, homeOtLosses: r.homeOtLosses,
    roadWins: r.roadWins, roadLosses: r.roadLosses, roadOtLosses: r.roadOtLosses,
    l10Wins: r.l10Wins, l10Losses: r.l10Losses, l10OtLosses: r.l10OtLosses,
    streakCode: r.streakCode,            // 'W' or 'L'
    streakCount: r.streakCount,
    goalFor: r.goalFor,
    goalAgainst: r.goalAgainst,
  }));
  cache.set(cacheKey, teams);
  return teams;
}

// Zoek team op naam of abbrev (fuzzy).
async function findTeamByName(teamName) {
  if (!teamName || typeof teamName !== 'string') return null;
  const all = await fetchStandings();
  if (!all) return null;
  const t = teamName.toLowerCase().trim();
  for (const r of all) {
    const abbrev = (r.teamAbbrev || '').toLowerCase();
    const name = (r.teamName || '').toLowerCase();
    if (abbrev && t === abbrev) return r;
    if (name && (t === name || t.includes(name) || name.includes(t))) return r;
  }
  return null;
}

async function fetchTeamSummary(teamName) {
  const t = await findTeamByName(teamName);
  if (!t) return null;
  return {
    source: SOURCE_NAME,
    teamAbbrev: t.teamAbbrev,
    teamName: t.teamName,
    wins: t.wins, losses: t.losses, otLosses: t.otLosses,
    points: t.points,
    gamesPlayed: t.gamesPlayed,
    gd: t.goalDifferential,
    homeWin: t.homeWins, homeLoss: t.homeLosses, homeOT: t.homeOtLosses,
    roadWin: t.roadWins, roadLoss: t.roadLosses, roadOT: t.roadOtLosses,
    l10Win: t.l10Wins, l10Loss: t.l10Losses, l10OT: t.l10OtLosses,
    streakType: t.streakCode, streakCount: t.streakCount,
    goalsFor: t.goalFor, goalsAgainst: t.goalAgainst,
  };
}

async function healthCheck() {
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  const rows = await fetchStandings();
  const latency = Date.now() - t0;
  return { source: SOURCE_NAME, healthy: Array.isArray(rows) && rows.length > 0, latencyMs: latency, breaker: breaker.status() };
}

function _clearCache() { cache.clear(); }
function _cacheSize() { return cache.size; }

module.exports = {
  SOURCE_NAME,
  HOST, BASE,
  fetchStandings,
  findTeamByName,
  fetchTeamSummary,
  healthCheck,
  _clearCache,
  _cacheSize,
  _breaker: breaker,
};
