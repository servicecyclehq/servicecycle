// ─────────────────────────────────────────────────────────────────────────────
// TestReportImport.jsx — staged PDF test-report ingest (gem R1, the moat).
// Upload a PowerDB/Megger/NETA test-report PDF → preview the extracted
// measurements (human-in-the-loop) → commit to TestMeasurements + auto-created
// deficiencies → land on the fix-it list. "We read the report nobody reads and
// hand back the to-do list."
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FileText, UploadCloud, CheckCircle2 } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { takePendingImport } from '../lib/pendingImport';

const PF_COLORS = { GREEN: '#15803d', YELLOW: '#92400e', RED: '#b91c1c' };

export default function TestReportImport() {
  useDocumentTitle('Import Test Report');

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [assets, setAssets] = useState([]);
  const [assetId, setAssetId] = useState('');
  const [testDate, setTestDate] = useState('');
  const [vendor, setVendor] = useState('');
  const [techName, setTechName] = useState('');
  const [result, setResult] = useState(null);

  useEffect(() => {
    api.get('/api/assets').then(r => {
      const d = r.data?.data;
      const list = Array.isArray(d) ? d : (d?.assets || d?.items || []);
      setAssets(list.map(a => ({ id: a.id, label: [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || a.serialNumber || a.id, serial: a.serialNumber })));
    }).catch(() => {});
  }, []);

  async function previewFile(file) {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api.post('/api/test-reports/import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const d = res.data.data;
      setPreview(d);
      setRows(d.measurements.map(m => ({ ...m, include: true })));
      setAssetId(d.assetMatch?.id || '');
      setTestDate(d.meta?.testDate || new Date().toISOString().slice(0, 10));
      setVendor(d.meta?.vendor || '');
      setTechName(d.meta?.techName || '');
      setStep(2);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to read the PDF');
    } finally { setBusy(false); }
  }

  function onFile(e) { previewFile(e.target.files?.[0]); }

  // W2: if the "Add data" door handed us a file, preview it automatically.
  useEffect(() => { const f = takePendingImport(); if (f) previewFile(f); }, []);

  function setRow(i, patch) { setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }

  async function commit() {
    if (!assetId) { setError('Pick the asset this report belongs to'); return; }
    const chosen = rows.filter(r => r.include);
    if (!chosen.length) { setError('Include at least one measurement'); return; }
    setBusy(true); setError('');
    try {
      const res = await api.post('/api/test-reports/import/commit', { assetId, testDate, vendor, techName, measurements: chosen });
      setResult(res.data.data);
      setStep(3);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to commit');
    } finally { setBusy(false); }
  }

  function reset() { setStep(1); setPreview(null); setRows([]); setResult(null); setError(''); }

  const s = preview?.summary;

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <FileText size={22} strokeWidth={1.75} /> Import test report (PDF)
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 720, lineHeight: 1.6 }}>
        Upload the PowerDB / Megger / NETA test report your contractor emailed you. ServiceCycle reads it,
        pulls the measurements, and hands back the list of things to fix — no manual data entry.
      </p>

      {error && <div style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {/* Step 1 — upload */}
      {step === 1 && (
        <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
          <UploadCloud size={40} strokeWidth={1.25} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{busy ? 'Reading PDF…' : 'Drop a test-report PDF or choose a file'}</div>
          <input type="file" accept="application/pdf,.pdf" onChange={onFile} disabled={busy} />
        </div></div>
      )}

      {/* Step 2 — preview */}
      {step === 2 && preview && (
        <>
          {preview.assetSections > 1 && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 'var(--font-size-sm)' }}>
              ⚠ This report appears to cover <strong>{preview.assetSections} assets</strong>. All readings below will attach to the one asset you pick — review them, or split the report and import per asset. (Automatic per-asset split is coming.)
            </div>
          )}
          {preview.ocr && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8', fontSize: 'var(--font-size-sm)' }}>
              This was a scanned report — readings were recovered by OCR and may contain errors. Please verify each before committing.
            </div>
          )}
          <div className="card mb-16"><div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 260px' }}>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Asset this report belongs to</label>
              <select className="input" value={assetId} onChange={e => setAssetId(e.target.value)} style={{ width: '100%' }}>
                <option value="">— select asset —</option>
                {assets.map(a => <option key={a.id} value={a.id}>{a.label}{a.serial ? ` · ${a.serial}` : ''}</option>)}
              </select>
              {preview.assetMatch
                ? <div style={{ fontSize: 11, color: '#15803d', marginTop: 3 }}>Matched by serial {preview.meta.serialNumber}</div>
                : preview.meta?.serialNumber && <div style={{ fontSize: 11, color: '#92400e', marginTop: 3 }}>No asset matched serial {preview.meta.serialNumber} — pick one.</div>}
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Test date</label>
              <input type="date" className="input" value={testDate} onChange={e => setTestDate(e.target.value)} style={{ width: 160 }} />
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Vendor</label>
              <input type="text" className="input" value={vendor} onChange={e => setVendor(e.target.value)} style={{ width: 160 }} />
            </div>
          </div></div>

          <div className="card mb-16">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
              <div className="card-title">Extracted measurements ({s.total})</div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                <span style={{ color: '#b91c1c', fontWeight: 700 }}>{s.red} RED</span> · <span style={{ color: '#92400e', fontWeight: 700 }}>{s.yellow} YELLOW</span> · {s.green} GREEN · {s.deficienciesToCreate} deficiencies will be created
              </div>
            </div>
            <div className="card-body" style={{ overflowX: 'auto' }}>
              {s.total === 0 && <div style={{ color: 'var(--color-text-secondary)' }}>No measurements detected. The PDF may be a scan (image) rather than a text report.</div>}
              {s.total > 0 && (
                <table style={{ width: '100%', fontSize: 'var(--font-size-sm)', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                    <th></th><th>Measurement</th><th>Ph</th><th>Value</th><th>Expected</th><th>Result</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td><input type="checkbox" checked={r.include} onChange={() => setRow(i, { include: !r.include })} /></td>
                        <td>{r.label}</td>
                        <td>{r.phase || '—'}</td>
                        <td>{r.asFoundValue ?? '—'} {r.asFoundUnit || ''}</td>
                        <td style={{ color: 'var(--color-text-secondary)' }}>{r.expectedRange || '—'}</td>
                        <td>
                          <select value={r.passFail || ''} onChange={e => setRow(i, { passFail: e.target.value || null })}
                            style={{ color: PF_COLORS[r.passFail] || 'inherit', fontWeight: 700, background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 4, padding: '2px 4px' }}>
                            <option value="">—</option><option value="GREEN">GREEN</option><option value="YELLOW">YELLOW</option><option value="RED">RED</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busy} onClick={commit}>{busy ? 'Committing…' : 'Commit & generate fix list'}</button>
            <button className="btn btn-secondary" onClick={reset} disabled={busy}>Start over</button>
          </div>
        </>
      )}

      {/* Step 3 — action list */}
      {step === 3 && result && (
        <div className="card"><div className="card-body" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <CheckCircle2 size={24} style={{ color: 'var(--color-success)' }} />
            <h2 style={{ margin: 0, fontSize: 18 }}>Here's what we found</h2>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', padding: '12px 16px', marginBottom: 18, borderRadius: 8,
            background: 'var(--color-success-bg, #f0fdf4)', border: '1px solid var(--color-success-border, #bbf7d0)' }}>
            <div style={{ flex: 1, minWidth: 240, fontSize: 'var(--font-size-sm)' }}>
              <strong>{result.measurementsCreated} measurement{result.measurementsCreated !== 1 ? 's' : ''} recorded.</strong>{' '}
              {result.deficienciesCreated > 0
                ? <>We flagged <strong>{result.deficienciesCreated} deficienc{result.deficienciesCreated !== 1 ? 'ies' : 'y'}</strong> from out-of-spec readings
                    {' '}({result.deficiencyBySeverity.IMMEDIATE} immediate, {result.deficiencyBySeverity.RECOMMENDED} recommended, {result.deficiencyBySeverity.ADVISORY} advisory).</>
                : <>All readings within spec — no deficiencies.</>}
            </div>
            <Link to={`/assets/${result.assetId}`} className="btn btn-primary btn-sm">View asset trends →</Link>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/deficiencies?resolved=false" className="btn btn-secondary">View fix-it list</Link>
            <button className="btn btn-secondary" onClick={reset}>Import another report</button>
          </div>
        </div></div>
      )}
    </div>
  );
}
