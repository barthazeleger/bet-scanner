# EdgePickr Private Operating Model

Laatste update: 2026-04-16 (v10.10.4)

Dit document is de actieve productdoctrine voor EdgePickr. Niet het oude
SaaS-plan, maar de private operator-workflow is leidend.

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
- Kleine, production-safe diffs omdat elke push via Render live kan raken.
- Tests voor scanner, signalen, bankroll-logica en regressies zijn goedkoper dan stille edge-erosie.
- Elke change krijgt meteen een version bump, changelog update en info-page versie-update. Geen stille codewijzigingen zonder release-spoor.

## 6. Actieve roadmap

De roadmap is niet feature-first maar edge-first. Elke fase moet de scanner
inhoudelijk scherper maken of de discipline-lus veiliger maken.

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
- meer “skip” waar de markt of context te onduidelijk is

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

Prioriteiten:
- historisch expliciete money-state per bet waar nodig (`unit_at_time`, bankroll-context)
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
- geen dashboards bouwen die vooral “interessant” zijn maar geen actie sturen

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
- line timeline per pick: open, first seen, scan-time, pre-kickoff, close
- steam vs drift classificatie: beweegt de markt met info of zonder bevestiging?
- sharp-soft disagreement score: preferred bookies, soft books en sharp reference apart volgen
- stale-line detectie: pick krijgt bonus als preferred price achterloopt op sharp move, maar alleen kortdurend
- last-safe-entry logic: wanneer de price nog speelbaar is, wanneer niet meer

### B. Point-in-time team news engine

Veel edge verdwijnt omdat nieuws te laat, te grof of niet sport-specifiek genoeg binnenkomt.

Nodige functies:
- NBA: injury-status verandering + rest tags + confirmed availability
- NFL: official injury report + practice participation + weather/stadium context
- MLB: probable pitcher → confirmed starter → lineup status
- NHL: confirmed goalie + roster/injury confirmation
- Football: lineup certainty, late scratches, coach/staff changes, fixture congestion

Belangrijk:
- nieuws zonder timestamp of zonder as-of betrouwbaarheid telt niet mee in ranking
- nieuws-signalen moeten kunnen afzwakken als bevestiging ontbreekt

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

Bankrollgroei komt niet alleen uit goede picks maar uit goed opgeschaalde picks.

Nodige functies:
- `unit_at_time` en bankroll-context historisch per bet
- bewezen-edge tiers: exploratory, standard, scale-up
- step-up gate op basis van CLV, ROI, drawdown en sample size samen
- automatische step-down bij execution decay of CLV regime shift
- onderscheid tussen price edge en model edge in stake sizing

### F. Combo discipline

Combis zijn toegestaan, maar alleen als ze een gecontroleerd instrument blijven.

Regels:
- singles blijven canonieke output
- combi alleen als alle legs individueel speelbaar of expliciet combo-eligible zijn
- correlatiecheck per league/team/market family
- lagere stake caps dan singles, tenzij data ooit structureel anders bewijst
- aparte performance-lus voor combis; nooit mengen met single-learn data

## 11. Data-source ladder

Nieuwe data gebruiken we niet op “lijkt handig”, maar volgens deze volgorde:

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

De beste volgende productverbeteringen zijn:

1. Price-memory layer
   Volledige line history per event/market/book.

2. Execution panel per pick
   Niet meer “is dit value?”, maar “is dit nu nog speelbare value?”

3. News confidence engine
   Een signaal telt zwaarder als het recent, officieel en bevestigd is.

4. Market-quality gate
   Slechte of dunne markt = lagere stake of no bet, ook als model edge positief oogt.

5. Regime-aware bankroll controller
   Unit- en step-up logica aanpassen aan bewezen edge-regime.

6. Separate single/combi learning
   Zodat combivariantie de single-engine niet vervuilt.
