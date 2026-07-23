/**
 * deviceLabelMatch.ts -- fuzzy-match a freshly-extracted device/point label
 * (TestMeasurement.label, e.g. "Main Breaker (MB-1)") against the labels
 * already on file for the SAME asset + measurementType, so the Testing &
 * Trends year-over-year view (which links readings by EXACT label string --
 * see commitTestReport.ts's priorByKey and TestingTrendsTab.jsx's rowKey)
 * doesn't silently fork a device's trend line just because this year's
 * report (possibly a different vendor/technician) formatted the same
 * physical breaker's name slightly differently ("MB-1" vs
 * "Main Breaker (MB-1)" vs "Main Bkr 1").
 *
 * Design note (2026-07-23 overnight research -- see
 * Device_Identity_Matching_Research_ServiceCycle.md, delivered to Dustin):
 * there is no industry-wide standard NETA-accredited firms actually follow
 * for naming individual breaker/feeder positions -- NETA's own test-report
 * guide ties naming to whatever the FACILITY's one-line diagram/nameplate
 * already says, not a portable taxonomy (IEC 81346/KKS is a real instance-
 * naming standard but is a European power-plant design-engineering
 * convention, not something U.S. NETA testing firms were found to use; ANSI
 * /IEEE C37.2 only classifies device TYPE, e.g. "52 = breaker", not a
 * specific instance). So this matches against each asset's OWN label
 * history, not an external abbreviation table.
 *
 * Full probabilistic (Fellegi-Sunter/Splink-style) record linkage is more
 * machinery than this problem needs: the candidate pool is a handful of
 * prior labels scoped to ONE asset+measurementType, not millions of records
 * with many independently-weighted fields, and a human is already reviewing
 * every import on the Preview screen regardless. A normalized, per-token
 * fuzzy score with a 3-tier confidence + margin check -- mirroring the
 * red/yellow/green pattern already used for reading confidence elsewhere in
 * this UI (TestReportImport.jsx's CONF_DOT/CONF_LABEL) -- is the right-sized
 * fit: green auto-links with zero clicks, yellow surfaces a one-click
 * confirm (defaulted to accept, since the common case should stay
 * frictionless), red is treated as a new device (including every device on
 * a brand-new asset's first-ever import, which is correct, not a gap).
 */

'use strict';

const GREEN_MIN = 0.90;        // auto-link, zero-click
const GREEN_MARGIN_MIN = 0.08; // best candidate must clear the 2nd-best by
                                // this much to auto-link -- guards against
                                // e.g. "F-1" scoring high against BOTH a
                                // prior "Feeder F-1" and "Feeder F-11".
                                // Waived for a literal exact-string repeat
                                // (see isExact below), which is unambiguous
                                // regardless of how any other candidate scores.
const YELLOW_MIN = 0.55;       // below this -> new device, no prompt at all

function normalizeLabel(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/([a-z])(\d)/g, '$1 $2')  // "mb1" -> "mb 1"
    .replace(/(\d)([a-z])/g, '$1 $2')  // "1a"  -> "1 a"
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation/parens -> space
    .trim()
    .replace(/\s+/g, ' ');
}

function tokens(norm: string): string[] {
  return norm.split(' ').filter(Boolean);
}

// A "weak" token (a bare single character -- a lone digit or letter) barely
// discriminates on its own; a match built ONLY from weak tokens is capped
// low rather than trusted (e.g. "A-1" vs "B-1" sharing only "1").
function isWeakToken(t: string): boolean {
  return t.length <= 1;
}

// Standard Jaro-Winkler similarity (0..1) -- used only to fuzz-match
// individual TOKENS (typo tolerance, e.g. "Feedr" vs "Feeder"), never whole
// strings. See tokenSetScore's comment for why whole-string JW was rejected.
function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const matchDist = Math.max(0, Math.floor(Math.max(la, lb) / 2) - 1);
  const aMatches = new Array(la).fill(false);
  const bMatches = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, lb);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  t /= 2;
  const jaro = (matches / la + matches / lb + (matches - t) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < la && prefix < lb && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

// Per-TOKEN matching (exact, or a close Jaro-Winkler typo match on tokens of
// length >= 3) rather than whole-string similarity. This is deliberate:
// whole-string JW lets two DIFFERENT devices that happen to share filler
// words and overall length/shape ("Tie Breaker (TB-1)" vs "Main Breaker
// (MB-1)" -- both "<Role> Breaker (<XX>-1)") score misleadingly high just
// from structural resemblance, even though "breaker" doesn't distinguish
// them at all. Scoring token-by-token means only tokens that ACTUALLY recur
// across both labels count, so two different roles sharing one word don't
// look like a match.
function bestTokenMatch(t: string, candidates: string[], used: Set<string>): { token: string; weight: number } | null {
  if (candidates.includes(t) && !used.has(t)) return { token: t, weight: 1 };
  if (t.length < 3) return null; // don't fuzz very short tokens (e.g. "f", "mb")
  let best: { token: string; jw: number } | null = null;
  for (const o of candidates) {
    if (used.has(o) || o.length < 3) continue;
    const jw = jaroWinkler(t, o);
    if (jw >= 0.85 && (!best || jw > best.jw)) best = { token: o, jw };
  }
  return best ? { token: best.token, weight: 0.9 } : null;
}

function tokenSetScore(aNorm: string, bNorm: string): number {
  const ta = tokens(aNorm), tb = tokens(bNorm);
  if (!ta.length || !tb.length) return 0;
  const used = new Set<string>();
  let sharedWeight = 0;
  let sawStrongMatch = false;
  for (const t of ta) {
    const m = bestTokenMatch(t, tb, used);
    if (!m) continue;
    used.add(m.token);
    const w = (isWeakToken(t) ? 0.25 : 1) * m.weight;
    sharedWeight += w;
    if (!isWeakToken(t)) sawStrongMatch = true;
  }
  if (sharedWeight === 0) return 0;
  const weightOf = (arr: string[]) => arr.reduce((s, t) => s + (isWeakToken(t) ? 0.25 : 1), 0);
  const minWeight = Math.min(weightOf(ta), weightOf(tb));
  const score = minWeight > 0 ? sharedWeight / minWeight : 0;
  // A match built ONLY from weak (single-char) tokens is weak evidence on
  // its own -- cap it below the yellow floor either way.
  return sawStrongMatch ? score : Math.min(score, 0.4);
}

function pairScore(newNorm: string, priorNorm: string): number {
  if (!newNorm || !priorNorm) return 0;
  if (newNorm === priorNorm) return 1;
  return tokenSetScore(newNorm, priorNorm);
}

type LabelTier = 'green' | 'yellow' | 'red';

interface LabelMatchResult {
  tier: LabelTier;
  matchedLabel: string | null;
  score: number;
}

/**
 * Score `newLabel` against every label this asset+measurementType has seen
 * before; return the confidence tier per the design above. `priorLabels` may
 * contain duplicates (raw DB rows) -- deduped internally.
 */
function matchDeviceLabel(newLabel: string, priorLabels: string[]): LabelMatchResult {
  const newNorm = normalizeLabel(newLabel);
  const uniquePrior = [...new Set((priorLabels || []).filter(Boolean))];
  if (!newNorm || !uniquePrior.length) return { tier: 'red', matchedLabel: null, score: 0 };

  const scored = uniquePrior
    .map((p) => ({ label: p, score: pairScore(newNorm, normalizeLabel(p)) }))
    .sort((x, y) => y.score - x.score);

  const best = scored[0];
  const second = scored[1];
  const isExact = normalizeLabel(best.label) === newNorm;
  const margin = best.score - (second ? second.score : 0);

  if (best.score >= GREEN_MIN && (isExact || margin >= GREEN_MARGIN_MIN)) {
    return { tier: 'green', matchedLabel: best.label, score: best.score };
  }
  if (best.score >= YELLOW_MIN) {
    return { tier: 'yellow', matchedLabel: best.label, score: best.score };
  }
  return { tier: 'red', matchedLabel: null, score: best.score };
}

module.exports = { normalizeLabel, tokenSetScore, jaroWinkler, matchDeviceLabel };
export {};
