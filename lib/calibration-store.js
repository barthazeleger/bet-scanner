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
    // v12.0.0: BTTS eigen multiplier-bucket. Voorheen las scan cm.over/cm.under
    // voor BTTS-stake terwijl learning-loop al naar btts_yes/btts_no schreef →
    // cross-market contamination (Over×1.18 lekte naar BTTS). Nu aparte leer-
    // paden én aparte scan-consumptie.
    btts_yes: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    btts_no: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    // v12.0.0: DNB en DC aparte learning-buckets. Voorheen ongebruikt, nu
    // read door scan-body voor consistent kelly-multiplier gedrag.
    dnb_home: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    dnb_away: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    dc_1x: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    dc_12: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
    dc_x2: { n: 0, w: 0, profit: 0, multiplier: 1.0 },
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
    // v12.2.20 (D4): Supabase = single source of truth. File-write alleen als
    // (a) er geen Supabase client is (test-modus / cold-boot) of (b) Supabase
    // upsert faalt (outage-resilience). Voorheen schreven we altijd dual-
    // persist; dat creëerde een race tussen concurrent updateBetOutcome +
    // autotune omdat fs.writeFileSync zonder lock kan interleave-vermengen.
    if (!supabase) {
      try {
        fs.writeFileSync(fallbackFile, JSON.stringify(nextCalib, null, 2), 'utf8');
      } catch (error) {
        console.warn('calibration file write failed:', error.message);
      }
      return;
    }
    try {
      const { error } = await supabase.from('calibration').upsert({
        id: 1,
        data: nextCalib,
        updated_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
    } catch (error) {
      console.error('saveCalib error, persisting to fallback file:', error.message);
      // Outage-resilience: schrijf naar file zodat een herstart na crash niet
      // op stale boot-state landt. Volgende success save() syncht alles weer.
      try {
        fs.writeFileSync(fallbackFile, JSON.stringify(nextCalib, null, 2), 'utf8');
      } catch (fileError) {
        console.warn('calibration fallback write failed:', fileError.message);
      }
    }
  }

  // v12.2.7 (F3): snapshot/restore voor atomic outcome-flip. Calls om calib-
  // state vóór een revert+update flow vast te leggen, en bij exception terug
  // te zetten. Diepe kopie via JSON-roundtrip (calib is plain JSON, geen
  // functions/circulars).
  function snapshot() {
    const c = loadSync();
    return JSON.parse(JSON.stringify(c));
  }
  async function restore(snap) {
    if (!snap || typeof snap !== 'object') return;
    await save(snap);
  }

  return {
    DEFAULT_CALIB,
    cloneDefaultCalib,
    loadSync,
    load,
    save,
    snapshot,
    restore,
  };
}

module.exports = {
  DEFAULT_CALIB,
  cloneDefaultCalib,
  createCalibrationStore,
};
