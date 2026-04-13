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

// ── SUMMARY ──────────────────────────────────────────────────────────────────
console.log(`\n\u2514\u2500\u2500 Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
