// ─────────────────────────────────────────────────────────────────────────────
// AssetsList.jsx — equipment asset register (ServiceCycle Assets v1).
//
// Single-round-trip mount via GET /api/bootstrap (assets page + pagination +
// site/contractor/member lookups + settings). Intentionally simpler than the
// old ContractsList canonical pattern: no saved views, no column picker — a
// plain server-filtered table with search + two rows of dropdown filters
// (site/type/condition, then owner/service-status/due-window) and an
// active-filter chip row. All filters flow into both the bootstrap fetch and
// the XLSX export URL via buildFilterParams().
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Download, Plus, Upload, Zap } from 'lucide-react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { kbdActivate } from '../lib/a11y';
import EmptyState from '../components/EmptyState';
import Toast from '../components/Toast';
import ColumnPicker from '../components/ColumnPicker';
import {
  EQUIPMENT_TYPE_LABELS,
  CONDITION_META,
  CRITICALITY_SCORE_META,
  fmtDate,
  fmtMoney,
} from '../lib/equipment';

const PAGE_SIZE = 25;

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
      border: `1px solid ${meta.color}`,
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
        background: meta.bg, color: meta.color, border: `1px solid ${meta.color}`,
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
  // /assets?equipmentType=X — read once on mount, then state owns the value.
  const [searchParams] = useSearchParams();

  const [page, setPage]           = useState(1);
  const [search, setSearch]       = useState('');
  const [siteId, setSiteId]       = useState('');
  const [equipmentType, setEquipmentType] = useState(() => searchParams.get('equipmentType') || '');
  const [condition, setCondition] = useState('');
  // Column-filter row (second toolbar row): responsible person, service
  // status, and due window. ownerId accepts a member uuid or the literal
  // 'unassigned'; dueWithin is 'overdue' | '30' | '60' | '90'.
  const [ownerId, setOwnerId]         = useState('');
  const [inServiceF, setInServiceF]   = useState('');
  const [dueWithin, setDueWithin]     = useState('');
  // Risk filters: minimum criticality score ('' | '3' | '4' | '5') and the
  // predictive-maintenance-only toggle chip.
  const [minCriticality, setMinCriticality] = useState('');
  const [predictiveOnly, setPredictiveOnly] = useState(false);
  // Server-side sort: '' (default order) | 'criticality' | 'repairCost',
  // both descending server-side. Toggled by clicking the column headers.
  const [sort, setSort] = useState('');

  // ─── Column visibility (ColumnPicker) ──────────────────────────────────────
  // Columns that can be toggled. 'equipment', 'condition', 'nextDue' are
  // considered essential and are on by default. 'address' is the new column
  // that surfaces whether a site's address is filled in.
  const COLUMNS = [
    { id: 'equipment',    label: 'Equipment' },
    { id: 'mfgModel',     label: 'Manufacturer / Model' },
    { id: 'serial',       label: 'Serial #' },
    { id: 'location',     label: 'Location' },
    { id: 'address',      label: 'Address' },
    { id: 'owner',        label: 'Owner' },
    { id: 'condition',    label: 'Condition' },
    { id: 'criticality',  label: 'Criticality' },
    { id: 'repairCost',   label: 'Repair Cost' },
    { id: 'nextDue',      label: 'Next Due' },
    { id: 'openDef',      label: 'Open Def.' },
    { id: 'service',      label: 'Service' },
  ];
  const DEFAULT_VISIBILITY = {
    equipment: true, mfgModel: true, serial: true, location: true,
    address: true, owner: true, condition: true, criticality: true,
    repairCost: false, nextDue: true, openDef: true, service: true,
  };
  const [colVis, setColVis] = useState(DEFAULT_VISIBILITY);

  // Debounce the search box so we don't hammer /api/bootstrap per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Reset to page 1 whenever a filter (or the sort) changes (skip the
  // initial mount).
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) { mounted.current = true; return; }
    setPage(1);
  }, [debouncedSearch, siteId, equipmentType, condition, ownerId, inServiceF, dueWithin, minCriticality, predictiveOnly, sort]);

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
    return params;
  }

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = buildFilterParams();
    if (sort) params.set('sort', sort);
    params.set('page', String(page));
    params.set('limit', String(PAGE_SIZE));
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
  }, [page, debouncedSearch, siteId, equipmentType, condition, ownerId, inServiceF, dueWithin, minCriticality, predictiveOnly, sort]);

  const hasFilters = !!(debouncedSearch || siteId || equipmentType || condition || ownerId || inServiceF || dueWithin || minCriticality || predictiveOnly);
  const { assets, pagination, sites, equipmentTypes, members } = data;

  function clearAllFilters() {
    setSearch(''); setSiteId(''); setEquipmentType(''); setCondition('');
    setOwnerId(''); setInServiceF(''); setDueWithin('');
    setMinCriticality(''); setPredictiveOnly(false);
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
              : `${pagination.total} asset${pagination.total !== 1 ? 's' : ''}${hasFilters ? ' matching filters' : ' under maintenance management'}`}
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
            title="Download an XLSX of the assets matching the current filters"
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
                      {colVis.mfgModel    && <th>Manufacturer / Model</th>}
                      {colVis.serial      && <th>Serial #</th>}
                      {colVis.location    && <th>Location</th>}
                      {colVis.address     && (
                        <th title="Whether this asset's site has a street address on record">Address</th>
                      )}
                      {colVis.owner       && <th>Owner</th>}
                      {colVis.condition   && <th>Condition</th>}
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
                      {colVis.nextDue     && <th>Next Due</th>}
                      {colVis.openDef     && <th style={{ textAlign: 'right' }}>Open Def.</th>}
                      {colVis.service     && <th>Service</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map(a => {
                      const openDefs = a._count?.deficiencies ?? 0;
                      // Address completeness: site has at least a street address
                      // OR city+state, so the geo-matching engine can work with it.
                      const hasAddress = !!(a.site?.address || (a.site?.city && a.site?.state));
                      return (
                        <tr
                          key={a.id}
                          style={{ cursor: 'pointer' }}
                          onClick={() => navigate(`/assets/${a.id}`)}
                          tabIndex={0}
                          onKeyDown={kbdActivate(() => navigate(`/assets/${a.id}`))}
                        >
                          {colVis.equipment   && (
                            <td style={{ fontWeight: 600 }}>
                              {EQUIPMENT_TYPE_LABELS[a.equipmentType] || a.equipmentType}
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
                          {colVis.condition   && <td><ConditionBadge condition={a.governingCondition} /></td>}
                          {colVis.criticality && <td><CriticalityBadge score={a.criticalityScore} /></td>}
                          {colVis.repairCost  && (
                            <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }} className={a.repairCostEstimate == null ? 'td-muted' : undefined}>
                              {fmtMoney(a.repairCostEstimate)}
                            </td>
                          )}
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

              {pagination.pages > 1 && (
                <div className="pagination">
                  <div className="pagination-info">
                    Page {pagination.page} of {pagination.pages} · {pagination.total} assets
                  </div>
                  <div className="pagination-controls">
                    <button
                      type="button"
                      className="page-btn"
                      disabled={page <= 1}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                      ‹ Prev
                    </button>
                    <button
                      type="button"
                      className="page-btn"
                      disabled={page >= pagination.pages}
                      onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
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
