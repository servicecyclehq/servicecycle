/**
 * RenewalBriefSectionsCard — admin-toggleable opt-in sections for the
 * AI renewal brief.
 *
 * Extracted from SettingsPage.jsx in v0.37.3 W6 followup MT-150. The
 * previous inline implementation had:
 *   - Its own out-of-band state object alongside the page-level form state
 *   - A standalone "Save section selection" button decoupled from the
 *     page-level Save (two save surfaces in one form was confusing)
 *   - A bare fetch() to /api/contracts/brief-sections that bypassed the
 *     shared api client (MT-101)
 *   - setTimeout(...5000) "Saved" reset that fired setState on unmounted
 *     components if the admin navigated away mid-save (MT-145)
 *
 * This component fixes all four:
 *   - Self-contained state (no parent coupling beyond the prop bag)
 *   - Auto-save on toggle (no Save button at all — matches the "one
 *     account-wide setting per toggle" mental model used by Slack /
 *     Teams webhook URLs elsewhere in Settings)
 *   - api.get / api.put for the two endpoint touches (auth header +
 *     refresh-token interceptor free)
 *   - useEffect with cleanup ref tracks unmount state so the deferred
 *     "saved" reset cannot setState after unmount
 *
 * Props (all required unless noted):
 *   disabled   boolean   — set true when AI is globally off, brief is
 *                          off at the account level, demo mode is on,
 *                          or the user isn't admin. Renders read-only.
 *   aiProvider string?   — current account AI provider slug. Used for the
 *                          per-toggle "Processed by:" disclosure microcopy.
 *   demoMode   boolean   — when true, server rejects the PUT with a
 *                          friendly demo-locked message; we also render an
 *                          inline "locked in demo" hint.
 *
 * Telemetry / debugging:
 *   The card publishes save state via inline microcopy ("Saving…",
 *   "Saved.", error message). There's no global notification ping — the
 *   save is small + local enough that inline feedback is the right
 *   surface.
 */

import { useEffect, useRef, useState } from 'react';
import api from '../api/client';

// (Pass-6 W3 MT-035 + MT-030) Provider labels for the per-toggle AI
// disclosure microcopy below. Mirrors AiConsentModal.PROVIDER_LABELS so
// the same legally meaningful name shows in both surfaces. Keep in sync
// when adding a provider to lib/ai.js.
const SECTION_PROVIDER_LABELS = {
  anthropic:    'Anthropic Claude',
  openai:       'OpenAI',
  azure_openai: 'Azure OpenAI (your Microsoft tenant)',
  gemini:       'Google Gemini',
  cloudflare:   'Cloudflare Workers AI',
  huggingface:  'Hugging Face Inference API',
  groq:         'Groq',
};

// (Pass-6 W3 MT-030) Per-section additional-data-categories disclosure.
// The always-on brief sends: product, vendor, dates, pricing, contract
// terms, notes, tags, renewal history (the AiConsentModal baseline).
// Each opt-in section augments that baseline -- this map names what
// additional fields leave the box when that toggle is enabled.
const SECTION_DATA_DISCLOSURES = {
  recommended_strategy:
    'Sends the always-on baseline (product, vendor, dates, pricing, notes, tags, renewal history). No additional fields.',
  license_utilization_analysis:
    'Adds licensed-seat count and active-seat count to the prompt context.',
  coterm_opportunities:
    'Adds vendor-scoped relationship notes (other active contracts with this vendor, their end-date proximity).',
  quote_request_hygiene:
    'Adds contract / customer / PO numbers to the prompt context (used to remind the team what to include in quote-request emails).',
  internal_stakeholder_map:
    'Adds department, contract owner name, and total contract value -- used to infer the likely sign-off ROLES (not named individuals). Output is suggestion-only.',
};

// Visual primitives copied from SettingsPage.jsx so this card looks
// pixel-identical to the rest of the page's toggle rows. Kept inline
// (not exported from a shared module) because Settings is the only
// surface using them today; if other admin pages adopt the same style
// later, lift these to a shared layout module.
const sectionHeading = {
  fontSize:    '1rem',
  fontWeight:  600,
  margin:      '0 0 0.5rem',
  color:       'var(--text-primary)',
};
const sectionDesc = {
  margin:    '0 0 1rem',
  fontSize:  '0.85rem',
  lineHeight: 1.5,
  color:     'var(--color-text-secondary)',
};
const toggleRow = {
  display:        'flex',
  alignItems:     'flex-start',
  justifyContent: 'space-between',
  gap:            '1rem',
  padding:        '0.6rem 0.75rem',
  border:         '1px solid var(--color-border)',
  borderRadius:   6,
  background:     'var(--color-surface-alt, transparent)',
};
const toggleTrack = {
  position:    'relative',
  flexShrink:  0,
  width:       42,
  height:      22,
  borderRadius: 11,
  transition:  'background 0.15s',
};
const toggleThumb = {
  position:    'absolute',
  top:         2,
  width:       18,
  height:      18,
  borderRadius: '50%',
  background:  '#fff',
  transition:  'transform 0.15s',
  boxShadow:   '0 1px 3px rgba(0,0,0,0.2)',
};

export default function RenewalBriefSectionsCard({ disabled = false, aiProvider, demoMode = false }) {
  // catalog: [{ slug, label, description, defaultOn }]
  // enabled: string[] (subset of catalog slugs)
  // pendingSaves: per-slug map of in-flight save promises so we don't fire
  //   overlapping requests if the user toggles fast.
  const [state, setState] = useState({
    catalog: [],
    enabled: [],
    hash:    '',
    loaded:  false,
    loadError: null,
  });
  // savingSlug holds the slug whose toggle is mid-save (or null when idle)
  // so we can render a per-row "Saving…" hint instead of a page-level one.
  const [savingSlug, setSavingSlug] = useState(null);
  // savedAt tracks the wall-clock time of the most recent successful save
  // — we render an inline "Saved a moment ago" indicator that auto-fades
  // after FADE_MS. The setTimeout that handles the fade is cleaned up on
  // unmount via the cleanup ref below (MT-145).
  const [savedAt, setSavedAt] = useState(null);
  const [error, setError]     = useState(null);
  const mountedRef = useRef(true);

  // Track unmount so deferred timeouts can't setState on a stale component.
  // This was the MT-145 fix surface — the previous implementation fired
  // setTimeout(setSaved=false, 5000) with no cleanup, so navigating away
  // from /settings within 5s of a save produced a React warning + state
  // leak. Setting mountedRef.current=false on unmount short-circuits the
  // setState call inside the deferred callback.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Initial fetch of the catalog + per-account enabled list.
  useEffect(() => {
    let cancelled = false;
    api.get('/api/contracts/brief-sections')
      .then((r) => {
        if (cancelled) return;
        const d = r.data?.data;
        if (d) {
          setState((prev) => ({
            ...prev,
            catalog: Array.isArray(d.catalog) ? d.catalog : [],
            enabled: Array.isArray(d.enabled) ? d.enabled : [],
            hash:    d.hash || '',
            loaded:  true,
          }));
        } else {
          setState((prev) => ({ ...prev, loaded: true }));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          loaded: true,
          loadError: err?.response?.data?.error || 'Could not load supplementary sections.',
        }));
      });
    return () => { cancelled = true; };
  }, []);

  // Auto-fade the "Saved." indicator after a couple of seconds. Tracked
  // via a ref-guarded setTimeout so unmount cancels cleanly.
  useEffect(() => {
    if (!savedAt) return undefined;
    const FADE_MS = 2500;
    const timer = setTimeout(() => {
      if (mountedRef.current) setSavedAt(null);
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [savedAt]);

  async function handleToggle(slug) {
    if (disabled) return;
    // Compute next-state optimistically so the user sees instant feedback.
    // Revert if the server rejects.
    const currentlyEnabled = state.enabled.includes(slug);
    const nextEnabled = currentlyEnabled
      ? state.enabled.filter((s) => s !== slug)
      : [...state.enabled, slug];

    setState((prev) => ({ ...prev, enabled: nextEnabled }));
    setSavingSlug(slug);
    setError(null);

    try {
      const r = await api.put('/api/contracts/brief-sections', { enabled: nextEnabled });
      const d = r.data;
      if (!mountedRef.current) return;
      if (d?.success) {
        setState((prev) => ({
          ...prev,
          enabled: Array.isArray(d.data?.enabled) ? d.data.enabled : prev.enabled,
          hash:    d.data?.hash || prev.hash,
        }));
        setSavedAt(new Date());
      } else {
        // Server returned success:false with a friendly error message.
        setState((prev) => ({ ...prev, enabled: currentlyEnabled ? [...prev.enabled, slug] : prev.enabled.filter((s) => s !== slug) }));
        setError(d?.error || 'Failed to save brief section settings.');
      }
    } catch (err) {
      if (!mountedRef.current) return;
      // Revert optimistic update.
      setState((prev) => ({
        ...prev,
        enabled: currentlyEnabled
          ? Array.from(new Set([...prev.enabled, slug]))
          : prev.enabled.filter((s) => s !== slug),
      }));
      setError(err?.response?.data?.error || 'Network error while saving.');
    } finally {
      if (mountedRef.current) setSavingSlug(null);
    }
  }

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={sectionHeading}>Renewal Brief Sections</h2>
      <p style={sectionDesc}>
        The renewal brief always includes Situation, Market, Tactics, and Watch For.
        {' '}Toggle these supplementary sections to add admin-driven extras. Changes
        {' '}invalidate cached briefs on the next view so the new selection takes effect
        {' '}without a manual refresh.
      </p>
      {/* (Pass-6 W3 MT-030) Account-level AI disclosure preamble. */}
      <p style={{ ...sectionDesc, marginTop: -8, fontSize: '0.82rem' }}>
        Enabling a section sends additional contract context to{' '}
        <strong>
          {SECTION_PROVIDER_LABELS[aiProvider] || aiProvider || 'the configured AI provider'}
        </strong>{' '}
        on every brief generation. Expand a toggle below to see exactly which
        fields. See{' '}
        <a href="/legal/privacy" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
          Privacy Policy section 4
        </a>{' '}
        for sub-processor coverage and retention.
      </p>

      {!state.loaded && (
        <p style={{ ...sectionDesc, fontStyle: 'italic' }}>Loading sections…</p>
      )}

      {state.loaded && state.loadError && (
        <p style={{ ...sectionDesc, color: 'var(--color-danger, #b00020)' }}>
          {state.loadError}
        </p>
      )}

      {state.loaded && !state.loadError && state.catalog.length === 0 && (
        <p style={{ ...sectionDesc, fontStyle: 'italic' }}>
          No supplementary sections available on this instance.
        </p>
      )}

      {state.loaded && state.catalog.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          {state.catalog.map((sec) => {
            const checked = state.enabled.includes(sec.slug);
            const isSaving = savingSlug === sec.slug;
            return (
              <label
                key={sec.slug}
                style={{
                  ...toggleRow,
                  opacity: disabled ? 0.5 : 1,
                  cursor:  disabled ? 'not-allowed' : 'pointer',
                }}
                onClick={() => !disabled && !isSaving && handleToggle(sec.slug)}
              >
                <div>
                  <div style={{ fontWeight: 600, color: 'var(--text-primary)', fontSize: '0.9rem' }}>
                    {sec.label}
                    {sec.defaultOn && (
                      <span style={{
                        color: 'var(--color-text-secondary)',
                        fontWeight: 400,
                        fontSize: '0.75rem',
                        marginLeft: 6,
                      }}>(on by default)</span>
                    )}
                    {isSaving && (
                      <span style={{
                        color: 'var(--color-text-secondary)',
                        fontWeight: 400,
                        fontSize: '0.75rem',
                        marginLeft: 6,
                      }}>· Saving…</span>
                    )}
                  </div>
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.8rem', marginTop: 2 }}>
                    {sec.description}
                  </div>
                  {/* (Pass-6 W3 MT-030) Per-toggle AI disclosure microcopy. */}
                  {checked && SECTION_DATA_DISCLOSURES[sec.slug] && (
                    <div
                      style={{
                        color: 'var(--color-text-secondary)',
                        fontSize: '0.75rem',
                        marginTop: 6,
                        paddingLeft: 8,
                        borderLeft: '2px solid var(--color-text-muted)',
                        lineHeight: 1.5,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>Processed by:</span>{' '}
                      {SECTION_PROVIDER_LABELS[aiProvider] || aiProvider || 'the configured AI provider'}
                      <br />
                      <span style={{ fontWeight: 600 }}>Data sent:</span>{' '}
                      {SECTION_DATA_DISCLOSURES[sec.slug]}
                    </div>
                  )}
                </div>
                <div
                  role="switch"
                  aria-checked={checked}
                  aria-label={sec.label}
                  aria-disabled={disabled || isSaving}
                  aria-busy={isSaving}
                  tabIndex={(disabled || isSaving) ? -1 : 0}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!disabled && !isSaving) handleToggle(sec.slug);
                  }}
                  onKeyDown={(e) => {
                    if (!disabled && !isSaving && (e.key === ' ' || e.key === 'Enter')) {
                      e.preventDefault();
                      handleToggle(sec.slug);
                    }
                  }}
                  style={{
                    ...toggleTrack,
                    background: checked ? 'var(--accent)' : 'var(--color-text-muted)',
                    cursor:     (disabled || isSaving) ? 'not-allowed' : 'pointer',
                    opacity:    (disabled || isSaving) ? 0.6 : 1,
                  }}
                >
                  <div style={{
                    ...toggleThumb,
                    transform: checked ? 'translateX(20px)' : 'translateX(2px)',
                  }} />
                </div>
              </label>
            );
          })}

          {/* Inline feedback row. No standalone Save button: changes
              auto-save on toggle. */}
          <div
            role="status"
            aria-live="polite"
            style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minHeight: 22, fontSize: '0.85rem' }}
          >
            {savedAt && !error && (
              <span style={{ color: 'var(--accent)' }}>Saved.</span>
            )}
            {error && (
              <span style={{ color: 'var(--color-danger, #b00020)' }}>{error}</span>
            )}
            {demoMode && (
              <span style={{ color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                Locked in demo mode — toggles are read-only.
              </span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
