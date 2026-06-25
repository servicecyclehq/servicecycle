// ─────────────────────────────────────────────────────────────────────────────
// ReviewQueue.jsx — confidence-gated ingest review.
//
// Reports that emailed in (or came from a backfill zip) but didn't clear the
// confidence gate wait here. The high-confidence ones were already added
// automatically; these need a human to confirm before any asset card is
// written. Approve = commit (creates the cards); Reject = discard. Both are
// logged to the activity trail as proof a person decided.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { ClipboardCheck, CheckCircle2, AlertTriangle, Mail, Archive, Loader2, X, Pencil } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EQUIPMENT_TYPE_LABELS } from '../lib/equipment';
import Toast from '../components/Toast';

const EQUIPMENT_TYPE_OPTIONS = Object.entries(EQUIPMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }));

// Friendly presets for the auto-add confidence floor. Higher = stricter (more
// goes to review); lower = more auto-commits.
const THRESHOLD_PRESETS = [
  { value: 0.92, label: 'Strict' },
  { value: 0.85, label: 'Balanced' },
  { value: 0.70, label: 'Lenient' },
];
const nearestPreset = (t) => THRESHOLD_PRESETS.reduce((a, b) => (Math.abs(b.value - t) < Math.abs(a.value - t) ? b : a), THRESHOLD_PRESETS[1]).value;

const BAND = {
  red:    { color: 'var(--color-danger, #b91c1c)',  bg: 'rgba(185,28,28,0.10)',  label: 'Needs a close look' },
  yellow: { color: 'var(--color-warning, #b45309)', bg: 'rgba(180,83,9,0.10)',   label: 'Quick check' },
  green:  { color: 'var(--color-success, #15803d)', bg: 'rgba(21,128,61,0.10)',  label: 'Looks clean' },
};

function fmtDate(d) {
  try { return new Date(d).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return ''; }
}

export default function ReviewQueue() {
  useDocumentTitle('Review queue');
  const { user } = useAuth();
  const [items, setItems] = useState(null);
  const [settings, setSettings] = useState(null);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [sites, setSites] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState(null);
  const [siteFor, setSiteFor] = useState({}); // jobId -> siteId override
  const [editState, setEditState] = useState({}); // jobId -> edits patch (when editor opened)
  const [openEdit, setOpenEdit] = useState(null); // jobId whose editor is expanded
  const [toast, setToast] = useState(null);
  const [err, setErr] = useState('');

  function startEdit(job) {
    if (!job.editable) return;
    setEditState(s => s[job.id] ? s : ({
      ...s,
      [job.id]: {
        equipmentType: job.editable.equipmentType || '',
        serialNumber: job.editable.serialNumber || '',
        manufacturer: job.editable.manufacturer || '',
        model: job.editable.model || '',
        assetId: job.editable.matchedAssetId || '', // '' = create new
      },
    }));
    setOpenEdit(openEdit === job.id ? null : job.id);
  }
  const patchEdit = (jobId, key, value) => setEditState(s => ({ ...s, [jobId]: { ...s[jobId], [key]: value } }));

  const load = useCallback(async () => {
    try {
      const r = await api.get('/api/ingest/review');
      setItems(r.data?.data?.items || []);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not load the review queue.');
      setItems([]);
    }
  }, []);

  const loadSettings = useCallback(() => {
    api.get('/api/ingest/review/settings').then(r => setSettings(r.data?.data || null)).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadSettings(); }, [loadSettings]);
  useEffect(() => { api.get('/api/sites').then(r => setSites(r.data?.data?.sites || [])).catch(() => {}); }, []);

  async function saveThreshold(value) {
    if (savingThreshold) return;
    setSavingThreshold(true);
    try {
      await api.put('/api/ingest/review/settings', { threshold: value });
      setToast({ message: 'Auto-add sensitivity updated.', variant: 'success', duration: 3500 });
      loadSettings();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not save that setting.');
    } finally { setSavingThreshold(false); }
  }

  async function approve(job) {
    if (busyId) return;
    setBusyId(job.id); setErr('');
    try {
      const body = {};
      if (siteFor[job.id]) body.siteId = siteFor[job.id];
      if (editState[job.id]) body.edits = editState[job.id];
      const r = await api.post(`/api/ingest/review/${job.id}/approve`, body);
      const n = r.data?.data?.committed?.assetsCommitted ?? 0;
      setItems(prev => (prev || []).filter(x => x.id !== job.id));
      setToast({ message: `Approved — ${n} asset card${n === 1 ? '' : 's'} added.`, variant: 'success', duration: 4000 });
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to approve. Try again.');
    } finally { setBusyId(null); }
  }

  async function reject(job) {
    if (busyId) return;
    setBusyId(job.id); setErr('');
    try {
      await api.post(`/api/ingest/review/${job.id}/reject`, {});
      setItems(prev => (prev || []).filter(x => x.id !== job.id));
      setConfirmReject(null);
      setToast({ message: 'Discarded — nothing was added.', variant: 'info', duration: 4000 });
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to reject. Try again.');
    } finally { setBusyId(null); }
  }

  async function approveAll() {
    if (bulkBusy || !items?.length) return;
    setBulkBusy(true); setErr('');
    try {
      const jobIds = items.map(i => i.id);
      const r = await api.post('/api/ingest/review/bulk-approve', { jobIds });
      const a = r.data?.data?.approved ?? 0;
      const n = r.data?.data?.assetsCommitted ?? 0;
      setToast({ message: `Approved ${a} report${a === 1 ? '' : 's'} — ${n} asset card${n === 1 ? '' : 's'} added.`, variant: 'success', duration: 5000 });
      await load();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Bulk approve failed. Try again.');
    } finally { setBulkBusy(false); }
  }

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ClipboardCheck size={22} strokeWidth={1.75} /> Review queue
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 760, lineHeight: 1.6 }}>
        Reports that came in by email or backfill but need a human OK before they're added. Clean,
        high-confidence reports are added automatically — these were flagged because something about
        the identity or the readings wasn't certain. Approve to create the cards, or discard.
      </p>

      {err && (
        <div role="alert" style={{ padding: '12px 16px', background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', borderRadius: 8, color: 'var(--chip-red-fg)', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" /> <span>{err}</span>
        </div>
      )}

      {/* Auto-add sensitivity + 30-day readout. Collapsed by default. */}
      {settings && (
        <details style={{ marginBottom: 18, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface)' }}>
          <summary style={{ cursor: 'pointer', padding: '10px 14px', fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
            Auto-add sensitivity &amp; recent activity
          </summary>
          <div style={{ padding: '0 14px 14px', display: 'flex', flexWrap: 'wrap', gap: 24 }}>
            <div style={{ flex: '1 1 240px' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>How much auto-adds without review</div>
              {settings.canEdit ? (
                <select
                  value={nearestPreset(settings.threshold)}
                  onChange={e => saveThreshold(Number(e.target.value))}
                  disabled={savingThreshold}
                  style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-bg)', color: 'var(--color-text)', fontSize: 'var(--font-size-sm)' }}
                >
                  {THRESHOLD_PRESETS.map(p => <option key={p.value} value={p.value}>{p.label} — {p.value >= 0.9 ? 'most goes to review' : p.value <= 0.7 ? 'most auto-adds' : 'recommended'}</option>)}
                </select>
              ) : (
                <div style={{ fontSize: 'var(--font-size-sm)' }}>{nearestPreset(settings.threshold) >= 0.9 ? 'Strict' : nearestPreset(settings.threshold) <= 0.7 ? 'Lenient' : 'Balanced'} <span style={{ color: 'var(--color-text-secondary)' }}>(admins can change this)</span></div>
              )}
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 6, lineHeight: 1.5 }}>
                Identity checks (matching the right asset, avoiding duplicates) always require review — this only affects how strict we are about reading confidence.
              </div>
            </div>
            <div style={{ flex: '1 1 240px' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>Last {settings.stats.sinceDays} days</div>
              <div style={{ fontSize: 'var(--font-size-sm)', lineHeight: 1.7 }}>
                <div><strong>{settings.stats.autoAdded}</strong> added automatically</div>
                <div><strong>{settings.stats.approved}</strong> approved after review · <strong>{settings.stats.rejected}</strong> discarded</div>
                <div style={{ color: 'var(--color-text-secondary)' }}>
                  {settings.stats.correctionRate == null
                    ? 'Not enough reviews yet to estimate accuracy.'
                    : `${Math.round(settings.stats.correctionRate * 100)}% of approvals needed an edit — ${settings.stats.correctionRate <= 0.1 ? 'you could loosen the sensitivity.' : settings.stats.correctionRate >= 0.4 ? 'consider keeping it strict.' : 'about right.'}`}
                </div>
              </div>
            </div>
          </div>
        </details>
      )}

      {items === null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-secondary)', padding: '24px 0' }}>
          <Loader2 size={16} style={{ animation: 'spin 0.9s linear infinite' }} aria-hidden="true" /> Loading…
        </div>
      )}

      {items !== null && items.length === 0 && (
        <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
          <CheckCircle2 size={36} strokeWidth={1.25} style={{ color: 'var(--color-success, #15803d)', marginBottom: 12 }} aria-hidden="true" />
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Nothing to review</div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
            Clean reports are added automatically. Anything that needs a check will show up here.
          </div>
        </div></div>
      )}

      {items !== null && items.length > 0 && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 14 }}>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              <strong style={{ color: 'var(--color-text)' }}>{items.length}</strong> report{items.length === 1 ? '' : 's'} waiting
            </div>
            <button className="btn btn-primary" onClick={approveAll} disabled={bulkBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {bulkBusy ? <Loader2 size={15} style={{ animation: 'spin 0.9s linear infinite' }} aria-hidden="true" /> : <CheckCircle2 size={15} aria-hidden="true" />}
              Approve all ({items.length})
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {items.map(job => {
              const meta = BAND[job.band] || BAND.yellow;
              const KindIcon = job.kind === 'email_in' ? Mail : Archive;
              const itemBusy = busyId === job.id;
              return (
                <div key={job.id} className="card" style={{ borderLeft: `3px solid ${meta.color}` }}>
                  <div className="card-body" style={{ padding: 18 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                          <KindIcon size={15} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} aria-hidden="true" />
                          <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{job.fileName || 'report'}</span>
                          <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: meta.color, background: meta.bg, borderRadius: 4, padding: '1px 7px', whiteSpace: 'nowrap' }}>{meta.label}</span>
                        </div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                          {job.kind === 'email_in' ? 'Emailed in' : 'Backfill'} · {fmtDate(job.createdAt)}
                          {job.meta?.serialNumber ? ` · S/N ${job.meta.serialNumber}` : ''}
                          {job.meta?.manufacturer ? ` · ${job.meta.manufacturer}` : ''}
                          {' · '}{job.measurementCount} reading{job.measurementCount === 1 ? '' : 's'}
                          {job.deficienciesToCreate != null ? ` · ${job.deficienciesToCreate} flagged` : ''}
                        </div>
                      </div>
                    </div>

                    {Array.isArray(job.reasons) && job.reasons.length > 0 && (
                      <ul style={{ margin: '12px 0 0', paddingLeft: 18, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                        {job.reasons.slice(0, 5).map((r, i) => <li key={i} style={{ marginBottom: 2 }}>{r}</li>)}
                      </ul>
                    )}

                    {/* Inline editor — fix the flagged fields, then approve. */}
                    {openEdit === job.id && job.editable && editState[job.id] && (
                      <div style={{ marginTop: 14, padding: 14, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface-alt, var(--color-bg))', display: 'flex', flexDirection: 'column', gap: 10 }}>
                        {/* This device: merge to an existing asset, or create new */}
                        {job.editable.candidates && job.editable.candidates.length > 0 && (
                          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
                            This device
                            <select
                              value={editState[job.id].assetId}
                              onChange={e => patchEdit(job.id, 'assetId', e.target.value)}
                              disabled={itemBusy}
                              style={{ display: 'block', marginTop: 4, width: '100%', maxWidth: 460, padding: '6px 9px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)', fontWeight: 400 }}
                            >
                              <option value="">Create a new asset</option>
                              {job.editable.candidates.map(c => <option key={c.id} value={c.id}>Attach to {c.label}{c.siteName ? ` · ${c.siteName}` : ''}</option>)}
                            </select>
                          </label>
                        )}
                        {/* New-asset fields — only relevant when creating new */}
                        {!editState[job.id].assetId && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, flex: '1 1 180px' }}>
                              Equipment type
                              <select
                                value={editState[job.id].equipmentType}
                                onChange={e => patchEdit(job.id, 'equipmentType', e.target.value)}
                                disabled={itemBusy}
                                style={{ display: 'block', marginTop: 4, width: '100%', padding: '6px 9px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)', fontWeight: 400 }}
                              >
                                {EQUIPMENT_TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </label>
                            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, flex: '1 1 140px' }}>
                              Serial number
                              <input value={editState[job.id].serialNumber} onChange={e => patchEdit(job.id, 'serialNumber', e.target.value)} disabled={itemBusy}
                                style={{ display: 'block', marginTop: 4, width: '100%', padding: '6px 9px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)', fontWeight: 400, boxSizing: 'border-box' }} />
                            </label>
                            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, flex: '1 1 140px' }}>
                              Manufacturer
                              <input value={editState[job.id].manufacturer} onChange={e => patchEdit(job.id, 'manufacturer', e.target.value)} disabled={itemBusy}
                                style={{ display: 'block', marginTop: 4, width: '100%', padding: '6px 9px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)', fontWeight: 400, boxSizing: 'border-box' }} />
                            </label>
                            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, flex: '1 1 140px' }}>
                              Model
                              <input value={editState[job.id].model} onChange={e => patchEdit(job.id, 'model', e.target.value)} disabled={itemBusy}
                                style={{ display: 'block', marginTop: 4, width: '100%', padding: '6px 9px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)', fontWeight: 400, boxSizing: 'border-box' }} />
                            </label>
                          </div>
                        )}
                        <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}>
                          Fix anything the parser got wrong, then Approve to save it correctly.
                        </div>
                      </div>
                    )}

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
                      <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        Site
                        <select
                          value={siteFor[job.id] || ''}
                          onChange={e => setSiteFor(s => ({ ...s, [job.id]: e.target.value }))}
                          disabled={itemBusy}
                          style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 'var(--font-size-xs)' }}
                        >
                          <option value="">Account default</option>
                          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </label>
                      <div style={{ flex: 1 }} />
                      {confirmReject === job.id ? (
                        <>
                          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>Discard this report?</span>
                          <button className="btn" onClick={() => reject(job)} disabled={itemBusy} style={{ color: 'var(--color-danger, #b91c1c)' }}>
                            {itemBusy ? 'Discarding…' : 'Yes, discard'}
                          </button>
                          <button className="btn" onClick={() => setConfirmReject(null)} disabled={itemBusy} aria-label="Cancel discard"><X size={14} /></button>
                        </>
                      ) : (
                        <>
                          {job.isSingleAsset && job.editable && (
                            <button className="btn" onClick={() => startEdit(job)} disabled={itemBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                              <Pencil size={13} aria-hidden="true" /> {openEdit === job.id ? 'Done editing' : 'Edit'}
                            </button>
                          )}
                          <button className="btn" onClick={() => setConfirmReject(job.id)} disabled={itemBusy}>Discard</button>
                          <button className="btn btn-primary" onClick={() => approve(job)} disabled={itemBusy} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {itemBusy ? <Loader2 size={14} style={{ animation: 'spin 0.9s linear infinite' }} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
                            Approve &amp; add
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 16 }}>
            Every approval and discard is recorded in the <Link to="/activity">activity log</Link>.
          </p>
        </>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
