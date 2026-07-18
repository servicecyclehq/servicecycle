// ─────────────────────────────────────────────────────────────────────────────
// ReportActionBar.jsx — the shared action bar for every Reports page.
//
// Standardizes the right-side header controls so every report reads as one
// system (Block 1 #5): a primary "Download PDF" (server-rendered Field Report,
// same as /reports/compliance) + a secondary "Print" (browser print via the
// shared styles/print.css standard). Extra report-specific buttons (e.g.
// Download XLSX, audit snapshot, generate bundle) render BEFORE the standard
// pair via `leading`, so the Print + Download PDF pairing is identical
// everywhere while individual reports can still add their own affordances.
//
// Contract:
//   <ReportActionBar
//     onDownloadPdf={async () => {...}}   // omit to hide the Download PDF button
//     pdfBusy={bool} pdfDisabled={bool}
//     pdfLabel="Download PDF" pdfBusyLabel="Building PDF…"
//     onPrint={() => window.print()}      // defaults to window.print
//     showPrint={true}
//     leading={<button className="btn btn-primary">…</button>}  // extra buttons
//   />
//
// Rendered inside a `.page-header` as its right-hand element, mirroring
// ComplianceStandardsReport.jsx exactly. `no-print` so the bar never appears
// in the printed artifact.
// ─────────────────────────────────────────────────────────────────────────────

import { Printer, Download } from 'lucide-react';

export default function ReportActionBar({
  onDownloadPdf,
  pdfBusy = false,
  pdfDisabled = false,
  pdfLabel = 'Download PDF',
  pdfBusyLabel = 'Building PDF…',
  onPrint,
  showPrint = true,
  leading = null,
}) {
  const handlePrint = onPrint || (() => window.print());
  return (
    <div
      className="no-print"
      style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap', justifyContent: 'flex-end' }}
    >
      {leading}
      {onDownloadPdf && (
        <button
          type="button"
          className="btn btn-primary"
          onClick={onDownloadPdf}
          disabled={pdfBusy || pdfDisabled}
          title="Download this report as a PDF"
        >
          <Download size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          {pdfBusy ? pdfBusyLabel : pdfLabel}
        </button>
      )}
      {showPrint && (
        <button
          type="button"
          className="btn btn-secondary"
          onClick={handlePrint}
          title="Print this report"
        >
          <Printer size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
          Print
        </button>
      )}
    </div>
  );
}
