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
  const [newSiteName, setNewSiteName] = useState('');
  const [sourceType, setSourceType] = useState('study_report');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null); // { ingestId, status, totalBusCount, warnings, siteId }
  const [phase, setPhase] = useState(''); // '' | 'queued' | 'processing' — while the background worker runs
  const [elapsed, setElapsed] = useState(0); // seconds since submit — visible so a long extract never looks frozen

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

  // Tick a visible elapsed clock while the background worker runs. Extraction
  // can take several minutes on a big report or when the AI provider is under
  // load, and the old static "can take a minute" line made a normal 3-4 minute
  // run look hung. Reset whenever we leave the busy state.
  useEffect(() => {
    if (!busy) { setElapsed(0); return; }
    const t0 = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);
  const fmtElapsed = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // W1 part 2 (2026-07-14): extraction runs in a background worker, so we poll
  // GET /api/arc-flash/ingest/:id until the row leaves queued/processing. A
  // transient poll error is ignored (keep polling); a 404 or the overall
  // deadline surfaces. Native-PDF on a large report can take a minute+, hence
  // the generous deadline.
  async function pollIngest(ingestId, intervalMs = 3000, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, intervalMs));
      let ing;
      try {
        const r = await api.get(`/api/arc-flash/ingest/${ingestId}`);
        ing = r.data?.data?.ingest;
      } catch (e2) {
        if (e2?.response?.status === 404) throw new Error('Ingest not found.');
        continue; // transient network/db blip — keep polling
      }
      if (!ing) continue;
      if (ing.status !== 'queued' && ing.status !== 'processing' && ing.status !== 'extracting') return ing;
      setPhase(ing.status);
    }
    throw new Error("Extraction is taking longer than expected — check the site's Arc Flash panel in a moment.");
  }

  async function submit(e) {
    e.preventDefault();
    setErr(''); setResult(null); setPhase('queued');
    if (!file) { setErr('Choose a PDF/Word study or a PNG/JPG one-line first.'); return; }
    const creatingSite = siteId === '__new__';
    if (!creatingSite && !siteId) { setErr('Pick the site this study belongs to, or choose "+ New site".'); return; }
    if (creatingSite && !newSiteName.trim()) { setErr('Enter a name for the new site.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (creatingSite) fd.append('newSiteName', newSiteName.trim());
      else fd.append('siteId', siteId);
      fd.append('sourceType', sourceType);
      // /ingest returns 202 { ingestId, status:'queued' } immediately; the heavy
      // native-PDF extraction runs in arcFlashIngestWorker. Poll for the result
      // instead of holding one long request open (the old 90s sync wait would
      // time out on a large chunked report).
      const r = await api.post('/api/arc-flash/ingest', fd);
      const enq = r.data?.data || {};
      if (!enq.ingestId) throw new Error('Upload did not return an ingest id.');
      const ing = await pollIngest(enq.ingestId);
      setResult({
        ingestId: enq.ingestId, status: ing.status,
        totalBusCount: ing.totalBusCount, readyBusCount: ing.readyBusCount,
        warnings: [], siteId: enq.siteId || ing.siteId || siteId,
      });
      if (ing.status === 'failed') setErr(ing.error || 'Extraction failed — try a clearer file.');
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2?.message || 'Upload failed.');
    } finally {
      setBusy(false); setPhase('');
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
              <option value="__new__">+ New site (create from this document)</option>
            </select>
            {siteId === '__new__' && (
              <input type="text" value={newSiteName} onChange={e => setNewSiteName(e.target.value)} placeholder="New site name (e.g. from the drawing title block)" style={{ width: '100%', maxWidth: 320, marginTop: 8 }} />
            )}
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
              <UploadCloud size={16} /> {busy ? (phase === 'processing' || phase === 'extracting' ? 'Extracting…' : 'Queued…') : 'Extract'}
            </button>
            {busy && (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
                <strong>{phase === 'processing' || phase === 'extracting' ? 'Extracting' : 'Queued'} · {fmtElapsed(elapsed)} elapsed.</strong>{' '}
                Reading the document in the background — usually under a minute, but a large report (or heavy AI load) can take several minutes. You can leave this page; the study will be waiting on the site's Arc Flash panel.
              </div>
            )}
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
