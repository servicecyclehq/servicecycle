import { useState, useEffect } from 'react';
import api from '../api/client';

// Per-asset arc-flash incident-energy trend (#25 headline, slice 1). Shows how a
// panel's blast energy has moved across study revisions with the NFPA 70E
// DANGER/WARNING class. Renders nothing if the asset has no arc-flash history,
// so it's safe to mount unconditionally on any asset page.

function hazColor(h) { return h === 'DANGER' ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)'; }
function fmtDate(d) { try { const dt = new Date(d); const utc = dt.getUTCHours()===0 && dt.getUTCMinutes()===0 && dt.getUTCSeconds()===0 && dt.getUTCMilliseconds()===0; return dt.toLocaleDateString(undefined, utc ? { timeZone: 'UTC' } : undefined); } catch { return ''; } }

export default function ArcFlashTrend({ assetId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.get('/api/sites/arc-flash/asset/' + assetId + '/trend')
      .then(r => { if (live) setData(r.data?.data || null); })
      .catch(() => { if (live) setData(null); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [assetId]);

  if (loading) return null;
  const points = data?.points || [];
  if (points.length === 0) return null; // no arc-flash history -> hide entirely

  const energyPts = points.filter(p => p.incidentEnergyCalCm2 != null);
  const max = Math.max(40, ...energyPts.map(p => p.incidentEnergyCalCm2)); // floor scale at the 40 cal/cm2 DANGER line
  const trend = data?.trend;
  const latest = data?.latest;

  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Arc flash history</h3>
        {latest && (
          <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#fff', background: hazColor(latest.hazardClass), padding: '2px 8px', borderRadius: 4 }}>
            {latest.hazardClass}
          </span>
        )}
      </div>

      {trend && (
        <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          Incident energy {trend.direction === 'increasing' ? 'rose' : trend.direction === 'decreasing' ? 'fell' : 'held'} from{' '}
          <strong>{trend.first}</strong> to{' '}
          <strong style={{ color: trend.last > 40 ? 'var(--color-danger)' : 'inherit' }}>{trend.last}</strong> cal/cm&sup2;
          {' '}across {energyPts.length} studies{trend.everDanger ? ' · crossed the 40 cal/cm² DANGER line' : ''}.
        </div>
      )}

      {energyPts.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 72, marginBottom: 12 }}>
          {energyPts.map((p, i) => {
            const h = Math.max(4, Math.round((p.incidentEnergyCalCm2 / max) * 60));
            return (
              <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1, minWidth: 0 }}
                   title={fmtDate(p.performedDate) + ' · ' + p.incidentEnergyCalCm2 + ' cal/cm²'}>
                <div style={{ fontSize: '0.6rem', color: 'var(--color-text-secondary)' }}>{p.incidentEnergyCalCm2}</div>
                <div style={{ width: '70%', maxWidth: 28, height: h, background: hazColor(p.hazardClass), borderRadius: '3px 3px 0 0' }} />
                <div style={{ fontSize: '0.58rem', color: 'var(--color-text-secondary)', marginTop: 3 }}>{new Date(p.performedDate).getFullYear()}</div>
              </div>
            );
          })}
        </div>
      )}

      <table className="data-table" style={{ width: '100%', fontSize: '0.74rem' }}>
        <thead><tr><th>Study date</th><th>IE / PPE</th><th>Boundary</th><th>Class</th><th>Current</th></tr></thead>
        <tbody>
          {points.slice().reverse().map((p, i) => (
            <tr key={i}>
              <td>{fmtDate(p.performedDate)}</td>
              <td>{p.incidentEnergyCalCm2 != null ? (p.incidentEnergyCalCm2 + ' cal') : (p.ppeCategory != null ? ('PPE ' + p.ppeCategory) : '-')}</td>
              <td>{p.arcFlashBoundaryIn != null ? (p.arcFlashBoundaryIn + ' in') : '-'}</td>
              <td style={{ fontWeight: 600, color: hazColor(p.hazardClass) }}>{p.hazardClass}</td>
              <td>{p.isCurrent ? 'current' : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
