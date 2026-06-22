import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

/**
 * Arc-flash health card for the dashboard (Slice 3 surfacing, pulled forward).
 * The four numbers that answer "where's my arc-flash risk + what's outstanding":
 * DANGER buses, studies expiring, blocked buses needing data, open field tasks.
 * SELF-HIDES when everything is zero so it only appears for accounts that have
 * arc-flash data — no feature-flag wiring needed.
 */
export default function ArcFlashDashboardCard() {
  const [d, setD] = useState(null);
  useEffect(() => {
    let on = true;
    api.get('/api/arc-flash/dashboard')
      .then((r) => { if (on) setD(r.data?.data || null); })
      .catch(() => { if (on) setD(null); });
    return () => { on = false; };
  }, []);

  if (!d) return null;
  const total = (d.dangerBuses || 0) + (d.studiesExpiringSoon || 0) + (d.blockedBuses || 0) + (d.openCollectionTasks || 0);
  if (!total) return null;

  const Stat = ({ label, value, accent }) => (
    <div style={{ flex: '1 1 0', minWidth: 90, padding: '6px 10px' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: accent || 'var(--color-text)' }}>{value}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>{label}</div>
    </div>
  );

  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Arc flash</h3>
        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>IEEE 1584 data layer &middot; a PE runs the study</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
        <Stat label="DANGER buses" value={d.dangerBuses || 0} accent={d.dangerBuses ? 'var(--color-danger, #b91c1c)' : undefined} />
        <Stat label="studies expiring" value={d.studiesExpiringSoon || 0} accent={d.studiesExpiringSoon ? 'var(--color-warning, #c2410c)' : undefined} />
        <Stat label="buses needing data" value={d.blockedBuses || 0} accent={d.blockedBuses ? 'var(--color-warning, #c2410c)' : undefined} />
        <Stat label="open field tasks" value={d.openCollectionTasks || 0} />
      </div>
      {Array.isArray(d.topDanger) && d.topDanger.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid var(--color-border)', paddingTop: 8 }}>
          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginBottom: 4 }}>Hottest equipment</div>
          {d.topDanger.map((t, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.76rem', padding: '2px 0' }}>
              <span>{t.assetId ? <Link to={`/assets/${t.assetId}`}>{t.busName}</Link> : t.busName}{t.nominalVoltage ? ` (${t.nominalVoltage})` : ''}</span>
              <span style={{ fontWeight: 600, color: 'var(--color-danger, #b91c1c)' }}>{t.incidentEnergyCalCm2 != null ? `${t.incidentEnergyCalCm2} cal/cm²` : 'DANGER'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
