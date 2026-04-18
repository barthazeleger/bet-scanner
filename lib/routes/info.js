'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * v11.2.7 · Phase 5.4e: Info/meta read-only routes extracted uit server.js.
 *
 * Factory pattern. Mount via `app.use('/api', createInfoRouter({...}))`.
 *
 * Verantwoordelijkheden:
 *   - GET /api/version   — APP_VERSION + last 10 model-log entries
 *   - GET /api/changelog — parse CHANGELOG.md → JSON entries (admin-only)
 *
 * @param {object} deps
 *   - appVersion      — string (APP_VERSION constant)
 *   - loadCalib       — fn () → calibration object (voor modelLog)
 *   - requireAdmin    — Express middleware
 *   - changelogPath   — optional absolute path (default __dirname/../../CHANGELOG.md)
 * @returns {express.Router}
 */
module.exports = function createInfoRouter(deps) {
  const { appVersion, loadCalib, requireAdmin } = deps;
  const changelogPath = deps.changelogPath || path.join(__dirname, '..', '..', 'CHANGELOG.md');

  const required = { appVersion, loadCalib, requireAdmin };
  for (const [key, val] of Object.entries(required)) {
    if (val === undefined || val === null) {
      throw new Error(`createInfoRouter: missing required dep '${key}'`);
    }
  }

  const router = express.Router();

  router.get('/version', (req, res) => {
    const c = loadCalib();
    res.json({
      version:          appVersion,
      modelLog:         (c.modelLog || []).slice(0, 10),
      modelLastUpdated: c.modelLastUpdated || null,
    });
  });

  router.get('/changelog', requireAdmin, (req, res) => {
    try {
      const raw = fs.readFileSync(changelogPath, 'utf8');
      const entries = [];
      // Split op "## [x.y.z] - date" secties
      const blocks = raw.split(/\n(?=## \[)/);
      for (const block of blocks) {
        const hdr = block.match(/^## \[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})/);
        if (!hdr) continue;
        const version = hdr[1], date = hdr[2];
        // Binnen het block: ### Section headers
        const body = block.slice(hdr[0].length).trim();
        const sections = [];
        const parts = body.split(/\n(?=### )/);
        for (const p of parts) {
          const sh = p.match(/^### ([^\n]+)/);
          if (!sh) continue;
          const title = sh[1].trim();
          const text = p.slice(sh[0].length).trim();
          sections.push({ title, text });
        }
        entries.push({ version, date, sections });
      }
      res.json({ version: appVersion, entries });
    } catch (e) {
      res.status(500).json({ error: (e && e.message) || 'Kan CHANGELOG niet lezen' });
    }
  });

  return router;
};
