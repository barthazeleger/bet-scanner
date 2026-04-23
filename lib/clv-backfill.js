'use strict';

const { marketKeyFromBetMarkt } = require('./clv-match');

/**
 * Fallback CLV lookup via odds_snapshots wanneer live `fetchCurrentOdds` faalt
 * (match is afgelopen → api-sports geeft geen odds meer; of strictBookie match
 * vindt preferred bookie niet meer in response).
 *
 * Probeerslagen in volgorde:
 *   1. Preferred bookie (de bookie die bij de bet is gelogd) → snapshot-preferred
 *   2. Pinnacle / Betfair (sharp anchor) → snapshot-sharp
 *   3. Laatste snapshot van welke bookie dan ook → snapshot-any
 *
 * snapshot-any bewijst dat er ergens odds zijn vastgelegd, maar de CLV-vergelijking
 * is dan minder zuiver (andere bookie dan waar bet is geplaatst). Resultaat heeft
 * `sourceType` field zodat operator later kan filteren.
 *
 * @param {object} supabase — Supabase client / mock
 * @param {object} args { fixtureId, markt, preferredBookie, matchName }
 * @returns {Promise<{closingOdds: number, bookieUsed: string, sourceType: string} | null>}
 */
async function fetchSnapshotClosing(supabase, args = {}) {
  if (!supabase || typeof supabase.from !== 'function') return null;
  const { fixtureId, markt, preferredBookie = '', matchName = '' } = args;
  if (!fixtureId || !markt) return null;
  const mapped = marketKeyFromBetMarkt(markt, { matchName });
  if (!mapped || !mapped.market_type || !mapped.selection_key) return null;

  try {
    let query = supabase
      .from('odds_snapshots')
      .select('bookmaker, odds, line, captured_at')
      .eq('fixture_id', fixtureId)
      .eq('market_type', mapped.market_type)
      .eq('selection_key', mapped.selection_key)
    if (mapped.line !== null && mapped.line !== undefined) {
      query = query.eq('line', mapped.line);
    }
    const { data, error } = await query
      .order('captured_at', { ascending: false })
      .limit(50);
    if (error || !Array.isArray(data) || data.length === 0) return null;

    const rowOdds = (row) => {
      const v = parseFloat(row?.odds);
      return Number.isFinite(v) && v > 1 ? +v.toFixed(3) : null;
    };

    const lowerPref = String(preferredBookie || '').toLowerCase();
    if (lowerPref) {
      const preferredRow = data.find(r => {
        const book = String(r.bookmaker || '').toLowerCase();
        return book === lowerPref || book.includes(lowerPref) || lowerPref.includes(book);
      });
      const val = rowOdds(preferredRow);
      if (val) return { closingOdds: val, bookieUsed: preferredRow.bookmaker, sourceType: 'snapshot-preferred' };
    }

    // Sharp anchor: Pinnacle (primary) of Betfair (secondary).
    const sharp = data.find(r => /pinnacle/i.test(r.bookmaker || ''))
               || data.find(r => /betfair/i.test(r.bookmaker || ''));
    const sharpVal = rowOdds(sharp);
    if (sharpVal) return { closingOdds: sharpVal, bookieUsed: sharp.bookmaker, sourceType: 'snapshot-sharp' };

    // Last resort: newest snapshot van welke bookie dan ook.
    for (const row of data) {
      const val = rowOdds(row);
      if (val) return { closingOdds: val, bookieUsed: row.bookmaker, sourceType: 'snapshot-any' };
    }
    return null;
  } catch (e) {
    console.warn('[clv-backfill] fetchSnapshotClosing failed:', e?.message || e);
    return null;
  }
}

module.exports = { fetchSnapshotClosing };
