import { useEffect, useState } from 'react';
import api from '../api/client';

/**
 * Shared renderer for admin-defined custom fields. Drop into NewContract
 * and ContractDetail to surface every active definition as a form input.
 *
 * Props:
 *   - values:      { [fieldKey]: string }  — current form state
 *   - onChange:    (fieldKey, value) => void
 *   - categoryId   (optional): the contract's selected category ID.
 *                  When provided, only fields scoped to that category
 *                  (def.categoryId === categoryId) OR global fields
 *                  (def.categoryId === null) are rendered.
 *                  When omitted/undefined, ALL active fields are shown
 *                  (backward-compat for callers that don't know the cat).
 *   - existingValues (optional): array of { definitionId, value, definition }
 *                  from GET /api/contracts/:id, so the edit form starts
 *                  pre-populated. Internally merged into `values` once.
 *   - disabled (optional)
 *
 * Empty-state: if there are no relevant active fields, returns null so the
 * form doesn't get an awkward "Custom Fields" section header pointing at
 * nothing. The new-contract form thus only shows the section when an admin
 * has actually defined fields (and those fields match the selected category).
 *
 * Archived fields with existing values render in a separate read-only
 * block so an admin retiring a field doesn't erase what's already there.
 */

export default function CustomFieldInputs({ values, onChange, existingValues, disabled, categoryId }) {
  const [definitions, setDefinitions] = useState(null);
  const [error, setError] = useState(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/custom-fields')
      .then(r => { if (!cancelled) setDefinitions(r.data.data?.fields || []); })
      .catch(() => { if (!cancelled) setError('Could not load custom fields.'); });
    return () => { cancelled = true; };
  }, []);

  // Hydrate from existingValues once when both arrive — don't overwrite
  // user edits if it loads later.
  useEffect(() => {
    if (hydrated || !definitions || !existingValues) return;
    const byDef = new Map(definitions.map(d => [d.id, d]));
    for (const v of existingValues) {
      const def = byDef.get(v.definitionId) || v.definition;
      if (!def) continue;
      if (values[def.fieldKey] === undefined && v.value != null) {
        onChange(def.fieldKey, v.value);
      }
    }
    setHydrated(true);
  }, [definitions, existingValues, hydrated, values, onChange]);

  // Re-run hydration when categoryId changes (user switches category on edit
  // form) so any pre-filled values for the new category surface immediately.
  useEffect(() => {
    if (!categoryId) return;
    setHydrated(false);
  }, [categoryId]);

  if (error) return <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)' }}>{error}</div>;
  if (!definitions) return null;

  // Filter active fields: show global fields (categoryId === null) plus
  // fields specifically scoped to the selected category. When no categoryId
  // is provided show everything (backward-compat).
  const active = definitions.filter(d => {
    if (d.archivedAt) return false;
    if (categoryId === undefined || categoryId === null || categoryId === '') return true;
    return d.categoryId === null || d.categoryId === categoryId;
  });

  const archivedWithValues = definitions.filter(d => d.archivedAt && existingValues?.some(v => v.definitionId === d.id && v.value));

  if (active.length === 0 && archivedWithValues.length === 0) return null;

  return (
    <div style={{ marginTop: 24 }}>
      <h3 style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, marginBottom: 4, color: 'var(--color-text)' }}>
        Custom Fields
      </h3>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
        Defined by your admin in Settings → Custom Fields.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
        {active.map(def => (
          <CustomFieldInput
            key={def.id}
            def={def}
            value={values[def.fieldKey] ?? ''}
            onChange={(v) => onChange(def.fieldKey, v)}
            disabled={disabled}
          />
        ))}
      </div>

      {archivedWithValues.length > 0 && (
        <div style={{ marginTop: 16, padding: 12, background: 'var(--color-surface)', border: '1px dashed var(--color-border-strong)', borderRadius: 6 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.05 }}>
            Archived custom fields (read-only)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {archivedWithValues.map(def => {
              const v = existingValues.find(x => x.definitionId === def.id);
              return (
                <div key={def.id}>
                  <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 2 }}>{def.name}</div>
                  <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>{v?.value || '—'}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomFieldInput({ def, value, onChange, disabled }) {
  const labelStyle = { display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 4 };
  const inputStyle = {
    width: '100%', padding: '7px 10px', fontSize: 'var(--font-size-ui)',
    border: '1px solid var(--color-border-strong)', borderRadius: 4,
    background: 'var(--color-bg)', color: 'var(--color-text)', boxSizing: 'border-box',
  };

  return (
    <div>
      <label style={labelStyle}>
        {def.name}
        {def.required && <span style={{ color: 'var(--color-danger)', marginLeft: 4 }}>*</span>}
      </label>
      {(() => {
        switch (def.type) {
          case 'textarea':
            return (
              <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                rows={3}
                style={inputStyle}
              />
            );
          case 'number':
            return (
              <input
                type="number"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                style={inputStyle}
              />
            );
          case 'date':
            return (
              <input
                type="date"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                style={inputStyle}
              />
            );
          case 'checkbox':
            return (
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, paddingTop: 4 }}>
                <input
                  type="checkbox"
                  checked={value === 'true' || value === true}
                  onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
                  disabled={disabled}
                  style={{ cursor: 'pointer' }}
                />
                <span style={{ fontSize: 'var(--font-size-ui)' }}>{def.helpText || 'Yes'}</span>
              </label>
            );
          case 'select':
            return (
              <select
                aria-label={def.label || 'Custom field value'}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                style={inputStyle}
              >
                <option value="">— Select —</option>
                {(def.options || []).map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            );
          case 'text':
          default:
            return (
              <input
                type="text"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                disabled={disabled}
                style={inputStyle}
              />
            );
        }
      })()}
      {def.helpText && def.type !== 'checkbox' && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>{def.helpText}</div>
      )}
    </div>
  );
}