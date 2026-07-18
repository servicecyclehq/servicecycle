// ─────────────────────────────────────────────────────────────────────────────
// StandardsLibrary.jsx — plain-language guide to the governing standards
// (/reports/standards-library).
//
// GET /api/standards → data.standards: [{ code, edition, publisher, title,
// keyMandate, revisionCycle, _count.taskDefinitions }] (global rows, seeded —
// see server/routes/standards.ts). GET /api/standards/task-definitions gives
// the tenant-visible task matrix; we group it client-side by standard.code so
// each card shows how many task definitions in THIS account's library trace
// to that standard (global seed + the account's custom tasks), falling back
// to the server's _count when the matrix call fails.
//
// The "What it means for you" paragraphs are app copy, not server data —
// they answer "what is this document and why does my facility care" in one
// breath. Keep them accurate and short when editing.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, ArrowRight } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import EmptyState from '../components/EmptyState';
import BackLink from '../components/BackLink';
import ReportActionBar from '../components/ReportActionBar';
import { downloadAuthedFile } from '../api/download';

// Publisher chip palette — literal hexes per the house domain-chip convention.
const PUBLISHER_META = {
  NFPA: { color: '#dc2626', bg: '#fef2f2' },
  NETA: { color: '#2563eb', bg: '#eff6ff' },
  IEEE: { color: '#7c3aed', bg: '#f5f3ff' },
  OSHA: { color: '#d97706', bg: '#fffbeb' },
};

// Plain-English explainers, keyed by ComplianceStandard.code.
const WHAT_IT_MEANS = {
  'NFPA 70B':
    'The backbone of this platform. In 2023 it changed from a recommended practice to a standard — ' +
    'having an electrical maintenance program is now mandatory, not optional, and maintenance intervals ' +
    'must be set by each asset’s assessed condition (the C1/C2/C3 ratings you see on every asset) ' +
    'rather than a one-size-fits-all calendar. Insurers and AHJs increasingly ask for evidence of a 70B program.',
  'NFPA 70E':
    'Worker safety. Where 70B protects the equipment, 70E protects the people working on it: arc flash ' +
    'risk assessments (refreshed at least every five years or after system changes), PPE category selection, ' +
    'energized-work permits, and lockout/tagout practices. OSHA cites 70E as the benchmark for safe electrical work.',
  'NFPA 110':
    'Emergency and standby power. Sets the testing cadence that keeps generators trustworthy: monthly ' +
    'exercise under load, an annual load-bank test when monthly runs don’t reach enough load, and a full ' +
    'system test on a multi-year cycle. Fire marshals and healthcare surveyors check these records directly.',
  'NETA MTS':
    'The "how" behind your maintenance tasks. NETA MTS specifies the field tests for in-service equipment — ' +
    'what to measure, the pass/fail criteria, and (in its Appendix B matrix) how often to test based on ' +
    'condition. Most of the intervals in this platform’s task library trace back to it.',
  'NETA ATS':
    'Acceptance testing for new installations. Before new gear is energized, ATS testing proves it was ' +
    'installed and is performing correctly — and the recorded values become the baseline that later ' +
    'maintenance tests are trended against. If you commission new equipment, this is the spec to put in the contract.',
  'IEEE C57.104':
    'How to read transformer oil results. Dissolved gas analysis (DGA) detects developing faults inside ' +
    'liquid-filled transformers; C57.104 is the guide for interpreting those gas levels and their ' +
    'rate-of-change, mapping them to the Normal / Caution / Action statuses shown on lab samples here.',
  'IEEE 43':
    'The yardstick for motor and generator insulation. Defines how to run insulation resistance tests on ' +
    'rotating machinery and what minimum IR values and polarization index indicate healthy windings — ' +
    'the standard your megohm readings are judged against.',
  'OSHA 1910-S':
    'The law. Unlike the NFPA/NETA/IEEE documents (which are consensus standards), 29 CFR 1910 Subpart S ' +
    'is a federal regulation — directly enforceable, with serious-violation fines in the tens of thousands ' +
    'of dollars per item. Following NFPA 70E and 70B is the accepted way to demonstrate compliance with it.',
};

function PublisherChip({ publisher }) {
  const meta = PUBLISHER_META[publisher] || { color: '#64748b', bg: '#f1f5f9' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.color}`,
      whiteSpace: 'nowrap',
    }}>
      {publisher}
    </span>
  );
}

export default function StandardsLibrary() {
  useDocumentTitle('Standards Library');

  const [standards, setStandards]   = useState([]);
  const [taskCounts, setTaskCounts] = useState(null); // { [code]: n } | null until loaded
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [pdfBusy, setPdfBusy]       = useState(false);

  async function handleDownloadPdf() {
    if (pdfBusy) return;
    setPdfBusy(true);
    try {
      const url = `${import.meta.env.VITE_API_URL ?? ''}/api/standards?format=pdf`;
      await downloadAuthedFile(url, `Standards_Library_${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e) {
      setError(e?.message || 'Failed to download the PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      api.get('/api/standards'),
      api.get('/api/standards/task-definitions'),
    ]).then(([stdRes, defRes]) => {
      if (cancelled) return;
      if (stdRes.status === 'fulfilled') {
        setStandards(stdRes.value.data?.data?.standards || []);
      } else {
        setError(stdRes.reason?.response?.data?.error || 'Failed to load the standards library.');
      }
      if (defRes.status === 'fulfilled') {
        // Group the tenant-visible task matrix by standard code.
        const defs = defRes.value.data?.data?.taskDefinitions || [];
        const counts = {};
        for (const d of defs) {
          const code = d?.standard?.code;
          if (!code) continue;
          counts[code] = (counts[code] || 0) + 1;
        }
        setTaskCounts(counts);
      }
      // Task-definitions failure is non-fatal — cards fall back to _count.
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  function taskCountFor(std) {
    if (taskCounts) return taskCounts[std.code] ?? 0;
    return std._count?.taskDefinitions ?? 0;
  }

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">Standards Library</h1>
          <div className="page-subtitle">
            The documents that govern your electrical maintenance program — what each one is,
            in plain language, and what this platform tracks against it.
          </div>
        </div>
        <ReportActionBar
          onDownloadPdf={handleDownloadPdf}
          pdfBusy={pdfBusy}
          pdfDisabled={loading || standards.length === 0}
        />
      </div>

      <div className="page-body print-doc">
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Standards Library</h1>
          <div className="print-masthead-meta">
            Generated {new Date().toLocaleDateString()}
          </div>
        </header>
        <div className="print-rule print-only"></div>
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {loading ? (
          <div className="loading">Loading standards…</div>
        ) : standards.length === 0 ? (
          <div className="card">
            <EmptyState
              icon={BookOpen}
              title="No standards loaded"
              sub="The standards library is seeded server-side. If this instance was just set up, run the standards seed script."
            />
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
            gap: 14,
          }}>
            {standards.map(std => {
              const count = taskCountFor(std);
              return (
                <div key={std.id || `${std.code}-${std.edition}`} className="card" style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
                    <span style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-text)', letterSpacing: '-0.01em' }}>
                      {std.code}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-data)', fontWeight: 600, color: 'var(--color-text-secondary)' }}>
                      {std.edition === 'current' ? 'current' : `${std.edition} edition`}
                    </span>
                    <span style={{ marginLeft: 'auto' }}><PublisherChip publisher={std.publisher} /></span>
                  </div>

                  <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)', marginBottom: 8 }}>
                    {std.title}
                  </div>

                  {std.keyMandate && (
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                      <strong style={{ color: 'var(--color-text)' }}>Key mandate:</strong> {std.keyMandate}
                      {std.revisionCycle ? <> · <strong style={{ color: 'var(--color-text)' }}>Revised:</strong> {std.revisionCycle}</> : null}
                    </div>
                  )}

                  {WHAT_IT_MEANS[std.code] && (
                    <p style={{
                      fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)',
                      lineHeight: 1.6, margin: '0 0 12px', flex: 1,
                    }}>
                      <strong style={{ color: 'var(--color-text)' }}>What it means for you. </strong>
                      {WHAT_IT_MEANS[std.code]}
                    </p>
                  )}

                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    gap: 8, paddingTop: 10, borderTop: '1px solid var(--color-border)', marginTop: 'auto',
                  }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                      {count} task definition{count === 1 ? '' : 's'} in your library
                    </span>
                    <Link
                      to={`/reports/compliance/${encodeURIComponent(std.code)}`}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        fontSize: 'var(--font-size-sm)', fontWeight: 600,
                        color: 'var(--color-primary)', textDecoration: 'none', whiteSpace: 'nowrap',
                      }}
                    >
                      Compliance report
                      <ArrowRight size={14} />
                    </Link>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {!loading && standards.length > 0 && (
          <p style={{
            marginTop: 20, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)',
            lineHeight: 1.6,
          }}>
            Editions shown are the ones tracked in the platform. When a standards body publishes a new
            edition, the revision-alert workflow flags affected task definitions so your intervals can be
            reviewed against the updated requirements — you don’t have to watch the publishers yourself.
          </p>
        )}

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">Generated {new Date().toLocaleDateString()}</span>
        </footer>
      </div>
    </>
  );
}
