// ─────────────────────────────────────────────────────────────────────────────
// TestReportImport.jsx — staged PDF test-report ingest (gem R1, the moat).
// Upload a PowerDB/Megger/NETA test-report PDF → preview the extracted
// measurements (human-in-the-loop) → commit to TestMeasurements + auto-created
// deficiencies → land on the fix-it list. "We read the report nobody reads and
// hand back the to-do list."
//
// #1 one-upload = one-facility: when the report spans >1 SUBSTATION/POSITION
// section the preview returns `sections[]`; this page renders a per-section
// accordion (match each block to the register or create a new asset) and
// commits every asset in one shot. Single-asset reports keep the flat UI.
// Also wires the cross-block client debt: #4 correction diff + extractionId on
// commit, and the #5 priorImport / #2 truncated coverage warnings.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FileText, UploadCloud, CheckCircle2 } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { takePendingImport } from '../lib/pendingImport';
import { EQUIPMENT_TYPE_LABELS, fmtDate } from '../lib/equipment';

const PF_COLORS = { GREEN: '#15803d', YELLOW: '#92400e', RED: '#b91c1c' };
// #10 confidence triage — same red/yellow/green review the nameplate flow uses.
// The parser emits a 0..1 confidence per reading (0.9 ruled-table, 0.6 inline,
// ≤0.5 OCR); map to the shared traffic-light so the user reviews the few
// uncertain rows instead of re-reading all of them.
const CONF_DOT = { high: '#16a34a', medium: '#d97706', low: '#dc2626' };
const CONF_LABEL = { high: 'high confidence', medium: 'double-check', low: 'verify' };
function confLevel(c) {
  if (typeof c !== 'number') return 'medium'; // unknown (e.g. pdfjs fallback) → review
  if (c >= 0.85) return 'high';
  if (c >= 0.55) return 'medium';
  return 'low';
}
const CREATE = '__create__';
const TYPE_OPTIONS = Object.entries(EQUIPMENT_TYPE_LABELS).sort((a, b) => a[1].localeCompare(b[1]));

export default function TestReportImport() {
  useDocumentTitle('Import Test Report');

  // #14 contractor bulk ingest: when an oem_admin arrives from the Fleet
  // Dashboard with ?targetAccountId, every request is scoped to that customer
  // account so the report seeds/updates the customer's facility.
  const [searchParams] = useSearchParams();
  const targetAccountId = searchParams.get('targetAccountId') || null;
  const targetCustomer = searchParams.get('customer') || null;

  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phase, setPhase] = useState(''); // #2 async ingest progress text
  const [preview, setPreview] = useState(null);
  const [rows, setRows] = useState([]);
  const [original, setOriginal] = useState([]);   // #4: snapshot for the correction diff
  const [previewedAt, setPreviewedAt] = useState(0);
  const [assets, setAssets] = useState([]);
  const [sites, setSites] = useState([]);
  const [assetId, setAssetId] = useState('');       // single-asset path
  const [sel, setSel] = useState([]);               // per-section asset id | CREATE
  const [createFields, setCreateFields] = useState([]); // per-section new-asset inputs
  const [testDate, setTestDate] = useState('');
  const [vendor, setVendor] = useState('');
  const [techName, setTechName] = useState('');
  const [isAcceptanceTest, setIsAcceptanceTest] = useState(false); // #27 year-0 baseline
  const [result, setResult] = useState(null);

  useEffect(() => {
    // In OEM cross-account mode the local /api/assets list is the OEM's own and
    // would be wrong to offer; the preview's assetCandidates (resolved against
    // the target account) are the authoritative match source instead.
    if (!targetAccountId) {
      api.get('/api/assets').then(r => {
        const d = r.data?.data;
        const list = Array.isArray(d) ? d : (d?.assets || d?.items || []);
        setAssets(list.map(a => ({ id: a.id, label: [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || a.serialNumber || a.id, serial: a.serialNumber })));
      }).catch(() => {});
    }
    const sitesUrl = targetAccountId ? `/api/sites?targetAccountId=${encodeURIComponent(targetAccountId)}` : '/api/sites';
    api.get(sitesUrl).then(r => setSites(r.data?.data?.sites || [])).catch(() => {});
  }, [targetAccountId]);

  const isMulti = !!(preview?.sections && preview.sections.length > 1);

  // Apply a preview payload (same shape from the sync /preview route OR the #2
  // async ingest job result) to the review UI.
  function applyPreview(d) {
    setPreview(d);
    setRows(d.measurements.map(m => ({ ...m, include: true })));
    setOriginal(d.measurements.map(m => ({ passFail: m.passFail ?? null, asFoundValue: m.asFoundValue ?? null })));
    setPreviewedAt(Date.now());
    setAssetId(d.assetMatch?.id || '');
    // Per-section selection + create-asset prefill (multi-asset reports).
    if (d.sections && d.sections.length > 1) {
      setSel(d.sections.map(sec => sec.assetMatch?.id || CREATE));
      setCreateFields(d.sections.map((sec, i) => ({
        siteId: '', equipmentType: '',
        manufacturer: i === 0 ? (d.meta?.manufacturer || '') : '',
        model:        i === 0 ? (d.meta?.model || '') : '',
        serialNumber: i === 0 ? (d.meta?.serialNumber || '') : '',
      })));
    } else {
      setSel([]); setCreateFields([]);
    }
    setTestDate(d.meta?.testDate || new Date().toISOString().slice(0, 10));
    setVendor(d.meta?.vendor || '');
    setTechName(d.meta?.techName || '');
    setStep(2);
  }

  // #2: large multi-page jobs go through the async queue (parse off the request)
  // so a 40-page facility report can't time out; small single-asset files keep
  // the instant sync path. The job result is the SAME shape as /preview.
  const ASYNC_THRESHOLD_BYTES = 1.5 * 1024 * 1024;

  async function previewAsync(file) {
    const fd = new FormData();
    fd.append('file', file);
    if (targetAccountId) fd.append('targetAccountId', targetAccountId);
    setPhase('Uploading…');
    const enq = await api.post('/api/ingest/jobs', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    const jobId = enq.data.data.jobId;
    // Poll up to ~2 minutes (60 × 2s).
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const s = await api.get(`/api/ingest/jobs/${jobId}`);
      const j = s.data.data;
      setPhase(j.phase ? `${j.phase}… (${j.progress || 0}%)` : `Working… (${j.progress || 0}%)`);
      if (j.status === 'done') { applyPreview(j.result); return; }
      if (j.status === 'failed') throw new Error(j.error || 'Ingest failed');
    }
    throw new Error('Still processing — check back shortly under recent imports.');
  }

  async function previewFile(file) {
    if (!file) return;
    setBusy(true); setError(''); setPhase('');
    try {
      if (file.size > ASYNC_THRESHOLD_BYTES) {
        await previewAsync(file);
      } else {
        const fd = new FormData();
        fd.append('file', file);
        if (targetAccountId) fd.append('targetAccountId', targetAccountId);
        // 2026-07-14: AI gap-fill on this sync path can run past the client's
        // global 30s default (observed ~30-33s on a real multi-section
        // report's arc-flash sibling path) -- override per-request rather
        // than raising the global default.
        const res = await api.post('/api/test-reports/import/preview', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 90000 });
        applyPreview(res.data.data);
      }
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Failed to read the PDF');
    } finally { setBusy(false); setPhase(''); }
  }

  function onFile(e) { previewFile(e.target.files?.[0]); }

  // W2: if the "Add data" door handed us a file, preview it automatically.
  useEffect(() => { const f = takePendingImport(); if (f) previewFile(f); }, []);

  function setRow(i, patch) { setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r)); }
  function setCreate(i, patch) { setCreateFields(cf => cf.map((c, idx) => idx === i ? { ...c, ...patch } : c)); }
  function setSelAt(i, v) { setSel(s => s.map((x, idx) => idx === i ? v : x)); }

  // #4 correction capture: diff the human-edited rows against the extraction
  // snapshot so the server banks a labeled {field, before, after} corpus.
  function buildCorrections() {
    const out = [];
    rows.forEach((r, i) => {
      const o = original[i] || {};
      if ((r.passFail ?? null) !== (o.passFail ?? null)) {
        out.push({ field: 'passFail', before: o.passFail ?? null, after: r.passFail ?? null, formFamily: preview?.source || null, measurementType: r.measurementType });
      }
      if (String(r.asFoundValue ?? '') !== String(o.asFoundValue ?? '')) {
        out.push({ field: 'asFoundValue', before: o.asFoundValue ?? null, after: r.asFoundValue ?? null, formFamily: preview?.source || null, measurementType: r.measurementType });
      }
    });
    return out;
  }

  async function commit() {
    const corrections = buildCorrections();
    const reviewMs = previewedAt ? Date.now() - previewedAt : null;
    const base = { testDate, vendor, techName, isAcceptanceTest, extractionId: preview?.extractionId || null, corrections, reviewMs, ...(targetAccountId ? { targetAccountId } : {}) };

    if (isMulti) {
      // Build the per-section payload; only sections with included readings ship.
      const sectionsPayload = [];
      for (let i = 0; i < preview.sections.length; i++) {
        const sec = preview.sections[i];
        const measurements = sec.measurementIndices.map(idx => rows[idx]).filter(r => r && r.include);
        if (!measurements.length) continue;
        const choice = sel[i];
        if (choice === CREATE) {
          const c = createFields[i] || {};
          if (!c.siteId || !c.equipmentType) { setError(`"${sec.label}": pick a site and equipment type for the new asset (or match it to an existing one).`); return; }
          sectionsPayload.push({ createAsset: { siteId: c.siteId, equipmentType: c.equipmentType, manufacturer: c.manufacturer || null, model: c.model || null, serialNumber: c.serialNumber || null }, measurements, label: sec.label });
        } else if (choice) {
          sectionsPayload.push({ assetId: choice, measurements, label: sec.label });
        } else {
          setError(`"${sec.label}": choose an asset to attach these readings to.`); return;
        }
      }
      if (!sectionsPayload.length) { setError('Include at least one reading in at least one section.'); return; }
      setBusy(true); setError('');
      try {
        const res = await api.post('/api/test-reports/import/commit', { ...base, sections: sectionsPayload });
        setResult(res.data.data);
        setStep(3);
      } catch (err) {
        setError(err?.response?.data?.error || 'Failed to commit');
      } finally { setBusy(false); }
      return;
    }

    // Single-asset path.
    if (!assetId) { setError('Pick the asset this report belongs to'); return; }
    const chosen = rows.filter(r => r.include);
    if (!chosen.length) { setError('Include at least one measurement'); return; }
    setBusy(true); setError('');
    try {
      const res = await api.post('/api/test-reports/import/commit', { ...base, assetId, measurements: chosen });
      setResult(res.data.data);
      setStep(3);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to commit');
    } finally { setBusy(false); }
  }

  function reset() { setStep(1); setPreview(null); setRows([]); setOriginal([]); setResult(null); setError(''); setSel([]); setCreateFields([]); }

  const s = preview?.summary;

  // ── Render helpers — invoked as functions (NOT <Component/>) so they render
  // inline without a component boundary; defining a component inside the page
  // and mounting it as JSX would remount on every keystroke and drop input
  // focus in the create-asset form. ─────────────────────────────────────────
  function readingsTable(indices) {
    const idx = (indices || rows.map((_, i) => i)).map(i => [rows[i], i]);
    if (!idx.length) return <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>No readings in this section.</div>;
    const diag = idx.filter(([r]) => (r.kind || 'D') !== 'R');
    const ref = idx.filter(([r]) => (r.kind || 'D') === 'R');
    // #10 triage: diagnostic readings the parser was unsure about float to the
    // top for review; the confident ones collapse so the user verifies the few
    // that matter instead of re-reading every row.
    const flagged = diag.filter(([r]) => confLevel(r.confidence) !== 'high');
    const confident = diag.filter(([r]) => confLevel(r.confidence) === 'high');
    const headRow = (
      <thead><tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)' }}>
        <th></th><th></th><th>Measurement</th><th>Ph</th><th>Value</th><th>Expected</th><th>Result</th>
      </tr></thead>
    );
    const renderRows = (list) => list.map(([r, i]) => {
      const lvl = confLevel(r.confidence);
      return (
        <tr key={i} style={{ borderTop: '1px solid var(--color-border)', background: lvl === 'low' ? '#fef2f2' : 'transparent' }}>
          <td><input type="checkbox" checked={r.include} onChange={() => setRow(i, { include: !r.include })} /></td>
          <td title={CONF_LABEL[lvl]}><span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 999, background: CONF_DOT[lvl] }} /></td>
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
      );
    });
    const tableOf = (list, extraStyle) => (
      <table style={{ width: '100%', fontSize: 'var(--font-size-sm)', borderCollapse: 'collapse', ...(extraStyle || {}) }}>
        {headRow}<tbody>{renderRows(list)}</tbody>
      </table>
    );
    return (
      <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          <span><strong>Review {flagged.length}</strong> of {diag.length} reading{diag.length === 1 ? '' : 's'}</span>
          <span style={{ display: 'inline-flex', gap: 10 }}>
            {['high', 'medium', 'low'].map(c => (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: CONF_DOT[c] }} /> {CONF_LABEL[c]}
              </span>
            ))}
          </span>
        </div>
        {flagged.length > 0 ? tableOf(flagged) : <div style={{ color: '#15803d', fontSize: 'var(--font-size-sm)', padding: '4px 0' }}>✓ The parser was confident on every reading — give them a glance and commit.</div>}
        {confident.length > 0 && (
          <details style={{ marginTop: 12 }} open={flagged.length === 0}>
            <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', userSelect: 'none' }}>
              {flagged.length > 0 ? `${confident.length} high-confidence reading${confident.length === 1 ? '' : 's'}` : `All ${confident.length} reading${confident.length === 1 ? '' : 's'}`}
            </summary>
            {tableOf(confident, { marginTop: 8 })}
          </details>
        )}
        {ref.length > 0 && (
          <details style={{ marginTop: 14 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', userSelect: 'none' }}>
              Additional readings &amp; nameplate data ({ref.length}) — voltages, currents, temps, settings; stored for reference, not compliance-critical
            </summary>
            {tableOf(ref, { marginTop: 8, opacity: 0.8 })}
          </details>
        )}
      </>
    );
  }

  function summaryChips(sum) {
    if (!sum) return null;
    return (
      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
        <span style={{ color: '#b91c1c', fontWeight: 700 }}>{sum.red} RED</span> · <span style={{ color: '#92400e', fontWeight: 700 }}>{sum.yellow} YELLOW</span> · {sum.green} GREEN · {sum.deficienciesToCreate} deficiencies
      </span>
    );
  }

  // Asset <select> shared by the flat path and each section. `value`/`onChange`
  // drive either assetId (flat) or sel[i] (section); section mode adds CREATE.
  function assetPicker({ value, onChange, candidates, allowCreate }) {
    return (
      <select className="input" value={value} onChange={e => onChange(e.target.value)} style={{ width: '100%' }}>
        <option value="">— select asset —</option>
        {allowCreate && <option value={CREATE}>+ Create a new asset for this section</option>}
        {candidates && candidates.length > 0 && (
          <optgroup label="Suggested matches">
            {candidates.map(c => <option key={c.id} value={c.id}>{c.label}{c.serialNumber ? ` · ${c.serialNumber}` : ''}{c.lastTestedAt ? ` · last tested ${fmtDate(c.lastTestedAt)}` : ''}</option>)}
          </optgroup>
        )}
        <optgroup label="All assets">
          {assets.map(a => <option key={a.id} value={a.id}>{a.label}{a.serial ? ` · ${a.serial}` : ''}</option>)}
        </optgroup>
      </select>
    );
  }

  function createAssetForm(idx) {
    const c = createFields[idx] || {};
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 8, padding: 12, borderRadius: 8, background: 'var(--color-bg-subtle, #f8fafc)', border: '1px dashed var(--color-border)' }}>
        <div style={{ flex: '1 1 180px' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Site</label>
          <select className="input" value={c.siteId} onChange={e => setCreate(idx, { siteId: e.target.value })} style={{ width: '100%' }}>
            <option value="">— select site —</option>
            {sites.map(st => <option key={st.id} value={st.id}>{st.name}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 180px' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Equipment type</label>
          <select className="input" value={c.equipmentType} onChange={e => setCreate(idx, { equipmentType: e.target.value })} style={{ width: '100%' }}>
            <option value="">— select type —</option>
            {TYPE_OPTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Serial #</label>
          <input className="input" value={c.serialNumber} onChange={e => setCreate(idx, { serialNumber: e.target.value })} style={{ width: '100%' }} placeholder="optional" />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Manufacturer</label>
          <input className="input" value={c.manufacturer} onChange={e => setCreate(idx, { manufacturer: e.target.value })} style={{ width: '100%' }} placeholder="optional" />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Model</label>
          <input className="input" value={c.model} onChange={e => setCreate(idx, { model: e.target.value })} style={{ width: '100%' }} placeholder="optional" />
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <FileText size={22} strokeWidth={1.75} /> Import test report (PDF)
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 720, lineHeight: 1.6 }}>
        Upload the PowerDB / Megger / NETA test report your contractor emailed you. ServiceCycle reads it,
        pulls the measurements, and hands back the list of things to fix — no manual data entry.
      </p>

      {targetAccountId && (
        <div style={{ padding: '10px 14px', background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, color: '#5b21b6', marginBottom: 16, fontSize: 'var(--font-size-sm)' }}>
          Ingesting for <strong>{targetCustomer || 'a fleet customer'}</strong>. Matches and new assets are written to that customer's account, not yours.
        </div>
      )}

      {error && <div style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {/* Step 1 — upload */}
      {step === 1 && (
        <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
          <UploadCloud size={40} strokeWidth={1.25} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{busy ? (phase || 'Reading…') : 'Drop a test-report PDF — or a photo of a paper field sheet'}</div>
          <input type="file" accept="application/pdf,.pdf,image/*" capture="environment" onChange={onFile} disabled={busy} />
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
            PDF, or a clear photo (JPG/PNG/HEIC) of a printed or hand-written sheet. Large multi-page reports parse in the background.
          </div>
        </div></div>
      )}

      {/* Step 2 — preview */}
      {step === 2 && preview && (
        <>
          {/* #5 dedupe: this exact PDF was already imported. */}
          {preview.priorImport && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fff1f1', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>
              ⚠ This exact report was already imported{preview.priorImport.importedAt ? ` on ${fmtDate(preview.priorImport.importedAt)}` : ''}{preview.priorImport.readings ? ` (${preview.priorImport.readings} readings)` : ''}. Committing again will create <strong>duplicate</strong> readings and skew the trends — only proceed if you're intentionally re-importing.
            </div>
          )}
          {/* #2 coverage: the parse was truncated before the last page. */}
          {preview.truncated && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 'var(--font-size-sm)' }}>
              Coverage is partial — readings were extracted from {preview.pagesScanned ? `pages 1–${preview.pagesScanned}` : 'the first pages'}{preview.pageCount ? ` of ${preview.pageCount}` : ''}. Later pages weren't parsed; some assets or readings may be missing.
            </div>
          )}
          {isMulti && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3', fontSize: 'var(--font-size-sm)' }}>
              This report covers <strong>{preview.sections.length} assets</strong>. Match each section below to the right equipment (or create a new asset), then commit once — every asset is imported together.
            </div>
          )}
          {preview.photoOfPaper && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 'var(--font-size-sm)' }}>
              Read from your photo of a paper sheet — OCR of photos (especially hand-writing) is error-prone. Verify every reading before committing.
            </div>
          )}
          {preview.ocr && !preview.photoOfPaper && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8', fontSize: 'var(--font-size-sm)' }}>
              This was a scanned report — readings were recovered by OCR and may contain errors. Please verify each before committing.
            </div>
          )}
          {preview.aiUsed && preview.aiAdded > 0 && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#faf5ff', border: '1px solid #e9d5ff', color: '#7e22ce', fontSize: 'var(--font-size-sm)' }}>
              ✨ The structured parser came back thin on this report, so AI recovered <strong>{preview.aiAdded} additional reading{preview.aiAdded === 1 ? '' : 's'}</strong> (marked <em>AI</em>). AI can misread — please verify these before committing.
            </div>
          )}

          {/* Shared header: test date + vendor */}
          <div className="card mb-16"><div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Test date</label>
              <input type="date" className="input" value={testDate} onChange={e => setTestDate(e.target.value)} style={{ width: 160 }} />
            </div>
            <div>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Vendor</label>
              <input type="text" className="input" value={vendor} onChange={e => setVendor(e.target.value)} style={{ width: 200 }} />
            </div>
            <div style={{ alignSelf: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}>
                <input type="checkbox" checked={isAcceptanceTest} onChange={e => setIsAcceptanceTest(e.target.checked)} />
                <span>Acceptance / commissioning test <span style={{ color: 'var(--color-text-secondary)' }}>(year-0 baseline)</span></span>
              </label>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, maxWidth: 320 }}>
                Anchors trend math to this report and skips year-over-year flags — NFPA 70B baseline.
              </div>
            </div>
          </div></div>

          {/* ── Multi-asset: per-section accordion ─────────────────────────── */}
          {isMulti ? preview.sections.map((sec, i) => (
            <details key={i} className="card mb-16" open={i === 0}>
              <summary className="card-header" style={{ cursor: 'pointer', display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span className="card-title">{sec.label || `Section ${i + 1}`}</span>
                {summaryChips(sec.summary)}
              </summary>
              <div className="card-body">
                <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Attach this section to</label>
                {assetPicker({ value: sel[i] ?? CREATE, onChange: v => setSelAt(i, v), candidates: sec.assetCandidates, allowCreate: true })}
                {sec.assetMatch && sel[i] === sec.assetMatch.id && (
                  <div style={{ fontSize: 11, color: '#15803d', marginTop: 3 }}>
                    Suggested: {sec.assetMatch.label}{sec.assetMatch.reason ? ` (${sec.assetMatch.reason.replace(/_/g, ' ')})` : ''}{sec.assetMatch.lastTestedAt ? ` · last tested ${fmtDate(sec.assetMatch.lastTestedAt)}` : ''} — same device?
                  </div>
                )}
                {sel[i] === CREATE && createAssetForm(i)}
                <div style={{ marginTop: 14 }}>{readingsTable(sec.measurementIndices)}</div>
              </div>
            </details>
          )) : (
            /* ── Single asset: flat picker + table ─────────────────────────── */
            <>
              <div className="card mb-16"><div className="card-body">
                <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Asset this report belongs to</label>
                <div style={{ maxWidth: 420 }}>{assetPicker({ value: assetId, onChange: setAssetId, candidates: preview.assetCandidates, allowCreate: false })}</div>
                {preview.assetMatch
                  ? <div style={{ fontSize: 11, color: '#15803d', marginTop: 3 }}>
                      Matched {preview.assetMatch.label}{preview.assetMatch.reason ? ` by ${preview.assetMatch.reason.replace(/_/g, ' ')}` : ''}{preview.assetMatch.lastTestedAt ? ` · last tested ${fmtDate(preview.assetMatch.lastTestedAt)}` : ''} — same device?
                    </div>
                  : preview.meta?.serialNumber && <div style={{ fontSize: 11, color: '#92400e', marginTop: 3 }}>No asset matched serial {preview.meta.serialNumber} — pick one.</div>}
              </div></div>

              <div className="card mb-16">
                <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                  <div className="card-title">Extracted measurements ({s.total})</div>
                  {summaryChips(s)}
                </div>
                <div className="card-body" style={{ overflowX: 'auto' }}>
                  {s.total === 0
                    ? <div style={{ color: 'var(--color-text-secondary)' }}>No measurements detected. The PDF may be a scan (image) rather than a text report.</div>
                    : readingsTable(null)}
                </div>
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={busy} onClick={commit}>{busy ? 'Committing…' : (isMulti ? 'Commit all & generate fix list' : 'Commit & generate fix list')}</button>
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

          {result.totals ? (
            /* Multi-section result */
            <>
              <div style={{ padding: '12px 16px', marginBottom: 18, borderRadius: 8, background: 'var(--color-success-bg, #f0fdf4)', border: '1px solid var(--color-success-border, #bbf7d0)', fontSize: 'var(--font-size-sm)' }}>
                Imported <strong>{result.totals.assetsCommitted} asset{result.totals.assetsCommitted !== 1 ? 's' : ''}</strong>
                {result.totals.assetsCreated > 0 ? ` (${result.totals.assetsCreated} newly created)` : ''}: <strong>{result.totals.measurementsCreated}</strong> readings recorded, <strong>{result.totals.deficienciesCreated}</strong> deficienc{result.totals.deficienciesCreated !== 1 ? 'ies' : 'y'} flagged.
              </div>
              <div style={{ display: 'grid', gap: 8, marginBottom: 18 }}>
                {result.sections.map((r, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap', padding: '8px 12px', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 'var(--font-size-sm)' }}>
                    <span>{r.label || `Asset ${i + 1}`}{r.created ? <em style={{ color: 'var(--color-text-secondary)' }}> · new</em> : ''} — {r.measurementsCreated} readings, {r.deficienciesCreated} deficiencies</span>
                    <Link to={`/assets/${r.assetId}`} className="btn btn-secondary btn-sm">View asset →</Link>
                  </div>
                ))}
              </div>
            </>
          ) : (
            /* Single-asset result */
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
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/deficiencies?resolved=false" className="btn btn-secondary">View fix-it list</Link>
            <button className="btn btn-secondary" onClick={reset}>Import another report</button>
          </div>
        </div></div>
      )}
    </div>
  );
}
