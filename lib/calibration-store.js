'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CALIB = {
  version: 1,
  lastUpdated: null,
  totalSettled: 0,
  totalWins: 0,
  totalProfit: 0,
  markets: {
    home: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    away: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    draw: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    over: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    under: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    other: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
  },
  epBuckets: {},
  leagues: {},
  lossLog: [],
};

function cloneDefaultCalib() {
  return JSON.parse(JSON.stringify(DEFAULT_CALIB));
}

function createCalibrationStore(options = {}) {
  const {
    supabase,
    baseDir = process.cwd(),
    fileName = 'calibration.json',
    ttlMs = 10 * 1000,
  } = options;

  let cache = null;
  let cacheAt = 0;
  const fallbackFile = path.join(baseDir, fileName);

  function loadSync() {
    if (cache) return cache;
    try {
      cache = JSON.parse(fs.readFileSync(fallbackFile, 'utf8'));
      return cache;
    } catch {
      return cloneDefaultCalib();
    }
  }

  async function load() {
    if (cache && Date.now() - cacheAt < ttlMs) return cache;
    if (!supabase) return loadSync();
    try {
      const { data, error } = await supabase.from('calibration').select('data').eq('id', 1).single();
      if (!error && data?.data) {
        cache = data.data;
        cacheAt = Date.now();
        return cache;
      }
    } catch (error) {
      console.warn('loadCalibAsync failed, using stale cache/file:', error.message);
    }
    return loadSync();
  }

  async function save(nextCalib) {
    cache = nextCalib;
    cacheAt = Date.now();
    // v11.3.24 Phase 7.2 · A3 (Codex #2): schrijf ook naar fallback-file.
    // Eerder werd alleen naar cache+Supabase geschreven terwijl `loadSync()`
    // de file leest als noodfallback bij Supabase-outage. Zonder write-back
    // liep de file permanent achter → schijnveiligheid bij echte outage.
    try {
      fs.writeFileSync(fallbackFile, JSON.stringify(nextCalib, null, 2), 'utf8');
    } catch (error) {
      console.warn('calibration fallback write failed:', error.message);
    }
    if (!supabase) return;
    try {
      await supabase.from('calibration').upsert({
        id: 1,
        data: nextCalib,
        updated_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error('saveCalib error:', error.message);
    }
  }

  return {
    DEFAULT_CALIB,
    cloneDefaultCalib,
    loadSync,
    load,
    save,
  };
}

module.exports = {
  DEFAULT_CALIB,
  cloneDefaultCalib,
  createCalibrationStore,
};
