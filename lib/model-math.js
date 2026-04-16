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

// Classificeer een markt-label naar een bucket-key voor calibratie + kill-switch.
// 60-min markten krijgen aparte buckets (home60/draw60/away60) zodat ze niet
// met inc-OT markten mengen in markt-multipliers.
//
// v10.7.20: `other` werd de vangbak voor BTTS, DNB, DC, Spread, NRFI, YRFI,
// team totals etc. — waardoor kill-switch en markt-multipliers deze niet apart
// konden beoordelen. Nu eigen bucket per markt-type.
//
// Volgorde is belangrijk:
// - BTTS/DNB/DC checks vóór draw/ML (want DNB bevat vaak 🏠/✈️, DC bevat X2/1X).
// - Spread/RunLine/PuckLine vóór generic over/under (spread bevat ±getal niet O/U).
// - NRFI/YRFI vóór over/under (baseball 1st inning markt).
// - Team totals vóór generic O/U (team over/under is eigen markt).
function detectMarket(markt = '') {
  const m = markt.toLowerCase();
  const is60min = m.includes('60-min') || m.includes('60 min') || m.includes('🕐');

  // BTTS (Both Teams To Score)
  if (m.includes('btts') || m.includes('beide teams') || (m.includes(' both ') && m.includes('score'))) {
    if (m.includes('nee') || /\bno\b/.test(m) || m.includes('🛡️')) return 'btts_no';
    return 'btts_yes';
  }

  // DNB (Draw No Bet) — voor ML want emoji 🏠/✈️ vangt anders
  if (m.includes('dnb') || m.includes('draw no bet')) {
    if (m.includes('✈️') || m.includes('away') || m.includes('uit')) return 'dnb_away';
    return 'dnb_home';
  }

  // Double Chance — "1X", "X2", "12" (niet "1X2" dat is 3-way ML)
  // Match woord-grenzen zodat "x2" niet in "0x2.5" matcht
  if (/\b1x\b/.test(m) && !/\b1x2\b/.test(m)) return 'dc_1x';
  if (/\bx2\b/.test(m)) return 'dc_x2';
  if ((m.includes('dubbele kans') || m.includes('double chance')) && /\b12\b/.test(m)) return 'dc_12';

  // NRFI / YRFI (baseball 1st inning)
  if (m.includes('nrfi') || m.includes('no run first') || m.includes('no run 1st')) return 'nrfi';
  if (m.includes('yrfi') || m.includes('yes run first') || m.includes('yes run 1st')) return 'yrfi';

  // Team totals (voor generic over/under)
  if (m.includes('team total') || m.includes('team over') || m.includes('team under')) {
    if (m.includes('over')) return 'team_total_over';
    if (m.includes('under')) return 'team_total_under';
    return 'team_total';
  }

  // Odd/Even total
  if (m.includes('odd total') || m.includes('even total') || m.includes('odd/even')) {
    return m.includes('odd') ? 'odd' : 'even';
  }

  // Spread / Handicap / Run Line / Puck Line — main-market side-line bets
  if (m.includes('spread') || m.includes('handicap') || m.includes('run line') || m.includes('puck line')) {
    if (m.includes('✈️') || m.includes('away') || m.includes('uit')) return 'spread_away';
    return 'spread_home';
  }

  // Gelijkspel (draw specifiek, geen DC)
  if (m.includes('gelijkspel') || (m.includes('draw') && !m.includes('no bet'))) {
    return is60min ? 'draw60' : 'draw';
  }

  // Moneyline / Match Winner
  if (m.includes('wint') || m.includes('winner') || m.includes('home') || m.includes('thuis') || m.includes('moneyline')) {
    if (m.includes('✈️') || m.includes('away') || m.includes('uit') || m.match(/→.*away/)) return is60min ? 'away60' : 'away';
    return is60min ? 'home60' : 'home';
  }

  // Over/Under (main)
  if (m.includes('over') || m.includes('>')) return 'over';
  if (m.includes('under') || m.includes('<')) return 'under';

  return 'other';
}

// ═══════════════════════════════════════════════════════════════════════════════
// BETTING MATHEMATICS
// ═══════════════════════════════════════════════════════════════════════════════

const KELLY_FRACTION_DEFAULT = 0.50;
const KELLY_FRACTION_MIN     = 0.50;
const KELLY_FRACTION_MAX     = 0.75; // never go full-Kelly automatisch — handmatige override vereist
const KELLY_FRACTION_STEP    = 0.05;

// Runtime-mutable factor (read via getKellyFraction, write via setKellyFraction).
// Persistence: caller verantwoordelijk voor opslag in calibration store.
let _kellyFraction = KELLY_FRACTION_DEFAULT;
function getKellyFraction() { return _kellyFraction; }
function setKellyFraction(v) {
  const num = Number(v);
  if (!isFinite(num)) return _kellyFraction;
  _kellyFraction = Math.max(0.10, Math.min(1.00, num));
  return _kellyFraction;
}
// Backwards-compat alias (zodat oude imports niet breken — nieuwe code gebruikt getKellyFraction()).
const KELLY_FRACTION = KELLY_FRACTION_DEFAULT;

// Half-Kelly bet sizing: k = (ep*(odd-1) - (1-ep)) / (odd-1), * dynamische factor
function calcKelly(ep, odd) {
  const k = ((ep * (odd - 1)) - (1 - ep)) / (odd - 1);
  return k * _kellyFraction;
}

// Map half-Kelly naar unit label voor pick display.
// 6 tiers, fractioneel zodat ze schalen met elke unit-grootte (1U=€25/€30/€50 etc).
// v10.8.20: Kelly-math is primair — stake-tiers volgen half-Kelly thresholds.
// De score-display (kellyScore) volgt de stake-tier, niet andersom. Dat houdt
// de EV-optimale sizing intact en maakt "score 8 + 2U" (v10.8.18) onmogelijk.
// Raw-Kelly% (= 2*hk): 0.3U <3% | 0.5U 3-6% | 0.75U 6-10% | 1.0U 10-14% | 1.5U 14-20% | 2.0U >20%.
function kellyToUnits(hk) {
  if (hk > 0.10)  return '2.0U';
  if (hk > 0.07)  return '1.5U';
  if (hk > 0.05)  return '1.0U';
  if (hk > 0.03)  return '0.75U';
  if (hk > 0.015) return '0.5U';
  return '0.3U';
}

// v10.8.20: score-display op 5-10 schaal, direct 1-1 gekoppeld aan stake-tier.
// 0.3U → 5, 0.5U → 6, 0.75U → 7, 1.0U → 8, 1.5U → 9, 2.0U → 10.
// Voorheen gebruikte UI een lineaire formule (hk-0.015)/0.135*5+5 die niet
// aligned was met kellyToUnits — gaf bv. hk=0.105 → score 8 + 2.0U.
function kellyScore(hk) {
  if (hk > 0.10)  return 10;
  if (hk > 0.07)  return 9;
  if (hk > 0.05)  return 8;
  if (hk > 0.03)  return 7;
  if (hk > 0.015) return 6;
  return 5;
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

// ═══════════════════════════════════════════════════════════════════════════════
// NHL SHOTS DIFFERENTIAL SIGNAL
// ═══════════════════════════════════════════════════════════════════════════════

// Team shots-for/against differential vs opponent → kansaanpassing (±3% max).
// Teams die structureel meer shots nemen dan incasseren winnen vaker in toto
// (bron: Natural Stat Trick, shot metrics voorspellen goals > feitelijke goals).
// Vereist ≥20 games per team voor betrouwbaar signal.
function shotsDifferentialAdjustment(homeStats, awayStats) {
  if (!homeStats || !awayStats) return { adj: 0, note: null, valid: false };
  if ((homeStats.gp || 0) < 20 || (awayStats.gp || 0) < 20) return { adj: 0, note: null, valid: false };
  if (!isFinite(homeStats.shotsFor) || !isFinite(homeStats.shotsAgainst)) return { adj: 0, note: null, valid: false };
  if (!isFinite(awayStats.shotsFor) || !isFinite(awayStats.shotsAgainst)) return { adj: 0, note: null, valid: false };
  // SF% = shots for / (shots for + against); .55+ is elite, .45- is zwak
  const homeSFpct = homeStats.shotsFor / (homeStats.shotsFor + homeStats.shotsAgainst);
  const awaySFpct = awayStats.shotsFor / (awayStats.shotsFor + awayStats.shotsAgainst);
  const diff = homeSFpct - awaySFpct; // +0.05 = home is beduidend beter in shot-control
  const raw = diff * 0.45; // 10% SF%-verschil ≈ 4.5% edge
  const clamped = Math.max(-0.03, Math.min(0.03, raw));
  const note = `SF%: ${(homeSFpct*100).toFixed(1)}% vs ${(awaySFpct*100).toFixed(1)}% (Δ${diff > 0 ? '+' : ''}${(diff*100).toFixed(1)}%)`;
  return { adj: clamped, note, valid: true };
}

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

// ═══════════════════════════════════════════════════════════════════════════════
// HIERARCHICAL CALIBRATION
// Stem probability-multipliers af per (sport, league, market, bookie) bucket
// met Bayesian smoothing naar parent als child sample te klein is.
// Activeert volledig zodra een markt ≥ N bets heeft.
// ═══════════════════════════════════════════════════════════════════════════════

// Default bucket: een markt zonder data heeft prior multiplier 1.0 (neutraal).
const HIER_CALIB_PRIOR = 1.0;
// Min sample voor "vertrouwen" in eigen bucket; eronder bayesian-smoothing naar parent.
const HIER_CALIB_MIN_N = 30;
// Smoothing strength (hoger = trager naar own-bucket).
const HIER_CALIB_K = 50;

// Bayesian smoothing: combineer eigen multiplier met parent op basis van n.
// formule: weight = n / (n + K); result = weight * own + (1 - weight) * parent.
function bayesSmooth(own, n, parent, k = HIER_CALIB_K) {
  if (n <= 0) return parent;
  const w = n / (n + k);
  return w * own + (1 - w) * parent;
}

// Bereken hiërarchische multiplier voor een pick.
// buckets is een object met subset van: { global, sport, sport_league, sport_market, sport_league_market, sport_bookie }
// Elke bucket heeft { multiplier, n }. Returns gecombineerde multiplier.
function hierarchicalMultiplier(buckets) {
  const get = (key) => buckets?.[key] || { multiplier: HIER_CALIB_PRIOR, n: 0 };
  const global  = get('global');
  const sport   = get('sport');
  const market  = get('sport_market');
  const league  = get('sport_league_market');
  // Smooth opbouwend: global → sport → market → league
  const smGlobal = global.multiplier; // root
  const smSport  = bayesSmooth(sport.multiplier, sport.n, smGlobal);
  const smMarket = bayesSmooth(market.multiplier, market.n, smSport);
  const smLeague = bayesSmooth(league.multiplier, league.n, smMarket);
  // Clamp safety: nooit < 0.5 of > 1.5 ongeacht data
  return Math.max(0.5, Math.min(1.5, smLeague));
}

// ═══════════════════════════════════════════════════════════════════════════════
// RESIDUAL MODEL FRAMEWORK (skeleton)
// Wordt actief zodra ≥ MIN_TRAINING_PICKS settled candidates voor (sport, market) bestaan.
// Tot dan: model_delta = 0 (markt = baseline).
// ═══════════════════════════════════════════════════════════════════════════════

const RESIDUAL_MIN_TRAINING_PICKS = 100;

// Eenvoudige logistic-regression coëfficiënten per markt; in productie via Supabase ophalen.
// Returnt model_delta dat opgeteld bij baseline_prob de finale prob geeft.
// Skeleton: returnt 0 totdat coefficients beschikbaar zijn.
function residualModelDelta(featureVector, coefficients) {
  if (!coefficients || !Array.isArray(coefficients.weights) || !coefficients.weights.length) {
    return 0; // No-op skeleton: model nog niet getraind voor deze markt
  }
  if (!featureVector || typeof featureVector !== 'object') return 0;
  // Lineaire combinatie van features × weights + bias
  let z = coefficients.bias || 0;
  for (let i = 0; i < coefficients.weights.length; i++) {
    const f = parseFloat(featureVector[coefficients.featureNames?.[i]]) || 0;
    z += coefficients.weights[i] * f;
  }
  // Sigmoid voor delta naar [-0.15, 0.15]
  const sig = 1 / (1 + Math.exp(-z));
  const delta = (sig - 0.5) * 0.30; // [-0.15, +0.15]
  return Math.max(-0.15, Math.min(0.15, delta));
}

// Sample-size + backtest-gate check voor activatie.
// Binair: bij n >= MIN én walk-forward Brier-improvement (delta < 0) → actief.
// Zonder validation stats: alleen sample-size check (skeleton returnt sowieso 0).
function residualModelActive(sampleSize, validationStats = null) {
  if ((sampleSize | 0) < RESIDUAL_MIN_TRAINING_PICKS) return false;
  if (validationStats && typeof validationStats.brierDelta === 'number') {
    return validationStats.brierDelta < 0;
  }
  return true;
}

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
  KELLY_FRACTION_DEFAULT,
  KELLY_FRACTION_MIN,
  KELLY_FRACTION_MAX,
  KELLY_FRACTION_STEP,
  getKellyFraction,
  setKellyFraction,

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
  kellyScore,
  epBucketKey,

  // Domain-specific
  pitcherAdjustment,
  shotsDifferentialAdjustment,
  recomputeWl,

  // Hierarchical calibration
  HIER_CALIB_PRIOR,
  HIER_CALIB_MIN_N,
  HIER_CALIB_K,
  bayesSmooth,
  hierarchicalMultiplier,

  // Residual model framework
  RESIDUAL_MIN_TRAINING_PICKS,
  residualModelDelta,
  residualModelActive,
};
