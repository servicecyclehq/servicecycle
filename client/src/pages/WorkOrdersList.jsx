// ─────────────────────────────────────────────────────────────────────────────
// WorkOrdersList.jsx — contractor job queue.
//
// GET /api/work-orders?status&siteId&contractorId&page → data.workOrders +
// data.pagination. Filter dropdowns hydrate from GET /api/contractors and
// GET /api/sites. "New work order" modal: asset picker (GET /api/assets
// search), optional schedule picker (GET /api/schedules?assetId=), contractor
// + tech pickers, scheduledDate, netaCertLevel, notes → POST /api/work-orders
// → navigate to the new job's detail page.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Plus, ClipboardList } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import EmptyState from '../components/EmptyState';
import { useFromState } from '../components/BackLink';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { WO_STATUS_META, DECAL_META, assetLabel, fmtDate } from '../lib/equipment';

const WO_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'];
const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];
const CERT_LABELS = {
  LEVEL_I: 'Level I', LEVEL_II: 'Level II', LEVEL_III: 'Level III', LEVEL_IV: 'Level IV',
};

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

// ── New work order modal ─────────────────────────────────────────────────────
function NewWorkOrderModal({ contractors, onClose, onCreated, initialAssetId = '' }) {
  const [assetSearch, setAssetSearch] = useState('');
  const [assets, setAssets] = useState([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [techs, setTechs] = useState([]);
  const [form, setForm] = useState({
    assetId: initialAssetId, scheduleId: '', contractorId: '', assignedTechId: '',
    netaCertLevel: '', scheduledDate: '', notes: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const label = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };

  // Asset search (debounced).
  useEffect(() => {
    setAssetsLoading(true);
    const t = setTimeout(() => {
      api.get('/api/assets', { params: { limit: 100, ...(assetSearch ? { search: assetSearch } : {}) } })
        .then(r => setAssets(r.data?.data?.assets || []))
        .catch(() => setAssets([]))
        .finally(() => setAssetsLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [assetSearch]);

  // Schedules for the chosen asset.
  useEffect(() => {
    if (!form.assetId) { setSchedules([]); return; }
    api.get('/api/schedules', { params: { assetId: form.assetId, limit: 100 } })
      .then(r => setSchedules(r.data?.data?.schedules || []))
      .catch(() => setSchedules([]));
  }, [form.assetId]);

  // Tech roster for the chosen contractor.
  useEffect(() => {
    if (!form.contractorId) { setTechs([]); return; }
    api.get(`/api/contractors/${form.contractorId}`)
      .then(r => setTechs(r.data?.data?.contractor?.techs || []))
      .catch(() => setTechs([]));
  }, [form.contractorId]);

  async function submit(e) {
    e.preventDefault();
    if (!form.assetId) { setError('Pick an asset.'); return; }
    setSaving(true); setError('');
    try {
      const res = await api.post('/api/work-orders', {
        assetId:        form.assetId,
        scheduleId:     form.scheduleId || null,
        contractorId:   form.contractorId || null,
        assignedTechId: form.assignedTechId || null,
        netaCertLevel:  form.netaCertLevel || null,
        scheduledDate:  form.scheduledDate || null,
        notes:          form.notes || null,
      });
      onCreated(res.data?.data?.workOrder);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create work order.');
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog" aria-modal="true" aria-label="New work order"
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
          maxWidth: 560, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 14 }}>New work order</div>
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 12 }}>
          <label style={label}>Asset <span style={{ color: 'var(--color-danger)' }}>*</span></label>
          <input
            className="form-control form-control-wide"
            placeholder="Search by manufacturer, model, serial, or site…"
            value={assetSearch}
            onChange={e => setAssetSearch(e.target.value)}
            style={{ marginBottom: 6 }}
          />
          <select
            className="form-control form-control-wide" required
            value={form.assetId}
            onChange={e => setForm(f => ({ ...f, assetId: e.target.value, scheduleId: '' }))}
            size={Math.min(Math.max(assets.length, 2), 6)}
          >
            {assetsLoading && <option value="" disabled>Searching…</option>}
            {!assetsLoading && assets.length === 0 && <option value="" disabled>No matching assets</option>}
            {assets.map(a => (
              <option key={a.id} value={a.id}>
                {assetLabel(a)}{a.site?.name ? ` — ${a.site.name}` : ''}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={label}>Maintenance schedule (optional)</label>
          <select
            className="form-control form-control-wide"
            value={form.scheduleId}
            onChange={e => setForm(f => ({ ...f, scheduleId: e.target.value }))}
            disabled={!form.assetId}
          >
            <option value="">No linked schedule — ad hoc job</option>
            {schedules.map(s => (
              <option key={s.id} value={s.id}>
                {s.taskDefinition?.taskName || 'Task'}
                {s.nextDueDate ? ` — due ${fmtDate(s.nextDueDate)}` : ''}
              </option>
            ))}
          </select>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            Linking a schedule rolls its next-due date forward when the job completes.
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={label}>Contractor</label>
            <select
              className="form-control form-control-wide"
              value={form.contractorId}
              onChange={e => setForm(f => ({ ...f, contractorId: e.target.value, assignedTechId: '' }))}
            >
              <option value="">Unassigned / in-house</option>
              {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label style={label}>Assigned tech</label>
            <select
              className="form-control form-control-wide"
              value={form.assignedTechId}
              onChange={e => setForm(f => ({ ...f, assignedTechId: e.target.value }))}
              disabled={!form.contractorId}
            >
              <option value="">—</option>
              {techs.map(t => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.netaCertLevel ? ` (NETA ${CERT_LABELS[t.netaCertLevel] || t.netaCertLevel})` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={label}>Scheduled date</label>
            <input
              type="date" className="form-control form-control-wide"
              value={form.scheduledDate}
              onChange={e => setForm(f => ({ ...f, scheduledDate: e.target.value }))}
            />
          </div>
          <div>
            <label style={label}>Required NETA cert level</label>
            <select
              className="form-control form-control-wide"
              value={form.netaCertLevel}
              onChange={e => setForm(f => ({ ...f, netaCertLevel: e.target.value }))}
            >
              <option value="">From task definition / none</option>
              {NETA_CERT_LEVELS.map(l => <option key={l} value={l}>{CERT_LABELS[l]}</option>)}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label style={label}>Notes</label>
          <textarea
            className="form-control" rows={3}
            value={form.notes}
            onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !form.assetId}>
            {saving ? 'Creating…' : 'Create work order'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function WorkOrdersList() {
  useDocumentTitle('Work orders');
  const { user } = useAuth();
  const navigate = useNavigate();
  // C1: row clicks record this list as the origin for the detail BackLink.
  const fromState = useFromState();
  const canWrite = ['admin', 'manager'].includes(user?.role);

  const [workOrders, setWorkOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState({ status: '', siteId: '', contractorId: '' });
  const [page, setPage] = useState(1);

  const [contractors, setContractors] = useState([]);
  const [sites, setSites] = useState([]);
  const [showNew, setShowNew] = useState(false);

  // ── Priority Queue ──────────────────────────────────────────────────────────
  const [pqAssets, setPqAssets]   = useState([]);
  const [pqLoading, setPqLoading] = useState(true);
  const [pqError,   setPqError]   = useState('');
  // Pre-fill for NewWorkOrderModal when launched from a priority queue row.
  const [newWoAssetId, setNewWoAssetId] = useState(null);

  // Filter sources + priority queue (one-shot).
  useEffect(() => {
    api.get('/api/contractors')
      .then(r => setContractors(r.data?.data?.contractors || []))
      .catch(() => {});
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => {});
    // Priority queue — top 10 scored assets with no open work order.
    api.get('/api/work-orders/priority-queue')
      .then(r => setPqAssets(r.data?.data?.assets || []))
      .catch(() => setPqError('Failed to load priority queue.'))
      .finally(() => setPqLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    setError('');
    const params = { page };
    if (filters.status)       params.status = filters.status;
    if (filters.siteId)       params.siteId = filters.siteId;
    if (filters.contractorId) params.contractorId = filters.contractorId;
    api.get('/api/work-orders', { params })
      .then(r => {
        setWorkOrders(r.data?.data?.workOrders || []);
        setPagination(r.data?.data?.pagination || null);
      })
      .catch(() => setError('Failed to load work orders.'))
      .finally(() => setLoading(false));
  }, [filters, page]);

  const setFilter = (k) => (e) => {
    setFilters(f => ({ ...f, [k]: e.target.value }));
    setPage(1);
  };

  const hasFilters = filters.status || filters.siteId || filters.contractorId;
  const totalPages = pagination?.pages || 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Work orders</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : `${pagination?.total ?? workOrders.length} job${(pagination?.total ?? workOrders.length) !== 1 ? 's' : ''}${hasFilters ? ' (filtered)' : ''}`}
          </div>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>
            <Plus size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            New work order
          </button>
        )}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* ── Filters ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
          <select className="form-control" value={filters.status} onChange={setFilter('status')} aria-label="Filter by status">
            <option value="">All statuses</option>
            {WO_STATUSES.map(s => (
              <option key={s} value={s}>{metaOf(WO_STATUS_META, s).label || s}</option>
            ))}
          </select>
          <select className="form-control" value={filters.siteId} onChange={setFilter('siteId')} aria-label="Filter by site">
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="form-control" value={filters.contractorId} onChange={setFilter('contractorId')} aria-label="Filter by contractor">
            <option value="">All contractors</option>
            {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {hasFilters && (
            <button
              type="button" className="btn btn-secondary btn-sm"
              onClick={() => { setFilters({ status: '', siteId: '', contractorId: '' }); setPage(1); }}
            >
              Clear filters
            </button>
          )}
        </div>

        {/* ── Priority Queue ───────────────────────────────────────────────── */}
        {(pqLoading || pqError || pqAssets.length > 0) && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 600 }}>Priority Queue</h2>
                <p style={{ margin: '2px 0 0', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  Top scored assets (DPS = condition × criticality) with no open work order.
                </p>
              </div>
            </div>
            {pqError && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{pqError}</div>}
            {pqLoading && !pqError && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>}
            {!pqLoading && !pqError && pqAssets.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Asset</th>
                      <th>Site</th>
                      <th style={{ textAlign: 'right' }} title="Deficiency Priority Score: condition score × criticality score. Range 1–25. Higher = more urgent.">DPS</th>
                      <th style={{ textAlign: 'right' }}>Condition</th>
                      <th style={{ textAlign: 'right' }}>Criticality</th>
                      {canWrite && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {pqAssets.map(a => {
                      const name = [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || 'Asset';
                      const dps = a.priorityScore;
                      const dpsColor = dps >= 20 ? '#c62828' : dps >= 16 ? '#e65100' : 'var(--color-text)';
                      return (
                        <tr key={a.id}>
                          <td>
                            <Link to={`/assets/${a.id}`} state={fromState} style={{ fontWeight: 500 }}>{name}</Link>
                            {a.serialNumber && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginLeft: 6 }}>#{a.serialNumber}</span>}
                          </td>
                          <td className="td-muted">{a.site?.name || '—'}</td>
                          <td style={{ textAlign: 'right', fontWeight: 700, color: dpsColor }}>{dps}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{a.conditionScore ?? '—'}</td>
                          <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{a.criticalityScore ?? '—'}</td>
                          {canWrite && (
                            <td style={{ textAlign: 'right' }}>
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => { setNewWoAssetId(a.id); setShowNew(true); }}
                              >
                                Create work order
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

        {loading && <div className="loading">Loading work orders…</div>}

        {!loading && workOrders.length === 0 && !error && (
          <div className="card">
            <EmptyState
              icon={ClipboardList}
              title={hasFilters ? 'No work orders match these filters' : 'No work orders yet'}
              sub={hasFilters
                ? 'Try clearing a filter or two.'
                : 'Work orders track each contractor visit against an asset — create one to schedule maintenance or testing.'}
              ctaLabel={!hasFilters && canWrite ? 'New work order' : undefined}
              ctaOnClick={!hasFilters && canWrite ? () => setShowNew(true) : undefined}
            />
          </div>
        )}

        {!loading && workOrders.length > 0 && (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Site</th>
                    <th>Task</th>
                    <th>Contractor / tech</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Scheduled</th>
                    <th style={{ textAlign: 'right' }}>Completed</th>
                    <th>Decal</th>
                  </tr>
                </thead>
                <tbody>
                  {workOrders.map(wo => {
                    const go = () => navigate(`/work-orders/${wo.id}`, { state: fromState });
                    return (
                      <tr
                        key={wo.id}
                        style={{ cursor: 'pointer' }}
                        onClick={go} tabIndex={0} onKeyDown={kbdActivate(go)}
                      >
                        <td>
                          <Link
                            to={`/work-orders/${wo.id}`}
                            state={fromState}
                            onClick={e => e.stopPropagation()}
                            style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}
                          >
                            {assetLabel(wo.asset)}
                          </Link>
                        </td>
                        <td className="td-muted">{wo.asset?.site?.name || '—'}</td>
                        <td>{wo.schedule?.taskDefinition?.taskName || <span className="text-muted">Ad hoc</span>}</td>
                        <td className="td-muted">
                          {wo.contractor?.name || '—'}
                          {wo.assignedTech?.name && (
                            <div style={{ fontSize: 'var(--font-size-xs)' }}>{wo.assignedTech.name}</div>
                          )}
                        </td>
                        <td><Chip meta={metaOf(WO_STATUS_META, wo.status)} fallback={wo.status} /></td>
                        <td style={{ textAlign: 'right' }} className="td-muted">{fmtDate(wo.scheduledDate)}</td>
                        <td style={{ textAlign: 'right' }} className="td-muted">{fmtDate(wo.completedDate)}</td>
                        <td>
                          {wo.netaDecal
                            ? <Chip meta={metaOf(DECAL_META, wo.netaDecal)} fallback={wo.netaDecal} />
                            : <span className="text-muted">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {totalPages > 1 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, padding: '10px 16px', borderTop: '1px solid var(--color-border)' }}>
                <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  {String.fromCharCode(8592)} Prev
                </button>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  Page {page} of {totalPages}
                </span>
                <button className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  Next {String.fromCharCode(8594)}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showNew && (
        <NewWorkOrderModal
          contractors={contractors}
          initialAssetId={newWoAssetId || ''}
          onClose={() => { setShowNew(false); setNewWoAssetId(null); }}
          onCreated={(wo) => {
            setShowNew(false);
            setNewWoAssetId(null);
            if (wo?.id) navigate(`/work-orders/${wo.id}`, { state: fromState });
          }}
        />
      )}
    </>
  );
}
