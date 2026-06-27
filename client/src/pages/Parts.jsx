/**
 * Parts catalog page — lists all Part records for this account, lets managers
 * create / edit / delete parts and manage per-asset SpareInventory entries.
 *
 * Route: /parts
 * Gate: manager+  (the API already enforces this; client hides the link for viewers)
 */
import { useEffect, useRef, useState } from 'react';
import api from '../api/client';
import Pagination from '../components/Pagination';
import { useConfirm } from '../context/ConfirmContext';

const CATEGORIES = ['BREAKER', 'TRANSFORMER', 'RELAY', 'CABLE', 'FUSE', 'CONSUMABLE', 'OTHER'];

function Badge({ category }) {
  const tokenMap = {
    BREAKER:     { bg: 'var(--chip-blue-bg)',       fg: 'var(--chip-blue-fg)' },
    TRANSFORMER: { bg: 'var(--chip-slate-bg)',      fg: 'var(--chip-slate-fg)' },
    RELAY:       { bg: 'var(--chip-green-bg)',      fg: 'var(--chip-green-fg)' },
    CABLE:       { bg: 'var(--chip-amber-bg)',      fg: 'var(--chip-amber-fg)' },
    FUSE:        { bg: 'var(--chip-red-bg)',        fg: 'var(--chip-red-fg)' },
    CONSUMABLE:  { bg: 'var(--chip-slate-soft-bg)', fg: 'var(--chip-slate-soft-fg)' },
    OTHER:       { bg: 'var(--chip-slate-soft-bg)', fg: 'var(--chip-slate-soft-fg)' },
  };
  const tok = tokenMap[category] || tokenMap.OTHER;
  return (
    <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 6px', borderRadius: 4,
      background: tok.bg, color: tok.fg, whiteSpace: 'nowrap' }}>
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
  const confirm = useConfirm();
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
    if (!await confirm({
      title: 'Delete part?',
      message: `Delete part ${part.partNumber}? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
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
    if (!await confirm({
      title: 'Remove inventory entry?',
      message: 'Remove this inventory entry?',
      confirmLabel: 'Remove',
      danger: true,
    })) return;
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
      <tr style={{ cursor: 'pointer' }}>
        <td onClick={toggleOpen}>
          <span style={{ marginRight: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{open ? '▼' : '▶'}</span>
          <strong style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-data)' }}>{part.partNumber}</strong>
        </td>
        <td onClick={toggleOpen}>{part.description}</td>
        <td onClick={toggleOpen}>{part.manufacturer || <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
        <td style={{ whiteSpace: 'nowrap' }} onClick={toggleOpen}>
          {part.category ? <Badge category={part.category} /> : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
        </td>
        <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }} onClick={toggleOpen}>
          {part.unitCost != null ? `$${Number(part.unitCost).toFixed(2)}` : <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}
        </td>
        <td style={{ textAlign: 'center' }} onClick={toggleOpen}>
          {part._count?.inventory || 0}
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
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

// ── CSV import modal ──────────────────────────────────────────────────────────

const STATUS_COLORS = { new: '#22c55e', update: '#f59e0b', error: '#dc2626' };

function CsvImportModal({ onClose, onImported }) {
  const fileRef = useRef(null);
  const [preview, setPreview] = useState(null); // array of rows with .status
  const [parseErrors, setParseErrors] = useState([]);
  const [loading, setLoading] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [err, setErr] = useState('');

  async function handleFile(file) {
    if (!file) return;
    setLoading(true); setErr(''); setPreview(null); setImportResult(null);
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await api.post('/api/parts/import?preview=true', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPreview(r.data?.data?.preview || []);
      setParseErrors(r.data?.data?.parseErrors || []);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to parse CSV.');
    } finally { setLoading(false); }
  }

  async function confirmImport() {
    if (!fileRef.current?.files?.[0]) return;
    setLoading(true); setErr('');
    const form = new FormData();
    form.append('file', fileRef.current.files[0]);
    try {
      const r = await api.post('/api/parts/import', form, { headers: { 'Content-Type': 'multipart/form-data' } });
      setImportResult(r.data?.data);
      onImported();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Import failed.');
    } finally { setLoading(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.35)' }}>
      <div className="card" style={{ width: '100%', maxWidth: 680, maxHeight: '85vh', overflow: 'auto', padding: 24, position: 'relative' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, margin: 0 }}>Import parts from CSV</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕ Close</button>
        </div>

        {!importResult ? (
          <>
            <div style={{ marginBottom: 14, fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
              Upload a CSV with columns: <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)' }}>partNumber, description, manufacturer, category, unitCost, leadTimeWeeks, notes, qtyOnHand, qtyMin, location</span>.
              Existing parts are matched by part number and updated; new part numbers are created.
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
              <a href="/api/parts/import/template" download className="btn btn-secondary btn-sm">⬇ Download template</a>
              <input
                ref={fileRef}
                type="file" accept=".csv,text/csv"
                style={{ flex: 1, minWidth: 200 }}
                onChange={e => handleFile(e.target.files?.[0])}
              />
            </div>

            {loading && <div style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }}>Parsing…</div>}
            {err && <div className="alert alert-error" style={{ marginBottom: 12 }}>{err}</div>}
            {parseErrors.length > 0 && (
              <div style={{ marginBottom: 12, fontSize: 'var(--font-size-sm)', color: 'var(--chip-amber-fg, #d97706)' }}>
                {parseErrors.length} row warning{parseErrors.length !== 1 ? 's' : ''}: {parseErrors.slice(0, 3).join(' · ')}
                {parseErrors.length > 3 ? ` (+${parseErrors.length - 3} more)` : ''}
              </div>
            )}

            {preview && preview.length > 0 && (
              <>
                <div style={{ marginBottom: 8, fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>
                  Preview — {preview.filter(r => r.status === 'new').length} new · {preview.filter(r => r.status === 'update').length} updates
                </div>
                <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto', marginBottom: 14 }}>
                  <table>
                    <thead><tr>
                      <th>Part number</th><th>Description</th><th>Category</th><th style={{ textAlign: 'right' }}>Unit cost</th><th style={{ textAlign: 'center' }}>Qty OH</th><th style={{ textAlign: 'center' }}>Min</th><th style={{ textAlign: 'center' }}>Status</th>
                    </tr></thead>
                    <tbody>
                      {preview.map((r, i) => (
                        <tr key={i}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)' }}>{r.partNumber}</td>
                          <td>{r.description}</td>
                          <td>{r.category || <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                          <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{r.unitCost != null ? `$${Number(r.unitCost).toFixed(2)}` : '—'}</td>
                          <td style={{ textAlign: 'center' }}>{r.qtyOnHand ?? 0}</td>
                          <td style={{ textAlign: 'center' }}>{r.qtyMin ?? '—'}</td>
                          <td style={{ textAlign: 'center' }}>
                            <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                              background: (STATUS_COLORS[r.status] || '#6b7280') + '22',
                              color: STATUS_COLORS[r.status] || '#6b7280' }}>
                              {r.status?.toUpperCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary" onClick={confirmImport} disabled={loading}>
                    {loading ? 'Importing…' : `Import ${preview.length} part${preview.length !== 1 ? 's' : ''}`}
                  </button>
                  <button className="btn btn-secondary" onClick={() => { setPreview(null); if (fileRef.current) fileRef.current.value = ''; }}>Reset</button>
                </div>
              </>
            )}
            {preview && preview.length === 0 && (
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>No valid rows found in the CSV.</div>
            )}
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '20px 0' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, marginBottom: 8 }}>Import complete</div>
            <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 20 }}>
              {importResult.created} created · {importResult.updated} updated
            </div>
            <button className="btn btn-primary" onClick={onClose}>Done</button>
          </div>
        )}
      </div>
    </div>
  );
}

const PARTS_PAGE_SIZE = 50;

export default function Parts() {
  // CUST-8-11: search / category / low-stock filter persist in the URL so a
  // refresh or back-nav keeps the view, and pagination keeps the rendered set
  // bounded (PARTS_PAGE_SIZE) instead of dumping the whole catalog at once.
  const initialParams = (() => {
    try { return new URLSearchParams(window.location.search); }
    catch { return new URLSearchParams(); }
  })();

  const [parts, setParts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [search, setSearch] = useState(initialParams.get('search') || '');
  const [debouncedSearch, setDebouncedSearch] = useState(initialParams.get('search') || '');
  const [category, setCategory] = useState(initialParams.get('category') || '');
  const [filter, setFilter] = useState(initialParams.get('filter') === 'low' ? 'low' : ''); // 'low' = low-stock only
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  // Debounce the search box so each keystroke doesn't hit the API.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Persist the active view (search / category / low-stock) to the URL.
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (category) params.set('category', category);
    if (filter === 'low') params.set('filter', 'low');
    const qs = params.toString();
    const next = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
    window.history.replaceState(null, '', next);
  }, [debouncedSearch, category, filter]);

  async function loadParts() {
    setLoading(true); setErr('');
    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.set('search', debouncedSearch);
      if (category) params.set('category', category);
      params.set('page', String(page));
      params.set('limit', String(PARTS_PAGE_SIZE));
      const r = await api.get(`/api/parts?${params}`);
      // Paginated envelope (page/limit sent) → { parts, pagination }.
      const d = r.data?.data;
      const list = Array.isArray(d) ? d : (d?.parts || []);
      setParts(list);
      setTotal(d?.pagination?.total ?? list.length);
      setTotalPages(d?.pagination?.pages ?? 1);
    } catch { setErr('Failed to load parts.'); }
    finally { setLoading(false); }
  }

  // Reset to page 1 when the search/category filter changes.
  useEffect(() => { setPage(1); }, [debouncedSearch, category]);

  useEffect(() => { loadParts(); }, [debouncedSearch, category, page]);

  // Low-stock view data
  const [lowItems, setLowItems] = useState(null);
  const [lowLoading, setLowLoading] = useState(false);
  useEffect(() => {
    if (filter !== 'low') { setLowItems(null); return; }
    setLowLoading(true);
    api.get('/api/parts/low-stock')
      .then(r => setLowItems(r.data?.data?.items || []))
      .catch(() => setLowItems([]))
      .finally(() => setLowLoading(false));
  }, [filter]);

  async function createPart(form) {
    setSaving(true); setErr('');
    try {
      await api.post('/api/parts', form);
      setAdding(false);
      loadParts();
    } catch (e) { setErr(e?.response?.data?.error || 'Create failed.'); }
    finally { setSaving(false); }
  }

  return (
    <>
      {importing && (
        <CsvImportModal
          onClose={() => setImporting(false)}
          onImported={() => { loadParts(); }}
        />
      )}

      <div className="page-header">
        <div>
          <h1 className="page-title">Parts catalog</h1>
          <p className="page-subtitle">Manage spare parts and consumables · track stock levels by asset or site</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => setImporting(true)}>⬆ Import CSV</button>
          <button className="btn btn-primary" onClick={() => setAdding(a => !a)}>{adding ? 'Cancel' : '+ Add part'}</button>
        </div>
      </div>

      <div className="page-body">
        {adding && (
          <div className="card mb-16" style={{ padding: 16 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 'var(--font-size-ui)', fontWeight: 600 }}>New part</h3>
            <PartForm onSave={createPart} onCancel={() => setAdding(false)} saving={saving} />
          </div>
        )}

        {err && <div className="alert alert-error mb-16">{err}</div>}

        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <input className="input search-input" style={{ flex: '2 1 260px' }}
            placeholder="Search part number, description, manufacturer…" value={search}
            onChange={e => setSearch(e.target.value)} />
          <select className="input filter-select" value={category} onChange={e => setCategory(e.target.value)} style={{ flex: '0 0 160px' }}>
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <button
            className="btn btn-secondary btn-sm"
            style={filter === 'low' ? { background: 'var(--chip-amber-bg)', borderColor: 'var(--chip-amber-fg)', color: 'var(--chip-amber-fg)' } : {}}
            onClick={() => setFilter(f => f === 'low' ? '' : 'low')}
          >
            {filter === 'low' ? '✕ Low stock filter' : '⚠ Low stock'}
          </button>
        </div>

        {/* Low-stock view */}
        {filter === 'low' && (
          <div className="card mb-16" style={{ padding: 0 }}>
            <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--chip-amber-fg)', background: 'var(--chip-amber-bg)', borderRadius: 'var(--radius) var(--radius) 0 0' }}>
              ⚠ Parts below minimum stock level
            </div>
            {lowLoading ? (
              <div style={{ padding: 20, color: 'var(--color-text-secondary)' }}>Loading…</div>
            ) : !lowItems || lowItems.length === 0 ? (
              <div style={{ padding: 20, color: 'var(--color-text-secondary)' }}>All managed parts are at or above their minimum stock levels.</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead><tr>
                    <th>Part number</th>
                    <th>Description</th>
                    <th>Category</th>
                    <th>Scope</th>
                    <th style={{ textAlign: 'center' }}>On hand</th>
                    <th style={{ textAlign: 'center' }}>Min</th>
                  </tr></thead>
                  <tbody>
                    {lowItems.map((entry, i) => {
                      const scope = entry.asset
                        ? `${entry.asset.equipmentType?.replace(/_/g, ' ')} ${entry.asset.manufacturer || ''} ${entry.asset.model || ''}`.trim()
                        : entry.site?.name || 'Account-wide';
                      return (
                        <tr key={i}>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{entry.part.partNumber}</td>
                          <td>
                            <div>{entry.part.description}</div>
                            {entry.procurementRisk && (
                              <span title={`Lead time: ${entry.part.leadTimeWeeks} wks â€” order soon`}
                                style={{ display: "inline-flex", alignItems: "center", gap: 3, padding: "2px 7px",
                                  borderRadius: 999, fontSize: "0.65rem", fontWeight: 800, marginTop: 3,
                                  background: "var(--chip-red-bg)", color: "var(--chip-red-fg)", border: "1px solid var(--chip-red-fg)",
                                  whiteSpace: "nowrap" }}>
                                âš  PROCUREMENT RISK Â· {entry.part.leadTimeWeeks}wk lead
                              </span>
                            )}
                          </td>
                          <td>{entry.part.category || <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                          <td style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{scope}</td>
                          <td style={{ textAlign: 'center', fontWeight: 700, color: entry.qtyOnHand === 0 ? 'var(--color-danger, #dc2626)' : 'var(--chip-amber-fg, #d97706)' }}>
                            {entry.qtyOnHand}
                            {entry.qtyOnHand === 0 && <span style={{ marginLeft: 4, fontSize: 'var(--font-size-xs)', fontWeight: 700 }}>OOS</span>}
                          </td>
                          <td style={{ textAlign: 'center', color: 'var(--color-text-secondary)' }}>{entry.qtyMin}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {loading ? (
          <div style={{ color: 'var(--color-text-secondary)', padding: 24 }}>Loading parts…</div>
        ) : parts.length === 0 ? (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            {search || category ? 'No parts match your filters.' : 'No parts yet. Add your first spare part to start tracking inventory.'}
          </div>
        ) : (
          <div className="card" style={{ padding: 0 }}>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {['Part number', 'Description', 'Manufacturer', 'Category', 'Unit cost', 'Locations', ''].map(h => (
                      <th key={h} style={{ textAlign: h === 'Unit cost' ? 'right' : h === 'Locations' ? 'center' : 'left' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {parts.map(p => <PartRow key={p.id} part={p} onRefresh={loadParts} />)}
                </tbody>
              </table>
            </div>
            <Pagination
              page={page}
              totalPages={totalPages}
              disabled={loading}
              label={`${total.toLocaleString()} part${total !== 1 ? 's' : ''}${totalPages > 1 ? ` · page ${page} of ${totalPages}` : ''}`}
              onPrev={() => setPage(p => Math.max(1, p - 1))}
              onNext={() => setPage(p => Math.min(totalPages, p + 1))}
            />
          </div>
        )}
      </div>
    </>
  );
}
