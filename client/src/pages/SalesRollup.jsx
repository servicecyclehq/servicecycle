// ─────────────────────────────────────────────────────────────────────────────
// SalesRollup.jsx — the sales-manager roll-up (/sales, Chunk B-2).
// One card per Account Manager: their book of customer accounts sorted
// worst-compliance-first (the opportunity surface), plus an Unassigned bucket.
// Read-only; every number is a byproduct SC already captures. The server gates
// this to operator staff (admin/manager allowed only in the demo sandbox).
// ─────────────────────────────────────────────────────────────────────────────
import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function pct(v) { return v == null ? '—' : `${v}%`; }
function complianceColor(v) {
  if (v == null) return 'var(--color-text-secondary)';
  if (v >= 90) return 'var(--chip-green-fg, #16a34a)';
  if (v >= 70) return 'var(--chip-amber-fg, #d97706)';
  return 'var(--chip-red-fg, #dc2626)';
}

const card = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', marginBottom: 14 };
const th = { textAlign: 'left', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.03em', color: 'var(--color-text-secondary)', padding: '4px 8px' };
const td = { padding: '6px 8px', fontSize: '0.85rem', borderTop: '1px solid var(--color-border)' };

function Book({ accounts }) {
  return (
    <div className="table-wrap" style={{ marginTop: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>
          <th style={th}>Account</th>
          <th style={{ ...th, textAlign: 'right' }}>Compliance</th>
          <th style={{ ...th, textAlign: 'right' }}>Open def.</th>
          <th style={{ ...th, textAlign: 'right' }}>Open WOs</th>
          <th style={{ ...th, textAlign: 'right' }}>Overdue</th>
          <th style={{ ...th, textAlign: 'right' }}>Assets</th>
        </tr></thead>
        <tbody>
          {accounts.map(a => (
            <tr key={a.accountId}>
              <td style={td}>{a.companyName}</td>
              <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: complianceColor(a.compliance) }}>{pct(a.compliance)}</td>
              <td style={{ ...td, textAlign: 'right', color: a.openDeficiencies > 0 ? 'var(--chip-red-fg, #dc2626)' : 'inherit' }}>{a.openDeficiencies}</td>
              <td style={{ ...td, textAlign: 'right' }}>{a.openWorkOrders}</td>
              <td style={{ ...td, textAlign: 'right' }}>{a.overdueSchedules}</td>
              <td style={{ ...td, textAlign: 'right' }}>{a.assets}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RepCard({ rep }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={card}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{ all: 'unset', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: '1rem', fontWeight: 700 }}>{rep.repName}</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{rep.accountCount} account{rep.accountCount === 1 ? '' : 's'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
            {rep.openDeficiencies} open def. · {rep.openWorkOrders} WOs
          </span>
          <span title="Book-average compliance" style={{ fontSize: '1.05rem', fontWeight: 800, color: complianceColor(rep.avgCompliance) }}>
            {pct(rep.avgCompliance)}
          </span>
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s' }}>▸</span>
        </div>
      </button>
      {open && <Book accounts={rep.accounts} />}
    </div>
  );
}

function accountsForRep(data, fromRepId) {
  if (fromRepId === '') return data?.unassigned || [];
  return (data?.reps || []).find(r => r.repId === fromRepId)?.accounts || [];
}

// Reassign a rep's book (or selected accounts) to another AM. Asks before
// overwriting the customer-facing contact (serviceRep) when it would change it.
function ReassignPanel({ data, onDone }) {
  const [open, setOpen] = useState(false);
  const [reps, setReps] = useState([]);
  const [fromRep, setFromRep] = useState('');
  const [toRep, setToRep] = useState('');
  const [picked, setPicked] = useState({}); // accountId -> bool
  const [syncContact, setSyncContact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!open) return;
    api.get('/api/sales/reps').then(r => setReps(r.data?.data?.reps || [])).catch(() => {});
  }, [open]);

  const book = accountsForRep(data, fromRep);
  // Default: all of the from-rep's accounts selected.
  useEffect(() => {
    const next = {};
    for (const a of book) next[a.accountId] = true;
    setPicked(next);
    setMsg('');
  }, [fromRep]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedIds = book.filter(a => picked[a.accountId]).map(a => a.accountId);

  async function move() {
    if (!toRep || selectedIds.length === 0) return;
    setBusy(true); setMsg('');
    try {
      const r = await api.post('/api/sales/reassign', {
        fromRepId: fromRep === '' ? null : fromRep,
        toRepId: toRep,
        accountIds: selectedIds,
        syncContact,
      });
      setMsg(`Moved ${r.data?.data?.moved ?? 0} account(s).`);
      onDone && onDone();
    } catch {
      setMsg('Reassignment failed.');
    } finally { setBusy(false); }
  }

  const sel = { width: '100%', padding: '6px 8px', fontSize: '0.85rem', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-bg)', color: 'var(--color-text)', marginTop: 3 };

  return (
    <div style={{ ...card, borderStyle: open ? 'solid' : 'dashed' }}>
      <button type="button" onClick={() => setOpen(o => !o)} style={{ all: 'unset', cursor: 'pointer', fontWeight: 700, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.12s', color: 'var(--color-text-secondary)' }}>▸</span>
        Reassign accounts
      </button>
      {open && (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
            <label style={{ fontSize: '0.78rem' }}>Move from
              <select style={sel} value={fromRep} onChange={e => setFromRep(e.target.value)}>
                <option value="">— Unassigned —</option>
                {(data?.reps || []).map(r => <option key={r.repId} value={r.repId}>{r.repName} ({r.accountCount})</option>)}
              </select>
            </label>
            <label style={{ fontSize: '0.78rem' }}>Move to
              <select style={sel} value={toRep} onChange={e => setToRep(e.target.value)}>
                <option value="">Select a rep…</option>
                {reps.filter(r => r.id !== fromRep).map(r => <option key={r.id} value={r.id}>{r.name}{r.accountCount ? ` (${r.accountCount})` : ''}</option>)}
              </select>
            </label>
          </div>

          {book.length === 0 ? (
            <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>No accounts in this book.</div>
          ) : (
            <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, maxHeight: 200, overflowY: 'auto' }}>
              {book.map(a => (
                <label key={a.accountId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', fontSize: '0.82rem', borderTop: '1px solid var(--color-border)' }}>
                  <input type="checkbox" checked={!!picked[a.accountId]} onChange={e => setPicked(p => ({ ...p, [a.accountId]: e.target.checked }))} />
                  <span style={{ flex: 1 }}>{a.companyName}</span>
                  <span style={{ color: complianceColor(a.compliance), fontWeight: 700 }}>{pct(a.compliance)}</span>
                </label>
              ))}
            </div>
          )}

          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.8rem' }}>
            <input type="checkbox" checked={syncContact} onChange={e => setSyncContact(e.target.checked)} style={{ marginTop: 2 }} />
            <span>Also update the customer-facing contact (digest CC / Reply-To) to the new rep.
              <span style={{ color: 'var(--color-text-secondary)' }}> Leave off to keep the existing contact — only check this if you want to overwrite it.</span>
            </span>
          </label>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !toRep || selectedIds.length === 0} onClick={move}>
              {busy ? 'Moving…' : `Move ${selectedIds.length} account${selectedIds.length === 1 ? '' : 's'}`}
            </button>
            {msg && <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{msg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}

export default function SalesRollup() {
  useDocumentTitle('Sales roll-up');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setLoading(true); setErr('');
    api.get('/api/sales/rollup')
      .then(r => setData(r.data?.data || null))
      .catch(e => {
        if (e?.response?.status === 403) setErr('The sales roll-up is available to operator staff only.');
        else setErr('Could not load the sales roll-up.');
      })
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '8px 4px 40px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
        <h1 style={{ fontSize: '1.4rem', margin: 0 }}>Sales roll-up</h1>
        {data && (
          <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
            {data.summary.repCount} reps · {data.summary.accountCount} accounts
          </span>
        )}
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', margin: '4px 0 16px', lineHeight: 1.5 }}>
        Each account manager's book, sorted worst-compliance-first — the opportunity surface. Read-only; pulled from the compliance, deficiency, and work-order data ServiceCycle already tracks. No manual entry.
      </p>

      {loading && <div style={card}>Loading…</div>}
      {err && !loading && <div role="alert" className="alert alert-error">{err}</div>}

      {!loading && !err && data && (
        <>
          <ReassignPanel data={data} onDone={load} />
          {data.reps.length === 0 && data.unassigned.length === 0 && (
            <div style={card}>No accounts in scope yet.</div>
          )}
          {data.reps.map(rep => <RepCard key={rep.repId} rep={rep} />)}

          {data.unassigned.length > 0 && (
            <div style={{ ...card, borderColor: 'var(--chip-amber-fg, #d97706)' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
                <span style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--chip-amber-fg, #d97706)' }}>Unassigned</span>
                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{data.unassigned.length} account{data.unassigned.length === 1 ? '' : 's'} with no account manager</span>
              </div>
              <Book accounts={data.unassigned} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
