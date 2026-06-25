import { useState } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useAiConsent } from '../context/AiConsentContext';
import AiDisclaimer from './AiDisclaimer';

/**
 * MaintenanceBriefCard â€” AI maintenance recommendation + NFPA 70B
 * compliance summary for one asset.
 *
 * Self-contained: takes { asset }, owns all of its own state (no
 * persistence â€” the server doesn't cache briefs in v1, so a page reload
 * clears the output; that's intentional until the cache table lands).
 *
 * Gating (client-side mirror of the server gates â€” the server enforces
 * everything independently):
 *   - features.maintenance_brief  â†’ card hidden entirely when the user's
 *     feature flags don't grant the brief (viewer default).
 *   - aiEnabled && aiConfigured   â†’ card hidden when the instance has AI
 *     off or no provider key configured.
 *
 * Consent: the generate click routes through useAiConsent().requestConsent â€”
 * the provider either runs the call immediately (already acknowledged this
 * session / persistently silenced) or opens the app-level AiConsentModal
 * first and runs the call after acknowledgment. If the SERVER still answers
 * 403 ai_consent_required / ai_consent_outdated (e.g. consent-version
 * drift), we surface a retry hint â€” the next click re-walks the modal flow.
 *
 * Server endpoint: POST /api/assets/:id/brief â†’
 *   { success, data: { brief: { sections, generatedAt, model } } }
 * sections = { conditionAssessment, complianceStatus,
 *              recommendedActions: [{ action, rationale, standardRef, urgency }],
 *              riskSummary }
 */

const URGENCY_CHIPS = {
  immediate: {
    label: 'Immediate',
    color: 'var(--chip-red-fg)',   background: 'var(--chip-red-bg)',   border: '1px solid var(--chip-red-fg)',
  },
  next_outage: {
    label: 'Next outage',
    color: 'var(--chip-amber-fg)', background: 'var(--chip-amber-bg)', border: '1px solid var(--chip-amber-fg)',
  },
  next_cycle: {
    label: 'Next cycle',
    color: 'var(--chip-slate-fg)', background: 'var(--chip-slate-bg)', border: '1px solid var(--chip-slate-fg)',
  },
};

function UrgencyChip({ urgency }) {
  const chip = URGENCY_CHIPS[urgency] || URGENCY_CHIPS.next_cycle;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        textTransform: 'none',
        color: chip.color,
        background: chip.background,
        border: chip.border,
      }}
    >
      {chip.label}
    </span>
  );
}

function SectionHeading({ children }) {
  return (
    <div
      style={{
        fontSize: 'var(--font-size-xs)',
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: 'var(--color-text-secondary)',
        margin: '14px 0 6px',
      }}
    >
      {children}
    </div>
  );
}

export default function MaintenanceBriefCard({ asset }) {
  const { aiEnabled, aiConfigured, features } = useAuth();
  const { requestConsent } = useAiConsent();

  const [brief, setBrief]     = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);

  // Hidden entirely when the feature isn't granted or AI isn't available
  // on this instance â€” visible-but-blocked buttons are worse UX than
  // hidden ones (Cluster D audit rule).
  if (!features?.maintenance_brief || !aiEnabled || !aiConfigured) return null;
  if (!asset?.id) return null;

  const runGeneration = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.post(`/api/assets/${asset.id}/brief`);
      setBrief(res.data?.data?.brief || null);
    } catch (err) {
      const status = err.response?.status;
      const data   = err.response?.data;
      if (status === 429 && data?.error === 'ai_daily_cap_reached') {
        const { count, cap, resetAt } = data.data || {};
        const resetStr = resetAt ? new Date(resetAt).toLocaleString() : 'midnight UTC';
        setError(`Daily AI brief limit reached${cap ? ` (${count}/${cap})` : ''}. Resets at ${resetStr}.`);
      } else if (status === 429) {
        setError('Too many AI requests right now â€” please try again in a little while.');
      } else if (data?.error === 'ai_consent_required' || data?.error === 'ai_consent_outdated') {
        // Server-side consent drift (text or provider changed since last
        // acknowledgment). The next click re-runs the consent modal flow.
        setError('AI consent needs to be re-acknowledged â€” please click Generate again and accept the consent dialog.');
      } else if (data?.error === 'ai_brief_disabled_for_account') {
        setError('AI maintenance brief is disabled for this account. An admin can enable it in Settings.');
      } else if (status === 503) {
        setError(data?.message || 'AI is temporarily unavailable on this instance. Please try again later.');
      } else if (err.demoBlocked) {
        setError(null); // global demo banner already showed
      } else {
        setError(data?.message || data?.error || err.message || 'Failed to generate maintenance brief.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = () => {
    if (loading) return;
    // requestConsent either runs the action now (session already
    // acknowledged / silenced) or opens the app-level consent modal and
    // runs it after the user accepts.
    requestConsent(runGeneration);
  };

  const sections = brief?.sections;

  return (
    <div className="card mb-16">
      <div
        className="card-header"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div className="card-title">AI Maintenance Brief</div>
        {sections && !loading && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={handleGenerate}>
            Regenerate
          </button>
        )}
      </div>
      <div className="card-body">
        {!sections && !loading && (
          <div>
            <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
              Generate an AI maintenance recommendation and NFPA 70B compliance summary from this
              asset&apos;s schedules, work-order history, deficiencies, and lab samples.
            </div>
            <button type="button" className="btn btn-primary" onClick={handleGenerate}>
              Generate maintenance brief
            </button>
          </div>
        )}

        {loading && (
          <div
            role="status"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)',
              padding: '8px 0',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 14, height: 14, flexShrink: 0,
                border: '2px solid var(--color-border)',
                borderTopColor: 'var(--color-primary, #2563eb)',
                borderRadius: '50%',
                animation: 'spin 0.9s linear infinite',
              }}
            />
            <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
            Analyzing maintenance historyâ€¦
          </div>
        )}

        {error && !loading && (
          <div
            role="alert"
            style={{
              marginTop: sections ? 12 : 12,
              padding: '8px 12px',
              borderRadius: 8,
              background: 'var(--chip-red-bg)',
              border: '1px solid var(--chip-red-fg)',
              color: 'var(--chip-red-fg)',
              fontSize: 'var(--font-size-ui)',
            }}
          >
            {error}
          </div>
        )}

        {sections && !loading && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>
            <SectionHeading>Condition Assessment</SectionHeading>
            <p style={{ margin: 0, lineHeight: 1.55 }}>{sections.conditionAssessment}</p>

            <SectionHeading>NFPA 70B Compliance Status</SectionHeading>
            <p style={{ margin: 0, lineHeight: 1.55 }}>{sections.complianceStatus}</p>

            <SectionHeading>Recommended Actions</SectionHeading>
            {sections.recommendedActions?.length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {sections.recommendedActions.map((a, i) => (
                  <li
                    key={i}
                    style={{
                      padding: '10px 0',
                      borderBottom: i < sections.recommendedActions.length - 1
                        ? '1px solid var(--color-border)'
                        : 'none',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                      <UrgencyChip urgency={a.urgency} />
                      <span style={{ fontWeight: 600 }}>{a.action}</span>
                    </div>
                    {a.rationale && (
                      <div style={{ marginTop: 4, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                        {a.rationale}
                      </div>
                    )}
                    {a.standardRef && (
                      <div style={{ marginTop: 3, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted, var(--color-text-secondary))' }}>
                        Ref: {a.standardRef}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>
                No specific actions recommended.
              </p>
            )}

            <SectionHeading>Risk Summary</SectionHeading>
            <p style={{ margin: 0, lineHeight: 1.55 }}>{sections.riskSummary}</p>

            <div
              style={{
                marginTop: 14,
                fontSize: 'var(--font-size-xs)',
                color: 'var(--color-text-secondary)',
              }}
            >
              Generated {brief.generatedAt ? new Date(brief.generatedAt).toLocaleString() : ''}
              {brief.model ? ` Â· ${brief.model}` : ''}
              {' Â· Not persisted â€” regenerate after new test results are entered.'}
            </div>

            <AiDisclaimer variant="maintenanceBrief" compact style={{ marginTop: 10 }} />
          </div>
        )}
      </div>
    </div>
  );
}
