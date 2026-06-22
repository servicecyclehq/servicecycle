// ArcFlashReport.jsx — Arc Flash Label Report (/reports/arc-flash).
// Every current (non-superseded) NFPA 70E 130.5(H) label across the account:
// nominal voltage, incident energy, arc-flash boundary, PPE / min arc rating,
// DANGER/WARNING severity, study date + expiry. Printable label schedule for
// auditors / insurers. Manager / admin gated by the route.
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import BackLink from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function fmtDate(d) { try { return d ? new Date(d).toLocaleDateString() : '—'; } catch { return '—'; } }
function n(v) { return (v == null || v === '') ? '—' : String(v); }
function sevColor(s) { return s === 'danger' ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)'; }
function bandColor(score) { return score == null ? 'var(--color-text-secondary)' : score >= 80 ? '#15803d' : score >= 50 ? '#b45309' : '#b91c1c'; }

// Print stylesheet: drop the app chrome + interactive controls, tighten the table
// so the label schedule prints as a clean one-page-per-section document.
const PRINT_CSS = `@media print {
  .no-print { display: none !important; }
  .page-body { padding: 0 !important; }
  .data-table { font-size: 0.7rem !important; }
  .data-table th, .data-table td { padding: 3px 6px !important; }
  a { color: inherit !important; text-decoration: none !important; }
}`;

export default function ArcFlashReport() {
  useDocumentTitle('Arc Flash Label Report');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyDanger, setOnlyDanger] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/api/arc-flash/report')
      .then(r => setData(r.data?.data || null))
      .catch(() => setError('Failed to load the arc-flash report.'))
      .finally(() => setLoading(false));
  }, []);

  const rows = useMemo(() => {
    const all = data?.rows || [];
    const filtered = onlyDanger ? all.filter(r => r.labelSeverity === 'danger') : all;
    return filtered.slice().sort((a, b) => (b.incidentEnergyCalCm2 || 0) - (a.incidentEnergyCalCm2 || 0));
  }, [data, onlyDanger]);

  const s = data?.summary;

  return (
    <div className="page-body">
      <style>{PRINT_CSS}</style>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div>
          <span className="no-print"><BackLink fallback="/reports" fallbackLabel="Reports" /></span>
          <h1 style={{ margin: '6px 0 0', fontSize: '1.3rem' }}>Arc Flash Label Report</h1>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            Current NFPA 70E 130.5(H) labels across all sites. ServiceCycle is the data layer; a licensed PE runs and stamps the study.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm no-print" onClick={() => window.print()}>Print</button>
      </div>

      {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
      {loading && <div className="card" style={{ padding: 16 }}>Loading…</div>}

      {!loading && !error && (
        <>
          {s && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Tile label="Labelled buses" value={s.total} />
              <Tile label="DANGER" value={s.danger} color="var(--color-danger)" />
              <Tile label="WARNING" value={s.warning} color="var(--color-warning)" />
              <Tile label="Avg confidence" value={s.avgConfidence == null ? '—' : `${s.avgConfidence}%`} color={bandColor(s.avgConfidence)} />
              <Tile label="Studies expiring (90d)" value={s.expiringSoon} />
            </div>
          )}

          <label className="no-print" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem', marginBottom: 10 }}>
            <input type="checkbox" checked={onlyDanger} onChange={e => setOnlyDanger(e.target.checked)} />
            Show DANGER only
          </label>

          {rows.length === 0 ? (
            <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
              No arc-flash labels recorded yet. Upload a one-line or study report on a site, or bind a study to assets.
            </div>
          ) : (
            <table className="data-table" style={{ width: '100%', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  <th>Bus / equipment</th><th>Site</th><th>Voltage</th>
                  <th>Incident energy</th><th>Boundary</th><th>PPE / arc rating</th>
                  <th>Severity</th><th>Confidence</th><th>Study date</th><th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={(r.assetId || '') + i}>
                    <td>{r.assetId ? <Link to={`/assets/${r.assetId}`}>{r.busName || '(bus)'}</Link> : (r.busName || '(bus)')}{r.equipmentType ? <span style={{ color: 'var(--color-text-secondary)' }}> · {r.equipmentType}</span> : null}</td>
                    <td>{n(r.site)}</td>
                    <td>{n(r.nominalVoltage)}</td>
                    <td>{r.incidentEnergyCalCm2 != null ? `${r.incidentEnergyCalCm2} cal/cm²` : '—'}</td>
                    <td>{r.arcFlashBoundaryIn != null ? `${r.arcFlashBoundaryIn} in` : '—'}</td>
                    <td>{r.requiredArcRatingCalCm2 != null ? `${r.requiredArcRatingCalCm2} cal/cm²` : (r.ppeCategory != null ? `Cat ${r.ppeCategory}` : '—')}</td>
                    <td style={{ fontWeight: 700, color: r.labelSeverity ? sevColor(r.labelSeverity) : 'inherit' }}>{r.labelSeverity ? r.labelSeverity.toUpperCase() : '—'}</td>
                    <td style={{ fontWeight: 600, color: bandColor(r.confidence?.score) }}>{r.confidence?.score != null ? `${r.confidence.score}%` : '—'}</td>
                    <td>{fmtDate(r.performedDate)}</td>
                    <td style={{ color: r.expiringSoon ? 'var(--color-danger)' : 'inherit' }}>{fmtDate(r.expiresAt)}{r.expiringSoon ? ' ⚠' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
