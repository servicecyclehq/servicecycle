// ArcFlashFleet.jsx — Arc Flash Fleet Dashboard (/reports/arc-flash-fleet).
// Cross-site rollup: DANGER %, label readiness, average data-confidence (2.8a),
// open sanity-check findings (2.8c), and expiring studies — the "where is my
// arc-flash risk across the whole portfolio" view. Manager/admin via the route.
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function bandColor(score) {
  if (score == null) return 'var(--color-text-secondary)';
  return score >= 80 ? '#15803d' : score >= 50 ? '#b45309' : '#b91c1c';
}

export default function ArcFlashFleet() {
  useDocumentTitle('Arc Flash Fleet Dashboard');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get('/api/arc-flash/fleet')
      .then(r => setData(r.data?.data || null))
      .catch(() => setError('Failed to load the arc-flash fleet rollup.'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const [exporting, setExporting] = useState(false);
  async function exportModel() {
    setExporting(true);
    try {
      const r = await api.get('/api/arc-flash/export', { params: { format: 'csv' }, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([r.data], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `arc-flash-model-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { /* non-fatal */ }
    finally { setExporting(false); }
  }

  const sites = data?.sites || [];
  const t = data?.totals;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Arc Flash Fleet Dashboard</h1>
          <div className="page-subtitle">Portfolio-wide incident energy and PPE overview</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={exportModel} disabled={exporting} title="Export the collected model as CSV for SKM / ETAP / EasyPower">{exporting ? 'Exporting…' : 'Export model (CSV)'}</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadAuthedFile('/api/arc-flash/fleet?format=csv', 'arc-flash-fleet.csv').catch(() => {})} title="Export the per-site attention rollup (DANGER, confidence, incidents) as CSV">Export rollup (CSV)</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadAuthedFile('/api/arc-flash/labels.pdf', 'arc-flash-labels.pdf').catch(() => {})} title="Print-ready NFPA 70E labels for every bus (4x6, one per page)">Labels (PDF)</button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <div className="page-body">

      <LoadGrowthBanner />

      {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
      {loading && <div className="card" style={{ padding: 16 }}>Loading…</div>}

      {!loading && !error && (
        <>
          {t && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Tile label="Sites" value={t.sites} />
              <Tile label="Labelled buses" value={t.busCount} />
              <Tile label="DANGER buses" value={t.dangerCount} color="var(--color-danger)" />
              <Tile label="Avg confidence" value={t.avgConfidence == null ? '—' : `${t.avgConfidence}%`} color={bandColor(t.avgConfidence)} />
              <Tile label="Blocked buses" value={t.blockedCount} />
              <Tile label="Sanity errors" value={t.contradictionErrors} color={t.contradictionErrors > 0 ? 'var(--color-danger)' : undefined} />
              <Tile label="Studies expiring (90d)" value={t.expiringStudies} />
              <Tile label="Incidents (12mo)" value={t.recentIncidents} color={t.recentIncidents > 0 ? 'var(--color-danger)' : undefined} />
            </div>
          )}

          {sites.length === 0 ? (
            <div className="card" style={{ padding: 16, color: 'var(--color-text-secondary)' }}>
              No arc-flash labels recorded yet. Upload a one-line or study report on a site, or bind a study to assets.
            </div>
          ) : (
            <table className="data-table" style={{ width: '100%', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  <th>Site</th><th>Buses</th><th>DANGER</th><th>Blocked</th>
                  <th>Avg confidence</th><th>Low confidence</th><th>Sanity (err / chk)</th>
                  <th>Studies</th><th>Expiring</th><th>Incidents (12mo)</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.siteId}>
                    <td>{s.siteId === 'unassigned' ? s.siteName : <Link to={`/sites/${s.siteId}`}>{s.siteName}</Link>}</td>
                    <td>{s.busCount}</td>
                    <td style={{ fontWeight: s.dangerCount > 0 ? 700 : 400, color: s.dangerCount > 0 ? 'var(--color-danger)' : 'inherit' }}>
                      {s.dangerCount} {s.busCount ? <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>({s.dangerPct}%)</span> : null}
                    </td>
                    <td style={{ color: s.blockedCount > 0 ? 'var(--color-warning)' : 'inherit' }}>{s.blockedCount}</td>
                    <td><span style={{ fontWeight: 700, color: bandColor(s.avgConfidence) }}>{s.avgConfidence == null ? '—' : `${s.avgConfidence}%`}</span></td>
                    <td style={{ color: s.lowConfidenceCount > 0 ? 'var(--color-danger)' : 'inherit' }}>{s.lowConfidenceCount}</td>
                    <td>
                      <span style={{ color: s.contradictionErrors > 0 ? 'var(--color-danger)' : 'inherit', fontWeight: s.contradictionErrors > 0 ? 700 : 400 }}>{s.contradictionErrors}</span>
                      {' / '}{s.contradictionWarnings}
                    </td>
                    <td>{s.studyCount}</td>
                    <td style={{ color: s.expiringStudies > 0 ? 'var(--color-danger)' : 'inherit' }}>{s.expiringStudies}</td>
                    <td style={{ fontWeight: s.recentIncidents > 0 ? 700 : 400, color: s.recentIncidents > 0 ? 'var(--color-danger)' : 'inherit' }}
                      title={s.recentIncidents > 0 ? `${s.openIncidents} open · ${s.incidentInjuries} with injury${s.lastIncidentAt ? ` · last ${new Date(s.lastIncidentAt).toLocaleDateString()}` : ''}` : 'No incidents logged in the last 12 months'}>
                      {s.recentIncidents}{s.incidentInjuries > 0 ? <span style={{ color: 'var(--color-danger)' }}> ⚠</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p style={{ marginTop: 14, fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
            Confidence is a deterministic 0–100 data-trust score (input completeness, study freshness, field verification, setting drift) — not a certification of the calculation. Sanity errors are physically impossible or under-protective values to fix before the label is trusted.
          </p>

          <RiskScore />
          <AuditBundle />
          <RegulatoryReview />
          <ImportResults onApplied={load} />
          <AfxPanel />
        </>
      )}
    </div>
  </>
  );
}

// Telemetry-derived load-growth flag. Self-hides unless a load channel has grown
// past the >10% NFPA 70E §130.5 re-study threshold. Read-only signal; SC never
// recomputes incident energy.
function LoadGrowthBanner() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/api/arc-flash/load-growth').then(r => setData(r.data?.data || null)).catch(() => {});
  }, []);
  if (!data || !data.exceedsThreshold) return null;
  const top = data.channels[0];
  return (
    <div className="card mb-16" style={{ padding: '12px 16px', borderLeft: '4px solid var(--chip-amber-fg, #d97706)' }}>
      <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--chip-amber-fg, #d97706)' }}>
        Telemetry: load growth up to {data.maxGrowthPct}% detected
      </div>
      <div style={{ fontSize: '0.82rem', color: 'var(--color-text-secondary)', marginTop: 4 }}>
        {data.channels.length} load channel{data.channels.length === 1 ? '' : 's'} past the {data.threshold}% threshold
        {top ? ` (e.g. ${top.label}: ${top.baseline}→${top.current}${top.unit ? ' ' + top.unit : ''}, +${top.growthPct}%)` : ''}. {data.note}
      </div>
    </div>
  );
}

// AFX — the open Arc Flash Data Exchange standard. Download the versioned spec,
// and validate any CSV against it. The "Export model (CSV)" button above already
// emits AFX-conformant data.
// ConformanceBadge: visual marker on per-tool template download buttons.
// [DEMO-8-11] Honest wording: 'matched' = column names are mapped to the tool's
// published import format (format-matched), but you must still confirm them
// against YOUR tool version. 'draft' = structure confirmed, field names need
// verification. We do not assert independent verification we can't substantiate.
function ConformanceBadge({ level }) {
  if (level === 'exact') return (
    <span title="Column names mapped to this tool's published import format — confirm against your tool version"
      style={{ fontSize: '0.62rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3,
        background: 'var(--chip-green-bg, #dcfce7)', color: 'var(--chip-green-fg, #16a34a)',
        lineHeight: 1.4, whiteSpace: 'nowrap' }}>
      FORMAT-MATCHED
    </span>
  );
  return (
    <span title="Structure confirmed; verify column names against your specific tool version"
      style={{ fontSize: '0.62rem', fontWeight: 700, padding: '1px 5px', borderRadius: 3,
        background: 'var(--chip-amber-bg, #fef3c7)', color: 'var(--chip-amber-fg, #d97706)',
        lineHeight: 1.4, whiteSpace: 'nowrap' }}>
      DRAFT
    </span>
  );
}

// SpecExplorer: renders the live /afx/spec field catalog inline so engineers can
// browse required vs. optional fields, types, and example values without leaving SC.
function SpecExplorer({ spec }) {
  const [showMulti, setShowMulti] = useState(false);
  const fields = spec?.fields || [];
  const multiTables = spec?.multiTableSchema || {};
  const afxVer = spec?.afxVersion || '?';
  const since = spec?.since ? new Date(spec.since).getFullYear() : null;
  const reqCount = fields.filter(f => f.required).length;
  const optCount = fields.filter(f => !f.required).length;
  return (
    <div style={{ marginTop: 10, padding: '12px 14px', background: 'var(--color-surface-2, #f8fafc)',
        borderRadius: 6, border: '1px solid var(--color-border)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>AFX v{afxVer} field catalog</span>
          {since && <span style={{ marginLeft: 8, fontSize: '0.75rem', color: 'var(--color-text-secondary)' }}>
            IEEE 1584-2018 &middot; NFPA 70E 130.5(H) &middot; since {since}
          </span>}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowMulti(m => !m)}>
          {showMulti ? 'Flat spec' : 'Multi-table schema'}
        </button>
      </div>
      {!showMulti && (
        <>
          <div style={{ fontSize: '0.78rem', fontWeight: 600, marginBottom: 4, color: 'var(--color-text-secondary)' }}>
            {reqCount} required &middot; {optCount} optional
          </div>
          <table style={{ width: '100%', fontSize: '0.75rem', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-3, #f1f5f9)' }}>
                {['Field', 'Type', 'Req', 'Description / example'].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '3px 8px', borderBottom: '1px solid var(--color-border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {fields.map((f, i) => (
                <tr key={i} style={{ background: f.required ? 'var(--chip-green-bg, #f0fdf4)' : undefined,
                    borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '3px 8px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{f.column}</td>
                  <td style={{ padding: '3px 8px', color: 'var(--color-text-secondary)' }}>{f.type || '---'}</td>
                  <td style={{ padding: '3px 8px', textAlign: 'center' }}>
                    {f.required
                      ? <span style={{ color: 'var(--chip-green-fg, #16a34a)', fontWeight: 700 }}>yes</span>
                      : <span style={{ color: 'var(--color-text-secondary)' }}>---</span>}
                  </td>
                  <td style={{ padding: '3px 8px', color: 'var(--color-text-secondary)', maxWidth: 260 }}>
                    {f.description || ''}
                    {f.example != null && <span style={{ marginLeft: 4, fontFamily: 'monospace', color: 'var(--color-text)' }}>e.g. {String(f.example)}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {showMulti && (
        <div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
            Multi-table schema (Bus / Cable / Transformer / Device) topology keyed by exact string IDs.
          </div>
          {Object.entries(multiTables).map(([table, def]) => (
            <div key={table} style={{ marginBottom: 10 }}>
              <div style={{ fontWeight: 600, fontSize: '0.82rem', marginBottom: 3 }}>{def.sheet || table}</div>
              <table style={{ width: '100%', fontSize: '0.73rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: 'var(--color-surface-3, #f1f5f9)' }}>
                    {['AFX header', 'ETAP (draft)', 'EasyPower'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '2px 6px', borderBottom: '1px solid var(--color-border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(def.fields || []).map((f, fi) => (
                    <tr key={fi} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace' }}>{f.afx || '---'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace', color: 'var(--chip-amber-fg, #d97706)' }}>{f.etap || '---'}</td>
                      <td style={{ padding: '2px 6px', fontFamily: 'monospace' }}>{f.easypower || '---'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AfxPanel() {
  const [spec, setSpec] = useState(null);
  const [file, setFile] = useState(null);
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [mtFile, setMtFile] = useState(null);
  const [mtReport, setMtReport] = useState(null);
  const [mtBusy, setMtBusy] = useState(false);
  const [impFile, setImpFile] = useState(null);
  const [impPreview, setImpPreview] = useState(null);
  const [impBusy, setImpBusy] = useState(false);
  const [impApplyBusy, setImpApplyBusy] = useState(false);
  const [impApplyMsg, setImpApplyMsg] = useState('');
  const [impOverwrite, setImpOverwrite] = useState(false);
  const [impSites, setImpSites] = useState([]);
  const [impCreateSiteId, setImpCreateSiteId] = useState('');
  const [impDevices, setImpDevices] = useState(false);
  const [specOpen, setSpecOpen] = useState(false);

  async function loadSpec() {
    if (spec) return spec;
    const r = await api.get('/api/arc-flash/afx/spec');
    setSpec(r.data?.data || null);
    return r.data?.data;
  }
  async function downloadSpec() {
    try {
      const s = await loadSpec();
      const blob = new Blob([JSON.stringify(s, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `afx-spec-v${s.afxVersion}.json`; a.click();
      URL.revokeObjectURL(url);
    } catch { setErr('Could not load the AFX spec.'); }
  }
  async function validate() {
    if (!file) { setErr('Choose a CSV to validate.'); return; }
    setBusy(true); setErr(''); setReport(null);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.post('/api/arc-flash/afx/validate', fd);
      setReport(r.data?.data || null);
    } catch (e) { setErr(e?.response?.data?.error || 'Validation failed.'); }
    finally { setBusy(false); }
  }
  async function validateMulti() {
    if (!mtFile) { setErr('Choose a multi-table .xlsx to validate.'); return; }
    setMtBusy(true); setErr(''); setMtReport(null);
    try {
      const fd = new FormData(); fd.append('file', mtFile);
      const r = await api.post('/api/arc-flash/afx/validate-multi', fd);
      setMtReport(r.data?.data || null);
    } catch (e) { setErr(e?.response?.data?.error || 'Multi-table validation failed.'); }
    finally { setMtBusy(false); }
  }
  async function previewImport() {
    if (!impFile) { setErr('Choose a multi-table .xlsx to preview.'); return; }
    setImpBusy(true); setErr(''); setImpPreview(null);
    try {
      const fd = new FormData(); fd.append('file', impFile);
      if (impOverwrite) fd.append('overwrite', 'true');
      const r = await api.post('/api/arc-flash/afx/import-multi/preview', fd);
      setImpPreview(r.data?.data || null); setImpApplyMsg('');
      if ((r.data?.data?.plan?.summary?.newBuses || 0) > 0 && impSites.length === 0) {
        api.get('/api/sites').then(s => setImpSites(s.data?.data?.sites || [])).catch(() => {});
      }
    } catch (e) { setErr(e?.response?.data?.error || 'Import preview failed.'); }
    finally { setImpBusy(false); }
  }
  async function applyImport(createNew) {
    if (!impFile) return;
    if (createNew && !impCreateSiteId) { setErr('Choose a site for the new equipment.'); return; }
    setImpApplyBusy(true); setErr(''); setImpApplyMsg('');
    try {
      const fd = new FormData(); fd.append('file', impFile); fd.append('confirm', 'true');
      if (impOverwrite) fd.append('mode', 'overwrite');
      if (createNew) { fd.append('createNew', 'true'); fd.append('siteId', impCreateSiteId); }
      if (impDevices) fd.append('importDevices', 'true');
      const r = await api.post('/api/arc-flash/afx/import-multi/apply', fd);
      const d = r.data?.data || {};
      const ov = d.summary?.overwritten ? `, ${d.summary.overwritten} value(s) replaced` : '';
      const cr = d.created ? `, ${d.created} new bus(es) created${d.feedsWired ? ` (${d.feedsWired} feed link(s))` : ''}` : '';
      const dv = d.devicesCreated ? `, ${d.devicesCreated} device(s) added` : '';
      setImpApplyMsg(`Applied: ${d.applied} bus(es) updated${ov}${cr}${dv}. (mode: ${d.summary?.mode || 'fill_only'})`);
      setImpPreview(null);
    } catch (e) { setErr(e?.response?.data?.error || 'Import apply failed.'); }
    finally { setImpApplyBusy(false); }
  }

  return (
    <div className="card" style={{ padding: '14px 16px', marginTop: 16 }}>
      <h2 style={{ margin: 0, fontSize: '1rem' }}>Arc Flash Data Exchange (AFX)</h2>
      <p style={{ margin: '4px 0 10px', color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>
        Our open, versioned CSV/JSON standard for arc-flash study + label data, anchored on IEEE 1584-2018 inputs and NFPA 70E 130.5(H) outputs. The “Export model (CSV)” button above already emits AFX. Validate any file against the spec below.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={downloadSpec}>Download AFX spec (JSON)</button>
        <button type="button" className="btn btn-secondary btn-sm"
          onClick={async () => { if (!specOpen) { try { await loadSpec(); } catch { setErr('Could not load AFX spec.'); return; } } setSpecOpen(o => !o); }}>
          {specOpen ? 'Hide spec' : 'Browse spec in-app'}
        </button>
        <input type="file" accept=".csv,text/csv" onChange={e => { setFile(e.target.files?.[0] || null); setReport(null); setErr(''); }} aria-label="CSV to validate against AFX" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!file || busy} onClick={validate}>{busy ? 'Validating…' : 'Validate against AFX'}</button>
      </div>
      {specOpen && spec && <SpecExplorer spec={spec} />}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Per-tool templates:</span>
        {[['arcad', 'ARCAD', 'exact'], ['skm', 'SKM PTW', 'exact'], ['easypower', 'EasyPower', 'exact']].map(([tool, label, conf]) => (
          <span key={tool} style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <button type="button" className="btn btn-secondary btn-sm"
              onClick={() => downloadAuthedFile(`/api/arc-flash/afx/template?tool=${tool}`, `afx-template-${tool}.csv`).catch(() => {})}
              title={`${label} template - column names mapped to this tool's published import format; confirm against your tool version`}>{label}</button>
            <ConformanceBadge level={conf} />
          </span>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
          <button type="button" className="btn btn-secondary btn-sm"
            onClick={() => downloadAuthedFile('/api/arc-flash/afx/template?tool=etap', 'afx-template-etap.csv').catch(() => {})}
            title="ETAP DataX template - structure confirmed; verify column names against your tool version">ETAP</button>
          <ConformanceBadge level="draft" />
        </span>
        <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
          FORMAT-MATCHED = mapped to the tool's published format &middot; DRAFT = check with your tool. Confirm columns against your tool version before importing.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Multi-table export (related Bus/Cable/Transformer/Device tabs):</span>
        {[['afx', 'AFX'], ['easypower', 'EasyPower'], ['etap', 'ETAP (draft)']].map(([tool, label]) => (
          <button key={tool} type="button" className="btn btn-secondary btn-sm"
            onClick={() => downloadAuthedFile(`/api/arc-flash/afx/export-multi?tool=${tool}`, `afx-multitable-${tool}.xlsx`).catch(() => {})}
            title={`Export your model as a ${label} multi-tab workbook (ID-keyed topology)`}>{label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Validate a multi-table set (referential integrity):</span>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => { setMtFile(e.target.files?.[0] || null); setMtReport(null); setErr(''); }} aria-label="Multi-table xlsx to validate" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!mtFile || mtBusy} onClick={validateMulti}>{mtBusy ? 'Checking…' : 'Check integrity'}</button>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <span style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Preview an import (dry-run, writes nothing):</span>
        <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => { setImpFile(e.target.files?.[0] || null); setImpPreview(null); setErr(''); }} aria-label="Multi-table xlsx to preview import" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!impFile || impBusy} onClick={previewImport}>{impBusy ? 'Previewing…' : 'Preview import'}</button>
      </div>

      {impPreview && (
        <div style={{ marginTop: 12, fontSize: '0.82rem' }}>
          <div style={{ fontWeight: 700 }}>
            Dry run — nothing written. {impPreview.plan.summary.newBuses} new bus(es), {impPreview.plan.summary.matchedBuses} would update existing
            {' · '}{impPreview.plan.summary.incomingDevices} device(s), {impPreview.plan.summary.incomingCables} cable(s), {impPreview.plan.summary.incomingTransformers} transformer(s) incoming
          </div>
          {!impPreview.validation.ok && (
            <div style={{ marginTop: 6, color: 'var(--color-danger)' }}>
              {impPreview.validation.errors.length} integrity error(s) — fix before importing. Run “Check integrity” for detail.
            </div>
          )}
          {impPreview.plan.createBuses?.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--color-text-secondary)' }}>New: {impPreview.plan.createBuses.slice(0, 15).join(', ')}{impPreview.plan.createBuses.length > 15 ? '…' : ''}</div>
          )}
          {impPreview.plan.matchedByName?.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--color-text-secondary)' }}>Matches existing: {impPreview.plan.matchedByName.slice(0, 15).map(m => m.incoming).join(', ')}{impPreview.plan.matchedByName.length > 15 ? '…' : ''}</div>
          )}
          {impOverwrite && (impPreview.mergePreview?.totalConflicts || 0) > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontWeight: 600, fontSize: '0.8rem', marginBottom: 4, color: 'var(--chip-amber-fg, #d97706)' }}>
                Overwrite preview — {impPreview.mergePreview.totalConflicts} field(s) on {impPreview.mergePreview.conflicts.length} bus(es) would change:
              </div>
              <table style={{ width: '100%', fontSize: '0.73rem', borderCollapse: 'collapse', marginBottom: 4 }}>
                <thead>
                  <tr style={{ background: 'var(--color-surface-2, #f8fafc)' }}>
                    {['Bus', 'Field', 'Current value', 'Incoming value'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '2px 8px', borderBottom: '1px solid var(--color-border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {impPreview.mergePreview.conflicts.slice(0, 25).flatMap((c, ci) =>
                    Object.entries(c.changes).map(([field, ch], fi) => (
                      <tr key={`${ci}-${fi}`} style={{ borderBottom: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '2px 8px', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{fi === 0 ? c.busName : ''}</td>
                        <td style={{ padding: '2px 8px', fontFamily: 'monospace' }}>{field}</td>
                        <td style={{ padding: '2px 8px', color: 'var(--chip-amber-fg, #d97706)' }}>{String(ch.old)}</td>
                        <td style={{ padding: '2px 8px', color: 'var(--chip-green-fg, #16a34a)' }}>{String(ch.new)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              {impPreview.mergePreview.totalConflicts > 25 && (
                <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>
                  … and more; apply to see the full diff in the activity log.
                </div>
              )}
            </div>
          )}
          {impPreview.validation.ok && impPreview.plan.summary.matchedBuses > 0 && (
            <div style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={impApplyBusy} onClick={() => applyImport(false)}
                title="Apply to matched buses. Never creates new buses; never erases a value with a blank.">
                {impApplyBusy ? 'Applying…' : `Apply${impOverwrite ? ' (overwrite)' : ' (fill-only)'} to ${impPreview.plan.summary.matchedBuses} matched bus(es)`}
              </button>
              <label style={{ marginLeft: 10, fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                <input type="checkbox" checked={impOverwrite} onChange={e => setImpOverwrite(e.target.checked)} style={{ marginRight: 4 }} />
                Overwrite differing values (default: fill blanks only)
              </label>
            </div>
          )}
          {impPreview.validation.ok && impPreview.plan.summary.incomingDevices > 0 && (impPreview.plan.summary.matchedBuses > 0 || impPreview.plan.summary.newBuses > 0) && (
            <label style={{ display: 'block', marginTop: 8, fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
              <input type="checkbox" checked={impDevices} onChange={e => setImpDevices(e.target.checked)} style={{ marginRight: 4 }} />
              Also import {impPreview.plan.summary.incomingDevices} protective device(s) onto their protected buses (skips duplicates)
            </label>
          )}
          {impPreview.validation.ok && impPreview.plan.summary.newBuses > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: '0.8rem', marginBottom: 4 }}>{impPreview.plan.summary.newBuses} bus(es) don’t match anything in SC. Create them as new equipment under:</div>
              <select value={impCreateSiteId} onChange={e => setImpCreateSiteId(e.target.value)} style={{ marginRight: 8 }} aria-label="Site for new equipment">
                <option value="">Choose a site…</option>
                {impSites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <button type="button" className="btn btn-secondary btn-sm" disabled={impApplyBusy || !impCreateSiteId} onClick={() => applyImport(true)}
                title="Create the unmatched buses as new assets under the chosen site, wiring feed topology from the Cables/Transformers tabs.">
                {impApplyBusy ? 'Working…' : `Create ${impPreview.plan.summary.newBuses} new bus(es)${impPreview.plan.summary.matchedBuses ? ' + update matched' : ''}`}
              </button>
            </div>
          )}
        </div>
      )}
      {impApplyMsg && <div className="alert alert-success" style={{ marginTop: 10 }}>{impApplyMsg}</div>}

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}

      {mtReport && (
        <div style={{ marginTop: 12, fontSize: '0.82rem' }}>
          <div style={{ fontWeight: 700, color: mtReport.ok ? 'var(--chip-green-fg, #16a34a)' : 'var(--color-danger)' }}>
            {mtReport.ok ? '✓ Referential integrity OK' : `${mtReport.errors.length} error(s) — will break import`}
            {' '}({mtReport.stats.buses} buses, {mtReport.stats.cables} cables, {mtReport.stats.transformers} transformers, {mtReport.stats.devices} devices)
            {mtReport.warnings.length > 0 ? ` · ${mtReport.warnings.length} warning(s)` : ''}
          </div>
          {mtReport.errors?.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--color-danger)' }}>
              {mtReport.errors.slice(0, 12).map((it, i) => (
                <li key={i}><strong>{it.table}</strong>{it.id ? ` [${it.id}]` : ''}: {it.issue}</li>
              ))}
            </ul>
          )}
          {mtReport.warnings?.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, color: 'var(--chip-amber-fg, #d97706)' }}>
              {mtReport.warnings.slice(0, 12).map((it, i) => (
                <li key={i}><strong>{it.table}</strong>{it.id ? ` [${it.id}]` : ''}: {it.issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {report && (
        <div style={{ marginTop: 12, fontSize: '0.82rem' }}>
          <div style={{ fontWeight: 700, color: report.ok ? 'var(--chip-green-fg, #16a34a)' : 'var(--chip-amber-fg, #d97706)' }}>
            {report.ok ? '✓ Conforms to AFX' : 'Issues found'} — {report.summary.recognizedColumns} recognized, {report.summary.unknownColumns} unknown columns, {report.summary.missingRequired} missing required, {report.summary.rowIssues} row issue(s)
          </div>
          {report.missingRequired?.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--color-danger)' }}>Missing required: {report.missingRequired.map(m => m.header).join(', ')}</div>
          )}
          {report.unknownColumns?.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--color-text-secondary)' }}>Unknown columns (ignored): {report.unknownColumns.slice(0, 12).join(', ')}{report.unknownColumns.length > 12 ? '…' : ''}</div>
          )}
          {report.rowIssues?.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {report.rowIssues.slice(0, 10).map((it, i) => (
                <li key={i}>Row {it.row}, <strong>{it.column}</strong>: “{it.value}” — {it.issue}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, color }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: color || 'var(--color-text)' }}>{value}</div>
    </div>
  );
}

// Slice 3.5b — round-trip the PE's stamped results back in. Upload the results
// CSV, preview the matched changes, then apply. Pairs with "Export model".
const FIELD_LABEL = {
  incidentEnergyCalCm2: 'Incident energy', arcFlashBoundaryIn: 'Arc-flash boundary',
  ppeCategory: 'PPE category', requiredArcRatingCalCm2: 'Required arc rating', workingDistanceIn: 'Working distance',
};
function ImportResults({ onApplied }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  function onFile(e) {
    setFile(e.target.files?.[0] || null); setPreview(null); setMsg(''); setErr('');
  }

  async function run(isPreview) {
    if (!file) { setErr('Choose a results CSV first.'); return; }
    setBusy(true); setErr(''); setMsg('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('preview', isPreview ? 'true' : 'false');
      const r = await api.post('/api/arc-flash/import-results', fd);
      const d = r.data?.data;
      if (isPreview) { setPreview(d); }
      else { setMsg(`Applied ${d.applied} update(s). ${d.unmatchedCount} unmatched.`); setPreview(null); setFile(null); if (onApplied) onApplied(); }
    } catch (e) { setErr(e?.response?.data?.error || 'Import failed.'); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ padding: '14px 16px', marginTop: 16 }}>
      <h2 style={{ margin: 0, fontSize: '1rem' }}>Import stamped results</h2>
      <p style={{ margin: '4px 0 10px', color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>
        Upload the PE's results CSV (incident energy, boundary, PPE, arc rating per bus). SC matches by site + bus and updates the label outputs. Round-trips with “Export model”.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="file" accept=".csv,text/csv" onChange={onFile} aria-label="Results CSV" />
        <button type="button" className="btn btn-secondary btn-sm" disabled={!file || busy} onClick={() => run(true)}>{busy ? 'Working…' : 'Preview'}</button>
        {preview && preview.matched > 0 && <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => run(false)}>Apply {preview.matched} update(s)</button>}
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}
      {msg && <div className="alert alert-success" style={{ marginTop: 10 }}>{msg}</div>}

      {preview && (
        <div style={{ marginTop: 12, fontSize: '0.82rem' }}>
          <div style={{ color: 'var(--color-text-secondary)' }}>
            Recognized columns: {preview.recognized?.map(f => FIELD_LABEL[f] || f).join(', ') || '—'}. {preview.matched} bus(es) to update, {preview.unmatchedCount} unmatched.
          </div>
          {preview.updates?.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {preview.updates.slice(0, 12).map((u, i) => (
                <li key={i} style={{ marginBottom: 3 }}>
                  <strong>{u.site ? `${u.site} / ` : ''}{u.busName}</strong>: {Object.entries(u.changes).map(([f, ch]) => `${FIELD_LABEL[f] || f} ${ch.from ?? '—'} → ${ch.to}`).join('; ')}
                </li>
              ))}
            </ul>
          )}
          {preview.unmatched?.length > 0 && (
            <div style={{ marginTop: 6, color: 'var(--color-warning)' }}>
              Unmatched: {preview.unmatched.slice(0, 8).map(u => u.busName).join(', ')}{preview.unmatched.length > 8 ? '…' : ''}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Slice 10 — portfolio / insurer risk score + anonymized network benchmark.
function riskColor(band) { return band === 'low' ? '#15803d' : band === 'moderate' ? '#b45309' : '#b91c1c'; }
function RiskScore() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function run() {
    setLoading(true); setErr('');
    try {
      const r = await api.get('/api/arc-flash/risk-score');
      setData(r.data?.data || null);
    } catch { setErr('Could not compute the risk score.'); }
    finally { setLoading(false); }
  }

  const b = data?.benchmark;
  return (
    <div className="card" style={{ padding: '14px 16px', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Portfolio risk score</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>
            A 0–100 arc-flash safety score (higher = safer) for executives and insurers, with an anonymized benchmark against the network.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={run} disabled={loading}>{loading ? 'Scoring…' : 'Compute score'}</button>
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}

      {data && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '2.2rem', fontWeight: 800, color: riskColor(data.band) }}>{data.score}</span>
            <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>/ 100 · <strong style={{ color: riskColor(data.band) }}>{data.band} risk</strong></span>
          </div>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: '0.8rem' }}>
            {data.factors.map((f, i) => (
              <li key={i} style={{ marginBottom: 2 }}>{f.label}: {f.detail}{f.penalty > 0 ? <span style={{ color: 'var(--color-danger)' }}> (−{f.penalty})</span> : null}</li>
            ))}
          </ul>

          <div style={{ marginTop: 12, borderTop: '1px dashed var(--color-border)', paddingTop: 10, fontSize: '0.82rem' }}>
            {b?.available ? (
              <div>
                <strong>Network benchmark</strong> ({b.accountCount} anonymized portfolios):
                your DANGER share is <strong>{b.yourDangerPct}%</strong> vs a network median of <strong>{b.medianDangerPct}%</strong> (25th–75th: {b.p25DangerPct}%–{b.p75DangerPct}%).
                You are safer than <strong>{b.yourSafetyPercentile}%</strong> of the network.
              </div>
            ) : (
              <div style={{ color: 'var(--color-text-secondary)' }}>Network benchmark withheld until at least {b?.minAccounts} portfolios contribute (privacy floor). Currently {b?.accountCount}.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Slice 12 — regulatory-change review: studies on an outdated NFPA 70E / IEEE
// 1584 edition basis. Lazy (button) so the page doesn't auto-run the scan.
function fmtDateShort(d) { try { return d ? new Date(d).toLocaleDateString() : '—'; } catch { return '—'; } }
function RegulatoryReview() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function run() {
    setLoading(true); setErr('');
    try {
      const r = await api.get('/api/arc-flash/regulatory-review');
      setData(r.data?.data || null);
    } catch { setErr('Could not run the regulatory review.'); }
    finally { setLoading(false); }
  }

  return (
    <div className="card" style={{ padding: '14px 16px', marginTop: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Regulatory review</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>
            Studies on a superseded IEEE 1584 edition or performed before NFPA 70E-2024 — a code change (not a physical one) that may age the label.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={run} disabled={loading}>{loading ? 'Scanning…' : 'Run review'}</button>
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}

      {data && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: '0.84rem', marginBottom: 8 }}>
            {data.outdated === 0
              ? <span style={{ color: 'var(--color-success, #16a34a)' }}>All {data.totalStudies} current arc-flash studies are on the current code basis.</span>
              : <span><strong>{data.outdated}</strong> of {data.totalStudies} current studies are on an outdated code basis.</span>}
          </div>
          {data.flagged?.length > 0 && (
            <table className="data-table" style={{ width: '100%', fontSize: '0.78rem' }}>
              <thead><tr><th>Study date</th><th>Basis</th><th>Assets</th><th>Why</th></tr></thead>
              <tbody>
                {data.flagged.map((s, i) => (
                  <tr key={s.studyId || i}>
                    <td>{fmtDateShort(s.performedDate)}</td>
                    <td>{s.method || (s.ieeeEdition ? `IEEE 1584-${s.ieeeEdition}` : '—')}</td>
                    <td>{s.assetCount}</td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>{s.reasons.join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const ITEM_LABEL = {
  sanity_error: 'Sanity error', study_expired: 'Study expired', danger_bus: 'DANGER bus',
  blocked_bus: 'Blocked (missing inputs)', study_expiring: 'Study expiring',
  arc_flash_incident: 'Open incident',
};

// Slice 3c — on-demand insurer/auditor bundle: a compliance posture scorecard, a
// prioritized punch list, and a downloadable JSON snapshot. Lazy (button) so the
// page doesn't double-load the heavy rollup.
function AuditBundle() {
  const [bundle, setBundle] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function generate() {
    setLoading(true); setErr('');
    try {
      const r = await api.get('/api/arc-flash/audit-bundle');
      setBundle(r.data?.data || null);
    } catch { setErr('Could not build the audit bundle.'); }
    finally { setLoading(false); }
  }

  function download() {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `arc-flash-audit-bundle-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  }

  const p = bundle?.posture;
  return (
    <div className="card" style={{ padding: '14px 16px', marginTop: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1rem' }}>Audit / insurer bundle</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>
            A single on-demand snapshot for diligence: compliance posture, a prioritized punch list, and the full label schedule.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {!bundle && <button type="button" className="btn btn-primary btn-sm" onClick={generate} disabled={loading}>{loading ? 'Building…' : 'Generate audit bundle'}</button>}
          {bundle && <button type="button" className="btn btn-secondary btn-sm" onClick={download}>Download JSON</button>}
          {bundle && <button type="button" className="btn btn-secondary btn-sm" onClick={generate} disabled={loading}>{loading ? 'Refreshing…' : 'Refresh'}</button>}
        </div>
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 12 }}>{err}</div>}

      {p && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10, marginTop: 14 }}>
            <Tile label="DANGER buses" value={p.dangerBuses} color={p.dangerBuses > 0 ? 'var(--color-danger)' : undefined} />
            <Tile label="Sanity errors" value={p.sanityErrors} color={p.sanityErrors > 0 ? 'var(--color-danger)' : undefined} />
            <Tile label="Studies expired" value={p.studiesExpired} color={p.studiesExpired > 0 ? 'var(--color-danger)' : undefined} />
            <Tile label="Studies expiring" value={p.studiesExpiring90d} />
            <Tile label="Blocked buses" value={p.blockedBuses} />
            <Tile label="Open field tasks" value={p.openCollectionTasks} />
            <Tile label="Open incidents" value={p.openIncidents ?? 0} color={p.openIncidents > 0 ? 'var(--color-danger)' : undefined} />
            <Tile label="Incident injuries" value={p.incidentsWithInjury ?? 0} color={p.incidentsWithInjury > 0 ? 'var(--color-danger)' : undefined} />
          </div>

          {bundle.itemsToResolve?.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <h3 style={{ margin: '0 0 6px', fontSize: '0.9rem' }}>Items to resolve ({bundle.itemsToResolveTotal})</h3>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
                {bundle.itemsToResolve.slice(0, 10).map((it, i) => (
                  <li key={i} style={{ marginBottom: 3 }}>
                    <strong>{ITEM_LABEL[it.type] || it.type}</strong> — {it.site} / {it.busName}: {it.detail}
                  </li>
                ))}
              </ul>
              {bundle.itemsToResolveTotal > 10 && <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 4 }}>…and {bundle.itemsToResolveTotal - 10} more in the downloaded bundle.</div>}
            </div>
          )}

          <p style={{ marginTop: 12, fontSize: '0.76rem', color: 'var(--color-text-secondary)' }}>{p.exposureNote}</p>
        </>
      )}
      </div>
  );
}
