// ─────────────────────────────────────────────────────────────────────────────
// FieldJob.jsx — the field-labor (field_tech / subcontractor) job card.
//
// What a sub sees after tapping a job or scanning a QR label. Deliberately lean
// and built ONLY on the assignment-scoped /api/field surface (a sub is
// default-denied off every other route): asset context (read), voice-first
// measurement capture, report-a-finding, and mark-complete. No pricing, no
// other customers, no manager-only features (LOTO / photo-inspect / OCR live on
// the full FieldAsset card, which non-field_tech roles get).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api/client';
import { fieldMutate } from '../../lib/fieldApi';
import Toast from '../../components/Toast';
import VoiceCaptureButton from '../../components/field/VoiceCaptureButton';
import { EQUIPMENT_TYPE_LABELS, CONDITION_META, SEVERITY_META, assetLabel } from '../../lib/equipment';

const fatBtn = {
  boxSizing: 'border-box', width: '100%', minHeight: 56,
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
  fontSize: 16, fontWeight: 700, borderRadius: 12, cursor: 'pointer',
  WebkitTapHighlightColor: 'transparent',
};
const fldLabel = {
  display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 4,
};
const fldCtrl = {
  width: '100%', padding: '10px', borderRadius: 10, fontSize: 15, boxSizing: 'border-box',
  border: '1px solid var(--color-border-strong, var(--color-border))',
  background: 'var(--color-surface)', color: 'var(--color-text)',
};

function Chip({ label, color, bg }) {
  return <span style={{ display: 'inline-block', padding: '4px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, color, background: bg }}>{label}</span>;
}
function Card({ title, accent, children }) {
  return (
    <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, marginBottom: 14, overflow: 'hidden' }}>
      <div style={{ padding: '12px 14px', fontWeight: 800, fontSize: 15, color: 'var(--color-text)', borderBottom: '1px solid var(--color-border)', borderLeft: accent ? `4px solid ${accent}` : 'none' }}>{title}</div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

// [NETA-8-4] Insulation resistance on MV cable / large transformers reads in GΩ–TΩ;
// without these options a tech is forced to enter a wrong value in MΩ.
// [NETA-8-12] Micro-ohm uses the MICRO SIGN U+00B5 (µΩ) to match how the test-report
// parser and the Python field library normalize it — a Greek-mu (U+03BC) here would
// split the same unit into two distinct strings and break trend matching.
const UNITS = ['TΩ', 'GΩ', 'MΩ', 'kΩ', 'Ω', 'µΩ', 'A', 'kV', 'V', 'ms', '°C', '%'];

export default function FieldJob() {
  const { id } = useParams(); // assetId (QR labels encode /field/asset/:assetId)
  const [asset, setAsset] = useState(null);
  const [openDefs, setOpenDefs] = useState([]);
  const [jobs, setJobs] = useState([]); // the sub's assigned WOs on THIS asset
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  // Measurement form
  const [woId, setWoId] = useState('');
  const [mType, setMType] = useState('insulation_resistance');
  const [mValue, setMValue] = useState('');
  const [mUnit, setMUnit] = useState('MΩ');
  const [mPass, setMPass] = useState(null); // 'pass' | 'fail'
  const [mBusy, setMBusy] = useState(false);

  // Deficiency form
  const [defSev, setDefSev] = useState(null);
  const [defDesc, setDefDesc] = useState('');
  const [defBusy, setDefBusy] = useState(false);

  const fetchAll = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get(`/api/field/asset/${id}`),
      api.get('/api/field/assignments'),
    ])
      .then(([cardRes, asgRes]) => {
        const card = cardRes.data?.data || {};
        setAsset(card.asset || null);
        setOpenDefs(card.openDeficiencies || []);
        const mine = (asgRes.data?.data?.assignments || []).filter((a) => a.asset?.id === id);
        setJobs(mine);
        if (mine.length === 1) setWoId(mine[0].id);
        setError(null);
      })
      .catch((err) => setError(
        err.response?.status === 404
          ? 'This job isn’t assigned to you, or the label is stale.'
          : (err.response?.data?.error || err.message || 'Failed to load job'),
      ))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Voice → prefill the measurement form (+ auto-pick the WO when the parse
  // resolved one). The tech reviews and taps Save — never auto-committed.
  function applyVoice({ proposal, asset: matched }) {
    if (!proposal) return;
    if (proposal.measurementType) setMType(proposal.measurementType);
    if (proposal.value != null) setMValue(String(proposal.value));
    if (proposal.unit) setMUnit(proposal.unit);
    if (proposal.passFail) setMPass(proposal.passFail === 'RED' ? 'fail' : 'pass');
    const matchedWO = matched?.openWorkOrders?.[0]?.id;
    if (matchedWO && jobs.some((j) => j.id === matchedWO)) setWoId(matchedWO);
    setToast({ message: 'Heard you — review and save.', variant: 'info' });
  }

  async function saveMeasurement() {
    if (mBusy || !woId || !mValue.trim()) return;
    setMBusy(true);
    try {
      const res = await fieldMutate({
        method: 'POST',
        url: `/api/field/work-orders/${woId}/measurements`,
        body: {
          measurementType: mType,
          asFoundValue: mValue.trim(),
          asFoundUnit: mUnit,
          passFail: mPass, // 'pass'/'fail' → server maps to GREEN/RED
        },
        meta: { label: `Measurement (${mType})`, assetId: id },
      });
      setMValue(''); setMPass(null);
      if (res?.queued) {
        setToast({ message: 'Saved offline — will sync when you\'re back online.', variant: 'warn' });
      } else {
        setToast({ message: 'Measurement recorded.', variant: 'success' });
      }
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to save measurement.', variant: 'error' });
    } finally { setMBusy(false); }
  }

  async function reportDeficiency() {
    if (defBusy || !defSev || !defDesc.trim()) return;
    setDefBusy(true);
    try {
      const res = await fieldMutate({
        method: 'POST',
        url: '/api/field/deficiencies',
        body: { assetId: id, severity: defSev, description: defDesc.trim() },
        meta: { label: `Deficiency (${defSev})`, assetId: id },
      });
      setDefSev(null); setDefDesc('');
      if (res?.queued) {
        setToast({ message: 'Saved offline — will sync when you\'re back online.', variant: 'warn' });
      } else {
        setToast({ message: 'Deficiency reported.', variant: 'success' });
        fetchAll();
      }
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to report deficiency.', variant: 'error' });
    } finally { setDefBusy(false); }
  }

  async function completeJob(jobId) {
    try {
      const res = await fieldMutate({
        method: 'POST',
        url: `/api/field/work-orders/${jobId}/complete`,
        body: {},
        meta: { label: 'Complete work order', assetId: id },
      });
      if (res?.queued) {
        setToast({ message: 'Saved offline — will sync when you\'re back online.', variant: 'warn' });
      } else {
        setToast({ message: 'Work order completed.', variant: 'success' });
        fetchAll();
      }
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to complete.', variant: 'error' });
    }
  }

  if (loading) return <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>Loading job…</div>;
  if (error) {
    return (
      <div>
        <div role="alert" style={{ padding: 14, borderRadius: 12, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 14, marginBottom: 14 }}>{error}</div>
        <Link to="/field" style={{ ...fatBtn, background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', textDecoration: 'none' }}>← My Jobs</Link>
      </div>
    );
  }
  if (!asset) return null;

  const gov = CONDITION_META[asset.governingCondition];
  const position = asset.position ? (asset.position.name || asset.position.code) : null;

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--color-text)', lineHeight: 1.25 }}>{assetLabel(asset)}</div>
        <div style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', marginTop: 3 }}>
          {EQUIPMENT_TYPE_LABELS[asset.equipmentType] || asset.equipmentType}
          {asset.site?.name ? ` · ${asset.site.name}` : ''}{position ? ` · ${position}` : ''}
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {gov && <Chip label={gov.label} color={gov.color} bg={gov.bg} />}
          <Chip label={asset.isEnergized === false ? 'De-energized' : '⚡ Energized'} color={asset.isEnergized === false ? '#64748b' : '#d97706'} bg={asset.isEnergized === false ? '#f1f5f9' : '#fffbeb'} />
        </div>
      </div>

      {/* Assigned work orders */}
      <Card title={`My work orders (${jobs.length})`} accent="var(--color-primary)">
        {jobs.length === 0 && <div style={{ fontSize: 13.5, color: 'var(--color-text-secondary)' }}>No open work orders assigned to you on this asset.</div>}
        {jobs.map((j) => (
          <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14.5 }}>{j.taskName || 'Work order'}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{j.status}</div>
            </div>
            <button type="button" onClick={() => completeJob(j.id)}
              style={{ ...fatBtn, width: 'auto', minWidth: 120, minHeight: 44, fontSize: 14, background: '#16a34a', color: '#fff', border: 'none' }}>
              ✓ Complete
            </button>
          </div>
        ))}
      </Card>

      {/* Record measurement — voice first */}
      <Card title="Record measurement" accent="#0d4f6e">
        <VoiceCaptureButton assetId={id} onParsed={applyVoice} disabled={jobs.length === 0} />

        {jobs.length > 1 && (
          <div style={{ marginBottom: 10 }}>
            <label style={fldLabel}>Work order</label>
            <select value={woId} onChange={(e) => setWoId(e.target.value)} style={fldCtrl}>
              <option value="">Select…</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.taskName || j.id.slice(-8)}</option>)}
            </select>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <label style={fldLabel}>Type</label>
            <select value={mType} onChange={(e) => setMType(e.target.value)} style={fldCtrl}>
              <option value="insulation_resistance">Insulation Resistance</option>
              <option value="contact_resistance">Contact Resistance</option>
              <option value="power_factor">Power Factor</option>
              <option value="load_current">Load Current</option>
              <option value="voltage">Voltage</option>
              <option value="temperature">Temperature</option>
              <option value="timing">Timing</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div>
            <label style={fldLabel}>Unit</label>
            <select value={mUnit} onChange={(e) => setMUnit(e.target.value)} style={fldCtrl}>
              {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={fldLabel}>As-found value</label>
          <input type="number" inputMode="decimal" value={mValue} onChange={(e) => setMValue(e.target.value)} placeholder="e.g. 68" style={fldCtrl} />
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={fldLabel}>Result</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {['pass', 'fail'].map((v) => (
              <button key={v} type="button" onClick={() => setMPass(mPass === v ? null : v)}
                style={{ flex: 1, padding: '10px 0', borderRadius: 10, fontWeight: 700, fontSize: 15, border: 'none', cursor: 'pointer',
                  background: mPass === v ? (v === 'pass' ? '#16a34a' : '#dc2626') : 'var(--color-border)',
                  color: mPass === v ? '#fff' : 'var(--color-text-secondary)' }}>
                {v === 'pass' ? '✓ Pass' : '✗ Fail'}
              </button>
            ))}
          </div>
        </div>
        <button type="button" onClick={saveMeasurement} disabled={mBusy || !woId || !mValue.trim()}
          style={{ ...fatBtn, background: (!woId || !mValue.trim()) ? 'var(--color-border)' : 'var(--color-primary)', color: (!woId || !mValue.trim()) ? 'var(--color-text-secondary)' : '#fff', border: 'none' }}>
          {mBusy ? 'Saving…' : 'Save measurement'}
        </button>
      </Card>

      {/* Report a finding */}
      <Card title="Report a finding" accent="#dc2626">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
          {['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'].map((sev) => {
            const meta = SEVERITY_META[sev]; const active = defSev === sev;
            return (
              <button key={sev} type="button" onClick={() => setDefSev(sev)} aria-pressed={active}
                style={{ minHeight: 52, borderRadius: 12, cursor: 'pointer', fontSize: 12, fontWeight: 800,
                  color: active ? '#fff' : meta.color, background: active ? meta.color : meta.bg, border: `2px solid ${meta.color}` }}>
                {meta.label}
              </button>
            );
          })}
        </div>
        <textarea value={defDesc} onChange={(e) => setDefDesc(e.target.value)} rows={3} placeholder="What did you find?"
          style={{ ...fldCtrl, resize: 'vertical', fontFamily: 'inherit', marginBottom: 10 }} />
        <button type="button" onClick={reportDeficiency} disabled={defBusy || !defSev || !defDesc.trim()}
          style={{ ...fatBtn, background: (!defSev || !defDesc.trim()) ? 'var(--color-border)' : '#dc2626', color: (!defSev || !defDesc.trim()) ? 'var(--color-text-secondary)' : '#fff', border: 'none' }}>
          {defBusy ? 'Submitting…' : 'Submit finding'}
        </button>
      </Card>

      {openDefs.length > 0 && (
        <Card title={`Open findings (${openDefs.length})`}>
          {openDefs.map((d) => {
            const meta = SEVERITY_META[d.severity];
            return (
              <div key={d.id} style={{ display: 'flex', gap: 10, padding: '8px 0', alignItems: 'flex-start' }}>
                {meta && <Chip label={meta.label} color={meta.color} bg={meta.bg} />}
                <span style={{ fontSize: 13.5, color: 'var(--color-text)' }}>{d.description}</span>
              </div>
            );
          })}
        </Card>
      )}

      <Link to="/field" style={{ ...fatBtn, background: 'var(--color-surface)', color: 'var(--color-text)', border: '1px solid var(--color-border)', textDecoration: 'none' }}>← My Jobs</Link>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
