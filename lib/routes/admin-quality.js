'use strict';

const express = require('express');
const { supportsClvForBetMarkt } = require('../clv-match');

/**
 * v11.3.7 · Phase 5.4o: Admin-quality cluster extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createAdminQualityRouter({...}))`.
 *
 * Verantwoordelijkheden (execution/data quality + odds-drift + per-bookie + market thresholds):
 *   - GET /api/admin/v2/execution-quality    — punt-in-tijd execution analyse per fixture/markt/selection
 *   - GET /api/admin/v2/data-quality         — feature_snapshots + odds_snapshots freshness/issue summary
 *   - GET /api/admin/odds-drift              — odds drift-per-bucket t.o.v. close (research-tool)
 *   - GET /api/admin/v2/per-bookie-stats     — ROI + CLV per bookmaker uit settled bets
 *   - GET /api/admin/v2/market-thresholds    — huidige adaptive MIN_EDGE per markt tier
 *
 * @param {object} deps
 *   - supabase                     — Supabase client
 *   - requireAdmin                 — Express middleware
 *   - loadUsers                    — async () → users[] (voor execution-quality preferredBookies)
 *   - summarizeExecutionQuality    — lib/execution-quality helper
 *   - normalizeSport               — lib/model-math helper
 *   - getMarketSampleCache         — getter () → { data, at }
 *   - refreshMarketSampleCounts    — async () → void
 *   - MARKET_SAMPLE_TTL_MS         — number (cache TTL voor markt-tiers)
 *   - BOOTSTRAP_MIN_TOTAL_BETS     — number (tier-bootstrap threshold)
 * @returns {express.Router}
 */
module.exports = function createAdminQualityRouter(deps) {
  const {
    supabase, requireAdmin, loadUsers,
    summarizeExecutionQuality, normalizeSport,
    getMarketSampleCache, refreshMarketSampleCounts,
    MARKET_SAMPLE_TTL_MS, BOOTSTRAP_MIN_TOTAL_BETS,
  } = deps;

  const required = {
    supabase, requireAdmin, loadUsers,
    summarizeExecutionQuality, normalizeSport,
    getMarketSampleCache, refreshMarketSampleCounts,
    MARKET_SAMPLE_TTL_MS, BOOTSTRAP_MIN_TOTAL_BETS,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createAdminQualityRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // GET /api/admin/v2/execution-quality — execution analyse per fixture/markt/selection.
  // Helpt bepalen of een prijs speelbaar, stale of markt-beatend was.
  router.get('/admin/v2/execution-quality', requireAdmin, async (req, res) => {
    try {
      const fixtureId = parseInt(req.query.fixture_id);
      const marketType = String(req.query.market_type || '').trim();
      const selectionKey = String(req.query.selection_key || '').trim();
      if (!fixtureId || !marketType || !selectionKey) {
        return res.status(400).json({ error: 'fixture_id, market_type en selection_key zijn verplicht' });
      }
      const line = req.query.line != null && req.query.line !== '' ? parseFloat(req.query.line) : null;
      const bookmaker = String(req.query.bookmaker || '').trim();
      const anchorIso = req.query.anchor_iso ? new Date(String(req.query.anchor_iso)).toISOString() : null;
      const { data: fixture } = await supabase.from('fixtures').select('id, start_time').eq('id', fixtureId).maybeSingle();
      const { data: snaps } = await supabase.from('odds_snapshots')
        .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
        .eq('fixture_id', fixtureId)
        .limit(5000);
      const users = await loadUsers().catch(() => []);
      const admin = users.find(u => u.role === 'admin');
      const preferredBookiesLower = (admin?.settings?.preferredBookies || [])
        .map(x => (x || '').toString().toLowerCase()).filter(Boolean);
      const execution = summarizeExecutionQuality(snaps || [], {
        marketType,
        selectionKey,
        line,
        bookmaker,
        anchorIso,
        preferredBookiesLower,
        startTimeIso: fixture?.start_time || null,
      });
      res.json({
        fixture_id: fixtureId,
        start_time: fixture?.start_time || null,
        execution,
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // GET /api/admin/v2/data-quality — feature_snapshots freshness + issue-counts + consensus-health.
  router.get('/admin/v2/data-quality', requireAdmin, async (req, res) => {
    try {
      const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
      const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const { data: feats } = await supabase.from('feature_snapshots')
        .select('fixture_id, captured_at, quality').gte('captured_at', sinceIso);
      const totalFeats = (feats || []).length;
      if (!totalFeats) return res.json({ hours, totalFeatures: 0, qualityIssues: {} });

      const issues = { lineup_missing: 0, low_three_way_bookies: 0, no_standings: 0, shots_signal_invalid: 0, pitcher_signal_invalid: 0 };
      for (const f of feats) {
        const q = f.quality || {};
        if (q.lineup_known === false || q.lineup_confirmed === false) issues.lineup_missing++;
        if ((q.three_way_bookies || 0) < 3 && q.three_way_bookies !== undefined) issues.low_three_way_bookies++;
        if (q.standings_present === false) issues.no_standings++;
        if (q.shots_signal_valid === false) issues.shots_signal_invalid++;
        if (q.pitcher_signal_valid === false) issues.pitcher_signal_invalid++;
      }
      const { data: oddsSnaps } = await supabase.from('odds_snapshots')
        .select('fixture_id').gte('captured_at', sinceIso);
      const fixtureWithOdds = new Set((oddsSnaps || []).map(o => o.fixture_id));
      const featFixtures = new Set((feats || []).map(f => f.fixture_id));
      const missingOddsCount = [...featFixtures].filter(f => !fixtureWithOdds.has(f)).length;

      let oldestAgeMin = null;
      if (feats && feats.length) {
        const oldest = feats.reduce((min, f) => {
          const t = new Date(f.captured_at).getTime();
          return min == null || t < min ? t : min;
        }, null);
        if (oldest) oldestAgeMin = Math.round((Date.now() - oldest) / 60000);
      }

      const { data: cons } = await supabase.from('market_consensus')
        .select('bookmaker_count, quality_score').gte('captured_at', sinceIso);
      const avgBookies = (cons || []).length ? +(cons.reduce((s, c) => s + (c.bookmaker_count || 0), 0) / cons.length).toFixed(1) : null;
      const avgQuality = (cons || []).length ? +(cons.reduce((s, c) => s + (c.quality_score || 0), 0) / cons.length).toFixed(3) : null;

      res.json({
        hours, totalFeatures: totalFeats,
        qualityIssues: issues,
        missingOdds: { fixtures_with_features_but_no_odds: missingOddsCount },
        consensus: { snapshots: (cons || []).length, avg_bookmaker_count: avgBookies, avg_quality_score: avgQuality },
        freshness: { oldest_feature_snapshot_age_min: oldestAgeMin },
        summary: {
          healthy_pct: totalFeats > 0 ? +((totalFeats - issues.no_standings - issues.lineup_missing) / totalFeats * 100).toFixed(1) : 100,
        },
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // GET /api/admin/odds-drift — odds drift per (sport, market_type, hours-before-kick) bucket.
  // Helpt bepalen of vroege of late inzet gemiddeld beter was per markt. Negatief drift =
  // vroege inzet leverde hogere odds op.
  router.get('/admin/odds-drift', requireAdmin, async (req, res) => {
    try {
      const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 14));
      const sinceIso = new Date(Date.now() - days * 86400 * 1000).toISOString();
      const scope = (req.query.scope === 'all') ? 'all' : 'mine';

      const nowIso = new Date().toISOString();
      const { data: fixtures } = await supabase.from('fixtures')
        .select('id, sport, start_time')
        .gte('start_time', sinceIso)
        .lt('start_time', nowIso)
        .limit(800);
      if (!fixtures?.length) return res.json({ days, scope, totalFixtures: 0, buckets: [] });
      let allowedIds = null;
      if (scope === 'mine') {
        const { data: myBets } = await supabase.from('bets')
          .select('fixture_id').eq('user_id', req.user?.id).not('fixture_id', 'is', null);
        allowedIds = new Set((myBets || []).map(b => b.fixture_id));
      }
      const filteredFixtures = allowedIds
        ? fixtures.filter(f => allowedIds.has(f.id))
        : fixtures;
      if (!filteredFixtures.length) return res.json({
        days, scope, totalFixtures: 0, buckets: [],
        note: scope === 'mine' ? 'Nog geen gelogde bets in deze window. Schakel naar scope=all voor brede data.' : undefined,
      });
      const fixtureMap = new Map(filteredFixtures.map(f => [f.id, f]));
      const fixtureIds = filteredFixtures.map(f => f.id);

      const snapshots = [];
      const BATCH = 200;
      for (let i = 0; i < fixtureIds.length; i += BATCH) {
        const batch = fixtureIds.slice(i, i + BATCH);
        const { data: snaps } = await supabase.from('odds_snapshots')
          .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
          .in('fixture_id', batch)
          .limit(5000);
        if (snaps?.length) snapshots.push(...snaps);
        if (snapshots.length >= 20000) break;
      }
      if (!snapshots.length) return res.json({ days, scope, totalFixtures: filteredFixtures.length, totalSnapshots: 0, buckets: [] });

      const groups = new Map();
      for (const s of snapshots) {
        const key = `${s.fixture_id}|${s.bookmaker}|${s.market_type}|${s.selection_key}|${s.line || ''}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }

      const bucketize = (hrs) => {
        if (hrs < 2) return '0-2h';
        if (hrs < 6) return '2-6h';
        if (hrs < 12) return '6-12h';
        if (hrs < 24) return '12-24h';
        if (hrs < 48) return '24-48h';
        return '48h+';
      };
      const BUCKETS = ['0-2h', '2-6h', '6-12h', '12-24h', '24-48h', '48h+'];

      const agg = new Map();

      for (const [, snaps] of groups) {
        if (snaps.length < 2) continue;
        snaps.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
        const close = snaps[snaps.length - 1];
        const closeOdds = parseFloat(close.odds);
        if (!(closeOdds > 1)) continue;
        const fix = fixtureMap.get(close.fixture_id);
        if (!fix?.start_time) continue;
        const sport = normalizeSport(fix.sport);
        const startMs = new Date(fix.start_time).getTime();

        for (let i = 0; i < snaps.length - 1; i++) {
          const snap = snaps[i];
          const o = parseFloat(snap.odds);
          if (!(o > 1)) continue;
          const hrsBeforeKick = (startMs - new Date(snap.captured_at).getTime()) / 3600000;
          if (hrsBeforeKick <= 0) continue;
          const bucket = bucketize(hrsBeforeKick);
          const drift = ((closeOdds - o) / o) * 100;
          const aggKey = `${sport}|${snap.market_type}|${bucket}`;
          if (!agg.has(aggKey)) agg.set(aggKey, { sport, market_type: snap.market_type, bucket, sumDrift: 0, sumAbs: 0, count: 0 });
          const a = agg.get(aggKey);
          a.sumDrift += drift;
          a.sumAbs += Math.abs(drift);
          a.count++;
        }
      }

      const buckets = Array.from(agg.values())
        .map(a => ({
          sport: a.sport,
          market_type: a.market_type,
          bucket: a.bucket,
          n: a.count,
          avg_drift_pct: +(a.sumDrift / a.count).toFixed(3),
          avg_abs_drift_pct: +(a.sumAbs / a.count).toFixed(3),
        }))
        .filter(b => b.n >= 5)
        .sort((a, b) => a.sport.localeCompare(b.sport) || a.market_type.localeCompare(b.market_type) || BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));

      const bestEntry = {};
      for (const b of buckets) {
        const k = `${b.sport}|${b.market_type}`;
        if (!bestEntry[k] || b.avg_drift_pct < bestEntry[k].avg_drift_pct) {
          bestEntry[k] = { bucket: b.bucket, avg_drift_pct: b.avg_drift_pct, n: b.n };
        }
      }

      res.json({
        days, scope, totalFixtures: filteredFixtures.length, totalSnapshots: snapshots.length,
        buckets, bestEntry,
        note: 'avg_drift_pct: % verandering naar close. Negatief = odds waren vroeger HOGER (vroege inzet beter). Positief = later inzetten was beter.',
      });
    } catch (e) {
      // v11.3.23 H3: geen raw e.message naar client (information disclosure).
      console.error('[odds-drift]', e?.message || e);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  // GET /api/admin/v2/per-bookie-stats — ROI + CLV per bookmaker uit settled bets.
  router.get('/admin/v2/per-bookie-stats', requireAdmin, async (req, res) => {
    try {
      const { data: bets, error } = await supabase.from('bets')
        .select('tip, sport, markt, odds, uitkomst, wl, clv_pct, inzet')
        .in('uitkomst', ['W', 'L']);
      if (error) { console.error('[admin-quality]', error.message); return res.status(500).json({ error: 'Interne fout · check server logs' }); }
      const all = bets || [];
      if (!all.length) return res.json({ bookies: {}, summary: { totalBets: 0 } });

      const byBookie = {};
      for (const b of all) {
        const bk = (b.tip || 'Unknown').trim();
        if (!byBookie[bk]) byBookie[bk] = { n: 0, w: 0, sumPnl: 0, sumStake: 0, clvN: 0, sumClv: 0, posClv: 0 };
        const s = byBookie[bk];
        s.n++;
        if (b.uitkomst === 'W') s.w++;
        s.sumPnl += parseFloat(b.wl || 0);
        s.sumStake += parseFloat(b.inzet || 0);
        if (typeof b.clv_pct === 'number' && !isNaN(b.clv_pct) && supportsClvForBetMarkt(b.markt)) {
          s.clvN++;
          s.sumClv += b.clv_pct;
          if (b.clv_pct > 0) s.posClv++;
        }
      }
      const result = {};
      for (const [bk, s] of Object.entries(byBookie)) {
        const winRate = s.n ? (s.w / s.n * 100) : 0;
        const roiPct = s.sumStake ? (s.sumPnl / s.sumStake * 100) : 0;
        result[bk] = {
          n: s.n,
          win_rate_pct: +winRate.toFixed(1),
          roi_pct: +roiPct.toFixed(2),
          total_pnl_eur: +s.sumPnl.toFixed(2),
          total_stake_eur: +s.sumStake.toFixed(2),
          avg_clv_pct: s.clvN ? +(s.sumClv / s.clvN).toFixed(2) : null,
          positive_clv_pct: s.clvN ? +(s.posClv / s.clvN * 100).toFixed(1) : null,
          clv_sample: s.clvN,
        };
      }
      res.json({
        bookies: result,
        summary: { totalBets: all.length, bookieCount: Object.keys(byBookie).length },
        note: 'Toont executable edge per bookie. Lage ROI/CLV op een specifieke bookie kan duiden op slechte odds-shopping of late line movement.',
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // GET /api/admin/v2/market-thresholds — huidige adaptive MIN_EDGE per markt tier.
  router.get('/admin/v2/market-thresholds', requireAdmin, async (req, res) => {
    try {
      const cache = getMarketSampleCache();
      if (Date.now() - cache.at > MARKET_SAMPLE_TTL_MS) await refreshMarketSampleCounts();
      const fresh = getMarketSampleCache();
      const baseMinEdge = 0.055;
      const totalSettled = Object.values(fresh.data).reduce((a, b) => a + b, 0);
      const bootstrap = totalSettled < BOOTSTRAP_MIN_TOTAL_BETS;
      const tiers = Object.entries(fresh.data).map(([key, n]) => {
        const tier = bootstrap ? 'BOOTSTRAP' : n >= 100 ? 'PROVEN' : n >= 30 ? 'EARLY' : 'UNPROVEN';
        const minEdge = bootstrap ? baseMinEdge : n >= 100 ? baseMinEdge : n >= 30 ? Math.max(baseMinEdge, 0.065) : Math.max(baseMinEdge, 0.08);
        return { key, n, tier, min_edge_pct: +(minEdge * 100).toFixed(1) };
      }).sort((a, b) => b.n - a.n);
      res.json({
        base_min_edge_pct: baseMinEdge * 100,
        bootstrap_active: bootstrap,
        total_settled: totalSettled,
        bootstrap_threshold: BOOTSTRAP_MIN_TOTAL_BETS,
        tiers,
        thresholds: { proven_min_n: 100, early_min_n: 30, unproven_min_edge_pct: 8.0, early_min_edge_pct: 6.5 },
      });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
