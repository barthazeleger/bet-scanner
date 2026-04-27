'use strict';

/**
 * EdgePickr v12.4.2 — Bookie audit helper.
 *
 * Vergelijkt een gekozen pick-quote tegen de wider pool van quotes die een
 * upstream filter (scope-detect, blacklist, preferred-only etc.) heeft
 * uitgesloten. Als een uitgesloten quote materieel beter is dan de gekozen,
 * returnt het de "winning rejected" zodat caller een inbox-warning kan
 * emit'ten zonder zelf de pick te wijzigen.
 *
 * Doctrine: een filter mag picks nooit stilletjes downgrade'n. Of we
 * vertrouwen het filter (en de uitgesloten quote is terecht weg), of het
 * filter mist iets en de operator moet weten welk patroon ze niet ziet.
 *
 * Niet-doel: settlement-correct kiezen welke quote daadwerkelijk veilig is
 * — dat blijft de verantwoordelijkheid van de filter (HOCKEY_60MIN_BOOKIES
 * etc.). Dit is alleen zichtbaarheid op de gap.
 */

/**
 * @param {Array} all      Alle quotes in dezelfde bucket (bv. team=home,
 *                          side=over, point=2.5).
 * @param {Function} isAllowed  Filter-predicate die quote → boolean returnt.
 *                          Quotes waarvoor isAllowed=false zijn de "rejected"
 *                          set die we audit'en.
 * @param {number} chosenPrice  Prijs van de gekozen pick (bv. bestFromArr().price).
 * @param {object} opts
 *   - thresholdPct: minimum gap als verhouding (default 0.03 = 3%).
 *                   Onder de drempel: ruis, niet melden.
 *   - maxPrice:     prijs-cap waarboven we niet vergelijken (longshot-quotes
 *                   zijn meestal onbetrouwbaar/illiquid en niet representatief).
 * @returns {{bookie:string,price:number,scope:string,gapPct:number}|null}
 *           null als er geen anomaly is (geen rejected, of gap onder drempel).
 */
function findRejectedBetterQuote(all, isAllowed, chosenPrice, opts = {}) {
  const thresholdPct = Number.isFinite(opts.thresholdPct) ? opts.thresholdPct : 0.03;
  const maxPrice = Number.isFinite(opts.maxPrice) ? opts.maxPrice : null;
  if (!Array.isArray(all) || all.length === 0) return null;
  if (typeof isAllowed !== 'function') return null;
  if (!Number.isFinite(chosenPrice) || chosenPrice <= 0) return null;
  const rejected = all.filter(o => o && Number.isFinite(o.price) && o.price > 0 && !isAllowed(o));
  if (!rejected.length) return null;
  const inBudget = maxPrice != null ? rejected.filter(o => o.price <= maxPrice) : rejected;
  if (!inBudget.length) return null;
  const winner = inBudget.reduce(
    (best, o) => (o.price > best.price ? o : best),
    { price: 0, bookie: '', scope: 'unknown' }
  );
  if (!winner.bookie) return null;
  const gap = (winner.price - chosenPrice) / chosenPrice;
  if (gap < thresholdPct) return null;
  return {
    bookie: winner.bookie,
    price: +winner.price.toFixed(3),
    scope: winner.scope || 'unknown',
    gapPct: +(gap * 100).toFixed(1),
  };
}

module.exports = { findRejectedBetterQuote };
