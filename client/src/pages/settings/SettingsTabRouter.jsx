// client/src/pages/settings/SettingsTabRouter.jsx
// ─────────────────────────────────────────────────────────────
// v0.91 Phase 1a — two-level tab chrome for /settings.
//
// Replaces the single wrapped tab strip that used to live inline
// in SettingsPage.jsx (lines ~350-404 pre-v0.91). The new IA per
// spec §7 is three top tabs — Workspace / Integrations / Security
// — with a sub-pill row beneath the active top tab showing the
// existing settings sub-sections that belong to that group.
//
// What this component owns:
//   - Top-tab row (3 buttons, role="tablist")
//   - Sub-pill row (filtered to admin-visible entries)
//   - Keyboard arrow navigation within each row
//   - Default-sub-tab selection when the user clicks a top tab
//   - Resolving the active top tab from the current sub-tab
//
// What this component does NOT own:
//   - The activeTab state (lives in SettingsPage so the existing
//     `display: activeTab === 'X' ? 'block' : 'none'` section
//     gating keeps working untouched)
//   - The URL ?tab=... sync (parent handles it in onSubTabChange)
//   - The section bodies (Phase 1b extracts them into focused files)
//
// Token policy: every colour reference goes through an index.css
// variable (--color-primary, --color-text-secondary, etc). No raw
// hex. Spacing/borders likewise.
// ─────────────────────────────────────────────────────────────

import React, { useMemo, useRef } from 'react';
import {
  TOP_TABS,
  visibleSubTabsForTopTab,
  topTabForSubTab,
  defaultSubTabFor,
} from './settingsTabConfig.js';

export default function SettingsTabRouter({
  activeSubTab,
  onSubTabChange,
  isAdmin = false,
}) {
  // Derive the active top tab from the current sub-tab. If the
  // sub-tab id is unknown (stale URL, deleted feature), fall back
  // to the first top tab so the chrome still renders.
  const activeTopTab = useMemo(() => {
    return topTabForSubTab(activeSubTab) || TOP_TABS[0];
  }, [activeSubTab]);

  const visibleSubTabs = useMemo(() => {
    return visibleSubTabsForTopTab(activeTopTab, isAdmin);
  }, [activeTopTab, isAdmin]);

  // Refs for focus management on arrow-key navigation. Keyed by
  // composite id so the same hook serves both rows.
  const buttonRefs = useRef({});

  const focusButton = (key) => {
    const el = buttonRefs.current[key];
    if (el && typeof el.focus === 'function') el.focus();
  };

  // Handler factory for keyboard arrow navigation within a tab row.
  // Arrow Left/Right cycle through the row; Home/End jump to ends.
  // We move focus AND activate, matching the WAI-ARIA "automatic
  // activation" tabs pattern that the existing SettingsPage used.
  const makeKeyHandler = (items, getKey, activate) => (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const ids = items.map(getKey);
    const currentIdx = ids.findIndex(id => id === e.currentTarget.dataset.tabId);
    if (currentIdx < 0) return;
    let nextIdx;
    if (e.key === 'Home') nextIdx = 0;
    else if (e.key === 'End') nextIdx = ids.length - 1;
    else if (e.key === 'ArrowRight') nextIdx = (currentIdx + 1) % ids.length;
    else nextIdx = (currentIdx - 1 + ids.length) % ids.length;
    activate(ids[nextIdx]);
    // Focus moves to the new active button after React commits.
    setTimeout(() => focusButton(ids[nextIdx]), 0);
  };

  // Top tab click: switch group AND select that group's default
  // sub-tab so the form below isn't left rendering a sub-tab from
  // the previous group.
  const onTopTabClick = (topTab) => {
    const nextSubTab = defaultSubTabFor(topTab, isAdmin);
    onSubTabChange(nextSubTab);
  };

  return (
    <div className="settings-tab-router" style={{ marginBottom: '1.75rem' }}>
      {/* ── Top tabs (Workspace / Integrations / Security) ──── */}
      <div
        role="tablist"
        aria-label="Settings section groups"
        onKeyDown={makeKeyHandler(
          TOP_TABS,
          t => t.id,
          (id) => {
            const top = TOP_TABS.find(t => t.id === id);
            if (top) onTopTabClick(top);
          },
        )}
        className="settings-tab-row"
      >
        {TOP_TABS.map((top) => {
          const isActive = top.id === activeTopTab.id;
          return (
            <button
              key={top.id}
              type="button"
              role="tab"
              id={`settings-toptab-${top.id}`}
              data-tab-id={top.id}
              ref={(el) => { buttonRefs.current[top.id] = el; }}
              aria-selected={isActive}
              aria-controls={`settings-tabpanel-${activeSubTab}`}
              tabIndex={isActive ? 0 : -1}
              onClick={() => onTopTabClick(top)}
              className="settings-tab-button"
            >
              {top.label}
            </button>
          );
        })}
      </div>

      {/* ── Sub-pill row (sub-sections of the active top tab) ── */}
      {visibleSubTabs.length > 0 && (
        <div
          role="tablist"
          aria-label={`${activeTopTab.label} sections`}
          onKeyDown={makeKeyHandler(
            visibleSubTabs,
            t => t.id,
            (id) => onSubTabChange(id),
          )}
          className="settings-subpill-row"
        >
          {visibleSubTabs.map((sub) => {
            const isActive = sub.id === activeSubTab;
            return (
              <button
                key={sub.id}
                type="button"
                role="tab"
                id={`settings-tab-${sub.id}`}
                data-tab-id={sub.id}
                ref={(el) => { buttonRefs.current[sub.id] = el; }}
                aria-selected={isActive}
                aria-controls={`settings-tabpanel-${sub.id}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSubTabChange(sub.id)}
                className="settings-subpill-button"
              >
                {sub.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
