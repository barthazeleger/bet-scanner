'use strict';

// Pure market resolver voor CLV-checks. Testbaar zonder API.
// Input: bookmaker-object uit api-sports odds response + markt-string (zoals
// opgeslagen in bets.markt). Output: parsed odd of null.
//
// Belangrijk: strict market matching. Geen loose .includes() die Alt/Corners/
// Team totals verkeerd matcht. Check-volgorde: DNB/Draw/BTTS → before ML,
// omdat ML-vangnet ook emoji-markten (🏠/✈️) matcht.

const NON_MAIN = /alt|corner|card|booking|team total|home total|away total|1st|2nd|3rd|first half|first period|first quarter|first inning|halftime|half time|period|quarter|inning/i;

function isUnsupportedClvMarket(markt) {
  return /team\s*total|\bTT\b/i.test(String(markt || ''));
}

function supportsClvForBetMarkt(markt) {
  return !isUnsupportedClvMarket(markt);
}

function sanitizeUnsupportedClvFields(row) {
  if (!row || supportsClvForBetMarkt(row.markt)) return row;
  return {
    ...row,
    clv_pct: null,
    clvPct: null,
    clv_odds: null,
    clvOdds: null,
    sharp_clv_pct: null,
    sharpClvPct: null,
    sharp_clv_odds: null,
    sharpClvOdds: null,
  };
}

function resolveOddFromBookie(bk, markt) {
  if (!bk || !markt) return null;
  const m = String(markt).toLowerCase();
  const bets = bk.bets || [];

  // v12.1.0 (operator-rapport): Team Total markten (TT Over/Under X.X) mogen
  // NIET matchen met game-total. TT meet één team's score. Zonder deze skip
  // pakte resolver game-total Under 3.5 voor TT Under 3.5 bet → verkeerde
  // closing line (bv. 5.75 ipv 1.95) → absurde CLV -66%. TT-CLV vereist een
  // aparte snapshot-structuur die odds_snapshots nog niet heeft. Liever geen
  // CLV dan verkeerde CLV.
  const isTeamTotalMarkt = isUnsupportedClvMarket(markt);
  if (isTeamTotalMarkt) return null;

  // v10.7.22: skip bets met lege values — voorheen bleef resolver steken op
  // eerste name-match die geen data had en retourneerde null; nu probeer
  // volgende match met gevulde values.
  const findByNames = (names) => {
    const low = names.map(n => n.toLowerCase());
    return bets.find(b => low.includes(String(b.name || '').trim().toLowerCase())
      && Array.isArray(b.values) && b.values.length > 0);
  };

  let val = null;

  const ouMatch = m.match(/(over|under)\s*(\d+\.?\d*)/);
  if (ouMatch && !/1h\s|1st half|p1\s|1st period/.test(m)) {
    const side = ouMatch[1] === 'over' ? 'Over' : 'Under';
    const line = ouMatch[2];
    const ou = bets.find(b => {
      const nm = (b.name || '').toLowerCase();
      if (NON_MAIN.test(nm)) return false;
      const vals = b.values || [];
      const hasOver = vals.some(v => String(v.value || '').trim() === `Over ${line}`);
      const hasUnder = vals.some(v => String(v.value || '').trim() === `Under ${line}`);
      return hasOver && hasUnder;
    });
    if (ou) val = (ou.values || []).find(v => String(v.value || '').trim() === `${side} ${line}`);
  } else if (m.includes('60-min') || m.includes('60 min') || m.includes('🕐')) {
    const isDraw = m.includes('gelijkspel') || m.includes('draw');
    const isHome = !isDraw && (m.includes('🏠') || !m.includes('✈️'));
    const target = isDraw ? 'Draw' : isHome ? 'Home' : 'Away';
    for (const bet of bets) {
      const v3 = (bet.values || []).filter(x => ['Home','Draw','Away'].includes(String(x.value ?? '').trim()));
      if (v3.length === 3 && bet.id !== 1) {
        val = v3.find(x => String(x.value ?? '').trim() === target);
        if (val) break;
      }
    }
  } else if (m.includes('dnb') || m.includes('draw no bet')) {
    const dnb = findByNames(['Draw No Bet', 'Draw no Bet', 'DNB']);
    if (dnb) {
      const isHome = m.includes('🏠') || !m.includes('✈️');
      val = (dnb.values || []).find(v => String(v.value || '').trim() === (isHome ? 'Home' : 'Away'));
    }
  } else if (m.includes('gelijkspel') || (m.includes('draw') && !m.includes('no bet'))) {
    const mw = findByNames(['Match Winner', 'Winner', 'Match Odds', '3Way Result', 'Regular Time', 'Home/Away']);
    if (mw) val = (mw.values || []).find(v => String(v.value || '').trim() === 'Draw');
  } else if (m.includes('btts') || m.includes('beide') || (m.includes(' both ') && m.includes('score'))) {
    const btts = findByNames(['Both Teams Score', 'Both Teams To Score', 'Both Teams to Score', 'BTTS', 'Both Teams To Score – Yes/No']);
    if (btts) {
      const isNo = m.includes('nee') || /\bno\b/.test(m) || m.includes('🛡️');
      val = (btts.values || []).find(v => String(v.value || '').trim() === (isNo ? 'No' : 'Yes'));
    }
  } else if (m.includes('nrfi') || m.includes('yrfi') || m.includes('no run first') || m.includes('no run 1st') || m.includes('yes run first') || m.includes('yes run 1st')) {
    const nrfi = bets.find(b => {
      const n = (b.name || '').toLowerCase();
      return n.includes('1st inning') || n.includes('nrfi') || n.includes('run in 1st') || n.includes('first inning');
    });
    if (nrfi) {
      const isNRFI = m.includes('nrfi') || m.includes('no run');
      val = (nrfi.values || []).find(v => String(v.value || '').trim() === (isNRFI ? 'No' : 'Yes')) || (nrfi.values || [])[0];
    }
  } else if ((m.includes('1h ') || m.includes('1st half') || m.includes('p1 ') || m.includes('1st period')) && (m.includes('over') || m.includes('under'))) {
    const isOver = m.includes('over');
    const lineMatch = m.match(/(?:over|under)\s*(\d+\.?\d*)/i);
    const halfBet = bets.find(b => {
      const bn = (b.name||'').toLowerCase();
      return (bn.includes('1st half') || bn.includes('first half') || bn.includes('1st period') || bn.includes('first period')) && (bn.includes('over') || bn.includes('total'));
    });
    if (halfBet && lineMatch) {
      val = (halfBet.values || []).find(v => String(v.value||'').trim() === `${isOver ? 'Over' : 'Under'} ${lineMatch[1]}`);
    }
  } else if ((m.includes('1h ') || m.includes('1st half') || m.includes('p1 ') || m.includes('1st period')) && (m.includes('spread') || m.match(/[+-]\d/))) {
    const halfSpBet = bets.find(b => {
      const bn = (b.name||'').toLowerCase();
      return (bn.includes('1st half') || bn.includes('first half') || bn.includes('1st period') || bn.includes('first period')) && (bn.includes('spread') || bn.includes('handicap'));
    });
    if (halfSpBet) {
      const lineMatch = m.match(/([+-]?\d+\.?\d*)/);
      if (lineMatch) val = (halfSpBet.values || []).find(v => String(v.value||'').includes(lineMatch[1]));
    }
  } else if (m.includes('odd total') || m.includes('even total') || m.includes('odd/even') || m.includes('🎲')) {
    const oeBet = bets.find(b => {
      const bn = (b.name||'').toLowerCase();
      return bn.includes('odd') && bn.includes('even');
    });
    if (oeBet) {
      const isOdd = m.includes('odd');
      val = (oeBet.values || []).find(v => String(v.value||'').toLowerCase() === (isOdd ? 'odd' : 'even'));
    }
  } else if (m.includes('spread') || m.includes('handicap') || m.includes('run line') || m.includes('puck line')) {
    const sp = bets.find(b => {
      const n = (b.name || '').toLowerCase();
      if (NON_MAIN.test(n)) return false;
      return n.includes('spread') || n.includes('handicap') || n.includes('run line') || n.includes('puck line') || n === 'asian handicap';
    });
    if (sp) {
      const lineMatch = m.match(/([+-]?\d+\.?\d*)/);
      if (lineMatch) {
        val = (sp.values || []).find(v => String(v.value || '').includes(lineMatch[1]));
      }
    }
  } else if (m.includes('wint') || m.includes('winner') || m.includes('moneyline') || m.includes('🏠') || m.includes('✈️')) {
    // v10.10.13: strict ML matching. Voorheen pakte findByNames de eerste bet
    // die 'Home/Away' heette, ook als dat feitelijk een handicap-bet was met
    // values ['Home +1', 'Away -1']. Bij MLB Detroit Tigers gaf dat 1.74
    // (de +1 handicap) ipv de echte ML 2.00. Fix: skip bets met handicap-
    // syntax in de values, skip NON_MAIN markten, eis 2-3 outcomes.
    const mlNames = ['match winner', 'home/away', 'winner', 'match odds', '3way result', 'regular time', 'moneyline', 'money line'];
    const mlCandidates = bets.filter(b => {
      const n = String(b.name || '').trim().toLowerCase();
      if (!mlNames.includes(n)) return false;
      if (NON_MAIN.test(n)) return false;
      if (!Array.isArray(b.values) || b.values.length === 0) return false;
      // Reject als één van de values een handicap-prefix heeft ('Home +1.5', '+1', etc).
      const hasHandicapValue = b.values.some(v => /[+\-]\s*\d/.test(String(v.value || '')));
      if (hasHandicapValue) return false;
      // ML heeft typisch 2 (Home/Away) of 3 (Home/Draw/Away) outcomes.
      if (b.values.length > 3) return false;
      return true;
    });
    const mw = mlCandidates[0] || null;
    if (mw) {
      const isHome = m.includes('🏠') || !m.includes('✈️');
      val = (mw.values || []).find(v => {
        const s = String(v.value || '').trim();
        return s === (isHome ? 'Home' : 'Away') || s === (isHome ? '1' : '2');
      });
    }
  }

  return val ? parseFloat(val.odd) || null : null;
}

// v10.10.21: markt-string → canonical snapshot-key mapping voor Pinnacle
// closing line lookup in odds_snapshots. Dekt de grote meerderheid van picks
// (ML, totals, BTTS, NRFI, 3-way). Exotische markten returnen null (graceful skip).
function marketKeyFromBetMarkt(markt) {
  if (!markt) return null;
  const m = String(markt).toLowerCase();
  // v12.1.0: Team Total markten krijgen aparte market_type. Voorheen matchte
  // TT "Under 3.5" tegen game-total key → verkeerde closing-line lookup in
  // odds_snapshots → absurde CLV-waarden. Return null tot odds_snapshots een
  // 'team_total' key ondersteunt (nu nog niet). Liever geen CLV dan foute CLV.
  if (isUnsupportedClvMarket(markt)) return null;
  if (m.includes('btts') || m.includes('beide') || (m.includes('both') && m.includes('score'))) {
    return { market_type: 'btts', selection_key: (m.includes('nee') || /\bno\b/.test(m)) ? 'no' : 'yes' };
  }
  if (/over\s*(\d+\.?\d*)/.test(m) && !m.includes('1h') && !m.includes('1st') && !m.includes('f5')) {
    const lineMatch = m.match(/over\s*(\d+\.?\d*)/);
    return { market_type: 'total', selection_key: 'over', line: lineMatch ? parseFloat(lineMatch[1]) : null };
  }
  if (/under\s*(\d+\.?\d*)/.test(m) && !m.includes('1h') && !m.includes('1st') && !m.includes('f5')) {
    const lineMatch = m.match(/under\s*(\d+\.?\d*)/);
    return { market_type: 'total', selection_key: 'under', line: lineMatch ? parseFloat(lineMatch[1]) : null };
  }
  if (m.includes('60-min') || m.includes('60 min') || m.includes('🕐')) {
    if (m.includes('gelijkspel') || m.includes('draw')) return { market_type: 'threeway', selection_key: 'draw' };
    return { market_type: 'threeway', selection_key: m.includes('✈️') ? 'away' : 'home' };
  }
  if (m.includes('nrfi') || m.includes('no run')) return { market_type: 'nrfi', selection_key: 'no' };
  if (m.includes('yrfi') || m.includes('yes run')) return { market_type: 'nrfi', selection_key: 'yes' };
  if (m.includes('f5 ') && (m.includes('over') || m.includes('under'))) {
    const lineMatch = m.match(/(?:over|under)\s*(\d+\.?\d*)/);
    return { market_type: 'f5_total', selection_key: m.includes('over') ? 'over' : 'under', line: lineMatch ? parseFloat(lineMatch[1]) : null };
  }
  if (m.includes('f5 ')) {
    // F5 ML labels zijn "⚾ F5 TeamName" zonder 🏠/✈️. Home/away is niet
    // afleidbaar uit de markt-string alleen → return null. Liever geen
    // sharp-CLV dan foute sharp-CLV (Codex-blocker v10.10.21 review).
    return null;
  }
  if (m.includes('wint') || m.includes('winner') || m.includes('moneyline') || m.includes('🏠') || m.includes('✈️')) {
    return { market_type: 'moneyline', selection_key: m.includes('✈️') ? 'away' : 'home' };
  }
  return null;
}

module.exports = {
  resolveOddFromBookie,
  marketKeyFromBetMarkt,
  supportsClvForBetMarkt,
  sanitizeUnsupportedClvFields,
};
