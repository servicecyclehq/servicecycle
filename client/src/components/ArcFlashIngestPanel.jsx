import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import ArcFlashOneLine from './ArcFlashOneLine';

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

const HAZARD_COLOR = { DANGER: 'var(--color-danger, #b91c1c)', WARNING: 'var(--color-warning, #c2410c)' };

// Tiny inline spinner (reuses the global `spin` keyframe) for active button states.
function Spinner({ size = 12 }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: size, height: size, verticalAlign: '-1px', marginRight: 6,
      border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%',
      opacity: 0.85, animation: 'spin 0.7s linear infinite',
    }} />
  );
}

/**
 * Slice 2.7 — field-collection of the hard inputs (upstream device + trip
 * settings + feeder cable) that block a bus. Generate tasks from the gap list,
 * then record a device by hand or by photo-read; the bus re-gaps on submit.
 */
function FieldCollection({ ingest, canWrite, onChanged }) {
  const [tasks, setTasks] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [note, setNote] = useState(null);

  const load = useCallback(() => {
    api.get('/api/arc-flash/collection-tasks?ingestId=' + ingest.id)
      .then(r => setTasks(r.data?.data?.tasks || []))
      .catch(() => setTasks([]));
  }, [ingest.id]);
  useEffect(() => { load(); }, [load]);

  async function generate() {
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await api.post(`/api/arc-flash/ingest/${ingest.id}/collection-tasks`, {});
      const d = r.data?.data;
      setNote(d.created ? `Generated ${d.created} field task(s).` : (d.skipped ? `All blocked buses already have tasks (${d.skipped}).` : 'No blocked buses need collection.'));
      load();
    } catch (e) { setErr(e?.response?.data?.error || 'Could not generate tasks.'); }
    finally { setBusy(false); }
  }

  async function photoRead(taskId, fileEl) {
    const f = fileEl.files?.[0];
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      const fd = new FormData();
      fd.append('photo', f);
      const r = await api.post('/api/arc-flash/photo-read', fd);
      const dev = r.data?.data?.device || {};
      setForm(prev => ({
        ...prev,
        deviceType: dev.deviceType || prev.deviceType || '',
        sensorRatingA: dev.sensorRatingA ?? prev.sensorRatingA ?? '',
        manufacturer: dev.manufacturer || prev.manufacturer || '',
        model: dev.model || prev.model || '',
        settings: dev.settings ? JSON.stringify(dev.settings) : (prev.settings || ''),
      }));
      setNote('Photo read — review the pre-filled values, then save.');
    } catch (e) { setErr(e?.response?.data?.message || e?.response?.data?.error || 'Photo read unavailable.'); }
    finally { setBusy(false); }
  }

  async function collect(taskId) {
    setBusy(true); setErr(null); setNote(null);
    let settings = null;
    if (form.settings) { try { settings = JSON.parse(form.settings); } catch { setErr('Settings must be valid JSON, e.g. {"longTimePickup":0.9}'); setBusy(false); return; } }
    const device = {
      deviceType: form.deviceType || null, manufacturer: form.manufacturer || null, model: form.model || null,
      sensorRatingA: form.sensorRatingA || null, settings,
    };
    const cable = { cableSize: form.cableSize || null, cableLengthFt: form.cableLengthFt || null, cableMaterial: form.cableMaterial || null };
    try {
      await api.post(`/api/field/arc-flash/tasks/${taskId}/collect`, { device, cable });
      setOpenId(null); setForm({});
      load();
      if (onChanged) onChanged();
    } catch (e) { setErr(e?.response?.data?.error || 'Could not save collection.'); }
    finally { setBusy(false); }
  }

  const open = tasks.filter(t => t.status !== 'collected' && t.status !== 'cancelled');
  const done = tasks.filter(t => t.status === 'collected');
  const inp = { fontSize: '0.72rem', width: '100%', boxSizing: 'border-box' };

  return (
    <div style={{ marginTop: 14, borderTop: '1px dashed var(--color-border)', paddingTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <strong style={{ fontSize: '0.82rem' }}>Field collection — get the missing device + cable data</strong>
        {canWrite && <button className="btn-link" onClick={generate} disabled={busy} style={{ fontSize: '0.76rem' }}>{busy && <Spinner size={10} />}Generate field tasks from gaps</button>}
      </div>
      {note && <div style={{ color: 'var(--color-success, #16a34a)', fontSize: '0.76rem', marginTop: 6 }}>{note}</div>}
      {err && <div style={{ color: 'var(--color-danger)', fontSize: '0.76rem', marginTop: 6 }}>{err}</div>}

      {open.length === 0 && done.length === 0 && (
        <div style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary)', marginTop: 6 }}>No collection tasks yet. Generate them from the blocked buses above.</div>
      )}

      {open.map(t => (
        <div key={t.id} style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '8px 10px', marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontWeight: 700, fontSize: '0.78rem' }}>{t.busName}</span>
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {t.hazardClass && <span style={{ fontSize: '0.64rem', fontWeight: 700, color: '#fff', background: HAZARD_COLOR[t.hazardClass] || 'var(--color-text-secondary)', padding: '2px 6px', borderRadius: 4 }}>{t.hazardClass}</span>}
              {t.requiresOutage && <span style={{ fontSize: '0.64rem', color: 'var(--color-text-secondary)' }}>outage</span>}
              {t.requiresQualifiedPerson && <span style={{ fontSize: '0.64rem', color: 'var(--color-text-secondary)' }}>qualified person</span>}
            </span>
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary)', marginTop: 4 }}>{t.instructions}</div>
          {t.ppeNote && <div style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)', marginTop: 3, fontStyle: 'italic' }}>{t.ppeNote}</div>}
          {canWrite && (openId === t.id ? (
            <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 6 }}>
              <select style={inp} value={form.deviceType || ''} onChange={e => setForm({ ...form, deviceType: e.target.value })}>
                <option value="">device type</option><option value="breaker">breaker</option><option value="fuse">fuse</option><option value="relay">relay</option><option value="switch">switch</option>
              </select>
              <input style={inp} placeholder="sensor/plug A" value={form.sensorRatingA || ''} onChange={e => setForm({ ...form, sensorRatingA: e.target.value })} />
              <input style={inp} placeholder="manufacturer" value={form.manufacturer || ''} onChange={e => setForm({ ...form, manufacturer: e.target.value })} />
              <input style={inp} placeholder="model" value={form.model || ''} onChange={e => setForm({ ...form, model: e.target.value })} />
              <input style={{ ...inp, gridColumn: '1 / -1' }} placeholder='trip settings JSON, e.g. {"longTimePickup":0.9,"instantaneous":6}' value={form.settings || ''} onChange={e => setForm({ ...form, settings: e.target.value })} />
              <input style={inp} placeholder="cable size" value={form.cableSize || ''} onChange={e => setForm({ ...form, cableSize: e.target.value })} />
              <input style={inp} placeholder="cable ft" value={form.cableLengthFt || ''} onChange={e => setForm({ ...form, cableLengthFt: e.target.value })} />
              <input style={inp} placeholder="Cu/Al" value={form.cableMaterial || ''} onChange={e => setForm({ ...form, cableMaterial: e.target.value })} />
              <label className="btn-link" style={{ fontSize: '0.72rem', cursor: 'pointer', alignSelf: 'center' }}>
                Photo-read<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => photoRead(t.id, e.target)} />
              </label>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn-link" onClick={() => { setOpenId(null); setForm({}); }} style={{ fontSize: '0.74rem' }}>Cancel</button>
                <button className="btn" onClick={() => collect(t.id)} disabled={busy} style={{ fontSize: '0.74rem' }}>{busy ? <><Spinner size={10} />Saving…</> : 'Save device & re-gap'}</button>
              </div>
            </div>
          ) : (
            <button className="btn-link" onClick={() => { setOpenId(t.id); setForm({}); setNote(null); setErr(null); }} style={{ fontSize: '0.74rem', marginTop: 6 }}>Record device</button>
          ))}
        </div>
      ))}

      {done.length > 0 && <div style={{ fontSize: '0.72rem', color: 'var(--color-success, #16a34a)', marginTop: 8 }}>✓ Collected: {done.map(t => t.busName).join(', ')}</div>}
    </div>
  );
}

/**
 * Slice 2.8b — drift vs the prior confirmed revision for this site. Self-hides
 * unless there's a prior revision AND a material change (added/removed bus, or a
 * changed voltage / fault current / device / trip settings / topology). Surfaces
 * the re-study recommendation; a licensed PE decides whether to re-run.
 */
function fmtVal(v) { return v == null || v === '' ? '—' : (typeof v === 'object' ? JSON.stringify(v) : String(v)); }

function DriftBanner({ ingestId }) {
  const [drift, setDrift] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/api/arc-flash/ingest/${ingestId}/drift`)
      .then(r => { if (live) setDrift(r.data?.data?.drift || null); })
      .catch(() => {});
    return () => { live = false; };
  }, [ingestId]);

  if (!drift || !drift.hasPrior || !drift.materialChange) return null;

  return (
    <div style={{ border: '1px solid var(--color-warning, #c2410c)', background: 'var(--color-warning-bg, #fff7ed)', borderRadius: 6, padding: '10px 12px', marginTop: 12, fontSize: '0.78rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.66rem', fontWeight: 700, color: '#fff', background: 'var(--color-warning, #c2410c)', padding: '2px 7px', borderRadius: 4 }}>RE-STUDY RECOMMENDED</span>
        <strong>Change vs prior confirmed revision</strong>
      </div>
      <div style={{ color: 'var(--color-text-secondary)', marginTop: 6 }}>{drift.summary}</div>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
        {drift.busChanges.map((b, i) => (
          <li key={i} style={{ marginBottom: 3 }}>
            <strong>{b.busName}</strong> — {b.change}
            {b.fields && b.fields.length > 0 && (
              <span style={{ color: 'var(--color-text-secondary)' }}>: {b.fields.map(f => `${f.label} ${fmtVal(f.from)} → ${fmtVal(f.to)}${f.pct != null ? ` (${f.pct}%)` : ''}`).join('; ')}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Slice 2.8c — contradiction / sanity-check findings for the draft. Self-hides
 * when there are none. Errors = physically impossible / under-protective;
 * warnings = suspicious, confirm. SC raises the flag; the PE adjudicates.
 */
function SevTag({ severity }) {
  const isErr = severity === 'error';
  return <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: isErr ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)', padding: '1px 6px', borderRadius: 3 }}>{isErr ? 'ERROR' : 'CHECK'}</span>;
}

const TOPO_GAP_LABEL = {
  MISSED_FEED: 'Missed feed',
  INCOMPLETE_TRANSFER: 'Incomplete transfer',
  UNTRACED_ALTERNATE: 'Untraced alternate',
  REDUNDANCY_CONTRADICTION: 'Redundancy contradiction',
};

/**
 * Multi-source topology gap flags derived from the drawing at draft time. Errors here
 * are places where the extractor could not fully trace the redundant topology (a missed
 * second feed, a transfer switch with no traceable alternate, an untraced alternate
 * source, or a 2N/N+1 label the graph does not support) -- a human corrects the equipment
 * types + "fed from" below, then confirm persists the AssetFeed redundancy graph.
 */
function TopologyGapsPanel({ topology }) {
  if (!topology) return null;
  const gaps = Array.isArray(topology.gaps) ? topology.gaps : [];
  const feedCount = topology.feedCount || 0;
  const dual = Array.isArray(topology.dualCorded) ? topology.dualCorded : [];
  if (gaps.length === 0 && feedCount === 0) return null;
  const borderColor = gaps.length > 0 ? 'var(--color-warning, #c2410c)' : 'var(--color-border, #d1d5db)';
  return (
    <div style={{ border: `1px solid ${borderColor}`, borderRadius: 6, padding: '10px 12px', marginTop: 12, fontSize: '0.78rem' }}>
      <strong>Multi-source topology</strong>
      <span style={{ color: 'var(--color-text-secondary)', marginLeft: 8 }}>
        {feedCount} feed{feedCount === 1 ? '' : 's'}{dual.length > 0 ? `, ${dual.length} dual-corded` : ''}{gaps.length > 0 ? `, ${gaps.length} to review` : ', no gaps'}
      </span>
      {dual.length > 0 && (
        <div style={{ color: 'var(--color-text-secondary)', marginTop: 6, fontSize: '0.72rem' }}>Dual-corded: {dual.join(', ')}</div>
      )}
      {gaps.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
          {gaps.map((g, i) => (
            <li key={i} style={{ marginBottom: 4 }}>
              <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: 'var(--color-warning, #c2410c)', padding: '1px 6px', borderRadius: 3 }}>{TOPO_GAP_LABEL[g.code] || g.code}</span>{' '}
              <strong>{g.busName}</strong> - {g.message}
            </li>
          ))}
        </ul>
      )}
      <div style={{ color: 'var(--color-text-secondary)', marginTop: 6, fontSize: '0.7rem' }}>
        Derived from the drawing as a draft. Correct the equipment types and &ldquo;fed from&rdquo; below, then confirm to persist the redundancy graph. System of record - no study math.
      </div>
    </div>
  );
}

// [safety] Industry-standard caveat surfaced in the one-line / study ingest. Automated
// extraction is a strong DRAFT, not a verified model: even best-in-class tools in this
// field reach only ~90-95% accuracy and REQUIRE review by a qualified person -- the same
// human-sign-off policy we apply to arc-flash studies. Always shown while a draft is reviewed.
function ExtractionCaveat() {
  return (
    <div style={{ border: '1px solid var(--color-warning, #c2410c)', background: 'var(--color-warning-bg, #fff7ed)', borderRadius: 6, padding: '10px 12px', marginTop: 12, fontSize: '0.76rem', lineHeight: 1.5 }}>
      <strong>&#9888; AI draft &mdash; verify before confirming.</strong> Check every bus and connection against the source drawing. Requires qualified human review.
    </div>
  );
}

function ContradictionsPanel({ contradictions }) {
  const findings = contradictions?.findings || [];
  if (findings.length === 0) return null;
  const { errorCount = 0, warningCount = 0 } = contradictions;
  const borderColor = errorCount > 0 ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)';
  return (
    <div style={{ border: `1px solid ${borderColor}`, borderRadius: 6, padding: '10px 12px', marginTop: 12, fontSize: '0.78rem' }}>
      <strong>Sanity checks</strong>
      <span style={{ color: 'var(--color-text-secondary)', marginLeft: 8 }}>
        {errorCount > 0 ? `${errorCount} error${errorCount === 1 ? '' : 's'}` : ''}{errorCount > 0 && warningCount > 0 ? ', ' : ''}{warningCount > 0 ? `${warningCount} to confirm` : ''}
      </span>
      <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
        {findings.map((f, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <SevTag severity={f.severity} /> <strong>{f.busName}</strong> — {f.message}
            {f.detail && <span style={{ color: 'var(--color-text-secondary)' }}> ({f.detail})</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ArcFlashIngestPanel({ siteId, canWrite = false }) {
  const [ingests, setIngests] = useState([]);
  const [draft, setDraft] = useState(null); // { ingest, buses, reviewPackage }
  const [phase, setPhase] = useState(''); // '' | 'queued' | 'processing' — background worker progress
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

  // W1 part 2 (2026-07-14): extraction runs in a background worker; poll the
  // ingest until it leaves queued/processing, then open the finished draft.
  async function pollIngest(ingestId, intervalMs = 3000, timeoutMs = 10 * 60 * 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, intervalMs));
      let ing;
      try {
        const r = await api.get('/api/arc-flash/ingest/' + ingestId);
        ing = r.data?.data?.ingest;
      } catch (e2) {
        if (e2?.response?.status === 404) throw new Error('Ingest not found.');
        continue; // transient — keep polling
      }
      if (!ing) continue;
      if (ing.status !== 'queued' && ing.status !== 'processing' && ing.status !== 'extracting') return ing;
      setPhase(ing.status);
    }
    throw new Error('Extraction is taking longer than expected — reopen the draft from the list in a moment.');
  }

  async function upload(e) {
    e.preventDefault();
    if (!file) { setErr('Choose a PDF study or PNG/JPG one-line first.'); return; }
    setBusy(true); setErr(null); setConfirmMsg(null); setPhase('queued');
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('siteId', siteId);
      fd.append('sourceType', sourceType);
      // /ingest returns 202 { ingestId, status:'queued' } immediately; the heavy
      // native-PDF extraction runs in arcFlashIngestWorker. Poll for it rather
      // than holding one long request open.
      const r = await api.post('/api/arc-flash/ingest', fd);
      const enq = r.data?.data;
      setFile(null);
      if (!enq?.ingestId) throw new Error('Upload did not return an ingest id.');
      loadList();
      const ing = await pollIngest(enq.ingestId);
      loadList();
      if (ing.status === 'failed') setErr(ing.error || 'Extraction failed.');
      openDraft(enq.ingestId);
    } catch (e2) {
      setErr(e2?.response?.data?.error || e2?.message || 'Upload failed.');
    } finally {
      setBusy(false); setPhase('');
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
      setConfirmMsg(`Reused ${d.assetsMatched} existing asset(s), created ${d.assetsCreated} new, wired ${d.feedsWired} feed link(s)` + (d.studyId ? `, and a study covering ${d.boundCount} bus(es).` : '.'));
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
          <button type="submit" className="btn" disabled={busy}>{busy ? <><Spinner />Reading {sourceType === 'study_report' ? 'study' : 'one-line'}…</> : 'Extract'}</button>
        </form>
      )}

      {err && <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem', marginTop: 8 }}>{err}</div>}
      {confirmMsg && <div style={{ color: 'var(--color-success, #16a34a)', fontSize: '0.82rem', marginTop: 8, fontWeight: 600 }}>{confirmMsg}</div>}

      {/* Auto-built power-path one-line for the whole site */}
      <ArcFlashOneLine siteId={siteId} />

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

          {/* Drift vs the prior confirmed revision (re-study trigger) */}
          <DriftBanner ingestId={ing.id} key={ing.id} />

          {/* Contradiction / sanity-check findings */}
          {/* [safety] industry-standard AI-extraction caveat, always shown on a draft */}
          <ExtractionCaveat />
          <ContradictionsPanel contradictions={draft.contradictions} />

          {/* [multi-source topology] gap flags for human correction */}
          <TopologyGapsPanel topology={draft.topology} />

          {/* [dedupe visibility] reuse-vs-create summary BEFORE confirm */}
          {!confirmed && draft.dedupeSummary && draft.dedupeSummary.willReuse > 0 && (
            <div style={{ background: 'var(--color-success-bg, #ecfdf5)', border: '1px solid var(--color-success, #16a34a)', borderRadius: 6, padding: '8px 12px', marginTop: 12, fontSize: '0.75rem' }}>
              <strong>{draft.dedupeSummary.willReuse}</strong> bus(es) already exist on this site and will be reused; <strong>{draft.dedupeSummary.willCreate}</strong> new will be created. Confirming updates the existing assets instead of duplicating them.
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
                    <td>
                      <strong>{b.busName}</strong>
                      {b.dedupe?.willReuse
                        ? <div style={{ fontSize: '0.66rem', color: 'var(--color-success, #16a34a)', fontWeight: 600, marginTop: 2 }}>matches existing &middot; will reuse</div>
                        : (b.resolution === 'create' && <div style={{ fontSize: '0.66rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>new asset</div>)}
                    </td>
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

          {/* Field collection — close the blocked-bus gaps (device + cable) */}
          <FieldCollection ingest={ing} canWrite={canWrite} onChanged={() => openDraft(ing.id)} />

          {/* Confirm bar */}
          {!confirmed && canWrite && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              <label style={{ fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={createStudy} onChange={e => setCreateStudy(e.target.checked)} />
                Also create an arc-flash study from these inputs
              </label>
              <button className="btn btn-primary" onClick={confirm} disabled={busy}>{busy ? <><Spinner />Working…</> : 'Confirm & create assets'}</button>
            </div>
          )}
          {confirmed && <div style={{ fontSize: '0.8rem', color: 'var(--color-success, #16a34a)', marginTop: 10, fontWeight: 600 }}>✓ Confirmed — assets {ing.producedStudyId ? 'and study ' : ''}created from this document.</div>}
        </div>
      )}
    </div>
  );
}
