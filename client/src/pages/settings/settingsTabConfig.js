// client/src/pages/settings/settingsTabConfig.js
// ─────────────────────────────────────────────────────────────
// v0.91 Phase 1a — settings IA configuration.
//
// Single source of truth for:
//   1. Which sub-tabs live under which top tab (Workspace /
//      Integrations / Security).
//   2. Human-readable labels for every sub-tab.
//   3. Admin-only filtering rules.
//   4. Helpers the SettingsTabRouter uses to derive the active
//      top tab from an arbitrary `?tab=...` URL parameter.
//
// Why this isn't inside SettingsTabRouter.jsx: the same mapping
// is consumed by SettingsPage.jsx (to validate the activeTab on
// mount) and by Phase 1b's section-extraction work, so the
// config needs to be importable from multiple call sites without
// dragging React in.
// ─────────────────────────────────────────────────────────────

import WorkspaceTab from './WorkspaceTab.jsx';
import IntegrationsTab from './IntegrationsTab.jsx';
import SecurityTab from './SecurityTab.jsx';

// Order = the order top tabs appear in the chrome.
export const TOP_TABS = [WorkspaceTab, IntegrationsTab, SecurityTab];

// Human-readable label for every existing sub-tab id. Mirrors the
// TABS array that used to live inside SettingsPage.jsx — kept here
// so the router doesn't import SettingsPage and so Phase 1b can
// drop sub-tabs as their content moves into focused files without
// hunting through SettingsPage.jsx for labels.
export const SUB_TAB_LABELS = {
  general:            'General',
  emp:                'Maintenance Program',
  alerts:             'Alerts',
  ai:                 'AI & Extraction',
  access:             'Users & Roles',
  'api-keys':         'API Keys',
  webhooks:           'Webhooks',
  security:           'Security',
  storage:            'Storage & Backup',
  encryption:         'Encryption',
  customfields:       'Custom Fields',
  data:               'Account Data',
  branding:           'Branding',
  partner:            'Connected Partner',
};

// Sub-tabs that require admin role. Non-admins won't see these in the
// sub-pill row and can't activate them via direct ?tab= URL (the
// router falls back to that top tab's defaultSubTab).
export const ADMIN_ONLY_SUB_TABS = new Set([
  'api-keys',
  'webhooks',
]);

// Returns the top-tab descriptor that owns the given sub-tab id, or
// null if the sub-tab id is unknown. Used by the router to keep the
// top-tab highlight in sync with the active sub-tab — including the
// case where the active sub-tab was set via URL on first paint.
export function topTabForSubTab(subTabId) {
  for (const top of TOP_TABS) {
    if (top.subTabIds.includes(subTabId)) return top;
  }
  return null;
}

// Returns the visible sub-tab descriptors for a top tab, after
// admin-only filtering. Each descriptor has { id, label }. The router
// renders these as a sub-pill row underneath the active top tab.
export function visibleSubTabsForTopTab(topTab, isAdmin) {
  return topTab.subTabIds
    .filter(id => isAdmin || !ADMIN_ONLY_SUB_TABS.has(id))
    .map(id => ({ id, label: SUB_TAB_LABELS[id] || id }));
}

// Resolves what the active sub-tab should be when (a) the URL was
// pristine on first paint, or (b) the user clicked a top-tab whose
// previously-active sub-tab they aren't allowed to see. Honors the
// per-top-tab defaultSubTab, then falls back to the first visible
// sub-tab if the default is admin-gated for this user.
export function defaultSubTabFor(topTab, isAdmin) {
  if (isAdmin || !ADMIN_ONLY_SUB_TABS.has(topTab.defaultSubTab)) {
    return topTab.defaultSubTab;
  }
  const visible = visibleSubTabsForTopTab(topTab, isAdmin);
  return visible.length ? visible[0].id : topTab.defaultSubTab;
}
