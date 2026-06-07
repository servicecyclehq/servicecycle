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

const fatBtn = {
  boxSizing: 'border-box', width: '100%', minHeight: 56,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};

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
                  accept="image/jpeg,image/png,image/webp"
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
                display: 'flex', gap: 10, alignItems: 'center', padding: '12px 14px',
                borderBottom: i < openWOs.length - 1 ? '1px solid var(--color-border)' : 'none',
              }}>
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600, color: 'var(--color-text)' }}>
                  {wo.taskName || 'Work order'}
                </span>
                {meta && <Chip label={meta.label} color={meta.color} bg={meta.bg} />}
              </div>
            );
          })}
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
