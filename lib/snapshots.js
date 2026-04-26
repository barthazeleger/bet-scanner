'use strict';

/**
 * EdgePickr Snapshot Layer (v2 foundation).
 * Schrijft point-in-time data naar Supabase tijdens scans:
 *  - fixtures: één row per (sport, fixture_id), upsert.
 *  - odds_snapshots: append-only, één row per (fixture, bookie, markt, selectie, line).
 *  - feature_snapshots: append-only, één row per (fixture, captured_at).
 *  - market_consensus: append-only, één row per (fixture, market_type, line, captured_at).
 *
 * Volledig fail-safe: bij Supabase-fout wordt geen exception gegooid, scan gaat door.
 * Geen impact op pick-flow als snapshots niet werken.
 */

const FEATURE_SET_VERSION = 'v9.6.0';

/**
 * Upsert fixture metadata. Idempotent.
 * @param {object} supabase - Supabase client
 * @param {object} fix - { id, sport, leagueId, leagueName, season, homeTeamId, homeTeamName, awayTeamId, awayTeamName, startTime, status }
 */
async function upsertFixture(supabase, fix) {
  if (!fix?.id || !fix?.sport || !fix?.homeTeamName || !fix?.awayTeamName || !fix?.startTime) return;
  try {
    await supabase.from('fixtures').upsert({
      id:              fix.id,
      sport:           fix.sport,
      league_id:       fix.leagueId || null,
      league_name:     fix.leagueName || null,
      season:          fix.season ? String(fix.season) : null,
      home_team_id:    fix.homeTeamId || null,
      home_team_name:  fix.homeTeamName,
      away_team_id:    fix.awayTeamId || null,
      away_team_name:  fix.awayTeamName,
      start_time:      new Date(fix.startTime).toISOString(),
      status:          fix.status || 'scheduled',
      updated_at:      new Date().toISOString(),
    }, { onConflict: 'id' });
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Schrijf bulk odds-snapshots vanuit parsed odds output.
 * @param {object} supabase
 * @param {number} fixtureId
 * @param {Array} rows - [{ bookmaker, market_type, selection_key, line, odds }]
 */
async function writeOddsSnapshots(supabase, fixtureId, rows) {
  if (!fixtureId || !Array.isArray(rows) || !rows.length) return;
  const capturedAt = new Date().toISOString();
  // Filter ongeldige odds
  const valid = rows.filter(r => r && r.bookmaker && r.market_type && r.selection_key && parseFloat(r.odds) > 1.0);
  if (!valid.length) return;
  const payload = valid.map(r => ({
    fixture_id:    fixtureId,
    captured_at:   capturedAt,
    bookmaker:     r.bookmaker,
    market_type:   r.market_type,
    selection_key: r.selection_key,
    line:          r.line != null && isFinite(r.line) ? +parseFloat(r.line).toFixed(2) : null,
    odds:          +parseFloat(r.odds).toFixed(4),
    source:        r.source || 'api-sports',
  }));
  try {
    // Batch in chunks van 500 om Supabase request size limit te respecteren
    for (let i = 0; i < payload.length; i += 500) {
      await supabase.from('odds_snapshots').insert(payload.slice(i, i + 500));
    }
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Helper: zet parsed-odds object van parseGameOdds om naar odds_snapshots rows.
 * Werkt voor alle markten die parseGameOdds retourneert.
 * @param {object} parsed - resultaat van parseGameOdds
 * @returns {Array} rows klaar voor writeOddsSnapshots
 */
function flattenParsedOdds(parsed) {
  const rows = [];
  for (const o of (parsed.moneyline || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'moneyline', selection_key: o.side, line: null, odds: o.price });
  }
  for (const o of (parsed.threeWay || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'threeway', selection_key: o.side, line: null, odds: o.price });
  }
  for (const o of (parsed.totals || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'total', selection_key: o.side, line: o.point, odds: o.price });
  }
  for (const o of (parsed.spreads || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'spread', selection_key: o.side, line: o.point, odds: o.price });
  }
  for (const o of (parsed.teamTotals || [])) {
    rows.push({ bookmaker: o.bookie, market_type: `team_total_${o.team}`, selection_key: o.side, line: o.point, odds: o.price });
  }
  for (const o of (parsed.doubleChance || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'double_chance', selection_key: o.side.toLowerCase(), line: null, odds: o.price });
  }
  for (const o of (parsed.dnb || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'dnb', selection_key: o.side, line: null, odds: o.price });
  }
  for (const o of (parsed.halfML || [])) {
    const mkt = o.market === 'f5' ? 'f5_ml' : 'half_ml';
    rows.push({ bookmaker: o.bookie, market_type: mkt, selection_key: o.side, line: null, odds: o.price });
  }
  for (const o of (parsed.halfTotals || [])) {
    const mkt = o.market === 'f5' ? 'f5_total' : 'half_total';
    rows.push({ bookmaker: o.bookie, market_type: mkt, selection_key: o.side, line: o.point, odds: o.price });
  }
  for (const o of (parsed.halfSpreads || [])) {
    const mkt = o.market === 'f5' ? 'f5_spread' : 'half_spread';
    rows.push({ bookmaker: o.bookie, market_type: mkt, selection_key: o.side, line: o.point, odds: o.price });
  }
  for (const o of (parsed.nrfi || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'nrfi', selection_key: o.side, line: null, odds: o.price });
  }
  for (const o of (parsed.oddEven || [])) {
    rows.push({ bookmaker: o.bookie, market_type: 'odd_even', selection_key: o.side, line: null, odds: o.price });
  }
  return rows;
}

/**
 * Schrijf market_consensus rij. 1 row per (fixture, market_type, line) per scan.
 * @param {object} supabase
 * @param {object} args - { fixtureId, marketType, line, consensusProb, bookmakerCount, overround, qualityScore }
 */
async function writeMarketConsensus(supabase, args) {
  if (!args?.fixtureId || !args?.marketType || !args?.consensusProb) return;
  try {
    const consensusOdds = {};
    for (const [k, v] of Object.entries(args.consensusProb)) {
      if (typeof v === 'number' && v > 0) consensusOdds[k] = +(1 / v).toFixed(4);
    }
    await supabase.from('market_consensus').insert({
      fixture_id:      args.fixtureId,
      market_type:     args.marketType,
      line:            args.line != null && isFinite(args.line) ? +parseFloat(args.line).toFixed(2) : null,
      consensus_prob:  args.consensusProb,
      consensus_odds:  Object.keys(consensusOdds).length ? consensusOdds : null,
      bookmaker_count: args.bookmakerCount || 0,
      overround:       args.overround != null ? +parseFloat(args.overround).toFixed(5) : null,
      quality_score:   args.qualityScore != null ? +parseFloat(args.qualityScore).toFixed(4) : null,
    });
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Schrijf feature_snapshot voor een fixture op pick-tijd.
 * @param {object} supabase
 * @param {number} fixtureId
 * @param {object} features - vrije JSON, alle gebruikte signal-waardes
 * @param {object} quality - vrije JSON met data-kwaliteit indicators
 */
async function writeFeatureSnapshot(supabase, fixtureId, features, quality = {}) {
  if (!fixtureId || !features) return;
  try {
    await supabase.from('feature_snapshots').insert({
      fixture_id:          fixtureId,
      feature_set_version: FEATURE_SET_VERSION,
      features:            features,
      quality:             quality,
    });
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Convert football convertAfOdds output (bookies = [{title, markets:[{key, outcomes:[{name, price, point}]}]}])
 * naar canonical odds_snapshots rows.
 */
function flattenFootballBookies(bookies, homeTeam, awayTeam) {
  const rows = [];
  for (const bk of (bookies || [])) {
    const bookmaker = bk.title || bk.name || 'Unknown';
    for (const m of (bk.markets || [])) {
      for (const o of (m.outcomes || [])) {
        const price = parseFloat(o.price) || 0;
        if (price <= 1.0) continue;
        let market_type = m.key;
        let selection_key = (o.name || '').toLowerCase();
        let line = o.point != null ? +parseFloat(o.point).toFixed(2) : null;

        // Normaliseer keys naar canonical schema
        if (market_type === 'h2h') {
          market_type = '1x2';
          if (o.name === homeTeam) selection_key = 'home';
          else if (o.name === awayTeam) selection_key = 'away';
          else if (o.name === 'Draw') selection_key = 'draw';
        } else if (market_type === 'totals') {
          market_type = 'total';
          selection_key = (o.name || '').toLowerCase(); // over / under
        } else if (market_type === 'btts') {
          selection_key = (o.name || '').toLowerCase(); // yes / no
        } else if (market_type === 'spreads') {
          market_type = 'spread';
          if (o.name === homeTeam) selection_key = 'home';
          else if (o.name === awayTeam) selection_key = 'away';
        }

        rows.push({ bookmaker, market_type, selection_key, line, odds: price });
      }
    }
  }
  return rows;
}

/**
 * Bereken quality score voor een market_consensus uit bookmaker count en spread.
 * Returns 0-1 (1 = hoog vertrouwen).
 *  - >= 8 bookies: 1.0
 *  - 5-7: 0.8
 *  - 3-4: 0.6
 *  - 2: 0.4
 *  - 1: 0.2
 * Lagere overround (= scherpere markt) verhoogt score lichtelijk.
 */
function consensusQualityScore(bookmakerCount, overround) {
  let base;
  if (bookmakerCount >= 8) base = 1.0;
  else if (bookmakerCount >= 5) base = 0.8;
  else if (bookmakerCount >= 3) base = 0.6;
  else if (bookmakerCount >= 2) base = 0.4;
  else if (bookmakerCount === 1) base = 0.2;
  else return 0;
  // Penalty voor extreme overround (>10% vig = soft of foute markt)
  if (overround > 0.10) base *= 0.7;
  else if (overround > 0.06) base *= 0.9;
  return Math.max(0, Math.min(1, base));
}

/**
 * Registreer een model_version (idempotent door unique constraint sport+market+tag).
 * @param {object} supabase
 * @param {object} v - { name, sport, marketType, versionTag, featureSetVersion, status }
 * @returns {Promise<number|null>} model_version_id of null bij fout
 */
async function registerModelVersion(supabase, v) {
  if (!v?.versionTag) return null;
  try {
    // Probeer eerst te lezen (idempotent)
    const sport = v.sport || 'multi';
    const marketType = v.marketType || 'multi';
    const { data: existing } = await supabase.from('model_versions')
      .select('id').eq('sport', sport).eq('market_type', marketType).eq('version_tag', v.versionTag)
      .maybeSingle();
    if (existing?.id) return existing.id;
    // Insert nieuwe versie
    const { data: inserted, error } = await supabase.from('model_versions').insert({
      name: v.name || 'edgepickr-heuristic',
      sport, market_type: marketType,
      version_tag: v.versionTag,
      feature_set_version: v.featureSetVersion || FEATURE_SET_VERSION,
      status: v.status || 'active',
      metrics: v.metrics || {},
    }).select('id').single();
    if (error) return null;
    return inserted?.id || null;
  } catch (e) { return null; }
}

/**
 * Schrijf model_run en retourneer id voor pick_candidates referentie.
 * @returns {Promise<number|null>} model_run_id
 */
async function writeModelRun(supabase, args) {
  if (!args?.fixtureId || !args?.modelVersionId || !args?.marketType || !args?.baselineProb || !args?.finalProb) return null;
  try {
    const { data: inserted, error } = await supabase.from('model_runs').insert({
      fixture_id:        args.fixtureId,
      model_version_id:  args.modelVersionId,
      market_type:       args.marketType,
      line:              args.line != null && isFinite(args.line) ? +parseFloat(args.line).toFixed(2) : null,
      baseline_prob:     args.baselineProb,
      model_delta:       args.modelDelta || {},
      final_prob:        args.finalProb,
      calibration:       args.calibration || {},
      debug:             args.debug || {},
    }).select('id').single();
    if (error) return null;
    return inserted?.id || null;
  } catch (e) { return null; }
}

/**
 * Schrijf één pick_candidate. passed_filters=false → rejected_reason verplicht voor analyse.
 *
 * v12.4.0: extra optionele velden voor paper-trading shadow-flow.
 *   shadow, finalTop5, marketType, line, marktLabel, kickoffMs, sport
 * Settlement-velden (closingOdds/closingBookie/closingSource/clvPct/result/
 * settledAt) blijven bewust UNDEFINED bij scan-tijd; settlePaperTradingCandidate
 * doet de UPDATE na fixture-finish.
 */
async function writePickCandidate(supabase, args) {
  if (!args?.modelRunId || !args?.fixtureId || !args?.selectionKey || !args?.bookmaker) return;
  try {
    const row = {
      model_run_id:        args.modelRunId,
      fixture_id:          args.fixtureId,
      selection_key:       args.selectionKey,
      bookmaker:           args.bookmaker,
      bookmaker_odds:      +parseFloat(args.bookmakerOdds || 0).toFixed(4),
      fair_prob:           +parseFloat(args.fairProb || 0).toFixed(6),
      edge_pct:            +parseFloat(args.edgePct || 0).toFixed(4),
      kelly_fraction:      args.kellyFraction != null ? +parseFloat(args.kellyFraction).toFixed(6) : null,
      stake_units:         args.stakeUnits != null ? +parseFloat(args.stakeUnits).toFixed(3) : null,
      expected_value_eur:  args.expectedValueEur != null ? +parseFloat(args.expectedValueEur).toFixed(2) : null,
      passed_filters:      !!args.passedFilters,
      rejected_reason:     args.rejectedReason || null,
      signals:             args.signals || [],
    };
    if (args.shadow != null)      row.shadow      = !!args.shadow;
    if (args.finalTop5 != null)   row.final_top5  = !!args.finalTop5;
    if (args.marketType)          row.market_type = String(args.marketType);
    if (args.line != null && Number.isFinite(parseFloat(args.line))) row.line = +parseFloat(args.line).toFixed(2);
    if (args.marktLabel)          row.markt_label = String(args.marktLabel);
    if (args.kickoffMs != null && Number.isFinite(Number(args.kickoffMs))) row.kickoff_ms = Number(args.kickoffMs);
    if (args.sport)               row.sport       = String(args.sport);
    await supabase.from('pick_candidates').insert(row);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Hoog-niveau wrapper: schrijf model_run + 2 pick_candidates (home/away) voor
 * een 2-way ML evaluatie. Reduceert duplicatie in scan-code.
 *
 * @param {object} args
 *   supabase, modelVersionId, fixtureId, marketType (string),
 *   fpHome, fpAway, adjHome, adjAway, bH={price,bookie}, bA={price,bookie},
 *   homeEdge, awayEdge, minEdge, maxWinnerOdds (default 6.5), minPrice (default 1.60),
 *   matchSignals (array), debug (object),
 *   marketBaseline {home, away} (optional, voor model_run baseline; defaults to {fpHome, fpAway}),
 *   extraGate(side, bookie) → null|string (optionele extra reject-reason check)
 */
async function recordMl2WayEvaluation(args) {
  const { supabase, modelVersionId, fixtureId, marketType,
          fpHome, fpAway, adjHome, adjAway,
          bH, bA, homeEdge, awayEdge, minEdge,
          matchSignals = [], debug = {} } = args;
  if (!supabase || !modelVersionId || !fixtureId || !marketType) return;
  const minPrice = args.minPrice ?? 1.60;
  const maxPrice = args.maxWinnerOdds ?? 6.5;
  const baseline = args.marketBaseline || { home: fpHome, away: fpAway };

  try {
    const runId = await writeModelRun(supabase, {
      fixtureId, modelVersionId, marketType, line: null,
      baselineProb: baseline,
      modelDelta: { home: adjHome - baseline.home, away: adjAway - baseline.away },
      finalProb: { home: adjHome, away: adjAway },
      debug,
    });
    if (!runId) return;

    const evaluate = (side, edge, fairProb, best) => {
      let rejected = null;
      const passedExtra = args.extraGate ? args.extraGate(side, best.bookie) : null;
      if (best.price <= 0) rejected = 'no_bookie_price';
      else if (best.price < minPrice) rejected = `price_too_low (${best.price})`;
      else if (best.price > maxPrice) rejected = `price_too_high (${best.price})`;
      else if (passedExtra) rejected = passedExtra;
      else if (edge < minEdge) rejected = `edge_below_min (${(edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%)`;
      writePickCandidate(supabase, {
        modelRunId: runId, fixtureId, selectionKey: side,
        bookmaker: best.bookie || 'none', bookmakerOdds: best.price,
        fairProb, edgePct: edge,
        passedFilters: !rejected, rejectedReason: rejected,
        signals: matchSignals,
      }).catch(() => {});
    };
    evaluate('home', homeEdge, adjHome, bH);
    evaluate('away', awayEdge, adjAway, bA);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * v12.2.32: high-level wrapper voor over/under-style markten met line.
 * Werkt voor main O/U totals, F5 totals, hockey/MLB team totals — elk
 * paar (Over/Under) dat een Poisson- of model-based prob heeft. Schrijft
 * model_run + 2 pick_candidates (over/under) per evaluatie.
 *
 * Voorheen schreven deze markten NIET naar v2 pick_candidates → admin
 * dashboards (scan-by-sport, model-brier, pick-distribution) ondervatten
 * de werkelijkheid van non-ML picks.
 *
 * @param {object} args
 *   supabase, modelVersionId, fixtureId, marketType (string),
 *   line, pOver, pUnder, bestOv={price,bookie}, bestUn={price,bookie},
 *   ovEdge, unEdge, minEdge, minPrice (default 1.60), maxPrice (default 3.5),
 *   matchSignals (array), debug (object).
 */
async function recordTotalsEvaluation(args) {
  const { supabase, modelVersionId, fixtureId, marketType, line,
          pOver, pUnder, bestOv, bestUn, ovEdge, unEdge, minEdge,
          matchSignals = [], debug = {} } = args;
  if (!supabase || !modelVersionId || !fixtureId || !marketType) return;
  const minPrice = args.minPrice ?? 1.60;
  const maxPrice = args.maxPrice ?? 3.5;
  try {
    const runId = await writeModelRun(supabase, {
      fixtureId, modelVersionId, marketType, line: line == null ? null : Number(line),
      baselineProb: { over: pOver, under: pUnder },
      modelDelta: {},
      finalProb: { over: pOver, under: pUnder },
      debug,
    });
    if (!runId) return;
    const evaluate = (side, edge, fairProb, best) => {
      let rejected = null;
      if (!best || best.price <= 0) rejected = 'no_bookie_price';
      else if (best.price < minPrice) rejected = `price_too_low (${best.price})`;
      else if (best.price > maxPrice) rejected = `price_too_high (${best.price})`;
      else if (edge < minEdge) rejected = `edge_below_min (${(edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%)`;
      writePickCandidate(supabase, {
        modelRunId: runId, fixtureId, selectionKey: side,
        bookmaker: best?.bookie || 'none', bookmakerOdds: best?.price || 0,
        fairProb, edgePct: edge,
        passedFilters: !rejected, rejectedReason: rejected,
        signals: matchSignals,
      }).catch(() => {});
    };
    evaluate('over', ovEdge, pOver, bestOv);
    evaluate('under', unEdge, pUnder, bestUn);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] recordTotalsEvaluation failed:', e?.message || e);
  }
}

/**
 * v12.2.46: Threeway (1X2) evaluatie wrapper. Home/Draw/Away.
 *
 * @param {object} args
 *   supabase, modelVersionId, fixtureId, marketType (default 'threeway'),
 *   pHome, pDraw, pAway,
 *   bestH={price,bookie}, bestD={price,bookie}, bestA={price,bookie},
 *   homeEdge, drawEdge, awayEdge, minEdge,
 *   minPrice (default 1.60), maxPrice (default 12),
 *   matchSignals, debug.
 */
async function recordThreewayEvaluation(args) {
  const { supabase, modelVersionId, fixtureId,
          pHome, pDraw, pAway, bestH, bestD, bestA,
          homeEdge, drawEdge, awayEdge, minEdge,
          matchSignals = [], debug = {} } = args;
  if (!supabase || !modelVersionId || !fixtureId) return;
  const marketType = args.marketType || 'threeway';
  const minPrice = args.minPrice ?? 1.60;
  const maxPrice = args.maxPrice ?? 12;
  try {
    const runId = await writeModelRun(supabase, {
      fixtureId, modelVersionId, marketType, line: null,
      baselineProb: { home: pHome, draw: pDraw, away: pAway },
      modelDelta: {},
      finalProb: { home: pHome, draw: pDraw, away: pAway },
      debug,
    });
    if (!runId) return;
    const evaluate = (sel, edge, fairProb, best) => {
      let rejected = null;
      if (!best || best.price <= 0) rejected = 'no_bookie_price';
      else if (best.price < minPrice) rejected = `price_too_low (${best.price})`;
      else if (best.price > maxPrice) rejected = `price_too_high (${best.price})`;
      else if (edge < minEdge) rejected = `edge_below_min (${(edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%)`;
      writePickCandidate(supabase, {
        modelRunId: runId, fixtureId, selectionKey: sel,
        bookmaker: best?.bookie || 'none', bookmakerOdds: best?.price || 0,
        fairProb, edgePct: edge,
        passedFilters: !rejected, rejectedReason: rejected,
        signals: matchSignals,
      }).catch(() => {});
    };
    evaluate('home', homeEdge, pHome, bestH);
    evaluate('draw', drawEdge, pDraw, bestD);
    evaluate('away', awayEdge, pAway, bestA);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] recordThreewayEvaluation failed:', e?.message || e);
  }
}

/**
 * v12.2.47: Double Chance evaluatie wrapper. 1X / 12 / X2.
 *
 * @param {object} args
 *   supabase, modelVersionId, fixtureId,
 *   pHX, p12, pX2, bestHX, best12, bestX2,
 *   eHX, e12, eX2, minEdge, matchSignals, debug.
 */
async function recordDoubleChanceEvaluation(args) {
  const { supabase, modelVersionId, fixtureId,
          pHX, p12, pX2, bestHX, best12, bestX2,
          eHX, e12, eX2, minEdge,
          matchSignals = [], debug = {} } = args;
  if (!supabase || !modelVersionId || !fixtureId) return;
  const minPrice = args.minPrice ?? 1.15;
  const maxPrice = args.maxPrice ?? 2.50;
  try {
    const runId = await writeModelRun(supabase, {
      fixtureId, modelVersionId, marketType: 'double_chance', line: null,
      baselineProb: { '1x': pHX, '12': p12, 'x2': pX2 },
      modelDelta: {},
      finalProb: { '1x': pHX, '12': p12, 'x2': pX2 },
      debug,
    });
    if (!runId) return;
    const evaluate = (sel, edge, fairProb, best) => {
      let rejected = null;
      if (!best || best.price <= 0) rejected = 'no_bookie_price';
      else if (best.price < minPrice) rejected = `price_too_low (${best.price})`;
      else if (best.price > maxPrice) rejected = `price_too_high (${best.price})`;
      else if (edge < minEdge) rejected = `edge_below_min (${(edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%)`;
      writePickCandidate(supabase, {
        modelRunId: runId, fixtureId, selectionKey: sel,
        bookmaker: best?.bookie || 'none', bookmakerOdds: best?.price || 0,
        fairProb, edgePct: edge,
        passedFilters: !rejected, rejectedReason: rejected,
        signals: matchSignals,
      }).catch(() => {});
    };
    evaluate('1x', eHX, pHX, bestHX);
    evaluate('12', e12, p12, best12);
    evaluate('x2', eX2, pX2, bestX2);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] recordDoubleChanceEvaluation failed:', e?.message || e);
  }
}

/**
 * v12.2.38: BTTS evaluatie wrapper. Yes/No zonder line.
 *
 * @param {object} args
 *   supabase, modelVersionId, fixtureId,
 *   pYes, pNo, bestYes={price,bookie}, bestNo={price,bookie},
 *   yesEdge, noEdge, minEdge, minPrice (default 1.60), maxPrice (default 3.5),
 *   matchSignals (array), debug (object).
 */
async function recordBttsEvaluation(args) {
  const { supabase, modelVersionId, fixtureId,
          pYes, pNo, bestYes, bestNo, yesEdge, noEdge, minEdge,
          matchSignals = [], debug = {} } = args;
  if (!supabase || !modelVersionId || !fixtureId) return;
  const minPrice = args.minPrice ?? 1.60;
  const maxPrice = args.maxPrice ?? 3.5;
  try {
    const runId = await writeModelRun(supabase, {
      fixtureId, modelVersionId, marketType: 'btts', line: null,
      baselineProb: { yes: pYes, no: pNo },
      modelDelta: {},
      finalProb: { yes: pYes, no: pNo },
      debug,
    });
    if (!runId) return;
    const evaluate = (side, edge, fairProb, best) => {
      let rejected = null;
      if (!best || best.price <= 0) rejected = 'no_bookie_price';
      else if (best.price < minPrice) rejected = `price_too_low (${best.price})`;
      else if (best.price > maxPrice) rejected = `price_too_high (${best.price})`;
      else if (edge < minEdge) rejected = `edge_below_min (${(edge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(1)}%)`;
      writePickCandidate(supabase, {
        modelRunId: runId, fixtureId, selectionKey: side,
        bookmaker: best?.bookie || 'none', bookmakerOdds: best?.price || 0,
        fairProb, edgePct: edge,
        passedFilters: !rejected, rejectedReason: rejected,
        signals: matchSignals,
      }).catch(() => {});
    };
    evaluate('yes', yesEdge, pYes, bestYes);
    evaluate('no', noEdge, pNo, bestNo);
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] recordBttsEvaluation failed:', e?.message || e);
  }
}

/**
 * Schrijf een raw_api_events row voor debugging/replay.
 * Sample-rate: niet elke call, alleen failures of specifieke calls.
 */
async function writeRawApiEvent(supabase, args) {
  if (!supabase || !args?.source || !args?.entityType) return;
  try {
    await supabase.from('raw_api_events').insert({
      source:      args.source,
      entity_type: args.entityType,
      entity_id:   args.entityId ? String(args.entityId) : null,
      payload:     args.payload || {},
    });
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Upsert signal_stats row (één per (model_version, signal_name)).
 */
async function upsertSignalStat(supabase, args) {
  if (!supabase || !args?.signalName || !args?.modelVersionId) return;
  try {
    // Try update first, insert if not exists
    const { data: existing } = await supabase.from('signal_stats')
      .select('id').eq('model_version_id', args.modelVersionId).eq('signal_name', args.signalName)
      .maybeSingle();
    const row = {
      model_version_id: args.modelVersionId,
      sport:            args.sport || null,
      market_type:      args.marketType || null,
      signal_name:      args.signalName,
      sample_size:      args.sampleSize || 0,
      avg_clv:          args.avgClv != null ? +parseFloat(args.avgClv).toFixed(4) : null,
      avg_pnl:          args.avgPnl != null ? +parseFloat(args.avgPnl).toFixed(4) : null,
      lift_vs_market:   args.liftVsMarket != null ? +parseFloat(args.liftVsMarket).toFixed(4) : null,
      weight:           args.weight != null ? +parseFloat(args.weight).toFixed(4) : null,
      updated_at:       new Date().toISOString(),
    };
    if (existing?.id) {
      await supabase.from('signal_stats').update(row).eq('id', existing.id);
    } else {
      await supabase.from('signal_stats').insert(row);
    }
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Schrijf execution_log voor een geplaatste bet.
 */
async function writeExecutionLog(supabase, args) {
  if (!supabase || !args?.bookmaker || !args?.acceptedOdds) return;
  try {
    const slip = args.requestedOdds && args.requestedOdds > 0
      ? +(((args.acceptedOdds - args.requestedOdds) / args.requestedOdds * 100).toFixed(4))
      : null;
    await supabase.from('execution_logs').insert({
      bet_id:         args.betId || null,
      bet_uuid:       args.betUuid || null,
      requested_odds: args.requestedOdds != null ? +parseFloat(args.requestedOdds).toFixed(4) : null,
      accepted_odds:  +parseFloat(args.acceptedOdds).toFixed(4),
      delay_ms:       args.delayMs != null ? parseInt(args.delayMs) : null,
      slippage_pct:   slip,
      bookmaker:      args.bookmaker,
      notes:          args.notes || {},
    });
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

/**
 * Schrijf training_example zodra een bet uitkomst heeft + features beschikbaar zijn.
 */
async function writeTrainingExample(supabase, args) {
  if (!supabase || !args?.fixtureId || !args?.marketType || !args?.label) return;
  try {
    await supabase.from('training_examples').insert({
      fixture_id:           args.fixtureId,
      market_type:          args.marketType,
      line:                 args.line != null ? +parseFloat(args.line).toFixed(2) : null,
      snapshot_time:        args.snapshotTime || new Date().toISOString(),
      feature_snapshot_id:  args.featureSnapshotId || null,
      market_consensus_id:  args.marketConsensusId || null,
      label:                args.label,
      close_label:          args.closeLabel || null,
    });
  } catch (e) {
    if (process.env.SNAPSHOT_DEBUG) console.warn('[snapshots] write failed:', e?.message || e);
  }
}

module.exports = {
  FEATURE_SET_VERSION,
  upsertFixture,
  writeOddsSnapshots,
  writeMarketConsensus,
  writeFeatureSnapshot,
  flattenParsedOdds,
  flattenFootballBookies,
  consensusQualityScore,
  registerModelVersion,
  writeModelRun,
  writePickCandidate,
  recordMl2WayEvaluation,
  recordTotalsEvaluation,
  recordThreewayEvaluation,
  recordDoubleChanceEvaluation,
  recordBttsEvaluation,
  writeRawApiEvent,
  upsertSignalStat,
  writeExecutionLog,
  writeTrainingExample,
};
