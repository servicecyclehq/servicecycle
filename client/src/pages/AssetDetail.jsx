// ─────────────────────────────────────────────────────────────────────────────
// AssetDetail.jsx — single-asset compliance hub (ServiceCycle Assets v1).
//
// GET /api/assets/:id → asset with hierarchy context, maintenance schedules
// (incl. task definitions + their governing standard {code, edition}; null →
// account-defined custom task), latest work orders, open deficiencies, recent
// lab samples, documents, and customFieldValues (with definitions). Sections
// below mirror that payload; the schedules card groups rows per standard with
// a compliance badge and a link into /reports/compliance/:standardCode; the
// activity feed comes from
// GET /api/assets/:id/activity, and the editable custom-field definitions
// from GET /api/custom-fields (active only).
//
// Write actions (manager+, mirrored by the server's requireManager gates):
//   • inline edit            → PUT  /api/assets/:id
//   • archive / unarchive    → POST /api/assets/:id/(un)archive
//   • apply schedule template→ POST /api/schedules/bulk-apply {assetId}
//   • mark schedule complete → POST /api/schedules/:id/complete {}
//   • spawn work order       → POST /api/work-orders {assetId, scheduleId}
//   • resolve deficiency     → POST /api/deficiencies/:id/resolve
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import TestingTrendsTab from '../components/TestingTrendsTab';
import BackLink, { useFromState } from '../components/BackLink';
import Toast from '../components/Toast';
import InfoTip from '../components/InfoTip';
import CustomFieldInputs from '../components/CustomFieldInputs';
import MaintenanceBriefCard from '../components/MaintenanceBriefCard';
import AssetEvidenceTraceCard from '../components/AssetEvidenceTraceCard';
import PhotoInspectCard from '../components/PhotoInspectCard';
import PowerPathCard from '../components/PowerPathCard';
import OutageConsolidationCard from '../components/OutageConsolidationCard';
import ConditionIntervalCard from '../components/ConditionIntervalCard';
import QuoteRequestButton from '../components/QuoteRequestButton';
import AssetLotoCard from '../components/AssetLotoCard';
import AssetDocumentsCard from '../components/AssetDocumentsCard';
import NameplateCard from '../components/NameplateCard';
import IncidentLogCard from '../components/IncidentLogCard';
import ArcFlashTrend from '../components/ArcFlashTrend';
import DgaImportCard from '../components/DgaImportCard';
import ThermographyImportCard from '../components/ThermographyImportCard';

// IR thermography applies to energized distribution equipment (a 70B annual task).
const IR_TYPES = new Set([
  'SWITCHGEAR', 'SWITCHBOARD', 'PANELBOARD', 'MCC', 'BUSWAY', 'CIRCUIT_BREAKER',
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'DISCONNECT_SWITCH', 'FUSE_GEAR',
  'TRANSFER_SWITCH', 'GENERATOR', 'MOTOR', 'UPS_BATTERY', 'VFD',
]);
import {
  EQUIPMENT_TYPE_LABELS,
  CONDITION_META,
  WO_STATUS_META,
  SEVERITY_META,
  DECAL_META,
  IEEE_STATUS_META,
  REDUNDANCY_META,
  CRITICALITY_SCORE_META,
  assetLabel,
  fmtDate,
  fmtMoney,
} from '../lib/equipment';

const CONDITION_TIP =
  'NFPA 70B:2023 condition of maintenance: three axes (physical / criticality / ' +
  'environment), each C1 good, C2 fair, or C3 poor. The worst axis governs and ' +
  'selects the maintenance interval for every task on this asset.';

// Generic pill chip driven by a {label,color,bg} meta record.
function MetaChip({ meta, fallback }) {
  if (!meta) return <span className="text-muted">{fallback || '—'}</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1.5,
      background: meta.bg, color: meta.color,
      border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
      whiteSpace: 'nowrap',
    }}>
      {meta.label}
    </span>
  );
}

function ServiceChip({ on, onLabel, offLabel }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 10px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, letterSpacing: '0.02em', lineHeight: 1.5, whiteSpace: 'nowrap',
      background: on ? 'var(--chip-green-bg, var(--color-success-bg))' : 'var(--color-bg)',
      color: on ? 'var(--chip-green-fg, var(--color-success))' : 'var(--color-text-muted)',
      border: `1px solid ${on ? 'color-mix(in srgb, var(--chip-green-fg, var(--color-success)) 40%, transparent)' : 'var(--color-border)'}`,
    }}>
      {on ? onLabel : offLabel}
    </span>
  );
}

// Effective interval (months) for a schedule given the asset's governing
// condition, honoring the per-schedule conditionOverride.
function effectiveIntervalMonths(schedule, asset) {
  const cond = schedule.conditionOverride || asset.governingCondition || 'C2';
  const td = schedule.taskDefinition || {};
  const months = td[`interval${cond}Months`];
  return { cond, months: months ?? null };
}

// ── Per-standard schedule grouping ────────────────────────────────────────────
// Schedules group by taskDefinition.standard ({code, edition}); a null
// standard means an account-defined custom task. Group collapse state is
// persisted per browser profile under the servicecycle_ localStorage prefix.
const ACCOUNT_DEFINED = 'Account-defined';
const STDGROUPS_KEY = 'servicecycle_asset_stdgroups';

// Client-side schedule status, mirroring the server's compliance vocabulary
// (current | overdue | unbaselined | inactive).
function scheduleStatus(s) {
  if (!s.isActive) return 'inactive';
  if (!s.nextDueDate) return 'unbaselined';
  return new Date(s.nextDueDate) < new Date() ? 'overdue' : 'current';
}

// Group badge: 'N of M current'. Red when anything is overdue, amber when
// anything is unbaselined, green when every schedule is current.
function GroupComplianceBadge({ items }) {
  const statuses = items.map(scheduleStatus);
  const current = statuses.filter(st => st === 'current').length;
  const palette = statuses.includes('overdue')
    ? { color: 'var(--chip-red-fg, #dc2626)', bg: 'var(--chip-red-bg, #fef2f2)' }
    : statuses.includes('unbaselined')
      ? { color: 'var(--chip-amber-fg, #d97706)', bg: 'var(--chip-amber-bg, #fffbeb)' }
      : { color: 'var(--chip-green-fg, #16a34a)', bg: 'var(--chip-green-bg, #f0fdf4)' };
  return <MetaChip meta={{ ...palette, label: `${current} of ${items.length} current` }} />;
}

// Human line for one activity-log row.
function activityText(log) {
  const d = log.details || {};
  switch (log.action) {
    case 'asset_created':         return `Asset created (${EQUIPMENT_TYPE_LABELS[d.equipmentType] || d.equipmentType || 'equipment'}${d.siteName ? ` at ${d.siteName}` : ''})`;
    case 'fields_updated':        return `Updated: ${Array.isArray(d.fields) ? d.fields.join(', ') : 'fields'}`;
    case 'condition_changed':     return `Governing condition changed ${d.from || '?'} → ${d.to || '?'}`;
    case 'asset_archived':        return 'Asset archived';
    case 'asset_unarchived':      return 'Asset unarchived';
    case 'maintenance_completed': return `Maintenance completed: ${d.taskName || d.taskCode || 'task'}${d.nextDueDate ? ` (next due ${fmtDate(d.nextDueDate)})` : ''}`;
    case 'work_order_created':    return 'Work order created';
    default:                      return log.action?.replace(/_/g, ' ') || 'activity';
  }
}

// Display form of one stored custom-field value, per its definition's type.
// Values are the server's canonical strings (checkbox 'true'/'false', date
// 'YYYY-MM-DD', select option value) — this maps them back to human terms.
function formatCustomValue(def, value) {
  if (value == null || value === '') return null;
  switch (def.type) {
    case 'checkbox': return value === 'true' ? 'Yes' : 'No';
    case 'date':     return fmtDate(value);
    case 'select': {
      const opt = (def.options || []).find(o => o.value === value);
      return opt?.label || value;
    }
    default: return value;
  }
}

// ── Mark-complete modal ───────────────────────────────────────────────────────
// Small prompt before POST /api/schedules/:id/complete — captures the optional
// performedByName ('name / employer') auditors expect on maintenance records.
function CompleteScheduleModal({ schedule, onClose, onConfirm, busy }) {
  const [performedByName, setPerformedByName] = useState('');
  // V3: capture the REAL date the work was performed (defaults to today, but
  // editable so a historical service can be recorded honestly). This is the
  // manual update path on the asset card; report ingest is the other path.
  const [completedDate, setCompletedDate] = useState(new Date().toISOString().slice(0, 10));
  return (
    <div
      role="dialog" aria-modal="true" aria-label="Mark task complete"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <form
        onSubmit={e => { e.preventDefault(); onConfirm(performedByName.trim() || null, completedDate); }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 440, width: '100%', padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 6 }}>
          Mark task complete?
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>
          Records "{schedule.taskDefinition?.taskName || 'this task'}" as completed on the date below
          and rolls the next due date forward by the condition-appropriate interval.
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>
            Date performed
          </label>
          <input type="date" className="form-control" max={new Date().toISOString().slice(0, 10)}
            value={completedDate} onChange={e => setCompletedDate(e.target.value)} style={{ width: 180 }} />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>
            Performed by (name / employer) <span className="text-muted" style={{ fontWeight: 400 }}>— optional</span>
          </label>
          <input
            className="form-control form-control-wide"
            placeholder="e.g. J. Rivera / Apex Electrical Testing"
            value={performedByName}
            onChange={e => setPerformedByName(e.target.value)}
            autoFocus
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Recording…' : 'Mark complete'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Inline edit form ──────────────────────────────────────────────────────────
function EditAssetForm({ asset, fieldDefs, members, onCancel, onSaved }) {
  const [form, setForm] = useState({
    equipmentType:        asset.equipmentType,
    ownerId:              asset.owner?.id || asset.ownerId || '',
    manufacturer:         asset.manufacturer || '',
    model:                asset.model || '',
    serialNumber:         asset.serialNumber || '',
    installDate:          asset.installDate ? asset.installDate.slice(0, 10) : '',
    lastCommissionedDate: asset.lastCommissionedDate ? asset.lastCommissionedDate.slice(0, 10) : '',
    conditionPhysical:    asset.conditionPhysical || 'C2',
    conditionCriticality: asset.conditionCriticality || 'C2',
    conditionEnvironment: asset.conditionEnvironment || 'C2',
    inService:            !!asset.inService,
    isEnergized:          !!asset.isEnergized,
    notes:                asset.notes || '',
    // Risk & criticality — selects/inputs hold strings; '' means unset (null).
    criticalityScore:     asset.criticalityScore != null ? String(asset.criticalityScore) : '',
    repairCostEstimate:   asset.repairCostEstimate != null ? String(asset.repairCostEstimate) : '',
    spareLeadTimeWeeks:   asset.spareLeadTimeWeeks != null ? String(asset.spareLeadTimeWeeks) : '',
    redundancyStatus:     asset.redundancyStatus || '',
    requiresPredictiveMaintenance: !!asset.requiresPredictiveMaintenance,
  });
  const [nameplate, setNameplate] = useState(() => {
    const entries = Object.entries(asset.nameplateData || {}).filter(([k]) => !k.startsWith('_'));
    return entries.length > 0
      ? entries.map(([key, value]) => ({ key, value: String(value ?? '') }))
      : [{ key: '', value: '' }];
  });
  // Custom field values keyed by definitionId, seeded from the asset's
  // stored customFieldValues. Only ACTIVE definitions are editable —
  // archived ones stay read-only in the detail card and are never
  // submitted (the server rejects writes against archived definitions).
  const [customFields, setCustomFields] = useState(() => {
    const stored = new Map((asset.customFieldValues || []).map(v => [v.definitionId, v.value]));
    const map = {};
    for (const def of fieldDefs) map[def.id] = stored.get(def.id) ?? '';
    return map;
  });
  // If the definitions fetch resolves AFTER the form mounts, hydrate the
  // late arrivals from the asset's stored values — but never clobber a key
  // the user has already touched.
  useEffect(() => {
    const stored = new Map((asset.customFieldValues || []).map(v => [v.definitionId, v.value]));
    setCustomFields(prev => {
      const map = { ...prev };
      for (const def of fieldDefs) {
        if (!(def.id in map)) map[def.id] = stored.get(def.id) ?? '';
      }
      return map;
    });
  }, [fieldDefs, asset.customFieldValues]);
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  async function handleSubmit(e) {
    e.preventDefault();
    const nameplateData = {};
    for (const { key, value } of nameplate) {
      const k = key.trim();
      if (k && !k.startsWith('_')) nameplateData[k] = value;
    }
    // Preserve the nameplate scan metadata (photo ref + confidence) — the
    // key/value editor intentionally hides it, so re-merge it so a plain
    // details edit never wipes the saved nameplate photo.
    if (asset.nameplateData && asset.nameplateData._scan) nameplateData._scan = asset.nameplateData._scan;
    setSaving(true); setError('');
    try {
      const res = await api.put(`/api/assets/${asset.id}`, {
        equipmentType:        form.equipmentType,
        ownerId:              form.ownerId || null,
        manufacturer:         form.manufacturer.trim() || null,
        model:                form.model.trim() || null,
        serialNumber:         form.serialNumber.trim() || null,
        installDate:          form.installDate || null,
        lastCommissionedDate: form.lastCommissionedDate || null,
        conditionPhysical:    form.conditionPhysical,
        conditionCriticality: form.conditionCriticality,
        conditionEnvironment: form.conditionEnvironment,
        inService:            form.inService,
        isEnergized:          form.isEnergized,
        notes:                form.notes.trim() || null,
        criticalityScore:     form.criticalityScore ? Number(form.criticalityScore) : null,
        repairCostEstimate:   form.repairCostEstimate.trim() || null,
        spareLeadTimeWeeks:   form.spareLeadTimeWeeks !== '' ? Number(form.spareLeadTimeWeeks) : null,
        redundancyStatus:     form.redundancyStatus || null,
        requiresPredictiveMaintenance: form.requiresPredictiveMaintenance,
        nameplateData:        Object.keys(nameplateData).length > 0 ? nameplateData : null,
        // Whole map every save — empty strings clear, server upserts the rest.
        ...(fieldDefs.length > 0 ? { customFields } : {}),
      });
      onSaved(res.data.data.asset);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save changes.');
      setSaving(false);
    }
  }

  const conditionSelect = (field, label) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <select aria-label={label} className="form-control" value={form[field]} onChange={e => setF(field, e.target.value)}>
        {Object.entries(CONDITION_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
      </select>
    </div>
  );

  return (
    <div className="card mb-16">
      <div className="card-header"><div className="card-title">Edit Asset</div></div>
      <div className="card-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Equipment Type</label>
              <select aria-label="Equipment type" className="form-control" value={form.equipmentType} onChange={e => setF('equipmentType', e.target.value)}>
                {Object.entries(EQUIPMENT_TYPE_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Manufacturer</label>
              <input className="form-control" value={form.manufacturer} onChange={e => setF('manufacturer', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Model</label>
              <input className="form-control" value={form.model} onChange={e => setF('model', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Serial Number</label>
              <input className="form-control" value={form.serialNumber} onChange={e => setF('serialNumber', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Install Date</label>
              <input type="date" className="form-control" aria-label="Install date" value={form.installDate} onChange={e => setF('installDate', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Last Commissioned</label>
              <input type="date" className="form-control" aria-label="Last commissioned date" value={form.lastCommissionedDate} onChange={e => setF('lastCommissionedDate', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Owner</label>
              <select
                aria-label="Asset owner"
                className="form-control"
                value={form.ownerId}
                onChange={e => setF('ownerId', e.target.value)}
              >
                <option value="">— Unassigned —</option>
                {(members || []).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
              <div className="form-hint">Owner receives every maintenance alert for this asset.</div>
            </div>
          </div>

          <div className="form-row">
            {conditionSelect('conditionPhysical', 'Physical Condition')}
            {conditionSelect('conditionCriticality', 'Criticality')}
            {conditionSelect('conditionEnvironment', 'Environment')}
          </div>

          <div className="checkbox-group">
            <input id="edit-asset-in-service" type="checkbox" checked={form.inService} onChange={e => setF('inService', e.target.checked)} />
            <label htmlFor="edit-asset-in-service" className="checkbox-label">In service</label>
          </div>
          <div className="checkbox-group">
            <input id="edit-asset-energized" type="checkbox" checked={form.isEnergized} onChange={e => setF('isEnergized', e.target.checked)} />
            <label htmlFor="edit-asset-energized" className="checkbox-label">Energized</label>
          </div>

          {/* ── Risk & Criticality ────────────────────────────────────────── */}
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label">Risk &amp; Criticality</label>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Criticality Score</label>
                <select aria-label="Criticality score" className="form-control" value={form.criticalityScore} onChange={e => setF('criticalityScore', e.target.value)}>
                  <option value="">— Not scored —</option>
                  {[5, 4, 3, 2, 1].map(n => (
                    <option key={n} value={n}>{n} — {CRITICALITY_SCORE_META[n].label}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Repair Cost Estimate ($)</label>
                <input
                  type="number" min="0" step="0.01" className="form-control"
                  aria-label="Repair cost estimate in dollars" placeholder="e.g. 25000"
                  value={form.repairCostEstimate}
                  onChange={e => setF('repairCostEstimate', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Spare Lead Time (weeks)</label>
                <input
                  type="number" min="0" step="1" className="form-control"
                  aria-label="Spare lead time in weeks" placeholder="e.g. 12"
                  value={form.spareLeadTimeWeeks}
                  onChange={e => setF('spareLeadTimeWeeks', e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Redundancy</label>
                <select aria-label="Redundancy status" className="form-control" value={form.redundancyStatus} onChange={e => setF('redundancyStatus', e.target.value)}>
                  <option value="">— Unknown —</option>
                  {Object.entries(REDUNDANCY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
                </select>
              </div>
            </div>
            <div className="checkbox-group">
              <input
                id="edit-asset-predictive" type="checkbox"
                checked={form.requiresPredictiveMaintenance}
                onChange={e => setF('requiresPredictiveMaintenance', e.target.checked)}
              />
              <label htmlFor="edit-asset-predictive" className="checkbox-label">
                Requires predictive maintenance (IR scans, oil analysis, partial discharge…)
              </label>
            </div>
          </div>

          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label">Nameplate Data</label>
            {nameplate.map((pair, idx) => (
              <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                <input
                  className="form-control" style={{ maxWidth: 200 }} placeholder="Key"
                  aria-label={`Nameplate key ${idx + 1}`}
                  value={pair.key}
                  onChange={e => setNameplate(prev => prev.map((p, i) => i === idx ? { ...p, key: e.target.value } : p))}
                />
                <input
                  className="form-control" style={{ maxWidth: 280 }} placeholder="Value"
                  aria-label={`Nameplate value ${idx + 1}`}
                  value={pair.value}
                  onChange={e => setNameplate(prev => prev.map((p, i) => i === idx ? { ...p, value: e.target.value } : p))}
                />
                <button
                  type="button" className="btn btn-secondary btn-sm"
                  aria-label={`Remove nameplate pair ${idx + 1}`}
                  onClick={() => setNameplate(prev => prev.length === 1 ? [{ key: '', value: '' }] : prev.filter((_, i) => i !== idx))}
                >
                  ✕
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => setNameplate(prev => [...prev, { key: '', value: '' }])}>
              + Add field
            </button>
          </div>

          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label">Notes</label>
            <textarea className="form-control form-control-wide" aria-label="Notes" rows={3} value={form.notes} onChange={e => setF('notes', e.target.value)} />
          </div>

          {fieldDefs.length > 0 && (
            <div className="form-group" style={{ marginTop: 12 }}>
              <label className="form-label">Custom Fields</label>
              <CustomFieldInputs
                definitions={fieldDefs}
                values={customFields}
                onChange={(id, v) => setCustomFields(p => ({ ...p, [id]: v }))}
                disabled={saving}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function AssetDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // C1: links out of this page record it as the origin, so their BackLink
  // returns here (asset → work order → back to this asset).
  const fromState = useFromState();
  const confirm = useConfirm();
  const { user, features, accountFeatures } = useAuth();
  // See AssetsList: assets_write with contracts_write fallback until the
  // AuthContext flag catalog is retargeted.
  const canWrite = features.assets_write ?? features.contracts_write;
  // Compliance report pages are admin/manager-gated (same as /reports) — only
  // show the per-group 'Report →' links to roles that can actually open them.
  const canViewReports = ['admin', 'manager'].includes(user?.role);

  const [asset, setAsset]     = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [toast, setToast]     = useState(null);
  const [editing, setEditing] = useState(false);
  const [activeTab, setActiveTab] = useState('overview'); // 'overview' | 'testing'
  const [busy, setBusy]       = useState(false); // serializes row-level actions
  const [activity, setActivity] = useState([]);
  // Active custom field definitions (admin-defined in Settings). Drives the
  // editable inputs in the edit form; archived definitions never appear here
  // but their stored values still render read-only from the asset payload.
  const [fieldDefs, setFieldDefs] = useState([]);
  // Account members ({id, name}) for the owner picker — from bootstrap.
  const [members, setMembers] = useState([]);
  // Schedule pending the mark-complete prompt (null when closed).
  const [completingSchedule, setCompletingSchedule] = useState(null);
  // Collapsed per-standard schedule groups, keyed by standard code (or
  // 'Account-defined'). Default expanded; collapse choices persist across
  // sessions via localStorage. Map values are `true` when collapsed.
  const [collapsedGroups, setCollapsedGroups] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STDGROUPS_KEY) || '{}') || {}; } catch { return {}; }
  });
  const toggleGroup = (code) => {
    setCollapsedGroups(prev => {
      const next = { ...prev };
      if (next[code]) delete next[code]; else next[code] = true;
      try { localStorage.setItem(STDGROUPS_KEY, JSON.stringify(next)); } catch { /* persistence is best-effort */ }
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    api.get('/api/custom-fields')
      .then(r => {
        if (cancelled) return;
        setFieldDefs((r.data.data?.fields || []).filter(d => !d.archivedAt));
      })
      .catch(() => { /* section simply doesn't render */ });
    // Members for the owner picker — bootstrap carries data.members {id,name}.
    api.get('/api/bootstrap?limit=1')
      .then(r => {
        if (cancelled) return;
        setMembers(r.data.data?.members || []);
      })
      .catch(() => { /* picker simply renders empty */ });
    return () => { cancelled = true; };
  }, []);

  useDocumentTitle(asset ? assetLabel(asset) : 'Asset');

  const fetchAsset = useCallback(() => {
    return api.get(`/api/assets/${id}`)
      .then(r => { setAsset(r.data.data.asset); setError(''); })
      .catch(err => {
        setError(err.response?.status === 404 ? 'Asset not found.' : 'Failed to load asset.');
      });
  }, [id]);

  const fetchActivity = useCallback(() => {
    return api.get(`/api/assets/${id}/activity`)
      .then(r => setActivity(r.data.data.logs || []))
      .catch(() => { /* feed is non-critical */ });
  }, [id]);

  useEffect(() => {
    setLoading(true);
    Promise.all([fetchAsset(), fetchActivity()]).finally(() => setLoading(false));
  }, [fetchAsset, fetchActivity]);

  const refetchAll = () => { fetchAsset(); fetchActivity(); };

  // ── Actions ────────────────────────────────────────────────────────────────
  async function handleArchiveToggle() {
    const archiving = !asset.archivedAt;
    if (!await confirm({
      title: archiving ? 'Archive this asset?' : 'Unarchive this asset?',
      message: archiving
        ? 'The asset disappears from the main register but its history (work orders, lab samples, deficiencies) stays intact. You can unarchive it any time from the Archived Assets page.'
        : 'The asset returns to the main register and resumes appearing in compliance views.',
      confirmLabel: archiving ? 'Archive' : 'Unarchive',
      danger: archiving,
    })) return;
    try {
      await api.post(`/api/assets/${id}/${archiving ? 'archive' : 'unarchive'}`);
      setToast({ message: archiving ? 'Asset archived.' : 'Asset unarchived.', variant: 'success', duration: 4000 });
      refetchAll();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Action failed.', variant: 'error' });
    }
  }

  async function handleApplyTemplate() {
    if (!await confirm({
      title: 'Apply the industry-standard maintenance program?',
      message: 'Adds this equipment type\'s industry-standard maintenance program (NFPA 70B) — inspection, cleaning, lubrication, insulation-resistance ("megger"), and infrared scanning. Manufacturer instructions take precedence, so adjust each interval to the OEM and your program. Customers who require more extensive testing can enable the extended (NETA) battery. Existing schedules are kept — the operation is idempotent.',
      confirmLabel: 'Apply program',
    })) return;
    // Snapshot the current schedule ids so the success toast can name exactly
    // which tasks the template added (the bulk-apply response only carries a
    // count — we diff against a refetch instead of changing the API).
    const prevIds = new Set((asset?.schedules || []).map(s => s.id));
    try {
      const res = await api.post('/api/schedules/bulk-apply', { assetId: id });
      const created = res.data.data?.created ?? 0;
      let message;
      if (created > 0) {
        let names = [];
        try {
          const r2 = await api.get(`/api/assets/${id}`);
          names = (r2.data.data?.asset?.schedules || [])
            .filter(s => !prevIds.has(s.id))
            .map(s => s.taskDefinition?.taskName)
            .filter(Boolean);
        } catch { /* fall back to the count-only message */ }
        message = names.length > 0
          ? `Added ${created} maintenance schedule${created !== 1 ? 's' : ''}: ${names.join(', ')}`
          : `Added ${created} maintenance schedule${created !== 1 ? 's' : ''} from the NFPA 70B / NETA template.`;
      } else {
        message = 'No new schedules to add — this asset already has every template task for its equipment type.';
      }
      setToast({ message, variant: 'success', duration: 8000 });
      refetchAll();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to apply template.', variant: 'error' });
    }
  }

  // Confirmation + performedByName + real completion date from CompleteScheduleModal.
  async function handleCompleteSchedule(schedule, performedByName, completedDate) {
    if (busy) return;
    setBusy(true);
    try {
      const body = {};
      if (performedByName) body.performedByName = performedByName;
      if (completedDate) body.completedDate = completedDate;
      await api.post(`/api/schedules/${schedule.id}/complete`, body);
      setCompletingSchedule(null);
      setToast({ message: 'Maintenance completion recorded.', variant: 'success', duration: 4000 });
      refetchAll();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to record completion.', variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function handleNewWorkOrder(schedule) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.post('/api/work-orders', { assetId: id, scheduleId: schedule?.id || null });
      navigate(`/work-orders/${res.data.data.workOrder.id}`, { state: fromState });
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to create work order.', variant: 'error' });
      setBusy(false);
    }
  }

  async function handleResolveDeficiency(def) {
    if (busy) return;
    if (!await confirm({
      title: 'Resolve deficiency?',
      message: `Marks "${(def.description || '').slice(0, 120)}" as resolved.`,
      confirmLabel: 'Resolve',
    })) return;
    setBusy(true);
    try {
      await api.post(`/api/deficiencies/${def.id}/resolve`);
      setToast({ message: 'Deficiency resolved.', variant: 'success', duration: 4000 });
      refetchAll();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to resolve deficiency.', variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return <div className="page-body"><div className="loading">Loading asset…</div></div>;
  }
  if (error && !asset) {
    return (
      <div className="page-body">
        <div role="alert" className="alert alert-error mb-16">{error}</div>
        <BackLink fallback="/assets" fallbackLabel="Assets" className="btn btn-secondary" />
      </div>
    );
  }
  if (!asset) return null;

  const breadcrumb = [asset.site?.name, asset.building?.name, asset.area?.name,
    asset.position ? (asset.position.code ? `${asset.position.code} — ${asset.position.name}` : asset.position.name) : null,
  ].filter(Boolean).join(' › ');

  // Filter the reserved `_scan` key (confidence + photo ref from the nameplate
  // scan flow) — it renders in the dedicated NameplateCard, not the raw list.
  const nameplateEntries = Object.entries(asset.nameplateData || {}).filter(([k]) => !k.startsWith('_'));
  const schedules    = asset.schedules || [];
  // Group schedules by governing standard. Standards sort alphabetically;
  // account-defined custom tasks always sink to the bottom.
  const scheduleGroups = (() => {
    const map = new Map();
    for (const s of schedules) {
      const std = s.taskDefinition?.standard || null;
      const code = std?.code || ACCOUNT_DEFINED;
      if (!map.has(code)) map.set(code, { code, edition: std?.edition || null, items: [] });
      map.get(code).items.push(s);
    }
    return [...map.values()].sort((a, b) => {
      if (a.code === ACCOUNT_DEFINED) return 1;
      if (b.code === ACCOUNT_DEFINED) return -1;
      return a.code.localeCompare(b.code);
    });
  })();
  const workOrders   = asset.workOrders || [];
  const deficiencies = asset.deficiencies || [];
  const labSamples   = asset.labSamples || [];
  const documents    = asset.documents || [];

  // Custom fields: one row per ACTIVE definition (value or em-dash), plus
  // stored values whose definition has since been archived — those stay
  // visible (read-only) so retiring a field never erases what's recorded.
  const customValueByDef = new Map((asset.customFieldValues || []).map(v => [v.definitionId, v.value]));
  const archivedCustomValues = (asset.customFieldValues || [])
    .filter(v => v.definition?.archivedAt && v.value != null && v.value !== '');

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/assets" fallbackLabel="Assets" />
          <h1 className="page-title">
            {assetLabel(asset)}
            {asset.archivedAt && (
              <span className="badge badge-cancelled" style={{ marginLeft: 10, verticalAlign: 'middle' }}>Archived</span>
            )}
          </h1>
          <div className="page-subtitle">
            {EQUIPMENT_TYPE_LABELS[asset.equipmentType] || asset.equipmentType}
            {breadcrumb && <> · {breadcrumb}</>}
            {' · '}
            <span title={asset.owner?.email || undefined}>
              Owner: {asset.owner?.name || 'Unassigned'}
            </span>
          </div>
          <div className="contract-header-meta" style={{ marginTop: 8 }}>
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              Condition <InfoTip content={CONDITION_TIP} />
            </span>
            <span title="Physical condition"><MetaChip meta={CONDITION_META[asset.conditionPhysical] && { ...CONDITION_META[asset.conditionPhysical], label: `Phys ${asset.conditionPhysical}` }} /></span>
            <span title="Criticality"><MetaChip meta={CONDITION_META[asset.conditionCriticality] && { ...CONDITION_META[asset.conditionCriticality], label: `Crit ${asset.conditionCriticality}` }} /></span>
            <span title="Operating environment"><MetaChip meta={CONDITION_META[asset.conditionEnvironment] && { ...CONDITION_META[asset.conditionEnvironment], label: `Env ${asset.conditionEnvironment}` }} /></span>
            <span title="Governing condition (worst of the three axes)">
              <MetaChip meta={CONDITION_META[asset.governingCondition] && { ...CONDITION_META[asset.governingCondition], label: `Governing: ${CONDITION_META[asset.governingCondition].label}` }} />
            </span>
            <ServiceChip on={!!asset.inService} onLabel="In service" offLabel="Out of service" />
            <ServiceChip on={!!asset.isEnergized} onLabel="Energized" offLabel="De-energized" />
          </div>
        </div>
        {canWrite && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'flex-start' }}>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(v => !v)}>
              {editing ? 'Close editor' : 'Edit'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleApplyTemplate}
              title="Adds the standard NFPA 70B / NETA maintenance schedule for this equipment type."
            >
              Apply schedule template
            </button>
            <button
              type="button"
              className={asset.archivedAt ? 'btn btn-secondary' : 'btn btn-danger'}
              onClick={handleArchiveToggle}
            >
              {asset.archivedAt ? 'Unarchive' : 'Archive'}
            </button>
          </div>
        )}
      </div>

      <div className="detail-tabs">
        {[['overview', 'Overview'], ['testing', 'Testing & Trends']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className="detail-tab"
            data-active={activeTab === key ? 'true' : 'false'}
            onClick={() => setActiveTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {activeTab === 'testing' && <TestingTrendsTab asset={asset} canWrite={canWrite} />}
        {activeTab === 'overview' && (<>

        {editing && (
          <EditAssetForm
            asset={asset}
            fieldDefs={fieldDefs}
            members={members}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              setToast({ message: 'Asset updated.', variant: 'success', duration: 4000 });
              refetchAll();
            }}
          />
        )}

        {/* ── Incidents / protective-device operations (#24) ───────────────── */}
        <IncidentLogCard assetId={asset.id} />

        {/* ── Arc-flash incident-energy trend (#25 headline) ───────────────── */}
        <ArcFlashTrend assetId={asset.id} />

        {/* ── Oil / DGA import (#28) — oil-filled transformers ─────────────── */}
        {/* Gated behind the per-account dga_import flag (lib/accountFeatures) —
            code intact, simply not rendered when the account has it off. */}
        {accountFeatures.dga_import && asset.equipmentType === 'TRANSFORMER_LIQUID' && (
          <DgaImportCard assetId={asset.id} canWrite={canWrite} onChanged={refetchAll} />
        )}

        {/* ── IR thermography import (#29) — energized distribution gear ────── */}
        {/* Gated behind the per-account thermography_import flag. */}
        {accountFeatures.thermography_import && IR_TYPES.has(asset.equipmentType) && (
          <ThermographyImportCard assetId={asset.id} canWrite={canWrite} onChanged={refetchAll} />
        )}

        {/* ── Open Deficiencies ─────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title" style={deficiencies.length > 0 ? { color: 'var(--color-danger)' } : undefined}>
              Open Deficiencies ({deficiencies.length})
            </div>
          </div>
          {deficiencies.length === 0 ? (
            <div className="card-body">
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No open deficiencies — nothing outstanding on this asset.
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Description</th>
                    <th>Logged</th>
                    {canWrite && <th style={{ textAlign: 'right' }}></th>}
                  </tr>
                </thead>
                <tbody>
                  {deficiencies.map(def => (
                    <tr key={def.id}>
                      <td><MetaChip meta={SEVERITY_META[def.severity]} fallback={def.severity} /></td>
                      <td>
                        <div>{def.description}</div>
                        {def.correctiveAction && (
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                            Corrective action: {def.correctiveAction}
                          </div>
                        )}
                      </td>
                      <td className="td-muted">{fmtDate(def.createdAt)}</td>
                      {canWrite && (
                        <td style={{ textAlign: 'right' }}>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={() => handleResolveDeficiency(def)}
                            disabled={busy}
                          >
                            Resolve
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

        {/* ── Risk & Criticality ────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header"><div className="card-title">Risk &amp; Criticality</div></div>
          <div className="card-body">
            <div className="detail-grid">
              <div className="detail-item">
                <div className="detail-label">Criticality Score</div>
                <div className="detail-value">
                  <MetaChip
                    meta={CRITICALITY_SCORE_META[asset.criticalityScore] && {
                      ...CRITICALITY_SCORE_META[asset.criticalityScore],
                      label: `${asset.criticalityScore} — ${CRITICALITY_SCORE_META[asset.criticalityScore].label}`,
                    }}
                    fallback="Not scored"
                  />
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Repair Cost Estimate</div>
                <div className="detail-value">{fmtMoney(asset.repairCostEstimate)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Spare Lead Time</div>
                <div className="detail-value">
                  {asset.spareLeadTimeWeeks != null
                    ? `${asset.spareLeadTimeWeeks} week${asset.spareLeadTimeWeeks !== 1 ? 's' : ''}`
                    : <span className="text-muted">—</span>}
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Redundancy</div>
                <div className="detail-value">
                  <MetaChip meta={REDUNDANCY_META[asset.redundancyStatus]} fallback="Unknown" />
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Predictive Maintenance</div>
                <div className="detail-value">
                  <ServiceChip
                    on={!!asset.requiresPredictiveMaintenance}
                    onLabel="Predictive program"
                    offLabel="Not required"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Service Quote Request ─────────────────────────────────────────── */}
        {/* "The dossier is the feature, not the button." Pre-fills full asset
            context so the rep gets everything they need without asking.
            EMERGENCY mode when driver=down_now: rep phone displayed large
            with CALL NOW copy. PENDING BROTHER VALIDATION on question copy. */}
        <QuoteRequestButton asset={asset} />

        {/* ── Maintenance Schedules ─────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div>
              <div className="card-title">Maintenance Schedules ({schedules.length})</div>
              {canWrite && (
                <div className="card-subtitle">
                  “Apply schedule template” adds the standard NFPA 70B / NETA maintenance schedule for this equipment type.
                </div>
              )}
            </div>
          </div>
          {schedules.length === 0 ? (
            <div className="card-body">
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No maintenance schedules yet.
                {canWrite && ' Use "Apply schedule template" to pair this asset with the standard NFPA 70B task set for its equipment type.'}
              </div>
            </div>
          ) : (
            // One section per governing standard. The header row (code +
            // edition + compliance badge) always renders — collapsing a group
            // hides only its schedule rows, never the group itself.
            scheduleGroups.map(group => {
              const collapsed = !!collapsedGroups[group.code];
              const Chevron = collapsed ? ChevronRight : ChevronDown;
              return (
                <div key={group.code} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <div
                    role="button"
                    tabIndex={0}
                    aria-expanded={!collapsed}
                    aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.code} schedules`}
                    onClick={() => toggleGroup(group.code)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleGroup(group.code); }
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                      padding: '10px 16px', cursor: 'pointer', userSelect: 'none',
                      background: 'var(--color-bg)',
                    }}
                  >
                    <Chevron size={15} color="var(--color-text-secondary)" strokeWidth={2} aria-hidden="true" style={{ flexShrink: 0 }} />
                    <span style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
                      {group.code}
                      {group.edition && (
                        <span className="text-muted" style={{ fontWeight: 400, marginLeft: 6, fontSize: 'var(--font-size-xs)' }}>
                          {group.edition}
                        </span>
                      )}
                    </span>
                    <GroupComplianceBadge items={group.items} />
                    <span style={{ flex: 1 }} />
                    {canViewReports && (
                      <Link
                        to={`/reports/compliance/${encodeURIComponent(group.code)}`}
                        onClick={e => e.stopPropagation()}
                        style={{
                          fontSize: 'var(--font-size-xs)', fontWeight: 600,
                          color: 'var(--color-primary)', whiteSpace: 'nowrap', textDecoration: 'none',
                        }}
                        title={`Open the ${group.code} compliance report`}
                      >
                        Report →
                      </Link>
                    )}
                  </div>
                  {!collapsed && (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Task</th>
                            <th>Standard Ref</th>
                            <th>Interval</th>
                            <th>Last Completed</th>
                            <th>Next Due</th>
                            {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {group.items.map(s => {
                            const { cond, months } = effectiveIntervalMonths(s, asset);
                            const overdue = s.nextDueDate && new Date(s.nextDueDate) < new Date();
                            return (
                              <tr key={s.id} style={!s.isActive ? { opacity: 0.55 } : undefined}>
                                <td>
                                  <div style={{ fontWeight: 600 }}>{s.taskDefinition?.taskName || '—'}</div>
                                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                                    {[
                                      s.taskDefinition?.requiresOutage ? 'Requires outage' : null,
                                      s.conditionOverride ? `Override: ${s.conditionOverride}` : null,
                                      !s.isActive ? 'Inactive' : null,
                                    ].filter(Boolean).join(' · ')}
                                  </div>
                                </td>
                                <td className="td-muted">{s.taskDefinition?.standardRef || '—'}</td>
                                <td>
                                  {months != null
                                    ? <span>{months} mo <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>({cond})</span></span>
                                    : <span className="text-muted">—</span>}
                                </td>
                                <td>{fmtDate(s.lastCompletedDate)}</td>
                                <td>
                                  <span style={overdue ? { color: 'var(--color-danger)', fontWeight: 600 } : undefined}>
                                    {fmtDate(s.nextDueDate)}{overdue ? ' · overdue' : ''}
                                  </span>
                                </td>
                                {canWrite && (
                                  <td style={{ textAlign: 'right' }}>
                                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => setCompletingSchedule(s)}
                                        disabled={busy}
                                        title="Record a completion today and roll the recurrence forward"
                                      >
                                        Mark complete
                                      </button>
                                      <button
                                        type="button"
                                        className="btn btn-secondary btn-sm"
                                        onClick={() => handleNewWorkOrder(s)}
                                        disabled={busy}
                                        title="Create a work order for this task"
                                      >
                                        New work order
                                      </button>
                                    </div>
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
              );
            })
          )}
        </div>

        {/* ── Condition-based interval engine (R3) ──────────────────────────── */}
        <ConditionIntervalCard asset={asset} canWrite={canWrite} onApplied={refetchAll} />

        {/* ── Outage Consolidation Planner ──────────────────────────────────── */}
        {/* Self-gating: renders null when there are no outage-requiring tasks
            in the ±90-day window so it stays invisible for healthy assets. */}
        <OutageConsolidationCard asset={asset} canWrite={canWrite} />

        {/* ── Work Orders ───────────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header">
            <div className="card-title">Work Orders {workOrders.length > 0 && `(latest ${workOrders.length})`}</div>
          </div>
          {workOrders.length === 0 ? (
            <div className="card-body">
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No work orders for this asset yet.
              </div>
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Scheduled</th>
                    <th>Contractor</th>
                    <th>Completed</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {workOrders.map(wo => (
                    <tr key={wo.id}>
                      <td><MetaChip meta={WO_STATUS_META[wo.status]} fallback={wo.status} /></td>
                      <td>{fmtDate(wo.scheduledDate)}</td>
                      <td>
                        {wo.contractor?.name || <span className="text-muted">Unassigned</span>}
                        {wo.assignedTech?.name && (
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                            {wo.assignedTech.name}
                          </div>
                        )}
                      </td>
                      <td>{fmtDate(wo.completedDate)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <Link to={`/work-orders/${wo.id}`} state={fromState} className="btn btn-secondary btn-sm">Open</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── AI Maintenance Brief ──────────────────────────────────────────── */}
        {/* Self-gating: renders null unless AI is enabled+configured and the
            user's role carries the maintenance_brief feature. */}
        <MaintenanceBriefCard asset={asset} />

        {/* #2 — per-asset requirement → evidence trace (renders null if no tasks). */}
        <AssetEvidenceTraceCard assetId={id} />

        {/* ── Power Path ────────────────────────────────────────────────────── */}
        {/* Upstream/downstream feed chain; refetches itself whenever the asset
            object refreshes, and bumps the page on feed edits. */}
        <PowerPathCard asset={asset} canWrite={canWrite} onChanged={refetchAll} />

        {/* ── Lab Samples ───────────────────────────────────────────────────── */}
        {labSamples.length > 0 && (
          <div className="card mb-16">
            <div className="card-header">
              <div className="card-title">Lab Samples (latest {labSamples.length})</div>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Sample Date</th>
                    <th>Lab</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {labSamples.map(ls => (
                    <tr key={ls.id}>
                      <td style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 'var(--font-size-sm)' }}>
                        {(ls.sampleType || '').replace(/_/g, ' ')}
                      </td>
                      <td>{fmtDate(ls.sampleDate)}</td>
                      <td className="td-muted">{ls.labName || '—'}</td>
                      <td>
                        <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                          <MetaChip meta={DECAL_META[ls.resultRating]} fallback="Pending" />
                          {IEEE_STATUS_META[ls.ieeeStatus] && (
                            <span title="IEEE C57.104 DGA status">
                              <MetaChip meta={{
                                ...IEEE_STATUS_META[ls.ieeeStatus],
                                label: `IEEE ${ls.ieeeStatus} — ${IEEE_STATUS_META[ls.ieeeStatus].label}`,
                              }} />
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ── LOTO Procedures ───────────────────────────────────────────────── */}
        {/* Structured lockout/tagout procedures (energy sources + steps).
            Active procedure shown prominently; drafts editable; archived
            collapsed. OSHA 29 CFR 1910.147 compliance anchor. */}
        <AssetLotoCard asset={asset} canWrite={canWrite} />

        {/* ── Documents & Procedures ────────────────────────────────────────── */}
        {/* OEM manuals, wiring diagrams, test reports, warranty docs, and
            PDF backups of LOTO procedures. Supports file upload and URL links. */}
        <AssetDocumentsCard asset={asset} canWrite={canWrite} />

        {/* ── AI Photo Inspection ───────────────────────────────────────────── */}
        {/* Same self-gating as the brief card (maintenance_brief feature +
            aiEnabled + aiConfigured). Apply actions refetch the asset. */}
        <PhotoInspectCard asset={asset} onApplied={refetchAll} />

        {/* ── Nameplate photo + AI-parsed fields (scan → review → save) ──────── */}
        <NameplateCard asset={asset} canEdit={canWrite} onChanged={refetchAll} />

        {/* ── Nameplate ─────────────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header"><div className="card-title">Nameplate &amp; Details</div></div>
          <div className="card-body">
            <div className="detail-grid">
              <div className="detail-item">
                <div className="detail-label">Install Date</div>
                <div className="detail-value">{fmtDate(asset.installDate)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Last Commissioned</div>
                <div className="detail-value">{fmtDate(asset.lastCommissionedDate)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Serial Number</div>
                <div className="detail-value">{asset.serialNumber || <span className="text-muted">—</span>}</div>
              </div>
              {nameplateEntries.map(([k, v]) => (
                <div className="detail-item" key={k}>
                  <div className="detail-label">{k}</div>
                  <div className="detail-value">{String(v ?? '') || <span className="text-muted">—</span>}</div>
                </div>
              ))}
            </div>
            {asset.notes && (
              <div style={{ marginTop: 16 }}>
                <div className="detail-label">Notes</div>
                <div className="detail-value" style={{ whiteSpace: 'pre-wrap' }}>{asset.notes}</div>
              </div>
            )}
          </div>
        </div>

        {/* ── Custom Fields ─────────────────────────────────────────────────── */}
        {(fieldDefs.length > 0 || archivedCustomValues.length > 0) && (
          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Custom Fields</div></div>
            <div className="card-body">
              <div className="detail-grid">
                {fieldDefs.map(def => (
                  <div className="detail-item" key={def.id}>
                    <div className="detail-label">{def.name}</div>
                    <div className="detail-value">
                      {formatCustomValue(def, customValueByDef.get(def.id)) ?? <span className="text-muted">—</span>}
                    </div>
                  </div>
                ))}
                {archivedCustomValues.map(v => (
                  <div className="detail-item" key={v.definitionId}>
                    <div className="detail-label">{v.definition.name} <span className="text-muted">(archived)</span></div>
                    <div className="detail-value">
                      {formatCustomValue(v.definition, v.value) ?? <span className="text-muted">—</span>}
                    </div>
                  </div>
                ))}
              </div>
              {canWrite && fieldDefs.length > 0 && (
                <div className="form-hint" style={{ marginTop: 12 }}>
                  Edit values via the Edit button above. Definitions are managed in Settings → Custom Fields.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Documents (compact) ───────────────────────────────────────────── */}
        {documents.length > 0 && (
          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Documents ({documents.length})</div></div>
            <div className="card-body" style={{ padding: 0 }}>
              {documents.map(doc => (
                <div key={doc.id} style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '10px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--font-size-ui)' }}>
                  <span style={{ fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {doc.filename || doc.originalName || 'Document'}
                  </span>
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap' }}>
                    {doc.uploader?.name ? `${doc.uploader.name} · ` : ''}{fmtDate(doc.uploadedAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Activity feed ─────────────────────────────────────────────────── */}
        <div className="card mb-16">
          <div className="card-header"><div className="card-title">Activity</div></div>
          <div className="card-body" style={{ padding: 0 }}>
            {activity.length === 0 ? (
              <div style={{ padding: 16, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No activity recorded yet.
              </div>
            ) : (
              activity.map(log => (
                <div key={log.id} style={{ display: 'flex', gap: 10, padding: '10px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--font-size-ui)' }}>
                  <div style={{ flex: 1 }}>
                    <div>{activityText(log)}</div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      {log.user?.name || 'System'} · {fmtDate(log.createdAt)}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        </>)}
      </div>
      {completingSchedule && (
        <CompleteScheduleModal
          schedule={completingSchedule}
          busy={busy}
          onClose={() => setCompletingSchedule(null)}
          onConfirm={(performedByName, completedDate) => handleCompleteSchedule(completingSchedule, performedByName, completedDate)}
        />
      )}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
