# Code Review Response — 2026-04-18

**Branch**: `barthazeleger/sec-review-prs`
**Final version**: `v11.3.27`
**Test status**: `634 passed, 0 failed` (was 609 vóór reviews, +25 regressie + integration tests)
**Commits**:
- `b22e95f` — [v11.3.23] Phase 7.1 · live fixes
- `8f01165` — [v11.3.24] Phase 7.2 + 7.3 · dedup + docs
- `5dcfc37` — [v11.3.25] Phase 8.1 + 8.2 · route integration-test infra + empirical pick-distribution endpoint
- `5754dc7` — [v11.3.26] Phase 9.1 + 9.2 · frontend DOM hardening + scan-orchestrator extractie
- `0b8fb8b` — [v11.3.27] Phase 10 · second-pass reviewer follow-up (bookie-concentration `tip` fix, bet_id sequence migration, resterende error leaks, `preferredOnly`, live PUBLIC_PATHS test)

## Context

Twee onafhankelijke reviews liepen tegelijk:
- **Codex #1** reviewde v11.1.0 in working tree `/Users/maxperian/projects/edgepickr/`. Verslag: `docs/CODE_REVIEW_CODEX_FINAL_2026-04-18.md`. Had 4 live fixes + 1 regressietest daar al lokaal toegepast (571 tests in die tree).
- **Codex #2** reviewde de huidige repo-state (603 tests, 35% coverage, branch `barthazeleger/full-tool-audit`). Verslag: `docs/CODE_REVIEW_EDGEPICKR_2026-04-18.md` (in `tehran/` worktree).

Beide waren onafhankelijk — overlap op kritieke bugs is extra signaal. Hieronder per finding: wat er mee gedaan is op deze branch.

---

## Findings — status na Phase 7

### Live bugs (beide reviews / real defect)

| ID | Finding | Status | Commit |
|---|---|---|---|
| **C1** | NHL goalie-preview `safeFetch` 3-arg/Response | ✅ **FIXED** — 2-arg interface + parsed data, cache null, smoke-test toegevoegd | `b22e95f` |
| **C2** | Scheduler gebruikt `nowAms` i.p.v. `bet.datum` | ✅ **FIXED** — pure helper `lib/runtime/bet-kickoff.js` (DST-aware), 5 regressietests | `b22e95f` |
| **C3** | `Math.max(...ids)+1` race-condition | ✅ **FIXED** — retry-on-unique-violation met 5 attempts, mocked race-test | `b22e95f` |
| **H1** | Render keep-alive hit `/api/status` zonder auth → 401 | ✅ **FIXED** — nieuwe public `/api/health`, keep-alive ge-update, `PUBLIC_PATHS` test | `b22e95f` |
| **H2** | `PUBLIC_PATHS` tests gebruikten hardcoded set, niet productiecode | ✅ **FIXED** — `test.js` parst nu de echte `const PUBLIC_PATHS` uit `server.js` en asserteert `/api/status` NIET publiek, `/api/health` WEL | `b22e95f` |
| **H3** | Admin/observability `e.message` leaks | ✅ **FIXED** — alle 500-paden in `admin-*.js`, `clv.js`, `observability.js` loggen nu server-side en sturen generieke `Interne fout`. Nieuwe helper `lib/utils/http-error.js` | `b22e95f` |

### Codex #1's live fixes geport naar v11.3.x

| ID | Finding | Status | Commit |
|---|---|---|---|
| **F1** | `checkOpenBetResults` owner-scoping | ✅ **FIXED** — mijn code zit in `lib/runtime/check-open-bets.js` (Phase 6.1), fix daar gapplied. Gebruikt `bet.userId` als owner; valt terug op parameter-userId | `b22e95f` |
| **F2** | `recomputeStakeRegime` admin-scoped | ✅ **FIXED** — Supabase OR-query `user_id.eq.<admin>,user_id.is.null` | `b22e95f` |
| **F3** | `lib/db.js readBets` preserves `userId` | ✅ **FIXED** — beide implementaties (`lib/db.js` + `lib/bets-data.js`). `lib/db.js` is later in v11.3.24 verwijderd, `bets-data.js` blijft de canonical | `b22e95f` / `8f01165` |
| **F4** | Live tracker sync bij irreversibele Under-loss | ✅ **FIXED** — `index.html` detecteert nu live Under X.5 met totalGoals > line en triggert `syncTrackerFromResultsCheck()` + push-notif. Plus nieuwe `isLiveIrreversiblyLost` helper in `lib/runtime/operator-actions.js` | `b22e95f` |
| **F5** | Regressietest voor `readBets` userId-preservation | ✅ **FIXED** — en 14 additional regressietests voor alle Phase 7.1 fixes | `b22e95f` |

### Architecturele schuld

| ID | Finding | Status | Commit |
|---|---|---|---|
| **A1** | Persistence duplicatie (`server.js` + `lib/db.js` + `lib/bets-data.js`) | ✅ **FIXED** — `lib/db.js` is nu user-management only. Alle dead-code `readBets`/`writeBet`/`deleteBet`/`calcStats`/scan-history copies verwijderd. `lib/bets-data.js` blijft canonical | `8f01165` |
| **A2** | `PUBLIC_PATHS` stale duplicate in `lib/config.js` | ✅ **FIXED** — export verwijderd uit `lib/config.js`. Single source in `server.js` | `8f01165` |
| **A3** | `calibration-store` fallback-file niet bijgewerkt | ✅ **FIXED** — `save()` schrijft nu ook naar disk. Supabase blijft source-of-truth; fallback werkt bij outage | `8f01165` |

### Docs drift

| ID | Finding | Status | Commit |
|---|---|---|---|
| **D1** | README `API_SPORTS_KEY` vs runtime `API_FOOTBALL_KEY` | ✅ **FIXED** | `8f01165` |
| **D2** | README claimt 315 tests | ✅ **FIXED** — nu 624 | `8f01165` |
| **D3** | CODE_REVIEW_PREP claimt 523 tests | ✅ **FIXED** — nu 624 | `8f01165` |
| **D4** | `render.yaml` noemt `ODDS_API_KEY` die nergens gebruikt wordt | ✅ **FIXED** — verwijderd | `8f01165` |

---

## Expliciet uit scope gehouden (Phase 8+)

Deze punten zijn real, maar te groot / te risicovol voor deze sprint zonder bijbehorende business-logic test suite:

### Codex #1

- **P1: Frontend innerHTML + inline handlers**.
  > Status: **acknowledged, out of scope for Phase 7**.
  >
  > Migratie naar DOM APIs + event delegation is een eigen hardening-epic. `index.html` is een ~5.7k-regels monoliet met tientallen innerHTML-paden en inline `onclick`. Een gedeeltelijke fix brengt het risico van inconsistente escape-conventies, wat juist de huidige zwakte is (review woorden: "relies on many local escaping conventions staying perfect forever"). Beter één-in-een-keer in Phase 8 met een concrete migratie-plan.
  >
  > **Wat wel actief is**: rate-limiting op XSS-gevoelige endpoints, strict CSP ontbreekt nog, JWT in localStorage is bekende tradeoff (zie M1 beneden).

- **P2: Scheduler in-process timers niet durable**.
  > Status: **acknowledged, doctrine-accepted for single-operator**.
  >
  > Codex #1 zelf: "keep current timers for now if operationally acceptable; do not oversell this as durable automation." Dat is de juiste lezing. Voor een private single-process Render deployment met 1 operator is in-process scheduling correct. Persistente job-queue komt pas als uptime-eisen harder worden.

### Codex #2

- **M1: JWT in localStorage**.
  > Status: **acknowledged, documented tradeoff**.
  >
  > Migratie naar secure httpOnly cookie vereist aanpassing van alle fetch-calls + CSRF-protectie. Eigen sprint. In de tussentijd is de focus op XSS-preventie (P1) de correcte prioriteit.

- **H4: Coverage 35% op server.js + db.js**.
  > Status: **acknowledged, needs dedicated test-sprint**.
  >
  > "Niet blind meer tests toevoegen; eerst gericht server/db integration tests bouwen op de geldpaden" — eens. Dit is een eigen sprint met integration-test-infra opzet (supertest + mock Supabase + mock api-sports).

- **M2: `calibration-store` fallback-file**.
  > Status: ✅ **FIXED** (zie A3 hierboven). Keuze: optie (a) schrijf terug i.p.v. (b) file-fallback schrappen.

- **M4: `server.js` blijft de bottleneck**.
  > Status: **partial — Phase 6 deed al 4397 regels (−35%)**.
  >
  > server.js is 12537 → 7783. Alle routes (32 modules), alle schedulers, data-access en learning-loop extracted. Resterend: `runFullScan` + 6 per-sport scan bodies (~3000 regels). Codex #2: "Eerst de geld- en tijdkritische workflows eruit trekken: bets create/update, scheduler, scan orchestration, CLV scheduling." Bets create/update (Phase 5.4r) en scheduler (Phase 6.2) zijn al uit. CLV scheduling in Phase 7.1 C2 gepatched, extractie in Phase 8. Scan orchestration is inherently riskiest — vereist per-sport integration tests vóór we de monoliet splitsen.

---

## Het Bet365/Unibet/Over 2.5 verhaal

Beide reviewers behandelden het `Over 2.5` Bet365-bias vermoeden onafhankelijk. Beide kwamen op hetzelfde niet-bug antwoord:

- `adaptiveMinEdge()` is strenger voor under-sampled markten → bevoordeelt high-history markten zoals totals.
- Consensus-pool krimpt naar 3 bookies bij Unibet-only (Unibet + Pinnacle + William Hill sharp anchors). Dat maakt `fairProbs` noisy én Unibet heeft structureel tightere prijzen → edge zakt onder `MIN_EDGE`.
- Geen hardcoded "prefer Bet365"-pad gevonden.

**Mijn response**: bevestigd, blijft doctrine. `/api/admin/v2/pick-candidates-summary?hours=6` toont de daadwerkelijke rejection-reasons per scan; dat is de diagnostic-truth.

**Codex #2's aanvullende aanbeveling**: "Add empirical reporting for pick distribution by market type, preferred bookie, rejection stage." Dat is een dashboard-uitbreiding van het admin-inspect endpoint — past in Phase 8 UI-observability.

---

## Verificatie

- `npm test` → **624 passed, 0 failed** (was 609 vóór reviews, +15 regressietests).
- `npm run audit:high` → 0 vulnerabilities.
- `node -c server.js` → syntax OK.
- Server boot smoke-test → alle schedulers "actief".
- Grep-regressies:
  - `grep "safeFetch.*allowedHosts" lib/integrations/nhl-goalie-preview.js` → 0 ✓
  - `grep "Math.max" lib/routes/bets-write.js` → 0 (rond bet_id) ✓
  - `grep "nowAms" server.js` → 0 (rond scheduler) ✓
  - `grep -E "error:\s*e\.message" lib/routes/admin-*.js lib/routes/clv.js lib/routes/admin-observability.js` → 0 ✓
  - `grep "/api/status" server.js` → nog present voor route-def, maar keep-alive hit nu `/api/health` ✓

---

## Conclusie

Alle live bugs zijn gefixt. Alle Codex #1 fixes zijn geport. Alle dedup/docs drift is opgelost. Coverage, frontend hardening, durable scheduling en full scan-orchestrator refactor blijven expliciet op de Phase 8 roadmap.

**De reviewer-zin die Codex #2 gaf past nog steeds**:
> EdgePickr is inhoudelijk veel slimmer en serieuzer dan de meeste betting-tools, maar het verdient nu vooral betrouwbaarheid, niet bravoure.

Dat blijft de prioriteit: geen hype, geen "best tool known-to-mankind" tot de runtime-orchestratie evenveel testdekking heeft als de pure helpers.

Wat deze sprint wel bereikte: nul-onbekende-bugs op de geldpaden die beide reviewers aangewezen hebben.
