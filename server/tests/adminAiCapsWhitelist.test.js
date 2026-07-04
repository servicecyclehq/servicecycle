'use strict';

/**
 * Regression-lock for the 2026-07-04 AI-caps whitelist reconciliation.
 *
 * Prior state: `routes/admin.ts` AI_CAP_ACTIONS listed the actions
 *   [extract, ask, brief, brief_search, narrate]
 * but the REAL per-user meter action names fired by `checkAndIncrement` in
 * routes are
 *   [ingest_extract, ask, maintenance_brief, narrate, photo_inspect, nameplate_scan]
 * (source of truth: routes/aiUsage.ts:26 — the client's canonical list).
 * Setting caps through the admin UI wrote AccountSetting rows keyed
 * `ai_cap_extract` / `ai_cap_brief` / `ai_cap_brief_search` — none of which
 * any code path ever looked up, so tuning them was a silent no-op. Meanwhile
 * `nameplate_scan` and `photo_inspect` (the actions that actually gate demo
 * throttling) were not tunable per-account without direct SQL.
 *
 * The whitelist now lives in lib/aiCapActions.ts (single source of truth for
 * admin.ts and this test). This suite locks it against the canonical set so a
 * future edit that drops or misspells any of these keys — or reintroduces one
 * of the stale ones — fails loudly at CI time.
 *
 * Kept as a pure unit test: no supertest, no prisma boot, no express router.
 * Booting the admin router transitively loads prisma + a dozen sibling
 * routes, none of which are relevant to what the whitelist SAYS.
 */

const { AI_CAP_ACTIONS, VALID_AI_CAP_ACTIONS } = require('../lib/aiCapActions');

// SOT: the client-facing catalogue at routes/aiUsage.ts:26. If that constant
// ever moves, this array moves with it — but the CI diff is the enforcement,
// not this comment. `brief_search` is intentionally absent (never metered).
const CANONICAL_METER_ACTIONS = [
  'ingest_extract',
  'ask',
  'maintenance_brief',
  'narrate',
  'photo_inspect',
  'nameplate_scan',
];

// Keys the prior whitelist carried and NO code path ever metered. Locked in
// the "must-not-reappear" set so a copy-paste regression fails.
const STALE_ACTIONS = ['extract', 'brief', 'brief_search'];

describe('AI_CAP_ACTIONS whitelist matches real meter actions', () => {
  test('whitelist contains every canonical metered action', () => {
    const actions = AI_CAP_ACTIONS.map((a) => a.action).sort();
    expect(actions).toEqual([...CANONICAL_METER_ACTIONS].sort());
  });

  test('none of the stale keys reappear', () => {
    const actions = AI_CAP_ACTIONS.map((a) => a.action);
    for (const s of STALE_ACTIONS) {
      expect(actions).not.toContain(s);
    }
  });

  test('every whitelisted action carries a non-empty human label', () => {
    for (const row of AI_CAP_ACTIONS) {
      expect(typeof row.label).toBe('string');
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  test('AccountSetting override keys resolve to the pattern `ai_cap_<action>`', () => {
    // The lookup is lib/aiQuota.ts:256 `key: `ai_cap_${action}` — assert the
    // action strings are simple snake_case identifiers (no spaces, dashes,
    // uppercase) so the resolved key is a legal AccountSetting.key string.
    for (const { action } of AI_CAP_ACTIONS) {
      expect(action).toMatch(/^[a-z][a-z_]*[a-z]$/);
    }
  });

  test('VALID_AI_CAP_ACTIONS Set matches the array', () => {
    // The PUT /api/admin/ai-caps route uses this Set to silently drop keys
    // that don't belong. Sanity-check the two structures stay aligned.
    const arr = AI_CAP_ACTIONS.map((a) => a.action).sort();
    const set = [...VALID_AI_CAP_ACTIONS].sort();
    expect(set).toEqual(arr);
  });

  test('every action appears in the frozen readonly list (no runtime mutation)', () => {
    // The exported list is Object.freeze()d so a rogue push in a boot-time
    // module can't smuggle a fake action past the CI diff.
    expect(Object.isFrozen(AI_CAP_ACTIONS)).toBe(true);
  });
});
