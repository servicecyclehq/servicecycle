/**
 * AiConsentModal — Phase 4 (v0.4.0).
 *
 * H1-5 (v0.76.4): condensed from 4 dense paragraphs to a 2-bullet summary
 * with a "Learn more ▼" collapsible for full disclosure text. Demo caps
 * are shown inline in the bullet list when in demo mode.
 *
 * Two actions:
 *   - "I understand, continue" — acknowledges, runs the deferred AI action.
 *   - "Cancel" — closes the modal without running the action.
 */

import { useState, useRef } from 'react';
import { useAiConsent } from '../context/AiConsentContext';
import { useAuth } from '../context/AuthContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useAiUsage } from '../hooks/useAiUsage';

// v0.36.8 (Pass-6 W3 MT-035): human-readable provider labels for GDPR Art. 13.
const PROVIDER_LABELS = {
  anthropic:    'Anthropic Claude',
  openai:       'OpenAI',
  azure_openai: 'Azure OpenAI (your Microsoft tenant)',
  gemini:       'Google Gemini 2.0 Flash',
  cloudflare:   'Cloudflare Workers AI',
  huggingface:  'Hugging Face Inference API',
  groq:         'Groq',
};

export default function AiConsentModal() {
  const { isOpen, acknowledge, cancel } = useAiConsent();
  const { aiProvider, demoMode } = useAuth();
  const { usage } = useAiUsage({ enabled: isOpen });
  const dialogRef = useRef(null);
  const [showMore, setShowMore] = useState(false);
  useFocusTrap(dialogRef, { onClose: cancel });

  if (!isOpen) return null;

  const providerLabel = PROVIDER_LABELS[aiProvider] || aiProvider || 'the configured AI provider';
  const briefCap = usage?.actions?.brief?.cap;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-consent-title"
      aria-describedby="ai-consent-body"
      onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999, padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'var(--color-surface, #fff)',
          color: 'var(--color-text-primary, #111)',
          borderRadius: '8px',
          padding: '1.75rem',
          maxWidth: '480px',
          width: '100%',
          boxShadow: '0 10px 40px rgba(0,0,0,0.3)',
        }}
      >
        <h2
          id="ai-consent-title"
          style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1.1rem' }}
        >
          Before you use AI features
        </h2>

        <div id="ai-consent-body" style={{ fontSize: '0.9rem', lineHeight: 1.6 }}>
          {/* Two-bullet summary */}
          <ul style={{ margin: '0 0 0.75rem', paddingLeft: '1.2rem' }}>
            <li style={{ marginBottom: '0.4rem' }}>
              Your contract data is sent to <strong>{providerLabel}</strong> to generate
              the brief. No data is stored by the AI provider beyond the request.
            </li>
            {demoMode && briefCap != null && (
              <li>
                In demo mode, you have{' '}
                <strong>{briefCap} brief{briefCap !== 1 ? 's' : ''} per day</strong>{' '}
                (resets midnight UTC).
              </li>
            )}
          </ul>

          {/* "Learn more" collapsible */}
          <button
            type="button"
            onClick={() => setShowMore(s => !s)}
            style={{
              background: 'none', border: 'none', padding: 0,
              fontSize: '0.85rem',
              color: 'var(--color-primary, #0d4f6e)',
              cursor: 'pointer',
              textDecoration: 'underline',
              marginBottom: showMore ? '0.75rem' : 0,
            }}
          >
            {showMore ? 'Hide details ▲' : 'Learn more about AI privacy ▼'}
          </button>

          {showMore && (
            <div style={{ fontSize: '0.85rem', lineHeight: 1.55, color: 'var(--color-text-secondary, #555)' }}>
              <p style={{ margin: '0 0 0.6rem' }}>
                Information sent includes the product name, vendor, dates, pricing, contract
                terms, internal notes, tags, and renewal history for the contract you are
                working with.
              </p>
              {aiProvider === 'cloudflare' && (
                <p style={{ margin: '0 0 0.6rem' }}>
                  If Cloudflare Workers AI is temporarily unavailable, the same data may be
                  routed to <strong>Hugging Face</strong> or <strong>Groq</strong> as a
                  fallback. The data categories above apply to all three providers. See
                  Privacy Policy section 4 for details.
                </p>
              )}
              <p style={{ margin: '0 0 0.6rem' }}>
                If web-search enrichment is enabled, the contract's{' '}
                <strong>category</strong> (e.g. "SaaS", "Telecom") and the{' '}
                <strong>product name</strong> are sent to <strong>Tavily</strong> to look
                up recent market data. Vendor names, customer information, uploaded
                documents, and custom fields are NOT sent to Tavily.
              </p>
              <p style={{ margin: 0 }}>
                This message appears once per browser session as a reminder. You can turn
                it off permanently in Settings &rarr; AI &amp; Extraction.
              </p>

              {/* Demo mode daily cap disclosure (all action types) */}
              {demoMode && usage?.actions && (
                <div
                  style={{
                    marginTop: '0.75rem',
                    padding: '0.65rem 0.85rem',
                    background: 'var(--color-warning-bg, #fffbeb)',
                    border: '1px solid var(--color-warning, #b45309)',
                    borderRadius: '6px',
                    fontSize: '0.82rem',
                    lineHeight: 1.5,
                    color: 'var(--color-warning, #78350f)',
                  }}
                >
                  <strong>Demo mode — daily AI call limits per user:</strong>
                  <ul style={{ margin: '0.3rem 0 0.5rem 1rem', paddingLeft: 0 }}>
                    {usage.actions.extract?.cap != null && (
                      <li>PDF/image extraction: <strong>{usage.actions.extract.cap}/day</strong></li>
                    )}
                    {usage.actions.ask?.cap != null && (
                      <li>Ask ServiceCycle questions: <strong>{usage.actions.ask.cap}/day</strong></li>
                    )}
                    {usage.actions.brief?.cap != null && (
                      <li>Renewal brief generations: <strong>{usage.actions.brief.cap}/day</strong></li>
                    )}
                  </ul>
                  <a
                    href="https://servicecycle.com/install"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-primary, #0d4f6e)', textDecoration: 'underline', fontWeight: 600 }}
                  >
                    Self-host ServiceCycle to remove these caps and use your own AI key →
                  </a>
                </div>
              )}
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex', gap: '0.6rem',
            justifyContent: 'flex-end',
            marginTop: '1.5rem',
          }}
        >
          <button
            type="button"
            onClick={cancel}
            style={{
              padding: '0.55rem 1rem', fontSize: '0.9rem', fontWeight: 500,
              background: 'transparent', color: 'var(--color-text-secondary, #555)',
              border: '1px solid var(--color-border, #d0d0d0)',
              borderRadius: '6px', cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={acknowledge}
            autoFocus
            style={{
              padding: '0.55rem 1rem', fontSize: '0.9rem', fontWeight: 600,
              background: 'var(--color-primary, #1f6feb)',
              color: 'var(--color-surface)',
              border: 'none', borderRadius: '6px', cursor: 'pointer',
            }}
          >
            I understand — continue
          </button>
        </div>
      </div>
    </div>
  );
}
