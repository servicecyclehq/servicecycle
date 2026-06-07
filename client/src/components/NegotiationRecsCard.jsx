/**
 * NegotiationRecsCard — AI Debate Engine output
 *
 * v0.79.0: Full adversarial analysis engine (5 AI personas + deterministic
 * verdict). Calls:
 *   GET  /api/contracts/:id/negotiation-analysis/status  — cache check on mount
 *   POST /api/contracts/:id/negotiation-analysis         — run or serve cached debate
 *
 * UI states:
 *   idle (no cache)  → "Run Full Analysis" button
 *   idle (cached)    → "View Analysis" + "↻ Re-run" button
 *   loading          → spinner
 *   result           → verdict badge + synthesis + actions + persona summaries
 *   error / quota    → inline alert
 *
 * The old /negotiate quick-analysis card is preserved as NegotiationRecsCardV1
 * for accounts that haven't enabled the debate engine yet.
 */

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import AiDisclaimer from './AiDisclaimer';
import AiCapHelper from './AiCapHelper';
import { useAiConsent } from '../context/AiConsentContext';

// ---------------------------------------------------------------------------
// Verdict config
// ---------------------------------------------------------------------------
const VERDICT_CONFIG = {
  RENEW:        { label: 'Renew',        bg: '#f0fdf4', color: '#166534', border: '#bbf7d0', dot: '#22c55e' },
  RENEGOTIATE:  { label: 'Renegotiate',  bg: '#eff6ff', color: '#1d4ed8', border: '#bfdbfe', dot: '#3b82f6' },
  REDUCE:       { label: 'Reduce Scope', bg: '#fffbeb', color: '#92400e', border: '#fde68a', dot: '#f59e0b' },
  REPLACE:      { label: 'Replace',      bg: '#fef3c7', color: '#78350f', border: '#fcd34d', dot: 'var(--color-warning)' },
  RETIRE:       { label: 'Retire',       bg: '#fef2f2', color: '#b91c1c', border: '#fecaca', dot: '#ef4444' },
};

const TIER_LABEL = { 1: 'Hard override', 2: 'Scored', 3: 'Default' };

function VerdictBadge({ verdict }) {
  const cfg = VERDICT_CONFIG[verdict] || VERDICT_CONFIG.RENEGOTIATE;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '4px 14px', borderRadius: 14,
      background: cfg.bg, color: cfg.color,
      border: `1.5px solid ${cfg.border}`,
      fontSize: 'var(--font-size-ui)', fontWeight: 800, letterSpacing: '0.03em',
    }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: cfg.dot }} />
      {cfg.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------
function Section({ title, color = 'var(--color-text-secondary)', children }) {
  return (
    <div>
      <div style={{
        fontSize: 'var(--font-size-xs)', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.08em', color, marginBottom: 8,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ActionRow({ action }) {
  return (
    <div style={{
      padding: '10px 12px',
      background: 'var(--color-primary-subtle, #eff6ff)',
      border: '1px solid var(--color-primary-border, #bfdbfe)',
      borderRadius: 'var(--radius)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{
          fontSize: 'var(--font-size-xs)', fontWeight: 800, color: 'var(--color-primary, #2c63d6)',
          background: 'var(--color-primary-border, #bfdbfe)',
          borderRadius: 8, padding: '1px 7px', flexShrink: 0,
        }}>
          {action.rank}
        </span>
        <span style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)', lineHeight: 1.4 }}>
          {action.action}
        </span>
      </div>
      <div style={{ paddingLeft: 28, display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
        {action.deadline && <span>⏱ {action.deadline}</span>}
        {action.owner    && <span>{action.owner}</span>}
      </div>
      {action.consequence_of_inaction && (
        <div style={{ paddingLeft: 28, fontSize: 'var(--font-size-sm)', color: '#b91c1c', lineHeight: 1.4, fontStyle: 'italic' }}>
          If ignored: {action.consequence_of_inaction}
        </div>
      )}
    </div>
  );
}

function RiskChip({ risk }) {
  const sev = risk.severity || 'low';
  const sevColor = { critical: '#b91c1c', high: '#92400e', medium: 'var(--color-warning)', low: '#166534' };
  return (
    <div style={{
      padding: '7px 10px',
      border: `1px solid var(--color-border)`,
      borderLeft: `3px solid ${sevColor[sev] || '#6b7280'}`,
      borderRadius: 'var(--radius)',
      fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', lineHeight: 1.4,
      display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
    }}>
      <span>{risk.risk}</span>
      <span style={{
        fontSize: 'var(--font-size-2xs)', fontWeight: 700, textTransform: 'uppercase',
        color: sevColor[sev] || '#6b7280', flexShrink: 0,
        padding: '1px 6px', borderRadius: 6,
        background: sev === 'critical' ? '#fef2f2' : sev === 'high' ? '#fffbeb' : sev === 'medium' ? '#fefce8' : '#f0fdf4',
      }}>
        {sev}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Defensive text coercion
// ---------------------------------------------------------------------------
// The synthesisDirector prompt asks for executive_summary as "Three paragraphs"
// and the AI sometimes returns {paragraph1, paragraph2, paragraph3} instead of
// a flat string. Without coercion this triggers React error #31 ("objects are
// not valid as a React child") and ErrorBoundary surfaces as "Something went
// wrong". asText() and <Paragraphs> normalize both shapes.
function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join('\n\n');
  if (typeof v === 'object') {
    const paraKeys = Object.keys(v)
      .filter(k => /^paragraph\d+$/i.test(k))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (paraKeys.length > 0) return paraKeys.map(k => asText(v[k])).filter(Boolean).join('\n\n');
    if (typeof v.text    === 'string') return v.text;
    if (typeof v.content === 'string') return v.content;
    if (typeof v.body    === 'string') return v.body;
  }
  return String(v);
}
function Paragraphs({ text }) {
  const flat = asText(text);
  if (!flat) return null;
  const paras = flat.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
  if (paras.length <= 1) return <>{flat}</>;
  return (
    <>
      {paras.map((p, i) => (
        <div key={i} style={{ marginBottom: i < paras.length - 1 ? 10 : 0 }}>{p}</div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Full analysis result renderer
// ---------------------------------------------------------------------------
function DebateResult({ data, onRerun }) {
  const { verdictResult, synthesis, confidenceFlags, generatedAt } = data;
  const vr = verdictResult || {};
  const sy = synthesis   || {};

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* Verdict row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <VerdictBadge verdict={vr.verdict} />
          {vr.tier && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              {TIER_LABEL[vr.tier] || ''} · score {vr.score ?? 0}
            </span>
          )}
          {vr.tied_with && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-warning)' }}>
              near-tie with {vr.tied_with}
            </span>
          )}
        </div>
        <button
          className="btn btn-ghost"
          onClick={onRerun}
          style={{ fontSize: 'var(--font-size-sm)', padding: '4px 10px', color: 'var(--color-text-secondary)' }}
        >
          ↻ Re-run
        </button>
      </div>

      {/* Board one-liner */}
      {sy.board_one_liner && (
        <div style={{
          fontSize: 'var(--font-size-base)', fontWeight: 600, color: 'var(--color-text)',
          padding: '10px 14px',
          background: 'var(--color-bg-secondary, #f8fafc)',
          borderRadius: 'var(--radius)',
          borderLeft: '3px solid var(--color-primary, #2c63d6)',
        }}>
          <Paragraphs text={sy.board_one_liner} />
        </div>
      )}

      {/* Executive summary */}
      {sy.executive_summary && (
        <Section title="Executive Summary">
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', lineHeight: 1.65 }}>
            <Paragraphs text={sy.executive_summary} />
          </div>
        </Section>
      )}

      {/* Priority actions */}
      {sy.priority_actions?.length > 0 && (
        <Section title="Priority Actions" color="#1d4ed8">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {sy.priority_actions.map((a, i) => <ActionRow key={i} action={a} />)}
          </div>
        </Section>
      )}

      {/* What vendor knows */}
      {sy.what_vendor_knows && (
        <Section title="What the Vendor Knows" color="#78350f">
          <div style={{
            fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', lineHeight: 1.6,
            padding: '10px 12px',
            background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 'var(--radius)',
          }}>
            <Paragraphs text={sy.what_vendor_knows} />
          </div>
        </Section>
      )}

      {/* Key risks */}
      {sy.key_risks_to_surface?.length > 0 && (
        <Section title="Key Risks" color="#b91c1c">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sy.key_risks_to_surface.map((r, i) => <RiskChip key={i} risk={r} />)}
          </div>
        </Section>
      )}

      {/* Negotiation posture */}
      {sy.negotiation_posture && (
        <Section title="Negotiation Posture">
          <div style={{
            fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', lineHeight: 1.6,
            padding: '10px 12px',
            background: 'var(--color-bg-secondary, #f8fafc)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)',
          }}>
            <Paragraphs text={sy.negotiation_posture} />
          </div>
        </Section>
      )}

      {/* Dissenting signals */}
      {sy.dissenting_signals?.length > 0 && (
        <Section title="Where the Analysis Disagrees" color="#6b7280">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {sy.dissenting_signals.map((d, i) => (
              <div key={i} style={{
                fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5,
                padding: '8px 10px', background: 'var(--color-bg-secondary, #f8fafc)',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
              }}>
                <strong style={{ color: 'var(--color-text)' }}>{d.dimension}:</strong>{' '}
                {Array.isArray(d.positions) ? d.positions.join(' vs ') : d.positions}
                {d.recommended_stance_under_uncertainty && (
                  <div style={{ marginTop: 3, fontStyle: 'italic' }}>
                    Stance: {d.recommended_stance_under_uncertainty}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* Confidence flags */}
      {confidenceFlags?.length > 0 && sy.confidence_statement && (
        <div style={{
          fontSize: 'var(--font-size-sm)', color: '#92400e', lineHeight: 1.5,
          padding: '8px 12px', background: '#fffbeb',
          border: '1px solid #fde68a', borderRadius: 'var(--radius)',
        }}>
          ⚠ {sy.confidence_statement}
        </div>
      )}

      {/* Footer */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <AiDisclaimer variant="brief" compact />
        {generatedAt && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            Generated {new Date(generatedAt).toLocaleDateString()}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main card
// ---------------------------------------------------------------------------
export default function NegotiationRecsCard({ contractId }) {
  const [result,    setResult]    = useState(null);
  const [loading,   setLoading]   = useState(false);
  const [error,     setError]     = useState('');
  const [quotaMsg,  setQuotaMsg]  = useState('');
  const [cacheInfo, setCacheInfo] = useState(null); // { cached, verdict, generatedAt }
  const { requestConsent } = useAiConsent();

  // Check cache on mount
  useEffect(() => {
    let cancelled = false;
    api.get(`/api/contracts/${contractId}/negotiation-analysis/status`)
      .then(res => { if (!cancelled) setCacheInfo(res.data?.data || { cached: false }); })
      .catch(() => { if (!cancelled) setCacheInfo({ cached: false }); });
    return () => { cancelled = true; };
  }, [contractId]);

  const runDebate = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError('');
    setQuotaMsg('');

    try {
      const res  = await api.post(`/api/contracts/${contractId}/negotiation-analysis`, { forceRefresh });
      const data = res.data?.data;
      setResult(data);
      setCacheInfo({ cached: true, verdict: data.verdictResult?.verdict, generatedAt: data.generatedAt });
    } catch (err) {
      const status  = err.response?.status;
      const payload = err.response?.data;
      if (status === 402) {
        setQuotaMsg('Daily AI quota reached. Resets at midnight UTC.');
      } else if (status === 403 && payload?.error === 'ai_consent_required') {
        // consent modal handles this
      } else {
        setError(payload?.error || payload?.message || 'Analysis failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  function handleRun(forceRefresh = false) {
    if (loading) return;
    requestConsent(() => runDebate(forceRefresh));
  }

  const hasCachedResult = cacheInfo?.cached && !result;

  return (
    <div id="cd-negotiate" className="card mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
      <div className="card-body">

        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: result ? 16 : 0, gap: 8, flexWrap: 'wrap' }}>
          <div>
            <div className="card-title" style={{ marginBottom: 2 }}>
              Renewal Analysis
            </div>
            {!result && (
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {hasCachedResult
                  ? `Cached analysis available — verdict: ${cacheInfo.verdict || '…'}`
                  : '5-persona adversarial analysis engine: leverage · market · risk · vendor · synthesis.'}
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
            {hasCachedResult && (
              <button
                className="btn btn-secondary"
                onClick={() => handleRun(false)}
                disabled={loading}
                style={{ fontSize: 'var(--font-size-ui)', padding: '5px 12px' }}
              >
                View Analysis
              </button>
            )}
            {result && (
              <button
                className="btn btn-ghost"
                onClick={() => handleRun(true)}
                disabled={loading}
                style={{ fontSize: 'var(--font-size-sm)', padding: '4px 10px', color: 'var(--color-text-secondary)' }}
              >
                ↻ Re-run
              </button>
            )}
            {!hasCachedResult && !result && (
              <button
                className="btn btn-primary"
                onClick={() => handleRun(false)}
                disabled={loading || cacheInfo === null}
                style={{ fontSize: 'var(--font-size-ui)', padding: '5px 12px', whiteSpace: 'nowrap' }}
              >
                {loading ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg style={{ width: 13, height: 13, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10" />
                    </svg>
                    Analyzing…
                  </span>
                ) : 'Run Analysis'}
              </button>
            )}
          </div>
        </div>

        {/* Loading state */}
        {loading && !result && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '24px 0', color: 'var(--color-text-secondary)' }}>
            <svg style={{ width: 24, height: 24, animation: 'spin 1s linear infinite' }} viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4" strokeDashoffset="10" />
            </svg>
            <div style={{ fontSize: 'var(--font-size-ui)' }}>Running 5-persona analysis engine…</div>
            <div style={{ fontSize: 'var(--font-size-sm)' }}>This takes ~30–60 seconds</div>
          </div>
        )}

        {/* Errors */}
        {error    && <div role="alert" className="alert alert-error"   style={{ marginTop: 12, fontSize: 'var(--font-size-ui)' }}>{error}</div>}
        {quotaMsg && <div role="alert" className="alert alert-warning" style={{ marginTop: 12, fontSize: 'var(--font-size-ui)' }}>{quotaMsg}</div>}

        {/* Pre-run disclaimer */}
        {!result && !loading && !error && !quotaMsg && cacheInfo !== null && !hasCachedResult && (
          <div style={{ marginTop: 12 }}>
            <AiDisclaimer variant="brief" compact />
            <AiCapHelper action="negotiation-analysis" label="Full renewal analysis" />
          </div>
        )}

        {/* Full analysis result */}
        {result && <DebateResult data={result} onRerun={() => handleRun(true)} />}

      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}