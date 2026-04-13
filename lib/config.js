'use strict';

const path           = require('path');
const { createClient } = require('@supabase/supabase-js');
const webpush        = require('web-push');

// ── SUPABASE CONFIG ──────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('FATAL: SUPABASE_URL and SUPABASE_KEY required'); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

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

// ── CONSTANTS ──────────────────────────────────────────────────────────────────
const APP_VERSION    = '8.3.0';
const TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT       = process.env.TELEGRAM_CHAT_ID || '';
const TG_URL     = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
const UNIT_EUR   = 25;
const START_BANKROLL = 250;

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

// ── SOFASCORE HEADERS ──────────────────────────────────────────────────────────
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

// ── HELPERS ────────────────────────────────────────────────────────────────────
const get    = (url) => fetch(url, { headers: H }).then(r => r.json()).catch(() => ({}));
const toD    = f => { if (!f || !f.includes('/')) return null; const [n,d] = f.split('/').map(Number); return +(1 + n/d).toFixed(2); };
const clamp  = (v, lo, hi) => Math.round(Math.min(hi, Math.max(lo, v)));
const sleep  = ms => new Promise(r => setTimeout(r, ms));

// ── PICK FACTORY CONSTANTS ──────────────────────────────────────────────────
const MAX_WINNER_ODDS  = 4.0;
const BLOWOUT_OPP_MAX  = 1.35;
const MIN_EP           = 0.52;
const KELLY_FRACTION   = 0.50;

// ── EP BUCKET ──────────────────────────────────────────────────────────────────
const EP_BUCKETS = ['0.28','0.30','0.38','0.45','0.55'];
function epBucketKey(ep) {
  if (ep >= 0.55) return '0.55';
  if (ep >= 0.45) return '0.45';
  if (ep >= 0.38) return '0.38';
  if (ep >= 0.30) return '0.30';
  return '0.28';
}
const DEFAULT_EPW = { '0.28':0.80, '0.30':0.95, '0.38':1.05, '0.45':1.15, '0.55':1.25 };

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
function getScanRunning() { return scanRunning; }
function setScanRunning(v) { scanRunning = v; }

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

// European cup league IDs · teams in these play midweek, risico op vermoeidheid
const EUROPEAN_CUP_IDS = new Set([2, 3, 848]); // UCL, UEL, UECL

// ── LAST PICKS (in-memory voor analyse tab) ──────────────────────────────────
let lastPrematchPicks = [];
let lastLivePicks = [];
function getLastPrematchPicks() { return lastPrematchPicks; }
function setLastPrematchPicks(v) { lastPrematchPicks = v; }
function getLastLivePicks() { return lastLivePicks; }
function setLastLivePicks(v) { lastLivePicks = v; }

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

// Whitelist: alleen deze extensies/bestanden serveren als statische files
const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2', '.ttf']);
const ALLOWED_FILES = new Set(['/manifest.json', '/sw.js']);

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

// Session-caches (worden éénmaal per scan gevuld)
const afCache = {
  teamStats: {},
  injuries:  {},
  referees:  {},
  h2h:       {},
};

// Team season statistics cache
const teamStatsCache = {}; // key = `${teamId}-${leagueId}-${season}`

module.exports = {
  supabase, JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSW,
  VAPID_PUBLIC, VAPID_PRIVATE,
  APP_VERSION, TOKEN, CHAT, TG_URL, UNIT_EUR, START_BANKROLL,
  AF_KEY, CURRENT_SEASON, SPLIT_SEASON, CALENDAR_SEASON,
  H, get, toD, clamp, sleep,
  MAX_WINNER_ODDS, BLOWOUT_OPP_MAX, MIN_EP, KELLY_FRACTION,
  EP_BUCKETS, epBucketKey, DEFAULT_EPW,
  rateLimit, rateLimitMap,
  getScanRunning, setScanRunning,
  TOP_FB, EUROPEAN_CUP_IDS,
  getLastPrematchPicks, setLastPrematchPicks,
  getLastLivePicks, setLastLivePicks,
  loginCodes, PUBLIC_PATHS, ALLOWED_EXTENSIONS, ALLOWED_FILES,
  afRateLimit, sportRateLimits, afCache, teamStatsCache,
};
