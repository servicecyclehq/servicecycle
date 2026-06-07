import { useState, useEffect, useRef, useCallback } from 'react';
import { InfoTip } from '../components/InfoTip';
import { useParams, useNavigate, useSearchParams, Link, useLocation} from 'react-router-dom';
import api from '../api/client';
import { renewalUrgency, URGENCY_CHIP_CLASS } from '../lib/urgency';
import { buildContractOrigin, rememberContractOrigin } from '../lib/contractOrigin';
import { useAuth } from '../context/AuthContext';
import { useAiConsent } from '../context/AiConsentContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import CustomFieldInputs from '../components/CustomFieldInputs';
import AiDisclaimer from '../components/AiDisclaimer';
import AiCapHelper from '../components/AiCapHelper'; // v0.32.4
import BriefSection from '../components/BriefSection';
import NegotiationRecsCard from '../components/NegotiationRecsCard'; // v0.78.0
import BriefCategoryBadge from '../components/BriefCategoryBadge';
import BriefSources from '../components/BriefSources';
import QuoteUploadCard from '../components/QuoteUploadCard';
import RenewalPlanningPanel from '../components/RenewalPlanningPanel';
import { downloadAuthedFile } from '../api/download';
// v0.54 — lucide icons for the contract-detail header action cluster.
// Replaces the prior emoji set (🔄 🗄 📂 📄 👤 ✓) with consistent outline
// icons so the header stops looking like an accumulated pile of buttons.
import {
  FileUp, UserPlus, UserCheck, Archive, ArchiveRestore,
  X as XIcon, Pencil, RefreshCw, AlertTriangle, Clock, Download,
} from 'lucide-react';

// Pass 6 P0-D-01 (v0.36.3): map the opt-in renewal-brief slugs (server
// catalog snake_case, persisted in AccountSetting brief_sections_enabled)
// to the camelCase keys the server uses inside the optInSections payload.
// Keep aligned with server/lib/aiBrief/optInSections.js SECTIONS[].slug
// and .key. If a new slug is added there, add the mapping here too or
// the new section will fetch but won't render.
const OPT_IN_SLUG_TO_KEY = Object.freeze({
  recommended_strategy:         'recommendedStrategy',
  license_utilization_analysis: 'licenseUtilization',
  coterm_opportunities:         'cotermOpportunities',
  quote_request_hygiene:        'quoteRequestHygiene',
  internal_stakeholder_map:     'internalStakeholderMap',
});


const SAVINGS_LEVER_OPTIONS = [
  { value: '',                   label: 'Not tagged' },
  { value: 'usage_reduction',    label: 'Usage Reduction — utilization data → seat count cut' },
  { value: 'term_length',        label: 'Term Length Change — multi-year commit → lower rate' },
  { value: 'benchmark_pressure', label: 'Benchmark Pressure — cited benchmark → vendor matched' },
  { value: 'competitive_threat', label: 'Competitive Threat — competing quote → vendor moved' },
  { value: 'seat_count_cut',     label: 'Seat Count Cut — below contracted minimum → repriced' },
  { value: 'legal_language',     label: 'Legal Language Change — removed auto-renewal → vendor conceded' },
  { value: 'other',              label: 'Other' },
];
const SAVINGS_LEVER_LABEL = (v) => SAVINGS_LEVER_OPTIONS.find(o => o.value === v)?.label || v;

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtMoney(val) {
  if (val == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val);
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / (1000 * 60 * 60 * 24));
}

// v0.54 — urgency state drives the colored left stripe on the detail header.
// 'calm' = brand petrol, 'evaluate' = amber, 'urgent' = red, 'neutral' = gray
// for non-active contracts (renewed / cancelled / expired). Thresholds match
// the existing days-chip-urgent (<=30) / days-chip-soon (<=60) classes
// loosely — we widen the evaluate window to 90d here so the user has more
// of a heads-up than they get from the per-row chip.
function urgencyState(contract) {
  // #6: canonical Evaluate-By-driven model (lib/urgency.js); overdue -> urgent stripe.
  const u = renewalUrgency(contract);
  return u === 'overdue' ? 'urgent' : u;
}

// v0.54 — the inline urgency phrase that sits in the meta row when there's
// something to say. Returns null when the contract is calm (no phrase
// needed — the static end date already conveys it) or non-active.
function urgencyPhrase(contract) {
  const u = renewalUrgency(contract);
  if (u === 'neutral' || u === 'calm') return null;
  const d = daysUntil(contract.endDate);
  if (u === 'overdue') return { text: `Overdue by ${Math.abs(d)}d`, Icon: AlertTriangle, color: 'var(--color-danger)' };
  if (u === 'urgent')  return { text: `Renews in ${d}d \u00B7 act now`, Icon: AlertTriangle, color: 'var(--color-danger)' };
  return { text: `Renews in ${d}d \u00B7 time to evaluate`, Icon: Clock, color: 'var(--color-warning)' };
}

// v0.54 — status dot color + label. Replaces the StatusBadge pill in the
// detail header so the title block reads less like a Bootstrap landing
// page and more like a Linear / Plausible status row.
const STATUS_DOT = {
  active:       { color: 'var(--color-success)',      label: 'Active' },
  under_review: { color: 'var(--color-warning)',      label: 'Under review' },
  renewed:      { color: 'var(--color-primary)',      label: 'Renewed' },
  cancelled:    { color: 'var(--color-text-muted)',   label: 'Cancelled' },
  expired:      { color: 'var(--color-danger)',       label: 'Expired' },
};

// v0.54 — shared inline styles for the 4-icon action cluster
// (Upload / Assign / Archive / Cancel). Persistent label under each icon
// per Dustin's D4+D2 hybrid pick.
const ICON_CLUSTER_BTN = {
  background: 'transparent', border: 'none',
  borderRight: '1px solid var(--color-border)',
  color: 'var(--color-text-secondary)',
  padding: '6px 12px 4px',
  cursor: 'pointer',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  gap: 1, minWidth: 64,
  fontSize: 'var(--font-size-xs)',
};
const ICON_CLUSTER_BTN_LAST = { ...ICON_CLUSTER_BTN, borderRight: 'none' };
const ICON_CLUSTER_LABEL = { fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' };

function DVal({ value, mono }) {
  if (!value && value !== 0 && value !== false) return <span className="detail-value empty">—</span>;
  return <div className={`detail-value${mono ? ' font-mono' : ''}`}>{String(value)}</div>;
}

function StatusBadge({ status }) {
  const labels = { active: 'Active', under_review: 'Under Review', renewed: 'Renewed', cancelled: 'Cancelled', expired: 'Expired' };
  return <span className={`badge badge-${status}`}>{labels[status] || status}</span>;
}

// #7 contract-section-refresh: quiet per-card edit affordance. Lives in a card
// header; faint until hovered or focused. Replaces the global Edit mode.
function HoverPencil({ onClick, label }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      title={label ? `Edit ${label}` : 'Edit'}
      aria-label={label ? `Edit ${label}` : 'Edit'}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'none', border: 'none', cursor: 'pointer',
        color: hover ? 'var(--color-primary)' : 'var(--color-text-muted)',
        opacity: 1, padding: '2px 6px', borderRadius: 'var(--radius)',
        fontSize: 'var(--font-size-sm)', transition: 'opacity .12s ease, color .12s ease',
        flexShrink: 0,
      }}
    >
      <Pencil size={14} strokeWidth={2} />
      <span>Edit</span>
    </button>
  );
}

// #7: Save/Cancel footer for an inline card editor.
function CardSaveBar({ saving, error, onCancel, onSave }) {
  return (
    <>
      {error && <div role="alert" className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </>
  );
}

// #8 contract-section-refresh: click-to-edit a single numeric value with autosave
// on blur/Enter. Used for seat counts in the License Utilization card.
function InlineNum({ value, canEdit, onSave, label, suffix }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  if (editing) {
    const commit = async () => {
      setBusy(true);
      try { await onSave(draft === '' ? null : Math.max(0, parseInt(draft, 10) || 0)); setEditing(false); }
      catch (e) { /* keep open so the user can retry */ }
      finally { setBusy(false); }
    };
    return (
      <input
        type="number" min="0" autoFocus disabled={busy} value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') setEditing(false); }}
        style={{ width: 90, padding: '2px 6px', border: '1px solid var(--color-border-strong)', borderRadius: 4, font: 'inherit', background: 'var(--color-bg)', color: 'var(--color-text)' }}
      />
    );
  }
  return (
    <span
      onClick={canEdit ? () => { setDraft(value ?? ''); setEditing(true); } : undefined}
      title={canEdit ? `Click to edit ${label}` : undefined}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: canEdit ? 'pointer' : 'default', borderBottom: canEdit ? '1px dashed var(--color-border-strong)' : 'none', width: 'fit-content' }}
    >
      <span style={{ fontWeight: 600 }}>{value != null ? `${value}${suffix || ''}` : '\u2014'}</span>
      {canEdit && <Pencil size={11} strokeWidth={2} style={{ opacity: 0.4 }} />}
    </span>
  );
}

function DaysAlert({ label, dateStr, contract }) {
  // Evaluation-start date: only relevant when the contract is active or under review
  if (label === 'Evaluation start date') {
    if (contract?.status === 'under_review') {
      const reviewer  = contract?.evaluationStartedByUser;
      const startedAt = contract?.evaluationStartedAt;
      return (
        <div className="alert" style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary-hover)', border: '1px solid #bfdbfe' }}>
          🔍 Under review{reviewer ? ` by ${reviewer.name}` : ''}
          {startedAt ? ` · started ${fmt(startedAt)}` : ''}
        </div>
      );
    }
    // Renewed, cancelled, expired — review is done, don't show anything
    if (contract?.status !== 'active') return null;
  }
  const days = daysUntil(dateStr);
  if (!dateStr || days === null) return null;
  let cls = '', msg = '';
  if (days < 0) { cls = 'alert-error'; msg = `${label} was ${Math.abs(days)} day${Math.abs(days) !== 1 ? 's' : ''} ago — action needed`; }
  else if (days <= 14) { cls = 'alert-error'; msg = `${label} in ${days} day${days !== 1 ? 's' : ''} — action required`; }
  else if (days <= 30) { cls = 'alert-info'; msg = `${label} in ${days} days`; }
  else return null;
  return <div className={`alert ${cls}`}>{msg} ({fmt(dateStr)})</div>;
}

const DELIVERY_LABELS = { user: 'Per User', device: 'Per Device', shared_pool: 'Shared Pool' };
const STATUS_OPTIONS = ['active', 'under_review', 'renewed', 'cancelled', 'expired'];
const DELIVERY_OPTIONS = ['user', 'device', 'shared_pool'];

// ─── Payment Schedule Card ────────────────────────────────────────────────────
// Self-contained — fetches and saves its own data. Renders after the Financial card.

const SCHEDULE_TYPE_META = {
  installment:  { label: 'Annual installments',      color: 'var(--color-primary)', bg: 'var(--color-primary-light)', border: 'var(--color-info)' },
  monthly:      { label: 'Monthly',                  color: 'var(--color-info)', bg: 'var(--color-primary-light)', border: 'var(--color-info)' },
  paid_upfront: { label: 'Paid in full (upfront)',   color: 'var(--color-success)', bg: 'var(--color-success-bg)', border: 'var(--color-success)' },
  dismissed:    { label: 'Not applicable',           color: 'var(--color-text-secondary)', bg: 'var(--color-bg)', border: 'var(--color-border)' },
};

function PaymentScheduleCard({ contractId, contract, canEdit }) {
  const [schedule,    setSchedule]    = useState(undefined); // undefined = loading
  const [editing,     setEditing]     = useState(false);
  const [editType,    setEditType]    = useState('installment');
  const [editNotes,   setEditNotes]   = useState('');
  const [editRows,    setEditRows]    = useState([]);        // [{ yearNumber, amount, dueDate, notes }]
  const [monthlyAmount, setMonthlyAmount] = useState('');
  const [monthlyStart,  setMonthlyStart]  = useState('');
  const [saving,      setSaving]      = useState(false);
  const [saveErr,     setSaveErr]     = useState('');

  // Load schedule
  useEffect(() => {
    api.get(`/api/contracts/${contractId}/payment-schedule`)
      .then(r => setSchedule(r.data.data.schedule || null))
      .catch(() => setSchedule(null));
  }, [contractId]);

  // Derive term length in years from contract dates
  function termYears() {
    if (!contract?.startDate || !contract?.endDate) return 3;
    const years = Math.round(
      (new Date(contract.endDate) - new Date(contract.startDate)) / (1000 * 60 * 60 * 24 * 365.25)
    );
    return Math.max(1, Math.min(10, years));
  }

  // Monthly schedule helpers
  function termMonths() {
    if (!contract?.startDate || !contract?.endDate) return 12;
    const days = (new Date(contract.endDate) - new Date(contract.startDate)) / (1000 * 60 * 60 * 24);
    const months = Math.round(days / 30.44);
    return Math.max(1, Math.min(120, months || 12));
  }

  function addMonths(iso, n) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    d.setMonth(d.getMonth() + n);
    return d.toISOString().slice(0, 10);
  }

  function generateMonthly() {
    if (!monthlyStart) { setSaveErr('Enter a billing start date first'); return; }
    const n = termMonths();
    setEditRows(Array.from({ length: n }, (_, i) => ({
      yearNumber: i + 1,
      amount:     monthlyAmount || '',
      dueDate:    addMonths(monthlyStart, i),
      notes:      '',
    })));
    setSaveErr('');
  }

  function openEdit() {
    const ty = schedule?.scheduleType || 'installment';
    setEditType(ty);
    setEditNotes(schedule?.notes || '');
    if ((ty === 'installment' || ty === 'monthly') && schedule?.installments?.length) {
      setEditRows(schedule.installments.map(i => ({
        yearNumber: i.yearNumber,
        amount:     String(i.amount),
        dueDate:    i.dueDate ? i.dueDate.slice(0, 10) : '',
        notes:      i.notes || '',
      })));
      if (ty === 'monthly') {
        setMonthlyAmount(String(schedule.installments[0].amount));
        setMonthlyStart(schedule.installments[0].dueDate ? schedule.installments[0].dueDate.slice(0, 10) : '');
      }
    } else {
      const n = termYears();
      setEditRows(Array.from({ length: n }, (_, i) => ({
        yearNumber: i + 1, amount: '', dueDate: '', notes: '',
      })));
    }
    setSaveErr('');
    setEditing(true);
  }

  function openNew(type) {
    setEditType(type);
    setEditNotes('');
    setMonthlyAmount('');
    setMonthlyStart(contract?.startDate ? new Date(contract.startDate).toISOString().slice(0, 10) : '');
    if (type === 'installment') {
      const n = termYears();
      setEditRows(Array.from({ length: n }, (_, i) => ({
        yearNumber: i + 1, amount: '', dueDate: '', notes: '',
      })));
    } else {
      setEditRows([]);
    }
    setSaveErr('');
    setEditing(true);
  }

  function updateRow(idx, field, val) {
    setEditRows(rows => rows.map((r, i) => i === idx ? { ...r, [field]: val } : r));
  }

  function addYear() {
    setEditRows(rows => [...rows, { yearNumber: rows.length + 1, amount: '', dueDate: '', notes: '' }]);
  }

  function removeYear(idx) {
    setEditRows(rows => rows.filter((_, i) => i !== idx).map((r, i) => ({ ...r, yearNumber: i + 1 })));
  }

  async function handleSave() {
    setSaving(true);
    setSaveErr('');
    try {
      const payload = {
        scheduleType: editType,
        notes:        editNotes || null,
        installments: (editType === 'installment' || editType === 'monthly')
          ? editRows.filter(r => r.amount).map(r => ({
              yearNumber: r.yearNumber,
              amount:     parseFloat(r.amount),
              dueDate:    r.dueDate || null,
              notes:      r.notes  || null,
            }))
          : [],
      };
      const r = await api.put(`/api/contracts/${contractId}/payment-schedule`, payload);
      setSchedule(r.data.data.schedule);
      setEditing(false);
    } catch (err) {
      setSaveErr(err.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  // ── Helpers ──
  function fmtAmount(val) {
    if (!val && val !== 0) return '—';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function totalAmount() {
    if (!schedule?.installments?.length) return null;
    return schedule.installments.reduce((sum, i) => sum + parseFloat(i.amount), 0);
  }

  // ── Render ──
  if (schedule === undefined) return null; // loading — render nothing silently

  const typeMeta = schedule ? SCHEDULE_TYPE_META[schedule.scheduleType] : null;

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ alignItems: 'center' }}>
        <div className="card-title">💳 Payment Schedule</div>
        {!editing && canEdit && schedule && (
          <button
            className="btn btn-secondary"
            style={{ fontSize: '0.78rem', padding: '4px 10px' }}
            onClick={openEdit}
          >
            Edit
          </button>
        )}
      </div>
      <div className="card-body">

        {/* ── No schedule set yet ── */}
        {!schedule && !editing && (
          <div>
            <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
              No payment schedule has been set for this contract. Setting one helps with budget
              forecasting and ensures the right amounts show up in your annual payment calendar.
            </p>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(SCHEDULE_TYPE_META).map(([type, meta]) => (
                  <button
                    key={type}
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openNew(type)}
                    style={{ minWidth: 150, justifyContent: 'center' }}
                  >
                    {meta.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Schedule set, view mode ── */}
        {schedule && !editing && (
          <div>
            {/* Type badge */}
            <div style={{ marginBottom: 12 }}>
              <span style={{
                fontSize: '0.78rem', fontWeight: 700, padding: '3px 10px', borderRadius: 4,
                background: typeMeta?.bg, color: typeMeta?.color, border: `1px solid ${typeMeta?.border}`,
              }}>
                {typeMeta?.label}
              </span>
            </div>

            {/* Paid upfront notice */}
            {schedule.scheduleType === 'paid_upfront' && (
              <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', margin: '0 0 8px' }}>
                Full contract term paid up front. No annual payments due — renewal motion still applies at end of term.
              </p>
            )}

            {/* Dismissed notice */}
            {schedule.scheduleType === 'dismissed' && (
              <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)', margin: '0 0 8px' }}>
                Not applicable — treated as standard annual recurring billing. Budget forecast uses cost per license × quantity each year.
              </p>
            )}

            {/* Installment table */}
            {(schedule.scheduleType === 'installment' || schedule.scheduleType === 'monthly') && schedule.installments?.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <th style={thStyle}>{schedule.scheduleType === 'monthly' ? 'Month' : 'Year'}</th>
                    <th style={thStyle}>Due Date</th>
                    <th style={{ ...thStyle, textAlign: 'right' }}>Amount</th>
                    <th style={thStyle}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.installments.map((inst, i) => {
                    const isLast = i === schedule.installments.length - 1;
                    return (
                      <tr key={inst.id} style={{
                        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
                        background: isLast ? 'rgba(124,58,237,0.04)' : 'transparent',
                      }}>
                        <td style={tdStyle}>
                          {schedule.scheduleType === 'monthly' ? 'Month' : 'Year'} {inst.yearNumber}
                          {isLast && schedule.scheduleType !== 'monthly' && <span style={{ marginLeft: 6, fontSize: '0.7rem', fontWeight: 600, color: 'var(--color-primary)' }}>renewal yr</span>}
                        </td>
                        <td style={tdStyle}>{fmtDate(inst.dueDate)}</td>
                        <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 600 }}>{fmtAmount(inst.amount)}</td>
                        <td style={{ ...tdStyle, color: 'var(--color-text-secondary)' }}>{inst.notes || '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid var(--color-border)' }}>
                    <td colSpan={2} style={{ ...tdStyle, fontWeight: 700 }}>Total contract value</td>
                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }}>{fmtAmount(totalAmount())}</td>
                    <td style={tdStyle} />
                  </tr>
                </tfoot>
              </table>
            )}
            {(schedule.scheduleType === 'installment' || schedule.scheduleType === 'monthly') && !schedule.installments?.length && (
              <p style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                Payment amounts not yet entered.
                {canEdit && <button onClick={openEdit} style={inlineLinkBtn}> Add amounts →</button>}
              </p>
            )}

            {/* Top-level notes */}
            {schedule.notes && (
              <p style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)', marginTop: 10, fontStyle: 'italic' }}>
                {schedule.notes}
              </p>
            )}
          </div>
        )}

        {/* ── Edit / Create form ── */}
        {editing && (
          <div>
            {/* Schedule type selector */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                Payment type
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(SCHEDULE_TYPE_META).map(([type, meta]) => (
                  <button
                    key={type}
                    type="button"
                    className={editType === type ? 'btn btn-primary' : 'btn btn-secondary'}
                    onClick={() => setEditType(type)}
                    style={{ minWidth: 150, justifyContent: 'center' }}
                  >
                    {meta.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Installment rows */}
            {(editType === 'installment' || editType === 'monthly') && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
                  {editType === 'monthly' ? 'Monthly payments' : 'Annual payments'}
                </div>

                {editType === 'monthly' && (
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
                    <div>
                      <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Monthly amount ($)</label>
                      <input type="number" min="0" step="0.01" placeholder="0.00" value={monthlyAmount} onChange={e => setMonthlyAmount(e.target.value)} style={{ ...scheduleInput, width: 140 }} />
                    </div>
                    <div>
                      <label style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>Billing start</label>
                      <input type="date" value={monthlyStart} onChange={e => setMonthlyStart(e.target.value)} style={{ ...scheduleInput, width: 160 }} />
                    </div>
                    <button type="button" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '6px 12px' }} onClick={generateMonthly}>
                      {editRows.length ? 'Regenerate' : 'Generate schedule'}
                    </button>
                  </div>
                )}
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.83rem', marginBottom: 8 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={thStyle}>{editType === 'monthly' ? 'Month' : 'Year'}</th>
                      <th style={thStyle}>Amount ($)</th>
                      <th style={thStyle}>Due Date</th>
                      <th style={thStyle}>Notes</th>
                      <th style={{ ...thStyle, width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {editRows.map((row, idx) => {
                      const isLast = idx === editRows.length - 1;
                      return (
                        <tr key={idx} style={{
                          borderBottom: '1px solid var(--color-border)',
                          background: isLast ? 'rgba(124,58,237,0.03)' : 'transparent',
                        }}>
                          <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                            {editType === 'monthly' ? 'Month' : 'Year'} {row.yearNumber}
                            {isLast && editType !== 'monthly' && <span style={{ marginLeft: 5, fontSize: '0.68rem', fontWeight: 700, color: 'var(--color-primary)' }}>renewal yr</span>}
                          </td>
                          <td style={tdStyle}>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              placeholder="0.00"
                              value={row.amount}
                              onChange={e => updateRow(idx, 'amount', e.target.value)}
                              style={scheduleInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              type="date"
                              value={row.dueDate}
                              onChange={e => updateRow(idx, 'dueDate', e.target.value)}
                              style={scheduleInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            <input
                              type="text"
                              placeholder="Optional note"
                              value={row.notes}
                              onChange={e => updateRow(idx, 'notes', e.target.value)}
                              style={scheduleInput}
                            />
                          </td>
                          <td style={tdStyle}>
                            {editRows.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeYear(idx)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', fontSize: '0.85rem', padding: '2px 4px' }}
                                title="Remove this year"
                              >✕</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>

                <button
                  type="button"
                  onClick={addYear}
                  style={{ fontSize: '0.78rem', color: 'var(--color-primary)', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  {editType === 'monthly' ? '+ Add month' : '+ Add year'}
                </button>
              </div>
            )}

            {/* paid_upfront notice */}
            {editType === 'paid_upfront' && (
              <p style={{ fontSize: '0.83rem', color: 'var(--color-text-secondary)', marginBottom: 16 }}>
                Mark this contract as paid in full for the entire term. No annual installment amounts needed.
                A renewal motion will still be triggered at the end of the term.
              </p>
            )}

            {/* dismissed notice */}
            {editType === 'dismissed' && (
              <p style={{ fontSize: '0.83rem', color: 'var(--color-text-secondary)', marginBottom: 16 }}>
                Mark as not applicable. Budget forecast will use cost per license × quantity as standard annual recurring billing.
              </p>
            )}

            {/* Top-level notes field */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text-secondary)', display: 'block', marginBottom: 4 }}>
                Schedule notes <span style={{ fontWeight: 400 }}>(optional)</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Invoiced each March on anniversary date"
                value={editNotes}
                onChange={e => setEditNotes(e.target.value)}
                style={{ ...scheduleInput, width: '100%', maxWidth: 440 }}
              />
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? 'Saving…' : 'Save Schedule'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditing(false)}
                disabled={saving}
              >
                Cancel
              </button>
              {saveErr && <span style={{ color: 'var(--color-danger)', fontSize: '0.8rem' }}>{saveErr}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '6px 10px', fontSize: '0.75rem', fontWeight: 600, color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' };
const tdStyle = { padding: '8px 10px', verticalAlign: 'middle' };
const scheduleInput = { padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 4, fontSize: '0.83rem', background: 'var(--color-surface)', color: 'var(--color-text)', outline: 'none', width: '100%', boxSizing: 'border-box' };
const inlineLinkBtn = { background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 'inherit', padding: 0, textDecoration: 'underline' };

// ─── Renewal Workflow Checklist ───────────────────────────────────────────────

const CHECKLIST_STEPS = [
  { key: 'noticesSent',       label: 'Renewal notice sent to vendor',     desc: 'Notified the vendor of intent to review, or opened the cancel window.' },
  { key: 'usageReviewed',     label: 'Usage reviewed / quote requested',  desc: 'Reviewed seat/license utilization and requested a renewal quote.' },
  { key: 'proposalReceived',  label: 'Proposal received',                 desc: 'Vendor has submitted a renewal quote or proposal.' },
  { key: 'underNegotiation',  label: 'Under negotiation',                 desc: 'Actively negotiating terms, price, or scope.' },
  { key: 'awaitingSignature', label: 'Approved & awaiting signature',     desc: 'Final agreement reached internally; pending signatures.' },
  { key: 'signed',            label: 'Signed / renewed',                  desc: 'Renewal complete; contract executed.' },
];

// helper: normalize a checklist value — old records stored plain booleans
function itemChecked(val)  { return val === true || val?.checked === true; }
function itemMeta(val)     { return (val && typeof val === 'object') ? val : null; }
function fmtCheckDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function RenewalChecklist({ contractId, checklist, canEdit, onUpdate }) {
  const [saving, setSaving] = useState(false);

  async function toggle(key) {
    if (!canEdit || saving) return;
    // Send a plain boolean map - server enriches checked items with user + timestamp
    const next = {};
    for (const s of CHECKLIST_STEPS) {
      next[s.key] = s.key === key ? !itemChecked(checklist[s.key]) : itemChecked(checklist[s.key]);
    }
    setSaving(true);
    try {
      const res = await api.put(`/api/contracts/${contractId}`, { renewalChecklist: next });
      onUpdate(res.data.data.contract);
    } catch (e) {
      console.error('Checklist save error', e);
    } finally {
      setSaving(false);
    }
  }

  const completedCount = CHECKLIST_STEPS.filter(s => itemChecked(checklist[s.key])).length;
  const pct = Math.round((completedCount / CHECKLIST_STEPS.length) * 100);

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="card-title">🗂 Renewal Workflow</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {completedCount} of {CHECKLIST_STEPS.length} steps complete
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 80, height: 6, background: 'var(--color-border)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: pct === 100 ? 'var(--color-success)' : 'var(--color-primary)', borderRadius: 3, transition: 'width 0.3s' }} />
          </div>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', minWidth: 30 }}>{pct}%</span>
        </div>
      </div>
      {/* #13: 6 steps in a 3x2 grid. Step description -> cell hover tooltip;
          checked-by/when -> hover on the number/check badge. Progress bar + %
          and the next-step highlight are retained. */}
      <div className="card-body" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }}>
        {CHECKLIST_STEPS.map((step, idx) => {
          const checked  = itemChecked(checklist[step.key]);
          const meta     = itemMeta(checklist[step.key]);
          const prevDone = idx === 0 || itemChecked(checklist[CHECKLIST_STEPS[idx - 1].key]);
          const isNext   = !checked && prevDone && CHECKLIST_STEPS.slice(0, idx).every(s => itemChecked(checklist[s.key]));
          const badgeTitle = checked && meta?.userName
            ? `Checked by ${meta.userName}${meta.checkedAt ? ` on ${fmtCheckDate(meta.checkedAt)}` : ''}`
            : (checked ? 'Completed' : 'Not yet complete');
          return (
            <div
              key={step.key}
              onClick={() => canEdit && toggle(step.key)}
              title={step.desc}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: 10,
                padding: '10px 12px', borderRadius: 'var(--radius)',
                border: isNext ? '1px solid var(--color-primary)' : '1px solid var(--color-border)',
                background: isNext ? 'var(--color-surface-raised, rgba(124,58,237,0.05))' : 'var(--color-surface)',
                cursor: canEdit ? 'pointer' : 'default',
                opacity: saving ? 0.6 : 1,
                transition: 'background 0.15s, border-color 0.15s',
              }}
            >
              <div
                title={badgeTitle}
                style={{
                  width: 22, height: 22, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 'var(--font-size-xs)', fontWeight: 700, lineHeight: 1,
                  border: checked ? 'none' : '2px solid var(--color-border)',
                  background: checked ? 'var(--color-primary)' : 'transparent',
                  color: checked ? 'var(--color-surface)' : 'var(--color-text-secondary)',
                }}
              >
                {checked ? '\u2713' : (idx + 1)}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 'var(--font-size-ui)',
                  fontWeight: checked ? 400 : 500,
                  color: checked ? 'var(--color-text-secondary)' : 'var(--color-text)',
                  textDecoration: checked ? 'line-through' : 'none',
                }}>
                  {step.label}
                </div>
                {isNext && (
                  <div style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 3 }}>
                    Next step
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Activity Timeline ────────────────────────────────────────────────────────

const ACTION_CONFIG = {
  status_changed:     { icon: '🔄', label: (d) => `Status changed: ${(d.from || '').replace('_', ' ')} → ${(d.to || '').replace('_', ' ')}` },
  fields_updated:     { icon: '✏️',  label: (d) => `Updated: ${(d.fields || []).join(', ')}` },
  owner_assigned:     { icon: '👤', label: (d) => d.toUserId ? 'Owner assigned' : 'Owner removed' },
  brief_generated:    { icon: '✨', label: (d) => d.refresh ? 'AI renewal brief regenerated' : 'AI renewal brief generated' },
  document_uploaded:  { icon: '📄', label: (d) => `Document uploaded${d.filename ? ': ' + d.filename : ''}` },
  contract_created:   { icon: '✅', label: (d) => d.clonedFrom ? 'Contract created as renewal' : 'Contract created' },
  contract_renewed:   { icon: '🔁', label: ()  => 'Renewal created — new contract record generated' },
  contract_cancelled: { icon: '🚫', label: ()  => 'Contract cancelled' },
  checklist_updated:  { icon: '☑️',  label: (d) => {
    const items = (d.items || []);
    if (!items.length) return 'Renewal checklist updated';
    const checked = items.filter(i => i.checked).map(i => i.label);
    const unchecked = items.filter(i => !i.checked).map(i => i.label);
    const parts = [];
    if (checked.length)   parts.push(`✓ ${checked.join(', ')}`);
    if (unchecked.length) parts.push(`✗ ${unchecked.join(', ')}`);
    return `Checklist: ${parts.join(' | ')}`;
  }},
};

function relTime(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins  <  1) return 'just now';
  if (mins  < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days  === 1) return 'yesterday';
  return `${days} days ago`;
}

function dayBucket(dateStr) {
  const d     = new Date(dateStr);
  const today = new Date();
  const yest  = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString())  return 'Yesterday';
  return d.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

// ── Purchase Orders panel (v0.10.0) ──────────────────────────────────────────
// Multi-PO support for the Microsoft MPSA / Adobe VIP pattern. Contract holds
// the master agreement number (Contract.contractNumber); each PO under it
// gets its own row in the purchase_orders table with its own poNumber,
// amount, order date, and coverage period. The list-view search-by-PO
// (extended in v0.10.0) joins to this table so typing a PO number in the
// contracts-page search filters down to the parent contract.
function PurchaseOrdersPanel({ contract, canEdit, onChange, onDocChange }) {
  const confirm = useConfirm();
  const initial = Array.isArray(contract.purchaseOrders) ? contract.purchaseOrders : [];
  const [pos, setPos] = useState(initial);
  const [editingId, setEditingId] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Re-sync from parent when the contract object changes (after refetch).
  useEffect(() => {
    setPos(Array.isArray(contract.purchaseOrders) ? contract.purchaseOrders : []);
  }, [contract.purchaseOrders]);

  const fmtAmount = (a) => {
    if (a === null || a === undefined || a === '') return '—';
    const n = Number(a);
    if (!Number.isFinite(n)) return '—';
    return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  };
  const fmtDate = (d) => {
    if (!d) return '—';
    const date = new Date(d);
    return isNaN(date) ? '—' : date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  };

  async function refresh() {
    try {
      const r = await api.get(`/api/contracts/${contract.id}/purchase-orders`);
      const fresh = r.data?.data?.purchaseOrders || [];
      setPos(fresh);
      if (onChange) onChange(fresh);
    } catch (e) { /* leave existing list on error */ }
  }

  async function handleSubmit(formData, poId) {
    setBusy(true); setError('');
    try {
      if (poId) {
        await api.patch(`/api/contracts/${contract.id}/purchase-orders/${poId}`, formData);
      } else {
        await api.post(`/api/contracts/${contract.id}/purchase-orders`, formData);
      }
      setAdding(false);
      setEditingId(null);
      await refresh();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save purchase order.');
    } finally {
      setBusy(false);
    }
  }

  async function handleArchive(po) {
    if (!await confirm({
      title: 'Archive purchase order',
      message: `Archive PO ${po.poNumber}? It will disappear from the contract detail and from PO search.`,
      confirmLabel: 'Archive',
      danger: true,
    })) return;
    setBusy(true); setError('');
    try {
      await api.delete(`/api/contracts/${contract.id}/purchase-orders/${po.id}`);
      await refresh();
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to archive purchase order.');
    } finally {
      setBusy(false);
    }
  }

  // #10: attach a stored file to a specific PO. Reuses the generic document
  // upload endpoint (poId links the Document to the PO + its parent contract).
  const attachRef = useRef(null);
  const [attachPoId, setAttachPoId] = useState(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [openingDoc, setOpeningDoc] = useState(null);

  function pickAttach(poId) {
    setAttachPoId(poId);
    setError('');
    if (attachRef.current) attachRef.current.click();
  }

  async function handleAttach(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !attachPoId) return;
    setAttachBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('poId', attachPoId);
      fd.append('contractId', contract.id);
      await api.post('/api/documents/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (onDocChange) await onDocChange(); else await refresh();
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to attach file to PO.');
    } finally {
      setAttachBusy(false);
      setAttachPoId(null);
    }
  }

  async function openDoc(docId) {
    setOpeningDoc(docId);
    try {
      const res = await api.get(`/api/documents/${docId}/url`);
      const url = res.data?.data?.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) { /* ignore */ }
    finally { setOpeningDoc(null); }
  }

  return (
    <div className="card mb-16">
      <div className="card-header">
        <div>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>📑 Purchase Orders</span>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--color-text-secondary)' }}>
              {pos.length === 0 ? 'none yet' : `${pos.length}`}
            </span>
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Track individual deliverable POs under this master agreement. Useful for MPSA / VIP / framework agreements where one contract number covers many orders.
          </div>
        </div>
        {canEdit && !adding && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => { setAdding(true); setEditingId(null); setError(''); }}
            disabled={busy}
          >
            + Add PO
          </button>
        )}
      </div>
      <div className="card-body">
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
        <input ref={attachRef} type="file" onChange={handleAttach} style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />

        {adding && (
          <PurchaseOrderForm
            contractId={contract.id}
            busy={busy}
            onCancel={() => { setAdding(false); setError(''); }}
            onSubmit={(form) => handleSubmit(form, null)}
          />
        )}

        {pos.length === 0 && !adding && (
          <div className="empty-state" style={{ padding: '20px 12px' }}>
            <div className="empty-state-title">No POs recorded yet</div>
            <div className="empty-state-sub">
              {canEdit
                ? 'Click "Add PO" above to log the first one. Anything added here will surface when searching by PO number from the contracts list.'
                : 'Once a manager logs the first PO, it will appear here.'}
            </div>
          </div>
        )}

        {pos.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PO #</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Order date</th>
                  <th style={{ textAlign: 'right' }}>Coverage</th>
                  {canEdit && <th style={{ width: 130 }}></th>}
                </tr>
              </thead>
              <tbody>
                {pos.map((po) => editingId === po.id ? (
                  <tr key={po.id}>
                    <td colSpan={canEdit ? 7 : 6} style={{ padding: 0 }}>
                      <div style={{ padding: '12px 16px' }}>
                        <PurchaseOrderForm
                          contractId={contract.id}
                          initial={po}
                          busy={busy}
                          onCancel={() => { setEditingId(null); setError(''); }}
                          onSubmit={(form) => handleSubmit(form, po.id)}
                        />
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={po.id}>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)', fontWeight: 600 }}>{po.poNumber}</td>
                    <td style={{ maxWidth: 280 }}>
                      {po.description
                        ? <span>{po.description}</span>
                        : <span className="text-muted">—</span>}
                      {po.notes && <div className="text-secondary" style={{ fontSize: 'var(--font-size-xs)', marginTop: 2, whiteSpace: 'pre-wrap' }}>{po.notes}</div>}
                      {Array.isArray(po.documents) && po.documents.length > 0 && (
                        <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {po.documents.map((d) => (
                            <button
                              key={d.id}
                              type="button"
                              onClick={() => openDoc(d.id)}
                              disabled={openingDoc === d.id}
                              title={'Open ' + d.filename}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: 200, padding: '2px 8px', fontSize: 'var(--font-size-xs)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)', background: 'var(--color-surface, #fff)', color: 'var(--color-primary)', cursor: 'pointer' }}
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.filename}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono, monospace)' }}>{fmtAmount(po.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{po.quantity ?? '—'}</td>
                    <td style={{ textAlign: 'right' }}>{fmtDate(po.orderDate)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {po.coverageStartDate || po.coverageEndDate
                        ? <span style={{ fontSize: 'var(--font-size-sm)' }}>{fmtDate(po.coverageStartDate)} → {fmtDate(po.coverageEndDate)}</span>
                        : <span className="text-muted">—</span>}
                    </td>
                    {canEdit && (
                      <td style={{ textAlign: 'right' }}>
                        <button type="button" className="btn btn-secondary btn-sm" style={{ marginRight: 6 }}
                          onClick={() => pickAttach(po.id)}
                          disabled={busy || attachBusy}
                          title="Attach a file to this PO (stored as a download; also appears in Documents tagged by PO number)">
                          {attachBusy && attachPoId === po.id ? 'Uploading...' : '+ File'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" style={{ marginRight: 6 }}
                          onClick={() => { setEditingId(po.id); setAdding(false); setError(''); }}
                          disabled={busy}>
                          Edit
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm"
                          onClick={() => handleArchive(po)} disabled={busy}>
                          Archive
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
    </div>
  );
}

// Self-contained add/edit form. Used inline for both "+ Add PO" and edit-row.
function PurchaseOrderForm({ initial, busy, onCancel, onSubmit, contractId }) {
  const init = initial || {};
  const toDateInput = (d) => {
    if (!d) return '';
    const date = new Date(d);
    if (isNaN(date)) return '';
    return date.toISOString().slice(0, 10);
  };
  const [poNumber,    setPoNumber]    = useState(init.poNumber || '');
  const [description, setDescription] = useState(init.description || '');
  const [amount,      setAmount]      = useState(init.amount ?? '');
  const [quantity,    setQuantity]    = useState(init.quantity ?? '');
  const [orderDate,   setOrderDate]   = useState(toDateInput(init.orderDate));
  const [coverageStartDate, setCoverageStartDate] = useState(toDateInput(init.coverageStartDate));
  const [coverageEndDate,   setCoverageEndDate]   = useState(toDateInput(init.coverageEndDate));
  const [notes, setNotes] = useState(init.notes || '');

  // #10: AI autofill -- upload a PO/order doc, extract fields, pre-fill the form.
  const aiRef = useRef(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiErr, setAiErr] = useState('');
  const [aiNote, setAiNote] = useState('');

  function applyProposed(p) {
    if (!p) return;
    if (p.poNumber != null && p.poNumber !== '') setPoNumber(String(p.poNumber));
    if (p.description != null && p.description !== '') setDescription(String(p.description));
    if (p.amount != null && p.amount !== '') setAmount(String(p.amount));
    if (p.quantity != null && p.quantity !== '') setQuantity(String(p.quantity));
    if (p.orderDate) setOrderDate(toDateInput(p.orderDate));
    if (p.coverageStartDate) setCoverageStartDate(toDateInput(p.coverageStartDate));
    if (p.coverageEndDate) setCoverageEndDate(toDateInput(p.coverageEndDate));
  }

  async function handleAiFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !contractId) return;
    setAiBusy(true); setAiErr(''); setAiNote('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post(`/api/contracts/${contractId}/purchase-orders/extract`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const proposed = res.data?.data?.proposed;
      applyProposed(proposed);
      setAiNote((proposed && proposed.aiNotes) ? proposed.aiNotes : 'Fields pre-filled from the file. Review before saving.');
    } catch (err) {
      const code = err?.response?.data?.error;
      setAiErr(code === 'ai_daily_cap_reached' ? 'Daily AI extraction limit reached.' : (code || 'Could not read that file.'));
    } finally {
      setAiBusy(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    if (!poNumber.trim()) return;
    onSubmit({
      poNumber:          poNumber.trim(),
      description:       description.trim() || null,
      amount:            amount === '' ? null : Number(amount),
      quantity:          quantity === '' ? null : parseInt(quantity, 10),
      orderDate:         orderDate || null,
      coverageStartDate: coverageStartDate || null,
      coverageEndDate:   coverageEndDate || null,
      notes:             notes.trim() || null,
    });
  }

  return (
    <form onSubmit={submit} style={{ background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '14px 16px', marginBottom: 16 }}>
      {contractId && (
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 12, paddingBottom: 12, borderBottom: '1px dashed var(--color-border)' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => aiRef.current && aiRef.current.click()} disabled={aiBusy || busy} title="Upload a PO or order document and let AI pre-fill these fields">
            {aiBusy ? 'Reading file...' : 'Autofill from file (AI)'}
          </button>
          <input ref={aiRef} type="file" accept=".pdf,.doc,.docx,.txt" onChange={handleAiFile} style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>PDF / Word / text. Review fields before saving.</span>
          {aiErr && <span role="alert" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-error)' }}>{aiErr}</span>}
          {!aiErr && aiNote && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{aiNote}</span>}
        </div>
      )}
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="cd-po-number">PO Number <span className="required">*</span></label>
          <input id="cd-po-number" className="form-control" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} required autoFocus placeholder="PO-2026-0042" />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="cd-description">Description</label>
          <input id="cd-description" className="form-control" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="100 seats M365 E5 + 50 EMS" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="cd-amount">Amount (USD)</label>
          <input id="cd-amount" className="form-control" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="84000" />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="cd-quantity">Quantity</label>
          <input id="cd-quantity" className="form-control" type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="100" />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label" htmlFor="cd-order-date">Order Date</label>
          <input id="cd-order-date" className="form-control" type="date" value={orderDate} onChange={(e) => setOrderDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="cd-coverage-start-date">Coverage Start</label>
          <input id="cd-coverage-start-date" className="form-control" type="date" value={coverageStartDate} onChange={(e) => setCoverageStartDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="cd-coverage-end-date">Coverage End</label>
          <input id="cd-coverage-end-date" className="form-control" type="date" value={coverageEndDate} onChange={(e) => setCoverageEndDate(e.target.value)} />
        </div>
      </div>
      <div className="form-group">
        <label className="form-label" htmlFor="cd-notes">Notes</label>
        <textarea id="cd-notes" className="form-control form-control-wide" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional internal notes about this PO (terms, delivery, etc.)" />
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !poNumber.trim()}>
          {busy ? 'Saving…' : (initial ? 'Save changes' : 'Add PO')}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// ── Documents panel ──────────────────────────────────────────────────────────
// Per UX review 2026-05-01: surface uploaded contract documents on the
// detail page itself rather than only via the "Upload Doc" button at the
// top. Lists each doc with filename, uploader, upload date, and a click-to-
// open behaviour that uses /api/documents/:id/url (handles local + S3).
function DocumentsPanel({ contract, canEdit, onUploaded }) {
  const navigate = useNavigate();
  const docs = contract.documents || [];
  // #10: map poId -> poNumber so PO-attached files can be tagged by PO number.
  const poById = {};
  (contract.purchaseOrders || []).forEach((po) => { if (po && po.id) poById[po.id] = po.poNumber; });
  const [opening, setOpening] = useState(null);
  // #11: hidden input for direct (no-AI) storage upload of ANY file type.
  const fileInputRef = useRef(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadErr, setUploadErr]   = useState('');

  async function handleAttachFile(e) {
    const file = e.target.files?.[0];
    e.target.value = '';                       // allow re-picking the same file
    if (!file) return;
    setUploadBusy(true); setUploadErr('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('contractId', contract.id);
      await api.post('/api/documents/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (onUploaded) await onUploaded();
    } catch (err) {
      setUploadErr(err?.response?.data?.error || 'Upload failed.');
    } finally {
      setUploadBusy(false);
    }
  }

  function fileIcon(fileType) {
    if (!fileType) return '📄';
    if (fileType.includes('pdf'))  return '📕';
    if (fileType.includes('word') || fileType.includes('docx') || fileType.includes('officedocument')) return '📘';
    if (fileType.startsWith('image/')) return '🖼️';
    return '📄';
  }

  async function viewDoc(docId) {
    setOpening(docId);
    try {
      const res = await api.get(`/api/documents/${docId}/url`);
      const url = res.data?.data?.url;
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      console.error('Failed to open document', e);
    } finally {
      setOpening(null);
    }
  }

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="card-title">📁 Documents</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {docs.length} file{docs.length !== 1 ? 's' : ''} attached
          </div>
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => fileInputRef.current && fileInputRef.current.click()}
              disabled={uploadBusy}
              title="Store any file on this contract (no AI extraction). Served as a download."
            >
              {uploadBusy ? 'Uploading\u2026' : '+ Attach file'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => navigate('/ingest')}
              title="Upload a contract document and extract fields with Claude AI (PDF/Word/image only)"
            >
              Extract with AI
            </button>
            <input ref={fileInputRef} type="file" onChange={handleAttachFile} style={{ display: 'none' }} aria-hidden="true" tabIndex={-1} />
          </div>
        )}
      </div>
      <div className="card-body" style={{ padding: docs.length === 0 ? undefined : '4px 0' }}>
        {uploadErr && <div role="alert" className="alert alert-error" style={{ margin: '0 0 8px' }}>{uploadErr}</div>}
        {docs.length === 0 ? (
          <div style={{ padding: '8px 4px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            No documents attached yet.
            {canEdit && <> Click <strong>+ Attach file</strong> to store any file, or <strong>Extract with AI</strong> to pull fields from a PDF/Word doc.</>}
          </div>
        ) : (
          docs.map((doc, i) => (
            <div
              key={doc.id}
              onClick={() => viewDoc(doc.id)}
              style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '10px 16px',
                cursor: 'pointer',
                borderBottom: i === docs.length - 1 ? 'none' : '1px solid var(--color-border)',
                opacity: opening === doc.id ? 0.5 : 1,
                transition: 'background 0.1s, opacity 0.15s',
              }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--color-bg)'}
              onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            >
              <span style={{ fontSize: 'var(--font-size-xl)', flexShrink: 0, lineHeight: 1 }}>{fileIcon(doc.fileType)}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {doc.filename}
                  {doc.poId && poById[doc.poId] && (
                    <span style={{ marginLeft: 6, padding: '1px 6px', fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-primary)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm, 6px)' }} title="Attached to a purchase order">
                      PO {poById[doc.poId]}
                    </span>
                  )}
                  {doc.encrypted && (
                    <span style={{ marginLeft: 6, color: 'var(--color-success)', fontSize: 'var(--font-size-xs)' }} title="Encrypted at rest">🔒</span>
                  )}
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {doc.uploader?.name ? `Uploaded by ${doc.uploader.name}` : 'Uploaded'}
                  {' · '}
                  {fmt(doc.uploadedAt)}
                </div>
              </div>
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                {opening === doc.id ? 'Opening…' : 'View →'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Compact Recent Activity panel (UX review E2) ─────────────────────────────
// Last 5 events for this contract with a "View all →" deep-link to the
// per-contract Activity Log filter. The full grouped timeline that used to
// live at the bottom of the page is now reachable from /activity?contractId=.
function RecentActivityPanel({ contractId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/contracts/${contractId}/activity`)
      .then(res => setLogs(res.data.data.logs || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [contractId]);

  const recent = logs.slice(0, 5);

  return (
    <div className="card">
      <div className="card-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="card-title">📋 Recent Activity</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {logs.length === 0 ? 'No events yet' : `Last ${recent.length} of ${logs.length} event${logs.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        {logs.length > 0 && (
          <Link
            to={`/activity?contractId=${contractId}`}
            style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none', whiteSpace: 'nowrap' }}
          >
            View all →
          </Link>
        )}
      </div>
      <div className="card-body" style={{ padding: recent.length === 0 ? undefined : '4px 0' }}>
        {loading ? (
          <div style={{ padding: '8px 4px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>
        ) : recent.length === 0 ? (
          <div style={{ padding: '8px 4px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            No activity recorded yet. Edits, status changes, and renewals appear here.
          </div>
        ) : (
          recent.map((log, i) => {
            const cfg     = ACTION_CONFIG[log.action] || { icon: '•', label: () => log.action };
            const details = log.details || {};
            return (
              <div
                key={log.id}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 10,
                  padding: '8px 16px',
                  borderBottom: i === recent.length - 1 ? 'none' : '1px solid var(--color-border)',
                }}
              >
                <span style={{ fontSize: 'var(--font-size-data)', flexShrink: 0, lineHeight: '20px' }}>{cfg.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {cfg.label(details)}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    {log.user?.name || 'System'} · <span title={new Date(log.createdAt).toLocaleString()}>{relTime(log.createdAt)}</span>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// Legacy full-timeline component, kept for reference / potential reuse but
// no longer rendered on the page. The /activity?contractId=… route now
// owns the full chronological view.
// eslint-disable-next-line no-unused-vars
function ActivityTimeline({ contractId }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/api/contracts/${contractId}/activity`)
      .then(res => setLogs(res.data.data.logs))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [contractId]);

  if (loading || logs.length === 0) return null;

  // Group logs by calendar day (logs arrive newest-first from server)
  const groups = [];
  let curDay = null;
  for (const log of logs) {
    const dayKey = new Date(log.createdAt).toDateString();
    if (dayKey !== curDay) {
      curDay = dayKey;
      groups.push({ label: dayBucket(log.createdAt), entries: [] });
    }
    groups[groups.length - 1].entries.push(log);
  }

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-header">
        <div className="card-title">📋 Activity Log</div>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          {logs.length} event{logs.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div style={{ padding: '4px 0 8px' }}>
        {groups.map((group, gi) => (
          <div key={gi}>
            {/* Day separator */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 20px 4px' }}>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
              <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em', whiteSpace: 'nowrap' }}>
                {group.label}
              </span>
              <div style={{ flex: 1, height: 1, background: 'var(--color-border)' }} />
            </div>
            {/* Events */}
            {group.entries.map((log) => {
              const cfg     = ACTION_CONFIG[log.action] || { icon: '•', label: () => log.action };
              const details = log.details || {};
              return (
                <div
                  key={log.id}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 12,
                    padding: '7px 20px',
                    borderBottom: '1px solid var(--color-border)',
                  }}
                >
                  <span style={{ fontSize: 'var(--font-size-base)', flexShrink: 0, lineHeight: '20px', marginTop: 1 }}>{cfg.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>{cfg.label(details)}</span>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginLeft: 8 }}>
                      by {log.user?.name || 'System'}
                    </span>
                  </div>
                  <span
                    title={new Date(log.createdAt).toLocaleString()}
                    style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', marginTop: 2, flexShrink: 0 }}
                  >
                    {relTime(log.createdAt)}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Contract section tabs + per-tab jump-to nav -----------------------------
// #1/#2 contract-section-refresh: replaces the prior single global "Jump to:"
// TOC. Two tabs (Contract & Finance / Renewal Prep), URL-synced via ?tab=.
// In view mode a second row shows grouped jump-to chips for the ACTIVE tab;
// clicking scrolls to that group's <section> wrapper. Edit mode shows the tab
// row only. One sticky container avoids multi-layer sticky-stacking bugs.
const GRP_SCROLL = 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 104px)';

const CONTRACT_TABS = [
  { key: 'contract', label: 'Contract & Finance' },
  { key: 'renewal',  label: 'Renewal Prep' },
];

function ContractTabsNav({ activeTab, onTabChange, groups, showChips }) {
  const [activeId, setActiveId] = useState(groups?.[0]?.id ?? null);
  const groupKey = (groups || []).map((g) => g.id).join('|');

  useEffect(() => {
    if (!showChips) return;
    const list = (groups || []).map((g) => document.getElementById(g.id)).filter(Boolean);
    if (list.length === 0) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActiveId(visible[0].target.id);
      },
      { rootMargin: '-140px 0px -60% 0px', threshold: 0 }
    );
    list.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, showChips, groupKey]);

  return (
    <div
      style={{
        position: 'sticky',
        top: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 8px)',
        zIndex: 9,
        background: 'var(--color-bg)',
        borderBottom: '1px solid var(--color-border)',
        marginBottom: 16,
        marginLeft: -24, marginRight: -24, paddingLeft: 24, paddingRight: 24,
      }}
    >
      <div role="tablist" aria-label="Contract sections" style={{ display: 'flex', gap: 4, paddingTop: 8 }}>
        {CONTRACT_TABS.map((tb) => {
          const isActive = tb.key === activeTab;
          return (
            <button
              key={tb.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onTabChange(tb.key)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                padding: '8px 14px', fontSize: 'var(--font-size-ui)',
                fontWeight: isActive ? 600 : 500,
                color: isActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                borderBottom: isActive ? '2px solid var(--color-primary)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >
              {tb.label}
            </button>
          );
        })}
      </div>
      {showChips && groups && groups.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 0, overflowX: 'auto', scrollbarWidth: 'none', paddingTop: 8, paddingBottom: 8 }}>
          <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap', marginRight: 8, flexShrink: 0 }}>
            Jump to:
          </span>
          {groups.map(({ id, label }, i) => {
            const isActive = id === activeId;
            return (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' }}>
                {i > 0 && (
                  <span aria-hidden="true" style={{ color: 'var(--color-border-strong)', padding: '0 4px', fontSize: 'var(--font-size-sm)' }}>
                    {'\u00b7'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => {
                    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    setActiveId(id);
                  }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: '4px 6px', fontSize: 'var(--font-size-sm)',
                    fontWeight: isActive ? 600 : 500,
                    color: isActive ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                    borderRadius: 4,
                  }}
                >
                  {label}
                </button>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// --- Quote Request Checklist Card --------------------------------------------
// Static companion to the AI Renewal Brief. Surfaces the four fields a reseller
// needs in a quote-request email so that a customer's outreach gets turned
// around in hours instead of days. No new endpoint, no AI cost — pulls from
// the existing contract state. The "Copy email template" button assembles a
// pre-filled message; "missing — add to contract" inline links flip the page
// into edit mode so the user can fill the gap.

function QuoteRequestChecklist({ contract, onAddMissing, onOpenVendor }) {
  const [copyState, setCopyState] = useState('idle'); // idle | copied | error

  const vendorName     = contract?.vendor?.name || '';
  const product        = contract?.product || '';
  const quantity       = contract?.quantity ?? null;
  const contractNumber = contract?.contractNumber || '';
  const customerNumber = contract?.customerNumber || '';
  const poNumber       = contract?.poNumber || '';
  const endDate        = contract?.endDate || null;
  const lastTermPo     = contract?.parentContract?.poNumber || '';

  // v0.6.x: recipient candidates. Pulled from vendor.contacts (sorted by
  // lastContactedAt desc on the server) plus vendor.supportEmail. Default
  // selection is the first contact with an email (i.e. the most-recently-
  // contacted one); user can flip to a different contact or to the generic
  // support address via the picker if multiple are on file.
  const supportEmail   = contract?.vendor?.supportEmail || '';
  const vendorContacts = (contract?.vendor?.contacts || []).filter(c => c.email && c.email.trim());
  const recipientOptions = [
    ...vendorContacts.map(c => ({
      id:    `contact:${c.id}`,
      label: c.name + (c.title ? ` · ${c.title}` : ''),
      email: c.email.trim(),
      name:  c.name,
    })),
    ...(supportEmail ? [{
      id:    'support',
      label: `${vendorName || 'Vendor'} support`,
      email: supportEmail,
      name:  `${vendorName || 'Vendor'} support`,
    }] : []),
  ];
  const [recipientId, setRecipientId] = useState(() => recipientOptions[0]?.id || '');
  const recipient = recipientOptions.find(o => o.id === recipientId) || recipientOptions[0] || null;

  const fields = [
    {
      key:    'identifier',
      label:  'Contract / agreement number',
      value:  contractNumber,
      altKey: 'customerNumber',
      altLabel: 'Customer number',
      altValue: customerNumber,
    },
    { key: 'product',  label: 'Product name',         value: product },
    { key: 'quantity', label: 'Quantity',             value: quantity != null ? String(quantity) : '' },
    { key: 'poNumber', label: 'Current term PO',      value: poNumber },
  ];

  // Renewal-chain awareness: only surface the prior-term PO when this contract
  // is a renewal AND the prior term recorded its own PO. The whole point of
  // this row is "if you're buying through the same vendor as last year, this
  // anchors them back to the right order".
  const showLastTermPo = !!contract?.parentContract && !!lastTermPo;

  const subjectLine = `Quote request: ${product || '<product>'} renewal${vendorName ? ` — ${vendorName}` : ''}`;
  const idLine      = contractNumber
    ? `Contract / agreement number: ${contractNumber}`
    : (customerNumber ? `Customer number: ${customerNumber}` : 'Contract / agreement number: <missing — add before sending>');
  const qtyLine     = (quantity != null) ? `Quantity: ${quantity}` : 'Quantity: <missing — add before sending>';
  const productLine = product   ? `Product: ${product}` : 'Product: <missing — add before sending>';
  const endLine     = endDate
    ? `Current term end: ${new Date(endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  const priorPoLine = showLastTermPo
    ? `Prior-term PO (for reference / order anchoring): ${lastTermPo}`
    : '';

  const emailBody = [
    `Hi${vendorName ? ` ${vendorName} team` : ''},`,
    '',
    `Could you put together a renewal quote for the following? I've included the contract details and previous order information up front so it's easy to tie back to our existing records.`,
    '',
    idLine,
    productLine,
    qtyLine,
    endLine,
    priorPoLine,
  ].filter(Boolean).concat([
    '',
    'Happy to jump on a call if any of this is unclear. Thanks!',
  ]).join('\n');

  // v0.6.x: prepend To: when we have a recipient. Format `Name <email>` so it
  // pastes cleanly into Gmail, Outlook, and most mail clients' compose fields.
  const toLine = recipient ? `To: ${recipient.name} <${recipient.email}>\n` : '';
  const fullEmail = `${toLine}Subject: ${subjectLine}\n\n${emailBody}`;

  async function copyEmail() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(fullEmail);
      } else {
        // Fallback for older browsers / non-secure contexts
        const ta = document.createElement('textarea');
        ta.value = fullEmail;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch (err) {
      console.error('Clipboard write failed:', err);
      setCopyState('error');
      setTimeout(() => setCopyState('idle'), 2500);
    }
  }

  function MissingLink() {
    if (typeof onAddMissing !== 'function') return null;
    return (
      <a
        href="#"
        onClick={(e) => { e.preventDefault(); onAddMissing(); }}
        style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none' }}
      >
        missing — add to contract
      </a>
    );
  }

  return (
    <div className="card mb-16">
      <div className="card-header">
        <div className="card-title">📋 Quote Request Checklist</div>
        <button
          className={`btn btn-sm ${copyState === 'copied' ? 'btn-success' : 'btn-secondary'}`}
          onClick={copyEmail}
          title="Copy a pre-filled quote-request email to your clipboard"
        >
          {copyState === 'copied' ? '✓ Copied' : copyState === 'error' ? 'Copy failed' : 'Copy Email Template'}
        </button>
      </div>
      <div className="card-body">
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 0, marginBottom: 12 }}>
          Including these in your reseller outreach gets quotes back in hours instead of days.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* v0.6.x: quote recipient row — shows the auto-resolved To: address
              (most recently contacted vendor rep, falling back to support email).
              When multiple contacts are on file, surface a dropdown so the user
              can flip without leaving the page. */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '180px 1fr auto',
              alignItems: 'baseline',
              gap: 12,
              padding: '6px 0',
              borderBottom: '1px solid var(--color-border)',
              fontSize: 'var(--font-size-ui)',
            }}
          >
            <span style={{ color: 'var(--color-text-secondary)' }}>Quote recipient</span>
            <span>
              {recipientOptions.length === 0 && (
                <em style={{ color: 'var(--color-text-secondary)' }}>—</em>
              )}
              {recipientOptions.length === 1 && recipient && (
                <span className="font-mono" style={{ color: 'var(--color-text)' }}>
                  {recipient.name} &lt;{recipient.email}&gt;
                </span>
              )}
              {recipientOptions.length > 1 && (
                <select
                  aria-label="Email recipient"
                  value={recipientId}
                  onChange={(e) => setRecipientId(e.target.value)}
                  style={{
                    fontSize: 'var(--font-size-ui)',
                    padding: '4px 8px',
                    border: '1px solid var(--color-border-strong)',
                    borderRadius: 'var(--radius)',
                    background: 'var(--color-surface)',
                    color: 'var(--color-text)',
                    maxWidth: '100%',
                  }}
                >
                  {recipientOptions.map(o => (
                    <option key={o.id} value={o.id}>
                      {o.label} — {o.email}
                    </option>
                  ))}
                </select>
              )}
            </span>
            <span>
              {recipientOptions.length === 0 && typeof onOpenVendor === 'function' && contract?.vendor?.id && (
                <a
                  href={`/vendors/${contract.vendor.id}`}
                  onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); onOpenVendor(contract.vendor.id); }}
                  style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-primary)', textDecoration: 'none' }}
                >
                  add vendor contact
                </a>
              )}
            </span>
          </div>
          {fields.map((f) => {
            const hasValue    = !!f.value;
            const hasAltValue = !!f.altValue;
            return (
              <div
                key={f.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '180px 1fr auto',
                  alignItems: 'baseline',
                  gap: 12,
                  padding: '6px 0',
                  borderBottom: '1px solid var(--color-border)',
                  fontSize: 'var(--font-size-ui)',
                }}
              >
                <span style={{ color: 'var(--color-text-secondary)' }}>{f.label}</span>
                <span className={hasValue ? 'font-mono' : ''} style={{ color: hasValue ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
                  {hasValue
                    ? f.value
                    : hasAltValue
                      ? <><span style={{ color: 'var(--color-text-secondary)' }}>{f.altLabel}: </span><span className="font-mono" style={{ color: 'var(--color-text)' }}>{f.altValue}</span></>
                      : <em>—</em>}
                </span>
                <span>{!hasValue && !hasAltValue && <MissingLink />}</span>
              </div>
            );
          })}
          {showLastTermPo && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '180px 1fr auto',
                alignItems: 'baseline',
                gap: 12,
                padding: '6px 0',
                fontSize: 'var(--font-size-ui)',
              }}
            >
              <span style={{ color: 'var(--color-text-secondary)' }}>Last term PO</span>
              <span>
                <span className="font-mono" style={{ color: 'var(--color-text)' }}>{lastTermPo}</span>
                <span style={{ color: 'var(--color-text-secondary)', marginLeft: 8, fontSize: 'var(--font-size-sm)' }}>
                  (used to anchor the prior order)
                </span>
              </span>
              <span />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ContractDetail() {
  useDocumentTitle('Contract');
  const location = useLocation();
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // #1 contract-section-refresh: URL-synced active tab (?tab=). Unknown -> Tab 1.
  // Coexists with existing params (e.g. ?imported=1) - we mutate only the tab key.
  const activeTab = searchParams.get('tab') === 'renewal' ? 'renewal' : 'contract';
  const setActiveTab = (t) => {
    const next = new URLSearchParams(searchParams);
    if (t === 'renewal') next.set('tab', 'renewal'); else next.delete('tab');
    setSearchParams(next, { replace: true });
  };
  const { user, features, demoMode } = useAuth();
  const { requestConsent } = useAiConsent();
  const confirm = useConfirm();
  const canEdit = features.contracts_write;
  const canEditFinancials = user?.role === 'admin';
  const isAdmin = user?.role === 'admin';
  const justImported = searchParams.get('imported') === '1';

  // v0.54.2 — measure the urgency-stripe header card's actual height and
  // expose it as a CSS custom property so the SectionJumpNav (also sticky)
  // can dock right below it. Without this the jump nav slid UP THROUGH the
  // header (both stuck to top: 0 with different z-index) which read as a
  // visual bug. Now it reads as an intentional two-tier nav while
  // scrolling: header → jump nav → content.
  const headerCardRef = useRef(null);
  // v0.92.x: measure via a REF CALLBACK (not a mount-only effect) so it runs when
  // the header card actually mounts. The contract loads async, so useEffect([])
  // fired before the card existed -> --contract-header-height stayed unset, fell
  // back to 96px, and the sticky tabs slid UNDER the (taller, ~138px) header.
  const headerRoRef = useRef(null);
  const measureHeaderCard = useCallback((el) => {
    headerCardRef.current = el;
    if (headerRoRef.current) { headerRoRef.current.disconnect(); headerRoRef.current = null; }
    if (!el) { document.documentElement.style.removeProperty('--contract-header-height'); return; }
    const update = () => {
      const h = Math.round(el.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--contract-header-height', `${h}px`);
    };
    update();
    if (typeof ResizeObserver !== 'undefined') {
      headerRoRef.current = new ResizeObserver(update);
      headerRoRef.current.observe(el);
    }
  }, []);

  const [contract, setContract] = useState(null);
  const [vendors, setVendors] = useState([]);
  const [members, setMembers] = useState([]);
  // v0.4.1 (#9): categories list for the picker in the edit form. Phase 1-3
  // added the picker on NewContract but didn't wire it into the
  // ContractDetail edit flow — the only way to change a contract's
  // category was through Settings → Categories which is the wrong place.
  const [categories, setCategories] = useState([]);

  // #4 contract-section-refresh: navigate from a contract to one of its
  // vendors in-app, carrying origin context so the vendor page can offer a
  // "Back to [contract]" round-trip (exact contract + tab + section + scroll).
  const goToVendor = (vendorId) => {
    if (!vendorId) return;
    const title = contract?.vendor?.name
      ? contract.vendor.name + ' \u2014 ' + contract.product
      : (contract?.product || 'contract');
    const origin = buildContractOrigin(title);
    rememberContractOrigin(origin);
    navigate(`/vendors/${vendorId}`, { state: { contractOrigin: origin } });
  };

  // #4: when we return here from a vendor page, restore the scroll position the
  // user left from (router state carries the saved scrollY). Fires once the
  // contract has loaded so the page is at full height; the one-shot ref guards
  // against re-running on later re-renders.
  const scrollRestoredRef = useRef(false);
  useEffect(() => {
    if (!contract || scrollRestoredRef.current) return;
    const y = location.state?.restoreScroll;
    if (typeof y === 'number') {
      scrollRestoredRef.current = true;
      requestAnimationFrame(() => window.scrollTo(0, y));
    }
  }, [contract]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // #7: global Edit mode removed; per-card editing uses editingCard.
  const canAssignOwner = ['admin', 'manager'].includes(user?.role);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [form, setForm] = useState({});
  // #7 contract-section-refresh: key of the single card currently in inline
  // edit mode (null = none). Replaces the all-or-nothing global Edit toggle.
  const [editingCard, setEditingCard] = useState(null);
  // #12: License Keys & Access card state (separate from editingCard; manages
  // its own reveal + dual-resource save to /api/contracts and /vendor-portal).
  const [lkEditing, setLkEditing] = useState(false);
  const [lkDraft, setLkDraft] = useState('');
  const [lkPortalDraft, setLkPortalDraft] = useState('');
  const [lkSaving, setLkSaving] = useState(false);
  const [lkError, setLkError] = useState('');
  const [lkRevealed, setLkRevealed] = useState(null); // null=masked, string=plaintext
  const [lkRevealing, setLkRevealing] = useState(false);
  const [lkRevealError, setLkRevealError] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [tagSaving, setTagSaving] = useState(false);
  // Phase 4 v0.4.0: brief now holds structured sections + drift metadata.
  // { text, generatedAt, sections, sectionsParsed, categorySlug, templateVersion, currentCategorySlug, searchEnrichment }
  const [brief, setBrief] = useState(null);
  const [briefLoading, setBriefLoading] = useState(false);
  // H3-4 (v0.76.4): AbortController for cancellable brief generation
  const [briefAbortController, setBriefAbortController] = useState(null);
  const [briefError, setBriefError] = useState('');
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState('');
  // Custom fields edit state. Hydrated from contract.customFieldValues by
  // CustomFieldInputs the first time it sees the data after fetch.
  const [customFields, setCustomFields] = useState({});
  const setCustom = (key, val) => setCustomFields(prev => ({ ...prev, [key]: val }));
  const [m365Overlap, setM365Overlap] = useState(null);
  // #19: fetch the Microsoft 365 license-overlap callout payload for this
  // contract. Fails soft (null) so a 404/500 never blocks the page.
  useEffect(() => {
    let cancelled = false;
    setM365Overlap(null);
    api.get(`/api/contracts/${id}/m365-overlap`)
      .then((r) => { if (!cancelled) setM365Overlap(r?.data?.data?.overlap || null); })
      .catch(() => { if (!cancelled) setM365Overlap(null); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    const calls = [
      api.get(`/api/contracts/${id}`),
      api.get('/api/vendors'),
      canAssignOwner ? api.get('/api/users/members') : Promise.resolve(null),
      api.get('/api/categories'), // v0.4.1 (#9): for the edit-form picker
    ];
    Promise.all(calls)
      .then(([cRes, vRes, mRes, catRes]) => {
        const c = cRes.data.data.contract;
        setContract(c);
        setVendors(vRes.data.data.vendors);
        if (mRes) setMembers(mRes.data.data.users);
        // v0.4.1 (#9): non-archived categories for the edit picker
        const cats = (catRes?.data?.data?.categories || []).filter((c2) => !c2.archivedAt);
        setCategories(cats);
        if (c.renewalBrief) {
          // Phase 4: hydrate from the cached brief endpoint (it parses
          // sections + returns drift metadata). The endpoint's cached
          // return path is free — no LLM call, no consent gate, no
          // quota burn. (Consent gate sits AFTER the cached return.)
          api.post(`/api/contracts/${c.id}/brief`)
            .then((br) => {
              const d = br.data?.data || {};
              setBrief({
                text:                d.brief,
                generatedAt:         d.generatedAt,
                sections:            d.sections,
                sectionsParsed:      d.sectionsParsed,
                categorySlug:        d.categorySlug,
                templateVersion:     d.templateVersion,
                currentCategorySlug: d.currentCategorySlug,
                searchEnrichment:    d.searchEnrichment,
                sourcesUsed:         d.sourcesUsed,
                // Pass 6 P0-D-01: server has been returning these since
                // v0.36.0 but the SPA dropped them on the floor. Carry
                // them through so the renderer below can iterate.
                optInSections:       d.optInSections || {},
                enabledOptInSlugs:   Array.isArray(d.enabledOptInSlugs) ? d.enabledOptInSlugs : [],
              });
            })
            .catch((err) => {
              // Roadmap §6.5: feature off = feature unavailable, INCLUDING
              // cached view. When the per-account toggle (or the env-level
              // AI_ENABLED kill switch) is off, render nothing — do NOT
              // fall back to the stored row text. v0.4.0.1 fix.
              const code = err?.response?.data?.error;
              if (code === 'ai_brief_disabled_for_account'
                  || code === 'AI features are disabled on this instance') {
                setBrief(null);
                return;
              }
              // Other errors (network, transient 5xx) — still show the
              // cached text so the user keeps access to what they already
              // generated.
              setBrief({ text: c.renewalBrief, generatedAt: c.renewalBriefGeneratedAt });
            });
        }
      })
      .catch(() => setError('Failed to load contract.'))
      .finally(() => setLoading(false));
  }, [id, canAssignOwner]);

  const [exportingContract, setExportingContract] = useState(false);
  async function handleExportContract() {
    if (exportingContract) return;
    setExportingContract(true);
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const url = `${base}/api/export/contracts?ids=${encodeURIComponent(id)}`;
      const raw = `${contract?.vendor?.name ? contract.vendor.name + '-' : ''}${contract?.product || 'contract'}`;
      const safe = raw.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'contract';
      await downloadAuthedFile(url, `${safe}-${new Date().toISOString().split('T')[0]}.xlsx`);
    } catch (e) {
      setStatusError(e.message || 'Export failed.');
    } finally {
      setExportingContract(false);
    }
  }

  const generateBrief = async (refresh = false) => {
    // Phase 4: gate behind per-session AI consent modal. If the user has
    // already acknowledged this session (or has aiConsentSilenced=true),
    // the action runs immediately. Otherwise the modal opens and the
    // action runs after they click "I understand".
    requestConsent(async () => {
      const ac = new AbortController();
      setBriefAbortController(ac);
      setBriefLoading(true);
      setBriefError('');
      try {
        const res = await api.post(`/api/contracts/${id}/brief${refresh ? '?refresh=1' : ''}`, undefined, { signal: ac.signal });
        const d = res.data.data;
        setBrief({
          text:                d.brief,
          generatedAt:         d.generatedAt,
          sections:            d.sections,
          sectionsParsed:      d.sectionsParsed,
          categorySlug:        d.categorySlug,
          templateVersion:     d.templateVersion,
          currentCategorySlug: d.currentCategorySlug,
          searchEnrichment:    d.searchEnrichment,
          sourcesUsed:         d.sourcesUsed,
          // Pass 6 P0-D-01: see the matching cached-hydration setBrief
          // upstream — server returns these, we now actually use them.
          optInSections:       d.optInSections || {},
          enabledOptInSlugs:   Array.isArray(d.enabledOptInSlugs) ? d.enabledOptInSlugs : [],
        });
      } catch (err) {
        // Server-side ai_consent_required 403 should not normally fire (the
        // client gates upstream), but surface a friendly message just in
        // case the timestamps disagree somehow.
        const errCode = err.response?.data?.error;
        if (errCode === 'ai_consent_required') {
          setBriefError('AI consent is required before generating a brief. Please try again.');
        } else if (errCode === 'ai_brief_disabled_for_account') {
          setBriefError('AI renewal brief is disabled for your account. An admin can enable it in Settings → AI & Extraction.');
        } else {
          setBriefError(err.response?.data?.error || 'Failed to generate brief.');
        }
      } finally {
        setBriefLoading(false);
        setBriefAbortController(null);
      }
    });
  };

  // #7: build the edit-draft from the live contract. Shared by the per-card
  // inline editors (openCardEdit) and the legacy global edit (startEdit).
  const buildEditForm = () => ({
      vendorId: contract.vendorId,
      categoryId: contract.categoryId || '', // v0.4.1 (#9): editable category
      contractNumber: contract.contractNumber || '',
      customerNumber: contract.customerNumber || '',
      product: contract.product,
      quantity: contract.quantity ?? '',
      costPerLicense: contract.costPerLicense ?? '',
      startDate: contract.startDate ? contract.startDate.split('T')[0] : '',
      endDate: contract.endDate ? contract.endDate.split('T')[0] : '',
      autoRenewal: contract.autoRenewal,
      autoRenewalNoticeDays: contract.autoRenewalNoticeDays ?? '',
      poNumber: contract.poNumber || '',
      invoiceNumber: contract.invoiceNumber || '',
      requestor: contract.requestor || '',
      // v0.5.14: '__OTHER__' UI sentinel when free-text fields are populated
      // and the User reference is null. The submit handler converts back to ''.
      internalOwnerId: contract.internalOwnerId || (contract.internalOwnerName ? '__OTHER__' : ''),
      internalOwnerName:  contract.internalOwnerName  || '',
      internalOwnerEmail: contract.internalOwnerEmail || '',
      deliveryEmail: contract.deliveryEmail || '',
      department: contract.department || '',
      team: contract.team || '',
      costCenter: contract.costCenter || '',
      glCode: contract.glCode || '',
      endUserName: contract.endUserName || '',
      endUserEmail: contract.endUserEmail || '',
      deliveryMethod: contract.deliveryMethod || '',
      licenseKeys: contract.licenseKeys || '',
      notes: contract.notes || '',
      status: contract.status,
      resellerName: contract.resellerName || '',
      resellerAccountNumber: contract.resellerAccountNumber || '',
      resellerContactName: contract.resellerContactName || '',
      resellerContactEmail: contract.resellerContactEmail || '',
      originalAsk: contract.originalAsk ?? '',
      finalNegotiatedPrice: contract.finalNegotiatedPrice ?? '',
      savingsLever: contract.savingsLever || '',
      negotiationLog: contract.negotiationLog || '',
      seatsLicensed: contract.seatsLicensed ?? '',
      seatsActivelyInUse: contract.seatsActivelyInUse ?? '',
      annualUpliftPercent: contract.annualUpliftPercent ?? '',
      coTermGroup: contract.coTermGroup || '',
      signatureStatus: contract.signatureStatus || '',
      signedAt: contract.signedAt ? contract.signedAt.split('T')[0] : '',
      signerName: contract.signerName || '',
      leaseStart: contract.leaseStart ? contract.leaseStart.split('T')[0] : '',
      leaseEnd: contract.leaseEnd ? contract.leaseEnd.split('T')[0] : '',
      leaseType: contract.leaseType || '',
      leaseBuyout: contract.leaseBuyout ?? '',
    });


  // #7 contract-section-refresh: open one card for inline editing.
  const openCardEdit = (cardKey) => { setForm(buildEditForm()); setEditingCard(cardKey); setSaveError(''); setCustomFields({}); };

  const closeCardEdit = () => { setEditingCard(null); setSaveError(''); };


  const setF = (key, val) => setForm((prev) => ({ ...prev, [key]: val }));

  // #11: refetch the contract so a freshly attached document shows in the panel.
  const refreshContract = async () => {
    try {
      const res = await api.get(`/api/contracts/${id}`);
      setContract(res.data.data.contract);
    } catch (e) { /* non-fatal */ }
  };


  // #7 contract-section-refresh: persist only the named fields for one card,
  // then refetch. Partial PUTs already work (see handleAssignToMe /
  // handleQuickStatusChange). Pass '__customFields__' to include the
  // CustomFieldInputs draft.
  const saveCard = async (keys) => {
    setSaving(true);
    setSaveError('');
    try {
      const payload = {};
      for (const k of keys) {
        if (k === '__customFields__') continue;
        payload[k] = form[k];
      }
      if (payload.internalOwnerId === '__OTHER__') payload.internalOwnerId = '';
      if (keys.includes('__customFields__')) payload.customFields = customFields;
      await api.put(`/api/contracts/${id}`, payload);
      const res = await api.get(`/api/contracts/${id}`);
      setContract(res.data.data.contract);
      setEditingCard(null);
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  // #8: persist a single field inline (seat counts), then refetch so all cards reflect it.
  const saveField = async (patch) => {
    await api.put(`/api/contracts/${id}`, patch);
    const res = await api.get(`/api/contracts/${id}`);
    setContract(res.data.data.contract);
  };

  // #12: License Keys & Access handlers.
  const lkOpenEdit = () => { setLkDraft(''); setLkPortalDraft((contract.vendor && contract.vendor.portalUrl) || ''); setLkError(''); setLkEditing(true); };
  const lkCancel = () => { setLkEditing(false); setLkError(''); };
  const lkHide = () => setLkRevealed(null);
  const lkReveal = async () => {
    setLkRevealing(true); setLkRevealError('');
    try {
      const res = await api.post(`/api/contracts/${id}/license-keys/reveal`);
      setLkRevealed(res.data.data.licenseKeys || '');
    } catch (err) {
      setLkRevealError(err.response?.data?.error || 'Unable to reveal license keys.');
    } finally { setLkRevealing(false); }
  };
  const lkSave = async () => {
    setLkSaving(true); setLkError('');
    try {
      if (lkDraft.trim() !== '') {
        await api.put(`/api/contracts/${id}`, { licenseKeys: lkDraft });
      }
      const cur = ((contract.vendor && contract.vendor.portalUrl) || '').trim();
      if (lkPortalDraft.trim() !== cur) {
        await api.put(`/api/contracts/${id}/vendor-portal`, { portalUrl: lkPortalDraft.trim() });
      }
      const res = await api.get(`/api/contracts/${id}`);
      setContract(res.data.data.contract);
      setLkRevealed(null);
      setLkEditing(false);
    } catch (err) {
      setLkError(err.response?.data?.error || 'Save failed.');
    } finally { setLkSaving(false); }
  };

  const handleAddTag = async (e) => {
    e.preventDefault();
    const tag = tagInput.trim().toLowerCase();
    if (!tag) return;
    setTagSaving(true);
    try {
      const res = await api.post(`/api/contracts/${id}/tags`, { tag });
      setContract(prev => ({ ...prev, tags: res.data.data.tags }));
      setTagInput('');
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to add tag.');
    } finally {
      setTagSaving(false);
    }
  };

  const handleRemoveTag = async (tag) => {
    try {
      const res = await api.delete(`/api/contracts/${id}/tags/${encodeURIComponent(tag)}`);
      setContract(prev => ({ ...prev, tags: res.data.data.tags }));
    } catch (err) {
      setSaveError('Failed to remove tag.');
    }
  };

  const handleRenew = async () => {
    if (!await confirm({
      title: 'Create renewal contract',
      message: 'Create a renewal contract? This will clone this contract into a new active record and mark this one as Renewed. You can edit the dates and pricing on the new contract.',
      confirmLabel: 'Create renewal',
    })) return;
    try {
      const res = await api.post(`/api/contracts/${id}/renew`);
      navigate(`/contracts/${res.data.data.contractId}?imported=1`);
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to create renewal.');
    }
  };

  const handleAssignToMe = async () => {
    if (contract.internalOwnerId === user?.id) return;
    setStatusSaving(true);
    setStatusError('');
    try {
      const res = await api.put(`/api/contracts/${id}`, { internalOwnerId: user.id });
      setContract(res.data.data.contract);
    } catch (err) {
      setStatusError(err.response?.data?.error || 'Failed to assign contract.');
    } finally {
      setStatusSaving(false);
    }
  };

  const handleQuickStatusChange = async (newStatus) => {
    if (newStatus === contract.status) return;
    setStatusSaving(true);
    setStatusError('');
    try {
      const res = await api.put(`/api/contracts/${id}`, { status: newStatus });
      setContract(res.data.data.contract);
    } catch (err) {
      setStatusError(err.response?.data?.error || 'Failed to update status.');
    } finally {
      setStatusSaving(false);
    }
  };

  const handleCancel = async () => {
    if (!await confirm({
      title: 'Cancel contract',
      message: 'Cancel this contract? This sets the status to Cancelled. Contract data is preserved and can be restored by an admin.',
      confirmLabel: 'Cancel contract',
      cancelLabel: 'Keep contract',
      danger: true,
    })) return;
    try {
      await api.delete(`/api/contracts/${id}`);
      navigate('/contracts');
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to cancel contract.');
    }
  };

  const handleArchive = async () => {
    const isArchived = !!contract.archivedAt;
    const msg = isArchived
      ? 'Restore this contract to the active list?'
      : 'Archive this contract? It will move to the Archive view and no longer appear in the active contracts list.';
    if (!await confirm({
      title: isArchived ? 'Restore contract' : 'Archive contract',
      message: msg,
      confirmLabel: isArchived ? 'Restore' : 'Archive',
      danger: !isArchived,
    })) return;
    try {
      await api.patch(`/api/contracts/${id}/archive`, { archived: !isArchived });
      if (!isArchived) {
        navigate('/contracts');
      } else {
        const res = await api.get(`/api/contracts/${id}`);
        setContract(res.data.data.contract);
      }
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Failed to archive contract.');
    }
  };

  if (loading) return <div className="loading">Loading contract…</div>;
  /* 2026-05-10 review M4 fix: when the load fails (bad id, deleted contract,
     scope-out-of-range), give the user a clear way back to the list. The
     previous bare error banner left them stranded on a blank page. */
  if (error) return (
    <div className="page-body">
      <div style={{ marginBottom: 12 }}>
        <button onClick={() => navigate('/contracts')} style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', textDecoration: 'none', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>
          ← All Contracts
        </button>
      </div>
      <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>
      <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
        This contract may have been deleted, archived, or never existed. Use
        the link above to return to the contracts list.
      </div>
    </div>
  );
  if (!contract) return null;

  // #1/#2 contract-section-refresh: per-tab jump-to group presence.
  const _daysToEnd = daysUntil(contract.endDate);
  const hasWorkflow = (contract.status === 'under_review' || (_daysToEnd != null && _daysToEnd <= 90))
    && contract.status !== 'renewed' && contract.status !== 'cancelled';
  const aiEnabled = !!features.renewal_brief && !!user?.account?.aiBriefEnabled && !['renewed', 'cancelled', 'expired'].includes(contract?.status);
  const hasRenewalSavings = contract.originalAsk != null || contract.finalNegotiatedPrice != null || !!contract.signatureStatus;
  const hasNegotiation = !!contract.negotiationLog || canEdit;
  const hasClose = hasNegotiation || (aiEnabled && !!brief) || hasRenewalSavings;
  const tab1Groups = [
    { id: 'cd-grp-keydates', label: 'Key Dates' },
    { id: 'cd-grp-finance',  label: 'Finance' },
    { id: 'cd-grp-delivery', label: 'Delivery & Assignment' },
    { id: 'cd-grp-records',  label: 'Records' },
  ];
  const tab2Groups = [
    ...(hasWorkflow ? [{ id: 'cd-grp-workflow', label: 'Workflow' }] : []),
    { id: 'cd-grp-planning', label: 'Planning' },
    { id: 'cd-grp-quotes',   label: 'Quotes' },
    ...(aiEnabled ? [{ id: 'cd-grp-aibrief', label: 'AI Brief' }] : []),
    ...(hasClose ? [{ id: 'cd-grp-close', label: 'Negotiation & Close' }] : []),
  ];
  const activeGroups = activeTab === 'renewal' ? tab2Groups : tab1Groups;

  // #8: category-aware label for the merged quantity/seats value.
  const seatsLabel = contract?.category?.slug === 'saas' ? 'Seats Licensed' : 'Quantity';
  const totalValue = contract.costPerLicense && contract.quantity
    ? parseFloat(contract.costPerLicense) * parseInt(contract.quantity)
    : null;

  return (
    <>
      {/* v0.54 Header — see contract-detail-card with urgency stripe */}
      {/* v0.54 — Contract detail header (P3 urgency-stripe).
          Replaces the prior 6-button flex header.
            - Left stripe color reflects renewal urgency (calm / evaluate / urgent).
            - Status pill becomes a colored dot + text inline with the meta row.
            - Inline meta row uses mid-dot separators (vendor · # · category · urgency phrase).
            - Action row: 4-icon cluster (Upload / Assign / Archive / Cancel) + Edit + Renew.
          Helpers (urgencyState, urgencyPhrase, STATUS_DOT, ICON_CLUSTER_*) live at
          module scope alongside daysUntil. */}
      <div ref={measureHeaderCard} className={`contract-detail-card urgency-${urgencyState(contract)}`}>
        <button
          onClick={() => {
            const stateFrom = location.state?.from;
            let stored = null;
            try { stored = sessionStorage.getItem('lapseiq_last_contracts_url'); } catch (e) {}
            let target = stateFrom || stored;
            // #11: an archived contract returns to the archived list, not the
            // active one (the stored last-contracts-url points at active /contracts).
            if (contract.archivedAt && (!target || (target.startsWith('/contracts') && !target.startsWith('/contracts/archived')))) {
              target = '/contracts/archived';
            }
            if (target && target.startsWith('/contracts')) navigate(target);
            else navigate(-1);
          }}
          className="back-link"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, marginBottom: 8 }}
        >
          {(() => {
            const stateFrom = location.state?.from;
            let stored = null;
            try { stored = sessionStorage.getItem('lapseiq_last_contracts_url'); } catch (e) {}
            let target = stateFrom || stored || '';
            if (contract.archivedAt && (!target || (target.startsWith('/contracts') && !target.startsWith('/contracts/archived')))) {
              target = '/contracts/archived';
            }
            if (target.startsWith('/contracts/archived')) return '\u2190 Archived Contracts';
            const hasFilters = /[?&](f_|search=|status=|renewal=|vendorId=|endMonth=|ownerId=|categoryId=|hasPO=|evaluateBy=|view=)/.test(target);
            return hasFilters ? '← Filtered Contracts' : '← Contracts';
          })()}
        </button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 0, flex: 1 }}>{editingCard === 'details' ? (<div style={{ width: '100%' }}>
              <div className="form-row form-row-2">
                <div className="form-group">
                  <label className="form-label" htmlFor="cdc-product">Product</label>
                  <input id="cdc-product" className="form-control" value={form.product} onChange={(e) => setF('product', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="cdc-vendor">Vendor</label>
                  <select id="cdc-vendor" className="form-control" value={form.vendorId} onChange={(e) => setF('vendorId', e.target.value)}>
                    {vendors.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-row form-row-2">
                {categories.length > 0 && (
                  <div className="form-group">
                    <label className="form-label" htmlFor="cdc-category">Category</label>
                    <select id="cdc-category" className="form-control" value={form.categoryId || ''} onChange={(e) => setF('categoryId', e.target.value)}>
                      {categories.map((c) => (<option key={c.id} value={c.id}>{c.icon ? `${c.icon} ${c.name}` : c.name}</option>))}
                    </select>
                  </div>
                )}
                <div className="form-group">
                  <label className="form-label" htmlFor="cdc-contract-number">Contract #</label>
                  <input id="cdc-contract-number" className="form-control" value={form.contractNumber} onChange={(e) => setF('contractNumber', e.target.value)} />
                </div>
              </div>
              <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['product','vendorId','categoryId','contractNumber'])} />
            </div>) : (<>
            <h1 className="page-title" style={{ fontSize: 'var(--font-size-xl)', fontWeight: 500, color: 'var(--color-text)', lineHeight: 1.15, margin: 0 }}>{contract.vendor?.name ? (<><a href={`/vendors/${contract.vendor.id}`} onClick={(e) => { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; e.preventDefault(); goToVendor(contract.vendor.id); }} style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px dotted var(--color-border-strong)' }} title={`View ${contract.vendor.name}`}>{contract.vendor.name}</a>{' \u2014 ' + contract.product}</>) : contract.product}</h1>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('details')} label='Details'/>}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 8, flexWrap: 'wrap', fontSize: 'var(--font-size-ui)' }}>
              {canEdit ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_DOT[contract.status]?.color || 'var(--color-text-muted)', display: 'inline-block' }} />
                  <select
                    aria-label="Change contract status"
                    value={contract.status}
                    onChange={(e) => handleQuickStatusChange(e.target.value)}
                    disabled={statusSaving}
                    title="Change status"
                    style={{
                      fontSize: 'var(--font-size-ui)',
                      padding: '2px 18px 2px 6px',
                      borderRadius: 'var(--radius)',
                      border: '1px solid transparent',
                      background: 'transparent',
                      color: STATUS_DOT[contract.status]?.color || 'var(--color-text)',
                      cursor: statusSaving ? 'wait' : 'pointer',
                      opacity: statusSaving ? 0.6 : 1,
                      fontWeight: 500,
                      appearance: 'none',
                    }}
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s} style={{ color: 'var(--color-text)', background: 'var(--color-surface)' }}>{STATUS_DOT[s]?.label || s.replace('_', ' ')}</option>
                    ))}
                  </select>
                </span>
              ) : (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: STATUS_DOT[contract.status]?.color || 'var(--color-text)', fontWeight: 500 }}>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: STATUS_DOT[contract.status]?.color || 'var(--color-text-muted)', display: 'inline-block' }} />
                  {STATUS_DOT[contract.status]?.label || contract.status}
                </span>
              )}
              {statusSaving && (
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Saving…</span>
              )}
              {/* #5: vendor now shown in the title */}
              {contract.contractNumber && (
                <>
                  <span style={{ color: 'var(--color-border-strong)' }}>·</span>
                  <span style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)' }}>{contract.contractNumber}</span>
                </>
              )}
              {contract.category && (
                <>
                  <span style={{ color: 'var(--color-border-strong)' }}>·</span>
                  <span
                    title={`Category: ${contract.category.name}`}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--color-text-secondary)' }}
                  >
                    {contract.category.icon && <span>{contract.category.icon}</span>}
                    <span>{contract.category.name}</span>
                  </span>
                </>
              )}
              {(() => {
                const phrase = urgencyPhrase(contract);
                if (!phrase) return null;
                const PhraseIcon = phrase.Icon;
                return (
                  <>
                    <span style={{ color: 'var(--color-border-strong)' }}>·</span>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: phrase.color, fontWeight: 500 }}>
                      <PhraseIcon size={13} strokeWidth={2} />
                      {phrase.text}
                    </span>
                  </>
                );
              })()}
            </div>
          </>)}</div>
          {canEdit && editingCard === null && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexShrink: 0 }}>
              <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', overflow: 'hidden', background: 'var(--color-bg)' }}>
                <button
                  type="button"
                  onClick={() => navigate('/ingest')}
                  title="Upload a contract document and extract fields with Claude AI"
                  style={ICON_CLUSTER_BTN}
                >
                  <FileUp size={16} strokeWidth={1.75} />
                  <span style={ICON_CLUSTER_LABEL}>Upload</span>
                </button>
                {contract.internalOwnerId !== user?.id ? (
                  <button
                    type="button"
                    onClick={handleAssignToMe}
                    disabled={statusSaving}
                    title={contract.internalOwner ? `Currently owned by ${contract.internalOwner.name}` : 'No owner assigned'}
                    style={ICON_CLUSTER_BTN}
                  >
                    <UserPlus size={16} strokeWidth={1.75} />
                    <span style={ICON_CLUSTER_LABEL}>Assign</span>
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        const res = await api.put(`/api/contracts/${id}`, { internalOwnerId: null });
                        setContract(res.data.data.contract);
                      } catch (err) {
                        setStatusError(err.response?.data?.error || 'Failed to unassign.');
                      }
                    }}
                    disabled={statusSaving}
                    title="Owned by you — click to unassign"
                    style={{ ...ICON_CLUSTER_BTN, color: 'var(--color-success)' }}
                  >
                    <UserCheck size={16} strokeWidth={1.75} />
                    <span style={{ ...ICON_CLUSTER_LABEL, color: 'var(--color-success)' }}>Yours</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleArchive}
                  title={contract.archivedAt ? 'Restore to active contracts list' : 'Archive — removes from active view, data preserved'}
                  style={contract.archivedAt ? { ...ICON_CLUSTER_BTN, color: 'var(--color-success)' } : ICON_CLUSTER_BTN}
                >
                  {contract.archivedAt ? <ArchiveRestore size={16} strokeWidth={1.75} /> : <Archive size={16} strokeWidth={1.75} />}
                  <span style={contract.archivedAt ? { ...ICON_CLUSTER_LABEL, color: 'var(--color-success)' } : ICON_CLUSTER_LABEL}>
                    {contract.archivedAt ? 'Restore' : 'Archive'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  title="Cancel this contract"
                  style={{ ...ICON_CLUSTER_BTN_LAST, color: 'var(--color-danger)' }}
                >
                  <XIcon size={16} strokeWidth={1.75} />
                  <span style={{ ...ICON_CLUSTER_LABEL, color: 'var(--color-danger)' }}>Cancel</span>
                </button>
              </div>
              {aiEnabled && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  style={{ minWidth: 96, justifyContent: 'center' }}
                  onClick={() => { setActiveTab('renewal'); setTimeout(() => document.getElementById('cd-grp-aibrief')?.scrollIntoView({ behavior: 'smooth' }), 60); }}
                  title="Jump to AI Renewal Brief"
                >
                  ✨ AI Brief
                </button>
              )}
              <button type="button" className="btn btn-secondary" style={{ minWidth: 96, justifyContent: 'center' }} onClick={handleExportContract} disabled={exportingContract} title="Download this contract as an Excel (.xlsx) file">
                <Download size={14} strokeWidth={2} />{exportingContract ? 'Exporting...' : 'Export'}
              </button>
              {contract.status !== 'renewed' && contract.status !== 'cancelled' && (
                <button type="button" className="btn btn-secondary" style={{ minWidth: 96, justifyContent: 'center' }} onClick={handleRenew}>
                  <RefreshCw size={14} strokeWidth={2} />Renew
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="page-body">
        {justImported && (
          <div className="alert" style={{ background: 'var(--color-success-bg)', color: 'var(--color-success)', border: '1px solid var(--color-success-bg-strong)', marginBottom: 16 }}>
            ✓ Contract successfully imported from document — please review the extracted fields below and make any corrections.
          </div>
        )}
        {/* Tags */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12, alignItems: 'center' }}>
          {contract.tags?.map(t => (
            <span key={t.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--color-primary-light)', color: 'var(--color-primary)', borderRadius: 20, padding: '3px 10px', fontSize: 'var(--font-size-sm)', fontWeight: 500 }}>
              {t.tag}
              {canEdit && (
                <button onClick={() => handleRemoveTag(t.tag)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', padding: 0, lineHeight: 1, marginLeft: 2, fontSize: 'var(--font-size-data)' }}>×</button>
              )}
            </span>
          ))}
          {canEdit && (
            <form onSubmit={handleAddTag} style={{ display: 'flex', gap: 4 }}>
              <input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                aria-label="Add tag"
                placeholder="Add tag…"
                className="form-control" style={{ width: 160 }}
                disabled={tagSaving}
              />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={tagSaving} title="Type a tag, then click +">+</button>


            </form>
          )}
        </div>

        {/* Date alerts */}
        <DaysAlert label="Cancel-by date" dateStr={contract.cancelByDate} />
        <DaysAlert label="Evaluation start date" dateStr={contract.evaluationStartByDate} contract={contract} />

        {statusError && <div role="alert" className="alert alert-error">{statusError}</div>}
        {saveError && <div role="alert" className="alert alert-error">{saveError}</div>}

                {/* #1 contract-section-refresh: two-tab nav (replaces global Jump-to TOC). */}
        {/* #19 M365 license-overlap callout: renders only when this contract's
            function is already bundled in an M365 license the account holds. */}
        {m365Overlap && m365Overlap.anchor && (
          <div className="card mb-16" style={{ borderLeft: '4px solid var(--color-primary)', background: 'var(--color-primary-light)' }}>
            <div className="card-body" style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <AlertTriangle size={20} strokeWidth={1.9} style={{ color: 'var(--color-primary)', flexShrink: 0, marginTop: 2 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, color: 'var(--color-text)', marginBottom: 4 }}>
                  Possible Microsoft 365 overlap
                </div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                  This contract overlaps with <strong>{m365Overlap.capability}</strong>, already included in your{' '}
                  <Link to={`/contracts/${m365Overlap.anchor.id}`} style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                    {m365Overlap.anchor.vendorName} ({m365Overlap.anchor.tier})
                  </Link>{' '}license. {m365Overlap.note}
                </div>
                {aiEnabled && (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => { setActiveTab('renewal'); setTimeout(() => document.getElementById('cd-grp-aibrief')?.scrollIntoView({ behavior: 'smooth' }), 60); }}
                    title="Jump to the AI Renewal Brief for rep/consultant talking points"
                  >
                    Run AI renewal brief for talking points
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
        <ContractTabsNav activeTab={activeTab} onTabChange={setActiveTab} groups={activeGroups} showChips={true} />

        {/* === VIEW MODE === */}
        {true && (
          <>
            {/* ===== TAB 1: Contract & Finance ===== */}
            <div role="tabpanel" aria-label="Contract & Finance" hidden={activeTab !== 'contract'} style={{ display: activeTab === 'contract' ? 'block' : 'none' }}>
              <section id="cd-grp-keydates" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Key Dates */}
            <div id="cd-dates" className="card card--accent mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
              <div className="card-header"><div className="card-title">Key Dates</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('keydates')} label='Key Dates'/>}</div>
              <div className="card-body">{editingCard === 'keydates' ? (<>
                <div className="form-section" style={{ marginBottom: 0 }}>
                  <div className="form-row form-row-2">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-start-date">Start Date</label>
                      <input id="cdc-start-date" type="date" className="form-control" value={form.startDate} onChange={(e) => setF('startDate', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-end-date">Renewal / End Date</label>
                      <input id="cdc-end-date" type="date" className="form-control" value={form.endDate} onChange={(e) => setF('endDate', e.target.value)} />
                      <div className="form-hint">Review-by and cancel-by dates recalculate automatically on save.</div>
                    </div>
                  </div>
                  <div className="form-row form-row-2">
                    <div className="form-group">
                      <div className="checkbox-group">
                        <input type="checkbox" id="cdc-autoRenewal" checked={form.autoRenewal} onChange={(e) => setF('autoRenewal', e.target.checked)} />
                        <label htmlFor="cdc-autoRenewal" className="checkbox-label">Auto-renewal enabled</label>
                      </div>
                    </div>
                    {form.autoRenewal && (
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-notice-days">Notice Period (days)</label>
                        <input id="cdc-notice-days" type="number" className="form-control" value={form.autoRenewalNoticeDays} onChange={(e) => setF('autoRenewalNoticeDays', e.target.value)} placeholder="e.g. 30" />
                      </div>
                    )}
                  </div>
                </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['startDate','endDate','autoRenewal','autoRenewalNoticeDays'])} /></>) : (<>
                <div className="detail-grid">
                  <div className="detail-item">
                    <div className="detail-label">Start Date</div>
                    <DVal value={fmt(contract.startDate)} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Renewal / End Date</div>
                    <DVal value={fmt(contract.endDate)} />
                    {contract.endDate && (
                      <div style={{ marginTop: 4 }}>
                        {(() => {
                          const d = daysUntil(contract.endDate);
                          if (d === null) return null;
                          const cls = URGENCY_CHIP_CLASS[renewalUrgency(contract)] || 'days-chip-ok';
                          return <span className={`days-chip ${cls}`}>{d < 0 ? `${Math.abs(d)} days` : `${d} days`}</span>;
                        })()}
                      </div>
                    )}
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Evaluate By <InfoTip content="The period before the renewal date to begin your evaluation - auto-calculated from contract value." /></div>
                    <DVal value={fmt(contract.evaluationStartByDate)} />
                    <div className="form-hint">Auto-calculated from contract value</div>
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Auto-Renewal</div>
                    <DVal value={contract.autoRenewal ? 'Yes' : 'No'} />
                  </div>
                  {contract.autoRenewal && (
                    <>
                      <div className="detail-item">
                        <div className="detail-label">Notice Period</div>
                        <DVal value={contract.autoRenewalNoticeDays ? `${contract.autoRenewalNoticeDays} days` : null} />
                      </div>
                      <div className="detail-item">
                        <div className="detail-label">Cancel By <InfoTip content="The last date to notify the vendor of non-renewal without triggering auto-renewal. Typically 30-90 days before the end date." /></div>
                        <DVal value={fmt(contract.cancelByDate)} />
                        <div className="form-hint">Must cancel before this date</div>
                      </div>
                    </>
                  )}
                </div>
              </>)}</div>
            </div>

            
              </section>
              <section id="cd-grp-finance" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Financial */}
            <div id="cd-financial" className="card mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
              <div className="card-header"><div className="card-title">Financial</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('financial')} label='Financial'/>}</div>
              <div className="card-body">{editingCard === 'financial' ? (<>
                <div className="form-section" style={{ marginBottom: 0 }}>
                  {!canEditFinancials && (
                    <div className="alert alert-info" style={{ marginBottom: 12, fontSize: 'var(--font-size-ui)' }}>Cost fields can only be edited by an administrator.</div>
                  )}
                  <div className="form-row form-row-3">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-quantity">Quantity</label>
                      <input id="cdc-quantity" type="number" className="form-control" value={form.quantity} onChange={(e) => setF('quantity', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-cost-per-license">Cost Per License ($)</label>
                      <input id="cdc-cost-per-license" type="number" step="0.01" className="form-control" value={form.costPerLicense} onChange={(e) => setF('costPerLicense', e.target.value)} disabled={!canEditFinancials} style={!canEditFinancials ? { opacity: 0.6, cursor: 'not-allowed' } : {}} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-po-number">PO Number</label>
                      <input id="cdc-po-number" className="form-control" value={form.poNumber} onChange={(e) => setF('poNumber', e.target.value)} />
                    </div>
                  </div>
                  <div className="form-row form-row-2">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-invoice-number">Invoice Number</label>
                      <input id="cdc-invoice-number" className="form-control" value={form.invoiceNumber} onChange={(e) => setF('invoiceNumber', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-requestor">Requestor</label>
                      <input id="cdc-requestor" className="form-control" value={form.requestor} onChange={(e) => setF('requestor', e.target.value)} />
                    </div>
                  </div>
                </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['quantity','costPerLicense','poNumber','invoiceNumber','requestor'])} /></>) : (<>
                <div className="detail-grid">
                  <div className="detail-item">
                    <div className="detail-label">Quantity</div>
                    <DVal value={contract.quantity} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Cost Per License</div>
                    <DVal value={contract.costPerLicense != null ? fmtMoney(contract.costPerLicense) : null} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Total Contract Value</div>
                    <DVal value={totalValue != null ? fmtMoney(totalValue) : null} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">PO Number</div>
                    <DVal value={contract.poNumber} mono />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Invoice Number</div>
                    <DVal value={contract.invoiceNumber} mono />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Requestor</div>
                    <DVal value={contract.requestor} />
                  </div>
                </div>
              </>)}</div>
            </div>

            
              {(contract?.category?.slug === 'hardware' || contract?.category?.slug === 'lease_rent') && (canEdit || contract.leaseStart || contract.leaseEnd || contract.leaseType || contract.leaseBuyout != null) && (
              <div id="cd-lease" className="card mb-16">
                <div className="card-header"><div className="card-title">Lease Terms</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('lease')} label='Lease Terms'/>}</div>
                <div className="card-body">{editingCard === 'lease' ? (<>
                  <div className="form-section" style={{ marginBottom: 0 }}>
                    <div className="form-row form-row-2">
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-lease-start">Lease Start</label>
                        <input id="cdc-lease-start" type="date" className="form-control" value={form.leaseStart} onChange={(e) => setF('leaseStart', e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-lease-end">Lease End</label>
                        <input id="cdc-lease-end" type="date" className="form-control" value={form.leaseEnd} onChange={(e) => setF('leaseEnd', e.target.value)} />
                      </div>
                    </div>
                    <div className="form-row form-row-2">
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-lease-type">Lease Type</label>
                        <input id="cdc-lease-type" className="form-control" value={form.leaseType} onChange={(e) => setF('leaseType', e.target.value)} placeholder="e.g. Operating, Capital, FMV, $1 buyout" />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-lease-buyout">Buyout Amount ($)</label>
                        <input id="cdc-lease-buyout" type="number" step="0.01" className="form-control" value={form.leaseBuyout} onChange={(e) => setF('leaseBuyout', e.target.value)} placeholder="End-of-term purchase option" />
                      </div>
                    </div>
                  </div>
                  <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['leaseStart','leaseEnd','leaseType','leaseBuyout'])} /></>) : (<>
                  <div className="detail-grid">
                    <div className="detail-item"><div className="detail-label">Lease Start</div><DVal value={fmt(contract.leaseStart)} /></div>
                    <div className="detail-item"><div className="detail-label">Lease End</div><DVal value={fmt(contract.leaseEnd)} /></div>
                    <div className="detail-item"><div className="detail-label">Lease Type</div><DVal value={contract.leaseType} /></div>
                    <div className="detail-item"><div className="detail-label">Buyout Amount</div><DVal value={contract.leaseBuyout != null ? fmtMoney(contract.leaseBuyout) : null} /></div>
                  </div>
                </>)}</div>
              </div>
            )}

              {/* Purchase Orders panel (v0.10.0) — only render when the contract
                actually has POs OR when the user has permission to add the
                first one. Hidden for read-only viewers on contracts that
                never had POs so an empty card doesn't pad the layout. */}
            {(canEdit || (contract.purchaseOrders && contract.purchaseOrders.length > 0)) && (
              <PurchaseOrdersPanel
                contract={contract}
                canEdit={canEdit}
                onChange={(pos) => setContract(prev => ({ ...prev, purchaseOrders: pos }))}
                onDocChange={refreshContract}
              />
            )}

            
              {/* Reseller / Purchase Source */}
            {(canEdit || contract.resellerName || contract.resellerAccountNumber || contract.resellerContactName || contract.resellerContactEmail) && (
              <div className="card mb-16">
                <div className="card-header"><div className="card-title">Purchase Source / Reseller</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('reseller')} label='Purchase Source'/>}</div>
                <div className="card-body">{editingCard === 'reseller' ? (<>
                <div className="form-section" style={{ marginBottom: 0 }}>
                    <div className="form-row form-row-2">
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-reseller-name">Reseller / Distributor</label>
                        <input id="cdc-reseller-name" className="form-control" placeholder="e.g. SoftwareOne, SHI, Insight" value={form.resellerName} onChange={(e) => setF('resellerName', e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-reseller-account-number">Account # with Reseller</label>
                        <input id="cdc-reseller-account-number" className="form-control" value={form.resellerAccountNumber} onChange={(e) => setF('resellerAccountNumber', e.target.value)} />
                      </div>
                    </div>
                    <div className="form-row form-row-2">
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-reseller-contact-name">Reseller Contact Name</label>
                        <input id="cdc-reseller-contact-name" className="form-control" value={form.resellerContactName} onChange={(e) => setF('resellerContactName', e.target.value)} />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-reseller-contact-email">Reseller Contact Email</label>
                        <input id="cdc-reseller-contact-email" type="email" className="form-control" value={form.resellerContactEmail} onChange={(e) => setF('resellerContactEmail', e.target.value)} />
                      </div>
                    </div>
                  </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['resellerName','resellerAccountNumber','resellerContactName','resellerContactEmail'])} /></>) : (<>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <div className="detail-label">Reseller / Distributor</div>
                      <DVal value={contract.resellerName} />
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Account # with Reseller</div>
                      <DVal value={contract.resellerAccountNumber} mono />
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Reseller Contact</div>
                      <DVal value={contract.resellerContactName} />
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Reseller Contact Email</div>
                      <DVal value={contract.resellerContactEmail} />
                    </div>
                  </div>
                </>)}</div>
              </div>
            )}

            
              {/* Payment Schedule */}
            <PaymentScheduleCard
              contractId={id}
              contract={contract}
              canEdit={canEdit}
            />

            
              </section>
              <section id="cd-grp-delivery" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Delivery & Assignment */}
            <div className="card mb-16">
              <div className="card-header"><div className="card-title">Delivery &amp; Assignment</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('delivery')} label='Delivery'/>}</div>
              <div className="card-body">{editingCard === 'delivery' ? (<>
                <div className="form-section" style={{ marginBottom: 0 }}>
                  <div className="form-row form-row-3">
                    {(contract?.category?.slug === 'saas') && (
                      <div className="form-group">
                        <label className="form-label" htmlFor="cdc-delivery-method">License Type</label>
                        <select id="cdc-delivery-method" className="form-control" value={form.deliveryMethod} onChange={(e) => setF('deliveryMethod', e.target.value)}>
                          <option value="">Select...</option>
                          {DELIVERY_OPTIONS.map((d) => <option key={d} value={d}>{DELIVERY_LABELS[d]}</option>)}
                        </select>
                      </div>
                    )}
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-delivery-email">Delivery Email</label>
                      <input id="cdc-delivery-email" type="email" className="form-control" value={form.deliveryEmail} onChange={(e) => setF('deliveryEmail', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-department">Department</label>
                      <input id="cdc-department" className="form-control" value={form.department} onChange={(e) => setF('department', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-team">Team</label>
                      <input id="cdc-team" className="form-control" value={form.team} onChange={(e) => setF('team', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-cost-center">Cost Center</label>
                      <input id="cdc-cost-center" className="form-control" value={form.costCenter} onChange={(e) => setF('costCenter', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-gl-code">GL Code</label>
                      <input id="cdc-gl-code" className="form-control" placeholder="e.g. 6230-OPEX-IT" maxLength={50} value={form.glCode} onChange={(e) => setF('glCode', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-end-user-name">End User Name</label>
                      <input id="cdc-end-user-name" className="form-control" value={form.endUserName} onChange={(e) => setF('endUserName', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-end-user-email">End User Email</label>
                      <input id="cdc-end-user-email" type="email" className="form-control" value={form.endUserEmail} onChange={(e) => setF('endUserEmail', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-customer-number">Customer #</label>
                      <input id="cdc-customer-number" className="form-control" value={form.customerNumber} onChange={(e) => setF('customerNumber', e.target.value)} />
                    </div>
                  </div>
                  {canAssignOwner && (
                    <div className="form-group" style={{ marginTop: 12 }}>
                      <label className="form-label" htmlFor="cdc-internal-owner">Internal Owner</label>
                      <select id="cdc-internal-owner" className="form-control" value={form.internalOwnerId || ''} onChange={(e) => { const v = e.target.value; if (v !== '__OTHER__') { setForm(prev => ({ ...prev, internalOwnerId: v || null, internalOwnerName: '', internalOwnerEmail: '' })); } else { setF('internalOwnerId', '__OTHER__'); } }}>
                        <option value="">Unassigned</option>
                        {members.map((m) => (<option key={m.id} value={m.id}>{m.name}</option>))}
                        <option value="__OTHER__">Other (not a LapseIQ user)...</option>
                      </select>
                      {form.internalOwnerId === '__OTHER__' && (
                        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                          <input className="form-control" placeholder="Owner name" value={form.internalOwnerName} onChange={(e) => setF('internalOwnerName', e.target.value)} />
                          <input type="email" className="form-control" placeholder="Owner email (optional)" value={form.internalOwnerEmail} onChange={(e) => setF('internalOwnerEmail', e.target.value)} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['deliveryMethod','deliveryEmail','department','team','costCenter','glCode','endUserName','endUserEmail','customerNumber','internalOwnerId','internalOwnerName','internalOwnerEmail'])} /></>) : (<>
                <div className="detail-grid">
                  <div className="detail-item">
                    <div className="detail-label">License Type</div>
                    <DVal value={contract.deliveryMethod ? DELIVERY_LABELS[contract.deliveryMethod] : null} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Delivery Email</div>
                    <DVal value={contract.deliveryEmail} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Department</div>
                    <DVal value={contract.department} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Team</div>
                    <DVal value={contract.team} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Cost Center</div>
                    <DVal value={contract.costCenter} mono />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">GL Code</div>
                    <DVal value={contract.glCode} mono />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Internal Owner</div>
                    {false && canAssignOwner ? (
                      <>
                        {/* v0.5.14: dropdown with "Other..." option for non-LapseIQ owners */}
                        <select
                          aria-label="Internal owner"
                          className="form-control form-control-sm"
                          value={form.internalOwnerId || ''}
                          onChange={(e) => {
                            const v = e.target.value;
                            if (v !== '__OTHER__') {
                              setForm(prev => ({ ...prev, internalOwnerId: v || null, internalOwnerName: '', internalOwnerEmail: '' }));
                            } else {
                              setF('internalOwnerId', '__OTHER__');
                            }
                          }}
                        >
                          <option value="">Unassigned</option>
                          {members.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}</option>
                          ))}
                          <option value="__OTHER__">Other (not a LapseIQ user)…</option>
                        </select>
                        {form.internalOwnerId === '__OTHER__' && (
                          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <input
                              className="form-control form-control-sm"
                              placeholder="Owner name"
                              value={form.internalOwnerName}
                              onChange={(e) => setF('internalOwnerName', e.target.value)}
                            />
                            <input
                              type="email"
                              className="form-control form-control-sm"
                              placeholder="Owner email (optional)"
                              value={form.internalOwnerEmail}
                              onChange={(e) => setF('internalOwnerEmail', e.target.value)}
                            />
                          </div>
                        )}
                      </>
                    ) : (
                      // v0.5.14: display free-text name when no User is assigned but
                      // a non-LapseIQ owner was recorded.
                      <DVal value={contract.internalOwner?.name || contract.internalOwnerName} />
                    )}
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">End User</div>
                    <DVal value={contract.endUserName} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">End User Email</div>
                    <DVal value={contract.endUserEmail} />
                  </div>
                  <div className="detail-item">
                    <div className="detail-label">Customer #</div>
                    <DVal value={contract.customerNumber} mono />
                  </div>
                </div>
              </>)}</div>
            </div>

            {/* #12: dedicated License Keys & Access card (SaaS / software-gated). */}
            {(contract?.category?.slug === 'saas' || !contract?.category) && (canEdit || contract.hasLicenseKeys || (contract.vendor && contract.vendor.portalUrl)) && (
              <div className="card mb-16">
                <div className="card-header"><div className="card-title">License Keys &amp; Access</div>{canEdit && editingCard === null && !lkEditing && <HoverPencil onClick={lkOpenEdit} label='License Keys & Access'/>}</div>
                <div className="card-body">{lkEditing ? (<>
                  <div className="form-group">
                    <label className="form-label" htmlFor="cdc-lk-keys">License Keys</label>
                    <textarea id="cdc-lk-keys" className="form-control" rows={4} value={lkDraft} onChange={(e) => setLkDraft(e.target.value)} placeholder={contract.hasLicenseKeys ? 'Paste new keys to replace the stored ones (leave blank to keep existing)' : 'Paste license keys here...'} />
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginTop: 4 }}>Stored encrypted at rest. Leave blank to keep the existing keys unchanged.</div>
                  </div>
                  <div className="form-group" style={{ marginTop: 12 }}>
                    <label className="form-label" htmlFor="cdc-lk-portal">Vendor Portal URL</label>
                    <input id="cdc-lk-portal" type="url" className="form-control" value={lkPortalDraft} onChange={(e) => setLkPortalDraft(e.target.value)} placeholder="https://..." />
                    <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginTop: 4 }}>Applies to all {(contract.vendor && contract.vendor.name) || 'vendor'} contracts.</div>
                  </div>
                  <CardSaveBar saving={lkSaving} error={lkError} onCancel={lkCancel} onSave={lkSave} /></>) : (<>
                  <div className="detail-item">
                    <div className="detail-label">License Keys</div>
                    {contract.hasLicenseKeys ? (
                      lkRevealed !== null ? (<>
                        <pre style={{ marginTop: 4, fontSize: 'var(--font-size-sm)', background: 'var(--color-bg)', padding: 10, borderRadius: 'var(--radius)', overflowX: 'auto', border: '1px solid var(--color-border)', whiteSpace: 'pre-wrap' }}>{lkRevealed || '(empty)'}</pre>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={lkHide} style={{ marginTop: 6 }}>Hide</button>
                      </>) : (
                        <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                          <span style={{ fontFamily: 'monospace', letterSpacing: '0.2em', color: 'var(--color-text-muted)' }}>{'\u2022'.repeat(12)}</span>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={lkReveal} disabled={lkRevealing}>{lkRevealing ? 'Revealing...' : 'Reveal'}</button>
                        </div>
                      )
                    ) : (
                      <div style={{ marginTop: 4, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-sm)' }}>No license keys stored.</div>
                    )}
                    {lkRevealError && <div role="alert" className="alert alert-error" style={{ marginTop: 8 }}>{lkRevealError}</div>}
                    {contract.hasLicenseKeys && lkRevealed === null && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginTop: 6 }}>Stored encrypted. Revealing is recorded in the activity audit.</div>}
                  </div>
                  <div className="detail-item" style={{ marginTop: 14 }}>
                    <div className="detail-label">Vendor Portal</div>
                    {(contract.vendor && contract.vendor.portalUrl) ? (
                      <a href={contract.vendor.portalUrl} target="_blank" rel="noopener noreferrer">{contract.vendor.portalUrl}</a>
                    ) : (
                      <DVal value={null} />
                    )}
                  </div>
                </>)}</div>
              </div>
            )}

            
              </section>
              <section id="cd-grp-records" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Documents + Recent Activity panels (UX review E1 + E2)
                Side-by-side at >=640px viewport, stacked below that. */}
            <div
              className="mb-16"
              style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16 }}
            >
              <DocumentsPanel contract={contract} canEdit={canEdit} onUploaded={refreshContract} />
              <RecentActivityPanel contractId={contract.id} />
            </div>

            {/* #7 Custom Fields card (was previously only editable in global edit). */}
            {(canEdit || (contract.customFieldValues && contract.customFieldValues.length > 0)) && (
              <div className="card mb-16">
                <div className="card-header">
                  <div className="card-title">Custom Fields</div>
                  {canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('customfields')} label='Custom Fields'/>}
                </div>
                <div className="card-body">
                  {editingCard === 'customfields' ? (<>
                    <CustomFieldInputs values={customFields} onChange={setCustom} existingValues={contract.customFieldValues} categoryId={contract.categoryId} />
                    <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['__customFields__'])} />
                  </>) : (
                    (contract.customFieldValues && contract.customFieldValues.filter(v => v.value != null && v.value !== '').length > 0) ? (
                      <div className="detail-grid">
                        {contract.customFieldValues.filter(v => v.value != null && v.value !== '').map(v => (
                          <div className="detail-item" key={v.definitionId || v.id}>
                            <div className="detail-label">{v.definition?.name || 'Field'}</div>
                            <DVal value={v.value} />
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>No custom field values set.</div>
                    )
                  )}
                </div>
              </div>
            )}

            
              {/* Notes */}
            {(canEdit || contract.notes) && (
              <div className="card mb-16">
                <div className="card-header"><div className="card-title">Notes</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('notes')} label='Notes'/>}</div>
                <div className="card-body">{editingCard === 'notes' ? (<>
                <div className="form-group" style={{ marginBottom: 0 }}>
                    <textarea className="form-control" rows={5} value={form.notes} onChange={(e) => setF('notes', e.target.value)} placeholder="Renewal strategy, vendor history, flags to watch..." />
                  </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['notes'])} /></>) : (<>
                  <p style={{ fontSize: 'var(--font-size-ui)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{contract.notes}</p>
                </>)}</div>
              </div>
            )}

            
              </section>
              {/* Flags: contract-record info, on Contract & Finance tab (confirmed in review). */}
              {/* Flags */}
            {features.contract_flags && contract.flags?.length > 0 && (
              <div className="card mb-16">
                <div className="card-header">
                  <div className="card-title">Contract Flags</div>
                  <span className="badge badge-under_review">{contract.flags.length} flag{contract.flags.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="card-body">
                  {contract.flags.map((flag) => (
                    <div key={flag.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                        <span className="badge badge-under_review">{flag.flagType.replace('_', ' ')}</span>
                        {flag.sourcePage && <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>p. {flag.sourcePage}</span>}
                      </div>
                      <p style={{ fontSize: 'var(--font-size-ui)' }}>{flag.description}</p>
                      {flag.sourceText && (
                        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4, fontStyle: 'italic' }}>
                          "{flag.sourceText}"
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            
              {/* Renewal history: moved to Contract & Finance tab per review 2026-05-29. */}
              {/* Renewal Chain */}
            {(contract.parentContract || contract.renewals?.length > 0) && (
              <div id="cd-history" className="card mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
                <div className="card-header"><div className="card-title">🔄 Renewal History</div></div>
                <div className="card-body" style={{ padding: '8px 0' }}>
                  {contract.parentContract && (
                    <div
                      onClick={() => navigate(`/contracts/${contract.parentContract.id}`)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', cursor: 'pointer', borderBottom: '1px solid var(--color-border)' }}
                      className="table-row-clickable"
                    >
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', minWidth: 60 }}>Previous</span>
                      <span style={{ flex: 1, fontSize: 'var(--font-size-ui)' }}>{contract.parentContract.product}</span>
                      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                        {fmt(contract.parentContract.startDate)} → {fmt(contract.parentContract.endDate)}
                      </span>
                      <span className={`badge badge-${contract.parentContract.status}`} style={{ fontSize: 'var(--font-size-xs)' }}>
                        {contract.parentContract.status}
                      </span>
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', background: 'var(--color-primary-light)' }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', fontWeight: 600, minWidth: 60 }}>Current</span>
                    <span style={{ flex: 1, fontSize: 'var(--font-size-ui)', fontWeight: 600 }}>{contract.product}</span>
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                      {fmt(contract.startDate)} → {fmt(contract.endDate)}
                    </span>
                    <StatusBadge status={contract.status} />
                  </div>
                  {contract.renewals?.map((r) => (
                    <div
                      key={r.id}
                      onClick={() => navigate(`/contracts/${r.id}`)}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 16px', cursor: 'pointer', borderTop: '1px solid var(--color-border)' }}
                      className="table-row-clickable"
                    >
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', minWidth: 60 }}>Renewed</span>
                      <span style={{ flex: 1, fontSize: 'var(--font-size-ui)' }}>{r.product}</span>
                      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                        {fmt(r.startDate)} → {fmt(r.endDate)}
                      </span>
                      <span className={`badge badge-${r.status}`} style={{ fontSize: 'var(--font-size-xs)' }}>{r.status}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            </div>

            {/* ===== TAB 2: Renewal Prep ===== */}
            <div role="tabpanel" aria-label="Renewal Prep" hidden={activeTab !== 'renewal'} style={{ display: activeTab === 'renewal' ? 'block' : 'none' }}>
              <section id="cd-grp-workflow" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Renewal Workflow Checklist — show when under_review OR within 90 days */}
            {(contract.status === 'under_review' || daysUntil(contract.endDate) <= 90) &&
              contract.status !== 'renewed' && contract.status !== 'cancelled' && (
              <RenewalChecklist
                contractId={contract.id}
                checklist={contract.renewalChecklist || {}}
                canEdit={canEdit}
                onUpdate={(updated) => setContract(updated)}
              />
            )}

            
              </section>
              <section id="cd-grp-planning" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* License Utilization */}
            {true && (
              <div id="cd-utilization" className="card mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
                <div className="card-header"><div className="card-title">📊 License Utilization</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('utilization')} label='License Utilization'/>}</div>
                <div className="card-body">{editingCard === 'utilization' ? (<>
                <div className="form-section" style={{ marginBottom: 0 }}>
                  <div className="form-row form-row-3">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-seats-licensed">{seatsLabel}</label>
                      <input id="cdc-seats-licensed" type="number" min="0" className="form-control" value={form.seatsLicensed} onChange={(e) => setF('seatsLicensed', e.target.value)} placeholder="Total purchased" />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-seats-in-use">Seats In Use</label>
                      <input id="cdc-seats-in-use" type="number" min="0" className="form-control" value={form.seatsActivelyInUse} onChange={(e) => setF('seatsActivelyInUse', e.target.value)} placeholder="Confirmed active" />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-uplift">Expected Annual Uplift (%)</label>
                      <input id="cdc-uplift" type="number" min="0" step="0.1" className="form-control" value={form.annualUpliftPercent} onChange={(e) => setF('annualUpliftPercent', e.target.value)} placeholder="e.g. 5" />
                      <div className="form-hint">Used to calculate estimated savings from downsizing</div>
                    </div>
                  </div>
                </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['seatsLicensed','seatsActivelyInUse','annualUpliftPercent'])} /></>) : (<>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <div className="detail-label">{seatsLabel}</div>
                      <InlineNum value={contract.seatsLicensed} canEdit={canEdit} label={seatsLabel} onSave={(v) => saveField({ seatsLicensed: v })} />
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Seats In Use</div>
                      <InlineNum value={contract.seatsActivelyInUse} canEdit={canEdit} label="Seats In Use" onSave={(v) => saveField({ seatsActivelyInUse: v })} />
                    </div>
                    {contract.seatsLicensed != null && contract.seatsActivelyInUse != null && (
                      <div className="detail-item">
                        <div className="detail-label">Utilization Rate</div>
                        {(() => {
                          const pct = Math.round((contract.seatsActivelyInUse / contract.seatsLicensed) * 100);
                          const color = pct >= 80 ? 'var(--color-success)' : pct >= 50 ? 'var(--color-warning)' : 'var(--color-danger)';
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
                              <span style={{ fontWeight: 700, color, fontSize: 'var(--font-size-base)' }}>{pct}%</span>
                              <div style={{ flex: 1, maxWidth: 120, height: 6, background: 'var(--color-border)', borderRadius: 3, overflow: 'hidden' }}>
                                <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, borderRadius: 3 }} />
                              </div>
                              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{contract.seatsLicensed - contract.seatsActivelyInUse} unused</span>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                    <div className="detail-item">
                      <div className="detail-label">Expected Annual Uplift</div>
                      <DVal value={contract.annualUpliftPercent != null ? `${contract.annualUpliftPercent}%` : null} />
                    </div>
                    {/* Estimated savings from downsizing */}
                    {contract.seatsLicensed != null && contract.seatsActivelyInUse != null &&
                     contract.costPerLicense != null && contract.seatsLicensed > contract.seatsActivelyInUse && (
                      <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                        <div className="detail-label">Estimated Savings (if downsized to seats in use)</div>
                        {(() => {
                          const unusedSeats = contract.seatsLicensed - contract.seatsActivelyInUse;
                          const uplift = contract.annualUpliftPercent != null ? parseFloat(contract.annualUpliftPercent) / 100 : 0;
                          const renewedCostPerSeat = parseFloat(contract.costPerLicense) * (1 + uplift);
                          const estSavings = unusedSeats * renewedCostPerSeat;
                          return (
                            <div>
                              <span style={{ fontWeight: 700, color: 'var(--color-success)', fontSize: 16 }}>
                                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(estSavings)}
                              </span>
                              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginLeft: 8 }}>
                                {unusedSeats} unused seats × ${(renewedCostPerSeat).toFixed(2)}/seat at renewal
                              </span>
                              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 3, fontStyle: 'italic' }}>
                                ⚠️ Estimated only — actual savings may be lower if volume discounts apply to current pricing.
                              </div>
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                </>)}</div>
              </div>
            )}

            
              {/* v0.55.0 — Renewal planning panel (per-SKU editable counts +
                pricing, auto-save). Sits ABOVE the AI brief so the user
                plans first, then reads the AI's take on the plan. */}
            <RenewalPlanningPanel contract={contract} canEdit={canEdit} />

                        
              </section>
              <section id="cd-grp-quotes" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Quote Request Checklist — static companion to the AI brief.
                Renders even when renewal_brief is gated off, because it has
                no AI cost and the fields it surfaces matter for any
                quote-request email. */}
            <QuoteRequestChecklist
              contract={contract}
              onAddMissing={canEdit ? () => { setActiveTab('contract'); openCardEdit('details'); } : undefined}
              onOpenVendor={goToVendor}
            />

            
              {/* v0.8.0: vendor-quote auto-fill card — sits right above
                Renewal & Savings so the "drop a PDF, see savings" demo flow
                is visually adjacent to the savings tracker it feeds. */}
            <QuoteUploadCard
              contract={contract}
              canEdit={canEdit}
              onContractUpdated={(updated) => setContract(updated)}
            />

            
              </section>
              <section id="cd-grp-aibrief" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* AI Renewal Brief — Phase 4 v0.4.0 structured render.
                v0.4.1 follow-up: gate on account.aiBriefEnabled too —
                when the admin toggles the feature off, the card
                disappears entirely (not even an empty state), matching
                how other tiered features hide UI rather than render
                "disabled" placeholders. */}
            {aiEnabled && <div id="ai-brief-section" className="card mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
              <div className="card-header">
                <div>
                  <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span>✨ AI Renewal Brief</span>
                    {brief?.categorySlug && (() => {
                      // M3 fix (2026-05-12): the badge shows the category the
                      // BRIEF was generated against, not the contract's
                      // current category. Previously we passed
                      // contract.category.name/icon/color alongside
                      // brief.categorySlug, producing a Frankenstein chip:
                      // "saas" slug with "Telecom" name + telecom icon/color
                      // after the user changed the contract category but
                      // hadn't yet regenerated the brief. Look up the
                      // brief-snapshot category from the categories list so
                      // the badge is self-consistent.
                      const briefCategory = categories.find(c => c.slug === brief.categorySlug);
                      return (
                        <BriefCategoryBadge
                          slug={brief.categorySlug}
                          name={briefCategory?.name || brief.categorySlug}
                          icon={briefCategory?.icon}
                          color={briefCategory?.color}
                        />
                      );
                    })()}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    Per-category renewal brief
                    {brief?.generatedAt && (
                      <span style={{ marginLeft: 6 }}>
                        — generated {new Date(brief.generatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                      </span>
                    )}
                    {typeof brief?.searchEnrichment === 'number' && brief.searchEnrichment > 0 && (
                      <span style={{ marginLeft: 6 }}>
                        — enriched with {brief.searchEnrichment} market source{brief.searchEnrichment === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {brief && (
                    <>
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => generateBrief(true)}
                        disabled={briefLoading}
                        title="Regenerate with latest contract data"
                      >
                        {briefLoading ? 'Generating…' : '↺ Regenerate'}
                      </button>
                      {/* v0.78.0 + v0.92.x: open Ask LapseIQ pre-loaded with this brief as context; disabled in DEMO_MODE so the shared AI budget funds briefs, not multi-turn Q&A (self-hosters with their own AI key get the live Ask) */}
                      {demoMode ? (
                        <span
                          className="btn btn-secondary btn-sm"
                          role="button"
                          aria-disabled="true"
                          title="Follow-up questions about this brief need your own AI key -- available when you self-host LapseIQ. The shared demo AI budget is reserved for generating briefs."
                          style={{ opacity: 0.55, cursor: 'not-allowed' }}
                        >
                          {'\u{1F4AC} Ask'}
                        </span>
                      ) : (
                        <button
                          className="btn btn-secondary btn-sm"
                          onClick={() => window.dispatchEvent(new CustomEvent('lapseiq:open-ask', {
                            detail: {
                              briefContext: brief.text,
                              contractName: contract.product + (contract.vendor?.name ? ' (' + contract.vendor.name + ')' : ''),
                            },
                          }))}
                          title="Ask the AI assistant questions about this renewal brief"
                          disabled={briefLoading}
                          aria-label="Ask about this brief"
                        >
                          {'\u{1F4AC} Ask'}
                        </button>
                      )}
                    </>
                  )}
                  {!brief && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => generateBrief(false)}
                      disabled={briefLoading}
                    >
                      {briefLoading ? 'Generating…' : '✨ Generate Brief'}
                    </button>
                  )}
                  {briefLoading && briefAbortController && (
                    <button
                      type="button"
                      className="btn btn-link btn-sm"
                      onClick={() => {
                        briefAbortController.abort();
                        setBriefAbortController(null);
                        setBriefLoading(false);
                      }}
                      style={{ color: 'var(--color-danger)', padding: '0 4px' }}
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
              <div className="card-body">
                {briefError && (
                  <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{briefError}</div>
                )}
                {/* Persistent disclaimer above the brief itself. Renders
                    whether or not the brief has been generated yet so the
                    expectation is set BEFORE the user clicks Generate. */}
                <AiDisclaimer variant="renewalBrief" style={{ marginBottom: 12 }} />

                {/* Drift warning: the brief was generated against one
                    category template, but the contract's category has
                    since changed. Encourage regeneration.
                    M3 fix (2026-05-12): compare against contract.category.slug
                    (the live source of truth) instead of brief.currentCategorySlug
                    (a server-snapshot that doesn't refresh after a same-page
                    category edit, so the warning would silently fail to fire
                    while the badge showed mixed state). */}
                {brief && brief.categorySlug && contract?.category?.slug
                  && brief.categorySlug !== contract.category.slug && (() => {
                  const liveSlug = contract.category.slug;
                  const liveCategory = categories.find(c => c.slug === liveSlug);
                  const liveName = liveCategory?.name || liveSlug;
                  return (
                    <div
                      className="alert alert-warning"
                      style={{ marginBottom: 12, fontSize: 'var(--font-size-ui)' }}
                    >
                      This brief was generated for the <strong>{brief.categorySlug}</strong>{' '}
                      category, but the contract is now <strong>{liveSlug}</strong>.{' '}
                      <button
                        type="button"
                        className="btn btn-link btn-sm"
                        onClick={() => generateBrief(true)}
                        disabled={briefLoading}
                        style={{ padding: 0, marginLeft: 4 }}
                      >
                        Regenerate using the {liveName} template?
                      </button>
                    </div>
                  );
                })()}

                {briefLoading && !brief && (
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', padding: '8px 0' }}>
                    Analyzing contract and pulling fresh market data — this usually takes about 30 seconds.
                  </div>
                )}

                {/* Structured render path: when sections parsed cleanly,
                    show one BriefSection per key with a feedback widget,
                    then a "Market sources cited" footer (v0.4.1 #10)
                    when Tavily enriched the brief. */}
                {brief && !briefLoading && brief.sectionsParsed && brief.sections && (
                  <div>
                    {['situation', 'market', 'tactics', 'watchFor'].map((key) => (
                      <BriefSection
                        key={key}
                        sectionKey={key}
                        body={brief.sections[key]}
                        contractId={id}
                        categorySlug={brief.categorySlug}
                        templateVersion={brief.templateVersion}
                      />
                    ))}
                    {/* Pass 6 P0-D-01 (v0.36.3): opt-in sections. Server has
                        generated these since v0.36.0 (and pays for the
                        second LLM call), but pre-v0.36.3 the SPA never
                        rendered them. Iterate enabledOptInSlugs so the
                        order matches the server-side catalog. Skip a
                        section whose body came back empty (model didn't
                        follow the envelope) rather than show the
                        always-on "section was empty" placeholder — that
                        copy makes less sense for a supplementary
                        section. Feedback widget suppressed for opt-ins
                        in v0.36.3; per-opt-in feedback is separate scope. */}
                    {Array.isArray(brief.enabledOptInSlugs) && brief.enabledOptInSlugs.length > 0 && brief.optInSections && (
                      brief.enabledOptInSlugs.map((slug) => {
                        const key = OPT_IN_SLUG_TO_KEY[slug];
                        if (!key) return null;
                        const body = brief.optInSections[key];
                        if (!body || String(body).trim().length === 0) return null;
                        return (
                          <BriefSection
                            key={`optin:${slug}`}
                            sectionKey={key}
                            body={body}
                            contractId={id}
                            categorySlug={brief.categorySlug}
                            templateVersion={brief.templateVersion}
                            showFeedback={false}
                            isOptIn /* v0.37.2 W6 MT-156 */
                          />
                        );
                      })
                    )}
                    <BriefSources sources={brief.sourcesUsed} />
                  </div>
                )}

                {/* Fallback: model didn't follow the envelope cleanly,
                    or the brief is from a pre-Phase-4 cached row.
                    Render raw text so the user still gets value. */}
                {brief && !briefLoading && !brief.sectionsParsed && brief.text && (
                  <div style={{ fontSize: 'var(--font-size-ui)', lineHeight: 1.7, color: 'var(--color-text)', whiteSpace: 'pre-wrap' }}>
                    {brief.text}
                  </div>
                )}

                {!brief && !briefLoading && !briefError && (
                  <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                    Click <strong>Generate Brief</strong> to get an AI-powered renewal brief.
                    Structured 4-section output (Situation, Market, Tactics, Watch For)
                    tailored to this contract's category.
                    {/* v0.32.4: demo-mode cap helper. */}
                    <AiCapHelper action="brief" label="brief generations" />
                  </div>
                )}
              </div>
            </div>}

            
              </section>
              <section id="cd-grp-close" style={{ scrollMarginTop: GRP_SCROLL }}>
              {/* Negotiation Log */}
            {(contract.negotiationLog || canEdit) && (
              <div id="cd-negotiation" className="card mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
                <div className="card-header">
                  <div className="card-title">📝 Negotiation Log</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('negotiation')} label='Negotiation Log'/>}
                  {!contract.negotiationLog && canEdit && (
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Click the pencil to add notes</span>
                  )}
                </div>
                {editingCard === 'negotiation' ? (
                  <div className="card-body">
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <textarea className="form-control" rows={7} value={form.negotiationLog} onChange={(e) => setF('negotiationLog', e.target.value)} placeholder="Record your negotiation history here: what the vendor asked, what you countered, who the rep was, what tactics worked, notes for next cycle." />
                    </div>
                    <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['negotiationLog'])} />
                  </div>
                ) : contract.negotiationLog ? (
                  <div className="card-body">
                    <p style={{ fontSize: 'var(--font-size-ui)', lineHeight: 1.7, whiteSpace: 'pre-wrap', color: 'var(--color-text)' }}>{contract.negotiationLog}</p>
                  </div>
                ) : (
                  <div style={{ padding: '16px 20px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)', fontStyle: 'italic' }}>
                    No negotiation notes yet. Use the pencil to record what was asked, what was offered, who the vendor rep was, and what tactics worked.
                  </div>
                )}
              </div>
            )}

            
              {/* v0.78.0: Negotiation Recommendations */}
            {aiEnabled && brief && (
              <NegotiationRecsCard
                contractId={id}
                contractName={contract.product + (contract.vendor?.name ? ' (' + contract.vendor.name + ')' : '')}
              />
            )}

            
              {/* Renewal & Savings */}
            {(canEdit || contract.originalAsk != null || contract.finalNegotiatedPrice != null || contract.signatureStatus) && (
              <div id="cd-renewal" className="card card--accent mb-16" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
                <div className="card-header"><div className="card-title">🤝 Renewal & Savings</div>{canEdit && editingCard === null && <HoverPencil onClick={() => openCardEdit('renewal')} label='Renewal & Savings'/>}</div>
                <div className="card-body">{editingCard === 'renewal' ? (<>
                <div className="form-section" style={{ marginBottom: 0 }}>
                  <div className="form-row form-row-2">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-original-ask">Vendor's Original Ask ($)</label>
                      <input id="cdc-original-ask" type="number" step="0.01" min="0" className="form-control" value={form.originalAsk} onChange={(e) => setF('originalAsk', e.target.value)} placeholder="Vendor's first price" />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-final-price">Final Negotiated Price ($)</label>
                      <input id="cdc-final-price" type="number" step="0.01" min="0" className="form-control" value={form.finalNegotiatedPrice} onChange={(e) => setF('finalNegotiatedPrice', e.target.value)} placeholder="What you actually pay" />
                    </div>
                  </div>
                  {(form.originalAsk || form.finalNegotiatedPrice) && (
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-savings-lever">What drove the saving?</label>
                      <select id="cdc-savings-lever" className="form-control" value={form.savingsLever} onChange={(e) => setF('savingsLever', e.target.value)}>
                        {SAVINGS_LEVER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </div>
                  )}
                  <div className="form-row form-row-3">
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-signature-status">Signature Status</label>
                      <select id="cdc-signature-status" className="form-control" value={form.signatureStatus} onChange={(e) => setF('signatureStatus', e.target.value)}>
                        <option value="">Not set</option>
                        <option value="pending">Pending</option>
                        <option value="signed">Signed</option>
                        <option value="declined">Declined</option>
                      </select>
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-signed-at">Signed Date</label>
                      <input id="cdc-signed-at" type="date" className="form-control" value={form.signedAt} onChange={(e) => setF('signedAt', e.target.value)} />
                    </div>
                    <div className="form-group">
                      <label className="form-label" htmlFor="cdc-signer-name">Signed By</label>
                      <input id="cdc-signer-name" className="form-control" value={form.signerName} onChange={(e) => setF('signerName', e.target.value)} placeholder="Name of signer" />
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="cdc-coterm">Co-Term Group</label>
                    <input id="cdc-coterm" className="form-control" value={form.coTermGroup} onChange={(e) => setF('coTermGroup', e.target.value)} placeholder="e.g. Microsoft Q4 2027" />
                    <div className="form-hint">Links related contracts so you can renew them together.</div>
                  </div>
                </div>
                <CardSaveBar saving={saving} error={saveError} onCancel={closeCardEdit} onSave={() => saveCard(['originalAsk','finalNegotiatedPrice','savingsLever','signatureStatus','signedAt','signerName','coTermGroup'])} /></>) : (<>
                  <div className="detail-grid">
                    <div className="detail-item">
                      <div className="detail-label">Vendor's Original Ask</div>
                      <DVal value={contract.originalAsk != null ? fmtMoney(contract.originalAsk) : null} />
                    </div>
                    <div className="detail-item">
                      <div className="detail-label">Final Negotiated Price</div>
                      <DVal value={contract.finalNegotiatedPrice != null ? fmtMoney(contract.finalNegotiatedPrice) : null} />
                    </div>
                    {contract.originalAsk != null && contract.finalNegotiatedPrice != null && (
                      <div className="detail-item">
                        <div className="detail-label">Savings Achieved</div>
                        {(() => {
                          const saved = parseFloat(contract.originalAsk) - parseFloat(contract.finalNegotiatedPrice);
                          const pct = contract.originalAsk > 0 ? Math.round((saved / parseFloat(contract.originalAsk)) * 100) : 0;
                          return saved > 0 ? (
                            <div>
                              <span style={{ fontWeight: 700, color: 'var(--color-success)', fontSize: 'var(--font-size-base)' }}>
                                {fmtMoney(saved)}
                              </span>
                              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginLeft: 8 }}>({pct}% off ask)</span>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>No savings vs. ask</span>
                          );
                        })()}
                      </div>
                    )}
                    {contract.savingsLever && (
                      <div className="detail-item">
                        <div className="detail-label">Saving Lever</div>
                        <div className="detail-value">{SAVINGS_LEVER_LABEL(contract.savingsLever)}</div>
                      </div>
                    )}
                    <div className="detail-item">
                      <div className="detail-label">Signature Status</div>
                      {contract.signatureStatus ? (
                        <span style={{
                          display: 'inline-block', padding: '2px 10px', borderRadius: 12, fontSize: 'var(--font-size-sm)', fontWeight: 600,
                          background: contract.signatureStatus === 'signed' ? 'var(--color-success-bg)' : contract.signatureStatus === 'declined' ? 'var(--color-danger-bg)' : 'var(--color-warning-bg)',
                          color: contract.signatureStatus === 'signed' ? 'var(--color-success)' : contract.signatureStatus === 'declined' ? 'var(--color-danger)' : 'var(--color-warning)',
                        }}>
                          {contract.signatureStatus.charAt(0).toUpperCase() + contract.signatureStatus.slice(1)}
                        </span>
                      ) : <DVal value={null} />}
                    </div>
                    {contract.signatureStatus === 'signed' && (
                      <>
                        <div className="detail-item">
                          <div className="detail-label">Signed Date</div>
                          <DVal value={fmt(contract.signedAt)} />
                        </div>
                        <div className="detail-item">
                          <div className="detail-label">Signed By</div>
                          <DVal value={contract.signerName} />
                        </div>
                      </>
                    )}
                  </div>
                </>)}</div>
              </div>
            )}

            
              </section>

            </div>
          </>
        )}

        {/* Recent activity moved up next to Documents (UX review E2);
            full chronological view lives at /activity?contractId=:id */}
      </div>
    </>
  );
}
