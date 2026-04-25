'use strict';

const express = require('express');
const { summarizeSharpSoftWindows } = require('../sharp-soft-windows');
const { SHARP_BOOKIES } = require('../line-timeline');

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
 *   - GET /api/admin/v2/sharp-soft-windows — execution-edge windows waar soft-
 *     book (preferred) gunstiger staat dan sharp consensus. v12.2.17 (R4 wiring).
 *
 * @param {object} deps
 *   - supabase                — Supabase client
 *   - requireAdmin            — Express middleware
 *   - autoTuneSignalsByClv    — async () → result object
 *   - loadUsers               — async () → users[] (voor preferred-bookies van admin)
 * @returns {express.Router}
 */
module.exports = function createAdminSnapshotsRouter(deps) {
  const { supabase, requireAdmin, autoTuneSignalsByClv, loadUsers } = deps;

  const required = { supabase, requireAdmin, autoTuneSignalsByClv, loadUsers };
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
      // v11.3.23 H3: no raw e.message to client.
      console.error('[admin-snapshots]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // v12.2.17 (R4 wiring): execution-edge windows. Aggregeert recent
  // odds_snapshots over fixtures in [now, now+lookaheadHours] en returnt
  // markten waar best soft-bookie odd > best sharp-bookie odd impliceert dat
  // de soft markt achterloopt → execution-edge window.
  router.get('/admin/v2/sharp-soft-windows', requireAdmin, async (req, res) => {
    try {
      const lookaheadHours = Math.max(1, Math.min(72, parseInt(req.query.lookahead_hours) || 24));
      const minGapPp = Math.max(0.005, Math.min(0.20, parseFloat(req.query.min_gap_pp) || 0.02));
      const sinceLookbackHours = Math.max(1, Math.min(24, parseInt(req.query.lookback_hours) || 6));

      const nowIso = new Date().toISOString();
      const untilIso = new Date(Date.now() + lookaheadHours * 3600 * 1000).toISOString();
      const sinceIso = new Date(Date.now() - sinceLookbackHours * 3600 * 1000).toISOString();

      const { data: fixtures } = await supabase.from('fixtures')
        .select('id, start_time, home_team_name, away_team_name, sport')
        .gte('start_time', nowIso)
        .lte('start_time', untilIso)
        .limit(500);
      const fxList = Array.isArray(fixtures) ? fixtures : [];
      if (!fxList.length) return res.json({ windows: [], lookaheadHours, minGapPp, count: 0 });

      const fxMap = new Map(fxList.map(f => [f.id, f]));
      const fixtureIds = fxList.map(f => f.id);

      const { data: snaps } = await supabase.from('odds_snapshots')
        .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
        .in('fixture_id', fixtureIds)
        .gte('captured_at', sinceIso)
        .limit(20000);
      const snapList = Array.isArray(snaps) ? snaps : [];

      const users = await loadUsers().catch(() => []);
      const admin = users.find(u => u.role === 'admin');
      const preferred = (admin?.settings?.preferredBookies || ['Bet365', 'Unibet'])
        .map(x => String(x || '').toLowerCase()).filter(Boolean);
      const softSet = new Set(preferred);

      const windows = summarizeSharpSoftWindows({
        snapshots: snapList,
        fixtures: fxMap,
        sharpSet: SHARP_BOOKIES,
        softSet,
        threshold: minGapPp,
      });

      res.json({
        lookaheadHours,
        lookbackHours: sinceLookbackHours,
        minGapPp,
        sinceIso,
        nowIso,
        untilIso,
        count: windows.length,
        windows: windows.slice(0, 100), // top 100 by absolute gap
      });
    } catch (e) {
      console.error('[admin-snapshots]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  return router;
};
