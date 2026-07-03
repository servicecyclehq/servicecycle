// -----------------------------------------------------------------------------
// BulkReportRow.jsx -- one file's row in the bulk drop-zone queue.
//
// Renders the lifecycle of a single dropped PDF: pending (spinner) -> extracted
// (key-field summary + confidence chips + plausibility warnings + asset picker +
// include toggle) OR failed (error). Field-level correction lives in the
// existing single-report screen (/test-reports/import); this row exposes a
// minimal accept/reject with an asset picker inline, and a "Review in detail"
// escape hatch is offered by the parent when a file needs deeper edits.
//
// Presentational + controlled: all state (which asset, included?) is owned by the
// parent page and threaded down via props so the queue commits as one unit.
// Matches the CSS conventions of TestReportImport.jsx (PF colors, confidence
// chips, .input/.btn classes, card styling).
// -----------------------------------------------------------------------------

import { fmtDate } from '../../../lib/equipment';

const PF_COLORS = { GREEN: '#15803d', YELLOW: '#92400e', RED: '#b91c1c' };

function Spinner() {
  return (
    <span
      aria-label="Extracting"
      style={{
        display: 'inline-block', width: 14, height: 14, borderRadius: 999,
        border: '2px solid var(--color-border)', borderTopColor: 'var(--color-text-secondary)',
        animation: 'sc-spin 0.7s linear infinite',
      }}
    />
  );
}

// Compact RED/YELLOW/GREEN chip strip for a file's extracted summary.
function ConfidenceChips({ summary }) {
  if (!summary) return null;
  return (
    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
      <span style={{ color: PF_COLORS.RED, fontWeight: 700 }}>{summary.red} RED</span>
      {' · '}
      <span style={{ color: PF_COLORS.YELLOW, fontWeight: 700 }}>{summary.yellow} YELLOW</span>
      {' · '}
      {summary.green} GREEN
      {' · '}
      {summary.deficienciesToCreate} deficienc{summary.deficienciesToCreate === 1 ? 'y' : 'ies'}
    </span>
  );
}

export default function BulkReportRow({ entry, assets, onToggleInclude, onPickAsset, onReviewDetail }) {
  // entry: { status, filename, ... } (see BulkReportImportPage). The parent adds
  // client-only fields: include (bool), assetId (chosen), committed/commitError.
  const isMulti = !!(entry.sections && entry.sections.length > 1);
  const border = '1px solid var(--color-border)';

  // -- Pending (still uploading / extracting) --
  if (entry.status === 'pending') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: border }}>
        <Spinner />
        <span style={{ fontWeight: 600 }}>{entry.filename}</span>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Extracting…</span>
      </div>
    );
  }

  // -- Failed extraction --
  if (entry.status === 'failed') {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 14px', borderTop: border, background: '#fff1f1' }}>
        <span style={{ color: PF_COLORS.RED, fontWeight: 700, fontSize: 18, lineHeight: 1 }}>✕</span>
        <div>
          <div style={{ fontWeight: 600 }}>{entry.filename}</div>
          <div style={{ color: PF_COLORS.RED, fontSize: 'var(--font-size-sm)' }}>{entry.error || 'Could not read this file.'}</div>
        </div>
      </div>
    );
  }

  // -- Post-commit outcomes (rendered read-only in the results step) --
  if (entry.status === 'committed') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: border, background: 'var(--color-success-bg, #f0fdf4)' }}>
        <span style={{ color: '#15803d', fontWeight: 700, fontSize: 16, lineHeight: 1 }}>✓</span>
        <span style={{ fontWeight: 600 }}>{entry.filename}</span>
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          {entry.measurementsCreated} readings, {entry.deficienciesCreated} deficienc{entry.deficienciesCreated === 1 ? 'y' : 'ies'}
        </span>
        {entry.assetId && (
          <a href={`/assets/${entry.assetId}`} className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }}>View asset →</a>
        )}
      </div>
    );
  }
  if (entry.status === 'commit-failed') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderTop: border, background: '#fff1f1' }}>
        <span style={{ color: PF_COLORS.RED, fontWeight: 700, fontSize: 16, lineHeight: 1 }}>✕</span>
        <span style={{ fontWeight: 600 }}>{entry.filename}</span>
        <span style={{ color: PF_COLORS.RED, fontSize: 'var(--font-size-sm)' }}>{entry.error || 'Commit failed'}</span>
      </div>
    );
  }

  // -- Extracted: reviewable row (default) --
  const meta = entry.meta || {};
  const flags = Array.isArray(entry.plausibilityFlags) ? entry.plausibilityFlags : [];
  const readingCount = Array.isArray(entry.measurements) ? entry.measurements.length : 0;
  const matchLabel = entry.assetMatch ? entry.assetMatch.label : null;

  return (
    <div style={{ padding: '12px 14px', borderTop: border, background: entry.include ? 'transparent' : 'var(--color-bg-subtle, #f8fafc)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <input
          type="checkbox"
          checked={!!entry.include}
          onChange={() => onToggleInclude(entry.id)}
          style={{ marginTop: 3 }}
          aria-label={`Include ${entry.filename}`}
        />
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {entry.filename}
            {isMulti && (
              <span style={{ fontSize: 'var(--font-size-xs)', color: '#3730a3', background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '1px 6px' }}>
                {entry.sections.length} assets
              </span>
            )}
            {entry.ocr && (
              <span style={{ fontSize: 'var(--font-size-xs)', color: '#1d4ed8', background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '1px 6px' }}>OCR</span>
            )}
            {entry.aiUsed && (
              <span style={{ fontSize: 'var(--font-size-xs)', color: '#7e22ce', background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 6, padding: '1px 6px' }}>AI</span>
            )}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {readingCount} reading{readingCount === 1 ? '' : 's'}
            {meta.serialNumber ? ` · SN ${meta.serialNumber}` : ''}
            {meta.testDate ? ` · ${fmtDate(meta.testDate)}` : ''}
          </div>
          <div style={{ marginTop: 4 }}><ConfidenceChips summary={entry.summary} /></div>

          {/* #5 dedupe warning */}
          {entry.priorImport && (
            <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: PF_COLORS.RED }}>
              ⚠ Already imported{entry.priorImport.importedAt ? ` on ${fmtDate(entry.priorImport.importedAt)}` : ''} — committing again duplicates readings.
            </div>
          )}
          {/* #2 truncation warning */}
          {entry.truncated && (
            <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: '#92400e' }}>
              Coverage partial — later pages weren't parsed; some readings may be missing.
            </div>
          )}
          {/* Plausibility gate warnings */}
          {flags.length > 0 && (
            <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: '#92400e' }}>
              {flags.length} reading{flags.length === 1 ? '' : 's'} failed a data-sanity check:
              {' '}{flags.slice(0, 3).map((f) => `${f.label}${f.phase ? ` (Ph ${f.phase})` : ''}`).join(', ')}{flags.length > 3 ? '…' : ''}
            </div>
          )}
        </div>

        <div style={{ flex: '1 1 240px', minWidth: 220 }}>
          {isMulti ? (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              Multi-asset report ({entry.sections.length} sections). Commit these on the single-report screen so each section can be matched to its own asset; they're excluded from the one-click batch.
            </div>
          ) : (
            <>
              <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Attach to asset</label>
              <select
                className="input"
                value={entry.assetId || ''}
                onChange={(e) => onPickAsset(entry.id, e.target.value)}
                style={{ width: '100%' }}
              >
                <option value="">— select asset —</option>
                {entry.assetCandidates && entry.assetCandidates.length > 0 && (
                  <optgroup label="Suggested matches">
                    {entry.assetCandidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}{c.serialNumber ? ` · ${c.serialNumber}` : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="All assets">
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}{a.serial ? ` · ${a.serial}` : ''}</option>
                  ))}
                </optgroup>
              </select>
              {matchLabel && entry.assetId === (entry.assetMatch && entry.assetMatch.id) && (
                <div style={{ fontSize: 11, color: '#15803d', marginTop: 3 }}>
                  Suggested: {matchLabel}{entry.assetMatch.reason ? ` (${String(entry.assetMatch.reason).replace(/_/g, ' ')})` : ''}
                </div>
              )}
              {!matchLabel && meta.serialNumber && (
                <div style={{ fontSize: 11, color: '#92400e', marginTop: 3 }}>No asset matched SN {meta.serialNumber} — pick one.</div>
              )}
            </>
          )}
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            style={{ marginTop: 8 }}
            onClick={() => onReviewDetail(entry)}
          >
            {entry.expanded ? 'Hide readings' : `Review ${readingCount} reading${readingCount === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>

      {/* Inline read-only readings table (triage view — verify before commit). */}
      {entry.expanded && readingCount > 0 && (
        <div style={{ marginTop: 10, overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 'var(--font-size-sm)', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-secondary)' }}>
                <th style={{ padding: '2px 8px 2px 0' }}>Measurement</th>
                <th style={{ padding: '2px 8px' }}>Ph</th>
                <th style={{ padding: '2px 8px' }}>Value</th>
                <th style={{ padding: '2px 8px' }}>Expected</th>
                <th style={{ padding: '2px 8px' }}>Result</th>
              </tr>
            </thead>
            <tbody>
              {entry.measurements.map((m, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '3px 8px 3px 0' }}>{m.label || m.measurementType}</td>
                  <td style={{ padding: '3px 8px' }}>{m.phase || '—'}</td>
                  <td style={{ padding: '3px 8px' }}>{m.asFoundValue != null ? m.asFoundValue : '—'} {m.asFoundUnit || ''}</td>
                  <td style={{ padding: '3px 8px', color: 'var(--color-text-secondary)' }}>{m.expectedRange || '—'}</td>
                  <td style={{ padding: '3px 8px', color: PF_COLORS[m.passFail] || 'inherit', fontWeight: m.passFail ? 700 : 400 }}>{m.passFail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
