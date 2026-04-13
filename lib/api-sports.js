'use strict';

const { AF_KEY, sleep, supabase, afRateLimit, sportRateLimits, afCache, teamStatsCache } = require('./config');
const { AF_LEAGUE_MAP } = require('./leagues');

// Load persistent usage from Supabase at startup
(async () => {
  try {
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const { data } = await supabase.from('api_usage').select('*').eq('date', todayStr).single();
    if (data) {
      afRateLimit.remaining = data.remaining;
      afRateLimit.limit = data.api_limit || 7500;
      afRateLimit.updatedAt = data.updated_at;
      afRateLimit.callsToday = data.calls || 0;
      afRateLimit.date = data.date;
    } else {
      afRateLimit.date = todayStr;
      afRateLimit.callsToday = 0;
    }
  } catch { afRateLimit.date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
})();

function saveAfUsage() {
  supabase.from('api_usage').upsert({
    date: afRateLimit.date, calls: afRateLimit.callsToday,
    remaining: afRateLimit.remaining, api_limit: afRateLimit.limit,
    updated_at: new Date().toISOString()
  }).then(() => {}).catch(() => {});
}

async function afGet(host, path, params = {}) {
  if (!AF_KEY) return [];
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `https://${host}${path}${qs ? '?' + qs : ''}`;
  try {
    const r = await fetch(url, {
      headers: { 'x-apisports-key': AF_KEY, Accept: 'application/json' }
    });
    const rem = r.headers.get('x-ratelimit-requests-remaining');
    const lim = r.headers.get('x-ratelimit-requests-limit');
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    if (afRateLimit.date !== todayStr) { afRateLimit.callsToday = 0; afRateLimit.date = todayStr; }
    afRateLimit.callsToday++;
    if (rem !== null) {
      afRateLimit.remaining = parseInt(rem);
      afRateLimit.limit = parseInt(lim) || afRateLimit.limit;
    }
    afRateLimit.updatedAt = new Date().toISOString();
    const sport = host.includes('basketball')        ? 'basketball'
                : host.includes('hockey')            ? 'hockey'
                : host.includes('baseball')          ? 'baseball'
                : host.includes('american-football') ? 'american-football'
                : host.includes('handball')          ? 'handball'
                : 'football';
    const srl = sportRateLimits[sport];
    if (srl.date !== todayStr) { srl.callsToday = 0; srl.date = todayStr; }
    srl.callsToday++;
    saveAfUsage();
    const d = await r.json().catch(() => ({}));
    return d.response || [];
  } catch { return []; }
}

async function enrichWithApiSports(emit) {
  if (!AF_KEY) return;
  emit({ log: '📡 api-sports.io: data ophalen (blessures, H2H, scheidsrechters, vorm)...' });

  let callsUsed = 0;
  const MAX_CALLS = 85;

  afCache.teamStats = {}; afCache.injuries = {}; afCache.referees = {}; afCache.h2h = {};

  for (const [sportKey, cfg] of Object.entries(AF_LEAGUE_MAP)) {
    if (callsUsed >= MAX_CALLS) break;
    try {
      const isSoccer = cfg.host.includes('football');
      const rows = await afGet(cfg.host, '/standings', { league: cfg.league, season: cfg.season });
      callsUsed++;

      const statsMap = {};
      if (isSoccer) {
        for (const entry of (rows[0]?.league?.standings?.[0] || [])) {
          const nm  = entry.team?.name?.toLowerCase();
          const all = entry.all;
          if (!nm || !all) continue;
          const played = all.played || 1;
          const home = entry.home;
          const away = entry.away;
          const homePlayed = home?.played || 1;
          const awayPlayed = away?.played || 1;
          statsMap[nm] = {
            form:         entry.form || '',
            goalsFor:     +(all.goals?.for  / played).toFixed(2),
            goalsAgainst: +(all.goals?.against / played).toFixed(2),
            teamId:       entry.team?.id,
            rank:         entry.rank || 0,
            homeGPG:      +(home?.goals?.for / homePlayed).toFixed(2),
            homeGAPG:     +(home?.goals?.against / homePlayed).toFixed(2),
            awayGPG:      +(away?.goals?.for / awayPlayed).toFixed(2),
            awayGAPG:     +(away?.goals?.against / awayPlayed).toFixed(2),
          };
        }
      } else {
        for (const row of (Array.isArray(rows[0]) ? rows[0] : rows)) {
          const team = row.team || row;
          const nm   = (team.name || '').toLowerCase();
          if (!nm) continue;
          const games = row.games || {};
          const won   = games.wins?.total || 0;
          const lost  = games.loses?.total || games.losses?.total || 0;
          const played = won + lost || 1;
          statsMap[nm] = {
            winPct:      +(won / played).toFixed(3),
            goalsFor:    +(games.points?.for   || 0) / played,
            goalsAgainst: +(games.points?.against || 0) / played,
            teamId:      team.id,
            form:        '',
          };
        }
      }
      afCache.teamStats[sportKey] = statsMap;
      await sleep(120);
    } catch {}
  }
  emit({ log: `✅ Standings: ${Object.keys(afCache.teamStats).length} competities geladen (${callsUsed} calls)` });

  const soccerLeagues = Object.entries(AF_LEAGUE_MAP).filter(([k]) => k.startsWith('soccer'));
  for (const [sportKey, cfg] of soccerLeagues) {
    if (callsUsed >= MAX_CALLS) break;
    try {
      const rows = await afGet(cfg.host, '/injuries', { league: cfg.league, season: cfg.season });
      callsUsed++;
      const injMap = {};
      for (const r of rows) {
        const nm = (r.team?.name || '').toLowerCase();
        if (!nm) continue;
        if (!injMap[nm]) injMap[nm] = [];
        injMap[nm].push({
          player: r.player?.name || '?',
          type:   r.player?.type || r.reason || 'Geblesseerd',
        });
      }
      afCache.injuries[sportKey] = injMap;
      await sleep(120);
    } catch {}
  }
  const injCount = Object.values(afCache.injuries).reduce((s,v) => s + Object.keys(v).length, 0);
  emit({ log: `✅ Blessures: ${injCount} teams met geblesseerde spelers (${callsUsed} calls)` });

  const topLeaguesForRef = ['soccer_epl','soccer_spain_la_liga','soccer_germany_bundesliga',
                            'soccer_italy_serie_a','soccer_france_ligue_one','soccer_netherlands_eredivisie'];
  for (const sportKey of topLeaguesForRef) {
    const cfg = AF_LEAGUE_MAP[sportKey];
    if (!cfg || callsUsed >= MAX_CALLS) break;
    try {
      const rows = await afGet(cfg.host, '/fixtures', {
        league: cfg.league, season: cfg.season, next: 10
      });
      callsUsed++;
      for (const f of rows) {
        const hm  = (f.teams?.home?.name || '').toLowerCase();
        const aw  = (f.teams?.away?.name || '').toLowerCase();
        const ref = f.fixture?.referee || '';
        if (hm && aw && ref) {
          afCache.referees[`${hm} vs ${aw}`] = { name: ref.replace(/, \w+$/, '') };
        }
      }
      await sleep(120);
    } catch {}
  }
  emit({ log: `✅ Scheidsrechters: ${Object.keys(afCache.referees).length} wedstrijden (${callsUsed} calls)` });
  emit({ log: `📊 api-sports klaar · ${callsUsed} calls gebruikt (All Sports · 7500/dag per sport)` });
}

let h2hCallsThisScan = 0;
function resetH2HCalls() { h2hCallsThisScan = 0; }

async function fetchH2H(homeId, awayId) {
  if (!AF_KEY || h2hCallsThisScan >= 5 || !homeId || !awayId) return null;
  const key = `${Math.min(homeId,awayId)}-${Math.max(homeId,awayId)}`;
  if (afCache.h2h[key]) return afCache.h2h[key];
  try {
    h2hCallsThisScan++;
    const rows = await afGet('v3.football.api-sports.io', '/fixtures/headtohead', {
      h2h: `${homeId}-${awayId}`, last: 10
    });
    let hmW=0, awW=0, dr=0, totalGoals=0, btts=0;
    for (const f of rows) {
      const hG = f.goals?.home ?? 0, aG = f.goals?.away ?? 0;
      if (hG > aG) hmW++; else if (hG < aG) awW++; else dr++;
      totalGoals += hG + aG;
      if (hG > 0 && aG > 0) btts++;
    }
    const n = rows.length || 1;
    const result = { hmW, awW, dr, n, avgGoals: +(totalGoals/n).toFixed(1), bttsRate: +(btts/n).toFixed(2) };
    afCache.h2h[key] = result;
    await sleep(120);
    return result;
  } catch { return null; }
}

async function fetchTeamStats(teamId, leagueId, season) {
  if (!AF_KEY || !teamId || !leagueId) return null;
  const cacheKey = `${teamId}-${leagueId}-${season}`;
  if (teamStatsCache[cacheKey]) return teamStatsCache[cacheKey];
  try {
    const data = await afGet('v3.football.api-sports.io', '/teams/statistics', {
      team: teamId, league: leagueId, season
    });
    const stats = Array.isArray(data) ? data[0] : data;
    if (!stats) return null;
    const result = {
      goalsForAvg:     parseFloat(stats.goals?.for?.average?.total) || 0,
      goalsAgainstAvg: parseFloat(stats.goals?.against?.average?.total) || 0,
      goalsForHomeAvg: parseFloat(stats.goals?.for?.average?.home) || 0,
      goalsAgainstAwayAvg: parseFloat(stats.goals?.against?.average?.away) || 0,
      cleanSheet:      stats.clean_sheet?.total || 0,
      cleanSheetPct:   0,
      failedToScore:   stats.failed_to_score?.total || 0,
      failedToScorePct: 0,
      played:          0,
    };
    const played = (stats.fixtures?.played?.total) || 1;
    result.played = played;
    result.cleanSheetPct = +(result.cleanSheet / played).toFixed(3);
    result.failedToScorePct = +(result.failedToScore / played).toFixed(3);
    teamStatsCache[cacheKey] = result;
    await sleep(100);
    return result;
  } catch { return null; }
}

module.exports = {
  afGet, enrichWithApiSports, fetchH2H, fetchTeamStats,
  resetH2HCalls, saveAfUsage,
};
