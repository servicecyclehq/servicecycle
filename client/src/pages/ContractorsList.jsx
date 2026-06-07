// ─────────────────────────────────────────────────────────────────────────────
// ContractorsList.jsx — NETA testing contractor directory.
//
// GET /api/contractors → data.contractors with _count.techs and
// _count.workOrders (open SCHEDULED/IN_PROGRESS jobs). Add contractor
// (admin/manager) → POST /api/contractors. Row click → /contractors/:id.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, HardHat, BadgeCheck } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import EmptyState from '../components/EmptyState';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function InHouseBadge() {
  return (
    <span
      title="In-house maintenance crew"
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '2px 8px', borderRadius: 999, marginLeft: 8,
        fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
        background: 'var(--color-surface)', color: 'var(--color-text-secondary)',
        border: '1px solid var(--color-border)',
      }}
    >
      In-house
    </span>
  );
}

function NetaBadge() {
  return (
    <span
      title="NETA accredited company"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px', borderRadius: 999,
        fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
        background: 'var(--color-success-bg, rgba(34,197,94,0.12))',
        color: 'var(--color-success, #15803d)',
      }}
    >
      <BadgeCheck size={12} strokeWidth={2} /> NETA accredited
    </span>
  );
}

const EMPTY_FORM = {
  name: '', netaAccredited: false,
  supportEmail: '', supportPhone: '', supportPortalUrl: '', notes: '',
};

function AddContractorModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const label = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Contractor name is required.'); return; }
    setSaving(true); setError('');
    try {
      const res = await api.post('/api/contractors', form);
      onCreated(res.data?.data?.contractor);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create contractor.');
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Add contractor"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 14 }}>Add contractor</div>
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 12 }}>
          <label style={label}>Company name <span style={{ color: 'var(--color-danger)' }}>*</span></label>
          <input className="form-control form-control-wide" value={form.name} onChange={set('name')} maxLength={200} autoFocus required />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-ui)', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.netaAccredited}
              onChange={e => setForm(f => ({ ...f, netaAccredited: e.target.checked }))}
            />
            NETA accredited company
          </label>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div style={{ marginBottom: 12 }}>
            <label style={label}>Support email</label>
            <input type="email" className="form-control form-control-wide" value={form.supportEmail} onChange={set('supportEmail')} />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label style={label}>Support phone</label>
            <input className="form-control form-control-wide" value={form.supportPhone} onChange={set('supportPhone')} />
          </div>
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Support portal URL</label>
          <input className="form-control form-control-wide" placeholder="https://…" value={form.supportPortalUrl} onChange={set('supportPortalUrl')} />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label style={label}>Notes</label>
          <textarea className="form-control" rows={3} value={form.notes} onChange={set('notes')} />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>
            {saving ? 'Creating…' : 'Create contractor'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function ContractorsList() {
  useDocumentTitle('Contractors');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [contractors, setContractors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const canWrite = ['admin', 'manager'].includes(user?.role);

  function fetchContractors() {
    setLoading(true);
    api.get('/api/contractors')
      .then(r => setContractors(r.data?.data?.contractors || []))
      .catch(() => setError('Failed to load contractors.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { fetchContractors(); }, []);

  function handleCreated(contractor) {
    setShowAdd(false);
    if (contractor?.id) navigate(`/contractors/${contractor.id}`);
    else fetchContractors();
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Contractors</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : `${contractors.length} testing & maintenance compan${contractors.length !== 1 ? 'ies' : 'y'}`}
          </div>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Add contractor
          </button>
        )}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
        {loading && <div className="loading">Loading contractors…</div>}

        {!loading && contractors.length === 0 && !error && (
          <div className="card">
            <EmptyState
              icon={HardHat}
              title="No contractors yet"
              sub="Contractors are the NETA testing and maintenance companies you assign work orders to. Add one with its tech roster to get started."
              ctaLabel={canWrite ? 'Add your first contractor' : undefined}
              ctaOnClick={canWrite ? () => setShowAdd(true) : undefined}
            />
          </div>
        )}

        {!loading && contractors.length > 0 && (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Accreditation</th>
                    <th style={{ textAlign: 'right' }}>Techs</th>
                    <th style={{ textAlign: 'right' }}>Open work orders</th>
                  </tr>
                </thead>
                <tbody>
                  {contractors.map(c => {
                    const go = () => navigate(`/contractors/${c.id}`);
                    const openWOs = c._count?.workOrders ?? 0;
                    return (
                      <tr
                        key={c.id}
                        style={{ cursor: 'pointer' }}
                        onClick={go} tabIndex={0} onKeyDown={kbdActivate(go)}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>
                            {c.name}
                            {c.isInternal && <InHouseBadge />}
                          </div>
                          {(c.supportEmail || c.supportPhone) && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                              {[c.supportEmail, c.supportPhone].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td>{c.netaAccredited ? <NetaBadge /> : <span className="text-muted">—</span>}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{c._count?.techs ?? 0}</td>
                        <td style={{ textAlign: 'right' }}>
                          {openWOs > 0
                            ? <span style={{ fontWeight: 700, color: 'var(--color-primary)' }}>{openWOs}</span>
                            : <span className="text-muted">0</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showAdd && <AddContractorModal onClose={() => setShowAdd(false)} onCreated={handleCreated} />}
    </>
  );
}
