'use strict';

const { supabase, UNIT_EUR, START_BANKROLL } = require('./config');

// ── USER MANAGEMENT (Supabase "users" table) ────────────────────────────────
let _usersCache     = null;
let _usersCacheAt   = 0;
const USERS_TTL     = 30 * 1000; // 30 sec cache

function defaultSettings() {
  return {
    startBankroll: START_BANKROLL,
    unitEur:       UNIT_EUR,
    language:      'nl',
    timezone:      'Europe/Amsterdam',
    scanTimes:     ['07:30'],
    scanEnabled:   true,
    twoFactorEnabled: false,
    preferredBookies: ['Bet365', 'Unibet'],
  };
}

async function loadUsers(force = false) {
  if (!force && _usersCache && Date.now() - _usersCacheAt < USERS_TTL) return _usersCache;
  try {
    const { data, error } = await supabase.from('users').select('*');
    if (error) throw new Error(error.message);
    _usersCache = (data || []).map(r => ({
      id: r.id, email: (r.email || '').toLowerCase(), passwordHash: r.password_hash || '',
      role: r.role || 'user', status: r.status || 'pending',
      settings: (() => { try { return { ...defaultSettings(), ...(typeof r.settings === 'string' ? JSON.parse(r.settings) : (r.settings || {})) }; } catch { return defaultSettings(); } })(),
      createdAt: r.created_at || ''
    }));
    _usersCacheAt = Date.now();
    return _usersCache;
  } catch { return _usersCache || []; }
}

async function saveUser(user) {
  const { error } = await supabase.from('users').upsert({
    id: user.id, email: user.email, password_hash: user.passwordHash,
    role: user.role, status: user.status,
    settings: user.settings || defaultSettings(),
    created_at: user.createdAt || new Date().toISOString()
  }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
  _usersCache = null;
}

function getUsersCache() { return _usersCache; }
function clearUsersCache() { _usersCache = null; }

async function getUserMoneySettings(userId) {
  if (!userId) return { startBankroll: START_BANKROLL, unitEur: UNIT_EUR };
  try {
    const users = await loadUsers();
    const settings = users.find(u => u.id === userId)?.settings || {};
    const startBankrollRaw = parseFloat(settings.startBankroll);
    const unitEurRaw = parseFloat(settings.unitEur);
    return {
      startBankroll: isFinite(startBankrollRaw) && startBankrollRaw > 0 ? startBankrollRaw : START_BANKROLL,
      unitEur: isFinite(unitEurRaw) && unitEurRaw > 0 ? unitEurRaw : UNIT_EUR,
    };
  } catch {
    return { startBankroll: START_BANKROLL, unitEur: UNIT_EUR };
  }
}

// ── BET TRACKER ──────────────────────────────────────────────────────────────

function calcStats(bets, startBankroll = START_BANKROLL, unitEur = UNIT_EUR) {
  const W     = bets.filter(b => b.uitkomst === 'W').length;
  const L     = bets.filter(b => b.uitkomst === 'L').length;
  const open  = bets.filter(b => b.uitkomst === 'Open').length;
  const total = bets.length;
  const wlEur = bets.reduce((s, b) => s + (b.uitkomst !== 'Open' ? b.wl : 0), 0);
  const totalInzet = bets.filter(b => b.uitkomst !== 'Open').reduce((s, b) => s + b.inzet, 0);
  const roi   = totalInzet > 0 ? wlEur / totalInzet : 0;
  const openInzet = bets.filter(b => b.uitkomst === 'Open').reduce((s, b) => s + (b.inzet || 0), 0);
  const bankroll  = +(startBankroll + wlEur).toFixed(2);
  const avgOdds   = total > 0 ? +(bets.reduce((s,b)=>s+b.odds,0)/total).toFixed(3) : 0;
  const avgUnits  = total > 0 ? +(bets.reduce((s,b)=>s+b.units,0)/total).toFixed(2) : 0;
  const strikeRate = (W+L) > 0 ? Math.round(W/(W+L)*100) : 0;
  // Per-bet unit_at_time (v10.10.7) — fallback huidige unitEur voor legacy rows.
  const unitFor = (b) => {
    const ue = b && b.unitAtTime;
    return Number.isFinite(ue) && ue > 0 ? ue : unitEur;
  };
  const winU  = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>{ const ue = unitFor(b); return ue > 0 ? s + (b.wl/ue) : s; },0).toFixed(2);
  const lossU = +bets.filter(b=>b.uitkomst==='L').reduce((s,b)=>{ const ue = unitFor(b); return ue > 0 ? s + (b.wl/ue) : s; },0).toFixed(2);
  // CLV stats
  const clvBets = bets.filter(b => b.clvPct !== null && b.clvPct !== undefined && !isNaN(b.clvPct));
  const avgCLV = clvBets.length > 0 ? +(clvBets.reduce((s, b) => s + b.clvPct, 0) / clvBets.length).toFixed(2) : 0;
  const clvPositive = clvBets.filter(b => b.clvPct > 0).length;
  const clvTotal = clvBets.length;

  // Variance tracker
  const settledBets = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
  const expectedWins = +settledBets.reduce((s, b) => {
    const prob = b.odds > 1 ? 1 / b.odds : 0.5;
    return s + prob;
  }, 0).toFixed(2);
  const actualWins = W;
  const variance = +(actualWins - expectedWins).toFixed(2);
  const varianceStdDev = +Math.sqrt(settledBets.reduce((s, b) => {
    const prob = b.odds > 1 ? 1 / b.odds : 0.5;
    return s + prob * (1 - prob);
  }, 0)).toFixed(2);
  const luckFactor = varianceStdDev > 0 ? +(variance / varianceStdDev).toFixed(2) : 0;

  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const todayBets = bets.filter(b => {
    if (b.uitkomst !== 'Open') return false;
    const d = b.datum;
    if (!d) return false;
    const parts = d.split('-');
    if (parts.length !== 3) return false;
    const iso = `${parts[2]}-${parts[1]}-${parts[0]}`;
    return iso === todayStr;
  });
  const potentialWin = +todayBets.reduce((s, b) => s + (b.odds - 1) * b.inzet, 0).toFixed(2);
  const potentialLoss = +todayBets.reduce((s, b) => s + b.inzet, 0).toFixed(2);
  const todayBetsCount = todayBets.length;
  // netUnits: per-bet division door unit_at_time (legacy fallback huidige unit).
  const netUnits  = +bets.reduce((s, b) => {
    if (b.uitkomst === 'Open') return s;
    const ue = unitFor(b);
    return ue > 0 ? s + (b.wl / ue) : s;
  }, 0).toFixed(2);
  const netProfit = +wlEur.toFixed(2);

  return { total, W, L, open, wlEur: +wlEur.toFixed(2), roi: +roi.toFixed(4),
           bankroll: +bankroll.toFixed(2), startBankroll, avgOdds, avgUnits, strikeRate, winU, lossU,
           netUnits, netProfit,
           avgCLV, clvPositive, clvTotal,
           expectedWins, actualWins, variance, varianceStdDev, luckFactor,
           openInzet, potentialWin, potentialLoss, todayBetsCount };
}

async function readBets(userId = null, money = null) {
  const effectiveMoney = money || await getUserMoneySettings(userId);
  let query = supabase.from('bets').select('*').order('bet_id', { ascending: true });
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const bets = (data || []).map(r => {
    const unitAtTime = Number.isFinite(parseFloat(r.unit_at_time)) && parseFloat(r.unit_at_time) > 0
      ? parseFloat(r.unit_at_time)
      : null;
    const ueForInzet = unitAtTime || effectiveMoney.unitEur;
    return {
      id: r.bet_id, datum: r.datum || '', sport: r.sport || '', wedstrijd: r.wedstrijd || '',
      markt: r.markt || '', odds: r.odds || 0, units: r.units || 0,
      inzet: r.inzet != null ? r.inzet : +(r.units * ueForInzet).toFixed(2),
      tip: r.tip || 'Bet365', uitkomst: r.uitkomst || 'Open', wl: r.wl || 0,
      tijd: r.tijd || '', score: r.score || null,
      signals: r.signals || '', clvOdds: r.clv_odds || null, clvPct: r.clv_pct || null, sharpClvOdds: r.sharp_clv_odds || null, sharpClvPct: r.sharp_clv_pct || null,
      fixtureId: r.fixture_id || null,
      unitAtTime,
    };
  });
  return { bets, stats: calcStats(bets, effectiveMoney.startBankroll, effectiveMoney.unitEur), _raw: data };
}

async function writeBet(bet, userId = null, unitEur = null) {
  const money = await getUserMoneySettings(userId);
  const ue = unitEur ?? money.unitEur;
  const inzet = +(bet.units * ue).toFixed(2);
  const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2)
           : bet.uitkomst === 'L' ? -inzet : 0;
  const base = {
    bet_id: bet.id, datum: bet.datum, sport: bet.sport, wedstrijd: bet.wedstrijd,
    markt: bet.markt, odds: bet.odds, units: bet.units, inzet, tip: bet.tip || 'Bet365',
    uitkomst: bet.uitkomst || 'Open', wl, tijd: bet.tijd || '', score: bet.score || null,
    signals: bet.signals || '',
    user_id: userId || null,
    unit_at_time: ue,
  };
  await insertBetWithSchemaFallback(base, bet.fixtureId || null);
}

// Schema-tolerant insert: probeert eerst alle kolommen, valt terug op
// minder kolommen als de DB nog op een ouder schema draait. Tiers:
//   1. base + fixture_id + unit_at_time   (huidig schema, v10.10.7+)
//   2. base + unit_at_time                 (geen fixture_id)
//   3. base zonder unit_at_time + zonder fixture_id (pre-v10.10.7 schema)
async function insertBetWithSchemaFallback(base, fixtureId) {
  const isColumnError = (msg) => (msg || '').toLowerCase().includes('column');
  const safeInsert = async (payload) => {
    try {
      const { error } = await supabase.from('bets').insert(payload);
      return error || null;
    } catch (e) {
      return { message: e.message };
    }
  };
  let err = await safeInsert({ ...base, fixture_id: fixtureId });
  if (err && isColumnError(err.message)) err = await safeInsert(base);
  if (err && isColumnError(err.message)) {
    const { unit_at_time, ...legacy } = base;
    err = await safeInsert(legacy);
  }
  if (err) throw new Error(err.message);
}

async function deleteBet(id, userId = null) {
  let query = supabase.from('bets').delete().eq('bet_id', id);
  if (userId) query = query.eq('user_id', userId);
  await query;
}

// ── SCAN HISTORY ─────────────────────────────────────────────────────────────
const SCAN_HISTORY_MAX  = 10;
let _scanHistoryCache = null;

function loadScanHistory() {
  if (_scanHistoryCache) return _scanHistoryCache;
  return [];
}

async function loadScanHistoryFromSheets() {
  try {
    const { data, error } = await supabase.from('scan_history').select('*').order('ts', { ascending: false }).limit(SCAN_HISTORY_MAX);
    if (error) throw new Error(error.message);
    _scanHistoryCache = (data || []).map(r => ({
      ts: r.ts, type: r.type, totalEvents: r.total_events, picks: r.picks || []
    }));
    return _scanHistoryCache;
  } catch { return loadScanHistory(); }
}

async function saveScanEntry(picks, type = 'prematch', totalEvents = 0, userId = null) {
  const entry = {
    ts:          new Date().toISOString(),
    type,
    total_events: totalEvents,
    picks: picks.map(p => ({
      match: p.match, league: p.league, label: p.label, odd: p.odd,
      prob: p.prob, units: p.units, reason: p.reason, kelly: p.kelly,
      ep: p.ep, edge: p.edge, strength: p.strength, expectedEur: p.expectedEur,
      kickoff: p.kickoff, scanType: p.scanType || type, bookie: p.bookie,
      signals: p.signals || [], sport: p.sport || 'football',
      selected: p.selected !== false,
      audit: p.audit || null,
    })),
    user_id: userId || null,
  };
  _scanHistoryCache = null;
  try {
    await supabase.from('scan_history').insert(entry);
    // Trim to max entries
    let trimQuery = supabase.from('scan_history').select('id').order('ts', { ascending: false });
    if (userId) trimQuery = trimQuery.eq('user_id', userId);
    const { data: all } = await trimQuery;
    if (all && all.length > SCAN_HISTORY_MAX) {
      const toDelete = all.slice(SCAN_HISTORY_MAX).map(r => r.id);
      await supabase.from('scan_history').delete().in('id', toDelete);
    }
  } catch (e) { console.error('Scan history save fout:', e.message); }
}

module.exports = {
  defaultSettings, loadUsers, saveUser, getUsersCache, clearUsersCache,
  getUserMoneySettings,
  calcStats, readBets, writeBet, deleteBet,
  loadScanHistory, loadScanHistoryFromSheets, saveScanEntry,
  SCAN_HISTORY_MAX,
};
