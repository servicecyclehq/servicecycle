// ─────────────────────────────────────────────────────────────────────────────
// ContractorDetail.jsx — one contractor: edit card, tech roster, recent jobs.
//
// Server endpoints (verified against server/routes/contractors.ts):
//   GET    /api/contractors/:id          → data.contractor (techs, workOrders)
//   PUT    /api/contractors/:id
//   POST   /api/contractors/:id/techs
//   PUT    /api/contractors/techs/:techId
//   DELETE /api/contractors/techs/:techId
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Pencil, BadgeCheck } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import Toast from '../components/Toast';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { WO_STATUS_META, DECAL_META, assetLabel, fmtDate } from '../lib/equipment';

const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];
const CERT_LABELS = {
  LEVEL_I: 'Level I', LEVEL_II: 'Level II', LEVEL_III: 'Level III', LEVEL_IV: 'Level IV',
};

const EMPTY_TECH = { name: '', title: '', netaCertLevel: '', email: '', phone: '' };

function metaOf(metaMap, key) {
  const m = metaMap?.[key];
  if (!m) return {};
  return typeof m === 'string' ? { label: m } : m;
}

function Chip({ meta, fallback }) {
  const m = meta || {};
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
      background: m.bg || 'var(--color-surface)',
      color: m.color || 'var(--color-text-secondary)',
      border: `1px solid ${m.color || 'var(--color-border)'}`,
    }}>{m.label || fallback}</span>
  );
}

function CertSelect({ value, onChange }) {
  return (
    <select className="form-control" value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">No NETA cert</option>
      {NETA_CERT_LEVELS.map(l => <option key={l} value={l}>{CERT_LABELS[l]}</option>)}
    </select>
  );
}

// ── Tech row: view + inline edit ─────────────────────────────────────────────
function TechRow({ tech, canWrite, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(tech);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function save() {
    setBusy(true);
    const ok = await onSave(tech.id, {
      name: form.name, title: form.title || null,
      netaCertLevel: form.netaCertLevel || null,
      email: form.email || null, phone: form.phone || null,
    });
    setBusy(false);
    if (ok) setEditing(false);
  }

  if (editing) {
    return (
      <tr>
        <td><input className="form-control" value={form.name} onChange={set('name')} /></td>
        <td><input className="form-control" value={form.title || ''} onChange={set('title')} /></td>
        <td><CertSelect value={form.netaCertLevel} onChange={v => setForm(f => ({ ...f, netaCertLevel: v }))} /></td>
        <td><input type="email" className="form-control" value={form.email || ''} onChange={set('email')} /></td>
        <td><input className="form-control" value={form.phone || ''} onChange={set('phone')} /></td>
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={busy || !form.name?.trim()}>Save</button>{' '}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(false); setForm(tech); }} disabled={busy}>Cancel</button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td style={{ fontWeight: 600 }}>{tech.name}</td>
      <td className="td-muted">{tech.title || '—'}</td>
      <td>
        {tech.netaCertLevel ? (
          <span style={{
            display: 'inline-block', padding: '2px 8px', borderRadius: 999,
            fontSize: 'var(--font-size-xs)', fontWeight: 600,
            background: 'var(--color-surface)', border: '1px solid var(--color-border)',
          }}>
            NETA {CERT_LABELS[tech.netaCertLevel] || tech.netaCertLevel}
          </span>
        ) : <span className="text-muted">—</span>}
      </td>
      <td className="td-muted">{tech.email || '—'}</td>
      <td className="td-muted">{tech.phone || '—'}</td>
      {canWrite && (
        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setForm(tech); setEditing(true); }}>Edit</button>{' '}
          <button type="button" className="btn btn-secondary btn-sm" style={{ color: 'var(--color-danger)' }} onClick={() => onDelete(tech)}>Remove</button>
        </td>
      )}
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function ContractorDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = ['admin', 'manager'].includes(user?.role);

  const [contractor, setContractor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const [addingTech, setAddingTech] = useState(false);
  const [techForm, setTechForm] = useState(EMPTY_TECH);
  const [techSaving, setTechSaving] = useState(false);

  useDocumentTitle(contractor ? contractor.name : 'Contractor');

  const fetchContractor = useCallback(() => {
    return api.get(`/api/contractors/${id}`)
      .then(r => setContractor(r.data?.data?.contractor || null))
      .catch(err => setError(err.response?.status === 404 ? 'Contractor not found.' : 'Failed to load contractor.'));
  }, [id]);

  useEffect(() => {
    setLoading(true);
    fetchContractor().finally(() => setLoading(false));
  }, [fetchContractor]);

  function apiError(err, fallback) {
    setToast({ message: err.response?.data?.error || fallback, variant: 'error' });
  }

  function openEditor() {
    setForm({
      name: contractor.name || '',
      netaAccredited: !!contractor.netaAccredited,
      supportEmail: contractor.supportEmail || '',
      supportPhone: contractor.supportPhone || '',
      supportPortalUrl: contractor.supportPortalUrl || '',
      notes: contractor.notes || '',
    });
    setEditing(true);
  }

  async function saveContractor(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.put(`/api/contractors/${id}`, form);
      await fetchContractor();
      setEditing(false);
      setToast({ message: 'Contractor saved.', variant: 'success', duration: 4000 });
    } catch (err) {
      apiError(err, 'Failed to save contractor.');
    } finally {
      setSaving(false);
    }
  }

  async function addTech(e) {
    e.preventDefault();
    if (!techForm.name.trim()) return;
    setTechSaving(true);
    try {
      await api.post(`/api/contractors/${id}/techs`, {
        name: techForm.name.trim(),
        title: techForm.title || null,
        netaCertLevel: techForm.netaCertLevel || null,
        email: techForm.email || null,
        phone: techForm.phone || null,
      });
      setTechForm(EMPTY_TECH);
      setAddingTech(false);
      await fetchContractor();
    } catch (err) {
      apiError(err, 'Failed to add tech.');
    } finally {
      setTechSaving(false);
    }
  }

  async function saveTech(techId, body) {
    try {
      await api.put(`/api/contractors/techs/${techId}`, body);
      await fetchContractor();
      return true;
    } catch (err) {
      apiError(err, 'Failed to update tech.');
      return false;
    }
  }

  async function deleteTech(tech) {
    const ok = await confirm({
      title: `Remove ${tech.name} from the roster?`,
      message: 'Removal is blocked if the tech is assigned to existing work orders.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/contractors/techs/${tech.id}`);
      await fetchContractor();
    } catch (err) {
      apiError(err, 'Failed to remove tech.');
    }
  }

  if (loading) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">Contractor</h1></div>
        <div className="page-body"><div className="loading">Loading contractor…</div></div>
      </>
    );
  }
  if (error || !contractor) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">Contractor</h1></div>
        <div className="page-body">
          <div role="alert" className="alert alert-error">{error || 'Contractor not found.'}</div>
          <Link to="/contractors" className="btn btn-secondary" style={{ marginTop: 12 }}>Back to contractors</Link>
        </div>
      </>
    );
  }

  const label = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };
  const techs = contractor.techs || [];
  const workOrders = contractor.workOrders || [];

  return (
    <>
      <div className="page-header">
        <div>
          <button
            type="button" onClick={() => navigate('/contractors')}
            style={{ background: 'none', border: 'none', padding: 0, marginBottom: 4, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}
          >
            {String.fromCharCode(8592)} Contractors
          </button>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {contractor.name}
            {contractor.netaAccredited && (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 10px', borderRadius: 999,
                fontSize: 'var(--font-size-xs)', fontWeight: 600,
                background: 'var(--color-success-bg, rgba(34,197,94,0.12))',
                color: 'var(--color-success, #15803d)',
              }}>
                <BadgeCheck size={13} strokeWidth={2} /> NETA accredited
              </span>
            )}
          </h1>
          <div className="page-subtitle">
            {[contractor.supportEmail, contractor.supportPhone].filter(Boolean).join(' · ') || 'No support contact on file'}
          </div>
        </div>
        {canWrite && !editing && (
          <button className="btn btn-secondary" onClick={openEditor}>
            <Pencil size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Edit contractor
          </button>
        )}
      </div>

      <div className="page-body">
        {editing && form && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><div className="card-title">Edit contractor</div></div>
            <form onSubmit={saveContractor} style={{ padding: '16px 20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                <div>
                  <label style={label}>Company name *</label>
                  <input className="form-control form-control-wide" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} maxLength={200} required />
                </div>
                <div>
                  <label style={label}>Support email</label>
                  <input type="email" className="form-control form-control-wide" value={form.supportEmail} onChange={e => setForm(f => ({ ...f, supportEmail: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Support phone</label>
                  <input className="form-control form-control-wide" value={form.supportPhone} onChange={e => setForm(f => ({ ...f, supportPhone: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Support portal URL</label>
                  <input className="form-control form-control-wide" placeholder="https://…" value={form.supportPortalUrl} onChange={e => setForm(f => ({ ...f, supportPortalUrl: e.target.value }))} />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-ui)', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.netaAccredited}
                    onChange={e => setForm(f => ({ ...f, netaAccredited: e.target.checked }))}
                  />
                  NETA accredited company
                </label>
              </div>
              <div style={{ marginTop: 12 }}>
                <label style={label}>Notes</label>
                <textarea className="form-control" rows={3} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          </div>
        )}

        {/* ── Tech roster ─────────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Tech roster</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Field technicians with ANSI/NETA ETT certification levels — work orders assign one of these techs.
              </div>
            </div>
            {canWrite && (
              <button className="btn btn-secondary btn-sm" onClick={() => setAddingTech(a => !a)}>
                {addingTech ? 'Cancel' : '+ Add tech'}
              </button>
            )}
          </div>

          {addingTech && (
            <form onSubmit={addTech} style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={label}>Name *</label>
                  <input className="form-control" value={techForm.name} onChange={e => setTechForm(f => ({ ...f, name: e.target.value }))} autoFocus required />
                </div>
                <div>
                  <label style={label}>Title</label>
                  <input className="form-control" value={techForm.title} onChange={e => setTechForm(f => ({ ...f, title: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>NETA cert level</label>
                  <CertSelect value={techForm.netaCertLevel} onChange={v => setTechForm(f => ({ ...f, netaCertLevel: v }))} />
                </div>
                <div>
                  <label style={label}>Email</label>
                  <input type="email" className="form-control" value={techForm.email} onChange={e => setTechForm(f => ({ ...f, email: e.target.value }))} />
                </div>
                <div>
                  <label style={label}>Phone</label>
                  <input className="form-control" value={techForm.phone} onChange={e => setTechForm(f => ({ ...f, phone: e.target.value }))} />
                </div>
                <button type="submit" className="btn btn-primary" disabled={techSaving || !techForm.name.trim()}>
                  {techSaving ? 'Adding…' : 'Add tech'}
                </button>
              </div>
            </form>
          )}

          {techs.length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No techs on the roster yet
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Title</th>
                    <th>NETA cert</th>
                    <th>Email</th>
                    <th>Phone</th>
                    {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {techs.map(t => (
                    <TechRow key={t.id} tech={t} canWrite={canWrite} onSave={saveTech} onDelete={deleteTech} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Recent work orders ─────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Recent work orders</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Latest jobs assigned to this contractor
              </div>
            </div>
          </div>
          {workOrders.length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No work orders yet
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Status</th>
                    <th>Tech</th>
                    <th style={{ textAlign: 'right' }}>Scheduled</th>
                    <th style={{ textAlign: 'right' }}>Completed</th>
                    <th>Decal</th>
                  </tr>
                </thead>
                <tbody>
                  {workOrders.map(wo => (
                    <tr key={wo.id}>
                      <td>
                        <Link to={`/work-orders/${wo.id}`} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                          {assetLabel(wo.asset)}
                        </Link>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                          {wo.asset?.site?.name || '—'}
                        </div>
                      </td>
                      <td><Chip meta={metaOf(WO_STATUS_META, wo.status)} fallback={wo.status} /></td>
                      <td className="td-muted">{wo.assignedTech?.name || '—'}</td>
                      <td style={{ textAlign: 'right' }} className="td-muted">{fmtDate(wo.scheduledDate)}</td>
                      <td style={{ textAlign: 'right' }} className="td-muted">{fmtDate(wo.completedDate)}</td>
                      <td>
                        {wo.netaDecal
                          ? <Chip meta={metaOf(DECAL_META, wo.netaDecal)} fallback={wo.netaDecal} />
                          : <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
