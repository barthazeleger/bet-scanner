'use strict';

const { resolveEarlyLiveOutcome } = require('./operator-actions');

/**
 * Bepaal uitkomst (W/L/null) voor een bet op basis van een wedstrijd-event.
 *
 * Input:
 *   markt   — raw bet.markt string ("🏠 Ajax wint", "Over 2.5", "BTTS Ja", etc.)
 *   ev      — event-object uit api-sports parsing {home, away, scoreH, scoreA, live?,
 *             regScoreH?, regScoreA?, halfH?, halfA?, p1H?, p1A?, inn1H?, inn1A?}
 *   options.isLive — true = event is nog niet afgelopen; bet mag alleen settled
 *             worden via mathematisch-gegarandeerde early-close (over-line al bereikt,
 *             beide teams al gescoord voor BTTS Ja, etc.). Nooit L uit live.
 *
 * Output: { uitkomst: 'W' | 'L' | null, note: string | null }
 *   - uitkomst=null betekent: bet blijft Open. Note beschrijft waarom (markt niet
 *     herkend, wedstrijd bezig, exact push, draw-void).
 *
 * WAAROM deze gate bestaat: vóór v11.0.0 viel de settle-pipeline door naar de
 * finished-logica ook als ev.live===true. BTTS Nee op 0-0 in de 70e minuut werd
 * dan als L weggeschreven ("else L" bij bothScored=false), waarmee Open-bets op
 * nog-lopende wedstrijden onterecht werden gesloten én de learning-loop
 * (updateCalibration) gecontamineerd raakte.
 */
function resolveBetOutcome(markt, ev, options = {}) {
  if (!ev) return { uitkomst: null, note: 'Geen event' };
  const isLive = options.isLive === true;
  const rawMarkt = String(markt || '');
  const market = rawMarkt.toLowerCase();

  // LIVE-GATE: alleen mathematisch-gegarandeerde vroege afsluiting toegestaan.
  if (isLive) {
    const early = resolveEarlyLiveOutcome(rawMarkt, ev);
    if (early) return { uitkomst: early, note: 'Early-settle vanuit live-event' };
    return { uitkomst: null, note: 'Wedstrijd bezig · auto-settle overgeslagen' };
  }

  const scoreH = Number(ev.scoreH) || 0;
  const scoreA = Number(ev.scoreA) || 0;
  const total = scoreH + scoreA;
  const homeL = String(ev.home || '').toLowerCase();
  const awayL = String(ev.away || '').toLowerCase();
  const matchesTeam = (team, label) => {
    if (!team || !label) return false;
    const lastWord = team.split(' ').pop();
    return team.includes(label) || label.includes(lastWord);
  };

  // 3-weg 60-min markten (hockey/handbal regulation)
  const is60min = market.includes('60-min') || market.includes('60 min') || market.includes('🕐');
  if (is60min && ev.regScoreH != null && ev.regScoreA != null) {
    if (market.includes('gelijkspel') || market.includes('draw')) {
      return { uitkomst: ev.regScoreH === ev.regScoreA ? 'W' : 'L', note: null };
    }
    const winnerMatch = market.match(/(.+?)\s+wint/i);
    if (winnerMatch) {
      const t = winnerMatch[1].replace(/[🏠✈️🕐]/g, '').trim().toLowerCase();
      if (matchesTeam(homeL, t)) return { uitkomst: ev.regScoreH > ev.regScoreA ? 'W' : 'L', note: null };
      if (matchesTeam(awayL, t)) return { uitkomst: ev.regScoreA > ev.regScoreH ? 'W' : 'L', note: null };
    }
  }

  // NRFI / YRFI (baseball 1st inning)
  if (market.includes('nrfi') || market.includes('yrfi') ||
      market.includes('no run 1st') || market.includes('yes run 1st') ||
      market.includes('no run first') || market.includes('yes run first')) {
    if (ev.inn1H != null && ev.inn1A != null) {
      const firstInningRuns = (ev.inn1H || 0) + (ev.inn1A || 0);
      const isNRFI = market.includes('nrfi') || market.includes('no run');
      return {
        uitkomst: isNRFI ? (firstInningRuns === 0 ? 'W' : 'L') : (firstInningRuns > 0 ? 'W' : 'L'),
        note: null,
      };
    }
  }

  // 1st Half Over/Under (basketball, NFL)
  if ((market.includes('1h ') || market.includes('1st half')) &&
      (market.includes('over') || market.includes('under'))) {
    const halfTotal = (ev.halfH != null && ev.halfA != null) ? ev.halfH + ev.halfA : null;
    if (halfTotal !== null) {
      const overM = market.match(/over\s*(\d+\.?\d*)/i);
      const underM = !overM && market.match(/under\s*(\d+\.?\d*)/i);
      if (overM) {
        const line = parseFloat(overM[1]);
        return { uitkomst: halfTotal > line ? 'W' : halfTotal < line ? 'L' : null, note: halfTotal === line ? 'Exact push' : null };
      }
      if (underM) {
        const line = parseFloat(underM[1]);
        return { uitkomst: halfTotal < line ? 'W' : halfTotal > line ? 'L' : null, note: halfTotal === line ? 'Exact push' : null };
      }
    }
  }

  // 1st Half Spread (basketball, NFL)
  if ((market.includes('1h ') || market.includes('1st half')) &&
      (market.includes('spread') || market.match(/[+-]\d/))) {
    if (ev.halfH != null && ev.halfA != null) {
      const spreadM = market.match(/([+-]?\d+\.?\d*)/);
      if (spreadM) {
        const line = parseFloat(spreadM[1]);
        const isHome = market.includes(homeL.split(' ').pop());
        const diff = isHome ? (ev.halfH - ev.halfA) : (ev.halfA - ev.halfH);
        const adjusted = diff + line;
        return { uitkomst: adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : null, note: adjusted === 0 ? 'Exact push' : null };
      }
    }
  }

  // 1st Period Over/Under (hockey)
  if ((market.includes('p1 ') || market.includes('1st period')) &&
      (market.includes('over') || market.includes('under'))) {
    const p1Total = (ev.p1H != null && ev.p1A != null) ? ev.p1H + ev.p1A : null;
    if (p1Total !== null) {
      const overM = market.match(/over\s*(\d+\.?\d*)/i);
      const underM = !overM && market.match(/under\s*(\d+\.?\d*)/i);
      if (overM) {
        const line = parseFloat(overM[1]);
        return { uitkomst: p1Total > line ? 'W' : p1Total < line ? 'L' : null, note: p1Total === line ? 'Exact push' : null };
      }
      if (underM) {
        const line = parseFloat(underM[1]);
        return { uitkomst: p1Total < line ? 'W' : p1Total > line ? 'L' : null, note: p1Total === line ? 'Exact push' : null };
      }
    }
  }

  // Odd/Even total
  if (market.includes('odd total') || market.includes('even total') || market.includes('🎲')) {
    const isOdd = market.includes('odd');
    return { uitkomst: ((total % 2 === 1) === isOdd) ? 'W' : 'L', note: null };
  }

  // v12.1.0 (operator-rapport): Team Total (TT) markten. Voorheen viel dit
  // door naar Generic Over/Under die game-total (scoreH+scoreA) vergeleek met
  // line — compleet verkeerd. TBL vs MTL 3-4 met bet "TBL TT Under 3.5": TBL
  // scoorde 3, 3 < 3.5 → W. Oude code: total=7 > 3.5 → L. Settlement fout.
  //
  // Label-format: "📈 {Team} TT Over {line}" / "📉 {Team} TT Under {line}".
  // Extract team-naam voor TT-regex en zoek of het home of away is.
  const ttMatch = market.match(/(.+?)\s+tt\s+(over|under)\s+(\d+\.?\d*)/i);
  if (ttMatch) {
    const teamPart = ttMatch[1].replace(/[📈📉🏠✈️🔒]/g, '').trim().toLowerCase();
    const isOver = /over/i.test(ttMatch[2]);
    const line = parseFloat(ttMatch[3]);
    let teamScore = null;
    if (matchesTeam(homeL, teamPart)) teamScore = scoreH;
    else if (matchesTeam(awayL, teamPart)) teamScore = scoreA;
    if (teamScore != null && Number.isFinite(line)) {
      if (isOver) return { uitkomst: teamScore > line ? 'W' : teamScore < line ? 'L' : null, note: teamScore === line ? 'Exact push' : null };
      return { uitkomst: teamScore < line ? 'W' : teamScore > line ? 'L' : null, note: teamScore === line ? 'Exact push' : null };
    }
    return { uitkomst: null, note: 'TT: team niet herkend in event' };
  }

  // Generic Over
  const overM = market.match(/over\s*(\d+\.?\d*)/i);
  if (overM) {
    const line = parseFloat(overM[1]);
    return { uitkomst: total > line ? 'W' : total < line ? 'L' : null, note: total === line ? 'Exact push' : null };
  }

  // Generic Under
  const underM = market.match(/under\s*(\d+\.?\d*)/i);
  if (underM && !overM) {
    const line = parseFloat(underM[1]);
    return { uitkomst: total < line ? 'W' : total > line ? 'L' : null, note: total === line ? 'Exact push' : null };
  }

  // BTTS Ja / Yes
  if (market.includes('btts ja') || market.includes('btts yes') ||
      (market.includes('btts') && !market.includes('nee') && !market.includes('no'))) {
    return { uitkomst: (scoreH > 0 && scoreA > 0) ? 'W' : 'L', note: null };
  }
  // BTTS Nee / No
  if (market.includes('btts nee') || market.includes('btts no')) {
    return { uitkomst: (scoreH === 0 || scoreA === 0) ? 'W' : 'L', note: null };
  }

  // DNB (Draw No Bet)
  if (market.includes('dnb ') || market.includes('draw no bet')) {
    if (scoreH === scoreA) return { uitkomst: null, note: 'DNB draw = void' };
    const dnbTeam = market.replace(/.*dnb\s*/i, '').replace(/draw no bet\s*/i, '').trim().toLowerCase();
    if (matchesTeam(homeL, dnbTeam)) return { uitkomst: scoreH > scoreA ? 'W' : 'L', note: null };
    if (matchesTeam(awayL, dnbTeam)) return { uitkomst: scoreA > scoreH ? 'W' : 'L', note: null };
  }

  // Spread / handicap / run line / puck line
  const spreadMatch = market.match(/(?:spread|handicap|line)\s*[:\s]?\s*(.+?)\s*([+-]\d+\.?\d*)/i);
  if (spreadMatch) {
    const spreadTeam = spreadMatch[1].trim().toLowerCase();
    const line = parseFloat(spreadMatch[2]);
    const isHome = matchesTeam(homeL, spreadTeam);
    const isAway = matchesTeam(awayL, spreadTeam);
    if (isHome || isAway) {
      const diff = isHome ? (scoreH - scoreA) : (scoreA - scoreH);
      const adjusted = diff + line;
      return { uitkomst: adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : null, note: adjusted === 0 ? 'Exact push' : null };
    }
  }

  // Moneyline / winner
  const winnerMatch = market.match(/(?:winner|wint)[^a-z]+([\w\s]+?)(?:\s*[\|·]|$)/i)
                   || market.match(/→\s*([\w\s]+?)(?:\s*[\|·]|$)/i);
  if (winnerMatch) {
    const t = winnerMatch[1].trim().toLowerCase();
    if (matchesTeam(homeL, t)) {
      return { uitkomst: scoreH > scoreA ? 'W' : scoreH < scoreA ? 'L' : null, note: scoreH === scoreA ? 'Draw = void' : null };
    }
    if (matchesTeam(awayL, t)) {
      return { uitkomst: scoreA > scoreH ? 'W' : scoreA < scoreH ? 'L' : null, note: scoreH === scoreA ? 'Draw = void' : null };
    }
  }

  return { uitkomst: null, note: 'Markt niet herkend · update handmatig' };
}

module.exports = { resolveBetOutcome, resolveEarlyLiveOutcome };
