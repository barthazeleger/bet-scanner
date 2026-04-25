'use strict';

/**
 * v12.2.23 (R4 alerts): bepaal welke sharp-soft windows een push-alert
 * waardig zijn. Pure helper — caller doet supabase + push io.
 *
 * Regels:
 *   - alleen `soft_undervalues` (actionable kant)
 *   - gap >= minGapPp (default 4pp)
 *   - kickoff binnen maxKickoffHours (default 6u — geen alerts voor matches
 *     die nog 24u weg zijn; window kan nog veel bewegen)
 *   - dedupe: alertKey al in recentAlertKeys → skip
 *
 * @param {object} args
 *   - windows: Array van sharp-soft windows (zoals summarizeSharpSoftWindows returnt)
 *   - recentAlertKeys: Set<string> van keys die al verzonden zijn (uit notifications-tabel)
 *   - minGapPp: number (default 0.04)
 *   - maxKickoffHours: number (default 6)
 *   - now: number (Date.now() — injectable voor tests)
 * @returns {Array<{window, alertKey, title, body}>}
 */
function selectAlertableWindows(args) {
  const {
    windows = [],
    recentAlertKeys = new Set(),
    minGapPp = 0.04,
    maxKickoffHours = 6,
    now = Date.now(),
  } = args || {};

  const alertable = [];
  const cutoff = now + maxKickoffHours * 3600 * 1000;
  const set = recentAlertKeys instanceof Set ? recentAlertKeys : new Set();

  for (const w of windows) {
    if (!w || w.edgeDirection !== 'soft_undervalues') continue;
    if (Math.abs(w.gapPp) < minGapPp) continue;
    if (!w.kickoffIso) continue;
    const k = Date.parse(w.kickoffIso);
    if (!Number.isFinite(k) || k < now || k > cutoff) continue;
    const alertKey = buildAlertKey(w);
    if (set.has(alertKey)) continue;
    alertable.push({
      window: w,
      alertKey,
      title: 'Sharp-soft execution edge',
      body: formatBody(w),
    });
  }
  // Sort by absolute gap descending zodat de meest waardevolle eerst gaan
  alertable.sort((a, b) => Math.abs(b.window.gapPp) - Math.abs(a.window.gapPp));
  return alertable;
}

function buildAlertKey(w) {
  const linePart = w.line == null ? '' : `@${w.line}`;
  return `sharpsoft:${w.fixtureId}|${w.marketType}${linePart}|${w.outcome}`;
}

function formatBody(w) {
  const linePart = w.line == null ? '' : ` ${w.line}`;
  const gapStr = (w.gapPp * 100).toFixed(1);
  const kickoff = w.kickoffIso ? new Date(w.kickoffIso).toISOString().slice(11, 16) : '?';
  return `${w.fixtureName} · ${w.marketType}${linePart} ${w.outcome} @ ${w.softBookie} ${w.softOdd} (vs sharp ${w.sharpOdd}, +${gapStr}pp) · KO ${kickoff}`;
}

module.exports = { selectAlertableWindows, buildAlertKey, formatBody };
