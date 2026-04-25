'use strict';

const { sanitizeUnsupportedClvFields } = require('./clv-match');

/**
 * v11.3.21 · Phase 6.3: Data-access laag voor de `bets` Supabase-tabel
 * extracted uit server.js. Pure data-toegang + stats-berekening.
 *
 * Factory pattern. Gebruik:
 *   const bd = createBetsData({ supabase, getUserMoneySettings, revertCalibration, updateCalibration, ... });
 *   const { bets, stats } = await bd.readBets(userId);
 *
 * Verantwoordelijkheden:
 *   - calcStats         — pure aggregaties (W/L, ROI, CLV, variance, potentiële winst/verlies vandaag).
 *   - readBets          — leest bets uit Supabase, projecteert naar app-vorm, berekent stats.
 *   - getUserUnitEur    — thin wrapper om unitEur op te halen voor writes.
 *   - writeBet          — inserts nieuwe bet met schema-tolerant tier-retry (v10.10.7 → legacy).
 *   - updateBetOutcome  — update uitkomst + wl, trigger revert+apply calibration bij flip.
 *   - deleteBet         — verwijder bet uit Supabase (user-scoped).
 *
 * @param {object} deps
 *   - supabase
 *   - getUserMoneySettings — async (userId) → { startBankroll, unitEur }
 *   - defaultStartBankroll — number fallback voor calcStats
 *   - defaultUnitEur       — number fallback voor calcStats
 *   - revertCalibration    — async (bet, userId) → void (voor outcome-flip)
 *   - updateCalibration    — async (bet, userId) → void (voor nieuwe settled)
 * @returns {object}
 */
module.exports = function createBetsData(deps) {
  const {
    supabase,
    getUserMoneySettings,
    defaultStartBankroll,
    defaultUnitEur,
    revertCalibration,
    updateCalibration,
    bookieBalanceStore, // v12.2.0: optional — hooks fire als geinjecteerd
  } = deps;

  const required = {
    supabase, getUserMoneySettings,
    revertCalibration, updateCalibration,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createBetsData: missing required dep '${key}'`);
    }
  }

  function calcStats(bets, startBankroll = defaultStartBankroll, unitEur = defaultUnitEur) {
    const W     = bets.filter(b => b.uitkomst === 'W').length;
    const L     = bets.filter(b => b.uitkomst === 'L').length;
    const open  = bets.filter(b => b.uitkomst === 'Open').length;
    const total = bets.length;
    const wlEur = bets.reduce((s, b) => s + (b.uitkomst !== 'Open' ? b.wl : 0), 0);
    const totalInzet = bets.filter(b => b.uitkomst !== 'Open').reduce((s, b) => s + b.inzet, 0);
    const roi   = totalInzet > 0 ? wlEur / totalInzet : 0;
    const bankroll  = +(startBankroll + wlEur).toFixed(2);
    const avgOdds   = total > 0 ? +(bets.reduce((s,b)=>s+b.odds,0)/total).toFixed(3) : 0;
    const avgUnits  = total > 0 ? +(bets.reduce((s,b)=>s+b.units,0)/total).toFixed(2) : 0;
    const strikeRate = (W+L) > 0 ? Math.round(W/(W+L)*100) : 0;
    const unitFor = (b) => {
      const ue = b && b.unitAtTime;
      return Number.isFinite(ue) && ue > 0 ? ue : unitEur;
    };
    const winU  = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>{ const ue = unitFor(b); return ue > 0 ? s + (b.wl/ue) : s; },0).toFixed(2);
    const lossU = +bets.filter(b=>b.uitkomst==='L').reduce((s,b)=>{ const ue = unitFor(b); return ue > 0 ? s + (b.wl/ue) : s; },0).toFixed(2);
    const clvBets = bets.filter(b => b.clvPct !== null && b.clvPct !== undefined && !isNaN(b.clvPct));
    const avgCLV = clvBets.length > 0 ? +(clvBets.reduce((s, b) => s + b.clvPct, 0) / clvBets.length).toFixed(2) : 0;
    const clvPositive = clvBets.filter(b => b.clvPct > 0).length;
    const clvTotal = clvBets.length;

    const settledBets = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    const expectedWins = +settledBets.reduce((s, b) => {
      const prob = b.odds > 1 ? 1 / b.odds : 0.5;
      return s + prob;
    }, 0).toFixed(2);
    const actualWins = W;
    const variance = +(actualWins - expectedWins).toFixed(2);
    const varianceStdDev = +Math.sqrt(settledBets.reduce((s, b) => {
      const prob = b.odds > 1 ? 1 / b.odds : 0.5;
      return s + prob * (1 - prob);
    }, 0)).toFixed(2);
    const luckFactor = varianceStdDev > 0 ? +(variance / varianceStdDev).toFixed(2) : 0;

    // v12.1.2: "vandaag" = today-slate inclusief nachtwedstrijden die pas morgen
    // van datum wisselen (bv. NHL 04:00 lokaal = datum morgen). Matcht zo de
    // tracker "Vandaag"-filter, die ook van today tot tomorrow toont. Zonder
    // deze uitbreiding telde 'pot. profit today (N bets)' minder bets dan er
    // in de gefilterde tabel zichtbaar waren.
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const tmStr = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const NIGHT_CUTOFF_HR = 6;
    const todayBets = bets.filter(b => {
      if (b.uitkomst !== 'Open') return false;
      const d = b.datum;
      if (!d) return false;
      const parts = d.split('-');
      if (parts.length !== 3) return false;
      const iso = `${parts[2]}-${parts[1]}-${parts[0]}`;
      if (iso === todayStr) return true;
      if (iso === tmStr) {
        const hhmm = (b.tijd || '').split(':');
        const hr = parseInt(hhmm[0], 10);
        if (Number.isFinite(hr) && hr < NIGHT_CUTOFF_HR) return true;
      }
      return false;
    });
    const potentialWin = +todayBets.reduce((s, b) => s + (b.odds - 1) * b.inzet, 0).toFixed(2);
    const potentialLoss = +todayBets.reduce((s, b) => s + b.inzet, 0).toFixed(2);
    const todayBetsCount = todayBets.length;

    const netUnits  = +bets.reduce((s, b) => {
      if (b.uitkomst === 'Open') return s;
      const ue = unitFor(b);
      return ue > 0 ? s + (b.wl / ue) : s;
    }, 0).toFixed(2);
    const netProfit = +wlEur.toFixed(2);

    return { total, W, L, open, wlEur: +wlEur.toFixed(2), roi: +roi.toFixed(4),
             bankroll, startBankroll, avgOdds, avgUnits, strikeRate, winU, lossU,
             netUnits, netProfit,
             avgCLV, clvPositive, clvTotal,
             expectedWins, actualWins, variance, varianceStdDev, luckFactor,
             potentialWin, potentialLoss, todayBetsCount };
  }

  async function readBets(userId = null, money = null) {
    const effectiveMoney = money || await getUserMoneySettings(userId);
    let query = supabase.from('bets').select('*').order('bet_id', { ascending: true });
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const bets = (data || []).map(r => {
      const unitAtTime = Number.isFinite(parseFloat(r.unit_at_time)) && parseFloat(r.unit_at_time) > 0
        ? parseFloat(r.unit_at_time)
        : null;
      const ueForInzet = unitAtTime || effectiveMoney.unitEur;
      return sanitizeUnsupportedClvFields({
        id: r.bet_id, datum: r.datum || '', sport: r.sport || '', wedstrijd: r.wedstrijd || '',
        markt: r.markt || '', odds: r.odds || 0, units: r.units || 0,
        inzet: r.inzet != null ? r.inzet : +(r.units * ueForInzet).toFixed(2),
        tip: r.tip || 'Bet365', uitkomst: r.uitkomst || 'Open', wl: r.wl || 0,
        tijd: r.tijd || '', score: r.score || null,
        signals: r.signals || '', clvOdds: r.clv_odds || null, clvPct: r.clv_pct || null, sharpClvOdds: r.sharp_clv_odds || null, sharpClvPct: r.sharp_clv_pct || null,
        fixtureId: r.fixture_id || null,
        unitAtTime,
        // v11.3.23 F3 (Codex #1): preserve user_id zodat globale results-check
        // settled bets kan toeschrijven aan de juiste owner ipv userId=null.
        userId: r.user_id || null,
      });
    });
    return { bets, stats: calcStats(bets, effectiveMoney.startBankroll, effectiveMoney.unitEur), _raw: data };
  }

  async function getUserUnitEur(userId) {
    const { unitEur } = await getUserMoneySettings(userId);
    return unitEur;
  }

  // v11.3.27 (reviewer-fix): true atomic bet_id via Postgres sequence.
  // De migratie `docs/migrations-archive/v11.3.27_bets_bet_id_sequence.sql`
  // koppelt `bet_id` aan `nextval('bets_bet_id_seq')`. writeBet probeert
  // insert-zonder-bet_id (DB genereert unieke id via sequence) + `.select()`
  // om de gegenereerde id op te halen. Fallback: als de sequence nog niet is
  // toegepast (pre-migrate schema), valt writeBet terug op MAX+1 retry-loop
  // met exponential backoff en 10 attempts.
  async function allocateNextBetId() {
    const { data, error } = await supabase.from('bets')
      .select('bet_id').order('bet_id', { ascending: false }).limit(1);
    if (error) throw new Error(error.message);
    const max = Array.isArray(data) && data.length ? (Number(data[0].bet_id) || 0) : 0;
    return max + 1;
  }

  const UNIQUE_VIOLATION_RE = /duplicate key|23505|unique constraint|already exists/i;
  const NOT_NULL_BET_ID_RE = /null value in column "bet_id"|violates not-null/i;

  // Flip-flag zodat we na 1 succes via sequence niet meer de fallback proberen.
  let _sequenceKnownBroken = false;

  async function _trySequenceInsert(basePayload, fixtureId) {
    // Insert ZONDER bet_id → DB gebruikt default nextval(...) als sequence bestaat.
    // .select('bet_id').single() haalt de gegenereerde id op.
    try {
      let q = supabase.from('bets').insert({ ...basePayload, fixture_id: fixtureId }).select('bet_id').single();
      const { data, error } = await q;
      if (error) {
        // Not-null violation = geen default set op bet_id → sequence ontbreekt.
        if (NOT_NULL_BET_ID_RE.test(String(error.message || ''))) {
          _sequenceKnownBroken = true;
          return { fallback: true };
        }
        // Column error (fixture_id / unit_at_time niet in schema) → signal schema-tier-retry.
        return { columnMismatch: (error.message || '').toLowerCase().includes('column'), error };
      }
      return { ok: true, betId: Number(data?.bet_id) };
    } catch (e) {
      return { error: { message: e.message } };
    }
  }

  async function writeBet(bet, userId = null, unitEur = null) {
    const ue = unitEur ?? await getUserUnitEur(userId);
    const inzet = +(bet.units * ue).toFixed(2);
    const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2)
             : bet.uitkomst === 'L' ? -inzet : 0;
    const basePayload = {
      datum: bet.datum, sport: bet.sport, wedstrijd: bet.wedstrijd,
      markt: bet.markt, odds: bet.odds, units: bet.units, inzet, tip: bet.tip || 'Bet365',
      uitkomst: bet.uitkomst || 'Open', wl, tijd: bet.tijd || '', score: bet.score || null,
      signals: bet.signals || '',
      user_id: userId || null,
      unit_at_time: ue,
    };

    // Tier-1: DB-sequence (true atomic, race-proof). Werkt zodra v11.3.27
    // migratie is toegepast. Graceful fallback naar MAX+1 retry-loop als
    // sequence ontbreekt (pre-migrate schema).
    const balanceHookArgs = { tip: bet.tip || 'Bet365', inzet, odds: bet.odds, uitkomst: bet.uitkomst || 'Open' };
    if (!_sequenceKnownBroken && !bet.id) {
      const seqResult = await _trySequenceInsert(basePayload, bet.fixtureId || null);
      if (seqResult.ok) { bet.id = seqResult.betId; await maybeApplyBookieBalanceOnWrite(userId, balanceHookArgs); return; }
      if (seqResult.columnMismatch) {
        // Probeer schema-tiers met sequence (no fixture_id, dan ook geen unit_at_time).
        let seq2 = await _trySequenceInsert(basePayload, null);
        if (seq2.ok) { bet.id = seq2.betId; await maybeApplyBookieBalanceOnWrite(userId, balanceHookArgs); return; }
        if (seq2.columnMismatch) {
          const { unit_at_time, ...legacyBase } = basePayload;
          const seq3 = await _trySequenceInsert(legacyBase, null);
          if (seq3.ok) { bet.id = seq3.betId; await maybeApplyBookieBalanceOnWrite(userId, balanceHookArgs); return; }
        }
      }
      // seqResult.fallback=true of onbekende error → valt door naar tier-2.
    }

    // Tier-2 (fallback): MAX+1 retry-loop met exponential backoff.
    // Gemitigeerd maar niet race-proof. Alleen in gebruik als sequence ontbreekt
    // of bet.id expliciet is opgegeven (imports).
    const isColumnError = (msg) => (msg || '').toLowerCase().includes('column');
    const safeInsert = async (payload) => {
      try {
        const { error } = await supabase.from('bets').insert(payload);
        return error || null;
      } catch (e) {
        return { message: e.message };
      }
    };

    const MAX_ATTEMPTS = 10;
    let lastErr = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const betId = bet.id && attempt === 0 ? bet.id : await allocateNextBetId();
      const base = { bet_id: betId, ...basePayload };

      let err = await safeInsert({ ...base, fixture_id: bet.fixtureId || null });
      if (err && isColumnError(err.message)) err = await safeInsert(base);
      if (err && isColumnError(err.message)) {
        const { unit_at_time, ...legacy } = base;
        err = await safeInsert(legacy);
      }

      if (!err) {
        bet.id = betId;
        await maybeApplyBookieBalanceOnWrite(userId, balanceHookArgs);
        return;
      }
      lastErr = err;
      if (UNIQUE_VIOLATION_RE.test(String(err.message || ''))) {
        // Exponential backoff: 10ms, 20ms, 40ms, ... tot ~5s max.
        const backoffMs = Math.min(5000, 10 * Math.pow(2, attempt));
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      throw new Error(err.message);
    }
    throw new Error(`writeBet: ${MAX_ATTEMPTS} attempts failed, last: ${lastErr?.message || 'unknown'}`);
  }

  // v12.2.0: bookie-balance hook helpers. No-op als bookieBalanceStore niet is
  // geinjecteerd (bv. tijdens tests die alleen bet-logica checken).
  async function maybeApplyBookieBalanceOnWrite(userId, row) {
    if (!bookieBalanceStore || typeof bookieBalanceStore.onBetWritten !== 'function') return;
    try { await bookieBalanceStore.onBetWritten(userId, row); }
    catch (e) { console.warn('[bookie-balance] onBetWritten failed:', e.message); }
  }
  async function maybeApplyBookieBalanceOnOutcome(userId, args) {
    if (!bookieBalanceStore || typeof bookieBalanceStore.onBetOutcomeChanged !== 'function') return;
    try { await bookieBalanceStore.onBetOutcomeChanged(userId, args); }
    catch (e) { console.warn('[bookie-balance] onBetOutcomeChanged failed:', e.message); }
  }
  async function maybeApplyBookieBalanceOnDelete(userId, row) {
    if (!bookieBalanceStore || typeof bookieBalanceStore.onBetDeleted !== 'function') return;
    try { await bookieBalanceStore.onBetDeleted(userId, row); }
    catch (e) { console.warn('[bookie-balance] onBetDeleted failed:', e.message); }
  }

  async function updateBetOutcome(id, uitkomst, userId = null) {
    let query = supabase.from('bets').select('*').eq('bet_id', id);
    if (userId) query = query.eq('user_id', userId);
    const { data: row } = await query.single();
    if (!row) return;
    const odds = row.odds || 0;
    const units = row.units || 0;
    const userUnitEur = await getUserUnitEur(userId);
    const inzet = row.inzet != null ? row.inzet : +(units * userUnitEur).toFixed(2);
    const wl = uitkomst === 'W' ? +((odds-1)*inzet).toFixed(2) : uitkomst === 'L' ? -inzet : 0;
    const prevOutcome = row.uitkomst;
    let updateQuery = supabase.from('bets').update({ uitkomst, wl }).eq('bet_id', id);
    if (userId) updateQuery = updateQuery.eq('user_id', userId);
    await updateQuery;

    // v12.2.0: bookie-balance transition hook.
    await maybeApplyBookieBalanceOnOutcome(row.user_id || userId, {
      bookie: row.tip, inzet, odds,
      prevOutcome: prevOutcome || 'Open', newOutcome: uitkomst,
    });

    // v12.2.7 (F3): outcome-flip moet atomic over revert+update. Voorheen kon
    // updateCalibration halverwege gooien terwijl revertCalibration al was
    // uitgevoerd → calib half-gereverted, totalSettled telt fout. Fix: snapshot
    // calib pre-flip via deps.snapshotCalib (optional), bij exception restore.
    // Backwards-compat: als snapshotCalib niet ge-injecteerd is, valt terug op
    // oude (niet-atomic) flow.
    const prevSettled = prevOutcome === 'W' || prevOutcome === 'L';
    const newSettled = uitkomst === 'W' || uitkomst === 'L';
    const needsFlip = (prevSettled && prevOutcome !== uitkomst) || newSettled;
    let _calibSnapshot = null;
    const { snapshotCalib, restoreCalib } = deps;
    if (needsFlip && typeof snapshotCalib === 'function' && typeof restoreCalib === 'function') {
      try { _calibSnapshot = snapshotCalib(); } catch (_) { _calibSnapshot = null; }
    }
    try {
      if (prevSettled && prevOutcome !== uitkomst) {
        await revertCalibration({
          datum: row.datum, wedstrijd: row.wedstrijd, markt: row.markt,
          odds, units, uitkomst: prevOutcome, wl: row.wl,
          sport: row.sport || 'football', league: row.league,
          ep: row.ep, prob: row.prob,
        }, userId);
      }
    } catch (e) {
      if (_calibSnapshot && typeof restoreCalib === 'function') {
        try { restoreCalib(_calibSnapshot); }
        catch (re) { console.warn('[calibration] restore-after-flip-failure ook mislukt:', re.message); }
      }
      throw e;
    }
  }

  async function deleteBet(id, userId = null) {
    // v12.2.0: fetch row vóór delete zodat we de bookie-balance impact kunnen reversen.
    let selectQuery = supabase.from('bets').select('*').eq('bet_id', id);
    if (userId) selectQuery = selectQuery.eq('user_id', userId);
    const { data: row } = await selectQuery.single();

    let query = supabase.from('bets').delete().eq('bet_id', id);
    if (userId) query = query.eq('user_id', userId);
    await query;

    if (row) {
      const inzet = row.inzet != null ? row.inzet : +(Number(row.units || 0) * (await getUserUnitEur(userId))).toFixed(2);
      await maybeApplyBookieBalanceOnDelete(row.user_id || userId, {
        tip: row.tip, inzet, odds: row.odds, uitkomst: row.uitkomst || 'Open',
      });
    }
  }

  return {
    calcStats,
    readBets,
    getUserUnitEur,
    writeBet,
    updateBetOutcome,
    deleteBet,
  };
};
