'use strict';

/**
 * EdgePickr Playability Matrix (sectie 6 Bouwvolgorde, sectie 10.A doctrine).
 *
 * Pure assessor: bepaalt per `(sport, market_type)` of Bart een markt kan
 * spelen, hoe rijk de ondersteunende data is, en hoe goed de markt-structuur.
 * Deze module BESLIST niks zelf — hij levert signalen aan pick-ranking,
 * execution-gate en roadmap-prio. Geen API-calls, geen side-effects.
 *
 * Drie aparte assen, niet samengeklapt:
 *   - executable: kan Bart dit nu werkelijk spelen op B365/Unibet?
 *   - dataRich:   hebben we voldoende bronondersteuning (injuries/lineups/
 *                 starters/goalie-preview/weather etc.) voor dit market-type?
 *   - lineQuality: marktstructuur — bookmaker-count, overround-kwaliteit
 *
 * `playable` is een bewuste aggregatie van alleen executable + lineQuality,
 * NIET dataRich — omdat een markt speelbaar kan zijn met dunne enrichment
 * (Codex-review v10.10.14). `dataRich` beïnvloedt confidence/ranking/roadmap
 * apart, niet een hard skip.
 *
 * Callers leveren wat ze weten. Onbekende velden → safe defaults.
 */

const { supportsApiSportsInjuries, detectApiSportsFamily } = require('./api-sports-capabilities');

const KNOWN_SPORTS = new Set(['football', 'basketball', 'hockey', 'baseball', 'american-football', 'handball']);

// Market-type families die EdgePickr intern gebruikt (consistent met
// lib/odds-parser market_type values + server.js sport-scan routes).
const KNOWN_MARKETS = new Set([
  'moneyline', 'threeway', '1x2', 'total', 'spread', 'btts', 'dnb',
  'double_chance', 'half_ml', 'half_total', 'half_spread',
  'team_total_home', 'team_total_away', 'nrfi', 'odd_even',
  'f5_ml', 'f5_total', 'f5_spread',
]);

// Welke data-bronnen zijn sport-markt-relevant? Per (sport, market_type)
// een expliciete lijst — als ≥ 1 bron bekend en actief is, wordt de markt
// data-rich genoemd. Bewust conservatief: ontbrekende vermelding = dataRich
// onbekend (returnt false, met note).
const RELEVANT_FEEDS = {
  // Voetbal: injuries + lineups + referees + weather (outdoor) ondersteunen
  // vrijwel alle hoofd-markten.
  football: {
    moneyline:     ['injuries', 'lineups'],
    '1x2':         ['injuries', 'lineups'],
    threeway:      ['injuries', 'lineups'],
    total:         ['injuries', 'lineups', 'weather'],
    spread:        ['injuries', 'lineups'],
    btts:          ['injuries', 'lineups'],
    dnb:           ['injuries', 'lineups'],
    double_chance: ['injuries', 'lineups'],
    half_ml:       ['injuries', 'lineups'],
    half_total:    ['injuries', 'lineups'],
  },
  hockey: {
    moneyline:  ['goalie_preview'],
    threeway:   ['goalie_preview'],
    total:      ['goalie_preview'],
    spread:     ['goalie_preview'],
    team_total_home: ['goalie_preview'],
    team_total_away: ['goalie_preview'],
  },
  baseball: {
    moneyline:  ['probable_pitcher', 'lineups'],
    total:      ['probable_pitcher', 'weather'],
    spread:     ['probable_pitcher'],
    nrfi:       ['probable_pitcher'],
    f5_ml:      ['probable_pitcher'],
    f5_total:   ['probable_pitcher'],
    f5_spread:  ['probable_pitcher'],
  },
  basketball: {
    // v10.10.15: `pace` was geen feed-backed capability maar een
    // derived/model-feature uit game-data. Verwijderd uit dataRich-
    // assessment om semantiek helder te houden: dataRich = externe
    // bronondersteuning, niet afgeleide signalen.
    moneyline: ['injuries', 'rest_days'],
    total:     ['injuries'],
    spread:    ['injuries', 'rest_days'],
    half_ml:   ['injuries'],
    half_total:['injuries'],
  },
  'american-football': {
    moneyline: ['injuries', 'weather'],
    total:     ['injuries', 'weather'],
    spread:    ['injuries', 'weather'],
  },
  handball: {
    moneyline: [],
    threeway:  [],
    total:     [],
    spread:    [],
  },
};

function ensureNotes(target) {
  return Array.isArray(target) ? target : [];
}

function assessExecutable({ preferredHasCoverage, preferredCount }, notes) {
  if (preferredHasCoverage === true) {
    notes.push('executable: preferred bookie dekt markt');
    return true;
  }
  if (preferredHasCoverage === false) {
    notes.push('not_executable: geen preferred bookie met prijs voor deze markt');
    return false;
  }
  // Onbekend — conservatief aannemen dat wel (caller hoort dit expliciet
  // te checken, onbekend ≠ weigering).
  if (Number.isInteger(preferredCount) && preferredCount > 0) {
    notes.push('executable: ≥1 preferred bookie aanwezig');
    return true;
  }
  notes.push('executable: onbekend (caller leverde geen coverage signal)');
  return null;
}

function assessDataRich({ sport, marketType, capabilities }, notes) {
  if (!sport || !KNOWN_SPORTS.has(sport)) {
    notes.push(`dataRich: onbekende sport (${sport || 'null'}) → false`);
    return false;
  }
  const sportMap = RELEVANT_FEEDS[sport] || {};
  const feeds = sportMap[marketType];
  if (!feeds) {
    notes.push(`dataRich: geen feed-mapping voor (${sport}, ${marketType}) → false`);
    return false;
  }
  if (!feeds.length) {
    notes.push(`dataRich: geen sport-feeds beschikbaar (${sport}) → false`);
    return false;
  }
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const active = feeds.filter(feed => caps[feed] === true);
  if (!active.length) {
    notes.push(`dataRich: geen actieve feeds uit [${feeds.join(', ')}] → false`);
    return false;
  }
  notes.push(`dataRich: actieve feeds [${active.join(', ')}]`);
  return true;
}

function assessLineQuality({ bookmakerCount, overroundPct }, notes) {
  const n = Number.isFinite(bookmakerCount) ? bookmakerCount : null;
  if (n === null) {
    notes.push('lineQuality: onbekend (geen bookmakerCount) → medium');
    return 'medium';
  }
  let tier;
  if (n >= 6) tier = 'high';
  else if (n >= 3) tier = 'medium';
  else tier = 'low';
  notes.push(`lineQuality: ${tier} (n=${n})`);

  // Overround-penalty: bij extreem hoge vig degradeer één tier.
  if (Number.isFinite(overroundPct) && overroundPct > 0.10) {
    if (tier === 'high') tier = 'medium';
    else if (tier === 'medium') tier = 'low';
    notes.push(`lineQuality downgrade → ${tier} (overround ${(overroundPct * 100).toFixed(1)}% > 10%)`);
  }
  return tier;
}

/**
 * Hoofd-assessor. Pure functie, geen state, geen side-effects.
 *
 * @param {object} args
 *   - sport:                 'football' | 'basketball' | 'hockey' | etc.
 *   - marketType:            'moneyline' / 'total' / 'spread' / 'btts' / ...
 *   - preferredHasCoverage?: boolean  (caller bepaalt via getPreferredBookies)
 *   - preferredCount?:       number   (alt: hoeveel preferred bookies op event)
 *   - bookmakerCount?:       number   (uit line-timeline)
 *   - overroundPct?:         number   (markt-vig als fractie, 0.06 = 6%)
 *   - capabilities?:         object   { injuries, lineups, weather,
 *                                       goalie_preview, probable_pitcher,
 *                                       rest_days, pace } boolean-map
 *   - apiHost?:              string   (voor automatische capability-detect)
 *
 * @returns {{ executable:boolean|null, dataRich:boolean,
 *             lineQuality:'high'|'medium'|'low', playable:boolean,
 *             notes:string[] }}
 */
function assessPlayability(args = {}) {
  const notes = [];
  const sport = args.sport || null;
  const marketType = args.marketType || null;

  // Auto-fill injuries capability op basis van apiHost wanneer caller niet
  // expliciet heeft gezet.
  const capabilities = { ...(args.capabilities || {}) };
  if (capabilities.injuries === undefined && args.apiHost) {
    capabilities.injuries = supportsApiSportsInjuries(args.apiHost);
  }

  if (!sport) notes.push('sport ontbreekt → assessment is speculatief');
  if (!marketType) notes.push('marketType ontbreekt → dataRich forced false');

  const executable = assessExecutable(args, notes);
  const dataRich = assessDataRich({ sport, marketType, capabilities }, notes);
  const lineQuality = assessLineQuality(args, notes);

  // v10.10.15: bewust conservatief — `executable === null` (caller leverde
  // geen coverage-signal) wordt NIET gepromoveerd naar playable=true.
  // Voorheen: `executable === null + lineQuality !== 'low'` → playable. Dat
  // interpreteerde "execution unknown" stilletjes als "waarschijnlijk
  // speelbaar", gevaarlijk voor operator-beslissingen (Codex-review v10.10.14).
  // Nu: strict `executable === true` vereist. `coverageKnown` flag geeft
  // downstream het verschil tussen "niet speelbaar want false" en "niet
  // speelbaar want onbekend" zonder playable zelf nullable te maken.
  const coverageKnown = executable !== null;
  const playable = executable === true && lineQuality !== 'low';
  if (playable) notes.push('playable: ok');
  else if (executable === null) notes.push('not_playable: execution coverage onbekend (conservatief)');
  else if (executable === false) notes.push('not_playable: execution blokkeert');
  else notes.push('not_playable: lineQuality=low');

  return {
    executable,
    dataRich,
    lineQuality,
    playable,
    coverageKnown,
    notes,
  };
}

module.exports = {
  assessPlayability,
  assessExecutable,
  assessDataRich,
  assessLineQuality,
  RELEVANT_FEEDS,
  KNOWN_SPORTS,
  KNOWN_MARKETS,
  detectApiSportsFamily,
};
