// ThinPoolBadge — honesty marker for benchmark pools below the comparison
// threshold (server-flagged, < 8 comparable units): the percentile is shown
// as directional context only, never as precision.

export default function ThinPoolBadge({ poolSize }) {
  return (
    <span
      style={{
        display: 'inline-block', padding: '1px 7px', borderRadius: 999,
        fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap',
        background: 'var(--color-warning-bg, rgba(245,158,11,0.12))',
        color: 'var(--color-warning, #b45309)',
        border: '1px solid color-mix(in srgb, var(--color-warning, #b45309) 40%, transparent)',
      }}
      title={`Only ${poolSize} comparable unit${poolSize === 1 ? '' : 's'} in this pool — treat the percentile as directional, not precise.`}
    >
      small pool — directional only
    </span>
  );
}
