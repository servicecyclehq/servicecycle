// ─────────────────────────────────────────────────────────────────────────────
// AccountBackupReport.jsx — full-account export (/reports/account-backup).
//
// Block 1 #5 (phase 2): the "Export Everything" tile now opens an in-platform
// page with the shared ReportActionBar. This one is a genuine full-account data
// backup (one sheet per record type / a lossless JSON), NOT a report — so its
// primary affordances are Download Excel and Download JSON, plus Print. There
// is intentionally no "Download PDF": a PDF of an entire multi-sheet account
// backup isn't a usable artifact. (Every other report keeps Print + Download
// PDF; this is the single, deliberate export exception — flagged for Dustin.)
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Download, Archive } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import BackLink from '../components/BackLink';
import ReportActionBar from '../components/ReportActionBar';

const CONTENTS = [
  'Sites, assets, and maintenance schedules',
  'Work orders, deficiencies, and quote requests',
  'Arc-flash studies and labels; LOTO procedures',
  'Parts catalog, spare inventory, and asset part requirements',
  'Document and compliance-snapshot metadata with integrity hashes and retrieval paths',
];

export default function AccountBackupReport() {
  useDocumentTitle('Account Backup');

  const [busy, setBusy] = useState('');   // '', 'xlsx', 'json'
  const [error, setError] = useState('');

  async function download(kind) {
    if (busy) return;
    setBusy(kind);
    setError('');
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const stamp = new Date().toISOString().slice(0, 10);
      const url = `${base}/api/export/account?format=${kind}`;
      await downloadAuthedFile(url, `ServiceCycle-Account-Export-${stamp}.${kind}`);
    } catch (e) {
      setError(e?.message || 'Failed to prepare the account backup.');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Account Backup</h1>
          <div className="page-subtitle">
            A complete, portable copy of your account in open formats — yours to keep or re-import anywhere.
          </div>
        </div>
        <ReportActionBar
          leading={(
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => download('xlsx')}
                disabled={!!busy}
                title="Download the full account as a multi-sheet Excel workbook"
              >
                <Download size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                {busy === 'xlsx' ? 'Preparing…' : 'Download Excel'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => download('json')}
                disabled={!!busy}
                title="Download the lossless JSON copy"
              >
                <Download size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
                {busy === 'json' ? 'Preparing…' : 'Download JSON'}
              </button>
            </>
          )}
        />
      </div>

      <div className="page-body print-doc">
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Account Backup</h1>
          <div className="print-masthead-meta">Generated {new Date().toLocaleDateString()}</div>
        </header>
        <div className="print-rule print-only"></div>

        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div
          className="card"
          style={{
            padding: '12px 16px', marginBottom: 20,
            fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)',
            lineHeight: 1.55, borderLeft: '3px solid var(--color-primary)',
          }}
        >
          <strong style={{ color: 'var(--color-text)' }}>No lock-in.</strong>{' '}
          The Excel workbook has one sheet per record type and opens directly in Excel or Sheets. The JSON is the
          lossless, canonical copy. Every export is recorded in the account audit log.
        </div>

        <section className="print-sec">
          <div className="print-sec-head print-only">
            <span className="print-sec-no" />
            <h2 className="print-sec-title">What's included</h2>
          </div>
          <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>
            What's included
          </h2>
          <div className="card" style={{ padding: '14px 18px' }}>
            <ul style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
              {CONTENTS.map((c) => <li key={c}>{c}</li>)}
            </ul>
          </div>
        </section>

        <div className="no-print" style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
          <Archive size={14} strokeWidth={1.75} />
          A full-account backup is a data export, not a report — so this page offers Excel and JSON rather than a PDF.
        </div>

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">Generated {new Date().toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}
