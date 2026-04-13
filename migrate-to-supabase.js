#!/usr/bin/env node
'use strict';

/**
 * Eenmalig migratiescript: Google Sheets → Supabase
 *
 * Gebruik:
 *   GOOGLE_CREDENTIALS_JSON='...' node migrate-to-supabase.js
 *
 * Of als je het lokaal draait met het gsheets-key.json bestand:
 *   node migrate-to-supabase.js
 */

const { google } = require('googleapis');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://mntfhhzanoyhgfavozhg.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';
const SHEET_ID     = '1tHV7Mrp_jUzlU-nxUAHpYL-d0rcqG2FpfGGNWbu16Ik';
const BET_START_ROW = 19;
const UNIT_EUR = 10;

if (!SUPABASE_KEY) {
  console.error('❌ Zet SUPABASE_KEY env var (service_role key)');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Google Sheets client
const SHEET_CREDS = process.env.GOOGLE_CREDENTIALS_JSON
  ? JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON)
  : (() => { try { return require('./gsheets-key.json'); } catch { return null; } })();

if (!SHEET_CREDS) {
  console.error('❌ Google credentials niet gevonden (GOOGLE_CREDENTIALS_JSON env of gsheets-key.json)');
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: SHEET_CREDS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});
const sheets = google.sheets({ version: 'v4', auth });

async function getSheetTab() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data.sheets?.[0]?.properties?.title || 'Sheet1';
}

// ── Migreer bets ──────────────────────────────────────────────────────────────
async function migrateBets() {
  console.log('\n📋 Bets migreren...');
  const tab = await getSheetTab();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A1:P500`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const data = res.data.values || [];
  const pf = v => parseFloat(String(v || '').replace(',', '.')) || 0;

  const bets = [];
  for (let i = BET_START_ROW - 1; i < data.length; i++) {
    const row = data[i];
    if (!row || !row[0]) continue;
    const nr = parseFloat(row[0]);
    if (isNaN(nr)) continue;
    bets.push({
      bet_id:   nr,
      datum:    row[1] || '',
      sport:    row[2] || '',
      wedstrijd: row[3] || '',
      markt:    row[4] || '',
      odds:     pf(row[5]),
      units:    pf(row[6]),
      inzet:    pf(row[7]) || +(pf(row[6]) * UNIT_EUR).toFixed(2),
      tip:      row[8] || 'Bet365',
      uitkomst: row[9] || 'Open',
      wl:       pf(row[10]),
      tijd:     row[11] || '',
      score:    parseInt(row[12]) || null,
      signals:  row[13] || '',
      clv_odds: pf(row[14]) || null,
      clv_pct:  pf(row[15]) || null,
    });
  }

  if (!bets.length) {
    console.log('  Geen bets gevonden in de sheet');
    return;
  }

  // Verwijder bestaande bets in Supabase (clean insert)
  await supabase.from('bets').delete().neq('id', 0);

  // Insert in batches van 50
  for (let i = 0; i < bets.length; i += 50) {
    const batch = bets.slice(i, i + 50);
    const { error } = await supabase.from('bets').insert(batch);
    if (error) console.error(`  ❌ Batch ${i}: ${error.message}`);
    else console.log(`  ✅ Batch ${i}-${i + batch.length}: ${batch.length} bets`);
  }
  console.log(`  📊 Totaal: ${bets.length} bets gemigreerd`);
}

// ── Migreer users ─────────────────────────────────────────────────────────────
async function migrateUsers() {
  console.log('\n👤 Users migreren...');
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `Users!A2:G500`,
    });
    const rows = (res.data.values || []).filter(r => r[0]);
    if (!rows.length) { console.log('  Geen users gevonden'); return; }

    await supabase.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    for (const r of rows) {
      let settings = {};
      try { settings = JSON.parse(r[5] || '{}'); } catch {}
      const { error } = await supabase.from('users').insert({
        id:            r[0],
        email:         (r[1] || '').toLowerCase(),
        password_hash: r[2] || '',
        role:          r[3] || 'user',
        status:        r[4] || 'pending',
        settings,
        created_at:    r[6] || new Date().toISOString(),
      });
      if (error) console.error(`  ❌ User ${r[1]}: ${error.message}`);
      else console.log(`  ✅ ${r[1]} (${r[3]})`);
    }
  } catch (e) {
    console.log(`  ⚠️ Users tab niet gevonden of fout: ${e.message}`);
  }
}

// ── Migreer scan history ──────────────────────────────────────────────────────
async function migrateScanHistory() {
  console.log('\n📜 Scan history migreren...');
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `ScanHistory!A1:C10`,
    });
    const rows = (res.data.values || []).filter(r => r[0]);
    if (!rows.length) { console.log('  Geen scan history gevonden'); return; }

    await supabase.from('scan_history').delete().neq('id', 0);

    for (const r of rows) {
      try {
        const entry = JSON.parse(r[2] || '{}');
        const { error } = await supabase.from('scan_history').insert({
          ts:           entry.ts || r[0],
          type:         entry.type || r[1] || 'prematch',
          total_events: entry.totalEvents || 0,
          picks:        entry.picks || [],
        });
        if (error) console.error(`  ❌ ${r[0]}: ${error.message}`);
        else console.log(`  ✅ ${r[0]} (${entry.picks?.length || 0} picks)`);
      } catch {}
    }
  } catch (e) {
    console.log(`  ⚠️ ScanHistory tab niet gevonden: ${e.message}`);
  }
}

// ── Migreer calibratie ────────────────────────────────────────────────────────
async function migrateCalibration() {
  console.log('\n🧠 Calibratie migreren...');
  try {
    const calibFile = path.join(__dirname, 'calibration.json');
    const data = JSON.parse(fs.readFileSync(calibFile, 'utf8'));
    const { error } = await supabase.from('calibration').upsert({
      id: 1, data, updated_at: new Date().toISOString()
    });
    if (error) console.error(`  ❌ ${error.message}`);
    else console.log(`  ✅ Calibratie gemigreerd (${data.totalSettled || 0} settled bets)`);
  } catch (e) {
    console.log(`  ⚠️ calibration.json niet gevonden: ${e.message}`);
  }
}

// ── Migreer signal weights ────────────────────────────────────────────────────
async function migrateSignalWeights() {
  console.log('\n🔧 Signal weights migreren...');
  try {
    const swFile = path.join(__dirname, 'signal_weights.json');
    const weights = JSON.parse(fs.readFileSync(swFile, 'utf8'));
    const { error } = await supabase.from('signal_weights').upsert({
      id: 1, weights, updated_at: new Date().toISOString()
    });
    if (error) console.error(`  ❌ ${error.message}`);
    else console.log(`  ✅ Signal weights gemigreerd`);
  } catch (e) {
    console.log(`  ⚠️ signal_weights.json niet gevonden: ${e.message}`);
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🚀 EdgePickr migratie: Google Sheets → Supabase\n');
  console.log(`   Supabase: ${SUPABASE_URL}`);
  console.log(`   Sheet:    ${SHEET_ID}`);

  await migrateBets();
  await migrateUsers();
  await migrateScanHistory();
  await migrateCalibration();
  await migrateSignalWeights();

  console.log('\n✅ Migratie voltooid!\n');
}

main().catch(e => { console.error('❌ Fatale fout:', e.message); process.exit(1); });
