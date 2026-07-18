// ─────────────────────────────────────────────────────────────────────────────
// AssetRegisterReport.jsx — Asset Register export (/reports/asset-register).
//
// Block 1 #5 (phase 2): the Export Asset Register tile now opens an in-platform
// page carrying the shared ReportActionBar instead of instant-downloading. The
// register is a data export, so the primary affordance is Download XLSX
// (GET /api/export/xlsx?view=assets); it also offers Download PDF (the same
// register as a Field Report table, GET /api/export/assets?format=pdf) and
// Print, so it reads like every other report. For the live, filterable list,
// the Assets page remains the interactive surface.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Download } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import BackLink from '../components/BackLink';
import ReportActionBar from '../components/ReportActionBar';

const COLUMNS = [
  ['Site', 'The site the asset belongs to.'],
  ['Equipment Type', 'Canonical equipment type (round-trips back into the CSV importer).'],
  ['Manufacturer / Model / Serial', 'Nameplate identity for each unit.'],
  ['Condition', 'Governing condition rating (C1 / C2 / C3).'],
  ['In Service', 'Whether the asset is currently in service.'],
  ['Next Due', 'Earliest active maintenance-schedule due date.'],
];

export default function AssetRegisterReport() {
  useDocumentTitle('Asset Register');

  const [busy, setBusy] = useState('');   // '', 'pdf', 'xlsx'
  const [error, setError] = useState('');

  async function download(kind) {
    if (busy) return;
    setBusy(kind);
    setError('');
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const stamp = new Date().toISOString().slice(0, 10);
      if (kind === 'pdf') {
        await downloadAuthedFile(`${base}/api/export/assets?format=pdf`, `Asset_Register_${stamp}.pdf`);
      } else {
        await downloadAuthedFile(`${base}/api/export/xlsx?view=assets`, `Asset_Register_${stamp}.xlsx`);
      }
    } catch (e) {
      setError(e?.message || 'Failed to download the asset register.');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Asset Register</h1>
          <div className="page-subtitle">
            The full asset register — every asset with its identity, condition, and next-due date.
          </div>
        </div>
        <ReportActionBar
          onDownloadPdf={() => download('pdf')}
          pdfBusy={busy === 'pdf'}
          pdfDisabled={!!busy}
          leading={(
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => download('xlsx')}
              disabled={!!busy}
              title="Download the asset register as an Excel workbook"
            >
              <Download size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
              {busy === 'xlsx' ? 'Preparing…' : 'Download XLSX'}
            </button>
          )}
        />
      </div>

      <div className="page-body print-doc">
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Asset Register</h1>
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
          <strong style={{ color: 'var(--color-text)' }}>What this is.</strong>{' '}
          A portable snapshot of your equipment inventory in open formats — no lock-in. Download it as an Excel
          workbook or a Field Report PDF. For the live, filterable list you edit day-to-day, use the Assets page.
        </div>

        <section className="print-sec">
          <div className="print-sec-head print-only">
            <span className="print-sec-no" />
            <h2 className="print-sec-title">Columns in the register</h2>
          </div>
          <h2 className="no-print" style={{ fontSize: 'var(--font-size-lg, 17px)', fontWeight: 600, margin: '0 0 10px' }}>
            Columns in the register
          </h2>
          <div className="card">
            <div className="table-wrap">
              <table className="print-table">
                <thead>
                  <tr><th style={{ width: '34%' }}>Column</th><th>What it holds</th></tr>
                </thead>
                <tbody>
                  {COLUMNS.map(([name, desc]) => (
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
          <span className="print-footer-pages">Generated {new Date().toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}
