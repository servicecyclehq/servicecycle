// ArcFlashHeatMap.jsx — Arc Flash Heat-Map (/reports/arc-flash-heatmap).
// A 2D color-coded grid of every labelled bus, grouped by site, shaded by
// incident energy (the NFPA 70E hazard) with a confidence outline. The "exec
// instantly sees where the heat is" view. (A true geospatial floor-plan overlay
// needs per-asset plan coordinates — a later upgrade; this first cut needs none.)
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import BackLink from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// Incident-energy color ramp (cal/cm^2). DANGER severity (>40 cal or >600 V) is
// always red regardless of a missing IE value.
function heatColor(ie, severity) {
  if (severity === 'danger') return '#b91c1c';
  if (ie == null) return '#9ca3af';            // unknown — neutral gray
  if (ie <= 1.2) return '#15803d';             // below the arc-flash boundary threshold
  if (ie <= 8) return '#65a30d';
  if (ie <= 25) return '#ca8a04';
  if (ie <= 40) return '#ea580c';
  return '#b91c1c';
}
function bandOutline(band) { return band === 'green' ? '#15803d' : band === 'yellow' ? '#b45309' : band === 'red' ? '#b91c1c' : 'transparent'; }

const LEGEND = [
  { c: '#15803d', t: '≤1.2 cal' },
  { c: '#65a30d', t: '≤8 cal' },
  { c: '#ca8a04', t: '≤25 cal' },
  { c: '#ea580c', t: '≤40 cal' },
  { c: '#b91c1c', t: 'DANGER (>40 cal / >600 V)' },
  { c: '#9ca3af', t: 'No incident energy yet' },
];

export default function ArcFlashHeatMap() {
  useDocumentTitle('Arc Flash Heat-Map');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyDanger, setOnlyDanger] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get('/api/arc-flash/report')
      .then(r => setData(r.data?.data || null))
      .catch(() => setError('Failed to load the arc-flash heat-map.'))
      .finally(() => setLoading(false));
  }, []);

  const bySite = useMemo(() => {
    const rows = (data?.rows || []).filter(r => !onlyDanger || r.labelSeverity === 'danger');
    const map = new Map();
    for (const r of rows) {
      const site = r.site || 'Unassigned';
      if (!map.has(site)) map.set(site, []);
      map.get(site).push(r);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => (b.incidentEnergyCalCm2 || 0) - (a.incidentEnergyCalCm2 || 0));
    }
    // Hottest sites first.
    return Array.from(map.entries()).sort((a, b) => {
      const da = a[1].filter(r => r.labelSeverity === 'danger').length;
      const db = b[1].filter(r => r.labelSeverity === 'danger').length;
      return db - da;
    });
  }, [data, onlyDanger]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Arc Flash Heat Map</h1>
          <div className="page-subtitle">Incident energy distribution across sites and equipment</div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}>
            <input type="checkbox" checked={onlyDanger} onChange={e => setOnlyDanger(e.target.checked)} />
            DANGER only
          </label>
        </div>
      </div>

      <div className="page-body">
      {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
      {loading && <div className="card" style={{ padding: 16 }}>Loading…</div>}

      {!loading && !error && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginBottom: 16, fontSize: '0.76rem', color: 'var(--color-text-secondary)' }}>
            {LEGEND.map(l => (
              <span key={l.t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: l.c, display: 'inline-block' }} />{l.t}
              </span>
            ))}
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <span style={{ width: 12, height: 12, borderRadius: 3, border: '2px solid #b91c1c', display: 'inline-block' }} />outline = confidence (green/amber/red)
            </span>
          </div>

          {bySite.length === 0 ? (
            <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
              No arc-flash labels to map yet. Upload a one-line or study report on a site, or bind a study to assets.
            </div>
          ) : (
            bySite.map(([site, rows]) => (
              <div key={site} style={{ marginBottom: 22 }}>
                <h2 style={{ fontSize: '1rem', margin: '0 0 10px' }}>
                  {site} <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400, fontSize: '0.82rem' }}>({rows.length} bus{rows.length === 1 ? '' : 'es'}, {rows.filter(r => r.labelSeverity === 'danger').length} DANGER)</span>
                </h2>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
                  {rows.map((r, i) => {
                    const bg = heatColor(r.incidentEnergyCalCm2, r.labelSeverity);
                    const tile = (
                      <div style={{ background: bg, color: '#fff', borderRadius: 8, padding: '10px 12px', minHeight: 76, outline: `3px solid ${bandOutline(r.confidence?.band)}`, outlineOffset: -3, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                        <div style={{ fontWeight: 700, fontSize: '0.82rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.busName || '(bus)'}</div>
                        <div style={{ fontSize: '0.74rem', opacity: 0.95 }}>
                          {r.incidentEnergyCalCm2 != null ? `${r.incidentEnergyCalCm2} cal/cm²` : 'IE —'}{r.nominalVoltage ? ` · ${r.nominalVoltage}` : ''}
                        </div>
                        <div style={{ fontSize: '0.68rem', opacity: 0.9 }}>
                          {r.labelSeverity ? r.labelSeverity.toUpperCase() : '—'}{r.confidence?.score != null ? ` · trust ${r.confidence.score}%` : ''}
                        </div>
                      </div>
                    );
                    return r.assetId
                      ? <Link key={(r.assetId || '') + i} to={`/assets/${r.assetId}`} style={{ textDecoration: 'none' }}>{tile}</Link>
                      : <div key={i}>{tile}</div>;
                  })}
                </div>
              </div>
            ))
          )}
        </>
      )}
      </div>
    </>
  );
}
