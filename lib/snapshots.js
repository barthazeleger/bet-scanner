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
  } catch (e) { /* swallow */ }
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
  } catch (e) { /* swallow */ }
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
  } catch (e) { /* swallow */ }
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
  } catch (e) { /* swallow */ }
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
 */
async function writePickCandidate(supabase, args) {
  if (!args?.modelRunId || !args?.fixtureId || !args?.selectionKey || !args?.bookmaker) return;
  try {
    await supabase.from('pick_candidates').insert({
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
    });
  } catch (e) { /* swallow */ }
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
};
