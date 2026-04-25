-- v12.2.27 (canonical-monitor wire-up): probability_source onderdeel van unique key.
-- Voorheen: unique index op (signal_name, sport, market_type, window_key) → kon
-- maar één row per bucket bestaan, ongeacht source. Nu we canonical (pick_ep)
-- naast ep_proxy willen schrijven per bucket, moet de source onderdeel zijn van
-- de unique key zodat upsert beide rijen naast elkaar accepteert.

drop index if exists public.signal_calibration_unique_idx;

create unique index if not exists signal_calibration_unique_idx
  on public.signal_calibration(
    signal_name,
    coalesce(sport, ''),
    coalesce(market_type, ''),
    window_key,
    probability_source
  );

comment on index public.signal_calibration_unique_idx is
  'v12.2.27: source toegevoegd aan unique key zodat pick_ep (canonical) en ep_proxy naast elkaar bestaan per (signal, sport, market, window).';
