'use strict';

let preferredBookiesLower = null;

function setPreferredBookies(list) {
  // Canonieke truth = admin/operator preferredBookies uit settings.
  // Alleen als settings ontbreken of leeg zijn valt de runtime terug op
  // hard-coded trusted defaults elders in de scannerlaag. Die fallback is
  // safety-net, geen primaire execution truth.
  if (Array.isArray(list) && list.length) {
    preferredBookiesLower = list.map(x => (x || '').toString().toLowerCase()).filter(Boolean);
  } else {
    preferredBookiesLower = null;
  }
}

function getPreferredBookies() {
  return preferredBookiesLower ? [...preferredBookiesLower] : null;
}

// v10.12.20: directe access tot de lowercase-lijst voor pick-odds filtering.
// Gebruikt door lib/picks.js analyseTotal().
function getPreferredBookiesLower() {
  return preferredBookiesLower;
}

function fairProbs2Way(oddsArr) {
  if (!oddsArr || oddsArr.length < 2) return null;
  const home = oddsArr.find(o => o.side === 'home');
  const away = oddsArr.find(o => o.side === 'away');
  if (!home || !away || home.price < 1.01 || away.price < 1.01) return null;
  const totalIP = 1 / home.price + 1 / away.price;
  return { home: (1 / home.price) / totalIP, away: (1 / away.price) / totalIP };
}

function calcWinProb({ h2hEdge, formEdge, posAdj, momentum, injAdj, stakesAdj, homeAdv = 0.05 }, clampFn) {
  const clampImpl = clampFn || ((v, min, max) => Math.min(max, Math.max(min, v)));
  const combined = h2hEdge * 0.22 + formEdge * 0.35 + posAdj * 0.12 + momentum * 0.10 + injAdj * 0.08 + stakesAdj * 0.08 + homeAdv;
  return clampImpl((0.50 + combined * 0.32) * 100, 10, 90);
}

function fairProbs(bookmakers, homeTeam, awayTeam) {
  const hp = [];
  const ap = [];
  const dp = [];
  for (const bk of bookmakers) {
    const mkt = bk.markets?.find(m => m.key === 'h2h');
    if (!mkt?.outcomes?.length) continue;
    const totalIP = mkt.outcomes.reduce((sum, o) => sum + 1 / o.price, 0);
    if (totalIP < 0.5) continue;
    for (const o of mkt.outcomes) {
      const p = (1 / o.price) / totalIP;
      if (o.name === homeTeam) hp.push(p);
      else if (o.name === awayTeam) ap.push(p);
      else dp.push(p);
    }
  }
  const avg = a => (a.length ? a.reduce((sum, v) => sum + v, 0) / a.length : 0);
  const h = avg(hp);
  const a = avg(ap);
  const d = avg(dp);
  if (!h || !a) return null;
  const tot = h + a + (d || 0);
  return { home: h / tot, away: a / tot, draw: d / tot };
}

function parseGameOdds(oddsResp, homeTeam, awayTeam) {
  const bookmakers = oddsResp?.[0]?.bookmakers || oddsResp?.bookmakers || [];
  if (!bookmakers.length) {
    return {
      moneyline: [],
      totals: [],
      spreads: [],
      halfML: [],
      halfTotals: [],
      halfSpreads: [],
      nrfi: [],
      oddEven: [],
      threeWay: [],
      teamTotals: [],
      doubleChance: [],
      dnb: [],
    };
  }

  const ml = [];
  const tots = [];
  const spr = [];
  const halfML = [];
  const halfTotals = [];
  const halfSpreads = [];
  const nrfi = [];
  const oddEven = [];
  const threeWay = [];
  const teamTotals = [];
  const doubleChance = [];
  const dnb = [];

  for (const bk of bookmakers) {
    const bkName = bk.name || bk.bookmaker?.name || 'Unknown';
    for (const bet of (bk.bets || [])) {
      const betId = bet.id;
      const betName = (bet.name || '').toLowerCase();

      const mlNames = ['match winner', 'home/away', 'winner', 'match odds', '3way result', 'moneyline', 'money line'];
      const isMlByName = mlNames.includes(betName);
      if (betId === 1 || isMlByName) {
        const vals = bet.values || [];
        const names = vals.map(v => String(v.value || '').trim()).sort().join('|');
        if (vals.length === 2 && names === 'Away|Home') {
          for (const v of vals) {
            const side = v.value === 'Home' ? 'home' : 'away';
            ml.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }

      const vals3 = (bet.values || []).filter(v => ['Home', 'Draw', 'Away', '1', 'X', '2'].includes(String(v.value ?? '').trim()));
      if (vals3.length === 3 && betId !== 1) {
        for (const v of vals3) {
          const s = String(v.value ?? '').trim();
          const side = (s === 'Home' || s === '1') ? 'home'
            : (s === 'Draw' || s === 'X') ? 'draw'
              : (s === 'Away' || s === '2') ? 'away' : null;
          if (side) threeWay.push({ side, price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }

      // v12.0.0 (Codex P0): scope-isolatie. betId 2/3 werd ongecontroleerd naar
      // full-game `tots`/`spr` gepusht zelfs als bet.name "1st half", "1st period",
      // "1st inning", "F5" of andere period/half-variant bevatte. Gevolg: 1st-
      // period Under 1.5 kwam OOK in full-game totals → scanner pakte period-
      // price als full-game edge. Nu hard gate: period/half/F5 markten gaan
      // uitsluitend naar halfTotals/halfSpreads, niet naar full-game pools.
      const isHalfOrF5Bet = betName.includes('1st half') || betName.includes('first half') ||
        betName.includes('2nd half') || betName.includes('second half') ||
        betName.includes('1st period') || betName.includes('first period') ||
        betName.includes('2nd period') || betName.includes('3rd period') ||
        betName.includes('1st inning') || betName.includes('first inning') ||
        betName.includes('1st 5 inning') || betName.includes('first 5 inning') ||
        betName.includes('1st 5 innings') || betName.includes('f5 ') || betName === 'f5' ||
        betName.includes('1st quarter') || betName.includes('2nd quarter') ||
        betName.includes('3rd quarter') || betName.includes('4th quarter');
      if ((betId === 2 || betId === 3) && !isHalfOrF5Bet) {
        // v12.0.0: detecteer settlement-scope voor hockey/sporten waar dat telt.
        // Default 'unknown' → downstream gebruikt bookie-blacklist (HOCKEY_60MIN_BOOKIES).
        // Expliciete 'regulation'/'incl_ot' label maakt parser-level scope-filter
        // mogelijk zonder afhankelijkheid van bookie-blacklist.
        const scope = (betName.includes('regulation') || betName.includes('regular time') || betName.includes('60 min'))
          ? 'regulation'
          : (betName.includes('incl') && betName.includes('ot')) || betName.includes('overtime included') || betName.includes('including overtime')
            ? 'incl_ot'
            : 'unknown';
        for (const v of (bet.values || [])) {
          const totalMatch = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            const price = parseFloat(v.odd) || 0;
            // v12.0.1: sanity-cap op totals price. O/U-markten hebben per
            // definitie prijzen tussen ~1.20 en ~6.0. Odds ver buiten die range
            // (bv. 34.0) zijn data-corruptie, niet value. Voorheen kon zo'n
            // outlier via dedupeBestPrice door naar scanner en onrealistische
            // edges produceren (NBA 1H Over 110.5 @ 34 → edge +2600%).
            if (price < 1.10 || price > 10.0) continue;
            tots.push({ side: totalMatch[1].toLowerCase(), point: parseFloat(totalMatch[2]), price, bookie: bkName, scope });
          }
          const spreadMatch = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (spreadMatch) {
            const price = parseFloat(v.odd) || 0;
            // v12.0.1: sanity-cap. Spreads liggen tussen ~1.30 en ~5.0.
            if (price < 1.10 || price > 10.0) continue;
            spr.push({
              side: spreadMatch[1].toLowerCase() === 'home' ? 'home' : 'away',
              name: spreadMatch[1].toLowerCase() === 'home' ? homeTeam : awayTeam,
              point: parseFloat(spreadMatch[2]),
              price,
              bookie: bkName,
              scope,
            });
          }
        }
      }

      const is1H = betName.includes('1st half') || betName.includes('first half') || betName.includes('1st period') || betName.includes('first period') || betName.includes('1st inning');
      if (is1H) {
        if (betName.includes('winner') || betName.includes('moneyline') || betName.includes('result')) {
          for (const v of (bet.values || [])) {
            const side = v.value === 'Home' ? 'home' : v.value === 'Away' ? 'away' : null;
            if (side) halfML.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
        for (const v of (bet.values || [])) {
          const totalMatch = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            const price = parseFloat(v.odd) || 0;
            // v12.0.1: sanity-cap (zie full-game totals comment).
            if (price < 1.10 || price > 10.0) continue;
            halfTotals.push({ side: totalMatch[1].toLowerCase(), point: parseFloat(totalMatch[2]), price, bookie: bkName });
          }
          const spreadMatch = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (spreadMatch) {
            const price = parseFloat(v.odd) || 0;
            if (price < 1.10 || price > 10.0) continue;
            halfSpreads.push({
              side: spreadMatch[1].toLowerCase() === 'home' ? 'home' : 'away',
              name: spreadMatch[1].toLowerCase() === 'home' ? homeTeam : awayTeam,
              point: parseFloat(spreadMatch[2]),
              price,
              bookie: bkName,
            });
          }
        }
      }

      const isF5 = betName.includes('1st 5 inning') || betName.includes('first 5 inning') ||
        betName.includes('1st 5 innings') || betName.includes('f5 ');
      if (isF5) {
        if (betName.includes('winner') || betName.includes('moneyline') || betName.includes('result')) {
          const vals = bet.values || [];
          const hasDraw = vals.some(v => String(v.value || '').trim() === 'Draw');
          for (const v of vals) {
            const val = String(v.value || '').trim();
            const price = parseFloat(v.odd) || 0;
            if (price <= 1.0) continue;
            if (val === 'Home') halfML.push({ side: 'home', name: homeTeam, price, bookie: bkName, market: 'f5', hasDraw });
            else if (val === 'Away') halfML.push({ side: 'away', name: awayTeam, price, bookie: bkName, market: 'f5', hasDraw });
            else if (val === 'Draw' && hasDraw) halfML.push({ side: 'draw', price, bookie: bkName, market: 'f5', hasDraw });
          }
        }
        for (const v of (bet.values || [])) {
          const totalMatch = String(v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            halfTotals.push({ side: totalMatch[1].toLowerCase(), point: parseFloat(totalMatch[2]), price: parseFloat(v.odd) || 0, bookie: bkName, market: 'f5' });
          }
          const spreadMatch = String(v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (spreadMatch) {
            halfSpreads.push({
              side: spreadMatch[1].toLowerCase() === 'home' ? 'home' : 'away',
              name: spreadMatch[1].toLowerCase() === 'home' ? homeTeam : awayTeam,
              point: parseFloat(spreadMatch[2]),
              price: parseFloat(v.odd) || 0,
              bookie: bkName,
              market: 'f5',
            });
          }
        }
      }

      if (betName.includes('1st inning') || betName.includes('nrfi') || betName.includes('first inning')) {
        for (const v of (bet.values || [])) {
          const val = (v.value || '').toLowerCase();
          if (val === 'yes' || val === 'no' || val === 'over' || val === 'under') {
            const isNRFI = val === 'no' || val === 'under';
            nrfi.push({ side: isNRFI ? 'nrfi' : 'yrfi', price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }

      const isTeamTotalBet = (betName.includes('home team total') || betName.includes('away team total')) &&
        !betName.includes('1st') && !betName.includes('2nd') && !betName.includes('3rd') &&
        !betName.includes('period') && !betName.includes('half') && !betName.includes('quarter');
      if (isTeamTotalBet) {
        const team = betName.includes('home') ? 'home' : 'away';
        // v12.0.0 (Codex P0.3): settlement-scope voor team totals. Hockey/other
        // sporten waar regulation vs incl-OT een andere markt is. 'unknown' =
        // downstream gebruikt bookie-blacklist.
        const ttScope = (betName.includes('regulation') || betName.includes('regular time') || betName.includes('60 min'))
          ? 'regulation'
          : (betName.includes('incl') && betName.includes('ot')) || betName.includes('overtime included') || betName.includes('including overtime')
            ? 'incl_ot'
            : 'unknown';
        for (const v of (bet.values || [])) {
          const totalMatch = String(v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (totalMatch) {
            const point = parseFloat(totalMatch[2]);
            const price = parseFloat(v.odd) || 0;
            // v12.0.1: sanity-cap. Team-totals markt heeft prijzen 1.20-~6.0.
            if (price >= 1.10 && price <= 10.0 && isFinite(point)) {
              teamTotals.push({ team, side: totalMatch[1].toLowerCase(), point, price, bookie: bkName, scope: ttScope });
            }
          }
        }
      }

      if (betName.includes('double chance') && !betName.includes('half') && !betName.includes('period') && !betName.includes('quarter')) {
        for (const v of (bet.values || [])) {
          const val = String(v.value || '').trim();
          const price = parseFloat(v.odd) || 0;
          if (price <= 1.0) continue;
          let side = null;
          if (val === 'Home/Draw' || val === '1X') side = 'HX';
          else if (val === 'Home/Away' || val === '12') side = '12';
          else if (val === 'Draw/Away' || val === 'X2') side = 'X2';
          if (side) doubleChance.push({ side, price, bookie: bkName });
        }
      }

      if ((betName.includes('draw no bet') || betName === 'dnb') && !betName.includes('half') && !betName.includes('period')) {
        for (const v of (bet.values || [])) {
          const val = String(v.value || '').trim();
          const price = parseFloat(v.odd) || 0;
          if (price <= 1.0) continue;
          const side = val === 'Home' ? 'home' : val === 'Away' ? 'away' : null;
          if (side) dnb.push({ side, price, bookie: bkName });
        }
      }

      if (betName.includes('odd/even') || betName.includes('odd or even') || betName.includes('total odd') || betName.includes('total even')) {
        for (const v of (bet.values || [])) {
          const val = (v.value || '').toLowerCase();
          if (val === 'odd' || val === 'even') {
            oddEven.push({ side: val, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }
    }
  }

  // v12.0.0 (Codex P1): dedupeMainLine bewaarde de LAAGSTE prijs bij duplicate
  // bookie|side|point entries — bedoeld om risico te dempen bij parser-lekken,
  // maar het effect was dat je systematisch de slechtste variant overhield.
  // Nu de parser scope-isolatie heeft (betId 2/3 niet meer naar full-game bij
  // period/half/F5), komen duplicates realistisch alleen voor als dezelfde
  // bookie één lijn écht 2x quoote — dan wil je de beste prijs. Alle dedupes
  // gebruiken nu `dedupeBestPrice`. De oude `dedupeMainLine` blijft leeftijd
  // (niet meer gebruikt) voor eventuele backwards-compat, markeer als deprecated.
  const dedupeBestPrice = (arr, keyFn) => {
    if (!arr.length) return arr;
    const seen = new Map();
    for (const o of arr) {
      const key = keyFn(o);
      const prev = seen.get(key);
      if (!prev || o.price > prev.price) seen.set(key, o);
    }
    return [...seen.values()];
  };
  const kSide = o => `${(o.bookie || '').toLowerCase()}|${o.side}`;
  // v12.0.0 (Codex P0.3): scope toegevoegd aan dedupe-key voor totals/spreads/
  // teamTotals — zodat 'regulation' vs 'incl_ot' vs 'unknown' van dezelfde
  // bookie+point niet meer elkaar overschrijven.
  const kPoint = o => `${(o.bookie || '').toLowerCase()}|${o.side}|${o.point}|${o.scope || 'unknown'}`;
  const kTeam = o => `${(o.bookie || '').toLowerCase()}|${o.team}|${o.side}|${o.point}|${o.scope || 'unknown'}`;

  return {
    moneyline: dedupeBestPrice(ml, kSide),
    halfML: dedupeBestPrice(halfML, kSide),
    threeWay: dedupeBestPrice(threeWay, kSide),
    doubleChance: dedupeBestPrice(doubleChance, kSide),
    dnb: dedupeBestPrice(dnb, kSide),
    nrfi: dedupeBestPrice(nrfi, kSide),
    oddEven: dedupeBestPrice(oddEven, kSide),
    totals: dedupeBestPrice(tots, kPoint),
    spreads: dedupeBestPrice(spr, kPoint),
    halfTotals: dedupeBestPrice(halfTotals, kPoint),
    halfSpreads: dedupeBestPrice(halfSpreads, kPoint),
    teamTotals: dedupeBestPrice(teamTotals, kTeam),
  };
}

function bestFromArr(arr, options = {}) {
  // v10.10.11: returnt voortaan altijd ÉN preferred-best ÉN market-best.
  // Default `requirePreferred: true` houdt `price`/`bookie` op preferred-best
  // zodat bestaande call-sites (incl. heel de voetbal-flow) ongewijzigd
  // gedrag krijgen. Met `{ requirePreferred: false }` wordt `price`/`bookie`
  // de market-best — bedoeld voor multi-sport diagnostiek waar Bet365/Unibet
  // niet altijd een prijs hebben.
  const requirePreferred = options.requirePreferred !== false;
  const preferred = Array.isArray(options.preferredBookiesLower) && options.preferredBookiesLower.length
    ? options.preferredBookiesLower
    : preferredBookiesLower;
  const pool = arr || [];
  const pickHighest = (cands) => cands.length
    ? cands.reduce(
        (best, o) => (o.price > best.price ? { price: +o.price.toFixed(3), bookie: o.bookie } : best),
        { price: 0, bookie: '' }
      )
    : { price: 0, bookie: '' };

  const marketBest = pickHighest(pool);
  const preferredPool = preferred && preferred.length
    ? pool.filter(o => preferred.some(p => (o.bookie || '').toLowerCase().includes(p)))
    : pool;
  const preferredBest = pickHighest(preferredPool);

  const active = requirePreferred ? preferredBest : marketBest;
  const isActivePreferred = !!(active.bookie
    && preferred && preferred.length
    && preferred.some(p => active.bookie.toLowerCase().includes(p)));

  return {
    price: active.price,
    bookie: active.bookie,
    isPreferred: isActivePreferred,
    preferredPrice: preferredBest.price,
    preferredBookie: preferredBest.bookie,
    marketPrice: marketBest.price,
    marketBookie: marketBest.bookie,
  };
}

/**
 * Multi-sport diagnostic: onderscheidt 'edge te laag' van 'preferred bookie
 * heeft geen prijs voor deze markt'. Returnt diag-string of null (= ok).
 *
 * Voorheen rekende multi-sport een edge van -100% wanneer de preferred-pool
 * leeg was, omdat `bestFromArr` dan `{price:0}` teruggaf. Dat camoufleerde
 * een actieve markt waar bv. Pinnacle/Bovada wel prijzen hadden maar
 * Bet365/Unibet niet. Deze helper splitst die gevallen weer uit zodat de
 * scan-log de werkelijkheid weergeeft.
 *
 * @param {string} side - 'home' / 'away' / 'draw' / etc.
 * @param {object} best - output van bestFromArr (heeft preferredPrice +
 *                        marketPrice + marketBookie velden)
 * @param {number} fairProb - geprojecteerde kans (0-1)
 * @param {number} minEdge - minimum edge fractie
 * @returns {string|null}
 */
function diagBestPrice(side, best, fairProb, minEdge) {
  if (!best || typeof best !== 'object') return null;
  if (best.price > 0) {
    const edge = fairProb * best.price - 1;
    if (edge < minEdge) {
      return `${side} edge ${(edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%`;
    }
    return null;
  }
  if (best.marketPrice > 0) {
    const marketEdge = fairProb * best.marketPrice - 1;
    return `${side}: geen preferred prijs (markt: ${best.marketBookie} @ ${best.marketPrice}, market-edge ${(marketEdge * 100).toFixed(1)}%)`;
  }
  return `${side}: geen prijs in markt`;
}

function bestSpreadPick(spreads, fairProb, minEdge, minOdds = 1.60, maxOdds = 3.8, options = {}) {
  if (!spreads || !spreads.length) return null;
  const byPoint = {};
  for (const s of spreads) {
    if (!s || typeof s.price !== 'number') continue;
    if (s.price < minOdds || s.price > maxOdds) continue;
    const key = String(s.point);
    (byPoint[key] = byPoint[key] || []).push(s);
  }
  for (const pt of Object.keys(byPoint)) {
    const bookieMap = {};
    for (const s of byPoint[pt]) {
      const bk = (s.bookie || '').toLowerCase();
      if (!bookieMap[bk] || s.price < bookieMap[bk].price) bookieMap[bk] = s;
    }
    byPoint[pt] = Object.values(bookieMap);
  }
  let best = null;
  for (const [pt, pool] of Object.entries(byPoint)) {
    const top = bestFromArr(pool, options);
    if (top.price <= 0) continue;
    const fp = typeof fairProb === 'function' ? fairProb(parseFloat(pt)) : fairProb;
    if (!fp || fp <= 0) continue;
    const edge = fp * top.price - 1;
    if (edge < minEdge) continue;
    if (!best || edge > best.edge) best = { ...top, point: parseFloat(pt), edge };
  }
  return best;
}

function buildSpreadFairProbFns(homeSpr, awaySpr, fallbackHome, fallbackAway) {
  const groupBy = (arr, fn) => {
    const out = {};
    for (const s of arr || []) {
      const key = fn(s);
      (out[key] = out[key] || []).push(s);
    }
    return out;
  };
  const homeByPt = groupBy(homeSpr, s => s.point);
  const awayByPt = groupBy(awaySpr, s => s.point);
  const avgIP = arr => arr.reduce((sum, o) => sum + 1 / o.price, 0) / arr.length;

  const tryDevig = (hArr, aArr) => {
    if (!hArr?.length || !aArr?.length) return null;
    const avgH = avgIP(hArr);
    const avgA = avgIP(aArr);
    const tot = avgH + avgA;
    if (tot > 1.00 && tot < 1.15) return { home: avgH / tot, away: avgA / tot, vig: tot - 1 };
    return null;
  };

  const probMap = {};
  for (const ptStr of Object.keys(homeByPt)) {
    const pt = parseFloat(ptStr);
    const samePoint = tryDevig(homeByPt[pt], awayByPt[pt]);
    const oppPoint = tryDevig(homeByPt[pt], awayByPt[-pt]);
    let chosen;
    if (samePoint && oppPoint) chosen = samePoint.vig <= oppPoint.vig ? samePoint : oppPoint;
    else chosen = samePoint || oppPoint;
    if (chosen) probMap[pt] = chosen;
  }

  // v11.1.1: hasDevig exposed zodat caller kan checken of de fallback is
  // gebruikt (= geen cross-bookie paired devig beschikbaar bij dit point).
  // Bij extreme 1H handicap lijnen (bv. NBA -9.5 alleen op Bet365) is de
  // fallback een synthetische prob die vaak te ruim van de werkelijke markt
  // afligt. Pick-laag kan nu kiezen om die picks te rejecten i.p.v. ze op de
  // fallback te ranken.
  const bookieCountAt = pt => {
    const same = homeByPt[pt]?.length || 0;
    const opp = awayByPt[-pt]?.length || 0;
    return Math.max(same, opp);
  };
  return {
    homeFn: pt => probMap[pt]?.home ?? fallbackHome,
    awayFn: pt => probMap[pt]?.away ?? probMap[-pt]?.away ?? fallbackAway,
    hasDevig: pt => Boolean(probMap[pt] || probMap[-pt]),
    bookieCountAt,
  };
}

function bestOdds(bookmakers, marketKey, outcomeName, options = {}) {
  let best = { price: 0, bookie: '' };
  const preferred = Array.isArray(options.preferredBookiesLower) && options.preferredBookiesLower.length
    ? options.preferredBookiesLower
    : preferredBookiesLower;
  for (const bk of bookmakers) {
    if (preferred) {
      const bkName = (bk.title || bk.name || '').toLowerCase();
      if (!preferred.some(p => bkName.includes(p))) continue;
    }
    const mkt = bk.markets?.find(m => m.key === marketKey);
    const o = mkt?.outcomes?.find(outcome => outcome.name === outcomeName);
    if (o && o.price > best.price) best = { price: +o.price.toFixed(3), bookie: bk.title };
  }
  return best;
}

function bookiePrice(bookmakers, bookieFragment, marketKey, outcomeName) {
  const bk = bookmakers.find(b => b.key?.includes(bookieFragment) || b.title?.toLowerCase().includes(bookieFragment));
  const mkt = bk?.markets?.find(m => m.key === marketKey);
  return mkt?.outcomes?.find(o => o.name === outcomeName)?.price || null;
}

function convertAfOdds(afBookmakers, hm, aw) {
  return afBookmakers.map(bk => {
    const markets = [];
    const mw = bk.bets?.find(b => b.id === 1);
    if (mw) {
      markets.push({
        key: 'h2h',
        outcomes: mw.values.map(v => ({
          name: v.value === 'Home' ? hm : v.value === 'Away' ? aw : 'Draw',
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
    const ah = bk.bets?.find(b => b.id === 12 && !(b.name || '').toLowerCase().includes('draw no bet'));
    if (ah) {
      markets.push({
        key: 'spreads',
        outcomes: ah.values.map(v => {
          const m = v.value.match(/^(Home|Away)\s*([+-][\d.]+)?/i);
          if (!m) return null;
          return {
            name: m[1].toLowerCase() === 'home' ? hm : aw,
            price: parseFloat(v.odd) || 0,
            point: parseFloat(m[2] || '0'),
          };
        }).filter(o => o && o.price > 1.01),
      });
    }
    return { title: bk.name, key: bk.name?.toLowerCase().replace(/\s+/g, '_'), markets };
  }).filter(bk => bk.markets.length > 0);
}

module.exports = {
  calcWinProb,
  fairProbs,
  fairProbs2Way,
  parseGameOdds,
  setPreferredBookies,
  getPreferredBookies,
  getPreferredBookiesLower,
  bestFromArr,
  diagBestPrice,
  bestSpreadPick,
  buildSpreadFairProbFns,
  bestOdds,
  bookiePrice,
  convertAfOdds,
};
