'use strict';

const express = require('express');
const { summarizeSharpSoftWindows } = require('../sharp-soft-windows');
const { SHARP_BOOKIES } = require('../line-timeline');
const { buildBrierRecords, diagnoseJoinFailure } = require('../bets-pick-join');
const { computeBrier, computeLogLoss } = require('../walk-forward');
const { compareDevigOnSnapshots } = require('../devig-backtest');

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
      const includeMirror = req.query.include_mirror === '1' || req.query.include_mirror === 'true';

      const nowIso = new Date().toISOString();
      const untilIso = new Date(Date.now() + lookaheadHours * 3600 * 1000).toISOString();
      const sinceIso = new Date(Date.now() - sinceLookbackHours * 3600 * 1000).toISOString();

      const { data: fixtures } = await supabase.from('fixtures')
        .select('id, start_time, home_team_name, away_team_name, sport')
        .gte('start_time', nowIso)
        .lte('start_time', untilIso)
        .limit(500);
      const fxList = Array.isArray(fixtures) ? fixtures : [];
      if (!fxList.length) return res.json({
        windows: [], lookaheadHours, lookbackHours: sinceLookbackHours,
        minGapPp, includeMirror, sinceIso, nowIso, untilIso, count: 0,
      });

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
        includeMirror,
      });

      res.json({
        lookaheadHours,
        lookbackHours: sinceLookbackHours,
        minGapPp,
        includeMirror,
        sinceIso,
        nowIso,
        untilIso,
        count: windows.length,
        windows: windows.slice(0, 100),
      });
    } catch (e) {
      console.error('[admin-snapshots]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // v12.2.21 (R2 partial + R3 diag): model Brier vs market Brier.
  // Joint settled bets met pick_candidates → fair_prob. Records zonder
  // join vallen terug op market-implied prob (1/odds). Output: per-source
  // Brier + log-loss + sample counts. Geeft signaal of het model écht
  // toegevoegde waarde levert boven markt-baseline.
  router.get('/admin/v2/model-brier', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(7, Math.min(365, parseInt(req.query.days) || 90));
      const sinceIso = new Date(Date.now() - days * 86400 * 1000).toISOString();

      const { data: bets } = await supabase.from('bets')
        .select('bet_id, fixture_id, datum, tijd, markt, tip, odds, units, uitkomst, sport')
        .in('uitkomst', ['W', 'L'])
        .gte('created_at', sinceIso)
        .limit(5000);
      const settled = Array.isArray(bets) ? bets.filter(b => b.fixture_id != null) : [];
      if (!settled.length) return res.json({ days, totalSettled: 0, model: null, market: null, comparison: null });

      const fixtureIds = [...new Set(settled.map(b => b.fixture_id))];
      const { data: cands } = await supabase.from('pick_candidates')
        .select('id, model_run_id, fixture_id, selection_key, bookmaker, fair_prob, bookmaker_odds, passed_filters, model_runs!inner(market_type, line, captured_at)')
        .in('fixture_id', fixtureIds)
        .limit(20000);
      const candList = Array.isArray(cands) ? cands : [];

      const candByFixture = new Map();
      for (const c of candList) {
        const fid = Number(c.fixture_id);
        if (!candByFixture.has(fid)) candByFixture.set(fid, []);
        candByFixture.get(fid).push(c);
      }

      const records = buildBrierRecords(settled, candByFixture);
      const modelRecs = records.filter(r => r.source === 'model');
      const marketRecs = records.filter(r => r.source === 'market');

      // v12.2.45 (audit P2.4): coverage-breakdown — diagnose waarom join faalt.
      const failureBreakdown = { matched: 0, no_candidate: 0, market_mismatch: 0, selection_mismatch: 0, line_mismatch: 0, bookmaker_mismatch: 0, bet_unparseable: 0 };
      for (const bet of settled) {
        const cands = candByFixture.get(Number(bet.fixture_id)) || [];
        const diag = diagnoseJoinFailure(bet, cands);
        if (failureBreakdown[diag.category] != null) failureBreakdown[diag.category]++;
      }

      const modelBrier = computeBrier(modelRecs);
      const marketBrier = computeBrier(marketRecs);
      const modelLog = computeLogLoss(modelRecs);
      const marketLog = computeLogLoss(marketRecs);

      // Eerlijke head-to-head: alleen op de overlap waar BEIDE beschikbaar zijn.
      // Voor model recs hebben we nu ook 1/odds als alternatief — bouw mirrored set.
      const overlapRecs = modelRecs.map(r => {
        const bet = settled.find(b => b.bet_id === r.bet_id);
        return bet && Number(bet.odds) > 1
          ? { predicted_prob: 1 / Number(bet.odds), outcome_binary: r.outcome_binary }
          : null;
      }).filter(Boolean);
      const marketOnOverlap = computeBrier(overlapRecs);

      res.json({
        days,
        totalSettled: settled.length,
        joinCoverage: {
          model: modelRecs.length,
          marketOnly: marketRecs.length,
          coveragePct: settled.length ? +(modelRecs.length / settled.length * 100).toFixed(1) : 0,
          failureBreakdown,
        },
        model: { brier: modelBrier.score, logLoss: modelLog.score, n: modelBrier.n },
        market: { brier: marketBrier.score, logLoss: marketLog.score, n: marketBrier.n },
        headToHead: modelRecs.length >= 30 ? {
          modelBrier: modelBrier.score,
          marketBrier: marketOnOverlap.score,
          delta: marketOnOverlap.score != null && modelBrier.score != null
            ? +(marketOnOverlap.score - modelBrier.score).toFixed(5) : null,
          interpretation: modelBrier.score == null || marketOnOverlap.score == null
            ? 'insufficient_data'
            : (modelBrier.score < marketOnOverlap.score ? 'model_beats_market' : 'market_beats_model'),
          n: modelRecs.length,
        } : { reason: 'insufficient_join_coverage', minimumNeeded: 30, have: modelRecs.length },
      });
    } catch (e) {
      console.error('[admin-snapshots]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // v12.2.22 (R1 spike): backtest log-margin vs proportional devig op recente
  // odds_snapshots. Antwoord op audit-vraag "is log-margin marginaal preciezer?".
  // Returnt mean/max abs diff in pp + distributie-buckets + top-10 grootste.
  router.get('/admin/v2/devig-backtest', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(72, parseInt(req.query.hours) || 24));
      const minBookies = Math.max(2, Math.min(10, parseInt(req.query.min_bookmakers) || 3));
      const sharpOnly = req.query.sharp_only === '1' || req.query.sharp_only === 'true';
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data: snaps } = await supabase.from('odds_snapshots')
        .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
        .gte('captured_at', sinceIso)
        .limit(20000);
      const result = compareDevigOnSnapshots(Array.isArray(snaps) ? snaps : [], {
        minBookmakers: minBookies,
        sharpOnly,
      });
      res.json({ hours, minBookmakers: minBookies, sharpOnly, ...result });
    } catch (e) {
      console.error('[admin-snapshots]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  return router;
};
