// ─────────────────────────────────────────────────────────────────────────────
// PathTo100.jsx — gem N2 "Path to 100%".
//
// Turns the compliance score into a ranked to-do list: each row is one thing to
// fix (complete overdue work / baseline a schedule / apply a template to an
// uncovered asset), tagged with the points it recovers, with a one-click action.
// Also surfaces the honest Compliance% · Coverage% pair the headline tile hides.
//
// Props: { siteId?: string|null, compact?: bool, limit?: number, onChanged?: fn }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Target } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import Toast from './Toast';

const KIND_META = {
  overdue:         { bg: '#fff1f1', color: '#b91c1c', label: 'Overdue' },
  unbaselined:     { bg: '#fffbeb', color: '#92400e', label: 'Needs baseline' },
  uncovered:       { bg: '#eff6ff', color: '#1d4ed8', label: 'No program' },
  emp_coordinator: { bg: '#f5f3ff', color: '#6d28d9', label: 'EMP §4.2' },
  emp_review:      { bg: '#f5f3ff', color: '#6d28d9', label: 'EMP §4.2' },
};

function ActionButton({ row, busy, onRun }) {
  const labels = { create_wo: 'Create work order', baseline: 'Record last service', apply_template: 'Apply template' };
  // EMP program gaps are fixed on the settings page, not via an inline API call.
  if (row.action.type === 'emp_settings') {
    return (
      <Link to="/settings?tab=emp" className="btn btn-secondary btn-sm">Open EMP settings</Link>
    );
  }
  return (
    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => onRun(row)}>
      {busy ? '…' : (labels[row.action.type] || 'Fix')}
    </button>
  );
}

export default function PathTo100({ siteId = null, compact = false, limit = 50, onChanged }) {
  const { role } = useAuth();
  const canWrite = ['admin', 'manager'].includes(role);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/compliance/path-to-100${siteId ? `?siteId=${siteId}` : ''}`);
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load path to 100%');
    } finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  async function runAction(row) {
    const key = row.scheduleId || row.assetId;
    setBusyId(key);
    try {
      const a = row.action;
      if (a.type === 'create_wo') {
        await api.post('/api/work-orders', { assetId: a.assetId, scheduleId: a.scheduleId, scheduledDate: new Date().toISOString().slice(0, 10) });
        setToast({ message: 'Work order created', type: 'success' });
      } else if (a.type === 'baseline') {
        // V3 evidence-grade: never fabricate a completion. Ask for the REAL
        // last-service date; blank = "never/unknown" -> schedule goes due-now.
        const ans = window.prompt(
          'When was this task last actually performed?\n\nEnter the real date as YYYY-MM-DD.\nLeave blank if it has never been done / you don’t know (it will be marked due now).',
          ''
        );
        if (ans === null) { setBusyId(null); return; } // cancelled
        const lastServiceDate = ans.trim() || null;
        const r = await api.post(`/api/schedules/${a.scheduleId}/baseline`, { lastServiceDate });
        setToast({ message: r.data?.data?.baselined ? 'Recorded last-service date' : 'Marked due now', type: 'success' });
      } else if (a.type === 'apply_template') {
        const r = await api.post('/api/schedules/bulk-apply', { assetId: a.assetId });
        setToast({ message: `Applied template — ${r.data?.data?.created ?? 0} task(s) added`, type: 'success' });
      }
      await load();
      onChanged && onChanged();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Action failed', type: 'error' });
    } finally { setBusyId(null); }
  }

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading path to 100%…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: '#b91c1c' }}>{error}</div></div>;
  if (!data)   return null;

  const rows = data.actions.slice(0, compact ? Math.min(limit, 5) : limit);
  const fully = data.summary.fullyCompliant;

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <Target size={18} />
        <div className="card-title" style={{ flex: 1 }}>Path to 100%</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span title="Honest rate: counts uncovered assets + unbaselined schedules as gaps"
            style={{ fontSize: 22, fontWeight: 800, color: data.overallRate >= 90 ? '#15803d' : data.overallRate >= 70 ? '#92400e' : '#b91c1c' }}>
            {data.overallRate}%
          </span>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            Compliance {data.compliance.rate ?? '—'}% · Coverage {data.coverage.rate}%
            {' '}({data.coverage.coveredAssets}/{data.coverage.totalAssets} assets)
          </span>
        </div>
      </div>
      <div className="card-body">
        {fully ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#15803d', padding: '8px 0' }}>
            <CheckCircle2 size={20} /> <span style={{ fontWeight: 700 }}>Fully compliant — nothing to fix.</span>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
              {data.summary.totalActions} task{data.summary.totalActions !== 1 ? 's' : ''} stand between you and 100%
              {' '}· <strong>{data.summary.overdueCount}</strong> overdue, <strong>{data.summary.unbaselinedCount}</strong> need baselining,
              {' '}<strong>{data.summary.uncoveredCount}</strong> uncovered asset{data.summary.uncoveredCount !== 1 ? 's' : ''}
              {data.summary.empGapCount > 0 && <>{' '}· <strong>{data.summary.empGapCount}</strong> EMP §4.2 gap{data.summary.empGapCount !== 1 ? 's' : ''}</>}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {rows.map((row, i) => {
                const m = KIND_META[row.kind] || KIND_META.uncovered;
                const key = row.scheduleId || row.assetId;
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10, background: m.bg, color: m.color, whiteSpace: 'nowrap' }}>{m.label}</span>
                    <Link to={row.assetId ? `/assets/${row.assetId}` : '/settings?tab=emp'} style={{ flex: 1, minWidth: 200, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                      {row.title}
                    </Link>
                    {row.siteName && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{row.siteName}</span>}
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#15803d', whiteSpace: 'nowrap' }}>+{row.pointsRecovered}%</span>
                    {canWrite && <ActionButton row={row} busy={busyId === key} onRun={runAction} />}
                  </div>
                );
              })}
            </div>
            {data.summary.totalActions > rows.length && (
              <div style={{ marginTop: 10, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Showing top {rows.length} of {data.summary.totalActions}.{' '}
                <Link to="/reports/compliance">See the full list →</Link>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
