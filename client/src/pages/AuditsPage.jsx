// ─────────────────────────────────────────────────────────────────────────────
// AuditsPage.jsx — audit visits + recommendation (REC) tracking (/audits).
//
// Two views, toggled by pill tabs:
//   (a) "Audit visits" — GET /api/audits → data.audits. Each row: type badge
//       (insurance blue / OSHA red / internal pre-audit slate / customer +
//       AHJ neutral), site or "Account-wide", auditor (name · org), dates,
//       outcome chip, open-REC count. Row click expands an inline detail
//       panel (GET /api/audits/:id) with the recommendation workflow
//       (Respond → responseNotes textarea; Complete; Decline w/ notes), an
//       add-recommendation form, linked evidence snapshots with authed
//       downloads, and a "Generate evidence snapshot" action that POSTs
//       /api/audits/:id/snapshots so the hash-anchored PDF is linked to
//       this visit.
//   (b) "All recommendations" — GET /api/audits/recommendations with status
//       filter chips (incl. Overdue via ?overdue=true). Due dates render red
//       when overdue; mandatory severity gets a red-outline chip.
//
// Admin/manager gate matches the /reports route (RequireRole in App.jsx);
// write actions additionally check the role client-side so a future viewer
// grant degrades gracefully.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ClipboardCheck, Plus, Download, ShieldCheck, Pencil, ChevronDown, ChevronRight,
} from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { downloadAuthedFile } from '../api/download';
import Toast from '../components/Toast';
import EmptyState from '../components/EmptyState';
import { fmtDate } from '../lib/equipment';
import { kbdActivate } from '../lib/a11y';

// ── Domain meta maps ─────────────────────────────────────────────────────────
// Literal hexes (not theme vars) to match the CONDITION/SEVERITY convention in
// lib/equipment.js — these are traffic-light domain colors, not theme accents.

const AUDIT_TYPE_META = {
  insurance:         { label: 'Insurance',         color: 'var(--chip-blue-fg)',   bg: 'var(--chip-blue-bg)' },
  osha:              { label: 'OSHA',              color: 'var(--chip-red-fg)',    bg: 'var(--chip-red-bg)' },
  internal_preaudit: { label: 'Internal Pre-audit', color: 'var(--chip-slate-fg)', bg: 'var(--chip-slate-bg)' },
  customer:          { label: 'Customer' },
  ahj:               { label: 'AHJ' },
};

const OUTCOME_META = {
  passed:               { label: 'Passed',               color: 'var(--chip-green-fg)', bg: 'var(--chip-green-bg)' },
  passed_with_findings: { label: 'Passed w/ findings',   color: 'var(--chip-amber-fg)', bg: 'var(--chip-amber-bg)' },
  failed:               { label: 'Failed',               color: 'var(--chip-red-fg)',   bg: 'var(--chip-red-bg)' },
  pending:              { label: 'Pending',              color: 'var(--chip-slate-fg)', bg: 'var(--chip-slate-bg)' },
};

const REC_STATUS_META = {
  open:      { label: 'Open',      color: 'var(--chip-blue-fg)',  bg: 'var(--chip-blue-bg)' },
  responded: { label: 'Responded', color: 'var(--chip-amber-fg)', bg: 'var(--chip-amber-bg)' },
  completed: { label: 'Completed', color: 'var(--chip-green-fg)', bg: 'var(--chip-green-bg)' },
  declined:  { label: 'Declined',  color: 'var(--chip-slate-fg)', bg: 'var(--chip-slate-bg)' },
};

const AUDIT_TYPES = ['insurance', 'osha', 'internal_preaudit', 'customer', 'ahj'];
const OUTCOMES    = ['pending', 'passed', 'passed_with_findings', 'failed'];

function Chip({ meta, fallback }) {
  const m = meta || {};
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 600, whiteSpace: 'nowrap',
      background: m.bg || 'var(--color-surface)',
      color: m.color || 'var(--color-text-secondary)',
      border: `1px solid ${m.color || 'var(--color-border)'}`,
    }}>{m.label || fallback || '—'}</span>
  );
}

// Severity chip — server-defined free-ish values; "mandatory" gets the red
// outline the spec calls for, everything else renders neutral.
function SeverityChip({ severity }) {
  if (!severity) return <span className="text-muted">—</span>;
  const isMandatory = String(severity).toLowerCase() === 'mandatory';
  return (
    <Chip
      meta={isMandatory
        ? { label: 'Mandatory', color: 'var(--chip-red-fg)', bg: 'transparent' }
        : { label: severity.charAt(0).toUpperCase() + severity.slice(1) }}
    />
  );
}

function isOverdue(rec) {
  if (!rec?.dueDate) return false;
  if (['completed', 'declined'].includes(rec.status)) return false;
  const due = new Date(rec.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  return due.getTime() < Date.now();
}

function dateInputValue(d) {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

const fieldLabel = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };

function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={fieldLabel}>
        {label}{required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
      </label>
      {children}
    </div>
  );
}

// ── Record / edit audit modal ────────────────────────────────────────────────

const EMPTY_AUDIT_FORM = {
  auditType: 'insurance', siteId: '', auditorName: '', auditorOrg: '',
  scheduledDate: '', performedDate: '', outcome: 'pending',
};

function AuditModal({ audit, sites, onClose, onSaved }) {
  const editing = !!audit?.id;
  const [form, setForm] = useState(() => editing ? {
    auditType:     audit.auditType || 'insurance',
    siteId:        audit.site?.id || audit.siteId || '',
    auditorName:   audit.auditorName || '',
    auditorOrg:    audit.auditorOrg || '',
    scheduledDate: dateInputValue(audit.scheduledDate),
    performedDate: dateInputValue(audit.performedDate),
    outcome:       audit.outcome || 'pending',
  } : EMPTY_AUDIT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Audit 2026-07-08 (~9 of 16 dialogs missing useFocusTrap).
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose, autoFocus: true });

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.auditorName.trim()) { setError('Auditor name is required.'); return; }
    setSaving(true); setError('');
    const body = {
      auditType:     form.auditType,
      siteId:        form.siteId || null,
      auditorName:   form.auditorName.trim(),
      auditorOrg:    form.auditorOrg.trim() || null,
      scheduledDate: form.scheduledDate || null,
      performedDate: form.performedDate || null,
      outcome:       form.outcome,
    };
    try {
      const res = editing
        ? await api.put(`/api/audits/${audit.id}`, body)
        : await api.post('/api/audits', body);
      onSaved(res.data?.data?.audit);
    } catch (err) {
      setError(err.response?.data?.error || `Failed to ${editing ? 'update' : 'record'} audit.`);
      setSaving(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog" aria-modal="true" aria-label={editing ? 'Edit audit visit' : 'Record audit visit'}
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
          maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 14 }}>
          {editing ? 'Edit audit visit' : 'Record audit visit'}
        </div>
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Audit type" required>
            <select className="form-control form-control-wide" value={form.auditType} onChange={set('auditType')}>
              {AUDIT_TYPES.map(t => (
                <option key={t} value={t}>{AUDIT_TYPE_META[t]?.label || t}</option>
              ))}
            </select>
          </Field>
          <Field label="Scope">
            <select className="form-control form-control-wide" value={form.siteId} onChange={set('siteId')}>
              <option value="">Account-wide</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Auditor name" required>
            <input className="form-control form-control-wide" value={form.auditorName} onChange={set('auditorName')} maxLength={200} autoFocus={!editing} required />
          </Field>
          <Field label="Auditor organization">
            <input className="form-control form-control-wide" value={form.auditorOrg} onChange={set('auditorOrg')} maxLength={200} placeholder="e.g. carrier, OSHA office" />
          </Field>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Scheduled date">
            <input type="date" className="form-control form-control-wide" value={form.scheduledDate} onChange={set('scheduledDate')} />
          </Field>
          <Field label="Performed date">
            <input type="date" className="form-control form-control-wide" value={form.performedDate} onChange={set('performedDate')} />
          </Field>
        </div>

        <Field label="Outcome">
          <select className="form-control form-control-wide" value={form.outcome} onChange={set('outcome')}>
            {OUTCOMES.map(o => (
              <option key={o} value={o}>{OUTCOME_META[o]?.label || o}</option>
            ))}
          </select>
        </Field>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !form.auditorName.trim()}>
            {saving ? 'Saving…' : (editing ? 'Save changes' : 'Record audit')}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Recommendation row (inside the audit detail panel) ──────────────────────

function RecommendationRow({ rec, members, canWrite, onChanged, onError }) {
  // pendingAction: null | 'respond' | 'decline' — shows the notes textarea.
  const [pendingAction, setPendingAction] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const overdue = isOverdue(rec);
  const terminal = ['completed', 'declined'].includes(rec.status);

  async function transition(body) {
    setBusy(true);
    try {
      await api.put(`/api/audits/recommendations/${rec.id}`, body);
      setPendingAction(null);
      setNotes('');
      onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to update recommendation.');
    } finally {
      setBusy(false);
    }
  }

  async function handleComplete() {
    if (!await confirm({
      title: 'Mark recommendation completed',
      message: 'Mark this recommendation as completed? This records the completion timestamp for the audit trail.',
      confirmLabel: 'Mark completed',
    })) return;
    transition({ status: 'completed' });
  }

  function submitNotes(e) {
    e.preventDefault();
    if (!notes.trim()) return;
    transition({
      status: pendingAction === 'respond' ? 'responded' : 'declined',
      responseNotes: notes.trim(),
    });
  }

  const assigneeName = rec.assignedTo?.name
    || members.find(m => m.id === rec.assignedToUserId)?.name
    || null;

  return (
    <div style={{
      border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
      padding: '10px 12px', marginBottom: 8, background: 'var(--color-bg)',
    }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <Chip meta={REC_STATUS_META[rec.status]} fallback={rec.status} />
        <SeverityChip severity={rec.severity} />
        {rec.source && <Chip meta={{ label: rec.source }} />}
        <span style={{
          marginLeft: 'auto', fontSize: 'var(--font-size-xs)', whiteSpace: 'nowrap',
          color: overdue ? 'var(--color-danger)' : 'var(--color-text-secondary)',
          fontWeight: overdue ? 700 : 400,
        }}>
          {rec.dueDate ? `Due ${fmtDate(rec.dueDate)}${overdue ? ' — overdue' : ''}` : 'No due date'}
        </span>
      </div>

      <div style={{ marginTop: 6, fontSize: 'var(--font-size-ui)', lineHeight: 1.5 }}>
        {rec.description || <span className="text-muted">No description</span>}
      </div>

      <div style={{ marginTop: 4, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {assigneeName && <span>Assigned to {assigneeName}</span>}
        {rec.respondedAt && <span>Responded {fmtDate(rec.respondedAt)}</span>}
        {rec.completedAt && <span>Completed {fmtDate(rec.completedAt)}</span>}
      </div>

      {rec.responseNotes && (
        <div style={{
          marginTop: 6, padding: '6px 10px', borderLeft: '3px solid var(--color-border-strong)',
          fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5,
          background: 'var(--color-surface)', borderRadius: 'var(--radius)',
        }}>
          {rec.responseNotes}
        </div>
      )}

      {/* Workflow actions — open → responded/completed/declined; responded → completed/declined. */}
      {canWrite && !terminal && !pendingAction && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          {rec.status === 'open' && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setPendingAction('respond'); setNotes(''); }}>
              Respond
            </button>
          )}
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={handleComplete}>
            Complete
          </button>
          <button
            type="button" className="btn btn-secondary btn-sm" disabled={busy}
            style={{ color: 'var(--color-danger)' }}
            onClick={() => { setPendingAction('decline'); setNotes(''); }}
          >
            Decline
          </button>
        </div>
      )}

      {canWrite && pendingAction && (
        <form onSubmit={submitNotes} style={{ marginTop: 8 }}>
          <label style={fieldLabel}>
            {pendingAction === 'respond' ? 'Response notes' : 'Reason for declining'}
            <span style={{ color: 'var(--color-danger)' }}> *</span>
          </label>
          <textarea
            className="form-control"
            rows={3}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder={pendingAction === 'respond'
              ? 'What corrective action is planned or underway?'
              : 'Why is this recommendation being declined? (recorded for the audit trail)'}
            autoFocus
            style={{ width: '100%', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !notes.trim()}>
              {busy ? 'Saving…' : (pendingAction === 'respond' ? 'Save response' : 'Decline recommendation')}
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setPendingAction(null); setNotes(''); }}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ── Add-recommendation form ──────────────────────────────────────────────────

const EMPTY_REC_FORM = { source: '', severity: 'recommended', description: '', dueDate: '', assignedToUserId: '' };

function AddRecommendationForm({ auditId, members, onAdded, onError }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_REC_FORM);
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.description.trim()) return;
    setSaving(true);
    try {
      await api.post(`/api/audits/${auditId}/recommendations`, {
        source:           form.source.trim() || null,
        severity:         form.severity,
        description:      form.description.trim(),
        dueDate:          form.dueDate || null,
        assignedToUserId: form.assignedToUserId || null,
      });
      setForm(EMPTY_REC_FORM);
      setOpen(false);
      onAdded();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to add recommendation.');
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(true)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Plus size={13} /> Add recommendation
      </button>
    );
  }

  return (
    <form onSubmit={submit} style={{
      border: '1px dashed var(--color-border-strong)', borderRadius: 'var(--radius)',
      padding: '12px 14px', marginTop: 4,
    }}>
      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)', marginBottom: 10 }}>New recommendation</div>
      <Field label="Description" required>
        <textarea className="form-control" rows={2} value={form.description} onChange={set('description')} autoFocus style={{ width: '100%', boxSizing: 'border-box' }} />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <Field label="Source">
          <input className="form-control form-control-wide" value={form.source} onChange={set('source')} placeholder="e.g. report §3.2" maxLength={200} />
        </Field>
        <Field label="Severity">
          <select className="form-control form-control-wide" value={form.severity} onChange={set('severity')}>
            <option value="mandatory">Mandatory</option>
            <option value="recommended">Recommended</option>
            <option value="advisory">Advisory</option>
          </select>
        </Field>
        <Field label="Due date">
          <input type="date" className="form-control form-control-wide" value={form.dueDate} onChange={set('dueDate')} />
        </Field>
        <Field label="Assign to">
          <select className="form-control form-control-wide" value={form.assignedToUserId} onChange={set('assignedToUserId')}>
            <option value="">Unassigned</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !form.description.trim()}>
          {saving ? 'Adding…' : 'Add recommendation'}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={saving} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>
  );
}

// ── Expanded audit detail panel ──────────────────────────────────────────────

function AuditDetailPanel({ auditId, members, standards, canWrite, onAuditChanged, onEdit, setToast }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [snapStd, setSnapStd] = useState('');
  const [generating, setGenerating] = useState(false);

  const load = useCallback(() => {
    return api.get(`/api/audits/${auditId}`)
      .then(r => { setDetail(r.data?.data?.audit || null); setError(''); })
      .catch(err => setError(err.response?.data?.error || 'Failed to load audit detail.'));
  }, [auditId]);

  useEffect(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]);

  function refreshBoth() {
    load();
    onAuditChanged(); // keep the list's REC counts in sync
  }

  async function handleGenerateSnapshot() {
    if (generating) return;
    setGenerating(true);
    setToast({ message: 'Generating evidence snapshot for this audit…', variant: 'info', duration: 8000 });
    try {
      const body = {};
      if (snapStd) body.standardCode = snapStd;
      const res = await api.post(`/api/audits/${auditId}/snapshots`, body);
      const snap = res.data?.data?.snapshot || {};
      const shaPrefix = (snap.sha256 || '').slice(0, 12);
      setToast({
        message: shaPrefix
          ? `Snapshot generated and linked to this audit. Integrity hash: ${shaPrefix}…`
          : 'Snapshot generated and linked to this audit.',
        variant: 'success', duration: 10000,
      });
      refreshBoth();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to generate snapshot.', variant: 'error' });
    } finally {
      setGenerating(false);
    }
  }

  async function handleDownload(snap) {
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      await downloadAuthedFile(
        `${base}/api/compliance/snapshots/${snap.id}/download`,
        snap.filename || 'audit-snapshot.pdf',
      );
    } catch (err) {
      setToast({ message: err.message || 'Download failed.', variant: 'error' });
    }
  }

  if (loading) return <div className="loading" style={{ padding: 16 }}>Loading audit detail…</div>;
  if (error) return <div role="alert" className="alert alert-error" style={{ margin: 12 }}>{error}</div>;
  if (!detail) return null;

  const recs = detail.recommendations || [];
  const snaps = detail.snapshots || [];

  return (
    <div style={{ padding: '14px 16px', background: 'var(--color-surface)' }}>
      {canWrite && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
          <button
            type="button" className="btn btn-secondary btn-sm"
            onClick={() => onEdit(detail)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <Pencil size={13} /> Edit visit
          </button>
        </div>
      )}

      {/* Recommendations */}
      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
        Recommendations ({recs.length})
      </div>
      {recs.length === 0 && (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          No recommendations recorded for this visit.
        </div>
      )}
      {recs.map(rec => (
        <RecommendationRow
          key={rec.id}
          rec={rec}
          members={members}
          canWrite={canWrite}
          onChanged={refreshBoth}
          onError={(msg) => setToast({ message: msg, variant: 'error' })}
        />
      ))}
      {canWrite && (
        <div style={{ marginBottom: 16 }}>
          <AddRecommendationForm
            auditId={auditId}
            members={members}
            onAdded={refreshBoth}
            onError={(msg) => setToast({ message: msg, variant: 'error' })}
          />
        </div>
      )}

      {/* Linked snapshots */}
      <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', margin: '14px 0 8px', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>
        Linked evidence snapshots ({snaps.length})
      </div>
      {snaps.length === 0 && (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
          No snapshots linked to this visit yet.
        </div>
      )}
      {snaps.map(snap => (
        <div key={snap.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', flexWrap: 'wrap' }}>
          <ShieldCheck size={15} color="var(--color-primary)" strokeWidth={1.75} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--font-size-sm)' }}>{snap.filename || 'snapshot.pdf'}</span>
          {snap.kind === 'emp' && <Chip meta={{ label: 'EMP document', color: 'var(--chip-blue-fg)', bg: 'var(--chip-blue-bg)' }} />}
          <span className="text-muted" style={{ fontSize: 'var(--font-size-xs)' }}>{fmtDate(snap.createdAt)}</span>
          {snap.sha256 && (
            <code title={snap.sha256} style={{ fontSize: 'var(--font-size-xs)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--color-text-secondary)' }}>
              {snap.sha256.slice(0, 12)}…
            </code>
          )}
          <button
            type="button" className="btn btn-secondary btn-sm"
            onClick={() => handleDownload(snap)}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginLeft: 'auto' }}
          >
            <Download size={12} /> Download
          </button>
        </div>
      ))}

      {canWrite && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginTop: 10, flexWrap: 'wrap' }}>
          <div style={{ minWidth: 200 }}>
            <label style={fieldLabel} htmlFor={`audit-snap-std-${auditId}`}>Standard scope</label>
            <select
              id={`audit-snap-std-${auditId}`}
              className="form-control"
              value={snapStd}
              onChange={e => setSnapStd(e.target.value)}
              disabled={generating}
            >
              <option value="">All standards</option>
              {standards.map(code => <option key={code} value={code}>{code}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={handleGenerateSnapshot} disabled={generating}>
            {generating ? 'Generating…' : 'Generate evidence snapshot for this audit'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── All-recommendations tab ──────────────────────────────────────────────────

const REC_FILTERS = [
  { key: '',          label: 'All' },
  { key: 'open',      label: 'Open' },
  { key: 'responded', label: 'Responded' },
  { key: 'completed', label: 'Completed' },
  { key: 'declined',  label: 'Declined' },
  { key: 'overdue',   label: 'Overdue' },
];

function AllRecommendations({ setToast }) {
  const [filter, setFilter] = useState('open');
  const [recs, setRecs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // CUST-8-9: real pagination so recommendations beyond the first 50 are
  // reachable (the server already pages this list).
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);

  // Filter changes reset to page 1.
  useEffect(() => { setPage(1); }, [filter]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = { page };
    if (filter === 'overdue') params.overdue = 'true';
    else if (filter) params.status = filter;
    api.get('/api/audits/recommendations', { params })
      .then(r => {
        if (cancelled) return;
        const d = r.data?.data || {};
        const list = d.recommendations || [];
        setRecs(list);
        setTotal(d.pagination?.total ?? list.length);
        setTotalPages(d.pagination?.pages ?? 1);
        setError('');
      })
      .catch(err => { if (!cancelled) setError(err.response?.data?.error || 'Failed to load recommendations.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filter, page]);

  void setToast; // reserved for future row-level actions

  return (
    <div className="card">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div className="card-title">All recommendations {!loading && `(${total})`}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 'auto' }} role="group" aria-label="Filter recommendations by status">
          {REC_FILTERS.map(f => {
            const active = filter === f.key;
            const isOverdueChip = f.key === 'overdue';
            return (
              <button
                key={f.key || 'all'}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(f.key)}
                style={{
                  padding: '3px 10px', borderRadius: 999, cursor: 'pointer',
                  fontSize: 'var(--font-size-xs)', fontWeight: 600,
                  background: active ? (isOverdueChip ? 'var(--chip-red-bg)' : 'var(--color-primary-light, #eff6ff)') : 'var(--color-surface)',
                  color: active ? (isOverdueChip ? 'var(--chip-red-fg)' : 'var(--color-primary)') : 'var(--color-text-secondary)',
                  border: `1px solid ${active ? (isOverdueChip ? 'var(--chip-red-fg)' : 'var(--color-primary)') : 'var(--color-border)'}`,
                }}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </div>

      {error && <div role="alert" className="alert alert-error" style={{ margin: 12 }}>{error}</div>}
      {loading ? (
        <div className="card-body"><div className="loading">Loading recommendations…</div></div>
      ) : recs.length === 0 && !error ? (
        <EmptyState
          icon={ClipboardCheck}
          title="No recommendations"
          sub={filter
            ? 'Nothing matches this filter. Recommendations recorded against audit visits land here.'
            : 'Recommendations recorded against audit visits land here.'}
        />
      ) : recs.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Recommendation</th>
                <th>Audit</th>
                <th>Source</th>
                <th>Severity</th>
                <th>Status</th>
                <th>Due</th>
                <th>Assignee</th>
              </tr>
            </thead>
            <tbody>
              {recs.map(rec => {
                const overdue = isOverdue(rec);
                const audit = rec.auditVisit || {};
                return (
                  <tr key={rec.id}>
                    <td style={{ maxWidth: 360 }}>
                      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                        {rec.description || '—'}
                      </div>
                    </td>
                    <td className="td-muted" style={{ whiteSpace: 'nowrap' }}>
                      {audit.auditType
                        ? <Chip meta={AUDIT_TYPE_META[audit.auditType]} fallback={audit.auditType} />
                        : '—'}
                    </td>
                    <td className="td-muted">{rec.source || '—'}</td>
                    <td><SeverityChip severity={rec.severity} /></td>
                    <td><Chip meta={REC_STATUS_META[rec.status]} fallback={rec.status} /></td>
                    <td style={{
                      whiteSpace: 'nowrap',
                      color: overdue ? 'var(--color-danger)' : undefined,
                      fontWeight: overdue ? 700 : undefined,
                    }}>
                      {fmtDate(rec.dueDate)}
                    </td>
                    <td className="td-muted">{rec.assignedTo?.name || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && totalPages > 1 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', padding: '10px 14px', borderTop: '1px solid var(--color-border)' }}>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            {total.toLocaleString()} total · page {page} of {totalPages}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
            {String.fromCharCode(8592)} Prev
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
            Next {String.fromCharCode(8594)}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AuditsPage() {
  useDocumentTitle('Audits');
  const { user } = useAuth();
  const canWrite = ['admin', 'manager'].includes(user?.role);

  const [tab, setTab] = useState('visits'); // 'visits' | 'recs'

  const [audits, setAudits] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);

  const [expandedId, setExpandedId] = useState(null);
  const [modalAudit, setModalAudit] = useState(null); // null=closed, {}=new, {...audit}=edit

  // Picker sources — loaded once.
  const [sites, setSites] = useState([]);
  const [members, setMembers] = useState([]);
  const [standards, setStandards] = useState([]);

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => { /* picker just offers Account-wide */ });
    // Members for the assignee picker — bootstrap carries them alongside the
    // assets payload; limit=1 keeps the asset page tiny.
    api.get('/api/bootstrap', { params: { limit: 1 } })
      .then(r => setMembers(r.data?.data?.members || r.data?.data?.users || []))
      .catch(() => { /* assignee picker just offers Unassigned */ });
    api.get('/api/compliance/summary')
      .then(r => {
        const codes = (r.data?.data?.summary || []).map(row => row.standard?.code).filter(Boolean);
        setStandards([...new Set(codes)]);
      })
      .catch(() => { /* snapshot picker just offers All standards */ });
  }, []);

  const fetchAudits = useCallback(() => {
    return api.get('/api/audits', { params: { page } })
      .then(r => {
        // Server returns data.visits (CUST-8-9: align client with the route shape).
        setAudits(r.data?.data?.visits || []);
        setPagination(r.data?.data?.pagination || null);
        setError('');
      })
      .catch(err => setError(err.response?.data?.error || 'Failed to load audit visits.'));
  }, [page]);

  useEffect(() => {
    setLoading(true);
    fetchAudits().finally(() => setLoading(false));
  }, [fetchAudits]);

  function handleSaved(saved) {
    const wasEditing = !!modalAudit?.id;
    setModalAudit(null);
    fetchAudits();
    setToast({
      message: wasEditing ? 'Audit visit updated.' : 'Audit visit recorded.',
      variant: 'success', duration: 5000,
    });
    if (!wasEditing && saved?.id) setExpandedId(saved.id);
  }

  const totalPages = pagination?.pages || 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Audits</h1>
          <div className="page-subtitle">
            Insurance, OSHA, customer, and AHJ audit visits — with recommendation tracking and hash-anchored evidence snapshots.
          </div>
        </div>
        {canWrite && tab === 'visits' && (
          <button className="btn btn-primary" onClick={() => setModalAudit({})}>
            <Plus size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Record audit
          </button>
        )}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* Tab pills */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }} role="tablist" aria-label="Audit views">
          {[{ key: 'visits', label: 'Audit visits' }, { key: 'recs', label: 'All recommendations' }].map(t => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.key)}
                style={{
                  padding: '6px 14px', borderRadius: 999, cursor: 'pointer',
                  fontSize: 'var(--font-size-sm)', fontWeight: 600,
                  background: active ? 'var(--color-primary)' : 'var(--color-surface)',
                  color: active ? 'var(--color-surface)' : 'var(--color-text-secondary)',
                  border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border-strong)'}`,
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {tab === 'recs' && <AllRecommendations setToast={setToast} />}

        {tab === 'visits' && (
          <div className="card">
            {loading ? (
              <div className="card-body"><div className="loading">Loading audit visits…</div></div>
            ) : audits.length === 0 && !error ? (
              <EmptyState
                icon={ClipboardCheck}
                title="No audit visits yet"
                sub="Record insurance, OSHA, customer, or AHJ visits here — each visit tracks its recommendations and links the evidence snapshots you hand the auditor."
                ctaLabel={canWrite ? 'Record your first audit' : undefined}
                ctaOnClick={canWrite ? () => setModalAudit({}) : undefined}
              />
            ) : audits.length > 0 && (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 28 }}></th>
                        <th>Type</th>
                        <th>Scope</th>
                        <th>Auditor</th>
                        <th>Scheduled</th>
                        <th>Performed</th>
                        <th>Outcome</th>
                        <th style={{ textAlign: 'right' }}>Open RECs</th>
                        <th style={{ textAlign: 'right' }}>Snapshots</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audits.map(a => {
                        const expanded = expandedId === a.id;
                        const toggle = () => setExpandedId(expanded ? null : a.id);
                        const openRecs = a.recommendationCounts?.open ?? 0;
                        const auditorLabel = [a.auditorName, a.auditorOrg].filter(Boolean).join(' · ');
                        return (
                          <RowGroup key={a.id}>
                            <tr
                              style={{ cursor: 'pointer' }}
                              onClick={toggle}
                              tabIndex={0}
                              onKeyDown={kbdActivate(toggle)}
                              aria-expanded={expanded}
                            >
                              <td style={{ color: 'var(--color-text-secondary)' }}>
                                {expanded
                                  ? <ChevronDown size={14} strokeWidth={2} aria-hidden="true" />
                                  : <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />}
                              </td>
                              <td><Chip meta={AUDIT_TYPE_META[a.auditType]} fallback={a.auditType} /></td>
                              <td>{a.site?.name || <span className="td-muted">Account-wide</span>}</td>
                              <td>
                                <div style={{ fontWeight: 600 }}>{auditorLabel || '—'}</div>
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }} className="td-muted">{fmtDate(a.scheduledDate)}</td>
                              <td style={{ whiteSpace: 'nowrap' }} className="td-muted">{fmtDate(a.performedDate)}</td>
                              <td><Chip meta={OUTCOME_META[a.outcome]} fallback={a.outcome} /></td>
                              <td style={{ textAlign: 'right' }}>
                                {openRecs > 0 ? (
                                  <span style={{
                                    display: 'inline-block', minWidth: 18, padding: '1px 7px', borderRadius: 999,
                                    fontSize: 'var(--font-size-xs)', fontWeight: 700,
                                    background: 'var(--chip-red-bg)', color: 'var(--chip-red-fg)', border: '1px solid rgba(220,38,38,0.35)',
                                  }}>
                                    {openRecs}
                                  </span>
                                ) : (
                                  <span className="text-muted">0</span>
                                )}
                              </td>
                              <td style={{ textAlign: 'right' }} className="td-muted">{a.snapshotCount ?? 0}</td>
                            </tr>
                            {expanded && (
                              <tr>
                                <td colSpan={9} style={{ padding: 0, borderTop: 'none' }}>
                                  <AuditDetailPanel
                                    auditId={a.id}
                                    members={members}
                                    standards={standards}
                                    canWrite={canWrite}
                                    onAuditChanged={fetchAudits}
                                    onEdit={(detail) => setModalAudit(detail)}
                                    setToast={setToast}
                                  />
                                </td>
                              </tr>
                            )}
                          </RowGroup>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'flex-end', padding: '10px 14px' }}>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                      ← Prev
                    </button>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                      Page {page} of {totalPages}
                    </span>
                    <button type="button" className="btn btn-secondary btn-sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                      Next →
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {modalAudit && (
        <AuditModal
          audit={modalAudit.id ? modalAudit : null}
          sites={sites}
          onClose={() => setModalAudit(null)}
          onSaved={handleSaved}
        />
      )}
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}

// React fragments can't carry keys via the shorthand inside .map with two
// sibling <tr>s — tiny named wrapper keeps the table semantics valid.
function RowGroup({ children }) {
  return <>{children}</>;
}
