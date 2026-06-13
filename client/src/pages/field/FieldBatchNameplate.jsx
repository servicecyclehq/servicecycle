// ─────────────────────────────────────────────────────────────────────────────
// FieldBatchNameplate.jsx — #13 batch nameplate capture (/field/batch).
//
// Walk the floor and build the register: pick a site + type once (both
// remembered), then tap "Add another" to create an asset, apply its 70B
// template, and open the same confidence-review scanner as everywhere else.
// On save it loops straight back so 30 nameplates is 30 taps, not 30 trips
// through the full new-asset form. A running list shows what's been captured.
//
// Reuses NameplateReview entirely (single-asset scan→review→save). The asset is
// created BEFORE the scan so the modal has a real id; bailing leaves a bare
// asset (site + type + schedules) that can be scanned later — same contract as
// FieldNewAsset.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../api/client';
import { EQUIPMENT_TYPE_LABELS } from '../../lib/equipment';
import NameplateReview from '../../components/NameplateReview';

const LAST_SITE_KEY = 'sc_field_last_site';
const LAST_TYPE_KEY = 'sc_field_last_type';

export default function FieldBatchNameplate() {
  const navigate = useNavigate();
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [activeAssetId, setActiveAssetId] = useState(null); // open scanner for this asset
  const [captured, setCaptured] = useState([]); // [{ id, label, scanned }]

  useEffect(() => {
    api.get('/api/sites')
      .then(r => {
        const list = r.data?.data?.sites || [];
        setSites(list);
        let last = null;
        try { last = localStorage.getItem(LAST_SITE_KEY); } catch (_e) { /* storage blocked */ }
        if (last && list.some(s => s.id === last)) setSiteId(last);
      })
      .catch(() => {});
    try {
      const lt = localStorage.getItem(LAST_TYPE_KEY);
      if (lt && EQUIPMENT_TYPE_LABELS[lt]) setEquipmentType(lt);
    } catch (_e) { /* storage blocked */ }
  }, []);

  const typeOptions = Object.entries(EQUIPMENT_TYPE_LABELS).sort((a, b) => a[1].localeCompare(b[1]));
  const typeLabel = equipmentType ? (EQUIPMENT_TYPE_LABELS[equipmentType] || equipmentType) : '';

  async function addAnother() {
    if (!siteId) { setError('Pick a site first.'); return; }
    if (!equipmentType) { setError('Pick an equipment type.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await api.post('/api/assets', { siteId, equipmentType });
      const asset = res.data?.data?.asset || res.data?.data;
      const aid = asset?.id;
      if (!aid) throw new Error('Create failed');
      try { localStorage.setItem(LAST_SITE_KEY, siteId); localStorage.setItem(LAST_TYPE_KEY, equipmentType); } catch (_e) { /* storage blocked */ }
      api.post('/api/schedules/bulk-apply', { assetId: aid }).catch(() => {}); // 70B template, best-effort
      setActiveAssetId(aid);
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Could not create the asset — try again.');
    } finally {
      setBusy(false);
    }
  }

  // Record the in-progress asset in the captured list (scanned flag from save),
  // then loop straight into the next capture for fast walk-the-floor flow.
  function finish(aid, scanned) {
    setCaptured(prev => prev.some(c => c.id === aid)
      ? prev.map(c => (c.id === aid ? { ...c, scanned: c.scanned || scanned } : c))
      : [...prev, { id: aid, label: typeLabel, scanned }]);
    setActiveAssetId(null);
  }

  const scannedCount = captured.filter(c => c.scanned).length;

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: '0 auto' }}>
      <Link to="/field" style={{ fontSize: 14, color: 'var(--color-primary, #2563eb)' }}>← Back</Link>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 4px' }}>Batch add equipment</h1>
      <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', marginTop: 0 }}>
        Pick the site and type once, then snap each nameplate and save — it loops back so you can walk the
        floor and build the register fast. Site and type are remembered between scans.
      </p>

      <label style={lbl}>Site</label>
      <select className="form-control" value={siteId} onChange={e => setSiteId(e.target.value)} style={sel}>
        <option value="">— Select a site —</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      <label style={lbl}>Equipment type</label>
      <select className="form-control" value={equipmentType} onChange={e => setEquipmentType(e.target.value)} style={sel}>
        <option value="">— Select a type —</option>
        {typeOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>
      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginTop: 4 }}>
        Change the type any time — each scan uses whatever is selected now.
      </div>

      {error && <div style={{ color: '#b91c1c', fontSize: 13.5, marginTop: 12 }}>{error}</div>}

      <button
        type="button"
        onClick={addAnother}
        disabled={busy || !siteId || !equipmentType}
        style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', marginTop: 18,
          background: (!siteId || !equipmentType) ? '#c4b5fd' : '#7c3aed', color: '#fff',
          fontWeight: 700, fontSize: 15, cursor: 'pointer', minHeight: 56 }}
      >
        {busy ? 'Creating…' : (captured.length ? '📷 Add another nameplate' : '📷 Start — add first nameplate')}
      </button>

      {captured.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
            Captured this session: {captured.length} ({scannedCount} with a nameplate)
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {captured.map((c, i) => (
              <Link key={c.id} to={`/field/asset/${c.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                  border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 13.5, color: 'var(--color-text)' }}>
                <span style={{ color: c.scanned ? '#15803d' : '#92400e', fontWeight: 700 }}>{c.scanned ? '✓' : '•'}</span>
                <span style={{ flex: 1 }}>{i + 1}. {c.label}{c.scanned ? '' : ' (no nameplate yet)'}</span>
                <span style={{ fontSize: 12, color: 'var(--color-primary, #2563eb)' }}>Open →</span>
              </Link>
            ))}
          </div>
          <button type="button" onClick={() => navigate('/field')}
            style={{ width: '100%', padding: '12px', borderRadius: 10, border: '1px solid var(--color-border)',
              background: '#fff', color: 'var(--color-text)', fontWeight: 700, fontSize: 15, cursor: 'pointer', marginTop: 14, minHeight: 52 }}>
            Done
          </button>
        </div>
      )}

      {activeAssetId && (
        <NameplateReview
          assetId={activeAssetId}
          assetLabel={typeLabel || 'new equipment'}
          onClose={() => finish(activeAssetId, false)}
          onSaved={() => finish(activeAssetId, true)}
        />
      )}
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-secondary)', marginBottom: 4, marginTop: 16 };
const sel = { width: '100%', minHeight: 48 };
