import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// StubReport.jsx — generic "Coming soon" placeholder for Phase 3 reports
// listed in the registry. Reads the report metadata via the route params and
// renders a styled placeholder so the IA chassis stays complete in v0.58.0
// while the actual aggregation logic ships in v0.59+.
// ─────────────────────────────────────────────────────────────────────────────

import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronLeft, Clock } from 'lucide-react';
import { REPORTS } from '../tables/reportsRegistry';

export default function StubReport() {
  const navigate = useNavigate();
  const location = useLocation();

  // Find the registry entry whose route matches the current path. Falls back
  // to a "Coming soon" generic shell if the route isn't registered.
  const report = REPORTS.find(r => r.route === location.pathname);

  const Icon = report?.icon || Clock;

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">{report?.name || 'Report'}</h1>
          <div className="page-subtitle">{report?.description}</div>
        </div>
      </div>

      <div className="page-body">
        <div className="card" style={{
          padding: 40,
          textAlign: 'center',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
        }}>
          <div style={{
            width: 64, height: 64, borderRadius: 16,
            background: 'var(--color-bg-subtle, #f1f5f9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={28} color="var(--color-text-secondary)" strokeWidth={1.6} />
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>
              Coming soon
            </div>
            <p style={{
              fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)',
              lineHeight: 1.6, maxWidth: 480, margin: '0 auto',
            }}>
              This report is not yet available.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => navigate('/reports')}
          >
            Back to Reports
          </button>
        </div>
      </div>
    </>
  );
}
