// client/src/components/system/FormField.jsx
// ─────────────────────────────────────────────────────────────
// v0.91 system primitive — labelled form-field wrapper.
//
// Resolves the axe `label` and `select-name` violations the
// v0.90.9 baseline + the locked mockup audits flagged. Every
// <input>, <select>, and <textarea> in the product ships
// through this wrapper so the label-input association is
// structurally guaranteed.
//
// Pattern:
//   <FormField label="Email" helper="We'll send confirmation here">
//     <input type="email" autoComplete="email" />
//   </FormField>
//
// The label is rendered as a real <label htmlFor={id}>, the
// input gets a matching id (auto-generated if not provided),
// and helper/error text is wired via aria-describedby /
// aria-invalid so assistive tech announces both correctly.
//
// Cohesion notes:
//   - All visual styling pulls from tokens.css — no raw hex.
//   - Spacing uses the 4px scale (var(--space-*)).
//   - Required marker is rendered visually (text-danger asterisk)
//     and announced via aria-required on the cloned input.
// ─────────────────────────────────────────────────────────────

import { Children, cloneElement, isValidElement, useId } from 'react';

export default function FormField({
  label,
  helper,
  error,
  required = false,
  children,
  className,
  style,
}) {
  const autoId = useId();
  const helperId = helper ? `${autoId}-helper` : null;
  const errorId = error ? `${autoId}-error` : null;
  const describedBy = [errorId, helperId].filter(Boolean).join(' ') || undefined;

  // Take exactly one child — the input/select/textarea — and inject
  // id + aria-* attributes. If consumer already set an id, respect it.
  const child = Children.only(children);
  if (!isValidElement(child)) {
    // Defensive: if a consumer wraps a non-element in FormField, render
    // the label but let the child be whatever it is. Don't throw.
    return (
      <div className={className} style={style}>
        {label && <label>{label}{required ? <Asterisk /> : null}</label>}
        {children}
      </div>
    );
  }

  const childId = child.props.id || autoId;
  const enriched = cloneElement(child, {
    id: childId,
    'aria-describedby': describedBy,
    'aria-invalid': error ? 'true' : child.props['aria-invalid'],
    'aria-required': required ? 'true' : child.props['aria-required'],
    required: required || child.props.required,
  });

  return (
    <div
      className={['lq-form-field', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2, 8px)',
        ...style,
      }}
    >
      {label && (
        <label
          htmlFor={childId}
          style={{
            fontSize: 'var(--font-size-small, 12px)',
            fontWeight: 'var(--font-weight-medium, 500)',
            color: 'var(--color-ink)',
            lineHeight: 'var(--leading-snug, 1.3)',
          }}
        >
          {label}
          {required ? <Asterisk /> : null}
        </label>
      )}

      {enriched}

      {helper && !error && (
        <span
          id={helperId}
          style={{
            fontSize: 'var(--font-size-small, 12px)',
            fontWeight: 'var(--font-weight-regular, 400)',
            color: 'var(--color-text-muted)',
            lineHeight: 'var(--leading-normal, 1.55)',
          }}
        >
          {helper}
        </span>
      )}

      {error && (
        <span
          id={errorId}
          role="alert"
          style={{
            fontSize: 'var(--font-size-small, 12px)',
            fontWeight: 'var(--font-weight-medium, 500)',
            color: 'var(--color-danger)',
            lineHeight: 'var(--leading-normal, 1.55)',
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

function Asterisk() {
  return (
    <span
      aria-hidden="true"
      style={{
        color: 'var(--color-danger)',
        marginLeft: 4,
        fontWeight: 'var(--font-weight-medium, 500)',
      }}
    >
      *
    </span>
  );
}
