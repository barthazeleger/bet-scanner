# Bet Scanner v5.1

Data-gedreven sportsbetting platform met een zelflerend prediction model, real-time tracking en automatische notificaties.

## Wat het doet

Bet Scanner scant dagelijks 40 voetbalcompetities wereldwijd, vindt value bets waar bookmakers het mis hebben, en leert van elke bet om steeds beter te worden.

### Core features

| Feature | Beschrijving |
|---|---|
| **Dagelijkse scan** | Automatisch om 10:00 — analyseert wedstrijden van vandaag + nachtwedstrijden tot 10:00 volgende ochtend |
| **14 signalen** | Thuisvoordeel, vorm, H2H, blessures, standings, team stats, home/away splits, lineup, referee, API predictions, O/U adjustments, weer (regen/wind), Poisson model, fixture congestion |
| **6 markten** | Match Winner, Over/Under, BTTS, Draw No Bet, Handicap, Gelijkspel |
| **Kelly Criterion** | Half-Kelly sizing: 0.3U (voorzichtig) tot 2.0U (sterk vertrouwen) |
| **Self-learning** | Markt multipliers, signal gewichten en EP-buckets passen zich automatisch aan |
| **CLV tracking** | Slotodds ophalen bij aftrap — meet of je de markt verslaat |
| **Variance tracker** | Geluk vs skill: sigma-afwijking van verwachte resultaten |

### Tracking & monitoring

| Feature | Beschrijving |
|---|---|
| **Mijn Bets tab** | Live scores van je open bets, auto-refresh 30s via ESPN |
| **Tracker** | Volledige bet history met W/L, CLV%, score, periode-filter |
| **Data tab** | Bankroll grafiek, hit rate per score/markt, CLV analyse, signal attribution, timing analyse |
| **Inbox** | Model activity feed: calibraties, signal tuning, milestones, inzichten |
| **Status** | Service health, API budget, model status |

### Notificaties

| Kanaal | Wat |
|---|---|
| **Telegram** | Dagelijkse picks, pre-kickoff checks (30 min), odds movement alerts (elk uur), CLV bij aftrap, model updates, milestones |
| **Push (PWA)** | Dagelijks overzicht om 06:00 |
| **Browser** | Live bet events: goal over O/U lijn, team achter/voor, wedstrijd afgelopen |

### Beveiliging

- JWT authenticatie met login pagina
- Bcrypt password hashing
- Admin panel: gebruikers goedkeuren/blokkeren
- Registratie met Telegram notificatie aan admin

## Tech stack

```
Node.js + Express          Server
Google Sheets              Database (bets, users, scan history)
api-football.com Pro       Primaire data (7500 calls/dag, EUR 19/mnd)
ESPN Scoreboard API        Live scores auto-refresh (gratis, onbeperkt)
Telegram Bot API           Notificaties (gratis)
Render.com                 Hosting (free tier + keep-alive)
Web Push API               PWA push notificaties
```

## Installatie

### 1. Clone & install
```bash
git clone https://github.com/barthazeleger/bet-scanner.git
cd bet-scanner
npm install
```

### 2. Environment variables
```bash
# Google Sheets
SHEET_ID=your_sheet_id
GOOGLE_CREDENTIALS_JSON={"type":"service_account",...}

# API keys
API_FOOTBALL_KEY=your_api_football_key

# Auth
JWT_SECRET=random_64_hex_string
ADMIN_EMAIL=your@email.com
ADMIN_PASSWORD=your_password

# Optioneel
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
```

### 3. Google Sheet setup
Het systeem maakt automatisch de benodigde tabs aan:
- **Sheet1** (of eerste tab): bets, rij 19+
- **Users**: gebruikersbeheer
- **ScanHistory**: scan resultaten

### 4. Start
```bash
npm start
# Server draait op http://localhost:3000
```

### 5. Deploy op Render
```bash
# render.yaml is geconfigureerd
# Voeg environment variables toe via Render dashboard
```

## Hoe het model werkt

```
1. Odds ophalen          Bet365 + Unibet via api-football
2. No-vig berekening     Verwijder bookmaker marge -> fair probability
3. 14 signalen           Pas kans aan op basis van data (+/- per signaal)
4. Kelly Criterion       Bereken optimale inzet op basis van edge
5. Threshold filter      Alleen picks met voldoende expected profit
6. Calibratie            Model leert van resultaten (markt, EP, signals)
```

### Self-learning cyclus

```
Bet gelogd -> Wedstrijd afgelopen -> Uitkomst bepaald -> Calibratie update
                                                              |
                                  Markt multiplier aangepast <-+
                                  EP bucket hergewogen        <-+
                                  Signal gewichten getuned    <-+ (dagelijks)
```

## 59 competities

| Regio | Competities |
|---|---|
| **Engeland** | Premier League, Championship, League One, League Two |
| **Spanje** | La Liga, La Liga 2 |
| **Duitsland** | Bundesliga, 2. Bundesliga |
| **Italie** | Serie A, Serie B |
| **Frankrijk** | Ligue 1, Ligue 2 |
| **Nederland** | Eredivisie, Eerste Divisie |
| **Portugal** | Primeira Liga, Liga 2 |
| **Europa** | UCL, UEL, UECL |
| **Overig EU** | Belgie, Turkije, Schotland, Oostenrijk, Zwitserland, Denemarken, Noorwegen, Zweden, Griekenland, Polen, Tsjechie, Roemenie, Kroatie, Rusland, Oekraine |
| **Wereld** | MLS, Liga MX, Brasileirao, Argentina, Saudi, Japan |

## API budget

| Actie | Calls |
|---|---|
| Dagelijkse scan (10:00) | ~200-400 |
| Live scores (eerste load) | ~2 |
| Pre-kickoff check | ~2 per bet |
| CLV check bij aftrap | ~2 per bet |
| Odds monitor (elk uur) | ~1 per open bet |
| Check uitslagen | ~2 |
| **Dagelijks totaal** | ~300-600 van 7500 |

## Versiegeschiedenis

| Versie | Datum | Highlights |
|---|---|---|
| **v5.1** | apr 2026 | 59 competities, weer/Poisson/congestion, drawdown, bookmaker tracking, scan tot 10:00 |
| **v5.0** | apr 2026 | 59 competities, weer data, Poisson model, fixture congestion, drawdown protection |
| **v4.10** | apr 2026 | POTD generator, modal herberekening, push fix, sorteerbare tracker |
| **v4.8** | apr 2026 | PWA, push notificaties, status pagina, mobile-first, iOS bottom nav |
| **v4.5** | apr 2026 | Mijn Bets tab, correlatie-check, ESPN auto-refresh, signal auto-tuning, inbox |
| **v4.2** | apr 2026 | CLV tracking, signal attribution, variance tracker, BTTS/DNB, odds alerts |
| **v4.1** | apr 2026 | Login systeem, JWT auth, per-user settings, admin panel |
| **v3.6** | apr 2026 | Score/markt analyse, bankroll herbereken |
| **v3.5** | apr 2026 | Periode filter, vergelijkfunctie |
| **v3.4** | apr 2026 | Volledige api-football migratie, 40 competities |
| **v3.3** | apr 2026 | Bankroll fix, score tracking |
| **v3.2** | apr 2026 | Dashboard restyling, notificaties |

## Licentie

Private repository. Alle rechten voorbehouden.

---

Gebouwd met [Claude Code](https://claude.ai/code) door Anthropic.
