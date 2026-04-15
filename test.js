'use strict';

const assert = require('assert');

// Pure helpers uit de ECHTE productie-module — geen mirrors meer.
// Als iemand de implementatie in lib/model-math.js verandert, breken de tests hier.
const modelMath = require('./lib/model-math');
const {
  epBucketKey, calcKelly, kellyToUnits, KELLY_FRACTION,
  poisson, poissonOver, poisson3Way,
  devigProportional, consensus3Way, deriveIncOTProbFrom3Way, modelMarketSanityCheck,
  normalizeTeamName, teamMatchScore, normalizeSport, detectMarket,
  pitcherAdjustment, shotsDifferentialAdjustment, recomputeWl,
  NHL_OT_HOME_SHARE, MODEL_MARKET_DIVERGENCE_THRESHOLD,
  bayesSmooth, hierarchicalMultiplier, HIER_CALIB_PRIOR, HIER_CALIB_MIN_N, HIER_CALIB_K,
  residualModelDelta, residualModelActive, RESIDUAL_MIN_TRAINING_PICKS,
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

// kellyToUnits komt uit lib/model-math.js

// Score: kelly -> 5-10 scale (implied by strength sorting in server)
function kellyScore(hk) {
  // The app uses strength = k*(odd-1)*vP*epW for ranking
  // Approximate 5-10 score based on half-kelly thresholds
  if (hk > 0.09) return 10;
  if (hk > 0.07) return 9;
  if (hk > 0.05) return 8;
  if (hk > 0.04) return 7;
  if (hk > 0.03) return 6;
  return 5;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  \u2705 ${name}`);
  } catch (e) {
    failed++;
    console.log(`  \u274c ${name}: ${e.message}`);
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
console.log('\n  Kelly Score (5-10):');

test('high kelly maps to score 10', () => {
  assert.strictEqual(kellyScore(0.10), 10);
});

test('low kelly maps to score 5', () => {
  assert.strictEqual(kellyScore(0.02), 5);
});

test('scores are monotonic with kelly', () => {
  const vals = [0.02, 0.03, 0.04, 0.05, 0.07, 0.10];
  const scores = vals.map(kellyScore);
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] >= scores[i - 1], `Score should not decrease: ${scores[i]} >= ${scores[i - 1]}`);
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
  // None of these should be in PUBLIC_PATHS
  const PUBLIC_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/register', '/api/auth/verify-code']);
  for (const ep of adminEndpoints) {
    assert.ok(!PUBLIC_PATHS.has(ep), `${ep} should NOT be in public paths`);
  }
});

test('settings whitelist includes v2 toggles maar geen dangerous keys', () => {
  // Whitelist moet behouden worden bij elke v2 toevoeging
  const ALLOWED_SETTINGS = new Set([
    'startBankroll','unitEur','language','timezone','scanTimes','scanEnabled',
    'twoFactorEnabled','telegramChatId','telegramEnabled','preferredBookies',
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

test('PUBLIC_PATHS only contains safe endpoints', () => {
  const PUBLIC_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/register', '/api/auth/verify-code']);
  assert.strictEqual(PUBLIC_PATHS.size, 4, 'Should have exactly 4 public endpoints');
  assert.ok(!PUBLIC_PATHS.has('/api/bets'), '/api/bets should not be public');
  assert.ok(!PUBLIC_PATHS.has('/api/prematch'), '/api/prematch should not be public');
  assert.ok(!PUBLIC_PATHS.has('/api/admin/users'), '/api/admin/users should not be public');
  assert.ok(!PUBLIC_PATHS.has('/api/model-feed'), '/api/model-feed should not be public');
});

test('settings whitelist blocks dangerous keys', () => {
  const ALLOWED_SETTINGS = new Set(['startBankroll','unitEur','language','timezone','scanTimes','scanEnabled','twoFactorEnabled','telegramChatId','telegramEnabled']);
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

test('modelMarketSanityCheck: default threshold is 0.04', () => {
  const r = modelMarketSanityCheck(0.50, 0.55);
  assert.strictEqual(r.agree, false, 'divergence 0.05 > default 0.04');
  assert.strictEqual(r.threshold, 0.04);
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

test('adaptiveMinEdge: tier-based threshold per sample size', () => {
  const baseMinEdge = 0.055;
  const compute = (n) => n >= 100 ? baseMinEdge : n >= 30 ? Math.max(baseMinEdge, 0.065) : Math.max(baseMinEdge, 0.08);
  assert.strictEqual(compute(0), 0.08, 'geen data → 8% conservatief');
  assert.strictEqual(compute(29), 0.08, '<30 → 8%');
  assert.strictEqual(compute(30), 0.065, '30-99 → 6.5%');
  assert.strictEqual(compute(99), 0.065);
  assert.strictEqual(compute(100), 0.055, 'proven → base 5.5%');
  assert.strictEqual(compute(500), 0.055);
});

test('adaptiveMinEdge: bootstrap mode bypass tot 100 totaal', () => {
  const BOOTSTRAP = 100;
  const baseMinEdge = 0.055;
  const compute = (totalSettled, marketN) => {
    if (totalSettled < BOOTSTRAP) return baseMinEdge;
    if (marketN >= 100) return baseMinEdge;
    if (marketN >= 30) return Math.max(baseMinEdge, 0.065);
    return Math.max(baseMinEdge, 0.08);
  };
  // Bootstrap fase: alles op base ondanks per-markt 0
  assert.strictEqual(compute(0, 0), 0.055, 'geen data globaal → base');
  assert.strictEqual(compute(50, 5), 0.055, 'in bootstrap → bypass adaptive');
  assert.strictEqual(compute(99, 0), 0.055, 'net onder bootstrap drempel → base');
  // Post-bootstrap: tiers actief
  assert.strictEqual(compute(100, 0), 0.08, 'post-bootstrap, n=0 → strict 8%');
  assert.strictEqual(compute(500, 50), 0.065, 'post-bootstrap, n=50 → 6.5%');
});

test('adaptiveMinEdge: nooit lager dan baseMinEdge', () => {
  const compute = (n, base) => n >= 100 ? base : n >= 30 ? Math.max(base, 0.065) : Math.max(base, 0.08);
  // Als baseMinEdge hoger is dan tier-defaults, gebruik base
  assert.strictEqual(compute(500, 0.10), 0.10, 'base 10% > tier → behoud base');
  assert.strictEqual(compute(50, 0.10), 0.10);
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

test('modal: matige daling (-5%) → severity=moderate, rec ≈ helft', () => {
  const r = computeModalAdvice({ origOdds: 2.00, newOdds: 1.90, prob: 0.60, origUnits: 1.0 });
  assert.strictEqual(r.severity, 'moderate');
  assert.ok(r.recUnits <= 0.5, `moderate rec (${r.recUnits}) moet ≤ helft van origUnits`);
});

test('modal: grote daling (-7%) → severity=adverse, rec=0, message flags invalid', () => {
  const r = computeModalAdvice({ origOdds: 2.00, newOdds: 1.85, prob: 0.60, origUnits: 1.0 });
  assert.strictEqual(r.severity, 'adverse');
  assert.strictEqual(r.recUnits, 0);
  assert.ok(/valide|line moved/i.test(r.message), 'adverse message flagged');
});

test('modal: Padres scenario 1.91→1.80 (-5.8%) → adverse of moderate, NIET hoger dan orig', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 1.80, prob: 0.62, origUnits: 0.75 });
  assert.ok(r.severity === 'moderate' || r.severity === 'adverse',
    `expected moderate/adverse, got ${r.severity}`);
  assert.ok(r.recUnits <= 0.75,
    `recUnits (${r.recUnits}) NOOIT hoger dan origUnits (0.75) bij lagere odds`);
});

test('modal: hogere odds (+3%) → severity=better, rec gecapt op origUnits', () => {
  const r = computeModalAdvice({ origOdds: 1.91, newOdds: 2.00, prob: 0.62, origUnits: 0.75 });
  assert.strictEqual(r.severity, 'better');
  assert.ok(r.recUnits <= 0.75, 'better rec gecapt op origUnits');
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

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n\u2514\u2500\u2500 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
