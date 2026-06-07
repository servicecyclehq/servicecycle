/**
 * AskModal -- Ask LapseIQ in-product assistant.
 *
 * Single-turn Q&A surface backed by POST /api/ask. Conversation history
 * lives only in component state (no DB persistence, no session memory
 * across requests). Each /api/ask call is independent -- the server loads
 * the AI Guide as system context per request, so the assistant doesn't
 * "remember" prior turns; it just looks like a chat to the user.
 *
 * Renders responses as plain text with newlines preserved (whiteSpace:
 * pre-wrap). No markdown, no HTML -- keeps stored-XSS surface zero in v1.
 *
 * Closes on Escape or backdrop click. Enter submits; Shift+Enter inserts
 * a newline. Quota errors (402) and config errors (503) render distinctly
 * so the user knows whether to retry or wait for midnight UTC.
 *
 * v0.78.0 -- brief-context mode:
 *   When briefContext + contractName props are passed (from the brief card
 *   "Ask about this" button), every API call includes those values so the
 *   model can answer questions grounded in that specific contract's brief.
 *   The header changes to show which contract is being discussed.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import api from '../api/client';
import AiDisclaimer from './AiDisclaimer';
import AiCapHelper from './AiCapHelper';
import { useAiConsent } from '../context/AiConsentContext';

const MAX_QUESTION_CHARS = 4000;

export default function AskModal({ onClose, briefContext = null, contractName = null }) {
  const isBriefMode = !!(briefContext && briefContext.trim());

  // Conversation history for this session only.
  const [messages, setMessages]   = useState([]);
  const [input, setInput]         = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]         = useState('');
  const [quota, setQuota]         = useState(null);
  const [quotaExhausted, setQuotaExhausted] = useState(false);

  const scrollRef = useRef(null);
  const inputRef  = useRef(null);
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose });
  const { requestConsent } = useAiConsent();

  // Close on Escape.
  const handleKey = useCallback((e) => {
    if (e.key === 'Escape') onClose();
  }, [onClose]);
  useEffect(() => {
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleKey]);

  // Auto-scroll the message list to the bottom on new content.
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, submitting]);

  async function handleSubmit(e) {
    if (e) e.preventDefault();
    const question = input.trim();
    if (!question) return;
    if (submitting || quotaExhausted) return;
    requestConsent(() => doAsk(question));
  }

  async function doAsk(question) {
    const next = [...messages, { role: 'user', text: question }];
    setMessages(next);
    setInput('');
    setSubmitting(true);
    setError('');

    try {
      // v0.78.0: pass brief context when in brief-context mode
      const payload = { question };
      if (isBriefMode) {
        payload.briefContext = briefContext.trim();
        if (contractName) payload.contractName = contractName.trim().slice(0, 200);
      }
      const res  = await api.post('/api/ask', payload);
      const data = res.data?.data;
      const answer = data?.answer || '';
      if (data?.quota) setQuota(data.quota);
      setMessages([...next, { role: 'assistant', text: answer }]);
    } catch (err) {
      const status  = err.response?.status;
      const payload = err.response?.data;
      const msg     = payload?.error || 'Something went wrong. Please try again.';

      if (status === 402) {
        setQuotaExhausted(true);
        if (payload?.quota) setQuota(payload.quota);
        setMessages([...next, { role: 'assistant', text: msg, error: true, quota: true }]);
      } else if (status === 503) {
        setMessages([...next, { role: 'assistant', text: msg, error: true }]);
      } else if (status === 429) {
        setMessages([...next, { role: 'assistant', text: msg, error: true }]);
      } else if (status === 400) {
        setError(msg);
        setInput(question);
        setMessages(next.slice(0, -1));
      } else {
        setMessages([...next, { role: 'assistant', text: msg, error: true }]);
      }
    } finally {
      setSubmitting(false);
      if (inputRef.current && !quotaExhausted) inputRef.current.focus();
    }
  }

  function onTextareaKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const remaining = MAX_QUESTION_CHARS - input.length;
  const overLimit = remaining < 0;

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
        aria-label={isBriefMode ? `Ask about ${contractName || 'this contract'}` : 'Ask LapseIQ'}
        style={{
          position: 'fixed',
          bottom: 24, right: 24,
          width: 480, maxWidth: 'calc(100vw - 48px)',
          height: 600, maxHeight: 'calc(100vh - 96px)',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'calc(var(--radius) * 1.5)',
          boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          zIndex: 901, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px',
          borderBottom: '1px solid var(--color-border)',
          flex: '0 0 auto',
        }}>
          <div style={{ minWidth: 0, flex: 1, marginRight: 8 }}>
            <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, color: 'var(--color-text)', display: 'flex', alignItems: 'center', gap: 6 }}>
              Ask LapseIQ
              {isBriefMode && (
                <span style={{
                  fontSize: 'var(--font-size-xs)', fontWeight: 600,
                  background: 'var(--color-primary-subtle, #eff6ff)',
                  color: 'var(--color-primary, #2c63d6)',
                  border: '1px solid var(--color-primary-border, #bfdbfe)',
                  borderRadius: 4, padding: '1px 6px',
                  whiteSpace: 'nowrap',
                }}>
                  brief context
                </span>
              )}
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {isBriefMode
                ? `Asking about: ${contractName || 'this contract'}`
                : 'Product help and renewal-management practice. Single-turn — each question is independent.'}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--color-text-secondary)', padding: 4, borderRadius: 4, lineHeight: 1,
              flexShrink: 0,
            }}
            title="Close"
            aria-label="Close Ask LapseIQ"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 14, height: 14 }}>
              <line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/>
            </svg>
          </button>
        </div>

        {/* Conversation scroll area */}
        <div
          ref={scrollRef}
          style={{
            flex: '1 1 auto',
            overflowY: 'auto',
            padding: '14px 18px',
            background: 'var(--color-surface, #fafafa)',
          }}
        >
          {messages.length === 0 && (
            <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', lineHeight: 1.6 }}>
              {isBriefMode ? (
                <>
                  <p style={{ margin: '0 0 10px' }}>
                    The AI renewal brief for <strong style={{ color: 'var(--color-text)' }}>{contractName || 'this contract'}</strong> is loaded as context. Ask anything about this renewal.
                  </p>
                  <p style={{ margin: '0 0 6px', fontWeight: 600, color: 'var(--color-text)' }}>
                    Examples
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>What's my strongest leverage point going into this renewal?</li>
                    <li>How much runway do I have before the auto-renewal locks in?</li>
                    <li>What should my opening ask be given the renewal history?</li>
                  </ul>
                </>
              ) : (
                <>
                  <p style={{ margin: '0 0 10px' }}>
                    Ask about a LapseIQ feature, where to find something in the UI, or a renewal-management practice question.
                  </p>
                  <p style={{ margin: '0 0 6px', fontWeight: 600, color: 'var(--color-text)' }}>
                    Examples
                  </p>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    <li>How do I track savings on a contract I just negotiated?</li>
                    <li>What's the difference between review-by and cancel-by?</li>
                    <li>How should I handle a vendor that auto-renews at "current list price"?</li>
                  </ul>
                  <p style={{ margin: '14px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    Ask LapseIQ won't speak to security posture, compliance frameworks, legal interpretation, pricing, or competitor comparisons.
                  </p>
                </>
              )}
            </div>
          )}

          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                marginBottom: 12,
                display: 'flex',
                justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                style={{
                  maxWidth: '85%',
                  padding: '10px 12px',
                  borderRadius: 'var(--radius)',
                  fontSize: 'var(--font-size-ui)',
                  lineHeight: 1.55,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  background: m.role === 'user'
                    ? 'var(--color-primary, #2c63d6)'
                    : (m.error ? 'var(--color-error-bg, #fef2f2)' : 'var(--color-bg, #fff)'),
                  color: m.role === 'user'
                    ? '#fff'
                    : (m.error ? 'var(--color-error, #b91c1c)' : 'var(--color-text)'),
                  border: m.role === 'user'
                    ? 'none'
                    : `1px solid ${m.error ? 'var(--color-error-border, #fecaca)' : 'var(--color-border)'}`,
                }}
              >
                {m.text}
              </div>
            </div>
          ))}

          {submitting && (
            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <div
                style={{
                  padding: '10px 12px',
                  borderRadius: 'var(--radius)',
                  background: 'var(--color-bg, #fff)',
                  border: '1px solid var(--color-border)',
                  fontSize: 'var(--font-size-ui)',
                  color: 'var(--color-text-secondary)',
                  fontStyle: 'italic',
                }}
              >
                Thinking…
              </div>
            </div>
          )}
        </div>

        {/* Composer */}
        <form
          onSubmit={handleSubmit}
          style={{
            flex: '0 0 auto',
            padding: '12px 14px 12px',
            borderTop: '1px solid var(--color-border)',
            background: 'var(--color-bg)',
          }}
        >
          <AiDisclaimer variant="ask" compact style={{ marginBottom: 10 }} />

          {error && (
            <div role="alert" className="alert alert-error" style={{ marginBottom: 10, fontSize: 'var(--font-size-sm)' }}>
              {error}
            </div>
          )}

          <textarea
            ref={inputRef}
            autoFocus
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onTextareaKeyDown}
            placeholder={
              quotaExhausted
                ? 'Daily quota reached. Resets at midnight UTC.'
                : isBriefMode
                  ? `Ask a question about ${contractName || 'this contract'}…  (Enter to send, Shift+Enter for a new line)`
                  : 'Ask LapseIQ a question…  (Enter to send, Shift+Enter for a new line)'
            }
            disabled={submitting || quotaExhausted}
            maxLength={MAX_QUESTION_CHARS + 100}
            style={{
              width: '100%', boxSizing: 'border-box',
              minHeight: 60, maxHeight: 160, resize: 'vertical',
              padding: '8px 10px', fontSize: 'var(--font-size-ui)',
              border: `1px solid ${overLimit ? 'var(--color-error, #b91c1c)' : 'var(--color-border)'}`,
              borderRadius: 'var(--radius)',
              background: 'var(--color-surface)',
              color: 'var(--color-text)',
              fontFamily: 'inherit', lineHeight: 1.5,
              outline: 'none',
              opacity: (submitting || quotaExhausted) ? 0.6 : 1,
            }}
          />

          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginTop: 6, fontSize: 'var(--font-size-xs)',
            color: overLimit ? 'var(--color-error, #b91c1c)' : 'var(--color-text-secondary)',
          }}>
            <span>
              {quota && quota.cap !== null && Number.isFinite(quota.cap) && (
                <>Daily AI quota: {quota.count}/{quota.cap}</>
              )}
            </span>
            <span>
              {input.length} / {MAX_QUESTION_CHARS}
            </span>
          </div>

          <AiCapHelper action="ask" label="Ask LapseIQ questions" />

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting || quotaExhausted || !input.trim() || overLimit}
            >
              {submitting ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}