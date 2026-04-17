# EdgePickr — Claude Code Instructions

## Wat is dit project
EdgePickr is een private betting terminal voor één operator (Bart). Data-driven sports betting picks met zelflerend model, 6 sporten, 59 competities, 14 signalen. Doel: structureel de markt verslaan via CLV, execution quality en bankroll-discipline.

## Stack
- **Backend**: Node.js/Express (`server.js` ~12k regels)
- **Database**: Supabase (PostgreSQL), RLS enabled op alle tabellen
- **Frontend**: Monolitisch `index.html` met inline JS
- **APIs**: api-football.com Pro, ESPN live scores, MLB StatsAPI, NHL API, Open-Meteo weer
- **Hosting**: Render.com (free tier)
- **Notificaties**: Web Push (VAPID, per-user scoped) + Supabase `notifications` inbox — sinds v10.12.0. Telegram verwijderd.

## Repo-structuur
Zie `docs/REPO_STRUCTURE.md` voor de volledige indeling. Kernpunten:
- `lib/` — core model/pick/market modules
- `lib/integrations/` — externe providers, scrapers, source-adapters
- `lib/runtime/` — scheduling, live-board, operator-workflow helpers
- `docs/PRIVATE_OPERATING_MODEL.md` — actieve productdoctrine
- `docs/RESEARCH_MARKETS_SIGNALS.md` — markt/signal research

## Werkafspraken

### Versioning
- Semver bij elke push. CHANGELOG.md automatisch bijwerken.
- Versie-pin in test.js (`appMeta.APP_VERSION`) meebumpen.
- Alle versie-locaties: `lib/app-meta.js`, `package.json`, `package-lock.json`, `index.html` (2 plekken), `README.md`, `docs/PRIVATE_OPERATING_MODEL.md`.

### Commit-discipline
- `[claude]` prefix op commits van Claude.
- `[codex]` prefix op commits van Codex (GPT-reviewer).
- `[claude+codex]` voor gezamenlijke releases.
- Gedetailleerde commit messages met WHAT/WHY/IMPACT.

### Geen deploys rond scan-tijden
07:30, 14:00, 21:00 Amsterdam — Render-deploys breken actieve scans af.

### Testen
- `npm test` moet groen zijn vóór elke push.
- Nieuwe pure helpers krijgen unit tests.
- Async tests via `runAsyncTests()` queue (geen parallel mock-conflicts).

### Code-stijl
- Geen hardcoding van waarden die configureerbaar horen te zijn.
- Security-first: valideer input aan system-boundaries, niet intern.
- Geen comments die WHAT beschrijven — alleen WHY als het niet-obvious is.
- Geen features bouwen voor hypothetische toekomst.

## Samenwerking Claude × Codex

### Werkmodel
- **Claude codet, Codex reviewt** (tenzij anders afgesproken per slice).
- Codex krijgt veto op ontwerp-keuzes vóór implementatie begint.
- Bij meningsverschil: expliciet uitschrijven als "Open vraag" in doctrine, Bart beslist.

### Review-discipline
- Per finding: `[P-level] file:line — beschrijving + voorstel`
- P0 = security exploit met concreet aanvalspad
- P1 = correctness bug of data-corruptie
- P2 = quality/hardening (defense-in-depth)
- P3 = performance
- P4 = doctrine/informatief
- Geen "waarschijnlijk oké" — bewijs of het is een finding.

### Claude-specifieke discipline (Codex-feedback 2026-04-17)
- **Lees de hele data-flow vóór je "af" claimt.** Niet alleen de gewijzigde regels — trace write → read → consumer end-to-end.
- **Security-labels niet te hoog.** Geen P0 zonder concreet exploit-pad. Hardening = P2.
- **Doe een onafhankelijke code-read vóór ontwerp-aannames.** F5-flow was al compleet in de code toen ik een greenfield-voorstel deed.

## Doctrine-referenties
- **Bouwvolgorde**: unit_at_time → price-memory → execution-gate → signal expansion
- **Execution truth ≠ sharp truth**: Pinnacle/Betfair = sharp reference (CLV-anchor), Bet365/Unibet = execution books. Nooit mengen.
- **Singles canoniek**: combi's alleen bij expliciete same-game correlatie met bewezen voordeel boven parlay-tax.
- **Low-touch**: 3 scans + uitzonderingsalerts. Geen always-on operator-terminal.
- **Survivability**: account-health op soft books meewegen. Niet te sharp op één bookie.

## Migraties
- SQL-bestanden in `docs/migrations-archive/`.
- Draai via: `node scripts/migrate.js docs/migrations-archive/<file>.sql`
- Script heeft destructive-query blocker (DROP/TRUNCATE/DELETE geweigerd).
- `.env` moet lokaal bestaan met SUPABASE_URL + SUPABASE_KEY + JWT_SECRET.

## Huidige versie
v10.12.0 — Telegram verwijderd, web-push + inbox enige operator-alert-kanaal.

## Open items voor volgende sprint
- Punt 16b: data-layer collapse (calcStats/readBets/writeBet → lib/db.js, vereist supabase-client unificatie)
- Punt 19: bet-id → UUID/auto-increment (schema-migratie)
- Punt 9 uitbreiding: resterende inline onclick handlers zonder user-data (low-risk, cosmetisch)
- Calibration-monitor: canonical pick.ep via bet↔pick_candidate join (vervangt ep_proxy)
- Concept-drift monitoring (rolling 90d vs 365d windows)
