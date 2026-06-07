// S2-FN-04 (v0.75.1): warn when server capped the result set at REPORT_QUERY_CAP rows.
export default function TruncationBanner({ meta }) {
  if (!meta?.truncated) return null;
  const count = meta.returnedCount ?? '?';
  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: 10,
      padding: '10px 16px',
      marginBottom: 16,
      borderRadius: 8,
      background: '#fffbeb',
      border: '1px solid #fcd34d',
      color: '#92400e',
      fontSize: 'var(--font-size-ui)',
      lineHeight: 1.5,
    }}>
      <span style={{ fontSize: 'var(--font-size-base)', marginTop: 1 }}>&#x26A0;&#xFE0F;</span>
      <span>
        <strong>Report capped at {count} rows.</strong>{' '}
        Your dataset exceeds the report limit. Use CSV or XLSX export for the full dataset.
      </span>
    </div>
  );
}