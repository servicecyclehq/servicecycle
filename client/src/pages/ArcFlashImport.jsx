// ─────────────────────────────────────────────────────────────────────────────
// ArcFlashImport.jsx — standalone landing for an arc-flash study / one-line that
// arrived through the "Add data" door (gem W2). The full review + confirm flow
// (ArcFlashIngestPanel) is site-scoped and lives on SiteDetail, but an arc-flash
// document needs a site chosen before it can be ingested — this page asks for
// that one input, uploads to POST /api/arc-flash/ingest, then deep-links into the
// site's Arc Flash panel to review the extracted buses and confirm.
//
// Reached automatically when AddData's content pre-scan (/api/ingest/classify)
// decides a dropped PDF/.docx is an arc-flash study, or when the user picks
// "Arc-flash / short-circuit study" in the ambiguous-case fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap, UploadCloud } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { takePendingImport, takePendingImportMeta } from '../lib/pendingImport';

export default function ArcFlashImport() {
  useDocumentTitle('Import arc-flash study');

  const [file, setFile] = useState(null);
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [sourceType, setSourceType] = useState('study_report');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null); // { ingestId, status, totalBusCount, warnings, siteId }

  // W2 hand-off: adopt the file the Add-data door passed us (consumed once),
  // plus an optional sourceType hint (one_line vs study_report) -- Add Data's
  // content pre-scan or its ambiguous-case chooser may already know which one
  // this is; pre-select it here but leave the dropdown editable either way.
  useEffect(() => {
    const f = takePendingImport();
    if (f) setFile(f);
    const meta = takePendingImportMeta();
    if (meta?.sourceType === 'one_line' || meta?.sourceType === 'study_report') setSourceType(meta.sourceType);
  }, []);
  useEffect(() => {
    api.get('/api/sites').then(r => setSites(r.data?.data?.sites || [])).catch(() => setSites([]));
  }, []);

  async function submit(e) {
    e.preventDefault();
    setErr(''); setResult(null);
    if (!file) { setErr('Choose a PDF/Word study or a PNG/JPG one-line first.'); return; }
    if (!siteId) { setErr('Pick the site this study belongs to.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('siteId', siteId);
      fd.append('sourceType', sourceType);
      const r = await api.post('/api/arc-flash/ingest', fd);
      const d = r.data?.data || {};
      setResult({ ...d, siteId });
      if (d.status === 'failed') setErr((d.warnings && d.warnings[0]) || 'Extraction failed — try a clearer file.');
    } catch (e2) {
      setErr(e2?.response?.data?.error || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Zap size={22} strokeWidth={1.75} /> Import arc-flash study
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 720, lineHeight: 1.6 }}>
        SC reads the study report or one-line, drafts the IEEE 1584 inputs per bus, and lists what's still
        missing. Pick the site it belongs to, then review and confirm on the site's Arc Flash panel.
      </p>

      {err && <div style={{ padding: '12px 16px', background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', borderRadius: 8, color: 'var(--chip-red-fg)', marginBottom: 16 }}>{err}</div>}

      {!result && (
        <form onSubmit={submit} className="card"><div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 560 }}>
          <div>
            <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 6 }}>Document</label>
            {file
              ? <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Selected: <strong>{file.name}</strong></div>
              : <input type="file" accept=".pdf,.docx,.png,.jpg,.jpeg,.webp" onChange={e => setFile(e.target.files?.[0] || null)} />}
            {file && (
              <button type="button" className="btn-link" style={{ fontSize: 'var(--font-size-xs)', marginTop: 4 }} onClick={() => setFile(null)}>Choose a different file</button>
            )}
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 6 }}>Site</label>
            <select value={siteId} onChange={e => setSiteId(e.target.value)} style={{ width: '100%', maxWidth: 320 }}>
              <option value="">— pick a site —</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 6 }}>Document type</label>
            <select value={sourceType} onChange={e => setSourceType(e.target.value)}>
              <option value="study_report">Study report</option>
              <option value="one_line">One-line diagram</option>
            </select>
          </div>

          <div>
            <button type="submit" className="btn" disabled={busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <UploadCloud size={16} /> {busy ? 'Reading…' : 'Extract'}
            </button>
          </div>
        </div></form>
      )}

      {result && result.ingestId && (
        <div className="card"><div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontWeight: 600 }}>
            {result.status === 'failed'
              ? 'Extraction did not find any buses.'
              : `Extracted ${result.totalBusCount ?? 0} bus(es) — ${result.readyBusCount ?? 0} ready.`}
          </div>
          {Array.isArray(result.warnings) && result.warnings.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              {result.warnings.slice(0, 5).map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="btn" to={`/sites/${result.siteId}`}>Review &amp; confirm on the site</Link>
            <button type="button" className="btn-secondary" onClick={() => { setResult(null); setFile(null); }}>Import another</button>
          </div>
        </div></div>
      )}
    </div>
  );
}
