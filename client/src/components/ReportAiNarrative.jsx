// ─────────────────────────────────────────────────────────────────────────────
// ReportAiNarrative.jsx — v0.61.0 pilot
//
// Reusable banner that calls POST /api/reports/:reportId/narrate and renders
// the 2-3 sentence AI-generated summary above a report's KPI band. Gates on
// AiConsent (existing context) so first use surfaces the modal exactly once
// per session, matching every other AI-triggering surface in LapseIQ.
//
// Self-host operators with no AI provider configured (aiConfigured=false)
// see the banner replaced with a one-line "Configure AI in Settings" CTA.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, RotateCw, AlertTriangle, ChevronRight } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useAiConsent } from '../context/AiConsentContext';

export default function ReportAiNarrative({ reportId, params = {}, paramsKey }) {
  const { aiEnabled, aiConfigured } = useAuth();
  const navigate = useNavigate();
  const { requestConsent } = useAiConsent();

  const [state, setState] = useState({
    narrative: null,
    actions: [],
    provider: null,
    generatedAt: null,
    loading: false,
    error: null,
    capInfo: null,
  });

  // Serialize params for cache-busting and as a stable cache key. The caller
  // can override via explicit paramsKey for performance, otherwise we
  // JSON.stringify the params object.
  const key = useMemo(() => paramsKey ?? JSON.stringify(params || {}), [paramsKey, params]);

  const run = useCallback(() => {
    requestConsent(async () => {
      setState(s => ({ ...s, loading: true, error: null, capInfo: null }));
      try {
        const res = await api.post(`/api/reports/${reportId}/narrate`, params);
        const d = res?.data?.data;
        if (!d) throw new Error('Empty response from narrate endpoint.');
        setState({
          narrative: d.narrative || '',
          actions: Array.isArray(d.actions) ? d.actions : [],
          provider: d.provider || null,
          generatedAt: d.generatedAt || null,
          loading: false,
          error: null,
          capInfo: null,
        });
      } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;
        const msg = data?.error || err?.message || 'Failed to generate narrative.';
        const cap = status === 429 ? { cap: data?.cap, used: data?.used } : null;
        setState(s => ({ ...s, loading: false, error: msg, capInfo: cap }));
      }
    });
  }, [reportId, params, requestConsent]);

  // v0.61.1: click-to-generate. Auto-firing on mount would burn 1 AI call
  // per page visit regardless of user intent — at 50 demo visitors x 3
  // narrate-eligible reports that is 150 calls/day baseline against the
  // 1300/day shared aiBudgetGuard fuse. Click-to-generate matches every
  // other AI surface (Ask = type a question, Brief = click Generate,
  // Extract = upload a file). Param changes within a session still
  // auto-rerun, but ONLY after the user has generated at least one
  // narrative for this report (so changing the horizon chip on
  // Auto-Renewal Exposure stays smooth without front-loading the cost).
  useEffect(() => {
    if (!aiEnabled || !aiConfigured) return;
    if (state.narrative === null) return; // never auto-fire the first time
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportId, key, aiEnabled, aiConfigured]);

  // Render guards
  if (!aiEnabled) return null; // feature flag off — render nothing
  if (!aiConfigured) {
    // Self-host install without AI: friendly nudge, no scary error
    return (
      <div style={{
        margin: '0 0 16px', padding: '10px 14px',
        background: 'rgba(100,116,139,0.06)', border: '1px dashed var(--color-border)',
        borderRadius: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Sparkles size={14} />
        <span>
          AI narrative is available when an AI provider is configured.{' '}
          <button
            type="button"
            onClick={() => navigate('/settings?tab=ai')}
            style={{ background: 'none', border: 'none', color: 'var(--color-primary)', cursor: 'pointer',
                     textDecoration: 'underline', padding: 0, fontSize: 'inherit', fontFamily: 'inherit' }}
          >
            Configure AI →
          </button>
        </span>
      </div>
    );
  }

  const tone = state.error ? 'error' : state.loading ? 'loading' : state.narrative ? 'ok' : 'idle';
  const bg = tone === 'error' ? 'rgba(220,38,38,0.05)' : 'linear-gradient(135deg, rgba(13,79,110,0.06), rgba(8,145,178,0.04))';
  const border = tone === 'error' ? '1px solid rgba(220,38,38,0.25)' : '1px solid rgba(13,79,110,0.18)';

  return (
    <div style={{
      margin: '0 0 16px', padding: '14px 16px',
      background: bg, border,
      borderRadius: 8,
      display: 'flex', alignItems: 'flex-start', gap: 12,
    }}>
      <div style={{
        flexShrink: 0,
        width: 28, height: 28, borderRadius: 6,
        background: tone === 'error' ? '#fee2e2' : '#0d4f6e',
        color: tone === 'error' ? '#991b1b' : '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {tone === 'error' ? <AlertTriangle size={16} /> : <Sparkles size={16} />}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', alignItems: 'baseline', gap: 8,
          fontSize: 'var(--font-size-2xs)', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: tone === 'error' ? '#991b1b' : '#0d4f6e', marginBottom: 4,
        }}>
          <span>AI Summary</span>
          {state.provider && <span style={{ fontWeight: 500, color: 'var(--color-text-secondary)', textTransform: 'none', letterSpacing: 0 }}>
            via {state.provider}
          </span>}
        </div>

        {tone === 'idle' && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <span>Generate a 2-3 sentence summary of this report.</span>
            <button
              type="button"
              onClick={run}
              style={{
                background: '#0d4f6e', color: '#fff', border: 0,
                borderRadius: 4, padding: '5px 12px',
                fontSize: 'var(--font-size-sm)', fontWeight: 600, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              <Sparkles size={12} /> Generate AI summary
            </button>
          </div>
        )}

        {tone === 'loading' && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Synthesizing the report…
          </div>
        )}

        {tone === 'error' && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: '#991b1b', lineHeight: 1.5 }}>
            {state.error}
            {state.capInfo?.cap != null && (
              <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--font-size-xs)', color: '#7f1d1d' }}>
                Daily quota: {state.capInfo.used}/{state.capInfo.cap}. Resets at 00:00 UTC.
              </span>
            )}
          </div>
        )}

        {tone === 'ok' && (
          <>
            <div style={{ fontSize: 13.5, color: 'var(--color-text)', lineHeight: 1.55 }}>
              {state.narrative}
            </div>
            {/* v0.65.0: AI-recommended actions. Server validates each route
                against a whitelist; render up to 3 as clickable pills under
                the narrative. Tooltip = the action's "reason". */}
            {state.actions && state.actions.length > 0 && (
              <div style={{
                marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6,
              }}>
                {state.actions.map((a, i) => (
                  <button
                    key={i}
                    type="button"
                    title={a.reason || a.label}
                    onClick={() => navigate(a.route)}
                    style={{
                      background: 'var(--color-surface, #fff)',
                      border: '1px solid #0d4f6e',
                      color: '#0d4f6e',
                      borderRadius: 999,
                      padding: '4px 10px 4px 12px',
                      fontSize: 'var(--font-size-sm)', fontWeight: 600, cursor: 'pointer',
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                    }}
                  >
                    {a.label}
                    <ChevronRight size={12} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {tone !== 'idle' && (
        <div style={{
          marginTop: 8, fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
        }}>
          <span>AI-generated. May contain inaccuracies — verify against the data below before acting.</span>
          <button
            type="button"
            onClick={run}
            disabled={state.loading}
            style={{
              background: 'transparent', border: '1px solid var(--color-border)',
              borderRadius: 4, padding: '3px 8px',
              fontSize: 'var(--font-size-xs)', color: 'var(--color-text)', cursor: state.loading ? 'wait' : 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }}
          >
            <RotateCw size={11} style={{ animation: state.loading ? 'spin 1s linear infinite' : 'none' }} />
            {state.loading ? 'Generating…' : 'Regenerate'}
          </button>
        </div>
        )}
      </div>
    </div>
  );
}
