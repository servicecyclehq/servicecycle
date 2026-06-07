import React, { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';
const API = import.meta.env.VITE_API_URL || '/api';

// ─── Categories (Phase 2 non-SaaS expansion) ──────────────────────────────────
// Mirrors CustomFieldsSection in style + interaction patterns. The 9 system
// defaults are seeded per account; users can rename, recolor, change icon,
// reorder, archive any of them, and create custom ones. The "saas" category
// is the system fallback for new contracts and cannot be archived (server
// enforces this; client also flags it visually).

export default function CategoriesSection({ isAdmin }) {
  const [categories, setCategories] = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [busy,       setBusy]       = useState(false);
  const [error,      setError]      = useState(null);
  const [editingId,  setEditingId]  = useState(null);
  const [editDraft,  setEditDraft]  = useState({});

  // New-category form state
  const [newName,    setNewName]    = useState('');
  const [newIcon,    setNewIcon]    = useState('');
  // newColor default '#5b6373' is a DB-persisted category color literal, NOT a CSS color usage -- keep raw.
  const [newColor,   setNewColor]   = useState('#5b6373');
  const [newNotice,  setNewNotice]  = useState('30');
  const [newAuto,    setNewAuto]    = useState(false);

  function load() {
    setLoading(true);
    fetch(`${API}/categories`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}` },
    }).then(r => r.json()).then(d => {
      if (d.success) setCategories(d.data.categories);
    }).finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, []);

  async function createCategory() {
    setError(null);
    if (!newName.trim()) return setError('Name is required');
    setBusy(true);
    try {
      const body = {
        name:               newName.trim(),
        icon:               newIcon.trim() || null,
        color:              newColor || null,
        defaultNoticeDays:  newNotice ? parseInt(newNotice, 10) : null,
        defaultAutoRenewal: !!newAuto,
      };
      const r = await fetch(`${API}/categories`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error || 'Failed to create category');
      } else {
        setNewName(''); setNewIcon(''); setNewColor('#5b6373');
        setNewNotice('30'); setNewAuto(false);
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit(id) {
    setBusy(true);
    setError(null);
    try {
      const body = {
        name:               editDraft.name?.trim(),
        icon:               editDraft.icon ?? null,
        color:              editDraft.color ?? null,
        defaultNoticeDays:  editDraft.defaultNoticeDays === '' || editDraft.defaultNoticeDays == null
                              ? null
                              : parseInt(editDraft.defaultNoticeDays, 10),
        defaultAutoRenewal: editDraft.defaultAutoRenewal ?? null,
      };
      const r = await fetch(`${API}/categories/${id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!d.success) {
        setError(d.error || 'Update failed');
      } else {
        setEditingId(null);
        setEditDraft({});
        load();
      }
    } finally {
      setBusy(false);
    }
  }

  async function archiveCategory(id, archived) {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API}/categories/${id}/archive`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}`,
        },
        body: JSON.stringify({ archived }),
      });
      const d = await r.json();
      if (!d.success) setError(d.error || 'Archive toggle failed');
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!isAdmin) {
    return (
      <section>
        <h2 className={sectionHeading}>Categories</h2>
        <p className={sectionDesc}>Manager or admin access required to manage categories.</p>
      </section>
    );
  }

  const active   = categories.filter(c => !c.archivedAt);
  const archived = categories.filter(c => c.archivedAt);

  return (
    <section>
      <h2 className={sectionHeading}>Categories</h2>
      <p className={sectionDesc}>
        Tag every contract with what kind of commitment it is — SaaS subscription, telecom,
        insurance, lease, hardware maintenance, supplier agreement, anything. The 9 system
        defaults ship with LapseIQ; rename, recolor, or replace them, and add your own.
        Behavioural defaults (typical notice period, whether contracts in this category
        auto-renew) pre-fill the new-contract form when you pick the category.
      </p>

      {error && (
        <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--color-danger)', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 'var(--font-size-ui)' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading categories…</div>
      ) : (
        <>
          <table style={{ width: '100%', fontSize: 'var(--font-size-ui)', borderCollapse: 'collapse', marginBottom: 16 }}>
            <thead>
              <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
                <th scope="col" style={{ padding: '6px 8px', width: 32 }}></th>
                <th scope="col" style={{ padding: '6px 8px' }}>Name</th>
                <th scope="col" style={{ padding: '6px 8px', width: 100 }}>Notice (d)</th>
                <th scope="col" style={{ padding: '6px 8px', width: 110 }}>Auto-renew?</th>
                <th scope="col" style={{ padding: '6px 8px', width: 90 }}>Contracts</th>
                <th scope="col" style={{ padding: '6px 8px', width: 160 }}></th>
              </tr>
            </thead>
            <tbody>
              {active.map(c => {
                const isEditing = editingId === c.id;
                const isSaasFallback = c.slug === 'saas';
                return (
                  <tr key={c.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '6px 8px', fontSize: 16 }}>
                      {isEditing ? (
                        <input
                          maxLength={4}
                          style={{ width: 36, padding: '2px 4px', fontSize: 'var(--font-size-data)', border: '1px solid var(--color-border)', borderRadius: 4, textAlign: 'center' }}
                          value={editDraft.icon ?? ''}
                          onChange={e => setEditDraft({ ...editDraft, icon: e.target.value })}
                        />
                      ) : (
                        <span style={{ display: 'inline-block', width: 22, height: 22, lineHeight: '22px', textAlign: 'center', borderRadius: 4, background: c.color ? `${c.color}22` : 'var(--color-surface)' }}>
                          {c.icon || '·'}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {isEditing ? (
                        <input
                          maxLength={80}
                          style={{ width: '100%', padding: '4px 6px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4 }}
                          value={editDraft.name ?? ''}
                          onChange={e => setEditDraft({ ...editDraft, name: e.target.value })}
                        />
                      ) : (
                        <>
                          <div style={{ fontWeight: 600 }}>{c.name}</div>
                          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                            {c.slug}
                            {c.isSystemDefault && <span style={{ marginLeft: 6, color: 'var(--color-primary)' }}>system</span>}
                            {isSaasFallback && <span style={{ marginLeft: 6, color: 'var(--color-warning)' }}>fallback default</span>}
                          </div>
                        </>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {isEditing ? (
                        <input
                          type="number"
                          min={0}
                          max={365}
                          style={{ width: 60, padding: '4px 6px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4 }}
                          value={editDraft.defaultNoticeDays ?? ''}
                          onChange={e => setEditDraft({ ...editDraft, defaultNoticeDays: e.target.value })}
                        />
                      ) : (
                        c.defaultNoticeDays ?? '—'
                      )}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {isEditing ? (
                        <select
                          aria-label="Auto-renew default"
                          style={{ padding: '4px 6px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4 }}
                          value={editDraft.defaultAutoRenewal == null ? '' : String(editDraft.defaultAutoRenewal)}
                          onChange={e => setEditDraft({
                            ...editDraft,
                            defaultAutoRenewal: e.target.value === '' ? null : e.target.value === 'true',
                          })}
                        >
                          <option value="">—</option>
                          <option value="true">Yes</option>
                          <option value="false">No</option>
                        </select>
                      ) : (
                        c.defaultAutoRenewal == null ? '—' : (c.defaultAutoRenewal ? 'Yes' : 'No')
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }}>
                      {c.contractCount ?? 0}
                    </td>
                    <td style={{ padding: '6px 8px', textAlign: 'right' }}>
                      {isEditing ? (
                        <>
                          <button onClick={() => saveEdit(c.id)} disabled={busy} className={btnPrimary} style={{ padding: '3px 10px', fontSize: 'var(--font-size-sm)', marginRight: 6 }}>
                            Save
                          </button>
                          <button onClick={() => { setEditingId(null); setEditDraft({}); }} disabled={busy} style={{ background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 4, padding: '3px 10px', fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setEditingId(c.id);
                              setEditDraft({
                                name: c.name,
                                icon: c.icon ?? '',
                                color: c.color ?? '',
                                defaultNoticeDays: c.defaultNoticeDays ?? '',
                                defaultAutoRenewal: c.defaultAutoRenewal,
                              });
                            }}
                            style={{ background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 4, padding: '3px 10px', fontSize: 'var(--font-size-sm)', cursor: 'pointer', marginRight: 6 }}
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => archiveCategory(c.id, true)}
                            disabled={busy || isSaasFallback}
                            title={isSaasFallback ? 'SaaS is the fallback for new contracts and cannot be archived' : 'Hide from picker; existing contracts keep their assignment'}
                            style={{ background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 4, padding: '3px 10px', fontSize: 'var(--font-size-sm)', cursor: isSaasFallback ? 'not-allowed' : 'pointer', opacity: isSaasFallback ? 0.4 : 1, color: 'var(--color-danger)' }}
                          >
                            Archive
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {archived.length > 0 && (
            <details style={{ marginBottom: 16 }}>
              <summary style={{ cursor: 'pointer', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                {archived.length} archived {archived.length === 1 ? 'category' : 'categories'}
              </summary>
              <table style={{ width: '100%', fontSize: 'var(--font-size-ui)', borderCollapse: 'collapse', marginTop: 8 }}>
                <tbody>
                  {archived.map(c => (
                    <tr key={c.id} style={{ borderBottom: '1px solid var(--color-border)', opacity: 0.7 }}>
                      <td style={{ padding: '6px 8px', width: 32, fontSize: 16 }}>{c.icon || '·'}</td>
                      <td style={{ padding: '6px 8px' }}>
                        <div style={{ fontWeight: 600 }}>{c.name}</div>
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                          {c.slug} · archived {c.archivedAt && new Date(c.archivedAt).toLocaleDateString()}
                          {' · '}{c.contractCount ?? 0} contracts still assigned
                        </div>
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'right', width: 120 }}>
                        <button
                          onClick={() => archiveCategory(c.id, false)}
                          disabled={busy}
                          style={{ background: 'transparent', border: '1px solid var(--color-border)', borderRadius: 4, padding: '3px 10px', fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </>
      )}

      {/* New-category form */}
      <div style={{ marginTop: 8, padding: '12px 14px', border: '1px dashed var(--color-border)', borderRadius: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 'var(--font-size-ui)', marginBottom: 8 }}>Create a custom category</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>Icon</label>
            <input
              maxLength={4}
              placeholder="📋"
              style={{ width: 56, padding: '5px 8px', fontSize: 'var(--font-size-data)', border: '1px solid var(--color-border)', borderRadius: 4, textAlign: 'center' }}
              value={newIcon}
              onChange={e => setNewIcon(e.target.value)}
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>Name</label>
            <input
              maxLength={80}
              placeholder="e.g. HVAC service"
              style={{ width: '100%', padding: '5px 8px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4 }}
              value={newName}
              onChange={e => setNewName(e.target.value)}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>Color</label>
            <input
              type="color"
              style={{ width: 44, height: 30, padding: 0, border: '1px solid var(--color-border)', borderRadius: 4, cursor: 'pointer' }}
              value={newColor}
              onChange={e => setNewColor(e.target.value)}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>Notice (days)</label>
            <input
              type="number"
              min={0}
              max={365}
              style={{ width: 80, padding: '5px 8px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4 }}
              value={newNotice}
              onChange={e => setNewNotice(e.target.value)}
            />
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'block', marginBottom: 2 }}>Auto-renew default</label>
            <select
              aria-label="Auto-renew default for new category"
              style={{ padding: '5px 8px', fontSize: 'var(--font-size-ui)', border: '1px solid var(--color-border)', borderRadius: 4 }}
              value={String(newAuto)}
              onChange={e => setNewAuto(e.target.value === 'true')}
            >
              <option value="false">No</option>
              <option value="true">Yes</option>
            </select>
          </div>
          <button
            type="button"
            onClick={createCategory}
            disabled={busy || !newName.trim()}
            className={btnPrimary}
          >
            {busy ? 'Saving…' : '+ Add category'}
          </button>
        </div>
      </div>
    </section>
  );
}
