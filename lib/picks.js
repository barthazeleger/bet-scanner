'use strict';

const { clamp, UNIT_EUR, MIN_EP, KELLY_FRACTION, MAX_WINNER_ODDS, epBucketKey, DEFAULT_EPW } = require('./config');
const { getDrawdownMultiplier } = require('./calibration');

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}) {
  const picks     = [];
  const combiPool = [];

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

    const ddMult = getDrawdownMultiplier();
    const hk = k * KELLY_FRACTION * ddMult;
    const u  = hk>0.09?'1.0U' : hk>0.04?'0.5U' : '0.3U';
    const edge = Math.round((ep * odd - 1) * 100 * 10) / 10;

    const uNum = hk>0.09 ? 1.0 : hk>0.04 ? 0.5 : 0.3;
    const expectedEur = +(uNum * UNIT_EUR * (edge / 100) * dataConf).toFixed(2);
    const pick = { match, league, label, odd, units: u, reason, prob, ep: +ep.toFixed(3),
                   strength: k*(odd-1)*vP*epW*dataConf, kelly: hk, edge, expectedEur, kickoff, bookie,
                   signals: signals || [], referee: referee || null, dataConfidence: dataConf };

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

// ── PROBABILITY CALCULATORS ─────────────────────────────────────────────────
function calcWinProb({ h2hEdge, formEdge, posAdj, momentum, injAdj, stakesAdj, homeAdv=0.05 }) {
  const combined = h2hEdge*0.22 + formEdge*0.35 + posAdj*0.12 + momentum*0.10 + injAdj*0.08 + stakesAdj*0.08 + homeAdv;
  return clamp((0.50 + combined * 0.32) * 100, 10, 90);
}

function calcOverProb({ h2hAvgGoals, hmAvgGF, hmAvgGA, awAvgGF, awAvgGA, line=2.5 }) {
  const projGoals = (hmAvgGF + awAvgGF + hmAvgGA + awAvgGA) / 2 * 0.88;
  const factor    = ((projGoals - line) * 0.22) + ((h2hAvgGoals - line) * 0.15);
  return clamp((0.50 + factor) * 100, 15, 85);
}

function calcBTTSProb({ h2hBTTS, h2hN, hmAvgGF, awAvgGF }) {
  const h2hRate  = h2hN > 0 ? h2hBTTS / h2hN : 0.50;
  const formRate = Math.min(0.92, hmAvgGF / 1.8) * Math.min(0.92, awAvgGF / 1.8);
  return clamp((h2hRate * 0.45 + formRate * 0.55) * 100, 15, 85);
}

// ── ODDS ANALYSE HELPERS ───────────────────────────────────────────────────────

function fairProbs(bookmakers, homeTeam, awayTeam) {
  const hp = [], ap = [], dp = [];
  for (const bk of bookmakers) {
    const mkt = bk.markets?.find(m => m.key === 'h2h');
    if (!mkt?.outcomes?.length) continue;
    const totalIP = mkt.outcomes.reduce((s,o) => s + 1/o.price, 0);
    if (totalIP < 0.5) continue;
    for (const o of mkt.outcomes) {
      const p = (1/o.price) / totalIP;
      if (o.name === homeTeam)  hp.push(p);
      else if (o.name === awayTeam) ap.push(p);
      else dp.push(p);
    }
  }
  const avg = a => a.length ? a.reduce((s,v)=>s+v,0)/a.length : 0;
  const h = avg(hp), a = avg(ap), d = avg(dp);
  if (!h || !a) return null;
  const tot = h + a + (d||0);
  return { home: h/tot, away: a/tot, draw: d/tot };
}

function bestOdds(bookmakers, marketKey, outcomeName) {
  let best = { price: 0, bookie: '' };
  for (const bk of bookmakers) {
    const mkt = bk.markets?.find(m => m.key === marketKey);
    const o   = mkt?.outcomes?.find(o => o.name === outcomeName);
    if (o && o.price > best.price) best = { price: +o.price.toFixed(3), bookie: bk.title };
  }
  return best;
}

function bookiePrice(bookmakers, bookieFragment, marketKey, outcomeName) {
  const bk = bookmakers.find(b => b.key?.includes(bookieFragment) || b.title?.toLowerCase().includes(bookieFragment));
  const mkt = bk?.markets?.find(m => m.key === marketKey);
  return mkt?.outcomes?.find(o => o.name === outcomeName)?.price || null;
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

// No-vig fair probabilities for 2-way markets (basketball/hockey · no draw)
function fairProbs2Way(oddsArr) {
  if (!oddsArr || oddsArr.length < 2) return null;
  const home = oddsArr.find(o => o.side === 'home');
  const away = oddsArr.find(o => o.side === 'away');
  if (!home || !away || home.price < 1.01 || away.price < 1.01) return null;
  const totalIP = 1/home.price + 1/away.price;
  return { home: (1/home.price)/totalIP, away: (1/away.price)/totalIP };
}

// Parse basketball/hockey odds from api-sports response
function parseGameOdds(oddsResp, homeTeam, awayTeam) {
  const bookmakers = oddsResp?.[0]?.bookmakers || oddsResp?.bookmakers || [];
  if (!bookmakers.length) return { moneyline: [], totals: [], spreads: [] };

  const ml = [], tots = [], spr = [];
  for (const bk of bookmakers) {
    const bkName = bk.name || bk.bookmaker?.name || 'Unknown';
    for (const bet of (bk.bets || [])) {
      const betId = bet.id;
      if (betId === 1) {
        for (const v of (bet.values || [])) {
          const side = v.value === 'Home' ? 'home' : v.value === 'Away' ? 'away' : null;
          if (side) ml.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }
      if (betId === 2 || betId === 3) {
        for (const v of (bet.values || [])) {
          const m = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (m) tots.push({ side: m[1].toLowerCase(), point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }
      if (betId === 2 || betId === 3) {
        for (const v of (bet.values || [])) {
          const m = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (m) spr.push({ side: m[1].toLowerCase() === 'home' ? 'home' : 'away', name: m[1].toLowerCase() === 'home' ? homeTeam : awayTeam, point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }
    }
  }
  return { moneyline: ml, totals: tots, spreads: spr };
}

// Best odds from parsed odds array
function bestFromArr(arr) {
  if (!arr.length) return { price: 0, bookie: '' };
  return arr.reduce((best, o) => o.price > best.price ? { price: +o.price.toFixed(3), bookie: o.bookie } : best, { price: 0, bookie: '' });
}

// ── ODDS CONVERTER: api-football.com → intern formaat ──────────────────────
function convertAfOdds(afBookmakers, hm, aw) {
  return afBookmakers.map(bk => {
    const markets = [];
    const mw = bk.bets?.find(b => b.id === 1);
    if (mw) {
      markets.push({
        key: 'h2h',
        outcomes: mw.values.map(v => ({
          name:  v.value === 'Home' ? hm : v.value === 'Away' ? aw : 'Draw',
          price: parseFloat(v.odd) || 0,
        })).filter(o => o.price > 1.01),
      });
    }
    const ou = bk.bets?.find(b => b.id === 5);
    if (ou) {
      markets.push({
        key: 'totals',
        outcomes: ou.values.map(v => {
          const m = v.value.match(/(Over|Under)\s+([\d.]+)/i);
          if (!m) return null;
          return { name: m[1], price: parseFloat(v.odd) || 0, point: parseFloat(m[2]) };
        }).filter(Boolean),
      });
    }
    const bttsB = bk.bets?.find(b => b.id === 8);
    if (bttsB) {
      markets.push({
        key: 'btts',
        outcomes: bttsB.values.map(v => ({
          name: v.value,
          price: parseFloat(v.odd) || 0,
        })).filter(o => o.price > 1.01),
      });
    }
    const ah = bk.bets?.find(b => b.id === 12 && !(b.name||'').toLowerCase().includes('draw no bet'));
    if (ah) {
      markets.push({
        key: 'spreads',
        outcomes: ah.values.map(v => {
          const m = v.value.match(/^(Home|Away)\s*([+-][\d.]+)?/i);
          if (!m) return null;
          return {
            name:  m[1].toLowerCase() === 'home' ? hm : aw,
            price: parseFloat(v.odd) || 0,
            point: parseFloat(m[2] || '0'),
          };
        }).filter(o => o && o.price > 1.01),
      });
    }
    return { title: bk.name, key: bk.name?.toLowerCase().replace(/\s+/g,'_'), markets };
  }).filter(bk => bk.markets.length > 0);
}

module.exports = {
  buildPickFactory, calcForm, calcMomentum, calcStakes,
  calcWinProb, calcOverProb, calcBTTSProb,
  fairProbs, bestOdds, bookiePrice, analyseTotal,
  fairProbs2Way, parseGameOdds, bestFromArr, convertAfOdds,
};
