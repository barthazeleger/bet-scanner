'use strict';

// v10.9.0: MLB Stats API extended adapter (statsapi.mlb.com).
// Server.js had al /schedule + /people (pitcher-stats); deze module breidt uit met:
//   - team-standings-like via /standings
//   - team splits (home/away, vs-l/r, recent 10) via /teams/{id}/stats
//
// Officieel publiek, geen auth nodig, stabiele API.

const {
  fetchViaBreaker, RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled,
} = require('../scraper-base');

const SOURCE_NAME = 'mlb-stats-ext';
const HOST = 'statsapi.mlb.com';
const BASE = `https://${HOST}/api/v1`;
const ALLOWED = [HOST];

const CACHE_TTL_MS = 60 * 60 * 1000;
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

function currentSeason() {
  return String(new Date().getUTCFullYear());
}

async function fetchStandings(season) {
  const s = season || currentSeason();
  const cacheKey = `mlb:standings:${s}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  // Standings endpoint voor regular season AL + NL
  const url = `${BASE}/standings?leagueId=103,104&season=${encodeURIComponent(s)}`;
  const data = await _get(url);
  if (!data || !Array.isArray(data.records)) { cache.set(cacheKey, null); return null; }

  const teams = [];
  for (const rec of data.records) {
    const division = rec.division?.name || null;
    for (const tr of (rec.teamRecords || [])) {
      teams.push({
        teamId: tr.team?.id,
        teamName: tr.team?.name,
        division,
        wins: tr.wins,
        losses: tr.losses,
        winPct: tr.winningPercentage,
        runsScored: tr.runsScored,
        runsAllowed: tr.runsAllowed,
        runDiff: tr.runDifferential,
        gamesPlayed: tr.gamesPlayed,
        streakCode: tr.streak?.streakCode,
        streakType: tr.streak?.streakType,
        streakNum: tr.streak?.streakNumber,
        homeRecord: (tr.records?.splitRecords || []).find(s => s.type === 'home'),
        roadRecord: (tr.records?.splitRecords || []).find(s => s.type === 'away'),
        l10Record: (tr.records?.splitRecords || []).find(s => s.type === 'lastTen'),
      });
    }
  }
  cache.set(cacheKey, teams);
  return teams;
}

async function findTeamByName(teamName, season) {
  if (!teamName || typeof teamName !== 'string') return null;
  const all = await fetchStandings(season);
  if (!all) return null;
  const t = teamName.toLowerCase().trim();
  for (const r of all) {
    const name = (r.teamName || '').toLowerCase();
    if (!name) continue;
    if (name === t || name.includes(t) || t.includes(name)) return r;
  }
  return null;
}

async function fetchTeamSummary(teamName, season) {
  const t = await findTeamByName(teamName, season);
  if (!t) return null;
  return {
    source: SOURCE_NAME,
    teamId: t.teamId,
    teamName: t.teamName,
    wins: t.wins, losses: t.losses, winPct: t.winPct,
    runsScored: t.runsScored, runsAllowed: t.runsAllowed, runDiff: t.runDiff,
    gamesPlayed: t.gamesPlayed,
    streakType: t.streakType, streakCount: t.streakNum, streakCode: t.streakCode,
    homeWin: t.homeRecord?.wins, homeLoss: t.homeRecord?.losses,
    roadWin: t.roadRecord?.wins, roadLoss: t.roadRecord?.losses,
    l10Win: t.l10Record?.wins, l10Loss: t.l10Record?.losses,
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
  currentSeason,
  fetchStandings,
  findTeamByName,
  fetchTeamSummary,
  healthCheck,
  _clearCache,
  _cacheSize,
  _breaker: breaker,
};
