// ─────────────────────────────────────────────────────────────────────────────
// BackfillImport.jsx — #34 bulk historical backfill (client UI).
//
// Upload a single .zip of test-report PDFs/photos. The server fans it out into
// one auto-commit ingest job per report (POST /api/ingest/backfill), and this
// page polls POST /api/ingest/backfill/status, showing per-file progress and
// the running count of asset cards created. manager+ (route-gated in App.jsx).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { UploadCloud, Archive, CheckCircle2, AlertTriangle, Loader2, FileText } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { takePendingImport } from '../lib/pendingImport';

const POLL_MS = 2500;
const ZIP_RE = /\.zip$/i;

const STATUS_META = {
  queued:     { label: 'Queued',     color: 'var(--color-text-secondary)' },
  processing: { label: 'Processing', color: 'var(--color-warning, #b45309)' },
  done:       { label: 'Done',       color: 'var(--color-success, #15803d)' },
  failed:     { label: 'Failed',     color: 'var(--color-danger, #b91c1c)' },
};

export default function BackfillImport() {
  useDocumentTitle('Bulk backfill');

  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [file, setFile] = useState(null);
  const [phase, setPhase] = useState('pick'); // pick | uploading | polling | done
  const [err, setErr] = useState('');
  const [batch, setBatch] = useState(null);   // { batchSize, jobIds, truncated, skipped, skippedNonReport }
  const [status, setStatus] = useState(null);  // aggregate status payload

  const cancelledRef = useRef(false);
  const timerRef = useRef(null);

  // Optional site picker (server falls back to the account's first site).
  useEffect(() => {
    api.get('/api/sites').then(r => setSites(r.data?.data?.sites || [])).catch(() => {});
  }, []);

  // Consume a .zip dropped on the Add-data door, if any.
  useEffect(() => {
    const pending = takePendingImport();
    if (pending && ZIP_RE.test(pending.name || '')) setFile(pending);
  }, []);

  // Cleanup any in-flight poll on unmount.
  useEffect(() => () => { cancelledRef.current = true; clearTimeout(timerRef.current); }, []);

  const pollOnce = useCallback(async (jobIds) => {
    if (cancelledRef.current) return;
    try {
      const r = await api.post('/api/ingest/backfill/status', { jobIds });
      const data = r.data?.data;
      if (cancelledRef.current) return;
      setStatus(data);
      if (data && data.complete) { setPhase('done'); return; }
    } catch (e) {
      // Transient poll error: keep trying, surface only if it persists into done.
      if (cancelledRef.current) return;
    }
    timerRef.current = setTimeout(() => pollOnce(jobIds), POLL_MS);
  }, []);

  function onPick(e) {
    const f = e.target.files?.[0];
    setErr('');
    if (!f) return;
    if (!ZIP_RE.test(f.name || '')) { setErr(`"${f.name}" is not a .zip. Zip your report PDFs/photos together first.`); return; }
    setFile(f);
  }

  async function onUpload() {
    if (!file || phase === 'uploading' || phase === 'polling') return;
    setErr('');
    setBatch(null);
    setStatus(null);
    setPhase('uploading');
    cancelledRef.current = false;
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (siteId) fd.append('siteId', siteId);
      const res = await api.post('/api/ingest/backfill', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const data = res.data?.data;
      if (!data || !Array.isArray(data.jobIds) || data.jobIds.length === 0) {
        setPhase('pick');
        setErr('No report files were found in that archive. Add PDFs or photos (PDF, JPG, PNG, HEIC, WebP) and try again.');
        return;
      }
      setBatch(data);
      setPhase('polling');
      pollOnce(data.jobIds);
    } catch (e) {
      setPhase('pick');
      const msg = e?.response?.data?.error || e?.message || 'Upload failed. Try again.';
      setErr(msg);
    }
  }

  function reset() {
    cancelledRef.current = true;
    clearTimeout(timerRef.current);
    setFile(null); setBatch(null); setStatus(null); setErr(''); setPhase('pick');
  }

  const counts = status?.counts || {};
  const finished = (counts.done || 0) + (counts.failed || 0);
  const totalJobs = batch?.jobIds?.length || status?.found || 0;
  const pct = totalJobs > 0 ? Math.round((finished / totalJobs) * 100) : 0;
  const busy = phase === 'uploading' || phase === 'polling';

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Archive size={22} strokeWidth={1.75} /> Bulk backfill
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 720, lineHeight: 1.6 }}>
        Stand up an account from a folder of past test reports in one move. Zip your report
        PDFs (and report photos) together and drop the archive here — each report becomes an
        asset card automatically. For a single report, use{' '}
        <Link to="/test-reports/import">Import test report</Link> instead.
      </p>

      {err && (
        <div role="alert" style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" /> <span>{err}</span>
        </div>
      )}

      {/* ── Picker ──────────────────────────────────────────────────────── */}
      {(phase === 'pick' || phase === 'uploading') && (
        <div className="card"><div className="card-body" style={{ padding: 28 }}>
          <div style={{ marginBottom: 16 }}>
            <label htmlFor="bf-site" style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 6 }}>
              Site for these reports <span style={{ fontWeight: 400, color: 'var(--color-text-secondary)' }}>(optional)</span>
            </label>
            <select
              id="bf-site"
              value={siteId}
              onChange={e => setSiteId(e.target.value)}
              disabled={busy}
              style={{ width: '100%', maxWidth: 420, padding: '8px 10px', borderRadius: 6, border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)', color: 'var(--color-text)' }}
            >
              <option value="">Account default (first site)</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 6 }}>
              Every report in the archive lands on this site. Asset matching still keys on serial first.
            </div>
          </div>

          <label htmlFor="bf-file" style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 6 }}>Report archive (.zip)</label>
          <input id="bf-file" type="file" accept=".zip" onChange={onPick} disabled={busy} />
          {file && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}><Archive size={13} aria-hidden="true" /> {file.name}</div>}

          <div style={{ marginTop: 20 }}>
            <button className="btn btn-primary" onClick={onUpload} disabled={!file || busy} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              {phase === 'uploading'
                ? (<><Loader2 size={15} style={{ animation: 'spin 0.9s linear infinite' }} aria-hidden="true" /> Uploading…</>)
                : (<><UploadCloud size={15} aria-hidden="true" /> Upload &amp; backfill</>)}
            </button>
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 12, lineHeight: 1.5 }}>
            Up to 200 reports per archive · 100 MB zip · 15 MB per report. Accepts PDF, JPG, PNG, HEIC, WebP.
            Reports are auto-committed — review the created asset cards afterward.
          </div>
        </div></div>
      )}

      {/* ── Progress / results ──────────────────────────────────────────── */}
      {batch && (
        <div className="card" style={{ marginTop: 16 }}><div className="card-body" style={{ padding: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 12 }}>
            <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
              {phase === 'done'
                ? <><CheckCircle2 size={18} style={{ color: 'var(--color-success, #15803d)' }} aria-hidden="true" /> Backfill complete</>
                : <><Loader2 size={16} style={{ animation: 'spin 0.9s linear infinite' }} aria-hidden="true" /> Processing {totalJobs} report{totalJobs === 1 ? '' : 's'}…</>}
            </div>
            <div role="status" aria-live="polite" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
              {finished} / {totalJobs} files · <strong style={{ color: 'var(--color-text)' }}>{status?.assetsCommitted || 0}</strong> asset card{(status?.assetsCommitted || 0) === 1 ? '' : 's'} created
            </div>
          </div>

          {/* Progress bar */}
          <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Backfill progress"
               style={{ height: 8, borderRadius: 999, background: 'var(--color-border)', overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ width: `${pct}%`, height: '100%', background: phase === 'done' ? 'var(--color-success, #15803d)' : 'var(--color-primary)', transition: 'width 0.4s ease' }} />
          </div>

          {(batch.truncated || (batch.skippedNonReport && batch.skippedNonReport.length > 0) || (batch.skipped && batch.skipped.length > 0)) && (
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>
              {batch.truncated && <div>⚠ Only the first 200 reports were queued; re-upload the remainder in a second archive.</div>}
              {batch.skipped?.length > 0 && <div>{batch.skipped.length} file(s) skipped: {batch.skipped.slice(0, 5).map(s => `${s.name} (${s.reason})`).join(', ')}{batch.skipped.length > 5 ? '…' : ''}</div>}
              {batch.skippedNonReport?.length > 0 && <div>{batch.skippedNonReport.length} non-report file(s) in the archive were ignored.</div>}
            </div>
          )}

          {/* Per-file list */}
          <div style={{ border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
            {(status?.jobs || []).map(j => {
              const meta = STATUS_META[j.status] || STATUS_META.queued;
              return (
                <div key={j.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--font-size-sm)' }}>
                  <FileText size={14} style={{ flexShrink: 0, color: 'var(--color-text-secondary)' }} aria-hidden="true" />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.fileName || j.id}</span>
                  {j.status === 'done' && <span style={{ color: 'var(--color-text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{j.assetsCommitted} card{j.assetsCommitted === 1 ? '' : 's'}</span>}
                  {j.error && <span title={j.error} style={{ color: 'var(--color-danger, #b91c1c)', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.error}</span>}
                  <span style={{ color: meta.color, fontWeight: 600, minWidth: 78, textAlign: 'right' }}>{meta.label}</span>
                </div>
              );
            })}
            {(!status?.jobs || status.jobs.length === 0) && (
              <div style={{ padding: '14px 12px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Queuing reports…</div>
            )}
          </div>

          {phase === 'done' && (
            <div style={{ marginTop: 18, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link to="/assets" className="btn btn-primary">View asset cards</Link>
              <button className="btn" onClick={reset}>Backfill another archive</button>
            </div>
          )}
        </div></div>
      )}
    </div>
  );
}
