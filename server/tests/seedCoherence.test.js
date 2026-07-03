/**
 * tests/seedCoherence.test.js
 * ---------------------------
 * TRIPWIRES against known demo-seed regression classes — NOT proofs of seed
 * coherence. These tests load scripts/seed-demo.js as TEXT (no DB, no prisma)
 * and assert that the specific bug classes fixed in the 2026-07-03
 * acquisition scan (commit f027483, docs/ACQUISITION_SCAN_2026-07-03.md)
 * cannot silently return:
 *
 *   1. Season/holiday/absolute-date anchors. The seed runs nightly against
 *      "now"; a record narrated around a fixed calendar moment (the old
 *      "Thanksgiving shutdown" copy, or a hardcoded "November 27, 2025")
 *      reads coherent for a few weeks and then silently rots. Fixed by
 *      rewording to season-free copy ("Annual production shutdown") and
 *      relative date math.
 *   2. def5 <-> wo10 linkage. The def5 deficiency is the finding that WO #10
 *      (SWGR-1A-1 IR thermography, completed -365d) logged; it must reference
 *      wo10, not some other WO, or the deficiency's origin story breaks.
 *   3. Schedule anchoring via completedAgo. Three schedules were re-anchored
 *      so lastCompleted/nextDue derive from a relative completedAgo offset
 *      instead of drifting absolute dates.
 *
 * Tuning notes (why the regexes are shaped the way they are — keep in sync
 * if you edit them):
 *   - Comments are stripped first so a comment that legitimately names a
 *     month or holiday (e.g. explaining the fix) never trips the checks,
 *     and so a comment mentioning wo10/completedAgo can never SATISFY the
 *     positive checks.
 *   - The month regex requires a 4-digit year ("July 12, 2026" / "12 July
 *     2026" / "July 2026"). Year-free narrative strings like the
 *     QuoteRequest copy "Weekend of July 12th" are pre-existing display
 *     text, deliberately not flagged; the rot class fixed on 2026-07-03 was
 *     year-anchored dates.
 *   - Absolute `new Date('YYYY-...')` literals are allowed ONLY on lines
 *     that set installDate/oneLineDiagramDate — those are historical facts
 *     that SHOULD be absolute. Anything else (schedule dates, WO dates,
 *     alert dates) must use relative math (addDays/completedAgo/dueIn).
 *
 * Also tripwired: the literal "Demo seed complete" success marker — the
 * nightly reseed workflow (.github/workflows/reseed.yml) greps seed output
 * for it because the ssh/docker exit code has mislabeled runs. Rewording
 * that log line would make every nightly reseed false-fail.
 */

const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, '..', 'scripts', 'seed-demo.js');

/**
 * Strip JS comments from source text.
 *  - Block comments via non-greedy regex.
 *  - Line comments by cutting each line at the first `//` NOT preceded by
 *    `:` (spares https:// URLs). Verified: the seed has no non-URL `//`
 *    inside string literals, so this text-level cut is safe here. If that
 *    ever changes, prefer a real tokenizer over loosening these tripwires.
 */
function stripComments(src) {
  const noBlocks = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return noBlocks
    .split('\n')
    .map((line) => {
      let idx = -1;
      let from = 0;
      for (;;) {
        const i = line.indexOf('//', from);
        if (i === -1) break;
        if (i > 0 && line[i - 1] === ':') { from = i + 2; continue; } // ://
        idx = i;
        break;
      }
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('seed-demo.js coherence tripwires (regression classes fixed 2026-07-03)', () => {
  let raw;
  let code; // comment-stripped

  beforeAll(() => {
    raw = fs.readFileSync(SEED_PATH, 'utf8');
    code = stripComments(raw);
  });

  test('sanity: seed file loads and is non-trivial', () => {
    expect(raw.length).toBeGreaterThan(10000);
  });

  // ── Class 1: season/holiday/absolute-date anchors ─────────────────────────
  test('no holiday/season-specific anchors in seed data', () => {
    // \b keeps 'Easter' from matching 'Eastern Iowa' (region strings).
    const holidayRe = /\b(Thanksgiving|Christmas|Easter|Hanukkah|Halloween|New Year)\b/i;
    expect(code).not.toMatch(holidayRe);
  });

  test('no year-anchored calendar dates in seed data', () => {
    const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
    // "July 12, 2026" / "July 12th 2026"
    const monthDayYear = new RegExp(`\\b(${MONTHS})\\s+\\d{1,2}(st|nd|rd|th)?\\s*,?\\s+\\d{4}\\b`);
    // "12 July 2026"
    const dayMonthYear = new RegExp(`\\b\\d{1,2}\\s+(${MONTHS})\\s+\\d{4}\\b`);
    // "July 2026"
    const monthYear = new RegExp(`\\b(${MONTHS})\\s+\\d{4}\\b`);
    expect(code).not.toMatch(monthDayYear);
    expect(code).not.toMatch(dayMonthYear);
    expect(code).not.toMatch(monthYear);
  });

  test("absolute new Date('...') literals only on installDate/oneLineDiagramDate lines", () => {
    const offenders = code
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /new Date\(\s*['"`]\d{4}/.test(line))
      .filter(({ line }) => !/installDate|oneLineDiagramDate/.test(line));
    // Historical install dates are FACTS and should be absolute; everything
    // else must be relative to the seed run ("now") or it rots.
    expect(offenders).toEqual([]);
  });

  // ── Class 2: def5 must reference wo10 ─────────────────────────────────────
  test('def5 deficiency references wo10 (the WO that logged the finding)', () => {
    const idx = code.indexOf('const def5');
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, idx + 800);
    expect(block).toMatch(/workOrderId:\s*wo10\.id/);
  });

  // ── Class 3: re-anchored schedules still use completedAgo ─────────────────
  test.each([
    'SWGR-1A-1:SWGR_INSULATION_RES',
    'T-1:XFMR_DGA',
    'SWGR-1A-1:SWGR_IR_THERMO',
  ])('schedule %s is anchored via completedAgo', (key) => {
    const re = new RegExp(`'${escapeRegExp(key)}':\\s*\\{\\s*completedAgo:`);
    expect(code).toMatch(re);
  });

  // ── Ops contract: nightly reseed success marker ───────────────────────────
  test("seed still prints the 'Demo seed complete' success marker", () => {
    // .github/workflows/reseed.yml fails the nightly job unless the seed
    // output contains this exact string (exit codes have lied before).
    expect(code).toMatch(/Demo seed complete/);
  });
});
