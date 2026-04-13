'use strict';

const { CURRENT_SEASON, SPLIT_SEASON, CALENDAR_SEASON } = require('./config');

// Voetbal competities via api-football.com (league ID, thuisvoordeel)
const AF_FOOTBALL_LEAGUES = [
  // ── Europa · Tier 1 ────────────────────────────────────────────────────────
  { id:39,  key:'epl',          name:'Premier League',      ha:0.05, season:CURRENT_SEASON },
  { id:140, key:'laliga',       name:'La Liga',             ha:0.05, season:CURRENT_SEASON },
  { id:78,  key:'bundesliga',   name:'Bundesliga',          ha:0.05, season:CURRENT_SEASON },
  { id:135, key:'seriea',       name:'Serie A',             ha:0.05, season:CURRENT_SEASON },
  { id:61,  key:'ligue1',       name:'Ligue 1',             ha:0.05, season:CURRENT_SEASON },
  { id:88,  key:'eredivisie',   name:'Eredivisie',          ha:0.05, season:CURRENT_SEASON },
  { id:94,  key:'primeiraliga', name:'Primeira Liga',       ha:0.05, season:CURRENT_SEASON },
  { id:203, key:'superlig',     name:'Süper Lig',           ha:0.06, season:CURRENT_SEASON },
  { id:144, key:'jupiler',      name:'Jupiler Pro League',  ha:0.05, season:CURRENT_SEASON },
  { id:179, key:'scottish',     name:'Scottish Prem',       ha:0.05, season:CURRENT_SEASON },
  // ── Europa · Tier 2 ────────────────────────────────────────────────────────
  { id:40,  key:'championship', name:'Championship',        ha:0.04, season:CURRENT_SEASON },
  { id:41,  key:'league1',      name:'League One',          ha:0.04, season:CURRENT_SEASON },
  { id:42,  key:'league2',      name:'League Two',          ha:0.04, season:CURRENT_SEASON },
  { id:141, key:'laliga2',      name:'La Liga 2',           ha:0.04, season:CURRENT_SEASON },
  { id:79,  key:'bundesliga2',  name:'Bundesliga 2',        ha:0.04, season:CURRENT_SEASON },
  { id:136, key:'serieb',       name:'Serie B',             ha:0.04, season:CURRENT_SEASON },
  { id:66,  key:'ligue2',       name:'Ligue 2',             ha:0.04, season:CURRENT_SEASON },
  { id:89,  key:'eerstedivisie',name:'Eerste Divisie',      ha:0.04, season:CURRENT_SEASON },
  { id:95,  key:'liga2por',     name:'Liga Portugal 2',     ha:0.04, season:CURRENT_SEASON },
  { id:180, key:'scottish2',    name:'Scottish Championship',ha:0.04,season:CURRENT_SEASON },
  // ── Europese Cups ──────────────────────────────────────────────────────────
  { id:2,   key:'ucl',          name:'Champions League',    ha:0.02, season:CURRENT_SEASON },
  { id:3,   key:'uel',          name:'Europa League',       ha:0.02, season:CURRENT_SEASON },
  { id:848, key:'uecl',         name:'Conference League',   ha:0.02, season:CURRENT_SEASON },
  // ── Andere Europese competities ────────────────────────────────────────────
  { id:218, key:'austria',      name:'Austrian Bundesliga', ha:0.05, season:CURRENT_SEASON },
  { id:207, key:'swiss',        name:'Swiss Super League',  ha:0.05, season:CURRENT_SEASON },
  { id:119, key:'denmark',      name:'Danish Superliga',    ha:0.05, season:CURRENT_SEASON },
  { id:103, key:'norway',       name:'Eliteserien',         ha:0.05, season:new Date().getFullYear() },
  { id:113, key:'sweden',       name:'Allsvenskan',         ha:0.05, season:new Date().getFullYear() },
  { id:197, key:'greece',       name:'Super League Greece', ha:0.06, season:CURRENT_SEASON },
  { id:106, key:'poland',       name:'Ekstraklasa',         ha:0.05, season:CURRENT_SEASON },
  { id:345, key:'czech',        name:'Czech First League',  ha:0.05, season:CURRENT_SEASON },
  { id:283, key:'romania',      name:'Liga I Romania',      ha:0.05, season:CURRENT_SEASON },
  { id:210, key:'croatia',      name:'HNL Croatia',         ha:0.06, season:CURRENT_SEASON },
  { id:235, key:'russia',       name:'Russian Premier',     ha:0.05, season:CURRENT_SEASON },
  { id:333, key:'ukraine',      name:'Ukrainian Premier',   ha:0.05, season:CURRENT_SEASON },
  // ── Rest van de wereld ─────────────────────────────────────────────────────
  { id:253, key:'mls',          name:'MLS',                 ha:0.04, season:new Date().getFullYear() },
  { id:262, key:'ligamx',       name:'Liga MX',             ha:0.06, season:new Date().getFullYear() },
  { id:71,  key:'brasileirao',  name:'Brasileirao',         ha:0.06, season:new Date().getFullYear() },
  { id:128, key:'argentina',    name:'Primera División',    ha:0.06, season:new Date().getFullYear() },
  { id:307, key:'saudi',        name:'Saudi Pro League',    ha:0.05, season:CURRENT_SEASON },
  { id:98,  key:'j1league',     name:'J1 League',           ha:0.04, season:new Date().getFullYear() },
  // ── Azië & Oceanië ─────────────────────────────────────────────────────────
  { id:169, key:'china_super',   name:'Chinese Super League',  ha:0.05, season:new Date().getFullYear() },
  { id:292, key:'korea',         name:'K League 1',            ha:0.05, season:new Date().getFullYear() },
  { id:188, key:'australia',     name:'A-League',              ha:0.04, season:CURRENT_SEASON },
  // ── Zuid-Amerika ───────────────────────────────────────────────────────────
  { id:239, key:'colombia',      name:'Liga BetPlay',          ha:0.06, season:new Date().getFullYear() },
  { id:268, key:'chile',         name:'Primera División Chile', ha:0.06, season:new Date().getFullYear() },
  { id:242, key:'peru',          name:'Liga 1 Peru',           ha:0.06, season:new Date().getFullYear() },
  // ── Afrika & Midden-Oosten ─────────────────────────────────────────────────
  { id:233, key:'egypt',         name:'Egyptian Premier',      ha:0.06, season:CURRENT_SEASON },
  { id:270, key:'south_africa',  name:'South African Premier', ha:0.05, season:CURRENT_SEASON },
  // ── Scandinavië & Noordelijk Europa (2e divisies) ─────────────────────────
  { id:547, key:'denmark2',      name:'Danish 1st Division',   ha:0.04, season:CURRENT_SEASON },
  { id:271, key:'norway2',       name:'Norwegian First Div',   ha:0.04, season:new Date().getFullYear() },
  { id:114, key:'sweden2',       name:'Superettan',            ha:0.04, season:new Date().getFullYear() },
  { id:318, key:'finland',       name:'Veikkausliiga',         ha:0.05, season:new Date().getFullYear() },
  { id:373, key:'iceland',       name:'Úrvalsdeild',           ha:0.04, season:new Date().getFullYear() },
  // ── Oost-Europa ───────────────────────────────────────────────────────────
  { id:327, key:'bulgaria',      name:'First Professional League', ha:0.05, season:CURRENT_SEASON },
  { id:332, key:'serbia',        name:'Serbian SuperLiga',     ha:0.05, season:CURRENT_SEASON },
  { id:383, key:'hungary',       name:'NB I Hungary',          ha:0.05, season:CURRENT_SEASON },
  { id:286, key:'cyprus',        name:'Cyprus First Division', ha:0.05, season:CURRENT_SEASON },
  { id:325, key:'slovakia',      name:'Slovak Super Liga',     ha:0.05, season:CURRENT_SEASON },
];

// ── BASKETBALL LEAGUES ────────────────────────────────────────────────────────
const NBA_LEAGUES = [
  { id: 12,  key: 'nba',         name: 'NBA',                 ha: 0.03, season: SPLIT_SEASON },
  { id: 120, key: 'euroleague',  name: 'Euroleague',          ha: 0.04, season: SPLIT_SEASON },
  { id: 116, key: 'acb',         name: 'Liga ACB (Spanje)',   ha: 0.05, season: SPLIT_SEASON },
  { id: 117, key: 'lnb',         name: 'LNB Pro A (Frankrijk)',ha: 0.05, season: SPLIT_SEASON },
  { id: 204, key: 'bsl',         name: 'BSL (Turkije)',       ha: 0.05, season: CURRENT_SEASON },
];

// ── HOCKEY LEAGUES ────────────────────────────────────────────────────────────
const NHL_LEAGUES = [
  { id: 57,  key: 'nhl',         name: 'NHL',                 ha: 0.03, season: CURRENT_SEASON },
  { id: 85,  key: 'khl',         name: 'KHL (Rusland)',       ha: 0.04, season: CURRENT_SEASON },
  { id: 72,  key: 'shl',         name: 'SHL (Zweden)',        ha: 0.04, season: CURRENT_SEASON },
  { id: 68,  key: 'liiga',       name: 'Liiga (Finland)',     ha: 0.04, season: CURRENT_SEASON },
];

// ── BASEBALL LEAGUES ──────────────────────────────────────────────────────────
const BASEBALL_LEAGUES = [
  { id: 1,   key: 'mlb',         name: 'MLB',                 ha: 0.04, season: CALENDAR_SEASON },
  { id: 10,  key: 'kbo',         name: 'KBO (Korea)',         ha: 0.04, season: CALENDAR_SEASON },
  { id: 11,  key: 'npb',         name: 'NPB (Japan)',         ha: 0.04, season: CALENDAR_SEASON },
];

// ── NFL LEAGUES ───────────────────────────────────────────────────────────────
const NFL_LEAGUES = [
  { id: 1,   key: 'nfl',         name: 'NFL',                 ha: 0.057, season: CURRENT_SEASON },
  { id: 2,   key: 'ncaa',        name: 'NCAA Football',       ha: 0.05, season: CURRENT_SEASON },
];

// ── HANDBALL LEAGUES ──────────────────────────────────────────────────────────
const HANDBALL_LEAGUES = [
  { id: 30,  key: 'ehf_cl',      name: 'EHF Champions League',ha: 0.05, season: CURRENT_SEASON },
  { id: 35,  key: 'hbl',         name: 'Handball Bundesliga',  ha: 0.06, season: CURRENT_SEASON },
  { id: 36,  key: 'lnh',         name: 'Starligue (Frankrijk)',ha: 0.06, season: CURRENT_SEASON },
  { id: 37,  key: 'asobal',      name: 'Liga Asobal (Spanje)',ha: 0.06, season: CURRENT_SEASON },
];

// Mapping voor enrichWithApiSports: gebouwd vanuit AF_FOOTBALL_LEAGUES
const AF_LEAGUE_MAP = Object.fromEntries(
  AF_FOOTBALL_LEAGUES.map(l => [l.key, { host:'v3.football.api-sports.io', league:l.id, season:l.season }])
);

module.exports = {
  AF_FOOTBALL_LEAGUES, NBA_LEAGUES, NHL_LEAGUES, BASEBALL_LEAGUES,
  NFL_LEAGUES, HANDBALL_LEAGUES, AF_LEAGUE_MAP,
};
