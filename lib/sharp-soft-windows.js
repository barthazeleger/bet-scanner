'use strict';

const { findExecutionEdge } = require('./sharp-soft-asymmetry');

/**
 * v12.2.17 (R4 wiring): aggregeer odds_snapshots in sharp-vs-soft execution
 * windows. Pure helper — geen Supabase calls. Consumer (admin route) levert
 * snapshots aan; deze functie groepeert, devigt, en returnt windows met
 * meetbare gap.
 *
 * Doctrine: sharp = Pinnacle/Betfair (canonieke truth, lage marge).
 *           soft  = Bet365/Unibet (execution, soms achterloop).
 * Window = significant verschil tussen sharp fair_prob en soft fair_prob op
 * dezelfde uitkomst → execution edge bestaat (jij krijgt soft prijs maar
 * sharp denkt het waarschijnlijker).
 *
 * @param {object} args
 *   - snapshots: rows uit odds_snapshots {fixture_id, captured_at, bookmaker, market_type, selection_key, line, odds}
 *   - fixtures:  Map<id, {start_time, home_team_name, away_team_name}>
 *   - sharpSet:  Set<string> (lowercase bookmaker names)
 *   - softSet:   Set<string> (lowercase bookmaker names; preferred bookies)
 *   - threshold: number (pp; gap onder threshold wordt geskipt)
 * @returns {Array<{fixtureId, fixtureName, kickoffIso, marketType, line, outcome, softOdd, sharpOdd, softFair, sharpFair, gapPp, edgeDirection}>}
 */
function summarizeSharpSoftWindows({ snapshots, fixtures, sharpSet, softSet, threshold = 0.02, includeMirror = false }) {
  if (!Array.isArray(snapshots) || !snapshots.length) return [];
  const sharp = sharpSet instanceof Set ? sharpSet : new Set();
  const soft = softSet instanceof Set ? softSet : new Set();
  const fxMap = fixtures instanceof Map ? fixtures : new Map();

  const groupKey = r => `${r.fixture_id}|${r.market_type}|${r.line == null ? '' : r.line}`;
  const grouped = new Map();
  for (const r of snapshots) {
    if (!r || !Number.isFinite(Number(r.odds)) || Number(r.odds) <= 1) continue;
    const k = groupKey(r);
    let g = grouped.get(k);
    if (!g) { g = []; grouped.set(k, g); }
    g.push(r);
  }

  const out = [];
  for (const [, rows] of grouped) {
    const latest = new Map();
    for (const r of rows) {
      const bookieLower = String(r.bookmaker || '').toLowerCase();
      const sel = r.selection_key;
      const innerKey = `${bookieLower}|${sel}`;
      const prev = latest.get(innerKey);
      const ts = Date.parse(r.captured_at) || 0;
      if (!prev || ts > prev._ts) latest.set(innerKey, { ...r, _ts: ts, _bookieLower: bookieLower });
    }

    const selections = new Set();
    const sharpBest = new Map();
    const softBest = new Map();
    for (const [, r] of latest) {
      selections.add(r.selection_key);
      const isSharp = [...sharp].some(s => r._bookieLower.includes(s));
      const isSoft = [...soft].some(s => r._bookieLower.includes(s));
      const odd = Number(r.odds);
      if (isSharp) {
        const cur = sharpBest.get(r.selection_key);
        if (!cur || odd > cur.odd) sharpBest.set(r.selection_key, { odd, bookie: r.bookmaker });
      }
      if (isSoft) {
        const cur = softBest.get(r.selection_key);
        if (!cur || odd > cur.odd) softBest.set(r.selection_key, { odd, bookie: r.bookmaker });
      }
    }

    const selArr = [...selections];
    if (selArr.length < 2) continue;
    if (selArr.some(s => !sharpBest.has(s) || !softBest.has(s))) continue;

    const softOdds = selArr.map(s => softBest.get(s).odd);
    const sharpOdds = selArr.map(s => sharpBest.get(s).odd);
    const edges = findExecutionEdge({ softOdds, sharpOdds, threshold });
    if (!edges.length) continue;

    const sample = rows[0];
    const fx = fxMap.get(sample.fixture_id) || {};
    const fxName = fx.home_team_name && fx.away_team_name
      ? `${fx.home_team_name} vs ${fx.away_team_name}`
      : `fixture ${sample.fixture_id}`;
    for (const e of edges) {
      // v12.2.18: 2-way devig is symmetrisch — een soft_undervalues op de
      // ene kant impliceert automatisch sharp_undervalues op de andere. De
      // sharp_undervalues regel is een spiegel van de soft_undervalues kant
      // en heeft geen actie-waarde voor de operator (we pakken execution-
      // edge bij soft, niet anti-edge bij sharp). Default: alleen soft kant.
      if (!includeMirror && e.edgeDirection !== 'soft_undervalues') continue;
      const sel = selArr[e.outcomeIndex];
      out.push({
        fixtureId: sample.fixture_id,
        fixtureName: fxName,
        kickoffIso: fx.start_time || null,
        marketType: sample.market_type,
        line: sample.line == null ? null : Number(sample.line),
        outcome: sel,
        softOdd: softBest.get(sel).odd,
        softBookie: softBest.get(sel).bookie,
        sharpOdd: sharpBest.get(sel).odd,
        sharpBookie: sharpBest.get(sel).bookie,
        softFair: e.softFair,
        sharpFair: e.sharpFair,
        gapPp: e.gapPp,
        edgeDirection: e.edgeDirection,
      });
    }
  }

  out.sort((a, b) => Math.abs(b.gapPp) - Math.abs(a.gapPp));
  return out;
}

module.exports = { summarizeSharpSoftWindows };
