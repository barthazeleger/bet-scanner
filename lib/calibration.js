'use strict';

const fs   = require('fs');
const path = require('path');
const { supabase, UNIT_EUR, START_BANKROLL, epBucketKey, DEFAULT_EPW } = require('./config');
const { tg } = require('./telegram');
const { readBets, getUsersCache } = require('./db');

// ── CALIBRATIE ────────────────────────────────────────────────────────────────
const DEFAULT_CALIB = { version:1, lastUpdated:null, totalSettled:0, totalWins:0, totalProfit:0,
  markets:{ home:{n:0,w:0,profit:0,multiplier:1.0}, away:{n:0,w:0,profit:0,multiplier:1.0},
            draw:{n:0,w:0,profit:0,multiplier:1.0}, over:{n:0,w:0,profit:0,multiplier:1.0},
            under:{n:0,w:0,profit:0,multiplier:1.0}, other:{n:0,w:0,profit:0,multiplier:1.0} },
  epBuckets: {}, leagues:{}, lossLog:[] };

let _calibCache = null;
let _calibCacheAt = 0;
const CALIB_TTL = 10 * 1000; // 10 sec cache

function loadCalib() {
  if (_calibCache) return _calibCache;
  try { _calibCache = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'calibration.json'), 'utf8')); return _calibCache; }
  catch { return { ...DEFAULT_CALIB }; }
}

async function loadCalibAsync() {
  if (_calibCache && Date.now() - _calibCacheAt < CALIB_TTL) return _calibCache;
  try {
    const { data, error } = await supabase.from('calibration').select('data').eq('id', 1).single();
    if (!error && data?.data) {
      _calibCache = data.data;
      _calibCacheAt = Date.now();
      return _calibCache;
    }
  } catch {}
  return loadCalib();
}

async function saveCalib(c) {
  _calibCache = c;
  _calibCacheAt = Date.now();
  try {
    await supabase.from('calibration').upsert({ id: 1, data: c, updated_at: new Date().toISOString() });
  } catch (e) { console.error('saveCalib error:', e.message); }
}

function detectMarket(markt = '') {
  const m = markt.toLowerCase();
  if (m.includes('wint') || m.includes('winner') || m.includes('home') || m.includes('thuis')) {
    if (m.includes('✈️') || m.includes('away') || m.includes('uit') || m.match(/→.*away/)) return 'away';
    return 'home';
  }
  if (m.includes('gelijkspel') || m.includes('draw') || m.includes('x2') || m.includes('1x')) return 'draw';
  if (m.includes('over') || m.includes('>')) return 'over';
  if (m.includes('under') || m.includes('<')) return 'under';
  return 'other';
}

function updateCalibration(bet, userId = null) {
  if (!bet || !['W','L'].includes(bet.uitkomst)) return;
  if (userId) {
    const users = getUsersCache() || [];
    const user = users.find(u => u.id === userId);
    if (user && user.role !== 'admin') return;
  }
  const c    = loadCalib();
  const mKey = `${bet.sport || 'football'}_${detectMarket(bet.markt || '')}`;
  const lg   = bet.wedstrijd?.split(' vs ')?.[0] ? (bet.league || 'Unknown') : 'Unknown';
  const won  = bet.uitkomst === 'W';
  const pnl  = parseFloat(bet.wl) || 0;

  c.totalSettled++; if (won) c.totalWins++; c.totalProfit += pnl;

  const mk = c.markets[mKey] || { n:0, w:0, profit:0, multiplier:1.0 };
  mk.n++; if (won) mk.w++; mk.profit += pnl;

  const oldMult = mk.multiplier;
  if (mk.n >= 8) {
    const wr = mk.w / mk.n;
    const profitPerBet = mk.profit / mk.n;
    if (profitPerBet < -3 && wr < 0.40) mk.multiplier = Math.max(0.55, mk.multiplier - 0.05);
    else if (profitPerBet > 3 && wr > 0.55) mk.multiplier = Math.min(1.30, mk.multiplier + 0.03);
    else mk.multiplier = Math.max(0.70, Math.min(1.20, 0.70 + wr * 1.0));
  }
  c.markets[mKey] = mk;

  const multDelta = Math.abs(mk.multiplier - oldMult);
  if (mk.n >= 8 && multDelta >= 0.04) {
    const dir    = mk.multiplier > oldMult ? '↑ vertrouwen omhoog' : '↓ drempel verhoogd';
    const wr     = mk.w / mk.n;
    const entry  = {
      date:    new Date().toISOString(),
      type:    'market_calibration',
      market:  mKey,
      oldMult: +oldMult.toFixed(3),
      newMult: +mk.multiplier.toFixed(3),
      n:       mk.n,
      winRate: +(wr * 100).toFixed(1),
      note:    `${mKey} · ${dir} (${wr*100 < 50 ? '' : '+'}${((wr-0.5)*100).toFixed(0)}% winrate, ${mk.n} bets)`,
    };
    c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
    c.modelLastUpdated = entry.date;
    tg(`🧠 MODEL UPDATE\n📊 ${mKey} multiplier: ${oldMult.toFixed(2)} → ${mk.multiplier.toFixed(2)}\n📈 Win rate: ${(wr*100).toFixed(0)}% (${mk.n} bets)\n${dir}`).catch(() => {});
  }

  const epEst = bet.ep ? parseFloat(bet.ep) : (bet.prob ? parseFloat(bet.prob) / 100 : null);
  if (epEst && epEst >= 0.28) {
    const bk = epBucketKey(epEst);
    if (!c.epBuckets) c.epBuckets = {};
    if (!c.epBuckets[bk]) c.epBuckets[bk] = { n:0, w:0, weight: DEFAULT_EPW[bk] };
    const eb = c.epBuckets[bk];
    eb.n++; if (won) eb.w++;

    if (c.totalSettled >= 100 && eb.n >= 15) {
      const actualWr  = eb.w / eb.n;
      const expectedWr = parseFloat(bk);
      const ratio     = actualWr / Math.max(expectedWr, 0.01);
      const oldW      = eb.weight;
      const rawNew    = oldW * (0.85 + ratio * 0.15);
      eb.weight       = Math.max(0.50, Math.min(1.60, +rawNew.toFixed(3)));

      if (Math.abs(eb.weight - oldW) >= 0.05) {
        const dir = eb.weight > oldW ? '↑' : '↓';
        const entry = {
          date:    new Date().toISOString(),
          type:    'ep_calibration',
          market:  `epW bucket ${bk}`,
          oldMult: +oldW.toFixed(3),
          newMult: +eb.weight.toFixed(3),
          n:       eb.n,
          winRate: +(actualWr*100).toFixed(1),
          note:    `epW [${bk}+] ${dir} bijgesteld · werkelijke hitrate ${(actualWr*100).toFixed(0)}% vs verwacht ${(expectedWr*100).toFixed(0)}% (${eb.n} bets)`,
        };
        c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
        c.modelLastUpdated = entry.date;
        tg(`🧠 MODEL UPDATE\n🎯 EP bucket [${bk}+] gewicht: ${oldW.toFixed(2)} → ${eb.weight.toFixed(2)}\n📈 Hit rate: ${(actualWr*100).toFixed(0)}% vs verwacht ${(expectedWr*100).toFixed(0)}% (${eb.n} bets)`).catch(() => {});
      }
    }
    c.epBuckets[bk] = eb;
  }

  if (!c.leagues[lg]) c.leagues[lg] = { n:0, w:0, profit:0 };
  c.leagues[lg].n++; if (won) c.leagues[lg].w++;
  c.leagues[lg].profit += pnl;

  if (!won) {
    c.lossLog = [
      { date: bet.datum, match: bet.wedstrijd, markt: bet.markt, odds: bet.odds,
        market: mKey, reason: '—', pnl },
      ...(c.lossLog || [])
    ].slice(0, 50);
  }

  c.lastUpdated = new Date().toISOString();

  const milestones = [10, 25, 50, 100, 200];
  if (milestones.includes(c.totalSettled)) {
    const roi = c.totalProfit / Math.max(1, c.totalSettled * UNIT_EUR) * 100;
    const wr = c.totalWins / c.totalSettled * 100;
    const entry = {
      date: new Date().toISOString(), type: 'milestone',
      note: `🏆 ${c.totalSettled} bets milestone! Win rate: ${wr.toFixed(0)}% · ROI: ${roi.toFixed(1)}% · P/L: €${c.totalProfit.toFixed(2)}`
    };
    c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
    let msg = `🏆 MILESTONE: ${c.totalSettled} BETS\n📊 Win rate: ${wr.toFixed(0)}%\n💰 ROI: ${roi.toFixed(1)}%\n💵 P/L: €${c.totalProfit.toFixed(2)}`;
    if (c.totalSettled === 50 && roi > 10) {
      msg += `\n\n✅ ROI > 10% na 50 bets · overweeg unit verhoging naar €20`;
    } else if (c.totalSettled === 50 && roi < 0) {
      msg += `\n\n⚠️ Negatieve ROI · model review aanbevolen. Check signal attribution.`;
    }
    tg(msg).catch(() => {});
  }

  saveCalib(c);
  return c;
}

// ── SIGNAL AUTO-TUNING ───────────────────────────────────────────────────────
let _signalWeightsCache = null;

function loadSignalWeights() {
  return _signalWeightsCache || {};
}

async function loadSignalWeightsAsync() {
  try {
    const { data, error } = await supabase.from('signal_weights').select('weights').eq('id', 1).single();
    if (!error && data?.weights) {
      _signalWeightsCache = data.weights;
      return _signalWeightsCache;
    }
  } catch {}
  return loadSignalWeights();
}

async function saveSignalWeights(w) {
  _signalWeightsCache = w;
  try {
    await supabase.from('signal_weights').upsert({ id: 1, weights: w, updated_at: new Date().toISOString() });
  } catch (e) { console.error('saveSignalWeights error:', e.message); }
}

async function autoTuneSignals() {
  try {
    const adminUser = (getUsersCache() || []).find(u => u.role === 'admin');
    const { bets } = await readBets(adminUser?.id || null);
    const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    if (settled.length < 20) return;

    const signalStats = {};
    for (const b of settled) {
      let sigs;
      try { sigs = JSON.parse(b.signals || '[]'); } catch { continue; }
      if (!Array.isArray(sigs)) continue;
      for (const sig of sigs) {
        const name = sig.split(':')[0];
        if (!name) continue;
        if (!signalStats[name]) signalStats[name] = { n: 0, w: 0 };
        signalStats[name].n++;
        if (b.uitkomst === 'W') signalStats[name].w++;
      }
    }

    const weights = loadSignalWeights();
    const c = loadCalib();
    let changed = false;

    for (const [name, stats] of Object.entries(signalStats)) {
      if (stats.n < 15) continue;
      const hitRate = stats.w / stats.n;
      const old = weights[name] || 1.0;

      let newW = old;
      if (hitRate > 0.55) newW = Math.min(1.5, old * 1.05);
      else if (hitRate < 0.40) newW = Math.max(0.3, old * 0.92);
      else newW = old * 0.98 + 0.02;

      if (Math.abs(newW - old) >= 0.03) {
        weights[name] = +newW.toFixed(3);
        changed = true;
        const dir = newW > old ? '↑ verhoogd' : '↓ verlaagd';
        const entry = {
          date: new Date().toISOString(), type: 'signal_tuning',
          note: `Signal "${name}" ${dir}: ${old.toFixed(2)} → ${newW.toFixed(2)} (${(hitRate*100).toFixed(0)}% hit rate, ${stats.n} bets)`
        };
        c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
        c.modelLastUpdated = entry.date;
        tg(`🧠 SIGNAL TUNING\n🔧 "${name}" gewicht: ${old.toFixed(2)} → ${newW.toFixed(2)}\n📈 Hit rate: ${(hitRate*100).toFixed(0)}% (${stats.n} bets)\n${dir}`).catch(() => {});
      }
    }

    if (changed) {
      saveSignalWeights(weights);
      saveCalib(c);
    }
  } catch (e) { console.error('autoTuneSignals fout:', e.message); }
}

// ── DRAWDOWN PROTECTION ──────────────────────────────────────────────────────
function getDrawdownMultiplier() {
  const c = loadCalib();
  const losses = c.lossLog || [];
  if (c.totalSettled < 5) return 1.0;

  try {
    const totalWr = c.totalSettled > 0 ? c.totalWins / c.totalSettled : 0.5;
    const recentProfit = c.totalProfit || 0;

    if (recentProfit < -(START_BANKROLL * 0.20)) {
      console.log('⚠️ Drawdown protection: stakes gehalveerd (>20% loss)');
      tg(`🛡️ DRAWDOWN PROTECTION\nStakes gehalveerd · bankroll >20% onder start.\nHuidige P/L: €${recentProfit.toFixed(2)}`).catch(() => {});
      return 0.5;
    }
    if (c.totalSettled >= 10 && totalWr < 0.30) {
      console.log('⚠️ Drawdown protection: stakes -30% (win rate < 30%)');
      return 0.7;
    }
    if (losses.length >= 5 && c.totalSettled >= 8) {
      const last5 = losses.slice(0, 5);
      const recentDates = last5.map(l => l.date).filter(Boolean);
      if (recentDates.length >= 5) {
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10);
        const allRecent = recentDates.every(d => d >= threeDaysAgo);
        if (allRecent) {
          console.log('⚠️ Drawdown protection: stakes -40% (5 verliezen in 3 dagen)');
          return 0.6;
        }
      }
    }
  } catch {}
  return 1.0;
}

// ── PORTFOLIO ANALYSE ─────────────────────────────────────────────────────────
async function runPortfolioAnalysis() {
  const c    = loadCalib();
  const { stats: s } = await readBets();
  if (c.totalSettled < 5) return;

  const roi      = s.roi ?? 0;
  const bankroll = s.bankroll ?? START_BANKROLL;
  const profit   = bankroll - START_BANKROLL;
  const lines    = [];

  lines.push(`📊 PORTFOLIO ANALYSE · ${new Date().toLocaleDateString('nl-NL')}`);
  lines.push(`Settled: ${c.totalSettled} bets | W/L: ${c.totalWins}/${c.totalSettled - c.totalWins} | ROI: ${(roi*100).toFixed(1)}%`);
  lines.push(`Bankroll: €${bankroll} (${profit >= 0 ? '+' : ''}€${profit.toFixed(2)} t.o.v. start)`);
  lines.push('');

  lines.push('📈 Markt performance:');
  for (const [mk, v] of Object.entries(c.markets)) {
    if (v.n < 3) continue;
    const wr = Math.round(v.w / v.n * 100);
    const status = v.multiplier < 0.8 ? '⚠️' : v.multiplier > 1.1 ? '✅' : '➡️';
    lines.push(`  ${status} ${mk}: ${v.w}/${v.n} (${wr}%) | €${v.profit.toFixed(1)} | model×${v.multiplier.toFixed(2)}`);
  }
  lines.push('');

  if (c.lossLog?.length >= 3) {
    const byMarket = {};
    for (const l of c.lossLog) {
      byMarket[l.market] = (byMarket[l.market] || 0) + 1;
    }
    const worst = Object.entries(byMarket).sort((a,b) => b[1]-a[1])[0];
    if (worst?.[1] >= 3) {
      lines.push(`⚠️ Verliespatroon: ${worst[1]}x verlies in "${worst[0]}" picks · model drempel verhoogd`);
    }
  }
  lines.push('');

  lines.push('🔧 API status & aanbevelingen:');
  lines.push(`✅ api-football.com Pro: actief (7500 req/dag)`);

  if (c.totalSettled >= 30 && roi > 0.10) {
    lines.push(`🚀 UPGRADE AANBEVOLEN: ROI ${(roi*100).toFixed(1)}% over ${c.totalSettled} bets · api-sports All Sports ($99/mnd) rechtvaardigt zich`);
  } else if (c.totalSettled >= 20 && roi > 0.05) {
    lines.push(`💡 Winstgevend (ROI ${(roi*100).toFixed(1)}%) · wacht tot 30+ bets voor All Sports upgrade`);
  } else if (c.totalSettled < 20) {
    lines.push(`⏳ Nog ${20 - c.totalSettled} settled bets nodig voor upgrade-aanbeveling`);
  }

  const bankrollGrowth = bankroll - START_BANKROLL;
  const currentUnit = UNIT_EUR;
  if (bankrollGrowth >= START_BANKROLL) {
    lines.push(`💰 UNIT VERHOGING: Bankroll +100% (€${bankroll.toFixed(0)}) → overweeg unit van €${currentUnit} naar €${currentUnit*2}`);
  } else if (bankrollGrowth >= START_BANKROLL * 0.5) {
    lines.push(`💰 Unit verhoging mogelijk: Bankroll +50% (€${bankroll.toFixed(0)}) → overweeg €${currentUnit} → €${Math.round(currentUnit*1.5)}`);
  }

  await tg(lines.join('\n')).catch(() => {});

  const inboxEntries = [];
  if (c.totalSettled >= 10) {
    inboxEntries.push({
      date: new Date().toISOString(), type: 'performance',
      note: `Portfolio: ${c.totalSettled} bets · ROI ${(roi*100).toFixed(1)}% · W/L ${c.totalWins}/${c.totalSettled-c.totalWins} · P/L €${profit.toFixed(2)}`
    });
  }
  if (bankrollGrowth >= START_BANKROLL) {
    inboxEntries.push({
      date: new Date().toISOString(), type: 'upgrade_advice',
      note: `💰 Bankroll +100% (€${bankroll.toFixed(0)}) · unit verhoging naar €${currentUnit*2} aanbevolen`
    });
  } else if (bankrollGrowth >= START_BANKROLL * 0.5) {
    inboxEntries.push({
      date: new Date().toISOString(), type: 'upgrade_advice',
      note: `💰 Bankroll +50% (€${bankroll.toFixed(0)}) · overweeg unit van €${currentUnit} naar €${Math.round(currentUnit*1.5)}`
    });
  }
  if (c.totalSettled >= 30 && roi > 0.10) {
    inboxEntries.push({
      date: new Date().toISOString(), type: 'recommendation',
      note: `ROI ${(roi*100).toFixed(1)}% na ${c.totalSettled} bets · overwegen: unit verhoging, of api-sports All Sports upgrade`
    });
  }
  if (s.clvTotal >= 5) {
    const clvMsg = s.avgCLV > 0
      ? `CLV gemiddeld +${s.avgCLV.toFixed(1)}% · je pakt betere odds dan de markt bij aftrap. Dit is bewijs van edge.`
      : `CLV gemiddeld ${s.avgCLV.toFixed(1)}% · je odds zijn slechter dan de slotlijn. Probeer eerder te loggen.`;
    inboxEntries.push({ date: new Date().toISOString(), type: 'clv_insight', note: clvMsg });
  }
  if (s.clvTotal >= 10) {
    const { bets } = await readBets();
    const early = bets.filter(b => b.clvPct > 0 && b.clvPct != null);
    const late = bets.filter(b => b.clvPct < 0 && b.clvPct != null);
    if (early.length > late.length * 1.5) {
      inboxEntries.push({ date: new Date().toISOString(), type: 'timing_insight',
        note: `${early.length} van ${early.length+late.length} bets met CLV data verslaan de closing line · je timing is goed.` });
    } else if (late.length > early.length * 1.5) {
      inboxEntries.push({ date: new Date().toISOString(), type: 'timing_insight',
        note: `Maar ${early.length} van ${early.length+late.length} bets verslaan de closing line · overweeg bets eerder te plaatsen.` });
    }
  }
  if (c.lossLog?.length >= 5) {
    const byMarket = {};
    for (const l of c.lossLog.slice(0, 10)) byMarket[l.market] = (byMarket[l.market]||0) + 1;
    const worst = Object.entries(byMarket).sort((a,b) => b[1]-a[1])[0];
    if (worst?.[1] >= 4) {
      inboxEntries.push({ date: new Date().toISOString(), type: 'insight',
        note: `⚠️ Verliespatroon: ${worst[1]}x verlies in "${worst[0]}" picks uit laatste 10. Model drempel is automatisch verhoogd.` });
    }
  }
  if (inboxEntries.length) {
    c.modelLog = [...inboxEntries, ...(c.modelLog || [])].slice(0, 50);
    c.modelLastUpdated = new Date().toISOString();
    saveCalib(c);
  }
}

// updateBetOutcome needs calibration, so it lives here
async function updateBetOutcome(id, uitkomst, userId = null) {
  const { supabase, UNIT_EUR } = require('./config');
  let query = supabase.from('bets').select('*').eq('bet_id', id);
  if (userId) query = query.eq('user_id', userId);
  const { data: row } = await query.single();
  if (!row) return;
  const odds = row.odds || 0;
  const units = row.units || 0;
  const inzet = row.inzet || +(units * UNIT_EUR).toFixed(2);
  const wl = uitkomst === 'W' ? +((odds-1)*inzet).toFixed(2) : uitkomst === 'L' ? -inzet : 0;
  let updateQuery = supabase.from('bets').update({ uitkomst, wl }).eq('bet_id', id);
  if (userId) updateQuery = updateQuery.eq('user_id', userId);
  await updateQuery;
  updateCalibration({ datum: row.datum, wedstrijd: row.wedstrijd, markt: row.markt,
                      odds, units, uitkomst, wl });
}

module.exports = {
  DEFAULT_CALIB, loadCalib, loadCalibAsync, saveCalib,
  detectMarket, updateCalibration, updateBetOutcome,
  loadSignalWeights, loadSignalWeightsAsync, saveSignalWeights, autoTuneSignals,
  getDrawdownMultiplier, runPortfolioAnalysis,
};
