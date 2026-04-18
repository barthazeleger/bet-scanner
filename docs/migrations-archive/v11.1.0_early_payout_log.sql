-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v11.1.0 — early_payout_log (shadow-mode tracking)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Fase 4 doctrine-hook: nieuwe signalen shippen in shadow-mode (weight=0),
-- promoveren pas na 50+ samples + bewezen lift. Deze tabel verzamelt per
-- settled bet of een early-payout regel van de gebruikte bookie had kunnen
-- activeren op basis van final-score. Volledige peak-lead-during-match
-- meting volgt in shadow v2 (fixture /events endpoint).

create table if not exists early_payout_log (
  id                      bigserial primary key,
  bet_id                  bigint,
  bookie_used             text,
  sport                   text,
  market_type             text,
  selection_key           text,
  actual_outcome          text,
  ep_rule_applied         boolean not null,
  ep_activation_estimate  text,
  ep_would_have_paid      boolean,
  potential_lift          boolean,
  final_score_home        integer,
  final_score_away        integer,
  odds_used               numeric(10, 4),
  odds_best_market        numeric(10, 4),
  logged_at               timestamptz not null default now()
);

create index if not exists idx_early_payout_log_bookie_sport_market
  on early_payout_log (bookie_used, sport, market_type);
create index if not exists idx_early_payout_log_logged_at
  on early_payout_log (logged_at);
create index if not exists idx_early_payout_log_bet_id
  on early_payout_log (bet_id);

alter table early_payout_log enable row level security;

-- Service-role krijgt volledige access (backend gebruikt service_role key).
-- Patroon is consistent met bets/notifications/signal_weights tabellen.
drop policy if exists early_payout_log_service_all on early_payout_log;
create policy early_payout_log_service_all on early_payout_log
  for all using (true) with check (true);
