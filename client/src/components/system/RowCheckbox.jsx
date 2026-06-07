// client/src/components/system/RowCheckbox.jsx
// ─────────────────────────────────────────────────────────────
// v0.91 system primitive — labelled row-checkbox.
//
// Direct fix for the v0.90.9 baseline finding: /budget rendered
// 285 unlabelled <input type="checkbox"> nodes (axe `label`
// violation, critical impact). The fix isn't 285 manual edits —
// it's one extracted primitive that bakes the label association
// into the row pattern, so it can never regress.
//
// Pattern (typical bulk-select table cell):
//   <td>
//     <RowCheckbox
//       checked={selected.has(row.id)}
//       onChange={(e) => toggleRow(row.id, e.target.checked)}
//       label={`Select ${row.vendor.name} — ${row.product}`}
//     />
//   </td>
//
// Pattern (table-header select-all with tri-state):
//   <th>
//     <RowCheckbox
//       checked={allSelected}
//       indeterminate={anySelected && !allSelected}
//       onChange={toggleSelectAll}
//       label="Select all visible rows"
//     />
//   </th>
//
// The label is rendered as a visually-hidden span (sr-only) so
// the row's actual visible content stays compact, but the
// checkbox is properly labelled for screen readers — and the
// label updates dynamically per row so each control announces
// what it acts on.
//
// If you want the label visible (e.g. opt-in checkboxes in a
// settings form), pass `visibleLabel` instead of `label`.
//
// `indeterminate` is a DOM property (not an HTML attribute or
// React prop), so we sync it via useEffect against an internal
// ref. Passing indeterminate={true} renders the tri-state dash.
// ─────────────────────────────────────────────────────────────

import { useId, useRef, useEffect } from 'react';

export default function RowCheckbox({
  checked,
  defaultChecked,
  indeterminate = false,
  onChange,
  disabled = false,
  label,           // sr-only label (most common case — table row checkboxes)
  visibleLabel,    // visible label adjacent to checkbox (settings-form case)
  className,
  style,
  ...rest
}) {
  const id = useId();
  const ref = useRef(null);
  const accessibleLabel = visibleLabel || label;

  // indeterminate is a DOM property, not a React prop — sync via ref/effect.
  useEffect(() => {
    if (ref.current) {
      ref.current.indeterminate = !!indeterminate;
    }
  }, [indeterminate]);

  if (!accessibleLabel && process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error('[RowCheckbox] missing required `label` or `visibleLabel` prop — a11y violation.');
  }

  const input = (
    <input
      ref={ref}
      id={id}
      type="checkbox"
      checked={checked}
      defaultChecked={defaultChecked}
      onChange={onChange}
      disabled={disabled}
      aria-label={visibleLabel ? undefined : accessibleLabel}
      {...rest}
    />
  );

  if (visibleLabel) {
    return (
      <label
        htmlFor={id}
        className={['lq-row-checkbox', className].filter(Boolean).join(' ')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'var(--space-2, 8px)',
          fontSize: 'var(--font-size-body, 14px)',
          fontWeight: 'var(--font-weight-regular, 400)',
          color: disabled ? 'var(--color-text-faint)' : 'var(--color-ink)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          ...style,
        }}
      >
        {input}
        <span>{visibleLabel}</span>
      </label>
    );
  }

  // sr-only label path: input renders bare, screen reader gets the
  // label via aria-label baked above.
  return (
    <span
      className={['lq-row-checkbox-bare', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        ...style,
      }}
    >
      {input}
    </span>
  );
}
