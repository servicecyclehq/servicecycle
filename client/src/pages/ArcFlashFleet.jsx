// ArcFlashFleet.jsx — Arc Flash Fleet Dashboard (/reports/arc-flash-fleet).
// Cross-site rollup: DANGER %, label readiness, average data-confidence (2.8a),
// open sanity-check findings (2.8c), and expiring studies — the "where is my
// arc-flash risk across the whole portfolio" view. Manager/admin via the route.
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import BackLink from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function bandColor(score) {
  if (score == null) return 'var(--color-text-secondary)';
  return score >= 80 ? '#15803d' : score >= 50 ? '#b45309' : '#b91c1c';
}

export default function ArcFlashFleet() {
  useDocumentTitle('Arc Flash Fleet Dashboard');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/api/arc-flash/fleet')
      .then(r => setData(r.data?.data || null))
      .catch(() => setError('Failed to load the arc-flash fleet rollup.'))
      .finally(() => setLoading(false));
  }, []);

  const sites = data?.sites || [];
  const t = data?.totals;

  return (
    <div className="page-body">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 style={{ margin: '6px 0 0', fontSize: '1.3rem' }}>Arc Flash Fleet Dashboard</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            Arc-flash risk across every site: DANGER coverage, data confidence, sanity-check findings, and expiring studies. ServiceCycle is the data layer; a licensed PE runs and stamps the study.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print</button>
      </div>

      {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
      {loading && <div className="card" style={{ padding: 16 }}>Loading…</div>}

      {!loading && !error && (
        <>
          {t && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Tile label="Sites" value={t.sites} />
              <Tile label="Labelled buses" value={t.busCount} />
              <Tile label="DANGER buses" value={t.dangerCount} color="var(--color-danger)" />
              <Tile label="Avg confidence" value={t.avgConfidence == null ? '—' : `${t.avgConfidence}%`} color={bandColor(t.avgConfidence)} />
              <Tile label="Blocked buses" value={t.blockedCount} />
              <Tile label="Sanity errors" value={t.contradictionErrors} color={t.contradictionErrors > 0 ? 'var(--color-danger)' : undefined} />
              <Tile label="Studies expiring (90d)" value={t.expiringStudies} />
            </div>
          )}

          {sites.length === 0 ? (
            <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
              No arc-flash labels recorded yet. Upload a one-line or study report on a site, or bind a study to assets.
            </div>
          ) : (
            <table className="data-table" style={{ width: '100%', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  <th>Site</th><th>Buses</th><th>DANGER</th><th>Blocked</th>
                  <th>Avg confidence</th><th>Low confidence</th><th>Sanity (err / chk)</th>
                  <th>Studies</th><th>Expiring</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.siteId}>
                    <td>{s.siteId === 'unassigned' ? s.siteName : <Link to={`/sites/${s.siteId}`}>{s.siteName}</Link>}</td>
                    <td>{s.busCount}</td>
                    <td style={{ fontWeight: s.dangerCount > 0 ? 700 : 400, color: s.dangerCount > 0 ? 'var(--color-danger)' : 'inherit' }}>
                      {s.dangerCount} {s.busCount ? <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>({s.dangerPct}%)</span> : null}
                    </td>
                    <td style={{ color: s.blockedCount > 0 ? 'var(--color-warning)' : 'inherit' }}>{s.blockedCount}</td>
                    <td><span style={{ fontWeight: 700, color: bandColor(s.avgConfidence) }}>{s.avgConfidence == null ? '—' : `${s.avgConfidence}%`}</span></td>
                    <td style={{ color: s.lowConfidenceCount > 0 ? 'var(--color-danger)' : 'inherit' }}>{s.lowConfidenceCount}</td>
                    <td>
                      <span style={{ color: s.contradictionErrors > 0 ? 'var(--color-danger)' : 'inherit', fontWeight: s.contradictionErrors > 0 ? 700 : 400 }}>{s.contradictionErrors}</span>
                      {' / '}{s.contradictionWarnings}
                    </td>
                    <td>{s.studyCount}</td>
                    <td style={{ color: s.expiringStudies > 0 ? 'var(--color-danger)' : 'inherit' }}>{s.expiringStudies}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p style={{ marginTop: 14, fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
            Confidence is a deterministic 0–100 data-trust score (input completeness, study freshness, field verification, setting drift) — not a certification of the calculation. Sanity errors are physically impossible or under-protective values to fix before the label is trusted.
          </p>
        </>
      )}
    </div>
  );
}

function Tile({ label, value, color }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: color || 'var(--color-text)' }}>{value}</div>
    </div>
  );
}
