'use strict';

const { supabase, UNIT_EUR, START_BANKROLL } = require('./config');

/**
 * v11.3.24 · Phase 7.2 · A1: persistence collapse.
 *
 * Reviewer Codex #1 merkte drie autoriteiten voor bet-persistence: server.js
 * (inline), lib/db.js (duplicate), lib/bets-data.js (v11.3.21 factory). Na
 * Phase 6.3 leeft de canonical in `lib/bets-data.js`. server.js gebruikt die
 * via factory-inject. De oude `readBets`/`writeBet`/`deleteBet`/`calcStats`
 * kopieën in dit bestand waren dode code en zijn nu verwijderd.
 *
 * Ook de dode `loadScanHistory`/`loadScanHistoryFromSheets`/`saveScanEntry`/
 * `SCAN_HISTORY_MAX` exports zijn hier weg — server.js heeft zijn eigen
 * implementaties die actief worden gebruikt.
 *
 * Dit module is nu dedicated aan user-management: users-cache, loadUsers,
 * saveUser, getUserMoneySettings en defaultSettings.
 */

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

module.exports = {
  defaultSettings, loadUsers, saveUser, getUsersCache, clearUsersCache,
  getUserMoneySettings,
};
