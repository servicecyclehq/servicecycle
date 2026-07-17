/**
 * routes/glossary.ts — read-only electrical symbol/marking glossary (punch #4).
 *
 * Explains the shorthand on one-lines and test reports: IEEE C37.2 device
 * function numbers, IEEE 315 one-line device abbreviations, and NETA/NECA test
 * markings. Pure reference data — any authenticated role may read; no writes.
 *
 * Mounted at /api/glossary in index.ts (authenticateToken applied at the mount).
 *   GET /api/glossary?category=device_number   full list (optional filter)
 *   GET /api/glossary/lookup?q=87T             resolve one designation
 */

'use strict';

const router = require('express').Router();
const {
  allEntries, lookupDesignation, explainDesignation, CATEGORIES,
} = require('../lib/electricalGlossary');

// ── GET /api/glossary ─────────────────────────────────────────────────────────
// Full glossary; ?category= narrows to one of CATEGORIES.
router.get('/', (req, res) => {
  const category = req.query.category ? String(req.query.category) : null;
  let entries = allEntries();
  if (category) {
    if (!CATEGORIES.includes(category)) {
      return res.status(400).json({ success: false, error: `Unknown category. One of: ${CATEGORIES.join(', ')}` });
    }
    entries = entries.filter((e: any) => e.category === category);
  }
  return res.json({ success: true, data: { categories: CATEGORIES, count: entries.length, entries } });
});

// ── GET /api/glossary/lookup?q=87T ────────────────────────────────────────────
// Resolve a single designation — combo ("50/51") and device-number+suffix
// ("87T", "51G") aware. Returns the matched entries + a compact explanation.
router.get('/lookup', (req, res) => {
  const q = req.query.q != null ? String(req.query.q) : '';
  if (!q.trim()) {
    return res.status(400).json({ success: false, error: 'Pass ?q= a designation to look up (e.g. 87T, SWGR, IR).' });
  }
  const entries = lookupDesignation(q);
  return res.json({
    success: true,
    data: { query: q, matched: entries.length > 0, explanation: explainDesignation(q), entries },
  });
});

module.exports = router;

export {};
