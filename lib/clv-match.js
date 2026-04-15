'use strict';

// Pure market resolver voor CLV-checks. Testbaar zonder API.
// Input: bookmaker-object uit api-sports odds response + markt-string (zoals
// opgeslagen in bets.markt). Output: parsed odd of null.
//
// Belangrijk: strict market matching. Geen loose .includes() die Alt/Corners/
// Team totals verkeerd matcht. Check-volgorde: DNB/Draw/BTTS → before ML,
// omdat ML-vangnet ook emoji-markten (🏠/✈️) matcht.

const NON_MAIN = /alt|corner|card|booking|team total|home total|away total|1st|2nd|3rd|first half|first period|first quarter|first inning|halftime|half time|period|quarter|inning/i;

function resolveOddFromBookie(bk, markt) {
  if (!bk || !markt) return null;
  const m = String(markt).toLowerCase();
  const bets = bk.bets || [];

  const findByNames = (names) => {
    const low = names.map(n => n.toLowerCase());
    return bets.find(b => low.includes(String(b.name || '').trim().toLowerCase()));
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
    const mw = findByNames(['Match Winner', 'Home/Away', 'Winner', 'Match Odds', '3Way Result', 'Regular Time', 'Moneyline', 'Money Line']);
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

module.exports = { resolveOddFromBookie };
