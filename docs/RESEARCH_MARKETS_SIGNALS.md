# EdgePickr · Market & Signal Expansion Research

Laatste update: 2026-04-14 (v9.3.0 baseline)

Dit document inventariseert (a) markten in api-sports die we nu niet gebruiken,
(b) gratis externe APIs die signal-diepte kunnen toevoegen, en (c) een
prioritering op basis van impact vs effort. Niets hardcoded — elke nieuwe
constante / gewicht krijgt een calibratiepad.

---

## 1. Current State Inventory

### Markten die we nu scannen (per sport)

| Sport | Gebruikt | Broncode |
|---|---|---|
| **Voetbal** | 1X2 (thuis/gelijk/uit), O/U totals, BTTS, DNB, Asian Handicap (spread), 1st Half O/U, 1st Half Spread | `runPrematch` |
| **Basketball** | Moneyline, Spread, Totals, 1st Half O/U, 1st Half Spread | `runBasketball` |
| **Hockey** | 2-way ML (met sanity), 3-way ML 60-min (Poisson), Totals, Puck Line, 1st Period O/U, Odd/Even | `runHockey` |
| **Baseball** | Moneyline, Run Line, Totals, NRFI/YRFI | `runBaseball` |
| **NFL** | Moneyline, Spread, Totals, 1st Half O/U, 1st Half Spread | `runFootballUS` |
| **Handbal** | Moneyline (2-way), 3-way ML 60-min (Poisson), Spreads, Totals, Odd/Even | `runHandball` |

### Signalen die we nu gebruiken

| Signal | Toegepast in | Bron |
|---|---|---|
| Consensus odds (no-vig fair probability) | Alle sporten | api-sports odds-endpoints |
| League home advantage | Alle sporten | Per-league constant (`ha`), TODO: dynamisch |
| Team form (laatste 5) | Alle sporten | api-sports /standings form-string |
| Head-to-head (H2H) | Voetbal | api-sports /fixtures/headtohead |
| Standings (positie, punten, W/L/D) | Alle sporten | api-sports /standings |
| Blessures | Voetbal (en optioneel hockey/baseball) | api-sports /injuries |
| Scheidsrechter profiel | Voetbal | api-sports /fixtures + fixture-specific referee |
| Goal differential per game | Hockey, handbal | Afgeleid uit /standings |
| Home/away splits | Voetbal, hockey, handbal | Afgeleid uit /standings |
| Back-to-back games (b2b) | Hockey | Afgeleid uit /games gisteren |
| Momentum (recent vs oude form) | Handbal, voetbal | Afgeleid uit form-string |
| Weer | Voetbal (outdoor) | OpenWeatherMap |
| Clean sheet rate | Voetbal | Afgeleid |

---

## 2. Market Expansion (binnen huidige api-sports Pro plan)

Uit de probe `GET /api/debug/odds?sport=hockey&team=vegas` hebben we gezien
dat Bet365 alleen al **50+ bet-types** aanbiedt voor één NHL wedstrijd.
Wij gebruiken er nu ~6. Onderstaand: markten die api-sports serveert maar
die we niet ophalen/analyseren.

### 2.1 Hockey (verified via probe)

| Markt | Aanwezig bij | Waarom relevant | Risico |
|---|---|---|---|
| **1x2 (1st Period)** | Bet365, 10Bet, WilliamHill, 1xBet, Marathon, Betano | 3-way op 1e periode, 22% v/d tijd draw → laag-vig edge mogelijk | Kleine sample → veel variance |
| **3Way Result (2st Period)** | Bet365, 10Bet, WilliamHill, Marathon, 1xBet | Zelfde logica per 2e periode | Kleine sample |
| **3Way Result (3rdPeriod)** | Bet365, 10Bet, WilliamHill, Marathon, 1xBet | Zelfde per 3e periode | Kleine sample |
| **Handicap Result (3-way)** | Bet365 (3v) | Spread incl. draw-uitkomst | Mismatch bij settlement draw |
| **Correct Score** | Bet365 (42 values) | Hoge uitbetalingen, Poisson-gestuurd | Lage hit rate, grote variance |
| **Double Chance (60-min)** | Bet365 (3v) | 1X / X2 / 12 — lagere odds maar veiliger | Marginale edges |
| **Odd/Even Total (Incl OT)** | Bet365 | Coin-flip markt, soms mispriced | Model heeft geen edge tenzij distributional signal |
| **Team Total Goals Home (Incl OT)** | Bet365 (10v) | Poisson-gestuurd, per team | Berekening OK (zelfde λ als totals) |
| **Team Total Goals Away (Incl OT)** | Bet365 (10v) | Idem | Idem |
| **Home/Away Totals (1st Period)** | Bet365 | Per team per periode | Zeer lage goals → alleen 0.5/1.5 lines interessant |
| **Player Points / Shots / Assists / Powerplay** | Bet365 (player props) | Grote markt bij NHL fans, vaak soft lines | Vereist player stats uit andere API (NHL.com) |
| **Anytime Goal Scorer / First Goal Scorer** | Bet365 (~40 values) | Populair, volatiel | Vereist xG-per-player data |

**Quick win:** Team Totals (per team) rechtstreeks uit onze bestaande Poisson
af te leiden — geen nieuwe data nodig. Geen extra API-calls, hergebruikt het
`poisson3Way` model.

### 2.2 Voetbal (bekend uit code-audit, te verifiëren via probe)

| Markt | Waarom relevant | Risico |
|---|---|---|
| **Correct Score** | Hoge odds, Poisson-gestuurd | Lage hit rate |
| **HT/FT (Halftime/Fulltime)** | Combineert beide periodes | Complex, soft-book markt |
| **First Team to Score** | 50/50 coin-flip met edge bij sterke thuis | Laag-vig vaak |
| **Total Cards (O/U 3.5, 4.5)** | Referee signal werkt hier sterk | Vereist referee-card-avg data (hebben we) |
| **Total Corners (O/U 9.5, 10.5)** | Style-of-play signal | Vereist team corner stats |
| **Clean Sheet Home / Away** | Combineert met BTTS, lagere variance | Standings geven al clean-sheet data |
| **Player Goalscorer / Assist / Shot markets** | Grote soft markt | Vereist external player xG data |
| **Asian Handicap alternative lines** | +0.5, +1, +1.25 etc. — veel meer detail | Parser uitbreiden voor quarter-lines |
| **Draw No Bet (DNB)** | Simpeler dan 1X2, lagere variance | Edge meestal beperkt tot sterke favorieten |
| **Team To Score First** | Combineert home-ice + ref-bias + form | Model bestaat al latent |

### 2.3 Basketball (NBA / Euroleague)

| Markt | Waarom relevant | Risico |
|---|---|---|
| **Quarter-by-quarter totals / ML** | Niche maar vaak soft | Kleine sample |
| **Team Totals per team** | Pace-based, vaak mispriced | Vereist pace stats |
| **Player points O/U** | Populairste NBA markt | Vereist player usage % + recent games |
| **Player rebounds / assists / threes** | Idem | Idem |
| **Race to N points** | Exotic | Zeer kleine markt |
| **1st team to N points** | Exotic | Idem |

### 2.4 Baseball (MLB)

| Markt | Waarom relevant | Risico |
|---|---|---|
| **1st 5 Innings (F5) ML / Total / Run Line** | Pitcher-driven, zeer populair, vaak sharp | Vereist starting pitcher data (probable pitchers API) |
| **Team Totals** | Lineup-driven | Vereist lineup info |
| **NRFI + 1st 3 innings no-run** | Pitcher-driven | Idem |
| **Player hits / home runs / strikeouts** | Hoge volume markten | Vereist recent player stats |

**Quick win voor MLB:** F5 markten worden gepubliceerd door api-sports
(bet name patterns met "1st 5" of "F5"). Parser uitbreiden + starting-pitcher
signal toevoegen = significante model-verbetering.

### 2.5 NFL

| Markt | Waarom relevant | Risico |
|---|---|---|
| **Team Totals** | Pace/style driven | Vereist team offensive stats |
| **Player yards passing / rushing / receiving** | Populair | Zeer data-intensief |
| **Race to N points, 1H Spread varianten** | Soft markten | Kleine sample |

### 2.6 Handbal

Weinig missende markten. Handbal bij EU-bookies beperkt tot 1X2 + totals + spread.

---

## 3. Externe APIs — onderzocht per sport

Elke externe API moet aan drie criteria voldoen voor opname:
1. **Gratis** of binnen huidige budget
2. **Publiekelijk gedocumenteerd** (geen scraping zonder toestemming)
3. **Robuuste signal-waarde** (≥3% model-accuracy verbetering in literatuur)

### 3.1 MLB Stats API (statsapi.mlb.com) — HIGH PRIORITY

**Status:** Publiekelijk, officieel door MLB, gratis, no auth, geen rate limit.
**Documentatie:** Niet officieel gedocumenteerd door MLB maar vaste structuur,
gereverse-engineerd community docs (GitHub toronto/mlb-stats-api). Betrouwbaar.
**Relevante endpoints:**
- `/api/v1/schedule` met `hydrate=probablePitcher` → starting pitchers per game
- `/api/v1/people/{pid}/stats?stats=season` → pitcher ERA, WHIP, K/9, BAA
- `/api/v1/teams/{tid}/stats` → team batting OPS, runs/game

**Signal-waarde:**
- Starting pitcher ERA-differential = ~35% van MLB ML-prediction variance (bron:
  *The Book: Playing the Percentages in Baseball* — Tango/Lichtman/Dolphin)
- Pitcher K/9 rate voorspelt totals ±7% beter dan team averages alleen
- Relief-pitcher bullpen ERA = belangrijk voor F5 markten

**Implementatie effort:** Laag. Eén extra API-call per game + 1 signal per pick.

### 3.2 NHL Public API (api-web.nhle.com) — MEDIUM PRIORITY

**Status:** Publiekelijk NHL API (versie web/v1 sinds oktober 2023). Free, no auth.
**Betrouwbaarheid:** Officieel NHL, stabiele endpoints gedurende seizoen.
**Relevante endpoints:**
- `/v1/scoreboard/now` → huidige scores
- `/v1/gamecenter/{id}/boxscore` → shot-totals, face-off %, PP/PK
- `/v1/team/{tri}/roster/current` → roster
- `/v1/club-stats/{tri}/now` → team scoring chances, xG, Corsi (beperkt)

**Signal-waarde:**
- **xG (expected goals)** — voorspelt scoring beter dan feitelijke goals (sample size),
  ~4-6% verbetering in totals (bron: MoneyPuck methodology papers)
- **PP/PK splits** — NHL gebruikt 18+% van speeltijd in specialty-teams; sterk signal
- **Goalie start** — goalies hebben 30-40% van totals-variance (bron: Natural Stat Trick)

**Implementatie effort:** Medium. Nieuwe data-fetch + parsing + caching.

### 3.3 ESPN Hidden API — MEDIUM PRIORITY

**Status:** Niet officieel gedocumenteerd. Werkt stabiel sinds 2010+.
**Betrouwbaarheid:** Onofficieel, kan zonder waarschuwing breken.
**Endpoints (sports.core.api.espn.com):**
- Team statistics per sport (NBA, NFL, MLB, NHL)
- Standings / power rankings
- Injury reports (NBA + NFL vaker up-to-date dan api-sports)

**Signal-waarde:**
- NBA/NFL injuries: api-sports heeft hier soms gaten, ESPN is vollediger
- NFL coaching records, home/away splits
- NBA DRtg / ORtg afgeleid via ESPN team stats

**Implementatie effort:** Medium. Meerdere endpoints, geen schema-contract.

### 3.4 Understat (xG voor voetbal) — MEDIUM PRIORITY

**Status:** Scraping-based (understat.com). Geen officiële API, data in HTML.
**Betrouwbaarheid:** Dekking: EPL, La Liga, Bundesliga, Serie A, Ligue 1, RPL.
Geen lower-tier Europese competitie. Update elke 24u.
**Toegang:** Eenvoudige Python-lib (`understat-scraper`) in JS te herimplementeren.
**Risico:** Terms of service verbieden bulk scraping niet expliciet maar ook niet
expliciet toestaan. Rate limiting door ons zelf toepassen.

**Signal-waarde:**
- Team xG-for/against → team-strength signal sterker dan goals
- Bevoorbeeld: Manchester City kan 3-0 winnen met xG 2.5 (true strength) of 1.2
  (fortuinlijk). xG is betrouwbaarder predictor (~5-8% model-improvement, Opta studies)

**Implementatie effort:** Medium-hoog. Scraping stability + parsing + caching +
TOS monitoring.

### 3.5 Basketball-Reference / NBA.com Stats — LOW PRIORITY

**Status:** NBA.com stats heeft rate-limits + User-Agent check. Basketball-Reference
is scraping-based.
**Signal-waarde:** DRtg, ORtg, pace → betere totals prediction (~3-5%).
**Risico:** Technisch complexer, ToS-onzeker, breekt vaker.

Alternatief: afleiden uit api-sports team stats (minder precies maar stabiel).

### 3.6 OddsAPI / Pinnacle Odds feed — LOW PRIORITY

**Status:** Pinnacle API is officieel (pinnacleapi.github.io), maar vereist
account + daily rate limits. Gratis basic tier = 500 calls/dag.
**Waarom relevant:** Pinnacle = scherpste boek, hun odds ≈ true fair value.
Sharp books eerst → later markt-move indicator.
**Risico:** Extra bookie account. Juridische vraag over TOS data-gebruik.

Voor sanity-check doel nu: 3-way consensus over 10+ bookies uit api-sports is
al voldoende. Pinnacle apart niet urgent.

### 3.7 Weather (OpenWeatherMap) — AL GEÏMPLEMENTEERD

Gebruikt voor voetbal outdoor. Wind + regen + temp.
**Uitbreiding mogelijk:** NFL outdoor stadiums (wind > 15mph verlaagt totals
~4 punten per game, bron: Pro Football Focus). NHL outdoor games (zeldzaam).

---

## 4. Signal Weighting Methodology

Per engineering standaard: geen hardcoded gewichten. Elke nieuwe signal volgt
deze workflow:

### 4.1 Start weights (expert prior)
Uit literatuur een redelijke beginwaarde kiezen, bv voor MLB starting pitcher:
`pitcher_adj = min(0.08, max(-0.08, (awayERA - homeERA) * 0.012))`. Dit is
een **expert prior**, gemarkeerd als TODO-calibreer.

### 4.2 Tracking per signal
Elke pick krijgt een `signals: ['pitcher:+3.5%', 'form:-1.2%', …]` array die
naar Supabase `bets` gaat. Bij settlement wordt deze per-signal W/L bijgehouden.

### 4.3 Auto-tuning
`autoTuneSignals()` draait daily. Per signal met ≥30 bets:
- Hit rate > 55% → gewicht ×1.05 (max 1.5)
- Hit rate < 40% → gewicht ×0.92 (min 0.3)
- Anders → gradueel naar 1.0
Dit bestaat al voor voetbal signalen, uitbreiden naar multi-sport.

### 4.4 Sanity ceiling
Per signal een max-abs-adjustment (bv ±8%) zodat één dominant signal het model
niet kan kapen. Al toegepast in hockey/handbal signals.

---

## 5. Prioritized Roadmap

### Priority 1 — Quick wins (laag effort, hoge impact)

| Item | Effort | Impact | Rationale |
|---|---|---|---|
| **Hockey Team Totals** uit bestaand Poisson | 1u | Medium | Geen nieuwe data, hergebruik λh/λa |
| **MLB F5 markten** parser + starting-pitcher signal | 3u | Hoog | F5 is pitcher-driven, publieke data gratis |
| **Voetbal Double Chance** uit 1X2 devig | 1u | Laag-Medium | Simpele derived markt |
| **Voetbal DNB** via bestaande consensus | 1u | Laag-Medium | Ook derived |
| **Odd/Even Total signal** voor hockey/football | 2u | Laag | Alleen bij duidelijke Poisson-afwijking |

### Priority 2 — Signal diepte

| Item | Effort | Impact | Rationale |
|---|---|---|---|
| **MLB Starting Pitcher** via statsapi.mlb.com | 4u | Zeer hoog | 35% van ML-variance (literatuur) |
| **NHL xG + goalie start** via api-web.nhle.com | 6u | Hoog | Voorspelt goals > feitelijke goals-per-game |
| **NBA DRtg/ORtg** via ESPN team stats | 4u | Medium | Pace/efficiency signal |
| **NFL weather** via OpenWeatherMap uitbreiden | 2u | Medium | Wind-effect op totals |
| **Referee card avg** voor voetbal card-markten | 3u | Medium | Al referee-data, card-data toevoegen |

### Priority 3 — Nieuwe marktcategorieën

| Item | Effort | Impact | Rationale |
|---|---|---|---|
| **Voetbal Player Goalscorer** met xG data | 10u+ | Hoog | Grote markt, soft lines |
| **NHL Player Shots/Points** met NHL API | 8u | Medium-hoog | Populair, data beschikbaar |
| **NBA Player Points O/U** met NBA stats | 10u+ | Hoog | Grote markt, complex model |

### Priority 4 — Experimenteel / onzeker

| Item | Effort | Impact | Rationale |
|---|---|---|---|
| **Understat xG** voor voetbal | 8u | Hoog | Sterker signal, scraping-risk |
| **Pinnacle odds feed** | 6u + account | Laag-Medium | Sanity-check al voldoende via consensus |
| **Line movement tracking** | 15u+ storage | Zeer hoog | Toekomst, vereist historische data |

---

## 6. Implementation Principles (recap engineering standaard)

Elk roadmap-item moet:
1. **Research-backed**: literatuur of probe-verified evidence dat het signal waarde heeft
2. **Safe defaults**: start-weights expliciet als "prior", niet als finale waarheid
3. **Testable**: unit tests voor nieuwe helpers, integration test voor scan-flow
4. **Observable**: signal appears in `bet.signals` array zodat autoTune het kan tracken
5. **Fallback**: als externe API faalt, scan moet doorgaan zonder crash
6. **Rate-aware**: externe API-calls cachen per game (niet per scan)
7. **Budget-aware**: per-scan max-N extra API-calls, log totaal

---

## 7. Volgende stap

Gesuggereerde eerste sprint (~8-10u werk, hoogste verwachte ROI):

1. Hockey Team Totals (1u) — leren & integratie-patroon valideren
2. MLB F5 markten + starting pitcher signal (7u) — grootste impact
3. Voetbal DNB + Double Chance derived (2u) — laag risico, meer pick-kandidaten

Daarna evalueren (30+ picks per nieuwe market type) voordat we Priority 2+ starten.
