// ─────────────────────────────────────────────────────────────────────────────
// ThermographyImportCard.jsx — #29 IR thermography import.
//
// Paste an IR survey report (hot-spots are read line by line) and/or add rows
// by hand, Preview the NETA Table 100.18 severity per hot-spot, then Save —
// which logs a deficiency for each hot-spot above threshold on this asset.
//
// Props: { assetId, canWrite, onChanged }
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import api from '../api/client';

const SEV_COLOR = { IMMEDIATE: '#b91c1c', RECOMMENDED: '#92400e', ADVISORY: '#64748b' };

export default function ThermographyImportCard({ assetId, canWrite, onChanged }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [rows, setRows] = useState([{ location: '', deltaT: '' }]);
  const [surveyDate, setSurveyDate] = useState(new Date().toISOString().slice(0, 10));
  const [graded, setGraded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  function setRow(i, k, v) { setRows((p) => p.map((r, j) => (j === i ? { ...r, [k]: v } : r))); }
  function body() {
    const hotspots = rows.filter((r) => r.deltaT !== '' && r.deltaT != null).map((r) => ({ location: r.location || 'Unspecified location', deltaT: Number(r.deltaT) }));
    return { hotspots, surveyDate, reportText: text.trim() || undefined };
  }

  async function preview() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/api/assets/${assetId}/thermography/preview`, body());
      setGraded(r.data?.data?.hotspots || []);
    } catch (e) {
      setMsg(e?.response?.data?.error || 'Could not read that report');
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/api/assets/${assetId}/thermography/commit`, body());
      const d = r.data?.data;
      setMsg(`Logged ${d?.hotspotsLogged} hot-spot(s) — ${d?.deficienciesCreated} deficiency(ies) created.`);
      setGraded(null); setRows([{ location: '', deltaT: '' }]); setText(''); setOpen(false);
      onChanged && onChanged();
    } catch (e) {
      setMsg(e?.response?.data?.error || 'Could not save the survey');
    } finally { setBusy(false); }
  }

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="card-title" style={{ flex: 1 }}>IR thermography survey</div>
        {canWrite && <button className="btn btn-secondary btn-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : '+ Import IR survey'}</button>}
      </div>
      {open && canWrite && (
        <div className="card-body">
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Paste IR report text (optional)</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Paste the survey — lines with a temperature rise (ΔT) become hot-spots"
            style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13, marginBottom: 12 }} />

          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Or add hot-spots by hand</label>
          {rows.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <input value={r.location} onChange={(e) => setRow(i, 'location', e.target.value)} placeholder="Location (e.g. Panel 3, Phase B lug)"
                style={{ flex: 1, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13 }} />
              <input type="number" value={r.deltaT} onChange={(e) => setRow(i, 'deltaT', e.target.value)} placeholder="ΔT °C"
                style={{ width: 90, padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13 }} />
            </div>
          ))}
          <button className="btn btn-secondary btn-sm" onClick={() => setRows((p) => [...p, { location: '', deltaT: '' }])} style={{ marginBottom: 12 }}>+ Add row</button>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600, marginRight: 8 }}>Survey date</label>
            <input type="date" value={surveyDate} onChange={(e) => setSurveyDate(e.target.value)} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13 }} />
          </div>

          {graded && graded.length > 0 && (
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              {graded.map((g, i) => (
                <div key={i} style={{ padding: '4px 0', borderTop: '1px solid var(--color-border)' }}>
                  <strong style={{ color: SEV_COLOR[g.severity] || '#64748b' }}>{g.severity || 'OK'}</strong>
                  {' '}· {g.location} — ΔT {g.deltaT}°C <span style={{ color: 'var(--color-text-secondary)' }}>({g.label})</span>
                </div>
              ))}
            </div>
          )}
          {msg && <div style={{ marginBottom: 10, fontSize: 13 }}>{msg}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={preview}>{busy ? '…' : 'Preview severity'}</button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save survey'}</button>
          </div>
        </div>
      )}
      {!open && msg && <div className="card-body" style={{ fontSize: 13, color: '#15803d' }}>{msg}</div>}
    </div>
  );
}
