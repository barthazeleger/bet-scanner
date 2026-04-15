'use strict';

// Modal unit-advies na odds-aanpassing in de log-modal.
// Pure functie, testbaar in Node, bruikbaar in browser via UMD.
//
// v10.8.9: 4-tier line-move logica. Bij lagere odds gebruikte updatePayout()
// voorheen pure Kelly, die de scanner-dampings (market mult, new-season,
// risk gates) negeert — waardoor een LAGERE odd kon leiden tot een HOGER
// unit-advies. Dat klopt niet. Nieuwe aanpak:
//
//   Δ% = (newOdds - origOdds) / origOdds * 100
//
//   Δ% ≥ -2%   → "ongewijzigd": scanner-advies behouden
//   -4% ≤ Δ% < -2% → "light": origUnits × kellyRatio, afgerond op bucket
//   -6% ≤ Δ% < -4% → "moderate": helft van scanner-advies + waarschuwing
//           Δ% < -6% → "adverse": 0U, "line moved — niet meer valide"
//   Δ% > +2%   → "better": pure Kelly maar GECAPT op origUnits
//
// Rationale: een grote adverse line-move (>6%) is een sterk reverse-CLV
// signaal — bookies bewegen lijnen niet willekeurig, een gap van die orde
// betekent dat sharp money op de andere kant kwam en ons model-advies
// waarschijnlijk overschat was.

const UNIT_BUCKETS = [0, 0.2, 0.3, 0.4, 0.5, 0.75, 1.0, 1.5, 2.0];

function roundToBucket(u) {
  if (u <= 0) return 0;
  let best = UNIT_BUCKETS[0];
  let bestDiff = Math.abs(best - u);
  for (const b of UNIT_BUCKETS) {
    const d = Math.abs(b - u);
    if (d < bestDiff) { best = b; bestDiff = d; }
  }
  return best;
}

// Floor naar bucket: altijd afronden NAAR BENEDEN naar dichtstbijzijnde bucket.
// Gebruikt bij light/moderate zodat een daling strikt monotoon doorkomt in
// het advies (geen "3% daling → zelfde unit" via rounding-up).
function floorToBucket(u) {
  if (u <= 0) return 0;
  let best = 0;
  for (const b of UNIT_BUCKETS) {
    if (b <= u) best = b;
    else break;
  }
  return best;
}

function kellyFor(prob, odds) {
  if (!prob || !odds || odds <= 1) return 0;
  return Math.max(0, (prob * (odds - 1) - (1 - prob)) / (odds - 1));
}

function scoreFromHk(hk) {
  if (hk <= 0) return 0;
  return Math.min(10, Math.max(5, Math.round((hk - 0.015) / 0.135 * 5) + 5));
}

function pureRecFromHk(hk) {
  if (hk < 0.015) return 0;
  if (hk < 0.025) return 0.2;
  if (hk < 0.035) return 0.3;
  if (hk < 0.045) return 0.4;
  if (hk < 0.055) return 0.5;
  if (hk < 0.070) return 0.75;
  if (hk < 0.090) return 1.0;
  if (hk < 0.120) return 1.5;
  return 2.0;
}

function computeModalAdvice(input) {
  const origOdds  = Number(input && input.origOdds)  || 0;
  const newOdds   = Number(input && input.newOdds)   || 0;
  const prob      = Number(input && input.prob)      || 0; // 0..1
  const origUnits = Number(input && input.origUnits) || 0;
  const origScore = Number(input && input.origScore) || 0;
  // v10.8.11: scanner-edge als authoritative anker. Bij aangeleverde origEdge
  // schalen we dampedEdge proportioneel met (pure_new / pure_orig), ipv ruwe
  // bucket-inversie. Matcht modal-weergave exact met wat card toont.
  const origEdge  = Number(input && input.origEdge);  // % (bv 7 voor +7%)

  if (!origOdds || !newOdds || !prob) {
    return { severity: 'invalid', recUnits: 0, diff: 0, diffPct: 0,
             edge: 0, dampedEdge: 0, kelly: 0, hk: 0, scoreVal: 0, message: '' };
  }

  const diff    = newOdds - origOdds;
  const diffPct = (diff / origOdds) * 100;

  const fairOdds = 1 / prob;
  const edge     = ((newOdds - fairOdds) / fairOdds) * 100;
  const kelly    = kellyFor(prob, newOdds);
  const hk       = kelly * 0.5;
  const pureRec  = pureRecFromHk(hk);

  const oldKelly = kellyFor(prob, origOdds);
  const oldHk    = oldKelly * 0.5;
  const kellyRatio = oldHk > 0 ? hk / oldHk : 0;

  const freshScore = scoreFromHk(hk);
  const effOrigScore = origScore || scoreFromHk(oldHk);

  // Damping: scanner paste multipliers / new-season / risk-gates toe die
  // pure Kelly niet kent. We willen modal-edge matchen met scanner-edge.
  //
  // Primair (v10.8.11): als origEdge (scanner truth) beschikbaar is, schalen
  // we proportioneel met pure-edge ratio:
  //   dampedEdge = origEdge × (pureEdge_new / pureEdge_orig)
  // Dan klopt het bij ongewijzigde odds 1-op-1 met de card.
  //
  // Fallback: bucket-inversie via origUnits/pureRec (grof maar werkend).
  const pureEdgeOrig = ((origOdds - fairOdds) / fairOdds) * 100;
  const pureOrigRec = pureRecFromHk(oldHk);
  let dampingFactor;
  let dampedEdge;
  if (isFinite(origEdge) && origEdge > 0 && pureEdgeOrig > 0) {
    dampingFactor = Math.min(1, origEdge / pureEdgeOrig);
    dampedEdge = origEdge * (edge / pureEdgeOrig);
  } else {
    dampingFactor = (origUnits > 0 && pureOrigRec > 0)
      ? Math.min(1, origUnits / pureOrigRec)
      : 1;
    dampedEdge = edge * dampingFactor;
  }

  // Tier 1: ongewijzigd (±2%)
  if (Math.abs(diffPct) < 2) {
    return {
      severity: 'unchanged', recUnits: origUnits || pureRec,
      diff, diffPct, edge, dampedEdge, kelly, hk, dampingFactor,
      scoreVal: effOrigScore,
      message: 'Odds ongewijzigd — scanner advies',
    };
  }

  // Tier 5: hogere odds → cap op origUnits (pure Kelly mag niet boven scanner)
  if (diffPct > 2) {
    const rec = origUnits ? Math.min(pureRec, origUnits) : pureRec;
    return {
      severity: 'better', recUnits: rec,
      diff, diffPct, edge, dampedEdge, kelly, hk, dampingFactor,
      scoreVal: Math.max(effOrigScore, freshScore),
      message: 'Odds gestegen — bevestig bij bookie',
    };
  }

  // Tier 4: adverse (>5% daling) → invalid
  // v10.8.10: drempel verlaagd van -6% naar -5% na gebruikersfeedback —
  // Luton case (-5.8%) hoort bij adverse, niet moderate.
  if (diffPct <= -5) {
    return {
      severity: 'adverse', recUnits: 0,
      diff, diffPct, edge, dampedEdge, kelly, hk, dampingFactor,
      scoreVal: Math.min(effOrigScore, freshScore),
      message: 'Line moved sterk tegen — pick niet meer valide',
    };
  }

  // Tier 3: moderate (3.5-5% daling) → halveren + warning
  if (diffPct <= -3.5) {
    const halved = origUnits > 0 ? origUnits / 2 : pureRec / 2;
    return {
      severity: 'moderate', recUnits: floorToBucket(Math.min(halved, pureRec)),
      diff, diffPct, edge, dampedEdge, kelly, hk, dampingFactor,
      scoreVal: Math.min(effOrigScore, freshScore),
      message: 'Line moved tegen — advies gehalveerd',
    };
  }

  // Tier 2: light (2-4% daling) → scale origUnits met kellyRatio
  // floorToBucket zodat een daling strikt monotoon in het advies doorkomt.
  const scaled = origUnits > 0 && kellyRatio > 0
    ? origUnits * kellyRatio
    : pureRec;
  const lightRec = floorToBucket(Math.min(scaled, pureRec));
  // Als floor gelijk blijft aan origUnits (zeer kleine daling): één bucket lager
  let finalLight = lightRec;
  if (origUnits > 0 && lightRec >= origUnits) {
    const idx = UNIT_BUCKETS.indexOf(origUnits);
    if (idx > 0) finalLight = UNIT_BUCKETS[idx - 1];
  }
  return {
    severity: 'light', recUnits: finalLight,
    diff, diffPct, edge, dampedEdge, kelly, hk, dampingFactor,
    scoreVal: Math.min(effOrigScore, freshScore),
    message: 'Odds lichtjes omlaag — advies bijgesteld',
  };
}

// ── UMD export ───────────────────────────────────────────────────────────────
const _api = { computeModalAdvice, kellyFor, scoreFromHk, pureRecFromHk, roundToBucket };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = _api;
} else if (typeof window !== 'undefined') {
  window.EPAdvice = _api;
}
