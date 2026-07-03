// PercentileBar — fleet-context percentile as a small horizontal bar + label.
// Percentile semantics come from the server (oriented so higher = healthier
// within the pool for metrics with a known worse-direction). For metrics
// without a direction (orientation 'value_order') the bar is neutral gray and
// the label says "by value" — no health claim.

function ordinal(n) {
  const v = Math.round(Number(n) || 0);
  const s = ['th', 'st', 'nd', 'rd'];
  const m = v % 100;
  return `${v}${s[(m - 20) % 10] || s[m] || s[0]}`;
}

function barColor(pct, oriented) {
  if (!oriented) return 'var(--color-text-secondary)';
  if (pct >= 67) return 'var(--color-success, #15803d)';
  if (pct >= 34) return 'var(--color-warning, #b45309)';
  return 'var(--color-danger, #b91c1c)';
}

export default function PercentileBar({ percentile, orientation }) {
  const pct = Math.max(0, Math.min(100, Number(percentile) || 0));
  const oriented = orientation === 'higher_is_better' || orientation === 'lower_is_better';
  const color = barColor(pct, oriented);
  const label = oriented ? `${ordinal(pct)}` : `${ordinal(pct)} by value`;
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 130 }}
      title={oriented
        ? `${ordinal(pct)} percentile of comparable units in this fleet pool (higher = healthier within the pool)`
        : `${ordinal(pct)} percentile by recorded value — no better/worse orientation is defined for this measurement`}
    >
      <span style={{ flex: '0 0 64px', height: 8, borderRadius: 999, background: 'color-mix(in srgb, var(--color-border) 55%, transparent)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${pct}%`, borderRadius: 999, background: color }} />
      </span>
      <span style={{ fontSize: '0.78rem', fontWeight: 600, color, whiteSpace: 'nowrap' }}>{label}</span>
    </span>
  );
}
