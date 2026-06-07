// client/src/pages/settings/SecurityTab.jsx
// ─────────────────────────────────────────────────────────────
// v0.91 Phase 1a — top-tab descriptor for the Security group.
//
// Per spec §7, Security covers: Password Policy, MFA, Document
// Encryption at Rest (+ MASTER_KEY backup), Automated Backups,
// Audit Log access, Account Data Export, Alert Preferences.
//
// Phase 1a routes the existing tab IDs that cover these sections
// to this top tab. Phase 1b will split Document Storage out of
// the current 'storage' tab into Workspace (where the spec lives)
// while keeping Backups here.
// ─────────────────────────────────────────────────────────────

const SecurityTab = {
  id: 'security',
  label: 'Security',
  // 'security' bundles Password Policy + MFA setup.
  // 'encryption' is the Document Encryption at Rest section.
  // 'storage' currently bundles Document Storage + Automated Backups;
  // Phase 1b will split Document Storage out to Workspace.
  // 'alerts' bundles Alert Preferences + Slack + Teams; Phase 1b will
  // promote Slack/Teams to Integrations and leave Alert Preferences here.
  // 'data' is the Account Data Export + Demo Reset surface.
  subTabIds: [
    'security',    // Password Policy + MFA
    'encryption',  // Document Encryption at Rest (admin)
    'storage',     // Document Storage + Backups (admin; split in 1b)
    'alerts',      // Alert Preferences (+ Slack/Teams — split in 1b)
    'data',        // Account Data Export + Demo Reset (admin)
  ],
  defaultSubTab: 'security',
};

export default SecurityTab;
