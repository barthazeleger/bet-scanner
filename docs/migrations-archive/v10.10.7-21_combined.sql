-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v10.10.7 → v10.10.21 — alle openstaande migraties
-- Veilig om in één keer te draaien (IF NOT EXISTS overal).
-- ═══════════════════════════════════════════════════════════════════════════════

-- v10.10.7: unit_at_time op bets
alter table public.bets
  add column if not exists unit_at_time numeric;

-- v10.10.16: signal_calibration tabel (Brier/log-loss monitoring)
create table if not exists public.signal_calibration (
  id                bigint generated always as identity primary key,
  signal_name       text not null,
  sport             text,
  market_type       text,
  window_key        text not null check (window_key in ('30d', '90d', '365d', 'lifetime')),
  window_start      timestamptz,
  window_end        timestamptz,
  n                 int not null default 0,
  n_effective       numeric(10,3),
  brier_score       numeric(10,6),
  log_loss          numeric(10,6),
  avg_prob          numeric(10,4),
  actual_rate       numeric(10,4),
  bin_payload       jsonb,
  attribution_mode  text check (attribution_mode in ('weighted', 'uniform', 'mixed')),
  probability_source text not null default 'ep_proxy'
                   check (probability_source in ('ep_proxy', 'pick_ep')),
  updated_at        timestamptz not null default now()
);

create unique index if not exists signal_calibration_unique_idx
  on public.signal_calibration(signal_name, coalesce(sport, ''), coalesce(market_type, ''), window_key);

create index if not exists signal_calibration_sport_idx on public.signal_calibration(sport);
create index if not exists signal_calibration_window_idx on public.signal_calibration(window_key);
create index if not exists signal_calibration_brier_idx on public.signal_calibration(brier_score asc nulls last);

-- v10.10.21: sharp CLV (Pinnacle closing line)
alter table public.bets
  add column if not exists sharp_clv_odds numeric;

alter table public.bets
  add column if not exists sharp_clv_pct numeric;
