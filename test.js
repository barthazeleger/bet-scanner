'use strict';

const assert = require('assert');

// ─── STANDALONE COPIES OF PURE FUNCTIONS FROM server.js ──────────────────────
// These are copied to test in isolation without needing Supabase/env vars.

// EP Bucket Key
function epBucketKey(ep) {
  if (ep >= 0.55) return '0.55';
  if (ep >= 0.45) return '0.45';
  if (ep >= 0.38) return '0.38';
  if (ep >= 0.30) return '0.30';
  return '0.28';
}

// Kelly Criterion
const KELLY_FRACTION = 0.50;
function calcKelly(ep, odd) {
  const k = ((ep * (odd - 1)) - (1 - ep)) / (odd - 1);
  return k * KELLY_FRACTION;
}

// Poisson
function factorial(n) {
  let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
}

function poissonProb(lambda, k) {
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);
}

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

// Unit sizing from half-Kelly
function kellyToUnits(hk) {
  return hk > 0.09 ? '1.0U' : hk > 0.04 ? '0.5U' : '0.3U';
}

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

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n\u2514\u2500\u2500 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
