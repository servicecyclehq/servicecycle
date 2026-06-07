// ─────────────────────────────────────────────────────────────────────────────
// CustomFieldInputs.jsx — shared renderer/editor for admin-defined custom
// fields on assets (originally built for contracts; re-targeted for the
// Assets v1 custom-fields wiring).
//
// Pure presentational: the caller owns fetching definitions
// (GET /api/custom-fields, active only) and the values map; this component
// renders one input per definition and reports edits upward. Values use the
// server's canonical string forms throughout — checkbox 'true'/'false',
// date 'YYYY-MM-DD', number as a numeric string, select as an option value —
// so what the inputs hold round-trips through POST/PUT customFields and the
// GET /api/assets/:id customFieldValues payload unchanged.
//
// Props:
//   - definitions: array of CustomFieldDefinition rows
//                  ({ id, name, type, options, required, helpText,
//                    displayOrder }). The caller filters out archived
//                  definitions — anything passed in renders as editable.
//   - values:      { [definitionId]: string } — current form state.
//   - onChange:    (definitionId, value) => void
//   - disabled     (optional)
//
// Empty-state: with no definitions, returns null so the host form doesn't
// get a section header pointing at nothing.
// ─────────────────────────────────────────────────────────────────────────────

export default function CustomFieldInputs({ definitions, values, onChange, disabled }) {
  if (!definitions || definitions.length === 0) return null;

  // Admin-controlled ordering, with name as a stable tiebreaker.
  const sorted = [...definitions].sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.name.localeCompare(b.name)
  );

  return (
    <div className="form-row">
      {sorted.map(def => (
        <CustomFieldInput
          key={def.id}
          def={def}
          value={values?.[def.id] ?? ''}
          onChange={v => onChange(def.id, v)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

function CustomFieldInput({ def, value, onChange, disabled }) {
  const label = (
    <label className="form-label" htmlFor={`cf-${def.id}`}>
      {def.name}
      {def.required && <span className="required"> *</span>}
    </label>
  );

  // Checkbox gets the app's checkbox-group treatment instead of a boxed input.
  if (def.type === 'checkbox') {
    return (
      <div className="form-group">
        {label}
        <div className="checkbox-group">
          <input
            id={`cf-${def.id}`}
            type="checkbox"
            checked={value === 'true'}
            onChange={e => onChange(e.target.checked ? 'true' : 'false')}
            disabled={disabled}
          />
          <label htmlFor={`cf-${def.id}`} className="checkbox-label">
            {def.helpText || 'Yes'}
          </label>
        </div>
      </div>
    );
  }

  let input;
  switch (def.type) {
    case 'textarea':
      input = (
        <textarea
          id={`cf-${def.id}`}
          className="form-control"
          rows={3}
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      );
      break;
    case 'number':
      input = (
        <input
          id={`cf-${def.id}`}
          type="number"
          className="form-control"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      );
      break;
    case 'date':
      input = (
        <input
          id={`cf-${def.id}`}
          type="date"
          className="form-control"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      );
      break;
    case 'select':
      input = (
        <select
          id={`cf-${def.id}`}
          className="form-control"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        >
          <option value="">— Select —</option>
          {(def.options || []).map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      );
      break;
    case 'text':
    default:
      input = (
        <input
          id={`cf-${def.id}`}
          type="text"
          className="form-control"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
        />
      );
  }

  return (
    <div className="form-group">
      {label}
      {input}
      {def.helpText && <div className="form-hint">{def.helpText}</div>}
    </div>
  );
}
