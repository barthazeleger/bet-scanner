-- EdgePickr v12.2.8 — was_preferred_at_log_time per bet
-- F5 fix: voorkomt dat learning-loop historische bets uitsluit als operator
-- preferredBookies wijzigt. Per bet wordt op moment van loggen vastgelegd of
-- de tip-bookie tóen preferred was. Filter in updateCalibration gebruikt nu
-- die point-in-time kolom ipv runtime isPreferredBookie(bet.tip) check.
--
-- Default true voor bestaande bets: aanname is dat ze gelogd zijn met
-- bookies die destijds preferred waren (anders zou de scan ze niet hebben
-- voorgesteld). Dat houdt huidige calibration data intact.

alter table public.bets
  add column if not exists was_preferred_at_log_time boolean default true;

create index if not exists bets_was_preferred_idx
  on public.bets(was_preferred_at_log_time)
  where uitkomst in ('W', 'L');
