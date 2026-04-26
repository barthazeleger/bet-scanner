'use strict';

/**
 * EdgePickr v12.4.0 — Paper-trading shadow-flow.
 *
 * Doel: kandidaten die door alle model+sanity-gates komen maar niet in de
 * top-5 finalPicks belanden, plus markten die nu structureel onderbedeeld
 * zijn, worden geschreven als shadow-rows naar pick_candidates met volle
 * audit-trail. Settlement-sweep rekent ze af tegen api-sports event-data
 * en logt closing-price/CLV via odds_snapshots.
 *
 * Geen unit-allocatie, geen UI-prominentie — puur data zodat een latere
 * auto-promote-harness per markt × sport kan beslissen op basis van CLV +
 * Brier ≤ baseline (signal-promotion-doctrine extended naar markt-types).
 *
 * Hergebruikt:
 *   - snap.writePickCandidate (uitgebreid met shadow/markt_label/etc velden)
 *   - resolveBetOutcome (lib/runtime/results-checker.js) — markt-aware W/L/null
 *   - fetchSnapshotClosing (lib/clv-backfill.js) — closing-price uit odds_snapshots
 *
 * `buildMarktLabel` reconstrueert een resolveBetOutcome-compatible label uit
 * (marketType, selectionKey, line, sport, teams). Dit vermijdt 12 evaluation-
 * call-sites te moeten uitbreiden met markt_label-arg — pure functie blijft
 * testbaar en raakt server.js niet.
 */

const snap = require('./snapshots');
const { resolveBetOutcome } = require('./runtime/results-checker');
const { fetchSnapshotClosing } = require('./clv-backfill');

/**
 * Reconstrueer een markt-label string die resolveBetOutcome herkent.
 * Niet bedoeld om visueel identiek te zijn aan de mkP-output — alleen om
 * de juiste matchers in resolveBetOutcome te triggeren.
 *
 * @param {object} args { marketType, selectionKey, line, home, away }
 * @returns {string|null} label of null als markt niet ondersteund wordt
 */
function buildMarktLabel(args = {}) {
  const { marketType, selectionKey, line, home = '', away = '' } = args;
  if (!marketType || !selectionKey) return null;
  const mt = String(marketType).toLowerCase();
  const sk = String(selectionKey).toLowerCase();
  const lineStr = (line != null && Number.isFinite(parseFloat(line))) ? parseFloat(line) : null;

  // 1X2 / moneyline (3-way of 2-way)
  if (mt === '1x2' || mt === 'moneyline' || mt === 'moneyline_incl_ot') {
    if (sk === 'home') return `🏠 ${home} wint`;
    if (sk === 'away') return `✈️ ${away} wint`;
    if (sk === 'draw') return `🤝 Gelijkspel`;
  }

  // 60-min threeway (hockey/handball regulation)
  if (mt === 'threeway') {
    if (sk === 'home') return `🕐 ${home} wint (60-min)`;
    if (sk === 'away') return `🕐 ${away} wint (60-min)`;
    if (sk === 'draw') return `🕐 Gelijkspel (60-min)`;
  }

  // Totals (full game)
  if (mt === 'total') {
    if (sk === 'over' && lineStr != null)  return `⚽ Over ${lineStr} goals`;
    if (sk === 'under' && lineStr != null) return `🔒 Under ${lineStr} goals`;
  }

  // BTTS
  if (mt === 'btts') {
    if (sk === 'yes') return `🔥 BTTS Ja`;
    if (sk === 'no')  return `🛡️ BTTS Nee`;
  }

  // DNB (resolver matcht op "DNB {team}" of "Draw No Bet {team}")
  if (mt === 'dnb') {
    if (sk === 'home') return `DNB ${home}`;
    if (sk === 'away') return `DNB ${away}`;
  }

  // Double Chance — niet door resolveBetOutcome ondersteund. Label produceren
  // voor latere uitbreiding; settle returnt null tot resolver DC kent.
  if (mt === 'double_chance') {
    if (sk === '1x') return `Double Chance 1X (${home} of gelijk)`;
    if (sk === '12') return `Double Chance 12 (${home} of ${away})`;
    if (sk === 'x2') return `Double Chance X2 (gelijk of ${away})`;
  }

  // Handicap / spread / puck line / run line. selection_key formaat: "home_-1.5"
  // of "away_+0.5". Resolver matcht op "spread|handicap|line ... [team] [±line]".
  if (mt === 'handicap' || mt === 'spread' || mt === 'puck_line' || mt === 'run_line') {
    const m = sk.match(/^(home|away)[_\s]?([+-]?\d+\.?\d*)?$/);
    const side = m?.[1];
    const lineFromKey = m?.[2] != null ? parseFloat(m[2]) : null;
    const usedLine = lineStr != null ? lineStr : lineFromKey;
    if (side && Number.isFinite(usedLine)) {
      const team = side === 'home' ? home : away;
      const sign = usedLine >= 0 ? `+${usedLine}` : `${usedLine}`;
      const prefix = mt === 'puck_line' ? 'Puck Line' : mt === 'run_line' ? 'Run Line' : 'Handicap';
      return `${prefix} ${team} ${sign}`;
    }
  }

  // 1H spread (basketball/NFL)
  if (mt === 'half_spread') {
    const m = sk.match(/^(home|away)[_\s]?([+-]?\d+\.?\d*)?$/);
    const side = m?.[1];
    const lineFromKey = m?.[2] != null ? parseFloat(m[2]) : null;
    const usedLine = lineStr != null ? lineStr : lineFromKey;
    if (side && Number.isFinite(usedLine)) {
      const team = side === 'home' ? home : away;
      const sign = usedLine >= 0 ? `+${usedLine}` : `${usedLine}`;
      return `1H Spread ${team} ${sign}`;
    }
  }

  // 1H total (basketball/NFL)
  if (mt === 'half_total') {
    if (sk === 'over' && lineStr != null)  return `1H Over ${lineStr}`;
    if (sk === 'under' && lineStr != null) return `1H Under ${lineStr}`;
  }

  // P1 total (hockey)
  if (mt === 'period_total') {
    if (sk === 'over' && lineStr != null)  return `P1 Over ${lineStr}`;
    if (sk === 'under' && lineStr != null) return `P1 Under ${lineStr}`;
  }

  // Team Total (hockey/baseball/etc). selectionKey formats:
  // "home_over_2.5" / "away_under_3.0"
  if (mt === 'team_total' || mt === 'team_total_home' || mt === 'team_total_away') {
    const m = sk.match(/^(home|away)[_\s](over|under)[_\s]?(\d+\.?\d*)?$/);
    const side = m?.[1];
    const dir = m?.[2];
    const lineFromKey = m?.[3] != null ? parseFloat(m[3]) : null;
    const usedLine = lineStr != null ? lineStr : lineFromKey;
    if (side && dir && Number.isFinite(usedLine)) {
      const team = side === 'home' ? home : away;
      const arrow = dir === 'over' ? '📈' : '📉';
      return `${arrow} ${team} TT ${dir === 'over' ? 'Over' : 'Under'} ${usedLine}`;
    }
  }

  // NRFI / YRFI (baseball)
  if (mt === 'nrfi') {
    if (sk === 'nrfi') return 'NRFI';
    if (sk === 'yrfi') return 'YRFI';
  }

  // Odd/Even (hockey)
  if (mt === 'odd_even') {
    if (sk === 'odd')  return `🎲 Odd Total`;
    if (sk === 'even') return `🎲 Even Total`;
  }

  // F5 markets — resolver kent ze niet, label voor toekomstige uitbreiding.
  if (mt === 'f5_ml') {
    if (sk === 'home') return `F5 ML ${home}`;
    if (sk === 'away') return `F5 ML ${away}`;
  }
  if (mt === 'f5_total') {
    if (sk === 'over' && lineStr != null)  return `F5 Over ${lineStr}`;
    if (sk === 'under' && lineStr != null) return `F5 Under ${lineStr}`;
  }

  return null;
}

/**
 * Schrijf een paper-trading shadow-row naar pick_candidates.
 * Vereist: pick met _fixtureMeta + bestaande modelRunId (van recordXxxEvaluation
 * helpers). Caller kan model_run_id leveren of null geven (dan wordt rij niet
 * geschreven omdat schema NOT NULL FK afdwingt).
 *
 * Dit is een dunne wrapper. Het zware werk (kelly/edge/probabilities) is al
 * door mkP gedaan; we hergebruiken de resulterende pick.
 *
 * @param {object} supabase
 * @param {object} args {
 *   pick,            // de mkP-output pick { match, label, odd, kelly, units, edge, ... }
 *   modelRunId,      // FK uit eerder writeModelRun (kan null zijn → skip)
 *   fixtureMeta,     // pick._fixtureMeta { fixtureId, marketType, selectionKey, line }
 *   home, away,      // teams (voor markt_label-reconstructie)
 *   sport,           // 'football'/'hockey'/'baseball'/etc.
 *   shadow,          // boolean
 *   finalTop5,       // boolean
 *   kickoffMs,       // ms-epoch van kickoff
 * }
 */
async function writePaperTradingCandidate(supabase, args = {}) {
  if (!supabase || typeof supabase.from !== 'function') return;
  const { pick, modelRunId, fixtureMeta, home, away, sport, shadow = true, finalTop5 = false, kickoffMs } = args;
  if (!modelRunId || !pick || !fixtureMeta) return;
  const fairProb = (pick.prob != null ? Number(pick.prob) : 0) / 100;
  const edgePct = pick.edge != null ? Number(pick.edge) : 0;
  const stakeUnits = pick.units != null ? parseFloat(pick.units) : null;
  const expectedValueEur = pick.expectedEur != null ? Number(pick.expectedEur) : null;
  const marktLabel = pick.label || buildMarktLabel({
    marketType: fixtureMeta.marketType, selectionKey: fixtureMeta.selectionKey,
    line: fixtureMeta.line, home, away,
  });
  await snap.writePickCandidate(supabase, {
    modelRunId,
    fixtureId: fixtureMeta.fixtureId,
    selectionKey: fixtureMeta.selectionKey,
    bookmaker: pick.bookie || 'none',
    bookmakerOdds: pick.odd,
    fairProb,
    edgePct,
    kellyFraction: pick.kelly,
    stakeUnits,
    expectedValueEur,
    passedFilters: !!finalTop5,
    rejectedReason: !finalTop5 ? 'shadow_outside_top5' : null,
    signals: pick.signals || [],
    shadow,
    finalTop5,
    marketType: fixtureMeta.marketType,
    line: fixtureMeta.line,
    marktLabel,
    kickoffMs,
    sport,
  });
}

/**
 * Settle één pick_candidate row tegen een fixture-event. Updates result,
 * settled_at, closing_odds, closing_bookie, closing_source, clv_pct.
 *
 * @param {object} supabase
 * @param {object} candidate row uit pick_candidates (met markt_label/bookmaker_odds/sport/fixture_id)
 * @param {object} ev fixture-event { home, away, scoreH, scoreA, regScoreH?, regScoreA?, ... }
 * @returns {Promise<{result: 'W'|'L'|'P'|null, clvPct: number|null}|null>}
 */
async function settlePaperTradingCandidate(supabase, candidate, ev) {
  if (!supabase || !candidate || !ev) return null;
  if (!candidate.markt_label) return null;
  const { uitkomst, note } = resolveBetOutcome(candidate.markt_label, ev, { isLive: false });
  // null + 'Exact push' → mark as P (push); other null → unresolvable, skip update
  let result = null;
  if (uitkomst === 'W' || uitkomst === 'L') result = uitkomst;
  else if (uitkomst === null && /push/i.test(String(note || ''))) result = 'P';
  if (!result) return null;

  // Closing-price via odds_snapshots
  const closing = await fetchSnapshotClosing(supabase, {
    fixtureId: candidate.fixture_id,
    markt: candidate.markt_label,
    preferredBookie: candidate.bookmaker,
    matchName: `${ev.home || ''} vs ${ev.away || ''}`,
  }).catch(() => null);

  let clvPct = null;
  if (closing && closing.closingOdds && candidate.bookmaker_odds) {
    const taken = parseFloat(candidate.bookmaker_odds);
    const closed = parseFloat(closing.closingOdds);
    // Standard CLV: (taken_decimal - 1) / (closed_decimal - 1) - 1.
    // Positive = beat the close; negative = market moved against you.
    if (taken > 1 && closed > 1) {
      clvPct = +(((taken - 1) / (closed - 1) - 1) * 100).toFixed(2);
    }
  }

  try {
    await supabase.from('pick_candidates')
      .update({
        result,
        settled_at: new Date().toISOString(),
        closing_odds: closing?.closingOdds || null,
        closing_bookie: closing?.bookieUsed || null,
        closing_source: closing?.sourceType || null,
        clv_pct: clvPct,
      })
      .eq('id', candidate.id);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[paper-trading] settle update failed:', e?.message || e);
    return null;
  }
  return { result, clvPct };
}

/**
 * Batch-sweep: query alle unsettled pick_candidates met kickoff_ms < cutoff,
 * fetch fixture-events per sport, settle row-by-row.
 *
 * Argument `fetchEventByFixture` is een caller-provided async functie:
 *   (sport, fixtureId) → ev | null
 * (zodat sweep zelf geen api-football direct binnenroept; kan hergebruik uit
 * check-open-bets cron).
 *
 * @returns {Promise<{checked: number, settled: number, skipped: number}>}
 */
async function runPaperTradingSweep({ supabase, fetchEventByFixture, cutoffMs, batchSize = 200 } = {}) {
  const stats = { checked: 0, settled: 0, skipped: 0 };
  if (!supabase || typeof supabase.from !== 'function' || typeof fetchEventByFixture !== 'function') {
    return stats;
  }
  const cutoff = Number.isFinite(cutoffMs) ? cutoffMs : Date.now();
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from('pick_candidates')
      .select('id, fixture_id, sport, markt_label, bookmaker, bookmaker_odds, kickoff_ms, market_type')
      .is('result', null)
      .not('markt_label', 'is', null)
      .lt('kickoff_ms', cutoff)
      .order('kickoff_ms', { ascending: true })
      .range(from, from + batchSize - 1);
    if (error || !Array.isArray(data) || data.length === 0) break;
    for (const row of data) {
      stats.checked++;
      try {
        const ev = await fetchEventByFixture(row.sport, row.fixture_id);
        if (!ev) { stats.skipped++; continue; }
        const res = await settlePaperTradingCandidate(supabase, row, ev);
        if (res && res.result) stats.settled++;
        else stats.skipped++;
      } catch (e) {
        stats.skipped++;
      }
    }
    if (data.length < batchSize) break;
    from += batchSize;
  }
  return stats;
}

module.exports = {
  buildMarktLabel,
  writePaperTradingCandidate,
  settlePaperTradingCandidate,
  runPaperTradingSweep,
};
