'use strict';

// v12.1.0 (operator-rapport NHL live): extended statuses. 'PT' = Penalties
// (shootout, komt in ~10% NHL games voor), 'INT' = intermission (break tussen
// periodes op sommige API-versies), 'AOT' blijft finished dus niet hier.
// Voorheen ontbrak PT → NHL shootout-games toonden geen live-status in UI.
const V1_LIVE_STATUSES = new Set([
  'Q1', 'Q2', 'Q3', 'Q4',
  'OT', 'BT', 'HT', 'LIVE', 'INT',
  'P1', 'P2', 'P3', 'PT',
  'IN1', 'IN2', 'IN3', 'IN4', 'IN5', 'IN6', 'IN7', 'IN8', 'IN9',
]);

function isV1LiveStatus(statusShort) {
  return V1_LIVE_STATUSES.has(String(statusShort || '').toUpperCase());
}

function shouldIncludeDatedV1Game(statusShort, options = {}) {
  const st = String(statusShort || '').toUpperCase();
  if (st === 'NS') return true;
  if (options.includeLiveStatuses === true && isV1LiveStatus(st)) return true;
  return false;
}

module.exports = {
  V1_LIVE_STATUSES,
  isV1LiveStatus,
  shouldIncludeDatedV1Game,
};
