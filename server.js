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
  formatDropReasons,
  calcForm,
  calcMomentum,
  calcStakes,
  calcOverProb,
  calcBTTSProb,
  analyseTotal,
} = require('./lib/picks');
const { summarizeExecutionQuality, normalizeBookmaker } = require('./lib/execution-quality');
const { fetchNhlGoaliePreview } = require('./lib/integrations/nhl-goalie-preview');
const { applyCorrelationDamp } = require('./lib/correlation-damp');
const { supportsApiSportsInjuries } = require('./lib/integrations/api-sports-capabilities');
const { shouldRunPostResultsModelJobs } = require('./lib/runtime/daily-results');
const { parseBetKickoff } = require('./lib/runtime/bet-kickoff');
const { isV1LiveStatus, shouldIncludeDatedV1Game } = require('./lib/runtime/live-board');
const { matchesClvRecomputeTarget } = require('./lib/runtime/operator-actions');
const { resolveBetOutcome } = require('./lib/runtime/results-checker');
const { logScanEnd } = require('./lib/runtime/scan-logger');
const { fetchSnapshotClosing } = require('./lib/clv-backfill');
const { logEarlyPayoutShadow, aggregateEarlyPayoutStats } = require('./lib/signals/early-payout');
const { marketKeyFromBetMarkt: _marketKeyFromBetMarkt, supportsClvForBetMarkt } = require('./lib/clv-match');

// Snapshot layer (v2 foundation): point-in-time logging voor learning + backtesting
const snap = require('./lib/snapshots');

// Price-memory query layer (Phase A.1 wiring): read-side helpers bovenop odds_snapshots.
const lineTimelineLib = require('./lib/line-timeline');
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
    const all = bets.filter(b =>
      typeof b.clv_pct === 'number' &&
      !isNaN(b.clv_pct) &&
      supportsClvForBetMarkt(b.markt)
    );
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
// v11.3.30 (operator-rapport 2026-04-19): tier-differentiatie verwijderd.
//
// Oude drempels (8% / 6.5% / 5.5%) waren een SAMPLE-TRAP:
//   - football_over had ≥100 samples → 5.5% → picks komen door
//   - alle andere markten (1X2, BTTS, DNB, basketball/hockey/baseball ML,
//     NRFI, F5 ML) <30 samples → 8% → vrijwel nooit picks → geen samples
//     toename → blijvend unproven → blijvend 8%
//   Resultaat sinds 2026-04-18: alleen Over 2.5 voetbal picks. Chicken-
//   and-egg: je hebt samples nodig om te calibreren, dus strenger zijn op
//   markten zónder samples verhindert juist de calibratie.
//
// Nieuwe logica: uniforme baseMinEdge (5.5%) post-bootstrap. Risicobeheer
// ligt al bij andere lagen: sanity-gate (7pp), signal-quality, line-
// quality, execution-coverage, price-range, ≥1 paired bookie, dataConfidence.
// Een extra adaptieve drempel op top is overkill én contra-productief.
// Bootstrap (<100 totaal): base MIN_EDGE everywhere (ongewijzigd).
function adaptiveMinEdge(sport, marktLabel, baseMinEdge) {
  if (Date.now() - _marketSampleCache.at > MARKET_SAMPLE_TTL_MS) {
    refreshMarketSampleCounts().catch(e => console.warn('Market samples refresh failed:', e.message));
  }
  // Bootstrap én post-bootstrap beide: base MIN_EDGE. Sample-cache refresh
  // blijft lopen zodat een latere beleidswijziging (bv. per-markt kill-
  // switch op basis van CLV) de counts kan gebruiken zonder extra plumbing.
  // sport + marktLabel parameters blijven voor backward-compat + toekomstig
  // per-markt beleid, maar worden nu niet benut.
  void sport; void marktLabel;
  return baseMinEdge;
}

// Pure math & model helpers — geïmporteerd uit lib zodat test.js dezelfde code test
const modelMath = require('./lib/model-math');
const {
  NHL_OT_HOME_SHARE, MODEL_MARKET_DIVERGENCE_THRESHOLD, KELLY_FRACTION,
  getKellyFraction, setKellyFraction, KELLY_FRACTION_MIN, KELLY_FRACTION_MAX, KELLY_FRACTION_STEP,
  poisson, poissonOver, poisson3Way,
  devigProportional, consensus3Way, deriveIncOTProbFrom3Way, modelMarketSanityCheck, passesDivergence2Way,
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
// v10.12.1 (security): trust the first proxy hop (Render's edge). Zonder dit
// is `req.ip` altijd het proxy-loopback en delen alle auth'd users één
// rate-limit-bucket — één attacker DoS't iedereen. Met trust=1 gebruikt Express
// x-forwarded-for[0] als req.ip, wat op Render de werkelijke client IP is.
app.set('trust proxy', 1);
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
//
// v10.12.1 (security): endpoint-validatie bij save. Voorheen kon een auth'd
// user een willekeurige URL als endpoint registreren — webpush.sendNotification
// zou dan blind HTTP POSTen naar interne services (169.254.169.254, localhost,
// :6379, …) = blind SSRF. Nu: alleen HTTPS + hostname uit bekende push-service
// allowlist (FCM, Mozilla autopush, Apple, WNS). Extra: size-cap op subscription
// payload tegen memory-DoS.
const ALLOWED_PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
  'api.push.apple.com',
];
const ALLOWED_PUSH_HOST_SUFFIXES = [
  '.notify.windows.com', // *.notify.windows.com (WNS regional endpoints)
  '.push.apple.com',     // forward-compat Apple endpoints
];

function isAllowedPushEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > 2000) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (ALLOWED_PUSH_HOSTS.includes(host)) return true;
  return ALLOWED_PUSH_HOST_SUFFIXES.some(suffix => host.endsWith(suffix));
}

async function savePushSub(sub, userId = null) {
  if (!sub?.endpoint) return;
  if (!isAllowedPushEndpoint(sub.endpoint)) {
    console.warn(`[push] Rejected non-allowlisted endpoint: ${String(sub.endpoint).slice(0, 120)}`);
    return;
  }
  const serialized = JSON.stringify(sub);
  if (serialized.length > 4000) {
    console.warn(`[push] Rejected oversized subscription payload (${serialized.length} bytes)`);
    return;
  }
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
// v12.2.9 (F6): persistent store met Supabase + Map-cache. Bij Render-restart
// blijven actieve codes geldig (5 min TTL) ipv direct verloren.
const { createAuthCodesStore } = require('./lib/auth-codes-store');
const loginCodes = createAuthCodesStore({ supabase });

// Cleanup expired codes every 10 min — sweep cache + Supabase.
setInterval(() => loginCodes.cleanup(), 10 * 60 * 1000);

// Routes that don't require authentication (full paths)
// v10.10.22 fase 2: UUID-validatie voor .or() interpolaties (defense-in-depth).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isValidUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// v10.10.22 fase 2: /api/status verwijderd uit publieke paden (lekte model-stats + API-usage).
// v11.3.23 H1: /api/health dedicated public keep-alive endpoint (minimale { ok, ts } payload).
const PUBLIC_PATHS = new Set([
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/verify-code',
  '/api/health',
]);

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
const UNIT_EUR   = 25;
const START_BANKROLL = 250;
// (calibration + signal weights stored in Supabase)

// ── USER MANAGEMENT — v10.11.0 fase 3: gecollapsed naar lib/db.js ──────────
// Voorheen: volledige duplicaten van loadUsers/saveUser/defaultSettings/
// getUserMoneySettings in zowel server.js als lib/db.js. Nu: één canonieke
// bron in lib/db.js, server.js importeert.
const {
  defaultSettings, loadUsers, saveUser, getUsersCache, clearUsersCache,
  getUserMoneySettings,
} = require('./lib/db');

// v10.9.9: dynamic UNIT_EUR. Admin's settings.unitEur override de globale
// constant zodat compounding (unit €25 → €50 → €100) de pick-ranking en
// expectedEur meeschuift zonder code-deploy. `mkP` leest synchrone cache —
// `refreshActiveUnitEur()` wordt bij elke scan-start aangeroepen.
let _activeUnitEur = UNIT_EUR;
let _activeStartBankroll = START_BANKROLL;
// v10.12.23 Phase C.10 live-wiring: stake-regime engine beslist automatisch
// over Kelly-fractie + unit-multiplier. Computed per scan, cached hier zodat
// pick-flow synchroon kan lezen. Null tijdens boot = fallback naar defaults.
let _currentStakeRegime = null;
let _lastRegimeTransitionName = null;
function getStakeRegime() { return _currentStakeRegime; }
function getActiveUnitEur() {
  const mult = _currentStakeRegime?.unitMultiplier;
  if (Number.isFinite(mult) && mult > 0 && mult <= 2) {
    return +(_activeUnitEur * mult).toFixed(2);
  }
  return _activeUnitEur;
}
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

// v10.12.23 Phase C.10 live-wiring: bereken regime uit live bets-data.
// Wordt aangeroepen aan start van elke scan + bij boot. Pure async lezer.
// v11.0.0: bankroll-metrics-berekening staat nu in lib/stake-regime.js
// (computeBankrollMetrics) en is gedeeld met /api/admin/v2/stake-regime preview.
async function recomputeStakeRegime() {
  try {
    const { evaluateStakeRegime, computeBankrollMetrics } = require('./lib/stake-regime');
    // v11.3.23 F2 (Codex #1): scope op admin-user + legacy user_id=null.
    // Eerdere versie las alle users' settled history, wat in een multi-user
    // scenario de stake-regime contaminates. Doctrine: single-operator.
    const adminId = await getAdminUserId().catch(() => null);
    let query = supabase.from('bets')
      .select('uitkomst, clv_pct, wl, inzet, datum').in('uitkomst', ['W', 'L']);
    if (adminId) {
      query = query.or(`user_id.eq.${adminId},user_id.is.null`);
    }
    const { data: bets, error } = await query;
    if (error) return;
    const metrics = computeBankrollMetrics(bets || [], _activeStartBankroll);

    const decision = evaluateStakeRegime({
      totalSettled: metrics.totalSettled,
      longTermClvPct: metrics.longTermClvPct,
      longTermRoi: metrics.longTermRoi,
      recentClvPct: metrics.recentClvPct,
      drawdownPct: metrics.drawdownPct,
      consecutiveLosses: metrics.consecutiveLosses,
      bankrollPeak: metrics.bankrollPeak,
      currentBankroll: metrics.currentBankroll,
    });

    // Sanity: bounds-check. Als output outside verwacht bereik → fallback naar
    // conservatief default (kelly 0.35, unit ×1.0), log warning.
    if (!decision || !Number.isFinite(decision.kellyFraction)
        || decision.kellyFraction < 0.10 || decision.kellyFraction > 0.80) {
      console.warn('[stake-regime] decision out of bounds — fallback to conservative default');
      _currentStakeRegime = { regime: 'fallback', kellyFraction: 0.35, unitMultiplier: 1.0, reasons: ['bounds_check_failed'] };
      setKellyFraction(0.35);
      return;
    }

    // Transition alert
    if (_lastRegimeTransitionName && decision.regime !== _lastRegimeTransitionName) {
      notify(
        `🎚️ STAKE-REGIME TRANSITION\n${_lastRegimeTransitionName} → ${decision.regime}\nKelly ${decision.kellyFraction} · unit ×${decision.unitMultiplier}\n${(decision.reasons || []).join(' · ')}`,
        'stake_regime_transition'
      ).catch(() => {});
    }
    _lastRegimeTransitionName = decision.regime;
    _currentStakeRegime = decision;
    // Sync de globale Kelly-fractie zodat lib/model-math.js:getKellyFraction()
    // (gebruikt door mkP in lib/picks.js) de regime-waarde teruggeeft.
    setKellyFraction(decision.kellyFraction);
  } catch (e) {
    console.warn('[stake-regime] recompute failed:', e.message);
    // behoud vorige regime als die er was; anders default
    if (!_currentStakeRegime) {
      _currentStakeRegime = { regime: 'fallback', kellyFraction: 0.35, unitMultiplier: 1.0, reasons: ['recompute_failed'] };
    }
  }
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

// loadUsers + saveUser: nu uit lib/db.js (boven geïmporteerd)

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

const calibrationStore = createCalibrationStore({ supabase, baseDir: __dirname });
const loadCalib = calibrationStore.loadSync;
const loadCalibAsync = calibrationStore.load;
const saveCalib = calibrationStore.save;
// v12.2.7 (F3): atomic outcome-flip. Geinjecteerd in createBetsData.
const snapshotCalib = calibrationStore.snapshot;
const restoreCalib = calibrationStore.restore;

// detectMarket() komt uit lib/model-math.js


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
// v10.12.25 DEPRECATED · De stake-regime engine (lib/stake-regime.js, wired
// in v10.12.23) vervangt deze functie. `scale_up` regime triggert nu op
// dezelfde criteria (200+ settled, CLV ≥2%, ROI ≥5%) én weegt drawdown /
// regime-shift / consecutive-L tegelijk. Deze function blijft hier als
// no-op-met-log zodat bestaande callers (scheduleAutoRetraining +
// /api/admin/v2/auto-retrain) niet crashen — ze krijgen voortaan
// `{ stepped: false, reason: 'deprecated_use_stake_regime' }`.
//
// Wordt verwijderd in een toekomstige commit zodra alle callers zijn
// opgeschoond.

async function evaluateKellyAutoStepup() {
  console.info('[kelly-stepup] deprecated — stake-regime engine handles this now (v10.12.23+)');
  return { stepped: false, reason: 'deprecated_use_stake_regime' };
}

// v10.12.3 (Phase A.3): Brier feedback loop. Aggregeert signal_calibration
// rows per (signal, window) over alle sports/markten. 90d drift = brier90 -
// brier365. Positief = signal raakt slechter gekalibreerd ook al kan raw
// CLV nog stabiel zijn (ranking-correct maar probability-gedrift). Wordt
// binnen autoTuneSignalsByClv als extra gate gebruikt:
//   drift ≥ 0.03 + n90 ≥ 50 → mute override (ook bij positieve CLV)
//   drift ≥ 0.015 + n90 ≥ 30 → extra demping × 0.90
// Concept-drift doctrine uit §14.R2.A.
async function loadSignalBrierDrift() {
  try {
    const { data, error } = await supabase.from('signal_calibration')
      .select('signal_key, window_key, brier_score, sample_size')
      .in('window_key', ['90d', '365d']);
    if (error) {
      // Tabel bestaat nog niet → drift-monitoring no-op, backwards-compat.
      if (/relation .* does not exist/i.test(error.message || '')) return new Map();
      throw error;
    }
    // Aggregeer per (signal_key, window_key): weighted-avg brier over sports/markten.
    const byKey = new Map(); // signalKey → { win90: {sumBn, sumN}, win365: {sumBn, sumN} }
    for (const row of data || []) {
      if (!row?.signal_key || !Number.isFinite(row.brier_score) || !Number.isFinite(row.sample_size) || row.sample_size <= 0) continue;
      if (!byKey.has(row.signal_key)) byKey.set(row.signal_key, { win90: { sumBn: 0, sumN: 0 }, win365: { sumBn: 0, sumN: 0 } });
      const entry = byKey.get(row.signal_key);
      const target = row.window_key === '90d' ? entry.win90 : row.window_key === '365d' ? entry.win365 : null;
      if (!target) continue;
      target.sumBn += row.brier_score * row.sample_size;
      target.sumN  += row.sample_size;
    }
    const result = new Map();
    for (const [signalKey, entry] of byKey) {
      const brier90 = entry.win90.sumN > 0 ? entry.win90.sumBn / entry.win90.sumN : null;
      const brier365 = entry.win365.sumN > 0 ? entry.win365.sumBn / entry.win365.sumN : null;
      if (brier90 == null || brier365 == null) continue;
      result.set(signalKey, {
        brier90: +brier90.toFixed(4),
        brier365: +brier365.toFixed(4),
        drift: +(brier90 - brier365).toFixed(4),
        n90: entry.win90.sumN,
        n365: entry.win365.sumN,
      });
    }
    return result;
  } catch (e) {
    console.warn('[brier-drift] load failed:', e.message);
    return new Map();
  }
}

async function autoTuneSignalsByClv() {
  // Operator failsafe: signal-kill mode kan worden uitgeschakeld via dashboard.
  // Dan tunet de functie nog wel weights, maar de mute (weight=0) wordt overgeslagen.
  const muteAllowed = OPERATOR.signal_auto_kill_enabled !== false;
  try {
    const { data: bets } = await supabase.from('bets')
      .select('signals, clv_pct, sport, markt').not('clv_pct', 'is', null);
    const all = (bets || []).filter(b =>
      typeof b.clv_pct === 'number' &&
      !isNaN(b.clv_pct) &&
      b.signals &&
      supportsClvForBetMarkt(b.markt)
    );
    if (all.length < 30) return { tuned: 0, adjustments: [], note: 'te weinig CLV data (<30)' };

    const signalStats = summarizeSignalMetrics(all.map(b => ({
      marketKey: `${normalizeSport(b.sport || 'football')}_${detectMarket(b.markt || 'other')}`,
      clvPct: b.clv_pct,
      signalNames: parseBetSignals(b.signals).map(s => String(s).split(':')[0]).filter(Boolean),
    }))).signals;

    // v10.12.3 Phase A.3: Brier drift context (90d vs 365d) voor elke signal.
    // Triggert extra mute/demping ook als CLV niet negatief genoeg is voor
    // de bestaande gate.
    const brierDrift = await loadSignalBrierDrift();

    // v10.12.11 Phase B.5: Benjamini-Hochberg FDR correctie.
    // Met 14+ signalen × meerdere sporten is multiple-comparisons risico hoog —
    // iedere monkey vindt een "edge" door toeval. Voor elk signaal dat nu in
    // aanmerking komt voor tuning (n ≥ 20), berekenen we een 2-tailed binomial
    // p-value op posExcessClvRate vs null=0.5. Signalen die BH-FDR (q=0.10)
    // NIET passeren, krijgen alleen een soft nudge richting 1.0 i.p.v. grote
    // weight-stap. Doctrine §14.R2.A eiste deze correctie expliciet.
    const fdrCandidates = Object.entries(signalStats)
      .filter(([, s]) => s.n >= 20)
      .map(([name, s]) => {
        // posExcessClvRate: fractie bets waar signaal boven markt-baseline zat.
        const k = Math.round(s.posExcessClvRate * s.n);
        return { name, p: modelMath.binomialPvalueTwoTailed(k, s.n) };
      });
    const fdrPass = modelMath.benjaminiHochbergFDR(fdrCandidates, 0.10);

    const weights = loadSignalWeights();
    const adjustments = [];
    let tuned = 0, muted = 0, drifted = 0, fdrDampened = 0;
    for (const [name, s] of Object.entries(signalStats)) {
      if (s.n < 20) continue;
      const avgClv = s.avgClv;
      const edgeClv = s.shrunkExcessClv;
      const old = weights[name] !== undefined ? weights[name] : 1.0;
      const drift = brierDrift.get(name) || null;
      const clearsFDR = fdrPass.has(name);
      let newW = old;
      let reason = null;

      // Brier-drift override: structurele kalibratie-degradatie → mute zelfs
      // als CLV nog neutraal/positief is (ranking kan correct zijn terwijl
      // probability-output drift — Kelly-sizing gebruikt de probability,
      // dus dit raakt stake-correctness direct).
      if (muteAllowed && drift && drift.n90 >= 50 && drift.drift >= 0.03 && drift.brier90 > drift.brier365) {
        newW = 0;
        reason = `brier_drift_mute (90d Brier ${drift.brier90.toFixed(3)} vs 365d ${drift.brier365.toFixed(3)} · drift +${drift.drift.toFixed(3)} over ${drift.n90} samples)`;
        muted++;
        drifted++;
      }
      // KILL-SWITCH op CLV (bestaand gedrag)
      else if (muteAllowed && s.n >= SIGNAL_KILL_MIN_N && edgeClv <= -1.5 && avgClv <= -0.5) {
        newW = 0;
        reason = `auto_disabled (edge_clv ${edgeClv.toFixed(2)}%, raw ${avgClv.toFixed(2)}% over ${s.n} bets)`;
        muted++;
      } else if (old === 0 && s.n >= SIGNAL_KILL_MIN_N && edgeClv >= 0.75 && avgClv > 0) {
        // AUTO-PROMOTE: alleen als er GEEN Brier-drift is (drift < 0.03),
        // anders blijft het signaal in shadow tot kalibratie-herstel.
        if (!drift || drift.drift < 0.03) {
          newW = 0.5;
          reason = `auto_promoted (edge_clv +${edgeClv.toFixed(2)}%, raw +${avgClv.toFixed(2)}% over ${s.n} bets · weight 0 → 0.5)`;
        } else {
          reason = `auto_promote_blocked (edge_clv ok maar Brier drift +${drift.drift.toFixed(3)} — signaal blijft shadow)`;
        }
      } else if (edgeClv < -1.0) newW = Math.max(0.3, old * 0.92);
      else if (edgeClv > 1.0) newW = Math.min(1.5, old * 1.05);
      else if (edgeClv < -0.25) newW = Math.max(0.3, old * 0.97);
      else if (edgeClv > 0.25) newW = Math.min(1.5, old * 1.02);
      else newW = old * 0.99 + 0.01;

      // Soft-dampen bij matige drift (als we niet al gemute hebben)
      if (newW > 0 && drift && drift.n90 >= 30 && drift.drift >= 0.015 && drift.drift < 0.03 && drift.brier90 > drift.brier365) {
        newW = +(newW * 0.90).toFixed(3);
        reason = (reason ? reason + ' + ' : '') + `brier_drift_dampen (90d Brier +${drift.drift.toFixed(3)}, n=${drift.n90})`;
        drifted++;
      }

      // v10.12.11 Phase B.5: FDR-dampen. Als signaal NIET door BH-FDR komt
      // en we wilden de weight aanpassen (andere dan ×1.0), schaal terug
      // naar een halve-step richting 1.0. Mutes door drift/CLV-kill blijven
      // staan — die hebben ander bewijs (negatieve CLV + grote sample).
      if (newW > 0 && !clearsFDR && newW !== old && reason !== null && !/auto_disabled|brier_drift_mute/.test(reason || '')) {
        // Schaal de delta met 0.5
        const half = old + (newW - old) * 0.5;
        newW = +half.toFixed(3);
        reason = (reason ? reason + ' + ' : '') + `fdr_soft (geen significantie bij q=0.10 · tuning gehalveerd)`;
        fdrDampened++;
      }

      if (Math.abs(newW - old) >= 0.02 || reason) {
        weights[name] = +newW.toFixed(3);
        adjustments.push({
          name, old: +old.toFixed(3), new: +newW.toFixed(3),
          avgClv: +avgClv.toFixed(2), edgeClv: +edgeClv.toFixed(2), n: s.n,
          brier_drift: drift ? drift.drift : null,
          brier_n90: drift ? drift.n90 : null,
          fdr_passed: clearsFDR,
          reason
        });
        tuned++;
      }
    }
    if (tuned) await saveSignalWeights(weights);

    // Web-push alert als er signals op drift zijn gemute — operator wil dit
    // weten zonder in admin-panel te gaan kijken.
    if (drifted > 0) {
      const driftList = adjustments
        .filter(a => /brier_drift/.test(a.reason || ''))
        .slice(0, 5)
        .map(a => `${a.name} (drift +${(a.brier_drift || 0).toFixed(3)})`)
        .join(', ');
      notify(`📉 SIGNAL BRIER DRIFT\n${drifted} signaal(en) kalibratie-gedrift gedetecteerd:\n${driftList}`, 'brier_drift').catch(() => {});
    }

    return { tuned, muted, drifted, fdrDampened, adjustments };
  } catch (e) {
    return { tuned: 0, adjustments: [], error: e.message };
  }
}

async function autoTuneSignals() {
  try {
    // Alleen admin bets voor model training
    const adminUser = (getUsersCache() || []).find(u => u.role === 'admin');
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
        notify(`🧠 SIGNAL TUNING\n🔧 "${name}" gewicht: ${old.toFixed(2)} → ${newW.toFixed(2)}\n📈 Hit rate: ${(hitRate*100).toFixed(0)}% (${stats.n} bets)\n${dir}`).catch(() => {});
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

  await notify(lines.join('\n')).catch(() => {});

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
// v10.12.25 race-fix: gebruik frozen immutable arrays met atomic reference
// swap. Helpers gedefinieerd als locale bindings zodat bestaande references
// blijven werken; setters doen een atomic Object.freeze swap. Voorkomt dat
// een concurrent GET /api/picks een halverwege gevulde array ziet tijdens
// een lange scan.
let lastPrematchPicks = Object.freeze([]);
let lastLivePicks = Object.freeze([]);
function _atomicSetPrematch(v) { lastPrematchPicks = Object.freeze(Array.isArray(v) ? [...v] : []); }
function _atomicSetLive(v)     { lastLivePicks     = Object.freeze(Array.isArray(v) ? [...v] : []); }

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
const toD    = f => { if (!f || !f.includes('/')) return null; const [n,d] = f.split('/').map(Number); return +(1 + n/d).toFixed(2); };
const clamp  = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// Operator alert channel (v10.12.0: Telegram removed — Web Push + inbox only).
// Schrijft naar Supabase notifications (PWA-inbox) én stuurt een web-push.
// userId=null → broadcast (admin-scoped in practice: single operator).
const notify = async (text, type = 'info', userId = null) => {
  const lines = text.split('\n');
  const title = lines[0].replace(/[^\w\s€%·:→←↑↓+\-.,!?()]/g, '').trim().slice(0, 100);
  const body = lines.slice(1).join('\n').slice(0, 200);
  supabase.from('notifications').insert({
    type, title, body: text, read: false, user_id: userId
  }).then(() => {}).catch(() => {});
  const pushPayload = { title: title || 'EdgePickr', body: body || 'Nieuwe update', tag: type, url: '/' };
  const pushPromise = userId ? sendPushToUser(userId, pushPayload) : sendPushToAll(pushPayload);
  pushPromise.catch(() => {});
};
// v11.3.22 Phase 6.4: updateCalibration + revertCalibration verhuisd naar
// lib/learning-loop.js. Mount HIER (na notify-declaratie) want factory
// dep-validation throws op undefined notify in TDZ.
const createLearningLoop = require('./lib/learning-loop');
const learningLoop = createLearningLoop({
  loadCalib, saveCalib, getUsersCache, notify, getUserMoneySettings,
  // v12.1.0: filter learning-data op preferred bookies. Bets op niet-actieve
  // bookies (bv. niet-legaal in NL) vervuilen calibratie voor markten die
  // operator nooit speelt. Door preferred-check te injecteren wordt de learning-
  // loop operator-bookie-aware.
  getPreferredBookies,
});
const updateCalibration = learningLoop.updateCalibration;
const revertCalibration = learningLoop.revertCalibration;


// Log een gefaalde pre-match/CLV check naar de notifications tabel,
// zodat de user het in de 🔔 dropdown ziet.
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
// v10.12.23 Phase C.10 live-wiring: drawdown is nu onderdeel van de unified
// stake-regime engine (`_currentStakeRegime.kellyFraction` bevat al de
// drawdown-dempt kelly). Deze functie returnt voortaan 1.0 zodat `hkRaw = k
// * kelly * drawdownMultiplier * auditDampen` geen double-damping geeft.
//
// De oude heuristieken (>20% P/L loss, <30% win rate, 5-L streak in 3 days)
// zijn VERPLAATST naar `lib/stake-regime.js` als `drawdown_hard` /
// `drawdown_soft` / `consecutive_l` regimes, met strengere thresholds op
// relative-peak-drawdown ipv absolute-start-loss (eerlijker als bankroll is
// gegroeid) en incorporerend met CLV/ROI in één besluit.
function getDrawdownMultiplier() {
  return 1.0;
}

function buildPickFactory(MIN_ODDS = 1.60, calibEpBuckets = {}, sport = 'football') {
  // v10.12.8: execution-gate draait nu als post-scan pass
  // (lib/runtime/scan-gate.js). buildPickFactory blijft daarom lean en
  // aan mkP-kant: fixtureMeta wordt alleen doorgegeven + opgeslagen op de
  // pick. Geen resolveExecutionMetrics meer hier.
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
  // v10.12.14 Phase D.13: ook een recente-matches cache voor congestion signal.
  if (!afCache.recentMatches) afCache.recentMatches = {};
  if (!afCache.recentMatches[sport]) afCache.recentMatches[sport] = {};

  const cached = afCache.lastPlayed[sport][teamId];
  if (cached !== undefined) return cached; // null ook geldig (= niet gevonden)
  try {
    const path = cfg.host.includes('football') ? '/fixtures' : '/games';
    // v10.12.14: fetch last=3 zodat we congestion-density kunnen berekenen.
    // Zelfde API-call kost als last=1 (1 API-call, meer rows terug).
    const rows = await afGet(cfg.host, path, { team: teamId, last: 3 });
    let dateStr = null;
    const recentDates = [];
    for (const row of (rows || [])) {
      const d = row.fixture?.date || row.date || row.timestamp || null;
      if (d) recentDates.push(d);
    }
    if (recentDates.length) dateStr = recentDates[0];
    // Cache ook null zodat we niet nogmaals fetchen voor onbekende team.
    afCache.lastPlayed[sport][teamId] = dateStr;
    afCache.recentMatches[sport][teamId] = recentDates;
    await sleep(80);
    return dateStr;
  } catch (e) {
    console.warn(`fetchLastPlayedDate failed voor ${sport}/${teamId}:`, e.message);
    afCache.lastPlayed[sport][teamId] = null;
    afCache.recentMatches[sport][teamId] = [];
    return null;
  }
}

// v10.12.14 Phase D.13: read-helper voor recente wedstrijden.
function getRecentMatchDates(sport, teamId) {
  if (!afCache.recentMatches || !afCache.recentMatches[sport]) return [];
  return afCache.recentMatches[sport][teamId] || [];
}

// v10.12.14 Phase D.13: fixture-congestion. Telt matches in de laatste N dagen
// vóór kickoff. Pure helper — testbaar zonder API-calls.
function computeFixtureCongestion(recentDates, kickoffMs, windowDays = 7) {
  if (!Array.isArray(recentDates) || recentDates.length === 0 || !Number.isFinite(kickoffMs)) {
    return { count: 0, congested: false, densityDays: null };
  }
  const msPerDay = 86400000;
  const cutoff = kickoffMs - windowDays * msPerDay;
  let count = 0;
  let earliestMs = null;
  for (const d of recentDates) {
    const ms = Date.parse(d);
    if (!Number.isFinite(ms) || ms > kickoffMs) continue;
    if (ms >= cutoff) count++;
    if (earliestMs === null || ms < earliestMs) earliestMs = ms;
  }
  const densityDays = earliestMs !== null ? +((kickoffMs - earliestMs) / msPerDay).toFixed(1) : null;
  // Congested: ≥ 3 matches in the last N days. Doctrine §10.B "fixture congestion" proxy.
  const congested = count >= 3;
  return { count, congested, densityDays };
}

// Bereken rest-days + maak signal/note.
// Thresholds per sport:
//   NBA/NHL: <2 dagen = tired (back-to-back)
//   MLB:     <1 dag = tired (uncommon, usually off-days)
//   NFL:     <4 dagen = short week
//   Football:<3 dagen = midweek after CL/EL
function buildRestDaysInfo(sport, kickoffMs, homeLastDate, awayLastDate, opts = {}) {
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

  // v10.12.14 Phase D.13: fixture-congestion signaal. Ships in shadow mode
  // (value=0%, weight=0). Auto-promote via autoTuneSignalsByClv zodra n≥50
  // picks met positieve CLV én BH-FDR pass (v10.12.11).
  // Rules:
  //   - home ≥3 matches in last 7d → fixture_congestion_home_tired
  //   - away ≥3 matches in last 7d → fixture_congestion_away_tired
  //   - Eén van de teams congested én de ander niet → mismatch advantage
  //     voor de NIET-congested team.
  let homeCong = { count: 0, congested: false, densityDays: null };
  let awayCong = { count: 0, congested: false, densityDays: null };
  if (Array.isArray(opts.homeRecentDates)) {
    homeCong = computeFixtureCongestion(opts.homeRecentDates, kickoffMs, 7);
  }
  if (Array.isArray(opts.awayRecentDates)) {
    awayCong = computeFixtureCongestion(opts.awayRecentDates, kickoffMs, 7);
  }
  if (homeCong.congested) signals.push('fixture_congestion_home_tired:0%');
  if (awayCong.congested) signals.push('fixture_congestion_away_tired:0%');
  if (homeCong.congested && !awayCong.congested) signals.push('congestion_mismatch_away_advantage:0%');
  if (awayCong.congested && !homeCong.congested) signals.push('congestion_mismatch_home_advantage:0%');

  // Menselijke note
  let note = '';
  if (hmDays !== null && awDays !== null) {
    const hmStr = hmDays < 1 ? `${(hmDays*24).toFixed(0)}u` : `${Math.round(hmDays)}d`;
    const awStr = awDays < 1 ? `${(awDays*24).toFixed(0)}u` : `${Math.round(awDays)}d`;
    if (homeTired || awayTired || Math.abs(hmDays - awDays) >= 2) {
      note = ` | 🛌 rust: thuis ${hmStr} / uit ${awStr}`;
    }
  }
  if (homeCong.congested || awayCong.congested) {
    const hmC = homeCong.congested ? `${homeCong.count}🔥` : `${homeCong.count}`;
    const awC = awayCong.congested ? `${awayCong.count}🔥` : `${awayCong.count}`;
    note += ` | 📅 congestion 7d: thuis ${hmC} / uit ${awC}`;
  }
  return { hmDays, awDays, homeTired, awayTired, signals, note, homeCongested: homeCong.congested, awayCongested: awayCong.congested, homeCongestionCount: homeCong.count, awayCongestionCount: awayCong.count };
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
  const { picks, combiPool, mkP, dropReasons } = buildPickFactory(1.60, calib.epBuckets || {}, 'basketball');
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
            const agg = require('./lib/integrations/data-aggregator');
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

        // v12.1.8: maxPrice cap voorkomt dat een longshot-quote van een
        // nieuwe preferred-bookie (bv. 888sport @ 5.0) de dedupe-winnaar wordt
        // terwijl Bet365 @ 2.50 binnen cap had gepast. Pick valt dan niet meer
        // weg op de post-check <= MAX_WINNER_ODDS.
        const bH = bestFromArr(homeOdds, { maxPrice: MAX_WINNER_ODDS });
        const bA = bestFromArr(awayOdds, { maxPrice: MAX_WINNER_ODDS });

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

        // v10.12.8 Phase A.1b basketball: ML is 2-way (geen draw)
        const fxMetaBbH = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'home', line: null };
        const fxMetaBbA = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'away', line: null };
        // v11.1.2: sanity-gate tegen signal-pushed adjHome/adjAway die ver
        // van market-consensus afligt. Zelfde patroon als hockey ML.
        const bbMlGate = passesDivergence2Way(adjHome, adjAway, bH.price, bA.price);
        // Moneyline picks
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && bbMlGate.passA)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals, null, fxMetaBbH);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && bbMlGate.passB)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals, null, fxMetaBbA);

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
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.01);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.01);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;
              // v11.2.1: safety-gate ook op pure devig O/U (model=market by construction
              // maar guard beschermt tegen outlier-pool skew bij ≥2 bookies). fxMeta added.
              const ouGate = passesDivergence2Way(overP, 1-overP, bestOv.price, bestUn.price);
              const fxMetaOvBb = { fixtureId: gameId, marketType: 'total', selectionKey: 'over', line };
              const fxMetaUnBb = { fixtureId: gameId, marketType: 'total', selectionKey: 'under', line };

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60 && ouGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🏀 Over ${line} pts`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals, null, fxMetaOvBb);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60 && ouGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} pts`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals, null, fxMetaUnBb);
              // v12.2.37: NBA O/U → v2.
              if (_currentModelVersionId) {
                snap.recordTotalsEvaluation({
                  supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                  marketType: 'total', line,
                  pOver: overP, pUnder: 1 - overP,
                  bestOv, bestUn, ovEdge: overEdge, unEdge: underEdge, minEdge: MIN_EDGE,
                  matchSignals, debug: { sport: 'basketball' },
                }).catch(() => {});
              }
            }
          }
        }

        // Spread (NBA, variabele lijnen) — per-point devigged consensus voor eerlijke cover-prob.
        // v11.1.1: hasDevig-gate + bookie-count ≥ 3 + modelMarketSanityCheck. Voorheen kon
        // een Bet365-only extreme lijn (bv. -12.5) de fallback-prob (fpHome*0.50) raken en
        // dan een synthetische "+50%" edge opleveren. Nu vereisen we paired devig + ≥3
        // bookies + divergence ≤ 4%.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home');
          const awaySpr = parsed.spreads.filter(o => o.side === 'away');
          const { homeFn, awayFn, hasDevig, bookieCountAt } = buildSpreadFairProbFns(homeSpr, awaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(homeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH && hasDevig(bH.point) && bookieCountAt(bH.point) >= 3) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            const fp = homeFn(bH.point);
            const marketProb = 1 / bH.price;
            const sanity = modelMarketSanityCheck(fp, marketProb);
            if (sanity.agree) {
              const fxMeta = { fixtureId: gameId, marketType: 'spread', selectionKey: `home_${bH.point}`, line: bH.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
                `Spread | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
            }
          }
          const bA = bestSpreadPick(awaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA && hasDevig(bA.point) && bookieCountAt(bA.point) >= 3) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            const fp = awayFn(bA.point);
            const marketProb = 1 / bA.price;
            const sanity = modelMarketSanityCheck(fp, marketProb);
            if (sanity.agree) {
              const fxMeta = { fixtureId: gameId, marketType: 'spread', selectionKey: `away_${bA.point}`, line: bA.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
                `Spread | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
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
            const h1Ov = h1Over.filter(o => Math.abs(o.point - h1Line) < 0.01);
            const h1Un = h1Under.filter(o => Math.abs(o.point - h1Line) < 0.01);
            if (h1Ov.length && h1Un.length) {
              const h1AvgOvIP = h1Ov.reduce((s,o)=>s+1/o.price,0) / h1Ov.length;
              const h1AvgUnIP = h1Un.reduce((s,o)=>s+1/o.price,0) / h1Un.length;
              const h1TotIP = h1AvgOvIP + h1AvgUnIP;
              const h1OverP = h1TotIP > 0 ? h1AvgOvIP / h1TotIP : 0.5;
              // v12.1.8: maxPrice cap parity met post-check (<= 3.5 voor 1H O/U)
              const h1BestOv = bestFromArr(h1Ov, { maxPrice: 3.5 });
              const h1BestUn = bestFromArr(h1Un, { maxPrice: 3.5 });
              const h1OverEdge = h1OverP * h1BestOv.price - 1;
              const h1UnderEdge = (1-h1OverP) * h1BestUn.price - 1;
              // v11.2.1: safety-gate + fxMeta
              const h1Gate = passesDivergence2Way(h1OverP, 1-h1OverP, h1BestOv.price, h1BestUn.price);
              const fxMetaH1Ov = { fixtureId: gameId, marketType: 'half_total', selectionKey: 'over', line: h1Line };
              const fxMetaH1Un = { fixtureId: gameId, marketType: 'half_total', selectionKey: 'under', line: h1Line };

              if (h1OverEdge >= MIN_EDGE && h1BestOv.price >= 1.60 && h1BestOv.price <= 3.5 && h1Gate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🏀 1H Over ${h1Line} pts`, h1BestOv.price,
                  `1st Half O/U: ${(h1OverP*100).toFixed(1)}% over | ${h1BestOv.bookie}: ${h1BestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(h1OverP*100), h1OverEdge * 0.20, kickoffTime, h1BestOv.bookie, matchSignals, null, fxMetaH1Ov);
              if (h1UnderEdge >= MIN_EDGE && h1BestUn.price >= 1.60 && h1BestUn.price <= 3.5 && h1Gate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 1H Under ${h1Line} pts`, h1BestUn.price,
                  `1st Half O/U: ${((1-h1OverP)*100).toFixed(1)}% under | ${h1BestUn.bookie}: ${h1BestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-h1OverP)*100), h1UnderEdge * 0.18, kickoffTime, h1BestUn.bookie, matchSignals, null, fxMetaH1Un);
            }
          }
        }

        // ── 1st Half Spread (basketball) ──
        // v11.1.1: VOLLEDIGE REWRITE. Vroegere versie gebruikte fpHome (full-game ML 2-way
        // prob, bv. 69%) direct als fair-prob voor 1H handicap — wat systematisch
        // overconfident is bij extreme lijnen die alleen Bet365 aanbiedt (-9.5/-10.5).
        // Operator-report 2026-04-18 image-v11: Denver -9.5 @ 3.45 kreeg 69% model-kans,
        // Edge +85% (pure 158%) = fake edge. Nu: per-point devig (half-game fallback =
        // ML × 0.50) + hasDevig-gate + min 3 bookies + divergence ≤ 4%.
        {
          const h1HomeSpr = parsed.halfSpreads.filter(o => o.side === 'home');
          const h1AwaySpr = parsed.halfSpreads.filter(o => o.side === 'away');
          const { homeFn, awayFn, hasDevig, bookieCountAt } = buildSpreadFairProbFns(h1HomeSpr, h1AwaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(h1HomeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH && hasDevig(bH.point) && bookieCountAt(bH.point) >= 3) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            const fp = homeFn(bH.point);
            const marketProb = 1 / bH.price;
            const sanity = modelMarketSanityCheck(fp, marketProb);
            if (sanity.agree) {
              const fxMeta = { fixtureId: gameId, marketType: 'half_spread', selectionKey: `home_${bH.point}`, line: bH.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${hm} ${pt}`, bH.price,
                `1st Half Spread | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bH.edge * 0.18, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
            }
          }
          const bA = bestSpreadPick(h1AwaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA && hasDevig(bA.point) && bookieCountAt(bA.point) >= 3) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            const fp = awayFn(bA.point);
            const marketProb = 1 / bA.price;
            const sanity = modelMarketSanityCheck(fp, marketProb);
            if (sanity.agree) {
              const fxMeta = { fixtureId: gameId, marketType: 'half_spread', selectionKey: `away_${bA.point}`, line: bA.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${aw} ${pt}`, bA.price,
                `1st Half Spread | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bA.edge * 0.18, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
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

  // v10.12.8 Phase A.1b: post-scan execution-gate pass (basketball ML).
  let gatedPicks = picks;
  try {
    const { applyPostScanGate } = require('./lib/runtime/scan-gate');
    const { kellyToUnits } = require('./lib/model-math');
    const preferredBookies = (getPreferredBookies() && getPreferredBookies().length)
      ? getPreferredBookies() : ['Bet365', 'Unibet'];
    const before = gatedPicks.length;
    const res = await applyPostScanGate(gatedPicks, supabase, {
      preferredBookies,
      scanAnchorMs: Date.now(),
      activeUnitEur: getActiveUnitEur(),
      marketTypes: ['moneyline'],
      kellyToUnits,
    });
    gatedPicks = res.picks;
    if (res.stats.dampened || res.stats.skipped) {
      emit({ log: `🏀 Execution-gate: ${res.stats.dampened} gedempt · ${res.stats.skipped} geskipt (van ${before})` });
    }
  } catch (err) {
    emit({ log: `⚠️ Basketball execution-gate mislukt: ${err.message}` });
  }

  emit({ log: `🏀 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${gatedPicks.length} basketball picks` });
  // v12.2.3: drop-reasons telemetrie. Toont waarom picks niet doorkwamen
  // tijdens generatie (mkP-level filters; execution-gate-drops zijn separate log).
  const _dropFmtNba = formatDropReasons(dropReasons);
  if (_dropFmtNba) emit({ log: `🏀 Drops: ${_dropFmtNba}` });

  // Save scan entry
  if (gatedPicks.length) saveScanEntry(gatedPicks, 'nba', totalEvents);

  return gatedPicks;
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
  const { picks, combiPool, mkP, dropReasons } = buildPickFactory(1.60, calib.epBuckets || {}, 'hockey');
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
            const agg = require('./lib/integrations/data-aggregator');
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
        // v12.1.8: maxPrice cap voorkomt dat hockey ML picks verloren gaan
        // wanneer een nieuwe preferred-bookie een longshot-odd boven
        // MAX_WINNER_ODDS aanbiedt.
        const bH = bestFromArr(homeOddsOT.length ? homeOddsOT : homeOdds, { maxPrice: MAX_WINNER_ODDS });
        const bA = bestFromArr(awayOddsOT.length ? awayOddsOT : awayOdds, { maxPrice: MAX_WINNER_ODDS });

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
          // v10.12.9 Phase A.1b hockey: 2-way ML inc-OT
          const fxMetaHkH = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'home', line: null };
          const fxMetaHkA = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'away', line: null };
          if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS
              && isOTBookieHockey(bH.bookie) && sanityHome.agree) {
            // v12.2.25: explicit (inc-OT) tag op hockey 2-way ML labels.
            // Voorkomt verwarring met 60-min regulation product op andere bookies
            // (bv. Unibet/Toto). Doctrine: nooit mengen — pick-label moet scope tonen.
            mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint (inc-OT)`, bH.price,
              `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | Markt-fair: ${(marketFairIncOT.home*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
              Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, [...matchSignals, 'sanity_ok'], null, fxMetaHkH);
          }
          if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS
              && isOTBookieHockey(bA.bookie) && sanityAway.agree) {
            mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint (inc-OT)`, bA.price,
              `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | Markt-fair: ${(marketFairIncOT.away*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
              Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, [...matchSignals, 'sanity_ok'], null, fxMetaHkA);
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
          // v12.1.8: maxPrice cap parity met post-check (Home/Away ≤ 4.0, Draw ≤ 8.0 voor hockey)
          const bH3 = bestFromArr(h3, { maxPrice: MAX_WINNER_ODDS });
          const bD3 = bestFromArr(d3, { maxPrice: 8.00 });
          const bA3 = bestFromArr(a3, { maxPrice: MAX_WINNER_ODDS });

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
          // v11.3.32 (Codex-finding): NHL TT scope-mismatch. Sommige bookies
          // settelen team-totals op 60-min regular time (geen OT), terwijl onze
          // lambda + Poisson full-game incl OT is (lambda = expHome + 0.023).
          //
          // v12.1.12: scope-based filter ipv puur bookie-blacklist. Sommige
          // bookies (bv. Unibet NL) bieden BEIDE markten aan als aparte entries
          // ("Reguliere Speeltijd" + "Inclusief verlenging"). Blind bookie-blacklist
          // gooide ook de incl-OT variant weg terwijl die wél legitiem matchte
          // met ons model. Fix: (1) scope='regulation' altijd weg, (2) scope=
          // 'incl_ot' altijd houden, (3) scope='unknown' valt terug op bookie-
          // blacklist als vangnet.
          const isTtMatch = (o) =>
            o.scope !== 'regulation' &&
            (o.scope === 'incl_ot' || isOTBookieHockey(o.bookie));
          const homeTT = parsed.teamTotals.filter(o => o.team === 'home' && isTtMatch(o));
          const awayTT = parsed.teamTotals.filter(o => o.team === 'away' && isTtMatch(o));
          const linesHome = [...new Set(homeTT.map(o => o.point))];
          const linesAway = [...new Set(awayTT.map(o => o.point))];

          // v11.3.31 (Codex-finding): Team Totals gebruikt Poisson-based pOver,
          // niet market-devigged. `passesDivergence2Way()` vergelijkt Poisson-prob
          // met devigged-market-prob, wat per definitie methodologisch mismatcht
          // is — Poisson ≠ market-implied. Fix: verwijder gate, behoud:
          //   (a) paired over/under aanwezig (zie !ov.length || !un.length check),
          //   (b) lambda in healthy range (0.5-5.0 goals/game; buiten = data stuk),
          //   (c) price range 1.60-3.5 + edge-min uit MIN_EDGE,
          //   (d) mkP's auditSuspicious-dampen op grote baseline-gaps.
          const ttLambdaOk = (lambda) => Number.isFinite(lambda) && lambda >= 0.5 && lambda <= 5.0;
          for (const line of linesHome) {
            if (!ttLambdaOk(lambdaHome)) continue;
            const ov = homeTT.filter(o => o.side === 'over' && o.point === line);
            const un = homeTT.filter(o => o.side === 'under' && o.point === line);
            if (!ov.length || !un.length) continue;
            // v12.1.8: maxPrice cap parity met post-check (<= 3.5 voor TT O/U)
            const bestOv = bestFromArr(ov, { maxPrice: 3.5 });
            const bestUn = bestFromArr(un, { maxPrice: 3.5 });
            if (bestOv.price <= 0 || bestUn.price <= 0) continue;
            const pOver = poissonOver(lambdaHome, line);
            const pUnder = 1 - pOver;
            const ovEdge = pOver * bestOv.price - 1;
            const unEdge = pUnder * bestUn.price - 1;
            const fxMetaTtH = { fixtureId: gameId, marketType: 'team_total', selectionKey: `home_over_${line}`, line };
            const fxMetaTtU = { fixtureId: gameId, marketType: 'team_total', selectionKey: `home_under_${line}`, line };
            if (ovEdge >= MIN_EDGE && bestOv.price >= 1.60 && bestOv.price <= 3.5) {
              mkP(`${hm} vs ${aw}`, league.name, `📈 ${hm} TT Over ${line}`, bestOv.price,
                `Team Total Home: ${(pOver*100).toFixed(1)}% over ${line} (λ=${lambdaHome.toFixed(2)}) | ${bestOv.bookie}: ${bestOv.price} | ${ko}`,
                Math.round(pOver*100), ovEdge * 0.22, kickoffTime, bestOv.bookie, [...matchSignals, 'team_total_home'], null, fxMetaTtH);
            }
            if (unEdge >= MIN_EDGE && bestUn.price >= 1.60 && bestUn.price <= 3.5) {
              mkP(`${hm} vs ${aw}`, league.name, `📉 ${hm} TT Under ${line}`, bestUn.price,
                `Team Total Home: ${(pUnder*100).toFixed(1)}% under ${line} (λ=${lambdaHome.toFixed(2)}) | ${bestUn.bookie}: ${bestUn.price} | ${ko}`,
                Math.round(pUnder*100), unEdge * 0.22, kickoffTime, bestUn.bookie, [...matchSignals, 'team_total_home'], null, fxMetaTtU);
            }
            // v12.2.32: schrijf TT evaluatie ook naar v2 pick_candidates zodat
            // /admin/v2/scan-by-sport en /admin/v2/model-brier hockey TT mee tellen.
            if (_currentModelVersionId) {
              snap.recordTotalsEvaluation({
                supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                marketType: 'team_total_home', line,
                pOver, pUnder, bestOv, bestUn, ovEdge, unEdge, minEdge: MIN_EDGE,
                matchSignals: [...matchSignals, 'team_total_home'],
                debug: { sport: 'hockey', side: 'home', lambda: lambdaHome },
              }).catch(() => {});
            }
          }
          for (const line of linesAway) {
            if (!ttLambdaOk(lambdaAway)) continue;
            const ov = awayTT.filter(o => o.side === 'over' && o.point === line);
            const un = awayTT.filter(o => o.side === 'under' && o.point === line);
            if (!ov.length || !un.length) continue;
            // v12.1.8: maxPrice cap parity met post-check (<= 3.5 voor TT O/U)
            const bestOv = bestFromArr(ov, { maxPrice: 3.5 });
            const bestUn = bestFromArr(un, { maxPrice: 3.5 });
            if (bestOv.price <= 0 || bestUn.price <= 0) continue;
            const pOver = poissonOver(lambdaAway, line);
            const pUnder = 1 - pOver;
            const ovEdge = pOver * bestOv.price - 1;
            const unEdge = pUnder * bestUn.price - 1;
            const fxMetaTtH = { fixtureId: gameId, marketType: 'team_total', selectionKey: `away_over_${line}`, line };
            const fxMetaTtU = { fixtureId: gameId, marketType: 'team_total', selectionKey: `away_under_${line}`, line };
            if (ovEdge >= MIN_EDGE && bestOv.price >= 1.60 && bestOv.price <= 3.5) {
              mkP(`${hm} vs ${aw}`, league.name, `📈 ${aw} TT Over ${line}`, bestOv.price,
                `Team Total Away: ${(pOver*100).toFixed(1)}% over ${line} (λ=${lambdaAway.toFixed(2)}) | ${bestOv.bookie}: ${bestOv.price} | ${ko}`,
                Math.round(pOver*100), ovEdge * 0.22, kickoffTime, bestOv.bookie, [...matchSignals, 'team_total_away'], null, fxMetaTtH);
            }
            if (unEdge >= MIN_EDGE && bestUn.price >= 1.60 && bestUn.price <= 3.5) {
              mkP(`${hm} vs ${aw}`, league.name, `📉 ${aw} TT Under ${line}`, bestUn.price,
                `Team Total Away: ${(pUnder*100).toFixed(1)}% under ${line} (λ=${lambdaAway.toFixed(2)}) | ${bestUn.bookie}: ${bestUn.price} | ${ko}`,
                Math.round(pUnder*100), unEdge * 0.22, kickoffTime, bestUn.bookie, [...matchSignals, 'team_total_away'], null, fxMetaTtU);
            }
            // v12.2.32: TT evaluatie naar v2.
            if (_currentModelVersionId) {
              snap.recordTotalsEvaluation({
                supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                marketType: 'team_total_away', line,
                pOver, pUnder, bestOv, bestUn, ovEdge, unEdge, minEdge: MIN_EDGE,
                matchSignals: [...matchSignals, 'team_total_away'],
                debug: { sport: 'hockey', side: 'away', lambda: lambdaAway },
              }).catch(() => {});
            }
          }
        }

        // Over/Under total goals
        // v12.0.0 (Codex P0.3): hockey totals settlement-scope. Parser markeert
        // regulation/incl_ot/unknown. Sluit expliciet 'regulation' uit want onze
        // lambda + Poisson is full-game. Plus bookie-blacklist want unknown-label
        // bij 60-min-only bookies is feitelijk regulation.
        const scopeOkHkTotal = o => o.scope !== 'regulation' && isOTBookieHockey(o.bookie);
        const overOdds = parsed.totals.filter(o => o.side === 'over' && scopeOkHkTotal(o));
        const underOdds = parsed.totals.filter(o => o.side === 'under' && scopeOkHkTotal(o));
        if (overOdds.length && underOdds.length) {
          const pointCounts = {};
          for (const o of [...overOdds, ...underOdds]) {
            pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          }
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.01);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.01);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;
              // v11.2.1: safety-gate + fxMeta
              const hkOuGate = passesDivergence2Way(overP, 1-overP, bestOv.price, bestUn.price);
              const fxMetaHkOv = { fixtureId: gameId, marketType: 'total', selectionKey: 'over', line };
              const fxMetaHkUn = { fixtureId: gameId, marketType: 'total', selectionKey: 'under', line };

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60 && hkOuGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🏒 Over ${line} goals`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals, null, fxMetaHkOv);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60 && hkOuGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} goals`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals, null, fxMetaHkUn);
              // v12.2.33: hockey main O/U → v2 pick_candidates.
              if (_currentModelVersionId) {
                snap.recordTotalsEvaluation({
                  supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                  marketType: 'total', line,
                  pOver: overP, pUnder: 1 - overP,
                  bestOv, bestUn, ovEdge: overEdge, unEdge: underEdge, minEdge: MIN_EDGE,
                  matchSignals, debug: { sport: 'hockey' },
                }).catch(() => {});
              }
            }
          }
        }

        // Puck line (spread) — NHL standard is ±1.5. v11.1.2: vereisen nu
        // paired devig (≥3 bookies per zijde) ÉN sanity check. Fallback naar
        // fpHome × 0.55 werkt alleen wanneer we geen consensus hebben; in dat
        // geval skippen we de pick (liever geen pick dan fake edge).
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home' && Math.abs(o.point) === 1.5);
          const awaySpr = parsed.spreads.filter(o => o.side === 'away' && Math.abs(o.point) === 1.5);
          const home15 = homeSpr.filter(s => s.point === -1.5);
          const away15 = awaySpr.filter(s => s.point === 1.5);
          let fpHomePuck = null, fpAwayPuck = null;
          if (home15.length >= 3 && away15.length >= 3) {
            const avgH = home15.reduce((s,o)=>s+1/o.price, 0) / home15.length;
            const avgA = away15.reduce((s,o)=>s+1/o.price, 0) / away15.length;
            const tot = avgH + avgA;
            if (tot > 1.00 && tot < 1.15) {
              fpHomePuck = avgH / tot;
              fpAwayPuck = avgA / tot;
            }
          }
          if (fpHomePuck != null && fpAwayPuck != null) {
            const bH = bestSpreadPick(homeSpr, fpHomePuck, MIN_EDGE + 0.01);
            if (bH) {
              const sanity = modelMarketSanityCheck(fpHomePuck, 1 / bH.price);
              if (sanity.agree) {
                const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
                const fxMeta = { fixtureId: gameId, marketType: 'puck_line', selectionKey: `home_${bH.point}`, line: bH.point };
                mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
                  `Puck Line | ${bH.bookie}: ${bH.price} · cover ${(fpHomePuck*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                  Math.round(fpHomePuck*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
              }
            }
            const bA = bestSpreadPick(awaySpr, fpAwayPuck, MIN_EDGE + 0.01);
            if (bA) {
              const sanity = modelMarketSanityCheck(fpAwayPuck, 1 / bA.price);
              if (sanity.agree) {
                const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
                const fxMeta = { fixtureId: gameId, marketType: 'puck_line', selectionKey: `away_${bA.point}`, line: bA.point };
                mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
                  `Puck Line | ${bA.bookie}: ${bA.price} · cover ${(fpAwayPuck*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                  Math.round(fpAwayPuck*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
              }
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
            const p1Ov = p1Over.filter(o => Math.abs(o.point - p1Line) < 0.01);
            const p1Un = p1Under.filter(o => Math.abs(o.point - p1Line) < 0.01);
            if (p1Ov.length && p1Un.length) {
              const p1AvgOvIP = p1Ov.reduce((s,o)=>s+1/o.price,0) / p1Ov.length;
              const p1AvgUnIP = p1Un.reduce((s,o)=>s+1/o.price,0) / p1Un.length;
              const p1TotIP = p1AvgOvIP + p1AvgUnIP;
              const p1OverP = p1TotIP > 0 ? p1AvgOvIP / p1TotIP : 0.5;
              // v12.1.8: maxPrice cap parity met post-check (<= 3.5 voor P1 O/U)
              const p1BestOv = bestFromArr(p1Ov, { maxPrice: 3.5 });
              const p1BestUn = bestFromArr(p1Un, { maxPrice: 3.5 });
              const p1OverEdge = p1OverP * p1BestOv.price - 1;
              const p1UnderEdge = (1-p1OverP) * p1BestUn.price - 1;
              // v11.2.1: safety-gate + fxMeta
              const p1Gate = passesDivergence2Way(p1OverP, 1-p1OverP, p1BestOv.price, p1BestUn.price);
              const fxMetaP1Ov = { fixtureId: gameId, marketType: 'period_total', selectionKey: 'over', line: p1Line };
              const fxMetaP1Un = { fixtureId: gameId, marketType: 'period_total', selectionKey: 'under', line: p1Line };

              if (p1OverEdge >= MIN_EDGE && p1BestOv.price >= 1.60 && p1BestOv.price <= 3.5 && p1Gate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🏒 P1 Over ${p1Line} goals`, p1BestOv.price,
                  `1st Period O/U: ${(p1OverP*100).toFixed(1)}% over | ${p1BestOv.bookie}: ${p1BestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(p1OverP*100), p1OverEdge * 0.20, kickoffTime, p1BestOv.bookie, matchSignals, null, fxMetaP1Ov);
              if (p1UnderEdge >= MIN_EDGE && p1BestUn.price >= 1.60 && p1BestUn.price <= 3.5 && p1Gate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 P1 Under ${p1Line} goals`, p1BestUn.price,
                  `1st Period O/U: ${((1-p1OverP)*100).toFixed(1)}% under | ${p1BestUn.bookie}: ${p1BestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-p1OverP)*100), p1UnderEdge * 0.18, kickoffTime, p1BestUn.bookie, matchSignals, null, fxMetaP1Un);
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
          // v11.2.1: vereist ≥3 bookies per zijde zodat pure consensus-devig stabiel is.
          if (oddOdds.length >= 3 && evenOdds.length >= 3) {
            const bestOdd = bestFromArr(oddOdds);
            const bestEven = bestFromArr(evenOdds);
            const avgOddIP = oddOdds.reduce((s,o)=>s+1/o.price,0) / oddOdds.length;
            const avgEvenIP = evenOdds.reduce((s,o)=>s+1/o.price,0) / evenOdds.length;
            const oeTotal = avgOddIP + avgEvenIP;
            const oddP = oeTotal > 0 ? avgOddIP / oeTotal : 0.5;
            const oddEdge = oddP * bestOdd.price - 1;
            const evenEdge = (1-oddP) * bestEven.price - 1;
            const oeGate = passesDivergence2Way(oddP, 1-oddP, bestOdd.price, bestEven.price);

            if (oddEdge >= MIN_EDGE && bestOdd.price >= 1.60 && oeGate.passA)
              mkP(`${hm} vs ${aw}`, league.name, `🎲 Odd Total`, bestOdd.price,
                `Odd/Even: ${(oddP*100).toFixed(1)}% odd | ${bestOdd.bookie}: ${bestOdd.price}${sharedNotes} | ${ko}`,
                Math.round(oddP*100), oddEdge * 0.16, kickoffTime, bestOdd.bookie, matchSignals);
            if (evenEdge >= MIN_EDGE && bestEven.price >= 1.60 && oeGate.passB)
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

  // v12.1.7: Strength-filter parity met voetbal. Voorheen sloeg hockey de
  // MIN_CONFIDENCE-check over, waardoor TT-picks altijd doorkwamen terwijl
  // voetbal 1x2-picks op strength >= 0.015 gedropt werden. Nu moeten hockey
  // picks (ML én TT) dezelfde drempel halen — voorkomt TT-monopoli wanneer
  // model zwakke TT-edges niet anders van sterke picks onderscheidt.
  const HOCKEY_MIN_CONFIDENCE = 0.015;
  const rawHockeyCount = picks.length;
  const filteredHockeyPicks = picks.filter(p => p.strength >= HOCKEY_MIN_CONFIDENCE);
  if (rawHockeyCount > filteredHockeyPicks.length) {
    emit({ log: `🏒 Confidence-filter: ${rawHockeyCount - filteredHockeyPicks.length} van ${rawHockeyCount} hockey picks < 0.015 strength` });
  }

  // v10.12.9 Phase A.1b: post-scan execution-gate pass (hockey ML)
  let gatedHockeyPicks = filteredHockeyPicks;
  try {
    const { applyPostScanGate } = require('./lib/runtime/scan-gate');
    const { kellyToUnits } = require('./lib/model-math');
    const preferredBookies = (getPreferredBookies() && getPreferredBookies().length)
      ? getPreferredBookies() : ['Bet365', 'Unibet'];
    const before = gatedHockeyPicks.length;
    const res = await applyPostScanGate(gatedHockeyPicks, supabase, {
      preferredBookies, scanAnchorMs: Date.now(), activeUnitEur: getActiveUnitEur(),
      marketTypes: ['moneyline'], kellyToUnits,
    });
    gatedHockeyPicks = res.picks;
    if (res.stats.dampened || res.stats.skipped) {
      emit({ log: `🏒 Execution-gate: ${res.stats.dampened} gedempt · ${res.stats.skipped} geskipt (van ${before})` });
    }
  } catch (err) {
    emit({ log: `⚠️ Hockey execution-gate mislukt: ${err.message}` });
  }

  emit({ log: `🏒 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${gatedHockeyPicks.length} hockey picks` });
  // v12.2.3: drop-reasons telemetrie.
  const _dropFmtNhl = formatDropReasons(dropReasons);
  if (_dropFmtNhl) emit({ log: `🏒 Drops: ${_dropFmtNhl}` });

  if (gatedHockeyPicks.length) saveScanEntry(gatedHockeyPicks, 'nhl', totalEvents);

  return gatedHockeyPicks;
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
  const { picks, combiPool, mkP, dropReasons } = buildPickFactory(1.60, calib.epBuckets || {}, 'baseball');
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
            const agg = require('./lib/integrations/data-aggregator');
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

        // v12.1.8: maxPrice cap voorkomt dat een longshot-quote van een
        // nieuwe preferred-bookie (bv. 888sport @ 5.0) de dedupe-winnaar wordt
        // terwijl Bet365 @ 2.50 binnen cap had gepast. Pick valt dan niet meer
        // weg op de post-check <= MAX_WINNER_ODDS.
        const bH = bestFromArr(homeOdds, { maxPrice: MAX_WINNER_ODDS });
        const bA = bestFromArr(awayOdds, { maxPrice: MAX_WINNER_ODDS });

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

        // v10.12.9 Phase A.1b baseball: ML 2-way
        const fxMetaMlbH = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'home', line: null };
        const fxMetaMlbA = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'away', line: null };
        // v11.1.2: sanity-gate tegen pitcher/form-signal-pushed adjHome/adjAway.
        const mlbMlGate = passesDivergence2Way(adjHome, adjAway, bH.price, bA.price);
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && mlbMlGate.passA)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals, null, fxMetaMlbH);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && mlbMlGate.passB)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals, null, fxMetaMlbA);

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
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.01);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.01);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = Math.max(0.10, Math.min(0.90, (totIP2 > 0 ? avgOvIP / totIP2 : 0.5) + mlbWeatherAdj));
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;
              // v11.2.1: safety-gate vangt mlbWeatherAdj die overP ver van markt kan trekken + fxMeta
              const mlbOuGate = passesDivergence2Way(overP, 1-overP, bestOv.price, bestUn.price);
              const fxMetaMlbOv = { fixtureId: gameId, marketType: 'total', selectionKey: 'over', line };
              const fxMetaMlbUn = { fixtureId: gameId, marketType: 'total', selectionKey: 'under', line };

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60 && mlbOuGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `⚾ Over ${line} runs`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals, null, fxMetaMlbOv);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60 && mlbOuGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} runs`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals, null, fxMetaMlbUn);
              // v12.2.33: MLB main O/U → v2.
              if (_currentModelVersionId) {
                snap.recordTotalsEvaluation({
                  supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                  marketType: 'total', line,
                  pOver: overP, pUnder: 1 - overP,
                  bestOv, bestUn, ovEdge: overEdge, unEdge: underEdge, minEdge: MIN_EDGE,
                  matchSignals, debug: { sport: 'baseball', weatherAdj: mlbWeatherAdj },
                }).catch(() => {});
              }
            }
          }
        }

        // Run Line (spread) — MLB standard is ±1.5. v11.1.2: vereisen nu ≥3
        // bookies per zijde voor paired devig + sanity check. Fallback fpHome ×
        // 0.55 was bij dunne data-pool bron van fake edges — bij insufficient
        // paired bookies skip nu.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home' && Math.abs(o.point) === 1.5);
          const awaySpr = parsed.spreads.filter(o => o.side === 'away' && Math.abs(o.point) === 1.5);
          const home15 = homeSpr.filter(s => s.point === -1.5);
          const away15 = awaySpr.filter(s => s.point === 1.5);
          let fpHomeSpread = null, fpAwaySpread = null;
          if (home15.length >= 3 && away15.length >= 3) {
            const avgH = home15.reduce((s,o)=>s+1/o.price, 0) / home15.length;
            const avgA = away15.reduce((s,o)=>s+1/o.price, 0) / away15.length;
            const tot = avgH + avgA;
            if (tot > 1.00 && tot < 1.15) {
              fpHomeSpread = avgH / tot;
              fpAwaySpread = avgA / tot;
            }
          }
          if (fpHomeSpread != null && fpAwaySpread != null) {
            const bH = bestSpreadPick(homeSpr, fpHomeSpread, MIN_EDGE + 0.01);
            if (bH) {
              const sanity = modelMarketSanityCheck(fpHomeSpread, 1 / bH.price);
              if (sanity.agree) {
                const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
                const fxMeta = { fixtureId: gameId, marketType: 'run_line', selectionKey: `home_${bH.point}`, line: bH.point };
                mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
                  `Run Line | ${bH.bookie}: ${bH.price} · cover ${(fpHomeSpread*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                  Math.round(fpHomeSpread*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
              }
            }
            const bA = bestSpreadPick(awaySpr, fpAwaySpread, MIN_EDGE + 0.01);
            if (bA) {
              const sanity = modelMarketSanityCheck(fpAwaySpread, 1 / bA.price);
              if (sanity.agree) {
                const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
                const fxMeta = { fixtureId: gameId, marketType: 'run_line', selectionKey: `away_${bA.point}`, line: bA.point };
                mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
                  `Run Line | ${bA.bookie}: ${bA.price} · cover ${(fpAwaySpread*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                  Math.round(fpAwaySpread*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
              }
            }
          }
        }

        // ── NRFI (No Run First Inning) ──
        // Research: NRFI is profitable when both pitchers have low FIP / strong 1st innings
        // We use team form + run differential as proxy for pitching quality
        // v11.2.1: NRFI is pitcher-dominated; zonder valid pitcher-data is de
        // team-runs-per-game proxy te zwak om op in te zetten. Vereis ook ≥3
        // paired bookies zodat consensus-devig niet op thin pool rust.
        const nrfiOdds = parsed.nrfi.filter(o => o.side === 'nrfi');
        const yrfiOdds = parsed.nrfi.filter(o => o.side === 'yrfi');
        if (nrfiOdds.length >= 3 && yrfiOdds.length >= 3 && pitcherSig.valid) {
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

          // v11.1.2: sanity-gate. nrfiP is consensus-devig, nrfiAdj pushes tot ±2%.
          // Deze moet dicht bij market-implied blijven (≤ 4% divergence anders fake edge).
          const nrfiGate = passesDivergence2Way(adjNrfiP, 1 - adjNrfiP, bestNrfi.price, bestYrfi.price);

          // v12.0.0 (Claude P0.3): fxMeta toegevoegd. Zonder fxMeta kon
          // applyPostScanGate deze markten niet koppelen aan line-timeline
          // voor execution-quality checks.
          const fxMetaNrfi = { fixtureId: gameId, marketType: 'nrfi', selectionKey: 'nrfi', line: null };
          const fxMetaYrfi = { fixtureId: gameId, marketType: 'nrfi', selectionKey: 'yrfi', line: null };
          if (nrfiEdge >= MIN_EDGE && bestNrfi.price >= 1.60 && nrfiGate.passA)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ NRFI (No Run 1st Inning)`, bestNrfi.price,
              `NRFI: ${(adjNrfiP*100).toFixed(1)}% | ${bestNrfi.bookie}: ${bestNrfi.price}${sharedNotes} | ${ko}`,
              Math.round(adjNrfiP*100), nrfiEdge * 0.18, kickoffTime, bestNrfi.bookie, matchSignals, null, fxMetaNrfi);
          if (yrfiEdge >= MIN_EDGE && bestYrfi.price >= 1.60 && nrfiGate.passB)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ YRFI (Yes Run 1st Inning)`, bestYrfi.price,
              `YRFI: ${((1-adjNrfiP)*100).toFixed(1)}% | ${bestYrfi.bookie}: ${bestYrfi.price}${sharedNotes} | ${ko}`,
              Math.round((1-adjNrfiP)*100), yrfiEdge * 0.18, kickoffTime, bestYrfi.bookie, matchSignals, null, fxMetaYrfi);
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
          // v11.2.1: cap lowered van ±0.12 → ±0.06 zodat signal-push niet ruim
          // buiten de passesDivergence2Way 4pp threshold kan drijven. Gaf voorheen
          // 8pp unguarded range. Pitcher x3 blijft gewicht-dominerend binnen cap.
          const f5PitcherAdj = Math.max(-0.06, Math.min(0.06, pitcherSig.adj * 3 * starterReliability.factor));
          const f5Home = Math.min(0.85, Math.max(0.15, fpHome + f5PitcherAdj + ha * 0.7));
          const f5Away = Math.min(0.85, Math.max(0.15, fpAway - f5PitcherAdj * 0.7 - ha * 0.35));

          const f5H = f5ML.filter(o => o.side === 'home');
          const f5A = f5ML.filter(o => o.side === 'away');
          // v12.1.8: F5 ML cap parity met post-check (<= MAX_WINNER_ODDS)
          const bF5H = bestFromArr(f5H, { maxPrice: MAX_WINNER_ODDS });
          const bF5A = bestFromArr(f5A, { maxPrice: MAX_WINNER_ODDS });
          const eF5H = bF5H.price > 0 ? f5Home * bF5H.price - 1 : -1;
          const eF5A = bF5A.price > 0 ? f5Away * bF5A.price - 1 : -1;
          const f5MinEdge = starterReliability.factor < 0.8 ? MIN_EDGE + 0.015 : MIN_EDGE;
          // v10.10.17: F5 ML preferred-coverage diagnostiek
          const f5HDiag = diagBestPrice('F5-ML home', bF5H, f5Home, f5MinEdge);
          const f5ADiag = diagBestPrice('F5-ML away', bF5A, f5Away, f5MinEdge);
          if (f5HDiag) f5Diag.push(f5HDiag);
          if (f5ADiag) f5Diag.push(f5ADiag);

          // v11.1.2: sanity-gate op F5 ML. f5Home gebruikt pitcher × 3 signal,
          // kan daardoor ver van market-implied drijven bij dubieus pitcher-data.
          const f5MlGate = passesDivergence2Way(f5Home, f5Away, bF5H.price, bF5A.price);

          // v12.0.0 (Claude P0.3): fxMeta + P1.5 pitcher reliability nu
          // expliciet vereist (voorheen alleen MIN_EDGE + 0.015 bonus).
          const fxMetaF5H = { fixtureId: gameId, marketType: 'f5_ml', selectionKey: 'home', line: null };
          const fxMetaF5A = { fixtureId: gameId, marketType: 'f5_ml', selectionKey: 'away', line: null };
          if (eF5H >= f5MinEdge && bF5H.price >= 1.60 && bF5H.price <= MAX_WINNER_ODDS && f5MlGate.passA)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 ${hm}`, bF5H.price,
              `F5 (1st 5 inn): ${(f5Home*100).toFixed(1)}% | ${bF5H.bookie}: ${bF5H.price} | ${pitcherSig.note} · ${starterReliability.note} | ${ko}`,
              Math.round(f5Home*100), eF5H * 0.24, kickoffTime, bF5H.bookie, [...matchSignals, 'f5_ml', 'pitcher_3x'], null, fxMetaF5H);
          if (eF5A >= f5MinEdge && bF5A.price >= 1.60 && bF5A.price <= MAX_WINNER_ODDS && f5MlGate.passB)
            mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 ${aw}`, bF5A.price,
              `F5 (1st 5 inn): ${(f5Away*100).toFixed(1)}% | ${bF5A.bookie}: ${bF5A.price} | ${pitcherSig.note} · ${starterReliability.note} | ${ko}`,
              Math.round(f5Away*100), eF5A * 0.24, kickoffTime, bF5A.bookie, [...matchSignals, 'f5_ml', 'pitcher_3x'], null, fxMetaF5A);
        }

        // F5 Totals (consensus-driven — market weet beter dan wij)
        if (f5Totals.length) {
          const pointCounts = {};
          for (const o of f5Totals) pointCounts[o.point] = (pointCounts[o.point] || 0) + 1;
          const mainLine = Object.entries(pointCounts).sort((a,b)=>b[1]-a[1])[0]?.[0];
          if (mainLine) {
            const line = parseFloat(mainLine);
            const ov = f5Totals.filter(o => o.side === 'over' && Math.abs(o.point - line) < 0.01);
            const un = f5Totals.filter(o => o.side === 'under' && Math.abs(o.point - line) < 0.01);
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
              // v11.2.1: pitcherUnderBias kan adjOverP trekken; gate tegen markt-consensus
              const f5OuGate = passesDivergence2Way(adjOverP, 1-adjOverP, bestOv.price, bestUn.price);

              // v12.0.0 (Claude P0.3): fxMeta voor F5 totals
              const fxMetaF5Ov = { fixtureId: gameId, marketType: 'f5_total', selectionKey: 'over', line };
              const fxMetaF5Un = { fixtureId: gameId, marketType: 'f5_total', selectionKey: 'under', line };
              if (eOv >= MIN_EDGE && bestOv.price >= 1.60 && f5OuGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 Over ${line}`, bestOv.price,
                  `F5 Total: ${(adjOverP*100).toFixed(1)}% over ${line} | ${bestOv.bookie}: ${bestOv.price} | ${ko}`,
                  Math.round(adjOverP*100), eOv * 0.20, kickoffTime, bestOv.bookie, [...matchSignals, 'f5_total'], null, fxMetaF5Ov);
              if (eUn >= MIN_EDGE && bestUn.price >= 1.60 && f5OuGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `⚾ F5 Under ${line}`, bestUn.price,
                  `F5 Total: ${((1-adjOverP)*100).toFixed(1)}% under ${line} | ${bestUn.bookie}: ${bestUn.price} | ${ko}`,
                  Math.round((1-adjOverP)*100), eUn * 0.20, kickoffTime, bestUn.bookie, [...matchSignals, 'f5_total'], null, fxMetaF5Un);
              // v12.2.33: F5 totals → v2.
              if (_currentModelVersionId) {
                snap.recordTotalsEvaluation({
                  supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                  marketType: 'f5_total', line,
                  pOver: adjOverP, pUnder: 1 - adjOverP,
                  bestOv, bestUn, ovEdge: eOv, unEdge: eUn, minEdge: MIN_EDGE,
                  matchSignals: [...matchSignals, 'f5_total'],
                  debug: { sport: 'baseball' },
                }).catch(() => {});
              }
            }
          }
        }

        // v10.10.17 / v10.12.13 fix: per-match F5 diagnostiek in scan-output.
        // Voorheen stond dit BUITEN de game-loop → f5Diag out-of-scope →
        // runtime `ReferenceError: f5Diag is not defined` die MLB + KBO
        // scans afbrak. Nu correct binnen de game-loop body.
        if (f5Diag.length) emit({ log: `  └─ F5 ${hm} vs ${aw}: ${f5Diag.slice(0, 3).join(' · ')}` });
      }
      await sleep(200);
    } catch (err) {
      emit({ log: `⚠️ ⚾ ${league.name}: ${err.message}` });
    }
  }

  // Tag picks
  for (const p of picks)     { p.scanType = 'mlb'; p.sport = 'baseball'; }
  for (const p of combiPool) { p.scanType = 'mlb'; p.sport = 'baseball'; }

  // v10.12.9 Phase A.1b: baseball execution-gate post-process
  let gatedMlbPicks = picks;
  try {
    const { applyPostScanGate } = require('./lib/runtime/scan-gate');
    const { kellyToUnits } = require('./lib/model-math');
    const preferredBookies = (getPreferredBookies() && getPreferredBookies().length)
      ? getPreferredBookies() : ['Bet365', 'Unibet'];
    const before = gatedMlbPicks.length;
    const res = await applyPostScanGate(gatedMlbPicks, supabase, {
      preferredBookies, scanAnchorMs: Date.now(), activeUnitEur: getActiveUnitEur(),
      marketTypes: ['moneyline'], kellyToUnits,
    });
    gatedMlbPicks = res.picks;
    if (res.stats.dampened || res.stats.skipped) {
      emit({ log: `⚾ Execution-gate: ${res.stats.dampened} gedempt · ${res.stats.skipped} geskipt (van ${before})` });
    }
  } catch (err) {
    emit({ log: `⚠️ Baseball execution-gate mislukt: ${err.message}` });
  }

  emit({ log: `⚾ ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${gatedMlbPicks.length} baseball picks` });
  // v12.2.3: drop-reasons telemetrie.
  const _dropFmtMlb = formatDropReasons(dropReasons);
  if (_dropFmtMlb) emit({ log: `⚾ Drops: ${_dropFmtMlb}` });

  if (gatedMlbPicks.length) saveScanEntry(gatedMlbPicks, 'mlb', totalEvents);

  return gatedMlbPicks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// NFL SCANNER · api-sports.io american-football
// ═══════════════════════════════════════════════════════════════════════════════

async function runFootballUS(emit) {
  if (!AF_KEY) { emit({ log: '🏈 NFL: geen API key' }); return []; }
  emit({ log: `🏈 NFL scan · ${NFL_LEAGUES.length} competities` });

  const calib = loadCalib();
  const { picks, combiPool, mkP, dropReasons } = buildPickFactory(1.60, calib.epBuckets || {}, 'american-football');
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

        // v12.1.8: maxPrice cap voorkomt dat een longshot-quote van een
        // nieuwe preferred-bookie (bv. 888sport @ 5.0) de dedupe-winnaar wordt
        // terwijl Bet365 @ 2.50 binnen cap had gepast. Pick valt dan niet meer
        // weg op de post-check <= MAX_WINNER_ODDS.
        const bH = bestFromArr(homeOdds, { maxPrice: MAX_WINNER_ODDS });
        const bA = bestFromArr(awayOdds, { maxPrice: MAX_WINNER_ODDS });

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

        // v10.12.9 Phase A.1b NFL: ML 2-way
        const fxMetaNflH = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'home', line: null };
        const fxMetaNflA = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'away', line: null };
        // v11.1.2: sanity-gate voor NFL ML (signal-adjusted adjHome/adjAway).
        const nflMlGate = passesDivergence2Way(adjHome, adjAway, bH.price, bA.price);
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && nflMlGate.passA)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals, null, fxMetaNflH);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && nflMlGate.passB)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals, null, fxMetaNflA);

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
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.01);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.01);
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
              // v11.2.1: gate vangt weather-adj die overP ver van markt drijft + fxMeta
              const nflOuGate = passesDivergence2Way(overP, 1-overP, bestOv.price, bestUn.price);
              const fxMetaNflOv = { fixtureId: gameId, marketType: 'total', selectionKey: 'over', line };
              const fxMetaNflUn = { fixtureId: gameId, marketType: 'total', selectionKey: 'under', line };

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60 && nflOuGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🏈 Over ${line} pts`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals, null, fxMetaNflOv);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60 && nflOuGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} pts`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals, null, fxMetaNflUn);
              // v12.2.37: NFL O/U → v2.
              if (_currentModelVersionId) {
                snap.recordTotalsEvaluation({
                  supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                  marketType: 'total', line,
                  pOver: overP, pUnder: 1 - overP,
                  bestOv, bestUn, ovEdge: overEdge, unEdge: underEdge, minEdge: MIN_EDGE,
                  matchSignals, debug: { sport: 'american-football' },
                }).catch(() => {});
              }
            }
          }
        }

        // Spread (NFL, variabele lijnen) — v11.2.1 hardened: hasDevig + bookie-count
        // ≥ 3 + modelMarketSanityCheck + fxMeta. Was UNCHECKED in v11.1.1 (alleen
        // 1H kreeg fix). Zelfde fake-edge risico op extreme single-bookie lijnen.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home');
          const awaySpr = parsed.spreads.filter(o => o.side === 'away');
          const { homeFn, awayFn, hasDevig, bookieCountAt } = buildSpreadFairProbFns(homeSpr, awaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(homeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH && hasDevig(bH.point) && bookieCountAt(bH.point) >= 3) {
            const fp = homeFn(bH.point);
            const sanity = modelMarketSanityCheck(fp, 1 / bH.price);
            if (sanity.agree) {
              const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
              const fxMeta = { fixtureId: gameId, marketType: 'spread', selectionKey: `home_${bH.point}`, line: bH.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
                `Spread | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
            }
          }
          const bA = bestSpreadPick(awaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA && hasDevig(bA.point) && bookieCountAt(bA.point) >= 3) {
            const fp = awayFn(bA.point);
            const sanity = modelMarketSanityCheck(fp, 1 / bA.price);
            if (sanity.agree) {
              const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
              const fxMeta = { fixtureId: gameId, marketType: 'spread', selectionKey: `away_${bA.point}`, line: bA.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
                `Spread | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
            }
          }
        }

        // ── 1st Half Spread (NFL) ──
        // v11.1.1: zelfde fix als NBA 1H spread. Per-point devig + hasDevig gate +
        // bookie-count ≥ 3 + modelMarketSanityCheck. Voorkomt fake edges op extreme
        // lijnen die alleen 1 bookie aanbiedt.
        {
          const h1HomeSpr = parsed.halfSpreads.filter(o => o.side === 'home');
          const h1AwaySpr = parsed.halfSpreads.filter(o => o.side === 'away');
          const { homeFn, awayFn, hasDevig, bookieCountAt } = buildSpreadFairProbFns(h1HomeSpr, h1AwaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(h1HomeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH && hasDevig(bH.point) && bookieCountAt(bH.point) >= 3) {
            const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
            const fp = homeFn(bH.point);
            const marketProb = 1 / bH.price;
            const sanity = modelMarketSanityCheck(fp, marketProb);
            if (sanity.agree) {
              const fxMeta = { fixtureId: gameId, marketType: 'half_spread', selectionKey: `home_${bH.point}`, line: bH.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${hm} ${pt}`, bH.price,
                `1st Half Spread | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bH.edge * 0.18, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
            }
          }
          const bA = bestSpreadPick(h1AwaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA && hasDevig(bA.point) && bookieCountAt(bA.point) >= 3) {
            const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
            const fp = awayFn(bA.point);
            const marketProb = 1 / bA.price;
            const sanity = modelMarketSanityCheck(fp, marketProb);
            if (sanity.agree) {
              const fxMeta = { fixtureId: gameId, marketType: 'half_spread', selectionKey: `away_${bA.point}`, line: bA.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 1H ${aw} ${pt}`, bA.price,
                `1st Half Spread | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bA.edge * 0.18, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
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
            const h1Ov = h1Over.filter(o => Math.abs(o.point - h1Line) < 0.01);
            const h1Un = h1Under.filter(o => Math.abs(o.point - h1Line) < 0.01);
            if (h1Ov.length && h1Un.length) {
              const h1AvgOvIP = h1Ov.reduce((s,o)=>s+1/o.price,0) / h1Ov.length;
              const h1AvgUnIP = h1Un.reduce((s,o)=>s+1/o.price,0) / h1Un.length;
              const h1TotIP = h1AvgOvIP + h1AvgUnIP;
              const h1OverP = h1TotIP > 0 ? h1AvgOvIP / h1TotIP : 0.5;
              // v12.1.8: maxPrice cap parity met post-check (<= 3.5 voor 1H O/U)
              const h1BestOv = bestFromArr(h1Ov, { maxPrice: 3.5 });
              const h1BestUn = bestFromArr(h1Un, { maxPrice: 3.5 });
              const h1OverEdge = h1OverP * h1BestOv.price - 1;
              const h1UnderEdge = (1-h1OverP) * h1BestUn.price - 1;
              // v11.2.1: safety-gate + fxMeta
              const h1NflGate = passesDivergence2Way(h1OverP, 1-h1OverP, h1BestOv.price, h1BestUn.price);
              const fxMetaNflH1Ov = { fixtureId: gameId, marketType: 'half_total', selectionKey: 'over', line: h1Line };
              const fxMetaNflH1Un = { fixtureId: gameId, marketType: 'half_total', selectionKey: 'under', line: h1Line };

              if (h1OverEdge >= MIN_EDGE && h1BestOv.price >= 1.60 && h1BestOv.price <= 3.5 && h1NflGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🏈 1H Over ${h1Line} pts`, h1BestOv.price,
                  `1st Half O/U: ${(h1OverP*100).toFixed(1)}% over | ${h1BestOv.bookie}: ${h1BestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(h1OverP*100), h1OverEdge * 0.20, kickoffTime, h1BestOv.bookie, matchSignals, null, fxMetaNflH1Ov);
              if (h1UnderEdge >= MIN_EDGE && h1BestUn.price >= 1.60 && h1BestUn.price <= 3.5 && h1NflGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 1H Under ${h1Line} pts`, h1BestUn.price,
                  `1st Half O/U: ${((1-h1OverP)*100).toFixed(1)}% under | ${h1BestUn.bookie}: ${h1BestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-h1OverP)*100), h1UnderEdge * 0.18, kickoffTime, h1BestUn.bookie, matchSignals, null, fxMetaNflH1Un);
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

  // v10.12.9 Phase A.1b: NFL execution-gate post-process
  let gatedNflPicks = picks;
  try {
    const { applyPostScanGate } = require('./lib/runtime/scan-gate');
    const { kellyToUnits } = require('./lib/model-math');
    const preferredBookies = (getPreferredBookies() && getPreferredBookies().length)
      ? getPreferredBookies() : ['Bet365', 'Unibet'];
    const before = gatedNflPicks.length;
    const res = await applyPostScanGate(gatedNflPicks, supabase, {
      preferredBookies, scanAnchorMs: Date.now(), activeUnitEur: getActiveUnitEur(),
      marketTypes: ['moneyline'], kellyToUnits,
    });
    gatedNflPicks = res.picks;
    if (res.stats.dampened || res.stats.skipped) {
      emit({ log: `🏈 Execution-gate: ${res.stats.dampened} gedempt · ${res.stats.skipped} geskipt (van ${before})` });
    }
  } catch (err) {
    emit({ log: `⚠️ NFL execution-gate mislukt: ${err.message}` });
  }

  emit({ log: `🏈 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${gatedNflPicks.length} NFL picks` });
  // v12.2.3: drop-reasons telemetrie.
  const _dropFmtNfl = formatDropReasons(dropReasons);
  if (_dropFmtNfl) emit({ log: `🏈 Drops: ${_dropFmtNfl}` });

  if (gatedNflPicks.length) saveScanEntry(gatedNflPicks, 'nfl', totalEvents);

  return gatedNflPicks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// HANDBALL SCANNER · api-sports.io handball
// ═══════════════════════════════════════════════════════════════════════════════

async function runHandball(emit) {
  if (!AF_KEY) { emit({ log: '🤾 Handball: geen API key' }); return []; }
  emit({ log: `🤾 Handball scan · ${HANDBALL_LEAGUES.length} competities` });

  const calib = loadCalib();
  const { picks, combiPool, mkP, dropReasons } = buildPickFactory(1.60, calib.epBuckets || {}, 'handball');
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

        // v12.1.8: maxPrice cap voorkomt dat een longshot-quote van een
        // nieuwe preferred-bookie (bv. 888sport @ 5.0) de dedupe-winnaar wordt
        // terwijl Bet365 @ 2.50 binnen cap had gepast. Pick valt dan niet meer
        // weg op de post-check <= MAX_WINNER_ODDS.
        const bH = bestFromArr(homeOdds, { maxPrice: MAX_WINNER_ODDS });
        const bA = bestFromArr(awayOdds, { maxPrice: MAX_WINNER_ODDS });

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
        // v10.12.19 fix: marketFairHb gelift uit het inner block zodat het
        // downstream (snap.writeFeatureSnapshot line ~5243) bereikbaar is.
        // Voorheen out-of-scope → `marketFairHb is not defined` error in handbal scan.
        let marketFairHb = null;
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
          // v12.1.8: maxPrice cap parity met post-check (Home/Away ≤ 4.0, Draw ≤ 15.0 voor handball)
          const bH3 = bestFromArr(h3, { maxPrice: MAX_WINNER_ODDS });
          const bD3 = bestFromArr(d3, { maxPrice: 15.00 });
          const bA3 = bestFromArr(a3, { maxPrice: MAX_WINNER_ODDS });

          const e3H = bH3.price > 0 ? p3.pHome * bH3.price - 1 : -1;
          const e3D = bD3.price > 0 ? p3.pDraw * bD3.price - 1 : -1;
          const e3A = bA3.price > 0 ? p3.pAway * bA3.price - 1 : -1;

          // Sanity-check handbal Poisson tegen markt consensus (zelfde principe als hockey)
          marketFairHb = consensus3Way(parsed.threeWay);
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

        // v10.12.9 Phase A.1b handball: ML 2-way
        const fxMetaHbH = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'home', line: null };
        const fxMetaHbA = { fixtureId: gameId, marketType: 'moneyline', selectionKey: 'away', line: null };
        // v11.1.2: sanity-gate voor handball ML (signal-adjusted).
        const hbMlGate = passesDivergence2Way(adjHome, adjAway, bH.price, bA.price);
        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && hbMlGate.passA)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price,
            `Consensus: ${(fpHome*100).toFixed(1)}%→${(adjHome*100).toFixed(1)}% | ${bH.bookie}: ${bH.price}${sharedNotes} | ${ko}`,
            Math.round(adjHome*100), homeEdge * 0.28, kickoffTime, bH.bookie, matchSignals, null, fxMetaHbH);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && hbMlGate.passB)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price,
            `Consensus: ${(fpAway*100).toFixed(1)}%→${(adjAway*100).toFixed(1)}% | ${bA.bookie}: ${bA.price}${sharedNotes} | ${ko}`,
            Math.round(adjAway*100), awayEdge * 0.28, kickoffTime, bA.bookie, matchSignals, null, fxMetaHbA);

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
            const ov = overOdds.filter(o => Math.abs(o.point - line) < 0.01);
            const un = underOdds.filter(o => Math.abs(o.point - line) < 0.01);
            if (ov.length && un.length) {
              const avgOvIP = ov.reduce((s,o)=>s+1/o.price,0) / ov.length;
              const avgUnIP = un.reduce((s,o)=>s+1/o.price,0) / un.length;
              const totIP2 = avgOvIP + avgUnIP;
              const overP = totIP2 > 0 ? avgOvIP / totIP2 : 0.5;
              const bestOv = bestFromArr(ov);
              const bestUn = bestFromArr(un);
              const overEdge = overP * bestOv.price - 1;
              const underEdge = (1-overP) * bestUn.price - 1;
              // v11.2.1: safety-gate + fxMeta
              const hbOuGate = passesDivergence2Way(overP, 1-overP, bestOv.price, bestUn.price);
              const fxMetaHbOv = { fixtureId: gameId, marketType: 'total', selectionKey: 'over', line };
              const fxMetaHbUn = { fixtureId: gameId, marketType: 'total', selectionKey: 'under', line };

              if (overEdge >= MIN_EDGE && bestOv.price >= 1.60 && hbOuGate.passA)
                mkP(`${hm} vs ${aw}`, league.name, `🤾 Over ${line} goals`, bestOv.price,
                  `O/U: ${(overP*100).toFixed(1)}% over | ${bestOv.bookie}: ${bestOv.price}${sharedNotes} | ${ko}`,
                  Math.round(overP*100), overEdge * 0.24, kickoffTime, bestOv.bookie, matchSignals, null, fxMetaHbOv);
              if (underEdge >= MIN_EDGE && bestUn.price >= 1.60 && hbOuGate.passB)
                mkP(`${hm} vs ${aw}`, league.name, `🔒 Under ${line} goals`, bestUn.price,
                  `O/U: ${((1-overP)*100).toFixed(1)}% under | ${bestUn.bookie}: ${bestUn.price}${sharedNotes} | ${ko}`,
                  Math.round((1-overP)*100), underEdge * 0.22, kickoffTime, bestUn.bookie, matchSignals, null, fxMetaHbUn);
              // v12.2.37: handball O/U → v2.
              if (_currentModelVersionId) {
                snap.recordTotalsEvaluation({
                  supabase, modelVersionId: _currentModelVersionId, fixtureId: gameId,
                  marketType: 'total', line,
                  pOver: overP, pUnder: 1 - overP,
                  bestOv, bestUn, ovEdge: overEdge, unEdge: underEdge, minEdge: MIN_EDGE,
                  matchSignals, debug: { sport: 'handball' },
                }).catch(() => {});
              }
            }
          }
        }

        // Handicap (handball) — v11.2.1 hardened: hasDevig + ≥3 bookies + sanity + fxMeta.
        {
          const homeSpr = parsed.spreads.filter(o => o.side === 'home');
          const awaySpr = parsed.spreads.filter(o => o.side === 'away');
          const { homeFn, awayFn, hasDevig, bookieCountAt } = buildSpreadFairProbFns(homeSpr, awaySpr, fpHome * 0.50, fpAway * 0.50);
          const bH = bestSpreadPick(homeSpr, homeFn, MIN_EDGE + 0.01);
          if (bH && hasDevig(bH.point) && bookieCountAt(bH.point) >= 3) {
            const fp = homeFn(bH.point);
            const sanity = modelMarketSanityCheck(fp, 1 / bH.price);
            if (sanity.agree) {
              const pt = bH.point > 0 ? `+${bH.point}` : `${bH.point}`;
              const fxMeta = { fixtureId: gameId, marketType: 'handicap', selectionKey: `home_${bH.point}`, line: bH.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bH.price,
                `Handicap | ${bH.bookie}: ${bH.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bH.edge * 0.20, kickoffTime, bH.bookie, matchSignals, null, fxMeta);
            }
          }
          const bA = bestSpreadPick(awaySpr, awayFn, MIN_EDGE + 0.01);
          if (bA && hasDevig(bA.point) && bookieCountAt(bA.point) >= 3) {
            const fp = awayFn(bA.point);
            const sanity = modelMarketSanityCheck(fp, 1 / bA.price);
            if (sanity.agree) {
              const pt = bA.point > 0 ? `+${bA.point}` : `${bA.point}`;
              const fxMeta = { fixtureId: gameId, marketType: 'handicap', selectionKey: `away_${bA.point}`, line: bA.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bA.price,
                `Handicap | ${bA.bookie}: ${bA.price} · cover ${(fp*100).toFixed(1)}%${sharedNotes} | ${ko}`,
                Math.round(fp*100), bA.edge * 0.20, kickoffTime, bA.bookie, matchSignals, null, fxMeta);
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

  // v10.12.9 Phase A.1b: handball execution-gate post-process
  let gatedHbPicks = picks;
  try {
    const { applyPostScanGate } = require('./lib/runtime/scan-gate');
    const { kellyToUnits } = require('./lib/model-math');
    const preferredBookies = (getPreferredBookies() && getPreferredBookies().length)
      ? getPreferredBookies() : ['Bet365', 'Unibet'];
    const before = gatedHbPicks.length;
    const res = await applyPostScanGate(gatedHbPicks, supabase, {
      preferredBookies, scanAnchorMs: Date.now(), activeUnitEur: getActiveUnitEur(),
      marketTypes: ['moneyline'], kellyToUnits,
    });
    gatedHbPicks = res.picks;
    if (res.stats.dampened || res.stats.skipped) {
      emit({ log: `🤾 Execution-gate: ${res.stats.dampened} gedempt · ${res.stats.skipped} geskipt (van ${before})` });
    }
  } catch (err) {
    emit({ log: `⚠️ Handball execution-gate mislukt: ${err.message}` });
  }

  emit({ log: `🤾 ${totalEvents} wedstrijden geanalyseerd (${apiCallsUsed} API calls) | ${gatedHbPicks.length} handball picks` });
  // v12.2.3: drop-reasons telemetrie.
  const _dropFmtHb = formatDropReasons(dropReasons);
  if (_dropFmtHb) emit({ log: `🤾 Drops: ${_dropFmtHb}` });

  if (gatedHbPicks.length) saveScanEntry(gatedHbPicks, 'handball', totalEvents);

  return gatedHbPicks;
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

  // v10.12.8 Phase A.1b: kickoff map wordt verderop in het scan-gate
  // post-process gebruikt. Bouwen zodra fixtures pre-fetched zijn.
  const _scanKickoffByFixture = new Map();
  for (const leagueKey of Object.keys(_footballFixturesCache)) {
    for (const f of (_footballFixturesCache[leagueKey] || [])) {
      const fid = f?.fixture?.id;
      if (!fid) continue;
      const kMs = Date.parse(f?.fixture?.date || '');
      if (Number.isFinite(kMs)) _scanKickoffByFixture.set(fid, kMs);
    }
  }

  const { picks, combiPool, mkP, dropReasons } = buildPickFactory(1.60, calib.epBuckets || {}, 'football');
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
          // v10.12.14 Phase D.13: fixture-congestion uit cached recent-matches.
          // fetchLastPlayedDate populeert afCache.recentMatches met last=3 dates.
          const hmRecent = getRecentMatchDates('football', hmId);
          const awRecent = getRecentMatchDates('football', awId);
          restInfo = buildRestDaysInfo('football', kickoffMs, hmLast, awLast, {
            homeRecentDates: hmRecent, awayRecentDates: awRecent,
          });
          if (restInfo.homeTired) scanTelemetry.restDaysTiredHome++;
          if (restInfo.awayTired) scanTelemetry.restDaysTiredAway++;
          if (restInfo.homeCongested) {
            scanTelemetry.fixtureCongestionHome = (scanTelemetry.fixtureCongestionHome || 0) + 1;
          }
          if (restInfo.awayCongested) {
            scanTelemetry.fixtureCongestionAway = (scanTelemetry.fixtureCongestionAway || 0) + 1;
          }
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
        // v10.12.17 Phase D.13b: lineup-certainty shadow signal.
        // States: 'both' | 'home_only' | 'away_only' | 'neither' | 'too_early' | 'unknown'
        let lineupCertainty = 'too_early';
        const minsToKo = (kickoffMs - Date.now()) / 60000;
        if (minsToKo > 0 && minsToKo < 180 && apiCallsUsed < 290) {
          await sleep(80);
          const luResp = await afGet('v3.football.api-sports.io', '/fixtures/lineups', { fixture: fid });
          apiCallsUsed++;
          lineupCertainty = 'neither';
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
            // Certainty label (≥9 starters = confirmed)
            const homeConfirmed = hmXI >= 9;
            const awayConfirmed = awXI >= 9;
            lineupCertainty = homeConfirmed && awayConfirmed ? 'both'
              : homeConfirmed ? 'home_only'
              : awayConfirmed ? 'away_only'
              : 'neither';
          }
        } else if (minsToKo <= 0) {
          lineupCertainty = 'unknown';  // post-kickoff, shouldn't happen
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
        const totalAdjUncapped = earlySeason ? (dampedFormH2h + injAdj + congestionAdj) : totalAdjRaw;
        // v12.0.0 (Claude P1.4): cumulatieve signal-push cap. Elke individuele
        // signaal-component (form ±5%, ref ±4%, H2H ±3%, congestion ±3%) heeft
        // al een eigen cap, maar sommatie zonder cum-cap liet 15-25pp drift toe.
        // Cap ±10pp zodat cumulatief meer dan 3 signalen samen niet wild van
        // markt afwijken. Sandefjord-class BTTS-fake edges (was 34pp) zijn al
        // elders afgevangen; dit cap'pt 1X2 signal-push specifiek.
        const totalAdj = Math.max(-0.10, Math.min(0.10, totalAdjUncapped));
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
          // v10.12.17 Phase D.13b: lineup-certainty shadow signal.
          // Auto-promotes via autoTuneSignalsByClv als "bets met confirmed lineup"
          // structureel hogere CLV blijken te hebben dan "too early" bets.
          if (lineupCertainty === 'both') sigs.push('lineup_confirmed_both:0%');
          else if (lineupCertainty === 'home_only') sigs.push('lineup_confirmed_home_only:0%');
          else if (lineupCertainty === 'away_only') sigs.push('lineup_confirmed_away_only:0%');
          else if (lineupCertainty === 'neither') sigs.push('lineup_pending:0%');
          else if (lineupCertainty === 'too_early') sigs.push('lineup_too_early:0%');
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
              // v11.3.31 (Codex-finding): sanity_fail reject-reason was onzichtbaar.
              // 1X2 mkP-calls checken sanityHomeFb/sanityAwayFb/sanityDrawFb.agree,
              // maar pick_candidates logt die niet mee → near-miss UI blind voor
              // deze hele rejection-categorie. Nu wel gelogd.
              const evals = [
                { side: 'home', edge: homeEdge, prob: adjHome2, best: bH, gateOk: (bA.price > BLOWOUT_OPP_MAX), sanity: sanityHomeFb },
                { side: 'draw', edge: drawEdge, prob: adjDraw || 0, best: bD || { price: 0, bookie: 'none' }, gateOk: true, minThreshold: MIN_EDGE + 0.01, sanity: sanityDrawFb },
                { side: 'away', edge: awayEdge, prob: adjAway2, best: bA, gateOk: (bH.price > BLOWOUT_OPP_MAX), sanity: sanityAwayFb },
              ];
              for (const ev of evals) {
                const min = ev.minThreshold != null ? ev.minThreshold : MIN_EDGE;
                const adaptiveMin = adaptiveMinEdge('football', `${ev.side}`, min);
                let rejected = null;
                if (!ev.best || ev.best.price <= 0) rejected = 'no_bookie_price';
                else if (ev.best.price < 1.60) rejected = `price_too_low (${ev.best.price})`;
                else if (ev.side !== 'draw' && ev.best.price > MAX_WINNER_ODDS) rejected = `price_too_high (${ev.best.price})`;
                else if (!ev.gateOk) rejected = 'blowout_opp_too_low';
                else if (ev.sanity && ev.sanity.agree === false) rejected = `sanity_fail (div ${(ev.sanity.divergence * 100).toFixed(1)}pp > ${(MODEL_MARKET_DIVERGENCE_THRESHOLD * 100).toFixed(1)}pp)`;
                else if (ev.edge < adaptiveMin) rejected = `edge_below_min (${(ev.edge * 100).toFixed(1)}% < ${(adaptiveMin * 100).toFixed(1)}%)`;
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

        // v10.12.6 Phase A.1b: thread fixtureMeta voor de football 1X2 markt
        // door. Market-type '1x2' komt overeen met de schrijf-zijde in
        // snap.writeMarketConsensus (zie scan-snapshot code hierboven).
        const fxMetaH = { fixtureId: fid, marketType: '1x2', selectionKey: 'home', line: null };
        const fxMetaA = { fixtureId: fid, marketType: '1x2', selectionKey: 'away', line: null };
        const fxMetaD = { fixtureId: fid, marketType: '1x2', selectionKey: 'draw', line: null };
        // v11.1.2: 3-way sanity-gate per zijde tegen markt-consensus fp.
        // adjHome2/adjDraw/adjAway2 zijn signal-adjusted; divergentie > 4pp
        // t.o.v. fp.home/fp.draw/fp.away = geen pick.
        const sanityHomeFb = fp && typeof fp.home === 'number' ? modelMarketSanityCheck(adjHome2, fp.home) : { agree: true };
        const sanityAwayFb = fp && typeof fp.away === 'number' ? modelMarketSanityCheck(adjAway2, fp.away) : { agree: true };
        const sanityDrawFb = fp && typeof fp.draw === 'number' ? modelMarketSanityCheck(adjDraw || 0, fp.draw) : { agree: true };

        if (homeEdge >= MIN_EDGE && bH.price >= 1.60 && bH.price <= MAX_WINNER_ODDS && bA.price > BLOWOUT_OPP_MAX && sanityHomeFb.agree)
          mkP(`${hm} vs ${aw}`, league.name, `🏠 ${hm} wint`, bH.price, reasonH, Math.round(adjHome2*100), homeEdge * 0.28 * (cm.home?.multiplier ?? 1), kickoffTime, bH.bookie, matchSignals, refereeName, fxMetaH);

        if (awayEdge >= MIN_EDGE && bA.price >= 1.60 && bA.price <= MAX_WINNER_ODDS && bH.price > BLOWOUT_OPP_MAX && sanityAwayFb.agree)
          mkP(`${hm} vs ${aw}`, league.name, `✈️ ${aw} wint`, bA.price, reasonA, Math.round(adjAway2*100), awayEdge * 0.28 * (cm.away?.multiplier ?? 1), kickoffTime, bA.bookie, matchSignals, refereeName, fxMetaA);

        if (drawEdge >= MIN_EDGE + 0.01 && bD?.price >= 1.60 && sanityDrawFb.agree)
          mkP(`${hm} vs ${aw}`, league.name, `🤝 Gelijkspel`, bD.price, reasonD, Math.round((adjDraw||0)*100), drawEdge * 0.22 * (cm.draw?.multiplier ?? 1), kickoffTime, bD?.bookie, matchSignals, refereeName, fxMetaD);

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
          // v10.12.7 Phase A.1b: totals market is 2-way (over/under), line=2.5
          const fxMetaOver  = { fixtureId: fid, marketType: 'total', selectionKey: 'over',  line: 2.5 };
          const fxMetaUnder = { fixtureId: fid, marketType: 'total', selectionKey: 'under', line: 2.5 };
          // v11.2.1: safety-gate. overP is signal-adjusted (tsAdj ±5% + weather ±3%
          // + poisson ±4% + aggPush ±3%). Kan max ~15% divergeren van devigged
          // consensus. Gate zorgt dat we niet op signal-gepushte fake edge inzetten.
          const fbOuGate = passesDivergence2Way(overP, 1-overP, over.best.price, under.best.price);
          if (overEdge >= MIN_EDGE && fbOuGate.passA)
            mkP(`${hm} vs ${aw}`, league.name, `⚽ Over 2.5 goals`, over.best.price,
              `O/U consensus: ${(overP*100).toFixed(1)}% over | ${over.best.bookie}: ${over.best.price}${tsNote}${weatherOUNote}${poissonOUNote}${predNote} | ${ko}`,
              Math.round(overP*100), overEdge * 0.24 * (cm.over?.multiplier ?? 1), kickoffTime, over.best.bookie, ouSignals, refereeName, fxMetaOver);
          if (underEdge >= MIN_EDGE && under.best.price >= 1.60 && fbOuGate.passB)
            mkP(`${hm} vs ${aw}`, league.name, `🔒 Under 2.5 goals`, under.best.price,
              `O/U consensus: ${((1-overP)*100).toFixed(1)}% under | ${under.best.bookie}: ${under.best.price}${tsNote}${weatherOUNote}${poissonOUNote} | ${ko}`,
              Math.round((1-overP)*100), underEdge * 0.22 * (cm.under?.multiplier ?? 1), kickoffTime, under.best.bookie, ouSignals, refereeName, fxMetaUnder);
          // v12.2.33: voetbal main O/U → v2 (grootste volume → biggest visibility win).
          if (_currentModelVersionId) {
            snap.recordTotalsEvaluation({
              supabase, modelVersionId: _currentModelVersionId, fixtureId: fid,
              marketType: 'total', line: 2.5,
              pOver: overP, pUnder: 1 - overP,
              bestOv: over.best, bestUn: under.best,
              ovEdge: overEdge, unEdge: underEdge, minEdge: MIN_EDGE,
              matchSignals: ouSignals, debug: { sport: 'football' },
            }).catch(() => {});
          }
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
            // v10.12.20 fix: pick-odds MUST come uit operator's preferred bookies
            // (execution truth). filteredBks bevat ook sharp-refs (Pinnacle,
            // William Hill) voor consensus-berekening; die mogen niet naar de
            // pick.bookie lekken. Doctrine §10.A preferred = operator settings.
            // Voorheen lekten non-preferred bookies naar de pick badge.
            const preferredSet = getPreferredBookies();
            const isPreferred = (name) => {
              if (!preferredSet || !preferredSet.length) return true; // no setting → allow all (pre-set fallback)
              const lc = String(name || '').toLowerCase();
              return preferredSet.some(p => lc.includes(p));
            };
            let bestYes = { price: 0, bookie: '' };
            let bestNo  = { price: 0, bookie: '' };
            for (const b of bttsBk) {
              if (!isPreferred(b.name)) continue;
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
                  const agg = require('./lib/integrations/data-aggregator');
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
              // v10.12.7 Phase A.1b: BTTS = 2-way binary market
              const fxMetaBttsY = { fixtureId: fid, marketType: 'btts', selectionKey: 'yes', line: null };
              const fxMetaBttsN = { fixtureId: fid, marketType: 'btts', selectionKey: 'no',  line: null };

              // v11.3.31 (Codex-finding): methodologisch correcte gate voor BTTS.
              // Voorheen: passesDivergence2Way(bttsYesP, marketDevig, 7pp threshold).
              // Probleem: bttsYesP komt uit calcBTTSProb() (H2H + form-model), NIET
              // uit market-devig. Die kan inherent 15-25pp van market-devig afliggen
              // zonder dat dat "fake edge" is — het is gewoon een andere methode.
              // De Sandefjord-case (74% model vs 42% market @ 2.40) was een DUN-H2H
              // probleem: h2hN=2, BTTS_H2H_PRIOR_K kon de sample niet voldoende
              // shrinken. Echte fix: vereis h2hN >= 5 zodat calcBTTSProb op
              // voldoende data kan steunen. Plus: auditSuspicious in mkP vangt al
              // grote gaps tussen model en markt-baseline (stake-dampen 0.6×).
              const bttsDataOk = h2hN >= 5;

              // v12.0.0 (Codex P1 + Claude P0): BTTS gebruikt nu eigen
              // calibratie-buckets. Voorheen las scan cm.over / cm.under, terwijl
              // learning-loop al naar football_btts_yes/no schreef → cross-market
              // contamination. Nu end-to-end consistent: schrijven en lezen beide
              // via btts_yes / btts_no keys.
              if (bttsYesEdge >= MIN_EDGE && bestYes.price >= 1.60 && bttsDataOk)
                mkP(`${hm} vs ${aw}`, league.name, `🔥 BTTS Ja`, bestYes.price,
                  `BTTS: ${(bttsYesP*100).toFixed(1)}% | ${bestYes.bookie}: ${bestYes.price} | GF: ${hmGFAvg}/${awGFAvg}${h2hStr} | ${ko}`,
                  Math.round(bttsYesP*100), bttsYesEdge * 0.22 * (cm.btts_yes?.multiplier ?? 1), kickoffTime, bestYes.bookie, bttsSignals, refereeName, fxMetaBttsY);

              if (bttsNoEdge >= MIN_EDGE && bestNo.price >= 1.60 && bttsDataOk)
                mkP(`${hm} vs ${aw}`, league.name, `🛡️ BTTS Nee`, bestNo.price,
                  `BTTS Nee: ${(bttsNoP*100).toFixed(1)}% | ${bestNo.bookie}: ${bestNo.price} | GF: ${hmGFAvg}/${awGFAvg} | CS: ${hmTS2?.cleanSheetPct ? (hmTS2.cleanSheetPct*100).toFixed(0)+'%' : '?'}/${awTS2?.cleanSheetPct ? (awTS2.cleanSheetPct*100).toFixed(0)+'%' : '?'}${h2hStr} | ${ko}`,
                  Math.round(bttsNoP*100), bttsNoEdge * 0.20 * (cm.btts_no?.multiplier ?? 1), kickoffTime, bestNo.bookie, bttsSignals, refereeName, fxMetaBttsN);
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
            // v10.12.22 fix: DNB pick-odds moeten uit operator's preferred
            // bookies komen, niet uit de wider consensus-pool (Pinnacle etc).
            // Zelfde fix als BTTS in v10.12.20.
            const _prefSetDnb = getPreferredBookies();
            const _isPreferredDnb = (name) => {
              if (!_prefSetDnb || !_prefSetDnb.length) return true;
              const lc = String(name || '').toLowerCase();
              return _prefSetDnb.some(p => lc.includes(p));
            };
            let bestDnbH = { price: 0, bookie: '' };
            let bestDnbA = { price: 0, bookie: '' };
            for (const b of dnbBk) {
              if (!_isPreferredDnb(b.name)) continue;
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

            // v10.12.7 Phase A.1b: DNB = 2-way markt
            const fxMetaDnbH = { fixtureId: fid, marketType: 'dnb', selectionKey: 'home', line: null };
            const fxMetaDnbA = { fixtureId: fid, marketType: 'dnb', selectionKey: 'away', line: null };
            // v11.1.2: sanity-gate vs devigged DNB-market. dnbHomeP/dnbAwayP is
            // model-derived (redistrib); vergelijk met bookmaker-implied.
            const dnbGate = passesDivergence2Way(dnbHomeP, dnbAwayP, bestDnbH.price, bestDnbA.price);

            // v12.0.0 (Claude P1): DNB krijgt eigen calibratie-bucket. Voorheen
            // stake zonder multiplier → systematisch onder-gestaked in ranking.
            if (dnbHomeEdge >= MIN_EDGE && bestDnbH.price >= 1.30 && bestDnbH.price <= 2.50 && dnbGate.passA)
              mkP(`${hm} vs ${aw}`, league.name, `🏠 DNB ${hm}`, bestDnbH.price,
                `Draw No Bet: ${(dnbHomeP*100).toFixed(1)}% | ${bestDnbH.bookie}: ${bestDnbH.price} | Gelijk=terugbetaling | ${ko}`,
                Math.round(dnbHomeP*100), dnbHomeEdge * 0.24 * (cm.dnb_home?.multiplier ?? 1), kickoffTime, bestDnbH.bookie, matchSignals, refereeName, fxMetaDnbH);

            if (dnbAwayEdge >= MIN_EDGE && bestDnbA.price >= 1.30 && bestDnbA.price <= 2.50 && dnbGate.passB)
              mkP(`${hm} vs ${aw}`, league.name, `✈️ DNB ${aw}`, bestDnbA.price,
                `Draw No Bet: ${(dnbAwayP*100).toFixed(1)}% | ${bestDnbA.bookie}: ${bestDnbA.price} | Gelijk=terugbetaling | ${ko}`,
                Math.round(dnbAwayP*100), dnbAwayEdge * 0.24 * (cm.dnb_away?.multiplier ?? 1), kickoffTime, bestDnbA.bookie, matchSignals, refereeName, fxMetaDnbA);
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

          // v10.12.22 fix: Double Chance pick-odds alleen uit preferred bookies
          const _prefSetDc = getPreferredBookies();
          const _isPreferredDc = (name) => {
            if (!_prefSetDc || !_prefSetDc.length) return true;
            const lc = String(name || '').toLowerCase();
            return _prefSetDc.some(p => lc.includes(p));
          };
          let bestHX = { price: 0, bookie: '' };
          let best12 = { price: 0, bookie: '' };
          let bestX2 = { price: 0, bookie: '' };
          for (const b of dcBookies) {
            if (!_isPreferredDc(b.name)) continue;
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

          // v11.2.1 sanity-gate + fxMeta. Vergelijk signal-adjusted DC-prob met
          // devigged 3-way consensus (fp.home+fp.draw etc.). Signal-push >4pp blokkeert.
          const mfHX = fp && typeof fp.home === 'number' && typeof fp.draw === 'number' ? fp.home + fp.draw : null;
          const mf12 = fp && typeof fp.home === 'number' && typeof fp.away === 'number' ? fp.home + fp.away : null;
          const mfX2 = fp && typeof fp.draw === 'number' && typeof fp.away === 'number' ? fp.draw + fp.away : null;
          const sanDcHX = mfHX != null ? modelMarketSanityCheck(pHX, mfHX) : { agree: true };
          const sanDc12 = mf12 != null ? modelMarketSanityCheck(p12, mf12) : { agree: true };
          const sanDcX2 = mfX2 != null ? modelMarketSanityCheck(pX2, mfX2) : { agree: true };
          const fxMetaDcHX = { fixtureId: fid, marketType: 'double_chance', selectionKey: '1x', line: null };
          const fxMetaDc12 = { fixtureId: fid, marketType: 'double_chance', selectionKey: '12', line: null };
          const fxMetaDcX2 = { fixtureId: fid, marketType: 'double_chance', selectionKey: 'x2', line: null };

          // v12.0.0 (Claude P1): Double Chance eigen calibratie-buckets.
          if (eHX >= MIN_EDGE && bestHX.price >= 1.15 && bestHX.price <= 2.50 && sanDcHX.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🎯 1X (${hm} of gelijk)`, bestHX.price,
              `Double Chance 1X: ${(pHX*100).toFixed(1)}% | ${bestHX.bookie}: ${bestHX.price} | ${ko}`,
              Math.round(pHX*100), eHX * 0.16 * (cm.dc_1x?.multiplier ?? 1), kickoffTime, bestHX.bookie, matchSignals, refereeName, fxMetaDcHX);
          if (e12 >= MIN_EDGE && best12.price >= 1.15 && best12.price <= 2.50 && sanDc12.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🎯 12 (geen gelijk)`, best12.price,
              `Double Chance 12: ${(p12*100).toFixed(1)}% | ${best12.bookie}: ${best12.price} | ${ko}`,
              Math.round(p12*100), e12 * 0.16 * (cm.dc_12?.multiplier ?? 1), kickoffTime, best12.bookie, matchSignals, refereeName, fxMetaDc12);
          if (eX2 >= MIN_EDGE && bestX2.price >= 1.15 && bestX2.price <= 2.50 && sanDcX2.agree)
            mkP(`${hm} vs ${aw}`, league.name, `🎯 X2 (${aw} of gelijk)`, bestX2.price,
              `Double Chance X2: ${(pX2*100).toFixed(1)}% | ${bestX2.bookie}: ${bestX2.price} | ${ko}`,
              Math.round(pX2*100), eX2 * 0.16 * (cm.dc_x2?.multiplier ?? 1), kickoffTime, bestX2.bookie, matchSignals, refereeName, fxMetaDcX2);
        }

        // ── Handicap ──────────────────────────────────────────────────
        // v11.2.1 KRITIEKE BUG FIX: voorheen gebruikte dit fp.home/fp.away (full-game
        // ML 3-way prob) DIRECT als cover-prob voor handicap. Chelsea -1.5 @ 2.20
        // met fp.home=52% gaf edge 14% — maar -1.5 vereist winst met 2+ goals, NIET
        // alleen winnen. Systematisch fake edges op extreme handicap-lijnen die
        // alleen 1 bookie aanbiedt. Zelfde bug-klasse als NBA 1H spread (v11.1.1).
        //
        // Nu: per-point devig via buildSpreadFairProbFns + hasDevig + ≥3 bookies +
        // modelMarketSanityCheck + fxMeta. Bij onvoldoende paired bookies → skip.
        {
          const ahHomeSpr = [];
          const ahAwaySpr = [];
          for (const bk of bookies) {
            const sMkt = bk.markets?.find(m => m.key === 'spreads');
            if (!sMkt) continue;
            for (const o of (sMkt.outcomes || [])) {
              if (!o.price || o.price < 1.01 || o.point === undefined) continue;
              const side = o.name === hm ? 'home' : (o.name === aw ? 'away' : null);
              if (!side) continue;
              const row = { side, point: Number(o.point), price: Number(o.price), bookie: bk.title };
              if (side === 'home') ahHomeSpr.push(row);
              else ahAwaySpr.push(row);
            }
          }
          const { homeFn, awayFn, hasDevig, bookieCountAt } = buildSpreadFairProbFns(ahHomeSpr, ahAwaySpr, fp.home * 0.65, fp.away * 0.65);
          const bAhH = bestSpreadPick(ahHomeSpr, homeFn, MIN_EDGE + 0.01);
          if (bAhH && hasDevig(bAhH.point) && bookieCountAt(bAhH.point) >= 3) {
            const fpAh = homeFn(bAhH.point);
            const sanity = modelMarketSanityCheck(fpAh, 1 / bAhH.price);
            if (sanity.agree && bAhH.price <= 3.8) {
              const pt = bAhH.point > 0 ? `+${bAhH.point}` : `${bAhH.point}`;
              const fxMeta = { fixtureId: fid, marketType: 'handicap', selectionKey: `home_${bAhH.point}`, line: bAhH.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${hm} ${pt}`, bAhH.price,
                `Handicap | ${bAhH.bookie}: ${bAhH.price} · cover ${(fpAh*100).toFixed(1)}% | ${ko}`,
                Math.round(fpAh*100), bAhH.edge * 0.20, kickoffTime, bAhH.bookie, matchSignals, refereeName, fxMeta);
            }
          }
          const bAhA = bestSpreadPick(ahAwaySpr, awayFn, MIN_EDGE + 0.01);
          if (bAhA && hasDevig(bAhA.point) && bookieCountAt(bAhA.point) >= 3) {
            const fpAh = awayFn(bAhA.point);
            const sanity = modelMarketSanityCheck(fpAh, 1 / bAhA.price);
            if (sanity.agree && bAhA.price <= 3.8) {
              const pt = bAhA.point > 0 ? `+${bAhA.point}` : `${bAhA.point}`;
              const fxMeta = { fixtureId: fid, marketType: 'handicap', selectionKey: `away_${bAhA.point}`, line: bAhA.point };
              mkP(`${hm} vs ${aw}`, league.name, `🎯 ${aw} ${pt}`, bAhA.price,
                `Handicap | ${bAhA.bookie}: ${bAhA.price} · cover ${(fpAh*100).toFixed(1)}% | ${ko}`,
                Math.round(fpAh*100), bAhA.edge * 0.20, kickoffTime, bAhA.bookie, matchSignals, refereeName, fxMeta);
            }
          }
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
  // v12.2.3: drop-reasons telemetrie. Voetbal heeft hoogste volume, dus belangrijkste signaal.
  const _dropFmtVoetbal = formatDropReasons(dropReasons);
  if (_dropFmtVoetbal) emit({ log: `⚽ Drops: ${_dropFmtVoetbal}` });

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
  // v12.1.7: 0.025 → 0.015. Na de v12.0.x stapeling van strengere sanity/
  // divergence/parser gates kwamen er systematisch 0-1 picks per scan uit.
  // 0.015 laat iets meer picks door zonder de echte quality-gates aan te raken.
  const MIN_CONFIDENCE = 0.015;

  const seen2 = new Set();
  let allCandidates = picks
    .filter(p => { const k=p.match+'|'+p.label; if(seen2.has(k)) return false; seen2.add(k); return true; })
    .filter(p => p.strength >= MIN_CONFIDENCE)
    .sort((a,b) => b.expectedEur - a.expectedEur || b.ep - a.ep); // meeste verwachte winst bovenaan

  // v10.12.8 Phase A.1b: post-scan execution-gate pass. Alle football picks
  // die `_fixtureMeta` dragen (1X2 + totals + BTTS + DNB) krijgen hun kelly
  // gedempt / worden geskipt op basis van de line-timeline metrics.
  try {
    const { applyPostScanGate } = require('./lib/runtime/scan-gate');
    const { kellyToUnits } = require('./lib/model-math');
    const preferredBookies = (getPreferredBookies() && getPreferredBookies().length)
      ? getPreferredBookies() : ['Bet365', 'Unibet'];
    const before = allCandidates.length;
    const res = await applyPostScanGate(allCandidates, supabase, {
      preferredBookies,
      kickoffByFixtureId: _scanKickoffByFixture,
      scanAnchorMs: Date.now(),
      activeUnitEur: getActiveUnitEur(),
      marketTypes: ['1x2', 'total', 'btts', 'dnb'],
      kellyToUnits,
    });
    allCandidates = res.picks;
    // Re-sort na mutatie (expectedEur kan zijn veranderd bij gedempte picks)
    allCandidates.sort((a,b) => b.expectedEur - a.expectedEur || b.ep - a.ep);
    if (res.stats.dampened || res.stats.skipped) {
      emit({ log: `📉 Execution-gate: ${res.stats.dampened} gedempt · ${res.stats.skipped} geskipt (van ${before})` });
    }
  } catch (err) {
    emit({ log: `⚠️ Execution-gate pass mislukt (picks ongewijzigd): ${err.message}` });
  }

  const finalPicks = allCandidates.slice(0, 5);

  const weakCount = allCandidates.length - finalPicks.length;

  if (finalPicks.length === 0) {
    const noMsg = allCandidates.length > 0
      ? `🌅 Dagelijkse Pre-Match Scan\n\n🚫 Geen overtuigde picks.\n${allCandidates.length} kandidaat(en) gevonden maar te zwak (min. confidence niet gehaald).\nGeanalyseerd: ${totalEvents} wedstrijden`
      : `🌅 Dagelijkse Pre-Match Scan\n\nGeen kwalificerende picks gevonden.\nGeanalyseerd: ${totalEvents} wedstrijden | Min. odds: 1.60`;
    // Web-push wordt gestuurd NA multi-sport merge
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

  _atomicSetPrematch(finalPicks);
  // Web-push wordt gestuurd NA multi-sport merge in POST /api/prematch
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
    // niet alleen web-push. Push kan gemist worden; inbox is het permanente
    // logboek van beslissingen. Plus: sommige aanbevelingen
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
      await notify(`💰 UNIT VERHOGING AANBEVOLEN\nBankroll: €${bkr.toFixed(0)} (+100%)\nOverweeg unit van €${money.unitEur} → €${money.unitEur*2}\n\nAccepteer via de instellingen.`).catch(() => {});
      await supabase.from('notifications').insert({
        type: 'upgrade_unit', title, body, read: false, user_id: null,
      }).then(() => {}, () => {});
      cs.upgrades_lastAt.upgrade_unit = now;
      await saveCalib(cs).catch(() => {});
    } else if (cs.totalSettled >= 30 && roi2 > 0.10 && canFire('upgrade_api')) {
      const title = `🚀 API-upgrade overweging`;
      const body = `ROI ${(roi2 * 100).toFixed(1)}% over ${cs.totalSettled} bets · overweeg api-sports All Sports upgrade ($99/mnd). (Negeer als al gedaan. Wordt pas over 7d opnieuw getoond; dismiss permanent via admin.)`;
      await notify(`🚀 ROI ${(roi2*100).toFixed(1)}% over ${cs.totalSettled} bets.\nOverweeg All Sports upgrade ($99/mnd) voor meer markten.`).catch(() => {});
      await supabase.from('notifications').insert({
        type: 'upgrade_api', title, body, read: false, user_id: null,
      }).then(() => {}, () => {});
      cs.upgrades_lastAt.upgrade_api = now;
      await saveCalib(cs).catch(() => {});
    }
  } catch (e) {
    console.warn('Unit uplevel / ROI-milestone notification failed:', e.message);
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
// Stille functie: geen eigen push. Geeft picks terug getagd als scanType:'live'.
// Wordt aangeroepen vanuit runPrematch (gecombineerde scan) én vanuit runLive (dagelijks).
// ═══════════════════════════════════════════════════════════════════════════════
// v11.3.17 Phase 6.1: getLivePicks + runLive verhuisd naar lib/scan/run-live.js
// via factory-pattern. scan-stream route (lib/routes/scan-stream.js) roept
// runLive aan via dep-inject, en dagelijkse-scheduler via scheduleDailyScan.
const createLiveScan = require('./lib/scan/run-live');
const { runLive, getLivePicks } = createLiveScan({
  afGet, loadCalib, sleep, notify, buildPickFactory,
  setLastLivePicks: _atomicSetLive,
  leagues: { football: AF_FOOTBALL_LEAGUES },
});

// v11.3.21 Phase 6.3: data-access voor bets-tabel verhuisd naar
// lib/bets-data.js. calcStats + readBets + writeBet + updateBetOutcome +
// deleteBet + getUserUnitEur via factory-pattern. revertCalibration +
// updateCalibration blijven in server.js (learning-loop), worden geinject.
const createBetsData = require('./lib/bets-data');
// v12.2.0: per-bookie bankroll tracking. Store wordt ge-inject in betsData zodat
// writeBet/updateBetOutcome/deleteBet auto-sync balances.
const { createBookieBalanceStore } = require('./lib/bookie-balances');
const bookieBalanceStore = createBookieBalanceStore({ supabase });

// v12.2.14 (D1): persistent scheduled jobs voor pre-kickoff + CLV checks.
// Bij Render-restart blijven pending jobs bewaard en worden ze automatisch
// opnieuw gepland (rescheduleAllPending bij boot, periodieke sweep).
const { createScheduledJobsStore } = require('./lib/scheduled-jobs');
const scheduledJobs = createScheduledJobsStore({
  supabase,
  handlers: {
    pre_kickoff: (payload) => _executePreKickoffCheck(payload),
    clv_check:   (payload) => _executeCLVCheck(payload),
  },
});
// v12.2.8 (F5): inline isPreferredBookie helper voor writeBet zodat per-bet
// `was_preferred_at_log_time` point-in-time wordt vastgelegd. Mirror van
// lib/learning-loop's interne isPreferredBookie maar met server-scope deps.
function isPreferredBookieAtLogTime(bookieName) {
  const prefs = (typeof getPreferredBookies === 'function' ? getPreferredBookies() : []) || [];
  if (!prefs.length) return true; // fail-open bij ontbreken settings
  const bk = String(bookieName || '').toLowerCase();
  if (!bk) return true;
  return prefs.map(s => String(s).toLowerCase()).some(p => bk.includes(p));
}
const betsData = createBetsData({
  supabase,
  getUserMoneySettings,
  defaultStartBankroll: START_BANKROLL,
  defaultUnitEur: UNIT_EUR,
  revertCalibration,
  updateCalibration,
  bookieBalanceStore,
  // v12.2.7 (F3): atomic outcome-flip via calib snapshot/restore
  snapshotCalib,
  restoreCalib,
  // v12.2.8 (F5): point-in-time preferred-bookie flag bij writeBet
  isPreferredBookie: isPreferredBookieAtLogTime,
});
const calcStats = betsData.calcStats;
const readBets = betsData.readBets;
const getUserUnitEur = betsData.getUserUnitEur;
const writeBet = betsData.writeBet;
const updateBetOutcome = betsData.updateBetOutcome;
const deleteBet = betsData.deleteBet;


// ═══════════════════════════════════════════════════════════════════════════════
// EXPRESS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ── AUTH ROUTES ────────────────────────────────────────────────────────────────
// v11.2.3 Phase 5.3: auth-routes (login, verify-code, register, me, password)
// verhuisd naar lib/routes/auth.js via factory-pattern.
const createAuthRouter = require('./lib/routes/auth');
app.use('/api', createAuthRouter({
  rateLimit,
  loadUsers,
  saveUser,
  bcrypt,
  jwt,
  jwtSecret: JWT_SECRET,
  loginCodes,
  sendEmail,
  notify,
  defaultSettings,
}));


// ── USER SETTINGS ──────────────────────────────────────────────────────────────
// v11.2.4 Phase 5.4a: user-settings verhuisd naar lib/routes/user.js.
const createUserRouter = require('./lib/routes/user');
app.use('/api', createUserRouter({ loadUsers, saveUser, defaultSettings, rescheduleUserScans }));


// ── ADMIN ROUTES ───────────────────────────────────────────────────────────────
// v11.2.5 Phase 5.4c: admin-users routes (list/update/delete) verhuisd naar
// lib/routes/admin-users.js. De rest van /api/admin/* blijft in server.js
// tot Phase 5.6 admin-v2 cluster extraction.
const createAdminUsersRouter = require('./lib/routes/admin-users');
app.use('/api', createAdminUsersRouter({
  supabase, requireAdmin, loadUsers, saveUser, clearUsersCache, notify, sendEmail,
}));

// v11.3.8 Phase 5.4p: calibration-monitor + line-timeline-preview verhuisd naar
// lib/routes/admin-timeline.js.
const createAdminTimelineRouter = require('./lib/routes/admin-timeline');
app.use('/api', createAdminTimelineRouter({ supabase, requireAdmin, loadUsers, lineTimelineLib }));

// v11.3.19 Phase 6.2b: maintenance + health schedulers verhuisd naar
// lib/runtime/maintenance-schedulers.js. Factory pattern met 7 schedulers
// + 2 pure helpers. Mount HIER (niet lager) want computeBookieConcentration
// wordt dadelijk door admin-inspect gebruikt via dep-inject.
const createMaintenanceSchedulers = require("./lib/runtime/maintenance-schedulers");
const maintenanceSchedulers = createMaintenanceSchedulers({
  supabase, loadCalib, saveCalib,
  readBets, getAdminUserId,
  notify,
  normalizeSport, detectMarket,
  autoTuneSignalsByClv, loadSignalWeights,
  getCurrentModelVersionId: () => _currentModelVersionId,
  getUnitEur: () => UNIT_EUR,
});
const scheduleRetentionCleanup = maintenanceSchedulers.scheduleRetentionCleanup;
const scheduleAutotune = maintenanceSchedulers.scheduleAutotune;
const scheduleBookieConcentrationWatcher = maintenanceSchedulers.scheduleBookieConcentrationWatcher;
const scheduleHealthAlerts = maintenanceSchedulers.scheduleHealthAlerts;
const scheduleSignalStatsRefresh = maintenanceSchedulers.scheduleSignalStatsRefresh;
const scheduleAutoRetraining = maintenanceSchedulers.scheduleAutoRetraining;
const checkUnitSizeChange = maintenanceSchedulers.checkUnitSizeChange;
const computeBookieConcentration = maintenanceSchedulers.computeBookieConcentration;
const writeTrainingExamplesForSettled = maintenanceSchedulers.writeTrainingExamplesForSettled;

// v11.3.5 Phase 5.4m: bookie-concentration / stake-regime / early-payout-summary /
// pick-candidates-summary / clv-stats verhuisd naar lib/routes/admin-inspect.js.
const createAdminInspectRouter = require('./lib/routes/admin-inspect');
app.use('/api', createAdminInspectRouter({
  supabase, requireAdmin, computeBookieConcentration,
  getActiveStartBankroll, aggregateEarlyPayoutStats,
  normalizeSport, detectMarket,
  loadUsers,
}));

// GET /api/admin/v2/kill-switch — huidige status + actieve killed markten
// v11.3.2 Phase 5.4j: kill-switch / operator / upgrade-ack endpoints verhuisd
// naar lib/routes/admin-controls.js.
const createAdminControlsRouter = require('./lib/routes/admin-controls');
app.use('/api', createAdminControlsRouter({
  requireAdmin,
  killSwitch: KILL_SWITCH,
  refreshKillSwitch,
  operator: OPERATOR,
  saveOperatorState,
  loadCalib, saveCalib,
}));

// v11.3.9 Phase 5.4q: walkforward + training-examples-build + drift + why-this-pick
// verhuisd naar lib/routes/admin-model-eval.js.
const createAdminModelEvalRouter = require('./lib/routes/admin-model-eval');
app.use('/api', createAdminModelEvalRouter({
  supabase, requireAdmin, loadUsers,
  normalizeSport, detectMarket, normalizeBookmaker,
  summarizeExecutionQuality, writeTrainingExamplesForSettled,
}));

// v11.3.6 Phase 5.4n: scrape-diagnose / scrape-sources × 2 verhuisd naar
// lib/routes/admin-sources.js.
const createAdminSourcesRouter = require('./lib/routes/admin-sources');
app.use('/api', createAdminSourcesRouter({ requireAdmin, operator: OPERATOR, loadCalib, saveCalib }));

// v11.3.4 Phase 5.4l: signal-performance × 2 + model-feed verhuisd naar
// lib/routes/admin-signals.js.
const createAdminSignalsRouter = require('./lib/routes/admin-signals');
app.use('/api', createAdminSignalsRouter({
  supabase, requireAdmin,
  loadCalib, loadSignalWeights,
  summarizeSignalMetrics, parseBetSignals,
  normalizeSport, detectMarket,
}));

// v11.3.7 Phase 5.4o: execution-quality / data-quality / odds-drift /
// per-bookie-stats / market-thresholds verhuisd naar lib/routes/admin-quality.js.
const createAdminQualityRouter = require('./lib/routes/admin-quality');
app.use('/api', createAdminQualityRouter({
  supabase, requireAdmin, loadUsers,
  summarizeExecutionQuality, normalizeSport,
  getMarketSampleCache: () => _marketSampleCache,
  refreshMarketSampleCounts,
  MARKET_SAMPLE_TTL_MS, BOOTSTRAP_MIN_TOTAL_BETS,
}));

// v11.3.3 Phase 5.4k: autotune-clv + snapshot-counts verhuisd naar
// lib/routes/admin-snapshots.js.
const createAdminSnapshotsRouter = require('./lib/routes/admin-snapshots');
app.use('/api', createAdminSnapshotsRouter({ supabase, requireAdmin, autoTuneSignalsByClv, loadUsers }));

// ── PUSH + INBOX NOTIFICATIONS ─────────────────────────────────────────────
// v11.2.0 Phase 5.1: handlers verhuisd naar lib/routes/notifications.js via
// factory-pattern. Eén mount hier, geen per-route boilerplate meer.
const createNotificationsRouter = require('./lib/routes/notifications');
app.use('/api', createNotificationsRouter({
  supabase,
  isValidUuid,
  rateLimit,
  savePushSub,
  deletePushSub,
  vapidPublicKey: VAPID_PUBLIC,
}));

// Prematch scan · SSE streaming (inclusief live check op moment van draaien)
// ── v10.8.13: shared multi-sport scan pipeline ──────────────────────────────
// Extractie uit de /api/prematch route zodat zowel de handmatige trigger
// (SSE streaming) als de cron-scheduler exact dezelfde pipeline draaien,
// INCLUSIEF de multi-sport scans en de notify() notificatie. Voorheen deed de
// cron alleen runPrematch() (football, geen notificatie) — verklaarde de
// missende 14:00 push.
// v11.3.26 Phase 9.2: runFullScan orchestrator verhuisd naar lib/scan/orchestrator.js.
// Per-sport scan bodies (runPrematch, runBasketball, runHockey, runBaseball,
// runFootballUS, runHandball) blijven in server.js — die hebben dense business-
// logic die eerst per-sport integration-tests verdient voor veilige extractie.
const createScanOrchestrator = require('./lib/scan/orchestrator');
let _scanOrchestrator = null;
function getRunFullScan() {
  if (!_scanOrchestrator) {
    _scanOrchestrator = createScanOrchestrator({
      runPrematch, runBasketball, runHockey, runBaseball, runFootballUS, runHandball,
      setPreferredBookies, refreshActiveUnitEur, recomputeStakeRegime,
      getActiveUnitEur: () => _activeUnitEur,
      getActiveStartBankroll: () => _activeStartBankroll,
      getCurrentStakeRegime: () => _currentStakeRegime,
      defaultUnitEur: UNIT_EUR,
      defaultStartBankroll: START_BANKROLL,
      isMarketKilled, applyCorrelationDamp,
      refreshSportCaps, getSportCap,
      getSportCapCache: () => _sportCapCache,
      sportCapTtlMs: SPORT_CAP_TTL_MS,
      getMarketSampleCache: () => _marketSampleCache,
      normalizeSport, detectMarket,
      operator: OPERATOR,
      saveScanEntry, notify, logScanEnd,
      kellyScore,
      supabase,
      // v12.0.2: orchestrator overschrijft na multi-sport merge de module-
      // state zodat /api/picks (= analyse-tab) de volledige set toont.
      setLastPrematchPicks: _atomicSetPrematch,
    });
  }
  return _scanOrchestrator.runFullScan;
}
async function runFullScan(opts) {
  return getRunFullScan()(opts);
}


// v11.3.16 Phase 5.4x: POST /api/prematch + POST /api/live (SSE scan streams)
// verhuisd naar lib/routes/scan-stream.js via factory-pattern. scanRunning
// blijft module-level flag in server.js want cron scheduler deelt hem.
const createScanStreamRouter = require('./lib/routes/scan-stream');
app.use('/api', createScanStreamRouter({
  requireAdmin, rateLimit,
  operator: OPERATOR,
  getScanRunning: () => scanRunning,
  setScanRunning: (v) => { scanRunning = v; },
  loadUsers, runFullScan, runLive,
}));

// Bets ophalen
// v11.2.6 Phase 5.4d: GET /api/bets + correlations + DELETE verhuisd naar
// lib/routes/bets.js. POST/PUT/recalculate + current-odds zijn in v11.3.10
// naar lib/routes/bets-write.js verhuisd (mount verderop in dit bestand).
const createBetsRouter = require('./lib/routes/bets');
app.use('/api', createBetsRouter({
  readBets, deleteBet, loadUsers, calcStats, rateLimit,
  defaultStartBankroll: START_BANKROLL,
  defaultUnitEur: UNIT_EUR,
}));

// Bet toevoegen
// ── PRE-KICKOFF CHECK · 30 min voor aftrap ───────────────────────────────────
// Haalt huidige odds op voor het specifieke event en vergelijkt met gelogde odds.
// Stuurt web-push alert als: odds gedrift >8%, of als aftrap veranderd is.
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

  return resolveOddFromBookie(bk, markt, {
    matchName: opts.matchName,
    sport: normalizeSport(sport),
  });
}

// v12.2.14 (D1): pre-kickoff handler — pure functie zonder setTimeout. Wordt
// aangeroepen vanuit scheduledJobs store (DB-persistent) of bij re-schedule
// na server-boot. Idempotent: meerdere keren callen = meerdere notify-msgs
// maar geen state-mutatie. Acceptabel.
async function _executePreKickoffCheck(payload) {
  const bet = payload || {};
  const tijdStr = bet.tijd || bet.time;
  const kickoffMs = parseBetKickoff(bet.datum, tijdStr);
  if (!Number.isFinite(kickoffMs)) return;
  try {
    const loggedOdds = parseFloat(bet.odds);
    const matchName  = bet.wedstrijd || '';
    const markt      = bet.markt || '';
    const lines      = [];

    const betSport = bet.sport || 'football';
    let currentOdds = null;
    try {
      const fxId = bet.fixtureId || await findGameId(betSport, matchName);
      currentOdds = await fetchCurrentOdds(betSport, fxId, markt, bet.tip, { strictBookie: true, matchName });
    } catch (e) {
      console.warn(`Pre-kickoff odds fetch failed voor "${matchName}":`, e.message);
    }

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
    await notify(lines.join('\n'));
  } catch (err) {
    console.error('Pre-kickoff check error:', err.message);
    throw err; // re-throw zodat scheduledJobs.markError telt
  }
}

async function schedulePreKickoffCheck(bet) {
  // Live bets zijn al bezig · geen pre-kickoff check nodig
  if (bet.scanType === 'live') return;

  // v11.3.23 C2: gebruik bet.datum + bet.tijd canonical via pure helper.
  const tijdStr = bet.tijd || bet.time;
  if (!tijdStr) return;
  const kickoffMs = parseBetKickoff(bet.datum, tijdStr);
  if (!Number.isFinite(kickoffMs)) return;

  const checkMs = kickoffMs - 30 * 60 * 1000;
  const delayMs = checkMs - Date.now();
  if (delayMs < 5000 || delayMs > 48 * 60 * 60 * 1000) return;

  // v12.2.14 (D1): persist + setTimeout via scheduledJobs store. Bij Render-
  // restart blijft de job behouden + wordt automatisch gerescheduuld.
  if (scheduledJobs && typeof scheduledJobs.enqueue === 'function') {
    await scheduledJobs.enqueue({
      job_type: 'pre_kickoff',
      bet_id: bet.id || null,
      payload: {
        id: bet.id, datum: bet.datum, tijd: tijdStr, odds: bet.odds,
        wedstrijd: bet.wedstrijd, markt: bet.markt, sport: bet.sport,
        tip: bet.tip, fixtureId: bet.fixtureId,
      },
      due_at: new Date(checkMs).toISOString(),
    });
  } else {
    // Fallback: oude in-memory setTimeout (alleen als store niet ge-init is)
    setTimeout(() => _executePreKickoffCheck(bet).catch(() => {}), delayMs);
  }

  console.log(`⏱  Pre-kickoff check gepland voor "${bet.wedstrijd}" over ${Math.round(delayMs/60000)} min`);
}

// ── CLV CHECK · 2 min voor aftrap ─────────────────────────────────────────
// Haalt slotlijn-odds op vlak voor kickoff en berekent CLV%.
//
// v12.2.14 (D1): handler-pattern voor scheduledJobs store. Idempotent.
async function _executeCLVCheck(payload) {
  const bet = payload || {};
  try {
    const loggedOdds = parseFloat(bet.odds);
    const matchName  = bet.wedstrijd || '';
    const markt      = bet.markt || '';

    const betSport = bet.sport || 'football';
    const fxId = bet.fixtureId || await findGameId(betSport, matchName);
    const closingOdds = await fetchCurrentOdds(betSport, fxId, markt, bet.tip, { strictBookie: true, matchName });
    const usedBookie = bet.tip || 'onbekend';

    if (!closingOdds) {
      // 1× retry over 5 min via store (persistent — overleeft restart)
      if (!bet._clvRetried && scheduledJobs?.enqueue) {
        await scheduledJobs.enqueue({
          job_type: 'clv_check',
          bet_id: bet.id || null,
          payload: { ...bet, _clvRetried: true },
          due_at: new Date(Date.now() + 5 * 60000).toISOString(),
        });
        console.log(`[CLV] retry gepland over 5 min voor "${matchName}"`);
        return;
      }
      logCheckFailure('clv', matchName, 'closing odds niet beschikbaar').catch(() => {});
      return;
    }

    const clvPct = +((loggedOdds - closingOdds) / closingOdds * 100).toFixed(2);
    const clvIcon = clvPct > 0 ? '✅' : '❌';
    await supabase.from('bets').update({ clv_odds: closingOdds, clv_pct: clvPct }).eq('bet_id', bet.id);
    await notify(`📊 CLV: ${matchName}\n🏦 ${usedBookie} | Gelogd: ${loggedOdds} → Slotlijn: ${closingOdds} | CLV: ${clvPct > 0 ? '+' : ''}${clvPct}% ${clvIcon}`).catch(() => {});
  } catch (err) {
    console.error('CLV check error:', err.message);
    throw err;
  }
}

async function scheduleCLVCheck(bet) {
  if (bet.scanType === 'live') return;
  const tijdStr = bet.tijd || bet.time;
  if (!tijdStr) return;
  const kickoffMs = parseBetKickoff(bet.datum, tijdStr);
  if (!Number.isFinite(kickoffMs)) return;

  const checkMs = kickoffMs - 2 * 60 * 1000;
  const delayMs = checkMs - Date.now();
  if (delayMs < 3000 || delayMs > 48 * 60 * 60 * 1000) return;

  if (scheduledJobs && typeof scheduledJobs.enqueue === 'function') {
    await scheduledJobs.enqueue({
      job_type: 'clv_check',
      bet_id: bet.id || null,
      payload: {
        id: bet.id, datum: bet.datum, tijd: tijdStr, odds: bet.odds,
        wedstrijd: bet.wedstrijd, markt: bet.markt, sport: bet.sport,
        tip: bet.tip, fixtureId: bet.fixtureId,
      },
      due_at: new Date(checkMs).toISOString(),
    });
  } else {
    setTimeout(() => _executeCLVCheck(bet).catch(() => {}), delayMs);
  }

  console.log(`📊 CLV check gepland voor "${bet.wedstrijd}" over ${Math.round(delayMs/60000)} min (2 min voor aftrap)`);
}

// v11.3.10 Phase 5.4r: POST /api/bets, PUT /api/bets/:id, POST /api/bets/recalculate
// en GET /api/bets/:id/current-odds verhuisd naar lib/routes/bets-write.js via
// factory-pattern. Lift-and-shift: zelfde gedrag, zelfde deps, zelfde responses.
const createBetsWriteRouter = require('./lib/routes/bets-write');
app.use('/api', createBetsWriteRouter({
  supabase,
  rateLimit,
  requireAdmin,
  readBets,
  writeBet,
  updateBetOutcome,
  getUserUnitEur,
  loadUsers,
  calcStats,
  defaultStartBankroll: START_BANKROLL,
  defaultUnitEur: UNIT_EUR,
  schedulePreKickoffCheck,
  scheduleCLVCheck,
  afGet,
  marketKeyFromBetMarkt,
}));

// v12.2.0: per-bookie bankroll balances (lijst + manual set).
const createBookieBalancesRouter = require('./lib/routes/bookie-balances');
app.use('/api', createBookieBalancesRouter({ bookieBalanceStore, rateLimit }));

// v11.2.2 Phase 5.2: CLV backfill + recompute + probe verhuisd naar
// lib/routes/clv.js via factory-pattern. Handelt admin-only vul van
// clv_odds/clv_pct, forced recompute na fetchCurrentOdds fixes, en
// one-bet probe voor diagnose.
const createClvRouter = require('./lib/routes/clv');
app.use('/api', createClvRouter({
  supabase,
  requireAdmin,
  findGameIdVerbose,
  fetchCurrentOdds,
  fetchSnapshotClosing,
  marketKeyFromBetMarkt,
  matchesClvRecomputeTarget,
  afRateLimit,
  sportRateLimits,
  refreshKillSwitch,
  KILL_SWITCH,
  autoTuneSignalsByClv,
  evaluateKellyAutoStepup,
}));


// v11.3.14 Phase 5.4v: /api/debug/odds + /api/debug/wl verhuisd naar
// lib/routes/debug.js via factory-pattern. Admin-only diagnostics,
// lift-and-shift zonder gedragswijziging.
const createDebugRouter = require('./lib/routes/debug');
app.use('/api', createDebugRouter({
  requireAdmin, normalizeSport, getSportApiConfig, afGet, readBets, calcStats,
}));


// v11.2.8 Phase 5.4f: /api/picks + /api/scan-history verhuisd naar
// lib/routes/picks.js. /api/potd + /api/analyze zijn in v11.3.11 · Phase 5.4s
// verhuisd naar lib/routes/analyze.js (mount hieronder).
const createPicksRouter = require('./lib/routes/picks');
app.use('/api', createPicksRouter({
  supabase, isValidUuid,
  getLastPrematchPicks: () => lastPrematchPicks,
  getLastLivePicks:     () => lastLivePicks,
  loadScanHistoryFromSheets, loadScanHistory,
  scanHistoryMax: SCAN_HISTORY_MAX,
}));

// v11.3.11 Phase 5.4s: GET /api/potd en POST /api/analyze verhuisd naar
// lib/routes/analyze.js via factory-pattern. Lift-and-shift, identiek gedrag.
const createAnalyzeRouter = require('./lib/routes/analyze');
app.use('/api', createAnalyzeRouter({
  rateLimit,
  requireAdmin,
  getLastPrematchPicks: () => lastPrematchPicks,
  getLastLivePicks:     () => lastLivePicks,
  loadScanHistoryFromSheets,
  loadScanHistory,
  getUserMoneySettings,
  readBets,
  loadUsers,
  afGet,
  getSportApiConfig,
}));

// API status · rate limits + service health
// Supabase DB usage — via eigen service_role key, toont DB-grootte + row counts
// voor de belangrijkste tabellen zodat je ziet hoe dicht bij de 500MB free-tier je zit.
// v11.3.1 Phase 5.4i: /api/admin/supabase-usage + /api/admin/scheduler-status
// verhuisd naar lib/routes/admin-observability.js.
const createAdminObservabilityRouter = require('./lib/routes/admin-observability');
app.use('/api', createAdminObservabilityRouter({
  supabase, requireAdmin, loadUsers,
  getUserScanTimers: (userId) => userScanTimers[userId],
  supabaseUrl: process.env.SUPABASE_URL,
}));

// v11.3.23 H1: /api/health public keep-alive endpoint.
const createHealthRouter = require('./lib/routes/health');
app.use('/api', createHealthRouter());

// v11.2.9 Phase 5.4g: /api/status toegevoegd aan lib/routes/info.js module
// (naast /api/version + /api/changelog). Alle meta/info routes één mount,
// expliciete deps inject.
const createInfoRouter = require('./lib/routes/info');
app.use('/api', createInfoRouter({
  appVersion: APP_VERSION,
  loadCalib,
  requireAdmin,
  afKey: AF_KEY,
  afRateLimit,
  sportRateLimits,
  getCurrentStakeRegime: () => _currentStakeRegime,
  leagues: {
    football:            AF_FOOTBALL_LEAGUES,
    basketball:          NBA_LEAGUES,
    hockey:              NHL_LEAGUES,
    baseball:             BASEBALL_LEAGUES,
    'american-football': NFL_LEAGUES,
    handball:            HANDBALL_LEAGUES,
  },
}));

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

// v11.3.13 Phase 5.4u: /api/admin/rebuild-calib + /api/admin/backfill-signals
// verhuisd naar lib/routes/admin-backfill.js via factory-pattern.
// Mutex state is module-scoped (was module-level let in server.js).
const createAdminBackfillRouter = require('./lib/routes/admin-backfill');
app.use('/api', createAdminBackfillRouter({
  supabase,
  requireAdmin,
  loadCalib,
  saveCalib,
  getUsersCache,
  normalizeSport,
  detectMarket,
  computeMarketMultiplier,
  refreshMarketSampleCounts,
  findGameId,
}));

// v11.3.15 Phase 5.4w: /api/notifications (aggregate alert-feed) verhuisd naar
// lib/routes/notifications-feed.js via factory-pattern. Inbox CRUD-routes
// staan al langer in lib/routes/notifications.js (v11.2.0).
const createNotificationsFeedRouter = require('./lib/routes/notifications-feed');
app.use('/api', createNotificationsFeedRouter({
  supabase, loadCalib, getAdminUserId, getUserMoneySettings, readBets, loadUsers,
}));
// v11.3.17 Phase 6.1: checkOpenBetResults verhuisd naar
// lib/runtime/check-open-bets.js via factory-pattern. Gedeeld door
// /api/check-results (tracker-router) en scheduleDailyResultsCheck cron.
const createOpenBetsChecker = require('./lib/runtime/check-open-bets');
const checkOpenBetResults = createOpenBetsChecker({
  supabase, readBets, updateBetOutcome, afGet, sendPushToUser,
});

// v11.2.4 Phase 5.4b: /api/check-results + /api/backfill-times verhuisd naar
// lib/routes/tracker.js. checkOpenBetResults zit sinds v11.3.17 in
// lib/runtime/check-open-bets.js (mount hierboven).
const createTrackerRouter = require('./lib/routes/tracker');
app.use('/api', createTrackerRouter({
  supabase, requireAdmin, readBets, checkOpenBetResults, afGet, sleep,
}));


// v11.3.12 Phase 5.4t: /api/live-poll, /api/live-scores, /api/live-events/:id
// verhuisd naar lib/routes/live.js via factory-pattern. Lift-and-shift,
// zelfde ESPN + api-football responses, zelfde dedup-logica.
const createLiveRouter = require('./lib/routes/live');
app.use('/api', createLiveRouter({
  afGet,
  leagues: {
    football:            AF_FOOTBALL_LEAGUES,
    basketball:          NBA_LEAGUES,
    hockey:              NHL_LEAGUES,
    baseball:            BASEBALL_LEAGUES,
    'american-football': NFL_LEAGUES,
    handball:            HANDBALL_LEAGUES,
  },
}));

// v11.3.18 Phase 6.2a: polling + heartbeat schedulers verhuisd naar
// lib/runtime/polling-schedulers.js. De 4 schedulers delen een factory;
// scheduleKickoffWindowPolling, scheduleFixtureSnapshotPolling,
// scheduleOddsMonitor, scheduleScanHeartbeatWatcher. Mount hieronder,
// start-calls blijven in boot-sequence.
const createPollingSchedulers = require('./lib/runtime/polling-schedulers');
const pollingSchedulers = createPollingSchedulers({
  supabase, afGet, sleep, notify,
  normalizeSport, getSportApiConfig,
  loadCalibAsync, saveCalib,
  readBets, getAdminUserId,
});
const scheduleKickoffWindowPolling = pollingSchedulers.scheduleKickoffWindowPolling;
const scheduleFixtureSnapshotPolling = pollingSchedulers.scheduleFixtureSnapshotPolling;
const scheduleOddsMonitor = pollingSchedulers.scheduleOddsMonitor;
const scheduleScanHeartbeatWatcher = pollingSchedulers.scheduleScanHeartbeatWatcher;




// v11.3.0 Phase 5.4h: /api/signal-analysis + /api/timing-analysis verhuisd
// naar lib/routes/analytics.js. Beide admin-only, lezen readBets en aggregeren
// op signals (hit-rate + avg CLV edge) resp. timing-buckets (>12h / 3-12h / <3h).
const createAnalyticsRouter = require('./lib/routes/analytics');
app.use('/api', createAnalyticsRouter({ requireAdmin, readBets }));


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
  scheduleScanHeartbeatWatcher();
  scheduleAutotune();
  scheduleBookieConcentrationWatcher();

  // v12.2.14 (D1): rescheduleer pending pre-kickoff/CLV jobs uit DB en
  // zet sweep-loop op (cleanup completed > 7d, mark overdue > 1u).
  scheduledJobs.rescheduleAllPending().catch(e => console.warn('scheduledJobs reschedule:', e.message));
  setInterval(() => scheduledJobs.sweep(), 10 * 60 * 1000);

  // v10.9.9: herstel persisted scrape-source toggles uit calib. Zonder dit
  // reset elke deploy alle sources naar default off — operationeel irritant.
  try {
    const scraperBase = require('./lib/integrations/scraper-base');
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
  // v10.12.23 Phase C.10: stake-regime engine bij boot laden zodat de
  // eerste scan meteen met de correcte regime-output draait (i.p.v. eerst
  // met `_currentStakeRegime=null` fallback kelly 0.5).
  recomputeStakeRegime().then(() => {
    if (_currentStakeRegime) {
      const r = _currentStakeRegime;
      console.log(`🎚️ Stake-regime (boot): ${r.regime} · Kelly ${r.kellyFraction} · unit ×${r.unitMultiplier}`);
    }
  });

  // Kill-switch initial load + 30-min refresh
  // Operator state laden VÓÓR kill-switch refresh zodat market_auto_kill_enabled correct staat
  loadOperatorState().then(() => refreshKillSwitch())
    .then(() => console.log(`🛑 Kill-switch geladen (${KILL_SWITCH.set.size} actief, OPERATOR: scan=${OPERATOR.master_scan_enabled}, market-kill=${OPERATOR.market_auto_kill_enabled}, signal-kill=${OPERATOR.signal_auto_kill_enabled}, panic=${OPERATOR.panic_mode}, scraping=${OPERATOR.scraping_enabled})`));

  // v10.9.0: circuit-breaker state-change → Supabase inbox notificatie zodat user
  // retroactief kan zien welke bron down/up ging. Rate-limit via breaker zelf
  // (alleen state-transitions tellen, niet elke fetch).
  try {
    const scraperBase = require('./lib/integrations/scraper-base');
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

  // v12.2.23 (R4 alerts): periodieke check op sharp-soft execution windows.
  // Stuurt push + inbox notification voor windows met gap >= 4pp en kickoff
  // binnen 6u. Dedupe via notifications.body LIKE 'sharpsoft:...'.
  const { summarizeSharpSoftWindows: _ss } = require('./lib/sharp-soft-windows');
  const { selectAlertableWindows: _ssAlerts } = require('./lib/sharp-soft-alerts');
  const { SHARP_BOOKIES: _SHARP } = require('./lib/line-timeline');
  async function runSharpSoftAlertsCheck() {
    try {
      const nowIso = new Date().toISOString();
      const untilIso = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
      const sinceIso = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
      const { data: fixtures } = await supabase.from('fixtures')
        .select('id, start_time, home_team_name, away_team_name, sport')
        .gte('start_time', nowIso).lte('start_time', untilIso).limit(500);
      if (!Array.isArray(fixtures) || !fixtures.length) return;
      const fxMap = new Map(fixtures.map(f => [f.id, f]));
      const { data: snaps } = await supabase.from('odds_snapshots')
        .select('fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds')
        .in('fixture_id', fixtures.map(f => f.id)).gte('captured_at', sinceIso).limit(20000);
      const adminUserId = await getAdminUserId().catch(() => null);
      const adminUser = (await loadUsers().catch(() => [])).find(u => u.role === 'admin');
      const preferred = (adminUser?.settings?.preferredBookies || ['Bet365', 'Unibet'])
        .map(x => String(x || '').toLowerCase()).filter(Boolean);
      const windows = _ss({
        snapshots: Array.isArray(snaps) ? snaps : [],
        fixtures: fxMap, sharpSet: _SHARP,
        softSet: new Set(preferred), threshold: 0.04, includeMirror: false,
      });
      // Recent alerts (last 12h) — body begint met 'sharpsoft:'.
      const since12h = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
      const { data: recent } = await supabase.from('notifications')
        .select('body').eq('type', 'sharp_soft_alert').gte('created_at', since12h).limit(500);
      const recentKeys = new Set();
      for (const r of (recent || [])) {
        const firstLine = String(r.body || '').split('\n')[0];
        if (firstLine.startsWith('sharpsoft:')) recentKeys.add(firstLine);
      }
      const alerts = _ssAlerts({
        windows, recentAlertKeys: recentKeys,
        minGapPp: 0.04, maxKickoffHours: 6,
      });
      if (!alerts.length) return;
      // Cap op 5 alerts per check tegen burst-spam.
      const toSend = alerts.slice(0, 5);
      for (const a of toSend) {
        const dbBody = `${a.alertKey}\n${a.body}`;
        try {
          await supabase.from('notifications').insert({
            type: 'sharp_soft_alert', title: a.title, body: dbBody,
            read: false, user_id: adminUserId,
          });
          if (adminUserId) await sendPushToUser(adminUserId, { title: a.title, body: a.body });
        } catch (e) { console.warn('[sharp-soft alerts] insert/push failed:', e?.message || e); }
      }
      console.log(`🎯 Sharp-soft alerts: ${toSend.length} verzonden (van ${alerts.length} kandidaten)`);
    } catch (e) {
      console.warn('[sharp-soft alerts] check failed:', e?.message || e);
    }
  }
  // Initiele run + elke 15 min.
  setTimeout(() => runSharpSoftAlertsCheck().catch(() => {}), 60 * 1000);
  setInterval(() => runSharpSoftAlertsCheck().catch(() => {}), 15 * 60 * 1000);

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
      schedulePreKickoffCheck(b).catch(e => console.warn(`[pre-kickoff] re-schedule failed voor bet ${b?.id}:`, e?.message || e));
      scheduleCLVCheck(b).catch(e => console.warn(`[CLV] re-schedule failed voor bet ${b?.id}:`, e?.message || e));
    });
    console.log(`⏱  Pre-kickoff + CLV checks herplanned voor ${openWithTime.length} open bet(s)`);
  }).catch(() => {});

  // Keep-alive voor Render free tier (voorkomt slaapstand na 15 min).
  // v11.3.23 H1: hit /api/health (public) ipv /api/status (auth-required).
  // Eerdere keep-alive kreeg 401 en had geen effect op slaapstand.
  if (process.env.RENDER_EXTERNAL_HOSTNAME) {
    const url = `https://${process.env.RENDER_EXTERNAL_HOSTNAME}/api/health`;
    console.log(`🔁 Keep-alive actief → ${url}`);
    setInterval(() => fetch(url).catch(e => console.warn('Keep-alive ping failed:', e.message)), 14 * 60 * 1000);
  }
});

// ── DAGELIJKSE PRE-MATCH SCAN (10:00 AM) ─────────────────────────────────────
// Plan een scan op een bepaald uur (0-23); geeft de timeout handle terug
// Accepteert zowel number (legacy: uur) als "HH:MM" string.

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
    .select('bet_id, datum, sport, markt, odds, tip, uitkomst, signals, fixture_id')
    .in('uitkomst', ['W', 'L'])
    .limit(10000);
  if (error) return { error: error.message, aggregated: 0 };

  const eligible = [];
  for (const b of betsRows || []) {
    const odds = parseFloat(b.odds);
    if (!Number.isFinite(odds) || odds <= 1.0) continue;
    const settledAt = _parseBetDatum(b.datum);
    if (!settledAt || settledAt < cutoffMs) continue;
    const signals = _parseSignalsBlob(b.signals);
    eligible.push({ raw: b, odds, settledAt, signals });
  }

  if (!eligible.length) return { aggregated: 0, settledCount: 0 };

  // v12.2.27 (canonical wire-up): pull pick_candidates joined met model_runs
  // voor alle relevante fixtures. Per bet → probeer canonical pick_ep match
  // via lib/bets-pick-join. Bets zonder fixture_id of zonder match vallen
  // terug op ep_proxy.
  const { buildBrierRecords: _bbRec, findMatchingPickCandidate: _findPC } = require('./lib/bets-pick-join');
  const fixtureIds = [...new Set(eligible.map(e => e.raw.fixture_id).filter(Boolean))];
  const candByFixture = new Map();
  if (fixtureIds.length) {
    try {
      // Chunk om Supabase URL-limieten te respecteren.
      for (let i = 0; i < fixtureIds.length; i += 200) {
        const chunk = fixtureIds.slice(i, i + 200);
        const { data: cands } = await supabase.from('pick_candidates')
          .select('id, model_run_id, fixture_id, selection_key, bookmaker, fair_prob, bookmaker_odds, passed_filters, model_runs!inner(market_type, line, captured_at)')
          .in('fixture_id', chunk)
          .limit(20000);
        for (const c of (cands || [])) {
          const fid = Number(c.fixture_id);
          if (!candByFixture.has(fid)) candByFixture.set(fid, []);
          candByFixture.get(fid).push(c);
        }
      }
    } catch (_) { /* fall back to ep_proxy if pull fails */ }
  }

  const settledCanonical = [];
  const settledProxy = [];
  for (const e of eligible) {
    const b = e.raw;
    const cands = candByFixture.get(Number(b.fixture_id)) || [];
    let canonicalMatch = null;
    if (cands.length) {
      try { canonicalMatch = _findPC({ fixture_id: b.fixture_id, markt: b.markt, tip: b.tip }, cands); }
      catch (_) { canonicalMatch = null; }
    }
    const baseRow = {
      uitkomst: b.uitkomst,
      settledAt: e.settledAt,
      signals: e.signals,
      sport: b.sport || null,
      marketType: detectMarket(b.markt || 'other'),
    };
    if (canonicalMatch && Number.isFinite(canonicalMatch.fair_prob) && canonicalMatch.fair_prob > 0 && canonicalMatch.fair_prob < 1) {
      settledCanonical.push({ ...baseRow, ep: canonicalMatch.fair_prob });
    } else {
      const implied = 1 / e.odds;
      const signalBoost = e.signals
        .map(s => { const m = /([+-]\d+\.?\d*)%/.exec(String(s)); return m ? parseFloat(m[1]) / 100 : 0; })
        .reduce((a, c) => a + c, 0);
      const ep = Math.max(0.02, Math.min(0.95, implied + signalBoost));
      settledProxy.push({ ...baseRow, ep });
    }
  }

  const passes = [
    { settled: settledCanonical, source: 'pick_ep' },
    { settled: settledProxy, source: 'ep_proxy' },
  ];

  let totalAggregated = 0;
  for (const pass of passes) {
    if (!pass.settled.length) continue;
    const aggregates = _calAggregateBySignal(pass.settled, { now });
    const rows = _buildCalibrationRows(aggregates, {
      windowEndMs: now,
      probabilitySource: pass.source,
    });
    if (!rows.length) continue;
    try {
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { error: upErr } = await supabase.from('signal_calibration')
          .upsert(chunk, { onConflict: 'signal_name,sport,market_type,window_key,probability_source' });
        if (upErr) {
          if (/relation .* does not exist/i.test(upErr.message || '')) {
            return { error: 'signal_calibration tabel nog niet gemigreerd', aggregated: totalAggregated };
          }
          // Pre-v12.2.27 schema heeft nog onConflict zonder probability_source.
          // Probeer fallback met oude conflict-key zodat upgrade pad werkt.
          if (/no unique or exclusion constraint/i.test(upErr.message || '')) {
            const { error: legacyErr } = await supabase.from('signal_calibration')
              .upsert(chunk, { onConflict: 'signal_name,sport,market_type,window_key' });
            if (legacyErr) return { error: legacyErr.message, aggregated: totalAggregated };
          } else {
            return { error: upErr.message, aggregated: totalAggregated };
          }
        }
      }
      totalAggregated += rows.length;
    } catch (e) {
      return { error: e.message, aggregated: totalAggregated };
    }
  }

  return {
    aggregated: totalAggregated,
    settledCount: eligible.length,
    canonicalCount: settledCanonical.length,
    proxyCount: settledProxy.length,
    canonicalCoveragePct: eligible.length ? +(settledCanonical.length / eligible.length * 100).toFixed(1) : 0,
  };
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
    const users = getUsersCache() || [];
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

// v11.3.20 Phase 6.2c: scheduleScanAtHour + scheduleDailyScan +
// scheduleDailyResultsCheck verhuisd naar lib/runtime/scan-schedulers.js.
// Mount aan het einde van server.js zodat updateCalibrationMonitor en
// evaluateActionableTodos (function-decls hierboven) bij factory-call tijd
// bestaan. App.listen-callback draait async ná module-load, dus deze const
// references resolven correct.
const createScanSchedulers = require('./lib/runtime/scan-schedulers');
const scanSchedulers = createScanSchedulers({
  supabase, loadUsers, notify,
  runFullScan, checkOpenBetResults,
  readBets, getAdminUserId,
  sendPushToAll,
  autoTuneSignals, evaluateKellyAutoStepup, autoTuneSignalsByClv,
  updateCalibrationMonitor, evaluateActionableTodos,
  getScanRunning: () => scanRunning,
  setScanRunning: (v) => { scanRunning = v; },
  userScanTimers,
});
const scheduleScanAtHour = scanSchedulers.scheduleScanAtHour;
const scheduleDailyScan = scanSchedulers.scheduleDailyScan;
const scheduleDailyResultsCheck = scanSchedulers.scheduleDailyResultsCheck;
