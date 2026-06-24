/**
 * Parts catalog page — lists all Part records for this account, lets managers
 * create / edit / delete parts and manage per-asset SpareInventory entries.
 *
 * Route: /parts
 * Gate: manager+  (the API already enforces this; client hides the link for viewers)
 */
import { useEffect, useState } from 'react';
import api from '../api/client';

const CATEGORIES = ['BREAKER', 'TRANSFORMER', 'RELAY', 'CABLE', 'FUSE', 'CONSUMABLE', 'OTHER'];

function Badge({ category }) {
  const colours = {
    BREAKER: '#3b82f6', TRANSFORMER: '#8b5cf6', RELAY: '#06b6d4',
    CABLE: '#d97706', FUSE: '#ef4444', CONSUMABLE: '#6b7280', OTHER: '#6b7280',
  };
  const bg = colours[category] || '#6b7280';
  return (
    <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4,
      background: bg + '22', color: bg, whiteSpace: 'nowrap' }}>
      {category || 'UNCATEGORISED'}
    </span>
  );
}

function PartForm({ initial, onSave, onCancel, saving }) {
  const [form, setForm] = useState({
    partNumber: initial?.partNumber || '',
    description: initial?.description || '',
    manufacturer: initial?.manufacturer || '',
    category: initial?.category || '',
    unitCost: initial?.unitCost != null ? String(initial.unitCost) : '',
    leadTimeWeeks: initial?.leadTimeWeeks != null ? String(initial.leadTimeWeeks) : '',
    notes: initial?.notes || '',
  });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form); }}
      style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Part number *</label>
          <input className="input" required value={form.partNumber} onChange={e => set('partNumber', e.target.value)} placeholder="e.g. CH-QO130L" />
        </div>
        <div style={{ flex: '2 1 260px' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Description *</label>
          <input className="input" required value={form.description} onChange={e => set('description', e.target.value)} placeholder="e.g. 30A 1-pole QO breaker" />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 160px' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Manufacturer</label>
          <input className="input" value={form.manufacturer} onChange={e => set('manufacturer', e.target.value)} placeholder="e.g. Square D" />
        </div>
        <div style={{ flex: '1 1 140px' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Category</label>
          <select className="input" value={form.category} onChange={e => set('category', e.target.value)}>
            <option value="">— select —</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ flex: '1 1 110px' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Unit cost ($)</label>
          <input className="input" type="number" min="0" step="0.01" value={form.unitCost} onChange={e => set('unitCost', e.target.value)} placeholder="0.00" />
        </div>
        <div style={{ flex: '1 1 110px' }}>
          <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Lead time (wks)</label>
          <input className="input" type="number" min="0" step="1" value={form.leadTimeWeeks} onChange={e => set('leadTimeWeeks', e.target.value)} placeholder="—" />
        </div>
      </div>
      <div>
        <label style={{ fontSize: '0.78rem', fontWeight: 600 }}>Notes</label>
        <textarea className="input" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="Storage conditions, substitutes, ordering notes…" style={{ resize: 'vertical' }} />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>{saving ? 'Saving…' : initial ? 'Save changes' : 'Add part'}</button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function InventoryEntry({ entry, onEdit, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ qtyOnHand: String(entry.qtyOnHand), qtyMin: entry.qtyMin != null ? String(entry.qtyMin) : '', location: entry.location || '', notes: entry.notes || '' });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      await onEdit(entry.id, form);
      setEditing(false);
    } finally { setSaving(false); }
  }

  const assetLabel = entry.asset ? `${entry.asset.equipmentType?.replace(/_/g, ' ')} — ${entry.asset.manufacturer || ''} ${entry.asset.model || ''}`.trim() : null;
  const siteLabel = entry.site?.name;
  const scopeLabel = assetLabel || siteLabel || 'Account-wide';
  const belowMin = entry.qtyMin != null && entry.qtyOnHand < entry.qtyMin;

  return (
    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
      {!editing ? (
        <>
          <td style={{ padding: '6px 10px', fontSize: '0.78rem' }}>
            {scopeLabel}
            {entry.location && <span style={{ marginLeft: 6, fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>@ {entry.location}</span>}
          </td>
          <td style={{ padding: '6px 10px', textAlign: 'center', fontWeight: 600, color: belowMin ? 'var(--chip-amber-fg, #d97706)' : undefined }}>
            {entry.qtyOnHand}
            {entry.qtyMin != null && <span style={{ marginLeft: 4, fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>/ min {entry.qtyMin}</span>}
            {belowMin && <span style={{ marginLeft: 4, fontSize: '0.68rem', color: 'var(--chip-amber-fg, #d97706)', fontWeight: 700 }}>LOW</span>}
          </td>
          <td style={{ padding: '6px 10px' }}>
            <button className="btn btn-secondary btn-sm" style={{ marginRight: 4 }} onClick={() => setEditing(true)}>Edit</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onDelete(entry.id)}>Remove</button>
          </td>
        </>
      ) : (
        <td colSpan={3} style={{ padding: '8px 10px' }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div><label style={{ fontSize: '0.72rem' }}>Qty on hand</label><input className="input" type="number" min="0" value={form.qtyOnHand} onChange={e => set('qtyOnHand', e.target.value)} style={{ width: 70 }} /></div>
            <div><label style={{ fontSize: '0.72rem' }}>Min qty</label><input className="input" type="number" min="0" value={form.qtyMin} onChange={e => set('qtyMin', e.target.value)} style={{ width: 70 }} /></div>
            <div style={{ flex: 1 }}><label style={{ fontSize: '0.72rem' }}>Location</label><input className="input" value={form.location} onChange={e => set('location', e.target.value)} /></div>
            <button className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? '…' : 'Save'}</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </td>
      )}
    </tr>
  );
}

function PartRow({ part, onRefresh }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function loadDetail() {
    try {
      const r = await api.get(`/api/parts/${part.id}`);
      setDetail(r.data?.data || null);
    } catch { setErr('Failed to load part detail.'); }
  }

  async function toggleOpen() {
    if (!open && !detail) await loadDetail();
    setOpen(o => !o);
  }

  async function saveEdit(form) {
    setSaving(true); setErr('');
    try {
      await api.patch(`/api/parts/${part.id}`, form);
      await onRefresh();
      setEditing(false);
      if (open) await loadDetail();
    } catch (e) { setErr(e?.response?.data?.error || 'Save failed.'); }
    finally { setSaving(false); }
  }

  async function deletePart() {
    if (!window.confirm(`Delete part ${part.partNumber}? This cannot be undone.`)) return;
    try {
      await api.delete(`/api/parts/${part.id}`);
      onRefresh();
    } catch (e) { setErr(e?.response?.data?.error || 'Delete failed.'); }
  }

  async function addInventory(form) {
    await api.post(`/api/parts/${part.id}/inventory`, form);
    loadDetail();
  }

  async function editInventory(entryId, form) {
    await api.patch(`/api/parts/${part.id}/inventory/${entryId}`, form);
    loadDetail();
  }

  async function deleteInventory(entryId) {
    if (!window.confirm('Remove this inventory entry?')) return;
    await api.delete(`/api/parts/${part.id}/inventory/${entryId}`);
    loadDetail();
  }

  const [addingInv, setAddingInv] = useState(false);
  const [invForm, setInvForm] = useState({ qtyOnHand: '0', qtyMin: '', location: '', assetId: '', siteId: '', notes: '' });
  const setInv = (k, v) => setInvForm(f => ({ ...f, [k]: v }));

  async function submitInv(e) {
    e.preventDefault();
    try {
      await addInventory({ ...invForm, qtyOnHand: parseInt(invForm.qtyOnHand, 10) || 0 });
      setAddingInv(false);
      setInvForm({ qtyOnHand: '0', qtyMin: '', location: '', assetId: '', siteId: '', notes: '' });
    } catch (ex) { setErr(ex?.response?.data?.error || 'Failed to add inventory.'); }
  }

  return (
    <>
      <tr style={{ borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}>
        <td style={{ padding: '8px 10px' }} onClick={toggleOpen}>
          <span style={{ marginRight: 6, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>{open ? '▼' : '▶'}</span>
          <strong style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}>{part.partNumber}</strong>
        </td>
        <td style={{ padding: '8px 10px' }} onClick={toggleOpen}>{part.description}</td>
        <td style={{ padding: '8px 10px' }} onClick={toggleOpen}>{part.manufacturer || <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }} onClick={toggleOpen}>
          {part.category ? <Badge category={part.category} /> : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
        </td>
        <td style={{ padding: '8px 10px', textAlign: 'right', fontFamily: 'monospace' }} onClick={toggleOpen}>
          {part.unitCost != null ? `$${Number(part.unitCost).toFixed(2)}` : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
        </td>
        <td style={{ padding: '8px 10px', textAlign: 'center', color: 'var(--color-text-secondary)' }} onClick={toggleOpen}>
          {part._count?.inventory || 0}
        </td>
        <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
          <button className="btn btn-secondary btn-sm" style={{ marginRight: 4 }} onClick={e => { e.stopPropagation(); setEditing(e2 => !e2); }}>Edit</button>
          <button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); deletePart(); }}
            disabled={part._count?.inventory > 0}
            title={part._count?.inventory > 0 ? 'Remove inventory entries first' : 'Delete this part'}>Delete</button>
        </td>
      </tr>
      {err && <tr><td colSpan={7} style={{ padding: '4px 10px', color: 'var(--chip-red-fg, #dc2626)', fontSize: '0.78rem' }}>{err}</td></tr>}
      {editing && (
        <tr><td colSpan={7} style={{ padding: '10px 16px', background: 'var(--color-surface-2)' }}>
          <PartForm initial={part} onSave={saveEdit} onCancel={() => setEditing(false)} saving={saving} />
        </td></tr>
      )}
      {open && (
        <tr><td colSpan={7} style={{ padding: '10px 16px', background: 'var(--color-surface-2)' }}>
          {!detail ? <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>Loading…</span> : (
            <>
              {part.leadTimeWeeks != null && (
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
                  Lead time: {part.leadTimeWeeks} wk{part.leadTimeWeeks !== 1 ? 's' : ''}{part.notes ? ` · ${part.notes}` : ''}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: '0.82rem', fontWeight: 600 }}>Inventory entries ({detail.inventory?.length || 0})</span>
                <button className="btn btn-secondary btn-sm" onClick={() => setAddingInv(a => !a)}>{addingInv ? 'Cancel' : '+ Add entry'}</button>
              </div>
              {addingInv && (
                <form onSubmit={submitInv} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8, padding: '8px', background: 'var(--color-surface-3, #f1f5f9)', borderRadius: 4 }}>
                  <div><label style={{ fontSize: '0.72rem' }}>Qty on hand</label><input className="input" type="number" min="0" value={invForm.qtyOnHand} onChange={e => setInv('qtyOnHand', e.target.value)} style={{ width: 80 }} /></div>
                  <div><label style={{ fontSize: '0.72rem' }}>Min qty</label><input className="input" type="number" min="0" value={invForm.qtyMin} onChange={e => setInv('qtyMin', e.target.value)} style={{ width: 70 }} /></div>
                  <div style={{ flex: 1, minWidth: 140 }}><label style={{ fontSize: '0.72rem' }}>Location</label><input className="input" value={invForm.location} onChange={e => setInv('location', e.target.value)} placeholder="Bin / shelf" /></div>
                  <div style={{ flex: 1, minWidth: 160 }}><label style={{ fontSize: '0.72rem' }}>Asset ID (optional)</label><input className="input" value={invForm.assetId} onChange={e => setInv('assetId', e.target.value)} placeholder="asset UUID" /></div>
                  <div style={{ flex: 1, minWidth: 160 }}><label style={{ fontSize: '0.72rem' }}>Site ID (optional)</label><input className="input" value={invForm.siteId} onChange={e => setInv('siteId', e.target.value)} placeholder="site UUID" /></div>
                  <button type="submit" className="btn btn-primary btn-sm">Add</button>
                </form>
              )}
              {detail.inventory?.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ background: 'var(--color-surface-3, #f1f5f9)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 10px', borderBottom: '1px solid var(--color-border)' }}>Scope</th>
                      <th style={{ textAlign: 'center', padding: '4px 10px', borderBottom: '1px solid var(--color-border)' }}>Qty</th>
                      <th style={{ padding: '4px 10px', borderBottom: '1px solid var(--color-border)' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.inventory.map(e => (
                      <InventoryEntry key={e.id} entry={e} onEdit={editInventory} onDelete={deleteInventory} />
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>No inventory entries yet. Add one to start tracking stock.</div>
              )}
            </>
          )}
        </td></tr>
      )}
    </>
  );
}

export default function Parts() {
  const [parts, setParts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  async function loadParts() {
    setLoading(true); setErr('');
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (category) params.set('category', category);
      const r = await api.get(`/api/parts?${params}`);
      setParts(r.data?.data || []);
    } catch { setErr('Failed to load parts.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { loadParts(); }, [search, category]);

  async function createPart(form) {
    setSaving(true); setErr('');
    try {
      await api.post('/api/parts', form);
      setAdding(false);
      loadParts();
    } catch (e) { setErr(e?.response?.data?.error || 'Create failed.'); }
    finally { setSaving(false); }
  }

  const lowStockCount = parts.filter(p => p._count?.inventory > 0).length; // rough proxy

  return (
    <div className="page-container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h1 className="page-title">Parts catalog</h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginTop: 2 }}>
            Manage spare parts and consumables · track stock levels by asset or site
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add part'}</button>
      </div>

      {adding && (
        <div className="card mb-16" style={{ padding: 16 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>New part</h3>
          <PartForm onSave={createPart} onCancel={() => setAdding(false)} saving={saving} />
        </div>
      )}

      {err && <div className="alert alert-error mb-16">{err}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <input className="input" placeholder="Search part number, description, manufacturer…" value={search}
          onChange={e => setSearch(e.target.value)} style={{ flex: '2 1 260px' }} />
        <select className="input" value={category} onChange={e => setCategory(e.target.value)} style={{ flex: '0 0 160px' }}>
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', padding: 24 }}>Loading parts…</div>
      ) : parts.length === 0 ? (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
          {search || category ? 'No parts match your filters.' : 'No parts yet. Add your first spare part to start tracking inventory.'}
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface-2)' }}>
                {['Part number', 'Description', 'Manufacturer', 'Category', 'Unit cost', 'Locations', ''].map(h => (
                  <th key={h} style={{ textAlign: h === 'Unit cost' ? 'right' : h === 'Locations' ? 'center' : 'left', padding: '8px 10px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, fontSize: '0.78rem', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {parts.map(p => <PartRow key={p.id} part={p} onRefresh={loadParts} />)}
            </tbody>
          </table>
          <div style={{ padding: '8px 12px', fontSize: '0.75rem', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)' }}>
            {parts.length} part{parts.length !== 1 ? 's' : ''}
          </div>
        </div>
      )}
    </div>
  );
}
