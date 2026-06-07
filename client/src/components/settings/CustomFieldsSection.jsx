import React, { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';
const API = import.meta.env.VITE_API_URL || '/api';

// ── Custom Fields Section ─────────────────────────────────────────────────────
// Admin manages the schema (definitions) here; the per-contract values land
// on the contract form via the shared CustomFieldInputs component.
//
// UX notes:
//   - One-row-per-field table with inline rename, archive toggle, delete-after-
//     archive (cascade-deletes the values; only an admin who's seen a "this
//     will erase data" confirm should hit it).
//   - Add-field row at the bottom for create. `select` reveals a textarea for
//     comma-separated options because per-row option editing inside a table
//     row gets fiddly; the value column shows the inline list.

const FIELD_TYPES = [
  { value: 'text',     label: 'Text' },
  { value: 'textarea', label: 'Long text' },
  { value: 'number',   label: 'Number' },
  { value: 'date',     label: 'Date' },
  { value: 'checkbox', label: 'Checkbox' },
  { value: 'select',   label: 'Dropdown' },
];

export default function CustomFieldsSection({ isAdmin }) {
  const [fields,     setFields]    = useState([]);
  const [categories, setCategories]= useState([]);
  const [loading,    setLoading]   = useState(true);
  const [busy,       setBusy]      = useState(false);
  const [error,      setError]     = useState(null);

  // New-field form state
  const [newName,     setNewName]     = useState('');
  const [newType,     setNewType]     = useState('text');
  const [newRequired, setNewRequired] = useState(false);
  const [newOptions,  setNewOptions]  = useState(''); // comma-separated for select
  const [newHelp,     setNewHelp]     = useState('');
  const [newCategory, setNewCategory] = useState(''); // '' = global (all contracts)

  function load() {
    setLoading(true);
    Promise.all([
      fetch(`${API}/custom-fields`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}` },
      }).then(r => r.json()),
      fetch(`${API}/categories`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}` },
      }).then(r => r.json()),
    ]).then(([fd, cd]) => {
      if (fd.success) setFields(fd.data.fields);
      if (cd.success) setCategories(cd.data.categories.filter(c => !c.archivedAt));
    }).finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function createField() {
    setError(null);
    if (!newName.trim()) return setError('Name is required');
    if (newType === 'select' && !newOptions.trim()) return setError('Add at least one option for a dropdown');

    setBusy(true);
    try {
      const body = {
        name:       newName.trim(),
        type:       newType,
        required:   newRequired,
        helpText:   newHelp.trim() || undefined,
        categoryId: newCategory || null,
      };
      if (newType === 'select') {
        body.options = newOptions.split(',').map(s => s.trim()).filter(Boolean);
      }
      const r = await fetch(`${API}/custom-fields`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error || 'Failed to create field');
      } else {
        setNewName(''); setNewType('text'); setNewRequired(false);
        setNewOptions(''); setNewHelp(''); setNewCategory('');
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function patchField(id, body) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/custom-fields/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) setError(d.error || 'Update failed');
      load();
    } finally { setBusy(false); }
  }

  async function archiveField(id, archived) {
    setBusy(true);
    try {
      await fetch(`${API}/custom-fields/${id}/archive`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: JSON.stringify({ archived }),
      });
      load();
    } finally { setBusy(false); }
  }

  if (!isAdmin) {
    return (
      <section>
        <h2 className={sectionHeading}>Custom Fields</h2>
        <p className={sectionDesc}>Admin access required to manage custom fields.</p>
      </section>
    );
  }

  // Build a lookup map so scope labels render without another fetch
  const catById = Object.fromEntries(categories.map(c => [c.id, c]));

  return (
    <section>
      <h2 className={sectionHeading}>Custom Fields</h2>
      <p className={sectionDesc}>
        Add organisation-specific fields that appear on contract forms. Scope a field to a
        specific category (e.g. only on Insurance contracts) or leave it as{' '}
        <strong>All contracts</strong> to show it everywhere. Up to 50 active fields.
      </p>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--color-danger)', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 'var(--font-size-ui)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading custom fields…</div>
      ) : (
        <div style={{ marginBottom: '1.5rem' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th scope="col" style={{ textAlign: 'left',  padding: '8px 6px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Name</th>
                <th scope="col" style={{ textAlign: 'left',  padding: '8px 6px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Type</th>
                <th scope="col" style={{ textAlign: 'left',  padding: '8px 6px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Scope</th>
                <th scope="col" style={{ textAlign: 'center', padding: '8px 6px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Req.</th>
                <th scope="col" style={{ textAlign: 'left',  padding: '8px 6px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Help text</th>
                <th scope="col" style={{ textAlign: 'right', padding: '8px 6px', fontWeight: 600, color: 'var(--color-text-secondary)' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {fields.length === 0 && (
                <tr><td colSpan={6} style={{ padding: '20px 6px', color: 'var(--color-text-secondary)', textAlign: 'center' }}>No custom fields yet. Add one below.</td></tr>
              )}
              {fields.map(f => {
                const isArchived = !!f.archivedAt;
                const scopeCat   = f.categoryId ? catById[f.categoryId] : null;
                const scopeLabel = scopeCat ? (scopeCat.icon ? `${scopeCat.icon} ${scopeCat.name}` : scopeCat.name) : 'All contracts';
                const scopeStyle = { fontSize: 'var(--font-size-sm)', color: f.categoryId ? 'var(--color-primary)' : 'var(--color-text-secondary)', whiteSpace: 'nowrap' };
                return (
                  <tr key={f.id} style={{ borderBottom: '1px solid var(--color-border)', opacity: isArchived ? 0.55 : 1 }}>
                    <td style={{ padding: '8px 6px' }}>
                      <input
                        defaultValue={f.name}
                        disabled={busy || isArchived}
                        onBlur={(e) => { if (e.target.value !== f.name) patchField(f.id, { name: e.target.value }); }}
                        style={{ padding: '4px 6px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)', width: '100%' }}
                      />
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, fontFamily: 'monospace' }}>
                        key: {f.fieldKey}
                        {f.type === 'select' && f.options?.length > 0 && (
                          <> · options: {f.options.map(o => o.label).join(', ')}</>
                        )}
                      </div>
                    </td>
                    <td style={{ padding: '8px 6px' }}>
                      {FIELD_TYPES.find(t => t.value === f.type)?.label || f.type}
                    </td>
                    <td style={{ padding: '8px 6px', ...scopeStyle }}>
                      {scopeLabel}
                    </td>
                    <td style={{ padding: '8px 6px', textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={!!f.required}
                        disabled={busy || isArchived}
                        onChange={(e) => patchField(f.id, { required: e.target.checked })}
                      />
                    </td>
                    <td style={{ padding: '8px 6px' }}>
                      <input
                        defaultValue={f.helpText || ''}
                        disabled={busy || isArchived}
                        onBlur={(e) => { if ((e.target.value || '') !== (f.helpText || '')) patchField(f.id, { helpText: e.target.value }); }}
                        style={{ padding: '4px 6px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)', width: '100%' }}
                        placeholder="Optional hint"
                      />
                    </td>
                    <td style={{ padding: '8px 6px', textAlign: 'right' }}>
                      <button
                        type="button"
                        onClick={() => archiveField(f.id, !isArchived)}
                        disabled={busy}
                        style={{ background: 'none', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', padding: '3px 10px', borderRadius: 4, fontSize: 'var(--font-size-sm)', cursor: busy ? 'wait' : 'pointer' }}
                      >
                        {isArchived ? 'Restore' : 'Archive'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Add-field form */}
      <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: '1rem' }}>
        <h3 style={{ fontSize: 'var(--font-size-data)', fontWeight: 700, marginBottom: 12, color: 'var(--color-text)' }}>Add a new field</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Field name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Cost centre code"
              style={{ width: '100%', padding: '6px 10px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)', boxSizing: 'border-box' }}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Type</label>
            <select
              aria-label="Field type"
              value={newType}
              onChange={(e) => setNewType(e.target.value)}
              style={{ width: '100%', padding: '6px 10px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)' }}
            >
              {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 3 }}>Category scope</label>
            <select
              aria-label="Category scope"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              style={{ width: '100%', padding: '6px 10px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)' }}
            >
              <option value="">All contracts</option>
              {categories.map(c => (
                <option key={c.id} value={c.id}>{c.icon ? `${c.icon} ` : ''}{c.name}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', cursor: 'pointer' }}>
              <input type="checkbox" checked={newRequired} onChange={(e) => setNewRequired(e.target.checked)} />
              Required
            </label>
          </div>
        </div>
        {newType === 'select' && (
          <input
            value={newOptions}
            onChange={(e) => setNewOptions(e.target.value)}
            placeholder="Comma-separated options (e.g. Claims-made, Occurrence, Retro)"
            style={{ width: '100%', padding: '6px 10px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)', marginBottom: 10, boxSizing: 'border-box' }}
          />
        )}
        <input
          value={newHelp}
          onChange={(e) => setNewHelp(e.target.value)}
          placeholder="Optional help text shown under the input"
          style={{ width: '100%', padding: '6px 10px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4, background: 'var(--color-surface)', color: 'var(--color-text)', marginBottom: 10, boxSizing: 'border-box' }}
        />
        <button
          type="button"
          onClick={createField}
          disabled={busy || !newName.trim()}
          className={btnPrimary}
        >
          {busy ? 'Saving...' : '+ Add field'}
        </button>
      </div>
    </section>
  );
}
