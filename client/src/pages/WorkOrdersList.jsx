// ─────────────────────────────────────────────────────────────────────────────
// WorkOrdersList.jsx — contractor job queue.
//
// GET /api/work-orders?status&siteId&contractorId&page → data.workOrders +
// data.pagination. Filter dropdowns hydrate from GET /api/contractors and
// GET /api/sites. The "New work order" modal is the shared
// components/NewWorkOrderModal.jsx (also opened from DeficienciesPage's
// "Create work order" action) -- it POSTs /api/work-orders, then this page
// navigates to the new job's detail page.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link, useSearchParams } from 'react-router-dom';
import { Plus, ClipboardList } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import EmptyState from '../components/EmptyState';
import Pagination from '../components/Pagination';
import NewWorkOrderModal from '../components/NewWorkOrderModal';
import { useFromState } from '../components/BackLink';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { WO_STATUS_META, DECAL_META, assetLabel, fmtDate } from '../lib/equipment';

const WO_STATUSES = ['SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'];

function metaOf(metaMap, key) {
  const m = metaMap?.[key];
  if (!m) return {};
  return typeof m === 'string' ? { label: m } : m;
}

// UX-8-3: lightweight skeleton table so the page shows structure while loading
// instead of a bare "Loading…". Pure CSS shimmer via inline keyframes.
function SkeletonRows({ rows = 6, cols = 8 }) {
  return (
    <div className="card" aria-busy="true" aria-label="Loading work orders">
      <style>{`@keyframes sc-shimmer{0%{opacity:.55}50%{opacity:1}100%{opacity:.55}}`}</style>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Asset</th><th>Site</th><th>Task</th><th>Contractor / tech</th>
              <th>Status</th><th style={{ textAlign: 'right' }}>Scheduled</th>
              <th style={{ textAlign: 'right' }}>Completed</th><th>Decal</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                {Array.from({ length: cols }).map((__, c) => (
                  <td key={c}>
                    <span style={{
                      display: 'inline-block', height: 12, width: c === 0 ? '70%' : c === 3 ? '60%' : '45%',
                      borderRadius: 4, background: 'var(--color-border, #e2e8f0)',
                      animation: 'sc-shimmer 1.2s ease-in-out infinite',
                    }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
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

// ─────────────────────────────────────────────────────────────────────────────
export default function WorkOrdersList() {
  useDocumentTitle('Work orders');
  const { user } = useAuth();
  const navigate = useNavigate();
  // C1: row clicks record this list as the origin for the detail BackLink.
  const fromState = useFromState();
  const canWrite = ['admin', 'manager'].includes(user?.role);

  // CUST-8-8: filters + page persist in the URL so returning from a job (or a
  // refresh / back-nav) restores exactly where you were instead of resetting.
  const [searchParams, setSearchParams] = useSearchParams();
  const WO_STATUS_SET = new Set(WO_STATUSES);

  const [workOrders, setWorkOrders] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filters, setFilters] = useState(() => {
    const status = searchParams.get('status') || '';
    return {
      status: WO_STATUS_SET.has(status) ? status : '',
      siteId: searchParams.get('siteId') || '',
      contractorId: searchParams.get('contractorId') || '',
    };
  });
  const [page, setPage] = useState(() => {
    const p = parseInt(searchParams.get('page'), 10);
    return Number.isFinite(p) && p >= 1 ? p : 1;
  });

  // Mirror filters + page → URL (replace so we don't spam history).
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDel = (k, v) => { if (v) next.set(k, v); else next.delete(k); };
    setOrDel('status', filters.status);
    setOrDel('siteId', filters.siteId);
    setOrDel('contractorId', filters.contractorId);
    setOrDel('page', page > 1 ? String(page) : '');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, page]);

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

        {loading && <SkeletonRows />}

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
              <Pagination
                page={page}
                totalPages={totalPages}
                label={`Page ${page} of ${totalPages}`}
                onPrev={() => setPage(p => p - 1)}
                onNext={() => setPage(p => p + 1)}
              />
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
