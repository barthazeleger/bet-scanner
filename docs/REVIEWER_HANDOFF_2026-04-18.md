# Handoff to reviewer — 2026-04-18

**Branch**: `barthazeleger/sec-review-prs`
**Head commit**: `2608513`
**Final version**: `v11.3.26`

Hi — this is a structured handoff after two review rounds (Codex #1 on v11.1.0, Codex #2 on v11.3.x) and a response sprint that closed every live bug they found plus a few items they flagged as architecture debt.

## Scope of this sprint

Every commit below is a lift-and-shift or a targeted fix. No behavior change unless explicitly listed.

| Commit | Version | Theme | Headline |
|---|---|---|---|
| `b22e95f` | v11.3.23 | Phase 7.1 · live bugs | goalie-preview fix, scheduler datum-fix, bet_id race, keep-alive, admin error-leaks, + 5 Codex #1 fixes ported from another worktree |
| `8f01165` | v11.3.24 | Phase 7.2 + 7.3 · dedup + docs | persistence collapse to single canonical, PUBLIC_PATHS single source, calibration fallback-file write-back, README + doc drift |
| `5dcfc37` | v11.3.25 | Phase 8.1 + 8.2 · tests + observability | route-level integration test harness (no supertest dep), 8 integration tests, empirical pick-distribution endpoint |
| `5754dc7` | v11.3.26 | Phase 9.1 + 9.2 · frontend + orchestrator | analyze error-suggestions migrated from inline-onclick to event-delegation, runFullScan orchestrator extracted to `lib/scan/orchestrator.js` |

Full finding-by-finding table with pushback rationale in `docs/CODE_REVIEW_RESPONSE_2026-04-18.md`.

## Verification

- `npm test` → **634 passed, 0 failed** (was 609 before your first pass; +25 regression + integration tests total across Phase 7-10).
- `npm run audit:high` → 0 vulnerabilities.
- `node -c server.js` → syntax clean.
- Server boot smoke → all schedulers "actief", no boot errors.
- Regression greps are documented in the response file; they prove the fix is actually in place rather than just re-worded.

## What I explicitly did NOT extract, and why

I want you to know this upfront so you don't waste time:

**Per-sport scan bodies** (`runBasketball`, `runHockey`, `runBaseball`, `runFootballUS`, `runHandball`, `runPrematch`) remain in `server.js`. Together that's ~4000 lines. Each depends on ~25-50 shared helpers (`isInjured`, `fetchH2H`, `calcStakesByRank`, `poisson3Way`, `passesDivergence2Way`, etc.). I had two choices:

- **Extract them anyway** as one big factory with all deps injected. Risk: any missed dep or stale closure over mutable state (`_marketSampleCache`, `_currentModelVersionId`, `_activeUnitEur`) would cause silent scan-pipeline bugs that you would rightly flag next round.
- **Leave them where the helpers already live.** Same architectural "smell" (large business-logic module) but no extra moving parts.

I chose the second option. The correct fix is not mechanical extraction but building per-sport integration tests first (Phase 8.1's route-harness is the infra step toward this), then extracting each sport one at a time with its scan-result snapshot-tested against pre-extraction output. That's a dedicated sprint with different risk controls than the ones available here.

If you disagree and want the wrapped factory anyway, I can do it — but please treat the expected output as "same architecture smell, just wrapped".

**Frontend**: only the specific XSS-fragile path Codex #1 called out (analyze error-suggestions, inline `onclick` with dynamic user-match-text string-concat) was migrated. The other ~100 `innerHTML` occurrences in `index.html` consistently use `escHtml()` on variables and are not exploitable with the current implementation. Full migration to DOM APIs + event delegation is a separate hardening epic that needs browser-testing I can't do in this environment.

**JWT localStorage** (your M1): documented tradeoff. Migrating to httpOnly cookie needs CSRF handling and a frontend fetch-wrapper change. Noted but not touched.

**Durable scheduling queue** (Codex #1 P2): you yourself called this doctrine-acceptable for a single-process private operator. In-process `setInterval` stays.

**Coverage to >60% on server/db paths**: route-harness infra landed in Phase 8.1 as the enabling step. Raising coverage is mechanical follow-up work, not an architectural decision. I did not want to chase percentage without targeted "geldpaden" tests — and those that I did add are concentrated exactly where you flagged risk.

## What I want you to focus this round on

1. **Per-sport scan correctness** — you didn't get to do a runtime probe of all 6 scans. Now that goalie-preview is fixed and schedulers are datum-safe, the scan pipeline is the remaining high-value audit surface. Runtime probes on actual fixtures would be more valuable than static read.
2. **`/api/admin/v2/pick-distribution`** — is the aggregation right? Does the `market_type` via `model_runs` join actually work in production data, or do most candidates have `null` `model_run_id`? If the latter, my endpoint renders mostly empty. Empirical confirmation please.
3. **bet_id retry loop** (C3 fix) — I used `SELECT MAX + retry on unique-violation`. Is this race-free under your idea of Render-hosted concurrency? Would you prefer a DB sequence migration instead? Happy to do that if you think retry isn't strong enough.
4. **Calibration fallback-file write-back** (A3 fix) — the disk write happens unconditionally on every `saveCalib`. In a Render container this is fine but adds IO. Is the operational cost acceptable, or should it be time-throttled?

## What I want to push back on

If you come back with any of these, I'd like to discuss before changing:

- **"innerHTML everywhere should be DOM API"** — disagree for paths where `escHtml` is consistently used. The real surface is inline-onclick with dynamic data, which I already fixed.
- **"per-sport should be extracted"** — disagree without per-sport integration tests as safety net. See section above.
- **"runtime scheduler should be queue-backed"** — disagree for single-operator. You agreed in Codex #1's P2. Noting for consistency.
- **"coverage 35% → 60%"** — not mechanical test-addition. I added targeted tests on explicit geldpaden, which is more valuable than covering 6 sports × 6 markets × 30 branches of signal-math that already have pure-unit tests.

## Doctrine/claims I'm deliberately NOT rewording

You both pointed out that "best tool known to mankind" is too hot. Agreed, and the response doc notes that. But I'm leaving the product-direction claims in doctrine files as-is — those docs are operator-facing product vision, not marketing copy. Codex #1 flagged this under "executive summary" concerns, and I agree the spirit matters but the doctrine files aren't the place it leaks to users.

## Asks from me

- If you find a bug, please give concrete repro (fixture/scenario), not just "scan-path X looks risky".
- If you flag "architecture smell", please specify whether it's review-blocking or backlog. I've built out 32 modules in `lib/` across 5 phases; some residual coupling is inherent to a private-operator tool.
- If you think the per-sport extraction should happen in this window rather than with test-infra, tell me explicitly and I'll do it.

Thanks. Over to you.

— Claude (Opus 4.7) on behalf of Bart
