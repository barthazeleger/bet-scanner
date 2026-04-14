-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v10.0.0 — v2 Completion Tables
-- Sluit de reviewer's volledige tabelset af. Naast bestaande tabellen.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── SIGNAL STATS (historische tracking van signal performance) ──────────────
-- Per (model_version, signal_name) één row die periodiek wordt bijgewerkt.
-- avg_clv toont CLV-bijdrage; lift_vs_market = winrate beter dan implied prob.
create table if not exists public.signal_stats (
  id                bigint generated always as identity primary key,
  model_version_id  bigint references public.model_versions(id) on delete cascade,
  sport             text,
  market_type       text,
  signal_name       text not null,
  sample_size       int not null default 0,
  avg_clv           numeric(10,4),     -- gemiddelde CLV% over alle bets met dit signal
  avg_pnl           numeric(10,4),     -- gemiddelde €PnL per bet
  lift_vs_market    numeric(10,4),     -- (winrate - implied_prob) gemiddeld
  weight            numeric(10,4),     -- huidige effective weight (uit signal_weights)
  updated_at        timestamptz not null default now()
);

create unique index if not exists signal_stats_unique_idx
  on public.signal_stats(model_version_id, signal_name);
create index if not exists signal_stats_clv_idx on public.signal_stats(avg_clv desc);

-- ── EXECUTION LOGS (slippage tracking voor toekomstige bookie API integratie) ─
-- Voor nu manueel ingevuld bij bet-place. Toekomst: auto bij bookie API call.
create table if not exists public.execution_logs (
  id              bigint generated always as identity primary key,
  bet_id          bigint references public.bets(id) on delete set null,
  bet_uuid        text,                  -- alias voor cross-reference als bet ints renumberen
  requested_odds  numeric(10,4),         -- wat we wilden nemen
  accepted_odds   numeric(10,4) not null, -- wat we feitelijk kregen
  delay_ms        int,                   -- tijd tussen request en accept
  slippage_pct    numeric(10,4),         -- (accepted - requested) / requested * 100
  bookmaker       text not null,
  notes           jsonb not null default '{}',
  created_at      timestamptz not null default now()
);

create index if not exists execution_logs_bet_idx on public.execution_logs(bet_id);
create index if not exists execution_logs_bookie_idx on public.execution_logs(bookmaker, created_at desc);

-- ── TRAINING EXAMPLES (point-in-time labeled data voor residual model) ──────
-- Eén row per (fixture, market_type) zodra een outcome bekend is.
-- Koppelt feature_snapshot + market_consensus aan finale uitkomst.
create table if not exists public.training_examples (
  id                  bigint generated always as identity primary key,
  fixture_id          bigint not null references public.fixtures(id) on delete cascade,
  market_type         text not null,
  line                numeric(8,2),
  snapshot_time       timestamptz not null,
  feature_snapshot_id bigint references public.feature_snapshots(id) on delete set null,
  market_consensus_id bigint references public.market_consensus(id) on delete set null,
  label               jsonb,            -- {"home":1,"draw":0,"away":0} of {"over":1,"under":0}
  close_label         jsonb,            -- (optional) labels o.b.v. closing line
  created_at          timestamptz not null default now()
);

create index if not exists training_examples_market_idx on public.training_examples(market_type, snapshot_time desc);
create index if not exists training_examples_fixture_idx on public.training_examples(fixture_id);

-- ── RAW API EVENTS (debug + replay) ─────────────────────────────────────────
-- Optioneel: bewaar volledige API-payloads voor reproductie tijdens debugging.
-- Niet alle calls schrijven hierheen (te volumineus); alleen failure-debugging
-- en specifieke endpoints. Houd retention beperkt met TTL-cleanup.
create table if not exists public.raw_api_events (
  id            bigint generated always as identity primary key,
  source        text not null,         -- api-sports, statsapi.mlb.com, api-web.nhle.com
  entity_type   text not null,         -- fixtures, odds, injuries, lineup, weather
  entity_id     text,                  -- fixture_id of team_abbrev als string
  fetched_at    timestamptz not null default now(),
  payload       jsonb not null
);

create index if not exists raw_api_events_source_type_idx on public.raw_api_events(source, entity_type, fetched_at desc);
create index if not exists raw_api_events_entity_idx on public.raw_api_events(entity_id, fetched_at desc);

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
--   select count(*) from public.signal_stats;       -- 0
--   select count(*) from public.execution_logs;     -- 0
--   select count(*) from public.training_examples;  -- 0
--   select count(*) from public.raw_api_events;     -- 0
