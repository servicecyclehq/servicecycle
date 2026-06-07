import { useState, useEffect, useCallback, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useFocusTrap } from '../hooks/useFocusTrap';
import api from '../api/client';

const ALL_CATEGORIES = [
  "Something's broken / I need help",
  'Feature request',
  'General feedback',
  'Security concern',
  'Billing or account question',
];

const VIEWER_CATEGORIES = [
  "Something's broken / I need help",
  'General feedback',
];

export default function FeedbackModal({ onClose }) {
  const { user, demoMode } = useAuth();
  const isViewer = user?.role === 'viewer';
  const categories = isViewer ? VIEWER_CATEGORIES : ALL_CATEGORIES;

  const [step, setStep]         = useState('category'); // 'category' | 'message'
  const [category, setCategory] = useState('');
  const [message, setMessage]   = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState('');

  // Pass-3 audit MUST #3: focus trap. Replaces the previous document-
  // -level keydown listener (which handled Escape only, didn't trap Tab,
  // and didn't restore focus on close). useFocusTrap covers all three.
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose });

  // Demo-only inline notice. Demo visitors see feedback collection is
  // active and forwarded; production self-hosted operators do not see
  // this because feedback is off-by-default for them.
  const demoNotice = demoMode ? (
    <div style={{
      padding: '10px 14px',
      margin: '0 0 12px',
      background: 'var(--color-bg-subtle, #f7f7f9)',
      border: '1px solid var(--color-border, #dde2eb)',
      borderLeft: '3px solid var(--color-accent, #6366f1)',
      borderRadius: 6,
      fontSize: 'var(--font-size-sm)',
      lineHeight: 1.5,
      color: 'var(--color-text-secondary, #4a5568)',
    }}>
      <strong>Demo notice:</strong> this is the LapseIQ demo. Feedback you
      submit here is forwarded to the LapseIQ team to improve the product.
      See the <a href="/legal/demo-sandbox-notice" target="_blank" rel="noreferrer">Demo Sandbox Notice</a> for full details.
    </div>
  ) : null;

  function selectCategory(cat) {
    setCategory(cat);
    setStep('message');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!message.trim()) { setError('Please add a message before submitting.'); return; }
    setError('');
    setSubmitting(true);
    try {
      await api.post('/api/feedback', {
        category,
        message: message.trim(),
        pageUrl: window.location.href,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
          zIndex: 900, backdropFilter: 'blur(2px)',
        }}
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Send Feedback"
        style={{
        position: 'fixed', bottom: 24, right: 24,
        width: 380, maxWidth: 'calc(100vw - 48px)',
        background: 'var(--color-bg)',
        border: '1px solid var(--color-border)',
        borderRadius: 'calc(var(--radius) * 1.5)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
        zIndex: 901, overflow: 'hidden',
      }}>

        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px 14px',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <div>
            <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, color: 'var(--color-text)' }}>Send Feedback</div>
            {step === 'message' && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{category}</div>
            )}
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4, borderRadius: 4, lineHeight: 1 }}
            title="Close"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px 20px' }}>

          {/* ── Success state ─────────────────────────────────────────────── */}
          {submitted && (
            <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
              <div style={{ fontSize: 'var(--font-size-3xl)', marginBottom: 10 }}>✓</div>
              <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>
                Thanks for the feedback
              </div>
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 20 }}>
                We'll look into it and follow up at <strong>{user?.email}</strong> if needed.
              </div>
              <button className="btn btn-secondary" onClick={onClose} style={{ width: '100%' }}>
                Close
              </button>
            </div>
          )}

          {/* ── Step 1: Category selection ────────────────────────────────── */}
          {!submitted && demoNotice}
          {!submitted && step === 'category' && (
            <div>
              <p style={{ margin: '0 0 14px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                What brings you here today?
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {categories.map(cat => (
                  <button
                    key={cat}
                    onClick={() => selectCategory(cat)}
                    style={{
                      textAlign: 'left', padding: '10px 14px',
                      background: 'var(--color-surface)',
                      border: '1px solid var(--color-border)',
                      borderRadius: 'var(--radius)',
                      fontSize: 'var(--font-size-ui)', fontWeight: 500, color: 'var(--color-text)',
                      cursor: 'pointer', transition: 'all 0.1s',
                    }}
                    onMouseEnter={e => {
                      e.currentTarget.style.borderColor = 'var(--color-primary)';
                      e.currentTarget.style.color = 'var(--color-primary)';
                    }}
                    onMouseLeave={e => {
                      e.currentTarget.style.borderColor = 'var(--color-border)';
                      e.currentTarget.style.color = 'var(--color-text)';
                    }}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2: Message ───────────────────────────────────────────── */}
          {!submitted && step === 'message' && (
            <form onSubmit={handleSubmit}>
              <textarea
                autoFocus
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder={
                  category === "Something's broken / I need help"
                    ? 'Describe what happened and what you were trying to do…'
                    : category === 'Feature request'
                    ? 'Describe the feature and how it would help you…'
                    : category === 'Security concern'
                    ? 'Describe the security issue you observed…'
                    : 'Your message…'
                }
                maxLength={5000}
                style={{
                  width: '100%', boxSizing: 'border-box',
                  minHeight: 110, resize: 'vertical',
                  padding: '10px 12px', fontSize: 'var(--font-size-ui)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius)',
                  background: 'var(--color-surface)',
                  color: 'var(--color-text)',
                  fontFamily: 'inherit', lineHeight: 1.5,
                  outline: 'none',
                }}
              />
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'right', marginTop: 4, marginBottom: 12 }}>
                {message.length} / 5000
              </div>

              {error && (
                <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => { setStep('category'); setError(''); }}
                  style={{ flex: '0 0 auto' }}
                >
                  Back
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={submitting || !message.trim()}
                  style={{ flex: 1 }}
                >
                  {submitting ? 'Sending…' : 'Send Feedback'}
                </button>
              </div>
            </form>
          )}

        </div>
      </div>
    </>
  );
}
