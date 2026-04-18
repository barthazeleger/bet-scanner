'use strict';

const express = require('express');

/**
 * v11.3.4 · Phase 5.4l: Admin signal/model-feed routes extracted.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminSignalsRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/admin/v2/signal-performance — persisted `signal_stats` tabel
 *     (simpelste read: order by avg_clv desc). Gebruikt voor ingelogde signal
 *     metrics uit aparte berekening (Phase B.4 walk-forward).
 *   - GET /api/admin/signal-performance — live analytics: parse elke bet's
 *     signals + summarize via `summarizeSignalMetrics`. Classifeert per signal:
 *     auto_promotable / logging_positive / logging / active / mute_candidate.
 *   - GET /api/model-feed — calibratie-feed voor admin UI: modelLog, signal
 *     weights, market-multipliers, ep-buckets, aggregate perSport.
 *
 * @param {object} deps
 *   - supabase                  — Supabase client
 *   - requireAdmin              — Express middleware
 *   - loadCalib                 — fn () → calibration object
 *   - loadSignalWeights         — fn () → object (signal name → weight)
 *   - summarizeSignalMetrics    — fn (betMeta[]) → { signals: {name: {n, avgClv, shrunkExcessClv, posClvRate}} }
 *   - parseBetSignals           — fn (raw) → array
 *   - normalizeSport, detectMarket — pure helpers
 * @returns {express.Router}
 */
module.exports = function createAdminSignalsRouter(deps) {
  const {
    supabase, requireAdmin,
    loadCalib, loadSignalWeights,
    summarizeSignalMetrics, parseBetSignals,
    normalizeSport, detectMarket,
  } = deps;

  const required = {
    supabase, requireAdmin, loadCalib, loadSignalWeights,
    summarizeSignalMetrics, parseBetSignals, normalizeSport, detectMarket,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminSignalsRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/admin/v2/signal-performance', requireAdmin, async (req, res) => {
    try {
      const { data, error } = await supabase.from('signal_stats')
        .select('*').order('avg_clv', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      res.json({ signals: data || [] });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/admin/signal-performance', requireAdmin, async (req, res) => {
    try {
      const { data: bets, error } = await supabase.from('bets')
        .select('signals, clv_pct, sport, markt').not('clv_pct', 'is', null)
        .limit(10000);
      if (error) return res.status(500).json({ error: error.message });

      const weights = loadSignalWeights();
      const signalStats = summarizeSignalMetrics((bets || []).map(b => ({
        marketKey: `${normalizeSport(b.sport || 'football')}_${detectMarket(b.markt || 'other')}`,
        clvPct: b.clv_pct,
        signalNames: parseBetSignals(b.signals).map(s => String(s || '').split(':')[0]).filter(Boolean),
      }))).signals;

      const rows = Object.entries(signalStats).map(([name, s]) => {
        const avgClv = +(s.avgClv).toFixed(2);
        const edgeClv = +(s.shrunkExcessClv).toFixed(2);
        const posPct = +(s.posClvRate * 100).toFixed(1);
        const weight = weights[name] !== undefined ? weights[name] : 0;
        let status = 'logging';
        if (weight === 0 && s.n >= 50 && edgeClv >= 0.75 && avgClv > 0) status = 'auto_promotable';
        else if (weight === 0 && s.n >= 20 && edgeClv > 0) status = 'logging_positive';
        else if (weight === 0) status = 'logging';
        else if (weight > 0) status = 'active';
        if (s.n >= 50 && edgeClv <= -1.5 && avgClv <= -0.5) status = 'mute_candidate';
        return {
          name, n: s.n, avgClv, edgeClv, posCLV_pct: posPct,
          weight: +(weight.toFixed ? weight.toFixed(3) : weight), status,
        };
      }).sort((a, b) => b.n - a.n);

      res.json({
        signals: rows,
        thresholds: {
          SIGNAL_PROMOTE_MIN_N: 50,
          SIGNAL_KILL_MIN_N: 50,
          SIGNAL_KILL_CLV_PCT: -3.0,
          SIGNAL_PROMOTE_WEIGHT: 0.5,
        },
        totalSignals: rows.length,
        totalBetsAnalyzed: (bets || []).length,
      });
    } catch (e) {
      console.error('signal-performance error:', e);
      res.status(500).json({ error: (e && e.message) || 'Interne fout' });
    }
  });

  router.get('/model-feed', requireAdmin, (req, res) => {
    const c = loadCalib();
    const sw = loadSignalWeights();
    // Aggregeer per sport door de sport_markt buckets te splitten op eerste underscore.
    const markets = c.markets || {};
    const perSportMap = {};
    for (const [key, m] of Object.entries(markets)) {
      if (!m || !m.n) continue;
      const idx = key.indexOf('_');
      const sport = idx > 0 ? key.slice(0, idx) : 'football';
      if (!perSportMap[sport]) perSportMap[sport] = { sport, n: 0, w: 0, profit: 0 };
      perSportMap[sport].n += m.n;
      perSportMap[sport].w += m.w;
      perSportMap[sport].profit += m.profit;
    }
    const perSport = Object.values(perSportMap)
      .map(s => ({ ...s, winrate: s.n ? Math.round(s.w / s.n * 100) : 0, profit: +s.profit.toFixed(2) }))
      .sort((a, b) => b.n - a.n);
    res.json({
      log: (c.modelLog || []).slice(0, 30),
      lastUpdated: c.modelLastUpdated || null,
      totalSettled: c.totalSettled || 0,
      signalWeights: sw,
      markets,
      epBuckets: c.epBuckets || {},
      perSport,
    });
  });

  return router;
};
