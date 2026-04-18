'use strict';

const express = require('express');

/**
 * v11.3.10 · Phase 5.4r: Bets write routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createBetsWriteRouter({...}))`.
 *
 * Endpoints:
 *   - POST /api/bets                  — nieuwe bet + CLV/pre-kickoff scheduling
 *   - PUT  /api/bets/:id              — outcome/odds/units/sport/tip update + wl-recompute
 *   - POST /api/bets/recalculate      — admin: bulk wl-recompute over settled bets
 *   - GET  /api/bets/:id/current-odds — preferred-bookie odds refresh + drift
 *
 * @param {object} deps
 *   - supabase
 *   - rateLimit                 — fn (key, maxCount, windowMs) → boolean
 *   - requireAdmin              — Express middleware
 *   - readBets                  — async (userId) → { bets, stats }
 *   - writeBet                  — async (bet, userId) → void
 *   - updateBetOutcome          — async (id, uitkomst, userId) → void
 *   - getUserUnitEur            — async (userId) → number
 *   - loadUsers                 — async () → users[]
 *   - calcStats                 — fn (bets, sb, ue) → stats
 *   - defaultStartBankroll      — number fallback
 *   - defaultUnitEur            — number fallback
 *   - schedulePreKickoffCheck   — async (bet) → void
 *   - scheduleCLVCheck          — async (bet) → void
 *   - afGet                     — async (host, path, params) → any
 *   - marketKeyFromBetMarkt     — fn (markt) → { market_type, selection_key }
 * @returns {express.Router}
 */
module.exports = function createBetsWriteRouter(deps) {
  const {
    supabase,
    rateLimit,
    requireAdmin,
    readBets,
    writeBet,
    updateBetOutcome,
    getUserUnitEur,
    loadUsers,
    calcStats,
    defaultStartBankroll,
    defaultUnitEur,
    schedulePreKickoffCheck,
    scheduleCLVCheck,
    afGet,
    marketKeyFromBetMarkt,
  } = deps;

  const required = {
    supabase, rateLimit, requireAdmin, readBets, writeBet, updateBetOutcome,
    getUserUnitEur, loadUsers, calcStats,
    schedulePreKickoffCheck, scheduleCLVCheck, afGet, marketKeyFromBetMarkt,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createBetsWriteRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.post('/bets', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (rateLimit('betwrite:' + userId, 60, 60 * 1000)) return res.status(429).json({ error: 'Te veel bet-writes · wacht een minuut' });
      const body = req.body || {};
      if (!body.wedstrijd || typeof body.wedstrijd !== 'string') return res.status(400).json({ error: 'Wedstrijd is verplicht' });
      if (!body.markt || typeof body.markt !== 'string') return res.status(400).json({ error: 'Markt is verplicht' });
      const odds = parseFloat(body.odds);
      if (isNaN(odds) || odds <= 1.0) return res.status(400).json({ error: 'Odds moeten hoger zijn dan 1.0' });
      const units = parseFloat(body.units);
      if (isNaN(units) || units <= 0) return res.status(400).json({ error: 'Units moeten hoger zijn dan 0' });
      const VALID_OUTCOMES = new Set(['Open', 'W', 'L']);
      if (body.uitkomst && !VALID_OUTCOMES.has(body.uitkomst)) return res.status(400).json({ error: 'Uitkomst moet Open, W of L zijn' });

      if (body.datum && body.tijd) {
        const tijdH = parseInt(body.tijd.split(':')[0]);
        if (!isNaN(tijdH) && tijdH >= 0 && tijdH < 10) {
          const todayAms = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
          const datumParts = body.datum.match(/^(\d{2})-(\d{2})-(\d{4})$/);
          if (datumParts) {
            const datumISO = `${datumParts[3]}-${datumParts[2]}-${datumParts[1]}`;
            if (datumISO === todayAms) {
              const tomorrowAms = new Date(Date.now() + 86400000).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
              const [y, m, d] = tomorrowAms.split('-');
              body.datum = `${d}-${m}-${y}`;
            }
          }
        }
      }

      const { bets } = await readBets(userId);
      const nextId = bets.length > 0 ? Math.max(...bets.map(b => b.id)) + 1 : 1;
      const newBet = { ...body, id: nextId, odds, units, uitkomst: body.uitkomst || 'Open' };
      await writeBet(newBet, userId);
      schedulePreKickoffCheck(newBet).catch(e => console.warn(`[pre-kickoff] schedule failed voor bet ${newBet?.id}:`, e?.message || e));
      scheduleCLVCheck(newBet).catch(e => console.warn(`[CLV] schedule failed voor bet ${newBet?.id}:`, e?.message || e));
      const result = await readBets(userId);

      const newMatch = (newBet.wedstrijd || '').toLowerCase().trim();
      if (newMatch) {
        const openOnSame = result.bets.filter(b =>
          b.uitkomst === 'Open' && b.id !== nextId &&
          b.wedstrijd.toLowerCase().trim() === newMatch
        );
        if (openOnSame.length > 0) {
          const allOnMatch = [newBet, ...openOnSame];
          const totalExposure = allOnMatch.reduce((s, b) => s + (b.inzet || (b.units || 0) * 10), 0);
          result.correlationWarning = {
            match: newBet.wedstrijd,
            count: allOnMatch.length,
            bets: allOnMatch.map(b => ({ id: b.id, markt: b.markt || '', odds: b.odds || b.odd || 0 })),
            totalExposure,
            message: `${allOnMatch.length} bets op ${newBet.wedstrijd} · gecorreleerd risico €${totalExposure.toFixed(2)}`
          };
        }
      }
      res.json(result);
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.put('/bets/:id', async (req, res) => {
    try {
      const userId = req.user?.id;
      if (rateLimit('betwrite:' + userId, 60, 60 * 1000)) return res.status(429).json({ error: 'Te veel bet-writes · wacht een minuut' });
      const { uitkomst, odds, units, tip, sport } = req.body || {};
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });
      if (uitkomst && !['Open', 'W', 'L'].includes(uitkomst)) return res.status(400).json({ error: 'Uitkomst moet Open, W of L zijn' });
      const ALLOWED_SPORTS = new Set(['football','basketball','hockey','baseball','american-football','handball']);
      if (sport != null && !ALLOWED_SPORTS.has(String(sport))) return res.status(400).json({ error: 'Ongeldige sport' });
      const updates = {};
      const userUe = await getUserUnitEur(userId);
      if (odds != null) updates.odds = parseFloat(odds);
      if (units != null) { updates.units = parseFloat(units); updates.inzet = +(parseFloat(units) * userUe).toFixed(2); }
      if (tip) updates.tip = tip;
      if (sport) updates.sport = sport;
      if (req.body.score === null || typeof req.body.score === 'number') {
        updates.score = req.body.score;
      }
      if (Object.keys(updates).length) {
        let updateQuery = supabase.from('bets').update(updates).eq('bet_id', id);
        if (userId) updateQuery = updateQuery.eq('user_id', userId);
        await updateQuery;
      }
      if (uitkomst) {
        await updateBetOutcome(id, uitkomst, userId);
      } else if (odds != null || units != null) {
        let readQ = supabase.from('bets').select('*').eq('bet_id', id);
        if (userId) readQ = readQ.eq('user_id', userId);
        const { data: row } = await readQ.single();
        if (row && (row.uitkomst === 'W' || row.uitkomst === 'L')) {
          const newInzet = row.inzet != null ? row.inzet : +((row.units || 0) * userUe).toFixed(2);
          const newWl = row.uitkomst === 'W'
            ? +((row.odds - 1) * newInzet).toFixed(2)
            : +(-newInzet).toFixed(2);
          let wlQ = supabase.from('bets').update({ wl: newWl }).eq('bet_id', id);
          if (userId) wlQ = wlQ.eq('user_id', userId);
          await wlQ;
        }
      }
      res.json(await readBets(userId));
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.post('/bets/recalculate', requireAdmin, async (req, res) => {
    try {
      let fixed = 0;
      const userId = req.user?.role === 'admin' && req.query.all ? null : req.user?.id;
      let settledQuery = supabase.from('bets').select('*').in('uitkomst', ['W', 'L']);
      if (userId) settledQuery = settledQuery.eq('user_id', userId);
      const { data: settledBets } = await settledQuery;
      const recalcUe = await getUserUnitEur(userId);
      for (const bet of (settledBets || [])) {
        const inzet = bet.inzet || +(bet.units * recalcUe).toFixed(2);
        const wl = bet.uitkomst === 'W' ? +((bet.odds-1)*inzet).toFixed(2) : +(-inzet).toFixed(2);
        if (Math.abs((bet.wl || 0) - wl) >= 0.01) {
          await supabase.from('bets').update({ wl }).eq('bet_id', bet.bet_id);
          fixed++;
        }
      }
      const { bets } = await readBets(userId);
      const users = await loadUsers().catch(() => []);
      const user  = users.find(u => u.id === req.user?.id);
      const sb = user?.settings?.startBankroll ?? defaultStartBankroll;
      const ue = user?.settings?.unitEur       ?? defaultUnitEur;
      res.json({ fixed, bets, stats: calcStats(bets, sb, ue) });
    } catch (e) { res.status(500).json({ error: 'Interne fout' }); }
  });

  router.get('/bets/:id/current-odds', async (req, res) => {
    try {
      const userId = req.user?.id;
      const id = parseInt(req.params.id);
      if (isNaN(id) || id <= 0) return res.status(400).json({ error: 'Ongeldig ID' });
      if (rateLimit('currentodds:' + userId, 30, 60 * 1000)) return res.status(429).json({ error: 'Te veel refreshes · wacht een minuut' });
      let betQuery = supabase.from('bets').select('*').eq('bet_id', id);
      if (userId) betQuery = betQuery.eq('user_id', userId);
      const { data: bet, error: betErr } = await betQuery.single();
      if (betErr || !bet) return res.status(404).json({ error: 'Bet niet gevonden' });
      if (!bet.fixture_id) return res.json({ note: 'Geen fixture_id gekoppeld aan deze bet; huidige odds niet opvraagbaar.', canRefresh: false });
      if (bet.uitkomst === 'W' || bet.uitkomst === 'L') {
        return res.json({ note: 'Bet is al settled; current-odds refresh wordt overgeslagen.', canRefresh: false });
      }
      const sport = (bet.sport || 'football').toLowerCase();
      const hostMap = {
        football: { host: 'v3.football.api-sports.io', path: '/odds' },
        basketball: { host: 'v1.basketball.api-sports.io', path: '/odds' },
        hockey: { host: 'v1.hockey.api-sports.io', path: '/odds' },
        baseball: { host: 'v1.baseball.api-sports.io', path: '/odds' },
        'american-football': { host: 'v1.american-football.api-sports.io', path: '/odds' },
        handball: { host: 'v1.handball.api-sports.io', path: '/odds' },
      };
      const cfg = hostMap[sport];
      if (!cfg) return res.status(400).json({ error: `Sport '${sport}' heeft geen odds-endpoint` });
      const users = await loadUsers().catch(() => []);
      const u = users.find(x => x.id === userId);
      const preferred = Array.isArray(u?.settings?.preferredBookies) && u.settings.preferredBookies.length
        ? u.settings.preferredBookies.map(x => String(x).toLowerCase())
        : ['bet365', 'unibet'];
      const oddsResp = await afGet(cfg.host, cfg.path, { fixture: bet.fixture_id });
      if (!oddsResp?.length) return res.json({ note: 'Geen odds beschikbaar bij api-sports', canRefresh: true });
      const bookmakers = oddsResp[0]?.bookmakers || [];
      const preferredBks = bookmakers.filter(b => preferred.some(p => String(b.name || '').toLowerCase().includes(p)));
      const searchBks = preferredBks.length ? preferredBks : bookmakers;
      const mapped = marketKeyFromBetMarkt(bet.markt || '');
      if (!mapped?.market_type || !mapped?.selection_key) {
        return res.json({ note: 'Markt niet mappable voor odds-refresh', canRefresh: true, marketRaw: bet.markt });
      }
      let best = { price: 0, bookie: null };
      for (const bk of searchBks) {
        for (const betDef of (bk.bets || [])) {
          for (const val of (betDef.values || [])) {
            const rawName = String(val.value || '').toLowerCase();
            const price = parseFloat(val.odd);
            if (!Number.isFinite(price) || price <= 1.0) continue;
            const match = rawName === mapped.selection_key
              || (mapped.selection_key === 'home' && rawName === 'home')
              || (mapped.selection_key === 'away' && rawName === 'away')
              || (mapped.selection_key === 'draw' && rawName === 'draw')
              || (mapped.selection_key === 'yes' && /^yes/.test(rawName))
              || (mapped.selection_key === 'no' && /^no/.test(rawName))
              || (mapped.selection_key === 'over' && /over/.test(rawName))
              || (mapped.selection_key === 'under' && /under/.test(rawName));
            if (match && price > best.price) {
              best = { price: +price.toFixed(3), bookie: bk.name };
            }
          }
        }
      }
      if (best.price <= 0) return res.json({ note: 'Markt niet gevonden in huidige odds-response', canRefresh: true });
      const logged = parseFloat(bet.odds);
      const deltaAbs = +(best.price - logged).toFixed(3);
      const deltaPct = logged > 0 ? +((best.price - logged) / logged * 100).toFixed(2) : null;
      const impliedLogged = logged > 0 ? +(1 / logged).toFixed(4) : null;
      const impliedCurrent = best.price > 0 ? +(1 / best.price).toFixed(4) : null;
      const direction = deltaAbs > 0 ? 'lengthened' : deltaAbs < 0 ? 'shortened' : 'flat';
      const preferredMatch = preferredBks.some(b => String(b.name || '').toLowerCase() === String(best.bookie || '').toLowerCase());
      res.json({
        canRefresh: true,
        fixtureId: bet.fixture_id,
        loggedOdds: logged,
        loggedBookie: bet.tip || null,
        currentOdds: best.price,
        currentBookie: best.bookie,
        currentFromPreferred: preferredMatch,
        deltaAbs,
        deltaPct,
        direction,
        impliedLogged,
        impliedCurrent,
      });
    } catch (e) {
      console.error('current-odds error:', e.message);
      res.status(500).json({ error: 'Interne fout · check server logs' });
    }
  });

  return router;
};
