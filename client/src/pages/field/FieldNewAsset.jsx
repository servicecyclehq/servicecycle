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

import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../../api/client';
import { EQUIPMENT_TYPE_LABELS, matchEquipmentType } from '../../lib/equipment';
import NameplateReview from '../../components/NameplateReview';
import { useAuth } from '../../context/AuthContext';
import { useAiConsent } from '../../context/AiConsentContext';

const LAST_SITE_KEY = 'sc_field_last_site';

const CONF_META = {
  high:   { color: '#15803d', label: 'high confidence' },
  medium: { color: '#92400e', label: 'medium confidence — please confirm' },
  low:    { color: '#b91c1c', label: 'low confidence — please confirm' },
};

export default function FieldNewAsset() {
  const navigate = useNavigate();
  const { aiEnabled, aiConfigured, features } = useAuth();
  const { requestConsent } = useAiConsent();
  // Same gate as NewAsset's photo-identify panel: the feature, AI on, a provider
  // configured. Server enforces consent/quota/budget independently.
  const aiIdentifyAvailable = !!(features?.maintenance_brief && aiEnabled && aiConfigured);

  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const [equipmentType, setEquipmentType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newAssetId, setNewAssetId] = useState(null); // set after create → opens the scan modal

  // #12 AI type-guess: snap first, the type select pre-fills from the photo.
  const identifyInputRef = useRef(null);
  const [identifyBusy, setIdentifyBusy] = useState(false);
  const [identifyError, setIdentifyError] = useState(null);
  const [typeGuess, setTypeGuess] = useState(null); // { type, confidence, raw }
  const [dupWarn, setDupWarn] = useState(null); // #3/#6 identity-check best match

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

  function onIdentifyPick(e) {
    const f = e.target.files && e.target.files[0];
    if (f) requestConsent(() => runIdentify(f));
    if (identifyInputRef.current) identifyInputRef.current.value = '';
  }

  // Snap a photo → photo-inspect type guess → pre-select the equipment type
  // (confidence-flagged). The tech confirms by tapping Create & scan. The
  // detailed nameplate plate is captured by the NameplateReview modal after.
  async function runIdentify(file) {
    setIdentifyBusy(true); setIdentifyError(null); setDupWarn(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (siteId) fd.append('siteId', siteId);
      const res = await api.post('/api/assets/photo-inspect', fd);
      const ident = res.data?.data?.analysis?.identification || {};
      const typeKey = matchEquipmentType(ident.equipmentTypeGuess);
      if (typeKey) {
        setEquipmentType(typeKey);
        setTypeGuess({ type: typeKey, confidence: String(ident.confidence || '').toLowerCase(), raw: ident.equipmentTypeGuess });
      } else {
        setIdentifyError('Could not identify the type from that photo — pick it below.');
      }
      // #3/#6 warn-before-create: if the scanned serial already matches an asset,
      // offer to open it instead of spawning a duplicate.
      const serial = String(ident.serialNumber || '').trim();
      if (serial) {
        try {
          const chk = await api.post('/api/assets/identity-check', {
            serialNumber: serial, siteId: siteId || undefined, equipmentType: typeKey || undefined,
          });
          const d = chk.data?.data;
          if (d?.isDuplicate && d.best) setDupWarn(d.best);
        } catch (_e) { /* identity-check is advisory — never block create */ }
      }
    } catch (err) {
      const status = err.response?.status;
      const data = err.response?.data;
      if (status === 429 && data?.error === 'ai_daily_cap_reached') {
        const { count, cap } = data.data || {};
        setIdentifyError(`Daily AI limit reached${cap ? ` (${count}/${cap})` : ''} — pick the type below.`);
      } else {
        setIdentifyError(data?.error === 'ai_consent_required' ? 'AI consent is required — pick the type below.'
          : 'Could not identify from the photo — pick the type below.');
      }
    } finally {
      setIdentifyBusy(false);
    }
  }

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

      {aiIdentifyAvailable && (
        <>
          <label style={lbl}>Identify it for me (optional)</label>
          <input
            ref={identifyInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={onIdentifyPick}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => identifyInputRef.current && identifyInputRef.current.click()}
            disabled={identifyBusy}
            style={{ width: '100%', padding: '12px', borderRadius: 10, border: '1px solid #c4b5fd',
              background: '#f5f3ff', color: '#6d28d9', fontWeight: 700, fontSize: 14, cursor: 'pointer', minHeight: 48 }}
          >
            {identifyBusy ? 'Identifying…' : '📷 Snap to identify the type'}
          </button>
          {typeGuess && CONF_META[typeGuess.confidence] && (
            <div style={{ fontSize: 12.5, marginTop: 6, color: CONF_META[typeGuess.confidence].color }}>
              AI thinks: <strong>{EQUIPMENT_TYPE_LABELS[typeGuess.type] || typeGuess.type}</strong>
              {' '}· {CONF_META[typeGuess.confidence].label}. Confirm or change below.
            </div>
          )}
          {identifyError && <div style={{ fontSize: 12.5, marginTop: 6, color: '#b91c1c' }}>{identifyError}</div>}
        </>
      )}

      {dupWarn && (
        <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, border: '1px solid #fbbf24', background: '#fffbeb' }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: '#92400e' }}>You may already have this device</div>
          <div style={{ fontSize: 12.5, color: '#92400e', marginTop: 4 }}>
            That serial matches <strong>{dupWarn.label}</strong>
            {dupWarn.siteName ? ` at ${dupWarn.siteName}` : ''}
            {dupWarn.lastTestedAt ? ` (last tested ${new Date(dupWarn.lastTestedAt).toLocaleDateString()})` : ''}.
            {' '}Same device?
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" onClick={() => navigate(`/field/asset/${dupWarn.id}`)}
              style={{ padding: '8px 14px', borderRadius: 8, border: 'none', background: '#7c3aed', color: '#fff', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              Open {dupWarn.label} instead
            </button>
            <button type="button" onClick={() => setDupWarn(null)}
              style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #d6b91e', background: '#fff', color: '#92400e', fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
              No, it's a new asset
            </button>
          </div>
        </div>
      )}

      <label style={lbl}>Equipment type</label>
      <select className="form-control" value={equipmentType} onChange={e => { setEquipmentType(e.target.value); setTypeGuess(null); }} style={{ width: '100%', minHeight: 48 }}>
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
