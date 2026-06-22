import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

/**
 * Arc-flash Slice 2 — ingest + review panel (mounted on SiteDetail, behind the
 * arc_flash_studies flag). Upload a one-line / study report → SC extracts a
 * structured system model + per-bus IEEE 1584 gap punch list → review & confirm
 * → assets + (optionally) a study are created. The auto-generated Review Package
 * is the extract → findings → gap list → 2-question engineer ask.
 */

const EQUIP_TYPES = [
  'TRANSFORMER_LIQUID', 'TRANSFORMER_DRY', 'SWITCHGEAR', 'SWITCHBOARD', 'PANELBOARD', 'BUSWAY',
  'GENERATOR', 'MOTOR', 'MCC', 'VFD', 'UPS_BATTERY', 'CIRCUIT_BREAKER', 'DISCONNECT_SWITCH',
  'TRANSFER_SWITCH', 'CABLE_LV', 'CABLE_MV_HV',
];

const BAND_COLOR = { green: 'var(--color-success, #16a34a)', yellow: 'var(--color-warning, #c2410c)', red: 'var(--color-danger, #b91c1c)' };
const READY_LABEL = { ready: 'Ready', defaultable: 'Defaults applied', blocked: 'Blocked' };

function Chip({ band, children }) {
  return (
    <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#fff', background: BAND_COLOR[band] || 'var(--color-text-secondary)', padding: '2px 7px', borderRadius: 4, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  );
}

export default function ArcFlashIngestPanel({ siteId, canWrite = false }) {
  const [ingests, setIngests] = useState([]);
  const [draft, setDraft] = useState(null); // { ingest, buses, reviewPackage }
  const [file, setFile] = useState(null);
  const [sourceType, setSourceType] = useState('one_line');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [createStudy, setCreateStudy] = useState(true);
  const [confirmMsg, setConfirmMsg] = useState(null);

  const loadList = useCallback(() => {
    api.get('/api/arc-flash/ingests?siteId=' + siteId)
      .then(r => setIngests(r.data?.data?.ingests || []))
      .catch(() => setIngests([]));
  }, [siteId]);

  useEffect(() => { loadList(); }, [loadList]);

  const openDraft = useCallback((id) => {
    setConfirmMsg(null); setErr(null);
    api.get('/api/arc-flash/ingest/' + id)
      .then(r => setDraft(r.data?.data || null))
      .catch(() => setErr('Could not load draft.'));
  }, []);

  async function upload(e) {
    e.preventDefault();
    if (!file) { setErr('Choose a PDF study or PNG/JPG one-line first.'); return; }
    setBusy(true); setErr(null); setConfirmMsg(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('siteId', siteId);
      fd.append('sourceType', sourceType);
      const r = await api.post('/api/arc-flash/ingest', fd);
      const d = r.data?.data;
      loadList();
      if (d?.ingestId) {
        if (d.status === 'failed') setErr((d.warnings && d.warnings[0]) || 'Extraction failed.');
        openDraft(d.ingestId);
      }
      setFile(null);
    } catch (e2) {
      setErr(e2?.response?.data?.error || 'Upload failed.');
    } finally {
      setBusy(false);
    }
  }

  async function patchBus(busId, patch) {
    if (!draft) return;
    try {
      const r = await api.patch(`/api/arc-flash/ingest/${draft.ingest.id}/bus/${busId}`, patch);
      const updated = r.data?.data?.bus;
      const band = r.data?.data?.overallBand;
      setDraft(prev => prev ? {
        ...prev,
        ingest: { ...prev.ingest, overallBand: band ?? prev.ingest.overallBand, readyBusCount: r.data?.data?.readyBusCount ?? prev.ingest.readyBusCount },
        buses: prev.buses.map(b => (b.id === busId ? { ...b, ...updated } : b)),
      } : prev);
    } catch (e2) {
      setErr(e2?.response?.data?.error || 'Could not save edit.');
    }
  }

  async function confirm() {
    if (!draft) return;
    setBusy(true); setErr(null);
    try {
      const r = await api.post(`/api/arc-flash/ingest/${draft.ingest.id}/confirm`, { createStudy, studyType: 'arc_flash' });
      const d = r.data?.data;
      setConfirmMsg(`Created ${d.assetsCreated} asset(s), matched ${d.assetsMatched}, wired ${d.feedsWired} feed link(s)` + (d.studyId ? `, and a study covering ${d.boundCount} bus(es).` : '.'));
      openDraft(draft.ingest.id);
      loadList();
    } catch (e2) {
      setErr(e2?.response?.data?.error || 'Confirm failed.');
    } finally {
      setBusy(false);
    }
  }

  const card = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', marginTop: 16 };
  const rp = draft?.reviewPackage;
  const ing = draft?.ingest;
  const confirmed = ing?.status === 'confirmed';

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h3 style={{ margin: 0, fontSize: '0.95rem' }}>Import one-line / study → gap analysis</h3>
        <span style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)' }}>SC drafts the IEEE 1584 inputs; an engineer confirms.</span>
      </div>

      {canWrite && (
        <form onSubmit={upload} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" onChange={e => setFile(e.target.files?.[0] || null)} />
          <select value={sourceType} onChange={e => setSourceType(e.target.value)}>
            <option value="one_line">One-line diagram</option>
            <option value="study_report">Study report</option>
          </select>
          <button type="submit" className="btn" disabled={busy}>{busy ? 'Working…' : 'Extract'}</button>
        </form>
      )}

      {err && <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem', marginTop: 8 }}>{err}</div>}
      {confirmMsg && <div style={{ color: 'var(--color-success, #16a34a)', fontSize: '0.82rem', marginTop: 8, fontWeight: 600 }}>{confirmMsg}</div>}

      {/* Prior drafts */}
      {ingests.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <table className="data-table" style={{ width: '100%', fontSize: '0.74rem' }}>
            <thead><tr><th>Uploaded</th><th>File</th><th>Buses</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {ingests.map(i => (
                <tr key={i.id}>
                  <td>{new Date(i.createdAt).toLocaleDateString()}</td>
                  <td style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.fileName || '(upload)'}</td>
                  <td>{i.readyBusCount}/{i.totalBusCount} ready</td>
                  <td>{i.overallBand && <Chip band={i.overallBand}>{i.status === 'confirmed' ? 'confirmed' : i.status.replace('_', ' ')}</Chip>}</td>
                  <td><button className="btn-link" onClick={() => openDraft(i.id)} style={{ fontSize: '0.74rem' }}>Review</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Active draft */}
      {draft && ing && (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--color-border)', paddingTop: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <strong style={{ fontSize: '0.85rem' }}>{ing.fileName || 'Uploaded document'}</strong>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {ing.extractionMethod && <span style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)' }}>read via {ing.extractionMethod}</span>}
              {ing.overallBand && <Chip band={ing.overallBand}>{ing.readyBusCount}/{ing.totalBusCount} buses ready</Chip>}
            </span>
          </div>

          {/* Review Package — extract + the 2-question engineer ask */}
          {rp && (
            <div style={{ background: 'var(--color-bg, #fafafa)', border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', marginTop: 12, fontSize: '0.78rem' }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>{rp.title}</div>
              <div style={{ color: 'var(--color-text-secondary)', display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                {rp.extract.sourceVoltage && <span>Source: <strong>{rp.extract.sourceVoltage}</strong></span>}
                {rp.extract.mainTransformer && <span>Transformer: <strong>{rp.extract.mainTransformer}</strong></span>}
                {rp.extract.serviceFaultCurrentKA != null && <span>Service fault: <strong>{rp.extract.serviceFaultCurrentKA} kA</strong></span>}
                {rp.extract.study?.peName && <span>Study by: <strong>{rp.extract.study.peName}</strong></span>}
                <span>Buses: <strong>{rp.extract.busCount}</strong></span>
              </div>
              <ol style={{ margin: '8px 0 0', paddingLeft: 18 }}>
                {rp.engineerAsk.map((q, i) => <li key={i} style={{ marginBottom: 2 }}>{q}</li>)}
              </ol>
            </div>
          )}

          {/* Per-bus model + gaps */}
          <table className="data-table" style={{ width: '100%', fontSize: '0.74rem', marginTop: 12 }}>
            <thead><tr><th>Bus</th><th>Equipment</th><th>Voltage</th><th>Fed from</th><th>Readiness</th><th>Still needs</th>{!confirmed && canWrite && <th>Action</th>}</tr></thead>
            <tbody>
              {draft.buses.map(b => {
                const missing = (b.gaps?.missingRequired || []).map(f => (b.gaps?.fields || []).find(x => x.field === f)?.label || f);
                return (
                  <tr key={b.id}>
                    <td><strong>{b.busName}</strong></td>
                    <td>
                      {!confirmed && canWrite ? (
                        <select value={b.equipmentTypeGuess || ''} onChange={e => patchBus(b.id, { equipmentTypeGuess: e.target.value || null })} style={{ fontSize: '0.72rem', maxWidth: 150 }}>
                          <option value="">— set type —</option>
                          {EQUIP_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
                        </select>
                      ) : (b.equipmentTypeGuess?.replace(/_/g, ' ') || <span style={{ color: 'var(--color-danger)' }}>unset</span>)}
                    </td>
                    <td>
                      {!confirmed && canWrite ? (
                        <input defaultValue={b.nominalVoltage || ''} onBlur={e => { if ((e.target.value || null) !== b.nominalVoltage) patchBus(b.id, { nominalVoltage: e.target.value || null }); }} placeholder="e.g. 480V" style={{ width: 70, fontSize: '0.72rem' }} />
                      ) : (b.nominalVoltage || '-')}
                    </td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>{b.fedFromBusName || '-'}</td>
                    <td><Chip band={b.confidence}>{READY_LABEL[b.readiness] || b.readiness}</Chip></td>
                    <td style={{ color: missing.length ? 'var(--color-danger)' : 'var(--color-text-secondary)', maxWidth: 200 }}>{missing.length ? missing.join(', ') : '—'}</td>
                    {!confirmed && canWrite && (
                      <td>
                        <select value={b.resolution} onChange={e => patchBus(b.id, { resolution: e.target.value })} style={{ fontSize: '0.72rem' }}>
                          <option value="create">Create asset</option>
                          <option value="skip">Skip</option>
                          <option value="pending">Pending</option>
                        </select>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Confirm bar */}
          {!confirmed && canWrite && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              <label style={{ fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={createStudy} onChange={e => setCreateStudy(e.target.checked)} />
                Also create an arc-flash study from these inputs
              </label>
              <button className="btn" onClick={confirm} disabled={busy}>{busy ? 'Working…' : 'Confirm & create assets'}</button>
            </div>
          )}
          {confirmed && <div style={{ fontSize: '0.8rem', color: 'var(--color-success, #16a34a)', marginTop: 10, fontWeight: 600 }}>✓ Confirmed — assets {ing.producedStudyId ? 'and study ' : ''}created from this document.</div>}
        </div>
      )}
    </div>
  );
}
