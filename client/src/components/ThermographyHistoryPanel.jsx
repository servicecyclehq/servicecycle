// ─────────────────────────────────────────────────────────────────────────────
// ThermographyHistoryPanel.jsx — #29 IR survey history for one asset (§7.4).
//
// Lists surveys newest-first with their findings and the conditions each was
// taken under, plus a per-component trend so a joint that is heating up survey
// over survey is visible at a glance. Below-threshold findings are shown too —
// they carry no deficiency but they are the trend.
//
// A manager can also delete a survey outright (undo an accidental/duplicate
// import — see DUPE-IR-1) — this removes the survey, its findings, and every
// deficiency they spawned, server-side; see the DELETE route added alongside
// this in server/routes/thermographyIngest.ts.
//
// Props: { assetId, refreshKey, canWrite, onChanged }
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import api from '../api/client';
import { fmtDate } from '../lib/equipment';
import { useConfirm } from '../context/ConfirmContext';

const SEV_COLOR = { IMMEDIATE: 'var(--chip-red-fg)', RECOMMENDED: 'var(--chip-amber-fg)', ADVISORY: 'var(--chip-slate-fg)' };
const REF_LABEL = { AMBIENT: 'over ambient', SIMILAR: 'vs. similar', BASELINE: 'vs. baseline' };

/** Direction of travel between the two most recent readings for a component. */
function TrendArrow({ points }) {
  if (!points || points.length < 2) {
    return <span style={{ color: 'var(--color-text-secondary)' }} title="Only one reading — no trend yet">·</span>;
  }
  const last = points[points.length - 1]?.deltaT;
  const prev = points[points.length - 2]?.deltaT;
  if (last == null || prev == null) return <span style={{ color: 'var(--color-text-secondary)' }}>·</span>;
  const delta = last - prev;
  // A 1 °C wobble between surveys is measurement noise, not a trend.
  if (Math.abs(delta) < 1) {
    return <span style={{ color: 'var(--color-text-secondary)' }} title={`Stable (${prev}°C → ${last}°C)`}>→ stable</span>;
  }
  const worse = delta > 0;
  return (
    <span
      style={{ color: worse ? 'var(--color-danger)' : 'var(--chip-green-fg)', fontWeight: 700 }}
      title={`${prev}°C → ${last}°C`}
    >
      {worse ? '▲' : '▼'} {worse ? '+' : ''}{delta.toFixed(1)}°C
    </span>
  );
}

/** Open the attached IR report. Documents are served through a presigned URL
 *  (GET /api/documents/:id/url) — a bare href would carry no bearer token.
 *  Mirrors components/AssetDocumentsCard.jsx:207-209. */
async function openEvidence(documentId) {
  try {
    const { data } = await api.get(`/api/documents/${documentId}/url`);
    const href = data.data?.url || data.data?.apiPath;
    if (href) window.open(href, '_blank', 'noopener');
  } catch (_e) {
    /* the survey row stays usable even if the evidence link fails */
  }
}

function conditionLine(s) {
  const bits = [];
  if (s.thermographerName) bits.push(s.thermographerQual ? `${s.thermographerName} (${s.thermographerQual})` : s.thermographerName);
  if (s.cameraMake || s.cameraModel) bits.push([s.cameraMake, s.cameraModel].filter(Boolean).join(' '));
  if (s.ambientTempC != null) bits.push(`ambient ${s.ambientTempC}°C`);
  if (s.humidityPct != null) bits.push(`RH ${s.humidityPct}%`);
  if (s.emissivity != null) bits.push(`ε ${s.emissivity}`);
  if (s.reflectedTempC != null) bits.push(`reflected ${s.reflectedTempC}°C`);
  if (s.loadPercent != null) bits.push(`load ${s.loadPercent}%`);
  return bits.join(' · ');
}

export default function ThermographyHistoryPanel({ assetId, refreshKey, canWrite, onChanged }) {
  const confirm = useConfirm();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [delErr, setDelErr] = useState(null);

  const load = useCallback(() => {
    let alive = true;
    setLoading(true);
    api.get(`/api/assets/${assetId}/thermography/history`)
      .then((r) => { if (alive) { setData(r.data?.data || null); setError(null); } })
      .catch((e) => {
        if (!alive) return;
        // 403 = the account doesn't have the surface on; the card above is
        // already hidden in that case, so stay silent rather than alarm.
        if (e?.response?.status === 403) setData(null);
        else setError(e?.response?.data?.error || 'Could not load IR history');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [assetId]);

  useEffect(() => load(), [load, refreshKey]);

  async function handleDelete(survey) {
    setDelErr(null);
    const findingCount = (survey.findings || []).length;
    if (!await confirm({
      title: 'Delete this IR survey?',
      message: `Deletes the ${fmtDate(survey.surveyDate)} survey, its ${findingCount} finding${findingCount === 1 ? '' : 's'}, and every deficiency it created. This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    setDeletingId(survey.id);
    try {
      await api.delete(`/api/assets/${assetId}/thermography/surveys/${survey.id}`);
      load();
      onChanged && onChanged();
    } catch (e) {
      setDelErr(e?.response?.data?.error || 'Could not delete this survey');
    } finally {
      setDeletingId(null);
    }
  }

  if (loading) return null;
  if (error) {
    return (
      <div className="card mb-16">
        <div className="card-header"><div className="card-title">IR survey history</div></div>
        <div className="card-body" style={{ fontSize: 13, color: 'var(--color-danger)' }}>{error}</div>
      </div>
    );
  }
  const surveys = data?.surveys || [];
  const trends  = (data?.trends || []).filter((t) => t.points && t.points.length > 1);
  if (surveys.length === 0) return null;

  return (
    <div className="card mb-16">
      <div className="card-header">
        <div className="card-title">IR survey history</div>
        <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
          {surveys.length} survey{surveys.length === 1 ? '' : 's'} · NFPA 70B §7.4
        </div>
      </div>
      <div className="card-body">

        {delErr && (
          <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--color-danger)' }}>{delErr}</div>
        )}

        {trends.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
              Component trend (latest vs. previous survey)
            </div>
            {trends.map((t) => (
              <div key={t.component} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '3px 0', fontSize: 13 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t.component}
                </span>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>
                  {t.points.map((p) => (p.deltaT == null ? '—' : `${p.deltaT}°`)).join(' → ')}
                </span>
                <TrendArrow points={t.points} />
              </div>
            ))}
          </div>
        )}

        {surveys.map((s) => (
          <div key={s.id} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 'var(--font-size-ui)' }}>{fmtDate(s.surveyDate)}</strong>
              {s.sourceDocumentId && (
                <button
                  type="button"
                  className="btn-link"
                  style={{ fontSize: 11, background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--color-primary)' }}
                  title={s.sourceDocument?.filename || 'Attached IR report'}
                  onClick={() => openEvidence(s.sourceDocumentId)}
                >
                  IR report (evidence)
                </button>
              )}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {(s.findings || []).length} finding{(s.findings || []).length === 1 ? '' : 's'}
              </span>
              {canWrite && (
                <button
                  type="button"
                  className="btn-link"
                  disabled={deletingId === s.id}
                  style={{ fontSize: 11, background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--color-danger)' }}
                  title="Delete this survey, its findings, and the deficiencies it created"
                  onClick={() => handleDelete(s)}
                >
                  {deletingId === s.id ? 'Deleting…' : 'Delete'}
                </button>
              )}
            </div>

            {conditionLine(s) && (
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 2 }}>
                {conditionLine(s)}
              </div>
            )}
            {s.notes && (
              <div style={{ fontSize: 12, marginTop: 4, fontStyle: 'italic' }}>{s.notes}</div>
            )}

            <div style={{ marginTop: 6 }}>
              {(s.findings || []).map((f) => (
                <div key={f.id} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 13, flexWrap: 'wrap' }}>
                  <strong style={{ color: SEV_COLOR[f.severity] || 'var(--color-text-secondary)', minWidth: 96 }}>
                    {f.severity || 'Below thr.'}
                  </strong>
                  <span style={{ flex: 1, minWidth: 120 }}>{f.component}</span>
                  <span style={{ fontWeight: 600 }}>ΔT {f.deltaT}°C</span>
                  <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>
                    {REF_LABEL[f.referenceType] || ''}
                    {f.loadPercent != null ? ` · load ${f.loadPercent}%` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
