// ─────────────────────────────────────────────────────────────────────────────
// FieldAsset.jsx — the Field Mode asset card (what a tech sees after scanning
// the QR label on the equipment). Phone-first, action-first ordering:
//
//   Header  — asset label, site · position, condition / in-service / energized
//             chips, fed-from line + downstream count.
//   (a) Tasks — each active schedule as a fat row; tapping opens a bottom-sheet
//       complete flow (optional "name / employer" + confirm) →
//       fieldMutate POST /api/schedules/:id/complete. {queued} → "Saved
//       offline — will sync" toast; online success → toast + refetch.
//   (b) Photo inspect — ONLINE ONLY (vision needs the network; never queued).
//       Gated on aiEnabled && aiConfigured && features.maintenance_brief, plus
//       navigator.onLine. Compact phone rendering of the same analysis shapes
//       PhotoInspectCard.jsx shows on desktop; no apply-flow on phone v1 —
//       links to the full site for review & apply.
//   (c) Report deficiency — 3 fat severity buttons + description, queueable
//       via fieldMutate POST /api/deficiencies.
//   (d) Open deficiencies + work orders — read-only lists.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api/client';
import { fieldMutate } from '../../lib/fieldApi';
import { useAuth } from '../../context/AuthContext';
import { useAiConsent } from '../../context/AiConsentContext';
import Toast from '../../components/Toast';
import {
  EQUIPMENT_TYPE_LABELS, CONDITION_META, SEVERITY_META, WO_STATUS_META,
  assetLabel, fmtDate,
} from '../../lib/equipment';

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Schedule status chips — same traffic-light convention as the desktop pages.
const SCHEDULE_STATUS_META = {
  current:     { label: 'Current',        color: '#16a34a', bg: '#f0fdf4' },
  overdue:     { label: 'Overdue',        color: '#dc2626', bg: '#fef2f2' },
  unbaselined: { label: 'Not baselined',  color: '#64748b', bg: '#f1f5f9' },
};

// Photo-observation severity chips — mirrors PhotoInspectCard's palette.
const OBS_SEVERITY_CHIPS = {
  normal:  { label: 'Normal',  color: '#334155', bg: '#e2e8f0' },
  monitor: { label: 'Monitor', color: '#92400e', bg: '#fef3c7' },
  concern: { label: 'Concern', color: '#991b1b', bg: '#fee2e2' },
};

function Chip({ label, color, bg, big }) {
  return (
    <span style={{
      display: 'inline-block', padding: big ? '5px 12px' : '3px 10px', borderRadius: 999,
      fontSize: big ? 13 : 12, fontWeight: 700, whiteSpace: 'nowrap',
      color, background: bg,
    }}>
      {label}
    </span>
  );
}

function SectionCard({ title, children, accent }) {
  return (
    <div style={{
      background: 'var(--color-surface)', border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg, 12px)', marginBottom: 14, overflow: 'hidden',
    }}>
      <div style={{
        padding: '12px 14px', fontWeight: 800, fontSize: 15, color: 'var(--color-text)',
        borderBottom: '1px solid var(--color-border)',
        borderLeft: accent ? `4px solid ${accent}` : 'none',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

const mFldLabel = {
  display: 'block', fontSize: 11, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.05em',
  color: 'var(--color-text-secondary)', marginBottom: 4,
};
const mFldCtrl = {
  width: '100%', padding: '10px 10px', borderRadius: 10, fontSize: 15,
  border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)',
  color: 'var(--color-text)', boxSizing: 'border-box',
};

const fatBtn = {
  boxSizing: 'border-box', width: '100%', minHeight: 56,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};

// ── Shared base style for small inline buttons ────────────────────────────
const btnBase = {
  cursor: 'pointer',
  borderRadius: 8,
  border: 'none',
  outline: 'none',
  fontFamily: 'inherit',
  fontWeight: 500,
  lineHeight: 1.2,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  WebkitTapHighlightColor: 'transparent',
};

// ── Leave-Behind PDF — field-friendly version ─────────────────────────────
function FieldLeaveBehindButton({ woId }) {
  const [busy, setBusy] = useState(false);
  async function generate() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/work-orders/${woId}/leave-behind-pdf`, { method: 'POST' });
      if (!res.ok) throw new Error('Server error');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `leave-behind-${woId.slice(-8).toUpperCase()}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      alert('Could not generate PDF. Please try again when online.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      type="button"
      onClick={generate}
      disabled={busy}
      style={{
        ...btnBase,
        background: 'var(--color-surface)', color: 'var(--color-text)',
        border: '1px solid var(--color-border)', fontSize: 13, padding: '8px 14px',
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? 'Generating…' : 'Leave-Behind PDF'}
    </button>
  );
}

// ── LOTO (lockout/tagout) — compact field read view ───────────────────────────
// Techs need the written procedure at the equipment, not back at the desk.
// Fetches the same GET /api/assets/:id/loto the desktop AssetLotoCard uses and
// renders ACTIVE procedures read-only: energy sources first (what to isolate),
// then the ordered steps. Drafts/archived are noted but not rendered — only an
// approved (active) procedure should be followed in the field.
const LOTO_CAT_LABELS = {
  shutdown: 'Shutdown', isolation: 'Isolation', lockout: 'Lockout',
  verify: 'Verify', restore: 'Restore', release: 'Release',
};
function FieldLotoSection({ assetId }) {
  const [procs, setProcs] = useState(null); // null = loading
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setProcs(null);
    setErr(null);
    api.get(`/api/assets/${assetId}/loto`)
      .then(r => {
        if (cancelled) return;
        const all = r.data?.data || [];
        setProcs(all);
        const active = all.filter(p => p.status === 'active');
        if (active.length === 1) setOpenId(active[0].id); // single proc opens itself
      })
      .catch(e => { if (!cancelled) setErr(e?.response?.data?.error || 'Failed to load LOTO procedures.'); });
    return () => { cancelled = true; };
  }, [assetId]);

  const active = (procs || []).filter(p => p.status === 'active');
  const drafts = (procs || []).filter(p => p.status === 'draft');

  return (
    <SectionCard title="🔒 Lockout / Tagout" accent="#ea580c">
      <div style={{ padding: 14 }}>
        {procs === null && !err && (
          <div style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>Loading procedures…</div>
        )}
        {err && (
          <div role="alert" style={{
            padding: '10px 12px', borderRadius: 10, fontSize: 13.5,
            background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b',
          }}>
            {err}
          </div>
        )}
        {procs !== null && !err && active.length === 0 && (
          <div style={{
            padding: '10px 12px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.5,
            background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
          }}>
            <strong>No approved LOTO procedure on file for this asset.</strong>{' '}
            Do not rely on memory — OSHA 1910.147 requires a written procedure.
            {drafts.length > 0 && ` (${drafts.length} draft${drafts.length !== 1 ? 's' : ''} pending approval on the full site.)`}
          </div>
        )}
        {active.map(p => {
          const open = openId === p.id;
          const sources = p.energySources || [];
          const steps = [...(p.steps || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
          return (
            <div key={p.id} style={{ border: '1px solid var(--color-border)', borderRadius: 12, marginBottom: 10, overflow: 'hidden' }}>
              <button
                type="button"
                onClick={() => setOpenId(open ? null : p.id)}
                aria-expanded={open}
                style={{
                  all: 'unset', boxSizing: 'border-box', cursor: 'pointer', width: '100%',
                  minHeight: 52, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10,
                  WebkitTapHighlightColor: 'transparent',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--color-text)' }}>{p.title}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    Rev {p.version || 1} · {sources.length} energy source{sources.length !== 1 ? 's' : ''} · {steps.length} step{steps.length !== 1 ? 's' : ''}
                  </div>
                </div>
                <Chip label="Active ✓" color="#15803d" bg="#f0fdf4" />
                <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)', fontSize: 13 }}>{open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div style={{ borderTop: '1px solid var(--color-border)', padding: '10px 12px', fontSize: 13.5 }}>
                  {sources.length > 0 && (
                    <>
                      <div style={{ fontWeight: 800, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                        ⚡ Energy sources to isolate
                      </div>
                      {sources.map((s2, i) => (
                        <div key={s2.id || i} style={{ padding: '6px 0', borderBottom: '1px solid var(--color-border)', lineHeight: 1.5 }}>
                          <div style={{ fontWeight: 600, color: 'var(--color-text)' }}>
                            {i + 1}. {s2.description}
                            <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}> ({s2.energyType})</span>
                          </div>
                          <div style={{ color: 'var(--color-text-secondary)', fontSize: 12.5 }}>
                            Isolate at <strong style={{ color: 'var(--color-text)' }}>{s2.isolationPoint}</strong> — {s2.isolationMethod}.
                            Verify: {s2.verificationMethod}
                          </div>
                        </div>
                      ))}
                    </>
                  )}
                  <div style={{ fontWeight: 800, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', margin: '12px 0 6px' }}>
                    📋 Steps — follow in order
                  </div>
                  {steps.map((st, i) => (
                    <div key={st.id || i} style={{ display: 'flex', gap: 10, padding: '6px 0', borderBottom: i < steps.length - 1 ? '1px solid var(--color-border)' : 'none' }}>
                      <span style={{
                        flexShrink: 0, width: 24, height: 24, borderRadius: 999,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 800,
                        background: 'var(--color-bg)', color: 'var(--color-text-secondary)',
                        border: '1px solid var(--color-border)',
                      }}>
                        {i + 1}
                      </span>
                      <div style={{ lineHeight: 1.5, minWidth: 0 }}>
                        <span style={{ color: 'var(--color-text)' }}>{st.instruction}</span>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 3 }}>
                          {st.category && <Chip label={LOTO_CAT_LABELS[st.category] || st.category} color="#475569" bg="#f1f5f9" />}
                          {st.requiresVerification && <Chip label="Verify & record" color="#92400e" bg="#fef3c7" />}
                        </div>
                      </div>
                    </div>
                  ))}
                  {p.notes && (
                    <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                      Notes: {p.notes}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

export default function FieldAsset() {
  const { id } = useParams();
  const { aiEnabled, aiConfigured, features } = useAuth();
  const { requestConsent } = useAiConsent();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  // Online state — gates the photo-inspect section (vision is online-only).
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', down); };
  }, []);

  // (a) Complete bottom-sheet state
  const [sheetSchedule, setSheetSchedule] = useState(null);
  const [performedBy, setPerformedBy] = useState('');
  const [completing, setCompleting] = useState(false);

  // (b) Photo inspect state
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoResult, setPhotoResult] = useState(null);
  const [photoError, setPhotoError] = useState(null);
  const photoInputRef = useRef(null);

  // (c) Report-deficiency state
  const [defSeverity, setDefSeverity] = useState(null);
  const [defDesc, setDefDesc] = useState('');
  const [defBusy, setDefBusy] = useState(false);

  // (d) Test measurement state
  const [measWoId,       setMeasWoId]       = useState('');
  const [measType,       setMeasType]       = useState('insulation_resistance');
  const [measPhase,      setMeasPhase]      = useState('A');
  const [measAfValue,    setMeasAfValue]    = useState('');
  const [measAfUnit,     setMeasAfUnit]     = useState('MΩ');
  const [measAlValue,    setMeasAlValue]    = useState('');
  const [measAlUnit,     setMeasAlUnit]     = useState('MΩ');
  const [measPassFail,   setMeasPassFail]   = useState(null); // 'pass' | 'fail'
  const [measBusy,       setMeasBusy]       = useState(false);

  // ── Nameplate OCR state ────────────────────────────────────────────────────
  const ocrInputRef = useRef(null);
  const [ocrBusy,    setOcrBusy]    = useState(false);
  const [ocrResult,  setOcrResult]  = useState(null);  // extracted fields object
  const [ocrError,   setOcrError]   = useState(null);
  const [ocrApplied, setOcrApplied] = useState(false);

  const fetchData = useCallback(() => {
    api.get(`/api/field/asset/${id}`)
      .then(r => { setData(r.data?.data || null); setError(null); })
      .catch(err => setError(
        err.response?.status === 404
          ? 'Asset not found — the QR label may be stale.'
          : (err.response?.data?.error || err.message || 'Failed to load asset')
      ))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { setLoading(true); setPhotoResult(null); setPhotoError(null); fetchData(); }, [fetchData]);

  const asset = data?.asset || null;
  const schedules = data?.activeSchedules || [];
  const openDefs = data?.openDeficiencies || [];
  const openWOs = data?.openWorkOrders || [];
  // Auto-select the only WO when there's exactly one
  useEffect(() => {
    if (openWOs.length === 1 && !measWoId) {
      setMeasWoId(openWOs[0].id);
    }
  }, [openWOs.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── (a) Complete flow ───────────────────────────────────────────────────────
  async function handleComplete() {
    if (!sheetSchedule || completing) return;
    setCompleting(true);
    const taskName = sheetSchedule.taskDefinition?.taskName || 'Maintenance task';
    try {
      const body = performedBy.trim() ? { performedByName: performedBy.trim() } : {};
      const res = await fieldMutate({
        method: 'POST',
        url: `/api/schedules/${sheetSchedule.id}/complete`,
        body,
        meta: { label: `Complete: ${taskName}`, assetId: id },
      });
      setSheetSchedule(null);
      setPerformedBy('');
      if (res?.queued) {
        setToast({ message: 'Saved offline — will sync when you’re back online.', variant: 'warn' });
      } else {
        setToast({ message: `${taskName} marked complete.`, variant: 'success', duration: 4000 });
        fetchData();
      }
    } catch (err) {
      setToast({
        message: err.response?.data?.error || err.response?.data?.message || err.message || 'Failed to complete task.',
        variant: 'error',
      });
    } finally {
      setCompleting(false);
    }
  }

  // ── (b) Photo inspect (online-only — never queued) ─────────────────────────
  const photoFeature = !!(features?.maintenance_brief && aiEnabled && aiConfigured);

  function handlePhotoPick(e) {
    const f = e.target.files?.[0];
    if (photoInputRef.current) photoInputRef.current.value = ''; // re-pick same file works
    if (!f) return;
    setPhotoError(null);
    if (!PHOTO_TYPES.includes(f.type)) {
      setPhotoError('Unsupported image type — use a JPEG, PNG, or WebP photo.');
      return;
    }
    if (f.size > MAX_PHOTO_BYTES) {
      setPhotoError(`Photo too large (${(f.size / 1024 / 1024).toFixed(1)}MB) — the limit is 10MB.`);
      return;
    }
    // Same consent flow as the desktop card — runs immediately if already
    // acknowledged, otherwise opens the app-level AiConsentModal first.
    requestConsent(() => runPhotoInspect(f));
  }

  async function runPhotoInspect(file) {
    if (!navigator.onLine) {
      setPhotoError('Photo inspect needs a connection — try again when you’re back online.');
      return;
    }
    setPhotoBusy(true);
    setPhotoError(null);
    setPhotoResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('assetId', id);
      const siteId = asset?.site?.id;
      if (siteId) fd.append('siteId', siteId);
      const res = await api.post('/api/assets/photo-inspect', fd);
      setPhotoResult(res.data?.data || null);
    } catch (err) {
      const status = err.response?.status;
      const d = err.response?.data;
      if (status === 429 && d?.error === 'ai_daily_cap_reached') {
        setPhotoError('Daily AI limit reached — try again tomorrow.');
      } else if (status === 429) {
        setPhotoError('Too many AI requests right now — try again shortly.');
      } else if (d?.error === 'ai_consent_required' || d?.error === 'ai_consent_outdated') {
        setPhotoError('AI consent needs re-acknowledging — pick the photo again and accept the dialog.');
      } else if (status === 413) {
        setPhotoError('The server rejected this photo as too large — try a smaller image.');
      } else if (status === 503) {
        setPhotoError(d?.message || 'AI is temporarily unavailable on this instance.');
      } else if (!err.response) {
        setPhotoError('Connection dropped — photo inspect needs a network. Try again when online.');
      } else {
        setPhotoError(d?.message || d?.error || err.message || 'Failed to analyze photo.');
      }
    } finally {
      setPhotoBusy(false);
    }
  }



  // ── Nameplate OCR ────────────────────────────────────────────────────────────
  function handleOcrPick(e) {
    const f = e.target.files?.[0];
    if (ocrInputRef.current) ocrInputRef.current.value = '';
    if (!f) return;
    setOcrError(null);
    setOcrResult(null);
    setOcrApplied(false);
    if (!PHOTO_TYPES.includes(f.type)) {
      setOcrError('Use a JPEG, PNG, or WebP photo.');
      return;
    }
    if (f.size > MAX_PHOTO_BYTES) {
      setOcrError(`Photo too large (${(f.size / 1024 / 1024).toFixed(1)}MB) — limit is 10MB.`);
      return;
    }
    runOcrNameplate(f);
  }

  async function runOcrNameplate(file) {
    if (!navigator.onLine) {
      setOcrError('Nameplate scan needs a connection.');
      return;
    }
    setOcrBusy(true);
    setOcrError(null);
    try {
      const fd = new FormData();
      fd.append('image', file);
      if (id) fd.append('assetId', id);
      const res = await api.post('/api/assets/ocr-nameplate', fd);
      setOcrResult(res.data?.data || null);
    } catch (err) {
      const d = err.response?.data;
      const status = err.response?.status;
      if (status === 503) setOcrError(d?.message || 'AI unavailable on this instance.');
      else if (status === 403) setOcrError('AI consent needed — re-open and accept the dialog.');
      else if (!err.response) setOcrError('Connection dropped — try again online.');
      else setOcrError(d?.error || err.message || 'Failed to read nameplate.');
    } finally {
      setOcrBusy(false);
    }
  }

  async function applyOcrToAsset() {
    if (!ocrResult || !id) return;
    const patch = {};
    if (ocrResult.manufacturer) patch.manufacturer = ocrResult.manufacturer;
    if (ocrResult.model)         patch.model        = ocrResult.model;
    if (ocrResult.serialNumber)  patch.serialNumber = ocrResult.serialNumber;
    if (!Object.keys(patch).length) return;
    try {
      await api.put(`/api/assets/${id}`, patch);
      setOcrApplied(true);
      setToast({ message: 'Asset updated from nameplate', type: 'success' });
      setTimeout(fetchData, 800);
    } catch {
      setToast({ message: 'Could not save — try again', type: 'error' });
    }
  }

  // ── (d) Add test measurement ────────────────────────────────────────────────
  async function handleAddMeasurement() {
    if (measBusy || !measWoId || !measAfValue.trim()) return;
    setMeasBusy(true);
    try {
      const payload = {
        measurementType: measType,
        phase:           measPhase,
        asFoundValue:    measAfValue.trim(),
        asFoundUnit:     measAfUnit,
        asLeftValue:     measAlValue.trim() || null,
        asLeftUnit:      measAlValue.trim() ? measAlUnit : null,
        passFail:        measPassFail,
      };
      const result = await fieldMutate({
        url:    `/api/work-orders/${measWoId}/measurements`,
        method: 'POST',
        body:   payload,
        meta:   { label: `Measurement (${measType})`, assetId: id },
      });
      if (result !== 'queued') {
        setMeasAfValue(''); setMeasAlValue(''); setMeasPassFail(null);
        setToast({ message: 'Measurement recorded.', type: 'success' });
        fetchData();
      } else {
        setToast({ message: 'Saved offline — will sync when online.', type: 'info' });
        setMeasAfValue(''); setMeasAlValue(''); setMeasPassFail(null);
      }
    } catch (err) {
      setToast({
        message: err.response?.data?.error || err.message || 'Failed to save measurement.',
        type: 'error',
      });
    } finally {
      setMeasBusy(false);
    }
  }

  // ── (c) Report deficiency (queueable) ──────────────────────────────────────
  async function handleReportDeficiency() {
    if (defBusy || !defSeverity || !defDesc.trim()) return;
    setDefBusy(true);
    try {
      const res = await fieldMutate({
        method: 'POST',
        url: '/api/deficiencies',
        body: { assetId: id, severity: defSeverity, description: defDesc.trim() },
        meta: { label: `Deficiency (${defSeverity})`, assetId: id },
      });
      setDefSeverity(null);
      setDefDesc('');
      if (res?.queued) {
        setToast({ message: 'Deficiency saved offline — will sync when you’re back online.', variant: 'warn' });
      } else {
        setToast({ message: 'Deficiency reported.', variant: 'success', duration: 4000 });
        fetchData();
      }
    } catch (err) {
      setToast({
        message: err.response?.data?.error || err.response?.data?.message || err.message || 'Failed to report deficiency.',
        variant: 'error',
      });
    } finally {
      setDefBusy(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading asset…</div>;
  }
  if (error) {
    return (
      <div>
        <div role="alert" style={{
          padding: '14px', borderRadius: 12, background: '#fef2f2',
          border: '1px solid #fecaca', color: '#991b1b', fontSize: 14, marginBottom: 14,
        }}>
          {error}
        </div>
        <Link to="/field" style={{ ...fatBtn, background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', textDecoration: 'none' }}>
          ← Back to My Day
        </Link>
      </div>
    );
  }
  if (!asset) return null;

  const govMeta = CONDITION_META[asset.governingCondition];
  const position = asset.position ? (asset.position.name || asset.position.code) : null;
  const analysis = photoResult?.analysis || null;
  const ident = analysis?.identification || {};
  const vis = analysis?.visibleCondition || {};
  const clues = analysis?.connectionClues || {};

  return (
    <div>
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text)', lineHeight: 1.25 }}>
          {assetLabel(asset)}
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', marginTop: 3 }}>
          {EQUIPMENT_TYPE_LABELS[asset.equipmentType] || asset.equipmentType}
          {asset.site?.name ? ` · ${asset.site.name}` : ''}
          {position ? ` · ${position}` : ''}
        </div>

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {govMeta && <Chip big label={govMeta.label} color={govMeta.color} bg={govMeta.bg} />}
          <Chip
            big
            label={asset.inService === false ? 'Out of service' : 'In service'}
            color={asset.inService === false ? '#64748b' : '#16a34a'}
            bg={asset.inService === false ? '#f1f5f9' : '#f0fdf4'}
          />
          <Chip
            big
            label={asset.isEnergized === false ? 'De-energized' : '⚡ Energized'}
            color={asset.isEnergized === false ? '#64748b' : '#d97706'}
            bg={asset.isEnergized === false ? '#f1f5f9' : '#fffbeb'}
          />
        </div>

        {(asset.fedFrom || asset.downstreamCount > 0) && (
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 10, lineHeight: 1.5 }}>
            {asset.fedFrom && (
              <>Fed from <strong style={{ color: 'var(--color-text)' }}>{assetLabel(asset.fedFrom)}</strong></>
            )}
            {asset.fedFrom && asset.downstreamCount > 0 && ' · '}
            {asset.downstreamCount > 0 && (
              <span style={{ color: '#d97706', fontWeight: 700 }}>
                affects {asset.downstreamCount} downstream
              </span>
            )}
          </div>
        )}
      </div>

      {/* ── (a) Tasks ──────────────────────────────────────────────────────── */}
      <SectionCard title="Tasks" accent="var(--color-primary)">
        {schedules.length === 0 && (
          <div style={{ padding: 14, fontSize: 13.5, color: 'var(--color-text-secondary)' }}>
            No active maintenance tasks on this asset.
          </div>
        )}
        {schedules.map((s, i) => {
          const meta = SCHEDULE_STATUS_META[s.status] || SCHEDULE_STATUS_META.current;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => { setSheetSchedule(s); setPerformedBy(''); }}
              style={{
                all: 'unset', boxSizing: 'border-box', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10, width: '100%',
                minHeight: 64, padding: '10px 14px',
                borderBottom: i < schedules.length - 1 ? '1px solid var(--color-border)' : 'none',
                WebkitTapHighlightColor: 'transparent',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text)', lineHeight: 1.3 }}>
                  {s.taskDefinition?.taskName || 'Maintenance task'}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 3, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span>Due {fmtDate(s.nextDueDate)}</span>
                  {s.taskDefinition?.requiresOutage && (
                    <span style={{ color: '#dc2626', fontWeight: 700 }}>⚠ outage required</span>
                  )}
                  {s.taskDefinition?.standardRef && <span>{s.taskDefinition.standardRef}</span>}
                </div>
              </div>
              <Chip label={meta.label} color={meta.color} bg={meta.bg} />
              <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)', fontSize: 18 }}>›</span>
            </button>
          );
        })}
      </SectionCard>

      {/* ── LOTO — written procedure at the equipment ──────────────────────── */}
      <FieldLotoSection assetId={id} />

      {/* ── (b) Photo inspect — ONLINE ONLY ────────────────────────────────── */}
      {photoFeature && (
        <SectionCard title="📷 Photo inspect">
          <div style={{ padding: 14 }}>
            {!online ? (
              <div style={{
                padding: '10px 12px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.5,
                background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e',
              }}>
                Photo inspect needs a connection — it&rsquo;ll be back when you&rsquo;re online.
              </div>
            ) : (
              <>
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={handlePhotoPick}
                  disabled={photoBusy}
                  style={{ display: 'none' }}
                  aria-label="Equipment photo"
                />
                {!photoBusy && (
                  <button
                    type="button"
                    onClick={() => photoInputRef.current?.click()}
                    style={{ ...fatBtn, background: 'var(--color-primary)', color: '#fff', border: 'none' }}
                  >
                    {analysis ? 'Take another photo' : '📷 Snap a photo to inspect'}
                  </button>
                )}
                {photoBusy && (
                  <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56, fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                    <span aria-hidden="true" style={{
                      width: 16, height: 16, border: '2.5px solid var(--color-border)',
                      borderTopColor: 'var(--color-primary)', borderRadius: '50%',
                      animation: 'fieldspin2 0.9s linear infinite',
                    }} />
                    <style>{'@keyframes fieldspin2 { to { transform: rotate(360deg); } }'}</style>
                    Reading the nameplate and inspecting…
                  </div>
                )}
                {photoError && !photoBusy && (
                  <div role="alert" style={{
                    marginTop: 10, padding: '10px 12px', borderRadius: 10,
                    background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13.5,
                  }}>
                    {photoError}
                  </div>
                )}

                {analysis && !photoBusy && (
                  <div style={{ marginTop: 12, fontSize: 13.5, color: 'var(--color-text)' }}>
                    {/* Identification — compact */}
                    <div style={{ fontWeight: 800, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                      Identification
                    </div>
                    {[
                      ['Type', ident.equipmentTypeGuess],
                      ['Mfr', ident.manufacturer],
                      ['Model', ident.model],
                      ['Serial', ident.serialNumber],
                    ].filter(([, v]) => v).map(([label, value]) => (
                      <div key={label} style={{ display: 'flex', gap: 8, padding: '2px 0' }}>
                        <span style={{ color: 'var(--color-text-secondary)', minWidth: 52 }}>{label}</span>
                        <span style={{ fontWeight: 600 }}>{String(value)}</span>
                      </div>
                    ))}

                    {/* Visible condition — compact */}
                    <div style={{ fontWeight: 800, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', margin: '12px 0 6px' }}>
                      Visible condition
                    </div>
                    {(vis.observations || []).length === 0 && (
                      <div style={{ color: 'var(--color-text-secondary)' }}>No visible findings reported.</div>
                    )}
                    {(vis.observations || []).map((o, i) => {
                      const c = OBS_SEVERITY_CHIPS[o.severity] || OBS_SEVERITY_CHIPS.normal;
                      return (
                        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '4px 0' }}>
                          <Chip label={c.label} color={c.color} bg={c.bg} />
                          <span style={{ lineHeight: 1.45 }}>{o.finding}</span>
                        </div>
                      );
                    })}
                    {(vis.suggestedConditionPhysical || vis.suggestedConditionEnvironment) && (
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                        {vis.suggestedConditionPhysical && CONDITION_META[vis.suggestedConditionPhysical] && (
                          <Chip
                            label={`Suggests phys ${vis.suggestedConditionPhysical}`}
                            color={CONDITION_META[vis.suggestedConditionPhysical].color}
                            bg={CONDITION_META[vis.suggestedConditionPhysical].bg}
                          />
                        )}
                        {vis.suggestedConditionEnvironment && CONDITION_META[vis.suggestedConditionEnvironment] && (
                          <Chip
                            label={`Suggests env ${vis.suggestedConditionEnvironment}`}
                            color={CONDITION_META[vis.suggestedConditionEnvironment].color}
                            bg={CONDITION_META[vis.suggestedConditionEnvironment].bg}
                          />
                        )}
                      </div>
                    )}

                    {/* Connection clues — compact */}
                    {((clues.visibleLabels || []).length > 0 || (clues.feedHints || []).length > 0) && (
                      <>
                        <div style={{ fontWeight: 800, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', margin: '12px 0 6px' }}>
                          Connection clues
                        </div>
                        {(clues.visibleLabels || []).length > 0 && (
                          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                            {clues.visibleLabels.map((l, i) => (
                              <span key={i} style={{
                                padding: '2px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600,
                                background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                                color: 'var(--color-text)',
                              }}>
                                {l}
                              </span>
                            ))}
                          </div>
                        )}
                        {(clues.feedHints || []).map((h, i) => (
                          <div key={i} style={{ color: 'var(--color-text-secondary)', lineHeight: 1.5, padding: '1px 0' }}>• {h}</div>
                        ))}
                      </>
                    )}

                    <div style={{
                      marginTop: 10, fontSize: 12, fontStyle: 'italic',
                      color: 'var(--color-text-secondary)', lineHeight: 1.5,
                    }}>
                      Visual assessment only — not a substitute for testing.
                    </div>
                    <Link
                      to={`/assets/${id}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', minHeight: 44, marginTop: 4,
                        color: 'var(--color-primary)', fontWeight: 700, fontSize: 13.5, textDecoration: 'none',
                      }}
                    >
                      Review &amp; apply on the full site →
                    </Link>
                  </div>
                )}
              </>
            )}
          </div>
        </SectionCard>
      )}

      {/* ── (c) Report deficiency ──────────────────────────────────────────── */}
      <SectionCard title="Report deficiency" accent="#dc2626">
        <div style={{ padding: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
            {['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'].map(sev => {
              const meta = SEVERITY_META[sev];
              const active = defSeverity === sev;
              return (
                <button
                  key={sev}
                  type="button"
                  onClick={() => setDefSeverity(sev)}
                  aria-pressed={active}
                  style={{
                    boxSizing: 'border-box', minHeight: 56, padding: '6px 4px',
                    borderRadius: 12, cursor: 'pointer',
                    fontSize: 12.5, fontWeight: 800, letterSpacing: '0.01em',
                    color: active ? '#fff' : meta.color,
                    background: active ? meta.color : meta.bg,
                    border: `2px solid ${meta.color}`,
                    WebkitTapHighlightColor: 'transparent',
                  }}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <textarea
            value={defDesc}
            onChange={e => setDefDesc(e.target.value)}
            placeholder="What did you find? (e.g. oil seep at lower gasket, breaker won't rack in…)"
            rows={3}
            aria-label="Deficiency description"
            style={{
              boxSizing: 'border-box', width: '100%', padding: 12, fontSize: 15,
              color: 'var(--color-text)', background: 'var(--color-bg)',
              border: '1px solid var(--color-border)', borderRadius: 12,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={handleReportDeficiency}
            disabled={defBusy || !defSeverity || !defDesc.trim()}
            style={{
              ...fatBtn, marginTop: 10, border: 'none',
              background: (!defSeverity || !defDesc.trim()) ? 'var(--color-border)' : '#dc2626',
              color: (!defSeverity || !defDesc.trim()) ? 'var(--color-text-secondary)' : '#fff',
              cursor: (defBusy || !defSeverity || !defDesc.trim()) ? 'default' : 'pointer',
              opacity: defBusy ? 0.7 : 1,
            }}
          >
            {defBusy ? 'Submitting…' : 'Submit deficiency'}
          </button>
        </div>
      </SectionCard>

      {/* ── (d) Read-only: open deficiencies + work orders ─────────────────── */}
      {openDefs.length > 0 && (
        <SectionCard title={`Open deficiencies (${openDefs.length})`}>
          {openDefs.map((d, i) => {
            const meta = SEVERITY_META[d.severity];
            return (
              <div key={d.id} style={{
                display: 'flex', gap: 10, alignItems: 'flex-start', padding: '12px 14px',
                borderBottom: i < openDefs.length - 1 ? '1px solid var(--color-border)' : 'none',
              }}>
                {meta && <Chip label={meta.label} color={meta.color} bg={meta.bg} />}
                <span style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--color-text)' }}>{d.description}</span>
              </div>
            );
          })}
        </SectionCard>
      )}

      {openWOs.length > 0 && (
        <SectionCard title={`Open work orders (${openWOs.length})`}>
          {openWOs.map((wo, i) => {
            const meta = WO_STATUS_META[wo.status];
            return (
              <div key={wo.id} style={{
                padding: '12px 14px',
                borderBottom: i < openWOs.length - 1 ? '1px solid var(--color-border)' : 'none',
              }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)' }}>
                    {wo.taskName || 'Work order'}
                  </span>
                  {meta && <Chip label={meta.label} color={meta.color} bg={meta.bg} />}
                </div>
                <FieldLeaveBehindButton woId={wo.id} />
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* ── (d) Test measurements — only shown when open WOs exist ─────── */}
      {openWOs.length > 0 && (
        <SectionCard title="Record measurement" accent="var(--color-primary)">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '6px 0' }}>
            {openWOs.length > 1 && (
              <div>
                <label style={mFldLabel}>Work Order</label>
                <select
                  value={measWoId}
                  onChange={(e) => setMeasWoId(e.target.value)}
                  style={mFldCtrl}
                >
                  <option value="">Select work order…</option>
                  {openWOs.map((wo) => (
                    <option key={wo.id} value={wo.id}>{wo.taskName || wo.id}</option>
                  ))}
                </select>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={mFldLabel}>Type</label>
                <select value={measType} onChange={(e) => setMeasType(e.target.value)} style={mFldCtrl}>
                  <option value="insulation_resistance">Insulation Resistance</option>
                  <option value="contact_resistance">Contact Resistance</option>
                  <option value="power_factor">Power Factor / Tan δ</option>
                  <option value="load_current">Load Current</option>
                  <option value="voltage">Voltage</option>
                  <option value="temperature">Temperature (IR)</option>
                  <option value="timing">Timing</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label style={mFldLabel}>Phase</label>
                <select value={measPhase} onChange={(e) => setMeasPhase(e.target.value)} style={mFldCtrl}>
                  {['A','B','C','A-B','B-C','A-C','3-phase','N/A'].map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
              <div>
                <label style={mFldLabel}>As-Found Value</label>
                <input
                  type="number" inputMode="decimal"
                  value={measAfValue} onChange={(e) => setMeasAfValue(e.target.value)}
                  placeholder="e.g. 1200" style={mFldCtrl}
                />
              </div>
              <div>
                <label style={mFldLabel}>Unit</label>
                <select value={measAfUnit} onChange={(e) => setMeasAfUnit(e.target.value)} style={mFldCtrl}>
                  {['MΩ','kΩ','Ω','μΩ','A','kV','V','ms','°C','%','W','kVA'].map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
              <div>
                <label style={mFldLabel}>As-Left Value <span style={{ fontWeight: 400 }}>(optional)</span></label>
                <input
                  type="number" inputMode="decimal"
                  value={measAlValue} onChange={(e) => setMeasAlValue(e.target.value)}
                  placeholder="After service" style={mFldCtrl}
                />
              </div>
              <div>
                <label style={mFldLabel}>Unit</label>
                <select value={measAlUnit} onChange={(e) => setMeasAlUnit(e.target.value)} style={mFldCtrl}>
                  {['MΩ','kΩ','Ω','μΩ','A','kV','V','ms','°C','%','W','kVA'].map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label style={mFldLabel}>Pass / Fail</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {['pass', 'fail'].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setMeasPassFail(measPassFail === v ? null : v)}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 10, fontWeight: 700,
                      fontSize: 15, border: 'none', cursor: 'pointer',
                      background: measPassFail === v
                        ? (v === 'pass' ? '#16a34a' : '#dc2626')
                        : 'var(--color-border)',
                      color: measPassFail === v ? '#fff' : 'var(--color-text-secondary)',
                      transition: 'background 0.15s',
                    }}
                  >
                    {v === 'pass' ? '✓ Pass' : '✗ Fail'}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={handleAddMeasurement}
              disabled={measBusy || !measWoId || !measAfValue.trim()}
              style={{
                ...fatBtn,
                background: (!measWoId || !measAfValue.trim()) ? 'var(--color-border)' : 'var(--color-primary)',
                color: (!measWoId || !measAfValue.trim()) ? 'var(--color-text-secondary)' : '#fff',
                cursor: (measBusy || !measWoId || !measAfValue.trim()) ? 'default' : 'pointer',
                marginTop: 4,
              }}
            >
              {measBusy ? 'Saving…' : 'Save Measurement'}
            </button>
          </div>
        </SectionCard>
      )}

      <Link
        to="/field"
        style={{
          ...fatBtn, background: 'var(--color-surface)', color: 'var(--color-text)',
          border: '1px solid var(--color-border)', textDecoration: 'none', marginTop: 4,
        }}
      >
        ← Back to My Day
      </Link>

      {/* ── (e) Nameplate OCR ────────────────────────────────────────────────── */}
      <SectionCard title="Scan nameplate" accent="#7c3aed">
        <input
          ref={ocrInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={handleOcrPick}
          disabled={ocrBusy}
          style={{ display: 'none' }}
          aria-label="Nameplate photo"
        />

        {!ocrBusy && !ocrResult && (
          <button
            type="button"
            onClick={() => ocrInputRef.current?.click()}
            style={{ ...fatBtn, background: '#7c3aed', color: '#fff', border: 'none' }}
          >
            📷 Scan nameplate
          </button>
        )}

        {ocrBusy && (
          <div role="status" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, minHeight: 56, fontSize: 14.5, fontWeight: 600, color: 'var(--color-text-secondary)' }}>
            <span aria-hidden="true" style={{
              width: 16, height: 16, border: '2.5px solid var(--color-border)',
              borderTopColor: '#7c3aed', borderRadius: '50%',
              animation: 'fieldspin2 0.9s linear infinite',
            }} />
            Reading nameplate…
          </div>
        )}

        {ocrError && !ocrBusy && (
          <div role="alert" style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, background: '#fee2e2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 13.5 }}>
            {ocrError}
            <button type="button" onClick={() => { setOcrError(null); ocrInputRef.current?.click(); }}
              style={{ marginLeft: 10, fontSize: 12, color: '#991b1b', textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer' }}>
              Try again
            </button>
          </div>
        )}

        {ocrResult && !ocrBusy && (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 8 }}>
              Extracted fields
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
              <tbody>
                {[
                  ['Manufacturer',    ocrResult.manufacturer],
                  ['Model',           ocrResult.model],
                  ['Serial No.',      ocrResult.serialNumber],
                  ['Voltage',         ocrResult.voltage],
                  ['kVA',             ocrResult.kva != null ? String(ocrResult.kva) : null],
                  ['Amperage',        ocrResult.amperage],
                  ['Phases',          ocrResult.phases != null ? String(ocrResult.phases) : null],
                  ['Frequency',       ocrResult.frequency],
                  ['Mfg. Year',       ocrResult.year != null ? String(ocrResult.year) : null],
                  ['Enclosure',       ocrResult.enclosureRating],
                ].filter(([, v]) => v).map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ padding: '4px 0', color: 'var(--color-text-secondary)', width: '38%', verticalAlign: 'top' }}>{label}</td>
                    <td style={{ padding: '4px 0', fontWeight: 600 }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              {!ocrApplied && (ocrResult.manufacturer || ocrResult.model || ocrResult.serialNumber) && (
                <button
                  type="button"
                  onClick={applyOcrToAsset}
                  style={{ ...fatBtn, background: '#7c3aed', color: '#fff', border: 'none', flex: '1 1 auto' }}
                >
                  Apply to asset
                </button>
              )}
              {ocrApplied && (
                <div style={{ padding: '10px 14px', borderRadius: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', fontSize: 13.5, fontWeight: 600, flex: '1 1 auto', textAlign: 'center' }}>
                  ✓ Asset updated
                </div>
              )}
              <button
                type="button"
                onClick={() => { setOcrResult(null); setOcrApplied(false); setOcrError(null); ocrInputRef.current?.click(); }}
                style={{ ...fatBtn, background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text)', flex: '0 0 auto' }}
              >
                Rescan
              </button>
            </div>
          </div>
        )}
      </SectionCard>

      {/* ── Bottom-sheet: complete task ────────────────────────────────────── */}
      {sheetSchedule && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Complete task"
          style={{ position: 'fixed', inset: 0, zIndex: 200 }}
        >
          <div
            onClick={() => !completing && setSheetSchedule(null)}
            style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }}
          />
          <div style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            background: 'var(--color-surface)', borderRadius: '18px 18px 0 0',
            padding: '18px 16px calc(18px + env(safe-area-inset-bottom, 0px))',
            maxWidth: 560, margin: '0 auto', boxSizing: 'border-box',
            boxShadow: '0 -8px 30px rgba(0,0,0,0.3)',
          }}>
            <div aria-hidden="true" style={{
              width: 44, height: 5, borderRadius: 999, background: 'var(--color-border)',
              margin: '0 auto 14px',
            }} />
            <div style={{ fontWeight: 800, fontSize: 17, color: 'var(--color-text)', lineHeight: 1.3 }}>
              {sheetSchedule.taskDefinition?.taskName || 'Maintenance task'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 4, marginBottom: 14 }}>
              Due {fmtDate(sheetSchedule.nextDueDate)}
              {sheetSchedule.lastCompletedDate ? ` · last done ${fmtDate(sheetSchedule.lastCompletedDate)}` : ''}
              {sheetSchedule.taskDefinition?.requiresOutage ? ' · ⚠ outage required' : ''}
            </div>

            <label htmlFor="field-performed-by" style={{
              display: 'block', fontSize: 13, fontWeight: 700,
              color: 'var(--color-text-secondary)', marginBottom: 6,
            }}>
              Performed by (optional)
            </label>
            <input
              id="field-performed-by"
              value={performedBy}
              onChange={e => setPerformedBy(e.target.value)}
              placeholder="name / employer"
              disabled={completing}
              style={{
                boxSizing: 'border-box', width: '100%', minHeight: 52, padding: '0 14px',
                fontSize: 16, color: 'var(--color-text)', background: 'var(--color-bg)',
                border: '1px solid var(--color-border)', borderRadius: 12,
                outline: 'none', marginBottom: 14,
              }}
            />

            <button
              type="button"
              onClick={handleComplete}
              disabled={completing}
              style={{
                ...fatBtn, minHeight: 60, border: 'none',
                background: '#16a34a', color: '#fff', opacity: completing ? 0.7 : 1,
              }}
            >
              {completing ? 'Saving…' : '✓ Mark complete'}
            </button>
            <button
              type="button"
              onClick={() => setSheetSchedule(null)}
              disabled={completing}
              style={{
                ...fatBtn, marginTop: 10, background: 'transparent',
                color: 'var(--color-text-secondary)', border: '1px solid var(--color-border)',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
