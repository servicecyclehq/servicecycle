// ─────────────────────────────────────────────────────────────────────────────
// ImportAssets.jsx — bulk asset import from CSV/Excel (Day-1 onboarding flow).
//
// Three steps:
//   1. Upload    — dropzone / file input (.csv/.xlsx) → POST
//                  /api/assets/import/preview (multipart)
//   2. Map       — column-mapping table (dropdown per detected column,
//                  pre-filled from server auto-detection) + options
//                  (create missing sites, auto-apply NFPA 70B schedules)
//                  + first-10-rows preview with row-error highlights.
//                  Mapping edits re-run /preview with the explicit columnMap
//                  so validation stays live.
//   3. Done      — POST /commit results: created / skipped / errored with
//                  reasons, link back to /assets.
//
// Server is the source of truth for validation; this page only renders what
// /preview and /commit return. Route is RequireRole admin/manager in App.jsx.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Upload, FileSpreadsheet, CheckCircle2, AlertTriangle } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EQUIPMENT_TYPE_LABELS } from '../lib/equipment';

const ACCEPT = '.csv,.xlsx,.xls';

function errorMessage(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}

export default function ImportAssets() {
  useDocumentTitle('Import assets');
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [step, setStep]         = useState(1);           // 1 upload · 2 map · 3 done
  const [file, setFile]         = useState(null);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [preview, setPreview]   = useState(null);        // /preview response data
  const [mapping, setMapping]   = useState({});          // header -> fieldKey|null
  const [createMissingSites, setCreateMissingSites] = useState(true);
  const [autoApplySchedules, setAutoApplySchedules] = useState(true);

  const [result, setResult]     = useState(null);        // /commit response data

  // ── Step 1 → 2: upload + preview ──────────────────────────────────────────
  async function runPreview(selectedFile, columnMap) {
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', selectedFile);
      if (columnMap) fd.append('columnMap', JSON.stringify(columnMap));
      const r = await api.post('/api/assets/import/preview', fd);
      const d = r.data.data;
      setPreview(d);
      setMapping(d.suggestedMapping || {});
      setStep(2);
    } catch (err) {
      // A mapping that drops a required column 400s but still carries the
      // suggested mapping payload — keep the user on step 2 in that case.
      const data = err?.response?.data?.data;
      if (columnMap && data?.suggestedMapping) {
        setError(errorMessage(err, 'Preview failed.'));
      } else if (!columnMap) {
        setError(errorMessage(err, 'Could not read that file.'));
        setFile(null);
      } else {
        setError(errorMessage(err, 'Preview failed.'));
      }
    } finally {
      setBusy(false);
    }
  }

  function handleFileChosen(f) {
    if (!f) return;
    if (!/\.(csv|xlsx|xls)$/i.test(f.name)) {
      setError('Only .csv or .xlsx files are accepted.');
      return;
    }
    setFile(f);
    runPreview(f);
  }

  // Re-validate on every mapping change — the file is small (≤500 rows /
  // 5MB cap) and the server re-parse keeps validation truthful.
  function changeMapping(header, fieldKey) {
    const next = { ...mapping, [header]: fieldKey || null };
    setMapping(next);
    if (file) runPreview(file, next);
  }

  // ── Step 2 → 3: commit ────────────────────────────────────────────────────
  async function handleCommit() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('columnMap', JSON.stringify(mapping));
      fd.append('createMissingSites', String(createMissingSites));
      fd.append('autoApplySchedules', String(autoApplySchedules));
      const r = await api.post('/api/assets/import/commit', fd);
      setResult(r.data.data);
      setStep(3);
    } catch (err) {
      setError(errorMessage(err, 'Import failed.'));
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(1);
    setFile(null);
    setPreview(null);
    setMapping({});
    setResult(null);
    setError('');
  }

  // Per-row error lookup for the preview-table highlights. Server row
  // numbers are 1-indexed + header, so file row i (0-based) = row i+2.
  const errorsByRow = {};
  for (const ve of preview?.validationErrors || []) errorsByRow[ve.row] = ve.errors;
  const dupRows = new Set((preview?.duplicates || []).map(d => d.row));

  const mappedFields   = Object.values(mapping).filter(Boolean);
  const missingSite    = !mappedFields.includes('siteName');
  const missingType    = !mappedFields.includes('equipmentType');
  const validRowCount  = preview
    ? preview.totalRows - (preview.validationErrors?.length || 0) - (preview.duplicates?.length || 0)
    : 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Import assets</h1>
          <div className="page-subtitle">
            Bulk-load equipment from a CSV or Excel spreadsheet — up to 500 rows per file.
          </div>
        </div>
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => navigate('/assets')}>
            Back to assets
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 'var(--font-size-sm)' }}>
          {['1 · Upload', '2 · Map columns', '3 · Results'].map((label, i) => (
            <span
              key={label}
              style={{
                padding: '4px 12px', borderRadius: 20, fontWeight: 600,
                background: step === i + 1 ? 'var(--color-primary)' : 'var(--color-bg-secondary, #f1f5f9)',
                color:      step === i + 1 ? '#fff' : 'var(--color-text-secondary)',
              }}
            >
              {label}
            </span>
          ))}
        </div>

        {/* ── Step 1: upload ─────────────────────────────────────────────── */}
        {step === 1 && (
          <div className="card" style={{ padding: 24 }}>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a CSV or Excel file"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => {
                e.preventDefault();
                setDragOver(false);
                handleFileChosen(e.dataTransfer.files?.[0]);
              }}
              style={{
                border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-border, #cbd5e1)'}`,
                borderRadius: 12,
                padding: '48px 24px',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'var(--color-primary-bg, #eff6ff)' : 'transparent',
              }}
            >
              <Upload size={32} strokeWidth={1.5} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {busy ? 'Reading file…' : 'Drop a spreadsheet here, or click to browse'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                .csv or .xlsx · max 5MB · 500 rows. First row must be column headers.
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                style={{ display: 'none' }}
                onChange={e => handleFileChosen(e.target.files?.[0])}
              />
            </div>
            <div style={{ marginBottom: 12, fontSize: 13, color: 'var(--color-text-secondary)' }}>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  // Valid equipment type enum values from EQUIPMENT_TYPE_LABELS
                  const headers = 'Site,Equipment Type,Building,Area,Position,Description,Serial Number,Manufacturer,Model,Install Year,Criticality';
                  const example = 'Main Plant,TRANSFORMER_LIQUID,Building A,MV Room,Bay 1,13.8kV/480V step-down,SN-12345,Eaton,DST-750,2018,4';
                  const csv = headers + '\n' + example;
                  const blob = new Blob([csv], { type: 'text/csv' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'servicecycle-asset-import-template.csv';
                  a.click();
                  URL.revokeObjectURL(url);
                }}
                style={{ color: 'var(--color-primary)', textDecoration: 'underline' }}
              >
                Download template CSV
              </a>
              {' '}&mdash; includes all valid Equipment Type values as examples
            </div>
            <div style={{ marginTop: 16, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              Expected columns: <strong>Site</strong> and <strong>Equipment Type</strong> (required), plus
              optional Building, Area, Position, Manufacturer, Model, Serial Number, Install Date,
              Condition (C1/C2/C3), In Service, and Notes. Equipment types accept labels like
              “{EQUIPMENT_TYPE_LABELS.TRANSFORMER_LIQUID}” or enum values like TRANSFORMER_LIQUID.
            </div>
          </div>
        )}

        {/* ── Step 2: mapping + options + preview ────────────────────────── */}
        {step === 2 && preview && (
          <>
            <div className="card" style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <FileSpreadsheet size={18} strokeWidth={1.75} style={{ color: 'var(--color-text-secondary)' }} />
                <strong>{file?.name}</strong>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                  {preview.totalRows} data row{preview.totalRows !== 1 ? 's' : ''}
                </span>
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={reset}>
                  Choose a different file
                </button>
              </div>

              <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Column mapping</h3>
              <div className="table-wrap" style={{ marginBottom: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>File column</th>
                      <th>Sample value</th>
                      <th>Imports as</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.headers.map(h => (
                      <tr key={h}>
                        <td style={{ fontWeight: 600 }}>{h}</td>
                        <td className="td-muted" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {preview.sampleRows?.[0]?.[h] || <span className="text-muted">—</span>}
                        </td>
                        <td>
                          <select
                            className="filter-select"
                            aria-label={`Map column ${h}`}
                            value={mapping[h] || ''}
                            disabled={busy}
                            onChange={e => changeMapping(h, e.target.value)}
                          >
                            <option value="">— Ignore —</option>
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

              {(missingSite || missingType) && (
                <div role="alert" className="alert alert-error mb-16">
                  Required column{missingSite && missingType ? 's' : ''} not mapped:{' '}
                  {[missingSite && 'Site', missingType && 'Equipment Type'].filter(Boolean).join(', ')}.
                </div>
              )}

              <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Options</h3>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={createMissingSites}
                  onChange={e => setCreateMissingSites(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>Create missing sites</strong>
                  <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    Site, building, area, and position names that don't exist yet are created automatically.
                  </span>
                </span>
              </label>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={autoApplySchedules}
                  onChange={e => setAutoApplySchedules(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>Auto-apply NFPA 70B maintenance schedules</strong>
                  <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    Each imported asset gets the standard task set for its equipment type.
                  </span>
                </span>
              </label>

              {preview.unknownSites?.length > 0 && (
                <div
                  className={`alert ${createMissingSites ? 'alert-info' : 'alert-error'}`}
                  style={{ marginTop: 16 }}
                >
                  {preview.unknownSites.length} new site{preview.unknownSites.length !== 1 ? 's' : ''} in this file:{' '}
                  {preview.unknownSites.slice(0, 8).join(', ')}{preview.unknownSites.length > 8 ? '…' : ''}
                  {!createMissingSites && ' — enable "Create missing sites" or fix the names to continue.'}
                </div>
              )}
            </div>

            {/* Preview table — first 10 raw rows with error/duplicate highlights */}
            <div className="card" style={{ padding: 20, marginBottom: 16 }}>
              <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>
                Preview — first {Math.min(10, preview.totalRows)} of {preview.totalRows} rows
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
                        <tr
                          key={rowNum}
                          style={rowErrors
                            ? { background: 'var(--color-danger-bg, #fef2f2)' }
                            : isDup ? { background: 'var(--color-warning-bg, #fffbeb)' } : undefined}
                        >
                          <td className="td-muted">{rowNum}</td>
                          {preview.headers.map(h => (
                            <td key={h} style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {r[h] || <span className="text-muted">—</span>}
                            </td>
                          ))}
                          <td style={{ fontSize: 'var(--font-size-xs)', whiteSpace: 'normal', minWidth: 160 }}>
                            {rowErrors ? (
                              <span style={{ color: 'var(--color-danger)' }}>
                                {rowErrors.map(e => e.error).join('; ')}
                              </span>
                            ) : isDup ? (
                              <span style={{ color: 'var(--color-warning, #d97706)' }}>Duplicate serial — will be skipped</span>
                            ) : (
                              <span style={{ color: 'var(--color-success)' }}>OK</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {(preview.validationErrors?.length > 0 || preview.duplicates?.length > 0) && (
                <div style={{ marginTop: 12, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  {preview.validationErrors?.length > 0 && (
                    <div>
                      <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 4, color: 'var(--color-danger)' }} />
                      {preview.validationErrors.length} row{preview.validationErrors.length !== 1 ? 's' : ''} with errors
                      will not be imported
                      {preview.validationErrors.some(ve => ve.row > 11) && ' (some beyond this preview)'}
                      .
                    </div>
                  )}
                  {preview.validationErrors?.length > 10 && (
                    <details style={{ marginTop: 12 }}>
                      <summary style={{ cursor: 'pointer', color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>
                        Show all {preview.validationErrors.length} validation errors
                      </summary>
                      <ul style={{ marginTop: 8, fontSize: 13, paddingLeft: 20 }}>
                        {preview.validationErrors.map((err, i) => (
                          <li key={i}>Row {err.row}: {Array.isArray(err.errors) ? err.errors.map(e => e.error).join('; ') : err.message || JSON.stringify(err.errors)}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {preview.duplicates?.length > 0 && (
                    <div>
                      {preview.duplicates.length} row{preview.duplicates.length !== 1 ? 's' : ''} with already-known
                      serial numbers will be skipped.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy}>
                Start over
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCommit}
                disabled={
                  busy || missingSite || missingType || validRowCount === 0 ||
                  (!createMissingSites && preview.unknownSites?.length > 0)
                }
              >
                {busy ? 'Importing…' : `Import ${validRowCount} asset${validRowCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}

        {/* ── Step 3: results ────────────────────────────────────────────── */}
        {step === 3 && result && (
          <div className="card" style={{ padding: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
              <CheckCircle2 size={24} strokeWidth={1.75} style={{ color: 'var(--color-success)' }} />
              <h2 style={{ fontSize: 'var(--font-size-lg, 18px)', margin: 0 }}>Here's what we found</h2>
            </div>

            {/* N4: lead with the actionable outcome, not the row count. */}
            {result.created > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                padding: '12px 16px', marginBottom: 18, borderRadius: 8,
                background: 'var(--color-success-bg, #f0fdf4)', border: '1px solid var(--color-success-border, #bbf7d0)' }}>
                <div style={{ flex: 1, minWidth: 240, fontSize: 'var(--font-size-sm)' }}>
                  <strong>{result.created} asset{result.created !== 1 ? 's' : ''} imported.</strong>{' '}
                  {result.assetsWithProgram > 0
                    ? <>{result.assetsWithProgram} now carr{result.assetsWithProgram !== 1 ? 'y' : 'ies'} an NFPA 70B maintenance program ({result.schedulesCreated} task{result.schedulesCreated !== 1 ? 's' : ''} scheduled).</>
                    : <>No matching task templates for these equipment types.</>}
                  {result.assetsWithoutProgram > 0 && (
                    <> <span style={{ color: 'var(--color-warning, #92400e)', fontWeight: 600 }}>{result.assetsWithoutProgram} landed with no program — review them.</span></>
                  )}
                </div>
                <Link to="/reports/compliance" className="btn btn-primary btn-sm">View your fix-it list →</Link>
              </div>
            )}

            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-success)' }}>{result.created}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>created</div>
              </div>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-warning, #d97706)' }}>{result.skipped}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>skipped (duplicates)</div>
              </div>
              <div>
                <div style={{ fontSize: 28, fontWeight: 700, color: result.failed > 0 ? 'var(--color-danger)' : 'var(--color-text)' }}>{result.failed}</div>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>errored</div>
              </div>
              {result.sitesCreated > 0 && (
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{result.sitesCreated}</div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>sites created</div>
                </div>
              )}
              {result.schedulesCreated > 0 && (
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{result.schedulesCreated}</div>
                  <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>schedules applied</div>
                </div>
              )}
            </div>

            {result.skippedRows?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 6 }}>Skipped rows</h3>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  {result.skippedRows.slice(0, 20).map(s => (
                    <li key={s.row}>Row {s.row} — {s.serialNumber ? `serial ${s.serialNumber}: ` : ''}{s.reason}</li>
                  ))}
                  {result.skippedRows.length > 20 && <li>…and {result.skippedRows.length - 20} more</li>}
                </ul>
              </div>
            )}

            {result.errors?.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 6, color: 'var(--color-danger)' }}>Rows with errors (not imported)</h3>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                  {result.errors.slice(0, 20).map(er => (
                    <li key={er.row}>Row {er.row} — {er.errors.map(e => e.error).join('; ')}</li>
                  ))}
                  {result.errors.length > 20 && <li>…and {result.errors.length - 20} more</li>}
                </ul>
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 6 }}>
                  Fix these rows in your spreadsheet and re-import — duplicate serials are skipped automatically,
                  so re-running the same file is safe.
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <Link to="/assets" className="btn btn-primary">Go to assets</Link>
              <button type="button" className="btn btn-secondary" onClick={reset}>
                Import another file
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
