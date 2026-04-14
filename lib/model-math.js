'use strict';

/**
 * EdgePickr Model Math — pure helpers voor probability calculations,
 * market-derivation, team-matching en sport-normalisatie.
 *
 * Alles in dit bestand moet pure functions zijn (geen side effects, geen state
 * behalve constants). Zo kunnen unit tests deze module direct importeren en
 * testen we de ECHTE productie-code, niet mirrored copies.
 *
 * Gebruikt door: server.js (via require) en test.js (via require).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// TUNABLE CONSTANTS (startwaarden, documenteer calibratie-pad)
// ═══════════════════════════════════════════════════════════════════════════════

// NHL OT home win rate: historische data 2010-2024 geeft ~52% home voordeel in OT.
// TODO: auto-calibreren uit settled hockey bets (P(home wint | status=AOT)).
const NHL_OT_HOME_SHARE = 0.52;

// Threshold voor model-vs-market divergentie bij sanity check. Conservatieve
// start 4%. TODO: autoTune-per-sport zodra ≥50 settled bets per markt beschikbaar.
const MODEL_MARKET_DIVERGENCE_THRESHOLD = 0.04;

// ═══════════════════════════════════════════════════════════════════════════════
// POISSON FAMILY
// ═══════════════════════════════════════════════════════════════════════════════

// Poisson PMF: P(X = k) voor X ~ Poisson(lambda).
function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let result = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) result *= lambda / i;
  return result;
}

// P(X > line) waar X ~ Poisson(lambda). Voor lines zoals 1.5, 2.5.
// threshold = floor(line); 1.5 → 1; P(X > 1) = P(X >= 2).
function poissonOver(lambda, line) {
  if (typeof lambda !== 'number' || !isFinite(lambda) || lambda < 0) return 0;
  if (typeof line !== 'number' || !isFinite(line)) return 0;
  const threshold = Math.floor(line);
  let cumulative = 0;
  for (let k = 0; k <= threshold; k++) cumulative += poisson(k, lambda);
  return Math.max(0, Math.min(1, 1 - cumulative));
}

// Bivariate Poisson (assumptie: onafhankelijk): P(home>away), P(tie), P(away>home)
// na regulation. Gebruikt voor 3-weg ML Poisson-model (hockey + handbal).
function poisson3Way(expHome, expAway, maxGoals = 12) {
  let pHome = 0, pTie = 0, pAway = 0;
  for (let h = 0; h <= maxGoals; h++) {
    const ph = poisson(h, expHome);
    for (let a = 0; a <= maxGoals; a++) {
      const pa = poisson(a, expAway);
      const joint = ph * pa;
      if (h > a) pHome += joint;
      else if (h === a) pTie += joint;
      else pAway += joint;
    }
  }
  const total = pHome + pTie + pAway;
  return { pHome: pHome / total, pDraw: pTie / total, pAway: pAway / total };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET-DERIVED PROBABILITY TOOLKIT
// ═══════════════════════════════════════════════════════════════════════════════

// Proportional devig: gegeven odds voor mutually-exclusive outcomes → fair probs.
// Simpelste methode, accuraat genoeg voor markten met vig < ~10%.
function devigProportional(oddsArray) {
  if (!Array.isArray(oddsArray) || !oddsArray.length) return null;
  const impliedProbs = [];
  for (const o of oddsArray) {
    const price = parseFloat(o);
    if (!price || price <= 1.0 || !isFinite(price)) return null;
    impliedProbs.push(1 / price);
  }
  const sum = impliedProbs.reduce((a, b) => a + b, 0);
  if (!sum || !isFinite(sum) || sum <= 0) return null;
  return {
    probs: impliedProbs.map(p => p / sum),
    vig: +(sum - 1).toFixed(4),
  };
}

// Consensus-probability uit 3-way markt over meerdere bookies.
// Devig per bookie, dan gemiddelde → stabieler dan eerst averagen dan devigen.
function consensus3Way(threeWayOdds) {
  if (!Array.isArray(threeWayOdds) || !threeWayOdds.length) return null;
  const byBookie = {};
  for (const o of threeWayOdds) {
    const bk = o.bookie || 'unknown';
    if (!byBookie[bk]) byBookie[bk] = {};
    byBookie[bk][o.side] = parseFloat(o.price);
  }
  const devigged = [];
  for (const bk of Object.keys(byBookie)) {
    const b = byBookie[bk];
    if (!b.home || !b.draw || !b.away) continue;
    const d = devigProportional([b.home, b.draw, b.away]);
    if (d) devigged.push(d.probs);
  }
  if (!devigged.length) return null;
  const avgHome = devigged.reduce((s, p) => s + p[0], 0) / devigged.length;
  const avgDraw = devigged.reduce((s, p) => s + p[1], 0) / devigged.length;
  const avgAway = devigged.reduce((s, p) => s + p[2], 0) / devigged.length;
  const total = avgHome + avgDraw + avgAway;
  return {
    home: avgHome / total,
    draw: avgDraw / total,
    away: avgAway / total,
    bookieCount: devigged.length,
  };
}

// Converteer 60-min 3-way fair probs naar inc-OT 2-way fair probs.
function deriveIncOTProbFrom3Way(pReg, otHomeShare = NHL_OT_HOME_SHARE) {
  if (!pReg || typeof pReg.home !== 'number' || typeof pReg.draw !== 'number' || typeof pReg.away !== 'number') return null;
  const share = Math.max(0, Math.min(1, otHomeShare));
  return {
    home: pReg.home + pReg.draw * share,
    away: pReg.away + pReg.draw * (1 - share),
  };
}

// Sanity check: stem model-prob overeen met market consensus?
function modelMarketSanityCheck(modelProb, marketProb, threshold = MODEL_MARKET_DIVERGENCE_THRESHOLD) {
  if (typeof modelProb !== 'number' || typeof marketProb !== 'number' || isNaN(modelProb) || isNaN(marketProb)) {
    return { agree: false, divergence: null, marketProb, modelProb, threshold, reason: 'invalid_input' };
  }
  const divergence = +Math.abs(modelProb - marketProb).toFixed(4);
  return {
    agree: divergence <= threshold,
    divergence,
    marketProb: +marketProb.toFixed(4),
    modelProb: +modelProb.toFixed(4),
    threshold,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEAM & SPORT NORMALISATION
// ═══════════════════════════════════════════════════════════════════════════════

// Normaliseer teamnaam voor fuzzy matching. Strip accenten, lowercase,
// veelvoorkomende prefixes/suffixes.
function normalizeTeamName(s) {
  return (s || '').toString().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bfc\b|\bcf\b|\bac\b|\bsc\b|\bbk\b/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Fuzzy team match: probeer exact, bevat, dan woord-overlap. Return score 0-100.
function teamMatchScore(apiName, queryName) {
  const a = normalizeTeamName(apiName);
  const q = normalizeTeamName(queryName);
  if (!a || !q) return 0;
  if (a === q) return 100;
  if (a.includes(q) || q.includes(a)) return 80;
  const aw = new Set(a.split(' ').filter(w => w.length >= 3));
  const qw = new Set(q.split(' ').filter(w => w.length >= 3));
  if (!aw.size || !qw.size) return 0;
  let overlap = 0;
  for (const w of qw) if (aw.has(w)) overlap++;
  const ratio = overlap / Math.max(aw.size, qw.size);
  return Math.round(ratio * 70);
}

// Normaliseer sport-string (Dutch UI labels of varianten) naar canonical English slug.
function normalizeSport(s) {
  const k = (s || '').toString().trim().toLowerCase();
  const map = {
    voetbal: 'football', football: 'football', soccer: 'football',
    basketball: 'basketball', basketbal: 'basketball', nba: 'basketball',
    ijshockey: 'hockey', hockey: 'hockey', nhl: 'hockey', 'ice hockey': 'hockey',
    honkbal: 'baseball', baseball: 'baseball', mlb: 'baseball',
    'american football': 'american-football', 'american-football': 'american-football', nfl: 'american-football',
    handbal: 'handball', handball: 'handball',
  };
  return map[k] || 'football';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET TYPE DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

// Classificeer een markt-label naar een bucket-key voor calibratie.
// 60-min markten krijgen aparte buckets (home60/draw60/away60) zodat ze niet
// met inc-OT markten mengen in markt-multipliers.
function detectMarket(markt = '') {
  const m = markt.toLowerCase();
  const is60min = m.includes('60-min') || m.includes('60 min') || m.includes('🕐');
  if (m.includes('gelijkspel') || m.includes('draw') || m.includes('x2') || m.includes('1x')) {
    return is60min ? 'draw60' : 'draw';
  }
  if (m.includes('wint') || m.includes('winner') || m.includes('home') || m.includes('thuis')) {
    if (m.includes('✈️') || m.includes('away') || m.includes('uit') || m.match(/→.*away/)) return is60min ? 'away60' : 'away';
    return is60min ? 'home60' : 'home';
  }
  if (m.includes('over') || m.includes('>')) return 'over';
  if (m.includes('under') || m.includes('<')) return 'under';
  return 'other';
}

// ═══════════════════════════════════════════════════════════════════════════════
// BETTING MATHEMATICS
// ═══════════════════════════════════════════════════════════════════════════════

const KELLY_FRACTION = 0.50;

// Half-Kelly bet sizing: k = (ep*(odd-1) - (1-ep)) / (odd-1), * KELLY_FRACTION
function calcKelly(ep, odd) {
  const k = ((ep * (odd - 1)) - (1 - ep)) / (odd - 1);
  return k * KELLY_FRACTION;
}

// Map half-Kelly naar unit label voor pick display.
function kellyToUnits(hk) {
  return hk > 0.09 ? '1.0U' : hk > 0.04 ? '0.5U' : '0.3U';
}

// EP (expected probability) bucket key voor calibratie van epW gewichten.
function epBucketKey(ep) {
  if (ep >= 0.55) return '0.55';
  if (ep >= 0.45) return '0.45';
  if (ep >= 0.38) return '0.38';
  if (ep >= 0.30) return '0.30';
  return '0.28';
}

// ═══════════════════════════════════════════════════════════════════════════════
// MLB PITCHER SIGNAL
// ═══════════════════════════════════════════════════════════════════════════════

// ERA-differential signal. Lagere ERA thuis = home team scoort minder tegen.
// Vereist ≥10 IP per pitcher voor betrouwbaar signal.
function pitcherAdjustment(homePitcher, awayPitcher) {
  if (!homePitcher?.era || !awayPitcher?.era) return { adj: 0, note: null, valid: false };
  if ((homePitcher.ip || 0) < 10 || (awayPitcher.ip || 0) < 10) return { adj: 0, note: null, valid: false };
  const eraDiff = awayPitcher.era - homePitcher.era;
  const raw = eraDiff * 0.017;
  const clamped = Math.max(-0.06, Math.min(0.06, raw));
  const note = `Pitchers: ${homePitcher.name?.split(' ').pop() || 'H'} ${homePitcher.era.toFixed(2)} vs ${awayPitcher.name?.split(' ').pop() || 'A'} ${awayPitcher.era.toFixed(2)} (Δ${eraDiff > 0 ? '+' : ''}${eraDiff.toFixed(2)})`;
  return { adj: clamped, note, valid: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// WL RECOMPUTATION (voor PUT /api/bets/:id edit-paths)
// ═══════════════════════════════════════════════════════════════════════════════

// Herbereken wl (win/loss €) voor een settled bet na odds/units edit.
// Returns null voor Open bets; positive voor W, negative voor L.
function recomputeWl(row, unitEur = 25) {
  if (!row || (row.uitkomst !== 'W' && row.uitkomst !== 'L')) return null;
  const inzet = row.inzet != null ? row.inzet : +((row.units || 0) * unitEur).toFixed(2);
  return row.uitkomst === 'W'
    ? +((row.odds - 1) * inzet).toFixed(2)
    : +(-inzet).toFixed(2);
}

module.exports = {
  // Constants
  NHL_OT_HOME_SHARE,
  MODEL_MARKET_DIVERGENCE_THRESHOLD,
  KELLY_FRACTION,

  // Poisson
  poisson,
  poissonOver,
  poisson3Way,

  // Market-derivation
  devigProportional,
  consensus3Way,
  deriveIncOTProbFrom3Way,
  modelMarketSanityCheck,

  // Team/sport normalisation
  normalizeTeamName,
  teamMatchScore,
  normalizeSport,

  // Market detection
  detectMarket,

  // Betting math
  calcKelly,
  kellyToUnits,
  epBucketKey,

  // Domain-specific
  pitcherAdjustment,
  recomputeWl,
};
