# Code Review Summary · v11.0.0 → v11.1.0

Entry-document voor externe reviewer. v10.12.26 was het vorige review-target; deze release-bundel antwoordt op 10 operator-bevindingen uit de in-use-test sessie 2026-04-18 en introduceert een architectuur-shift ("modular-from-start") waarmee server.js vanaf v11 monotonisch shrinkt.

**Scope:** 8 commits, 9 nieuwe files, 570 tests groen, 0 npm-audit vulnerabilities. Alle pushes op `origin/master`.

## Per operator-bevinding → commit + testbestand

| # | Bevinding | Commit(s) | Prio | Tests |
|---|---|---|---|---|
| 1 | Stake-regime drawdown label "€88/€38" was cumulative NET P/L, niet bankroll — engine triggerde `drawdown_hard` false-positive | `83a5e8c` (v11.0.0 C1.3) | P0 correctness | test.js: `computeBankrollMetrics` 7 tests |
| 2 | ChatGPT Plus (€23/mnd sinds 15-04-2026) niet zichtbaar op Info → Abonnementen | `9f1ce6e` (v11.0.2 C3.1) | P2 UI | — (UI-only) |
| 3 | BTTS auto-close bugs: 2 Open bets als L gezet terwijl 1 W was en 1 nog bezig; signal-weights meebewogen | `2d7d38e` (v11.0.0 C1.1) | P0 correctness | test.js: `results-checker` 13 tests |
| 4 | Recent lege CLVs in tracker; backfill alleen via curl | `3842449` (v11.0.1 C2.2) | P1 UX | test.js: `clv-backfill` 7 tests |
| 5 | "Odds nu" knop silent-fail op `canRefresh:false` paden | `3842449` (v11.0.1 C2.1) | P1 UX | — (UI-only, manual verify) |
| 5b | Bet365 early-payout regels als signal — hoe vaak was een L eigenlijk een W via EP-rule | `6f592d5` (v11.1.0 C4) | P3 shadow | test.js: `early-payout` 14 tests |
| 6 | "Waar stonden de net-niet picks in de scan?" — geen UI-surface voor rejected candidates | `9f1ce6e` (v11.0.2 C3.2) | P2 UI | — (UI-only, gebruikt bestaand endpoint) |
| 7 | Referee-red-card rate → O/U 2.5 correlatie als signaal? | `6f592d5` (v11.1.0 C4.2) | P3 research | — (research-doc, geen code) |
| 8 | False-positive "SCANNER STIL" 21 min na succesvolle cron-scan | `9847a05` (v11.0.0 C1.2) | P0 visibility | test.js: `scan-logger` 6 tests |
| 9 | Meta: roadmap of data opbouwen? | Dit batch beantwoordt P0-P2; Phase 5 (server.js split) is opdrachtplan v11.2.x | — | — |
| 10 | Offer voor manual-scan debug | Na migration run + v11.1.0 deploy kan Bart manual scan triggeren. Eerst bij 07:30 cron morgen automatisch. | — | — |

## Architectuur-shift v11.0.0: modular-from-start

Elke nieuwe code landt voortaan direct in lib/ modules. server.js is voortaan alleen: app-setup, middleware-mount, boot-sequence. Doctrine-directive van operator 2026-04-18.

### Nieuwe lib/ modules in deze batch

| Module | Doel | LoC |
|---|---|---|
| `lib/runtime/results-checker.js` | `resolveBetOutcome(markt, ev, {isLive})` — settle-pipeline + LIVE-gate | ~200 |
| `lib/runtime/scan-logger.js` | `logScanEnd` / `hasRecentScanActivity` — heartbeat | ~55 |
| `lib/clv-backfill.js` | `fetchSnapshotClosing` — odds_snapshots fallback | ~70 |
| `lib/signals/early-payout.js` | `evaluateEarlyPayoutFromFinal` / `logEarlyPayoutShadow` / `aggregateEarlyPayoutStats` | ~130 |
| `lib/signals/early-payout-rules.js` | EARLY_PAYOUT_RULES constant + lookup helpers | ~55 |
| `lib/stake-regime.js` (extended) | `computeBankrollMetrics(bets, startBankroll)` added | +65 |

### server.js delta

Nu 12537 regels. v10.12.26 was 12537 (zelfde — per saldo ongeveer gelijk: ~400 regels settle-logic verplaatst, ~250 regels dedup stake-regime, maar ~400 regels nieuwe wiring + endpoints). **Net LoC-delta is bij benadering 0**; de WIN is single-responsibility distributie naar modules + eliminatie van de duplicate code pad voor stake-regime metrics.

Phase 5 (server.js route-extraction) is gepland als **v11.2.x multi-commit batch**: `lib/routes/{auth,bets,scan,picks,clv,admin,notifications,tracker}.js` + `lib/scan/orchestrator.js` + per-sport scan-bodies. Target: server.js < 1500 regels. Dedicated sprint (operator heeft 1-2 weken geauthoriseerd voor test-then-push); niet in deze batch.

## Kwaliteit-hardening buiten operator-report

### Outcome-flip calibration-revert
`updateBetOutcome(id, uitkomst, userId)` rolt nu de oude calibration-delta terug bij W→L of L→W operator-correcties. Voorheen append-only → manuele correctie verdubbelde de vervuiling wanneer de auto-settle fout was gegaan. Mirror-functie `revertCalibration(bet)` staat naast `updateCalibration`.

### Silent-catch verbeteringen
- `sendPushToUser` bij bet-result krijgt expliciete `.catch(e => console.warn(...))` met bet-id i.p.v. `() => {}`.
- `fetchSnapshotClosing` catch-all met context-rich log.
- `logEarlyPayoutShadow` shadow-log skip bij DB-fout, geen crash in settle-flow.

### Dead-code cleanup
- `resolveEarlyLiveOutcome` import uit server.js weggehaald (alleen via results-checker.js gebruikt).
- Duplicate bankroll-metrics parsing uit 2 plekken in server.js verwijderd.

## Doctrine-directives (memory / CLAUDE.md)

Nieuwe doctrine-entries in `.claude/memory/`:

1. **`feedback_autonomy_and_modular.md`** — autonomy level + "modular-from-start" directive. Nieuwe code NOOIT meer in server.js.

Bestaande referentie `project_signal_promotion_doctrine` blijft leidend: early-payout signaal landt in shadow-mode (weight=0), promotion pas bij 50+ samples per combinatie + walk-forward proof.

## Deployment-impact

**Operator-actie vereist vóór v11.1.0 volledig werkt**:
```bash
node scripts/migrate.js docs/migrations-archive/v11.1.0_early_payout_log.sql
```
Zonder deze migratie: `logEarlyPayoutShadow` fail-silent, maar geen crash of side-effect.

**Geen breaking API-changes**. Alle bestaande endpoints + response-formaten onveranderd. Nieuw endpoint `/api/admin/v2/early-payout-summary` is additief.

## Tests-samenvatting

```
v10.12.26 baseline: 523 tests passed, 0 failed
v11.1.0 current:    570 tests passed, 0 failed  (+47 netto)

Per fase-delta:
  C1.1 BTTS auto-close:         +13
  C1.2 scan-heartbeat:           +6
  C1.3 stake-regime drawdown:    +7
  C2.2 CLV snapshot fallback:    +7
  C4.1b early-payout signal:     +14
```

npm audit --audit-level=high: 0 vulnerabilities.

## Reviewer aanbevolen aandachtspunten

1. **`lib/runtime/results-checker.js` LIVE-gate**: nooit auto-L uit live-event. Geen asymmetrie (BTTS Ja mag W uit live, Nee moet wachten op FT). Verify dat alle early-close scenarios `resolveEarlyLiveOutcome` doorlopen, niet de finished-pipeline.
2. **`revertCalibration` flip-handling**: edge-cases bij W → Open (niet geteste flow — zou niet moeten voorkomen in productie want Open→W→L→W is de realistische flow; W→Open is admin-manual en zou ook gereverted moeten worden).
3. **`computeBankrollMetrics` fallback op startBankroll=0**: drawdown-trigger wordt volledig uitgeschakeld. Correct voor nieuwe setups, maar als operator per ongeluk `startBankroll=0` zet, verliezen ze een kill-switch. Overweeg UI-warning in Settings.
4. **Early-payout shadow-log conservatisme**: alleen final-score differential. Comeback-loss scenarios (team going 2-0 → final 2-2) worden gemist → underestimate van activation-rate. Shadow v2 moet `/events` endpoint gebruiken.
5. **Heartbeat query**: 14h threshold blijft correct voor 3 scans/dag (max gap 10.5h), maar als Bart van scan-schema afwijkt (bv. 2 scans/dag) moet de threshold mee.

## Bekende tech-debt (niet in scope deze batch)

- `server.js` 12.5k regels (Phase 5 v11.2.x target).
- `index.html` 5.7k regels inline JS/CSS.
- `user_id = null` semantiek voor operator-alerts in notifications tabel.
- `bet_id` blijft integer (UUID migratie open).
- Calibration-monitor schrijft `probability_source='ep_proxy'` tot bet↔pick_candidate join landt.

## Git-log van deze batch

```
6f592d5 [claude][v11.1.0] Phase 4 · early-payout shadow signal + referee-reds research entry
9f1ce6e [claude][v11.0.2] Phase 3 · ChatGPT subscription entry + near-miss picks UI
3842449 [claude][v11.0.1] Phase 2 · odds-nu UX fix + CLV backfill UI + snapshot fallback
daff2d4 [claude][v11.0.0] Phase 1 P0 bugfixes + architectuur-shift modular-from-start
83a5e8c [claude] C1.3 Stake-regime drawdown op echte bankroll · computeBankrollMetrics helper
9847a05 [claude] C1.2 Scan-heartbeat fix · scan-logger module · false-positive SCANNER STIL
2d7d38e [claude] C1.1 BTTS auto-close gate + revertCalibration + results-checker module
```
