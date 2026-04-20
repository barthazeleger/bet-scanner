'use strict';

/**
 * v11.3.26 · Phase 9.2: runFullScan orchestrator extracted uit server.js.
 *
 * Coördineert de multi-sport scan: football (runPrematch) + basketball/hockey/
 * baseball/NFL/handball in parallel, vervolgens kill-switch, correlatie-damping,
 * diversification cap, scan_entry write, notify, en safePicks projection.
 *
 * De per-sport scan bodies (runBasketball, runHockey, etc.) blijven in
 * server.js — die dragen het meeste business-logic volume en vereisen eigen
 * integration-tests voordat ze veilig kunnen worden geëxtracteerd.
 *
 * Factory pattern met vele deps (scan-orchestration coördineert veel state).
 * Alle mutable global-state wordt via getter-functies gelezen zodat de
 * orchestrator altijd de actuele waarde ziet.
 *
 * @param {object} deps
 *   Sport-scan helpers:
 *   - runPrematch, runBasketball, runHockey, runBaseball, runFootballUS, runHandball
 *
 *   Pre-scan prep:
 *   - setPreferredBookies, refreshActiveUnitEur, recomputeStakeRegime
 *   - getActiveUnitEur, getActiveStartBankroll, getCurrentStakeRegime (getters)
 *   - defaultUnitEur, defaultStartBankroll
 *
 *   Post-scan logic:
 *   - isMarketKilled, applyCorrelationDamp
 *   - refreshSportCaps, getSportCap, getSportCapCache (getter), sportCapTtlMs
 *   - getMarketSampleCache (getter)
 *   - normalizeSport, detectMarket
 *   - operator (object met max_picks_per_day / panic_mode)
 *
 *   Output + persist:
 *   - saveScanEntry, notify, logScanEnd
 *   - kellyScore
 *
 *   Infra:
 *   - supabase
 * @returns {{ runFullScan: (opts) => Promise<{safePicks, safeCombis, topPicks, topCombis, allPicks, beforeKill}> }}
 */
module.exports = function createScanOrchestrator(deps) {
  const {
    runPrematch, runBasketball, runHockey, runBaseball, runFootballUS, runHandball,
    setPreferredBookies, refreshActiveUnitEur, recomputeStakeRegime,
    getActiveUnitEur, getActiveStartBankroll, getCurrentStakeRegime,
    defaultUnitEur, defaultStartBankroll,
    isMarketKilled, applyCorrelationDamp,
    refreshSportCaps, getSportCap, getSportCapCache, sportCapTtlMs,
    getMarketSampleCache,
    normalizeSport, detectMarket,
    operator,
    saveScanEntry, notify, logScanEnd,
    kellyScore,
    supabase,
    // v12.0.2 (optional): setLastPrematchPicks laat orchestrator de gemergde
    // multi-sport picks terugschrijven naar de module-state die /api/picks
    // leest. Zonder dit schreef alleen runPrematch() zijn voetbal-subset weg,
    // en toonde analyse-tab geen hockey/basketball/baseball picks.
    setLastPrematchPicks,
  } = deps;

  const required = {
    runPrematch, runBasketball, runHockey, runBaseball, runFootballUS, runHandball,
    setPreferredBookies, refreshActiveUnitEur, recomputeStakeRegime,
    getActiveUnitEur, getActiveStartBankroll, getCurrentStakeRegime,
    isMarketKilled, applyCorrelationDamp,
    refreshSportCaps, getSportCap, getSportCapCache,
    getMarketSampleCache,
    normalizeSport, detectMarket,
    operator,
    saveScanEntry, notify, logScanEnd,
    kellyScore,
    supabase,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createScanOrchestrator: missing required dep '${key}'`);
    }
  }

  async function runFullScan({ emit = () => {}, prefs = null, isAdmin = true, triggerLabel = 'manual' } = {}) {
    const scanStartedAt = Date.now();
    try {
      setPreferredBookies(prefs);
      if (prefs?.length) emit({ log: `🏦 Edge-evaluatie op jouw bookies: ${prefs.join(', ')}` });

      await refreshActiveUnitEur();
      const activeUe = getActiveUnitEur();
      const activeSb = getActiveStartBankroll();
      if (activeUe !== defaultUnitEur || activeSb !== defaultStartBankroll) {
        emit({ log: `💰 Actieve unit: €${activeUe} · bankroll: €${activeSb}` });
      }

      await recomputeStakeRegime();
      const regime = getCurrentStakeRegime();
      if (regime) {
        emit({ log: `🎚️ Stake-regime: ${regime.regime} · Kelly ${regime.kellyFraction} · unit ×${regime.unitMultiplier}` });
      }

      const footballPicks = await runPrematch(emit);

      emit({ log: '🏀🏒⚾🏈🤾 Multi-sport scans starten...' });
      const [nbaPicks, nhlPicks, mlbPicks, nflPicks, handballPicks] = await Promise.all([
        runBasketball(emit).catch(err => { emit({ log: `⚠️ Basketball scan mislukt: ${err.message}` }); return []; }),
        runHockey(emit).catch(err => { emit({ log: `⚠️ Hockey scan mislukt: ${err.message}` }); return []; }),
        runBaseball(emit).catch(err => { emit({ log: `⚠️ Baseball scan mislukt: ${err.message}` }); return []; }),
        runFootballUS(emit).catch(err => { emit({ log: `⚠️ NFL scan mislukt: ${err.message}` }); return []; }),
        runHandball(emit).catch(err => { emit({ log: `⚠️ Handball scan mislukt: ${err.message}` }); return []; }),
      ]);

      let allPicks = [...footballPicks, ...nbaPicks, ...nhlPicks, ...mlbPicks, ...nflPicks, ...handballPicks];

      // Kill-switch enforcement.
      const beforeKill = allPicks.length;
      const killedPicks = allPicks.filter(p => isMarketKilled(p.sport, p.label));
      allPicks = allPicks.filter(p => !isMarketKilled(p.sport, p.label));
      const killedCount = beforeKill - allPicks.length;
      if (killedCount > 0) {
        emit({ log: `🛑 Kill-switch: ${killedCount} pick(s) geblokkeerd op markt-CLV regels` });
        try {
          const sample = killedPicks.slice(0, 3).map(p => `${p.match} (${p.label})`).join('; ');
          await supabase.from('notifications').insert({
            type: 'kill_switch',
            title: `🛑 ${killedCount} pick(s) geblokkeerd door kill-switch`,
            body: `${killedCount} potentiële picks vielen weg omdat de markt structureel negatieve CLV heeft.\nVoorbeelden: ${sample}${killedPicks.length > 3 ? ` (+${killedPicks.length - 3} meer)` : ''}`,
            read: false, user_id: null,
          });
        } catch { /* swallow */ }
      }

      // Correlatie-demping op league-day clusters + same-fixture.
      const preDampCount = allPicks.filter(p => p.correlationAudit).length;
      void preDampCount;
      applyCorrelationDamp(allPicks);
      const dampedCount = allPicks.filter(p => p.correlationAudit && p.correlationAudit.dampFactor < 1.0).length;
      if (dampedCount > 0) emit({ log: `📉 Correlatie-demping: ${dampedCount} pick(s) gedempt (zelfde league/dag of wedstrijd)` });

      allPicks.sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0));

      // Diversification.
      const MAX_PICKS = operator.panic_mode ? Math.min(2, operator.max_picks_per_day) : operator.max_picks_per_day;
      const MAX_PER_MATCH = 1;
      const sportCapCache = getSportCapCache();
      const sportCapTtl = Number.isFinite(sportCapTtlMs) ? sportCapTtlMs : 10 * 60 * 1000;
      if (Date.now() - sportCapCache.at > sportCapTtl) {
        await refreshSportCaps().catch(() => {});
      }
      if (operator.panic_mode) {
        const beforePanic = allPicks.length;
        const marketSampleCache = getMarketSampleCache();
        allPicks = allPicks.filter(p => {
          const key = `${normalizeSport(p.sport)}_${detectMarket(p.label)}`;
          return (marketSampleCache.data[key] || 0) >= 100;
        });
        const panicSkipped = beforePanic - allPicks.length;
        if (panicSkipped) emit({ log: `🚨 Panic mode: ${panicSkipped} pick(s) geskipt (alleen PROVEN markten)` });
      }
      const seenMatches = new Map();
      const seenSports = new Map();
      const topPicks = [];
      const skippedReasons = { same_match: 0, same_sport_cap: 0 };
      for (const p of allPicks) {
        if (topPicks.length >= MAX_PICKS) break;
        const matchKey = (p.match || '').toLowerCase().trim();
        const sportKey = normalizeSport(p.sport || 'unknown');
        const sportCap = getSportCap(sportKey);
        if (matchKey && (seenMatches.get(matchKey) || 0) >= MAX_PER_MATCH) { skippedReasons.same_match++; continue; }
        if ((seenSports.get(sportKey) || 0) >= sportCap) { skippedReasons.same_sport_cap++; continue; }
        topPicks.push(p);
        if (matchKey) seenMatches.set(matchKey, (seenMatches.get(matchKey) || 0) + 1);
        seenSports.set(sportKey, (seenSports.get(sportKey) || 0) + 1);
      }
      const droppedCount = allPicks.length - topPicks.length;

      emit({ log: `🌐 Totaal: ${footballPicks.length} voetbal + ${nbaPicks.length} basketball + ${nhlPicks.length} hockey + ${mlbPicks.length} baseball + ${nflPicks.length} NFL + ${handballPicks.length} handball = ${beforeKill} kandidaten` });
      const provenSports = Object.entries(sportCapCache.stats || {})
        .filter(([, s]) => s.cap === 3)
        .map(([k, s]) => `${k}(n=${s.n}, ROI ${s.roi > 0 ? '+' : ''}${s.roi}%)`);
      if (provenSports.length) emit({ log: `🏆 Bewezen sporten (cap=3): ${provenSports.join(', ')}` });
      if (skippedReasons.same_match) emit({ log: `🎯 ${skippedReasons.same_match} pick(s) geskipt: zelfde wedstrijd al in selectie (correlatie)` });
      if (skippedReasons.same_sport_cap) emit({ log: `🎯 ${skippedReasons.same_sport_cap} pick(s) geskipt: per-sport cap bereikt (default 2, bewezen sport 3)` });
      if (droppedCount > 0) emit({ log: `🎯 ${topPicks.length}/${MAX_PICKS} picks geselecteerd (${droppedCount} weggelaten door diversification + ranking)` });

      if (topPicks.length === 0) {
        emit({ log: `✋ Geen picks vandaag — ons systeem zag te weinig value. Dat is goed: niet elke dag is een edge-dag.` });
      } else if (topPicks.length <= 2) {
        emit({ log: `✋ ${topPicks.length} pick(s) — kwaliteit boven volume. Strenge filters hebben hun werk gedaan.` });
      }

      const topSet = new Set(topPicks);
      for (const p of allPicks) p.selected = topSet.has(p);

      const topCombis = allPicks
        .filter(p => p.isCombi && !topSet.has(p))
        .sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0))
        .slice(0, 3);
      for (const p of topCombis) p.combiAlternative = true;

      saveScanEntry(allPicks, 'prematch', beforeKill);

      // v12.0.2: overschrijf de module-state die /api/picks leest met de
      // gemergde multi-sport `allPicks`. Voorheen schreef alleen runPrematch()
      // zijn voetbal-subset weg → analyse-tab zag alleen football terwijl de
      // scans-tab (SSE live-stream) wel alle sports toonde. Inconsistentie
      // tussen scans/analyse verholpen door hier allPicks te persisten.
      if (typeof setLastPrematchPicks === 'function') {
        try { setLastPrematchPicks(allPicks); } catch { /* swallow */ }
      }

      // Web-push + inbox notificatie.
      if (topPicks.length > 0) {
        const sportEmoji = { football: '⚽', basketball: '🏀', hockey: '🏒', baseball: '⚾', 'american-football': '🏈', handball: '🤾' };
        const todayLabel = new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' });
        let msg = `🎯 EDGEPICKR DAILY SCAN\n📅 ${todayLabel}\n📊 ${allPicks.length} kandidaten uit 6 sporten\n✅ TOP ${topPicks.length} PICKS\n\n`;
        topPicks.forEach((p, i) => {
          const icon = sportEmoji[p.sport] || '🏆';
          const star = i === 0 ? '⭐' : i === 1 ? '🔵' : '•';
          msg += `${star} ${icon} ${p.match}\n${p.league}\n📌 ${p.label}\n💰 Odds: ${p.odd} | ${p.units}\n📈 Kans: ${p.prob}%\n\n`;
        });
        notify(msg).catch(() => {});
      } else {
        const todayLabel = new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' });
        notify(`🎯 EDGEPICKR DAILY SCAN\n📅 ${todayLabel}\n\n🚫 Geen picks met voldoende edge gevonden.`).catch(() => {});
      }

      const toSafe = (p) => {
        const hk = p.kelly || 0;
        const score = kellyScore(hk);
        // v12.1.1 (operator-rapport): fixtureId meegeven zodat frontend het
        // kan doorzetten naar POST /api/bets bij bet-loggen. Voorheen werd
        // `_fixtureMeta.fixtureId` alleen intern gebruikt voor post-scan gate
        // en nooit naar de UI-pick geprojecteerd → modalPick.fixtureId = null
        // → bet-row krijgt fixture_id=null → "huidige odds ophalen" toont
        // "Geen fixture_id gekoppeld" voor elke bet.
        const fixtureId = p._fixtureMeta?.fixtureId || p.fixtureId || null;
        const pick = {
          match: p.match, league: p.league, label: p.label, odd: p.odd,
          prob: p.prob, units: p.units, edge: p.edge, score,
          kickoff: p.kickoff, scanType: p.scanType, bookie: p.bookie,
          sport: p.sport || 'football', audit: p.audit || null,
          isCombi: p.isCombi === true, legs: p.legs || null,
          fixtureId,
        };
        if (isAdmin) { pick.reason = p.reason; pick.kelly = p.kelly; pick.ep = p.ep; pick.strength = p.strength; pick.expectedEur = p.expectedEur; pick.signals = p.signals || []; }
        return pick;
      };
      const safePicks = topPicks.map(toSafe);
      const safeCombis = topCombis.map(toSafe);

      await logScanEnd(supabase, {
        triggerLabel,
        picksCount: topPicks.length,
        candidatesCount: beforeKill,
        durationMs: Date.now() - scanStartedAt,
        sports: ['football', 'basketball', 'hockey', 'baseball', 'american-football', 'handball'],
      });

      return { safePicks, safeCombis, topPicks, topCombis, allPicks, beforeKill };
    } finally {
      setPreferredBookies(null);
    }
  }

  return { runFullScan };
};
