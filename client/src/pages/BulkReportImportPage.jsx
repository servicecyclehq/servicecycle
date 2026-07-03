// -----------------------------------------------------------------------------
// BulkReportImportPage.jsx -- bulk PDF test-report drop-zone (productized R1).
//
// "Drop 50 PDFs, watch the queue extract, review, commit." A many-file drop-zone
// feeds a client-side CHUNKED upload to POST /api/test-reports/import/bulk-preview
// (server caps 8 files/request; we chunk a large drop into successive requests to
// stay under the 20/min ingest limiter). Each file streams back into a live queue
// row (spinner -> extracted key fields + confidence + plausibility warnings, or
// error). The reviewer picks the target asset per file (suggested match
// pre-selected), toggles include, then commits the whole queue via
// POST /bulk-commit -> a per-file results summary.
//
// Field-level correction is intentionally NOT reimplemented here: the existing
// single-report screen (/test-reports/import) already owns the measurement-edit
// table. Each row offers "Review in detail" that stashes the extracted preview and
// deep-links into that screen. Multi-asset reports (which need per-section asset
// matching) are always routed there rather than committed through the flat bulk
// path. Admin/manager only (RequireRole in App.jsx; server requireManager on
// bulk-commit).
// -----------------------------------------------------------------------------

import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { UploadCloud, Layers, CheckCircle2 } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import BulkReportRow from '../components/import/bulk/BulkReportRow';

// Must not exceed the server's BULK_MAX_FILES (8). We chunk the dropped file list
// into slices of this size and upload them one request at a time.
const CHUNK_SIZE = 8;
const ACCEPT_RE = /\.(pdf|jpe?g|png|heic|heif|webp)$/i;

let _rowSeq = 0;
function nextRowId() { return `r${++_rowSeq}`; }

export default function BulkReportImportPage() {
  useDocumentTitle('Bulk import test reports');

  // #14 contractor bulk ingest passthrough (oem_admin acting for a fleet customer).
  const [searchParams] = useSearchParams();
  const targetAccountId = searchParams.get('targetAccountId') || null;
  const targetCustomer = searchParams.get('customer') || null;

  const [step, setStep] = useState(1);          // 1 drop · 2 review · 3 results
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState([]);         // queue entries (see BulkReportRow)
  const [assets, setAssets] = useState([]);
  const [committing, setCommitting] = useState(false);
  const [result, setResult] = useState(null);   // bulk-commit totals
  const previewedAtRef = useRef(0);
  const fileInputRef = useRef(null);

  // Local asset list (for the per-file picker) — skipped in OEM cross-account
  // mode where the local list would be the wrong tenant's.
  useEffect(() => {
    if (targetAccountId) return;
    api.get('/api/assets').then((r) => {
      const d = r.data && r.data.data;
      const list = Array.isArray(d) ? d : (d && (d.assets || d.items)) || [];
      setAssets(list.map((a) => ({
        id: a.id,
        label: [a.manufacturer, a.model].filter(Boolean).join(' ') || a.equipmentType || a.serialNumber || a.id,
        serial: a.serialNumber,
      })));
    }).catch(() => {});
  }, [targetAccountId]);

  function updateRow(id, patch) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  // Drop / choose -> validate -> enqueue pending rows -> chunked upload.
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []).filter((f) => ACCEPT_RE.test(f.name));
    if (!files.length) {
      setError('Drop PDF test reports (or photos: JPG/PNG/HEIC).');
      return;
    }
    setError('');
    setStep(2);
    setBusy(true);
    previewedAtRef.current = Date.now();

    // Seed a pending row per file so the queue shows spinners immediately.
    const pending = files.map((f) => ({ id: nextRowId(), status: 'pending', filename: f.name }));
    setRows((rs) => [...rs, ...pending]);
    setProgress({ done: 0, total: files.length });

    // Chunk into CHUNK_SIZE-file requests; upload sequentially so we never fire
    // more than one ingest request at a time (stays well under 20/min).
    let done = 0;
    for (let c = 0; c < files.length; c += CHUNK_SIZE) {
      const slice = files.slice(c, c + CHUNK_SIZE);
      const sliceRows = pending.slice(c, c + CHUNK_SIZE);
      try {
        const fd = new FormData();
        slice.forEach((f) => fd.append('files', f));
        if (targetAccountId) fd.append('targetAccountId', targetAccountId);
        const res = await api.post('/api/test-reports/import/bulk-preview', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        const results = (res.data && res.data.data && res.data.data.results) || [];
        // Server preserves input order; map each result onto its pending row.
        setRows((rs) => rs.map((r) => {
          const pos = sliceRows.findIndex((p) => p.id === r.id);
          if (pos === -1 || pos >= results.length) return r;
          const d = results[pos];
          if (d.status === 'failed') {
            return { ...r, status: 'failed', error: d.error };
          }
          return {
            ...r,
            ...d,
            status: 'extracted',
            // Pre-select the suggested asset; include by default only when we can
            // actually commit it (single-asset with a value/verdict present).
            assetId: (d.assetMatch && d.assetMatch.id) || '',
            include: true,
          };
        }));
      } catch (err) {
        // A whole-chunk failure (network / 429 / 500) marks just this chunk's rows
        // failed; the rest of the drop keeps processing.
        const msg = (err && err.response && err.response.data && err.response.data.error) || 'Upload failed for this batch.';
        setRows((rs) => rs.map((r) => (sliceRows.some((p) => p.id === r.id) ? { ...r, status: 'failed', error: msg } : r)));
      }
      done += slice.length;
      setProgress({ done, total: files.length });
    }
    setBusy(false);
  }

  function onDrop(e) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }
  function onInputChange(e) { handleFiles(e.target.files); if (fileInputRef.current) fileInputRef.current.value = ''; }

  function toggleInclude(id) { setRows((rs) => rs.map((r) => (r.id === id ? { ...r, include: !r.include } : r))); }
  function pickAsset(id, assetId) { updateRow(id, { assetId }); }

  // "Review in detail" expands an inline read-only table of every extracted
  // reading for that file so the reviewer can verify values before commit. We do
  // NOT re-implement field-level editing here (that lives on the single-report
  // screen); the bulk flow is a triage-and-commit surface. Reports that need a
  // value corrected are excluded here and re-uploaded on /test-reports/import.
  function reviewDetail(entry) { updateRow(entry.id, { expanded: !entry.expanded }); }

  // Rows that CAN commit through the flat bulk path: extracted, included,
  // single-asset (multi-asset must go through detailed review), asset chosen.
  const committable = rows.filter(
    (r) => r.status === 'extracted' && r.include && !(r.sections && r.sections.length > 1) && r.assetId,
  );
  const extractedRows = rows.filter((r) => r.status === 'extracted');
  const multiRows = extractedRows.filter((r) => r.sections && r.sections.length > 1);
  const includedNeedingAsset = extractedRows.filter(
    (r) => r.include && !(r.sections && r.sections.length > 1) && !r.assetId,
  );
  const allIncluded = extractedRows.length > 0 && extractedRows.every((r) => r.include);

  function selectAll(on) {
    setRows((rs) => rs.map((r) => (r.status === 'extracted' ? { ...r, include: on } : r)));
  }

  async function commitAll() {
    if (!committable.length) {
      setError('Pick an asset and include at least one single-asset report to commit. Multi-asset reports open detailed review.');
      return;
    }
    setError('');
    setCommitting(true);
    const reviewMs = previewedAtRef.current ? Date.now() - previewedAtRef.current : null;
    const items = committable.map((r) => ({
      extractionId: r.extractionId || null,
      filename: r.filename,
      assetId: r.assetId,
      measurements: r.measurements,
      testDate: (r.meta && r.meta.testDate) || undefined,
      vendor: (r.meta && r.meta.vendor) || undefined,
      techName: (r.meta && r.meta.techName) || undefined,
      reviewMs,
    }));
    try {
      const res = await api.post('/api/test-reports/import/bulk-commit', {
        items,
        ...(targetAccountId ? { targetAccountId } : {}),
      });
      const data = res.data && res.data.data;
      setResult(data.totals);
      // Reflect per-item outcomes back onto the queue rows by filename+extractionId.
      const byKey = new Map((data.results || []).map((o) => [`${o.extractionId || ''}|${o.filename || ''}`, o]));
      setRows((rs) => rs.map((r) => {
        const o = byKey.get(`${r.extractionId || ''}|${r.filename || ''}`);
        if (!o) return r;
        if (o.status === 'committed') return { ...r, status: 'committed', measurementsCreated: o.measurementsCreated, deficienciesCreated: o.deficienciesCreated };
        return { ...r, status: 'commit-failed', error: o.error };
      }));
      setStep(3);
    } catch (err) {
      setError((err && err.response && err.response.data && err.response.data.error) || 'Failed to commit the batch.');
    } finally {
      setCommitting(false);
    }
  }

  function reset() {
    setStep(1); setRows([]); setResult(null); setError(''); setProgress({ done: 0, total: 0 });
  }

  return (
    <div className="page-container">
      {/* one keyframes definition for the row spinners */}
      <style>{'@keyframes sc-spin{to{transform:rotate(360deg)}}'}</style>

      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Layers size={22} strokeWidth={1.75} /> Bulk import test reports
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 760, lineHeight: 1.6 }}>
        Drop a whole folder of PowerDB / Megger / NETA report PDFs at once. ServiceCycle extracts each one, you glance at the
        queue, match each report to its asset, and commit the batch — no file-by-file uploads.
      </p>

      {targetAccountId && (
        <div style={{ padding: '10px 14px', background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, color: '#5b21b6', marginBottom: 16, fontSize: 'var(--font-size-sm)' }}>
          Ingesting for <strong>{targetCustomer || 'a fleet customer'}</strong>. Matches and readings are written to that customer's account, not yours.
        </div>
      )}

      {error && <div style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {/* Step 1 — drop-zone */}
      {step === 1 && (
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className="card"
          style={{ borderStyle: 'dashed', borderColor: dragOver ? 'var(--color-primary, #2563eb)' : 'var(--color-border)', background: dragOver ? 'var(--color-bg-subtle, #f8fafc)' : undefined }}
        >
          <div className="card-body" style={{ textAlign: 'center', padding: 48 }}>
            <UploadCloud size={44} strokeWidth={1.25} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Drop test-report PDFs here — up to 50 at a time</div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
              PDFs, or clear photos (JPG/PNG/HEIC) of printed sheets. They upload in small batches and extract in the background.
            </div>
            <input ref={fileInputRef} type="file" accept="application/pdf,.pdf,image/*" multiple onChange={onInputChange} />
          </div>
        </div>
      )}

      {/* Step 2 — queue + review */}
      {(step === 2 || step === 3) && (
        <>
          {/* progress banner while extracting */}
          {step === 2 && busy && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1d4ed8', fontSize: 'var(--font-size-sm)' }}>
              Extracting… {progress.done} of {progress.total} files processed.
            </div>
          )}

          {step === 2 && multiRows.length > 0 && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3', fontSize: 'var(--font-size-sm)' }}>
              {multiRows.length} report{multiRows.length === 1 ? '' : 's'} cover multiple assets. Commit those from the single-report screen (Import Test Report) so each section matches its own asset — they're excluded from this one-click batch.
            </div>
          )}
          {step === 2 && includedNeedingAsset.length > 0 && (
            <div style={{ padding: '10px 14px', marginBottom: 14, borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 'var(--font-size-sm)' }}>
              {includedNeedingAsset.length} included report{includedNeedingAsset.length === 1 ? '' : 's'} still need an asset picked before they can commit.
            </div>
          )}

          <div className="card mb-16">
            <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
              <div className="card-title">Report queue ({rows.length})</div>
              {step === 2 && extractedRows.length > 0 && (
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={allIncluded} onChange={(e) => selectAll(e.target.checked)} />
                  Select all
                </label>
              )}
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              {rows.length === 0
                ? <div style={{ padding: 16, color: 'var(--color-text-secondary)' }}>No files yet.</div>
                : rows.map((r) => (
                    <BulkReportRow
                      key={r.id}
                      entry={r}
                      assets={assets}
                      onToggleInclude={toggleInclude}
                      onPickAsset={pickAsset}
                      onReviewDetail={reviewDetail}
                    />
                  ))}
            </div>
          </div>

          {step === 2 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={committing || busy || !committable.length} onClick={commitAll}>
                {committing ? 'Committing…' : `Commit ${committable.length} report${committable.length === 1 ? '' : 's'} & generate fix lists`}
              </button>
              <button className="btn btn-secondary" onClick={reset} disabled={committing}>Start over</button>
              {busy && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Still extracting — you can begin reviewing finished rows now.</span>}
            </div>
          )}
        </>
      )}

      {/* Step 3 — results summary */}
      {step === 3 && result && (
        <div className="card"><div className="card-body" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <CheckCircle2 size={24} style={{ color: 'var(--color-success)' }} />
            <h2 style={{ margin: 0, fontSize: 18 }}>Batch imported</h2>
          </div>
          <div style={{ padding: '12px 16px', marginBottom: 18, borderRadius: 8, background: 'var(--color-success-bg, #f0fdf4)', border: '1px solid var(--color-success-border, #bbf7d0)', fontSize: 'var(--font-size-sm)' }}>
            Committed <strong>{result.committed}</strong> of {result.itemsSubmitted} report{result.itemsSubmitted === 1 ? '' : 's'}
            {result.failed > 0 ? <> · <strong style={{ color: '#b91c1c' }}>{result.failed} failed</strong></> : ''}
            {' '}— <strong>{result.measurementsCreated}</strong> readings recorded, <strong>{result.deficienciesCreated}</strong> deficienc{result.deficienciesCreated === 1 ? 'y' : 'ies'} flagged.
          </div>
          {/* Per-file outcomes reuse the same row component (committed / commit-failed states). */}
          <div className="card mb-16"><div className="card-body" style={{ padding: 0 }}>
            {rows.filter((r) => r.status === 'committed' || r.status === 'commit-failed').map((r) => (
              <BulkReportRow key={r.id} entry={r} assets={assets} onToggleInclude={() => {}} onPickAsset={() => {}} onReviewDetail={() => {}} />
            ))}
          </div></div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/deficiencies?resolved=false" className="btn btn-secondary">View fix-it list</Link>
            <button className="btn btn-secondary" onClick={reset}>Import another batch</button>
          </div>
        </div></div>
      )}
    </div>
  );
}
