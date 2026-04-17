'use strict';

/**
 * EdgePickr · Post-scan execution-gate pass (Phase A.1b · doctrine §6/§10.A).
 *
 * Na een sport-scan komen picks terug met optional `_fixtureMeta`
 * ({fixtureId, marketType, selectionKey, line}). Deze helper doet één
 * bulk-query naar odds_snapshots, bouwt timelines, past `applyExecutionGate`
 * opnieuw toe, en muteert picks in-place:
 *   - kelly / units / expectedEur worden bijgewerkt
 *   - executionAudit wordt gevuld met {combined_multiplier, multipliers, reasons, skipped}
 *   - picks met gate.skip=true worden uit de returned-array gefilterd
 *
 * Geen side effects buiten picks-array mutatie + bulk-query.
 * Backwards-compat: picks zonder `_fixtureMeta` blijven ongewijzigd (gate is
 * no-op). Empty timelineMap → zelfde: gate is no-op, alle picks komen door.
 *
 * @param {Array} picks         - output van een sport-scan
 * @param {object} supabase     - supabase client (voor bulk-query)
 * @param {object} opts
 *   - preferredBookies:  string[]
 *   - kickoffByFixtureId: Map<number, ms>  (voor pre-kickoff windows)
 *   - scanAnchorMs:      number
 *   - activeUnitEur:     number            (voor expectedEur recalc, default 25)
 *   - marketTypes:       string[]          (filter op odds_snapshots query)
 *   - kellyToUnits:      function          (om kelly → units string te formatten)
 * @returns {Promise<{picks: Array, stats: {total, gated, skipped, dampened}}>}
 */
async function applyPostScanGate(picks, supabase, opts = {}) {
  const stats = { total: (picks || []).length, gated: 0, skipped: 0, dampened: 0 };
  if (!Array.isArray(picks) || picks.length === 0) return { picks: [], stats };

  const withMeta = picks.filter(p => p && p._fixtureMeta && Number.isFinite(p._fixtureMeta.fixtureId));
  if (withMeta.length === 0) return { picks, stats };

  const lineTimeline = require('../line-timeline');
  const { applyExecutionGate } = require('../execution-gate');
  const { kellyToUnits } = opts.kellyToUnits ? { kellyToUnits: opts.kellyToUnits } : require('../model-math');

  const fixtureIds = [...new Set(withMeta.map(p => p._fixtureMeta.fixtureId))];
  const marketTypes = Array.isArray(opts.marketTypes) && opts.marketTypes.length
    ? opts.marketTypes
    : [...new Set(withMeta.map(p => p._fixtureMeta.marketType).filter(Boolean))];

  let timelineMap;
  try {
    timelineMap = await lineTimeline.buildScanTimelineMap(supabase, {
      fixtureIds,
      marketTypes,
      preferredBookies: opts.preferredBookies || [],
      kickoffByFixtureId: opts.kickoffByFixtureId,
      scanAnchorMs: opts.scanAnchorMs,
    });
  } catch (_) {
    return { picks, stats };
  }
  if (!(timelineMap instanceof Map) || timelineMap.size === 0) return { picks, stats };

  const activeUnitEur = Number.isFinite(opts.activeUnitEur) && opts.activeUnitEur > 0 ? opts.activeUnitEur : 25;

  const survivors = [];
  for (const p of picks) {
    if (!p._fixtureMeta) { survivors.push(p); continue; }
    const entry = lineTimeline.lookupTimeline(timelineMap, p._fixtureMeta);
    if (!entry || !entry.timeline) { survivors.push(p); continue; }
    // twoWayMarket inference uit label
    const lbl = (p.label || '').toLowerCase();
    const twoWayMarket = /over\s|under\s|btts|dnb|team\s+total|ml|moneyline|puck\s*line|run\s*line|^🏠|^✈️/.test(lbl);
    const metrics = lineTimeline.deriveExecutionMetrics(entry.timeline, { twoWayMarket });
    if (!metrics) { survivors.push(p); continue; }

    const gated = applyExecutionGate(p.kelly, metrics);
    stats.gated++;
    if (gated.skip === true) {
      stats.skipped++;
      // Pick gefilterd — geen push naar survivors
      continue;
    }
    // Update pick in-place als de gate gedempt heeft
    if (Number.isFinite(gated.hk) && gated.hk !== p.kelly) {
      p.kelly = gated.hk;
      p.units = kellyToUnits(gated.hk);
      const uNum = parseFloat(p.units);
      const edgePct = p.edge / 100;
      p.expectedEur = +(uNum * activeUnitEur * edgePct * (p.dataConfidence || 1)).toFixed(2);
      stats.dampened++;
    }
    p.executionAudit = {
      combined_multiplier: gated.combinedMultiplier,
      multipliers: gated.multipliers,
      reasons: gated.reasons,
      skipped: false,
    };
    survivors.push(p);
  }
  return { picks: survivors, stats };
}

module.exports = { applyPostScanGate };
