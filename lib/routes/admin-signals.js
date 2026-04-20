'use strict';

const express = require('express');
const { supportsClvForBetMarkt } = require('../clv-match');

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
      if (error) { console.error('[admin-signals]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }
      res.json({ signals: data || [] });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/admin/signal-performance', requireAdmin, async (req, res) => {
    try {
      const { data: bets, error } = await supabase.from('bets')
        .select('signals, clv_pct, sport, markt').not('clv_pct', 'is', null)
        .limit(10000);
      if (error) { console.error('[admin-signals]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }

      const weights = loadSignalWeights();
      const usable = (bets || []).filter(b =>
        typeof b.clv_pct === 'number' &&
        !isNaN(b.clv_pct) &&
        supportsClvForBetMarkt(b.markt)
      );
      const signalStats = summarizeSignalMetrics(usable.map(b => ({
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
      // v11.3.23 H3: no raw e.message to client.
      console.error('[signal-performance]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  router.get('/model-feed', requireAdmin, (req, res) => {
    const c = loadCalib();
    const sw = loadSignalWeights();
    // v12.1.0 (operator-rapport): oud sport-detect was fout. `key.slice(0, idx)`
    // voor 'btts_yes' gaf sport='btts' → werd als aparte sport gezien terwijl
    // het een football-markt is. Plus: legacy unprefixed keys (home/away/over/
    // under/draw) werden NAAST football_home/away geteld → dubbele telling
    // voor football. Bart's symptoom: voetbal-totaal in Model tab > totaal in
    // tracker.
    //
    // Fix: whitelist known sport-prefixes. Alles anders valt onder football
    // (of 'other' als het niet identificeerbaar is). Dubbeltelling voorkomen
    // door prefix-match strict te houden.
    const KNOWN_SPORTS = ['football', 'basketball', 'hockey', 'baseball', 'american-football', 'handball'];
    const detectSportFromKey = (key) => {
      for (const s of KNOWN_SPORTS) {
        if (key === s || key.startsWith(`${s}_`)) return s;
      }
      return 'football';
    };
    const markets = c.markets || {};
    const perSportMap = {};
    for (const [key, m] of Object.entries(markets)) {
      if (!m || !m.n) continue;
      const sport = detectSportFromKey(key);
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
