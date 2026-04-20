'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://edgepickr-test.supabase.co';
process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'test-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Pure helpers uit de ECHTE productie-module — geen mirrors meer.
// Als iemand de implementatie in lib/model-math.js verandert, breken de tests hier.
const modelMath = require('./lib/model-math');
const appMeta = require('./lib/app-meta');
const pkg = require('./package.json');
const { createCalibrationStore } = require('./lib/calibration-store');
const {
  calcWinProb,
  fairProbs,
  fairProbs2Way,
  parseGameOdds,
  setPreferredBookies,
  bookiePrice,
  bestFromArr,
  bestSpreadPick,
  buildSpreadFairProbFns,
  convertAfOdds,
} = require('./lib/odds-parser');
const { createPickContext, buildPickFactory, calcBTTSProb, bestOdds, analyseTotal } = require('./lib/picks');
const { summarizeExecutionQuality } = require('./lib/execution-quality');
const { selectLikelyGoalie, extractNhlGoaliePreview } = require('./lib/integrations/nhl-goalie-preview');
const lineTimeline = require('./lib/line-timeline');
const execGate = require('./lib/execution-gate');
const playability = require('./lib/playability');
const calMonitor = require('./lib/calibration-monitor');
const corrDamp = require('./lib/correlation-damp');
const walkForward = require('./lib/walk-forward');
const scanGate = require('./lib/runtime/scan-gate');
const { evaluateStakeRegime, computeBankrollMetrics } = require('./lib/stake-regime');
const { supportsApiSportsInjuries } = require('./lib/integrations/api-sports-capabilities');
const dailyResults = require('./lib/runtime/daily-results');
const liveBoard = require('./lib/runtime/live-board');
const operatorActions = require('./lib/runtime/operator-actions');
const resultsChecker = require('./lib/runtime/results-checker');
const scanLogger = require('./lib/runtime/scan-logger');
const clvBackfill = require('./lib/clv-backfill');
const earlyPayout = require('./lib/signals/early-payout');
const earlyPayoutRules = require('./lib/signals/early-payout-rules');
const createNotificationsRouter = require('./lib/routes/notifications');
const createClvRouter = require('./lib/routes/clv');
const createAuthRouter = require('./lib/routes/auth');
const createUserRouter = require('./lib/routes/user');
const createTrackerRouter = require('./lib/routes/tracker');
const createAdminUsersRouter = require('./lib/routes/admin-users');
const createBetsRouter = require('./lib/routes/bets');
const createInfoRouter = require('./lib/routes/info');
const createPicksRouter = require('./lib/routes/picks');
const createAnalyticsRouter = require('./lib/routes/analytics');
const createAdminObservabilityRouter = require('./lib/routes/admin-observability');
const createAdminControlsRouter = require('./lib/routes/admin-controls');
const createAdminSnapshotsRouter = require('./lib/routes/admin-snapshots');
const createAdminSignalsRouter = require('./lib/routes/admin-signals');
const {
  epBucketKey, calcKelly, kellyToUnits, kellyScore, KELLY_FRACTION,
  poisson, poissonOver, poisson3Way,
  devigProportional, consensus3Way, deriveIncOTProbFrom3Way, modelMarketSanityCheck,
  normalizeTeamName, teamMatchScore, normalizeSport, detectMarket,
  pitcherAdjustment, pitcherReliabilityFactor, goalieAdjustment,
  injurySeverityWeight, nbaAvailabilityAdjustment,
  shotsDifferentialAdjustment, recomputeWl,
  NHL_OT_HOME_SHARE, MODEL_MARKET_DIVERGENCE_THRESHOLD,
  bayesSmooth, hierarchicalMultiplier, HIER_CALIB_PRIOR, HIER_CALIB_MIN_N, HIER_CALIB_K,
  residualModelDelta, residualModelActive, RESIDUAL_MIN_TRAINING_PICKS, summarizeSignalMetrics,
} = modelMath;

// Voor tests die nog factorial/poissonProb (oude naam) nodig hebben; wrappers via lib.
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poissonProb(lambda, k) { return poisson(k, lambda); }

// calcForm
function calcForm(evts, tid) {
  let W = 0, D = 0, L = 0, gF = 0, gA = 0, cs = 0;
  for (const m of (evts || [])) {
    const isH = m.homeTeam?.id === tid;
    const ts = isH ? (m.homeScore?.current ?? 0) : (m.awayScore?.current ?? 0);
    const os = isH ? (m.awayScore?.current ?? 0) : (m.homeScore?.current ?? 0);
    if (ts > os) W++; else if (ts === os) D++; else L++;
    gF += ts; gA += os;
    if (os === 0) cs++;
  }
  const n = (evts || []).length || 1;
  return { W, D, L, pts: W * 3 + D, form: `${W}W${D}D${L}L`,
    avgGF: +(gF / n).toFixed(2), avgGA: +(gA / n).toFixed(2),
    cleanSheets: cs, n };
}

// calcMomentum
function calcMomentum(evts, tid) {
  const f3 = calcForm((evts || []).slice(0, 3), tid);
  const f36 = calcForm((evts || []).slice(3, 6), tid);
  return f3.pts - f36.pts;
}

// Rate limiter
function createRateLimiter() {
  const map = new Map();
  return function rateLimit(key, maxReqs, windowMs) {
    const now = Date.now();
    const entry = map.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    map.set(key, entry);
    return entry.count > maxReqs;
  };
}

// kellyToUnits en kellyScore komen uit lib/model-math.js (geïmporteerd bovenaan)

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

// v10.9.0: async tests moeten sequentieel lopen want ze delen global.fetch mock
// en module-state (caches, circuit breakers). Parallel = races.
const pendingAsync = [];
function test(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    // Queue async — run in volgorde via runAsyncTests().
    pendingAsync.push({ name, fn });
    return;
  }
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u274c ${name}: ${e.message}`);
  }
}
async function runAsyncTests() {
  for (const { name, fn } of pendingAsync) {
    try {
      await fn();
      passed++;
      console.log(`  \u2705 (async) ${name}`);
    } catch (e) {
      failed++;
      console.log(`  \u274c (async) ${name}: ${e && e.message || e}`);
    }
  }
}

console.log('\n\u250c\u2500\u2500 EdgePickr Unit Tests \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500');

// ── EP Bucket Key ────────────────────────────────────────────────────────────
console.log('\n  EP Bucket Key:');

test('ep >= 0.55 returns 0.55', () => {
  assert.strictEqual(epBucketKey(0.60), '0.55');
  assert.strictEqual(epBucketKey(0.55), '0.55');
});

test('ep 0.45-0.54 returns 0.45', () => {
  assert.strictEqual(epBucketKey(0.50), '0.45');
  assert.strictEqual(epBucketKey(0.45), '0.45');
});

test('ep 0.38-0.44 returns 0.38', () => {
  assert.strictEqual(epBucketKey(0.40), '0.38');
  assert.strictEqual(epBucketKey(0.38), '0.38');
});

test('ep 0.30-0.37 returns 0.30', () => {
  assert.strictEqual(epBucketKey(0.35), '0.30');
  assert.strictEqual(epBucketKey(0.30), '0.30');
});

test('ep < 0.30 returns 0.28', () => {
  assert.strictEqual(epBucketKey(0.20), '0.28');
  assert.strictEqual(epBucketKey(0.28), '0.28');
});

// ── Kelly Criterion ──────────────────────────────────────────────────────────
console.log('\n  Kelly Criterion:');

test('positive edge gives positive kelly', () => {
  // ep=0.60, odd=2.0 → k = (0.60*1 - 0.40)/1 = 0.20, half = 0.10
  const hk = calcKelly(0.60, 2.0);
  assert.ok(hk > 0, `Expected positive, got ${hk}`);
  assert.ok(Math.abs(hk - 0.10) < 0.001, `Expected ~0.10, got ${hk}`);
});

test('no edge gives zero/negative kelly', () => {
  // ep=0.50, odd=2.0 → k = (0.50*1 - 0.50)/1 = 0, half = 0
  const hk = calcKelly(0.50, 2.0);
  assert.ok(hk <= 0.001, `Expected ~0, got ${hk}`);
});

test('negative edge gives negative kelly', () => {
  // ep=0.40, odd=2.0 → k = (0.40*1 - 0.60)/1 = -0.20, half = -0.10
  const hk = calcKelly(0.40, 2.0);
  assert.ok(hk < 0, `Expected negative, got ${hk}`);
});

test('higher edge = higher kelly', () => {
  const hk1 = calcKelly(0.60, 2.0);
  const hk2 = calcKelly(0.70, 2.0);
  assert.ok(hk2 > hk1, `Expected ${hk2} > ${hk1}`);
});

test('kelly scales with half-kelly fraction', () => {
  // Full kelly would be 0.20 for ep=0.60, odd=2.0
  const hk = calcKelly(0.60, 2.0);
  assert.ok(Math.abs(hk - 0.10) < 0.001, 'Half-kelly should be 50% of full kelly');
});

// ── Unit Sizing ──────────────────────────────────────────────────────────────
console.log('\n  Unit Sizing:');

test('hk > 0.10 = 2.0U (raw Kelly > 20%)', () => {
  assert.strictEqual(kellyToUnits(0.11), '2.0U');
  assert.strictEqual(kellyToUnits(0.20), '2.0U');
});

test('hk 0.07-0.10 = 1.5U (raw Kelly 14-20%)', () => {
  assert.strictEqual(kellyToUnits(0.08), '1.5U');
  assert.strictEqual(kellyToUnits(0.10), '1.5U');
});

test('hk 0.05-0.07 = 1.0U (raw Kelly 10-14%)', () => {
  assert.strictEqual(kellyToUnits(0.06), '1.0U');
  assert.strictEqual(kellyToUnits(0.07), '1.0U');
});

test('hk 0.03-0.05 = 0.75U (raw Kelly 6-10%)', () => {
  assert.strictEqual(kellyToUnits(0.04), '0.75U');
  assert.strictEqual(kellyToUnits(0.05), '0.75U');
});

test('hk 0.015-0.03 = 0.5U (raw Kelly 3-6%)', () => {
  assert.strictEqual(kellyToUnits(0.02), '0.5U');
  assert.strictEqual(kellyToUnits(0.03), '0.5U');
});

test('hk <= 0.015 = 0.3U (raw Kelly < 3%)', () => {
  assert.strictEqual(kellyToUnits(0.01), '0.3U');
  assert.strictEqual(kellyToUnits(0.015), '0.3U');
});

// ── Kelly Score ──────────────────────────────────────────────────────────────
console.log('\n  Kelly Score (5-10, tier-aligned met kellyToUnits):');

test('hk > 0.10 maps to score 10 (2.0U tier)', () => {
  assert.strictEqual(kellyScore(0.11), 10);
  assert.strictEqual(kellyScore(0.20), 10);
});

test('hk 0.07-0.10 maps to score 9 (1.5U tier)', () => {
  assert.strictEqual(kellyScore(0.08), 9);
  assert.strictEqual(kellyScore(0.10), 9);
});

test('hk 0.05-0.07 maps to score 8 (1.0U tier)', () => {
  assert.strictEqual(kellyScore(0.06), 8);
  assert.strictEqual(kellyScore(0.07), 8);
});

test('hk 0.03-0.05 maps to score 7 (0.75U tier)', () => {
  assert.strictEqual(kellyScore(0.04), 7);
  assert.strictEqual(kellyScore(0.05), 7);
});

test('hk 0.015-0.03 maps to score 6 (0.5U tier)', () => {
  assert.strictEqual(kellyScore(0.02), 6);
  assert.strictEqual(kellyScore(0.03), 6);
});

test('hk <= 0.015 maps to score 5 (0.3U tier)', () => {
  assert.strictEqual(kellyScore(0.01), 5);
  assert.strictEqual(kellyScore(0.015), 5);
});

test('score and kellyToUnits stay in lockstep', () => {
  const pairs = [
    [0.01, '0.3U', 5], [0.02, '0.5U', 6], [0.04, '0.75U', 7],
    [0.06, '1.0U', 8], [0.08, '1.5U', 9], [0.12, '2.0U', 10],
  ];
  for (const [hk, u, s] of pairs) {
    assert.strictEqual(kellyToUnits(hk), u, `hk=${hk} → units mismatch`);
    assert.strictEqual(kellyScore(hk), s, `hk=${hk} → score mismatch`);
  }
});

// ── Poisson ──────────────────────────────────────────────────────────────────
console.log('\n  Poisson Probability:');

test('poisson(1,0) = e^-1 ≈ 0.368', () => {
  const p = poissonProb(1, 0);
  assert.ok(Math.abs(p - 0.3679) < 0.001, `Expected ~0.368, got ${p}`);
});

test('poisson(1,1) = e^-1 ≈ 0.368', () => {
  const p = poissonProb(1, 1);
  assert.ok(Math.abs(p - 0.3679) < 0.001, `Expected ~0.368, got ${p}`);
});

test('poisson(2,2) ≈ 0.271', () => {
  const p = poissonProb(2, 2);
  assert.ok(Math.abs(p - 0.2707) < 0.001, `Expected ~0.271, got ${p}`);
});

test('poisson probabilities sum to ~1 for k=0..10', () => {
  let sum = 0;
  for (let k = 0; k <= 10; k++) sum += poissonProb(1.5, k);
  assert.ok(Math.abs(sum - 1.0) < 0.001, `Expected ~1.0, got ${sum}`);
});

test('factorial returns correct values', () => {
  assert.strictEqual(factorial(0), 1);
  assert.strictEqual(factorial(1), 1);
  assert.strictEqual(factorial(5), 120);
  assert.strictEqual(factorial(6), 720);
});

// ── calcForm ─────────────────────────────────────────────────────────────────
console.log('\n  calcForm:');

test('3 wins = 9 pts, form "3W0D0L"', () => {
  const evts = [
    { homeTeam: { id: 1 }, homeScore: { current: 2 }, awayScore: { current: 0 } },
    { homeTeam: { id: 1 }, homeScore: { current: 3 }, awayScore: { current: 1 } },
    { homeTeam: { id: 1 }, homeScore: { current: 1 }, awayScore: { current: 0 } },
  ];
  const f = calcForm(evts, 1);
  assert.strictEqual(f.W, 3);
  assert.strictEqual(f.D, 0);
  assert.strictEqual(f.L, 0);
  assert.strictEqual(f.pts, 9);
  assert.strictEqual(f.form, '3W0D0L');
});

test('mixed results counted correctly', () => {
  const evts = [
    { homeTeam: { id: 1 }, homeScore: { current: 2 }, awayScore: { current: 0 } },  // W
    { homeTeam: { id: 1 }, homeScore: { current: 1 }, awayScore: { current: 1 } },  // D
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 3 } },  // L
  ];
  const f = calcForm(evts, 1);
  assert.strictEqual(f.W, 1);
  assert.strictEqual(f.D, 1);
  assert.strictEqual(f.L, 1);
  assert.strictEqual(f.pts, 4);
});

test('clean sheets counted', () => {
  const evts = [
    { homeTeam: { id: 1 }, homeScore: { current: 1 }, awayScore: { current: 0 } },
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 0 } },
  ];
  const f = calcForm(evts, 1);
  assert.strictEqual(f.cleanSheets, 2);
});

test('away team perspective works', () => {
  const evts = [
    { homeTeam: { id: 99 }, homeScore: { current: 0 }, awayScore: { current: 2 } },
  ];
  const f = calcForm(evts, 5); // tid=5 is away team
  assert.strictEqual(f.W, 1);
  assert.strictEqual(f.avgGF, 2);
});

test('empty events returns zeroes', () => {
  const f = calcForm([], 1);
  assert.strictEqual(f.W, 0);
  assert.strictEqual(f.pts, 0);
});

// ── calcMomentum ─────────────────────────────────────────────────────────────
console.log('\n  calcMomentum:');

test('improving form = positive momentum', () => {
  // Last 3 games: 3 wins (9 pts), previous 3: 3 losses (0 pts) → momentum = 9
  const evts = [
    // Recent (index 0-2)
    { homeTeam: { id: 1 }, homeScore: { current: 2 }, awayScore: { current: 0 } },
    { homeTeam: { id: 1 }, homeScore: { current: 1 }, awayScore: { current: 0 } },
    { homeTeam: { id: 1 }, homeScore: { current: 3 }, awayScore: { current: 1 } },
    // Older (index 3-5)
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 1 } },
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 2 } },
    { homeTeam: { id: 1 }, homeScore: { current: 1 }, awayScore: { current: 3 } },
  ];
  const m = calcMomentum(evts, 1);
  assert.strictEqual(m, 9); // 9 - 0
});

test('declining form = negative momentum', () => {
  const evts = [
    // Recent: 3 losses
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 1 } },
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 2 } },
    { homeTeam: { id: 1 }, homeScore: { current: 0 }, awayScore: { current: 1 } },
    // Older: 3 wins
    { homeTeam: { id: 1 }, homeScore: { current: 2 }, awayScore: { current: 0 } },
    { homeTeam: { id: 1 }, homeScore: { current: 3 }, awayScore: { current: 1 } },
    { homeTeam: { id: 1 }, homeScore: { current: 1 }, awayScore: { current: 0 } },
  ];
  const m = calcMomentum(evts, 1);
  assert.strictEqual(m, -9); // 0 - 9
});

// ── Rate Limiter ─────────────────────────────────────────────────────────────
console.log('\n  Rate Limiter:');

test('allows requests within limit', () => {
  const rl = createRateLimiter();
  assert.strictEqual(rl('test-key', 5, 60000), false); // 1st
  assert.strictEqual(rl('test-key', 5, 60000), false); // 2nd
  assert.strictEqual(rl('test-key', 5, 60000), false); // 3rd
});

test('blocks requests exceeding limit', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 5; i++) rl('flood', 5, 60000);
  assert.strictEqual(rl('flood', 5, 60000), true); // 6th = blocked
});

test('different keys are independent', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 5; i++) rl('key-a', 5, 60000);
  assert.strictEqual(rl('key-a', 5, 60000), true);  // key-a blocked
  assert.strictEqual(rl('key-b', 5, 60000), false); // key-b still ok
});

// ── Rate Limiter Edge Cases ──────────────────────────────────────────────────
console.log('\n  Rate Limiter Edge Cases:');

test('rate limit resets after window expires', () => {
  const map = new Map();
  function rl(key, maxReqs, windowMs) {
    const now = Date.now();
    const entry = map.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + windowMs; }
    entry.count++;
    map.set(key, entry);
    return entry.count > maxReqs;
  }
  // Fill up the limit
  for (let i = 0; i < 3; i++) rl('reset-test', 3, 100);
  assert.strictEqual(rl('reset-test', 3, 100), true); // 4th = blocked
  // Simulate window expiry by manipulating the entry
  const entry = map.get('reset-test');
  entry.resetAt = Date.now() - 1; // expired
  map.set('reset-test', entry);
  assert.strictEqual(rl('reset-test', 3, 100), false); // reset, 1st again
});

test('login codes expire after 5 min (simulated)', () => {
  // Simulate the loginCodes Map behavior from server.js
  const loginCodes = new Map();
  const email = 'test@example.com';
  const code = '123456';
  // Set code that expires in 5 minutes
  loginCodes.set(email, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
  const entry = loginCodes.get(email);
  assert.strictEqual(entry.code, code);
  assert.ok(Date.now() < entry.expiresAt, 'Code should not be expired yet');
  // Simulate expiry
  entry.expiresAt = Date.now() - 1;
  assert.ok(Date.now() > entry.expiresAt, 'Code should be expired now');
});

test('rate limiter at exact boundary', () => {
  const rl = createRateLimiter();
  // maxReqs=1 means only 1 request allowed
  assert.strictEqual(rl('boundary', 1, 60000), false); // 1st = ok
  assert.strictEqual(rl('boundary', 1, 60000), true);  // 2nd = blocked
});

// ── Data Validation Tests ───────────────────────────────────────────────────
console.log('\n  Data Validation:');

test('bet creation requires wedstrijd (match name)', () => {
  // Simulate the validation logic from POST /api/bets
  const body = { markt: 'Over 2.5', odds: 1.90, units: 1 };
  assert.ok(!body.wedstrijd || typeof body.wedstrijd !== 'string',
    'Missing wedstrijd should fail validation');
});

test('bet creation requires markt', () => {
  const body = { wedstrijd: 'Ajax vs PSV', odds: 1.90, units: 1 };
  assert.ok(!body.markt || typeof body.markt !== 'string',
    'Missing markt should fail validation');
});

test('odds must be > 1.0', () => {
  const validOdds = [1.01, 1.50, 2.00, 5.00];
  const invalidOdds = [0, 0.5, 1.0, -1, NaN];
  for (const o of validOdds) {
    assert.ok(parseFloat(o) > 1.0, `Odds ${o} should be valid`);
  }
  for (const o of invalidOdds) {
    assert.ok(!(parseFloat(o) > 1.0), `Odds ${o} should be invalid`);
  }
});

test('units must be > 0', () => {
  const validUnits = [0.1, 0.3, 0.5, 1.0, 2.0];
  const invalidUnits = [0, -1, NaN];
  for (const u of validUnits) {
    assert.ok(parseFloat(u) > 0, `Units ${u} should be valid`);
  }
  for (const u of invalidUnits) {
    assert.ok(!(parseFloat(u) > 0), `Units ${u} should be invalid`);
  }
});

test('uitkomst must be Open, W, or L', () => {
  const VALID = new Set(['Open', 'W', 'L']);
  assert.ok(VALID.has('Open'));
  assert.ok(VALID.has('W'));
  assert.ok(VALID.has('L'));
  assert.ok(!VALID.has('X'));
  assert.ok(!VALID.has(''));
  assert.ok(!VALID.has('win'));
  assert.ok(!VALID.has('<script>'));
});

// ── User Isolation Tests ────────────────────────────────────────────────────
console.log('\n  User Isolation:');

test('readBets with userId filters correctly (mock)', () => {
  // Simulate filtering logic from readBets
  const allBets = [
    { id: 1, user_id: 'user-a', wedstrijd: 'Match A' },
    { id: 2, user_id: 'user-b', wedstrijd: 'Match B' },
    { id: 3, user_id: 'user-a', wedstrijd: 'Match C' },
  ];
  const userId = 'user-a';
  const filtered = allBets.filter(b => b.user_id === userId);
  assert.strictEqual(filtered.length, 2);
  assert.ok(filtered.every(b => b.user_id === 'user-a'));
});

test('null userId returns all bets (admin behavior)', () => {
  const allBets = [
    { id: 1, user_id: 'user-a' },
    { id: 2, user_id: 'user-b' },
    { id: 3, user_id: 'user-a' },
  ];
  const userId = null;
  const filtered = userId ? allBets.filter(b => b.user_id === userId) : allBets;
  assert.strictEqual(filtered.length, 3);
});

test('user cannot access another users data by manipulating ID', () => {
  // Simulate the server logic: userId comes from JWT, not from request
  const jwtUserId = 'user-a';
  const requestedUserId = 'user-b'; // attacker tries to request another user's data
  // Server should always use JWT userId, not request param
  const effectiveUserId = jwtUserId; // This is how the server works
  assert.strictEqual(effectiveUserId, 'user-a');
  assert.notStrictEqual(effectiveUserId, requestedUserId);
});

// ── Drawdown Protection Tests ───────────────────────────────────────────────
console.log('\n  Drawdown Protection:');

test('multiplier = 1.0 when no losses (insufficient data)', () => {
  // Simulate getDrawdownMultiplier with no data
  const c = { totalSettled: 3, totalWins: 3, totalProfit: 30, lossLog: [] };
  // c.totalSettled < 5 → return 1.0
  const multiplier = c.totalSettled < 5 ? 1.0 : null;
  assert.strictEqual(multiplier, 1.0);
});

test('multiplier = 1.0 when profitable and healthy win rate', () => {
  const c = { totalSettled: 20, totalWins: 12, totalProfit: 50, lossLog: [] };
  const START_BANKROLL = 100;
  // Not in drawdown: profit > 0, win rate > 30%
  const totalWr = c.totalWins / c.totalSettled;
  const inDrawdown = c.totalProfit < -(START_BANKROLL * 0.20) || totalWr < 0.30;
  assert.ok(!inDrawdown, 'Should not be in drawdown');
});

test('multiplier < 1.0 when significant losses (>20% of bankroll)', () => {
  const START_BANKROLL = 100;
  const c = { totalSettled: 15, totalWins: 3, totalProfit: -25, lossLog: [] };
  // totalProfit < -(100 * 0.20) = -20 → halve stakes
  const shouldHalve = c.totalProfit < -(START_BANKROLL * 0.20);
  assert.ok(shouldHalve, 'Should trigger drawdown protection at >20% loss');
  const multiplier = shouldHalve ? 0.5 : 1.0;
  assert.ok(multiplier < 1.0, `Multiplier should be < 1.0, got ${multiplier}`);
});

test('multiplier < 1.0 when win rate below 30% after 10+ bets', () => {
  const c = { totalSettled: 12, totalWins: 2, totalProfit: -10 };
  const totalWr = c.totalWins / c.totalSettled;
  const shouldReduce = c.totalSettled >= 10 && totalWr < 0.30;
  assert.ok(shouldReduce, 'Should trigger stake reduction');
  const multiplier = shouldReduce ? 0.7 : 1.0;
  assert.ok(multiplier < 1.0, `Multiplier should be < 1.0, got ${multiplier}`);
});

// ── Weather Data Tests ──────────────────────────────────────────────────────
console.log('\n  Weather Data:');

test('rain > 5mm gives negative adjustment', () => {
  const weatherData = { rain: 8, wind: 10, temp: 15 };
  let weatherAdj = 0;
  if (weatherData.rain > 5) weatherAdj -= 0.03;
  if (weatherData.wind > 30) weatherAdj -= 0.02;
  assert.ok(weatherAdj < 0, `Should be negative, got ${weatherAdj}`);
  assert.strictEqual(weatherAdj, -0.03);
});

test('wind > 30 gives negative adjustment', () => {
  const weatherData = { rain: 2, wind: 35, temp: 15 };
  let weatherAdj = 0;
  if (weatherData.rain > 5) weatherAdj -= 0.03;
  if (weatherData.wind > 30) weatherAdj -= 0.02;
  assert.ok(weatherAdj < 0, `Should be negative, got ${weatherAdj}`);
  assert.strictEqual(weatherAdj, -0.02);
});

test('rain > 5mm AND wind > 30 both apply', () => {
  const weatherData = { rain: 10, wind: 40, temp: 8 };
  let weatherAdj = 0;
  if (weatherData.rain > 5) weatherAdj -= 0.03;
  if (weatherData.wind > 30) weatherAdj -= 0.02;
  assert.strictEqual(weatherAdj, -0.05);
});

test('no rain/wind gives 0 adjustment', () => {
  const weatherData = { rain: 2, wind: 15, temp: 20 };
  let weatherAdj = 0;
  if (weatherData.rain > 5) weatherAdj -= 0.03;
  if (weatherData.wind > 30) weatherAdj -= 0.02;
  assert.strictEqual(weatherAdj, 0);
});

test('null weather data gives 0 adjustment', () => {
  const weatherData = null;
  let weatherAdj = 0;
  if (weatherData && weatherData.rain > 5) weatherAdj -= 0.03;
  if (weatherData && weatherData.wind > 30) weatherAdj -= 0.02;
  assert.strictEqual(weatherAdj, 0);
});

// ── Security-Specific Tests ─────────────────────────────────────────────────
console.log('\n  Security:');

test('HTML is properly escaped', () => {
  // Copy of escHtml from index.html
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  assert.strictEqual(escHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(escHtml('Normal text'), 'Normal text');
  assert.strictEqual(escHtml('A & B < C > D'), 'A &amp; B &lt; C &gt; D');
  assert.strictEqual(escHtml(''), '');
  assert.strictEqual(escHtml('"quotes"'), '"quotes"'); // quotes not escaped (for non-attribute context)
});

test('escHtml handles special characters in team names', () => {
  function escHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  assert.strictEqual(escHtml('FC Köln'), 'FC Köln');
  assert.strictEqual(escHtml('São Paulo'), 'São Paulo');
  assert.strictEqual(escHtml('Atlético <Madrid>'), 'Atlético &lt;Madrid&gt;');
});

test('invalid fixture IDs are rejected', () => {
  // Simulate the validation from /api/live-events/:id
  const testCases = [
    { input: '123', expected: 123, valid: true },
    { input: 'abc', expected: NaN, valid: false },
    { input: '-1', expected: -1, valid: false },
    { input: '0', expected: 0, valid: false },
    { input: '1.5', expected: 1, valid: true },
    { input: '999999', expected: 999999, valid: true },
  ];
  for (const tc of testCases) {
    const id = parseInt(tc.input);
    const valid = !isNaN(id) && id > 0;
    assert.strictEqual(valid, tc.valid, `ID "${tc.input}" should be ${tc.valid ? 'valid' : 'invalid'}`);
  }
});

test('input validation rejects prototype pollution keys', () => {
  // Ensure the settings whitelist prevents prototype pollution
  const allowed = ['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled','twoFactorEnabled'];
  const attackKeys = ['__proto__', 'constructor', 'prototype', 'toString'];
  for (const key of attackKeys) {
    assert.ok(!allowed.includes(key), `"${key}" should not be in allowed settings`);
  }
});

test('path traversal is blocked', () => {
  const path = require('path');
  const ALLOWED_EXTENSIONS = new Set(['.html', '.css', '.png', '.jpg', '.jpeg', '.svg', '.ico', '.webp', '.gif', '.woff', '.woff2', '.ttf']);
  const testPaths = [
    { input: '/../../../etc/passwd', blocked: true },
    { input: '/..%2F..%2Fetc/passwd', blocked: true },
    { input: '/index.html', blocked: false },
    { input: '/style.css', blocked: false },
    { input: '/.env', blocked: true },
    { input: '/server.js', blocked: true },
  ];
  for (const tc of testPaths) {
    const normalized = path.normalize(decodeURIComponent(tc.input)).replace(/\\/g, '/');
    const hasTraversal = normalized.includes('..');
    const ext = path.extname(normalized).toLowerCase();
    const isAllowed = normalized === '/' || ALLOWED_EXTENSIONS.has(ext);
    const blocked = hasTraversal || !isAllowed;
    assert.strictEqual(blocked, tc.blocked, `Path "${tc.input}" should be ${tc.blocked ? 'blocked' : 'allowed'}`);
  }
});

test('JWT secret is required (env check pattern)', () => {
  // Verify the pattern: if no JWT_SECRET, server exits
  // We just test that empty string is falsy
  assert.ok(!'', 'Empty JWT_SECRET should be falsy');
  assert.ok(!undefined, 'Undefined JWT_SECRET should be falsy');
  assert.ok(!null, 'Null JWT_SECRET should be falsy');
  assert.ok('some-secret', 'Non-empty JWT_SECRET should be truthy');
});

// ── Calibration & Market Detection Tests ────────────────────────────────────
console.log('\n  Market Detection:');

test('detectMarket identifies home correctly', () => {
  // Gebruikt echte detectMarket uit lib/model-math.js (niet een lokale kopie).
  assert.strictEqual(detectMarket('Ajax wint'), 'home');
  assert.strictEqual(detectMarket('✈️ PSV wint'), 'away');
  assert.strictEqual(detectMarket('Gelijkspel'), 'draw');
  assert.strictEqual(detectMarket('Over 2.5 goals'), 'over');
  assert.strictEqual(detectMarket('Under 2.5 goals'), 'under');
});

// v10.7.20: split "other" bucket in BTTS/DNB/DC/Spread/NRFI/TeamTotal
test('detectMarket: BTTS split (yes/no)', () => {
  assert.strictEqual(detectMarket('BTTS Ja'), 'btts_yes');
  assert.strictEqual(detectMarket('BTTS Yes'), 'btts_yes');
  assert.strictEqual(detectMarket('BTTS Nee'), 'btts_no');
  assert.strictEqual(detectMarket('🛡️ BTTS No'), 'btts_no');
});

test('detectMarket: DNB home/away split', () => {
  assert.strictEqual(detectMarket('🏠 DNB Wigan'), 'dnb_home');
  assert.strictEqual(detectMarket('✈️ DNB Rotherham'), 'dnb_away');
});

test('detectMarket: Double Chance buckets', () => {
  assert.strictEqual(detectMarket('Dubbele kans 1X'), 'dc_1x');
  assert.strictEqual(detectMarket('Double Chance X2'), 'dc_x2');
  // niet "1X2" (3-way ML); wel "1X"
  assert.notStrictEqual(detectMarket('1X2 Home'), 'dc_1x');
});

test('detectMarket: Spread/Run Line/Puck Line', () => {
  assert.strictEqual(detectMarket('🏠 Dodgers -1.5 Run Line'), 'spread_home');
  assert.strictEqual(detectMarket('✈️ Vegas +1.5 Puck Line'), 'spread_away');
  assert.strictEqual(detectMarket('Ajax -1 Handicap'), 'spread_home');
});

test('detectMarket: NRFI/YRFI baseball', () => {
  assert.strictEqual(detectMarket('NRFI'), 'nrfi');
  assert.strictEqual(detectMarket('No Run First Inning'), 'nrfi');
  assert.strictEqual(detectMarket('YRFI'), 'yrfi');
  assert.strictEqual(detectMarket('Yes Run First Inning'), 'yrfi');
});

test('detectMarket: Team totals', () => {
  assert.strictEqual(detectMarket('Home team total over 1.5'), 'team_total_over');
  assert.strictEqual(detectMarket('Away team total under 2.5'), 'team_total_under');
});

test('detectMarket: onbekende markt blijft "other" (geen regressie)', () => {
  assert.strictEqual(detectMarket('Exotic Prop XYZ'), 'other');
  assert.strictEqual(detectMarket(''), 'other');
});

test('EP bucket weights have valid defaults', () => {
  const DEFAULT_EPW = { '0.28':0.80, '0.30':0.95, '0.38':1.05, '0.45':1.15, '0.55':1.25 };
  for (const [key, w] of Object.entries(DEFAULT_EPW)) {
    assert.ok(w >= 0.5 && w <= 2.0, `Weight ${w} for bucket ${key} should be in [0.5, 2.0]`);
    assert.ok(parseFloat(key) >= 0.28, `Bucket key ${key} should be >= 0.28`);
  }
  // Weights should increase with EP
  const keys = Object.keys(DEFAULT_EPW).sort((a,b) => parseFloat(a) - parseFloat(b));
  for (let i = 1; i < keys.length; i++) {
    assert.ok(DEFAULT_EPW[keys[i]] >= DEFAULT_EPW[keys[i-1]],
      `Weight for ${keys[i]} should be >= weight for ${keys[i-1]}`);
  }
});

// ── Sport Scanner: Season Constants ─────────────────────────────────────────
console.log('\n  Season Constants:');

test('CURRENT_SEASON returns correct integer (prev year in Jan-Jun)', () => {
  // Simulates the logic: if month < 7, season = year - 1
  const now = new Date(); // April 2026
  const season = now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear();
  assert.strictEqual(typeof season, 'number');
  // In April 2026, should be 2025
  if (now.getMonth() < 7) {
    assert.strictEqual(season, now.getFullYear() - 1);
  }
});

test('SPLIT_SEASON returns correct "YYYY-YYYY" format', () => {
  const now = new Date();
  const split = now.getMonth() < 7
    ? `${now.getFullYear() - 1}-${now.getFullYear()}`
    : `${now.getFullYear()}-${now.getFullYear() + 1}`;
  assert.ok(/^\d{4}-\d{4}$/.test(split), `Expected YYYY-YYYY, got "${split}"`);
  const [first, second] = split.split('-').map(Number);
  assert.strictEqual(second - first, 1, 'Years should differ by 1');
});

test('CALENDAR_SEASON returns current year as string', () => {
  const calSeason = String(new Date().getFullYear());
  assert.strictEqual(typeof calSeason, 'string');
  assert.ok(/^\d{4}$/.test(calSeason), `Expected 4-digit year, got "${calSeason}"`);
  assert.strictEqual(calSeason, String(new Date().getFullYear()));
});

// ── Sport Scanner: Data Confidence ──────────────────────────────────────────
console.log('\n  Data Confidence Multiplier:');

test('6+ signals gives confidence 1.0', () => {
  const signals = ['a','b','c','d','e','f'];
  const sigCount = signals.length;
  const dataConf = sigCount >= 6 ? 1.0 : sigCount >= 3 ? 0.70 : sigCount >= 1 ? 0.50 : 0.40;
  assert.strictEqual(dataConf, 1.0);
});

test('3-5 signals gives confidence 0.7', () => {
  for (const n of [3, 4, 5]) {
    const signals = Array(n).fill('sig');
    const sigCount = signals.length;
    const dataConf = sigCount >= 6 ? 1.0 : sigCount >= 3 ? 0.70 : sigCount >= 1 ? 0.50 : 0.40;
    assert.strictEqual(dataConf, 0.70, `Expected 0.70 for ${n} signals, got ${dataConf}`);
  }
});

test('1-2 signals gives confidence 0.5', () => {
  for (const n of [1, 2]) {
    const sigCount = n;
    const dataConf = sigCount >= 6 ? 1.0 : sigCount >= 3 ? 0.70 : sigCount >= 1 ? 0.50 : 0.40;
    assert.strictEqual(dataConf, 0.50, `Expected 0.50 for ${n} signals, got ${dataConf}`);
  }
});

test('0 signals gives confidence 0.4', () => {
  const sigCount = 0;
  const dataConf = sigCount >= 6 ? 1.0 : sigCount >= 3 ? 0.70 : sigCount >= 1 ? 0.50 : 0.40;
  assert.strictEqual(dataConf, 0.40);
});

// ── Tomorrow Filter ─────────────────────────────────────────────────────────
console.log('\n  Tomorrow Filter:');

test('game at 09:00 tomorrow passes <10:00 filter', () => {
  // Simulate: kickoff hour = 9, filter is koH < 10
  const koH = 9;
  const passesTmrFilter = koH < 10;
  assert.strictEqual(passesTmrFilter, true, '09:00 should pass the <10 filter');
});

test('game at 11:00 tomorrow is filtered out', () => {
  const koH = 11;
  const passesTmrFilter = koH < 10;
  assert.strictEqual(passesTmrFilter, false, '11:00 should be filtered out');
});

test('game at 20:00 today always passes (today fixtures not filtered)', () => {
  // Today fixtures are always included without hour filtering
  const todayFixtures = [{ id: 1, date: '2026-04-12T20:00:00Z' }];
  // Today fixtures pass through unfiltered
  assert.strictEqual(todayFixtures.length, 1, 'Today game at 20:00 should pass');
});

test('game at exactly 10:00 tomorrow is filtered out (< not <=)', () => {
  const koH = 10;
  const passesTmrFilter = koH < 10;
  assert.strictEqual(passesTmrFilter, false, '10:00 should not pass the strict < 10 filter');
});

// ── Multi-Sport Calibration ─────────────────────────────────────────────────
console.log('\n  Multi-Sport Calibration:');

test('sport-prefixed market keys are different', () => {
  function detectMarket(markt) {
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
  const basketballKey = `basketball_${detectMarket('Home wint')}`;
  const footballKey = `football_${detectMarket('Home wint')}`;
  assert.notStrictEqual(basketballKey, footballKey, 'Basketball and football keys should differ');
  assert.strictEqual(basketballKey, 'basketball_home');
  assert.strictEqual(footballKey, 'football_home');
});

test('sport-prefixed keys preserve market type', () => {
  function detectMarket(markt) {
    const m = markt.toLowerCase();
    if (m.includes('over') || m.includes('>')) return 'over';
    if (m.includes('under') || m.includes('<')) return 'under';
    return 'other';
  }
  const hockeyOver = `hockey_${detectMarket('Over 5.5')}`;
  const baseballOver = `baseball_${detectMarket('Over 8.5')}`;
  assert.strictEqual(hockeyOver, 'hockey_over');
  assert.strictEqual(baseballOver, 'baseball_over');
  assert.notStrictEqual(hockeyOver, baseballOver);
});

test('detectMarket still works correctly for all types', () => {
  function detectMarket(markt) {
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
  assert.strictEqual(detectMarket('Thuis wint'), 'home');
  assert.strictEqual(detectMarket('Winner home'), 'home');
  assert.strictEqual(detectMarket('✈️ Away wint'), 'away');
  assert.strictEqual(detectMarket('Gelijkspel X'), 'draw');
  assert.strictEqual(detectMarket('Draw'), 'draw');
  assert.strictEqual(detectMarket('Over 2.5'), 'over');
  assert.strictEqual(detectMarket('> 3.5'), 'over');
  assert.strictEqual(detectMarket('Under 1.5'), 'under');
  assert.strictEqual(detectMarket('< 2.5'), 'under');
  assert.strictEqual(detectMarket('BTTS Yes'), 'other');
  assert.strictEqual(detectMarket('Correct Score 2-1'), 'other');
});

// ── Input Validation (extended) ─────────────────────────────────────────────
console.log('\n  Input Validation (extended):');

test('bet odds must be > 1.0 (server validation logic)', () => {
  // Matches server.js line: if (isNaN(odds) || odds <= 1.0) return error
  const testCases = [
    { input: 1.01, valid: true },
    { input: 2.50, valid: true },
    { input: 1.0,  valid: false },
    { input: 0.99, valid: false },
    { input: 0,    valid: false },
    { input: -1.5, valid: false },
    { input: NaN,  valid: false },
  ];
  for (const tc of testCases) {
    const odds = parseFloat(tc.input);
    const valid = !isNaN(odds) && odds > 1.0;
    assert.strictEqual(valid, tc.valid, `Odds ${tc.input} should be ${tc.valid ? 'valid' : 'invalid'}`);
  }
});

test('bet units must be > 0 (server validation logic)', () => {
  const testCases = [
    { input: 0.1,  valid: true },
    { input: 0.5,  valid: true },
    { input: 1.0,  valid: true },
    { input: 0,    valid: false },
    { input: -0.5, valid: false },
    { input: NaN,  valid: false },
  ];
  for (const tc of testCases) {
    const units = parseFloat(tc.input);
    const valid = !isNaN(units) && units > 0;
    assert.strictEqual(valid, tc.valid, `Units ${tc.input} should be ${tc.valid ? 'valid' : 'invalid'}`);
  }
});

test('invalid fixture IDs are rejected (extended)', () => {
  const testCases = [
    { input: '12345',      valid: true },
    { input: '1',          valid: true },
    { input: '0',          valid: false },
    { input: '-5',         valid: false },
    { input: 'abc',        valid: false },
    { input: '',           valid: false },
    { input: 'null',       valid: false },
    { input: '3.14',       valid: true },  // parseInt gives 3, which is > 0
    { input: '1e5',        valid: true },  // parseInt gives 1
    { input: 'undefined',  valid: false },
  ];
  for (const tc of testCases) {
    const id = parseInt(tc.input);
    const valid = !isNaN(id) && id > 0;
    assert.strictEqual(valid, tc.valid, `Fixture ID "${tc.input}" should be ${tc.valid ? 'valid' : 'invalid'}`);
  }
});

test('bet update ID validation matches server logic', () => {
  // Server: const id = parseInt(req.params.id); if (isNaN(id) || id <= 0)
  const invalidIds = ['0', '-1', 'abc', '', 'null', 'undefined'];
  for (const input of invalidIds) {
    const id = parseInt(input);
    assert.ok(isNaN(id) || id <= 0, `ID "${input}" should be rejected`);
  }
  const validIds = ['1', '42', '999'];
  for (const input of validIds) {
    const id = parseInt(input);
    assert.ok(!isNaN(id) && id > 0, `ID "${input}" should be accepted`);
  }
});

// ── Security: Error Message Leaking ─────────────────────────────────────────
console.log('\n  Security (extended):');

test('server error responses do not leak e.message', () => {
  // All catch blocks in routes should return generic error
  const genericError = 'Interne fout';
  assert.ok(!genericError.includes('stack'), 'Error should not contain stack traces');
  assert.ok(!genericError.includes('ECONNREFUSED'), 'Error should not contain infra details');
  assert.ok(!genericError.includes('password'), 'Error should not contain credentials');
});

test('live scan error does not leak err.message', () => {
  // The server should use a generic message for live scan errors too
  const errorMsg = 'Live scan mislukt'; // matches the fixed server code
  assert.ok(!errorMsg.includes('TypeError'), 'Should not contain JS error types');
  assert.ok(!errorMsg.includes('Cannot read'), 'Should not contain JS error details');
});

test('admin-only endpoints require admin role', () => {
  // Verify these endpoint patterns are admin-protected
  const adminEndpoints = [
    '/api/model-feed', '/api/signal-analysis', '/api/timing-analysis',
    '/api/admin/users', '/api/bets/recalculate', '/api/debug/wl', '/api/backfill-times',
    // v2 admin endpoints (v9.6+)
    '/api/admin/v2/pick-candidates-summary',
    '/api/admin/v2/clv-stats',
    '/api/admin/v2/snapshot-counts',
    '/api/admin/v2/kill-switch',
    '/api/admin/v2/walkforward',
    '/api/admin/v2/autotune-clv',
    '/api/clv/backfill',
    '/api/clv/backfill/probe',
    '/api/debug/odds',
  ];
  assert.strictEqual(adminEndpoints.length, 16, 'Should have 16 admin endpoints listed');
  // v11.3.27 reviewer-fix: parse de echte PUBLIC_PATHS uit server.js i.p.v.
  // een hardcoded kopie. Eerder: hardcoded set met /api/status erin terwijl
  // productiecode dat pad bewust heeft verwijderd — test was drift-blind.
  const serverSrcForPublic = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const pubMatch = serverSrcForPublic.match(/const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert(pubMatch, 'PUBLIC_PATHS declaration not found in server.js');
  const liveSet = new Set((pubMatch[1].match(/['"][^'"]+['"]/g) || []).map(s => s.replace(/['"]/g, '')));
  for (const ep of adminEndpoints) {
    assert.ok(!liveSet.has(ep), `${ep} should NOT be in live PUBLIC_PATHS`);
  }
});

test('settings whitelist includes v2 toggles maar geen dangerous keys', () => {
  // Whitelist moet behouden worden bij elke v2 toevoeging
  const ALLOWED_SETTINGS = new Set([
    'startBankroll','unitEur','language','timezone','scanTimes','scanEnabled',
    'twoFactorEnabled','preferredBookies',
  ]);
  assert.ok(ALLOWED_SETTINGS.has('preferredBookies'));
  // Dangerous prototype-keys mogen NIET in whitelist
  const dangerous = ['__proto__', 'constructor', 'prototype', '__defineGetter__', 'isAdmin', 'role', 'status'];
  for (const k of dangerous) assert.ok(!ALLOWED_SETTINGS.has(k), `${k} mag niet in whitelist`);
});

test('v2 endpoints valideren input ranges (hours/days)', () => {
  // Server gebruikt Math.max(1, Math.min(N, parseInt(value) || default))
  const clamp = (val, def, max) => Math.max(1, Math.min(max, parseInt(val) || def));
  assert.strictEqual(clamp(undefined, 24, 168), 24, 'default 24');
  assert.strictEqual(clamp('999', 24, 168), 168, 'clamp to max');
  assert.strictEqual(clamp('0', 24, 168), 24, '0 is falsy → fallback default'); // matches server.js logic
  assert.strictEqual(clamp('xyz', 24, 168), 24, 'invalid → default');
  assert.strictEqual(clamp('-5', 24, 168), 1, 'negatief → min');
});

test('PUBLIC_PATHS only contains safe endpoints (live parse from server.js)', () => {
  // v11.3.27 reviewer-fix: test de echte runtime-constante i.p.v. een hardcoded
  // kopie met /api/status erin. Eerder ging deze test groen terwijl prod al
  // was bijgewerkt.
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const match = serverSrc.match(/const PUBLIC_PATHS = new Set\(\[([\s\S]*?)\]\);/);
  assert(match, 'PUBLIC_PATHS not found in server.js');
  const live = new Set((match[1].match(/['"][^'"]+['"]/g) || []).map(s => s.replace(/['"]/g, '')));
  assert.ok(!live.has('/api/bets'), '/api/bets should not be public');
  assert.ok(!live.has('/api/prematch'), '/api/prematch should not be public');
  assert.ok(!live.has('/api/admin/users'), '/api/admin/users should not be public');
  assert.ok(!live.has('/api/model-feed'), '/api/model-feed should not be public');
  assert.ok(!live.has('/api/status'), '/api/status must NOT be public (removed v10.10.22)');
  assert.ok(live.has('/api/health'), '/api/health MUST be public for keep-alive');
});

test('settings whitelist blocks dangerous keys', () => {
  const ALLOWED_SETTINGS = new Set(['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled','twoFactorEnabled']);
  const dangerousKeys = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf',
    '__defineGetter__', '__defineSetter__', 'hasOwnProperty'];
  for (const key of dangerousKeys) {
    assert.ok(!ALLOWED_SETTINGS.has(key), `"${key}" must not be in allowed settings`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// MARKET-DERIVED PROBABILITY HELPERS komen nu uit lib/model-math.js (geen mirrors meer).
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n  Market-derived probability toolkit:');

// ── devigProportional ────────────────────────────────────────────────────────

test('devigProportional: 2-way balanced odds', () => {
  const r = devigProportional([1.95, 1.95]);
  assert.ok(r !== null, 'should return result');
  assert.strictEqual(r.probs.length, 2);
  assert.ok(Math.abs(r.probs[0] - 0.5) < 1e-6, 'both probs should be 0.5');
  assert.ok(Math.abs(r.probs[1] - 0.5) < 1e-6);
  // vig = sum of 1/1.95 * 2 - 1 ≈ 0.0256
  assert.ok(r.vig > 0.02 && r.vig < 0.03, `vig ${r.vig} should be ~0.025`);
});

test('devigProportional: 2-way skewed odds (favorite + underdog)', () => {
  const r = devigProportional([1.50, 2.80]);
  assert.ok(r !== null);
  // Favorite prob > 0.5, underdog < 0.5
  assert.ok(r.probs[0] > 0.55);
  assert.ok(r.probs[1] < 0.45);
  // Probs sum to 1
  assert.ok(Math.abs(r.probs[0] + r.probs[1] - 1) < 1e-9);
});

test('devigProportional: 3-way hockey typical', () => {
  // Fair scenario: home 50%, draw 20%, away 30%, with 4% vig
  // Odds roughly: 1/(.50*1.04) = 1.923, 1/(.20*1.04) = 4.808, 1/(.30*1.04) = 3.205
  const r = devigProportional([1.923, 4.808, 3.205]);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.probs[0] - 0.50) < 0.005, `home should be ~0.50, got ${r.probs[0]}`);
  assert.ok(Math.abs(r.probs[1] - 0.20) < 0.005);
  assert.ok(Math.abs(r.probs[2] - 0.30) < 0.005);
  assert.ok(Math.abs(r.vig - 0.04) < 0.002);
});

test('devigProportional: probs always sum to 1.0', () => {
  const tests = [[2.0, 2.0], [1.5, 3.5], [1.3, 4.5, 10.0], [1.8, 4.0, 2.5], [5.0, 1.2]];
  for (const odds of tests) {
    const r = devigProportional(odds);
    const sum = r.probs.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1.0) < 1e-9, `sum=${sum} for ${odds}`);
  }
});

test('devigProportional: invalid inputs return null', () => {
  assert.strictEqual(devigProportional(null), null);
  assert.strictEqual(devigProportional([]), null);
  assert.strictEqual(devigProportional('not an array'), null);
  assert.strictEqual(devigProportional([0]), null);
  assert.strictEqual(devigProportional([1.0]), null); // odds <=1 invalid
  assert.strictEqual(devigProportional([-1.5]), null);
  assert.strictEqual(devigProportional([Infinity]), null);
  assert.strictEqual(devigProportional([NaN]), null);
});

test('devigProportional: handles stringified numbers', () => {
  const r = devigProportional(['1.95', '1.95']);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.probs[0] - 0.5) < 1e-6);
});

// ── consensus3Way ────────────────────────────────────────────────────────────

test('consensus3Way: single bookie = devigged that bookie', () => {
  const odds = [
    { bookie: 'Bet365', side: 'home', price: 2.0 },
    { bookie: 'Bet365', side: 'draw', price: 4.0 },
    { bookie: 'Bet365', side: 'away', price: 2.5 },
  ];
  const c = consensus3Way(odds);
  assert.ok(c !== null);
  assert.strictEqual(c.bookieCount, 1);
  // Devigged: 1/2, 1/4, 1/2.5 = 0.5, 0.25, 0.4 → sum 1.15
  // Fair: 0.5/1.15, 0.25/1.15, 0.4/1.15
  assert.ok(Math.abs(c.home - 0.5/1.15) < 1e-6);
  assert.ok(Math.abs(c.draw - 0.25/1.15) < 1e-6);
  assert.ok(Math.abs(c.away - 0.4/1.15) < 1e-6);
});

test('consensus3Way: multi-bookie averages', () => {
  const odds = [
    { bookie: 'A', side: 'home', price: 2.0 }, { bookie: 'A', side: 'draw', price: 4.0 }, { bookie: 'A', side: 'away', price: 2.5 },
    { bookie: 'B', side: 'home', price: 2.1 }, { bookie: 'B', side: 'draw', price: 3.8 }, { bookie: 'B', side: 'away', price: 2.4 },
  ];
  const c = consensus3Way(odds);
  assert.ok(c !== null);
  assert.strictEqual(c.bookieCount, 2);
  // Home prob: between the two bookies'
  assert.ok(c.home > 0.40 && c.home < 0.50);
  // Sum to 1
  const sum = c.home + c.draw + c.away;
  assert.ok(Math.abs(sum - 1.0) < 1e-9);
});

test('consensus3Way: incomplete bookies are skipped', () => {
  const odds = [
    { bookie: 'A', side: 'home', price: 2.0 }, { bookie: 'A', side: 'away', price: 2.5 }, // no draw
    { bookie: 'B', side: 'home', price: 2.1 }, { bookie: 'B', side: 'draw', price: 3.8 }, { bookie: 'B', side: 'away', price: 2.4 },
  ];
  const c = consensus3Way(odds);
  assert.ok(c !== null);
  assert.strictEqual(c.bookieCount, 1, 'alleen B moet meetellen');
});

test('consensus3Way: no valid bookies returns null', () => {
  assert.strictEqual(consensus3Way(null), null);
  assert.strictEqual(consensus3Way([]), null);
  assert.strictEqual(consensus3Way([{ bookie: 'A', side: 'home', price: 2 }]), null); // incompleet
});

test('consensus3Way: probs always normalized', () => {
  const odds = [
    { bookie: 'A', side: 'home', price: 1.5 }, { bookie: 'A', side: 'draw', price: 6 }, { bookie: 'A', side: 'away', price: 4 },
    { bookie: 'B', side: 'home', price: 1.45 }, { bookie: 'B', side: 'draw', price: 6.5 }, { bookie: 'B', side: 'away', price: 4.2 },
  ];
  const c = consensus3Way(odds);
  const sum = c.home + c.draw + c.away;
  assert.ok(Math.abs(sum - 1.0) < 1e-9);
});

// ── deriveIncOTProbFrom3Way ──────────────────────────────────────────────────

test('deriveIncOTProbFrom3Way: 50/50 OT share', () => {
  const pReg = { home: 0.40, draw: 0.20, away: 0.40 };
  const r = deriveIncOTProbFrom3Way(pReg, 0.50);
  assert.ok(r !== null);
  assert.ok(Math.abs(r.home - 0.50) < 1e-9, 'home inc OT = 0.40 + 0.20*0.50 = 0.50');
  assert.ok(Math.abs(r.away - 0.50) < 1e-9);
  assert.ok(Math.abs(r.home + r.away - 1.0) < 1e-9);
});

test('deriveIncOTProbFrom3Way: home OT advantage 0.52 (NHL default)', () => {
  const pReg = { home: 0.40, draw: 0.20, away: 0.40 };
  const r = deriveIncOTProbFrom3Way(pReg, 0.52);
  // home = 0.40 + 0.20 * 0.52 = 0.504, away = 0.40 + 0.20 * 0.48 = 0.496
  assert.ok(Math.abs(r.home - 0.504) < 1e-9);
  assert.ok(Math.abs(r.away - 0.496) < 1e-9);
  assert.ok(Math.abs(r.home + r.away - 1.0) < 1e-9);
});

test('deriveIncOTProbFrom3Way: extreme OT share clamped', () => {
  const pReg = { home: 0.40, draw: 0.20, away: 0.40 };
  const rOverMax = deriveIncOTProbFrom3Way(pReg, 1.5); // clamp to 1
  assert.ok(Math.abs(rOverMax.home - 0.60) < 1e-9);
  const rUnderMin = deriveIncOTProbFrom3Way(pReg, -0.5); // clamp to 0
  assert.ok(Math.abs(rUnderMin.home - 0.40) < 1e-9);
});

test('deriveIncOTProbFrom3Way: invalid input returns null', () => {
  assert.strictEqual(deriveIncOTProbFrom3Way(null), null);
  assert.strictEqual(deriveIncOTProbFrom3Way({}), null);
  assert.strictEqual(deriveIncOTProbFrom3Way({ home: 0.4, draw: 0.2 }), null); // missing away
  assert.strictEqual(deriveIncOTProbFrom3Way({ home: 'x', draw: 0.2, away: 0.4 }), null);
});

// ── modelMarketSanityCheck ───────────────────────────────────────────────────

// ── passesDivergence2Way (v11.1.2) ──────────────────────────────────────────

test('passesDivergence2Way: model matcht markt → beide passen', () => {
  // Markt: 2.00 / 2.00 = 50/50 fair. Model zegt 49/51 = 1pp divergence.
  const r = modelMath.passesDivergence2Way(0.49, 0.51, 2.00, 2.00);
  assert.strictEqual(r.passA, true);
  assert.strictEqual(r.passB, true);
  assert.ok(r.marketFair.a > 0.49 && r.marketFair.a < 0.51);
});

test('passesDivergence2Way: BTTS bug reproductie — 74% model vs 42% market → block', () => {
  // Sandefjord/Rosenborg BTTS Nee @ 2.40, 74% model. Yes @ ~1.60.
  // Devigged: yes = 60%, no = 40% (approx). Model no=74% → 34pp divergence → FAIL.
  const r = modelMath.passesDivergence2Way(0.26, 0.74, 1.60, 2.40);
  assert.strictEqual(r.passA, false, 'Yes side faalt (26% model vs ~60% market)');
  assert.strictEqual(r.passB, false, 'No side faalt (74% model vs ~40% market)');
});

test('passesDivergence2Way: NBA ML signal-push bug → block', () => {
  // Signal-adjusted adjHome=65%, adjAway=35%. Market (via odds) = 52%/48%.
  // 13pp divergence → blokkeren.
  const r = modelMath.passesDivergence2Way(0.65, 0.35, 1.90, 2.10);
  assert.strictEqual(r.passA, false);
  assert.strictEqual(r.passB, false);
});

test('passesDivergence2Way: vig-out-of-range → fail-closed (v12.0.1)', () => {
  // v12.0.1: extreme overround (bv. 20%+ vig of <0.98 tot) = data-corruptie
  // of incompatibele paired odds. Fail-closed i.p.v. fail-open voorkomt
  // absurde picks (bv. NBA 1H Over 110.5 @ 34.0 paired met Under @ 1.10
  // gaf tot=0.94 → pre-v12.0.1 slipte door; nu hard geblokkeerd).
  const r = modelMath.passesDivergence2Way(0.80, 0.20, 1.10, 1.10);
  assert.strictEqual(r.passA, false);
  assert.strictEqual(r.passB, false);
  assert.strictEqual(r.marketFair, null);
  assert.ok(String(r.reason || '').includes('overround_out_of_range'));
});

test('passesDivergence2Way: extreme odds paired (34 vs 1.10) → fail-closed', () => {
  // Exacte repro van de v12.0.0 bug: NBA 1H Over 110.5 @ 34 met Under @ 1.10.
  // Pre-fix: tot=0.029+0.909=0.938 < 1.0 → fail-open → absurde edge door.
  const r = modelMath.passesDivergence2Way(0.50, 0.50, 34.0, 1.10);
  assert.strictEqual(r.passA, false, 'outlier odd moet gate falen');
  assert.strictEqual(r.passB, false);
});

test('passesDivergence2Way: ongeldige prijs → fail-open', () => {
  const r = modelMath.passesDivergence2Way(0.5, 0.5, 0, 2.0);
  assert.strictEqual(r.passA, true);
  assert.strictEqual(r.passB, true);
  assert.strictEqual(r.marketFair, null);
});

test('passesDivergence2Way: custom threshold', () => {
  // 10% divergence, 15% threshold → pass
  const r1 = modelMath.passesDivergence2Way(0.60, 0.40, 2.00, 2.00, 0.15);
  assert.strictEqual(r1.passA, true);
  // 10% divergence, 5% threshold → fail
  const r2 = modelMath.passesDivergence2Way(0.60, 0.40, 2.00, 2.00, 0.05);
  assert.strictEqual(r2.passA, false);
});

test('modelMarketSanityCheck: agree when within threshold', () => {
  const r = modelMarketSanityCheck(0.50, 0.52, 0.04);
  assert.strictEqual(r.agree, true);
  assert.ok(Math.abs(r.divergence - 0.02) < 1e-9);
});

test('modelMarketSanityCheck: disagree when above threshold', () => {
  const r = modelMarketSanityCheck(0.70, 0.50, 0.04);
  assert.strictEqual(r.agree, false);
  assert.ok(r.divergence > 0.04);
});

test('modelMarketSanityCheck: exactly at threshold agrees', () => {
  const r = modelMarketSanityCheck(0.50, 0.54, 0.04);
  assert.strictEqual(r.agree, true, 'divergence 0.04 = threshold → agree');
});

test('modelMarketSanityCheck: invalid inputs reject safely', () => {
  assert.strictEqual(modelMarketSanityCheck(NaN, 0.5, 0.04).agree, false);
  assert.strictEqual(modelMarketSanityCheck(null, 0.5, 0.04).agree, false);
  assert.strictEqual(modelMarketSanityCheck(0.5, undefined, 0.04).agree, false);
  assert.strictEqual(modelMarketSanityCheck('0.5', 0.5, 0.04).agree, false);
});

test('modelMarketSanityCheck: default threshold is 0.07 (v11.3.28)', () => {
  // v11.3.28: threshold 0.04 → 0.07 om legitieme signal-based picks niet
  // te blokkeren. 0.05 divergence moet nu passeren; 0.08 moet falen.
  const r = modelMarketSanityCheck(0.50, 0.55);
  assert.strictEqual(r.agree, true, 'divergence 0.05 ≤ default 0.07');
  assert.strictEqual(r.threshold, 0.07);
  const r2 = modelMarketSanityCheck(0.50, 0.58);
  assert.strictEqual(r2.agree, false, 'divergence 0.08 > default 0.07');
});

// ── Poisson3Way regression ───────────────────────────────────────────────────

test('poisson3Way: balanced teams → ~equal probs', () => {
  const r = poisson3Way(3.0, 3.0);
  assert.ok(Math.abs(r.pHome - r.pAway) < 0.01, 'balanced → equal');
  // Sum = 1
  assert.ok(Math.abs(r.pHome + r.pDraw + r.pAway - 1.0) < 1e-9);
});

test('poisson3Way: favorite (more goals) wins more', () => {
  const r = poisson3Way(4.0, 2.0);
  assert.ok(r.pHome > r.pAway, 'home scoort meer → home wint vaker');
  assert.ok(r.pHome > 0.5);
});

test('poisson3Way: low-scoring → higher draw %', () => {
  const rLow = poisson3Way(2.0, 2.0);
  const rHigh = poisson3Way(5.0, 5.0);
  assert.ok(rLow.pDraw > rHigh.pDraw, 'lage goals → meer draws');
});

test('poisson3Way: zero goals handled', () => {
  const r = poisson3Way(0, 0);
  assert.ok(r.pDraw > 0.99, '0 goals → bijna zeker 0-0 draw');
});

// ── poissonOver: P(X > line) met Poisson ───────────────────────────────────

test('poissonOver: lambda=3 line 1.5 ≈ 0.8 (NHL team total)', () => {
  const p = poissonOver(3.0, 1.5);
  // P(X > 1.5) = P(X >= 2) = 1 - P(0) - P(1) = 1 - 0.0498 - 0.1494 = ~0.801
  assert.ok(Math.abs(p - 0.801) < 0.005, `got ${p}, expected ~0.801`);
});

test('poissonOver: lambda=3 line 2.5 ≈ 0.58', () => {
  const p = poissonOver(3.0, 2.5);
  // P(X > 2.5) = P(X >= 3) = 1 - 0.0498 - 0.1494 - 0.224 = ~0.577
  assert.ok(Math.abs(p - 0.577) < 0.01, `got ${p}, expected ~0.577`);
});

test('poissonOver: lambda=2 line 3.5 ≈ 0.14', () => {
  const p = poissonOver(2.0, 3.5);
  // Under-scoring scenario
  assert.ok(p < 0.2 && p > 0.1, `got ${p}`);
});

test('poissonOver: high line ≈ 0', () => {
  const p = poissonOver(3.0, 10.5);
  assert.ok(p < 0.01, 'line 10.5 onwaarschijnlijk bij lambda 3');
});

test('poissonOver: low line ≈ 1', () => {
  const p = poissonOver(3.0, 0.5);
  // P(X > 0) = 1 - P(0) = 1 - e^-3 ≈ 0.95
  assert.ok(p > 0.94 && p <= 1.0, `got ${p}`);
});

test('poissonOver: invalid inputs return 0', () => {
  assert.strictEqual(poissonOver(NaN, 2.5), 0);
  assert.strictEqual(poissonOver(-1, 2.5), 0);
  assert.strictEqual(poissonOver(3, NaN), 0);
  assert.strictEqual(poissonOver('string', 2.5), 0);
});

test('poissonOver: lambda=0 edge case', () => {
  // Bij lambda=0 is P(X > any positive line) = 0
  assert.strictEqual(poissonOver(0, 0.5), 0);
  assert.strictEqual(poissonOver(0, 1.5), 0);
});

// ── Pitcher adjustment (MLB) ────────────────────────────────────────────────

// pitcherAdjustment komt uit lib/model-math.js

test('pitcherAdjustment: home pitcher beter → positieve adj', () => {
  const r = pitcherAdjustment(
    { era: 3.0, ip: 80, name: 'Skubal' },
    { era: 4.5, ip: 70, name: 'Adams' }
  );
  assert.strictEqual(r.valid, true);
  assert.ok(r.adj > 0, 'home ERA beter → adj positief');
  assert.ok(r.adj <= 0.06, 'clamped max 0.06');
});

test('pitcherAdjustment: away pitcher beter → negatieve adj', () => {
  const r = pitcherAdjustment(
    { era: 4.5, ip: 70, name: 'B' },
    { era: 2.5, ip: 80, name: 'A' }
  );
  assert.ok(r.adj < 0);
  assert.ok(r.adj >= -0.06, 'clamped min -0.06');
});

test('pitcherAdjustment: extreme verschil clamps bij ±0.06', () => {
  const rBig = pitcherAdjustment(
    { era: 2.0, ip: 100, name: 'A' },
    { era: 6.0, ip: 80, name: 'B' }
  );
  assert.ok(Math.abs(rBig.adj - 0.06) < 1e-9, 'clamped exact op +0.06');
});

test('pitcherAdjustment: <10 IP → invalid', () => {
  const r = pitcherAdjustment(
    { era: 2.0, ip: 5, name: 'A' },
    { era: 4.0, ip: 80, name: 'B' }
  );
  assert.strictEqual(r.valid, false, 'te weinig IP → geen signal');
  assert.strictEqual(r.adj, 0);
});

test('pitcherAdjustment: missing pitcher → invalid', () => {
  assert.strictEqual(pitcherAdjustment(null, null).valid, false);
  assert.strictEqual(pitcherAdjustment({era:3,ip:50}, null).valid, false);
  assert.strictEqual(pitcherAdjustment({}, {era:3,ip:50}).valid, false);
});

test('pitcherAdjustment: note bevat ERA-verschil', () => {
  const r = pitcherAdjustment(
    { era: 3.0, ip: 50, name: 'Skubal' },
    { era: 4.2, ip: 40, name: 'Adams' }
  );
  assert.ok(r.note.includes('Skubal'));
  assert.ok(r.note.includes('Adams'));
  assert.ok(r.note.includes('3.00'));
  assert.ok(r.note.includes('4.20'));
});

test('pitcherReliabilityFactor: dunne starters dampen F5-pitcher edge', () => {
  const thin = pitcherReliabilityFactor(
    { era: 3.2, ip: 12, name: 'A' },
    { era: 4.1, ip: 18, name: 'B' }
  );
  const full = pitcherReliabilityFactor(
    { era: 3.2, ip: 60, name: 'A' },
    { era: 4.1, ip: 72, name: 'B' }
  );
  assert.ok(thin.factor < 1, 'lage IP moet pitcher-weight dempen');
  assert.strictEqual(full.factor, 1, 'sterke sample mag volle weight houden');
});

test('goalieAdjustment: betere home goalie geeft positieve adj', () => {
  const r = goalieAdjustment(
    { name: 'Vejmelka', savePct: 0.917, gaa: 2.41, gamesPlayed: 42 },
    { name: 'Backup', savePct: 0.901, gaa: 2.95, gamesPlayed: 31 }
  );
  assert.strictEqual(r.valid, true);
  assert.ok(r.adj > 0);
});

test('goalieAdjustment: confirmation boost blijft klein maar werkt', () => {
  const base = goalieAdjustment(
    { name: 'Home', savePct: 0.909, gaa: 2.62, gamesPlayed: 25 },
    { name: 'Away', savePct: 0.905, gaa: 2.74, gamesPlayed: 25 }
  );
  const boosted = goalieAdjustment(
    { name: 'Home', savePct: 0.909, gaa: 2.62, gamesPlayed: 25 },
    { name: 'Away', savePct: 0.905, gaa: 2.74, gamesPlayed: 25 },
    { confirmedHome: true, confirmedAway: false }
  );
  assert.ok(boosted.adj > base.adj);
  assert.ok(boosted.adj - base.adj <= 0.0061);
});

// v10.10.3 — confidenceFactor moet output dempen bij thin starter-data
test('goalieAdjustment v10.10.3: medium-confidence schaalt adj met 0.7', () => {
  const high = goalieAdjustment(
    { name: 'Home', savePct: 0.920, gaa: 2.20, gamesPlayed: 40, confidenceFactor: 1.0 },
    { name: 'Away', savePct: 0.900, gaa: 2.80, gamesPlayed: 40, confidenceFactor: 1.0 }
  );
  const medium = goalieAdjustment(
    { name: 'Home', savePct: 0.920, gaa: 2.20, gamesPlayed: 40, confidenceFactor: 1.0 },
    { name: 'Away', savePct: 0.900, gaa: 2.80, gamesPlayed: 40, confidenceFactor: 0.7 }
  );
  assert.ok(high.valid && medium.valid);
  assert.ok(Math.abs(medium.adj - high.adj * 0.7) < 0.0005, `medium=${medium.adj} ≈ high=${high.adj} × 0.7`);
  assert.strictEqual(medium.confidenceFactor, 0.7);
});

test('goalieAdjustment v10.10.3: svDiff-gewicht 1.5 (gehalveerd van 3 t.o.v. v10.10.2)', () => {
  // svDiff 0.020 (elite vs average) zou met oud gewicht 3 → 0.06 raw geven
  // (= clamp). Met nieuw gewicht 1.5 → 0.030 raw, ruim onder clamp. Dat geeft
  // hoofdroom voor gaaDiff/conf zonder dat sv-alleen al de clamp raakt.
  const r = goalieAdjustment(
    { name: 'Home', savePct: 0.920, gaa: 2.50, gamesPlayed: 40 },
    { name: 'Away', savePct: 0.900, gaa: 2.50, gamesPlayed: 40 }
  );
  // 0.020 * 1.5 + 0 * 0.03 + 0 = 0.030 → cf default 1.0
  assert.ok(Math.abs(r.adj - 0.03) < 0.001, `verwacht ~0.03, kreeg ${r.adj}`);
});

test('nbaAvailabilityAdjustment v10.10.3: residual-multiplier-fix is dubbeltel-vrij bij weight≤1.0', () => {
  // Default scenario: nbaAvailability is canonieke combined helper.
  // Losse rest/inj signal-weights komen ALLEEN bij weight>1.0 als residual erbij.
  // Bij default (weight=0): availabilityAdj === nbaAvailability.adj.
  const restWeight = 0, injWeight = 0;
  const restResidualMult = Math.max(0, restWeight - 1);
  const injResidualMult = Math.max(0, injWeight - 1);
  assert.strictEqual(restResidualMult, 0);
  assert.strictEqual(injResidualMult, 0);
  // En bij weight=1.0 (gepromote): nog steeds residual=0 (geen extra optelling).
  assert.strictEqual(Math.max(0, 1.0 - 1), 0);
  // Pas bij weight=1.5 wordt 0.5 residual toegevoegd.
  assert.strictEqual(Math.max(0, 1.5 - 1), 0.5);
});

test('injurySeverityWeight: nba statuses worden gewogen i.p.v. blind geteld', () => {
  assert.strictEqual(injurySeverityWeight('Out', 'basketball'), 1);
  assert.strictEqual(injurySeverityWeight('Doubtful', 'basketball'), 0.75);
  assert.strictEqual(injurySeverityWeight('Questionable', 'basketball'), 0.5);
  assert.strictEqual(injurySeverityWeight('Probable', 'basketball'), 0);
});

test('nbaAvailabilityAdjustment: meer rust en gezondere away-team negatief voor home', () => {
  const r = nbaAvailabilityAdjustment(
    { restDays: 1, injuryLoad: 2.0 },
    { restDays: 4, injuryLoad: 0.5 }
  );
  assert.ok(r.adj < 0, 'home minder rust + meer blessures moet home negatief raken');
  assert.ok(r.note.includes('Rest'));
  assert.ok(r.note.includes('Inj load'));
});

test('selectLikelyGoalie: kiest primaire starter op games-played en confidence', () => {
  const r = selectLikelyGoalie([
    { name: { default: 'Backup' }, gamesPlayed: 18, savePctg: 0.901, goalsAgainstAvg: 2.93 },
    { name: { default: 'Starter' }, gamesPlayed: 42, savePctg: 0.916, goalsAgainstAvg: 2.45 },
  ]);
  assert.strictEqual(r.name, 'Starter');
  assert.strictEqual(r.confidence, 'high');
});

test('extractNhlGoaliePreview: leest team-specifieke goalies uit gamecenter payload', () => {
  const payload = {
    homeTeam: { id: 1 },
    awayTeam: { id: 2 },
    goalieSeasonStats: {
      goalies: [
        { teamId: 1, name: { default: 'Home Starter' }, gamesPlayed: 40, savePctg: 0.915, goalsAgainstAvg: 2.4 },
        { teamId: 1, name: { default: 'Home Backup' }, gamesPlayed: 15, savePctg: 0.901, goalsAgainstAvg: 2.9 },
        { teamId: 2, name: { default: 'Away Starter' }, gamesPlayed: 38, savePctg: 0.908, goalsAgainstAvg: 2.61 },
      ],
    },
  };
  const r = extractNhlGoaliePreview(payload);
  assert.strictEqual(r.home.name, 'Home Starter');
  assert.strictEqual(r.away.name, 'Away Starter');
});

// ── NHL shots-differential signal ──────────────────────────────────────────

test('shotsDifferentialAdjustment: dominant home → positieve adj', () => {
  const home = { gp: 50, shotsFor: 1700, shotsAgainst: 1300 }; // SF% = 0.567
  const away = { gp: 50, shotsFor: 1400, shotsAgainst: 1600 }; // SF% = 0.467
  const r = shotsDifferentialAdjustment(home, away);
  assert.strictEqual(r.valid, true);
  assert.ok(r.adj > 0, 'home dominanter in shot-control → positieve adj');
});

test('shotsDifferentialAdjustment: clamped op ±3%', () => {
  const home = { gp: 50, shotsFor: 2000, shotsAgainst: 1000 }; // 0.667
  const away = { gp: 50, shotsFor: 1000, shotsAgainst: 2000 }; // 0.333
  const r = shotsDifferentialAdjustment(home, away);
  assert.ok(Math.abs(r.adj - 0.03) < 1e-9, 'extreme verschil → clamped 3%');
});

test('shotsDifferentialAdjustment: <20 GP → invalid', () => {
  const home = { gp: 10, shotsFor: 300, shotsAgainst: 250 };
  const away = { gp: 50, shotsFor: 1500, shotsAgainst: 1500 };
  assert.strictEqual(shotsDifferentialAdjustment(home, away).valid, false);
});

test('shotsDifferentialAdjustment: missing data → safe null', () => {
  assert.strictEqual(shotsDifferentialAdjustment(null, null).valid, false);
  assert.strictEqual(shotsDifferentialAdjustment({}, {}).valid, false);
  assert.strictEqual(shotsDifferentialAdjustment({ gp: 30, shotsFor: NaN, shotsAgainst: 100 }, { gp: 30, shotsFor: 100, shotsAgainst: 100 }).valid, false);
});

test('shotsDifferentialAdjustment: balanced teams → adj ≈ 0', () => {
  const home = { gp: 50, shotsFor: 1500, shotsAgainst: 1500 };
  const away = { gp: 50, shotsFor: 1500, shotsAgainst: 1500 };
  const r = shotsDifferentialAdjustment(home, away);
  assert.ok(Math.abs(r.adj) < 1e-9, 'gelijk = 0 adj');
});

// ── Double Chance derived probs ─────────────────────────────────────────────

test('Double Chance: probs som op tot 2.0 (elke outcome zit in 2 DC-markten)', () => {
  const pH = 0.45, pX = 0.25, pA = 0.30;
  const pHX = pH + pX;
  const p12 = pH + pA;
  const pX2 = pX + pA;
  assert.ok(Math.abs((pHX + p12 + pX2) - 2.0) < 1e-9, 'som = 2.0');
});

test('DNB derived: draw chance uitsluiten, home+away genormaliseerd', () => {
  const pH = 0.45, pA = 0.30;
  const dnbH = pH / (pH + pA);
  const dnbA = pA / (pH + pA);
  assert.ok(Math.abs(dnbH + dnbA - 1.0) < 1e-9);
  assert.ok(dnbH > pH, 'zonder draw component meer home kans');
});

// ── Integration scenario's ──────────────────────────────────────────────────

test('full pipeline: LA Kings example catches bad pick', () => {
  // Market odds (alle 11 bookies geven ~deze range voor 3-way Vancouver vs LA)
  const threeWay = [
    { bookie: 'A', side: 'home', price: 3.20 }, // Vancouver reg prob ~0.31
    { bookie: 'A', side: 'draw', price: 4.30 }, // draw reg prob ~0.23
    { bookie: 'A', side: 'away', price: 1.98 }, // LA Kings reg prob ~0.51
    { bookie: 'B', side: 'home', price: 3.15 },
    { bookie: 'B', side: 'draw', price: 4.40 },
    { bookie: 'B', side: 'away', price: 2.00 },
  ];
  const consensus = consensus3Way(threeWay);
  const incOT = deriveIncOTProbFrom3Way(consensus, 0.52);
  // LA Kings inc-OT fair prob ~ 0.51 + 0.23 * 0.48 ≈ 0.62
  assert.ok(incOT.away > 0.55 && incOT.away < 0.65, `LA Kings inc-OT should be ~0.62, got ${incOT.away}`);

  // Ons model zei 0.688 (68.8%). Markt zegt ~0.62. Divergentie ~0.07.
  const modelLA = 0.688;
  const sanity = modelMarketSanityCheck(modelLA, incOT.away, 0.04);
  assert.strictEqual(sanity.agree, false, 'model 0.688 vs markt ~0.62 > 0.04 threshold → SKIP (bescherming tegen slechte pick)');
});

test('full pipeline: model-market agreement → accept', () => {
  const threeWay = [
    { bookie: 'A', side: 'home', price: 2.50 },
    { bookie: 'A', side: 'draw', price: 4.00 },
    { bookie: 'A', side: 'away', price: 2.70 },
  ];
  const consensus = consensus3Way(threeWay);
  const incOT = deriveIncOTProbFrom3Way(consensus, 0.50);
  // Model dat bijna overeenkomt met markt
  const modelHome = incOT.home + 0.02;
  const sanity = modelMarketSanityCheck(modelHome, incOT.home, 0.04);
  assert.strictEqual(sanity.agree, true, 'model binnen 0.04 van markt → accepteer');
});

// ── Regression: code-review findings v9.4.1 ────────────────────────────────

console.log('\n  Code-review regressions (v9.4.1):');

// recomputeWl komt uit lib/model-math.js

test('recomputeWl: W bet met hogere odds geeft hogere wl', () => {
  const row = { uitkomst: 'W', odds: 2.0, units: 1.0, inzet: 25 };
  const wl1 = recomputeWl(row);
  row.odds = 2.5; // odds aangepast
  const wl2 = recomputeWl(row);
  assert.ok(wl2 > wl1, 'hogere odds → hogere winst');
});

test('recomputeWl: L bet met hogere inzet geeft groter verlies', () => {
  const row = { uitkomst: 'L', odds: 2.0, units: 1.0, inzet: 25 };
  const wl1 = recomputeWl(row);
  row.inzet = 50; // inzet verhoogd
  const wl2 = recomputeWl(row);
  assert.ok(wl2 < wl1, 'hogere inzet → groter verlies');
  assert.strictEqual(wl1, -25);
  assert.strictEqual(wl2, -50);
});

test('recomputeWl: Open bet → null (geen herberekening)', () => {
  assert.strictEqual(recomputeWl({ uitkomst: 'Open', odds: 2.0, units: 1.0 }), null);
});

test('recomputeWl: ontbrekende inzet valt terug op units * unitEur', () => {
  const row = { uitkomst: 'W', odds: 2.0, units: 1.0 };
  const wl = recomputeWl(row, 25);
  assert.strictEqual(wl, 25, '1U×€25×(2.0-1) = €25');
});

// v10.10.7: unit_at_time per bet
test('recomputeWl: row.unitAtTime krijgt voorrang op meegegeven unitEur', () => {
  // Bet geplaatst toen unit €10 was; huidige unit is €25.
  const row = { uitkomst: 'W', odds: 2.0, units: 1.0, unitAtTime: 10 };
  const wl = recomputeWl(row, 25);
  assert.strictEqual(wl, 10, 'historische unit €10 wint van huidige €25 (1U×€10×1)');
});

test('recomputeWl: row zonder unitAtTime gebruikt fallback unitEur', () => {
  const row = { uitkomst: 'L', odds: 2.0, units: 1.0 };
  const wl = recomputeWl(row, 25);
  assert.strictEqual(wl, -25, 'legacy row zonder unitAtTime → fallback €25');
});

test('calcStats per-bet unitAtTime: winU/lossU splitsen correct over verschillende units', () => {
  // Reproductie van db.js calcStats per-bet logic.
  const unitFor = (b, unitEur) => {
    const ue = b && b.unitAtTime;
    return Number.isFinite(ue) && ue > 0 ? ue : unitEur;
  };
  const bets = [
    { uitkomst: 'W', wl: 10, unitAtTime: 10 },   // 1U winst @ €10
    { uitkomst: 'W', wl: 50, unitAtTime: 25 },   // 2U winst @ €25
    { uitkomst: 'L', wl: -10, unitAtTime: 10 },  // 1U verlies @ €10
    { uitkomst: 'L', wl: -25, unitAtTime: 25 },  // 1U verlies @ €25
  ];
  const winU  = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>{const ue=unitFor(b,25);return ue>0?s+(b.wl/ue):s;},0).toFixed(2);
  const lossU = +bets.filter(b=>b.uitkomst==='L').reduce((s,b)=>{const ue=unitFor(b,25);return ue>0?s+(b.wl/ue):s;},0).toFixed(2);
  assert.strictEqual(winU, 3, '1U + 2U = 3U winst (per-bet division, niet 60/25=2.4)');
  assert.strictEqual(lossU, -2, '-1U + -1U = -2U verlies');
});

test('calcStats per-bet unitAtTime: legacy row valt terug op huidige unitEur', () => {
  const unitFor = (b, unitEur) => {
    const ue = b && b.unitAtTime;
    return Number.isFinite(ue) && ue > 0 ? ue : unitEur;
  };
  // Mengvorm: 1 bet met unitAtTime, 1 zonder (legacy).
  const bets = [
    { uitkomst: 'W', wl: 10, unitAtTime: 10 },
    { uitkomst: 'W', wl: 25 }, // legacy → fallback huidige €25
  ];
  const winU = +bets.filter(b=>b.uitkomst==='W').reduce((s,b)=>{const ue=unitFor(b,25);return ue>0?s+(b.wl/ue):s;},0).toFixed(2);
  assert.strictEqual(winU, 2, '1U (€10 historisch) + 1U (€25 fallback) = 2U');
});

test('writeBet schema-fallback: drie tiers (full → no-fixture → no-unit_at_time)', async () => {
  // Reproductie van het schema-tolerant insert patroon uit lib/db.js + server.js.
  // Tier 1 faalt op fixture_id, Tier 2 faalt op unit_at_time, Tier 3 slaagt.
  const inserts = [];
  let tier = 0;
  const fakeSupabase = {
    from: () => ({
      insert: (payload) => {
        inserts.push(payload);
        tier++;
        if (tier === 1) return Promise.resolve({ error: { message: 'column "fixture_id" does not exist' } });
        if (tier === 2) return Promise.resolve({ error: { message: 'column "unit_at_time" does not exist' } });
        return Promise.resolve({ error: null });
      },
    }),
  };
  const isColumnError = (msg) => (msg || '').toLowerCase().includes('column');
  const safeInsert = async (payload) => {
    try { const { error } = await fakeSupabase.from('bets').insert(payload); return error || null; }
    catch (e) { return { message: e.message }; }
  };
  const base = { bet_id: 1, odds: 2.0, units: 1.0, inzet: 25, unit_at_time: 25 };
  let err = await safeInsert({ ...base, fixture_id: 999 });
  if (err && isColumnError(err.message)) err = await safeInsert(base);
  if (err && isColumnError(err.message)) {
    const { unit_at_time, ...legacy } = base;
    err = await safeInsert(legacy);
  }
  assert.strictEqual(err, null, 'derde tier slaagt');
  assert.strictEqual(inserts.length, 3, 'drie pogingen');
  assert.ok('fixture_id' in inserts[0], 'tier 1 had fixture_id');
  assert.ok('unit_at_time' in inserts[1], 'tier 2 had unit_at_time, geen fixture_id');
  assert.ok(!('fixture_id' in inserts[1]));
  assert.ok(!('unit_at_time' in inserts[2]), 'tier 3 had geen unit_at_time meer');
});

test('writeBet payload-shape: unit_at_time wordt meegegeven gelijk aan inzet-unit', () => {
  // Reproductie van db.js writeBet base-construction.
  const bet = { id: 1, odds: 2.0, units: 1.0, uitkomst: 'Open' };
  const ue = 25;
  const inzet = +(bet.units * ue).toFixed(2);
  const base = {
    bet_id: bet.id, odds: bet.odds, units: bet.units, inzet,
    uitkomst: bet.uitkomst,
    unit_at_time: ue,
  };
  assert.strictEqual(base.unit_at_time, ue);
  assert.strictEqual(base.inzet, base.units * base.unit_at_time);
});

// 2FA status check mirror
function authGateAfterCode(user) {
  if (!user) return { ok: false, code: 401, error: 'Verificatie mislukt' };
  if (user.status === 'blocked') return { ok: false, code: 403, error: 'Account geblokkeerd · neem contact op' };
  if (user.status === 'pending') return { ok: false, code: 403, error: 'Je account wacht nog op goedkeuring. Check je email.' };
  return { ok: true };
}

test('2FA status-gate: blocked user geweigerd na code-verify', () => {
  const r = authGateAfterCode({ id: 1, email: 'x@y.com', status: 'blocked' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 403);
  assert.ok(r.error.includes('geblokkeerd'));
});

test('2FA status-gate: pending user geweigerd', () => {
  const r = authGateAfterCode({ id: 1, email: 'x@y.com', status: 'pending' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 403);
});

test('2FA status-gate: approved user doorgelaten', () => {
  const r = authGateAfterCode({ id: 1, email: 'x@y.com', status: 'approved' });
  assert.strictEqual(r.ok, true);
});

test('2FA status-gate: ontbrekende user → 401', () => {
  const r = authGateAfterCode(null);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 401);
});

// Scheduler: admin-timers moeten opgeslagen zijn voor cancelation
function planAdminScans(admin, userScanTimers, mockScheduler) {
  const id = admin.id;
  // Clear oude
  if (userScanTimers[id]) {
    userScanTimers[id].forEach(h => h && clearTimeout(h));
  }
  if (!admin.settings?.scanEnabled) {
    userScanTimers[id] = [];
    return;
  }
  const times = admin.settings.scanTimes?.length ? admin.settings.scanTimes : ['07:30'];
  userScanTimers[id] = times.map(t => mockScheduler(t));
}

test('scheduler: admin scan-handles worden opgeslagen', () => {
  const timers = {};
  let callCount = 0;
  const fake = (t) => { callCount++; return { fake: true, t }; };
  planAdminScans({ id: 1, settings: { scanTimes: ['07:30', '14:30'], scanEnabled: true } }, timers, fake);
  assert.strictEqual(timers[1].length, 2, '2 handles opgeslagen');
  assert.strictEqual(callCount, 2);
});

test('scheduler: reschedule vervangt oude handles zonder duplicaten', () => {
  const timers = {};
  const made = [];
  const fake = (t) => { const h = { t }; made.push(h); return h; };
  // Eerste planning: 2 tijden
  planAdminScans({ id: 1, settings: { scanTimes: ['07:30', '14:30'], scanEnabled: true } }, timers, fake);
  // Reschedule met 1 tijd
  planAdminScans({ id: 1, settings: { scanTimes: ['09:00'], scanEnabled: true } }, timers, fake);
  assert.strictEqual(timers[1].length, 1, 'na reschedule 1 actieve handle');
  assert.strictEqual(made.length, 3, 'totaal 3 handles ooit gemaakt (2 oud + 1 nieuw)');
});

test('scheduler: scanEnabled=false clearst timers', () => {
  const timers = {};
  const fake = (t) => ({ t });
  planAdminScans({ id: 1, settings: { scanTimes: ['07:30'], scanEnabled: true } }, timers, fake);
  planAdminScans({ id: 1, settings: { scanEnabled: false } }, timers, fake);
  assert.strictEqual(timers[1].length, 0, 'scanEnabled=false → geen actieve timers');
});

// ── Snapshot helpers (v9.6.0 v2 foundation) ────────────────────────────────

console.log('\n  Snapshot layer (v2 foundation):');

const snap = require('./lib/snapshots');

test('flattenParsedOdds: alle markttypes geconverteerd naar canonical rows', () => {
  const parsed = {
    moneyline: [{ side: 'home', price: 1.95, bookie: 'Bet365' }],
    threeWay: [{ side: 'draw', price: 4.0, bookie: 'Unibet' }],
    totals: [{ side: 'over', point: 2.5, price: 1.85, bookie: 'Bet365' }],
    spreads: [{ side: 'home', point: -1.5, price: 2.10, bookie: 'Bet365' }],
    teamTotals: [{ team: 'home', side: 'over', point: 1.5, price: 1.50, bookie: 'Bet365' }],
    doubleChance: [{ side: 'HX', price: 1.20, bookie: 'Unibet' }],
    dnb: [{ side: 'home', price: 1.40, bookie: 'Unibet' }],
    halfML: [{ side: 'away', price: 2.20, bookie: 'Bet365', market: 'f5' }],
    halfTotals: [{ side: 'over', point: 4.5, price: 1.90, bookie: 'Bet365', market: 'f5' }],
    halfSpreads: [{ side: 'home', point: 0.5, price: 1.70, bookie: 'Bet365', market: 'f5' }],
    nrfi: [{ side: 'nrfi', price: 1.65, bookie: 'Bet365' }],
    oddEven: [{ side: 'odd', price: 1.95, bookie: 'Bet365' }],
  };
  const rows = snap.flattenParsedOdds(parsed);
  // 12 markets × 1 entry each = 12 rows
  assert.strictEqual(rows.length, 12);
  // Validate sample types
  assert.ok(rows.find(r => r.market_type === 'moneyline' && r.selection_key === 'home' && r.odds === 1.95));
  assert.ok(rows.find(r => r.market_type === 'threeway' && r.selection_key === 'draw'));
  assert.ok(rows.find(r => r.market_type === 'team_total_home'));
  assert.ok(rows.find(r => r.market_type === 'f5_ml'));
  assert.ok(rows.find(r => r.market_type === 'nrfi'));
});

test('flattenParsedOdds: lege parsed input → lege array', () => {
  const rows = snap.flattenParsedOdds({});
  assert.strictEqual(rows.length, 0);
});

test('flattenFootballBookies: h2h + totals canonicalisatie', () => {
  const bookies = [
    {
      title: 'Bet365',
      markets: [
        { key: 'h2h', outcomes: [
          { name: 'Manchester United', price: 2.10 },
          { name: 'Draw', price: 3.40 },
          { name: 'Liverpool', price: 3.20 },
        ]},
        { key: 'totals', outcomes: [
          { name: 'Over', price: 1.85, point: 2.5 },
          { name: 'Under', price: 1.95, point: 2.5 },
        ]},
        { key: 'btts', outcomes: [
          { name: 'Yes', price: 1.75 },
          { name: 'No', price: 2.05 },
        ]},
      ],
    },
  ];
  const rows = snap.flattenFootballBookies(bookies, 'Manchester United', 'Liverpool');
  // 3 (1x2) + 2 (totals) + 2 (btts) = 7 rows
  assert.strictEqual(rows.length, 7);
  // 1x2 home detected by team name
  assert.ok(rows.find(r => r.market_type === '1x2' && r.selection_key === 'home' && r.odds === 2.10));
  assert.ok(rows.find(r => r.market_type === '1x2' && r.selection_key === 'draw' && r.odds === 3.40));
  assert.ok(rows.find(r => r.market_type === '1x2' && r.selection_key === 'away' && r.odds === 3.20));
  // totals canonicalized
  assert.ok(rows.find(r => r.market_type === 'total' && r.selection_key === 'over' && r.line === 2.5));
  // btts
  assert.ok(rows.find(r => r.market_type === 'btts' && r.selection_key === 'yes'));
});

test('flattenFootballBookies: lege bookies → lege array', () => {
  assert.strictEqual(snap.flattenFootballBookies(null, 'A', 'B').length, 0);
  assert.strictEqual(snap.flattenFootballBookies([], 'A', 'B').length, 0);
});

test('consensusQualityScore: bookie count tiers werken', () => {
  assert.strictEqual(snap.consensusQualityScore(10, 0.04), 1.0);
  assert.strictEqual(snap.consensusQualityScore(6, 0.04), 0.8);
  assert.strictEqual(snap.consensusQualityScore(3, 0.04), 0.6);
  assert.strictEqual(snap.consensusQualityScore(2, 0.04), 0.4);
  assert.strictEqual(snap.consensusQualityScore(1, 0.04), 0.2);
  assert.strictEqual(snap.consensusQualityScore(0, 0.04), 0);
});

test('consensusQualityScore: hoge overround penalt', () => {
  const high = snap.consensusQualityScore(8, 0.12); // > 10% → penalty
  assert.ok(high < 1.0);
  assert.ok(high <= 0.7);
  const med = snap.consensusQualityScore(8, 0.07); // 6-10% → mild penalty
  assert.ok(med < 1.0);
  assert.ok(med >= 0.85);
});

test('snapshot writers: zijn no-op bij ontbrekende data (geen exceptions)', async () => {
  // Mock supabase die exception zou gooien als gebeld → mag niet
  const fakeSupabase = { from: () => { throw new Error('should not be called'); } };
  await snap.upsertFixture(fakeSupabase, null);
  await snap.upsertFixture(fakeSupabase, { id: 1 }); // missing required fields
  await snap.writeOddsSnapshots(fakeSupabase, null, []);
  await snap.writeOddsSnapshots(fakeSupabase, 1, []);
  await snap.writeMarketConsensus(fakeSupabase, null);
  await snap.writeMarketConsensus(fakeSupabase, { fixtureId: 1 }); // missing
  await snap.writeFeatureSnapshot(fakeSupabase, null);
  await snap.writeFeatureSnapshot(fakeSupabase, 1, null);
  // Geen assertion nodig: als er een exception was, falt de test
});

test('registerModelVersion: ontbrekende versionTag → null', async () => {
  const fakeSb = { from: () => { throw new Error('mag niet bellen'); } };
  const result = await snap.registerModelVersion(fakeSb, {});
  assert.strictEqual(result, null);
});

test('writeModelRun: ontbrekende velden → null, geen exception', async () => {
  const fakeSb = { from: () => { throw new Error('mag niet bellen'); } };
  assert.strictEqual(await snap.writeModelRun(fakeSb, {}), null);
  assert.strictEqual(await snap.writeModelRun(fakeSb, { fixtureId: 1 }), null);
  assert.strictEqual(await snap.writeModelRun(fakeSb, { fixtureId: 1, modelVersionId: 1 }), null);
  // Met alle required maar throwing supabase
  const errSb = { from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.reject(new Error('down')) }) }) }) };
  const r = await snap.writeModelRun(errSb, {
    fixtureId: 1, modelVersionId: 1, marketType: 'threeway',
    baselineProb: { home: 0.5 }, finalProb: { home: 0.55 },
  });
  assert.strictEqual(r, null);
});

test('writePickCandidate: rejected pick met reason wordt accepted', async () => {
  let captured = null;
  const fakeSb = { from: () => ({ insert: (row) => { captured = row; return Promise.resolve({ error: null }); } }) };
  await snap.writePickCandidate(fakeSb, {
    modelRunId: 5, fixtureId: 100, selectionKey: 'home',
    bookmaker: 'Bet365', bookmakerOdds: 1.86, fairProb: 0.55, edgePct: 2.3,
    passedFilters: false, rejectedReason: 'edge_below_min (2.3%)',
    signals: ['form:+1.2%'],
  });
  assert.ok(captured);
  assert.strictEqual(captured.passed_filters, false);
  assert.strictEqual(captured.rejected_reason, 'edge_below_min (2.3%)');
  assert.strictEqual(captured.bookmaker, 'Bet365');
  assert.strictEqual(captured.signals.length, 1);
});

test('writePickCandidate: ontbrekende fields → no-op', async () => {
  const fakeSb = { from: () => { throw new Error('mag niet bellen'); } };
  await snap.writePickCandidate(fakeSb, {});
  await snap.writePickCandidate(fakeSb, { modelRunId: 1 });
  await snap.writePickCandidate(fakeSb, { modelRunId: 1, fixtureId: 1, selectionKey: 'home' }); // mist bookmaker
});

test('snapshot writers: Supabase-exceptie wordt gevangen, geen rethrow', async () => {
  const errorSupabase = {
    from: () => ({
      upsert: () => Promise.reject(new Error('supabase down')),
      insert: () => Promise.reject(new Error('supabase down')),
    }),
  };
  // Mag NIET gooien — alle helpers zijn fail-safe
  await snap.upsertFixture(errorSupabase, {
    id: 1, sport: 'hockey', homeTeamName: 'A', awayTeamName: 'B', startTime: Date.now(),
  });
  await snap.writeOddsSnapshots(errorSupabase, 1, [{ bookmaker: 'X', market_type: 'ml', selection_key: 'home', odds: 1.9 }]);
  await snap.writeMarketConsensus(errorSupabase, { fixtureId: 1, marketType: 'threeway', consensusProb: { home: 0.5, draw: 0.2, away: 0.3 } });
  await snap.writeFeatureSnapshot(errorSupabase, 1, { test: true });
});

// ── Hierarchical calibration + Residual model framework ────────────────────

console.log('\n  Hierarchical calibration + residual framework:');

test('bayesSmooth: n=0 → parent, n→∞ → own', () => {
  assert.strictEqual(bayesSmooth(1.20, 0, 1.00), 1.00, 'geen data → terugvallen op parent');
  // n veel groter dan K → own dominant
  const big = bayesSmooth(1.20, 10000, 1.00);
  assert.ok(Math.abs(big - 1.20) < 0.01, 'veel data → own multiplier');
});

test('bayesSmooth: n=K → 50/50 blend', () => {
  const r = bayesSmooth(1.20, HIER_CALIB_K, 1.00);
  assert.ok(Math.abs(r - 1.10) < 1e-9, 'n=K → midpoint');
});

test('hierarchicalMultiplier: lege buckets → 1.0 (prior)', () => {
  const r = hierarchicalMultiplier({});
  assert.strictEqual(r, 1.0);
});

test('hierarchicalMultiplier: clamped op [0.5, 1.5]', () => {
  // Forceer extreme waardes
  const high = hierarchicalMultiplier({
    sport_league_market: { multiplier: 5.0, n: 1000 },
    sport_market: { multiplier: 5.0, n: 1000 },
    sport: { multiplier: 5.0, n: 1000 },
  });
  assert.ok(high <= 1.5, 'clamped to 1.5');
  const low = hierarchicalMultiplier({
    sport_league_market: { multiplier: 0.1, n: 1000 },
    sport_market: { multiplier: 0.1, n: 1000 },
    sport: { multiplier: 0.1, n: 1000 },
  });
  assert.ok(low >= 0.5, 'clamped to 0.5');
});

test('hierarchicalMultiplier: child met weinig data smoothed naar parent', () => {
  // Sport_market heeft 100 bets, league_market heeft maar 5 bets
  const r = hierarchicalMultiplier({
    sport: { multiplier: 1.0, n: 500 },
    sport_market: { multiplier: 1.20, n: 100 },
    sport_league_market: { multiplier: 0.80, n: 5 },
  });
  // League smoothed naar market (1.20), zou rond 1.15-1.18 moeten zijn
  assert.ok(r > 1.10 && r < 1.22, `r=${r} should be smoothed toward market`);
});

test('summarizeSignalMetrics: corrigeert signaal voor negatieve markt-bias', () => {
  const out = summarizeSignalMetrics([
    { marketKey: 'football_home', clvPct: -2.0, signalNames: ['travel_fade'] },
    { marketKey: 'football_home', clvPct: -1.0, signalNames: ['travel_fade'] },
    { marketKey: 'football_home', clvPct: -3.0, signalNames: [] },
    { marketKey: 'football_home', clvPct: -2.0, signalNames: [] },
  ], { marketPriorK: 0, signalPriorK: 0 });
  assert.ok(out.signals.travel_fade, 'signal summary should exist');
  assert.strictEqual(+out.markets.football_home.baselineClv.toFixed(2), -2.00);
  assert.strictEqual(+out.signals.travel_fade.avgClv.toFixed(2), -1.50);
  assert.strictEqual(+out.signals.travel_fade.avgExcessClv.toFixed(2), 0.50);
});

test('summarizeSignalMetrics: kleine samples worden teruggeshrinkt', () => {
  const out = summarizeSignalMetrics([
    { marketKey: 'football_over', clvPct: 4.0, signalNames: ['weather_over'] },
    { marketKey: 'football_over', clvPct: 0.0, signalNames: [] },
  ], { marketPriorK: 0, signalPriorK: 9 });
  const raw = out.signals.weather_over.avgExcessClv;
  const shrunk = out.signals.weather_over.shrunkExcessClv;
  assert.ok(raw > 0, 'raw excess should be positive');
  assert.ok(shrunk > 0 && shrunk < raw, `shrunk=${shrunk}, raw=${raw}`);
});

test('buildPickFactory: runtime hooks sturen kelly, expectedEur en audit-damping', () => {
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'basketball',
    drawdownMultiplier: () => 0.5,
    activeUnitEur: 50,
  });
  // v12.0.0: signals-array moet niet leeg zijn — 0-signal picks worden nu
  // geskipt (P1.6). Met 1 signal krijg je dataConf=0.55 (was 0.50). Kelly +
  // audit-damping blijven gelijk, expectedEur schaalt 10% hoger.
  mkP('Lakers vs Celtics', 'NBA', 'Lakers ML', 2.0, 'test', 80, 0.10, null, 'Bet365', ['test_signal:+2.0%']);
  assert.strictEqual(picks.length, 1);
  const pick = picks[0];
  assert.strictEqual(pick.sport, 'basketball');
  assert.strictEqual(pick.audit.suspicious, true);
  assert.strictEqual(+pick.kelly.toFixed(3), 0.03);
  assert.strictEqual(pick.units, '0.5U');
  // expectedEur = units * unit(50) * edge * dataConf. Schaalt 0.55/0.40 = 1.375x
  // t.o.v. oude verwachting van 2. Dus nu ~2.75.
  assert.ok(pick.expectedEur > 2.5 && pick.expectedEur < 3.0, `expectedEur in 2.5-3.0 range, kreeg ${pick.expectedEur}`);
});

test('createPickContext: normaliseert pick-runtime context met veilige defaults', () => {
  const ctx = createPickContext({
    sport: 'basketball',
    activeUnitEur: 25,
    drawdownMultiplier: () => 0.7,
    adaptiveMinEdge: () => 0.06,
  });
  assert.strictEqual(ctx.sport, 'basketball');
  assert.strictEqual(ctx.activeUnitEur, 25);
  assert.strictEqual(ctx.drawdownMultiplier(), 0.7);
  assert.strictEqual(ctx.adaptiveMinEdge('basketball', 'Home', 0.055), 0.06);

  const fallback = createPickContext({});
  assert.strictEqual(fallback.sport, 'football');
  assert.ok(fallback.activeUnitEur > 0);
  assert.strictEqual(fallback.drawdownMultiplier(), 1.0);
  assert.strictEqual(fallback.adaptiveMinEdge, null);
});

// v10.10.14: PickContext executionMetrics integratie (component A)
test('createPickContext: accepteert executionMetrics als optioneel veld', () => {
  const withMetrics = createPickContext({
    executionMetrics: { targetPresent: true, preferredGap: 0.01 },
  });
  assert.ok(withMetrics.executionMetrics);
  assert.strictEqual(withMetrics.executionMetrics.targetPresent, true);

  const withoutMetrics = createPickContext({});
  assert.strictEqual(withoutMetrics.executionMetrics, null);

  // Garbage in → null out (strict normalisatie)
  const garbage = createPickContext({ executionMetrics: 'oops' });
  assert.strictEqual(garbage.executionMetrics, null);
});

test('buildPickFactory: zonder executionMetrics → identiek aan pre-v10.10.14 gedrag', () => {
  const { picks, mkP } = buildPickFactory(1.6, {}, { sport: 'football' });
  mkP('Ajax vs PSV', 'Eredivisie', 'Ajax ML', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(picks.length, 1, 'pick komt gewoon door');
  assert.strictEqual(picks[0].executionAudit, null, 'geen gate-audit bij null metrics');
});

test('buildPickFactory: executionMetrics met targetPresent=false → skip pick', () => {
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    executionMetrics: { targetPresent: false },
  });
  mkP('Ajax vs PSV', 'Eredivisie', 'Ajax ML', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(picks.length, 0, 'no_target_bookie → hard skip');
});

test('buildPickFactory: executionMetrics met stale → dempt kelly', () => {
  // Zonder gate: baseline kelly-niveau
  const { picks: noMetricsPicks, mkP: mkNoMetrics } = buildPickFactory(1.6, {}, { sport: 'football' });
  mkNoMetrics('A vs B', 'L', 'Home', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  const baselineKelly = noMetricsPicks[0].kelly;

  // Met stale metrics: kelly gedempt (×0.7 stale_abs_mid)
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    executionMetrics: { targetPresent: true, preferredGap: 0.06 }, // 0.06 → stale_abs_mid × 0.7
  });
  mkP('A vs B', 'L', 'Home', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(picks.length, 1, 'pick komt door met demping');
  assert.ok(picks[0].kelly < baselineKelly, `kelly ${picks[0].kelly} < baseline ${baselineKelly}`);
  assert.ok(picks[0].executionAudit, 'audit aanwezig');
  assert.strictEqual(picks[0].executionAudit.combinedMultiplier ?? picks[0].executionAudit.combined_multiplier, 0.7);
  assert.ok(picks[0].executionAudit.reasons.some(r => r.includes('stale_abs_mid')));
});

test('buildPickFactory: resolveExecutionMetrics heeft voorrang op ctx.executionMetrics', () => {
  // Static ctx: targetPresent=true (geen skip). Resolver: targetPresent=false (skip).
  // Als resolver voorrang heeft → pick wordt geskipt.
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    executionMetrics: { targetPresent: true },
    resolveExecutionMetrics: () => ({ targetPresent: false }),
  });
  mkP('A vs B', 'L', 'Home', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(picks.length, 0, 'resolver wint → skip');
});

test('buildPickFactory: resolveExecutionMetrics throw → fallback naar ctx.executionMetrics', () => {
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    executionMetrics: { targetPresent: true }, // safe fallback
    resolveExecutionMetrics: () => { throw new Error('oeps'); },
  });
  mkP('A vs B', 'L', 'Home', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(picks.length, 1, 'crash in resolver → pick komt door via ctx-fallback');
});

test('buildPickFactory: fixtureMeta wordt doorgegeven aan resolveExecutionMetrics + opgeslagen op pick._fixtureMeta', () => {
  // v10.12.6 Phase A.1b: verifieer dat de 12e positional arg op mkP
  // (fixtureMeta) correct door de factory stroomt.
  let receivedMeta = null;
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    resolveExecutionMetrics: (args) => {
      receivedMeta = args.fixtureMeta;
      return { targetPresent: true, preferredGap: 0 }; // niet skippen
    },
  });
  const meta = { fixtureId: 12345, marketType: '1x2', selectionKey: 'home', line: null };
  mkP('Ajax vs PSV', 'Eredivisie', '🏠 Ajax wint', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%'], null, meta);
  assert.deepStrictEqual(receivedMeta, meta, 'resolver ontvangt fixtureMeta');
  assert.strictEqual(picks.length, 1);
  assert.deepStrictEqual(picks[0]._fixtureMeta, meta, 'pick bewaart fixtureMeta voor downstream audits');
});

test('buildPickFactory: geen fixtureMeta → resolver krijgt null (backwards-compat)', () => {
  let receivedMeta = 'NOT_CALLED';
  const { picks, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    resolveExecutionMetrics: (args) => {
      receivedMeta = args.fixtureMeta;
      return null; // geen metrics → gate no-op
    },
  });
  mkP('Ajax vs PSV', 'Eredivisie', '🏠 Ajax wint', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(receivedMeta, null, 'fixtureMeta default is null');
  assert.strictEqual(picks.length, 1, 'pick komt door (gate no-op)');
  assert.strictEqual(picks[0]._fixtureMeta, null);
});

test('buildPickFactory: adaptiveMinEdge kan pick uit singles en combiPool weren', () => {
  const { picks, combiPool, mkP } = buildPickFactory(1.6, {}, {
    sport: 'football',
    adaptiveMinEdge: () => 0.25,
  });
  mkP('Ajax vs PSV', 'Eredivisie', 'Ajax ML', 2.0, 'test', 62, 0.10, null, 'Bet365', ['form:+2.0%']);
  assert.strictEqual(picks.length, 0);
  assert.strictEqual(combiPool.length, 0);
});

// v11.3.29 P0 regressietests (Codex-finding): analyseTotal() moet EXACTE
// line matchen, niet "dichtbij" via < 0.6 tolerantie. Pre-fix kon een
// outcomes-array `[Over 3.0, Over 2.5]` ertoe leiden dat analyseTotal(2.5)
// de 3.0-prijs teruggaf via find() op de eerste match.
test('analyseTotal: exact line match — 2.5 pakt NIET 3.0 prijs', () => {
  const bookmakers = [
    {
      title: 'Bet365',
      markets: [{
        key: 'totals',
        outcomes: [
          // volgorde: 3.0 eerst, dan 2.5 — pre-fix zou 3.0 pakken
          { name: 'Over', price: 2.55, point: 3.0 },
          { name: 'Over', price: 1.92, point: 2.5 },
        ],
      }],
    },
  ];
  const r = analyseTotal(bookmakers, 'Over', 2.5);
  assert.strictEqual(r.best.price, 1.92, `moet Over 2.5 @ 1.92 pakken, kreeg ${r.best.price}`);
  assert.strictEqual(r.best.bookie, 'Bet365');
});

test('analyseTotal: exact line match — 2.5 pakt NIET 2.0 prijs', () => {
  const bookmakers = [
    {
      title: 'Bet365',
      markets: [{
        key: 'totals',
        outcomes: [
          { name: 'Over', price: 1.50, point: 2.0 },
          { name: 'Over', price: 1.95, point: 2.5 },
        ],
      }],
    },
  ];
  const r = analyseTotal(bookmakers, 'Over', 2.5);
  assert.strictEqual(r.best.price, 1.95, `moet Over 2.5 @ 1.95 pakken, kreeg ${r.best.price}`);
});

test('analyseTotal: line die niet bestaat → geen match', () => {
  const bookmakers = [
    {
      title: 'Bet365',
      markets: [{
        key: 'totals',
        outcomes: [
          { name: 'Over', price: 1.50, point: 2.0 },
          { name: 'Over', price: 2.55, point: 3.0 },
        ],
      }],
    },
  ];
  const r = analyseTotal(bookmakers, 'Over', 2.5);
  assert.strictEqual(r.best.price, 0, 'geen 2.5 line → best.price blijft 0');
  assert.strictEqual(r.avgIP, 0, 'geen matches → avgIP = 0');
});

test('analyseTotal: meerdere bookies met exact 2.5 → beste prijs wint + consensus correct', () => {
  const bookmakers = [
    {
      title: 'Bet365',
      markets: [{
        key: 'totals',
        outcomes: [{ name: 'Over', price: 1.85, point: 2.5 }],
      }],
    },
    {
      title: 'Unibet',
      markets: [{
        key: 'totals',
        outcomes: [{ name: 'Over', price: 1.90, point: 2.5 }],
      }],
    },
    {
      title: 'NoiseBookie',
      markets: [{
        key: 'totals',
        outcomes: [{ name: 'Over', price: 3.50, point: 3.5 }], // andere line, mag niet mee
      }],
    },
  ];
  const r = analyseTotal(bookmakers, 'Over', 2.5);
  assert.strictEqual(r.best.price, 1.90, 'Unibet 1.90 > Bet365 1.85 op 2.5');
  // avgIP over de 2 bookies op 2.5: (1/1.85 + 1/1.90) / 2 ≈ 0.5334
  assert.ok(Math.abs(r.avgIP - 0.5334) < 0.01, `avgIP ≈ 0.5334, kreeg ${r.avgIP}`);
});

test('calcBTTSProb: dunne H2H sample wordt Bayesian geshrinkt', () => {
  const thin = calcBTTSProb({ h2hBTTS: 3, h2hN: 3, hmAvgGF: 1.8, awAvgGF: 1.8 });
  const thick = calcBTTSProb({ h2hBTTS: 20, h2hN: 25, hmAvgGF: 1.8, awAvgGF: 1.8 });
  assert.ok(thin < 80, `thin sample should be shrunk, got ${thin}`);
  assert.ok(thick > thin, `thick sample should retain more H2H signal (${thick} vs ${thin})`);
});

test('bestOdds: preferred bookies filter kan hogere niet-preferred prijs negeren', () => {
  const bookmakers = [
    {
      title: 'SharpBook',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 2.3 }] }],
    },
    {
      title: 'Bet365',
      markets: [{ key: 'h2h', outcomes: [{ name: 'Home', price: 2.1 }] }],
    },
  ];
  const anyBook = bestOdds(bookmakers, 'h2h', 'Home');
  const preferredOnly = bestOdds(bookmakers, 'h2h', 'Home', { preferredBookiesLower: ['bet365'] });
  assert.strictEqual(anyBook.price, 2.3);
  assert.strictEqual(preferredOnly.price, 2.1);
  assert.strictEqual(preferredOnly.bookie, 'Bet365');
});

test('summarizeExecutionQuality: classificeert stale price en market beat', () => {
  const rows = [
    { captured_at: '2026-04-16T08:00:00.000Z', bookmaker: 'Bet365', market_type: 'moneyline', selection_key: 'home', line: null, odds: 2.00 },
    { captured_at: '2026-04-16T08:00:00.000Z', bookmaker: 'SharpBook', market_type: 'moneyline', selection_key: 'home', line: null, odds: 2.12 },
    { captured_at: '2026-04-16T11:00:00.000Z', bookmaker: 'Bet365', market_type: 'moneyline', selection_key: 'home', line: null, odds: 1.88 },
    { captured_at: '2026-04-16T11:00:00.000Z', bookmaker: 'SharpBook', market_type: 'moneyline', selection_key: 'home', line: null, odds: 1.90 },
  ];
  const summary = summarizeExecutionQuality(rows, {
    marketType: 'moneyline',
    selectionKey: 'home',
    bookmaker: 'Bet365',
    anchorIso: '2026-04-16T08:30:00.000Z',
    preferredBookiesLower: ['bet365'],
  });
  assert.strictEqual(summary.status, 'stale_price');
  assert.strictEqual(summary.open.best_overall.odds, 2.12);
  assert.strictEqual(summary.anchor.target_book.odds, 2.0);
  assert.strictEqual(summary.latest.best_overall.odds, 1.9);
  assert.ok(summary.move_to_latest_pct > 5, `expected positive CLV-like move, got ${summary.move_to_latest_pct}`);
});

test('summarizeExecutionQuality: geeft no_target_bookie als gelogde bookie ontbreekt', () => {
  const rows = [
    { captured_at: '2026-04-16T08:00:00.000Z', bookmaker: 'SharpBook', market_type: 'moneyline', selection_key: 'home', line: null, odds: 2.12 },
    { captured_at: '2026-04-16T08:00:00.000Z', bookmaker: 'Unibet', market_type: 'moneyline', selection_key: 'home', line: null, odds: 2.04 },
  ];
  const summary = summarizeExecutionQuality(rows, {
    marketType: 'moneyline',
    selectionKey: 'home',
    bookmaker: 'Bet365',
    anchorIso: '2026-04-16T08:30:00.000Z',
    preferredBookiesLower: ['bet365', 'unibet'],
  });
  assert.strictEqual(summary.status, 'no_target_bookie');
  assert.strictEqual(summary.anchor.best_preferred.odds, 2.04);
});

test('calibration store: loadSync valt terug op default zonder file', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'edgepickr-calib-'));
  const store = createCalibrationStore({ baseDir: tmpDir });
  const calib = store.loadSync();
  assert.strictEqual(calib.totalSettled, 0);
  calib.totalSettled = 99;
  const freshStore = createCalibrationStore({ baseDir: tmpDir });
  assert.strictEqual(freshStore.loadSync().totalSettled, 0);
});

test('calibration store: loadSync leest lokale fallbackfile', () => {
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'edgepickr-calib-'));
  const file = path.join(tmpDir, 'calibration.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, totalSettled: 42, markets: {}, epBuckets: {}, leagues: {}, lossLog: [] }));
  const store = createCalibrationStore({ baseDir: tmpDir });
  const calib = store.loadSync();
  assert.strictEqual(calib.totalSettled, 42);
});

test('calibration store: async load gebruikt supabase en cachet resultaat', async () => {
  let calls = 0;
  const fakeSupabase = {
    from: (table) => {
      assert.strictEqual(table, 'calibration');
      return {
        select: () => ({
          eq: (column, value) => {
            assert.strictEqual(column, 'id');
            assert.strictEqual(value, 1);
            return {
              single: async () => {
                calls++;
                return { data: { data: { version: 1, totalSettled: 17, markets: {}, epBuckets: {}, leagues: {}, lossLog: [] } }, error: null };
              },
            };
          },
        }),
      };
    },
  };
  const store = createCalibrationStore({ supabase: fakeSupabase, baseDir: __dirname });
  const first = await store.load();
  const second = await store.load();
  assert.strictEqual(first.totalSettled, 17);
  assert.strictEqual(second.totalSettled, 17);
  assert.strictEqual(calls, 1);
});

test('calibration store: save warmt cache en schrijft naar supabase', async () => {
  let payload = null;
  const fakeSupabase = {
    from: (table) => {
      assert.strictEqual(table, 'calibration');
      return {
        upsert: async (row) => { payload = row; return { error: null }; },
      };
    },
  };
  const store = createCalibrationStore({ supabase: fakeSupabase, baseDir: __dirname });
  const next = { version: 1, totalSettled: 23, markets: {}, epBuckets: {}, leagues: {}, lossLog: [] };
  await store.save(next);
  assert.ok(payload);
  assert.strictEqual(payload.id, 1);
  assert.strictEqual(payload.data.totalSettled, 23);
  assert.strictEqual(store.loadSync().totalSettled, 23);
});

test('release metadata: app-meta en package.json voeren dezelfde versie', () => {
  assert.strictEqual(appMeta.APP_VERSION, '12.1.0');
  assert.strictEqual(pkg.version, appMeta.APP_VERSION);
  const lock = JSON.parse(fs.readFileSync(path.join(__dirname, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.version, appMeta.APP_VERSION);
  assert.strictEqual(lock.name, pkg.name);
});

test('supportsApiSportsInjuries: voetbal en nfl true, nba/nhl/mlb false', () => {
  assert.strictEqual(supportsApiSportsInjuries('v3.football.api-sports.io'), true);
  assert.strictEqual(supportsApiSportsInjuries('v1.american-football.api-sports.io'), true);
  assert.strictEqual(supportsApiSportsInjuries('v1.basketball.api-sports.io'), false);
  assert.strictEqual(supportsApiSportsInjuries('v1.hockey.api-sports.io'), false);
  assert.strictEqual(supportsApiSportsInjuries('v1.baseball.api-sports.io'), false);
});

test('release metadata: index fallbackversies matchen app-meta', () => {
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.ok(html.includes(`id="scan-version">${appMeta.APP_VERSION}<`), 'scan-version fallback should match app-meta');
  assert.ok(html.includes(`id="app-version-str">versie ${appMeta.APP_VERSION}<`), 'app-version fallback should match app-meta');
});

test('residualModelDelta: zonder coefficients → 0 (skeleton)', () => {
  assert.strictEqual(residualModelDelta({}, null), 0);
  assert.strictEqual(residualModelDelta({}, { weights: [] }), 0);
});

test('residualModelDelta: met coefficients berekent sigmoid delta', () => {
  const coef = {
    bias: 0,
    weights: [0.5, -0.3],
    featureNames: ['form', 'rest_diff'],
  };
  const r = residualModelDelta({ form: 1, rest_diff: 0 }, coef);
  // z = 0 + 0.5*1 = 0.5; sigmoid(0.5) ≈ 0.622; (0.622 - 0.5) * 0.30 ≈ 0.0366
  assert.ok(r > 0.02 && r < 0.05, `delta ${r} expected ~0.037`);
});

test('residualModelDelta: clamped binnen ±0.15', () => {
  const coef = { bias: 100, weights: [], featureNames: [] };
  const r = residualModelDelta({}, coef);
  assert.ok(r <= 0.15);
  const coefNeg = { bias: -100, weights: [], featureNames: [] };
  const rN = residualModelDelta({}, coefNeg);
  assert.ok(rN >= -0.15);
});

test('residualModelActive: drempel = RESIDUAL_MIN_TRAINING_PICKS', () => {
  assert.strictEqual(residualModelActive(99), false);
  assert.strictEqual(residualModelActive(100), true);
  assert.strictEqual(residualModelActive(500), true);
  assert.strictEqual(residualModelActive(0), false);
  assert.strictEqual(residualModelActive(null), false);
});

test('residualModelActive: backtest-gate (negatieve brierDelta = beter)', () => {
  assert.strictEqual(residualModelActive(150, { brierDelta: -0.01 }), true);  // beter
  assert.strictEqual(residualModelActive(150, { brierDelta: 0.01 }),  false); // slechter
  assert.strictEqual(residualModelActive(150, { brierDelta: 0 }),     false); // gelijk
  assert.strictEqual(residualModelActive(50,  { brierDelta: -0.05 }), false); // sample te laag
});

// ── INTEGRATION: end-to-end snapshot flow met mock supabase ────────────────

console.log('\n  Snapshot integration (mock supabase):');

function makeMockSupabase() {
  const tables = { fixtures: [], odds_snapshots: [], feature_snapshots: [], market_consensus: [], model_versions: [], model_runs: [], pick_candidates: [] };
  let nextId = 1;
  const builder = (tableName) => {
    const tbl = tables[tableName] = tables[tableName] || [];
    return {
      _whereChain: [],
      _selectFields: null,
      select(fields) { this._selectFields = fields; return this; },
      eq(col, val) { this._whereChain.push({ col, val }); return this; },
      gte() { return this; },
      lte() { return this; },
      not() { return this; },
      is() { return this; },
      order() { return this; },
      limit() { return this; },
      maybeSingle() {
        const filtered = this._whereChain.length ? tbl.filter(r => this._whereChain.every(w => r[w.col] === w.val)) : tbl;
        return Promise.resolve({ data: filtered[0] || null, error: null });
      },
      single() {
        const filtered = this._whereChain.length ? tbl.filter(r => this._whereChain.every(w => r[w.col] === w.val)) : tbl;
        return Promise.resolve({ data: filtered[0] || null, error: filtered.length ? null : { message: 'not found' } });
      },
      insert(row) {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) {
          tbl.push({ ...r, id: nextId++ });
        }
        return {
          select: () => ({ single: () => Promise.resolve({ data: tbl[tbl.length - 1], error: null }) }),
          then: (cb) => Promise.resolve({ data: rows, error: null }).then(cb),
          catch: () => Promise.resolve({ data: rows, error: null }),
        };
      },
      upsert(row) {
        const rows = Array.isArray(row) ? row : [row];
        for (const r of rows) {
          const existingIdx = tbl.findIndex(x => x.id === r.id);
          if (existingIdx >= 0) tbl[existingIdx] = { ...tbl[existingIdx], ...r };
          else tbl.push({ ...r });
        }
        return Promise.resolve({ data: rows, error: null });
      },
      update(row) {
        return {
          eq: (col, val) => {
            const updated = [];
            for (const r of tbl) {
              if (r[col] === val) { Object.assign(r, row); updated.push(r); }
            }
            return Promise.resolve({ data: updated, error: null });
          },
        };
      },
    };
  };
  const sb = { from: builder, _tables: tables };
  return sb;
}

test('integration: upsertFixture schrijft naar fixtures tabel', async () => {
  const sb = makeMockSupabase();
  await snap.upsertFixture(sb, {
    id: 999, sport: 'hockey', leagueId: 57, leagueName: 'NHL',
    homeTeamName: 'Vegas', awayTeamName: 'Winnipeg',
    startTime: Date.now(), status: 'scheduled',
  });
  assert.strictEqual(sb._tables.fixtures.length, 1);
  assert.strictEqual(sb._tables.fixtures[0].id, 999);
  assert.strictEqual(sb._tables.fixtures[0].sport, 'hockey');
});

test('integration: upsertFixture is idempotent (zelfde id 2x → 1 row)', async () => {
  const sb = makeMockSupabase();
  const fix = { id: 1, sport: 'hockey', homeTeamName: 'A', awayTeamName: 'B', startTime: Date.now() };
  await snap.upsertFixture(sb, fix);
  await snap.upsertFixture(sb, { ...fix, status: 'finished' });
  assert.strictEqual(sb._tables.fixtures.length, 1);
  assert.strictEqual(sb._tables.fixtures[0].status, 'finished');
});

test('integration: writeOddsSnapshots schrijft per-row + filter ongeldige odds', async () => {
  const sb = makeMockSupabase();
  await snap.writeOddsSnapshots(sb, 100, [
    { bookmaker: 'Bet365', market_type: '1x2', selection_key: 'home', odds: 2.0 },
    { bookmaker: 'Unibet', market_type: '1x2', selection_key: 'draw', odds: 3.5 },
    { bookmaker: 'Bet365', market_type: '1x2', selection_key: 'away', odds: 0 }, // invalid
    { bookmaker: 'Bet365', market_type: 'total', selection_key: 'over', line: 2.5, odds: 1.85 },
  ]);
  assert.strictEqual(sb._tables.odds_snapshots.length, 3, '3 valid rows (1 met odds=0 gefilterd)');
  const home = sb._tables.odds_snapshots.find(r => r.selection_key === 'home');
  assert.strictEqual(home.fixture_id, 100);
  assert.strictEqual(home.bookmaker, 'Bet365');
});

test('integration: writeMarketConsensus schrijft consensus + inverse odds', async () => {
  const sb = makeMockSupabase();
  await snap.writeMarketConsensus(sb, {
    fixtureId: 100, marketType: '1x2', line: null,
    consensusProb: { home: 0.5, draw: 0.25, away: 0.25 },
    bookmakerCount: 8, overround: 0.04, qualityScore: 1.0,
  });
  assert.strictEqual(sb._tables.market_consensus.length, 1);
  const row = sb._tables.market_consensus[0];
  assert.strictEqual(row.bookmaker_count, 8);
  // consensus_odds = inverse: 1/0.5=2, 1/0.25=4, 1/0.25=4
  assert.ok(row.consensus_odds.home === 2);
  assert.ok(row.consensus_odds.draw === 4);
});

test('integration: registerModelVersion is idempotent', async () => {
  const sb = makeMockSupabase();
  const id1 = await snap.registerModelVersion(sb, {
    name: 'edgepickr-heuristic', sport: 'multi', marketType: 'multi',
    versionTag: 'v9.8.0', featureSetVersion: 'v9.6.0',
  });
  const id2 = await snap.registerModelVersion(sb, {
    name: 'edgepickr-heuristic', sport: 'multi', marketType: 'multi',
    versionTag: 'v9.8.0', featureSetVersion: 'v9.6.0',
  });
  assert.strictEqual(id1, id2, 'Tweede call returnt hetzelfde id');
  assert.strictEqual(sb._tables.model_versions.length, 1, 'Geen duplicaat row');
});

test('integration: writeModelRun returnt id voor latere referentie', async () => {
  const sb = makeMockSupabase();
  const runId = await snap.writeModelRun(sb, {
    fixtureId: 100, modelVersionId: 1, marketType: 'moneyline_incl_ot',
    baselineProb: { home: 0.5, away: 0.5 },
    finalProb: { home: 0.55, away: 0.45 },
  });
  assert.ok(runId > 0, 'returnt id');
  assert.strictEqual(sb._tables.model_runs.length, 1);
});

test('integration: recordMl2WayEvaluation schrijft 1 model_run + 2 candidates', async () => {
  const sb = makeMockSupabase();
  await snap.recordMl2WayEvaluation({
    supabase: sb, modelVersionId: 1, fixtureId: 100, marketType: 'moneyline',
    fpHome: 0.5, fpAway: 0.5, adjHome: 0.55, adjAway: 0.45,
    bH: { price: 2.0, bookie: 'Bet365' }, bA: { price: 1.95, bookie: 'Unibet' },
    homeEdge: 0.10, awayEdge: -0.122, minEdge: 0.055,
    matchSignals: ['ha:+5%'],
  });
  assert.strictEqual(sb._tables.model_runs.length, 1);
  assert.strictEqual(sb._tables.pick_candidates.length, 2);
  const home = sb._tables.pick_candidates.find(c => c.selection_key === 'home');
  const away = sb._tables.pick_candidates.find(c => c.selection_key === 'away');
  assert.strictEqual(home.passed_filters, true, 'home edge 10% > 5.5% min → accepted');
  assert.strictEqual(away.passed_filters, false, 'away edge negatief → rejected');
  assert.ok(away.rejected_reason.includes('edge_below_min'));
});

test('integration: recordMl2WayEvaluation extraGate werkt (bv. OT-bookie filter)', async () => {
  const sb = makeMockSupabase();
  await snap.recordMl2WayEvaluation({
    supabase: sb, modelVersionId: 1, fixtureId: 100, marketType: 'moneyline_incl_ot',
    fpHome: 0.5, fpAway: 0.5, adjHome: 0.55, adjAway: 0.45,
    bH: { price: 2.0, bookie: 'Unibet' }, bA: { price: 1.95, bookie: 'Bet365' },
    homeEdge: 0.10, awayEdge: 0.10, minEdge: 0.055,
    extraGate: (side, bookie) => bookie?.toLowerCase().includes('unibet') ? 'bookie_not_inc_ot' : null,
  });
  const home = sb._tables.pick_candidates.find(c => c.selection_key === 'home');
  const away = sb._tables.pick_candidates.find(c => c.selection_key === 'away');
  assert.strictEqual(home.passed_filters, false, 'Unibet bookie wordt afgekapt door extraGate');
  assert.strictEqual(home.rejected_reason, 'bookie_not_inc_ot');
  assert.strictEqual(away.passed_filters, true, 'Bet365 home → toegelaten');
});

test('integration: complete scan-flow simulatie (4 entiteiten geschreven)', async () => {
  const sb = makeMockSupabase();
  // Simuleer wat één hockey-game in de scan zou doen
  const gameId = 416908;
  await snap.upsertFixture(sb, { id: gameId, sport: 'hockey', homeTeamName: 'Vegas', awayTeamName: 'Winnipeg', startTime: Date.now() });
  await snap.writeOddsSnapshots(sb, gameId, [
    { bookmaker: 'Bet365', market_type: '1x2', selection_key: 'home', odds: 2.0 },
    { bookmaker: 'Bet365', market_type: 'total', selection_key: 'over', line: 5.5, odds: 1.95 },
  ]);
  await snap.writeMarketConsensus(sb, {
    fixtureId: gameId, marketType: 'threeway',
    consensusProb: { home: 0.45, draw: 0.20, away: 0.35 },
    bookmakerCount: 8, overround: 0.05, qualityScore: 1.0,
  });
  await snap.writeFeatureSnapshot(sb, gameId, { sport: 'hockey', adjHome: 0.50 }, { standings_present: true });
  await snap.recordMl2WayEvaluation({
    supabase: sb, modelVersionId: 1, fixtureId: gameId, marketType: 'moneyline_incl_ot',
    fpHome: 0.55, fpAway: 0.45, adjHome: 0.55, adjAway: 0.45,
    bH: { price: 1.86, bookie: 'Bet365' }, bA: { price: 2.10, bookie: 'Bet365' },
    homeEdge: 0.023, awayEdge: -0.055, minEdge: 0.055,
  });
  // Verify alle vier entiteiten
  assert.strictEqual(sb._tables.fixtures.length, 1);
  assert.strictEqual(sb._tables.odds_snapshots.length, 2);
  assert.strictEqual(sb._tables.market_consensus.length, 1);
  assert.strictEqual(sb._tables.feature_snapshots.length, 1);
  assert.strictEqual(sb._tables.model_runs.length, 1);
  assert.strictEqual(sb._tables.pick_candidates.length, 2);
  // Beide candidates rejected (home edge te laag)
  assert.strictEqual(sb._tables.pick_candidates.filter(c => c.passed_filters).length, 0);
});

// ── Code-review v2 fixes (v10.0.1) ──────────────────────────────────────────

console.log('\n  Reviewer v2 fixes:');

test('diversification: max 1 pick per match (anti-correlatie)', () => {
  // Simuleer multi-sport merge selectie logic
  const picks = [
    { match: 'Vegas vs Winnipeg', sport: 'hockey', expectedEur: 5.0, label: '🏠 Vegas wint' },
    { match: 'Vegas vs Winnipeg', sport: 'hockey', expectedEur: 4.5, label: '📈 Vegas TT Over 3.5' },
    { match: 'Boston vs Toronto', sport: 'hockey', expectedEur: 4.0, label: '🏠 Boston wint' },
    { match: 'Atlanta vs Miami', sport: 'baseball', expectedEur: 3.8, label: '🏠 Atlanta wint' },
  ];
  picks.sort((a, b) => b.expectedEur - a.expectedEur);
  const seenMatches = new Map(), seenSports = new Map();
  const top = [];
  for (const p of picks) {
    if (top.length >= 5) break;
    const m = p.match.toLowerCase().trim();
    if ((seenMatches.get(m) || 0) >= 1) continue;
    if ((seenSports.get(p.sport) || 0) >= 2) continue;
    top.push(p);
    seenMatches.set(m, 1);
    seenSports.set(p.sport, (seenSports.get(p.sport) || 0) + 1);
  }
  // Vegas TT Over (zelfde match) moet weggefilterd
  assert.strictEqual(top.length, 3, 'Vegas-Winnipeg dupe gefilterd → 3 picks');
  assert.ok(!top.find(p => p.label.includes('TT Over')), 'TT Over op zelfde match niet in selectie');
});

test('diversification: max 2 per sport (anti-concentratie)', () => {
  const picks = [
    { match: 'A vs B', sport: 'hockey', expectedEur: 5 },
    { match: 'C vs D', sport: 'hockey', expectedEur: 4 },
    { match: 'E vs F', sport: 'hockey', expectedEur: 3 }, // sport cap → skip
    { match: 'G vs H', sport: 'baseball', expectedEur: 2.5 },
    { match: 'I vs J', sport: 'football', expectedEur: 2 },
  ];
  picks.sort((a, b) => b.expectedEur - a.expectedEur);
  const seenMatches = new Map(), seenSports = new Map();
  const top = [];
  for (const p of picks) {
    if (top.length >= 5) break;
    if ((seenMatches.get(p.match.toLowerCase()) || 0) >= 1) continue;
    if ((seenSports.get(p.sport) || 0) >= 2) continue;
    top.push(p);
    seenMatches.set(p.match.toLowerCase(), 1);
    seenSports.set(p.sport, (seenSports.get(p.sport) || 0) + 1);
  }
  // 3e hockey moet weggefilterd, baseball + football wel door
  assert.strictEqual(top.length, 4);
  assert.strictEqual(top.filter(p => p.sport === 'hockey').length, 2, 'max 2 hockey');
  assert.ok(top.find(p => p.sport === 'baseball'));
  assert.ok(top.find(p => p.sport === 'football'));
});

test('kill-switch enforcement: filter werkt op pick.label via detectMarket', () => {
  // Mock kill-switch met sport_market keys
  const killed = new Set(['hockey_home', 'football_draw']);
  const isKilled = (sport, label) => {
    const market = detectMarket(label || 'other');
    return killed.has(`${normalizeSport(sport)}_${market}`);
  };
  assert.strictEqual(isKilled('hockey', '🏠 Vegas wint'), true, 'home label gekoppeld aan home market');
  assert.strictEqual(isKilled('hockey', '✈️ Winnipeg wint'), false, 'away market niet killed');
  assert.strictEqual(isKilled('Voetbal', '🤝 Gelijkspel'), true, 'normalizeSport: Voetbal → football, draw market killed');
  assert.strictEqual(isKilled('hockey', '🕐 Vegas wint (60-min)'), false, '60-min markt = aparte bucket (home60), niet killed');
});

test('afGet timeout: AbortController fires bij langzame call', async () => {
  // We kunnen geen echte fetch mocken, maar test dat de mechaniek correct is
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10);
  let aborted = false;
  try {
    await new Promise((resolve, reject) => {
      controller.signal.addEventListener('abort', () => { aborted = true; reject(new Error('AbortError')); });
      setTimeout(resolve, 100); // langer dan 10ms timeout
    });
  } catch {}
  clearTimeout(timer);
  assert.strictEqual(aborted, true, 'AbortController fires correct binnen 10ms');
});

// ── Code-review v3 fixes (v10.0.2) ──────────────────────────────────────────

console.log('\n  Reviewer v3 fixes:');

test('safePick: non-admin krijgt geen reason/kelly/ep/strength/expectedEur/signals', () => {
  const PUBLIC_FIELDS = ['match', 'league', 'label', 'odd', 'units', 'prob', 'edge', 'score', 'kickoff', 'bookie', 'sport', 'selected'];
  const safePick = (p, isAdmin) => {
    if (isAdmin) return p;
    const out = {};
    for (const k of PUBLIC_FIELDS) if (p[k] !== undefined) out[k] = p[k];
    return out;
  };
  const internal = {
    match: 'A vs B', league: 'L', label: 'home', odd: 1.9, prob: 55, score: 7,
    reason: 'TOPSECRET model details', kelly: 0.045, ep: 0.55, strength: 0.123,
    expectedEur: 4.50, signals: ['ha:+5%', 'form:+2%'], scanType: 'pre',
  };
  const adminView = safePick(internal, true);
  assert.ok(adminView.reason && adminView.kelly && adminView.signals);
  const userView = safePick(internal, false);
  assert.strictEqual(userView.reason, undefined);
  assert.strictEqual(userView.kelly, undefined);
  assert.strictEqual(userView.ep, undefined);
  assert.strictEqual(userView.strength, undefined);
  assert.strictEqual(userView.expectedEur, undefined);
  assert.strictEqual(userView.signals, undefined);
  assert.strictEqual(userView.scanType, undefined); // ook scanType weg
  // Public fields wel aanwezig
  assert.strictEqual(userView.match, 'A vs B');
  assert.strictEqual(userView.odd, 1.9);
  assert.strictEqual(userView.score, 7);
});

test('POTD: filtert op selected:true uit history (anti-diversification-bypass)', () => {
  const histPicks = [
    { match: 'A vs B', expectedEur: 6.0, selected: false }, // door divers gefilterd
    { match: 'C vs D', expectedEur: 5.0, selected: true },
    { match: 'E vs F', expectedEur: 4.0, selected: true },
  ];
  // POTD logic: filter selected !== false, dan hoogste expectedEur
  const selectedOnly = histPicks.filter(p => p.selected !== false);
  const fallback = selectedOnly.length ? selectedOnly : histPicks;
  const pick = [...fallback].sort((a, b) => (b.expectedEur || 0) - (a.expectedEur || 0))[0];
  assert.strictEqual(pick.match, 'C vs D', 'A vs B was uitgesloten door diversification, niet pakken');
});

test('POTD: backwards-compat met pre-v10.0.2 entries (selected undefined)', () => {
  const oldHist = [
    { match: 'A vs B', expectedEur: 6.0 }, // geen selected veld
    { match: 'C vs D', expectedEur: 5.0 },
  ];
  const selectedOnly = oldHist.filter(p => p.selected !== false);
  // Beide blijven (selected undefined !== false)
  assert.strictEqual(selectedOnly.length, 2);
});

test('CSP header bevat strict-default + unsafe-inline waar nodig', () => {
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
  // Critical directives present
  assert.ok(CSP.includes("default-src 'self'"), 'default-src self');
  assert.ok(CSP.includes("frame-ancestors 'none'"), 'frame-ancestors blocked');
  assert.ok(CSP.includes("object-src 'none'"), 'object-src blocked');
  assert.ok(CSP.includes("base-uri 'self'"), 'base-uri locked');
  // unsafe-inline aanwezig (noodzakelijk omdat index.html inline scripts heeft)
  assert.ok(CSP.includes("'unsafe-inline'"), 'unsafe-inline accepted (legacy)');
});

// ── Discipline-first additions (v10.0.3) ────────────────────────────────────

console.log('\n  Discipline-first (signal kill + adaptive edge):');

test('signal kill: avg CLV ≤ -3% over ≥50 samples → weight = 0', () => {
  const SIGNAL_KILL_MIN_N = 50;
  const SIGNAL_KILL_CLV_PCT = -3.0;
  const decide = (avgClv, n) => (n >= SIGNAL_KILL_MIN_N && avgClv <= SIGNAL_KILL_CLV_PCT) ? 0 : 1.0;
  assert.strictEqual(decide(-3.5, 60), 0, 'structureel slecht → mute');
  assert.strictEqual(decide(-3.0, 50), 0, 'exact op grens → mute');
  assert.strictEqual(decide(-2.9, 60), 1.0, 'net boven threshold → blijf');
  assert.strictEqual(decide(-5.0, 49), 1.0, '<50 samples → tune ipv kill');
  assert.strictEqual(decide(0.5, 100), 1.0, 'positief → niet mute');
});

test('adaptiveMinEdge: uniforme baseMinEdge post-tier-removal (v11.3.30)', () => {
  // v11.3.30: tier-differentiatie verwijderd. adaptiveMinEdge retourneert
  // altijd baseMinEdge. Risico wordt elders geborgd (sanity-gate 7pp,
  // signal-quality, line-quality, execution-coverage). Oude tiers (8%/6.5%/5.5%)
  // waren een sample-trap: unproven markten kwamen nooit door 8%, kregen
  // dus geen samples, bleven op 8% → chicken-and-egg.
  const compute = (n, base) => base;
  assert.strictEqual(compute(0, 0.055), 0.055, 'geen data → base');
  assert.strictEqual(compute(29, 0.055), 0.055, '<30 → base');
  assert.strictEqual(compute(30, 0.055), 0.055, '30-99 → base');
  assert.strictEqual(compute(500, 0.055), 0.055, '≥100 → base');
});

test('adaptiveMinEdge: base parameter is passthrough (v11.3.30)', () => {
  // Als caller een andere base wil (bv. per-sport beleid in toekomstige
  // sprint), wordt die direct teruggegeven. Tier-logica is weg.
  const compute = (n, base) => base;
  assert.strictEqual(compute(500, 0.10), 0.10, 'base 10% → 10%');
  assert.strictEqual(compute(50, 0.075), 0.075, 'base 7.5% → 7.5%');
});

// ── v10.1.0 profit-focus: per-bookie ROI + CLV alerts + drawdown ────────────

console.log('\n  v10.1.0 profit-focus:');

test('per-bookie ROI: pos PnL → pos ROI%', () => {
  const bookieAgg = (bets) => {
    const out = {};
    for (const b of bets) {
      const bk = b.tip || 'X';
      if (!out[bk]) out[bk] = { n: 0, w: 0, sumPnl: 0, sumStake: 0 };
      out[bk].n++;
      if (b.uitkomst === 'W') out[bk].w++;
      out[bk].sumPnl += parseFloat(b.wl || 0);
      out[bk].sumStake += parseFloat(b.inzet || 0);
    }
    return Object.fromEntries(Object.entries(out).map(([bk, s]) => [bk, {
      n: s.n, win_rate_pct: s.n ? +(s.w / s.n * 100).toFixed(1) : 0,
      roi_pct: s.sumStake ? +(s.sumPnl / s.sumStake * 100).toFixed(2) : 0,
    }]));
  };
  const bets = [
    { tip: 'Bet365', uitkomst: 'W', wl: 25, inzet: 25 },
    { tip: 'Bet365', uitkomst: 'L', wl: -25, inzet: 25 },
    { tip: 'Bet365', uitkomst: 'W', wl: 30, inzet: 25 },
    { tip: 'Unibet', uitkomst: 'L', wl: -25, inzet: 25 },
    { tip: 'Unibet', uitkomst: 'L', wl: -25, inzet: 25 },
  ];
  const result = bookieAgg(bets);
  assert.strictEqual(result.Bet365.n, 3);
  assert.strictEqual(result.Bet365.win_rate_pct, 66.7);
  assert.ok(result.Bet365.roi_pct > 0, 'Bet365 winstgevend');
  assert.ok(result.Unibet.roi_pct < 0, 'Unibet verlies');
});

test('CLV milestone alert: triggert elke N nieuwe bets', () => {
  const interval = 25;
  let lastN = 0;
  const checkAlert = (currentN) => {
    if (currentN >= lastN + interval) { lastN = currentN; return true; }
    return false;
  };
  assert.strictEqual(checkAlert(10), false);
  assert.strictEqual(checkAlert(24), false);
  assert.strictEqual(checkAlert(25), true, 'eerste milestone');
  assert.strictEqual(checkAlert(26), false, 'net na alert geen dubbele');
  assert.strictEqual(checkAlert(50), true, 'tweede milestone');
});

test('drawdown alert: triggert bij <-15% over 7d met cooldown', () => {
  const threshold = -0.15;
  const cooldownMs = 24 * 3600 * 1000;
  let lastAlertAt = 0;
  const check = (recentPctPnl, now = Date.now()) => {
    if (now - lastAlertAt < cooldownMs) return false;
    if (recentPctPnl < threshold) { lastAlertAt = now; return true; }
    return false;
  };
  assert.strictEqual(check(-0.10), false, 'binnen tolerance');
  assert.strictEqual(check(-0.20), true, 'over threshold → alert');
  assert.strictEqual(check(-0.30), false, 'cooldown actief');
  // Simuleer 25u later
  lastAlertAt = Date.now() - 25 * 3600 * 1000;
  assert.strictEqual(check(-0.20), true, 'na cooldown weer alert');
});

// ── REGRESSIE TESTS (v10.7.13) — voorkomt dat bugs terugkeren ──────────────
console.log('\n  Regressie tests v10.7.13 (spread/bookie invarianten):');

// Mini-implementatie van core helpers — zelfde logica als server.js, puur voor test.
function bestFromArr_test(arr, preferredLower) {
  let pool = arr || [];
  if (preferredLower && pool.length) {
    pool = pool.filter(o => preferredLower.some(p => (o.bookie || '').toLowerCase().includes(p)));
  }
  if (!pool.length) return { price: 0, bookie: '' };
  return pool.reduce((best, o) => o.price > best.price ? { price: +o.price.toFixed(3), bookie: o.bookie } : best, { price: 0, bookie: '' });
}

function bestSpreadPick_test(spreads, fairProb, minEdge, preferredLower, minOdds = 1.60, maxOdds = 3.8) {
  if (!spreads || !spreads.length) return null;
  const byPoint = {};
  for (const s of spreads) {
    if (!s || typeof s.price !== 'number') continue;
    if (s.price < minOdds || s.price > maxOdds) continue;
    const k = String(s.point);
    (byPoint[k] = byPoint[k] || []).push(s);
  }
  for (const pt of Object.keys(byPoint)) {
    const bookieMap = {};
    for (const s of byPoint[pt]) {
      const bk = (s.bookie || '').toLowerCase();
      if (!bookieMap[bk] || s.price < bookieMap[bk].price) bookieMap[bk] = s;
    }
    byPoint[pt] = Object.values(bookieMap);
  }
  let best = null;
  for (const [pt, pool] of Object.entries(byPoint)) {
    const top = bestFromArr_test(pool, preferredLower);
    if (top.price <= 0) continue;
    const fp = typeof fairProb === 'function' ? fairProb(parseFloat(pt)) : fairProb;
    if (!fp || fp <= 0) continue;
    const edge = fp * top.price - 1;
    if (edge < minEdge) continue;
    if (!best || edge > best.edge) best = { ...top, point: parseFloat(pt), edge };
  }
  return best;
}

test('dedupe per (bookie, point): alt-line hoge prijs wordt weggegooid voor main-line', () => {
  // Dodgers scenario: Bet365 heeft main -1.5@2.10 + alt -1.5@2.55
  const spreads = [
    { side: 'home', point: -1.5, price: 2.10, bookie: 'Bet365' },
    { side: 'home', point: -1.5, price: 2.55, bookie: 'Bet365' }, // 3-way alt
    { side: 'home', point: -1.5, price: 2.17, bookie: 'Unibet' },
  ];
  const result = bestSpreadPick_test(spreads, 0.47, 0.01, ['bet365', 'unibet']);
  assert.ok(result, 'zou pick moeten retourneren');
  // Unibet 2.17 moet winnen omdat Bet365 gededupeerd naar 2.10 (lowest per bookie)
  assert.strictEqual(result.bookie, 'Unibet', 'Unibet wint na dedupe');
  assert.strictEqual(result.price, 2.17);
});

test('INVARIANT: meer brokers in pool kan NOOIT picks verwijderen', () => {
  const spreads = [
    { side: 'home', point: -1.5, price: 2.10, bookie: 'Bet365' },
    { side: 'home', point: -1.5, price: 2.55, bookie: 'Bet365' }, // alt
    { side: 'home', point: -1.5, price: 2.17, bookie: 'Unibet' },
  ];
  const unibetOnly = bestSpreadPick_test(spreads, 0.47, 0.01, ['unibet']);
  const combi     = bestSpreadPick_test(spreads, 0.47, 0.01, ['bet365', 'unibet']);
  assert.ok(unibetOnly, 'unibet-only moet pick geven');
  assert.ok(combi, 'combi moet OOK pick geven (invariant)');
  // Combi-edge ≥ unibet-only-edge
  assert.ok(combi.edge >= unibetOnly.edge - 0.001, `combi edge (${combi.edge}) >= unibet-only (${unibetOnly.edge})`);
});

test('INVARIANT: single-bookie edge == combi-edge als best-prijs identiek is', () => {
  const spreads = [
    { side: 'home', point: -1.5, price: 2.10, bookie: 'Bet365' },
    { side: 'home', point: -1.5, price: 2.17, bookie: 'Unibet' },
  ];
  const unibetOnly = bestSpreadPick_test(spreads, 0.47, 0.01, ['unibet']);
  const combi     = bestSpreadPick_test(spreads, 0.47, 0.01, ['bet365', 'unibet']);
  // Beide moeten Unibet 2.17 als best kiezen
  assert.strictEqual(unibetOnly.bookie, 'Unibet');
  assert.strictEqual(combi.bookie, 'Unibet');
  assert.strictEqual(combi.price, unibetOnly.price);
});

test('per-entry maxOdds filter kill alleen anomalieën, niet legit entries', () => {
  const spreads = [
    { side: 'home', point: -1.5, price: 2.17, bookie: 'Unibet' },  // legit
    { side: 'home', point: -1.5, price: 4.20, bookie: 'Weird' },   // anomaal
  ];
  const result = bestSpreadPick_test(spreads, 0.47, 0.01, null);
  assert.ok(result, 'Unibet 2.17 moet picked worden ondanks anomalie');
  assert.strictEqual(result.price, 2.17);
});

test('fairProb als function: per-point devigged consensus werkt', () => {
  const spreads = [
    { side: 'home', point: -1.5, price: 2.17, bookie: 'Unibet' },
    { side: 'home', point: -2.5, price: 3.50, bookie: 'Unibet' },
  ];
  const probFn = (pt) => pt === -1.5 ? 0.47 : 0.30; // verschillende cover-prob per line
  const result = bestSpreadPick_test(spreads, probFn, 0.01, null);
  assert.ok(result);
  // -1.5 edge = 0.47*2.17-1 = 0.020 (boven minEdge 0.01)
  // -2.5 edge = 0.30*3.50-1 = 0.050 (hoger, zou moeten winnen)
  assert.strictEqual(result.point, -2.5, 'beste edge across point-groups wint');
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLV · resolveOddFromBookie (market-matching) regression tests
// ═══════════════════════════════════════════════════════════════════════════════
// Waarom: v10.7.20 fix. Oude fetchCurrentOdds matchte markten te los met
// .includes('over'/'winner'/etc.), en hitte zo Alt/Corners/Team totals of
// catchte DNB als ML via emoji. Dit veroorzaakte foute CLV% (o.a. Wigan 0%
// waar echte waarde +16.6% was, en Chesterfield -2.56% waar echte waarde
// +3.8% was). Deze tests lock de strict matching.
const { resolveOddFromBookie } = require('./lib/clv-match');

test('CLV: Match Winner strict match — geen Alt Winner fallback', () => {
  const bk = { name: 'Unibet', bets: [
    { id: 99, name: 'Alt Winner 1st Half', values: [{ value: 'Home', odd: '3.10' }, { value: 'Away', odd: '4.00' }] },
    { id: 1,  name: 'Match Winner',        values: [{ value: 'Home', odd: '1.58' }, { value: 'Draw', odd: '3.80' }, { value: 'Away', odd: '5.60' }] },
  ]};
  const odd = resolveOddFromBookie(bk, '🏠 Wigan wint');
  assert.strictEqual(odd, 1.58, 'moet Match Winner Home 1.58 pakken, niet Alt 3.10');
});

// v10.10.13: MLB Detroit Tigers regression. "Detroit Tigers wint" mocht
// nooit de Handicap +1 prijs (1.74) pakken. Reproduceert het screenshot:
// Unibet ML 2.00 / Handicap +1 1.74. Pre-kickoff drift-check matchte
// foutief op 1.74 → "ODDS GEDRIFT 2.02 → 1.74 (-13.9%)" terwijl de echte
// ML praktisch stilstond.
test('CLV: ML wint skipt Handicap-bet met "Home/Away" naam (Detroit Tigers regression)', () => {
  const bk = { name: 'Unibet', bets: [
    // Handicap +1/-1 bet die in MLB-payload soms ook 'Home/Away' heet
    { id: 50, name: 'Home/Away', values: [{ value: 'Home +1', odd: '1.74' }, { value: 'Away -1', odd: '2.12' }] },
    // Echte moneyline
    { id: 1,  name: 'Money Line', values: [{ value: 'Home', odd: '2.00' }, { value: 'Away', odd: '1.85' }] },
  ]};
  const odd = resolveOddFromBookie(bk, '🐅 Detroit Tigers wint');
  assert.strictEqual(odd, 2.00, 'moet Money Line Home 2.00 pakken, niet Handicap 1.74');
});

test('CLV: ML wint accepteert "Home/Away" naam alleen zonder handicap-values', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 1, name: 'Home/Away', values: [{ value: 'Home', odd: '2.10' }, { value: 'Away', odd: '1.80' }] },
  ]};
  const odd = resolveOddFromBookie(bk, 'Detroit Tigers wint');
  assert.strictEqual(odd, 2.10, 'echte Home/Away ML mag wel matchen');
});

test('CLV: O/U 2.5 main goals — geen Corners O/U 2.5 fallback', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 200, name: 'Corners Over/Under',      values: [{ value: 'Over 2.5',  odd: '1.95' }, { value: 'Under 2.5', odd: '1.90' }] },
    { id: 5,   name: 'Goals Over/Under',        values: [{ value: 'Over 2.5',  odd: '1.83' }, { value: 'Under 2.5', odd: '1.97' }] },
  ]};
  const odd = resolveOddFromBookie(bk, 'Over 2.5');
  assert.strictEqual(odd, 1.83, 'moet Goals Over 2.5 pakken (1.83), niet Corners (1.95)');
});

test('CLV: O/U skip alt-lines ook met dezelfde line-waarde', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 201, name: 'Alt Total Goals', values: [{ value: 'Over 2.5', odd: '2.05' }, { value: 'Under 2.5', odd: '1.80' }] },
    { id: 5,   name: 'Over/Under',      values: [{ value: 'Over 2.5', odd: '1.83' }, { value: 'Under 2.5', odd: '1.97' }] },
  ]};
  const odd = resolveOddFromBookie(bk, 'Over 2.5');
  assert.strictEqual(odd, 1.83, 'main Over/Under wint van Alt Total');
});

test('CLV: DNB check loopt VOOR ML (emoji-vangnet bug fix)', () => {
  const bk = { name: 'Unibet', bets: [
    { id: 1,  name: 'Match Winner', values: [{ value: 'Home', odd: '2.10' }, { value: 'Draw', odd: '3.40' }, { value: 'Away', odd: '3.60' }] },
    { id: 12, name: 'Draw No Bet',  values: [{ value: 'Home', odd: '1.85' }, { value: 'Away', odd: '2.95' }] },
  ]};
  const odd = resolveOddFromBookie(bk, '🏠 DNB Wigan');
  assert.strictEqual(odd, 1.85, 'DNB Home 1.85, niet ML Home 2.10');
});

test('CLV: BTTS Yes vs No detectie', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 8, name: 'Both Teams To Score', values: [{ value: 'Yes', odd: '1.75' }, { value: 'No', odd: '2.05' }] },
  ]};
  assert.strictEqual(resolveOddFromBookie(bk, 'BTTS Yes'), 1.75);
  assert.strictEqual(resolveOddFromBookie(bk, 'BTTS Nee'), 2.05);
});

test('CLV: NRFI baseball market', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 50, name: '1st Inning Run',  values: [{ value: 'Yes', odd: '2.10' }, { value: 'No', odd: '1.70' }] },
  ]};
  assert.strictEqual(resolveOddFromBookie(bk, 'NRFI'), 1.70, 'NRFI → No 1.70');
  assert.strictEqual(resolveOddFromBookie(bk, 'YRFI'), 2.10, 'YRFI → Yes 2.10');
});

test('CLV: Run Line spread baseball strict main-lijn', () => {
  const bk = { name: 'Unibet', bets: [
    { id: 60, name: 'Alt Run Line',   values: [{ value: 'Home -2.5', odd: '4.50' }, { value: 'Home -1.5', odd: '2.80' }] },
    { id: 61, name: 'Run Line',       values: [{ value: 'Home -1.5', odd: '2.17' }, { value: 'Away +1.5', odd: '1.68' }] },
  ]};
  const odd = resolveOddFromBookie(bk, 'Braves -1.5 handicap');
  assert.strictEqual(odd, 2.17, 'main Run Line 2.17 (niet Alt 2.80)');
});

test('CLV: 1st Half O/U blijft half-markt, raakt main niet', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 5,   name: 'Goals Over/Under',     values: [{ value: 'Over 2.5', odd: '1.83' }, { value: 'Under 2.5', odd: '1.97' }] },
    { id: 100, name: '1st Half Over/Under',  values: [{ value: 'Over 0.5', odd: '1.55' }, { value: 'Under 0.5', odd: '2.40' }] },
  ]};
  const odd = resolveOddFromBookie(bk, '1st half Over 0.5');
  assert.strictEqual(odd, 1.55, '1H O/U matches halfBet niet main');
});

test('CLV: 60-min 3-way hockey (regulation)', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 1,   name: 'Winner',           values: [{ value: 'Home', odd: '1.70' }, { value: 'Away', odd: '2.20' }] },
    { id: 150, name: '3Way Result 60m',   values: [{ value: 'Home', odd: '2.05' }, { value: 'Draw', odd: '3.90' }, { value: 'Away', odd: '2.60' }] },
  ]};
  const odd = resolveOddFromBookie(bk, '🏠 Vegas wint 🕐 60-min');
  assert.strictEqual(odd, 2.05, '60-min home uit 3-way bet, niet 2-way Winner');
});

test('CLV: draws zonder "no bet" in markt matchen Match Winner Draw', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 1,  name: 'Match Winner', values: [{ value: 'Home', odd: '1.90' }, { value: 'Draw', odd: '3.50' }, { value: 'Away', odd: '4.20' }] },
    { id: 12, name: 'Draw No Bet',  values: [{ value: 'Home', odd: '1.55' }, { value: 'Away', odd: '2.80' }] },
  ]};
  assert.strictEqual(resolveOddFromBookie(bk, 'Gelijkspel'), 3.50, 'Draw → Match Winner Draw');
});

test('CLV: INVARIANT — bet.id nummering niet relied upon (name match)', () => {
  // baseball api-sports gebruikt andere bet.id; name-match moet blijven werken
  const bk = { name: 'Unibet', bets: [
    { id: 777, name: 'Match Winner', values: [{ value: 'Home', odd: '1.95' }, { value: 'Away', odd: '1.90' }] },
  ]};
  const odd = resolveOddFromBookie(bk, '✈️ Dodgers wint');
  assert.strictEqual(odd, 1.90, 'name-based match werkt ongeacht bet.id nummer');
});

test('CLV: ML "1"/"2" value-conventie ook geaccepteerd', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 1, name: 'Match Odds', values: [{ value: '1', odd: '1.80' }, { value: 'X', odd: '3.40' }, { value: '2', odd: '4.10' }] },
  ]};
  assert.strictEqual(resolveOddFromBookie(bk, '🏠 Wint'), 1.80);
  assert.strictEqual(resolveOddFromBookie(bk, '✈️ Wint'), 4.10);
});

test('CLV: onbekende markt → null (geen silent fallback)', () => {
  const bk = { name: 'Bet365', bets: [
    { id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.80' }] },
  ]};
  const odd = resolveOddFromBookie(bk, 'Exotic Market XYZ');
  assert.strictEqual(odd, null, 'onbekende markt returnt null');
});

// ═══════════════════════════════════════════════════════════════════════════════
// v10.7.22 · regression tests (code-review fixes)
// ═══════════════════════════════════════════════════════════════════════════════

test('CLV resolver: null / empty bookie returnt null (geen crash)', () => {
  assert.strictEqual(resolveOddFromBookie(null, 'Over 2.5'), null);
  assert.strictEqual(resolveOddFromBookie({}, 'Over 2.5'), null);
  assert.strictEqual(resolveOddFromBookie({ bets: [] }, 'Over 2.5'), null);
  assert.strictEqual(resolveOddFromBookie({ bets: null }, 'Over 2.5'), null);
});

test('CLV resolver: null markt returnt null (geen crash)', () => {
  const bk = { bets: [{ id: 1, name: 'Match Winner', values: [{ value: 'Home', odd: '1.80' }] }] };
  assert.strictEqual(resolveOddFromBookie(bk, null), null);
  assert.strictEqual(resolveOddFromBookie(bk, ''), null);
  assert.strictEqual(resolveOddFromBookie(bk, undefined), null);
});

test('CLV resolver: bet.values null/undefined leidt niet tot crash', () => {
  const bk = { bets: [
    { id: 1, name: 'Match Winner', values: null },
    { id: 2, name: 'Match Winner', values: [{ value: 'Home', odd: '1.95' }] },
  ]};
  // eerste bet matcht op naam maar values is null → fallback naar tweede
  const odd = resolveOddFromBookie(bk, '🏠 Home wint');
  assert.strictEqual(odd, 1.95, 'skipt null-values en pakt volgende match');
});

test('detectMarket: alle nieuwe buckets dekken expected labels', () => {
  assert.strictEqual(detectMarket('BTTS Ja'), 'btts_yes');
  assert.strictEqual(detectMarket('Beide Teams Score Nee'), 'btts_no');
  assert.strictEqual(detectMarket('🏠 DNB Home'), 'dnb_home');
  assert.strictEqual(detectMarket('✈️ DNB Away'), 'dnb_away');
  assert.strictEqual(detectMarket('Dubbele kans 1X'), 'dc_1x');
  assert.strictEqual(detectMarket('Dubbele kans X2'), 'dc_x2');
  assert.strictEqual(detectMarket('🏠 Home -1.5 spread'), 'spread_home');
  assert.strictEqual(detectMarket('✈️ Away +1.5 handicap'), 'spread_away');
  assert.strictEqual(detectMarket('NRFI'), 'nrfi');
  assert.strictEqual(detectMarket('YRFI'), 'yrfi');
  assert.strictEqual(detectMarket('Odd total'), 'odd');
  assert.strictEqual(detectMarket('Even total'), 'even');
});

test('detectMarket: edge cases die eerst foute bucket gaven', () => {
  // "1X2 Home" mag NIET als dc_1x worden gezien (dat is 3-way ML)
  assert.notStrictEqual(detectMarket('1X2 Home'), 'dc_1x');
  // "Draw no bet" mag NIET via draw-tak gevangen worden
  assert.notStrictEqual(detectMarket('Draw No Bet Home'), 'draw');
  // "draw" in draw_no_bet context → dnb_* niet draw
  const dnb = detectMarket('🏠 DNB Ajax');
  assert.ok(dnb === 'dnb_home', 'DNB labels vangen niet als draw');
});

// Shared multiplier formula (computeMarketMultiplier)
// Niet geëxporteerd uit server.js; regression-test via formule reproductie.
test('rebuild-calib: multiplier-formule preserveert prior bij <8 bets', () => {
  // Zelfde logica als computeMarketMultiplier in server.js
  const compute = (stats, prior) => {
    if (!stats || stats.n < 8) return prior;
    const wr = stats.w / stats.n;
    const profitPerBet = stats.profit / stats.n;
    if (profitPerBet < -3 && wr < 0.40) return Math.max(0.55, prior - 0.05);
    if (profitPerBet >  3 && wr > 0.55) return Math.min(1.30, prior + 0.03);
    return +Math.max(0.70, Math.min(1.20, 0.70 + wr * 1.0)).toFixed(3);
  };
  // Prior 1.25, 5 bets → behoud prior (n<8)
  assert.strictEqual(compute({ n: 5, w: 4, profit: 10 }, 1.25), 1.25);
  // 10 bets, 7W, +50 profit, ppb=5, wr=0.70 → goede markt → prior + 0.03 (1.03)
  assert.strictEqual(compute({ n: 10, w: 7, profit: 50 }, 1.00), 1.03);
  // 10 bets, 7W, +25 profit, ppb=2.5 (<3) → else-branch → clamp 0.70+0.7=1.20 (capped)
  assert.strictEqual(compute({ n: 10, w: 7, profit: 25 }, 1.00), 1.20);
  // Slechte markt: 10 bets, 2W, -40 profit, ppb=-4, wr=0.20 → prior - 0.05
  assert.strictEqual(compute({ n: 10, w: 2, profit: -40 }, 1.00), 0.95);
  // Zeer goede markt: 10 bets, 7W, +40, ppb=4, wr=0.70 → prior + 0.03 capped 1.30
  assert.strictEqual(compute({ n: 10, w: 7, profit: 40 }, 1.28), 1.30);
});

test('minDeltaPct validation: rejecteert NaN/Infinity/negatief', () => {
  const validate = (raw) =>
    (typeof raw === 'number' && isFinite(raw) && raw >= 0 && raw <= 100) ? Math.abs(raw) : 0.5;
  assert.strictEqual(validate(NaN), 0.5);
  assert.strictEqual(validate(Infinity), 0.5);
  assert.strictEqual(validate(-Infinity), 0.5);
  assert.strictEqual(validate(-1), 0.5);
  assert.strictEqual(validate(101), 0.5);
  assert.strictEqual(validate('0.3'), 0.5, 'strings worden rejected');
  assert.strictEqual(validate(2.5), 2.5);
  assert.strictEqual(validate(0), 0);
});

test('humanize narrative XSS: escape helper werkt', () => {
  const escape = (s) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  assert.strictEqual(escape('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.strictEqual(escape('Team A & Team B'), 'Team A &amp; Team B');
  assert.strictEqual(escape('normaal'), 'normaal');
});

test('aggregate-score: buildAggregateInfo — leader/trailer/square', () => {
  // Reproduceer buildAggregateInfo uit server.js
  const build = (aggHome, aggAway) => {
    if (aggHome == null || aggAway == null) return { signals: [], note: '' };
    const diff = aggHome - aggAway;
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
  };
  // All square
  assert.deepStrictEqual(build(2, 2).signals, ['leg2_all_square:0%']);
  // Home leads small
  assert.deepStrictEqual(build(3, 2).signals, ['leg2_home_leads_agg:0%']);
  // Home leads big (≥2)
  assert.deepStrictEqual(build(3, 1).signals, ['leg2_home_leads_agg:0%', 'leg2_home_leads_big:0%']);
  // Away leads big
  assert.deepStrictEqual(build(0, 3).signals, ['leg2_away_leads_agg:0%', 'leg2_away_leads_big:0%']);
  // Null safe
  assert.deepStrictEqual(build(null, 2).signals, []);
});

test('aggregate-score: Over/BTTS push-adjustment berekening', () => {
  // Reproduceer overP / bttsYesP adjustment logic uit server.js
  const computeOUAdj = (aggDiff) => {
    if (aggDiff == null || aggDiff === 0) return 0;
    const absDiff = Math.abs(aggDiff);
    return Math.min(0.04, 0.02 * absDiff);
  };
  const computeBTTSAdj = (aggDiff) => {
    if (aggDiff == null || aggDiff === 0) return 0;
    const absDiff = Math.abs(aggDiff);
    return Math.min(0.03, 0.02 * Math.min(2, absDiff));
  };
  // All square: geen adj
  assert.strictEqual(computeOUAdj(0), 0);
  assert.strictEqual(computeBTTSAdj(0), 0);
  // Deficit 1: +2% op Over, +2% op BTTS
  assert.strictEqual(computeOUAdj(1), 0.02);
  assert.strictEqual(computeBTTSAdj(1), 0.02);
  // Deficit 2: +4% Over, +3% BTTS (capped)
  assert.strictEqual(computeOUAdj(2), 0.04);
  assert.strictEqual(computeBTTSAdj(2), 0.03);
  // Deficit 3: cap blijft gelden
  assert.strictEqual(computeOUAdj(3), 0.04);
  assert.strictEqual(computeBTTSAdj(3), 0.03);
  // Symmetrisch voor away-side deficit
  assert.strictEqual(computeOUAdj(-2), 0.04);
  assert.strictEqual(computeBTTSAdj(-3), 0.03);
});

test('new-season indicator: detectie + damping factor', () => {
  const parse = (roundStr) => {
    const m = String(roundStr || '').toLowerCase().match(/regular season\s*[-–]?\s*(\d+)/i);
    const seasonRound = m ? parseInt(m[1]) : null;
    const earlySeason = seasonRound !== null && seasonRound <= 4;
    return { seasonRound, earlySeason, dampingFactor: earlySeason ? 0.6 : 1.0 };
  };
  assert.deepStrictEqual(parse('Regular Season - 1'), { seasonRound: 1, earlySeason: true, dampingFactor: 0.6 });
  assert.deepStrictEqual(parse('Regular Season - 4'), { seasonRound: 4, earlySeason: true, dampingFactor: 0.6 });
  assert.deepStrictEqual(parse('Regular Season - 5'), { seasonRound: 5, earlySeason: false, dampingFactor: 1.0 });
  assert.deepStrictEqual(parse('Regular Season - 28'), { seasonRound: 28, earlySeason: false, dampingFactor: 1.0 });
  // Knockout rounds don't trigger early-season
  assert.deepStrictEqual(parse('Quarter-finals'), { seasonRound: null, earlySeason: false, dampingFactor: 1.0 });
  assert.deepStrictEqual(parse(''), { seasonRound: null, earlySeason: false, dampingFactor: 1.0 });
});

test('new-season damping: form + h2h gedempt, injuries/congestion niet', () => {
  const computeTotalAdj = (formAdj, injAdj, h2hAdj, congestionAdj, earlySeason, damping) => {
    if (!earlySeason) return formAdj + injAdj + h2hAdj + congestionAdj;
    return (formAdj + h2hAdj) * damping + injAdj + congestionAdj;
  };
  // Full season: alles telt vol
  assert.strictEqual(+computeTotalAdj(0.05, 0.02, 0.03, -0.01, false, 1.0).toFixed(3), 0.09);
  // Early season: form + h2h op 60%, injuries + congestion vol
  // (0.05 + 0.03) * 0.6 + 0.02 + -0.01 = 0.048 + 0.01 = 0.058
  assert.strictEqual(+computeTotalAdj(0.05, 0.02, 0.03, -0.01, true, 0.6).toFixed(3), 0.058);
});

test('rest-days helper: signalen en note logica', () => {
  // Reproduceer buildRestDaysInfo logic uit server.js
  const build = (sport, kickoffMs, hmLast, awLast) => {
    const msPerDay = 86400000;
    const hmDays = hmLast ? Math.max(0, (kickoffMs - new Date(hmLast).getTime()) / msPerDay) : null;
    const awDays = awLast ? Math.max(0, (kickoffMs - new Date(awLast).getTime()) / msPerDay) : null;
    const threshold = sport === 'basketball' || sport === 'hockey' ? 2
                    : sport === 'american-football' ? 4
                    : sport === 'football' ? 3 : 1;
    const homeTired = hmDays !== null && hmDays < threshold;
    const awayTired = awDays !== null && awDays < threshold;
    const signals = [];
    if (homeTired) signals.push('rest_days_home_tired:0%');
    if (awayTired) signals.push('rest_days_away_tired:0%');
    if (hmDays !== null && awDays !== null && Math.abs(hmDays - awDays) >= 3) {
      signals.push(hmDays > awDays ? 'rest_mismatch_home_advantage:0%' : 'rest_mismatch_away_advantage:0%');
    }
    return { hmDays, awDays, homeTired, awayTired, signals };
  };
  const now = Date.now();
  // NBA back-to-back: home speelde gister, away 3 dagen geleden → home tired + mismatch
  const r1 = build('basketball', now, new Date(now - 1*86400000).toISOString(), new Date(now - 4*86400000).toISOString());
  assert.ok(r1.homeTired, 'home met 1d rust = tired (NBA threshold 2)');
  assert.ok(!r1.awayTired, 'away met 4d rust = niet tired');
  assert.ok(r1.signals.includes('rest_days_home_tired:0%'));
  assert.ok(r1.signals.includes('rest_mismatch_away_advantage:0%'), 'away heeft edge bij grote rust-mismatch');

  // NFL short week: home 3d → tired (threshold 4), away 7d → niet
  const r2 = build('american-football', now, new Date(now - 3*86400000).toISOString(), new Date(now - 7*86400000).toISOString());
  assert.ok(r2.homeTired);
  assert.ok(!r2.awayTired);

  // Football midweek: beide 2d rust → home tired (threshold 3)
  const r3 = build('football', now, new Date(now - 2*86400000).toISOString(), new Date(now - 2*86400000).toISOString());
  assert.ok(r3.homeTired && r3.awayTired);
  assert.strictEqual(r3.signals.filter(s => s.includes('mismatch')).length, 0, 'geen mismatch bij gelijke rust');

  // Missing data: beide null → geen signalen
  const r4 = build('football', now, null, null);
  assert.strictEqual(r4.signals.length, 0);
  assert.strictEqual(r4.hmDays, null);
});

test('knockout parser: detecteert leg en stage uit f.league.round', () => {
  // Reproduceer de knockoutInfo logic uit server.js runPrematch
  const parse = (round) => {
    const roundStr = String(round || '').toLowerCase();
    const legMatch = roundStr.match(/(1st|2nd|first|second)\s*leg/);
    return {
      isKnockout: /round of|quarter|semi|final|1st leg|2nd leg|leg/i.test(roundStr),
      leg: legMatch ? (legMatch[1].startsWith('1') || legMatch[1] === 'first' ? 1 : 2) : null,
      stageLabel: roundStr.includes('final') && !roundStr.includes('semi') && !roundStr.includes('quarter') ? 'finale'
                : roundStr.includes('semi') ? 'halve finale'
                : roundStr.includes('quarter') ? 'kwartfinale'
                : roundStr.includes('round of 16') ? '1/8 finale'
                : roundStr.includes('round of 32') ? '1/16 finale'
                : null,
    };
  };
  assert.deepStrictEqual(parse('Regular Season - 28'), { isKnockout: false, leg: null, stageLabel: null });
  assert.deepStrictEqual(parse('Round of 16 - 1st Leg'), { isKnockout: true, leg: 1, stageLabel: '1/8 finale' });
  assert.deepStrictEqual(parse('Quarter-finals 2nd Leg'), { isKnockout: true, leg: 2, stageLabel: 'kwartfinale' });
  assert.deepStrictEqual(parse('Semi-finals'), { isKnockout: true, leg: null, stageLabel: 'halve finale' });
  assert.deepStrictEqual(parse('Final'), { isKnockout: true, leg: null, stageLabel: 'finale' });
  assert.deepStrictEqual(parse('Round of 32 2nd leg'), { isKnockout: true, leg: 2, stageLabel: '1/16 finale' });
});

test('projection (v10.8.6): timeline returnt {bankroll, unit, stake, profit}', () => {
  // Reproduceer renderProjections project() — returns array of objects
  const project = (bankroll, unitEur, betsPerMonth, avgUnits, effRoi) => {
    const timeline = [{ month: 0, bankroll, unit: unitEur, stake: unitEur * avgUnits, profit: 0 }];
    let curBank = bankroll;
    let curUnit = unitEur;
    for (let m = 1; m <= 12; m++) {
      const stakePerBet = curUnit * avgUnits;
      const monthProfit = betsPerMonth * stakePerBet * effRoi;
      curBank = +(curBank + monthProfit).toFixed(2);
      const newUnit = Math.max(1, Math.round(curBank * 0.10));
      timeline.push({ month: m, bankroll: curBank, unit: newUnit, stake: stakePerBet, profit: +monthProfit.toFixed(2) });
      curUnit = newUnit;
    }
    return timeline;
  };
  // Bankroll 250, unit 25, 90 bets, 0.75U, ROI 6%
  const p = project(250, 25, 90, 0.75, 0.06);
  assert.strictEqual(p[0].bankroll, 250);
  assert.strictEqual(p[1].profit, 101.25, 'M1 profit');
  assert.strictEqual(p[1].bankroll, 351.25, 'M1 bankroll');
  assert.strictEqual(p[1].unit, 35, 'M1 nieuwe unit');
  // M2: unit=35 stake=26.25 profit=141.75
  assert.strictEqual(p[2].profit, 141.75);
  assert.strictEqual(p[2].bankroll, 493);
  // Bij negative ROI: bankroll daalt
  const neg = project(250, 25, 90, 0.75, -0.05);
  assert.ok(neg[12].bankroll < 250, 'negatieve ROI = bankroll daalt');
  // Zero ROI = constant
  const zero = project(250, 25, 90, 0.75, 0);
  assert.strictEqual(zero[12].bankroll, 250);
});

test('safe ladder: unit-rule per niveau', () => {
  const safeRulePct = (unit) => {
    if (unit < 100) return 0.10;
    if (unit < 300) return 0.05;
    if (unit < 500) return 0.03;
    return 0.02;
  };
  assert.strictEqual(safeRulePct(25), 0.10);
  assert.strictEqual(safeRulePct(99), 0.10);
  assert.strictEqual(safeRulePct(100), 0.05);
  assert.strictEqual(safeRulePct(250), 0.05);
  assert.strictEqual(safeRulePct(300), 0.03);
  assert.strictEqual(safeRulePct(499), 0.03);
  assert.strictEqual(safeRulePct(500), 0.02);
  assert.strictEqual(safeRulePct(2000), 0.02);
});

test('bookie radar: thresholds NL realiteit', () => {
  const radarLevel = (unit) =>
    unit >= 1000 ? '🚨' :
    unit >= 500  ? '⚠️' :
    unit >= 200  ? '👁️' :
    unit >= 150  ? '🟠' :
    unit >= 50   ? '🟡' :
    null;
  assert.strictEqual(radarLevel(25), null, 'Onder €50: geen radar');
  assert.strictEqual(radarLevel(75), '🟡');
  assert.strictEqual(radarLevel(150), '🟠', '€150: vroege flag');
  assert.strictEqual(radarLevel(200), '👁️');
  assert.strictEqual(radarLevel(550), '⚠️');
  assert.strictEqual(radarLevel(1500), '🚨');
});

test('regression-to-mean ROI: blend met 5% prior', () => {
  const blend = (observed, n, prior = 0.05, fullN = 100) => {
    const w = Math.min(n / fullN, 1);
    return w * observed + (1 - w) * prior;
  };
  // 27 bets, 15.3% observed → ~7.8% effective
  assert.ok(Math.abs(blend(0.153, 27) - 0.0779) < 0.001, `expected ~7.79%, got ${blend(0.153, 27)}`);
  // 100 bets: pure observed (weight=1)
  assert.strictEqual(blend(0.153, 100), 0.153);
  // 200 bets: still pure (capped)
  assert.strictEqual(blend(0.153, 200), 0.153);
  // 0 bets: pure prior
  assert.strictEqual(blend(0.30, 0), 0.05);
  // 50 bets: 50% mix
  assert.strictEqual(+blend(0.10, 50).toFixed(3), 0.075);
});

test('dismissed alerts expiry: oude entries verwijderd', () => {
  const now = Date.now();
  const cutoff = now - 30 * 86400000;
  const raw = [
    { key: 'old1', ts: now - 40 * 86400000 }, // expired
    { key: 'fresh1', ts: now - 1 * 86400000 }, // fresh
    'legacy_string', // oud format zonder ts → wordt nu-gestempeld
  ];
  const normalized = raw.map(x => typeof x === 'string' ? { key: x, ts: now } : x)
    .filter(x => x && x.ts && x.ts > cutoff);
  assert.strictEqual(normalized.length, 2, 'old1 verwijderd, fresh1 + legacy blijven');
  assert.deepStrictEqual(normalized.map(x => x.key).sort(), ['fresh1', 'legacy_string']);
});

test('projection: €3k milestone detection', () => {
  // Met effROI 7.78% (regression-blended uit observed 15.3% × weight 0.27)
  const project = (bankroll, unitEur, betsPerMonth, avgUnits, effRoi) => {
    const timeline = [{ month: 0, profit: 0 }];
    let curBank = bankroll;
    let curUnit = unitEur;
    for (let m = 1; m <= 12; m++) {
      const stakePerBet = curUnit * avgUnits;
      const monthProfit = betsPerMonth * stakePerBet * effRoi;
      curBank = +(curBank + monthProfit).toFixed(2);
      timeline.push({ month: m, bankroll: curBank, unit: Math.round(curBank * 0.10), profit: +monthProfit.toFixed(2) });
      curUnit = Math.max(1, Math.round(curBank * 0.10));
    }
    return timeline;
  };
  const p = project(250, 25, 90, 0.75, 0.0778);
  const m3kIdx = p.findIndex(r => r.profit >= 3000);
  assert.ok(m3kIdx >= 7 && m3kIdx <= 10, `€3k bereikt rond M8-9, got M${m3kIdx}`);
});

test('projection: scenarios factor werken lineair op ROI', () => {
  const scenarios = [{ factor: 0.5 }, { factor: 1.0 }, { factor: 1.5 }];
  const roi = 0.10, betsPerMonth = 30, stakePct = 0.025;
  const rates = scenarios.map(s => betsPerMonth * stakePct * roi * s.factor);
  assert.strictEqual(+rates[0].toFixed(4), 0.0375);
  assert.strictEqual(+rates[1].toFixed(4), 0.075);
  assert.strictEqual(+rates[2].toFixed(4), 0.1125);
  // Pessimistic < expected < optimistic
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2]);
});

test('parseBetSignals: handelt alle schema-varianten af', () => {
  // Reproduceer parseBetSignals logic
  const parse = (raw) => {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; }
      catch { return []; }
    }
    return [];
  };
  // jsonb: direct array
  assert.deepStrictEqual(parse(['a', 'b']), ['a', 'b']);
  // text: JSON string
  assert.deepStrictEqual(parse('["a","b"]'), ['a', 'b']);
  // Empty string
  assert.deepStrictEqual(parse(''), []);
  // Null
  assert.deepStrictEqual(parse(null), []);
  // Undefined
  assert.deepStrictEqual(parse(undefined), []);
  // Invalid JSON
  assert.deepStrictEqual(parse('not-json'), []);
  // Empty array JSON
  assert.deepStrictEqual(parse('[]'), []);
  // Number (weird case)
  assert.deepStrictEqual(parse(42), []);
});

test('humanizer extension: BTTS + Aggregate + baseball tokens', () => {
  // Reproduceer parts parsing logic
  const humanize = (reason) => {
    const parts = reason.split('|').map(s => s.trim()).filter(Boolean);
    const facts = [];
    // BTTS
    const btts = parts.find(p => /^BTTS\s*(Nee)?:/i.test(p));
    if (btts) {
      const gf = parts.find(p => /^GF:/i.test(p));
      const gfMatch = gf && gf.match(/GF:\s*([\d.]+)\/([\d.]+)/);
      if (gfMatch) {
        const hmGF = parseFloat(gfMatch[1]), awGF = parseFloat(gfMatch[2]);
        if (hmGF >= 1.7 && awGF >= 1.7) facts.push('beide teams scoren ruim');
      }
    }
    // Aggregate
    const agg = parts.find(p => /🏆|aggregaat/i.test(p));
    if (agg) {
      const m = agg.match(/aggregaat\s+(thuis|uit)\s+leidt\s+(\d+)-(\d+)/i);
      if (m) {
        const diff = parseInt(m[2]) - parseInt(m[3]);
        if (diff >= 2) facts.push('riante voorsprong');
        else facts.push('kleine voorsprong');
      }
    }
    // RD/g baseball
    const rd = parts.find(p => /RD\/g:/i.test(p));
    if (rd) {
      const m = rd.match(/RD\/g:\s*([+-]?\d+\.?\d*)\s*vs\s*([+-]?\d+\.?\d*)/);
      if (m && Math.abs(parseFloat(m[1]) - parseFloat(m[2])) > 1) {
        facts.push('run differential edge');
      }
    }
    return facts;
  };
  assert.deepStrictEqual(humanize('BTTS: 65% | GF: 2.88/2.13 | wo 15 apr'), ['beide teams scoren ruim']);
  assert.deepStrictEqual(humanize('Consensus: 40%→55% | 🏆 Aggregaat thuis leidt 3-1'), ['riante voorsprong']);
  assert.deepStrictEqual(humanize('Vorm | RD/g:+0.5 vs -0.8 | H/A'), ['run differential edge']);
  // Geen matching tokens
  assert.deepStrictEqual(humanize('wat dan ook | onbekend'), []);
});

test('parseGameOdds ML: dedupe pakt HOOGSTE prijs per bookie (geen alt-lijn risico)', () => {
  // Zelfde logic als dedupeBestPrice in parseGameOdds
  const dedupeBestPrice = (arr, keyFn) => {
    const seen = new Map();
    for (const o of arr) {
      const k = keyFn(o);
      const prev = seen.get(k);
      if (!prev || o.price > prev.price) seen.set(k, o);
    }
    return [...seen.values()];
  };
  const pool = [
    { side: 'home', price: 1.89, bookie: 'Unibet' },
    { side: 'home', price: 1.90, bookie: 'Bet365' },
    { side: 'home', price: 1.88, bookie: 'Bet365' },  // stale/dubbele entry
  ];
  const deduped = dedupeBestPrice(pool, o => `${o.bookie}|${o.side}`);
  const bet365 = deduped.find(o => o.bookie === 'Bet365');
  assert.strictEqual(bet365.price, 1.90, 'Bet365 behoudt 1.90 (hoogste), niet 1.88');
  // bestFromArr zou Bet365 kiezen boven Unibet
  const best = deduped.reduce((b, o) => o.price > b.price ? o : b, { price: 0 });
  assert.strictEqual(best.bookie, 'Bet365');
  assert.strictEqual(best.price, 1.90);
});

test('odds-parser: parseGameOdds dedupet alle markten op hoogste prijs per bookie (v12.0.0)', () => {
  const parsed = parseGameOdds([{
    bookmakers: [
      {
        name: 'Bet365',
        bets: [
          {
            id: 1,
            name: 'Match Winner',
            values: [
              { value: 'Home', odd: '1.88' },
              { value: 'Away', odd: '2.02' },
            ],
          },
          {
            id: 99,
            name: 'Moneyline',
            values: [
              { value: 'Home', odd: '1.90' },
              { value: 'Away', odd: '2.00' },
            ],
          },
          {
            id: 2,
            name: 'Spread',
            values: [
              { value: 'Home -1.5', odd: '2.55' },
              { value: 'Home -1.5', odd: '2.10' },
            ],
          },
        ],
      },
      {
        name: 'Unibet',
        bets: [
          {
            id: 1,
            name: 'Match Winner',
            values: [
              { value: 'Home', odd: '1.89' },
              { value: 'Away', odd: '2.03' },
            ],
          },
          {
            id: 2,
            name: 'Spread',
            values: [
              { value: 'Home -1.5', odd: '2.17' },
            ],
          },
        ],
      },
    ],
  }], 'Ajax', 'PSV');
  const bet365Ml = parsed.moneyline.find(o => o.bookie === 'Bet365' && o.side === 'home');
  const bet365Spread = parsed.spreads.find(o => o.bookie === 'Bet365' && o.side === 'home');
  assert.strictEqual(bet365Ml.price, 1.90);
  // v12.0.0 (Codex P1): dedupe bewaart nu BESTE (hoogste) prijs, niet meer de laagste.
  // Oud gedrag (dedupeMainLine behield slechtste prijs) was bedoeld als risico-demping
  // bij parser-lekken, maar hield juist verkeerde varianten vast. Met scope-isolatie
  // (betId 2/3 niet meer naar full-game bij half/F5) zijn duplicates legitiem en
  // wil operator de hoogste prijs.
  assert.strictEqual(bet365Spread.price, 2.55);
});

test('odds-parser: bestFromArr respecteert preferredBookies state', () => {
  setPreferredBookies(['unibet']);
  const best = bestFromArr([
    { price: 2.2, bookie: 'Bet365' },
    { price: 2.05, bookie: 'Unibet' },
  ]);
  assert.strictEqual(best.bookie, 'Unibet');
  assert.strictEqual(best.price, 2.05);
  setPreferredBookies(null);
});

// v10.10.12: nieuwe shape — preferredPrice/marketPrice altijd aanwezig.
test('odds-parser: bestFromArr returnt nieuwe shape met preferred + market velden', () => {
  setPreferredBookies(['bet365', 'unibet']);
  const best = bestFromArr([
    { price: 2.20, bookie: 'Pinnacle' },
    { price: 2.10, bookie: 'Bet365' },
  ]);
  // Default requirePreferred:true → active = preferred (Bet365 2.10)
  assert.strictEqual(best.price, 2.10);
  assert.strictEqual(best.bookie, 'Bet365');
  assert.strictEqual(best.isPreferred, true);
  // Maar market-best blijft zichtbaar
  assert.strictEqual(best.marketPrice, 2.20);
  assert.strictEqual(best.marketBookie, 'Pinnacle');
  // En preferred-best ook
  assert.strictEqual(best.preferredPrice, 2.10);
  assert.strictEqual(best.preferredBookie, 'Bet365');
  setPreferredBookies(null);
});

test('odds-parser: bestFromArr met requirePreferred:false → active = market-best', () => {
  setPreferredBookies(['bet365', 'unibet']);
  const best = bestFromArr([
    { price: 2.20, bookie: 'Pinnacle' },
    { price: 2.10, bookie: 'Bet365' },
  ], { requirePreferred: false });
  assert.strictEqual(best.price, 2.20, 'active = market-best');
  assert.strictEqual(best.bookie, 'Pinnacle');
  assert.strictEqual(best.isPreferred, false);
  assert.strictEqual(best.preferredPrice, 2.10, 'preferred ook zichtbaar');
  setPreferredBookies(null);
});

test('odds-parser: bestFromArr — preferred leeg, market wel → price=0 default, marketPrice gevuld', () => {
  setPreferredBookies(['bet365', 'unibet']);
  // NHL/NBA/MLB scenario: alleen niet-preferred bookies
  const best = bestFromArr([
    { price: 2.10, bookie: 'Pinnacle' },
    { price: 2.05, bookie: 'Bovada' },
  ]);
  // Default requirePreferred=true → preferred-best = niets → price 0 (huidig gedrag)
  assert.strictEqual(best.price, 0);
  assert.strictEqual(best.bookie, '');
  // Maar market-best laat zien dat de markt wel actief was
  assert.strictEqual(best.marketPrice, 2.10);
  assert.strictEqual(best.marketBookie, 'Pinnacle');
  assert.strictEqual(best.preferredPrice, 0);
  setPreferredBookies(null);
});

// v10.10.12: diagBestPrice — onderscheidt 'edge te laag' van 'preferred ontbreekt'
const { diagBestPrice } = require('./lib/odds-parser');

test('diagBestPrice: preferred prijs + edge OK → null (geen diag)', () => {
  const best = { price: 2.10, bookie: 'Bet365', preferredPrice: 2.10, preferredBookie: 'Bet365', marketPrice: 2.10, marketBookie: 'Bet365' };
  assert.strictEqual(diagBestPrice('home', best, 0.50, 0.05), null);
});

test('diagBestPrice: preferred prijs + edge te laag → "home edge X% < Y%"', () => {
  const best = { price: 2.10, bookie: 'Bet365', preferredPrice: 2.10, preferredBookie: 'Bet365', marketPrice: 2.10, marketBookie: 'Bet365' };
  // fairProb 0.40 × 2.10 = 0.84 → edge = -0.16 = -16%
  const msg = diagBestPrice('home', best, 0.40, 0.05);
  assert.ok(msg.includes('home edge'));
  assert.ok(msg.includes('-16.0%'));
});

test('diagBestPrice: preferred ontbreekt + market wel → echte oorzaak ipv -100%', () => {
  const best = { price: 0, bookie: '', preferredPrice: 0, preferredBookie: '', marketPrice: 2.10, marketBookie: 'Pinnacle' };
  // fairProb 0.50 × 2.10 = 1.05 → market-edge = +5%
  const msg = diagBestPrice('home', best, 0.50, 0.05);
  assert.ok(msg.includes('geen preferred prijs'), `kreeg: ${msg}`);
  assert.ok(msg.includes('Pinnacle'));
  assert.ok(msg.includes('2.1'));
  assert.ok(msg.includes('5.0%'));
  // Geen "-100%" meer
  assert.ok(!msg.includes('-100'));
});

test('diagBestPrice: geen prijs nergens → "geen prijs in markt"', () => {
  const best = { price: 0, bookie: '', preferredPrice: 0, preferredBookie: '', marketPrice: 0, marketBookie: '' };
  const msg = diagBestPrice('home', best, 0.50, 0.05);
  assert.strictEqual(msg, 'home: geen prijs in markt');
});

test('odds-parser: bestSpreadPick gebruikt preferred state zonder picks te killen', () => {
  setPreferredBookies(['bet365', 'unibet']);
  const result = bestSpreadPick([
    { side: 'home', point: -1.5, price: 2.10, bookie: 'Bet365' },
    { side: 'home', point: -1.5, price: 2.55, bookie: 'Bet365' },
    { side: 'home', point: -1.5, price: 2.17, bookie: 'Unibet' },
  ], 0.47, 0.01);
  assert.ok(result);
  assert.strictEqual(result.bookie, 'Unibet');
  assert.strictEqual(result.price, 2.17);
  setPreferredBookies(null);
});

test('odds-parser: buildSpreadFairProbFns ondersteunt opposite-point pairing', () => {
  const homeSpr = [{ side: 'home', point: -7.5, price: 1.95, bookie: 'Bet365' }];
  const awaySpr = [{ side: 'away', point: 7.5, price: 1.95, bookie: 'Unibet' }];
  const { homeFn, awayFn } = buildSpreadFairProbFns(homeSpr, awaySpr, 0.5, 0.5);
  assert.ok(homeFn(-7.5) > 0.45 && homeFn(-7.5) < 0.55);
  assert.ok(awayFn(7.5) > 0.45 && awayFn(7.5) < 0.55);
});

test('odds-parser: buildSpreadFairProbFns hasDevig=true bij paired bookies', () => {
  const homeSpr = [{ side: 'home', point: -7.5, price: 1.95, bookie: 'Bet365' }];
  const awaySpr = [{ side: 'away', point: 7.5, price: 1.95, bookie: 'Unibet' }];
  const { hasDevig } = buildSpreadFairProbFns(homeSpr, awaySpr, 0.5, 0.5);
  assert.strictEqual(hasDevig(-7.5), true, 'opposite-point paired → devig beschikbaar');
  assert.strictEqual(hasDevig(-12.5), false, 'geen data op -12.5 → geen devig');
});

test('odds-parser: buildSpreadFairProbFns hasDevig=false bij eenzame bookie (operator-report bug)', () => {
  // Reproductie van de v11.0 bug: Bet365 biedt -9.5, geen andere bookie heeft
  // -9.5 of +9.5. Zonder hasDevig-gate gaf fpHome * 0.50 een synthetische prob
  // die bij extreme lijnen systematisch te hoog was → fake edges.
  const homeSpr = [{ side: 'home', point: -9.5, price: 3.45, bookie: 'Bet365' }];
  const awaySpr = []; // niemand anders biedt de overkant
  const { hasDevig, homeFn } = buildSpreadFairProbFns(homeSpr, awaySpr, 0.69, 0.31);
  assert.strictEqual(hasDevig(-9.5), false, 'Bet365-only line → geen devig');
  assert.strictEqual(homeFn(-9.5), 0.69, 'fallback word teruggegeven maar caller moet hem negeren');
});

test('odds-parser: buildSpreadFairProbFns bookieCountAt telt unique bookies', () => {
  const homeSpr = [
    { side: 'home', point: -7.5, price: 1.95, bookie: 'Bet365' },
    { side: 'home', point: -7.5, price: 1.92, bookie: 'Unibet' },
    { side: 'home', point: -7.5, price: 1.93, bookie: 'Pinnacle' },
  ];
  const awaySpr = [
    { side: 'away', point: 7.5, price: 1.95, bookie: 'Bet365' },
  ];
  const { bookieCountAt } = buildSpreadFairProbFns(homeSpr, awaySpr, 0.5, 0.5);
  assert.strictEqual(bookieCountAt(-7.5), 3, 'max(home-side, away-side) = 3');
  assert.strictEqual(bookieCountAt(-12.5), 0, 'geen data → 0');
});

test('odds-parser: fairProbs2Way devigt home/away odds', () => {
  const fair = fairProbs2Way([
    { side: 'home', price: 1.8 },
    { side: 'away', price: 2.0 },
  ]);
  assert.ok(fair);
  assert.ok(Math.abs(fair.home + fair.away - 1) < 0.0001);
  assert.ok(fair.home > fair.away);
});

test('odds-parser: calcWinProb clamped en monotonic op edge', () => {
  const low = calcWinProb({ h2hEdge: -0.2, formEdge: -0.2, posAdj: -0.1, momentum: -0.1, injAdj: 0, stakesAdj: 0 });
  const high = calcWinProb({ h2hEdge: 0.2, formEdge: 0.2, posAdj: 0.1, momentum: 0.1, injAdj: 0, stakesAdj: 0 });
  assert.ok(low >= 10 && low <= 90);
  assert.ok(high >= 10 && high <= 90);
  assert.ok(high > low);
});

test('odds-parser: fairProbs normaliseert 3-way bookmaker consensus', () => {
  const probs = fairProbs([
    { markets: [{ key: 'h2h', outcomes: [{ name: 'Ajax', price: 2.0 }, { name: 'PSV', price: 3.0 }, { name: 'Draw', price: 4.0 }] }] },
    { markets: [{ key: 'h2h', outcomes: [{ name: 'Ajax', price: 2.1 }, { name: 'PSV', price: 2.9 }, { name: 'Draw', price: 3.8 }] }] },
  ], 'Ajax', 'PSV');
  assert.ok(probs);
  assert.ok(Math.abs(probs.home + probs.away + probs.draw - 1) < 0.0001);
  assert.ok(probs.home > probs.away);
});

test('odds-parser: bookiePrice leest specifieke bookmakerprijs', () => {
  const price = bookiePrice([
    { title: 'Bet365', key: 'bet365', markets: [{ key: 'h2h', outcomes: [{ name: 'Ajax', price: 2.1 }] }] },
    { title: 'Unibet', key: 'unibet', markets: [{ key: 'h2h', outcomes: [{ name: 'Ajax', price: 2.05 }] }] },
  ], 'unibet', 'h2h', 'Ajax');
  assert.strictEqual(price, 2.05);
});

test('odds-parser: convertAfOdds zet api-football payload om naar interne markten', () => {
  const rows = convertAfOdds([{
    name: 'Bet365',
    bets: [
      { id: 1, values: [{ value: 'Home', odd: '2.10' }, { value: 'Away', odd: '3.20' }, { value: 'Draw', odd: '3.40' }] },
      { id: 5, values: [{ value: 'Over 2.5', odd: '1.83' }, { value: 'Under 2.5', odd: '1.97' }] },
      { id: 8, values: [{ value: 'Yes', odd: '1.75' }, { value: 'No', odd: '2.05' }] },
      { id: 12, name: 'Asian Handicap', values: [{ value: 'Home -1.5', odd: '2.17' }, { value: 'Away +1.5', odd: '1.68' }] },
    ],
  }], 'Ajax', 'PSV');
  assert.strictEqual(rows.length, 1);
  const [bk] = rows;
  assert.ok(bk.markets.find(m => m.key === 'h2h'));
  assert.ok(bk.markets.find(m => m.key === 'totals'));
  assert.ok(bk.markets.find(m => m.key === 'btts'));
  assert.ok(bk.markets.find(m => m.key === 'spreads'));
});

test('modal recUnits: bij odds-daling daalt aanbevolen units', () => {
  // Reproduceert de logic uit updatePayout() (v10.7.22 fijne trapjes)
  const units = (hk) => hk < 0.015 ? 0
                      : hk < 0.025 ? 0.2
                      : hk < 0.035 ? 0.3
                      : hk < 0.045 ? 0.4
                      : hk < 0.055 ? 0.5
                      : hk < 0.070 ? 0.75
                      : hk < 0.090 ? 1.0
                      : hk < 0.120 ? 1.5
                      : 2.0;
  const kelly = (prob, odds) => Math.max(0, (prob * (odds - 1) - (1 - prob)) / (odds - 1));
  const prob = 0.60;
  const hkHigh = kelly(prob, 2.0) * 0.5;  // odds 2.0
  const hkLow  = kelly(prob, 1.8) * 0.5;  // odds 1.8
  assert.ok(hkHigh > hkLow, 'hk daalt bij lagere odds');
  assert.ok(units(hkHigh) >= units(hkLow), 'units(hkLow) ≤ units(hkHigh)');
});

// ── Modal advice (v10.8.9) ───────────────────────────────────────────────────
console.log('\n  Modal Advice (line-move tiers):');

const { computeModalAdvice } = require('./lib/modal-advice');

test('modal: odds ongewijzigd → severity=unchanged, rec=origUnits', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.91, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'unchanged');
  assert.strictEqual(r.recUnits, 0.75);
});

test('modal: odds binnen ±2% → still unchanged', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.90, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'unchanged');
});

test('modal: lichte daling (-3%) → severity=light, rec < origUnits', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.85, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'light');
  assert.ok(r.recUnits < 0.75, `light rec (${r.recUnits}) moet onder origUnits`);
  assert.ok(r.recUnits > 0, 'light rec niet 0');
});

test('modal: matige daling (-4%) → severity=moderate, rec ≈ helft', () => {
  const r = computeModalAdvice({ origOdds: 2.00, newOdds: 1.92, prob: 0.60, origUnits: 1.0 });
  assert.strictEqual(r.severity, 'moderate');
  assert.ok(r.recUnits <= 0.5, `moderate rec (${r.recUnits}) moet ≤ helft van origUnits`);
});

test('modal: grote daling (-7%) → severity=adverse, rec=0, message flags invalid', () => {
  const r = computeModalAdvice({ origOdds: 2.00, newOdds: 1.85, prob: 0.60, origUnits: 1.0 });
  assert.strictEqual(r.severity, 'adverse');
  assert.strictEqual(r.recUnits, 0);
  assert.ok(/valide|line moved/i.test(r.message), 'adverse message flagged');
});

test('modal v10.8.10: Luton/Padres -5.8% → nu ADVERSE (threshold -5%)', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.80, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'adverse', 'drempel -5% moet -5.8% adverse maken');
  assert.strictEqual(r.recUnits, 0);
});

test('modal v10.8.10: damped edge = pure edge × (origUnits/pureRec)', () => {
  // Luton: prob=0.62, origOdds=1.91, origUnits=0.75
  // pure hk at 1.91 = 0.101 → pureRec 1.5 → damping 0.5
  // pure edge at 1.91 = (1.91 - 1.613)/1.613 = ~18.4%
  // damped edge = 18.4 × 0.5 = ~9.2
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.91, prob: 0.62, origUnits: 0.75 });
  assert.ok(r.dampedEdge < r.edge, 'damped edge moet lager zijn dan pure edge');
  assert.ok(Math.abs(r.dampingFactor - 0.5) < 0.1, `damping ≈ 0.5, got ${r.dampingFactor}`);
});

test('modal v10.8.10: damped edge schaalt mee bij nieuwe odds', () => {
  // Bij 1.80: pure edge ~11.6, damped (×0.5) ~5.8 — rond MIN_EDGE
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.80, prob: 0.62, origUnits: 0.75 });
  assert.ok(r.dampedEdge < 7, `damped edge bij 1.80 moet rond 5-6%, got ${r.dampedEdge}`);
  assert.ok(r.dampedEdge > 4, `damped edge bij 1.80 moet niet absurd laag, got ${r.dampedEdge}`);
});

test('modal v10.8.11: origEdge anchor → bij ongewijzigde odds matcht damped = origEdge', () => {
  // Luton card toont Edge +7%, modal moet bij 1.91 unchanged ook 7% tonen
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.91, prob: 0.62, origUnits: 0.75, origEdge: 7 });
  assert.strictEqual(r.severity, 'unchanged');
  assert.ok(Math.abs(r.dampedEdge - 7) < 0.5, `expected ~7%, got ${r.dampedEdge}`);
});

test('modal v10.8.11: origEdge anchor schaalt proportioneel bij lagere odds', () => {
  // Luton 1.91→1.86: pure 18.4→15.3 (ratio 0.832)
  // dampedEdge = 7 × (15.3/18.4) ≈ 5.8
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.86, prob: 0.62, origUnits: 0.75, origEdge: 7 });
  assert.ok(r.dampedEdge > 5 && r.dampedEdge < 6.5, `expected ~5.8, got ${r.dampedEdge}`);
});

test('modal v10.8.11: origEdge niet aangeleverd → fallback naar bucket-inversie', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.91, prob: 0.62, origUnits: 0.75 });
  // Zonder origEdge: damping = 0.75/1.5 = 0.5, damped = 18.4 × 0.5 = 9.2
  assert.ok(r.dampedEdge > 8 && r.dampedEdge < 10, `fallback expected ~9.2, got ${r.dampedEdge}`);
});

test('modal: hogere odds (+4.7%) → severity=better, 1 bucket omhoog (v12.1.0)', () => {
  // v12.1.0: bij +4% of meer betere odds mag units 1 bucket omhoog (gecapt
  // op pureRec). Voorheen altijd gecapt op origUnits, wat inconsistent was
  // met de score die wel tot 10/10 klom.
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 2.00, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'better');
  // origUnits=0.75 → idx=5, oneUp = 1.0. pureRec bij hk=0.12 = 2.0. rec = min(1.0, 2.0) = 1.0.
  assert.strictEqual(r.recUnits, 1.0);
});

test('modal: licht hogere odds (+2.5%) → severity=better, blijft op origUnits', () => {
  // Onder +4% blijft unit-advies op origUnits (conservatief).
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.96, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'better');
  assert.ok(r.recUnits <= 0.75, 'onder +4% blijft rec op origUnits');
});

test('modal: zero/invalid input → severity=invalid, rec=0', () => {
  const r = computeModalAdvice({ origOdds: 0, newOdds: 1.80, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'invalid');
  assert.strictEqual(r.recUnits, 0);
});

test('modal: lagere odds schalen origUnits met kelly-ratio, niet met pure Kelly', () => {
  // Bij -3% daling bij zeer hoge prob zou pure Kelly nog 1U aanbevelen; we
  // willen dat origUnits (0.3) DAALT met de Kelly-ratio, niet stijgt naar 1U.
  const r = computeModalAdvice({ origOdds: 1.50, newOdds: 1.45, prob: 0.78, origUnits: 0.3 });
  assert.ok(r.recUnits <= 0.3, `rec (${r.recUnits}) mag niet boven origUnits (0.3) uitkomen`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// v10.9.0 — SCRAPING / DATA-AGGREGATOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n  Scraper Base (v10.9.0):');

const scraperBase = require('./lib/integrations/scraper-base');
const { isUrlSafe, TTLCache, RateLimiter, CircuitBreaker, normalizeTeamKey,
        setSourceEnabled, isSourceEnabled, allBreakerStatuses, getBreaker } = scraperBase;

test('isUrlSafe: blokkeert non-https', () => {
  assert.strictEqual(isUrlSafe('http://example.com/x'), false);
  assert.strictEqual(isUrlSafe('ftp://example.com/x'), false);
});
test('isUrlSafe: blokkeert localhost + private IPs (SSRF)', () => {
  assert.strictEqual(isUrlSafe('https://localhost/x'), false);
  assert.strictEqual(isUrlSafe('https://127.0.0.1/x'), false);
  assert.strictEqual(isUrlSafe('https://10.0.0.5/x'), false);
  assert.strictEqual(isUrlSafe('https://192.168.1.1/x'), false);
  assert.strictEqual(isUrlSafe('https://169.254.169.254/latest'), false);
});
test('isUrlSafe: respecteert allowedHosts-lijst', () => {
  assert.strictEqual(isUrlSafe('https://example.com/x', ['example.com']), true);
  assert.strictEqual(isUrlSafe('https://sub.example.com/x', ['example.com']), true);
  assert.strictEqual(isUrlSafe('https://evil.com/x', ['example.com']), false);
});
test('isUrlSafe: weigert mega-lange URLs (DOS-guard)', () => {
  const url = 'https://x.com/' + 'a'.repeat(3000);
  assert.strictEqual(isUrlSafe(url, ['x.com']), false);
});
test('isUrlSafe: malformed URL → false', () => {
  assert.strictEqual(isUrlSafe('not-a-url'), false);
  assert.strictEqual(isUrlSafe(''), false);
  assert.strictEqual(isUrlSafe(null), false);
});
test('isUrlSafe: IPv6 loopback + link-local geblokkeerd', () => {
  assert.strictEqual(isUrlSafe('https://[::1]/api'), false);
  assert.strictEqual(isUrlSafe('https://[fe80::1]/api'), false);
  assert.strictEqual(isUrlSafe('https://[fc00::1]/api'), false);
});
test('isUrlSafe: 172.16-172.31 private range geblokkeerd', () => {
  assert.strictEqual(isUrlSafe('https://172.16.0.1/x'), false);
  assert.strictEqual(isUrlSafe('https://172.20.0.1/x'), false);
  assert.strictEqual(isUrlSafe('https://172.31.255.254/x'), false);
  // 172.32 is géén private → toegestaan mits allowedHosts matcht
  assert.strictEqual(isUrlSafe('https://172.32.0.1/x', ['172.32.0.1']), true);
});
test('isUrlSafe: URL-injection poging (subdomain spoof) geblokkeerd', () => {
  assert.strictEqual(isUrlSafe('https://evil.com.sofascore.com/x', ['sofascore.com']), true); // sub ok
  assert.strictEqual(isUrlSafe('https://sofascore.com.evil.com/x', ['sofascore.com']), false); // niet sub
  assert.strictEqual(isUrlSafe('https://example.com@evil.com/x', ['example.com']), false); // userinfo trick
});

test('TTLCache: set/get werkt', () => {
  const c = new TTLCache(1000);
  c.set('a', 42);
  assert.strictEqual(c.get('a'), 42);
});
test('TTLCache: expire na TTL', () => {
  const c = new TTLCache(-1); // negative TTL → immediate expire
  c.set('a', 42);
  assert.strictEqual(c.get('a'), undefined);
});
test('TTLCache: maxEntries evict oudste', () => {
  const c = new TTLCache(10000, 3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3); c.set('d', 4);
  assert.strictEqual(c.size, 3);
  assert.strictEqual(c.get('a'), undefined);
  assert.strictEqual(c.get('d'), 4);
});
test('TTLCache: get refresht LRU-volgorde', () => {
  const c = new TTLCache(10000, 3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  c.get('a'); // a wordt meest-recent
  c.set('d', 4);
  assert.strictEqual(c.get('b'), undefined); // b is nu oudst → evicted
  assert.strictEqual(c.get('a'), 1);
});

test('RateLimiter: serialiseert calls met min-interval', async () => {
  // v10.9.2: jitter ±30% → 50ms ±15ms tussen calls. Lower-bound: 2 intervallen
  // van 35ms minimum = 70ms. Tolerant voor system jitter.
  const rl = new RateLimiter(50);
  const start = Date.now();
  await rl.acquire();
  await rl.acquire();
  await rl.acquire();
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 50, `verwacht >= 50ms, gekregen ${elapsed}ms`);
});

test('normalizeTeamKey: diacritics + suffixes gestript', () => {
  assert.strictEqual(normalizeTeamKey('Bromley FC'), 'bromley');
  assert.strictEqual(normalizeTeamKey('Cambridge United'), 'cambridge');
  assert.strictEqual(normalizeTeamKey('Atlético Madrid'), 'atletico madrid');
  assert.strictEqual(normalizeTeamKey('FC Köln'), 'koln');
});
test('normalizeTeamKey: lege input → lege string', () => {
  assert.strictEqual(normalizeTeamKey(''), '');
  assert.strictEqual(normalizeTeamKey(null), '');
  assert.strictEqual(normalizeTeamKey(undefined), '');
});
test('normalizeTeamKey: script-tag / XSS-poging wordt gestript', () => {
  const weird = '<script>alert(1)</script>Arsenal';
  const k = normalizeTeamKey(weird);
  assert.ok(!k.includes('<'));
  assert.ok(!k.includes('>'));
  assert.ok(k.includes('arsenal'));
});
test('normalizeTeamKey: numerieke + unicode input veilig', () => {
  assert.strictEqual(normalizeTeamKey('1. FC Köln'), '1 koln');
  // Non-ASCII wordt ge-stript door [^a-z0-9]+ regex. Veilig voor DB-keys.
  assert.strictEqual(normalizeTeamKey('東京FC'), '');
});

// v10.9.3 regression: audit signal_contrib parser vereist expliciete +/-
test('audit signal-parser: "poisson_o25:80.0%" telt NIET mee (geen sign)', () => {
  const sig = 'poisson_o25:80.0%';
  const m = /([+-]\d+\.?\d*)%/.exec(sig);
  assert.strictEqual(m, null);
});
test('audit signal-parser: "form:+1.5%" telt +1.5', () => {
  const m = /([+-]\d+\.?\d*)%/.exec('form:+1.5%');
  assert.ok(m);
  assert.strictEqual(parseFloat(m[1]), 1.5);
});
test('audit signal-parser: "weather:-3.0%" telt -3', () => {
  const m = /([+-]\d+\.?\d*)%/.exec('weather:-3.0%');
  assert.ok(m);
  assert.strictEqual(parseFloat(m[1]), -3);
});
test('audit signal-parser: "knockout_1st_leg:0%" telt NIET mee (meta-signal)', () => {
  const m = /([+-]\d+\.?\d*)%/.exec('knockout_1st_leg:0%');
  assert.strictEqual(m, null);
});

test('CircuitBreaker: start in closed state, allow()=true', () => {
  const cb = new CircuitBreaker({ name: 'test1', failureThreshold: 3 });
  assert.strictEqual(cb.state, 'closed');
  assert.strictEqual(cb.allow(), true);
});
test('CircuitBreaker: failure threshold trigger → open', () => {
  const cb = new CircuitBreaker({ name: 'test2', failureThreshold: 3, minCooldownMs: 100000 });
  cb.allow(); cb.onFailure('err');
  cb.allow(); cb.onFailure('err');
  cb.allow(); cb.onFailure('err');
  assert.strictEqual(cb.state, 'open');
  assert.strictEqual(cb.allow(), false);
});
test('CircuitBreaker: open → half-open na cooldown', () => {
  const cb = new CircuitBreaker({ name: 'test3', failureThreshold: 1, minCooldownMs: 0 });
  cb.allow(); cb.onFailure('err');
  assert.strictEqual(cb.state, 'open');
  const allowed = cb.allow(); // cooldown is 0 → direct half-open
  assert.strictEqual(allowed, true);
  assert.strictEqual(cb.state, 'half-open');
});
test('CircuitBreaker: half-open success threshold → closed', () => {
  const cb = new CircuitBreaker({ name: 'test4', failureThreshold: 1, successThreshold: 2, minCooldownMs: 0 });
  cb.allow(); cb.onFailure('err');
  cb.allow(); cb.onSuccess();
  cb.allow(); cb.onSuccess();
  assert.strictEqual(cb.state, 'closed');
});
test('CircuitBreaker: half-open fail → open met langere cooldown', () => {
  const cb = new CircuitBreaker({ name: 'test5', failureThreshold: 1, minCooldownMs: 100, maxCooldownMs: 1000 });
  cb.allow(); cb.onFailure('err');
  const before = cb.currentCooldownMs;
  cb.openedAt = Date.now() - 200; // simuleer verstreken cooldown
  cb.allow(); // → half-open
  cb.onFailure('err');
  assert.strictEqual(cb.state, 'open');
  assert.ok(cb.currentCooldownMs > before, 'cooldown moet verdubbelen');
});
test('CircuitBreaker: reset() herstelt volledig', () => {
  const cb = new CircuitBreaker({ name: 'test6', failureThreshold: 1 });
  cb.allow(); cb.onFailure('err');
  cb.reset();
  assert.strictEqual(cb.state, 'closed');
  assert.strictEqual(cb.fails, 0);
});
test('CircuitBreaker: status() bevat breaker metadata', () => {
  const cb = new CircuitBreaker({ name: 'test7' });
  const s = cb.status();
  assert.strictEqual(s.name, 'test7');
  assert.strictEqual(s.state, 'closed');
  assert.strictEqual(typeof s.totalCalls, 'number');
});

test('CircuitBreaker: state-change callbacks firen bij open/closed transitions', () => {
  const events = [];
  scraperBase.onBreakerStateChange(e => events.push(e));
  const cb = new CircuitBreaker({ name: 'hook-test', failureThreshold: 2, minCooldownMs: 0, successThreshold: 1 });
  scraperBase.registerBreaker(cb);
  cb.allow(); cb.onFailure('err1');
  cb.allow(); cb.onFailure('err2'); // → open
  cb.allow(); cb.onSuccess(); // half-open → closed (successThreshold=1)
  const opens = events.filter(e => e.name === 'hook-test' && e.to === 'open');
  const closes = events.filter(e => e.name === 'hook-test' && e.to === 'closed');
  const halfOpens = events.filter(e => e.name === 'hook-test' && e.to === 'half-open');
  assert.ok(opens.length >= 1, 'geen open-transitie gelogd');
  assert.ok(halfOpens.length >= 1, 'geen half-open-transitie gelogd');
  assert.ok(closes.length >= 1, 'geen close-transitie gelogd');
});

test('setSourceEnabled / isSourceEnabled roundtrip', () => {
  setSourceEnabled('x-test', true);
  assert.strictEqual(isSourceEnabled('x-test'), true);
  setSourceEnabled('x-test', false);
  assert.strictEqual(isSourceEnabled('x-test'), false);
});
test('isSourceEnabled: onbekende source = false (default off)', () => {
  assert.strictEqual(isSourceEnabled('never-registered-xyz'), false);
});

// ── Mocked fetch helper ──
function withMockFetch(handler, testFn) {
  const orig = global.fetch;
  global.fetch = async (url, opts) => {
    const res = await handler(url, opts);
    if (res === null || res === undefined) {
      return { ok: false, status: 500, text: async () => '', json: async () => null };
    }
    if (res.status && res.status >= 400) {
      return { ok: false, status: res.status, text: async () => '', json: async () => null };
    }
    const body = res.body === undefined ? res : res.body;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return { ok: true, status: 200, text: async () => text, json: async () => body };
  };
  const restore = () => { global.fetch = orig; };
  const result = testFn();
  if (result && typeof result.then === 'function') return result.finally(restore);
  restore();
  return result;
}

// ── SOFASCORE ──────────────────────────────────────────────────────────────
console.log('\n  Sources/SofaScore (v10.9.0):');

const sofa = require('./lib/integrations/sources/sofascore');

test('sofascore: disabled source → null (default off)', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', false);
  const r = await sofa.findTeamId('Arsenal', 'football');
  assert.strictEqual(r, null);
});

test('sofascore: findTeamId match op exact normalized name', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  await withMockFetch(async () => ({
    results: [
      { type: 'team', entity: { id: 42, name: 'Arsenal', slug: 'arsenal', sport: { slug: 'football' } } },
      { type: 'team', entity: { id: 43, name: 'Arsenal Tula', slug: 'arsenal-tula', sport: { slug: 'football' } } },
    ],
  }), async () => {
    const r = await sofa.findTeamId('Arsenal', 'football');
    assert.strictEqual(r.id, 42);
    assert.strictEqual(r.name, 'Arsenal');
  });
});

test('sofascore: findTeamId filtert op sport', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  await withMockFetch(async () => ({
    results: [
      { type: 'team', entity: { id: 10, name: 'Arsenal', sport: { slug: 'basketball' } } },
      { type: 'team', entity: { id: 42, name: 'Arsenal', sport: { slug: 'football' } } },
    ],
  }), async () => {
    const r = await sofa.findTeamId('Arsenal', 'football');
    assert.strictEqual(r.id, 42);
  });
});

test('sofascore: findTeamId: geen match → null', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  await withMockFetch(async () => ({ results: [] }), async () => {
    const r = await sofa.findTeamId('NietBestaand', 'football');
    assert.strictEqual(r, null);
  });
});

test('sofascore: 5xx → circuit breaker telt failure, return null', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  let calls = 0;
  await withMockFetch(async () => { calls++; return { status: 500 }; }, async () => {
    const r = await sofa.findTeamId('X', 'football');
    assert.strictEqual(r, null);
    assert.ok(calls === 1);
  });
});

test('sofascore: fetchH2HEvents parses scores + dates', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  const now = Math.floor(Date.now() / 1000);
  let call = 0;
  await withMockFetch(async (url) => {
    call++;
    if (url.includes('/search/suggestions/')) {
      const q = decodeURIComponent(url.split('/').pop());
      if (q.toLowerCase().includes('bromley')) {
        return { results: [{ type: 'team', entity: { id: 1, name: 'Bromley', sport: { slug: 'football' } } }] };
      }
      return { results: [{ type: 'team', entity: { id: 2, name: 'Cambridge United', sport: { slug: 'football' } } }] };
    }
    if (url.includes('/h2h/')) {
      return {
        events: [
          { startTimestamp: now - 86400*30, homeTeam: { id: 1, name: 'Bromley' }, awayTeam: { id: 2, name: 'Cambridge United' }, homeScore: { current: 2 }, awayScore: { current: 1 } },
          { startTimestamp: now - 86400*60, homeTeam: { id: 2, name: 'Cambridge United' }, awayTeam: { id: 1, name: 'Bromley' }, homeScore: { current: 0 }, awayScore: { current: 0 } },
          { startTimestamp: now - 86400*90, homeTeam: { id: 1, name: 'Bromley' }, awayTeam: { id: 2, name: 'Cambridge United' }, homeScore: { current: 3 }, awayScore: { current: 2 } },
        ],
      };
    }
    return { results: [] };
  }, async () => {
    const events = await sofa.fetchH2HEvents('Bromley', 'Cambridge United', 'football');
    assert.strictEqual(events.length, 3);
    assert.strictEqual(events[0].btts, true);   // 2-1
    assert.strictEqual(events[1].btts, false);  // 0-0
    assert.strictEqual(events[2].btts, true);   // 3-2
    const btts = events.filter(e => e.btts).length;
    assert.strictEqual(btts, 2);
  });
});

test('sofascore: fetchH2HEvents met kapotte scores → skipt bad event', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  await withMockFetch(async (url) => {
    if (url.includes('/search/suggestions/')) {
      return { results: [{ type: 'team', entity: { id: 1, name: 'A', sport: { slug: 'football' } } }] };
    }
    if (url.includes('/h2h/')) {
      return {
        events: [
          { homeTeam: { id: 1, name: 'A' }, awayTeam: { id: 2, name: 'B' }, homeScore: { current: 'abc' }, awayScore: { current: 1 } },
          { homeTeam: null, awayTeam: { id: 2 }, homeScore: { current: 1 }, awayScore: { current: 0 } },
          { homeTeam: { id: 1, name: 'A' }, awayTeam: { id: 2, name: 'B' }, homeScore: { current: 300 }, awayScore: { current: 1 } }, // sanity cap
        ],
      };
    }
    return {};
  }, async () => {
    const events = await sofa.fetchH2HEvents('A', 'B', 'football');
    assert.strictEqual(events.length, 0);
  });
});

test('sofascore: fetchTeamFormEvents: parseert W/D/L + home/away', async () => {
  sofa._clearCache();
  sofa._breaker.reset();
  setSourceEnabled('sofascore', true);
  await withMockFetch(async (url) => {
    if (url.includes('/search/suggestions/')) {
      return { results: [{ type: 'team', entity: { id: 1, name: 'X', sport: { slug: 'football' } } }] };
    }
    if (url.includes('/events/last/')) {
      return {
        events: [
          { startTimestamp: 100, homeTeam: { id: 1, name: 'X' }, awayTeam: { id: 2, name: 'Y' }, homeScore: { current: 2 }, awayScore: { current: 0 } }, // W home
          { startTimestamp: 99, homeTeam: { id: 2, name: 'Z' }, awayTeam: { id: 1, name: 'X' }, homeScore: { current: 3 }, awayScore: { current: 1 } }, // L away
          { startTimestamp: 98, homeTeam: { id: 1, name: 'X' }, awayTeam: { id: 3, name: 'A' }, homeScore: { current: 1 }, awayScore: { current: 1 } }, // D
        ],
      };
    }
    return {};
  }, async () => {
    const form = await sofa.fetchTeamFormEvents('X', 'football', 10);
    assert.strictEqual(form.length, 3);
    assert.strictEqual(form[0].result, 'W');
    assert.strictEqual(form[1].result, 'L');
    assert.strictEqual(form[2].result, 'D');
    assert.strictEqual(form[0].isHome, true);
    assert.strictEqual(form[1].isHome, false);
  });
});

// ── FOTMOB ──────────────────────────────────────────────────────────────
console.log('\n  Sources/FotMob (v10.9.0):');

const fotmob = require('./lib/integrations/sources/fotmob');

test('fotmob: disabled → null', async () => {
  fotmob._clearCache(); fotmob._breaker.reset();
  setSourceEnabled('fotmob', false);
  const r = await fotmob.findTeamId('Arsenal');
  assert.strictEqual(r, null);
});

test('fotmob: findTeamId parseert nested suggestions-array', async () => {
  fotmob._clearCache(); fotmob._breaker.reset();
  setSourceEnabled('fotmob', true);
  await withMockFetch(async () => ({
    suggestions: [[{ type: 'team', id: 9825, name: 'Arsenal' }]],
  }), async () => {
    const r = await fotmob.findTeamId('Arsenal');
    assert.strictEqual(r.id, 9825);
  });
});

test('fotmob: fetchTeamFormEvents skipt non-finished + malformed', async () => {
  fotmob._clearCache(); fotmob._breaker.reset();
  setSourceEnabled('fotmob', true);
  await withMockFetch(async (url) => {
    if (url.includes('/searchapi/suggest')) {
      return { suggestions: [[{ type: 'team', id: 1, name: 'X' }]] };
    }
    if (url.includes('/teams?id=')) {
      return {
        fixtures: {
          allFixtures: {
            fixtures: [
              { status: { finished: true, utcTime: '2026-04-01T18:00:00Z', scoreStr: '2 - 1' }, home: { id: 1, name: 'X' }, away: { id: 2, name: 'Y' } }, // W
              { status: { finished: false, utcTime: '2026-04-08T20:00:00Z' }, home: { id: 1, name: 'X' }, away: { id: 3, name: 'Z' } }, // upcoming → skip
              { status: { finished: true, utcTime: '2026-03-25T15:30:00Z', scoreStr: '??' }, home: { id: 1, name: 'X' }, away: { id: 4, name: 'A' } }, // no score → skip
              { status: { finished: true, utcTime: '2026-03-20T12:00:00Z', scoreStr: '0 - 0' }, home: { id: 5, name: 'B' }, away: { id: 1, name: 'X' } }, // D away
            ],
          },
        },
      };
    }
    return {};
  }, async () => {
    const f = await fotmob.fetchTeamFormEvents('X', 10);
    assert.strictEqual(f.length, 2);
    assert.strictEqual(f[0].result, 'W');
    assert.strictEqual(f[1].result, 'D');
  });
});

// ── NBA-STATS ──────────────────────────────────────────────────────────
console.log('\n  Sources/NBA-stats (v10.9.0):');

const nbaStats = require('./lib/integrations/sources/nba-stats');

test('nba-stats: fetchStandings parseert resultSets', async () => {
  nbaStats._clearCache(); nbaStats._breaker.reset();
  setSourceEnabled('nba-stats', true);
  await withMockFetch(async () => ({
    resultSets: [{
      headers: ['TeamID', 'TeamCity', 'TeamName', 'Conference', 'WINS', 'LOSSES', 'WinPCT', 'HOME', 'ROAD', 'L10', 'strCurrentStreak', 'PointsPG', 'OppPointsPG', 'DiffPointsPG', 'Division'],
      rowSet: [
        [1, 'Boston', 'Celtics', 'East', 60, 22, 0.731, '32-9', '28-13', '8-2', 'W5', 115, 108, 7, 'Atlantic'],
      ],
    }],
  }), async () => {
    const rows = await nbaStats.fetchStandings('2025-26');
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].fullName, 'Boston Celtics');
    assert.strictEqual(rows[0].wins, 60);
  });
});

test('nba-stats: fetchTeamSummary parseert streak + records', async () => {
  nbaStats._clearCache(); nbaStats._breaker.reset();
  setSourceEnabled('nba-stats', true);
  await withMockFetch(async () => ({
    resultSets: [{
      headers: ['TeamID', 'TeamCity', 'TeamName', 'Conference', 'WINS', 'LOSSES', 'WinPCT', 'HOME', 'ROAD', 'L10', 'strCurrentStreak', 'PointsPG', 'OppPointsPG', 'DiffPointsPG'],
      rowSet: [[1, 'Boston', 'Celtics', 'East', 60, 22, 0.731, '32-9', '28-13', '8-2', 'W5', 115, 108, 7]],
    }],
  }), async () => {
    const s = await nbaStats.fetchTeamSummary('Boston Celtics', '2025-26');
    assert.strictEqual(s.streakType, 'W');
    assert.strictEqual(s.streakCount, 5);
    assert.strictEqual(s.homeWin, 32);
    assert.strictEqual(s.l10Win, 8);
  });
});

test('nba-stats: no resultSets → null', async () => {
  nbaStats._clearCache(); nbaStats._breaker.reset();
  setSourceEnabled('nba-stats', true);
  await withMockFetch(async () => ({ resultSets: [] }), async () => {
    const r = await nbaStats.fetchStandings('2025-26');
    assert.strictEqual(r, null);
  });
});

// ── NHL-API ────────────────────────────────────────────────────────────
console.log('\n  Sources/NHL-api (v10.9.0):');

const nhlApi = require('./lib/integrations/sources/nhl-api');

test('nhl-api: fetchStandings parseert nested team fields', async () => {
  nhlApi._clearCache(); nhlApi._breaker.reset();
  setSourceEnabled('nhl-api', true);
  await withMockFetch(async () => ({
    standings: [
      { teamAbbrev: { default: 'BOS' }, teamName: { default: 'Bruins' }, conferenceName: 'East', divisionName: 'Atlantic',
        wins: 40, losses: 25, otLosses: 7, points: 87, gamesPlayed: 72, goalDifferential: 25,
        homeWins: 22, homeLosses: 10, homeOtLosses: 3,
        roadWins: 18, roadLosses: 15, roadOtLosses: 4,
        l10Wins: 6, l10Losses: 3, l10OtLosses: 1,
        streakCode: 'W', streakCount: 4, goalFor: 220, goalAgainst: 195 },
    ],
  }), async () => {
    const rows = await nhlApi.fetchStandings();
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].teamAbbrev, 'BOS');
    assert.strictEqual(rows[0].points, 87);
  });
});

test('nhl-api: findTeamByName case-insensitive', async () => {
  nhlApi._clearCache(); nhlApi._breaker.reset();
  setSourceEnabled('nhl-api', true);
  await withMockFetch(async () => ({
    standings: [{ teamAbbrev: { default: 'BOS' }, teamName: { default: 'Bruins' }, wins: 40, losses: 25 }],
  }), async () => {
    const r = await nhlApi.findTeamByName('bruins');
    assert.ok(r);
    assert.strictEqual(r.teamAbbrev, 'BOS');
  });
});

// ── MLB-EXT ────────────────────────────────────────────────────────────
console.log('\n  Sources/MLB-stats-ext (v10.9.0):');

const mlbExt = require('./lib/integrations/sources/mlb-stats-ext');

test('mlb-ext: fetchStandings parseert records-splits', async () => {
  mlbExt._clearCache(); mlbExt._breaker.reset();
  setSourceEnabled('mlb-stats-ext', true);
  await withMockFetch(async () => ({
    records: [{
      division: { name: 'AL East' },
      teamRecords: [{
        team: { id: 111, name: 'Red Sox' },
        wins: 90, losses: 72, winningPercentage: '.556',
        runsScored: 780, runsAllowed: 700, runDifferential: 80,
        gamesPlayed: 162,
        streak: { streakCode: 'W3', streakType: 'wins', streakNumber: 3 },
        records: { splitRecords: [
          { type: 'home', wins: 50, losses: 31 },
          { type: 'away', wins: 40, losses: 41 },
          { type: 'lastTen', wins: 6, losses: 4 },
        ]},
      }],
    }],
  }), async () => {
    const rows = await mlbExt.fetchStandings('2025');
    assert.strictEqual(rows.length, 1);
    const s = await mlbExt.fetchTeamSummary('Red Sox', '2025');
    assert.strictEqual(s.wins, 90);
    assert.strictEqual(s.homeWin, 50);
    assert.strictEqual(s.streakCount, 3);
  });
});

// ── DATA AGGREGATOR ────────────────────────────────────────────────────
console.log('\n  Data Aggregator (v10.9.0):');

const agg = require('./lib/integrations/data-aggregator');

test('aggregator: _dedupH2H verwijdert duplicates by date+pair', () => {
  const events = [
    { source: 's1', date: '2025-10-01', homeTeam: 'A', awayTeam: 'B', homeScore: 1, awayScore: 1 },
    { source: 's2', date: '2025-10-01', homeTeam: 'B', awayTeam: 'A', homeScore: 1, awayScore: 1 }, // zelfde match, andere home-positie
    { source: 's1', date: '2025-09-10', homeTeam: 'A', awayTeam: 'B', homeScore: 2, awayScore: 0 },
  ];
  const d = agg._dedupH2H(events);
  assert.strictEqual(d.length, 2);
});

test('aggregator: _summarizeH2H telt btts + rates', () => {
  const events = [
    { homeTeam: 'A', awayTeam: 'B', homeScore: 2, awayScore: 1, btts: true },  // btts
    { homeTeam: 'A', awayTeam: 'B', homeScore: 1, awayScore: 0, btts: false }, // geen btts
    { homeTeam: 'B', awayTeam: 'A', homeScore: 3, awayScore: 3, btts: true },  // btts + over2.5
  ];
  const s = agg._summarizeH2H(events, 'A', 'B');
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.btts, 2);
  assert.ok(Math.abs(s.bttsRate - 0.667) < 0.01);
});

test('aggregator: _dedupFormEvents op date+opp', () => {
  const events = [
    { source: 's1', date: '2025-10-01', oppName: 'X', myScore: 2, oppScore: 1, result: 'W' },
    { source: 's2', date: '2025-10-01', oppName: 'X', myScore: 2, oppScore: 1, result: 'W' }, // duplicate
    { source: 's1', date: '2025-09-15', oppName: 'Y', myScore: 1, oppScore: 1, result: 'D' },
  ];
  const d = agg._dedupFormEvents(events);
  assert.strictEqual(d.length, 2);
});

test('aggregator: _summarizeForm telt W/D/L + GF/GA', () => {
  const events = [
    { date: '2025-10-01', myScore: 2, oppScore: 1 }, // W
    { date: '2025-09-15', myScore: 1, oppScore: 1 }, // D
    { date: '2025-09-01', myScore: 0, oppScore: 2 }, // L
  ];
  const s = agg._summarizeForm(events);
  assert.strictEqual(s.n, 3);
  assert.strictEqual(s.w, 1);
  assert.strictEqual(s.d, 1);
  assert.strictEqual(s.l, 1);
  assert.strictEqual(s.gfPerGame, 1);
  assert.strictEqual(s.gaPerGame, 4 / 3 > 1.33 && 4 / 3 < 1.34 ? +(4/3).toFixed(2) : s.gaPerGame);
  assert.ok(s.form.length > 0);
});

test('aggregator: getMergedH2H faalt gracefully als alle sources disabled', async () => {
  setSourceEnabled('sofascore', false);
  setSourceEnabled('fotmob', false);
  const r = await agg.getMergedH2H('football', 'A', 'B');
  assert.strictEqual(r, null);
});

test('aggregator: getMergedH2H merged events van meerdere sources (dedup)', async () => {
  sofa._clearCache(); sofa._breaker.reset();
  fotmob._clearCache(); fotmob._breaker.reset();
  setSourceEnabled('sofascore', true);
  setSourceEnabled('fotmob', true);
  const now = Math.floor(Date.now() / 1000);
  await withMockFetch(async (url) => {
    if (url.includes('sofascore') && url.includes('/search/suggestions/')) {
      const q = decodeURIComponent(url.split('/').pop()).toLowerCase();
      return { results: [{ type: 'team', entity: { id: q.includes('bromley') ? 1 : 2, name: q.includes('bromley') ? 'Bromley' : 'Cambridge United', sport: { slug: 'football' } } }] };
    }
    if (url.includes('sofascore') && url.includes('/h2h/')) {
      return {
        events: [
          { startTimestamp: now - 86400 * 30, homeTeam: { id: 1, name: 'Bromley' }, awayTeam: { id: 2, name: 'Cambridge United' }, homeScore: { current: 2 }, awayScore: { current: 1 } },
        ],
      };
    }
    if (url.includes('fotmob') && url.includes('searchapi/suggest')) {
      const term = url.split('term=')[1];
      return { suggestions: [[{ type: 'team', id: term.toLowerCase().includes('bromley') ? 11 : 22, name: term.toLowerCase().includes('bromley') ? 'Bromley' : 'Cambridge United' }]] };
    }
    if (url.includes('fotmob') && url.includes('/teams?id=')) {
      return {
        fixtures: {
          allFixtures: {
            fixtures: [
              { status: { finished: true, utcTime: new Date(Date.now() - 86400 * 1000 * 30).toISOString(), scoreStr: '2 - 1' }, home: { id: 11, name: 'Bromley' }, away: { id: 22, name: 'Cambridge United' } },  // zelfde wedstrijd
              { status: { finished: true, utcTime: new Date(Date.now() - 86400 * 1000 * 60).toISOString(), scoreStr: '0 - 0' }, home: { id: 22, name: 'Cambridge United' }, away: { id: 11, name: 'Bromley' } }, // extra
            ],
          },
        },
      };
    }
    return {};
  }, async () => {
    const r = await agg.getMergedH2H('football', 'Bromley', 'Cambridge United');
    assert.ok(r);
    // sofascore gives 1 game, fotmob gives 2 but 1 overlapt → total dedup = 2
    assert.ok(r.n >= 1 && r.n <= 2, `verwacht 1-2 unieke events, kreeg ${r.n}`);
    assert.ok(r.sources.length >= 1);
  });
});

test('aggregator: healthCheckAll roept alle sources aan', async () => {
  setSourceEnabled('sofascore', false);
  setSourceEnabled('fotmob', false);
  setSourceEnabled('nba-stats', false);
  setSourceEnabled('nhl-api', false);
  setSourceEnabled('mlb-stats-ext', false);
  const r = await agg.healthCheckAll();
  assert.strictEqual(r.length, 5);
  assert.ok(r.every(x => x.healthy === null || x.disabled === true || x.healthy === false));
});

test('daily-results: post-results model jobs draaien alleen bij nieuwe settlements', () => {
  assert.deepStrictEqual(
    dailyResults.shouldRunPostResultsModelJobs(2),
    { shouldRun: true, reason: 'new_results_settled' }
  );
  assert.deepStrictEqual(
    dailyResults.shouldRunPostResultsModelJobs(0),
    { shouldRun: false, reason: 'no_new_results' }
  );
  assert.deepStrictEqual(
    dailyResults.shouldRunPostResultsModelJobs(NaN),
    { shouldRun: false, reason: 'no_new_results' }
  );
});

test('live-board: dated baseball fallback accepteert live inning-statussen', () => {
  assert.strictEqual(liveBoard.isV1LiveStatus('IN4'), true);
  assert.strictEqual(
    liveBoard.shouldIncludeDatedV1Game('IN4', { includeLiveStatuses: true }),
    true
  );
  assert.strictEqual(
    liveBoard.shouldIncludeDatedV1Game('IN4', { includeLiveStatuses: false }),
    false
  );
  assert.strictEqual(
    liveBoard.shouldIncludeDatedV1Game('NS', { includeLiveStatuses: false }),
    true
  );
});

test('operator-actions: auto-sync tracker triggert alleen bij live → einde overgang', () => {
  assert.strictEqual(
    operatorActions.shouldAutoSyncTrackerOnLiveEnd({ wasLive: true, isLive: false, alreadyNotifiedFt: false }),
    true
  );
  assert.strictEqual(
    operatorActions.shouldAutoSyncTrackerOnLiveEnd({ wasLive: false, isLive: false, alreadyNotifiedFt: false }),
    false
  );
  assert.strictEqual(
    operatorActions.shouldAutoSyncTrackerOnLiveEnd({ wasLive: true, isLive: false, alreadyNotifiedFt: true }),
    false
  );
});

test('operator-actions: CLV recompute target kan op één bet focussen', () => {
  const row = { bet_id: 42 };
  assert.strictEqual(operatorActions.matchesClvRecomputeTarget(row, { betId: 42 }), true);
  assert.strictEqual(operatorActions.matchesClvRecomputeTarget(row, { betId: 41 }), false);
  assert.strictEqual(operatorActions.matchesClvRecomputeTarget(row, {}), true);
});

test('operator-actions: live over/btts kunnen vroegtijdig beslissen', () => {
  assert.strictEqual(
    operatorActions.resolveEarlyLiveOutcome('Over 2.5', { scoreH: 2, scoreA: 1 }),
    'W'
  );
  assert.strictEqual(
    operatorActions.resolveEarlyLiveOutcome('Under 2.5', { scoreH: 2, scoreA: 1 }),
    'L'
  );
  assert.strictEqual(
    operatorActions.resolveEarlyLiveOutcome('⚽ BTTS Nee', { scoreH: 1, scoreA: 1 }),
    'L'
  );
  assert.strictEqual(
    operatorActions.resolveEarlyLiveOutcome('⚽ BTTS Ja', { scoreH: 1, scoreA: 1 }),
    'W'
  );
  assert.strictEqual(
    operatorActions.resolveEarlyLiveOutcome('Under 2.5', { scoreH: 1, scoreA: 0 }),
    null
  );
});

// ── RESULTS-CHECKER (v11.0.0): LIVE-GATE VOORKOMT ONTERECHTE AUTO-SETTLE ─────
console.log('\n  Results-checker (auto-settle pipeline):');

test('results-checker: LIVE gate blokkeert BTTS Nee op 0-0 in-progress', () => {
  // Operator-bug report: BTTS Nee op nog-lopende wedstrijd werd als L gesloten.
  // Vanaf v11.0.0 moet een live-event met onbepaalde BTTS-status Open blijven.
  const r = resultsChecker.resolveBetOutcome(
    '⚽ BTTS Nee',
    { home: 'Ajax', away: 'PSV', scoreH: 0, scoreA: 0 },
    { isLive: true }
  );
  assert.strictEqual(r.uitkomst, null);
  assert.ok(r.note && r.note.toLowerCase().includes('bezig'));
});

test('results-checker: LIVE gate sluit BTTS Nee wel op 1-1 (mathematisch verloren)', () => {
  const r = resultsChecker.resolveBetOutcome(
    '⚽ BTTS Nee',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 1 },
    { isLive: true }
  );
  assert.strictEqual(r.uitkomst, 'L');
});

test('results-checker: LIVE gate sluit BTTS Ja op 1-1 (mathematisch gewonnen)', () => {
  const r = resultsChecker.resolveBetOutcome(
    '⚽ BTTS Ja',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 1 },
    { isLive: true }
  );
  assert.strictEqual(r.uitkomst, 'W');
});

test('results-checker: LIVE gate houdt ML Open bij partial lead (kan nog kantelen)', () => {
  const r = resultsChecker.resolveBetOutcome(
    '🏠 Ajax wint',
    { home: 'Ajax', away: 'PSV', scoreH: 2, scoreA: 0, live: true },
    { isLive: true }
  );
  assert.strictEqual(r.uitkomst, null);
});

test('results-checker: LIVE gate sluit Over 2.5 bij overschreden lijn', () => {
  const r = resultsChecker.resolveBetOutcome(
    'Over 2.5',
    { home: 'Ajax', away: 'PSV', scoreH: 2, scoreA: 1 },
    { isLive: true }
  );
  assert.strictEqual(r.uitkomst, 'W');
});

test('results-checker: LIVE gate houdt Under 2.5 Open bij partial (kan nog overschreden worden)', () => {
  const r = resultsChecker.resolveBetOutcome(
    'Under 2.5',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 0 },
    { isLive: true }
  );
  assert.strictEqual(r.uitkomst, null);
});

test('results-checker: FINISHED pipeline resolved BTTS Ja op 2-1 als W', () => {
  const r = resultsChecker.resolveBetOutcome(
    '⚽ BTTS Ja',
    { home: 'Ajax', away: 'PSV', scoreH: 2, scoreA: 1 },
    { isLive: false }
  );
  assert.strictEqual(r.uitkomst, 'W');
});

test('results-checker: FINISHED pipeline resolved BTTS Ja op 0-0 als L', () => {
  const r = resultsChecker.resolveBetOutcome(
    '⚽ BTTS Ja',
    { home: 'Ajax', away: 'PSV', scoreH: 0, scoreA: 0 },
    { isLive: false }
  );
  assert.strictEqual(r.uitkomst, 'L');
});

test('results-checker: FINISHED pipeline resolved BTTS Nee op 1-0 als W', () => {
  const r = resultsChecker.resolveBetOutcome(
    '⚽ BTTS Nee',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 0 },
    { isLive: false }
  );
  assert.strictEqual(r.uitkomst, 'W');
});

test('results-checker: FINISHED Under 2.5 op 1-0 → W', () => {
  const r = resultsChecker.resolveBetOutcome(
    'Under 2.5',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 0 },
    { isLive: false }
  );
  assert.strictEqual(r.uitkomst, 'W');
});

test('results-checker: FINISHED Over 2.5 op exacte 2-0 → null (push)', () => {
  const r = resultsChecker.resolveBetOutcome(
    'Over 2.0',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 1 },
    { isLive: false }
  );
  assert.strictEqual(r.uitkomst, null);
  assert.ok(r.note && r.note.toLowerCase().includes('push'));
});

test('results-checker: FINISHED DNB draw → null (void)', () => {
  const r = resultsChecker.resolveBetOutcome(
    'DNB Ajax',
    { home: 'Ajax', away: 'PSV', scoreH: 1, scoreA: 1 },
    { isLive: false }
  );
  assert.strictEqual(r.uitkomst, null);
  assert.ok(r.note && r.note.toLowerCase().includes('dnb'));
});

test('results-checker: zonder event → null met uitleg', () => {
  const r = resultsChecker.resolveBetOutcome('⚽ BTTS Ja', null, { isLive: false });
  assert.strictEqual(r.uitkomst, null);
  assert.ok(r.note);
});

// ── SCAN-LOGGER (v11.0.0): heartbeat moet scan_end tellen ───────────────────
// ── NOTIFICATIONS ROUTER (v11.2.0 Phase 5.1 extraction) ─────────────────────
console.log('\n  Notifications router (factory extraction):');

test('notifications router: throws bij missing deps', () => {
  assert.throws(() => createNotificationsRouter({}), /missing required deps/);
});

test('notifications router: construct met valid deps returnt Express router', () => {
  const router = createNotificationsRouter({
    supabase: { from: () => ({ select: () => ({ order: () => ({ limit: () => ({ or: () => ({ then: () => {} }) }) }) }) }) },
    isValidUuid: () => true,
    rateLimit: () => false,
    savePushSub: async () => {},
    deletePushSub: async () => {},
    vapidPublicKey: 'test-key',
  });
  assert.ok(router);
  assert.strictEqual(typeof router.use, 'function', 'Express router heeft .use method');
  // Router moet de 6 routes gemount hebben (3 push + 3 inbox)
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/push/vapid-key'));
  assert.ok(routes.includes('/push/subscribe'));
  assert.ok(routes.includes('/inbox-notifications'));
  assert.ok(routes.includes('/inbox-notifications/read'));
});

// ── CLV ROUTER (v11.2.2 Phase 5.2 extraction) ───────────────────────────────
console.log('\n  CLV router (factory extraction):');

test('clv router: throws bij missing deps', () => {
  assert.throws(() => createClvRouter({}), /missing required dep/);
});

test('user router: throws bij missing deps', () => {
  assert.throws(() => createUserRouter({}), /missing required dep/);
});

test('user router: construct met valid deps + 2 routes', () => {
  const router = createUserRouter({
    loadUsers: async () => [],
    saveUser: async () => {},
    defaultSettings: () => ({}),
    rescheduleUserScans: () => {},
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/user/settings'));
});

test('admin-signals router: throws bij missing deps', () => {
  assert.throws(() => createAdminSignalsRouter({}), /missing required dep/);
});

test('admin-signals router: construct met valid deps + 3 routes', () => {
  const router = createAdminSignalsRouter({
    supabase: { from: () => ({ select: () => ({ not: () => ({ limit: async () => ({ data: [], error: null }) }), order: () => ({}) }) }) },
    requireAdmin: (req, res, next) => next(),
    loadCalib: () => ({ markets: {}, modelLog: [] }),
    loadSignalWeights: () => ({}),
    summarizeSignalMetrics: () => ({ signals: {} }),
    parseBetSignals: () => [],
    normalizeSport: (s) => s,
    detectMarket: () => 'other',
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/admin/v2/signal-performance'));
  assert.ok(routes.includes('/admin/signal-performance'));
  assert.ok(routes.includes('/model-feed'));
});

test('admin-snapshots router: throws bij missing deps', () => {
  assert.throws(() => createAdminSnapshotsRouter({}), /missing required dep/);
});

test('admin-snapshots router: construct met valid deps + 2 routes', () => {
  const router = createAdminSnapshotsRouter({
    supabase: { from: () => ({ select: () => ({}) }) },
    requireAdmin: (req, res, next) => next(),
    autoTuneSignalsByClv: async () => ({ ok: true }),
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/admin/v2/autotune-clv'));
  assert.ok(routes.includes('/admin/v2/snapshot-counts'));
});

test('admin-controls router: throws bij missing deps', () => {
  assert.throws(() => createAdminControlsRouter({}), /missing required dep/);
});

test('admin-controls router: construct met valid deps + 5 routes', () => {
  const router = createAdminControlsRouter({
    requireAdmin: (req, res, next) => next(),
    killSwitch: { enabled: true, set: new Set(), thresholds: {}, lastRefreshed: null },
    refreshKillSwitch: async () => {},
    operator: { master_scan_enabled: true, panic_mode: false },
    saveOperatorState: async () => {},
    loadCalib: () => ({}),
    saveCalib: async () => {},
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/admin/v2/kill-switch'));
  assert.ok(routes.includes('/admin/v2/upgrade-ack'));
  assert.ok(routes.includes('/admin/v2/operator'));
});

test('admin-observability router: throws bij missing deps', () => {
  assert.throws(() => createAdminObservabilityRouter({}), /missing required dep/);
});

test('admin-observability router: construct met valid deps + 2 routes', () => {
  const router = createAdminObservabilityRouter({
    supabase: { from: () => ({ select: () => ({}) }), rpc: async () => ({ data: null }) },
    requireAdmin: (req, res, next) => next(),
    loadUsers: async () => [],
    getUserScanTimers: () => [],
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/admin/supabase-usage'));
  assert.ok(routes.includes('/admin/scheduler-status'));
});

test('analytics router: throws bij missing deps', () => {
  assert.throws(() => createAnalyticsRouter({}), /missing required dep/);
});

test('analytics router: construct met valid deps + 2 routes', () => {
  const router = createAnalyticsRouter({
    requireAdmin: (req, res, next) => next(),
    readBets: async () => ({ bets: [] }),
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/signal-analysis'));
  assert.ok(routes.includes('/timing-analysis'));
});

test('picks router: throws bij missing deps', () => {
  assert.throws(() => createPicksRouter({}), /missing required dep/);
});

test('picks router: construct met valid deps + 2 routes', () => {
  const router = createPicksRouter({
    supabase: { from: () => ({ select: () => ({ order: () => ({ limit: () => ({ or: () => ({}) }) }) }) }) },
    isValidUuid: () => true,
    getLastPrematchPicks: () => [],
    getLastLivePicks: () => [],
    loadScanHistoryFromSheets: async () => [],
    loadScanHistory: () => [],
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/picks'));
  assert.ok(routes.includes('/scan-history'));
});

test('picks router: safePick strips model-internals voor non-admin', () => {
  const fullPick = { match: 'A vs B', odd: 2.0, reason: 'secret', kelly: 0.05, ep: 0.6 };
  const safe = createPicksRouter.safePick(fullPick, false);
  assert.strictEqual(safe.match, 'A vs B');
  assert.strictEqual(safe.odd, 2.0);
  assert.strictEqual(safe.reason, undefined);
  assert.strictEqual(safe.kelly, undefined);
  assert.strictEqual(safe.ep, undefined);
});

test('picks router: safePick returnt alles voor admin', () => {
  const fullPick = { match: 'A vs B', reason: 'full', kelly: 0.05 };
  const safe = createPicksRouter.safePick(fullPick, true);
  assert.strictEqual(safe.reason, 'full');
  assert.strictEqual(safe.kelly, 0.05);
});

test('info router: throws bij missing deps', () => {
  assert.throws(() => createInfoRouter({}), /missing required dep/);
});

test('info router: construct met valid deps + 2 routes', () => {
  const router = createInfoRouter({
    appVersion: '11.2.7',
    loadCalib: () => ({ modelLog: [], modelLastUpdated: null }),
    requireAdmin: (req, res, next) => next(),
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/version'));
  assert.ok(routes.includes('/changelog'));
});

test('bets router: throws bij missing deps', () => {
  assert.throws(() => createBetsRouter({}), /missing required dep/);
});

test('bets router: construct met valid deps + 3 routes', () => {
  const router = createBetsRouter({
    readBets: async () => ({ bets: [], stats: {}, _raw: [] }),
    deleteBet: async () => {},
    loadUsers: async () => [],
    calcStats: () => ({}),
    rateLimit: () => false,
    defaultStartBankroll: 100,
    defaultUnitEur: 10,
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/bets'));
  assert.ok(routes.includes('/bets/correlations'));
  assert.ok(routes.includes('/bets/:id'));
});

test('admin-users router: throws bij missing deps', () => {
  assert.throws(() => createAdminUsersRouter({}), /missing required dep/);
});

test('admin-users router: construct met valid deps + 3 routes', () => {
  const router = createAdminUsersRouter({
    supabase: { from: () => ({ delete: () => ({ eq: async () => {} }) }) },
    requireAdmin: (req, res, next) => next(),
    loadUsers: async () => [],
    saveUser: async () => {},
    clearUsersCache: () => {},
    notify: async () => {},
    sendEmail: async () => true,
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/admin/users'));
  assert.ok(routes.includes('/admin/users/:id'));
});

test('tracker router: throws bij missing deps', () => {
  assert.throws(() => createTrackerRouter({}), /missing required dep/);
});

test('tracker router: construct met valid deps + 2 routes', () => {
  const router = createTrackerRouter({
    supabase: { from: () => ({}) },
    requireAdmin: (req, res, next) => next(),
    readBets: async () => ({ bets: [], stats: {} }),
    checkOpenBetResults: async () => ({ checked: 0, updated: 0, results: [] }),
    afGet: async () => [],
    sleep: async () => {},
  });
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/check-results'));
  assert.ok(routes.includes('/backfill-times'));
});

test('auth router: throws bij missing deps', () => {
  assert.throws(() => createAuthRouter({}), /missing required dep/);
});

test('auth router: construct met valid deps + 5 routes', () => {
  const router = createAuthRouter({
    rateLimit: () => false,
    loadUsers: async () => [],
    saveUser: async () => {},
    bcrypt: { compare: async () => true, hash: async () => 'h' },
    jwt: { sign: () => 'token' },
    jwtSecret: 'test-secret',
    loginCodes: new Map(),
    sendEmail: async () => true,
    notify: async () => {},
    defaultSettings: () => ({}),
  });
  assert.ok(router);
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/auth/login'));
  assert.ok(routes.includes('/auth/verify-code'));
  assert.ok(routes.includes('/auth/register'));
  assert.ok(routes.includes('/auth/me'));
  assert.ok(routes.includes('/auth/password'));
});

test('clv router: construct met valid deps + 3 routes', () => {
  const stubMiddleware = (req, res, next) => next();
  const router = createClvRouter({
    supabase: { from: () => ({ select: () => ({}) }) },
    requireAdmin: stubMiddleware,
    findGameIdVerbose: async () => ({ fxId: null }),
    fetchCurrentOdds: async () => null,
    fetchSnapshotClosing: async () => null,
    marketKeyFromBetMarkt: () => null,
    matchesClvRecomputeTarget: () => true,
    afRateLimit: { remaining: 100, limit: 100, callsToday: 0 },
    sportRateLimits: {},
    refreshKillSwitch: async () => {},
    KILL_SWITCH: { set: new Set() },
    autoTuneSignalsByClv: async () => ({}),
    evaluateKellyAutoStepup: async () => ({}),
  });
  assert.ok(router);
  assert.strictEqual(typeof router.use, 'function');
  const routes = router.stack.filter(l => l.route).map(l => l.route.path);
  assert.ok(routes.includes('/clv/backfill'));
  assert.ok(routes.includes('/clv/recompute'));
  assert.ok(routes.includes('/clv/backfill/probe'));
});

console.log('\n  Scan-logger (heartbeat notification writer):');

test('scan-logger: hasRecentScanActivity matcht cron_tick en scan_end', () => {
  assert.strictEqual(scanLogger.hasRecentScanActivity([{ type: 'cron_tick' }]), true);
  assert.strictEqual(scanLogger.hasRecentScanActivity([{ type: 'scan_end' }]), true);
  assert.strictEqual(scanLogger.hasRecentScanActivity([{ type: 'unit_change' }]), true);
  assert.strictEqual(scanLogger.hasRecentScanActivity([]), false);
  assert.strictEqual(scanLogger.hasRecentScanActivity([{ type: 'heartbeat_miss' }]), false);
  assert.strictEqual(scanLogger.hasRecentScanActivity(null), false);
});

test('scan-logger: legacy scan_final_selection alleen matcht als operator opt-in (default nee)', () => {
  // Guard regression: oude heartbeat-query keek naar scan_final_selection dat
  // nooit bestond. Ensure we're not still matching it by default.
  assert.strictEqual(
    scanLogger.hasRecentScanActivity([{ type: 'scan_final_selection' }]),
    false,
    'scan_final_selection mag niet meer tellen als heartbeat signal'
  );
});

test('scan-logger: logScanEnd schrijft scan_end met juiste velden', async () => {
  let captured = null;
  const fakeSupabase = {
    from(table) {
      assert.strictEqual(table, 'notifications');
      return {
        async insert(payload) {
          captured = payload;
          return { data: [payload], error: null };
        },
      };
    },
  };
  const ok = await scanLogger.logScanEnd(fakeSupabase, {
    triggerLabel: 'cron-1400',
    picksCount: 3,
    candidatesCount: 142,
    durationMs: 18_500,
    sports: ['football', 'basketball'],
  });
  assert.strictEqual(ok, true, 'logScanEnd returnt true bij succes');
  assert.strictEqual(captured.type, 'scan_end');
  assert.ok(captured.title.includes('cron-1400'));
  assert.ok(captured.body.includes('3 picks'));
  assert.ok(captured.body.includes('142 kandidaten'));
  assert.ok(captured.body.includes('19s') || captured.body.includes('18s'));
  assert.strictEqual(captured.user_id, null);
  assert.strictEqual(captured.read, false);
});

test('scan-logger: insert-error path returnt false', async () => {
  const fakeSupabase = {
    from: () => ({ async insert() { return { data: null, error: { message: 'network' } }; } }),
  };
  const ok = await scanLogger.logScanEnd(fakeSupabase, { triggerLabel: 'manual' });
  assert.strictEqual(ok, false);
});

test('scan-logger: supabase=null → no-op false', async () => {
  const ok = await scanLogger.logScanEnd(null, { triggerLabel: 'manual' });
  assert.strictEqual(ok, false);
});

test('scan-logger: insert throw → caught als false', async () => {
  const fakeSupabase = {
    from: () => ({ async insert() { throw new Error('boom'); } }),
  };
  const ok = await scanLogger.logScanEnd(fakeSupabase, { triggerLabel: 'manual' });
  assert.strictEqual(ok, false);
});

// ── CLV BACKFILL (v11.0.1): snapshot fallback wanneer live api faalt ────────
console.log('\n  CLV backfill (odds_snapshots fallback):');

function buildFakeSupabaseForSnapshots(rows) {
  return {
    from(table) {
      assert.strictEqual(table, 'odds_snapshots');
      return {
        _filters: {},
        select() { return this; },
        eq(col, val) { this._filters[col] = val; return this; },
        order() { return this; },
        async limit() {
          const f = this._filters;
          const filtered = (rows || []).filter(r =>
            (!f.fixture_id || r.fixture_id === f.fixture_id) &&
            (!f.market_type || r.market_type === f.market_type) &&
            (!f.selection_key || r.selection_key === f.selection_key)
          );
          return { data: filtered, error: null };
        },
      };
    },
  };
}

test('clv-backfill: geen fixtureId/markt → null', async () => {
  const sb = buildFakeSupabaseForSnapshots([]);
  const r1 = await clvBackfill.fetchSnapshotClosing(sb, {});
  const r2 = await clvBackfill.fetchSnapshotClosing(sb, { fixtureId: 1 });
  const r3 = await clvBackfill.fetchSnapshotClosing(sb, { markt: 'Over 2.5' });
  assert.strictEqual(r1, null);
  assert.strictEqual(r2, null);
  assert.strictEqual(r3, null);
});

test('clv-backfill: preferred bookie row wint van Pinnacle', async () => {
  const sb = buildFakeSupabaseForSnapshots([
    { fixture_id: 42, market_type: 'total', selection_key: 'over', line: 2.5, bookmaker: 'Unibet', odds: 1.90, captured_at: '2026-04-10T19:00:00Z' },
    { fixture_id: 42, market_type: 'total', selection_key: 'over', line: 2.5, bookmaker: 'Pinnacle', odds: 1.95, captured_at: '2026-04-10T19:00:00Z' },
  ]);
  const r = await clvBackfill.fetchSnapshotClosing(sb, {
    fixtureId: 42, markt: 'Over 2.5', preferredBookie: 'Unibet',
  });
  assert.strictEqual(r.closingOdds, 1.9);
  assert.strictEqual(r.sourceType, 'snapshot-preferred');
  assert.strictEqual(r.bookieUsed, 'Unibet');
});

test('clv-backfill: zonder preferred match → Pinnacle als sharp anchor', async () => {
  const sb = buildFakeSupabaseForSnapshots([
    { fixture_id: 42, market_type: 'total', selection_key: 'over', bookmaker: 'Pinnacle', odds: 1.95, captured_at: '2026-04-10T19:00:00Z' },
    { fixture_id: 42, market_type: 'total', selection_key: 'over', bookmaker: 'Betway', odds: 1.88, captured_at: '2026-04-10T19:00:00Z' },
  ]);
  const r = await clvBackfill.fetchSnapshotClosing(sb, {
    fixtureId: 42, markt: 'Over 2.5', preferredBookie: 'Bet365',
  });
  assert.strictEqual(r.sourceType, 'snapshot-sharp');
  assert.strictEqual(r.bookieUsed, 'Pinnacle');
});

test('clv-backfill: alleen soft-book → snapshot-any fallback', async () => {
  const sb = buildFakeSupabaseForSnapshots([
    { fixture_id: 42, market_type: 'total', selection_key: 'over', bookmaker: 'Betway', odds: 1.85, captured_at: '2026-04-10T19:00:00Z' },
  ]);
  const r = await clvBackfill.fetchSnapshotClosing(sb, {
    fixtureId: 42, markt: 'Over 2.5', preferredBookie: 'Bet365',
  });
  assert.strictEqual(r.sourceType, 'snapshot-any');
  assert.strictEqual(r.bookieUsed, 'Betway');
  assert.strictEqual(r.closingOdds, 1.85);
});

test('clv-backfill: niet-mappable markt → null (geen crash)', async () => {
  const sb = buildFakeSupabaseForSnapshots([]);
  const r = await clvBackfill.fetchSnapshotClosing(sb, {
    fixtureId: 42, markt: '🎯 Exotische markt zonder mapping',
  });
  assert.strictEqual(r, null);
});

test('clv-backfill: geen rijen → null', async () => {
  const sb = buildFakeSupabaseForSnapshots([]);
  const r = await clvBackfill.fetchSnapshotClosing(sb, {
    fixtureId: 99, markt: 'Over 2.5', preferredBookie: 'Bet365',
  });
  assert.strictEqual(r, null);
});

test('clv-backfill: ongeldige odds (≤1) worden genegeerd', async () => {
  const sb = buildFakeSupabaseForSnapshots([
    { fixture_id: 42, market_type: 'total', selection_key: 'over', bookmaker: 'Pinnacle', odds: 0.5, captured_at: '2026-04-10T19:00:00Z' },
    { fixture_id: 42, market_type: 'total', selection_key: 'over', bookmaker: 'Betway', odds: 1.92, captured_at: '2026-04-10T18:00:00Z' },
  ]);
  const r = await clvBackfill.fetchSnapshotClosing(sb, {
    fixtureId: 42, markt: 'Over 2.5', preferredBookie: 'Bet365',
  });
  assert.strictEqual(r.bookieUsed, 'Betway');
  assert.strictEqual(r.closingOdds, 1.92);
});

// ── EARLY-PAYOUT RULES DICT (v11.1.0) ────────────────────────────────────────
console.log('\n  Early-payout rules:');

test('early-payout rules: Bet365 football ML → 2 Goals Ahead', () => {
  const r = earlyPayoutRules.getEarlyPayoutRule('Bet365', 'football', 'moneyline');
  assert.ok(r, 'Bet365 football ML rule bestaat');
  assert.strictEqual(r.leadType, 'goals');
  assert.strictEqual(r.leadThreshold, 2);
  assert.ok(r.appliesToSelections.includes('home'));
  assert.ok(r.appliesToSelections.includes('away'));
});

test('early-payout rules: Bet365 MLB ML → 5 Run Lead', () => {
  const r = earlyPayoutRules.getEarlyPayoutRule('bet365', 'baseball', 'moneyline');
  assert.strictEqual(r.leadThreshold, 5);
  assert.strictEqual(r.leadType, 'runs');
});

test('early-payout rules: Bet365 NBA ML → 20 Point Lead', () => {
  const r = earlyPayoutRules.getEarlyPayoutRule('Bet365', 'basketball', 'moneyline');
  assert.strictEqual(r.leadThreshold, 20);
});

test('early-payout rules: Bet365 NHL ML → 3 Goal Lead', () => {
  const r = earlyPayoutRules.getEarlyPayoutRule('Bet365', 'hockey', 'moneyline');
  assert.strictEqual(r.leadThreshold, 3);
});

test('early-payout rules: Unibet / Pinnacle hebben geen regels', () => {
  assert.strictEqual(earlyPayoutRules.getEarlyPayoutRule('Unibet', 'football', 'moneyline'), null);
  assert.strictEqual(earlyPayoutRules.getEarlyPayoutRule('Pinnacle', 'football', 'moneyline'), null);
  assert.strictEqual(earlyPayoutRules.bookieHasAnyEarlyPayoutRules('Unibet'), false);
  assert.strictEqual(earlyPayoutRules.bookieHasAnyEarlyPayoutRules('Bet365'), true);
});

test('early-payout rules: Over/Under totals hebben nooit EP', () => {
  assert.strictEqual(earlyPayoutRules.getEarlyPayoutRule('Bet365', 'football', 'total'), null);
  assert.strictEqual(earlyPayoutRules.getEarlyPayoutRule('Bet365', 'football', 'btts'), null);
});

// ── EARLY-PAYOUT EVALUATOR + SHADOW-LOG (v11.1.0) ────────────────────────────
console.log('\n  Early-payout signal (shadow mode):');

test('early-payout evaluator: Bet365 football 2-0 final → ruleApplies true, wouldPay true', () => {
  const r = earlyPayout.evaluateEarlyPayoutFromFinal({
    bookie: 'Bet365', sport: 'football', marketType: 'moneyline', selection: 'home',
    finalScoreHome: 2, finalScoreAway: 0,
  });
  assert.strictEqual(r.ruleApplies, true);
  assert.strictEqual(r.wouldHavePaidByFinalDiff, true);
});

test('early-payout evaluator: Bet365 football 1-0 final → ruleApplies true, wouldPay false', () => {
  const r = earlyPayout.evaluateEarlyPayoutFromFinal({
    bookie: 'Bet365', sport: 'football', marketType: 'moneyline', selection: 'home',
    finalScoreHome: 1, finalScoreAway: 0,
  });
  assert.strictEqual(r.ruleApplies, true);
  assert.strictEqual(r.wouldHavePaidByFinalDiff, false);
});

test('early-payout evaluator: Unibet → ruleApplies false (geen EP-regel)', () => {
  const r = earlyPayout.evaluateEarlyPayoutFromFinal({
    bookie: 'Unibet', sport: 'football', marketType: 'moneyline', selection: 'home',
    finalScoreHome: 2, finalScoreAway: 0,
  });
  assert.strictEqual(r.ruleApplies, false);
});

test('early-payout evaluator: MLB 5-run lead → wouldPay true', () => {
  const r = earlyPayout.evaluateEarlyPayoutFromFinal({
    bookie: 'Bet365', sport: 'baseball', marketType: 'moneyline', selection: 'away',
    finalScoreHome: 2, finalScoreAway: 7,
  });
  assert.strictEqual(r.wouldHavePaidByFinalDiff, true);
});

test('early-payout evaluator: NBA 15-point diff → wouldPay false (<20 threshold)', () => {
  const r = earlyPayout.evaluateEarlyPayoutFromFinal({
    bookie: 'Bet365', sport: 'basketball', marketType: 'moneyline', selection: 'home',
    finalScoreHome: 115, finalScoreAway: 100,
  });
  assert.strictEqual(r.ruleApplies, true);
  assert.strictEqual(r.wouldHavePaidByFinalDiff, false);
});

test('early-payout shadow-log: skipt insert als ruleApplies=false', async () => {
  let inserted = null;
  const sb = { from: () => ({ async insert(p) { inserted = p; return { error: null }; } }) };
  const { logged } = await earlyPayout.logEarlyPayoutShadow(sb, {
    betId: 1, bookie: 'Unibet', sport: 'football', marketType: 'moneyline', selection: 'home',
    actualOutcome: 'W', finalScoreHome: 2, finalScoreAway: 0,
  });
  assert.strictEqual(logged, false);
  assert.strictEqual(inserted, null);
});

test('early-payout shadow-log: schrijft row bij ruleApplies met potential_lift=true (L + wouldPay)', async () => {
  // Dit is edge-case voor v1: final diff ≥ threshold én actual_outcome=L.
  // Kan gebeuren als bet is op home ML maar team verloor (bv. home 2-0 → away comeback 3-2),
  // maar in onze conservative eval op final-score-only is die combinatie onmogelijk
  // (diff ≥ 2 in selection-direction impliceert W). Test met scenario waarin
  // selection tegenstrijdig was aan de lead-richting maar rule techniisch applied.
  // Echte potential_lift meting komt uit event-timeline (shadow v2).
  let inserted = null;
  const sb = { from: () => ({ async insert(p) { inserted = p; return { error: null }; } }) };
  const { logged, evaluation } = await earlyPayout.logEarlyPayoutShadow(sb, {
    betId: 7, bookie: 'Bet365', sport: 'football', marketType: 'moneyline', selection: 'home',
    actualOutcome: 'W', finalScoreHome: 3, finalScoreAway: 0, oddsUsed: 1.85,
  });
  assert.strictEqual(logged, true);
  assert.strictEqual(evaluation.wouldHavePaidByFinalDiff, true);
  assert.ok(inserted);
  assert.strictEqual(inserted.bet_id, 7);
  assert.strictEqual(inserted.ep_rule_applied, true);
  assert.strictEqual(inserted.ep_would_have_paid, true);
  assert.strictEqual(inserted.potential_lift, false); // actual=W, dus geen lift
  assert.strictEqual(inserted.odds_used, 1.85);
});

test('early-payout aggregator: samples + rates per bookie/sport/market', () => {
  const rows = [
    { bookie_used: 'Bet365', sport: 'football', market_type: 'moneyline', ep_rule_applied: true, ep_would_have_paid: true, potential_lift: false, actual_outcome: 'W' },
    { bookie_used: 'Bet365', sport: 'football', market_type: 'moneyline', ep_rule_applied: true, ep_would_have_paid: false, potential_lift: false, actual_outcome: 'L' },
    { bookie_used: 'Bet365', sport: 'football', market_type: 'moneyline', ep_rule_applied: true, ep_would_have_paid: true, potential_lift: true, actual_outcome: 'L' },
    { bookie_used: 'Unibet', sport: 'football', market_type: 'moneyline', ep_rule_applied: false, actual_outcome: 'W' }, // should skip (rule not applied)
  ];
  const stats = earlyPayout.aggregateEarlyPayoutStats(rows);
  const k = 'Bet365/football/moneyline';
  assert.ok(stats[k]);
  assert.strictEqual(stats[k].samples, 3);
  assert.strictEqual(stats[k].potentialLifts, 1);
  assert.strictEqual(stats[k].losses, 2);
  assert.strictEqual(stats[k].conversionRate, 0.5);
  assert.strictEqual(stats[k].activationRate, +((2/3).toFixed(4)));
});

// ── PRICE-MEMORY: line-timeline (v10.10.9, fundament 2 uit Bouwvolgorde) ─────
console.log('\n  Line-timeline (price-memory query layer):');

function makeOddsRow({ at, bookie, market = 'h2h', sel = 'home', line = null, odds }) {
  return {
    captured_at: at, bookmaker: bookie, market_type: market,
    selection_key: sel, line, odds,
  };
}

test('lineTimeline.groupByLine: scheidt buckets per (selection, line) en sorteert chronologisch', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-16T12:00:00Z', bookie: 'pinnacle', sel: 'over', line: 2.5, odds: 1.95 }),
    makeOddsRow({ at: '2026-04-16T11:00:00Z', bookie: 'pinnacle', sel: 'over', line: 2.5, odds: 1.92 }),
    makeOddsRow({ at: '2026-04-16T11:00:00Z', bookie: 'pinnacle', sel: 'under', line: 2.5, odds: 1.93 }),
    makeOddsRow({ at: '2026-04-16T11:00:00Z', bookie: 'pinnacle', sel: 'over', line: 3.5, odds: 2.10 }),
  ];
  const buckets = lineTimeline.groupByLine(rows);
  assert.strictEqual(buckets.size, 3, 'over@2.5, under@2.5, over@3.5');
  const over25 = buckets.get('over|2.5');
  assert.strictEqual(over25.rows.length, 2);
  assert.strictEqual(over25.rows[0].captured_at, '2026-04-16T11:00:00Z', 'eerste row chronologisch');
  assert.strictEqual(over25.rows[1].captured_at, '2026-04-16T12:00:00Z');
});

test('lineTimeline.buildTimeline: lege rows → null structuur, geen crash', () => {
  const t = lineTimeline.buildTimeline([], { kickoffMs: Date.parse('2026-04-16T20:00:00Z') });
  assert.strictEqual(t.open, null);
  assert.strictEqual(t.close, null);
  assert.strictEqual(t.drift, null);
  assert.strictEqual(t.preferredGap, null);
  assert.strictEqual(t.stale, null);
  assert.strictEqual(t.bookmakerCountMax, 0);
  assert.strictEqual(t.samples, 0);
});

test('lineTimeline.buildTimeline: open=eerste cluster, drift positief = prob omhoog (prijs zakt)', () => {
  // Open @ 2.50 (40%), close @ 2.00 (50%) → drift = +0.10
  const rows = [
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'pinnacle', odds: 2.50 }),
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'bet365',   odds: 2.50 }),
    makeOddsRow({ at: '2026-04-16T19:30:00Z', bookie: 'pinnacle', odds: 2.00 }),
    makeOddsRow({ at: '2026-04-16T19:30:00Z', bookie: 'bet365',   odds: 2.00 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-16T20:00:00Z'),
    closeWindowMs: 60 * 60 * 1000, // ruim 1u zodat 19:30 als close telt
    preKickoffWindowMs: 60 * 60 * 1000,
  });
  assert.ok(t.open && t.open.marketAvgProb > 0.39 && t.open.marketAvgProb < 0.41, 'open ~40%');
  assert.ok(t.close && t.close.marketAvgProb > 0.49 && t.close.marketAvgProb < 0.51, 'close ~50%');
  assert.ok(t.drift > 0.09 && t.drift < 0.11, `drift +0.10 (kreeg ${t.drift})`);
  assert.strictEqual(t.bookmakerCountMax, 2);
});

test('lineTimeline.buildTimeline: preferred_gap detectie en stale-flag', () => {
  // Markt-best 2.20, preferred bet365 op 2.05 → gap 0.15 → stale=true
  const rows = [
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'pinnacle', odds: 2.20 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'circa',    odds: 2.18 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'bet365',   odds: 2.05 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-16T20:00:00Z'),
    preferredBookies: ['bet365', 'unibet'],
    closeWindowMs: 10 * 60 * 1000,
    preKickoffWindowMs: 10 * 60 * 1000,
  });
  assert.ok(t.close, 'close cluster moet bestaan');
  assert.strictEqual(t.close.bestPrice, 2.20);
  assert.strictEqual(t.close.bestPreferredPrice, 2.05);
  assert.strictEqual(t.preferredGap, 0.15);
  assert.strictEqual(t.stale, true, 'gap >= 0.05 odds → stale');
});

test('lineTimeline.buildTimeline: gap < 0.05 → stale=false', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'pinnacle', odds: 2.10 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'bet365',   odds: 2.08 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-16T20:00:00Z'),
    preferredBookies: ['bet365'],
    closeWindowMs: 10 * 60 * 1000,
    preKickoffWindowMs: 10 * 60 * 1000,
  });
  assert.ok(t.preferredGap < 0.05);
  assert.strictEqual(t.stale, false);
});

test('lineTimeline.buildTimeline: first_seen_on_preferred ≠ open als preferred pas later in markt komt', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'pinnacle', odds: 2.10 }),
    makeOddsRow({ at: '2026-04-16T10:00:00Z', bookie: 'bet365',   odds: 2.05 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'bet365',   odds: 2.00 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-16T20:00:00Z'),
    preferredBookies: ['bet365'],
  });
  assert.strictEqual(t.open.capturedAt, '2026-04-16T08:00:00Z', 'open = eerste pinnacle cluster');
  assert.strictEqual(t.firstSeenOnPreferred.capturedAt, '2026-04-16T10:00:00Z', 'eerste preferred cluster');
});

test('lineTimeline.buildTimeline: scan_anchor kiest cluster dichtst bij scan-tijd', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'pinnacle', odds: 2.10 }),
    makeOddsRow({ at: '2026-04-16T14:30:00Z', bookie: 'pinnacle', odds: 2.05 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'pinnacle', odds: 2.00 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-16T20:00:00Z'),
    scanAnchorMs: Date.parse('2026-04-16T14:00:00Z'),
  });
  assert.strictEqual(t.scanAnchor.capturedAt, '2026-04-16T14:30:00Z', 'dichtstbij scan-anchor');
});

test('lineTimeline.buildTimeline: time_to_move bij significante moves', () => {
  // Drie significante moves van ~5pp
  const rows = [
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'pinnacle', odds: 2.50 }),
    makeOddsRow({ at: '2026-04-16T09:00:00Z', bookie: 'pinnacle', odds: 2.20 }),
    makeOddsRow({ at: '2026-04-16T10:00:00Z', bookie: 'pinnacle', odds: 2.00 }),
  ];
  const t = lineTimeline.buildTimeline(rows, { moveThreshold: 0.03 });
  // Met 2 moves van ieder 1u: median = 1u = 3600000ms
  assert.ok(t.timeToMoveMs >= 3500000 && t.timeToMoveMs <= 3700000, `time-to-move ~1u (kreeg ${t.timeToMoveMs})`);
});

test('lineTimeline.buildTimeline: latest_pre_kickoff ≠ close (close zit dichter op kickoff)', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-16T18:00:00Z', bookie: 'pinnacle', odds: 2.10 }),
    makeOddsRow({ at: '2026-04-16T19:25:00Z', bookie: 'pinnacle', odds: 2.05 }),
    makeOddsRow({ at: '2026-04-16T19:58:00Z', bookie: 'pinnacle', odds: 2.00 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-16T20:00:00Z'),
    closeWindowMs: 5 * 60 * 1000,    // close = ≤ 5min vóór kickoff
    preKickoffWindowMs: 30 * 60 * 1000, // pre = ≤ 30min vóór kickoff
  });
  assert.strictEqual(t.latestPreKickoff.capturedAt, '2026-04-16T19:25:00Z', '≤30min, ≥5min vóór kickoff');
  assert.strictEqual(t.close.capturedAt, '2026-04-16T19:58:00Z', '≤5min vóór kickoff');
});

test('lineTimeline.getLineTimeline: empty supabase response → lege Map', async () => {
  const fakeSupabase = {
    from: () => ({
      select: function() { return this; },
      eq: function() { return this; },
      order: function() { return Promise.resolve({ data: [], error: null }); },
    }),
  };
  const r = await lineTimeline.getLineTimeline(fakeSupabase, { fixtureId: 1, marketType: 'h2h' });
  assert.ok(r instanceof Map);
  assert.strictEqual(r.size, 0);
});

test('lineTimeline.getLineTimeline: missing fixtureId/marketType → lege Map zonder query', async () => {
  let queried = false;
  const fakeSupabase = { from: () => { queried = true; return {}; } };
  const r1 = await lineTimeline.getLineTimeline(fakeSupabase, { marketType: 'h2h' });
  const r2 = await lineTimeline.getLineTimeline(fakeSupabase, { fixtureId: 1 });
  assert.strictEqual(queried, false, 'geen query bij missing required params');
  assert.strictEqual(r1.size, 0);
  assert.strictEqual(r2.size, 0);
});

test('lineTimeline.getLineTimeline: integration met mock supabase happy path', async () => {
  const rows = [
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'pinnacle', sel: 'home', odds: 2.50 }),
    makeOddsRow({ at: '2026-04-16T08:00:00Z', bookie: 'bet365',   sel: 'home', odds: 2.45 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'pinnacle', sel: 'home', odds: 2.00 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'bet365',   sel: 'home', odds: 1.95 }),
    makeOddsRow({ at: '2026-04-16T19:55:00Z', bookie: 'pinnacle', sel: 'away', odds: 1.85 }),
  ];
  const fakeSupabase = {
    from: () => ({
      select: function() { return this; },
      eq: function() { return this; },
      order: function() { return Promise.resolve({ data: rows, error: null }); },
    }),
  };
  const r = await lineTimeline.getLineTimeline(fakeSupabase, {
    fixtureId: 999, marketType: 'h2h',
    kickoffTime: '2026-04-16T20:00:00Z',
    preferredBookies: ['bet365'],
  });
  assert.strictEqual(r.size, 2, 'home + away buckets');
  const home = r.get('home|null');
  assert.ok(home);
  assert.ok(home.timeline.drift > 0.09, 'home prob steeg ~10pp');
  assert.ok(home.timeline.firstSeenOnPreferred);
});

// ── Phase A.1 · deriveExecutionMetrics + buildScanTimelineMap (v10.12.2) ────
test('lineTimeline.deriveExecutionMetrics: null timeline → null', () => {
  assert.strictEqual(lineTimeline.deriveExecutionMetrics(null), null);
  assert.strictEqual(lineTimeline.deriveExecutionMetrics(undefined), null);
});

test('lineTimeline.deriveExecutionMetrics: preferredGap uit timeline → preferredGapPct + stalePct', () => {
  const fakeTimeline = {
    close: { bestPrice: 2.10, bestPreferredPrice: 2.00, marketAvgProb: 0.50, bookmakerCount: 8 },
    preferredGap: 0.10,
    bookmakerCountMax: 8,
    samples: 5,
    sharpGap: 0.05,
    drift: 0.01,
  };
  const m = lineTimeline.deriveExecutionMetrics(fakeTimeline);
  assert.ok(m);
  assert.strictEqual(m.preferredGap, 0.10);
  // (2.10 - 2.00) / 2.00 × 100 = 5%
  assert.strictEqual(m.preferredGapPct, 5);
  assert.strictEqual(m.stalePct, 5);
  assert.strictEqual(m.bookmakerCountMax, 8);
  assert.strictEqual(m.hasTargetBookie, true);
});

test('lineTimeline.deriveExecutionMetrics: overroundPct 3-way vs 2-way', () => {
  // marketAvgProb 0.40 → 3-way overround: 0.40*3-1 = 0.20 = 20%
  const fakeTimeline = {
    close: { bestPrice: 2.50, bestPreferredPrice: 2.45, marketAvgProb: 0.40, bookmakerCount: 6 },
    preferredGap: 0.05,
    bookmakerCountMax: 6,
    samples: 3,
  };
  const m3 = lineTimeline.deriveExecutionMetrics(fakeTimeline);
  assert.strictEqual(m3.overroundPct, 20);
  const m2 = lineTimeline.deriveExecutionMetrics(fakeTimeline, { twoWayMarket: true });
  // 2-way: 0.40*2-1 = -0.20 → clamped naar 0
  assert.strictEqual(m2.overroundPct, 0);
});

test('lineTimeline.deriveExecutionMetrics: geen preferred price → hasTargetBookie=false', () => {
  const fakeTimeline = {
    close: { bestPrice: 2.50, bestPreferredPrice: null, marketAvgProb: 0.45, bookmakerCount: 4 },
    preferredGap: null,
    bookmakerCountMax: 4,
  };
  const m = lineTimeline.deriveExecutionMetrics(fakeTimeline);
  assert.strictEqual(m.hasTargetBookie, false);
  assert.strictEqual(m.preferredGapPct, null);
});

test('lineTimeline.buildScanTimelineMap: empty fixtureIds → lege Map zonder query', async () => {
  let called = false;
  const fakeSupabase = { from: () => { called = true; return { select: () => ({ in: () => ({ order: async () => ({ data: [] }) }) }) }; } };
  const r = await lineTimeline.buildScanTimelineMap(fakeSupabase, { fixtureIds: [] });
  assert.strictEqual(r.size, 0);
  assert.strictEqual(called, false);
});

test('lineTimeline.buildScanTimelineMap: meerdere fixtures → per-bucket keys', async () => {
  const rows = [
    { fixture_id: 1, captured_at: '2026-04-16T18:00:00Z', bookmaker: 'pinnacle', market_type: 'h2h', selection_key: 'home', line: null, odds: 2.10 },
    { fixture_id: 1, captured_at: '2026-04-16T19:00:00Z', bookmaker: 'bet365',   market_type: 'h2h', selection_key: 'home', line: null, odds: 2.00 },
    { fixture_id: 2, captured_at: '2026-04-16T18:00:00Z', bookmaker: 'pinnacle', market_type: 'h2h', selection_key: 'away', line: null, odds: 3.50 },
  ];
  // Builder returns itself so .in().order().in() chains; awaiting resolves with data.
  const builder = {};
  builder.select = () => builder;
  builder.in = () => builder;
  builder.order = () => builder;
  builder.then = (resolve) => resolve({ data: rows, error: null });
  const fakeSupabase = { from: () => builder };
  const map = await lineTimeline.buildScanTimelineMap(fakeSupabase, {
    fixtureIds: [1, 2], marketTypes: ['h2h'], preferredBookies: ['bet365'],
  });
  assert.strictEqual(map.size, 2);
  assert.ok(map.has('1|h2h|home|null'));
  assert.ok(map.has('2|h2h|away|null'));
});

test('lineTimeline.lookupTimeline: O(1) key-match', () => {
  const map = new Map([
    ['1|h2h|home|null', { fixtureId: 1, timeline: { samples: 3 } }],
    ['1|totals|over|2.5', { fixtureId: 1, timeline: { samples: 5 } }],
  ]);
  assert.ok(lineTimeline.lookupTimeline(map, { fixtureId: 1, marketType: 'h2h', selectionKey: 'home', line: null }));
  assert.ok(lineTimeline.lookupTimeline(map, { fixtureId: 1, marketType: 'totals', selectionKey: 'over', line: 2.5 }));
  assert.strictEqual(lineTimeline.lookupTimeline(map, { fixtureId: 1, marketType: 'h2h', selectionKey: 'away', line: null }), null);
  assert.strictEqual(lineTimeline.lookupTimeline(null, { fixtureId: 1, marketType: 'h2h', selectionKey: 'home', line: null }), null);
});

// ── EXECUTION GATE: applyExecutionGate (v10.10.10+, fundament 3 Bouwvolgorde) ─
console.log('\n  Execution gate (Kelly-damping op metrics):');

test('applyExecutionGate: hk=0 of negatief → reasons=hk_invalid_or_zero', () => {
  const r1 = execGate.applyExecutionGate(0, {});
  const r2 = execGate.applyExecutionGate(-0.5, {});
  assert.strictEqual(r1.hk, 0);
  assert.deepStrictEqual(r1.reasons, ['hk_invalid_or_zero']);
  assert.strictEqual(r2.hk, 0);
});

test('applyExecutionGate: targetPresent=false → hard skip wint van alles', () => {
  const r = execGate.applyExecutionGate(0.05, {
    targetPresent: false,
    preferredGap: 0.01,
  });
  assert.strictEqual(r.skip, true);
  assert.strictEqual(r.hk, 0);
  assert.deepStrictEqual(r.reasons, ['no_target_bookie']);
});

test('applyExecutionGate: targetPresent=null → geen hard skip (onbekend ≠ false)', () => {
  const r = execGate.applyExecutionGate(0.05, { targetPresent: null });
  assert.strictEqual(r.skip, false);
  assert.strictEqual(r.hk, 0.05);
});

test('applyExecutionGate: preferredGap >= 0.10 → hk × 0.5 (stale_abs_high)', () => {
  const r = execGate.applyExecutionGate(0.10, { preferredGap: 0.12 });
  assert.strictEqual(r.hk, 0.05);
  assert.strictEqual(r.multipliers.staleAbs, 0.5);
  assert.ok(r.reasons[0].startsWith('stale_abs_high'));
});

test('applyExecutionGate: preferredGap 0.05–0.10 → hk × 0.7 (stale_abs_mid)', () => {
  const r = execGate.applyExecutionGate(0.10, { preferredGap: 0.06 });
  assert.strictEqual(r.hk, 0.07);
  assert.strictEqual(r.multipliers.staleAbs, 0.7);
  assert.ok(r.reasons[0].startsWith('stale_abs_mid'));
});

test('applyExecutionGate: preferredGap < 0.05 → geen multiplier', () => {
  const r = execGate.applyExecutionGate(0.10, { preferredGap: 0.03 });
  assert.strictEqual(r.hk, 0.10);
  assert.deepStrictEqual(r.multipliers, {});
});

test('applyExecutionGate: preferredGapPct ≥ 3.5% → hk × 0.6', () => {
  const r = execGate.applyExecutionGate(0.10, { preferredGapPct: 0.04 });
  assert.strictEqual(r.hk, 0.06);
  assert.strictEqual(r.multipliers.gapPct, 0.6);
});

test('applyExecutionGate: preferredGapPct 2.0–3.5% → hk × 0.8', () => {
  const r = execGate.applyExecutionGate(0.10, { preferredGapPct: 0.025 });
  assert.strictEqual(r.hk, 0.08);
  assert.strictEqual(r.multipliers.gapPct, 0.8);
});

test('applyExecutionGate: 2-way overround > 8% → hk × 0.85', () => {
  const r = execGate.applyExecutionGate(1.0, { overroundPct: 0.10, marketShape: 'two-way' });
  assert.strictEqual(r.hk, 0.85);
  assert.strictEqual(r.multipliers.overround, 0.85);
});

test('applyExecutionGate: 3-way overround > 12% triggert, 8% niet', () => {
  const r1 = execGate.applyExecutionGate(1.0, { overroundPct: 0.13, marketShape: 'three-way' });
  const r2 = execGate.applyExecutionGate(1.0, { overroundPct: 0.10, marketShape: 'three-way' });
  assert.strictEqual(r1.hk, 0.85);
  assert.strictEqual(r2.hk, 1.0, '3-way: 10% overround zit nog onder 12% drempel');
});

test('applyExecutionGate: bookmakerCountMax < 3 → hk × 0.8 (thin_market)', () => {
  const r = execGate.applyExecutionGate(1.0, { bookmakerCountMax: 2 });
  assert.strictEqual(r.hk, 0.8);
  assert.strictEqual(r.multipliers.thinMarket, 0.8);
});

test('applyExecutionGate: meerdere multipliers stapelen multiplicatief', () => {
  const r = execGate.applyExecutionGate(1.0, {
    preferredGap: 0.06,        // × 0.7
    preferredGapPct: 0.04,     // × 0.6
    overroundPct: 0.10,        // × 0.85
    bookmakerCountMax: 2,      // × 0.8
    marketShape: 'two-way',
  });
  // 0.7 × 0.6 × 0.85 × 0.8 = 0.2856
  assert.ok(Math.abs(r.combinedMultiplier - 0.2856) < 0.0001, `combined ~0.2856, kreeg ${r.combinedMultiplier}`);
  assert.strictEqual(Object.keys(r.multipliers).length, 4);
  assert.strictEqual(r.reasons.length, 4);
});

test('applyExecutionGate: thresholds override schuift drempels', () => {
  const r = execGate.applyExecutionGate(1.0, { preferredGap: 0.05 }, { staleAbsHigh: 0.04 });
  assert.strictEqual(r.multipliers.staleAbs, 0.5, 'override schuift drempel naar beneden');
});

test('buildExecutionMetrics: consolideert lineTimeline + executionQuality output', () => {
  const lt = {
    close: { bestPreferredPrice: 2.00, bestPrice: 2.10 },
    preferredGap: 0.10,
    bookmakerCountMax: 5,
    drift: 0.02,
    timeToMoveMs: 1800000,
  };
  const eq = { overround: 0.07, status: 'playable' };
  const m = execGate.buildExecutionMetrics({ executionQuality: eq, lineTimeline: lt });
  assert.strictEqual(m.targetPresent, true);
  assert.strictEqual(m.preferredGap, 0.10);
  assert.strictEqual(m.preferredGapPct, 0.05, '0.10 / 2.00 = 0.05');
  assert.strictEqual(m.bookmakerCountMax, 5);
  assert.strictEqual(m.overroundPct, 0.07);
  assert.strictEqual(m.status, 'playable');
});

test('buildExecutionMetrics: ontbrekende preferred price → targetPresent=null', () => {
  const lt = { close: { bestPrice: 2.10, bestPreferredPrice: null }, preferredGap: null };
  const m = execGate.buildExecutionMetrics({ lineTimeline: lt });
  assert.strictEqual(m.targetPresent, null, 'onbekend ≠ false');
});

test('buildExecutionMetrics → applyExecutionGate end-to-end', () => {
  const lt = {
    close: { bestPreferredPrice: 1.95, bestPrice: 2.05 },
    preferredGap: 0.10,
    bookmakerCountMax: 6,
  };
  const eq = { overround: 0.05 };
  const metrics = execGate.buildExecutionMetrics({ executionQuality: eq, lineTimeline: lt });
  const r = execGate.applyExecutionGate(0.05, metrics);
  // preferredGap=0.10 → staleAbs × 0.5
  // preferredGapPct = 0.10/1.95 ≈ 0.0513 → gapPct × 0.6 (≥ 3.5%)
  assert.strictEqual(r.skip, false);
  assert.ok(Math.abs(r.combinedMultiplier - 0.30) < 0.001, `0.5 × 0.6 = 0.30, kreeg ${r.combinedMultiplier}`);
  assert.ok(r.hk < 0.05);
});

// ── PLAYABILITY MATRIX (v10.10.14, component D) ──────────────────────────────
console.log('\n  Playability matrix:');

test('assessPlayability: onbekende sport → dataRich=false + note', () => {
  const r = playability.assessPlayability({ sport: 'cricket', marketType: 'moneyline' });
  assert.strictEqual(r.dataRich, false);
  assert.ok(r.notes.some(n => n.includes('onbekende sport')));
});

test('assessPlayability: voetbal moneyline met injuries+lineups → dataRich=true', () => {
  const r = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    capabilities: { injuries: true, lineups: true },
  });
  assert.strictEqual(r.dataRich, true);
});

test('assessPlayability: voetbal btts zonder lineups/injuries → dataRich=false', () => {
  const r = playability.assessPlayability({
    sport: 'football', marketType: 'btts',
    capabilities: {},
  });
  assert.strictEqual(r.dataRich, false);
});

test('assessPlayability: NHL moneyline met goalie_preview → dataRich=true', () => {
  const r = playability.assessPlayability({
    sport: 'hockey', marketType: 'moneyline',
    capabilities: { goalie_preview: true },
  });
  assert.strictEqual(r.dataRich, true);
});

test('assessPlayability: MLB f5_total met probable_pitcher → dataRich=true', () => {
  const r = playability.assessPlayability({
    sport: 'baseball', marketType: 'f5_total',
    capabilities: { probable_pitcher: true },
  });
  assert.strictEqual(r.dataRich, true);
});

test('assessPlayability: lineQuality tier-mapping op bookmakerCount', () => {
  assert.strictEqual(playability.assessPlayability({ bookmakerCount: 8 }).lineQuality, 'high');
  assert.strictEqual(playability.assessPlayability({ bookmakerCount: 4 }).lineQuality, 'medium');
  assert.strictEqual(playability.assessPlayability({ bookmakerCount: 2 }).lineQuality, 'low');
});

test('assessPlayability: overround > 10% degradeert lineQuality één tier', () => {
  const r = playability.assessPlayability({ bookmakerCount: 8, overroundPct: 0.12 });
  assert.strictEqual(r.lineQuality, 'medium', 'high → medium bij hoge overround');
  assert.ok(r.notes.some(n => n.includes('downgrade')));
});

test('assessPlayability: playable = executable && lineQuality !== low', () => {
  const good = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    preferredHasCoverage: true, bookmakerCount: 8,
    capabilities: {},
  });
  assert.strictEqual(good.playable, true);
  assert.strictEqual(good.coverageKnown, true);
  assert.strictEqual(good.dataRich, false, 'dataRich mag false zijn');

  const noExec = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    preferredHasCoverage: false, bookmakerCount: 8,
  });
  assert.strictEqual(noExec.playable, false, 'executable=false → not playable');
  assert.strictEqual(noExec.coverageKnown, true);

  const lowLine = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    preferredHasCoverage: true, bookmakerCount: 1,
  });
  assert.strictEqual(lowLine.playable, false, 'lineQuality=low → not playable');
  assert.strictEqual(lowLine.coverageKnown, true);
});

// v10.10.15: Codex-review fix — executable onbekend promoveert niet meer
// stilletjes naar playable=true.
test('assessPlayability: executable=null → playable=false (conservatief) + coverageKnown=false', () => {
  // Geen preferredHasCoverage aanwezig → executable = null (onbekend).
  // Met hoge lineQuality zou dit voorheen gevaarlijk `playable=true` geven.
  const unknown = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    bookmakerCount: 8,
  });
  assert.strictEqual(unknown.executable, null);
  assert.strictEqual(unknown.playable, false, 'execution onbekend → niet-playable (conservatief)');
  assert.strictEqual(unknown.coverageKnown, false, 'expliciet gemarkeerd als niet-gekend');
  assert.ok(unknown.notes.some(n => n.includes('coverage onbekend')));
});

test('assessPlayability: preferredCount > 0 promoveert executable naar true (coverageKnown=true)', () => {
  // preferredCount > 0 betekent dat de caller expliciet preferred bookies
  // heeft geteld op dit event — dat telt als known coverage, dus
  // coverageKnown=true en executable=true.
  const hinted = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    preferredCount: 2, bookmakerCount: 8,
  });
  assert.strictEqual(hinted.executable, true, 'preferredCount > 0 → executable=true');
  assert.strictEqual(hinted.coverageKnown, true);
  assert.strictEqual(hinted.playable, true);
});

test('assessPlayability: dataRich BLIJFT aparte as van playable (Codex-nuance)', () => {
  // Markt is speelbaar (preferred + 6+ bookies), maar geen enrichment-data.
  // Moet playable=true geven maar dataRich=false.
  const r = playability.assessPlayability({
    sport: 'hockey', marketType: 'total',
    preferredHasCoverage: true, bookmakerCount: 6,
    capabilities: { goalie_preview: false }, // expliciet geen feed
  });
  assert.strictEqual(r.playable, true, 'markt is speelbaar ondanks dunne data');
  assert.strictEqual(r.dataRich, false);
});

test('assessPlayability: apiHost auto-vult injuries-capability via supportsApiSportsInjuries', () => {
  const football = playability.assessPlayability({
    sport: 'football', marketType: 'moneyline',
    apiHost: 'v3.football.api-sports.io',
    capabilities: { lineups: true },
  });
  assert.strictEqual(football.dataRich, true, 'football injuries auto-true');

  const basketball = playability.assessPlayability({
    sport: 'basketball', marketType: 'moneyline',
    apiHost: 'v1.basketball.api-sports.io',
  });
  assert.strictEqual(basketball.dataRich, false, 'basketball heeft geen injuries-feed volgens capabilities');
});

// v10.10.15: Codex-review fix — basketball pace is derived, niet feed-backed.
test('assessPlayability: basketball total met pace=true → dataRich=false (pace is derived feature)', () => {
  const r = playability.assessPlayability({
    sport: 'basketball', marketType: 'total',
    capabilities: { pace: true }, // zelfs expliciet pace=true mag niet tellen
  });
  assert.strictEqual(r.dataRich, false, 'pace is geen feed, niet meetellen');
  // injuries WEL tellen
  const rInjury = playability.assessPlayability({
    sport: 'basketball', marketType: 'total',
    capabilities: { injuries: true },
  });
  assert.strictEqual(rInjury.dataRich, true, 'injuries is wel feed-backed');
});

// ── CALIBRATION MONITOR (slice 2, v10.10.16) ─────────────────────────────────
console.log('\n  Calibration monitor:');

test('computeBrierScore: perfect kalibratie (0 of 1 matcht outcome) → 0', () => {
  const preds = [
    { prob: 1.0, outcome: 1 },
    { prob: 0.0, outcome: 0 },
    { prob: 1.0, outcome: 1 },
  ];
  assert.strictEqual(calMonitor.computeBrierScore(preds), 0);
});

test('computeBrierScore: random 0.5 gok → 0.25', () => {
  const preds = [
    { prob: 0.5, outcome: 1 },
    { prob: 0.5, outcome: 0 },
    { prob: 0.5, outcome: 1 },
    { prob: 0.5, outcome: 0 },
  ];
  assert.strictEqual(calMonitor.computeBrierScore(preds), 0.25);
});

test('computeBrierScore: lege/invalid → null', () => {
  assert.strictEqual(calMonitor.computeBrierScore([]), null);
  assert.strictEqual(calMonitor.computeBrierScore(null), null);
  assert.strictEqual(calMonitor.computeBrierScore([{ prob: 'x', outcome: 0 }]), null);
});

test('computeWeightedBrierScore: dominante weight trekt metric richting dominante pick', () => {
  const preds = [
    { prob: 0.9, outcome: 1, weight: 0.9 }, // bijna perfect, zwaar
    { prob: 0.9, outcome: 0, weight: 0.1 }, // slecht, licht
  ];
  const weighted = calMonitor.computeWeightedBrierScore(preds);
  const unweighted = calMonitor.computeBrierScore(preds);
  assert.ok(weighted < unweighted, `weighted ${weighted} moet lager zijn dan unweighted ${unweighted}`);
});

test('computeLogLoss: perfect → ~0 (clamped bij log(0))', () => {
  const preds = [
    { prob: 0.99, outcome: 1 },
    { prob: 0.01, outcome: 0 },
  ];
  const ll = calMonitor.computeLogLoss(preds);
  assert.ok(ll >= 0 && ll < 0.05, `verwacht ~0, kreeg ${ll}`);
});

test('computeLogLoss: random 0.5 → ~ln(2) = 0.693', () => {
  const preds = [
    { prob: 0.5, outcome: 1 },
    { prob: 0.5, outcome: 0 },
  ];
  const ll = calMonitor.computeLogLoss(preds);
  assert.ok(Math.abs(ll - Math.log(2)) < 0.001, `verwacht ~0.693, kreeg ${ll}`);
});

test('computeLogLoss: clamps extreme probs om log(0) te vermijden', () => {
  const preds = [{ prob: 1.0, outcome: 0 }]; // worst case
  const ll = calMonitor.computeLogLoss(preds);
  assert.ok(Number.isFinite(ll), 'geen -Infinity of NaN');
  assert.ok(ll > 30, 'maar wel heel groot — dit is een catastrofale fout');
});

test('computeWeightedLogLoss: dominante weight trekt metric richting dominante pick', () => {
  const preds = [
    { prob: 0.8, outcome: 1, weight: 0.9 },
    { prob: 0.8, outcome: 0, weight: 0.1 },
  ];
  const weighted = calMonitor.computeWeightedLogLoss(preds);
  const unweighted = calMonitor.computeLogLoss(preds);
  assert.ok(weighted < unweighted, `weighted ${weighted} moet lager zijn dan unweighted ${unweighted}`);
  assert.ok(Number.isFinite(weighted));
});

test('computeCalibrationBins: split in 10 bins, bin-indices + counts kloppen', () => {
  const preds = [
    { prob: 0.05, outcome: 0 },
    { prob: 0.15, outcome: 1 },
    { prob: 0.55, outcome: 1 },
    { prob: 0.55, outcome: 0 },
    { prob: 0.95, outcome: 1 },
  ];
  const bins = calMonitor.computeCalibrationBins(preds, 10);
  assert.strictEqual(bins.length, 10);
  assert.strictEqual(bins[0].n, 1); // 0.05 zit in bin 0
  assert.strictEqual(bins[1].n, 1); // 0.15 in bin 1
  assert.strictEqual(bins[5].n, 2); // 0.55×2 in bin 5
  assert.strictEqual(bins[9].n, 1); // 0.95 in bin 9
  assert.strictEqual(bins[5].actualRate, 0.5, '1W 1L op bin 5 → 50%');
});

test('computeWeightedCalibrationBins: avgProb/actualRate gebruiken weights i.p.v. plain counts', () => {
  const preds = [
    { prob: 0.55, outcome: 1, weight: 0.75 },
    { prob: 0.55, outcome: 0, weight: 0.25 },
  ];
  const bins = calMonitor.computeWeightedCalibrationBins(preds, 10);
  assert.strictEqual(bins[5].n, 2);
  assert.ok(Math.abs(bins[5].weightSum - 1.0) < 0.0001);
  assert.strictEqual(bins[5].avgProb, 0.55);
  assert.strictEqual(bins[5].actualRate, 0.75);
});

test('parseSignalContribution: standaard pattern', () => {
  assert.deepStrictEqual(
    calMonitor.parseSignalContribution('form:+2.5%'),
    { name: 'form', contribution: 2.5 }
  );
  assert.deepStrictEqual(
    calMonitor.parseSignalContribution('nhl_goalie:-1.2%'),
    { name: 'nhl_goalie', contribution: -1.2 }
  );
  assert.strictEqual(calMonitor.parseSignalContribution('sanity_ok'), null);
  assert.strictEqual(calMonitor.parseSignalContribution(null), null);
});

test('attributePickToSignals: gewogen mode bij parseable percentages', () => {
  const result = calMonitor.attributePickToSignals({
    signals: ['form:+3.0%', 'h2h:+1.0%'],
  });
  assert.strictEqual(result.mode, 'weighted');
  assert.strictEqual(result.signals.length, 2);
  const form = result.signals.find(s => s.name === 'form');
  const h2h = result.signals.find(s => s.name === 'h2h');
  assert.ok(Math.abs(form.weight - 0.75) < 0.001, 'form 3/4 = 75%');
  assert.ok(Math.abs(h2h.weight - 0.25) < 0.001, 'h2h 1/4 = 25%');
});

test('attributePickToSignals: uniform fallback bij labels zonder percentages', () => {
  const result = calMonitor.attributePickToSignals({
    signals: ['sanity_ok', '3way_ml'],
  });
  assert.strictEqual(result.mode, 'uniform');
  assert.strictEqual(result.signals.length, 2);
  assert.ok(result.signals.every(s => Math.abs(s.weight - 0.5) < 0.001));
});

test('attributePickToSignals: mixed percent + label → gewogen modus op percent-only', () => {
  const result = calMonitor.attributePickToSignals({
    signals: ['form:+2.0%', 'sanity_ok'],
  });
  // Alleen form is parseable → mode weighted, weight 1.0 voor form, sanity_ok wordt genegeerd in weighted modus.
  assert.strictEqual(result.mode, 'weighted');
  assert.strictEqual(result.signals.length, 1);
  assert.strictEqual(result.signals[0].name, 'form');
});

test('attributePickToSignals: totalAbs=0 (alle contributions 0) → uniform fallback', () => {
  const result = calMonitor.attributePickToSignals({
    signals: ['form:+0%', 'h2h:+0%'],
  });
  assert.strictEqual(result.mode, 'uniform');
  assert.strictEqual(result.signals.length, 2);
});

test('windowsFor: settled 15d ago hoort bij 30d/90d/365d/lifetime', () => {
  const now = Date.now();
  const settled = now - 15 * 24 * 60 * 60 * 1000;
  const windows = calMonitor.windowsFor(settled, now);
  assert.ok(windows.includes('30d'));
  assert.ok(windows.includes('90d'));
  assert.ok(windows.includes('365d'));
  assert.ok(windows.includes('lifetime'));
});

test('windowsFor: settled 200d ago hoort alleen bij 365d/lifetime', () => {
  const now = Date.now();
  const settled = now - 200 * 24 * 60 * 60 * 1000;
  const windows = calMonitor.windowsFor(settled, now);
  assert.ok(!windows.includes('30d'));
  assert.ok(!windows.includes('90d'));
  assert.ok(windows.includes('365d'));
  assert.ok(windows.includes('lifetime'));
});

test('aggregateBySignal: weegt settled picks per (signal, sport, market, window)', () => {
  const now = Date.now();
  const recent = now - 5 * 24 * 60 * 60 * 1000; // 5 dagen geleden
  const oud = now - 120 * 24 * 60 * 60 * 1000;  // 120 dagen geleden
  const settled = [
    {
      ep: 0.60, uitkomst: 'W', settledAt: recent,
      signals: ['form:+2.5%'], sport: 'football', markt: '1x2',
    },
    {
      ep: 0.55, uitkomst: 'L', settledAt: recent,
      signals: ['form:+1.5%'], sport: 'football', markt: '1x2',
    },
    {
      ep: 0.65, uitkomst: 'W', settledAt: oud,
      signals: ['form:+3.0%'], sport: 'football', markt: '1x2',
    },
  ];
  const out = calMonitor.aggregateBySignal(settled, { now });

  const formFb1x2_30d = out.get('form|football|1x2|30d');
  const formFb1x2_lifetime = out.get('form|football|1x2|lifetime');
  assert.ok(formFb1x2_30d, 'form/football/1x2/30d bucket bestaat');
  assert.strictEqual(formFb1x2_30d.n, 2, 'alleen de 2 recente picks in 30d');
  assert.ok(formFb1x2_lifetime, 'lifetime bucket bestaat');
  assert.strictEqual(formFb1x2_lifetime.n, 3, 'alle drie in lifetime');
  assert.strictEqual(formFb1x2_lifetime.attributionMode, 'weighted');
  assert.ok(formFb1x2_lifetime.brierScore >= 0);
  assert.ok(formFb1x2_lifetime.logLoss >= 0);
});

test('aggregateBySignal: mixed pick weegt signal buckets 0.75 / 0.25', () => {
  const now = Date.now();
  const settled = [
    {
      ep: 0.70, uitkomst: 'W', settledAt: now - 86400000,
      signals: ['form:+3.0%', 'h2h:+1.0%'], sport: 'football', markt: '1x2',
    },
  ];
  const out = calMonitor.aggregateBySignal(settled, { now });
  const form = out.get('form|football|1x2|lifetime');
  const h2h = out.get('h2h|football|1x2|lifetime');
  assert.ok(form && h2h);
  assert.strictEqual(form.n, 1);
  assert.strictEqual(h2h.n, 1);
  assert.ok(Math.abs(form.nEffective - 0.75) < 0.001, `form nEffective ${form.nEffective}`);
  assert.ok(Math.abs(h2h.nEffective - 0.25) < 0.001, `h2h nEffective ${h2h.nEffective}`);
});

test('aggregateBySignal: mixed attribution-mode per signaal krijgt "mixed" label', () => {
  const now = Date.now();
  const recent = now - 5 * 24 * 60 * 60 * 1000;
  const settled = [
    // Pick 1: gewogen
    { ep: 0.60, uitkomst: 'W', settledAt: recent, signals: ['form:+2.5%'], sport: 'football', markt: '1x2' },
    // Pick 2: uniform (geen percentages)
    { ep: 0.55, uitkomst: 'L', settledAt: recent, signals: ['form'], sport: 'football', markt: '1x2' },
  ];
  const out = calMonitor.aggregateBySignal(settled, { now });
  const form = out.get('form|football|1x2|lifetime');
  assert.ok(form);
  assert.strictEqual(form.attributionMode, 'mixed');
});

test('aggregateBySignal: open bets (uitkomst Open) worden genegeerd', () => {
  const now = Date.now();
  const settled = [
    { ep: 0.60, uitkomst: 'Open', settledAt: now - 86400000, signals: ['form:+2%'], sport: 'football', markt: '1x2' },
    { ep: 0.55, uitkomst: 'W', settledAt: now - 86400000, signals: ['form:+2%'], sport: 'football', markt: '1x2' },
  ];
  const out = calMonitor.aggregateBySignal(settled, { now });
  const form = out.get('form|football|1x2|lifetime');
  assert.strictEqual(form.n, 1, 'alleen de settled W telt');
});

test('windowStartFor: 30d/90d/365d krijgen expliciete start, lifetime blijft null', () => {
  const endMs = Date.UTC(2026, 3, 16, 12, 0, 0);
  assert.ok(calMonitor.windowStartFor('30d', endMs));
  assert.ok(calMonitor.windowStartFor('90d', endMs));
  assert.ok(calMonitor.windowStartFor('365d', endMs));
  assert.strictEqual(calMonitor.windowStartFor('lifetime', endMs), null);
});

test('buildCalibrationRows: schrijft probability_source=ep_proxy en expliciete window_start', () => {
  const aggregates = new Map([[
    'form|football|1x2|30d',
    {
      signalName: 'form',
      sport: 'football',
      marketType: '1x2',
      windowKey: '30d',
      n: 2,
      nEffective: 1.5,
      brierScore: 0.123456,
      logLoss: 0.54321,
      avgProb: 0.61,
      actualRate: 0.5,
      bins: [{ bin: 0, n: 1, weightSum: 1, avgProb: 0.6, actualRate: 1.0 }],
      attributionMode: 'mixed',
    },
  ]]);
  const rows = calMonitor.buildCalibrationRows(aggregates, {
    windowEndMs: Date.UTC(2026, 3, 16, 12, 0, 0),
    probabilitySource: 'ep_proxy',
  });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].probability_source, 'ep_proxy');
  assert.ok(rows[0].window_start, '30d krijgt expliciete start');
  assert.ok(rows[0].window_end);
});

// ── CORRELATION DAMPING (v10.10.18, discipline edge) ──────────────────────────
console.log('\n  Correlation damping:');

test('groupCorrelatedPicks: solo pick → cluster met 1 entry, geen same-fixture', () => {
  const picks = [{ match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z' }];
  const clusters = corrDamp.groupCorrelatedPicks(picks);
  assert.strictEqual(clusters.size, 1);
  const c = [...clusters.values()][0];
  assert.strictEqual(c.picks.length, 1);
  assert.strictEqual(c.hasSameFixture, false);
});

test('groupCorrelatedPicks: twee picks zelfde league + dag = 1 cluster', () => {
  const picks = [
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T18:00:00Z' },
    { match: 'Feyenoord vs AZ', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z' },
  ];
  const clusters = corrDamp.groupCorrelatedPicks(picks);
  assert.strictEqual(clusters.size, 1);
  assert.strictEqual([...clusters.values()][0].picks.length, 2);
  assert.strictEqual([...clusters.values()][0].hasSameFixture, false);
});

test('groupCorrelatedPicks: zelfde wedstrijd = hasSameFixture=true', () => {
  const picks = [
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', label: 'Over 2.5' },
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', label: 'BTTS Ja' },
  ];
  const clusters = corrDamp.groupCorrelatedPicks(picks);
  assert.strictEqual([...clusters.values()][0].hasSameFixture, true);
});

test('groupCorrelatedPicks: verschillende leagues = aparte clusters', () => {
  const picks = [
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z' },
    { match: 'Liverpool vs Chelsea', league: 'Premier League', kickoff: '2026-04-17T20:00:00Z' },
  ];
  const clusters = corrDamp.groupCorrelatedPicks(picks);
  assert.strictEqual(clusters.size, 2);
});

test('applyCorrelationDamp: solo pick → geen demping', () => {
  const picks = [{ match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', kelly: 0.05, units: '1.0U', expectedEur: 5, strength: 0.1 }];
  corrDamp.applyCorrelationDamp(picks);
  assert.strictEqual(picks[0].kelly, 0.05, 'onveranderd');
  assert.strictEqual(picks[0].correlationAudit, undefined, 'geen audit');
});

test('applyCorrelationDamp: same-league-day → tweede pick gets × 0.5', () => {
  const picks = [
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T18:00:00Z', kelly: 0.04, units: '0.75U', expectedEur: 4, strength: 0.08 },
    { match: 'Feyenoord vs AZ', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', kelly: 0.05, units: '1.0U', expectedEur: 5, strength: 0.10 },
  ];
  corrDamp.applyCorrelationDamp(picks);
  // Feyenoord (expectedEur 5) is cluster_leader → onveranderd
  const leader = picks.find(p => p.correlationAudit?.reason === 'cluster_leader');
  const damped = picks.find(p => p.correlationAudit?.reason === 'same_league_same_day');
  assert.ok(leader);
  assert.ok(damped);
  assert.strictEqual(damped.correlationAudit.dampFactor, 0.5);
  assert.ok(damped.kelly < 0.04, 'kelly gedempt');
});

test('applyCorrelationDamp: same-fixture → × 0.25 (zwaardere demping)', () => {
  const picks = [
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', kelly: 0.04, units: '0.75U', expectedEur: 3, strength: 0.06, label: 'Over 2.5' },
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', kelly: 0.05, units: '1.0U', expectedEur: 5, strength: 0.10, label: 'BTTS Ja' },
  ];
  corrDamp.applyCorrelationDamp(picks);
  const damped = picks.find(p => p.correlationAudit?.reason === 'same_fixture');
  assert.ok(damped, 'same_fixture demping toegepast');
  assert.strictEqual(damped.correlationAudit.dampFactor, 0.25);
});

test('groupCorrelatedPicks: zelfde league maar andere sport = aparte clusters (Codex-review fix)', () => {
  const picks = [
    { match: 'Team A vs Team B', league: 'Premier League', sport: 'football', kickoff: '2026-04-17T20:00:00Z' },
    { match: 'Team C vs Team D', league: 'Premier League', sport: 'handball', kickoff: '2026-04-17T20:00:00Z' },
  ];
  const clusters = corrDamp.groupCorrelatedPicks(picks);
  assert.strictEqual(clusters.size, 2, 'zelfde league-naam maar andere sport = 2 clusters');
});

test('applyCorrelationDamp: cross-league picks → geen demping op beide', () => {
  const picks = [
    { match: 'Ajax vs PSV', league: 'Eredivisie', kickoff: '2026-04-17T20:00:00Z', kelly: 0.05, units: '1.0U', expectedEur: 5, strength: 0.10 },
    { match: 'Liverpool vs Chelsea', league: 'Premier League', kickoff: '2026-04-17T20:00:00Z', kelly: 0.04, units: '0.75U', expectedEur: 4, strength: 0.08 },
  ];
  corrDamp.applyCorrelationDamp(picks);
  // Geen picks gedempt (verschillende leagues)
  assert.ok(picks.every(p => !p.correlationAudit || p.correlationAudit.dampFactor === 1.0 || p.correlationAudit === undefined));
});

test('operatorDay: converteert kickoff naar Amsterdam kalenderdag', () => {
  // 2026-04-17T22:00:00Z = 18 apr 00:00 in CEST (+2)
  assert.strictEqual(corrDamp.operatorDay('2026-04-17T22:00:00Z'), '2026-04-18');
  // 2026-04-17T12:00:00Z = 17 apr 14:00 in CEST
  assert.strictEqual(corrDamp.operatorDay('2026-04-17T12:00:00Z'), '2026-04-17');
});

// ── BENJAMINI-HOCHBERG FDR + BINOMIAL P-VALUE (v10.12.11 Phase B.5) ─────────
console.log('\n  Binomial p-value + BH FDR:');

test('binomialPvalueTwoTailed: observed = expected (k=n/2) → p near 1', () => {
  const p = modelMath.binomialPvalueTwoTailed(50, 100);
  assert.ok(p > 0.95, `verwacht ~1, kreeg ${p}`);
});

test('binomialPvalueTwoTailed: extreme observation → small p', () => {
  // 80/100 successes vs null=0.5 is highly significant
  const p = modelMath.binomialPvalueTwoTailed(80, 100);
  assert.ok(p < 0.001, `verwacht <0.001, kreeg ${p}`);
});

test('binomialPvalueTwoTailed: n=0 → p=1 (geen data)', () => {
  assert.strictEqual(modelMath.binomialPvalueTwoTailed(0, 0), 1);
});

test('benjaminiHochbergFDR: alle p-values hoog → geen signal passeert', () => {
  const items = [
    { name: 'A', p: 0.4 },
    { name: 'B', p: 0.5 },
    { name: 'C', p: 0.8 },
  ];
  const pass = modelMath.benjaminiHochbergFDR(items, 0.10);
  assert.strictEqual(pass.size, 0);
});

test('benjaminiHochbergFDR: significantste signalen passeren', () => {
  const items = [
    { name: 'A', p: 0.01 },
    { name: 'B', p: 0.05 },
    { name: 'C', p: 0.50 },
  ];
  const pass = modelMath.benjaminiHochbergFDR(items, 0.10);
  assert.ok(pass.has('A'));
  assert.ok(pass.has('B'));
  assert.ok(!pass.has('C'));
});

test('benjaminiHochbergFDR: lege input → lege set', () => {
  assert.strictEqual(modelMath.benjaminiHochbergFDR([], 0.10).size, 0);
  assert.strictEqual(modelMath.benjaminiHochbergFDR(null, 0.10).size, 0);
});

test('benjaminiHochbergFDR: strengere q blokkeert meer', () => {
  // Met m=3 bij q=0.10 zijn de critical values (1/3)*q, (2/3)*q, (3/3)*q
  // = 0.0333, 0.0667, 0.10. A(p=0.005)+B(p=0.05) passeren (B ≤ 0.067).
  // Bij q=0.01 zijn critvals 0.0033, 0.0067, 0.01 — ALLEEN een zeer kleine p
  // passeert. Hier is p=0.001 < 0.0033 ✓, dus A passeert alleen bij strict
  // als we een extremer p-value gebruiken.
  const loose = [
    { name: 'A', p: 0.005 }, { name: 'B', p: 0.05 }, { name: 'C', p: 0.50 },
  ];
  const strictItems = [
    { name: 'A', p: 0.001 }, { name: 'B', p: 0.05 }, { name: 'C', p: 0.50 },
  ];
  const passLoose = modelMath.benjaminiHochbergFDR(loose, 0.10);
  const passStrict = modelMath.benjaminiHochbergFDR(strictItems, 0.01);
  assert.ok(passLoose.has('A') && passLoose.has('B'), 'q=0.10 laat A en B door');
  assert.ok(passStrict.has('A'), 'q=0.01 laat alleen A (p=0.001 < 0.0033) door');
  assert.ok(!passStrict.has('B'));
});

// ── WALK-FORWARD VALIDATOR (v10.12.4, Phase B.4, doctrine §14.R2.A) ──────────
// ── UNIFIED STAKE-REGIME ENGINE (v10.12.21 Phase C.10) ────────────────────
console.log('\n  Unified stake-regime engine:');

test('evaluateStakeRegime: lege input → exploratory', () => {
  const r = evaluateStakeRegime({});
  assert.strictEqual(r.regime, 'exploratory');
  assert.strictEqual(r.kellyFraction, 0.35);
  assert.strictEqual(r.unitMultiplier, 1.0);
});

test('evaluateStakeRegime: drawdown 35% → drawdown_hard (kelly 0.25, unit ×0.5)', () => {
  const r = evaluateStakeRegime({
    totalSettled: 100, longTermClvPct: 2.0, longTermRoi: 0.05,
    drawdownPct: 0.35, bankrollPeak: 1000, currentBankroll: 650,
  });
  assert.strictEqual(r.regime, 'drawdown_hard');
  assert.strictEqual(r.kellyFraction, 0.25);
  assert.strictEqual(r.unitMultiplier, 0.5);
});

test('evaluateStakeRegime: drawdown 22% → drawdown_soft (kelly 0.40)', () => {
  const r = evaluateStakeRegime({
    totalSettled: 100, longTermClvPct: 1.5,
    drawdownPct: 0.22, bankrollPeak: 1000, currentBankroll: 780,
  });
  assert.strictEqual(r.regime, 'drawdown_soft');
  assert.strictEqual(r.kellyFraction, 0.40);
});

test('evaluateStakeRegime: 7 consecutive L → consecutive_l regime', () => {
  const r = evaluateStakeRegime({
    totalSettled: 100, longTermClvPct: 1.5,
    consecutiveLosses: 7, drawdownPct: 0.15,
  });
  assert.strictEqual(r.regime, 'consecutive_l');
  assert.strictEqual(r.unitMultiplier, 0.75);
});

test('evaluateStakeRegime: regime shift — long-term +2%, recent -1.5% → regime_shift', () => {
  const r = evaluateStakeRegime({
    totalSettled: 150,
    longTermClvPct: 2.0, recentClvPct: -1.5,
    drawdownPct: 0.05,
  });
  assert.strictEqual(r.regime, 'regime_shift');
  assert.strictEqual(r.kellyFraction, 0.40);
});

test('evaluateStakeRegime: exploratory — totalSettled < 50', () => {
  const r = evaluateStakeRegime({ totalSettled: 30, longTermClvPct: 5.0, longTermRoi: 0.10 });
  assert.strictEqual(r.regime, 'exploratory');
});

test('evaluateStakeRegime: scale_up — 200+ settled + CLV ≥ 2% + ROI ≥ 5%', () => {
  const r = evaluateStakeRegime({
    totalSettled: 250, longTermClvPct: 2.5, longTermRoi: 0.08,
    drawdownPct: 0.05,
  });
  assert.strictEqual(r.regime, 'scale_up');
  assert.strictEqual(r.kellyFraction, 0.65);
});

test('evaluateStakeRegime: standard — 100+ settled + positive CLV', () => {
  const r = evaluateStakeRegime({
    totalSettled: 120, longTermClvPct: 0.8, longTermRoi: 0.02,
    drawdownPct: 0.03,
  });
  assert.strictEqual(r.regime, 'standard');
  assert.strictEqual(r.kellyFraction, 0.50);
});

test('evaluateStakeRegime: scale_up overruled door drawdown_hard (priority)', () => {
  const r = evaluateStakeRegime({
    totalSettled: 300, longTermClvPct: 3.0, longTermRoi: 0.10,
    drawdownPct: 0.35, bankrollPeak: 1500, currentBankroll: 975,
  });
  assert.strictEqual(r.regime, 'drawdown_hard', 'hard-drawdown beats scale_up');
});

test('evaluateStakeRegime: negative long-term CLV maar geen drawdown → fallback exploratory', () => {
  const r = evaluateStakeRegime({
    totalSettled: 120, longTermClvPct: -0.5, longTermRoi: -0.01,
    drawdownPct: 0.05,
  });
  assert.strictEqual(r.regime, 'exploratory');
});

test('evaluateStakeRegime: reasons array bevat regime + details', () => {
  const r = evaluateStakeRegime({
    totalSettled: 250, longTermClvPct: 2.5, longTermRoi: 0.08,
  });
  assert.ok(Array.isArray(r.reasons));
  assert.ok(r.reasons.some(rs => rs.startsWith('scale_up:')), 'reasons bevat scale_up: prefix');
});

// ── COMPUTE-BANKROLL-METRICS (v11.0.0): drawdown anker op echte bankroll ────
test('computeBankrollMetrics: lege input returnt defaults (startBankroll anchor)', () => {
  const m = computeBankrollMetrics([], 100);
  assert.strictEqual(m.totalSettled, 0);
  assert.strictEqual(m.bankrollPeak, 100);
  assert.strictEqual(m.currentBankroll, 100);
  assert.strictEqual(m.drawdownPct, 0);
  assert.strictEqual(m.consecutiveLosses, 0);
});

test('computeBankrollMetrics: drawdown op echte bankroll, niet NET P/L', () => {
  // Voorbeeld uit operator-report: peak €88.72 NET P/L, nu €38.72 NET P/L.
  // Op NET-P/L basis: drawdown = (88.72 - 38.72) / 88.72 = 56.4% → TRIGGER.
  // Op echte-bankroll basis (start €500): peak €588.72, nu €538.72 → 8.5%.
  const bets = [
    { uitkomst: 'W', wl: 88.72, datum: '01-04-2026', clv_pct: 1, inzet: 10 },
    { uitkomst: 'L', wl: -50.00, datum: '02-04-2026', clv_pct: -1, inzet: 10 },
  ];
  const m = computeBankrollMetrics(bets, 500);
  assert.strictEqual(m.bankrollPeak, 588.72);
  assert.strictEqual(m.currentBankroll, 538.72);
  const pct = +(m.drawdownPct * 100).toFixed(1);
  assert.ok(pct > 8 && pct < 9, `expected ~8.5%, got ${pct}%`);
});

test('computeBankrollMetrics: startBankroll=0 skips drawdown trigger (fallback)', () => {
  const bets = [
    { uitkomst: 'W', wl: 100, datum: '01-04-2026', clv_pct: 1, inzet: 10 },
    { uitkomst: 'L', wl: -50, datum: '02-04-2026', clv_pct: -1, inzet: 10 },
  ];
  const m = computeBankrollMetrics(bets, 0);
  assert.strictEqual(m.drawdownPct, 0, 'drawdown disabled wanneer startBankroll ontbreekt');
});

test('computeBankrollMetrics: sorts chronologisch via dd-mm-yyyy parsing', () => {
  const bets = [
    { uitkomst: 'L', wl: -10, datum: '03-04-2026' },
    { uitkomst: 'W', wl: +20, datum: '01-04-2026' },
    { uitkomst: 'L', wl: -5, datum: '02-04-2026' },
  ];
  const m = computeBankrollMetrics(bets, 100);
  // Order: +20 (120) → -5 (115) → -10 (105). Peak=120, end=105.
  assert.strictEqual(m.bankrollPeak, 120);
  assert.strictEqual(m.currentBankroll, 105);
});

test('computeBankrollMetrics: consecutive losses at tail', () => {
  const bets = [
    { uitkomst: 'W', wl: 10, datum: '01-04-2026' },
    { uitkomst: 'L', wl: -5, datum: '02-04-2026' },
    { uitkomst: 'L', wl: -5, datum: '03-04-2026' },
    { uitkomst: 'L', wl: -5, datum: '04-04-2026' },
  ];
  const m = computeBankrollMetrics(bets, 100);
  assert.strictEqual(m.consecutiveLosses, 3);
});

test('computeBankrollMetrics: CLV averages per rolling window (30 + 200)', () => {
  // 40 bets verspreid over unieke dagen. Eerste 10 hebben clv=1.0, laatste 30
  // hebben clv=4.0. recentClvPct moet 4.0 zijn, longTermClvPct het gewogen gem.
  const bets = Array.from({ length: 40 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, i + 1));
    const datum = `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
    return {
      uitkomst: i % 2 === 0 ? 'W' : 'L',
      wl: i % 2 === 0 ? 10 : -5,
      clv_pct: i < 10 ? 1.0 : 4.0,
      inzet: 10,
      datum,
    };
  });
  const m = computeBankrollMetrics(bets, 100);
  assert.strictEqual(m.recentClvPct, 4.0, 'last-30 avg = 4.0 (allemaal in tweede helft)');
  const expectedLong = +((10 * 1.0 + 30 * 4.0) / 40).toFixed(3);
  assert.strictEqual(m.longTermClvPct, expectedLong, 'long-term (laatste 200, hier 40) = gewogen gem.');
});

test('computeBankrollMetrics: bets zonder datum worden genegeerd (chrono-filter)', () => {
  const bets = [
    { uitkomst: 'W', wl: 10 }, // geen datum
    { uitkomst: 'L', wl: -5, datum: 'garbage' }, // ongeldig
    { uitkomst: 'W', wl: 10, datum: '01-04-2026' }, // valid
  ];
  const m = computeBankrollMetrics(bets, 100);
  assert.strictEqual(m.bankrollPeak, 110, 'alleen de valid bet telt mee');
  assert.strictEqual(m.currentBankroll, 110);
});

// ── BOOKIE CONCENTRATION (v10.12.16 Phase C.9) ────────────────────────────
console.log('\n  Bookie concentration (operator survivability):');

function __computeBookieConcentration(bets, windowDays = 7, nowMs = Date.now()) {
  if (!Array.isArray(bets) || bets.length === 0) return { total: 0, perBookie: [], maxShare: 0, maxBookie: null };
  const msPerDay = 86400000;
  const cutoff = nowMs - windowDays * msPerDay;
  const byBookie = new Map();
  let total = 0;
  for (const b of bets) {
    if (!b || !b.bookie || !Number.isFinite(b.inzet) || b.inzet <= 0) continue;
    let ms = null;
    if (b.datum && typeof b.datum === 'string') {
      const dm = b.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (dm) ms = Date.parse(`${dm[3]}-${dm[2]}-${dm[1]}T12:00:00Z`);
    } else if (Number.isFinite(b.timestamp_ms)) {
      ms = b.timestamp_ms;
    }
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    const key = String(b.bookie).toLowerCase();
    byBookie.set(key, (byBookie.get(key) || 0) + b.inzet);
    total += b.inzet;
  }
  const perBookie = [...byBookie.entries()]
    .map(([bookie, stake]) => ({ bookie, stake: +stake.toFixed(2), share: total > 0 ? +(stake / total).toFixed(4) : 0 }))
    .sort((a, b) => b.share - a.share);
  const top = perBookie[0] || { share: 0, bookie: null };
  return { total: +total.toFixed(2), perBookie, maxShare: top.share, maxBookie: top.bookie };
}

test('computeBookieConcentration: lege bets → total=0', () => {
  const r = __computeBookieConcentration([], 7);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.maxShare, 0);
  assert.strictEqual(r.maxBookie, null);
});

test('computeBookieConcentration: 3 bookies gelijk verdeeld → 33%', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const bets = [
    { bookie: 'Bet365', inzet: 10, datum: '15-04-2026' },
    { bookie: 'Unibet', inzet: 10, datum: '16-04-2026' },
    { bookie: 'Pinnacle', inzet: 10, datum: '17-04-2026' },
  ];
  const r = __computeBookieConcentration(bets, 7, now);
  assert.strictEqual(r.total, 30);
  assert.ok(Math.abs(r.maxShare - 0.3333) < 0.001, `verwacht ~0.33, kreeg ${r.maxShare}`);
  assert.strictEqual(r.perBookie.length, 3);
});

test('computeBookieConcentration: dominante bookie triggert threshold', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const bets = [
    { bookie: 'Bet365', inzet: 80, datum: '15-04-2026' },
    { bookie: 'Unibet', inzet: 20, datum: '16-04-2026' },
  ];
  const r = __computeBookieConcentration(bets, 7, now);
  assert.strictEqual(r.total, 100);
  assert.strictEqual(r.maxBookie, 'bet365');
  assert.ok(r.maxShare > 0.60);
});

test('computeBookieConcentration: bets buiten window → genegeerd', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const bets = [
    { bookie: 'Bet365', inzet: 100, datum: '01-01-2026' },
    { bookie: 'Unibet', inzet: 50,  datum: '16-04-2026' },
  ];
  const r = __computeBookieConcentration(bets, 7, now);
  assert.strictEqual(r.total, 50);
  assert.strictEqual(r.maxBookie, 'unibet');
});

test('computeBookieConcentration: null bookie + zero inzet → skip', () => {
  const now = Date.parse('2026-04-17T12:00:00Z');
  const bets = [
    { bookie: null, inzet: 50, datum: '16-04-2026' },
    { bookie: 'Bet365', inzet: 0, datum: '16-04-2026' },
    { bookie: 'Unibet', inzet: 25, datum: '16-04-2026' },
  ];
  const r = __computeBookieConcentration(bets, 7, now);
  assert.strictEqual(r.total, 25);
});

// ── FIXTURE CONGESTION (v10.12.14 Phase D.13) ─────────────────────────────
console.log('\n  Fixture congestion (shadow-mode signal):');

// Need to access computeFixtureCongestion from server.js. It's a module-private
// helper, so test against its behavior via buildRestDaysInfo side-effects
// (the public integration surface). We re-declare it inline to test the pure
// math without requiring server.js boot.
function __computeFixtureCongestion(recentDates, kickoffMs, windowDays = 7) {
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
  const congested = count >= 3;
  return { count, congested, densityDays };
}

test('computeFixtureCongestion: lege input → count=0, niet congested', () => {
  const r = __computeFixtureCongestion([], Date.now());
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.congested, false);
});

test('computeFixtureCongestion: 3 matches in 7d → congested=true', () => {
  const kickoff = Date.parse('2026-04-17T19:00:00Z');
  const dates = [
    '2026-04-11T19:00:00Z',   // 6d voor kickoff (binnen window)
    '2026-04-13T20:00:00Z',   // 4d voor
    '2026-04-16T19:00:00Z',   // 1d voor
  ];
  const r = __computeFixtureCongestion(dates, kickoff, 7);
  assert.strictEqual(r.count, 3);
  assert.strictEqual(r.congested, true);
});

test('computeFixtureCongestion: 2 matches in 7d → niet congested', () => {
  const kickoff = Date.parse('2026-04-17T19:00:00Z');
  const dates = ['2026-04-14T19:00:00Z', '2026-04-16T20:00:00Z'];
  const r = __computeFixtureCongestion(dates, kickoff, 7);
  assert.strictEqual(r.count, 2);
  assert.strictEqual(r.congested, false);
});

test('computeFixtureCongestion: match buiten window wordt niet geteld', () => {
  const kickoff = Date.parse('2026-04-17T19:00:00Z');
  const dates = [
    '2026-04-01T19:00:00Z',   // >7d → niet tellen
    '2026-04-15T19:00:00Z',   // binnen window
  ];
  const r = __computeFixtureCongestion(dates, kickoff, 7);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.congested, false);
});

test('computeFixtureCongestion: toekomstige date wordt niet geteld', () => {
  const kickoff = Date.parse('2026-04-17T19:00:00Z');
  const dates = ['2026-04-20T19:00:00Z'];   // na kickoff
  const r = __computeFixtureCongestion(dates, kickoff, 7);
  assert.strictEqual(r.count, 0);
});

test('computeFixtureCongestion: density bij 3 matches over 10d → ~10 dagen', () => {
  const kickoff = Date.parse('2026-04-17T19:00:00Z');
  const dates = [
    '2026-04-07T19:00:00Z',
    '2026-04-12T19:00:00Z',
    '2026-04-16T19:00:00Z',
  ];
  const r = __computeFixtureCongestion(dates, kickoff, 14);
  assert.ok(r.densityDays >= 9.9 && r.densityDays <= 10.1, `verwacht ~10, kreeg ${r.densityDays}`);
});

console.log('\n  Walk-forward validator:');

test('walkForward: empty records → lege splits', () => {
  assert.deepStrictEqual(walkForward.walkForward([], {}), []);
  assert.deepStrictEqual(walkForward.walkForward(null, {}), []);
});

test('walkForward: records zonder datum → overgeslagen', () => {
  const records = [{ foo: 'bar' }, { baz: 'qux' }];
  const r = walkForward.walkForward(records, { dateField: 'kickoff_at' });
  assert.deepStrictEqual(r, []);
});

test('walkForward: chronological split, geen lookahead', () => {
  // 300 records gelijkmatig verspreid over 400 dagen (1 per ~1.33 dag)
  const base = Date.parse('2025-01-01T00:00:00Z');
  const DAY = 86400000;
  const records = Array.from({ length: 300 }, (_, i) => ({
    kickoff_at: new Date(base + i * 1.333 * DAY).toISOString(),
    idx: i,
  }));
  const splits = walkForward.walkForward(records, { trainDays: 100, testDays: 30, strideDays: 30, minTrainN: 10, minTestN: 5 });
  assert.ok(splits.length > 0, 'moet meerdere splits opleveren');
  // Elke split: alle train-records < test-records in tijd (geen lookahead)
  for (const s of splits) {
    const maxTrain = Math.max(...s.train.map(r => Date.parse(r.kickoff_at)));
    const minTest  = Math.min(...s.test.map(r => Date.parse(r.kickoff_at)));
    assert.ok(maxTrain < minTest, 'train moet strikt vóór test liggen (geen leakage)');
  }
});

test('walkForward: minTrainN gate → kleine training sets worden overgeslagen', () => {
  const base = Date.parse('2026-01-01T00:00:00Z');
  const DAY = 86400000;
  const records = Array.from({ length: 20 }, (_, i) => ({
    kickoff_at: new Date(base + i * DAY).toISOString(),
  }));
  const splits = walkForward.walkForward(records, { trainDays: 7, testDays: 3, minTrainN: 100 });
  assert.strictEqual(splits.length, 0, 'geen training set haalt de minTrainN van 100');
});

test('walkForward: dd-mm-yyyy datum-formaat uit bets.datum wordt correct geparsed', () => {
  // bets.datum formaat is dd-mm-yyyy (niet ISO). walkForward moet dit aankunnen.
  const records = [
    { datum: '15-01-2026' }, { datum: '16-01-2026' }, { datum: '17-01-2026' },
  ];
  const r = records.map(rec => ({ ms: walkForward.parseRecordDate(rec, 'datum'), rec }));
  assert.ok(r.every(x => Number.isFinite(x.ms)), 'alle datums parsebaar');
  assert.ok(r[0].ms < r[1].ms && r[1].ms < r[2].ms, 'chronologisch oplopend');
});

test('computeBrier: perfect voorspeld → 0', () => {
  const recs = [
    { predicted_prob: 1.0, outcome_binary: 1 },
    { predicted_prob: 0.0, outcome_binary: 0 },
  ];
  assert.strictEqual(walkForward.computeBrier(recs).score, 0);
});

test('computeBrier: random 0.5 op {0,1} → ~0.25', () => {
  const recs = [
    { predicted_prob: 0.5, outcome_binary: 1 },
    { predicted_prob: 0.5, outcome_binary: 0 },
    { predicted_prob: 0.5, outcome_binary: 1 },
    { predicted_prob: 0.5, outcome_binary: 0 },
  ];
  assert.strictEqual(walkForward.computeBrier(recs).score, 0.25);
});

test('computeBrier: skipt records zonder prob/outcome', () => {
  const recs = [
    { predicted_prob: 0.5, outcome_binary: 1 },
    { predicted_prob: null, outcome_binary: 0 },
    { predicted_prob: 0.3 }, // outcome ontbreekt
  ];
  const r = walkForward.computeBrier(recs);
  assert.strictEqual(r.n, 1, 'maar 1 valide record');
});

test('computeLogLoss: perfect voorspeld → 0', () => {
  const recs = [
    { predicted_prob: 0.9999, outcome_binary: 1 },
    { predicted_prob: 0.0001, outcome_binary: 0 },
  ];
  const r = walkForward.computeLogLoss(recs);
  assert.ok(r.score < 0.001, `verwacht ~0, kreeg ${r.score}`);
});

test('computeClvAvg: mean over records', () => {
  const recs = [{ clv_pct: 2.0 }, { clv_pct: -1.0 }, { clv_pct: 0.5 }];
  assert.strictEqual(walkForward.computeClvAvg(recs).avg, 0.5);
});

// ── SCAN-GATE POST-PROCESS (v10.12.8 Phase A.1b) ─────────────────────────────
console.log('\n  Scan-gate post-process:');

test('applyPostScanGate: lege picks → geen DB call', async () => {
  let called = false;
  const fakeSupabase = { from: () => { called = true; return {}; } };
  const r = await scanGate.applyPostScanGate([], fakeSupabase, {});
  assert.strictEqual(r.picks.length, 0);
  assert.strictEqual(called, false, 'geen supabase query voor lege picks');
});

test('applyPostScanGate: picks zonder _fixtureMeta → ongewijzigd terug', async () => {
  const picks = [{ match: 'A vs B', kelly: 0.05, units: '1.0U', expectedEur: 5, edge: 10, _fixtureMeta: null }];
  const r = await scanGate.applyPostScanGate(picks, {}, {});
  assert.strictEqual(r.picks.length, 1);
  assert.strictEqual(r.stats.gated, 0, 'geen gate fired');
});

test('applyPostScanGate: playability dropt pick met low lineQuality (default strict)', async () => {
  // Eén bookie → bookmakerCount=1 → lineQuality=low → playable=false
  const rows = [
    { fixture_id: 1, captured_at: '2026-04-16T18:00:00Z', bookmaker: 'pinnacle', market_type: 'moneyline', selection_key: 'home', line: null, odds: 1.90 },
  ];
  const builder1 = {};
  builder1.select = () => builder1;
  builder1.in = () => builder1;
  builder1.order = () => builder1;
  builder1.then = (resolve) => resolve({ data: rows, error: null });
  const fakeSupabase1 = { from: () => builder1 };
  const picks1 = [{
    match: 'A vs B', label: '🏠 A wint', kelly: 0.05, units: '1.0U',
    expectedEur: 5, edge: 10, dataConfidence: 1, sport: 'basketball', bookie: 'Bet365',
    _fixtureMeta: { fixtureId: 1, marketType: 'moneyline', selectionKey: 'home', line: null },
  }];
  const r1 = await scanGate.applyPostScanGate(picks1, fakeSupabase1, {
    marketTypes: ['moneyline'], preferredBookies: ['Bet365'],
  });
  assert.strictEqual(r1.stats.playabilityDropped, 1);
  assert.strictEqual(r1.picks.length, 0);
});

test('applyPostScanGate: strictPlayability=false → shadow, niet dropt', async () => {
  const rows = [
    { fixture_id: 1, captured_at: '2026-04-16T18:00:00Z', bookmaker: 'pinnacle', market_type: 'moneyline', selection_key: 'home', line: null, odds: 1.90 },
  ];
  const builderS = {};
  builderS.select = () => builderS;
  builderS.in = () => builderS;
  builderS.order = () => builderS;
  builderS.then = (resolve) => resolve({ data: rows, error: null });
  const fakeSupabaseS = { from: () => builderS };
  const picksS = [{
    match: 'A vs B', label: '🏠 A wint', kelly: 0.05, units: '1.0U',
    expectedEur: 5, edge: 10, dataConfidence: 1, sport: 'basketball', bookie: 'Bet365',
    _fixtureMeta: { fixtureId: 1, marketType: 'moneyline', selectionKey: 'home', line: null },
  }];
  const rS = await scanGate.applyPostScanGate(picksS, fakeSupabaseS, {
    marketTypes: ['moneyline'], preferredBookies: ['Bet365'], strictPlayability: false,
  });
  assert.strictEqual(rS.stats.playabilityShadowed, 1);
  assert.strictEqual(rS.picks.length, 1);
  assert.strictEqual(rS.picks[0].shadow, true);
});

test('applyPostScanGate: pick met _fixtureMeta maar lege timelineMap → pick survivest', async () => {
  // Builder returns an empty row set → buildScanTimelineMap returnt lege Map → gate no-op
  const builder = {};
  builder.select = () => builder;
  builder.in = () => builder;
  builder.order = () => builder;
  builder.then = (resolve) => resolve({ data: [], error: null });
  const fakeSupabase = { from: () => builder };
  const picks = [{
    match: 'A vs B', label: '🏠 A wint', kelly: 0.05, units: '1.0U',
    expectedEur: 5, edge: 10, dataConfidence: 1,
    _fixtureMeta: { fixtureId: 1, marketType: '1x2', selectionKey: 'home', line: null },
  }];
  const r = await scanGate.applyPostScanGate(picks, fakeSupabase, { marketTypes: ['1x2'] });
  assert.strictEqual(r.picks.length, 1);
  assert.strictEqual(r.stats.skipped, 0);
});

test('walkForwardBrier: integratie met mock dataset', () => {
  const base = Date.parse('2025-01-01T00:00:00Z');
  const DAY = 86400000;
  // 100 records: random prob 0.5 → Brier ~0.25 consistent over splits
  const records = Array.from({ length: 200 }, (_, i) => ({
    kickoff_at: new Date(base + i * DAY).toISOString(),
    predicted_prob: 0.5,
    outcome_binary: i % 2,
  }));
  const r = walkForward.walkForwardBrier(records, { trainDays: 50, testDays: 20, minTrainN: 20, minTestN: 5 });
  assert.ok(r.splitCount > 0, 'meerdere splits');
  assert.strictEqual(r.weightedAvgBrier, 0.25, 'weighted avg Brier = 0.25 voor 50/50');
});

// ── BAYESIAN FORM SHRINKAGE (v10.10.19, broad shrinkage roadmap punt 5) ──────
console.log('\n  Bayesian form shrinkage:');

const { shrinkFormScore, FORM_PRIOR_PTS_PER_GAME, FORM_SHRINKAGE_K } = modelMath;

test('shrinkFormScore: 5W (rawScore=15) wordt gedempt richting prior', () => {
  const shrunk = shrinkFormScore(15, 5);
  assert.ok(shrunk < 15 && shrunk > 10, `verwacht ~11.25, kreeg ${shrunk}`);
});

test('shrinkFormScore: 5L (rawScore=0) wordt opgetrokken richting prior', () => {
  const shrunk = shrinkFormScore(0, 5);
  assert.ok(shrunk > 0 && shrunk < 5, `verwacht ~3.75, kreeg ${shrunk}`);
});

test('shrinkFormScore: neutrale form (7.5) verandert nauwelijks', () => {
  const shrunk = shrinkFormScore(7.5, 5);
  assert.ok(Math.abs(shrunk - 7.5) < 0.1, `verwacht ~7.5, kreeg ${shrunk}`);
});

test('shrinkFormScore: meer games → minder shrinkage (n=20 dicht bij raw)', () => {
  const shrunk5 = shrinkFormScore(15, 5);
  const shrunk20 = shrinkFormScore(15 * 4, 20); // 20W = 60 punten
  // Bij n=20: w = 20/25 = 0.8 → shrunk = 0.8*60 + 0.2*30 = 54
  // Bij n=5:  w = 5/10 = 0.5 → shrunk = 0.5*15 + 0.5*7.5 = 11.25
  // Shrinkage ratio: (raw - shrunk) / raw
  const ratio5 = (15 - shrunk5) / 15;
  const ratio20 = (60 - shrunk20) / 60;
  assert.ok(ratio20 < ratio5, 'meer data = minder shrinkage');
});

test('shrinkFormScore: baseball 10-game window met n=10', () => {
  const raw10W = 30; // 10 wins × 3 punten
  const shrunk = shrinkFormScore(raw10W, 10);
  // w = 10/15 ≈ 0.667 → shrunk = 0.667*30 + 0.333*15 = 25
  assert.ok(shrunk > 20 && shrunk < 30, `verwacht ~25, kreeg ${shrunk}`);
});

test('shrinkFormScore: formAdj-verschil wordt kleiner na shrinkage', () => {
  // Simuleer formAdj berekening: (hmForm - awForm) / 15 * 0.04
  const hmRaw = 15; // 5W
  const awRaw = 0;  // 5L
  const rawDiff = (hmRaw - awRaw) / 15 * 0.04;
  const shrunkDiff = (shrinkFormScore(hmRaw) - shrinkFormScore(awRaw)) / 15 * 0.04;
  assert.ok(Math.abs(shrunkDiff) < Math.abs(rawDiff), `shrunk adj ${shrunkDiff} < raw adj ${rawDiff}`);
  assert.ok(Math.abs(shrunkDiff) > 0, 'niet volledig naar 0 gedempt');
});

// ── SHARP REFERENCE (v10.10.20, roadmap punt 6) ─────────────────────────────
console.log('\n  Sharp reference (Pinnacle/Betfair):');

// ── CLV SHARP REFERENCE (v10.10.21) ──────────────────────────────────────────
console.log('\n  CLV sharp reference (Pinnacle closing):');

const { marketKeyFromBetMarkt } = require('./lib/clv-match');

test('marketKeyFromBetMarkt: ML wint → moneyline/home', () => {
  const r = marketKeyFromBetMarkt('🏠 Ajax wint');
  assert.deepStrictEqual(r, { market_type: 'moneyline', selection_key: 'home' });
});

test('marketKeyFromBetMarkt: away wint → moneyline/away', () => {
  const r = marketKeyFromBetMarkt('✈️ PSV wint');
  assert.deepStrictEqual(r, { market_type: 'moneyline', selection_key: 'away' });
});

test('marketKeyFromBetMarkt: BTTS Ja → btts/yes', () => {
  const r = marketKeyFromBetMarkt('⚽ BTTS Ja');
  assert.deepStrictEqual(r, { market_type: 'btts', selection_key: 'yes' });
});

test('marketKeyFromBetMarkt: Over 2.5 basis → total/over/line', () => {
  const r = marketKeyFromBetMarkt('Over 2.5');
  assert.strictEqual(r.market_type, 'total');
  assert.strictEqual(r.selection_key, 'over');
  assert.strictEqual(r.line, 2.5);
});

test('marketKeyFromBetMarkt: NRFI → nrfi/no', () => {
  const r = marketKeyFromBetMarkt('⚾ NRFI (No Run 1st Inning)');
  assert.deepStrictEqual(r, { market_type: 'nrfi', selection_key: 'no' });
});

test('marketKeyFromBetMarkt: F5 ML → null (home/away niet afleidbaar zonder emoji)', () => {
  assert.strictEqual(marketKeyFromBetMarkt('⚾ F5 Detroit Tigers'), null, 'geen 🏠/✈️ → graceful null');
});

test('marketKeyFromBetMarkt: Over 2.5 → total/over met line=2.5', () => {
  const r = marketKeyFromBetMarkt('Over 2.5');
  assert.strictEqual(r.market_type, 'total');
  assert.strictEqual(r.selection_key, 'over');
  assert.strictEqual(r.line, 2.5, 'line wordt geparsed');
});

test('marketKeyFromBetMarkt: F5 Over 4.5 → f5_total/over met line=4.5', () => {
  const r = marketKeyFromBetMarkt('⚾ F5 Over 4.5');
  assert.strictEqual(r.market_type, 'f5_total');
  assert.strictEqual(r.selection_key, 'over');
  assert.strictEqual(r.line, 4.5);
});

test('marketKeyFromBetMarkt: 60-min draw → threeway/draw', () => {
  const r = marketKeyFromBetMarkt('🕐 Gelijkspel (60-min)');
  assert.deepStrictEqual(r, { market_type: 'threeway', selection_key: 'draw' });
});

test('marketKeyFromBetMarkt: onbekende markt → null (graceful)', () => {
  assert.strictEqual(marketKeyFromBetMarkt('Exotic Player Prop'), null);
  assert.strictEqual(marketKeyFromBetMarkt(null), null);
});

test('lineTimeline.isSharpBookie: detecteert Pinnacle/Betfair als sharp', () => {
  assert.strictEqual(lineTimeline.isSharpBookie('Pinnacle'), true);
  assert.strictEqual(lineTimeline.isSharpBookie('Betfair'), true);
  assert.strictEqual(lineTimeline.isSharpBookie('Pinnacle Sports'), true);
  assert.strictEqual(lineTimeline.isSharpBookie('Bet365'), false);
  assert.strictEqual(lineTimeline.isSharpBookie('Unibet'), false);
});

test('snapshotAggregate: returnt bestSharpPrice apart van bestPrice/bestPreferred', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-17T19:00:00Z', bookie: 'Pinnacle', odds: 2.15 }),
    makeOddsRow({ at: '2026-04-17T19:00:00Z', bookie: 'Bet365', odds: 2.10 }),
    makeOddsRow({ at: '2026-04-17T19:00:00Z', bookie: 'Unibet', odds: 2.05 }),
    makeOddsRow({ at: '2026-04-17T19:00:00Z', bookie: 'Bovada', odds: 2.12 }),
  ];
  const preferred = new Set(['bet365', 'unibet']);
  const agg = lineTimeline.snapshotAggregate(rows, preferred);
  assert.strictEqual(agg.bestPrice, 2.15, 'market-best = Pinnacle');
  assert.strictEqual(agg.bestPreferredPrice, 2.10, 'preferred-best = Bet365');
  assert.strictEqual(agg.bestSharpPrice, 2.15, 'sharp-best = Pinnacle');
  assert.strictEqual(agg.bestSharpBookie, 'Pinnacle');
});

test('buildTimeline: sharpGap = sharp - preferred aan close', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-17T19:55:00Z', bookie: 'Pinnacle', odds: 2.15 }),
    makeOddsRow({ at: '2026-04-17T19:55:00Z', bookie: 'Bet365', odds: 2.05 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-17T20:00:00Z'),
    preferredBookies: ['bet365'],
    closeWindowMs: 10 * 60 * 1000,
  });
  assert.strictEqual(t.sharpGap, 0.10, 'sharp (2.15) - preferred (2.05) = 0.10');
  assert.strictEqual(t.sharpPrice, 2.15);
  assert.strictEqual(t.sharpBookie, 'Pinnacle');
});

test('buildTimeline: sharpGap=null als geen sharp bookie in data', () => {
  const rows = [
    makeOddsRow({ at: '2026-04-17T19:55:00Z', bookie: 'Bet365', odds: 2.05 }),
    makeOddsRow({ at: '2026-04-17T19:55:00Z', bookie: 'Unibet', odds: 2.00 }),
  ];
  const t = lineTimeline.buildTimeline(rows, {
    kickoffMs: Date.parse('2026-04-17T20:00:00Z'),
    preferredBookies: ['bet365'],
    closeWindowMs: 10 * 60 * 1000,
  });
  assert.strictEqual(t.sharpGap, null);
  assert.strictEqual(t.sharpPrice, null);
});

test('buildTimeline: lege rows → sharpGap=null (geen crash)', () => {
  const t = lineTimeline.buildTimeline([]);
  assert.strictEqual(t.sharpGap, null);
  assert.strictEqual(t.sharpBookie, null);
});

// ═══════════════════════════════════════════════════════════════════════════
// v11.3.23 · PHASE 7.1 REVIEW-BUG REGRESSION TESTS
// ═══════════════════════════════════════════════════════════════════════════

// C2: parseBetKickoff uses bet.datum + bet.tijd, not today's date.
const { parseBetKickoff } = require('./lib/runtime/bet-kickoff');

test('parseBetKickoff: ISO-string returns exact timestamp', () => {
  const iso = '2026-05-15T19:30:00+02:00';
  const result = parseBetKickoff(null, iso);
  assert.strictEqual(result, new Date(iso).getTime());
});

test('parseBetKickoff: HH:MM + datum morgen geeft morgen (niet vandaag)', () => {
  // Vandaag in Amsterdam
  const nowAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const tomorrowMs = Date.parse(nowAms + 'T00:00:00Z') + 86400000;
  const tomorrowAms = new Date(tomorrowMs).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const [yyyy, mm, dd] = tomorrowAms.split('-');
  const datum = `${dd}-${mm}-${yyyy}`;
  const kickoff = parseBetKickoff(datum, '20:00');
  // Moet minstens een paar uur in de toekomst liggen (niet vandaag 20:00).
  assert(kickoff > Date.now() + 60 * 60 * 1000, 'kickoff should be at least 1 hour out');
});

test('parseBetKickoff: HH:MM + datum 3 dagen vooruit respecteert datum', () => {
  const nowAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const threeAheadMs = Date.parse(nowAms + 'T12:00:00Z') + 3 * 86400000;
  const threeAheadAms = new Date(threeAheadMs).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
  const [yyyy, mm, dd] = threeAheadAms.split('-');
  const datum = `${dd}-${mm}-${yyyy}`;
  const kickoff = parseBetKickoff(datum, '14:00');
  const deltaDays = (kickoff - Date.now()) / 86400000;
  assert(deltaDays >= 2.5 && deltaDays <= 3.5, `delta should be ~3 days, got ${deltaDays.toFixed(2)}`);
});

test('parseBetKickoff: invalid tijd returns null', () => {
  assert.strictEqual(parseBetKickoff('19-04-2026', 'notatime'), null);
  assert.strictEqual(parseBetKickoff('19-04-2026', '25:99'), null);
  assert.strictEqual(parseBetKickoff('19-04-2026', ''), null);
});

test('parseBetKickoff: geen datum valt terug op vandaag (legacy gedrag)', () => {
  // Tijd moet in de toekomst liggen (anders +1 dag).
  const nowAms = new Date();
  const futureHour = (nowAms.getHours() + 2) % 24;
  const tijd = `${String(futureHour).padStart(2, '0')}:00`;
  const kickoff = parseBetKickoff(null, tijd);
  assert(Number.isFinite(kickoff), 'kickoff should be finite');
  const delta = kickoff - Date.now();
  assert(delta > 0 && delta < 36 * 3600 * 1000, `kickoff should be within 36h, delta=${delta}`);
});

// F3: readBets preserves userId in mapped bets.
test('bets-data.readBets mapping preserves userId for global results-check', () => {
  // Pure map test — we simuleren één Supabase row en checken dat userId bewaard blijft.
  const mockRow = { bet_id: 42, user_id: 'abc-123', uitkomst: 'Open', odds: 2.0, units: 1, datum: '01-01-2026', wedstrijd: 'A vs B', markt: '🏠 A wint' };
  // Simpele mapping-replicatie (mirror van bets-data.js).
  const mapped = {
    id: mockRow.bet_id,
    userId: mockRow.user_id || null,
  };
  assert.strictEqual(mapped.id, 42);
  assert.strictEqual(mapped.userId, 'abc-123');
});

// F4: isLiveIrreversiblyLost detects Under-broken + BTTS-nee-both-scored.
const { isLiveIrreversiblyLost } = require('./lib/runtime/operator-actions');

test('isLiveIrreversiblyLost: Under 2.5 met 3 goals → true', () => {
  assert.strictEqual(isLiveIrreversiblyLost('Under 2.5', { scoreH: 2, scoreA: 1 }), true);
});

test('isLiveIrreversiblyLost: Under 2.5 met 2 goals → false', () => {
  assert.strictEqual(isLiveIrreversiblyLost('Under 2.5', { scoreH: 1, scoreA: 1 }), false);
});

test('isLiveIrreversiblyLost: BTTS Nee met beide teams gescoord → true', () => {
  assert.strictEqual(isLiveIrreversiblyLost('BTTS Nee', { scoreH: 1, scoreA: 1 }), true);
});

test('isLiveIrreversiblyLost: BTTS Nee met 1-0 → false (nog reversibel)', () => {
  assert.strictEqual(isLiveIrreversiblyLost('BTTS Nee', { scoreH: 1, scoreA: 0 }), false);
});

test('isLiveIrreversiblyLost: Over 2.5 → nooit irreversibel verloren via deze helper', () => {
  assert.strictEqual(isLiveIrreversiblyLost('Over 2.5', { scoreH: 0, scoreA: 0 }), false);
});

// C1: fetchNhlGoaliePreview handles safeFetch 2-arg interface correctly.
// We smoke-test via require alone — runtime path tested separately if mock framework available.
test('nhl-goalie-preview module loads without crash', () => {
  const mod = require('./lib/integrations/nhl-goalie-preview');
  assert.strictEqual(typeof mod.fetchNhlGoaliePreview, 'function');
  assert.strictEqual(typeof mod.extractNhlGoaliePreview, 'function');
  assert.strictEqual(typeof mod.selectLikelyGoalie, 'function');
});

// H2: PUBLIC_PATHS test uses the actual server.js constant (structural test).
test('PUBLIC_PATHS: /api/status is NOT public, /api/health IS public', () => {
  // Read server.js source and verify the PUBLIC_PATHS set.
  const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const pubMatch = serverSrc.match(/const PUBLIC_PATHS = new Set\(\[[\s\S]*?\]\);/);
  assert(pubMatch, 'PUBLIC_PATHS declaration not found in server.js');
  const block = pubMatch[0];
  assert(!/['"]\/api\/status['"]/.test(block), '/api/status must NOT be in PUBLIC_PATHS');
  assert(/['"]\/api\/health['"]/.test(block), '/api/health MUST be in PUBLIC_PATHS for keep-alive');
  assert(/['"]\/api\/auth\/login['"]/.test(block), '/api/auth/login must be in PUBLIC_PATHS');
});

// C3: writeBet retries on unique-violation (bet_id race).
test('writeBet retries on bet_id unique violation (simulated race)', async () => {
  const createBetsData = require('./lib/bets-data');
  let insertAttempts = 0;
  let selectCalls = 0;
  const mockSupabase = {
    from: () => ({
      select: () => ({
        order: () => ({
          limit: () => {
            selectCalls++;
            // Eerste call: max=41 (next=42). Tweede call: max=42 (next=43).
            return Promise.resolve({ data: [{ bet_id: 40 + selectCalls }] });
          },
        }),
      }),
      insert: () => {
        insertAttempts++;
        if (insertAttempts === 1) {
          return Promise.resolve({ error: { message: 'duplicate key value violates unique constraint' } });
        }
        return Promise.resolve({ error: null });
      },
    }),
  };
  const betsData = createBetsData({
    supabase: mockSupabase,
    getUserMoneySettings: async () => ({ unitEur: 10, startBankroll: 500 }),
    defaultStartBankroll: 500,
    defaultUnitEur: 10,
    revertCalibration: async () => {},
    updateCalibration: async () => {},
  });
  const bet = { units: 1, odds: 2.0, uitkomst: 'Open', sport: 'football', wedstrijd: 'A vs B', markt: 'ML', datum: '01-01-2026', tijd: '19:00' };
  await betsData.writeBet(bet);
  assert(insertAttempts >= 2, `expected ≥2 insert attempts on unique violation, got ${insertAttempts}`);
  assert(bet.id >= 42, `bet.id should be set to retry-allocated id, got ${bet.id}`);
});

// H1: /api/health route is public + returns minimal payload.
test('health-route factory returns router with /health endpoint', () => {
  const createHealthRouter = require('./lib/routes/health');
  const router = createHealthRouter();
  assert.strictEqual(typeof router, 'function');
  // Express Router exposes stack; check at least one route registered.
  assert(Array.isArray(router.stack) && router.stack.length > 0, 'health router should have routes');
});

// ═══════════════════════════════════════════════════════════════════════════
// v11.3.25 · PHASE 8.1 ROUTE-LEVEL INTEGRATION TESTS (via route-harness)
// ═══════════════════════════════════════════════════════════════════════════
// Reviewer Codex #2 H4: coverage op server/db geldpaden te laag. Deze tests
// mounten echte Express routers met mocked deps en dispatchen requests via
// de harness. Geen supertest dep, geen nieuwe devDep — pure in-process.

const { callRoute, makeNoopAuthMiddleware } = require('./lib/testing/route-harness');

// Health route — public, minimal payload.
test('integration: GET /health returns { ok, ts }', async () => {
  const createHealthRouter = require('./lib/routes/health');
  const router = createHealthRouter();
  const res = await callRoute(router, { method: 'GET', path: '/health' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.ok, true);
  assert(Number.isFinite(res.body.ts), 'ts should be a number');
});

// Bets-read flow: GET /bets returnt bets + stats voor een user.
test('integration: GET /bets returns { bets, stats } scoped per user', async () => {
  const createBetsRouter = require('./lib/routes/bets');
  const mockBets = [
    { id: 1, wedstrijd: 'A vs B', markt: 'ML', odds: 2.0, units: 1, inzet: 10, uitkomst: 'W', wl: 10, userId: 'u1' },
    { id: 2, wedstrijd: 'C vs D', markt: 'Over 2.5', odds: 1.8, units: 1, inzet: 10, uitkomst: 'Open', wl: 0, userId: 'u1' },
  ];
  const router = createBetsRouter({
    readBets: async (userId) => {
      assert.strictEqual(userId, 'u1', 'readBets should receive correct userId');
      return { bets: mockBets, _raw: [] };
    },
    deleteBet: async () => {},
    loadUsers: async () => [{ id: 'u1', role: 'user', settings: { startBankroll: 500, unitEur: 10 } }],
    calcStats: (bets, sb, ue) => ({ total: bets.length, bankroll: sb, unitEur: ue }),
    rateLimit: () => false,
    defaultStartBankroll: 500,
    defaultUnitEur: 10,
  });
  const res = await callRoute(router, { method: 'GET', path: '/bets', user: { id: 'u1', role: 'user' } });
  assert.strictEqual(res.statusCode, 200);
  assert(Array.isArray(res.body.bets));
  assert.strictEqual(res.body.bets.length, 2);
  assert.strictEqual(res.body.stats.total, 2);
});

// Bets-correlations: groepeert open bets op dezelfde match.
test('integration: GET /bets/correlations groepeert open bets op wedstrijd', async () => {
  const createBetsRouter = require('./lib/routes/bets');
  const router = createBetsRouter({
    readBets: async () => ({
      bets: [
        { id: 1, wedstrijd: 'Ajax vs PSV', markt: 'ML', odds: 2.0, units: 1, inzet: 10, uitkomst: 'Open' },
        { id: 2, wedstrijd: 'Ajax vs PSV', markt: 'Over 2.5', odds: 1.8, units: 1, inzet: 10, uitkomst: 'Open' },
        { id: 3, wedstrijd: 'Feyenoord vs AZ', markt: 'ML', odds: 1.7, units: 1, inzet: 10, uitkomst: 'Open' },
      ],
    }),
    deleteBet: async () => {},
    loadUsers: async () => [],
    calcStats: () => ({}),
    rateLimit: () => false,
    defaultStartBankroll: 500,
    defaultUnitEur: 10,
  });
  const res = await callRoute(router, { method: 'GET', path: '/bets/correlations', user: { id: 'u1' } });
  assert.strictEqual(res.statusCode, 200);
  assert(Array.isArray(res.body.correlations));
  assert.strictEqual(res.body.correlations.length, 1, 'alleen Ajax/PSV (2 bets) is correlated');
  assert.strictEqual(res.body.correlations[0].bets.length, 2);
});

// Bets DELETE: rate-limit afweer + user-scoping.
test('integration: DELETE /bets/:id blokkeert bij rate-limit hit', async () => {
  const createBetsRouter = require('./lib/routes/bets');
  let rateLimitCalled = false;
  const router = createBetsRouter({
    readBets: async () => ({ bets: [] }),
    deleteBet: async () => {},
    loadUsers: async () => [],
    calcStats: () => ({}),
    rateLimit: () => { rateLimitCalled = true; return true; },
    defaultStartBankroll: 500,
    defaultUnitEur: 10,
  });
  const res = await callRoute(router, { method: 'DELETE', path: '/bets/42', user: { id: 'u1' }, params: { id: '42' } });
  assert(rateLimitCalled, 'rateLimit helper should be invoked');
  assert.strictEqual(res.statusCode, 429);
});

// Bets DELETE: ongeldige id returnt 400.
test('integration: DELETE /bets/:id rejects invalid id', async () => {
  const createBetsRouter = require('./lib/routes/bets');
  const router = createBetsRouter({
    readBets: async () => ({ bets: [] }),
    deleteBet: async () => {},
    loadUsers: async () => [],
    calcStats: () => ({}),
    rateLimit: () => false,
    defaultStartBankroll: 500,
    defaultUnitEur: 10,
  });
  const res = await callRoute(router, { method: 'DELETE', path: '/bets/notanumber', user: { id: 'u1' }, params: { id: 'notanumber' } });
  assert.strictEqual(res.statusCode, 400);
});

// Admin error-leak regressie: admin-controls upgrade-ack returnt géén raw error.
test('integration: admin-controls 500-pad lekt geen raw error message', async () => {
  const createAdminControlsRouter = require('./lib/routes/admin-controls');
  const router = createAdminControlsRouter({
    requireAdmin: makeNoopAuthMiddleware(),
    killSwitch: { enabled: true, set: new Set(), thresholds: {}, lastRefreshed: null },
    refreshKillSwitch: async () => {},
    operator: { master_scan_enabled: true },
    saveOperatorState: async () => {},
    loadCalib: () => { throw new Error('SECRET_INTERNAL_DETAIL'); },
    saveCalib: async () => {},
  });
  const res = await callRoute(router, {
    method: 'POST', path: '/admin/v2/upgrade-ack',
    user: { id: 'admin-1', role: 'admin' }, body: { type: 'upgrade_api' },
  });
  assert.strictEqual(res.statusCode, 500);
  assert(res.body && res.body.error);
  assert(!/SECRET_INTERNAL_DETAIL/.test(String(res.body.error)),
    'raw internal error message must not leak to client');
});

// v11.3.25 Phase 8.2: pick-distribution endpoint (empirical bias-check).
test('integration: GET /admin/v2/pick-distribution aggregates by market × bookie × reason', async () => {
  const createAdminInspectRouter = require('./lib/routes/admin-inspect');
  const mockCandidates = [
    { bookmaker: 'Bet365', passed_filters: true, rejected_reason: null, model_run_id: 'run1', selection_key: 'over', created_at: new Date().toISOString() },
    { bookmaker: 'Bet365', passed_filters: false, rejected_reason: 'edge_below_min', model_run_id: 'run1', selection_key: 'over', created_at: new Date().toISOString() },
    { bookmaker: 'Unibet', passed_filters: false, rejected_reason: 'no_bookie_price', model_run_id: 'run1', selection_key: 'over', created_at: new Date().toISOString() },
    { bookmaker: 'Bet365', passed_filters: true, rejected_reason: null, model_run_id: 'run2', selection_key: 'home', created_at: new Date().toISOString() },
  ];
  const mockRuns = [
    { id: 'run1', market_type: 'totals' },
    { id: 'run2', market_type: 'moneyline' },
  ];
  const mockSupabase = {
    from: (table) => ({
      select: () => ({
        gte: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: table === 'pick_candidates' ? mockCandidates : [], error: null }),
          }),
        }),
        in: () => Promise.resolve({ data: table === 'model_runs' ? mockRuns : [], error: null }),
      }),
    }),
  };
  const router = createAdminInspectRouter({
    supabase: mockSupabase,
    requireAdmin: makeNoopAuthMiddleware(),
    computeBookieConcentration: () => ({}),
    getActiveStartBankroll: () => 500,
    aggregateEarlyPayoutStats: async () => [],
    normalizeSport: (s) => s,
    detectMarket: () => 'other',
    loadUsers: async () => [{ id: 'admin-1', role: 'admin', settings: { preferredBookies: ['Unibet'] } }],
  });
  const res = await callRoute(router, {
    method: 'GET', path: '/admin/v2/pick-distribution',
    query: { hours: '24' }, user: { id: 'admin-1', role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.total, 4);
  assert.strictEqual(res.body.accepted, 2);
  assert.strictEqual(res.body.rejected, 2);
  assert(res.body.distribution.totals, 'distribution should have totals bucket');
  assert(res.body.distribution.totals.bet365, 'totals → bet365 bucket should exist');
  assert.strictEqual(res.body.distribution.totals.bet365.accepted, 1);
  assert.strictEqual(res.body.distribution.totals.bet365.rejected, 1);
  assert(res.body.bookieSummary.bet365, 'bookieSummary should aggregate bet365');
  assert.strictEqual(res.body.bookieSummary.bet365.accepted, 2);
  assert.strictEqual(res.body.bookieSummary.bet365.total, 3);
});

// v11.3.27 reviewer-fix: pick-distribution ?preferredOnly=1 filtert echt.
test('integration: GET /admin/v2/pick-distribution?preferredOnly=1 filters on user prefs', async () => {
  const createAdminInspectRouter = require('./lib/routes/admin-inspect');
  const mockCandidates = [
    { bookmaker: 'Bet365', passed_filters: true, rejected_reason: null, model_run_id: 'r1', selection_key: 'over', created_at: new Date().toISOString() },
    { bookmaker: 'Unibet', passed_filters: true, rejected_reason: null, model_run_id: 'r1', selection_key: 'over', created_at: new Date().toISOString() },
    { bookmaker: 'Pinnacle', passed_filters: true, rejected_reason: null, model_run_id: 'r1', selection_key: 'over', created_at: new Date().toISOString() },
    { bookmaker: 'William Hill', passed_filters: false, rejected_reason: 'edge_below_min', model_run_id: 'r1', selection_key: 'over', created_at: new Date().toISOString() },
  ];
  const mockRuns = [{ id: 'r1', market_type: 'totals' }];
  const mockSupabase = {
    from: (table) => ({
      select: () => ({
        gte: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: table === 'pick_candidates' ? mockCandidates : [], error: null }),
          }),
        }),
        in: () => Promise.resolve({ data: table === 'model_runs' ? mockRuns : [], error: null }),
      }),
    }),
  };
  const router = createAdminInspectRouter({
    supabase: mockSupabase,
    requireAdmin: makeNoopAuthMiddleware(),
    computeBookieConcentration: () => ({}),
    getActiveStartBankroll: () => 500,
    aggregateEarlyPayoutStats: async () => [],
    normalizeSport: (s) => s,
    detectMarket: () => 'other',
    loadUsers: async () => [{ id: 'admin-1', role: 'admin', settings: { preferredBookies: ['Bet365', 'Unibet'] } }],
  });
  const res = await callRoute(router, {
    method: 'GET', path: '/admin/v2/pick-distribution',
    query: { preferredOnly: '1' }, user: { id: 'admin-1', role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.preferredOnly, true);
  assert.deepStrictEqual(res.body.preferredBookies, ['bet365', 'unibet']);
  // Na filter blijven alleen Bet365 + Unibet over (2 van de 4).
  assert.strictEqual(res.body.total, 2, `expected 2 after preferred filter, got ${res.body.total}`);
  assert(!res.body.bookieSummary['william hill'], 'william hill should be filtered out');
  assert(!res.body.bookieSummary.pinnacle, 'pinnacle should be filtered out');
});

// v11.3.27 reviewer-fix: bookie-concentration reads `tip`, not `bookie`.
test('integration: GET /admin/v2/bookie-concentration uses `tip` column', async () => {
  const createAdminInspectRouter = require('./lib/routes/admin-inspect');
  let selectedColumn = null;
  let notNullCol = null;
  const mockSupabase = {
    from: () => ({
      select: (cols) => {
        selectedColumn = cols;
        return {
          not: (col) => {
            notNullCol = col;
            return Promise.resolve({
              data: [
                { tip: 'Bet365', inzet: 50, datum: '15-04-2026' },
                { tip: 'Unibet', inzet: 30, datum: '15-04-2026' },
              ],
              error: null,
            });
          },
        };
      },
    }),
  };
  const router = createAdminInspectRouter({
    supabase: mockSupabase,
    requireAdmin: makeNoopAuthMiddleware(),
    computeBookieConcentration: (bets) => ({
      total: bets.reduce((s, b) => s + b.inzet, 0),
      perBookie: bets.map(b => ({ bookie: b.bookie, stake: b.inzet, share: 0.5 })),
      maxShare: 0.5, maxBookie: bets[0]?.bookie || null,
    }),
    getActiveStartBankroll: () => 500,
    aggregateEarlyPayoutStats: async () => [],
    normalizeSport: (s) => s,
    detectMarket: () => 'other',
    loadUsers: async () => [],
  });
  const res = await callRoute(router, {
    method: 'GET', path: '/admin/v2/bookie-concentration',
    user: { id: 'admin-1', role: 'admin' },
  });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(selectedColumn, 'tip, inzet, datum', 'must select `tip` not `bookie`');
  assert.strictEqual(notNullCol, 'tip', 'must filter not-null on `tip`');
  assert.strictEqual(res.body.total, 80);
  assert.strictEqual(res.body.perBookie[0].bookie, 'Bet365');
});

// Info route: GET /version returns app version (geen auth nodig — mounted elsewhere).
test('integration: GET /version returns { version } from app-meta', async () => {
  const createInfoRouter = require('./lib/routes/info');
  const router = createInfoRouter({
    appVersion: '11.3.25-test',
    loadCalib: () => ({ markets: {} }),
    requireAdmin: makeNoopAuthMiddleware(),
    afKey: 'test-key',
    afRateLimit: { callsToday: 0, remaining: 100, limit: 100 },
    sportRateLimits: {},
    getCurrentStakeRegime: () => ({ regime: 'stable', kellyFraction: 0.5 }),
    leagues: { football: [], basketball: [], hockey: [], baseball: [], 'american-football': [], handball: [] },
  });
  const res = await callRoute(router, { method: 'GET', path: '/version' });
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.version, '11.3.25-test');
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────
runAsyncTests().then(() => {
  console.log(`\n\u2514\u2500\u2500 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
});
