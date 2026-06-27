/**
 * RequiredPartsPanel — shows parts "required on hand" for a specific asset.
 *
 * Distinct from SpareInventoryPanel (which shows WHERE parts are stocked).
 * This panel answers: "what parts does THIS asset need available to avoid downtime?"
 * Each row shows stock status (OK / LOW / OOS) across all inventory entries for that part.
 *
 * Route: rendered inside AssetDetail overview tab when parts_module is enabled.
 * API:
 *   GET    /api/parts/required-by/:assetId          list requirements with stock status
 *   POST   /api/parts/required-by/:assetId          add a requirement
 *   DELETE /api/parts/required-by/:assetId/:partId  remove a requirement
 */
import { useEffect, useState, useRef } from 'react';
import api from '../api/client';
import { useConfirm } from '../context/ConfirmContext';

const STOCK_META = {
  OK:  { label: 'OK',  bg: 'var(--chip-green-bg, #dcfce7)',  fg: 'var(--chip-green-fg, #15803d)' },
  LOW: { label: 'LOW', bg: 'var(--chip-amber-bg, #fef3c7)',  fg: 'var(--chip-amber-fg, #d97706)' },
  OOS: { label: 'OOS', bg: 'var(--chip-red-bg, #fee2e2)',    fg: 'var(--chip-red-fg, #dc2626)'   },
};

function StockBadge({ status }) {
  const m = STOCK_META[status] || STOCK_META.OOS;
  return (
    <span style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '2px 7px', borderRadius: 4,
      background: m.bg, color: m.fg, whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

function AddPartRow({ assetId, onAdded }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState('1');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const debounceRef = useRef(null);

  function handleSearch(val) {
    setQuery(val);
    setSelected(null);
    clearTimeout(debounceRef.current);
    if (!val.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.get('/api/parts', { params: { search: val } });
        setResults(r.data?.data?.slice(0, 8) || []);
      } catch { setResults([]); }
    }, 250);
  }

  async function handleAdd() {
    if (!selected) return;
    setSaving(true); setErr('');
    try {
      await api.post(`/api/parts/required-by/${assetId}`, { partId: selected.id, qtyRequired: parseInt(qty, 10) || 1 });
      setSelected(null); setQuery(''); setResults([]); setQty('1');
      onAdded();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to add requirement.');
    } finally { setSaving(false); }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', padding: '10px 16px', background: 'var(--color-surface-2)', borderTop: '1px solid var(--color-border)' }}>
      <div style={{ flex: '2 1 200px', position: 'relative' }}>
        <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>Part</label>
        <input
          className="input"
          placeholder="Search part number or description…"
          value={selected ? `${selected.partNumber} — ${selected.description}` : query}
          onChange={e => handleSearch(e.target.value)}
          onFocus={() => { if (selected) { setSelected(null); setQuery(''); } }}
        />
        {results.length > 0 && !selected && (
          <div style={{
            position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 50,
            background: 'var(--color-surface)', border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow)', maxHeight: 200, overflowY: 'auto',
          }}>
            {results.map(p => (
              <div key={p.id}
                style={{ padding: '7px 12px', cursor: 'pointer', fontSize: 'var(--font-size-ui)' }}
                onMouseDown={() => { setSelected(p); setResults([]); }}
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{p.partNumber}</span>
                <span style={{ marginLeft: 8, color: 'var(--color-text-secondary)' }}>{p.description}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ flex: '0 0 80px' }}>
        <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>Qty needed</label>
        <input className="input" type="number" min="1" value={qty} onChange={e => setQty(e.target.value)} />
      </div>
      <button className="btn btn-primary btn-sm" disabled={!selected || saving} onClick={handleAdd} style={{ marginBottom: 0 }}>
        {saving ? '…' : 'Add'}
      </button>
      {err && <div style={{ width: '100%', fontSize: 'var(--font-size-sm)', color: 'var(--color-danger, #dc2626)' }}>{err}</div>}
    </div>
  );
}

export default function RequiredPartsPanel({ assetId, canEdit }) {
  const confirm = useConfirm();
  const [requirements, setRequirements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const r = await api.get(`/api/parts/required-by/${assetId}`);
      setRequirements(r.data?.data || []);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to load required parts.');
    } finally { setLoading(false); }
  }

  useEffect(() => { load(); }, [assetId]);

  async function removeRequirement(partId) {
    if (!await confirm({
      title: 'Remove required part?',
      message: 'Remove this required part link from the asset?',
      confirmLabel: 'Remove',
      danger: true,
    })) return;
    try {
      await api.delete(`/api/parts/required-by/${assetId}/${partId}`);
      load();
    } catch (e) { setErr(e?.response?.data?.error || 'Failed to remove.'); }
  }

  return (
    <div className="card" style={{ marginBottom: 16, padding: 0 }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600 }}>Required spare parts</span>
        {canEdit && (
          <button className="btn btn-secondary btn-sm" onClick={() => setAdding(a => !a)}>
            {adding ? 'Cancel' : '+ Link part'}
          </button>
        )}
      </div>

      {err && <div style={{ padding: '8px 16px', color: 'var(--color-danger, #dc2626)', fontSize: 'var(--font-size-sm)' }}>{err}</div>}

      {loading ? (
        <div style={{ padding: '16px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>Loading…</div>
      ) : requirements.length === 0 ? (
        <div style={{ padding: '16px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
          No required parts linked yet.{canEdit ? ' Use "Link part" to specify what spare parts should always be on hand for this asset.' : ''}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr>
              <th>Part number</th>
              <th>Description</th>
              <th>Category</th>
              <th style={{ textAlign: 'center' }}>Qty needed</th>
              <th style={{ textAlign: 'center' }}>On hand</th>
              <th style={{ textAlign: 'center' }}>Status</th>
              {canEdit && <th />}
            </tr></thead>
            <tbody>
              {requirements.map(r => (
                <tr key={r.id}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{r.part.partNumber}</td>
                  <td>{r.part.description}</td>
                  <td>{r.part.category || <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                  <td style={{ textAlign: 'center' }}>{r.qtyRequired}</td>
                  <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{r.totalOnHand}</td>
                  <td style={{ textAlign: 'center' }}><StockBadge status={r.stockStatus} /></td>
                  {canEdit && (
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => removeRequirement(r.part.id)}>Remove</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && canEdit && (
        <AddPartRow assetId={assetId} onAdded={() => { setAdding(false); load(); }} />
      )}
    </div>
  );
}
