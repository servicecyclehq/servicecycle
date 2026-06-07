/**
 * BriefCategoryBadge — small chip showing the category the AI renewal
 * brief was generated against.
 *
 * Phase 4 — v0.4.0. Rendered next to the brief title in
 * ContractDetail.jsx. The icon + color come from the Category row
 * (admin can customise per-account in Settings → Categories).
 */

export default function BriefCategoryBadge({ slug, name, icon, color }) {
  if (!slug && !name) return null;
  const displayName = name || slug;
  return (
    <span
      title={`Brief template: ${slug}`}
      style={{
        display:        'inline-flex',
        alignItems:     'center',
        gap:            4,
        padding:        '2px 8px',
        borderRadius:   12,
        fontSize:       '0.75rem',
        fontWeight:     500,
        // Soft background tint from the category's color if available;
        // else a neutral grey. Falls back gracefully when color is null.
        background:     color ? `${color}22` : 'var(--color-surface-alt, #f3f4f6)',
        color:          color || 'var(--text-secondary, #555)',
        border:         `1px solid ${color ? `${color}55` : 'var(--color-border, #e1e1e1)'}`,
        verticalAlign:  'middle',
      }}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      <span>{displayName}</span>
    </span>
  );
}
