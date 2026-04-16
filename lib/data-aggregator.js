'use strict';

// v10.9.0: Data aggregator — unified interface voor H2H, team-form en team-stats.
// Merged meerdere sources, dedupliceert op event-level, faalt gracefully.
//
// Design principes:
//   - Elke source-module implementeert subset van: fetchH2HEvents, fetchTeamFormEvents, fetchTeamSummary
//   - Aggregator roept alle ENABLED sources parallel aan per sport
//   - Events gededupliceerd op (date + sorted team-pair) → geen dubbel-tellen
//   - Bij fail van een source: skip, gebruik wat er wel is
//   - Master-kill-switch: OPERATOR.scraping_enabled respecteert aggregator niet direct;
//     caller in server.js moet deze check doen voor aggregator-calls
//
// Terugwaartse compatibiliteit: als geen enkele source enabled/werkt → aggregator
// returnt null / {events:[]} zodat caller kan falbacken op api-football.

const sofascore = require('./sources/sofascore');
const fotmob = require('./sources/fotmob');
const nbaStats = require('./sources/nba-stats');
const nhlApi = require('./sources/nhl-api');
const mlbExt = require('./sources/mlb-stats-ext');

const { normalizeTeamKey } = require('./scraper-base');

// Source-registry per sport. Elke sport-entry noemt welke sources beschikbaar zijn
// voor welk doel (h2h, form, summary). Sources worden sequentially geprobeerd,
// de aggregator verzamelt events van allemaal voor merge.
const SPORT_SOURCES = {
  football: {
    h2h: [sofascore, fotmob],
    form: [sofascore, fotmob],
    summary: [],
  },
  basketball: {
    h2h: [sofascore],
    form: [sofascore],
    summary: [nbaStats],
  },
  hockey: {
    h2h: [sofascore],
    form: [sofascore],
    summary: [nhlApi],
  },
  baseball: {
    h2h: [sofascore],
    form: [sofascore],
    summary: [mlbExt],
  },
  handball: {
    h2h: [sofascore],
    form: [sofascore],
    summary: [],
  },
  volleyball: {
    h2h: [sofascore],
    form: [sofascore],
    summary: [],
  },
  'american-football': {
    h2h: [],
    form: [],
    summary: [],
  },
};

// Deduplicate H2H events op (date, sorted team-pair normalized).
// Behoudt de eerste event bij duplicates.
function _dedupH2H(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const date = e.date || 'unknown';
    const a = normalizeTeamKey(e.homeTeam || '');
    const b = normalizeTeamKey(e.awayTeam || '');
    const pair = [a, b].sort().join('|');
    const key = `${date}::${pair}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// Compute aggregates vanuit dedup'ed H2H events.
function _summarizeH2H(events, team1Name, team2Name) {
  let n = 0, btts = 0, over25 = 0, totalGoals = 0;
  let team1Wins = 0, team2Wins = 0, draws = 0;
  const t1 = normalizeTeamKey(team1Name || '');
  const t2 = normalizeTeamKey(team2Name || '');
  const sources = new Set();
  for (const e of events) {
    const hs = e.homeScore, as = e.awayScore;
    if (typeof hs !== 'number' || typeof as !== 'number') continue;
    n++;
    totalGoals += hs + as;
    if (e.btts === true || (hs > 0 && as > 0)) btts++;
    if (hs + as > 2.5) over25++;
    const homeKey = normalizeTeamKey(e.homeTeam || '');
    const homeWon = hs > as, awayWon = as > hs;
    if (hs === as) draws++;
    else if (homeKey === t1 && homeWon) team1Wins++;
    else if (homeKey === t2 && homeWon) team2Wins++;
    else if (homeKey === t1 && awayWon) team2Wins++;
    else if (homeKey === t2 && awayWon) team1Wins++;
    if (e.source) sources.add(e.source);
  }
  return {
    n, btts, over25, draws, team1Wins, team2Wins,
    bttsRate: n > 0 ? +(btts / n).toFixed(3) : 0,
    over25Rate: n > 0 ? +(over25 / n).toFixed(3) : 0,
    avgGoals: n > 0 ? +(totalGoals / n).toFixed(2) : 0,
    sources: Array.from(sources),
  };
}

// Haal H2H data van alle enabled sources voor een sport. Merged + dedup.
// Fail-safe: elke source-fail wordt gelogd maar breekt niet de aggregator.
async function getMergedH2H(sport, team1Name, team2Name) {
  if (!team1Name || !team2Name) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.h2h) || !reg.h2h.length) return null;

  const results = await Promise.all(reg.h2h.map(async src => {
    try {
      if (typeof src.fetchH2HEvents !== 'function') return [];
      // SofaScore takes sport as 3rd param; FotMob is football-only.
      const events = src === sofascore
        ? await src.fetchH2HEvents(team1Name, team2Name, sport)
        : await src.fetchH2HEvents(team1Name, team2Name);
      return Array.isArray(events) ? events : [];
    } catch {
      return [];
    }
  }));

  const merged = _dedupH2H(results.flat());
  if (!merged.length) return null;

  const summary = _summarizeH2H(merged, team1Name, team2Name);
  return { events: merged, ...summary };
}

// Deduplicate form events per-team (by date). Behoud eerste.
function _dedupFormEvents(events) {
  const seen = new Set();
  const out = [];
  for (const e of events) {
    if (!e || typeof e !== 'object') continue;
    const date = e.date || `${e.myScore}-${e.oppScore}-${e.oppName || ''}`;
    const key = `${date}::${normalizeTeamKey(e.oppName || '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function _summarizeForm(events) {
  let w = 0, d = 0, l = 0, gf = 0, ga = 0, cs = 0;
  let formStr = '';
  const sources = new Set();
  const sorted = [...events].sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) : 0;
    const tb = b.date ? Date.parse(b.date) : 0;
    return tb - ta; // nieuwste eerst
  });
  for (const e of sorted) {
    const my = e.myScore, opp = e.oppScore;
    if (typeof my !== 'number' || typeof opp !== 'number') continue;
    gf += my; ga += opp;
    if (opp === 0) cs++;
    if (my > opp) { w++; formStr = 'W' + formStr; }
    else if (my < opp) { l++; formStr = 'L' + formStr; }
    else { d++; formStr = 'D' + formStr; }
    if (e.source) sources.add(e.source);
  }
  const n = w + d + l;
  if (n === 0) return null;
  return {
    n, w, d, l,
    gfPerGame: +(gf / n).toFixed(2),
    gaPerGame: +(ga / n).toFixed(2),
    cleanSheets: cs,
    cleanSheetPct: +(cs / n).toFixed(3),
    form: formStr.slice(0, 10),
    sources: Array.from(sources),
  };
}

async function getMergedForm(sport, teamName, limit = 10) {
  if (!teamName) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.form) || !reg.form.length) return null;

  const results = await Promise.all(reg.form.map(async src => {
    try {
      if (typeof src.fetchTeamFormEvents !== 'function') return [];
      const events = src === sofascore
        ? await src.fetchTeamFormEvents(teamName, sport, limit)
        : await src.fetchTeamFormEvents(teamName, limit);
      return Array.isArray(events) ? events : [];
    } catch {
      return [];
    }
  }));

  const merged = _dedupFormEvents(results.flat()).slice(0, limit);
  if (!merged.length) return null;

  const summary = _summarizeForm(merged);
  if (!summary) return null;
  return { events: merged, ...summary };
}

async function getTeamSummary(sport, teamName) {
  if (!teamName) return null;
  const reg = SPORT_SOURCES[sport];
  if (!reg || !Array.isArray(reg.summary) || !reg.summary.length) return null;

  for (const src of reg.summary) {
    try {
      if (typeof src.fetchTeamSummary !== 'function') continue;
      const s = await src.fetchTeamSummary(teamName);
      if (s) return s;
    } catch { /* try next */ }
  }
  return null;
}

// Aggregate health across all registered sources.
async function healthCheckAll() {
  const sources = [sofascore, fotmob, nbaStats, nhlApi, mlbExt];
  const results = await Promise.all(sources.map(async src => {
    try { return await src.healthCheck(); }
    catch (e) { return { source: src.SOURCE_NAME, healthy: false, error: e.message }; }
  }));
  return results;
}

module.exports = {
  SPORT_SOURCES,
  getMergedH2H,
  getMergedForm,
  getTeamSummary,
  healthCheckAll,
  // Exported voor tests:
  _dedupH2H,
  _summarizeH2H,
  _dedupFormEvents,
  _summarizeForm,
};
