// ─────────────────────────────────────────────────────────────────────────────
// ThermographyImportCard.jsx — #29 IR thermography capture (NFPA 70B §7.4).
//
// Hybrid capture: attach the vendor's IR report PDF, let the parser pre-fill
// what it can read, then confirm/complete the survey header and per-finding
// rows by hand. Saving writes a structured ThermographySurvey + one finding per
// hot spot (below-threshold ones included, for trending) and stores the PDF as
// evidence.
//
// Fields the parser could not read are flagged "not found — enter manually"
// rather than left silently blank, so a §7.4 record isn't quietly incomplete.
//
// Props: { assetId, canWrite, onChanged }
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from 'react';
import api from '../api/client';

const SEV_COLOR = { IMMEDIATE: 'var(--chip-red-fg)', RECOMMENDED: 'var(--chip-amber-fg)', ADVISORY: 'var(--chip-slate-fg)' };

// Confidence at or below this is treated as "the parser guessed" and the field
// is flagged for the tech to confirm.
const LOW_CONFIDENCE = 0.5;

const HEADER_FIELDS = [
  { key: 'thermographerName', label: 'Thermographer',      type: 'text',   placeholder: 'Name' },
  { key: 'thermographerQual', label: 'Qualification',      type: 'text',   placeholder: 'e.g. NETA Level II' },
  { key: 'cameraMake',        label: 'Camera make',        type: 'text',   placeholder: 'e.g. FLIR' },
  { key: 'cameraModel',       label: 'Camera model',       type: 'text',   placeholder: 'e.g. T540' },
  { key: 'ambientTempC',      label: 'Ambient °C',         type: 'number', placeholder: '24.5' },
  { key: 'humidityPct',       label: 'Humidity %',         type: 'number', placeholder: '45' },
  { key: 'emissivity',        label: 'Emissivity',         type: 'number', placeholder: '0.95' },
  { key: 'reflectedTempC',    label: 'Reflected °C',       type: 'number', placeholder: '22.0' },
  { key: 'loadPercent',       label: 'Load % at scan',     type: 'number', placeholder: '78' },
];

const EMPTY_HEADER = HEADER_FIELDS.reduce((acc, f) => ({ ...acc, [f.key]: '' }), { notes: '' });

const REFERENCE_OPTIONS = [
  { value: 'similar',  label: 'Similar component' },
  { value: 'ambient',  label: 'Over ambient' },
  { value: 'baseline', label: 'Vs. baseline' },
];

const inputStyle = {
  width: '100%', padding: '6px 8px', borderRadius: 6,
  border: '1px solid var(--color-border)', fontSize: 13,
};

export default function ThermographyImportCard({ assetId, canWrite, onChanged }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rows, setRows] = useState([{ component: '', deltaT: '', reference: 'similar', referenceDeltaT: '', loadPercent: '' }]);
  const [surveyDate, setSurveyDate] = useState(new Date().toISOString().slice(0, 10));
  const [header, setHeader] = useState(EMPTY_HEADER);
  const [confidence, setConfidence] = useState({});
  const [graded, setGraded] = useState(null);
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  function setRow(i, k, v) { setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r))); }
  function setHeaderField(k, v) { setHeader((p) => ({ ...p, [k]: v })); }

  function reset() {
    setRows([{ component: '', deltaT: '', reference: 'similar', referenceDeltaT: '', loadPercent: '' }]);
    setText(''); setHeader(EMPTY_HEADER); setConfidence({}); setGraded(null);
    setFile(null); if (fileRef.current) fileRef.current.value = '';
  }

  // The JSON body shared by preview and commit.
  function payload() {
    const hotspots = rows
      .filter((r) => r.deltaT !== '' && r.deltaT != null)
      .map((r) => ({
        location:        r.component || 'Unspecified location',
        component:       r.component || 'Unspecified location',
        deltaT:          Number(r.deltaT),
        reference:       r.reference || 'similar',
        referenceDeltaT: r.referenceDeltaT === '' ? null : Number(r.referenceDeltaT),
        loadPercent:     r.loadPercent === '' ? null : Number(r.loadPercent),
      }));
    const hdr = {};
    for (const f of HEADER_FIELDS) {
      const v = header[f.key];
      if (v !== '' && v != null) hdr[f.key] = f.type === 'number' ? Number(v) : v;
    }
    if (header.notes) hdr.notes = header.notes;
    return { hotspots, surveyDate, reportText: text.trim() || undefined, header: hdr };
  }

  async function preview() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const r = await api.post(`/api/assets/${assetId}/thermography/preview`, payload());
      const d = r.data?.data || {};
      setGraded(d.hotspots || []);
      setConfidence(d.confidence || {});
      // Pre-fill the header form from the parse, but never clobber something
      // the tech already typed.
      if (d.header) {
        setHeader((prev) => {
          const next = { ...prev };
          for (const f of HEADER_FIELDS) {
            const parsed = d.header[f.key];
            if ((next[f.key] === '' || next[f.key] == null) && parsed != null) next[f.key] = String(parsed);
          }
          return next;
        });
      }
      if (d.surveyDate) setSurveyDate(d.surveyDate);
      // Adopt parsed hot-spots into the editable grid so they can be corrected
      // before saving (the parser is best-effort, the record is not).
      if (Array.isArray(d.hotspots) && d.hotspots.length) {
        setRows(d.hotspots.map((h) => ({
          component:       h.location || h.component || '',
          deltaT:          h.deltaT ?? '',
          reference:       h.reference || 'similar',
          referenceDeltaT: h.referenceDeltaT ?? '',
          loadPercent:     h.loadPercent ?? '',
        })));
      }
      setMsg('Parsed — confirm the highlighted fields, then save.');
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not read that report');
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setErr(null); setMsg(null);
    try {
      let r;
      if (file) {
        // Multipart: the JSON body travels in `payload`, the PDF in `file`.
        const fd = new FormData();
        fd.append('file', file);
        fd.append('payload', JSON.stringify(payload()));
        r = await api.post(`/api/assets/${assetId}/thermography/commit`, fd);
      } else {
        r = await api.post(`/api/assets/${assetId}/thermography/commit`, payload());
      }
      const d = r.data?.data || {};
      const bits = [
        `${d.findingsCreated ?? 0} finding(s) recorded`,
        `${d.deficienciesCreated ?? 0} deficiency(ies) created`,
      ];
      if (d.belowThreshold > 0) bits.push(`${d.belowThreshold} below threshold (kept for trending)`);
      bits.push(d.evidenceAttached ? 'IR report attached as evidence' : 'no evidence attached');
      setMsg(`Survey saved — ${bits.join(' · ')}.`);
      reset();
      setOpen(false);
      onChanged && onChanged();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Could not save the survey');
    } finally { setBusy(false); }
  }

  // A field is flagged when the parser ran (we have some confidence data) and
  // this field came back missing or low-confidence while still empty.
  function flagged(key) {
    if (!graded) return false;
    const c = confidence[key];
    return (header[key] === '' || header[key] == null) && (c == null || c <= LOW_CONFIDENCE);
  }

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="card-title" style={{ flex: 1 }}>IR thermography survey</div>
        {canWrite && (
          <button className="btn btn-secondary btn-sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Cancel' : '+ Import IR survey'}
          </button>
        )}
      </div>

      {open && canWrite && (
        <div className="card-body">
          {/* 1 — evidence */}
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>
            1 · Attach the IR report (PDF)
          </label>
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ fontSize: 13, marginBottom: 4 }}
          />
          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Stored as evidence on this asset (§7.4). The thermal images stay inside the report. Max 20 MB.
          </div>

          {/* 2 — parse source */}
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>
            2 · Paste the report text to pre-fill (optional)
          </label>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="Paste the survey — lines with a temperature rise (ΔT) become hot-spots, and the header (camera, emissivity, ambient, load) is read where present"
            style={{ ...inputStyle, marginBottom: 12, fontFamily: 'inherit' }}
          />

          {/* 3 — survey header */}
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 6 }}>
            3 · Survey conditions (NFPA 70B §7.4)
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8, marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: 2 }}>Survey date</div>
              <input type="date" value={surveyDate} onChange={(e) => setSurveyDate(e.target.value)} style={inputStyle} />
            </div>
            {HEADER_FIELDS.map((f) => (
              <div key={f.key}>
                <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600, marginBottom: 2 }}>
                  {f.label}
                </div>
                <input
                  type={f.type}
                  step={f.type === 'number' ? 'any' : undefined}
                  value={header[f.key]}
                  placeholder={f.placeholder}
                  onChange={(e) => setHeaderField(f.key, e.target.value)}
                  style={{
                    ...inputStyle,
                    borderColor: flagged(f.key) ? 'var(--chip-amber-fg)' : 'var(--color-border)',
                  }}
                />
                {flagged(f.key) && (
                  <div style={{ fontSize: 10, color: 'var(--chip-amber-fg)', marginTop: 2 }}>
                    Not found in the report — enter manually
                  </div>
                )}
              </div>
            ))}
          </div>
          <textarea
            value={header.notes}
            onChange={(e) => setHeaderField('notes', e.target.value)}
            rows={2}
            placeholder="Survey notes (optional)"
            style={{ ...inputStyle, marginBottom: 12, fontFamily: 'inherit' }}
          />

          {/* 4 — findings */}
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 6 }}>
            4 · Findings — every row is recorded, including below-threshold ones
          </label>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
              <input
                value={r.component}
                onChange={(e) => setRow(i, 'component', e.target.value)}
                placeholder="Component (e.g. Panel 3, Phase B lug)"
                style={{ ...inputStyle, flex: '2 1 180px', width: 'auto' }}
              />
              <input
                type="number" step="any" value={r.deltaT}
                onChange={(e) => setRow(i, 'deltaT', e.target.value)}
                placeholder="ΔT °C"
                style={{ ...inputStyle, flex: '0 0 84px', width: 'auto' }}
              />
              <select
                value={r.reference}
                onChange={(e) => setRow(i, 'reference', e.target.value)}
                style={{ ...inputStyle, flex: '1 1 140px', width: 'auto' }}
              >
                {REFERENCE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
              <input
                type="number" step="any" value={r.referenceDeltaT}
                onChange={(e) => setRow(i, 'referenceDeltaT', e.target.value)}
                placeholder="Ref ΔT"
                style={{ ...inputStyle, flex: '0 0 84px', width: 'auto' }}
              />
              <input
                type="number" step="any" value={r.loadPercent}
                onChange={(e) => setRow(i, 'loadPercent', e.target.value)}
                placeholder="Load %"
                style={{ ...inputStyle, flex: '0 0 84px', width: 'auto' }}
              />
              {rows.length > 1 && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => setRows((p) => p.filter((_, j) => j !== i))}
                  title="Remove this row"
                >×</button>
              )}
            </div>
          ))}
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setRows((p) => [...p, { component: '', deltaT: '', reference: 'similar', referenceDeltaT: '', loadPercent: '' }])}
            style={{ marginBottom: 12 }}
          >+ Add row</button>

          {graded && graded.length > 0 && (
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                NETA Table 100.18 grading
              </div>
              {graded.map((g, i) => (
                <div key={i} style={{ padding: '4px 0', borderTop: '1px solid var(--color-border)' }}>
                  <strong style={{ color: SEV_COLOR[g.severity] || '#64748b' }}>{g.severity || 'Below threshold'}</strong>
                  {' '}· {g.location} — ΔT {g.deltaT}°C{' '}
                  <span style={{ color: 'var(--color-text-secondary)' }}>({g.label})</span>
                </div>
              ))}
            </div>
          )}

          {err && <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--color-danger)' }}>{err}</div>}
          {msg && <div style={{ marginBottom: 10, fontSize: 13 }}>{msg}</div>}

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={preview}>
              {busy ? '…' : 'Preview / parse'}
            </button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>
              {busy ? 'Saving…' : 'Save survey'}
            </button>
          </div>
        </div>
      )}

      {!open && msg && <div className="card-body" style={{ fontSize: 13, color: 'var(--chip-green-fg)' }}>{msg}</div>}
    </div>
  );
}
