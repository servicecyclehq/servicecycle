// ─────────────────────────────────────────────────────────────────────────────
// ComplianceDocsCard.jsx — dashboard easy-button for per-standard compliance docs.
//
// Lists each standard with its estimated compliance % and a one-click button
// that generates an immutable, hash-anchored PDF for THAT standard
// (POST /api/compliance/snapshots { standardCode } → authed download). The
// standards a customer lives in (NFPA 70B etc.) are pinned to the top.
//
// Framed as ESTIMATED compliance on purpose: the rate is computed against the
// standard requirements currently configured in ServiceCycle, which may lag the
// latest published edition — it's a working estimate, not a legal certification.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { FileDown } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useAuth } from '../context/AuthContext';
import Toast from './Toast';

// Standards most customers live in float to the top.
const PINNED = ['NFPA 70B', 'NFPA 70E'];

function rateColor(r) {
  if (r == null) return 'var(--color-text-secondary)';
  return r >= 90 ? '#15803d' : r >= 70 ? '#92400e' : '#b91c1c';
}

export default function ComplianceDocsCard() {
  const { role } = useAuth();
  const canExport = ['admin', 'manager'].includes(role);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    api.get('/api/compliance/summary')
      .then((r) => {
        const list = r.data?.data?.standards || [];
        list.sort((a, b) => {
          const ac = a.standard?.code || '', bc = b.standard?.code || '';
          const ap = PINNED.indexOf(ac), bp = PINNED.indexOf(bc);
          const an = ap === -1 ? 99 : ap, bn = bp === -1 ? 99 : bp;
          if (an !== bn) return an - bn;
          return ac.localeCompare(bc);
        });
        setRows(list);
      })
      .catch(() => setRows([]));
  }, []);

  async function downloadPdf(code) {
    setBusy(code);
    setToast({ message: `Generating ${code} compliance PDF…`, type: 'info' });
    try {
      const res = await api.post('/api/compliance/snapshots', { standardCode: code });
      const snap = res.data?.data?.snapshot || {};
      if (!snap.id) throw new Error('No document produced');
      const base = import.meta.env.VITE_API_URL ?? '';
      await downloadAuthedFile(
        `${base}/api/compliance/snapshots/${snap.id}/download`,
        snap.filename || `compliance-${code}.pdf`,
      );
      setToast({ message: `${code} PDF downloaded — SHA-256 recorded in the audit log.`, type: 'success' });
    } catch (e) {
      setToast({ message: e?.response?.data?.error || e.message || 'Export failed', type: 'error' });
    } finally { setBusy(null); }
  }

  if (!rows || rows.length === 0) return null;

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      <div className="card-header">
        <div>
          <div className="card-title">Compliance documents</div>
          <div className="card-subtitle">
            <strong>Estimated</strong> compliance per standard — one tap for an audit PDF (stamped with the
            edition on file + today's date). A working estimate from the requirements configured in
            ServiceCycle, not a legal certification — verify against the current published edition.
          </div>
        </div>
      </div>
      <div style={{ padding: '4px 16px 12px' }}>
        {rows.map((r) => {
          const code = r.standard?.code || 'Account-defined';
          const rate = r.complianceRate;
          return (
            <div key={code} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderTop: '1px solid var(--color-border)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {code}{r.standard?.edition ? <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}> · {r.standard.edition} ed.</span> : null}
                </div>
                {r.standard?.title && (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.standard.title}
                  </div>
                )}
              </div>
              <div title="Estimated on-time compliance for this standard's tracked tasks"
                style={{ fontSize: 15, fontWeight: 800, color: rateColor(rate), minWidth: 56, textAlign: 'right' }}>
                ~{rate ?? '—'}%
              </div>
              {canExport && (
                <button className="btn btn-secondary btn-sm" disabled={busy === code} onClick={() => downloadPdf(code)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <FileDown size={14} /> {busy === code ? '…' : 'PDF'}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
