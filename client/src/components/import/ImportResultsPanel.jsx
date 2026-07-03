// -----------------------------------------------------------------------------
// ImportResultsPanel.jsx -- step-3 results for the SMART asset importer
// (pages/ImportAssetsPage.jsx -> POST /api/import/assets/commit).
//
// Renders the per-row outcomes the server returned (created |
// skipped_duplicate | error), the headline counts, and a "download error
// rows" button that rebuilds a CSV of just the failed rows (original cells +
// row number + error messages) so the user can fix and re-import only what
// failed -- duplicates are skipped automatically on re-run, so re-importing
// the corrected file is safe.
// -----------------------------------------------------------------------------

import { Link } from 'react-router-dom';
import { CheckCircle2, Download } from 'lucide-react';

const OUTCOME_STYLES = {
  created: {
    label: 'Created',
    color: 'var(--color-success, #16a34a)',
    background: 'var(--color-success-bg, #f0fdf4)',
  },
  skipped_duplicate: {
    label: 'Skipped (duplicate)',
    color: 'var(--color-warning, #d97706)',
    background: 'var(--color-warning-bg, #fffbeb)',
  },
  error: {
    label: 'Error',
    color: 'var(--color-danger, #dc2626)',
    background: 'var(--color-danger-bg, #fef2f2)',
  },
};

function OutcomeBadge({ outcome }) {
  const s = OUTCOME_STYLES[outcome] || OUTCOME_STYLES.error;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 'var(--font-size-xs, 11px)', fontWeight: 600, whiteSpace: 'nowrap',
      color: s.color, background: s.background,
    }}>
      {s.label}
    </span>
  );
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Build and download a CSV of the ERROR rows only: original columns first,
 * then Row (spreadsheet row number) and Errors (joined messages).
 *
 * Server row numbers are 1-indexed + header, so outcome.row N maps back to
 * rows[N - 2].
 */
function downloadErrorRowsCsv(headers, rows, outcomes) {
  const errorOutcomes = outcomes.filter((o) => o.outcome === 'error');
  if (errorOutcomes.length === 0) return;
  const lines = [[...headers, 'Row', 'Errors'].map(csvEscape).join(',')];
  for (const o of errorOutcomes) {
    const original = rows[o.row - 2] || {};
    const msg = Array.isArray(o.errors) ? o.errors.map((e) => e.error).join('; ') : (o.reason || 'Error');
    lines.push([...headers.map((h) => csvEscape(original[h])), o.row, csvEscape(msg)].join(','));
  }
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'import-error-rows.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function outcomeDetail(o) {
  if (o.outcome === 'created') return 'Asset created';
  if (o.outcome === 'skipped_duplicate') return o.reason || 'Duplicate of an existing asset';
  if (Array.isArray(o.errors)) return o.errors.map((e) => e.error).join('; ');
  return o.reason || 'Error';
}

const MAX_OUTCOME_ROWS = 50;

/**
 * @param result  commit response data: { created, skippedDuplicates,
 *                errorCount, sitesCreated, outcomes: [...] }
 * @param headers original file headers (for the error CSV)
 * @param rows    original parsed rows (echoed through /preview)
 * @param onReset "import another file"
 */
export default function ImportResultsPanel({ result, headers, rows, onReset }) {
  const outcomes = result.outcomes || [];
  const errorRows = outcomes.filter((o) => o.outcome === 'error');

  return (
    <div className="card" style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <CheckCircle2 size={24} strokeWidth={1.75} style={{ color: 'var(--color-success)' }} />
        <h2 style={{ fontSize: 'var(--font-size-lg, 18px)', margin: 0 }}>Import finished</h2>
      </div>

      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-success)' }}>{result.created}</div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>created</div>
        </div>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--color-warning, #d97706)' }}>{result.skippedDuplicates}</div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>skipped (duplicates)</div>
        </div>
        <div>
          <div style={{ fontSize: 28, fontWeight: 700, color: result.errorCount > 0 ? 'var(--color-danger)' : 'var(--color-text)' }}>{result.errorCount}</div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>errored</div>
        </div>
        {result.sitesCreated > 0 && (
          <div>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{result.sitesCreated}</div>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>sites created</div>
          </div>
        )}
      </div>

      {result.skippedDuplicates > 0 && (
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
          Duplicates are matched by serial number (typo-tolerant) or by site + type + manufacturer/model/position,
          so re-running the same file never double-imports.
        </div>
      )}

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <table>
          <thead>
            <tr>
              <th style={{ width: 60 }}>Row</th>
              <th style={{ width: 150 }}>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {outcomes.slice(0, MAX_OUTCOME_ROWS).map((o) => (
              <tr key={o.row}>
                <td className="td-muted">{o.row}</td>
                <td><OutcomeBadge outcome={o.outcome} /></td>
                <td style={{ fontSize: 'var(--font-size-sm)', whiteSpace: 'normal', color: o.outcome === 'error' ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>
                  {outcomeDetail(o)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {outcomes.length > MAX_OUTCOME_ROWS && (
          <div style={{ marginTop: 8, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
            ...and {outcomes.length - MAX_OUTCOME_ROWS} more rows (download the error CSV for the full list).
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link to="/assets" className="btn btn-primary">Go to assets</Link>
        {errorRows.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => downloadErrorRowsCsv(headers, rows, outcomes)}
          >
            <Download size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Download {errorRows.length} error row{errorRows.length !== 1 ? 's' : ''} (CSV)
          </button>
        )}
        <button type="button" className="btn btn-secondary" onClick={onReset}>
          Import another file
        </button>
      </div>
    </div>
  );
}
