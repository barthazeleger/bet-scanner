'use strict';

const express = require('express');

/**
 * v11.2.8 · Phase 5.4f: Picks-read routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createPicksRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/picks         — huidige in-memory prematch + live picks (model-internals admin-only)
 *   - GET /api/scan-history  — laatste N scans uit scan_history tabel
 *
 * Security: non-admin users krijgen een public-safe veldset (geen reason/kelly/
 * ep/strength/expectedEur/signals/scanType) zodat model-internals niet lekken.
 *
 * NIET in scope (complex deps): /api/potd (POTD-generator met record-lookup)
 * en /api/analyze (natural-language parser).
 *
 * @param {object} deps
 *   - supabase              — Supabase client
 *   - isValidUuid           — (s) → boolean
 *   - getLastPrematchPicks  — () → array (module-level state getter)
 *   - getLastLivePicks      — () → array
 *   - loadScanHistoryFromSheets — async () → array
 *   - loadScanHistory       — () → array (local fallback)
 *   - scanHistoryMax        — number (N rows limit)
 * @returns {express.Router}
 */

// Pure helpers voor safe projectie (geen model-internals naar non-admin).
const PUBLIC_PICK_FIELDS = ['match', 'league', 'label', 'odd', 'units', 'prob', 'edge', 'score', 'kickoff', 'bookie', 'sport', 'selected', 'audit'];

function safePick(p, isAdmin) {
  if (isAdmin) return p;
  const out = {};
  for (const k of PUBLIC_PICK_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  return out;
}

function safePicksList(picks, isAdmin) {
  return (picks || []).map(p => safePick(p, isAdmin));
}

module.exports = function createPicksRouter(deps) {
  const {
    supabase,
    isValidUuid,
    getLastPrematchPicks,
    getLastLivePicks,
    loadScanHistoryFromSheets,
    loadScanHistory,
    scanHistoryMax = 10,
  } = deps;

  const required = { supabase, isValidUuid, getLastPrematchPicks, getLastLivePicks, loadScanHistoryFromSheets, loadScanHistory };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createPicksRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/picks', (req, res) => {
    // SECURITY: model-internals (reason, kelly, ep, strength, expectedEur, signals) alleen admin.
    const isAdmin = req.user?.role === 'admin';
    res.json({
      prematch: safePicksList(getLastPrematchPicks(), isAdmin),
      live:     safePicksList(getLastLivePicks(), isAdmin),
    });
  });

  router.get('/scan-history', async (req, res) => {
    // v10.8.12: expliciet no-store zodat browser/CDN nooit een stale response
    // cached — auto-refresh zou anders oude picks blijven zien.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const isAdmin = req.user?.role === 'admin';
    try {
      let query = supabase.from('scan_history').select('*')
        .order('ts', { ascending: false }).limit(scanHistoryMax);
      if (!isAdmin && req.user?.id) {
        if (isValidUuid(req.user.id)) query = query.or(`user_id.eq.${req.user.id},user_id.is.null`);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      const history = (data || []).map(r => ({
        ts: r.ts, type: r.type, totalEvents: r.total_events,
        picks: safePicksList(r.picks || [], isAdmin),
      }));
      return res.json(history);
    } catch (e) {
      console.error('scan-history query fout:', e.message);
      const raw = await loadScanHistoryFromSheets().catch(() => loadScanHistory());
      const filtered = (raw || []).map(r => ({ ...r, picks: safePicksList(r.picks || [], isAdmin) }));
      res.json(filtered);
    }
  });

  return router;
};

// Export helpers ook standalone voor tests + hergebruik (potd/analyze in server.js)
module.exports.safePick = safePick;
module.exports.safePicksList = safePicksList;
module.exports.PUBLIC_PICK_FIELDS = PUBLIC_PICK_FIELDS;
