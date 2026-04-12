'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const { google }     = require('googleapis');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');

const app = express();
app.use(express.json());

// ── AUTH CONFIG ────────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET || 'bet-scanner-dev-secret-change-in-prod';
const ADMIN_EMAIL  = (process.env.ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSW  = process.env.ADMIN_PASSWORD || '';
const USER_TAB     = 'Users';

// Routes that don't require authentication (full paths)
const PUBLIC_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/register']);

// JWT middleware
function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
}
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    next();
  });
}

// Apply JWT auth to all /api/* routes except public ones
// Note: use req.path (full path), NOT inside app.use('/api') which strips prefix
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_PATHS.has(req.path)) return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname)));

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const APP_VERSION    = '4.1.0';
const TOKEN      = '8722733522:AAGuQiuENAwHYrW21wXD-W5drNAxJHSiYMw';
const CHAT       = '12272422';
const TG_URL     = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
const UNIT_EUR   = 10;
const START_BANKROLL = 100;
const CALIB_FILE = path.join(__dirname, 'calibration.json');

// ── GOOGLE SHEETS CONFIG ──────────────────────────────────────────────────────
const SHEET_ID    = process.env.SHEET_ID || '1tHV7Mrp_jUzlU-nxUAHpYL-d0rcqG2FpfGGNWbu16Ik';
const SHEET_CREDS = process.env.GOOGLE_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
  : require('./gsheets-key.json');
const BET_START_ROW = 19;  // bets starten op rij 19 (1-gebaseerd)

let _sheetsAuth = null;
function getSheetsClient() {
  if (!_sheetsAuth) {
    _sheetsAuth = new google.auth.GoogleAuth({
      credentials: SHEET_CREDS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }
  return google.sheets({ version: 'v4', auth: _sheetsAuth });
}

let _sheetTab = null;
let _sheetGid = 0;
async function getSheetMeta() {
  if (_sheetTab) return { tab: _sheetTab, gid: _sheetGid };
  const sh   = getSheetsClient();
  const meta = await sh.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const s0   = meta.data.sheets?.[0]?.properties;
  _sheetTab  = s0?.title || 'Sheet1';
  _sheetGid  = s0?.sheetId ?? 0;
  return { tab: _sheetTab, gid: _sheetGid };
}

// ── USER MANAGEMENT (Google Sheets "Users" tab) ─────────────────────────────
let _usersCache     = null;
let _usersCacheAt   = 0;
const USERS_TTL     = 5 * 60 * 1000; // 5 min

function defaultSettings() {
  return {
    startBankroll: START_BANKROLL,
    unitEur:       UNIT_EUR,
    language:      'nl',
    timezone:      'Europe/Amsterdam',
    scanTimes:     [10],
    scanEnabled:   true,
  };
}

async function ensureUsersTab() {
  const sh   = getSheetsClient();
  const meta = await sh.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = meta.data.sheets?.some(s => s.properties?.title === USER_TAB);
  if (!exists) {
    await sh.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ addSheet: { properties: { title: USER_TAB } } }] }
    });
    await sh.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${USER_TAB}!A1:G1`,
      valueInputOption: 'RAW',
      requestBody: { values: [['id','email','passwordHash','role','status','settings','createdAt']] }
    });
  }
}

async function loadUsers(force = false) {
  if (!force && _usersCache && Date.now() - _usersCacheAt < USERS_TTL) return _usersCache;
  try {
    const sh  = getSheetsClient();
    const res = await sh.spreadsheets.values.get({
      spreadsheetId: SHEET_ID, range: `${USER_TAB}!A2:G500`
    });
    const rows = (res.data.values || []).filter(r => r[0]);
    _usersCache = rows.map(r => ({
      id: r[0], email: (r[1]||'').toLowerCase(), passwordHash: r[2]||'',
      role: r[3]||'user', status: r[4]||'pending',
      settings: (() => { try { return { ...defaultSettings(), ...JSON.parse(r[5]||'{}') }; } catch { return defaultSettings(); } })(),
      createdAt: r[6]||''
    }));
    _usersCacheAt = Date.now();
    return _usersCache;
  } catch { return _usersCache || []; }
}

async function saveUser(user) {
  const sh   = getSheetsClient();
  const users = await loadUsers(true);
  const idx  = users.findIndex(u => u.id === user.id);
  const row  = [
    user.id, user.email, user.passwordHash, user.role, user.status,
    JSON.stringify(user.settings || defaultSettings()), user.createdAt
  ];
  if (idx === -1) {
    await sh.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${USER_TAB}!A2`,
      valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    });
  } else {
    await sh.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${USER_TAB}!A${idx+2}:G${idx+2}`,
      valueInputOption: 'RAW', requestBody: { values: [row] }
    });
  }
  _usersCache = null;
}

async function seedAdminUser() {
  if (!ADMIN_EMAIL || !ADMIN_PASSW) return;
  try {
    await ensureUsersTab();
    const users = await loadUsers(true);
    const exists = users.find(u => u.email === ADMIN_EMAIL);
    if (!exists) {
      const hash = await bcrypt.hash(ADMIN_PASSW, 10);
      await saveUser({
        id: crypto.randomUUID(), email: ADMIN_EMAIL, passwordHash: hash,
        role: 'admin', status: 'approved',
        settings: defaultSettings(), createdAt: new Date().toISOString()
      });
      console.log(`👤 Admin aangemaakt: ${ADMIN_EMAIL}`);
    }
  } catch (e) { console.error('seedAdminUser fout:', e.message); }
}

// Per-user scan scheduling
const userScanTimers = {}; // userId → [timeout handles]

function rescheduleUserScans(user) {
  if (userScanTimers[user.id]) {
    userScanTimers[user.id].forEach(h => clearTimeout(h));
    delete userScanTimers[user.id];
  }
  if (!user?.settings?.scanEnabled) return;
  const times = user.settings.scanTimes || [10];
  userScanTimers[user.id] = times.map(h => scheduleScanAtHour(h));
}

// ── CALIBRATIE — leren van resultaten ────────────────────────────────────────
// ep-bucket sleutels: de ranges die overeenkomen met de epW bonuses in mkP
const EP_BUCKETS = ['0.28','0.30','0.38','0.45','0.55'];
function epBucketKey(ep) {
  if (ep >= 0.55) return '0.55';
  if (ep >= 0.45) return '0.45';
  if (ep >= 0.38) return '0.38';
  if (ep >= 0.30) return '0.30';
  return '0.28';
}
// Standaard epW gewichten (worden overschreven door calibratie na 100 bets)
const DEFAULT_EPW = { '0.28':0.80, '0.30':0.95, '0.38':1.05, '0.45':1.15, '0.55':1.25 };

function loadCalib() {
  try { return JSON.parse(fs.readFileSync(CALIB_FILE, 'utf8')); }
  catch { return { version:1, lastUpdated:null, totalSettled:0, totalWins:0, totalProfit:0,
    markets:{ home:{n:0,w:0,profit:0,multiplier:1.0}, away:{n:0,w:0,profit:0,multiplier:1.0},
              draw:{n:0,w:0,profit:0,multiplier:1.0}, over:{n:0,w:0,profit:0,multiplier:1.0},
              under:{n:0,w:0,profit:0,multiplier:1.0}, other:{n:0,w:0,profit:0,multiplier:1.0} },
    epBuckets: {}, leagues:{}, lossLog:[] }; }
}
function saveCalib(c) { fs.writeFileSync(CALIB_FILE, JSON.stringify(c, null, 2)); }

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

function updateCalibration(bet) {
  if (!bet || !['W','L'].includes(bet.uitkomst)) return;
  const c    = loadCalib();
  const mKey = detectMarket(bet.markt || '');
  const lg   = bet.wedstrijd?.split(' vs ')?.[0] ? (bet.league || 'Unknown') : 'Unknown';
  const won  = bet.uitkomst === 'W';
  const pnl  = parseFloat(bet.wl) || 0;

  // Update totals
  c.totalSettled++; if (won) c.totalWins++; c.totalProfit += pnl;

  // Update market
  const mk = c.markets[mKey] || { n:0, w:0, profit:0, multiplier:1.0 };
  mk.n++; if (won) mk.w++; mk.profit += pnl;

  // Recalibrate multiplier na 8+ bets in categorie
  const oldMult = mk.multiplier;
  if (mk.n >= 8) {
    const wr = mk.w / mk.n;
    const profitPerBet = mk.profit / mk.n;
    if (profitPerBet < -3 && wr < 0.40) mk.multiplier = Math.max(0.55, mk.multiplier - 0.05);
    else if (profitPerBet > 3 && wr > 0.55) mk.multiplier = Math.min(1.30, mk.multiplier + 0.03);
    else mk.multiplier = Math.max(0.70, Math.min(1.20, 0.70 + wr * 1.0));
  }
  c.markets[mKey] = mk;

  // Log significante multiplier-verandering (>= 4%) als model-update
  const multDelta = Math.abs(mk.multiplier - oldMult);
  if (mk.n >= 8 && multDelta >= 0.04) {
    const dir    = mk.multiplier > oldMult ? '↑ vertrouwen omhoog' : '↓ drempel verhoogd';
    const wr     = mk.w / mk.n;
    const entry  = {
      date:    new Date().toISOString(),
      market:  mKey,
      oldMult: +oldMult.toFixed(3),
      newMult: +mk.multiplier.toFixed(3),
      n:       mk.n,
      winRate: +(wr * 100).toFixed(1),
      note:    `${mKey} · ${dir} (${wr*100 < 50 ? '' : '+'}${((wr-0.5)*100).toFixed(0)}% winrate, ${mk.n} bets)`,
    };
    c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 30);
    c.modelLastUpdated = entry.date;
  }

  // ── ep-bucket tracking (voor dynamische epW kalibratie) ──────────────────
  // Sla ep op per bet zodat we kunnen terugkijken welk bucket dit was.
  // ep zit niet in de bet-record — we reconstrueren het uit kans (prob) veld als fallback.
  const epEst = bet.ep ? parseFloat(bet.ep) : (bet.prob ? parseFloat(bet.prob) / 100 : null);
  if (epEst && epEst >= 0.28) {
    const bk = epBucketKey(epEst);
    if (!c.epBuckets) c.epBuckets = {};
    if (!c.epBuckets[bk]) c.epBuckets[bk] = { n:0, w:0, weight: DEFAULT_EPW[bk] };
    const eb = c.epBuckets[bk];
    eb.n++; if (won) eb.w++;

    // Herbereken gewicht na 100 totale bets + min 15 per bucket
    if (c.totalSettled >= 100 && eb.n >= 15) {
      const actualWr  = eb.w / eb.n;
      const expectedWr = parseFloat(bk); // bucket ondergrens als proxy voor verwachte hitrate
      const ratio     = actualWr / Math.max(expectedWr, 0.01);
      const oldW      = eb.weight;
      // Graduele aanpassing: max ±0.10 per recalibratie, begrensd op [0.50, 1.60]
      const rawNew    = oldW * (0.85 + ratio * 0.15);
      eb.weight       = Math.max(0.50, Math.min(1.60, +rawNew.toFixed(3)));

      if (Math.abs(eb.weight - oldW) >= 0.05) {
        const dir = eb.weight > oldW ? '↑' : '↓';
        const entry = {
          date:    new Date().toISOString(),
          market:  `epW bucket ${bk}`,
          oldMult: +oldW.toFixed(3),
          newMult: +eb.weight.toFixed(3),
          n:       eb.n,
          winRate: +(actualWr*100).toFixed(1),
          note:    `epW [${bk}+] ${dir} bijgesteld — werkelijke hitrate ${(actualWr*100).toFixed(0)}% vs verwacht ${(expectedWr*100).toFixed(0)}% (${eb.n} bets)`,
        };
        c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 30);
        c.modelLastUpdated = entry.date;
      }
    }
    c.epBuckets[bk] = eb;
  }

  // Update league
  if (!c.leagues[lg]) c.leagues[lg] = { n:0, w:0, profit:0 };
  c.leagues[lg].n++; if (won) c.leagues[lg].w++;
  c.leagues[lg].profit += pnl;

  // Log verliezen voor analyse
  if (!won) {
    c.lossLog = [
      { date: bet.datum, match: bet.wedstrijd, markt: bet.markt, odds: bet.odds,
        market: mKey, reason: '—', pnl },
      ...(c.lossLog || [])
    ].slice(0, 50);
  }

  c.lastUpdated = new Date().toISOString();
  saveCalib(c);
  return c;
}

// ── PORTFOLIO ANALYSE & UPGRADE AANBEVELINGEN ─────────────────────────────────
async function runPortfolioAnalysis() {
  const c    = loadCalib();
  const { stats: s } = await readBets();
  if (c.totalSettled < 5) return; // te weinig data

  const roi      = s.roi ?? 0;
  const bankroll = s.bankroll ?? START_BANKROLL;
  const profit   = bankroll - START_BANKROLL;
  const lines    = [];

  lines.push(`📊 PORTFOLIO ANALYSE — ${new Date().toLocaleDateString('nl-NL')}`);
  lines.push(`Settled: ${c.totalSettled} bets | W/L: ${c.totalWins}/${c.totalSettled - c.totalWins} | ROI: ${(roi*100).toFixed(1)}%`);
  lines.push(`Bankroll: €${bankroll} (${profit >= 0 ? '+' : ''}€${profit.toFixed(2)} t.o.v. start)`);
  lines.push('');

  // ── Market calibratie samenvatting ──
  lines.push('📈 Markt performance:');
  for (const [mk, v] of Object.entries(c.markets)) {
    if (v.n < 3) continue;
    const wr = Math.round(v.w / v.n * 100);
    const status = v.multiplier < 0.8 ? '⚠️' : v.multiplier > 1.1 ? '✅' : '➡️';
    lines.push(`  ${status} ${mk}: ${v.w}/${v.n} (${wr}%) | €${v.profit.toFixed(1)} | model×${v.multiplier.toFixed(2)}`);
  }
  lines.push('');

  // ── Verlies-patronen ──
  if (c.lossLog?.length >= 3) {
    const byMarket = {};
    for (const l of c.lossLog) {
      byMarket[l.market] = (byMarket[l.market] || 0) + 1;
    }
    const worst = Object.entries(byMarket).sort((a,b) => b[1]-a[1])[0];
    if (worst?.[1] >= 3) {
      lines.push(`⚠️ Verliespatroon: ${worst[1]}x verlies in "${worst[0]}" picks — model drempel verhoogd`);
    }
  }
  lines.push('');

  // ── Upgrade aanbevelingen ──
  lines.push('🔧 API status & aanbevelingen:');
  lines.push(`✅ api-football.com Pro: actief (7500 req/dag)`);

  // api-sports all-sports upgrade aanbeveling (ROI-gebaseerd)
  if (c.totalSettled >= 30 && roi > 0.10) {
    lines.push(`🚀 UPGRADE AANBEVOLEN: ROI ${(roi*100).toFixed(1)}% over ${c.totalSettled} bets — api-sports All Sports ($99/mnd) rechtvaardigt zich`);
  } else if (c.totalSettled >= 20 && roi > 0.05) {
    lines.push(`💡 Winstgevend (ROI ${(roi*100).toFixed(1)}%) — wacht tot 30+ bets voor All Sports upgrade`);
  } else if (c.totalSettled < 20) {
    lines.push(`⏳ Nog ${20 - c.totalSettled} settled bets nodig voor upgrade-aanbeveling`);
  }

  // Unit size aanbeveling op basis van bankroll groei
  const bankrollGrowth = bankroll - START_BANKROLL;
  const currentUnit = UNIT_EUR;
  if (bankrollGrowth >= START_BANKROLL) {
    lines.push(`💰 UNIT VERHOGING: Bankroll +100% (€${bankroll.toFixed(0)}) → overweeg unit van €${currentUnit} naar €${currentUnit*2}`);
  } else if (bankrollGrowth >= START_BANKROLL * 0.5) {
    lines.push(`💰 Unit verhoging mogelijk: Bankroll +50% (€${bankroll.toFixed(0)}) → overweeg €${currentUnit} → €${Math.round(currentUnit*1.5)}`);
  }

  await tg(lines.join('\n')).catch(() => {});
}

const H = {
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'nl-NL,nl;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://www.sofascore.com/',
  'Origin': 'https://www.sofascore.com',
  'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
  'Connection': 'keep-alive'
};

// ── API CONFIG ─────────────────────────────────────────────────────────────────
const AF_KEY = process.env.API_FOOTBALL_KEY || 'c154e5166a368537e38675f46ce4340f';

// Seizoen berekening: Europese competities lopen aug–mei, dus in jan–jul = vorig jaar
const CURRENT_SEASON = new Date().getMonth() < 7
  ? new Date().getFullYear() - 1   // april 2026 → season 2025
  : new Date().getFullYear();

// Voetbal competities via api-football.com (league ID, ESPN code, thuisvoordeel)
const AF_FOOTBALL_LEAGUES = [
  // ── Europa — Tier 1 ────────────────────────────────────────────────────────
  { id:39,  key:'epl',          name:'Premier League',      ha:0.05, season:CURRENT_SEASON },
  { id:140, key:'laliga',       name:'La Liga',             ha:0.05, season:CURRENT_SEASON },
  { id:78,  key:'bundesliga',   name:'Bundesliga',          ha:0.05, season:CURRENT_SEASON },
  { id:135, key:'seriea',       name:'Serie A',             ha:0.05, season:CURRENT_SEASON },
  { id:61,  key:'ligue1',       name:'Ligue 1',             ha:0.05, season:CURRENT_SEASON },
  { id:88,  key:'eredivisie',   name:'Eredivisie',          ha:0.05, season:CURRENT_SEASON },
  { id:94,  key:'primeiraliga', name:'Primeira Liga',       ha:0.05, season:CURRENT_SEASON },
  { id:203, key:'superlig',     name:'Süper Lig',           ha:0.06, season:CURRENT_SEASON },
  { id:144, key:'jupiler',      name:'Jupiler Pro League',  ha:0.05, season:CURRENT_SEASON },
  { id:179, key:'scottish',     name:'Scottish Prem',       ha:0.05, season:CURRENT_SEASON },
  // ── Europa — Tier 2 ────────────────────────────────────────────────────────
  { id:40,  key:'championship', name:'Championship',        ha:0.04, season:CURRENT_SEASON },
  { id:41,  key:'league1',      name:'League One',          ha:0.04, season:CURRENT_SEASON },
  { id:42,  key:'league2',      name:'League Two',          ha:0.04, season:CURRENT_SEASON },
  { id:141, key:'laliga2',      name:'La Liga 2',           ha:0.04, season:CURRENT_SEASON },
  { id:79,  key:'bundesliga2',  name:'Bundesliga 2',        ha:0.04, season:CURRENT_SEASON },
  { id:136, key:'serieb',       name:'Serie B',             ha:0.04, season:CURRENT_SEASON },
  { id:66,  key:'ligue2',       name:'Ligue 2',             ha:0.04, season:CURRENT_SEASON },
  { id:89,  key:'eerstedivisie',name:'Eerste Divisie',      ha:0.04, season:CURRENT_SEASON },
  { id:95,  key:'liga2por',     name:'Liga Portugal 2',     ha:0.04, season:CURRENT_SEASON },
  { id:180, key:'scottish2',    name:'Scottish Championship',ha:0.04,season:CURRENT_SEASON },
  // ── Europese Cups ──────────────────────────────────────────────────────────
  { id:2,   key:'ucl',          name:'Champions League',    ha:0.02, season:CURRENT_SEASON },
  { id:3,   key:'uel',          name:'Europa League',       ha:0.02, season:CURRENT_SEASON },
  { id:848, key:'uecl',         name:'Conference League',   ha:0.02, season:CURRENT_SEASON },
  // ── Andere Europese competities ────────────────────────────────────────────
  { id:218, key:'austria',      name:'Austrian Bundesliga', ha:0.05, season:CURRENT_SEASON },
  { id:207, key:'swiss',        name:'Swiss Super League',  ha:0.05, season:CURRENT_SEASON },
  { id:119, key:'denmark',      name:'Danish Superliga',    ha:0.05, season:CURRENT_SEASON },
  { id:103, key:'norway',       name:'Eliteserien',         ha:0.05, season:new Date().getFullYear() },
  { id:113, key:'sweden',       name:'Allsvenskan',         ha:0.05, season:new Date().getFullYear() },
  { id:197, key:'greece',       name:'Super League Greece', ha:0.06, season:CURRENT_SEASON },
  { id:106, key:'poland',       name:'Ekstraklasa',         ha:0.05, season:CURRENT_SEASON },
  { id:345, key:'czech',        name:'Czech First League',  ha:0.05, season:CURRENT_SEASON },
  { id:283, key:'romania',      name:'Liga I Romania',      ha:0.05, season:CURRENT_SEASON },
  { id:210, key:'croatia',      name:'HNL Croatia',         ha:0.06, season:CURRENT_SEASON },
  { id:235, key:'russia',       name:'Russian Premier',     ha:0.05, season:CURRENT_SEASON },
  { id:333, key:'ukraine',      name:'Ukrainian Premier',   ha:0.05, season:CURRENT_SEASON },
  // ── Rest van de wereld ─────────────────────────────────────────────────────
  { id:253, key:'mls',          name:'MLS',                 ha:0.04, season:new Date().getFullYear() },
  { id:262, key:'ligamx',       name:'Liga MX',             ha:0.06, season:new Date().getFullYear() },
  { id:71,  key:'brasileirao',  name:'Brasileirao',         ha:0.06, season:new Date().getFullYear() },
  { id:128, key:'argentina',    name:'Primera División',    ha:0.06, season:new Date().getFullYear() },
  { id:307, key:'saudi',        name:'Saudi Pro League',    ha:0.05, season:CURRENT_SEASON },
  { id:98,  key:'j1league',     name:'J1 League',           ha:0.04, season:new Date().getFullYear() },
];

// ESPN standings cache
const espnStandings = {};

// ── LAST PICKS (in-memory voor analyse tab) ──────────────────────────────────
let lastPrematchPicks = [];
let lastLivePicks = [];

// ── SCAN HISTORY ─────────────────────────────────────────────────────────────
const SCAN_HISTORY_FILE = path.join(__dirname, 'scan-history.json');
const SCAN_HISTORY_MAX  = 10;

function loadScanHistory() {
  try { return JSON.parse(fs.readFileSync(SCAN_HISTORY_FILE, 'utf8')); } catch { return []; }
}
function saveScanEntry(picks, type = 'prematch', totalEvents = 0) {
  const history = loadScanHistory();
  history.unshift({
    ts:          new Date().toISOString(),
    type,
    totalEvents,
    picks: picks.map(p => ({
      match: p.match, league: p.league, label: p.label, odd: p.odd,
      prob: p.prob, units: p.units, reason: p.reason, kelly: p.kelly,
      ep: p.ep, edge: p.edge, strength: p.strength, expectedEur: p.expectedEur,
      kickoff: p.kickoff, scanType: p.scanType || type, bookie: p.bookie,
    })),
  });
  fs.writeFileSync(SCAN_HISTORY_FILE, JSON.stringify(history.slice(0, SCAN_HISTORY_MAX), null, 2));
}

// ── HELPERS ────────────────────────────────────────────────────────────────────
const get    = (url) => fetch(url, { headers: H }).then(r => r.json()).catch(() => ({}));
const toD    = f => { if (!f || !f.includes('/')) return null; const [n,d] = f.split('/').map(Number); return +(1 + n/d).toFixed(2); };
const clamp  = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const tg     = async (text) => fetch(TG_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: CHAT, text }) }).catch(() => {});

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

// ── PROBABILITY CALCULATORS (0-100, puur data, onafhankelijk van odds) ─────────
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

// ── TOP LEAGUES ────────────────────────────────────────────────────────────────
const TOP_FB = new Set([
  'Premier League','La Liga','Serie A','Bundesliga','Ligue 1',
  'Eredivisie','Championship','Primeira Liga','Süper Lig',
  'Jupiler Pro League','Scottish Premiership','MLS','Liga MX',
  'Brasileirao','Argentine Primera Division','Ekstraklasa',
  'Czech Liga','Swiss Super League','Austrian Bundesliga','Greek Super League',
  'Allsvenskan','Eliteserien','Veikkausliiga','Danish Superliga',
  'Slovak Super Liga','Romanian Liga 1','Hungarian OTP Bank Liga',
  'Croatian Football League','Serbian SuperLiga','Turkish First League',
  'Segunda Division','Serie B','2. Bundesliga','Ligue 2',
  'Russian Premier League','Israeli Premier League','Saudi Pro League',
  'UAE Pro League','J1 League','K League 1','A-League',
  'Belgian Pro League','Swiss Challenge League','National League'
]);

// ── PICK FACTORY ──────────────────────────────────────────────────────────────
const MAX_WINNER_ODDS  = 4.0;   // geen winnaar-bets boven deze koers (Wharton: >4.0 = variance ruin)
const BLOWOUT_OPP_MAX  = 1.35;  // tegenstander ≤ 1.35 = mismatched wedstrijd
const MIN_EP           = 0.52;  // minimale geschatte kans (~52%) — boven 50% = meer wins dan losses structureel
const KELLY_FRACTION   = 0.50;  // half-Kelly: veiligst voor kleine bankroll (aanbevolen door Wharton)

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}) {
  const picks     = [];  // standalone picks (odd >= MIN_ODDS)
  const combiPool = [];  // alle valide picks incl. lage odds (voor combi-legs)

  const mkP = (match, league, label, odd, reason, prob, boost=0, kickoff=null, bookie=null) => {
    if (!odd || odd < 1.10) return;            // absoluut minimum
    const ip = 1/odd;
    const ep = Math.min(0.88, ip + boost);
    if (ep < MIN_EP) return;
    if (ep <= ip + 0.03) return;               // minimale edge vereist
    const k = ((ep*(odd-1)) - (1-ep)) / (odd-1);
    if (k <= 0.015) return;

    // Odds-penalty: hogere odds = hogere variance = lagere strength
    // Gebaseerd op Wharton research: >3.5 is nadrukkelijk afgeraden
    const vP = odd > 3.50 ? 0.42
             : odd > 2.50 ? 0.65
             : odd > 2.00 ? 0.85
             : 1.0;

    const bk  = epBucketKey(ep);
    const epW = (calibEpBuckets[bk]?.n >= 15 && calibEpBuckets[bk]?.weight)
      ? calibEpBuckets[bk].weight
      : DEFAULT_EPW[bk];

    // Half-Kelly unit sizing (fractional Kelly = 0.5 — Wharton aanbeveling)
    const hk = k * KELLY_FRACTION;
    const u  = hk>0.09?'1.0U' : hk>0.04?'0.5U' : '0.3U';
    const edge = Math.round((ep * odd - 1) * 100 * 10) / 10;

    const uNum = hk>0.09 ? 1.0 : hk>0.04 ? 0.5 : 0.3;
    const expectedEur = +(uNum * UNIT_EUR * (edge / 100)).toFixed(2);
    const pick = { match, league, label, odd, units: u, reason, prob, ep: +ep.toFixed(3),
                   strength: k*(odd-1)*vP*epW, kelly: hk, edge, expectedEur, kickoff, bookie };

    combiPool.push(pick);            // altijd in combi-pool (ook lage odds)
    if (odd >= MIN_ODDS) picks.push(pick);  // alleen in singles als >= MIN_ODDS
  };
  return { picks, combiPool, mkP };
}

// ── ODDS ANALYSE HELPERS ───────────────────────────────────────────────────────

// No-vig kansen per bookmaker normaliseren + gemiddelde over alle bookmakers
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

// Beste odds voor een uitkomst over alle bookmakers
function bestOdds(bookmakers, marketKey, outcomeName) {
  let best = { price: 0, bookie: '' };
  for (const bk of bookmakers) {
    const mkt = bk.markets?.find(m => m.key === marketKey);
    const o   = mkt?.outcomes?.find(o => o.name === outcomeName);
    if (o && o.price > best.price) best = { price: +o.price.toFixed(3), bookie: bk.title };
  }
  return best;
}

// Specifieke bookmaker odds
function bookiePrice(bookmakers, bookieFragment, marketKey, outcomeName) {
  const bk = bookmakers.find(b => b.key?.includes(bookieFragment) || b.title?.toLowerCase().includes(bookieFragment));
  const mkt = bk?.markets?.find(m => m.key === marketKey);
  return mkt?.outcomes?.find(o => o.name === outcomeName)?.price || null;
}

// Totals analyse: zoek beste O/U odds + consensus kans
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

// ESPN standings ophalen voor positie-informatie (gecached per sessie)
async function fetchEspnStandings(espnCode) {
  if (!espnCode) return {};
  if (espnStandings[espnCode]) return espnStandings[espnCode];
  try {
    const url = `https://site.api.espn.com/apis/v2/sports/soccer/${espnCode}/standings`;
    const d   = await fetch(url, { headers: { Accept:'application/json' } }).then(r=>r.json()).catch(()=>({}));
    const map = {};
    for (const entry of (d.standings?.entries || [])) {
      const name = entry.team?.displayName || '';
      const rank = entry.stats?.find(s => s.name==='rank')?.value
                || entry.stats?.find(s => s.name==='playoffSeed')?.value
                || 0;
      const pts  = entry.stats?.find(s => s.name==='points')?.value || 0;
      if (name) map[name.toLowerCase()] = { rank: +rank, pts: +pts };
    }
    espnStandings[espnCode] = map;
    return map;
  } catch { return {}; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// API-SPORTS.IO ENRICHMENT — vorm, H2H, blessures, scheidsrechter, team-stats
// ═══════════════════════════════════════════════════════════════════════════════

// Session-caches (worden éénmaal per scan gevuld)
const afCache = {
  teamStats: {},   // key=sport_key, value: { teamNameLower: { form, goalsFor, goalsAgainst, winPct, teamId } }
  injuries:  {},   // key=sport_key, value: { teamNameLower: [{ player, type }] }
  referees:  {},   // key='home vs away' (lower), value: { name, yellowsPerGame, redsPerGame }
  h2h:       {},   // key='id1-id2', value: { hmW, awW, dr, n, avgGoals, bttsRate }
};

// ── API-FOOTBALL RATE LIMIT TRACKER ─────────────────────────────────────────
let afRateLimit = { remaining: null, limit: null, updatedAt: null };

async function afGet(host, path, params = {}) {
  if (!AF_KEY) return [];
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `https://${host}${path}${qs ? '?' + qs : ''}`;
  try {
    const r = await fetch(url, {
      headers: { 'x-apisports-key': AF_KEY, Accept: 'application/json' }
    });
    // Lees rate limit headers uit elke response
    const rem = r.headers.get('x-ratelimit-requests-remaining');
    const lim = r.headers.get('x-ratelimit-requests-limit');
    if (rem !== null) afRateLimit = {
      remaining: parseInt(rem),
      limit:     parseInt(lim) || afRateLimit.limit,
      updatedAt: new Date().toISOString(),
    };
    const d = await r.json().catch(() => ({}));
    return d.response || [];
  } catch { return []; }
}

// Mapping voor enrichWithApiSports: gebouwd vanuit AF_FOOTBALL_LEAGUES
const AF_LEAGUE_MAP = Object.fromEntries(
  AF_FOOTBALL_LEAGUES.map(l => [l.key, { host:'v3.football.api-sports.io', league:l.id, season:l.season }])
);

// ── ODDS CONVERTER: api-football.com → intern formaat ──────────────────────
// Converteert api-football.com bookmaker-array naar het formaat dat fairProbs/bestOdds verwacht
function convertAfOdds(afBookmakers, hm, aw) {
  return afBookmakers.map(bk => {
    const markets = [];
    // Bet ID 1: Match Winner → h2h
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
    // Bet ID 5: Goals Over/Under → totals
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
    // Bet ID 12: Asian Handicap → spreads
    const ah = bk.bets?.find(b => b.id === 12);
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

async function enrichWithApiSports(emit) {
  if (!AF_KEY) return;
  emit({ log: '📡 api-sports.io: data ophalen (blessures, H2H, scheidsrechters, vorm)...' });

  let callsUsed = 0;
  const MAX_CALLS = 85; // bewaar buffer

  // Wis session-caches
  afCache.teamStats = {}; afCache.injuries = {}; afCache.referees = {}; afCache.h2h = {};

  // ── STAP 1: Standings + teamIDs per sport (1 call per league) ───────────
  for (const [sportKey, cfg] of Object.entries(AF_LEAGUE_MAP)) {
    if (callsUsed >= MAX_CALLS) break;
    try {
      const isSoccer = cfg.host.includes('football');
      const path = isSoccer ? '/standings' : '/standings';
      const rows = await afGet(cfg.host, path, { league: cfg.league, season: cfg.season });
      callsUsed++;

      const statsMap = {};
      if (isSoccer) {
        for (const entry of (rows[0]?.league?.standings?.[0] || [])) {
          const nm  = entry.team?.name?.toLowerCase();
          const all = entry.all;
          if (!nm || !all) continue;
          const played = all.played || 1;
          statsMap[nm] = {
            form:         entry.form || '',
            goalsFor:     +(all.goals?.for  / played).toFixed(2),
            goalsAgainst: +(all.goals?.against / played).toFixed(2),
            teamId:       entry.team?.id,
            rank:         entry.rank || 0,
          };
        }
      } else {
        // Basketball / Hockey / Baseball standings
        for (const row of (Array.isArray(rows[0]) ? rows[0] : rows)) {
          const team = row.team || row;
          const nm   = (team.name || '').toLowerCase();
          if (!nm) continue;
          const games = row.games || {};
          const won   = games.wins?.total || 0;
          const lost  = games.loses?.total || games.losses?.total || 0;
          const played = won + lost || 1;
          statsMap[nm] = {
            winPct:      +(won / played).toFixed(3),
            goalsFor:    +(games.points?.for   || 0) / played,
            goalsAgainst: +(games.points?.against || 0) / played,
            teamId:      team.id,
            form:        '',
          };
        }
      }
      afCache.teamStats[sportKey] = statsMap;
      await sleep(120); // respect rate limit
    } catch {}
  }
  emit({ log: `✅ Standings: ${Object.keys(afCache.teamStats).length} competities geladen (${callsUsed} calls)` });

  // ── STAP 2: Blessures per voetbalcompetitie (1 call per league) ──────────
  const soccerLeagues = Object.entries(AF_LEAGUE_MAP).filter(([k]) => k.startsWith('soccer'));
  for (const [sportKey, cfg] of soccerLeagues) {
    if (callsUsed >= MAX_CALLS) break;
    try {
      const rows = await afGet(cfg.host, '/injuries', { league: cfg.league, season: cfg.season });
      callsUsed++;
      const injMap = {};
      for (const r of rows) {
        const nm = (r.team?.name || '').toLowerCase();
        if (!nm) continue;
        if (!injMap[nm]) injMap[nm] = [];
        injMap[nm].push({
          player: r.player?.name || '?',
          type:   r.player?.type || r.reason || 'Geblesseerd',
        });
      }
      afCache.injuries[sportKey] = injMap;
      await sleep(120);
    } catch {}
  }
  const injCount = Object.values(afCache.injuries).reduce((s,v) => s + Object.keys(v).length, 0);
  emit({ log: `✅ Blessures: ${injCount} teams met geblesseerde spelers (${callsUsed} calls)` });

  // ── STAP 3: Aankomende fixtures met scheidsrechter (top leagues) ─────────
  const topLeaguesForRef = ['soccer_epl','soccer_spain_la_liga','soccer_germany_bundesliga',
                            'soccer_italy_serie_a','soccer_france_ligue_one','soccer_netherlands_eredivisie'];
  for (const sportKey of topLeaguesForRef) {
    const cfg = AF_LEAGUE_MAP[sportKey];
    if (!cfg || callsUsed >= MAX_CALLS) break;
    try {
      const rows = await afGet(cfg.host, '/fixtures', {
        league: cfg.league, season: cfg.season, next: 10
      });
      callsUsed++;
      for (const f of rows) {
        const hm  = (f.teams?.home?.name || '').toLowerCase();
        const aw  = (f.teams?.away?.name || '').toLowerCase();
        const ref = f.fixture?.referee || '';
        if (hm && aw && ref) {
          afCache.referees[`${hm} vs ${aw}`] = { name: ref.replace(/, \w+$/, '') };
        }
      }
      await sleep(120);
    } catch {}
  }
  emit({ log: `✅ Scheidsrechters: ${Object.keys(afCache.referees).length} wedstrijden (${callsUsed} calls)` });
  const tier = callsUsed <= 100 ? 'free (100/dag)' : 'Pro (7500/dag)';
  emit({ log: `📊 api-football.com klaar — ${callsUsed} calls gebruikt (${tier})` });
}

// Haal H2H op voor twee teams (lazy-loaded, max 5x per scan)
let h2hCallsThisScan = 0;
async function fetchH2H(homeId, awayId) {
  if (!AF_KEY || h2hCallsThisScan >= 5 || !homeId || !awayId) return null;
  const key = `${Math.min(homeId,awayId)}-${Math.max(homeId,awayId)}`;
  if (afCache.h2h[key]) return afCache.h2h[key];
  try {
    h2hCallsThisScan++;
    const rows = await afGet('v3.football.api-sports.io', '/fixtures/headtohead', {
      h2h: `${homeId}-${awayId}`, last: 10
    });
    let hmW=0, awW=0, dr=0, totalGoals=0, btts=0;
    for (const f of rows) {
      const hG = f.goals?.home ?? 0, aG = f.goals?.away ?? 0;
      if (hG > aG) hmW++; else if (hG < aG) awW++; else dr++;
      totalGoals += hG + aG;
      if (hG > 0 && aG > 0) btts++;
    }
    const n = rows.length || 1;
    const result = { hmW, awW, dr, n, avgGoals: +(totalGoals/n).toFixed(1), bttsRate: +(btts/n).toFixed(2) };
    afCache.h2h[key] = result;
    await sleep(120);
    return result;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PREMATCH SCAN — The Odds API + ESPN
// ═══════════════════════════════════════════════════════════════════════════════
async function runPrematch(emit) {
  if (!AF_KEY) {
    emit({ log: '❌ Geen API_FOOTBALL_KEY ingesteld!' });
    return [];
  }

  emit({ log: `🎯 Prematch scan — api-football.com (${AF_FOOTBALL_LEAGUES.length} competities, bet365 odds, lineups, predictions)` });

  // ── STAP 1: ESPN standings parallel ─────────────────────────────────────
  emit({ log: '📊 ESPN standings ophalen...' });
  const standingsCache = {};
  await Promise.all(AF_FOOTBALL_LEAGUES.filter(l => l.espn).map(async l => {
    standingsCache[l.key] = await fetchEspnStandings(l.espn);
  }));
  emit({ log: `✅ Standings geladen (${Object.keys(standingsCache).length} competities)` });

  // ── STAP 2: Team stats, blessures, scheidsrechters ───────────────────────
  h2hCallsThisScan = 0;
  await enrichWithApiSports(emit);

  // ── Calibratie ───────────────────────────────────────────────────────────
  const calib = loadCalib();
  const cm = calib.markets;
  emit({ log: `🧠 Calibratie: thuis×${cm.home.multiplier.toFixed(2)} uit×${cm.away.multiplier.toFixed(2)} draw×${cm.draw.multiplier.toFixed(2)} over×${cm.over.multiplier.toFixed(2)}` });

  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {});
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  // Datumbereik: vandaag + morgen
  const dateFrom = new Date().toISOString().slice(0, 10);
  const dateTo   = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);

  // ── STAP 3: Per competitie fixtures + odds + predictions ────────────────
  for (const league of AF_FOOTBALL_LEAGUES) {
    try {
      // Fixtures voor komende 2 dagen
      const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', {
        league: league.id, season: league.season, from: dateFrom, to: dateTo, status: 'NS',
      });
      apiCallsUsed++;

      if (!fixtures?.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `✅ ${league.name}: ${fixtures.length} wedstrijd(en)` });
      totalEvents += fixtures.length;

      const standings = standingsCache[league.key] || {};
      const afStats   = afCache.teamStats[league.key] || {};
      const afInj     = afCache.injuries[league.key]  || {};

      for (const f of fixtures) {
        const fid = f.fixture?.id;
        const hm  = f.teams?.home?.name;
        const aw  = f.teams?.away?.name;
        if (!fid || !hm || !aw) continue;

        const kickoffMs  = new Date(f.fixture?.date).getTime();
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
        const ko = new Date(kickoffMs)
          .toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });

        // ── Odds ophalen van api-football.com ─────────────────────────
        await sleep(120);
        const oddsResp = await afGet('v3.football.api-sports.io', '/odds', { fixture: fid });
        apiCallsUsed++;
        if (!oddsResp?.length) continue;

        const rawBks = oddsResp[0]?.bookmakers || [];

        // Alleen Bet365 en Unibet — andere bookmakers hebben onbetrouwbare odds
        const ALLOWED_BKMS = ['bet365', 'unibet'];
        const filteredBks = rawBks.filter(b =>
          ALLOWED_BKMS.some(name => b.name?.toLowerCase().includes(name))
        );
        if (filteredBks.length === 0) continue; // geen van beide beschikbaar, skip

        const bookies = convertAfOdds(filteredBks, hm, aw);
        const fp = fairProbs(bookies, hm, aw);
        if (!fp) continue;

        // ── Predictions (api-football.com model als extra signaal) ────
        let predAdj = 0, predNote = '';
        if (apiCallsUsed < 280) {
          await sleep(80);
          const predResp = await afGet('v3.football.api-sports.io', '/predictions', { fixture: fid });
          apiCallsUsed++;
          if (predResp?.length) {
            const pct  = predResp[0]?.predictions?.percent;
            const adv  = predResp[0]?.predictions?.advice || '';
            if (pct) {
              const predHome = parseInt(pct.home) / 100;
              // Kleine boost: max ±2.5% richting api-football.com prediction
              predAdj = Math.max(-0.025, Math.min(0.025, (predHome - fp.home) * 0.2));
              if (adv) predNote = ` | 🤖 ${adv}`;
            }
          }
        }

        // ── Lineups (alleen als aftrap < 3 uur weg) ───────────────────
        let lineupNote = '', lineupPenalty = { home: 0, away: 0 };
        const minsToKo = (kickoffMs - Date.now()) / 60000;
        if (minsToKo > 0 && minsToKo < 180 && apiCallsUsed < 290) {
          await sleep(80);
          const luResp = await afGet('v3.football.api-sports.io', '/fixtures/lineups', { fixture: fid });
          apiCallsUsed++;
          if (luResp?.length >= 2) {
            const hmLu = luResp.find(t => t.team?.id === f.teams?.home?.id);
            const awLu = luResp.find(t => t.team?.id === f.teams?.away?.id);
            const hmXI = hmLu?.startXI?.length || 0;
            const awXI = awLu?.startXI?.length || 0;
            if (hmXI > 0) lineupNote += ` | 📋 ${hm.split(' ').pop()} XI: ${hmLu.formation || '?'}`;
            if (awXI > 0) lineupNote += ` ${aw.split(' ').pop()} XI: ${awLu.formation || '?'}`;
            // Rotatiesignaal: als een ploeg duidelijk roteert (< 9 starters geteld)
            if (hmXI > 0 && hmXI < 9) { lineupPenalty.home = -0.03; lineupNote += ` ⚠️ ${hm.split(' ').pop()} roteert`; }
            if (awXI > 0 && awXI < 9) { lineupPenalty.away = -0.03; lineupNote += ` ⚠️ ${aw.split(' ').pop()} roteert`; }
          }
        }

        // ── ESPN positie-aanpassing ────────────────────────────────────
        let posAdj = 0, posStr = '';
        if (league.espn && Object.keys(standings).length > 0) {
          const hmSt = standings[hm.toLowerCase()];
          const awSt = standings[aw.toLowerCase()];
          if (hmSt && awSt) {
            posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.003));
            posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
          }
        }

        const ha = league.ha || 0;
        const adjHome = Math.min(0.88, fp.home + ha + posAdj + predAdj + lineupPenalty.home);
        const adjAway = Math.max(0.08, fp.away - ha * 0.5 - posAdj * 0.5 - predAdj * 0.5 + lineupPenalty.away);
        const adjDraw = fp.draw && fp.draw > 0.05 ? fp.draw - posAdj * 0.3 : null;

        // ── api-football.com stats: vorm, blessures, scheidsrechter ───
        const hmKey = hm.toLowerCase(), awKey = aw.toLowerCase();
        const hmSt  = afStats[hmKey], awSt = afStats[awKey];
        const hmInj = afInj[hmKey] || [], awInj = afInj[awKey] || [];
        const refInfo = afCache.referees[`${hmKey} vs ${awKey}`];

        let formAdj = 0, formNote = '';
        if (hmSt && awSt) {
          if (hmSt.form && awSt.form) {
            const fmScore = s => [...(s.slice(-5)||'')].reduce((a,c)=>a+(c==='W'?3:c==='D'?1:0),0);
            formAdj = Math.max(-0.05, Math.min(0.05, (fmScore(hmSt.form) - fmScore(awSt.form)) / 15 * 0.04));
          }
          const hmGD = hmSt.goalsFor && hmSt.goalsAgainst ? +(hmSt.goalsFor-hmSt.goalsAgainst).toFixed(2) : null;
          const awGD = awSt.goalsFor && awSt.goalsAgainst ? +(awSt.goalsFor-awSt.goalsAgainst).toFixed(2) : null;
          formNote = ` | Vorm: ${hmSt.form?.slice(-5)||''}${hmGD!=null?` (${hmGD>0?'+':''}${hmGD})`:''}  vs  ${awSt.form?.slice(-5)||''}${awGD!=null?` (${awGD>0?'+':''}${awGD})`:''} `;
        }

        let injAdj = 0, injNote = '';
        if (hmInj.length || awInj.length) {
          injAdj = Math.max(-0.04, Math.min(0.04, (awInj.length - hmInj.length) * 0.015));
          const fmt = arr => arr.slice(0,3).map(p=>p.player).join(', ') + (arr.length>3?` +${arr.length-3}`:'');
          if (hmInj.length) injNote += ` | ❌ ${hm.split(' ').pop()}: ${fmt(hmInj)} (${hmInj.length}x)`;
          if (awInj.length) injNote += ` | ❌ ${aw.split(' ').pop()}: ${fmt(awInj)} (${awInj.length}x)`;
        }

        const refNote = refInfo ? ` | 🟨 Ref: ${refInfo.name}` : '';

        let h2hAdj = 0, h2hNote = '';
        const hmId = hmSt?.teamId, awId = awSt?.teamId;
        if (hmId && awId) {
          const h2h = await fetchH2H(hmId, awId);
          if (h2h && h2h.n >= 3) {
            h2hAdj = Math.max(-0.03, Math.min(0.03, ((h2h.hmW - h2h.awW) / h2h.n) * 0.03));
            h2hNote = ` | H2H: ${h2h.hmW}W-${h2h.dr}D-${h2h.awW}L (${h2h.n}x, ${h2h.avgGoals} goals/game, BTTS ${Math.round(h2h.bttsRate*100)}%)`;
          }
        }

        const totalAdj  = formAdj + injAdj + h2hAdj;
        const adjHome2  = Math.min(0.88, adjHome + totalAdj);
        const adjAway2  = Math.max(0.08, adjAway - totalAdj);

        const bH = bestOdds(bookies, 'h2h', hm);
        const bA = bestOdds(bookies, 'h2h', aw);
        const bD = adjDraw !== null ? bestOdds(bookies, 'h2h', 'Draw') : null;

        const homeEdge = bH.price > 0 ? adjHome2 * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway2 * bA.price - 1 : -1;
        const drawEdge = bD?.price > 0 ? (adjDraw||0) * bD.price - 1 : -1;

        const sharedNotes = `${posStr}${formNote}${injNote}${h2hNote}${refNote}${predNote}${lineupNote}`;
        const reasonH = `Consensus: ${(fp.home*100).toFixed(1)}%→${(adjHome2*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`;
        const reasonA = `Consensus: ${(fp.away*100).toFixed(1)}%→${(adjAway2*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`;
        const reasonD = `Gelijkspel: ${((fp.draw||0)*100).toFixed(1)}% | ${bD?.bookie}: ${bD?.price}${sharedNotes} | ${ko}`;

        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && bA.price > BLOWOUT_OPP_MAX)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price, reasonH, Math.round(adjHome2*100), homeEdge * 0.28 * (cm.home?.multiplier ?? 1), kickoffTime, bH.bookie);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && bH.price > BLOWOUT_OPP_MAX)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price, reasonA, Math.round(adjAway2*100), awayEdge * 0.28 * (cm.away?.multiplier ?? 1), kickoffTime, bA.bookie);

        if (drawEdge >= MIN_EDGE + 0.01 && bD?.price >= 1.60)
          mkP(`${hm} vs ${aw}`, league.name, `🤝 Gelijkspel`, bD.price, reasonD, Math.round((adjDraw||0)*100), drawEdge * 0.22 * (cm.draw?.multiplier ?? 1), kickoffTime, bD?.bookie);

        // ── O/U Goals 2.5 ─────────────────────────────────────────────
        const over  = analyseTotal(bookies, 'Over',  2.5);
        const under = analyseTotal(bookies, 'Under', 2.5);
        if (over.best.price >= 1.60 && over.avgIP > 0) {
          const totIP  = over.avgIP + under.avgIP;
          const overP  = totIP > 0 ? over.avgIP / totIP : 0.5;
          const overEdge  = overP * over.best.price - 1;
          const underEdge = under.best.price > 0 ? (1-overP) * under.best.price - 1 : -1;
          if (overEdge >= MIN_EDGE)
            mkP(`${hm} vs ${aw}`, league.name, `⚽ Over 2.5 goals`, over.best.price,
              `O/U consensus: ${(overP*100).toFixed(1)}% over | ${over.best.bookie}: ${over.best.price}${predNote} | ${ko}`,
              Math.round(overP*100), overEdge * 0.24 * (cm.over?.multiplier ?? 1), kickoffTime, over.best.bookie);
          if (underEdge >= MIN_EDGE && under.best.price >= 1.60)
            mkP(`${hm} vs ${aw}`, league.name, `🔒 Under 2.5 goals`, under.best.price,
              `O/U consensus: ${((1-overP)*100).toFixed(1)}% under | ${under.best.bookie}: ${under.best.price} | ${ko}`,
              Math.round((1-overP)*100), underEdge * 0.22 * (cm.under?.multiplier ?? 1), kickoffTime, under.best.bookie);
        }

        // ── Handicap ──────────────────────────────────────────────────
        for (const bk of bookies.slice(0, 3)) {
          const sMkt = bk.markets?.find(m => m.key === 'spreads');
          if (!sMkt) continue;
          for (const o of (sMkt.outcomes || [])) {
            if (!o.price || o.price < 1.60 || o.price > 3.8) continue;
            const baseP = o.name === hm ? fp.home : fp.away;
            const sEdge = baseP * o.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = o.point !== undefined ? (o.point > 0 ? `+${o.point}` : `${o.point}`) : '';
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${o.name} ${pt}`, o.price,
                `Handicap | ${bk.title}: ${o.price} | ${ko}`, Math.round(baseP*100), sEdge * 0.20, kickoffTime, bk.title);
            }
          }
          break;
        }
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ ${league.name}: ${err.message}` });
    }
  }

  // Tag alle prematch picks als 'pre'
  for (const p of picks)     p.scanType = 'pre';
  for (const p of combiPool) p.scanType = 'pre';

  emit({ log: `📋 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} pre-match picks` });

  // ── STAP 2b: LIVE PICKS mengen ───────────────────────────────────────────
  // Haalt live wedstrijden op met xG + live odds. Picks getagd als scanType:'live'.
  // Geen eigen Telegram — alles gaat samen in de finale pool.
  emit({ log: '🔴 Live wedstrijden checken...' });
  try {
    const livePicks = await getLivePicks(emit, calib.epBuckets || {});
    for (const lp of livePicks) {
      picks.push(lp);
      combiPool.push(lp);
    }
    emit({ log: `✅ ${livePicks.length} live pick(s) toegevoegd aan pool` });
  } catch (e) {
    emit({ log: `⚠️ Live check overgeslagen: ${e.message}` });
  }

  emit({ log: `📋 Totaal ${picks.length} kandidaten (pre + live) | Combi's berekenen...` });

  // ── STAP 3: COMBI'S (2-beners + 3-beners) ───────────────────────────────
  // Alle EV+ picks (ook odds < 1.60) komen in de combiPool.
  // Singles (>= 1.60), 2-beners en 3-beners worden in één pool gegooid.
  // Sortering op hitrate (ep) — hoogste kans wint, ongeacht of het single/combi is.
  // Eindkoers altijd 1.60–MAX_WINNER_ODDS. Geen leg-minimum voor combis.
  const combiLegs = combiPool.filter(p => p.kelly > 0.02 && !p.label.startsWith('🎯'));

  const makeCombi = (legs) => {
    // Geen twee legs uit zelfde wedstrijd
    const matches = new Set(legs.map(p => p.match));
    if (matches.size < legs.length) return;
    const co  = +legs.reduce((acc, p) => acc * p.odd, 1).toFixed(2);
    if (co < 1.60 || co > MAX_WINNER_ODDS) return;
    const ep  = +legs.reduce((acc, p) => acc * p.ep, 1).toFixed(3);
    if (ep < MIN_EP) return;
    const kc  = ((ep*(co-1)) - (1-ep)) / (co-1);
    if (kc <= 0.015) return;
    const hkc = kc * KELLY_FRACTION;
    const legStr = legs.map(p => `${Math.round(p.ep*100)}%`).join('×');
    const oddsStr = legs.map(p => p.odd).join('×');
    picks.push({
      match:   legs.length === 2
        ? `COMBI: ${legs[0].match.slice(0,18)} + ${legs[1].match.slice(0,18)}`
        : `3BENER: ${legs.map(p => p.match.split(' vs ')[0].slice(0,10)).join('+')}`,
      league:  'Multi',
      label:   legs.map(p => p.label).join(' + '),
      odd:     co,
      units:   hkc > 0.06 ? '0.5U' : '0.3U',
      reason:  `${oddsStr}=${co} | Hitrate: ${Math.round(ep*100)}% (${legStr})`,
      prob:    Math.round(ep * 100),
      ep,
      strength: kc*(co-1)*(legs.length === 3 ? 0.65 : 0.75), // 3-bener iets conservatiever
      kelly:   hkc,
      edge:    Math.round((ep*co-1)*100*10)/10,
      isCombi: true,
      legs:    legs.length,
    });
  };

  // 2-beners
  for (let i = 0; i < combiLegs.length - 1; i++)
    for (let j = i + 1; j < combiLegs.length; j++)
      makeCombi([combiLegs[i], combiLegs[j]]);

  // 3-beners (alleen als genoeg kandidaten, om explosie te beperken)
  if (combiLegs.length >= 3 && combiLegs.length <= 12) {
    for (let i = 0; i < combiLegs.length - 2; i++)
      for (let j = i + 1; j < combiLegs.length - 1; j++)
        for (let k2 = j + 1; k2 < combiLegs.length; k2++)
          makeCombi([combiLegs[i], combiLegs[j], combiLegs[k2]]);
  }

  // ── SORT + DEDUP + CONFIDENCE FILTER ─────────────────────────────────────
  // Primair: ep (hitrate) aflopend. Bij gelijke hitrate: strength als tiebreaker.
  // MIN_CONFIDENCE bewaakt dat picks echt EV+ zijn, niet alleen hoge hitrate.
  const MIN_CONFIDENCE = 0.025;

  const seen2 = new Set();
  const allCandidates = picks
    .filter(p => { const k=p.match+'|'+p.label; if(seen2.has(k)) return false; seen2.add(k); return true; })
    .filter(p => p.strength >= MIN_CONFIDENCE)
    .sort((a,b) => b.expectedEur - a.expectedEur || b.ep - a.ep); // meeste verwachte winst bovenaan

  const finalPicks = allCandidates.slice(0, 5);

  const weakCount = allCandidates.length - finalPicks.length;

  if (finalPicks.length === 0) {
    const noMsg = allCandidates.length > 0
      ? `🌅 Dagelijkse Pre-Match Scan\n\n🚫 Geen overtuigde picks.\n${allCandidates.length} kandidaat(en) gevonden maar te zwak (min. confidence niet gehaald).\nGeanalyseerd: ${totalEvents} wedstrijden`
      : `🌅 Dagelijkse Pre-Match Scan\n\nGeen kwalificerende picks gevonden.\nGeanalyseerd: ${totalEvents} wedstrijden | Min. odds: 1.60`;
    await tg(noMsg);
    emit({ log: `📭 Geen overtuigde picks (${allCandidates.length} kandidaten te zwak). Bericht gestuurd.`, picks: [] });
    return [];
  }

  const weakNote = weakCount > 0 ? ` (${weakCount} zwakke kandidaat${weakCount>1?'en':''} weggelaten)` : '';
  emit({ log: `🎯 ${finalPicks.length} overtuigde pick${finalPicks.length>1?'s':''}${weakNote}! Sturen naar Telegram...` });

  // ── TELEGRAM BERICHTEN ─────────────────────────────────────────────────────
  const today = new Date().toLocaleDateString('nl-NL',{day:'2-digit',month:'long',year:'numeric'});
  const pickWord = finalPicks.length === 1 ? 'OVERTUIGDE PICK' : `${finalPicks.length} OVERTUIGDE PICKS`;
  const header = `🌅 DAGELIJKSE PRE-MATCH SCAN\n📅 ${today}\n📊 ${totalEvents} wedstrijden geanalyseerd\n✅ ${pickWord} (van ${allCandidates.length} kandidaten)\n\n`;

  let msgs = [header];
  let cur  = 0;
  for (const [i, p] of finalPicks.entries()) {
    const star = i === 0 ? '⭐' : i === 1 ? '🔵' : '•';
    const typeTag = p.scanType === 'live' ? ' 🔴LIVE' : ' 🌅PRE';
    const line = `${star} PICK ${i+1}${typeTag}: ${p.match}\n${p.league}\n📌 ${p.label}\n💰 Odds: ${p.odd} | ${p.units}\n📈 Kans: ${p.prob}%\n📊 ${p.reason}\n\n`;
    if ((msgs[cur]||'').length + line.length > 3900) { cur++; msgs.push(''); }
    msgs[cur] = (msgs[cur]||'') + line;
  }
  for (const msg of msgs) { if (msg.trim()) await tg(msg); }

  lastPrematchPicks = finalPicks;
  saveScanEntry(finalPicks, 'prematch', totalEvents);
  emit({ log: `✅ Klaar! ${msgs.length} Telegram bericht(en) gestuurd.`, picks: finalPicks });

  // ── Upgrade / unit-size check na scan ────────────────────────────────────
  try {
    const cs = loadCalib();
    const { stats } = await readBets().catch(() => ({ stats: {} }));
    const bkr = stats.bankroll ?? START_BANKROLL;
    const bkrGrowth = bkr - START_BANKROLL;
    const roi2 = stats.roi ?? 0;
    if (bkrGrowth >= START_BANKROLL) {
      await tg(`💰 UNIT VERHOGING AANBEVOLEN\nBankroll: €${bkr.toFixed(0)} (+100%)\nOverweeg unit van €${UNIT_EUR} → €${UNIT_EUR*2}\n\nAccepteer via de instellingen.`).catch(()=>{});
    } else if (cs.totalSettled >= 30 && roi2 > 0.10) {
      await tg(`🚀 ROI ${(roi2*100).toFixed(1)}% over ${cs.totalSettled} bets.\nOverweeg All Sports upgrade ($99/mnd) voor meer markten.`).catch(()=>{});
    }
  } catch {}


  // ── Wekelijkse portfolio-analyse (elke zondag of elke 7e scan) ───────────
  const c = loadCalib();
  if (c.totalSettled > 0 && c.totalSettled % 7 === 0) {
    await runPortfolioAnalysis();
  }

  return finalPicks;
}

// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE PICKS HELPER — haalt live wedstrijden op + analyseert met xG + live odds
// Stille functie: geen eigen Telegram. Geeft picks terug getagd als scanType:'live'.
// Wordt aangeroepen vanuit runPrematch (gecombineerde scan) én vanuit runLive (dagelijks).
// ═══════════════════════════════════════════════════════════════════════════════
async function getLivePicks(emit, calibEpBuckets = {}) {
  const topLeagueIds = new Set(AF_FOOTBALL_LEAGUES.map(l => l.id));
  const { picks, combiPool, mkP } = buildPickFactory(1.50, calibEpBuckets);

  const liveFixtures = await afGet('v3.football.api-sports.io', '/fixtures', { live: 'all' });
  const candidates = liveFixtures
    .filter(f => topLeagueIds.has(f.league?.id))
    .slice(0, 12);

  emit({ log: `📡 Live: ${liveFixtures.length} wedstrijden | ${candidates.length} topcompetities` });
  if (!candidates.length) return [];

  const enriched = await Promise.all(candidates.map(async f => {
    const fid = f.fixture?.id;
    const [stats, liveOddsData] = await Promise.all([
      afGet('v3.football.api-sports.io', '/fixtures/statistics', { fixture: fid }),
      afGet('v3.football.api-sports.io', '/odds/live',           { fixture: fid }).catch(() => []),
    ]);
    await sleep(150);

    const getStat = (team, name) => {
      const ts = stats.find(s => s.team?.id === team?.id);
      return parseInt(ts?.statistics?.find(s => s.type === name)?.value || '0') || 0;
    };

    const hTeam = f.teams?.home, aTeam = f.teams?.away;
    const hG = f.goals?.home ?? 0, aG = f.goals?.away ?? 0;
    const min = f.fixture?.status?.elapsed || 0;

    const sotH  = getStat(hTeam, 'Shots on Goal');
    const sotA  = getStat(aTeam, 'Shots on Goal');
    const posH  = getStat(hTeam, 'Ball Possession');
    const cornH = getStat(hTeam, 'Corner Kicks');
    const cornA = getStat(aTeam, 'Corner Kicks');
    const dangH = getStat(hTeam, 'Blocked Shots') + sotH;
    const dangA = getStat(aTeam, 'Blocked Shots') + sotA;

    const xgH     = +(sotH * 0.33 + cornH * 0.05).toFixed(2);
    const xgA     = +(sotA * 0.33 + cornA * 0.05).toFixed(2);
    const xgTotal = xgH + xgA;

    // Live odds ophalen (bet365 of eerste bookmaker)
    const rawBks  = liveOddsData?.[0]?.bookmakers || [];
    const bet365  = rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
    const liveOdds = bet365 ? convertAfOdds([bet365], hTeam?.name || 'Home', aTeam?.name || 'Away') : [];

    return { f, fid, hTeam, aTeam, hG, aG, min,
             sotH, sotA, posH, cornH, cornA, xgH, xgA, xgTotal, dangH, dangA, liveOdds };
  }));

  for (const d of enriched) {
    const { f, fid, hTeam, aTeam, hG, aG, min,
            sotH, sotA, posH, xgH, xgA, xgTotal, dangH, dangA, liveOdds } = d;

    if (min < 15 || min > 82) continue;

    const hm    = hTeam?.name || 'Thuis';
    const aw    = aTeam?.name || 'Uit';
    const lg    = f.league?.name || 'Football';
    const score = `${hG}-${aG}`;

    // Haal live odds op voor specifieke markten
    const h2h    = liveOdds.find(bk => bk.markets?.find(m => m.key === 'h2h'))?.markets?.find(m => m.key === 'h2h');
    const ouMkt  = liveOdds.find(bk => bk.markets?.find(m => m.key === 'totals'))?.markets?.find(m => m.key === 'totals');

    const liveH  = h2h?.outcomes?.find(o => o.name === hm)?.price;
    const liveA  = h2h?.outcomes?.find(o => o.name === aw)?.price;
    const liveOv = ouMkt?.outcomes?.find(o => o.name === 'Over' && Math.abs((o.point||2.5)-2.5)<0.01)?.price;
    const liveUn = ouMkt?.outcomes?.find(o => o.name === 'Under' && Math.abs((o.point||2.5)-2.5)<0.01)?.price;

    const xgEdge  = xgH - xgA;
    const reason  = (xg, sot, dom) =>
      `xG: ${xg.toFixed(1)} | SoT: ${sot} | Bezit: ${dom}% | ${score} in ${min}' · ${lg}`;

    // Scenario 1: xG-dominantie vs. score — value op dominerend team dat verliest/gelijkspeelt
    if (hG <= aG && xgEdge > 0.8 && min < 70 && liveH) {
      const boost = clamp(xgEdge * 0.10, 0, 0.18);
      mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `🔄 ${hm} keert terug`, liveH,
        reason(xgH, sotH, posH), clamp(40+xgEdge*10,38,68), boost);
    }
    if (aG <= hG && -xgEdge > 0.8 && min < 70 && liveA) {
      const boost = clamp((-xgEdge) * 0.10, 0, 0.18);
      mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `🔄 ${aw} keert terug`, liveA,
        reason(xgA, sotA, 100-posH), clamp(40+(-xgEdge)*10,38,68), boost);
    }

    // Scenario 2: Hoge xG, weinig goals → Over 2.5
    if (xgTotal > 2.4 && (hG+aG) < 2 && min < 65 && liveOv) {
      const boost = clamp((xgTotal-2.4)*0.07, 0, 0.15);
      mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `📈 Over 2.5 (xG ${xgTotal.toFixed(1)})`, liveOv,
        `xG total: ${xgTotal.toFixed(1)} | ${score} in ${min}' | SoT: ${sotH}+${sotA}`,
        clamp(45+(xgTotal-2.4)*12,42,72), boost);
    }

    // Scenario 3: Lage xG, 0-0 voor rust → Under 2.5
    if (xgTotal < 0.8 && (hG+aG) === 0 && min > 35 && min < 45 && liveUn) {
      const boost = clamp((0.8-xgTotal)*0.10, 0, 0.15);
      mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `🔒 Under 2.5 (lage xG)`, liveUn,
        `xG: ${xgTotal.toFixed(1)} | ${score} in ${min}' | SoT: ${sotH}+${sotA}`,
        clamp(55+(0.8-xgTotal)*20,48,70), boost);
    }

    // Scenario 4: Extreme druk maar scoreloos
    if (dangH > dangA*2.5 && (hG+aG) === 0 && min > 20 && min < 70 && liveH) {
      mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `⚡ ${hm} scoort (druk ${(dangH/Math.max(1,dangA)).toFixed(1)}:1)`, liveH,
        `Gevaarlijk: ${dangH}vs${dangA} | xG ${xgH.toFixed(1)}-${xgA.toFixed(1)} | ${score} in ${min}'`,
        clamp(50+dangH*2.5,45,72), dangH*0.01);
    }
    if (dangA > dangH*2.5 && (hG+aG) === 0 && min > 20 && min < 70 && liveA) {
      mkP(`${hm} vs ${aw}`, `🔴 Live · ${lg}`, `⚡ ${aw} scoort (druk ${(dangA/Math.max(1,dangH)).toFixed(1)}:1)`, liveA,
        `Gevaarlijk: ${dangA}vs${dangH} | xG ${xgA.toFixed(1)}-${xgH.toFixed(1)} | ${score} in ${min}'`,
        clamp(50+dangA*2.5,45,72), dangA*0.01);
    }
  }

  // Tag alle picks als 'live' en geef terug
  return picks.map(p => ({ ...p, scanType: 'live', fixtureId: undefined }));
}

// ── DAGELIJKSE LIVE CHECK (vanuit cron) ──────────────────────────────────────
async function runLive(emit) {
  emit({ log: '🔴 Live scan — xG + live odds + balbezit' });
  const calib = loadCalib();
  const livePicks = await getLivePicks(emit, calib.epBuckets || {});

  if (!livePicks.length) {
    await tg(`🔴 Live check — geen kwalificerende situaties op dit moment.`).catch(()=>{});
    emit({ log: '📭 Geen picks.', picks: [] });
    return [];
  }

  const time = new Date().toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
  let msgs = [`🔴 LIVE — ${time}\n${livePicks.length} pick(s)\n\n`], cur = 0;
  for (const [i, p] of livePicks.entries()) {
    const star = i === 0 ? '⭐' : '🔵';
    const line = `${star} ${p.match}\n${p.league}\n📌 ${p.label}\n💰 ${p.odd} | ${p.units} | ${p.prob}% kans\n📊 ${p.reason}\n\n`;
    if ((msgs[cur]||'').length + line.length > 3900) { cur++; msgs.push(''); }
    msgs[cur] = (msgs[cur]||'') + line;
  }
  for (const msg of msgs) if (msg.trim()) await tg(msg).catch(()=>{});

  lastLivePicks = livePicks;
  emit({ log: `✅ ${livePicks.length} live pick(s) gestuurd.`, picks: livePicks });
  return livePicks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BET TRACKER — GOOGLE SHEETS
// ═══════════════════════════════════════════════════════════════════════════════

function calcStats(bets, startBankroll = START_BANKROLL, unitEur = UNIT_EUR) {
  const W     = bets.filter(b => b.uitkomst === 'W').length;
  const L     = bets.filter(b => b.uitkomst === 'L').length;
  const open  = bets.filter(b => b.uitkomst === 'Open').length;
  const total = bets.length;
  const wlEur = bets.reduce((s, b) => s + (b.uitkomst !== 'Open' ? b.wl : 0), 0);
  const totalInzet = bets.filter(b => b.uitkomst !== 'Open').reduce((s, b) => s + b.inzet, 0);
  const roi   = totalInzet > 0 ? wlEur / totalInzet : 0;
  const bankroll  = startBankroll + wlEur;
  const avgOdds   = total > 0 ? +(bets.reduce((s,b)=>s+b.odds,0)/total).toFixed(3) : 0;
  const avgUnits  = total > 0 ? +(bets.reduce((s,b)=>s+b.units,0)/total).toFixed(2) : 0;
  const strikeRate = (W+L) > 0 ? Math.round(W/(W+L)*100) : 0;
  const winU  = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>s+(b.wl/unitEur),0).toFixed(2);
  const lossU = +bets.filter(b=>b.uitkomst==='L').reduce((s,b)=>s+(b.wl/unitEur),0).toFixed(2);
  return { total, W, L, open, wlEur: +wlEur.toFixed(2), roi: +roi.toFixed(4),
           bankroll: +bankroll.toFixed(2), startBankroll, avgOdds, avgUnits, strikeRate, winU, lossU };
}

async function readBets() {
  const sh  = getSheetsClient();
  const { tab } = await getSheetMeta();
  const res = await sh.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:M500`,
  });
  const data = res.data.values || [];

  const bets = [];
  for (let i = BET_START_ROW - 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0]) continue;
    const nr = parseFloat(row[0]);
    if (isNaN(nr)) continue;
    const pf = v => parseFloat(String(v||'').replace(',','.')) || 0;
    bets.push({
      id:        nr,
      datum:     row[1]  || '',
      sport:     row[2]  || '',
      wedstrijd: row[3]  || '',
      markt:     row[4]  || '',
      odds:      pf(row[5]),
      units:     pf(row[6]),
      inzet:     pf(row[7]) || +(pf(row[6]) * UNIT_EUR).toFixed(2),
      tip:       row[8]  || 'Main',
      uitkomst:  row[9]  || 'Open',
      wl:        pf(row[10]),
      tijd:      row[11] || '',
      score:     parseInt(row[12]) || null
    });
  }
  return { bets, stats: calcStats(bets), _raw: data };
}

async function writeBet(bet) {
  const sh  = getSheetsClient();
  const { tab } = await getSheetMeta();
  const inzet = bet.units * UNIT_EUR;
  const wl    = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2)
              : bet.uitkomst === 'L' ? -inzet : 0;
  await sh.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${BET_START_ROW}`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[
      bet.id, bet.datum, bet.sport, bet.wedstrijd, bet.markt,
      bet.odds, bet.units, inzet, bet.tip||'Main', bet.uitkomst||'Open', wl, bet.tijd||'', bet.score||''
    ]] },
  });
}

async function updateBetOutcome(id, uitkomst) {
  const sh  = getSheetsClient();
  const { tab } = await getSheetMeta();
  const { _raw } = await readBets();

  const pf = v => parseFloat(String(v||'').replace(',','.')) || 0;
  for (let i = BET_START_ROW - 1; i < _raw.length; i++) {
    if (parseFloat(_raw[i]?.[0]) !== parseFloat(id)) continue;
    const odds  = pf(_raw[i][5]);
    const units = pf(_raw[i][6]);
    const inzet = pf(_raw[i][7]) || +(units * UNIT_EUR).toFixed(2);
    const wl    = uitkomst === 'W' ? +((odds-1)*inzet).toFixed(2) : uitkomst === 'L' ? -inzet : 0;
    const rowNum = i + 1; // 1-gebaseerd
    await sh.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${tab}!J${rowNum}:K${rowNum}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[uitkomst, wl]] },
    });
    updateCalibration({ datum: _raw[i][1], wedstrijd: _raw[i][3], markt: _raw[i][4],
                        odds, units: parseFloat(_raw[i][6])||1, uitkomst, wl });
    break;
  }
}

async function deleteBet(id) {
  const sh  = getSheetsClient();
  const { tab, gid } = await getSheetMeta();
  const { _raw } = await readBets();

  for (let i = BET_START_ROW - 1; i < _raw.length; i++) {
    if (parseFloat(_raw[i]?.[0]) !== parseFloat(id)) continue;
    await sh.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteDimension: {
        range: { sheetId: gid, dimension: 'ROWS', startIndex: i, endIndex: i + 1 }
      }}] },
    });
    break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── AUTH ROUTES ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    const users = await loadUsers();
    const user  = users.find(u => u.email === email.toLowerCase());
    if (!user)                        return res.status(401).json({ error: 'Onbekend e-mailadres' });
    if (user.status === 'blocked')    return res.status(403).json({ error: 'Account geblokkeerd — neem contact op' });
    if (user.status === 'pending')    return res.status(403).json({ error: 'Account wacht op goedkeuring' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Onjuist wachtwoord' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, settings: user.settings } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    if (password.length < 8)  return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });
    await ensureUsersTab();
    const users = await loadUsers(true);
    if (users.find(u => u.email === email.toLowerCase()))
      return res.status(409).json({ error: 'E-mailadres al in gebruik' });
    const hash = await bcrypt.hash(password, 10);
    await saveUser({
      id: crypto.randomUUID(), email: email.toLowerCase(), passwordHash: hash,
      role: 'user', status: 'pending',
      settings: defaultSettings(), createdAt: new Date().toISOString()
    });
    tg(`🆕 Nieuwe registratie: ${email}\nGoedkeuren via Admin-panel`).catch(() => {});
    res.json({ message: 'Registratie ontvangen — wacht op goedkeuring van admin' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const users = await loadUsers();
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    res.json({ id: user.id, email: user.email, role: user.role, settings: user.settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── USER SETTINGS ──────────────────────────────────────────────────────────────
app.get('/api/user/settings', async (req, res) => {
  try {
    const users = await loadUsers();
    const user  = users.find(u => u.id === req.user.id);
    res.json(user?.settings || defaultSettings());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/user/settings', async (req, res) => {
  try {
    const users = await loadUsers(true);
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const allowed = ['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled'];
    allowed.forEach(k => { if (req.body[k] !== undefined) user.settings[k] = req.body[k]; });
    await saveUser(user);
    // Herplan scans als admin
    if (user.role === 'admin') rescheduleUserScans(user);
    res.json({ settings: user.settings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/auth/password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Huidig en nieuw wachtwoord verplicht' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Nieuw wachtwoord minimaal 8 tekens' });
    const users = await loadUsers(true);
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Huidig wachtwoord onjuist' });
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    await saveUser(user);
    res.json({ message: 'Wachtwoord gewijzigd' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers(true);
    res.json(users.map(u => ({ id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers(true);
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    if (req.body.status) user.status = req.body.status;
    if (req.body.role)   user.role   = req.body.role;
    await saveUser(user);
    if (req.body.status === 'approved')
      tg(`✅ Account goedgekeurd: ${user.email}`).catch(() => {});
    res.json({ id: user.id, email: user.email, role: user.role, status: user.status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers(true);
    const idx   = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    if (users[idx].email === req.user.email)
      return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
    const sh = getSheetsClient();
    await sh.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: { requests: [{ deleteDimension: {
        range: { sheetId: await getUsersSheetGid(), dimension: 'ROWS', startIndex: idx + 1, endIndex: idx + 2 }
      }}] }
    });
    _usersCache = null;
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function getUsersSheetGid() {
  const sh   = getSheetsClient();
  const meta = await sh.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets?.find(s => s.properties?.title === USER_TAB)?.properties?.sheetId ?? 1;
}

// Prematch scan — SSE streaming (inclusief live check op moment van draaien)
app.post('/api/prematch', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  runPrematch(emit)
    .then(picks => { emit({ done: true, picks: picks.map(p => ({ match: p.match, league: p.league, label: p.label, odd: p.odd, prob: p.prob, units: p.units, reason: p.reason, kelly: p.kelly, ep: p.ep, edge: p.edge, strength: p.strength, expectedEur: p.expectedEur, kickoff: p.kickoff, scanType: p.scanType, bookie: p.bookie })) }); res.end(); })
    .catch(err  => { emit({ error: err.message }); res.end(); });
});

// Live scan — SSE streaming
app.post('/api/live', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  runLive(emit)
    .then(picks => { emit({ done: true, picks: picks.map(p => ({ match: p.match, league: p.league, label: p.label, odd: p.odds||p.odd, prob: p.prob, units: p.units, reason: p.reason })) }); res.end(); })
    .catch(err  => { emit({ error: err.message }); res.end(); });
});

// Bets ophalen
app.get('/api/bets', async (req, res) => {
  try {
    const { bets, _raw } = await readBets();
    // Gebruik user-specifieke instellingen voor stats
    const users = await loadUsers().catch(() => []);
    const user  = users.find(u => u.id === req.user?.id);
    const sb = user?.settings?.startBankroll ?? START_BANKROLL;
    const ue = user?.settings?.unitEur       ?? UNIT_EUR;
    res.json({ bets, stats: calcStats(bets, sb, ue), _raw });
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Bet toevoegen
// ── PRE-KICKOFF CHECK — 30 min voor aftrap ───────────────────────────────────
// Haalt huidige odds op voor het specifieke event en vergelijkt met gelogde odds.
// Stuurt Telegram ping als: odds gedrift >8%, of als aftrap veranderd is.
async function schedulePreKickoffCheck(bet) {
  // Live bets zijn al bezig — geen pre-kickoff check nodig
  if (bet.scanType === 'live') return;

  // Probeer aftrap-tijdstip uit de bet te halen (veld 'datum' = datum, 'tijd' = HH:MM)
  const tijdStr = bet.tijd || bet.time; // "HH:MM" of ISO
  if (!tijdStr) return;

  let kickoffMs;
  try {
    if (tijdStr.includes('T') || tijdStr.includes('-')) {
      kickoffMs = new Date(tijdStr).getTime();
    } else {
      // "HH:MM" — combineer met datum van vandaag/morgen
      const [h, m] = tijdStr.split(':').map(Number);
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); // morgen
      kickoffMs = d.getTime();
    }
  } catch { return; }

  const checkMs = kickoffMs - 30 * 60 * 1000; // 30 min voor aftrap
  const delayMs = checkMs - Date.now();
  if (delayMs < 5000 || delayMs > 48 * 60 * 60 * 1000) return; // te laat of te ver weg

  setTimeout(async () => {
    try {
      const loggedOdds = parseFloat(bet.odds);
      const matchName  = bet.wedstrijd || '';
      const markt      = bet.markt || '';
      const lines      = [];

      // Haal huidige odds op via api-football.com
      let currentOdds = null;
      if (bet.fixtureId) {
        // fixtureId is opgeslagen bij het loggen van de bet via de scan
        try {
          const oddsData = await afGet('v3.football.api-sports.io', '/odds', { fixture: bet.fixtureId });
          const rawBks   = oddsData?.[0]?.bookmakers || [];
          const bet365   = rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
          if (bet365) {
            const mw = bet365.bets?.find(b => b.id === 1); // Match Winner
            if (mw) {
              const isHome = markt.includes('🏠') || !markt.includes('✈️');
              const side   = isHome ? 'Home' : 'Away';
              const val    = mw.values?.find(v => v.value === side || v.value === 'Draw');
              if (val) currentOdds = parseFloat(val.odd) || null;
            }
          }
        } catch {}
      }

      // Beoordeling
      const time30 = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
      lines.push(`⏰ PRE-KICKOFF CHECK\n📌 ${matchName} (aftrap ~${time30})\n🎲 Markt: ${markt}`);

      if (currentOdds) {
        const drift = (currentOdds - loggedOdds) / loggedOdds;
        const driftPct = (drift * 100).toFixed(1);
        const driftStr = drift >= 0 ? `+${driftPct}%` : `${driftPct}%`;

        if (Math.abs(drift) >= 0.08) {
          lines.push(`\n⚠️ ODDS GEDRIFT: ${loggedOdds} → ${currentOdds} (${driftStr})`);
          if (drift < -0.08) lines.push(`📉 Odds gedaald — markt wordt zekerder van het ANDERE resultaat. Overweeg de bet te annuleren.`);
          else lines.push(`📈 Odds gestegen — meer waarde dan verwacht. Bet ziet er goed uit.`);
        } else {
          lines.push(`\n✅ Odds stabiel: ${loggedOdds} → ${currentOdds} (${driftStr}) — geen significante marktbeweging.`);
        }
      } else {
        lines.push(`\n⚠️ Kon geen huidige odds ophalen — controleer odds handmatig.`);
      }

      lines.push(`\n🟢 Succes! (automatische check 30 min voor aftrap)`);
      await tg(lines.join('\n'));
    } catch (err) {
      console.error('Pre-kickoff check error:', err.message);
    }
  }, delayMs);

  console.log(`⏱  Pre-kickoff check gepland voor "${bet.wedstrijd}" over ${Math.round(delayMs/60000)} min`);
}

app.post('/api/bets', async (req, res) => {
  try {
    const { bets } = await readBets();
    const nextId = bets.length > 0 ? Math.max(...bets.map(b => b.id)) + 1 : 1;
    const newBet = { ...req.body, id: nextId };
    await writeBet(newBet);
    schedulePreKickoffCheck(newBet).catch(() => {}); // niet-blokkerend
    res.json(await readBets());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Uitkomst updaten
app.put('/api/bets/:id', async (req, res) => {
  try {
    await updateBetOutcome(req.params.id, req.body.uitkomst);
    res.json(await readBets());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// W/L herberekenen voor alle settled bets (fix na inzet-bug)
app.post('/api/bets/recalculate', async (req, res) => {
  try {
    const sh = getSheetsClient();
    const { tab } = await getSheetMeta();
    const { bets, _raw } = await readBets();
    const pf = v => parseFloat(String(v||'').replace(',','.')) || 0;
    let fixed = 0;
    for (let i = BET_START_ROW - 1; i < _raw.length; i++) {
      const row = _raw[i];
      if (!row || !row[0]) continue;
      const uitkomst = row[9] || '';
      if (uitkomst !== 'W' && uitkomst !== 'L') continue;
      const odds  = pf(row[5]);
      const units = pf(row[6]);
      const inzet = pf(row[7]) || +(units * UNIT_EUR).toFixed(2);
      const wl    = uitkomst === 'W' ? +((odds-1)*inzet).toFixed(2) : -inzet;
      const currentWl = pf(row[10]);
      if (Math.abs(currentWl - wl) < 0.01) continue; // al correct
      await sh.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!K${i+1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[wl]] },
      });
      fixed++;
      await sleep(80);
    }
    res.json({ fixed, ...(await readBets()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Bet verwijderen
app.delete('/api/bets/:id', async (req, res) => {
  try { await deleteBet(req.params.id); res.json(await readBets()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Laatste picks ophalen (voor analyse tab)
app.get('/api/picks', (req, res) => {
  res.json({ prematch: lastPrematchPicks, live: lastLivePicks });
});

// Scan history — laatste N scans met picks
app.get('/api/scan-history', (req, res) => {
  res.json(loadScanHistory());
});

// API status — rate limits
app.get('/api/status', (req, res) => {
  res.json({
    afKeySet:   !!AF_KEY,
    remaining:  afRateLimit.remaining,
    limit:      afRateLimit.limit,
    updatedAt:  afRateLimit.updatedAt,
  });
});

// Versie info
app.get('/api/version', (req, res) => {
  const c = loadCalib();
  res.json({
    version:          APP_VERSION,
    modelLog:         (c.modelLog || []).slice(0, 10),
    modelLastUpdated: c.modelLastUpdated || null,
  });
});

// Notifications — API alerts + calibratie inzichten
app.get('/api/notifications', async (req, res) => {
  try {
    const alerts = [];
    const c = loadCalib();

    const { stats } = await readBets().catch(() => ({ stats: {} }));
    const roi = stats.roi ?? 0;
    const bankroll = stats.bankroll ?? START_BANKROLL;
    const bankrollGrowth = bankroll - START_BANKROLL;

    // Unit size aanbeveling op basis van bankroll groei
    if (bankrollGrowth >= START_BANKROLL) {
      alerts.push({ type: 'success', icon: '💰', msg: `Bankroll +100% (€${bankroll.toFixed(0)}) — unit verhoging aanbevolen: €${UNIT_EUR} → €${UNIT_EUR*2}`, unitAdvice: true });
    } else if (bankrollGrowth >= START_BANKROLL * 0.5) {
      alerts.push({ type: 'info', icon: '💰', msg: `Bankroll +50% (€${bankroll.toFixed(0)}) — overweeg unit van €${UNIT_EUR} naar €${Math.round(UNIT_EUR*1.5)}`, unitAdvice: true });
    }

    // All Sports ($99/mnd) upgrade aanbeveling
    if (c.totalSettled >= 30 && roi > 0.10) {
      alerts.push({ type: 'success', icon: '🚀', msg: `ROI ${(roi*100).toFixed(1)}% over ${c.totalSettled} bets — api-sports All Sports ($99/mnd) betaalt zich terug.` });
    } else if (c.totalSettled >= 20 && roi > 0.05) {
      alerts.push({ type: 'info', icon: '💡', msg: `ROI ${(roi*100).toFixed(1)}% — winstgevend! Wacht tot 30+ bets voor All Sports upgrade.` });
    }

    if (c.lossLog?.length >= 5) {
      const byMarket = {};
      for (const l of c.lossLog.slice(0, 20)) byMarket[l.market] = (byMarket[l.market]||0) + 1;
      const worst = Object.entries(byMarket).sort((a,b) => b[1]-a[1])[0];
      if (worst?.[1] >= 3) {
        alerts.push({ type: 'warn', icon: '⚠️', msg: `${worst[1]}x verlies in "${worst[0]}" picks (laatste 20 bets) — model drempel verhoogd.` });
      }
    }

    for (const [mk, v] of Object.entries(c.markets)) {
      if (v.n >= 8 && v.multiplier <= 0.75) {
        alerts.push({ type: 'warn', icon: '📉', msg: `"${mk}" picks: ${v.w}/${v.n} gewonnen — model filtert strenger.` });
      } else if (v.n >= 10 && v.multiplier >= 1.15) {
        alerts.push({ type: 'success', icon: '📈', msg: `"${mk}" picks presteren goed (${v.w}/${v.n}) — model vertrouwt dit signaal meer.` });
      }
    }

    // Model update notificaties (laatste 3, maximaal 14 dagen oud)
    const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const entry of (c.modelLog || []).slice(0, 3)) {
      if (new Date(entry.date).getTime() < cutoff) break;
      const dir = entry.newMult > entry.oldMult ? '📈' : '📉';
      alerts.push({
        type:        'model',
        icon:        dir,
        msg:         `Model update: ${entry.note} (${entry.oldMult.toFixed(2)}→${entry.newMult.toFixed(2)})`,
        date:        entry.date,
        modelUpdate: true,
      });
    }

    res.json({ alerts, totalSettled: c.totalSettled, lastUpdated: c.lastUpdated, modelLastUpdated: c.modelLastUpdated || null });
  } catch (e) { res.status(500).json({ alerts: [], error: e.message }); }
});

// ── CHECK UITSLAGEN — standalone functie (gebruikt door route én dagelijkse cron) ──
async function checkOpenBetResults() {
  const { bets } = await readBets();
  const openBets = bets.filter(b => b.uitkomst === 'Open');
  if (!openBets.length) return { checked: 0, updated: 0, results: [] };

  const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
  const espnGet = url => fetch(url, { headers: { Accept: 'application/json' } }).then(r => r.json()).catch(() => ({}));

  const sources = [
    { url: `${ESPN}/soccer/eng.1/scoreboard` }, { url: `${ESPN}/soccer/esp.1/scoreboard` },
    { url: `${ESPN}/soccer/ger.1/scoreboard` }, { url: `${ESPN}/soccer/ita.1/scoreboard` },
    { url: `${ESPN}/soccer/fra.1/scoreboard` }, { url: `${ESPN}/soccer/ned.1/scoreboard` },
    { url: `${ESPN}/soccer/por.1/scoreboard` }, { url: `${ESPN}/soccer/tur.1/scoreboard` },
    { url: `${ESPN}/soccer/eng.2/scoreboard` },
    { url: `${ESPN}/soccer/uefa.champions/scoreboard` }, { url: `${ESPN}/soccer/uefa.europa/scoreboard` },
    { url: `${ESPN}/basketball/nba/scoreboard` },
    { url: `${ESPN}/hockey/nhl/scoreboard` },
    { url: `${ESPN}/baseball/mlb/scoreboard` },
  ];

  const raw = await Promise.all(sources.map(async src => {
    const d = await espnGet(src.url);
    return (d.events || []).map(ev => {
      const comp = ev.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === 'home');
      const away = comp?.competitors?.find(c => c.homeAway === 'away');
      const status = ev.status?.type;
      if (!home || !away || !status?.completed) return null;
      return { home: home.team?.displayName||'', away: away.team?.displayName||'',
               scoreH: parseInt(home.score||'0'), scoreA: parseInt(away.score||'0') };
    }).filter(Boolean);
  }));
  const allFinished = raw.flat();

  const results = [];
  for (const bet of openBets) {
    const parts = (bet.wedstrijd||'').split(' vs ').map(s => s.trim().toLowerCase());
    if (parts.length < 2) continue;
    const [hmQ, awQ] = parts;
    const ev = allFinished.find(e => {
      const h = e.home.toLowerCase(), a = e.away.toLowerCase();
      return (h.includes(hmQ) || hmQ.includes(h.split(' ').pop())) &&
             (a.includes(awQ) || awQ.includes(a.split(' ').pop()));
    });
    if (!ev) continue;

    const markt = (bet.markt||'').toLowerCase();
    const total = ev.scoreH + ev.scoreA;
    let uitkomst = null;

    if      (markt.includes('over 2.5')  || markt.includes('over2.5'))  uitkomst = total > 2 ? 'W' : 'L';
    else if (markt.includes('under 2.5') || markt.includes('under2.5')) uitkomst = total < 3 ? 'W' : 'L';
    else if (markt.includes('over 1.5')  || markt.includes('over1.5'))  uitkomst = total > 1 ? 'W' : 'L';
    else if (markt.includes('under 1.5') || markt.includes('under1.5')) uitkomst = total < 2 ? 'W' : 'L';
    else if (markt.includes('over 3.5')  || markt.includes('over3.5'))  uitkomst = total > 3 ? 'W' : 'L';
    else if (markt.includes('under 3.5') || markt.includes('under3.5')) uitkomst = total < 4 ? 'W' : 'L';
    else {
      const winnerMatch = markt.match(/(?:winner|wint)[^a-z]+([\w\s]+?)(?:\s*[\|·]|$)/i)
                       || markt.match(/→\s*([\w\s]+?)(?:\s*[\|·]|$)/i);
      if (winnerMatch) {
        const t = winnerMatch[1].trim().toLowerCase();
        const isHome = ev.home.toLowerCase().includes(t) || t.includes(ev.home.toLowerCase().split(' ').pop());
        const isAway = ev.away.toLowerCase().includes(t) || t.includes(ev.away.toLowerCase().split(' ').pop());
        if (isHome) uitkomst = ev.scoreH > ev.scoreA ? 'W' : ev.scoreH < ev.scoreA ? 'L' : null;
        else if (isAway) uitkomst = ev.scoreA > ev.scoreH ? 'W' : ev.scoreA < ev.scoreH ? 'L' : null;
      }
    }

    if (uitkomst) await updateBetOutcome(bet.id, uitkomst);
    results.push({ id: bet.id, wedstrijd: bet.wedstrijd, markt: bet.markt,
                   score: `${ev.scoreH}-${ev.scoreA}`, uitkomst,
                   note: uitkomst ? null : 'Score gevonden — update handmatig' });
  }

  return { checked: openBets.length, updated: results.filter(r => r.uitkomst).length, results };
}

// Check uitslagen route
app.get('/api/check-results', async (req, res) => {
  try {
    const result = await checkOpenBetResults();
    const { bets, stats } = await readBets();
    res.json({ ...result, bets, stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live scores via ESPN public API (gratis, geen key nodig)
app.get('/api/live-scores', async (req, res) => {
  try {
    const knownLeagueIds = new Set(AF_FOOTBALL_LEAGUES.map(l => l.id));
    const leagueNames    = Object.fromEntries(AF_FOOTBALL_LEAGUES.map(l => [l.id, l.name]));

    // Live en vandaag geplande wedstrijden ophalen in parallel
    const today = new Date().toISOString().slice(0, 10);
    const [liveFixtures, todayFixtures] = await Promise.all([
      afGet('v3.football.api-sports.io', '/fixtures', { live: 'all' }),
      afGet('v3.football.api-sports.io', '/fixtures', { date: today }),
    ]);

    const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);

    const mapFixture = (f) => {
      const statusShort = f.fixture?.status?.short || '';
      const elapsed     = f.fixture?.status?.elapsed;
      const extra       = f.fixture?.status?.extra;
      const isLive      = LIVE_STATUSES.has(statusShort);

      let minute = '';
      if (isLive) {
        if (statusShort === 'HT') minute = 'HT';
        else if (statusShort === 'BT') minute = 'ET rust';
        else if (elapsed != null) minute = extra ? `${elapsed}+${extra}'` : `${elapsed}'`;
      }

      const startTime = !isLive && f.fixture?.date
        ? new Date(f.fixture.date).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' })
        : '';

      return {
        id:        f.fixture.id,
        fixtureId: f.fixture.id,
        sport:     'football',
        league:    leagueNames[f.league?.id] || f.league?.name || '',
        leagueId:  f.league?.id,
        home:      f.teams?.home?.name || '?',
        away:      f.teams?.away?.name || '?',
        homeLogo:  f.teams?.home?.logo || '',
        awayLogo:  f.teams?.away?.logo || '',
        scoreH:    isLive ? (f.goals?.home ?? 0) : null,
        scoreA:    isLive ? (f.goals?.away ?? 0) : null,
        minute,
        status:    f.fixture?.status?.long || '',
        startTime,
        live:      isLive,
      };
    };

    // Dedup op fixture ID (live heeft voorrang boven scheduled)
    const seen = new Set();
    const events = [];

    for (const f of liveFixtures) {
      if (!knownLeagueIds.has(f.league?.id)) continue;
      seen.add(f.fixture?.id);
      events.push(mapFixture(f));
    }
    for (const f of todayFixtures) {
      if (!knownLeagueIds.has(f.league?.id)) continue;
      if (seen.has(f.fixture?.id)) continue;
      if (f.fixture?.status?.short !== 'NS') continue; // alleen nog niet begonnen
      seen.add(f.fixture?.id);
      events.push(mapFixture(f));
    }

    events.sort((a, b) => {
      if (a.live !== b.live) return b.live ? 1 : -1;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });

    res.json({ events, liveCount: events.filter(e => e.live).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Live wedstrijd events + stats via api-football (rijkere data dan ESPN)
app.get('/api/live-events/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [eventsData, statsData, fixtureData] = await Promise.all([
      afGet('v3.football.api-sports.io', '/fixtures/events',     { fixture: id }),
      afGet('v3.football.api-sports.io', '/fixtures/statistics', { fixture: id }),
      afGet('v3.football.api-sports.io', '/fixtures',            { id }),
    ]);

    // ── Events (goals, kaarten, wissels) ─────────────────────────────────────
    const events = (eventsData || []).map(ev => {
      const t = ev.type || '', detail = ev.detail || '';
      let type;
      if (t === 'Goal') {
        type = detail.includes('Own Goal') ? 'owngoal' : 'goal';
      } else if (t === 'Card') {
        type = detail.includes('Yellow') ? 'yellow' : 'red';
      } else if (t === 'subst') {
        type = 'sub';
      } else { return null; }

      const min = ev.time?.elapsed != null
        ? (ev.time?.extra ? `${ev.time.elapsed}+${ev.time.extra}'` : `${ev.time.elapsed}'`)
        : '';
      return {
        type,
        minute:  min,
        team:    ev.team?.name   || '',
        player:  ev.player?.name || '',
        assist:  ev.assist?.name || '',
        detail,
      };
    }).filter(Boolean);

    // ── Fixture basisinfo ─────────────────────────────────────────────────────
    const fx     = fixtureData?.[0];
    const homeT  = fx?.teams?.home?.name  || '';
    const awayT  = fx?.teams?.away?.name  || '';
    const scoreH = fx?.goals?.home ?? null;
    const scoreA = fx?.goals?.away ?? null;
    const short  = fx?.fixture?.status?.short || '';
    const elapsed = fx?.fixture?.status?.elapsed;
    const extra   = fx?.fixture?.status?.extra;
    const minute  = short === 'HT' ? 'HT' : elapsed != null
      ? (extra ? `${elapsed}+${extra}'` : `${elapsed}'`) : '';
    const status = fx?.fixture?.status?.long || '';

    // ── Stats ─────────────────────────────────────────────────────────────────
    const homeId = fx?.teams?.home?.id;
    const statMap = {};
    for (const side of (statsData || [])) {
      const isHome = side.team?.id === homeId;
      for (const s of (side.statistics || [])) {
        if (!statMap[s.type]) statMap[s.type] = {};
        statMap[s.type][isHome ? 'home' : 'away'] = s.value ?? '—';
      }
    }

    // api-football stat keys → display keys
    const statKeyMap = [
      ['Ball Possession',   'possessionPct'],
      ['Total Shots',       'totalShots'],
      ['Shots on Goal',     'shotsOnTarget'],
      ['Blocked Shots',     'blockedShots'],
      ['Corner Kicks',      'wonCorners'],
      ['Fouls',             'foulsCommitted'],
      ['Yellow Cards',      'yellowCards'],
      ['Red Cards',         'redCards'],
      ['Offsides',          'offsides'],
      ['Goalkeeper Saves',  'saves'],
    ];
    const stats = statKeyMap
      .filter(([k]) => statMap[k])
      .map(([k, key]) => ({ key, home: statMap[k]?.home ?? '—', away: statMap[k]?.away ?? '—' }));

    // xG: gebruik API-waarde indien beschikbaar, anders schatting via schoten op doel
    if (statMap['expected_goals'] || statMap['Expected Goals'] || statMap['xG']) {
      const xgKey = statMap['expected_goals'] ? 'expected_goals' : statMap['xG'] ? 'xG' : 'Expected Goals';
      stats.unshift({ key: 'xG', home: statMap[xgKey]?.home ?? '—', away: statMap[xgKey]?.away ?? '—' });
    } else if (statMap['Shots on Goal']) {
      const sotH2 = parseFloat(statMap['Shots on Goal']?.home) || 0;
      const sotA2 = parseFloat(statMap['Shots on Goal']?.away) || 0;
      if (sotH2 || sotA2) stats.unshift({ key: 'xG', home: (sotH2*0.33).toFixed(2), away: (sotA2*0.33).toFixed(2) });
    }

    res.json({ events, home: homeT, away: awayT, scoreH, scoreA, status, minute, stats });
  } catch (e) { res.status(500).json({ error: e.message, events: [] }); }
});

// Eenmalig: kickofftijden invullen voor bets zonder tijd
app.post('/api/backfill-times', async (req, res) => {
  try {
    const { bets, _raw } = await readBets();
    const sh  = getSheetsClient();
    const { tab } = await getSheetMeta();
    const results = [];

    for (let i = 0; i < bets.length; i++) {
      const b = bets[i];
      // altijd overschrijven zodat foute tijden gecorrigeerd worden

      // Zoek fixture op datum + teamnaam
      const [teamA] = b.wedstrijd.split(' vs ').map(t => t.trim());
      const dateStr = b.datum.split('-').reverse().join('-'); // dd-mm-yyyy → yyyy-mm-dd
      const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: dateStr });
      await sleep(200);

      const [tA, tB] = b.wedstrijd.toLowerCase().split(' vs ').map(t => t.trim());
      // Zoek fixture waar BEIDE teams (deels) matchen — voorkomt jeugd/reserve wedstrijden
      let match = fixtures.find(f => {
        const home = f.teams?.home?.name?.toLowerCase() || '';
        const away = f.teams?.away?.name?.toLowerCase() || '';
        const homeMatch = home.includes(tA.split(' ')[0]) || tA.includes(home.split(' ')[0]);
        const awayMatch = away.includes(tB.split(' ')[0]) || tB.includes(away.split(' ')[0]);
        return homeMatch && awayMatch;
      });
      // Fallback: één team matcht, maar neem de LAATSTE kickoff (meest waarschijnlijk hoofdteam)
      if (!match) {
        const candidates = fixtures.filter(f => {
          const home = f.teams?.home?.name?.toLowerCase() || '';
          const away = f.teams?.away?.name?.toLowerCase() || '';
          return home.includes(tA.split(' ')[0]) || tA.includes(home.split(' ')[0]) ||
                 away.includes(tB.split(' ')[0]) || tB.includes(away.split(' ')[0]);
        });
        match = candidates.sort((a, b) => new Date(b.fixture?.date) - new Date(a.fixture?.date))[0];
      }

      if (!match) { results.push({ id: b.id, status: 'niet gevonden', wedstrijd: b.wedstrijd }); continue; }

      const rawDate = match.fixture?.date || '';
      const tijd = new Date(rawDate).toLocaleTimeString('nl-NL', {
        hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam'
      });

      // Schrijf naar kolom L van de juiste rij
      const rowNum = BET_START_ROW + i; // 1-gebaseerd
      await sh.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${tab}!L${rowNum}`,
        valueInputOption: 'RAW',
        requestBody: { values: [[tijd]] },
      });

      results.push({ id: b.id, status: 'bijgewerkt', wedstrijd: b.wedstrijd, tijd, rawDate });
    }

    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── START ───────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Bet Scanner draait op http://localhost:${PORT}\n`);
  console.log(`   Prematch scan : POST /api/prematch`);
  console.log(`   Live scan     : POST /api/live`);
  console.log(`   Bet tracker   : GET/POST /api/bets\n`);
  seedAdminUser().catch(e => console.error('Seed admin fout:', e.message));
  scheduleDailyResultsCheck();
  scheduleDailyScan();

  // Herplan pre-kickoff checks voor alle open bets bij herstart
  readBets().then(({ bets }) => {
    bets.filter(b => b.uitkomst === 'Open' && b.tijd).forEach(b => schedulePreKickoffCheck(b).catch(() => {}));
    console.log(`⏱  Pre-kickoff checks herplanned voor ${bets.filter(b=>b.uitkomst==='Open'&&b.tijd).length} open bet(s)`);
  }).catch(() => {});

  // Keep-alive voor Render free tier (voorkomt slaapstand na 15 min)
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/status`;
    console.log(`🔁 Keep-alive actief → ${url}`);
    setInterval(() => fetch(url).catch(() => {}), 14 * 60 * 1000);
  }
});

// ── DAGELIJKSE PRE-MATCH SCAN (10:00 AM) ─────────────────────────────────────
// Plan een scan op een bepaald uur (0-23); geeft de timeout handle terug
function scheduleScanAtHour(hour) {
  const now    = new Date();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
  console.log(`📡 Scan gepland om ${hm} (over ${Math.round(delay/60000)} min)`);
  return setTimeout(async () => {
    console.log(`📡 Scan om ${hour}:00 gestart...`);
    try {
      await runPrematch(() => {});
      console.log(`📡 Scan om ${hour}:00 klaar`);
    } catch (e) {
      console.error(`Scan om ${hour}:00 fout:`, e.message);
      await tg(`⚠️ Scan om ${hour}:00 mislukt: ${e.message}`).catch(() => {});
    }
    // Herplan dezelfde scan voor morgen
    scheduleScanAtHour(hour);
  }, delay);
}

function scheduleDailyScan() {
  // Laad admin settings voor scan-tijden; fallback naar 10:00
  loadUsers().then(users => {
    const admin = users.find(u => u.role === 'admin') || { settings: defaultSettings() };
    const times = admin.settings?.scanTimes?.length ? admin.settings.scanTimes : [10];
    times.forEach(h => scheduleScanAtHour(h));
  }).catch(() => scheduleScanAtHour(10));
}

// ── DAGELIJKSE UITSLAG CHECK (09:03 AM) ──────────────────────────────────────
function scheduleDailyResultsCheck() {
  const now    = new Date();
  const target = new Date(now);
  target.setHours(9, 3, 0, 0); // 09:03 (lichte offset om :00 piek te vermijden)
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit' });
  console.log(`⏰ Dagelijkse check gepland om ${hm} (over ${Math.round(delay/60000)} min)`);

  setTimeout(async () => {
    console.log('⏰ Dagelijkse uitslag check gestart...');
    try {
      const { checked, updated, results } = await checkOpenBetResults();
      const { stats } = await readBets();
      const lines = [`📋 DAGELIJKSE CHECK — ${new Date().toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long' })}`];
      lines.push(`${checked} open bet${checked !== 1 ? 's' : ''} gecontroleerd | ${updated} auto-bijgewerkt\n`);
      for (const r of results) {
        const ico = r.uitkomst === 'W' ? '✅' : r.uitkomst === 'L' ? '❌' : '⚠️';
        lines.push(`${ico} ${r.wedstrijd}\n   ${r.markt} | ${r.score} → ${r.uitkomst || 'handmatig'}`);
      }
      if (!results.length) lines.push('Geen afgeronde wedstrijden gevonden voor open bets.');
      lines.push(`\n💰 Bankroll: €${stats.bankroll} | ROI: ${(stats.roi*100).toFixed(1)}%`);
      await tg(lines.join('\n')).catch(() => {});
    } catch (e) {
      console.error('Daily check fout:', e);
      await tg(`⚠️ Dagelijkse check mislukt: ${e.message}`).catch(() => {});
    }

    // ── Live scan: kijk of er al waardevolle live games zijn ────────────────
    try {
      const noopEmit = () => {};
      const livePicks = await runLive(noopEmit).catch(() => []);
      if (livePicks?.length > 0) {
        console.log(`⚡ Dagelijkse live check: ${livePicks.length} pick(s) gevonden en gestuurd`);
      }
    } catch (e) {
      console.error('Dagelijkse live check fout:', e.message);
    }

    scheduleDailyResultsCheck(); // plan volgende dag
  }, delay);
}
