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

// Threshold voor model-vs-market divergentie bij sanity check.
// v11.3.28: 0.04 → 0.07. Operator-rapport 2026-04-18 22:00: "sinds begin
// middag alleen Over 2.5 voetbal, geen BTTS/1X2/DNB/ML meer". Root cause:
// v11.1.2 + v11.2.1 (vandaag 09:30/09:52) introduceerden 4pp gate op 11
// markten. Cumulatieve signal-pushes (referee, H2H, form, predictions,
// congestion, weather) zitten legitiem op 5-8pp voor 1X2/BTTS/DNB, ver
// onder de Sandefjord-class 34pp fake-edge maar ruim boven 4pp. 7pp laat
// legitieme signal-based picks door, blokkeert nog steeds de fake-edges.
// TODO: autoTune-per-sport zodra ≥50 settled bets per markt beschikbaar.
const MODEL_MARKET_DIVERGENCE_THRESHOLD = 0.07;

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

/**
 * v11.1.2 — 2-way market divergence gate (BTTS, O/U, ML zonder draw, NRFI,
 * Run Line per point). Devig de paired odds, vergelijk model-prob met
 * market-implied, return pass-flags per zijde + marketFair struct.
 *
 * Vig-range [1.00, 1.15) filtert te-ruime spreads (bv. missende kwaliteit
 * bookie-pool). Bij onbruikbare vig → beide zijden passeren (geen gate).
 * Doctrine: een gate die crasht of een lege market-fair gebruikt is erger
 * dan geen gate — noisy fail-open is expliciet.
 *
 * @param {number} modelProbA
 * @param {number} modelProbB (=1-modelProbA normaal; los doorgegeven voor flexibiliteit)
 * @param {number} priceA    bookmaker odds voor zijde A
 * @param {number} priceB    bookmaker odds voor zijde B
 * @param {number} threshold divergence threshold, default 0.04
 * @returns {{passA: boolean, passB: boolean, marketFair: {a, b, vig}|null}}
 */
function passesDivergence2Way(modelProbA, modelProbB, priceA, priceB, threshold = MODEL_MARKET_DIVERGENCE_THRESHOLD) {
  const pA = Number(priceA);
  const pB = Number(priceB);
  if (!Number.isFinite(pA) || pA <= 1.0 || !Number.isFinite(pB) || pB <= 1.0) {
    return { passA: true, passB: true, marketFair: null };
  }
  const ipA = 1 / pA;
  const ipB = 1 / pB;
  const tot = ipA + ipB;
  // v12.0.1: fail-closed bij onrealistische overround. Voorheen: tot < 1.0 OR
  // tot >= 1.15 → fail-open (beide zijden pass). Probleem: extreme paired odds
  // zoals (34, 1.10) geven tot=0.94 < 1.0 → gate-bypass → absurde 1H Over picks
  // met edges >2000% kwamen door. Correcte reading: tot buiten [1.0, 1.15] =
  // data is vrijwel zeker corrupt, gate MOET faal zodat pick dropt.
  // Exchange-style zero-vig (tot ~1.0) blijft legit → gebruik tolerantie 0.98.
  if (tot < 0.98 || tot >= 1.15) {
    return { passA: false, passB: false, marketFair: null, reason: `overround_out_of_range (tot=${tot.toFixed(3)})` };
  }
  const marketFair = { a: ipA / tot, b: ipB / tot, vig: +(tot - 1).toFixed(4) };
  const divA = Number.isFinite(modelProbA) ? Math.abs(modelProbA - marketFair.a) : Infinity;
  const divB = Number.isFinite(modelProbB) ? Math.abs(modelProbB - marketFair.b) : Infinity;
  return {
    passA: divA <= threshold,
    passB: divB <= threshold,
    marketFair,
    divergenceA: Number.isFinite(divA) ? +divA.toFixed(4) : null,
    divergenceB: Number.isFinite(divB) ? +divB.toFixed(4) : null,
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
// v12.0.0 (Claude P1.5): reliability-factor wordt nu toegepast op adj. Voorheen
// werd pitcherReliabilityFactor() elders berekend maar niet terug-gevoerd in de
// adj-waarde — rookie-pitcher met 3 starts kreeg dus dezelfde ±6% signal-weight
// als 20-start veteraan. Nu schaalt `raw` mee met reliability zodat dunne
// samples minder hard pushen.
function pitcherAdjustment(homePitcher, awayPitcher) {
  if (!homePitcher?.era || !awayPitcher?.era) return { adj: 0, note: null, valid: false };
  if ((homePitcher.ip || 0) < 10 || (awayPitcher.ip || 0) < 10) return { adj: 0, note: null, valid: false };
  const eraDiff = awayPitcher.era - homePitcher.era;
  const reliability = pitcherReliabilityFactor(homePitcher, awayPitcher);
  const raw = eraDiff * 0.017 * reliability.factor;
  const clamped = Math.max(-0.06, Math.min(0.06, raw));
  const note = `Pitchers: ${homePitcher.name?.split(' ').pop() || 'H'} ${homePitcher.era.toFixed(2)} vs ${awayPitcher.name?.split(' ').pop() || 'A'} ${awayPitcher.era.toFixed(2)} (Δ${eraDiff > 0 ? '+' : ''}${eraDiff.toFixed(2)})${reliability.factor < 1 ? ` ×${reliability.factor.toFixed(2)}` : ''}`;
  return { adj: clamped, note, valid: true };
}

// Early-season / thin-sample damping voor starter-gedreven MLB edges.
// F5 blijft nuttig, maar met 2 starts willen we niet dezelfde pitcher-weight
// gebruiken als bij 6-8 starts. Factor geldt daarom als betrouwbaarheidsschaal.
function pitcherReliabilityFactor(homePitcher, awayPitcher) {
  const homeIp = Number(homePitcher?.ip) || 0;
  const awayIp = Number(awayPitcher?.ip) || 0;
  if (homeIp <= 0 || awayIp <= 0) {
    return { factor: 0.7, note: 'Starter sample dun', valid: false };
  }
  const minIp = Math.min(homeIp, awayIp);
  const totalIp = homeIp + awayIp;
  let factor = 1.0;
  if (minIp < 15) factor = 0.7;
  else if (minIp < 25) factor = 0.82;
  else if (totalIp < 70) factor = 0.9;
  const note = factor < 1
    ? `Starter sample ×${factor.toFixed(2)} (${homeIp.toFixed(0)} IP vs ${awayIp.toFixed(0)} IP)`
    : 'Starter sample sterk';
  return { factor, note, valid: true };
}

// NHL goalie signal: save% draagt zwaarder dan GAA; confirmation kan een kleine
// extra push geven maar mag nooit de pure kwaliteit overstemmen.
//
// v10.10.3 fixes:
//  1. svDiff-gewicht 3 → 1.5: was te zwaar (0.020 save%-gap = volle ±6% cap),
//     halveren tot we 100+ settled NHL picks hebben om empirisch te kalibreren.
//     Effect: 0.020 svDiff → 3% (i.p.v. 6%), past binnen "voorzichtig tot bewezen".
//  2. confidenceFactor uit selectLikelyGoalie() wordt nu daadwerkelijk toegepast.
//     Voorheen: primary-goalie met slechts 6 games-voorsprong (medium=0.7) kreeg
//     volle ±6% adj alsof het een vaste starter was. Nu: clamped × min(homeCf,
//     awayCf). Medium-confidence zakt max-impact naar ±2.1%, low naar ±1.35%.
function goalieAdjustment(homeGoalie, awayGoalie, opts = {}) {
  const homeSv = Number(homeGoalie?.savePct);
  const awaySv = Number(awayGoalie?.savePct);
  const homeGaa = Number(homeGoalie?.gaa);
  const awayGaa = Number(awayGoalie?.gaa);
  const homeGp = Number(homeGoalie?.gamesPlayed || homeGoalie?.gamesStarted || 0);
  const awayGp = Number(awayGoalie?.gamesPlayed || awayGoalie?.gamesStarted || 0);
  if (!isFinite(homeSv) || !isFinite(awaySv) || !isFinite(homeGaa) || !isFinite(awayGaa)) {
    return { adj: 0, note: null, valid: false };
  }
  if (homeGp < 8 || awayGp < 8) return { adj: 0, note: null, valid: false };
  const svDiff = homeSv - awaySv;
  const gaaDiff = awayGaa - homeGaa;
  const confAdj = opts.confirmedHome && !opts.confirmedAway
    ? 0.006
    : opts.confirmedAway && !opts.confirmedHome
      ? -0.006
      : 0;
  const raw = svDiff * 1.5 + gaaDiff * 0.03 + confAdj;
  const clamped = Math.max(-0.06, Math.min(0.06, raw));
  // confidenceFactor uit selectLikelyGoalie: 1.0 (high), 0.7 (medium), 0.45 (low).
  // Default 1.0 als selectLikelyGoalie niet als source is gebruikt (back-compat).
  const homeCf = Number.isFinite(homeGoalie?.confidenceFactor) ? homeGoalie.confidenceFactor : 1.0;
  const awayCf = Number.isFinite(awayGoalie?.confidenceFactor) ? awayGoalie.confidenceFactor : 1.0;
  const cf = Math.min(homeCf, awayCf);
  const adj = +(clamped * cf).toFixed(4);
  const cfTag = cf < 1 ? ` · cf×${cf.toFixed(2)}` : '';
  const note = `Goalies: ${homeGoalie.name?.split(' ').pop() || 'H'} ${homeSv.toFixed(3)}/${homeGaa.toFixed(2)} vs ${awayGoalie.name?.split(' ').pop() || 'A'} ${awaySv.toFixed(3)}/${awayGaa.toFixed(2)}${cfTag}`;
  return { adj, note, valid: true, confidenceFactor: cf };
}

function injurySeverityWeight(status, sport = 'generic') {
  if (!status) return 0;
  const s = String(status).toLowerCase();
  if (s.includes('probable') || s.includes('healthy') || s.includes('active')) return 0;
  if (s.includes('out') || s.includes('ir ') || s.includes('injured reserve') || s.includes('suspen')) return 1;
  if (s.includes('doubt')) return 0.75;
  if (s.includes('question') || s.includes('day-to-day') || s.includes('day to day')) {
    return sport === 'basketball' ? 0.5 : 0.4;
  }
  if (sport === 'basketball' && (s.includes('game-time') || s.includes('gtd'))) return 0.45;
  if (s.includes('injured')) return 0.85;
  return 0;
}

// NBA-contexthelper: combineert rustverschil en gewogen blessurebelasting.
// B2B wordt elders al direct bestraft; hier modelleren we vooral de delta tussen
// 2+ dagen rust en roster-beschikbaarheid.
function nbaAvailabilityAdjustment(homeCtx, awayCtx) {
  const homeRest = Number(homeCtx?.restDays);
  const awayRest = Number(awayCtx?.restDays);
  const homeInj = Number(homeCtx?.injuryLoad) || 0;
  const awayInj = Number(awayCtx?.injuryLoad) || 0;
  const restDiff = isFinite(homeRest) && isFinite(awayRest) ? homeRest - awayRest : 0;
  const restAdj = Math.max(-0.018, Math.min(0.018, restDiff * 0.006));
  const injDiff = awayInj - homeInj;
  const injAdj = Math.max(-0.04, Math.min(0.04, injDiff * 0.01));
  const total = Math.max(-0.055, Math.min(0.055, restAdj + injAdj));
  const bits = [];
  if (restDiff) bits.push(`Rest Δ${restDiff > 0 ? '+' : ''}${restDiff}`);
  if (Math.abs(injDiff) >= 0.1) bits.push(`Inj load Δ${injDiff > 0 ? '+' : ''}${injDiff.toFixed(1)}`);
  return {
    adj: total,
    restAdj,
    injAdj,
    injuryDiff: injDiff,
    note: bits.length ? bits.join(' | ') : null,
    valid: true,
  };
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

// v10.10.19: Form-score shrinkage. Dempt extreme form-streaks (alle W of
// alle L) richting neutrale prior. Bij 5 games is een 5W-streak nog ~50%
// variance; Bayesian smoothing voorkomt dat dit als maximal signal meetelt.
// Zelfde principe als BTTS-H2H shrinkage (v10.8.23).
const FORM_PRIOR_PTS_PER_GAME = 1.5;  // E[pts/game] bij W=3,D=1,L=0 ≈ 1.5
const FORM_SHRINKAGE_K = 5;
function shrinkFormScore(rawScore, nGames = 5, priorPtsPerGame, k) {
  const prior = Number.isFinite(priorPtsPerGame) ? priorPtsPerGame : FORM_PRIOR_PTS_PER_GAME;
  const kk = Number.isFinite(k) ? k : FORM_SHRINKAGE_K;
  const n = Number.isFinite(nGames) && nGames > 0 ? nGames : 5;
  const ownRate = rawScore / n;
  const shrunkRate = bayesSmooth(ownRate, n, prior, kk);
  return +(shrunkRate * n).toFixed(2);
}

// Samenvatting per signaal met markt-contextcorrectie.
// Doel: signalen niet belonen/straffen voor de ruwe CLV van de markt waarin ze
// toevallig vaak voorkomen. We vergelijken daarom met een geshrinkte
// markt-baseline en berekenen signal excess CLV daarboven.
function summarizeSignalMetrics(rows, opts = {}) {
  const marketPriorK = Number.isFinite(opts.marketPriorK) ? opts.marketPriorK : 15;
  const signalPriorK = Number.isFinite(opts.signalPriorK) ? opts.signalPriorK : 25;
  const markets = {};
  const signals = {};

  for (const row of (rows || [])) {
    const marketKey = row?.marketKey || 'unknown';
    const clvPct = parseFloat(row?.clvPct);
    if (!isFinite(clvPct)) continue;
    if (!markets[marketKey]) markets[marketKey] = { n: 0, sumClv: 0 };
    markets[marketKey].n++;
    markets[marketKey].sumClv += clvPct;
  }

  for (const row of (rows || [])) {
    const marketKey = row?.marketKey || 'unknown';
    const clvPct = parseFloat(row?.clvPct);
    if (!isFinite(clvPct)) continue;
    const signalNames = Array.isArray(row?.signalNames) ? row.signalNames : [];
    if (!signalNames.length) continue;
    const market = markets[marketKey] || { n: 0, sumClv: 0 };
    const marketAvgClv = market.n ? market.sumClv / market.n : 0;
    const marketBaselineClv = bayesSmooth(marketAvgClv, market.n, 0, marketPriorK);
    const excessClv = clvPct - marketBaselineClv;
    for (const rawName of signalNames) {
      const name = (rawName || '').toString().trim();
      if (!name) continue;
      if (!signals[name]) {
        signals[name] = {
          n: 0, sumClv: 0, posClv: 0,
          sumExcessClv: 0, posExcessClv: 0,
        };
      }
      signals[name].n++;
      signals[name].sumClv += clvPct;
      signals[name].sumExcessClv += excessClv;
      if (clvPct > 0) signals[name].posClv++;
      if (excessClv > 0) signals[name].posExcessClv++;
    }
  }

  const signalSummary = {};
  for (const [name, s] of Object.entries(signals)) {
    const avgClv = s.n ? s.sumClv / s.n : 0;
    const avgExcessClv = s.n ? s.sumExcessClv / s.n : 0;
    signalSummary[name] = {
      n: s.n,
      avgClv,
      avgExcessClv,
      shrunkExcessClv: bayesSmooth(avgExcessClv, s.n, 0, signalPriorK),
      posClvRate: s.n ? s.posClv / s.n : 0,
      posExcessClvRate: s.n ? s.posExcessClv / s.n : 0,
    };
  }

  const marketSummary = {};
  for (const [key, m] of Object.entries(markets)) {
    const avgClv = m.n ? m.sumClv / m.n : 0;
    marketSummary[key] = {
      n: m.n,
      avgClv,
      baselineClv: bayesSmooth(avgClv, m.n, 0, marketPriorK),
    };
  }

  return { markets: marketSummary, signals: signalSummary };
}

/**
 * v10.12.11 Phase B.5: Binomial two-tailed p-value voor H0: rate=0.5.
 * Normale approximatie (valid bij n ≥ 20). Gebruikt voor autotune-FDR:
 * signaal met posExcessClvRate meaningfully > 0.5 → edge-bewijs.
 *
 * @param {number} k - geobserveerde successes
 * @param {number} n - totaal trials
 * @returns {number} p-value ∈ (0, 1]; 1 als n=0 of invalid input
 */
function binomialPvalueTwoTailed(k, n) {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0) return 1;
  if (k < 0 || k > n) return 1;
  // Normal approximation: z = (k - n*0.5) / sqrt(n * 0.25)
  const z = (k - n * 0.5) / Math.sqrt(n * 0.25);
  // Abramowitz & Stegun 26.2.17 benadering voor Φ (erf-free)
  const absZ = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * absZ);
  const d = 0.3989422804014327 * Math.exp(-absZ * absZ / 2);
  const phiAbs = 1 - d * t * (
    0.319381530 + t * (
      -0.356563782 + t * (
        1.781477937 + t * (
          -1.821255978 + t * 1.330274429
        )
      )
    )
  );
  const oneTail = 1 - phiAbs; // P(Z > |z|)
  return Math.min(1, Math.max(1e-12, 2 * oneTail));
}

/**
 * v10.12.11 Phase B.5: Benjamini-Hochberg False Discovery Rate correctie.
 * Gegeven een lijst {name, p}, retourneert de set van namen die passeren
 * bij target FDR q. Klassiek BH: sorteer p opsomed, vind grootste i waarvoor
 * p_i ≤ (i/m) * q, alle p_j ≤ p_i halen het.
 *
 * @param {Array<{name:string, p:number}>} items
 * @param {number} q  - target FDR, default 0.10
 * @returns {Set<string>} names die BH-FDR passeren
 */
function benjaminiHochbergFDR(items, q = 0.10) {
  const pass = new Set();
  if (!Array.isArray(items) || items.length === 0) return pass;
  const m = items.length;
  const sorted = items
    .filter(it => Number.isFinite(it?.p) && it.name)
    .sort((a, b) => a.p - b.p);
  let threshold = -1;
  for (let i = 0; i < sorted.length; i++) {
    const criticalVal = ((i + 1) / m) * q;
    if (sorted[i].p <= criticalVal) threshold = sorted[i].p;
  }
  if (threshold < 0) return pass;
  for (const it of sorted) {
    if (it.p <= threshold) pass.add(it.name);
  }
  return pass;
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
// v10.10.7: row.unitAtTime krijgt voorrang op de meegegeven unitEur,
// zodat historische bets met een andere unit niet retroactief vervormen.
function recomputeWl(row, unitEur = 25) {
  if (!row || (row.uitkomst !== 'W' && row.uitkomst !== 'L')) return null;
  const rowUe = Number.isFinite(row.unitAtTime) && row.unitAtTime > 0 ? row.unitAtTime : unitEur;
  const inzet = row.inzet != null ? row.inzet : +((row.units || 0) * rowUe).toFixed(2);
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
  passesDivergence2Way,

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
  pitcherReliabilityFactor,
  goalieAdjustment,
  injurySeverityWeight,
  nbaAvailabilityAdjustment,
  shotsDifferentialAdjustment,
  recomputeWl,

  // Hierarchical calibration
  HIER_CALIB_PRIOR,
  HIER_CALIB_MIN_N,
  HIER_CALIB_K,
  bayesSmooth,
  hierarchicalMultiplier,
  summarizeSignalMetrics,
  binomialPvalueTwoTailed,
  benjaminiHochbergFDR,

  // Form shrinkage (v10.10.18)
  shrinkFormScore,
  FORM_PRIOR_PTS_PER_GAME,
  FORM_SHRINKAGE_K,

  // Residual model framework
  RESIDUAL_MIN_TRAINING_PICKS,
  residualModelDelta,
  residualModelActive,
};
