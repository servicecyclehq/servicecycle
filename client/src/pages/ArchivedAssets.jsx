// ─────────────────────────────────────────────────────────────────────────────
// ArchivedAssets.jsx — soft-deleted asset register (ServiceCycle Assets v1).
//
// GET /api/assets?archived=true shows ONLY archived rows (server convention).
// Unarchive restores the asset to the main register via
// POST /api/assets/:id/unarchive. History (work orders, lab samples,
// deficiencies) is preserved either way — archive is never destructive.
//
// 2026-06-11: same Excel-style per-column filter row + ColumnPicker as
// AssetsList (D1/D6 pattern). The fetch pulls the whole archived set in one
// page (FETCH_LIMIT) so the column filters + pagination run client-side;
// the ColumnPicker selection persists to localStorage (COL_VIS_KEY).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { kbdActivate } from '../lib/a11y';
import EmptyState from '../components/EmptyState';
import Toast from '../components/Toast';
import BackLink, { useFromState } from '../components/BackLink';
import ColumnPicker from '../components/ColumnPicker';
import HeaderFilter, { filterIsActive } from '../components/HeaderFilter';
import { EQUIPMENT_TYPE_LABELS, assetLabel, fmtDate } from '../lib/equipment';

const PAGE_SIZE = 25;
// Pull the whole archived set in one page so the per-column filters +
// pagination can run client-side (mirrors AssetsList's D1 FETCH_LIMIT).
const FETCH_LIMIT = 500;

// ─── Columns (ColumnPicker + filter row share these ids) ─────────────────────
const COLUMNS = [
  { id: 'equipment', label: 'Equipment' },
  { id: 'mfgModel',  label: 'Manufacturer / Model' },
  { id: 'serial',    label: 'Serial #' },
  { id: 'site',      label: 'Site' },
  { id: 'archived',  label: 'Archived' },
];
const DEFAULT_VISIBILITY = {
  equipment: true, mfgModel: true, serial: true, site: true, archived: true,
};
const COL_LABELS = Object.fromEntries(COLUMNS.map(c => [c.id, c.label]));
const COL_VIS_KEY = 'sc.archivedAssets.columnVisibility.v1';

// One entry per filterable column — same machinery as AssetsList.
const COL_FILTER_TYPES = {
  equipment: 'multi',
  mfgModel:  'multi',
  serial:    'text',
  site:      'multi',
  archived:  'date',
};
const emptyColFilter = (type) =>
  type === 'multi'  ? []
  : type === 'text' ? ''
  : type === 'date' ? { from: '', to: '' }
  :                   { min: '', max: '' };
const EMPTY_COL_FILTERS = Object.fromEntries(
  Object.entries(COL_FILTER_TYPES).map(([id, type]) => [id, emptyColFilter(type)])
);

// Keeps the global `th` uppercase/letter-spacing treatment off the controls.
const FILTER_TH_STYLE = {
  padding: '6px 16px 10px',
  textTransform: 'none',
  letterSpacing: 'normal',
  fontWeight: 400,
};

export default function ArchivedAssets() {
  useDocumentTitle('Archived Assets');
  const navigate = useNavigate();
  // C1: row clicks record this list as the origin for AssetDetail's BackLink.
  const fromState = useFromState();
  const confirm = useConfirm();
  const { features } = useAuth();
  // See AssetsList: assets_write with contracts_write fallback.
  const canWrite = features.assets_write ?? features.contracts_write;

  const [assets, setAssets]   = useState([]);
  const [page, setPage]       = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [toast, setToast]     = useState(null);
  const [busyId, setBusyId]   = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  // ─── Column visibility (ColumnPicker) ──────────────────────────────────────
  const [colVis, setColVisState] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(COL_VIS_KEY) || 'null');
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        return { ...DEFAULT_VISIBILITY, ...saved };
      }
    } catch { /* corrupted storage — fall through to defaults */ }
    return DEFAULT_VISIBILITY;
  });
  const setColVis = (next) => {
    setColVisState(next);
    try { localStorage.setItem(COL_VIS_KEY, JSON.stringify(next)); } catch { /* quota/private mode */ }
  };

  // ─── Per-column header filters (client-side) ───────────────────────────────
  const [colFilters, setColFilters] = useState(EMPTY_COL_FILTERS);
  const setColFilter = (id, v) => setColFilters(f => ({ ...f, [id]: v }));
  const activeColFilterIds = Object.keys(COL_FILTER_TYPES)
    .filter(id => filterIsActive(COL_FILTER_TYPES[id], colFilters[id]));

  // Reset to page 1 whenever a column filter changes.
  useEffect(() => { setPage(1); }, [colFilters]);

  // Fetch the whole archived set in one page; filtering + pagination are
  // client-side from here.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.get(`/api/assets?archived=true&page=1&limit=${FETCH_LIMIT}&sort=createdAt&sortDir=desc`)
      .then(r => {
        if (cancelled) return;
        const d = r.data.data || {};
        setAssets(d.assets || []);
        setError('');
      })
      .catch(() => { if (!cancelled) setError('Failed to load archived assets.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  // Distinct-value option lists, derived from the archived set.
  const colOptions = useMemo(() => {
    const uniq = (vals) => [...new Set(vals)];
    return {
      equipment: uniq(assets.map(a => a.equipmentType).filter(Boolean))
        .map(v => ({ value: v, label: EQUIPMENT_TYPE_LABELS[v] || v }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label))),
      mfgModel: uniq(assets.map(a => a.manufacturer || '')).sort()
        .map(v => ({ value: v, label: v || '(blank)' })),
      site: uniq(assets.map(a => a.site?.name).filter(Boolean)).sort()
        .map(v => ({ value: v, label: v })),
    };
  }, [assets]);

  // Apply column filters (AND across columns, OR within a column).
  const filteredAssets = useMemo(() => {
    const f = colFilters;
    return assets.filter(a => {
      if (f.equipment.length && !f.equipment.includes(a.equipmentType)) return false;
      if (f.mfgModel.length  && !f.mfgModel.includes(a.manufacturer || '')) return false;
      if (f.site.length      && !f.site.includes(a.site?.name)) return false;
      if (f.serial.trim()    && !(a.serialNumber || '').toLowerCase().includes(f.serial.trim().toLowerCase())) return false;
      if (f.archived.from || f.archived.to) {
        if (!a.archivedAt) return false;
        const d = String(a.archivedAt).slice(0, 10); // ISO date-only, lexicographic-safe
        if (f.archived.from && d < f.archived.from) return false;
        if (f.archived.to   && d > f.archived.to)   return false;
      }
      return true;
    });
  }, [assets, colFilters]);

  // Client-side pagination over the filtered rows.
  const totalPages  = Math.max(1, Math.ceil(filteredAssets.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageRows    = filteredAssets.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  // One chip per active column filter — individually clearable.
  const colFilterChipText = (id) => {
    const type  = COL_FILTER_TYPES[id];
    const v     = colFilters[id];
    const label = COL_LABELS[id] || id;
    if (type === 'multi') {
      const opts = colOptions[id] || [];
      if (v.length === 1) return `${label}: ${opts.find(o => o.value === v[0])?.label ?? v[0]}`;
      return `${label}: ${v.length} selected`;
    }
    if (type === 'text') return `${label} contains “${v.trim()}”`;
    if (type === 'date') {
      if (v.from && v.to) return `${label}: ${v.from} → ${v.to}`;
      return v.from ? `${label} ≥ ${v.from}` : `${label} ≤ ${v.to}`;
    }
    return label;
  };
  const activeChips = activeColFilterIds.map(id => ({
    key:   `col-${id}`,
    label: colFilterChipText(id),
    clear: () => setColFilter(id, emptyColFilter(COL_FILTER_TYPES[id])),
  }));

  async function handleUnarchive(asset) {
    if (busyId) return;
    if (!await confirm({
      title: 'Unarchive asset?',
      message: `${assetLabel(asset)} returns to the main register and resumes appearing in compliance views.`,
      confirmLabel: 'Unarchive',
    })) return;
    setBusyId(asset.id);
    try {
      await api.post(`/api/assets/${asset.id}/unarchive`);
      setToast({ message: `${assetLabel(asset)} unarchived.`, variant: 'success', duration: 4000 });
      setReloadKey(k => k + 1);
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to unarchive asset.', variant: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  const hasFilters = activeColFilterIds.length > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/assets" fallbackLabel="Assets" />
          <h1 className="page-title">Archived Assets</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : `${filteredAssets.length} archived asset${filteredAssets.length !== 1 ? 's' : ''}${hasFilters ? ' matching filters' : ''} — history preserved, hidden from the main register`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
          <ColumnPicker
            columns={COLUMNS}
            visibility={colVis}
            onChange={setColVis}
            defaults={DEFAULT_VISIBILITY}
          />
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* Active-filter chips — one per filter, individually clearable. */}
        {hasFilters && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {activeChips.map(chip => (
              <span
                key={chip.key}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '3px 8px 3px 10px', borderRadius: 20,
                  fontSize: 'var(--font-size-xs)', fontWeight: 600,
                  background: 'var(--color-primary-light, #eef6f6)',
                  color: 'var(--color-primary)',
                  border: '1px solid var(--color-primary)',
                  whiteSpace: 'nowrap',
                }}
              >
                {chip.label}
                <button
                  type="button"
                  aria-label={`Clear filter: ${chip.label}`}
                  onClick={chip.clear}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'inherit', padding: 0, lineHeight: 1,
                    fontSize: 13, fontWeight: 700,
                  }}
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setColFilters(EMPTY_COL_FILTERS)}
            >
              Clear all
            </button>
          </div>
        )}

        <div className="card">
          {loading ? (
            <div className="loading">Loading archived assets…</div>
          ) : assets.length === 0 ? (
            <EmptyState
              icon={Archive}
              title="No archived assets"
              sub="Assets you archive from their detail page will show up here, with all their maintenance history intact."
              ctaLabel="Back to Assets"
              ctaTo="/assets"
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {colVis.equipment && <th>Equipment</th>}
                      {colVis.mfgModel  && <th>Manufacturer / Model</th>}
                      {colVis.serial    && <th>Serial #</th>}
                      {colVis.site      && <th>Site</th>}
                      {colVis.archived  && <th>Archived</th>}
                      {canWrite && <th style={{ textAlign: 'right' }}></th>}
                    </tr>
                    {/* Excel-style filter row, one control per visible column. */}
                    <tr aria-label="Column filters">
                      {colVis.equipment && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Equipment" type="multi" options={colOptions.equipment}
                            value={colFilters.equipment} onChange={v => setColFilter('equipment', v)} />
                        </th>
                      )}
                      {colVis.mfgModel && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Manufacturer" type="multi" options={colOptions.mfgModel}
                            value={colFilters.mfgModel} onChange={v => setColFilter('mfgModel', v)} />
                        </th>
                      )}
                      {colVis.serial && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Serial #" type="text"
                            value={colFilters.serial} onChange={v => setColFilter('serial', v)} />
                        </th>
                      )}
                      {colVis.site && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Site" type="multi" options={colOptions.site}
                            value={colFilters.site} onChange={v => setColFilter('site', v)} />
                        </th>
                      )}
                      {colVis.archived && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Archived" type="date"
                            value={colFilters.archived} onChange={v => setColFilter('archived', v)} />
                        </th>
                      )}
                      {canWrite && <th style={FILTER_TH_STYLE}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 && (
                      <tr>
                        <td colSpan={COLUMNS.filter(c => colVis[c.id] !== false).length + (canWrite ? 1 : 0)}
                            style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--color-text-secondary)' }}>
                          No archived assets match the column filters.{' '}
                          <button
                            type="button"
                            onClick={() => setColFilters(EMPTY_COL_FILTERS)}
                            style={{
                              all: 'unset', cursor: 'pointer', fontWeight: 600,
                              color: 'var(--color-primary)', textDecoration: 'underline',
                            }}
                          >
                            Clear column filters
                          </button>
                        </td>
                      </tr>
                    )}
                    {pageRows.map(a => (
                      <tr
                        key={a.id}
                        style={{ opacity: 0.75, cursor: 'pointer' }}
                        onClick={() => navigate(`/assets/${a.id}`, { state: fromState })}
                        tabIndex={0}
                        onKeyDown={kbdActivate(() => navigate(`/assets/${a.id}`, { state: fromState }))}
                      >
                        {colVis.equipment && (
                          <td style={{ fontWeight: 600 }}>
                            {EQUIPMENT_TYPE_LABELS[a.equipmentType] || a.equipmentType}
                          </td>
                        )}
                        {colVis.mfgModel && (
                          <td>
                            {(a.manufacturer || a.model)
                              ? [a.manufacturer, a.model].filter(Boolean).join(' ')
                              : <span className="text-muted">—</span>}
                          </td>
                        )}
                        {colVis.serial   && <td className="td-muted">{a.serialNumber || '—'}</td>}
                        {colVis.site     && <td>{a.site?.name || '—'}</td>}
                        {colVis.archived && <td className="td-muted">{fmtDate(a.archivedAt)}</td>}
                        {canWrite && (
                          <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleUnarchive(a)}
                              disabled={busyId === a.id}
                            >
                              {busyId === a.id ? 'Restoring…' : 'Unarchive'}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {totalPages > 1 && (
                <div className="pagination">
                  <div className="pagination-info">
                    Page {pageClamped} of {totalPages} · {filteredAssets.length} assets
                  </div>
                  <div className="pagination-controls">
                    <button
                      type="button"
                      className="page-btn"
                      disabled={pageClamped <= 1}
                      onClick={() => setPage(Math.max(1, pageClamped - 1))}
                    >
                      ‹ Prev
                    </button>
                    <button
                      type="button"
                      className="page-btn"
                      disabled={pageClamped >= totalPages}
                      onClick={() => setPage(Math.min(totalPages, pageClamped + 1))}
                    >
                      Next ›
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
