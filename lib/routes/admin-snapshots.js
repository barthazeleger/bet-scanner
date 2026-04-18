'use strict';

const express = require('express');

/**
 * v11.3.3 · Phase 5.4k: Admin snapshot/tuning utilities extracted.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminSnapshotsRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/admin/v2/snapshot-counts?hours=24 — totaal + recent per v2 tabel
 *     (fixtures, odds_snapshots, feature_snapshots, market_consensus, model_runs,
 *     pick_candidates). Health-check of de snapshot-polling werkt.
 *   - POST /api/admin/v2/autotune-clv — trigger handmatige CLV-based signal
 *     weight tuning (zelfde code-pad als de 6-hourly cron).
 *
 * @param {object} deps
 *   - supabase                — Supabase client
 *   - requireAdmin            — Express middleware
 *   - autoTuneSignalsByClv    — async () → result object
 * @returns {express.Router}
 */
module.exports = function createAdminSnapshotsRouter(deps) {
  const { supabase, requireAdmin, autoTuneSignalsByClv } = deps;

  const required = { supabase, requireAdmin, autoTuneSignalsByClv };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminSnapshotsRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.post('/admin/v2/autotune-clv', requireAdmin, async (req, res) => {
    try {
      const result = await autoTuneSignalsByClv();
      res.json(result);
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/admin/v2/snapshot-counts', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const tables = ['fixtures', 'odds_snapshots', 'feature_snapshots', 'market_consensus', 'model_runs', 'pick_candidates'];
      const counts = {};
      for (const t of tables) {
        const { count: total } = await supabase.from(t).select('*', { count: 'exact', head: true });
        const field = t === 'odds_snapshots' || t === 'feature_snapshots' || t === 'market_consensus' || t === 'model_runs' ? 'captured_at' : 'created_at';
        const { count: recent } = await supabase.from(t).select('*', { count: 'exact', head: true })
          .gte(field, sinceIso);
        counts[t] = { total: total || 0, recent: recent || 0 };
      }
      res.json({ hours, counts, sinceIso });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Interne fout' });
    }
  });

  return router;
};
