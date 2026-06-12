// ─────────────────────────────────────────────────────────────────────────────
// NameplateReview.jsx — scan a nameplate, AI parses it with per-field
// confidence, the tech verifies the red/yellow/green fields, THEN it saves.
//
// Flow:  pick/take photo → POST /api/assets/:id/ocr-nameplate (values +
//        confidence) → review form (each field flagged green/yellow/red) →
//        POST /api/assets/:id/nameplate (reviewed values + confidence + photo).
//
// Human-in-the-loop on purpose: nothing is written to the asset until the tech
// confirms. Editing a flagged field promotes it to "verified" (green). The
// asset being written to is shown in bold up top so a wrong-asset attach is
// caught before it happens (the asset card also offers delete-and-rescan).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef, useEffect } from 'react';
import api from '../api/client';

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

const FIELDS = [
  ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['serialNumber', 'Serial #'],
  ['voltage', 'Voltage'], ['kva', 'kVA'], ['amperage', 'Amperage'],
  ['phases', 'Phases'], ['frequency', 'Frequency'], ['year', 'Year'],
  ['enclosureRating', 'Enclosure'],
];

const DOT = { high: '#16a34a', medium: '#d97706', low: '#dc2626' };
const LABEL = { high: 'AI confident', medium: 'double-check', low: 'verify / enter' };

export default function NameplateReview({ assetId, assetLabel, onClose, onSaved }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [values, setValues] = useState(null);       // { field: value }
  const [conf, setConf] = useState({});             // { field: high|medium|low }
  const [touched, setTouched] = useState({});       // fields the tech edited → verified

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  function pick(e) {
    const f = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!f) return;
    setError(null);
    if (!PHOTO_TYPES.includes(f.type)) { setError('Use a JPEG, PNG, or WebP photo. (iPhone HEIC: Settings → Camera → Formats → Most Compatible.)'); return; }
    if (f.size > MAX_BYTES) { setError(`Photo too large (${(f.size / 1024 / 1024).toFixed(1)}MB) — limit is 10MB.`); return; }
    setFile(f);
    setPreview(p => { if (p) URL.revokeObjectURL(p); return URL.createObjectURL(f); });
    runScan(f);
  }

  async function runScan(f) {
    setBusy(true); setError(null); setValues(null);
    try {
      const fd = new FormData();
      fd.append('image', f);
      if (assetId) fd.append('assetId', assetId);
      const res = await api.post('/api/assets/ocr-nameplate', fd);
      const d = res.data?.data || {};
      const fields = d.fields || {};
      setValues(Object.fromEntries(FIELDS.map(([k]) => [k, fields[k] ?? ''])));
      setConf(d.confidence || {});
      setTouched({});
    } catch (err) {
      const s = err.response?.status; const e = err.response?.data;
      if (s === 503) setError(e?.message || 'AI is unavailable on this instance right now.');
      else if (s === 429) setError('Daily AI limit reached — try again later, or enter the fields by hand.');
      else if (e?.error === 'ai_consent_required' || e?.error === 'ai_consent_outdated') setError('AI consent needed — accept the dialog and rescan.');
      else setError(e?.message || e?.error || 'Could not read that photo — try a clearer, straight-on shot.');
    } finally { setBusy(false); }
  }

  function setField(k, v) { setValues(p => ({ ...p, [k]: v })); setTouched(p => ({ ...p, [k]: true })); }
  function effConf(k) { return touched[k] ? 'high' : (conf[k] || (values?.[k] ? 'medium' : 'low')); }

  async function save() {
    setBusy(true); setError(null);
    try {
      const cleanVals = {}; const cleanConf = {};
      for (const [k] of FIELDS) {
        const v = values[k];
        if (v !== '' && v != null) { cleanVals[k] = v; cleanConf[k] = effConf(k); }
      }
      const fd = new FormData();
      if (file) fd.append('image', file);
      fd.append('fields', JSON.stringify(cleanVals));
      fd.append('confidence', JSON.stringify(cleanConf));
      const res = await api.post(`/api/assets/${assetId}/nameplate`, fd);
      onSaved?.(res.data?.data?.nameplateData || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to save — try again.');
      setBusy(false);
    }
  }

  const flagged = values ? FIELDS.filter(([k]) => values[k] && effConf(k) !== 'high').length : 0;

  return (
    <div style={ov} onClick={onClose}>
      <div style={modal} onClick={e => e.stopPropagation()}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Scan nameplate</div>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 2 }}>
            Saving to <strong style={{ color: '#111827' }}>{assetLabel || 'this asset'}</strong>
          </div>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {!values && (
            <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
              <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16, textAlign: 'left' }}>
                Take or upload a photo of the equipment nameplate. <strong>AI will read it and ask you to review the fields before anything is saved</strong> — so a bad read never silently lands on the asset.
              </div>
              {preview && <img src={preview} alt="" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, marginBottom: 14, border: '1px solid #e5e7eb' }} />}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={pick} style={{ display: 'none' }} />
              <button onClick={() => fileRef.current?.click()} disabled={busy} style={btnPrimary}>
                {busy ? 'Reading nameplate…' : preview ? 'Choose a different photo' : '📷 Take / upload photo'}
              </button>
            </div>
          )}

          {values && (
            <>
              <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
                {preview && <img src={preview} alt="" style={{ width: 150, height: 112, objectFit: 'cover', borderRadius: 8, border: '1px solid #e5e7eb' }} />}
                <div style={{ flex: '1 1 220px', fontSize: 13, color: '#374151' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Review before saving</div>
                  {flagged > 0
                    ? <span><span style={{ color: '#d97706', fontWeight: 600 }}>{flagged} field{flagged === 1 ? '' : 's'}</span> the AI wasn’t fully sure about — confirm or fix them, then save. Editing a field marks it verified (green).</span>
                    : <span>The AI was confident on every field. Give them a glance and save.</span>}
                  <div style={{ marginTop: 8, display: 'flex', gap: 12, fontSize: 11, color: '#6b7280' }}>
                    <Legend c="high" /> <Legend c="medium" /> <Legend c="low" />
                  </div>
                </div>
              </div>

              <div>
                {FIELDS.map(([k, label]) => {
                  const c = effConf(k);
                  return (
                    <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                      <span title={LABEL[c]} style={{ flex: '0 0 10px', width: 10, height: 10, borderRadius: 999, background: DOT[c] }} />
                      <label style={{ flex: '0 0 96px', fontSize: 12, color: '#6b7280', fontWeight: 600 }}>{label}</label>
                      <input
                        value={values[k] ?? ''} onChange={e => setField(k, e.target.value)}
                        placeholder={c === 'low' ? 'not found — enter manually' : ''}
                        style={{ flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 14,
                          border: `1px solid ${c === 'low' ? '#fca5a5' : c === 'medium' ? '#fcd34d' : '#d1d5db'}`,
                          background: c === 'low' ? '#fef2f2' : '#fff' }} />
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {error && <div style={{ marginTop: 12, color: '#b91c1c', fontSize: 13, background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px' }}>{error}</div>}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
          {values && <button onClick={() => { setValues(null); setPreview(p => { if (p) URL.revokeObjectURL(p); return null; }); setFile(null); }} disabled={busy} style={btnGhost}>Rescan</button>}
          {values && <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? 'Saving…' : 'Confirm & save to asset'}</button>}
        </div>
      </div>
    </div>
  );
}

function Legend({ c }) {
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span style={{ width: 8, height: 8, borderRadius: 999, background: DOT[c] }} /> {LABEL[c]}
  </span>;
}

const ov = { position: 'fixed', inset: 0, background: 'rgba(17,24,39,.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 16 };
const modal = { background: '#fff', borderRadius: 14, width: 'min(560px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' };
const btnPrimary = { padding: '9px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const btnGhost = { padding: '9px 16px', borderRadius: 8, border: '1px solid #d1d5db', background: '#fff', color: '#374151', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
