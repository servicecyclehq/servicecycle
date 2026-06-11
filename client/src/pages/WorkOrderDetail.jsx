// ─────────────────────────────────────────────────────────────────────────────
// WorkOrderDetail.jsx — one contractor job: lifecycle, readings, findings,
// lab samples, documents.
//
// Server endpoints (verified against server/routes/workOrders.ts +
// deficiencies.ts):
//   GET    /api/work-orders/:id
//   PUT    /api/work-orders/:id                      (field edits + status)
//   POST   /api/work-orders/:id/measurements         (object or array)
//   DELETE /api/work-orders/measurements/:mid
//   POST   /api/work-orders/:id/deficiencies
//   POST   /api/deficiencies/:id/resolve
//   POST   /api/work-orders/:id/lab-samples
//
// Lifecycle: SCHEDULED → IN_PROGRESS → COMPLETE, with CANCELLED reachable
// from either non-terminal state. COMPLETE records as-found/as-left condition
// + NETA decal; the as-left condition updates the asset's physical condition
// and reschedules its maintenance server-side.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Pencil, FileText } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import Toast from '../components/Toast';
import BackLink, { useFromState } from '../components/BackLink';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import {
  CONDITION_META, WO_STATUS_META, SEVERITY_META, DECAL_META, IEEE_STATUS_META,
  assetLabel, fmtDate,
} from '../lib/equipment';

const CONDITIONS = ['C1', 'C2', 'C3'];
const DECALS = ['GREEN', 'YELLOW', 'RED'];
const SEVERITIES = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];
const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];
const CERT_LABELS = {
  LEVEL_I: 'Level I', LEVEL_II: 'Level II', LEVEL_III: 'Level III', LEVEL_IV: 'Level IV',
};
const GASES = [
  ['h2', 'H₂'], ['ch4', 'CH₄'], ['c2h2', 'C₂H₂'], ['c2h4', 'C₂H₄'],
  ['c2h6', 'C₂H₆'], ['co', 'CO'], ['co2', 'CO₂'], ['o2', 'O₂'], ['n2', 'N₂'],
];

// NETA ATS/MTS repair-priority classes for individual test results.
// 1 red, 2 amber, 3 slate-amber, 4 slate.
const SEVERITY_PRIORITY_META = {
  1: { label: '1 — Repair immediately',     short: 'P1', color: '#dc2626', bg: '#fef2f2' },
  2: { label: '2 — Monitor',                short: 'P2', color: '#d97706', bg: '#fffbeb' },
  3: { label: '3 — Repair as time permits', short: 'P3', color: '#a16207', bg: '#f1f5f9' },
  4: { label: '4 — Possible deficiency',    short: 'P4', color: '#64748b', bg: '#f1f5f9' },
};

const EMPTY_INSTRUMENT = { make: '', model: '', serial: '', calDate: '' };

function metaOf(metaMap, key) {
  const m = metaMap?.[key];
  if (!m) return {};
  return typeof m === 'string' ? { label: m } : m;
}

function Chip({ meta, fallback }) {
  const m = meta || {};
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
      background: m.bg || 'var(--color-surface)',
      color: m.color || 'var(--color-text-secondary)',
      border: `1px solid ${m.color || 'var(--color-border)'}`,
    }}>{m.label || fallback}</span>
  );
}

function condLabel(c) {
  return metaOf(CONDITION_META, c).label || c;
}

const labelStyle = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };
const todayStr = () => new Date().toISOString().slice(0, 10);

// ── Complete modal ───────────────────────────────────────────────────────────
function CompleteModal({ onClose, onComplete, saving, error }) {
  const [form, setForm] = useState({
    completedDate: todayStr(), asFoundCondition: '', asLeftCondition: '', netaDecal: '',
  });
  return (
    <div
      role="dialog" aria-modal="true" aria-label="Complete work order"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <form
        onSubmit={(e) => { e.preventDefault(); onComplete(form); }}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 480, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 6 }}>Complete work order</div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>
          NETA test records carry both as-found and as-left condition. The as-left
          condition updates the asset's physical condition and reschedules its
          maintenance — a degraded as-left immediately compresses the next interval.
        </div>
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ marginBottom: 12 }}>
          <label style={labelStyle}>Completed date</label>
          <input
            type="date" className="form-control form-control-wide" required
            value={form.completedDate}
            onChange={e => setForm(f => ({ ...f, completedDate: e.target.value }))}
          />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <div>
            <label style={labelStyle}>As-found condition</label>
            <select
              className="form-control form-control-wide"
              value={form.asFoundCondition}
              onChange={e => setForm(f => ({ ...f, asFoundCondition: e.target.value }))}
            >
              <option value="">Not recorded</option>
              {CONDITIONS.map(c => <option key={c} value={c}>{condLabel(c)}</option>)}
            </select>
          </div>
          <div>
            <label style={labelStyle}>As-left condition</label>
            <select
              className="form-control form-control-wide"
              value={form.asLeftCondition}
              onChange={e => setForm(f => ({ ...f, asLeftCondition: e.target.value }))}
            >
              <option value="">Not recorded</option>
              {CONDITIONS.map(c => <option key={c} value={c}>{condLabel(c)}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={labelStyle}>NETA decal</label>
          <select
            className="form-control form-control-wide"
            value={form.netaDecal}
            onChange={e => setForm(f => ({ ...f, netaDecal: e.target.value }))}
          >
            <option value="">No decal</option>
            {DECALS.map(d => <option key={d} value={d}>{metaOf(DECAL_META, d).label || d}</option>)}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Completing…' : 'Mark complete'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Leave-Behind PDF button — fetches as blob, opens in new tab ────────────
function LeaveBehindButton({ woId, label = 'Leave-Behind PDF' }) {
  const [busy, setBusy] = useState(false);
  async function generate() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/work-orders/${woId}/leave-behind-pdf`, { method: 'POST' });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leave-behind-${woId.slice(-8).toUpperCase()}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      alert('Could not generate leave-behind PDF. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="btn btn-secondary" onClick={generate} disabled={busy}>
      <FileText size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 5 }} />
      {busy ? 'Generating…' : label}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function WorkOrderDetail() {
  const { id } = useParams();
  // C1: outbound links record this WO as the origin so their BackLink
  // returns here.
  const fromState = useFromState();
  const { user } = useAuth();
  const confirm = useConfirm();
  const canWrite = ['admin', 'manager'].includes(user?.role);

  const [wo, setWo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  // Lifecycle
  const [showComplete, setShowComplete] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [completeError, setCompleteError] = useState('');
  const [transitioning, setTransitioning] = useState(false);

  // Details editing
  const [editing, setEditing] = useState(false);
  const [detailForm, setDetailForm] = useState(null);
  const [detailSaving, setDetailSaving] = useState(false);
  const [contractors, setContractors] = useState([]);
  const [techs, setTechs] = useState([]);

  // Test conditions & instruments (saved via the existing PUT).
  const [condForm, setCondForm] = useState({ ambientTempC: '', humidityPct: '', testEquipment: [] });
  const [condSaving, setCondSaving] = useState(false);

  // Child-record add forms
  const [measForm, setMeasForm] = useState({
    measurementType: '', phase: '', testVoltage: '', asFoundValue: '', asFoundUnit: '',
    asLeftValue: '', asLeftUnit: '', expectedRange: '', loadPercent: '',
    severityPriority: '', passFail: '',
  });
  const [measSaving, setMeasSaving] = useState(false);
  const [defForm, setDefForm] = useState({ severity: 'RECOMMENDED', description: '', correctiveAction: '' });
  const [defSaving, setDefSaving] = useState(false);
  const [labForm, setLabForm] = useState({
    sampleType: 'dga', sampleDate: todayStr(), labName: '', resultRating: '',
    h2: '', ch4: '', c2h2: '', c2h4: '', c2h6: '', co: '', co2: '', o2: '', n2: '',
    ieeeStatus: '', faultCode: '',
  });
  const [labSaving, setLabSaving] = useState(false);

  useDocumentTitle(wo ? `Work order — ${assetLabel(wo.asset)}` : 'Work order');

  const fetchWo = useCallback(() => {
    return api.get(`/api/work-orders/${id}`)
      .then(r => setWo(r.data?.data?.workOrder || null))
      .catch(err => setError(err.response?.status === 404 ? 'Work order not found.' : 'Failed to load work order.'));
  }, [id]);

  useEffect(() => {
    setLoading(true);
    fetchWo().finally(() => setLoading(false));
  }, [fetchWo]);

  // Re-seed the conditions form from the freshly fetched work order. Server
  // may not return these fields yet (parallel build) — default defensively.
  useEffect(() => {
    if (!wo) return;
    setCondForm({
      ambientTempC: wo.ambientTempC ?? '',
      humidityPct:  wo.humidityPct ?? '',
      testEquipment: Array.isArray(wo.testEquipment)
        ? wo.testEquipment.map(t => ({
            make: t?.make || '', model: t?.model || '', serial: t?.serial || '',
            calDate: t?.calDate ? String(t.calDate).slice(0, 10) : '',
          }))
        : [],
    });
  }, [wo]);

  // Contractor list only needed once the editor opens.
  useEffect(() => {
    if (!editing) return;
    api.get('/api/contractors')
      .then(r => setContractors(r.data?.data?.contractors || []))
      .catch(() => {});
  }, [editing]);

  // Tech roster follows the contractor chosen in the editor.
  useEffect(() => {
    if (!editing || !detailForm?.contractorId) { setTechs([]); return; }
    api.get(`/api/contractors/${detailForm.contractorId}`)
      .then(r => setTechs(r.data?.data?.contractor?.techs || []))
      .catch(() => setTechs([]));
  }, [editing, detailForm?.contractorId]);

  function apiError(err, fallback) {
    setToast({ message: err.response?.data?.error || fallback, variant: 'error' });
  }

  // ── Lifecycle actions ──────────────────────────────────────────────────────
  async function startJob() {
    setTransitioning(true);
    try {
      await api.put(`/api/work-orders/${id}`, { status: 'IN_PROGRESS' });
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to start work order.');
    } finally {
      setTransitioning(false);
    }
  }

  async function completeJob(form) {
    setCompleting(true);
    setCompleteError('');
    try {
      await api.put(`/api/work-orders/${id}`, {
        status: 'COMPLETE',
        completedDate: form.completedDate || null,
        asFoundCondition: form.asFoundCondition || null,
        asLeftCondition: form.asLeftCondition || null,
        netaDecal: form.netaDecal || null,
      });
      setShowComplete(false);
      await fetchWo();
      setToast({ message: 'Work order completed.', variant: 'success', duration: 5000 });
    } catch (err) {
      setCompleteError(err.response?.data?.error || 'Failed to complete work order.');
    } finally {
      setCompleting(false);
    }
  }

  async function cancelJob() {
    const ok = await confirm({
      title: 'Cancel this work order?',
      message: 'Cancellation is terminal — the job cannot be restarted. The linked schedule keeps its current due date.',
      confirmLabel: 'Cancel work order',
      danger: true,
    });
    if (!ok) return;
    setTransitioning(true);
    try {
      await api.put(`/api/work-orders/${id}`, { status: 'CANCELLED' });
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to cancel work order.');
    } finally {
      setTransitioning(false);
    }
  }

  // ── Details editing ────────────────────────────────────────────────────────
  function openEditor() {
    setDetailForm({
      contractorId: wo.contractor?.id || '',
      assignedTechId: wo.assignedTech?.id || '',
      netaCertLevel: wo.netaCertLevel || '',
      scheduledDate: wo.scheduledDate ? String(wo.scheduledDate).slice(0, 10) : '',
      reportPdfUrl: wo.reportPdfUrl || '',
      notes: wo.notes || '',
    });
    setEditing(true);
  }

  async function saveDetails(e) {
    e.preventDefault();
    setDetailSaving(true);
    try {
      await api.put(`/api/work-orders/${id}`, {
        contractorId: detailForm.contractorId || null,
        assignedTechId: detailForm.assignedTechId || null,
        netaCertLevel: detailForm.netaCertLevel || null,
        scheduledDate: detailForm.scheduledDate || null,
        reportPdfUrl: detailForm.reportPdfUrl || null,
        notes: detailForm.notes || null,
      });
      await fetchWo();
      setEditing(false);
      setToast({ message: 'Work order saved.', variant: 'success', duration: 4000 });
    } catch (err) {
      apiError(err, 'Failed to save work order.');
    } finally {
      setDetailSaving(false);
    }
  }

  // ── Test conditions & instruments ──────────────────────────────────────────
  function setInstrument(idx, field, value) {
    setCondForm(f => ({
      ...f,
      testEquipment: f.testEquipment.map((t, i) => i === idx ? { ...t, [field]: value } : t),
    }));
  }

  async function saveConditions(e) {
    e.preventDefault();
    setCondSaving(true);
    try {
      await api.put(`/api/work-orders/${id}`, {
        ambientTempC: condForm.ambientTempC === '' ? null : Number(condForm.ambientTempC),
        humidityPct:  condForm.humidityPct === '' ? null : Number(condForm.humidityPct),
        testEquipment: condForm.testEquipment
          .filter(t => t.make.trim() || t.model.trim() || t.serial.trim() || t.calDate)
          .map(t => ({
            make: t.make.trim() || null, model: t.model.trim() || null,
            serial: t.serial.trim() || null, calDate: t.calDate || null,
          })),
      });
      await fetchWo();
      setToast({ message: 'Test conditions saved.', variant: 'success', duration: 4000 });
    } catch (err) {
      apiError(err, 'Failed to save test conditions.');
    } finally {
      setCondSaving(false);
    }
  }

  // ── Child records ──────────────────────────────────────────────────────────
  async function addMeasurement(e) {
    e.preventDefault();
    if (!measForm.measurementType.trim()) return;
    setMeasSaving(true);
    try {
      await api.post(`/api/work-orders/${id}/measurements`, {
        measurementType: measForm.measurementType.trim(),
        phase: measForm.phase || null,
        testVoltage: measForm.testVoltage.trim() || null,
        asFoundValue: measForm.asFoundValue === '' ? null : measForm.asFoundValue,
        asFoundUnit: measForm.asFoundUnit || null,
        asLeftValue: measForm.asLeftValue === '' ? null : measForm.asLeftValue,
        asLeftUnit: measForm.asLeftUnit || null,
        expectedRange: measForm.expectedRange.trim() || null,
        loadPercent: measForm.loadPercent === '' ? null : Number(measForm.loadPercent),
        severityPriority: measForm.severityPriority === '' ? null : Number(measForm.severityPriority),
        passFail: measForm.passFail || null,
      });
      setMeasForm({
        measurementType: '', phase: '', testVoltage: '', asFoundValue: '', asFoundUnit: '',
        asLeftValue: '', asLeftUnit: '', expectedRange: '', loadPercent: '',
        severityPriority: '', passFail: '',
      });
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to add measurement.');
    } finally {
      setMeasSaving(false);
    }
  }

  async function deleteMeasurement(m) {
    const ok = await confirm({
      title: 'Delete this measurement?',
      message: `${m.measurementType}${m.phase ? ` (${m.phase})` : ''} — this cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/api/work-orders/measurements/${m.id}`);
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to delete measurement.');
    }
  }

  async function addDeficiency(e) {
    e.preventDefault();
    if (!defForm.description.trim()) return;
    setDefSaving(true);
    try {
      await api.post(`/api/work-orders/${id}/deficiencies`, {
        severity: defForm.severity,
        description: defForm.description.trim(),
        correctiveAction: defForm.correctiveAction || null,
      });
      setDefForm({ severity: 'RECOMMENDED', description: '', correctiveAction: '' });
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to record deficiency.');
    } finally {
      setDefSaving(false);
    }
  }

  async function resolveDeficiency(d) {
    const ok = await confirm({
      title: 'Resolve this deficiency?',
      message: d.description,
      confirmLabel: 'Resolve',
    });
    if (!ok) return;
    try {
      await api.post(`/api/deficiencies/${d.id}/resolve`, {});
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to resolve deficiency.');
    }
  }

  async function addLabSample(e) {
    e.preventDefault();
    setLabSaving(true);
    try {
      const body = {
        sampleType: labForm.sampleType,
        sampleDate: labForm.sampleDate || null,
        labName: labForm.labName || null,
        resultRating: labForm.resultRating || null,
      };
      if (labForm.sampleType === 'dga') {
        for (const [k] of GASES) body[k] = labForm[k] === '' ? null : labForm[k];
        body.ieeeStatus = labForm.ieeeStatus === '' ? null : Number(labForm.ieeeStatus);
        body.faultCode = labForm.faultCode.trim() || null;
      }
      await api.post(`/api/work-orders/${id}/lab-samples`, body);
      setLabForm({
        sampleType: 'dga', sampleDate: todayStr(), labName: '', resultRating: '',
        h2: '', ch4: '', c2h2: '', c2h4: '', c2h6: '', co: '', co2: '', o2: '', n2: '',
        ieeeStatus: '', faultCode: '',
      });
      await fetchWo();
    } catch (err) {
      apiError(err, 'Failed to record lab sample.');
    } finally {
      setLabSaving(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">Work order</h1></div>
        <div className="page-body"><div className="loading">Loading work order…</div></div>
      </>
    );
  }
  if (error || !wo) {
    return (
      <>
        <div className="page-header"><h1 className="page-title">Work order</h1></div>
        <div className="page-body">
          <div role="alert" className="alert alert-error">{error || 'Work order not found.'}</div>
          <BackLink fallback="/work-orders" fallbackLabel="Work orders" className="btn btn-secondary" style={{ marginTop: 12 }} />
        </div>
      </>
    );
  }

  const isTerminal = wo.status === 'COMPLETE' || wo.status === 'CANCELLED';
  const canStart = canWrite && wo.status === 'SCHEDULED';
  const canComplete = canWrite && (wo.status === 'SCHEDULED' || wo.status === 'IN_PROGRESS');
  const canCancel = canWrite && !isTerminal;
  const taskDef = wo.schedule?.taskDefinition;
  const measurements = wo.measurements || [];
  const deficiencies = wo.deficiencies || [];
  const labSamples = wo.labSamples || [];
  const documents = wo.documents || [];

  const DetailItem = ({ label, children }) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-ui)' }}>{children}</div>
    </div>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink
            fallback="/work-orders" fallbackLabel="Work orders"
            style={{ padding: 0, marginBottom: 4, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}
          />
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            {assetLabel(wo.asset)}
            <Chip meta={metaOf(WO_STATUS_META, wo.status)} fallback={wo.status} />
          </h1>
          <div className="page-subtitle">
            {taskDef?.taskName || 'Ad hoc job'}
            {wo.asset?.site?.name ? ` · ${wo.asset.site.name}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {canStart && (
            <button className="btn btn-secondary" onClick={startJob} disabled={transitioning}>Start</button>
          )}
          {canComplete && (
            <button className="btn btn-primary" onClick={() => { setCompleteError(''); setShowComplete(true); }} disabled={transitioning}>
              Complete
            </button>
          )}
          {canCancel && (
            <button className="btn btn-secondary" style={{ color: 'var(--color-danger)' }} onClick={cancelJob} disabled={transitioning}>
              Cancel
            </button>
          )}
          {wo.status === 'COMPLETE' && (
            <LeaveBehindButton woId={wo.id} />
          )}
        </div>
      </div>

      <div className="page-body">
        {/* E3 (2026-06-11): section order follows the WO's status. Active
            jobs keep the execution flow (conditions → measurements →
            findings, mirroring how a NETA tech works the job); COMPLETE /
            CANCELLED jobs read findings-first for manager review (instrument
            serials are audit fine print there). Implemented as CSS flex
            `order` on a column wrapper — pure presentation, zero data/JSX
            restructuring. */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
        {/* ── Details card ───────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20, order: 0 }}>
          <div className="card-header">
            <div className="card-title">Details</div>
            {canWrite && !isTerminal && !editing && (
              <button className="btn btn-secondary btn-sm" onClick={openEditor}>
                <Pencil size={13} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                Edit
              </button>
            )}
          </div>

          {!editing ? (
            <div style={{ padding: '14px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
              <DetailItem label="Asset">
                <Link to={`/assets/${wo.asset?.id}`} state={fromState} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                  {assetLabel(wo.asset)}
                </Link>
              </DetailItem>
              <DetailItem label="Task">
                {taskDef ? (
                  <>
                    {taskDef.taskName}
                    {taskDef.standardRef && (
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{taskDef.standardRef}</div>
                    )}
                  </>
                ) : <span className="text-muted">Ad hoc — no linked schedule</span>}
              </DetailItem>
              <DetailItem label="Contractor">
                {wo.contractor
                  ? <Link to={`/contractors/${wo.contractor.id}`} style={{ color: 'var(--color-primary)', textDecoration: 'none' }}>{wo.contractor.name}</Link>
                  : <span className="text-muted">Unassigned</span>}
              </DetailItem>
              <DetailItem label="Assigned tech">
                {wo.assignedTech
                  ? <>{wo.assignedTech.name}{wo.assignedTech.netaCertLevel ? ` (NETA ${CERT_LABELS[wo.assignedTech.netaCertLevel] || wo.assignedTech.netaCertLevel})` : ''}</>
                  : <span className="text-muted">—</span>}
              </DetailItem>
              <DetailItem label="Required cert level">
                {wo.netaCertLevel ? `NETA ${CERT_LABELS[wo.netaCertLevel] || wo.netaCertLevel}` : <span className="text-muted">—</span>}
              </DetailItem>
              <DetailItem label="Scheduled">{fmtDate(wo.scheduledDate)}</DetailItem>
              <DetailItem label="Completed">{fmtDate(wo.completedDate)}</DetailItem>
              {(wo.asFoundCondition || wo.asLeftCondition) && (
                <DetailItem label="Condition">
                  {wo.asFoundCondition ? `As found: ${condLabel(wo.asFoundCondition)}` : ''}
                  {wo.asFoundCondition && wo.asLeftCondition ? ' · ' : ''}
                  {wo.asLeftCondition ? `As left: ${condLabel(wo.asLeftCondition)}` : ''}
                </DetailItem>
              )}
              {wo.netaDecal && (
                <DetailItem label="NETA decal">
                  <Chip meta={metaOf(DECAL_META, wo.netaDecal)} fallback={wo.netaDecal} />
                </DetailItem>
              )}
              <DetailItem label="Report PDF">
                {wo.reportPdfUrl
                  ? <a href={wo.reportPdfUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--color-primary)' }}>Open report</a>
                  : <span className="text-muted">—</span>}
              </DetailItem>
              <div style={{ gridColumn: '1 / -1' }}>
                <DetailItem label="Notes">
                  {wo.notes
                    ? <span style={{ whiteSpace: 'pre-wrap' }}>{wo.notes}</span>
                    : <span className="text-muted">—</span>}
                </DetailItem>
              </div>
            </div>
          ) : (
            <form onSubmit={saveDetails} style={{ padding: '14px 20px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
                <div>
                  <label style={labelStyle}>Contractor</label>
                  <select
                    className="form-control form-control-wide"
                    value={detailForm.contractorId}
                    onChange={e => setDetailForm(f => ({ ...f, contractorId: e.target.value, assignedTechId: '' }))}
                  >
                    <option value="">Unassigned / in-house</option>
                    {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Assigned tech</label>
                  <select
                    className="form-control form-control-wide"
                    value={detailForm.assignedTechId}
                    onChange={e => setDetailForm(f => ({ ...f, assignedTechId: e.target.value }))}
                    disabled={!detailForm.contractorId}
                  >
                    <option value="">—</option>
                    {techs.map(t => (
                      <option key={t.id} value={t.id}>
                        {t.name}{t.netaCertLevel ? ` (NETA ${CERT_LABELS[t.netaCertLevel] || t.netaCertLevel})` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Required cert level</label>
                  <select
                    className="form-control form-control-wide"
                    value={detailForm.netaCertLevel}
                    onChange={e => setDetailForm(f => ({ ...f, netaCertLevel: e.target.value }))}
                  >
                    <option value="">None</option>
                    {NETA_CERT_LEVELS.map(l => <option key={l} value={l}>{CERT_LABELS[l]}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Scheduled date</label>
                  <input
                    type="date" className="form-control form-control-wide"
                    value={detailForm.scheduledDate}
                    onChange={e => setDetailForm(f => ({ ...f, scheduledDate: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Report PDF URL</label>
                  <input
                    className="form-control form-control-wide" placeholder="https://…"
                    value={detailForm.reportPdfUrl}
                    onChange={e => setDetailForm(f => ({ ...f, reportPdfUrl: e.target.value }))}
                  />
                </div>
              </div>
              <div style={{ marginTop: 12 }}>
                <label style={labelStyle}>Notes</label>
                <textarea
                  className="form-control" rows={3}
                  value={detailForm.notes}
                  onChange={e => setDetailForm(f => ({ ...f, notes: e.target.value }))}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)} disabled={detailSaving}>Cancel</button>
                <button type="submit" className="btn btn-primary" disabled={detailSaving}>
                  {detailSaving ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* ── Test conditions & instruments ─────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20, order: isTerminal ? 3 : 1 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Test conditions &amp; instruments</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                Ambient conditions and the calibrated instruments used on this job
              </div>
            </div>
          </div>

          {canWrite && !isTerminal ? (
            <form onSubmit={saveConditions} style={{ padding: '12px 20px' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={labelStyle}>Ambient temp (°C)</label>
                  <input
                    type="number" step="any" className="form-control" style={{ maxWidth: 130 }}
                    value={condForm.ambientTempC}
                    onChange={e => setCondForm(f => ({ ...f, ambientTempC: e.target.value }))}
                  />
                </div>
                <div>
                  <label style={labelStyle}>Humidity (%)</label>
                  <input
                    type="number" step="any" min="0" max="100" className="form-control" style={{ maxWidth: 130 }}
                    value={condForm.humidityPct}
                    onChange={e => setCondForm(f => ({ ...f, humidityPct: e.target.value }))}
                  />
                </div>
              </div>

              <div style={{ marginTop: 14 }}>
                <label style={labelStyle}>Test instruments</label>
                {condForm.testEquipment.length === 0 && (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                    No instruments recorded yet.
                  </div>
                )}
                {condForm.testEquipment.map((t, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
                    <input
                      className="form-control" style={{ maxWidth: 160 }} placeholder="Make"
                      aria-label={`Instrument ${idx + 1} make`}
                      value={t.make} onChange={e => setInstrument(idx, 'make', e.target.value)}
                    />
                    <input
                      className="form-control" style={{ maxWidth: 160 }} placeholder="Model"
                      aria-label={`Instrument ${idx + 1} model`}
                      value={t.model} onChange={e => setInstrument(idx, 'model', e.target.value)}
                    />
                    <input
                      className="form-control" style={{ maxWidth: 150 }} placeholder="Serial"
                      aria-label={`Instrument ${idx + 1} serial`}
                      value={t.serial} onChange={e => setInstrument(idx, 'serial', e.target.value)}
                    />
                    <div>
                      <label style={{ ...labelStyle, fontSize: 'var(--font-size-xs)', marginBottom: 2 }}>Calibration date</label>
                      <input
                        type="date" className="form-control"
                        aria-label={`Instrument ${idx + 1} calibration date`}
                        value={t.calDate} onChange={e => setInstrument(idx, 'calDate', e.target.value)}
                      />
                    </div>
                    <button
                      type="button" className="btn btn-secondary btn-sm" style={{ color: 'var(--color-danger)' }}
                      aria-label={`Remove instrument ${idx + 1}`}
                      onClick={() => setCondForm(f => ({ ...f, testEquipment: f.testEquipment.filter((_, i) => i !== idx) }))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button
                  type="button" className="btn btn-secondary btn-sm"
                  onClick={() => setCondForm(f => ({ ...f, testEquipment: [...f.testEquipment, { ...EMPTY_INSTRUMENT }] }))}
                >
                  + Add instrument
                </button>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
                  NETA requires instruments calibrated within 12 months, NIST-traceable.
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
                <button type="submit" className="btn btn-primary" disabled={condSaving}>
                  {condSaving ? 'Saving…' : 'Save conditions'}
                </button>
              </div>
            </form>
          ) : (
            <div style={{ padding: '12px 20px' }}>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', fontSize: 'var(--font-size-ui)' }}>
                <span>
                  <span style={{ fontWeight: 600 }}>Ambient temp:</span>{' '}
                  {wo.ambientTempC != null ? `${wo.ambientTempC} °C` : <span className="text-muted">—</span>}
                </span>
                <span>
                  <span style={{ fontWeight: 600 }}>Humidity:</span>{' '}
                  {wo.humidityPct != null ? `${wo.humidityPct}%` : <span className="text-muted">—</span>}
                </span>
              </div>
              {Array.isArray(wo.testEquipment) && wo.testEquipment.length > 0 ? (
                <div className="table-wrap" style={{ marginTop: 10 }}>
                  <table>
                    <thead>
                      <tr><th>Make</th><th>Model</th><th>Serial</th><th>Calibration date</th></tr>
                    </thead>
                    <tbody>
                      {wo.testEquipment.map((t, idx) => (
                        <tr key={idx}>
                          <td>{t?.make || '—'}</td>
                          <td>{t?.model || '—'}</td>
                          <td className="td-muted">{t?.serial || '—'}</td>
                          <td>{fmtDate(t?.calDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
                  No test instruments recorded.
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Test measurements ──────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20, order: 2 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Test measurements</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                As-found and as-left readings per NETA MTS
              </div>
            </div>
          </div>

          {measurements.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No measurements recorded
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Phase</th>
                    <th>Test voltage</th>
                    <th style={{ textAlign: 'right' }}>As found</th>
                    <th style={{ textAlign: 'right' }}>As left</th>
                    <th>Expected range</th>
                    <th style={{ textAlign: 'right' }}>Load %</th>
                    <th>Priority</th>
                    <th>Pass/fail</th>
                    {canWrite && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {measurements.map(m => (
                    <tr key={m.id}>
                      <td style={{ fontWeight: 600 }}>{m.measurementType}</td>
                      <td className="td-muted">{m.phase || '—'}</td>
                      <td className="td-muted">{m.testVoltage || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {m.asFoundValue != null ? `${m.asFoundValue}${m.asFoundUnit ? ` ${m.asFoundUnit}` : ''}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {m.asLeftValue != null ? `${m.asLeftValue}${m.asLeftUnit ? ` ${m.asLeftUnit}` : ''}` : '—'}
                      </td>
                      <td className="td-muted">{m.expectedRange || '—'}</td>
                      <td style={{ textAlign: 'right' }} className="td-muted">
                        {m.loadPercent != null ? `${m.loadPercent}%` : '—'}
                      </td>
                      <td>
                        {SEVERITY_PRIORITY_META[m.severityPriority] ? (
                          <span title={SEVERITY_PRIORITY_META[m.severityPriority].label}>
                            <Chip meta={{
                              ...SEVERITY_PRIORITY_META[m.severityPriority],
                              label: SEVERITY_PRIORITY_META[m.severityPriority].short,
                            }} />
                          </span>
                        ) : <span className="text-muted">—</span>}
                      </td>
                      <td>
                        {m.passFail
                          ? <Chip meta={metaOf(DECAL_META, m.passFail)} fallback={m.passFail} />
                          : <span className="text-muted">—</span>}
                      </td>
                      {canWrite && (
                        <td style={{ textAlign: 'right' }}>
                          <button type="button" className="btn btn-secondary btn-sm" style={{ color: 'var(--color-danger)' }} onClick={() => deleteMeasurement(m)}>
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

          {canWrite && (
            <form onSubmit={addMeasurement} style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={labelStyle}>Type *</label>
                  <input className="form-control" placeholder="e.g. Insulation resistance" value={measForm.measurementType} onChange={e => setMeasForm(f => ({ ...f, measurementType: e.target.value }))} required />
                </div>
                <div>
                  <label style={labelStyle}>Phase</label>
                  <input className="form-control" style={{ maxWidth: 90 }} placeholder="A-B" value={measForm.phase} onChange={e => setMeasForm(f => ({ ...f, phase: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Test voltage</label>
                  <input className="form-control" style={{ maxWidth: 120 }} placeholder="e.g. 1000 VDC" value={measForm.testVoltage} onChange={e => setMeasForm(f => ({ ...f, testVoltage: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>As found</label>
                  <input type="number" step="any" className="form-control" style={{ maxWidth: 110 }} value={measForm.asFoundValue} onChange={e => setMeasForm(f => ({ ...f, asFoundValue: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Unit</label>
                  <input className="form-control" style={{ maxWidth: 80 }} placeholder="MΩ" value={measForm.asFoundUnit} onChange={e => setMeasForm(f => ({ ...f, asFoundUnit: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>As left</label>
                  <input type="number" step="any" className="form-control" style={{ maxWidth: 110 }} value={measForm.asLeftValue} onChange={e => setMeasForm(f => ({ ...f, asLeftValue: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Unit</label>
                  <input className="form-control" style={{ maxWidth: 80 }} placeholder="MΩ" value={measForm.asLeftUnit} onChange={e => setMeasForm(f => ({ ...f, asLeftUnit: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Expected range</label>
                  <input className="form-control" style={{ maxWidth: 130 }} placeholder="e.g. >100 MΩ" value={measForm.expectedRange} onChange={e => setMeasForm(f => ({ ...f, expectedRange: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Load %</label>
                  <input type="number" step="any" min="0" max="100" className="form-control" style={{ maxWidth: 90 }} value={measForm.loadPercent} onChange={e => setMeasForm(f => ({ ...f, loadPercent: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Priority</label>
                  <select className="form-control" value={measForm.severityPriority} onChange={e => setMeasForm(f => ({ ...f, severityPriority: e.target.value }))}>
                    <option value="">—</option>
                    {[1, 2, 3, 4].map(p => <option key={p} value={p}>{SEVERITY_PRIORITY_META[p].label}</option>)}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Pass/fail</label>
                  <select className="form-control" value={measForm.passFail} onChange={e => setMeasForm(f => ({ ...f, passFail: e.target.value }))}>
                    <option value="">—</option>
                    {DECALS.map(d => <option key={d} value={d}>{metaOf(DECAL_META, d).label || d}</option>)}
                  </select>
                </div>
                <button type="submit" className="btn btn-primary" disabled={measSaving || !measForm.measurementType.trim()}>
                  {measSaving ? 'Adding…' : 'Add row'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* ── Deficiencies found ─────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20, order: isTerminal ? 1 : 3 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Deficiencies found</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                NETA severity classes: Immediate · Recommended · Advisory
              </div>
            </div>
          </div>

          {deficiencies.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No deficiencies recorded on this job
            </div>
          ) : (
            <div style={{ padding: '8px 20px' }}>
              {deficiencies.map(d => (
                <div key={d.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ flexShrink: 0, paddingTop: 2 }}>
                    <Chip meta={metaOf(SEVERITY_META, d.severity)} fallback={d.severity} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--font-size-ui)', textDecoration: d.resolvedAt ? 'line-through' : 'none', opacity: d.resolvedAt ? 0.65 : 1 }}>
                      {d.description}
                    </div>
                    {d.correctiveAction && (
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, whiteSpace: 'pre-wrap' }}>
                        {d.correctiveAction}
                      </div>
                    )}
                    {d.resolvedAt && (
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-success, #15803d)', marginTop: 2 }}>
                        Resolved {fmtDate(d.resolvedAt)}{d.resolvedBy?.name ? ` by ${d.resolvedBy.name}` : ''}
                      </div>
                    )}
                  </div>
                  {canWrite && !d.resolvedAt && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => resolveDeficiency(d)}>
                      Resolve
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {canWrite && (
            <form onSubmit={addDeficiency} style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={labelStyle}>Severity</label>
                  <select className="form-control" value={defForm.severity} onChange={e => setDefForm(f => ({ ...f, severity: e.target.value }))}>
                    {SEVERITIES.map(s => <option key={s} value={s}>{metaOf(SEVERITY_META, s).label || s}</option>)}
                  </select>
                </div>
                <div style={{ flex: '2 1 220px' }}>
                  <label style={labelStyle}>Description *</label>
                  <input className="form-control form-control-wide" value={defForm.description} onChange={e => setDefForm(f => ({ ...f, description: e.target.value }))} required />
                </div>
                <div style={{ flex: '2 1 220px' }}>
                  <label style={labelStyle}>Corrective action</label>
                  <input className="form-control form-control-wide" value={defForm.correctiveAction} onChange={e => setDefForm(f => ({ ...f, correctiveAction: e.target.value }))} />
                </div>
                <button type="submit" className="btn btn-primary" disabled={defSaving || !defForm.description.trim()}>
                  {defSaving ? 'Adding…' : 'Record deficiency'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* ── Lab samples ────────────────────────────────────────────────── */}
        <div className="card" style={{ marginBottom: 20, order: 4 }}>
          <div className="card-header">
            <div>
              <div className="card-title">Lab samples</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                DGA gas readings in ppm per IEEE C57.104
              </div>
            </div>
          </div>

          {labSamples.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              No lab samples on this job
            </div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th style={{ textAlign: 'right' }}>Sample date</th>
                    <th>Lab</th>
                    <th>Gases (ppm)</th>
                    <th>IEEE status</th>
                    <th>Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {labSamples.map(ls => (
                    <tr key={ls.id}>
                      <td style={{ fontWeight: 600, textTransform: 'uppercase', fontSize: 'var(--font-size-sm)' }}>{ls.sampleType}</td>
                      <td style={{ textAlign: 'right' }} className="td-muted">{fmtDate(ls.sampleDate)}</td>
                      <td className="td-muted">{ls.labName || '—'}</td>
                      <td style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                        {GASES.filter(([k]) => ls[k] != null).map(([k, lbl]) => `${lbl} ${ls[k]}`).join(' · ') || '—'}
                      </td>
                      <td>
                        {IEEE_STATUS_META[ls.ieeeStatus] ? (
                          <span title="IEEE C57.104 DGA condition status">
                            <Chip meta={IEEE_STATUS_META[ls.ieeeStatus]} />
                          </span>
                        ) : <span className="text-muted">—</span>}
                        {ls.faultCode && (
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                            Fault: {ls.faultCode}
                          </div>
                        )}
                      </td>
                      <td>
                        {ls.resultRating
                          ? <Chip meta={metaOf(DECAL_META, ls.resultRating)} fallback={ls.resultRating} />
                          : <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {canWrite && (
            <form onSubmit={addLabSample} style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={labelStyle}>Sample type</label>
                  <select className="form-control" value={labForm.sampleType} onChange={e => setLabForm(f => ({ ...f, sampleType: e.target.value }))}>
                    <option value="dga">DGA (dissolved gas analysis)</option>
                    <option value="oil_quality">Oil quality</option>
                    <option value="fuel">Fuel</option>
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Sample date</label>
                  <input type="date" className="form-control" value={labForm.sampleDate} onChange={e => setLabForm(f => ({ ...f, sampleDate: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Lab name</label>
                  <input className="form-control" value={labForm.labName} onChange={e => setLabForm(f => ({ ...f, labName: e.target.value }))} />
                </div>
                <div>
                  <label style={labelStyle}>Result rating</label>
                  <select className="form-control" value={labForm.resultRating} onChange={e => setLabForm(f => ({ ...f, resultRating: e.target.value }))}>
                    <option value="">—</option>
                    {DECALS.map(d => <option key={d} value={d}>{metaOf(DECAL_META, d).label || d}</option>)}
                  </select>
                </div>
              </div>
              {labForm.sampleType === 'dga' && (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                    {GASES.map(([k, lbl]) => (
                      <div key={k}>
                        <label style={{ ...labelStyle, fontSize: 'var(--font-size-xs)' }}>{lbl} (ppm)</label>
                        <input
                          type="number" step="any" min="0"
                          className="form-control" style={{ maxWidth: 90 }}
                          value={labForm[k]}
                          onChange={e => setLabForm(f => ({ ...f, [k]: e.target.value }))}
                        />
                      </div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
                    <div>
                      <label style={labelStyle}>IEEE C57.104 status</label>
                      <select className="form-control" value={labForm.ieeeStatus} onChange={e => setLabForm(f => ({ ...f, ieeeStatus: e.target.value }))}>
                        <option value="">—</option>
                        {[1, 2, 3].map(s => (
                          <option key={s} value={s}>{s} — {IEEE_STATUS_META[s].label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={labelStyle}>Fault code</label>
                      <input
                        className="form-control" style={{ maxWidth: 140 }}
                        placeholder="e.g. T2, D1, PD"
                        value={labForm.faultCode}
                        onChange={e => setLabForm(f => ({ ...f, faultCode: e.target.value }))}
                      />
                    </div>
                  </div>
                </>
              )}
              <div style={{ marginTop: 10 }}>
                <button type="submit" className="btn btn-primary" disabled={labSaving}>
                  {labSaving ? 'Recording…' : 'Record sample'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* ── Documents ──────────────────────────────────────────────────── */}
        {documents.length > 0 && (
          <div className="card" style={{ marginBottom: 20, order: 5 }}>
            <div className="card-header">
              <div className="card-title">Documents</div>
            </div>
            <div style={{ padding: '8px 20px 14px' }}>
              {documents.map(doc => (
                <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--font-size-ui)' }}>
                  <FileText size={14} strokeWidth={1.75} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />
                  <span style={{ fontWeight: 600 }}>{doc.filename}</span>
                  <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>
                    {doc.fileType || ''}{doc.version ? ` · v${doc.version}` : ''} · uploaded {fmtDate(doc.uploadedAt)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
      </div>

      {showComplete && (
        <CompleteModal
          onClose={() => setShowComplete(false)}
          onComplete={completeJob}
          saving={completing}
          error={completeError}
        />
      )}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
