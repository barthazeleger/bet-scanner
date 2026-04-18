# EdgePickr Private Operating Model

Laatste update: 2026-04-18 (v11.0.2)

Dit document is de actieve productdoctrine voor EdgePickr. Niet het oude
SaaS-plan, maar de private operator-workflow is leidend.

> Historische context: het oude SaaS-narratief is gearchiveerd in
> [`docs/_archive/BUSINESS_PLAN.md`](_archive/BUSINESS_PLAN.md). Niet leidend
> voor huidige keuzes.

## 1. Wat EdgePickr is

EdgePickr is een private betting terminal voor één operator:
- één bankroll
- één canonieke scan-state
- één set preferred bookies
- één waarheid voor bankroll- en unit-logica

Het systeem is geen generiek platform dat voor meerdere users moet voelen als
een complete consumer app. Alles wat niet helpt bij betere scans, betere
execution of betere discipline is bijzaak.

## 2. Hoofddoel

Het doel is niet "meer features", maar structureel betere beslissingen:
- hogere execution quality
- betere CLV
- strakkere bankroll-discipline
- compounding-ready stake logic
- minder handmatig beheer

Een feature is alleen welkom als die minstens één van die punten verbetert
zonder point-in-time correctness of scan-integriteit te beschadigen.

## 3. Productlussen

### Scan
- De knop is heilig.
- Ranking moet draaien op echte edge, niet op cosmetische "confidence".
- Liever 0 picks dan 1 pick met twijfelachtige reasoning of zwakke marktdekking.

### Learn
- Learning moet point-in-time auditbaar zijn.
- CLV is de primaire feedbacklus, niet hitrate.
- Signalen worden beoordeeld op extra waarde boven markt-context, niet op ruwe noise.

### Discipline
- Stake logic moet bankroll-beschermend zijn.
- Step-ups vragen bewijs, niet enthousiasme.
- Alerts en failsafes horen klein, duidelijk en operator-first te zijn.

## 4. Beslisregels voor nieuwe features

Voeg iets alleen toe als het:
1. scan-output aantoonbaar scherper maakt,
2. execution timing verbetert,
3. bankroll/CLV-discpline versterkt,
4. point-in-time auditability verhoogt,
5. of handwerk vervangt zonder canonieke state te vervuilen.

Voeg iets niet toe als het vooral:
- UI-oppervlak vergroot zonder scanwinst,
- multi-user/tiering-complexiteit introduceert,
- reasoning/signals onnodig blootlegt,
- of learning vervuilt met achterafkennis.

## 5. Technische voorkeuren

- Pure scan/helpers eerst naar testbare modules, niet naar meer `server.js`.
- Centrale waarheden voor versie, bankroll-settings en operator-state.
- Money-state per bet (`unit_at_time`, bankroll-context) wordt point-in-time
  vastgelegd. Geen retroactieve aannames over historische units; CLV- en
  ROI-analyses moeten over een unit-wisseling heen eerlijk blijven.
- Kleine, production-safe diffs omdat elke push via Render live kan raken.
- Tests voor scanner, signalen, bankroll-logica en regressies zijn goedkoper dan stille edge-erosie.
- Elke change krijgt meteen een version bump, changelog update en info-page versie-update. Geen stille codewijzigingen zonder release-spoor.

## 6. Actieve roadmap

De roadmap is niet feature-first maar edge-first. Elke fase moet de scanner
inhoudelijk scherper maken of de discipline-lus veiliger maken.

### Bouwvolgorde (fundering vóór signal-expansion)

Drie fundamenten gaan vooraf aan elke nieuwe signal-uitbreiding. In deze
volgorde:

1. **`unit_at_time` per bet** — historische CLV/ROI-analyse moet over
   unit-wisselingen heen kloppen. Zonder deze datalaag zijn alle Fase 4-claims
   retroactief vervormd.
2. **Price-memory query-laag** — `getLineTimeline(fixtureId, marketKey)`
   bovenop `odds_snapshots`. Ontsluit vrijwel alle execution- en
   scan-timing-signalen.
3. **Execution-quality als Kelly-gate** — market-quality moet stake
   beïnvloeden, niet alleen UI rendering.

Pas daarna mogen Fase 2-signalen (NFL/football news-tracks, extra
team-strength enrichments, etc.) erbij. Nieuwe signalen zonder deze onderlaag
maken de scanner drukker maar niet betrouwbaarder. Elke signal-sprint die
deze volgorde omkeert moet expliciet in dit document worden gemotiveerd.

### Fase 1 — Scanner-core hard maken

Doel: de knop betrouwbaarder en testbaarder maken.

Prioriteiten:
- pick-ranking, signal attribution en market parsing verder uit `server.js` halen
- per sport één gedeelde ranking/selection flow waar mogelijk
- regressietests toevoegen voor ranking, stake tiers, audit-damping en no-bet gates
- bookie-resolution, line-selection en closing-line matching verder harden

Succescriterium:
- minder drift tussen modules
- sneller veilig itereren op ranking/signalen
- geen stille regressies in stake of pick-selectie

### Fase 2 — Execution edge verdiepen

Doel: betere picks door betere timing en context, niet door meer cosmetische score.

Prioriteiten:
- line-move timing signalen: open → current → pre-kickoff → close
- market disagreement per bookie-cluster: soft vs sharp vs preferred
- injury recency / lineup certainty / goalie-pitcher confirmation dichter op kickoff
- rust/reis/asymmetrie-signalen per sport waar point-in-time data betrouwbaar is

Succescriterium:
- hogere CLV zonder dat pickvolume kunstmatig wordt opgevoerd
- meer "skip" waar de markt of context te onduidelijk is

### Fase 3 — Learn-lus strakker maken

Doel: het model niet alleen laten leren, maar correct laten leren.

Prioriteiten:
- signal performance per sport, markt, timing-window en bookmaker-context
- onderscheid tussen absolute CLV, excess CLV en execution quality
- strengere sample-size discipline voor weight-updates, step-ups en kill-switches
- operator-zicht op waarom een signaal momenteel trusted, muted of watchlist is

Succescriterium:
- minder ruis in autotune
- duidelijker bewijs waarom een signaal stijgt of zakt
- compounding-lussen reageren op echte edge, niet op variance

### Fase 4 — Bankroll en compounding engine

Doel: winst beter behouden en opschalen.

Vereiste fundering (zie sectie 6 Bouwvolgorde): `unit_at_time` is point-in-time
vastgelegd per bet. Zonder die datalaag is Fase 4 niet eerlijk evalueerbaar.

Prioriteiten:
- strengere step-up/step-down regels op basis van CLV, ROI en drawdown samen
- duidelijk onderscheid tussen exploratory picks en proven-edge picks
- projectie/logica die bankrollgroei ondersteunt zonder te vroeg aggressief te worden

Succescriterium:
- minder regimefouten bij unitwissels
- step-ups alleen na bewezen edge
- betere overleving bij drawdowns

### Fase 5 — Automation zonder cockpit-ziekte

Doel: minder handwerk, zonder extra productruis.

Prioriteiten:
- scans, checks, cleanup en monitoring waar mogelijk automatisch
- alleen operator-alerts voor echte uitzonderingen: drawdown, source-failure, drift, CLV-regime-shift
- geen dashboards bouwen die vooral "interessant" zijn maar geen actie sturen

Succescriterium:
- minder handmatige checks
- minder cognitieve load
- operator grijpt alleen in wanneer het systeem daar bewijs voor geeft

## 7. Wat we bewust niet najagen

Niet prioriteren:
- multi-user tiers, billing of platformisering
- explainability die teveel model-internals prijsgeeft
- exotische markten zonder bewezen executionvoordeel
- volume verhogen als CLV/discipline daar niet beter van wordt
- features die vooral mooi lijken in UI maar geen scan- of bankrollwinst opleveren

## 8. Beslisregel voor nieuwe signalen

Een nieuw signaal komt pas op de roadmap als we aannemelijk kunnen maken dat het:
- point-in-time beschikbaar is
- sport- en markt-specifiek genoeg is om echte extra informatie te bevatten
- meetbaar kan worden teruggekoppeld via CLV of executionkwaliteit
- en de scan helpt vaker goed te skippen, niet alleen vaker te selecteren

## 9. Productdoel: de markt verslaan, niet alleen picks tonen

De beste versie van EdgePickr is niet de breedste odds-app, maar de terminal die:
- sneller dan de markt relevante context verwerkt,
- strenger dan de markt onbetrouwbare spots skipt,
- beter dan de markt executionkwaliteit bewaakt,
- en agressiever mag compounden zodra die edge aantoonbaar echt is.

Dat betekent:
- scanner-output optimaliseren voor verwachte bankrollgroei, niet voor pickvolume
- singles standaard als basis-output behandelen
- combi's alleen toestaan wanneer ze de EV per euro verhogen zonder verborgen correlatie of discipline-schade
- elke extra markt of feature laten bewijzen dat hij CLV, execution of bankrolldiscipline verbetert

## 10. Wat er inhoudelijk nog nodig is voor een topproduct

### A. Execution intelligence

De markt wordt vaker verslagen op timing dan op modelcomplexiteit alleen.

Nodige functies:
- line timeline per pick (`getLineTimeline(fixtureId, marketKey)`): open,
  first_seen, first_seen_on_preferred, scan_anchor, latest_pre_kickoff, close
  + afgeleiden (drift, steam, stale, preferred gap, time-to-move)
- steam vs drift classificatie: beweegt de markt met info of zonder bevestiging?
- sharp-soft disagreement score: preferred bookies, soft books en sharp
  reference apart volgen
- stale-line detectie: pick krijgt bonus als preferred price achterloopt op
  sharp move, maar alleen kortdurend
- last-safe-entry logic: wanneer de price nog speelbaar is, wanneer niet meer

Execution-quality werkt als Kelly-gate, niet alleen als UI-laag. De gate hangt
op de ruwe metrics (`preferred_gap_pct`, `stale_pct`, `overround`,
`bookmaker_count`, preferred availability), niet op de classifier-labels —
zodat label-hertuning het stake-regime niet stilletjes kantelt.

Voorlopig werkmodel voor `applyExecutionGate(hk, metrics)`:

Beschikbaarheid eerst:
- `no_target_bookie` → hard skip
- preferred bookmaker ontbreekt op anchor of latest → hard skip

Stale / preferred-gap:
- `stale_pct ≥ 2.5%` → `hk × 0.5`
- `stale_pct 1.0–2.5%` → `hk × 0.7`
- `preferred_gap_pct ≥ 3.5%` → `hk × 0.6`
- `preferred_gap_pct 2.0–3.5%` → `hk × 0.8`

Markt-kwaliteit (secundair):
- 2-way overround > 8% → extra `hk × 0.85`
- 3-way overround > 12% → extra `hk × 0.85`
- `bookmaker_count` onder sport-drempel → extra `hk × 0.8`

Kalibratie volgt via settled-bet review per regime.

Preferred-bookies waarheid:
- canoniek = operator settings van de actieve admin
- hard-coded lijsten zijn alleen fallback/safety-net wanneer settings ontbreken
  of corrupt zijn, niet primaire execution truth
- classifier en gate evalueren altijd tegen de operator-set, niet tegen een
  doctrinaire default

### B. Point-in-time team news — per sport, niet één engine

Veel edge verdwijnt omdat nieuws te laat, te grof of niet sport-specifiek
genoeg binnenkomt. Het is geen generieke "news engine" — het zijn vijf
onafhankelijke as-of tracks met elk eigen bron-rot-risico:

- **MLB**: probable pitcher certainty → late scratch detectie
  *(deels lopend via `pitcherReliabilityFactor`)*
- **NHL**: goalie preview → confirmed goalie
  *(`nhl-goalie-preview.js` + `confidenceFactor` actief sinds v10.10.3)*
- **NBA**: injury availability / questionable resolution / rest
  *(residual-multiplier fix in v10.10.3)*
- **Football**: lineup certainty / rotation risk / fixture congestion
  *(nog niet geïmplementeerd)*
- **NFL**: official injury report / inactive list / weather/stadium context
  *(nog niet geïmplementeerd)*

Kruisregels per track:
- nieuws zonder timestamp of zonder as-of betrouwbaarheid telt niet mee in
  ranking
- nieuws-signalen moeten kunnen afzwakken als bevestiging ontbreekt
  (zie `confidenceFactor`-patroon in NHL goalie-preview als referentie)
- elke track wordt apart geprioriteerd en gemonitord, niet als één epic

### C. Market microstructure layer

Niet alle odds zijn even informatief.

Nodige functies:
- bookmaker tiers: sharp, semi-sharp, soft, preferred execution books
- per markt type een andere consensusregel
- afwijkingsscore per book en per line
- line-origin tracking: waar begon de move, wie volgde, wie liep achter
- margin-quality score: hoge overround = lagere vertrouwenswaarde

### D. Selection engine die ook goed kan skippen

De huidige scanner moet uiteindelijk niet alleen picks sorteren, maar expliciet beslissen:
- bet
- watch
- wait for better line
- no bet

Nodige functies:
- no-bet classifier bovenop pure edge
- confidence decomposition: market quality, news quality, model agreement, execution quality
- skip-reasons die intern auditbaar zijn maar niet als model-IP naar buiten lekken
- regime-awareness: early season, playoffs, back-to-back clusters, thin-data leagues

### E. Compounding engine

Bankrollgroei komt niet alleen uit goede picks maar uit goed opgeschaalde
picks. **Voorwaarde:** `unit_at_time` en bankroll-context zijn historisch per
bet vastgelegd. Zonder die datalaag kunnen step-up regels en CLV-context geen
eerlijke historische evaluatie doen.

Nodige functies:
- `unit_at_time` en bankroll-context historisch per bet *(fundament — zie
  sectie 6 Bouwvolgorde)*
- bewezen-edge tiers: exploratory, standard, scale-up
- step-up gate op basis van CLV, ROI, drawdown en sample size samen
- automatische step-down bij execution decay of CLV regime shift
- onderscheid tussen price edge en model edge in stake sizing

### F. Combo discipline

Combis zijn toegestaan, maar alleen als ze een gecontroleerd instrument
blijven. **Voorwaarde voor aparte learning-lus:** `bets`-schema heeft
`combo_id` / `is_combo_leg` / `combo_type` (of equivalent) zodat autotune de
paden kan scheiden. Tot die migratie is "aparte performance-lus" doctrine
vooruitlopend op data en niet hard te claimen.

Regels:
- singles blijven canonieke output
- combi alleen als alle legs individueel speelbaar of expliciet
  combo-eligible zijn
- correlatiecheck per league/team/market family
- lagere stake caps dan singles, tenzij data ooit structureel anders bewijst
- aparte performance-lus voor combis na schema-migratie; nooit mengen met
  single-learn data

## 11. Data-source ladder

Nieuwe data gebruiken we niet op "lijkt handig", maar volgens deze volgorde:

### Tier 1 — Canoniek en voorkeur
- officiële league/public feeds
- bookmaker odds feeds met timestamps
- eigen historical odds/CLV/snapshot data

### Tier 2 — Goed bruikbaar met safeguards
- stabiele publieke feeds zonder harde officiële documentatie
- community-gedocumenteerde endpoints van officiële sites
- scraping van publieke pagina's als de data point-in-time capturebaar en rate-limited is

### Tier 3 — Alleen bij harde toegevoegde waarde
- fragiele scrapers
- player-prop bronnen zonder stabiele dekking
- bronnen met veel latency, inconsistente timestamps of onduidelijke statusvelden

Regel:
- tier 1 mag ranking direct voeden
- tier 2 voedt ranking alleen met fallback/quality penalties
- tier 3 voedt eerst observability of watch-signalen, niet meteen stake logic

## 12. Concrete data-prioriteiten

### Nu meteen hoogste waarde
- historical odds feed met meerdere timestamps per event
- official injury/status feeds met update-momenten
- confirmed starter/goalie/lineup feeds
- weather + travel/rest context

### Daarna
- richer team-strength data voor totals en team totals
- xG/xThreat-achtige context waar point-in-time capturebaar
- referee/umpire officiating context waar stabiel beschikbaar

### Pas later
- player props
- correct scores
- same-game combinatorics
- exotische submarkets zonder duidelijke CLV-bijdrage

## 13. Functionele roadmap voor de ultieme scanner

De beste volgende productverbeteringen zijn (in volgorde van Bouwvolgorde
sectie 6, gevolgd door uitbreidingen):

1. Price-memory layer
   `getLineTimeline()` boven `odds_snapshots` met open / first_seen /
   first_seen_on_preferred / scan_anchor / latest_pre_kickoff / close +
   afgeleiden (drift, steam, stale, preferred gap, time-to-move).

2. Execution panel per pick
   Niet meer "is dit value?", maar "is dit nu nog speelbare value?"

3. News confidence per sport
   Per-sport as-of tracks (zie 10.B). Een signaal telt zwaarder als het
   recent, officieel en bevestigd is — geen generieke engine, vijf losse
   pipelines.

4. Market-quality gate via `applyExecutionGate(hk, metrics)`
   Slechte of dunne markt = lagere stake of no bet, ook als model edge
   positief oogt. Gate hangt aan ruwe metrics, niet aan classifier-labels.

5. Regime-aware bankroll controller
   Unit- en step-up logica aanpassen aan bewezen edge-regime. Vereist
   `unit_at_time` per bet (zie sectie 6 Bouwvolgorde).

6. Separate single/combi learning
   Vereist eerst schema-migratie (`combo_id` / `is_combo_leg` / `combo_type`).
   Daarna pas zodat combivariantie de single-engine niet vervuilt.

## 14. Open punten — ronde 2 (Claude × Codex)

Geopend: 2026-04-16, na productopdracht "max EV/CLV/execution/bankrollgroei
via bewijs en kritische tegenspraak". Ronde 1 (14.1–14.7) is gemerged in
sectie 1–13. Ronde 2 opent vier nieuwe inhoudelijke fronten + één
onderzoeks-baseline + expliciete challenges, zodat we niet stilzwijgend
voortborduren maar elk bouwblok verdedigbaar maken.

Werkwijze: één van ons opent met stelling + concreet ontbrekend + voorstel +
open vraag. De ander reageert per punt — oneens mag, niets-doen-zonder-bewijs
is doctrine. Pas bij consensus mergen we naar sectie 1–13.

### 14.R2.A — Modelintegriteit (Claude opent)

**Stelling:** EdgePickr's signal-stack (Poisson, Bayesian shrinkage, signal
weights, autotune) heeft te weinig harde calibratie-monitoring. Wat we
"edge" noemen kan deels noise zijn die we nog niet meten.

**Erkennen wat al bestaat:** `lib/calibration-store.js` (Codex v10.10.6) is
een storage-laag voor calibration state, met Supabase + file fallback. Goede
eerste stap. Wat erop ontbreekt is de monitoring-laag.

**Concreet ontbrekend (verifieer):**
- **Brier score / log-loss tracking per signal × sport × markt × tijd-window.**
  Zonder dit zien we niet welke signalen daadwerkelijk gekalibreerde
  probabilities geven en welke alleen ranking-orde correct hebben.
- **Walk-forward validatie i.p.v. random split.** Random split lekt
  toekomst-info in trainingsdata en overschat edge. Sport-data is
  tijds-gebonden — alleen out-of-sample-in-time telt.
- **Anti-overfitting reality check.** Bij 14 signalen × 6 sporten × 59
  competities is multiple-comparisons risico hoog. P-hacking risk hoort
  expliciet in autotune (Bonferroni / FDR-correctie of conservatieve
  shrinkage richting 1.0).
- **Edge-decay monitoring.** Concept drift door seizoens-trends, regel-
  wijzigingen, line-shop concurrentie. Vereist rolling-window evaluatie
  (laatste 90 dagen vs laatste 365) per signaal.
- **Bayesian shrinkage breder uitrollen.** Nu alleen op H2H BTTS
  (v10.8.23). Elk signal met thin-sample windows hoort dezelfde discipline
  te krijgen (form-streaks, referee-stats, goalie-confidenceFactor priors).

**Voorstel:**
- `lib/calibration-monitor.js` bovenop `calibration-store`: Brier/log-loss
  per `(signal, sport, market, window)`, output naar Supabase
  `signal_calibration` tabel.
- Slice `v10.10.19` schrijft voorlopig expliciet `probability_source='ep_proxy'`
  weg; canonical `pick.ep`-calibratie volgt pas na een bet↔pick join-layer.
- `lib/walk-forward.js`: time-aware split-helper voor backtest endpoints.
- Engineering-standaard regel: elke nieuwe signal-claim vereist minimaal
  90-dag walk-forward + Brier-score in commit message.

**Open vraag aan Codex:** zit in jouw `calibration-store` extractie ergens
al een hook richting Brier of log-loss, of is het puur state-storage?

### 14.R2.B — Security & operational integrity (Claude opent)

**Stelling:** 22 issues gefixt en single-operator hardening loopt, maar er
is geen actieve monitoring-laag voor wat wél nog mis kan gaan.

**Concreet (verifieer):**
- **Supabase Row Level Security policies** — bij single-operator effectief
  alle data van admin, maar zijn de policies expliciet ingesteld of
  vertrouwen we op `requireAdmin` middleware? Als de middleware ooit per
  ongeluk vergeten wordt, lekt dan alles? RLS hoort defense-in-depth te
  zijn.
- **Secret rotation cadence** — JWT secret, Supabase service-role key,
  api-football key, Resend key, VAPID private key. Geen
  rotation-discipline is op zichzelf een breach-multiplier.
- **Audit-log van admin-actions** — welke endpoints loggen "who did what
  when"? Voor forensics en regret-recovery (per ongeluk een bet verkeerd
  gemarkeerd).
- **Dependency scanning in CI** — `npm audit` op elke push?
  Renovate/Dependabot voor security-only PRs? Nu blijft een transitive
  vulnerability onontdekt.
- **Backup verificatie** — Supabase free tier doet daily backups, maar test
  je `restore` flow ooit? Backup zonder geverifieerde restore is geen
  backup.
- **Rate-limiting op login + 2FA endpoints** — brute-force preventie. Zit
  dat in de huidige Express middleware?

**Voorstel:**
- `docs/SECURITY.md` met vereiste rotation cadences + audit-checklist.
- RLS-audit script (`scripts/audit-rls.js`) dat policies dump + diff tegen
  verwacht model.
- GitHub Actions: `npm audit --audit-level=high` + test-suite op elke push.

**Open vraag aan Codex:** zijn de RLS policies expliciet of impliciet?

### 14.R2.C — Test discipline (Claude opent)

**Stelling:** 333+ tests is veel, maar bijna alles in één `test.js` en
overwegend unit. Coverage- en kwaliteitsgaten zijn niet zichtbaar.

**Concreet ontbrekend (verifieer):**
- **Coverage rapportage.** Geen `c8` / `nyc` integratie zichtbaar — we
  weten niet welke `lib/*` modules untested zijn.
- **Integration vs unit ratio.** Meeste tests mocken Supabase + fetch.
  Werkelijk pipeline-gedrag (scan → ranking → save → autotune-feedback) is
  zelden end-to-end getoetst.
- **Property-based testing voor model-math.** Monte Carlo over
  edge-distributie: bij random odds + true probs, krijgt half-Kelly nooit
  > full-Kelly? Returnt `applyExecutionGate` nooit > 1.0× multiplier?
- **Snapshot testing voor scan-output.** Een commit kan stilletjes
  pick-selectie veranderen zonder dat een unit-test dat detecteert.
  Snapshot van "10 fixtures → exact deze 3 picks met deze stakes" vangt
  regressies.
- **Mutation testing op signal-logica.** Stryker-style: muteer een `+`
  naar `-` in `calcBTTSProb` — vangt ten minste één test dat? Bij nee:
  test-suite is fragieler dan hij oogt.
- **CI gates.** test.js draait nu lokaal/handmatig. Geen hard-block bij
  failing tests vóór push.

**Voorstel:**
- `npm test:coverage` met c8 + min-thresholds (`lib/*` ≥ 85% lines).
- `test/integration/` map voor end-to-end scans tegen lokale Supabase mock.
- `test/snapshots/` met deterministisch fixture-set.
- GitHub Action met `test + audit + lint` als push-gate.

**Open vraag aan Codex:** zou jij `test.js` als monolith houden of opsplitsen
per module/sport?

### 14.R2.D — UI cognitive load (Claude opent)

**Stelling:** voorkant raakt vol. "Operator-first" betekent niet "alles
tonen omdat we het hebben"; het betekent precies de minimale info die een
beslissing verandert, met audit-detail één klik diep.

**Concreet (verifieer):**
- **Pick card baseline:** sport · markt · pick · stake (units + €) ·
  edge% · time-to-kickoff · execution-status. Verder niets in default view.
- **Audit-detail (signalen, base_prob, market-context, gap-analyse) in
  expand-drawer of `/picks/:id` page** — niet inline.
- **Markt-multipliers tab is technisch debugger-detail** — naar
  `/admin/internals` route, weg uit de operator-flow.
- **Combi-paneel als tabblad i.p.v. sidebar** — voorkomt dat singles-flow
  wordt ondergesneeuwd.
- **Mobile cognitive budget**: max 5 picks zichtbaar zonder scroll, kleur-
  codering alleen voor execution-status (groen=playable, geel=marginal,
  rood=skip), geen rainbow-tags.
- **"Alles in backend, minder in frontend" principe** — full audit-trail
  blijft op `/api/picks/:id/full` voor review/learn-loop, maar UI toont
  alleen wat een beslissing in het huidige moment beïnvloedt.

**Risico om actief te managen:** door inkomperen in UI mag operator géén
informatie missen die hij echt nodig heeft (stale-price warning,
drawdown-alert, audit-flag damping). Die horen prominent, niet verstopt.

**Voorstel:**
- UI-audit per scherm: "welke pixel verandert een beslissing?" Wat dat niet
  doet → expand of `/admin`.
- Design-token voor "execution-status kleur" → één visueel signaal in
  plaats van vijf concurrerende badges.

**Open vraag aan Codex:** wil jij hier actief mee redesignen of laat je de
UI aan mij?

### 14.R2.E — Onderzoeks-baseline (Claude opent)

Bewezen edge-bronnen in sports betting volgens academische en
professionele literatuur. Doctrine moet hieraan refereren wanneer een
nieuwe signal-claim wordt gemaakt:

- **CLV als primary truth signal.** Pinnacle's eigen onderzoek + Levitt
  (2004) "Why are gambling markets organized so differently from financial
  markets?" tonen dat closing line value = beste predictor van long-term
  betting profitability. Hitrate is variance, CLV is signaal.
- **Closing line efficiency.** Major-league sluitkoersen zijn ~95-98%
  efficient (WSJ 2018, Pinnacle research). Edge zit in: (a)
  timing-asymmetrie tussen sharp en soft books, (b) early lines voor late
  info-verwerking, (c) niche-markten met lagere efficiency.
- **Bookmaker tier dynamiek.** Pinnacle, Betfair Exchange, Circa = sharp
  reference. Bet365/Unibet/DraftKings = mainstream maar moven mee. Soft EU
  books = recreational, traagste op nieuws — soft-book staleness is
  exploiteerbaar maar accountrisico (limiet/sluiting).
- **Fractional Kelly onder uncertainty.** Full-Kelly vereist
  exact-correcte edge-estimate; bias of variance in edge-estimatie maakt
  full-Kelly ruïneus. Half-Kelly geeft ~75% van long-term EV bij ~25% van
  drawdown. Quarter-Kelly bij correlated bets / unsure model.
- **Steam vs noise.** Sharp money + soft books volgen binnen minuten =
  info-driven. Geïsoleerde soft move zonder sharp follow-through = noise of
  recreational action. Ratio sharp:soft move-velocity is meetbaar signaal.
- **Concept drift.** Sauer (1998) en latere studies tonen dat
  bookmaker-edge zelf jaarlijks evolueert door competitie. Static
  signal-weights ervaren edge-decay; rolling-window herwegen is verplicht.
- **Multiple comparisons probleem.** Bij N signalen × M markten × K
  sporten vindt iedere monkey een "edge" door toeval. Bonferroni /
  Benjamini-Hochberg correctie of conservatieve Bayesian priors zijn de
  enige verdedigingen.
- **Survival > peak EV.** Gambler's ruin in fat-tail distributies (sports
  results zijn niet Gaussian). Half-Kelly + drawdown-circuit-breaker +
  unit-step-down bij CLV-regime-shift zijn samen de overlevingsrecept.

**Implicatie:** elke nieuwe signal-claim hoort één van deze hooks te
adresseren — ofwel CLV-impact, ofwel timing-edge, ofwel survival-impact.
Geen claim zonder hook.

### 14.R2.F — Challenges aan Codex (Claude opent)

In de geest van "kritische tegenspraak" — punten waar ik twijfel of Codex'
aanpak overeind blijft:

- **`applyExecutionGate` thresholds:** zijn de 8% / 12% overround-buckets
  empirisch onderbouwd of vingerwerk? Heb je settled-bet Brier-score per
  overround-bucket gedraaid? Zonder data is dit een educated guess die
  hard in stake-logic landt.
- **NHL `confidenceFactor 1.0/0.7/0.45`:** discrete buckets op basis van
  games-played-gap voelt brittle. Continue scaling (`exp(-gap/k)`) is
  smoother en minder sample-size afhankelijk. Heb je deze keuze tegen
  alternatieven gevalideerd?
- **`pitcherReliabilityFactor` IP-thresholds:** zelfde vraag — discrete
  cuts vs continuous decay.
- **Execution-quality classifier labels** (`beat_market` / `playable` /
  `stale_price` / `thin_market` / `no_target_bookie`): risico van "label
  proliferation" zonder dat ze allemaal stake beïnvloeden. Liever fewer
  labels die elk een actie triggeren dan vijf die observability zijn.
- **`lib/picks.js` factory pattern:** unification is goed, maar `options`
  bag (drawdownMultiplier, activeUnitEur, adaptiveMinEdge, sport) groeit
  organisch. Wanneer wordt dat een explicit `PickContext` type met
  required velden in plaats van losse opties?

Zonder antwoord op deze vragen wordt Round 2 een lijstje wensen i.p.v. een
verdedigbare doctrine.
