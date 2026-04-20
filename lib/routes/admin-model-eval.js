'use strict';

const express = require('express');
const { supportsClvForBetMarkt } = require('../clv-match');

/**
 * v11.3.9 · Phase 5.4q: Admin model-eval cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminModelEvalRouter({...}))`.
 *
 * Verantwoordelijkheden (model/calibration evaluatie + attribution + training):
 *   - GET  /api/admin/v2/walkforward              — Brier/log-loss + calibration buckets over bets-window
 *   - POST /api/admin/v2/training-examples-build  — schrijf training_examples voor settled bets
 *   - GET  /api/admin/v2/drift                    — windowed CLV drift per markt/signaal/bookie
 *   - GET  /api/admin/v2/why-this-pick?bet_id=X   — attribution: baseline + delta + signals + execution
 *
 * @param {object} deps
 *   - supabase                       — Supabase client
 *   - requireAdmin                   — Express middleware
 *   - loadUsers                      — async () → users[]
 *   - normalizeSport                 — lib/model-math helper
 *   - detectMarket                   — lib/model-math helper
 *   - normalizeBookmaker             — lib/execution-quality helper
 *   - summarizeExecutionQuality      — lib/execution-quality helper
 *   - writeTrainingExamplesForSettled — async () → number
 * @returns {express.Router}
 */
module.exports = function createAdminModelEvalRouter(deps) {
  const {
    supabase, requireAdmin, loadUsers,
    normalizeSport, detectMarket, normalizeBookmaker,
    summarizeExecutionQuality, writeTrainingExamplesForSettled,
  } = deps;

  const required = {
    supabase, requireAdmin, loadUsers,
    normalizeSport, detectMarket, normalizeBookmaker,
    summarizeExecutionQuality, writeTrainingExamplesForSettled,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminModelEvalRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // GET /api/admin/v2/walkforward?sport=hockey&days=30 — Brier score + log-loss + calibration buckets.
  // Gebruikt impliciete prob uit logged odds als proxy (pas bij ≥500 pick_candidates per markt
  // kunnen we op echte model-prob walk-forward draaien).
  router.get('/admin/v2/walkforward', requireAdmin, async (req, res) => {
    try {
      const sport = req.query.sport ? normalizeSport(req.query.sport) : null;
      const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

      const { data: bets, error: betsErr } = await supabase.from('bets')
        .select('bet_id, sport, markt, odds, uitkomst, wl, clv_pct, datum').in('uitkomst', ['W', 'L']);
      if (betsErr) return res.status(500).json({ error: betsErr.message });
      const all = (bets || []).filter(b => {
        if (sport && normalizeSport(b.sport) !== sport) return false;
        const dm = (b.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (!dm) return false;
        const iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
        return iso >= sinceIso.slice(0, 10);
      });

      if (!all.length) return res.json({ days, sport, n: 0, message: 'Te weinig settled bets in window' });

      let brierSum = 0;
      let logLossSum = 0;
      const buckets = { '0-30': { n: 0, w: 0 }, '30-50': { n: 0, w: 0 }, '50-70': { n: 0, w: 0 }, '70-100': { n: 0, w: 0 } };
      for (const b of all) {
        const odds = parseFloat(b.odds);
        if (!odds || odds <= 1) continue;
        const impliedP = 1 / odds;
        const actual = b.uitkomst === 'W' ? 1 : 0;
        brierSum += Math.pow(impliedP - actual, 2);
        const p = Math.max(1e-6, Math.min(1 - 1e-6, impliedP));
        logLossSum += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
        const pct = impliedP * 100;
        let bk;
        if (pct < 30) bk = '0-30';
        else if (pct < 50) bk = '30-50';
        else if (pct < 70) bk = '50-70';
        else bk = '70-100';
        buckets[bk].n++;
        if (b.uitkomst === 'W') buckets[bk].w++;
      }
      const brier = +(brierSum / all.length).toFixed(4);
      const logLoss = +(logLossSum / all.length).toFixed(4);

      const calibration = {};
      for (const [bk, d] of Object.entries(buckets)) {
        if (!d.n) continue;
        calibration[bk] = {
          n: d.n,
          actual_wr: +(d.w / d.n).toFixed(3),
          predicted_wr_mid: { '0-30': 0.15, '30-50': 0.40, '50-70': 0.60, '70-100': 0.85 }[bk],
        };
      }

      res.json({
        days, sport, n: all.length,
        brier_score: brier,
        log_loss: logLoss,
        interpretation: brier < 0.20 ? 'EXCELLENT' : brier < 0.25 ? 'GOOD' : brier < 0.30 ? 'NEUTRAL' : 'POOR',
        calibration,
        note: 'Gebruikt impliciete prob uit logged odds als baseline. Pas wanneer pick_candidates volume ≥500 hebben kunnen we walk-forward op echte model-prob doen.',
      });
    } catch (e) {
      // v11.3.23 H3: no raw e.message to client.
      console.error('[admin-model-eval]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // POST /api/admin/v2/training-examples-build — schrijf training_examples voor settled bets.
  router.post('/admin/v2/training-examples-build', requireAdmin, async (req, res) => {
    try {
      const written = await writeTrainingExamplesForSettled();
      res.json({ written });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // GET /api/admin/v2/drift — vergelijk windows 25/50/100 vs all-time per markt/signaal/bookie.
  // Alert alleen bij n_recent ≥ 10 EN n_all ≥ 30 om self-deception bij kleine samples te voorkomen.
  router.get('/admin/v2/drift', requireAdmin, async (req, res) => {
    try {
      const { data: bets, error } = await supabase.from('bets')
        .select('sport, markt, tip, clv_pct, signals, datum').not('clv_pct', 'is', null)
        .order('datum', { ascending: false });
      if (error) { console.error('[admin-model-eval]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }

      const all = (bets || []).filter(b =>
        typeof b.clv_pct === 'number' &&
        !isNaN(b.clv_pct) &&
        supportsClvForBetMarkt(b.markt)
      );
      const WINDOWS = [25, 50, 100];

      const computeWindowed = (entityKey) => {
        const stats = {};
        for (let i = 0; i < all.length; i++) {
          const b = all[i];
          const keys = entityKey(b);
          if (!keys) continue;
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) {
            if (!stats[k]) stats[k] = { all: [], w25: [], w50: [], w100: [] };
            stats[k].all.push(b.clv_pct);
            if (i < 25) stats[k].w25.push(b.clv_pct);
            if (i < 50) stats[k].w50.push(b.clv_pct);
            if (i < 100) stats[k].w100.push(b.clv_pct);
          }
        }
        return Object.entries(stats).map(([k, s]) => {
          const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
          const avgAll = avg(s.all);
          const avg25 = avg(s.w25);
          const avg50 = avg(s.w50);
          const avg100 = avg(s.w100);
          let alert = null;
          if (s.w25.length >= 10 && s.all.length >= 30 && avg25 != null && avgAll != null) {
            const drift = avg25 - avgAll;
            if (drift < -2) alert = '🔴 SLECHTER';
            else if (drift > 2) alert = '✅ BETER';
          }
          return {
            key: k,
            n_all: s.all.length, n_25: s.w25.length, n_50: s.w50.length, n_100: s.w100.length,
            avg_all: avgAll, avg_25: avg25, avg_50: avg50, avg_100: avg100, alert,
          };
        }).sort((a, b) => (a.avg_25 || 0) - (b.avg_25 || 0));
      };

      const marketDrift = computeWindowed(b => `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`);
      const bookieDrift = computeWindowed(b => (b.tip || 'unknown'));
      const signalDrift = computeWindowed(b => {
        try {
          const sigs = typeof b.signals === 'string' ? JSON.parse(b.signals) : b.signals;
          if (!Array.isArray(sigs)) return null;
          return sigs.map(s => String(s).split(':')[0]).filter(Boolean);
        } catch { return null; }
      });

      res.json({
        ok: true, total_bets: all.length, windows: WINDOWS,
        marketDrift, bookieDrift, signalDrift,
        note: 'Alert alleen bij ≥10 in window én ≥30 totaal. Sample size altijd zichtbaar.',
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // GET /api/admin/v2/why-this-pick?bet_id=X — attribution per pick.
  // Toont welke baseline (markt) + welke model-delta + welke signals contribueerden.
  router.get('/admin/v2/why-this-pick', requireAdmin, async (req, res) => {
    try {
      const betId = parseInt(req.query.bet_id);
      if (!betId) return res.status(400).json({ error: 'bet_id is verplicht' });
      const { data: bet } = await supabase.from('bets').select('*').eq('bet_id', betId).maybeSingle();
      if (!bet) return res.status(404).json({ error: 'bet niet gevonden' });
      const fxId = bet.fixture_id;
      if (!fxId) return res.json({ bet, attribution: null, note: 'geen fixture_id, kan niet linken aan model_run' });
      const anchorIso = bet.created_at || (bet.datum && bet.tijd
        ? (() => {
            const dm = bet.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
            return dm ? `${dm[3]}-${dm[2]}-${dm[1]}T${bet.tijd}:00Z` : new Date().toISOString();
          })()
        : new Date().toISOString());
      const marketType = detectMarket(bet.markt || 'other');
      const { data: runs } = await supabase.from('model_runs')
        .select('*').eq('fixture_id', fxId).lte('captured_at', anchorIso).order('captured_at', { ascending: false });
      const matchingRun = (runs || []).find(r => r.market_type?.includes(marketType.replace('60', ''))) || (runs || [])[0];
      const { data: feat } = await supabase.from('feature_snapshots')
        .select('*').eq('fixture_id', fxId).lte('captured_at', anchorIso).order('captured_at', { ascending: false }).limit(1).maybeSingle();
      const { data: cons } = await supabase.from('market_consensus')
        .select('*').eq('fixture_id', fxId).lte('captured_at', anchorIso).order('captured_at', { ascending: false }).limit(1).maybeSingle();
      const { data: candidates } = await supabase.from('pick_candidates')
        .select('*').eq('fixture_id', fxId).order('created_at', { ascending: false });
      const { data: fixture } = await supabase.from('fixtures')
        .select('id, start_time').eq('id', fxId).maybeSingle();
      const { data: snaps } = await supabase.from('odds_snapshots')
        .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
        .eq('fixture_id', fxId)
        .limit(5000);
      let topContributions = [];
      let allSignals = [];
      try {
        const sigsStr = bet.signals || '';
        const sigs = typeof sigsStr === 'string' ? JSON.parse(sigsStr) : sigsStr;
        if (Array.isArray(sigs)) {
          allSignals = sigs;
          topContributions = sigs.map(s => {
            const str = String(s);
            const m = str.match(/^([^:]+):([+-]?[\d.]+)%?/);
            if (m) return { name: m[1], magnitude_pct: parseFloat(m[2]) };
            return { name: str, magnitude_pct: null };
          }).filter(x => x.magnitude_pct !== null)
            .sort((a, b) => Math.abs(b.magnitude_pct) - Math.abs(a.magnitude_pct))
            .slice(0, 5);
        }
      } catch (e) {
        console.warn('why-this-pick: signal parsing failed:', e.message);
      }
      const matchedCandidate = (candidates || []).find(c =>
        normalizeBookmaker(c.bookmaker) === normalizeBookmaker(bet.tip) &&
        Math.abs((parseFloat(c.bookmaker_odds) || 0) - (parseFloat(bet.odds) || 0)) < 0.01
      ) || (candidates || []).find(c => normalizeBookmaker(c.bookmaker) === normalizeBookmaker(bet.tip)) || null;
      const users = await loadUsers().catch(() => []);
      const admin = users.find(u => u.role === 'admin');
      const preferredBookiesLower = (admin?.settings?.preferredBookies || [])
        .map(x => (x || '').toString().toLowerCase()).filter(Boolean);
      const execution = matchedCandidate
        ? summarizeExecutionQuality(snaps || [], {
            marketType: matchedCandidate.market_type,
            selectionKey: matchedCandidate.selection_key,
            line: matchedCandidate.line,
            bookmaker: bet.tip || matchedCandidate.bookmaker || '',
            anchorIso,
            preferredBookiesLower,
            startTimeIso: fixture?.start_time || null,
          })
        : null;

      res.json({
        bet: { id: bet.bet_id, wedstrijd: bet.wedstrijd, markt: bet.markt, odds: bet.odds, uitkomst: bet.uitkomst, clv_pct: bet.clv_pct },
        market_baseline: matchingRun?.baseline_prob || null,
        model_delta: matchingRun?.model_delta || null,
        final_prob: matchingRun?.final_prob || null,
        top_contributions: topContributions,
        all_signals: allSignals,
        market_consensus: cons ? { type: cons.market_type, prob: cons.consensus_prob, bookies: cons.bookmaker_count, quality: cons.quality_score } : null,
        features: feat?.features || null,
        data_quality: feat?.quality || null,
        pick_candidates: (candidates || []).map(c => ({
          selection: c.selection_key, bookie: c.bookmaker, odds: c.bookmaker_odds,
          fair_prob: c.fair_prob, edge_pct: c.edge_pct, passed: c.passed_filters, rejected: c.rejected_reason,
        })),
        execution,
        model_version_id: matchingRun?.model_version_id,
        run_captured_at: matchingRun?.captured_at,
        point_in_time_anchor: anchorIso,
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
