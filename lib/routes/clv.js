'use strict';

const express = require('express');

/**
 * v11.2.2 · Phase 5.2: CLV backfill + recompute + probe routes extracted uit server.js.
 *
 * Factory pattern: alle deps expliciet inject — geen globals.
 * Mount via: `app.use('/api', createClvRouter({ supabase, ... }))`.
 *
 * Verantwoordelijkheden:
 *   - POST `/api/clv/backfill` — vul lege clv_pct voor settled/past-kickoff bets.
 *   - POST `/api/clv/recompute` — force-recompute CLV voor bestaande settled bets
 *     (bv. na fetchCurrentOdds fix). Updates alleen als delta ≥ minDelta.
 *   - GET  `/api/clv/backfill/probe?bet_id=X` — dry-run diagnose voor één bet.
 *
 * @param {object} deps
 *   - supabase                     — Supabase client
 *   - requireAdmin                 — Express middleware admin-gate
 *   - findGameIdVerbose            — async (sport, wedstrijd, anchorDate, windowDays) → {fxId, ...}
 *   - fetchCurrentOdds             — async (sport, fxId, markt, tip, opts) → price|null
 *   - fetchSnapshotClosing         — async (supabase, args) → {closingOdds, bookieUsed, sourceType}|null
 *   - marketKeyFromBetMarkt        — (markt) → {market_type, selection_key, line}|null
 *   - matchesClvRecomputeTarget    — (row, options) → boolean (target-bet scoping)
 *   - afRateLimit                  — {remaining, limit, callsToday}
 *   - sportRateLimits              — object per-sport rate-limits
 *   - refreshKillSwitch            — async () → void
 *   - KILL_SWITCH                  — {set: Set} kill-switch state
 *   - autoTuneSignalsByClv         — async () → object
 *   - evaluateKellyAutoStepup      — async () → object
 * @returns {express.Router}
 */
module.exports = function createClvRouter(deps) {
  const {
    supabase,
    requireAdmin,
    findGameIdVerbose,
    fetchCurrentOdds,
    fetchSnapshotClosing,
    marketKeyFromBetMarkt,
    matchesClvRecomputeTarget,
    afRateLimit,
    sportRateLimits,
    refreshKillSwitch,
    KILL_SWITCH,
    autoTuneSignalsByClv,
    evaluateKellyAutoStepup,
  } = deps;

  const required = {
    supabase, requireAdmin, findGameIdVerbose, fetchCurrentOdds,
    fetchSnapshotClosing, marketKeyFromBetMarkt, matchesClvRecomputeTarget,
    afRateLimit, sportRateLimits, refreshKillSwitch, KILL_SWITCH,
    autoTuneSignalsByClv, evaluateKellyAutoStepup,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createClvRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  // POST /api/clv/backfill — vul lege CLVs. Optioneel body: { all: true } voor cross-user.
  router.post('/clv/backfill', requireAdmin, async (req, res) => {
    try {
      const all = req.body?.all === true;
      const userId = (!all && req.user?.id) ? req.user.id : null;

      let q = supabase.from('bets').select('*').is('clv_pct', null);
      if (userId) q = q.eq('user_id', userId);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      const nowMs = Date.now();
      const candidates = (data || []).filter(r => {
        if (r.uitkomst && r.uitkomst !== 'Open') return true;
        if (r.datum && r.tijd) {
          const m = r.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (m) {
            const iso = `${m[3]}-${m[2]}-${m[1]}T${r.tijd}:00`;
            const ms = Date.parse(iso);
            if (!isNaN(ms) && ms < nowMs) return true;
          }
        }
        return false;
      });

      const details = [];
      let filled = 0, failed = 0;
      for (const r of candidates) {
        const id = r.bet_id;
        const wedstrijd = r.wedstrijd || '';
        const sport = r.sport || 'football';
        const markt = r.markt || '';
        const loggedOdds = parseFloat(r.odds);
        try {
          let fxId = r.fixture_id;
          let verbose = null;
          if (!fxId) {
            let anchorDate = null;
            const dm = (r.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (dm) anchorDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
            verbose = await findGameIdVerbose(sport, wedstrijd, anchorDate, [-3, -2, -1, 0, 1]);
            fxId = verbose.fxId;
            if (fxId) {
              try { await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', id); }
              catch (e) { console.error(`Backfill: fixture_id update failed voor bet ${id}:`, e.message); }
            }
          }
          if (!fxId) {
            failed++;
            details.push({ id, wedstrijd, sport, reason: 'fixture niet gevonden',
                           fixturesFetched: verbose?.fixturesFetched, topCandidates: verbose?.topCandidates,
                           bestScore: verbose?.bestScore, host: verbose?.host });
            await new Promise(rs => setTimeout(rs, 200));
            continue;
          }
          let closingOdds = await fetchCurrentOdds(sport, fxId, markt, r.tip, { strictBookie: true });
          let bookieUsed = r.tip;
          let sourceType = 'live-api';

          // v11.0.1: fallback naar odds_snapshots wanneer live api geen odds heeft.
          if (!closingOdds && loggedOdds) {
            const snap = await fetchSnapshotClosing(supabase, { fixtureId: fxId, markt, preferredBookie: r.tip });
            if (snap && Number.isFinite(snap.closingOdds)) {
              closingOdds = snap.closingOdds;
              bookieUsed = snap.bookieUsed;
              sourceType = snap.sourceType;
            }
          }

          if (!closingOdds || !loggedOdds) {
            failed++;
            details.push({ id, wedstrijd, sport, fxId, bookie: r.tip,
                           reason: `closing odds niet beschikbaar voor bookie "${r.tip}" (ook niet in odds_snapshots)` });
            await new Promise(rs => setTimeout(rs, 200));
            continue;
          }
          const clvPct = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
          await supabase.from('bets').update({ clv_odds: closingOdds, clv_pct: clvPct }).eq('bet_id', id);
          filled++;
          details.push({ id, wedstrijd, sport, clvPct, source: sourceType, bookieUsed });

          const icon = clvPct > 0 ? '✅' : '❌';
          const srcTag = sourceType === 'live-api' ? '' : ` · via ${sourceType}`;
          await supabase.from('notifications').insert({
            type: 'clv_backfill',
            title: `CLV ingevuld: ${wedstrijd}`.slice(0, 100),
            body: `${icon} ${wedstrijd} · ${loggedOdds} → ${closingOdds} · CLV ${clvPct > 0 ? '+' : ''}${clvPct}%${srcTag}`.slice(0, 200),
            read: false,
            user_id: r.user_id || null,
          }).catch(() => {});
        } catch (e) {
          failed++;
          details.push({ id, wedstrijd, reason: (e && e.message) || 'error' });
        }
        await new Promise(rs => setTimeout(rs, 200));
      }

      res.json({ scanned: candidates.length, filled, failed, details,
                 rateLimit: { remaining: afRateLimit.remaining, limit: afRateLimit.limit,
                              callsToday: afRateLimit.callsToday, perSport: sportRateLimits } });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Interne fout' });
    }
  });

  // POST /api/clv/recompute — FORCE hercomputeer CLV. Body: { all?, dryRun?, betId?, minDeltaPct? }
  router.post('/clv/recompute', requireAdmin, async (req, res) => {
    try {
      const all = req.body?.all === true;
      const dryRun = req.body?.dryRun === true;
      const rawBetId = parseInt(req.body?.betId);
      const targetBetId = Number.isFinite(rawBetId) && rawBetId > 0 ? rawBetId : null;
      const rawDelta = req.body?.minDeltaPct;
      const minDelta = (typeof rawDelta === 'number' && isFinite(rawDelta) && rawDelta >= 0 && rawDelta <= 100)
        ? Math.abs(rawDelta)
        : 0.5;
      const QUERY_CEILING = 10000;
      const userId = (!all && req.user?.id) ? req.user.id : null;

      let q = supabase.from('bets').select('*').in('uitkomst', ['W', 'L']).limit(QUERY_CEILING);
      if (userId) q = q.eq('user_id', userId);
      if (targetBetId != null) q = q.eq('bet_id', targetBetId);
      const { data, error } = await q;
      if (error) return res.status(500).json({ error: error.message });

      const details = [];
      let updated = 0, skipped = 0, failed = 0;
      for (const r of (data || [])) {
        if (!matchesClvRecomputeTarget(r, { betId: targetBetId })) continue;
        const id = r.bet_id;
        const wedstrijd = r.wedstrijd || '';
        const sport = r.sport || 'football';
        const markt = r.markt || '';
        const loggedOdds = parseFloat(r.odds);
        const oldClv = (typeof r.clv_pct === 'number') ? r.clv_pct : null;
        try {
          let fxId = r.fixture_id;
          if (!fxId) {
            let anchorDate = null;
            const dm = (r.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (dm) anchorDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
            const verbose = await findGameIdVerbose(sport, wedstrijd, anchorDate, [-3, -2, -1, 0, 1]);
            fxId = verbose.fxId;
            if (fxId && !dryRun) {
              try { await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', id); }
              catch (e) { console.error(`Recompute: fixture_id update failed voor bet ${id}:`, e.message); }
            }
          }
          if (!fxId) { failed++; details.push({ id, wedstrijd, reason: 'fixture niet gevonden' }); await new Promise(rs => setTimeout(rs, 150)); continue; }
          const closingOdds = await fetchCurrentOdds(sport, fxId, markt, r.tip, { strictBookie: true });
          if (!closingOdds || !loggedOdds) {
            failed++;
            details.push({ id, wedstrijd, sport, fxId, bookie: r.tip, reason: `closing odds niet beschikbaar voor "${r.tip}"` });
            await new Promise(rs => setTimeout(rs, 150));
            continue;
          }
          const newClv = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
          const delta = oldClv === null ? Infinity : Math.abs(newClv - oldClv);
          if (delta < minDelta) {
            skipped++;
            details.push({ id, wedstrijd, oldClv, newClv, delta: +delta.toFixed(2), action: 'skip-small-delta' });
            await new Promise(rs => setTimeout(rs, 150));
            continue;
          }
          // v10.10.21: sharp CLV — Pinnacle closing line uit odds_snapshots.
          let sharpClvOdds = null;
          let sharpClvPct = null;
          if (fxId) {
            const mapped = marketKeyFromBetMarkt(markt);
            if (mapped) {
              try {
                let snapQuery = supabase.from('odds_snapshots')
                  .select('odds')
                  .eq('fixture_id', fxId)
                  .eq('market_type', mapped.market_type)
                  .eq('selection_key', mapped.selection_key)
                  .ilike('bookmaker', '%pinnacle%')
                  .order('captured_at', { ascending: false })
                  .limit(1);
                if (mapped.line != null && Number.isFinite(mapped.line)) {
                  snapQuery = snapQuery.eq('line', +mapped.line.toFixed(2));
                }
                const { data: snapRows } = await snapQuery;
                if (snapRows?.[0]?.odds) {
                  sharpClvOdds = parseFloat(snapRows[0].odds);
                  if (Number.isFinite(sharpClvOdds) && sharpClvOdds > 1 && loggedOdds > 0) {
                    sharpClvPct = +((loggedOdds - sharpClvOdds) / sharpClvOdds * 100).toFixed(2);
                  }
                }
              } catch (e) {
                // Graceful: sharp CLV is nice-to-have, execution CLV is canonical.
              }
            }
          }
          const updatePayload = { clv_odds: closingOdds, clv_pct: newClv };
          if (sharpClvOdds !== null) updatePayload.sharp_clv_odds = sharpClvOdds;
          if (sharpClvPct !== null) updatePayload.sharp_clv_pct = sharpClvPct;
          if (!dryRun) {
            await supabase.from('bets').update(updatePayload).eq('bet_id', id);
          }
          updated++;
          details.push({ id, wedstrijd, markt, bookie: r.tip, oldClv, newClv, sharpClvPct, delta: oldClv === null ? null : +delta.toFixed(2), action: dryRun ? 'would-update' : 'updated' });
        } catch (e) {
          failed++;
          details.push({ id, wedstrijd, reason: (e && e.message) || 'error' });
        }
        await new Promise(rs => setTimeout(rs, 150));
      }

      // Na recompute: CLV-driven tuning opnieuw draaien op de nieuwe clv_pct.
      const tuning = { killSwitch: null, signalTune: null, kellyStepup: null };
      if (!dryRun && updated > 0) {
        try { await refreshKillSwitch(); tuning.killSwitch = { ok: true, activeKilled: KILL_SWITCH.set.size }; }
        catch (e) { tuning.killSwitch = { ok: false, error: e.message }; }
        try { tuning.signalTune = await autoTuneSignalsByClv(); }
        catch (e) { tuning.signalTune = { ok: false, error: e.message }; }
        try { tuning.kellyStepup = await evaluateKellyAutoStepup(); }
        catch (e) { tuning.kellyStepup = { ok: false, error: e.message }; }
      }

      res.json({ scanned: (data || []).length, updated, skipped, failed, dryRun, minDelta, betId: targetBetId, details, tuning,
                 rateLimit: { remaining: afRateLimit.remaining, limit: afRateLimit.limit,
                              callsToday: afRateLimit.callsToday, perSport: sportRateLimits } });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Interne fout' });
    }
  });

  // GET /api/clv/backfill/probe?bet_id=X — dry-run diagnose voor één bet.
  router.get('/clv/backfill/probe', requireAdmin, async (req, res) => {
    try {
      const betId = parseInt(req.query.bet_id);
      if (!betId) return res.status(400).json({ error: 'bet_id is verplicht' });
      const { data, error } = await supabase.from('bets').select('*').eq('bet_id', betId).single();
      if (error || !data) return res.status(404).json({ error: 'bet niet gevonden' });
      const sport = data.sport || 'football';
      const wedstrijd = data.wedstrijd || '';
      const markt = data.markt || '';
      const loggedOdds = parseFloat(data.odds);
      let anchorDate = null;
      const dm = (data.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dm) anchorDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
      const windowDays = req.query.wide === '1' ? [-7, -6, -5, -4, -3, -2, -1, 0, 1] : [-1, 0, 1];
      const verbose = data.fixture_id
        ? { fxId: data.fixture_id, fixturesFetched: {}, topCandidates: [], bestScore: null, note: 'gebruikt opgeslagen fixture_id' }
        : await findGameIdVerbose(sport, wedstrijd, anchorDate, windowDays);
      verbose.anchorDate = anchorDate;
      verbose.windowDays = windowDays;
      let closingOdds = null, clvPct = null;
      if (verbose.fxId) {
        closingOdds = await fetchCurrentOdds(sport, verbose.fxId, markt, data.tip);
        if (closingOdds && loggedOdds) clvPct = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
      }
      res.json({ bet: { id: betId, wedstrijd, sport, markt, loggedOdds, tip: data.tip, fixture_id: data.fixture_id,
                        datum: data.datum, tijd: data.tijd },
                 diagnose: verbose, closingOdds, clvPct,
                 rateLimit: { remaining: afRateLimit.remaining, limit: afRateLimit.limit,
                              callsToday: afRateLimit.callsToday, perSport: sportRateLimits } });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Interne fout' });
    }
  });

  return router;
};
