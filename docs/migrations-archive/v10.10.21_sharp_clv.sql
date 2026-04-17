-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v10.10.21 — sharp CLV (Pinnacle closing line als ground truth)
--
-- Twee CLV-meetpunten per bet:
--   clv_pct / clv_odds = execution-CLV (preferred bookie closing, bestaand)
--   sharp_clv_pct / sharp_clv_odds = sharp-CLV (Pinnacle closing, nieuw)
--
-- Industrie-standaard: positieve sharp-CLV = betere odds dan Pinnacle's
-- sluitkoers = bewijs dat het model de markt verslaat.
-- ═══════════════════════════════════════════════════════════════════════════════

alter table public.bets
  add column if not exists sharp_clv_odds numeric;

alter table public.bets
  add column if not exists sharp_clv_pct numeric;

comment on column public.bets.sharp_clv_odds is
  'Pinnacle closing odds voor deze markt (uit odds_snapshots, laatste snapshot '
  'vóór kickoff). NULL als Pinnacle geen prijs had.';

comment on column public.bets.sharp_clv_pct is
  'Sharp CLV: (loggedOdds - pinnacleClosing) / pinnacleClosing × 100. '
  'Positief = betere prijs dan Pinnacle closing = bewijs van model-edge.';
