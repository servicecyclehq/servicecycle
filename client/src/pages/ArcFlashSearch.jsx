// ArcFlashSearch.jsx — Natural-language Arc Flash search (/reports/arc-flash-search).
// Type a plain-English query ("480V MCC over 8 cal that are blocked") and SC parses
// it deterministically into structured filters and matches the label rows. The
// interpretation is shown back so results are explainable. Manager/admin gated.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import BackLink from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const EXAMPLES = [
  '480V MCC over 8 cal',
  'DANGER buses with low confidence',
  'switchgear with expired studies',
  'panels that are blocked',
  '13.8kV over 40 cal',
];

function sevColor(s) { return s === 'danger' ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)'; }
function bandColor(score) { return score == null ? 'var(--color-text-secondary)' : score >= 80 ? '#15803d' : score >= 50 ? '#b45309' : '#b91c1c'; }

export default function ArcFlashSearch() {
  useDocumentTitle('Arc Flash Search');
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function run(query) {
    const text = (query ?? q).trim();
    if (!text) return;
    setLoading(true); setError(''); setRes(null);
    try {
      const r = await api.get('/api/arc-flash/search', { params: { q: text } });
      setRes(r.data?.data || null);
    } catch { setError('Search failed.'); }
    finally { setLoading(false); }
  }

  return (
    <div className="page-body">
      <div style={{ marginBottom: 12 }}>
        <BackLink fallback="/reports" fallbackLabel="Reports" />
        <h1 style={{ margin: '6px 0 0', fontSize: '1.3rem' }}>Arc Flash Search</h1>
        <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
          Ask in plain English — voltage, equipment, incident energy, severity, confidence, study lifecycle, or missing data. The interpretation is shown so results are explainable.
        </p>
      </div>

      <form onSubmit={e => { e.preventDefault(); run(); }} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder='e.g. 480V MCC over 8 cal that are blocked'
          style={{ flex: '1 1 320px', fontSize: '0.9rem', padding: '8px 10px' }}
          aria-label="Search query"
        />
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      </form>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        {EXAMPLES.map(ex => (
          <button key={ex} type="button" className="btn btn-secondary btn-sm" style={{ fontSize: '0.74rem' }} onClick={() => { setQ(ex); run(ex); }}>{ex}</button>
        ))}
      </div>

      {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

      {res && (
        <>
          <div style={{ fontSize: '0.82rem', marginBottom: 10 }}>
            {res.unrecognized ? (
              <span style={{ color: 'var(--color-warning)' }}>Couldn't interpret that — try voltage, an equipment type, an incident-energy comparison (e.g. “over 8 cal”), DANGER/WARNING, low confidence, expired/expiring, or blocked.</span>
            ) : res.interpreted?.length ? (
              <span style={{ color: 'var(--color-text-secondary)' }}>Interpreted as: <strong>{res.interpreted.join(' · ')}</strong> — {res.total} match{res.total === 1 ? '' : 'es'}.</span>
            ) : (
              <span style={{ color: 'var(--color-text-secondary)' }}>{res.total} labelled bus{res.total === 1 ? '' : 'es'}.</span>
            )}
          </div>

          {res.matched?.length > 0 ? (
            <table className="data-table" style={{ width: '100%', fontSize: '0.8rem' }}>
              <thead>
                <tr><th>Bus / equipment</th><th>Site</th><th>Voltage</th><th>Incident energy</th><th>Severity</th><th>Confidence</th><th>State</th></tr>
              </thead>
              <tbody>
                {res.matched.map((r, i) => (
                  <tr key={(r.assetId || '') + i}>
                    <td>{r.assetId ? <Link to={`/assets/${r.assetId}`}>{r.busName || '(bus)'}</Link> : (r.busName || '(bus)')}{r.equipmentType ? <span style={{ color: 'var(--color-text-secondary)' }}> · {r.equipmentType}</span> : null}</td>
                    <td>{r.site || '—'}</td>
                    <td>{r.nominalVoltage || '—'}</td>
                    <td>{r.incidentEnergyCalCm2 != null ? `${r.incidentEnergyCalCm2} cal/cm²` : '—'}</td>
                    <td style={{ fontWeight: 700, color: r.labelSeverity ? sevColor(r.labelSeverity) : 'inherit' }}>{r.labelSeverity ? r.labelSeverity.toUpperCase() : '—'}</td>
                    <td style={{ fontWeight: 600, color: bandColor(r.confidence?.score) }}>{r.confidence?.score != null ? `${r.confidence.score}%` : '—'}</td>
                    <td>{[r.readiness === 'blocked' ? 'blocked' : null, r.expired ? 'expired' : (r.expiringSoon ? 'expiring' : null)].filter(Boolean).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No buses match that query.</div>
          )}
        </>
      )}
    </div>
  );
}
