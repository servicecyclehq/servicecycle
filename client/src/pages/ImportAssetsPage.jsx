// -----------------------------------------------------------------------------
// ImportAssetsPage.jsx -- SMART asset importer (AI-assisted column mapping).
//
// Sibling of ImportAssets.jsx (the template importer at /assets/import): that
// page expects headers close to our template; THIS one accepts whatever
// CSV/XLSX the user already has -- or pasted CSV text -- and proposes a
// column mapping for review before anything is written.
//
// Three steps against /api/import/assets (routes/importAssets.ts):
//   1. Source   -- file dropzone (.csv/.xlsx) OR paste-CSV textarea
//                  -> POST /preview (multipart). The server parses ONCE and
//                  echoes the rows; the client holds them for /commit.
//   2. Review   -- mapping table (per-column provenance chip: green Exact /
//                  blue Synonym / purple AI / gray Unmapped / Manual after an
//                  edit) + sample values + target dropdowns. Every edit
//                  re-runs /preview with the explicit mapping so the
//                  validation summary stays server-truthful. Options:
//                  allow creating missing sites.
//   3. Results  -- POST /commit outcomes per row (created |
//                  skipped_duplicate | error) + error-rows CSV download.
//
// Server is the source of truth for validation AND re-validates everything
// again on commit. Route is RequireRole admin/manager in App.jsx.
// -----------------------------------------------------------------------------

import { useRef, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Upload, FileSpreadsheet, Sparkles, AlertTriangle } from 'lucide-react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import MappingReviewTable from '../components/import/MappingReviewTable';
import ImportResultsPanel from '../components/import/ImportResultsPanel';

const ACCEPT = '.csv,.xlsx,.xls';

function errorMessage(err, fallback) {
  return err?.response?.data?.error || err?.message || fallback;
}

/** Rich map { header: { field, ... } } -> plain { header: field|null } for the API. */
function plainMapping(mapInfo) {
  const out = {};
  for (const [h, info] of Object.entries(mapInfo)) out[h] = info?.field || null;
  return out;
}

export default function ImportAssetsPage() {
  useDocumentTitle('Smart import');
  const navigate = useNavigate();
  const location = useLocation();
  const fileInputRef = useRef(null);

  const [step, setStep]         = useState(1);        // 1 source | 2 review | 3 results
  const [source, setSource]     = useState(null);     // { kind: 'file', file } | { kind: 'text', text }
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState('');
  const [dragOver, setDragOver] = useState(false);

  const [preview, setPreview]   = useState(null);     // /preview data (headers, rows, targetFields, columns, aiUsed)
  const [mapInfo, setMapInfo]   = useState({});       // { header: { field, confidence, source } } -- provenance preserved
  const [validation, setValidation] = useState(null); // latest server validation block
  const [missingRequired, setMissingRequired] = useState([]);
  const [duplicateTargets, setDuplicateTargets] = useState([]);
  const [allowCreateSites, setAllowCreateSites] = useState(true);

  const [result, setResult]     = useState(null);     // /commit data

  function buildSourceForm(src, extra = {}) {
    const fd = new FormData();
    if (src.kind === 'file') fd.append('file', src.file);
    else fd.append('text', src.text);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fd;
  }

  // -- Step 1 -> 2: parse + auto-map (deterministic tiers + AI assist) --------
  async function runAnalyze(src) {
    setBusy(true);
    setError('');
    try {
      const r = await api.post('/api/import/assets/preview', buildSourceForm(src));
      const d = r.data.data;
      setSource(src);
      setPreview(d);
      setMapInfo(d.mapping || {});
      setValidation(d.validation || null);
      setMissingRequired(d.missingRequired || []);
      setDuplicateTargets(d.duplicateTargets || []);
      setStep(2);
    } catch (err) {
      setError(errorMessage(err, 'Could not read that data.'));
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
    runAnalyze({ kind: 'file', file: f });
  }

  function handleAnalyzeText() {
    if (!pasteText.trim() || busy) return;
    runAnalyze({ kind: 'text', text: pasteText });
  }

  // -- Step 2: mapping edits re-validate server-side; chips keep provenance ---
  async function changeMapping(header, fieldKey) {
    const next = { ...mapInfo };
    // Unmap any other column currently holding this target -- one column per field.
    if (fieldKey) {
      for (const [h, info] of Object.entries(next)) {
        if (h !== header && info?.field === fieldKey) {
          next[h] = { field: null, confidence: 0, source: null };
        }
      }
    }
    next[header] = fieldKey
      ? { field: fieldKey, confidence: 1, source: 'user' }
      : { field: null, confidence: 0, source: null };
    setMapInfo(next);

    setBusy(true);
    setError('');
    try {
      const fd = buildSourceForm(source, { mapping: JSON.stringify(plainMapping(next)) });
      const r = await api.post('/api/import/assets/preview', fd);
      const d = r.data.data;
      setValidation(d.validation || null);
      setMissingRequired(d.missingRequired || []);
      setDuplicateTargets(d.duplicateTargets || []);
    } catch (err) {
      setError(errorMessage(err, 'Re-validation failed.'));
    } finally {
      setBusy(false);
    }
  }

  // -- Step 2 -> 3: commit (server re-validates everything) -------------------
  async function handleCommit() {
    if (!preview || busy) return;
    setBusy(true);
    setError('');
    try {
      const fd = new FormData();
      fd.append('rows', JSON.stringify(preview.rows || []));
      fd.append('mapping', JSON.stringify(plainMapping(mapInfo)));
      fd.append('allowCreateSites', String(allowCreateSites));
      const r = await api.post('/api/import/assets/commit', fd);
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
    setSource(null);
    setPasteText('');
    setPreview(null);
    setMapInfo({});
    setValidation(null);
    setMissingRequired([]);
    setDuplicateTargets([]);
    setResult(null);
    setError('');
  }

  const samplesByHeader = {};
  for (const c of preview?.columns || []) samplesByHeader[c.header] = c.samples;
  const aiCount = Object.values(mapInfo).filter((i) => i?.field && i.source === 'ai').length;
  const unmappedCount = (preview?.headers || []).filter((h) => !mapInfo[h]?.field).length;
  const validCount = validation?.validCount ?? 0;
  const canCommit = !busy && preview && missingRequired.length === 0 && duplicateTargets.length === 0 && validCount > 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Smart import</h1>
          <div className="page-subtitle">
            Bring any equipment spreadsheet -- ServiceCycle maps the columns, you approve.
          </div>
        </div>
        <div>
          <button type="button" className="btn btn-secondary" onClick={() => navigate(location.state?.from || '/assets')}>
            Back to assets
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, fontSize: 'var(--font-size-sm)' }}>
          {['1 - Add data', '2 - Review mapping', '3 - Results'].map((label, i) => (
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

        {/* -- Step 1: file or pasted text --------------------------------- */}
        {step === 1 && (
          <div className="card" style={{ padding: 24 }}>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload a CSV or Excel file"
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                handleFileChosen(e.dataTransfer.files?.[0]);
              }}
              style={{
                border: `2px dashed ${dragOver ? 'var(--color-primary)' : 'var(--color-border, #cbd5e1)'}`,
                borderRadius: 12,
                padding: '40px 24px',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'var(--color-primary-bg, #eff6ff)' : 'transparent',
                marginBottom: 16,
              }}
            >
              <Upload size={32} strokeWidth={1.5} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                {busy ? 'Analyzing...' : 'Drop any equipment spreadsheet here, or click to browse'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                .csv or .xlsx - max 5MB - 500 rows. No template needed: columns are matched automatically
                and anything ambiguous goes to AI with a few sample values, then to you for approval.
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                style={{ display: 'none' }}
                onChange={(e) => handleFileChosen(e.target.files?.[0])}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 8px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
              <span style={{ flex: 1, borderTop: '1px solid var(--color-border, #e2e8f0)' }} />
              or paste CSV text
              <span style={{ flex: 1, borderTop: '1px solid var(--color-border, #e2e8f0)' }} />
            </div>

            <textarea
              value={pasteText}
              onChange={(e) => setPasteText(e.target.value)}
              placeholder={'Site,Equipment,Mfr,S/N\nEastgate Plant,Panelboard,Eaton,SN-1001'}
              rows={5}
              disabled={busy}
              aria-label="Paste CSV text"
              style={{
                width: '100%', boxSizing: 'border-box', padding: 10, borderRadius: 8,
                border: '1px solid var(--color-border, #cbd5e1)', fontFamily: 'var(--font-mono, monospace)',
                fontSize: 13, background: 'transparent', color: 'inherit', resize: 'vertical',
              }}
            />
            <div style={{ marginTop: 8, display: 'flex', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-primary" disabled={busy || !pasteText.trim()} onClick={handleAnalyzeText}>
                {busy ? 'Analyzing...' : 'Analyze pasted text'}
              </button>
            </div>
          </div>
        )}

        {/* -- Step 2: mapping review + validation -------------------------- */}
        {step === 2 && preview && (
          <>
            <div className="card" style={{ padding: 20, marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <FileSpreadsheet size={18} strokeWidth={1.75} style={{ color: 'var(--color-text-secondary)' }} />
                <strong>{source?.kind === 'file' ? source.file?.name : 'Pasted CSV'}</strong>
                <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                  {preview.totalRows} data row{preview.totalRows !== 1 ? 's' : ''}
                </span>
                {aiCount > 0 && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-sm)', color: 'var(--color-ai, #7c3aed)' }}>
                    <Sparkles size={14} /> {aiCount} column{aiCount !== 1 ? 's' : ''} mapped by AI -- review before importing
                  </span>
                )}
                <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={reset}>
                  Start over
                </button>
              </div>

              <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Column mapping</h3>
              <MappingReviewTable
                headers={preview.headers}
                mapInfo={mapInfo}
                targetFields={preview.targetFields || []}
                samplesByHeader={samplesByHeader}
                busy={busy}
                onChangeField={changeMapping}
              />

              {missingRequired.length > 0 && (
                <div role="alert" className="alert alert-error mb-16">
                  Required field{missingRequired.length !== 1 ? 's' : ''} not mapped: {missingRequired.join(', ')}.
                  Map a column to each before importing.
                </div>
              )}
              {duplicateTargets.length > 0 && (
                <div role="alert" className="alert alert-error mb-16">
                  Two columns map to the same field: {duplicateTargets.join(', ')}. Set one of them to Ignore.
                </div>
              )}
              {unmappedCount > 0 && missingRequired.length === 0 && (
                <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                  {unmappedCount} column{unmappedCount !== 1 ? 's' : ''} will be ignored.
                </div>
              )}

              <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Options</h3>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={allowCreateSites}
                  onChange={(e) => setAllowCreateSites(e.target.checked)}
                  style={{ marginTop: 3 }}
                />
                <span>
                  <strong>Create missing sites</strong>
                  <span style={{ display: 'block', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                    Site, building, area, and position names that don't exist yet are created automatically.
                    When off, rows that reference an unknown site are reported as errors instead.
                  </span>
                </span>
              </label>
            </div>

            {/* Validation summary -- server-computed, refreshed on every edit */}
            <div className="card" style={{ padding: 20, marginBottom: 16 }}>
              <h3 style={{ fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Validation</h3>
              <div style={{ fontSize: 'var(--font-size-sm)', marginBottom: 8 }}>
                <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{validCount} row{validCount !== 1 ? 's' : ''} ready</span>
                {validation?.errorCount > 0 && (
                  <span style={{ color: 'var(--color-danger)', marginLeft: 12 }}>
                    <AlertTriangle size={13} style={{ verticalAlign: '-2px', marginRight: 4 }} />
                    {validation.errorCount} row{validation.errorCount !== 1 ? 's' : ''} with errors (will not be imported)
                  </span>
                )}
              </div>
              {validation?.errors?.length > 0 && (
                <details>
                  <summary style={{ cursor: 'pointer', color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)' }}>
                    Show validation errors
                  </summary>
                  <ul style={{ marginTop: 8, fontSize: 13, paddingLeft: 20 }}>
                    {validation.errors.slice(0, 20).map((e) => (
                      <li key={e.row}>Row {e.row}: {e.errors.map((x) => x.error).join('; ')}</li>
                    ))}
                    {validation.errors.length > 20 && <li>...and {validation.errors.length - 20} more</li>}
                  </ul>
                </details>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-secondary" onClick={reset} disabled={busy}>
                Start over
              </button>
              <button type="button" className="btn btn-primary" onClick={handleCommit} disabled={!canCommit}>
                {busy ? 'Working...' : `Import ${validCount} row${validCount !== 1 ? 's' : ''}`}
              </button>
            </div>
          </>
        )}

        {/* -- Step 3: per-row outcomes ------------------------------------- */}
        {step === 3 && result && (
          <ImportResultsPanel
            result={result}
            headers={preview?.headers || []}
            rows={preview?.rows || []}
            onReset={reset}
          />
        )}
      </div>
    </>
  );
}
