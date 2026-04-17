# EdgePickr — Code Review Onboarding

Laatste update: 2026-04-17 (v10.12.25)

Dit document is voor externe reviewers. Lees dit eerst; het bespaart je enkele uren aan "waarom staat dit zo?"-vragen.

## 1. Wat is dit project

EdgePickr is een **private single-operator betting terminal** voor Bart. Geen SaaS, geen multi-tenant, geen platform. Het doel is niet "mooi product" maar: **structureel de sportsbetting-markt verslaan via CLV, execution quality en bankroll-discipline.**

Canonieke doctrine: [`docs/PRIVATE_OPERATING_MODEL.md`](PRIVATE_OPERATING_MODEL.md). Lees minstens secties 1–10. Andere relevante docs:
- [`REPO_STRUCTURE.md`](REPO_STRUCTURE.md) — waarom de `lib/` / `lib/integrations/` / `lib/runtime/` split
- [`RESEARCH_MARKETS_SIGNALS.md`](RESEARCH_MARKETS_SIGNALS.md) — markt- en signaal-onderzoek
- [`CODE_REVIEW_CLAUDE.md`](CODE_REVIEW_CLAUDE.md) + [`CODE_REVIEW_CODEX_2026-04-17.md`](CODE_REVIEW_CODEX_2026-04-17.md) — vorige audits

## 2. Architectuur samengevat

```
Browser (PWA)  ─HTTPS──▶  server.js (Express, Node 20)  ──▶  Supabase PostgreSQL (RLS enabled)
                                │
                                ├──▶  api-sports.io (odds, fixtures, stats, predictions)
                                ├──▶  ESPN scoreboard (live scores)
                                ├──▶  MLB StatsAPI (probable pitchers)
                                ├──▶  NHL web API (goalie preview)
                                ├──▶  Open-Meteo (weather)
                                └──▶  Web Push (VAPID) + Resend (2FA email)

Hosting: Render.com free tier. Single process, single replica.
```

### Module indeling
- **`server.js`** (~12k regels, bekende monoliet — zie §6 tech debt) — Express routes, scan orchestratie, alle sport-specifieke logica
- **`lib/`** — pure domein-modules, testbaar zonder HTTP:
  - `model-math.js` · Poisson, Kelly, Bayesian shrinkage, FDR, Brier, log-loss
  - `picks.js` · `buildPickFactory` + `mkP()`, pick-assembly
  - `odds-parser.js` · odds normalisatie, preferred-bookie filtering
  - `execution-gate.js` · Kelly-multiplier op basis van stale-price / preferred-gap
  - `line-timeline.js` · price-memory query + derived metrics
  - `playability.js` · "is deze markt speelbaar?" filter
  - `calibration-monitor.js` + `calibration-store.js` · Brier per signal × sport × markt × window
  - `correlation-damp.js` · correlated-bet Kelly reductie
  - `stake-regime.js` · **unified stake-regime engine (NIEUW · v10.12.21/23)** — beslist Kelly + unit multiplier uit CLV/ROI/drawdown/regime-shift
  - `walk-forward.js` · time-aware split helper voor validatie
  - `db.js` · Supabase primitives (loadUsers, saveUser, readBets, writeBet, calcStats)
  - `auth.js` · JWT + bcrypt (klein, wordt grotendeels in server.js hergebruikt)
  - `config.js` · ENV + globals + rate-limit map
- **`lib/integrations/`** — externe bronnen + scraper base
  - `scraper-base.js` · SSRF-safe fetch + circuit breaker
  - `nhl-goalie-preview.js`, `sources/*.js` · per-provider adapters
- **`lib/runtime/`** — kleine operator-workflows
  - `daily-results.js`, `live-board.js`, `operator-actions.js`, `scan-gate.js` (post-scan execution-gate pass)
- **`index.html`** (~5.7k regels, monoliet — zie §6)
- **`js/lang.js`** (NL + EN strings)
- **`login.html`** · separate login page
- **`test.js`** (~5.8k regels, 523 tests) · monolithische suite; split is backlog item

## 3. Doctrine-keuzes die eruit kunnen zien als bugs maar intentioneel zijn

1. **Singles only, max 5 picks per scan.** Niet limitatie — filosofie. Combi's bestaan in de code (`combiPool`) maar zijn achter een streng correlation-damp gate.
2. **Preferred bookies = execution truth.** Pick.bookie KOMT altijd uit operator's `preferredBookies` setting (Bet365, Unibet default). Sharp-refs (Pinnacle, William Hill) doen WEL mee aan consensus-berekening maar NOOIT aan de pick.bookie. Als geen preferred-bookie de markt biedt → pick surface NIET. Dit is niet streng genoeg ge-audit tot v10.12.20/22 — recent gefixt in BTTS, DNB, Double Chance, AH.
3. **Stake-regime engine is de single source of truth voor Kelly + unit** (v10.12.23 live). `evaluateKellyAutoStepup` is deprecated stub die `{stepped: false, reason: 'deprecated_use_stake_regime'}` retourneert. `getDrawdownMultiplier()` retourneert 1.0 omdat drawdown ingebakken zit in regime.kellyFraction.
4. **Shadow signals default weight = 0.** Elk nieuw signal (bv. `fixture_congestion_home_tired`, `lineup_confirmed_both`) komt in pick.signals array maar beïnvloedt geen stake tot `autoTuneSignalsByClv` (v10.12.11 BH-FDR gated) 'm promoveert.
5. **RLS is enabled op alle tabellen + service_role key gebruikt.** Dat betekent `requireAuth` middleware is de primaire authorization-gate — niet RLS. RLS is defense-in-depth voor als de anon key ooit lekt.
6. **Global rate-limit map in memory** (niet Redis). Single-operator = single-process = voldoende. Cleanup interval elke 10 min.
7. **Telegram is intentioneel verwijderd** in v10.12.0. Web Push (PWA) + Supabase `notifications` tabel zijn het enige operator-alert-kanaal. Als je Telegram-referenties ziet in release-notes binnen `index.html`, zijn dat historische entries (v10.4.0, v10.1.3) die niet worden herschreven.

## 4. Waar de BIG architectural keuzes zitten

### Scan flow (read this first)
1. `POST /api/prematch` → `runFullScan()` (server.js:7704+)
2. `runFullScan()` doet per sport:
   - Fetcht fixtures + odds via `afGet()` (api-sports)
   - Builds pick candidates via `mkP()` uit `buildPickFactory()`
   - Elk pick krijgt `_fixtureMeta` ({fixtureId, marketType, selectionKey, line})
3. **Post-scan gate pass** (`lib/runtime/scan-gate.js:applyPostScanGate`) voor elke sport:
   - Bulk-queryt `odds_snapshots` voor alle fixtures → bouwt timelines
   - Derived metrics → `assessPlayability` check → `applyExecutionGate` dempt kelly of skipt
4. Merge alle sport-picks → kill-switch filter → correlation-damp → sort → top-5 slice
5. Save to `bets` (via user) + `scan_history` + notify via web-push

### Stake decision flow
1. `recomputeStakeRegime()` aan start van elke scan + bij boot
2. `evaluateStakeRegime(input)` beslist regime (exploratory / standard / scale_up / drawdown_soft / drawdown_hard / consecutive_l / regime_shift)
3. `setKellyFraction(regime.kellyFraction)` sync't globale Kelly → `mkP` → `calcKelly` gebruikt deze
4. `getActiveUnitEur()` × `regime.unitMultiplier` — stake schaalt mee

### Learn flow (closed loop)
1. Bet settled (W/L) via `PUT /api/bets/:id`
2. CLV recompute tegen Pinnacle closing line (`odds_snapshots` query)
3. Per scan tick: `updateCalibrationMonitor()` schrijft Brier + log-loss naar `signal_calibration` per (signal, sport, market, window)
4. Scheduled autotune (6h cron): `autoTuneSignalsByClv()` met BH-FDR gate + Brier-drift gate → promoveert/muteert signals
5. Volgende scan gebruikt nieuwe weights → cycle herhaalt

## 5. Kritieke bestanden + startpunten

| Wanneer je dit wil reviewen... | Start bij |
|---|---|
| Scan-orchestratie + per-sport flows | `server.js` line 7704 (`runFullScan`), daarna de 6 sport-scans rond lines 2494 (basketball), 3049 (hockey), 3797 (baseball), 4381 (NFL), 4830 (handball), 5152 (football) |
| Stake-decision math | `lib/stake-regime.js` (enkel bestand, klein, pure) |
| Execution-gate wiring | `lib/runtime/scan-gate.js` → `lib/execution-gate.js` → `lib/line-timeline.js` |
| Signal-weighting + autotune | `server.js` line 1005 (`autoTuneSignalsByClv`) + `lib/model-math.js` (binomial p-value + BH FDR + shrinkage) |
| Auth + RLS | `server.js` line 519–560 (`requireAuth`, `PUBLIC_PATHS`), `lib/db.js:loadUsers` |
| Bet storage schema | `docs/migrations-archive/v9.6.0_v2_foundation.sql` + `v10.0.0_v2_completion.sql` + `v10.10.7_unit_at_time.sql` + `v10.10.21_sharp_clv.sql` |
| Security hardening | Zie `CHANGELOG.md` v10.12.1 voor het security batch overzicht |

## 6. Bekende tech debt (geen verrassing voor ons)

1. **`server.js` monoliet (~12k regels).** Doctrine-prioriteit Fase 1 "scanner-core hard maken"; splitsing naar route-files is backlog item, wordt per-slice gedaan in volgende sprints.
2. **`index.html` inline JS/CSS (~5.7k regels).** Niet gesplitst in componenten. Single-operator UI met zware PWA-eisen; herbouw in framework is een Phase F item.
3. **Server.js test coverage laag (~10%).** `lib/*` coverage is 80-95% (`.c8rc.json` configured, drempels niet enforced). Integration-tests voor `runFullScan` zijn Phase E.22 backlog.
4. **6 uncovered lib modules** per Codex review: `auth.js`, `config.js`, `db.js`, `leagues.js`, `weather.js`, `api-sports.js`. Wordt stap-voor-stap toegevoegd.
5. **`bet_id` is per-user synthetic integer** (max+1 per user). Schema-migratie naar UUID is open backlog item (Punt 19 in CLAUDE.md). Cross-user corruptie-risico mitigated door user-scoping in alle endpoints.
6. **Modal-renderer bookie-label mystery** (v10.12.18 review note) — operator meldde modal toonde "Bet365" terwijl card "Unibet" showde en reason-string "William Hill". Niet kunnen reproduceren zonder screenshot; open vraag.
7. **Bet365-limit reminder hardcoded** naar 2026-04-26 expiry (server.js:10279). Zelf-cleaning na 26 apr maar TODO staat.
8. **Walk-forward validator bestaat** maar autotune leest nog uit `signal_calibration` (full-sample). Phase B.4b is migratie naar walk-forward Brier.

## 7. Hot spots waar ik extra ogen wil

Reviewer priority areas (niet extra-risicovol, maar wel critical):

1. **`lib/stake-regime.js`** — zeer nieuw (v10.12.21), live sinds v10.12.23. Thresholds (exploratory N=50, scale_up CLV≥2%/ROI≥5%, drawdown_hard ≥30%) zijn conservatief gekozen maar NIET empirisch gevalideerd tegen historisch data. Geef je beste interpretatie vanuit sportsbetting doctrine: te streng / te los / te traag / te snel?
2. **`lib/runtime/scan-gate.js` `applyPostScanGate`** — enige wire-point van execution-gate + playability. Review op: atomicity, error-swallowing, race conditions met bulk-query.
3. **Preferred-bookie audits** — v10.12.20/22 fixten BTTS, DNB, DC, AH in football. Andere sporten (basketball, hockey ML, baseball, NFL, handball) gebruiken `bestFromArr()` of `analyseTotal()` die WEL preferred-gated zijn, maar verify dat dit klopt onder werkelijke scan-output.
4. **`autoTuneSignalsByClv` (server.js:~1005)** — nu heeft 3 gates (kill-switch CLV, Brier drift, BH FDR). Interactie tussen die gates is expliciet gecodeerd (priority order in comments) maar kan een reviewer een interactie ontdekken die we missen.
5. **`recomputeStakeRegime()` triggers** — boot + elke scan. Een bet settlement (W/L) triggert het NIET direct. Als admin handmatig bets labelt W tijdens de dag, wordt de regime pas geherberekend bij de volgende scan. Mogelijk een latent issue.

## 8. Runbook / operational

### Deploy
```
git push origin master
# Render deployt automatisch. Geen handmatige build.
# Niet deployen tijdens 07:30, 14:00, 21:00 CET (scan-windows).
```

### Env vars (Render dashboard — niet in `.env.example`)
```
SUPABASE_URL, SUPABASE_KEY  (service_role)
JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
API_FOOTBALL_KEY
VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_CONTACT
RESEND_KEY  (2FA email)
```

### Migrations
```
node scripts/migrate.js docs/migrations-archive/<file>.sql
# Destructive-query blocker (DROP/TRUNCATE/DELETE) is ingebouwd.
```

### Recovery
- Supabase has daily auto-backups (free tier).
- Restore procedure not yet tested (Codex open item §14.R2.B).
- Operator alerts route ONLY through Web Push → PWA → inbox. No Telegram (removed v10.12.0).

## 9. Hoe te valideren dat alles nog werkt

```bash
npm install
npm test                      # 523 tests
npm run test:coverage         # c8 report (niet geforceerd)
npm run audit:high            # npm audit level=high
node -c server.js             # syntax-check
```

GitHub Actions CI runs these automatically on every push.

## 10. Vragen die we graag hebben van reviewers

- Is de stake-regime engine te conservatief op `scale_up` (N=200 + CLV≥2% + ROI≥5%)? Voorbeelden van professional books waar triggers agressiever of meer geleidelijk zijn?
- Zijn er correlation-patterns die we missen (bv. dezelfde team speelt 2x in 3 dagen)? Zie `lib/correlation-damp.js`.
- Edge-decay modeling — momenteel 90d vs 365d Brier drift. Reviewer-suggesties voor alternatieve change-point detection?
- Zijn er sporten waar execution-gate thresholds (3.5% preferred gap → kelly ×0.6) onder/over-gekalibreerd lijken?

Welkom en bedankt!
