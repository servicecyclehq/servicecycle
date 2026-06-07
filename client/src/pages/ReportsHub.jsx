// ─────────────────────────────────────────────────────────────────────────────
// ReportsHub.jsx — ServiceCycle compliance reports hub ("coming soon" state).
//
// The contract-renewal report grid was removed in the ServiceCycle conversion.
// This hub renders the planned compliance report suite as disabled cards
// (NFPA 70B Compliance Rate by Site, Overdue Maintenance by Severity, Audit
// Evidence Pack) plus one ACTIVE card that downloads the asset register via
// GET /api/export/xlsx?view=assets.
//
// The registry (client/src/tables/reportsRegistry.js) is the single source of
// truth for the cards. When a planned report ships, flip `planned: false` and
// add its route there.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { Download } from 'lucide-react';
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
            <Download size={14} />
            {busy ? 'Preparing download…' : 'Download XLSX'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ReportsHub() {
  useDocumentTitle('Reports');
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState(null);

  async function handleActivate(report) {
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
            The compliance report suite is on the way. Until it ships, you can export the asset register below.
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
          <strong style={{ color: 'var(--color-text)' }}>Coming soon.</strong>{' '}
          Compliance reports are planned for an upcoming release — NFPA 70B compliance rate by site,
          overdue maintenance by severity, and an audit evidence pack for insurance and OSHA documentation.
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
              busy={exporting && !!r.exportView}
            />
          ))}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
