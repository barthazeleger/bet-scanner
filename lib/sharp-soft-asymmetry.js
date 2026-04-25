'use strict';

const { devigProportional } = require('./devig');

/**
 * v12.2.13 (R4 MVP): sharp-soft asymmetric edge detection.
 *
 * Doctrine: Pinnacle/Betfair = sharp reference (lage marge, snel
 * lijn-bewegingen, model-canonieke truth). Bet365/Unibet = execution-
 * books (hogere marge, soms achterop bij sharp consensus). De gap is
 * exploitabel — soft-book staat tijdelijk gunstiger dan sharp consensus.
 *
 * Pure helpers — geen pipeline-integratie in deze release. Toekomstige
 * integratie: per scan een 30-min-pre-kickoff alert wanneer soft-book
 * fair-prob > sharp-fair-prob met meer dan threshold (default 4pp).
 *
 * Referenties: Datagolf "How sharp are bookmakers?", Pinnacle docs.
 */

/**
 * Bereken overround (vig) voor een set odds.
 * vig = Σ(1/odd_i) - 1
 *
 * @param {number[]} odds
 * @returns {number|null} 0.05 = 5% vig, null bij invalid input
 */
function calcOverround(odds) {
  if (!Array.isArray(odds) || odds.length < 2) return null;
  let sum = 0;
  let valid = 0;
  for (const o of odds) {
    const v = Number(o);
    if (Number.isFinite(v) && v > 1) { sum += 1 / v; valid++; }
  }
  if (valid !== odds.length || sum <= 0) return null;
  return +(sum - 1).toFixed(5);
}

/**
 * Vergelijk overround van een soft-book met sharp anchor.
 * Returnt soft vig, sharp vig, en gap. Een positief `gapPct` betekent
 * soft-book heeft hogere marge (normaal). Negatief = soft-book scherper
 * dan sharp (zeldzaam, maar waardevol om te detecteren — kan duiden op
 * stale lijn op de sharp side).
 */
function compareOverrounds(softOddsArr, sharpOddsArr) {
  const soft = calcOverround(softOddsArr);
  const sharp = calcOverround(sharpOddsArr);
  if (soft === null || sharp === null) return null;
  return {
    softVig: soft,
    sharpVig: sharp,
    gapPct: +((soft - sharp) * 100).toFixed(2),
    softTighter: soft < sharp,
  };
}

/**
 * Identificeer per-outcome execution-edge: voor elke uitkomst, hoeveel
 * implieert een soft-book quote vs sharp consensus?
 *
 * Soft fair-prob (na devig) > sharp fair-prob (na devig) → soft-book
 * undervaluet die kant → execution edge bestaat als jij op die kant zet
 * (bookie ziet 'm hoger dan markt, dus jouw payout > fair).
 *
 * Wait, dat is omgekeerd: soft fair_p < sharp fair_p betekent dat soft-book
 * een lágere kans toekent (= hogere odd), terwijl sharp denkt dat de kans
 * hoger is. Dus jouw bet bij soft krijgt een prijs alsof de gebeurtenis
 * minder waarschijnlijk is dan het werkelijk is = execution edge voor jou.
 *
 * @param {object} args
 *   - softOdds: number[] — soft-book odds per outcome
 *   - sharpOdds: number[] — sharp anchor odds (Pinnacle/Betfair) per outcome
 *   - threshold: pp — alleen returnt outcomes met absolute gap >= threshold
 * @returns {object[]} [{outcomeIndex, softFair, sharpFair, gapPp, hasEdge, edgeDirection}]
 */
function findExecutionEdge({ softOdds, sharpOdds, threshold = 0.02 }) {
  const softFair = devigProportional(softOdds);
  const sharpFair = devigProportional(sharpOdds);
  if (!softFair || !sharpFair || softFair.length !== sharpFair.length) return [];
  const out = [];
  for (let i = 0; i < softFair.length; i++) {
    const gapPp = sharpFair[i] - softFair[i]; // positive = sharp denkt waarschijnlijker dan soft
    if (Math.abs(gapPp) < threshold) continue;
    out.push({
      outcomeIndex: i,
      softFair: +softFair[i].toFixed(4),
      sharpFair: +sharpFair[i].toFixed(4),
      gapPp: +gapPp.toFixed(4),
      // Edge bestaat als sharp denkt waarschijnlijker maar soft prijs is hoger
      // (= soft fair_p lager). Dat is precies positive gapPp.
      hasEdge: gapPp > 0,
      edgeDirection: gapPp > 0 ? 'soft_undervalues' : 'sharp_undervalues',
    });
  }
  return out;
}

module.exports = { calcOverround, compareOverrounds, findExecutionEdge };
