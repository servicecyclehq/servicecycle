import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import { fmtMoney } from '../../lib/equipment';

/**
 * Identified-work card for the dashboard — the one-line attach-rate teaser:
 * "Identified work (90d): $X across N findings · Y quoted" → /installed-base.
 * Markup mirrors ArcFlashDashboardCard (card + title row + Stat strip).
 * Manager/admin only (the endpoint is requireManager; gating client-side too
 * avoids a guaranteed 403 on every viewer dashboard load) and SELF-HIDES when
 * the period has no findings, so it only appears for accounts with data.
 */
export default function IdentifiedWorkCard() {
  const { user } = useAuth();
  const canSee = ['admin', 'manager'].includes(user?.role);
  const [d, setD] = useState(null);

  useEffect(() => {
    if (!canSee) return undefined;
    let on = true;
    api.get('/api/installed-base/attach-rate', { params: { days: 90 } })
      .then((r) => { if (on) setD(r.data?.data || null); })
      .catch(() => { if (on) setD(null); });
    return () => { on = false; };
  }, [canSee]);

  if (!canSee || !d) return null;
  const s = d.stages || {};
  const identified = s.identified || {};
  if (!identified.findings) return null;

  const Stat = ({ label, value, accent }) => (
    <div style={{ flex: '1 1 0', minWidth: 90, padding: '6px 10px' }}>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: accent || 'var(--color-text)' }}>{value}</div>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>{label}</div>
    </div>
  );

  return (
    <div className="card" style={{ padding: '16px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Identified work (90d)</h3>
        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>estimates, not quotes &middot; <Link to="/installed-base">installed-base intelligence</Link></span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
        <Stat label="est. repair exposure" value={fmtMoney(identified.estimatedUsd)} accent={identified.estimatedUsd ? 'var(--color-warning, #b45309)' : undefined} />
        <Stat label={identified.findings === 1 ? 'finding identified' : 'findings identified'} value={identified.findings} />
        <Stat label="quote requests" value={s.quoted?.quoteRequests || 0} />
        <Stat label="resolved" value={s.converted?.findingsResolved || 0} accent={s.converted?.findingsResolved ? 'var(--color-success, #15803d)' : undefined} />
      </div>
    </div>
  );
}
