// BandChip — Watch / Plan / Act pill for the modernization pipeline. Bands are
// presentation groupings of the continuous modernization score (thresholds
// shipped by the server payload), not standards.

const META = {
  act:   { label: 'Act',   color: 'var(--color-danger, #b91c1c)',  bg: 'var(--color-danger-bg, rgba(220,38,38,0.10))' },
  plan:  { label: 'Plan',  color: 'var(--color-warning, #b45309)', bg: 'var(--color-warning-bg, rgba(245,158,11,0.12))' },
  watch: { label: 'Watch', color: 'var(--color-primary, #1d4ed8)', bg: 'color-mix(in srgb, var(--color-primary, #1d4ed8) 12%, transparent)' },
};

export default function BandChip({ band }) {
  const m = META[band];
  if (!m) return <span className="text-muted">—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.02em', whiteSpace: 'nowrap',
      background: m.bg, color: m.color,
      border: `1px solid color-mix(in srgb, ${m.color} 40%, transparent)`,
    }}>
      {m.label}
    </span>
  );
}
