/**
 * SpareInventoryPanel — shows all SpareInventory entries linked to a specific asset.
 * Renders as a card section inside AssetDetail.
 *
 * Props:
 *   assetId  {string}  — the asset UUID
 *   canEdit  {boolean} — whether the viewer is manager+ (show edit/add controls)
 */
import { useEffect, useState, useCallback } from 'react';
import api from '../api/client';
import { useConfirm } from '../context/ConfirmContext';

function QtyBadge({ qty, min }) {
  const low = min != null && qty < min;
  return (
    <span style={{ fontWeight: 700, fontSize: '0.85rem', color: low ? 'var(--chip-amber-fg, #d97706)' : undefined }}>
      {qty}
      {min != null && <span style={{ fontWeight: 400, fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginLeft: 4 }}>/ min {min}</span>}
      {low && <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--chip-amber-fg, #d97706)', marginLeft: 4 }}>LOW</span>}
    </span>
  );
}

export default function SpareInventoryPanel({ assetId, canEdit }) {
  const confirm = useConfirm();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      const r = await api.get(`/api/parts/by-asset/${assetId}`);
      setEntries(r.data?.data || []);
    } catch { setErr('Failed to load spares.'); }
    finally { setLoading(false); }
  }, [assetId]);

  useEffect(() => { load(); }, [load]);

  // Inline add form state
  const [addForm, setAddForm] = useState({ partSearch: '', partId: '', qtyOnHand: '1', qtyMin: '', location: '', notes: '' });
  const [partOptions, setPartOptions] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);

  async function searchParts(q) {
    if (!q || q.length < 2) { setPartOptions([]); return; }
    setSearchBusy(true);
    try {
      const r = await api.get(`/api/parts?search=${encodeURIComponent(q)}`);
      setPartOptions(r.data?.data || []);
    } catch { setPartOptions([]); }
    finally { setSearchBusy(false); }
  }

  async function submitAdd(e) {
    e.preventDefault(); setErr('');
    if (!addForm.partId) { setErr('Select a part first.'); return; }
    try {
      await api.post(`/api/parts/${addForm.partId}/inventory`, {
        assetId,
        qtyOnHand: parseInt(addForm.qtyOnHand, 10) || 0,
        qtyMin: addForm.qtyMin !== '' ? parseInt(addForm.qtyMin, 10) : undefined,
        location: addForm.location || undefined,
        notes: addForm.notes || undefined,
      });
      setAdding(false);
      setAddForm({ partSearch: '', partId: '', qtyOnHand: '1', qtyMin: '', location: '', notes: '' });
      setPartOptions([]);
      load();
    } catch (ex) { setErr(ex?.response?.data?.error || 'Failed to add spare.'); }
  }

  // Inline edit form
  const [editForm, setEditForm] = useState({});
  function startEdit(entry) {
    setEditForm({ qtyOnHand: String(entry.qtyOnHand), qtyMin: entry.qtyMin != null ? String(entry.qtyMin) : '', location: entry.location || '', notes: entry.notes || '' });
    setEditingId(entry.id);
  }
  async function saveEdit(entry) {
    setErr('');
    try {
      await api.patch(`/api/parts/${entry.partId}/inventory/${entry.id}`, {
        qtyOnHand: parseInt(editForm.qtyOnHand, 10) || 0,
        qtyMin: editForm.qtyMin !== '' ? parseInt(editForm.qtyMin, 10) : null,
        location: editForm.location || null,
        notes: editForm.notes || null,
      });
      setEditingId(null);
      load();
    } catch (ex) { setErr(ex?.response?.data?.error || 'Save failed.'); }
  }
  async function removeEntry(entry) {
    if (!await confirm({
      title: 'Remove spare?',
      message: 'Remove this spare from the asset?',
      confirmLabel: 'Remove',
      danger: true,
    })) return;
    try {
      await api.delete(`/api/parts/${entry.partId}/inventory/${entry.id}`);
      load();
    } catch (ex) { setErr(ex?.response?.data?.error || 'Remove failed.'); }
  }

  return (
    <div className="card mb-16" style={{ padding: '14px 16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 700 }}>Spare parts</h3>
        {canEdit && !adding && (
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>+ Link spare</button>
        )}
      </div>

      {err && <div style={{ color: 'var(--chip-red-fg, #dc2626)', fontSize: '0.78rem', marginBottom: 8 }}>{err}</div>}

      {adding && canEdit && (
        <form onSubmit={submitAdd}
          style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--color-surface-2, #f8fafc)', borderRadius: 6, border: '1px solid var(--color-border)' }}>
          <div style={{ fontWeight: 600, fontSize: '0.82rem', marginBottom: 8 }}>Link a part to this asset</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '2 1 200px', position: 'relative' }}>
              <label style={{ fontSize: '0.72rem' }}>Part number / description</label>
              <input className="input" value={addForm.partSearch}
                onChange={e => { setAddForm(f => ({ ...f, partSearch: e.target.value, partId: '' })); searchParts(e.target.value); }}
                placeholder="Type to search…" autoComplete="off" />
              {partOptions.length > 0 && (
                <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 4, zIndex: 10, maxHeight: 160, overflowY: 'auto' }}>
                  {partOptions.map(p => (
                    <div key={p.id} onClick={() => { setAddForm(f => ({ ...f, partSearch: `${p.partNumber} — ${p.description}`, partId: p.id })); setPartOptions([]); }}
                      style={{ padding: '6px 10px', cursor: 'pointer', fontSize: '0.8rem' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface-2)'}
                      onMouseLeave={e => e.currentTarget.style.background = ''}>
                      <strong style={{ fontFamily: 'monospace' }}>{p.partNumber}</strong> — {p.description}
                      {p.manufacturer && <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6, fontSize: '0.72rem' }}>{p.manufacturer}</span>}
                    </div>
                  ))}
                </div>
              )}
              {searchBusy && <span style={{ position: 'absolute', right: 8, top: 22, fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>…</span>}
            </div>
            <div><label style={{ fontSize: '0.72rem' }}>Qty on hand</label><input className="input" type="number" min="0" value={addForm.qtyOnHand} onChange={e => setAddForm(f => ({ ...f, qtyOnHand: e.target.value }))} style={{ width: 70 }} /></div>
            <div><label style={{ fontSize: '0.72rem' }}>Min qty</label><input className="input" type="number" min="0" value={addForm.qtyMin} onChange={e => setAddForm(f => ({ ...f, qtyMin: e.target.value }))} style={{ width: 70 }} /></div>
            <div style={{ flex: '1 1 130px' }}><label style={{ fontSize: '0.72rem' }}>Location</label><input className="input" value={addForm.location} onChange={e => setAddForm(f => ({ ...f, location: e.target.value }))} placeholder="Bin / shelf" /></div>
            <button type="submit" className="btn btn-primary btn-sm" disabled={!addForm.partId}>Add</button>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setAdding(false); setPartOptions([]); }}>Cancel</button>
          </div>
        </form>
      )}

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>Loading…</div>
      ) : entries.length === 0 ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.82rem' }}>
          No spares linked to this asset.{canEdit ? ' Use "Link spare" to associate parts from the catalog.' : ''}
        </div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
          <thead>
            <tr style={{ background: 'var(--color-surface-2)' }}>
              {['Part', 'Description', 'Qty', 'Location', canEdit ? '' : null].filter(Boolean).map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--color-border)', fontWeight: 600, fontSize: '0.75rem' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entries.map(entry => {
              if (editingId === entry.id) {
                return (
                  <tr key={entry.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td colSpan={canEdit ? 5 : 4} style={{ padding: '8px' }}>
                      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                        <div><label style={{ fontSize: '0.72rem' }}>Qty on hand</label><input className="input" type="number" min="0" value={editForm.qtyOnHand} onChange={e => setEditForm(f => ({ ...f, qtyOnHand: e.target.value }))} style={{ width: 70 }} /></div>
                        <div><label style={{ fontSize: '0.72rem' }}>Min qty</label><input className="input" type="number" min="0" value={editForm.qtyMin} onChange={e => setEditForm(f => ({ ...f, qtyMin: e.target.value }))} style={{ width: 70 }} /></div>
                        <div style={{ flex: 1 }}><label style={{ fontSize: '0.72rem' }}>Location</label><input className="input" value={editForm.location} onChange={e => setEditForm(f => ({ ...f, location: e.target.value }))} /></div>
                        <button className="btn btn-primary btn-sm" onClick={() => saveEdit(entry)}>Save</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={entry.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 8px', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{entry.part?.partNumber}</td>
                  <td style={{ padding: '6px 8px' }}>{entry.part?.description}</td>
                  <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}><QtyBadge qty={entry.qtyOnHand} min={entry.qtyMin} /></td>
                  <td style={{ padding: '6px 8px', color: 'var(--color-text-secondary)' }}>{entry.location || '—'}</td>
                  {canEdit && (
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <button className="btn btn-secondary btn-sm" style={{ marginRight: 4 }} onClick={() => startEdit(entry)}>Edit</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => removeEntry(entry)}>Remove</button>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
