/**
 * BriefFeedbackWidget — per-section thumbs + optional comment for AI renewal briefs.
 *
 * Phase 4 — v0.4.0 (Layer A: local-only). Submits to POST
 * /api/template-feedback which writes a TemplateFeedback row scoped to
 * the caller's account. v0.4.1 will add opt-in upstream sync to a CF
 * Worker.
 *
 * Props:
 *   - contractId      (string, uuid)
 *   - categorySlug    (string, e.g. 'saas')
 *   - templateVersion (string, e.g. '1')
 *   - section         (one of 'situation' | 'market' | 'tactics' | 'watchFor')
 *
 * UX:
 *   1. Two thumb buttons (up / down). Click → expand inline textarea +
 *      Submit button. Textarea is optional — submitting with empty
 *      free-text is valid.
 *   2. Cancel collapses the textarea without submitting.
 *   3. After submission, the widget shows "Thanks!" and disables further
 *      input for THIS render of the section. Refreshing the page or
 *      regenerating the brief gives a fresh widget.
 *
 * Privacy note (roadmap §6.3): pre-submit UI warning reminds users not
 * to paste vendor names / customer details / contract numbers into the
 * free-text comment.
 */

import { useState } from 'react';
import api from '../api/client';

const SECTION_LABELS = {
  situation: 'Situation',
  market:    'Market',
  tactics:   'Tactics',
  watchFor:  'Watch For',
};

const FREE_TEXT_MAX = 1000;

export default function BriefFeedbackWidget({ contractId, categorySlug, templateVersion, section }) {
  // Pending rating: null (none yet) | true (up) | false (down)
  const [pending, setPending]       = useState(null);
  const [freeText, setFreeText]     = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted]   = useState(false);
  const [error, setError]           = useState('');

  const sectionLabel = SECTION_LABELS[section] || section;

  function pickThumb(rating) {
    if (submitted) return;
    setPending(rating);
    setError('');
  }

  function cancel() {
    setPending(null);
    setFreeText('');
    setError('');
  }

  async function submit() {
    if (pending === null || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await api.post('/api/template-feedback', {
        contractId,
        categorySlug,
        templateVersion,
        section,
        rating:   pending,
        freeText: freeText.trim() ? freeText.trim().slice(0, FREE_TEXT_MAX) : null,
      });
      setSubmitted(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit feedback.');
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <div style={{ marginTop: 8, fontSize: '0.8rem', color: 'var(--text-secondary, #666)' }}>
        Thanks — your feedback on the {sectionLabel} section has been recorded.
      </div>
    );
  }

  return (
    <div style={{ marginTop: 8 }}>
      {/* Always show the two thumb buttons unless we're already submitting. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary, #666)' }}>
          Was this {sectionLabel} section helpful?
        </span>
        <button
          type="button"
          aria-label={`Thumbs up on ${sectionLabel} section`}
          aria-pressed={pending === true}
          disabled={submitting}
          onClick={() => pickThumb(true)}
          style={{
            background:   pending === true ? 'var(--accent, #1f6feb)' : 'transparent',
            color:        pending === true ? '#fff' : 'var(--text-primary, #111)',
            border:       '1px solid var(--color-border, #d0d0d0)',
            borderRadius: 6,
            padding:      '0.2rem 0.55rem',
            fontSize:     '0.85rem',
            cursor:       submitting ? 'wait' : 'pointer',
          }}
        >
          👍
        </button>
        <button
          type="button"
          aria-label={`Thumbs down on ${sectionLabel} section`}
          aria-pressed={pending === false}
          disabled={submitting}
          onClick={() => pickThumb(false)}
          style={{
            background:   pending === false ? '#d33' : 'transparent',
            color:        pending === false ? '#fff' : 'var(--text-primary, #111)',
            border:       '1px solid var(--color-border, #d0d0d0)',
            borderRadius: 6,
            padding:      '0.2rem 0.55rem',
            fontSize:     '0.85rem',
            cursor:       submitting ? 'wait' : 'pointer',
          }}
        >
          👎
        </button>
      </div>

      {/* Expand the comment box once a thumb is selected. */}
      {pending !== null && (
        <div style={{ marginTop: 8 }}>
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value.slice(0, FREE_TEXT_MAX))}
            placeholder="Optional: what was missing or off? Don't include vendor names, customer details, or contract numbers — feedback stays local to your instance, but keeping it generic helps with future opt-in upstream sharing."
            rows={3}
            maxLength={FREE_TEXT_MAX}
            disabled={submitting}
            style={{
              width:        '100%',
              fontSize:     '0.85rem',
              padding:      '0.45rem 0.55rem',
              borderRadius: 6,
              border:       '1px solid var(--color-border, #d0d0d0)',
              resize:       'vertical',
              fontFamily:   'inherit',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary, #666)' }}>
              {freeText.length}/{FREE_TEXT_MAX}
              {' · '}feedback stays on this instance (v0.4.0 is local-only)
            </span>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={cancel}
                disabled={submitting}
                style={{
                  background:   'transparent',
                  color:        'var(--text-secondary, #555)',
                  border:       '1px solid var(--color-border, #d0d0d0)',
                  borderRadius: 6,
                  padding:      '0.35rem 0.75rem',
                  fontSize:     '0.8rem',
                  cursor:       submitting ? 'wait' : 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={submitting}
                style={{
                  background:   'var(--color-primary, #1f6feb)',
                  color: 'var(--color-surface)',
                  border:       'none',
                  borderRadius: 6,
                  padding:      '0.35rem 0.75rem',
                  fontSize:     '0.8rem',
                  fontWeight:   600,
                  cursor:       submitting ? 'wait' : 'pointer',
                  opacity:      submitting ? 0.6 : 1,
                }}
              >
                {submitting ? 'Submitting…' : 'Submit feedback'}
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 6, fontSize: '0.8rem', color: '#c33' }}>{error}</div>
      )}
    </div>
  );
}
