/**
 * #37 QEMW credential wallet — read-only roster + assignment-vs-requirement gap.
 *
 * Surfaces the whole-account technician credential picture (ANSI/NETA EMW-2026
 * QEMW + NETA ETT + 70E qualified-person + thermographer) and the coverage gap
 * ("N jobs in the next 30 days require a certified tech; M qualified available").
 * Read-only: no forms, so no focus-loss concerns — renders straight through.
 * Credential editing lives on the contractor detail page.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BadgeCheck, ShieldAlert, ShieldCheck } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const QEMW_STATUS_META = {
  valid:    { label: 'Valid',    color: '#15803d' },
  expiring: { label: 'Expiring', color: '#b45309' },
  expired:  { label: 'Expired',  color: '#b91c1c' },
  none:     { label: 'None',     color: '#6b7280' },
};

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString(); } catch { return '—'; }
}

export default function QemwWallet() {
  useDocumentTitle('QEMW Wallet');
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/api/contractors/qemw-wallet')
      .then((r) => setData(r.data?.data || null))
      .catch(() => setError('Failed to load the QEMW wallet.'))
      .finally(() => setLoading(false));
  }, []);

  const s = data?.summary;
  const techs = data?.techs || [];

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">QEMW credential wallet</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : `${s?.totalTechs ?? 0} technician${(s?.totalTechs ?? 0) !== 1 ? 's' : ''} · ANSI/NETA EMW-2026`}
          </div>
        </div>
        <button className="btn" onClick={() => navigate('/contractors')}>Back to contractors</button>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
        {loading && <div className="loading">Loading credential wallet…</div>}

        {!loading && s && (
          <>
            {/* Coverage gap banner */}
            {s.upcomingCertifiedJobs > 0 && (
              <div
                className="card mb-16"
                style={{ borderLeft: `4px solid ${s.hasCoverageGap ? '#b91c1c' : '#15803d'}`, padding: 16 }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {s.hasCoverageGap
                    ? <ShieldAlert size={18} color="#b91c1c" />
                    : <ShieldCheck size={18} color="#15803d" />}
                  <strong>
                    {s.upcomingCertifiedJobs} job{s.upcomingCertifiedJobs !== 1 ? 's' : ''} in the next {s.windowDays} days
                    require a certified technician; {s.qualifiedTechsAvailable} qualified tech
                    {s.qualifiedTechsAvailable !== 1 ? 's' : ''} available.
                  </strong>
                </div>
                {s.hasCoverageGap && (
                  <div style={{ marginTop: 6, color: 'var(--color-text-muted, #5b6373)', fontSize: 13 }}>
                    No technician currently holds a valid QEMW credential. ANSI/NETA EMW-2026 requires
                    QEMW-certified personnel for qualifying maintenance work — plan training or assign a
                    certified contractor.
                  </div>
                )}
                {s.requireQemw && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted, #5b6373)' }}>
                    REQUIRE_QEMW is enabled for this account.
                  </div>
                )}
              </div>
            )}

            {/* Status tiles */}
            <div className="card mb-16" style={{ padding: 16, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {[
                ['Valid', s.qemwValid, '#15803d'],
                ['Expiring', s.qemwExpiring, '#b45309'],
                ['Expired', s.qemwExpired, '#b91c1c'],
                ['No QEMW', s.qemwNone, '#6b7280'],
              ].map(([label, value, color]) => (
                <div key={label} style={{ textAlign: 'center', minWidth: 64 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted, #5b6373)' }}>{label}</div>
                </div>
              ))}
            </div>

            {techs.length === 0 ? (
              <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-muted, #5b6373)' }}>
                <BadgeCheck size={28} strokeWidth={1.5} style={{ marginBottom: 8 }} />
                <div>No technicians on file yet. Add techs and their credentials from a contractor's page.</div>
              </div>
            ) : (
              <div className="card">
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Technician</th>
                        <th>Contractor</th>
                        <th>NETA ETT</th>
                        <th>QEMW</th>
                        <th>Cert #</th>
                        <th>Expires</th>
                        <th>70E training</th>
                        <th>Thermographer</th>
                      </tr>
                    </thead>
                    <tbody>
                      {techs.map((t) => {
                        const meta = QEMW_STATUS_META[t.qemwStatus] || QEMW_STATUS_META.none;
                        return (
                          <tr key={t.id}>
                            <td>{t.name}{t.title ? <span style={{ color: '#6b7280' }}> · {t.title}</span> : null}</td>
                            <td>{t.contractorName || '—'}</td>
                            <td>{t.netaCertLevel ? String(t.netaCertLevel).replace('LEVEL_', 'Level ') : '—'}</td>
                            <td>
                              <span style={{ color: meta.color, fontWeight: 600 }}>{meta.label}</span>
                              {t.qemwStatus === 'expiring' && t.qemwDaysUntilExpiry != null
                                ? <span style={{ color: '#6b7280' }}> ({t.qemwDaysUntilExpiry}d)</span>
                                : null}
                            </td>
                            <td>{t.qemwCertNumber || '—'}</td>
                            <td>{fmtDate(t.qemwExpiresAt)}</td>
                            <td style={{ color: t.trainingStatus === 'expired' ? '#b91c1c' : t.trainingStatus === 'expiring' ? '#b45309' : 'inherit' }}>
                              {t.trainingStatus === 'unknown' ? '—' : t.trainingStatus}
                            </td>
                            <td>{t.thermographerCertLevel ? `Level ${t.thermographerCertLevel}` : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
