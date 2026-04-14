-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v9.6.0 — v2 Foundation Tables
-- Sprint 1: snapshot infrastructure voor point-in-time learning.
-- Naast bestaande bets/users tabellen, geen breaking changes.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── FIXTURES ─────────────────────────────────────────────────────────────────
-- Eén row per (api-sports fixture id). Sport, league, teams, kickoff, status.
create table if not exists public.fixtures (
  id            bigint primary key,
  sport         text not null,
  league_id     bigint,
  league_name   text,
  season        text,
  home_team_id  bigint,
  home_team_name text not null,
  away_team_id  bigint,
  away_team_name text not null,
  start_time    timestamptz not null,
  status        text not null default 'scheduled',
  result_json   jsonb,
  source        text not null default 'api-sports',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists fixtures_sport_start_idx on public.fixtures(sport, start_time);
create index if not exists fixtures_league_start_idx on public.fixtures(league_id, start_time);
create index if not exists fixtures_status_idx on public.fixtures(status);

-- ── ODDS SNAPSHOTS ───────────────────────────────────────────────────────────
-- Time-series van bookmaker-odds per fixture/markt/selectie. Append-only.
-- Voor latere line-movement, multi-snapshot CLV, walk-forward backtests.
create table if not exists public.odds_snapshots (
  id            bigint generated always as identity primary key,
  fixture_id    bigint not null references public.fixtures(id) on delete cascade,
  captured_at   timestamptz not null default now(),
  bookmaker     text not null,
  market_type   text not null,   -- moneyline, 1x2, total, spread, btts, team_total, threeway, dnb, double_chance, f5_ml, f5_total
  selection_key text not null,   -- home, away, draw, over, under, yes, no, hx, x2, 12
  line          numeric(8,2),    -- 2.5, -1.5, etc; null voor markten zonder lijn
  odds          numeric(10,4) not null,
  source        text not null default 'api-sports'
);

create index if not exists odds_snapshots_fixture_time_idx on public.odds_snapshots(fixture_id, captured_at desc);
create index if not exists odds_snapshots_market_idx on public.odds_snapshots(fixture_id, market_type, line, captured_at desc);
create index if not exists odds_snapshots_bookie_idx on public.odds_snapshots(bookmaker, captured_at desc);

-- ── FEATURE SNAPSHOTS ────────────────────────────────────────────────────────
-- Point-in-time feature vector per fixture. JSONB voor snelle iteratie.
-- Quality scores per signal (lineup_confidence, injury_freshness, etc).
create table if not exists public.feature_snapshots (
  id                  bigint generated always as identity primary key,
  fixture_id          bigint not null references public.fixtures(id) on delete cascade,
  captured_at         timestamptz not null default now(),
  feature_set_version text not null,
  features            jsonb not null,
  quality             jsonb not null default '{}'
);

create index if not exists feature_snapshots_fixture_time_idx on public.feature_snapshots(fixture_id, captured_at desc);
create index if not exists feature_snapshots_version_idx on public.feature_snapshots(feature_set_version, captured_at desc);

-- ── MARKET CONSENSUS ─────────────────────────────────────────────────────────
-- Devigged baseline probability per fixture/markt op moment van scan.
-- Inclusief overround + quality score (bookmaker_count, spread).
create table if not exists public.market_consensus (
  id              bigint generated always as identity primary key,
  fixture_id      bigint not null references public.fixtures(id) on delete cascade,
  captured_at     timestamptz not null default now(),
  market_type     text not null,
  line            numeric(8,2),
  consensus_prob  jsonb not null,   -- {"home":0.51,"draw":0.24,"away":0.25}
  consensus_odds  jsonb,            -- inverse fair odds, {"home":1.96, ...}
  bookmaker_count int not null default 0,
  overround       numeric(8,5),     -- sum(1/odds) - 1, lager = scherper boek
  quality_score   numeric(6,4)      -- 0-1: hoe betrouwbaar deze consensus
);

create index if not exists market_consensus_fixture_time_idx on public.market_consensus(fixture_id, captured_at desc);
create index if not exists market_consensus_market_idx on public.market_consensus(fixture_id, market_type, line, captured_at desc);
create index if not exists market_consensus_quality_idx on public.market_consensus(market_type, quality_score desc, captured_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
-- Na uitvoering, controleer:
--   select count(*) from public.fixtures;            -- 0 (leeg, vult bij eerstvolgende scan)
--   select count(*) from public.odds_snapshots;      -- 0
--   select count(*) from public.feature_snapshots;   -- 0
--   select count(*) from public.market_consensus;    -- 0
