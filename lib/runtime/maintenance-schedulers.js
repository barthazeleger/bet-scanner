'use strict';

const snap = require('../snapshots');

/**
 * v11.3.19 · Phase 6.2b: Maintenance + health-alert schedulers extracted uit server.js.
 *
 * Factory pattern. Gebruik:
 *   const mt = createMaintenanceSchedulers({ ... });
 *   mt.scheduleRetentionCleanup();
 *   mt.scheduleAutotune();
 *   mt.scheduleBookieConcentrationWatcher();
 *   mt.scheduleHealthAlerts();
 *   mt.scheduleSignalStatsRefresh();
 *   mt.scheduleAutoRetraining();
 *   await mt.checkUnitSizeChange();
 *
 * Export ook `computeBookieConcentration` + `writeTrainingExamplesForSettled`
 * als pure helpers (gebruikt door admin-routes en daily-results hook).
 *
 * @param {object} deps
 *   - supabase
 *   - loadCalib, saveCalib
 *   - readBets, getAdminUserId
 *   - notify
 *   - normalizeSport, detectMarket
 *   - autoTuneSignalsByClv
 *   - loadSignalWeights
 *   - getCurrentModelVersionId  — fn () → string|null (mutable ref)
 *   - getUnitEur                — fn () → number (huidige global UNIT_EUR)
 * @returns {object} schedulers
 */
module.exports = function createMaintenanceSchedulers(deps) {
  const {
    supabase, loadCalib, saveCalib,
    readBets, getAdminUserId,
    notify,
    normalizeSport, detectMarket,
    autoTuneSignalsByClv, loadSignalWeights,
    getCurrentModelVersionId,
    getUnitEur,
  } = deps;

  const required = {
    supabase, loadCalib, saveCalib,
    readBets, getAdminUserId,
    notify,
    normalizeSport, detectMarket,
    autoTuneSignalsByClv, loadSignalWeights,
    getCurrentModelVersionId, getUnitEur,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createMaintenanceSchedulers: missing required dep '${key}'`);
    }
  }

  const CLV_ALERT_INTERVAL = 25;
  const DD_ALERT_THRESHOLD = -0.15;
  const DD_ALERT_COOLDOWN_MS = 24 * 3600 * 1000;
  const DRIFT_ALERT_RESET_MS = 7 * 86400000;

  let _lastClvAlertN = 0;
  let _lastDdAlertAt = 0;
  const _driftAlertedKeys = new Set();
  let _driftAlertResetAt = Date.now();
  let _lastBookieConcAlertAt = 0;
  let _lastAutotuneAt = 0;
  let _lastAutotuneSettledCount = null;

  async function runRetentionCleanup() {
    const ODDS_RETENTION_DAYS = 30;
    const FEATURE_RETENTION_DAYS = 60;
    try {
      const oddsIso = new Date(Date.now() - ODDS_RETENTION_DAYS * 86400000).toISOString();
      const { error: oErr, count: oCount } = await supabase.from('odds_snapshots')
        .delete({ count: 'estimated' }).lt('captured_at', oddsIso);
      if (oErr) console.warn('[retention] odds_snapshots delete:', oErr.message);
      else console.log(`🧹 odds_snapshots: ${oCount ?? '?'} rows ouder dan ${ODDS_RETENTION_DAYS}d verwijderd`);

      const fIso = new Date(Date.now() - FEATURE_RETENTION_DAYS * 86400000).toISOString();
      const { error: fErr, count: fCount } = await supabase.from('feature_snapshots')
        .delete({ count: 'estimated' }).lt('captured_at', fIso);
      if (fErr) console.warn('[retention] feature_snapshots delete:', fErr.message);
      else console.log(`🧹 feature_snapshots: ${fCount ?? '?'} rows ouder dan ${FEATURE_RETENTION_DAYS}d verwijderd`);
    } catch (e) {
      console.warn('[retention] crash:', e.message);
    }
  }
  function scheduleRetentionCleanup() {
    setTimeout(() => {
      runRetentionCleanup();
      setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);
    }, 5 * 60 * 1000);
  }

  async function runScheduledAutotune() {
    try {
      const { count, error } = await supabase.from('bets')
        .select('bet_id', { count: 'exact', head: true })
        .in('uitkomst', ['W', 'L']);
      if (error) return;
      const currentSettled = Number.isFinite(count) ? count : 0;
      if (_lastAutotuneSettledCount !== null) {
        const newSinceLast = currentSettled - _lastAutotuneSettledCount;
        if (newSinceLast < 20) return;
      }
      const result = await autoTuneSignalsByClv();
      _lastAutotuneAt = Date.now();
      _lastAutotuneSettledCount = currentSettled;
      if (!result || result.error) return;
      const big = (result.adjustments || []).filter(a => Math.abs(a.new - a.old) >= 0.10);
      if (big.length) {
        const top = big.slice(0, 3).map(a => `${a.name}: ${a.old}→${a.new} (${a.reason || 'delta'})`).join('\n• ');
        notify(
          `🧠 AUTOTUNE LARGE CHANGE\n${big.length} signaal(en) met ≥10% weight-shift:\n• ${top}`,
          'autotune_large_change'
        ).catch(() => {});
      }
      if (result.tuned) {
        await supabase.from('notifications').insert({
          type: 'autotune_run', title: `🧠 Autotune gedraaid`,
          body: `${result.tuned} signaal(en) geadjusteerd · ${result.muted || 0} gemute · ${result.drifted || 0} drift-flagged · ${result.fdrDampened || 0} FDR-soft · cur settled ${currentSettled}`,
          read: false, user_id: null,
        }).then(() => {}, () => {});
      }
    } catch (e) {
      console.warn('[scheduled-autotune] failed:', e.message);
    }
  }
  function scheduleAutotune() {
    setTimeout(() => {
      runScheduledAutotune();
      setInterval(runScheduledAutotune, 6 * 60 * 60 * 1000);
    }, 4 * 60 * 60 * 1000);
  }

  function computeBookieConcentration(bets, windowDays = 7, nowMs = Date.now()) {
    if (!Array.isArray(bets) || bets.length === 0) return { total: 0, perBookie: [], maxShare: 0, maxBookie: null };
    const msPerDay = 86400000;
    const cutoff = nowMs - windowDays * msPerDay;
    const byBookie = new Map();
    let total = 0;
    for (const b of bets) {
      if (!b || !b.bookie || !Number.isFinite(b.inzet) || b.inzet <= 0) continue;
      let ms = null;
      if (b.datum && typeof b.datum === 'string') {
        const dm = b.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (dm) ms = Date.parse(`${dm[3]}-${dm[2]}-${dm[1]}T12:00:00Z`);
      } else if (Number.isFinite(b.timestamp_ms)) {
        ms = b.timestamp_ms;
      }
      if (!Number.isFinite(ms) || ms < cutoff) continue;
      const key = String(b.bookie).toLowerCase();
      byBookie.set(key, (byBookie.get(key) || 0) + b.inzet);
      total += b.inzet;
    }
    const perBookie = [...byBookie.entries()]
      .map(([bookie, stake]) => ({ bookie, stake: +stake.toFixed(2), share: total > 0 ? +(stake / total).toFixed(4) : 0 }))
      .sort((a, b) => b.share - a.share);
    const top = perBookie[0] || { share: 0, bookie: null };
    return { total: +total.toFixed(2), perBookie, maxShare: top.share, maxBookie: top.bookie };
  }

  async function runBookieConcentrationCheck() {
    try {
      const { data: bets } = await supabase.from('bets')
        .select('bookie, inzet, datum').not('bookie', 'is', null);
      if (!Array.isArray(bets) || bets.length === 0) return;
      const conc = computeBookieConcentration(bets, 7, Date.now());
      if (conc.total < 50) return;
      if (conc.maxShare <= 0.60) return;
      const MIN_REALERT_MS = 24 * 60 * 60 * 1000;
      if (Date.now() - _lastBookieConcAlertAt < MIN_REALERT_MS) return;
      _lastBookieConcAlertAt = Date.now();
      const top3 = conc.perBookie.slice(0, 3)
        .map(b => `${b.bookie} ${(b.share * 100).toFixed(0)}% (€${b.stake})`).join(' · ');
      notify(
        `🏦 BOOKIE CONCENTRATIE HOOG\n${conc.maxBookie}: ${(conc.maxShare*100).toFixed(0)}% van €${conc.total} 7d volume.\nSpreid risico vóór soft-book limits/closure.\n${top3}`,
        'bookie_concentration'
      ).catch(() => {});
    } catch (e) {
      console.warn('[bookie-concentration] check failed:', e.message);
    }
  }
  function scheduleBookieConcentrationWatcher() {
    setTimeout(() => {
      runBookieConcentrationCheck();
      setInterval(runBookieConcentrationCheck, 6 * 60 * 60 * 1000);
    }, 60 * 60 * 1000);
  }

  function scheduleHealthAlerts() {
    const INTERVAL_MS = 60 * 60 * 1000;

    async function runHealthCheck() {
      try {
        const { data: clvBets } = await supabase.from('bets')
          .select('clv_pct, sport, markt').not('clv_pct', 'is', null);
        const all = (clvBets || []).filter(b => typeof b.clv_pct === 'number');
        if (_lastClvAlertN === 0) {
          try {
            const cCur = loadCalib();
            if (typeof cCur.lastClvAlertN === 'number') {
              _lastClvAlertN = cCur.lastClvAlertN;
            } else {
              _lastClvAlertN = Math.floor(all.length / CLV_ALERT_INTERVAL) * CLV_ALERT_INTERVAL;
              cCur.lastClvAlertN = _lastClvAlertN;
              await saveCalib(cCur);
            }
          } catch (e) {
            console.warn('CLV milestone counter init failed:', e.message);
            _lastClvAlertN = all.length;
          }
        }
        if (all.length >= _lastClvAlertN + CLV_ALERT_INTERVAL) {
          const avgClv = all.reduce((s, b) => s + b.clv_pct, 0) / all.length;
          const positive = all.filter(b => b.clv_pct > 0).length;
          const posPct = (positive / all.length * 100).toFixed(1);
          const verdict = avgClv > 1 ? '✅ EDGE BEWEZEN'
                        : avgClv > 0 ? '🟢 mild positief'
                        : avgClv > -2 ? '🟡 neutraal'
                        : '🔴 STRUCTUREEL NEGATIEF';
          const byMarket = {};
          for (const b of all) {
            const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
            if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0 };
            byMarket[key].n++;
            byMarket[key].sumClv += b.clv_pct;
          }
          const marketLines = Object.entries(byMarket)
            .filter(([, d]) => d.n >= 10)
            .map(([k, d]) => {
              const m = d.sumClv / d.n;
              const ico = m > 1 ? '✅' : m > 0 ? '🟢' : m > -2 ? '🟡' : '🔴';
              return `${ico} ${k}: ${m > 0 ? '+' : ''}${m.toFixed(2)}% (n=${d.n})`;
            })
            .sort()
            .join('\n');
          const marketSummary = marketLines || '(nog geen markt met ≥10 samples)';
          await notify(`📊 CLV Milestone\n${all.length} settled bets met CLV data\nGemiddelde CLV: ${avgClv > 0 ? '+' : ''}${avgClv.toFixed(2)}%\n${positive}/${all.length} positief (${posPct}%)\n${verdict}\n\nPer markt (≥10 bets):\n${marketSummary}`).catch(() => {});
          await supabase.from('notifications').insert({
            type: 'clv_milestone',
            title: `📊 CLV Milestone — ${all.length} settled bets`,
            body: `Gem. CLV ${avgClv > 0 ? '+' : ''}${avgClv.toFixed(2)}% · ${positive}/${all.length} positief (${posPct}%) · ${verdict}\n\nPer markt:\n${marketSummary}`.slice(0, 1500),
            read: false, user_id: null,
          }).then(() => {}, () => {});
          _lastClvAlertN = all.length;
          try {
            const cPersist = loadCalib();
            cPersist.lastClvAlertN = all.length;
            await saveCalib(cPersist);
          } catch (e) { console.warn('Could not persist _lastClvAlertN:', e.message); }
        }

        if (Date.now() - _driftAlertResetAt > DRIFT_ALERT_RESET_MS) {
          _driftAlertedKeys.clear();
          _driftAlertResetAt = Date.now();
        }
        try {
          const driftAll = (clvBets || []).filter(b => typeof b.clv_pct === 'number');
          if (driftAll.length >= 30) {
            const byMarketRecent = {}, byMarketAll = {};
            for (let i = 0; i < driftAll.length; i++) {
              const b = driftAll[i];
              const k = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
              if (!byMarketAll[k]) byMarketAll[k] = [];
              byMarketAll[k].push(b.clv_pct);
              if (i < 25) {
                if (!byMarketRecent[k]) byMarketRecent[k] = [];
                byMarketRecent[k].push(b.clv_pct);
              }
            }
            for (const [k, recent] of Object.entries(byMarketRecent)) {
              if (recent.length < 10) continue;
              const allForMk = byMarketAll[k] || [];
              if (allForMk.length < 30) continue;
              const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
              const avgAll = allForMk.reduce((a, b) => a + b, 0) / allForMk.length;
              const drift = avgRecent - avgAll;
              const alertKey = `${k}_drop`;
              if (drift < -2 && !_driftAlertedKeys.has(alertKey)) {
                _driftAlertedKeys.add(alertKey);
                await supabase.from('notifications').insert({
                  type: 'drift_alert',
                  title: `📉 Drift gedetecteerd: ${k}`,
                  body: `Recente CLV ${avgRecent.toFixed(2)}% vs all-time ${avgAll.toFixed(2)}% (Δ ${drift.toFixed(2)}%, n=${recent.length}/${allForMk.length}). Markt verslechtert. Overweeg observatie of admin override.`,
                  read: false, user_id: null,
                });
              }
            }
          }
        } catch { /* swallow */ }

        if (Date.now() - _lastDdAlertAt > DD_ALERT_COOLDOWN_MS) {
          const { bets, stats } = await readBets(await getAdminUserId());
          if (stats?.bankroll != null && stats?.startBankroll != null) {
            const sevenDaysAgo = Date.now() - 7 * 86400000;
            const recentSettled = (bets || []).filter(b => {
              if (b.uitkomst === 'Open') return false;
              const dm = (b.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
              if (!dm) return false;
              return Date.parse(`${dm[3]}-${dm[2]}-${dm[1]}`) > sevenDaysAgo;
            });
            const recent7dPnl = recentSettled.reduce((s, b) => s + parseFloat(b.wl || 0), 0);
            const recent7dPct = stats.startBankroll > 0 ? recent7dPnl / stats.startBankroll : 0;
            if (recent7dPct < DD_ALERT_THRESHOLD) {
              await notify(`⚠️ DRAWDOWN ALERT (soft)\nLaatste 7 dagen: ${(recent7dPct * 100).toFixed(1)}% (€${recent7dPnl.toFixed(2)})\nBankroll: €${stats.bankroll}\n\nGeen automatische pause. Overweeg unit-grootte verlagen of stop manueel.`).catch(() => {});
              await supabase.from('notifications').insert({
                type: 'drawdown_alert',
                title: `⚠️ Drawdown alert — laatste 7 dagen`,
                body: `P/L laatste 7 dagen: ${(recent7dPct * 100).toFixed(1)}% (€${recent7dPnl.toFixed(2)}). Bankroll: €${stats.bankroll}. Geen auto-pause — overweeg unit-verlagen of stop manueel.`,
                read: false, user_id: null,
              }).then(() => {}, () => {});
              _lastDdAlertAt = Date.now();
            }
          }
        }
      } catch (e) { console.error('Health alerts fout:', e.message); }
    }

    setTimeout(() => { runHealthCheck(); setInterval(runHealthCheck, INTERVAL_MS); }, 10 * 60 * 1000);
    console.log('🔔 Health alerts actief (CLV milestones + soft drawdown, hourly)');
  }

  function scheduleSignalStatsRefresh() {
    const INTERVAL_MS = 24 * 3600 * 1000;

    async function refresh() {
      const mvId = getCurrentModelVersionId();
      if (!mvId) return;
      try {
        const { data: bets } = await supabase.from('bets')
          .select('signals, clv_pct, wl, uitkomst, sport, markt, odds')
          .not('clv_pct', 'is', null);
        const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && b.signals);
        if (!all.length) return;

        const stats = {};
        for (const b of all) {
          let sigs;
          try { sigs = typeof b.signals === 'string' ? JSON.parse(b.signals) : b.signals; } catch { continue; }
          if (!Array.isArray(sigs)) continue;
          const odds = parseFloat(b.odds) || 0;
          const impliedP = odds > 1 ? 1 / odds : 0.5;
          const won = b.uitkomst === 'W' ? 1 : b.uitkomst === 'L' ? 0 : null;
          for (const sig of sigs) {
            const name = String(sig).split(':')[0];
            if (!name) continue;
            if (!stats[name]) stats[name] = { n: 0, sumClv: 0, sumPnl: 0, lifts: [] };
            stats[name].n++;
            stats[name].sumClv += b.clv_pct;
            stats[name].sumPnl += parseFloat(b.wl || 0);
            if (won != null) stats[name].lifts.push(won - impliedP);
          }
        }

        const weights = loadSignalWeights();
        let written = 0;
        for (const [name, s] of Object.entries(stats)) {
          if (s.n < 10) continue;
          await snap.upsertSignalStat(supabase, {
            modelVersionId: mvId,
            signalName: name,
            sampleSize: s.n,
            avgClv: s.sumClv / s.n,
            avgPnl: s.sumPnl / s.n,
            liftVsMarket: s.lifts.length ? s.lifts.reduce((a, b) => a + b, 0) / s.lifts.length : null,
            weight: weights[name] || 1.0,
          });
          written++;
        }
        console.log(`📊 Signal stats refresh: ${written} signals geüpdatet`);
      } catch (e) {
        console.error('Signal stats refresh fout:', e.message);
      }
    }

    setTimeout(() => { refresh(); setInterval(refresh, INTERVAL_MS); }, 30 * 60 * 1000);
    console.log('📊 Signal stats refresh actief (dagelijks vanaf +30min)');
  }

  async function writeTrainingExamplesForSettled() {
    try {
      const { data: bets } = await supabase.from('bets')
        .select('bet_id, fixture_id, markt, sport, uitkomst, datum')
        .in('uitkomst', ['W', 'L']).not('fixture_id', 'is', null);
      if (!bets?.length) return 0;
      let written = 0;
      for (const b of bets) {
        const marketType = detectMarket(b.markt || 'other');
        const { data: existing } = await supabase.from('training_examples')
          .select('id').eq('fixture_id', b.fixture_id).eq('market_type', marketType).maybeSingle();
        if (existing?.id) continue;
        const { data: feat } = await supabase.from('feature_snapshots')
          .select('id, captured_at').eq('fixture_id', b.fixture_id)
          .order('captured_at', { ascending: false }).limit(1).maybeSingle();
        const { data: cons } = await supabase.from('market_consensus')
          .select('id').eq('fixture_id', b.fixture_id).eq('market_type', marketType)
          .order('captured_at', { ascending: false }).limit(1).maybeSingle();
        const label = { won: b.uitkomst === 'W' ? 1 : 0 };
        await snap.writeTrainingExample(supabase, {
          fixtureId: b.fixture_id, marketType,
          snapshotTime: feat?.captured_at || new Date().toISOString(),
          featureSnapshotId: feat?.id || null,
          marketConsensusId: cons?.id || null,
          label,
        });
        written++;
      }
      if (written) console.log(`📚 Training examples geschreven: ${written}`);
      return written;
    } catch (e) { console.error('writeTrainingExamples fout:', e.message); return 0; }
  }

  function scheduleAutoRetraining() {
    const INTERVAL_MS = 7 * 24 * 3600 * 1000;
    const MIN_PICKS = 500;

    async function runRetrainCheck() {
      try {
        const { data: candidates } = await supabase.from('pick_candidates')
          .select('fixture_id, model_run_id');
        if (!candidates?.length) {
          console.log('📐 Auto-retrain: 0 pick_candidates, skip');
          return;
        }
        const { data: runs } = await supabase.from('model_runs')
          .select('id, market_type, debug');
        const runMap = {};
        for (const r of (runs || [])) {
          runMap[r.id] = { market_type: r.market_type, sport: r.debug?.sport || 'multi' };
        }
        const buckets = {};
        for (const c of candidates) {
          const meta = runMap[c.model_run_id];
          if (!meta) continue;
          const key = `${meta.sport}_${meta.market_type}`;
          buckets[key] = (buckets[key] || 0) + 1;
        }
        const eligible = Object.entries(buckets).filter(([, n]) => n >= MIN_PICKS);
        if (eligible.length) {
          console.log(`📐 Auto-retrain: ${eligible.length} markten met ≥${MIN_PICKS} candidates klaar voor training:`);
          for (const [k, n] of eligible) console.log(`   - ${k}: ${n} candidates`);
        } else {
          console.log(`📐 Auto-retrain: nog geen markt met ≥${MIN_PICKS} candidates (max ${Math.max(0, ...Object.values(buckets))})`);
        }
      } catch (e) {
        console.error('Auto-retrain check fout:', e.message);
      }
    }

    setTimeout(() => {
      runRetrainCheck();
      setInterval(runRetrainCheck, INTERVAL_MS);
    }, 60 * 60 * 1000);
    console.log('📐 Auto-retraining scheduler actief (wekelijks check vanaf +1u)');
  }

  async function checkUnitSizeChange() {
    try {
      const unitEur = getUnitEur();
      const { data: lastSetting } = await supabase.from('notifications').select('*')
        .eq('type', 'unit_change').order('created_at', { ascending: false }).limit(1).single();
      const lastUnit = lastSetting?.body?.match(/(\d+)/)?.[1];
      if (lastUnit && parseInt(lastUnit) !== unitEur) {
        await notify(`💰 Unit size gewijzigd: €${lastUnit} → €${unitEur} op ${new Date().toLocaleDateString('nl-NL')}`, 'unit_change');
        console.log(`💰 Unit size wijziging gelogd: €${lastUnit} → €${unitEur}`);
      } else if (!lastUnit) {
        await notify(`💰 Unit baseline: €${unitEur} vanaf ${new Date().toLocaleDateString('nl-NL')}`, 'unit_change');
        console.log(`💰 Unit baseline gelogd: €${unitEur}`);
      }
    } catch (e) {
      try {
        const unitEur = getUnitEur();
        await notify(`💰 Unit baseline: €${unitEur} vanaf ${new Date().toLocaleDateString('nl-NL')}`, 'unit_change');
        console.log(`💰 Unit baseline gelogd: €${unitEur}`);
      } catch (notifyErr) {
        console.warn('Unit baseline notify failed:', notifyErr.message);
      }
    }
  }

  return {
    scheduleRetentionCleanup,
    scheduleAutotune,
    scheduleBookieConcentrationWatcher,
    scheduleHealthAlerts,
    scheduleSignalStatsRefresh,
    scheduleAutoRetraining,
    checkUnitSizeChange,
    computeBookieConcentration,
    writeTrainingExamplesForSettled,
    runScheduledAutotune,
    runBookieConcentrationCheck,
    runRetentionCleanup,
  };
};
