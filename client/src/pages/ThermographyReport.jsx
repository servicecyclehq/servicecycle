// ─────────────────────────────────────────────────────────────────────────────
// ThermographyReport.jsx — #29 IR thermography report (NFPA 70B §7.4 / Annex E).
//
// A §7.4-shaped survey record: the conditions header (thermographer + their
// qualification, camera, ambient/humidity/emissivity/reflected/load, survey
// date), the per-finding table (component, ΔT, reference frame, reference ΔT,
// load %, NETA severity + label, corrective action), the NETA Table 100.18
// legend, and a link to the attached IR report.
//
// Serves both a single survey (?surveyId=) and a site-wide roll-up (?siteId=).
// Data: GET /api/thermography/surveys/:id/report  |  GET /api/thermography/report
//
// Layout follows the other in-platform report pages (see AssetRegisterReport /
// ComplianceStandardDetailReport): page-header + ReportActionBar, print
// masthead, print-sec sections.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { downloadAuthedFile } from '../api/download';
import BackLink from '../components/BackLink';
import ReportActionBar from '../components/ReportActionBar';
import EmptyState from '../components/EmptyState';
import { assetLabel, fmtDate } from '../lib/equipment';

const IR_REF_LABEL = {
  AMBIENT: 'Over ambient', SIMILAR: 'Similar component', BASELINE: 'Vs. baseline',
};

function ConditionsGrid({ c }) {
  const items = [
    ['Survey date',    c.surveyDate ? fmtDate(c.surveyDate) : '—'],
    ['Thermographer',  c.thermographerName || '—'],
    ['Qualification',  c.thermographerQual || '—'],
    ['Camera',         [c.cameraMake, c.cameraModel].filter(Boolean).join(' ') || '—'],
    ['Ambient',        c.ambientTempC != null ? `${c.ambientTempC} °C` : '—'],
    ['Humidity',       c.humidityPct != null ? `${c.humidityPct} %` : '—'],
    ['Emissivity',     c.emissivity != null ? String(c.emissivity) : '—'],
    ['Reflected temp', c.reflectedTempC != null ? `${c.reflectedTempC} °C` : '—'],
    ['Load at scan',   c.loadPercent != null ? `${c.loadPercent} %` : '—'],
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
      {items.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>{label}</div>
          <div style={{ fontSize: 'var(--font-size-ui)' }}>{value}</div>
        </div>
      ))}
    </div>
  );
}

function FindingsTable({ findings }) {
  return (
    <div className="table-wrap">
      <table className="print-table">
        <thead>
          <tr>
            <th>Component</th>
            <th style={{ textAlign: 'right' }}>ΔT</th>
            <th>Reference</th>
            <th style={{ textAlign: 'right' }}>Ref ΔT</th>
            <th style={{ textAlign: 'right' }}>Load %</th>
            <th>NETA severity</th>
            <th>Corrective action</th>
          </tr>
        </thead>
        <tbody>
          {findings.length === 0 ? (
            <tr><td colSpan={7} className="text-muted">No findings recorded for this survey.</td></tr>
          ) : findings.map((f) => (
            <tr key={f.id}>
              <td>{f.component}</td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{f.deltaT == null ? '—' : `${f.deltaT} °C`}</td>
              <td>{IR_REF_LABEL[f.referenceType] || f.referenceType || '—'}</td>
              <td style={{ textAlign: 'right' }}>{f.referenceDeltaT == null ? '—' : `${f.referenceDeltaT} °C`}</td>
              <td style={{ textAlign: 'right' }}>{f.loadPercent == null ? '—' : f.loadPercent}</td>
              <td style={{ color: f.severity ? 'var(--color-danger)' : undefined }}>
                {f.severity || 'Below threshold'}
                {f.severityLabel && (
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{f.severityLabel}</div>
                )}
              </td>
              <td>{f.correctiveAction || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SurveyBlock({ r, onOpenEvidence }) {
  const a = r.asset;
  return (
    <section className="print-sec">
      <div className="print-sec-head print-only">
        <span className="print-sec-no" />
        <h2 className="print-sec-title">{a ? assetLabel(a) : 'Survey'}</h2>
        <span className="print-sec-aux">{r.conditions.surveyDate ? fmtDate(r.conditions.surveyDate) : ''}</span>
      </div>

      <div className="card mb-16">
        <div className="card-header">
          <div className="card-title">{a ? assetLabel(a) : 'IR survey'}</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            {a?.siteName ? `${a.siteName} · ` : ''}
            {r.summary.findingCount} finding(s)
            {r.summary.bySeverity.BELOW_THRESHOLD > 0 && ` · ${r.summary.bySeverity.BELOW_THRESHOLD} below threshold`}
          </div>
        </div>

        <div className="card-body">
          <ConditionsGrid c={r.conditions} />
        </div>

        <FindingsTable findings={r.findings} />

        <div className="card-body" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          Evidence:{' '}
          {r.evidence?.documentId ? (
            onOpenEvidence ? (
              <button
                type="button"
                onClick={() => onOpenEvidence(r.evidence.documentId)}
                style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', color: 'var(--color-primary)', fontSize: 'inherit' }}
              >
                {r.evidence.filename || 'IR report (PDF)'}
              </button>
            ) : (r.evidence.filename || 'IR report on file')
          ) : 'no IR report attached to this survey'}
        </div>
      </div>
    </section>
  );
}

export default function ThermographyReport() {
  useDocumentTitle('IR Thermography Report');
  const [params] = useSearchParams();
  const surveyId = params.get('surveyId');
  const siteId   = params.get('siteId');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pdfBusy, setPdfBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const req = surveyId
      ? api.get(`/api/thermography/surveys/${surveyId}/report`)
      : api.get('/api/thermography/report', { params: siteId ? { siteId } : {} });
    req
      .then((r) => { if (alive) { setData(r.data?.data || null); setError(null); } })
      .catch((e) => { if (alive) setError(e?.response?.data?.error || 'Could not load the IR report'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [surveyId, siteId]);

  async function handleDownloadPdf() {
    setPdfBusy(true);
    try {
      const base = import.meta.env.VITE_API_URL ?? '';
      const stamp = new Date().toISOString().slice(0, 10);
      const url = surveyId
        ? `${base}/api/thermography/surveys/${surveyId}/report?format=pdf`
        : `${base}/api/thermography/report?format=pdf${siteId ? `&siteId=${encodeURIComponent(siteId)}` : ''}`;
      await downloadAuthedFile(url, `IR_Thermography_${stamp}.pdf`);
    } catch (e) {
      setError(e?.message || 'Could not build the PDF');
    } finally { setPdfBusy(false); }
  }

  async function openEvidence(documentId) {
    try {
      const { data: d } = await api.get(`/api/documents/${documentId}/url`);
      const href = d.data?.url || d.data?.apiPath;
      if (href) window.open(href, '_blank', 'noopener');
    } catch (_e) { /* non-fatal */ }
  }

  // Single-survey and roll-up responses are normalized to one list here so the
  // body renders identically either way.
  const reports = data
    ? (surveyId ? [data.report] : (data.reports || []))
    : [];
  const legend = data?.report?.legend || data?.legend || [];
  const scope  = data?.scope || null;

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/reports" fallbackLabel="Reports" />
          <h1 className="page-title">IR Thermography Report</h1>
          <div className="page-subtitle">
            NFPA 70B:2023 §7.4 · NETA MTS-2023 Table 100.18
            {scope?.siteName ? ` · ${scope.siteName}` : ''}
          </div>
        </div>
        <ReportActionBar onDownloadPdf={handleDownloadPdf} pdfBusy={pdfBusy} pdfDisabled={loading || reports.length === 0} />
      </div>

      <div className="page-body print-doc">
        <div className="print-masthead print-only">
          <div className="print-masthead-title">IR Thermography Report</div>
          <div className="print-masthead-meta">
            NFPA 70B:2023 §7.4 · Generated {data?.generatedAt ? fmtDate(data.generatedAt) : new Date().toLocaleDateString()}
          </div>
        </div>
        <div className="print-rule print-only" />

        {error && (
          <div className="card mb-16">
            <div className="card-body" style={{ color: 'var(--color-danger)' }}>{error}</div>
          </div>
        )}

        {!loading && !error && reports.length === 0 && (
          <EmptyState
            title="No IR surveys recorded"
            message="Import an IR survey from an asset's page to build this report."
          />
        )}

        {data && !surveyId && data.totals && reports.length > 0 && (
          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Summary</div></div>
            <div className="card-body" style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 'var(--font-size-ui)' }}>
              <span><strong>{data.totals.surveys}</strong> surveys</span>
              <span><strong>{data.totals.findings}</strong> findings</span>
              <span style={{ color: 'var(--color-danger)' }}><strong>{data.totals.IMMEDIATE}</strong> immediate</span>
              <span><strong>{data.totals.RECOMMENDED}</strong> recommended</span>
              <span><strong>{data.totals.ADVISORY}</strong> advisory</span>
              <span style={{ color: 'var(--color-text-secondary)' }}><strong>{data.totals.BELOW_THRESHOLD}</strong> below threshold</span>
            </div>
            {data.truncated && (
              <div className="card-body" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Showing the 200 most recent surveys. Narrow by site or date range to see older ones.
              </div>
            )}
          </div>
        )}

        {reports.map((r, i) => (
          <SurveyBlock key={r.survey?.id || i} r={r} onOpenEvidence={openEvidence} />
        ))}

        {legend.length > 0 && (
          <section className="print-sec">
            <div className="print-sec-head print-only">
              <span className="print-sec-no" />
              <h2 className="print-sec-title">NETA Table 100.18</h2>
            </div>
            <div className="card mb-16">
              <div className="card-header no-print"><div className="card-title">NETA Table 100.18 — severity bands</div></div>
              <div className="table-wrap">
                <table className="print-table">
                  <thead>
                    <tr><th>Reference</th><th>ΔT band</th><th>Action</th><th>ServiceCycle severity</th></tr>
                  </thead>
                  <tbody>
                    {legend.map((l, i) => (
                      <tr key={i}>
                        <td>{l.reference}</td>
                        <td>{l.band}</td>
                        <td>{l.action}</td>
                        <td>{l.severity}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        )}

        <footer className="print-footer print-only">
          NFPA 70B:2023 §7.4 · NETA MTS-2023 Table 100.18 · ServiceCycle
        </footer>
      </div>
    </>
  );
}
