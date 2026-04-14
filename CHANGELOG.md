# Changelog

Alle noemenswaardige wijzigingen aan EdgePickr. Formaat: [Keep a Changelog](https://keepachangelog.com/nl/1.1.0/), nieuwste eerst.

## [10.6.3] - 2026-04-14

### Added (one-shot reminder)
- Bet365-limit reminder in `/api/notifications`: toont tussen 19-26 apr 2026 een inbox-alert als Bet365 nog niet terug in `preferredBookies` staat. Code getagd met `// TODO: remove after 2026-04-26`, self-expiring via date-window.

## [10.6.2] - 2026-04-14

### Fixed
- **Dashboard flash voor login**: inline `<head>`-script redirect direct naar `/login.html` als `ep_token` mist. Rendert geen body meer zonder auth.
- **Odds monitor spam**: geen dedup → elke 60 min zelfde alert bij stabiele drift. Nu: in-memory `lastAlerts` Map per bet, re-alert alleen bij Δ ≥3pp drift, richtingswissel (sharp↔fade), of ≥4u na laatste alert. Persistent sharp-moves krijgen alsnog een 4u-heartbeat.

## [10.6.1] - 2026-04-14

### Fixed
- **`/api/notifications` 500**: server crashte op `entry.oldMult.toFixed(2)` bij modelLog entries zonder oldMult/newMult (milestone, signal_tuning, insight types). Nu type-guarded met `hasMult` check, identiek aan frontend fix in v10.3.0.
- **CSP source-map error**: Chart.js probeerde `chart.umd.js.map` op te halen van cdn.jsdelivr.net, geblokkeerd door `connect-src 'self'`. Toegevoegd: `https://cdn.jsdelivr.net` aan connect-src (zelfde origin waarvan we al script laden).
- **Deprecated meta-tag warning**: `<meta name="mobile-web-app-capable">` toegevoegd naast bestaande `apple-mobile-web-app-capable` (Chrome 95+ requires modern tag).

## [10.6.0] - 2026-04-14

### Changed (codebase split)
- `index.html` van 4768 → 4266 regels (-502): LANG dict + `t()`/`applyLanguage()` verhuisd naar `/js/lang.js` (434 regels), AUTH section (`api()`, `getToken()`, `logout()`, `initUserUI()`, push-registratie) naar `/js/auth.js` (70 regels).
- `<script>`-tags toegevoegd vóór de inline JS zodat lang/auth eerst laden — classic-script realm zorgt voor shared top-level scope, 125 `t()` call-sites resolven correct bij runtime.
- `.js` toegevoegd aan `ALLOWED_EXTENSIONS` in server.js + lib/config.js zodat Express static handler de nieuwe files serveert.
- Service worker (`sw.js`) gebruikt geen `caches.open`, dus geen cache-invalidation nodig.
- Tests: 190 passed, 0 failed. Syntax-check op lang.js + auth.js + server.js clean.

### Notes
- Next sessions: verdere splits (pages, live, modals) mogelijk als dit stabiel blijkt. Voor nu conservatief: LANG + auth zijn de zelfvoorzienende modules met duidelijkste grenzen.

## [10.5.3] - 2026-04-14

### Added (Phase 4 i18n)
- ~30 LANG keys (NL + EN) voor toasts, modals, errors: `err_prefix`, `err_network`, `err_connection`, `err_load_failed`, `err_fetch_failed`, `err_unknown`, `err_model_log`, `err_v2_load`, `err_password_empty`, `err_add_bet_empty`, `err_odds_empty`, `loading`, `loading_dots`, `loading_fetch`, `busy`, `confirm_remove_bet`, `confirm_clv_backfill`, `drift_title`, `drift_no_data`, `action_enable`, `action_disable`, `btn_close_live`, `prompt_new_odds`, `prompt_new_units`, `prompt_sport`, `prompt_bookie`, `fill_times_btn`, `bets_updated`, `bets_not_found`.
- Hardcoded NL strings in bet-edit prompts, CLV backfill confirm, operator toggle confirms, password change, loadSupabaseUsage, loadV2Dashboard, toggleOp, loadDriftView, checkResults, backfillTimes, recalcWL, toggleForm, toggleLive vervangen door `t()` calls met placeholder-substitutie waar nodig (`{id}`, `{val}`, `{list}`, `{window}`).

### Note
- Initial-state "Laden..." HTML op 7 plekken (notif-body, dash-quote, rb-list, signal-analysis, experimental-signals, model-log-body, page-settings) blijft static NL. Content wordt overschreven door `loadX()` na login, dus geen zichtbare impact op EN-gebruiker.

## [10.5.2] - 2026-04-14

### Removed (clutter)
- Onboarding tour (`TOUR_STEPS`, `startTour`, `restartTour`, tour-overlay, tour-tooltip HTML/CSS). Reden: werkte niet lekker en voegde niets toe.
- Help-tip tooltips ("?"-icoontjes op Bankroll/ROI/Strike rate/CLV/Variance/Score/Edge). Reden: clutter op dashboard, user kent de metrics al.
- Bijbehorende LANG keys (`tour_*`, `help_*`, `card_tour*`), CSS (`.help-tip`, `.help-text`, `.tour-*`), JS (`injectPickCardHelpTips`, `_origInitUserUI` tour hook).

### Added (Info tab i18n)
- `info_intro`, `info_model_body`, `info_subtitle`, `info_date` keys met NL + EN vertaling via `data-i18n-html`.
- Card header "april 2026" is nu taalgevoelig → "April 2026" in EN.

## [10.5.1] - 2026-04-14

### Changed (score/unit alignment)
- `kellyToUnits()` brackets aangescherpt zodat score 6/10 max 0.75U triggert (was 1.0U). Nieuwe mapping raw-Kelly%: 0.3U <3% · 0.5U 3-6% · 0.75U 6-10% · 1.0U 10-14% · 1.5U 14-20% · 2.0U >20%.
- Inzetstrategie-kaart labels bijgewerkt (€-bedragen identiek, alleen Kelly% ranges).
- Frontend `recUnits` helper in bet-edit modal aligned met nieuwe tiers.
- Reden: half-Kelly + pre-CLV fase vraagt conservatievere staking; auto-stepup en signal-tuning pushen winnende markten vanzelf omhoog als CLV bewijst.

### Tests
- 190 passed (kellyToUnits tier tests ge-refactored naar nieuwe grenzen).

## [10.4.1] - 2026-04-14

### Added (NBA + NFL signal scaffolding — volledig autonoom)
- **NBA `nba_rest_days_diff`**: per scan +2 extra api-sports calls per league (-2, -3 dagen). Berekent rest_days verschil home vs away (1/2/3/4+). Logged in matchSignals + feature_snapshots als `rest_days_home/away/diff`.
- **NFL `nfl_injury_diff`**: per scan +1 api-sports call per league (`/injuries`). Telt out/doubtful/questionable per team. Logged als `injury_count_home/away/diff`.
- **Auto-activatie pipeline**: beide signalen starten op weight=0 (geen scoring impact). `autoTuneSignalsByClv` v10.4.0 auto-promote-from-zero (n≥50 + CLV>0% → weight 0.5) activeert ze automatisch zodra bewezen. Telegram + inbox notification bij activatie. Geen handmatige actie nodig.
- Adj-formules in NBA/NFL scan vermenigvuldigen nu signal-adj × weight → bij weight=0 geen effect, bij weight 0.5+ proportionele invloed.

### Changed
- NBA scan kost ~3 calls extra per league per dag (was: 1 yesterday-call → nu yesterday + -2 + -3)
- NFL scan kost ~1 call extra per league per dag (injuries fetch)

## [10.4.0] - 2026-04-14

### Added (autonome model-evolutie)
- **Kelly-fraction auto-stepup**: KELLY_FRACTION nu dynamisch (default 0.50, max auto 0.75, step 0.05). Verhoogt automatisch bij avg CLV > 2% + ROI > 5% over laatste 200 bets, geen kill-switch in laatste 30d, cooldown 30d. Persistent in calibration store. Telegram + inbox notification bij elke stap. Volledige Kelly (>0.75) vereist handmatige override.
- **Auto-promote signal**: signalen op weight=0 die n≥50 picks halen met avg CLV > 0% worden automatisch geactiveerd op 0.5 (logged-only → live). Symmetrisch met bestaande mute-logic.
- **Status page extended**: 9 services in plaats van 5. Web Push (VAPID), MLB StatsAPI, NHL public API, open-meteo toegevoegd. Gratis APIs tonen ∞ icoon naast plan-naam.
- **Backtest-gate residual model**: `residualModelActive(n, validationStats)` accepteert nu walk-forward Brier-delta. Activatie alleen als delta < 0 (residual model verbetert calibratie).

### Changed
- **RESIDUAL_MIN_TRAINING_PICKS**: 500 → 100. Reden: bij 2 bets/dag was 500 onbereikbaar in praktijk. Backtest-gate vangt overfitting risk.
- **KELLY_FRACTION** is geen const meer maar dynamische runtime-state via `getKellyFraction()`/`setKellyFraction()`. Backwards-compat alias behouden.
- `lib/picks.js` + `server.js` (2x inline) gebruiken nu `getKellyFraction()` ipv hardcoded import.

### Tests
- 190 passed (1 nieuwe: backtest-gate residualModelActive)
- residualModelActive threshold-test bijgewerkt naar 100

## [10.3.1] - 2026-04-14

### Changed (unit sizing granularity)
- `kellyToUnits()` uitgebreid van 3 → 6 tiers: 0.3U / 0.5U / 0.75U / 1.0U / 1.5U / 2.0U
- Brackets in raw-Kelly%: <3% / 3-5% / 5-8% / 8-12% / 12-18% / >18% (half-Kelly intern)
- Inline duplicaten in server.js + lib/picks.js verwijderd → roepen nu kellyToUnits aan (geen drift meer)
- Inzetstrategie UI toont alle 6 tiers met euro-bedragen (€7,50 t/m €50 bij 1U=€25)
- Signal Attribution verhuisd van Data → Model tab (model-state, geen user analytics)
- 6 tests toegevoegd voor nieuwe tiers (189 totaal)

## [10.3.0] - 2026-04-14

### Changed (IA reorganisatie)
- Nieuwe **Model**-tab (admin-only): signal gewichten, markt multipliers, per-sport, model updates samen
- **Inbox** uitgekleed tot puur notificatie-feed (geen overlap meer met data/model)
- **v2 Pipeline Health** verhuisd van Inbox → Status (operational health centraal)
- **Model updates** verhuisd van Info → Model
- `loadInbox()` gesplitst in `loadInbox()` + `loadModelTab()` + `loadAppVersion()`

### Fixed
- Light-mode WCAG contrast: yellow `#f59e0b`→`#b45309`, green `#10b981`→`#047857`, red `#ef4444`→`#b91c1c` (alle 5:1+ AA)
- Model-log renderer crashte op milestone/signal_tuning/insight entries zonder oldMult/newMult — nu type-aware

### Docs
- Info-tab: model uitgelegd herschreven naar quantitative market-disagreement framing
- Databronnen: MLB StatsAPI, NHL public API, OpenWeatherMap, Supabase toegevoegd
- Abonnementen: deprecated rijen + gratis API-bundle verwijderd, sectie toont reële kosten + Render free
- Inzetstrategie: €500 startkapitaal, 1U=€25, max 1/match, max 2/sport, adaptive 5.5-8%, bootstrap tot 100 bets

## [10.2.2] - 2026-04-14

### Added (autonomy completion)
- Inbox notifications bij model-update (CLV autotune signal weight wijzigingen)
- Inbox drift alerts: dagelijkse check van markten met recente CLV verslechtering ≥2%
- 5 notification types totaal: kill_switch, model_update, drift_alert + Telegram CLV milestone + drawdown

## [10.2.1] - 2026-04-14

### Changed (reviewer pivot: observability > bedienbaarheid)
- Operator failsafes vereenvoudigd naar minimal set (master_scan_enabled, market/signal_auto_kill, panic_mode, max_picks_per_day)
- Dashboard UI: 5 toggle-knoppen ipv uitgebreide cockpit
- Panic mode in scan: max 2 picks + alleen PROVEN markten + max 1 per sport
- Drift endpoint: multi-window 25/50/100 vs all-time, per markt+signal+bookie, met sample size + alert min_n

### Added
- `GET/POST /api/admin/v2/operator` — minimale failsafe toggles
- `top_contributions` (top 5 ranked) in why-this-pick attributie
- Datakwaliteit: oldest_feature_snapshot_age_min + avg_bookmaker_count + avg_quality_score

## [10.2.0] - 2026-04-14

### Added (model control, reviewer-roadmap)
- `GET /api/admin/v2/drift?recent=N` — drift detection per markt + signal
- `GET /api/admin/v2/why-this-pick?bet_id=X` — pick attribution + lineage
- `GET /api/admin/v2/data-quality?hours=N` — quality flag aggregaties
- Dashboard UI knoppen: kill-switch toggle, refresh, autotune trigger, drift view

## [10.1.5] - 2026-04-14

### Added
- Bootstrap mode in adaptive MIN_EDGE: bypass per-markt tiers tot ≥100 totaal settled bets
- Voorkomt strangulatie van data-collectie tijdens eerste weken

## [10.1.4] - 2026-04-14

### Fixed (reviewer-advies)
- Adaptive MIN_EDGE gate sluit ook combiPool: geen combo-legs op onbewezen markten

## [10.1.3] - 2026-04-14

### Added
- `autoTuneSignalsByClv()` draait nu dagelijks automatisch na results-check (was alleen via endpoint)
- Alle disciplinemechanismen volledig dynamisch: kill-switch refresh 30 min, adaptive MIN_EDGE 30 min, signal stats dagelijks, CLV autotune dagelijks

## [10.1.2] - 2026-04-14

### Fixed (3e externe code-review)
- HIGH: `/api/picks` lekte ruwe modeldata; nu safePick filter (zelfde als scan-history/analyze)
- MEDIUM: CLV milestone alert nu per markt breakdown (≥10 samples per markt)
- LOW: UX-tak voor 0/1-2 picks ('kwaliteit boven volume' bevestigend signaal)

## [10.1.1] - 2026-04-14

### Added
- Inbox notifications voor kill-switch events (nieuwe blokkades, herstellingen, scan-blocks)

## [10.1.0] - 2026-04-14

### Added (profit-focus)
- **Adaptive MIN_EDGE in scan-pad**: mkP() filtert nu picks onder UNPROVEN/EARLY threshold
- `GET /api/admin/v2/per-bookie-stats`: ROI/CLV per bookmaker
- CLV health alerts via Telegram (elke 25 nieuwe settled CLV bets)
- Soft drawdown alert (geen pause, alleen warn) bij <-15% over 7d

## [10.0.3] - 2026-04-14

### Added
- Signal-level kill-switch: avg CLV ≤ -3% over ≥50 samples → weight = 0
- Adaptive MIN_EDGE helper (3 tiers: PROVEN/EARLY/UNPROVEN)

## [10.0.2] - 2026-04-14

### Fixed
- HIGH: model IP-leak via `/api/scan-history` en `/api/analyze` (safePick whitelist)
- MEDIUM: POTD diversification bypass (selected:true/false flag)
- LOW: ontbrekende Content-Security-Policy header

## [10.0.1] - 2026-04-14

### Fixed (2e externe code-review)
- Kill-switch enforcement (was alleen detection)
- Diversification: max 1 pick/match, max 2 per sport
- afGet timeout via AbortController (8s)
- Scan history bewaart nu allPicks (audit)

## [10.0.0] - 2026-04-14

### Major release: complete v2 architecture
EdgePickr is gepivotteerd van "scan-app met calibratie" naar een echte
**quantitative market-disagreement engine** met point-in-time snapshots,
residual modeling boven market consensus, en self-learning via CLV.

### Added (v2 completion)
- `signal_stats`, `execution_logs`, `training_examples`, `raw_api_events` tabellen (4 reviewer-tabellen die in v9.10 nog ontbraken)
- Signal stats dagelijkse refresh job: aggregeert avg CLV/PnL/lift per signal
- Training examples writer: koppelt feature_snapshots aan settled outcomes voor latere model training
- Execution logs schema voor toekomstige bookie-API slippage tracking
- `POST /api/admin/v2/training-examples-build` — bouw training set uit settled bets
- `GET /api/admin/v2/signal-performance` — historische signal stats per signal_name

### Architecture
- 11/12 reviewer-tabellen geïmplementeerd (12e = bets, was al aanwezig)
- 7-layered pipeline: ingest → feature store → consensus → model → pick engine → execution → learning
- Pure helpers in `lib/model-math.js` (geen test-mirrors meer)
- Snapshot writers in `lib/snapshots.js` (allemaal fail-safe)

### Migration
- `migrations/v10.0.0_v2_completion.sql` — laatste 4 tabellen

### Tests
- 171/171 pass (3 nieuwe security regressies + clamp validatie)

## [9.10.0] - 2026-04-14

### Added
- **Per-signal CLV autotune** (`autoTuneSignalsByClv`): pas signal weights aan o.b.v. avg CLV ipv W/L (sneller signal). `POST /api/admin/v2/autotune-clv`
- **Kickoff-window polling** (t-6h/t-1h/t-15m): elke 5 min check fixtures binnen ±5 min van die kickoff-relatieve momenten, schrijf snapshot
- **Auto-retraining scheduler**: wekelijkse check of (sport,markt) ≥500 candidates heeft, log kandidaten voor residual training. Echte training-pipeline placeholder (TODO).
- **Frontend admin v2 dashboard** in inbox: snapshot counts, pick candidates, CLV per sport, walk-forward, kill-switch

### Changed
- Inbox krijgt nieuwe "🧪 v2 Pipeline Health" kaart met refresh-button

## [9.9.0] - 2026-04-14

### Added
- **Kill-switch enforcement** met auto-disable bij avg CLV < -5% over ≥30 settled bets
- **Walk-forward backtest** endpoint: Brier + log loss + calibration buckets per sport
- **Hierarchical calibration** met Bayesian smoothing (global → sport → market → league)
- **Residual model framework** skeleton (logistic regression delta, activeert bij ≥500 picks/markt)
- Admin endpoints: `/api/admin/v2/kill-switch`, `/api/admin/v2/walkforward`

### Changed
- Architectuur opgeschoond: images naar `img/`, docs naar `docs/`

### Tests
- 9 nieuwe (169 totaal): hierarchical multiplier clamping, residual sigmoid, sample-size threshold

## [9.8.0] - 2026-04-14

### Added
- `/api/admin/v2/clv-stats` endpoint: per sport + (sport, markt) bucket → avg CLV%, % positief, total PnL
- Kill-switch eligibility detection: WATCHLIST tier (-5% < CLV < -2%) en AUTO_DISABLE (CLV < -5%)
- CLV als hoofd-KPI (winrate is te noisy bij kleine samples)

## [9.7.1] - 2026-04-14

### Added
- Pick candidates voor alle 6 sporten (basketball, baseball, NFL, handbal, football)
- `recordMl2WayEvaluation` helper voor 2-way ML pattern hergebruik
- Admin endpoints `pick-candidates-summary` en `snapshot-counts`

## [9.7.0] - 2026-04-14

### Added (Sprint 2: Pick Pipeline)
- `model_versions`, `model_runs`, `pick_candidates` Supabase tabellen
- Hockey scan schrijft model_run + pick_candidates met expliciete rejected_reason categorisatie
- Helpers: `registerModelVersion`, `writeModelRun`, `writePickCandidate`

### Migration
- `migrations/v9.7.0_v2_pick_pipeline.sql`

## [9.6.1] - 2026-04-14

### Added
- Football snapshot integratie (1X2 consensus, h2h canonicalisatie)
- Fixture snapshot polling job (elke 90 min, 30 fixtures cap)

## [9.6.0] - 2026-04-14

### Added (Sprint 1: v2 Foundation)
- 4 snapshot tabellen: `fixtures`, `odds_snapshots`, `feature_snapshots`, `market_consensus`
- `lib/snapshots.js` met fail-safe writers (Supabase-down = scan gaat door)
- Integratie in alle non-football scans
- Quality scores (bookmaker count + overround penalty)

### Migration
- `migrations/v9.6.0_v2_foundation.sql`

## [9.5.0] - 2026-04-14

### Refactor
- Pure helpers naar `lib/model-math.js` zodat tests echte productie-code testen (geen mirrors meer)
- NHL shots-differential signal via `api-web.nhle.com` (publiek, gratis)

### Added
- `shotsDifferentialAdjustment`: SF% diff × 0.45, clamped ±3%, vereist ≥20 GP

## [9.4.1] - 2026-04-14

### Fixed (uit externe code-review)
- 2FA verify-code controleert nu account.status (blocked/pending) vóór JWT
- Scheduler slaat handles op in userScanTimers[admin.id] → geen dubbele scans
- PUT /api/bets/:id herberekent wl bij odds/units edit van settled bet

## [9.4.0] - 2026-04-14

### Added
- Hockey team totals via Poisson (📈/📉)
- Voetbal Double Chance (1X/X2/12) afgeleid uit 1X2 consensus
- MLB starting pitcher signal via `statsapi.mlb.com` (free public API)
- F5 (1st 5 innings) markt parser + pick generation met pitcher 3x versterkt

## [9.3.0] - 2026-04-14

### Added
- **Market-derived probability toolkit**: `devigProportional`, `consensus3Way`, `deriveIncOTProbFrom3Way`, `modelMarketSanityCheck` — allemaal getest (26 nieuwe unit tests, 108/108 totaal).
- **Model-vs-market sanity check** voor NHL 2-way ML: pick wordt alleen getoond als model-prob binnen 4% van market-derived inc-OT prob zit. Voorkomt dat we picks op overschatte edges plaatsen.
- **Sanity check op 3-way Poisson picks** (hockey + handbal): devigged market 3-way consensus vergeleken met Poisson output. Skip bij divergentie > threshold.

### Changed
- NHL 2-way ML terug actief, maar met dubbele guardrail: (1) bookie moet OT-inclusief zijn (Bet365/Pinnacle/DK), (2) market-sanity check moet passen.
- `NHL_OT_HOME_SHARE = 0.52` en `MODEL_MARKET_DIVERGENCE_THRESHOLD = 0.04` als expliciete defaults — later dynamisch uit settled bets te calibreren.

### Technical
- Pure helpers gemirrord in `test.js` voor isolated testing.
- Safety: alle nieuwe helpers geven null bij invalid input, handle stringified numbers, renormalize non-normalized probs.

## [9.2.1] - 2026-04-14

### Fixed
- NHL 2-way ML (incl-OT) tijdelijk uitgeschakeld omdat api-sports feed "Home/Away" ambigu was tussen 60-min-met-push en inc-OT.
- ML parser strict: alleen bet-id 1 met exact 2 values {Home, Away} wordt als 2-way ML herkend.

## [9.2.0] - 2026-04-14

### Changed
- **Preferred-bookies edge-evaluatie**: `bestFromArr` filtert nu op user's preferredBookies. Edges worden berekend met alleen odds van jouw bookies; consensus blijft uit alle bookies (market-truth).
- **Final-only rendering**: picks verschijnen pas als hele scan klaar is (geen flicker meer van football-first dan multi-sport-update).

### Removed
- Live scan uit prematch flow (was legacy). Geen "Live check geen situaties" telegram meer.

## [9.1.8] - 2026-04-14

### Fixed
- Hockey 2-way ML filter: bookie-selectie gebeurt nu VOOR `bestFromArr` ipv erna. Voorkomt dat Unibet hoogste prijs had en de hele pick dropt.

## [9.1.7] - 2026-04-14

### Added
- **Settings → Bookies**: toggle checkboxes voor welke bookies je gebruikt. Default: Bet365 + Unibet.
- `GET /api/debug/odds?sport=hockey&team=...` — dumpt raw bookmaker data + markeert 3-way markten.

### Fixed
- Modal stake gebruikt nu `userSettings.unitEur` ipv hardcoded 10 (0.3 × 25 = €7.50 klopt).

## [9.1.6] - 2026-04-14

### Added
- **3-way ML (60-min regulation)** voor hockey + handbal via Poisson goal model.
- `poisson3Way(expHome, expAway)` helper — bivariate Poisson voor P(home>away), P(tie), P(away>home).
- `parseGameOdds` herkent 3-way markten (3 values Home/Draw/Away) als aparte `threeWay` array.
- Settlement logica voor 60-min markten (gebruikt `regScoreH`/`regScoreA`, niet inclusief OT).
- `fetchCurrentOdds` ondersteunt 3-way markets voor CLV tracking.

### Changed
- `detectMarket` keyt `home60`/`draw60`/`away60` apart zodat 60-min picks niet mengen met inc-OT in calibratie.

## [9.1.5] - 2026-04-14

### Fixed
- Hockey 2-way ML: `homeOddsOT`/`awayOddsOT` pre-filter voor 60-min-only bookies (Unibet, Toto, BetCity, Ladbrokes). Ons model is inc-OT; hun ML settlet op 60-min → edge werd overschat.

## [9.1.0 - 9.1.4] - 2026-04-14

### Added
- Sport-bucket fix in calibration: non-football scans geven sport mee aan mkP.
- `normalizeSport()` mapping Voetbal/IJshockey/Honkbal → canonical slug.
- Inbox "Per Sport" card met win rate per sport.
- Scan-tijden accepteren HH:MM formaat ipv hele uren. Default 07:30.
- CLV backfill knop in Mijn Bets UI.
- CLV backfill diagnostics + probe endpoint (`GET /api/clv/backfill/probe`).
- CLV strict bookie match: geen fallback naar Bet365 als jouw bookie niet beschikbaar.

## [9.0.3] - 2026-04-14

### Fixed
- Analyzer vindt nu niet-gescande wedstrijden: threshold versoepeld (100 → 70) en beide teams fuzzy ≥40.
- Analyzer zoekt gisteren/vandaag/morgen (Amsterdam-tz) voor nachtwedstrijden.

### Added
- Analyzer multi-sport support: herkent hints (`nhl`, `nba`, `mlb`, `nfl`, `handbal`, …) en valt zonder hint terug op football + max 3 andere sporten (budget-bewaking).
- `POST /api/clv/backfill` (admin-only): vult `clv_odds` + `clv_pct` achteraf voor bets waar de scheduled check faalde. Rate-limited op 200ms/bet. Schrijft notificatie per succesvolle backfill.

### Docs
- README.md herschreven voor v9.0 (multi-sport, Supabase, CLV backfill).
- CHANGELOG.md toegevoegd.

## [9.0.2] - 2026-04-14

### Fixed
- Pre-match en CLV checks werken nu ook voor nachtwedstrijden: `findGameId` zoekt gisteren/vandaag/morgen (Amsterdam-tz).
- `fixture_id` wordt opgeslagen bij bet-creatie zodat checks na server-herstart betrouwbaar zijn.
- Mijn Bets sorteert chronologisch (19:00 vandaag vóór 01:00 morgen).

### Added
- Automatische CLV retry 5 min later als eerste poging faalt.
- Falende pre-match/CLV checks krijgen een notificatie in de inbox.

## [9.0.1] - 2026-04-14

### Fixed
- CLV fuzzy match: Egyptische clubs, accented namen en prefix-afwijkingen matchen nu correct.
- Analyzer rejectt live wedstrijden (geen pre-match analyse mogelijk).

### Added
- Scan history admin-view (alle users zichtbaar).
- Unit-size logging in Telegram-picks.
- NET Units kolom in tracker.

## [9.0.0] - 2026-04-13

### Added
- Extra markten per sport: NRFI/YRFI (baseball), 1st Half/1st Period Over-Under en Spread, Odd/Even totaal.
- Sport-dropdown in bet-modal + editable in tracker + Handball optie.
- Multi-sport scanner stuurt nu één Telegram-bericht ipv één per sport.

### Fixed
- Bankroll berekent alleen settled bets (open bets tellen niet mee).
- Variance-bug: expected wins werd foutief afgerond.
- CLV display: 0% werd als leeg getoond (gefilterd).
- API usage per sport wordt persistent opgeslagen in Supabase.

## [8.6.0] - 2026-04-13

### Added
- Alle features (pre-match, CLV, calibratie, signal tuning) werken nu voor 6 sporten.

## [8.5.0] - 2026-04-13

### Added
- API usage per sport zichtbaar in status-pagina.
- Dagwinst-widget op dashboard.
- Light theme.

### Fixed
- Odds-drift detectie false positives.

## [8.4.0] - 2026-04-13

### Added
- Sport-iconen in lijsten.
- Bankroll-projectie met open bets meegenomen.

### Fixed
- 6 diverse bugfixes (modal units, scanner top-5 cap, BTTS Nee/Ja, draw/DNB).

## [8.3.0] - 2026-04-13

### Added
- Alle sport-scanners kijken tot morgenochtend 10:00 voor nachtwedstrijden.
- 82 tests (endpoints, calibratie, signals, security).
- Dynamische seizoenen: nooit meer handmatig updaten.

### Fixed
- Hockey + handbal seizoen-formaat (integer ipv split-string).

## [8.2.0] - 2026-04-12

### Added
- Advanced stats per sport (PPG, rebounds, xG, streaks, home dominance).
- Data confidence-score weegt signalen op basis van databronnen.
- Research-based signal-gewichten.

## [8.1.0] - 2026-04-12

### Added
- Baseball + NFL + Handball scanners.
- api-football Pro → api-sports All Sports migratie (6 sporten).

## [8.0.0] - 2026-04-11

### Added
- Multi-sport: NBA + NHL scanners.
- Business plan update (All Sports plan).

---

Oudere versies (v3.x–v7.x): zie git history.
