'use strict';

const { normalizeMarketKey } = require('./market-keys');

/**
 * v12.2.21 (R2 partial): bet ↔ pick_candidate join-laag.
 *
 * Doel: voor settled bets de canonical model probability (`pick_candidate.fair_prob`)
 * vinden zodat we Brier/log-loss/isotonic over MODEL-output kunnen rekenen
 * ipv markt-proxy. Voorheen schreef calibration-monitor `probability_source='ep_proxy'`
 * — bewust, want join-laag ontbrak.
 *
 * Strategie:
 *   1. Map bet.markt → {market_type, selection_key, line} via canonical market-keys.
 *   2. Filter pick_candidates joined met model_runs op:
 *      - fixture_id = bet.fixture_id
 *      - market_type = derived
 *      - selection_key = derived
 *      - (line null-or-equal)
 *      - bookmaker (case-insensitive) = bet.tip
 *      - model_runs.captured_at < kickoff (laatste pre-kickoff snapshot)
 *   3. Returnt fair_prob en metadata; null als geen match.
 *
 * Pure helper — caller voert query uit. Deze functie ontvangt
 * (bet, pickCandidatesWithRun) en returnt de match.
 */

/**
 * @param {object} bet — uit bets-tabel: {fixture_id, markt, tip, datum, tijd, ...}
 * @param {Array<object>} candidates — pick_candidates rows joined met model_runs:
 *   [{ id, fixture_id, selection_key, bookmaker, fair_prob, bookmaker_odds,
 *      passed_filters, model_runs: { market_type, line, captured_at } }]
 * @returns {object|null}
 *   { picked: cand, fair_prob, modelRunId, capturedAt, score: 0..1 (match-quality) }
 */
function findMatchingPickCandidate(bet, candidates) {
  if (!bet || !Array.isArray(candidates) || !candidates.length) return null;
  const norm = normalizeMarketKey(bet.markt || '');
  if (!norm || !norm.clvShape) return null;
  const target = norm.clvShape;
  const targetBookie = String(bet.tip || '').toLowerCase().trim();
  if (!bet.fixture_id) return null;

  const matches = candidates.filter(c => {
    if (Number(c.fixture_id) !== Number(bet.fixture_id)) return false;
    const mr = c.model_runs || {};
    if (mr.market_type !== target.market_type) return false;
    if (c.selection_key !== target.selection_key) return false;
    // Line: beide null OR numerieke gelijkheid (precision tolerantie 0.01)
    const tLine = target.line == null ? null : Number(target.line);
    const cLine = mr.line == null ? null : Number(mr.line);
    if (tLine === null && cLine !== null) return false;
    if (tLine !== null && cLine === null) return false;
    if (tLine !== null && Math.abs(tLine - cLine) > 0.01) return false;
    // Bookmaker case-insensitive (allow Bet365 ↔ bet365)
    if (String(c.bookmaker || '').toLowerCase().trim() !== targetBookie) return false;
    return true;
  });
  if (!matches.length) return null;

  // Kies de meest recente pre-kickoff capture. We hebben geen exacte
  // kickoff-time hier; als bet.fixture_id ↔ fixtures join tijd geleverd wordt
  // kan caller die dependency injecten. Voor nu: meest recente capture (max
  // captured_at per match).
  matches.sort((a, b) => {
    const ta = Date.parse(a.model_runs?.captured_at || '') || 0;
    const tb = Date.parse(b.model_runs?.captured_at || '') || 0;
    return tb - ta;
  });
  const picked = matches[0];
  return {
    picked,
    fair_prob: Number(picked.fair_prob),
    modelRunId: picked.model_run_id || null,
    capturedAt: picked.model_runs?.captured_at || null,
    score: 1.0, // exact match
  };
}

/**
 * Bouw outcome_binary (0/1) voor een settled bet. Skip Open/Push/Void.
 * Returnt null als bet niet evalueerbaar.
 */
function outcomeBinaryFromBet(bet) {
  if (!bet) return null;
  const u = String(bet.uitkomst || '').toUpperCase();
  if (u === 'W') return 1;
  if (u === 'L') return 0;
  return null;
}

/**
 * Convenience: voor een lijst settled bets + bijbehorende pick_candidates,
 * produceer (predicted_prob, outcome_binary) records voor walk-forward.computeBrier.
 *
 * @returns {Array<{predicted_prob, outcome_binary, source: 'model'|'market', bet_id}>}
 */
function buildBrierRecords(bets, candidatesByFixture) {
  const out = [];
  for (const bet of bets || []) {
    const outcome = outcomeBinaryFromBet(bet);
    if (outcome === null) continue;
    const cands = candidatesByFixture instanceof Map
      ? (candidatesByFixture.get(bet.fixture_id) || [])
      : [];
    const m = findMatchingPickCandidate(bet, cands);
    if (m && Number.isFinite(m.fair_prob) && m.fair_prob > 0 && m.fair_prob < 1) {
      out.push({ predicted_prob: m.fair_prob, outcome_binary: outcome, source: 'model', bet_id: bet.bet_id });
    } else if (Number(bet.odds) > 1) {
      // Fallback: market-implied prob (1/odds) als baseline. Tag als 'market'.
      out.push({ predicted_prob: 1 / Number(bet.odds), outcome_binary: outcome, source: 'market', bet_id: bet.bet_id });
    }
  }
  return out;
}

/**
 * v12.2.45 (audit P2.4): coverage-breakdown — diagnose WAAROM de canonical
 * join faalt. Helpt operator om "insufficient_join_coverage" te interpreteren.
 *
 * Categorieën:
 *   - matched           : exacte match gevonden (canonical pick_ep beschikbaar)
 *   - no_candidate      : geen pick_candidate voor deze fixture
 *   - market_mismatch   : candidates bestaan maar marketType klopt niet
 *   - selection_mismatch: market matcht, selection_key niet
 *   - line_mismatch     : market+selection matcht, line niet
 *   - bookmaker_mismatch: alles match behalve bookie (case-insensitive)
 *   - bet_unparseable   : bet.markt onbruikbaar (geen clvShape)
 *
 * @param {object} bet - bet-row
 * @param {Array<object>} candidates - pick_candidates voor bet.fixture_id
 * @returns {{ category: string }}
 */
function diagnoseJoinFailure(bet, candidates) {
  if (!bet) return { category: 'bet_unparseable' };
  const norm = require('./market-keys').normalizeMarketKey(bet.markt || '');
  if (!norm || !norm.clvShape) return { category: 'bet_unparseable' };
  const target = norm.clvShape;
  const cands = Array.isArray(candidates) ? candidates : [];
  if (!cands.length) return { category: 'no_candidate' };
  const sameFixture = cands.filter(c => Number(c.fixture_id) === Number(bet.fixture_id));
  if (!sameFixture.length) return { category: 'no_candidate' };
  const sameMkt = sameFixture.filter(c => c.model_runs?.market_type === target.market_type);
  if (!sameMkt.length) return { category: 'market_mismatch' };
  const sameSel = sameMkt.filter(c => c.selection_key === target.selection_key);
  if (!sameSel.length) return { category: 'selection_mismatch' };
  const tLine = target.line == null ? null : Number(target.line);
  const sameLine = sameSel.filter(c => {
    const cLine = c.model_runs?.line == null ? null : Number(c.model_runs.line);
    if (tLine === null && cLine === null) return true;
    if (tLine === null || cLine === null) return false;
    return Math.abs(tLine - cLine) <= 0.01;
  });
  if (!sameLine.length) return { category: 'line_mismatch' };
  const targetBookie = String(bet.tip || '').toLowerCase().trim();
  const sameBookie = sameLine.filter(c => String(c.bookmaker || '').toLowerCase().trim() === targetBookie);
  if (!sameBookie.length) return { category: 'bookmaker_mismatch' };
  return { category: 'matched' };
}

module.exports = { findMatchingPickCandidate, outcomeBinaryFromBet, buildBrierRecords, diagnoseJoinFailure };
