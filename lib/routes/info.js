'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * v11.2.7-9 · Phase 5.4e: Info/meta read-only routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createInfoRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/version   — APP_VERSION + last 10 model-log entries
 *   - GET /api/changelog — parse CHANGELOG.md → JSON entries (admin-only)
 *   - GET /api/status    — uptime + service status per subsystem + model + stake-regime
 *
 * Status-specifieke deps zijn optional (als niet geleverd, wordt /api/status
 * niet gemount). Info+changelog krijg je altijd.
 *
 * @param {object} deps
 *   - appVersion         — string (APP_VERSION constant)
 *   - loadCalib          — fn () → calibration object (voor modelLog)
 *   - requireAdmin       — Express middleware
 *   - changelogPath      — optional absolute path
 *   - afKey              — optional string (api-football key) voor status
 *   - afRateLimit        — optional object {remaining, limit, callsToday, updatedAt}
 *   - sportRateLimits    — optional object
 *   - getCurrentStakeRegime — optional () → regime|null
 *   - leagues            — optional { football, basketball, hockey, baseball, 'american-football', handball }
 * @returns {express.Router}
 */
module.exports = function createInfoRouter(deps) {
  const { appVersion, loadCalib, requireAdmin } = deps;
  const changelogPath = deps.changelogPath || path.join(__dirname, '..', '..', 'CHANGELOG.md');

  const required = { appVersion, loadCalib, requireAdmin };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createInfoRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // Optional /api/status mount — alleen als status-deps geleverd zijn.
  const { afKey, afRateLimit, sportRateLimits, getCurrentStakeRegime, leagues } = deps;
  if (afRateLimit && sportRateLimits && getCurrentStakeRegime && leagues) {
    router.get('/status', (req, res) => {
      const uptime = process.uptime();
      const c = loadCalib();
      const _regime = getCurrentStakeRegime();
      const leagueMap = (arr) => (arr || []).map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha }));
      res.json({
        version:    appVersion,
        uptime:     Math.round(uptime),
        uptimeStr:  uptime > 86400 ? `${Math.floor(uptime/86400)}d ${Math.floor((uptime%86400)/3600)}h`
                  : uptime > 3600 ? `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`
                  : `${Math.floor(uptime/60)}m`,
        services: {
          apiFootball: {
            status: !!afKey ? 'active' : 'no key',
            plan: 'All Sports',
            remaining: afRateLimit.remaining,
            limit: afRateLimit.limit || 7500,
            callsToday: afRateLimit.callsToday || 0,
            usedPct: Math.round((afRateLimit.callsToday || 0) / (afRateLimit.limit || 7500) * 100),
            updatedAt: afRateLimit.updatedAt,
            perSport: {
              football:            { calls: sportRateLimits.football?.callsToday            || 0, limit: 7500 },
              basketball:          { calls: sportRateLimits.basketball?.callsToday          || 0, limit: 7500 },
              hockey:              { calls: sportRateLimits.hockey?.callsToday              || 0, limit: 7500 },
              baseball:            { calls: sportRateLimits.baseball?.callsToday            || 0, limit: 7500 },
              'american-football': { calls: sportRateLimits['american-football']?.callsToday || 0, limit: 7500 },
              handball:            { calls: sportRateLimits.handball?.callsToday            || 0, limit: 7500 },
            },
          },
          espn: { status: 'active', plan: 'Free', unlimited: true, note: 'Live scores auto-refresh' },
          supabase: { status: 'active', plan: 'Free', unlimited: true, note: 'PostgreSQL · 500MB · bets/users/calibratie/snapshots' },
          webPush: { status: (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) ? 'active' : 'no key', plan: 'Free', unlimited: true, note: 'Operator alerts · picks · model updates (VAPID)' },
          render: { status: 'active', plan: 'Free', unlimited: true, note: 'Hosting + keep-alive elke 14 min' },
          mlbStats: { status: 'active', plan: 'Free', unlimited: true, note: 'MLB pitcher stats (api.mlb.com/api/v1)' },
          nhlPublic: { status: 'active', plan: 'Free', unlimited: true, note: 'NHL shots-differential + lineups' },
          openMeteo: { status: 'active', plan: 'Free', unlimited: true, note: 'Weer voor outdoor wedstrijden (open-meteo.com)' },
        },
        model: {
          totalSettled: c.totalSettled || 0,
          totalWins: c.totalWins || 0,
          lastCalibration: c.modelLastUpdated || null,
          marketsTracked: Object.keys(c.markets || {}).filter(k => (c.markets[k]?.n || 0) > 0).length,
        },
        stakeRegime: _regime ? {
          regime: _regime.regime,
          kellyFraction: _regime.kellyFraction,
          unitMultiplier: _regime.unitMultiplier,
          reasons: _regime.reasons || [],
        } : null,
        leagues: {
          football:            leagueMap(leagues.football),
          basketball:          leagueMap(leagues.basketball),
          hockey:              leagueMap(leagues.hockey),
          baseball:            leagueMap(leagues.baseball),
          'american-football': leagueMap(leagues['american-football']),
          handball:            leagueMap(leagues.handball),
        },
      });
    });
  }

  router.get('/version', (req, res) => {
    const c = loadCalib();
    res.json({
      version:          appVersion,
      modelLog:         (c.modelLog || []).slice(0, 10),
      modelLastUpdated: c.modelLastUpdated || null,
    });
  });

  router.get('/changelog', requireAdmin, (req, res) => {
    try {
      const raw = fs.readFileSync(changelogPath, 'utf8');
      const entries = [];
      // Split op "## [x.y.z] - date" secties
      const blocks = raw.split(/\n(?=## \[)/);
      for (const block of blocks) {
        const hdr = block.match(/^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
        if (!hdr) continue;
        const version = hdr[1], date = hdr[2];
        // Binnen het block: ### Section headers
        const body = block.slice(hdr[0].length).trim();
        const sections = [];
        const parts = body.split(/\n(?=### )/);
        for (const p of parts) {
          const sh = p.match(/^### ([^\n]+)/);
          if (!sh) continue;
          const title = sh[1].trim();
          const text = p.slice(sh[0].length).trim();
          sections.push({ title, text });
        }
        entries.push({ version, date, sections });
      }
      res.json({ version: appVersion, entries });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Kan CHANGELOG niet lezen' });
    }
  });

  return router;
};
