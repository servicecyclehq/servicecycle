// ─────────────────────────────────────────────────────────────────────────────
// AssetsList.jsx — equipment asset register (ServiceCycle Assets v1).
//
// Single-round-trip mount via GET /api/bootstrap (assets + site/contractor/
// member lookups + settings). The toolbar filters (search, site/type/
// condition, owner/service/due-window, risk chips) are SERVER-side and flow
// into both the bootstrap fetch and the XLSX export URL via
// buildFilterParams().
//
// D1 (2026-06-11): Excel-style per-column filters. The bootstrap fetch now
// pulls the full server-filtered set in one page (FETCH_LIMIT) and the
// dedicated filter row beneath the column headers narrows it CLIENT-side
// (AND across columns, OR within a column's multi-select), with client-side
// pagination over the filtered rows. Column filters do NOT flow into the
// XLSX export (server filters only).
//
// D6 (2026-06-11): the ColumnPicker selection persists to localStorage
// (COL_VIS_KEY), merged over DEFAULT_VISIBILITY so newly added columns pick
// up their default without nuking the user's choices.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Upload, Zap } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { kbdActivate } from '../lib/a11y';
import EmptyState from '../components/EmptyState';
import Toast from '../components/Toast';
import { useFromState } from '../components/BackLink';
import ColumnPicker from '../components/ColumnPicker';
import HeaderFilter, { filterIsActive } from '../components/HeaderFilter';
import {
  EQUIPMENT_TYPE_LABELS,
  CONDITION_META,
  CRITICALITY_SCORE_META,
  fmtDate,
  fmtMoney,
} from '../lib/equipment';

const PAGE_SIZE = 25;

// D1: pull the whole server-filtered set in one bootstrap page so the
// per-column filters + pagination can run client-side. Well above the demo
// population (~67 assets); revisit if a tenant ever approaches this.
const FETCH_LIMIT = 500;

// ─── Columns (ColumnPicker + filter row share these ids) ─────────────────────
// D2 (2026-06-11): ordered so the "does this need attention?" quartet
// (Equipment · Condition · Next Due · Open Def.) leads; identity/metadata
// columns (Serial #, Address, Owner) are hidden by default but stay
// available in the column picker.
const COLUMNS = [
  { id: 'equipment',    label: 'Equipment' },
  { id: 'condition',    label: 'Condition' },
  { id: 'nextDue',       label: 'Next Due' },
  { id: 'openDef',      label: 'Open Def.' },
  { id: 'criticality',  label: 'Criticality' },
  { id: 'location',     label: 'Location' },
  { id: 'mfgModel',     label: 'Manufacturer / Model' },
  { id: 'serial',       label: 'Serial #' },
  { id: 'nameplate',    label: 'Nameplate' },
  { id: 'address',      label: 'Address' },
  { id: 'owner',        label: 'Owner' },
  { id: 'repairCost',    label: 'Repair Cost' },
  { id: 'priorityScore', label: 'Priority Score' },
  { id: 'service',      label: 'Service' },
];
const DEFAULT_VISIBILITY = {
  equipment: true, mfgModel: true, serial: false, location: true,
  address: false, owner: false, condition: true, criticality: true,
  repairCost: false, priorityScore: false, nextDue: true, openDef: true, service: true,
  nameplate: true,
};
const COL_LABELS = Object.fromEntries(COLUMNS.map(c => [c.id, c.label]));
// D6: ColumnPicker selection persists here (bump the suffix if ids change).
const COL_VIS_KEY = 'sc.assetsList.columnVisibility.v1';

// ─── D1 column-filter machinery ──────────────────────────────────────────────
// One entry per filterable column. type drives both the HeaderFilter control
// and the predicate: multi (string[], OR), text (contains), date ({from,to}),
// number ({min,max}). Columns combine with AND.
const COL_FILTER_TYPES = {
  equipment:     'multi',
  condition:     'multi',
  nextDue:       'date',
  openDef:       'number',
  criticality:   'multi',
  location:      'multi',
  mfgModel:      'multi',
  serial:        'text',
  address:       'multi',
  owner:         'multi',
  repairCost:    'number',
  priorityScore: 'number',
  service:       'multi',
};
const emptyColFilter = (type) =>
  type === 'multi'  ? []
  : type === 'text' ? ''
  : type === 'date' ? { from: '', to: '' }
  :                   { min: '', max: '' };
const EMPTY_COL_FILTERS = Object.fromEntries(
  Object.entries(COL_FILTER_TYPES).map(([id, type]) => [id, emptyColFilter(type)])
);

// Static option lists for the binary categorical columns.
const SERVICE_OPTIONS = [
  { value: 'true',  label: 'In service' },
  { value: 'false', label: 'Out of service' },
];
const ADDRESS_OPTIONS = [
  { value: 'yes', label: 'Has address' },
  { value: 'no',  label: 'No address' },
];

// Address completeness mirrors the cell render: street address OR city+state.
const assetHasAddress = (a) => !!(a.site?.address || (a.site?.city && a.site?.state));

// Style override for the filter-row header cells — keeps the global `th`
// uppercase/letter-spacing treatment off the controls.
const FILTER_TH_STYLE = {
  padding: '6px 16px 10px',
  textTransform: 'none',
  letterSpacing: 'normal',
  fontWeight: 400,
};

export function ConditionBadge({ condition, compact }) {
  const meta = CONDITION_META[condition];
  if (!meta) return <span className="text-muted">—</span>;
  return (
    <span style={{
      display: 'inline-block',
      padding: '2px 9px',
      borderRadius: 20,
      fontSize: 'var(--font-size-xs)',
      fontWeight: 700,
      letterSpacing: '0.03em',
      background: meta.bg,
      color: meta.color,
      border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
      whiteSpace: 'nowrap',
    }}>
      {compact ? condition : meta.label}
    </span>
  );
}

// Compact numeric criticality badge (1–5) — full consequence label in the
// tooltip; the table column stays narrow. Reused by Dashboard's priority card.
export function CriticalityBadge({ score }) {
  const meta = CRITICALITY_SCORE_META[score];
  if (!meta) return <span className="text-muted">—</span>;
  return (
    <span
      title={`Criticality ${score} — ${meta.label}`}
      style={{
        display: 'inline-block', minWidth: 26, textAlign: 'center',
        padding: '2px 8px', borderRadius: 20,
        fontSize: 'var(--font-size-xs)', fontWeight: 700,
        background: meta.bg, color: meta.color, border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
        whiteSpace: 'nowrap',
      }}
    >
      {score}
    </span>
  );
}

function NextDueCell({ schedule }) {
  if (!schedule?.nextDueDate) return <span className="text-muted">—</span>;
  const overdue = new Date(schedule.nextDueDate) < new Date();
  return (
    <div>
      <div style={{ fontWeight: 600, color: overdue ? 'var(--color-danger)' : 'var(--color-text)', fontSize: 'var(--font-size-ui)' }}>
        {fmtDate(schedule.nextDueDate)}{overdue ? ' · overdue' : ''}
      </div>
      {schedule.taskDefinition?.taskName && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          {schedule.taskDefinition.taskName}
        </div>
      )}
    </div>
  );
}

export default function AssetsList() {
  useDocumentTitle('Assets');
  const navigate = useNavigate();
  // C1: row clicks record this list (path only — filters live in state, not
  // the URL) as the origin for AssetDetail's BackLink.
  const fromState = useFromState();
  const { features } = useAuth();
  // assets_write is the converted feature key; fall back to contracts_write
  // until AuthContext's flag catalog is retargeted (same role semantics —
  // admin/manager can write, viewer/consultant cannot).
  const canWrite = features.assets_write ?? features.contracts_write;

  const [data, setData]       = useState({ assets: [], pagination: { page: 1, pages: 1, total: 0 }, sites: [], equipmentTypes: [], members: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [toast, setToast]     = useState(null);
  const [exporting, setExporting] = useState(false);

  // Deep links (Dashboard's volume tab and elsewhere) pre-filter via
  // /assets?equipmentType=X&siteId=&dueWithin= — read once on mount, then
  // state owns the value (B5: drill-down counts land pre-filtered).
  const [searchParams] = useSearchParams();

  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [siteId, setSiteId]       = useState(() => searchParams.get('siteId') || '');
  const [equipmentType, setEquipmentType] = useState(() => searchParams.get('equipmentType') || '');
  const [condition, setCondition] = useState('');
  // Column-filter row (second toolbar row): responsible person, service
  // status, and due window. ownerId accepts a member uuid or the literal
  // 'unassigned'; dueWithin is 'overdue' | '30' | '60' | '90'.
  const [ownerId, setOwnerId]         = useState('');
  const [inServiceF, setInServiceF]   = useState('');
  const [dueWithin, setDueWithin]     = useState(() => {
    const q = searchParams.get('dueWithin');
    return ['overdue', '30', '60', '90'].includes(q) ? q : '';
  });
  // Risk filters: minimum criticality score ('' | '3' | '4' | '5') and the
  // predictive-maintenance-only toggle chip.
  const [minCriticality, setMinCriticality] = useState('');
  const [predictiveOnly, setPredictiveOnly] = useState(false);
  // High Priority filter: DPS >= 16 (priorityScore >= 16)
  const [highPriority,   setHighPriority]   = useState(false);
  // Server-side sort: '' (default order) | 'criticality' | 'repairCost' | 'priorityScore',
  // all descending server-side. Toggled by clicking the column headers.
  const [sort, setSort] = useState('');

  // ─── Column visibility (ColumnPicker, D6) ──────────────────────────────────
  // Persisted to localStorage and merged over DEFAULT_VISIBILITY so columns
  // added later still appear with their default state.
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

  // ─── D1: per-column header filters (client-side) ───────────────────────────
  const [colFilters, setColFilters] = useState(EMPTY_COL_FILTERS);
  const setColFilter = (id, v) => setColFilters(f => ({ ...f, [id]: v }));
  const activeColFilterIds = Object.keys(COL_FILTER_TYPES)
    .filter(id => filterIsActive(COL_FILTER_TYPES[id], colFilters[id]));

  // Debounce the search box so we don't hammer /api/bootstrap per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever a filter (server-side OR a D1 column filter) or
  // the sort changes (skip the initial mount).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setPage(1);
  }, [debouncedSearch, siteId, equipmentType, condition, ownerId, inServiceF, dueWithin, minCriticality, predictiveOnly, highPriority, sort, colFilters]);

  function buildFilterParams() {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (siteId)          params.set('siteId', siteId);
    if (equipmentType)   params.set('equipmentType', equipmentType);
    if (condition)       params.set('governingCondition', condition);
    if (ownerId)         params.set('ownerId', ownerId);
    if (inServiceF)      params.set('inService', inServiceF);
    if (dueWithin)       params.set('dueWithin', dueWithin);
    if (minCriticality)  params.set('minCriticality', minCriticality);
    if (predictiveOnly)  params.set('requiresPredictiveMaintenance', 'true');
    if (highPriority)    params.set('minPriorityScore', '16');
    return params;
  }

  // Fetch the full server-filtered set in one page (D1: column filters and
  // pagination are client-side, so the server page param is always 1).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = buildFilterParams();
    if (sort) params.set('sort', sort);
    params.set('page', '1');
    params.set('limit', String(FETCH_LIMIT));
    api.get(`/api/bootstrap?${params}`)
      .then(r => {
        if (cancelled) return;
        const d = r.data.data || {};
        setData({
          assets:         d.assets || [],
          pagination:     d.pagination || { page: 1, pages: 1, total: 0 },
          sites:          d.sites || [],
          equipmentTypes: d.equipmentTypes || Object.keys(EQUIPMENT_TYPE_LABELS),
          members:        d.members || [],
        });
        setError('');
      })
      .catch(() => { if (!cancelled) setError('Failed to load assets.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, siteId, equipmentType, condition, ownerId, inServiceF, dueWithin, minCriticality, predictiveOnly, highPriority, sort]);

  const hasFilters = !!(debouncedSearch || siteId || equipmentType || condition || ownerId || inServiceF || dueWithin || minCriticality || predictiveOnly || highPriority || activeColFilterIds.length);
  const { assets, sites, equipmentTypes, members } = data;

  // ─── D1: distinct-value option lists, derived from the current data set ────
  const colOptions = useMemo(() => {
    const uniq = (vals) => [...new Set(vals)];
    const byLabel = (a, b) => String(a.label).localeCompare(String(b.label));
    return {
      equipment: uniq(assets.map(a => a.equipmentType).filter(Boolean))
        .map(v => ({ value: v, label: EQUIPMENT_TYPE_LABELS[v] || v })).sort(byLabel),
      condition: uniq(assets.map(a => a.governingCondition).filter(Boolean)).sort()
        .map(v => ({ value: v, label: CONDITION_META[v]?.label || v })),
      criticality: uniq(assets.map(a => a.criticalityScore).filter(v => v != null))
        .sort((a, b) => a - b)
        .map(v => ({
          value: String(v),
          label: CRITICALITY_SCORE_META[v]?.label ? `${v} — ${CRITICALITY_SCORE_META[v].label}` : String(v),
        })),
      location: uniq(assets.map(a => a.site?.name).filter(Boolean)).sort()
        .map(v => ({ value: v, label: v })),
      mfgModel: uniq(assets.map(a => a.manufacturer || '')).sort()
        .map(v => ({ value: v, label: v || '(blank)' })),
      owner: uniq(assets.map(a => a.owner?.name || 'Unassigned')).sort()
        .map(v => ({ value: v, label: v })),
    };
  }, [assets]);

  // ─── D1: apply column filters (AND across columns, OR within a column) ─────
  const filteredAssets = useMemo(() => {
    const f = colFilters;
    const numOk = (val, { min, max }) => {
      if (min === '' && max === '') return true;
      if (val == null) return false;
      const n = Number(val);
      if (min !== '' && n < Number(min)) return false;
      if (max !== '' && n > Number(max)) return false;
      return true;
    };
    return assets.filter(a => {
      if (f.equipment.length   && !f.equipment.includes(a.equipmentType)) return false;
      if (f.condition.length   && !f.condition.includes(a.governingCondition)) return false;
      if (f.criticality.length && !f.criticality.includes(String(a.criticalityScore))) return false;
      if (f.location.length    && !f.location.includes(a.site?.name)) return false;
      if (f.mfgModel.length    && !f.mfgModel.includes(a.manufacturer || '')) return false;
      if (f.owner.length       && !f.owner.includes(a.owner?.name || 'Unassigned')) return false;
      if (f.service.length     && !f.service.includes(String(!!a.inService))) return false;
      if (f.address.length     && !f.address.includes(assetHasAddress(a) ? 'yes' : 'no')) return false;
      if (f.serial.trim()      && !(a.serialNumber || '').toLowerCase().includes(f.serial.trim().toLowerCase())) return false;
      if (f.nextDue.from || f.nextDue.to) {
        const due = a.schedules?.[0]?.nextDueDate;
        if (!due) return false;
        const d = String(due).slice(0, 10); // ISO date-only, lexicographic-safe
        if (f.nextDue.from && d < f.nextDue.from) return false;
        if (f.nextDue.to   && d > f.nextDue.to)   return false;
      }
      if (!numOk(a._count?.deficiencies ?? 0, f.openDef)) return false;
      if (!numOk(a.repairCostEstimate, f.repairCost)) return false;
      if (!numOk(a.priorityScore, f.priorityScore)) return false;
      return true;
    });
  }, [assets, colFilters]);

  // Client-side pagination over the filtered rows (D1).
  const totalPages  = Math.max(1, Math.ceil(filteredAssets.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const pageRows    = filteredAssets.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  function clearAllFilters() {
    setSearch(''); setSiteId(''); setEquipmentType(''); setCondition('');
    setOwnerId(''); setInServiceF(''); setDueWithin('');
    setMinCriticality(''); setPredictiveOnly(false); setHighPriority(false);
    setColFilters(EMPTY_COL_FILTERS);
  }

  // Column-header sort toggle: click to sort by this key (server default is
  // descending), click again to return to the default order.
  const toggleSort = (key) => setSort(s => (s === key ? '' : key));

  const DUE_WITHIN_LABELS = { overdue: 'Overdue', 30: 'Due ≤ 30 days', 60: 'Due ≤ 60 days', 90: 'Due ≤ 90 days' };

  // One chip per active filter — each individually clearable, plus a
  // clear-all at the end of the row (extends the old single-button pattern).
  const activeChips = [];
  if (debouncedSearch) activeChips.push({ key: 'search', label: `Search: “${debouncedSearch}”`, clear: () => setSearch('') });
  if (siteId)          activeChips.push({ key: 'site', label: `Site: ${sites.find(s => s.id === siteId)?.name || 'selected'}`, clear: () => setSiteId('') });
  if (equipmentType)   activeChips.push({ key: 'type', label: `Type: ${EQUIPMENT_TYPE_LABELS[equipmentType] || equipmentType}`, clear: () => setEquipmentType('') });
  if (condition)       activeChips.push({ key: 'condition', label: `Condition: ${CONDITION_META[condition]?.label || condition}`, clear: () => setCondition('') });
  if (ownerId)         activeChips.push({
    key: 'owner',
    label: `Owner: ${ownerId === 'unassigned' ? 'Unassigned' : (members.find(m => m.id === ownerId)?.name || 'selected')}`,
    clear: () => setOwnerId(''),
  });
  if (inServiceF)      activeChips.push({ key: 'inservice', label: `In service: ${inServiceF === 'true' ? 'Yes' : 'No'}`, clear: () => setInServiceF('') });
  if (dueWithin)       activeChips.push({ key: 'due', label: DUE_WITHIN_LABELS[dueWithin] || dueWithin, clear: () => setDueWithin('') });
  if (minCriticality)  activeChips.push({ key: 'crit', label: minCriticality === '5' ? 'Criticality: 5' : `Criticality: ${minCriticality}+`, clear: () => setMinCriticality('') });
  if (predictiveOnly)  activeChips.push({ key: 'predictive', label: 'Predictive maintenance', clear: () => setPredictiveOnly(false) });
  if (highPriority)    activeChips.push({ key: 'highpriority', label: 'High Priority (DPS ≥16)', clear: () => setHighPriority(false) });

  // D1: one chip per active column filter, mirroring the header controls.
  const colFilterChipText = (id) => {
    const type  = COL_FILTER_TYPES[id];
    const v     = colFilters[id];
    const label = COL_LABELS[id] || id;
    if (type === 'multi') {
      const opts = id === 'service' ? SERVICE_OPTIONS
                 : id === 'address' ? ADDRESS_OPTIONS
                 : (colOptions[id] || []);
      if (v.length === 1) return `${label}: ${opts.find(o => o.value === v[0])?.label ?? v[0]}`;
      return `${label}: ${v.length} selected`;
    }
    if (type === 'text') return `${label} contains “${v.trim()}”`;
    if (type === 'date') {
      if (v.from && v.to) return `${label}: ${v.from} → ${v.to}`;
      return v.from ? `${label} ≥ ${v.from}` : `${label} ≤ ${v.to}`;
    }
    if (v.min !== '' && v.max !== '') return `${label}: ${v.min}–${v.max}`;
    return v.min !== '' ? `${label} ≥ ${v.min}` : `${label} ≤ ${v.max}`;
  };
  activeColFilterIds.forEach(id => activeChips.push({
    key:   `col-${id}`,
    label: colFilterChipText(id),
    clear: () => setColFilter(id, emptyColFilter(COL_FILTER_TYPES[id])),
  }));

  async function handleExport() {
    if (exporting) return;
    setExporting(true);
    setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
    try {
      const params = buildFilterParams();
      params.set('view', 'assets');
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/xlsx?${params}`;
      await downloadAuthedFile(url, `Assets-${new Date().toISOString().split('T')[0]}.xlsx`);
      setToast({ title: 'Export ready', message: 'Your file is downloading.', variant: 'success', duration: 4000 });
    } catch (e) {
      setToast({ title: 'Export failed', message: e.message || 'Could not build the export.', variant: 'error' });
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Assets</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : `${filteredAssets.length} asset${filteredAssets.length !== 1 ? 's' : ''}${hasFilters ? ' matching filters' : ' under maintenance management'}`}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
          <ColumnPicker
            columns={COLUMNS}
            visibility={colVis}
            onChange={setColVis}
            defaults={DEFAULT_VISIBILITY}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleExport}
            disabled={exporting || loading || assets.length === 0}
            title="Download an XLSX of the assets matching the current search + toolbar filters (per-column header filters are not applied to exports)"
          >
            <Download size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {exporting ? 'Preparing export…' : 'Export'}
          </button>
          {canWrite && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => navigate('/assets/import')}
              title="Bulk import assets from a CSV or Excel spreadsheet"
            >
              <Upload size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Import
            </button>
          )}
          {canWrite && (
            <button type="button" className="btn btn-primary" onClick={() => navigate('/assets/new')}>
              <Plus size={14} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              Add asset
            </button>
          )}
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div className="filters-bar" style={{ marginBottom: 16 }}>
          <input
            type="search"
            className="search-input"
            placeholder="Search manufacturer, model, serial #, site…"
            aria-label="Search assets"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <select
            className="filter-select"
            aria-label="Filter by site"
            value={siteId}
            onChange={e => setSiteId(e.target.value)}
          >
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            className="filter-select"
            aria-label="Filter by equipment type"
            value={equipmentType}
            onChange={e => setEquipmentType(e.target.value)}
          >
            <option value="">All equipment types</option>
            {equipmentTypes.map(t => (
              <option key={t} value={t}>{EQUIPMENT_TYPE_LABELS[t] || t}</option>
            ))}
          </select>
          <select
            className="filter-select"
            aria-label="Filter by governing condition"
            value={condition}
            onChange={e => setCondition(e.target.value)}
          >
            <option value="">All conditions</option>
            {Object.entries(CONDITION_META).map(([k, m]) => (
              <option key={k} value={k}>{m.label}</option>
            ))}
          </select>
        </div>

        {/* Column filters — second toolbar row (owner / service status / due window). */}
        <div className="filters-bar" style={{ marginBottom: hasFilters ? 10 : 16 }}>
          <select
            className="filter-select"
            aria-label="Filter by responsible person"
            value={ownerId}
            onChange={e => setOwnerId(e.target.value)}
          >
            <option value="">All owners</option>
            <option value="unassigned">Unassigned</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <select
            className="filter-select"
            aria-label="Filter by service status"
            value={inServiceF}
            onChange={e => setInServiceF(e.target.value)}
          >
            <option value="">In service: All</option>
            <option value="true">In service: Yes</option>
            <option value="false">In service: No</option>
          </select>
          <select
            className="filter-select"
            aria-label="Filter by maintenance due window"
            value={dueWithin}
            onChange={e => setDueWithin(e.target.value)}
          >
            <option value="">Any due window</option>
            <option value="overdue">Overdue</option>
            <option value="30">Due ≤ 30 days</option>
            <option value="60">Due ≤ 60 days</option>
            <option value="90">Due ≤ 90 days</option>
          </select>
          <select
            className="filter-select"
            aria-label="Filter by minimum criticality score"
            value={minCriticality}
            onChange={e => setMinCriticality(e.target.value)}
          >
            <option value="">Any criticality</option>
            <option value="3">Criticality 3+</option>
            <option value="4">Criticality 4+</option>
            <option value="5">Criticality 5</option>
          </select>
          {/* Predictive-maintenance toggle chip — a binary filter, so a chip
              button beats a 2-option dropdown. */}
          <button
            type="button"
            aria-pressed={predictiveOnly}
            title="Show only assets flagged for predictive maintenance"
            onClick={() => setPredictiveOnly(v => !v)}
            style={{
              padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
              fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
              background: predictiveOnly ? 'var(--color-primary-light, #eef6f6)' : 'var(--color-bg)',
              color: predictiveOnly ? 'var(--color-primary)' : 'var(--color-text-secondary)',
              border: `1px solid ${predictiveOnly ? 'var(--color-primary)' : 'var(--color-border)'}`,
            }}
          >
            {predictiveOnly ? '✓ ' : ''}Predictive maintenance
          </button>
          {/* High Priority toggle chip — shows assets with DPS (priorityScore) >= 16. */}
          <button
            type="button"
            aria-pressed={highPriority}
            title="Show only high-priority assets (Degradation Priority Score ≥ 16)"
            onClick={() => setHighPriority(v => !v)}
            style={{
              padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
              fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
              background: highPriority ? '#fff3e0' : 'var(--color-bg)',
              color: highPriority ? '#e65100' : 'var(--color-text-secondary)',
              border: `1px solid ${highPriority ? '#e65100' : 'var(--color-border)'}`,
            }}
          >
            {highPriority ? '✓ ' : ''}High Priority
          </button>
        </div>

        {/* Active-filter chips — one per filter, individually clearable, with
            a one-click clear-all (extends the old single Clear button). */}
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
              onClick={clearAllFilters}
            >
              Clear all
            </button>
          </div>
        )}

        <div className="card">
          {loading ? (
            <div className="loading">Loading assets…</div>
          ) : assets.length === 0 ? (
            hasFilters ? (
              <EmptyState
                icon={Zap}
                title="No assets match these filters"
                sub="Try widening the search or clearing a filter."
              />
            ) : (
              <EmptyState
                icon={Zap}
                title="No assets yet"
                sub="Add your first piece of electrical equipment to start tracking NFPA 70B maintenance compliance."
                ctaLabel={canWrite ? 'Add asset' : undefined}
                ctaTo={canWrite ? '/assets/new' : undefined}
              />
            )
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {colVis.equipment   && <th>Equipment</th>}
                      {colVis.condition   && <th>Condition</th>}
                      {colVis.nextDue     && <th>Next Due</th>}
                      {colVis.openDef     && <th style={{ textAlign: 'right' }}>Open Def.</th>}
                      {colVis.criticality && (
                        <th
                          role="button" tabIndex={0}
                          aria-sort={sort === 'criticality' ? 'descending' : 'none'}
                          title="Sort by criticality score (highest first)"
                          onClick={() => toggleSort('criticality')}
                          onKeyDown={kbdActivate(() => toggleSort('criticality'))}
                          style={{ cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', color: sort === 'criticality' ? 'var(--color-primary)' : undefined }}
                        >
                          Criticality{sort === 'criticality' ? ' ▼' : ''}
                        </th>
                      )}
                      {colVis.location    && <th>Location</th>}
                      {colVis.mfgModel    && <th>Manufacturer / Model</th>}
                      {colVis.serial      && <th>Serial #</th>}
                      {colVis.nameplate   && <th title="Whether a nameplate photo has been captured for this asset">Nameplate</th>}
                      {colVis.address     && (
                        <th title="Whether this asset's site has a street address on record">Address</th>
                      )}
                      {colVis.owner       && <th>Owner</th>}
                      {colVis.repairCost  && (
                        <th
                          role="button" tabIndex={0}
                          aria-sort={sort === 'repairCost' ? 'descending' : 'none'}
                          title="Sort by repair cost estimate (highest first)"
                          onClick={() => toggleSort('repairCost')}
                          onKeyDown={kbdActivate(() => toggleSort('repairCost'))}
                          style={{ cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', textAlign: 'right', color: sort === 'repairCost' ? 'var(--color-primary)' : undefined }}
                        >
                          Repair Cost{sort === 'repairCost' ? ' ▼' : ''}
                        </th>
                      )}
                      {colVis.priorityScore && (
                        <th
                          role="button" tabIndex={0}
                          aria-sort={sort === 'priorityScore' ? 'descending' : 'none'}
                          title="Sort by Degradation Priority Score (DPS = conditionScore × criticalityScore, highest first)"
                          onClick={() => toggleSort('priorityScore')}
                          onKeyDown={kbdActivate(() => toggleSort('priorityScore'))}
                          style={{ cursor: 'pointer', whiteSpace: 'nowrap', userSelect: 'none', textAlign: 'right', color: sort === 'priorityScore' ? 'var(--color-primary)' : undefined }}
                        >
                          Priority Score{sort === 'priorityScore' ? ' ▼' : ''}
                        </th>
                      )}
                      {colVis.service     && <th>Service</th>}
                    </tr>
                    {/* D1 — Excel-style filter row, one control per visible column. */}
                    <tr aria-label="Column filters">
                      {colVis.equipment && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Equipment" type="multi" options={colOptions.equipment}
                            value={colFilters.equipment} onChange={v => setColFilter('equipment', v)} />
                        </th>
                      )}
                      {colVis.condition && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Condition" type="multi" options={colOptions.condition}
                            value={colFilters.condition} onChange={v => setColFilter('condition', v)} />
                        </th>
                      )}
                      {colVis.nextDue && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Next Due" type="date"
                            value={colFilters.nextDue} onChange={v => setColFilter('nextDue', v)} />
                        </th>
                      )}
                      {colVis.openDef && (
                        <th style={{ ...FILTER_TH_STYLE, textAlign: 'right' }}>
                          <HeaderFilter label="Open Def." type="number" align="right"
                            value={colFilters.openDef} onChange={v => setColFilter('openDef', v)} />
                        </th>
                      )}
                      {colVis.criticality && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Criticality" type="multi" options={colOptions.criticality}
                            value={colFilters.criticality} onChange={v => setColFilter('criticality', v)} />
                        </th>
                      )}
                      {colVis.location && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Location" type="multi" options={colOptions.location}
                            value={colFilters.location} onChange={v => setColFilter('location', v)} />
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
                      {colVis.nameplate && <th style={FILTER_TH_STYLE} />}
                      {colVis.address && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Address" type="multi" options={ADDRESS_OPTIONS}
                            value={colFilters.address} onChange={v => setColFilter('address', v)} />
                        </th>
                      )}
                      {colVis.owner && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Owner" type="multi" options={colOptions.owner}
                            value={colFilters.owner} onChange={v => setColFilter('owner', v)} />
                        </th>
                      )}
                      {colVis.repairCost && (
                        <th style={{ ...FILTER_TH_STYLE, textAlign: 'right' }}>
                          <HeaderFilter label="Repair Cost" type="number" align="right"
                            value={colFilters.repairCost} onChange={v => setColFilter('repairCost', v)} />
                        </th>
                      )}
                      {colVis.priorityScore && (
                        <th style={{ ...FILTER_TH_STYLE, textAlign: 'right' }}>
                          <HeaderFilter label="Priority Score" type="number" align="right"
                            value={colFilters.priorityScore} onChange={v => setColFilter('priorityScore', v)} />
                        </th>
                      )}
                      {colVis.service && (
                        <th style={FILTER_TH_STYLE}>
                          <HeaderFilter label="Service" type="multi" options={SERVICE_OPTIONS}
                            value={colFilters.service} onChange={v => setColFilter('service', v)} />
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 && (
                      <tr>
                        <td colSpan={COLUMNS.filter(c => colVis[c.id] !== false).length}
                            style={{ textAlign: 'center', padding: '28px 16px', color: 'var(--color-text-secondary)' }}>
                          No assets match the column filters.{' '}
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
                    {pageRows.map(a => {
                      const openDefs = a._count?.deficiencies ?? 0;
                      // Address completeness: site has at least a street address
                      // OR city+state, so the geo-matching engine can work with it.
                      const hasAddress = !!(a.site?.address || (a.site?.city && a.site?.state));
                      return (
                        <tr
                          key={a.id}
                          style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/assets/${a.id}`, { state: fromState })}
                          tabIndex={0}
                          onKeyDown={kbdActivate(() => navigate(`/assets/${a.id}`, { state: fromState }))}
                        >
                          {colVis.equipment   && (
                            <td style={{ fontWeight: 600 }}>
                              {EQUIPMENT_TYPE_LABELS[a.equipmentType] || a.equipmentType}
                            </td>
                          )}
                          {colVis.condition   && <td><ConditionBadge condition={a.governingCondition} /></td>}
                          {colVis.nextDue     && <td><NextDueCell schedule={a.schedules?.[0]} /></td>}
                          {colVis.openDef     && (
                            <td style={{ textAlign: 'right' }}>
                              {openDefs > 0 ? (
                                <span style={{
                                  display: 'inline-block', minWidth: 20, textAlign: 'center',
                                  padding: '2px 7px', borderRadius: 20, fontWeight: 700,
                                  fontSize: 'var(--font-size-xs)',
                                  background: 'var(--color-danger-bg)', color: 'var(--color-danger)',
                                }}>
                                  {openDefs}
                                </span>
                              ) : (
                                <span className="text-muted">0</span>
                              )}
                            </td>
                          )}
                          {colVis.criticality && <td><CriticalityBadge score={a.criticalityScore} /></td>}
                          {colVis.location    && (
                            <td>
                              <div>{a.site?.name || '—'}</div>
                              {a.position?.name && (
                                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                  {a.position.name}
                                </div>
                              )}
                            </td>
                          )}
                          {colVis.mfgModel    && (
                            <td>
                              {(a.manufacturer || a.model)
                                ? [a.manufacturer, a.model].filter(Boolean).join(' ')
                                : <span className="text-muted">—</span>}
                            </td>
                          )}
                          {colVis.serial      && <td className="td-muted">{a.serialNumber || '—'}</td>}
                          {colVis.nameplate   && <td style={{ textAlign: 'center' }}>{a.nameplateData && a.nameplateData._scan
                            ? <span title="Nameplate captured" style={{ color: '#16a34a', fontWeight: 700 }}>✓</span>
                            : <span title="No nameplate captured yet" style={{ color: '#d1d5db' }}>—</span>}</td>}
                          {colVis.address     && (
                            <td title={hasAddress
                              ? `${[a.site?.address, a.site?.city, a.site?.state, a.site?.postalCode].filter(Boolean).join(', ')}`
                              : 'No address on file — add one in Site settings to enable disaster alerts'
                            }>
                              {a.site
                                ? (
                                  <span style={{
                                    fontWeight: 700,
                                    fontSize: 'var(--font-size-xs)',
                                    color: hasAddress ? 'var(--color-success)' : 'var(--color-danger)',
                                  }}>
                                    {hasAddress ? '✓' : '✗'}
                                  </span>
                                )
                                : <span className="text-muted">—</span>
                              }
                            </td>
                          )}
                          {colVis.owner       && <td className="td-muted">{a.owner?.name || '—'}</td>}
                          {colVis.repairCost  && (
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className={a.repairCostEstimate == null ? 'td-muted' : undefined}>
                              {fmtMoney(a.repairCostEstimate)}
                            </td>
                          )}
                          {colVis.priorityScore && (
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                              {a.priorityScore != null ? (
                                <span style={{
                                  fontWeight: 600,
                                  color: a.priorityScore >= 20 ? '#c62828'
                                       : a.priorityScore >= 16 ? '#e65100'
                                       : a.priorityScore >= 10 ? 'var(--color-text)'
                                       : 'var(--color-text-secondary)',
                                }}>
                                  {a.priorityScore}
                                </span>
                              ) : <span className="td-muted">—</span>}
                            </td>
                          )}
                          {colVis.service     && (
                            <td>
                              <span
                                title={a.inService ? 'In service' : 'Out of service'}
                                style={{
                                  fontSize: 'var(--font-size-xs)', fontWeight: 600,
                                  color: a.inService ? 'var(--color-success)' : 'var(--color-text-muted)',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                ● {a.inService ? 'In service' : 'Out'}
                              </span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
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

        <div style={{ textAlign: 'right', marginTop: 8 }}>
          <Link
            to="/assets/archived"
            style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', textDecoration: 'none' }}
          >
            View archived assets
          </Link>
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
