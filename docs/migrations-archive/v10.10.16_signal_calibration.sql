-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v10.10.16 — signal_calibration tabel
--
-- Doctrine: sectie 14.R2.A (Modelintegriteit). Meet of onze signaal-
-- voorspellingen daadwerkelijk gekalibreerd zijn.
--
-- Separate van signal_stats (dat is lifetime/summary). Deze tabel is
-- window-based en rijker in shape: Brier/log-loss/bins per
-- (signal_name, sport, market_type, window_key).
--
-- Codex-review v10.10.15 keuzes:
--   - nieuwe tabel i.p.v. signal_stats uitbreiden
--   - vaste windows: 30d/90d/365d/lifetime
--   - attribution_mode expliciet opgeslagen (weighted/uniform/mixed)
--   - bin_payload als JSON voor reliability-diagram data
--   - probability_source expliciet opgeslagen zodat v1 ep_proxy niet als
--     canonical pick.ep gelezen wordt
-- ═══════════════════════════════════════════════════════════════════════════════

create table if not exists public.signal_calibration (
  id                bigint generated always as identity primary key,
  signal_name       text not null,
  sport             text,
  market_type       text,
  window_key        text not null check (window_key in ('30d', '90d', '365d', 'lifetime')),
  window_start      timestamptz,
  window_end        timestamptz,
  n                 int not null default 0,
  n_effective       numeric(10,3),             -- som van attribution-weights
  brier_score       numeric(10,6),             -- mean((prob - outcome)^2)
  log_loss          numeric(10,6),             -- -mean(y·log(p) + (1-y)·log(1-p))
  avg_prob          numeric(10,4),
  actual_rate       numeric(10,4),
  bin_payload       jsonb,                     -- array van bin-objects: {bin, binStart, binEnd, n, avgProb, actualRate}
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

comment on table public.signal_calibration is
  'Per-window Brier/log-loss/bin kalibratie per (signal, sport, market_type). '
  'Separate van signal_stats (lifetime summary). Gevuld door daily job uit '
  'lib/calibration-monitor.js. Doctrine sectie 14.R2.A.';

comment on column public.signal_calibration.attribution_mode is
  'Hoe signaal-bijdrage aan pick is gealloceerd: weighted (parseable %), '
  'uniform (geen %), of mixed (mix binnen bucket). Stabiele evaluatie-regime.';

comment on column public.signal_calibration.probability_source is
  'Bron van de voorspelde kans: v1 gebruikt ep_proxy (1/odds + signal boosts); '
  'latere slice kan pick_ep schrijven zodra bet↔pick join bestaat.';
