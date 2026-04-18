'use strict';

const express = require('express');

/**
 * v11.3.5 · Phase 5.4m: Admin-inspect cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminInspectRouter({...}))`.
 *
 * Verantwoordelijkheden (alleen read-endpoints · observability/analytics):
 *   - GET /api/admin/v2/bookie-concentration  — per-bookie stake-share laatste N dagen
 *   - GET /api/admin/v2/stake-regime          — wat regime-engine ZOU beslissen op huidige bets
 *   - GET /api/admin/v2/early-payout-summary  — shadow-mode early-payout aggregaten
 *   - GET /api/admin/v2/pick-candidates-summary — pick_candidates samenvatting (accepted/rejected)
 *   - GET /api/admin/v2/clv-stats             — CLV-first KPI per sport + markt
 *
 * @param {object} deps
 *   - supabase                    — Supabase client
 *   - requireAdmin                — Express middleware
 *   - computeBookieConcentration  — pure helper (bets, windowDays, nowMs) → concentratie
 *   - getActiveStartBankroll      — getter voor live _activeStartBankroll
 *   - aggregateEarlyPayoutStats   — lib/signals/early-payout helper
 *   - normalizeSport              — lib/model-math helper
 *   - detectMarket                — lib/model-math helper
 * @returns {express.Router}
 */
module.exports = function createAdminInspectRouter(deps) {
  const {
    supabase, requireAdmin, computeBookieConcentration,
    getActiveStartBankroll, aggregateEarlyPayoutStats,
    normalizeSport, detectMarket,
  } = deps;

  const required = {
    supabase, requireAdmin, computeBookieConcentration,
    getActiveStartBankroll, aggregateEarlyPayoutStats,
    normalizeSport, detectMarket,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminInspectRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // ── GET /api/admin/v2/bookie-concentration ───────────────────────────────
  // Per-bookie stake-share over laatste N dagen (max 60). Helpt soft-book
  // closure-risico spotten vóór de alert-drempel (>60%) fireert.
  router.get('/admin/v2/bookie-concentration', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(60, parseInt(req.query.days, 10) || 7));
      const { data: bets, error } = await supabase.from('bets')
        .select('bookie, inzet, datum').not('bookie', 'is', null);
      if (error) return res.status(500).json({ error: error.message });
      const conc = computeBookieConcentration(bets || [], days, Date.now());
      return res.json({
        windowDays: days,
        ...conc,
        alertThreshold: 0.60,
        aboveThreshold: conc.maxShare > 0.60,
      });
    } catch (e) {
      console.error('bookie-concentration error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/stake-regime ───────────────────────────────────────
  // Preview wat de unified stake-regime engine ZOU beslissen op huidige bets.
  // Gebaseerd op real-bankroll metrics (start + cumulative P/L) sinds v11.0.0.
  router.get('/admin/v2/stake-regime', requireAdmin, async (req, res) => {
    try {
      const { evaluateStakeRegime, computeBankrollMetrics } = require('../stake-regime');
      const { data: bets, error } = await supabase.from('bets')
        .select('uitkomst, clv_pct, wl, inzet, datum').in('uitkomst', ['W', 'L']);
      if (error) return res.status(500).json({ error: error.message });
      const metrics = computeBankrollMetrics(bets || [], getActiveStartBankroll());

      const decision = evaluateStakeRegime({
        totalSettled: metrics.totalSettled,
        longTermClvPct: metrics.longTermClvPct,
        longTermRoi: metrics.longTermRoi,
        recentClvPct: metrics.recentClvPct,
        drawdownPct: metrics.drawdownPct,
        consecutiveLosses: metrics.consecutiveLosses,
        bankrollPeak: metrics.bankrollPeak,
        currentBankroll: metrics.currentBankroll,
      });

      res.json({
        input: {
          totalSettled: metrics.totalSettled,
          longTermClvPct: metrics.longTermClvPct,
          longTermRoi: metrics.longTermRoi,
          recentClvPct: metrics.recentClvPct,
          drawdownPct: +(metrics.drawdownPct * 100).toFixed(2) + '%',
          consecutiveLosses: metrics.consecutiveLosses,
          bankrollPeak: metrics.bankrollPeak,
          currentBankroll: metrics.currentBankroll,
          startBankroll: metrics.startBankroll,
        },
        decision,
        note: 'Engine is v11.0.0 live. Drawdown berekend t.o.v. echte bankroll (start + cumulative P/L).',
      });
    } catch (e) {
      console.error('stake-regime error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/early-payout-summary ───────────────────────────────
  // Shadow-mode readout. Per (bookie, sport, market) samples, activation en
  // conversion-rate uit early_payout_log. Geen scoring-impact tot 50+ samples
  // + bewezen lift promotie triggert.
  router.get('/admin/v2/early-payout-summary', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
      const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
      const { data: rows, error } = await supabase.from('early_payout_log')
        .select('bookie_used, sport, market_type, selection_key, actual_outcome, ep_rule_applied, ep_would_have_paid, potential_lift, logged_at')
        .gte('logged_at', sinceIso);
      if (error) return res.status(500).json({ error: error.message });
      const stats = aggregateEarlyPayoutStats(rows || []);
      const combinations = Object.entries(stats).map(([key, v]) => ({ key, ...v, readyForPromotion: v.samples >= 50 }));
      combinations.sort((a, b) => b.samples - a.samples);
      return res.json({
        days,
        totalRows: (rows || []).length,
        combinations,
        note: 'Shadow-mode. Samples ≥ 50 per combinatie + walk-forward bewijs van lift vereist voor promotion naar actief signaal.',
      });
    } catch (e) {
      console.error('early-payout-summary error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // ── GET /api/admin/v2/pick-candidates-summary ────────────────────────────
  // Aggregaties over pick_candidates: totaal, acceptance-rate, top reject
  // reasons, breakdown per bookmaker. Helpt modelsturing zonder DB-tools.
  router.get('/admin/v2/pick-candidates-summary', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data: candidates, error } = await supabase
        .from('pick_candidates')
        .select('id, fixture_id, selection_key, bookmaker, bookmaker_odds, fair_prob, edge_pct, passed_filters, rejected_reason, model_run_id, created_at')
        .gte('created_at', sinceIso)
        .order('created_at', { ascending: false })
        .limit(5000);
      if (error) return res.status(500).json({ error: error.message });
      const list = candidates || [];
      if (!list.length) {
        return res.json({ hours, total: 0, accepted: 0, rejected: 0, byReason: {}, byBookie: {}, recentRejected: [] });
      }
      const accepted = list.filter(c => c.passed_filters).length;
      const rejected = list.length - accepted;
      const byReason = {};
      for (const c of list) {
        if (c.passed_filters) continue;
        const cat = (c.rejected_reason || 'unknown').split(' (')[0];
        byReason[cat] = (byReason[cat] || 0) + 1;
      }
      const byBookie = {};
      for (const c of list) {
        const b = c.bookmaker || 'none';
        if (!byBookie[b]) byBookie[b] = { total: 0, accepted: 0 };
        byBookie[b].total++;
        if (c.passed_filters) byBookie[b].accepted++;
      }
      const recentRejected = list.filter(c => !c.passed_filters).slice(0, 10).map(c => ({
        id: c.id, fixture_id: c.fixture_id, selection: c.selection_key,
        bookie: c.bookmaker, odds: c.bookmaker_odds, edge: c.edge_pct,
        reason: c.rejected_reason, at: c.created_at,
      }));
      res.json({
        hours, total: list.length, accepted, rejected,
        acceptanceRate: +(accepted / list.length * 100).toFixed(1),
        byReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1])),
        byBookie,
        recentRejected,
      });
    } catch (e) {
      res.status(500).json({ error: 'Interne fout' });
    }
  });

  // ── GET /api/admin/v2/clv-stats ──────────────────────────────────────────
  // CLV-first KPI per sport + markt. Reviewer-aanbeveling: CLV is hoofd-KPI
  // (winrate is te noisy bij kleine samples). Kill-switch eligibility
  // berekend per markt-bucket (n≥30 + avg CLV < -2%).
  router.get('/admin/v2/clv-stats', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
      const { data: bets, error } = await supabase.from('bets')
        .select('sport, markt, clv_pct, uitkomst, wl, datum')
        .not('clv_pct', 'is', null);
      if (error) return res.status(500).json({ error: error.message });

      const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct));
      if (!all.length) return res.json({ days, totalBets: 0, bySport: {}, byMarket: {}, killEligible: [] });

      const bySport = {};
      for (const b of all) {
        const s = normalizeSport(b.sport || 'football');
        if (!bySport[s]) bySport[s] = { n: 0, sumClv: 0, positive: 0, sumPnl: 0, settledN: 0 };
        bySport[s].n++;
        bySport[s].sumClv += b.clv_pct;
        if (b.clv_pct > 0) bySport[s].positive++;
        if (b.uitkomst === 'W' || b.uitkomst === 'L') {
          bySport[s].settledN++;
          bySport[s].sumPnl += parseFloat(b.wl || 0);
        }
      }
      const sportSummary = {};
      for (const [s, d] of Object.entries(bySport)) {
        sportSummary[s] = {
          n: d.n,
          avg_clv_pct: +(d.sumClv / d.n).toFixed(2),
          positive_clv_pct: +(d.positive / d.n * 100).toFixed(1),
          settled_n: d.settledN,
          total_pnl_eur: +d.sumPnl.toFixed(2),
        };
      }

      const byMarket = {};
      for (const b of all) {
        const s = normalizeSport(b.sport || 'football');
        const mk = detectMarket(b.markt || 'other');
        const key = `${s}_${mk}`;
        if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0, positive: 0, sumPnl: 0 };
        byMarket[key].n++;
        byMarket[key].sumClv += b.clv_pct;
        if (b.clv_pct > 0) byMarket[key].positive++;
        if (b.uitkomst === 'W' || b.uitkomst === 'L') byMarket[key].sumPnl += parseFloat(b.wl || 0);
      }
      const marketSummary = {};
      for (const [k, d] of Object.entries(byMarket)) {
        marketSummary[k] = {
          n: d.n,
          avg_clv_pct: +(d.sumClv / d.n).toFixed(2),
          positive_clv_pct: +(d.positive / d.n * 100).toFixed(1),
          total_pnl_eur: +d.sumPnl.toFixed(2),
        };
      }

      // Kill-switch eligibility: ≥30 bets + avg CLV < -2% → structureel negatief.
      const killEligible = [];
      for (const [k, s] of Object.entries(marketSummary)) {
        if (s.n >= 30 && s.avg_clv_pct < -2.0) {
          killEligible.push({
            key: k, n: s.n, avg_clv_pct: s.avg_clv_pct,
            recommendation: s.avg_clv_pct < -5 ? 'AUTO_DISABLE' : 'WATCHLIST',
          });
        }
      }

      res.json({
        days, totalBets: all.length,
        bySport: sportSummary,
        byMarket: marketSummary,
        killEligible,
        thresholds: { kill_min_n: 30, watchlist_clv: -2.0, auto_disable_clv: -5.0 },
      });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Interne fout' });
    }
  });

  return router;
};
