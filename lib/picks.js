'use strict';

const { clamp, UNIT_EUR, MIN_EP, MAX_WINNER_ODDS, epBucketKey, DEFAULT_EPW } = require('./config');
const { kellyToUnits, getKellyFraction } = require('./model-math');
const {
  calcWinProb,
  fairProbs,
  bestOdds,
  bookiePrice,
  fairProbs2Way,
  parseGameOdds,
  bestFromArr,
  convertAfOdds,
} = require('./odds-parser');

function defaultDrawdownMultiplier() { return 1.0; }

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}, options = {}) {
  const picks     = [];
  const combiPool = [];
  const drawdownMultiplier = typeof options.drawdownMultiplier === 'function'
    ? options.drawdownMultiplier
    : defaultDrawdownMultiplier;
  const activeUnitEur = Number.isFinite(options.activeUnitEur) && options.activeUnitEur > 0
    ? options.activeUnitEur
    : UNIT_EUR;
  const adaptiveMinEdge = typeof options.adaptiveMinEdge === 'function'
    ? options.adaptiveMinEdge
    : null;
  const sport = options.sport || 'football';

  const mkP = (match, league, label, odd, reason, prob, boost=0, kickoff=null, bookie=null, signals=null, referee=null) => {
    if (!odd || odd < 1.10) return;
    const ip = 1/odd;
    const ep = Math.min(0.88, ip + boost);
    if (ep < MIN_EP) return;
    if (ep <= ip + 0.03) return;
    const k = ((ep*(odd-1)) - (1-ep)) / (odd-1);
    if (k <= 0.015) return;

    const vP = odd > 3.50 ? 0.42
             : odd > 2.50 ? 0.65
             : odd > 2.00 ? 0.85
             : 1.0;

    const sigCount = (signals || []).length;
    const dataConf = sigCount >= 6 ? 1.0
                   : sigCount >= 3 ? 0.70
                   : sigCount >= 1 ? 0.50
                   : 0.40;

    const bk  = epBucketKey(ep);
    const epW = (calibEpBuckets[bk]?.n >= 15 && calibEpBuckets[bk]?.weight)
      ? calibEpBuckets[bk].weight
      : DEFAULT_EPW[bk];

    const labelLc = (label || '').toLowerCase();
    const isBttsPick = /btts/i.test(labelLc);
    const isOverUnderPick = /over\s*\d|under\s*\d/i.test(labelLc);
    const relevantSignals = (signals || []).filter(s => {
      const sigLc = s.toLowerCase();
      if (isBttsPick) return /btts|aggregate_push_btts/.test(sigLc);
      if (isOverUnderPick) return /(weather|poisson|team_stats|over|under|goals|o2\.5|u2\.5)/.test(sigLc);
      return !/btts|aggregate_push_btts|totalscore|o2\.5|u2\.5/.test(sigLc);
    });
    const baselineProb = +(100 / odd).toFixed(1);
    const signalContrib = +(relevantSignals.reduce((s, sig) => {
      const m = /([+-]\d+\.?\d*)%/.exec(sig);
      return s + (m ? parseFloat(m[1]) : 0);
    }, 0)).toFixed(1);
    const probGap = +(prob - baselineProb).toFixed(1);
    const basePct = +(prob - signalContrib).toFixed(1);
    const baseGap = +(basePct - baselineProb).toFixed(1);
    const auditSuspicious = probGap > 15 && Math.abs(baseGap) > 15
      && Math.abs(signalContrib) < Math.abs(baseGap) * 0.3;
    const auditDampen = auditSuspicious ? 0.6 : 1.0;
    const audit = {
      baseline_prob: baselineProb, base_prob: basePct, base_gap: baseGap,
      signal_contrib: signalContrib, prob_gap: probGap,
      suspicious: auditSuspicious, stake_dampen: auditDampen,
    };

    const ddMult = drawdownMultiplier();
    const hk = k * getKellyFraction() * ddMult * auditDampen;
    const u  = kellyToUnits(hk);
    const edge = Math.round((ep * odd - 1) * 100 * 10) / 10;

    const uNum = parseFloat(u);
    const expectedEur = +(uNum * activeUnitEur * (edge / 100) * dataConf).toFixed(2);
    const pick = { match, league, label, odd, units: u, reason, prob, ep: +ep.toFixed(3),
                   strength: k*(odd-1)*vP*epW*dataConf, kelly: hk, edge, expectedEur, kickoff, bookie,
                   signals: signals || [], referee: referee || null, dataConfidence: dataConf,
                   sport, audit };

    if (adaptiveMinEdge) {
      const requiredEdgePct = adaptiveMinEdge(sport, label, 0.055) * 100;
      if (edge < requiredEdgePct) return;
    }

    combiPool.push(pick);
    if (odd >= MIN_ODDS) picks.push(pick);
  };
  return { picks, combiPool, mkP };
}

// ── FORM & SIGNALS ─────────────────────────────────────────────────────────────
function calcForm(evts, tid) {
  let W=0,D=0,L=0,gF=0,gA=0,cs=0;
  for (const m of (evts||[])) {
    const isH = m.homeTeam?.id === tid;
    const ts  = isH ? (m.homeScore?.current??0) : (m.awayScore?.current??0);
    const os  = isH ? (m.awayScore?.current??0) : (m.homeScore?.current??0);
    if (ts > os) W++; else if (ts === os) D++; else L++;
    gF += ts; gA += os;
    if (os === 0) cs++;
  }
  const n = (evts||[]).length || 1;
  return { W, D, L, pts: W*3+D, form: `${W}W${D}D${L}L`,
           avgGF: +(gF/n).toFixed(2), avgGA: +(gA/n).toFixed(2),
           cleanSheets: cs, n };
}

function calcMomentum(evts, tid) {
  const f3  = calcForm((evts||[]).slice(0, 3), tid);
  const f36 = calcForm((evts||[]).slice(3, 6), tid);
  return f3.pts - f36.pts;
}

function calcStakes(pts, leaderPts, relegPts, cl4Pts, eu6Pts) {
  if (!leaderPts) return { label:'', adj:0 };
  const gapTop=leaderPts-pts, gapRel=pts-relegPts, gapCL=cl4Pts-pts, gapEU=eu6Pts-pts;
  if (gapRel <= 0)  return { label:'🔴 IN degradatiezone', adj: 0.12 };
  if (gapRel <= 3)  return { label:'🟠 Vecht om behoud',   adj: 0.08 };
  if (gapTop <= 3)  return { label:'🏆 Titelrace',          adj: 0.08 };
  if (gapCL  <= 3)  return { label:'⭐ CL-strijd',          adj: 0.05 };
  if (gapEU  <= 3)  return { label:'🎯 Europese strijd',    adj: 0.03 };
  if (gapRel > 15 && gapTop > 18) return { label:'😴 Niets te spelen', adj: -0.08 };
  return { label:'', adj:0 };
}

function calcOverProb({ h2hAvgGoals, hmAvgGF, hmAvgGA, awAvgGF, awAvgGA, line=2.5 }) {
  const projGoals = (hmAvgGF + awAvgGF + hmAvgGA + awAvgGA) / 2 * 0.88;
  const factor    = ((projGoals - line) * 0.22) + ((h2hAvgGoals - line) * 0.15);
  return clamp((0.50 + factor) * 100, 15, 85);
}

// Keep BTTS math aligned with the live scanner: thin H2H samples are shrunk
// toward a football-wide prior so 2/2 or 3/3 meetings do not overdrive picks.
const BTTS_H2H_PRIOR = 0.52;
const BTTS_H2H_PRIOR_K = 8;
function calcBTTSProb({ h2hBTTS, h2hN, hmAvgGF, awAvgGF }) {
  const n = h2hN || 0;
  const btts = h2hBTTS || 0;
  const h2hRate = (btts + BTTS_H2H_PRIOR * BTTS_H2H_PRIOR_K) / (n + BTTS_H2H_PRIOR_K);
  const formRate = Math.min(0.92, hmAvgGF / 1.8) * Math.min(0.92, awAvgGF / 1.8);
  return clamp((h2hRate * 0.45 + formRate * 0.55) * 100, 15, 85);
}

function analyseTotal(bookmakers, outcomeName, point) {
  const prices = [];
  let best = { price: 0, bookie: '' };
  for (const bk of bookmakers) {
    const mkt = bk.markets?.find(m => m.key === 'totals');
    const o   = mkt?.outcomes?.find(o => o.name === outcomeName && Math.abs((o.point||0)-point)<0.6);
    if (!o) continue;
    prices.push(o.price);
    if (o.price > best.price) best = { price: +o.price.toFixed(3), bookie: bk.title };
  }
  return { best, avgIP: prices.length ? prices.reduce((s,p)=>s+1/p,0)/prices.length : 0 };
}

module.exports = {
  buildPickFactory, calcForm, calcMomentum, calcStakes,
  calcWinProb, calcOverProb, calcBTTSProb,
  fairProbs, bestOdds, bookiePrice, analyseTotal,
  fairProbs2Way, parseGameOdds, bestFromArr, convertAfOdds,
};
