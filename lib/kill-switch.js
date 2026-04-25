'use strict';

/**
 * v12.2.48 (R8 step 1): kill-switch state + refresh-logica geëxtraheerd
 * uit server.js. Factory pattern — server.js mount één instance en geeft
 * die door als dep aan consumers (picks-pipeline, scan-orchestrator).
 *
 * Doctrine: kill-switch blokkeert markten met avg CLV onder threshold over
 * voldoende settled bets. Auto-disable bij gemiddelde CLV < -5% over ≥30
 * settled. Per markt-key (sport_market). Operator kan via admin endpoint
 * markt-key handmatig override.
 *
 * Returns object met:
 *   - set: Set<string>           — actieve geblokkeerde markt-keys
 *   - thresholds: object         — kill_min_n, watchlist_clv, auto_disable_clv
 *   - lastRefreshed: number      — ms timestamp
 *   - enabled: boolean           — master flag (operator-toggleable)
 *   - refresh(): Promise<void>   — herbouwt de set vanaf live bets
 *   - isMarketKilled(sport, marktLabel): boolean
 *   - setEnabled(enabled): void
 *
 * @param {object} deps
 *   - supabase                  — Supabase client
 *   - loadSettledBets           — async () → bets[] (cached source)
 *   - normalizeSport            — fn (sportKey) → canonical sport
 *   - detectMarket              — fn (markt) → bucket
 *   - supportsClvForBetMarkt    — fn (markt) → boolean (sniff out non-CLV markets)
 */
function createKillSwitch(deps) {
  const { supabase, loadSettledBets, normalizeSport, detectMarket, supportsClvForBetMarkt } = deps;
  const required = { supabase, loadSettledBets, normalizeSport, detectMarket, supportsClvForBetMarkt };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createKillSwitch: missing required dep '${key}'`);
    }
  }

  const state = {
    set: new Set(),
    thresholds: { kill_min_n: 30, watchlist_clv: -2.0, auto_disable_clv: -5.0 },
    lastRefreshed: 0,
    enabled: true,
  };

  async function refresh() {
    if (!state.enabled) { state.set.clear(); return; }
    try {
      const bets = await loadSettledBets();
      const all = (bets || []).filter(b =>
        typeof b.clv_pct === 'number' &&
        !isNaN(b.clv_pct) &&
        supportsClvForBetMarkt(b.markt)
      );
      const byMarket = {};
      for (const b of all) {
        const s = normalizeSport(b.sport || 'football');
        const mk = detectMarket(b.markt || 'other');
        const key = `${s}_${mk}`;
        if (!byMarket[key]) byMarket[key] = { n: 0, sumClv: 0 };
        byMarket[key].n++;
        byMarket[key].sumClv += b.clv_pct;
      }
      const newSet = new Set();
      const newKills = [];
      for (const [k, d] of Object.entries(byMarket)) {
        const avgClv = d.sumClv / d.n;
        if (d.n >= state.thresholds.kill_min_n && avgClv < state.thresholds.auto_disable_clv) {
          newSet.add(k);
          if (!state.set.has(k)) newKills.push({ key: k, avgClv: avgClv.toFixed(2), n: d.n });
        }
      }
      const previousSet = state.set;
      state.set = newSet;
      state.lastRefreshed = Date.now();
      if (newSet.size) console.log(`🛑 Kill-switch: ${newSet.size} markten geblokkeerd: ${[...newSet].join(', ')}`);
      // Inbox-notifications voor nieuwe kills + restored markets.
      for (const k of newKills) {
        try {
          await supabase.from('notifications').insert({
            type: 'kill_switch',
            title: `🛑 Markt geblokkeerd: ${k.key}`,
            body: `Auto-disable: gemiddelde CLV ${k.avgClv}% over ${k.n} settled bets is onder threshold (${state.thresholds.auto_disable_clv}%). Picks uit deze markt worden niet meer getoond. Override via admin endpoint.`,
            read: false, user_id: null,
          });
        } catch { /* swallow */ }
      }
      for (const k of previousSet) {
        if (!newSet.has(k)) {
          try {
            await supabase.from('notifications').insert({
              type: 'kill_switch',
              title: `✅ Markt heropend: ${k}`,
              body: `Auto-restored: gemiddelde CLV is hersteld boven threshold. Picks uit deze markt zijn weer toegestaan.`,
              read: false, user_id: null,
            });
          } catch { /* swallow */ }
        }
      }
    } catch (e) { /* swallow */ }
  }

  function isMarketKilled(sport, marktLabel) {
    if (!state.enabled || !state.set.size) return false;
    const key = `${normalizeSport(sport)}_${detectMarket(marktLabel || 'other')}`;
    return state.set.has(key);
  }

  function setEnabled(v) {
    state.enabled = !!v;
    if (!state.enabled) state.set.clear();
  }

  return {
    state,
    get set() { return state.set; },
    get thresholds() { return state.thresholds; },
    get lastRefreshed() { return state.lastRefreshed; },
    get enabled() { return state.enabled; },
    set enabled(v) { setEnabled(v); },
    refresh,
    isMarketKilled,
    setEnabled,
  };
}

module.exports = { createKillSwitch };
