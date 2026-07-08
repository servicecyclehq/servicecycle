// ─────────────────────────────────────────────────────────────────────────────
// NewWorkOrderModal.jsx — shared "New work order" creation modal.
//
// Extracted from WorkOrdersList.jsx (2026-07-03) so DeficienciesPage can open
// the SAME modal from a finding. Two entry modes:
//   - plain (WorkOrdersList "New work order" / priority-queue rows): asset
//     picker + optional schedule/contractor/tech/date/cert/notes.
//   - fromDeficiency (DeficienciesPage "Create work order"): the asset is
//     LOCKED to the deficiency's asset, notes are pre-seeded from the finding
//     description, and the deficiencyId rides on POST /api/work-orders so the
//     server links the finding to the new job atomically.
//
// `contractors` is optional — pass the already-fetched list (WorkOrdersList has
// one for its filters) or omit it and the modal fetches GET /api/contractors
// itself.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import api from '../api/client';
import { assetLabel, fmtDate } from '../lib/equipment';
import { useFocusTrap } from '../hooks/useFocusTrap';

const NETA_CERT_LEVELS = ['LEVEL_I', 'LEVEL_II', 'LEVEL_III', 'LEVEL_IV'];
const CERT_LABELS = {
  LEVEL_I: 'Level I', LEVEL_II: 'Level II', LEVEL_III: 'Level III', LEVEL_IV: 'Level IV',
};

export default function NewWorkOrderModal({
  contractors: contractorsProp = null,
  onClose,
  onCreated,
  initialAssetId = '',
  // { id, assetId, assetLabel, description } — locks the asset + links the finding.
  fromDeficiency = null,
}) {
  const lockedAssetId = fromDeficiency?.assetId || '';
  const [assetSearch, setAssetSearch] = useState('');
  const [assets, setAssets] = useState([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [schedules, setSchedules] = useState([]);
  const [contractorList, setContractorList] = useState(contractorsProp || []);
  const [techs, setTechs] = useState([]);
  const [form, setForm] = useState({
    assetId: lockedAssetId || initialAssetId, scheduleId: '', contractorId: '', assignedTechId: '',
    netaCertLevel: '', scheduledDate: '', notes: fromDeficiency?.description || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Audit 2026-07-08 (~9 of 16 dialogs missing useFocusTrap) — named as one
  // of the two example dialogs in the audit.
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose, autoFocus: true });

  const label = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 };

  // Contractors — only fetched when the caller didn't hand us a list.
  useEffect(() => {
    if (contractorsProp) return;
    api.get('/api/contractors')
      .then(r => setContractorList(r.data?.data?.contractors || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Asset search (debounced). Skipped entirely when the asset is locked.
  useEffect(() => {
    if (lockedAssetId) return;
    setAssetsLoading(true);
    const t = setTimeout(() => {
      api.get('/api/assets', { params: { limit: 100, ...(assetSearch ? { search: assetSearch } : {}) } })
        .then(r => setAssets(r.data?.data?.assets || []))
        .catch(() => setAssets([]))
        .finally(() => setAssetsLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [assetSearch, lockedAssetId]);

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
        ...(fromDeficiency?.id ? { deficiencyId: fromDeficiency.id } : {}),
      });
      onCreated(res.data?.data?.workOrder);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create work order.');
      setSaving(false);
    }
  }

  return (
    <div
      ref={dialogRef}
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
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: fromDeficiency ? 4 : 14 }}>New work order</div>
        {fromDeficiency && (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.4, marginBottom: 14 }}>
            From deficiency: {(fromDeficiency.description || '').slice(0, 140)}
          </div>
        )}
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        {lockedAssetId ? (
          <div style={{ marginBottom: 12 }}>
            <label style={label}>Asset</label>
            <div
              className="form-control form-control-wide"
              style={{ cursor: 'default', fontWeight: 600 }}
              aria-readonly="true"
            >
              {fromDeficiency?.assetLabel || 'Asset from deficiency'}
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
              Locked to the deficiency's asset.
            </div>
          </div>
        ) : (
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
        )}

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
              {contractorList.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
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
