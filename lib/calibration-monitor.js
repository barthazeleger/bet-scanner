'use strict';

/**
 * EdgePickr Calibration Monitor (sectie 14.R2.A doctrine).
 *
 * Meet of onze signaal-voorspellingen daadwerkelijk gekalibreerd zijn:
 * als we 60% win-kans voorspellen, winnen die picks dan ~60% van de tijd?
 * Het antwoord staat in Brier-score, log-loss en calibration-bins.
 *
 * **Predicted probability (v1) = `ep_proxy`**: `1/odds + ΣsignalBoost`.
 * Dit is expliciet GEEN canonical `pick.ep`; de bet↔pick join voor echte
 * model probability komt in een latere slice. Deze module houdt die bron
 * eerlijk gelabeld zodat downstream geen proxy-data als model truth leest.
 *
 * **Attributie per signaal**: primair gewogen op parseable percentage-
 * contribution in `pick.signals[]` (patronen zoals `form:+2.5%`); fallback
 * naar uniform verdeling wanneer signalen geen percentages hebben. Mode
 * wordt expliciet opgeslagen zodat downstream later weet welk regime is
 * gebruikt.
 *
 * **Window-shape**: `30d`, `90d`, `365d`, `lifetime`. Vaste vensters
 * voor voorspelbare storage + vergelijkbaarheid (Codex-kalibratie).
 *
 * **Aggregatie-sleutel**: `(signal_name, sport, market_type, window_key)`.
 * Een signaal dat voor voetbal-BTTS werkt zegt niets over hockey-ML.
 *
 * Alle functies hier zijn pure (geen side-effects, geen supabase). De
 * upsert/job-laag leeft elders.
 */

const WINDOWS = Object.freeze({
  '30d':       30 * 24 * 60 * 60 * 1000,
  '90d':       90 * 24 * 60 * 60 * 1000,
  '365d':     365 * 24 * 60 * 60 * 1000,
  'lifetime': Infinity,
});

// ── Core scoring primitives ─────────────────────────────────────────────────

/**
 * Brier-score: mean squared error tussen voorspelde kans en werkelijke
 * binaire uitkomst. Lager = beter. Range [0, 1]. 0.25 = random gok op 0.5.
 *
 * @param {Array<{prob:number, outcome:0|1}>} predictions
 * @returns {number|null}
 */
function computeBrierScore(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) return null;
  let sum = 0;
  let n = 0;
  for (const p of predictions) {
    if (!p || typeof p.prob !== 'number' || (p.outcome !== 0 && p.outcome !== 1)) continue;
    sum += (p.prob - p.outcome) ** 2;
    n += 1;
  }
  return n > 0 ? +(sum / n).toFixed(6) : null;
}

function computeWeightedBrierScore(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) return null;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of predictions) {
    if (!p || typeof p.prob !== 'number' || (p.outcome !== 0 && p.outcome !== 1)) continue;
    const weight = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1;
    weightedSum += weight * ((p.prob - p.outcome) ** 2);
    weightTotal += weight;
  }
  return weightTotal > 0 ? +(weightedSum / weightTotal).toFixed(6) : null;
}

/**
 * Log-loss (binary cross-entropy): -mean(y·log(p) + (1-y)·log(1-p)). Clamp
 * naar [eps, 1-eps] tegen log(0). Lager = beter.
 *
 * @param {Array<{prob:number, outcome:0|1}>} predictions
 * @returns {number|null}
 */
function computeLogLoss(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) return null;
  const eps = 1e-15;
  let sum = 0;
  let n = 0;
  for (const p of predictions) {
    if (!p || typeof p.prob !== 'number' || (p.outcome !== 0 && p.outcome !== 1)) continue;
    const prob = Math.max(eps, Math.min(1 - eps, p.prob));
    sum += p.outcome * Math.log(prob) + (1 - p.outcome) * Math.log(1 - prob);
    n += 1;
  }
  return n > 0 ? +(-sum / n).toFixed(6) : null;
}

function computeWeightedLogLoss(predictions) {
  if (!Array.isArray(predictions) || !predictions.length) return null;
  const eps = 1e-15;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const p of predictions) {
    if (!p || typeof p.prob !== 'number' || (p.outcome !== 0 && p.outcome !== 1)) continue;
    const weight = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1;
    const prob = Math.max(eps, Math.min(1 - eps, p.prob));
    const loss = -(p.outcome * Math.log(prob) + (1 - p.outcome) * Math.log(1 - prob));
    weightedSum += weight * loss;
    weightTotal += weight;
  }
  return weightTotal > 0 ? +(weightedSum / weightTotal).toFixed(6) : null;
}

/**
 * Calibration-bins: splits predictions op predicted prob in `binCount`
 * gelijke intervallen. Per bin: gemiddelde voorspelde kans vs werkelijke
 * hit-rate. Ideaal: avgProb ≈ actualRate per bin (diagonaal op reliability
 * diagram).
 *
 * @param {Array<{prob, outcome}>} predictions
 * @param {number} binCount - default 10
 * @returns {Array<{bin, binStart, binEnd, n, avgProb, actualRate}>}
 */
function computeCalibrationBins(predictions, binCount = 10) {
  if (!Array.isArray(predictions) || !predictions.length) return [];
  if (!Number.isInteger(binCount) || binCount < 2) binCount = 10;

  const bins = Array.from({ length: binCount }, (_, i) => ({
    bin: i,
    binStart: +(i / binCount).toFixed(4),
    binEnd: +((i + 1) / binCount).toFixed(4),
    _sumProb: 0,
    _sumOutcome: 0,
    n: 0,
  }));

  for (const p of predictions) {
    if (!p || typeof p.prob !== 'number' || (p.outcome !== 0 && p.outcome !== 1)) continue;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor(p.prob * binCount)));
    bins[idx]._sumProb += p.prob;
    bins[idx]._sumOutcome += p.outcome;
    bins[idx].n += 1;
  }

  return bins.map(b => ({
    bin: b.bin,
    binStart: b.binStart,
    binEnd: b.binEnd,
    n: b.n,
    avgProb: b.n > 0 ? +(b._sumProb / b.n).toFixed(4) : null,
    actualRate: b.n > 0 ? +(b._sumOutcome / b.n).toFixed(4) : null,
  }));
}

function computeWeightedCalibrationBins(predictions, binCount = 10) {
  if (!Array.isArray(predictions) || !predictions.length) return [];
  if (!Number.isInteger(binCount) || binCount < 2) binCount = 10;

  const bins = Array.from({ length: binCount }, (_, i) => ({
    bin: i,
    binStart: +(i / binCount).toFixed(4),
    binEnd: +((i + 1) / binCount).toFixed(4),
    _sumProbWeighted: 0,
    _sumOutcomeWeighted: 0,
    _sumWeight: 0,
    n: 0,
  }));

  for (const p of predictions) {
    if (!p || typeof p.prob !== 'number' || (p.outcome !== 0 && p.outcome !== 1)) continue;
    const weight = Number.isFinite(p.weight) && p.weight > 0 ? p.weight : 1;
    const idx = Math.min(binCount - 1, Math.max(0, Math.floor(p.prob * binCount)));
    bins[idx]._sumProbWeighted += weight * p.prob;
    bins[idx]._sumOutcomeWeighted += weight * p.outcome;
    bins[idx]._sumWeight += weight;
    bins[idx].n += 1;
  }

  return bins.map(b => ({
    bin: b.bin,
    binStart: b.binStart,
    binEnd: b.binEnd,
    n: b.n,
    weightSum: b._sumWeight > 0 ? +b._sumWeight.toFixed(6) : 0,
    avgProb: b._sumWeight > 0 ? +(b._sumProbWeighted / b._sumWeight).toFixed(4) : null,
    actualRate: b._sumWeight > 0 ? +(b._sumOutcomeWeighted / b._sumWeight).toFixed(4) : null,
  }));
}

// ── Signal-attributie ───────────────────────────────────────────────────────

/**
 * Parse één signal-string. Verwacht formaten zoals:
 *   `form:+2.5%`, `h2h:-1.0%`, `nba_availability:+3.2%`, `nhl_goalie:+1.1%`
 *
 * Returnt null als de string geen herkenbaar percentage bevat — dan valt
 * attribution terug op uniform mode.
 *
 * @param {string} signalStr
 * @returns {{name:string, contribution:number}|null}
 */
function parseSignalContribution(signalStr) {
  if (typeof signalStr !== 'string') return null;
  const s = signalStr.trim();
  const m = /^([^:]+):([+-]?\d+\.?\d*)%/.exec(s);
  if (!m) return null;
  const name = m[1].trim();
  const contribution = parseFloat(m[2]);
  if (!name || !Number.isFinite(contribution)) return null;
  return { name, contribution };
}

/**
 * Extract de naam van een signal-string, ook als er geen percentage in zit.
 * `form:+2.5%` → `form`. `sanity_ok` → `sanity_ok`.
 */
function extractSignalName(signalStr) {
  if (typeof signalStr !== 'string') return null;
  const s = signalStr.trim();
  const colonIdx = s.indexOf(':');
  return (colonIdx > 0 ? s.slice(0, colonIdx) : s).trim() || null;
}

/**
 * Attribueer een pick aan zijn signalen met gewichten die samen 1.0 vormen.
 *
 * Modus 'weighted': alle signalen met parseable percentage krijgen gewicht
 * evenredig aan |contribution| / Σ|contribution|. Signalen zonder percentage
 * worden genegeerd in deze modus (ze leven in `extraSignals`).
 *
 * Modus 'uniform': fallback wanneer geen enkel signaal parseable is, of
 * wanneer alle parseable contributions op 0 uitkomen. Alle named signalen
 * (inclusief labels zonder percentage zoals `sanity_ok`) delen gewicht 1/n.
 *
 * @param {{signals: string[]}} pick
 * @returns {{signals: Array<{name:string, weight:number}>, mode:'weighted'|'uniform'}}
 */
function attributePickToSignals(pick) {
  const raw = Array.isArray(pick?.signals) ? pick.signals : [];
  if (!raw.length) return { signals: [], mode: 'uniform' };

  const parsed = raw.map(parseSignalContribution).filter(Boolean);
  const totalAbs = parsed.reduce((s, p) => s + Math.abs(p.contribution), 0);

  if (parsed.length === 0 || totalAbs === 0) {
    const names = raw.map(extractSignalName).filter(Boolean);
    if (!names.length) return { signals: [], mode: 'uniform' };
    const w = 1 / names.length;
    const agg = new Map();
    for (const n of names) agg.set(n, (agg.get(n) || 0) + w);
    return {
      signals: [...agg.entries()].map(([name, weight]) => ({ name, weight: +weight.toFixed(6) })),
      mode: 'uniform',
    };
  }

  const agg = new Map();
  for (const p of parsed) {
    const w = Math.abs(p.contribution) / totalAbs;
    agg.set(p.name, (agg.get(p.name) || 0) + w);
  }
  return {
    signals: [...agg.entries()].map(([name, weight]) => ({ name, weight: +weight.toFixed(6) })),
    mode: 'weighted',
  };
}

// ── Aggregatie ──────────────────────────────────────────────────────────────

/**
 * Converteer een settled pick (ruwe bet-row + pick-context) naar een
 * prediction-record dat door de scoring-primitives gegeten kan worden.
 *
 * @param {{ep:number, uitkomst:'W'|'L'|'Open', settledAt?:number|string,
 *          signals:string[], sport?:string, markt?:string}} row
 */
function toPrediction(row) {
  if (!row || typeof row.ep !== 'number') return null;
  if (row.uitkomst !== 'W' && row.uitkomst !== 'L') return null;
  return {
    prob: row.ep,
    outcome: row.uitkomst === 'W' ? 1 : 0,
    settledAt: row.settledAt || null,
    signals: Array.isArray(row.signals) ? row.signals : [],
    sport: row.sport || null,
    marketType: row.marketType || row.markt || null,
  };
}

/**
 * Bepaal welke windows een settled-timestamp (ms) hoort — meerdere
 * tegelijk mogelijk. `lifetime` is altijd aan, `30d` alleen als de bet
 * binnen 30d viel, etc.
 */
function windowsFor(settledMs, now = Date.now()) {
  const out = ['lifetime'];
  if (!Number.isFinite(settledMs)) return out;
  const age = now - settledMs;
  if (age < 0) return out;
  if (age <= WINDOWS['30d']) out.push('30d');
  if (age <= WINDOWS['90d']) out.push('90d');
  if (age <= WINDOWS['365d']) out.push('365d');
  return out;
}

function windowStartFor(windowKey, windowEndMs) {
  if (!Number.isFinite(windowEndMs)) return null;
  if (windowKey === 'lifetime') return null;
  const duration = WINDOWS[windowKey];
  if (!Number.isFinite(duration) || !Number.isFinite(windowEndMs - duration)) return null;
  return new Date(windowEndMs - duration).toISOString();
}

function makeKey(signalName, sport, marketType, windowKey) {
  return `${signalName}|${sport || '*'}|${marketType || '*'}|${windowKey}`;
}

/**
 * Aggregeer settled picks naar per-signaal calibration-metrics per
 * (sport, market_type, window_key). Gebruikt gewogen attributie
 * (fallback uniform). Elke pick-contributie-gewicht weegt mee in
 * Brier/log-loss/bins van het betreffende signaal.
 *
 * @param {Array} settledPicks - records met shape van toPrediction()-output
 *   of ruwe rows die door toPrediction() getransformeerd kunnen worden
 * @param {{now?:number, binCount?:number}} [opts]
 * @returns {Map<string, {signalName, sport, marketType, windowKey, n, brierScore,
 *                        logLoss, avgProb, actualRate, bins, attributionMode}>}
 */
function aggregateBySignal(settledPicks, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const binCount = Number.isInteger(opts.binCount) && opts.binCount >= 2 ? opts.binCount : 10;

  // Per key: { predictions: [...], modes: Set<'weighted'|'uniform'> }
  const buckets = new Map();

  for (const raw of settledPicks || []) {
    const pred = raw && typeof raw.outcome === 'number' && typeof raw.prob === 'number'
      ? raw
      : toPrediction(raw);
    if (!pred) continue;

    const settledMs = typeof pred.settledAt === 'string' ? Date.parse(pred.settledAt) : pred.settledAt;
    const activeWindows = windowsFor(settledMs, now);

    const attribution = attributePickToSignals({ signals: pred.signals });
    // Pick zonder signalen → skip aggregatie; we kennen 'm niet toe aan
    // een signaal, want uniform verdelen over "niets" is onzin.
    if (!attribution.signals.length) continue;

    for (const sig of attribution.signals) {
      for (const windowKey of activeWindows) {
        const key = makeKey(sig.name, pred.sport, pred.marketType, windowKey);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            signalName: sig.name,
            sport: pred.sport || null,
            marketType: pred.marketType || null,
            windowKey,
            predictions: [],
            modes: new Set(),
          };
          buckets.set(key, bucket);
        }
        bucket.predictions.push({
          prob: pred.prob,
          outcome: pred.outcome,
          weight: sig.weight,
        });
        bucket.modes.add(attribution.mode);
      }
    }
  }

  // Compute metrics per bucket
  const out = new Map();
  for (const [key, bucket] of buckets) {
    if (!bucket.predictions.length) continue;

    const preds = bucket.predictions.map(p => ({
      prob: p.prob,
      outcome: p.outcome,
      weight: p.weight,
    }));
    const brier = computeWeightedBrierScore(preds);
    const logLoss = computeWeightedLogLoss(preds);
    const bins = computeWeightedCalibrationBins(preds, binCount);

    const sumProb = preds.reduce((s, p) => s + (p.weight * p.prob), 0);
    const sumOutcome = preds.reduce((s, p) => s + (p.weight * p.outcome), 0);
    const nEffective = bucket.predictions.reduce((s, p) => s + p.weight, 0);

    // Als ≥ 1 pick via uniform-fallback attributeerde, markeer de aggregate
    // mode als 'mixed' — dat is eerlijker dan 'weighted' stempelen op data
    // waar een deel geen percentages had.
    let mode;
    if (bucket.modes.has('weighted') && bucket.modes.has('uniform')) mode = 'mixed';
    else if (bucket.modes.has('weighted')) mode = 'weighted';
    else mode = 'uniform';

    out.set(key, {
      signalName: bucket.signalName,
      sport: bucket.sport,
      marketType: bucket.marketType,
      windowKey: bucket.windowKey,
      n: preds.length,
      nEffective: +nEffective.toFixed(3),
      brierScore: brier,
      logLoss: logLoss,
      avgProb: nEffective > 0 ? +(sumProb / nEffective).toFixed(4) : null,
      actualRate: nEffective > 0 ? +(sumOutcome / nEffective).toFixed(4) : null,
      bins,
      attributionMode: mode,
    });
  }
  return out;
}

function buildCalibrationRows(aggregates, { windowEndMs = Date.now(), probabilitySource = 'ep_proxy' } = {}) {
  const nowIso = new Date(windowEndMs).toISOString();
  const rows = [];
  for (const m of (aggregates?.values ? aggregates.values() : [])) {
    rows.push({
      signal_name:        m.signalName,
      sport:              m.sport,
      market_type:        m.marketType,
      window_key:         m.windowKey,
      window_start:       windowStartFor(m.windowKey, windowEndMs),
      window_end:         nowIso,
      n:                  m.n,
      n_effective:        m.nEffective,
      brier_score:        m.brierScore,
      log_loss:           m.logLoss,
      avg_prob:           m.avgProb,
      actual_rate:        m.actualRate,
      bin_payload:        m.bins,
      attribution_mode:   m.attributionMode,
      probability_source: probabilitySource,
      updated_at:         nowIso,
    });
  }
  return rows;
}

module.exports = {
  // Core scoring
  computeBrierScore,
  computeWeightedBrierScore,
  computeLogLoss,
  computeWeightedLogLoss,
  computeCalibrationBins,
  computeWeightedCalibrationBins,
  // Attributie
  parseSignalContribution,
  extractSignalName,
  attributePickToSignals,
  // Aggregatie
  aggregateBySignal,
  buildCalibrationRows,
  toPrediction,
  windowsFor,
  windowStartFor,
  // Constants
  WINDOWS,
};
