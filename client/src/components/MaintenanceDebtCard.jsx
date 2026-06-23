// ─────────────────────────────────────────────────────────────────────────────
// MaintenanceDebtCard.jsx — Maintenance Debt Ledger + capital plan.
//
// Quantifies overdue/deferred maintenance, known repair backlog, and RUL-driven
// modernization as accruing "$ debt", rolled into a cumulative 1/3/5-year
// funding plan grouped by site. CFO-grade; exportable to CSV. Customer-facing.
//
// Props: { compact?: bool }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Landmark, Download } from 'lucide-react';
import api from '../api/client';
import Tip from './Tip';
import { downloadAuthedFile } from '../api/download';
import Toast from './Toast';

function money(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return '$' + Math.round(Number(n)).toLocaleString('en-US');
}
const range = (r) => (r ? `${money(r.min)} – ${money(r.max)}` : '—');

function PlanTile({ label, r, accent }) {
  return (
    <div style={{ flex: 1, minWidth: 150, border: '1px solid var(--color-border)', borderRadius: 8, padding: '10px 12px', background: 'var(--color-bg-subtle, #fafbfd)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.03em', color: 'var(--color-text-secondary)' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: accent, marginTop: 2 }}>{range(r)}</div>
    </div>
  );
}

export default function MaintenanceDebtCard({ compact = false }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/api/compliance/maintenance-debt');
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load maintenance debt ledger');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function exportCsv() {
    try {
      await downloadAuthedFile('/api/compliance/maintenance-debt.csv', 'maintenance-debt.csv');
    } catch (e) {
      setToast({ message: e.message || 'Export failed', type: 'error' });
    }
  }

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading maintenance debt…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: '#b91c1c' }}>{error}</div></div>;
  if (!data)   return null;

  const t = data.totals;

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Landmark size={18} />
        <div className="card-title" style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>Maintenance Debt Ledger<Tip term="maintenanceDebt" /></div>
        <button className="btn btn-secondary btn-sm" onClick={exportCsv} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Download size={14} /> CSV
        </button>
      </div>
      <div className="card-body">
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', margin: '0 0 12px' }}>
          Deferred maintenance, known repair backlog, and end-of-life modernization as a cumulative funding plan.
        </p>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <PlanTile label="Fund by Year 1" r={data.plan.year1} accent="#b91c1c" />
          <PlanTile label="Cumulative by Year 3" r={data.plan.year3} accent="#b45309" />
          <PlanTile label="Cumulative by Year 5" r={data.plan.year5} accent="#0d4f6e" />
        </div>

        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', marginBottom: compact ? 0 : 10 }}>
          Deferred maintenance <strong>{range(t.deferredMaintenance)}</strong> ({t.deferredMaintenance.count} asset{t.deferredMaintenance.count !== 1 ? 's' : ''})
          {' · '}repair backlog <strong>{money(t.repairBacklog.amount)}</strong>
          {' · '}modernization <strong>{range(t.modernization)}</strong>
        </div>

        {!compact && data.bySite.length > 0 && (
          <div style={{ overflowX: 'auto', marginTop: 6 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>Site</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>Year 1</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>Year 3</th>
                  <th style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>Year 5</th>
                </tr>
              </thead>
              <tbody>
                {data.bySite.map((s) => (
                  <tr key={s.siteId || s.siteName}>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>{s.siteName}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>{range(s.plan.year1)}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>{range(s.plan.year3)}</td>
                    <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--color-border)' }}>{range(s.plan.year5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 10, fontStyle: 'italic' }}>
          {data.disclaimer}
        </p>
      </div>
    </div>
  );
}
