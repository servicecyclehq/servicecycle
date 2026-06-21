// ─────────────────────────────────────────────────────────────────────────────
// AuditFailureCard.jsx -- Phase 1 #1 "What will fail an audit" view.
//
// One ranked list of the findings an NFPA 70B auditor / insurer risk survey would
// most likely write up, aggregated from Path-to-100 gaps, undocumented-work
// evidence gaps, and drift/uncorrected findings. Headline = a readiness score.
//
// GET /api/compliance/audit-findings?siteId= -> { readiness, summary, findings[] }
// Props: { siteId?: string|null }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import api from '../api/client';

const SEV_META = {
  critical: { color: 'var(--chip-red-fg)', bg: 'var(--chip-red-bg)', label: 'Critical' },
  high:     { color: 'var(--chip-orange-fg)', bg: 'var(--chip-orange-bg)', label: 'High' },
  medium:   { color: 'var(--chip-amber-fg)', bg: 'var(--chip-amber-bg)', label: 'Medium' },
  low:      { color: 'var(--chip-green-fg)', bg: 'var(--chip-green-bg)', label: 'Low' },
};

function readinessColor(score) {
  if (score >= 90) return 'var(--color-success, #22c55e)';
  if (score >= 70) return 'var(--color-warning, #f59e0b)';
  return 'var(--color-danger, #dc2626)';
}

export default function AuditFailureCard({ siteId = null }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/audit-findings${siteId ? `?siteId=${siteId}` : ''}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load audit findings');
    } finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading audit-readiness view…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--chip-red-fg)' }}>{error}</div></div>;
  if (!data)   return null;

  const r = data.readiness || {};
  const s = data.summary || {};
  const sev = s.bySeverity || {};
  const scoreColor = readinessColor(r.score ?? 0);

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ShieldAlert size={18} />
        <div className="card-title" style={{ flex: 1 }}>What Will Fail an Audit</div>
        {!s.clean && (
          <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--chip-red-fg)' }}>
            {s.totalFindings} item{s.totalFindings === 1 ? '' : 's'} across {s.categories} finding{s.categories === 1 ? '' : 's'}
          </span>
        )}
      </div>
      <div className="card-body">
        {/* Headline readiness band. */}
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
          <div style={{ textAlign: 'center', minWidth: 96 }}>
            <div style={{ fontSize: 34, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{r.score ?? '—'}</div>
            <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>readiness · {r.levelLabel || '—'}</div>
          </div>
          {typeof r.documentedPct === 'number' && (
            <div style={{ textAlign: 'center', minWidth: 96 }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{r.documentedPct}%</div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>evidence on file</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {['critical', 'high', 'medium', 'low'].map((k) => (
              sev[k] > 0 ? (
                <span key={k} style={{ fontSize: 12, fontWeight: 700, color: SEV_META[k].color, background: SEV_META[k].bg, border: `1px solid ${SEV_META[k].color}33`, borderRadius: 6, padding: '3px 8px' }}>
                  {sev[k]} {SEV_META[k].label.toLowerCase()}
                </span>
              ) : null
            ))}
          </div>
        </div>

        {s.clean ? (
          <div style={{ color: 'var(--chip-green-fg)', fontSize: 'var(--font-size-sm)' }}>
            No likely audit findings detected. Coverage, on-time maintenance, evidence, and the written EMP all check out for this scope.
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
              Ranked by severity. Closing these is the fastest path to an audit-clean posture
              {typeof s.pointsToFull === 'number' && s.pointsToFull > 0 ? ` (+${s.pointsToFull} readiness points available)` : ''}.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {data.findings.map((f) => {
                const m = SEV_META[f.severity] || SEV_META.medium;
                return (
                  <div key={f.kind} style={{ padding: '10px 0', borderTop: '1px solid var(--color-border)' }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, color: m.color, background: m.bg, borderRadius: 4, padding: '2px 6px' }}>{m.label}</span>
                      <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)' }}>{f.title}</span>
                      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {f.count}{typeof f.pointsAtRisk === 'number' && f.pointsAtRisk > 0 ? ` · ${f.pointsAtRisk} pts` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', margin: '3px 0 4px' }}>{f.recommendation}</div>
                    {f.examples && f.examples.length > 0 && (
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {f.examples.map((ex, i) => (
                          <span key={i}>
                            {i > 0 ? ' · ' : ''}
                            {ex.assetId
                              ? <Link to={`/assets/${ex.assetId}`} style={{ color: 'var(--color-text)' }}>{ex.label}</Link>
                              : <span>{ex.label}</span>}
                            {ex.siteName ? <span> ({ex.siteName})</span> : ''}
                          </span>
                        ))}
                        {f.count > f.examples.length && <span> · +{f.count - f.examples.length} more</span>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
