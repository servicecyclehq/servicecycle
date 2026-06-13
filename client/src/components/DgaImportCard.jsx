// ─────────────────────────────────────────────────────────────────────────────
// DgaImportCard.jsx — #28 transformer-oil DGA import.
//
// Paste a lab report (text) or type the gas ppm values, Preview the IEEE
// C57.104 condition + key-gas fault, then Save — which records a LabSample and
// auto-creates a deficiency past Condition 1. Shown on transformer assets.
//
// Props: { assetId, canWrite, onChanged }
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import api from '../api/client';

const GASES = [
  ['h2', 'H2'], ['ch4', 'CH4'], ['c2h2', 'C2H2'], ['c2h4', 'C2H4'],
  ['c2h6', 'C2H6'], ['co', 'CO'], ['co2', 'CO2'], ['o2', 'O2'], ['n2', 'N2'],
];
const RATING = { GREEN: { c: '#15803d', t: 'Condition 1 — normal' }, YELLOW: { c: '#92400e', t: 'Condition 2 — caution' }, RED: { c: '#b91c1c', t: 'Condition 3/4 — action' } };

export default function DgaImportCard({ assetId, canWrite, onChanged }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [vals, setVals] = useState({});
  const [sampleDate, setSampleDate] = useState(new Date().toISOString().slice(0, 10));
  const [evalResult, setEval] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  function setGas(k, v) { setVals((p) => ({ ...p, [k]: v })); }
  function body() {
    const gases = {};
    for (const [k] of GASES) if (vals[k] !== '' && vals[k] != null) gases[k] = vals[k];
    return { gases, sampleDate, reportText: text.trim() || undefined };
  }

  async function preview() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/api/assets/${assetId}/dga/preview`, body());
      setEval(r.data?.data?.evaluation || null);
      // backfill gases parsed from text so the user sees what was read
      const g = r.data?.data?.gases || {};
      setVals((p) => ({ ...g, ...p }));
    } catch (e) {
      setMsg(e?.response?.data?.error || 'Could not read that report');
    } finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setMsg(null);
    try {
      const r = await api.post(`/api/assets/${assetId}/dga/commit`, body());
      const ev = r.data?.data?.evaluation;
      setMsg(`Saved — IEEE C57.104 Condition ${ev?.overallCondition}${r.data?.data?.deficiencyCreated ? ' (deficiency logged)' : ''}.`);
      setEval(null); setVals({}); setText(''); setOpen(false);
      onChanged && onChanged();
    } catch (e) {
      setMsg(e?.response?.data?.error || 'Could not save the result');
    } finally { setBusy(false); }
  }

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="card-title" style={{ flex: 1 }}>Oil / DGA result</div>
        {canWrite && <button className="btn btn-secondary btn-sm" onClick={() => setOpen((o) => !o)}>{open ? 'Cancel' : '+ Import DGA'}</button>}
      </div>
      {open && canWrite && (
        <div className="card-body">
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Paste lab report text (optional)</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Paste the DGA report — gas values are read automatically"
            style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13, marginBottom: 12 }} />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {GASES.map(([k, label]) => (
              <div key={k} style={{ width: 90 }}>
                <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600 }}>{label} (ppm)</label>
                <input type="number" value={vals[k] ?? ''} onChange={(e) => setGas(k, e.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13 }} />
              </div>
            ))}
            <div style={{ width: 140 }}>
              <label style={{ fontSize: 11, color: 'var(--color-text-secondary)', fontWeight: 600 }}>Sample date</label>
              <input type="date" value={sampleDate} onChange={(e) => setSampleDate(e.target.value)} style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid var(--color-border)', fontSize: 13 }} />
            </div>
          </div>
          {evalResult && (
            <div style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 8, background: '#f8fafc', border: '1px solid var(--color-border)', fontSize: 13.5 }}>
              <strong style={{ color: RATING[evalResult.resultRating]?.c }}>{RATING[evalResult.resultRating]?.t || `Condition ${evalResult.overallCondition}`}</strong>
              {' '}· TDCG {Math.round(evalResult.tdcg)} ppm{evalResult.faultLabel ? ` · ${evalResult.faultLabel} (${evalResult.faultCode})` : ''}
            </div>
          )}
          {msg && <div style={{ marginBottom: 10, fontSize: 13, color: '#0a0d12' }}>{msg}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" disabled={busy} onClick={preview}>{busy ? '…' : 'Preview condition'}</button>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save result'}</button>
          </div>
        </div>
      )}
      {!open && msg && <div className="card-body" style={{ fontSize: 13, color: '#15803d' }}>{msg}</div>}
    </div>
  );
}
