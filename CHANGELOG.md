# Changelog

Alle noemenswaardige wijzigingen aan EdgePickr. Formaat: [Keep a Changelog](https://keepachangelog.com/nl/1.1.0/), nieuwste eerst.

## [10.8.15] - 2026-04-15

### Fixed
- **Notificatie-badge "1" bleef hangen ondanks dat model-log gezien was**: `modelLogSeen` werd alleen geset vanuit `loadNotifications()` — openen van Info/Model-tab (`loadModelLog()`) updatete de seen-ts niet. Nu wordt de seen-ts geset op de meest recente model-update zodra `loadModelLog()` de items rendert, gevolgd door een directe `loadNotifications()` refresh.
- **Analyzer respecteerde `preferredBookies` niet**: `/api/analyze` haalde picks uit `lastPrematchPicks` + scan history zonder user-bookie filter. Je kreeg dus een pick terug op William Hill terwijl je alleen Bet365/Unibet had. Nu filtert de endpoint eerst op user's bookies; als er alleen picks bestaan buiten je set geeft hij een expliciete waarschuwing + de pick-lijst aan welke bookies ze wel hadden.

### Added
- **Pure edge naast damped edge op pick card**: bij signaal-damping (bv. baseball moneyline ×0.28) leek "59% kans + 1.88 odds → edge +6.2%" raar, want pure EV-edge zou +11.9% zijn. Card toont nu "Edge +6,2% (pure 11,9%)" met tooltip die de damping uitlegt. Modal deed dit al (v10.8.11), card trok gelijk.
- **Experimental signals tonen aantal gelogde bets + WR%**: naast ACTIEF/LOGGED-ONLY-badge zie je "N bets · WR X%" per signal, gekleurd op sample size (grijs <10 · geel 10-50 · groen ≥50). Data komt uit `/api/signal-analysis` (settled bets met signal-tracking).
- **Odds drift scope toggle**: "Mijn bets" (default) filtert naar fixtures waar je zelf op hebt gelogd — voorheen toonde de view ook baseball games die je nooit aanraakte. "Alle fixtures" knop blijft beschikbaar voor brede data (meer samples per bucket). Endpoint accepteert `?scope=mine|all`.
- **Cron heartbeat + scheduler-status**: elke cron-tik schrijft nu een `cron_tick` notificatie naar Supabase zodat je achteraf kan zien of de scheduler überhaupt vuurde. Nieuwe endpoint `/api/admin/scheduler-status` toont admin's geconfigureerde scan-tijden + volgende fire-time per slot + aantal actieve timers. Bedoeld om te onderscheiden tussen "scheduler stilstand" en "scan draaide maar tg()/push faalde" — relevant voor ontbrekende 21:00 notificaties.

### Changed
- Startup logt nu admin's scan-tijden + `scanEnabled` state zodat je in Render logs direct ziet welke tijden gepland staan.

## [10.8.14] - 2026-04-15

### Added
- **Odds drift dashboard** — nieuwe Data-tab kaart "📉 Odds drift" toont per sport + markt + uur-vóór-kickoff bucket (0-2h / 2-6h / 6-12h / 12-24h / 24-48h / 48h+) de gemiddelde prijs-beweging t.o.v. de closing line. Groen = odds waren vroeger hoger (vroege entry beter), rood = later inzetten gaf betere prijs. Kolom "Beste entry" flaggt de optimale bucket per markt. Endpoint `/api/admin/odds-drift?days=14` met min samplegrootte 5 per bucket.

## [10.8.13] - 2026-04-15

### Fixed
- **Scheduled scans sturen nu ook notificaties**: voorheen deed `scheduleScanAtHour` alleen `runPrematch()` (football, geen Telegram/push). Verklaart waarom je geen 14:00 notificatie kreeg.
- **Scheduled scans doen nu de volle multi-sport pipeline**: basketball + hockey + baseball + NFL + handball werden overgeslagen door cron — alleen UI-triggers deden alle 6 sporten.

### Changed
- **Refactor: `runFullScan()` shared function**. Pipeline geëxtraheerd uit `app.post('/api/prematch')` route zodat handmatige én cron scans identiek draaien — multi-sport, kill-switch, diversification, pick-selectie, tg() notificatie, scan-history save. Route is nu dunne SSE wrapper.
- Cron-scan gebruikt admin's `preferredBookies` setting voor consistente bookie-filter met UI.

## [10.8.12] - 2026-04-15

### Fixed
- **"See also" secondaries verdwenen na re-render**: in `renderPicks()` werd `el._picks = dedupedPicks` gezet (alleen primaries). Bij re-render (via `loadBets()` voor Gelogd-chip fix) gingen secondary BTTS/O2.5 picks verloren. Nu `el._picks = picks` (origineel, incl secondaries) — renderPicks dedupt opnieuw.
- **Auto-refresh pakte nog steeds geen nieuwe scans op**: cache-bust query param (`?_=<ts>`) op `/api/scan-history` fetch + server stuurt nu `Cache-Control: no-store`. Dekt browser + eventuele CDN edge-cache.

## [10.8.11] - 2026-04-15

### Fixed
- **Modal edge matcht nu card edge bij ongewijzigde odds**: v10.8.10's damping via `origUnits / pureRec_bucket` gaf 0.5 waar werkelijke scanner-damping ~0.38 was (Luton: card 7% vs modal 9.2%). Nu gebruikt modal de **stored `modalPick.edge`** als authoritative anker en schaalt proportioneel bij odds-verandering: `dampedEdge_new = origEdge × (pureEdge_new / pureEdge_orig)`. Luton:
  - 1.91 unchanged → modal toont 7% (= card)
  - 1.86 → 5.8% (7 × 15.3/18.4)
  - 1.80 → 4.4% (onder MIN_EDGE — adverse blijft gelden)
  Fallback naar bucket-inversie als `modalPick.edge` niet aanwezig is (oudere picks).

### Tests
3 nieuwe tests voor origEdge-based damping + fallback. Totaal **254 tests, 0 failed** (was 251).

## [10.8.10] - 2026-04-15

### Fixed
- **Modal toont nu gedempte edge (scanner-proxy)**: voorheen toonde modal pure Kelly-edge (bv 18.4% bij Luton 1.91) terwijl de pick-card gedempte edge van 7% toonde. Dat was inconsistent — "als 18.4% echt was, had scanner hem hoger gerankt". Nu: `dampedEdge = edge × (origUnits/pureRec_at_origOdds)`. Luton 1.91 → 9.2% effectief, bij 1.80 → 5.8% effectief (bijna onder MIN_EDGE). Bij significante damping (<0.95) toont modal ook de pure edge erachter in muted tekst.
- **Payout-boxen bleven leeg na advice-update**: stake/uitbetaling/winst werden berekend aan begin van `updatePayout()` terwijl units pas NA de advice-compute werden bijgesteld → boxen toonden €—. Nu `writePayout(advice.recUnits)` na elke advies-return.
- **Auto-refresh pakte nieuwe scan niet altijd op**: interval van 5min was te lang bij actieve sessies, en baseline-init via 2s timeout kon misgaan. Nu 90s interval, extra `window.focus` listener, en microtask-gebaseerde baseline die direct klaar is zodra `scanHistory` gevuld is.

### Changed
- **Adverse threshold verlaagd van -6% naar -5%**: 5.8% line-move (Luton/Padres) was eerder nog "moderate" (0.3U gehalveerd). Voelde te lief — gebruiker wil 1.91→1.80 als ongeldige pick flaggen. Nu:
  - Licht: -2 tot -3.5% (1 bucket lager)
  - Matig: -3.5 tot -5% (gehalveerd)
  - **Adverse: >-5% (0U, pick niet valide)**

### Tests
2 nieuwe tests voor dampedEdge + threshold update bestaande tests. Totaal **251 tests, 0 failed** (was 249).

## [10.8.9] - 2026-04-15

### Fixed
- **Modal odds-aanpassing bug**: bij **lagere** odds gaf de modal een HOGER unit-advies omdat het op pure Kelly rekende terwijl scanner-dampings (market multiplier, new-season, risk gates) weggevallen waren. Voorbeeld: scanner 1.91 → 0.75U, user vult 1.80 in → modal zei 1U. Klopt niet — lagere odds = minder waarde = lager advies.
- **"✓ Gelogd" chip verdween na hard-refresh**: race tussen `loadScanHistory()` (rendert picks) en `loadBets()` (vult `betData`). Renderen gebeurde met `betData=null` → alle picks toonden "+ Log" knop ook voor al gelogde bets. Nu re-render na loadBets() complete.

### Added
- **4-tier modal line-move logica** (via nieuwe `/lib/modal-advice.js`):
  - **Ongewijzigd (±2%)** → scanner-advies behouden
  - **Licht (-2 tot -4%)** → origUnits × kelly-ratio, floor naar bucket (minstens 1 bucket lager)
  - **Matig (-4 tot -6%)** → helft van scanner-advies + ⚠️ warning
  - **Adverse (>-6%)** → 🚫 "Line moved — pick niet meer valide" + **0U aanbevolen**
  - **Stijging (>+2%)** → pure Kelly gecapt op origUnits
  Rationale: een grote adverse line-move is een sterk reverse-CLV signaal (bookie moved prijs vanwege sharp money op andere kant → ons model overschatte edge).
- **Auto-refresh scan-history** op tab-focus (`visibilitychange`) + 5min interval terwijl tab zichtbaar. Detecteert nieuwe scans via timestamp-vergelijk, renders automatisch met "· vers" marker. Geen hard-refresh meer nodig.

### Tests
9 nieuwe tests in `test.js` voor 4-tier modal advice + Padres scenario (1.91→1.80) edge case. Totaal **249 tests, 0 failed** (was 240).

### Docs
- **Info-tab up-to-date** voor alle v10.8.0-9 features: knockout/aggregate score, rest-days alle 6 sporten, new-season damping, signal performance dashboard, projections met regression-to-mean + safe ladder, 18 market buckets, 9-bucket unit ladder, modal 4-tier line-move. Inzetstrategie-card uitgebreid van 6 naar 9 buckets.

## [10.8.8] - 2026-04-15

### Fixed (code review v10.8.0-7 findings)
- **Notification dedup**: was alleen op `type` → unit_increase met verschillende doelwitten werd silent gesuppressed. Nu dedup op `type+title+30d-window` → user krijgt geüpdate alert als doelwit verandert.
- **Backfill-signals mutex**: `_backfillSignalsInProgress` voorkomt concurrent calls die race conditions / dubbele writes opleveren.
- **€3k milestone off-by-one**: findIndex met `i > 0` filter zodat baseline (M0) niet als milestone telt.
- **localStorage dismiss expiry**: dismissed model-alerts hadden onbounded growth + cap=500 zou silent oude verwijderen. Nu `{key, ts}` format met **30-dag auto-cleanup** + cap=1000. Migratie van legacy flat-array format.
- **XSS escape op _setProjTab label**: voorheen alleen single-quote escape, nu ook double-quote.
- **Bookie-radar threshold €150** toegevoegd tussen €50 en €200 (Bet365 NL begint hier al te kijken).

### Added (Vooruitzichten + Acties — v10.8.6/.7)
- **Maand-voor-maand timeline tabel** met clickable scenario tabs (Pess/Verwacht/Opt). Toont per maand: bankroll | unit | stake/bet | maandwinst | cum. winst.
- **€3k milestone marker**: highlight in groen + banner zodra eerste maand €3k+ winst bereikt.
- **Bookie-radar markers** in unit-kolom: 🟡 €50+ · 🟠 €150+ · 👁️ €200+ · ⚠️ €500+ · 🚨 €1000+
- **Toggle Aggressief (10%) ↔ Safe ladder** mode. Safe ladder past unit-rule aan per niveau:
  - <€100 → 10% rule (onder bookie radar)
  - €100-300 → 5% (mainstream safe)
  - €300-500 → 3%
  - >€500 → 2% (professioneel)
- **Inbox filter "🚨 Acties"** voor actionable alerts (highlighted met accent border).
- **evaluateActionableTodos uitgebreid** met:
  - `unit_increase` — bij groeiende bankroll volgens safe-ladder rule
  - `bookie_diversify` — vanaf unit €200: spreid over 2-3 bookies
  - `cashout_advice` — vanaf unit €500: €3k-rule cashout strategie

### Changed (regression-to-mean ROI in projections — v10.8.5)
Sharp bettors halen long-term 5-7%, world-class 10%. 15%+ over <100 bets is bijna zeker run-good. Projection blendt nu observed met 5% prior:
```
weight = min(N/100, 1)
effROI = weight × observed + (1-weight) × 0.05
```
Bij 27 bets met 15.3% observed → effective 7.79%. Disclaimer in UI: "geblend met 5% prior wegens kleine sample n=X".

### Tests
4 nieuwe regression tests: safe-ladder thresholds, bookie-radar levels, regression-to-mean blend math, dismissed-alerts expiry. Totaal **240 tests, 0 failed** (was 235).

## [10.8.0] - 2026-04-15

### Added (Vooruitzichten / projections kaart op Data-pagina)
Nieuwe "🔮 Vooruitzichten" kaart toont bankroll-projectie met compounding over 1/3/6/12 maanden. Drie scenarios (pessimistisch 0.5× ROI / verwacht 1.0× / optimistisch 1.5×). Bevat unit-size advies bij gegroeide bankroll. Aannames (bets/maand, avg inzet) expliciet getoond.

### Added (Model-tab: market multipliers in tabs per sport)
- Tab "🕑 Recent": top 5 meest-recent-gewijzigd cross-sport (o.b.v. modelLog)
- Tabs per sport: Voetbal / Basketbal / Hockey / Baseball / NFL / Handbal
- Fallback bij geen modelLog: sorteer op biggest `|multiplier - 1|`

### Added (Changelog collapse)
Info-pagina was gigantisch. Nu toont default laatste 3 versies expanded, oudere versies achter "Toon X oudere versies" button.

### Added (PWA update toast)
Na SW auto-update reload nu zichtbare toast "✅ Geüpdatet naar vX.Y.Z" (3 seconden). Voorheen silent reload — gebruiker wist niet dat er iets gebeurde.

### Added (Humanizer voor alle markten + sporten)
Eerder werkte alleen voor football ML. Nu ook:
- **BTTS** (yes/no + GF pattern)
- **Over/Under** + TeamStats adjustment
- **Aggregate** (leader vs trailer language)
- **Baseball**: run differential + H/A split + pitcher
- **NBA/NHL**: back-to-back
- **NFL**: bye week
- **NHL**: shots differential
- **Streak** detection
Fallback "Modelanalyse:" opener als geen specifieke keyword matched maar wel facts.

### Added (Retroactieve signal backfill)
`POST /api/admin/backfill-signals` matcht oude bets → `pick_candidates` table via fixture_id + odds/bookie, en vult de lege `signals` kolom. DoS-cap op 500 per call. Nu heeft Signal Performance dashboard ook data voor historische bets.

### Added (Signals meegestuurd bij bet-log via modal)
Bug-fix: modal logde bets zonder signals. Nu wordt `modalPick.signals` meegestuurd zodat nieuwe bets direct in Signal Performance verschijnen.

### Fixed (Tracker inzet formatting)
Tracker toonde "€18" bij 0.75U × €25 = €18.75. JS `Number(18.00).toString()` droopt trailing zeros. Nu expliciet `.toFixed(2)` in tracker + modal.

### Fixed (Aggregate leg-detection zonder expliciete suffix)
Api-sports returnt vaak "Semi-finals" zonder "1st/2nd Leg" suffix. Oude regex faalde → `knockout: 2 (1e leg 0, 2e leg 0)` in telemetrie. Nu H2H broader candidate-matching: zelfde season + FT status + binnen 30 dagen + stage-match.

### Fixed (Debug endpoint: date/status/league info)
`/api/debug/odds` returnt nu ook `dateUTC/dateNL/status/league`. Gaf eerder verkeerde match (FT i.p.v. NS) bij team-name queries.

### Changed (Race-condition mutex op rebuild-calib)
`_calibRebuildInProgress` mutex voorkomt dat gelijktijdige calls corrupte calib-state veroorzaken. Parallel scans krijgen nog steeds 10s cache — maar rebuild zelf is nu exclusief.

### Changed (Signal parsing gestandaardiseerd)
`parseBetSignals()` helper in server.js handelt alle schema-varianten af (jsonb array, text JSON, null, undefined, invalid). Eerder waren er 5+ verschillende parse-paden die inconsistent faalden.

### Changed (afCache.lastPlayed daily reset)
Null-cache (team onbekend) bleef permanent — over multi-day scans raakte data stale. Nu dagelijkse reset via setInterval.

### Changed (Version bump 10.7.x → 10.8.0)
Minor bump gerechtvaardigd: 20+ nieuwe endpoints/features sinds v10.7.19 (rest-days signal, knockout awareness + aggregate score, new-season damping, signal performance dashboard, market tabs, projections, retro backfill, humanizer extensions, PWA updates).

### Tests
4 nieuwe regression tests: projection compounding math, scenarios factor lineariteit, parseBetSignals schema-varianten, humanizer BTTS/Aggregate/baseball tokens. Totaal **235 tests, 0 failed** (was 231).

### Volgende / open
- Info-tab databronnen + model-uitleg update (pending — nu niet actueel t.o.v. v10.8.0 features)

## [10.7.25] - 2026-04-15

### Added (aggregate-score Phase 2 — return-leg edge)
Bouwt verder op v10.7.23 knockout-awareness. Bij detectie van 2e leg fetchen we nu de **1e leg score via H2H endpoint**, berekenen aggregaat en passen EV aan op Over 2.5 en BTTS markten.

**Helpers:**
- `fetchAggregateScore(hmId, awId, roundStr, season)` — zoekt 1e leg via H2H `/fixtures/headtohead?h2h=X-Y&last=5`, filtert op `1st Leg` + zelfde seizoen. Herkent dat home/away gedraaid zijn in de 2e leg.
- `buildAggregateInfo(aggHome, aggAway)` — bouwt signalen + note. Detecteert all-square, small lead (1), big lead (≥2).

**Signalen** (weight=0 default, auto-promote via CLV):
- `leg2_all_square` / `leg2_home_leads_agg` / `leg2_home_leads_big` / `leg2_away_leads_agg` / `leg2_away_leads_big`
- `aggregate_push_ou` / `aggregate_push_btts` (direct effect signalen)

**Direct effect op probabilities** (research-backed, niet wachten op CLV-bewijs):
- **Over 2.5**: +2% per deficit-goal, cap +4%. Trailer moet scoren → meer goals.
- **BTTS**: +2% bij deficit=1, +3% bij deficit≥2 (cap). Leader scoort vaak ook op counters.
- **ML**: geen auto-adjustment (leader wint vaak alsnog ondanks defensiever spel).

**Human-note**: `🏆 Aggregaat thuis leidt 3-2`. Humanizer vertaalt: "thuis verdedigt voorsprong" / "uit moet minstens 2 scoren voor verlenging".

### Added (new-season indicator — B)
Vroeg in seizoen (ronde 1-4) is form/h2h minder predictief door kleine sample. Nu:
- Detectie via `f.league.round` matcht `Regular Season - N` met N≤4
- Signaal `early_season` (logging)
- **Dempt form + h2h adjustments met factor 0.6** (research: form-signal is 40% minder predictief in eerste weken)
- Injuries + congestion blijven ongedempt (die gelden direct)
- Note `🌱 Vroeg in seizoen (ronde X)` in reason

### Added (signal performance dashboard — D)
Nieuwe Model-tab kaart "Signal Performance" toont per signaal:
- `n` (aantal bets met dit signaal)
- `avgClv` + kleur (groen/rood)
- `posCLV_pct` (% bets met positieve CLV)
- Huidige `weight` (0.0-1.5)
- Status: 🚀 auto_promotable / ✅ active / 📈 logging_positive / 👁️ logging / 🔴 mute_candidate

**Endpoint:** `GET /api/admin/signal-performance`
Response include ook thresholds zodat UI de drempels toont.

### Tests
4 nieuwe regression tests: aggregate-score signals, Over/BTTS adj berekening, new-season detectie, damping-factor. Totaal **231 tests, 0 failed** (was 227).

### Waarom deze drie samen
- **A** levert direct meetbare edge op (geen CLV-wachttijd)
- **B** verlaagt risico op slechte picks in seizoenstart
- **D** geeft transparantie: je ziet live welke signalen werken en wanneer ze promoveren

## [10.7.24] - 2026-04-15

### Added (rest-days signal — alle 6 sporten)
Tussen wedstrijden verstreken dagen als signaal, met sport-aware thresholds:
- **NBA / NHL**: <2 dagen = tired (back-to-back)
- **NFL**: <4 dagen = short week (Thursday Night effect)
- **Football**: <3 dagen = midweek (na CL/EL impact)
- **MLB / handbal**: <1 dag = tired

**Signalen** (weight=0 default, auto-promote via `autoTuneSignalsByClv` bij positieve CLV over ≥20 samples):
- `rest_days_home_tired` / `rest_days_away_tired` — absoluut flag bij team onder threshold
- `rest_mismatch_home_advantage` / `rest_mismatch_away_advantage` — als verschil ≥3 dagen

**Human-note** in pick reason: `🛌 rust: thuis 1d / uit 3d`

**humanizePickReason** vertaalt naar: "thuis op korte rust, uit fris" of "uit op korte rust, thuis fris" of "groot verschil in rustdagen tussen teams".

**Helper** `fetchLastPlayedDate(sport, cfg, teamId, kickoffMs)`:
- Cached per (sport, teamId) binnen scan-session
- Null-cached ook (voorkomt herhaalde failed calls)
- ~80ms sleep tussen calls voor rate-limit respect

**API-kosten**: ~2 extra calls per fixture (1 per team), gedecupliceerd per scan. Budget impact ~100-200 calls/dag totaal over alle sporten (binnen 7500/dag budget).

### Fixed (CLV milestone spam)
`_lastClvAlertN` leefde alleen in-memory → elke deploy → eerste health-check triggert milestone weer. Nu gepersisteerd in calibration store. Bij eerste init na deploy: snap naar `floor(count/25)*25` zodat we niet retroactief milestones vuren.

### Fixed (debug endpoint: include date/status/league)
`/api/debug/odds` gaf alleen id/home/away/bookmakers. Voor de Padres-diagnose bleek dat een FT-match (afgelopen nacht) werd getoond ipv de aankomende NS-match. Nu ook: `dateUTC`, `dateNL` (Europe/Amsterdam), `status.short`, `league.name`. Geen bugfix maar UX van admin-tool.

### Fixed (duplicate hmId declaration in football scan loop)
Tijdens rest-days wire-up kreeg de football-loop `const hmId = f.teams?.home?.id` toegevoegd, wat conflicteerde met verderop `const hmId = hmSt?.teamId`. Latere declaration hernoemd naar `hmIdResolved` met fallback.

### Tests
1 nieuwe test voor rest-days signal logica (NBA back-to-back, NFL short week, football midweek, missing data). Totaal **227 tests, 0 failed**.

## [10.7.23] - 2026-04-15

### Added (knockout / 2-leg tie awareness — v1: logging)
Champions League, Europa League, Conference League, domestic cups. `f.league.round` bevat nu strings zoals "Round of 16 - 1st Leg", "Quarter-finals 2nd Leg", "Semi-finals", "Final". Parser extraheert:
- `leg` (1 of 2)
- `stageLabel` (finale / halve finale / kwartfinale / 1/8 finale / 1/16 finale)
- `isKnockout` (boolean)

**Wat er gebeurt nu:**
- Signalen toegevoegd: `knockout_1st_leg`, `knockout_2nd_leg`, `knockout_final`, `knockout_semi`, `knockout_quarter`. Allemaal weight=0 default. Auto-promote via `autoTuneSignalsByClv` zodra ≥20 bets met positieve CLV verzameld.
- Reason-string krijgt `🥊 2e leg kwartfinale` note.
- `humanizePickReason` (pick-kaart analyse) vertaalt naar "return leg — aggregaatstand speelt mee" of "heenwedstrijd van 2-leg tie".

**Wat NIET in v1:**
- Aggregate score adjustment: als team +2 op aggregaat staat gaan ze vaak conservatief spelen. Dat vereist api-call per fixture om 1e leg score op te halen. Phase 2.
- Away-goals rule (afgeschaft door UEFA 2021, maar domestic cups soms nog).

### Fixed (Padres ML dedupe — user-reported)
Padres scan gaf Unibet 1.88 terwijl Bet365 1.90 had. Twee oorzaken:
1. `parseGameOdds` matchte ML strikt op `bet.id===1`. Sommige bookies leveren Match Winner onder andere ID, alleen herkenbaar via naam ("Match Winner", "Home/Away", "Moneyline"). Nu naam-fallback.
2. Dedupe nam LAAGSTE prijs per bookie voor alle markten. Correct voor spread/totals (alt-lines hebben hogere prijzen), maar WRONG voor ML/DC/DNB/3way/NRFI/oddEven — die hebben geen alt-concept. Nu split: `dedupeMainLine` (lowest) voor spread/totals, `dedupeBestPrice` (highest) voor ML e.d.

### Fixed (remaining silent catches — debuggability)
14 stille catch blocks hebben nu minstens console.warn met context: pre-fetch fixtures, standings/injuries/referees enrichment, why-this-pick signal parsing, scan user-prefs load, pre-kickoff odds fetch, scan history load, analyze live-status check, Supabase RPC fallback, unit Telegram sends, market-samples refresh, loadSignalWeightsAsync. Functioneel gedrag onveranderd, alleen betere diagnose bij crashes.

### Tests
3 nieuwe regression tests: knockout-round parser, ML dedupe invariant, Padres-scenario reproduction. Totaal **226 tests, 0 failed** (was 215).

## [10.7.22] - 2026-04-15

### Security / Fixed (code-review bevindingen)
- **XSS fix**: `humanizePickReason()` output en raw `p.reason` nu ge-escaped vóór innerHTML. Voorheen konden teamnamen/refs met HTML-tekens ongefilterd in de DOM landen.
- **minDeltaPct validatie** (`/api/clv/recompute`): NaN/Infinity/negatief/>100 verworpen. Voorkomt silent no-ops (Infinity) of resource exhaustion (NaN).
- **DoS-cap**: `/api/clv/recompute` en `/api/admin/rebuild-calib` limieten nu op 10k bets per call. Response bevat `capped:true` als cap bereikt.

### Fixed (CLV resolver robustness)
- `findByNames()` skipt nu bets met lege values zodat eerste naam-match niet stille null retourneert als een andere entry wél data heeft. Regression test toegevoegd.
- Null-safe op bk, markt, values (tests voor alle edge cases).

### Fixed (rebuild-calib gedragsverbeteringen)
- **Behoudt multiplier als prior**: voorheen reset elke rebuild de multiplier naar 1.0 en verloor je opgebouwde tuning (50+ bets werk weg). Nu gebruikt ie de huidige waarde als prior, past de shared `computeMarketMultiplier` formule toe. Optionele `{resetMultipliers:true}` body om forceren.
- **Rebuild `leagues` aggregate**: voorheen stale na split. Nu opnieuw opgebouwd uit settled bets.
- **Gedeelde formule** (`computeMarketMultiplier`): één bron van waarheid voor `updateCalibration` én rebuild. Voorheen divergeerden ze (rebuild hardcoded 0.70/1.10, incremental graduated).
- **Post-rebuild refresh**: `refreshMarketSampleCounts()` wordt automatisch getriggerd zodat scan meteen met nieuwe counts werkt.

### Fixed (scan crashes + silent catches)
- **Scan-crash na rebuild-calib** (`cm.home.multiplier` TypeError): legacy scan-code las ongeprefixte keys die na rebuild niet meer bestonden. Nu backfill van ongeprefixte keys via `mm()` helper.
- **Surface real scan errors**: `runPrematch .catch` toonde generic "Scan mislukt" en slikte stack trace. Nu logs volledige stack + emits detail.
- **Drawdown protection fail-safe**: catch returnde 1.0 (volle stakes) bij crash. Nu 0.6 (voorzichtiger) + console.error.
- **loadCalibAsync**, **Kelly stepup notification**, **CLV backfill fixture_id updates**, **keep-alive ping**, **enrichment data writes**: alle stille catches nu minstens `console.error/warn` met context.

### Fixed (UI/UX)
- **Bet-edit modal: sport auto-fill**: voorheen viel hockey/nfl/handball via ontbrekende i18n keys terug op "Voetbal". Nu hardcoded map naar option labels + `sportSel.value` (ipv iterate options).
- **Bet-edit modal: units bij odds-daling**: bij lagere odds capt de recommender niet meer op origUnits. Fijner getrapte bands (0.2 / 0.3 / 0.4 / 0.5 / 0.75 / 1.0 / 1.5 / 2.0). Score gebruikt nu `freshScore` bij odds-daling.
- **Inzet formatting**: modal toont nu hele getallen zonder `.00` — match de tracker. Alleen decimalen als echt nodig.
- **Per-sport labels in Model tab**: fallback naar hardcoded Dutch namen bij ontbrekende `sport_*_full` i18n keys (voorheen toonde UI letterlijk "sport_hockey_full").

### Added (analyzer tab krijgt humanized narrative)
`renderAnalysisResult` toont nu de zelfde natuurlijke analyse-tekst als pick-card in scan-tab. Raw reason blijft onderaan als detail.

### Removed (dead code)
- `lib/calibration.js` — 434 regels parallel-implementatie die nergens geïmporteerd werd. Bevatte stale `detectMarket()` met 6 buckets (pre-v10.7.21). Verwijdering voorkomt toekomstige divergentie als iemand het per ongeluk importeert.

### Tests
9 nieuwe regression tests: CLV resolver null-safety (3), detectMarket nieuwe buckets (2), multiplier-formule (1), minDeltaPct validatie (1), XSS escape (1), modal recUnits bij odds-daling (1). Totaal **224 tests, 0 failed** (was 215).

## [10.7.21] - 2026-04-15

### Added (humanized pick-reasoning in analyse-tab)
Nieuwe `humanizePickReason()` parseert de technische reason-string (Consensus, Form, Injuries, Referee, Weather, Stakes) naar 1-2 natuurlijke zinnen die bovenin de analyse-uitklap staan. Technische details blijven eronder voor de power-user. Geeft een leesbare onderbouwing per pick zonder signals/weights/model-details weg te geven.

### Added (auto-sync CHANGELOG.md → in-app)
`GET /api/changelog` parseert `CHANGELOG.md` server-side en levert JSON (version/date/sections). In-app Versiegeschiedenis kaart rendert dit dynamisch (admin-only voor nu). Fallback naar hardcoded lijst bij load-failure. Eén source of truth.

### Fixed (PWA auto-update zonder reinstall)
Service worker luistert nu naar `SKIP_WAITING` message. Client roept `reg.update()` aan op elke page-load; nieuwe SW activeert zichzelf en triggert een `controllerchange` → auto-reload. Geen delete/reinstall meer nodig voor nieuwe deploys.

### Changed (PWA theme = system default)
Default theme volgt `prefers-color-scheme`. Gebruiker kan expliciet overriden via de dark-toggle; die keuze wint totdat localStorage wordt gewist. Live-update bij system theme change als er geen override staat.

### Changed (daily results check 06:00 → 10:00 Ams)
Verschoven ivm late US/MLB wedstrijden die pas diep in de nacht eindigen — 06:00 miste die regelmatig. Dagoverzicht bevat nu ook alle settled bets van de laatste 24h, niet alleen de nog-open bets die nu net afgesloten zijn. Voorheen zag je vaak maar 1 wedstrijd; nu volledige nacht + vorige dag.

### Fixed (notif sticky bug)
`toggleNotif()` wachtte niet op mark-read. Race condition liet 1 notif sticky staan na her-open. Nu `await` op mark-read voordat loadNotifications draait.

### Changed (API usage meter = football-specifiek)
Home meter toonde totaal-over-alle-sport-hosts. Nu expliciet football-host usage (= verreweg de grootste verbruiker door fixtures, injuries, refs, weather, predictions, standings, stats). Dat is de echte bottleneck.

### Added (CLV-knop feedback bij lege lijst)
`clvBackfill()` gaf vroeger gewoon "0 ingevuld" bij lege candidate-lijst. Nu expliciet: "Geen bets met lege CLV gevonden — gebruik Hercomputeer in admin-tab als je bestaande waarden wil herzien". Ook console-log van failures bij non-zero kandidaten.

### Changed (`football_other` vangbak opgesplitst)
`detectMarket()` classificeerde BTTS, DNB, Double Chance, Spread/Run Line/Puck Line, NRFI/YRFI, Team Totals en Odd/Even allemaal onder `other`. Effect: kill-switch en markt-multipliers konden geen aparte beslissing nemen per markttype. Ook: hockey/baseball markten verdwenen hier massaal in één `hockey_other` / `baseball_other` bucket.

Nu eigen bucket per type:
- `btts_yes`, `btts_no`
- `dnb_home`, `dnb_away`
- `dc_1x`, `dc_x2`, `dc_12`
- `spread_home`, `spread_away` (incl. Run Line / Puck Line / Handicap)
- `nrfi`, `yrfi`
- `team_total_over`, `team_total_under`, `team_total`
- `odd`, `even`
- Bestaande: `home`, `away`, `draw`, `home60`, `away60`, `draw60`, `over`, `under`

### Added (rebuild-calib endpoint)
`POST /api/admin/rebuild-calib` herbouwt `c.markets` vanaf 0 door alle admin settled bets opnieuw te classificeren met de nieuwe `detectMarket`. Body `{ dryRun:true }` laat de diff zien zonder te schrijven. Nodig om historische `football_other` op te splitsen naar de nieuwe buckets.

### Added (UI bucket-labels)
`renderInboxMarkets` (Model tab) kent alle nieuwe bucket-keys en toont per markt: BTTS Ja/Nee, DNB home/away, Dubbele 1X/X2/12, Spread/Handicap home/away, Team Over/Under, NRFI/YRFI, Odd/Even, 60-min varianten.

### Volg-upstappen voor user
1. Deploy.
2. `POST /api/admin/rebuild-calib` met `{dryRun:true}` → zie de diff (welke `_other` bets waar heen gaan).
3. Daarna `{dryRun:false}` → schrijft nieuwe calibratie. Kill-switch / markt-multipliers werken nu per specifieke markt.

### Tests
7 nieuwe `detectMarket` regression tests (BTTS, DNB, DC, Spread, NRFI/YRFI, Team Totals, onbekend-blijft-other). Totaal 215 tests, 0 failed.

## [10.7.20] - 2026-04-15

### Fixed (CLV market matching — root cause foute CLV%)
De oude `fetchCurrentOdds` matchte markten veel te los met `.includes('over')`, `.includes('winner')`, `.includes('spread')` etc. Gevolgen gezien op 2026-04-14:

- **Wigan ML @ 1.83 Unibet**: slotlijn kwam binnen als 1.83 → CLV 0% ❌. Werkelijke Unibet Home slot was 1.57 → **echte CLV +16.6%** ✅. Oude code pakte vermoedelijk een Alt/1st-half Winner ipv hoofdmarkt.
- **Chesterfield Over 2.5 @ 1.90 Bet365**: slotlijn kwam binnen als 1.95 → CLV -2.56% ❌. Bet365 Match Goals Over 2.5 sloot op 1.83 → **echte CLV +3.83%** ✅. Waarschijnlijk Corners O/U 2.5 of Alt Total 2.5 gepakt.
- **DNB bets** werden misgeclassificeerd als ML omdat de `🏠/✈️` emoji al door de ML-tak gevangen werd vóór de DNB-tak bereikt werd.

**Fix** (`lib/clv-match.js` — nieuwe pure resolver, testbaar zonder API):
1. O/U: vereist nu dat bet BEIDE `Over <line>` én `Under <line>` heeft, en filtert non-main via regex (`/alt|corner|card|team total|1st|period|...etc/`).
2. ML: exacte naam-match (`Match Winner`, `Home/Away`, `Winner`, etc.) ipv `.includes('winner')`. Accepteert ook `"1"/"2"` value-conventie.
3. DNB/Draw/BTTS checks **vóór** ML (emoji-vangnet bug).
4. Spread/Run Line/Puck Line filtert non-main (alt, corners, halftime, team totals).
5. `bet.id` niet meer hard-coded (varieert per sport) — name match is leading.

### Fixed (pre-kickoff odds notif — verkeerde bookie)
`schedulePreKickoffCheck` riep `fetchCurrentOdds` zonder `strictBookie:true`. Bij bookie-mismatch viel ie stil terug op Bet365 of eerste bookie → "odds stabiel" werd vergeleken met compleet andere book. Nu strictBookie overal.

### Fixed (CLV notif bookie display)
`usedBookie = bet.tip || 'Bet365'` toonde "Bet365" default als bookie ontbrak. Nu 'onbekend'.

### Added (retro CLV recompute endpoint)
`POST /api/clv/recompute` forceert hercomputatie voor ALLE settled bets. Body:
- `all: true` (admin: ook andere users)
- `dryRun: true` (geen writes, alleen rapport)
- `minDeltaPct: 0.5` (skip updates <0.5%-punt verschil — meet-ruis).

Na recompute draait automatisch: `refreshKillSwitch`, `autoTuneSignalsByClv`, `evaluateKellyAutoStepup` op de gecorrigeerde CLV-data. Zo werken kill-switch, signal-weights en Kelly-stepup op correcte cijfers. CLV-milestones + ROI-stats in tracker updaten automatisch op nieuwe clv_pct.

### Added (13 CLV regression tests)
`test.js` nu 208 tests. Dekt alle gefixte cases: Alt-market fallback, Corners O/U 2.5 fallback, DNB-emoji bug, BTTS, NRFI, Run Line main-lijn, 1st Half scheiding, 60-min 3-way hockey, `bet.id` onafhankelijkheid, "1"/"2" value-conventie, en null-return bij onbekende markten.

### Volg-upstappen voor user
1. Deploy (auto via push).
2. Eerst `POST /api/clv/recompute` met `{dryRun:true}` (admin) → zie verschilrapport.
3. Daarna `{dryRun:false}` → schrijft nieuwe clv_pct + draait tuning.

## [10.7.14] - 2026-04-14

### Fixed (paired-devig pairing conventie)
`buildSpreadFairProbFns` ging ervan uit dat pairing **altijd opposite-point** was (NBA/NFL conventie: Home -7.5 ↔ Away +7.5). Maar **MLB en NHL gebruiken same-point** (Home -1.5 ↔ Away -1.5, waar "Away -1.5" semantisch "Away side of -1.5 line" = bet-against-home betekent).

**Gevolg in v10.7.13**: paired-devig faalde voor MLB → sanity check tot<1.00 → fallback `fpHome × 0.55` → Dodgers cover-prob op 0.347 ipv realistische 0.447.

**Fix**: probeert BEIDE pairings, kiest die met plausibele vig (1.00-1.15). Lagere vig wint.

**Resultaat**: cover-prob voor MLB Dodgers -1.5 klopt nu met sharp markt (~44.5%). Edge bij 2.17 = ~-3% = terecht geen pick.

### Gevolg voor user
Wat eerder vandaag een "16% edge 7/10 pick" leek, was grotendeels artefact van de score-bug. Correct gekalibreerd is de bet marginaal -EV. Variance beslist over 1 bet. Bet staat, CLV-capture doet werk.

## [10.7.13] - 2026-04-14

### Added (regressietests — voorkomt dat vandaag's bugs terugkeren)
- `dedupe per (bookie, point)`: alt-line hoge prijs wordt weggegooid voor main-line
- `INVARIANT: meer brokers kan nooit picks verwijderen` — core invariant die vandaag was gebroken
- `INVARIANT: single-bookie edge == combi-edge` als best-prijs identiek is
- `per-entry maxOdds filter kill alleen anomalieën` — niet legit entries
- `fairProb als function`: per-point devigged consensus werkt over multiple point-lines

Totaal: 195 tests (was 190).

### Fixed (score bug op NBA + NFL + handball spreads)
Zelfde fout als MLB/NHL: `fpHome` (ML win-prob) werd direct gebruikt voor spread edge, terwijl spread cover strikter is dan winnen. Gaf overstate van edge → score 7/10 op eigenlijk marginale picks.

**Fix**: nieuwe helper `buildSpreadFairProbFns(homeSpr, awaySpr, fallbackH, fallbackA)` die per-point devigged consensus maakt uit paired (Home -X, Away +X) pools. `bestSpreadPick` accepteert nu een function voor `fairProb` — wordt per point-line geëvalueerd. Fallback: `fp × 0.50` als pool te dun of vig out-of-range.

**Toegepast op**: NBA spread, NFL spread + 1st half spread, handball handicap.
Voor MLB/NHL blijft de hardcoded `×0.55` fallback (runline standaard ±1.5, minder punt-variatie).

**Consequentie**: spread-picks tonen nu realistische cover-prob in reason-string (`cover 47.2%` ipv misleidende `63%` ML-prob). Score-tier klopt nu met echte edge.

## [10.7.12] - 2026-04-14

### Fixed (score/edge bug op spread-markten)
MLB run line en NHL puck line gebruikten `fpHome` (moneyline win-prob) direct voor spread edge-berekening. Dat overstelde de edge want "Home wins" ≠ "Home covers -1.5" (winnen met 2+ runs/goals is strikter dan simpelweg winnen).

**Fix**: spread-specifieke devigged consensus uit `(home -1.5, away +1.5)` pool. Als pool te dun / te rare (vig buiten 0-15%), fallback naar `fpHome × 0.55` (historische ML→cover ratio voor MLB/NHL).

**Impact**: edge op run-line / puck-line picks is nu realistisch. Score-mapping via hk blijft, maar hk krijgt correcte input. Geen meer 7/10 picks met eigenlijk marginale edge.

**Gebruiker-bevestiging**: api-sports "-1.5 @ 2.55" = 3-way run line (push als eigen outcome, hogere odds voor strengere conditie). Dedupe-fix (v10.7.10/11) pakt main 2-way line.

## [10.7.11] - 2026-04-14

### Fixed (broader application van v10.7.10 fix)
- De dedupe-bug zat structureel in `parseGameOdds`, niet alleen in spreads. Nu dedupe toegepast in parseGameOdds zelf op ALLE market-arrays: moneyline, totals, spreads, halfML, halfTotals, halfSpreads, nrfi, oddEven, threeWay, teamTotals, doubleChance, dnb.
- Key per markt: `(bookie, side)` voor ML-achtig, `(bookie, side, point)` voor spread/total-achtig, `(bookie, team, side, point)` voor teamTotals.
- Dedupe houdt LAAGSTE prijs = main line. Alt-lines met vals-hoge odds worden overal automatisch weggegooid.

### Rationale
Dezelfde anomalie die Dodgers -1.5 rejecte kan ook Over 8.5 rejecten als Bet365 een alt Over 8.5 @ hogere odds aanbiedt, of half-spreads, enz. Fix bij de bron = afgedekt voor alle toekomstige markten.

## [10.7.10] - 2026-04-14

### Fixed (KRITIEK — Dodgers-mysterie DEFINITIEF opgelost)
Via debug-log uit user's laatste scan bleek: api-sports levert per bookie soms MEERDERE entries op dezelfde spread-point (main line + alternate line). Voor Dodgers home -1.5 had Bet365 zowel @2.10 (main) als @2.55 (alt-line), en 1xbet/Betano ook dupes.

**Bug-chain:**
1. `bestFromArr` pakte max = Bet365 @2.55 (alt-line, anomaal hoog binnen range)
2. Edge berekend op 2.55: 60% (vals-hoog door alt-line conditie)
3. `mkP`: `ep = 1/2.55 + boost = 0.513` < `MIN_EP (0.52)` → REJECTED
4. Legit Unibet @2.17 (edge 37%, ep 0.534 > 0.52) genegeerd

**In Unibet-only mode**: pool filtered tot alleen Unibet entries → alt-line verdwijnt → Unibet 2.17 wint → pick fires.

**Fix**: `bestSpreadPick` dedupeert per `(bookie, point)` met LOWEST price. Main line heeft per definitie lagere odds dan alt-line (strengere win-conditie = langere odds voor alt). Lowest per bookie = main line.

Hiermee geldt eindelijk de invariant: **meer brokers in pool kan NOOIT picks verwijderen die bij single-broker wél zouden doorgaan.**

### Removed
- Debug-log in MLB run-line scan (doel bereikt, log was tijdelijk).

## [10.7.9] - 2026-04-14

### Fixed
- `renderRecentBets` crashte op `Object.entries(c.markets)` als calib.markets null/undefined was. Defensive check toegevoegd.

## [10.7.8] - 2026-04-14

### Added
- "Wis alles" knop in notificatie-dropdown. Verwijdert alle eigen + globale notifications via nieuwe `DELETE /api/inbox-notifications` endpoint. Confirm-prompt voor accidental clicks.

## [10.7.7] - 2026-04-14

### Debug
- MLB run-line pool dump in scan log voor diagnose Dodgers-mysterie. Toont per game: preferredBookies, fpHome/fpAway, en exacte pool entries (`bookie:point@price` per side). Ook log wanneer `bestSpreadPick` null returnt zodat we weten of het edge of pool was.
- Tijdelijk; verwijderen na root-cause vastgesteld.

## [10.7.6] - 2026-04-14

### Fixed (KRITIEK — Dodgers-mysterie opgelost)
**Root cause**: `bestSpreadPick` checkte `maxOdds` (3.8) NA `bestFromArr(pool)`. Als de preferred-bookies pool een entry had met anomaal hoge odds op dezelfde point-line (bv Bet365 alternate run-line @ 4.50), dan:

1. `bestFromArr` returned die anomalie als max
2. `top.price > maxOdds` check → hele point-group geskipt
3. Unibet's legit 2.17 verloren ondanks dat die binnen [1.60, 3.80] zit

**Symptoom voor gebruiker**: Dodgers -1.5 @ Unibet 2.17 verscheen ALTIJD in Unibet-only scan, NOOIT in [Bet365+Unibet] scan. 10x reproduceerbaar.

**Fix**: per-entry pre-filter op [minOdds, maxOdds] vóór groeperen. Anomalieën worden weggegooid, legit entries blijven. Pool-grootte kan picks nu nooit verkleinen — meer brokers = altijd ≥ picks van enkelvoudige broker.

### Refactored
- 1H spread paden voor NBA + NFL ook op `bestSpreadPick` (was nog op oude pattern). Nu 7/7 sport-spread-paden uniform.

### Tests
- 190 passed. Voeg nog regressietest toe in volgende release: "preferred=[A,B] geeft ≥ picks van preferred=[A] over geconstrueerde testdata".

## [10.7.5] - 2026-04-14

### Fixed (reviewer-catch)
- **NHL + MLB spread**: nog op oude pattern `bestFromArr(homeSpr)` met label uit `homeSpr[0].point`. ±1.5-filter dempte de bug, maar label-mismatch was nog mogelijk (pick op Unibet -1.5 kon tonen als "-X" van andere bookie). Nu 5/5 sport-spread-paden uniform via `bestSpreadPick()`.

### Clarified (was misleidend in eerdere release-notes)
- **Stakes**: niet "logged-only" maar **scaffolded met weight=0 default**. Adj wordt gemultiplied met weight uit `signal_weights` store. Zolang CLV-autotune het signaal niet promoveert (weight blijft 0), effect is 0. Dit is bewust: als signaal werkt, promoveert het automatisch.
- **Weather (NFL + MLB)**: **actief vanaf dag 1**, geen weight-gating. Regen/wind past direct `overP` aan voor O/U totals (zoals football weather al deed). Dit is bewust: weer is een fysiek feit, niet een signaal dat CLV-validatie nodig heeft.

### Note
- Testsuite dekt nog niet dat alle sport-spreads `bestSpreadPick` gebruiken én dat "logged-only" signalen geen score-impact hebben bij weight=0. Regressietest komt in volgende release.

## [10.7.4] - 2026-04-14

### Debug
- Multi-sport injury logs tonen nu raw api-rows naast matched count: `🏀 NBA: 0 blessures geladen (0 teams, api returned N rows)`. Bij N=0 ligt het aan api-sports tier; bij N>0 maar 0 matched ligt het aan status-keywords die isInjured() niet matched.
- NHL injury-log toegevoegd (was vergeten in 10.7.1).

### Observaties na live-scan (gebruiker)
- Football injuries: 142 teams geladen ✓ (was 0 voor 10.7.0)
- Pre-fetch skipte 50/59 inactieve competities ✓
- Call-reductie: ~40% vs vorige scans ✓
- Multi-sport injuries: 0 across all — root cause nog te bepalen (api-sports tier of status-naming). Debug-log helpt dit isoleren in volgende scan.

## [10.7.3] - 2026-04-14

### Changed (ALLOWED_BKMS dynamisch)
- Football scan gebruikte hardcoded `['bet365', 'unibet']` voor consensus-filtering. Nu: user's `preferredBookies` + altijd Pinnacle/William Hill als sharp refs. Fallback naar brede trusted set (7 bookies) als user geen voorkeur heeft.
- Gevolg: markt-consensus wordt breder en sharper, en toevoegen van nieuwe bookies (BetCity, TonyBet) werkt automatisch zonder code-change — zodra in preferredBookies, counten ze mee.

### Added (weather signal — NFL + MLB)
- **NFL**: outdoor stadia krijgen nu weer-data. Regen >5mm = -3% Over, wind >30km/h = -2.5% Over (komt samen in `overP` berekening).
- **MLB**: outdoor parks idem (regen >5mm = -2.5%, wind >25km/h = -2%). Kleiner dan NFL omdat baseball minder stil gelegd wordt bij wind.
- Weather-tag in `matchSignals` voor CLV-autotune, `weatherNote` in `sharedNotes` voor UI.
- Max weather-calls per scan gerespecteerd (existing `MAX_WEATHER_CALLS` cap).
- Voor indoor sports (basketball, hockey, handball) niet relevant → niet geïmplementeerd.

## [10.7.2] - 2026-04-14

### Added (multi-sport stakes signal)
- `calcStakesByRank(rank, totalTeams, sport)` — rank-based stakes-detectie per sport met sport-specifieke playoff/relegatie drempels:
  - **NBA/NHL**: top 20% = titelrace, top 50% = playoff-strijd, bottom 20% = onderaan
  - **MLB**: top 17% = titelrace, top 33% = playoff, bottom 17% = onderaan
  - **NFL**: top 25% = titelrace, top 44% = playoff, bottom 25% = onderaan
  - **Handball**: top 20% = titelrace, top 40% = euro-strijd, bottom 20% = degradatie
- Picks krijgen nu een `stakes` signal tag met adj-verschil tussen home/away. Weight start op 0 (logged-only), auto-promote via CLV als het signaal bewezen voorspellend is.
- Football had al `calcStakes` via gap-based logica; blijft zo voor preciezere detectie met punt-gaps.

## [10.7.1] - 2026-04-14

### Added (multi-sport injuries — scaffolding, conservatief)
- `isInjured()` universele status-matcher: telt `out`, `doubt(ful)`, `question(able)`, `day-to-day`, `IR`, `injured`, `suspen(ded)`. Niet: `probable`, `healthy`, `active`, `resting`. Conservatief ("zekere voor onzekere").
- **NBA `nba_injury_diff`**: nieuw signal via `/injuries` endpoint, weight=0 (logged-only), wordt auto-geactiveerd via CLV-autotune zodra n≥50 + CLV>0%. 0.6% per blessure-verschil bij weight 1.0.
- **NHL `nhl_injury_diff`**: idem, 0.5% per verschil.
- **MLB `mlb_injury_diff`**: idem, 0.3% per verschil (pitcher is dominant in baseball, overige blessures minder impactvol).
- **Handball `handball_injury_diff`**: idem, 0.7% per verschil (kleinste roster = grootste impact per blessure).
- **NFL** bestaande injury-signal geharmoniseerd met `isInjured()` helper.
- Scan-output toont nu per competitie: `🏀/🏒/⚾/🏈/🤾 League: N blessures geladen (M teams)` voor transparantie.

### Next
- Stakes signal (playoffs/degradatie/titel/niets te spelen) per sport via rank/seizoen-progressie.

## [10.7.0] - 2026-04-14

### Fixed (KRITIEK — silent bugs gevonden tijdens scan-audit)
- **Blessures werden nooit opgehaald**: STAP 2 in `enrichWithApiSports` filterde op `k.startsWith('soccer')` maar AF_LEAGUE_MAP keys zijn `'epl'`, `'laliga'`, `'egypt'` etc (géén `'soccer_'` prefix). Filter returnde 0 items → loop liep nul keer → `afCache.injuries` altijd leeg. Blessure-signaal heeft dus al maanden geen impact gehad op picks. Nu: iterate AF_LEAGUE_MAP direct.
- **Referee pre-cache eveneens kapot**: STAP 3 gebruikte hardcoded `'soccer_epl'`, `'soccer_spain_la_liga'` → `AF_LEAGUE_MAP[key]` = undefined → skip. Ref-data kwam nog via `f.fixture?.referee` fallback, maar pre-caching deed niks. Nu: correct keys (`'epl'`, `'laliga'`, `'bundesliga'`, `'seriea'`, `'ligue1'`, `'eredivisie'`).

### Optimized (football scan efficiency)
- **Pre-fetch fixtures**: nieuwe `preFetchFootballFixtures()` draait vóór `enrichWithApiSports`. Bouwt `activeSoccerKeys` Set met alleen leagues die matches hebben in de scan-window. Standings/injuries/referees worden nu alleen opgehaald voor die leagues.
- **Impact**: bij 13 actieve leagues uit 59 worden ~46 standings + 46 injury calls geskipt per scan. Fixtures zijn vooraf gecached zodat main scan loop ze niet opnieuw fetcht. Netto ~40% minder API calls per scan.
- **"X scans resterend"** op homepage blijft correct (leest uit cumulatieve `callsToday`).

### Pending (next)
- Multi-sport enrichment uitbreiden: referee/injuries/standings/weather/stakes voor NBA/NFL/NHL/MLB/handball is nu nog incompleet.
- "Stakes" signal (titelrace/degradatie/Europa-strijd) doorvoeren naar alle sports.

## [10.6.6] - 2026-04-14

### Fixed (KRITIEK — spread/handicap mixing-points bug in ALLE sports)
- **Oorzaak**: `homeSpr = spreads.filter(side==='home')` gaf ALLE point-lines terug in één array. `bestFromArr(homeSpr)` pakte vervolgens de hoogste prijs ongeacht point-line. Gevolg: een bookie met -3.5 @ 4.20 wint van dezelfde sport met -1.5 @ 2.17, en check `price <= 3.8` gooide de hele pick weg.
- **Gevolg voor gebruiker**: Dodgers -1.5 @ Unibet 2.17 (7/10 pick) verscheen wel in Unibet-only scan (pool uniform op -1.5) maar NIET in [Bet365+Unibet] scan (waar Bet365's extreme run line de pool contamineerde).
- **Fix**: Nieuwe module-helper `bestSpreadPick(spreads, fairProb, minEdge)` groepeert per point, runt `bestFromArr` per point-groep, pakt beste edge-qualifying. Toegepast op MLB run line, NHL puck line (beide met extra `±1.5` filter want vaste standard), NBA spread, NFL spread, handball handicap.
- **Secundaire fix**: label `homeSpr[0].point` was niet gekoppeld aan best.price — kon "Dodgers -1.5" tonen terwijl best eigenlijk Dodgers -2 was. Nu toont label het point van de daadwerkelijke best-pick.

## [10.6.5] - 2026-04-14

### Fixed (kritiek)
- **Odds-alert dedup bleef triggeren bij zelfde drift**: oorzaak was race-condition bij Render-restart — `loadCalib()` sync kon DEFAULT_CALIB returnen voor Supabase-cache warm was, waardoor saveCalib de hele calibratie overschreef (inclusief oddsAlerts). Nu: `loadCalibAsync()` aan begin van elke run (hot cache), één batch-write aan eind (geen N-writes per bet), fail-safe op lege calib.

### Added (actionable todos)
- `evaluateActionableTodos()` draait dagelijks na resultaten-check. Inserteert sticky inbox-items voor beslissingen die actie vragen, idempotent (checkt of todo-type al bestaat). Eerste todo: **Render upgrade** bij ≥100 settled bets + avg CLV > 0%. Blijft unread tot user mark-read klikt. Framework uitbreidbaar voor meer todos (bv BetCity bij €2k bankroll).

## [10.6.4] - 2026-04-14

### Fixed (kritiek)
- **`bestOdds` negeerde preferredBookies**: tweede best-odds-helper (gebruikt in football Moneyline path `server.js:4967-4969`) filterde niet op preferredBookies, alleen `bestFromArr` wel. Gevolg: football ML-picks toonden bookie/prijs van ELKE bookie in de markt, niet alleen jouw voorkeur. Nu geharmoniseerd: beide functies respecteren `_preferredBookiesLower`.
- **Odds monitor dedup verloor state bij Render-sleep**: `lastAlerts` Map was in-memory → free-tier sleep = Map gewist = re-alert zelfde drift. Nu persistent via `calib.oddsAlerts` (Supabase + disk), met 24u cleanup van stale entries.

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
