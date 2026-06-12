// ─────────────────────────────────────────────────────────────────────────────
// FieldNewAsset.jsx — add a new piece of equipment from the field (/field/new).
//
// Pick where it lives (site is remembered across the session so adding several
// at one facility is one tap each) and what it is → create the asset → apply
// its NFPA 70B template task matrix → scan the nameplate (the same confidence-
// review modal as everywhere else) → land on the new asset's field card.
//
// The asset is created BEFORE the scan so the nameplate review can attach the
// photo + parsed fields to a real id. If the tech backs out of the scan, the
// bare asset (site + type + schedules) still stands — they can scan it later.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../api/client';
import { EQUIPMENT_TYPE_LABELS } from '../../lib/equipment';
import NameplateReview from '../../components/NameplateReview';

const LAST_SITE_KEY = 'sc_field_last_site';

export default function FieldNewAsset() {
  const navigate = useNavigate();
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newAssetId, setNewAssetId] = useState(null); // set after create → opens the scan modal

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
  }, []);

  const typeOptions = Object.entries(EQUIPMENT_TYPE_LABELS).sort((a, b) => a[1].localeCompare(b[1]));

  async function createAndScan() {
    if (!siteId) { setError('Pick a site first.'); return; }
    if (!equipmentType) { setError('Pick an equipment type.'); return; }
    setBusy(true); setError(null);
    try {
      const res = await api.post('/api/assets', { siteId, equipmentType });
      const asset = res.data?.data?.asset || res.data?.data;
      const aid = asset?.id;
      if (!aid) throw new Error('Create failed');
      try { localStorage.setItem(LAST_SITE_KEY, siteId); } catch (_e) { /* storage blocked */ }
      // Apply the NFPA 70B template task matrix for this equipment type (best-effort).
      api.post('/api/schedules/bulk-apply', { assetId: aid }).catch(() => {});
      setNewAssetId(aid); // opens the nameplate scan modal
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Could not create the asset — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: '0 auto' }}>
      <Link to="/field" style={{ fontSize: 14, color: 'var(--color-primary, #2563eb)' }}>← Back</Link>
      <h1 style={{ fontSize: 20, fontWeight: 700, margin: '12px 0 4px' }}>Add equipment</h1>
      <p style={{ fontSize: 13.5, color: 'var(--color-text-secondary)', marginTop: 0 }}>
        Pick where it lives and what it is, then snap the nameplate — AI fills in the make, model and ratings
        for you to confirm before it saves.
      </p>

      <label style={lbl}>Site</label>
      <select className="form-control" value={siteId} onChange={e => setSiteId(e.target.value)} style={{ width: '100%', minHeight: 48 }}>
        <option value="">— Select a site —</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      {siteId && <div style={{ fontSize: 12, color: '#15803d', marginTop: 4 }}>Remembered for your next add this session.</div>}

      <label style={lbl}>Equipment type</label>
      <select className="form-control" value={equipmentType} onChange={e => setEquipmentType(e.target.value)} style={{ width: '100%', minHeight: 48 }}>
        <option value="">— Select a type —</option>
        {typeOptions.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
      </select>

      {error && <div style={{ color: '#b91c1c', fontSize: 13.5, marginTop: 12 }}>{error}</div>}

      <button
        type="button"
        onClick={createAndScan}
        disabled={busy || !siteId || !equipmentType}
        style={{ width: '100%', padding: '14px', borderRadius: 10, border: 'none', marginTop: 18,
          background: (!siteId || !equipmentType) ? '#c4b5fd' : '#7c3aed', color: '#fff',
          fontWeight: 700, fontSize: 15, cursor: 'pointer', minHeight: 56 }}
      >
        {busy ? 'Creating…' : '📷 Create & scan nameplate'}
      </button>

      {newAssetId && (
        <NameplateReview
          assetId={newAssetId}
          assetLabel={EQUIPMENT_TYPE_LABELS[equipmentType] || 'new equipment'}
          onClose={() => navigate(`/field/asset/${newAssetId}`)}
          onSaved={() => navigate(`/field/asset/${newAssetId}`)}
        />
      )}
    </div>
  );
}

const lbl = { display: 'block', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em', color: 'var(--color-text-secondary)', marginBottom: 4, marginTop: 16 };
