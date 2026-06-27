// ─────────────────────────────────────────────────────────────────────────────
// NameplateCard.jsx — the asset's saved nameplate: the photo next to the
// parsed fields (same shape as the nameplate-vision report), with the per-field
// confidence preserved as green/yellow/red dots and a "reviewed" stamp.
//
// Empty state offers "Scan nameplate" (opens NameplateReview). A saved card
// offers Re-scan (replace) and Remove (clear) — the latter is the fix for
// "this photo/data landed on the wrong asset": remove it here, rescan on the
// correct asset.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import api from '../api/client';
import NameplateReview from './NameplateReview';

const FIELDS = [
  ['manufacturer', 'Manufacturer'], ['model', 'Model'], ['serialNumber', 'Serial #'],
  ['voltage', 'Voltage'], ['kva', 'kVA'], ['amperage', 'Amperage'],
  ['phases', 'Phases'], ['frequency', 'Frequency'], ['year', 'Year'],
  ['enclosureRating', 'Enclosure'],
];
const DOT = { high: 'var(--chip-green-fg)', medium: 'var(--chip-amber-fg)', low: 'var(--chip-red-fg)' };

export default function NameplateCard({ asset, canEdit, onChanged }) {
  const [modal, setModal] = useState(false);
  const [photoUrl, setPhotoUrl] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const [busy, setBusy] = useState(false);

  const np = (asset?.nameplateData && typeof asset.nameplateData === 'object') ? asset.nameplateData : null;
  const scan = np?._scan || null;
  const photoKey = scan?.photoKey || null;
  const values = np ? Object.fromEntries(Object.entries(np).filter(([k]) => !k.startsWith('_'))) : {};
  const hasScan = !!scan;

  useEffect(() => {
    let url = null, cancelled = false;
    if (photoKey) {
      api.get('/api/documents/file', { params: { key: photoKey }, responseType: 'blob' })
        .then(r => { if (!cancelled) { url = URL.createObjectURL(r.data); setPhotoUrl(url); } })
        .catch(() => { if (!cancelled) setPhotoUrl(null); });
    } else setPhotoUrl(null);
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); };
  }, [photoKey]);

  async function remove() {
    setBusy(true);
    try { await api.delete(`/api/assets/${asset.id}/nameplate`); setConfirmDel(false); onChanged?.(); }
    catch { /* surfaced by parent refetch */ }
    finally { setBusy(false); }
  }

  const scannedAt = scan?.scannedAt ? new Date(scan.scannedAt).toLocaleDateString() : null;

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-body">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: hasScan ? 14 : 0 }}>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Nameplate</div>
          {hasScan && canEdit && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => setModal(true)} style={btnSm}>Re-scan</button>
              {!confirmDel
                ? <button onClick={() => setConfirmDel(true)} style={btnSmDanger}>Remove</button>
                : <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                    Wrong asset?
                    <button onClick={remove} disabled={busy} style={btnSmDanger}>{busy ? '…' : 'Yes, remove'}</button>
                    <button onClick={() => setConfirmDel(false)} style={btnSm}>Cancel</button>
                  </span>}
            </div>
          )}
        </div>

        {!hasScan && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
              No nameplate captured yet. {canEdit && 'Scan the plate to auto-fill the make, model, serial and ratings — you’ll review before it saves.'}
            </div>
            {canEdit && <button onClick={() => setModal(true)} style={btnPrimary}>📷 Scan nameplate</button>}
          </div>
        )}

        {hasScan && (
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {photoUrl
              ? <img src={photoUrl} alt="Saved equipment nameplate" style={{ width: 200, height: 150, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--color-border)', flex: '0 0 auto' }} />
              : <div style={{ width: 200, height: 150, borderRadius: 8, background: 'var(--color-surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--color-text-secondary)', fontSize: 12 }}>photo</div>}
            <div style={{ flex: '1 1 280px', minWidth: 0 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <tbody>
                  {FIELDS.filter(([k]) => values[k] != null && values[k] !== '').map(([k, label]) => {
                    const c = scan.confidence?.[k] || 'medium';
                    return (
                      <tr key={k}>
                        <td style={{ padding: '3px 8px 3px 0', fontSize: 11, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '.03em', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{label}</td>
                        <td style={{ padding: '3px 0', fontSize: 13.5, fontWeight: 500 }}>
                          <span title={c} style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 999, background: DOT[c], marginRight: 7, verticalAlign: 'middle' }} />
                          {String(values[k])}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {scannedAt && <div style={{ marginTop: 10, fontSize: 11, color: 'var(--color-text-secondary)' }}>Reviewed &amp; saved {scannedAt} · dots show the AI’s confidence at capture (green = verified)</div>}
            </div>
          </div>
        )}
      </div>

      {modal && (
        <NameplateReview
          assetId={asset.id}
          assetLabel={[asset.manufacturer, asset.model].filter(Boolean).join(' ') || asset.equipmentType || 'this asset'}
          onClose={() => setModal(false)}
          onSaved={() => { setModal(false); onChanged?.(); }}
        />
      )}
    </div>
  );
}

const btnPrimary = { padding: '8px 14px', borderRadius: 8, border: 'none', background: 'var(--color-primary)', color: '#fff', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const btnSm = { padding: '5px 10px', borderRadius: 6, border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text-secondary)', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
const btnSmDanger = { padding: '5px 10px', borderRadius: 6, border: '1px solid var(--chip-red-fg)', background: 'var(--color-surface)', color: 'var(--chip-red-fg)', fontWeight: 600, fontSize: 12, cursor: 'pointer' };
