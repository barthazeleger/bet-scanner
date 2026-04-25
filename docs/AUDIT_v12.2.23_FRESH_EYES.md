# EdgePickr · fresh-eyes audit (v12.2.23 baseline)

**Datum:** 2026-04-25
**Reviewer:** Claude (fresh-eyes pass na 18 versies inclusief audit-roadmap implementatie v12.2.5 → v12.2.23)
**Scope:** Security · functionele correctheid · doctrine-fit · resterende gaps · roadmap waarde-rangschikking

---

## Executive samenvatting

Tussen v12.2.5 en v12.2.23 zijn alle directe acuut/F1-7/D1-3 audit-findings afgerond én alle deferred items geadresseerd waar dat zonder externe input mogelijk was (F4, D4, R1 spike, R2 join-laag, R3 diag, R4 alerts, R7 concurrency). Het systeem is in een schonere staat dan vóór de audit:

- **Single sources of truth voor classificatie + persistence:** `lib/market-keys.js` consolideert clv-shape ↔ learning-bucket; `lib/calibration-store` schrijft alleen naar Supabase tenzij outage.
- **Drie nieuwe diagnostic admin endpoints:** model-Brier vs market-Brier, devig-algoritme backtest, sharp-soft execution windows. Operator kan nu data-driven beslissingen maken over R3 (Bayesian) / R1 (devig swap) zonder gokken.
- **Auto-alerts voor execution-edge windows** vervangen handmatige cockpit-checks. Doctrine-conform: geen always-on terminal nodig.
- **736 tests** (was 668 vóór audit), 100% groen.

Wat resteert vraagt of (a) live productie-data om te valideren (R3 swap-decisie, R1 devig-swap, R2 isotonic-fit) of (b) bewuste sprint-allocatie (R5 live betting · R6 betalde data-API · R8 server.js refactor). Geen open audit-findings van P0/P1 niveau.

---

## 1. Wat geverifieerd

### 1.1 Architectuur — geen nieuwe seams gebroken

- `lib/` bevat 50+ modules. Single-source-modules introduceren in v12.2.19/.21 (`market-keys`, `bets-pick-join`) hebben zero-impact op consumer-code: oude API blijft werken, nieuwe API is opt-in.
- `server.js` 7932 regels (was 12k pre-audit, post-audit 7932 zonder R8). Doctrine "monotonic shrink" gehandhaafd.
- Tests blijven schoon `npm test` → 736 passed, 0 failed.

### 1.2 Concurrency + races — gemitigeerd

- F2 atomic Postgres RPC voor bookie-balance (race-free).
- F3 snapshot/restore voor outcome-flip (atomair t.o.v. exception).
- D4 calibration-store enkele writer (Supabase primary, file fallback).
- F1 + R7 fixture-resolver inflight-promise dedup (geen thundering herd).
- D1 scheduled jobs persistent in Supabase (overleeft Render restart).

Resterend race-vlak: `_marketSampleCache` / `KILL_SWITCH.set` / `_scanKickoffByFixture` zijn nog process-globale mutables in `server.js`. Risico beperkt op single-instance Render (geen multi-replica), maar verzwakt testbaarheid. Adres: in R8 refactor.

### 1.3 Security — geen nieuwe exposures

- Nieuwe admin endpoints (sharp-soft-windows, model-brier, devig-backtest) gebruiken `requireAdmin` middleware. Error-paths sturen geen raw e.message client-side (`'Interne fout · check server logs'`).
- Push-channel: alerts gaan naar `adminUserId` via bestaande `sendPushToUser` (per-user gefilterd). Geen broadcast.
- Notifications inserts gebruiken parameterized supabase-client (geen SQL injection).
- Inflight-promise dedup heeft geen extra DoS vector — cache key + TTL ongewijzigd, alleen tweede laag dedupliceren.

### 1.4 Doctrine-fit

- **CLV-first:** Brier endpoint vergelijkt nog op model vs markt — execution-edge tracking via sharp-soft windows alerts. Doctrine "execution edge bij soft books" rechtstreeks operationeel.
- **Single-operator:** alle nieuwe admin endpoints achter requireAdmin, geen multi-user complicatie.
- **Auditability:** drop-reasons (v12.2.6) + market-keys drift-detection + Brier metrics → operator kan stille degradatie spotten.
- **Bankroll-discipline:** F2/F3/D4 voorkomen geld/calib-corruption onder concurrent writes. Geen wijziging op stake-tier of step-up logic.

---

## 2. Open vragen / aandachtspunten

### 2.1 [P2] Globale state in server.js (`KILL_SWITCH`, `_marketSampleCache`, `_scanKickoffByFixture`)

Mutaties zonder lock. Op Render single-instance (current) geen concrete bug, maar:
- Tests kunnen niet `createApp()` aanroepen zonder side-effects.
- Future multi-replica deploy zou silently corrumperen.

**Suggestie:** R8 sprint pakt dit aan via `createApp(deps)` factory + state-objects (geen globals). Niet urgent.

### 2.2 [P2] R4 alert-threshold is hard-coded (4pp + 6u + cap 5)

Nu impliciet in `server.js` geënt. Tunable via admin-setting wenselijk zodra eerste week alert-volume bekend. Anders risico op spam (te laag) of gemiste edges (te hoog). Bart's eerste live test gaf 8 windows over 4 fixtures met max gap 4.04pp — dat is op de rand van filter. Kan het zijn dat we **nul** alerts krijgen op de eerstkomende week omdat de threshold te streng is?

**Suggestie:** binnen 7 dagen check inbox. Als 0 alerts: lower threshold naar 3pp.

### 2.3 [P3] F5/NRFI calibratie-bucket pollution blijft

`market-keys` documenteert het in `KNOWN_ASYMMETRIC_MARKET_TYPES`. Maar het probleem zelf — F5 picks vermengd met main O/U bucket — is niet opgelost. Effect: F5-picks dragen bij aan main O/U calibratie multiplier, wat inaccurate Kelly-stakes geeft op main O/U.

**Suggestie:** v12.3.x sprint: voer migratie uit die existing F5-bets in calib re-buckets. Plus update detectMarket om F5 een eigen bucket te geven. Opt-in: alleen nodig als F5-picks ≥10% van settled volume vormen (anders effect is verwaarloosbaar).

### 2.4 [P3] Brier-endpoint kan misleidend laag-coverage rapporteren

Als `<30 model-recs` rapporteert het `insufficient_join_coverage`. Maar de SETTLED bets kunnen bestaan zonder pick_candidate matching omdat:
- Bet werd handmatig gelogd (niet uit scan)
- Pick_candidate had passed_filters=false
- Bookmaker-mismatch (bv. user logged @ Holland Casino, scan zag alleen Bet365)

Dit is geen bug, maar de output zegt "insufficient_join_coverage" zonder uitleg waarom. Operator kan denken dat data ontbreekt.

**Suggestie:** endpoint retourneert ook breakdown van *waarom* join faalt (bookmaker-mismatch / passed_filters=false / no candidate at all).

### 2.5 [P3] R4 alert-payload bevat fixture-naam in plaintext

Push-payload body bevat fixture-naam + bookie + odds. Geen PII maar wel fingerprintable. Op iOS push-bubble showt deze waarschijnlijk preview op lock-screen.

**Suggestie:** geen actie (single-operator, eigen device). Voor toekomstige multi-user: encrypted payload.

---

## 3. Roadmap revaluation

### Beslispunten met verzamelde data

| Item | Status | Volgende stap |
|---|---|---|
| **R1 devig swap** | Backtest endpoint live (v12.2.22). Geen swap. | Run `/admin/v2/devig-backtest?hours=72&min_bookmakers=4&sharp_only=1` 1× per week. Als meanAbsDiffPp < 0.5pp consistent → NIET swappen (proportional is good enough). Als > 1.0pp → swap default na 1 sprint herzien. |
| **R2 isotonic** | Join-laag live (v12.2.21). Geen fit. | Wacht tot model-Brier endpoint ≥100 joined bets. Dan: implementeer isotonic-fit op (predicted_prob, outcome) + injecteer in epW lookup. |
| **R3 Bayesian dynamic strength** | Brier-endpoint live (v12.2.21). Geen implementatie. | Bekijk model-Brier output. Als model_beats_market voor ≥3 maanden ≥200 bets: NIET implementeren (huidige model wint). Als market_beats_model: 2 weken sprint voor Bayesian update. |

### Strategic deferred (geen actie nodig deze sprint)

| Item | Reden | Trigger om weer op te pakken |
|---|---|---|
| **R5 Live betting** | Doctrine: pre-match Brier moet < 0.22 + CLV > +2% over 200 settled vóór scope-uitbreiding. | Bart laat data zien dat baseline behaald is. |
| **R6 Grotere sports API** | €1000+/mnd Opta vs €5k bankroll = niet realistisch. Betsapi €100/mnd is alternatief, maar geen operator-pijn nu. | Bart heeft signaal dat api-sports data te beperkt is voor specifiek markt-type. |
| **R8 server.js → app-factory** | "Niet urgent". Refactor 7932 regels = grote regressie-bait. Doctrine "monotonic shrink" wordt sowieso bediend door nieuwe lib/-modules. | Wanneer een feature implementatie te zwaar voelt door state-coupling. |

---

## 4. Test- + observability-staat

| Categorie | Pre-audit | Post-audit | Delta |
|---|---|---|---|
| Tests passed | 668 | 736 | +68 |
| lib/-modules | ~45 | ~50 | +5 (devig, sharp-soft-asymmetry, sharp-soft-windows, scheduled-jobs, market-keys, sharp-soft-alerts, bets-pick-join, devig-backtest, auth-codes-store) |
| Admin endpoints | ~20 | +5 (model-brier, devig-backtest, sharp-soft-windows × 2 paden, kept) | +5 |
| Migrations | 4 in audit-window | 4 (v12.2.8, .9, .12, .14) | — |

---

## 5. Conclusie + adviezen

EdgePickr is structureel scherper dan vóór de audit. **Geen P0/P1 issues open.** De resterende deferred items (R5/R6/R8) zijn bewuste keuzes met heldere triggers. Operator heeft nu **objectieve diagnostiek** (Brier · sharp-soft · devig-backtest) om model- en execution-effectiviteit te kalibreren in plaats van te raden.

### Acties voor operator (Bart) komende 14 dagen:
1. Check `/admin/v2/sharp-soft-windows` 1× per dag de eerste week. Als 0 windows: lower threshold (admin-setting later).
2. Check `/admin/v2/model-brier` na 30 settled bets. Beslis op R3 Bayesian.
3. Check inbox notifications type='sharp_soft_alert' — verschijnen ze überhaupt?
4. Run `/admin/v2/devig-backtest` 1× wekelijks. Vergelijk dist over tijd.

### Trigger-events die nieuwe sprint motiveren:
- Brier model > 0.245 en > markt → R3 sprint
- meanAbsDiffPp consistent > 1.0 → R1 swap-sprint
- Operator heeft moeite om nieuwe feature te shippen door state-koppeling → R8 sprint
- 200 settled bets met CLV > +2% en Brier < 0.22 → R5 live-betting research
