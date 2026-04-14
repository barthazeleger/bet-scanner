-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v9.7.0 — v2 Pick Pipeline Tables
-- Sprint 2: model versioning + per-fixture model runs + ALL pick candidates
-- (incl. rejected reasons). Voor reproduceerbare picks + signal lift analysis.
-- Naast bestaande tabellen, geen breaking changes.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── MODEL VERSIONS ──────────────────────────────────────────────────────────
-- Eén row per code-release (APP_VERSION). Sport/market-segmentatie via JSON
-- in metrics zodat we pas later per-markt models hoeven splitsen.
create table if not exists public.model_versions (
  id                     bigint generated always as identity primary key,
  name                   text not null,
  sport                  text not null default 'multi',  -- 'multi' tot per-markt models bestaan
  market_type            text not null default 'multi',
  version_tag            text not null,                  -- bv 'v9.7.0'
  feature_set_version    text not null,                  -- bv 'v9.6.0'
  training_window_start  date,
  training_window_end    date,
  metrics                jsonb not null default '{}',
  status                 text not null default 'active', -- active, deprecated, experimental
  created_at             timestamptz not null default now()
);

create unique index if not exists model_versions_unique_idx
  on public.model_versions(sport, market_type, version_tag);

-- ── MODEL RUNS ──────────────────────────────────────────────────────────────
-- Eén row per (fixture, market_type) per scan-moment. Bevat baseline (markt
-- consensus), model_delta (onze aanpassingen) en final_prob (model output).
-- Hierdoor kunnen we later per signal de incremental lift berekenen.
create table if not exists public.model_runs (
  id                bigint generated always as identity primary key,
  fixture_id        bigint not null references public.fixtures(id) on delete cascade,
  captured_at       timestamptz not null default now(),
  model_version_id  bigint not null references public.model_versions(id),
  market_type       text not null,
  line              numeric(8,2),
  baseline_prob     jsonb not null,    -- market consensus prob {"home":0.51,...}
  model_delta       jsonb not null default '{}', -- onze adjustments per outcome
  final_prob        jsonb not null,    -- definitieve model kans
  calibration       jsonb not null default '{}', -- toegepaste calibratie multipliers
  debug             jsonb not null default '{}'  -- extra context (signals, lambda's)
);

create index if not exists model_runs_fixture_time_idx on public.model_runs(fixture_id, captured_at desc);
create index if not exists model_runs_version_idx on public.model_runs(model_version_id, captured_at desc);
create index if not exists model_runs_market_idx on public.model_runs(market_type, captured_at desc);

-- ── PICK CANDIDATES ─────────────────────────────────────────────────────────
-- Append-only log van ELKE potentiële pick. passed_filters=true betekent dat
-- de pick door alle gates ging en getoond wordt aan de user. false betekent
-- gefilterd op edge/sanity/bookie etc, met rejected_reason text.
create table if not exists public.pick_candidates (
  id                  bigint generated always as identity primary key,
  model_run_id        bigint not null references public.model_runs(id) on delete cascade,
  fixture_id          bigint not null references public.fixtures(id) on delete cascade,
  selection_key       text not null,
  bookmaker           text not null,
  bookmaker_odds      numeric(10,4) not null,
  fair_prob           numeric(10,6) not null,
  edge_pct            numeric(10,4) not null,
  kelly_fraction      numeric(10,6),
  stake_units         numeric(10,3),
  expected_value_eur  numeric(10,2),
  passed_filters      boolean not null default false,
  rejected_reason     text,
  signals             jsonb not null default '[]',
  created_at          timestamptz not null default now()
);

create index if not exists pick_candidates_fixture_idx on public.pick_candidates(fixture_id, created_at desc);
create index if not exists pick_candidates_passed_idx on public.pick_candidates(passed_filters, created_at desc);
create index if not exists pick_candidates_model_run_idx on public.pick_candidates(model_run_id);
create index if not exists pick_candidates_bookie_idx on public.pick_candidates(bookmaker, passed_filters, created_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
--   select count(*) from public.model_versions;   -- 0 (vult bij eerste boot na v9.7.0)
--   select count(*) from public.model_runs;       -- 0 (vult bij eerste scan)
--   select count(*) from public.pick_candidates;  -- 0
