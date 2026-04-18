'use strict';

const { getEarlyPayoutRule } = require('./early-payout-rules');

/**
 * Evalueer early-payout coverage op basis van alleen final-score.
 *
 * BELANGRIJK — conservatieve ondergrens:
 * Dit gebruikt alleen final-score differential, niet de tijdlijn van events.
 * Een match die 2-0 stond in minute 70 maar eindigde 2-2 geeft hier
 * `wouldHavePaidByFinalDiff=false`, terwijl bet365 WEL had uitbetaald. Die
 * comeback-loss gevallen zijn juist de grootste EP-lift. Echte activation-rate
 * is dus ≥ de schatting hier. Shadow-v2 zal fixture `/events` endpoint gebruiken
 * voor peak-lead-during-match — scope voor volgend iteratie.
 *
 * @param {object} args
 *   - bookie: string (bv. 'Bet365')
 *   - sport: 'football' | 'baseball' | 'basketball' | 'hockey' | 'american-football'
 *   - marketType: 'moneyline' | 'dnb' | etc.
 *   - selection: 'home' | 'away'
 *   - finalScoreHome, finalScoreAway: numbers
 * @returns {{ruleApplies: boolean, wouldHavePaidByFinalDiff: boolean|null, rule: object|null}}
 */
function evaluateEarlyPayoutFromFinal(args = {}) {
  const { bookie, sport, marketType, selection, finalScoreHome, finalScoreAway } = args;
  const rule = getEarlyPayoutRule(bookie, sport, marketType);
  if (!rule) return { ruleApplies: false, wouldHavePaidByFinalDiff: null, rule: null };

  const selLower = String(selection || '').toLowerCase();
  if (!rule.appliesToSelections.includes(selLower)) {
    return { ruleApplies: false, wouldHavePaidByFinalDiff: null, rule };
  }

  const h = Number(finalScoreHome);
  const a = Number(finalScoreAway);
  if (!Number.isFinite(h) || !Number.isFinite(a)) {
    return { ruleApplies: true, wouldHavePaidByFinalDiff: null, rule };
  }

  const diff = selLower === 'home' ? (h - a) : (a - h);
  return {
    ruleApplies: true,
    wouldHavePaidByFinalDiff: diff >= rule.leadThreshold,
    rule,
  };
}

/**
 * Schrijf shadow-log row naar early_payout_log tabel.
 *
 * Shadow-mode: geen impact op pick-scoring of regime-engine. Alleen observability
 * tot ≥50 samples per (bookie, sport, market) combinatie + bewezen lift.
 *
 * Rij wordt alleen geschreven als `ruleApplies=true` — anders is er niks te meten
 * voor deze specifieke bookie/market. Fail-silent bij database-fouten (logging is
 * niet-kritiek voor main settle-flow).
 *
 * @param {object} supabase
 * @param {object} args — zie evaluateEarlyPayoutFromFinal + {betId, actualOutcome, oddsUsed, oddsBestMarket}
 * @returns {Promise<{logged: boolean, evaluation: object}>}
 */
async function logEarlyPayoutShadow(supabase, args = {}) {
  if (!supabase || typeof supabase.from !== 'function') {
    return { logged: false, evaluation: null };
  }
  const evaluation = evaluateEarlyPayoutFromFinal(args);
  if (!evaluation.ruleApplies) {
    return { logged: false, evaluation };
  }

  const wouldHavePaid = evaluation.wouldHavePaidByFinalDiff === true;
  const actualL = args.actualOutcome === 'L';
  const potentialLift = wouldHavePaid && actualL;

  try {
    const row = {
      bet_id: args.betId ?? null,
      bookie_used: args.bookie ?? null,
      sport: args.sport ?? null,
      market_type: args.marketType ?? null,
      selection_key: args.selection ?? null,
      actual_outcome: args.actualOutcome ?? null,
      ep_rule_applied: true,
      ep_activation_estimate: 'final_diff_floor',
      ep_would_have_paid: wouldHavePaid,
      potential_lift: potentialLift,
      final_score_home: Number.isFinite(+args.finalScoreHome) ? +args.finalScoreHome : null,
      final_score_away: Number.isFinite(+args.finalScoreAway) ? +args.finalScoreAway : null,
      odds_used: Number.isFinite(+args.oddsUsed) ? +args.oddsUsed : null,
      odds_best_market: Number.isFinite(+args.oddsBestMarket) ? +args.oddsBestMarket : null,
    };
    const result = await supabase.from('early_payout_log').insert(row);
    if (result && result.error) {
      console.warn('[early-payout] log insert error:', result.error.message || result.error);
      return { logged: false, evaluation };
    }
    return { logged: true, evaluation };
  } catch (e) {
    console.warn('[early-payout] log failed:', e?.message || e);
    return { logged: false, evaluation };
  }
}

/**
 * Pure aggregator voor analytics-queries. Input: rows uit early_payout_log.
 * Output: per (bookie, sport, market) combinatie de kerncijfers.
 *
 * @param {array} rows
 * @returns {object} {[key: 'bookie/sport/market']: {samples, activationRate, conversionRate, netLiftEstimate}}
 */
function aggregateEarlyPayoutStats(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return {};
  const byKey = new Map();
  for (const r of rows) {
    if (!r || !r.ep_rule_applied) continue;
    const key = `${r.bookie_used || '?'}/${r.sport || '?'}/${r.market_type || '?'}`;
    if (!byKey.has(key)) {
      byKey.set(key, { samples: 0, paid: 0, lifts: 0, losses: 0, bookie: r.bookie_used, sport: r.sport, market: r.market_type });
    }
    const agg = byKey.get(key);
    agg.samples++;
    if (r.ep_would_have_paid === true) agg.paid++;
    if (r.potential_lift === true) agg.lifts++;
    if (r.actual_outcome === 'L') agg.losses++;
  }
  const out = {};
  for (const [key, agg] of byKey.entries()) {
    const activationRate = agg.samples > 0 ? +(agg.paid / agg.samples).toFixed(4) : 0;
    const conversionRate = agg.losses > 0 ? +(agg.lifts / agg.losses).toFixed(4) : 0;
    out[key] = {
      bookie: agg.bookie,
      sport: agg.sport,
      market: agg.market,
      samples: agg.samples,
      activationRate,
      conversionRate,
      losses: agg.losses,
      potentialLifts: agg.lifts,
    };
  }
  return out;
}

module.exports = {
  evaluateEarlyPayoutFromFinal,
  logEarlyPayoutShadow,
  aggregateEarlyPayoutStats,
};
