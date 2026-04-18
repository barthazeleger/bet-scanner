'use strict';

const express = require('express');

/**
 * v11.3.6 · Phase 5.4n: Admin-sources cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminSourcesRouter({...}))`.
 *
 * Verantwoordelijkheden (scrape/data-source operator-tools):
 *   - GET  /api/admin/v2/scrape-diagnose?name=X — live probe één bron met detail-error
 *   - GET  /api/admin/v2/scrape-sources         — health + breaker + enabled-flag status
 *   - POST /api/admin/v2/scrape-sources         — enable/disable source of reset breaker
 *
 * @param {object} deps
 *   - requireAdmin    — Express middleware
 *   - operator        — OPERATOR shared state (leest scraping_enabled)
 *   - loadCalib       — fn () → calibration object
 *   - saveCalib       — async (c) → void
 * @returns {express.Router}
 */
module.exports = function createAdminSourcesRouter(deps) {
  const { requireAdmin, operator, loadCalib, saveCalib } = deps;

  const required = { requireAdmin, operator, loadCalib, saveCalib };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminSourcesRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  const VALID_SOURCE_NAMES = ['sofascore', 'fotmob', 'nba-stats', 'nhl-api', 'mlb-stats-ext'];

  // GET /api/admin/v2/scrape-diagnose?name=X — live-test één bron met detail-error
  // (HTTP status + error reason) via safeFetch returnDetails=true. Diagnostiek.
  router.get('/admin/v2/scrape-diagnose', requireAdmin, async (req, res) => {
    try {
      const { safeFetch } = require('../integrations/scraper-base');
      const name = String(req.query.name || '').trim();
      const probes = {
        'sofascore': { url: 'https://api.sofascore.com/api/v1/search/suggestions/Arsenal', hosts: ['api.sofascore.com'] },
        'fotmob': { url: 'https://www.fotmob.com/api/searchapi/suggest?term=Arsenal', hosts: ['www.fotmob.com'] },
        'nba-stats': { url: 'https://stats.nba.com/stats/leaguestandings?LeagueID=00&Season=2025-26&SeasonType=Regular+Season', hosts: ['stats.nba.com'],
          headers: {
            'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
            'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
          } },
        'nhl-api': { url: 'https://api-web.nhle.com/v1/standings/now', hosts: ['api-web.nhle.com'] },
        'mlb-stats-ext': { url: 'https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025', hosts: ['statsapi.mlb.com'] },
      };
      const probe = probes[name];
      if (!probe) return res.status(400).json({ error: 'unknown source', allowed: Object.keys(probes) });
      const t0 = Date.now();
      const result = await safeFetch(probe.url, {
        allowedHosts: probe.hosts,
        headers: probe.headers || {},
        returnDetails: true,
      });
      const latency = Date.now() - t0;
      res.json({
        source: name,
        url: probe.url,
        latencyMs: latency,
        ...result,
        sample: result.data ? JSON.stringify(result.data).slice(0, 400) : null,
      });
    } catch (e) {
      res.status(500).json({ error: 'diagnose failed', detail: e.message });
    }
  });

  // GET /api/admin/v2/scrape-sources — status alle externe data-sources.
  // Levert health, breaker state, enabled-flag.
  router.get('/admin/v2/scrape-sources', requireAdmin, async (req, res) => {
    try {
      const dataAggregator = require('../integrations/data-aggregator');
      const scraperBase = require('../integrations/scraper-base');
      const [health, breakers] = await Promise.all([
        dataAggregator.healthCheckAll(),
        Promise.resolve(scraperBase.allBreakerStatuses()),
      ]);
      res.json({
        scraping_enabled: operator.scraping_enabled,
        sources: scraperBase.listSources(),
        health,
        breakers,
      });
    } catch (e) {
      res.status(500).json({ error: 'scrape-sources fetch failed', detail: e.message });
    }
  });

  // POST /api/admin/v2/scrape-sources — enable/disable source runtime, persist naar calib.
  // Body: { name: 'sofascore', enabled: true } of { action: 'reset-breaker', name: 'sofascore' }
  router.post('/admin/v2/scrape-sources', requireAdmin, async (req, res) => {
    try {
      const scraperBase = require('../integrations/scraper-base');
      const body = req.body || {};
      if (body.action === 'reset-breaker') {
        if (!VALID_SOURCE_NAMES.includes(body.name)) return res.status(400).json({ error: 'unknown source' });
        const b = scraperBase.getBreaker(body.name);
        if (b) b.reset();
        return res.json({ ok: true, action: 'reset-breaker', name: body.name });
      }
      if (!VALID_SOURCE_NAMES.includes(body.name)) {
        return res.status(400).json({ error: 'unknown source; allowed: ' + VALID_SOURCE_NAMES.join(', ') });
      }
      scraperBase.setSourceEnabled(body.name, !!body.enabled);
      const cs = loadCalib();
      cs.scraper_sources = cs.scraper_sources || {};
      cs.scraper_sources[body.name] = !!body.enabled;
      await saveCalib(cs).catch(() => {});
      res.json({ ok: true, name: body.name, enabled: !!body.enabled, persisted: true });
    } catch (e) {
      res.status(500).json({ error: 'scrape-sources update failed', detail: e.message });
    }
  });

  return router;
};
