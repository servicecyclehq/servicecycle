/**
 * guideRetrieval.js — Tool-call retrieval for the LapseIQ AI Guide (v0.35.3)
 *
 * The legacy Ask LapseIQ system prompt loaded the entire 62KB / 16K-token
 * `docs/LapseIQ_AI_GUIDE.md` on every call. That worked on Anthropic but
 * is structurally incompatible with every free-tier provider:
 *
 *   - Cloudflare Llama-3.1-8B-instruct: 7968-token context window
 *   - Groq free tier: 12K TPM rate limit
 *   - HuggingFace Inference: 4K-8K depending on model
 *
 * This module turns the guide into ~8 named topic chunks ("sections")
 * persisted as plain text under `server/data/guide-sections/`. The route
 * (`server/routes/ask.js`) sends a compact ~500-token system prompt that
 * names the available topics; the model decides which section(s) to load
 * by emitting a `get_guide_section(topic)` tool call. The route loops:
 * tool_use → fetch section → feed back → second-pass call returns final
 * text. Per-call payload stays under ~3K tokens, fitting every provider.
 *
 * Section files are loaded lazily, once per process, and cached in memory.
 * If a section is missing (e.g. file removed or never written) the lookup
 * returns null rather than throwing — the route should respond with the
 * list of valid topics so the model can retry.
 *
 * Adding or renaming a section:
 *   1. Drop a `<topic>.txt` file into `server/data/guide-sections/`.
 *   2. Add a one-line description to `SECTION_INDEX` below.
 *   3. Restart the server (file contents are cached at first read).
 *
 * The on-disk file is the source of truth — no markdown frontmatter
 * processing, no markdown→text conversion. The route ships the raw
 * contents back to the model. Keep section files ~400-1500 tokens each.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// Stable table-of-contents the system prompt names. Each entry: topic key
// (string, lowercase, snake_case, used as the filename stem) and a short
// one-sentence description shown to the model so it can pick the right
// section. Order is preserved when listed back to the model.
const SECTION_INDEX = Object.freeze([
  {
    topic: 'product_overview',
    description: "What LapseIQ is, the seven core models (Account/Users/Vendors/Contracts/Documents/Alerts/ActivityLog), and the six-step renewal cycle (Inventory → Configuration → Watching → Negotiating → Closing → Reporting).",
  },
  {
    topic: 'contracts_and_dates',
    description: "The Contract record and the three dates (endDate, evaluationStartByDate, cancelByDate); status lifecycle; renewal workflow checklist; bulk operations on /contracts.",
  },
  {
    topic: 'vendors_alerts_workflow',
    description: "Vendor records, vendor-name normalizer, contacts, AI document ingestion pipeline (/ingest), renewal alerts (cron, email/Slack/Teams), and the dashboard calendar view.",
  },
  {
    topic: 'documents_reporting',
    description: "Document vault and storage (local + S3-compatible), encryption-at-rest, document versioning, communications log, Budget Forecast (/budget), and Executive Spend Report.",
  },
  {
    topic: 'admin_features',
    description: "Vendor news scanner, activity log, CSV import/export, co-term groups, custom fields, backup, setup wizard, 2FA, consultant access, and the Settings tabs.",
  },
  {
    topic: 'ai_features',
    description: "AI provider abstraction (Cloudflare/Anthropic/OpenAI/Azure/Gemini), document extraction, signature/business-card extraction, renewal brief, per-user-per-day quotas, and what the AI sees.",
  },
  {
    topic: 'demo_and_roles',
    description: "Demo sandbox vs. self-host behavior (DEMO_MODE flag, per-visitor sandbox, AI caps, write guard) and the four roles (admin/manager/viewer/consultant) with their permissions.",
  },
  {
    topic: 'practice_primer',
    description: "Renewal-management practitioner conventions: notice cadence, auto-renewal trap, true-ups and license utilization, co-terming, escalation clauses and CPI caps, minimum commits, vendor consolidation, what the renewal brief is for.",
  },
  {
    topic: 'common_questions',
    description: "Direct answer templates for the most-asked questions: why a cancel-by date changed, why review-by is far out, importing 200 contracts, why no alert email, viewing all contracts for one vendor, changing AI provider, admin vs manager, edit blocked, tracking savings, demo banner.",
  },
]);

const SECTION_DIR = path.join(__dirname, '..', 'data', 'guide-sections');

// Module-level cache. Keys are topic strings; values are the file contents.
// `null` means we tried to load and failed (so we don't retry the read on
// every call). `undefined` means we haven't tried yet.
const _cache = new Map();

/**
 * Return the canonical list of available sections, each with `topic` and
 * `description`. Used by the route to build the compact system prompt's
 * Table of Contents and to validate model tool calls.
 *
 * Always returns the static index — does NOT touch the filesystem. The
 * filesystem is consulted only by getSection().
 */
function listSections() {
  return SECTION_INDEX.map(s => ({ topic: s.topic, description: s.description }));
}

/**
 * Format the section index as a compact TOC string suitable for embedding
 * in a system prompt. Each line: `- <topic>: <description>`.
 * Keeps the LLM-facing TOC under ~250 tokens.
 */
function formatToc() {
  return SECTION_INDEX.map(s => `- ${s.topic}: ${s.description}`).join('\n');
}

/**
 * Fetch a section's full text. Returns a string, or null if the topic is
 * unknown OR the file is missing/unreadable.
 *
 * Callers (the ask route) should treat null as a recoverable signal: tell
 * the model the topic wasn't found and re-list the valid topics so it can
 * retry the tool call with a corrected name.
 */
function getSection(topic) {
  if (typeof topic !== 'string') return null;
  const key = topic.trim().toLowerCase();
  if (!key) return null;

  // Validate against the static index first — prevents path traversal via
  // a hostile topic value reaching the filesystem read below. (Even if a
  // model emitted `../../../etc/passwd` as a topic, the early return
  // here means we never construct the path.)
  const known = SECTION_INDEX.find(s => s.topic === key);
  if (!known) return null;

  if (_cache.has(key)) return _cache.get(key);

  const filePath = path.join(SECTION_DIR, `${key}.txt`);
  try {
    const body = fs.readFileSync(filePath, 'utf-8');
    _cache.set(key, body);
    return body;
  } catch (err) {
    console.warn(`[guideRetrieval] section "${key}" failed to load from ${filePath}: ${err.message}`);
    _cache.set(key, null);
    return null;
  }
}

/**
 * Pre-load every section into the cache. Optional — getSection() lazy-loads
 * on first access — but useful at startup to fail loudly if any file is
 * missing.
 *
 * Returns { loaded: N, missing: [...] }.
 */
function loadSections() {
  const missing = [];
  let loaded = 0;
  for (const s of SECTION_INDEX) {
    const body = getSection(s.topic);
    if (body) loaded += 1;
    else missing.push(s.topic);
  }
  return { loaded, missing };
}

/**
 * Clear the in-memory cache. Test-only — production code should restart
 * the server after editing a section file (same hot-reload posture as the
 * old AI Guide loader).
 */
function _clearCache() {
  _cache.clear();
}

module.exports = {
  listSections,
  formatToc,
  getSection,
  loadSections,
  _clearCache,
  SECTION_DIR,
};

export {};
