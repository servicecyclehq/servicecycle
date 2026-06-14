// ─────────────────────────────────────────────────────────────────────────────
// SiteDetail.jsx — one facility: header/edit/archive, structure tree
// (buildings → areas → positions, plus site-direct areas/positions), assets
// at the site, and blackout windows.
//
// Server endpoints (verified against server/routes/sites.ts):
//   GET    /api/sites/:id
//   PUT    /api/sites/:id
//   POST   /api/sites/:id/archive
//   POST   /api/sites/:siteId/buildings      PUT/DELETE /api/sites/buildings/:id
//   POST   /api/sites/:siteId/areas          PUT/DELETE /api/sites/areas/:id
//   POST   /api/sites/:siteId/positions      PUT/DELETE /api/sites/positions/:id
//   POST   /api/sites/:siteId/blackout-windows
//   DELETE /api/sites/blackout-windows/:id
//   GET    /api/assets?siteId=
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Building2, Pencil, Trash2, Plus, Archive } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import Toast from '../components/Toast';
import BackLink, { useFromState } from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  EQUIPMENT_TYPE_LABELS, CONDITION_META, STUDY_TYPE_LABELS, assetLabel, fmtDate,
} from '../lib/equipment';

// Node-kind → API path segment for PUT/DELETE (mounted under /api/sites).
const KIND_PATH = {
  building: 'buildings',
  area:     'areas',
  position: 'positions',
};

function metaOf(metaMap, key) {
  const m = metaMap?.[key];
  if (!m) return {};
  return typeof m === 'string' ? { label: m } : m;
}

const EMPTY_STUDY = {
  studyType: 'arc_flash', performedDate: '', expiresAt: '', performedBy: '',
  method: '', peName: '', peLicense: '', trigger: '', reportPdfUrl: '', notes: '',
};

// Study-expiry urgency: red when past, amber within 6 months, none otherwise.
function studyExpiryStyle(d) {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  const days = (dt - new Date()) / 86400000;
  if (days < 0)   return { color: 'var(--color-danger, #dc2626)', fontWeight: 700 };
  if (days < 183) return { color: '#d97706', fontWeight: 600 };
  return null;
}

function fmtDateTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ── Inline add-input row ─────────────────────────────────────────────────────
function InlineAdd({ placeholder, onSubmit, onCancel, busy }) {
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (name.trim()) onSubmit(name.trim()); }}
      style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '4px 0' }}
    >
      <input
        className="form-control"
        style={{ maxWidth: 240, fontSize: 'var(--font-size-sm)', padding: '4px 8px' }}
        placeholder={placeholder}
        value={name}
        onChange={e => setName(e.target.value)}
        autoFocus
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>Add</button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>Cancel</button>
    </form>
  );
}

// ── One tree row with rename / delete controls ───────────────────────────────
function TreeRow({ kind, node, depth, canWrite, onRename, onDelete, trailing, children }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(node.name);
  const [busy, setBusy] = useState(false);

  const KIND_LABEL = { building: 'Building', area: 'Area', position: 'Position' };

  async function save(e) {
    e.preventDefault();
    if (!name.trim() || name.trim() === node.name) { setEditing(false); setName(node.name); return; }
    setBusy(true);
    const ok = await onRename(kind, node.id, name.trim());
    setBusy(false);
    if (ok) setEditing(false);
  }

  return (
    <div style={{ marginLeft: depth * 22 }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px',
          borderRadius: 'var(--radius)', minHeight: 32,
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = ''; }}
      >
        <span style={{
          fontSize: 'var(--font-size-2xs)', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.04em', color: 'var(--color-text-secondary)',
          width: 62, flexShrink: 0,
        }}>
          {KIND_LABEL[kind]}
        </span>
        {editing ? (
          <form onSubmit={save} style={{ display: 'flex', gap: 6, alignItems: 'center', flex: 1 }}>
            <input
              className="form-control"
              style={{ maxWidth: 240, fontSize: 'var(--font-size-sm)', padding: '4px 8px' }}
              value={name} onChange={e => setName(e.target.value)} autoFocus
            />
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Save</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setEditing(false); setName(node.name); }}>Cancel</button>
          </form>
        ) : (
          <>
            <span style={{ fontSize: 'var(--font-size-ui)', fontWeight: kind === 'building' ? 600 : 400 }}>
              {node.name}
              {kind === 'position' && node.code && (
                <span className="text-muted" style={{ marginLeft: 6, fontSize: 'var(--font-size-xs)' }}>({node.code})</span>
              )}
            </span>
            <span style={{ flex: 1 }} />
            {trailing}
            {canWrite && (
              <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
                <button
                  type="button" title={`Rename ${KIND_LABEL[kind].toLowerCase()}`}
                  onClick={() => setEditing(true)}
                  style={{ all: 'unset', cursor: 'pointer', padding: 4, color: 'var(--color-text-secondary)', display: 'inline-flex' }}
                >
                  <Pencil size={13} strokeWidth={1.75} />
                </button>
                <button
                  type="button" title={`Delete ${KIND_LABEL[kind].toLowerCase()}`}
                  onClick={() => onDelete(kind, node)}
                  style={{ all: 'unset', cursor: 'pointer', padding: 4, color: 'var(--color-danger)', display: 'inline-flex' }}
                >
                  <Trash2 size={13} strokeWidth={1.75} />
                </button>
              </span>
            )}
          </>
        )}
      </div>
      {children}
    </div>
  );
}

// ── Site edit form ───────────────────────────────────────────────────────────
function SiteEditForm({ site, onSaved, onCancel }) {
  const [form, setForm] = useState({
    name: site.name || '', address: site.address || '', city: site.city || '',
    state: site.state || '', postalCode: site.postalCode || '',
    primaryContactName: site.primaryContactName || '',
    primaryContactEmail: site.primaryContactEmail || '',
    primaryContactPhone: site.primaryContactPhone || '',
    notes: site.notes || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const res = await api.put(`/api/sites/${site.id}`, form);
      onSaved(res.data?.data?.site);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save site.');
      setSaving(false);
    }
  }

  const label = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };
  return (
    <form onSubmit={submit} style={{ padding: '16px 20px' }}>
      {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <div><label style={label}>Name *</label><input className="form-control form-control-wide" value={form.name} onChange={set('name')} maxLength={200} required /></div>
        <div><label style={label}>Address</label><input className="form-control form-control-wide" value={form.address} onChange={set('address')} /></div>
        <div><label style={label}>City</label><input className="form-control form-control-wide" value={form.city} onChange={set('city')} /></div>
        <div><label style={label}>State</label><input className="form-control form-control-wide" value={form.state} onChange={set('state')} /></div>
        <div><label style={label}>Postal code</label><input className="form-control form-control-wide" value={form.postalCode} onChange={set('postalCode')} /></div>
        <div><label style={label}>Contact name</label><input className="form-control form-control-wide" value={form.primaryContactName} onChange={set('primaryContactName')} /></div>
        <div><label style={label}>Contact email</label><input type="email" className="form-control form-control-wide" value={form.primaryContactEmail} onChange={set('primaryContactEmail')} /></div>
        <div><label style={label}>Contact phone</label><input className="form-control form-control-wide" value={form.primaryContactPhone} onChange={set('primaryContactPhone')} /></div>
      </div>
      <div style={{ marginTop: 12 }}>
        <label style={label}>Notes</label>
        <textarea className="form-control" rows={3} value={form.notes} onChange={set('notes')} />
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function SiteDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // C1: asset links record this site as the origin so AssetDetail's BackLink
  // returns here instead of the global Assets list.
  const fromState = useFromState();
  const { user, accountFeatures } = useAuth();
  const confirm = useConfirm();
  const canWrite = ['admin', 'manager'].includes(user?.role);

  const [site, setSite] = useState(null);
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [editing, setEditing] = useState(false);
  // adding = { kind: 'building'|'area'|'position', buildingId?, areaId? } | null
  const [adding, setAdding] = useState(null);
  const [busy, setBusy] = useState(false);

  // Blackout add form
  const [bwForm, setBwForm] = useState({ startsAt: '', endsAt: '', isOutageWindow: true, reason: '' });
  const [bwOpen, setBwOpen] = useState(false);
  const [bwSaving, setBwSaving] = useState(false);

  // System studies (audit-readiness). Add/edit shares one form; editingStudyId
  // null means the form creates via POST, otherwise saves via PUT.
  const [studies, setStudies] = useState([]);
  const [studyFormOpen, setStudyFormOpen] = useState(false);
  const [editingStudyId, setEditingStudyId] = useState(null);
  const [studyForm, setStudyForm] = useState(EMPTY_STUDY);
  const [studySaving, setStudySaving] = useState(false);

  useDocumentTitle(site ? site.name : 'Site');

  const fetchSite = useCallback(() => {
    return api.get(`/api/sites/${id}`)
      .then(r => setSite(r.data?.data?.site || null))
      .catch(err => setError(err.response?.status === 404 ? 'Site not found.' : 'Failed to load site.'));
  }, [id]);

  const fetchStudies = useCallback(() => {
    return api.get(`/api/sites/${id}/studies`)
      .then(r => setStudies(r.data?.data?.studies || []))
      .catch(() => { /* studies card simply shows empty — endpoint may lag the client (parallel build) */ });
  }, [id]);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchSite(),
      fetchStudies(),
      api.get('/api/assets', { params: { siteId: id, limit: 100 } })
        .then(r => setAssets(r.data?.data?.assets || []))
        .catch(() => { /* asset list is secondary — leave empty */ }),
    ]).finally(() => setLoading(false));
  }, [id, fetchSite, fetchStudies]);

  function apiError(err, fallback) {
    setToast({ message: err.response?.data?.error || fallback, variant: 'error' });
  }

  // ── Structure tree mutations ───────────────────────────────────────────────
  async function addNode(name) {
    if (!adding) return;
    setBusy(true);
    try {
      if (adding.kind === 'building') {
        await api.post(`/api/sites/${id}/buildings`, { name });
      } else if (adding.kind === 'area') {
        await api.post(`/api/sites/${id}/areas`, { name, buildingId: adding.buildingId || null });
      } else {
        await api.post(`/api/sites/${id}/positions`, { name, areaId: adding.areaId || null });
      }
      setAdding(null);
      await fetchSite();
    } catch (err) {
      apiError(err, 'Failed to add.');
    } finally {
      setBusy(false);
    }
  }

  async function renameNode(kind, nodeId, name) {
    try {
      await api.put(`/api/sites/${KIND_PATH[kind]}/${nodeId}`, { name });
      await fetchSite();
      return true;
    } catch (err) {
      apiError(err, 'Failed to rename.');
      return false;
    }
  }

  async function deleteNode(kind, node) {
    const ok = await confirm({
      title: `Delete ${kind} "${node.name}"?`,
      message: 'This cannot be undone. Deletion is blocked while anything still belongs to it.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/sites/${KIND_PATH[kind]}/${node.id}`);
      await fetchSite();
    } catch (err) {
      apiError(err, 'Failed to delete.');
    }
  }

  // ── Header actions ─────────────────────────────────────────────────────────
  async function archiveSite() {
    const ok = await confirm({
      title: `Archive "${site.name}"?`,
      message: 'The site drops out of the sites list. Its assets and history stay addressable; you can unarchive later.',
      confirmLabel: 'Archive',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.post(`/api/sites/${id}/archive`);
      navigate('/sites');
    } catch (err) {
      apiError(err, 'Failed to archive site.');
    }
  }

  // ── Blackout windows ───────────────────────────────────────────────────────
  async function addBlackout(e) {
    e.preventDefault();
    if (!bwForm.startsAt || !bwForm.endsAt) return;
    setBwSaving(true);
    try {
      await api.post(`/api/sites/${id}/blackout-windows`, {
        startsAt: new Date(bwForm.startsAt).toISOString(),
        endsAt:   new Date(bwForm.endsAt).toISOString(),
        isOutageWindow: bwForm.isOutageWindow,
        reason: bwForm.reason || null,
      });
      setBwForm({ startsAt: '', endsAt: '', isOutageWindow: true, reason: '' });
      setBwOpen(false);
      await fetchSite();
    } catch (err) {
      apiError(err, 'Failed to add blackout window.');
    } finally {
      setBwSaving(false);
    }
  }

  async function deleteBlackout(w) {
    const ok = await confirm({
      title: 'Delete this blackout window?',
      message: `${fmtDateTime(w.startsAt)} → ${fmtDateTime(w.endsAt)}${w.reason ? ` (${w.reason})` : ''}`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/sites/blackout-windows/${w.id}`);
      await fetchSite();
    } catch (err) {
      apiError(err, 'Failed to delete blackout window.');
    }
  }

  // ── System studies ─────────────────────────────────────────────────────────
  function openStudyForm(study) {
    if (study) {
      setEditingStudyId(study.id);
      setStudyForm({
        studyType:     study.studyType || 'arc_flash',
        performedDate: study.performedDate ? String(study.performedDate).slice(0, 10) : '',
        expiresAt:     study.expiresAt ? String(study.expiresAt).slice(0, 10) : '',
        performedBy:   study.performedBy || '',
        method:        study.method || '',
        peName:        study.peName || '',
        peLicense:     study.peLicense || '',
        trigger:       study.trigger || '',
        reportPdfUrl:  study.reportPdfUrl || '',
        notes:         study.notes || '',
      });
    } else {
      setEditingStudyId(null);
      setStudyForm(EMPTY_STUDY);
    }
    setStudyFormOpen(true);
  }

  async function saveStudy(e) {
    e.preventDefault();
    if (!studyForm.studyType || !studyForm.performedDate) return;
    setStudySaving(true);
    try {
      const body = {
        studyType:     studyForm.studyType,
        performedDate: studyForm.performedDate,
        expiresAt:     studyForm.expiresAt || null,
        performedBy:   studyForm.performedBy.trim() || null,
        method:        studyForm.method.trim() || null,
        peName:        studyForm.peName.trim() || null,
        peLicense:     studyForm.peLicense.trim() || null,
        trigger:       studyForm.trigger.trim() || null,
        reportPdfUrl:  studyForm.reportPdfUrl.trim() || null,
        notes:         studyForm.notes.trim() || null,
      };
      if (editingStudyId) {
        await api.put(`/api/sites/studies/${editingStudyId}`, body);
      } else {
        await api.post(`/api/sites/${id}/studies`, body);
      }
      setStudyFormOpen(false);
      setEditingStudyId(null);
      setStudyForm(EMPTY_STUDY);
      await fetchStudies();
      setToast({ message: editingStudyId ? 'Study updated.' : 'Study recorded.', variant: 'success', duration: 4000 });
    } catch (err) {
      apiError(err, 'Failed to save study.');
    } finally {
      setStudySaving(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">Site</h1></div>
        <div className="page-body"><div className="loading">Loading site…</div></div>
      </>
    );
  }
  if (error || !site) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">Site</h1></div>
        <div className="page-body">
          <div role="alert" className="alert alert-error">{error || 'Site not found.'}</div>
          <BackLink fallback="/sites" fallbackLabel="Sites" className="btn btn-secondary" style={{ marginTop: 12 }} />
        </div>
      </>
    );
  }

  const loc = [site.address, [site.city, site.state].filter(Boolean).join(', '), site.postalCode]
    .filter(Boolean).join(' · ');
  const addBtn = (label, payload) => (
    <button
      type="button" className="btn btn-secondary btn-sm"
      onClick={() => setAdding(payload)}
      style={{ fontSize: 'var(--font-size-xs)' }}
    >
      <Plus size={12} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 4 }} />{label}
    </button>
  );
  const isAdding = (kind, buildingId = null, areaId = null) =>
    adding && adding.kind === kind && (adding.buildingId || null) === buildingId && (adding.areaId || null) === areaId;

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink
            fallback="/sites" fallbackLabel="Sites"
            style={{ padding: 0, marginBottom: 4, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}
          />
          <h1 className="page-title">{site.name}</h1>
          <div className="page-subtitle">
            {loc || 'No address on file'}
            {site.primaryContactName && (
              <> · Contact: {site.primaryContactName}
                {site.primaryContactPhone ? ` (${site.primaryContactPhone})` : ''}
              </>
            )}
          </div>
        </div>
        {canWrite && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setEditing(e => !e)}>
              <Pencil size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {editing ? 'Close editor' : 'Edit site'}
            </button>
            <button className="btn btn-secondary" onClick={archiveSite} style={{ color: 'var(--color-danger)' }}>
              <Archive size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Archive
            </button>
          </div>
        )}
      </div>

      <div className="page-body">
        {editing && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><div className="card-title">Edit site</div></div>
            <SiteEditForm
              site={site}
              onSaved={(updated) => { setSite(s => ({ ...s, ...updated })); setEditing(false); setToast({ message: 'Site saved.', variant: 'success', duration: 4000 }); }}
              onCancel={() => setEditing(false)}
            />
          </div>
        )}

        {/* ── Structure tree ─────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title">
                <Building2 size={15} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                Structure
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Buildings, areas, and equipment positions. Areas and positions can also hang directly off the site.
              </div>
            </div>
            {canWrite && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {addBtn('Building', { kind: 'building' })}
                {addBtn('Area', { kind: 'area' })}
                {addBtn('Position', { kind: 'position' })}
              </div>
            )}
          </div>
          <div style={{ padding: '8px 16px 16px' }}>
            {isAdding('building') && <InlineAdd placeholder="Building name" onSubmit={addNode} onCancel={() => setAdding(null)} busy={busy} />}
            {isAdding('area') && <InlineAdd placeholder="Area name (site-direct)" onSubmit={addNode} onCancel={() => setAdding(null)} busy={busy} />}
            {isAdding('position') && <InlineAdd placeholder="Position name (site-direct)" onSubmit={addNode} onCancel={() => setAdding(null)} busy={busy} />}

            {(site.buildings?.length || 0) + (site.areas?.length || 0) + (site.positions?.length || 0) === 0 && (
              <div style={{ padding: '16px 4px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                No structure defined yet{canWrite ? ' — add a building, area, or position above.' : '.'}
              </div>
            )}

            {(site.buildings || []).map(b => (
              <TreeRow
                key={b.id} kind="building" node={b} depth={0}
                canWrite={canWrite} onRename={renameNode} onDelete={deleteNode}
                trailing={canWrite && (
                  <button
                    type="button" className="btn btn-secondary btn-sm"
                    style={{ fontSize: 'var(--font-size-2xs)', padding: '2px 8px' }}
                    onClick={() => setAdding({ kind: 'area', buildingId: b.id })}
                  >
                    + Area
                  </button>
                )}
              >
                {isAdding('area', b.id) && (
                  <div style={{ marginLeft: 22 }}>
                    <InlineAdd placeholder={`Area name in ${b.name}`} onSubmit={addNode} onCancel={() => setAdding(null)} busy={busy} />
                  </div>
                )}
                {(b.areas || []).map(a => (
                  <TreeRow
                    key={a.id} kind="area" node={a} depth={1}
                    canWrite={canWrite} onRename={renameNode} onDelete={deleteNode}
                    trailing={canWrite && (
                      <button
                        type="button" className="btn btn-secondary btn-sm"
                        style={{ fontSize: 'var(--font-size-2xs)', padding: '2px 8px' }}
                        onClick={() => setAdding({ kind: 'position', areaId: a.id })}
                      >
                        + Position
                      </button>
                    )}
                  >
                    {isAdding('position', null, a.id) && (
                      <div style={{ marginLeft: 22 }}>
                        <InlineAdd placeholder={`Position name in ${a.name}`} onSubmit={addNode} onCancel={() => setAdding(null)} busy={busy} />
                      </div>
                    )}
                    {(a.positions || []).map(p => (
                      <TreeRow key={p.id} kind="position" node={p} depth={2} canWrite={canWrite} onRename={renameNode} onDelete={deleteNode} />
                    ))}
                  </TreeRow>
                ))}
              </TreeRow>
            ))}

            {/* Site-direct areas */}
            {(site.areas || []).map(a => (
              <TreeRow
                key={a.id} kind="area" node={a} depth={0}
                canWrite={canWrite} onRename={renameNode} onDelete={deleteNode}
                trailing={canWrite && (
                  <button
                    type="button" className="btn btn-secondary btn-sm"
                    style={{ fontSize: 'var(--font-size-2xs)', padding: '2px 8px' }}
                    onClick={() => setAdding({ kind: 'position', areaId: a.id })}
                  >
                    + Position
                  </button>
                )}
              >
                {isAdding('position', null, a.id) && (
                  <div style={{ marginLeft: 22 }}>
                    <InlineAdd placeholder={`Position name in ${a.name}`} onSubmit={addNode} onCancel={() => setAdding(null)} busy={busy} />
                  </div>
                )}
                {(a.positions || []).map(p => (
                  <TreeRow key={p.id} kind="position" node={p} depth={1} canWrite={canWrite} onRename={renameNode} onDelete={deleteNode} />
                ))}
              </TreeRow>
            ))}

            {/* Site-direct positions */}
            {(site.positions || []).map(p => (
              <TreeRow key={p.id} kind="position" node={p} depth={0} canWrite={canWrite} onRename={renameNode} onDelete={deleteNode} />
            ))}
          </div>
        </div>

        {/* ── Assets at this site ────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Assets at this site</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {site._count?.assets ?? assets.length} active asset{(site._count?.assets ?? assets.length) !== 1 ? 's' : ''}
              </div>
            </div>
            {canWrite && (
              <Link to="/assets/new" className="btn btn-secondary btn-sm">Add asset</Link>
            )}
          </div>
          {assets.length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No assets at this site yet
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Type</th>
                    <th>Condition</th>
                    <th>Next Due</th>
                    <th style={{ textAlign: 'right' }}>Open deficiencies</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map(a => {
                    const cm = metaOf(CONDITION_META, a.governingCondition);
                    return (
                      <tr key={a.id}>
                        <td>
                          <Link to={`/assets/${a.id}`} state={fromState} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                            {assetLabel(a)}
                          </Link>
                        </td>
                        <td className="td-muted">{EQUIPMENT_TYPE_LABELS?.[a.equipmentType] || a.equipmentType || '—'}</td>
                        <td>
                          {a.governingCondition ? (
                            <span style={{ fontWeight: 600, color: cm.color || 'var(--color-text)' }}>
                              {cm.label || a.governingCondition}
                            </span>
                          ) : <span className="text-muted">—</span>}
                        </td>
                        {/* D5 (2026-06-11): Next Due — soonest active schedule
                            (decorated as `nextDue` by GET /api/assets). */}
                        <td>
                          {a.nextDue ? (
                            <span style={{
                              fontWeight: 600,
                              color: new Date(a.nextDue) < new Date() ? 'var(--color-danger)' : 'var(--color-text)',
                              whiteSpace: 'nowrap',
                            }}>
                              {fmtDate(a.nextDue)}{new Date(a.nextDue) < new Date() ? ' · overdue' : ''}
                            </span>
                          ) : <span className="text-muted">—</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {(a.openDeficiencyCount ?? 0) > 0
                            ? <span style={{ fontWeight: 700, color: 'var(--color-danger)' }}>{a.openDeficiencyCount}</span>
                            : <span className="text-muted">0</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Blackout windows ───────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Blackout windows</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Planned outage windows allow outage work inside them; work freezes block all work.
              </div>
            </div>
            {canWrite && (
              <button className="btn btn-secondary btn-sm" onClick={() => setBwOpen(o => !o)}>
                {bwOpen ? 'Cancel' : '+ Add window'}
              </button>
            )}
          </div>

          {bwOpen && (
            <form onSubmit={addBlackout} style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Starts</label>
                  <input
                    type="datetime-local" className="form-control" required
                    value={bwForm.startsAt}
                    onChange={e => setBwForm(f => ({ ...f, startsAt: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Ends</label>
                  <input
                    type="datetime-local" className="form-control" required
                    value={bwForm.endsAt}
                    min={bwForm.startsAt || undefined}
                    onChange={e => setBwForm(f => ({ ...f, endsAt: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Type</label>
                  <select
                    className="form-control"
                    value={bwForm.isOutageWindow ? 'outage' : 'freeze'}
                    onChange={e => setBwForm(f => ({ ...f, isOutageWindow: e.target.value === 'outage' }))}
                  >
                    <option value="outage">Planned outage window</option>
                    <option value="freeze">Work freeze</option>
                  </select>
                </div>
                <div style={{ flex: '1 1 200px' }}>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Reason</label>
                  <input
                    className="form-control form-control-wide"
                    placeholder="e.g. Annual plant shutdown"
                    value={bwForm.reason}
                    onChange={e => setBwForm(f => ({ ...f, reason: e.target.value }))}
                  />
                </div>
                <button type="submit" className="btn btn-primary" disabled={bwSaving || !bwForm.startsAt || !bwForm.endsAt}>
                  {bwSaving ? 'Adding…' : 'Add window'}
                </button>
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
                A planned outage window means outage-requiring work may be scheduled inside it.
                A work freeze means no maintenance work at all during the window.
              </div>
            </form>
          )}

          {(site.blackoutWindows || []).length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No upcoming blackout windows
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Window</th>
                    <th>Type</th>
                    <th>Reason</th>
                    {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {(site.blackoutWindows || []).map(w => (
                    <tr key={w.id}>
                      <td style={{ fontSize: 'var(--font-size-sm)' }}>
                        {fmtDateTime(w.startsAt)} {String.fromCharCode(8594)} {fmtDateTime(w.endsAt)}
                      </td>
                      <td>
                        <span style={{
                          display: 'inline-block', padding: '2px 8px', borderRadius: 999,
                          fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
                          background: w.isOutageWindow ? 'var(--color-success-bg, rgba(34,197,94,0.12))' : 'var(--color-danger-bg, rgba(220,38,38,0.10))',
                          color: w.isOutageWindow ? 'var(--color-success, #15803d)' : 'var(--color-danger, #dc2626)',
                        }}>
                          {w.isOutageWindow ? 'Planned outage window' : 'Work freeze'}
                        </span>
                      </td>
                      <td className="td-muted">{w.reason || '—'}</td>
                      {canWrite && (
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button" className="btn btn-secondary btn-sm"
                            style={{ color: 'var(--color-danger)' }}
                            onClick={() => deleteBlackout(w)}
                          >
                            Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── System studies (#25 arc-flash / coordination) ───────────────── */}
        {/* Gated behind the per-account arc_flash_studies flag — code intact,
            not rendered when the account has arc-flash management off. */}
        {accountFeatures.arc_flash_studies && (
        <div className="card" style={{ marginBottom: 20 }}>
          <div className="card-header">
            <div>
              <div className="card-title">System Studies</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Arc flash, short-circuit, coordination, and one-line reviews for this site
              </div>
            </div>
            {canWrite && (
              <button className="btn btn-secondary btn-sm" onClick={() => (studyFormOpen ? setStudyFormOpen(false) : openStudyForm(null))}>
                {studyFormOpen ? 'Cancel' : '+ Add study'}
              </button>
            )}
          </div>

          <div style={{
            padding: '10px 20px', borderBottom: '1px solid var(--color-border)',
            fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.5,
          }}>
            Auditors ask for: current arc flash study, short-circuit + coordination studies
            (≤5 years), and a dated one-line diagram review.
          </div>

          {canWrite && studyFormOpen && (
            <form onSubmit={saveStudy} style={{ padding: '12px 20px', borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', marginBottom: 10 }}>
                {editingStudyId ? 'Edit study' : 'Record a study'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Study type *</label>
                  <select
                    className="form-control form-control-wide" required
                    value={studyForm.studyType}
                    onChange={e => setStudyForm(f => ({ ...f, studyType: e.target.value }))}
                  >
                    {Object.entries(STUDY_TYPE_LABELS).map(([k, lbl]) => <option key={k} value={k}>{lbl}</option>)}
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Performed date *</label>
                  <input
                    type="date" className="form-control form-control-wide" required
                    value={studyForm.performedDate}
                    onChange={e => setStudyForm(f => ({ ...f, performedDate: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Expires</label>
                  <input
                    type="date" className="form-control form-control-wide"
                    value={studyForm.expiresAt}
                    min={studyForm.performedDate || undefined}
                    onChange={e => setStudyForm(f => ({ ...f, expiresAt: e.target.value }))}
                  />
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    Optional — defaults to 5 years from performed date.
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Performed by</label>
                  <input
                    className="form-control form-control-wide" placeholder="Engineering firm / individual"
                    value={studyForm.performedBy}
                    onChange={e => setStudyForm(f => ({ ...f, performedBy: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Method</label>
                  <input
                    className="form-control form-control-wide" placeholder="e.g. IEEE 1584-2018"
                    value={studyForm.method}
                    onChange={e => setStudyForm(f => ({ ...f, method: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>PE name</label>
                  <input
                    className="form-control form-control-wide"
                    value={studyForm.peName}
                    onChange={e => setStudyForm(f => ({ ...f, peName: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>PE license #</label>
                  <input
                    className="form-control form-control-wide"
                    value={studyForm.peLicense}
                    onChange={e => setStudyForm(f => ({ ...f, peLicense: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Trigger</label>
                  <input
                    className="form-control form-control-wide" placeholder="e.g. 5-year cycle, system modification"
                    value={studyForm.trigger}
                    onChange={e => setStudyForm(f => ({ ...f, trigger: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Report PDF URL</label>
                  <input
                    className="form-control form-control-wide" placeholder="https://…"
                    value={studyForm.reportPdfUrl}
                    onChange={e => setStudyForm(f => ({ ...f, reportPdfUrl: e.target.value }))}
                  />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>Notes</label>
                <textarea
                  className="form-control" rows={2}
                  value={studyForm.notes}
                  onChange={e => setStudyForm(f => ({ ...f, notes: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button
                  type="button" className="btn btn-secondary"
                  onClick={() => { setStudyFormOpen(false); setEditingStudyId(null); }}
                  disabled={studySaving}
                >
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={studySaving || !studyForm.studyType || !studyForm.performedDate}>
                  {studySaving ? 'Saving…' : editingStudyId ? 'Save study' : 'Record study'}
                </button>
              </div>
            </form>
          )}

          {studies.length === 0 ? (
            <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No studies recorded for this site yet
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Study</th>
                    <th>Performed</th>
                    <th>Expires</th>
                    <th>PE</th>
                    <th>Method</th>
                    <th>Report</th>
                    {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {studies.map(st => {
                    const expStyle = studyExpiryStyle(st.expiresAt);
                    const expired = st.expiresAt && new Date(st.expiresAt) < new Date();
                    return (
                      <tr key={st.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{STUDY_TYPE_LABELS[st.studyType] || st.studyType}</div>
                          {(st.performedBy || st.trigger) && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                              {[st.performedBy, st.trigger].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td>{fmtDate(st.performedDate)}</td>
                        <td>
                          <span style={expStyle || undefined} className={expStyle ? undefined : 'td-muted'}>
                            {fmtDate(st.expiresAt)}{expired ? ' · expired' : ''}
                          </span>
                        </td>
                        <td className="td-muted">
                          {st.peName
                            ? <>{st.peName}{st.peLicense ? <div style={{ fontSize: 'var(--font-size-xs)' }}>Lic. {st.peLicense}</div> : null}</>
                            : '—'}
                        </td>
                        <td className="td-muted">{st.method || '—'}</td>
                        <td>
                          {st.reportPdfUrl
                            ? <a href={st.reportPdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Open</a>
                            : <span className="text-muted">—</span>}
                        </td>
                        {canWrite && (
                          <td style={{ textAlign: 'right' }}>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => openStudyForm(st)}>
                              Edit
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        )}
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
