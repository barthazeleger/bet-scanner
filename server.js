'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const { createClient } = require('@supabase/supabase-js');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');
const webpush        = require('web-push');

// Snapshot layer (v2 foundation): point-in-time logging voor learning + backtesting
const snap = require('./lib/snapshots');
let _currentModelVersionId = null; // gevuld bij boot (registerModelVersion)

// ── KILL-SWITCH CACHE ──────────────────────────────────────────────────────
// Set van market-keys (sport_market) die geblokkeerd zijn op basis van negatieve CLV.
// Refreshed elke 30 min uit /api/admin/v2/clv-stats logica.
const KILL_SWITCH = {
  set: new Set(),
  thresholds: { kill_min_n: 30, watchlist_clv: -2.0, auto_disable_clv: -5.0 },
  lastRefreshed: 0,
  enabled: true, // master flag; admin kan dit later via UI uitzetten
};

async function refreshKillSwitch() {
  if (!KILL_SWITCH.enabled) { KILL_SWITCH.set.clear(); return; }
  try {
    const { data: bets } = await supabase.from('bets')
      .select('sport, markt, clv_pct').not('clv_pct', 'is', null);
    const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct));
    const byMarket = {};
    for (const b of all) {
      const s = normalizeSport(b.sport || 'football');
      const mk = detectMarket(b.markt || 'other');
      const key = `${s}_${mk}`;
      if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0 };
      byMarket[key].n++;
      byMarket[key].sumClv += b.clv_pct;
    }
    const newSet = new Set();
    const newKills = []; // markten die nu nieuw geblokkeerd zijn
    for (const [k, d] of Object.entries(byMarket)) {
      const avgClv = d.sumClv / d.n;
      if (d.n >= KILL_SWITCH.thresholds.kill_min_n && avgClv < KILL_SWITCH.thresholds.auto_disable_clv) {
        newSet.add(k);
        if (!KILL_SWITCH.set.has(k)) newKills.push({ key: k, avgClv: avgClv.toFixed(2), n: d.n });
      }
    }
    const previousSet = KILL_SWITCH.set;
    KILL_SWITCH.set = newSet;
    KILL_SWITCH.lastRefreshed = Date.now();
    if (newSet.size) console.log(`🛑 Kill-switch: ${newSet.size} markten geblokkeerd: ${[...newSet].join(', ')}`);
    // Inbox-notification per nieuw geblokkeerde markt
    for (const k of newKills) {
      try {
        await supabase.from('notifications').insert({
          type: 'kill_switch',
          title: `🛑 Markt geblokkeerd: ${k.key}`,
          body: `Auto-disable: gemiddelde CLV ${k.avgClv}% over ${k.n} settled bets is onder threshold (${KILL_SWITCH.thresholds.auto_disable_clv}%). Picks uit deze markt worden niet meer getoond. Override via admin endpoint.`,
          read: false, user_id: null,
        });
      } catch { /* swallow */ }
    }
    // Notification als markt weer "leeft" (uit kill-set verdwenen)
    for (const k of previousSet) {
      if (!newSet.has(k)) {
        try {
          await supabase.from('notifications').insert({
            type: 'kill_switch',
            title: `✅ Markt heropend: ${k}`,
            body: `Auto-restored: gemiddelde CLV is hersteld boven threshold. Picks uit deze markt zijn weer toegestaan.`,
            read: false, user_id: null,
          });
        } catch { /* swallow */ }
      }
    }
  } catch (e) { /* swallow */ }
}

function isMarketKilled(sport, marktLabel) {
  if (!KILL_SWITCH.enabled || !KILL_SWITCH.set.size) return false;
  const key = `${normalizeSport(sport)}_${detectMarket(marktLabel || 'other')}`;
  return KILL_SWITCH.set.has(key);
}

// Adaptive MIN_EDGE: voor markten met weinig settled bets vereisen we strenger
// edge (8% i.p.v. 5.5%) zodat we niet vroeg te veel risico nemen op markten
// waar we nog geen historische CLV-bewijs hebben.
// Reviewer-lijn: "alleen markten spelen waar CLV en execution zich beginnen te bewijzen"
const _marketSampleCache = { data: {}, at: 0 };
const MARKET_SAMPLE_TTL_MS = 30 * 60 * 1000; // 30 min

async function refreshMarketSampleCounts() {
  try {
    const { data: bets } = await supabase.from('bets')
      .select('sport, markt, uitkomst').in('uitkomst', ['W', 'L']);
    const counts = {};
    for (const b of (bets || [])) {
      const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    _marketSampleCache = { data: counts, at: Date.now() };
  } catch { /* swallow */ }
}

// Bootstrap-fase: tot we minimum totale settled bets hebben gebruiken we
// base MIN_EDGE overal. Anders strangulen we dataverzameling tijdens de
// eerste weken waarin per-markt n=0 en alle markten op 8% threshold zouden vallen.
const BOOTSTRAP_MIN_TOTAL_BETS = 100;

// Returns adjusted MIN_EDGE for given sport+market based on settled bet history.
// Bootstrap (<100 totaal): base MIN_EDGE everywhere — eerst data verzamelen.
// Post-bootstrap per-markt:
//   < 30 settled bets → 8% edge required (conservative)
//   30-100 → 6.5% (moderate)
//   100+ → base MIN_EDGE (proven market)
function adaptiveMinEdge(sport, marktLabel, baseMinEdge) {
  if (Date.now() - _marketSampleCache.at > MARKET_SAMPLE_TTL_MS) {
    refreshMarketSampleCounts().catch(() => {});
  }
  const totalSettled = Object.values(_marketSampleCache.data).reduce((a, b) => a + b, 0);
  // Bootstrap: nog te weinig globale data om strict per-markt te gaan
  if (totalSettled < BOOTSTRAP_MIN_TOTAL_BETS) return baseMinEdge;
  const key = `${normalizeSport(sport)}_${detectMarket(marktLabel || 'other')}`;
  const n = _marketSampleCache.data[key] || 0;
  if (n >= 100) return baseMinEdge;
  if (n >= 30) return Math.max(baseMinEdge, 0.065);
  return Math.max(baseMinEdge, 0.08);
}

// Pure math & model helpers — geïmporteerd uit lib zodat test.js dezelfde code test
const modelMath = require('./lib/model-math');
const {
  NHL_OT_HOME_SHARE, MODEL_MARKET_DIVERGENCE_THRESHOLD, KELLY_FRACTION,
  poisson, poissonOver, poisson3Way,
  devigProportional, consensus3Way, deriveIncOTProbFrom3Way, modelMarketSanityCheck,
  normalizeTeamName, teamMatchScore, normalizeSport,
  detectMarket, calcKelly, kellyToUnits, epBucketKey,
  pitcherAdjustment, shotsDifferentialAdjustment, recomputeWl,
} = modelMath;

// ── SUPABASE CONFIG ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('FATAL: SUPABASE_URL and SUPABASE_KEY required'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(express.json({ limit: '50kb' }));

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
// CSP: 'unsafe-inline' is nodig omdat index.html veel inline <script>/<style> heeft.
// Beperk verder strict tot self + benodigde externe API hosts (apple-icon push).
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ── RATE LIMITING ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(key, maxReqs, windowMs) {
  const now = Date.now();
  const entry = rateLimitMap.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
  entry.count++;
  rateLimitMap.set(key, entry);
  return entry.count > maxReqs;
}

// Scan lock · voorkom concurrent scans
let scanRunning = false;

// ── AUTH CONFIG ────────────────────────────────────────────────────────────────
const JWT_SECRET   = process.env.JWT_SECRET;
if (!JWT_SECRET) { console.error('FATAL: JWT_SECRET env var is required'); process.exit(1); }
const ADMIN_EMAIL  = (process.env.ADMIN_EMAIL || '').toLowerCase();
const ADMIN_PASSW  = process.env.ADMIN_PASSWORD || '';

// ── WEB PUSH CONFIG ────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:noreply@edgepickr.com', VAPID_PUBLIC, VAPID_PRIVATE);
}

let _pushSubsCache = null;

async function loadPushSubs() {
  if (_pushSubsCache) return _pushSubsCache;
  try {
    const { data, error } = await supabase.from('push_subscriptions').select('*');
    if (error) throw new Error(error.message);
    _pushSubsCache = (data || []).map(r => r.subscription);
    return _pushSubsCache;
  } catch { return []; }
}

async function savePushSub(sub) {
  if (!sub?.endpoint) return;
  await supabase.from('push_subscriptions').upsert(
    { endpoint: sub.endpoint, subscription: sub, created_at: new Date().toISOString() },
    { onConflict: 'endpoint' }
  );
  _pushSubsCache = null;
}

async function deletePushSub(endpoint) {
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  _pushSubsCache = null;
}

async function sendPushToAll(payload) {
  const subs = await loadPushSubs();
  const dead = [];
  for (const sub of subs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    for (const ep of dead) await deletePushSub(ep);
  }
}

// ── EMAIL (Resend) ─────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'EdgePickr <noreply@edgepickr.com>',
      to, subject, html
    })
  }).catch(() => {});
}

// ── 2FA LOGIN CODES ────────────────────────────────────────────────────────
const loginCodes = new Map(); // email → { code, expiresAt }

// Cleanup expired codes every 10 min
setInterval(() => {
  const now = Date.now();
  for (const [email, entry] of loginCodes) {
    if (now > entry.expiresAt) loginCodes.delete(email);
  }
}, 10 * 60 * 1000);

// Routes that don't require authentication (full paths)
const PUBLIC_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/register', '/api/auth/verify-code']);

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

// Whitelist: alleen deze extensies/bestanden serveren als statische files
const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2', '.ttf']);
const ALLOWED_FILES = new Set(['/manifest.json', '/sw.js']);
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  // Normalize path to prevent traversal via URL encoding or double slashes
  const normalized = path.normalize(decodeURIComponent(req.path)).replace(/\\/g, '/');
  if (normalized.includes('..')) return res.status(400).send('Bad request');
  const ext = path.extname(normalized).toLowerCase();
  if (normalized === '/' || ALLOWED_EXTENSIONS.has(ext) || ALLOWED_FILES.has(normalized)) return next();
  return res.status(404).send('Not found');
});
app.use(express.static(path.join(__dirname)));

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const APP_VERSION    = '10.2.0';
const TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT       = process.env.TELEGRAM_CHAT_ID || '';
const TG_URL     = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
const UNIT_EUR   = 25;
const START_BANKROLL = 250;
// (calibration + signal weights stored in Supabase)

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
    telegramChatId: null,
    telegramEnabled: false,
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

async function seedAdminUser() {
  if (!ADMIN_EMAIL || !ADMIN_PASSW) return;
  try {
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
  const times = user.settings.scanTimes || ['07:30'];
  userScanTimers[user.id] = times.map(t => scheduleScanAtHour(t));
}

// ── CALIBRATIE · leren van resultaten ────────────────────────────────────────
// ep-bucket sleutels: de ranges die overeenkomen met de epW bonuses in mkP
const EP_BUCKETS = ['0.28','0.30','0.38','0.45','0.55'];
// epBucketKey() komt uit lib/model-math.js
// Standaard epW gewichten (worden overschreven door calibratie na 100 bets)
const DEFAULT_EPW = { '0.28':0.80, '0.30':0.95, '0.38':1.05, '0.45':1.15, '0.55':1.25 };

const DEFAULT_CALIB = { version:1, lastUpdated:null, totalSettled:0, totalWins:0, totalProfit:0,
  markets:{ home:{n:0,w:0,profit:0,multiplier:1.0}, away:{n:0,w:0,profit:0,multiplier:1.0},
            draw:{n:0,w:0,profit:0,multiplier:1.0}, over:{n:0,w:0,profit:0,multiplier:1.0},
            under:{n:0,w:0,profit:0,multiplier:1.0}, other:{n:0,w:0,profit:0,multiplier:1.0} },
  epBuckets: {}, leagues:{}, lossLog:[] };

let _calibCache = null;
let _calibCacheAt = 0;
const CALIB_TTL = 10 * 1000; // 10 sec cache

function loadCalib() {
  // Synchronous: return cache or default (async load happens at startup)
  if (_calibCache) return _calibCache;
  // Try local file as fallback during first load
  try { _calibCache = JSON.parse(fs.readFileSync(path.join(__dirname, 'calibration.json'), 'utf8')); return _calibCache; }
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

// detectMarket() komt uit lib/model-math.js

function updateCalibration(bet, userId = null) {
  if (!bet || !['W','L'].includes(bet.uitkomst)) return;
  // Model alleen trainen op admin data (voorkomt vervuiling door andere users)
  if (userId) {
    const users = _usersCache || [];
    const user = users.find(u => u.id === userId);
    if (user && user.role !== 'admin') return; // skip non-admin bets
  }
  const c    = loadCalib();
  const mKey = `${normalizeSport(bet.sport)}_${detectMarket(bet.markt || '')}`;
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
    // Telegram notificatie
    tg(`🧠 MODEL UPDATE\n📊 ${mKey} multiplier: ${oldMult.toFixed(2)} → ${mk.multiplier.toFixed(2)}\n📈 Win rate: ${(wr*100).toFixed(0)}% (${mk.n} bets)\n${dir}`).catch(() => {});
  }

  // ── ep-bucket tracking (voor dynamische epW kalibratie) ──────────────────
  // Sla ep op per bet zodat we kunnen terugkijken welk bucket dit was.
  // ep zit niet in de bet-record · we reconstrueren het uit kans (prob) veld als fallback.
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

  // ── Milestone checks ────────────────────────────────────────────────────
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
// Na 30+ bets per signaal: pas gewicht aan op basis van werkelijke hit rate
let _signalWeightsCache = null;

function loadSignalWeights() {
  // Synchronous: return cache or default
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

// Per-signal CLV contribution autotune. CLV is sneller signal dan W/L:
// als een signal al consistent NEGATIEVE CLV oplevert, daalt zijn weight
// veel sneller dan via W/L (waar variance maanden duurt om uit te middelen).
// Returns {tuned: number, adjustments: [...]}.
// Signal-level kill-switch threshold: bij structureel negatieve CLV → weight = 0
// (effectief uitgezet). Conservatiever dan tuning: vereist meer samples + harder
// criterium. Reviewer-aanbeveling: "signalen zonder bewijs van lift eerder uitzetten".
const SIGNAL_KILL_MIN_N = 50;        // minimum samples voor kill-besluit
const SIGNAL_KILL_CLV_PCT = -3.0;    // gemiddelde CLV onder -3% → mute

async function autoTuneSignalsByClv() {
  try {
    const { data: bets } = await supabase.from('bets')
      .select('signals, clv_pct, sport, markt').not('clv_pct', 'is', null);
    const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct) && b.signals);
    if (all.length < 30) return { tuned: 0, adjustments: [], note: 'te weinig CLV data (<30)' };

    const signalStats = {}; // signalName → { n, sumClv, posClv }
    for (const b of all) {
      let sigs;
      try { sigs = typeof b.signals === 'string' ? JSON.parse(b.signals) : b.signals; } catch { continue; }
      if (!Array.isArray(sigs)) continue;
      for (const sig of sigs) {
        const name = String(sig).split(':')[0];
        if (!name) continue;
        if (!signalStats[name]) signalStats[name] = { n: 0, sumClv: 0, posClv: 0 };
        signalStats[name].n++;
        signalStats[name].sumClv += b.clv_pct;
        if (b.clv_pct > 0) signalStats[name].posClv++;
      }
    }

    const weights = loadSignalWeights();
    const adjustments = [];
    let tuned = 0, muted = 0;
    for (const [name, s] of Object.entries(signalStats)) {
      if (s.n < 20) continue;
      const avgClv = s.sumClv / s.n;
      const old = weights[name] || 1.0;
      let newW = old;
      let reason = null;
      // KILL-SWITCH: structureel negatieve CLV met genoeg samples → mute
      if (s.n >= SIGNAL_KILL_MIN_N && avgClv <= SIGNAL_KILL_CLV_PCT) {
        newW = 0;
        reason = `auto_disabled (avg_clv ${avgClv.toFixed(2)}% over ${s.n} bets)`;
        muted++;
      } else if (avgClv < -2) newW = Math.max(0.3, old * 0.92);
      else if (avgClv > 2) newW = Math.min(1.5, old * 1.05);
      else if (avgClv < -0.5) newW = Math.max(0.3, old * 0.97);
      else if (avgClv > 0.5) newW = Math.min(1.5, old * 1.02);
      else newW = old * 0.99 + 0.01;

      if (Math.abs(newW - old) >= 0.02 || reason) {
        weights[name] = +newW.toFixed(3);
        adjustments.push({ name, old: +old.toFixed(3), new: +newW.toFixed(3), avgClv: +avgClv.toFixed(2), n: s.n, reason });
        tuned++;
      }
    }
    if (tuned) await saveSignalWeights(weights);
    return { tuned, muted, adjustments };
  } catch (e) {
    return { tuned: 0, adjustments: [], error: e.message };
  }
}

async function autoTuneSignals() {
  try {
    // Alleen admin bets voor model training
    const adminUser = (_usersCache || []).find(u => u.role === 'admin');
    const { bets } = await readBets(adminUser?.id || null);
    const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    if (settled.length < 20) return; // te weinig data

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
      if (stats.n < 15) continue; // te weinig data voor dit signaal
      const hitRate = stats.w / stats.n;
      const old = weights[name] || 1.0;

      // Signals met hoge hit rate krijgen meer gewicht, lage minder
      // Gradueel: max ±10% per tuning cycle
      let newW = old;
      if (hitRate > 0.55) newW = Math.min(1.5, old * 1.05);
      else if (hitRate < 0.40) newW = Math.max(0.3, old * 0.92);
      else newW = old * 0.98 + 0.02; // langzaam naar 1.0 als neutraal

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

// ── PORTFOLIO ANALYSE & UPGRADE AANBEVELINGEN ─────────────────────────────────
async function runPortfolioAnalysis() {
  const c    = loadCalib();
  const { stats: s } = await readBets();
  if (c.totalSettled < 5) return; // te weinig data

  const roi      = s.roi ?? 0;
  const bankroll = s.bankroll ?? START_BANKROLL;
  const profit   = bankroll - START_BANKROLL;
  const lines    = [];

  lines.push(`📊 PORTFOLIO ANALYSE · ${new Date().toLocaleDateString('nl-NL')}`);
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
      lines.push(`⚠️ Verliespatroon: ${worst[1]}x verlies in "${worst[0]}" picks · model drempel verhoogd`);
    }
  }
  lines.push('');

  // ── Upgrade aanbevelingen ──
  lines.push('🔧 API status & aanbevelingen:');
  lines.push(`✅ api-football.com Pro: actief (7500 req/dag)`);

  // api-sports all-sports upgrade aanbeveling (ROI-gebaseerd)
  if (c.totalSettled >= 30 && roi > 0.10) {
    lines.push(`🚀 UPGRADE AANBEVOLEN: ROI ${(roi*100).toFixed(1)}% over ${c.totalSettled} bets · api-sports All Sports ($99/mnd) rechtvaardigt zich`);
  } else if (c.totalSettled >= 20 && roi > 0.05) {
    lines.push(`💡 Winstgevend (ROI ${(roi*100).toFixed(1)}%) · wacht tot 30+ bets voor All Sports upgrade`);
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

  // Log inzichten naar inbox
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
  // CLV inzicht
  if (s.clvTotal >= 5) {
    const clvMsg = s.avgCLV > 0
      ? `CLV gemiddeld +${s.avgCLV.toFixed(1)}% · je pakt betere odds dan de markt bij aftrap. Dit is bewijs van edge.`
      : `CLV gemiddeld ${s.avgCLV.toFixed(1)}% · je odds zijn slechter dan de slotlijn. Probeer eerder te loggen.`;
    inboxEntries.push({ date: new Date().toISOString(), type: 'clv_insight', note: clvMsg });
  }
  // Timing inzicht
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
  // Verliespatroon waarschuwing
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
const AF_KEY = process.env.API_FOOTBALL_KEY || '';

// Seizoen berekening: Europese competities lopen aug–mei, dus in jan–jul = vorig jaar
const CURRENT_SEASON = new Date().getMonth() < 7
  ? new Date().getFullYear() - 1   // april 2026 → season 2025
  : new Date().getFullYear();

// Split-year seizoenen (okt-jun): bijv. "2025-2026"
const SPLIT_SEASON = new Date().getMonth() < 7
  ? `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`
  : `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;

// Calendar-year seizoenen (apr-okt): bijv. "2026"
const CALENDAR_SEASON = String(new Date().getFullYear());

// Voetbal competities via api-football.com (league ID, thuisvoordeel)
const AF_FOOTBALL_LEAGUES = [
  // ── Europa · Tier 1 ────────────────────────────────────────────────────────
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
  // ── Europa · Tier 2 ────────────────────────────────────────────────────────
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
  // ── Azië & Oceanië (minder efficiënt geprijsd) ─────────────────────────
  { id:169, key:'china_super',   name:'Chinese Super League',  ha:0.05, season:new Date().getFullYear() },
  { id:292, key:'korea',         name:'K League 1',            ha:0.05, season:new Date().getFullYear() },
  { id:188, key:'australia',     name:'A-League',              ha:0.04, season:CURRENT_SEASON },
  // ── Zuid-Amerika ───────────────────────────────────────────────────────
  { id:239, key:'colombia',      name:'Liga BetPlay',          ha:0.06, season:new Date().getFullYear() },
  { id:268, key:'chile',         name:'Primera División Chile', ha:0.06, season:new Date().getFullYear() },
  { id:242, key:'peru',          name:'Liga 1 Peru',           ha:0.06, season:new Date().getFullYear() },
  // ── Afrika & Midden-Oosten ─────────────────────────────────────────────
  { id:233, key:'egypt',         name:'Egyptian Premier',      ha:0.06, season:CURRENT_SEASON },
  { id:270, key:'south_africa',  name:'South African Premier', ha:0.05, season:CURRENT_SEASON },
  // ── Scandinavië & Noordelijk Europa (2e divisies) ─────────────────────
  { id:547, key:'denmark2',      name:'Danish 1st Division',   ha:0.04, season:CURRENT_SEASON },
  { id:271, key:'norway2',       name:'Norwegian First Div',   ha:0.04, season:new Date().getFullYear() },
  { id:114, key:'sweden2',       name:'Superettan',            ha:0.04, season:new Date().getFullYear() },
  { id:318, key:'finland',       name:'Veikkausliiga',         ha:0.05, season:new Date().getFullYear() },
  { id:373, key:'iceland',       name:'Úrvalsdeild',           ha:0.04, season:new Date().getFullYear() },
  // ── Oost-Europa (minder efficiënt geprijsd) ───────────────────────────
  { id:327, key:'bulgaria',      name:'First Professional League', ha:0.05, season:CURRENT_SEASON },
  { id:332, key:'serbia',        name:'Serbian SuperLiga',     ha:0.05, season:CURRENT_SEASON },
  { id:383, key:'hungary',       name:'NB I Hungary',          ha:0.05, season:CURRENT_SEASON },
  { id:286, key:'cyprus',        name:'Cyprus First Division', ha:0.05, season:CURRENT_SEASON },
  { id:325, key:'slovakia',      name:'Slovak Super Liga',     ha:0.05, season:CURRENT_SEASON },
];

// (ESPN standings removed · api-football standings used exclusively)

// ── BASKETBALL LEAGUES (api-sports.io basketball) ────────────────────────────
const NBA_LEAGUES = [
  // Tier 1: goede odds coverage van 20+ bookmakers
  { id: 12,  key: 'nba',         name: 'NBA',                 ha: 0.03, season: SPLIT_SEASON },
  { id: 120, key: 'euroleague',  name: 'Euroleague',          ha: 0.04, season: SPLIT_SEASON },
  { id: 116, key: 'acb',         name: 'Liga ACB (Spanje)',   ha: 0.05, season: SPLIT_SEASON },
  { id: 117, key: 'lnb',         name: 'LNB Pro A (Frankrijk)',ha: 0.05, season: SPLIT_SEASON },
  { id: 204, key: 'bsl',         name: 'BSL (Turkije)',       ha: 0.05, season: CURRENT_SEASON },
];

// ── HOCKEY LEAGUES (alleen met goede odds data) ─────────────────────────────
const NHL_LEAGUES = [
  { id: 57,  key: 'nhl',         name: 'NHL',                 ha: 0.03, season: CURRENT_SEASON },
  { id: 85,  key: 'khl',         name: 'KHL (Rusland)',       ha: 0.04, season: CURRENT_SEASON },
  { id: 72,  key: 'shl',         name: 'SHL (Zweden)',        ha: 0.04, season: CURRENT_SEASON },
  { id: 68,  key: 'liiga',       name: 'Liiga (Finland)',     ha: 0.04, season: CURRENT_SEASON },
];

// ── BASEBALL LEAGUES (alleen met goede odds data) ───────────────────────────
const BASEBALL_LEAGUES = [
  { id: 1,   key: 'mlb',         name: 'MLB',                 ha: 0.04, season: CALENDAR_SEASON },
  { id: 10,  key: 'kbo',         name: 'KBO (Korea)',         ha: 0.04, season: CALENDAR_SEASON },
  { id: 11,  key: 'npb',         name: 'NPB (Japan)',         ha: 0.04, season: CALENDAR_SEASON },
];

// ── NFL LEAGUES (alleen met goede odds data) ────────────────────────────────
const NFL_LEAGUES = [
  { id: 1,   key: 'nfl',         name: 'NFL',                 ha: 0.057, season: CURRENT_SEASON },
  { id: 2,   key: 'ncaa',        name: 'NCAA Football',       ha: 0.05, season: CURRENT_SEASON },
];

// ── HANDBALL LEAGUES (alleen met goede odds data) ───────────────────────────
const HANDBALL_LEAGUES = [
  { id: 30,  key: 'ehf_cl',      name: 'EHF Champions League',ha: 0.05, season: CURRENT_SEASON },
  { id: 35,  key: 'hbl',         name: 'Handball Bundesliga',  ha: 0.06, season: CURRENT_SEASON },
  { id: 36,  key: 'lnh',         name: 'Starligue (Frankrijk)',ha: 0.06, season: CURRENT_SEASON },
  { id: 37,  key: 'asobal',      name: 'Liga Asobal (Spanje)',ha: 0.06, season: CURRENT_SEASON },
];

// ── LAST PICKS (in-memory voor analyse tab) ──────────────────────────────────
let lastPrematchPicks = [];
let lastLivePicks = [];

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

// ── HELPERS ────────────────────────────────────────────────────────────────────
const get    = (url) => fetch(url, { headers: H }).then(r => r.json()).catch(() => ({}));
const toD    = f => { if (!f || !f.includes('/')) return null; const [n,d] = f.split('/').map(Number); return +(1 + n/d).toFixed(2); };
const clamp  = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
const sleep  = ms => new Promise(r => setTimeout(r, ms));
const tgRaw  = async (text) => fetch(TG_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: CHAT, text }) }).catch(() => {});

// Stuur naar Telegram EN sla op in Supabase notifications tabel
const tg = async (text, type = 'info', userId = null) => {
  tgRaw(text).catch(() => {});
  const lines = text.split('\n');
  const title = lines[0].replace(/[^\w\s€%·:→←↑↓+\-.,!?()]/g, '').trim().slice(0, 100);
  const body = lines.slice(1).join('\n').slice(0, 200);
  supabase.from('notifications').insert({
    type, title, body: text, read: false, user_id: userId
  }).then(() => {}).catch(() => {});
  // Ook push notificatie sturen
  sendPushToAll({
    title: title || 'EdgePickr',
    body: body || 'Nieuwe update',
    tag: type,
    url: '/',
  }).catch(() => {});
};

// Log een gefaalde pre-match/CLV check naar de notifications tabel,
// zodat de user het in de 🔔 dropdown ziet (niet alleen op Telegram).
async function logCheckFailure(type, wedstrijd, reason) {
  try {
    const label = type === 'clv' ? 'CLV check' : 'Pre-match check';
    const title = `Check mislukt: ${wedstrijd}`.slice(0, 100);
    const body = `⚠️ ${label}: kon geen odds ophalen voor ${wedstrijd} · ${reason || 'controleer handmatig'}`;
    await supabase.from('notifications').insert({
      type: 'check_failed', title, body, read: false, user_id: null
    });
  } catch (e) {
    console.warn('[logCheckFailure]', e.message);
  }
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
const MIN_EP           = 0.52;  // minimale geschatte kans (~52%) · boven 50% = meer wins dan losses structureel
// KELLY_FRACTION komt uit lib/model-math.js (0.50 half-Kelly)

// ── DRAWDOWN PROTECTION ──────────────────────────────────────────────────────
// Bij een losing streak: verlaag automatisch stakes om bankroll te beschermen
function getDrawdownMultiplier() {
  const c = loadCalib();
  const losses = c.lossLog || [];
  // Tel opeenvolgende recente verliezen
  let streak = 0;
  for (const l of losses) {
    streak++;
    // Check of er een win tussenzit (lossLog bevat alleen losses, dus check via bets)
  }
  // Simpeler: kijk naar de laatste 10 bets ratio
  if (c.totalSettled < 5) return 1.0; // te weinig data
  const recentN = Math.min(10, c.totalSettled);
  const recentLossRate = losses.slice(0, recentN).length / recentN;

  // Gebruik de werkelijke streak uit de calibratie data
  // lossLog is gesorteerd nieuwste eerst · tel aaneengesloten verliezen
  // Maar we hebben ook wins nodig. Simpelste: check de bets direct.
  try {
    // Sync check via calibration data
    const totalWr = c.totalSettled > 0 ? c.totalWins / c.totalSettled : 0.5;
    const recentProfit = c.totalProfit || 0;

    // Als we meer dan 20% van startbankroll verloren hebben: halveer stakes
    if (recentProfit < -(START_BANKROLL * 0.20)) {
      console.log('⚠️ Drawdown protection: stakes gehalveerd (>20% loss)');
      tg(`🛡️ DRAWDOWN PROTECTION\nStakes gehalveerd · bankroll >20% onder start.\nHuidige P/L: €${recentProfit.toFixed(2)}`).catch(() => {});
      return 0.5;
    }
    // Als win rate onder 30% na 10+ bets: verlaag stakes met 30%
    if (c.totalSettled >= 10 && totalWr < 0.30) {
      console.log('⚠️ Drawdown protection: stakes -30% (win rate < 30%)');
      return 0.7;
    }
    // Na 5+ opeenvolgende verliezen (geschat): verlaag met 40%
    if (losses.length >= 5 && c.totalSettled >= 8) {
      const last5 = losses.slice(0, 5);
      const recentDates = last5.map(l => l.date).filter(Boolean);
      // Als alle 5 verliezen van de afgelopen 3 dagen zijn = streak
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

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}, sport = 'football') {
  const picks     = [];  // standalone picks (odd >= MIN_ODDS)
  const combiPool = [];  // alle valide picks incl. lage odds (voor combi-legs)

  const mkP = (match, league, label, odd, reason, prob, boost=0, kickoff=null, bookie=null, signals=null, referee=null) => {
    if (!odd || odd < 1.10) return;            // absoluut minimum
    const ip = 1/odd;
    const ep = Math.min(0.88, ip + boost);
    if (ep < MIN_EP) return;
    if (ep <= ip + 0.03) return;               // minimale edge vereist
    const k = ((ep*(odd-1)) - (1-ep)) / (odd-1);
    if (k <= 0.015) return;

    // Odds-penalty: hogere odds = hogere variance = lagere strength
    const vP = odd > 3.50 ? 0.42
             : odd > 2.50 ? 0.65
             : odd > 2.00 ? 0.85
             : 1.0;

    // Data confidence: meer signalen = meer vertrouwen in de pick
    // Bewezen: full data model +35% accuracy vs odds-only (ScienceDirect 2024)
    const sigCount = (signals || []).length;
    const dataConf = sigCount >= 6 ? 1.0    // volledige data
                   : sigCount >= 3 ? 0.70   // gedeeltelijke data
                   : sigCount >= 1 ? 0.50   // minimale data
                   : 0.40;                   // alleen odds

    const bk  = epBucketKey(ep);
    const epW = (calibEpBuckets[bk]?.n >= 15 && calibEpBuckets[bk]?.weight)
      ? calibEpBuckets[bk].weight
      : DEFAULT_EPW[bk];

    // Half-Kelly unit sizing met drawdown protection
    const ddMult = getDrawdownMultiplier();
    const hk = k * KELLY_FRACTION * ddMult;
    const u  = hk>0.09?'1.0U' : hk>0.04?'0.5U' : '0.3U';
    const edge = Math.round((ep * odd - 1) * 100 * 10) / 10;

    const uNum = hk>0.09 ? 1.0 : hk>0.04 ? 0.5 : 0.3;
    const expectedEur = +(uNum * UNIT_EUR * (edge / 100) * dataConf).toFixed(2);
    const pick = { match, league, label, odd, units: u, reason, prob, ep: +ep.toFixed(3),
                   strength: k*(odd-1)*vP*epW*dataConf, kelly: hk, edge, expectedEur, kickoff, bookie,
                   signals: signals || [], referee: referee || null, dataConfidence: dataConf, sport };

    // Adaptive MIN_EDGE gate: voor markten met <100 settled bets vereist
    // strenger edge percentage. Voorkomt dat we vroeg te veel risico nemen op
    // markten zonder bewezen CLV-historie. Helper definieert tier (PROVEN/EARLY/UNPROVEN).
    // v10.1.4: combiPool wordt OOK gefilterd — geen combo's op onbewezen markten.
    if (typeof adaptiveMinEdge === 'function') {
      const requiredEdgePct = adaptiveMinEdge(sport, label, 0.055) * 100;
      if (edge < requiredEdgePct) return; // te zwak: niet in singles én niet in combiPool
    }

    combiPool.push(pick);            // combi-eligible (na adaptive gate)
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

// (fetchEspnStandings removed · api-football standings provide rank/form/goals)

// ═══════════════════════════════════════════════════════════════════════════════
// API-SPORTS.IO ENRICHMENT · vorm, H2H, blessures, scheidsrechter, team-stats
// ═══════════════════════════════════════════════════════════════════════════════

// Session-caches (worden éénmaal per scan gevuld)
const afCache = {
  teamStats: {},   // key=sport_key, value: { teamNameLower: { form, goalsFor, goalsAgainst, winPct, teamId } }
  injuries:  {},   // key=sport_key, value: { teamNameLower: [{ player, type }] }
  referees:  {},   // key='home vs away' (lower), value: { name, yellowsPerGame, redsPerGame }
  h2h:       {},   // key='id1-id2', value: { hmW, awW, dr, n, avgGoals, bttsRate }
};

// ── API-FOOTBALL RATE LIMIT TRACKER ─────────────────────────────────────────
let afRateLimit = { remaining: null, limit: 7500, updatedAt: null, callsToday: 0, date: null };
// Per-sport rate limit tracking (All Sports plan: 7500 calls/sport/day)
const sportRateLimits = {
  football:           { callsToday: 0, date: null },
  basketball:         { callsToday: 0, date: null },
  hockey:             { callsToday: 0, date: null },
  baseball:           { callsToday: 0, date: null },
  'american-football': { callsToday: 0, date: null },
  handball:           { callsToday: 0, date: null },
};

// Load persistent usage from Supabase at startup
(async () => {
  try {
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    // Totaal
    const { data } = await supabase.from('api_usage').select('*').eq('date', todayStr).single();
    if (data) {
      afRateLimit = { remaining: data.remaining, limit: data.api_limit || 7500, updatedAt: data.updated_at, callsToday: data.calls || 0, date: data.date };
    } else {
      afRateLimit.date = todayStr;
      afRateLimit.callsToday = 0;
    }
    // Per sport
    const { data: sportRows } = await supabase.from('api_usage').select('*').like('date', `${todayStr}_%`);
    for (const row of (sportRows || [])) {
      const sport = row.date.split('_')[1];
      if (sport && sportRateLimits[sport]) {
        sportRateLimits[sport].callsToday = row.calls || 0;
        sportRateLimits[sport].date = todayStr;
      }
    }
  } catch { afRateLimit.date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
})();

function saveAfUsage() {
  // Totaal opslaan
  supabase.from('api_usage').upsert({
    date: afRateLimit.date, calls: afRateLimit.callsToday,
    remaining: afRateLimit.remaining, api_limit: afRateLimit.limit,
    updated_at: new Date().toISOString()
  }).then(() => {}).catch(() => {});
  // Per sport opslaan (date = "2026-04-13_football" etc)
  for (const [sport, srl] of Object.entries(sportRateLimits)) {
    if (srl.callsToday > 0) {
      supabase.from('api_usage').upsert({
        date: `${afRateLimit.date}_${sport}`, calls: srl.callsToday,
        api_limit: 7500, updated_at: new Date().toISOString()
      }).then(() => {}).catch(() => {});
    }
  }
}

const AF_TIMEOUT_MS = 8000; // 8s hard timeout op api-sports calls; voorkomt scan-stalling

async function afGet(host, path, params = {}) {
  if (!AF_KEY) return [];
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `https://${host}${path}${qs ? '?' + qs : ''}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AF_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { 'x-apisports-key': AF_KEY, Accept: 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    // Lees rate limit headers uit elke response
    const rem = r.headers.get('x-ratelimit-requests-remaining');
    const lim = r.headers.get('x-ratelimit-requests-limit');
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    if (afRateLimit.date !== todayStr) { afRateLimit.callsToday = 0; afRateLimit.date = todayStr; }
    afRateLimit.callsToday++;
    if (rem !== null) {
      afRateLimit.remaining = parseInt(rem);
      afRateLimit.limit = parseInt(lim) || afRateLimit.limit;
    }
    afRateLimit.updatedAt = new Date().toISOString();
    // Per-sport tracking
    const sport = host.includes('basketball')        ? 'basketball'
                : host.includes('hockey')            ? 'hockey'
                : host.includes('baseball')          ? 'baseball'
                : host.includes('american-football') ? 'american-football'
                : host.includes('handball')          ? 'handball'
                : 'football';
    const srl = sportRateLimits[sport];
    if (srl.date !== todayStr) { srl.callsToday = 0; srl.date = todayStr; }
    srl.callsToday++;
    saveAfUsage();
    const d = await r.json().catch(() => ({}));
    return d.response || [];
  } catch (e) {
    clearTimeout(timer);
    // Log naar console voor zichtbaarheid; teruggeven [] zodat scan doorgaat (fail-soft).
    if (e?.name === 'AbortError') console.warn(`⏱  afGet timeout (${AF_TIMEOUT_MS}ms): ${host}${path}`);
    return [];
  }
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
    // Bet ID 8: Both Teams to Score → btts
    const bttsB = bk.bets?.find(b => b.id === 8);
    if (bttsB) {
      markets.push({
        key: 'btts',
        outcomes: bttsB.values.map(v => ({
          name: v.value, // "Yes" or "No"
          price: parseFloat(v.odd) || 0,
        })).filter(o => o.price > 1.01),
      });
    }
    // Bet ID 12: Asian Handicap → spreads
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
          const home = entry.home;
          const away = entry.away;
          const homePlayed = home?.played || 1;
          const awayPlayed = away?.played || 1;
          statsMap[nm] = {
            form:         entry.form || '',
            goalsFor:     +(all.goals?.for  / played).toFixed(2),
            goalsAgainst: +(all.goals?.against / played).toFixed(2),
            teamId:       entry.team?.id,
            rank:         entry.rank || 0,
            // Home/away splits for split adjustment
            homeGPG:      +(home?.goals?.for / homePlayed).toFixed(2),
            homeGAPG:     +(home?.goals?.against / homePlayed).toFixed(2),
            awayGPG:      +(away?.goals?.for / awayPlayed).toFixed(2),
            awayGAPG:     +(away?.goals?.against / awayPlayed).toFixed(2),
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
  emit({ log: `📊 api-sports klaar · ${callsUsed} calls gebruikt (All Sports · 7500/dag per sport)` });
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

// ── Team season statistics (for O/U refinement) ─────────────────────────────
// Cached per scan session. Only fetched for candidate fixtures (post odds-filter).
const teamStatsCache = {}; // key = `${teamId}-${leagueId}-${season}`

async function fetchTeamStats(teamId, leagueId, season) {
  if (!AF_KEY || !teamId || !leagueId) return null;
  const cacheKey = `${teamId}-${leagueId}-${season}`;
  if (teamStatsCache[cacheKey]) return teamStatsCache[cacheKey];
  try {
    const data = await afGet('v3.football.api-sports.io', '/teams/statistics', {
      team: teamId, league: leagueId, season
    });
    // data is a single object (not array) · afGet returns response.response which
    // for this endpoint is an object, not array. Handle both cases.
    const stats = Array.isArray(data) ? data[0] : data;
    if (!stats) return null;
    const result = {
      goalsForAvg:     parseFloat(stats.goals?.for?.average?.total) || 0,
      goalsAgainstAvg: parseFloat(stats.goals?.against?.average?.total) || 0,
      goalsForHomeAvg: parseFloat(stats.goals?.for?.average?.home) || 0,
      goalsAgainstAwayAvg: parseFloat(stats.goals?.against?.average?.away) || 0,
      cleanSheet:      stats.clean_sheet?.total || 0,
      cleanSheetPct:   0,
      failedToScore:   stats.failed_to_score?.total || 0,
      failedToScorePct: 0,
      played:          0,
    };
    // Calculate percentages
    const played = (stats.fixtures?.played?.total) || 1;
    result.played = played;
    result.cleanSheetPct = +(result.cleanSheet / played).toFixed(3);
    result.failedToScorePct = +(result.failedToScore / played).toFixed(3);
    teamStatsCache[cacheKey] = result;
    await sleep(100);
    return result;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEATHER DATA · Open-Meteo API (gratis, geen API key)
// ═══════════════════════════════════════════════════════════════════════════════

// Simpele city→lat/lon mapping voor grote voetbalsteden
const CITY_COORDS = {
  'london':      { lat:51.50, lon:-0.13 },  'manchester':  { lat:53.48, lon:-2.24 },
  'liverpool':   { lat:53.41, lon:-2.98 },  'birmingham':  { lat:52.48, lon:-1.89 },
  'leeds':       { lat:53.80, lon:-1.55 },  'newcastle':   { lat:54.98, lon:-1.62 },
  'madrid':      { lat:40.42, lon:-3.70 },  'barcelona':   { lat:41.39, lon:2.17 },
  'sevilla':     { lat:37.39, lon:-5.99 },  'valencia':    { lat:39.47, lon:-0.38 },
  'münchen':     { lat:48.14, lon:11.58 },  'munich':      { lat:48.14, lon:11.58 },
  'dortmund':    { lat:51.51, lon:7.47 },   'berlin':      { lat:52.52, lon:13.41 },
  'leipzig':     { lat:51.34, lon:12.37 },  'frankfurt':   { lat:50.11, lon:8.68 },
  'milano':      { lat:45.46, lon:9.19 },   'milan':       { lat:45.46, lon:9.19 },
  'roma':        { lat:41.90, lon:12.50 },  'rome':        { lat:41.90, lon:12.50 },
  'torino':      { lat:45.07, lon:7.69 },   'napoli':      { lat:40.85, lon:14.27 },
  'paris':       { lat:48.86, lon:2.35 },   'lyon':        { lat:45.76, lon:4.84 },
  'marseille':   { lat:43.30, lon:5.37 },   'lille':       { lat:50.63, lon:3.06 },
  'amsterdam':   { lat:52.37, lon:4.90 },   'rotterdam':   { lat:51.92, lon:4.48 },
  'eindhoven':   { lat:51.44, lon:5.47 },   'lisboa':      { lat:38.72, lon:-9.14 },
  'lisbon':      { lat:38.72, lon:-9.14 },  'porto':       { lat:41.16, lon:-8.63 },
  'istanbul':    { lat:41.01, lon:28.98 },  'brussel':     { lat:50.85, lon:4.35 },
  'brussels':    { lat:50.85, lon:4.35 },   'glasgow':     { lat:55.86, lon:-4.25 },
  'edinburgh':   { lat:55.95, lon:-3.19 },  'wien':        { lat:48.21, lon:16.37 },
  'vienna':      { lat:48.21, lon:16.37 },  'zürich':      { lat:47.38, lon:8.54 },
  'zurich':      { lat:47.38, lon:8.54 },   'bern':        { lat:46.95, lon:7.45 },
  'copenhagen':  { lat:55.68, lon:12.57 },  'københavn':   { lat:55.68, lon:12.57 },
  'oslo':        { lat:59.91, lon:10.75 },  'stockholm':   { lat:59.33, lon:18.07 },
  'gothenburg':  { lat:57.71, lon:11.97 },  'helsinki':     { lat:60.17, lon:24.94 },
  'reykjavik':   { lat:64.15, lon:-21.95 }, 'athens':      { lat:37.98, lon:23.73 },
  'warsaw':      { lat:52.23, lon:21.01 },  'krakow':      { lat:50.06, lon:19.94 },
  'prague':      { lat:50.08, lon:14.44 },  'bucharest':   { lat:44.43, lon:26.10 },
  'zagreb':      { lat:45.81, lon:15.98 },  'moscow':      { lat:55.76, lon:37.62 },
  'kyiv':        { lat:50.45, lon:30.52 },  'belgrade':    { lat:44.79, lon:20.47 },
  'budapest':    { lat:47.50, lon:19.04 },  'sofia':       { lat:42.70, lon:23.32 },
  'nicosia':     { lat:35.17, lon:33.37 },  'bratislava':  { lat:48.15, lon:17.11 },
  'cairo':       { lat:30.04, lon:31.24 },  'johannesburg':{ lat:-26.20, lon:28.05 },
  'cape town':   { lat:-33.93, lon:18.42 }, 'pretoria':    { lat:-25.75, lon:28.19 },
  'new york':    { lat:40.71, lon:-74.01 }, 'los angeles': { lat:34.05, lon:-118.24 },
  'mexico city': { lat:19.43, lon:-99.13 }, 'bogota':      { lat:4.71, lon:-74.07 },
  'bogotá':      { lat:4.71, lon:-74.07 },  'santiago':    { lat:-33.45, lon:-70.67 },
  'lima':        { lat:-12.05, lon:-77.04 },'buenos aires':{ lat:-34.60, lon:-58.38 },
  'são paulo':   { lat:-23.55, lon:-46.63 },'sao paulo':   { lat:-23.55, lon:-46.63 },
  'rio de janeiro':{ lat:-22.91, lon:-43.17 },
  'riyadh':      { lat:24.71, lon:46.67 },  'jeddah':      { lat:21.49, lon:39.19 },
  'tokyo':       { lat:35.68, lon:139.69 }, 'osaka':       { lat:34.69, lon:135.50 },
  'seoul':       { lat:37.57, lon:126.98 }, 'beijing':     { lat:39.90, lon:116.40 },
  'shanghai':    { lat:31.23, lon:121.47 }, 'guangzhou':   { lat:23.13, lon:113.26 },
  'sydney':      { lat:-33.87, lon:151.21 },'melbourne':   { lat:-37.81, lon:144.96 },
};

let weatherCallsThisScan = 0;
const MAX_WEATHER_CALLS = 30;

async function fetchMatchWeather(lat, lon, kickoffTime) {
  if (weatherCallsThisScan >= MAX_WEATHER_CALLS) return null;
  const date = kickoffTime.toISOString().slice(0, 10);
  const hour = kickoffTime.getUTCHours();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,windspeed_10m,temperature_2m&start_date=${date}&end_date=${date}`;
  try {
    weatherCallsThisScan++;
    const r = await fetch(url).then(r => r.json());
    const idx = r.hourly?.time?.findIndex(t => t.includes(`T${String(hour).padStart(2,'0')}`)) ?? -1;
    if (idx < 0) return null;
    return {
      rain: r.hourly.precipitation?.[idx] ?? 0,       // mm
      wind: r.hourly.windspeed_10m?.[idx] ?? 0,       // km/h
      temp: r.hourly.temperature_2m?.[idx] ?? 15,     // °C
    };
  } catch { return null; }
}

function getVenueCoords(fixture) {
  // Probeer city uit fixture.venue.city, zoek in CITY_COORDS
  const city = (fixture?.venue?.city || '').toLowerCase().trim();
  if (!city) return null;
  // Directe match
  if (CITY_COORDS[city]) return CITY_COORDS[city];
  // Fuzzy: check of city-naam een bekende stad bevat
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (city.includes(key) || key.includes(city)) return coords;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// POISSON GOAL MODEL · supplementair op het bestaande model
// ═══════════════════════════════════════════════════════════════════════════════

function factorial(n) {
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

function poissonProb(lambda, k) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

function calcGoalProbs(homeAttack, homeDefense, awayAttack, awayDefense, leagueAvgGoals = 1.35) {
  // Expected goals via Poisson: attack * defense * league avg
  const homeExpG = Math.max(0.3, homeAttack * awayDefense * leagueAvgGoals);
  const awayExpG = Math.max(0.3, awayAttack * homeDefense * leagueAvgGoals);

  // Goal distribution matrix (0-6 goals each)
  const probs = {};
  for (let h = 0; h <= 6; h++) {
    for (let a = 0; a <= 6; a++) {
      probs[`${h}-${a}`] = poissonProb(homeExpG, h) * poissonProb(awayExpG, a);
    }
  }

  // Derived probabilities
  const overX = (line) => Object.entries(probs)
    .filter(([s]) => { const [h,a] = s.split('-').map(Number); return h+a > line; })
    .reduce((s, [,p]) => s + p, 0);

  const bttsYes = Object.entries(probs)
    .filter(([s]) => { const [h,a] = s.split('-').map(Number); return h>0 && a>0; })
    .reduce((s, [,p]) => s + p, 0);

  return {
    homeExpG: +homeExpG.toFixed(2),
    awayExpG: +awayExpG.toFixed(2),
    over15: +overX(1.5).toFixed(4),
    over25: +overX(2.5).toFixed(4),
    over35: +overX(3.5).toFixed(4),
    bttsYes: +bttsYes.toFixed(4),
    bttsNo:  +(1 - bttsYes).toFixed(4),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASKETBALL SCANNER · api-sports.io basketball
// ═══════════════════════════════════════════════════════════════════════════════

// No-vig fair probabilities for 2-way markets (basketball/hockey · no draw)
function fairProbs2Way(oddsArr) {
  // oddsArr = [{ name, price }, ...] for home + away
  if (!oddsArr || oddsArr.length < 2) return null;
  const home = oddsArr.find(o => o.side === 'home');
  const away = oddsArr.find(o => o.side === 'away');
  if (!home || !away || home.price < 1.01 || away.price < 1.01) return null;
  const totalIP = 1/home.price + 1/away.price;
  return { home: (1/home.price)/totalIP, away: (1/away.price)/totalIP };
}

// Parse basketball/hockey odds from api-sports response
// Extended: also extracts 1st-half, 1st-period, NRFI, odd/even markets
// Nieuw: threeWay (Home/Draw/Away 60-min regulation) voor hockey 3-weg ML
function parseGameOdds(oddsResp, homeTeam, awayTeam) {
  const bookmakers = oddsResp?.[0]?.bookmakers || oddsResp?.bookmakers || [];
  if (!bookmakers.length) return { moneyline: [], totals: [], spreads: [], halfML: [], halfTotals: [], halfSpreads: [], nrfi: [], oddEven: [], threeWay: [], teamTotals: [], doubleChance: [], dnb: [] };

  const ml = [], tots = [], spr = [];
  const halfML = [], halfTotals = [], halfSpreads = [];
  const nrfi = [], oddEven = [];
  const threeWay = [];
  const teamTotals = []; // { team: 'home'|'away', side: 'over'|'under', point, price, bookie }
  const doubleChance = []; // { side: 'HX'|'X2'|'12', price, bookie }
  const dnb = []; // { side: 'home'|'away', price, bookie }
  for (const bk of bookmakers) {
    const bkName = bk.name || bk.bookmaker?.name || 'Unknown';
    for (const bet of (bk.bets || [])) {
      const betId = bet.id;
      const betName = (bet.name || '').toLowerCase();
      // Moneyline — alleen 2-way entries (exact 2 values Home/Away, geen handicap).
      // bet id 1 + value count 2 + values zijn {Home, Away} defensief.
      if (betId === 1) {
        const vals = bet.values || [];
        const names = vals.map(v => String(v.value || '').trim()).sort().join('|');
        if (vals.length === 2 && names === 'Away|Home') {
          for (const v of vals) {
            const side = v.value === 'Home' ? 'home' : 'away';
            ml.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }
      // 3-way markt (Home/Draw/Away) — vaak label "Home/Away (Regular Time)", "3Way Result",
      // "Full Time Result" of "1X2". Detecteer op 3 values ongeacht bet id.
      const vals3 = (bet.values || []).filter(v => ['Home','Draw','Away','1','X','2'].includes(String(v.value ?? '').trim()));
      if (vals3.length === 3 && betId !== 1) {
        for (const v of vals3) {
          const s = String(v.value ?? '').trim();
          const side = (s === 'Home' || s === '1') ? 'home'
                     : (s === 'Draw' || s === 'X') ? 'draw'
                     : (s === 'Away' || s === '2') ? 'away' : null;
          if (side) threeWay.push({ side, price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }
      // Over/Under (bet id 3 for basketball total points, id 2 for hockey)
      if (betId === 2 || betId === 3) {
        for (const v of (bet.values || [])) {
          const m = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (m) tots.push({ side: m[1].toLowerCase(), point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }
      // Spread/Puckline (bet id 2 for basketball spread, id 3 for hockey puckline)
      if (betId === 2 || betId === 3) {
        for (const v of (bet.values || [])) {
          const m = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (m) spr.push({ side: m[1].toLowerCase() === 'home' ? 'home' : 'away', name: m[1].toLowerCase() === 'home' ? homeTeam : awayTeam, point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }

      // ── 1st Half / 1st Period markets (name-based detection) ──
      const is1H = betName.includes('1st half') || betName.includes('first half') || betName.includes('1st period') || betName.includes('first period') || betName.includes('1st inning');

      if (is1H) {
        // 1st Half Moneyline
        if (betName.includes('winner') || betName.includes('moneyline') || betName.includes('result')) {
          for (const v of (bet.values || [])) {
            const side = v.value === 'Home' ? 'home' : v.value === 'Away' ? 'away' : null;
            if (side) halfML.push({ side, name: side === 'home' ? homeTeam : awayTeam, price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
        // 1st Half Over/Under
        for (const v of (bet.values || [])) {
          const m = (v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (m) halfTotals.push({ side: m[1].toLowerCase(), point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
        }
        // 1st Half Spread
        for (const v of (bet.values || [])) {
          const m = (v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (m) halfSpreads.push({ side: m[1].toLowerCase() === 'home' ? 'home' : 'away', name: m[1].toLowerCase() === 'home' ? homeTeam : awayTeam, point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName });
        }
      }

      // ── F5 / 1st 5 Innings (baseball) ──
      // Pitcher-driven markt: eerste 5 innings settlement, zwaar afhankelijk van starting pitcher.
      // api-sports bet names: "1st 5 Innings Winner" (ML), "1st 5 Innings Total" (O/U),
      // "1st 5 Innings Run Line" (spread).
      const isF5 = betName.includes('1st 5 inning') || betName.includes('first 5 inning') ||
                   betName.includes('1st 5 innings') || betName.includes('f5 ');
      if (isF5) {
        // F5 ML: 2 of 3 values (met of zonder tie)
        if (betName.includes('winner') || betName.includes('moneyline') || betName.includes('result')) {
          const vals = bet.values || [];
          const hasDraw = vals.some(v => String(v.value || '').trim() === 'Draw');
          for (const v of vals) {
            const val = String(v.value || '').trim();
            const price = parseFloat(v.odd) || 0;
            if (price <= 1.0) continue;
            // Store apart als halfML entry met tag 'f5' in side voor downstream herkenning
            if (val === 'Home') halfML.push({ side: 'home', name: homeTeam, price, bookie: bkName, market: 'f5', hasDraw });
            else if (val === 'Away') halfML.push({ side: 'away', name: awayTeam, price, bookie: bkName, market: 'f5', hasDraw });
            else if (val === 'Draw' && hasDraw) halfML.push({ side: 'draw', price, bookie: bkName, market: 'f5', hasDraw });
          }
        }
        // F5 Total
        for (const v of (bet.values || [])) {
          const m = String(v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (m) halfTotals.push({ side: m[1].toLowerCase(), point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName, market: 'f5' });
        }
        // F5 Spread
        for (const v of (bet.values || [])) {
          const m = String(v.value || '').match(/(Home|Away)\s*([+-][\d.]+)/i);
          if (m) halfSpreads.push({ side: m[1].toLowerCase() === 'home' ? 'home' : 'away', name: m[1].toLowerCase() === 'home' ? homeTeam : awayTeam, point: parseFloat(m[2]), price: parseFloat(v.odd) || 0, bookie: bkName, market: 'f5' });
        }
      }

      // ── NRFI / 1st Inning scoring (baseball) ──
      if (betName.includes('1st inning') || betName.includes('nrfi') || betName.includes('first inning')) {
        for (const v of (bet.values || [])) {
          const val = (v.value || '').toLowerCase();
          // "Yes" = runs scored, "No" = no runs (NRFI)
          if (val === 'yes' || val === 'no' || val === 'over' || val === 'under') {
            const isNRFI = val === 'no' || val === 'under'; // NRFI = no runs
            nrfi.push({ side: isNRFI ? 'nrfi' : 'yrfi', price: parseFloat(v.odd) || 0, bookie: bkName });
          }
        }
      }

      // ── Team Totals (Home/Away Team Total Goals/Points, incl. OT full-game lijn) ──
      // Voorbeeld bet names: "Home Team Total Goals (Including OT)" of "Home Team Total Points"
      const isTeamTotalBet = (betName.includes('home team total') || betName.includes('away team total')) &&
        !betName.includes('1st') && !betName.includes('2nd') && !betName.includes('3rd') &&
        !betName.includes('period') && !betName.includes('half') && !betName.includes('quarter');
      if (isTeamTotalBet) {
        const team = betName.includes('home') ? 'home' : 'away';
        for (const v of (bet.values || [])) {
          const m = String(v.value || '').match(/(Over|Under)\s+([\d.]+)/i);
          if (m) {
            const point = parseFloat(m[2]);
            const price = parseFloat(v.odd) || 0;
            if (price > 1.0 && isFinite(point)) {
              teamTotals.push({ team, side: m[1].toLowerCase(), point, price, bookie: bkName });
            }
          }
        }
      }

      // ── Double Chance (3 values: Home/Draw, Home/Away, Draw/Away) ──
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

      // ── Draw No Bet (2 values: Home/Away, push op draw) ──
      if ((betName.includes('draw no bet') || betName === 'dnb') && !betName.includes('half') && !betName.includes('period')) {
        for (const v of (bet.values || [])) {
          const val = String(v.value || '').trim();
          const price = parseFloat(v.odd) || 0;
          if (price <= 1.0) continue;
          const side = val === 'Home' ? 'home' : val === 'Away' ? 'away' : null;
          if (side) dnb.push({ side, price, bookie: bkName });
        }
      }

      // ── Odd/Even total ──
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
  return { moneyline: ml, totals: tots, spreads: spr, halfML, halfTotals, halfSpreads, nrfi, oddEven, threeWay, teamTotals, doubleChance, dnb };
}

// poisson / poissonOver / poisson3Way / devigProportional / consensus3Way /
// deriveIncOTProbFrom3Way / modelMarketSanityCheck / NHL_OT_HOME_SHARE /
// MODEL_MARKET_DIVERGENCE_THRESHOLD komen uit lib/model-math.js

// ═══════════════════════════════════════════════════════════════════════════════
// MLB STATS API (statsapi.mlb.com)
// Publiekelijke MLB API, gratis, geen auth. Levert probable pitchers + season stats.
// Volledig fail-safe: als API faalt of timeout → return leeg, MLB-scan gaat door.
// ═══════════════════════════════════════════════════════════════════════════════

let _mlbPitcherCache = { date: null, data: null, at: 0 };
const MLB_CACHE_TTL_MS = 60 * 60 * 1000; // 1 uur per dag-slot
const MLB_FETCH_TIMEOUT_MS = 5000;

async function mlbFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MLB_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'EdgePickr/9.x' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

// Haalt probable pitchers + season stats op voor alle MLB games op een datum.
// Cached per-datum voor 1 uur. Return: [{home, away, homePitcher: {id, name, stats}, awayPitcher: ...}].
async function fetchMlbProbablePitchers(date) {
  if (_mlbPitcherCache.date === date && _mlbPitcherCache.data
      && Date.now() - _mlbPitcherCache.at < MLB_CACHE_TTL_MS) {
    return _mlbPitcherCache.data;
  }
  try {
    const schedUrl = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher`;
    const sched = await mlbFetch(schedUrl);
    if (!sched || !sched.dates) {
      _mlbPitcherCache = { date, data: [], at: Date.now() };
      return [];
    }
    const games = [];
    const pitcherIds = new Set();
    for (const d of (sched.dates || [])) {
      for (const g of (d.games || [])) {
        const home = g.teams?.home?.team?.name;
        const away = g.teams?.away?.team?.name;
        const hp = g.teams?.home?.probablePitcher;
        const ap = g.teams?.away?.probablePitcher;
        if (!home || !away) continue;
        games.push({
          home, away,
          homePitcherId: hp?.id || null, homePitcherName: hp?.fullName || null,
          awayPitcherId: ap?.id || null, awayPitcherName: ap?.fullName || null,
        });
        if (hp?.id) pitcherIds.add(hp.id);
        if (ap?.id) pitcherIds.add(ap.id);
      }
    }
    if (!pitcherIds.size) {
      _mlbPitcherCache = { date, data: games, at: Date.now() };
      return games;
    }
    // Batch season-stats fetch
    const currentYear = new Date().getFullYear();
    const idsParam = [...pitcherIds].join(',');
    const statsUrl = `https://statsapi.mlb.com/api/v1/people?personIds=${idsParam}&hydrate=stats(group=[pitching],type=[season],season=${currentYear})`;
    const statsResp = await mlbFetch(statsUrl);
    const pitcherStats = {};
    if (statsResp && Array.isArray(statsResp.people)) {
      for (const p of statsResp.people) {
        const group = (p.stats || []).find(s => s.group?.displayName === 'pitching');
        const split = group?.splits?.[0]?.stat;
        if (split) {
          const era = parseFloat(split.era);
          const whip = parseFloat(split.whip);
          const ip = parseFloat(split.inningsPitched);
          pitcherStats[p.id] = {
            name: p.fullName,
            era: isFinite(era) ? era : null,
            whip: isFinite(whip) ? whip : null,
            ip: isFinite(ip) ? ip : null,
          };
        }
      }
    }
    const result = games.map(g => ({
      ...g,
      homePitcher: g.homePitcherId ? pitcherStats[g.homePitcherId] || null : null,
      awayPitcher: g.awayPitcherId ? pitcherStats[g.awayPitcherId] || null : null,
    }));
    _mlbPitcherCache = { date, data: result, at: Date.now() };
    return result;
  } catch (e) {
    console.error('fetchMlbProbablePitchers fout:', e.message);
    _mlbPitcherCache = { date, data: [], at: Date.now() };
    return [];
  }
}

// pitcherAdjustment() komt uit lib/model-math.js

// ═══════════════════════════════════════════════════════════════════════════════
// NHL PUBLIC API (api-web.nhle.com)
// Publieke officiële NHL API, geen auth. Levert team season stats (shots, goals, etc).
// Fail-safe: bij API-outage/timeout → leeg return, hockey scan gaat door zonder signal.
// ═══════════════════════════════════════════════════════════════════════════════

// Map api-sports NHL team namen naar NHL API team abbreviations (tri-code).
// Wordt gebruikt om /club-stats-season/{ABBREV}/now op te vragen.
const NHL_TEAM_ABBREV = {
  'anaheim ducks': 'ANA',
  'arizona coyotes': 'UTA', 'utah mammoth': 'UTA', 'utah hockey club': 'UTA',
  'boston bruins': 'BOS',
  'buffalo sabres': 'BUF',
  'calgary flames': 'CGY',
  'carolina hurricanes': 'CAR',
  'chicago blackhawks': 'CHI',
  'colorado avalanche': 'COL',
  'columbus blue jackets': 'CBJ',
  'dallas stars': 'DAL',
  'detroit red wings': 'DET',
  'edmonton oilers': 'EDM',
  'florida panthers': 'FLA',
  'los angeles kings': 'LAK', 'la kings': 'LAK',
  'minnesota wild': 'MIN',
  'montreal canadiens': 'MTL',
  'nashville predators': 'NSH',
  'new jersey devils': 'NJD',
  'new york islanders': 'NYI',
  'new york rangers': 'NYR',
  'ottawa senators': 'OTT',
  'philadelphia flyers': 'PHI',
  'pittsburgh penguins': 'PIT',
  'seattle kraken': 'SEA',
  'san jose sharks': 'SJS',
  'st. louis blues': 'STL', 'st louis blues': 'STL',
  'tampa bay lightning': 'TBL',
  'toronto maple leafs': 'TOR',
  'vancouver canucks': 'VAN',
  'vegas golden knights': 'VGK',
  'washington capitals': 'WSH',
  'winnipeg jets': 'WPG',
};

function nhlTeamAbbrev(teamName) {
  const key = (teamName || '').toLowerCase().trim();
  return NHL_TEAM_ABBREV[key] || null;
}

const NHL_FETCH_TIMEOUT_MS = 5000;
const NHL_STATS_TTL_MS = 60 * 60 * 1000; // 1u cache per team
let _nhlStatsCache = {}; // abbrev → { data, at }

async function nhlFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NHL_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'EdgePickr/9.x' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

// Haal team season stats op via nhl.com public API. Retry-safe, cached 1u.
// Returns null bij outage of ongeldige data.
async function fetchNhlTeamStats(abbrev) {
  if (!abbrev) return null;
  const cached = _nhlStatsCache[abbrev];
  if (cached && Date.now() - cached.at < NHL_STATS_TTL_MS) return cached.data;
  try {
    const url = `https://api-web.nhle.com/v1/club-stats-season/${abbrev}`;
    const data = await nhlFetch(url);
    // Response: array van seasons; pak huidige (laatste).
    const seasons = Array.isArray(data) ? data : null;
    if (!seasons || !seasons.length) {
      _nhlStatsCache[abbrev] = { data: null, at: Date.now() };
      return null;
    }
    // De huidige actieve seizoen heeft gameTypeId=2 (regular) of 3 (playoffs)
    const current = seasons.filter(s => s.gameTypeId === 2 || s.gameTypeId === 3).pop() || seasons.pop();
    if (!current) {
      _nhlStatsCache[abbrev] = { data: null, at: Date.now() };
      return null;
    }
    // Normaliseer naar internal schema
    const stats = {
      abbrev,
      season: current.season,
      gp: current.gamesPlayed || 0,
      goalsFor: current.goalsFor || 0,
      goalsAgainst: current.goalsAgainst || 0,
      shotsFor: current.shotsForPerGame ? current.shotsForPerGame * (current.gamesPlayed || 0) : 0,
      shotsAgainst: current.shotsAgainstPerGame ? current.shotsAgainstPerGame * (current.gamesPlayed || 0) : 0,
      shotsForPerGame: current.shotsForPerGame || 0,
      shotsAgainstPerGame: current.shotsAgainstPerGame || 0,
      ppPct: current.powerPlayPct || 0,
      pkPct: current.penaltyKillPct || 0,
    };
    _nhlStatsCache[abbrev] = { data: stats, at: Date.now() };
    return stats;
  } catch {
    _nhlStatsCache[abbrev] = { data: null, at: Date.now() };
    return null;
  }
}

// Scan-wide filter: alleen odds van deze bookies tellen mee voor pick generation.
// Consensus/fair-probability blijft uit ALLE bookies berekend (markt-truth).
let _preferredBookiesLower = null;
function setPreferredBookies(list) {
  if (Array.isArray(list) && list.length) {
    _preferredBookiesLower = list.map(x => (x || '').toString().toLowerCase()).filter(Boolean);
  } else {
    _preferredBookiesLower = null;
  }
}

// Best odds uit parsed array; als preferredBookies is ingesteld, alleen die tellen.
function bestFromArr(arr) {
  let pool = arr || [];
  if (_preferredBookiesLower && pool.length) {
    pool = pool.filter(o => _preferredBookiesLower.some(p => (o.bookie || '').toLowerCase().includes(p)));
  }
  if (!pool.length) return { price: 0, bookie: '' };
  return pool.reduce((best, o) => o.price > best.price ? { price: +o.price.toFixed(3), bookie: o.bookie } : best, { price: 0, bookie: '' });
}

async function runBasketball(emit) {
  if (!AF_KEY) { emit({ log: '🏀 Basketball: geen API key' }); return []; }
  emit({ log: `🏀 Basketball scan · ${NBA_LEAGUES.length} competities` });

  const calib = loadCalib();
  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {}, 'basketball');
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  for (const league of NBA_LEAGUES) {
    try {
      // Fixtures today + tomorrow (night games)
      const [todayFixtures, tomorrowFixtures] = await Promise.all([
        afGet('v1.basketball.api-sports.io', '/games', { date: today, league: league.id, season: league.season }),
        afGet('v1.basketball.api-sports.io', '/games', { date: tomorrow, league: league.id, season: league.season }),
      ]);
      apiCallsUsed += 2;

      // Merge: tomorrow only before 10:00 Amsterdam (strict date check)
      const allFixtures = [...(todayFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        return koDate === today;
      }), ...(tomorrowFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        return koDate === tomorrow && koH < 10;
      })];

      const games = allFixtures.filter(f => {
        const st = f.status?.short || '';
        return st === 'NS' || st === 'SCH'; // Not started / Scheduled
      });

      if (!games.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `🏀 ${league.name}: ${games.length} wedstrijd(en)` });
      totalEvents += games.length;

      // Standings for form/rank
      await sleep(120);
      const standings = await afGet('v1.basketball.api-sports.io', '/standings', {
        league: league.id, season: league.season
      });
      apiCallsUsed++;

      // Build standings lookup: teamId → { rank, win, loss, form, teamName, home/away splits }
      const standingsMap = {};
      for (const group of (standings || [])) {
        // api-sports basketball standings: array of groups, each group is array of teams
        const teams = Array.isArray(group) ? group : [group];
        for (const t of teams) {
          const tid = t.team?.id;
          if (!tid) continue;
          const totalGames = (t.games?.win?.total || 0) + (t.games?.lose?.total || 0);
          standingsMap[tid] = {
            rank: t.position || 99,
            win: t.games?.win?.total || 0,
            loss: t.games?.lose?.total || 0,
            form: t.form || '',
            teamName: t.team?.name || '',
            streak: t.description || '',
            homeWin: t.games?.win?.home || 0,
            homeLoss: t.games?.lose?.home || 0,
            awayWin: t.games?.win?.away || 0,
            awayLoss: t.games?.lose?.away || 0,
            pointsFor: t.points?.for || 0,
            pointsAgainst: t.points?.against || 0,
            totalGames,
          };
        }
      }

      // Team stats cache for this league (basketball-specific: PPG, rebounds)
      const bbStatsCache = {};

      // Yesterday's fixtures for back-to-back detection
      await sleep(80);
      const yesterdayGames = await afGet('v1.basketball.api-sports.io', '/games', {
        date: yesterday, league: league.id, season: league.season
      });
      apiCallsUsed++;

      const playedYesterday = new Set();
      for (const g of (yesterdayGames || [])) {
        const st = g.status?.short || '';
        if (st === 'FT' || st === 'AOT') { // Finished or After OT
          if (g.teams?.home?.id) playedYesterday.add(g.teams.home.id);
          if (g.teams?.away?.id) playedYesterday.add(g.teams.away.id);
        }
      }

      for (const g of games) {
        const gameId = g.id;
        const hm = g.teams?.home?.name;
        const aw = g.teams?.away?.name;
        const hmId = g.teams?.home?.id;
        const awId = g.teams?.away?.id;
        if (!gameId || !hm || !aw) continue;

        const kickoffMs = new Date(g.date || g.time || g.timestamp * 1000).getTime();
        const ko = new Date(kickoffMs).toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // Odds
        await sleep(120);
        const oddsResp = await afGet('v1.basketball.api-sports.io', '/odds', { game: gameId });
        apiCallsUsed++;

        const parsed = parseGameOdds(oddsResp, hm, aw);
        if (!parsed.moneyline.length) continue;

        // v2 snapshots (fail-safe)
        snap.upsertFixture(supabase, {
          id: gameId, sport: 'basketball', leagueId: league.id, leagueName: league.name,
          season: league.season, homeTeamId: hmId, homeTeamName: hm,
          awayTeamId: awId, awayTeamName: aw, startTime: kickoffMs, status: 'scheduled',
        }).catch(() => {});
        snap.writeOddsSnapshots(supabase, gameId, snap.flattenParsedOdds(parsed)).catch(() => {});

        // Fair probabilities from moneyline consensus
        const homeOdds = parsed.moneyline.filter(o => o.side === 'home');
        const awayOdds = parsed.moneyline.filter(o => o.side === 'away');
        if (!homeOdds.length || !awayOdds.length) continue;

        const avgHomePrice = homeOdds.reduce((s,o)=>s+o.price,0) / homeOdds.length;
        const avgAwayPrice = awayOdds.reduce((s,o)=>s+o.price,0) / awayOdds.length;
        const totalIP = 1/avgHomePrice + 1/avgAwayPrice;
        if (totalIP < 0.5) continue;
        const fpHome = (1/avgHomePrice) / totalIP;
        const fpAway = (1/avgAwayPrice) / totalIP;

        // Standings adjustments
        const hmSt = hmId ? standingsMap[hmId] : null;
        const awSt = awId ? standingsMap[awId] : null;

        let posAdj = 0;
        if (hmSt && awSt) {
          posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.002));
        }

        // Form (last 5 from standings form string)
        let formAdj = 0;
        if (hmSt?.form && awSt?.form) {
          const fmScore = s => [...(s.slice(-5)||'')].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
          formAdj = Math.max(-0.05, Math.min(0.05, (fmScore(hmSt.form) - fmScore(awSt.form)) / 15 * 0.04));
        }

        // Back-to-back penalty: -4%
        let b2bAdj = 0, b2bNote = '';
        if (hmId && playedYesterday.has(hmId)) { b2bAdj -= 0.04; b2bNote += ` | ⚠️ ${hm.split(' ').pop()} B2B`; }
        if (awId && playedYesterday.has(awId)) { b2bAdj += 0.04; b2bNote += ` | ⚠️ ${aw.split(' ').pop()} B2B`; }

        // ── Advanced basketball signals ──
        let ppgAdj = 0, rebAdj = 0, homeSplitAdj = 0;
        let ppgNote = '', rebNote = '', splitNote = '';

        // PPG advantage from team statistics API (only for candidates, max 30 extra calls per league)
        if (hmSt && awSt && apiCallsUsed < 200) {
          for (const tid of [hmId, awId]) {
            if (tid && !bbStatsCache[tid] && apiCallsUsed < 200) {
              await sleep(100);
              try {
                const st = await afGet('v1.basketball.api-sports.io', '/statistics', { team: tid, league: league.id, season: league.season });
                apiCallsUsed++;
                if (st) {
                  const s = Array.isArray(st) ? st[0] : st;
                  bbStatsCache[tid] = {
                    ppg: s?.points?.for?.average?.all || 0,
                    ppgAllowed: s?.points?.against?.average?.all || 0,
                    rebFor: s?.rebounds?.total?.average || 0,
                    rebAgainst: s?.rebounds?.against?.average || 0,
                  };
                }
              } catch (e) { /* stats unavailable, skip */ }
            }
          }

          const hmStats = bbStatsCache[hmId];
          const awStats = bbStatsCache[awId];

          // PPG: if home PPG > away PPG allowed by >5 → +2% home
          if (hmStats?.ppg && awStats?.ppgAllowed) {
            const diff = hmStats.ppg - awStats.ppgAllowed;
            if (Math.abs(diff) > 5) {
              ppgAdj = Math.min(0.04, Math.max(-0.04, diff * 0.004));
              ppgNote = ` | PPG${diff > 0 ? '+' : ''}${diff.toFixed(1)}`;
            }
          }

          // Rebound differential: team with >3 more rebounds → +1.5%
          if (hmStats?.rebFor && awStats?.rebFor) {
            const hmRebDiff = (hmStats.rebFor || 0) - (hmStats.rebAgainst || 0);
            const awRebDiff = (awStats.rebFor || 0) - (awStats.rebAgainst || 0);
            const rebDiff = hmRebDiff - awRebDiff;
            if (Math.abs(rebDiff) > 3) {
              rebAdj = Math.min(0.04, Math.max(-0.04, rebDiff * 0.005));
              rebNote = ` | Reb:${rebDiff > 0 ? '+' : ''}${rebDiff.toFixed(1)}`;
            }
          }
        }

        // Home/away splits from standings (0 extra API calls)
        if (hmSt && awSt) {
          const hmHomeGames = (hmSt.homeWin || 0) + (hmSt.homeLoss || 0);
          const awAwayGames = (awSt.awayWin || 0) + (awSt.awayLoss || 0);
          if (hmHomeGames >= 5 && awAwayGames >= 5) {
            const hmHomeWR = hmSt.homeWin / hmHomeGames;
            const awAwayWR = awSt.awayWin / awAwayGames;
            const splitDiff = hmHomeWR - awAwayWR;
            if (Math.abs(splitDiff) > 0.15) {
              homeSplitAdj = Math.min(0.04, Math.max(-0.04, splitDiff * 0.08));
              splitNote = ` | H/A:${hmHomeWR.toFixed(2)}/${awAwayWR.toFixed(2)}`;
            }
          }
        }

        const totalAdv = ppgAdj + rebAdj + homeSplitAdj;

        const ha = league.ha || 0.03;
        const adjHome = Math.min(0.88, fpHome + ha + posAdj + formAdj + b2bAdj + totalAdv);
        const adjAway = Math.max(0.08, fpAway - ha * 0.5 - posAdj * 0.5 - formAdj * 0.5 - b2bAdj * 0.5 - totalAdv * 0.5);

        const bH = bestFromArr(homeOdds);
        const bA = bestFromArr(awayOdds);

        const homeEdge = bH.price > 0 ? adjHome * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway * bA.price - 1 : -1;

        // Build signals
        const matchSignals = [];
        if (ha !== 0) matchSignals.push(`home_adv:+${(ha*100).toFixed(1)}%`);
        if (Math.abs(formAdj) >= 0.005) matchSignals.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
        if (Math.abs(posAdj) >= 0.005) matchSignals.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
        if (b2bAdj !== 0) matchSignals.push(`b2b:${b2bAdj>0?'+':''}${(b2bAdj*100).toFixed(1)}%`);
        if (Math.abs(ppgAdj) >= 0.005) matchSignals.push(`ppg_advantage:${ppgAdj>0?'+':''}${(ppgAdj*100).toFixed(1)}%`);
        if (Math.abs(rebAdj) >= 0.005) matchSignals.push(`rebound_diff:${rebAdj>0?'+':''}${(rebAdj*100).toFixed(1)}%`);
        if (Math.abs(homeSplitAdj) >= 0.005) matchSignals.push(`home_away_split:${homeSplitAdj>0?'+':''}${(homeSplitAdj*100).toFixed(1)}%`);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const sharedNotes = `${posStr}${formNote}${b2bNote}${ppgNote}${rebNote}${splitNote}`;

        // v2: feature_snapshot + pick_candidates voor ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'basketball', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, b2bAdj, ppgAdj, rebAdj, homeSplitAdj,
        }, { standings_present: !!(hmSt && awSt) }).catch(() => {});
        if (_currentModelVersionId) {
          snap.recordMl2WayEvaluation({
            supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
            marketType: 'moneyline', fpHome, fpAway, adjHome, adjAway,
            bH, bA, homeEdge, awayEdge, minEdge: MIN_EDGE,
            maxWinnerOdds: MAX_WINNER_ODDS, matchSignals,
            debug: { sport: 'basketball', ha, signals: matchSignals },
          }).catch(() => {});
        }

        // Moneyline picks
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals);

        // Over/Under total points
        const overOdds = parsed.totals.filter(o => o.side === 'over');
        const underOdds = parsed.totals.filter(o => o.side === 'under');
        if (overOdds.length && underOdds.length) {
          // Group by point value and take the most common line
          const pointCounts = {};
          for (const o of [...overOdds, ...underOdds]) {
            pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          }
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.6);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.6);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🏀 Over ${line} pts`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} pts`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals);
            }
          }
        }

        // Spread
        const homeSpr = parsed.spreads.filter(o => o.side === 'home');
        const awaySpr = parsed.spreads.filter(o => o.side === 'away');
        if (homeSpr.length) {
          const best = bestFromArr(homeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = homeSpr[0].point > 0 ? `+${homeSpr[0].point}` : `${homeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, best.price,
                `Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (awaySpr.length) {
          const best = bestFromArr(awaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = awaySpr[0].point > 0 ? `+${awaySpr[0].point}` : `${awaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, best.price,
                `Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }

        // ── 1st Half Over/Under (basketball - research: 1H totals often mispriced) ──
        const h1Over = parsed.halfTotals.filter(o => o.side === 'over');
        const h1Under = parsed.halfTotals.filter(o => o.side === 'under');
        if (h1Over.length && h1Under.length) {
          const h1PointCounts = {};
          for (const o of [...h1Over, ...h1Under]) {
            h1PointCounts[o.point] = (h1PointCounts[o.point] || 0) + 1;
          }
          const h1MainLine = Object.entries(h1PointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (h1MainLine) {
            const h1Line = parseFloat(h1MainLine);
            const h1Ov = h1Over.filter(o => Math.abs(o.point - h1Line) < 0.6);
            const h1Un = h1Under.filter(o => Math.abs(o.point - h1Line) < 0.6);
            if (h1Ov.length && h1Un.length) {
              const h1AvgOvIP = h1Ov.reduce((s,o)=>s+1/o.price,0) / h1Ov.length;
              const h1AvgUnIP = h1Un.reduce((s,o)=>s+1/o.price,0) / h1Un.length;
              const h1TotIP = h1AvgOvIP + h1AvgUnIP;
              const h1OverP = h1TotIP > 0 ? h1AvgOvIP / h1TotIP : 0.5;
              const h1BestOv = bestFromArr(h1Ov);
              const h1BestUn = bestFromArr(h1Un);
              const h1OverEdge = h1OverP * h1BestOv.price - 1;
              const h1UnderEdge = (1-h1OverP) * h1BestUn.price - 1;

              if (h1OverEdge >= MIN_EDGE && h1BestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🏀 1H Over ${h1Line} pts`, h1BestOv.price,
                  `1st Half O/U: ${(h1OverP*100).toFixed(1)}% over | ${h1BestOv.bookie}: ${h1BestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(h1OverP*100), h1OverEdge * 0.20, kickoffTime, h1BestOv.bookie, matchSignals);
              if (h1UnderEdge >= MIN_EDGE && h1BestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 1H Under ${h1Line} pts`, h1BestUn.price,
                  `1st Half O/U: ${((1-h1OverP)*100).toFixed(1)}% under | ${h1BestUn.bookie}: ${h1BestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-h1OverP)*100), h1UnderEdge * 0.18, kickoffTime, h1BestUn.bookie, matchSignals);
            }
          }
        }

        // ── 1st Half Spread (basketball - research: mispriced vs full-game spread) ──
        const h1HomeSpr = parsed.halfSpreads.filter(o => o.side === 'home');
        const h1AwaySpr = parsed.halfSpreads.filter(o => o.side === 'away');
        if (h1HomeSpr.length) {
          const best = bestFromArr(h1HomeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = h1HomeSpr[0].point > 0 ? `+${h1HomeSpr[0].point}` : `${h1HomeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${hm} ${pt}`, best.price,
                `1st Half Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.18, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (h1AwaySpr.length) {
          const best = bestFromArr(h1AwaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = h1AwaySpr[0].point > 0 ? `+${h1AwaySpr[0].point}` : `${h1AwaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${aw} ${pt}`, best.price,
                `1st Half Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.18, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ 🏀 ${league.name}: ${err.message}` });
    }
  }

  // Tag picks
  for (const p of picks)     { p.scanType = 'nba'; p.sport = 'basketball'; }
  for (const p of combiPool) { p.scanType = 'nba'; p.sport = 'basketball'; }

  emit({ log: `🏀 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} basketball picks` });

  // Save scan entry
  if (picks.length) saveScanEntry(picks, 'nba', totalEvents);

  return picks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HOCKEY SCANNER · api-sports.io hockey
// ═══════════════════════════════════════════════════════════════════════════════

// Hockey bookies die ML settlen op 60-min (geen OT) → ML picks van deze bookies overslaan
// want ons kansmodel is inclusief OT. Betekent dat er alleen ML-picks komen van Bet365, Pinnacle, DK etc.
const HOCKEY_60MIN_BOOKIES = ['unibet', 'toto', 'betcity', 'ladbrokes'];

async function runHockey(emit) {
  if (!AF_KEY) { emit({ log: '🏒 Hockey: geen API key' }); return []; }
  emit({ log: `🏒 Hockey scan · ${NHL_LEAGUES.length} competities` });

  const calib = loadCalib();
  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {}, 'hockey');
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  for (const league of NHL_LEAGUES) {
    try {
      // Fixtures today + tomorrow (night games)
      const [todayFixtures, tomorrowFixtures] = await Promise.all([
        afGet('v1.hockey.api-sports.io', '/games', { date: today, league: league.id, season: league.season }),
        afGet('v1.hockey.api-sports.io', '/games', { date: tomorrow, league: league.id, season: league.season }),
      ]);
      apiCallsUsed += 2;

      // Merge: tomorrow only before 10:00 Amsterdam (strict date check)
      const allFixtures = [...(todayFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        return koDate === today;
      }), ...(tomorrowFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        return koDate === tomorrow && koH < 10;
      })];

      const games = allFixtures.filter(f => {
        const st = f.status?.short || '';
        return st === 'NS' || st === 'SCH';
      });

      if (!games.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `🏒 ${league.name}: ${games.length} wedstrijd(en)` });
      totalEvents += games.length;

      // Standings
      await sleep(120);
      const standings = await afGet('v1.hockey.api-sports.io', '/standings', {
        league: league.id, season: league.season
      });
      apiCallsUsed++;

      const standingsMap = {};
      for (const group of (standings || [])) {
        const teams = Array.isArray(group) ? group : [group];
        for (const t of teams) {
          const tid = t.team?.id;
          if (!tid) continue;
          const totalGames = (t.games?.win?.total || 0) + (t.games?.lose?.total || 0);
          standingsMap[tid] = {
            rank: t.position || 99,
            win: t.games?.win?.total || 0,
            loss: t.games?.lose?.total || 0,
            form: t.form || '',
            teamName: t.team?.name || '',
            goalsFor: t.goals?.for || 0,
            goalsAgainst: t.goals?.against || 0,
            homeWin: t.games?.win?.home || 0,
            homeLoss: t.games?.lose?.home || 0,
            awayWin: t.games?.win?.away || 0,
            awayLoss: t.games?.lose?.away || 0,
            totalGames,
          };
        }
      }

      // Yesterday's fixtures for back-to-back detection
      await sleep(80);
      const yesterdayGames = await afGet('v1.hockey.api-sports.io', '/games', {
        date: yesterday, league: league.id, season: league.season
      });
      apiCallsUsed++;

      const playedYesterday = new Set();
      for (const g of (yesterdayGames || [])) {
        const st = g.status?.short || '';
        if (st === 'FT' || st === 'AOT' || st === 'AP') {
          if (g.teams?.home?.id) playedYesterday.add(g.teams.home.id);
          if (g.teams?.away?.id) playedYesterday.add(g.teams.away.id);
        }
      }

      for (const g of games) {
        const gameId = g.id;
        const hm = g.teams?.home?.name;
        const aw = g.teams?.away?.name;
        const hmId = g.teams?.home?.id;
        const awId = g.teams?.away?.id;
        if (!gameId || !hm || !aw) continue;

        const kickoffMs = new Date(g.date || g.time || g.timestamp * 1000).getTime();
        const ko = new Date(kickoffMs).toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // Odds
        await sleep(120);
        const oddsResp = await afGet('v1.hockey.api-sports.io', '/odds', { game: gameId });
        apiCallsUsed++;

        const parsed = parseGameOdds(oddsResp, hm, aw);
        if (!parsed.moneyline.length) continue;

        // ── v2 SNAPSHOT LAYER ─────────────────────────────────────────────
        // Schrijf fixture + odds-snapshots voor latere learning/backtest.
        // Volledig fail-safe; geen impact op pick-flow als snapshots falen.
        snap.upsertFixture(supabase, {
          id: gameId, sport: 'hockey', leagueId: league.id, leagueName: league.name,
          season: league.season, homeTeamId: hmId, homeTeamName: hm,
          awayTeamId: awId, awayTeamName: aw, startTime: kickoffMs, status: 'scheduled',
        }).catch(() => {});
        snap.writeOddsSnapshots(supabase, gameId, snap.flattenParsedOdds(parsed)).catch(() => {});

        const homeOdds = parsed.moneyline.filter(o => o.side === 'home');
        const awayOdds = parsed.moneyline.filter(o => o.side === 'away');
        if (!homeOdds.length || !awayOdds.length) continue;

        const avgHomePrice = homeOdds.reduce((s,o)=>s+o.price,0) / homeOdds.length;
        const avgAwayPrice = awayOdds.reduce((s,o)=>s+o.price,0) / awayOdds.length;
        const totalIP = 1/avgHomePrice + 1/avgAwayPrice;
        if (totalIP < 0.5) continue;
        const fpHome = (1/avgHomePrice) / totalIP;
        const fpAway = (1/avgAwayPrice) / totalIP;

        const hmSt = hmId ? standingsMap[hmId] : null;
        const awSt = awId ? standingsMap[awId] : null;

        let posAdj = 0;
        if (hmSt && awSt) {
          posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.002));
        }

        let formAdj = 0;
        if (hmSt?.form && awSt?.form) {
          const fmScore = s => [...(s.slice(-5)||'')].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
          formAdj = Math.max(-0.05, Math.min(0.05, (fmScore(hmSt.form) - fmScore(awSt.form)) / 15 * 0.04));
        }

        // Back-to-back penalty: -4%
        let b2bAdj = 0, b2bNote = '';
        if (hmId && playedYesterday.has(hmId)) { b2bAdj -= 0.04; b2bNote += ` | ⚠️ ${hm.split(' ').pop()} B2B`; }
        if (awId && playedYesterday.has(awId)) { b2bAdj += 0.04; b2bNote += ` | ⚠️ ${aw.split(' ').pop()} B2B`; }

        // ── Advanced hockey signals (from standings, 0 extra API calls) ──
        let goalDiffAdj = 0, homeRecordAdj = 0;
        let goalDiffNote = '', homeRecordNote = '';

        // Goal differential per game: strong = >0.5 per game → +2%
        if (hmSt && awSt && hmSt.totalGames >= 5 && awSt.totalGames >= 5) {
          const hmGDpg = (hmSt.goalsFor - hmSt.goalsAgainst) / hmSt.totalGames;
          const awGDpg = (awSt.goalsFor - awSt.goalsAgainst) / awSt.totalGames;
          const gdDiff = hmGDpg - awGDpg;
          if (Math.abs(gdDiff) > 0.5) {
            goalDiffAdj = Math.min(0.04, Math.max(-0.04, gdDiff * 0.02));
            goalDiffNote = ` | GD/g:${hmGDpg > 0 ? '+' : ''}${hmGDpg.toFixed(2)} vs ${awGDpg > 0 ? '+' : ''}${awGDpg.toFixed(2)}`;
          }
        }

        // Home/away record: strong home vs weak away → +2%
        if (hmSt && awSt) {
          const hmHomeGames = (hmSt.homeWin || 0) + (hmSt.homeLoss || 0);
          const awAwayGames = (awSt.awayWin || 0) + (awSt.awayLoss || 0);
          if (hmHomeGames >= 5 && awAwayGames >= 5) {
            const hmHomeWR = hmSt.homeWin / hmHomeGames;
            const awAwayWR = awSt.awayWin / awAwayGames;
            const splitDiff = hmHomeWR - awAwayWR;
            if (Math.abs(splitDiff) > 0.15) {
              homeRecordAdj = Math.min(0.04, Math.max(-0.04, splitDiff * 0.08));
              homeRecordNote = ` | H/A:${hmHomeWR.toFixed(2)}/${awAwayWR.toFixed(2)}`;
            }
          }
        }

        // NHL shots-differential signal (van nhl.com public API).
        // Cached per team voor 1u; bij API-outage geen signal (graceful fallback).
        const hmAbbrev = nhlTeamAbbrev(hm);
        const awAbbrev = nhlTeamAbbrev(aw);
        let shotsSig = { adj: 0, note: null, valid: false };
        if (hmAbbrev && awAbbrev) {
          const [hmNhl, awNhl] = await Promise.all([
            fetchNhlTeamStats(hmAbbrev).catch(() => null),
            fetchNhlTeamStats(awAbbrev).catch(() => null),
          ]);
          shotsSig = shotsDifferentialAdjustment(hmNhl, awNhl);
        }

        const totalAdv = goalDiffAdj + homeRecordAdj + shotsSig.adj;

        const ha = league.ha || 0.03;
        const adjHome = Math.min(0.88, fpHome + ha + posAdj + formAdj + b2bAdj + totalAdv);
        const adjAway = Math.max(0.08, fpAway - ha * 0.5 - posAdj * 0.5 - formAdj * 0.5 - b2bAdj * 0.5 - totalAdv * 0.5);

        // Alleen 2-way ML bij bookies die inclusief OT settlen (anders overschat model de edge)
        const isOTBookieHockey = b => !HOCKEY_60MIN_BOOKIES.some(x => (b||'').toLowerCase().includes(x));
        const homeOddsOT = homeOdds.filter(o => isOTBookieHockey(o.bookie));
        const awayOddsOT = awayOdds.filter(o => isOTBookieHockey(o.bookie));
        const bH = bestFromArr(homeOddsOT.length ? homeOddsOT : homeOdds);
        const bA = bestFromArr(awayOddsOT.length ? awayOddsOT : awayOdds);

        const homeEdge = bH.price > 0 ? adjHome * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway * bA.price - 1 : -1;

        const matchSignals = [];
        if (ha !== 0) matchSignals.push(`home_ice:+${(ha*100).toFixed(1)}%`);
        if (Math.abs(formAdj) >= 0.005) matchSignals.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
        if (Math.abs(posAdj) >= 0.005) matchSignals.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
        if (b2bAdj !== 0) matchSignals.push(`b2b:${b2bAdj>0?'+':''}${(b2bAdj*100).toFixed(1)}%`);
        if (Math.abs(goalDiffAdj) >= 0.005) matchSignals.push(`goal_diff:${goalDiffAdj>0?'+':''}${(goalDiffAdj*100).toFixed(1)}%`);
        if (Math.abs(homeRecordAdj) >= 0.005) matchSignals.push(`home_away_record:${homeRecordAdj>0?'+':''}${(homeRecordAdj*100).toFixed(1)}%`);
        if (shotsSig.valid && Math.abs(shotsSig.adj) >= 0.003) matchSignals.push(`nhl_shots_diff:${shotsSig.adj>0?'+':''}${(shotsSig.adj*100).toFixed(1)}%`);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const shotsNote = shotsSig.valid ? ` | ${shotsSig.note}` : '';
        const sharedNotes = `${posStr}${formNote}${b2bNote}${goalDiffNote}${homeRecordNote}${shotsNote}`;

        // Per-game diagnostics (admin-only)
        const picksBefore = picks.length;
        const diag = [];

        // Expected goals per team (Poisson input, gebruikt voor 3-way én team totals)
        const hmGFpg = hmSt?.totalGames ? (hmSt.goalsFor / hmSt.totalGames) : 3.1;
        const hmGApg = hmSt?.totalGames ? (hmSt.goalsAgainst / hmSt.totalGames) : 3.1;
        const awGFpg = awSt?.totalGames ? (awSt.goalsFor / awSt.totalGames) : 3.1;
        const awGApg = awSt?.totalGames ? (awSt.goalsAgainst / awSt.totalGames) : 3.1;
        const formBoost = formAdj * 0.5;
        const b2bBoost = b2bAdj * 0.5;
        const expHome = Math.max(0.5, (hmGFpg + awGApg) / 2 + 0.15 + formBoost);
        const expAway = Math.max(0.5, (awGFpg + hmGApg) / 2 - 0.05 - b2bBoost);

        // ── 2-way ML MET MARKET-SANITY-CHECK ──
        const marketFairReg = parsed.threeWay?.length ? consensus3Way(parsed.threeWay) : null;
        const marketFairIncOT = marketFairReg ? deriveIncOTProbFrom3Way(marketFairReg) : null;

        // v2 snapshots: market_consensus voor 3-way én inc-OT (afgeleid)
        if (marketFairReg) {
          // Bereken overround uit ruwe 3-way odds
          const totalIp3 = parsed.threeWay.reduce((s, o) => s + 1 / o.price, 0) / Math.max(1, marketFairReg.bookieCount);
          snap.writeMarketConsensus(supabase, {
            fixtureId: gameId, marketType: 'threeway', line: null,
            consensusProb: { home: marketFairReg.home, draw: marketFairReg.draw, away: marketFairReg.away },
            bookmakerCount: marketFairReg.bookieCount,
            overround: totalIp3 - 1,
            qualityScore: snap.consensusQualityScore(marketFairReg.bookieCount, totalIp3 - 1),
          }).catch(() => {});
        }
        if (marketFairIncOT) {
          snap.writeMarketConsensus(supabase, {
            fixtureId: gameId, marketType: 'moneyline_incl_ot_derived', line: null,
            consensusProb: { home: marketFairIncOT.home, away: marketFairIncOT.away },
            bookmakerCount: marketFairReg?.bookieCount || 0,
            qualityScore: snap.consensusQualityScore(marketFairReg?.bookieCount || 0, 0),
          }).catch(() => {});
        }
        // Feature snapshot (sport-specifieke + market features bij elkaar)
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'hockey',
          fpHome, fpAway,
          adjHome, adjAway,
          ha, posAdj, formAdj, b2bAdj, goalDiffAdj, homeRecordAdj,
          shotsDiffAdj: shotsSig.adj, shotsDiffValid: shotsSig.valid,
          marketHomeProb: marketFairReg?.home, marketDrawProb: marketFairReg?.draw, marketAwayProb: marketFairReg?.away,
        }, {
          standings_present: !!(hmSt && awSt),
          three_way_bookies: marketFairReg?.bookieCount || 0,
          shots_signal_valid: shotsSig.valid,
        }).catch(() => {});

        // ── v2 MODEL RUN + PICK CANDIDATES voor hockey 2-way ML ──────────
        // Bewaar elke evaluatie (passed of niet) zodat we later signal-lift kunnen meten.
        if (marketFairIncOT && _currentModelVersionId) {
          (async () => {
            try {
              const runId = await snap.writeModelRun(supabase, {
                fixtureId: gameId, modelVersionId: _currentModelVersionId,
                marketType: 'moneyline_incl_ot', line: null,
                baselineProb: { home: marketFairIncOT.home, away: marketFairIncOT.away },
                modelDelta: { home: adjHome - marketFairIncOT.home, away: adjAway - marketFairIncOT.away },
                finalProb: { home: adjHome, away: adjAway },
                debug: { lambda_h: expHome, lambda_a: expAway, ha, signals: matchSignals },
              });
              if (!runId) return;
              // Home candidate
              const homeAccepted = homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && isOTBookieHockey(bH.bookie) && sanityHome?.agree;
              let homeReason = null;
              if (!homeAccepted) {
                if (bH.price < 1.60) homeReason = 'price_too_low';
                else if (bH.price > MAX_WINNER_ODDS) homeReason = 'price_too_high';
                else if (!isOTBookieHockey(bH.bookie)) homeReason = 'bookie_not_inc_ot';
                else if (homeEdge < MIN_EDGE) homeReason = `edge_below_min (${(homeEdge*100).toFixed(1)}%)`;
                else if (sanityHome && !sanityHome.agree) homeReason = `sanity_fail (div ${(sanityHome.divergence*100).toFixed(1)}%)`;
                else homeReason = 'unknown';
              }
              snap.writePickCandidate(supabase, {
                modelRunId: runId, fixtureId: gameId, selectionKey: 'home',
                bookmaker: bH.bookie || 'none', bookmakerOdds: bH.price,
                fairProb: adjHome, edgePct: homeEdge,
                passedFilters: homeAccepted, rejectedReason: homeReason,
                signals: matchSignals,
              }).catch(() => {});
              // Away candidate
              const awayAccepted = awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && isOTBookieHockey(bA.bookie) && sanityAway?.agree;
              let awayReason = null;
              if (!awayAccepted) {
                if (bA.price < 1.60) awayReason = 'price_too_low';
                else if (bA.price > MAX_WINNER_ODDS) awayReason = 'price_too_high';
                else if (!isOTBookieHockey(bA.bookie)) awayReason = 'bookie_not_inc_ot';
                else if (awayEdge < MIN_EDGE) awayReason = `edge_below_min (${(awayEdge*100).toFixed(1)}%)`;
                else if (sanityAway && !sanityAway.agree) awayReason = `sanity_fail (div ${(sanityAway.divergence*100).toFixed(1)}%)`;
                else awayReason = 'unknown';
              }
              snap.writePickCandidate(supabase, {
                modelRunId: runId, fixtureId: gameId, selectionKey: 'away',
                bookmaker: bA.bookie || 'none', bookmakerOdds: bA.price,
                fairProb: adjAway, edgePct: awayEdge,
                passedFilters: awayAccepted, rejectedReason: awayReason,
                signals: matchSignals,
              }).catch(() => {});
            } catch (e) { /* swallow */ }
          })();
        }
        const sanityHome = marketFairIncOT ? modelMarketSanityCheck(adjHome, marketFairIncOT.home) : null;
        const sanityAway = marketFairIncOT ? modelMarketSanityCheck(adjAway, marketFairIncOT.away) : null;

        if (!marketFairIncOT) diag.push('geen 3-way markt → geen 2-way sanity mogelijk');
        if (!homeOddsOT.length) diag.push('geen OT-bookie odds home');
        if (!awayOddsOT.length) diag.push('geen OT-bookie odds away');
        if (homeEdge < MIN_EDGE) diag.push(`home 2-way edge ${(homeEdge*100).toFixed(1)}% < ${(MIN_EDGE*100).toFixed(1)}%`);
        if (awayEdge < MIN_EDGE) diag.push(`away 2-way edge ${(awayEdge*100).toFixed(1)}% < ${(MIN_EDGE*100).toFixed(1)}%`);
        if (sanityHome && !sanityHome.agree) diag.push(`2-way home sanity FAIL: model ${(sanityHome.modelProb*100).toFixed(1)}% vs markt ${(sanityHome.marketProb*100).toFixed(1)}% (div ${(sanityHome.divergence*100).toFixed(1)}%)`);
        if (sanityAway && !sanityAway.agree) diag.push(`2-way away sanity FAIL: model ${(sanityAway.modelProb*100).toFixed(1)}% vs markt ${(sanityAway.marketProb*100).toFixed(1)}% (div ${(sanityAway.divergence*100).toFixed(1)}%)`);

        if (marketFairIncOT) {
          if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS
              && isOTBookieHockey(bH.bookie) && sanityHome.agree) {
            mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
              `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | Markt-fair: ${(marketFairIncOT.home*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
              Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, [...matchSignals, 'sanity_ok']);
          }
          if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS
              && isOTBookieHockey(bA.bookie) && sanityAway.agree) {
            mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
              `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | Markt-fair: ${(marketFairIncOT.away*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
              Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, [...matchSignals, 'sanity_ok']);
          }
        }

        // ── 3-weg ML (Home/Draw/Away 60-min regulation) via Poisson ──
        // Veilig voor elke bookie: 3-weg wordt altijd op 60-min gesettled, geen OT-verschil.
        if (parsed.threeWay && parsed.threeWay.length) {
          // expHome/expAway zijn al boven berekend (voor team totals + 3-way gedeeld)
          const p3 = poisson3Way(expHome, expAway);

          const h3 = parsed.threeWay.filter(o => o.side === 'home');
          const d3 = parsed.threeWay.filter(o => o.side === 'draw');
          const a3 = parsed.threeWay.filter(o => o.side === 'away');
          const bH3 = bestFromArr(h3);
          const bD3 = bestFromArr(d3);
          const bA3 = bestFromArr(a3);

          const e3H = bH3.price > 0 ? p3.pHome * bH3.price - 1 : -1;
          const e3D = bD3.price > 0 ? p3.pDraw * bD3.price - 1 : -1;
          const e3A = bA3.price > 0 ? p3.pAway * bA3.price - 1 : -1;

          // Sanity-check Poisson tegen market consensus: als ons model > threshold
          // divergeert van de market, skip de pick. Poisson kan scheef gaan bij
          // teams met extreme vorm-variatie of onvolledige standings.
          const sanH3 = marketFairReg ? modelMarketSanityCheck(p3.pHome, marketFairReg.home) : { agree: true };
          const sanD3 = marketFairReg ? modelMarketSanityCheck(p3.pDraw, marketFairReg.draw) : { agree: true };
          const sanA3 = marketFairReg ? modelMarketSanityCheck(p3.pAway, marketFairReg.away) : { agree: true };

          const threeNote = ` | λh:${expHome.toFixed(2)} λa:${expAway.toFixed(2)} | 60-min`;
          if (e3H >= MIN_EDGE && bH3.price >= 1.60 && bH3.price <= MAX_WINNER_ODDS && sanH3.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🕐 ${hm} wint (60-min)`, bH3.price,
              `3-way: ${(p3.pHome*100).toFixed(1)}% | Markt: ${marketFairReg ? (marketFairReg.home*100).toFixed(1)+'%' : 'n/a'} | ${bH3.bookie}: ${bH3.price}${threeNote} | ${ko}`,
              Math.round(p3.pHome*100), e3H * 0.26, kickoffTime, bH3.bookie, [...matchSignals, '3way_ml', 'sanity_ok']);
          if (e3D >= MIN_EDGE && bD3.price >= 2.80 && bD3.price <= 8.00 && sanD3.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🕐 Gelijkspel (60-min)`, bD3.price,
              `3-way: ${(p3.pDraw*100).toFixed(1)}% gelijk | Markt: ${marketFairReg ? (marketFairReg.draw*100).toFixed(1)+'%' : 'n/a'} | ${bD3.bookie}: ${bD3.price}${threeNote} | ${ko}`,
              Math.round(p3.pDraw*100), e3D * 0.20, kickoffTime, bD3.bookie, [...matchSignals, '3way_ml', 'sanity_ok']);
          if (e3A >= MIN_EDGE && bA3.price >= 1.60 && bA3.price <= MAX_WINNER_ODDS && sanA3.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🕐 ${aw} wint (60-min)`, bA3.price,
              `3-way: ${(p3.pAway*100).toFixed(1)}% | Markt: ${marketFairReg ? (marketFairReg.away*100).toFixed(1)+'%' : 'n/a'} | ${bA3.bookie}: ${bA3.price}${threeNote} | ${ko}`,
              Math.round(p3.pAway*100), e3A * 0.26, kickoffTime, bA3.bookie, [...matchSignals, '3way_ml', 'sanity_ok']);
        }

        // ── Team Totals (full game incl OT) via Poisson ──
        // Per team een Poisson(lambda) distributie; P(Home scoort > N) = 1 - CDF(N).
        // Gebruikt lambda + OT-adjustment (OT voegt gemiddeld 0.1 extra goal per team toe
        // voor de ~23% games die OT bereiken → +0.023 scoring per team all-games avg).
        if (parsed.teamTotals && parsed.teamTotals.length) {
          const lambdaHome = expHome + 0.023; // kleine bump voor incl-OT scoring
          const lambdaAway = expAway + 0.023;
          const homeTT = parsed.teamTotals.filter(o => o.team === 'home');
          const awayTT = parsed.teamTotals.filter(o => o.team === 'away');
          const linesHome = [...new Set(homeTT.map(o => o.point))];
          const linesAway = [...new Set(awayTT.map(o => o.point))];

          for (const line of linesHome) {
            const ov = homeTT.filter(o => o.side === 'over' && o.point === line);
            const un = homeTT.filter(o => o.side === 'under' && o.point === line);
            const pOver = poissonOver(lambdaHome, line);
            if (ov.length) {
              const best = bestFromArr(ov);
              const edge = best.price > 0 ? pOver * best.price - 1 : -1;
              if (edge >= MIN_EDGE && best.price >= 1.60 && best.price <= 3.5) {
                mkP(`${hm} vs ${aw}`, league.name, `📈 ${hm} TT Over ${line}`, best.price,
                  `Team Total Home: ${(pOver*100).toFixed(1)}% over ${line} (λ=${lambdaHome.toFixed(2)}) | ${best.bookie}: ${best.price} | ${ko}`,
                  Math.round(pOver*100), edge * 0.22, kickoffTime, best.bookie, [...matchSignals, 'team_total_home']);
              }
            }
            if (un.length) {
              const best = bestFromArr(un);
              const pUnder = 1 - pOver;
              const edge = best.price > 0 ? pUnder * best.price - 1 : -1;
              if (edge >= MIN_EDGE && best.price >= 1.60 && best.price <= 3.5) {
                mkP(`${hm} vs ${aw}`, league.name, `📉 ${hm} TT Under ${line}`, best.price,
                  `Team Total Home: ${(pUnder*100).toFixed(1)}% under ${line} (λ=${lambdaHome.toFixed(2)}) | ${best.bookie}: ${best.price} | ${ko}`,
                  Math.round(pUnder*100), edge * 0.22, kickoffTime, best.bookie, [...matchSignals, 'team_total_home']);
              }
            }
          }
          for (const line of linesAway) {
            const ov = awayTT.filter(o => o.side === 'over' && o.point === line);
            const un = awayTT.filter(o => o.side === 'under' && o.point === line);
            const pOver = poissonOver(lambdaAway, line);
            if (ov.length) {
              const best = bestFromArr(ov);
              const edge = best.price > 0 ? pOver * best.price - 1 : -1;
              if (edge >= MIN_EDGE && best.price >= 1.60 && best.price <= 3.5) {
                mkP(`${hm} vs ${aw}`, league.name, `📈 ${aw} TT Over ${line}`, best.price,
                  `Team Total Away: ${(pOver*100).toFixed(1)}% over ${line} (λ=${lambdaAway.toFixed(2)}) | ${best.bookie}: ${best.price} | ${ko}`,
                  Math.round(pOver*100), edge * 0.22, kickoffTime, best.bookie, [...matchSignals, 'team_total_away']);
              }
            }
            if (un.length) {
              const best = bestFromArr(un);
              const pUnder = 1 - pOver;
              const edge = best.price > 0 ? pUnder * best.price - 1 : -1;
              if (edge >= MIN_EDGE && best.price >= 1.60 && best.price <= 3.5) {
                mkP(`${hm} vs ${aw}`, league.name, `📉 ${aw} TT Under ${line}`, best.price,
                  `Team Total Away: ${(pUnder*100).toFixed(1)}% under ${line} (λ=${lambdaAway.toFixed(2)}) | ${best.bookie}: ${best.price} | ${ko}`,
                  Math.round(pUnder*100), edge * 0.22, kickoffTime, best.bookie, [...matchSignals, 'team_total_away']);
              }
            }
          }
        }

        // Over/Under total goals
        const overOdds = parsed.totals.filter(o => o.side === 'over');
        const underOdds = parsed.totals.filter(o => o.side === 'under');
        if (overOdds.length && underOdds.length) {
          const pointCounts = {};
          for (const o of [...overOdds, ...underOdds]) {
            pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          }
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.6);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.6);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🏒 Over ${line} goals`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} goals`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals);
            }
          }
        }

        // Puck line (spread)
        const homeSpr = parsed.spreads.filter(o => o.side === 'home');
        const awaySpr = parsed.spreads.filter(o => o.side === 'away');
        if (homeSpr.length) {
          const best = bestFromArr(homeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = homeSpr[0].point > 0 ? `+${homeSpr[0].point}` : `${homeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, best.price,
                `Puck Line | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (awaySpr.length) {
          const best = bestFromArr(awaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = awaySpr[0].point > 0 ? `+${awaySpr[0].point}` : `${awaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, best.price,
                `Puck Line | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }

        // ── 1st Period Over/Under (hockey - derivative markets often mispriced) ──
        const p1Over = parsed.halfTotals.filter(o => o.side === 'over');
        const p1Under = parsed.halfTotals.filter(o => o.side === 'under');
        if (p1Over.length && p1Under.length) {
          const p1PointCounts = {};
          for (const o of [...p1Over, ...p1Under]) {
            p1PointCounts[o.point] = (p1PointCounts[o.point] || 0) + 1;
          }
          const p1MainLine = Object.entries(p1PointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (p1MainLine) {
            const p1Line = parseFloat(p1MainLine);
            const p1Ov = p1Over.filter(o => Math.abs(o.point - p1Line) < 0.6);
            const p1Un = p1Under.filter(o => Math.abs(o.point - p1Line) < 0.6);
            if (p1Ov.length && p1Un.length) {
              const p1AvgOvIP = p1Ov.reduce((s,o)=>s+1/o.price,0) / p1Ov.length;
              const p1AvgUnIP = p1Un.reduce((s,o)=>s+1/o.price,0) / p1Un.length;
              const p1TotIP = p1AvgOvIP + p1AvgUnIP;
              const p1OverP = p1TotIP > 0 ? p1AvgOvIP / p1TotIP : 0.5;
              const p1BestOv = bestFromArr(p1Ov);
              const p1BestUn = bestFromArr(p1Un);
              const p1OverEdge = p1OverP * p1BestOv.price - 1;
              const p1UnderEdge = (1-p1OverP) * p1BestUn.price - 1;

              if (p1OverEdge >= MIN_EDGE && p1BestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🏒 P1 Over ${p1Line} goals`, p1BestOv.price,
                  `1st Period O/U: ${(p1OverP*100).toFixed(1)}% over | ${p1BestOv.bookie}: ${p1BestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(p1OverP*100), p1OverEdge * 0.20, kickoffTime, p1BestOv.bookie, matchSignals);
              if (p1UnderEdge >= MIN_EDGE && p1BestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 P1 Under ${p1Line} goals`, p1BestUn.price,
                  `1st Period O/U: ${((1-p1OverP)*100).toFixed(1)}% under | ${p1BestUn.bookie}: ${p1BestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-p1OverP)*100), p1UnderEdge * 0.18, kickoffTime, p1BestUn.bookie, matchSignals);
            }
          }
        }

        // ── Both Teams Score (hockey - BTTS equivalent: both teams score at least 1 goal) ──
        // Use full-game goal expectations from standings to estimate BTTS probability
        if (hmSt && awSt && hmSt.totalGames >= 5 && awSt.totalGames >= 5) {
          const hmGFpg = hmSt.goalsFor / hmSt.totalGames;
          const awGFpg = awSt.goalsFor / awSt.totalGames;
          // Poisson probability of scoring 0 goals
          const hmP0 = Math.exp(-hmGFpg);
          const awP0 = Math.exp(-awGFpg);
          // BTTS = 1 - P(home=0) - P(away=0) + P(both=0)
          const bttsP = 1 - hmP0 - awP0 + hmP0 * awP0;
          // Check if odd/even market has BTTS-like pricing, or use totals as proxy
          // Look for odds that match our BTTS estimate
          const oddOdds = parsed.oddEven.filter(o => o.side === 'odd');
          const evenOdds = parsed.oddEven.filter(o => o.side === 'even');
          if (oddOdds.length && evenOdds.length) {
            const bestOdd = bestFromArr(oddOdds);
            const bestEven = bestFromArr(evenOdds);
            // Odd total is roughly correlated with both teams scoring
            // Use consensus for fair probability
            const avgOddIP = oddOdds.reduce((s,o)=>s+1/o.price,0) / oddOdds.length;
            const avgEvenIP = evenOdds.reduce((s,o)=>s+1/o.price,0) / evenOdds.length;
            const oeTotal = avgOddIP + avgEvenIP;
            const oddP = oeTotal > 0 ? avgOddIP / oeTotal : 0.5;
            const oddEdge = oddP * bestOdd.price - 1;
            const evenEdge = (1-oddP) * bestEven.price - 1;

            if (oddEdge >= MIN_EDGE && bestOdd.price >= 1.60)
              mkP(`${hm} vs ${aw}`, league.name, `🎲 Odd Total`, bestOdd.price,
                `Odd/Even: ${(oddP*100).toFixed(1)}% odd | ${bestOdd.bookie}: ${bestOdd.price}${sharedNotes} | ${ko}`,
                Math.round(oddP*100), oddEdge * 0.16, kickoffTime, bestOdd.bookie, matchSignals);
            if (evenEdge >= MIN_EDGE && bestEven.price >= 1.60)
              mkP(`${hm} vs ${aw}`, league.name, `🎲 Even Total`, bestEven.price,
                `Odd/Even: ${((1-oddP)*100).toFixed(1)}% even | ${bestEven.bookie}: ${bestEven.price}${sharedNotes} | ${ko}`,
                Math.round((1-oddP)*100), evenEdge * 0.16, kickoffTime, bestEven.bookie, matchSignals);
          }
        }

        // Admin-only: als deze game geen pick opleverde, log waarom
        if (picks.length === picksBefore && diag.length) {
          emit({ log: `  └─ ${hm} vs ${aw}: ${diag.slice(0, 3).join(' · ')}` });
        }
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ 🏒 ${league.name}: ${err.message}` });
    }
  }

  // Tag picks
  for (const p of picks)     { p.scanType = 'nhl'; p.sport = 'hockey'; }
  for (const p of combiPool) { p.scanType = 'nhl'; p.sport = 'hockey'; }

  emit({ log: `🏒 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} hockey picks` });

  if (picks.length) saveScanEntry(picks, 'nhl', totalEvents);

  return picks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BASEBALL SCANNER · api-sports.io baseball
// ═══════════════════════════════════════════════════════════════════════════════

async function runBaseball(emit) {
  if (!AF_KEY) { emit({ log: '⚾ Baseball: geen API key' }); return []; }
  emit({ log: `⚾ Baseball scan · ${BASEBALL_LEAGUES.length} competities` });

  // Probable pitchers ophalen (één call per datum). Graceful fallback: bij falen geen pitcher signal.
  const pitcherDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }); // MLB gebruikt US-datums
  const mlbGames = await fetchMlbProbablePitchers(pitcherDate).catch(() => []);
  if (Array.isArray(mlbGames) && mlbGames.length) {
    emit({ log: `⚾ MLB StatsAPI: ${mlbGames.length} games met probable pitchers opgehaald` });
  } else {
    emit({ log: `⚠️ MLB StatsAPI niet beschikbaar, scan gaat door zonder pitcher signal` });
  }
  // Build team-name → pitcher-pair map voor fuzzy lookup
  const pitcherByTeamPair = (homeName, awayName) => {
    if (!Array.isArray(mlbGames) || !mlbGames.length) return null;
    let best = null, bestScore = 0;
    for (const g of mlbGames) {
      const s = teamMatchScore(g.home, homeName) + teamMatchScore(g.away, awayName);
      if (s > bestScore && s >= 120) { best = g; bestScore = s; }
    }
    return best;
  };

  const calib = loadCalib();
  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {}, 'baseball');
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  for (const league of BASEBALL_LEAGUES) {
    try {
      // Fixtures today + tomorrow (night games)
      const [todayFixtures, tomorrowFixtures] = await Promise.all([
        afGet('v1.baseball.api-sports.io', '/games', { date: today, league: league.id, season: league.season }),
        afGet('v1.baseball.api-sports.io', '/games', { date: tomorrow, league: league.id, season: league.season }),
      ]);
      apiCallsUsed += 2;

      // Merge: tomorrow only before 10:00 Amsterdam (strict date check)
      const allFixtures = [...(todayFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        return koDate === today;
      }), ...(tomorrowFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        return koDate === tomorrow && koH < 10;
      })];

      const games = allFixtures.filter(f => {
        const st = f.status?.short || '';
        return st === 'NS' || st === 'SCH';
      });

      if (!games.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `⚾ ${league.name}: ${games.length} wedstrijd(en)` });
      totalEvents += games.length;

      // Standings for form/rank
      await sleep(120);
      const standings = await afGet('v1.baseball.api-sports.io', '/standings', {
        league: league.id, season: league.season
      });
      apiCallsUsed++;

      // Build standings lookup
      const standingsMap = {};
      for (const group of (standings || [])) {
        const teams = Array.isArray(group) ? group : [group];
        for (const t of teams) {
          const tid = t.team?.id;
          if (!tid) continue;
          const totalGames = (t.games?.win?.total || 0) + (t.games?.lose?.total || 0);
          standingsMap[tid] = {
            rank: t.position || 99,
            win: t.games?.win?.total || 0,
            loss: t.games?.lose?.total || 0,
            form: t.form || '',
            teamName: t.team?.name || '',
            homeWin: t.games?.win?.home || 0,
            homeLoss: t.games?.lose?.home || 0,
            awayWin: t.games?.win?.away || 0,
            awayLoss: t.games?.lose?.away || 0,
            pointsFor: t.points?.for || 0,
            pointsAgainst: t.points?.against || 0,
            totalGames,
          };
        }
      }

      for (const g of games) {
        const gameId = g.id;
        const hm = g.teams?.home?.name;
        const aw = g.teams?.away?.name;
        const hmId = g.teams?.home?.id;
        const awId = g.teams?.away?.id;
        if (!gameId || !hm || !aw) continue;

        const kickoffMs = new Date(g.date || g.time || g.timestamp * 1000).getTime();
        const ko = new Date(kickoffMs).toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // Odds
        await sleep(120);
        const oddsResp = await afGet('v1.baseball.api-sports.io', '/odds', { game: gameId });
        apiCallsUsed++;

        const parsed = parseGameOdds(oddsResp, hm, aw);
        if (!parsed.moneyline.length) continue;

        // v2 snapshots (fail-safe)
        snap.upsertFixture(supabase, {
          id: gameId, sport: 'baseball', leagueId: league.id, leagueName: league.name,
          season: league.season, homeTeamId: hmId, homeTeamName: hm,
          awayTeamId: awId, awayTeamName: aw, startTime: kickoffMs, status: 'scheduled',
        }).catch(() => {});
        snap.writeOddsSnapshots(supabase, gameId, snap.flattenParsedOdds(parsed)).catch(() => {});

        // Fair probabilities from moneyline consensus
        const homeOdds = parsed.moneyline.filter(o => o.side === 'home');
        const awayOdds = parsed.moneyline.filter(o => o.side === 'away');
        if (!homeOdds.length || !awayOdds.length) continue;

        const avgHomePrice = homeOdds.reduce((s,o)=>s+o.price,0) / homeOdds.length;
        const avgAwayPrice = awayOdds.reduce((s,o)=>s+o.price,0) / awayOdds.length;
        const totalIP = 1/avgHomePrice + 1/avgAwayPrice;
        if (totalIP < 0.5) continue;
        const fpHome = (1/avgHomePrice) / totalIP;
        const fpAway = (1/avgAwayPrice) / totalIP;

        // Standings adjustments
        const hmSt = hmId ? standingsMap[hmId] : null;
        const awSt = awId ? standingsMap[awId] : null;

        let posAdj = 0;
        if (hmSt && awSt) {
          posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.002));
        }

        // Form (last 5-10 from standings form string)
        let formAdj = 0;
        if (hmSt?.form && awSt?.form) {
          const fmScore = s => [...(s.slice(-10)||'')].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
          formAdj = Math.max(-0.05, Math.min(0.05, (fmScore(hmSt.form) - fmScore(awSt.form)) / 30 * 0.04));
        }

        // ── Advanced baseball signals (from standings, 0 extra API calls) ──
        let runDiffAdj = 0, homeAwayAdj = 0, streakAdj = 0;
        let runDiffNote = '', homeAwayNote = '', streakNote = '';

        // Run differential per game: >0.5/game → +2%
        if (hmSt && awSt && hmSt.totalGames >= 10 && awSt.totalGames >= 10) {
          const hmRDpg = (hmSt.pointsFor - hmSt.pointsAgainst) / hmSt.totalGames;
          const awRDpg = (awSt.pointsFor - awSt.pointsAgainst) / awSt.totalGames;
          const rdDiff = hmRDpg - awRDpg;
          if (Math.abs(rdDiff) > 0.5) {
            runDiffAdj = Math.min(0.04, Math.max(-0.04, rdDiff * 0.02));
            runDiffNote = ` | RD/g:${hmRDpg > 0 ? '+' : ''}${hmRDpg.toFixed(2)} vs ${awRDpg > 0 ? '+' : ''}${awRDpg.toFixed(2)}`;
          }
        }

        // Home/away record splits
        if (hmSt && awSt) {
          const hmHomeGames = (hmSt.homeWin || 0) + (hmSt.homeLoss || 0);
          const awAwayGames = (awSt.awayWin || 0) + (awSt.awayLoss || 0);
          if (hmHomeGames >= 10 && awAwayGames >= 10) {
            const hmHomeWR = hmSt.homeWin / hmHomeGames;
            const awAwayWR = awSt.awayWin / awAwayGames;
            const splitDiff = hmHomeWR - awAwayWR;
            if (Math.abs(splitDiff) > 0.10) {
              homeAwayAdj = Math.min(0.04, Math.max(-0.04, splitDiff * 0.06));
              homeAwayNote = ` | H/A:${hmHomeWR.toFixed(2)}/${awAwayWR.toFixed(2)}`;
            }
          }
        }

        // Win streak detection: 5+ game win streak → +1.5%
        if (hmSt?.form) {
          const hmStreak = (hmSt.form.match(/W+$/) || [''])[0].length;
          if (hmStreak >= 5) { streakAdj += Math.min(0.04, hmStreak * 0.003); streakNote += ` | ${hm.split(' ').pop()} W${hmStreak}`; }
          const hmLStreak = (hmSt.form.match(/L+$/) || [''])[0].length;
          if (hmLStreak >= 5) { streakAdj -= Math.min(0.04, hmLStreak * 0.003); streakNote += ` | ${hm.split(' ').pop()} L${hmLStreak}`; }
        }
        if (awSt?.form) {
          const awStreak = (awSt.form.match(/W+$/) || [''])[0].length;
          if (awStreak >= 5) { streakAdj -= Math.min(0.04, awStreak * 0.003); streakNote += ` | ${aw.split(' ').pop()} W${awStreak}`; }
          const awLStreak = (awSt.form.match(/L+$/) || [''])[0].length;
          if (awLStreak >= 5) { streakAdj += Math.min(0.04, awLStreak * 0.003); streakNote += ` | ${aw.split(' ').pop()} L${awLStreak}`; }
        }
        streakAdj = Math.min(0.04, Math.max(-0.04, streakAdj));

        // Pitcher signal (MLB-only): ERA-differential via StatsAPI
        const mlbMatch = pitcherByTeamPair(hm, aw);
        const pitcherSig = mlbMatch ? pitcherAdjustment(mlbMatch.homePitcher, mlbMatch.awayPitcher) : { adj: 0, note: null, valid: false };

        const totalAdv = runDiffAdj + homeAwayAdj + streakAdj + pitcherSig.adj;

        // Home advantage (~54% in MLB)
        const ha = 0.04;
        const adjHome = Math.min(0.88, fpHome + ha + posAdj + formAdj + totalAdv);
        const adjAway = Math.max(0.08, fpAway - ha * 0.5 - posAdj * 0.5 - formAdj * 0.5 - totalAdv * 0.5);

        const bH = bestFromArr(homeOdds);
        const bA = bestFromArr(awayOdds);

        const homeEdge = bH.price > 0 ? adjHome * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway * bA.price - 1 : -1;

        // Build signals
        const matchSignals = [];
        if (ha !== 0) matchSignals.push(`baseball_home:+${(ha*100).toFixed(1)}%`);
        if (Math.abs(formAdj) >= 0.005) matchSignals.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
        if (Math.abs(posAdj) >= 0.005) matchSignals.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
        if (Math.abs(runDiffAdj) >= 0.005) matchSignals.push(`run_diff:${runDiffAdj>0?'+':''}${(runDiffAdj*100).toFixed(1)}%`);
        if (Math.abs(homeAwayAdj) >= 0.005) matchSignals.push(`home_away_split:${homeAwayAdj>0?'+':''}${(homeAwayAdj*100).toFixed(1)}%`);
        if (Math.abs(streakAdj) >= 0.005) matchSignals.push(`streak:${streakAdj>0?'+':''}${(streakAdj*100).toFixed(1)}%`);
        if (pitcherSig.valid && Math.abs(pitcherSig.adj) >= 0.005) {
          matchSignals.push(`pitcher_era_diff:${pitcherSig.adj>0?'+':''}${(pitcherSig.adj*100).toFixed(1)}%`);
        }

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-10)||'?'} vs ${awSt?.form?.slice(-10)||'?'}` : '';
        const pitcherNote = pitcherSig.valid ? ` | ${pitcherSig.note}` : '';
        const sharedNotes = `${posStr}${formNote}${runDiffNote}${homeAwayNote}${streakNote}${pitcherNote}`;

        // v2: feature_snapshot + pick_candidates voor MLB ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'baseball', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, runDiffAdj, homeAwayAdj, streakAdj,
          pitcherAdj: pitcherSig.adj, pitcherValid: pitcherSig.valid,
        }, {
          standings_present: !!(hmSt && awSt),
          pitcher_signal_valid: pitcherSig.valid,
          mlb_match_found: !!mlbMatch,
        }).catch(() => {});
        if (_currentModelVersionId) {
          snap.recordMl2WayEvaluation({
            supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
            marketType: 'moneyline', fpHome, fpAway, adjHome, adjAway,
            bH, bA, homeEdge, awayEdge, minEdge: MIN_EDGE,
            maxWinnerOdds: MAX_WINNER_ODDS, matchSignals,
            debug: { sport: 'baseball', ha, pitcher_valid: pitcherSig.valid, signals: matchSignals },
          }).catch(() => {});
        }

        // Moneyline picks
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals);

        // Over/Under total runs
        const overOdds = parsed.totals.filter(o => o.side === 'over');
        const underOdds = parsed.totals.filter(o => o.side === 'under');
        if (overOdds.length && underOdds.length) {
          const pointCounts = {};
          for (const o of [...overOdds, ...underOdds]) {
            pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          }
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.6);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.6);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `⚾ Over ${line} runs`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} runs`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals);
            }
          }
        }

        // Run Line (spread, usually -1.5/+1.5)
        const homeSpr = parsed.spreads.filter(o => o.side === 'home');
        const awaySpr = parsed.spreads.filter(o => o.side === 'away');
        if (homeSpr.length) {
          const best = bestFromArr(homeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = homeSpr[0].point > 0 ? `+${homeSpr[0].point}` : `${homeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, best.price,
                `Run Line | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (awaySpr.length) {
          const best = bestFromArr(awaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = awaySpr[0].point > 0 ? `+${awaySpr[0].point}` : `${awaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, best.price,
                `Run Line | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }

        // ── NRFI (No Run First Inning) ──
        // Research: NRFI is profitable when both pitchers have low FIP / strong 1st innings
        // We use team form + run differential as proxy for pitching quality
        const nrfiOdds = parsed.nrfi.filter(o => o.side === 'nrfi');
        const yrfiOdds = parsed.nrfi.filter(o => o.side === 'yrfi');
        if (nrfiOdds.length && yrfiOdds.length) {
          const avgNrfiIP = nrfiOdds.reduce((s,o)=>s+1/o.price,0) / nrfiOdds.length;
          const avgYrfiIP = yrfiOdds.reduce((s,o)=>s+1/o.price,0) / yrfiOdds.length;
          const nrfiTotIP = avgNrfiIP + avgYrfiIP;
          const nrfiP = nrfiTotIP > 0 ? avgNrfiIP / nrfiTotIP : 0.5;

          // Signal: low-scoring teams (low runs per game) favor NRFI
          let nrfiAdj = 0;
          if (hmSt && awSt && hmSt.totalGames >= 10 && awSt.totalGames >= 10) {
            const hmRpg = hmSt.pointsFor / hmSt.totalGames;
            const awRpg = awSt.pointsFor / awSt.totalGames;
            const avgRpg = (hmRpg + awRpg) / 2;
            // Lower scoring teams → boost NRFI probability slightly
            if (avgRpg < 4.0) nrfiAdj = 0.02;       // low-scoring matchup
            else if (avgRpg > 5.5) nrfiAdj = -0.02;  // high-scoring matchup
          }

          const bestNrfi = bestFromArr(nrfiOdds);
          const bestYrfi = bestFromArr(yrfiOdds);
          const adjNrfiP = Math.min(0.85, Math.max(0.15, nrfiP + nrfiAdj));
          const nrfiEdge = adjNrfiP * bestNrfi.price - 1;
          const yrfiEdge = (1 - adjNrfiP) * bestYrfi.price - 1;

          if (nrfiEdge >= MIN_EDGE && bestNrfi.price >= 1.60)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ NRFI (No Run 1st Inning)`, bestNrfi.price,
              `NRFI: ${(adjNrfiP*100).toFixed(1)}% | ${bestNrfi.bookie}: ${bestNrfi.price}${sharedNotes} | ${ko}`,
              Math.round(adjNrfiP*100), nrfiEdge * 0.18, kickoffTime, bestNrfi.bookie, matchSignals);
          if (yrfiEdge >= MIN_EDGE && bestYrfi.price >= 1.60)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ YRFI (Yes Run 1st Inning)`, bestYrfi.price,
              `YRFI: ${((1-adjNrfiP)*100).toFixed(1)}% | ${bestYrfi.bookie}: ${bestYrfi.price}${sharedNotes} | ${ko}`,
              Math.round((1-adjNrfiP)*100), yrfiEdge * 0.18, kickoffTime, bestYrfi.bookie, matchSignals);
        }

        // ── F5 (1st 5 Innings) markten ──
        // Pitcher-driven markt: weight pitcher signal 3x zwaarder (ERA-diff bepaalt ~80% van F5).
        // Alleen picks als we valid pitcher data hebben (anders te weinig model-info).
        const f5ML = (parsed.halfML || []).filter(o => o.market === 'f5');
        const f5Totals = (parsed.halfTotals || []).filter(o => o.market === 'f5');
        const f5Spreads = (parsed.halfSpreads || []).filter(o => o.market === 'f5');

        if (pitcherSig.valid && f5ML.length) {
          // F5 probability: Gebruik fpHome/fpAway als baseline + pitcher × 3
          const f5PitcherAdj = Math.max(-0.12, Math.min(0.12, pitcherSig.adj * 3));
          const f5Home = Math.min(0.85, Math.max(0.15, fpHome + f5PitcherAdj + ha * 0.7));
          const f5Away = Math.min(0.85, Math.max(0.15, fpAway - f5PitcherAdj * 0.7 - ha * 0.35));

          const f5H = f5ML.filter(o => o.side === 'home');
          const f5A = f5ML.filter(o => o.side === 'away');
          const bF5H = bestFromArr(f5H);
          const bF5A = bestFromArr(f5A);
          const eF5H = bF5H.price > 0 ? f5Home * bF5H.price - 1 : -1;
          const eF5A = bF5A.price > 0 ? f5Away * bF5A.price - 1 : -1;

          if (eF5H >= MIN_EDGE && bF5H.price >= 1.60 && bF5H.price <= MAX_WINNER_ODDS)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 ${hm}`, bF5H.price,
              `F5 (1st 5 inn): ${(f5Home*100).toFixed(1)}% | ${bF5H.bookie}: ${bF5H.price} | ${pitcherSig.note} | ${ko}`,
              Math.round(f5Home*100), eF5H * 0.24, kickoffTime, bF5H.bookie, [...matchSignals, 'f5_ml', 'pitcher_3x']);
          if (eF5A >= MIN_EDGE && bF5A.price >= 1.60 && bF5A.price <= MAX_WINNER_ODDS)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 ${aw}`, bF5A.price,
              `F5 (1st 5 inn): ${(f5Away*100).toFixed(1)}% | ${bF5A.bookie}: ${bF5A.price} | ${pitcherSig.note} | ${ko}`,
              Math.round(f5Away*100), eF5A * 0.24, kickoffTime, bF5A.bookie, [...matchSignals, 'f5_ml', 'pitcher_3x']);
        }

        // F5 Totals (consensus-driven — market weet beter dan wij)
        if (f5Totals.length) {
          const pointCounts = {};
          for (const o of f5Totals) pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = f5Totals.filter(o => o.side === 'over' && Math.abs(o.point - line) < 0.6);
            const un = f5Totals.filter(o => o.side === 'under' && Math.abs(o.point - line) < 0.6);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP = avgOvIP + avgUnIP;
              const overP = totIP > 0 ? avgOvIP / totIP : 0.5;
              // Pitcher signal op F5 totals: betere pitcher samen → lagere score → under-bias
              const pitcherUnderBias = pitcherSig.valid ? Math.max(0, (4.0 - (mlbMatch?.homePitcher?.era || 4) - (mlbMatch?.awayPitcher?.era || 4) + 4.0) * 0.01) : 0;
              const adjOverP = Math.max(0.05, Math.min(0.95, overP - pitcherUnderBias));
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const eOv = bestOv.price > 0 ? adjOverP * bestOv.price - 1 : -1;
              const eUn = bestUn.price > 0 ? (1 - adjOverP) * bestUn.price - 1 : -1;

              if (eOv >= MIN_EDGE && bestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 Over ${line}`, bestOv.price,
                  `F5 Total: ${(adjOverP*100).toFixed(1)}% over ${line} | ${bestOv.bookie}: ${bestOv.price} | ${ko}`,
                  Math.round(adjOverP*100), eOv * 0.20, kickoffTime, bestOv.bookie, [...matchSignals, 'f5_total']);
              if (eUn >= MIN_EDGE && bestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 Under ${line}`, bestUn.price,
                  `F5 Total: ${((1-adjOverP)*100).toFixed(1)}% under ${line} | ${bestUn.bookie}: ${bestUn.price} | ${ko}`,
                  Math.round((1-adjOverP)*100), eUn * 0.20, kickoffTime, bestUn.bookie, [...matchSignals, 'f5_total']);
            }
          }
        }
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ ⚾ ${league.name}: ${err.message}` });
    }
  }

  // Tag picks
  for (const p of picks)     { p.scanType = 'mlb'; p.sport = 'baseball'; }
  for (const p of combiPool) { p.scanType = 'mlb'; p.sport = 'baseball'; }

  emit({ log: `⚾ ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} baseball picks` });

  if (picks.length) saveScanEntry(picks, 'mlb', totalEvents);

  return picks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NFL SCANNER · api-sports.io american-football
// ═══════════════════════════════════════════════════════════════════════════════

async function runFootballUS(emit) {
  if (!AF_KEY) { emit({ log: '🏈 NFL: geen API key' }); return []; }
  emit({ log: `🏈 NFL scan · ${NFL_LEAGUES.length} competities` });

  const calib = loadCalib();
  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {}, 'american-football');
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  for (const league of NFL_LEAGUES) {
    try {
      // Fixtures today + tomorrow (night games)
      const [todayFixtures, tomorrowFixtures] = await Promise.all([
        afGet('v1.american-football.api-sports.io', '/games', { date: today, league: league.id, season: league.season }),
        afGet('v1.american-football.api-sports.io', '/games', { date: tomorrow, league: league.id, season: league.season }),
      ]);
      apiCallsUsed += 2;

      // Merge: tomorrow only before 10:00 Amsterdam (strict date check)
      const allFixtures = [...(todayFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        return koDate === today;
      }), ...(tomorrowFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        return koDate === tomorrow && koH < 10;
      })];

      const games = allFixtures.filter(f => {
        const st = f.status?.short || '';
        return st === 'NS' || st === 'SCH';
      });

      if (!games.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `🏈 ${league.name}: ${games.length} wedstrijd(en)` });
      totalEvents += games.length;

      // Standings
      await sleep(120);
      const standings = await afGet('v1.american-football.api-sports.io', '/standings', {
        league: league.id, season: league.season
      });
      apiCallsUsed++;

      const standingsMap = {};
      for (const group of (standings || [])) {
        const teams = Array.isArray(group) ? group : [group];
        for (const t of teams) {
          const tid = t.team?.id;
          if (!tid) continue;
          const totalGames = (t.games?.win?.total || 0) + (t.games?.lose?.total || 0);
          standingsMap[tid] = {
            rank: t.position || 99,
            win: t.games?.win?.total || 0,
            loss: t.games?.lose?.total || 0,
            form: t.form || '',
            teamName: t.team?.name || '',
            homeWin: t.games?.win?.home || 0,
            homeLoss: t.games?.lose?.home || 0,
            awayWin: t.games?.win?.away || 0,
            awayLoss: t.games?.lose?.away || 0,
            pointsFor: t.points?.for || 0,
            pointsAgainst: t.points?.against || 0,
            group: t.group?.name || '',
            totalGames,
          };
        }
      }

      for (const g of games) {
        const gameId = g.id;
        const hm = g.teams?.home?.name;
        const aw = g.teams?.away?.name;
        const hmId = g.teams?.home?.id;
        const awId = g.teams?.away?.id;
        if (!gameId || !hm || !aw) continue;

        const kickoffMs = new Date(g.date || g.time || g.timestamp * 1000).getTime();
        const ko = new Date(kickoffMs).toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // Odds
        await sleep(120);
        const oddsResp = await afGet('v1.american-football.api-sports.io', '/odds', { game: gameId });
        apiCallsUsed++;

        const parsed = parseGameOdds(oddsResp, hm, aw);
        if (!parsed.moneyline.length) continue;

        // v2 snapshots (fail-safe)
        snap.upsertFixture(supabase, {
          id: gameId, sport: 'american-football', leagueId: league.id, leagueName: league.name,
          season: league.season, homeTeamId: hmId, homeTeamName: hm,
          awayTeamId: awId, awayTeamName: aw, startTime: kickoffMs, status: 'scheduled',
        }).catch(() => {});
        snap.writeOddsSnapshots(supabase, gameId, snap.flattenParsedOdds(parsed)).catch(() => {});

        const homeOdds = parsed.moneyline.filter(o => o.side === 'home');
        const awayOdds = parsed.moneyline.filter(o => o.side === 'away');
        if (!homeOdds.length || !awayOdds.length) continue;

        const avgHomePrice = homeOdds.reduce((s,o)=>s+o.price,0) / homeOdds.length;
        const avgAwayPrice = awayOdds.reduce((s,o)=>s+o.price,0) / awayOdds.length;
        const totalIP = 1/avgHomePrice + 1/avgAwayPrice;
        if (totalIP < 0.5) continue;
        const fpHome = (1/avgHomePrice) / totalIP;
        const fpAway = (1/avgAwayPrice) / totalIP;

        const hmSt = hmId ? standingsMap[hmId] : null;
        const awSt = awId ? standingsMap[awId] : null;

        let posAdj = 0;
        if (hmSt && awSt) {
          posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.002));
        }

        // Form (last 3-5 games - smaller sample in NFL)
        let formAdj = 0;
        if (hmSt?.form && awSt?.form) {
          const fmScore = s => [...(s.slice(-5)||'')].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
          formAdj = Math.max(-0.05, Math.min(0.05, (fmScore(hmSt.form) - fmScore(awSt.form)) / 15 * 0.04));
        }

        // Home advantage (~57% in NFL)
        const ha = 0.057;
        // Bye week: markt overvalueert dit (prijst +1.0 punt, werkelijk +0.3)
        // Bron: Frontiers in Behavioral Economics 2024
        // We gebruiken +1% ipv +3% — de EDGE zit in dat de markt het overvalueert
        let byeAdj = 0, byeNote = '';
        if (hmSt?.form && hmSt.form.length > 0 && hmSt.form.slice(-1) === 'B') { byeAdj += 0.01; byeNote += ` | 💤 ${hm.split(' ').pop()} off bye (overvalued by market)`; }
        if (awSt?.form && awSt.form.length > 0 && awSt.form.slice(-1) === 'B') { byeAdj -= 0.01; byeNote += ` | 💤 ${aw.split(' ').pop()} off bye (overvalued by market)`; }

        // ── Advanced NFL signals (from standings, 0 extra API calls) ──
        let ptsDiffAdj = 0, homeRecordAdj = 0, divisionAdj = 0;
        let ptsDiffNote = '', homeRecordNote = '', divisionNote = '';

        // Points differential per game: >7/game → +2%
        if (hmSt && awSt && hmSt.totalGames >= 3 && awSt.totalGames >= 3) {
          const hmPDpg = (hmSt.pointsFor - hmSt.pointsAgainst) / hmSt.totalGames;
          const awPDpg = (awSt.pointsFor - awSt.pointsAgainst) / awSt.totalGames;
          const pdDiff = hmPDpg - awPDpg;
          if (Math.abs(pdDiff) > 7) {
            ptsDiffAdj = Math.min(0.04, Math.max(-0.04, pdDiff * 0.003));
            ptsDiffNote = ` | PD/g:${hmPDpg > 0 ? '+' : ''}${hmPDpg.toFixed(1)} vs ${awPDpg > 0 ? '+' : ''}${awPDpg.toFixed(1)}`;
          }
        }

        // Dominant home record (>75% home wins) → +2%
        if (hmSt) {
          const hmHomeGames = (hmSt.homeWin || 0) + (hmSt.homeLoss || 0);
          if (hmHomeGames >= 3) {
            const hmHomeWR = hmSt.homeWin / hmHomeGames;
            if (hmHomeWR > 0.75) {
              homeRecordAdj = Math.min(0.04, (hmHomeWR - 0.55) * 0.08);
              homeRecordNote = ` | HomeWR:${(hmHomeWR * 100).toFixed(0)}%`;
            }
          }
        }

        // Division rivalry: same-division games are closer (reduce edge by dampening)
        if (hmSt?.group && awSt?.group && hmSt.group === awSt.group && hmSt.group !== '') {
          divisionAdj = -0.015; // reduce confidence in division games, they're tighter
          divisionNote = ` | DIV rivalry`;
        }

        const totalAdv = ptsDiffAdj + homeRecordAdj + divisionAdj;

        const adjHome = Math.min(0.88, fpHome + ha + posAdj + formAdj + byeAdj + totalAdv);
        const adjAway = Math.max(0.08, fpAway - ha * 0.5 - posAdj * 0.5 - formAdj * 0.5 - byeAdj * 0.5 - totalAdv * 0.5);

        const bH = bestFromArr(homeOdds);
        const bA = bestFromArr(awayOdds);

        const homeEdge = bH.price > 0 ? adjHome * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway * bA.price - 1 : -1;

        const matchSignals = [];
        if (ha !== 0) matchSignals.push(`nfl_home:+${(ha*100).toFixed(1)}%`);
        if (Math.abs(formAdj) >= 0.005) matchSignals.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
        if (Math.abs(posAdj) >= 0.005) matchSignals.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
        if (byeAdj !== 0) matchSignals.push(`bye:${byeAdj>0?'+':''}${(byeAdj*100).toFixed(1)}%`);
        if (Math.abs(ptsDiffAdj) >= 0.005) matchSignals.push(`pts_diff:${ptsDiffAdj>0?'+':''}${(ptsDiffAdj*100).toFixed(1)}%`);
        if (Math.abs(homeRecordAdj) >= 0.005) matchSignals.push(`home_record:+${(homeRecordAdj*100).toFixed(1)}%`);
        if (divisionAdj !== 0) matchSignals.push(`division_rivalry:${(divisionAdj*100).toFixed(1)}%`);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const sharedNotes = `${posStr}${formNote}${byeNote}${ptsDiffNote}${homeRecordNote}${divisionNote}`;

        // v2: feature_snapshot + pick_candidates voor NFL ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'american-football', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, byeAdj, ptsDiffAdj, homeRecordAdj, divisionAdj,
        }, { standings_present: !!(hmSt && awSt) }).catch(() => {});
        if (_currentModelVersionId) {
          snap.recordMl2WayEvaluation({
            supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
            marketType: 'moneyline', fpHome, fpAway, adjHome, adjAway,
            bH, bA, homeEdge, awayEdge, minEdge: MIN_EDGE,
            maxWinnerOdds: MAX_WINNER_ODDS, matchSignals,
            debug: { sport: 'american-football', ha, signals: matchSignals },
          }).catch(() => {});
        }

        // Moneyline picks
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals);

        // Over/Under total points
        const overOdds = parsed.totals.filter(o => o.side === 'over');
        const underOdds = parsed.totals.filter(o => o.side === 'under');
        if (overOdds.length && underOdds.length) {
          const pointCounts = {};
          for (const o of [...overOdds, ...underOdds]) {
            pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          }
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.6);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.6);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🏈 Over ${line} pts`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} pts`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals);
            }
          }
        }

        // Spread (e.g., Home -3.5)
        const homeSpr = parsed.spreads.filter(o => o.side === 'home');
        const awaySpr = parsed.spreads.filter(o => o.side === 'away');
        if (homeSpr.length) {
          const best = bestFromArr(homeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = homeSpr[0].point > 0 ? `+${homeSpr[0].point}` : `${homeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, best.price,
                `Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (awaySpr.length) {
          const best = bestFromArr(awaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = awaySpr[0].point > 0 ? `+${awaySpr[0].point}` : `${awaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, best.price,
                `Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }

        // ── 1st Half Spread (NFL - research: 1H spreads often mispriced vs full-game) ──
        const h1HomeSpr = parsed.halfSpreads.filter(o => o.side === 'home');
        const h1AwaySpr = parsed.halfSpreads.filter(o => o.side === 'away');
        if (h1HomeSpr.length) {
          const best = bestFromArr(h1HomeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = h1HomeSpr[0].point > 0 ? `+${h1HomeSpr[0].point}` : `${h1HomeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${hm} ${pt}`, best.price,
                `1st Half Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.18, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (h1AwaySpr.length) {
          const best = bestFromArr(h1AwaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = h1AwaySpr[0].point > 0 ? `+${h1AwaySpr[0].point}` : `${h1AwaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${aw} ${pt}`, best.price,
                `1st Half Spread | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.18, kickoffTime, best.bookie, matchSignals);
            }
          }
        }

        // ── 1st Half Over/Under (NFL - often mispriced due to game script assumptions) ──
        const h1Over = parsed.halfTotals.filter(o => o.side === 'over');
        const h1Under = parsed.halfTotals.filter(o => o.side === 'under');
        if (h1Over.length && h1Under.length) {
          const h1PointCounts = {};
          for (const o of [...h1Over, ...h1Under]) {
            h1PointCounts[o.point] = (h1PointCounts[o.point] || 0) + 1;
          }
          const h1MainLine = Object.entries(h1PointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (h1MainLine) {
            const h1Line = parseFloat(h1MainLine);
            const h1Ov = h1Over.filter(o => Math.abs(o.point - h1Line) < 0.6);
            const h1Un = h1Under.filter(o => Math.abs(o.point - h1Line) < 0.6);
            if (h1Ov.length && h1Un.length) {
              const h1AvgOvIP = h1Ov.reduce((s,o)=>s+1/o.price,0) / h1Ov.length;
              const h1AvgUnIP = h1Un.reduce((s,o)=>s+1/o.price,0) / h1Un.length;
              const h1TotIP = h1AvgOvIP + h1AvgUnIP;
              const h1OverP = h1TotIP > 0 ? h1AvgOvIP / h1TotIP : 0.5;
              const h1BestOv = bestFromArr(h1Ov);
              const h1BestUn = bestFromArr(h1Un);
              const h1OverEdge = h1OverP * h1BestOv.price - 1;
              const h1UnderEdge = (1-h1OverP) * h1BestUn.price - 1;

              if (h1OverEdge >= MIN_EDGE && h1BestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🏈 1H Over ${h1Line} pts`, h1BestOv.price,
                  `1st Half O/U: ${(h1OverP*100).toFixed(1)}% over | ${h1BestOv.bookie}: ${h1BestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(h1OverP*100), h1OverEdge * 0.20, kickoffTime, h1BestOv.bookie, matchSignals);
              if (h1UnderEdge >= MIN_EDGE && h1BestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 1H Under ${h1Line} pts`, h1BestUn.price,
                  `1st Half O/U: ${((1-h1OverP)*100).toFixed(1)}% under | ${h1BestUn.bookie}: ${h1BestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-h1OverP)*100), h1UnderEdge * 0.18, kickoffTime, h1BestUn.bookie, matchSignals);
            }
          }
        }
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ 🏈 ${league.name}: ${err.message}` });
    }
  }

  // Tag picks
  for (const p of picks)     { p.scanType = 'nfl'; p.sport = 'american-football'; }
  for (const p of combiPool) { p.scanType = 'nfl'; p.sport = 'american-football'; }

  emit({ log: `🏈 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} NFL picks` });

  if (picks.length) saveScanEntry(picks, 'nfl', totalEvents);

  return picks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDBALL SCANNER · api-sports.io handball
// ═══════════════════════════════════════════════════════════════════════════════

async function runHandball(emit) {
  if (!AF_KEY) { emit({ log: '🤾 Handball: geen API key' }); return []; }
  emit({ log: `🤾 Handball scan · ${HANDBALL_LEAGUES.length} competities` });

  const calib = loadCalib();
  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {}, 'handball');
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  for (const league of HANDBALL_LEAGUES) {
    try {
      // Fixtures today + tomorrow (night games)
      const [todayFixtures, tomorrowFixtures] = await Promise.all([
        afGet('v1.handball.api-sports.io', '/games', { date: today, league: league.id, season: league.season }),
        afGet('v1.handball.api-sports.io', '/games', { date: tomorrow, league: league.id, season: league.season }),
      ]);
      apiCallsUsed += 2;

      // Merge: tomorrow only before 10:00 Amsterdam (strict date check)
      const allFixtures = [...(todayFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        return koDate === today;
      }), ...(tomorrowFixtures || []).filter(g => {
        const ko = new Date(g.date || g.timestamp * 1000);
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        return koDate === tomorrow && koH < 10;
      })];

      const games = allFixtures.filter(f => {
        const st = f.status?.short || '';
        return st === 'NS' || st === 'SCH';
      });

      if (!games.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `🤾 ${league.name}: ${games.length} wedstrijd(en)` });
      totalEvents += games.length;

      // Standings
      await sleep(120);
      const standings = await afGet('v1.handball.api-sports.io', '/standings', {
        league: league.id, season: league.season
      });
      apiCallsUsed++;

      const standingsMap = {};
      for (const group of (standings || [])) {
        const teams = Array.isArray(group) ? group : [group];
        for (const t of teams) {
          const tid = t.team?.id;
          if (!tid) continue;
          const totalGames = (t.games?.win?.total || 0) + (t.games?.lose?.total || 0) + (t.games?.draw?.total || 0);
          standingsMap[tid] = {
            rank: t.position || 99,
            win: t.games?.win?.total || 0,
            loss: t.games?.lose?.total || 0,
            draw: t.games?.draw?.total || 0,
            form: t.form || '',
            teamName: t.team?.name || '',
            homeWin: t.games?.win?.home || 0,
            homeLoss: t.games?.lose?.home || 0,
            homeDraw: t.games?.draw?.home || 0,
            awayWin: t.games?.win?.away || 0,
            awayLoss: t.games?.lose?.away || 0,
            pointsFor: t.points?.for || t.goals?.for || 0,
            pointsAgainst: t.points?.against || t.goals?.against || 0,
            totalGames,
          };
        }
      }

      for (const g of games) {
        const gameId = g.id;
        const hm = g.teams?.home?.name;
        const aw = g.teams?.away?.name;
        const hmId = g.teams?.home?.id;
        const awId = g.teams?.away?.id;
        if (!gameId || !hm || !aw) continue;

        const kickoffMs = new Date(g.date || g.time || g.timestamp * 1000).getTime();
        const ko = new Date(kickoffMs).toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // Odds
        await sleep(120);
        const oddsResp = await afGet('v1.handball.api-sports.io', '/odds', { game: gameId });
        apiCallsUsed++;

        const parsed = parseGameOdds(oddsResp, hm, aw);
        if (!parsed.moneyline.length) continue;

        // v2 snapshots (fail-safe)
        snap.upsertFixture(supabase, {
          id: gameId, sport: 'handball', leagueId: league.id, leagueName: league.name,
          season: league.season, homeTeamId: hmId, homeTeamName: hm,
          awayTeamId: awId, awayTeamName: aw, startTime: kickoffMs, status: 'scheduled',
        }).catch(() => {});
        snap.writeOddsSnapshots(supabase, gameId, snap.flattenParsedOdds(parsed)).catch(() => {});

        const homeOdds = parsed.moneyline.filter(o => o.side === 'home');
        const awayOdds = parsed.moneyline.filter(o => o.side === 'away');
        if (!homeOdds.length || !awayOdds.length) continue;

        const avgHomePrice = homeOdds.reduce((s,o)=>s+o.price,0) / homeOdds.length;
        const avgAwayPrice = awayOdds.reduce((s,o)=>s+o.price,0) / awayOdds.length;
        const totalIP = 1/avgHomePrice + 1/avgAwayPrice;
        if (totalIP < 0.5) continue;
        const fpHome = (1/avgHomePrice) / totalIP;
        const fpAway = (1/avgAwayPrice) / totalIP;

        const hmSt = hmId ? standingsMap[hmId] : null;
        const awSt = awId ? standingsMap[awId] : null;

        let posAdj = 0;
        if (hmSt && awSt) {
          posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.002));
        }

        // Form (last 5)
        let formAdj = 0;
        if (hmSt?.form && awSt?.form) {
          const fmScore = s => [...(s.slice(-5)||'')].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
          formAdj = Math.max(-0.05, Math.min(0.05, (fmScore(hmSt.form) - fmScore(awSt.form)) / 15 * 0.04));
        }

        // ── Advanced handball signals (from standings, 0 extra API calls) ──
        let goalDiffAdj = 0, homeWRAdj = 0, formMomentumAdj = 0;
        let goalDiffNote = '', homeWRNote = '', momentumNote = '';

        // Goal differential from standings: strong GD → +2%
        if (hmSt && awSt && hmSt.totalGames >= 5 && awSt.totalGames >= 5) {
          const hmGDpg = (hmSt.pointsFor - hmSt.pointsAgainst) / hmSt.totalGames;
          const awGDpg = (awSt.pointsFor - awSt.pointsAgainst) / awSt.totalGames;
          const gdDiff = hmGDpg - awGDpg;
          if (Math.abs(gdDiff) > 2) {
            goalDiffAdj = Math.min(0.04, Math.max(-0.04, gdDiff * 0.005));
            goalDiffNote = ` | GD/g:${hmGDpg > 0 ? '+' : ''}${hmGDpg.toFixed(1)} vs ${awGDpg > 0 ? '+' : ''}${awGDpg.toFixed(1)}`;
          }
        }

        // Home team with >80% home win rate → +3% (handball has very strong home advantage)
        if (hmSt) {
          const hmHomeGames = (hmSt.homeWin || 0) + (hmSt.homeLoss || 0) + (hmSt.homeDraw || 0);
          if (hmHomeGames >= 5) {
            const hmHomeWR = hmSt.homeWin / hmHomeGames;
            if (hmHomeWR > 0.80) {
              homeWRAdj = Math.min(0.04, (hmHomeWR - 0.55) * 0.12);
              homeWRNote = ` | HomeWR:${(hmHomeWR * 100).toFixed(0)}%`;
            }
          }
        }

        // Form momentum: last 3 vs previous 3 (acceleration)
        if (hmSt?.form && hmSt.form.length >= 6 && awSt?.form && awSt.form.length >= 6) {
          const momentumScore = s => {
            const recent = [...s.slice(-3)].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
            const prev = [...s.slice(-6,-3)].reduce((a,c)=>a+(c==='W'?3:c==='L'?0:1),0);
            return recent - prev;
          };
          const hmMomentum = momentumScore(hmSt.form);
          const awMomentum = momentumScore(awSt.form);
          const momDiff = hmMomentum - awMomentum;
          if (Math.abs(momDiff) >= 3) {
            formMomentumAdj = Math.min(0.04, Math.max(-0.04, momDiff * 0.005));
            momentumNote = ` | Momentum:${momDiff > 0 ? '+' : ''}${momDiff}`;
          }
        }

        const totalAdv = goalDiffAdj + homeWRAdj + formMomentumAdj;

        // Home advantage is STRONG in handball (~60%)
        const ha = league.ha || 0.06;
        const adjHome = Math.min(0.88, fpHome + ha + posAdj + formAdj + totalAdv);
        const adjAway = Math.max(0.08, fpAway - ha * 0.5 - posAdj * 0.5 - formAdj * 0.5 - totalAdv * 0.5);

        const bH = bestFromArr(homeOdds);
        const bA = bestFromArr(awayOdds);

        const homeEdge = bH.price > 0 ? adjHome * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway * bA.price - 1 : -1;

        const matchSignals = [];
        if (ha !== 0) matchSignals.push(`handball_home:+${(ha*100).toFixed(1)}%`);
        if (Math.abs(formAdj) >= 0.005) matchSignals.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
        if (Math.abs(posAdj) >= 0.005) matchSignals.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
        if (Math.abs(goalDiffAdj) >= 0.005) matchSignals.push(`goal_diff:${goalDiffAdj>0?'+':''}${(goalDiffAdj*100).toFixed(1)}%`);
        if (Math.abs(homeWRAdj) >= 0.005) matchSignals.push(`home_dominance:+${(homeWRAdj*100).toFixed(1)}%`);
        if (Math.abs(formMomentumAdj) >= 0.005) matchSignals.push(`momentum:${formMomentumAdj>0?'+':''}${(formMomentumAdj*100).toFixed(1)}%`);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const sharedNotes = `${posStr}${formNote}${goalDiffNote}${homeWRNote}${momentumNote}`;

        // ── 3-weg ML voor handbal (Home/Draw/Away 60-min) via Poisson ──
        // Handbal heeft vaak een 3-weg markt (gelijkspel in reguliere tijd is mogelijk).
        if (parsed.threeWay && parsed.threeWay.length) {
          const hmGFpg = hmSt?.totalGames ? (hmSt.goalsFor / hmSt.totalGames) : 28;
          const hmGApg = hmSt?.totalGames ? (hmSt.goalsAgainst / hmSt.totalGames) : 28;
          const awGFpg = awSt?.totalGames ? (awSt.goalsFor / awSt.totalGames) : 28;
          const awGApg = awSt?.totalGames ? (awSt.goalsAgainst / awSt.totalGames) : 28;
          const expHome = Math.max(10, (hmGFpg + awGApg) / 2 + ha * 30);
          const expAway = Math.max(10, (awGFpg + hmGApg) / 2 - ha * 10);
          const p3 = poisson3Way(expHome, expAway, 60);

          const h3 = parsed.threeWay.filter(o => o.side === 'home');
          const d3 = parsed.threeWay.filter(o => o.side === 'draw');
          const a3 = parsed.threeWay.filter(o => o.side === 'away');
          const bH3 = bestFromArr(h3);
          const bD3 = bestFromArr(d3);
          const bA3 = bestFromArr(a3);

          const e3H = bH3.price > 0 ? p3.pHome * bH3.price - 1 : -1;
          const e3D = bD3.price > 0 ? p3.pDraw * bD3.price - 1 : -1;
          const e3A = bA3.price > 0 ? p3.pAway * bA3.price - 1 : -1;

          // Sanity-check handbal Poisson tegen markt consensus (zelfde principe als hockey)
          const marketFairHb = consensus3Way(parsed.threeWay);
          const sanH3 = marketFairHb ? modelMarketSanityCheck(p3.pHome, marketFairHb.home) : { agree: true };
          const sanD3 = marketFairHb ? modelMarketSanityCheck(p3.pDraw, marketFairHb.draw) : { agree: true };
          const sanA3 = marketFairHb ? modelMarketSanityCheck(p3.pAway, marketFairHb.away) : { agree: true };

          const threeNote = ` | λh:${expHome.toFixed(1)} λa:${expAway.toFixed(1)} | 60-min`;
          if (e3H >= MIN_EDGE && bH3.price >= 1.60 && bH3.price <= MAX_WINNER_ODDS && sanH3.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🕐 ${hm} wint (60-min)`, bH3.price,
              `3-way: ${(p3.pHome*100).toFixed(1)}% | Markt: ${marketFairHb ? (marketFairHb.home*100).toFixed(1)+'%' : 'n/a'} | ${bH3.bookie}: ${bH3.price}${threeNote} | ${ko}`,
              Math.round(p3.pHome*100), e3H * 0.26, kickoffTime, bH3.bookie, [...matchSignals, '3way_ml', 'sanity_ok']);
          if (e3D >= MIN_EDGE && bD3.price >= 4.00 && bD3.price <= 15.00 && sanD3.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🕐 Gelijkspel (60-min)`, bD3.price,
              `3-way: ${(p3.pDraw*100).toFixed(1)}% gelijk | Markt: ${marketFairHb ? (marketFairHb.draw*100).toFixed(1)+'%' : 'n/a'} | ${bD3.bookie}: ${bD3.price}${threeNote} | ${ko}`,
              Math.round(p3.pDraw*100), e3D * 0.18, kickoffTime, bD3.bookie, [...matchSignals, '3way_ml', 'sanity_ok']);
          if (e3A >= MIN_EDGE && bA3.price >= 1.60 && bA3.price <= MAX_WINNER_ODDS && sanA3.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🕐 ${aw} wint (60-min)`, bA3.price,
              `3-way: ${(p3.pAway*100).toFixed(1)}% | Markt: ${marketFairHb ? (marketFairHb.away*100).toFixed(1)+'%' : 'n/a'} | ${bA3.bookie}: ${bA3.price}${threeNote} | ${ko}`,
              Math.round(p3.pAway*100), e3A * 0.26, kickoffTime, bA3.bookie, [...matchSignals, '3way_ml', 'sanity_ok']);
        }

        // v2: feature_snapshot + pick_candidates voor handbal ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'handball', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, goalDiffAdj, homeWRAdj, formMomentumAdj,
          marketHomeProb: marketFairHb?.home, marketDrawProb: marketFairHb?.draw, marketAwayProb: marketFairHb?.away,
        }, {
          standings_present: !!(hmSt && awSt),
          three_way_bookies: marketFairHb?.bookieCount || 0,
        }).catch(() => {});
        if (_currentModelVersionId) {
          snap.recordMl2WayEvaluation({
            supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
            marketType: 'moneyline', fpHome, fpAway, adjHome, adjAway,
            bH, bA, homeEdge, awayEdge, minEdge: MIN_EDGE,
            maxWinnerOdds: MAX_WINNER_ODDS, matchSignals,
            debug: { sport: 'handball', ha, signals: matchSignals },
          }).catch(() => {});
        }

        // Moneyline picks
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals);

        // Over/Under total goals
        const overOdds = parsed.totals.filter(o => o.side === 'over');
        const underOdds = parsed.totals.filter(o => o.side === 'under');
        if (overOdds.length && underOdds.length) {
          const pointCounts = {};
          for (const o of [...overOdds, ...underOdds]) {
            pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          }
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.6);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.6);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🤾 Over ${line} goals`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} goals`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals);
            }
          }
        }

        // Handicap
        const homeSpr = parsed.spreads.filter(o => o.side === 'home');
        const awaySpr = parsed.spreads.filter(o => o.side === 'away');
        if (homeSpr.length) {
          const best = bestFromArr(homeSpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpHome * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = homeSpr[0].point > 0 ? `+${homeSpr[0].point}` : `${homeSpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, best.price,
                `Handicap | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpHome*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
        if (awaySpr.length) {
          const best = bestFromArr(awaySpr);
          if (best.price >= 1.60 && best.price <= 3.8) {
            const sEdge = fpAway * best.price - 1;
            if (sEdge >= MIN_EDGE + 0.01) {
              const pt = awaySpr[0].point > 0 ? `+${awaySpr[0].point}` : `${awaySpr[0].point}`;
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, best.price,
                `Handicap | ${best.bookie}: ${best.price}${sharedNotes} | ${ko}`,
                Math.round(fpAway*100), sEdge * 0.20, kickoffTime, best.bookie, matchSignals);
            }
          }
        }
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ 🤾 ${league.name}: ${err.message}` });
    }
  }

  // Tag picks
  for (const p of picks)     { p.scanType = 'handball'; p.sport = 'handball'; }
  for (const p of combiPool) { p.scanType = 'handball'; p.sport = 'handball'; }

  emit({ log: `🤾 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} handball picks` });

  if (picks.length) saveScanEntry(picks, 'handball', totalEvents);

  return picks;
}

// European cup league IDs · teams in these play midweek, risico op vermoeidheid
const EUROPEAN_CUP_IDS = new Set([2, 3, 848]); // UCL, UEL, UECL

// ═══════════════════════════════════════════════════════════════════════════════
// PREMATCH SCAN · api-football.com
// ═══════════════════════════════════════════════════════════════════════════════
async function runPrematch(emit) {
  if (!AF_KEY) {
    emit({ log: '❌ Geen API_FOOTBALL_KEY ingesteld!' });
    return [];
  }

  emit({ log: `🎯 Prematch scan · api-sports (${AF_FOOTBALL_LEAGUES.length} voetbalcompetities + 5 sporten)` });

  // ── STAP 1: (ESPN removed · standings komen via enrichWithApiSports) ────

  // ── STAP 2: Team stats, blessures, scheidsrechters ───────────────────────
  h2hCallsThisScan = 0;
  weatherCallsThisScan = 0;
  // Clear team stats cache for fresh scan
  for (const k of Object.keys(teamStatsCache)) delete teamStatsCache[k];
  let teamStatsCalls = 0;
  await enrichWithApiSports(emit);

  // ── Calibratie ───────────────────────────────────────────────────────────
  const calib = loadCalib();
  const cm = calib.markets;
  emit({ log: `🧠 Calibratie: thuis×${cm.home.multiplier.toFixed(2)} uit×${cm.away.multiplier.toFixed(2)} draw×${cm.draw.multiplier.toFixed(2)} over×${cm.over.multiplier.toFixed(2)}` });

  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {});
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = 0;

  // Datumbereik: vandaag + morgen (voor nachtwedstrijden tot 10:00)
  const today    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const dateFrom = today;
  const dateTo   = tomorrow;

  // ── STAP 3: Per competitie fixtures + odds + predictions ────────────────
  for (const league of AF_FOOTBALL_LEAGUES) {
    try {
      // Fixtures voor komende 2 dagen
      const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', {
        league: league.id, season: league.season, from: dateFrom, to: dateTo, status: 'NS',
      });
      apiCallsUsed++;

      // Filter: morgen alleen wedstrijden vóór 10:00 Amsterdam (nachtwedstrijden)
      const cutoffHour = 10; // 10:00 volgende ochtend
      const filtered = (fixtures || []).filter(f => {
        const ko = new Date(f.fixture?.date);
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        // Vandaag: alles. Morgen: alleen vóór 10:00. Overmorgen+: skip
        if (koDate === today) return true;
        if (koDate === tomorrow) return koH < cutoffHour;
        return false;
      });

      if (!filtered.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `✅ ${league.name}: ${filtered.length} wedstrijd(en)` });
      totalEvents += filtered.length;

      const afStats   = afCache.teamStats[league.key] || {};
      const afInj     = afCache.injuries[league.key]  || {};

      for (const f of filtered) {
        const fid = f.fixture?.id;
        const hm  = f.teams?.home?.name;
        const aw  = f.teams?.away?.name;
        if (!fid || !hm || !aw) continue;

        const kickoffMs  = new Date(f.fixture?.date).getTime();
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const ko = new Date(kickoffMs)
          .toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // ── Odds ophalen van api-football.com ─────────────────────────
        await sleep(120);
        const oddsResp = await afGet('v3.football.api-sports.io', '/odds', { fixture: fid });
        apiCallsUsed++;
        if (!oddsResp?.length) continue;

        const rawBks = oddsResp[0]?.bookmakers || [];

        // Alleen Bet365 en Unibet · andere bookmakers hebben onbetrouwbare odds
        const ALLOWED_BKMS = ['bet365', 'unibet'];
        const filteredBks = rawBks.filter(b =>
          ALLOWED_BKMS.some(name => b.name?.toLowerCase().includes(name))
        );
        if (filteredBks.length === 0) continue; // geen van beide beschikbaar, skip

        const bookies = convertAfOdds(filteredBks, hm, aw);
        const fp = fairProbs(bookies, hm, aw);
        if (!fp) continue;

        // v2 snapshots (fail-safe) — fixture + odds + consensus
        snap.upsertFixture(supabase, {
          id: fid, sport: 'football', leagueId: league.id, leagueName: league.name,
          season: league.season, homeTeamId: f.teams?.home?.id, homeTeamName: hm,
          awayTeamId: f.teams?.away?.id, awayTeamName: aw, startTime: kickoffMs, status: 'scheduled',
        }).catch(() => {});
        snap.writeOddsSnapshots(supabase, fid, snap.flattenFootballBookies(bookies, hm, aw)).catch(() => {});

        if (fp.home != null && fp.away != null) {
          // 1X2 consensus snapshot
          const ipSum = (1/Math.max(0.01, fp._rawOdds?.home || (1/fp.home))) +
                        (1/Math.max(0.01, fp._rawOdds?.away || (1/fp.away))) +
                        (fp.draw ? (1/Math.max(0.01, fp._rawOdds?.draw || (1/fp.draw))) : 0);
          snap.writeMarketConsensus(supabase, {
            fixtureId: fid, marketType: '1x2', line: null,
            consensusProb: { home: fp.home, draw: fp.draw || 0, away: fp.away },
            bookmakerCount: bookies.length,
            overround: ipSum > 0 ? Math.max(0, ipSum - 1) : null,
            qualityScore: snap.consensusQualityScore(bookies.length, Math.max(0, ipSum - 1)),
          }).catch(() => {});
        }

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

        // ── api-football.com stats: vorm, blessures, scheidsrechter ───
        const hmKey = hm.toLowerCase(), awKey = aw.toLowerCase();
        const hmSt  = afStats[hmKey], awSt = afStats[awKey];
        const hmInj = afInj[hmKey] || [], awInj = afInj[awKey] || [];
        const refInfo = afCache.referees[`${hmKey} vs ${awKey}`];
        // Extract referee name directly from fixture data
        const fixtureRef = f.fixture?.referee || '';
        const refereeName = refInfo?.name || (fixtureRef ? fixtureRef.replace(/, \w+$/, '') : null);

        // ── Positie-aanpassing (api-football rank) ──────────────────
        let posAdj = 0, posStr = '';
        if (hmSt && awSt && hmSt.rank && awSt.rank) {
          posAdj = Math.max(-0.06, Math.min(0.06, (awSt.rank - hmSt.rank) * 0.003));
          posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        }

        // ── Home/away split aanpassing ──────────────────────────────
        let splitAdj = 0, splitNote = '';
        if (hmSt && awSt && hmSt.homeGPG !== undefined && awSt.awayGPG !== undefined) {
          // Home team: compare home goals-per-game vs overall GPG
          const hmHomeBoost = hmSt.goalsFor > 0 ? (hmSt.homeGPG - hmSt.goalsFor) / hmSt.goalsFor : 0;
          // Away team: compare away goals-against-per-game vs overall GA/game
          const awAwayDefPenalty = awSt.goalsAgainst > 0 ? (awSt.awayGAPG - awSt.goalsAgainst) / awSt.goalsAgainst : 0;
          // Positive hmHomeBoost = home team scores more at home than average → favor home
          // Positive awAwayDefPenalty = away team concedes more away than average → favor home
          splitAdj = Math.max(-0.04, Math.min(0.04, (hmHomeBoost + awAwayDefPenalty) * 0.06));
          if (Math.abs(splitAdj) >= 0.005) {
            splitNote = ` | H/A split: ${splitAdj>0?'+':''}${(splitAdj*100).toFixed(1)}%`;
          }
        }

        const ha = league.ha || 0;
        const adjHome = Math.min(0.88, fp.home + ha + posAdj + splitAdj + predAdj + lineupPenalty.home);
        const adjAway = Math.max(0.08, fp.away - ha * 0.5 - posAdj * 0.5 - splitAdj * 0.5 - predAdj * 0.5 + lineupPenalty.away);
        const adjDraw = fp.draw && fp.draw > 0.05 ? fp.draw - posAdj * 0.3 - splitAdj * 0.2 : null;

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

        const refNote = refereeName ? ` | 🟨 Scheidsrechter: ${refereeName}` : '';

        let h2hAdj = 0, h2hNote = '';
        const hmId = hmSt?.teamId, awId = awSt?.teamId;
        if (hmId && awId) {
          const h2h = await fetchH2H(hmId, awId);
          if (h2h && h2h.n >= 3) {
            h2hAdj = Math.max(-0.03, Math.min(0.03, ((h2h.hmW - h2h.awW) / h2h.n) * 0.03));
            h2hNote = ` | H2H: ${h2h.hmW}W-${h2h.dr}D-${h2h.awW}L (${h2h.n}x, ${h2h.avgGoals} goals/game, BTTS ${Math.round(h2h.bttsRate*100)}%)`;
          }
        }

        // ── Weather data (Open-Meteo, alleen voor kandidaat-wedstrijden) ──
        let weatherAdj = 0, weatherNote = '', weatherData = null;
        const venueCoords = getVenueCoords(f.fixture);
        if (venueCoords && weatherCallsThisScan < MAX_WEATHER_CALLS) {
          weatherData = await fetchMatchWeather(venueCoords.lat, venueCoords.lon, new Date(kickoffMs));
          if (weatherData) {
            const parts = [];
            if (weatherData.rain > 5)  { weatherAdj -= 0.03; parts.push(`🌧️ ${weatherData.rain}mm regen`); }
            if (weatherData.wind > 30) { weatherAdj -= 0.02; parts.push(`💨 ${weatherData.wind}km/h wind`); }
            if (parts.length) weatherNote = ` | Weer: ${parts.join(', ')} → Under nudge ${(weatherAdj*100).toFixed(0)}%`;
            else weatherNote = ` | ☀️ ${weatherData.temp}°C`;
          }
        }

        // ── Poisson goal model (supplementair) ──────────────────────
        let poissonNote = '', poissonOverP = null, poissonBttsP = null;
        if (hmSt && awSt && hmSt.goalsFor > 0 && awSt.goalsFor > 0) {
          // Bereken league gemiddelde doelpunten (benadering via standings)
          const allTeams = Object.values(afStats);
          const leagueAvgGF = allTeams.length > 4
            ? allTeams.reduce((s,t) => s + (t.goalsFor || 0), 0) / allTeams.length
            : 1.35;
          // Attack rating = team GF/game / league avg; Defense rating = team GA/game / league avg
          const leagueAvgGA = allTeams.length > 4
            ? allTeams.reduce((s,t) => s + (t.goalsAgainst || 0), 0) / allTeams.length
            : 1.35;
          const hmAttack  = hmSt.goalsFor / leagueAvgGF;
          const hmDefense = hmSt.goalsAgainst / leagueAvgGA;
          const awAttack  = awSt.goalsFor / leagueAvgGF;
          const awDefense = awSt.goalsAgainst / leagueAvgGA;

          const poisson = calcGoalProbs(hmAttack, hmDefense, awAttack, awDefense, leagueAvgGF);
          poissonOverP = poisson.over25;
          poissonBttsP = poisson.bttsYes;
          poissonNote = ` | 📊 Poisson xG: ${poisson.homeExpG}-${poisson.awayExpG}, O2.5: ${(poisson.over25*100).toFixed(0)}%, BTTS: ${(poisson.bttsYes*100).toFixed(0)}%`;
        }

        // ── Congestion detection (Europese cups) ────────────────────
        let congestionAdj = 0, congestionNote = '';
        // Check of een team in UCL/UEL/UECL speelt (=extra wedstrijden, vermoeidheid)
        if (EUROPEAN_CUP_IDS.has(league.id)) {
          // Dit IS een Europese cupwedstrijd · teams kunnen vermoeid zijn van weekendcompetitie
          congestionAdj = -0.02;
          congestionNote = ' | ⚠️ Europees duel: vermoeidheidsrisico';
        } else {
          // Domestic wedstrijd · check of een van de teams in Europese cups zit
          const hmId2 = hmSt?.teamId, awId2 = awSt?.teamId;
          // Zoek in vandaag's fixtures of dit team ook in een cup-competitie speelt
          // Simpele benadering: we weten welke teams in top competitions spelen
          // Teams uit top-5 competities met cupwedstrijden op weekdagen = vermoeidheidsrisico
          const dayOfWeek = new Date(kickoffMs).getDay(); // 0=zo, 6=za
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
          if (isWeekend && (hmSt?.rank <= 4 || awSt?.rank <= 4)) {
            // Top-4 teams spelen waarschijnlijk Europees op di/wo → weekend vermoeidheid
            if (hmSt?.rank <= 4) { congestionAdj -= 0.02; }
            if (awSt?.rank <= 4) { congestionAdj -= 0.02; }
            if (congestionAdj < 0) {
              congestionNote = ` | 🔄 Mogelijke congestie (top-${Math.min(hmSt?.rank||99, awSt?.rank||99)}, weekend na Europees)`;
            }
          }
        }
        congestionAdj = Math.max(-0.04, congestionAdj);

        const totalAdj  = formAdj + injAdj + h2hAdj + congestionAdj;
        const adjHome2  = Math.min(0.88, adjHome + totalAdj);
        const adjAway2  = Math.max(0.08, adjAway - totalAdj);

        const bH = bestOdds(bookies, 'h2h', hm);
        const bA = bestOdds(bookies, 'h2h', aw);
        const bD = adjDraw !== null ? bestOdds(bookies, 'h2h', 'Draw') : null;

        const homeEdge = bH.price > 0 ? adjHome2 * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway2 * bA.price - 1 : -1;
        const drawEdge = bD?.price > 0 ? (adjDraw||0) * bD.price - 1 : -1;

        // ── Build signal arrays ───────────────────────────────────
        const buildSignals = () => {
          const sigs = [];
          if (ha !== 0) sigs.push(`home_adv:+${(ha*100).toFixed(1)}%`);
          if (Math.abs(formAdj) >= 0.005) sigs.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
          if (Math.abs(injAdj) >= 0.005) sigs.push(`injuries:${injAdj>0?'+':''}${(injAdj*100).toFixed(1)}%`);
          if (Math.abs(h2hAdj) >= 0.005) sigs.push(`h2h:${h2hAdj>0?'+':''}${(h2hAdj*100).toFixed(1)}%`);
          if (Math.abs(posAdj) >= 0.005) sigs.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
          if (Math.abs(splitAdj) >= 0.005) sigs.push(`home_away_split:${splitAdj>0?'+':''}${(splitAdj*100).toFixed(1)}%`);
          if (Math.abs(predAdj) >= 0.005) sigs.push(`api_pred:${predAdj>0?'+':''}${(predAdj*100).toFixed(1)}%`);
          if (lineupPenalty.home !== 0) sigs.push(`lineup:${(lineupPenalty.home*100).toFixed(1)}%`);
          if (lineupPenalty.away !== 0) sigs.push(`lineup:${(lineupPenalty.away*100).toFixed(1)}%`);
          if (Math.abs(congestionAdj) >= 0.005) sigs.push(`congestion:${(congestionAdj*100).toFixed(1)}%`);
          if (weatherData && (weatherData.rain > 5 || weatherData.wind > 30)) sigs.push(`weather:${(weatherAdj*100).toFixed(1)}%`);
          if (poissonOverP !== null) sigs.push(`poisson_o25:${(poissonOverP*100).toFixed(1)}%`);
          return sigs;
        };
        const matchSignals = buildSignals();

        const sharedNotes = `${posStr}${splitNote}${formNote}${injNote}${h2hNote}${refNote}${predNote}${lineupNote}${weatherNote}${poissonNote}${congestionNote}`;
        const reasonH = `Consensus: ${(fp.home*100).toFixed(1)}%→${(adjHome2*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`;
        const reasonA = `Consensus: ${(fp.away*100).toFixed(1)}%→${(adjAway2*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`;
        const reasonD = `Gelijkspel: ${((fp.draw||0)*100).toFixed(1)}% | ${bD?.bookie}: ${bD?.price}${sharedNotes} | ${ko}`;

        // v2: feature_snapshot + model_run + pick_candidates voor voetbal 1X2
        snap.writeFeatureSnapshot(supabase, fid, {
          sport: 'football', fpHome: fp.home, fpDraw: fp.draw, fpAway: fp.away,
          adjHome: adjHome2, adjDraw: adjDraw || 0, adjAway: adjAway2,
          ha, posAdj, splitAdj, predAdj,
          lineupPenaltyHome: lineupPenalty?.home, lineupPenaltyAway: lineupPenalty?.away,
          formMomentumDiff: typeof formMomentumDiff !== 'undefined' ? formMomentumDiff : null,
          h2hAdjHome: typeof h2hAdj !== 'undefined' ? h2hAdj : null,
        }, {
          referee: !!refereeName,
          lineup_known: !!(lineupPenalty?.home != null || lineupPenalty?.away != null),
          weather_used: !!weatherNote,
        }).catch(() => {});

        if (_currentModelVersionId) {
          (async () => {
            try {
              const baseline = { home: fp.home, draw: fp.draw || 0, away: fp.away };
              const finalP = { home: adjHome2, draw: adjDraw || 0, away: adjAway2 };
              const runId = await snap.writeModelRun(supabase, {
                fixtureId: fid, modelVersionId: _currentModelVersionId,
                marketType: '1x2', line: null,
                baselineProb: baseline,
                modelDelta: { home: adjHome2 - fp.home, draw: (adjDraw || 0) - (fp.draw || 0), away: adjAway2 - fp.away },
                finalProb: finalP,
                debug: { sport: 'football', ha, signals: matchSignals, multipliers: { home: cm.home?.multiplier, draw: cm.draw?.multiplier, away: cm.away?.multiplier } },
              });
              if (!runId) return;
              const evals = [
                { side: 'home', edge: homeEdge, prob: adjHome2, best: bH, gateOk: (bA.price > BLOWOUT_OPP_MAX) },
                { side: 'draw', edge: drawEdge, prob: adjDraw || 0, best: bD || { price: 0, bookie: 'none' }, gateOk: true, minThreshold: MIN_EDGE + 0.01 },
                { side: 'away', edge: awayEdge, prob: adjAway2, best: bA, gateOk: (bH.price > BLOWOUT_OPP_MAX) },
              ];
              for (const ev of evals) {
                const min = ev.minThreshold != null ? ev.minThreshold : MIN_EDGE;
                let rejected = null;
                if (!ev.best || ev.best.price <= 0) rejected = 'no_bookie_price';
                else if (ev.best.price < 1.60) rejected = `price_too_low (${ev.best.price})`;
                else if (ev.side !== 'draw' && ev.best.price > MAX_WINNER_ODDS) rejected = `price_too_high (${ev.best.price})`;
                else if (!ev.gateOk) rejected = 'blowout_opp_too_low';
                else if (ev.edge < min) rejected = `edge_below_min (${(ev.edge * 100).toFixed(1)}% < ${(min * 100).toFixed(1)}%)`;
                snap.writePickCandidate(supabase, {
                  modelRunId: runId, fixtureId: fid, selectionKey: ev.side,
                  bookmaker: ev.best.bookie || 'none', bookmakerOdds: ev.best.price,
                  fairProb: ev.prob, edgePct: ev.edge,
                  passedFilters: !rejected, rejectedReason: rejected,
                  signals: matchSignals,
                }).catch(() => {});
              }
            } catch (e) { /* swallow */ }
          })();
        }

        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && bA.price > BLOWOUT_OPP_MAX)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price, reasonH, Math.round(adjHome2*100), homeEdge * 0.28 * (cm.home?.multiplier ?? 1), kickoffTime, bH.bookie, matchSignals, refereeName);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && bH.price > BLOWOUT_OPP_MAX)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price, reasonA, Math.round(adjAway2*100), awayEdge * 0.28 * (cm.away?.multiplier ?? 1), kickoffTime, bA.bookie, matchSignals, refereeName);

        if (drawEdge >= MIN_EDGE + 0.01 && bD?.price >= 1.60)
          mkP(`${hm} vs ${aw}`, league.name, `🤝 Gelijkspel`, bD.price, reasonD, Math.round((adjDraw||0)*100), drawEdge * 0.22 * (cm.draw?.multiplier ?? 1), kickoffTime, bD?.bookie, matchSignals, refereeName);

        // ── O/U Goals 2.5 ─────────────────────────────────────────────
        const over  = analyseTotal(bookies, 'Over',  2.5);
        const under = analyseTotal(bookies, 'Under', 2.5);
        if (over.best.price >= 1.60 && over.avgIP > 0) {
          const totIP  = over.avgIP + under.avgIP;
          let   overP  = totIP > 0 ? over.avgIP / totIP : 0.5;

          // ── Team stats O/U refinement (fetched only for candidate fixtures) ──
          let tsNote = '';
          if (hmSt?.teamId && awSt?.teamId && teamStatsCalls < 60) {
            const [hmTS, awTS] = await Promise.all([
              fetchTeamStats(hmSt.teamId, league.id, league.season),
              fetchTeamStats(awSt.teamId, league.id, league.season),
            ]);
            teamStatsCalls += 2;
            apiCallsUsed += 2;

            if (hmTS && awTS) {
              let tsAdj = 0;
              // Both teams high-scoring (>1.5 goals/game each) → nudge Over up
              if (hmTS.goalsForAvg > 1.5 && awTS.goalsForAvg > 1.5) {
                tsAdj += Math.min(0.03, ((hmTS.goalsForAvg + awTS.goalsForAvg) - 3.0) * 0.02);
              }
              // High clean sheet rate (>40%) from either team → nudge Under up
              if (hmTS.cleanSheetPct > 0.40) {
                tsAdj -= Math.min(0.03, (hmTS.cleanSheetPct - 0.40) * 0.08);
              }
              if (awTS.cleanSheetPct > 0.40) {
                tsAdj -= Math.min(0.03, (awTS.cleanSheetPct - 0.40) * 0.08);
              }
              // Cap total adjustment at +/-5%
              tsAdj = Math.max(-0.05, Math.min(0.05, tsAdj));
              if (Math.abs(tsAdj) >= 0.005) {
                overP = Math.max(0.10, Math.min(0.90, overP + tsAdj));
                tsNote = ` | TeamStats: ${tsAdj>0?'+':''}${(tsAdj*100).toFixed(1)}%`;
              }
            }
          }

          // ── Weather adjustment: regen/wind → nudge Under ─────────
          let weatherOUAdj = 0, weatherOUNote = '';
          if (weatherData) {
            if (weatherData.rain > 5)  weatherOUAdj -= 0.03;
            if (weatherData.wind > 30) weatherOUAdj -= 0.02;
            if (weatherOUAdj !== 0) {
              overP = Math.max(0.10, Math.min(0.90, overP + weatherOUAdj));
              weatherOUNote = ` | Weer: Under nudge ${(weatherOUAdj*100).toFixed(0)}%`;
            }
          }

          // ── Poisson cross-check: significant verschil = extra edge ──
          let poissonOUAdj = 0, poissonOUNote = '';
          if (poissonOverP !== null) {
            const diff = poissonOverP - overP;
            // Als Poisson >8% afwijkt van boekmaker → nudge richting Poisson
            if (Math.abs(diff) > 0.08) {
              poissonOUAdj = Math.max(-0.04, Math.min(0.04, diff * 0.3));
              overP = Math.max(0.10, Math.min(0.90, overP + poissonOUAdj));
              poissonOUNote = ` | Poisson O2.5: ${(poissonOverP*100).toFixed(0)}% (${poissonOUAdj>0?'+':''}${(poissonOUAdj*100).toFixed(1)}%)`;
            }
          }

          const overEdge  = overP * over.best.price - 1;
          const underEdge = under.best.price > 0 ? (1-overP) * under.best.price - 1 : -1;
          const ouSignals = [...matchSignals];
          if (tsNote) ouSignals.push(`team_stats:${tsNote.replace(/[^+\-\d.%]/g,'').trim()}`);
          if (weatherOUAdj !== 0) ouSignals.push(`weather_ou:${(weatherOUAdj*100).toFixed(1)}%`);
          if (Math.abs(poissonOUAdj) >= 0.005) ouSignals.push(`poisson_ou:${poissonOUAdj>0?'+':''}${(poissonOUAdj*100).toFixed(1)}%`);
          if (overEdge >= MIN_EDGE)
            mkP(`${hm} vs ${aw}`, league.name, `⚽ Over 2.5 goals`, over.best.price,
              `O/U consensus: ${(overP*100).toFixed(1)}% over | ${over.best.bookie}: ${over.best.price}${tsNote}${weatherOUNote}${poissonOUNote}${predNote} | ${ko}`,
              Math.round(overP*100), overEdge * 0.24 * (cm.over?.multiplier ?? 1), kickoffTime, over.best.bookie, ouSignals, refereeName);
          if (underEdge >= MIN_EDGE && under.best.price >= 1.60)
            mkP(`${hm} vs ${aw}`, league.name, `🔒 Under 2.5 goals`, under.best.price,
              `O/U consensus: ${((1-overP)*100).toFixed(1)}% under | ${under.best.bookie}: ${under.best.price}${tsNote}${weatherOUNote}${poissonOUNote} | ${ko}`,
              Math.round((1-overP)*100), underEdge * 0.22 * (cm.under?.multiplier ?? 1), kickoffTime, under.best.bookie, ouSignals, refereeName);
        }

        // ── BTTS (Both Teams To Score) ────────────────────────────────
        {
          // api-football bet id 8: "Both Teams to Score"
          const bttsBk = filteredBks.map(fb => {
            const bttsM = fb.bets?.find(b => b.id === 8);
            if (!bttsM) return null;
            return { name: fb.name, values: bttsM.values || [] };
          }).filter(Boolean);

          if (bttsBk.length > 0) {
            let bestYes = { price: 0, bookie: '' };
            let bestNo  = { price: 0, bookie: '' };
            for (const b of bttsBk) {
              const yesVal = b.values.find(v => v.value === 'Yes');
              const noVal  = b.values.find(v => v.value === 'No');
              if (yesVal) { const p = parseFloat(yesVal.odd); if (p > bestYes.price) bestYes = { price: p, bookie: b.name }; }
              if (noVal)  { const p = parseFloat(noVal.odd);  if (p > bestNo.price)  bestNo  = { price: p, bookie: b.name }; }
            }

            if (bestYes.price >= 1.50 || bestNo.price >= 1.50) {
              // Base BTTS probability from H2H + form
              const h2hKey2 = hmSt?.teamId && awSt?.teamId ? `${Math.min(hmSt.teamId,awSt.teamId)}-${Math.max(hmSt.teamId,awSt.teamId)}` : null;
              const h2hData = h2hKey2 ? afCache.h2h[h2hKey2] : null;
              const h2hBTTS = h2hData ? h2hData.bttsRate * h2hData.n : 0;
              const h2hN    = h2hData ? h2hData.n : 0;
              const hmGFAvg = hmSt?.goalsFor || 1.2;
              const awGFAvg = awSt?.goalsFor || 1.2;

              let bttsYesP = calcBTTSProb({ h2hBTTS, h2hN, hmAvgGF: hmGFAvg, awAvgGF: awGFAvg }) / 100;

              // Boost BTTS Yes if both teams score > 1.3 per game
              let bttsAdj = 0;
              if (hmGFAvg > 1.3 && awGFAvg > 1.3) {
                bttsAdj += Math.min(0.05, ((hmGFAvg + awGFAvg) - 2.6) * 0.04);
                bttsYesP = Math.min(0.85, bttsYesP + bttsAdj);
              }
              // Boost BTTS No if either team has high clean sheet rate (>35%)
              let csBoost = 0;
              if (hmSt && hmSt.goalsAgainst < 0.8) { csBoost += 0.04; }
              if (awSt && awSt.goalsAgainst < 0.8) { csBoost += 0.04; }
              // Use team stats for more accurate clean sheet info
              const hmTS2 = hmSt?.teamId ? teamStatsCache[`${hmSt.teamId}-${league.id}-${league.season}`] : null;
              const awTS2 = awSt?.teamId ? teamStatsCache[`${awSt.teamId}-${league.id}-${league.season}`] : null;
              if (hmTS2 && hmTS2.cleanSheetPct > 0.35) csBoost += Math.min(0.04, (hmTS2.cleanSheetPct - 0.35) * 0.10);
              if (awTS2 && awTS2.cleanSheetPct > 0.35) csBoost += Math.min(0.04, (awTS2.cleanSheetPct - 0.35) * 0.10);
              if (csBoost > 0) bttsYesP = Math.max(0.15, bttsYesP - csBoost);

              // Weather: regen + beide teams scoren veel → BTTS Yes omlaag
              let bttWeatherAdj = 0;
              if (weatherData && weatherData.rain > 5 && hmGFAvg > 1.3 && awGFAvg > 1.3) {
                bttWeatherAdj = -0.03;
                bttsYesP = Math.max(0.15, bttsYesP + bttWeatherAdj);
              }

              // Poisson cross-check voor BTTS
              let bttsPoissonAdj = 0;
              if (poissonBttsP !== null) {
                const diff = poissonBttsP - bttsYesP;
                if (Math.abs(diff) > 0.08) {
                  bttsPoissonAdj = Math.max(-0.04, Math.min(0.04, diff * 0.3));
                  bttsYesP = Math.max(0.15, Math.min(0.85, bttsYesP + bttsPoissonAdj));
                }
              }

              const bttsNoP = 1 - bttsYesP;
              const bttsYesEdge = bttsYesP * bestYes.price - 1;
              const bttsNoEdge  = bttsNoP * bestNo.price - 1;
              const bttsSignals = [...matchSignals];
              if (bttsAdj > 0) bttsSignals.push(`btts_scoring:+${(bttsAdj*100).toFixed(1)}%`);
              if (csBoost > 0) bttsSignals.push(`btts_cleansheet:-${(csBoost*100).toFixed(1)}%`);
              if (bttWeatherAdj !== 0) bttsSignals.push(`btts_weather:${(bttWeatherAdj*100).toFixed(1)}%`);
              if (Math.abs(bttsPoissonAdj) >= 0.005) bttsSignals.push(`btts_poisson:${bttsPoissonAdj>0?'+':''}${(bttsPoissonAdj*100).toFixed(1)}%`);

              if (bttsYesEdge >= MIN_EDGE && bestYes.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔥 BTTS Ja`, bestYes.price,
                  `BTTS: ${(bttsYesP*100).toFixed(1)}% | ${bestYes.bookie}: ${bestYes.price} | GF: ${hmGFAvg}/${awGFAvg} | ${ko}`,
                  Math.round(bttsYesP*100), bttsYesEdge * 0.22 * (cm.over?.multiplier ?? 1), kickoffTime, bestYes.bookie, bttsSignals, refereeName);

              if (bttsNoEdge >= MIN_EDGE && bestNo.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🛡️ BTTS Nee`, bestNo.price,
                  `BTTS Nee: ${(bttsNoP*100).toFixed(1)}% | ${bestNo.bookie}: ${bestNo.price} | CS: ${hmTS2?.cleanSheetPct ? (hmTS2.cleanSheetPct*100).toFixed(0)+'%' : '?'}/${awTS2?.cleanSheetPct ? (awTS2.cleanSheetPct*100).toFixed(0)+'%' : '?'} | ${ko}`,
                  Math.round(bttsNoP*100), bttsNoEdge * 0.20 * (cm.under?.multiplier ?? 1), kickoffTime, bestNo.bookie, bttsSignals, refereeName);
            }
          }
        }

        // ── Draw No Bet ──────────────────────────────────────────────
        {
          // api-football bet id 12: "Draw No Bet" (not Asian Handicap which is also id 12 in some contexts)
          const dnbBk = filteredBks.map(fb => {
            // Look for Draw No Bet specifically (different from Asian Handicap)
            const dnbM = fb.bets?.find(b => b.id === 12 && (b.name||'').toLowerCase().includes('draw no bet'));
            if (!dnbM) return null;
            return { name: fb.name, values: dnbM.values || [] };
          }).filter(Boolean);

          if (dnbBk.length > 0) {
            let bestDnbH = { price: 0, bookie: '' };
            let bestDnbA = { price: 0, bookie: '' };
            for (const b of dnbBk) {
              const homeVal = b.values.find(v => v.value === 'Home');
              const awayVal = b.values.find(v => v.value === 'Away');
              if (homeVal) { const p = parseFloat(homeVal.odd); if (p > bestDnbH.price) bestDnbH = { price: p, bookie: b.name }; }
              if (awayVal) { const p = parseFloat(awayVal.odd); if (p > bestDnbA.price) bestDnbA = { price: p, bookie: b.name }; }
            }

            // DNB probability: remove draw chance and redistribute
            const dnbHomeP = fp.draw > 0 ? adjHome2 / (adjHome2 + adjAway2) : adjHome2;
            const dnbAwayP = fp.draw > 0 ? adjAway2 / (adjHome2 + adjAway2) : adjAway2;

            const dnbHomeEdge = dnbHomeP * bestDnbH.price - 1;
            const dnbAwayEdge = dnbAwayP * bestDnbA.price - 1;

            if (dnbHomeEdge >= MIN_EDGE && bestDnbH.price >= 1.30 && bestDnbH.price <= 2.50)
              mkP(`${hm} vs ${aw}`, league.name, `🏠 DNB ${hm}`, bestDnbH.price,
                `Draw No Bet: ${(dnbHomeP*100).toFixed(1)}% | ${bestDnbH.bookie}: ${bestDnbH.price} | Gelijk=terugbetaling | ${ko}`,
                Math.round(dnbHomeP*100), dnbHomeEdge * 0.24, kickoffTime, bestDnbH.bookie, matchSignals, refereeName);

            if (dnbAwayEdge >= MIN_EDGE && bestDnbA.price >= 1.30 && bestDnbA.price <= 2.50)
              mkP(`${hm} vs ${aw}`, league.name, `✈️ DNB ${aw}`, bestDnbA.price,
                `Draw No Bet: ${(dnbAwayP*100).toFixed(1)}% | ${bestDnbA.bookie}: ${bestDnbA.price} | Gelijk=terugbetaling | ${ko}`,
                Math.round(dnbAwayP*100), dnbAwayEdge * 0.24, kickoffTime, bestDnbA.bookie, matchSignals, refereeName);
          }
        }

        // ── Double Chance (1X / X2 / 12) via 1X2 devig ──
        // Bookies bieden soms apart "Double Chance" markt. Als die er is: check edge tegen
        // afgeleide kansen. Lage odds (1.10-2.00) maar laag-variance markt, goed voor combi's.
        const dcBookies = bookies.map(fb => {
          const dcM = fb.markets?.find(m =>
            (m.key || '').includes('double_chance') || (m.key || '').includes('double-chance')
          );
          if (!dcM) return null;
          return { name: fb.title || fb.name, values: dcM.outcomes || [] };
        }).filter(Boolean);

        if (dcBookies.length > 0 && adjHome2 && adjAway2) {
          const pHX = adjHome2 + (adjDraw || 0);
          const p12 = adjHome2 + adjAway2;
          const pX2 = (adjDraw || 0) + adjAway2;

          let bestHX = { price: 0, bookie: '' };
          let best12 = { price: 0, bookie: '' };
          let bestX2 = { price: 0, bookie: '' };
          for (const b of dcBookies) {
            for (const o of b.values) {
              const val = String(o.name || '').trim();
              const price = parseFloat(o.price) || 0;
              if (price <= 1.0) continue;
              // Namen variëren per bookie: "Home/Draw", "1X", "1/X", etc.
              const v = val.toLowerCase().replace(/[\/\-\s]/g, '');
              if ((v === '1x' || v === 'homedraw') && price > bestHX.price) bestHX = { price, bookie: b.name };
              else if ((v === '12' || v === 'homeaway') && price > best12.price) best12 = { price, bookie: b.name };
              else if ((v === 'x2' || v === 'drawaway') && price > bestX2.price) bestX2 = { price, bookie: b.name };
            }
          }

          const eHX = bestHX.price > 0 ? pHX * bestHX.price - 1 : -1;
          const e12 = best12.price > 0 ? p12 * best12.price - 1 : -1;
          const eX2 = bestX2.price > 0 ? pX2 * bestX2.price - 1 : -1;

          if (eHX >= MIN_EDGE && bestHX.price >= 1.15 && bestHX.price <= 2.50)
            mkP(`${hm} vs ${aw}`, league.name, `🎯 1X (${hm} of gelijk)`, bestHX.price,
              `Double Chance 1X: ${(pHX*100).toFixed(1)}% | ${bestHX.bookie}: ${bestHX.price} | ${ko}`,
              Math.round(pHX*100), eHX * 0.16, kickoffTime, bestHX.bookie, matchSignals, refereeName);
          if (e12 >= MIN_EDGE && best12.price >= 1.15 && best12.price <= 2.50)
            mkP(`${hm} vs ${aw}`, league.name, `🎯 12 (geen gelijk)`, best12.price,
              `Double Chance 12: ${(p12*100).toFixed(1)}% | ${best12.bookie}: ${best12.price} | ${ko}`,
              Math.round(p12*100), e12 * 0.16, kickoffTime, best12.bookie, matchSignals, refereeName);
          if (eX2 >= MIN_EDGE && bestX2.price >= 1.15 && bestX2.price <= 2.50)
            mkP(`${hm} vs ${aw}`, league.name, `🎯 X2 (${aw} of gelijk)`, bestX2.price,
              `Double Chance X2: ${(pX2*100).toFixed(1)}% | ${bestX2.bookie}: ${bestX2.price} | ${ko}`,
              Math.round(pX2*100), eX2 * 0.16, kickoffTime, bestX2.bookie, matchSignals, refereeName);
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
                `Handicap | ${bk.title}: ${o.price} | ${ko}`, Math.round(baseP*100), sEdge * 0.20, kickoffTime, bk.title, matchSignals, refereeName);
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

  // Tag alle prematch picks als 'pre' + sport
  for (const p of picks)     { p.scanType = 'pre'; p.sport = 'football'; }
  for (const p of combiPool) { p.scanType = 'pre'; p.sport = 'football'; }

  emit({ log: `📋 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} pre-match picks` });

  emit({ log: `📋 Totaal ${picks.length} kandidaten | Combi's berekenen...` });

  // ── STAP 3: COMBI'S (2-beners + 3-beners) ───────────────────────────────
  // Alle EV+ picks (ook odds < 1.60) komen in de combiPool.
  // Singles (>= 1.60), 2-beners en 3-beners worden in één pool gegooid.
  // Sortering op hitrate (ep) · hoogste kans wint, ongeacht of het single/combi is.
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
    // Telegram wordt gestuurd NA multi-sport merge
    emit({ log: `📭 Geen voetbal picks (${allCandidates.length} kandidaten te zwak).`, picks: [] });
    return [];
  }

  const weakNote = weakCount > 0 ? ` (${weakCount} zwakke kandidaat${weakCount>1?'en':''} weggelaten)` : '';
  emit({ log: `🎯 ${finalPicks.length} voetbal pick${finalPicks.length>1?'s':''}${weakNote}` });

  lastPrematchPicks = finalPicks;
  // Telegram wordt gestuurd NA multi-sport merge in POST /api/prematch
  emit({ log: `✅ Voetbal scan klaar.`, picks: finalPicks });

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
// LIVE PICKS HELPER · haalt live wedstrijden op + analyseert met xG + live odds
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

    // Scenario 1: xG-dominantie vs. score · value op dominerend team dat verliest/gelijkspeelt
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

  // Tag alle picks als 'live' + sport en geef terug
  return picks.map(p => ({ ...p, scanType: 'live', sport: 'football', fixtureId: undefined }));
}

// ── DAGELIJKSE LIVE CHECK (vanuit cron) ──────────────────────────────────────
async function runLive(emit) {
  emit({ log: '🔴 Live scan · xG + live odds + balbezit' });
  const calib = loadCalib();
  const livePicks = await getLivePicks(emit, calib.epBuckets || {});

  if (!livePicks.length) {
    emit({ log: '📭 Geen picks.', picks: [] });
    return [];
  }

  const time = new Date().toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
  let msgs = [`🔴 LIVE · ${time}\n${livePicks.length} pick(s)\n\n`], cur = 0;
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
// BET TRACKER · GOOGLE SHEETS
// ═══════════════════════════════════════════════════════════════════════════════

function calcStats(bets, startBankroll = START_BANKROLL, unitEur = UNIT_EUR) {
  const W     = bets.filter(b => b.uitkomst === 'W').length;
  const L     = bets.filter(b => b.uitkomst === 'L').length;
  const open  = bets.filter(b => b.uitkomst === 'Open').length;
  const total = bets.length;
  const wlEur = bets.reduce((s, b) => s + (b.uitkomst !== 'Open' ? b.wl : 0), 0);
  const totalInzet = bets.filter(b => b.uitkomst !== 'Open').reduce((s, b) => s + b.inzet, 0);
  const roi   = totalInzet > 0 ? wlEur / totalInzet : 0;
  const openInzet = bets.filter(b => b.uitkomst === 'Open').reduce((s, b) => s + (b.inzet || 0), 0);
  const bankroll  = +(startBankroll + wlEur).toFixed(2); // alleen settled
  const avgOdds   = total > 0 ? +(bets.reduce((s,b)=>s+b.odds,0)/total).toFixed(3) : 0;
  const avgUnits  = total > 0 ? +(bets.reduce((s,b)=>s+b.units,0)/total).toFixed(2) : 0;
  const strikeRate = (W+L) > 0 ? Math.round(W/(W+L)*100) : 0;
  const winU  = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>s+(b.wl/unitEur),0).toFixed(2);
  const lossU = +bets.filter(b=>b.uitkomst==='L').reduce((s,b)=>s+(b.wl/unitEur),0).toFixed(2);
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

  // Potentiële dagwinst voor open bets van vandaag
  const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const todayBets = bets.filter(b => {
    if (b.uitkomst !== 'Open') return false;
    // datum format: DD-MM-YYYY → YYYY-MM-DD
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

  // Net units: wl in euro gedeeld door unit size (huidige unitEur als proxy).
  // Voor een precieze berekening zou unit_at_time per bet opgeslagen moeten worden;
  // voor nu gebruiken we de huidige unit size.
  const netUnits  = unitEur > 0 ? +(wlEur / unitEur).toFixed(2) : 0;
  const netProfit = +wlEur.toFixed(2);

  return { total, W, L, open, wlEur: +wlEur.toFixed(2), roi: +roi.toFixed(4),
           bankroll: +bankroll.toFixed(2), startBankroll, avgOdds, avgUnits, strikeRate, winU, lossU,
           netUnits, netProfit,
           avgCLV, clvPositive, clvTotal,
           expectedWins, actualWins, variance, varianceStdDev, luckFactor,
           potentialWin, potentialLoss, todayBetsCount };
}

async function readBets(userId = null) {
  let query = supabase.from('bets').select('*').order('bet_id', { ascending: true });
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const bets = (data || []).map(r => ({
    id: r.bet_id, datum: r.datum || '', sport: r.sport || '', wedstrijd: r.wedstrijd || '',
    markt: r.markt || '', odds: r.odds || 0, units: r.units || 0,
    inzet: r.inzet || +(r.units * UNIT_EUR).toFixed(2),
    tip: r.tip || 'Bet365', uitkomst: r.uitkomst || 'Open', wl: r.wl || 0,
    tijd: r.tijd || '', score: r.score || null,
    signals: r.signals || '', clvOdds: r.clv_odds || null, clvPct: r.clv_pct || null,
    fixtureId: r.fixture_id || null,
  }));
  return { bets, stats: calcStats(bets), _raw: data };
}

async function writeBet(bet, userId = null) {
  const inzet = bet.units * UNIT_EUR;
  const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2)
           : bet.uitkomst === 'L' ? -inzet : 0;
  const base = {
    bet_id: bet.id, datum: bet.datum, sport: bet.sport, wedstrijd: bet.wedstrijd,
    markt: bet.markt, odds: bet.odds, units: bet.units, inzet, tip: bet.tip || 'Bet365',
    uitkomst: bet.uitkomst || 'Open', wl, tijd: bet.tijd || '', score: bet.score || null,
    signals: bet.signals || '',
    user_id: userId || null,
  };
  // Probeer insert mét fixture_id; val terug zonder fixture_id voor oude DB-schemas
  try {
    const { error } = await supabase.from('bets').insert({ ...base, fixture_id: bet.fixtureId || null });
    if (error) {
      if ((error.message || '').toLowerCase().includes('column')) {
        const { error: err2 } = await supabase.from('bets').insert(base);
        if (err2) throw new Error(err2.message);
      } else {
        throw new Error(error.message);
      }
    }
  } catch (e) {
    if ((e.message || '').toLowerCase().includes('column')) {
      const { error: err2 } = await supabase.from('bets').insert(base);
      if (err2) throw new Error(err2.message);
    } else {
      throw e;
    }
  }
}

async function updateBetOutcome(id, uitkomst, userId = null) {
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

async function deleteBet(id, userId = null) {
  let query = supabase.from('bets').delete().eq('bet_id', id);
  if (userId) query = query.eq('user_id', userId);
  await query;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── AUTH ROUTES ────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (rateLimit('login:' + ip, 10, 15 * 60 * 1000)) return res.status(429).json({ error: 'Te veel pogingen · probeer over 15 minuten opnieuw' });
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    const users = await loadUsers();
    const user  = users.find(u => u.email === email.toLowerCase());
    if (!user)                        return res.status(401).json({ error: 'E-mail of wachtwoord onjuist' });
    if (user.status === 'blocked')    return res.status(403).json({ error: 'Account geblokkeerd · neem contact op' });
    if (user.status === 'pending')    return res.status(403).json({ error: 'Je account wacht nog op goedkeuring. Check je email.' });
    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'E-mail of wachtwoord onjuist' });
    // 2FA: if enabled, send code via email instead of token
    if (user.settings?.twoFactorEnabled) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      loginCodes.set(user.email, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
      await sendEmail(user.email, 'EdgePickr login code', `<h2>Je login code: ${code}</h2><p>Geldig voor 5 minuten.</p>`);
      return res.json({ requires2FA: true });
    }
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, settings: user.settings } });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── 2FA VERIFY CODE ───────────────────────────────────────────────────────
app.post('/api/auth/verify-code', async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (rateLimit('verify2fa:' + ip, 5, 15 * 60 * 1000)) return res.status(429).json({ error: 'Te veel pogingen · probeer over 15 minuten opnieuw' });
    const { email, code } = req.body || {};
    if (!email || !code) return res.status(400).json({ error: 'E-mail en code verplicht' });
    const entry = loginCodes.get(email.toLowerCase());
    if (!entry || entry.code !== code || Date.now() > entry.expiresAt) {
      return res.status(401).json({ error: 'Ongeldige of verlopen code' });
    }
    loginCodes.delete(email.toLowerCase());
    const users = await loadUsers();
    const user = users.find(u => u.email === email.toLowerCase());
    if (!user) return res.status(401).json({ error: 'Verificatie mislukt' });
    // Herhaal status-check: account kan tussen code-uitgifte en verify geblokkeerd of niet-goedgekeurd zijn
    if (user.status === 'blocked') return res.status(403).json({ error: 'Account geblokkeerd · neem contact op' });
    if (user.status === 'pending') return res.status(403).json({ error: 'Je account wacht nog op goedkeuring. Check je email.' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, role: user.role, settings: user.settings } });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    if (rateLimit('register:' + ip, 5, 60 * 60 * 1000)) return res.status(429).json({ error: 'Te veel registraties · probeer over een uur' });
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'E-mail en wachtwoord verplicht' });
    if (password.length < 8)  return res.status(400).json({ error: 'Wachtwoord minimaal 8 tekens' });
    const users = await loadUsers(true);
    if (users.find(u => u.email === email.toLowerCase()))
      return res.status(200).json({ message: 'Registratie ontvangen. Je krijgt een email zodra je account is goedgekeurd.' }); // generic to prevent enumeration
    const hash = await bcrypt.hash(password, 10);
    await saveUser({
      id: crypto.randomUUID(), email: email.toLowerCase(), passwordHash: hash,
      role: 'user', status: 'pending',
      settings: defaultSettings(), createdAt: new Date().toISOString()
    });
    tg(`🆕 Nieuwe registratie: ${email}\nGoedkeuren via Admin-panel`).catch(() => {});
    res.json({ message: 'Registratie ontvangen. Je krijgt een email zodra je account is goedgekeurd.' });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

app.get('/api/auth/me', async (req, res) => {
  try {
    const users = await loadUsers();
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    res.json({ id: user.id, email: user.email, role: user.role, settings: user.settings });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── USER SETTINGS ──────────────────────────────────────────────────────────────
app.get('/api/user/settings', async (req, res) => {
  try {
    const users = await loadUsers();
    const user  = users.find(u => u.id === req.user.id);
    res.json(user?.settings || defaultSettings());
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

app.put('/api/user/settings', async (req, res) => {
  try {
    const users = await loadUsers(true);
    const user  = users.find(u => u.id === req.user.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const allowed = ['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled','twoFactorEnabled','preferredBookies'];
    allowed.forEach(k => { if (req.body[k] !== undefined) user.settings[k] = req.body[k]; });
    await saveUser(user);
    // Herplan scans als admin
    if (user.role === 'admin') rescheduleUserScans(user);
    res.json({ settings: user.settings });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
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
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── ADMIN ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers(true);
    res.json(users.map(u => ({ id: u.id, email: u.email, role: u.role, status: u.status, createdAt: u.createdAt })));
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── v2 Admin: pick_candidates analytics ─────────────────────────────────────
// GET /api/admin/v2/pick-candidates-summary?hours=24
// Toont aggregaties: totaal kandidaten, accepted ratio, top reject reasons,
// top sporten, breakdown per markt. Helpt bij modelsturing zonder DB-tools.
app.get('/api/admin/v2/pick-candidates-summary', requireAdmin, async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data: candidates, error } = await supabase
      .from('pick_candidates')
      .select('id, fixture_id, selection_key, bookmaker, bookmaker_odds, fair_prob, edge_pct, passed_filters, rejected_reason, model_run_id, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });
    const list = candidates || [];
    if (!list.length) {
      return res.json({ hours, total: 0, accepted: 0, rejected: 0, byReason: {}, byBookie: {}, recentRejected: [] });
    }
    const accepted = list.filter(c => c.passed_filters).length;
    const rejected = list.length - accepted;
    // Group rejected by reason category (strip dynamic numbers)
    const byReason = {};
    for (const c of list) {
      if (c.passed_filters) continue;
      const cat = (c.rejected_reason || 'unknown').split(' (')[0];
      byReason[cat] = (byReason[cat] || 0) + 1;
    }
    // Group by bookmaker
    const byBookie = {};
    for (const c of list) {
      const b = c.bookmaker || 'none';
      if (!byBookie[b]) byBookie[b] = { total: 0, accepted: 0 };
      byBookie[b].total++;
      if (c.passed_filters) byBookie[b].accepted++;
    }
    // Last 10 rejected for inspection
    const recentRejected = list.filter(c => !c.passed_filters).slice(0, 10).map(c => ({
      id: c.id, fixture_id: c.fixture_id, selection: c.selection_key,
      bookie: c.bookmaker, odds: c.bookmaker_odds, edge: c.edge_pct,
      reason: c.rejected_reason, at: c.created_at,
    }));
    res.json({
      hours, total: list.length, accepted, rejected,
      acceptanceRate: +(accepted / list.length * 100).toFixed(1),
      byReason: Object.fromEntries(Object.entries(byReason).sort((a, b) => b[1] - a[1])),
      byBookie,
      recentRejected,
    });
  } catch (e) {
    res.status(500).json({ error: 'Interne fout' });
  }
});

// GET /api/admin/v2/clv-stats?days=30 — CLV-first KPI per sport + markt
// Reviewer-aanbeveling: CLV is hoofd-KPI (winrate is te noisy bij kleine samples).
// Toont per sport en per (sport,markt) bucket: sample size, avg CLV%, % positief.
app.get('/api/admin/v2/clv-stats', requireAdmin, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();
    const { data: bets, error } = await supabase.from('bets')
      .select('sport, markt, clv_pct, uitkomst, wl, datum')
      .not('clv_pct', 'is', null);
    if (error) return res.status(500).json({ error: error.message });

    const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct));
    if (!all.length) return res.json({ days, totalBets: 0, bySport: {}, byMarket: {}, killEligible: [] });

    // Per sport
    const bySport = {};
    for (const b of all) {
      const s = normalizeSport(b.sport || 'football');
      if (!bySport[s]) bySport[s] = { n: 0, sumClv: 0, positive: 0, sumPnl: 0, settledN: 0 };
      bySport[s].n++;
      bySport[s].sumClv += b.clv_pct;
      if (b.clv_pct > 0) bySport[s].positive++;
      if (b.uitkomst === 'W' || b.uitkomst === 'L') {
        bySport[s].settledN++;
        bySport[s].sumPnl += parseFloat(b.wl || 0);
      }
    }
    const sportSummary = {};
    for (const [s, d] of Object.entries(bySport)) {
      sportSummary[s] = {
        n: d.n,
        avg_clv_pct: +(d.sumClv / d.n).toFixed(2),
        positive_clv_pct: +(d.positive / d.n * 100).toFixed(1),
        settled_n: d.settledN,
        total_pnl_eur: +d.sumPnl.toFixed(2),
      };
    }

    // Per (sport, marktcategorie) bucket
    const byMarket = {};
    for (const b of all) {
      const s = normalizeSport(b.sport || 'football');
      const mk = detectMarket(b.markt || 'other');
      const key = `${s}_${mk}`;
      if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0, positive: 0, sumPnl: 0 };
      byMarket[key].n++;
      byMarket[key].sumClv += b.clv_pct;
      if (b.clv_pct > 0) byMarket[key].positive++;
      if (b.uitkomst === 'W' || b.uitkomst === 'L') byMarket[key].sumPnl += parseFloat(b.wl || 0);
    }
    const marketSummary = {};
    for (const [k, d] of Object.entries(byMarket)) {
      marketSummary[k] = {
        n: d.n,
        avg_clv_pct: +(d.sumClv / d.n).toFixed(2),
        positive_clv_pct: +(d.positive / d.n * 100).toFixed(1),
        total_pnl_eur: +d.sumPnl.toFixed(2),
      };
    }

    // Kill-switch eligibility: markten die ≥30 bets hebben EN gemiddeld CLV < -2%.
    // Reviewer-regel: structureel negatieve CLV → consider auto-disable.
    const killEligible = [];
    for (const [k, s] of Object.entries(marketSummary)) {
      if (s.n >= 30 && s.avg_clv_pct < -2.0) {
        killEligible.push({
          key: k, n: s.n, avg_clv_pct: s.avg_clv_pct,
          recommendation: s.avg_clv_pct < -5 ? 'AUTO_DISABLE' : 'WATCHLIST',
        });
      }
    }

    res.json({
      days, totalBets: all.length,
      bySport: sportSummary,
      byMarket: marketSummary,
      killEligible,
      thresholds: { kill_min_n: 30, watchlist_clv: -2.0, auto_disable_clv: -5.0 },
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  }
});

// GET /api/admin/v2/kill-switch — huidige status + actieve killed markten
app.get('/api/admin/v2/kill-switch', requireAdmin, (req, res) => {
  res.json({
    enabled: KILL_SWITCH.enabled,
    activeKills: [...KILL_SWITCH.set],
    thresholds: KILL_SWITCH.thresholds,
    lastRefreshed: KILL_SWITCH.lastRefreshed ? new Date(KILL_SWITCH.lastRefreshed).toISOString() : null,
  });
});

// POST /api/admin/v2/kill-switch — admin override (toggle enabled, manual add/remove)
app.post('/api/admin/v2/kill-switch', requireAdmin, async (req, res) => {
  try {
    const { enabled, addKey, removeKey, refresh } = req.body || {};
    if (typeof enabled === 'boolean') KILL_SWITCH.enabled = enabled;
    if (typeof addKey === 'string' && addKey) KILL_SWITCH.set.add(addKey);
    if (typeof removeKey === 'string' && removeKey) KILL_SWITCH.set.delete(removeKey);
    if (refresh) await refreshKillSwitch();
    res.json({
      enabled: KILL_SWITCH.enabled,
      activeKills: [...KILL_SWITCH.set],
      lastRefreshed: KILL_SWITCH.lastRefreshed ? new Date(KILL_SWITCH.lastRefreshed).toISOString() : null,
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/walkforward?sport=hockey&days=30
// Walk-forward evaluatie: voor elke historische pick_candidate die settled is,
// vergelijk model-prob met outcome. Berekent Brier score (model accuracy).
// Brier < 0.20 = uitstekend, 0.25 = neutraal, > 0.30 = slecht.
app.get('/api/admin/v2/walkforward', requireAdmin, async (req, res) => {
  try {
    const sport = req.query.sport ? normalizeSport(req.query.sport) : null;
    const days = Math.max(1, Math.min(365, parseInt(req.query.days) || 30));
    const sinceIso = new Date(Date.now() - days * 86400000).toISOString();

    // Stap 1: pak picks die zijn geplaatst en al een uitkomst hebben
    const { data: bets, error: betsErr } = await supabase.from('bets')
      .select('bet_id, sport, markt, odds, uitkomst, wl, clv_pct, datum').in('uitkomst', ['W', 'L']);
    if (betsErr) return res.status(500).json({ error: betsErr.message });
    const all = (bets || []).filter(b => {
      if (sport && normalizeSport(b.sport) !== sport) return false;
      // Datum filter (parse dd-mm-yyyy)
      const dm = (b.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (!dm) return false;
      const iso = `${dm[3]}-${dm[2]}-${dm[1]}`;
      return iso >= sinceIso.slice(0, 10);
    });

    if (!all.length) return res.json({ days, sport, n: 0, message: 'Te weinig settled bets in window' });

    // Brier score: gemiddelde van (predicted_prob - actual_outcome)^2
    // We hebben geen model-prob in bets; gebruiken impliciete prob uit logged odds als proxy.
    let brierSum = 0;
    let logLossSum = 0;
    const buckets = { '0-30': { n: 0, w: 0 }, '30-50': { n: 0, w: 0 }, '50-70': { n: 0, w: 0 }, '70-100': { n: 0, w: 0 } };
    for (const b of all) {
      const odds = parseFloat(b.odds);
      if (!odds || odds <= 1) continue;
      const impliedP = 1 / odds;
      const actual = b.uitkomst === 'W' ? 1 : 0;
      brierSum += Math.pow(impliedP - actual, 2);
      // Log loss: −[y log(p) + (1-y) log(1-p)], met clamping
      const p = Math.max(1e-6, Math.min(1 - 1e-6, impliedP));
      logLossSum += -(actual * Math.log(p) + (1 - actual) * Math.log(1 - p));
      // Calibration buckets op impliedP
      const pct = impliedP * 100;
      let bk;
      if (pct < 30) bk = '0-30';
      else if (pct < 50) bk = '30-50';
      else if (pct < 70) bk = '50-70';
      else bk = '70-100';
      buckets[bk].n++;
      if (b.uitkomst === 'W') buckets[bk].w++;
    }
    const brier = +(brierSum / all.length).toFixed(4);
    const logLoss = +(logLossSum / all.length).toFixed(4);

    // Calibration error: |actual_winrate - predicted_winrate| per bucket
    const calibration = {};
    for (const [bk, d] of Object.entries(buckets)) {
      if (!d.n) continue;
      calibration[bk] = {
        n: d.n,
        actual_wr: +(d.w / d.n).toFixed(3),
        predicted_wr_mid: { '0-30': 0.15, '30-50': 0.40, '50-70': 0.60, '70-100': 0.85 }[bk],
      };
    }

    res.json({
      days, sport, n: all.length,
      brier_score: brier,
      log_loss: logLoss,
      interpretation: brier < 0.20 ? 'EXCELLENT' : brier < 0.25 ? 'GOOD' : brier < 0.30 ? 'NEUTRAL' : 'POOR',
      calibration,
      note: 'Gebruikt impliciete prob uit logged odds als baseline. Pas wanneer pick_candidates volume ≥500 hebben kunnen we walk-forward op echte model-prob doen.',
    });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  }
});

// POST /api/admin/v2/training-examples-build — schrijf training_examples voor settled bets
app.post('/api/admin/v2/training-examples-build', requireAdmin, async (req, res) => {
  try {
    const written = await writeTrainingExamplesForSettled();
    res.json({ written });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/signal-performance — historische signal stats
app.get('/api/admin/v2/signal-performance', requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase.from('signal_stats')
      .select('*').order('avg_clv', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ signals: data || [] });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/drift?days=30 — vergelijk recente vs lange-termijn CLV per markt/signaal
// Detecteert markten/signalen die recent verslechteren of verbeteren.
app.get('/api/admin/v2/drift', requireAdmin, async (req, res) => {
  try {
    const recentN = Math.max(10, Math.min(200, parseInt(req.query.recent) || 25));
    const { data: bets, error } = await supabase.from('bets')
      .select('sport, markt, clv_pct, signals, datum, uitkomst').not('clv_pct', 'is', null)
      .order('datum', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct));
    if (all.length < recentN * 2) {
      return res.json({ ok: false, reason: 'te weinig data', n_total: all.length, recent_window: recentN });
    }

    // Per markt drift
    const marketStats = {};
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
      if (!marketStats[key]) marketStats[key] = { all: [], recent: [] };
      marketStats[key].all.push(b.clv_pct);
      if (i < recentN) marketStats[key].recent.push(b.clv_pct);
    }
    const marketDrift = [];
    for (const [k, s] of Object.entries(marketStats)) {
      if (s.all.length < 10 || s.recent.length < 5) continue;
      const avgAll = s.all.reduce((a, b) => a + b, 0) / s.all.length;
      const avgRecent = s.recent.reduce((a, b) => a + b, 0) / s.recent.length;
      const drift = avgRecent - avgAll;
      let alert = null;
      if (drift < -2) alert = '🔴 SLECHTER';
      else if (drift > 2) alert = '✅ BETER';
      marketDrift.push({
        key, n_all: s.all.length, n_recent: s.recent.length,
        avg_clv_all: +avgAll.toFixed(2), avg_clv_recent: +avgRecent.toFixed(2),
        drift_pct: +drift.toFixed(2), alert,
      });
    }
    marketDrift.sort((a, b) => a.drift_pct - b.drift_pct);

    // Per signal drift
    const signalStats = {};
    for (let i = 0; i < all.length; i++) {
      const b = all[i];
      let sigs;
      try { sigs = typeof b.signals === 'string' ? JSON.parse(b.signals) : b.signals; } catch { continue; }
      if (!Array.isArray(sigs)) continue;
      const isRecent = i < recentN;
      for (const sig of sigs) {
        const name = String(sig).split(':')[0];
        if (!name) continue;
        if (!signalStats[name]) signalStats[name] = { all: [], recent: [] };
        signalStats[name].all.push(b.clv_pct);
        if (isRecent) signalStats[name].recent.push(b.clv_pct);
      }
    }
    const signalDrift = [];
    for (const [name, s] of Object.entries(signalStats)) {
      if (s.all.length < 20 || s.recent.length < 5) continue;
      const avgAll = s.all.reduce((a, b) => a + b, 0) / s.all.length;
      const avgRecent = s.recent.reduce((a, b) => a + b, 0) / s.recent.length;
      const drift = avgRecent - avgAll;
      let alert = null;
      if (drift < -1.5) alert = '🔴 verslechtert';
      else if (drift > 1.5) alert = '✅ verbetert';
      signalDrift.push({
        name, n_all: s.all.length, n_recent: s.recent.length,
        avg_clv_all: +avgAll.toFixed(2), avg_clv_recent: +avgRecent.toFixed(2),
        drift_pct: +drift.toFixed(2), alert,
      });
    }
    signalDrift.sort((a, b) => a.drift_pct - b.drift_pct);

    res.json({ ok: true, recent_window: recentN, marketDrift, signalDrift });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/why-this-pick?bet_id=X — attribution per pick
// Toont welke baseline (markt) + welke model-delta + welke signals contribueerden.
app.get('/api/admin/v2/why-this-pick', requireAdmin, async (req, res) => {
  try {
    const betId = parseInt(req.query.bet_id);
    if (!betId) return res.status(400).json({ error: 'bet_id is verplicht' });
    const { data: bet } = await supabase.from('bets').select('*').eq('bet_id', betId).maybeSingle();
    if (!bet) return res.status(404).json({ error: 'bet niet gevonden' });
    // Fixture ID lookup
    const fxId = bet.fixture_id;
    if (!fxId) return res.json({ bet, attribution: null, note: 'geen fixture_id, kan niet linken aan model_run' });
    // Pak model_run voor deze fixture + market type
    const marketType = detectMarket(bet.markt || 'other');
    const { data: runs } = await supabase.from('model_runs')
      .select('*').eq('fixture_id', fxId).order('captured_at', { ascending: false });
    const matchingRun = (runs || []).find(r => r.market_type?.includes(marketType.replace('60', ''))) || (runs || [])[0];
    // Pak feature_snapshot
    const { data: feat } = await supabase.from('feature_snapshots')
      .select('*').eq('fixture_id', fxId).order('captured_at', { ascending: false }).limit(1).maybeSingle();
    // Pak market_consensus
    const { data: cons } = await supabase.from('market_consensus')
      .select('*').eq('fixture_id', fxId).order('captured_at', { ascending: false }).limit(1).maybeSingle();
    // Pak pick_candidate
    const { data: candidates } = await supabase.from('pick_candidates')
      .select('*').eq('fixture_id', fxId).order('created_at', { ascending: false });
    res.json({
      bet: { id: bet.bet_id, wedstrijd: bet.wedstrijd, markt: bet.markt, odds: bet.odds, uitkomst: bet.uitkomst, clv_pct: bet.clv_pct },
      market_baseline: matchingRun?.baseline_prob || null,
      model_delta: matchingRun?.model_delta || null,
      final_prob: matchingRun?.final_prob || null,
      market_consensus: cons ? { type: cons.market_type, prob: cons.consensus_prob, bookies: cons.bookmaker_count, quality: cons.quality_score } : null,
      features: feat?.features || null,
      data_quality: feat?.quality || null,
      pick_candidates: (candidates || []).map(c => ({
        selection: c.selection_key, bookie: c.bookmaker, odds: c.bookmaker_odds,
        fair_prob: c.fair_prob, edge_pct: c.edge_pct, passed: c.passed_filters, rejected: c.rejected_reason,
      })),
      model_version_id: matchingRun?.model_version_id,
      run_captured_at: matchingRun?.captured_at,
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/data-quality — summary van datakwaliteit checks
// Toont per fixture/feature snapshot welke quality flags actief zijn.
app.get('/api/admin/v2/data-quality', requireAdmin, async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const { data: feats } = await supabase.from('feature_snapshots')
      .select('fixture_id, captured_at, quality').gte('captured_at', sinceIso);
    const totalFeats = (feats || []).length;
    if (!totalFeats) return res.json({ hours, totalFeatures: 0, qualityIssues: {} });

    const issues = { lineup_missing: 0, low_three_way_bookies: 0, no_standings: 0, shots_signal_invalid: 0, pitcher_signal_invalid: 0 };
    for (const f of feats) {
      const q = f.quality || {};
      if (q.lineup_known === false || q.lineup_confirmed === false) issues.lineup_missing++;
      if ((q.three_way_bookies || 0) < 3 && q.three_way_bookies !== undefined) issues.low_three_way_bookies++;
      if (q.standings_present === false) issues.no_standings++;
      if (q.shots_signal_valid === false) issues.shots_signal_invalid++;
      if (q.pitcher_signal_valid === false) issues.pitcher_signal_invalid++;
    }
    // Missing odds: tellen fixtures met 0 odds_snapshots in zelfde window
    const { data: oddsSnaps } = await supabase.from('odds_snapshots')
      .select('fixture_id').gte('captured_at', sinceIso);
    const fixtureWithOdds = new Set((oddsSnaps || []).map(o => o.fixture_id));
    const featFixtures = new Set((feats || []).map(f => f.fixture_id));
    const missingOddsCount = [...featFixtures].filter(f => !fixtureWithOdds.has(f)).length;

    res.json({
      hours, totalFeatures: totalFeats,
      qualityIssues: issues,
      missingOdds: { fixtures_with_features_but_no_odds: missingOddsCount },
      summary: {
        healthy_pct: totalFeats > 0 ? +((totalFeats - issues.no_standings - issues.lineup_missing) / totalFeats * 100).toFixed(1) : 100,
      },
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/per-bookie-stats — ROI/CLV per bookmaker
// Reviewer: 'executable edge meten op specifieke bookies'
app.get('/api/admin/v2/per-bookie-stats', requireAdmin, async (req, res) => {
  try {
    const { data: bets, error } = await supabase.from('bets')
      .select('tip, sport, markt, odds, uitkomst, wl, clv_pct, inzet')
      .in('uitkomst', ['W', 'L']);
    if (error) return res.status(500).json({ error: error.message });
    const all = bets || [];
    if (!all.length) return res.json({ bookies: {}, summary: { totalBets: 0 } });

    const byBookie = {};
    for (const b of all) {
      const bk = (b.tip || 'Unknown').trim();
      if (!byBookie[bk]) byBookie[bk] = { n: 0, w: 0, sumPnl: 0, sumStake: 0, clvN: 0, sumClv: 0, posClv: 0 };
      const s = byBookie[bk];
      s.n++;
      if (b.uitkomst === 'W') s.w++;
      s.sumPnl += parseFloat(b.wl || 0);
      s.sumStake += parseFloat(b.inzet || 0);
      if (typeof b.clv_pct === 'number' && !isNaN(b.clv_pct)) {
        s.clvN++;
        s.sumClv += b.clv_pct;
        if (b.clv_pct > 0) s.posClv++;
      }
    }
    const result = {};
    for (const [bk, s] of Object.entries(byBookie)) {
      const winRate = s.n ? (s.w / s.n * 100) : 0;
      const roiPct = s.sumStake ? (s.sumPnl / s.sumStake * 100) : 0;
      result[bk] = {
        n: s.n,
        win_rate_pct: +winRate.toFixed(1),
        roi_pct: +roiPct.toFixed(2),
        total_pnl_eur: +s.sumPnl.toFixed(2),
        total_stake_eur: +s.sumStake.toFixed(2),
        avg_clv_pct: s.clvN ? +(s.sumClv / s.clvN).toFixed(2) : null,
        positive_clv_pct: s.clvN ? +(s.posClv / s.clvN * 100).toFixed(1) : null,
        clv_sample: s.clvN,
      };
    }
    res.json({
      bookies: result,
      summary: { totalBets: all.length, bookieCount: Object.keys(byBookie).length },
      note: 'Toont executable edge per bookie. Lage ROI/CLV op een specifieke bookie kan duiden op slechte odds-shopping of late line movement.',
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/market-thresholds — toon huidige adaptive MIN_EDGE per markt
app.get('/api/admin/v2/market-thresholds', requireAdmin, async (req, res) => {
  try {
    if (Date.now() - _marketSampleCache.at > MARKET_SAMPLE_TTL_MS) await refreshMarketSampleCounts();
    const baseMinEdge = 0.055;
    const totalSettled = Object.values(_marketSampleCache.data).reduce((a, b) => a + b, 0);
    const bootstrap = totalSettled < BOOTSTRAP_MIN_TOTAL_BETS;
    const tiers = Object.entries(_marketSampleCache.data).map(([key, n]) => {
      const tier = bootstrap ? 'BOOTSTRAP' : n >= 100 ? 'PROVEN' : n >= 30 ? 'EARLY' : 'UNPROVEN';
      const minEdge = bootstrap ? baseMinEdge : n >= 100 ? baseMinEdge : n >= 30 ? Math.max(baseMinEdge, 0.065) : Math.max(baseMinEdge, 0.08);
      return { key, n, tier, min_edge_pct: +(minEdge * 100).toFixed(1) };
    }).sort((a, b) => b.n - a.n);
    res.json({
      base_min_edge_pct: baseMinEdge * 100,
      bootstrap_active: bootstrap,
      total_settled: totalSettled,
      bootstrap_threshold: BOOTSTRAP_MIN_TOTAL_BETS,
      tiers,
      thresholds: { proven_min_n: 100, early_min_n: 30, unproven_min_edge_pct: 8.0, early_min_edge_pct: 6.5 },
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// POST /api/admin/v2/autotune-clv — run CLV-based signal weight tuning
app.post('/api/admin/v2/autotune-clv', requireAdmin, async (req, res) => {
  try {
    const result = await autoTuneSignalsByClv();
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/snapshot-counts — quick health check op v2 tabellen
app.get('/api/admin/v2/snapshot-counts', requireAdmin, async (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours) || 24));
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString();
    const tables = ['fixtures', 'odds_snapshots', 'feature_snapshots', 'market_consensus', 'model_runs', 'pick_candidates'];
    const counts = {};
    for (const t of tables) {
      // Eerst totaal
      const { count: total } = await supabase.from(t).select('*', { count: 'exact', head: true });
      // Dan recent
      const recentField = t === 'fixtures' ? 'created_at' : 'created_at';
      const { count: recent } = await supabase.from(t).select('*', { count: 'exact', head: true })
        .gte(t === 'odds_snapshots' || t === 'feature_snapshots' || t === 'market_consensus' || t === 'model_runs' ? 'captured_at' : 'created_at', sinceIso);
      counts[t] = { total: total || 0, recent: recent || 0 };
    }
    res.json({ hours, counts, sinceIso });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  }
});

app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers(true);
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const VALID_STATUSES = new Set(['pending', 'approved', 'blocked']);
    const VALID_ROLES = new Set(['user', 'admin']);
    if (req.body.status && !VALID_STATUSES.has(req.body.status)) return res.status(400).json({ error: 'Ongeldige status' });
    if (req.body.role && !VALID_ROLES.has(req.body.role)) return res.status(400).json({ error: 'Ongeldige rol' });
    if (req.body.status) user.status = req.body.status;
    if (req.body.role)   user.role   = req.body.role;
    await saveUser(user);
    if (req.body.status === 'approved') {
      tg(`✅ Account goedgekeurd: ${user.email}`).catch(() => {});
      sendEmail(user.email, 'Je EdgePickr account is goedgekeurd!',
        '<h2>Hey!</h2><p>Je account is goedgekeurd. Je kunt nu inloggen op <a href="https://edgepickr.com">https://edgepickr.com</a></p>'
      ).catch(() => {});
    }
    res.json({ id: user.id, email: user.email, role: user.role, status: user.status });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers(true);
    const user  = users.find(u => u.id === req.params.id);
    if (!user) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    if (user.email === req.user.email)
      return res.status(400).json({ error: 'Je kunt je eigen account niet verwijderen' });
    await supabase.from('users').delete().eq('id', req.params.id);
    _usersCache = null;
    res.json({ deleted: true });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── PUSH NOTIFICATIONS ─────────────────────────────────────────────────────
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (rateLimit('push:' + ip, 10, 60 * 60 * 1000)) return res.status(429).json({ error: 'Te veel verzoeken' });
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'Geen subscription' });
  await savePushSub(sub);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Geen endpoint' });
  await deletePushSub(endpoint);
  res.json({ ok: true });
});

// Prematch scan · SSE streaming (inclusief live check op moment van draaien)
app.post('/api/prematch', (req, res) => {
  if (scanRunning) return res.status(429).json({ error: 'Scan al bezig · wacht tot de huidige scan klaar is' });
  scanRunning = true;
  const isAdmin = req.user?.role === 'admin';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  // Non-admin: alleen voortgang tonen, geen model details
  let stepCount = 0;
  const emit = (data) => {
    if (!isAdmin && data.log) {
      stepCount++;
      // Stuur alleen voortgangspercentage
      const pct = Math.min(95, Math.round(stepCount * 1.5));
      res.write(`data: ${JSON.stringify({ progress: pct })}\n\n`);
      return;
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Zet preferred bookies VOOR de scan, zodat edge-evaluatie alleen op jouw bookies gebeurt.
  // bestFromArr filtert op deze lijst. Consensus/fair-prob blijft uit ALLE bookies (markt-truth).
  (async () => {
    try {
      const users = await loadUsers().catch(() => []);
      const me = users.find(u => u.id === req.user?.id) || users.find(u => u.role === 'admin');
      const prefs = me?.settings?.preferredBookies;
      setPreferredBookies(prefs);
      if (prefs?.length) emit({ log: `🏦 Edge-evaluatie op jouw bookies: ${prefs.join(', ')}` });
    } catch {}
    return runPrematch(emit);
  })()
    .then(async footballPicks => {
      // Also run basketball + hockey + baseball + NFL + handball (errors don't break the scan)
      emit({ log: '🏀🏒⚾🏈🤾 Multi-sport scans starten...' });
      const [nbaPicks, nhlPicks, mlbPicks, nflPicks, handballPicks] = await Promise.all([
        runBasketball(emit).catch(err => { emit({ log: `⚠️ Basketball scan mislukt: ${err.message}` }); return []; }),
        runHockey(emit).catch(err => { emit({ log: `⚠️ Hockey scan mislukt: ${err.message}` }); return []; }),
        runBaseball(emit).catch(err => { emit({ log: `⚠️ Baseball scan mislukt: ${err.message}` }); return []; }),
        runFootballUS(emit).catch(err => { emit({ log: `⚠️ NFL scan mislukt: ${err.message}` }); return []; }),
        runHandball(emit).catch(err => { emit({ log: `⚠️ Handball scan mislukt: ${err.message}` }); return []; }),
      ]);

      let allPicks = [...footballPicks, ...nbaPicks, ...nhlPicks, ...mlbPicks, ...nflPicks, ...handballPicks];

      // ── KILL-SWITCH ENFORCEMENT (v10.0.1) ─────────────────────────────
      // Filter picks die in een geblokkeerde markt vallen vóór ranking.
      const beforeKill = allPicks.length;
      const killedPicks = allPicks.filter(p => isMarketKilled(p.sport, p.label));
      allPicks = allPicks.filter(p => !isMarketKilled(p.sport, p.label));
      const killedCount = beforeKill - allPicks.length;
      if (killedCount > 0) {
        emit({ log: `🛑 Kill-switch: ${killedCount} pick(s) geblokkeerd op markt-CLV regels` });
        // Inbox notification met details
        try {
          const sample = killedPicks.slice(0, 3).map(p => `${p.match} (${p.label})`).join('; ');
          await supabase.from('notifications').insert({
            type: 'kill_switch',
            title: `🛑 ${killedCount} pick(s) geblokkeerd door kill-switch`,
            body: `${killedCount} potentiële picks vielen weg omdat de markt structureel negatieve CLV heeft.\nVoorbeelden: ${sample}${killedPicks.length > 3 ? ` (+${killedPicks.length - 3} meer)` : ''}`,
            read: false, user_id: null,
          });
        } catch { /* swallow */ }
      }

      // Sorteer op expectedEur (hoogste eerst)
      allPicks.sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0));

      // ── DIVERSIFICATION (v10.0.1) ─────────────────────────────────────
      // Reviewer: max 1 pick per match, max 2 per sport. Voorkomt over-exposure
      // op één wedstrijd (correlatierisico) en concentratie in 1 sport.
      const MAX_PICKS = 5;            // maximum (kan minder zijn als minder kandidaten)
      const MAX_PER_MATCH = 1;        // anti-correlatie
      const MAX_PER_SPORT = 2;        // anti-concentratie
      const seenMatches = new Map();  // match key → count
      const seenSports = new Map();   // sport → count
      const topPicks = [];
      const skippedReasons = { same_match: 0, same_sport_cap: 0 };
      for (const p of allPicks) {
        if (topPicks.length >= MAX_PICKS) break;
        const matchKey = (p.match || '').toLowerCase().trim();
        const sportKey = p.sport || 'unknown';
        if (matchKey && (seenMatches.get(matchKey) || 0) >= MAX_PER_MATCH) { skippedReasons.same_match++; continue; }
        if ((seenSports.get(sportKey) || 0) >= MAX_PER_SPORT) { skippedReasons.same_sport_cap++; continue; }
        topPicks.push(p);
        if (matchKey) seenMatches.set(matchKey, (seenMatches.get(matchKey) || 0) + 1);
        seenSports.set(sportKey, (seenSports.get(sportKey) || 0) + 1);
      }
      const droppedCount = allPicks.length - topPicks.length;

      emit({ log: `🌐 Totaal: ${footballPicks.length} voetbal + ${nbaPicks.length} basketball + ${nhlPicks.length} hockey + ${mlbPicks.length} baseball + ${nflPicks.length} NFL + ${handballPicks.length} handball = ${beforeKill} kandidaten` });
      if (skippedReasons.same_match) emit({ log: `🎯 ${skippedReasons.same_match} pick(s) geskipt: zelfde wedstrijd al in selectie (correlatie)` });
      if (skippedReasons.same_sport_cap) emit({ log: `🎯 ${skippedReasons.same_sport_cap} pick(s) geskipt: max ${MAX_PER_SPORT} per sport bereikt` });
      if (droppedCount > 0) emit({ log: `🎯 ${topPicks.length}/${MAX_PICKS} picks geselecteerd (${droppedCount} weggelaten door diversification + ranking)` });

      // Bevestigend signaal als selectie kleiner is dan max — geen alarmistische "geen edges":
      if (topPicks.length === 0) {
        emit({ log: `✋ Geen picks vandaag — ons systeem zag te weinig value. Dat is goed: niet elke dag is een edge-dag.` });
      } else if (topPicks.length <= 2) {
        emit({ log: `✋ ${topPicks.length} pick(s) — kwaliteit boven volume. Strenge filters hebben hun werk gedaan.` });
      }

      // Tag elke pick met selected=true/false zodat POTD/UI alleen uit selectie kiezen
      // maar audit/training het volledige lijstje heeft.
      const topSet = new Set(topPicks);
      for (const p of allPicks) p.selected = topSet.has(p);
      // Save ALL gerankede picks (incl. niet-geselecteerde) naar scan history voor audit
      saveScanEntry(allPicks, 'prematch', beforeKill);

      // 1 gecombineerd Telegram bericht met alle sport picks
      if (topPicks.length > 0) {
        const sportEmoji = { football: '⚽', basketball: '🏀', hockey: '🏒', baseball: '⚾', 'american-football': '🏈', handball: '🤾' };
        const todayLabel = new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' });
        let tgMsg = `🎯 EDGEPICKR DAILY SCAN\n📅 ${todayLabel}\n📊 ${allPicks.length} kandidaten uit 6 sporten\n✅ TOP ${topPicks.length} PICKS\n\n`;
        topPicks.forEach((p, i) => {
          const icon = sportEmoji[p.sport] || '🏆';
          const star = i === 0 ? '⭐' : i === 1 ? '🔵' : '•';
          tgMsg += `${star} ${icon} ${p.match}\n${p.league}\n📌 ${p.label}\n💰 Odds: ${p.odd} | ${p.units}\n📈 Kans: ${p.prob}%\n\n`;
        });
        tg(tgMsg).catch(() => {});
      } else {
        const todayLabel = new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: 'long', year: 'numeric' });
        tg(`🎯 EDGEPICKR DAILY SCAN\n📅 ${todayLabel}\n\n🚫 Geen picks met voldoende edge gevonden.`).catch(() => {});
      }

      // Non-admin: filter gevoelige model data uit picks
      const safePicks = topPicks.map(p => {
        // Score server-side berekenen (zodat kelly niet naar de client hoeft)
        const hk = p.kelly || 0;
        const score = Math.min(10, Math.max(5, Math.round((hk - 0.015) / 0.135 * 5) + 5));
        const pick = { match: p.match, league: p.league, label: p.label, odd: p.odd, prob: p.prob, units: p.units, edge: p.edge, score, kickoff: p.kickoff, scanType: p.scanType, bookie: p.bookie, sport: p.sport || 'football' };
        if (isAdmin) { pick.reason = p.reason; pick.kelly = p.kelly; pick.ep = p.ep; pick.strength = p.strength; pick.expectedEur = p.expectedEur; pick.signals = p.signals || []; }
        return pick;
      });
      emit({ done: true, picks: safePicks }); res.end(); scanRunning = false;
      setPreferredBookies(null); // reset scan-wide filter
    })
    .catch(err  => { emit({ error: 'Scan mislukt' }); res.end(); scanRunning = false; setPreferredBookies(null); });
});

// Live scan · SSE streaming
app.post('/api/live', (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
  if (rateLimit('live:' + ip, 5, 10 * 60 * 1000)) return res.status(429).json({ error: 'Te veel live scans · wacht even' });
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const emit = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  runLive(emit)
    .then(picks => { emit({ done: true, picks: picks.map(p => ({ match: p.match, league: p.league, label: p.label, odd: p.odds||p.odd, prob: p.prob, units: p.units, reason: p.reason })) }); res.end(); })
    .catch(err  => { console.error('Live scan fout:', err.message); emit({ error: 'Live scan mislukt' }); res.end(); });
});

// Bets ophalen
app.get('/api/bets', async (req, res) => {
  try {
    // Admin can see all data with ?all=true
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const { bets, _raw } = await readBets(userId);
    // Gebruik user-specifieke instellingen voor stats
    const users = await loadUsers().catch(() => []);
    const user  = users.find(u => u.id === req.user?.id);
    const sb = user?.settings?.startBankroll ?? START_BANKROLL;
    const ue = user?.settings?.unitEur       ?? UNIT_EUR;
    res.json({ bets, stats: calcStats(bets, sb, ue), _raw });
  }
  catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Correlated bets · groepen open bets op dezelfde wedstrijd
app.get('/api/bets/correlations', async (req, res) => {
  try {
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const { bets } = await readBets(userId);
    const openBets = bets.filter(b => b.uitkomst === 'Open');
    const groups = {};
    openBets.forEach(b => {
      const key = b.wedstrijd.toLowerCase().trim();
      if (!groups[key]) groups[key] = [];
      groups[key].push(b);
    });
    const correlated = Object.entries(groups)
      .filter(([_, g]) => g.length > 1)
      .map(([match, g]) => ({
        match,
        bets: g.map(b => ({ id: b.id, markt: b.markt, odds: b.odds, units: b.units })),
        totalExposure: g.reduce((s, b) => s + b.inzet, 0),
        warning: `${g.length} bets op dezelfde wedstrijd · gecorreleerd risico €${g.reduce((s,b) => s + b.inzet, 0).toFixed(2)}`
      }));
    res.json({ correlations: correlated });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Bet toevoegen
// ── PRE-KICKOFF CHECK · 30 min voor aftrap ───────────────────────────────────
// Haalt huidige odds op voor het specifieke event en vergelijkt met gelogde odds.
// Stuurt Telegram ping als: odds gedrift >8%, of als aftrap veranderd is.
// ── SPORT-AWARE API HELPERS ──────────────────────────────────────────────────
// normalizeSport() komt uit lib/model-math.js

function getSportApiConfig(sport) {
  sport = normalizeSport(sport);
  const configs = {
    football:          { host: 'v3.football.api-sports.io', fixturesPath: '/fixtures', oddsPath: '/odds', fixtureParam: 'fixture', gameParam: 'fixture' },
    basketball:        { host: 'v1.basketball.api-sports.io', fixturesPath: '/games', oddsPath: '/odds', fixtureParam: 'game', gameParam: 'game' },
    hockey:            { host: 'v1.hockey.api-sports.io', fixturesPath: '/games', oddsPath: '/odds', fixtureParam: 'game', gameParam: 'game' },
    baseball:          { host: 'v1.baseball.api-sports.io', fixturesPath: '/games', oddsPath: '/odds', fixtureParam: 'game', gameParam: 'game' },
    'american-football':{ host: 'v1.american-football.api-sports.io', fixturesPath: '/games', oddsPath: '/odds', fixtureParam: 'game', gameParam: 'game' },
    handball:          { host: 'v1.handball.api-sports.io', fixturesPath: '/games', oddsPath: '/odds', fixtureParam: 'game', gameParam: 'game' },
  };
  return configs[sport] || configs.football;
}

// normalizeTeamName() en teamMatchScore() komen uit lib/model-math.js

// Zoek fixture/game ID op teamnamen voor elke sport
// Zoekt over gisteren + vandaag + morgen (Amsterdam-tz) zodat nachtwedstrijden
// (NHL/NBA 01:00-04:00) die onder een Amerikaanse datum vallen ook gevonden worden.
async function findGameId(sport, matchName) {
  sport = normalizeSport(sport);
  const cfg = getSportApiConfig(sport);
  const parts = (matchName || '').split(' vs ').map(s => s.trim());
  if (parts.length < 2) return null;
  const [qHome, qAway] = parts;

  // Bouw date-range: gisteren, vandaag, morgen in Europe/Amsterdam (sv-SE = yyyy-mm-dd)
  const now = Date.now();
  const dates = [-1, 0, 1].map(offset => {
    const d = new Date(now + offset * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  });

  // Haal fixtures op per datum en dedupe op id
  const seen = new Set();
  const list = [];
  for (const date of dates) {
    const games = await afGet(cfg.host, cfg.fixturesPath, { date }).catch(() => []);
    for (const g of (games || [])) {
      const gid = sport === 'football' ? g.fixture?.id : g.id;
      if (gid == null || seen.has(gid)) continue;
      seen.add(gid);
      list.push(g);
    }
  }

  // Scoor elke game en kies de beste; hou de top-3 bij voor debug
  let best = null, bestScore = 0;
  const scored = [];
  for (const g of list) {
    const home = g.teams?.home?.name || '';
    const away = g.teams?.away?.name || '';
    const sHome = teamMatchScore(home, qHome);
    const sAway = teamMatchScore(away, qAway);
    const score = sHome + sAway;
    scored.push({ home, away, score });
    // Minimum: beide teams moeten enige match hebben (geen 0)
    if (sHome > 0 && sAway > 0 && score > bestScore) {
      best = g; bestScore = score;
    }
  }

  if (!best || bestScore < 50) {
    const top3 = scored.sort((a, b) => b.score - a.score).slice(0, 3);
    console.warn(`[findGameId] geen match voor "${matchName}" sport=${sport}, ${list.length} fixtures, top3: ${top3.map(x => `${x.home} vs ${x.away} (${x.score})`).join(' | ')}`);
    return null;
  }
  // Football: match.fixture.id, other sports: match.id
  return sport === 'football' ? best.fixture?.id : best.id;
}

// Verbose variant voor diagnostiek: geeft fxId + fixturesFetched + topCandidates terug
// Optie: anchorDate (YYYY-MM-DD) + window (dagen terug/vooruit). Default: gisteren/vandaag/morgen.
async function findGameIdVerbose(sport, matchName, anchorDate = null, windowDays = [-1, 0, 1]) {
  sport = normalizeSport(sport);
  const cfg = getSportApiConfig(sport);
  const parts = (matchName || '').split(' vs ').map(s => s.trim());
  const out = { fxId: null, host: cfg.host, fixturesFetched: {}, topCandidates: [], threshold: 50, error: null, anyTextMatch: [] };
  if (parts.length < 2) { out.error = 'matchName kon niet gesplitst worden op " vs "'; return out; }
  const [qHome, qAway] = parts;

  const anchor = anchorDate ? new Date(anchorDate + 'T12:00:00Z').getTime() : Date.now();
  const dates = windowDays.map(offset => {
    const d = new Date(anchor + offset * 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  });

  const seen = new Set();
  const list = [];
  for (const date of dates) {
    const games = await afGet(cfg.host, cfg.fixturesPath, { date }).catch(() => []);
    out.fixturesFetched[date] = (games || []).length;
    for (const g of (games || [])) {
      const gid = sport === 'football' ? g.fixture?.id : g.id;
      if (gid == null || seen.has(gid)) continue;
      seen.add(gid);
      list.push(g);
    }
  }

  let best = null, bestScore = 0;
  const scored = [];
  for (const g of list) {
    const home = g.teams?.home?.name || '';
    const away = g.teams?.away?.name || '';
    const sHome = teamMatchScore(home, qHome);
    const sAway = teamMatchScore(away, qAway);
    const score = sHome + sAway;
    scored.push({ home, away, sHome, sAway, score });
    if (sHome > 0 && sAway > 0 && score > bestScore) { best = g; bestScore = score; }
  }
  out.topCandidates = scored.sort((a, b) => b.score - a.score).slice(0, 5);
  out.bestScore = bestScore;
  // Zuivere text-search als fallback: zoek de query-termen in alle ruwe teamnamen
  const qHomeLow = (qHome || '').toLowerCase();
  const qAwayLow = (qAway || '').toLowerCase();
  out.anyTextMatch = list.filter(g => {
    const h = (g.teams?.home?.name || '').toLowerCase();
    const a = (g.teams?.away?.name || '').toLowerCase();
    return (qHomeLow && (h.includes(qHomeLow) || a.includes(qHomeLow))) ||
           (qAwayLow && (h.includes(qAwayLow) || a.includes(qAwayLow)));
  }).slice(0, 5).map(g => ({ home: g.teams?.home?.name, away: g.teams?.away?.name, date: g.fixture?.date || g.date,
                              id: sport === 'football' ? g.fixture?.id : g.id }));
  if (best && bestScore >= 50) {
    out.fxId = sport === 'football' ? best.fixture?.id : best.id;
  }
  return out;
}

// Haal odds op voor elke sport en match elke markt
async function fetchCurrentOdds(sport, gameId, markt, bookmaker, opts = {}) {
  if (!gameId) return null;
  const cfg = getSportApiConfig(sport);
  const oddsData = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: gameId }).catch(() => []);
  const rawBks = oddsData?.[0]?.bookmakers || [];
  const userBk = (bookmaker || '').toLowerCase();
  const strictBookie = opts.strictBookie === true;
  let bk = userBk ? rawBks.find(b => b.name?.toLowerCase().includes(userBk)) : null;
  if (!bk && !strictBookie) {
    bk = rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
  }
  if (!bk) return null;

  const m = markt.toLowerCase();
  let val = null;

  // Over/Under (alle sporten: goals, punten, runs)
  const overMatch = m.match(/over\s*(\d+\.?\d*)/);
  const underMatch = m.match(/under\s*(\d+\.?\d*)/);
  if (overMatch || underMatch) {
    const ou = bk.bets?.find(b => b.id === 5 || (b.name||'').toLowerCase().includes('over'));
    if (ou) {
      const isOver = !!overMatch;
      const line = (overMatch || underMatch)[1];
      val = ou.values?.find(v => v.value === `${isOver ? 'Over' : 'Under'} ${line}`);
    }
  }
  // 3-weg 60-min markt (hockey/handbal regulation): zoek bet met 3 Home/Draw/Away values
  else if (m.includes('60-min') || m.includes('60 min') || m.includes('🕐')) {
    const isDraw = m.includes('gelijkspel') || m.includes('draw');
    const isHome = !isDraw && (m.includes('🏠') || !m.includes('✈️'));
    const target = isDraw ? 'Draw' : isHome ? 'Home' : 'Away';
    for (const bet of (bk.bets || [])) {
      const v3 = (bet.values || []).filter(x => ['Home','Draw','Away'].includes(String(x.value ?? '').trim()));
      if (v3.length === 3 && bet.id !== 1) {
        val = v3.find(x => String(x.value ?? '').trim() === target);
        if (val) break;
      }
    }
  }
  // Moneyline / Match Winner
  else if (m.includes('wint') || m.includes('winner') || m.includes('moneyline') || m.includes('🏠') || m.includes('✈️')) {
    const mw = bk.bets?.find(b => b.id === 1 || (b.name||'').toLowerCase().includes('winner') || (b.name||'').toLowerCase().includes('money'));
    if (mw) {
      const isHome = m.includes('🏠') || !m.includes('✈️');
      val = mw.values?.find(v => v.value === (isHome ? 'Home' : 'Away'));
    }
  }
  // BTTS (voetbal + handball)
  else if (m.includes('btts') || m.includes('beide')) {
    const btts = bk.bets?.find(b => b.id === 8 || (b.name||'').toLowerCase().includes('both'));
    if (btts) {
      const isNo = m.includes('nee') || m.includes('no') || m.includes('🛡️');
      val = btts.values?.find(v => v.value === (isNo ? 'No' : 'Yes'));
    }
  }
  // Spread / Handicap / Run Line / Puck Line
  else if (m.includes('spread') || m.includes('handicap') || m.includes('line') || m.includes('puck')) {
    const sp = bk.bets?.find(b => (b.name||'').toLowerCase().includes('spread') || (b.name||'').toLowerCase().includes('handicap') || (b.name||'').toLowerCase().includes('line'));
    if (sp) {
      const lineMatch = m.match(/([+-]?\d+\.?\d*)/);
      if (lineMatch) val = sp.values?.find(v => v.value?.includes(lineMatch[1]));
    }
  }
  // Gelijkspel / Draw
  else if (m.includes('gelijkspel') || m.includes('draw')) {
    const mw = bk.bets?.find(b => b.id === 1);
    if (mw) val = mw.values?.find(v => v.value === 'Draw');
  }
  // DNB
  else if (m.includes('draw no bet') || m.includes('dnb')) {
    const dnb = bk.bets?.find(b => b.id === 12 || (b.name||'').toLowerCase().includes('draw no bet'));
    if (dnb) {
      const isHome = m.includes('🏠') || !m.includes('✈️');
      val = dnb.values?.find(v => v.value === (isHome ? 'Home' : 'Away'));
    }
  }
  // NRFI / YRFI (baseball)
  else if (m.includes('nrfi') || m.includes('yrfi') || m.includes('no run first') || m.includes('no run 1st') || m.includes('yes run first') || m.includes('yes run 1st')) {
    const nrfi = bk.bets?.find(b => (b.name||'').toLowerCase().includes('1st inning') || (b.name||'').toLowerCase().includes('nrfi'));
    if (nrfi) {
      const isNRFI = m.includes('nrfi') || m.includes('no run');
      val = nrfi.values?.find(v => v.value === (isNRFI ? 'No' : 'Yes')) || nrfi.values?.[0];
    }
  }
  // 1st Half / 1st Period Over/Under
  else if ((m.includes('1h ') || m.includes('1st half') || m.includes('p1 ') || m.includes('1st period')) && (m.includes('over') || m.includes('under'))) {
    const isOver = m.includes('over');
    const lineMatch = m.match(/(?:over|under)\s*(\d+\.?\d*)/i);
    const halfBet = bk.bets?.find(b => {
      const bn = (b.name||'').toLowerCase();
      return (bn.includes('1st half') || bn.includes('first half') || bn.includes('1st period') || bn.includes('first period')) && (bn.includes('over') || bn.includes('total'));
    });
    if (halfBet && lineMatch) {
      val = halfBet.values?.find(v => v.value === `${isOver ? 'Over' : 'Under'} ${lineMatch[1]}`);
    }
  }
  // 1st Half / 1st Period Spread
  else if ((m.includes('1h ') || m.includes('1st half') || m.includes('p1 ') || m.includes('1st period')) && (m.includes('spread') || m.match(/[+-]\d/))) {
    const halfSpBet = bk.bets?.find(b => {
      const bn = (b.name||'').toLowerCase();
      return (bn.includes('1st half') || bn.includes('first half') || bn.includes('1st period') || bn.includes('first period')) && (bn.includes('spread') || bn.includes('handicap'));
    });
    if (halfSpBet) {
      const lineMatch = m.match(/([+-]?\d+\.?\d*)/);
      if (lineMatch) val = halfSpBet.values?.find(v => v.value?.includes(lineMatch[1]));
    }
  }
  // Odd/Even total
  else if (m.includes('odd total') || m.includes('even total') || m.includes('odd/even') || m.includes('🎲')) {
    const oeBet = bk.bets?.find(b => (b.name||'').toLowerCase().includes('odd') && (b.name||'').toLowerCase().includes('even'));
    if (oeBet) {
      const isOdd = m.includes('odd');
      val = oeBet.values?.find(v => v.value?.toLowerCase() === (isOdd ? 'odd' : 'even'));
    }
  }

  return val ? parseFloat(val.odd) || null : null;
}

async function schedulePreKickoffCheck(bet) {
  // Live bets zijn al bezig · geen pre-kickoff check nodig
  if (bet.scanType === 'live') return;

  // Probeer aftrap-tijdstip uit de bet te halen (veld 'datum' = datum, 'tijd' = HH:MM)
  const tijdStr = bet.tijd || bet.time; // "HH:MM" of ISO
  if (!tijdStr) return;

  let kickoffMs;
  try {
    if (tijdStr.includes('T') || tijdStr.includes('-')) {
      kickoffMs = new Date(tijdStr).getTime();
    } else {
      // "HH:MM" in Amsterdam-tijd · converteer naar UTC
      const [h, m] = tijdStr.split(':').map(Number);
      const nowAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
      // Maak een ISO-string in Amsterdam-tijd en parse die correct
      const amsIso = `${nowAms}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
      // Bereken offset: verschil tussen UTC en Amsterdam
      const probe = new Date();
      const utcH = probe.getUTCHours();
      const amsH = parseInt(probe.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
      const offsetMs = (amsH - utcH) * 3600000;
      // Kickoff in UTC = Amsterdam-tijd minus offset
      const d = new Date(new Date(amsIso + 'Z').getTime() - offsetMs);
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

      // Haal huidige odds op via de juiste sport API
      const betSport = bet.sport || 'football';
      let currentOdds = null;
      try {
        const fxId = bet.fixtureId || await findGameId(betSport, matchName);
        currentOdds = await fetchCurrentOdds(betSport, fxId, markt, bet.tip);
      } catch {}

      // Beoordeling
      const time30 = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone:'Europe/Amsterdam' });
      lines.push(`⏰ PRE-KICKOFF CHECK\n📌 ${matchName} (aftrap ~${time30})\n🎲 Markt: ${markt}`);

      if (currentOdds) {
        const drift = (currentOdds - loggedOdds) / loggedOdds;
        const driftPct = (drift * 100).toFixed(1);
        const driftStr = drift >= 0 ? `+${driftPct}%` : `${driftPct}%`;

        if (Math.abs(drift) >= 0.08) {
          lines.push(`\n⚠️ ODDS GEDRIFT: ${loggedOdds} → ${currentOdds} (${driftStr})`);
          if (drift > 0.08) lines.push(`📈 Odds gestegen · markt twijfelt aan jouw kant. Overweeg cashout of annuleren.`);
          else lines.push(`📉 Odds gedaald · markt bevestigt jouw kant. Bet ziet er goed uit.`);
        } else {
          lines.push(`\n✅ Odds stabiel: ${loggedOdds} → ${currentOdds} (${driftStr}) · geen significante marktbeweging.`);
        }
      } else {
        lines.push(`\n⚠️ Kon geen huidige odds ophalen · controleer odds handmatig.`);
        logCheckFailure('prematch', matchName, 'controleer handmatig').catch(() => {});
      }

      lines.push(`\n🟢 Succes! (automatische check 30 min voor aftrap)`);
      await tg(lines.join('\n'));
    } catch (err) {
      console.error('Pre-kickoff check error:', err.message);
    }
  }, delayMs);

  console.log(`⏱  Pre-kickoff check gepland voor "${bet.wedstrijd}" over ${Math.round(delayMs/60000)} min`);
}

// ── CLV CHECK · 2 min voor aftrap ─────────────────────────────────────────
// Haalt slotlijn-odds op vlak voor kickoff en berekent CLV%.
async function scheduleCLVCheck(bet) {
  if (bet.scanType === 'live') return;

  const tijdStr = bet.tijd || bet.time;
  if (!tijdStr) return;

  let kickoffMs;
  try {
    if (tijdStr.includes('T') || tijdStr.includes('-')) {
      kickoffMs = new Date(tijdStr).getTime();
    } else {
      const [h, m] = tijdStr.split(':').map(Number);
      const nowAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
      const amsIso = `${nowAms}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
      const probe = new Date();
      const utcH = probe.getUTCHours();
      const amsH = parseInt(probe.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
      const offsetMs = (amsH - utcH) * 3600000;
      const d = new Date(new Date(amsIso + 'Z').getTime() - offsetMs);
      if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
      kickoffMs = d.getTime();
    }
  } catch { return; }

  const checkMs = kickoffMs - 2 * 60 * 1000; // 2 min voor aftrap
  const delayMs = checkMs - Date.now();
  if (delayMs < 3000 || delayMs > 48 * 60 * 60 * 1000) return;

  setTimeout(async () => {
    try {
      const loggedOdds = parseFloat(bet.odds);
      const matchName  = bet.wedstrijd || '';
      const markt      = bet.markt || '';

      // Gebruik sport-aware helpers voor alle sport APIs
      const betSport = bet.sport || 'football';
      const fxId = bet.fixtureId || await findGameId(betSport, matchName);
      const closingOdds = await fetchCurrentOdds(betSport, fxId, markt, bet.tip, { strictBookie: true });
      const usedBookie = bet.tip || 'Bet365';

      if (!closingOdds) {
        // 1x retry over 5 min als eerste poging faalt
        if (!bet._clvRetried) {
          bet._clvRetried = true;
          setTimeout(() => {
            scheduleCLVCheck({ ...bet, tijd: new Date(Date.now() + 3 * 60000).toISOString() });
          }, 5 * 60000);
          console.log(`[CLV] retry gepland over 5 min voor "${matchName}"`);
          return;
        }
        logCheckFailure('clv', matchName, 'closing odds niet beschikbaar').catch(() => {});
        return;
      }

      const clvPct = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
      const clvIcon = clvPct > 0 ? '✅' : '❌';

      // Schrijf CLV naar Supabase
      await supabase.from('bets').update({ clv_odds: closingOdds, clv_pct: clvPct }).eq('bet_id', bet.id);

      await tg(`📊 CLV: ${matchName}\n🏦 ${usedBookie} | Gelogd: ${loggedOdds} → Slotlijn: ${closingOdds} | CLV: ${clvPct > 0 ? '+' : ''}${clvPct}% ${clvIcon}`).catch(() => {});
    } catch (err) {
      console.error('CLV check error:', err.message);
    }
  }, delayMs);

  console.log(`📊 CLV check gepland voor "${bet.wedstrijd}" over ${Math.round(delayMs/60000)} min (2 min voor aftrap)`);
}

app.post('/api/bets', async (req, res) => {
  try {
    const userId = req.user?.id;
    const body = req.body || {};
    // Input validation
    if (!body.wedstrijd || typeof body.wedstrijd !== 'string') return res.status(400).json({ error: 'Wedstrijd is verplicht' });
    if (!body.markt || typeof body.markt !== 'string') return res.status(400).json({ error: 'Markt is verplicht' });
    const odds = parseFloat(body.odds);
    if (isNaN(odds) || odds <= 1.0) return res.status(400).json({ error: 'Odds moeten hoger zijn dan 1.0' });
    const units = parseFloat(body.units);
    if (isNaN(units) || units <= 0) return res.status(400).json({ error: 'Units moeten hoger zijn dan 0' });
    const VALID_OUTCOMES = new Set(['Open', 'W', 'L']);
    if (body.uitkomst && !VALID_OUTCOMES.has(body.uitkomst)) return res.status(400).json({ error: 'Uitkomst moet Open, W of L zijn' });
    // Fix datum for late-night/early-morning kickoffs (00:00-09:59)
    // If tijd is between 00:00 and 09:59 and datum is today, change datum to tomorrow
    if (body.datum && body.tijd) {
      const tijdH = parseInt(body.tijd.split(':')[0]);
      if (!isNaN(tijdH) && tijdH >= 0 && tijdH < 10) {
        const todayAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
        // Parse datum (DD-MM-YYYY format)
        const datumParts = body.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (datumParts) {
          const datumISO = `${datumParts[3]}-${datumParts[2]}-${datumParts[1]}`;
          if (datumISO === todayAms) {
            const tomorrowAms = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
            const [y, m, d] = tomorrowAms.split('-');
            body.datum = `${d}-${m}-${y}`;
          }
        }
      }
    }

    const { bets } = await readBets(userId);
    const nextId = bets.length > 0 ? Math.max(...bets.map(b => b.id)) + 1 : 1;
    const newBet = { ...body, id: nextId, odds, units, uitkomst: body.uitkomst || 'Open' };
    await writeBet(newBet, userId);
    schedulePreKickoffCheck(newBet).catch(() => {}); // niet-blokkerend
    scheduleCLVCheck(newBet).catch(() => {}); // niet-blokkerend
    const result = await readBets(userId);
    // Check for correlated bets on the same match
    const newMatch = (newBet.wedstrijd || '').toLowerCase().trim();
    if (newMatch) {
      const openOnSame = result.bets.filter(b =>
        b.uitkomst === 'Open' && b.id !== nextId &&
        b.wedstrijd.toLowerCase().trim() === newMatch
      );
      if (openOnSame.length > 0) {
        const allOnMatch = [newBet, ...openOnSame];
        const totalExposure = allOnMatch.reduce((s, b) => s + (b.inzet || (b.units || 0) * 10), 0);
        result.correlationWarning = {
          match: newBet.wedstrijd,
          count: allOnMatch.length,
          bets: allOnMatch.map(b => ({ id: b.id, markt: b.markt || '', odds: b.odds || b.odd || 0 })),
          totalExposure,
          message: `${allOnMatch.length} bets op ${newBet.wedstrijd} · gecorreleerd risico €${totalExposure.toFixed(2)}`
        };
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Uitkomst / bet-velden updaten
app.put('/api/bets/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { uitkomst, odds, units, tip, sport } = req.body || {};
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });
    if (uitkomst && !['Open', 'W', 'L'].includes(uitkomst)) return res.status(400).json({ error: 'Uitkomst moet Open, W of L zijn' });
    const updates = {};
    if (odds != null) updates.odds = parseFloat(odds);
    if (units != null) { updates.units = parseFloat(units); updates.inzet = +(parseFloat(units) * UNIT_EUR).toFixed(2); }
    if (tip) updates.tip = tip;
    if (sport) updates.sport = sport;
    if (Object.keys(updates).length) {
      let updateQuery = supabase.from('bets').update(updates).eq('bet_id', id);
      if (userId) updateQuery = updateQuery.eq('user_id', userId);
      await updateQuery;
    }
    if (uitkomst) {
      // Uitkomst in dezelfde request: updateBetOutcome herberekent wl
      await updateBetOutcome(id, uitkomst, userId);
    } else if (odds != null || units != null) {
      // Odds of units aangepast zonder nieuwe uitkomst: als bet al settled is, wl herberekenen
      // zodat bankroll/ROI consistent blijft. Voorkomt stale wl-waarden op historische bets.
      let readQ = supabase.from('bets').select('*').eq('bet_id', id);
      if (userId) readQ = readQ.eq('user_id', userId);
      const { data: row } = await readQ.single();
      if (row && (row.uitkomst === 'W' || row.uitkomst === 'L')) {
        const newInzet = row.inzet != null ? row.inzet : +((row.units || 0) * UNIT_EUR).toFixed(2);
        const newWl = row.uitkomst === 'W'
          ? +((row.odds - 1) * newInzet).toFixed(2)
          : +(-newInzet).toFixed(2);
        let wlQ = supabase.from('bets').update({ wl: newWl }).eq('bet_id', id);
        if (userId) wlQ = wlQ.eq('user_id', userId);
        await wlQ;
      }
    }
    res.json(await readBets(userId));
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// W/L herberekenen voor alle settled bets (fix na inzet-bug)
app.post('/api/bets/recalculate', requireAdmin, async (req, res) => {
  try {
    let fixed = 0;
    // Admin recalculate: filter by user unless ?all=true
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    let settledQuery = supabase.from('bets').select('*').in('uitkomst', ['W', 'L']);
    if (userId) settledQuery = settledQuery.eq('user_id', userId);
    const { data: settledBets } = await settledQuery;
    for (const bet of (settledBets || [])) {
      const inzet = bet.inzet || +(bet.units * UNIT_EUR).toFixed(2);
      const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2) : +(-inzet).toFixed(2);
      if (Math.abs((bet.wl || 0) - wl) >= 0.01) {
        await supabase.from('bets').update({ wl }).eq('bet_id', bet.bet_id);
        fixed++;
      }
    }
    const { bets } = await readBets(userId);
    const users = await loadUsers().catch(() => []);
    const user  = users.find(u => u.id === req.user?.id);
    const sb = user?.settings?.startBankroll ?? START_BANKROLL;
    const ue = user?.settings?.unitEur       ?? UNIT_EUR;
    res.json({ fixed, bets, stats: calcStats(bets, sb, ue) });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// CLV backfill · admin-only · vul clv_odds + clv_pct voor bets die het missen
// Nuttig na API-outages of voor oudere bets waar de scheduled check faalde.
// POST /api/clv/backfill  (optioneel body: { all: true } → ook andere users in admin-mode)
app.post('/api/clv/backfill', requireAdmin, async (req, res) => {
  try {
    const all = req.body?.all === true;
    const userId = (!all && req.user?.id) ? req.user.id : null;

    // Haal bets op met lege CLV
    let q = supabase.from('bets').select('*').is('clv_pct', null);
    if (userId) q = q.eq('user_id', userId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    // Filter: alleen settled OF kickoff in verleden (pre-match heeft dan meestal closing odds)
    const nowMs = Date.now();
    const candidates = (data || []).filter(r => {
      if (r.uitkomst && r.uitkomst !== 'Open') return true;
      // kickoff voorbij? parse tijd + datum
      if (r.datum && r.tijd) {
        const m = r.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (m) {
          const iso = `${m[3]}-${m[2]}-${m[1]}T${r.tijd}:00`;
          const ms = Date.parse(iso);
          if (!isNaN(ms) && ms < nowMs) return true;
        }
      }
      return false;
    });

    const details = [];
    let filled = 0, failed = 0;
    for (const r of candidates) {
      const id = r.bet_id;
      const wedstrijd = r.wedstrijd || '';
      const sport = r.sport || 'football';
      const markt = r.markt || '';
      const loggedOdds = parseFloat(r.odds);
      try {
        let fxId = r.fixture_id;
        let verbose = null;
        if (!fxId) {
          let anchorDate = null;
          const dm = (r.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (dm) anchorDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
          verbose = await findGameIdVerbose(sport, wedstrijd, anchorDate, [-3, -2, -1, 0, 1]);
          fxId = verbose.fxId;
          if (fxId) {
            try { await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', id); } catch {}
          }
        }
        if (!fxId) {
          failed++;
          details.push({ id, wedstrijd, sport, reason: 'fixture niet gevonden',
                         fixturesFetched: verbose?.fixturesFetched, topCandidates: verbose?.topCandidates,
                         bestScore: verbose?.bestScore, host: verbose?.host });
          await new Promise(rs => setTimeout(rs, 200));
          continue;
        }
        const closingOdds = await fetchCurrentOdds(sport, fxId, markt, r.tip, { strictBookie: true });
        if (!closingOdds || !loggedOdds) {
          failed++;
          details.push({ id, wedstrijd, sport, fxId, bookie: r.tip,
                         reason: `closing odds niet beschikbaar voor bookie "${r.tip}"` });
          await new Promise(rs => setTimeout(rs, 200));
          continue;
        }
        const clvPct = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
        await supabase.from('bets').update({ clv_odds: closingOdds, clv_pct: clvPct }).eq('bet_id', id);
        filled++;
        details.push({ id, wedstrijd, sport, clvPct });

        // Notificatie per succesvolle backfill
        const icon = clvPct > 0 ? '✅' : '❌';
        await supabase.from('notifications').insert({
          type: 'clv_backfill',
          title: `CLV ingevuld: ${wedstrijd}`.slice(0, 100),
          body: `${icon} ${wedstrijd} · ${loggedOdds} → ${closingOdds} · CLV ${clvPct > 0 ? '+' : ''}${clvPct}%`.slice(0, 200),
          read: false,
          user_id: r.user_id || null,
        }).catch(() => {});
      } catch (e) {
        failed++;
        details.push({ id, wedstrijd, reason: (e && e.message) || 'error' });
      }
      // Rate limit: 200ms per bet om API budget te sparen
      await new Promise(rs => setTimeout(rs, 200));
    }

    res.json({ scanned: candidates.length, filled, failed, details,
               rateLimit: { remaining: afRateLimit.remaining, limit: afRateLimit.limit,
                            callsToday: afRateLimit.callsToday, perSport: sportRateLimits } });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  }
});

// GET /api/debug/odds?sport=hockey&date=YYYY-MM-DD&team=Vegas
// Dumpt raw api-sports odds response voor één matchen om 3-way detectie te verifiëren
app.get('/api/debug/odds', requireAdmin, async (req, res) => {
  try {
    const sport = normalizeSport(req.query.sport || 'hockey');
    const windowDays = req.query.wide === '1' ? [-2,-1,0,1] : [-1,0,1];
    const team = (req.query.team || '').toLowerCase();
    const cfg = getSportApiConfig(sport);
    const datesFromParam = req.query.date ? [req.query.date] : windowDays.map(o => {
      const d = new Date(Date.now() + o * 86400000);
      return d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    });
    let allGames = [];
    const fetchedPerDate = {};
    for (const date of datesFromParam) {
      const games = await afGet(cfg.host, cfg.fixturesPath, { date }).catch(err => { console.error('debug odds fixtures fout', err); return []; });
      fetchedPerDate[date] = (games || []).length;
      for (const g of (games || [])) allGames.push(g);
    }
    const matches = allGames.filter(g => {
      const h = (g.teams?.home?.name || '').toLowerCase();
      const a = (g.teams?.away?.name || '').toLowerCase();
      return !team || h.includes(team) || a.includes(team);
    }).slice(0, 5);
    const out = [];
    for (const g of matches) {
      const id = sport === 'football' ? g.fixture?.id : g.id;
      if (!id) continue;
      const odds = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: id }).catch(err => { console.error('debug odds fout', err); return []; });
      const first = Array.isArray(odds) ? odds[0] : odds;
      const rawBookmakers = first?.bookmakers || [];
      const bookmakers = rawBookmakers.map(bk => ({
        bookie: bk?.name || 'unknown',
        bets: (bk?.bets || []).map(b => {
          const vals = Array.isArray(b?.values) ? b.values : [];
          return {
            id: b?.id, name: b?.name,
            values: vals.map(v => ({ value: v?.value, odd: v?.odd })),
            valueCount: vals.length,
            is3Way: vals.filter(v => ['Home','Draw','Away','1','X','2'].includes(String(v?.value ?? '').trim())).length === 3,
          };
        }),
      }));
      out.push({ id, home: g.teams?.home?.name, away: g.teams?.away?.name, bookmakers });
    }
    res.json({ sport, datesSearched: datesFromParam, fetchedPerDate, matchesFound: matches.length, matches: out });
  } catch (e) {
    console.error('debug/odds fout:', e);
    res.status(500).json({ error: (e && e.message) || 'Interne fout', stack: (e && e.stack) || null });
  }
});

// GET /api/clv/backfill/probe?bet_id=X  — dry-run diagnose voor één bet
app.get('/api/clv/backfill/probe', requireAdmin, async (req, res) => {
  try {
    const betId = parseInt(req.query.bet_id);
    if (!betId) return res.status(400).json({ error: 'bet_id is verplicht' });
    const { data, error } = await supabase.from('bets').select('*').eq('bet_id', betId).single();
    if (error || !data) return res.status(404).json({ error: 'bet niet gevonden' });
    const sport = data.sport || 'football';
    const wedstrijd = data.wedstrijd || '';
    const markt = data.markt || '';
    const loggedOdds = parseFloat(data.odds);
    // Anchor op bet.datum (formaat dd-mm-yyyy) zodat historische bets de juiste week doorzoeken
    let anchorDate = null;
    const dm = (data.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dm) anchorDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
    const windowDays = req.query.wide === '1' ? [-7, -6, -5, -4, -3, -2, -1, 0, 1] : [-1, 0, 1];
    const verbose = data.fixture_id
      ? { fxId: data.fixture_id, fixturesFetched: {}, topCandidates: [], bestScore: null, note: 'gebruikt opgeslagen fixture_id' }
      : await findGameIdVerbose(sport, wedstrijd, anchorDate, windowDays);
    verbose.anchorDate = anchorDate;
    verbose.windowDays = windowDays;
    let closingOdds = null, clvPct = null;
    if (verbose.fxId) {
      closingOdds = await fetchCurrentOdds(sport, verbose.fxId, markt, data.tip);
      if (closingOdds && loggedOdds) clvPct = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
    }
    res.json({ bet: { id: betId, wedstrijd, sport, markt, loggedOdds, tip: data.tip, fixture_id: data.fixture_id,
                      datum: data.datum, tijd: data.tijd },
               diagnose: verbose, closingOdds, clvPct,
               rateLimit: { remaining: afRateLimit.remaining, limit: afRateLimit.limit,
                            callsToday: afRateLimit.callsToday, perSport: sportRateLimits } });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  }
});

// Debug: settled bets data (voor bankroll diagnose)
app.get('/api/debug/wl', requireAdmin, async (req, res) => {
  try {
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const { bets } = await readBets(userId);
    const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    res.json({ settledCount: settled.length, bets: settled, stats: calcStats(bets) });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Bet verwijderen
app.delete('/api/bets/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });
    await deleteBet(id, userId);
    res.json(await readBets(userId));
  }
  catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Laatste picks ophalen (voor analyse tab)
app.get('/api/picks', (req, res) => {
  // SECURITY: same projection als /api/scan-history en /api/analyze.
  // Non-admin krijgt alleen public-safe veldset; geen reason/kelly/ep/strength/expectedEur/signals.
  const isAdmin = req.user?.role === 'admin';
  res.json({
    prematch: safePicksList(lastPrematchPicks, isAdmin),
    live:     safePicksList(lastLivePicks, isAdmin),
  });
});

// POTD (Pick of the Day) post generator voor Reddit + X
app.get('/api/potd', requireAdmin, async (req, res) => {
  try {
    let allPicks = [...lastPrematchPicks, ...lastLivePicks];
    // Fallback: laad uit scan history als geheugen leeg is (na deploy).
    // Filter op `selected: true` zodat we picks die door diversification zijn uitgesloten
    // niet alsnog als POTD pakken.
    if (!allPicks.length) {
      const history = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
      if (history.length) {
        const raw = history[0].picks || [];
        const selectedOnly = raw.filter(p => p.selected !== false); // ondersteun pre-v10.0.2 entries (undefined → keep)
        allPicks = selectedOnly.length ? selectedOnly : raw;
      }
    }
    if (!allPicks.length) return res.json({ error: 'Geen picks beschikbaar · draai eerst een scan' });

    // #1 pick = hoogste expectedEur uit toegestane (selected) picks
    const pick = [...allPicks].sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0))[0];

    // Record ophalen
    const userId = req.user?.id;
    const { bets, stats } = await readBets(userId);
    const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    const W = settled.filter(b => b.uitkomst === 'W').length;
    const L = settled.filter(b => b.uitkomst === 'L').length;
    const P = 0; // push/void
    const profitU = +(settled.reduce((s, b) => s + (b.wl || 0), 0) / UNIT_EUR).toFixed(1);
    const profitStr = profitU >= 0 ? `+${profitU}U` : `${profitU}U`;

    // Last 5
    const last5 = settled.slice(-5).map(b => b.uitkomst === 'W' ? '✅' : '❌').join('');
    const last5Short = settled.slice(-5).map(b => b.uitkomst === 'W' ? 'W' : 'L').join('-');

    // Laatste pick resultaat
    const lastBet = settled[settled.length - 1];
    const lastResult = lastBet
      ? `${lastBet.uitkomst === 'W' ? '✅' : '❌'} ${lastBet.wedstrijd} ${lastBet.uitkomst === 'W' ? '(W)' : '(L)'}`
      : 'Geen vorige pick';

    // Pick data
    const match = pick.match || '';
    const odds = pick.odd || pick.odds || 0;
    const units = pick.units || 0;
    const prob = pick.prob || 0;
    const edge = pick.edge || 0;
    const fairProb = prob;
    const impliedProb = odds > 1 ? (1 / odds * 100) : 0;
    const kickoff = pick.kickoff || '';
    const league = pick.league || '';
    const label = pick.label || '';
    const reason = pick.reason || '';
    const referee = pick.referee || '';
    const signals = pick.signals || [];

    const today = new Date().toLocaleDateString('nl-NL', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Amsterdam' }).replace(/\//g, '-');

    // Reddit post
    const reddit = [
      `**Pick of the Day (${today})** 🎯 🔥`,
      `**Record (W-L-P):** ${W}-${L}-${P} **${profitStr}**`,
      `**Last 5:** ${last5}`,
      '',
      lastBet ? `**Last Pick:** ${lastResult}` : '',
      '',
      `**${match}**`,
      `🕐 ${kickoff} (Amsterdam time)`,
      `💰 Odds: ${odds}`,
      `💵 Stake: ${units}U`,
      '',
      `*${reason}*`,
      '',
      `**Technical info:**`,
      `Edge on bookie +${edge.toFixed(1)}% · Consensus: ${impliedProb.toFixed(1)}%→${fairProb.toFixed(1)}%${referee ? ` | 🟨 ${referee}` : ''}`,
      '',
      `#PickOfTheDay #SportsBetting #SoccerBetting #potd #ValueBet`,
    ].filter(l => l !== undefined).join('\n');

    // X post
    const x = [
      `🔥 Pick of the Day (${today})`,
      '',
      `Record: ${W}-${L}-${P} (${profitStr}) | Last 5: ${last5Short}`,
      '',
      `⚽ ${match}`,
      `🕐 ${kickoff} (Amsterdam) | 💰 Stake: ${units}U`,
      `📊 Odds: ${odds}`,
      '',
      `📊 Model edge: +${edge.toFixed(1)}% EV (${impliedProb.toFixed(1)}% → ${fairProb.toFixed(1)}%)`,
      '',
      `#PickOfTheDay #SportsBetting #SoccerBetting #potd #ValueBet`,
    ].join('\n');

    res.json({ pick, reddit, x, record: { W, L, P, profitU, last5 } });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Scan history · laatste N scans met picks
// SECURITY: model-internals (reason, kelly, ep, strength, expectedEur, signals, scanType)
// alleen voor admin; non-admin krijgen public-safe veldset zodat IP niet lekt.
const PUBLIC_PICK_FIELDS = ['match', 'league', 'label', 'odd', 'units', 'prob', 'edge', 'score', 'kickoff', 'bookie', 'sport', 'selected'];
function safePick(p, isAdmin) {
  if (isAdmin) return p;
  const out = {};
  for (const k of PUBLIC_PICK_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}
function safePicksList(picks, isAdmin) {
  return (picks || []).map(p => safePick(p, isAdmin));
}

app.get('/api/scan-history', async (req, res) => {
  const isAdmin = req.user?.role === 'admin';
  try {
    let query = supabase.from('scan_history').select('*')
      .order('ts', { ascending: false }).limit(SCAN_HISTORY_MAX);
    if (!isAdmin && req.user?.id) {
      query = query.or(`user_id.eq.${req.user.id},user_id.is.null`);
    }
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const history = (data || []).map(r => ({
      ts: r.ts, type: r.type, totalEvents: r.total_events,
      picks: safePicksList(r.picks || [], isAdmin),
    }));
    return res.json(history);
  } catch (e) {
    console.error('scan-history query fout:', e.message);
    const raw = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
    const filtered = (raw || []).map(r => ({ ...r, picks: safePicksList(r.picks || [], isAdmin) }));
    res.json(filtered);
  }
});

// ── MATCH ANALYSER ENDPOINT ──────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const query = (req.body?.query || '').trim();
    if (!query) return res.status(400).json({ error: 'Voer een wedstrijd in' });

    // Parse the query to extract teams and market
    let teamA = null, teamB = null, market = null;

    // Natural language patterns
    // "speelt X tegen Y"
    const speeltMatch = query.match(/speelt\s+(.+?)\s+tegen\s+(.+?)(?:[\s,\.!?]|$)/i);
    // "X tegen Y"
    const tegenMatch = query.match(/^(?:vanavond|morgen|vandaag|straks)?\s*(.+?)\s+tegen\s+(.+?)(?:[\s,\.!?]|$)/i);
    // "X vs Y" or "X - Y"
    const vsMatch = query.match(/(.+?)\s+(?:vs\.?|[-–])\s+(.+)/i);
    // Simple "X Y" (two teams)
    const simpleMatch = query.match(/^([A-Z][\w]+(?:\s+[A-Z][\w]+)?)\s+([A-Z][\w]+(?:\s+[A-Z][\w]+)?)/);

    if (speeltMatch) {
      teamA = speeltMatch[1].trim();
      teamB = speeltMatch[2].trim();
    } else if (tegenMatch) {
      teamA = tegenMatch[1].trim();
      teamB = tegenMatch[2].trim();
    } else if (vsMatch) {
      teamA = vsMatch[1].trim();
      teamB = vsMatch[2].trim();
    } else if (simpleMatch) {
      teamA = simpleMatch[1].trim();
      teamB = simpleMatch[2].trim();
    }

    // Clean up filler words from team names
    const fillerWords = /^(vanavond|morgen|vandaag|straks|ik\s+denk\s+dat|misschien|volgens\s+mij|jij\??)\s*/gi;
    if (teamA) teamA = teamA.replace(fillerWords, '').trim();
    if (teamB) teamB = teamB.replace(fillerWords, '').replace(/[\s,\.!?]+$/, '').trim();

    // Extract market from natural language
    // "X wint" → home/away win
    const wintMatch = query.match(/(\w+)\s+wint/i);
    const overMatch = query.match(/over\s*([\d.]+)/i);
    const underMatch = query.match(/under\s*([\d.]+)/i);
    const bttsMatch = query.match(/btts|beide\s+teams?\s+scoren/i);
    const gelijkMatch = query.match(/gelijkspel|gelijk|draw/i);

    if (overMatch) market = `Over ${overMatch[1]}`;
    else if (underMatch) market = `Under ${underMatch[1]}`;
    else if (bttsMatch) market = 'BTTS';
    else if (gelijkMatch) market = 'Gelijkspel';
    else if (wintMatch) market = `${wintMatch[1]} wint`;

    if (!teamA) {
      // Fallback: use the whole query as search terms
      const words = query.replace(fillerWords, '').replace(/[,\.!?]+/g, '').trim();
      if (words.length < 2) return res.status(400).json({ error: 'Kon geen teams herkennen. Probeer: "Ajax vs PSV" of "Ajax PSV over 2.5"' });
      teamA = words;
    }

    // Search in lastPrematchPicks and scan history
    const searchTerms = [teamA, teamB].filter(Boolean).map(t => t.toLowerCase());
    const allPicks = [...lastPrematchPicks];

    // Also load from scan history
    try {
      const history = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
      if (history && history.length) {
        for (const entry of history) {
          if (entry.picks) allPicks.push(...entry.picks);
        }
      }
    } catch {}

    // Find matching picks
    const matches = allPicks.filter(p => {
      const matchStr = (p.match || '').toLowerCase();
      return searchTerms.some(t => matchStr.includes(t));
    });

    if (!matches.length) {
      // Try to find upcoming fixtures via API (wider search, multi-sport)
      // Zoek gisteren + vandaag + morgen (Amsterdam) zodat nachtwedstrijden (NHL/NBA) ook gevonden worden.
      const now = Date.now();
      const dateRange = [-1, 0, 1].map(o => new Date(now + o * 86400000)
        .toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }));
      let foundFixtures = [];
      const liveStatuses = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'INT', 'LIVE', 'Q1', 'Q2', 'Q3', 'Q4', 'OT'];
      const qLc = query.toLowerCase();

      // Sport hints: woorden in de query → bijbehorende sport
      const sportHints = [
        { sport: 'hockey',             re: /\b(hockey|nhl|ijshockey|ice hockey)\b/i },
        { sport: 'basketball',         re: /\b(basketball|basketbal|nba|ncaa)\b/i },
        { sport: 'baseball',           re: /\b(baseball|honkbal|mlb)\b/i },
        { sport: 'american-football',  re: /\b(nfl|american football|amerikaans voetbal)\b/i },
        { sport: 'handball',           re: /\b(handbal|handball)\b/i },
        { sport: 'football',           re: /\b(voetbal|soccer|football)\b/i },
      ];
      const matched = sportHints.find(h => h.re.test(qLc));
      // Probeer hint eerst, anders football, daarna fallback andere sporten (max 3 extra API rondes)
      const trySports = matched
        ? [matched.sport]
        : ['football', 'basketball', 'hockey', 'baseball', 'american-football', 'handball'];

      // Helper: fetch + score een sport over date range; retourneert topN candidates
      async function searchSport(sport) {
        const cfg = getSportApiConfig(sport);
        const seen = new Set();
        const pool = [];
        for (const d of dateRange) {
          const games = await afGet(cfg.host, cfg.fixturesPath, { date: d }).catch(() => []);
          for (const g of (games || [])) {
            const gid = sport === 'football' ? g.fixture?.id : g.id;
            if (gid == null || seen.has(gid)) continue;
            seen.add(gid);
            pool.push(g);
          }
        }
        const scored = [];
        for (const f of pool) {
          const status = sport === 'football' ? f.fixture?.status?.short : f.status?.short;
          if (liveStatuses.includes(status)) continue;
          const home = f.teams?.home?.name || '';
          const away = f.teams?.away?.name || '';
          const hs = teamA ? teamMatchScore(home, teamA) : 0;
          const as = teamB ? teamMatchScore(away, teamB) : 0;
          const anyA = teamA ? Math.max(teamMatchScore(home, teamA), teamMatchScore(away, teamA)) : 0;
          const anyB = teamB ? Math.max(teamMatchScore(home, teamB), teamMatchScore(away, teamB)) : 0;
          // Versoepelde threshold: 70 ipv 100 (was té streng, kwam alleen door bij perfecte match)
          const score = teamB ? (hs + as) : anyA;
          const pass  = teamB ? (score >= 70 && anyA >= 40 && anyB >= 40) : (anyA >= 60);
          if (!pass) continue;
          const kickoffIso = sport === 'football' ? f.fixture?.date : (f.date || f.time);
          scored.push({
            score,
            match: `${home} vs ${away}`,
            league: f.league?.name || '',
            kickoff: kickoffIso
              ? new Date(kickoffIso).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' })
              : '',
            sport,
          });
        }
        scored.sort((a, b) => b.score - a.score);
        return scored;
      }

      try {
        let all = [];
        let extraCalls = 0;
        for (const sport of trySports) {
          // Budget-bewaking: max 3 fallback sports (na football/hint)
          if (extraCalls >= 3) break;
          const found = await searchSport(sport).catch(() => []);
          if (found.length) all.push(...found);
          // Alleen extra sporten proberen als er nog niks is gevonden en geen hint
          if (!matched && sport !== 'football') extraCalls++;
          if (!matched && all.length >= 5) break; // genoeg kandidaten
        }
        // Dedupe op match+sport, sorteer op score, top 10
        const dedupe = new Map();
        for (const f of all) {
          const key = `${f.sport}|${f.match}`;
          if (!dedupe.has(key) || dedupe.get(key).score < f.score) dedupe.set(key, f);
        }
        foundFixtures = Array.from(dedupe.values())
          .sort((a, b) => b.score - a.score)
          .slice(0, 10)
          .map(({ score, ...rest }) => rest);
      } catch {}

      return res.json({
        error: `Geen analyse beschikbaar voor "${query}". Start een scan om deze wedstrijd te analyseren.`,
        matches: foundFixtures,
        foundFixtures,
      });
    }

    // Check of deze wedstrijd al bezig is (live) – dan geen pre-match analyse.
    const liveStatuses = ['1H', '2H', 'HT', 'ET', 'BT', 'P', 'INT', 'LIVE'];
    try {
      const bestMatchName = matches[0]?.match || '';
      const bestSport = matches[0]?.sport || 'football';
      if (bestSport === 'football' && bestMatchName) {
        const todayIso = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
        const fxList = await afGet('v3.football.api-sports.io', '/fixtures', { date: todayIso }).catch(() => []);
        const [qHome, qAway] = bestMatchName.split(' vs ').map(s => s.trim());
        const hit = (fxList || []).find(f => {
          const sHome = teamMatchScore(f.teams?.home?.name || '', qHome);
          const sAway = teamMatchScore(f.teams?.away?.name || '', qAway);
          return sHome >= 60 && sAway >= 60;
        });
        const status = hit?.fixture?.status?.short;
        if (status && liveStatuses.includes(status)) {
          return res.json({ error: 'Wedstrijd is al bezig. Pre-match analyse niet mogelijk.' });
        }
      }
    } catch {}

    // SECURITY: model-internals (reason, signals, kelly, ep) alleen voor admin.
    const isAdmin = req.user?.role === 'admin';
    const projectPick = (p) => {
      const score = p.score || (p.kelly ? Math.min(10, Math.max(5, Math.round((p.kelly - 0.015) / 0.135 * 5) + 5)) : null);
      const base = {
        match: p.match, league: p.league, label: p.label, odd: p.odd,
        prob: p.prob, units: p.units, edge: p.edge, score,
        kickoff: p.kickoff, bookie: p.bookie, sport: p.sport || 'football',
      };
      if (isAdmin) {
        base.reason = p.reason;
        base.signals = p.signals;
        if (p.kelly !== undefined) base.kelly = p.kelly;
        if (p.ep !== undefined) base.ep = p.ep;
        if (p.expectedEur !== undefined) base.expectedEur = p.expectedEur;
      }
      return base;
    };

    // If market specified, filter
    if (market) {
      const marketLc = market.toLowerCase();
      const marketMatches = matches.filter(p => (p.label || '').toLowerCase().includes(marketLc.split(' ')[0]));
      if (marketMatches.length) return res.json(projectPick(marketMatches[0]));
    }

    // Return all markets for this match
    if (matches.length === 1) return res.json(projectPick(matches[0]));

    // Multiple results: return multi
    return res.json({ multi: true, results: matches.map(projectPick) });
  } catch (e) {
    console.error('Analyze error:', e.message);
    res.status(500).json({ error: 'Analyse mislukt' });
  }
});

// API status · rate limits + service health
app.get('/api/status', (req, res) => {
  const uptime = process.uptime();
  const c = loadCalib();
  res.json({
    version:    APP_VERSION,
    uptime:     Math.round(uptime),
    uptimeStr:  uptime > 86400 ? `${Math.floor(uptime/86400)}d ${Math.floor((uptime%86400)/3600)}h`
              : uptime > 3600 ? `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`
              : `${Math.floor(uptime/60)}m`,
    services: {
      apiFootball: {
        status: !!AF_KEY ? 'active' : 'no key',
        plan: 'All Sports',
        remaining: afRateLimit.remaining,
        limit: afRateLimit.limit || 7500,
        callsToday: afRateLimit.callsToday || 0,
        usedPct: Math.round((afRateLimit.callsToday || 0) / (afRateLimit.limit || 7500) * 100),
        updatedAt: afRateLimit.updatedAt,
        perSport: {
          football:            { calls: sportRateLimits.football?.callsToday            || 0, limit: 7500 },
          basketball:          { calls: sportRateLimits.basketball?.callsToday          || 0, limit: 7500 },
          hockey:              { calls: sportRateLimits.hockey?.callsToday              || 0, limit: 7500 },
          baseball:            { calls: sportRateLimits.baseball?.callsToday            || 0, limit: 7500 },
          'american-football': { calls: sportRateLimits['american-football']?.callsToday || 0, limit: 7500 },
          handball:            { calls: sportRateLimits.handball?.callsToday            || 0, limit: 7500 },
        },
      },
      espn: { status: 'active', plan: 'Free', note: 'Onbeperkt · live scores auto-refresh' },
      supabase: { status: 'active', plan: 'Free', note: 'Database voor bets + users + calibratie' },
      telegram: { status: 'active', plan: 'Free', note: 'Picks, alerts, model updates' },
      render: { status: 'active', plan: 'Free', note: 'Hosting + keep-alive elke 14 min' },
    },
    model: {
      totalSettled: c.totalSettled || 0,
      totalWins: c.totalWins || 0,
      lastCalibration: c.modelLastUpdated || null,
      marketsTracked: Object.keys(c.markets || {}).filter(k => (c.markets[k]?.n || 0) > 0).length,
    },
    leagues: {
      football:            AF_FOOTBALL_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
      basketball:          NBA_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
      hockey:              NHL_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
      baseball:            BASEBALL_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
      'american-football': NFL_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
      handball:            HANDBALL_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
    },
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

// Model activity feed · alle automatische wijzigingen
app.get('/api/model-feed', requireAdmin, (req, res) => {
  const c = loadCalib();
  const sw = loadSignalWeights();
  // Aggregeer per sport door de sport_markt buckets te splitten op eerste underscore
  const markets = c.markets || {};
  const perSportMap = {};
  for (const [key, m] of Object.entries(markets)) {
    if (!m || !m.n) continue;
    const idx = key.indexOf('_');
    const sport = idx > 0 ? key.slice(0, idx) : 'football';
    if (!perSportMap[sport]) perSportMap[sport] = { sport, n: 0, w: 0, profit: 0 };
    perSportMap[sport].n += m.n;
    perSportMap[sport].w += m.w;
    perSportMap[sport].profit += m.profit;
  }
  const perSport = Object.values(perSportMap)
    .map(s => ({ ...s, winrate: s.n ? Math.round(s.w / s.n * 100) : 0, profit: +s.profit.toFixed(2) }))
    .sort((a, b) => b.n - a.n);
  res.json({
    log: (c.modelLog || []).slice(0, 30),
    lastUpdated: c.modelLastUpdated || null,
    totalSettled: c.totalSettled || 0,
    signalWeights: sw,
    markets,
    epBuckets: c.epBuckets || {},
    perSport,
  });
});

// Notifications · API alerts + calibratie inzichten
// In-app notifications (opgeslagen in Supabase)
app.get('/api/inbox-notifications', async (req, res) => {
  try {
    let query = supabase.from('notifications')
      .select('*').order('created_at', { ascending: false }).limit(50);
    // Filter: user's own notifications + global (null user_id)
    query = query.or(`user_id.eq.${req.user.id},user_id.is.null`);
    const { data, error } = await query;
    if (error) throw error;
    const unread = (data || []).filter(n => !n.read).length;
    res.json({ notifications: data || [], unread });
  } catch { res.status(500).json({ error: 'Interne fout' }); }
});

app.put('/api/inbox-notifications/read', async (req, res) => {
  try {
    await supabase.from('notifications').update({ read: true })
      .eq('read', false).or(`user_id.eq.${req.user.id},user_id.is.null`);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Interne fout' }); }
});

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
      alerts.push({ type: 'success', icon: '💰', msg: `Bankroll +100% (€${bankroll.toFixed(0)}) · unit verhoging aanbevolen: €${UNIT_EUR} → €${UNIT_EUR*2}`, unitAdvice: true });
    } else if (bankrollGrowth >= START_BANKROLL * 0.5) {
      alerts.push({ type: 'info', icon: '💰', msg: `Bankroll +50% (€${bankroll.toFixed(0)}) · overweeg unit van €${UNIT_EUR} naar €${Math.round(UNIT_EUR*1.5)}`, unitAdvice: true });
    }

    // All Sports ($99/mnd) upgrade aanbeveling
    if (c.totalSettled >= 30 && roi > 0.10) {
      alerts.push({ type: 'success', icon: '🚀', msg: `ROI ${(roi*100).toFixed(1)}% over ${c.totalSettled} bets · api-sports All Sports ($99/mnd) betaalt zich terug.` });
    } else if (c.totalSettled >= 20 && roi > 0.05) {
      alerts.push({ type: 'info', icon: '💡', msg: `ROI ${(roi*100).toFixed(1)}% · winstgevend! Wacht tot 30+ bets voor All Sports upgrade.` });
    }

    if (c.lossLog?.length >= 5) {
      const byMarket = {};
      for (const l of c.lossLog.slice(0, 20)) byMarket[l.market] = (byMarket[l.market]||0) + 1;
      const worst = Object.entries(byMarket).sort((a,b) => b[1]-a[1])[0];
      if (worst?.[1] >= 3) {
        alerts.push({ type: 'warn', icon: '⚠️', msg: `${worst[1]}x verlies in "${worst[0]}" picks (laatste 20 bets) · model drempel verhoogd.` });
      }
    }

    for (const [mk, v] of Object.entries(c.markets)) {
      if (v.n >= 8 && v.multiplier <= 0.75) {
        alerts.push({ type: 'warn', icon: '📉', msg: `"${mk}" picks: ${v.w}/${v.n} gewonnen · model filtert strenger.` });
      } else if (v.n >= 10 && v.multiplier >= 1.15) {
        alerts.push({ type: 'success', icon: '📈', msg: `"${mk}" picks presteren goed (${v.w}/${v.n}) · model vertrouwt dit signaal meer.` });
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

    // Supabase database grootte check (free tier = 500MB)
    try {
      const { count: betCount } = await supabase.from('bets').select('*', { count: 'exact', head: true });
      const { count: scanCount } = await supabase.from('scan_history').select('*', { count: 'exact', head: true });
      const estMB = ((betCount || 0) * 0.002 + (scanCount || 0) * 0.05).toFixed(1); // rough estimate
      if (parseFloat(estMB) > 400) {
        alerts.push({ type: 'error', icon: '🗄️', msg: `Supabase database bijna vol: ~${estMB}MB / 500MB · upgrade naar Pro ($25/mnd) aanbevolen.` });
      } else if (parseFloat(estMB) > 250) {
        alerts.push({ type: 'warn', icon: '🗄️', msg: `Supabase database: ~${estMB}MB / 500MB gebruikt. Nog ruimte maar hou in de gaten.` });
      }
    } catch {}

    res.json({ alerts, totalSettled: c.totalSettled, lastUpdated: c.lastUpdated, modelLastUpdated: c.modelLastUpdated || null });
  } catch (e) { res.status(500).json({ alerts: [], error: 'Interne fout' }); }
});

// ── CHECK UITSLAGEN · standalone functie (gebruikt door route én dagelijkse cron) ──
async function checkOpenBetResults(userId = null) {
  const { bets } = await readBets(userId);
  const openBets = bets.filter(b => b.uitkomst === 'Open');
  if (!openBets.length) return { checked: 0, updated: 0, results: [] };

  // Gebruik api-football voor uitslagen (vervangt ESPN) — alle sporten
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });

  // Fetch all sports in parallel
  const [
    todayFixtures, yesterdayFixtures,
    bbToday, bbYesterday,
    hkToday, hkYesterday,
    baToday, baYesterday,
    nflToday, nflYesterday,
    hbToday, hbYesterday,
  ] = await Promise.all([
    afGet('v3.football.api-sports.io', '/fixtures', { date: today }).catch(() => []),
    afGet('v3.football.api-sports.io', '/fixtures', { date: yesterday }).catch(() => []),
    afGet('v1.basketball.api-sports.io', '/games', { date: today }).catch(() => []),
    afGet('v1.basketball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
    afGet('v1.hockey.api-sports.io', '/games', { date: today }).catch(() => []),
    afGet('v1.hockey.api-sports.io', '/games', { date: yesterday }).catch(() => []),
    afGet('v1.baseball.api-sports.io', '/games', { date: today }).catch(() => []),
    afGet('v1.baseball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
    afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
    afGet('v1.american-football.api-sports.io', '/games', { date: yesterday }).catch(() => []),
    afGet('v1.handball.api-sports.io', '/games', { date: today }).catch(() => []),
    afGet('v1.handball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
  ]);

  // Football finished
  const FINISHED_STATUSES = new Set(['FT','AET','PEN']);
  const footballFinished = [...(todayFixtures || []), ...(yesterdayFixtures || [])]
    .filter(f => FINISHED_STATUSES.has(f.fixture?.status?.short))
    .map(f => ({
      home:   f.teams?.home?.name || '',
      away:   f.teams?.away?.name || '',
      scoreH: f.goals?.home ?? 0,
      scoreA: f.goals?.away ?? 0,
      sport:  'football',
    }));

  // Basketball finished games (include halftime scores for 1H market resolution)
  const bbFinished = [...(bbToday || []), ...(bbYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return status === 'FT' || status === 'AOT';
  }).map(g => ({
    home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
    scoreH: g.scores?.home?.total ?? 0, scoreA: g.scores?.away?.total ?? 0,
    // 1st half = Q1+Q2
    halfH: (g.scores?.home?.quarter_1 ?? 0) + (g.scores?.home?.quarter_2 ?? 0),
    halfA: (g.scores?.away?.quarter_1 ?? 0) + (g.scores?.away?.quarter_2 ?? 0),
    sport: 'basketball',
  }));

  // Hockey finished games (include 1st period + regulation score voor 3-weg)
  const hkFinished = [...(hkToday || []), ...(hkYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return status === 'FT' || status === 'AOT' || status === 'AP';
  }).map(g => {
    const status = (g.status?.short || '').toUpperCase();
    // Regulation score: sommeer eerste 3 periodes indien beschikbaar,
    // anders als status=FT is de finale score ook de reg score.
    // Bij AOT/AP was het na 60 min gelijk (anders geen OT nodig).
    const p1H = g.periods?.first?.home ?? null;
    const p1A = g.periods?.first?.away ?? null;
    const p2H = g.periods?.second?.home ?? null;
    const p2A = g.periods?.second?.away ?? null;
    const p3H = g.periods?.third?.home ?? null;
    const p3A = g.periods?.third?.away ?? null;
    let regH, regA;
    if (p1H != null && p2H != null && p3H != null) {
      regH = p1H + p2H + p3H;
      regA = (p1A || 0) + (p2A || 0) + (p3A || 0);
    } else if (status === 'FT') {
      regH = g.scores?.home ?? 0;
      regA = g.scores?.away ?? 0;
    } else if (status === 'AOT' || status === 'AP') {
      // Geen period data → neem aan dat het na 60 min gelijk was (standaard voor AOT/AP)
      regH = regA = g.scores?.home ?? 0;
    } else {
      regH = g.scores?.home ?? 0;
      regA = g.scores?.away ?? 0;
    }
    return {
      home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
      scoreH: g.scores?.home ?? 0, scoreA: g.scores?.away ?? 0,
      regScoreH: regH, regScoreA: regA,
      status,
      p1H, p1A,
      sport: 'hockey',
    };
  });

  // Baseball finished games (include 1st inning for NRFI resolution)
  const baseballFinished = [...(baToday || []), ...(baYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return status === 'FT' || status === 'AOT';
  }).map(g => ({
    home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
    scoreH: g.scores?.home?.total ?? 0, scoreA: g.scores?.away?.total ?? 0,
    // 1st inning scores for NRFI
    inn1H: g.scores?.home?.innings?.['1'] ?? g.scores?.home?.inning_1 ?? null,
    inn1A: g.scores?.away?.innings?.['1'] ?? g.scores?.away?.inning_1 ?? null,
    sport: 'baseball',
  }));

  // NFL (American Football) finished games (include 1st half scores)
  const nflFinished = [...(nflToday || []), ...(nflYesterday || [])].filter(g => {
    const status = (g.game?.status?.short || '').toUpperCase();
    return status === 'FT' || status === 'AOT';
  }).map(g => ({
    home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
    scoreH: g.scores?.home?.total ?? 0, scoreA: g.scores?.away?.total ?? 0,
    // 1st half = Q1+Q2
    halfH: (g.scores?.home?.quarter_1 ?? 0) + (g.scores?.home?.quarter_2 ?? 0),
    halfA: (g.scores?.away?.quarter_1 ?? 0) + (g.scores?.away?.quarter_2 ?? 0),
    sport: 'american-football',
  }));

  // Handball finished games
  const handballFinished = [...(hbToday || []), ...(hbYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return status === 'FT' || status === 'AOT' || status === 'AP';
  }).map(g => {
    const status = (g.status?.short || '').toUpperCase();
    const scoreH = g.scores?.home ?? 0;
    const scoreA = g.scores?.away ?? 0;
    // Handbal: FT = regulation gelijk aan final. AOT/AP = knockout OT, reg was gelijk.
    let regH = scoreH, regA = scoreA;
    if (status === 'AOT' || status === 'AP') { regH = regA = scoreH; }
    return { home: g.teams?.home?.name || '', away: g.teams?.away?.name || '',
             scoreH, scoreA, regScoreH: regH, regScoreA: regA, status, sport: 'handball' };
  });

  const allFinished = [...footballFinished, ...bbFinished, ...hkFinished, ...baseballFinished, ...nflFinished, ...handballFinished];

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

    // ── 3-weg 60-min markten (hockey/handbal regulation) ──
    // Gebruikt regScoreH/regScoreA (na 60 min, excl OT/SO). Bij AOT/AP was reg score gelijk.
    const is60min = markt.includes('60-min') || markt.includes('60 min') || markt.includes('🕐');
    if (is60min && ev.regScoreH != null && ev.regScoreA != null) {
      if (markt.includes('gelijkspel') || markt.includes('draw')) {
        uitkomst = ev.regScoreH === ev.regScoreA ? 'W' : 'L';
      } else {
        // Winnaar-detectie: pak teamnaam uit markt
        const winnerMatch = markt.match(/(.+?)\s+wint/i);
        if (winnerMatch) {
          const t = winnerMatch[1].replace(/[🏠✈️🕐]/g, '').trim().toLowerCase();
          const isHome = ev.home.toLowerCase().includes(t) || t.includes(ev.home.toLowerCase().split(' ').pop());
          const isAway = ev.away.toLowerCase().includes(t) || t.includes(ev.away.toLowerCase().split(' ').pop());
          if (isHome) uitkomst = ev.regScoreH > ev.regScoreA ? 'W' : 'L'; // gelijk = L (draw won)
          else if (isAway) uitkomst = ev.regScoreA > ev.regScoreH ? 'W' : 'L';
        }
      }
    }
    // ── NRFI / YRFI (baseball 1st inning) ──
    else if (markt.includes('nrfi') || markt.includes('yrfi') || markt.includes('no run 1st') || markt.includes('yes run 1st') || markt.includes('no run first') || markt.includes('yes run first')) {
      if (ev.inn1H !== null && ev.inn1H !== undefined && ev.inn1A !== null && ev.inn1A !== undefined) {
        const firstInningRuns = (ev.inn1H || 0) + (ev.inn1A || 0);
        const isNRFI = markt.includes('nrfi') || markt.includes('no run');
        if (isNRFI) uitkomst = firstInningRuns === 0 ? 'W' : 'L';
        else uitkomst = firstInningRuns > 0 ? 'W' : 'L';
      }
    }
    // ── 1st Half Over/Under (basketball, NFL) ──
    else if ((markt.includes('1h ') || markt.includes('1st half')) && (markt.includes('over') || markt.includes('under'))) {
      const halfTotal = (ev.halfH ?? null) !== null && (ev.halfA ?? null) !== null ? ev.halfH + ev.halfA : null;
      if (halfTotal !== null) {
        const h1OverMatch = markt.match(/over\s*(\d+\.?\d*)/i);
        const h1UnderMatch = !h1OverMatch && markt.match(/under\s*(\d+\.?\d*)/i);
        if (h1OverMatch) {
          const line = parseFloat(h1OverMatch[1]);
          uitkomst = halfTotal > line ? 'W' : halfTotal < line ? 'L' : null;
        } else if (h1UnderMatch) {
          const line = parseFloat(h1UnderMatch[1]);
          uitkomst = halfTotal < line ? 'W' : halfTotal > line ? 'L' : null;
        }
      }
    }
    // ── 1st Half Spread (basketball, NFL) ──
    else if ((markt.includes('1h ') || markt.includes('1st half')) && (markt.includes('spread') || markt.match(/[+-]\d/))) {
      const halfH = ev.halfH ?? null;
      const halfA = ev.halfA ?? null;
      if (halfH !== null && halfA !== null) {
        const h1SpreadMatch = markt.match(/([+-]?\d+\.?\d*)/);
        if (h1SpreadMatch) {
          const line = parseFloat(h1SpreadMatch[1]);
          // Determine which side from the label
          const isHome = markt.includes(ev.home.toLowerCase().split(' ').pop());
          const diff = isHome ? (halfH - halfA) : (halfA - halfH);
          const adjusted = diff + line;
          uitkomst = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : null;
        }
      }
    }
    // ── 1st Period Over/Under (hockey) ──
    else if ((markt.includes('p1 ') || markt.includes('1st period')) && (markt.includes('over') || markt.includes('under'))) {
      const p1Total = (ev.p1H ?? null) !== null && (ev.p1A ?? null) !== null ? ev.p1H + ev.p1A : null;
      if (p1Total !== null) {
        const p1OverMatch = markt.match(/over\s*(\d+\.?\d*)/i);
        const p1UnderMatch = !p1OverMatch && markt.match(/under\s*(\d+\.?\d*)/i);
        if (p1OverMatch) {
          const line = parseFloat(p1OverMatch[1]);
          uitkomst = p1Total > line ? 'W' : p1Total < line ? 'L' : null;
        } else if (p1UnderMatch) {
          const line = parseFloat(p1UnderMatch[1]);
          uitkomst = p1Total < line ? 'W' : p1Total > line ? 'L' : null;
        }
      }
    }
    // ── Odd/Even total ──
    else if (markt.includes('odd total') || markt.includes('even total') || markt.includes('🎲')) {
      const isOdd = markt.includes('odd');
      uitkomst = (total % 2 === 1) === isOdd ? 'W' : 'L';
    }
    // Generic over/under detection (works for all sports: goals, points, runs, etc.)
    else if (markt.match(/over\s*(\d+\.?\d*)/i)) {
      const ouMatch = markt.match(/over\s*(\d+\.?\d*)/i);
      const line = parseFloat(ouMatch[1]);
      uitkomst = total > line ? 'W' : total < line ? 'L' : null; // exact = push
    }
    else if (markt.match(/under\s*(\d+\.?\d*)/i) && !markt.match(/over\s*(\d+\.?\d*)/i)) {
      const ouMatch = markt.match(/under\s*(\d+\.?\d*)/i);
      const line = parseFloat(ouMatch[1]);
      uitkomst = total < line ? 'W' : total > line ? 'L' : null;
    }
    else if (markt.includes('btts ja') || markt.includes('btts yes') || (markt.includes('btts') && !markt.includes('nee') && !markt.includes('no'))) {
      uitkomst = (ev.scoreH > 0 && ev.scoreA > 0) ? 'W' : 'L';
    }
    else if (markt.includes('btts nee') || markt.includes('btts no')) {
      uitkomst = (ev.scoreH === 0 || ev.scoreA === 0) ? 'W' : 'L';
    }
    else if (markt.includes('dnb ') || markt.includes('draw no bet')) {
      // Draw No Bet: draw = void (no result)
      if (ev.scoreH === ev.scoreA) {
        uitkomst = null; // void / push · skip
      } else {
        // Find which team was picked
        const dnbTeam = markt.replace(/.*dnb\s*/i, '').replace(/draw no bet\s*/i, '').trim().toLowerCase();
        const isHome = ev.home.toLowerCase().includes(dnbTeam) || dnbTeam.includes(ev.home.toLowerCase().split(' ').pop());
        const isAway = ev.away.toLowerCase().includes(dnbTeam) || dnbTeam.includes(ev.away.toLowerCase().split(' ').pop());
        if (isHome) uitkomst = ev.scoreH > ev.scoreA ? 'W' : 'L';
        else if (isAway) uitkomst = ev.scoreA > ev.scoreH ? 'W' : 'L';
      }
    }
    else {
      // Spread / handicap / run line / puck line detection
      const spreadMatch = markt.match(/(?:spread|handicap|line)\s*[:\s]?\s*(.+?)\s*([+-]\d+\.?\d*)/i);
      if (spreadMatch) {
        const spreadTeam = spreadMatch[1].trim().toLowerCase();
        const line = parseFloat(spreadMatch[2]);
        const isHome = ev.home.toLowerCase().includes(spreadTeam) || spreadTeam.includes(ev.home.toLowerCase().split(' ').pop());
        const isAway = ev.away.toLowerCase().includes(spreadTeam) || spreadTeam.includes(ev.away.toLowerCase().split(' ').pop());
        if (isHome || isAway) {
          const diff = isHome ? (ev.scoreH - ev.scoreA) : (ev.scoreA - ev.scoreH);
          const adjusted = diff + line;
          uitkomst = adjusted > 0 ? 'W' : adjusted < 0 ? 'L' : null; // exact 0 = push
        }
      }

      if (!uitkomst) {
        // Moneyline / winner detection
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
    }

    if (uitkomst) {
      await updateBetOutcome(bet.id, uitkomst);
      // Push notification for bet result
      const wlAmount = uitkomst === 'W' ? +((bet.odds-1)*bet.inzet).toFixed(2) : -bet.inzet;
      await sendPushToAll({
        title: uitkomst === 'W' ? '✅ Bet gewonnen!' : '❌ Bet verloren',
        body: `${bet.wedstrijd}: ${ev.scoreH}-${ev.scoreA}\n${bet.markt} · ${uitkomst === 'W' ? '+' : ''}€${wlAmount}`,
        tag: 'bet-result-' + bet.id,
        url: '/',
      }).catch(() => {});
    }
    results.push({ id: bet.id, wedstrijd: bet.wedstrijd, markt: bet.markt,
                   score: `${ev.scoreH}-${ev.scoreA}`, uitkomst,
                   note: uitkomst ? null : 'Score gevonden · update handmatig' });
  }

  return { checked: openBets.length, updated: results.filter(r => r.uitkomst).length, results };
}

// Check uitslagen route
app.get('/api/check-results', async (req, res) => {
  try {
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const result = await checkOpenBetResults(userId);
    const { bets, stats } = await readBets(userId);
    res.json({ ...result, bets, stats });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Live scores via api-football
// Lightweight live poll via ESPN (gratis, onbeperkt · voor auto-refresh)
app.get('/api/live-poll', async (req, res) => {
  try {
    const espnGet = url => fetch(url, { headers: { Accept: 'application/json' } }).then(r => r.json()).catch(() => ({}));
    const leagues = [
      'eng.1','eng.2','esp.1','ger.1','ita.1','fra.1','ned.1','por.1','tur.1',
      'uefa.champions','uefa.europa','bel.1','sco.1'
    ];
    const raw = await Promise.all(leagues.map(async code => {
      const d = await espnGet(`https://site.api.espn.com/apis/site/v2/sports/soccer/${code}/scoreboard`);
      return (d.events || []).map(ev => {
        const comp = ev.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === 'home');
        const away = comp?.competitors?.find(c => c.homeAway === 'away');
        const status = ev.status?.type;
        const clock = ev.status?.displayClock || '';
        const detail = status?.shortDetail || '';
        const isLive = status?.state === 'in' || detail.match(/^(1st|2nd|HT|Half|ET)/i);
        const isFT = status?.completed || false;
        if (!home || !away) return null;
        return {
          id: ev.id, home: home.team?.displayName||'', away: away.team?.displayName||'',
          homeLogo: home.team?.logo||'', awayLogo: away.team?.logo||'',
          scoreH: parseInt(home.score||'0'), scoreA: parseInt(away.score||'0'),
          minute: isLive ? (detail.match(/^(HT|Half)/i) ? 'HT' : clock.replace(/\s/g,'')+"'") : isFT ? 'FT' : '',
          live: isLive, finished: isFT,
          league: ev.season?.type?.name || code,
          startTime: new Date(ev.date).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' }),
        };
      }).filter(Boolean);
    }));
    const events = raw.flat();
    res.json({ events, liveCount: events.filter(e => e.live).length, ts: Date.now() });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Live scores via api-football (rijkere data, kost API calls · voor eerste load + details)
app.get('/api/live-scores', async (req, res) => {
  try {
    const knownLeagueIds = new Set(AF_FOOTBALL_LEAGUES.map(l => l.id));
    const leagueNames    = Object.fromEntries(AF_FOOTBALL_LEAGUES.map(l => [l.id, l.name]));

    // Known league IDs for other sports
    const knownBBLeagueIds  = new Set(NBA_LEAGUES.map(l => l.id));
    const bbLeagueNames     = Object.fromEntries(NBA_LEAGUES.map(l => [l.id, l.name]));
    const knownHKLeagueIds  = new Set(NHL_LEAGUES.map(l => l.id));
    const hkLeagueNames     = Object.fromEntries(NHL_LEAGUES.map(l => [l.id, l.name]));
    const knownBALeagueIds  = new Set(BASEBALL_LEAGUES.map(l => l.id));
    const baLeagueNames     = Object.fromEntries(BASEBALL_LEAGUES.map(l => [l.id, l.name]));
    const knownNFLLeagueIds = new Set(NFL_LEAGUES.map(l => l.id));
    const nflLeagueNames    = Object.fromEntries(NFL_LEAGUES.map(l => [l.id, l.name]));
    const knownHBLeagueIds  = new Set(HANDBALL_LEAGUES.map(l => l.id));
    const hbLeagueNames     = Object.fromEntries(HANDBALL_LEAGUES.map(l => [l.id, l.name]));

    // Live en vandaag geplande wedstrijden ophalen in parallel — alle sporten
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const [
      liveFixtures, todayFixtures,
      bbLive, bbToday,
      hkLive, hkToday,
      baLive, baToday,
      nflLive, nflToday,
      hbLive, hbToday,
    ] = await Promise.all([
      afGet('v3.football.api-sports.io', '/fixtures', { live: 'all' }).catch(() => []),
      afGet('v3.football.api-sports.io', '/fixtures', { date: today }).catch(() => []),
      afGet('v1.basketball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
      afGet('v1.basketball.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.hockey.api-sports.io', '/games', { live: 'all' }).catch(() => []),
      afGet('v1.hockey.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.baseball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
      afGet('v1.baseball.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.handball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
      afGet('v1.handball.api-sports.io', '/games', { date: today }).catch(() => []),
    ]);

    const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);
    // v1 sport APIs use different status codes for live
    const V1_LIVE_STATUSES = new Set(['Q1','Q2','Q3','Q4','OT','BT','HT','LIVE','P1','P2','P3','OT','BT','IN1','IN2','IN3','IN4','IN5','IN6','IN7','IN8','IN9']);

    // ── Football mapper ──────────────────────────────────────────────────────
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

    // ── Generic v1 sport mapper (basketball, hockey, baseball, NFL, handball) ─
    const mapV1Game = (g, sport, leagueNamesMap) => {
      const statusShort = (g.status?.short || g.game?.status?.short || '').toUpperCase();
      const isLive = V1_LIVE_STATUSES.has(statusShort);
      const isFT = statusShort === 'FT' || statusShort === 'AOT' || statusShort === 'AP';
      const isNS = statusShort === 'NS';

      let scoreH = null, scoreA = null;
      if (sport === 'basketball' || sport === 'baseball') {
        scoreH = isLive || isFT ? (g.scores?.home?.total ?? 0) : null;
        scoreA = isLive || isFT ? (g.scores?.away?.total ?? 0) : null;
      } else if (sport === 'hockey' || sport === 'handball') {
        scoreH = isLive || isFT ? (g.scores?.home ?? 0) : null;
        scoreA = isLive || isFT ? (g.scores?.away ?? 0) : null;
      } else if (sport === 'american-football') {
        scoreH = isLive || isFT ? (g.scores?.home?.total ?? 0) : null;
        scoreA = isLive || isFT ? (g.scores?.away?.total ?? 0) : null;
      }

      const leagueId = g.league?.id;
      const startDate = g.date || g.game?.date?.date;
      const startTime = !isLive && startDate
        ? new Date(startDate).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' })
        : '';

      return {
        id:        g.id || g.game?.id || 0,
        fixtureId: g.id || g.game?.id || 0,
        sport,
        league:    leagueNamesMap[leagueId] || g.league?.name || '',
        leagueId,
        home:      g.teams?.home?.name || '?',
        away:      g.teams?.away?.name || '?',
        homeLogo:  g.teams?.home?.logo || '',
        awayLogo:  g.teams?.away?.logo || '',
        scoreH,
        scoreA,
        minute:    isLive ? statusShort : isFT ? 'FT' : '',
        status:    g.status?.long || g.game?.status?.long || '',
        startTime,
        live:      isLive,
      };
    };

    // ── Collect football events (dedup live vs scheduled) ────────────────────
    const seen = new Set();
    const events = [];

    for (const f of (liveFixtures || [])) {
      if (!knownLeagueIds.has(f.league?.id)) continue;
      seen.add(f.fixture?.id);
      events.push(mapFixture(f));
    }
    for (const f of (todayFixtures || [])) {
      if (!knownLeagueIds.has(f.league?.id)) continue;
      if (seen.has(f.fixture?.id)) continue;
      if (f.fixture?.status?.short !== 'NS') continue;
      seen.add(f.fixture?.id);
      events.push(mapFixture(f));
    }

    // ── Collect other sports (dedup live vs today) ───────────────────────────
    const addV1Sport = (liveGames, todayGames, sport, knownIds, namesMap) => {
      const sportSeen = new Set();
      for (const g of (liveGames || [])) {
        const lid = g.league?.id;
        const gid = g.id || g.game?.id;
        if (!knownIds.has(lid)) continue;
        sportSeen.add(gid);
        events.push(mapV1Game(g, sport, namesMap));
      }
      for (const g of (todayGames || [])) {
        const lid = g.league?.id;
        const gid = g.id || g.game?.id;
        if (!knownIds.has(lid)) continue;
        if (sportSeen.has(gid)) continue;
        const st = (g.status?.short || g.game?.status?.short || '').toUpperCase();
        if (st !== 'NS') continue;
        sportSeen.add(gid);
        events.push(mapV1Game(g, sport, namesMap));
      }
    };

    addV1Sport(bbLive,  bbToday,  'basketball',       knownBBLeagueIds,  bbLeagueNames);
    addV1Sport(hkLive,  hkToday,  'hockey',           knownHKLeagueIds,  hkLeagueNames);
    addV1Sport(baLive,  baToday,  'baseball',         knownBALeagueIds,  baLeagueNames);
    addV1Sport(nflLive, nflToday, 'american-football', knownNFLLeagueIds, nflLeagueNames);
    addV1Sport(hbLive,  hbToday,  'handball',         knownHBLeagueIds,  hbLeagueNames);

    events.sort((a, b) => {
      if (a.live !== b.live) return b.live ? 1 : -1;
      return (a.startTime || '').localeCompare(b.startTime || '');
    });

    res.json({ events, liveCount: events.filter(e => e.live).length });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Live wedstrijd events + stats via api-football (rijkere data dan ESPN)
app.get('/api/live-events/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });

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
  } catch (e) { res.status(500).json({ error: 'Interne fout', events: [] }); }
});

// Eenmalig: kickofftijden invullen voor bets zonder tijd
app.post('/api/backfill-times', requireAdmin, async (req, res) => {
  try {
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const { bets } = await readBets(userId);
    const results = [];

    for (let i = 0; i < bets.length; i++) {
      const b = bets[i];
      // altijd overschrijven zodat foute tijden gecorrigeerd worden

      // Zoek fixture op datum + teamnaam
      const dateStr = b.datum.split('-').reverse().join('-'); // dd-mm-yyyy → yyyy-mm-dd
      const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: dateStr });
      await sleep(200);

      const [tA, tB] = b.wedstrijd.toLowerCase().split(' vs ').map(t => t.trim());
      // Zoek fixture waar BEIDE teams (deels) matchen · voorkomt jeugd/reserve wedstrijden
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

      // Schrijf naar Supabase
      await supabase.from('bets').update({ tijd }).eq('bet_id', b.id);

      results.push({ id: b.id, status: 'bijgewerkt', wedstrijd: b.wedstrijd, tijd, rawDate });
    }

    res.json({ results });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── ODDS MOVEMENT ALERTS ─────────────────────────────────────────────────────
// Elke 60 minuten: check odds drift voor open bets met kickoff < 12 uur weg.
// ── KICKOFF-RELATIVE ODDS POLLING (v9.10.0) ─────────────────────────────────
// Reviewer-aanbeveling: snapshots op open / t-6h / t-1h / t-15m / close.
// Open = bij eerste scan. Close = ~2 min voor kickoff (al via scheduleCLVCheck).
// Tussen-snapshots t-6h/t-1h/t-15m: deze polling job draait elke 5 min en
// snapshot fixtures die zich in een venster ±5 min rondom die kickoff-relatieve
// momenten bevinden. Per fixture max 3 extra snapshots.
function scheduleKickoffWindowPolling() {
  const INTERVAL_MS = 5 * 60 * 1000; // 5 min
  const WINDOWS = [6 * 60, 60, 15]; // minuten voor kickoff
  const TOLERANCE_MIN = 5;
  const _seen = new Map(); // fixture_id → Set('6h','1h','15m')

  async function runWindow() {
    try {
      const nowMs = Date.now();
      const horizonMs = nowMs + 7 * 3600 * 1000;
      const { data: fixtures } = await supabase.from('fixtures')
        .select('id, sport, start_time')
        .eq('status', 'scheduled')
        .gte('start_time', new Date(nowMs).toISOString())
        .lte('start_time', new Date(horizonMs).toISOString())
        .order('start_time', { ascending: true })
        .limit(80);
      if (!fixtures?.length) return;

      let snapshotted = 0;
      for (const fix of fixtures) {
        const koMs = new Date(fix.start_time).getTime();
        const minsToKo = (koMs - nowMs) / 60000;
        for (const targetMin of WINDOWS) {
          if (Math.abs(minsToKo - targetMin) > TOLERANCE_MIN) continue;
          // Dedupe: deze fixture+window al gedaan?
          const tag = `${targetMin}m`;
          if (!_seen.has(fix.id)) _seen.set(fix.id, new Set());
          if (_seen.get(fix.id).has(tag)) continue;
          _seen.get(fix.id).add(tag);
          // Snapshot
          try {
            const sport = normalizeSport(fix.sport);
            if (sport === 'football') continue; // football snapshots via dagelijkse scan voor nu
            const cfg = getSportApiConfig(sport);
            const oddsResp = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: fix.id }).catch(() => []);
            if (!oddsResp?.length) continue;
            const parsed = parseGameOdds([oddsResp[0]], '', '');
            const rows = snap.flattenParsedOdds(parsed);
            if (rows.length) {
              await snap.writeOddsSnapshots(supabase, fix.id, rows);
              snapshotted++;
            }
          } catch { /* swallow */ }
        }
      }
      // Cleanup: verwijder finished fixtures uit _seen om memory te sparen
      for (const [fid] of _seen) {
        const f = fixtures.find(x => x.id === fid);
        if (!f || new Date(f.start_time).getTime() < nowMs) _seen.delete(fid);
      }
      if (snapshotted) console.log(`📸 Kickoff-window snapshots: ${snapshotted} (t-6h/1h/15m windows)`);
    } catch { /* swallow */ }
  }

  setTimeout(() => {
    runWindow();
    setInterval(runWindow, INTERVAL_MS);
  }, 3 * 60 * 1000);
  console.log('📸 Kickoff-window polling actief (t-6h/1h/15m, elke 5 min)');
}

// ── CLV HEALTH ALERTS + DRAWDOWN WATCHER (v10.1.0) ──────────────────────────
// Telegram-pings bij milestones zodat we sneller weten of model gezond is.
// Geen automatisch ingrijpen — alleen observeren (per reviewer-advies).
let _lastClvAlertN = 0;     // bet count bij laatste CLV alert
let _lastDdAlertAt = 0;     // timestamp laatste drawdown alert
const CLV_ALERT_INTERVAL = 25;          // ping elke 25 nieuwe settled CLV bets
const DD_ALERT_THRESHOLD = -0.15;       // -15% bankroll over 7d
const DD_ALERT_COOLDOWN_MS = 24 * 3600 * 1000; // max 1x/dag

function scheduleHealthAlerts() {
  const INTERVAL_MS = 60 * 60 * 1000; // hourly check

  async function runHealthCheck() {
    try {
      // CLV milestone alert: globaal totaal + per-markt verdict
      const { data: clvBets } = await supabase.from('bets')
        .select('clv_pct, sport, markt').not('clv_pct', 'is', null);
      const all = (clvBets || []).filter(b => typeof b.clv_pct === 'number');
      if (all.length >= _lastClvAlertN + CLV_ALERT_INTERVAL) {
        const avgClv = all.reduce((s, b) => s + b.clv_pct, 0) / all.length;
        const positive = all.filter(b => b.clv_pct > 0).length;
        const posPct = (positive / all.length * 100).toFixed(1);
        const verdict = avgClv > 1 ? '✅ EDGE BEWEZEN'
                      : avgClv > 0 ? '🟢 mild positief'
                      : avgClv > -2 ? '🟡 neutraal'
                      : '🔴 STRUCTUREEL NEGATIEF';
        // Per-markt breakdown (≥10 samples per markt om noise te beperken)
        const byMarket = {};
        for (const b of all) {
          const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
          if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0 };
          byMarket[key].n++;
          byMarket[key].sumClv += b.clv_pct;
        }
        const marketLines = Object.entries(byMarket)
          .filter(([, d]) => d.n >= 10)
          .map(([k, d]) => {
            const m = d.sumClv / d.n;
            const ico = m > 1 ? '✅' : m > 0 ? '🟢' : m > -2 ? '🟡' : '🔴';
            return `${ico} ${k}: ${m > 0 ? '+' : ''}${m.toFixed(2)}% (n=${d.n})`;
          })
          .sort()
          .join('\n');
        const marketSummary = marketLines || '(nog geen markt met ≥10 samples)';
        await tg(`📊 CLV Milestone\n${all.length} settled bets met CLV data\nGemiddelde CLV: ${avgClv > 0 ? '+' : ''}${avgClv.toFixed(2)}%\n${positive}/${all.length} positief (${posPct}%)\n${verdict}\n\nPer markt (≥10 bets):\n${marketSummary}`).catch(() => {});
        _lastClvAlertN = all.length;
      }

      // Drawdown soft alert (alleen warn, geen pause)
      if (Date.now() - _lastDdAlertAt > DD_ALERT_COOLDOWN_MS) {
        const { bets, stats } = await readBets();
        if (stats?.bankroll != null && stats?.startBankroll != null) {
          const sevenDaysAgo = Date.now() - 7 * 86400000;
          const recentSettled = (bets || []).filter(b => {
            if (b.uitkomst === 'Open') return false;
            const dm = (b.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
            if (!dm) return false;
            return Date.parse(`${dm[3]}-${dm[2]}-${dm[1]}`) > sevenDaysAgo;
          });
          const recent7dPnl = recentSettled.reduce((s, b) => s + parseFloat(b.wl || 0), 0);
          const recent7dPct = stats.startBankroll > 0 ? recent7dPnl / stats.startBankroll : 0;
          if (recent7dPct < DD_ALERT_THRESHOLD) {
            await tg(`⚠️ DRAWDOWN ALERT (soft)\nLaatste 7 dagen: ${(recent7dPct * 100).toFixed(1)}% (€${recent7dPnl.toFixed(2)})\nBankroll: €${stats.bankroll}\n\nGeen automatische pause. Overweeg unit-grootte verlagen of stop manueel.`).catch(() => {});
            _lastDdAlertAt = Date.now();
          }
        }
      }
    } catch (e) { console.error('Health alerts fout:', e.message); }
  }

  setTimeout(() => { runHealthCheck(); setInterval(runHealthCheck, INTERVAL_MS); }, 10 * 60 * 1000);
  console.log('🔔 Health alerts actief (CLV milestones + soft drawdown, hourly)');
}

// ── SIGNAL STATS REFRESH (v9.11.0) ──────────────────────────────────────────
// Wekelijks: aggregeer per signal de avg CLV, avg PnL, lift vs market.
// Schrijft naar signal_stats tabel; dashboard kan hier signal-performance zien.
function scheduleSignalStatsRefresh() {
  const INTERVAL_MS = 24 * 3600 * 1000; // dagelijks

  async function refresh() {
    if (!_currentModelVersionId) return;
    try {
      const { data: bets } = await supabase.from('bets')
        .select('signals, clv_pct, wl, uitkomst, sport, markt, odds')
        .not('clv_pct', 'is', null);
      const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && b.signals);
      if (!all.length) return;

      const stats = {}; // signalName → aggregates
      for (const b of all) {
        let sigs;
        try { sigs = typeof b.signals === 'string' ? JSON.parse(b.signals) : b.signals; } catch { continue; }
        if (!Array.isArray(sigs)) continue;
        const odds = parseFloat(b.odds) || 0;
        const impliedP = odds > 1 ? 1 / odds : 0.5;
        const won = b.uitkomst === 'W' ? 1 : b.uitkomst === 'L' ? 0 : null;
        for (const sig of sigs) {
          const name = String(sig).split(':')[0];
          if (!name) continue;
          if (!stats[name]) stats[name] = { n: 0, sumClv: 0, sumPnl: 0, lifts: [] };
          stats[name].n++;
          stats[name].sumClv += b.clv_pct;
          stats[name].sumPnl += parseFloat(b.wl || 0);
          if (won != null) stats[name].lifts.push(won - impliedP);
        }
      }

      const weights = loadSignalWeights();
      let written = 0;
      for (const [name, s] of Object.entries(stats)) {
        if (s.n < 10) continue;
        await snap.upsertSignalStat(supabase, {
          modelVersionId: _currentModelVersionId,
          signalName: name,
          sampleSize: s.n,
          avgClv: s.sumClv / s.n,
          avgPnl: s.sumPnl / s.n,
          liftVsMarket: s.lifts.length ? s.lifts.reduce((a, b) => a + b, 0) / s.lifts.length : null,
          weight: weights[name] || 1.0,
        });
        written++;
      }
      console.log(`📊 Signal stats refresh: ${written} signals geüpdatet`);
    } catch (e) {
      console.error('Signal stats refresh fout:', e.message);
    }
  }

  setTimeout(() => { refresh(); setInterval(refresh, INTERVAL_MS); }, 30 * 60 * 1000);
  console.log('📊 Signal stats refresh actief (dagelijks vanaf +30min)');
}

// ── TRAINING EXAMPLES WRITER (v9.11.0) ──────────────────────────────────────
// Bij elke result-check: voor settled bets met fixture_id én feature_snapshot,
// schrijf training_examples row zodat residual model later kan trainen.
// Idempotent: dedupe per (fixture, market_type) — herhaalde calls schrijven niet 2x.
async function writeTrainingExamplesForSettled() {
  try {
    const { data: bets } = await supabase.from('bets')
      .select('bet_id, fixture_id, markt, sport, uitkomst, datum')
      .in('uitkomst', ['W', 'L']).not('fixture_id', 'is', null);
    if (!bets?.length) return 0;
    let written = 0;
    for (const b of bets) {
      const marketType = detectMarket(b.markt || 'other');
      // Check of al bestaat
      const { data: existing } = await supabase.from('training_examples')
        .select('id').eq('fixture_id', b.fixture_id).eq('market_type', marketType).maybeSingle();
      if (existing?.id) continue;
      // Pak laatste feature_snapshot voor deze fixture
      const { data: feat } = await supabase.from('feature_snapshots')
        .select('id, captured_at').eq('fixture_id', b.fixture_id)
        .order('captured_at', { ascending: false }).limit(1).maybeSingle();
      const { data: cons } = await supabase.from('market_consensus')
        .select('id').eq('fixture_id', b.fixture_id).eq('market_type', marketType)
        .order('captured_at', { ascending: false }).limit(1).maybeSingle();
      // Label: 1 voor W, 0 voor L — generic; uitbreidbaar per markt-type later
      const label = { won: b.uitkomst === 'W' ? 1 : 0 };
      await snap.writeTrainingExample(supabase, {
        fixtureId: b.fixture_id, marketType,
        snapshotTime: feat?.captured_at || new Date().toISOString(),
        featureSnapshotId: feat?.id || null,
        marketConsensusId: cons?.id || null,
        label,
      });
      written++;
    }
    if (written) console.log(`📚 Training examples geschreven: ${written}`);
    return written;
  } catch (e) { console.error('writeTrainingExamples fout:', e.message); return 0; }
}

// ── AUTO-RETRAINING SCHEDULER (v9.10.0) ─────────────────────────────────────
// Wekelijks: check voor elke (sport, market_type) of er ≥500 settled
// pick_candidates zijn. Als ja: log dat deze markt klaar is voor residual
// model training. Echte training-pipeline (logistic regression fit) is
// placeholder; activeert pas wanneer we volume hebben om te valideren.
function scheduleAutoRetraining() {
  const INTERVAL_MS = 7 * 24 * 3600 * 1000; // weekly
  const MIN_PICKS = 500; // van lib/model-math.RESIDUAL_MIN_TRAINING_PICKS

  async function runRetrainCheck() {
    try {
      const { data: candidates } = await supabase.from('pick_candidates')
        .select('fixture_id, model_run_id');
      if (!candidates?.length) {
        console.log('📐 Auto-retrain: 0 pick_candidates, skip');
        return;
      }
      // Group by (sport, market_type) via model_runs
      const { data: runs } = await supabase.from('model_runs')
        .select('id, market_type, debug');
      const runMap = {};
      for (const r of (runs || [])) {
        runMap[r.id] = { market_type: r.market_type, sport: r.debug?.sport || 'multi' };
      }
      const buckets = {};
      for (const c of candidates) {
        const meta = runMap[c.model_run_id];
        if (!meta) continue;
        const key = `${meta.sport}_${meta.market_type}`;
        buckets[key] = (buckets[key] || 0) + 1;
      }
      const eligible = Object.entries(buckets).filter(([, n]) => n >= MIN_PICKS);
      if (eligible.length) {
        console.log(`📐 Auto-retrain: ${eligible.length} markten met ≥${MIN_PICKS} candidates klaar voor training:`);
        for (const [k, n] of eligible) console.log(`   - ${k}: ${n} candidates`);
        // TODO: feitelijke residual logistic regression training. Voor nu: log only.
        // De volgende stap zou zijn:
        // 1. Pull alle pick_candidates + bijbehorende settled bets (W/L)
        // 2. Pull feature_snapshots op pick-tijdstip (point-in-time correct)
        // 3. Train logistic regression: Y = bet won, X = features - market_baseline
        // 4. Schrijf coefficients naar model_versions.metrics.residual_coefficients
        // 5. Server.js residualModelDelta() leest deze coefficients
      } else {
        console.log(`📐 Auto-retrain: nog geen markt met ≥${MIN_PICKS} candidates (max ${Math.max(0, ...Object.values(buckets))})`);
      }
    } catch (e) {
      console.error('Auto-retrain check fout:', e.message);
    }
  }

  // Eerste run 1 uur na boot, dan wekelijks
  setTimeout(() => {
    runRetrainCheck();
    setInterval(runRetrainCheck, INTERVAL_MS);
  }, 60 * 60 * 1000);
  console.log('📐 Auto-retraining scheduler actief (wekelijks check vanaf +1u)');
}

// ── FIXTURE SNAPSHOT POLLING (v9.6.0) ────────────────────────────────────────
// Schrijft odds_snapshots throughout-the-day voor upcoming fixtures uit de
// fixtures tabel. Hierdoor krijgen we line-movement data voor latere
// CLV-analyse en walk-forward backtests.
//
// Cadence: elke 90 min. Cap: 30 fixtures per cycle (~30 API calls).
// Budget: ~480 API calls/dag, ruim binnen api-sports plan.
function scheduleFixtureSnapshotPolling() {
  const INTERVAL_MS = 90 * 60 * 1000; // 90 min
  const MAX_PER_CYCLE = 30;
  const WINDOW_HOURS = 8;

  async function runPolling() {
    try {
      const nowIso = new Date().toISOString();
      const winIso = new Date(Date.now() + WINDOW_HOURS * 3600 * 1000).toISOString();
      const { data: fixtures, error } = await supabase
        .from('fixtures')
        .select('id, sport, start_time')
        .eq('status', 'scheduled')
        .gte('start_time', nowIso)
        .lte('start_time', winIso)
        .order('start_time', { ascending: true })
        .limit(MAX_PER_CYCLE);
      if (error || !fixtures?.length) return;

      console.log(`📸 Odds polling: ${fixtures.length} upcoming fixtures (komende ${WINDOW_HOURS}u)`);
      let snapshotted = 0;
      for (const fix of fixtures) {
        try {
          const sport = normalizeSport(fix.sport);
          const cfg = getSportApiConfig(sport);
          await sleep(150); // gentle pacing
          const oddsResp = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: fix.id }).catch(() => []);
          if (!oddsResp?.length) continue;
          const first = oddsResp[0];
          // Voor football: ander parser-pad. Skip voor nu (komt via dagelijkse scan + dedicated football-monitor in latere sprint).
          if (sport === 'football') continue;
          const parsed = parseGameOdds([first], '', '');
          const rows = snap.flattenParsedOdds(parsed);
          if (!rows.length) continue;
          await snap.writeOddsSnapshots(supabase, fix.id, rows);
          snapshotted++;
        } catch { /* swallow */ }
      }
      if (snapshotted) console.log(`📸 ${snapshotted} odds-snapshots geschreven`);
    } catch (e) {
      console.error('Fixture snapshot polling fout:', e.message);
    }
  }

  // Start eerste cycle 5 min na boot, dan elke 90 min
  setTimeout(() => {
    runPolling();
    setInterval(runPolling, INTERVAL_MS);
  }, 5 * 60 * 1000);
  console.log('📸 Fixture snapshot polling actief (start over 5 min, dan elke 90 min)');
}

function scheduleOddsMonitor() {
  const INTERVAL_MS = 60 * 60 * 1000; // 60 min
  console.log('📈 Odds monitor actief (elke 60 min)');

  async function runOddsMonitor() {
    try {
      const { bets } = await readBets();
      const openBets = bets.filter(b => b.uitkomst === 'Open' && b.tijd);
      if (!openBets.length) return;

      const now = Date.now();
      let checksRun = 0;
      const MAX_CHECKS = 15; // max 15 fixtures per run (conservatief · ~30 API calls max)

      for (const bet of openBets) {
        if (checksRun >= MAX_CHECKS) break;

        // Bereken kickoff-tijd
        let kickoffMs;
        const tijdStr = bet.tijd;
        try {
          if (tijdStr.includes('T') || tijdStr.includes('-')) {
            kickoffMs = new Date(tijdStr).getTime();
          } else {
            const [h, m] = tijdStr.split(':').map(Number);
            const nowAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
            const amsIso = `${nowAms}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
            const probe = new Date();
            const utcH = probe.getUTCHours();
            const amsH = parseInt(probe.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
            const offsetMs = (amsH - utcH) * 3600000;
            kickoffMs = new Date(new Date(amsIso + 'Z').getTime() - offsetMs).getTime();
          }
        } catch { continue; }

        const minsToKo = (kickoffMs - now) / 60000;
        if (minsToKo < 0 || minsToKo > 720) continue; // alleen < 12 uur weg

        // Zoek fixture
        let fxId = bet.fixtureId;
        if (!fxId) {
          const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
          const parts = (bet.wedstrijd || '').split(' vs ').map(s => s.trim().toLowerCase());
          if (parts.length >= 2) {
            const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: today });
            checksRun++;
            const match = (fixtures || []).find(f => {
              const h = (f.teams?.home?.name || '').toLowerCase();
              const a = (f.teams?.away?.name || '').toLowerCase();
              return (h.includes(parts[0]) || parts[0].includes(h.split(' ').pop())) &&
                     (a.includes(parts[1]) || parts[1].includes(a.split(' ').pop()));
            });
            if (match) fxId = match.fixture?.id;
          }
        }
        if (!fxId) continue;

        const oddsData = await afGet('v3.football.api-sports.io', '/odds', { fixture: fxId });
        checksRun++;
        const rawBks   = oddsData?.[0]?.bookmakers || [];
        const userBk   = (bet.tip || 'bet365').toLowerCase();
        const bk       = rawBks.find(b => b.name?.toLowerCase().includes(userBk))
                      || rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
        if (!bk) continue;

        let currentOdds = null;
        const marktLc = (bet.markt || '').toLowerCase();

        if (marktLc.includes('over') || marktLc.includes('under')) {
          const ou = bk.bets?.find(b => b.id === 5);
          if (ou) {
            const lineMatch = marktLc.match(/(over|under)\s*(\d+\.?\d*)/);
            if (lineMatch) {
              const side = lineMatch[1].charAt(0).toUpperCase() + lineMatch[1].slice(1);
              const line = lineMatch[2];
              const val = ou.values?.find(v => v.value === `${side} ${line}`);
              if (val) currentOdds = parseFloat(val.odd) || null;
            }
          }
        } else if (marktLc.includes('wint') || marktLc.includes('winner')) {
          const mw = bk.bets?.find(b => b.id === 1);
          if (mw) {
            const isHome = marktLc.includes('🏠') || !marktLc.includes('✈️');
            const val = mw.values?.find(v => v.value === (isHome ? 'Home' : 'Away'));
            if (val) currentOdds = parseFloat(val.odd) || null;
          }
        } else if (marktLc.includes('btts') || marktLc.includes('beide')) {
          const btts = bk.bets?.find(b => b.id === 8);
          if (btts) {
            const val = btts.values?.find(v => v.value === (marktLc.includes('nee') || marktLc.includes('no') ? 'No' : 'Yes'));
            if (val) currentOdds = parseFloat(val.odd) || null;
          }
        } else if (marktLc.includes('gelijkspel') || marktLc.includes('draw')) {
          const mw = bk.bets?.find(b => b.id === 1);
          if (mw) {
            const val = mw.values?.find(v => v.value === 'Draw');
            if (val) currentOdds = parseFloat(val.odd) || null;
          }
        }

        if (!currentOdds) continue;

        const loggedOdds = parseFloat(bet.odds);
        const drift = (currentOdds - loggedOdds) / loggedOdds;
        const driftPct = (drift * 100).toFixed(1);

        if (Math.abs(drift) >= 0.05) {
          if (drift < 0) {
            await tg(`📉 ODDS ALERT: ${bet.wedstrijd} ${bet.markt} | ${loggedOdds} → ${currentOdds} (${driftPct}%) | Scherp geld bevestigt jouw kant`).catch(() => {});
          } else {
            await tg(`📈 ODDS ALERT: ${bet.wedstrijd} ${bet.markt} | ${loggedOdds} → ${currentOdds} (+${driftPct}%) | Markt draait · overweeg cashout`).catch(() => {});
          }
        }

        await sleep(150);
      }
    } catch (err) {
      console.error('Odds monitor error:', err.message);
    }
  }

  // Eerste run na 5 min, daarna elke 60 min
  setTimeout(() => {
    runOddsMonitor();
    setInterval(runOddsMonitor, INTERVAL_MS);
  }, 5 * 60 * 1000);
}

// ── SIGNAL ANALYSIS ENDPOINT ─────────────────────────────────────────────────
app.get('/api/signal-analysis', requireAdmin, async (req, res) => {
  try {
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const { bets } = await readBets(userId);
    const settledWithSignals = bets.filter(b => (b.uitkomst === 'W' || b.uitkomst === 'L') && b.signals);

    const signalMap = {}; // signalName → { count, wins, totalEdge }

    for (const bet of settledWithSignals) {
      let signals;
      try { signals = JSON.parse(bet.signals); } catch { continue; }
      if (!Array.isArray(signals)) continue;

      const won = bet.uitkomst === 'W';
      const edge = bet.clvPct || 0;

      for (const sig of signals) {
        // Parse signal name from format "name:+1.2%"
        const name = sig.split(':')[0];
        if (!signalMap[name]) signalMap[name] = { count: 0, wins: 0, totalEdge: 0 };
        signalMap[name].count++;
        if (won) signalMap[name].wins++;
        signalMap[name].totalEdge += edge;
      }
    }

    const signalAnalysis = Object.entries(signalMap).map(([name, data]) => ({
      name,
      betsCount: data.count,
      hitRate: +(data.wins / Math.max(1, data.count)).toFixed(3),
      avgEdge: +(data.totalEdge / Math.max(1, data.count)).toFixed(2),
    })).sort((a, b) => b.betsCount - a.betsCount);

    res.json({ signals: signalAnalysis });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// Timing analyse · CLV per timing bucket (uren voor aftrap)
app.get('/api/timing-analysis', requireAdmin, async (req, res) => {
  try {
    const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
    const { bets } = await readBets(userId);
    const settled = bets.filter(b => b.clvPct != null && b.clvPct !== 0 && b.tijd);
    const buckets = { 'Vroeg (>12h)': [], 'Medium (3-12h)': [], 'Laat (<3h)': [] };

    for (const b of settled) {
      // Parse bet datum + tijd → timestamp
      // b.datum = "dd-mm-yyyy", b.tijd = "HH:MM"
      if (!b.datum || !b.tijd) continue;
      const [dd, mm, yyyy] = b.datum.split('-').map(Number);
      const [hh, mi] = b.tijd.split(':').map(Number);
      if (!dd || !mm || !yyyy || isNaN(hh) || isNaN(mi)) continue;
      const betTime = new Date(yyyy, mm - 1, dd, hh, mi);

      // Kickoff time: if we have a kickoffTime stored, use it. Otherwise use 15:00 as default.
      // Many bets won't have kickoff stored, so try to infer from wedstrijd context
      let kickoffTime = null;
      if (b.kickoffTime) {
        const [kh, km] = b.kickoffTime.split(':').map(Number);
        if (!isNaN(kh) && !isNaN(km)) kickoffTime = new Date(yyyy, mm - 1, dd, kh, km);
      }

      if (!kickoffTime) {
        // Use a reasonable default: if bet was logged the same day, assume kickoff at 20:45
        kickoffTime = new Date(yyyy, mm - 1, dd, 20, 45);
      }

      const hoursBeforeKO = (kickoffTime.getTime() - betTime.getTime()) / 3600000;
      if (hoursBeforeKO < 0) continue; // bet logged after kickoff, skip

      if (hoursBeforeKO > 12) buckets['Vroeg (>12h)'].push(b);
      else if (hoursBeforeKO >= 3) buckets['Medium (3-12h)'].push(b);
      else buckets['Laat (<3h)'].push(b);
    }

    res.json({ buckets: Object.entries(buckets).map(([name, betsInBucket]) => ({
      name,
      count: betsInBucket.length,
      avgCLV: betsInBucket.length ? +(betsInBucket.reduce((s, b) => s + b.clvPct, 0) / betsInBucket.length).toFixed(2) : 0,
      hitRate: betsInBucket.length ? +(betsInBucket.filter(b => b.uitkomst === 'W').length / betsInBucket.length).toFixed(3) : 0
    }))});
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// ── UNIT SIZE CHANGE LOGGING ─────────────────────────────────────────────────
// UNIT_EUR is een const die wijzigt bij deploy. We loggen bij startup een event
// in de notifications-tabel zodra de waarde verschilt van de laatst bekende.
async function checkUnitSizeChange() {
  try {
    const { data: lastSetting } = await supabase.from('notifications').select('*')
      .eq('type', 'unit_change').order('created_at', { ascending: false }).limit(1).single();
    const lastUnit = lastSetting?.body?.match(/(\d+)/)?.[1];
    if (lastUnit && parseInt(lastUnit) !== UNIT_EUR) {
      await tg(`💰 Unit size gewijzigd: €${lastUnit} → €${UNIT_EUR} op ${new Date().toLocaleDateString('nl-NL')}`, 'unit_change');
      console.log(`💰 Unit size wijziging gelogd: €${lastUnit} → €${UNIT_EUR}`);
    } else if (!lastUnit) {
      // Geen eerdere setting: sla huidige waarde op als baseline
      await tg(`💰 Unit baseline: €${UNIT_EUR} vanaf ${new Date().toLocaleDateString('nl-NL')}`, 'unit_change');
      console.log(`💰 Unit baseline gelogd: €${UNIT_EUR}`);
    }
  } catch (e) {
    // Bij 'no rows' van single() komt hier ook een error – dan baseline schrijven
    try {
      await tg(`💰 Unit baseline: €${UNIT_EUR} vanaf ${new Date().toLocaleDateString('nl-NL')}`, 'unit_change');
      console.log(`💰 Unit baseline gelogd: €${UNIT_EUR}`);
    } catch {}
  }
}

// ── START ───────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 EdgePickr draait op http://localhost:${PORT}\n`);
  console.log(`   Prematch scan : POST /api/prematch (football + basketball + hockey + baseball + NFL + handball)`);
  console.log(`   Live scan     : POST /api/live`);
  console.log(`   Sports        : ${AF_FOOTBALL_LEAGUES.length} football + ${NBA_LEAGUES.length} basketball + ${NHL_LEAGUES.length} hockey + ${BASEBALL_LEAGUES.length} baseball + ${NFL_LEAGUES.length} NFL + ${HANDBALL_LEAGUES.length} handball leagues`);
  console.log(`   Bet tracker   : GET/POST /api/bets\n`);
  seedAdminUser().catch(e => console.error('Seed admin fout:', e.message));
  loadCalibAsync().then(() => console.log('📊 Calibratie geladen')).catch(() => {});
  loadSignalWeightsAsync().then(() => console.log('🔧 Signal weights geladen')).catch(() => {});
  loadScanHistoryFromSheets().then(h => console.log(`📜 Scan history geladen: ${h.length} entries`)).catch(() => {});
  loadPushSubs().then(s => console.log(`🔔 Push subs geladen: ${s.length}`)).catch(() => {});
  checkUnitSizeChange().catch(e => console.error('Unit size check fout:', e.message));
  scheduleDailyResultsCheck();
  scheduleDailyScan();
  scheduleOddsMonitor();
  scheduleFixtureSnapshotPolling();
  scheduleKickoffWindowPolling();
  scheduleAutoRetraining();
  scheduleSignalStatsRefresh();
  scheduleHealthAlerts();

  // Kill-switch initial load + 30-min refresh
  refreshKillSwitch().then(() => console.log(`🛑 Kill-switch geladen (${KILL_SWITCH.set.size} actief)`));
  setInterval(refreshKillSwitch, 30 * 60 * 1000);

  // Market sample counts cache voor adaptive MIN_EDGE
  refreshMarketSampleCounts().then(() => {
    const total = Object.values(_marketSampleCache.data).reduce((a, b) => a + b, 0);
    console.log(`📈 Market sample cache geladen (${Object.keys(_marketSampleCache.data).length} markten, ${total} settled)`);
  });
  setInterval(() => refreshMarketSampleCounts().catch(() => {}), 30 * 60 * 1000);

  // Registreer huidige model_version (idempotent) zodat model_runs ernaar kunnen wijzen
  snap.registerModelVersion(supabase, {
    name: 'edgepickr-heuristic',
    sport: 'multi', marketType: 'multi',
    versionTag: APP_VERSION,
    featureSetVersion: snap.FEATURE_SET_VERSION,
    status: 'active',
  }).then(id => {
    if (id) { _currentModelVersionId = id; console.log(`📐 Model version ${APP_VERSION} geregistreerd (id=${id})`); }
  }).catch(() => {});

  // Herplan pre-kickoff checks en CLV checks voor alle open bets bij herstart
  readBets().then(({ bets }) => {
    const openWithTime = bets.filter(b => b.uitkomst === 'Open' && b.tijd);
    openWithTime.forEach(b => {
      schedulePreKickoffCheck(b).catch(() => {});
      scheduleCLVCheck(b).catch(() => {});
    });
    console.log(`⏱  Pre-kickoff + CLV checks herplanned voor ${openWithTime.length} open bet(s)`);
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
// Accepteert zowel number (legacy: uur) als "HH:MM" string.
function scheduleScanAtHour(timeInput) {
  let hour, minute;
  if (typeof timeInput === 'number') { hour = timeInput; minute = 0; }
  else {
    const m = String(timeInput).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return;
    hour = parseInt(m[1]); minute = parseInt(m[2]);
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return;
  const label = `${String(hour).padStart(2,'0')}:${String(minute).padStart(2,'0')}`;

  const now    = new Date();
  const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const offsetMs = amsNow.getTime() - now.getTime();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);
  target.setTime(target.getTime() - offsetMs);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
  console.log(`📡 Scan gepland om ${hm} (over ${Math.round(delay/60000)} min)`);
  return setTimeout(async () => {
    console.log(`📡 Scan om ${label} gestart...`);
    try {
      await runPrematch(() => {});
      console.log(`📡 Scan om ${label} klaar`);
    } catch (e) {
      console.error(`Scan om ${label} fout:`, e.message);
      await tg(`⚠️ Scan om ${label} mislukt: ${e.message}`).catch(() => {});
    }
    // Herplan dezelfde scan voor morgen
    scheduleScanAtHour(timeInput);
  }, delay);
}

function scheduleDailyScan() {
  // Laad admin settings; plan scans en bewaar handles in userScanTimers[admin.id]
  // zodat rescheduleUserScans(admin) ze netjes kan opruimen en voorkomen dubbele scans.
  loadUsers().then(users => {
    const admin = users.find(u => u.role === 'admin');
    if (!admin) {
      // Geen admin-user bekend; plan een losse default-scan. Handle bewaren in _globalScanTimers.
      _globalScanTimers.push(scheduleScanAtHour('07:30'));
      return;
    }
    // Clear eventuele bestaande admin-timers voor we nieuwe plannen
    if (userScanTimers[admin.id]) {
      userScanTimers[admin.id].forEach(h => clearTimeout(h));
    }
    const times = admin.settings?.scanTimes?.length ? admin.settings.scanTimes : ['07:30'];
    userScanTimers[admin.id] = times.map(t => scheduleScanAtHour(t));
  }).catch(() => {
    _globalScanTimers.push(scheduleScanAtHour('07:30'));
  });
}
const _globalScanTimers = []; // fallback-handles als geen admin-user bekend is

// ── DAGELIJKSE UITSLAG CHECK (09:03 AM) ──────────────────────────────────────
function scheduleDailyResultsCheck() {
  const now    = new Date();
  // 06:00 Amsterdam-tijd → bereken UTC offset
  const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const offsetMs = amsNow.getTime() - now.getTime();
  const target = new Date(now);
  // Zet target op 06:00 Amsterdam = 06:00 - offset in UTC
  const amsTarget = new Date(now);
  amsTarget.setHours(6, 0, 0, 0);
  // Corrigeer naar UTC: als Amsterdam +2h is, dan UTC = 04:00
  target.setTime(amsTarget.getTime() - offsetMs);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
  console.log(`⏰ Dagelijkse check gepland om ${hm} (over ${Math.round(delay/60000)} min)`);

  setTimeout(async () => {
    console.log('⏰ Dagelijkse uitslag check gestart...');
    try {
      const { checked, updated, results } = await checkOpenBetResults();
      const { stats } = await readBets();
      const lines = [`📋 DAGELIJKSE CHECK · ${new Date().toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long' })}`];
      lines.push(`${checked} open bet${checked !== 1 ? 's' : ''} gecontroleerd | ${updated} auto-bijgewerkt\n`);
      for (const r of results) {
        const ico = r.uitkomst === 'W' ? '✅' : r.uitkomst === 'L' ? '❌' : '⚠️';
        lines.push(`${ico} ${r.wedstrijd}\n   ${r.markt} | ${r.score} → ${r.uitkomst || 'handmatig'}`);
      }
      if (!results.length) lines.push('Geen afgeronde wedstrijden gevonden voor open bets.');
      lines.push(`\n💰 Bankroll: €${stats.bankroll} | ROI: ${(stats.roi*100).toFixed(1)}%`);
      await tg(lines.join('\n')).catch(() => {});

      // Push notificatie met dagelijks overzicht
      const wCount = results.filter(r => r.uitkomst === 'W').length;
      const lCount = results.filter(r => r.uitkomst === 'L').length;
      const pushBody = results.length
        ? `${wCount}W / ${lCount}L · Bankroll: €${stats.bankroll} · ROI: ${(stats.roi*100).toFixed(1)}%`
        : `Geen afgeronde wedstrijden · Bankroll: €${stats.bankroll}`;
      await sendPushToAll({
        title: `📋 Dagelijks overzicht`,
        body: pushBody,
        tag: 'daily-results',
        url: '/',
      }).catch(() => {});
    } catch (e) {
      console.error('Daily check fout:', e);
      await tg(`⚠️ Dagelijkse check mislukt: ${e.message}`).catch(() => {});
    }

    // Auto-tune signalen na resultatencheck
    await autoTuneSignals().catch(e => console.error('Auto-tune fout:', e.message));
    // CLV-based autotune (sneller signal dan W/L) — draait dagelijks na results
    const clvTune = await autoTuneSignalsByClv().catch(e => ({ tuned: 0, error: e.message }));
    if (clvTune.tuned > 0) console.log(`📊 CLV autotune: ${clvTune.tuned} signal weights aangepast (${clvTune.muted || 0} gemute)`);

    scheduleDailyResultsCheck(); // plan volgende dag
  }, delay);
}
