// ─────────────────────────────────────────────────────────────────────────────
// AuditReadyBanner.jsx — gem V5 "Inspector's here". The panic-moment
// affordance: at a glance, are we audit-ready? and one click to pull the NFPA
// 70B EMP program (PDF + immutable, hash-chained snapshot). Readiness is fed by
// the Path-to-100 gap engine so it tells the truth in advance about whether the
// program would look good or embarrassing when opened.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ShieldAlert, FileDown, Share2 } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { downloadAuthedFile } from '../api/download';
import Toast from './Toast';

export default function AuditReadyBanner() {
  const { role } = useAuth();
  const canExport = ['admin', 'manager'].includes(role);
  const [gap, setGap] = useState(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    api.get('/api/compliance/path-to-100').then(r => setGap(r.data.data)).catch(() => {});
  }, []);

  async function downloadEmp() {
    setBusy(true);
    setToast({ message: 'Generating your EMP program and anchoring its hash…', type: 'info' });
    try {
      // Two-step: POST renders the EMP + persists an immutable snapshot, then
      // GET streams that snapshot's PDF (integrity-checked, any role).
      const res = await api.post('/api/compliance/emp-document');
      const snap = res.data?.data?.snapshot || {};
      if (!snap.id) throw new Error('No document produced');
      const base = import.meta.env.VITE_API_URL ?? '';
      await downloadAuthedFile(
        `${base}/api/compliance/snapshots/${snap.id}/download`,
        snap.filename || `nfpa-70b-emp-program-${new Date().toISOString().slice(0, 10)}.pdf`,
      );
      setToast({ message: 'Program downloaded — hash recorded in the audit log.', type: 'success' });
    } catch (e) {
      setToast({ message: e?.response?.status === 403 ? 'Ask a manager to export the program' : (e.message || 'Export failed'), type: 'error' });
    } finally { setBusy(false); }
  }

  // #21 auditor/insurer share link — create a 14-day read-only link and copy it.
  const [sharing, setSharing] = useState(false);
  async function shareWithUnderwriter() {
    setSharing(true);
    try {
      const res = await api.post('/api/share-links', { days: 14, label: 'underwriter' });
      const path = res.data?.data?.path;
      const url = `${window.location.origin}${path}`;
      try { await navigator.clipboard.writeText(url); } catch (_) { /* clipboard blocked */ }
      setToast({ message: `Read-only link copied — expires in 14 days. ${url}`, type: 'success' });
    } catch (e) {
      setToast({ message: e?.response?.status === 403 ? 'Ask a manager to create the link' : 'Could not create the link', type: 'error' });
    } finally { setSharing(false); }
  }

  const ready = gap && gap.summary.fullyCompliant;
  const items = gap ? gap.summary.totalActions : 0;
  const Icon = ready ? ShieldCheck : ShieldAlert;
  const bg = ready ? 'var(--color-success-bg, #f0fdf4)' : '#fffbeb';
  const border = ready ? 'var(--color-success-border, #bbf7d0)' : '#fde68a';
  const color = ready ? '#15803d' : '#92400e';

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      padding: '12px 16px', marginBottom: 16, borderRadius: 10, background: bg, border: `1px solid ${border}` }}>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <Icon size={22} style={{ color }} />
      <div style={{ flex: 1, minWidth: 240 }}>
        <div style={{ fontWeight: 700, color: 'var(--color-text)' }}>
          {gap == null ? 'Checking audit readiness…'
            : ready ? 'Audit-ready — your NFPA 70B program is complete'
            : `${items} item${items !== 1 ? 's' : ''} would look incomplete to an inspector`}
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
          {ready
            ? 'Pull your written Electrical Maintenance Program any time — hash-chained, timestamped evidence.'
            : <>Close them on the <Link to="/reports/compliance">Path to 100% Compliance</Link> list before the inspector opens the report.</>}
        </div>
      </div>
      {canExport && (
        <button className="btn btn-primary btn-sm" onClick={downloadEmp} disabled={busy}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <FileDown size={15} /> {busy ? 'Generating…' : 'Get my program'}
        </button>
      )}
      {canExport && (
        <button className="btn btn-secondary btn-sm" onClick={shareWithUnderwriter} disabled={sharing}
          title="Create a time-boxed, read-only link to your compliance record"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Share2 size={15} /> {sharing ? 'Creating…' : 'Share with underwriter'}
        </button>
      )}
    </div>
  );
}
