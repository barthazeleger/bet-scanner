'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const { createClient } = require('@supabase/supabase-js');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');
const webpush        = require('web-push');

// ── SUPABASE CONFIG ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('FATAL: SUPABASE_URL and SUPABASE_KEY required'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const app = express();
app.use(express.json({ limit: '50kb' }));

// ── SECURITY HEADERS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
const APP_VERSION    = '7.0.0';
const TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT       = process.env.TELEGRAM_CHAT_ID || '';
const TG_URL     = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
const UNIT_EUR   = 10;
const START_BANKROLL = 100;
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
    scanTimes:     [10],
    scanEnabled:   true,
    twoFactorEnabled: false,
    telegramChatId: null,
    telegramEnabled: false,
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
  const times = user.settings.scanTimes || [10];
  userScanTimers[user.id] = times.map(h => scheduleScanAtHour(h));
}

// ── CALIBRATIE · leren van resultaten ────────────────────────────────────────
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
  // Model alleen trainen op admin data (voorkomt vervuiling door andere users)
  if (userId) {
    const users = _usersCache || [];
    const user = users.find(u => u.id === userId);
    if (user && user.role !== 'admin') return; // skip non-admin bets
  }
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
      signals: p.signals || [],
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
  supabase.from('notifications').insert({
    type, title, body: text, read: false, user_id: userId
  }).then(() => {}).catch(() => {});
};

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
const KELLY_FRACTION   = 0.50;  // half-Kelly: veiligst voor kleine bankroll (aanbevolen door Wharton)

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

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}) {
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
    // Gebaseerd op Wharton research: >3.5 is nadrukkelijk afgeraden
    const vP = odd > 3.50 ? 0.42
             : odd > 2.50 ? 0.65
             : odd > 2.00 ? 0.85
             : 1.0;

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
    const expectedEur = +(uNum * UNIT_EUR * (edge / 100)).toFixed(2);
    const pick = { match, league, label, odd, units: u, reason, prob, ep: +ep.toFixed(3),
                   strength: k*(odd-1)*vP*epW, kelly: hk, edge, expectedEur, kickoff, bookie,
                   signals: signals || [], referee: referee || null };

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

// Load persistent usage from Supabase at startup
(async () => {
  try {
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const { data } = await supabase.from('api_usage').select('*').eq('date', todayStr).single();
    if (data) {
      afRateLimit = { remaining: data.remaining, limit: data.api_limit || 7500, updatedAt: data.updated_at, callsToday: data.calls || 0, date: data.date };
    } else {
      afRateLimit.date = todayStr;
      afRateLimit.callsToday = 0;
    }
  } catch { afRateLimit.date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' }); }
})();

function saveAfUsage() {
  supabase.from('api_usage').upsert({
    date: afRateLimit.date, calls: afRateLimit.callsToday,
    remaining: afRateLimit.remaining, api_limit: afRateLimit.limit,
    updated_at: new Date().toISOString()
  }).then(() => {}).catch(() => {});
}

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
    const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    if (afRateLimit.date !== todayStr) { afRateLimit.callsToday = 0; afRateLimit.date = todayStr; }
    afRateLimit.callsToday++;
    if (rem !== null) {
      afRateLimit.remaining = parseInt(rem);
      afRateLimit.limit = parseInt(lim) || afRateLimit.limit;
    }
    afRateLimit.updatedAt = new Date().toISOString();
    saveAfUsage();
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
  const tier = callsUsed <= 100 ? 'free (100/dag)' : 'Pro (7500/dag)';
  emit({ log: `📊 api-football.com klaar · ${callsUsed} calls gebruikt (${tier})` });
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

  emit({ log: `🎯 Prematch scan · api-football.com (${AF_FOOTBALL_LEAGUES.length} competities, bet365 odds, lineups, predictions)` });

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
        // Vandaag: alles. Morgen: alleen vóór 10:00
        if (koDate === today) return true;
        return koH < cutoffHour;
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

  // Tag alle prematch picks als 'pre'
  for (const p of picks)     p.scanType = 'pre';
  for (const p of combiPool) p.scanType = 'pre';

  emit({ log: `📋 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${picks.length} pre-match picks` });

  // ── STAP 2b: LIVE PICKS mengen ───────────────────────────────────────────
  // Haalt live wedstrijden op met xG + live odds. Picks getagd als scanType:'live'.
  // Geen eigen Telegram · alles gaat samen in de finale pool.
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
    await tg(noMsg);
    emit({ log: `📭 Geen overtuigde picks (${allCandidates.length} kandidaten te zwak). Bericht gestuurd.`, picks: [] });
    return [];
  }

  const weakNote = weakCount > 0 ? ` (${weakCount} zwakke kandidaat${weakCount>1?'en':''} weggelaten)` : '';
  emit({ log: `🎯 ${finalPicks.length} overtuigde pick${finalPicks.length>1?'s':''}${weakNote}! Sturen naar Telegram...` });

  // ── TELEGRAM BERICHTEN ─────────────────────────────────────────────────────
  const todayLabel = new Date().toLocaleDateString('nl-NL',{day:'2-digit',month:'long',year:'numeric'});
  const pickWord = finalPicks.length === 1 ? 'OVERTUIGDE PICK' : `${finalPicks.length} OVERTUIGDE PICKS`;
  const header = `🌅 DAGELIJKSE PRE-MATCH SCAN\n📅 ${todayLabel}\n📊 ${totalEvents} wedstrijden geanalyseerd\n✅ ${pickWord} (van ${allCandidates.length} kandidaten)\n\n`;

  let msgs = [header];
  let cur  = 0;
  for (const [i, p] of finalPicks.entries()) {
    const star = i === 0 ? '⭐' : i === 1 ? '🔵' : '•';
    const typeTag = p.scanType === 'live' ? ' 🔴LIVE' : ' 🌅PRE';
    const refLine = p.referee ? `\n🟨 Scheidsrechter: ${p.referee}` : '';
    const line = `${star} PICK ${i+1}${typeTag}: ${p.match}\n${p.league}\n📌 ${p.label}\n💰 Odds: ${p.odd} | ${p.units}\n📈 Kans: ${p.prob}%${refLine}\n📊 ${p.reason}\n\n`;
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

  // Tag alle picks als 'live' en geef terug
  return picks.map(p => ({ ...p, scanType: 'live', fixtureId: undefined }));
}

// ── DAGELIJKSE LIVE CHECK (vanuit cron) ──────────────────────────────────────
async function runLive(emit) {
  emit({ log: '🔴 Live scan · xG + live odds + balbezit' });
  const calib = loadCalib();
  const livePicks = await getLivePicks(emit, calib.epBuckets || {});

  if (!livePicks.length) {
    await tg(`🔴 Live check · geen kwalificerende situaties op dit moment.`).catch(()=>{});
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
  const bankroll  = startBankroll + wlEur;
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
    const prob = b.score ? b.score / 100 : (b.odds > 1 ? 1 / b.odds : 0.5);
    return s + prob;
  }, 0).toFixed(2);
  const actualWins = W;
  const variance = +(actualWins - expectedWins).toFixed(2);
  const varianceStdDev = +Math.sqrt(settledBets.reduce((s, b) => {
    const prob = b.score ? b.score / 100 : (b.odds > 1 ? 1 / b.odds : 0.5);
    return s + prob * (1 - prob);
  }, 0)).toFixed(2);
  const luckFactor = varianceStdDev > 0 ? +(variance / varianceStdDev).toFixed(2) : 0;

  return { total, W, L, open, wlEur: +wlEur.toFixed(2), roi: +roi.toFixed(4),
           bankroll: +bankroll.toFixed(2), startBankroll, avgOdds, avgUnits, strikeRate, winU, lossU,
           avgCLV, clvPositive, clvTotal,
           expectedWins, actualWins, variance, varianceStdDev, luckFactor };
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
  }));
  return { bets, stats: calcStats(bets), _raw: data };
}

async function writeBet(bet, userId = null) {
  const inzet = bet.units * UNIT_EUR;
  const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2)
           : bet.uitkomst === 'L' ? -inzet : 0;
  const { error } = await supabase.from('bets').insert({
    bet_id: bet.id, datum: bet.datum, sport: bet.sport, wedstrijd: bet.wedstrijd,
    markt: bet.markt, odds: bet.odds, units: bet.units, inzet, tip: bet.tip || 'Bet365',
    uitkomst: bet.uitkomst || 'Open', wl, tijd: bet.tijd || '', score: bet.score || null,
    signals: bet.signals || '',
    user_id: userId || null,
  });
  if (error) throw new Error(error.message);
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
    const allowed = ['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled','twoFactorEnabled'];
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

  runPrematch(emit)
    .then(picks => {
      // Non-admin: filter gevoelige model data uit picks
      const safePicks = picks.map(p => {
        // Score server-side berekenen (zodat kelly niet naar de client hoeft)
        const hk = p.kelly || 0;
        const score = Math.min(10, Math.max(5, Math.round((hk - 0.015) / 0.135 * 5) + 5));
        const pick = { match: p.match, league: p.league, label: p.label, odd: p.odd, prob: p.prob, units: p.units, edge: p.edge, score, kickoff: p.kickoff, scanType: p.scanType, bookie: p.bookie };
        if (isAdmin) { pick.reason = p.reason; pick.kelly = p.kelly; pick.ep = p.ep; pick.strength = p.strength; pick.expectedEur = p.expectedEur; pick.signals = p.signals || []; }
        return pick;
      });
      emit({ done: true, picks: safePicks }); res.end(); scanRunning = false;
    })
    .catch(err  => { emit({ error: 'Scan mislukt' }); res.end(); scanRunning = false; });
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
    .catch(err  => { emit({ error: err.message }); res.end(); });
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

      // Haal huidige odds op via api-football.com
      let currentOdds = null;
      try {
        let fxId = bet.fixtureId;

        // Geen fixtureId? Zoek fixture op teamnamen
        if (!fxId) {
          const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
          const parts = (matchName || '').split(' vs ').map(s => s.trim().toLowerCase());
          if (parts.length >= 2) {
            const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: today });
            const match = (fixtures || []).find(f => {
              const h = (f.teams?.home?.name || '').toLowerCase();
              const a = (f.teams?.away?.name || '').toLowerCase();
              return (h.includes(parts[0]) || parts[0].includes(h.split(' ').pop())) &&
                     (a.includes(parts[1]) || parts[1].includes(a.split(' ').pop()));
            });
            if (match) fxId = match.fixture?.id;
          }
        }

        if (fxId) {
          const oddsData = await afGet('v3.football.api-sports.io', '/odds', { fixture: fxId });
          const rawBks   = oddsData?.[0]?.bookmakers || [];
          const userBk   = (bet.tip || 'bet365').toLowerCase();
          const bk       = rawBks.find(b => b.name?.toLowerCase().includes(userBk))
                        || rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
          if (bk) {
            const marktLc = markt.toLowerCase();
            let val = null;

            if (marktLc.includes('over') || marktLc.includes('under')) {
              // Over/Under goals · bet id 5
              const ou = bk.bets?.find(b => b.id === 5) || bk.bets?.find(b => (b.name||'').toLowerCase().includes('over'));
              if (ou) {
                // Zoek de juiste lijn (bijv. "Over 2.5" of "Under 2.5")
                const lineMatch = marktLc.match(/(over|under)\s*(\d+\.?\d*)/);
                if (lineMatch) {
                  const side = lineMatch[1].charAt(0).toUpperCase() + lineMatch[1].slice(1); // "Over" of "Under"
                  const line = lineMatch[2]; // "2.5"
                  val = ou.values?.find(v => v.value === `${side} ${line}`);
                }
              }
            } else if (marktLc.includes('wint') || marktLc.includes('winner')) {
              // Match Winner · bet id 1
              const mw = bk.bets?.find(b => b.id === 1);
              if (mw) {
                const isHome = marktLc.includes('🏠') || !marktLc.includes('✈️');
                val = mw.values?.find(v => v.value === (isHome ? 'Home' : 'Away'));
              }
            } else if (marktLc.includes('btts') || marktLc.includes('beide')) {
              // Both Teams To Score · bet id 8
              const btts = bk.bets?.find(b => b.id === 8) || bk.bets?.find(b => (b.name||'').toLowerCase().includes('both'));
              if (btts) val = btts.values?.find(v => v.value === 'Yes');
            }

            if (val) currentOdds = parseFloat(val.odd) || null;
          }
        }
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
          if (drift < -0.08) lines.push(`📉 Odds gedaald · markt wordt zekerder van het ANDERE resultaat. Overweeg de bet te annuleren.`);
          else lines.push(`📈 Odds gestegen · meer waarde dan verwacht. Bet ziet er goed uit.`);
        } else {
          lines.push(`\n✅ Odds stabiel: ${loggedOdds} → ${currentOdds} (${driftStr}) · geen significante marktbeweging.`);
        }
      } else {
        lines.push(`\n⚠️ Kon geen huidige odds ophalen · controleer odds handmatig.`);
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

      // Zoek fixture ID
      let fxId = bet.fixtureId;
      if (!fxId) {
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
        const parts = (matchName || '').split(' vs ').map(s => s.trim().toLowerCase());
        if (parts.length >= 2) {
          const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: today });
          const match = (fixtures || []).find(f => {
            const h = (f.teams?.home?.name || '').toLowerCase();
            const a = (f.teams?.away?.name || '').toLowerCase();
            return (h.includes(parts[0]) || parts[0].includes(h.split(' ').pop())) &&
                   (a.includes(parts[1]) || parts[1].includes(a.split(' ').pop()));
          });
          if (match) fxId = match.fixture?.id;
        }
      }

      if (!fxId) return;

      const oddsData = await afGet('v3.football.api-sports.io', '/odds', { fixture: fxId });
      const rawBks   = oddsData?.[0]?.bookmakers || [];
      // Gebruik de bookmaker waar de user daadwerkelijk bet (opgeslagen in tip field)
      const userBookie = (bet.tip || 'bet365').toLowerCase();
      const bk = rawBks.find(b => b.name?.toLowerCase().includes(userBookie))
              || rawBks.find(b => b.name?.toLowerCase().includes('bet365'))
              || rawBks[0];
      if (!bk) return;
      const usedBookie = bk.name || userBookie;

      let closingOdds = null;
      const marktLc = markt.toLowerCase();

      if (marktLc.includes('over') || marktLc.includes('under')) {
        const ou = bk.bets?.find(b => b.id === 5) || bk.bets?.find(b => (b.name||'').toLowerCase().includes('over'));
        if (ou) {
          const lineMatch = marktLc.match(/(over|under)\s*(\d+\.?\d*)/);
          if (lineMatch) {
            const side = lineMatch[1].charAt(0).toUpperCase() + lineMatch[1].slice(1);
            const line = lineMatch[2];
            const val = ou.values?.find(v => v.value === `${side} ${line}`);
            if (val) closingOdds = parseFloat(val.odd) || null;
          }
        }
      } else if (marktLc.includes('wint') || marktLc.includes('winner')) {
        const mw = bk.bets?.find(b => b.id === 1);
        if (mw) {
          const isHome = marktLc.includes('🏠') || !marktLc.includes('✈️');
          const val = mw.values?.find(v => v.value === (isHome ? 'Home' : 'Away'));
          if (val) closingOdds = parseFloat(val.odd) || null;
        }
      } else if (marktLc.includes('btts') || marktLc.includes('beide')) {
        const btts = bk.bets?.find(b => b.id === 8) || bk.bets?.find(b => (b.name||'').toLowerCase().includes('both'));
        if (btts) {
          const val = btts.values?.find(v => v.value === (marktLc.includes('nee') || marktLc.includes('no') ? 'No' : 'Yes'));
          if (val) closingOdds = parseFloat(val.odd) || null;
        }
      } else if (marktLc.includes('draw no bet') || marktLc.includes('dnb')) {
        const dnb = bk.bets?.find(b => b.id === 12) || bk.bets?.find(b => (b.name||'').toLowerCase().includes('draw no bet'));
        if (dnb) {
          const isHome = marktLc.includes('🏠') || !marktLc.includes('✈️');
          const val = dnb.values?.find(v => v.value === (isHome ? 'Home' : 'Away'));
          if (val) closingOdds = parseFloat(val.odd) || null;
        }
      } else if (marktLc.includes('gelijkspel') || marktLc.includes('draw')) {
        const mw = bk.bets?.find(b => b.id === 1);
        if (mw) {
          const val = mw.values?.find(v => v.value === 'Draw');
          if (val) closingOdds = parseFloat(val.odd) || null;
        }
      }

      if (!closingOdds) return;

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

// Uitkomst updaten
app.put('/api/bets/:id', async (req, res) => {
  try {
    const userId = req.user?.id;
    const { uitkomst, odds, units, tip } = req.body || {};
    const id = parseInt(req.params.id);
    if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });
    if (uitkomst && !['Open', 'W', 'L'].includes(uitkomst)) return res.status(400).json({ error: 'Uitkomst moet Open, W of L zijn' });
    const updates = {};
    if (odds != null) updates.odds = parseFloat(odds);
    if (units != null) { updates.units = parseFloat(units); updates.inzet = +(parseFloat(units) * UNIT_EUR).toFixed(2); }
    if (tip) updates.tip = tip;
    if (Object.keys(updates).length) {
      let updateQuery = supabase.from('bets').update(updates).eq('bet_id', id);
      if (userId) updateQuery = updateQuery.eq('user_id', userId);
      await updateQuery;
    }
    if (uitkomst) await updateBetOutcome(id, uitkomst, userId);
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
  res.json({ prematch: lastPrematchPicks, live: lastLivePicks });
});

// POTD (Pick of the Day) post generator voor Reddit + X
app.get('/api/potd', requireAdmin, async (req, res) => {
  try {
    let allPicks = [...lastPrematchPicks, ...lastLivePicks];
    // Fallback: laad uit scan history als geheugen leeg is (na deploy)
    if (!allPicks.length) {
      const history = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
      if (history.length) allPicks = history[0].picks || [];
    }
    if (!allPicks.length) return res.json({ error: 'Geen picks beschikbaar · draai eerst een scan' });

    // #1 pick = hoogste expectedEur
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
app.get('/api/scan-history', async (req, res) => {
  const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
  if (userId) {
    // Per-user scan history from Supabase
    try {
      const { data, error } = await supabase.from('scan_history').select('*')
        .eq('user_id', userId).order('ts', { ascending: false }).limit(SCAN_HISTORY_MAX);
      if (error) throw new Error(error.message);
      const history = (data || []).map(r => ({
        ts: r.ts, type: r.type, totalEvents: r.total_events, picks: r.picks || []
      }));
      return res.json(history);
    } catch { /* fallback below */ }
  }
  const history = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
  res.json(history);
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
        plan: 'Pro',
        remaining: afRateLimit.remaining,
        limit: afRateLimit.limit || 7500,
        callsToday: afRateLimit.callsToday || 0,
        usedPct: Math.round((afRateLimit.callsToday || 0) / (afRateLimit.limit || 7500) * 100),
        updatedAt: afRateLimit.updatedAt,
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
    leagues: AF_FOOTBALL_LEAGUES.map(l => ({ id: l.id, name: l.name, key: l.key, ha: l.ha })),
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
  res.json({
    log: (c.modelLog || []).slice(0, 30),
    lastUpdated: c.modelLastUpdated || null,
    totalSettled: c.totalSettled || 0,
    signalWeights: sw,
    markets: c.markets || {},
    epBuckets: c.epBuckets || {},
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

  // Gebruik api-football voor uitslagen (vervangt ESPN)
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const [todayFixtures, yesterdayFixtures] = await Promise.all([
    afGet('v3.football.api-sports.io', '/fixtures', { date: today }),
    afGet('v3.football.api-sports.io', '/fixtures', { date: yesterday }),
  ]);
  const FINISHED_STATUSES = new Set(['FT','AET','PEN']);
  const allFinished = [...(todayFixtures || []), ...(yesterdayFixtures || [])]
    .filter(f => FINISHED_STATUSES.has(f.fixture?.status?.short))
    .map(f => ({
      home:   f.teams?.home?.name || '',
      away:   f.teams?.away?.name || '',
      scoreH: f.goals?.home ?? 0,
      scoreA: f.goals?.away ?? 0,
    }));

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

    // Live en vandaag geplande wedstrijden ophalen in parallel
    // Gebruik Amsterdam-datum zodat we rond middernacht de juiste dag tonen
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
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

// ── START ───────────────────────────────────────────────────────────────────
const PORT = 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 EdgePickr draait op http://localhost:${PORT}\n`);
  console.log(`   Prematch scan : POST /api/prematch`);
  console.log(`   Live scan     : POST /api/live`);
  console.log(`   Bet tracker   : GET/POST /api/bets\n`);
  seedAdminUser().catch(e => console.error('Seed admin fout:', e.message));
  loadCalibAsync().then(() => console.log('📊 Calibratie geladen')).catch(() => {});
  loadSignalWeightsAsync().then(() => console.log('🔧 Signal weights geladen')).catch(() => {});
  loadScanHistoryFromSheets().then(h => console.log(`📜 Scan history geladen: ${h.length} entries`)).catch(() => {});
  loadPushSubs().then(s => console.log(`🔔 Push subs geladen: ${s.length}`)).catch(() => {});
  scheduleDailyResultsCheck();
  scheduleDailyScan();
  scheduleOddsMonitor();

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
function scheduleScanAtHour(hour) {
  const now    = new Date();
  // hour is Amsterdam-tijd → converteer naar UTC
  const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const offsetMs = amsNow.getTime() - now.getTime();
  const target = new Date(now);
  target.setHours(hour, 0, 0, 0);
  target.setTime(target.getTime() - offsetMs);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
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

    scheduleDailyResultsCheck(); // plan volgende dag
  }, delay);
}
