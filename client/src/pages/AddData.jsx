// ─────────────────────────────────────────────────────────────────────────────
// AddData.jsx — gem W2: one "drop anything" door. The user shouldn't have to
// know our parser taxonomy (asset CSV vs CMMS export vs test-report PDF). Drop
// a file; we sniff it and route to the right importer, carrying the file so
// they don't re-pick it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UploadCloud, FileText, Table2, Database, Mail, Archive, Copy, Check } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { setPendingImport } from '../lib/pendingImport';
import api from '../api/client';

// Extension-level first pass. PDFs and .docx are NOT routed by extension alone —
// an arc-flash study and an instrument test report are both PDFs/Word docs, so
// they go through a server content pre-scan (POST /api/ingest/classify) that
// reads a text sample and picks the right importer. Legacy binary .doc has no
// lightweight extractor and is rejected with a "save as .docx" message.
function sniff(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.zip')) return { kind: 'backfill', route: '/backfill', label: 'zip of report PDFs/photos' };
  if (/\.(csv|xlsx|xls)$/.test(name)) return { kind: 'assets', route: '/assets/import', label: 'asset / schedule spreadsheet' };
  if (name.endsWith('.pdf') || name.endsWith('.docx')) return { kind: 'document', label: 'PDF / Word document' };
  if (name.endsWith('.doc')) return { kind: 'legacy-doc', label: 'legacy Word .doc' };
  // SC-26 fix (2026-07-24): a nameplate photo used to hard dead-end here with
  // a "go find the asset's page" message even though a working AI nameplate
  // reader already existed (NewAsset.jsx's "Start from a photo" panel, POST
  // /api/assets/photo-inspect) -- it just wasn't wired to this page. Only the
  // types that reader's server-side multer filter actually accepts
  // (server/routes/assetPhotoInspect.ts ACCEPTED_MIME: jpeg/png/webp/heic/heif)
  // get routed there; gif/tiff/bmp still sniff as a photo so they get an
  // honest "not supported yet" message instead of falling through to the
  // generic "not sure how to read this" error below.
  if (/\.(jpe?g|png|heic|heif|webp)$/.test(name)) return { kind: 'image', label: 'photo / image' };
  if (/\.(gif|tiff?|bmp)$/.test(name)) return { kind: 'image-unsupported', label: 'photo / image' };
  return null;
}

export default function AddData() {
  useDocumentTitle('Add data');
  const navigate = useNavigate();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);            // classify request in flight
  const [choice, setChoice] = useState(null);          // { file } awaiting manual type pick
  const [choiceKind, setChoiceKind] = useState('');    // user's pick in the fallback dropdown

  // 2026-07-13 fix: this card used to show a literal "reports-…@servicecycle.app"
  // placeholder -- no real account had a working address, since nothing ever
  // provisioned one. GET /api/settings/inbound-email now auto-creates + returns
  // the account's actual forwarding address.
  const [inboundEmail, setInboundEmail] = useState(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let on = true;
    api.get('/api/settings/inbound-email')
      .then(r => { if (on) setInboundEmail(r.data?.data?.email || null); })
      .catch(() => { if (on) setInboundEmail(null); });
    return () => { on = false; };
  }, []);

  function copyInboundEmail() {
    if (!inboundEmail) return;
    navigator.clipboard?.writeText(inboundEmail).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  async function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setErr(''); setChoice(null); setChoiceKind('');
    const s = sniff(file);
    if (!s) { setErr(`Not sure how to read "${file.name}". Use a PDF/Word test report, a CSV/XLSX spreadsheet, or a .zip of reports.`); return; }
    if (s.kind === 'legacy-doc') {
      setErr(`Legacy .doc (Word 97-2003) isn't supported. Open "${file.name}" in Word and "Save As" .docx, then try again.`);
      return;
    }
    if (s.kind === 'image-unsupported') {
      setErr(`"${file.name}" is a photo type we can't read for nameplate scanning yet (JPEG, PNG, WebP, and HEIC are supported -- that covers basically every phone camera). Re-save/export it as JPEG and try again, or drop a .zip if this is part of a batch.`);
      return;
    }
    if (s.kind === 'image') {
      // SC-26 fix: hand the photo to /assets/new's existing "Start from a
      // photo" AI flow instead of dead-ending here -- that flow already does
      // everything a nameplate scan needs (AI-consent gate, HEIC transcode,
      // structured manufacturer/model/serial/ratings extraction). NewAsset.jsx
      // picks this file up via takePendingImport() on mount and auto-runs it.
      setPendingImport(file);
      navigate('/assets/new');
      return;
    }
    if (s.kind === 'backfill' || s.kind === 'assets') {
      setPendingImport(file);
      navigate(s.route);
      return;
    }
    // PDF / .docx: classify by content so an arc-flash study doesn't land in the
    // test-report parser (and vice-versa). Fails soft — if the scan can't decide
    // (or the endpoint errors), we ask the user rather than guessing.
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/api/ingest/classify', fd);
      const kind = r.data?.data?.kind;
      if (kind === 'test_report') { setPendingImport(file); navigate('/test-reports/import'); return; }
      if (kind === 'arc_flash')   {
        // Pre-fill the arc-flash page's "one-line diagram" vs "study report"
        // dropdown from the server's text-density hint -- still just a default,
        // the dropdown stays editable, so a wrong guess costs one click, not a
        // misroute.
        const suggestedSourceType = r.data?.data?.suggestedSourceType || 'study_report';
        setPendingImport(file, { sourceType: suggestedSourceType });
        navigate('/arc-flash/import');
        return;
      }
      setChoice({ file }); // ambiguous / unreadable
    } catch {
      setChoice({ file }); // classify unavailable — ask, don't guess
    } finally {
      setBusy(false);
    }
  }

  function chooseType(kind) {
    if (!choice?.file || !kind) return;
    // 'one_line' and 'arc_flash' both land on the same arc-flash importer --
    // the only difference is which sourceType the page pre-selects.
    if (kind === 'one_line') {
      setPendingImport(choice.file, { sourceType: 'one_line' });
      navigate('/arc-flash/import');
      return;
    }
    if (kind === 'arc_flash') {
      setPendingImport(choice.file, { sourceType: 'study_report' });
      navigate('/arc-flash/import');
      return;
    }
    setPendingImport(choice.file);
    navigate('/test-reports/import');
  }

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <UploadCloud size={22} strokeWidth={1.75} /> Add data
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 720, lineHeight: 1.6 }}>
        Drop a report, spreadsheet, or export and we'll route it to the right importer. A contractor's test-report PDF, an
        asset spreadsheet, a CMMS export, or a .zip of reports. No need to know which importer it belongs to.
      </p>

      {err && <div style={{ padding: '12px 16px', background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', borderRadius: 8, color: 'var(--chip-red-fg)', marginBottom: 16 }}>{err}</div>}

      <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
        <UploadCloud size={40} strokeWidth={1.25} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Drop a file or choose one</div>
        <input type="file" accept=".pdf,.doc,.docx,.csv,.xlsx,.xls,.zip,.jpg,.jpeg,.png,.webp,.heic,.heif" onChange={onFile} disabled={busy} />
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 10 }}>
          PDF / Word test report · arc-flash study · asset CSV/XLSX · nameplate photo · .zip of reports (bulk backfill)
        </div>
        {busy && (
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
            Reading the document to route it to the right importer…
          </div>
        )}

        {/* Ambiguous-case fallback — mirrors the ArcFlashIngestPanel type dropdown */}
        {choice && (
          <div style={{ marginTop: 14, padding: '12px 14px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8, textAlign: 'left', maxWidth: 460, marginLeft: 'auto', marginRight: 'auto' }}>
            <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 8 }}>
              We couldn't tell what <strong>{choice.file.name}</strong> is. Which kind of document is it?
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <select value={choiceKind} onChange={e => setChoiceKind(e.target.value)}>
                <option value="">— choose type —</option>
                <option value="test_report">Instrument test report (PowerDB / Megger / NETA)</option>
                <option value="arc_flash">Arc-flash / short-circuit study (has incident-energy results)</option>
                <option value="one_line">One-line / single-line diagram (equipment layout, no results yet)</option>
              </select>
              <button type="button" className="btn" disabled={!choiceKind} onClick={() => chooseType(choiceKind)}>Continue</button>
            </div>
          </div>
        )}
      </div></div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
        <Link to="/test-reports/import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><FileText size={16} /> Test report (PDF)</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>PowerDB / Megger / NETA → fix list</div>
        </Link>
        <Link to="/test-reports/bulk-import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><UploadCloud size={16} /> Bulk PDFs</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Drop a stack of test reports → extraction queue → review → commit</div>
        </Link>
        <Link to="/import/assets" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Table2 size={16} /> Smart import (any spreadsheet)</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Any CSV/XLSX layout — columns auto-mapped, you approve, assets appear</div>
        </Link>
        <Link to="/import/doble" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Database size={16} /> Doble export</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>TestGuide / TDMS XML or CSV → same measurement pool as PowerDB</div>
        </Link>
        <Link to="/assets/import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Table2 size={16} /> Assets (CSV/XLSX)</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Bulk import equipment + schedules</div>
        </Link>
        <Link to="/backfill" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Archive size={16} /> Bulk backfill (.zip)</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>A folder of past reports → asset cards</div>
        </Link>
        <Link to="/import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Database size={16} /> CMMS export</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Maximo / SAP PM / Oracle EAM</div>
        </Link>
        <div className="card" style={{ flex: '1 1 260px', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Mail size={16} /> Email-in <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-success)', border: '1px solid var(--color-success)', borderRadius: 4, padding: '1px 5px' }}>LIVE</span></div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            Forward a test report as an email attachment — it parses every line and creates the asset cards automatically. No upload step.
          </div>
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
              Your account's address
            </div>
            {inboundEmail ? (
              <button
                type="button"
                onClick={copyInboundEmail}
                title="Copy to clipboard"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, width: '100%',
                  background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                  borderRadius: 6, padding: '6px 10px', cursor: 'pointer', textAlign: 'left',
                }}
              >
                <code style={{ fontSize: 'var(--font-size-xs)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{inboundEmail}</code>
                {copied
                  ? <Check size={13} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
                  : <Copy size={13} style={{ color: 'var(--color-text-secondary)', flexShrink: 0 }} />}
              </button>
            ) : (
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>Loading your address…</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
