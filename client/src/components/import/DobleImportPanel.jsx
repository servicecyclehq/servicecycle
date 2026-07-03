// ─────────────────────────────────────────────────────────────────────────────
// DobleImportPanel.jsx — Doble (TestGuide / TDMS / ProTest) test-data import.
//
// The neutral-reader on-ramp for the OTHER major ecosystem. PowerDB (Megger)
// data already imports via the PDF test-report path; this panel reads a Doble
// export (XML or CSV table) and commits its transformer readings — power factor
// / tan-delta, TTR, DGA — into the SAME unified pool, so year-over-year drift
// analysis, measurement views and Installed-Base queries treat Doble and
// Megger data as one body of history. (Doble + Megger merged under ESCO in
// April 2026; reading both neutrally is core positioning.)
//
// Flow: Upload → Preview (per-asset fuzzy match + confidence, counts, issues,
// duplicate flag) → tick which matched assets to import → Commit (results).
//
// Server: POST /api/doble/import/preview | /api/doble/import/commit
// Props: { onChanged? }  — called after a successful commit.
// ─────────────────────────────────────────────────────────────────────────────

import { useRef, useState } from 'react';
import api from '../../api/client';

const ACCEPT = '.xml,.csv';

const CONF = {
  high:   { c: 'var(--chip-green-fg)', label: 'high' },
  medium: { c: 'var(--chip-amber-fg)', label: 'medium' },
  low:    { c: 'var(--color-text-secondary)', label: 'low' },
};

function MatchBadge({ match }) {
  if (!match?.best) {
    return <span style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>no match — will create new</span>;
  }
  const conf = CONF[match.best.confidence] || CONF.low;
  return (
    <span style={{ fontSize: 12 }}>
      <strong>{match.best.label || match.best.serialNumber || 'Asset'}</strong>
      {' '}
      <span style={{ color: conf.c, fontWeight: 700 }}>{conf.label}</span>
      <span style={{ color: 'var(--color-text-secondary)' }}> ({match.best.reason})</span>
    </span>
  );
}

export default function DobleImportPanel({ onChanged }) {
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [step, setStep] = useState(1); // 1 upload · 2 preview · 3 results
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState({});   // assetKey -> bool
  const [result, setResult] = useState(null);

  function reset() {
    setFile(null); setStep(1); setMsg(null); setPreview(null);
    setSelected({}); setResult(null);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function doPreview() {
    if (!file) { setMsg('Choose a Doble .xml or .csv export first.'); return; }
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/api/doble/import/preview', fd);
      const d = r.data.data;
      setPreview(d);
      // Default-select assets that matched and aren't already imported.
      const sel = {};
      for (const a of d.assets || []) {
        sel[a.assetKey] = !!(a.match?.best && !a.alreadyImported);
      }
      setSelected(sel);
      setStep(2);
    } catch (err) {
      setMsg(err?.response?.data?.error || 'Could not read that Doble file.');
    } finally { setBusy(false); }
  }

  async function doCommit() {
    if (!preview) return;
    const matches = (preview.assets || [])
      .filter((a) => selected[a.assetKey] && a.match?.best?.id)
      .map((a) => ({ assetKey: a.assetKey, assetId: a.match.best.id }));
    if (!matches.length) { setMsg('Tick at least one matched asset to import.'); return; }
    setBusy(true); setMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('matches', JSON.stringify(matches));
      const r = await api.post('/api/doble/import/commit', fd);
      setResult(r.data.data);
      setStep(3);
      onChanged && onChanged();
    } catch (err) {
      setMsg(err?.response?.data?.error || 'Import failed.');
    } finally { setBusy(false); }
  }

  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="card-title" style={{ flex: 1 }}>Import Doble test data</div>
        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>TestGuide / TDMS · XML or CSV</span>
      </div>

      <div className="card-body">
        {/* Step 1 — upload */}
        {step === 1 && (
          <div>
            <p style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 0 }}>
              Upload a Doble export (power factor / tan-delta, TTR, DGA). Readings land in the
              same pool as your PowerDB and PDF imports, so trends compare across both.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              onChange={(e) => { setFile(e.target.files?.[0] || null); setMsg(null); }}
              style={{ fontSize: 13, marginBottom: 12, display: 'block' }}
            />
            {msg && <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--chip-red-fg)' }}>{msg}</div>}
            <button className="btn btn-primary btn-sm" disabled={busy || !file} onClick={doPreview}>
              {busy ? 'Reading…' : 'Preview import'}
            </button>
          </div>
        )}

        {/* Step 2 — preview */}
        {step === 2 && preview && (
          <div>
            <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
              Detected <strong>{String(preview.format).toUpperCase()}</strong> ({preview.schemaVersion}) ·
              {' '}{preview.assetCount} assets · {preview.testCount} tests · {preview.measurementCount} readings
            </div>
            {(preview.fileIssues || []).length > 0 && (
              <ul style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12, color: 'var(--chip-amber-fg)' }}>
                {preview.fileIssues.map((iss, i) => <li key={i}>{iss}</li>)}
              </ul>
            )}

            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ padding: '6px 8px' }}>Import</th>
                    <th style={{ padding: '6px 8px' }}>Asset (from file)</th>
                    <th style={{ padding: '6px 8px' }}>Match</th>
                    <th style={{ padding: '6px 8px' }}>Tests / readings</th>
                    <th style={{ padding: '6px 8px' }}>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.assets.map((a) => {
                    const canImport = !!a.match?.best?.id;
                    return (
                      <tr key={a.assetKey} style={{ borderBottom: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '6px 8px' }}>
                          <input
                            type="checkbox"
                            disabled={!canImport}
                            checked={!!selected[a.assetKey]}
                            onChange={(e) => setSelected((p) => ({ ...p, [a.assetKey]: e.target.checked }))}
                          />
                        </td>
                        <td style={{ padding: '6px 8px' }}>
                          <div style={{ fontWeight: 600 }}>{a.identity.serialNumber || a.assetKey}</div>
                          <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                            {[a.identity.manufacturer, a.identity.model, a.identity.location].filter(Boolean).join(' · ')}
                          </div>
                        </td>
                        <td style={{ padding: '6px 8px' }}><MatchBadge match={a.match} /></td>
                        <td style={{ padding: '6px 8px' }}>{a.testCount} / {a.measurementCount}</td>
                        <td style={{ padding: '6px 8px', fontSize: 11 }}>
                          {a.alreadyImported && <div style={{ color: 'var(--chip-amber-fg)' }}>already imported</div>}
                          {(a.issues || []).map((iss, i) => (
                            <div key={i} style={{ color: 'var(--color-text-secondary)' }}>{iss}</div>
                          ))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {msg && <div style={{ margin: '10px 0', fontSize: 13, color: 'var(--chip-red-fg)' }}>{msg}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-secondary btn-sm" disabled={busy} onClick={reset}>Cancel</button>
              <button className="btn btn-primary btn-sm" disabled={busy || selectedCount === 0} onClick={doCommit}>
                {busy ? 'Importing…' : `Import ${selectedCount} asset${selectedCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}

        {/* Step 3 — results */}
        {step === 3 && result && (
          <div>
            <div style={{ fontSize: 14, marginBottom: 8 }}>
              <strong style={{ color: 'var(--chip-green-fg)' }}>Imported {result.committed} asset{result.committed === 1 ? '' : 's'}</strong>
              {' · '}{result.measurementsCreated} readings
              {result.deficienciesCreated ? ` · ${result.deficienciesCreated} findings flagged` : ''}
              {result.skippedDuplicates ? ` · ${result.skippedDuplicates} skipped (duplicate)` : ''}
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                <tbody>
                  {(result.outcomes || []).map((o, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '5px 8px', fontWeight: 600 }}>{o.assetKey}</td>
                      <td style={{ padding: '5px 8px', color:
                        o.status === 'committed' ? 'var(--chip-green-fg)'
                        : o.status === 'skipped' ? 'var(--chip-amber-fg)'
                        : 'var(--chip-red-fg)' }}>
                        {o.status === 'committed'
                          ? `${o.measurementsCreated} readings${o.created ? ' (new asset)' : ''}`
                          : (o.reason || o.error || o.status)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={reset}>Import another file</button>
          </div>
        )}
      </div>
    </div>
  );
}
