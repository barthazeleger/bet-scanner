# Changelog

Alle noemenswaardige wijzigingen aan EdgePickr. Formaat: [Keep a Changelog](https://keepachangelog.com/nl/1.1.0/), nieuwste eerst.

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
