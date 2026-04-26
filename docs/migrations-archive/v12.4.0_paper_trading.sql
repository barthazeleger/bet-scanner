-- ═══════════════════════════════════════════════════════════════════════════════
-- EdgePickr v12.4.0 — Paper-trading shadow + market-scan telemetry
-- Operator-doctrine: signal-promotion extended naar markt-types. Shadow-rows
-- meten elke kandidaat-markt × sport totdat CLV+Brier-bewijs auto-promote
-- rechtvaardigt. Geen DROP/TRUNCATE/DELETE — additive only.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── pick_candidates: shadow + settlement velden ─────────────────────────────
-- shadow=true       → kandidaat passeerde model+sanity-gates maar niet top5
-- final_top5=true   → wél in finalPicks (live operator-zichtbaar)
-- markt_label       → raw p.label string voor resolveBetOutcome (settlement)
-- closing_*/clv_pct → settlement-sweep vult na fixture-finish via fetchSnapshotClosing
-- result/settled_at → W/L/P na resolveBetOutcome
-- market_type/line/sport → denormalisatie t.b.v. funnel-queries (10× sneller dan join)
alter table public.pick_candidates
  add column if not exists shadow         boolean not null default false,
  add column if not exists final_top5     boolean not null default false,
  add column if not exists market_type    text,
  add column if not exists line           numeric(8,2),
  add column if not exists markt_label    text,
  add column if not exists kickoff_ms     bigint,
  add column if not exists closing_odds   numeric(10,4),
  add column if not exists closing_bookie text,
  add column if not exists closing_source text,
  add column if not exists clv_pct        numeric(10,4),
  add column if not exists result         text,
  add column if not exists settled_at     timestamptz,
  add column if not exists sport          text;

-- Sweep filtert op kickoff_ms < now() AND result IS NULL → partial index nodig
create index if not exists pick_candidates_unsettled_idx
  on public.pick_candidates(kickoff_ms)
  where result is null;

-- Funnel-queries (per sport × markt × dag) één-table-hit
create index if not exists pick_candidates_market_idx
  on public.pick_candidates(sport, market_type, created_at desc);

-- Shadow vs live splitsing voor analyse
create index if not exists pick_candidates_shadow_idx
  on public.pick_candidates(shadow, final_top5, created_at desc);

-- ── market_scan_telemetry ───────────────────────────────────────────────────
-- Per scan × sport × markt-type één row met funnel-counters. Operator ziet
-- in scan-log één regel; persistente tabel is voor cross-scan trend-analyse
-- (welke markten worden zwaar gefilterd vs welke produceren consistent picks).
create table if not exists public.market_scan_telemetry (
  id                bigint generated always as identity primary key,
  scan_id           text not null,
  scan_anchor_ms    bigint not null,
  sport             text not null,
  market_type       text not null,
  generated         integer not null default 0,
  sanity_passed     integer not null default 0,
  divergence_passed integer not null default 0,
  exec_gate_passed  integer not null default 0,
  top5_count        integer not null default 0,
  created_at        timestamptz not null default now()
);

create index if not exists market_scan_telemetry_scan_idx
  on public.market_scan_telemetry(scan_anchor_ms desc, sport, market_type);

create index if not exists market_scan_telemetry_market_idx
  on public.market_scan_telemetry(market_type, sport, created_at desc);

-- ── RLS defense-in-depth (parallel aan v10.10.22) ───────────────────────────
alter table public.market_scan_telemetry enable row level security;

do $$ begin
  create policy "srv_market_scan_telemetry"
    on public.market_scan_telemetry for all to service_role
    using (true) with check (true);
exception when duplicate_object then null; end $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICATION
-- ═══════════════════════════════════════════════════════════════════════════════
--   select column_name from information_schema.columns
--    where table_schema='public' and table_name='pick_candidates' and column_name in
--    ('shadow','final_top5','market_type','markt_label','clv_pct','result');  -- 6 rows
--   select count(*) from public.market_scan_telemetry;  -- 0 (vult bij eerste scan)
