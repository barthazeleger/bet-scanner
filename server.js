'use strict';

const express        = require('express');
const path           = require('path');
const fs             = require('fs');
const { createClient } = require('@supabase/supabase-js');
const jwt            = require('jsonwebtoken');
const bcrypt         = require('bcryptjs');
const webpush        = require('web-push');
const { APP_VERSION } = require('./lib/app-meta');
const { createCalibrationStore } = require('./lib/calibration-store');
const {
  calcWinProb,
  fairProbs,
  fairProbs2Way,
  parseGameOdds,
  setPreferredBookies,
  getPreferredBookies,
  bestOdds,
  bookiePrice,
  bestFromArr,
  diagBestPrice,
  bestSpreadPick,
  buildSpreadFairProbFns,
  convertAfOdds,
} = require('./lib/odds-parser');
const {
  createPickContext,
  buildPickFactory: createPickFactory,
  calcForm,
  calcMomentum,
  calcStakes,
  calcOverProb,
  calcBTTSProb,
  analyseTotal,
} = require('./lib/picks');
const { summarizeExecutionQuality, normalizeBookmaker } = require('./lib/execution-quality');
const { fetchNhlGoaliePreview } = require('./lib/nhl-goalie-preview');
const { applyCorrelationDamp } = require('./lib/correlation-damp');
const { supportsApiSportsInjuries } = require('./lib/api-sports-capabilities');
const { shouldRunPostResultsModelJobs } = require('./lib/daily-results');
const { isV1LiveStatus, shouldIncludeDatedV1Game } = require('./lib/live-board');
const { matchesClvRecomputeTarget, resolveEarlyLiveOutcome } = require('./lib/operator-actions');

// Snapshot layer (v2 foundation): point-in-time logging voor learning + backtesting
const snap = require('./lib/snapshots');
let _currentModelVersionId = null; // gevuld bij boot (registerModelVersion)

// ── OPERATOR FAILSAFES (v10.2.1, persistent v10.2.3) ────────────────────────
// Minimale set toggles voor noodgevallen. Default: alles automatisch.
// Persistent: opgeslagen in admin user settings.operator zodat deploys/restarts
// de actieve mode niet wegvegen.
const OPERATOR = {
  master_scan_enabled: true,
  market_auto_kill_enabled: true,
  signal_auto_kill_enabled: true,
  panic_mode: false,
  max_picks_per_day: 5,
  // v10.9.0: master-switch voor externe data-aggregatie (sofascore/fotmob/nba-stats/nhl-api/mlb-stats-ext).
  // Default uit → pas inschakelen na productie-smoketest via admin endpoint.
  scraping_enabled: false,
};

async function loadOperatorState() {
  try {
    const users = await loadUsers().catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    const persisted = admin?.settings?.operator;
    if (persisted && typeof persisted === 'object') {
      for (const k of Object.keys(OPERATOR)) {
        if (persisted[k] !== undefined) OPERATOR[k] = persisted[k];
      }
      KILL_SWITCH.enabled = OPERATOR.market_auto_kill_enabled;
      console.log(`⚙️ Operator state geladen uit admin settings`);
    }
  } catch (e) { /* swallow */ }
}

async function saveOperatorState() {
  try {
    const users = await loadUsers(true).catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    if (!admin) return;
    admin.settings = { ...(admin.settings || {}), operator: { ...OPERATOR } };
    await supabase.from('users').update({ settings: admin.settings }).eq('id', admin.id);
  } catch (e) { /* swallow */ }
}

// ── KILL-SWITCH CACHE ──────────────────────────────────────────────────────
// Set van market-keys (sport_market) die geblokkeerd zijn op basis van negatieve CLV.
// Refreshed elke 30 min uit /api/admin/v2/clv-stats logica.
const KILL_SWITCH = {
  set: new Set(),
  thresholds: { kill_min_n: 30, watchlist_clv: -2.0, auto_disable_clv: -5.0 },
  lastRefreshed: 0,
  enabled: true, // master flag; admin kan dit later via UI uitzetten
};

// v10.10.22 fase 3: gecombineerde bets-refresh. Voorheen 3 aparte full-table
// scans (refreshKillSwitch, refreshMarketSampleCounts, refreshSportCaps) die
// elk dezelfde tabel opvroegen. Nu: één query, drie consumers.
let _settledBetsCache = { rows: [], at: 0 };
const SETTLED_BETS_TTL_MS = 5 * 60 * 1000;
async function loadSettledBetsOnce() {
  if (_settledBetsCache.rows.length && Date.now() - _settledBetsCache.at < SETTLED_BETS_TTL_MS) return _settledBetsCache.rows;
  try {
    const { data } = await supabase.from('bets')
      .select('sport, markt, uitkomst, inzet, wl, clv_pct')
      .in('uitkomst', ['W', 'L']);
    _settledBetsCache = { rows: data || [], at: Date.now() };
    return _settledBetsCache.rows;
  } catch { return _settledBetsCache.rows; }
}

async function refreshKillSwitch() {
  if (!KILL_SWITCH.enabled) { KILL_SWITCH.set.clear(); return; }
  try {
    const bets = await loadSettledBetsOnce();
    const all = bets.filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct));
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
let _marketSampleCache = { data: {}, at: 0 };
const MARKET_SAMPLE_TTL_MS = 30 * 60 * 1000; // 30 min

async function refreshMarketSampleCounts() {
  try {
    const bets = await loadSettledBetsOnce();
    const counts = {};
    for (const b of bets) {
      const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    _marketSampleCache = { data: counts, at: Date.now() };
  } catch { /* swallow */ }
}

// v10.8.16: per-sport cap voor de diversification-stap in runFullScan.
// Default 2 picks per sport. Bij bewezen sport (≥100 settled bets én ROI≥5%)
// mag het naar 3. In panic_mode altijd 1. Cache-refresh om de 10 min zodat de
// scan geen extra DB-hit doet per run.
const SPORT_CAP_PROVEN_N = 100;
const SPORT_CAP_PROVEN_ROI = 0.05;
const SPORT_CAP_TTL_MS = 10 * 60 * 1000;
let _sportCapCache = { caps: {}, stats: {}, at: 0 };

async function refreshSportCaps() {
  try {
    const bets = await loadSettledBetsOnce();
    const bySport = {};
    for (const b of bets) {
      const s = normalizeSport(b.sport || 'football');
      if (!bySport[s]) bySport[s] = { n: 0, staked: 0, profit: 0 };
      bySport[s].n++;
      bySport[s].staked += parseFloat(b.inzet) || 0;
      bySport[s].profit += parseFloat(b.wl) || 0;
    }
    const caps = {};
    const stats = {};
    for (const [s, d] of Object.entries(bySport)) {
      const roi = d.staked > 0 ? d.profit / d.staked : 0;
      caps[s] = (d.n >= SPORT_CAP_PROVEN_N && roi >= SPORT_CAP_PROVEN_ROI) ? 3 : 2;
      stats[s] = { n: d.n, roi: +(roi * 100).toFixed(2), cap: caps[s] };
    }
    _sportCapCache = { caps, stats, at: Date.now() };
  } catch { /* swallow */ }
}

function getSportCap(sport) {
  if (OPERATOR.panic_mode) return 1;
  const key = normalizeSport(sport || 'unknown');
  return _sportCapCache.caps[key] || 2;
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
    refreshMarketSampleCounts().catch(e => console.warn('Market samples refresh failed:', e.message));
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
  getKellyFraction, setKellyFraction, KELLY_FRACTION_MIN, KELLY_FRACTION_MAX, KELLY_FRACTION_STEP,
  poisson, poissonOver, poisson3Way,
  devigProportional, consensus3Way, deriveIncOTProbFrom3Way, modelMarketSanityCheck,
  normalizeTeamName, teamMatchScore, normalizeSport,
  detectMarket, calcKelly, kellyToUnits, kellyScore, epBucketKey,
  pitcherAdjustment, pitcherReliabilityFactor, goalieAdjustment,
  injurySeverityWeight, nbaAvailabilityAdjustment,
  shotsDifferentialAdjustment, recomputeWl, summarizeSignalMetrics,
  shrinkFormScore,
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
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https://cdn.jsdelivr.net",
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
// v10.10.22 fase 3: cleanup expired entries elke 10 min (voorkomt unbounded growth bij distributed traffic)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

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
    // v10.10.22 fix: user_id meegeven zodat sendPushToUser kan filteren.
    // Voorheen: alleen r.subscription → user_id was altijd undefined.
    _pushSubsCache = (data || []).map(r => ({ ...r.subscription, user_id: r.user_id || null }));
    return _pushSubsCache;
  } catch { return []; }
}

// v10.10.22: push subscriptions per-user. Voorheen global broadcast naar
// ALLE subscribers — cross-user data-leak (Codex P0 finding). Nu: userId
// wordt meegestuurd bij subscribe en opgeslagen in de subscription-row.
// sendPushToUser filtert op userId. Fallback sendPushToAll alleen voor
// operator-brede alerts (scan-klaar, model-updates).
async function savePushSub(sub, userId = null) {
  if (!sub?.endpoint) return;
  const row = { endpoint: sub.endpoint, subscription: sub, created_at: new Date().toISOString() };
  if (userId) row.user_id = userId;
  await supabase.from('push_subscriptions').upsert(row, { onConflict: 'endpoint' });
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

// v10.10.22: per-user push — stuurt alleen naar subscriptions van die user.
async function sendPushToUser(userId, payload) {
  if (!userId) return sendPushToAll(payload);
  const subs = await loadPushSubs();
  const dead = [];
  const userSubs = subs.filter(s => s.user_id === userId);
  for (const sub of userSubs) {
    try { await webpush.sendNotification(sub, JSON.stringify(payload)); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) dead.push(sub.endpoint); }
  }
  if (dead.length) {
    for (const ep of dead) await deletePushSub(ep);
  }
}

// ── EMAIL (Resend) ─────────────────────────────────────────────────────────
// v10.10.22: sendEmail returnt nu success/failure zodat 2FA fail-closed kan.
async function sendEmail(to, subject, html) {
  const RESEND_KEY = process.env.RESEND_KEY;
  if (!RESEND_KEY) return false;
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'EdgePickr <noreply@edgepickr.com>',
        to, subject, html
      })
    });
    return resp.ok;
  } catch { return false; }
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
// v10.10.22 fase 2: UUID-validatie voor .or() interpolaties (defense-in-depth).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// v10.10.22 fase 2: /api/status verwijderd uit publieke paden (lekte model-stats + API-usage).
const PUBLIC_PATHS = new Set(['/api/auth/login', '/api/auth/register', '/api/auth/verify-code']);

// JWT middleware
// v10.10.22: DB-backed auth — herlaadt live user-status/role uit database.
// Voorheen werden JWT-claims 30 dagen vertrouwd; blocked users en gedegradeerde
// admins hielden volledige toegang tot token-expiry. Nu: elke request checkt
// actuele status/role via loadUsers() (30s TTL cache, geen extra DB-call per
// request). Blocked/pending users worden direct geweigerd, role komt uit DB.
async function requireAuth(req, res, next) {
  const auth = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  let claims;
  try { claims = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Invalid or expired token' }); }
  try {
    const users = await loadUsers();
    const dbUser = users.find(u => u.id === claims.id);
    if (!dbUser) return res.status(401).json({ error: 'User not found' });
    if (dbUser.status === 'blocked') return res.status(403).json({ error: 'Account blocked' });
    if (dbUser.status === 'pending') return res.status(403).json({ error: 'Account pending approval' });
    req.user = { ...claims, role: dbUser.role, status: dbUser.status };
    next();
  } catch {
    req.user = claims;
    next();
  }
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
const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2', '.ttf']);
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

// v10.9.9: dynamic UNIT_EUR. Admin's settings.unitEur override de globale
// constant zodat compounding (unit €25 → €50 → €100) de pick-ranking en
// expectedEur meeschuift zonder code-deploy. `mkP` leest synchrone cache —
// `refreshActiveUnitEur()` wordt bij elke scan-start aangeroepen.
let _activeUnitEur = UNIT_EUR;
let _activeStartBankroll = START_BANKROLL;
function getActiveUnitEur() { return _activeUnitEur; }
function getActiveStartBankroll() { return _activeStartBankroll; }
async function refreshActiveUnitEur() {
  try {
    const users = await loadUsers().catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    const ue = parseFloat(admin?.settings?.unitEur);
    if (isFinite(ue) && ue > 0 && ue < 10000) _activeUnitEur = ue;
    const sb = parseFloat(admin?.settings?.startBankroll);
    if (isFinite(sb) && sb > 0 && sb < 1000000) _activeStartBankroll = sb;
  } catch { /* keep defaults */ }
}

// v10.9.8: helper voor single-operator scoping. Alle bankroll/ROI-adviezen
// gebruiken admin's bets zodat niet-admin-data nooit in beslissingen meeweegt.
// Gememorized per-proces (admin-id verandert zelden).
let _cachedAdminUserId = null;
async function getAdminUserId() {
  if (_cachedAdminUserId) return _cachedAdminUserId;
  try {
    const users = await loadUsers().catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    if (admin?.id) _cachedAdminUserId = admin.id;
    return _cachedAdminUserId || null;
  } catch { return null; }
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

const calibrationStore = createCalibrationStore({ supabase, baseDir: __dirname });
const loadCalib = calibrationStore.loadSync;
const loadCalibAsync = calibrationStore.load;
const saveCalib = calibrationStore.save;

// detectMarket() komt uit lib/model-math.js

async function updateCalibration(bet, userId = null) {
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
    const money = await getUserMoneySettings(userId);
    const roi = c.totalProfit / Math.max(1, c.totalSettled * money.unitEur) * 100;
    const wr = c.totalWins / c.totalSettled * 100;
    const entry = {
      date: new Date().toISOString(), type: 'milestone',
      note: `🏆 ${c.totalSettled} bets milestone! Win rate: ${wr.toFixed(0)}% · ROI: ${roi.toFixed(1)}% · P/L: €${c.totalProfit.toFixed(2)}`
    };
    c.modelLog = [entry, ...(c.modelLog || [])].slice(0, 50);
    let msg = `🏆 MILESTONE: ${c.totalSettled} BETS\n📊 Win rate: ${wr.toFixed(0)}%\n💰 ROI: ${roi.toFixed(1)}%\n💵 P/L: €${c.totalProfit.toFixed(2)}`;
    if (c.totalSettled === 50 && roi > 10) {
      msg += `\n\n✅ ROI > 10% na 50 bets · overweeg unit verhoging naar €${Math.round(money.unitEur * 1.5)}`;
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
  } catch (e) {
    console.warn('loadSignalWeightsAsync failed, using cached/default:', e.message);
  }
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

// ── Kelly-fraction auto-stepup ───────────────────────────────────────────────
// Verhoogt KELLY_FRACTION (bv. 0.50 → 0.55 → 0.60 ... → 0.75 cap) als bewezen
// edge over voldoende bets. Stapsgewijs (max 1 stap/dag), nooit naar full Kelly
// automatisch (handmatige override vereist via setKellyFraction).
const KELLY_STEPUP_MIN_TOTAL_BETS = 200;  // start pas na 200 settled bets totaal
const KELLY_STEPUP_RECENT_WINDOW  = 200;  // criterium over laatste N bets
const KELLY_STEPUP_MIN_AVG_CLV    = 2.0;  // gem. CLV > 2% over recent window
const KELLY_STEPUP_MIN_ROI        = 5.0;  // ROI > 5% over recent window
const KELLY_STEPUP_COOLDOWN_DAYS  = 30;   // min 30 dagen tussen stappen

async function evaluateKellyAutoStepup() {
  const c = loadCalib();
  const cur = getKellyFraction();
  if (cur >= KELLY_FRACTION_MAX) return { stepped: false, reason: 'at_max' };
  if ((c.totalSettled || 0) < KELLY_STEPUP_MIN_TOTAL_BETS) {
    return { stepped: false, reason: 'insufficient_total_bets' };
  }
  // Cooldown check
  const lastStep = c.kellyHistory?.[0]?.date ? new Date(c.kellyHistory[0].date).getTime() : 0;
  if (lastStep && (Date.now() - lastStep) < KELLY_STEPUP_COOLDOWN_DAYS * 86400000) {
    return { stepped: false, reason: 'cooldown' };
  }
  // Recent CLV + ROI check via Supabase
  let recentBets;
  try {
    const r = await supabase.from('bets')
      .select('clv_pct,wl,inzet,uitkomst')
      .in('uitkomst', ['W','L'])
      .order('datum', { ascending: false })
      .limit(KELLY_STEPUP_RECENT_WINDOW);
    if (r.error) throw new Error(r.error.message);
    recentBets = r.data || [];
  } catch (e) {
    return { stepped: false, reason: `bets_fetch_failed:${e.message}` };
  }
  if (recentBets.length < KELLY_STEPUP_RECENT_WINDOW) {
    return { stepped: false, reason: 'insufficient_recent_bets' };
  }
  const clvVals = recentBets.map(b => parseFloat(b.clv_pct)).filter(v => isFinite(v));
  const avgClv = clvVals.length ? clvVals.reduce((a,b) => a+b, 0) / clvVals.length : null;
  const totalStake = recentBets.reduce((a,b) => a + (parseFloat(b.inzet) || 0), 0);
  const totalPnl   = recentBets.reduce((a,b) => a + (parseFloat(b.wl)    || 0), 0);
  const roi = totalStake > 0 ? (totalPnl / totalStake) * 100 : 0;
  // Kill-switch check: als markten gekild zijn afgelopen 30 dagen → niet stepup
  const killedRecently = (c.modelLog || []).some(e =>
    e.type === 'kill_switch' &&
    new Date(e.date).getTime() > Date.now() - 30 * 86400000);
  if (killedRecently) return { stepped: false, reason: 'kill_switch_active' };
  if (avgClv === null || avgClv < KELLY_STEPUP_MIN_AVG_CLV) {
    return { stepped: false, reason: `avg_clv_${avgClv?.toFixed(2)}` };
  }
  if (roi < KELLY_STEPUP_MIN_ROI) {
    return { stepped: false, reason: `roi_${roi.toFixed(2)}` };
  }
  // Alle criteria gehaald → step up
  const next = Math.min(KELLY_FRACTION_MAX, cur + KELLY_FRACTION_STEP);
  setKellyFraction(next);
  c.kellyFraction = next;
  c.kellyHistory = [{
    date: new Date().toISOString(), from: cur, to: next,
    avgClv: +avgClv.toFixed(2), roi: +roi.toFixed(2), totalSettled: c.totalSettled
  }, ...(c.kellyHistory || [])].slice(0, 20);
  c.modelLog = [{
    date: new Date().toISOString(), type: 'kelly_stepup',
    note: `🚀 Kelly-fraction verhoogd: ${cur.toFixed(2)} → ${next.toFixed(2)} (avg CLV ${avgClv.toFixed(2)}%, ROI ${roi.toFixed(2)}% over ${recentBets.length} bets)`
  }, ...(c.modelLog || [])].slice(0, 50);
  await saveCalib(c);
  // Notifications
  const msg = `🚀 KELLY-FRACTION VERHOOGD\n${cur.toFixed(2)} → ${next.toFixed(2)}\n📈 Avg CLV: ${avgClv.toFixed(2)}% · ROI: ${roi.toFixed(2)}%\n📊 Over ${recentBets.length} bets · totaal ${c.totalSettled}`;
  await tg(msg).catch(() => {});
  try {
    await supabase.from('notifications').insert({
      type: 'kelly_stepup',
      title: `🚀 Kelly-fraction: ${cur.toFixed(2)} → ${next.toFixed(2)}`,
      body: `Bewezen edge over ${recentBets.length} bets (CLV ${avgClv.toFixed(2)}%, ROI ${roi.toFixed(2)}%). Cap: ${KELLY_FRACTION_MAX}.`,
      read: false, user_id: null,
    });
  } catch (e) {
    console.error('Kelly stepup notification insert failed:', e.message);
  }
  return { stepped: true, from: cur, to: next, avgClv, roi };
}

async function autoTuneSignalsByClv() {
  // Operator failsafe: signal-kill mode kan worden uitgeschakeld via dashboard.
  // Dan tunet de functie nog wel weights, maar de mute (weight=0) wordt overgeslagen.
  const muteAllowed = OPERATOR.signal_auto_kill_enabled !== false;
  try {
    const { data: bets } = await supabase.from('bets')
      .select('signals, clv_pct, sport, markt').not('clv_pct', 'is', null);
    const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct) && b.signals);
    if (all.length < 30) return { tuned: 0, adjustments: [], note: 'te weinig CLV data (<30)' };

    const signalStats = summarizeSignalMetrics(all.map(b => ({
      marketKey: `${normalizeSport(b.sport || 'football')}_${detectMarket(b.markt || 'other')}`,
      clvPct: b.clv_pct,
      signalNames: parseBetSignals(b.signals).map(s => String(s).split(':')[0]).filter(Boolean),
    }))).signals;

    const weights = loadSignalWeights();
    const adjustments = [];
    let tuned = 0, muted = 0;
    for (const [name, s] of Object.entries(signalStats)) {
      if (s.n < 20) continue;
      const avgClv = s.avgClv;
      const edgeClv = s.shrunkExcessClv;
      const old = weights[name] !== undefined ? weights[name] : 1.0;
      let newW = old;
      let reason = null;
      // KILL-SWITCH: structureel negatieve CLV met genoeg samples → mute
      // (alleen als operator signal_auto_kill_enabled = true)
      if (muteAllowed && s.n >= SIGNAL_KILL_MIN_N && edgeClv <= -1.5 && avgClv <= -0.5) {
        newW = 0;
        reason = `auto_disabled (edge_clv ${edgeClv.toFixed(2)}%, raw ${avgClv.toFixed(2)}% over ${s.n} bets)`;
        muted++;
      } else if (old === 0 && s.n >= SIGNAL_KILL_MIN_N && edgeClv >= 0.75 && avgClv > 0) {
        // AUTO-PROMOTE: signal stond op 0 (logged-only of gemute) maar bewijst nu edge → activeren
        newW = 0.5;
        reason = `auto_promoted (edge_clv +${edgeClv.toFixed(2)}%, raw +${avgClv.toFixed(2)}% over ${s.n} bets · weight 0 → 0.5)`;
      } else if (edgeClv < -1.0) newW = Math.max(0.3, old * 0.92);
      else if (edgeClv > 1.0) newW = Math.min(1.5, old * 1.05);
      else if (edgeClv < -0.25) newW = Math.max(0.3, old * 0.97);
      else if (edgeClv > 0.25) newW = Math.min(1.5, old * 1.02);
      else newW = old * 0.99 + 0.01;

      if (Math.abs(newW - old) >= 0.02 || reason) {
        weights[name] = +newW.toFixed(3);
        adjustments.push({
          name, old: +old.toFixed(3), new: +newW.toFixed(3),
          avgClv: +avgClv.toFixed(2), edgeClv: +edgeClv.toFixed(2), n: s.n, reason
        });
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
  // v10.9.8: admin-scoped. Portfolio-analyse advies is persoonlijk voor de
  // operator, geen globale aggregaat over meerdere user-bets.
  const adminUserId = await getAdminUserId();
  const money = await getUserMoneySettings(adminUserId);
  const { stats: s } = await readBets(adminUserId, money);
  if (c.totalSettled < 5) return; // te weinig data

  const roi      = s.roi ?? 0;
  const bankroll = s.bankroll ?? money.startBankroll;
  const profit   = bankroll - money.startBankroll;
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
  const bankrollGrowth = bankroll - money.startBankroll;
  const currentUnit = money.unitEur;
  if (bankrollGrowth >= money.startBankroll) {
    lines.push(`💰 UNIT VERHOGING: Bankroll +100% (€${bankroll.toFixed(0)}) → overweeg unit van €${currentUnit} naar €${currentUnit*2}`);
  } else if (bankrollGrowth >= money.startBankroll * 0.5) {
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
  if (bankrollGrowth >= money.startBankroll) {
    inboxEntries.push({
      date: new Date().toISOString(), type: 'upgrade_advice',
      note: `💰 Bankroll +100% (€${bankroll.toFixed(0)}) · unit verhoging naar €${currentUnit*2} aanbevolen`
    });
  } else if (bankrollGrowth >= money.startBankroll * 0.5) {
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
    const { bets } = await readBets(await getAdminUserId());
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
  } catch (e) {
    // v10.7.22: fail-safe default 0.6 bij crash ipv 1.0 — als drawdown-logic
    // stuk is zijn we liever voorzichtiger dan minder.
    console.error('Drawdown protection crash, fail-safe naar 0.6:', e.message);
    return 0.6;
  }
  return 1.0;
}

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}, sport = 'football') {
  const ctx = createPickContext({
    sport,
    drawdownMultiplier: getDrawdownMultiplier,
    activeUnitEur: getActiveUnitEur(),
    adaptiveMinEdge,
  });
  return createPickFactory(MIN_ODDS, calibEpBuckets, ctx);
}

// (fetchEspnStandings removed · api-football standings provide rank/form/goals)

// ═══════════════════════════════════════════════════════════════════════════════
// API-SPORTS.IO ENRICHMENT · vorm, H2H, blessures, scheidsrechter, team-stats
// ═══════════════════════════════════════════════════════════════════════════════

// Session-caches (worden éénmaal per scan gevuld)
// v10.8.0: centralized parser voor bets.signals kolom (jsonb of text in schema).
// Standaardiseert alle reads zodat bug bij schema-change maar op één plek zit.
function parseBetSignals(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  }
  return [];
}

const afCache = {
  teamStats: {},   // key=sport_key, value: { teamNameLower: { form, goalsFor, goalsAgainst, winPct, teamId } }
  injuries:  {},   // key=sport_key, value: { teamNameLower: [{ player, type }] }
  referees:  {},   // key='home vs away' (lower), value: { name, yellowsPerGame, redsPerGame }
  h2h:       {},   // key='id1-id2', value: { hmW, awW, dr, n, avgGoals, bttsRate }
  lastPlayed:{},   // v10.7.24: key=sport, value: { teamId: ISO date string of last completed fixture }
};
// v10.8.0: reset lastPlayed cache dagelijks (anders blijft null-cache voor
// onbekende teams permanent). h2h/teamStats worden per scan gewist.
setInterval(() => { afCache.lastPlayed = {}; }, 24 * 60 * 60 * 1000);

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

// v10.10.22 fase 3: saveAfUsage debounced. Voorheen werd dit bij ELKE
// api-sports call aangeroepen (600+ Supabase writes per scan). Nu: debounce
// naar max 1x per 30 seconden. Flush bij scan-einde via de existing
// saveAfUsage() call in scan-coordinator.
let _afUsageDirty = false;
let _afUsageTimer = null;
function saveAfUsage() {
  _afUsageDirty = true;
  if (_afUsageTimer) return; // debounce actief
  _afUsageTimer = setTimeout(() => {
    _afUsageTimer = null;
    if (!_afUsageDirty) return;
    _afUsageDirty = false;
    _flushAfUsage();
  }, 30 * 1000);
}
function _flushAfUsage() {
  supabase.from('api_usage').upsert({
    date: afRateLimit.date, calls: afRateLimit.callsToday,
    remaining: afRateLimit.remaining, api_limit: afRateLimit.limit,
    updated_at: new Date().toISOString()
  }).then(() => {}).catch(() => {});
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

// Generieke stakes-berekening op basis van rank binnen competitie.
// Per sport verschillen de playoff/degradatie drempels:
// - Basketball (NBA): playoff = top 50% per conference
// - Hockey (NHL): playoff = top 50% per conference
// - Baseball (MLB): playoff = top 5 van 30 ≈ 17%
// - NFL: playoff = 7 van 16 per conference ≈ 44%
// - Handball: Euro-plekken variëren, hanteer top 20%
// Retourneert { label, adj } waar adj een fractionele boost is (-0.06 tot +0.10).
const STAKES_CFG = {
  basketball:        { topPct: 0.20, playoffPct: 0.50, bottomPct: 0.80, bottomAdj: 0.06, topAdj: 0.06, playoffAdj: 0.03, noStakesAdj: -0.05 },
  hockey:            { topPct: 0.20, playoffPct: 0.50, bottomPct: 0.80, bottomAdj: 0.06, topAdj: 0.06, playoffAdj: 0.03, noStakesAdj: -0.05 },
  baseball:          { topPct: 0.17, playoffPct: 0.33, bottomPct: 0.83, bottomAdj: 0.04, topAdj: 0.05, playoffAdj: 0.03, noStakesAdj: -0.04 },
  'american-football': { topPct: 0.25, playoffPct: 0.44, bottomPct: 0.75, bottomAdj: 0.05, topAdj: 0.06, playoffAdj: 0.04, noStakesAdj: -0.05 },
  handball:          { topPct: 0.20, playoffPct: 0.40, bottomPct: 0.80, bottomAdj: 0.08, topAdj: 0.06, playoffAdj: 0.03, noStakesAdj: -0.06 },
};
function calcStakesByRank(rank, totalTeams, sport) {
  if (!rank || !totalTeams || totalTeams < 4) return { label: '', adj: 0 };
  const cfg = STAKES_CFG[sport] || STAKES_CFG.basketball;
  const pct = rank / totalTeams;
  if (pct >= cfg.bottomPct) return { label: '🔴 Onderaan/Degradatie', adj: cfg.bottomAdj };
  if (pct <= cfg.topPct)    return { label: '🏆 Titelrace',           adj: cfg.topAdj };
  if (pct <= cfg.playoffPct) return { label: '⭐ Playoff-strijd',       adj: cfg.playoffAdj };
  if (pct >= 0.40 && pct <= 0.70) return { label: '😴 Niets te spelen', adj: cfg.noStakesAdj };
  return { label: '', adj: 0 };
}

// Conservatief: twijfel = blessure. Universele status-matcher voor alle sports.
// Telt: out, doubtful, questionable, day-to-day, IR, injured, suspended (speelt niet).
// Telt niet: probable (speelt waarschijnlijk wel), healthy, active, resting (coach-decision).
function isInjured(status) {
  if (!status) return false;
  const s = String(status).toLowerCase();
  if (s.includes('probable') || s.includes('healthy') || s.includes('active')) return false;
  return s.includes('out') || s.includes('doubt') || s.includes('question') ||
         s.includes('day-to-day') || s.includes('day to day') || s.includes('ir ') ||
         s.includes('injured') || s.includes('suspen');
}

// Pre-fetch football fixtures om te bepalen welke leagues actief zijn vandaag.
// Bespaart ~40 calls/scan door standings/injuries alleen te laden voor
// competities die daadwerkelijk matches hebben in de window.
let _footballFixturesCache = {}; // league.key → filtered fixtures[]

async function preFetchFootballFixtures(emit, today, tomorrow, dateFrom, dateTo) {
  if (!AF_KEY) return new Set();
  _footballFixturesCache = {};
  const active = new Set();
  emit({ log: '🔍 Pre-fetch fixtures — bepaal actieve competities...' });
  let calls = 0;
  for (const league of AF_FOOTBALL_LEAGUES) {
    try {
      const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', {
        league: league.id, season: league.season, from: dateFrom, to: dateTo, status: 'NS',
      });
      calls++;
      const cutoffHour = 10;
      const filtered = (fixtures || []).filter(f => {
        const ko = new Date(f.fixture?.date);
        const koH = parseInt(ko.toLocaleTimeString('en-US', { hour:'numeric', hour12:false, timeZone:'Europe/Amsterdam' }));
        const koDate = ko.toLocaleDateString('sv-SE', { timeZone:'Europe/Amsterdam' });
        if (koDate === today) return true;
        if (koDate === tomorrow) return koH < cutoffHour;
        return false;
      });
      _footballFixturesCache[league.key] = filtered;
      if (filtered.length > 0) active.add(league.key);
      await sleep(60);
    } catch (e) {
      console.warn(`Pre-fetch fixtures failed voor ${league.key}:`, e.message);
    }
  }
  emit({ log: `✅ Pre-fetch klaar: ${active.size}/${AF_FOOTBALL_LEAGUES.length} competities actief (${calls} calls)` });
  return active;
}

async function enrichWithApiSports(emit, activeSoccerKeys = null) {
  if (!AF_KEY) return;
  emit({ log: '📡 api-sports.io: ⚽ voetbal-data ophalen (standings, blessures, scheidsrechters) voor actieve competities...' });

  let callsUsed = 0;
  const MAX_CALLS = 85; // bewaar buffer
  let skippedInactive = 0;

  // Wis session-caches
  afCache.teamStats = {}; afCache.injuries = {}; afCache.referees = {}; afCache.h2h = {};

  // ── STAP 1: Standings + teamIDs per league (1 call per league) ───────────
  // AF_LEAGUE_MAP keys matchen AF_FOOTBALL_LEAGUES.key (bv 'epl', 'egypt').
  // Skip leagues zonder matches in scan-window (bespaart ~40 calls/scan).
  for (const [sportKey, cfg] of Object.entries(AF_LEAGUE_MAP)) {
    if (callsUsed >= MAX_CALLS) break;
    if (activeSoccerKeys && !activeSoccerKeys.has(sportKey)) {
      skippedInactive++;
      continue;
    }
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
    } catch (e) {
      console.warn(`Standings fetch failed voor ${sportKey}:`, e.message);
    }
  }
  emit({ log: `✅ ⚽ Standings voetbal: ${Object.keys(afCache.teamStats).length} competities geladen (${callsUsed} calls${skippedInactive ? `, ${skippedInactive} inactief geskipt` : ''})` });

  // ── STAP 2: Blessures per competitie (1 call per league) ─────────────────
  // FIX: gebruik AF_LEAGUE_MAP direct (was .startsWith('soccer') filter die 0 items teruggaf).
  for (const [sportKey, cfg] of Object.entries(AF_LEAGUE_MAP)) {
    if (callsUsed >= MAX_CALLS) break;
    if (activeSoccerKeys && !activeSoccerKeys.has(sportKey)) continue;
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
    } catch (e) {
      console.warn(`Injuries fetch failed voor ${sportKey}:`, e.message);
    }
  }
  const injCount = Object.values(afCache.injuries).reduce((s,v) => s + Object.keys(v).length, 0);
  emit({ log: `✅ ⚽ Blessures voetbal: ${injCount} teams met geblesseerde spelers (${callsUsed} calls)` });

  // ── STAP 3: Aankomende fixtures met scheidsrechter (top leagues) ─────────
  // FIX: keys matchen nu AF_FOOTBALL_LEAGUES.key (was 'soccer_' prefix die niet bestond).
  const topLeaguesForRef = ['epl','laliga','bundesliga','seriea','ligue1','eredivisie'];
  for (const sportKey of topLeaguesForRef) {
    const cfg = AF_LEAGUE_MAP[sportKey];
    if (!cfg || callsUsed >= MAX_CALLS) break;
    if (activeSoccerKeys && !activeSoccerKeys.has(sportKey)) continue;
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
    } catch (e) {
      console.warn(`Referees fetch failed voor ${sportKey}:`, e.message);
    }
  }
  emit({ log: `✅ ⚽ Scheidsrechters voetbal: ${Object.keys(afCache.referees).length} wedstrijden (${callsUsed} calls)` });
  emit({ log: `📊 Voetbal-enrichment klaar · ${callsUsed} calls (multi-sport data wordt per-league binnen elk sport-loop opgehaald)` });
}

// v10.7.25: aggregate-score helper voor 2-leg knockout ties (CL/EL/Conference,
// domestic cups). Bij 2e leg fetchen we de 1e leg via H2H en berekenen totaal.
// Team leading aggregate → defensiever (over% zakt, BTTS% zakt); trailing →
// moet scoren → BTTS% omhoog, over% omhoog. Phase 2: nu signaal logging +
// damping van form-signal omdat aggregaat-druk vorm in de schaduw zet.
async function fetchAggregateScore(hmId, awId, roundStr, seasonYear) {
  if (!AF_KEY || !hmId || !awId) return null;
  try {
    // H2H recent 5 matches — 1e leg is meestal 1-2 weken eerder.
    const rows = await afGet('v3.football.api-sports.io', '/fixtures/headtohead', {
      h2h: `${hmId}-${awId}`, last: 5
    });
    if (!Array.isArray(rows) || !rows.length) return null;

    // v10.7.25: api-sports labelt leg niet altijd expliciet — soms alleen
    // "Semi-finals" voor beide legs. Zoek breed: zelfde season, status FT,
    // binnen 30 dagen, en stage-match (quarter/semi/final/round of X).
    const now = Date.now();
    const THIRTY_DAYS = 30 * 86400000;
    const currentStage = (roundStr.match(/(quarter|semi|final|round of \d+)/i) || [])[1]?.toLowerCase();

    const candidates = rows.filter(f => {
      const rd = String(f.league?.round || '').toLowerCase();
      const status = f.fixture?.status?.short;
      const kickoff = new Date(f.fixture?.date || 0).getTime();
      const sameSeason = !seasonYear || f.league?.season === seasonYear;
      const finished = status === 'FT' || status === 'AET' || status === 'PEN';
      const recent = kickoff > 0 && (now - kickoff) < THIRTY_DAYS;
      // Stage match: als we weten wat de stage is, eis dezelfde stage; anders accepteer
      const stageMatch = !currentStage || rd.includes(currentStage);
      return sameSeason && finished && recent && stageMatch;
    });
    if (!candidates.length) return null;

    // Kies de meest recente kandidaat (1e leg)
    candidates.sort((a, b) => new Date(b.fixture?.date || 0) - new Date(a.fixture?.date || 0));
    const firstLeg = candidates[0];

    const hG1 = firstLeg.goals?.home ?? 0;
    const aG1 = firstLeg.goals?.away ?? 0;
    const firstHome = firstLeg.teams?.home?.id;
    const firstAway = firstLeg.teams?.away?.id;
    // In de 2e leg zijn teams meestal omgedraaid (home wordt away).
    let aggHome, aggAway;
    if (hmId === firstAway) { aggHome = aG1; aggAway = hG1; }
    else if (hmId === firstHome) { aggHome = hG1; aggAway = aG1; }
    else return null;
    return { aggHome, aggAway, firstLegScore: `${hG1}-${aG1}`, firstLegFxId: firstLeg.fixture?.id,
             firstLegRound: firstLeg.league?.round };
  } catch (e) {
    console.warn('fetchAggregateScore failed:', e.message);
    return null;
  }
}

function buildAggregateInfo(aggHome, aggAway) {
  if (aggHome == null || aggAway == null) return { signals: [], note: '' };
  const diff = aggHome - aggAway; // positief = huidige thuis team leidt aggregaat
  const signals = [];
  let note = '';
  if (diff === 0) {
    signals.push('leg2_all_square:0%');
    note = ` | 🏆 Aggregaat gelijk (${aggHome}-${aggAway})`;
  } else if (diff > 0) {
    signals.push('leg2_home_leads_agg:0%');
    if (diff >= 2) signals.push('leg2_home_leads_big:0%');
    note = ` | 🏆 Aggregaat thuis leidt ${aggHome}-${aggAway}`;
  } else {
    signals.push('leg2_away_leads_agg:0%');
    if (-diff >= 2) signals.push('leg2_away_leads_big:0%');
    note = ` | 🏆 Aggregaat uit leidt ${aggAway}-${aggHome}`;
  }
  return { signals, note, aggDiff: diff };
}

// v10.7.24: rest-days helper — haalt laatste gespeelde fixture op en cached
// per (sport, teamId). Rest-days is een edge-signaal vooral voor NBA/NHL
// back-to-back situaties, MLB lange road-trips, en voetbal midweek-CL effect.
// Phase 1: signaal logging only (weight=0, auto-promote via CLV).
async function fetchLastPlayedDate(sport, cfg, teamId, beforeKickoffMs) {
  if (!AF_KEY || !teamId) return null;
  if (!afCache.lastPlayed[sport]) afCache.lastPlayed[sport] = {};
  const cached = afCache.lastPlayed[sport][teamId];
  if (cached !== undefined) return cached; // null ook geldig (= niet gevonden)
  try {
    const path = cfg.host.includes('football') ? '/fixtures' : '/games';
    const rows = await afGet(cfg.host, path, { team: teamId, last: 1 });
    // Extract date from response — structure varies per sport api-sports
    let dateStr = null;
    const row = rows?.[0];
    if (row) {
      dateStr = row.fixture?.date || row.date || row.timestamp || null;
    }
    // Cache ook null zodat we niet nogmaals fetchen voor onbekende team
    afCache.lastPlayed[sport][teamId] = dateStr;
    await sleep(80);
    return dateStr;
  } catch (e) {
    console.warn(`fetchLastPlayedDate failed voor ${sport}/${teamId}:`, e.message);
    afCache.lastPlayed[sport][teamId] = null;
    return null;
  }
}

// Bereken rest-days + maak signal/note.
// Thresholds per sport:
//   NBA/NHL: <2 dagen = tired (back-to-back)
//   MLB:     <1 dag = tired (uncommon, usually off-days)
//   NFL:     <4 dagen = short week
//   Football:<3 dagen = midweek after CL/EL
function buildRestDaysInfo(sport, kickoffMs, homeLastDate, awayLastDate) {
  const msPerDay = 86400000;
  const hmDays = homeLastDate ? Math.max(0, (kickoffMs - new Date(homeLastDate).getTime()) / msPerDay) : null;
  const awDays = awayLastDate ? Math.max(0, (kickoffMs - new Date(awayLastDate).getTime()) / msPerDay) : null;
  const threshold = sport === 'basketball' || sport === 'hockey' ? 2
                  : sport === 'american-football' ? 4
                  : sport === 'football' ? 3 : 1;
  const homeTired = hmDays !== null && hmDays < threshold;
  const awayTired = awDays !== null && awDays < threshold;
  // Signaal: logging-only (waarde=0%, weight=0 default in autoTune, promote via CLV)
  const signals = [];
  if (homeTired) signals.push('rest_days_home_tired:0%');
  if (awayTired) signals.push('rest_days_away_tired:0%');
  // Mismatch: 1 team rust, ander niet
  if (hmDays !== null && awDays !== null && Math.abs(hmDays - awDays) >= 3) {
    signals.push(hmDays > awDays ? 'rest_mismatch_home_advantage:0%' : 'rest_mismatch_away_advantage:0%');
  }
  // Menselijke note
  let note = '';
  if (hmDays !== null && awDays !== null) {
    const hmStr = hmDays < 1 ? `${(hmDays*24).toFixed(0)}u` : `${Math.round(hmDays)}d`;
    const awStr = awDays < 1 ? `${(awDays*24).toFixed(0)}u` : `${Math.round(awDays)}d`;
    if (homeTired || awayTired || Math.abs(hmDays - awDays) >= 2) {
      note = ` | 🛌 rust: thuis ${hmStr} / uit ${awStr}`;
    }
  }
  return { hmDays, awDays, homeTired, awayTired, signals, note };
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

      // ── nba_injury_diff (logged-only, conservatief: twijfel = blessure) ──
      const nbaInjuryMap = {};
      const nbaInjuryLoadMap = {};
      let nbaInjTotal = 0;
      let nbaInjResp = [];
      if (supportsApiSportsInjuries('v1.basketball.api-sports.io')) {
        await sleep(120);
        nbaInjResp = await afGet('v1.basketball.api-sports.io', '/injuries', {
          league: league.id, season: league.season
        }).catch(() => []);
        apiCallsUsed++;
        for (const inj of (nbaInjResp || [])) {
          const tid = inj.team?.id;
          if (!tid) continue;
          const severity = injurySeverityWeight(inj.player?.status || inj.status, 'basketball');
          if (severity > 0) {
            nbaInjuryMap[tid] = (nbaInjuryMap[tid] || 0) + 1;
            nbaInjuryLoadMap[tid] = +(nbaInjuryLoadMap[tid] || 0) + severity;
            nbaInjTotal++;
          }
        }
        emit({ log: `🏀 ${league.name}: ${nbaInjTotal} blessures geladen (${Object.keys(nbaInjuryMap).length} teams, gewogen load ${Object.values(nbaInjuryLoadMap).reduce((s,v)=>s+v,0).toFixed(1)}, api returned ${nbaInjResp?.length || 0} rows)` });
      } else {
        emit({ log: `🏀 ${league.name}: blessurefeed niet ondersteund door API-Sports (skip)` });
      }

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

      // ── nba_rest_days scaffolding (logged-only, geen scoring impact) ──
      // Fetch -2 en -3 dagen voor granulaire rest_days berekening.
      // Doel: data verzamelen voor toekomstige activatie via CLV-bewijs.
      const lastPlayedDayMap = {}; // teamId → days_ago (1, 2, 3, of 4+)
      for (const tId of playedYesterday) lastPlayedDayMap[tId] = 1;
      const todayMs = new Date(today).getTime();
      for (let dAgo = 2; dAgo <= 3; dAgo++) {
        await sleep(80);
        const dStr = new Date(todayMs - dAgo * 86400000).toISOString().slice(0, 10);
        const olderGames = await afGet('v1.basketball.api-sports.io', '/games', {
          date: dStr, league: league.id, season: league.season
        }).catch(() => []);
        apiCallsUsed++;
        for (const g of (olderGames || [])) {
          const st = g.status?.short || '';
          if (st !== 'FT' && st !== 'AOT') continue;
          const ids = [g.teams?.home?.id, g.teams?.away?.id].filter(Boolean);
          for (const tId of ids) {
            if (lastPlayedDayMap[tId] === undefined) lastPlayedDayMap[tId] = dAgo;
          }
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

        // v10.7.24: rest-days (phase 1) — kritiek voor NBA back-to-backs
        let restInfo = { signals: [], note: '', hmDays: null, awDays: null };
        try {
          const cfgBk = { host: 'v1.basketball.api-sports.io' };
          const [hmLast, awLast] = await Promise.all([
            fetchLastPlayedDate('basketball', cfgBk, hmId, kickoffMs),
            fetchLastPlayedDate('basketball', cfgBk, awId, kickoffMs),
          ]);
          restInfo = buildRestDaysInfo('basketball', kickoffMs, hmLast, awLast);
        } catch (e) { console.warn('Rest-days (basketball) fetch failed:', e.message); }

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
          formAdj = Math.max(-0.05, Math.min(0.05, (shrinkFormScore(fmScore(hmSt.form)) - shrinkFormScore(fmScore(awSt.form))) / 15 * 0.04));
        }

        // Back-to-back penalty: -4%
        let b2bAdj = 0, b2bNote = '';
        if (hmId && playedYesterday.has(hmId)) { b2bAdj -= 0.04; b2bNote += ` | ⚠️ ${hm.split(' ').pop()} B2B`; }
        if (awId && playedYesterday.has(awId)) { b2bAdj += 0.04; b2bNote += ` | ⚠️ ${aw.split(' ').pop()} B2B`; }

        // ── nba_rest_days_diff scaffolding (logged-only) ──
        // Positief = home meer rust (voordeel). Negatief = away meer rust.
        // 4 = "4+ dagen rest" (cap, anders zou data sparse zijn).
        const restHome = lastPlayedDayMap[hmId] !== undefined ? lastPlayedDayMap[hmId] : 4;
        const restAway = lastPlayedDayMap[awId] !== undefined ? lastPlayedDayMap[awId] : 4;
        const nbaRestDaysDiff = restHome - restAway;

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
        let splitSourceTag = '';
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
        // v10.9.0: fallback naar stats.nba.com als api-sports standings dun zijn.
        if (OPERATOR.scraping_enabled && homeSplitAdj === 0) {
          try {
            const agg = require('./lib/data-aggregator');
            const [hmExt, awExt] = await Promise.all([
              agg.getTeamSummary('basketball', hm),
              agg.getTeamSummary('basketball', aw),
            ]);
            if (hmExt && awExt) {
              const hmHG = (hmExt.homeWin || 0) + (hmExt.homeLoss || 0);
              const awAG = (awExt.roadWin || 0) + (awExt.roadLoss || 0);
              if (hmHG >= 5 && awAG >= 5) {
                const hmWR = hmExt.homeWin / hmHG;
                const awWR = awExt.roadWin / awAG;
                const diff = hmWR - awWR;
                if (Math.abs(diff) > 0.15) {
                  homeSplitAdj = Math.min(0.04, Math.max(-0.04, diff * 0.08));
                  splitNote = ` | H/A:${hmWR.toFixed(2)}/${awWR.toFixed(2)} [nba-stats]`;
                  splitSourceTag = 'nba-stats';
                }
              }
            }
          } catch { /* swallow */ }
        }

        const totalAdv = ppgAdj + rebAdj + homeSplitAdj;

        // Experimenteel: nba_rest_days_diff + nba_injury_diff. Weight start op 0 (logged-only).
        // Auto-promotie via autoTuneSignalsByClv zodra n≥50 en CLV > 0%.
        const _sw = loadSignalWeights();
        const restWeight = _sw.nba_rest_days_diff !== undefined ? _sw.nba_rest_days_diff : 0;
        const injWeight = _sw.nba_injury_diff !== undefined ? _sw.nba_injury_diff : 0;
        const nbaInjuryHome = +(nbaInjuryLoadMap[hmId] || 0);
        const nbaInjuryAway = +(nbaInjuryLoadMap[awId] || 0);
        const nbaInjuryDiff = +(nbaInjuryAway - nbaInjuryHome).toFixed(2); // + = away meer blessures = home voordeel
        const nbaAvailability = nbaAvailabilityAdjustment(
          { restDays: restHome, injuryLoad: nbaInjuryHome },
          { restDays: restAway, injuryLoad: nbaInjuryAway },
        );
        // v10.10.3 fix: voorheen werden nbaAvailability.adj + restAdj + nbaInjAdj
        // domweg opgeteld, terwijl nbaAvailability.adj zelf al rest+inj bevat.
        // Bij default weights (0) merkbaar geen probleem, maar zodra CLV-autotune
        // nba_rest_days_diff/nba_injury_diff promoot naar weight>0 ontstond een
        // dubbeltelling van rust+blessure-impact (tot ~6-9% home-bias).
        // Nu: nbaAvailability is de canonieke combined rest+injury adjustment.
        // De losse weight-paden vangen alleen RESIDUAL boven nbaAvailability:
        // restAdj/nbaInjAdj × (weight-1) als weight ≥ 1.0, anders 0. Voorkomt
        // dubbele cascadering en houdt CLV-autotune-pad open voor handgematigde
        // weight-overrides.
        const restResidualMult = Math.max(0, restWeight - 1);
        const injResidualMult = Math.max(0, injWeight - 1);
        const restResidualAdj = nbaRestDaysDiff * 0.008 * restResidualMult;
        const injResidualAdj = nbaInjuryDiff * 0.006 * injResidualMult;
        const availabilityAdj = nbaAvailability.adj + restResidualAdj + injResidualAdj;

        // Stakes signal (playoff-race / niets te spelen) — logged-only scaffolding
        const nbaTotalTeams = Object.keys(standingsMap).length;
        const hmStakes = calcStakesByRank(hmSt?.rank, nbaTotalTeams, 'basketball');
        const awStakes = calcStakesByRank(awSt?.rank, nbaTotalTeams, 'basketball');
        const stakesWeight = _sw.stakes !== undefined ? _sw.stakes : 0;
        const stakesAdj = (hmStakes.adj - awStakes.adj) * stakesWeight;
        const stakesNote = (hmStakes.label || awStakes.label) ? ` | Stakes: ${hmStakes.label||'—'} vs ${awStakes.label||'—'}` : '';

        // v10.8.16: ha uit adjHome — fpHome komt uit market consensus (inclusief HA).
        const ha = 0;
        const adjHome = Math.min(0.88, fpHome + posAdj + formAdj + b2bAdj + totalAdv + availabilityAdj + stakesAdj);
        const adjAway = Math.max(0.08, fpAway - posAdj * 0.5 - formAdj * 0.5 - b2bAdj * 0.5 - totalAdv * 0.5 - availabilityAdj * 0.5 - stakesAdj * 0.5);

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
        // Logged-only experimentele signalen
        if (nbaRestDaysDiff !== 0) matchSignals.push(`nba_rest_days_diff:${nbaRestDaysDiff>0?'+':''}${nbaRestDaysDiff}`);
        if (nbaInjuryDiff !== 0) matchSignals.push(`nba_injury_diff:${nbaInjuryDiff>0?'+':''}${nbaInjuryDiff.toFixed(1)}`);
        if (Math.abs(nbaAvailability.adj) >= 0.005) matchSignals.push(`nba_availability:${nbaAvailability.adj>0?'+':''}${(nbaAvailability.adj*100).toFixed(1)}%`);
        if (hmStakes.adj !== 0 || awStakes.adj !== 0) matchSignals.push(`stakes:${((hmStakes.adj - awStakes.adj)*100).toFixed(1)}%`);
        // v10.7.24: generic rest-days (phase 1 logging, weight=0) — naast bestaande nbaRestDaysDiff
        if (restInfo.signals.length) matchSignals.push(...restInfo.signals);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const availNote = nbaAvailability.note ? ` | ${nbaAvailability.note}` : '';
        const sharedNotes = `${posStr}${formNote}${b2bNote}${ppgNote}${rebNote}${splitNote}${availNote}${restInfo.note}`;

        // v2: feature_snapshot + pick_candidates voor ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'basketball', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, b2bAdj, ppgAdj, rebAdj, homeSplitAdj,
          // logged-only signals (nog niet in scoring)
          rest_days_home: restHome, rest_days_away: restAway, rest_days_diff: nbaRestDaysDiff,
          injury_load_home: nbaInjuryHome, injury_load_away: nbaInjuryAway, availabilityAdj,
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

        // Spread (NBA, variabele lijnen) — per-point devigged consensus voor eerlijke cover-prob.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home');
          const awaySpr = parsed.spreads.filter(o => o.side === 'away');
          // NBA spread-cover ≈ 0.50 × ML wanneer geen paired consensus (fallback)
          const { homeFn, awayFn } = buildSpreadFairProbFns(homeSpr, awaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(homeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            const fp = homeFn(bH.point);
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
              `Spread | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fp*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(awaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            const fp = awayFn(bA.point);
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
              `Spread | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fp*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals);
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
        {
          const h1HomeSpr = parsed.halfSpreads.filter(o => o.side === 'home');
          const h1AwaySpr = parsed.halfSpreads.filter(o => o.side === 'away');
          const bH = bestSpreadPick(h1HomeSpr, fpHome, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${hm} ${pt}`, bH.price,
              `1st Half Spread | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
              Math.round(fpHome*100), bH.edge * 0.18, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(h1AwaySpr, fpAway, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${aw} ${pt}`, bA.price,
              `1st Half Spread | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
              Math.round(fpAway*100), bA.edge * 0.18, kickoffTime, bA.bookie, matchSignals);
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

      // ── nhl_injury_diff scaffolding (logged-only, conservatief: twijfel = blessure) ──
      const nhlInjuryMap = {};
      let nhlInjTotal = 0;
      let nhlInjResp = [];
      if (supportsApiSportsInjuries('v1.hockey.api-sports.io')) {
        await sleep(120);
        nhlInjResp = await afGet('v1.hockey.api-sports.io', '/injuries', {
          league: league.id, season: league.season
        }).catch(() => []);
        apiCallsUsed++;
        for (const inj of (nhlInjResp || [])) {
          const tid = inj.team?.id;
          if (!tid) continue;
          if (isInjured(inj.player?.status || inj.status)) {
            nhlInjuryMap[tid] = (nhlInjuryMap[tid] || 0) + 1;
            nhlInjTotal++;
          }
        }
        emit({ log: `🏒 ${league.name}: ${nhlInjTotal} blessures geladen (${Object.keys(nhlInjuryMap).length} teams, api returned ${nhlInjResp?.length || 0} rows)` });
      } else {
        emit({ log: `🏒 ${league.name}: blessurefeed niet ondersteund door API-Sports (skip)` });
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

        // v10.7.24: rest-days (phase 1) — kritiek voor NHL back-to-backs
        let restInfo = { signals: [], note: '', hmDays: null, awDays: null };
        try {
          const cfgHk = { host: 'v1.hockey.api-sports.io' };
          const [hmLast, awLast] = await Promise.all([
            fetchLastPlayedDate('hockey', cfgHk, hmId, kickoffMs),
            fetchLastPlayedDate('hockey', cfgHk, awId, kickoffMs),
          ]);
          restInfo = buildRestDaysInfo('hockey', kickoffMs, hmLast, awLast);
        } catch (e) { console.warn('Rest-days (hockey) fetch failed:', e.message); }

        let goaliePreview = null;
        let goalieSig = { adj: 0, note: null, valid: false };
        try {
          goaliePreview = await fetchNhlGoaliePreview(gameId);
          if (goaliePreview?.home && goaliePreview?.away) {
            const rawGoalieSig = goalieAdjustment(goaliePreview.home, goaliePreview.away, {
              confirmedHome: goaliePreview.home.confirmed,
              confirmedAway: goaliePreview.away.confirmed,
            });
            const confFactor = Math.min(
              goaliePreview.home.confidenceFactor || 0,
              goaliePreview.away.confidenceFactor || 0,
            );
            if (rawGoalieSig.valid && confFactor >= 0.5) {
              goalieSig = {
                ...rawGoalieSig,
                adj: rawGoalieSig.adj * confFactor,
                note: `${rawGoalieSig.note} [preview ${goaliePreview.home.confidence}/${goaliePreview.away.confidence}]`,
                valid: true,
              };
            }
          }
        } catch (e) { console.warn('NHL goalie preview failed:', e.message); }

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
          formAdj = Math.max(-0.05, Math.min(0.05, (shrinkFormScore(fmScore(hmSt.form)) - shrinkFormScore(fmScore(awSt.form))) / 15 * 0.04));
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
        } else if (OPERATOR.scraping_enabled) {
          // v10.9.0: fallback naar api-web.nhle.com als api-sports dun is.
          try {
            const agg = require('./lib/data-aggregator');
            const [hmExt, awExt] = await Promise.all([
              agg.getTeamSummary('hockey', hm),
              agg.getTeamSummary('hockey', aw),
            ]);
            if (hmExt && awExt && hmExt.gamesPlayed >= 5 && awExt.gamesPlayed >= 5) {
              const hmGDpg = hmExt.gd / hmExt.gamesPlayed;
              const awGDpg = awExt.gd / awExt.gamesPlayed;
              const gdDiff = hmGDpg - awGDpg;
              if (Math.abs(gdDiff) > 0.5) {
                goalDiffAdj = Math.min(0.04, Math.max(-0.04, gdDiff * 0.02));
                goalDiffNote = ` | GD/g:${hmGDpg > 0 ? '+' : ''}${hmGDpg.toFixed(2)} vs ${awGDpg > 0 ? '+' : ''}${awGDpg.toFixed(2)} [nhl-api]`;
              }
            }
          } catch { /* swallow */ }
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

        const totalAdv = goalDiffAdj + homeRecordAdj + shotsSig.adj + goalieSig.adj;

        // ── nhl_injury_diff (logged-only, scaffolding) ──
        const nhlInjHome = nhlInjuryMap[hmId] || 0;
        const nhlInjAway = nhlInjuryMap[awId] || 0;
        const nhlInjDiff = nhlInjAway - nhlInjHome;
        const _swNhl = loadSignalWeights();
        const nhlInjW = _swNhl.nhl_injury_diff !== undefined ? _swNhl.nhl_injury_diff : 0;
        const nhlInjAdj = nhlInjDiff * 0.005 * nhlInjW;

        // Stakes (logged-only scaffolding)
        const nhlTotalTeams = Object.keys(standingsMap).length;
        const hmStakes = calcStakesByRank(hmSt?.rank, nhlTotalTeams, 'hockey');
        const awStakes = calcStakesByRank(awSt?.rank, nhlTotalTeams, 'hockey');
        const nhlStakesW = _swNhl.stakes !== undefined ? _swNhl.stakes : 0;
        const stakesAdj = (hmStakes.adj - awStakes.adj) * nhlStakesW;
        const stakesNote = (hmStakes.label || awStakes.label) ? ` | Stakes: ${hmStakes.label||'—'} vs ${awStakes.label||'—'}` : '';

        // v10.8.16: ha uit adjHome — fpHome komt uit market consensus (inclusief HA).
        const ha = 0;
        const adjHome = Math.min(0.88, fpHome + posAdj + formAdj + b2bAdj + totalAdv + nhlInjAdj + stakesAdj);
        const adjAway = Math.max(0.08, fpAway - posAdj * 0.5 - formAdj * 0.5 - b2bAdj * 0.5 - totalAdv * 0.5 - nhlInjAdj * 0.5 - stakesAdj * 0.5);

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
        if (goalieSig.valid && Math.abs(goalieSig.adj) >= 0.003) matchSignals.push(`nhl_goalie_edge:${goalieSig.adj>0?'+':''}${(goalieSig.adj*100).toFixed(1)}%`);
        if (nhlInjDiff !== 0) matchSignals.push(`nhl_injury_diff:${nhlInjDiff>0?'+':''}${nhlInjDiff}`);
        if (hmStakes.adj !== 0 || awStakes.adj !== 0) matchSignals.push(`stakes:${((hmStakes.adj - awStakes.adj)*100).toFixed(1)}%`);
        // v10.7.24: generic rest-days (weight=0 logging)
        if (restInfo.signals.length) matchSignals.push(...restInfo.signals);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const shotsNote = shotsSig.valid ? ` | ${shotsSig.note}` : '';
        const goalieNote = goalieSig.valid ? ` | ${goalieSig.note}` : '';
        const sharedNotes = `${posStr}${formNote}${b2bNote}${goalDiffNote}${homeRecordNote}${shotsNote}${goalieNote}${restInfo.note}`;

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
          goalieAdj: goalieSig.adj,
          shotsDiffAdj: shotsSig.adj, shotsDiffValid: shotsSig.valid,
          marketHomeProb: marketFairReg?.home, marketDrawProb: marketFairReg?.draw, marketAwayProb: marketFairReg?.away,
        }, {
          standings_present: !!(hmSt && awSt),
          three_way_bookies: marketFairReg?.bookieCount || 0,
          shots_signal_valid: shotsSig.valid,
          goalie_preview_available: !!(goaliePreview?.home && goaliePreview?.away),
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
        // v10.10.12: vervangt eerdere `-100% edge` ruis door echte oorzaak —
        // diagBestPrice splitst 'preferred bookie ontbreekt' van 'edge te laag'.
        const homeDiag = diagBestPrice('home 2-way', bH, adjHome, MIN_EDGE);
        const awayDiag = diagBestPrice('away 2-way', bA, adjAway, MIN_EDGE);
        if (homeDiag) diag.push(homeDiag);
        if (awayDiag) diag.push(awayDiag);
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

          // v10.10.14: 3-way ML diag symmetrisch met 2-way (v10.10.12). Vervangt
          // stille skip door echte oorzaak wanneer preferred ontbreekt.
          const h3Diag = diagBestPrice('home 3-way', bH3, p3.pHome, MIN_EDGE);
          const d3Diag = diagBestPrice('draw 3-way', bD3, p3.pDraw, MIN_EDGE);
          const a3Diag = diagBestPrice('away 3-way', bA3, p3.pAway, MIN_EDGE);
          if (h3Diag) diag.push(h3Diag);
          if (d3Diag) diag.push(d3Diag);
          if (a3Diag) diag.push(a3Diag);

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

        // Puck line (spread) — NHL standard is ±1.5. Gebruik spread-specifieke
        // devigged consensus, niet ML fpHome (Home wins ≠ Home covers -1.5).
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home' && Math.abs(o.point) === 1.5);
          const awaySpr = parsed.spreads.filter(o => o.side === 'away' && Math.abs(o.point) === 1.5);
          // Cover-kans voor -1.5 in NHL is historisch ~0.55 × ML win prob
          let fpHomePuck = fpHome * 0.55;
          let fpAwayPuck = fpAway * 0.55;
          const home15 = homeSpr.filter(s => s.point === -1.5);
          const away15 = awaySpr.filter(s => s.point === 1.5);
          if (home15.length >= 2 && away15.length >= 2) {
            const avgH = home15.reduce((s,o)=>s+1/o.price, 0) / home15.length;
            const avgA = away15.reduce((s,o)=>s+1/o.price, 0) / away15.length;
            const tot = avgH + avgA;
            if (tot > 1.00 && tot < 1.15) {
              fpHomePuck = avgH / tot;
              fpAwayPuck = avgA / tot;
            }
          }
          const bH = bestSpreadPick(homeSpr, fpHomePuck, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
              `Puck Line | ${bH.bookie}: ${bH.price} · cover ${(fpHomePuck*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fpHomePuck*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(awaySpr, fpAwayPuck, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
              `Puck Line | ${bA.bookie}: ${bA.price} · cover ${(fpAwayPuck*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fpAway*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals);
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

      // ── mlb_injury_diff (logged-only, conservatief) ──
      const mlbInjuryMap = {};
      let mlbInjTotal = 0;
      let mlbInjResp = [];
      if (supportsApiSportsInjuries('v1.baseball.api-sports.io')) {
        await sleep(80);
        mlbInjResp = await afGet('v1.baseball.api-sports.io', '/injuries', {
          league: league.id, season: league.season
        }).catch(() => []);
        apiCallsUsed++;
        for (const inj of (mlbInjResp || [])) {
          const tid = inj.team?.id;
          if (!tid) continue;
          if (isInjured(inj.player?.status || inj.status)) {
            mlbInjuryMap[tid] = (mlbInjuryMap[tid] || 0) + 1;
            mlbInjTotal++;
          }
        }
        emit({ log: `⚾ ${league.name}: ${mlbInjTotal} blessures geladen (${Object.keys(mlbInjuryMap).length} teams, api returned ${mlbInjResp?.length || 0} rows)` });
      } else {
        emit({ log: `⚾ ${league.name}: blessurefeed niet ondersteund door API-Sports (skip)` });
      }

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

        // v10.7.24: rest-days (phase 1, logging only)
        let restInfo = { signals: [], note: '', hmDays: null, awDays: null };
        try {
          const cfgBb = { host: 'v1.baseball.api-sports.io' };
          const [hmLast, awLast] = await Promise.all([
            fetchLastPlayedDate('baseball', cfgBb, hmId, kickoffMs),
            fetchLastPlayedDate('baseball', cfgBb, awId, kickoffMs),
          ]);
          restInfo = buildRestDaysInfo('baseball', kickoffMs, hmLast, awLast);
        } catch (e) { console.warn('Rest-days (baseball) fetch failed:', e.message); }

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
          formAdj = Math.max(-0.05, Math.min(0.05, (shrinkFormScore(fmScore(hmSt.form), 10) - shrinkFormScore(fmScore(awSt.form), 10)) / 30 * 0.04));
        }

        // ── Advanced baseball signals (from standings, 0 extra API calls) ──
        let runDiffAdj = 0, homeAwayAdj = 0, streakAdj = 0;
        let runDiffNote = '', homeAwayNote = '', streakNote = '';

        // Run differential per game: >0.5/game → +2%
        // v10.9.0: fallback naar MLB Stats API extended als api-football stale/dun is.
        let mlbExtSummary = null;
        if (OPERATOR.scraping_enabled && (!hmSt || hmSt.totalGames < 10 || !awSt || awSt.totalGames < 10)) {
          try {
            const agg = require('./lib/data-aggregator');
            const [hmExt, awExt] = await Promise.all([
              agg.getTeamSummary('baseball', hm),
              agg.getTeamSummary('baseball', aw),
            ]);
            if (hmExt && awExt) mlbExtSummary = { hm: hmExt, aw: awExt };
          } catch { /* swallow */ }
        }
        if (hmSt && awSt && hmSt.totalGames >= 10 && awSt.totalGames >= 10) {
          const hmRDpg = (hmSt.pointsFor - hmSt.pointsAgainst) / hmSt.totalGames;
          const awRDpg = (awSt.pointsFor - awSt.pointsAgainst) / awSt.totalGames;
          const rdDiff = hmRDpg - awRDpg;
          if (Math.abs(rdDiff) > 0.5) {
            runDiffAdj = Math.min(0.04, Math.max(-0.04, rdDiff * 0.02));
            runDiffNote = ` | RD/g:${hmRDpg > 0 ? '+' : ''}${hmRDpg.toFixed(2)} vs ${awRDpg > 0 ? '+' : ''}${awRDpg.toFixed(2)}`;
          }
        } else if (mlbExtSummary && mlbExtSummary.hm.gamesPlayed >= 10 && mlbExtSummary.aw.gamesPlayed >= 10) {
          const hmRDpg = mlbExtSummary.hm.runDiff / mlbExtSummary.hm.gamesPlayed;
          const awRDpg = mlbExtSummary.aw.runDiff / mlbExtSummary.aw.gamesPlayed;
          const rdDiff = hmRDpg - awRDpg;
          if (Math.abs(rdDiff) > 0.5) {
            runDiffAdj = Math.min(0.04, Math.max(-0.04, rdDiff * 0.02));
            runDiffNote = ` | RD/g:${hmRDpg > 0 ? '+' : ''}${hmRDpg.toFixed(2)} vs ${awRDpg > 0 ? '+' : ''}${awRDpg.toFixed(2)} [mlb-ext]`;
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
        const starterReliability = mlbMatch
          ? pitcherReliabilityFactor(mlbMatch.homePitcher, mlbMatch.awayPitcher)
          : { factor: 0.7, note: 'Starter sample dun', valid: false };

        const totalAdv = runDiffAdj + homeAwayAdj + streakAdj + (pitcherSig.adj * starterReliability.factor);

        // ── mlb_injury_diff (logged-only scaffolding) ──
        const mlbInjHome = mlbInjuryMap[hmId] || 0;
        const mlbInjAway = mlbInjuryMap[awId] || 0;
        const mlbInjDiff = mlbInjAway - mlbInjHome;
        const _swMlb = loadSignalWeights();
        const mlbInjW = _swMlb.mlb_injury_diff !== undefined ? _swMlb.mlb_injury_diff : 0;
        const mlbInjAdj = mlbInjDiff * 0.003 * mlbInjW;

        // Stakes (logged-only scaffolding)
        const mlbTotalTeams = Object.keys(standingsMap).length;
        const hmStakesM = calcStakesByRank(hmSt?.rank, mlbTotalTeams, 'baseball');
        const awStakesM = calcStakesByRank(awSt?.rank, mlbTotalTeams, 'baseball');
        const mlbStakesW = _swMlb.stakes !== undefined ? _swMlb.stakes : 0;
        const stakesAdj = (hmStakesM.adj - awStakesM.adj) * mlbStakesW;
        const stakesNote = (hmStakesM.label || awStakesM.label) ? ` | Stakes: ${hmStakesM.label||'—'} vs ${awStakesM.label||'—'}` : '';

        // ── Weather (outdoor MLB parks) — rain/wind dempen run-totaal ──
        let mlbWeatherAdj = 0, mlbWeatherNote = '';
        const mlbVenueCoords = getVenueCoords(g) || getVenueCoords({ venue: g.venue });
        if (mlbVenueCoords && weatherCallsThisScan < MAX_WEATHER_CALLS) {
          const w = await fetchMatchWeather(mlbVenueCoords.lat, mlbVenueCoords.lon, new Date(kickoffMs));
          if (w) {
            const parts = [];
            if (w.rain > 5)  { mlbWeatherAdj -= 0.025; parts.push(`🌧️ ${w.rain}mm`); }
            if (w.wind > 25) { mlbWeatherAdj -= 0.02; parts.push(`💨 ${w.wind}km/h`); }
            if (parts.length) mlbWeatherNote = ` | Weer: ${parts.join(', ')} → Under nudge ${(mlbWeatherAdj*100).toFixed(0)}%`;
          }
        }

        // v10.8.16: home-advantage NIET meer op fpHome optellen. fpHome komt uit
        // de-vigged bookmaker consensus en INCLUDEERT al home-field pricing.
        // Ha er bovenop = dubbel-tellen, systematische bias richting home teams.
        // `ha` variabele blijft 0 voor backwards compat met signals/logging.
        const ha = 0;
        const adjHome = Math.min(0.88, fpHome + posAdj + formAdj + totalAdv + mlbInjAdj + stakesAdj);
        const adjAway = Math.max(0.08, fpAway - posAdj * 0.5 - formAdj * 0.5 - totalAdv * 0.5 - mlbInjAdj * 0.5 - stakesAdj * 0.5);

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
          matchSignals.push(`pitcher_era_diff:${pitcherSig.adj>0?'+':''}${(pitcherSig.adj*100 * starterReliability.factor).toFixed(1)}%`);
        }
        if (mlbInjDiff !== 0) matchSignals.push(`mlb_injury_diff:${mlbInjDiff>0?'+':''}${mlbInjDiff}`);
        if (hmStakesM.adj !== 0 || awStakesM.adj !== 0) matchSignals.push(`stakes:${((hmStakesM.adj - awStakesM.adj)*100).toFixed(1)}%`);
        if (mlbWeatherAdj !== 0) matchSignals.push(`weather:${mlbWeatherAdj>0?'+':''}${(mlbWeatherAdj*100).toFixed(1)}%`);
        // v10.7.24: rest-days (phase 1 logging)
        if (restInfo.signals.length) matchSignals.push(...restInfo.signals);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-10)||'?'} vs ${awSt?.form?.slice(-10)||'?'}` : '';
        const pitcherNote = pitcherSig.valid ? ` | ${pitcherSig.note} · ${starterReliability.note}` : '';
        const sharedNotes = `${posStr}${formNote}${runDiffNote}${homeAwayNote}${streakNote}${pitcherNote}${mlbWeatherNote}${restInfo.note}`;

        // v2: feature_snapshot + pick_candidates voor MLB ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'baseball', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, runDiffAdj, homeAwayAdj, streakAdj,
          pitcherAdj: pitcherSig.adj * starterReliability.factor, pitcherValid: pitcherSig.valid,
          starterReliability: starterReliability.factor,
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
              const overP = Math.max(0.10, Math.min(0.90, (totIP2 > 0 ? avgOvIP / totIP2 : 0.5) + mlbWeatherAdj));
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

        // Run Line (spread) — MLB standard is ±1.5. Eerder bug: pool mixte
        // verschillende point-lines (bv -1.5 @ 2.17 en -2.5 @ 4.20), waardoor
        // bestFromArr soms >3.8 terugkwam en pick geskipt werd. Nu filter op ±1.5.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home' && Math.abs(o.point) === 1.5);
          const awaySpr = parsed.spreads.filter(o => o.side === 'away' && Math.abs(o.point) === 1.5);
          // FIX (v10.7.12): gebruik spread-specifieke devigged consensus ipv ML fpHome.
          // Home -1.5 cover ≠ Home wins. Markt-consensus van -1.5 pair geeft
          // eerlijke cover-kans. Fallback: fpHome × 0.55 (historische MLB ratio).
          let fpHomeSpread = fpHome * 0.55;
          let fpAwaySpread = fpAway * 0.55;
          const home15 = homeSpr.filter(s => s.point === -1.5);
          const away15 = awaySpr.filter(s => s.point === 1.5);  // +1.5 insurance pair
          if (home15.length >= 2 && away15.length >= 2) {
            const avgH = home15.reduce((s,o)=>s+1/o.price, 0) / home15.length;
            const avgA = away15.reduce((s,o)=>s+1/o.price, 0) / away15.length;
            const tot = avgH + avgA;
            // Sanity check: typical 2-way book is 1.02-1.12 (2-12% vig)
            if (tot > 1.00 && tot < 1.15) {
              fpHomeSpread = avgH / tot;
              fpAwaySpread = avgA / tot;
            }
          }
          const bH = bestSpreadPick(homeSpr, fpHomeSpread, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
              `Run Line | ${bH.bookie}: ${bH.price} · cover ${(fpHomeSpread*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fpHomeSpread*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(awaySpr, fpAwaySpread, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
              `Run Line | ${bA.bookie}: ${bA.price} · cover ${(fpAwaySpread*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fpAwaySpread*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals);
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

        // v10.10.17: F5 diagnostiek — waarom picks niet surfacen.
        const f5Diag = [];
        if (!pitcherSig.valid) f5Diag.push('F5-ML skip: pitcher data niet valid');
        if (!f5ML.length) f5Diag.push('F5-ML skip: geen F5 ML odds in payload');
        if (!f5Totals.length) f5Diag.push('F5-Total skip: geen F5 totals odds in payload');

        if (pitcherSig.valid && f5ML.length) {
          // F5 probability: Gebruik fpHome/fpAway als baseline + pitcher × 3
          const f5PitcherAdj = Math.max(-0.12, Math.min(0.12, pitcherSig.adj * 3 * starterReliability.factor));
          const f5Home = Math.min(0.85, Math.max(0.15, fpHome + f5PitcherAdj + ha * 0.7));
          const f5Away = Math.min(0.85, Math.max(0.15, fpAway - f5PitcherAdj * 0.7 - ha * 0.35));

          const f5H = f5ML.filter(o => o.side === 'home');
          const f5A = f5ML.filter(o => o.side === 'away');
          const bF5H = bestFromArr(f5H);
          const bF5A = bestFromArr(f5A);
          const eF5H = bF5H.price > 0 ? f5Home * bF5H.price - 1 : -1;
          const eF5A = bF5A.price > 0 ? f5Away * bF5A.price - 1 : -1;
          const f5MinEdge = starterReliability.factor < 0.8 ? MIN_EDGE + 0.015 : MIN_EDGE;
          // v10.10.17: F5 ML preferred-coverage diagnostiek
          const f5HDiag = diagBestPrice('F5-ML home', bF5H, f5Home, f5MinEdge);
          const f5ADiag = diagBestPrice('F5-ML away', bF5A, f5Away, f5MinEdge);
          if (f5HDiag) f5Diag.push(f5HDiag);
          if (f5ADiag) f5Diag.push(f5ADiag);

          if (eF5H >= f5MinEdge && bF5H.price >= 1.60 && bF5H.price <= MAX_WINNER_ODDS)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 ${hm}`, bF5H.price,
              `F5 (1st 5 inn): ${(f5Home*100).toFixed(1)}% | ${bF5H.bookie}: ${bF5H.price} | ${pitcherSig.note} · ${starterReliability.note} | ${ko}`,
              Math.round(f5Home*100), eF5H * 0.24, kickoffTime, bF5H.bookie, [...matchSignals, 'f5_ml', 'pitcher_3x']);
          if (eF5A >= f5MinEdge && bF5A.price >= 1.60 && bF5A.price <= MAX_WINNER_ODDS)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 ${aw}`, bF5A.price,
              `F5 (1st 5 inn): ${(f5Away*100).toFixed(1)}% | ${bF5A.bookie}: ${bF5A.price} | ${pitcherSig.note} · ${starterReliability.note} | ${ko}`,
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
      // v10.10.17: per-match F5 diagnostiek in scan-output
      if (f5Diag.length) emit({ log: `  └─ F5 ${hm} vs ${aw}: ${f5Diag.slice(0, 3).join(' · ')}` });
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

      // ── nfl_injury_diff (logged-only, conservatief: twijfel = blessure) ──
      await sleep(120);
      const injuriesResp = await afGet('v1.american-football.api-sports.io', '/injuries', {
        league: league.id, season: league.season
      }).catch(() => []);
      apiCallsUsed++;
      const injuryCountMap = {};
      let nflInjTotal = 0;
      for (const inj of (injuriesResp || [])) {
        const tid = inj.team?.id;
        if (!tid) continue;
        if (isInjured(inj.player?.status || inj.status)) {
          injuryCountMap[tid] = (injuryCountMap[tid] || 0) + 1;
          nflInjTotal++;
        }
      }
      emit({ log: `🏈 ${league.name}: ${nflInjTotal} blessures geladen (${Object.keys(injuryCountMap).length} teams, api returned ${injuriesResp?.length || 0} rows)` });

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

        // v10.7.24: rest-days (phase 1)
        let restInfo = { signals: [], note: '', hmDays: null, awDays: null };
        try {
          const cfgNfl = { host: 'v1.american-football.api-sports.io' };
          const [hmLast, awLast] = await Promise.all([
            fetchLastPlayedDate('american-football', cfgNfl, hmId, kickoffMs),
            fetchLastPlayedDate('american-football', cfgNfl, awId, kickoffMs),
          ]);
          restInfo = buildRestDaysInfo('american-football', kickoffMs, hmLast, awLast);
        } catch (e) { console.warn('Rest-days (NFL) fetch failed:', e.message); }

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
          formAdj = Math.max(-0.05, Math.min(0.05, (shrinkFormScore(fmScore(hmSt.form)) - shrinkFormScore(fmScore(awSt.form))) / 15 * 0.04));
        }

        // ── Weather (outdoor NFL stadia) — nudge O/U bij heavy rain/wind ──
        let weatherAdj = 0, weatherNote = '';
        const nflVenueCoords = getVenueCoords(g) || getVenueCoords({ venue: g.venue });
        if (nflVenueCoords && weatherCallsThisScan < MAX_WEATHER_CALLS) {
          const w = await fetchMatchWeather(nflVenueCoords.lat, nflVenueCoords.lon, new Date(kickoffMs));
          if (w) {
            const parts = [];
            if (w.rain > 5)  { weatherAdj -= 0.03; parts.push(`🌧️ ${w.rain}mm regen`); }
            if (w.wind > 30) { weatherAdj -= 0.025; parts.push(`💨 ${w.wind}km/h wind`); }
            if (parts.length) weatherNote = ` | Weer: ${parts.join(', ')} → Under nudge ${(weatherAdj*100).toFixed(0)}%`;
            else weatherNote = ` | ☀️ ${w.temp}°C`;
          }
        }

        // v10.8.16: ha = 0 — fpHome komt uit market consensus (inclusief HA).
        const ha = 0;
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

        // Experimenteel: nfl_injury_diff. Weight start op 0 (logged-only).
        // Auto-promotie via autoTuneSignalsByClv zodra n≥50 en CLV > 0%.
        const _swNfl = loadSignalWeights();
        const injWeight = _swNfl.nfl_injury_diff !== undefined ? _swNfl.nfl_injury_diff : 0;
        const injAdj = nflInjuryDiff * 0.005 * injWeight;

        // Stakes (logged-only scaffolding)
        const nflTotalTeams = Object.keys(standingsMap).length;
        const hmStakesN = calcStakesByRank(hmSt?.rank, nflTotalTeams, 'american-football');
        const awStakesN = calcStakesByRank(awSt?.rank, nflTotalTeams, 'american-football');
        const nflStakesW = _swNfl.stakes !== undefined ? _swNfl.stakes : 0;
        const stakesAdj = (hmStakesN.adj - awStakesN.adj) * nflStakesW;
        const stakesNote = (hmStakesN.label || awStakesN.label) ? ` | Stakes: ${hmStakesN.label||'—'} vs ${awStakesN.label||'—'}` : '';

        const adjHome = Math.min(0.88, fpHome + posAdj + formAdj + byeAdj + totalAdv + injAdj + stakesAdj);
        const adjAway = Math.max(0.08, fpAway - posAdj * 0.5 - formAdj * 0.5 - byeAdj * 0.5 - totalAdv * 0.5 - injAdj * 0.5 - stakesAdj * 0.5);

        const bH = bestFromArr(homeOdds);
        const bA = bestFromArr(awayOdds);

        const homeEdge = bH.price > 0 ? adjHome * bH.price - 1 : -1;
        const awayEdge = bA.price > 0 ? adjAway * bA.price - 1 : -1;

        // ── nfl_injury_diff (logged-only) ──
        const injHome = injuryCountMap[hmId] || 0;
        const injAway = injuryCountMap[awId] || 0;
        const nflInjuryDiff = injAway - injHome; // positief = away meer geblesseerd → home voordeel

        const matchSignals = [];
        if (ha !== 0) matchSignals.push(`nfl_home:+${(ha*100).toFixed(1)}%`);
        if (Math.abs(formAdj) >= 0.005) matchSignals.push(`form:${formAdj>0?'+':''}${(formAdj*100).toFixed(1)}%`);
        if (Math.abs(posAdj) >= 0.005) matchSignals.push(`position:${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%`);
        if (byeAdj !== 0) matchSignals.push(`bye:${byeAdj>0?'+':''}${(byeAdj*100).toFixed(1)}%`);
        if (Math.abs(ptsDiffAdj) >= 0.005) matchSignals.push(`pts_diff:${ptsDiffAdj>0?'+':''}${(ptsDiffAdj*100).toFixed(1)}%`);
        if (Math.abs(homeRecordAdj) >= 0.005) matchSignals.push(`home_record:+${(homeRecordAdj*100).toFixed(1)}%`);
        if (divisionAdj !== 0) matchSignals.push(`division_rivalry:${(divisionAdj*100).toFixed(1)}%`);
        // logged-only (nog niet in adjHome/adjAway gewogen): nfl_injury_diff
        if (nflInjuryDiff !== 0) matchSignals.push(`nfl_injury_diff:${nflInjuryDiff>0?'+':''}${nflInjuryDiff}`);
        if (hmStakesN.adj !== 0 || awStakesN.adj !== 0) matchSignals.push(`stakes:${((hmStakesN.adj - awStakesN.adj)*100).toFixed(1)}%`);
        if (weatherAdj !== 0) matchSignals.push(`weather:${weatherAdj>0?'+':''}${(weatherAdj*100).toFixed(1)}%`);
        // v10.7.24: rest-days (phase 1)
        if (restInfo.signals.length) matchSignals.push(...restInfo.signals);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const sharedNotes = `${posStr}${formNote}${byeNote}${ptsDiffNote}${homeRecordNote}${divisionNote}${weatherNote}${restInfo.note}`;

        // v2: feature_snapshot + pick_candidates voor NFL ML
        snap.writeFeatureSnapshot(supabase, gameId, {
          sport: 'american-football', fpHome, fpAway, adjHome, adjAway, ha,
          posAdj, formAdj, byeAdj, ptsDiffAdj, homeRecordAdj, divisionAdj,
          // logged-only signals (nog niet in scoring)
          injury_count_home: injHome, injury_count_away: injAway, injury_diff: nflInjuryDiff,
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
              // Weather-adjusted overP: regen/wind = minder scoring = under nudge
              const overP = Math.max(0.10, Math.min(0.90, (totIP2 > 0 ? avgOvIP / totIP2 : 0.5) + weatherAdj));
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

        // Spread (NFL) — per-point devigged consensus voor cover-prob.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home');
          const awaySpr = parsed.spreads.filter(o => o.side === 'away');
          // NFL spread-cover ≈ 0.50 × ML wanneer geen paired consensus
          const { homeFn, awayFn } = buildSpreadFairProbFns(homeSpr, awaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(homeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            const fp = homeFn(bH.point);
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
              `Spread | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fp*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(awaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            const fp = awayFn(bA.point);
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
              `Spread | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fp*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals);
          }
        }

        // ── 1st Half Spread (NFL - research: 1H spreads often mispriced vs full-game) ──
        {
          const h1HomeSpr = parsed.halfSpreads.filter(o => o.side === 'home');
          const h1AwaySpr = parsed.halfSpreads.filter(o => o.side === 'away');
          const bH = bestSpreadPick(h1HomeSpr, fpHome, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${hm} ${pt}`, bH.price,
              `1st Half Spread | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
              Math.round(fpHome*100), bH.edge * 0.18, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(h1AwaySpr, fpAway, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${aw} ${pt}`, bA.price,
              `1st Half Spread | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
              Math.round(fpAway*100), bA.edge * 0.18, kickoffTime, bA.bookie, matchSignals);
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

      // ── handball_injury_diff (logged-only, conservatief) ──
      await sleep(80);
      const hbInjResp = await afGet('v1.handball.api-sports.io', '/injuries', {
        league: league.id, season: league.season
      }).catch(() => []);
      apiCallsUsed++;
      const hbInjuryMap = {};
      let hbInjTotal = 0;
      for (const inj of (hbInjResp || [])) {
        const tid = inj.team?.id;
        if (!tid) continue;
        if (isInjured(inj.player?.status || inj.status)) {
          hbInjuryMap[tid] = (hbInjuryMap[tid] || 0) + 1;
          hbInjTotal++;
        }
      }
      emit({ log: `🤾 ${league.name}: ${hbInjTotal} blessures geladen (${Object.keys(hbInjuryMap).length} teams, api returned ${hbInjResp?.length || 0} rows)` });

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

        // v10.7.24: rest-days (phase 1)
        let restInfo = { signals: [], note: '', hmDays: null, awDays: null };
        try {
          const cfgHb = { host: 'v1.handball.api-sports.io' };
          const [hmLast, awLast] = await Promise.all([
            fetchLastPlayedDate('handball', cfgHb, hmId, kickoffMs),
            fetchLastPlayedDate('handball', cfgHb, awId, kickoffMs),
          ]);
          restInfo = buildRestDaysInfo('handball', kickoffMs, hmLast, awLast);
        } catch (e) { console.warn('Rest-days (handball) fetch failed:', e.message); }

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
          formAdj = Math.max(-0.05, Math.min(0.05, (shrinkFormScore(fmScore(hmSt.form)) - shrinkFormScore(fmScore(awSt.form))) / 15 * 0.04));
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

        // ── handball_injury_diff (logged-only scaffolding) ──
        const hbInjHome = hbInjuryMap[hmId] || 0;
        const hbInjAway = hbInjuryMap[awId] || 0;
        const hbInjDiff = hbInjAway - hbInjHome;
        const _swHb = loadSignalWeights();
        const hbInjW = _swHb.handball_injury_diff !== undefined ? _swHb.handball_injury_diff : 0;
        const hbInjAdj = hbInjDiff * 0.007 * hbInjW;

        // Stakes (logged-only scaffolding)
        const hbTotalTeams = Object.keys(standingsMap).length;
        const hmStakesH = calcStakesByRank(hmSt?.rank, hbTotalTeams, 'handball');
        const awStakesH = calcStakesByRank(awSt?.rank, hbTotalTeams, 'handball');
        const hbStakesW = _swHb.stakes !== undefined ? _swHb.stakes : 0;
        const stakesAdj = (hmStakesH.adj - awStakesH.adj) * hbStakesW;
        const stakesNote = (hmStakesH.label || awStakesH.label) ? ` | Stakes: ${hmStakesH.label||'—'} vs ${awStakesH.label||'—'}` : '';

        // v10.8.16: ha = 0 — fpHome komt uit market consensus (inclusief HA).
        const ha = 0;
        const adjHome = Math.min(0.88, fpHome + posAdj + formAdj + totalAdv + hbInjAdj + stakesAdj);
        const adjAway = Math.max(0.08, fpAway - posAdj * 0.5 - formAdj * 0.5 - totalAdv * 0.5 - hbInjAdj * 0.5 - stakesAdj * 0.5);

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
        if (hbInjDiff !== 0) matchSignals.push(`handball_injury_diff:${hbInjDiff>0?'+':''}${hbInjDiff}`);
        if (hmStakesH.adj !== 0 || awStakesH.adj !== 0) matchSignals.push(`stakes:${((hmStakesH.adj - awStakesH.adj)*100).toFixed(1)}%`);
        // v10.7.24: rest-days
        if (restInfo.signals.length) matchSignals.push(...restInfo.signals);

        const posStr = posAdj !== 0 ? ` | Positie: ${posAdj>0?'+':''}${(posAdj*100).toFixed(1)}%` : '';
        const formNote = hmSt?.form || awSt?.form ? ` | Vorm: ${hmSt?.form?.slice(-5)||'?'} vs ${awSt?.form?.slice(-5)||'?'}` : '';
        const sharedNotes = `${posStr}${formNote}${goalDiffNote}${homeWRNote}${momentumNote}${restInfo.note}`;

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

        // Handicap (handball) — per-point devigged consensus voor cover-prob.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home');
          const awaySpr = parsed.spreads.filter(o => o.side === 'away');
          const { homeFn, awayFn } = buildSpreadFairProbFns(homeSpr, awaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(homeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            const fp = homeFn(bH.point);
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
              `Handicap | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fp*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals);
          }
          const bA = bestSpreadPick(awaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            const fp = awayFn(bA.point);
            mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
              `Handicap | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
              Math.round(fp*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals);
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

  // Datumbereik: vandaag + morgen (voor nachtwedstrijden tot 10:00)
  const today    = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const dateFrom = today;
  const dateTo   = tomorrow;

  // ── STAP 1.5: Pre-fetch fixtures voor actieve leagues (1 call/league) ───
  const activeSoccerKeys = await preFetchFootballFixtures(emit, today, tomorrow, dateFrom, dateTo);
  // API calls voor pre-fetch worden in _footballFixturesCache opgeslagen.

  // ── STAP 2: Team stats, blessures, scheidsrechters (alleen actieve leagues) ──
  h2hCallsThisScan = 0;
  weatherCallsThisScan = 0;
  // Clear team stats cache for fresh scan
  for (const k of Object.keys(teamStatsCache)) delete teamStatsCache[k];
  let teamStatsCalls = 0;
  await enrichWithApiSports(emit, activeSoccerKeys);

  // v10.7.25: scan-telemetrie voor nieuwe signalen (zichtbaar in scan log)
  const scanTelemetry = {
    restDaysLookups: 0, restDaysCacheHits: 0, restDaysFails: 0,
    restDaysTiredHome: 0, restDaysTiredAway: 0,
    knockoutMatches: 0, knockout1stLeg: 0, knockout2ndLeg: 0,
    aggregateFetched: 0, aggregateLeaderHome: 0, aggregateLeaderAway: 0, aggregateSquare: 0,
    earlySeasonMatches: 0,
  };

  // ── Calibratie ───────────────────────────────────────────────────────────
  const calib = loadCalib();
  const cm = calib.markets;
  // v10.7.21: na rebuild-calib zijn keys sport-prefixed (football_home etc);
  // oude unprefixed keys kunnen ontbreken. Lees met fallback + prefereer
  // football_* als primair (meeste volume).
  const mm = (key, fallback = 1.0) => {
    const entry = cm[`football_${key}`] || cm[key];
    return (entry && typeof entry.multiplier === 'number') ? entry.multiplier : fallback;
  };
  // Backfill missing unprefixed keys zodat downstream cm.home?.multiplier werkt
  for (const k of ['home','away','draw','over','under','other']) {
    if (!cm[k]) cm[k] = cm[`football_${k}`] || { n:0, w:0, profit:0, multiplier:1.0 };
  }
  emit({ log: `🧠 Calibratie: thuis×${mm('home').toFixed(2)} uit×${mm('away').toFixed(2)} draw×${mm('draw').toFixed(2)} over×${mm('over').toFixed(2)}` });

  const { picks, combiPool, mkP } = buildPickFactory(1.60, calib.epBuckets || {});
  const MIN_EDGE = 0.055;
  let totalEvents = 0;
  let apiCallsUsed = AF_FOOTBALL_LEAGUES.length; // 1 call/league gebruikt in pre-fetch

  // ── STAP 3: Per competitie fixtures (uit cache) + odds + predictions ────
  for (const league of AF_FOOTBALL_LEAGUES) {
    try {
      // Fixtures uit pre-fetch cache (geen extra call)
      const filtered = _footballFixturesCache[league.key] || [];

      if (!filtered.length) { emit({ log: `📭 ${league.name}: geen wedstrijden` }); continue; }
      emit({ log: `✅ ${league.name}: ${filtered.length} wedstrijd(en)` });
      totalEvents += filtered.length;

      const afStats   = afCache.teamStats[league.key] || {};
      const afInj     = afCache.injuries[league.key]  || {};

      for (const f of filtered) {
        const fid = f.fixture?.id;
        const hm  = f.teams?.home?.name;
        const aw  = f.teams?.away?.name;
        const hmId = f.teams?.home?.id;
        const awId = f.teams?.away?.id;
        if (!fid || !hm || !aw) continue;

        const kickoffMs  = new Date(f.fixture?.date).getTime();
        const kickoffTime = new Date(kickoffMs).toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
        const ko = new Date(kickoffMs)
          .toLocaleString('nl-NL', { weekday:'short', day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });

        // v10.7.24: rest-days signaal (phase 1: logging, weight=0 default)
        let restInfo = { signals: [], note: '', hmDays: null, awDays: null };
        try {
          const cfgFootball = { host: 'v3.football.api-sports.io' };
          const hmCached = afCache.lastPlayed.football?.[hmId] !== undefined;
          const awCached = afCache.lastPlayed.football?.[awId] !== undefined;
          const [hmLast, awLast] = await Promise.all([
            fetchLastPlayedDate('football', cfgFootball, hmId, kickoffMs),
            fetchLastPlayedDate('football', cfgFootball, awId, kickoffMs),
          ]);
          if (hmCached) scanTelemetry.restDaysCacheHits++; else scanTelemetry.restDaysLookups++;
          if (awCached) scanTelemetry.restDaysCacheHits++; else scanTelemetry.restDaysLookups++;
          restInfo = buildRestDaysInfo('football', kickoffMs, hmLast, awLast);
          if (restInfo.homeTired) scanTelemetry.restDaysTiredHome++;
          if (restInfo.awayTired) scanTelemetry.restDaysTiredAway++;
        } catch (e) { scanTelemetry.restDaysFails++; console.warn('Rest-days (football) fetch failed:', e.message); }

        // ── Knockout / leg-info (CL, EL, Conference, domestic cups) ───
        // v10.7.23: parse f.league.round. Voorbeelden: "Round of 16 - 1st Leg",
        // "Quarter-finals 2nd Leg", "Semi-finals", "Final". Voor 2e leg is de
        // aggregaatstand cruciaal (wij weten die nog niet; dat is phase 2).
        // Phase 1: alleen LOGGEN als signaal (weight=0 default, auto-promote
        // zodra CLV positief over ≥20 samples).
        const roundStr = String(f.league?.round || '').toLowerCase();
        const legMatch = roundStr.match(/(1st|2nd|first|second)\s*leg/);
        const knockoutInfo = {
          isKnockout: /round of|quarter|semi|final|1st leg|2nd leg|leg/i.test(roundStr),
          leg: legMatch ? (legMatch[1].startsWith('1') || legMatch[1] === 'first' ? 1 : 2) : null,
          stageLabel: roundStr.includes('final') && !roundStr.includes('semi') && !roundStr.includes('quarter') ? 'finale'
                    : roundStr.includes('semi') ? 'halve finale'
                    : roundStr.includes('quarter') ? 'kwartfinale'
                    : roundStr.includes('round of 16') ? '1/8 finale'
                    : roundStr.includes('round of 32') ? '1/16 finale'
                    : null,
        };

        // v10.7.25: bij 2e leg → fetch 1e leg en bereken aggregaat
        // v10.8.4: ook proberen bij isKnockout met onbekende leg
        // (api-sports geeft vaak alleen "Semi-finals" zonder leg-suffix).
        // fetchAggregateScore returns null als er geen recent FT-match is
        // (= dit is dan 1e leg of geen 2-leg format).
        let aggInfo = { signals: [], note: '', aggDiff: null };
        if (knockoutInfo.isKnockout) scanTelemetry.knockoutMatches++;
        if (knockoutInfo.leg === 1) scanTelemetry.knockout1stLeg++;
        const tryAggregate = knockoutInfo.isKnockout && knockoutInfo.leg !== 1 && hmId && awId;
        if (tryAggregate) {
          try {
            const agg = await fetchAggregateScore(hmId, awId, roundStr, f.league?.season);
            if (agg) {
              aggInfo = buildAggregateInfo(agg.aggHome, agg.aggAway);
              scanTelemetry.aggregateFetched++;
              scanTelemetry.knockout2ndLeg++; // confirmed 2e leg via 1e leg presence
              if (aggInfo.aggDiff > 0) scanTelemetry.aggregateLeaderHome++;
              else if (aggInfo.aggDiff < 0) scanTelemetry.aggregateLeaderAway++;
              else scanTelemetry.aggregateSquare++;
            }
          } catch (e) { console.warn('Aggregate fetch failed:', e.message); }
        }

        // v10.7.25: new-season indicator — eerste 4 rondes hebben te weinig
        // sample om form/stats betrouwbaar te interpreteren. Signaal logging +
        // dempen van form/position adjustments tijdens deze fase.
        const seasonRoundMatch = roundStr.match(/regular season\s*[-–]?\s*(\d+)/i);
        const seasonRound = seasonRoundMatch ? parseInt(seasonRoundMatch[1]) : null;
        const earlySeason = seasonRound !== null && seasonRound <= 4;
        const seasonInfo = {
          signals: earlySeason ? ['early_season:0%'] : [],
          note: earlySeason ? ` | 🌱 Vroeg in seizoen (ronde ${seasonRound})` : '',
          dampingFactor: earlySeason ? 0.6 : 1.0, // dempt form/position op 60%
        };
        if (earlySeason) scanTelemetry.earlySeasonMatches++;

        // ── Odds ophalen van api-football.com ─────────────────────────
        await sleep(120);
        const oddsResp = await afGet('v3.football.api-sports.io', '/odds', { fixture: fid });
        apiCallsUsed++;
        if (!oddsResp?.length) continue;

        const rawBks = oddsResp[0]?.bookmakers || [];

        // Bookie filter: dynamisch via user's preferredBookies (fallback trusted set).
        // Consensus/fairProbs gebruikt BREDE pool voor markt-truth; pick-odds filtering
        // gebeurt pas in bestFromArr via preferredBookies in lib/odds-parser.
        // Trusted bookies: user prefs + scherpe refs die altijd consensus versterken.
        const TRUSTED_FALLBACK = ['bet365', 'unibet', 'pinnacle', 'william hill', 'betfair', '888sport', 'marathonbet'];
        const preferredBookies = getPreferredBookies();
        const bkmsForConsensus = (preferredBookies?.length
          ? Array.from(new Set([...preferredBookies, 'pinnacle', 'william hill']))
          : TRUSTED_FALLBACK);
        const filteredBks = rawBks.filter(b =>
          bkmsForConsensus.some(name => b.name?.toLowerCase().includes(name))
        );
        if (filteredBks.length === 0) continue; // geen trusted bookies, skip

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

        // v10.8.16: ha = 0 — fp.home komt uit market consensus (inclusief HA).
        const ha = 0;
        const adjHome = Math.min(0.88, fp.home + posAdj + splitAdj + predAdj + lineupPenalty.home);
        const adjAway = Math.max(0.08, fp.away - posAdj * 0.5 - splitAdj * 0.5 - predAdj * 0.5 + lineupPenalty.away);
        const adjDraw = fp.draw && fp.draw > 0.05 ? fp.draw - posAdj * 0.3 - splitAdj * 0.2 : null;

        let formAdj = 0, formNote = '';
        if (hmSt && awSt) {
          if (hmSt.form && awSt.form) {
            const fmScore = s => [...(s.slice(-5)||'')].reduce((a,c)=>a+(c==='W'?3:c==='D'?1:0),0);
            formAdj = Math.max(-0.05, Math.min(0.05, (shrinkFormScore(fmScore(hmSt.form)) - shrinkFormScore(fmScore(awSt.form))) / 15 * 0.04));
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
        // v10.7.24: hmId/awId al eerder gedeclareerd uit f.teams; fallback
        // naar standings-teamId als fixture.teams.id leeg was.
        const hmIdResolved = hmId || hmSt?.teamId;
        const awIdResolved = awId || awSt?.teamId;
        if (hmIdResolved && awIdResolved) {
          const h2h = await fetchH2H(hmIdResolved, awIdResolved);
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

        // v10.7.25: early-season damping — form/h2h hebben lagere predictieve
        // kracht in ronde 1-4, dus signalen worden gedempt. Home-advantage en
        // injuries blijven ongedempt (die gelden sowieso).
        const totalAdjRaw = formAdj + injAdj + h2hAdj + congestionAdj;
        const dampedFormH2h = (formAdj + h2hAdj) * seasonInfo.dampingFactor;
        const totalAdj = earlySeason ? (dampedFormH2h + injAdj + congestionAdj) : totalAdjRaw;
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
          // v10.7.23: knockout stage + leg signalen (weight=0 default, auto-promote via CLV)
          if (knockoutInfo.isKnockout) {
            if (knockoutInfo.leg === 1) sigs.push('knockout_1st_leg:0%');
            if (knockoutInfo.leg === 2) sigs.push('knockout_2nd_leg:0%');
            if (knockoutInfo.stageLabel === 'finale') sigs.push('knockout_final:0%');
            else if (knockoutInfo.stageLabel === 'halve finale') sigs.push('knockout_semi:0%');
            else if (knockoutInfo.stageLabel === 'kwartfinale') sigs.push('knockout_quarter:0%');
          }
          // v10.7.24: rest-days signaal
          if (restInfo.signals.length) sigs.push(...restInfo.signals);
          // v10.7.25: aggregate-score signalen (2e leg)
          if (aggInfo.signals.length) sigs.push(...aggInfo.signals);
          // v10.7.25: early-season signaal (logging + damping in calc)
          if (seasonInfo.signals.length) sigs.push(...seasonInfo.signals);
          return sigs;
        };
        const matchSignals = buildSignals();

        // Human-readable knockout note voor reason string
        const knockoutNote = knockoutInfo.isKnockout && (knockoutInfo.stageLabel || knockoutInfo.leg)
          ? ` | 🥊 ${knockoutInfo.leg ? `${knockoutInfo.leg}e leg ` : ''}${knockoutInfo.stageLabel || 'knock-out'}`
          : '';

        const sharedNotes = `${posStr}${splitNote}${formNote}${injNote}${h2hNote}${refNote}${predNote}${lineupNote}${weatherNote}${poissonNote}${congestionNote}${knockoutNote}${restInfo.note}${aggInfo.note}${seasonInfo.note}`;
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

          // v10.7.25: aggregaat-effect op Over 2.5 in 2-leg ties.
          // Research: team trailing on aggregate pusht harder → Over% stijgt.
          // Hoe groter de deficit, hoe sterker de push (tot cap ±2 doelpunten
          // deficit; daarna effect plateaut). Bidirectional: ALS er overhaupt
          // een deficit is (ongeacht welke kant), Over boost.
          let aggOUAdj = 0, aggOUNote = '';
          if (aggInfo.aggDiff !== null && aggInfo.aggDiff !== undefined && aggInfo.aggDiff !== 0) {
            const absDiff = Math.abs(aggInfo.aggDiff);
            aggOUAdj = Math.min(0.04, 0.02 * absDiff); // +2% per deficit-doelpunt, cap 4%
            overP = Math.max(0.10, Math.min(0.90, overP + aggOUAdj));
            aggOUNote = ` | Aggregate-push Over: +${(aggOUAdj*100).toFixed(1)}%`;
          }

          const overEdge  = overP * over.best.price - 1;
          const underEdge = under.best.price > 0 ? (1-overP) * under.best.price - 1 : -1;
          const ouSignals = [...matchSignals];
          if (tsNote) ouSignals.push(`team_stats:${tsNote.replace(/[^+\-\d.%]/g,'').trim()}`);
          if (weatherOUAdj !== 0) ouSignals.push(`weather_ou:${(weatherOUAdj*100).toFixed(1)}%`);
          if (Math.abs(poissonOUAdj) >= 0.005) ouSignals.push(`poisson_ou:${poissonOUAdj>0?'+':''}${(poissonOUAdj*100).toFixed(1)}%`);
          if (aggOUAdj !== 0) ouSignals.push(`aggregate_push_ou:+${(aggOUAdj*100).toFixed(1)}%`);
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
              const afN = h2hData?.n || 0;
              const afBTTS = h2hData ? h2hData.bttsRate * afN : 0;
              let h2hN    = afN;
              let h2hBTTS = afBTTS;
              let h2hSources = afN > 0 ? ['api-football'] : [];
              // v10.9.0: enrich H2H met aggregator-data (sofascore + fotmob) als enabled.
              // Policy: REPLACE in plaats van ADD — voorkomt dubbel-tellen want api-football
              // en scrapers tonen vaak dezelfde recente ontmoetingen. We nemen de bron met
              // meeste samples (grotere n → minder shrinkage in calcBTTSProb).
              if (OPERATOR.scraping_enabled) {
                try {
                  const agg = require('./lib/data-aggregator');
                  const merged = await agg.getMergedH2H('football', hm, aw);
                  if (merged && merged.n > afN) {
                    h2hN    = merged.n;
                    h2hBTTS = merged.btts;
                    h2hSources = merged.sources || [];
                  }
                } catch { /* swallow: aggregator mag scan nooit breken */ }
              }
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

              // v10.7.25: aggregaat-push effect op BTTS in 2-leg ties.
              // Research: deficit → trailer moet scoren → BTTS Ja waarschijnlijker.
              // Maar bij BIG deficit (≥2) parkt trailer soms de bus en probeert
              // niet eens → BTTS effect vlakker. Cap op +3%.
              let aggBTTSAdj = 0;
              if (aggInfo.aggDiff !== null && aggInfo.aggDiff !== undefined && aggInfo.aggDiff !== 0) {
                const absDiff = Math.abs(aggInfo.aggDiff);
                aggBTTSAdj = Math.min(0.03, 0.02 * Math.min(2, absDiff));
                bttsYesP = Math.max(0.15, Math.min(0.85, bttsYesP + aggBTTSAdj));
              }

              const bttsNoP = 1 - bttsYesP;
              const bttsYesEdge = bttsYesP * bestYes.price - 1;
              const bttsNoEdge  = bttsNoP * bestNo.price - 1;
              const bttsSignals = [...matchSignals];
              if (bttsAdj > 0) bttsSignals.push(`btts_scoring:+${(bttsAdj*100).toFixed(1)}%`);
              if (csBoost > 0) bttsSignals.push(`btts_cleansheet:-${(csBoost*100).toFixed(1)}%`);
              if (bttWeatherAdj !== 0) bttsSignals.push(`btts_weather:${(bttWeatherAdj*100).toFixed(1)}%`);
              if (Math.abs(bttsPoissonAdj) >= 0.005) bttsSignals.push(`btts_poisson:${bttsPoissonAdj>0?'+':''}${(bttsPoissonAdj*100).toFixed(1)}%`);
              if (aggBTTSAdj !== 0) bttsSignals.push(`aggregate_push_btts:+${(aggBTTSAdj*100).toFixed(1)}%`);

              // v10.8.23: H2H sample size tonen in rationale zodat user ziet
              // hoe betrouwbaar de h2hRate-input is. Dunne samples (<5 games)
              // worden via BTTS_H2H_PRIOR_K richting neutraal getrokken.
              const sourceTag = h2hSources.length > 1 ? ` [${h2hSources.join('+')}]` : '';
              const h2hStr = h2hN > 0 ? ` | H2H: ${Math.round(h2hBTTS)}/${h2hN} BTTS${h2hN < 5 ? ' (dun)' : ''}${sourceTag}` : ' | H2H: —';
              if (bttsYesEdge >= MIN_EDGE && bestYes.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🔥 BTTS Ja`, bestYes.price,
                  `BTTS: ${(bttsYesP*100).toFixed(1)}% | ${bestYes.bookie}: ${bestYes.price} | GF: ${hmGFAvg}/${awGFAvg}${h2hStr} | ${ko}`,
                  Math.round(bttsYesP*100), bttsYesEdge * 0.22 * (cm.over?.multiplier ?? 1), kickoffTime, bestYes.bookie, bttsSignals, refereeName);

              if (bttsNoEdge >= MIN_EDGE && bestNo.price >= 1.60)
                mkP(`${hm} vs ${aw}`, league.name, `🛡️ BTTS Nee`, bestNo.price,
                  `BTTS Nee: ${(bttsNoP*100).toFixed(1)}% | ${bestNo.bookie}: ${bestNo.price} | GF: ${hmGFAvg}/${awGFAvg} | CS: ${hmTS2?.cleanSheetPct ? (hmTS2.cleanSheetPct*100).toFixed(0)+'%' : '?'}/${awTS2?.cleanSheetPct ? (awTS2.cleanSheetPct*100).toFixed(0)+'%' : '?'}${h2hStr} | ${ko}`,
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
    const hkc = kc * getKellyFraction();
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

  // v10.7.25: signal coverage telemetrie (zichtbaar in scan log + observability)
  const tel = scanTelemetry;
  const telLines = [
    `📊 Signal coverage:`,
    `  🛌 rest-days: ${tel.restDaysLookups} API calls, ${tel.restDaysCacheHits} cache hits, ${tel.restDaysFails} fails · tired flags: thuis=${tel.restDaysTiredHome} uit=${tel.restDaysTiredAway}`,
    `  🥊 knockout: ${tel.knockoutMatches} (1e leg ${tel.knockout1stLeg}, 2e leg ${tel.knockout2ndLeg})`,
    `  🏆 aggregaat: ${tel.aggregateFetched} fetched uit ${tel.knockout2ndLeg} 2e legs · leider thuis=${tel.aggregateLeaderHome} uit=${tel.aggregateLeaderAway} gelijk=${tel.aggregateSquare}`,
    `  🌱 new-season: ${tel.earlySeasonMatches} wedstrijden in ronde 1-4`,
  ];
  emit({ log: telLines.join('\n') });

  lastPrematchPicks = finalPicks;
  // Telegram wordt gestuurd NA multi-sport merge in POST /api/prematch
  emit({ log: `✅ Voetbal scan klaar.`, picks: finalPicks });

  // ── Upgrade / unit-size check na scan ────────────────────────────────────
  try {
    const cs = loadCalib();
    // v10.9.8: admin-scoped, geen globale readBets.
    const adminUserId = await getAdminUserId();
    const money = await getUserMoneySettings(adminUserId);
    const { stats } = await readBets(adminUserId, money).catch(() => ({ stats: {} }));
    const bkr = stats.bankroll ?? money.startBankroll;
    const bkrGrowth = bkr - money.startBankroll;
    const roi2 = stats.roi ?? 0;
    // v10.9.5: upgrade-aanbevelingen ook naar inbox (Supabase notifications),
    // niet alleen Telegram. Telegram kan user missen of niet checken; inbox is
    // het permanente logboek van beslissingen. Plus: sommige aanbevelingen
    // (zoals All-Sports upgrade) zijn al uitgevoerd — zonder inbox-geschiedenis
    // weet je niet of je een oude of nieuwe prompt krijgt.
    // v10.9.6: dedup-guard. User meldde dat API-upgrade-notif elke scan kwam,
    // terwijl upgrade al gedaan was. Fix: (1) permanent-dismiss vlag via
    // calib (cs.upgrades_dismissed[type]=true), (2) rate-limit van 7 dagen
    // tussen dezelfde notificatie-type zodat het niet spamt als user nog geen
    // dismiss heeft doorgegeven. Admin dismist via /api/admin/v2/upgrade-ack.
    const now = Date.now();
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    cs.upgrades_dismissed = cs.upgrades_dismissed || {};
    cs.upgrades_lastAt = cs.upgrades_lastAt || {};
    const canFire = (key) => {
      if (cs.upgrades_dismissed[key]) return false;
      const lastAt = cs.upgrades_lastAt[key] || 0;
      return (now - lastAt) > WEEK_MS;
    };
    if (bkrGrowth >= money.startBankroll && canFire('upgrade_unit')) {
      const title = `💰 Unit-verhoging aanbevolen`;
      const body = `Bankroll: €${bkr.toFixed(0)} (+100% sinds start). Overweeg unit van €${money.unitEur} → €${money.unitEur * 2}. Accepteer via Instellingen. (Wordt pas over 7 dagen opnieuw getoond; dismiss permanent via admin.)`;
      await tg(`💰 UNIT VERHOGING AANBEVOLEN\nBankroll: €${bkr.toFixed(0)} (+100%)\nOverweeg unit van €${money.unitEur} → €${money.unitEur*2}\n\nAccepteer via de instellingen.`).catch(() => {});
      await supabase.from('notifications').insert({
        type: 'upgrade_unit', title, body, read: false, user_id: null,
      }).then(() => {}, () => {});
      cs.upgrades_lastAt.upgrade_unit = now;
      await saveCalib(cs).catch(() => {});
    } else if (cs.totalSettled >= 30 && roi2 > 0.10 && canFire('upgrade_api')) {
      const title = `🚀 API-upgrade overweging`;
      const body = `ROI ${(roi2 * 100).toFixed(1)}% over ${cs.totalSettled} bets · overweeg api-sports All Sports upgrade ($99/mnd). (Negeer als al gedaan. Wordt pas over 7d opnieuw getoond; dismiss permanent via admin.)`;
      await tg(`🚀 ROI ${(roi2*100).toFixed(1)}% over ${cs.totalSettled} bets.\nOverweeg All Sports upgrade ($99/mnd) voor meer markten.`).catch(() => {});
      await supabase.from('notifications').insert({
        type: 'upgrade_api', title, body, read: false, user_id: null,
      }).then(() => {}, () => {});
      cs.upgrades_lastAt.upgrade_api = now;
      await saveCalib(cs).catch(() => {});
    }
  } catch (e) {
    console.warn('Unit uplevel / ROI-milestone Telegram notification failed:', e.message);
  }


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

  // Net units: per-bet division door unit_at_time (v10.10.7); legacy fallback
  // huidige unitEur. Vervangt eerdere proxy die alle wl door één unit deelde.
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
           potentialWin, potentialLoss, todayBetsCount };
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

// Helper: haal user's bankroll/unit settings in 1 read zodat analytics,
// staking en compounding overal dezelfde waarheid gebruiken.
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

// Helper: haal user's unitEur (stake per unit) of fallback naar default.
async function getUserUnitEur(userId) {
  const { unitEur } = await getUserMoneySettings(userId);
  return unitEur;
}

async function writeBet(bet, userId = null, unitEur = null) {
  const ue = unitEur ?? await getUserUnitEur(userId);
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
  // Schema-tolerant: tier 1 = full payload (v10.10.7+); tier 2 = zonder
  // fixture_id; tier 3 = ook zonder unit_at_time (pre-v10.10.7 schema).
  const isColumnError = (msg) => (msg || '').toLowerCase().includes('column');
  const safeInsert = async (payload) => {
    try {
      const { error } = await supabase.from('bets').insert(payload);
      return error || null;
    } catch (e) {
      return { message: e.message };
    }
  };
  let err = await safeInsert({ ...base, fixture_id: bet.fixtureId || null });
  if (err && isColumnError(err.message)) err = await safeInsert(base);
  if (err && isColumnError(err.message)) {
    const { unit_at_time, ...legacy } = base;
    err = await safeInsert(legacy);
  }
  if (err) throw new Error(err.message);
}

async function updateBetOutcome(id, uitkomst, userId = null) {
  let query = supabase.from('bets').select('*').eq('bet_id', id);
  if (userId) query = query.eq('user_id', userId);
  const { data: row } = await query.single();
  if (!row) return;
  const odds = row.odds || 0;
  const units = row.units || 0;
  const userUnitEur = await getUserUnitEur(userId);
  const inzet = row.inzet != null ? row.inzet : +(units * userUnitEur).toFixed(2);
  const wl = uitkomst === 'W' ? +((odds-1)*inzet).toFixed(2) : uitkomst === 'L' ? -inzet : 0;
  let updateQuery = supabase.from('bets').update({ uitkomst, wl }).eq('bet_id', id);
  if (userId) updateQuery = updateQuery.eq('user_id', userId);
  await updateQuery;
  await updateCalibration({ datum: row.datum, wedstrijd: row.wedstrijd, markt: row.markt,
                            odds, units, uitkomst, wl, sport: row.sport || 'football' }, userId);
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
      const code = String(require('crypto').randomInt(100000, 999999));
      loginCodes.set(user.email, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
      const sent = await sendEmail(user.email, 'EdgePickr login code', `<h2>Je login code: ${code}</h2><p>Geldig voor 5 minuten.</p>`);
      if (!sent) {
        loginCodes.delete(user.email);
        return res.status(500).json({ error: 'Kon verificatie-email niet verzenden. Probeer later opnieuw.' });
      }
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

// ── v2 Admin: calibration-monitor read (slice 2, v10.10.16) ────────────────
// GET /api/admin/v2/calibration-monitor?window=90d&sport=football
// Leest per-signaal Brier/log-loss/bins uit signal_calibration. Rows dragen
// expliciet `probability_source` zodat v1 ep_proxy niet als canonical
// pick.ep-calibratie gelezen wordt. Optioneel filterable op window_key /
// sport / market_type. Niet-paginated: huidige cardinaliteit is
// signals × sporten × markten × 4 windows = O(100-500) rows.
app.get('/api/admin/v2/calibration-monitor', requireAdmin, async (req, res) => {
  try {
    const window = typeof req.query.window === 'string' ? req.query.window : null;
    const sport = typeof req.query.sport === 'string' ? req.query.sport : null;
    const marketType = typeof req.query.market_type === 'string' ? req.query.market_type : null;
    const allowedWindows = new Set(['30d', '90d', '365d', 'lifetime']);
    let query = supabase.from('signal_calibration')
      .select('*')
      .order('brier_score', { ascending: true, nullsLast: true })
      .limit(2000);
    if (window && allowedWindows.has(window)) query = query.eq('window_key', window);
    if (sport) query = query.eq('sport', sport);
    if (marketType) query = query.eq('market_type', marketType);
    const { data, error } = await query;
    if (error) {
      if (/relation .* does not exist/i.test(error.message || '')) {
        return res.json({ ready: false, reason: 'signal_calibration tabel niet gemigreerd', rows: [] });
      }
      return res.status(500).json({ error: error.message });
    }
    const rows = data || [];
    return res.json({
      ready: true,
      filters: { window, sport, market_type: marketType },
      rowCount: rows.length,
      rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// v10.9.6: POST /api/admin/v2/upgrade-ack — permanent dismiss een
// upgrade-aanbeveling-type (upgrade_api / upgrade_unit) zodat die niet opnieuw
// vuurt. Body: { type: 'upgrade_api', dismissed: true }.
app.post('/api/admin/v2/upgrade-ack', requireAdmin, async (req, res) => {
  try {
    const valid = new Set(['upgrade_api', 'upgrade_unit']);
    const type = String(req.body?.type || '');
    if (!valid.has(type)) return res.status(400).json({ error: 'unknown type; allowed: upgrade_api, upgrade_unit' });
    const dismissed = req.body?.dismissed !== false;
    const cs = loadCalib();
    cs.upgrades_dismissed = cs.upgrades_dismissed || {};
    cs.upgrades_dismissed[type] = dismissed;
    await saveCalib(cs);
    res.json({ ok: true, type, dismissed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// v10.9.2: GET /api/admin/v2/scrape-diagnose?name=X — live-test één bron met
// detail-error (HTTP status + error reason). Gebruikt returnDetails=true op
// safeFetch. Gebruik om te zien waarom een bron faalt in productie.
app.get('/api/admin/v2/scrape-diagnose', requireAdmin, async (req, res) => {
  try {
    const { safeFetch } = require('./lib/scraper-base');
    const name = String(req.query.name || '').trim();
    const probes = {
      'sofascore': { url: 'https://api.sofascore.com/api/v1/search/suggestions/Arsenal', hosts: ['api.sofascore.com'] },
      'fotmob': { url: 'https://www.fotmob.com/api/searchapi/suggest?term=Arsenal', hosts: ['www.fotmob.com'] },
      'nba-stats': { url: 'https://stats.nba.com/stats/leaguestandings?LeagueID=00&Season=2025-26&SeasonType=Regular+Season', hosts: ['stats.nba.com'],
        headers: {
          'Referer': 'https://www.nba.com/', 'Origin': 'https://www.nba.com',
          'x-nba-stats-origin': 'stats', 'x-nba-stats-token': 'true',
        } },
      'nhl-api': { url: 'https://api-web.nhle.com/v1/standings/now', hosts: ['api-web.nhle.com'] },
      'mlb-stats-ext': { url: 'https://statsapi.mlb.com/api/v1/standings?leagueId=103,104&season=2025', hosts: ['statsapi.mlb.com'] },
    };
    const probe = probes[name];
    if (!probe) return res.status(400).json({ error: 'unknown source', allowed: Object.keys(probes) });
    const t0 = Date.now();
    const result = await safeFetch(probe.url, {
      allowedHosts: probe.hosts,
      headers: probe.headers || {},
      returnDetails: true,
    });
    const latency = Date.now() - t0;
    res.json({
      source: name,
      url: probe.url,
      latencyMs: latency,
      ...result,
      sample: result.data ? JSON.stringify(result.data).slice(0, 400) : null,
    });
  } catch (e) {
    res.status(500).json({ error: 'diagnose failed', detail: e.message });
  }
});

// v10.9.0: GET /api/admin/v2/scrape-sources — status alle externe data-sources.
// Levert health, breaker state, enabled-flag. Geen auth-lekkage; alleen admin.
app.get('/api/admin/v2/scrape-sources', requireAdmin, async (req, res) => {
  try {
    const dataAggregator = require('./lib/data-aggregator');
    const scraperBase = require('./lib/scraper-base');
    const [health, breakers] = await Promise.all([
      dataAggregator.healthCheckAll(),
      Promise.resolve(scraperBase.allBreakerStatuses()),
    ]);
    res.json({
      scraping_enabled: OPERATOR.scraping_enabled,
      sources: scraperBase.listSources(),
      health,
      breakers,
    });
  } catch (e) {
    res.status(500).json({ error: 'scrape-sources fetch failed', detail: e.message });
  }
});

// v10.9.0: POST /api/admin/v2/scrape-sources — enable/disable source runtime.
// Body: { name: 'sofascore', enabled: true } of { action: 'reset-breaker', name: 'sofascore' }
app.post('/api/admin/v2/scrape-sources', requireAdmin, async (req, res) => {
  try {
    const scraperBase = require('./lib/scraper-base');
    const body = req.body || {};
    const validNames = ['sofascore', 'fotmob', 'nba-stats', 'nhl-api', 'mlb-stats-ext'];
    if (body.action === 'reset-breaker') {
      if (!validNames.includes(body.name)) return res.status(400).json({ error: 'unknown source' });
      const b = scraperBase.getBreaker(body.name);
      if (b) b.reset();
      return res.json({ ok: true, action: 'reset-breaker', name: body.name });
    }
    if (!validNames.includes(body.name)) return res.status(400).json({ error: 'unknown source; allowed: ' + validNames.join(', ') });
    scraperBase.setSourceEnabled(body.name, !!body.enabled);
    // v10.9.9: persist naar calib zodat toggle-state deploys/restarts overleeft.
    const cs = loadCalib();
    cs.scraper_sources = cs.scraper_sources || {};
    cs.scraper_sources[body.name] = !!body.enabled;
    await saveCalib(cs).catch(() => {});
    res.json({ ok: true, name: body.name, enabled: !!body.enabled, persisted: true });
  } catch (e) {
    res.status(500).json({ error: 'scrape-sources update failed', detail: e.message });
  }
});

// GET/POST /api/admin/v2/operator — minimal failsafe-toggles
app.get('/api/admin/v2/operator', requireAdmin, (req, res) => {
  res.json({ ...OPERATOR, kill_switch_active_count: KILL_SWITCH.set.size });
});
app.post('/api/admin/v2/operator', requireAdmin, async (req, res) => {
  const allowed = ['master_scan_enabled', 'market_auto_kill_enabled', 'signal_auto_kill_enabled', 'panic_mode', 'max_picks_per_day', 'scraping_enabled'];
  for (const k of allowed) {
    if (req.body && req.body[k] !== undefined) {
      OPERATOR[k] = (k === 'max_picks_per_day') ? Math.max(1, Math.min(10, parseInt(req.body[k]) || 5)) : !!req.body[k];
    }
  }
  KILL_SWITCH.enabled = OPERATOR.market_auto_kill_enabled;
  await saveOperatorState();
  res.json({ ...OPERATOR, kill_switch_active_count: KILL_SWITCH.set.size });
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

// GET /api/admin/v2/drift — vergelijk windows 25/50/100 vs all-time per markt/signaal/bookie
// Sample size altijd zichtbaar. Geen alert tier bij n < min_n om niet jezelf voor de gek te houden.
app.get('/api/admin/v2/drift', requireAdmin, async (req, res) => {
  try {
    const { data: bets, error } = await supabase.from('bets')
      .select('sport, markt, tip, clv_pct, signals, datum').not('clv_pct', 'is', null)
      .order('datum', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    const all = (bets || []).filter(b => typeof b.clv_pct === 'number' && !isNaN(b.clv_pct));
    const WINDOWS = [25, 50, 100];

    const computeWindowed = (entityKey) => {
      // entityKey(b) returns string key of entity, of array of keys (voor signals)
      const stats = {};
      for (let i = 0; i < all.length; i++) {
        const b = all[i];
        const keys = entityKey(b);
        if (!keys) continue;
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) {
          if (!stats[k]) stats[k] = { all: [], w25: [], w50: [], w100: [] };
          stats[k].all.push(b.clv_pct);
          if (i < 25) stats[k].w25.push(b.clv_pct);
          if (i < 50) stats[k].w50.push(b.clv_pct);
          if (i < 100) stats[k].w100.push(b.clv_pct);
        }
      }
      return Object.entries(stats).map(([k, s]) => {
        const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
        const avgAll = avg(s.all);
        const avg25 = avg(s.w25);
        const avg50 = avg(s.w50);
        const avg100 = avg(s.w100);
        // Alert alleen bij n_recent ≥ 10 EN n_all ≥ 30 (anders geen vertrouwen)
        let alert = null;
        if (s.w25.length >= 10 && s.all.length >= 30 && avg25 != null && avgAll != null) {
          const drift = avg25 - avgAll;
          if (drift < -2) alert = '🔴 SLECHTER';
          else if (drift > 2) alert = '✅ BETER';
        }
        return {
          key: k,
          n_all: s.all.length, n_25: s.w25.length, n_50: s.w50.length, n_100: s.w100.length,
          avg_all: avgAll, avg_25: avg25, avg_50: avg50, avg_100: avg100, alert,
        };
      }).sort((a, b) => (a.avg_25 || 0) - (b.avg_25 || 0));
    };

    const marketDrift = computeWindowed(b => `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`);
    const bookieDrift = computeWindowed(b => (b.tip || 'unknown'));
    const signalDrift = computeWindowed(b => {
      try {
        const sigs = typeof b.signals === 'string' ? JSON.parse(b.signals) : b.signals;
        if (!Array.isArray(sigs)) return null;
        return sigs.map(s => String(s).split(':')[0]).filter(Boolean);
      } catch { return null; }
    });

    res.json({
      ok: true, total_bets: all.length, windows: WINDOWS,
      marketDrift, bookieDrift, signalDrift,
      note: 'Alert alleen bij ≥10 in window én ≥30 totaal. Sample size altijd zichtbaar.',
    });
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
    // Point-in-time anchor: gebruik created_at van de bet (logmoment) als cutoff.
    // Snapshots NA dat moment zijn niet de context waarin de pick ontstond.
    const anchorIso = bet.created_at || (bet.datum && bet.tijd
      ? (() => {
          const dm = bet.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
          return dm ? `${dm[3]}-${dm[2]}-${dm[1]}T${bet.tijd}:00Z` : new Date().toISOString();
        })()
      : new Date().toISOString());
    // Pak laatste model_run die VOOR de bet werd gemaakt
    const marketType = detectMarket(bet.markt || 'other');
    const { data: runs } = await supabase.from('model_runs')
      .select('*').eq('fixture_id', fxId).lte('captured_at', anchorIso).order('captured_at', { ascending: false });
    const matchingRun = (runs || []).find(r => r.market_type?.includes(marketType.replace('60', ''))) || (runs || [])[0];
    // Pak feature_snapshot van vóór bet
    const { data: feat } = await supabase.from('feature_snapshots')
      .select('*').eq('fixture_id', fxId).lte('captured_at', anchorIso).order('captured_at', { ascending: false }).limit(1).maybeSingle();
    // Pak market_consensus van vóór bet
    const { data: cons } = await supabase.from('market_consensus')
      .select('*').eq('fixture_id', fxId).lte('captured_at', anchorIso).order('captured_at', { ascending: false }).limit(1).maybeSingle();
    // Pak pick_candidate
    const { data: candidates } = await supabase.from('pick_candidates')
      .select('*').eq('fixture_id', fxId).order('created_at', { ascending: false });
    const { data: fixture } = await supabase.from('fixtures')
      .select('id, start_time').eq('id', fxId).maybeSingle();
    const { data: snaps } = await supabase.from('odds_snapshots')
      .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
      .eq('fixture_id', fxId)
      .limit(5000);
    // Top 5 signal contributions: parse signals string voor magnitudes
    let topContributions = [];
    let allSignals = [];
    try {
      const sigsStr = bet.signals || '';
      const sigs = typeof sigsStr === 'string' ? JSON.parse(sigsStr) : sigsStr;
      if (Array.isArray(sigs)) {
        allSignals = sigs;
        topContributions = sigs.map(s => {
          const str = String(s);
          // Format: "name:+X.X%" of "name:flag"
          const m = str.match(/^([^:]+):([+-]?[\d.]+)%?/);
          if (m) return { name: m[1], magnitude_pct: parseFloat(m[2]) };
          return { name: str, magnitude_pct: null };
        }).filter(x => x.magnitude_pct !== null)
          .sort((a, b) => Math.abs(b.magnitude_pct) - Math.abs(a.magnitude_pct))
          .slice(0, 5);
      }
    } catch (e) {
      console.warn('why-this-pick: signal parsing failed:', e.message);
    }
    const matchedCandidate = (candidates || []).find(c =>
      normalizeBookmaker(c.bookmaker) === normalizeBookmaker(bet.tip) &&
      Math.abs((parseFloat(c.bookmaker_odds) || 0) - (parseFloat(bet.odds) || 0)) < 0.01
    ) || (candidates || []).find(c => normalizeBookmaker(c.bookmaker) === normalizeBookmaker(bet.tip)) || null;
    const users = await loadUsers().catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    const preferredBookiesLower = (admin?.settings?.preferredBookies || [])
      .map(x => (x || '').toString().toLowerCase()).filter(Boolean);
    const execution = matchedCandidate
      ? summarizeExecutionQuality(snaps || [], {
          marketType: matchedCandidate.market_type,
          selectionKey: matchedCandidate.selection_key,
          line: matchedCandidate.line,
          bookmaker: bet.tip || matchedCandidate.bookmaker || '',
          anchorIso,
          preferredBookiesLower,
          startTimeIso: fixture?.start_time || null,
        })
      : null;

    res.json({
      bet: { id: bet.bet_id, wedstrijd: bet.wedstrijd, markt: bet.markt, odds: bet.odds, uitkomst: bet.uitkomst, clv_pct: bet.clv_pct },
      market_baseline: matchingRun?.baseline_prob || null,
      model_delta: matchingRun?.model_delta || null,
      final_prob: matchingRun?.final_prob || null,
      top_contributions: topContributions,
      all_signals: allSignals,
      market_consensus: cons ? { type: cons.market_type, prob: cons.consensus_prob, bookies: cons.bookmaker_count, quality: cons.quality_score } : null,
      features: feat?.features || null,
      data_quality: feat?.quality || null,
      pick_candidates: (candidates || []).map(c => ({
        selection: c.selection_key, bookie: c.bookmaker, odds: c.bookmaker_odds,
        fair_prob: c.fair_prob, edge_pct: c.edge_pct, passed: c.passed_filters, rejected: c.rejected_reason,
      })),
      execution,
      model_version_id: matchingRun?.model_version_id,
      run_captured_at: matchingRun?.captured_at,
      point_in_time_anchor: anchorIso,
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/v2/execution-quality — punt-in-tijd execution analyse voor
// een specifieke fixture/markt/selectie. Helpt bepalen of een prijs speelbaar,
// stale of juist markt-beatend was.
app.get('/api/admin/v2/execution-quality', requireAdmin, async (req, res) => {
  try {
    const fixtureId = parseInt(req.query.fixture_id);
    const marketType = String(req.query.market_type || '').trim();
    const selectionKey = String(req.query.selection_key || '').trim();
    if (!fixtureId || !marketType || !selectionKey) {
      return res.status(400).json({ error: 'fixture_id, market_type en selection_key zijn verplicht' });
    }
    const line = req.query.line != null && req.query.line !== '' ? parseFloat(req.query.line) : null;
    const bookmaker = String(req.query.bookmaker || '').trim();
    const anchorIso = req.query.anchor_iso ? new Date(String(req.query.anchor_iso)).toISOString() : null;
    const { data: fixture } = await supabase.from('fixtures').select('id, start_time').eq('id', fixtureId).maybeSingle();
    const { data: snaps } = await supabase.from('odds_snapshots')
      .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
      .eq('fixture_id', fixtureId)
      .limit(5000);
    const users = await loadUsers().catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    const preferredBookiesLower = (admin?.settings?.preferredBookies || [])
      .map(x => (x || '').toString().toLowerCase()).filter(Boolean);
    const execution = summarizeExecutionQuality(snaps || [], {
      marketType,
      selectionKey,
      line,
      bookmaker,
      anchorIso,
      preferredBookiesLower,
      startTimeIso: fixture?.start_time || null,
    });
    res.json({
      fixture_id: fixtureId,
      start_time: fixture?.start_time || null,
      execution,
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

    // Freshness: oudste feature_snapshot in window
    let oldestAgeMin = null;
    if (feats && feats.length) {
      const oldest = feats.reduce((min, f) => {
        const t = new Date(f.captured_at).getTime();
        return min == null || t < min ? t : min;
      }, null);
      if (oldest) oldestAgeMin = Math.round((Date.now() - oldest) / 60000);
    }

    // Average bookmaker count per consensus snapshot in window
    const { data: cons } = await supabase.from('market_consensus')
      .select('bookmaker_count, quality_score').gte('captured_at', sinceIso);
    const avgBookies = (cons || []).length ? +(cons.reduce((s, c) => s + (c.bookmaker_count || 0), 0) / cons.length).toFixed(1) : null;
    const avgQuality = (cons || []).length ? +(cons.reduce((s, c) => s + (c.quality_score || 0), 0) / cons.length).toFixed(3) : null;

    res.json({
      hours, totalFeatures: totalFeats,
      qualityIssues: issues,
      missingOdds: { fixtures_with_features_but_no_odds: missingOddsCount },
      consensus: { snapshots: (cons || []).length, avg_bookmaker_count: avgBookies, avg_quality_score: avgQuality },
      freshness: { oldest_feature_snapshot_age_min: oldestAgeMin },
      summary: {
        healthy_pct: totalFeats > 0 ? +((totalFeats - issues.no_standings - issues.lineup_missing) / totalFeats * 100).toFixed(1) : 100,
      },
    });
  } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
});

// GET /api/admin/odds-drift — wanneer zijn odds gemiddeld het beste?
// v10.8.14: aggregeert odds_snapshots per (sport, market_type, uren-voor-kickoff)
// en toont de gemiddelde drift t.o.v. de closing line. Negatieve drift = odds
// waren vroeger HOGER dan nu → vroege inzet was waardevoller.
// Positieve drift = odds waren lager, later inzetten was beter.
app.get('/api/admin/odds-drift', requireAdmin, async (req, res) => {
  try {
    const days = Math.max(1, Math.min(30, parseInt(req.query.days) || 14));
    const sinceIso = new Date(Date.now() - days * 86400 * 1000).toISOString();
    // v10.8.15: scope toggle. 'mine' (default) filtert naar fixtures waar user
    // zelf op heeft gelogd — voorheen toonde de view ook sporten/wedstrijden
    // die user nooit heeft aangeraakt. 'all' houdt het brede beeld (meer
    // samples, betrouwbaarder per bucket), handig voor research.
    const scope = (req.query.scope === 'all') ? 'all' : 'mine';

    // Stap 1: fixtures die al gestart zijn in de window (we willen close-odds)
    const nowIso = new Date().toISOString();
    const { data: fixtures } = await supabase.from('fixtures')
      .select('id, sport, start_time')
      .gte('start_time', sinceIso)
      .lt('start_time', nowIso)
      .limit(800);
    if (!fixtures?.length) return res.json({ days, scope, totalFixtures: 0, buckets: [] });
    let allowedIds = null;
    if (scope === 'mine') {
      const { data: myBets } = await supabase.from('bets')
        .select('fixture_id').eq('user_id', req.user?.id).not('fixture_id', 'is', null);
      allowedIds = new Set((myBets || []).map(b => b.fixture_id));
    }
    const filteredFixtures = allowedIds
      ? fixtures.filter(f => allowedIds.has(f.id))
      : fixtures;
    if (!filteredFixtures.length) return res.json({
      days, scope, totalFixtures: 0, buckets: [],
      note: scope === 'mine' ? 'Nog geen gelogde bets in deze window. Schakel naar scope=all voor brede data.' : undefined,
    });
    const fixtureMap = new Map(filteredFixtures.map(f => [f.id, f]));
    const fixtureIds = filteredFixtures.map(f => f.id);

    // Stap 2: snapshots voor deze fixtures, paginated om Supabase 1000-row cap te ontwijken
    const snapshots = [];
    const BATCH = 200;
    for (let i = 0; i < fixtureIds.length; i += BATCH) {
      const batch = fixtureIds.slice(i, i + BATCH);
      const { data: snaps } = await supabase.from('odds_snapshots')
        .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
        .in('fixture_id', batch)
        .limit(5000);
      if (snaps?.length) snapshots.push(...snaps);
      if (snapshots.length >= 20000) break; // hard cap
    }
    if (!snapshots.length) return res.json({ days, scope, totalFixtures: filteredFixtures.length, totalSnapshots: 0, buckets: [] });

    // Stap 3: groeperen per (fixture, bookmaker, market_type, selection_key, line)
    // Voor elke groep: sorteer op captured_at, laatste = close line.
    const groups = new Map();
    for (const s of snapshots) {
      const key = `${s.fixture_id}|${s.bookmaker}|${s.market_type}|${s.selection_key}|${s.line || ''}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }

    // Stap 4: per groep drift per snapshot berekenen t.o.v. close
    // Bucket: 0-2h / 2-6h / 6-12h / 12-24h / 24-48h / 48h+
    const bucketize = (hrs) => {
      if (hrs < 2) return '0-2h';
      if (hrs < 6) return '2-6h';
      if (hrs < 12) return '6-12h';
      if (hrs < 24) return '12-24h';
      if (hrs < 48) return '24-48h';
      return '48h+';
    };
    const BUCKETS = ['0-2h', '2-6h', '6-12h', '12-24h', '24-48h', '48h+'];

    // Aggregate: key = sport|market_type|bucket → { sumDrift, count, sumAbs }
    const agg = new Map();

    for (const [, snaps] of groups) {
      if (snaps.length < 2) continue; // nodig close + vroege snapshot
      snaps.sort((a, b) => new Date(a.captured_at) - new Date(b.captured_at));
      const close = snaps[snaps.length - 1];
      const closeOdds = parseFloat(close.odds);
      if (!(closeOdds > 1)) continue;
      const fix = fixtureMap.get(close.fixture_id);
      if (!fix?.start_time) continue;
      const sport = normalizeSport(fix.sport);
      const startMs = new Date(fix.start_time).getTime();

      for (let i = 0; i < snaps.length - 1; i++) {
        const snap = snaps[i];
        const o = parseFloat(snap.odds);
        if (!(o > 1)) continue;
        const hrsBeforeKick = (startMs - new Date(snap.captured_at).getTime()) / 3600000;
        if (hrsBeforeKick <= 0) continue; // na kickoff — skip
        const bucket = bucketize(hrsBeforeKick);
        const drift = ((closeOdds - o) / o) * 100; // positief = odds zijn later gestegen
        const aggKey = `${sport}|${snap.market_type}|${bucket}`;
        if (!agg.has(aggKey)) agg.set(aggKey, { sport, market_type: snap.market_type, bucket, sumDrift: 0, sumAbs: 0, count: 0 });
        const a = agg.get(aggKey);
        a.sumDrift += drift;
        a.sumAbs += Math.abs(drift);
        a.count++;
      }
    }

    const buckets = Array.from(agg.values())
      .map(a => ({
        sport: a.sport,
        market_type: a.market_type,
        bucket: a.bucket,
        n: a.count,
        avg_drift_pct: +(a.sumDrift / a.count).toFixed(3),
        avg_abs_drift_pct: +(a.sumAbs / a.count).toFixed(3),
      }))
      .filter(b => b.n >= 5) // min samplegrootte
      .sort((a, b) => a.sport.localeCompare(b.sport) || a.market_type.localeCompare(b.market_type) || BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket));

    // Insight: per sport+markt, welke bucket geeft gemiddeld de beste entry?
    // Beste = hoogste positieve avg_drift (odds zijn sindsdien gestegen) OF grootste negatieve (toen was prijs hoger).
    // Voor inzetter: NEGATIEF drift is beter (odds waren vroeger hoger dan close).
    const bestEntry = {};
    for (const b of buckets) {
      const k = `${b.sport}|${b.market_type}`;
      if (!bestEntry[k] || b.avg_drift_pct < bestEntry[k].avg_drift_pct) {
        bestEntry[k] = { bucket: b.bucket, avg_drift_pct: b.avg_drift_pct, n: b.n };
      }
    }

    res.json({
      days, scope, totalFixtures: filteredFixtures.length, totalSnapshots: snapshots.length,
      buckets, bestEntry,
      note: 'avg_drift_pct: % verandering naar close. Negatief = odds waren vroeger HOGER (vroege inzet beter). Positief = later inzetten was beter.',
    });
  } catch (e) {
    console.error('odds-drift fout:', e.message);
    res.status(500).json({ error: e.message });
  }
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
  await savePushSub(sub, req.user?.id || null);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'Geen endpoint' });
  await deletePushSub(endpoint);
  res.json({ ok: true });
});

// Prematch scan · SSE streaming (inclusief live check op moment van draaien)
// ── v10.8.13: shared multi-sport scan pipeline ──────────────────────────────
// Extractie uit de /api/prematch route zodat zowel de handmatige trigger
// (SSE streaming) als de cron-scheduler exact dezelfde pipeline draaien,
// INCLUSIEF de multi-sport scans en de tg() notificatie. Voorheen deed de
// cron alleen runPrematch() (football, geen notificatie) — verklaarde de
// missende 14:00 push.
async function runFullScan({ emit = () => {}, prefs = null, isAdmin = true, triggerLabel = 'manual' } = {}) {
  try {
    setPreferredBookies(prefs);
    if (prefs?.length) emit({ log: `🏦 Edge-evaluatie op jouw bookies: ${prefs.join(', ')}` });
    // v10.9.9: refresh admin's actieve unit/bankroll zodat pick-ranking en
    // expectedEur-display meeschalen met compounding-updates (admin-settings).
    await refreshActiveUnitEur();
    if (_activeUnitEur !== UNIT_EUR || _activeStartBankroll !== START_BANKROLL) {
      emit({ log: `💰 Actieve unit: €${_activeUnitEur} · bankroll: €${_activeStartBankroll}` });
    }

    const footballPicks = await runPrematch(emit);

    emit({ log: '🏀🏒⚾🏈🤾 Multi-sport scans starten...' });
    const [nbaPicks, nhlPicks, mlbPicks, nflPicks, handballPicks] = await Promise.all([
      runBasketball(emit).catch(err => { emit({ log: `⚠️ Basketball scan mislukt: ${err.message}` }); return []; }),
      runHockey(emit).catch(err => { emit({ log: `⚠️ Hockey scan mislukt: ${err.message}` }); return []; }),
      runBaseball(emit).catch(err => { emit({ log: `⚠️ Baseball scan mislukt: ${err.message}` }); return []; }),
      runFootballUS(emit).catch(err => { emit({ log: `⚠️ NFL scan mislukt: ${err.message}` }); return []; }),
      runHandball(emit).catch(err => { emit({ log: `⚠️ Handball scan mislukt: ${err.message}` }); return []; }),
    ]);

    let allPicks = [...footballPicks, ...nbaPicks, ...nhlPicks, ...mlbPicks, ...nflPicks, ...handballPicks];

    // Kill-switch enforcement
    const beforeKill = allPicks.length;
    const killedPicks = allPicks.filter(p => isMarketKilled(p.sport, p.label));
    allPicks = allPicks.filter(p => !isMarketKilled(p.sport, p.label));
    const killedCount = beforeKill - allPicks.length;
    if (killedCount > 0) {
      emit({ log: `🛑 Kill-switch: ${killedCount} pick(s) geblokkeerd op markt-CLV regels` });
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

    // v10.10.18: correlatie-demping op league-day clusters + same-fixture.
    // Sterkste pick in elk cluster behoudt volle kelly, rest wordt gedempt.
    const preDampCount = allPicks.filter(p => p.correlationAudit).length;
    applyCorrelationDamp(allPicks);
    const dampedCount = allPicks.filter(p => p.correlationAudit && p.correlationAudit.dampFactor < 1.0).length;
    if (dampedCount > 0) emit({ log: `📉 Correlatie-demping: ${dampedCount} pick(s) gedempt (zelfde league/dag of wedstrijd)` });

    allPicks.sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0));

    // Diversification
    const MAX_PICKS = OPERATOR.panic_mode ? Math.min(2, OPERATOR.max_picks_per_day) : OPERATOR.max_picks_per_day;
    const MAX_PER_MATCH = 1;
    // v10.8.16: refresh per-sport caps (cache TTL 10min). Non-blocking op cache
    // miss, gebruikt dan default 2 per sport tot de eerstvolgende scan.
    if (Date.now() - _sportCapCache.at > SPORT_CAP_TTL_MS) {
      await refreshSportCaps().catch(() => {});
    }
    if (OPERATOR.panic_mode) {
      const beforePanic = allPicks.length;
      allPicks = allPicks.filter(p => {
        const key = `${normalizeSport(p.sport)}_${detectMarket(p.label)}`;
        return (_marketSampleCache.data[key] || 0) >= 100;
      });
      const panicSkipped = beforePanic - allPicks.length;
      if (panicSkipped) emit({ log: `🚨 Panic mode: ${panicSkipped} pick(s) geskipt (alleen PROVEN markten)` });
    }
    const seenMatches = new Map();
    const seenSports = new Map();
    const topPicks = [];
    const skippedReasons = { same_match: 0, same_sport_cap: 0 };
    for (const p of allPicks) {
      if (topPicks.length >= MAX_PICKS) break;
      const matchKey = (p.match || '').toLowerCase().trim();
      const sportKey = normalizeSport(p.sport || 'unknown');
      const sportCap = getSportCap(sportKey);
      if (matchKey && (seenMatches.get(matchKey) || 0) >= MAX_PER_MATCH) { skippedReasons.same_match++; continue; }
      if ((seenSports.get(sportKey) || 0) >= sportCap) { skippedReasons.same_sport_cap++; continue; }
      topPicks.push(p);
      if (matchKey) seenMatches.set(matchKey, (seenMatches.get(matchKey) || 0) + 1);
      seenSports.set(sportKey, (seenSports.get(sportKey) || 0) + 1);
    }
    const droppedCount = allPicks.length - topPicks.length;

    emit({ log: `🌐 Totaal: ${footballPicks.length} voetbal + ${nbaPicks.length} basketball + ${nhlPicks.length} hockey + ${mlbPicks.length} baseball + ${nflPicks.length} NFL + ${handballPicks.length} handball = ${beforeKill} kandidaten` });
    const provenSports = Object.entries(_sportCapCache.stats || {})
      .filter(([, s]) => s.cap === 3)
      .map(([k, s]) => `${k}(n=${s.n}, ROI ${s.roi > 0 ? '+' : ''}${s.roi}%)`);
    if (provenSports.length) emit({ log: `🏆 Bewezen sporten (cap=3): ${provenSports.join(', ')}` });
    if (skippedReasons.same_match) emit({ log: `🎯 ${skippedReasons.same_match} pick(s) geskipt: zelfde wedstrijd al in selectie (correlatie)` });
    if (skippedReasons.same_sport_cap) emit({ log: `🎯 ${skippedReasons.same_sport_cap} pick(s) geskipt: per-sport cap bereikt (default 2, bewezen sport 3)` });
    if (droppedCount > 0) emit({ log: `🎯 ${topPicks.length}/${MAX_PICKS} picks geselecteerd (${droppedCount} weggelaten door diversification + ranking)` });

    if (topPicks.length === 0) {
      emit({ log: `✋ Geen picks vandaag — ons systeem zag te weinig value. Dat is goed: niet elke dag is een edge-dag.` });
    } else if (topPicks.length <= 2) {
      emit({ log: `✋ ${topPicks.length} pick(s) — kwaliteit boven volume. Strenge filters hebben hun werk gedaan.` });
    }

    const topSet = new Set(topPicks);
    for (const p of allPicks) p.selected = topSet.has(p);

    // v10.9.7: combi-alternatieven. Combis (isCombi:true) die niet in top-5
    // singles landen worden hier apart opgepakt — user ziet de hoogste-EV
    // 2/3-bener als alternatief voor wie variance accepteert voor hoger EV.
    // Max 3 getoond. Elke combi heeft stake-cap 0.5U via makeCombi, dus zelfs
    // bij grote rally's aan legs wordt geen onverantwoord exposed.
    const topCombis = allPicks
      .filter(p => p.isCombi && !topSet.has(p))
      .sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0))
      .slice(0, 3);
    for (const p of topCombis) p.combiAlternative = true;

    saveScanEntry(allPicks, 'prematch', beforeKill);

    // v10.8.17/22: audit — flag picks waar de base-model (pre-signalen) ver
    // van markt afwijkt EN signalen dat niet wegduwen. Dat signaleert een
    // base-calc-driven claim die we extra willen controleren (bv. calcBTTSProb
    // met weinig H2H samples, of fpHome-derivering op dunne bookie-consensus).
    // v10.9.4: audit-inbox-notificatie verwijderd. De suspicious-flag werkt
    // nu DOOR in de stake (hk × 0.6) — geen aparte notificatie meer nodig.
    // Pick met damping = lagere stake + lagere score, user ziet het direct
    // zonder dat inbox-flag tegenstrijdig voelt met de 1.5U badge.

    // Telegram + push notificatie
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

    const toSafe = (p) => {
      const hk = p.kelly || 0;
      const score = kellyScore(hk);
      const pick = {
        match: p.match, league: p.league, label: p.label, odd: p.odd,
        prob: p.prob, units: p.units, edge: p.edge, score,
        kickoff: p.kickoff, scanType: p.scanType, bookie: p.bookie,
        sport: p.sport || 'football', audit: p.audit || null,
        isCombi: p.isCombi === true, legs: p.legs || null,
      };
      if (isAdmin) { pick.reason = p.reason; pick.kelly = p.kelly; pick.ep = p.ep; pick.strength = p.strength; pick.expectedEur = p.expectedEur; pick.signals = p.signals || []; }
      return pick;
    };
    const safePicks = topPicks.map(toSafe);
    // v10.9.7: combi-alternatieven meegeven zodat UI een apart paneel rendert.
    const safeCombis = topCombis.map(toSafe);
    return { safePicks, safeCombis, topPicks, topCombis, allPicks, beforeKill };
  } finally {
    setPreferredBookies(null);
  }
}

// v10.9.8: scan-triggering is single-operator. Niet-admin kan geen scan
// starten want dat vervuilt lastPrematchPicks + scan_history met globale
// user_id=null. Voor een private bankroll-tool moet alleen admin de
// canonieke scan-state voeden.
app.post('/api/prematch', requireAdmin, (req, res) => {
  if (!OPERATOR.master_scan_enabled) return res.status(503).json({ error: 'Scans uitgeschakeld via operator failsafe' });
  if (scanRunning) return res.status(429).json({ error: 'Scan al bezig · wacht tot de huidige scan klaar is' });
  scanRunning = true;
  const isAdmin = true;  // route is admin-only sinds v10.9.8
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  let stepCount = 0;
  const emit = (data) => {
    if (!isAdmin && data.log) {
      stepCount++;
      const pct = Math.min(95, Math.round(stepCount * 1.5));
      res.write(`data: ${JSON.stringify({ progress: pct })}\n\n`);
      return;
    }
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  (async () => {
    let prefs = null;
    try {
      const users = await loadUsers().catch(() => []);
      const me = users.find(u => u.id === req.user?.id) || users.find(u => u.role === 'admin');
      prefs = me?.settings?.preferredBookies || null;
    } catch (e) {
      console.warn('Scan: user prefs load failed, scan loopt zonder filter:', e.message);
    }
    const { safePicks, safeCombis } = await runFullScan({ emit, prefs, isAdmin, triggerLabel: 'manual' });
    emit({ done: true, picks: safePicks, combis: safeCombis || [] });
    res.end();
    scanRunning = false;
  })().catch(err => {
    const detail = (err && (err.message || err.toString())) || 'unknown';
    console.error('🔴 runFullScan crashed:', detail);
    if (err?.stack) console.error(err.stack);
    emit({ error: 'Scan mislukt', detail });
    res.end();
    scanRunning = false;
  });
});

// v10.9.8: live scan admin-only. Route streamde picks met `reason` veld (model-
// IP / rationale) naar elke ingelogde user. Voor private tool + model-IP
// bescherming: alleen admin.
// Live scan · SSE streaming
app.post('/api/live', requireAdmin, (req, res) => {
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
// ── fetchCurrentOdds ───────────────────────────────────────────────────────
// Haalt de slotlijn (of huidige odds) op voor EXACT de markt waar de bet in staat.
// Pure resolver (resolveOddFromBookie) zit in lib/clv-match.js zodat tests het
// zonder API kunnen draaien.
const { resolveOddFromBookie, marketKeyFromBetMarkt } = require('./lib/clv-match');

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

  return resolveOddFromBookie(bk, markt);
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
        // strictBookie:true → geen stille fallback naar Bet365 bij mismatch
        currentOdds = await fetchCurrentOdds(betSport, fxId, markt, bet.tip, { strictBookie: true });
      } catch (e) {
        console.warn(`Pre-kickoff odds fetch failed voor "${matchName}":`, e.message);
      }

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
      const usedBookie = bet.tip || 'onbekend';

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
    const userUe = await getUserUnitEur(userId);
    if (odds != null) updates.odds = parseFloat(odds);
    if (units != null) { updates.units = parseFloat(units); updates.inzet = +(parseFloat(units) * userUe).toFixed(2); }
    if (tip) updates.tip = tip;
    if (sport) updates.sport = sport;
    // Score override (voor corrigeren van picks die met buggy edge-calc zijn gelogd)
    if (req.body.score === null || typeof req.body.score === 'number') {
      updates.score = req.body.score;
    }
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
        const newInzet = row.inzet != null ? row.inzet : +((row.units || 0) * userUe).toFixed(2);
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
    const recalcUe = await getUserUnitEur(userId);
    for (const bet of (settledBets || [])) {
      const inzet = bet.inzet || +(bet.units * recalcUe).toFixed(2);
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
            try { await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', id); }
            catch (e) { console.error(`Backfill: fixture_id update failed voor bet ${id}:`, e.message); }
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

// POST /api/clv/recompute  — FORCE hercomputeer CLV voor alle (settled) bets.
// Nodig na fix in fetchCurrentOdds: bestaande clv_pct kunnen verkeerd zijn door
// slechte market-matching (bv. O/U die Corners of Alt-lijn matchte, ML die DNB
// greep, etc.). Endpoint negeert bestaande clv_pct, en overschrijft alleen als
// het echte verschil ≥ 0.5%-punt is (kleinere wijzigingen zijn meet-ruis).
// Body: { all?: boolean, dryRun?: boolean, minDeltaPct?: number }
app.post('/api/clv/recompute', requireAdmin, async (req, res) => {
  try {
    const all = req.body?.all === true;
    const dryRun = req.body?.dryRun === true;
    const rawBetId = parseInt(req.body?.betId);
    const targetBetId = Number.isFinite(rawBetId) && rawBetId > 0 ? rawBetId : null;
    // v10.7.22: validate minDeltaPct against NaN/Infinity. Zonder isFinite zou
    // minDeltaPct=Infinity alle bets skippen (stille no-op) of NaN → bij delta<NaN
    // altijd false → alle bets processed (resource exhaustion).
    const rawDelta = req.body?.minDeltaPct;
    const minDelta = (typeof rawDelta === 'number' && isFinite(rawDelta) && rawDelta >= 0 && rawDelta <= 100)
      ? Math.abs(rawDelta)
      : 0.5;
    const QUERY_CEILING = 10000;
    const userId = (!all && req.user?.id) ? req.user.id : null;

    // Alle settled bets (W/L) — die hebben closing odds en zijn beoordeelbaar.
    // Cap op 10k om DoS te voorkomen (elke bet doet ~1 api-sports call = 150ms).
    let q = supabase.from('bets').select('*').in('uitkomst', ['W', 'L']).limit(QUERY_CEILING);
    if (userId) q = q.eq('user_id', userId);
    if (targetBetId != null) q = q.eq('bet_id', targetBetId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const details = [];
    let updated = 0, skipped = 0, failed = 0;
    for (const r of (data || [])) {
      if (!matchesClvRecomputeTarget(r, { betId: targetBetId })) continue;
      const id = r.bet_id;
      const wedstrijd = r.wedstrijd || '';
      const sport = r.sport || 'football';
      const markt = r.markt || '';
      const loggedOdds = parseFloat(r.odds);
      const oldClv = (typeof r.clv_pct === 'number') ? r.clv_pct : null;
      try {
        let fxId = r.fixture_id;
        if (!fxId) {
          let anchorDate = null;
          const dm = (r.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (dm) anchorDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
          const verbose = await findGameIdVerbose(sport, wedstrijd, anchorDate, [-3, -2, -1, 0, 1]);
          fxId = verbose.fxId;
          if (fxId && !dryRun) {
            try { await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', id); }
            catch (e) { console.error(`Recompute: fixture_id update failed voor bet ${id}:`, e.message); }
          }
        }
        if (!fxId) { failed++; details.push({ id, wedstrijd, reason: 'fixture niet gevonden' }); await new Promise(rs => setTimeout(rs, 150)); continue; }
        const closingOdds = await fetchCurrentOdds(sport, fxId, markt, r.tip, { strictBookie: true });
        if (!closingOdds || !loggedOdds) {
          failed++;
          details.push({ id, wedstrijd, sport, fxId, bookie: r.tip, reason: `closing odds niet beschikbaar voor "${r.tip}"` });
          await new Promise(rs => setTimeout(rs, 150));
          continue;
        }
        const newClv = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
        const delta = oldClv === null ? Infinity : Math.abs(newClv - oldClv);
        if (delta < minDelta) {
          skipped++;
          details.push({ id, wedstrijd, oldClv, newClv, delta: +delta.toFixed(2), action: 'skip-small-delta' });
          await new Promise(rs => setTimeout(rs, 150));
          continue;
        }
        // v10.10.21: sharp CLV — Pinnacle closing line uit odds_snapshots.
        // Aparte meting van execution-CLV: positieve sharp-CLV = betere prijs
        // dan Pinnacle's sluitkoers = bewijs van model-edge (industrie-standaard).
        let sharpClvOdds = null;
        let sharpClvPct = null;
        if (fxId) {
          const mapped = marketKeyFromBetMarkt(markt);
          if (mapped) {
            try {
              let snapQuery = supabase.from('odds_snapshots')
                .select('odds')
                .eq('fixture_id', fxId)
                .eq('market_type', mapped.market_type)
                .eq('selection_key', mapped.selection_key)
                .ilike('bookmaker', '%pinnacle%')
                .order('captured_at', { ascending: false })
                .limit(1);
              // v10.10.21 fix: line-based markten exact matchen op gespeelde line
              if (mapped.line != null && Number.isFinite(mapped.line)) {
                snapQuery = snapQuery.eq('line', +mapped.line.toFixed(2));
              }
              const { data: snapRows } = await snapQuery;
              if (snapRows?.[0]?.odds) {
                sharpClvOdds = parseFloat(snapRows[0].odds);
                if (Number.isFinite(sharpClvOdds) && sharpClvOdds > 1 && loggedOdds > 0) {
                  sharpClvPct = +((loggedOdds - sharpClvOdds) / sharpClvOdds * 100).toFixed(2);
                }
              }
            } catch (e) {
              // Graceful: sharp CLV is nice-to-have, execution CLV is canonical.
            }
          }
        }
        const updatePayload = { clv_odds: closingOdds, clv_pct: newClv };
        if (sharpClvOdds !== null) updatePayload.sharp_clv_odds = sharpClvOdds;
        if (sharpClvPct !== null) updatePayload.sharp_clv_pct = sharpClvPct;
        if (!dryRun) {
          await supabase.from('bets').update(updatePayload).eq('bet_id', id);
        }
        updated++;
        details.push({ id, wedstrijd, markt, bookie: r.tip, oldClv, newClv, sharpClvPct, delta: oldClv === null ? null : +delta.toFixed(2), action: dryRun ? 'would-update' : 'updated' });
      } catch (e) {
        failed++;
        details.push({ id, wedstrijd, reason: (e && e.message) || 'error' });
      }
      await new Promise(rs => setTimeout(rs, 150));
    }

    // Na recompute: CLV-driven tuning opnieuw draaien op de nieuwe clv_pct.
    // Kill-switch, signal-weights en Kelly-stepup baseren zich op clv_pct.
    // Als die waarden incorrect waren, waren de tuning-beslissingen dat ook.
    const tuning = { killSwitch: null, signalTune: null, kellyStepup: null };
    if (!dryRun && updated > 0) {
      try { await refreshKillSwitch(); tuning.killSwitch = { ok: true, activeKilled: KILL_SWITCH.set.size }; }
      catch (e) { tuning.killSwitch = { ok: false, error: e.message }; }
      try { tuning.signalTune = await autoTuneSignalsByClv(); }
      catch (e) { tuning.signalTune = { ok: false, error: e.message }; }
      try { tuning.kellyStepup = await evaluateKellyAutoStepup(); }
      catch (e) { tuning.kellyStepup = { ok: false, error: e.message }; }
    }

    res.json({ scanned: (data || []).length, updated, skipped, failed, dryRun, minDelta, betId: targetBetId, details, tuning,
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
      // v10.7.24: include date/status/league zodat debug direct toont of
      // het de juiste fixture is (avond vs afgelopen nacht etc.).
      const gDate = g.fixture?.date || g.date || null;
      const nlDateTime = gDate ? new Date(gDate).toLocaleString('nl-NL', {
        weekday:'short', day:'2-digit', month:'short', year:'numeric',
        hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam'
      }) : null;
      out.push({
        id, home: g.teams?.home?.name, away: g.teams?.away?.name,
        dateUTC: gDate, dateNL: nlDateTime,
        status: g.fixture?.status?.short || g.status?.short || null,
        league: g.league?.name || null,
        bookmakers,
      });
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
    const money = await getUserMoneySettings(userId);
    const { bets, stats } = await readBets(userId, money);
    const settled = bets.filter(b => b.uitkomst === 'W' || b.uitkomst === 'L');
    const W = settled.filter(b => b.uitkomst === 'W').length;
    const L = settled.filter(b => b.uitkomst === 'L').length;
    const P = 0; // push/void
    const profitU = +(settled.reduce((s, b) => s + (b.wl || 0), 0) / money.unitEur).toFixed(1);
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
const PUBLIC_PICK_FIELDS = ['match', 'league', 'label', 'odd', 'units', 'prob', 'edge', 'score', 'kickoff', 'bookie', 'sport', 'selected', 'audit'];
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
  // v10.8.12: expliciet no-store zodat browser/CDN nooit een stale response
  // cached — auto-refresh zou anders oude picks blijven zien.
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  const isAdmin = req.user?.role === 'admin';
  try {
    let query = supabase.from('scan_history').select('*')
      .order('ts', { ascending: false }).limit(SCAN_HISTORY_MAX);
    if (!isAdmin && req.user?.id) {
      if (isValidUuid(req.user.id)) query = query.or(`user_id.eq.${req.user.id},user_id.is.null`);
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
    } catch (e) {
      console.warn('Scan history load failed:', e.message);
    }

    // v10.8.15: filter op user's preferredBookies. Voorheen kreeg je soms een
    // analyse terug van een pick met bookie die je niet eens hebt geselecteerd
    // (bv. William Hill terwijl je alleen Bet365/Unibet hebt). Dat gebeurt als
    // de pick oorspronkelijk onder admin-prefs is gescand maar user heeft
    // inmiddels andere bookies. We filteren hier; bij 0 matches tonen we een
    // waarschuwing plus de niet-gefilterde resultaten zodat user weet dat er
    // wel een pick bestond maar buiten zijn bookie-set.
    let userBookiesLc = null;
    try {
      const users = await loadUsers().catch(() => []);
      const me = users.find(u => u.id === req.user?.id);
      const list = me?.settings?.preferredBookies;
      if (Array.isArray(list) && list.length) {
        userBookiesLc = list.map(b => (b || '').toString().toLowerCase()).filter(Boolean);
      }
    } catch {}

    const rawMatches = allPicks.filter(p => {
      const matchStr = (p.match || '').toLowerCase();
      return searchTerms.some(t => matchStr.includes(t));
    });
    const inPrefs = (p) => !userBookiesLc
      || userBookiesLc.some(b => (p.bookie || '').toLowerCase().includes(b));
    const matchesPref = rawMatches.filter(inPrefs);
    const matchesNonPref = rawMatches.filter(p => !inPrefs(p));
    const matches = matchesPref.length ? matchesPref : [];
    const nonPrefWarning = (!matchesPref.length && matchesNonPref.length)
      ? {
          warning: `Pick gevonden, maar niet bij jouw bookies (${(userBookiesLc || []).join(', ')}). Beschikbaar bij: ${Array.from(new Set(matchesNonPref.map(p => p.bookie).filter(Boolean))).join(', ') || 'onbekend'}.`,
          matches: matchesNonPref,
        }
      : null;

    if (!matches.length) {
      // v10.8.15: als pick wel bestaat bij een bookie buiten user's prefs,
      // geef dat expliciet terug ipv "Geen analyse" + fixture-zoektocht. Dan
      // weet user: pick bestaat maar niet op zijn bookies.
      if (nonPrefWarning) {
        const projected = nonPrefWarning.matches.slice(0, 5).map(p => {
          const score = p.score || (p.kelly ? Math.min(10, Math.max(5, Math.round((p.kelly - 0.015) / 0.135 * 5) + 5)) : null);
          return {
            match: p.match, league: p.league, label: p.label, odd: p.odd,
            prob: p.prob, units: p.units, edge: p.edge, score,
            kickoff: p.kickoff, bookie: p.bookie, sport: p.sport || 'football',
            warning: nonPrefWarning.warning,
          };
        });
        if (projected.length === 1) return res.json(projected[0]);
        return res.json({ multi: true, results: projected, warning: nonPrefWarning.warning });
      }
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
    } catch (e) {
      console.warn('Analyze: live-status check failed:', e.message);
    }

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
// Supabase DB usage — via eigen service_role key, toont DB-grootte + row counts
// voor de belangrijkste tabellen zodat je ziet hoe dicht bij de 500MB free-tier je zit.
app.get('/api/admin/supabase-usage', requireAdmin, async (req, res) => {
  try {
    const FREE_TIER_BYTES = 500 * 1024 * 1024; // 500 MB
    // DB size via pg_database_size
    let dbBytes = null;
    try {
      const { data } = await supabase.rpc('pg_database_size_bytes');
      if (typeof data === 'number') dbBytes = data;
    } catch (e) {
      console.warn('supabase-usage: pg_database_size_bytes RPC failed, using row-count fallback:', e.message);
    }
    // Fallback: schat op basis van optelling van belangrijke tabellen (row counts × gemiddelde)
    const tables = [
      'bets', 'fixtures', 'odds_snapshots', 'feature_snapshots',
      'market_consensus', 'pick_candidates', 'model_runs', 'signal_stats',
      'training_examples', 'raw_api_events', 'execution_logs',
      'notifications', 'users', 'push_subscriptions', 'scan_history', 'calibration', 'signal_weights'
    ];
    const counts = {};
    for (const t of tables) {
      try {
        const { count, error } = await supabase.from(t).select('*', { count: 'exact', head: true });
        counts[t] = error ? null : (count || 0);
      } catch { counts[t] = null; }
    }
    res.json({
      dbBytes,
      freeTierBytes: FREE_TIER_BYTES,
      usedPct: dbBytes ? Math.round(dbBytes / FREE_TIER_BYTES * 100) : null,
      dbMB: dbBytes ? +(dbBytes / 1024 / 1024).toFixed(1) : null,
      freeMB: 500,
      rowCounts: counts,
      dashboardUrl: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\.supabase\.co.*$/, '.supabase.co') + '/dashboard' : null,
      note: dbBytes === null ? 'pg_database_size_bytes RPC niet beschikbaar — toont alleen row counts. Voor exacte DB-grootte: Supabase dashboard → Settings → Usage.' : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
      espn: { status: 'active', plan: 'Free', unlimited: true, note: 'Live scores auto-refresh' },
      supabase: { status: 'active', plan: 'Free', unlimited: true, note: 'PostgreSQL · 500MB · bets/users/calibratie/snapshots' },
      telegram: { status: (TOKEN || process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || process.env.TG_TOKEN) ? 'active' : 'no token', plan: 'Free', unlimited: true, note: 'Picks, alerts, model updates' },
      webPush: { status: (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) ? 'active' : 'no key', plan: 'Free', unlimited: true, note: 'PWA browser push (VAPID)' },
      render: { status: 'active', plan: 'Free', unlimited: true, note: 'Hosting + keep-alive elke 14 min' },
      mlbStats: { status: 'active', plan: 'Free', unlimited: true, note: 'MLB pitcher stats (api.mlb.com/api/v1)' },
      nhlPublic: { status: 'active', plan: 'Free', unlimited: true, note: 'NHL shots-differential + lineups' },
      openMeteo: { status: 'active', plan: 'Free', unlimited: true, note: 'Weer voor outdoor wedstrijden (open-meteo.com)' },
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
// Shared multiplier-formule voor rebuild én incremental updateCalibration.
// Voorheen divergeerden beide; rebuild gebruikte hardcoded 0.70/1.10 ipv
// huidige multiplier als prior. Resultaat: na rebuild verloor je alle
// eerder opgebouwde tuning. Nu één bron van waarheid.
function computeMarketMultiplier(stats, currentMultiplier = 1.0) {
  if (!stats || stats.n < 8) return currentMultiplier;
  const wr = stats.w / stats.n;
  const profitPerBet = stats.profit / stats.n;
  if (profitPerBet < -3 && wr < 0.40) return Math.max(0.55, currentMultiplier - 0.05);
  if (profitPerBet >  3 && wr > 0.55) return Math.min(1.30, currentMultiplier + 0.03);
  return +Math.max(0.70, Math.min(1.20, 0.70 + wr * 1.0)).toFixed(3);
}

// v10.8.0: mutex om gelijktijdige rebuild/recompute te voorkomen.
// Race scenario: scan leest _calibCache tijdens rebuild schrijft → inconsistent.
let _calibRebuildInProgress = false;

// POST /api/admin/rebuild-calib — rebuild c.markets vanaf 0 o.b.v. alle settled
// bets. Nodig na v10.7.20 detectMarket split: bestaande historische bets zitten
// onder `football_other`, maar moeten nu verdeeld zijn over btts/dnb/dc/spread/
// nrfi/team_total etc. Telt ook hockey/baseball op die eerder stil bleven
// omdat ze in `_other` verdronken.
// v10.7.22: preserve oude multiplier als prior (geen reset naar 1.0), rebuild
// ook `leagues`, cap query op 10k bets (DoS-guard), .limit() om eindeloze
// iteratie te voorkomen.
// Body: { dryRun?: boolean, resetMultipliers?: boolean }
app.post('/api/admin/rebuild-calib', requireAdmin, async (req, res) => {
  if (_calibRebuildInProgress) return res.status(409).json({ error: 'Rebuild al lopende, probeer over 30s opnieuw' });
  _calibRebuildInProgress = true;
  try {
    const dryRun = req.body?.dryRun === true;
    const resetMultipliers = req.body?.resetMultipliers === true;
    const QUERY_CEILING = 10000;

    // Alle admin settled bets (model trainen alleen op admin data).
    const users = _usersCache || [];
    const adminIds = users.filter(u => u.role === 'admin').map(u => u.id);
    let q = supabase.from('bets').select('*').in('uitkomst', ['W', 'L']).limit(QUERY_CEILING);
    if (adminIds.length) q = q.in('user_id', adminIds);
    const { data: bets, error } = await q;
    if (error) return res.status(500).json({ error: error.message });

    const oldC = loadCalib();
    const oldMarkets = oldC.markets || {};

    // Nieuwe markets-map opbouwen — behoud oude multiplier als prior zodat
    // eerder opgebouwde tuning niet verloren gaat.
    const newMarkets = {};
    const newLeagues = {};
    let totalSettled = 0, totalWins = 0, totalProfit = 0;
    for (const b of (bets || [])) {
      if (!['W','L'].includes(b.uitkomst)) continue;
      const key = `${normalizeSport(b.sport)}_${detectMarket(b.markt || '')}`;
      const won = b.uitkomst === 'W';
      const pnl = parseFloat(b.wl) || 0;
      if (!newMarkets[key]) {
        const priorMult = (!resetMultipliers && oldMarkets[key]?.multiplier) || 1.0;
        newMarkets[key] = { n: 0, w: 0, profit: 0, multiplier: priorMult };
      }
      const mk = newMarkets[key];
      mk.n++; if (won) mk.w++; mk.profit += pnl;
      totalSettled++; if (won) totalWins++; totalProfit += pnl;

      // Rebuild leagues aggregate
      const lg = b.league || 'Unknown';
      if (!newLeagues[lg]) newLeagues[lg] = { n: 0, w: 0, profit: 0 };
      newLeagues[lg].n++; if (won) newLeagues[lg].w++; newLeagues[lg].profit += pnl;
    }

    // Multiplier opnieuw afleiden met shared formule + prior.
    for (const mk of Object.values(newMarkets)) {
      const prior = mk.multiplier; // prior = oude multiplier (of 1.0 bij reset)
      mk.multiplier = computeMarketMultiplier(mk, prior);
    }

    // Per-sport aggregate vanuit de nieuwe markets (voor UI)
    const perSportMap = {};
    for (const [k, mk] of Object.entries(newMarkets)) {
      const sp = k.split('_')[0] || 'football';
      if (!perSportMap[sp]) perSportMap[sp] = { n: 0, w: 0, profit: 0 };
      perSportMap[sp].n += mk.n; perSportMap[sp].w += mk.w; perSportMap[sp].profit += mk.profit;
    }

    const before = Object.fromEntries(Object.entries(oldMarkets).map(([k, v]) => [k, v.n]));
    const after = Object.fromEntries(Object.entries(newMarkets).map(([k, v]) => [k, v.n]));
    const diff = {};
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) diff[k] = { before: before[k] || 0, after: after[k] || 0 };

    if (!dryRun) {
      const next = { ...oldC, markets: newMarkets, leagues: newLeagues,
                     totalSettled, totalWins, totalProfit,
                     modelLastUpdated: new Date().toISOString() };
      await saveCalib(next);
      // Refresh market sample cache zodat scan meteen met nieuwe counts werkt
      refreshMarketSampleCounts().catch(e => console.error('refreshMarketSampleCounts na rebuild:', e.message));
    }
    res.json({ ok: true, dryRun, resetMultipliers, totalSettled, totalWins, totalProfit,
      perSport: perSportMap, marketDiff: diff, newMarketKeys: Object.keys(newMarkets).sort(),
      leaguesCount: Object.keys(newLeagues).length,
      capped: (bets?.length || 0) >= QUERY_CEILING });
  } catch (e) {
    console.error('rebuild-calib error:', e);
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  } finally {
    _calibRebuildInProgress = false;
  }
});

// GET /api/changelog — Parse CHANGELOG.md → JSON. Admin-only voor nu (user-
// facing versie kan later onder eigen endpoint met gefilterde entries).
app.get('/api/changelog', requireAdmin, (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'CHANGELOG.md'), 'utf8');
    const entries = [];
    // Split op "## [x.y.z] - date" secties
    const blocks = raw.split(/\n(?=## \[)/);
    for (const block of blocks) {
      const hdr = block.match(/^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
      if (!hdr) continue;
      const version = hdr[1], date = hdr[2];
      // Binnen het block: ### Section headers
      const body = block.slice(hdr[0].length).trim();
      const sections = [];
      const parts = body.split(/\n(?=### )/);
      for (const p of parts) {
        const sh = p.match(/^### ([^\n]+)/);
        if (!sh) continue;
        const title = sh[1].trim();
        const text = p.slice(sh[0].length).trim();
        sections.push({ title, text });
      }
      entries.push({ version, date, sections });
    }
    res.json({ version: APP_VERSION, entries });
  } catch (e) {
    res.status(500).json({ error: (e && e.message) || 'Kan CHANGELOG niet lezen' });
  }
});

// POST /api/admin/backfill-signals — retroactief signals vullen voor bets
// die ze missen. Match via fixture_id (of findGameId fallback) naar
// pick_candidates tabel, neem signals van best-matching candidate.
// v10.8.8: mutex om concurrent backfill calls te voorkomen
let _backfillSignalsInProgress = false;
app.post('/api/admin/backfill-signals', requireAdmin, async (req, res) => {
  if (_backfillSignalsInProgress) return res.status(409).json({ error: 'Backfill al lopende, probeer over een minuut opnieuw' });
  _backfillSignalsInProgress = true;
  try {
    const dryRun = req.body?.dryRun === true;
    // v10.8.0: DoS-cap — max 500 per call. User kan in batches draaien.
    const MAX_CANDIDATES = Math.min(parseInt(req.body?.max || 500), 1000);
    const { data: bets, error: betsErr } = await supabase.from('bets')
      .select('*').limit(5000);
    if (betsErr) return res.status(500).json({ error: betsErr.message });

    // Filter bets zonder signals (of leeg)
    const candidates = (bets || []).filter(b => {
      if (b.signals == null) return true;
      if (typeof b.signals === 'string') return b.signals === '' || b.signals === '[]';
      if (Array.isArray(b.signals)) return b.signals.length === 0;
      return false;
    }).slice(0, MAX_CANDIDATES);

    const results = { scanned: candidates.length, matched: 0, updated: 0, failed: 0, details: [], capped: candidates.length === MAX_CANDIDATES };

    for (const b of candidates) {
      try {
        let fxId = b.fixture_id;
        if (!fxId) {
          // Probeer findGameId met naamlookup
          const sport = b.sport || 'football';
          try {
            fxId = await findGameId(sport, b.wedstrijd);
            if (fxId && !dryRun) {
              await supabase.from('bets').update({ fixture_id: fxId }).eq('bet_id', b.bet_id);
            }
          } catch {}
        }
        if (!fxId) { results.failed++; results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, reason: 'fixture niet gevonden' }); continue; }

        // Zoek pick_candidates met zelfde fixture + approx odds
        const { data: cands } = await supabase.from('pick_candidates')
          .select('signals, bookmaker, bookmaker_odds, selection_key')
          .eq('fixture_id', fxId);
        if (!cands || !cands.length) { results.failed++; results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, reason: 'geen pick_candidates' }); continue; }

        const betOdds = parseFloat(b.odds) || 0;
        const betBookie = (b.tip || '').toLowerCase();
        // Score matches: zelfde bookie + odds binnen 3%
        const match = cands.find(c => {
          const oddsDiff = Math.abs(parseFloat(c.bookmaker_odds || 0) - betOdds) / Math.max(betOdds, 0.01);
          return oddsDiff < 0.03 && (c.bookmaker || '').toLowerCase().includes(betBookie);
        }) || cands.find(c => {
          const oddsDiff = Math.abs(parseFloat(c.bookmaker_odds || 0) - betOdds) / Math.max(betOdds, 0.01);
          return oddsDiff < 0.05;
        });

        if (!match || !Array.isArray(match.signals) || !match.signals.length) {
          results.failed++;
          results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, reason: 'geen matchende candidate met signals' });
          continue;
        }
        results.matched++;
        if (!dryRun) {
          await supabase.from('bets').update({ signals: match.signals }).eq('bet_id', b.bet_id);
          results.updated++;
        }
        results.details.push({ id: b.bet_id, wedstrijd: b.wedstrijd, signalsCount: match.signals.length, action: dryRun ? 'would-update' : 'updated' });
      } catch (e) {
        results.failed++;
        results.details.push({ id: b.bet_id, reason: (e && e.message) || String(e) || 'unknown' });
      }
      await new Promise(rs => setTimeout(rs, 100)); // rate-limit
    }

    res.json({ ok: true, dryRun, ...results });
  } catch (e) {
    console.error('backfill-signals error:', e);
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  } finally {
    _backfillSignalsInProgress = false;
  }
});

// GET /api/admin/signal-performance — per-signal stats voor dashboard (D)
// Returnt: name, n (bets), avgCLV, posCLV%, currentWeight, status
// (active/muted/logging/auto_promotable).
app.get('/api/admin/signal-performance', requireAdmin, async (req, res) => {
  try {
    const { data: bets, error } = await supabase.from('bets')
      .select('signals, clv_pct, sport, markt').not('clv_pct', 'is', null)
      .limit(10000);
    if (error) return res.status(500).json({ error: error.message });

    const weights = loadSignalWeights();
    const signalStats = summarizeSignalMetrics((bets || []).map(b => ({
      marketKey: `${normalizeSport(b.sport || 'football')}_${detectMarket(b.markt || 'other')}`,
      clvPct: b.clv_pct,
      signalNames: parseBetSignals(b.signals).map(s => String(s || '').split(':')[0]).filter(Boolean),
    }))).signals;

    const rows = Object.entries(signalStats).map(([name, s]) => {
      const avgClv = +(s.avgClv).toFixed(2);
      const edgeClv = +(s.shrunkExcessClv).toFixed(2);
      const posPct = +(s.posClvRate * 100).toFixed(1);
      const weight = weights[name] !== undefined ? weights[name] : 0;
      let status = 'logging';
      if (weight === 0 && s.n >= 50 && edgeClv >= 0.75 && avgClv > 0) status = 'auto_promotable';
      else if (weight === 0 && s.n >= 20 && edgeClv > 0) status = 'logging_positive';
      else if (weight === 0) status = 'logging';
      else if (weight > 0) status = 'active';
      if (s.n >= 50 && edgeClv <= -1.5 && avgClv <= -0.5) status = 'mute_candidate';
      return {
        name, n: s.n, avgClv, edgeClv, posCLV_pct: posPct,
        weight: +(weight.toFixed ? weight.toFixed(3) : weight), status
      };
    }).sort((a, b) => b.n - a.n);

    res.json({
      signals: rows,
      thresholds: {
        SIGNAL_PROMOTE_MIN_N: 50,
        SIGNAL_KILL_MIN_N: 50,
        SIGNAL_KILL_CLV_PCT: -3.0,
        SIGNAL_PROMOTE_WEIGHT: 0.5,
      },
      totalSignals: rows.length,
      totalBetsAnalyzed: (bets || []).length,
    });
  } catch (e) {
    console.error('signal-performance error:', e);
    res.status(500).json({ error: (e && e.message) || 'Interne fout' });
  }
});

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
    if (!isValidUuid(req.user?.id)) {
      return res.status(401).json({ error: 'Invalid user context' });
    }
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

// v10.9.8: mark-as-read werkte ook op global rows (user_id=null) vanuit
// iedere user → iemand kon "Overweeg API-upgrade" weg-marken voor iedereen.
// Nu: global rows alleen door admin muteerbaar; users markeren alleen hun eigen.
app.put('/api/inbox-notifications/read', async (req, res) => {
  try {
    if (!isValidUuid(req.user?.id)) return res.status(401).json({ error: 'Invalid user context' });
    const isAdmin = req.user?.role === 'admin';
    const scope = isAdmin
      ? `user_id.eq.${req.user.id},user_id.is.null`
      : `user_id.eq.${req.user.id}`;
    await supabase.from('notifications').update({ read: true })
      .eq('read', false).or(scope);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Interne fout' }); }
});

// v10.9.8: delete-all global rows alleen door admin — voorheen kon elke user
// global notifications verwijderen voor iedereen.
app.delete('/api/inbox-notifications', async (req, res) => {
  try {
    if (!isValidUuid(req.user?.id)) return res.status(401).json({ error: 'Invalid user context' });
    const isAdmin = req.user?.role === 'admin';
    const scope = isAdmin
      ? `user_id.eq.${req.user.id},user_id.is.null`
      : `user_id.eq.${req.user.id}`;
    await supabase.from('notifications').delete().or(scope);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Interne fout' }); }
});

app.get('/api/notifications', async (req, res) => {
  try {
    const alerts = [];
    const c = loadCalib();

    // v10.9.8: single-operator. Bankroll/ROI-adviezen altijd op admin's bets,
    // niet globale aggregatie. Voorheen: readBets() zonder userId → global mix.
    const adminUserId = await getAdminUserId();
    const money = await getUserMoneySettings(adminUserId);
    const { stats } = await readBets(adminUserId, money).catch(() => ({ stats: {} }));
    const roi = stats.roi ?? 0;
    const bankroll = stats.bankroll ?? money.startBankroll;
    const bankrollGrowth = bankroll - money.startBankroll;

    // Unit size aanbeveling op basis van bankroll groei
    if (bankrollGrowth >= money.startBankroll) {
      alerts.push({ type: 'success', icon: '💰', msg: `Bankroll +100% (€${bankroll.toFixed(0)}) · unit verhoging aanbevolen: €${money.unitEur} → €${money.unitEur*2}`, unitAdvice: true });
    } else if (bankrollGrowth >= money.startBankroll * 0.5) {
      alerts.push({ type: 'info', icon: '💰', msg: `Bankroll +50% (€${bankroll.toFixed(0)}) · overweeg unit van €${money.unitEur} naar €${Math.round(money.unitEur*1.5)}`, unitAdvice: true });
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
      const hasMult = typeof entry.oldMult === 'number' && typeof entry.newMult === 'number';
      const dir = hasMult ? (entry.newMult > entry.oldMult ? '📈' : '📉') : '🧠';
      const msg = hasMult
        ? `Model update: ${entry.note} (${entry.oldMult.toFixed(2)}→${entry.newMult.toFixed(2)})`
        : `Model update: ${entry.note || entry.type || 'update'}`;
      alerts.push({
        type:        'model',
        icon:        dir,
        msg,
        date:        entry.date,
        modelUpdate: true,
      });
    }

    // TODO: remove after 2026-04-26 — one-shot Bet365-limit reminder
    // Vuurt tussen 19-26 apr 2026 als Bet365 nog uit staat in preferredBookies.
    try {
      const now = new Date();
      const start = new Date('2026-04-19T00:00:00+02:00');
      const expire = new Date('2026-04-26T00:00:00+02:00');
      if (now >= start && now < expire) {
        const users = await loadUsers();
        const user = users.find(u => u.id === req.user?.id);
        const prefs = user?.settings?.preferredBookies;
        const hasBet365 = Array.isArray(prefs) && prefs.some(b => (b || '').toLowerCase().includes('bet365'));
        if (!hasBet365) {
          alerts.push({
            type: 'info',
            icon: '🔓',
            msg: 'Bet365-limiet is afgelopen (19 apr). Zet Bet365 weer aan in Settings → preferred bookies.',
          });
        }
      }
    } catch {}

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
  const FOOTBALL_LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);
  const footballFinished = [...(todayFixtures || []), ...(yesterdayFixtures || [])]
    .filter(f => FINISHED_STATUSES.has(f.fixture?.status?.short))
    .map(f => ({
      home:   f.teams?.home?.name || '',
      away:   f.teams?.away?.name || '',
      scoreH: f.goals?.home ?? 0,
      scoreA: f.goals?.away ?? 0,
      sport:  'football',
    }));
  const footballCurrent = [...(todayFixtures || []), ...(yesterdayFixtures || [])]
    .filter(f => FOOTBALL_LIVE_STATUSES.has(f.fixture?.status?.short))
    .map(f => ({
      home:   f.teams?.home?.name || '',
      away:   f.teams?.away?.name || '',
      scoreH: f.goals?.home ?? 0,
      scoreA: f.goals?.away ?? 0,
      sport:  'football',
      live:   true,
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
  const bbCurrent = [...(bbToday || []), ...(bbYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return isV1LiveStatus(status);
  }).map(g => ({
    home: g.teams?.home?.name || '',
    away: g.teams?.away?.name || '',
    scoreH: g.scores?.home?.total ?? 0,
    scoreA: g.scores?.away?.total ?? 0,
    sport: 'basketball',
    live: true,
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
  const hkCurrent = [...(hkToday || []), ...(hkYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return isV1LiveStatus(status);
  }).map(g => ({
    home: g.teams?.home?.name || '',
    away: g.teams?.away?.name || '',
    scoreH: g.scores?.home ?? 0,
    scoreA: g.scores?.away ?? 0,
    sport: 'hockey',
    live: true,
  }));

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
  const baseballCurrent = [...(baToday || []), ...(baYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return isV1LiveStatus(status);
  }).map(g => ({
    home: g.teams?.home?.name || '',
    away: g.teams?.away?.name || '',
    scoreH: g.scores?.home?.total ?? 0,
    scoreA: g.scores?.away?.total ?? 0,
    inn1H: g.scores?.home?.innings?.['1'] ?? g.scores?.home?.inning_1 ?? null,
    inn1A: g.scores?.away?.innings?.['1'] ?? g.scores?.away?.inning_1 ?? null,
    sport: 'baseball',
    live: true,
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
  const nflCurrent = [...(nflToday || []), ...(nflYesterday || [])].filter(g => {
    const status = (g.game?.status?.short || '').toUpperCase();
    return isV1LiveStatus(status);
  }).map(g => ({
    home: g.teams?.home?.name || '',
    away: g.teams?.away?.name || '',
    scoreH: g.scores?.home?.total ?? 0,
    scoreA: g.scores?.away?.total ?? 0,
    sport: 'american-football',
    live: true,
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
  const handballCurrent = [...(hbToday || []), ...(hbYesterday || [])].filter(g => {
    const status = (g.status?.short || '').toUpperCase();
    return isV1LiveStatus(status);
  }).map(g => ({
    home: g.teams?.home?.name || '',
    away: g.teams?.away?.name || '',
    scoreH: g.scores?.home ?? 0,
    scoreA: g.scores?.away ?? 0,
    sport: 'handball',
    live: true,
  }));

  const allCurrent = [...footballCurrent, ...bbCurrent, ...hkCurrent, ...baseballCurrent, ...nflCurrent, ...handballCurrent];
  const matchEventForBet = (events, hmQ, awQ) => events.find(e => {
    const h = e.home.toLowerCase(), a = e.away.toLowerCase();
    return (h.includes(hmQ) || hmQ.includes(h.split(' ').pop())) &&
           (a.includes(awQ) || awQ.includes(a.split(' ').pop()));
  });

  const results = [];
  for (const bet of openBets) {
    const parts = (bet.wedstrijd||'').split(' vs ').map(s => s.trim().toLowerCase());
    if (parts.length < 2) continue;
    const [hmQ, awQ] = parts;
    const finishedEv = matchEventForBet(allFinished, hmQ, awQ);
    const liveEv = finishedEv ? null : matchEventForBet(allCurrent, hmQ, awQ);
    const ev = finishedEv || liveEv;
    if (!ev) continue;

    const markt = (bet.markt||'').toLowerCase();
    const total = ev.scoreH + ev.scoreA;
    let uitkomst = null;

    if (liveEv) {
      uitkomst = resolveEarlyLiveOutcome(markt, ev);
    }

    // ── 3-weg 60-min markten (hockey/handbal regulation) ──
    // Gebruikt regScoreH/regScoreA (na 60 min, excl OT/SO). Bij AOT/AP was reg score gelijk.
    const is60min = markt.includes('60-min') || markt.includes('60 min') || markt.includes('🕐');
    if (!uitkomst && is60min && ev.regScoreH != null && ev.regScoreA != null) {
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
    else if (!uitkomst && (markt.includes('nrfi') || markt.includes('yrfi') || markt.includes('no run 1st') || markt.includes('yes run 1st') || markt.includes('no run first') || markt.includes('yes run first'))) {
      if (ev.inn1H !== null && ev.inn1H !== undefined && ev.inn1A !== null && ev.inn1A !== undefined) {
        const firstInningRuns = (ev.inn1H || 0) + (ev.inn1A || 0);
        const isNRFI = markt.includes('nrfi') || markt.includes('no run');
        if (isNRFI) uitkomst = firstInningRuns === 0 ? 'W' : 'L';
        else uitkomst = firstInningRuns > 0 ? 'W' : 'L';
      }
    }
    // ── 1st Half Over/Under (basketball, NFL) ──
    else if (!uitkomst && (markt.includes('1h ') || markt.includes('1st half')) && (markt.includes('over') || markt.includes('under'))) {
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
    else if (!uitkomst && (markt.includes('1h ') || markt.includes('1st half')) && (markt.includes('spread') || markt.match(/[+-]\d/))) {
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
    else if (!uitkomst && (markt.includes('p1 ') || markt.includes('1st period')) && (markt.includes('over') || markt.includes('under'))) {
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
    else if (!uitkomst && (markt.includes('odd total') || markt.includes('even total') || markt.includes('🎲'))) {
      const isOdd = markt.includes('odd');
      uitkomst = (total % 2 === 1) === isOdd ? 'W' : 'L';
    }
    // Generic over/under detection (works for all sports: goals, points, runs, etc.)
    else if (!uitkomst && markt.match(/over\s*(\d+\.?\d*)/i)) {
      const ouMatch = markt.match(/over\s*(\d+\.?\d*)/i);
      const line = parseFloat(ouMatch[1]);
      uitkomst = total > line ? 'W' : total < line ? 'L' : null; // exact = push
    }
    else if (!uitkomst && markt.match(/under\s*(\d+\.?\d*)/i) && !markt.match(/over\s*(\d+\.?\d*)/i)) {
      const ouMatch = markt.match(/under\s*(\d+\.?\d*)/i);
      const line = parseFloat(ouMatch[1]);
      uitkomst = total < line ? 'W' : total > line ? 'L' : null;
    }
    else if (!uitkomst && (markt.includes('btts ja') || markt.includes('btts yes') || (markt.includes('btts') && !markt.includes('nee') && !markt.includes('no')))) {
      uitkomst = (ev.scoreH > 0 && ev.scoreA > 0) ? 'W' : 'L';
    }
    else if (!uitkomst && (markt.includes('btts nee') || markt.includes('btts no'))) {
      uitkomst = (ev.scoreH === 0 || ev.scoreA === 0) ? 'W' : 'L';
    }
    else if (!uitkomst && (markt.includes('dnb ') || markt.includes('draw no bet'))) {
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
      await updateBetOutcome(bet.id, uitkomst, userId);
      // Push notification for bet result
      const wlAmount = uitkomst === 'W' ? +((bet.odds-1)*bet.inzet).toFixed(2) : -bet.inzet;
      // v10.10.22 fix: per-user push i.p.v. global broadcast (Codex P0 blocker).
      await sendPushToUser(userId, {
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
    const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
    const [
      liveFixtures, todayFixtures,
      bbLive, bbToday,
      hkLive, hkToday,
      baLive, baToday, baYesterday,
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
      afGet('v1.baseball.api-sports.io', '/games', { date: yesterday }).catch(() => []),
      afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.american-football.api-sports.io', '/games', { date: today }).catch(() => []),
      afGet('v1.handball.api-sports.io', '/games', { live: 'all' }).catch(() => []),
      afGet('v1.handball.api-sports.io', '/games', { date: today }).catch(() => []),
    ]);

    const LIVE_STATUSES = new Set(['1H','HT','2H','ET','BT','P','INT','LIVE']);

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
      const isLive = isV1LiveStatus(statusShort);
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
    const addV1Sport = (liveGames, datedGames, sport, knownIds, namesMap, options = {}) => {
      const sportSeen = new Set();
      for (const g of (liveGames || [])) {
        const lid = g.league?.id;
        const gid = g.id || g.game?.id;
        if (!knownIds.has(lid)) continue;
        sportSeen.add(gid);
        events.push(mapV1Game(g, sport, namesMap));
      }
      for (const g of (datedGames || [])) {
        const lid = g.league?.id;
        const gid = g.id || g.game?.id;
        if (!knownIds.has(lid)) continue;
        if (sportSeen.has(gid)) continue;
        const st = (g.status?.short || g.game?.status?.short || '').toUpperCase();
        if (!shouldIncludeDatedV1Game(st, options)) continue;
        sportSeen.add(gid);
        events.push(mapV1Game(g, sport, namesMap));
      }
    };

    addV1Sport(bbLive,  bbToday,  'basketball',       knownBBLeagueIds,  bbLeagueNames);
    addV1Sport(hkLive,  hkToday,  'hockey',           knownHKLeagueIds,  hkLeagueNames);
    addV1Sport(baLive,  [...(baToday || []), ...(baYesterday || [])], 'baseball', knownBALeagueIds, baLeagueNames, { includeLiveStatuses: true });
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

// Drift alert state: alleen alerten bij NIEUWE drift (niet elk uur dezelfde)
const _driftAlertedKeys = new Set();
const DRIFT_ALERT_RESET_MS = 7 * 86400000; // reset wekelijks
let _driftAlertResetAt = Date.now();

// v10.9.6: odds_snapshots retention. Drift-dashboard query't alleen laatste 14
// dagen (`sinceIso` default). Alles ouder dan 30d (safety margin) is dode
// opslag → ruimt Supabase free-tier 500MB quota leeg. Ook feature_snapshots
// opschonen (>60d). Draait één keer per 24u.
async function runRetentionCleanup() {
  const ODDS_RETENTION_DAYS = 30;
  const FEATURE_RETENTION_DAYS = 60;
  try {
    const oddsIso = new Date(Date.now() - ODDS_RETENTION_DAYS * 86400000).toISOString();
    const { error: oErr, count: oCount } = await supabase.from('odds_snapshots')
      .delete({ count: 'estimated' }).lt('captured_at', oddsIso);
    if (oErr) console.warn('[retention] odds_snapshots delete:', oErr.message);
    else console.log(`🧹 odds_snapshots: ${oCount ?? '?'} rows ouder dan ${ODDS_RETENTION_DAYS}d verwijderd`);

    const fIso = new Date(Date.now() - FEATURE_RETENTION_DAYS * 86400000).toISOString();
    const { error: fErr, count: fCount } = await supabase.from('feature_snapshots')
      .delete({ count: 'estimated' }).lt('captured_at', fIso);
    if (fErr) console.warn('[retention] feature_snapshots delete:', fErr.message);
    else console.log(`🧹 feature_snapshots: ${fCount ?? '?'} rows ouder dan ${FEATURE_RETENTION_DAYS}d verwijderd`);
  } catch (e) {
    console.warn('[retention] crash:', e.message);
  }
}
function scheduleRetentionCleanup() {
  // Draai 1x bij boot (na 5min om scan niet te blokkeren), daarna elke 24u.
  setTimeout(() => {
    runRetentionCleanup();
    setInterval(runRetentionCleanup, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
}

function scheduleHealthAlerts() {
  const INTERVAL_MS = 60 * 60 * 1000; // hourly check

  async function runHealthCheck() {
    try {
      // CLV milestone alert: globaal totaal + per-markt verdict
      const { data: clvBets } = await supabase.from('bets')
        .select('clv_pct, sport, markt').not('clv_pct', 'is', null);
      const all = (clvBets || []).filter(b => typeof b.clv_pct === 'number');
      // v10.7.23: persist _lastClvAlertN in calibration store zodat deploys
      // de counter niet resetten. Eerder werd de milestone elke deploy
      // herhaald omdat in-memory counter=0 + 25 <= huidig totaal.
      if (_lastClvAlertN === 0) {
        try {
          const cCur = loadCalib();
          if (typeof cCur.lastClvAlertN === 'number') {
            _lastClvAlertN = cCur.lastClvAlertN;
          } else {
            // Eerste run na upgrade: snap naar floor(count / 25) * 25 zodat
            // we niet onmiddellijk retroactief 1 of meer milestones afvuren.
            _lastClvAlertN = Math.floor(all.length / CLV_ALERT_INTERVAL) * CLV_ALERT_INTERVAL;
            cCur.lastClvAlertN = _lastClvAlertN;
            await saveCalib(cCur);
          }
        } catch (e) {
          console.warn('CLV milestone counter init failed:', e.message);
          _lastClvAlertN = all.length; // fail-safe: voorkom spam
        }
      }
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
        // v10.9.5: ook in inbox als permanent logboek.
        await supabase.from('notifications').insert({
          type: 'clv_milestone',
          title: `📊 CLV Milestone — ${all.length} settled bets`,
          body: `Gem. CLV ${avgClv > 0 ? '+' : ''}${avgClv.toFixed(2)}% · ${positive}/${all.length} positief (${posPct}%) · ${verdict}\n\nPer markt:\n${marketSummary}`.slice(0, 1500),
          read: false, user_id: null,
        }).then(() => {}, () => {});
        _lastClvAlertN = all.length;
        // v10.7.23: persist counter zodat volgende deploy niet opnieuw triggert
        try {
          const cPersist = loadCalib();
          cPersist.lastClvAlertN = all.length;
          await saveCalib(cPersist);
        } catch (e) { console.warn('Could not persist _lastClvAlertN:', e.message); }
      }

      // Drift alert: detect markten/signalen die recent significant verslechteren
      if (Date.now() - _driftAlertResetAt > DRIFT_ALERT_RESET_MS) {
        _driftAlertedKeys.clear();
        _driftAlertResetAt = Date.now();
      }
      try {
        const driftAll = (clvBets || []).filter(b => typeof b.clv_pct === 'number');
        if (driftAll.length >= 30) {
          const byMarketRecent = {}, byMarketAll = {};
          for (let i = 0; i < driftAll.length; i++) {
            const b = driftAll[i];
            const k = `${normalizeSport(b.sport)}_${detectMarket(b.markt || 'other')}`;
            if (!byMarketAll[k]) byMarketAll[k] = [];
            byMarketAll[k].push(b.clv_pct);
            if (i < 25) {
              if (!byMarketRecent[k]) byMarketRecent[k] = [];
              byMarketRecent[k].push(b.clv_pct);
            }
          }
          for (const [k, recent] of Object.entries(byMarketRecent)) {
            if (recent.length < 10) continue;
            const all = byMarketAll[k] || [];
            if (all.length < 30) continue;
            const avgRecent = recent.reduce((a, b) => a + b, 0) / recent.length;
            const avgAll = all.reduce((a, b) => a + b, 0) / all.length;
            const drift = avgRecent - avgAll;
            const alertKey = `${k}_drop`;
            if (drift < -2 && !_driftAlertedKeys.has(alertKey)) {
              _driftAlertedKeys.add(alertKey);
              await supabase.from('notifications').insert({
                type: 'drift_alert',
                title: `📉 Drift gedetecteerd: ${k}`,
                body: `Recente CLV ${avgRecent.toFixed(2)}% vs all-time ${avgAll.toFixed(2)}% (Δ ${drift.toFixed(2)}%, n=${recent.length}/${all.length}). Markt verslechtert. Overweeg observatie of admin override.`,
                read: false, user_id: null,
              });
            }
          }
        }
      } catch { /* swallow */ }

      // Drawdown soft alert (alleen warn, geen pause)
      if (Date.now() - _lastDdAlertAt > DD_ALERT_COOLDOWN_MS) {
        const { bets, stats } = await readBets(await getAdminUserId());
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
            // v10.9.5: ook in inbox.
            await supabase.from('notifications').insert({
              type: 'drawdown_alert',
              title: `⚠️ Drawdown alert — laatste 7 dagen`,
              body: `P/L laatste 7 dagen: ${(recent7dPct * 100).toFixed(1)}% (€${recent7dPnl.toFixed(2)}). Bankroll: €${stats.bankroll}. Geen auto-pause — overweeg unit-verlagen of stop manueel.`,
              read: false, user_id: null,
            }).then(() => {}, () => {});
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
  const RE_ALERT_DELTA = 0.03;        // alleen opnieuw alerten bij +3pp verschil of richtingswissel
  const RE_ALERT_MIN_HOURS = 4;       // of als persistent sharp move na 4u
  // Persistent via calib.oddsAlerts zodat Render-sleep de dedup niet verliest
  console.log('📈 Odds monitor actief (elke 60 min, persistent dedup via calib)');

  async function runOddsMonitor() {
    try {
      // Load calib async zodat _calibCache warm is voor we schrijven.
      // Voorkomt dat na Render-restart de sync loadCalib() DEFAULT_CALIB returnt
      // en saveCalib de hele calibratie overschrijft.
      const calib = await loadCalibAsync();
      if (!calib || typeof calib !== 'object') return; // fail-safe
      calib.oddsAlerts = calib.oddsAlerts || {};

      const { bets } = await readBets(await getAdminUserId());
      const openBets = bets.filter(b => b.uitkomst === 'Open' && b.tijd);
      if (!openBets.length) return;

      const now = Date.now();
      let checksRun = 0;
      let dedupDirty = false;
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
          const direction = drift < 0 ? 'sharp' : 'fade';
          const prev = calib.oddsAlerts[bet.id];
          const driftChangedEnough = !prev || Math.abs(drift - prev.drift) >= RE_ALERT_DELTA;
          const directionFlipped   = prev && prev.direction !== direction;
          const longSincePrev      = prev && (now - prev.ts) >= RE_ALERT_MIN_HOURS * 60 * 60 * 1000;
          const shouldAlert        = !prev || directionFlipped || driftChangedEnough || longSincePrev;

          if (shouldAlert) {
            const alertTitle = direction === 'sharp' ? `📉 Odds-drift: scherp geld` : `📈 Odds-drift: markt draait`;
            const alertBody = direction === 'sharp'
              ? `${bet.wedstrijd} · ${bet.markt}\nGelogd: ${loggedOdds} → nu: ${currentOdds} (${driftPct}%)\nScherp geld bevestigt jouw kant.`
              : `${bet.wedstrijd} · ${bet.markt}\nGelogd: ${loggedOdds} → nu: ${currentOdds} (+${driftPct}%)\nMarkt draait van je af — overweeg cashout.`;
            await tg((direction === 'sharp'
              ? `📉 ODDS ALERT: ${bet.wedstrijd} ${bet.markt} | ${loggedOdds} → ${currentOdds} (${driftPct}%) | Scherp geld bevestigt jouw kant`
              : `📈 ODDS ALERT: ${bet.wedstrijd} ${bet.markt} | ${loggedOdds} → ${currentOdds} (+${driftPct}%) | Markt draait · overweeg cashout`
            )).catch(() => {});
            // v10.9.5: ook in inbox.
            await supabase.from('notifications').insert({
              type: 'odds_drift', title: alertTitle, body: alertBody,
              read: false, user_id: null,
            }).then(() => {}, () => {});
            calib.oddsAlerts[bet.id] = { drift, direction, ts: now };
            dedupDirty = true;
          }
        }

        await sleep(150);
      }

      // Eén keer saveCalib aan het eind (batch write) + 24u cleanup
      if (dedupDirty) {
        for (const k of Object.keys(calib.oddsAlerts)) {
          if (now - calib.oddsAlerts[k].ts > 24 * 60 * 60 * 1000) delete calib.oddsAlerts[k];
        }
        await saveCalib(calib);
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
    } catch (tgErr) {
      console.warn('Unit baseline Telegram send failed:', tgErr.message);
    }
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
  // checkUnitSizeChange obsolete: unit is nu per-user via settings.unitEur,
  // niet meer een global constante. Notificatie was misleidend (toonde UNIT_EUR=25
  // ipv user's actuele size).
  scheduleDailyResultsCheck();
  scheduleDailyScan();
  scheduleOddsMonitor();
  scheduleFixtureSnapshotPolling();
  scheduleKickoffWindowPolling();
  scheduleAutoRetraining();
  scheduleSignalStatsRefresh();
  scheduleHealthAlerts();
  scheduleRetentionCleanup();

  // v10.9.9: herstel persisted scrape-source toggles uit calib. Zonder dit
  // reset elke deploy alle sources naar default off — operationeel irritant.
  try {
    const scraperBase = require('./lib/scraper-base');
    const cs = loadCalib();
    const persisted = cs.scraper_sources || {};
    const known = ['sofascore', 'fotmob', 'nba-stats', 'nhl-api', 'mlb-stats-ext'];
    let applied = 0;
    for (const name of known) {
      if (persisted[name] === true) { scraperBase.setSourceEnabled(name, true); applied++; }
    }
    if (applied) console.log(`🔌 Scrape-sources hersteld: ${applied} source(s) enabled uit calib`);
  } catch (e) { console.warn('scrape-sources restore failed:', e.message); }

  // v10.9.9: active unit/bankroll bij boot laden zodat pick-ranking vanaf de
  // eerste scan met admin's actuele settings rekent.
  refreshActiveUnitEur().then(() => {
    if (_activeUnitEur !== UNIT_EUR) console.log(`💰 Active unit overridden via admin settings: €${_activeUnitEur}`);
  });

  // Kill-switch initial load + 30-min refresh
  // Operator state laden VÓÓR kill-switch refresh zodat market_auto_kill_enabled correct staat
  loadOperatorState().then(() => refreshKillSwitch())
    .then(() => console.log(`🛑 Kill-switch geladen (${KILL_SWITCH.set.size} actief, OPERATOR: scan=${OPERATOR.master_scan_enabled}, market-kill=${OPERATOR.market_auto_kill_enabled}, signal-kill=${OPERATOR.signal_auto_kill_enabled}, panic=${OPERATOR.panic_mode}, scraping=${OPERATOR.scraping_enabled})`));

  // v10.9.0: circuit-breaker state-change → Supabase inbox notificatie zodat user
  // retroactief kan zien welke bron down/up ging. Rate-limit via breaker zelf
  // (alleen state-transitions tellen, niet elke fetch).
  try {
    const scraperBase = require('./lib/scraper-base');
    scraperBase.onBreakerStateChange(ev => {
      const body = ev.to === 'open'
        ? `Bron "${ev.name}" auto-gedeactiveerd na ${ev.status.totalFails}/${ev.status.totalCalls} fails. Cooldown ~${Math.round(ev.status.cooldownMs / 60000)}min.`
        : ev.to === 'closed'
        ? `Bron "${ev.name}" is hersteld (state: ${ev.from} → closed).`
        : `Bron "${ev.name}" probeert herstel (state: ${ev.from} → ${ev.to}).`;
      supabase.from('notifications').insert({
        type: 'scrape_source',
        title: ev.to === 'open' ? `⚠️ Scraper "${ev.name}" offline` : `✅ Scraper "${ev.name}" weer online`,
        body: body.slice(0, 500),
        read: false, user_id: null,
      }).then(() => {}, () => {});
    });
  } catch (e) { console.warn('scraper breaker hook setup failed:', e.message); }

  // Kelly-fraction laden uit calibration store (default 0.50)
  loadCalibAsync().then(c => {
    const persisted = parseFloat(c?.kellyFraction);
    if (isFinite(persisted) && persisted >= KELLY_FRACTION_MIN && persisted <= 1.0) {
      setKellyFraction(persisted);
    }
    console.log(`💰 Kelly-fraction actief: ${getKellyFraction().toFixed(2)} (max auto: ${KELLY_FRACTION_MAX})`);
  }).catch(() => {});
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

  // Herplan pre-kickoff checks en CLV checks voor alle open bets bij herstart.
  // v10.9.8: admin-scoped — alleen admin's bets krijgen scheduler.
  getAdminUserId().then(uid => readBets(uid)).then(({ bets }) => {
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
    setInterval(() => fetch(url).catch(e => console.warn('Keep-alive ping failed:', e.message)), 14 * 60 * 1000);
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
    // v10.8.13: cron-scan draait nu de VOLLE pipeline (multi-sport +
    // notificatie) ipv alleen football via runPrematch. Verklaart waarom
    // je voorheen geen push/Telegram op scheduled scans kreeg.
    // v10.8.15: altijd een start-heartbeat naar notifications tabel, zodat
    // user achteraf kan zien of de cron-tik überhaupt vuurde (onderscheidt
    // "scheduler stilstand" vs "scan draait maar tg/push faalt").
    try {
      await supabase.from('notifications').insert({
        type: 'cron_tick',
        title: `⏱️ Cron scan ${label} gestart`,
        body: `Scheduler triggered at ${new Date().toISOString()}`,
        read: false, user_id: null,
      });
    } catch {}
    try {
      if (scanRunning) {
        console.log(`⚠️ Scan ${label}: al een scan bezig, skip cron-tik`);
      } else {
        scanRunning = true;
        try {
          // Laad admin prefs zodat cron dezelfde bookie-filter gebruikt als UI.
          let prefs = null;
          try {
            const users = await loadUsers().catch(() => []);
            const admin = users.find(u => u.role === 'admin');
            prefs = admin?.settings?.preferredBookies || null;
          } catch {}
          await runFullScan({
            emit: (d) => { if (d.log) console.log(`[${label}] ${d.log}`); },
            prefs,
            isAdmin: true,
            triggerLabel: `cron-${label}`,
          });
          console.log(`📡 Scan om ${label} klaar`);
        } finally {
          scanRunning = false;
        }
      }
    } catch (e) {
      console.error(`Scan om ${label} fout:`, e.message);
      await tg(`⚠️ Scan om ${label} mislukt: ${e.message}`).catch(() => {});
    }
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
      console.log('⚠️ scheduleDailyScan: geen admin-user, default-scan op 07:30');
      _globalScanTimers.push(scheduleScanAtHour('07:30'));
      return;
    }
    // Clear eventuele bestaande admin-timers voor we nieuwe plannen
    if (userScanTimers[admin.id]) {
      userScanTimers[admin.id].forEach(h => clearTimeout(h));
    }
    const times = admin.settings?.scanTimes?.length ? admin.settings.scanTimes : ['07:30'];
    console.log(`📅 Admin scan-scheduler: ${times.join(', ')} (scanEnabled=${admin.settings?.scanEnabled !== false})`);
    userScanTimers[admin.id] = times.map(t => scheduleScanAtHour(t));
  }).catch((e) => {
    console.log('⚠️ scheduleDailyScan: loadUsers faalde, default op 07:30:', e.message);
    _globalScanTimers.push(scheduleScanAtHour('07:30'));
  });
}

// v10.8.15: diagnostic endpoint. Vertelt welke scan-tijden gepland staan voor
// admin en wanneer de volgende cron-tik valt. Bedoeld om te onderscheiden
// tussen "scheduler heeft 21:00 niet gepland" vs "scheduler vuurde maar scan
// faalde". Geen auth buiten requireAdmin.
app.get('/api/admin/scheduler-status', requireAdmin, async (req, res) => {
  try {
    const users = await loadUsers().catch(() => []);
    const admin = users.find(u => u.role === 'admin');
    const times = admin?.settings?.scanTimes?.length ? admin.settings.scanTimes : ['07:30'];
    const enabled = admin?.settings?.scanEnabled !== false;
    const now = new Date();
    const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
    const offsetMs = amsNow.getTime() - now.getTime();
    const upcoming = times.map(t => {
      const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return { time: t, error: 'bad format' };
      const target = new Date(now);
      target.setHours(parseInt(m[1]), parseInt(m[2]), 0, 0);
      target.setTime(target.getTime() - offsetMs);
      if (target <= now) target.setDate(target.getDate() + 1);
      return {
        time: t,
        nextFire: target.toISOString(),
        nextFireLocal: target.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
        inMinutes: Math.round((target - now) / 60000),
      };
    }).sort((a, b) => (a.inMinutes || 0) - (b.inMinutes || 0));
    const activeTimers = admin ? (userScanTimers[admin.id]?.length || 0) : 0;
    res.json({
      adminId: admin?.id || null,
      scanEnabled: enabled,
      configuredTimes: times,
      activeTimers,
      upcoming,
      serverNow: now.toISOString(),
      amsNow: amsNow.toLocaleString('nl-NL', { timeZone: 'Europe/Amsterdam' }),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
const _globalScanTimers = []; // fallback-handles als geen admin-user bekend is

// ── DAGELIJKSE UITSLAG CHECK (10:00 Amsterdam) ───────────────────────────────
// v10.7.21: verschoven van 06:00 → 10:00 ivm late US/MLB wedstrijden die
// pas in de nacht eindigen. 06:00 miste vaak nog de nachtelijke uitslagen.
// Ook: overzicht bevat nu settled bets van LAATSTE 24H, niet alleen huidige
// open bets. Voorheen zag je vaak maar 1 wedstrijd (de enige nog open).
function scheduleDailyResultsCheck() {
  const now    = new Date();
  const amsNow = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const offsetMs = amsNow.getTime() - now.getTime();
  const target = new Date(now);
  const amsTarget = new Date(now);
  amsTarget.setHours(10, 0, 0, 0); // 10:00 Amsterdam
  target.setTime(amsTarget.getTime() - offsetMs);
  if (target <= now) target.setDate(target.getDate() + 1);
  const delay = target - now;
  const hm    = target.toLocaleTimeString('nl-NL', { hour:'2-digit', minute:'2-digit', timeZone:'Europe/Amsterdam' });
  console.log(`⏰ Dagelijkse check gepland om ${hm} (over ${Math.round(delay/60000)} min)`);

  setTimeout(async () => {
    console.log('⏰ Dagelijkse uitslag check gestart...');
    try {
      const { checked, updated, results } = await checkOpenBetResults();
      const { bets, stats } = await readBets(await getAdminUserId());

      // Overzicht ook settled bets van afgelopen 24h meenemen (niet alleen
      // wat nu nog open was). Hierdoor zie je de volledige nacht + gister.
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      const recent = (bets || []).filter(b => {
        if (!['W','L'].includes(b.uitkomst)) return false;
        // Parse datum (DD-MM-YYYY) + tijd (HH:MM)
        const dm = (b.datum || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
        if (!dm) return false;
        const iso = `${dm[3]}-${dm[2]}-${dm[1]}T${b.tijd || '12:00'}:00`;
        const ms = Date.parse(iso);
        return isFinite(ms) && ms >= cutoff;
      });
      const recentById = new Set(results.map(r => r.id));
      const recentExtra = recent.filter(b => !recentById.has(b.id));

      const lines = [`📋 DAGELIJKSE CHECK · ${new Date().toLocaleDateString('nl-NL', { weekday:'long', day:'numeric', month:'long' })}`];
      lines.push(`${checked} open bet${checked !== 1 ? 's' : ''} gecontroleerd | ${updated} auto-bijgewerkt`);
      lines.push(`📊 Laatste 24h: ${recent.length} settled bets (inclusief reeds vastgelegde)\n`);

      // Eerst: vers gecheckt in deze run
      for (const r of results) {
        const ico = r.uitkomst === 'W' ? '✅' : r.uitkomst === 'L' ? '❌' : '⚠️';
        lines.push(`${ico} ${r.wedstrijd}\n   ${r.markt} | ${r.score} → ${r.uitkomst || 'handmatig'}`);
      }
      // Daarna: al eerder settled in de laatste 24h
      for (const b of recentExtra) {
        const ico = b.uitkomst === 'W' ? '✅' : '❌';
        const scoreStr = b.score || '';
        lines.push(`${ico} ${b.wedstrijd}\n   ${b.markt} | ${scoreStr} → ${b.uitkomst}`);
      }
      if (!results.length && !recentExtra.length) lines.push('Geen afgeronde wedstrijden in laatste 24h.');

      lines.push(`\n💰 Bankroll: €${stats.bankroll} | ROI: ${(stats.roi*100).toFixed(1)}%`);
      await tg(lines.join('\n')).catch(() => {});

      // Push notificatie met dagelijks overzicht (volledige 24h)
      const wCount = recent.filter(r => r.uitkomst === 'W').length;
      const lCount = recent.filter(r => r.uitkomst === 'L').length;
      const pushBody = recent.length
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

    const postResultsDecision = shouldRunPostResultsModelJobs(updated);
    if (postResultsDecision.shouldRun) {
      // Auto-tune signalen alleen als er echt nieuwe resultaten zijn settled.
      await autoTuneSignals().catch(e => console.error('Auto-tune fout:', e.message));
      // Kelly-fraction auto-stepup check (na echte results-update, max 1 stap/dag)
      await evaluateKellyAutoStepup().catch(e => console.error('Kelly auto-stepup fout:', e.message));
      // CLV-based autotune draait mee met dezelfde settled-results cadence om
      // onverwachte modelupdates op rustige dagen te voorkomen.
      const clvTune = await autoTuneSignalsByClv().catch(e => ({ tuned: 0, error: e.message }));
      if (clvTune.tuned > 0) {
        console.log(`📊 CLV autotune: ${clvTune.tuned} signal weights aangepast (${clvTune.muted || 0} gemute)`);
        // Inbox notification bij significante modelverandering
        try {
          const muted = (clvTune.adjustments || []).filter(a => a.reason).slice(0, 3).map(a => `${a.name} (${a.avgClv}%)`).join(', ');
          const top = (clvTune.adjustments || []).filter(a => !a.reason).slice(0, 3).map(a => `${a.name}: ${a.old}→${a.new}`).join(', ');
          await supabase.from('notifications').insert({
            type: 'model_update',
            title: `🧠 Model bijgewerkt: ${clvTune.tuned} signal weights aangepast`,
            body: `${clvTune.muted || 0} signal(s) gemute (CLV ≤ -3%): ${muted || 'geen'}\n${top ? `Aangepast: ${top}` : ''}`,
            read: false, user_id: null,
          });
        } catch { /* swallow */ }
      }

      // v10.10.16: calibration-monitor (slice 2, sectie 14.R2.A). Meet of
      // onze signaal-voorspellingen daadwerkelijk gekalibreerd zijn.
      const calResult = await updateCalibrationMonitor().catch(e => ({ error: e.message }));
      if (calResult?.aggregated > 0) {
        console.log(`📊 Calibration monitor: ${calResult.aggregated} signal×sport×markt×window rows bijgewerkt`);
      } else if (calResult?.error) {
        console.warn(`⚠️ Calibration monitor skip: ${calResult.error}`);
      }
    } else {
      console.log('📭 Geen nieuwe settled bets → auto-tune, Kelly-stepup en calibration monitor overgeslagen');
    }

    // Actionable todos check — sticky inbox-items voor beslissingen die je moet nemen
    await evaluateActionableTodos().catch(e => console.error('Todo-check fout:', e.message));

    scheduleDailyResultsCheck(); // plan volgende dag
  }, delay);
}

// ── CALIBRATION MONITOR · slice 2 (v10.10.16) ───────────────────────────────
// Per-window Brier/log-loss per (signal, sport, market_type). Daily job
// leest settled bets, bouwt prediction-records via lib/calibration-monitor,
// en upsert resultaten naar Supabase.signal_calibration.
//
// v1-aanpak: gebruikt expliciet `ep_proxy = 1/odds + Σsignal_contribution%`.
// Dit is GEEN canonical `pick.ep`; de echte model-adjusted probability vereist
// een bet↔pick join-layer die in een aparte slice komt. Daarom schrijven we
// `probability_source='ep_proxy'` weg zodat downstream dit niet als model
// truth leest.

const {
  aggregateBySignal: _calAggregateBySignal,
  buildCalibrationRows: _buildCalibrationRows,
} = require('./lib/calibration-monitor');

function _parseSignalsBlob(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function _parseBetDatum(datum) {
  // bets.datum formaat: 'DD-MM-YYYY'
  if (typeof datum !== 'string') return null;
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(datum.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return Number.isFinite(t) ? t : null;
}

async function updateCalibrationMonitor() {
  const now = Date.now();
  const cutoffMs = now - 400 * 24 * 60 * 60 * 1000;
  const { data: betsRows, error } = await supabase.from('bets')
    .select('bet_id, datum, sport, markt, odds, uitkomst, signals, fixture_id')
    .in('uitkomst', ['W', 'L'])
    .limit(10000);
  if (error) return { error: error.message, aggregated: 0 };

  const settled = [];
  for (const b of betsRows || []) {
    const odds = parseFloat(b.odds);
    if (!Number.isFinite(odds) || odds <= 1.0) continue;
    const settledAt = _parseBetDatum(b.datum);
    if (!settledAt || settledAt < cutoffMs) continue;

    const signals = _parseSignalsBlob(b.signals);
    const implied = 1 / odds;
    const signalBoost = signals
      .map(s => { const m = /([+-]\d+\.?\d*)%/.exec(String(s)); return m ? parseFloat(m[1]) / 100 : 0; })
      .reduce((a, c) => a + c, 0);
    const ep = Math.max(0.02, Math.min(0.95, implied + signalBoost));

    settled.push({
      ep,
      uitkomst: b.uitkomst,
      settledAt,
      signals,
      sport: b.sport || null,
      marketType: detectMarket(b.markt || 'other'),
    });
  }

  if (!settled.length) return { aggregated: 0, settledCount: 0 };

  const aggregates = _calAggregateBySignal(settled, { now });
  const rows = _buildCalibrationRows(aggregates, {
    windowEndMs: now,
    probabilitySource: 'ep_proxy',
  });
  if (!rows.length) return { aggregated: 0, settledCount: settled.length };

  try {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { error: upErr } = await supabase.from('signal_calibration')
        .upsert(chunk, { onConflict: 'signal_name,sport,market_type,window_key' });
      if (upErr) {
        // Tabel kan nog niet bestaan (migratie niet gedraaid). Niet-fataal.
        if (/relation .* does not exist/i.test(upErr.message || '')) {
          return { error: 'signal_calibration tabel nog niet gemigreerd', aggregated: 0 };
        }
        return { error: upErr.message, aggregated: 0 };
      }
    }
    return { aggregated: rows.length, settledCount: settled.length };
  } catch (e) {
    return { error: e.message, aggregated: 0 };
  }
}

// ── ACTIONABLE TODOS — sticky inbox-items ───────────────────────────────────
// Inbox-notifications die blijven staan tot user ze als gelezen markeert.
// Idempotent: check of todo-type al bestaat (ook als 'read') voor we 'm inserten.
async function evaluateActionableTodos() {
  const todos = [];
  const c = loadCalib();

  // TODO: Render upgrade — bij 100 settled bets met positieve gem CLV
  try {
    const totalSettled = c.totalSettled || 0;
    const clvList = (c.clvHistory || []).slice(0, 100);
    const avgClv = clvList.length ? clvList.reduce((s, x) => s + (x.clv_pct || 0), 0) / clvList.length : 0;
    if (totalSettled >= 100 && avgClv > 0) {
      todos.push({
        type: 'todo_render_upgrade',
        title: '🚀 Tijd om Render te upgraden',
        body: `Milestone: ${totalSettled} settled bets met avg CLV ${avgClv.toFixed(2)}%.\n\nSysteem bewijst waarde. Upgrade Render Starter ($7/mnd) voor guaranteed uptime — huidige free tier kan sleep/cold-start veroorzaken waardoor pre-kickoff checks en CLV-capture kunnen missen.\n\nRender dashboard → Upgrade Plan.`,
      });
    }
  } catch {}

  // v10.8.7: actionable alerts — unit-increase + bookie-spreid bij groeiende bankroll
  try {
    const users = _usersCache || [];
    const admin = users.find(u => u.role === 'admin');
    if (admin) {
      const ue = admin.settings?.unitEur || UNIT_EUR;
      const { stats } = await readBets(admin.id);
      const bankroll = stats?.bankroll || START_BANKROLL;
      // Recommended unit per safe-ladder rule
      const safeRule = ue < 100 ? 0.10 : ue < 300 ? 0.05 : ue < 500 ? 0.03 : 0.02;
      const recommendedUnit = Math.max(1, Math.round(bankroll * safeRule));

      // Unit-increase alert: als bankroll groei zo'n unit-bump rechtvaardigt
      if (recommendedUnit > ue * 1.25 && bankroll >= 300) {
        todos.push({
          type: 'unit_increase',
          title: `💰 Tijd om unit te verhogen: €${ue} → €${recommendedUnit}`,
          body: `Bankroll groeide naar €${bankroll.toFixed(0)}. Volgens de ${(safeRule*100).toFixed(0)}%-regel (${ue<100?'aggressief':'safe ladder'}) is de aanbevolen unit-size nu €${recommendedUnit}.\n\nGa naar Settings en pas unitEur aan.`,
        });
      }

      // Bookie-diversify alert: bij unit > €200 gebruik 2+ bookies
      if (ue >= 200 || recommendedUnit >= 200) {
        const prefBookies = (admin.settings?.preferredBookies || []).length;
        if (prefBookies < 2) {
          todos.push({
            type: 'bookie_diversify',
            title: `🛡️ Spreid over meerdere bookies (unit €${ue})`,
            body: `Bij unit-size ≥€200 worden NL-bookies (Bet365/Unibet) snel verdacht. Single-bookie betting → limit binnen weken.\n\nMaak account bij minstens 2-3 bookies (Bet365, Unibet, BingoalNL) en zet ze als preferred in Settings. Roteer bets om onder de radar te blijven.`,
          });
        }
      }

      // Bookie-radar warning bij hoge unit
      if (ue >= 500) {
        todos.push({
          type: 'cashout_advice',
          title: `⚠️ Hoge unit (€${ue}) — overweeg cashout strategie`,
          body: `Op €${ue}/unit ben je in "limit-zone" bij Bet365/Unibet (limit binnen dagen-weken op sharp markten). Strategieën:\n\n1. Spreid over 3+ bookies en houd elke account onder €300/bet\n2. Cash €${Math.round(bankroll * 0.30)} eraf bij elke 30% bankroll-groei (jouw eigen €3k-rule)\n3. Mix in Bet Builder picks om "recreational" te lijken\n4. Vermijd alleen sharp markten (Asian totals, lower-division corners)`,
        });
      }
    }
  } catch (e) {
    console.warn('Actionable alerts evaluation failed:', e.message);
  }

  // v10.8.8: dedup op type+title (niet alleen type) zodat unit_increase met
  // verschillende doelwit (€25→€38 vs €25→€100) NIET hetzelfde wordt geacht.
  // Plus: skip insert als zelfde alert <30 dagen oud is om spam te voorkomen.
  for (const todo of todos) {
    try {
      const since = new Date(Date.now() - 30 * 86400000).toISOString();
      const { data } = await supabase.from('notifications')
        .select('id, created_at').eq('type', todo.type).eq('title', todo.title)
        .gte('created_at', since).limit(1);
      if (!data || !data.length) {
        await supabase.from('notifications').insert({
          type: todo.type,
          title: todo.title,
          body: todo.body,
          read: false,
          user_id: null,
        });
        console.log(`📋 Todo aangemaakt: ${todo.type} · ${todo.title}`);
      }
    } catch (e) { console.error('Todo insert fout:', e.message); }
  }
}
