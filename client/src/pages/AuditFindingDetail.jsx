// ─────────────────────────────────────────────────────────────────────────────
// AuditFindingDetail.jsx — full drill-down for one "What Will Fail an Audit"
// finding (/reports/audit-findings/:kind?siteId=).
//
// 2026-07-13 fix: AuditFailureCard (on /reports/compliance) showed 5 example
// assets per finding + a plain "+N more" text with nowhere to go — Dustin's
// live-review call: "what are the 44 more? I can't easily get to them... we
// want to be the data layer, and to be the data layer we need the data
// SIMPLE to get to." This page is that destination: every row in the card
// (title + count, and the "+N more" text) now links here, and the server
// returns the FULL unsliced examples list for the one requested `kind` via
// GET /api/compliance/audit-findings?fullKind=<kind> (see auditFindings.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ShieldAlert } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import BackLink from '../components/BackLink';
import EmptyState from '../components/EmptyState';

const SEV_META = {
  critical: { color: 'var(--chip-red-fg)', bg: 'var(--chip-red-bg)', label: 'Critical' },
  high:     { color: 'var(--chip-orange-fg)', bg: 'var(--chip-orange-bg)', label: 'High' },
  medium:   { color: 'var(--chip-amber-fg)', bg: 'var(--chip-amber-bg)', label: 'Medium' },
  low:      { color: 'var(--chip-green-fg)', bg: 'var(--chip-green-bg)', label: 'Low' },
};

export default function AuditFindingDetail() {
  const { kind } = useParams();
  const [searchParams] = useSearchParams();
  const siteId = searchParams.get('siteId') || '';

  useDocumentTitle('Audit finding');

  const [finding, setFinding] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let on = true;
    setLoading(true);
    setError('');
    setNotFound(false);
    const params = { fullKind: kind };
    if (siteId) params.siteId = siteId;
    api.get('/api/compliance/audit-findings', { params })
      .then(r => {
        if (!on) return;
        const f = (r.data?.data?.findings || []).find(x => x.kind === kind);
        if (!f) { setNotFound(true); setFinding(null); }
        else setFinding(f);
      })
      .catch(err => { if (on) setError(err.response?.data?.error || 'Failed to load this finding.'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, [kind, siteId]);

  const m = finding ? (SEV_META[finding.severity] || SEV_META.medium) : null;

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports/compliance" fallbackLabel="Compliance by Standard" />
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <ShieldAlert size={20} strokeWidth={1.75} />
            {finding?.title || 'Audit finding'}
          </h1>
          {finding?.standardRef && <div className="page-subtitle">{finding.standardRef}</div>}
        </div>
      </div>

      <div className="page-body">
        {loading && <div className="loading">Loading…</div>}
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {!loading && notFound && !error && (
          <div className="card">
            <EmptyState
              icon={ShieldAlert}
              title="This finding is no longer open"
              sub="Either the underlying issue has been resolved since you last looked, or the link is out of date. Head back to Compliance by Standard for the current list."
            />
          </div>
        )}

        {!loading && finding && (
          <>
            <div className="card mb-16">
              <div className="card-body" style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5,
                  color: m.color, background: m.bg, borderRadius: 5, padding: '3px 8px',
                }}>
                  {m.label}
                </span>
                <div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>
                    {finding.count} item{finding.count === 1 ? '' : 's'}
                    {typeof finding.pointsAtRisk === 'number' && finding.pointsAtRisk > 0 && (
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-secondary)', marginLeft: 8 }}>
                        · {finding.pointsAtRisk} readiness pts available
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    {finding.recommendation}
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                {/* 2026-07-13 (pre-go-live review, nice-to-have #4): undocumented_work
                    groups its examples by ASSET (each row can bundle several
                    undocumented items), while every other finding kind lists one
                    example per item -- exampleUnit says which this is so the
                    header doesn't overclaim "item" for an asset-grouped list. */}
                <div className="card-title">
                  Every matching {finding.exampleUnit === 'asset' ? 'asset' : 'item'}
                  {(finding.examples?.length ?? 0) === 1 ? '' : 's'} ({finding.examples?.length ?? 0})
                </div>
              </div>
              {!finding.examples || finding.examples.length === 0 ? (
                <div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>
                  No item-level detail is available for this finding.
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Asset</th>
                        <th>Site</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {finding.examples.map((ex, i) => (
                        <tr key={ex.assetId || i}>
                          <td style={{ fontWeight: 600 }}>
                            {ex.assetId
                              ? <Link to={`/assets/${ex.assetId}`} style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>{ex.label}</Link>
                              : ex.label}
                          </td>
                          <td className="td-muted">{ex.siteName || '—'}</td>
                          <td className="td-muted">{ex.detail || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
