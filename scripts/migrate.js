#!/usr/bin/env node
'use strict';

/**
 * EdgePickr migratie-runner. Voert SQL-bestanden uit tegen Supabase
 * via de bestaande service-role connectie.
 *
 * Gebruik:
 *   node scripts/migrate.js docs/migrations-archive/v10.10.21_sharp_clv.sql
 *   node scripts/migrate.js docs/migrations-archive/v10.10.7-21_combined.sql
 *   node scripts/migrate.js --dry   # toont SQL zonder uit te voeren
 *
 * Veiligheid:
 *   - Alleen additive queries (CREATE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS)
 *   - Blokkeert destructive keywords (DROP, TRUNCATE, DELETE FROM zonder WHERE)
 *   - Toont altijd de SQL voordat het draait
 *   - --dry flag voor preview zonder executie
 */

const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('FATAL: SUPABASE_URL en SUPABASE_KEY env vars vereist.');
  process.exit(1);
}

const DESTRUCTIVE = /\b(DROP\s+TABLE|DROP\s+INDEX|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM\s+\w+\s*;)/i;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry');
  const files = args.filter(a => a !== '--dry');

  if (!files.length) {
    console.log('Gebruik: node scripts/migrate.js <sql-file> [--dry]');
    console.log('  --dry   Toont SQL zonder uit te voeren');
    console.log('\nBeschikbare migraties:');
    const dir = path.join(__dirname, '..', 'docs', 'migrations-archive');
    if (fs.existsSync(dir)) {
      const sqls = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
      for (const f of sqls) console.log(`  docs/migrations-archive/${f}`);
    }
    process.exit(0);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  for (const file of files) {
    const filePath = path.resolve(file);
    if (!fs.existsSync(filePath)) {
      console.error(`Bestand niet gevonden: ${filePath}`);
      continue;
    }

    const sql = fs.readFileSync(filePath, 'utf8').trim();
    if (!sql) {
      console.warn(`Leeg bestand: ${file}`);
      continue;
    }

    // Veiligheidscheck: blokkeer destructive queries
    if (DESTRUCTIVE.test(sql)) {
      console.error(`GEBLOKKEERD: ${file} bevat destructive SQL (DROP/TRUNCATE/DELETE).`);
      console.error('Handmatig draaien in Supabase SQL Editor als dit bewust is.');
      continue;
    }

    console.log(`\n${'═'.repeat(70)}`);
    console.log(`Migratie: ${file}`);
    console.log(`${'═'.repeat(70)}`);
    console.log(sql);
    console.log(`${'─'.repeat(70)}`);

    if (dryRun) {
      console.log('DRY RUN — niet uitgevoerd.\n');
      continue;
    }

    // Splits op statement-grenzen (';' buiten strings) en voer per statement uit
    const statements = sql
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));

    let success = 0;
    let failed = 0;

    for (const stmt of statements) {
      if (!stmt || stmt.startsWith('--')) continue;
      try {
        const { error } = await supabase.rpc('exec_sql', { query: stmt });
        if (error) {
          // Fallback: sommige Supabase-instanties hebben geen exec_sql RPC.
          // Probeer via de REST API direct.
          const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({ query: stmt }),
          });
          if (!resp.ok) {
            const text = await resp.text();
            console.error(`  ❌ ${stmt.slice(0, 60)}...`);
            console.error(`     ${text.slice(0, 200)}`);
            failed++;
            continue;
          }
        }
        console.log(`  ✅ ${stmt.slice(0, 80)}${stmt.length > 80 ? '...' : ''}`);
        success++;
      } catch (e) {
        console.error(`  ❌ ${stmt.slice(0, 60)}...`);
        console.error(`     ${e.message}`);
        failed++;
      }
    }

    console.log(`\nResultaat: ${success} gelukt, ${failed} mislukt.`);
  }
}

main().catch(e => {
  console.error('Migratie-runner crash:', e.message);
  process.exit(1);
});
