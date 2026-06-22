import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import ArcFlashTrend from './ArcFlashTrend';

// ─────────────────────────────────────────────────────────────────────────────
// Per-asset Arc Flash tab — the surface for the schema-bootstrap data layer.
// Pulls everything arc-flash about one asset from GET /api/arc-flash/asset/:id:
//   - the current NFPA 70E 130.5(H) label (voltage, boundary, incident energy,
//     PPE / arc rating, shock approach boundaries, DANGER/WARNING severity)
//   - IEEE 1584-2018 inputs (fault current, electrode config, gap, clearing time,
//     enclosure size, mitigation flags, dual-scenario)
//   - the source / system model (utility max/min + X/R, transformer, motor/gen)
//   - protective devices + open field-collection tasks
//   - NETA as-found/as-left device tests + a "study may be stale" flag
//   - the arc-flash custom-field long tail
// Plus the existing incident-energy trend card, and a print view.
// ─────────────────────────────────────────────────────────────────────────────

const ELECTRODE_LABEL = {
  VCB: 'VCB (vertical, in box)', VCBB: 'VCBB (vertical, barriered)', HCB: 'HCB (horizontal, in box)',
  VOA: 'VOA (vertical, open air)', HOA: 'HOA (horizontal, open air)',
};
const TRIP_LABEL = { none: 'None (fuse/switch)', thermal_magnetic: 'Thermal-magnetic', electronic_lsi: 'Electronic LSI', electronic_lsig: 'Electronic LSIG' };
const PPE_METHOD_LABEL = { incident_energy: 'Incident energy (arc rating)', ppe_category: 'PPE category (table)' };
const CALC_LABEL = { ieee_1584_2018: 'IEEE 1584-2018', lee_method: 'Lee method (>15 kV)', manufacturer_test: 'Manufacturer test' };
const ENCLOSURE_LABEL = { panelboard: 'Panelboard', mcc: 'MCC', lv_switchgear: 'LV switchgear', mv_switchgear: 'MV switchgear', cable: 'Cable', open_air: 'Open air', other: 'Other' };
const TEST_TYPE_LABEL = { relay_calibration: 'Relay calibration', breaker_trip_test: 'Breaker trip test', primary_injection: 'Primary injection', as_found_as_left: 'As-found / as-left', other: 'Other' };

function fmtDate(d) { try { return d ? new Date(d).toLocaleDateString() : '—'; } catch { return '—'; } }
function num(v, unit) { return (v == null || v === '') ? '—' : (unit ? `${v} ${unit}` : String(v)); }
function yn(v) { return v == null ? '—' : (v ? 'Yes' : 'No'); }

const card = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', marginTop: 16 };
const h3 = { margin: '0 0 10px', fontSize: '0.95rem' };
const dlGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px 18px', fontSize: '0.82rem' };
const dt = { color: 'var(--color-text-secondary)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.02em' };

function Field({ label, value }) {
  return (
    <div>
      <div style={dt}>{label}</div>
      <div style={{ fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function sevColor(s) { return s === 'danger' ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)'; }

// Slice 2.8a — per-bus confidence/trust band color (green/yellow/red).
function bandColor(b) { return b === 'green' ? '#15803d' : b === 'yellow' ? '#b45309' : '#b91c1c'; }

// Compact trust meter: "Trust 78%" pill, band-colored, hover shows the factor
// breakdown. Deterministic score from the API (study age, completeness, field
// verification, drift) — NOT a certification of the calculation.
function ConfidenceBadge({ c, size = 'md' }) {
  if (!c || typeof c.score !== 'number') return null;
  const pad = size === 'sm' ? '1px 6px' : '4px 10px';
  const fs = size === 'sm' ? '0.68rem' : '0.75rem';
  return (
    <span
      title={c.summary || ''}
      style={{ display: 'inline-block', fontSize: fs, fontWeight: 700, color: '#fff', background: bandColor(c.band), padding: pad, borderRadius: 4, whiteSpace: 'nowrap' }}
    >
      Trust {c.score}%{c.capped ? ' ⚠' : ''}
    </span>
  );
}

export default function ArcFlashAssetTab({ assetId, canWrite }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    api.get(`/api/arc-flash/asset/${assetId}`)
      .then(r => setData(r.data?.data || null))
      .catch(() => setErr('Could not load arc-flash data for this asset.'))
      .finally(() => setLoading(false));
  }, [assetId]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="card mb-16" style={{ padding: 16 }}>Loading arc-flash data…</div>;
  if (err) return <div role="alert" className="alert alert-error mb-16">{err}</div>;

  const current = data?.current || null;
  const sev = data?.labelSeverity;
  const src = current?.study?.sourceModel || null;

  return (
    <div id="arc-flash-asset-report">
      {/* Header / status */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ ...h3, marginBottom: 4 }}>Arc Flash</h3>
          <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
            NFPA 70E 130.5(H) label data + IEEE 1584-2018 study inputs. ServiceCycle is the data layer; a licensed PE runs and stamps the study.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <ConfidenceBadge c={data?.confidence} />
          {sev && (
            <span style={{ fontSize: '0.75rem', fontWeight: 700, color: '#fff', background: sevColor(sev), padding: '4px 10px', borderRadius: 4 }}>
              {sev === 'danger' ? 'DANGER' : 'WARNING'}
            </span>
          )}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      {data?.confidence?.summary && (
        <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 6 }}>
          Data confidence: {data.confidence.summary}
        </div>
      )}

      {data?.staleStudy && (
        <div className="alert alert-warning mb-16" role="alert" style={{ marginTop: 16 }}>
          A recorded device test shows settings drift (as-found ≠ as-left, or differs from the study). The incident-energy result may be stale — confirm the study is still valid.
        </div>
      )}

      {data?.contradictions?.length > 0 && (
        <div style={{ ...card, borderColor: data.contradictions.some(f => f.severity === 'error') ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)' }} role="alert">
          <h3 style={h3}>Sanity checks</h3>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.82rem' }}>
            {data.contradictions.map((f, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <span style={{ fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: f.severity === 'error' ? 'var(--color-danger, #b91c1c)' : 'var(--color-warning, #c2410c)', padding: '1px 6px', borderRadius: 3 }}>{f.severity === 'error' ? 'ERROR' : 'CHECK'}</span>
                {' '}{f.message}{f.detail ? <span style={{ color: 'var(--color-text-secondary)' }}> ({f.detail})</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {!data?.hasArcFlash && (
        <div style={{ ...card, color: 'var(--color-text-secondary)' }}>
          No arc-flash study data, devices, or tasks recorded for this asset yet. Upload a one-line or study report on the site to populate it.
        </div>
      )}

      {/* Current label */}
      {current && (
        <div style={card}>
          <h3 style={h3}>Current label{current.study?.superseded ? ' (latest study superseded)' : ''}</h3>
          <div style={dlGrid}>
            <Field label="Bus" value={current.busName || '—'} />
            <Field label="Nominal voltage" value={current.nominalVoltage || '—'} />
            <Field label="Incident energy" value={num(current.incidentEnergyCalCm2, 'cal/cm²')} />
            <Field label="Working distance" value={num(current.workingDistanceIn, 'in')} />
            <Field label="Arc-flash boundary" value={num(current.arcFlashBoundaryIn, 'in')} />
            <Field label="PPE method" value={current.ppeMethod ? PPE_METHOD_LABEL[current.ppeMethod] : '—'} />
            <Field label="PPE category" value={current.ppeCategory != null ? `Cat ${current.ppeCategory}` : '—'} />
            <Field label="Min arc rating" value={num(current.requiredArcRatingCalCm2, 'cal/cm²')} />
            <Field label="Limited approach" value={num(current.shockLimitedApproachIn, 'in')} />
            <Field label="Restricted approach" value={num(current.shockRestrictedApproachIn, 'in')} />
            <Field label="Calc method" value={current.calcMethod ? CALC_LABEL[current.calcMethod] : '—'} />
            <Field label="Study date" value={fmtDate(current.study?.performedDate)} />
            <Field label="Study expires" value={fmtDate(current.study?.expiresAt)} />
            <Field label="Engineer" value={current.study?.peName || current.study?.method || '—'} />
          </div>
        </div>
      )}

      {/* IEEE 1584 inputs */}
      {current && (
        <div style={card}>
          <h3 style={h3}>IEEE 1584-2018 inputs</h3>
          <div style={dlGrid}>
            <Field label="Bolted fault current" value={num(current.boltedFaultCurrentKA, 'kA')} />
            <Field label="Arcing current" value={num(current.arcingCurrentKA, 'kA')} />
            <Field label="Reduced arcing current" value={num(current.arcingCurrentReducedKA, 'kA')} />
            <Field label="Governing scenario" value={current.governingScenario || '—'} />
            <Field label="Electrode config" value={current.electrodeConfig ? (ELECTRODE_LABEL[current.electrodeConfig] || current.electrodeConfig) : '—'} />
            <Field label="Conductor gap" value={num(current.conductorGapMm, 'mm')} />
            <Field label="Clearing time" value={num(current.clearingTimeMs, 'ms')} />
            <Field label="Enclosure type" value={current.enclosureType ? ENCLOSURE_LABEL[current.enclosureType] : '—'} />
            <Field label="Enclosure H×W×D" value={[current.enclosureHeightMm, current.enclosureWidthMm, current.enclosureDepthMm].every(x => x == null) ? '—' : `${num(current.enclosureHeightMm)} × ${num(current.enclosureWidthMm)} × ${num(current.enclosureDepthMm)} mm`} />
          </div>
          <h4 style={{ margin: '14px 0 6px', fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>Upstream protective device</h4>
          <div style={dlGrid}>
            <Field label="Device" value={[current.deviceManufacturer, current.deviceModel].filter(Boolean).join(' ') || current.upstreamDevice || current.deviceType || '—'} />
            <Field label="Type" value={current.deviceType || '—'} />
            <Field label="Trip unit" value={current.tripUnitType ? TRIP_LABEL[current.tripUnitType] : '—'} />
            <Field label="Fuse class" value={current.fuseClass || '—'} />
            <Field label="Rating" value={num(current.deviceRatingA, 'A')} />
            <Field label="Feeder cable" value={current.cableSize ? `${current.cableSize}${current.cableMaterial ? ` ${current.cableMaterial}` : ''}${current.cableLengthFt != null ? `, ${current.cableLengthFt} ft` : ''}` : '—'} />
          </div>
          <h4 style={{ margin: '14px 0 6px', fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>Mitigation</h4>
          <div style={dlGrid}>
            <Field label="ERMS / maint. mode" value={yn(current.ermsPresent)} />
            <Field label="Zone interlock (ZSI)" value={yn(current.zsiEnabled)} />
            <Field label="Differential (87)" value={yn(current.differentialPresent)} />
            <Field label="Arc-resistant gear" value={yn(current.arcResistant)} />
            <Field label="NEC 240.87 method" value={current.nec24087Method || '—'} />
          </div>
        </div>
      )}

      {/* Source / system model */}
      {src && (
        <div style={card}>
          <h3 style={h3}>Source / system model (PCC)</h3>
          <div style={dlGrid}>
            <Field label="Utility max fault" value={num(src.utilityMaxFaultKA, 'kA')} />
            <Field label="Utility min fault" value={num(src.utilityMinFaultKA, 'kA')} />
            <Field label="Utility X/R" value={num(src.utilityXr)} />
            <Field label="Transformer" value={src.transformerKva != null ? `${src.transformerKva} kVA${src.transformerImpedancePct != null ? `, ${src.transformerImpedancePct}% Z` : ''}` : '—'} />
            <Field label="Transformer V" value={(src.transformerPrimaryV || src.transformerSecondaryV) ? `${num(src.transformerPrimaryV)} → ${num(src.transformerSecondaryV)} V` : '—'} />
            <Field label="Connection" value={src.transformerConnection || '—'} />
            <Field label="Motor contribution" value={src.motorContributionHp != null ? `${src.motorContributionHp} HP${src.motorContributionCount != null ? ` (${src.motorContributionCount})` : ''}` : '—'} />
            <Field label="Generator" value={src.generatorKva != null ? `${src.generatorKva} kVA` : '—'} />
            <Field label="<125 kVA flag" value={src.below125kvaFlag == null ? '—' : (src.below125kvaFlag ? 'Flagged — PE to verify (IEEE 1584-2018 §4.3)' : 'No')} />
          </div>
        </div>
      )}

      {/* Study coverage */}
      {data?.studyAssets?.length > 1 && (
        <div style={card}>
          <h3 style={h3}>Study coverage ({data.studyAssets.length})</h3>
          <table className="data-table" style={{ width: '100%', fontSize: '0.78rem' }}>
            <thead><tr><th>Study date</th><th>Method</th><th>IE (cal/cm²)</th><th>Severity</th><th>Trust</th><th>Status</th></tr></thead>
            <tbody>
              {data.studyAssets.map((s, i) => (
                <tr key={s.id || i}>
                  <td>{fmtDate(s.study?.performedDate)}</td>
                  <td>{s.study?.method || '—'}</td>
                  <td>{num(s.incidentEnergyCalCm2)}</td>
                  <td style={{ fontWeight: 600, color: s.labelSeverity ? sevColor(s.labelSeverity) : 'inherit' }}>{s.labelSeverity ? s.labelSeverity.toUpperCase() : '—'}</td>
                  <td>{s.confidence ? <ConfidenceBadge c={s.confidence} size="sm" /> : '—'}</td>
                  <td>{s.study?.superseded ? 'superseded' : 'current'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Protective devices */}
      {data?.devices?.length > 0 && (
        <div style={card}>
          <h3 style={h3}>Protective devices ({data.devices.length})</h3>
          <table className="data-table" style={{ width: '100%', fontSize: '0.78rem' }}>
            <thead><tr><th>Label</th><th>Type</th><th>Frame / sensor</th><th>Settings</th><th>Source</th></tr></thead>
            <tbody>
              {data.devices.map(d => (
                <tr key={d.id}>
                  <td>{d.label}</td>
                  <td>{d.deviceType || '—'}</td>
                  <td>{[d.frameRatingA, d.sensorRatingA].filter(x => x != null).map(x => `${x}A`).join(' / ') || '—'}</td>
                  <td>{d.settings ? 'recorded' : '—'}</td>
                  <td>{d.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Open collection tasks */}
      {data?.collectionTasks?.length > 0 && (
        <div style={card}>
          <h3 style={h3}>Open field-collection tasks ({data.collectionTasks.length})</h3>
          {data.collectionTasks.map(t => (
            <div key={t.id} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 8, marginTop: 8, fontSize: '0.8rem' }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <strong>{t.busName}</strong>
                {t.hazardClass && <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#fff', background: t.hazardClass === 'DANGER' ? 'var(--color-danger)' : 'var(--color-warning)', padding: '1px 6px', borderRadius: 3 }}>{t.hazardClass}</span>}
                {t.requiresOutage && <span style={{ fontSize: '0.68rem', color: 'var(--color-text-secondary)' }}>outage</span>}
              </div>
              <div style={{ color: 'var(--color-text-secondary)', marginTop: 2 }}>{t.instructions}</div>
            </div>
          ))}
        </div>
      )}

      {/* NETA device tests (as-found / as-left) */}
      <DeviceTests data={data} assetId={assetId} canWrite={canWrite} onChange={load} current={current} />

      {/* Arc-flash custom fields (long tail) */}
      {data?.customFields?.length > 0 && (
        <div style={card}>
          <h3 style={h3}>Arc-flash fields</h3>
          <div style={dlGrid}>
            {data.customFields.map(f => (
              <Field key={f.definitionId} label={f.name} value={f.value == null || f.value === '' ? '—' : f.value} />
            ))}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: 8 }}>
            Edit these in the asset Edit form. Admins define arc-flash fields under Settings → Custom Fields.
          </div>
        </div>
      )}

      {data?.mitigations?.options?.length > 0 && <MitigationCard assetId={assetId} mitigations={data.mitigations} current={current} canWrite={canWrite} />}

      {data?.current && <LabelPortal assetId={assetId} canWrite={canWrite} />}

      {canWrite && <TccLookup />}

      <ArcFlashTrend assetId={assetId} />
    </div>
  );
}

// Slice 4 / 4.5 — incident-energy-reduction upsell + what-if ROI. Lists applicable
// mitigations (request a quote) and models a user/PE-supplied reduction estimate.
function MitigationCard({ assetId, mitigations, current, canWrite }) {
  const [quoted, setQuoted] = useState({});
  const [wf, setWf] = useState({ pct: '', cost: '' });
  const [roi, setRoi] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function requestQuote(opt) {
    setErr('');
    try {
      await api.post('/api/quote-requests', {
        assetId, driver: 'failed_inspection', timeline: 'within_30_days', triggerType: 'ARC_FLASH_MITIGATION',
        notes: `Arc-flash incident-energy reduction: ${opt.label}. ${opt.mechanism}`,
      });
      setQuoted(q => ({ ...q, [opt.key]: true }));
    } catch (e) { setErr(e?.response?.data?.error || 'Could not submit the quote request.'); }
  }

  async function runWhatIf(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/api/arc-flash/asset/${assetId}/what-if`, { estReductionPct: wf.pct, mitigationCostUsd: wf.cost || undefined });
      setRoi(r.data?.data?.result || null);
    } catch (e2) { setErr(e2?.response?.data?.error || 'Could not model the mitigation.'); }
    finally { setBusy(false); }
  }

  const ie = current?.incidentEnergyCalCm2;
  return (
    <div style={card}>
      <h3 style={{ ...h3, marginBottom: 2 }}>Incident-energy reduction</h3>
      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: 10 }}>{mitigations.note}</div>

      {mitigations.options.map(o => (
        <div key={o.key} style={{ borderTop: '1px solid var(--color-border)', paddingTop: 8, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <strong style={{ fontSize: '0.84rem' }}>{o.label}
              <span style={{ marginLeft: 6, fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: o.category === 'reduce_energy' ? '#15803d' : '#2563eb', padding: '1px 6px', borderRadius: 3 }}>{o.category === 'reduce_energy' ? 'REDUCE ENERGY' : 'WORKER SAFETY'}</span>
            </strong>
            {canWrite && (quoted[o.key]
              ? <span style={{ fontSize: '0.76rem', color: 'var(--color-success, #16a34a)' }}>✓ Quote requested</span>
              : <button type="button" className="btn btn-secondary btn-sm" onClick={() => requestQuote(o)}>Request a quote</button>)}
          </div>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 3 }}>{o.mechanism}</div>
          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: 2, fontStyle: 'italic' }}>{o.caveat}</div>
        </div>
      ))}

      {/* What-if sandbox (4.5) */}
      {ie != null && (
        <div style={{ marginTop: 14, borderTop: '1px dashed var(--color-border)', paddingTop: 12 }}>
          <strong style={{ fontSize: '0.82rem' }}>What-if: model a reduction</strong>
          <div style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary)', margin: '2px 0 8px' }}>
            Current incident energy: <strong>{ie} cal/cm²</strong>. Enter your (or your PE's) expected reduction — ServiceCycle does the arithmetic, not the IEEE 1584 calc.
          </div>
          <form onSubmit={runWhatIf} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <input style={{ fontSize: '0.8rem', width: 130 }} placeholder="reduction %" value={wf.pct} onChange={e => setWf({ ...wf, pct: e.target.value })} />
            <input style={{ fontSize: '0.8rem', width: 150 }} placeholder="mitigation $ (optional)" value={wf.cost} onChange={e => setWf({ ...wf, cost: e.target.value })} />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !wf.pct}>{busy ? 'Modeling…' : 'Model'}</button>
          </form>
          {roi?.ok && (
            <div style={{ marginTop: 10, fontSize: '0.82rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '6px 16px' }}>
              <Field label="Incident energy after" value={`${roi.ieAfterCalCm2} cal/cm²`} />
              <Field label="Reduced by" value={`${roi.calReduced} cal/cm²`} />
              <Field label="Clears DANGER (>40)?" value={roi.removesDanger ? 'Yes' : 'No'} />
              <Field label="PPE category" value={`${roi.ppeBefore ?? '—'} → ${roi.ppeAfter ?? '—'}`} />
              {roi.costPerCalReduced != null && <Field label="$ / cal reduced" value={`$${roi.costPerCalReduced}`} />}
            </div>
          )}
          {roi?.ok && <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: 8, fontStyle: 'italic' }}>{roi.caveat}</div>}
        </div>
      )}

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}
    </div>
  );
}

// Slice 3.5d — published-TCC device lookup. Turn a nameplate into a structured
// device + curve reference + class-typical clearing time (verify against the TCC).
function TccLookup() {
  const [f, setF] = useState({ manufacturer: '', model: '', type: '', ratingA: '' });
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);

  async function search(e) {
    e.preventDefault();
    setBusy(true); setSearched(true);
    try {
      const params = {};
      for (const k of ['manufacturer', 'model', 'type', 'ratingA']) if (f[k]) params[k] = f[k];
      const r = await api.get('/api/arc-flash/tcc-library', { params });
      setOut(r.data?.data || null);
    } catch { setOut(null); }
    finally { setBusy(false); }
  }

  const inp = { fontSize: '0.8rem', padding: '5px 7px' };
  const matches = out?.matches || [];
  return (
    <div style={card}>
      <h3 style={{ ...h3, marginBottom: 2 }}>Published TCC lookup</h3>
      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
        Identify an upstream device from its nameplate and get its published-TCC reference + a class-typical clearing time. Verify against the manufacturer's TCC at the bus fault current.
      </div>
      <form onSubmit={search} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={inp} placeholder="manufacturer" value={f.manufacturer} onChange={e => setF({ ...f, manufacturer: e.target.value })} />
        <input style={inp} placeholder="model / series" value={f.model} onChange={e => setF({ ...f, model: e.target.value })} />
        <select style={inp} value={f.type} onChange={e => setF({ ...f, type: e.target.value })}>
          <option value="">any type</option><option value="breaker">breaker</option><option value="fuse">fuse</option>
        </select>
        <input style={{ ...inp, width: 90 }} placeholder="rating A" value={f.ratingA} onChange={e => setF({ ...f, ratingA: e.target.value })} />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>{busy ? 'Searching…' : 'Look up'}</button>
      </form>

      {searched && !busy && (matches.length > 0 ? (
        <table className="data-table" style={{ width: '100%', fontSize: '0.76rem', marginTop: 12 }}>
          <thead><tr><th>Device</th><th>Type</th><th>Frame (A)</th><th>Typical clearing</th><th>Published TCC</th></tr></thead>
          <tbody>
            {matches.map((m, i) => (
              <tr key={i}>
                <td><strong>{m.manufacturer}</strong> · {m.series}</td>
                <td>{m.deviceType}{m.tripUnitType ? ` (${TRIP_LABEL[m.tripUnitType] || m.tripUnitType})` : ''}{m.fuseClass ? ` Class ${m.fuseClass}` : ''}</td>
                <td>{m.frameMinA}–{m.frameMaxA}</td>
                <td>~{m.typicalClearingTimeMs} ms</td>
                <td style={{ color: 'var(--color-text-secondary)' }}>{m.curveRef}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 10 }}>No library match — record the device manually and attach the manufacturer's TCC.</div>
      ))}
    </div>
  );
}

// Slice 3.5c — issue / reprint the QR/NFC label. The QR encodes a public portal
// URL that resolves to the live record and flags a printed-vs-current mismatch.
function LabelPortal({ assetId, canWrite }) {
  const [out, setOut] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function issue() {
    setBusy(true); setErr('');
    try {
      const r = await api.post(`/api/arc-flash/asset/${assetId}/issue-label`, { origin: window.location.origin });
      setOut(r.data?.data || null);
    } catch (e) { setErr(e?.response?.data?.error || 'Could not issue the label.'); }
    finally { setBusy(false); }
  }
  if (!canWrite) return null;

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ ...h3, marginBottom: 2 }}>QR / NFC label</h3>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
            A scannable label that opens the live record — and warns when the printed sticker is out of date.
          </div>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={issue} disabled={busy}>{busy ? 'Working…' : (out ? 'Reprint' : 'Issue QR label')}</button>
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}

      {out && (
        <div style={{ marginTop: 12, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {out.qrDataUrl && <img src={out.qrDataUrl} alt="Arc flash label QR code" width={140} height={140} style={{ border: '1px solid var(--color-border)', borderRadius: 6 }} />}
          <div style={{ fontSize: '0.8rem' }}>
            <div style={{ color: 'var(--color-text-secondary)' }}>Scan to open the live label:</div>
            <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.74rem', marginTop: 4 }}>{out.url}</div>
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => window.print()}>Print</button>
          </div>
        </div>
      )}
    </div>
  );
}

// NETA as-found / as-left test records (slice G). Read list + a compact record
// form for managers — the headline value is drift detection -> stale study.
function DeviceTests({ data, assetId, canWrite, onChange, current }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ testType: 'as_found_as_left', performedBy: '', asFound: '', asLeft: '', matchesStudy: '', result: '', notes: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const tests = data?.deviceTests || [];

  function parseJson(s) {
    if (!s || !s.trim()) return undefined;
    try { return JSON.parse(s); } catch { return null; } // null signals invalid
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    const asFound = parseJson(form.asFound);
    const asLeft = parseJson(form.asLeft);
    if (asFound === null || asLeft === null) { setError('As-found / as-left settings must be valid JSON (e.g. {"ltPickupA":400}).'); return; }
    setSaving(true);
    try {
      await api.post('/api/arc-flash/device-tests', {
        siteId: current?.siteId || data?.siteId, assetId,
        testType: form.testType, performedBy: form.performedBy || undefined,
        asFoundSettings: asFound, asLeftSettings: asLeft,
        matchesStudy: form.matchesStudy === '' ? undefined : form.matchesStudy === 'yes',
        result: form.result || undefined, notes: form.notes || undefined,
      });
      setForm({ testType: 'as_found_as_left', performedBy: '', asFound: '', asLeft: '', matchesStudy: '', result: '', notes: '' });
      setOpen(false);
      onChange();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to record test.');
    } finally { setSaving(false); }
  }

  if (tests.length === 0 && !canWrite) return null;

  const inp = { width: '100%', fontSize: '0.8rem' };

  return (
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ ...h3, marginBottom: 0 }}>NETA test records {tests.length > 0 ? `(${tests.length})` : ''}</h3>
        {canWrite && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : 'Record test'}</button>}
      </div>

      {open && (
        <form onSubmit={submit} style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          {error && <div role="alert" className="alert alert-error">{error}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <label style={{ fontSize: '0.78rem' }}>Test type
              <select style={inp} value={form.testType} onChange={e => setForm(f => ({ ...f, testType: e.target.value }))}>
                {Object.entries(TEST_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '0.78rem' }}>Performed by
              <input style={inp} value={form.performedBy} onChange={e => setForm(f => ({ ...f, performedBy: e.target.value }))} />
            </label>
            <label style={{ fontSize: '0.78rem' }}>As-found settings (JSON)
              <input style={inp} placeholder='{"ltPickupA":400}' value={form.asFound} onChange={e => setForm(f => ({ ...f, asFound: e.target.value }))} />
            </label>
            <label style={{ fontSize: '0.78rem' }}>As-left settings (JSON)
              <input style={inp} placeholder='{"ltPickupA":320}' value={form.asLeft} onChange={e => setForm(f => ({ ...f, asLeft: e.target.value }))} />
            </label>
            <label style={{ fontSize: '0.78rem' }}>Matches study?
              <select style={inp} value={form.matchesStudy} onChange={e => setForm(f => ({ ...f, matchesStudy: e.target.value }))}>
                <option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
              </select>
            </label>
            <label style={{ fontSize: '0.78rem' }}>Result
              <input style={inp} placeholder="pass / fail / conditional" value={form.result} onChange={e => setForm(f => ({ ...f, result: e.target.value }))} />
            </label>
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving} style={{ justifySelf: 'start' }}>{saving ? 'Saving…' : 'Save test record'}</button>
        </form>
      )}

      {tests.length > 0 && (
        <table className="data-table" style={{ width: '100%', fontSize: '0.78rem', marginTop: 12 }}>
          <thead><tr><th>Date</th><th>Type</th><th>By</th><th>Result</th><th>Drift</th></tr></thead>
          <tbody>
            {tests.map(t => (
              <tr key={t.id}>
                <td>{fmtDate(t.testDate || t.createdAt)}</td>
                <td>{TEST_TYPE_LABEL[t.testType] || t.testType}</td>
                <td>{t.performedBy || '—'}</td>
                <td>{t.result || '—'}</td>
                <td style={{ fontWeight: 600, color: t.driftFlagged ? 'var(--color-danger)' : 'inherit' }}>{t.driftFlagged ? 'DRIFT' : 'ok'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
