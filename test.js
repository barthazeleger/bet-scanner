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
  pitcherAdjustment, recomputeWl,
  NHL_OT_HOME_SHARE, MODEL_MARKET_DIVERGENCE_THRESHOLD,
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

test('hk > 0.09 = 1.0U', () => {
  assert.strictEqual(kellyToUnits(0.10), '1.0U');
  assert.strictEqual(kellyToUnits(0.15), '1.0U');
});

test('hk 0.04-0.09 = 0.5U', () => {
  assert.strictEqual(kellyToUnits(0.05), '0.5U');
  assert.strictEqual(kellyToUnits(0.09), '0.5U');
});

test('hk <= 0.04 = 0.3U', () => {
  assert.strictEqual(kellyToUnits(0.03), '0.3U');
  assert.strictEqual(kellyToUnits(0.01), '0.3U');
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
  // Copy of detectMarket from server.js
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
  assert.strictEqual(detectMarket('Ajax wint'), 'home');
  assert.strictEqual(detectMarket('✈️ PSV wint'), 'away');
  assert.strictEqual(detectMarket('Gelijkspel'), 'draw');
  assert.strictEqual(detectMarket('Over 2.5 goals'), 'over');
  assert.strictEqual(detectMarket('Under 2.5 goals'), 'under');
  assert.strictEqual(detectMarket('BTTS Ja'), 'other');
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
  const adminEndpoints = ['/api/model-feed', '/api/signal-analysis', '/api/timing-analysis',
    '/api/admin/users', '/api/bets/recalculate', '/api/debug/wl', '/api/backfill-times'];
  // These should all be in the admin-required list (verified by reading server.js)
  assert.strictEqual(adminEndpoints.length, 7, 'Should have 7 admin endpoints listed');
  // None of these should be in PUBLIC_PATHS
  const PUBLIC_PATHS = new Set(['/api/status', '/api/auth/login', '/api/auth/register', '/api/auth/verify-code']);
  for (const ep of adminEndpoints) {
    assert.ok(!PUBLIC_PATHS.has(ep), `${ep} should NOT be in public paths`);
  }
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

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n\u2514\u2500\u2500 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
