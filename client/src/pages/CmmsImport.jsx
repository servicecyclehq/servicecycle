// CmmsImport.jsx -- CMMS Data Import Hub
//
// Unified import page for migrating data from IBM Maximo, SAP S/4HANA PM,
// Oracle EAM, or generic CSV/Excel into ServiceCycle.
//
// Layout:
//   1. Platform picker  -- Generic / IBM Maximo / SAP S/4HANA PM / Oracle EAM
//   2. Data-type tabs   -- Assets | Work Orders | Deficiencies | Schedules
//   3. 3-step flow per tab: Upload -> Map columns -> Results
//
// The platform selection pre-fills column-mapping dropdowns with each
// system's known export header names so most customers need zero manual
// mapping work after selecting their platform.
//
// Server routes:
//   Assets      POST /api/assets/import/preview|commit       (existing)
//   Work Orders POST /api/work-orders/import/preview|commit   (new)
//   Deficiencies POST /api/deficiencies/import/preview|commit (new)
//   Schedules   POST /api/schedules/import/preview|commit     (new)

import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
  Database, History, ShieldAlert, Calendar,
} from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const ACCEPT = '.csv,.xlsx,.xls';

// ---- Platform definitions --------------------------------------------------

const PLATFORMS = [
  {
    id: 'generic',
    label: 'Generic CSV / Excel',
    description: 'Any spreadsheet with flexible column names.',
    logo: null,
  },
  {
    id: 'maximo',
    label: 'IBM Maximo',
    description: 'Maximo Application Suite OSLC REST export or CSV report.',
    logo: null,
  },
  {
    id: 'sap',
    label: 'SAP S/4HANA PM',
    description: 'IW38 (work orders), IW28 (notifications), or IP30 (PM schedules) export.',
    logo: null,
  },
  {
    id: 'oracle',
    label: 'Oracle EAM',
    description: 'Oracle Fusion / Oracle EAM CSV or spreadsheet export.',
    logo: null,
  },
];

// ---- Data-type tab definitions ---------------------------------------------

const TABS = [
  {
    id: 'assets',
    label: 'Assets',
    icon: Database,
    previewPath:  '/api/assets/import/preview',
    commitPath:   '/api/assets/import/commit',
    description:  'Equipment master data: type, location, nameplate, condition ratings.',
    platformHint: {
      maximo:  'Export assets via Maximo OSLC REST or the Asset List CSV report (ASSETNUM, SITEID, ASSETTYPE, MANUFACTURER, MODEL, SERIALNUM, INSTALLDATE).',
      sap:     'Use transaction IE05 (Equipment List) and export to Excel. Required columns: Equipment, Functional Location, Equipment Category, Manufacturer, Model Number, Serial Number, Start-Up Date.',
      oracle:  'Use Assets > Export > All Assets. Required columns: ASSET_NUMBER, ORG_CODE, CATEGORY, MANUFACTURER, MODEL_NUMBER, SERIAL_NUMBER, IN_SERVICE_DATE.',
      generic: 'First row must be column headers. Required: Site and Equipment Type. Optional: Building, Area, Manufacturer, Model, Serial Number, Install Date, Condition (C1/C2/C3).',
    },
  },
  {
    id: 'workorders',
    label: 'Work Orders',
    icon: History,
    previewPath:  '/api/work-orders/import/preview',
    commitPath:   '/api/work-orders/import/commit',
    description:  'Historical completed maintenance records. Populates EMP maintenance history immediately.',
    platformHint: {
      maximo:  'Run the Work Order List report filtered to STATUS=COMP/CLOSE with columns WONUM, ASSETNUM, STATUS, ACTSTART, ACTFINISH, SCHEDSTART, DESCRIPTION, VENDOR.',
      sap:     'Transaction IW38: filter by system status TECO or CLSD. Export to Excel. Key columns: Order, Equipment, User Status, Actual start, Actual finish, Basic start date, Short text, Vendor.',
      oracle:  'Work Orders > Completed. Export with columns WO_NUMBER, ASSET_NUMBER, STATUS_CODE, ACTUAL_START_DATE, ACTUAL_COMPLETION_DATE, SCHEDULED_START_DATE, DESCRIPTION.',
      generic: 'Required: Asset Serial Number, Completed Date. Optional: Scheduled Date, Started Date, Status, Notes, As-Found / As-Left Condition (C1/C2/C3), Contractor.',
    },
  },
  {
    id: 'deficiencies',
    label: 'Deficiencies',
    icon: ShieldAlert,
    previewPath:  '/api/deficiencies/import/preview',
    commitPath:   '/api/deficiencies/import/commit',
    description:  'Open findings and corrective actions from inspections and prior audits.',
    platformHint: {
      maximo:  'Export Failure Codes / Problem records. Key columns: ASSETNUM, DESCRIPTION, PROBLEMCODE (maps to severity), REMEDY (corrective action).',
      sap:     'Transaction IW28: PM Notifications. Export with columns Equipment, Short Text, Notification Type (M1/M2 -> severity), Long Text, Completion Date.',
      oracle:  'Work Requests or Service Requests export. Key columns: ASSET_NUMBER, DESCRIPTION, PRIORITY_CODE (1/2/3 -> severity), RESOLUTION_SUMMARY, RESOLUTION_DATE.',
      generic: 'Required: Asset Serial Number, Severity (IMMEDIATE / RECOMMENDED / ADVISORY or codes like P1/P2/P3), Description. Optional: Corrective Action, Resolution Date.',
    },
  },
  {
    id: 'schedules',
    label: 'Schedules',
    icon: Calendar,
    previewPath:  '/api/schedules/import/preview',
    commitPath:   '/api/schedules/import/commit',
    description:  'Updates last-completion dates on existing schedules so next-due dates are calculated correctly from day 1.',
    note:         'Run asset import first (with "Auto-apply NFPA 70B schedules" checked) before importing schedule history.',
    platformHint: {
      maximo:  'Export PM records (transaction PM01/PM03). Key columns: ASSETNUM, PMNUM or DESCRIPTION (task identifier), LASTCOMPDATE, NEXTDATE.',
      sap:     'Transaction IP30: Maintenance Planning. Export with columns Equipment, Maintenance Item, Item Description, Last Called, Next Planned.',
      oracle:  'Maintenance Schedules export. Key columns: ASSET_NUMBER, ACTIVITY or ACTIVITY_DESCRIPTION, LAST_COMPLETION_DATE, NEXT_DUE_DATE.',
      generic: 'Required: Asset Serial Number, Last Completed Date, and either Task Code (e.g. XFMR_DGA) or Task Description. Optional: Next Due Date.',
    },
  },
];

// ---- Helpers ---------------------------------------------------------------

function errorMessage(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}

function ResultCount({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 28, fontWeight: 700, color: `var(--color-${color})` }}>{value}</div>
      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{label}</div>
    </div>
  );
}

// ---- Single-tab import flow ------------------------------------------------

function ImportTab({ tab, platform }) {
  const fileInputRef = useRef(null);
  const [step, setStep]     = useState(1);
  const [file, setFile]     = useState(null);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');
  const [dragOver, setDO]   = useState(false);
  const [preview, setPreview] = useState(null);
  const [mapping, setMapping] = useState({});
  const [result, setResult]   = useState(null);
  // Assets-tab extras
  const [createSites, setCreateSites]     = useState(true);
  const [autoSchedules, setAutoSchedules] = useState(true);

  const isAssets = tab.id === 'assets';

  async function runPreview(f, colMap) {
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', f);
      fd.append('platform', platform);
      if (colMap) fd.append('columnMap', JSON.stringify(colMap));
      const r = await api.post(tab.previewPath, fd);
      const d = r.data.data;
      setPreview(d);
      setMapping(d.suggestedMapping || {});
      setStep(2);
    } catch (err) {
      const data = err?.response?.data?.data;
      if (colMap && data?.suggestedMapping) setError(errorMessage(err, 'Preview failed.'));
      else if (!colMap) { setError(errorMessage(err, 'Could not read that file.')); setFile(null); }
      else setError(errorMessage(err, 'Preview failed.'));
    } finally { setBusy(false); }
  }

  function handleFile(f) {
    if (!f) return;
    if (!/\.(csv|xlsx|xls)$/i.test(f.name)) { setError('Only .csv or .xlsx files are accepted.'); return; }
    setFile(f);
    runPreview(f, null);
  }

  function changeMapping(header, fieldKey) {
    const next = { ...mapping, [header]: fieldKey || null };
    setMapping(next);
    if (file) runPreview(file, next);
  }

  async function handleCommit() {
    if (!file || busy) return;
    setBusy(true); setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('platform', platform);
      fd.append('columnMap', JSON.stringify(mapping));
      if (isAssets) {
        fd.append('createMissingSites', String(createSites));
        fd.append('autoApplySchedules', String(autoSchedules));
      }
      const r = await api.post(tab.commitPath, fd);
      setResult(r.data.data);
      setStep(3);
    } catch (err) {
      setError(errorMessage(err, 'Import failed.'));
    } finally { setBusy(false); }
  }

  function reset() {
    setStep(1); setFile(null); setPreview(null);
    setMapping({}); setResult(null); setError('');
  }

  const errorsByRow = {};
  for (const ve of preview?.validationErrors || []) errorsByRow[ve.row] = ve.errors;
  const dupRows = new Set((preview?.duplicates || []).map(d => d.row));
  const mappedFields   = Object.values(mapping).filter(Boolean);
  const missingSite    = isAssets && !mappedFields.includes('siteName');
  const missingType    = isAssets && !mappedFields.includes('equipmentType');
  const validRowCount  = preview
    ? preview.totalRows - (preview.validationErrors?.length || 0) - (preview.duplicates?.length || 0)
    : 0;

  const hint = tab.platformHint[platform] || tab.platformHint.generic;

  // ---- Step 1: upload ----
  if (step === 1) return (
    <div>
      {tab.note && (
        <div className="alert alert-info mb-16" style={{ marginBottom: 16 }}>
          {tab.note}
        </div>
      )}
      <div style={{ marginBottom: 12, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', background: 'var(--color-bg-secondary)', borderRadius: 8, padding: '10px 14px' }}>
        <strong>How to export from {PLATFORMS.find(p => p.id === platform)?.label}:</strong> {hint}
      </div>
      {error && <div role="alert" className="alert alert-error mb-16" style={{ marginBottom: 12 }}>{error}</div>}
      <div
        role="button" tabIndex={0}
        aria-label="Upload file"
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        onDragOver={e => { e.preventDefault(); setDO(true); }}
        onDragLeave={() => setDO(false)}
        onDrop={e => { e.preventDefault(); setDO(false); handleFile(e.dataTransfer.files?.[0]); }}
        style={{
          border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-border, #cbd5e1)'}`,
          borderRadius: 12, padding: '40px 24px', textAlign: 'center', cursor: 'pointer',
          background: dragOver ? 'var(--color-primary-bg, #eff6ff)' : 'transparent',
        }}
      >
        <Upload size={28} strokeWidth={1.5} style={{ color: 'var(--color-text-secondary)', marginBottom: 10 }} />
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          {busy ? 'Reading file...' : 'Drop a spreadsheet here, or click to browse'}
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          .csv or .xlsx up to 10MB
        </div>
        <input ref={fileInputRef} type="file" accept={ACCEPT} style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files?.[0])} />
      </div>
    </div>
  );

  // ---- Step 2: mapping + options ----
  if (step === 2 && preview) return (
    <div>
      {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="card" style={{ padding: 18, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <FileSpreadsheet size={16} style={{ color: 'var(--color-text-secondary)' }} />
          <strong style={{ fontSize: 'var(--font-size-sm)' }}>{file?.name}</strong>
          <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            {preview.totalRows} row{preview.totalRows !== 1 ? 's' : ''}
          </span>
          <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={reset}>
            Choose a different file
          </button>
        </div>

        <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Column mapping</h3>
        <div className="table-wrap" style={{ marginBottom: 14 }}>
          <table>
            <thead><tr><th>File column</th><th>Sample value</th><th>Imports as</th></tr></thead>
            <tbody>
              {preview.headers.map(h => (
                <tr key={h}>
                  <td style={{ fontWeight: 600 }}>{h}</td>
                  <td className="td-muted" style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {preview.sampleRows?.[0]?.[h] || <span className="text-muted">--</span>}
                  </td>
                  <td>
                    <select className="filter-select" aria-label={`Map ${h}`}
                      value={mapping[h] || ''} disabled={busy}
                      onChange={e => changeMapping(h, e.target.value)}>
                      <option value="">-- Ignore --</option>
                      {preview.schemaFields.map(f => (
                        <option key={f.key} value={f.key}>
                          {f.label}{f.required ? ' *' : ''}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {isAssets && (
          <>
            {(missingSite || missingType) && (
              <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>
                Required columns not mapped: {[missingSite && 'Site', missingType && 'Equipment Type'].filter(Boolean).join(', ')}.
              </div>
            )}
            <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Options</h3>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={createSites} style={{ marginTop: 3 }}
                onChange={e => setCreateSites(e.target.checked)} />
              <span>
                <strong>Create missing sites</strong>
                <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  Site, building, area, and position names that don't exist yet are created automatically.
                </span>
              </span>
            </label>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={autoSchedules} style={{ marginTop: 3 }}
                onChange={e => setAutoSchedules(e.target.checked)} />
              <span>
                <strong>Auto-apply NFPA 70B maintenance schedules</strong>
                <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  Each imported asset gets the standard task set for its equipment type.
                </span>
              </span>
            </label>
          </>
        )}

        {preview.unknownSites?.length > 0 && (
          <div className={`alert ${createSites ? 'alert-info' : 'alert-error'}`} style={{ marginTop: 12 }}>
            {preview.unknownSites.length} new site{preview.unknownSites.length !== 1 ? 's' : ''} in this file:{' '}
            {preview.unknownSites.slice(0, 6).join(', ')}{preview.unknownSites.length > 6 ? '...' : ''}
            {!createSites && ' -- enable "Create missing sites" or fix the names.'}
          </div>
        )}

        {preview.unmatchedSerials?.length > 0 && (
          <div className="alert alert-warning" style={{ marginTop: 12 }}>
            {preview.unmatchedSerials.length} serial number{preview.unmatchedSerials.length !== 1 ? 's' : ''} not found in your asset list --
            those rows will be skipped: {preview.unmatchedSerials.slice(0, 4).join(', ')}{preview.unmatchedSerials.length > 4 ? '...' : ''}.
            Import assets first if needed.
          </div>
        )}
      </div>

      {/* Sample rows preview */}
      <div className="card" style={{ padding: 18, marginBottom: 12 }}>
        <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>
          Preview -- first {Math.min(10, preview.totalRows)} of {preview.totalRows} rows
        </h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                {preview.headers.map(h => <th key={h}>{h}</th>)}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {preview.sampleRows.map((r, i) => {
                const rowNum = i + 2;
                const rowErrors = errorsByRow[rowNum];
                const isDup = dupRows.has(rowNum);
                return (
                  <tr key={rowNum} style={
                    rowErrors ? { background: 'var(--color-danger-bg, #fef2f2)' }
                    : isDup ? { background: 'var(--color-warning-bg, #fffbeb)' }
                    : undefined
                  }>
                    <td className="td-muted">{rowNum}</td>
                    {preview.headers.map(h => (
                      <td key={h} style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r[h] || <span className="text-muted">--</span>}
                      </td>
                    ))}
                    <td style={{ fontSize: 'var(--font-size-xs)', whiteSpace: 'normal', minWidth: 140 }}>
                      {rowErrors
                        ? <span style={{ color: 'var(--color-danger)' }}>{rowErrors.map(e => e.error).join('; ')}</span>
                        : isDup
                        ? <span style={{ color: 'var(--color-warning, #d97706)' }}>Duplicate -- will be skipped</span>
                        : <span style={{ color: 'var(--color-success)' }}>OK</span>
                      }
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(preview.validationErrors?.length > 0 || preview.duplicates?.length > 0) && (
          <div style={{ marginTop: 10, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
            {preview.validationErrors?.length > 0 && (
              <div>
                <AlertTriangle size={12} style={{ verticalAlign: '-2px', marginRight: 4, color: 'var(--color-danger)' }} />
                {preview.validationErrors.length} row{preview.validationErrors.length !== 1 ? 's' : ''} with errors will not be imported.
              </div>
            )}
            {preview.duplicates?.length > 0 && (
              <div>{preview.duplicates.length} duplicate row{preview.duplicates.length !== 1 ? 's' : ''} will be skipped.</div>
            )}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy}>Start over</button>
        <button type="button" className="btn btn-primary" onClick={handleCommit}
          disabled={busy || (isAssets && (missingSite || missingType)) || validRowCount === 0
            || (isAssets && !createSites && preview.unknownSites?.length > 0)}>
          {busy ? 'Importing...' : `Import ${validRowCount} row${validRowCount !== 1 ? 's' : ''}`}
        </button>
      </div>
    </div>
  );

  // ---- Step 3: results ----
  if (step === 3 && result) {
    const mainCount = result.created ?? result.updated ?? 0;
    const mainLabel = result.updated !== undefined ? 'schedules updated' : 'created';
    return (
      <div className="card" style={{ padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <CheckCircle2 size={22} strokeWidth={1.75} style={{ color: 'var(--color-success)' }} />
          <h2 style={{ fontSize: 'var(--font-size-lg, 18px)', margin: 0 }}>Import complete</h2>
        </div>
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 20 }}>
          <ResultCount label={mainLabel} value={mainCount} color="success" />
          <ResultCount label="skipped" value={result.skipped || 0} color="warning" />
          <ResultCount label="errored" value={result.failed || 0} color={result.failed > 0 ? 'danger' : 'text'} />
          {result.sitesCreated > 0 && <ResultCount label="sites created" value={result.sitesCreated} color="text" />}
          {result.schedulesCreated > 0 && <ResultCount label="schedules applied" value={result.schedulesCreated} color="text" />}
        </div>

        {result.skippedRows?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 6 }}>Skipped rows</h3>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              {result.skippedRows.slice(0, 20).map(s => (
                <li key={s.row}>Row {s.row}{s.serialNumber ? ` (${s.serialNumber})` : ''}: {s.reason}</li>
              ))}
              {result.skippedRows.length > 20 && <li>...and {result.skippedRows.length - 20} more</li>}
            </ul>
          </div>
        )}

        {result.errors?.length > 0 && (
          <div style={{ marginBottom: 14 }}>
            <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 6, color: 'var(--color-danger)' }}>Rows with errors (not imported)</h3>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              {result.errors.slice(0, 20).map(er => (
                <li key={er.row}>Row {er.row}: {er.errors.map(e => e.error).join('; ')}</li>
              ))}
              {result.errors.length > 20 && <li>...and {result.errors.length - 20} more</li>}
            </ul>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-primary" onClick={reset}>Import another file</button>
        </div>
      </div>
    );
  }

  return null;
}

// ---- Main page -------------------------------------------------------------

export default function CmmsImport() {
  useDocumentTitle('Import data');
  const [platform, setPlatform] = useState('generic');
  const [activeTab, setActiveTab] = useState('assets');

  const currentTab = TABS.find(t => t.id === activeTab);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Import data</h1>
          <div className="page-subtitle">
            Migrate equipment records from IBM Maximo, SAP S/4HANA PM, Oracle EAM, or any CSV spreadsheet.
          </div>
        </div>
      </div>

      <div className="page-body">

        {/* Platform picker */}
        <div className="card" style={{ padding: 18, marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 10, fontSize: 'var(--font-size-ui)' }}>
            Source system
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {PLATFORMS.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPlatform(p.id)}
                style={{
                  padding: '10px 16px',
                  borderRadius: 8,
                  border: `2px solid ${platform === p.id ? 'var(--color-primary)' : 'var(--color-border, #e2e8f0)'}`,
                  background: platform === p.id ? 'var(--color-primary-bg, #eff6ff)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                  minWidth: 160,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 'var(--font-size-sm)', color: platform === p.id ? 'var(--color-primary)' : 'var(--color-text)' }}>
                  {p.label}
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {p.description}
                </div>
              </button>
            ))}
          </div>
          {platform !== 'generic' && (
            <div style={{ marginTop: 10, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              Column mapping dropdowns are pre-filled with standard {PLATFORMS.find(p2 => p2.id === platform)?.label} export column names.
            </div>
          )}
        </div>

        {/* Data-type tabs */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 0, borderBottom: '1px solid var(--color-border, #e2e8f0)' }}>
          {TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '10px 18px',
                  border: 'none', borderBottom: active ? '2px solid var(--color-primary)' : '2px solid transparent',
                  background: 'transparent', cursor: 'pointer',
                  fontWeight: active ? 700 : 400,
                  color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  fontSize: 'var(--font-size-sm)',
                  marginBottom: -1,
                }}
              >
                <Icon size={14} strokeWidth={1.75} />
                {tab.label}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
            {currentTab?.description}
          </div>
          {currentTab && (
            <ImportTab key={`${activeTab}-${platform}`} tab={currentTab} platform={platform} />
          )}
        </div>

      </div>
    </>
  );
}
