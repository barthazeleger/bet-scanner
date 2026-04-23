'use strict';

const snap = require('../snapshots');
const { parseGameOdds } = require('../odds-parser');
const { resolveOddFromBookie } = require('../clv-match');
const { parseBetKickoff } = require('./bet-kickoff');

/**
 * v11.3.18 · Phase 6.2a: Polling + heartbeat schedulers extracted uit server.js.
 *
 * Factory pattern. Gebruik:
 *   const schedulers = createPollingSchedulers({ ... });
 *   schedulers.scheduleKickoffWindowPolling();
 *   schedulers.scheduleFixtureSnapshotPolling();
 *   schedulers.scheduleOddsMonitor();
 *   schedulers.scheduleScanHeartbeatWatcher();
 *
 * Verantwoordelijkheden:
 *   - scheduleKickoffWindowPolling — t-6h/1h/15m odds-snapshots per fixture (5 min loop).
 *   - scheduleFixtureSnapshotPolling — 90 min doorlopende odds-snapshot van upcoming fixtures.
 *   - scheduleOddsMonitor — 60 min drift-check over open bets, stuurt drift-alerts + bewaart dedup in calib.
 *   - scheduleScanHeartbeatWatcher — 14u-silence alert als er geen scan-tick in notifications komt.
 *
 * @param {object} deps
 *   - supabase
 *   - afGet                 — async (host, path, params) → any
 *   - sleep                 — fn (ms) → Promise
 *   - notify                — async (text, type?, userId?) → void
 *   - normalizeSport        — fn (sport) → string
 *   - getSportApiConfig     — fn (sport) → { host, oddsPath, fixtureParam }
 *   - loadCalibAsync        — async () → calib (warm cache, safe voor write-after-read)
 *   - saveCalib             — async (calib) → void
 *   - readBets              — async (userId) → { bets }
 *   - getAdminUserId        — async () → string
 * @returns {object} schedulers
 */
module.exports = function createPollingSchedulers(deps) {
  const {
    supabase, afGet, sleep, notify,
    normalizeSport, getSportApiConfig,
    loadCalibAsync, saveCalib,
    readBets, getAdminUserId,
  } = deps;

  const required = {
    supabase, afGet, sleep, notify,
    normalizeSport, getSportApiConfig,
    loadCalibAsync, saveCalib,
    readBets, getAdminUserId,
  };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createPollingSchedulers: missing required dep '${key}'`);
    }
  }

  function scheduleKickoffWindowPolling() {
    const INTERVAL_MS = 5 * 60 * 1000;
    const WINDOWS = [6 * 60, 60, 15];
    const TOLERANCE_MIN = 5;
    const _seen = new Map();

    async function runWindow() {
      try {
        const nowMs = Date.now();
        const horizonMs = nowMs + 7 * 3600 * 1000;
        const { data: fixtures } = await supabase.from('fixtures')
          .select('id, sport, start_time')
          .eq('status', 'scheduled')
          .gte('start_time', new Date(nowMs).toISOString())
          .lte('start_time', new Date(horizonMs).toISOString())
          .order('start_time', { ascending: true })
          .limit(80);
        if (!fixtures?.length) return;

        let snapshotted = 0;
        for (const fix of fixtures) {
          const koMs = new Date(fix.start_time).getTime();
          const minsToKo = (koMs - nowMs) / 60000;
          for (const targetMin of WINDOWS) {
            if (Math.abs(minsToKo - targetMin) > TOLERANCE_MIN) continue;
            const tag = `${targetMin}m`;
            if (!_seen.has(fix.id)) _seen.set(fix.id, new Set());
            if (_seen.get(fix.id).has(tag)) continue;
            _seen.get(fix.id).add(tag);
            try {
              const sport = normalizeSport(fix.sport);
              if (sport === 'football') continue;
              const cfg = getSportApiConfig(sport);
              const oddsResp = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: fix.id }).catch(() => []);
              if (!oddsResp?.length) continue;
              const parsed = parseGameOdds([oddsResp[0]], '', '');
              const rows = snap.flattenParsedOdds(parsed);
              if (rows.length) {
                await snap.writeOddsSnapshots(supabase, fix.id, rows);
                snapshotted++;
              }
            } catch { /* swallow */ }
          }
        }
        for (const [fid] of _seen) {
          const f = fixtures.find(x => x.id === fid);
          if (!f || new Date(f.start_time).getTime() < nowMs) _seen.delete(fid);
        }
        if (snapshotted) console.log(`📸 Kickoff-window snapshots: ${snapshotted} (t-6h/1h/15m windows)`);
      } catch { /* swallow */ }
    }

    setTimeout(() => {
      runWindow();
      setInterval(runWindow, INTERVAL_MS);
    }, 3 * 60 * 1000);
    console.log('📸 Kickoff-window polling actief (t-6h/1h/15m, elke 5 min)');
  }

  function scheduleFixtureSnapshotPolling() {
    const INTERVAL_MS = 90 * 60 * 1000;
    const MAX_PER_CYCLE = 30;
    const WINDOW_HOURS = 8;

    async function runPolling() {
      try {
        const nowIso = new Date().toISOString();
        const winIso = new Date(Date.now() + WINDOW_HOURS * 3600 * 1000).toISOString();
        const { data: fixtures, error } = await supabase
          .from('fixtures')
          .select('id, sport, start_time')
          .eq('status', 'scheduled')
          .gte('start_time', nowIso)
          .lte('start_time', winIso)
          .order('start_time', { ascending: true })
          .limit(MAX_PER_CYCLE);
        if (error || !fixtures?.length) return;

        console.log(`📸 Odds polling: ${fixtures.length} upcoming fixtures (komende ${WINDOW_HOURS}u)`);
        let snapshotted = 0;
        for (const fix of fixtures) {
          try {
            const sport = normalizeSport(fix.sport);
            const cfg = getSportApiConfig(sport);
            await sleep(150);
            const oddsResp = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: fix.id }).catch(() => []);
            if (!oddsResp?.length) continue;
            const first = oddsResp[0];
            if (sport === 'football') continue;
            const parsed = parseGameOdds([first], '', '');
            const rows = snap.flattenParsedOdds(parsed);
            if (!rows.length) continue;
            await snap.writeOddsSnapshots(supabase, fix.id, rows);
            snapshotted++;
          } catch { /* swallow */ }
        }
        if (snapshotted) console.log(`📸 ${snapshotted} odds-snapshots geschreven`);
      } catch (e) {
        console.error('Fixture snapshot polling fout:', e.message);
      }
    }

    setTimeout(() => {
      runPolling();
      setInterval(runPolling, INTERVAL_MS);
    }, 5 * 60 * 1000);
    console.log('📸 Fixture snapshot polling actief (start over 5 min, dan elke 90 min)');
  }

  function scheduleOddsMonitor() {
    const INTERVAL_MS = 60 * 60 * 1000;
    const RE_ALERT_DELTA = 0.03;
    const RE_ALERT_MIN_HOURS = 4;
    console.log('📈 Odds monitor actief (elke 60 min, persistent dedup via calib)');

    async function runOddsMonitor() {
      try {
        const calib = await loadCalibAsync();
        if (!calib || typeof calib !== 'object') return;
        calib.oddsAlerts = calib.oddsAlerts || {};

        const { bets } = await readBets(await getAdminUserId());
        const openBets = bets.filter(b => b.uitkomst === 'Open' && b.tijd);
        if (!openBets.length) return;

        const now = Date.now();
        let checksRun = 0;
        let dedupDirty = false;
        const MAX_CHECKS = 15;

        for (const bet of openBets) {
          if (checksRun >= MAX_CHECKS) break;

          // v11.3.23 C2: gebruik bet.datum + bet.tijd canonical via pure helper.
          const kickoffMs = parseBetKickoff(bet.datum, bet.tijd);
          if (!Number.isFinite(kickoffMs)) continue;

          const minsToKo = (kickoffMs - now) / 60000;
          if (minsToKo < 0 || minsToKo > 720) continue;

          const sport = normalizeSport(bet.sport || 'football');
          let fxId = bet.fixtureId;
          if (!fxId && sport === 'football') {
            const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' });
            const parts = (bet.wedstrijd || '').split(' vs ').map(s => s.trim().toLowerCase());
            if (parts.length >= 2) {
              const fixtures = await afGet('v3.football.api-sports.io', '/fixtures', { date: today });
              checksRun++;
              const match = (fixtures || []).find(f => {
                const h = (f.teams?.home?.name || '').toLowerCase();
                const a = (f.teams?.away?.name || '').toLowerCase();
                return (h.includes(parts[0]) || parts[0].includes(h.split(' ').pop())) &&
                       (a.includes(parts[1]) || parts[1].includes(a.split(' ').pop()));
              });
              if (match) fxId = match.fixture?.id;
            }
          }
          if (!fxId) continue;

          const cfg = getSportApiConfig(sport);
          const oddsData = await afGet(cfg.host, cfg.oddsPath, { [cfg.fixtureParam]: fxId });
          checksRun++;
          const rawBks   = oddsData?.[0]?.bookmakers || [];
          const userBk   = (bet.tip || 'bet365').toLowerCase();
          const bk       = rawBks.find(b => b.name?.toLowerCase().includes(userBk))
                        || rawBks.find(b => b.name?.toLowerCase().includes('bet365')) || rawBks[0];
          if (!bk) continue;

          let currentOdds = null;
          currentOdds = resolveOddFromBookie(bk, bet.markt || '', {
            matchName: bet.wedstrijd || '',
            sport,
          });

          if (!currentOdds) continue;

          const loggedOdds = parseFloat(bet.odds);
          const drift = (currentOdds - loggedOdds) / loggedOdds;
          const driftPct = (drift * 100).toFixed(1);

          if (Math.abs(drift) >= 0.05) {
            const direction = drift < 0 ? 'sharp' : 'fade';
            const prev = calib.oddsAlerts[bet.id];
            const driftChangedEnough = !prev || Math.abs(drift - prev.drift) >= RE_ALERT_DELTA;
            const directionFlipped   = prev && prev.direction !== direction;
            const longSincePrev      = prev && (now - prev.ts) >= RE_ALERT_MIN_HOURS * 60 * 60 * 1000;
            const shouldAlert        = !prev || directionFlipped || driftChangedEnough || longSincePrev;

            if (shouldAlert) {
              const alertTitle = direction === 'sharp' ? `📉 Odds-drift: scherp geld` : `📈 Odds-drift: markt draait`;
              const alertBody = direction === 'sharp'
                ? `${bet.wedstrijd} · ${bet.markt}\nGelogd: ${loggedOdds} → nu: ${currentOdds} (${driftPct}%)\nScherp geld bevestigt jouw kant.`
                : `${bet.wedstrijd} · ${bet.markt}\nGelogd: ${loggedOdds} → nu: ${currentOdds} (+${driftPct}%)\nMarkt draait van je af — overweeg cashout.`;
              await notify((direction === 'sharp'
                ? `📉 ODDS ALERT: ${bet.wedstrijd} ${bet.markt} | ${loggedOdds} → ${currentOdds} (${driftPct}%) | Scherp geld bevestigt jouw kant`
                : `📈 ODDS ALERT: ${bet.wedstrijd} ${bet.markt} | ${loggedOdds} → ${currentOdds} (+${driftPct}%) | Markt draait · overweeg cashout`
              )).catch(() => {});
              await supabase.from('notifications').insert({
                type: 'odds_drift', title: alertTitle, body: alertBody,
                read: false, user_id: null,
              }).then(() => {}, () => {});
              calib.oddsAlerts[bet.id] = { drift, direction, ts: now };
              dedupDirty = true;
            }
          }

          await sleep(150);
        }

        if (dedupDirty) {
          for (const k of Object.keys(calib.oddsAlerts)) {
            if (now - calib.oddsAlerts[k].ts > 24 * 60 * 60 * 1000) delete calib.oddsAlerts[k];
          }
          await saveCalib(calib);
        }
      } catch (err) {
        console.error('Odds monitor error:', err.message);
      }
    }

    setTimeout(() => {
      runOddsMonitor();
      setInterval(runOddsMonitor, INTERVAL_MS);
    }, 5 * 60 * 1000);
  }

  let _lastHeartbeatAlertAt = 0;
  async function runScanHeartbeatCheck() {
    try {
      const since = new Date(Date.now() - 14 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from('notifications')
        .select('created_at, type')
        .in('type', ['cron_tick', 'scan_end', 'unit_change'])
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1);
      if (error) return;
      const hasRecent = Array.isArray(data) && data.length > 0;
      if (hasRecent) return;
      const MIN_REALERT_MS = 24 * 60 * 60 * 1000;
      if (Date.now() - _lastHeartbeatAlertAt < MIN_REALERT_MS) return;
      _lastHeartbeatAlertAt = Date.now();
      notify(
        `🫀 SCANNER STIL\nGeen scan-tick in de notifications tabel sinds de laatste 14 uur.\nMogelijke oorzaken: scheduler gecrasht, Render keep-alive down, of Supabase unreachable.\nCheck server logs en /api/status.`,
        'heartbeat_miss'
      ).catch(() => {});
    } catch (e) {
      console.warn('[heartbeat] check failed:', e.message);
    }
  }
  function scheduleScanHeartbeatWatcher() {
    setTimeout(() => {
      runScanHeartbeatCheck();
      setInterval(runScanHeartbeatCheck, 60 * 60 * 1000);
    }, 30 * 60 * 1000);
  }

  return {
    scheduleKickoffWindowPolling,
    scheduleFixtureSnapshotPolling,
    scheduleOddsMonitor,
    scheduleScanHeartbeatWatcher,
    runScanHeartbeatCheck,
  };
};
