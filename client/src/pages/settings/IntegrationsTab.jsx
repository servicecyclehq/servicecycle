// client/src/pages/settings/IntegrationsTab.jsx
// ─────────────────────────────────────────────────────────────
// v0.91 Phase 1a — top-tab descriptor for the Integrations group.
//
// Per spec §7, Integrations covers: AI Features, AI Provider,
// Azure OpenAI, Cloud Marketplace Connectors, Slack, Microsoft
// Teams, Webhooks, API Keys, Consultant Access.
//
// Phase 1a maps the existing SettingsPage tab IDs that cover these
// sections — content stays in SettingsPage.jsx. Phase 1b will
// extract Slack/Teams from the 'alerts' tab and Consultant Access
// from the 'access' tab into Integrations-resident files.
// ─────────────────────────────────────────────────────────────

const IntegrationsTab = {
  id: 'integrations',
  label: 'Integrations',
  // 'ai' bundles AI Features + AI Provider + Azure OpenAI + AI caps.
  // 'api-keys' and 'webhooks' are admin-only; the router filters them
  // out for non-admin users.
  // Slack/Teams currently live inside the 'alerts' tab (Security group).
  subTabIds: [
    'ai',         // AI Features + Provider + Azure
    'api-keys',   // API Keys (admin)
    'webhooks',   // Webhooks (admin)
    'partner',    // Connected Partner consent + audit log
  ],
  defaultSubTab: 'ai',
};

export default IntegrationsTab;
