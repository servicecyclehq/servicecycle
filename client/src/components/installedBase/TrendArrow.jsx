// TrendArrow — improving / stable / degrading marker for a benchmark row.
// Classification happens server-side with the SAME threshold + worse-direction
// constants the test-report ingest uses for its "trending … since last test"
// advisories, so this arrow and an ingest trend flag can never disagree.

const META = {
  degrading: { glyph: '↘', label: 'Degrading', color: 'var(--color-danger, #b91c1c)' },
  stable:    { glyph: '→', label: 'Stable',    color: 'var(--color-text-secondary)' },
  improving: { glyph: '↗', label: 'Improving', color: 'var(--color-success, #15803d)' },
};

export default function TrendArrow({ trend, deltaPct }) {
  const m = META[trend];
  if (!m) return <span className="text-muted" title="No prior reading of this measurement to trend against">—</span>;
  const delta = (deltaPct != null && trend !== null) ? ` ${deltaPct > 0 ? '+' : ''}${deltaPct}%` : '';
  return (
    <span
      style={{ color: m.color, fontWeight: 600, fontSize: '0.8rem', whiteSpace: 'nowrap' }}
      title={`${m.label} vs the prior reading of the same measurement${delta ? ` (${delta.trim()} change)` : ''}`}
    >
      <span aria-hidden="true">{m.glyph}</span> {m.label}{delta}
    </span>
  );
}
