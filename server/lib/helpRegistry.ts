/**
 * helpRegistry.js — Per-module help-doc index for the in-app Help drawer.
 *
 * Source of truth: markdown files under `docs/help/*.md` (repo root) synced
 * into `server/data/help/*.txt` at build time. The .txt suffix dodges the
 * server/.dockerignore `*.md` exclusion same way the AI Guide does.
 *
 * Adding or renaming a module:
 *   1. Drop a `<slug>.md` file into `docs/help/` and a matching .txt sync
 *      under `server/data/help/` (or run `npm run help:sync`).
 *   2. Add a one-line registry entry to MODULE_INDEX below.
 *   3. Restart the server (file contents are cached at first read).
 *
 * Slugs are the URL/topic key. Titles and descriptions are user-facing.
 * The order in MODULE_INDEX is the order the Help drawer's module picker
 * uses — keep it grouped roughly the way the sidebar is.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const MODULE_INDEX = Object.freeze([
  // v0.37.1 W5 MT-024: surface the onboarding module first — it is the
  // first thing a new admin reads after landing on the dashboard, before
  // they have any sites or assets yet.
  {
    slug:         'onboarding',
    title:        'Onboarding',
    description:  'Fresh-install /setup wizard, in-app new-user wizard, and the path from zero to a working compliance calendar.',
  },
  {
    slug:         'dashboard',
    title:        'Dashboard',
    description:  'The morning-coffee view: what is due or overdue today, open deficiencies by severity, and the maintenance pipeline ahead.',
  },
  {
    slug:         'assets',
    title:        'Assets',
    description:  'The operating unit: equipment records, nameplate data, NFPA 70B condition ratings, and how data lands on an asset.',
  },
  {
    slug:         'sites',
    title:        'Sites & Locations',
    description:  'The site → building → area → position hierarchy, on-site contacts, blackout windows, and arc-flash studies.',
  },
  {
    slug:         'contractors',
    title:        'Contractors',
    description:  'NETA-certified testing contractors, field technicians and their certification levels, and assignment rules.',
  },
  {
    slug:         'schedules',
    title:        'Maintenance Schedules',
    description:  'Task definitions, condition-based intervals (C1/C2/C3), next-due computation, and per-schedule overrides.',
  },
  {
    slug:         'work-orders',
    title:        'Work Orders',
    description:  'Scheduling, as-found / as-left condition capture, test measurements, deficiencies, and NETA decals.',
  },
  {
    slug:         'imports',
    title:        'Imports',
    description:  'CSV uploads, saved column-mapping profiles, the import paths (CSV / API), and the dedup model.',
  },
  {
    slug:         'alerts',
    title:        'Alerts',
    description:  'Daily digest, maintenance-due lead-time tiers, overdue escalation, per-user preferences, optional Slack and Teams channels.',
  },
  {
    slug:         'reports',
    title:        'Reports',
    description:  'Canned compliance reports: due/overdue horizon, deficiency ledger, test history, and executive summaries.',
  },
  {
    slug:         'settings',
    title:        'Settings',
    description:  'Admin control plane: AI provider, security, storage, encryption, custom fields, users and roles, and account data.',
  },
  // v0.37.1 W5 MT-024: last item because the audience is integrators and
  // ops admins, not the day-to-day maintenance operator. Surfacing it after
  // Settings matches the "Settings -> API & Integrations" UI grouping.
  {
    slug:         'api-and-integrations',
    title:        'API & Integrations',
    description:  'Public REST API, webhook endpoints, and the OpenAPI spec.',
  },
]);

// Resolve to the synced .txt path inside the runtime image first, then to
// the canonical .md repo path as a developer-workstation fallback. Same
// candidate chain pattern lib/guideRetrieval.js uses.
const SYNCED_DIR     = path.join(__dirname, '..', 'data', 'help');
const REPO_FALLBACK  = path.join(__dirname, '..', '..', 'docs', 'help');

// Module-level cache. Keys are slugs; values are file contents.
// `null` means we tried to load and failed. `undefined` means we haven't tried.
const _cache = new Map();

/**
 * Return the canonical list of modules, each with slug + title + description.
 * Used by the route to build the module-picker payload and to validate
 * incoming slug params before any FS read. Always returns the static index;
 * does NOT touch the filesystem.
 */
function listModules() {
  return MODULE_INDEX.map(m => ({ slug: m.slug, title: m.title, description: m.description }));
}

/**
 * Fetch a module's full markdown text. Returns a string, or null if the
 * slug is unknown OR the file is missing/unreadable.
 *
 * Slug validation against the static index happens BEFORE any path
 * construction — prevents path traversal via a hostile slug value.
 */
function getModule(slug) {
  if (typeof slug !== 'string') return null;
  const key = slug.trim().toLowerCase();
  if (!key) return null;

  const known = MODULE_INDEX.find(m => m.slug === key);
  if (!known) return null;

  if (_cache.has(key)) return _cache.get(key);

  // Try synced .txt first, then the .md fallback for dev workstations.
  const candidates = [
    path.join(SYNCED_DIR, `${key}.txt`),
    path.join(REPO_FALLBACK, `${key}.md`),
  ];

  for (const filePath of candidates) {
    try {
      const body = fs.readFileSync(filePath, 'utf-8');
      _cache.set(key, body);
      return body;
    } catch (_) {
      // try next candidate
    }
  }

  console.warn(`[helpRegistry] module "${key}" failed to load from: ${candidates.join(', ')}`);
  _cache.set(key, null);
  return null;
}

/**
 * Get a module's title for use in PDF headers / drawer headers.
 * Returns null if slug is unknown.
 */
function getModuleTitle(slug) {
  const m = MODULE_INDEX.find(x => x.slug === slug);
  return m ? m.title : null;
}

/**
 * Pre-load every module into the cache. Optional — getModule() lazy-loads
 * on first access — but useful at startup to fail loudly if any file is
 * missing.
 *
 * Returns { loaded: N, missing: [...] }.
 */
function loadAll() {
  const missing = [];
  let loaded = 0;
  for (const m of MODULE_INDEX) {
    if (getModule(m.slug)) loaded += 1;
    else missing.push(m.slug);
  }
  return { loaded, missing };
}

function _clearCache() { _cache.clear(); }

module.exports = {
  listModules,
  getModule,
  getModuleTitle,
  loadAll,
  _clearCache,
  MODULE_INDEX,
};

export {};
