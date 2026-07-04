/**
 * lib/aiCapActions.ts — canonical list of per-user AI meter actions.
 *
 * SOURCE OF TRUTH for the admin AI-caps panel (routes/admin.ts) and the
 * per-user usage endpoint (routes/aiUsage.ts). Every entry here MUST match a
 * real action string that `checkAndIncrement` fires from a route — see the
 * "Actual metered actions" grep in adminAiCapsWhitelist.test.js for the
 * canonical set.
 *
 * The AccountSetting override lookup uses the key `ai_cap_<action>` — see
 * `getAccountCapOverride` in lib/aiQuota.ts:242-260. So the action strings
 * are the authoritative keys; adding a new metered route means adding an
 * entry here.
 *
 * Prior state (fixed 2026-07-04): routes/admin.ts hard-coded a whitelist of
 * five actions — `extract`, `ask`, `brief`, `brief_search`, `narrate` — of
 * which THREE were misspelled or invented: `extract` (real name is
 * `ingest_extract`), `brief` (real name is `maintenance_brief`), and
 * `brief_search` (never metered anywhere). Setting caps via the admin UI
 * upserted AccountSetting rows keyed `ai_cap_extract` / `ai_cap_brief` /
 * `ai_cap_brief_search`, none of which any code path ever looked up. Two
 * caps that DID gate real demo throttling (`nameplate_scan`,
 * `photo_inspect`) were not tunable per-account without direct SQL.
 */

'use strict';

export interface AiCapAction {
  action: string;
  label: string;
}

// Keep in sync with routes/aiUsage.ts:26. Order here is the display order in
// the admin panel (highest-signal actions first — ingest + camera scans lead
// because those are what the demo throttle actually caps).
export const AI_CAP_ACTIONS: readonly AiCapAction[] = Object.freeze([
  // Deterministic ingest with an AI fallback — routes/testReportImport /
  // routes/ingest fire this meter for the fallback pass (see lib/aiQuota
  // header comment).
  { action: 'ingest_extract',    label: 'Test-Report AI Ingest (fallback pass)' },
  // Nameplate camera scan — the ONLY per-user metered AI action on the
  // nameplate ingest path (routes/assetPhotoInspect.ts:435). Deterministic
  // PDF import stays free — see aiQuota header on the "moat" rationale.
  { action: 'nameplate_scan',    label: 'Nameplate AI Camera Scan' },
  // Vision AI condition assessment on an equipment photo
  // (routes/assetPhotoInspect.ts:233).
  { action: 'photo_inspect',     label: 'Photo Condition Inspection (vision AI)' },
  // In-product assistant.
  { action: 'ask',               label: 'Ask ServiceCycle Assistant' },
  // AI maintenance-brief generation (routes/assetBrief.ts:156). Note the
  // action key: `maintenance_brief`, NOT `brief` (which was the stale key
  // the previous whitelist carried and nothing ever metered).
  { action: 'maintenance_brief', label: 'Maintenance Brief Generation' },
  // AI-narrated report summaries — v0.68.0 (audit Medium).
  { action: 'narrate',           label: 'AI Report Narration' },
]);

// Set of valid action strings — routes/admin.ts uses this to reject stale
// keys on PUT /api/admin/ai-caps.
export const VALID_AI_CAP_ACTIONS: Set<string> = new Set(AI_CAP_ACTIONS.map((a) => a.action));

// CommonJS compat for require('../lib/aiCapActions') callers.
module.exports = { AI_CAP_ACTIONS, VALID_AI_CAP_ACTIONS };
