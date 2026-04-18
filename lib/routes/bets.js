'use strict';

const express = require('express');

/**
 * v11.2.6 · Phase 5.4d: Bets read/delete routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createBetsRouter({...}))`.
 *
 * Verantwoordelijkheden in dit module:
 *   - GET    /api/bets              — lijst bets + stats (admin optioneel ?all=true)
 *   - GET    /api/bets/correlations — groep open bets op wedstrijd · correlatie-risk
 *   - DELETE /api/bets/:id          — bet verwijderen (rate-limited, user-scoped)
 *
 * Write-endpoints (POST/PUT/recalculate/current-odds) zijn in v11.3.10 · Phase 5.4r
 * verhuisd naar `lib/routes/bets-write.js` (eigen factory).
 *
 * @param {object} deps
 *   - readBets         — async (userId) → { bets, stats, _raw }
 *   - deleteBet        — async (betId, userId) → void
 *   - loadUsers        — async () → array
 *   - calcStats        — fn (bets, startBankroll, unitEur) → stats
 *   - rateLimit        — fn (key, maxCount, windowMs) → boolean
 *   - defaultStartBankroll — number (fallback)
 *   - defaultUnitEur       — number (fallback)
 * @returns {express.Router}
 */
module.exports = function createBetsRouter(deps) {
  const { readBets, deleteBet, loadUsers, calcStats, rateLimit, defaultStartBankroll, defaultUnitEur } = deps;

  const required = { readBets, deleteBet, loadUsers, calcStats, rateLimit };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createBetsRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/bets', async (req, res) => {
    try {
      // Admin can see all data with ?all=true
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const { bets, _raw } = await readBets(userId);
      // User-specifieke start-bankroll + unit voor stats (fallback: env defaults).
      const users = await loadUsers().catch(() => []);
      const user  = users.find(u => u.id === req.user?.id);
      const sb = user?.settings?.startBankroll ?? defaultStartBankroll;
      const ue = user?.settings?.unitEur       ?? defaultUnitEur;
      res.json({ bets, stats: calcStats(bets, sb, ue), _raw });
    }
    catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  // Correlated bets · groepen open bets op dezelfde wedstrijd
  router.get('/bets/correlations', async (req, res) => {
    try {
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      const { bets } = await readBets(userId);
      const openBets = bets.filter(b => b.uitkomst === 'Open');
      const groups = {};
      openBets.forEach(b => {
        const key = b.wedstrijd.toLowerCase().trim();
        if (!groups[key]) groups[key] = [];
        groups[key].push(b);
      });
      const correlated = Object.entries(groups)
        .filter(([_, g]) => g.length > 1)
        .map(([match, g]) => ({
          match,
          bets: g.map(b => ({ id: b.id, markt: b.markt, odds: b.odds, units: b.units })),
          totalExposure: g.reduce((s, b) => s + b.inzet, 0),
          warning: `${g.length} bets op dezelfde wedstrijd · gecorreleerd risico €${g.reduce((s,b) => s + b.inzet, 0).toFixed(2)}`
        }));
      res.json({ correlations: correlated });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.delete('/bets/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (rateLimit('betwrite:' + userId, 60, 60 * 1000)) return res.status(429).json({ error: 'Te veel bet-writes · wacht een minuut' });
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });
      await deleteBet(id, userId);
      res.json(await readBets(userId));
    }
    catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  return router;
};
