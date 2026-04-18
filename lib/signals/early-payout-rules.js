'use strict';

/**
 * Early-payout regels per bookie, genormaliseerd voor runtime lookups.
 *
 * Structuur: `EARLY_PAYOUT_RULES[bookie][sport][market_type]` → rule-object of null.
 *
 * Rule-object velden:
 *   - leadType: 'goals' | 'runs' | 'points' | 'sets' | null
 *   - leadThreshold: number (bv. 2 voor 2-goal lead, 5 voor 5-run lead)
 *   - appliesToSelections: array van selection_key strings (bv. ['home','away'])
 *   - note: korte toelichting voor audit/UI
 *
 * Alleen bevestigde regels staan hier; 'verify' entries in EARLY_PAYOUT_RULES.md
 * zijn bewust weggelaten tot operator ze rigoureus heeft bevestigd. Shadow-mode
 * logging gebruikt alleen `applies=true` rules — onbekende bookies = no-op.
 *
 * Bron: docs/EARLY_PAYOUT_RULES.md (gecached 2026-04-18). Update synchroon bij
 * promo-wijzigingen.
 */

const EARLY_PAYOUT_RULES = Object.freeze({
  bet365: Object.freeze({
    football: Object.freeze({
      moneyline: { leadType: 'goals', leadThreshold: 2, appliesToSelections: ['home', 'away'], note: '2 Goals Ahead' },
      dnb:       { leadType: 'goals', leadThreshold: 2, appliesToSelections: ['home', 'away'], note: '2 Goals Ahead (DNB)' },
    }),
    baseball: Object.freeze({
      moneyline: { leadType: 'runs', leadThreshold: 5, appliesToSelections: ['home', 'away'], note: '5 Run Lead' },
    }),
    basketball: Object.freeze({
      moneyline: { leadType: 'points', leadThreshold: 20, appliesToSelections: ['home', 'away'], note: '20 Point Lead (regular season)' },
    }),
    hockey: Object.freeze({
      moneyline: { leadType: 'goals', leadThreshold: 3, appliesToSelections: ['home', 'away'], note: '3 Goal Lead' },
    }),
    'american-football': Object.freeze({
      moneyline: { leadType: 'points', leadThreshold: 17, appliesToSelections: ['home', 'away'], note: '17 Point Lead (regular season)' },
    }),
  }),
  // Alle andere bookies: default pure-FT settlement. Geen entries = no EP rule.
});

/**
 * Lookup helper. Case-insensitive bookie/sport match.
 *
 * @param {string} bookie
 * @param {string} sport — 'football' | 'baseball' | 'basketball' | 'hockey' | 'american-football'
 * @param {string} marketType — 'moneyline' | 'dnb' | etc.
 * @returns {object|null}
 */
function getEarlyPayoutRule(bookie, sport, marketType) {
  if (!bookie || !sport || !marketType) return null;
  const bk = String(bookie).toLowerCase();
  const sp = String(sport).toLowerCase();
  const mk = String(marketType).toLowerCase();
  const bookieRules = EARLY_PAYOUT_RULES[bk];
  if (!bookieRules) return null;
  const sportRules = bookieRules[sp];
  if (!sportRules) return null;
  return sportRules[mk] || null;
}

/**
 * Heeft een bookie ooit EP-regels voor ENIGE (sport, market)?
 * Handig voor UI: toon EP-badge alleen als de bookie überhaupt relevant is.
 */
function bookieHasAnyEarlyPayoutRules(bookie) {
  if (!bookie) return false;
  return Boolean(EARLY_PAYOUT_RULES[String(bookie).toLowerCase()]);
}

module.exports = {
  EARLY_PAYOUT_RULES,
  getEarlyPayoutRule,
  bookieHasAnyEarlyPayoutRules,
};
