// -----------------------------------------------------------------------------
// MappingReviewTable.jsx -- step-2 column-mapping review for the SMART asset
// importer (pages/ImportAssetsPage.jsx -> /api/import/assets).
//
// One row per spreadsheet column: column name, provenance chip (how the
// mapping was proposed -- exact / synonym / AI / manual, with confidence),
// up to three sample values, and a target-field dropdown (core fields +
// the account's custom fields; "Ignore" unmaps).
//
// Presentational only -- the page owns state and re-validates against the
// server on every change (server is the source of truth for validation).
// -----------------------------------------------------------------------------

// Chip palette per mapping source. Colors follow the app convention of CSS
// variables with hex fallbacks so both themes stay legible.
const CHIP_STYLES = {
  exact: {
    label: 'Exact',
    background: 'var(--color-success-bg, #f0fdf4)',
    color: 'var(--color-success, #16a34a)',
    border: '1px solid var(--color-success-border, #bbf7d0)',
  },
  synonym: {
    label: 'Synonym',
    background: 'var(--color-primary-bg, #eff6ff)',
    color: 'var(--color-primary, #2563eb)',
    border: '1px solid var(--color-primary-border, #bfdbfe)',
  },
  ai: {
    label: 'AI',
    background: 'var(--color-ai-bg, #f5f3ff)',
    color: 'var(--color-ai, #7c3aed)',
    border: '1px solid var(--color-ai-border, #ddd6fe)',
  },
  user: {
    label: 'Manual',
    background: 'var(--color-bg-secondary, #f1f5f9)',
    color: 'var(--color-text, #0f172a)',
    border: '1px solid var(--color-border, #cbd5e1)',
  },
  unmapped: {
    label: 'Unmapped',
    background: 'var(--color-bg-secondary, #f8fafc)',
    color: 'var(--color-text-secondary, #64748b)',
    border: '1px dashed var(--color-border, #cbd5e1)',
  },
};

export function ConfidenceChip({ source, confidence }) {
  const kind = source && CHIP_STYLES[source] ? source : 'unmapped';
  const s = CHIP_STYLES[kind];
  const pct = kind === 'unmapped' || confidence == null ? null : Math.round(confidence * 100);
  return (
    <span
      title={pct == null ? 'No mapping proposed' : `Mapping confidence ${pct}%`}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 'var(--font-size-xs, 11px)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        background: s.background,
        color: s.color,
        border: s.border,
      }}
    >
      {s.label}{pct != null && kind !== 'exact' && kind !== 'user' ? ` ${pct}%` : ''}
    </span>
  );
}

/**
 * @param headers      string[] -- spreadsheet columns, in file order
 * @param mapInfo      { [header]: { field, confidence, source } }
 * @param targetFields [{ key, label, required }] -- dropdown vocabulary
 * @param samplesByHeader { [header]: string[] } -- up to 3 sample values
 * @param busy         disables the dropdowns while a re-validate is in flight
 * @param onChangeField (header, fieldKeyOrNull) => void
 */
export default function MappingReviewTable({ headers, mapInfo, targetFields, samplesByHeader, busy, onChangeField }) {
  return (
    <div className="table-wrap" style={{ marginBottom: 16 }}>
      <table>
        <thead>
          <tr>
            <th>File column</th>
            <th>Detected</th>
            <th>Sample values</th>
            <th>Imports as</th>
          </tr>
        </thead>
        <tbody>
          {headers.map((h) => {
            const info = mapInfo[h] || { field: null, confidence: 0, source: null };
            const samples = samplesByHeader[h] || [];
            return (
              <tr key={h}>
                <td style={{ fontWeight: 600, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {h}
                </td>
                <td>
                  <ConfidenceChip source={info.field ? info.source : null} confidence={info.confidence} />
                </td>
                <td className="td-muted" style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--font-size-sm)' }}>
                  {samples.length > 0 ? samples.join(' | ') : <span className="text-muted">(empty)</span>}
                </td>
                <td>
                  <select
                    className="filter-select"
                    aria-label={`Map column ${h}`}
                    value={info.field || ''}
                    disabled={busy}
                    onChange={(e) => onChangeField(h, e.target.value || null)}
                  >
                    <option value="">- Ignore -</option>
                    {targetFields.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.label}{f.required ? ' *' : ''}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
