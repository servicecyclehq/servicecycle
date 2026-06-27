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

const DOT = { high: 'var(--chip-green-fg)', medium: 'var(--chip-amber-fg)', low: 'var(--chip-red-fg)' };
const LABEL = { high: 'AI confident', medium: 'double-check', low: 'verify / enter' };

// Tiny inline spinner (reuses the global `spin` keyframe) for active button states.
function Spinner({ size = 14, color = '#fff' }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: size, height: size, verticalAlign: '-2px', marginRight: 7,
      border: `2px solid ${color}`, borderTopColor: 'transparent', borderRadius: '50%',
      opacity: 0.9, animation: 'spin 0.7s linear infinite',
    }} />
  );
}

export default function NameplateReview({ assetId, assetLabel, onClose, onSaved }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [values, setValues] = useState(null);       // { field: value }
  const [conf, setConf] = useState({});             // { field: high|medium|low }
  const [touched, setTouched] = useState({});       // fields the tech edited → verified
  const [remaining, setRemaining] = useState(null); // preview scans left today (null = unlimited)
  const [capped, setCapped] = useState(false);      // hit the preview scan cap

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  // Read the per-user nameplate-scan quota so we can show "N preview scans left"
  // before they tap, and the BYO-AI wall once they're out.
  useEffect(() => {
    api.get('/api/ai/usage/me')
      .then(r => {
        const n = r.data?.data?.actions?.nameplate_scan?.remaining;
        if (typeof n === 'number') { setRemaining(n); if (n <= 0) setCapped(true); }
      })
      .catch(() => {});
  }, []);

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
      if (typeof d.scansRemaining === 'number') setRemaining(d.scansRemaining);
    } catch (err) {
      const s = err.response?.status; const e = err.response?.data;
      if (s === 429 && e?.error === 'ai_daily_cap_reached') { setCapped(true); setRemaining(0); }
      else if (s === 503) setError(e?.message || 'AI is unavailable on this instance right now.');
      else if (s === 429) setError('Too many requests right now — try again in a moment.');
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
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Scan nameplate</div>
          <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Saving to <strong style={{ color: 'var(--color-text)' }}>{assetLabel || 'this asset'}</strong>
          </div>
        </div>

        <div style={{ padding: 20, overflowY: 'auto' }}>
          {!values && capped && (
            <div style={{ padding: '6px 0' }}>
              <div style={{ background: '#faf5ff', border: '1px solid #e9d5ff', color: '#6b21a8', borderRadius: 10, padding: '16px 18px', fontSize: 14, lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>You've used your preview nameplate scans.</div>
                Nameplate AI runs on <strong>your own AI key</strong> — your data, your provider, your control. Connect one in <strong>Settings → AI</strong> to scan without limits (free provider options work too). You can still type the fields in by hand below — no AI required.
              </div>
            </div>
          )}
          {!values && !capped && (
            <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
              <div style={{ background: 'var(--chip-blue-bg)', border: '1px solid var(--chip-blue-fg)', color: 'var(--chip-blue-fg)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16, textAlign: 'left' }}>
                Take or upload a photo of the equipment nameplate. <strong>AI will read it and ask you to review the fields before anything is saved</strong> — so a bad read never silently lands on the asset.
              </div>
              {preview && <img src={preview} alt="Nameplate photo to be read" style={{ maxWidth: '100%', maxHeight: 220, borderRadius: 8, marginBottom: 14, border: '1px solid var(--color-border)' }} />}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment" onChange={pick} style={{ display: 'none' }} />
              <button onClick={() => fileRef.current?.click()} disabled={busy} style={btnPrimary}>
                {busy ? <><Spinner />Reading nameplate…</> : preview ? 'Choose a different photo' : '📷 Take / upload photo'}
              </button>
              {remaining != null && (
                <div style={{ marginTop: 10, fontSize: 12, color: remaining <= 1 ? 'var(--chip-amber-fg)' : 'var(--color-text-secondary)' }}>
                  {remaining} preview scan{remaining === 1 ? '' : 's'} left today
                </div>
              )}
            </div>
          )}

          {values && (
            <>
              <div style={{ display: 'flex', gap: 14, marginBottom: 14, flexWrap: 'wrap' }}>
                {preview && <img src={preview} alt="Scanned nameplate being reviewed" style={{ width: 150, height: 112, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--color-border)' }} />}
                <div style={{ flex: '1 1 220px', fontSize: 13, color: 'var(--color-text)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>Review before saving</div>
                  {flagged > 0
                    ? <span><span style={{ color: 'var(--chip-amber-fg)', fontWeight: 600 }}>{flagged} field{flagged === 1 ? '' : 's'}</span> the AI wasn’t fully sure about — confirm or fix them, then save. Editing a field marks it verified (green).</span>
                    : <span>The AI was confident on every field. Give them a glance and save.</span>}
                  <div style={{ marginTop: 8, display: 'flex', gap: 12, fontSize: 11, color: 'var(--color-text-secondary)' }}>
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
                      <label style={{ flex: '0 0 96px', fontSize: 12, color: 'var(--color-text-secondary)', fontWeight: 600 }}>{label}</label>
                      <input
                        value={values[k] ?? ''} onChange={e => setField(k, e.target.value)}
                        placeholder={c === 'low' ? 'not found — enter manually' : ''}
                        style={{ flex: 1, padding: '7px 10px', borderRadius: 6, fontSize: 14,
                          border: `1px solid ${c === 'low' ? 'var(--chip-red-fg)' : c === 'medium' ? 'var(--chip-amber-fg)' : 'var(--color-border)'}`,
                          background: c === 'low' ? 'var(--chip-red-bg)' : 'var(--color-surface)' }} />
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {error && <div style={{ marginTop: 12, color: 'var(--chip-red-fg)', fontSize: 13, background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', borderRadius: 8, padding: '8px 12px' }}>{error}</div>}
        </div>

        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--color-border)', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button onClick={onClose} disabled={busy} style={btnGhost}>Cancel</button>
          {values && <button onClick={() => { setValues(null); setPreview(p => { if (p) URL.revokeObjectURL(p); return null; }); setFile(null); }} disabled={busy} style={btnGhost}>Rescan</button>}
          {values && <button onClick={save} disabled={busy} style={btnPrimary}>{busy ? <><Spinner />Saving…</> : 'Confirm & save to asset'}</button>}
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
const modal = { background: 'var(--color-surface)', borderRadius: 14, width: 'min(560px, 100%)', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,.3)' };
const btnPrimary = { padding: '9px 16px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
const btnGhost = { padding: '9px 16px', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', fontWeight: 600, fontSize: 14, cursor: 'pointer' };
