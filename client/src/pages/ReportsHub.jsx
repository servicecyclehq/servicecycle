// ─────────────────────────────────────────────────────────────────────────────
// ReportsHub.jsx — ServiceCycle compliance reports hub.
//
// The contract-renewal report grid was removed in the ServiceCycle conversion.
// This hub renders the compliance report suite: cards either navigate to an
// in-app report route (`to`: Compliance by Standard, Overdue Maintenance by
// Severity, Standards Library, Audit Evidence Snapshots, the arc-flash suite,
// Revenue Attribution) or download an export (`exportView` / `accountExport` /
// `empDownload`). Every card in the registry is live.
//
// The registry (client/src/tables/reportsRegistry.js) is the single source of
// truth for the cards. ReportCard still supports a `planned: true` flag (renders
// a disabled "Planned" card) for any future report that ships in stages, but no
// registry entry currently sets it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Download } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import Toast from '../components/Toast';
import { REPORTS } from '../tables/reportsRegistry';

function ReportCard({ report, onActivate, busy }) {
  const Icon = report.icon;
  const planned = !!report.planned;

  return (
    <div
      className="card"
      role={planned ? undefined : 'button'}
      tabIndex={planned ? undefined : 0}
      aria-disabled={planned || undefined}
      style={{
        padding: 0,
        overflow: 'hidden',
        cursor: planned ? 'default' : (busy ? 'progress' : 'pointer'),
        display: 'flex',
        flexDirection: 'column',
        opacity: planned ? 0.72 : 1,
        transition: 'box-shadow 0.15s, transform 0.1s',
      }}
      onClick={() => !planned && !busy && onActivate(report)}
      onKeyDown={e => {
        if (!planned && !busy && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onActivate(report);
        }
      }}
      onMouseEnter={e => {
        if (planned) return;
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.transform = '';
      }}
    >
      <div style={{ padding: '14px 16px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 7,
            background: 'var(--color-bg-subtle, #f1f5f9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={16} color="var(--color-text-secondary)" strokeWidth={1.75} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', color: 'var(--color-text)', lineHeight: 1.3 }}>
                {report.name}
              </span>
              {planned && (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '2px 6px', borderRadius: 4,
                  background: 'var(--color-bg-subtle, #f1f5f9)',
                  color: 'var(--color-text-secondary)', textTransform: 'uppercase',
                }}>
                  Planned
                </span>
              )}
            </div>
          </div>
        </div>

        <p style={{
          fontSize: 12.5, color: 'var(--color-text-secondary)',
          lineHeight: 1.55, margin: '0 0 12px', flex: 1,
        }}>
          {report.description}
        </p>

        {!planned && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            gap: 4,
            fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-primary)',
          }}>
            {report.to ? (
              <>
                Open report
                <ArrowRight size={14} />
              </>
            ) : report.empDownload ? (
              <>
                <Download size={14} />
                {busy ? 'Generating EMP…' : 'Download PDF'}
              </>
            ) : report.accountExport ? (
              <>
                <Download size={14} />
                {busy ? 'Preparing export…' : 'Download backup (JSON)'}
              </>
            ) : (
              <>
                <Download size={14} />
                {busy ? 'Preparing download…' : 'Download XLSX'}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReportsHub() {
  useDocumentTitle('Reports');
  const navigate = useNavigate();
  const [exporting, setExporting] = useState(false);
  const [empGenerating, setEmpGenerating] = useState(false);
  const [toast, setToast] = useState(null);

  async function handleActivate(report) {
    // In-app report routes navigate; export cards download.
    if (report.to) {
      navigate(report.to);
      return;
    }

    // EMP PDF download — GET /api/reports/emp streams the PDF directly.
    if (report.empDownload) {
      if (empGenerating) return;
      setEmpGenerating(true);
      setToast({ title: 'Generating EMP…', message: 'Building your Electrical Maintenance Program document — this may take a few seconds.', variant: 'info', duration: 8000 });
      try {
        const months = report.empMonths ?? 24;
        const url = `${import.meta.env.VITE_API_URL ?? ''}/api/reports/emp?months=${months}`;
        const dateStamp = new Date().toISOString().split('T')[0];
        await downloadAuthedFile(url, `EMP_${dateStamp}.pdf`);
        setToast({ title: 'EMP document ready', message: 'Your Electrical Maintenance Program PDF is downloading.', variant: 'success', duration: 5000 });
      } catch (e) {
        setToast({ title: 'EMP generation failed', message: e.message || 'Please try again.', variant: 'error', duration: 8000 });
      } finally {
        setEmpGenerating(false);
      }
      return;
    }

    // #5 Export-everything — full-account portable backup (lossless JSON).
    if (report.accountExport) {
      if (exporting) return;
      setExporting(true);
      setToast({ title: 'Preparing account export…', message: 'Bundling every record into a portable file — this may take a moment.', variant: 'info', duration: 6000 });
      try {
        const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/account?format=json`;
        await downloadAuthedFile(url, `ServiceCycle-Account-Export-${new Date().toISOString().split('T')[0]}.json`);
        setToast({ title: 'Export ready', message: 'Your complete account backup is downloading.', variant: 'success', duration: 4000 });
      } catch (e) {
        setToast({ title: 'Export failed', message: e.message || 'Please try again.', variant: 'error', duration: 8000 });
      } finally {
        setExporting(false);
      }
      return;
    }

    if (!report.exportView || exporting) return;
    setExporting(true);
    setToast({ title: 'Preparing export…', message: 'Building your file — this may take a moment.', variant: 'info', duration: 5000 });
    try {
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/export/xlsx?view=${encodeURIComponent(report.exportView)}`;
      await downloadAuthedFile(url, `AssetRegister-${new Date().toISOString().split('T')[0]}.xlsx`);
      setToast({ title: 'Export ready', message: 'Your file is downloading.', variant: 'success', duration: 4000 });
    } catch (e) {
      setToast({ title: 'Export failed', message: e.message || 'Please try again.', variant: 'error', duration: 8000 });
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <div className="page-subtitle">
            Audit-oriented reporting — compliance evidence, overdue risk, and exports today; more reports land as your maintenance data accumulates.
          </div>
        </div>
      </div>

      <div className="page-body">
        <div
          className="card"
          style={{
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 'var(--font-size-ui)',
            color: 'var(--color-text-secondary)',
            lineHeight: 1.55,
            borderLeft: '3px solid var(--color-primary)',
          }}
        >
          <strong style={{ color: 'var(--color-text)' }}>What's here.</strong>{' '}
          Compliance by Standard rolls maintenance status up per governing standard with a drill-down
          evidence table; Overdue Maintenance by Severity surfaces the riskiest gaps first; the Standards
          Library explains each governing document in plain language; Audit Evidence Snapshots produce
          immutable, hash-anchored PDFs for insurers and AHJs. The arc-flash suite, EMP document, and
          full account export round out the set.
        </div>

        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 14,
        }}>
          {REPORTS.map(r => (
            <ReportCard
              key={r.id}
              report={r}
              onActivate={handleActivate}
              busy={(exporting && (!!r.exportView || !!r.accountExport)) || (empGenerating && !!r.empDownload)}
            />
          ))}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
