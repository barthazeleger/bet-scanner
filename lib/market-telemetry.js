'use strict';

/**
 * EdgePickr v12.4.0 — Per-scan markt-mix telemetrie.
 *
 * In-memory funnel-counter per (sport × markt-type). Caller bumpt op elk
 * gate-stadium (generated → sanity_pass → divergence_pass → exec_gate_pass →
 * top5). `formatLine()` produceert één leesbare scan-log regel; `persist()`
 * doet één bulk-insert in market_scan_telemetry.
 *
 * Ontwerp-keuze: pure factory, geen module-state. Eén instance per (scan,
 * sport) zodat we tegelijk over multiple sporten in flight kunnen zijn zonder
 * cross-bestuiving.
 */

function createScanTelemetry({ sport, scanAnchorMs, scanId } = {}) {
  if (!sport) throw new Error('createScanTelemetry: sport required');
  const anchorMs = Number.isFinite(scanAnchorMs) ? scanAnchorMs : Date.now();
  const id = scanId || `${sport}_${anchorMs}`;
  // counters[marketType] = { generated, sanity_passed, divergence_passed,
  //                           exec_gate_passed, top5_count }
  const counters = Object.create(null);

  const slot = (mt) => {
    if (!mt) return null;
    const k = String(mt);
    if (!counters[k]) {
      counters[k] = {
        generated: 0,
        sanity_passed: 0,
        divergence_passed: 0,
        exec_gate_passed: 0,
        top5_count: 0,
      };
    }
    return counters[k];
  };

  const bumpGenerated      = (mt) => { const s = slot(mt); if (s) s.generated++; };
  const bumpSanityPass     = (mt) => { const s = slot(mt); if (s) s.sanity_passed++; };
  const bumpDivergencePass = (mt) => { const s = slot(mt); if (s) s.divergence_passed++; };
  const bumpExecGatePass   = (mt) => { const s = slot(mt); if (s) s.exec_gate_passed++; };
  const bumpTop5           = (mt) => { const s = slot(mt); if (s) s.top5_count++; };

  /**
   * Merge per-markt counters van scan-gate stats.byMarket. `gated` is hoeveel
   * keer applyExecutionGate gedraaid heeft (= door playability heen + niet skip).
   * `skipped` is execution_gate_skip; trekken we af om netto exec-gate-pass te
   * krijgen.
   */
  const mergeFromGateStats = (byMarket) => {
    if (!byMarket || typeof byMarket !== 'object') return;
    for (const [mt, st] of Object.entries(byMarket)) {
      const s = slot(mt);
      if (!s) continue;
      const gated = Number(st?.gated) || 0;
      const skipped = Number(st?.skipped) || 0;
      const playabilityDropped = Number(st?.playabilityDropped) || 0;
      // Netto: pick passed playability + execution gate. Dampened picks
      // tellen ook als pass (kelly is gedempt maar pick blijft).
      const passed = Math.max(0, gated - skipped - playabilityDropped);
      s.exec_gate_passed += passed;
    }
  };

  const formatLine = () => {
    const entries = Object.entries(counters)
      .filter(([, c]) => c.generated > 0 || c.top5_count > 0)
      .sort((a, b) => b[1].generated - a[1].generated);
    if (!entries.length) return `📊 Markt-mix ${sport}: (geen kandidaten)`;
    const parts = entries.map(([mt, c]) => {
      const segs = [`gen=${c.generated}`];
      if (c.sanity_passed)     segs.push(`san=${c.sanity_passed}`);
      if (c.divergence_passed) segs.push(`div=${c.divergence_passed}`);
      if (c.exec_gate_passed)  segs.push(`gate=${c.exec_gate_passed}`);
      if (c.top5_count)        segs.push(`top5=${c.top5_count}`);
      return `${mt}[${segs.join(' ')}]`;
    });
    return `📊 Markt-mix ${sport}: ${parts.join(' · ')}`;
  };

  /**
   * One bulk-insert in market_scan_telemetry. Geen-op bij geen rows of geen
   * supabase-client. Errors worden gevangen — telemetry mag scan nooit breken.
   */
  const persist = async (supabase) => {
    if (!supabase || typeof supabase.from !== 'function') return;
    const rows = Object.entries(counters)
      .filter(([, c]) => c.generated > 0 || c.top5_count > 0)
      .map(([mt, c]) => ({
        scan_id: id,
        scan_anchor_ms: anchorMs,
        sport,
        market_type: mt,
        generated: c.generated,
        sanity_passed: c.sanity_passed,
        divergence_passed: c.divergence_passed,
        exec_gate_passed: c.exec_gate_passed,
        top5_count: c.top5_count,
      }));
    if (!rows.length) return;
    try {
      await supabase.from('market_scan_telemetry').insert(rows);
    } catch (e) {
      if (process.env.SNAPSHOT_DEBUG) console.warn('[market-telemetry] persist failed:', e?.message || e);
    }
  };

  const snapshot = () => JSON.parse(JSON.stringify(counters));

  return {
    sport,
    scanAnchorMs: anchorMs,
    scanId: id,
    bumpGenerated,
    bumpSanityPass,
    bumpDivergencePass,
    bumpExecGatePass,
    bumpTop5,
    mergeFromGateStats,
    formatLine,
    persist,
    snapshot,
  };
}

module.exports = { createScanTelemetry };
