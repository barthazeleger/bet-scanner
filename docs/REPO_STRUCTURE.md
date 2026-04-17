# Repo Structure

Deze repo is bewust geen generieke SaaS-mapindeling. De hoofdvraag is:
waar woont runtime-logica, en welke modules zijn echt domeinen op zichzelf?

## Huidige indeling

### Root
- `server.js`
  De Express entrypoint en nog steeds de grootste orchestrator. Hier zit scan-
  coördinatie, scheduling, routes en een deel van de scanlogica.
- `index.html`, `styles.css`, `js/`
  Frontend/PWA-laag.
- `test.js`
  Centrale regressiesuite.
- `docs/`
  Doctrine, research, migratie-archief en reviewdocumenten.
- `scripts/`
  Operationele scripts die geen runtime-pad van de app zijn.

### `lib/`
Kleine, herbruikbare domeinmodules die direct door de scan- of API-flow gebruikt
worden.

- Core model/pick/market:
  - `model-math.js`
  - `odds-parser.js`
  - `picks.js`
  - `execution-gate.js`
  - `execution-quality.js`
  - `line-timeline.js`
  - `playability.js`
  - `correlation-damp.js`
  - `snapshots.js`
  - `clv-match.js`
  - `calibration-monitor.js`
  - `calibration-store.js`

- App/runtime support:
  - `config.js`
  - `db.js`
  - `app-meta.js`
  - `modal-advice.js`
  - `stake-regime.js`
  - `walk-forward.js`

### `lib/integrations/`
Alles wat primair gaat over externe providers, scrapers of bronaggregatie.

- `scraper-base.js`
  Shared fetch/circuit-breaker/rate-limit primitives.
- `api-sports-capabilities.js`
  Bron-capabilities en support-matrix.
- `nhl-goalie-preview.js`
  NHL preview integration.
- `data-aggregator.js`
  Merge-laag boven meerdere externe sources.
- `sources/`
  Bronadapters per provider:
  - `sofascore.js`
  - `fotmob.js`
  - `nba-stats.js`
  - `nhl-api.js`
  - `mlb-stats-ext.js`

### `lib/runtime/`
Kleine modules die niet “algemene business logic” zijn, maar specifieke
runtime/operator workflows ondersteunen.

- `daily-results.js`
  Post-results scheduler-gating.
- `live-board.js`
  Live-board inclusion/status helpers.
- `operator-actions.js`
  Kleine operatorgerichte acties zoals targeted CLV recompute matching en early
  live-settlement helpers.

## Waarom deze indeling

De belangrijkste structurele pijn zat niet in mapnamen, maar in het feit dat
`server.js` tegelijk integraties, runtime-workflows en pure domeinlogica
aanraakte.

Met deze split is de grens duidelijker:
- `lib/` = app-domein
- `lib/integrations/` = externe bronnen en fetch-primitives
- `lib/runtime/` = kleine operationele workflows en scheduler/live helpers

## Wat bewust nog niet is gedaan

- `server.js` is nog niet opgesplitst in route files of sport-specific services.
- `auth/config/db` zijn nog niet volledig gecollapsed naar één consistente
  infrastructuurlaag.
- Er is geen cosmetische massale rename gedaan van alle bestaande modules.

Die dingen zijn pas zinvol als ze ook echt verantwoordelijkheden uit
`server.js` halen, niet alleen omdat een map “netter” oogt.
