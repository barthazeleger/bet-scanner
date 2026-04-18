# Early-payout rules per bookie

Doel: executie-edge vangen die niet in CLV zit. Soft-books (Bet365) betalen
een Moneyline-weddenschap soms eerder uit dan Pinnacle, op basis van een
tussenstand. Als die conditie regelmatig triggered tijdens matches waar de
finale uitkomst alsnog een loss is, levert de soft-book een structurele
execution-lift op — ook als de odds gemiddeld 1–3% lager zijn.

Deze module is in **shadow mode**: we loggen per settled bet of de EP-rule op
enig moment activeerde, en of dat een L naar W zou hebben geconverteerd.
Geen scoring-impact tot 50+ samples per bookie-sport-market combinatie EN
bewezen netto-lift > odds-cost (zie `project_signal_promotion_doctrine`).

---

## Bet365 (primary case)

Bron: bet365 promotional T&Cs (gecached 2026-04-18). Operator bevestigt regels
vóór activatie in scoring.

| Sport | Markt | Regel | Status |
|---|---|---|---|
| Football (soccer) | Match Winner | **2 Goals Ahead** — als jouw team op enig moment 2+ goals voorsprong heeft, wordt ML als W uitbetaald, ongeacht eindstand | Actief |
| Football | Draw No Bet | 2 Goals Ahead (gelijk aan ML-variant) | Actief |
| Football | Double Chance | Niet van toepassing (rule vereist concrete team) | n.v.t. |
| Football | Over/Under | Niet van toepassing (total-markt, geen team-lead) | n.v.t. |
| Football | BTTS | Niet van toepassing | n.v.t. |
| Baseball (MLB) | Moneyline (9-inning of F5) | **5 Run Lead** — team met 5+ runs voorsprong op enig moment → ML uitbetaald als W | Actief |
| Basketball (NBA, reguliere fase) | Moneyline | **20 Point Lead** — team met 20+ point lead op enig moment → ML uitbetaald als W. Playoff-regels soms anders. | Actief (regulier) |
| Basketball (NBA, playoffs) | Moneyline | Minder betrouwbaar; verify per seizoen | Verify |
| Ice Hockey (NHL) | Moneyline | **3 Goal Lead** — 3+ doelpunten voorsprong op enig moment → ML uitbetaald als W | Actief |
| American Football (NFL) | Moneyline | **17 Point Lead** → ML uitbetaald als W. Playoff-variant soms anders. | Actief (reg) |
| Handball | Moneyline | **7 Goal Lead** — heuristiek op basis van bekende patronen. Verify per competitie. | Verify |
| Alle sporten | Totals / Spreads / Handicap | Geen early payout rule bekend — pure full-time settlement | n.v.t. |
| Alle sporten | BTTS / NRFI / niche | Geen early payout rule | n.v.t. |

Tennis, darts, snooker zijn nu buiten scope van EdgePickr. Als dat verandert:
- Tennis: 2 Sets Ahead — ML uitbetaald na 2 gewonnen sets (bij best-of-3 of best-of-5)
- Darts: First to reach N legs — variabel, verify.

## Unibet (Kindred Group)

Bron: unibet.nl voorwaarden + historisch. Verify per seizoen.

| Sport | Markt | Regel | Status |
|---|---|---|---|
| Alle | Alle | Geen blanket early-payout regel. Per-wedstrijd promo's ("insurance") vallen buiten scoring-framework. | Geen EP |

## Bet365, Unibet — effect op jouw bookie-keuze

Bet365 odds liggen op populaire voetbal-ML markten typisch 1–3% onder de
beste Unibet prijs (gecheckt 20 steekproeven, april 2026). Dat betekent: de EP-coverage
moet een conversie-lift geven van ≥ break-even voor preferred-bookie-switch
naar Bet365 +EV te zijn.

Break-even berekening (ruwe orde van grootte):
- Baseline ML @ 2.00 kans 50%, edge 0% (fair). EV = 0.
- Als Bet365 @ 1.97 geeft maar EP rule 2% kans van L → W conversie: extra EV = 0.02 × 2.00 = +0.04 op €100 stake (4% gross). Odds-cost = −1.5%. Net +2.5% → positief.
- Als conversie-rate < 1%: net negatief → stick met Unibet.

Die per-markt conversie-rate moeten we eerst **meten** via shadow-log voordat we
scoring aanpassen. Doctrine: geen scoring zonder 50+ samples + verified lift.

## Pinnacle, Betfair

Geen EP-regels. Pure FT settlement.

## William Hill, Betway

Historisch wisselend. Geen blanket regel. Bij activatie: verify actuele
promo-pagina per sport.

---

## Hoe de shadow-log werkt

1. Na elke settled bet (W/L) checkt `checkEarlyPayoutActivation()` via
   match-statistieken of de EP-regel op enig moment tijdens de wedstrijd is
   getriggerd.
2. Resultaat wordt gelogd in de `early_payout_log` tabel met:
   - `bet_id`, `bookie_used`, `sport`, `market_type`, `selection_key`
   - `ep_rule_applied` (bool — geldt er een EP-regel voor deze (bookie, markt)?)
   - `ep_activated` (bool — is de regel daadwerkelijk getriggerd tijdens de match?)
   - `ep_would_have_paid` (bool — als de regel was toegepast, zou het een W zijn geweest?)
   - `actual_outcome` (W/L)
   - `potential_lift` (bool — `actual_outcome=L AND ep_would_have_paid=true`)
3. Aggregaties in `/api/admin/v2/early-payout-summary`: per bookie-sport-markt combinatie
   - `samples`, `activation_rate`, `conversion_rate` (L→W via EP)
   - `odds_cost_avg` (soft-book vs market-best gemiddelde spread)
   - `net_expected_lift` (conversion × payout − odds_cost)

## Promotie-drempel (doctrine gedreven)

Signaal promoveert van shadow (weight=0) → actief wanneer:
- `samples ≥ 50` per (bookie, sport, market) combinatie
- `conversion_rate > odds_cost_avg + 1% safety margin`
- Walk-forward backtest toont Brier-improvement bij gebruik van coverage-boost

Demotie: bij drift (walk-forward Brier degradatie > 0.01 over 30d rolling) →
auto-terug naar shadow.

## Open vragen

- **API voor match-verloop**: api-sports biedt live-score events (goals/periods)
  voor voetbal/basketball/hockey/baseball/NFL. Voor oudere bets moet `fixture_events`
  endpoint nog gequery worden; throttle 200ms.
- **Handbal + NFL playoff**: regels minder stabiel; alleen activeren bij
  bevestiging van operator.
- **Multi-bookie matching**: als bet is geplaatst bij Unibet (geen EP) maar
  gelijkwaardige odds waren bij Bet365 beschikbaar tijdens scan, log counter-
  factual: `would_have_been_w_with_bet365=true`. Helpt operator beoordelen of
  preferred-bookie switch waardevol is.
