// ─────────────────────────────────────────────────────────────────────────────
// EmpReport.jsx — Electrical Maintenance Program document (/reports/emp).
//
// Block 1 #5 (phase 2): the EMP tile now opens an in-platform page instead of
// instant-downloading. The EMP itself is a formal NFPA 70B §4.2 document
// generated server-side; this page explains what it contains, lets the operator
// choose the work-order history window, and carries the shared ReportActionBar
// (Download PDF → GET /api/reports/emp?months=N, Print). For an immutable,
// audit-logged copy, the Compliance hub's snapshot pipeline is the anchored
// path — this download is the quick, on-demand artifact.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import BackLink from '../components/BackLink';
import ReportActionBar from '../components/ReportActionBar';

const WINDOW_OPTIONS = [12, 24, 36, 48, 60];

const SECTIONS = [
  ['Asset inventory', 'Every in-service asset with its equipment type, ratings, site, and governing condition (C1/C2/C3).'],
  ['Maintenance intervals', 'The condition-based preventive-maintenance schedule per asset — the NFPA 70B §4.2 basis for the program.'],
  ['Work-order history', 'Completed maintenance over the lookback window you choose, with NETA decals and as-left condition.'],
  ['Open deficiencies', 'Unresolved findings by severity, so the program shows its live gaps, not just its plan.'],
  ['Personnel qualifications', 'The qualified-person records that back the work — what carriers ask for at renewal.'],
];

export default function EmpReport() {
  useDocumentTitle('Electrical Maintenance Program');

  const [months, setMonths] = useState(24);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleDownloadPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    setError('');
    try {
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/reports/emp?months=${months}`;
      await downloadAuthedFile(url, `EMP_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) {
      setError(e?.message || 'Failed to generate the EMP document.');
    } finally {
      setPdfBusy(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Electrical Maintenance Program</h1>
          <div className="page-subtitle">
            Your formal NFPA 70B §4.2 Electrical Maintenance Program document — the artifact insurance carriers ask for at policy renewal.
          </div>
        </div>
        <ReportActionBar
          onDownloadPdf={handleDownloadPdf}
          pdfBusy={pdfBusy}
          pdfBusyLabel="Generating EMP…"
          pdfLabel="Download PDF"
        />
      </div>

      <div className="page-body print-doc">
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Electrical Maintenance Program</h1>
          <div className="print-masthead-meta">NFPA 70B §4.2 · Generated {new Date().toLocaleDateString()}</div>
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
          <strong style={{ color: 'var(--color-text)' }}>What this is.</strong>{' '}
          Since the 2023 edition, NFPA 70B makes a documented Electrical Maintenance Program mandatory. This generates that
          document on demand from your live data. For an immutable, SHA-256-anchored copy for an auditor, use Audit Evidence
          Snapshots in the Compliance hub.
        </div>

        <div className="no-print" style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 20, flexWrap: 'wrap' }}>
          <div>
            <label htmlFor="emp-months" className="form-label">Work-order history window</label>
            <select
              id="emp-months"
              className="form-control"
              style={{ maxWidth: 220 }}
              value={months}
              onChange={e => setMonths(Number(e.target.value))}
            >
              {WINDOW_OPTIONS.map(m => <option key={m} value={m}>Last {m} months</option>)}
            </select>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleDownloadPdf}
            disabled={pdfBusy}
            style={{ marginBottom: 1 }}
          >
            {pdfBusy ? 'Generating EMP…' : 'Download EMP document'}
          </button>
        </div>

        <section className="print-sec">
          <div className="print-sec-head print-only">
            <span className="print-sec-no" />
            <h2 className="print-sec-title">What the document contains</h2>
          </div>
          <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>
            What the document contains
          </h2>
          <div className="card">
            <div className="table-wrap">
              <table className="print-table">
                <thead>
                  <tr><th style={{ width: '30%' }}>Section</th><th>Contents</th></tr>
                </thead>
                <tbody>
                  {SECTIONS.map(([name, desc]) => (
                    <tr key={name}>
                      <td style={{ fontWeight: 600 }}>{name}</td>
                      <td className="td-muted">{desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">NFPA 70B §4.2 · Generated {new Date().toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}
