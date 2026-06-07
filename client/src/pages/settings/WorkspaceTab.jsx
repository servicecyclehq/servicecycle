// client/src/pages/settings/WorkspaceTab.jsx
// ─────────────────────────────────────────────────────────────
// v0.91 Phase 1a — top-tab descriptor for the Workspace group.
//
// This file deliberately stays thin in Phase 1a. It exports the
// top-tab id, label, and the list of *existing* SettingsPage
// sub-tab IDs that fall under the Workspace group per the v0.91
// IA refactor (see outputs/design-system-spec-v0.91.md §7).
//
// Phase 1b will extract the actual section bodies into focused
// files under client/src/components/settings/ and import them
// from here. Until that ships, the chrome is moving but the
// section render still lives inside SettingsPage.jsx.
//
// Why this file exists today: SettingsTabRouter consumes the
// per-top-tab descriptors so the sub-pill row, the keyboard-arrow
// behaviour, and the default-sub-tab choice all live in one place
// per group — not as magic strings inside the router.
// ─────────────────────────────────────────────────────────────

const WorkspaceTab = {
  id: 'workspace',
  label: 'Workspace',
  // Sub-tab IDs that belong under the Workspace top tab. Order = the
  // order they appear in the sub-pill row.
  // Per spec §7, Workspace covers: Account preferences, Headcount,
  // Users & roles, Categories, Custom Fields, Document Storage, Demo
  // Mode reset, Template Feedback. The 'general' sub-tab today bundles
  // Account preferences + Headcount; 'access' bundles Users + Roles +
  // Consultant Access (Consultant Access moves to Integrations in 1b).
  subTabIds: [
    'general',          // Account preferences + Headcount
    'categories',       // Category management
    'customfields',     // Custom Fields
    'access',           // Users & Roles (Consultant Access split out in 1b)
    'template-feedback' // Admin-only template feedback
  ],
  // Default sub-tab when the top tab is first selected.
  defaultSubTab: 'general',
};

export default WorkspaceTab;
