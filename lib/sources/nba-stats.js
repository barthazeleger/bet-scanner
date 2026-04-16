'use strict';

// v10.9.0: stats.nba.com adapter — officiële NBA stats API (public endpoints).
// Vereist specifieke headers anders → 403:
//   Referer, Origin, x-nba-stats-origin, x-nba-stats-token, User-Agent
// Endpoints are queryable via CommonTeamYears / TeamInfoCommon / LeagueStandings etc.
//
// Voor EdgePickr v10.9.0 gebruiken we:
//   /stats/leaguestandings   → elke scan 1 call, cache 1u, alle teams in 1 response
//
// Dit levert: record, conference-rank, home/road records, streak (L10).
// calcOverProb/adjHome in NBA scan kan deze data aanvullen op api-sports wanneer
// dat dun of stale is.

const {
  fetchViaBreaker, RateLimiter, TTLCache, CircuitBreaker, registerBreaker,
  isSourceEnabled,
} = require('../scraper-base');

const SOURCE_NAME = 'nba-stats';
const HOST = 'stats.nba.com';
const BASE = `https://${HOST}/stats`;
const ALLOWED = [HOST];

const CACHE_TTL_MS = 60 * 60 * 1000;    // 1u voor standings (live)
const RATE_LIMIT_MS = 1500;              // conservatief, NBA gooit 429 snel

const rl = new RateLimiter(RATE_LIMIT_MS);
const cache = new TTLCache(CACHE_TTL_MS);
const breaker = registerBreaker(new CircuitBreaker({
  name: SOURCE_NAME,
  failureThreshold: 3,
  minCooldownMs: 10 * 60 * 1000,
  maxCooldownMs: 2 * 60 * 60 * 1000,
}));

const HEADERS = {
  'Referer': 'https://www.nba.com/',
  'Origin': 'https://www.nba.com',
  'x-nba-stats-origin': 'stats',
  'x-nba-stats-token': 'true',
  'User-Agent': 'Mozilla/5.0 (compatible; EdgePickrBot/1.0)',
};

async function _get(url) {
  if (!isSourceEnabled(SOURCE_NAME)) return null;
  await rl.acquire();
  return fetchViaBreaker(url, { allowedHosts: ALLOWED, headers: HEADERS }, breaker);
}

async function healthCheck() {
  if (!isSourceEnabled(SOURCE_NAME)) return { source: SOURCE_NAME, healthy: null, disabled: true };
  const t0 = Date.now();
  const rows = await fetchStandings();
  const latency = Date.now() - t0;
  return { source: SOURCE_NAME, healthy: Array.isArray(rows) && rows.length > 0, latencyMs: latency, breaker: breaker.status() };
}

// Convert NBA row-set (resultSets[0]) to map {teamName → fieldsObject}.
function _parseResultSet(json) {
  const rs = Array.isArray(json?.resultSets) ? json.resultSets[0] : null;
  if (!rs || !Array.isArray(rs.headers) || !Array.isArray(rs.rowSet)) return null;
  const headers = rs.headers.map(h => String(h));
  const rows = rs.rowSet;
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== headers.length) continue;
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i];
    out.push(obj);
  }
  return out;
}

// Season format: "2025-26". Auto-derive from current date.
function currentSeason() {
  const now = new Date();
  const year = now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const next = (year + 1) % 100;
  return `${year}-${String(next).padStart(2, '0')}`;
}

// Fetch league standings for given season. Returns normalized list.
async function fetchStandings(season) {
  const s = season || currentSeason();
  const cacheKey = `nba:standings:${s}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams({
    LeagueID: '00',
    Season: s,
    SeasonType: 'Regular Season',
  });
  const url = `${BASE}/leaguestandings?${params}`;
  const data = await _get(url);
  const rows = _parseResultSet(data);
  if (!rows) { cache.set(cacheKey, null); return null; }

  const teams = rows.map(r => ({
    teamId: r.TeamID,
    teamCity: r.TeamCity,
    teamName: r.TeamName,
    fullName: `${r.TeamCity || ''} ${r.TeamName || ''}`.trim(),
    conference: r.Conference,
    division: r.Division,
    wins: r.WINS,
    losses: r.LOSSES,
    winPct: r.WinPCT,
    homeRecord: r.HOME,        // "W-L" string
    roadRecord: r.ROAD,
    l10: r.L10,
    strCurrentStreak: r.strCurrentStreak,  // "W3" or "L2" etc.
    pointsPG: r.PointsPG,
    oppPointsPG: r.OppPointsPG,
    diffPointsPG: r.DiffPointsPG,
  }));

  cache.set(cacheKey, teams);
  return teams;
}

// Helper: team-row opzoeken op naam (fuzzy). Returns null als niet gevonden.
async function findTeamByName(teamName, season) {
  if (!teamName || typeof teamName !== 'string') return null;
  const all = await fetchStandings(season);
  if (!all) return null;

  const target = teamName.toLowerCase().trim();
  for (const t of all) {
    const full = (t.fullName || '').toLowerCase();
    const city = (t.teamCity || '').toLowerCase();
    const name = (t.teamName || '').toLowerCase();
    if (full.includes(target) || target.includes(full)) return t;
    if (city && target.includes(city) && name && target.includes(name)) return t;
    if (name && (name === target || target.includes(name))) return t;
  }
  return null;
}

// Parse "W-L" record string into {wins, losses}.
function _parseRecord(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  return { wins: parseInt(m[1], 10), losses: parseInt(m[2], 10) };
}

// Parse "W3" / "L2" streak string into { type, count }.
function _parseStreak(s) {
  if (typeof s !== 'string') return null;
  const m = s.match(/^([WL])(\d+)/i);
  if (!m) return null;
  return { type: m[1].toUpperCase(), count: parseInt(m[2], 10) };
}

// Extended team-stats summary for scan use.
async function fetchTeamSummary(teamName, season) {
  const t = await findTeamByName(teamName, season);
  if (!t) return null;
  const home = _parseRecord(t.homeRecord);
  const road = _parseRecord(t.roadRecord);
  const l10 = _parseRecord(t.l10);
  const streak = _parseStreak(t.strCurrentStreak);
  return {
    source: 'nba-stats',
    teamId: t.teamId,
    fullName: t.fullName,
    conference: t.conference,
    wins: t.wins, losses: t.losses,
    winPct: t.winPct,
    homeWin: home?.wins, homeLoss: home?.losses,
    roadWin: road?.wins, roadLoss: road?.losses,
    l10Win: l10?.wins, l10Loss: l10?.losses,
    streakType: streak?.type, streakCount: streak?.count,
    pointsPG: t.pointsPG,
    oppPointsPG: t.oppPointsPG,
    diffPointsPG: t.diffPointsPG,
  };
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
