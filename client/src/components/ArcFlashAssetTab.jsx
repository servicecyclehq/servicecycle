import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import ArcFlashTrend from './ArcFlashTrend';

// Parse a single field from a JSON settings string (used by the structured
// as-found / as-left trip-setting form; the stored format stays a JSON string).
function parseJsonField(jsonStr, key) {
  if (!jsonStr) return '';
  try {
    const obj = typeof jsonStr === 'string' ? JSON.parse(jsonStr) : jsonStr;
    return obj[key] ?? '';
  } catch { return ''; }
}

// Update a single field within a JSON settings string. Empty clears the key;
// numeric-looking values are coerced to numbers so the stored JSON stays typed.
function updateJsonFieldInStr(jsonStr, key, value) {
  let obj = {};
  try { obj = jsonStr ? JSON.parse(jsonStr) : {}; } catch {}
  if (value === '' || value === null || value === undefined) {
    delete obj[key];
  } else {
    obj[key] = isNaN(Number(value)) ? value : Number(value);
  }
  return JSON.stringify(obj);
}

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

function fmtDate(d) { try { if (!d) return '—'; const dt = new Date(d); if (Number.isNaN(dt.getTime())) return '—'; const utc = dt.getUTCHours()===0 && dt.getUTCMinutes()===0 && dt.getUTCSeconds()===0 && dt.getUTCMilliseconds()===0; return dt.toLocaleDateString(undefined, utc ? { timeZone: 'UTC' } : undefined); } catch { return '—'; } }
function num(v, unit) { return (v == null || v === '') ? '—' : (unit ? `${v} ${unit}` : String(v)); }
function yn(v) { return v == null ? '—' : (v ? 'Yes' : 'No'); }

// C2b: focused QR-label reprint -- arms print.css's body.print-focus-label
// mode so only the .print-label-sheet block prints, then disarms after the
// print dialog closes (afterprint fires on cancel too).
function printLabelSheet() {
  document.body.classList.add('print-focus-label');
  window.addEventListener('afterprint', () => document.body.classList.remove('print-focus-label'), { once: true });
  window.print();
}

// C2f: focused energized-work-permit print -- arms print.css's
// body.print-focus-permit mode so only the .print-permit-sheet subtree
// prints, isolating the signable NFPA 70E 130.2(B) permit from the rest of
// the arc-flash tab (same pattern as printLabelSheet() above).
function printPermitSheet() {
  document.body.classList.add('print-focus-permit');
  window.addEventListener('afterprint', () => document.body.classList.remove('print-focus-permit'), { once: true });
  window.print();
}

const card = { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '14px 16px', marginTop: 16 };
const h3 = { margin: '0 0 10px', fontSize: '0.95rem' };
const dlGrid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px 18px', fontSize: '0.82rem' };
const dt = { color: 'var(--color-text-secondary)', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.02em' };

// Tiny inline spinner reusing the global `spin` keyframe — pairs with the
// "Building…/Modeling…/Searching…/Working…" button labels for snappier feedback.
function Spinner({ size = 12 }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: size, height: size, verticalAlign: '-1px', marginRight: 6,
      border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%',
      opacity: 0.85, animation: 'spin 0.7s linear infinite',
    }} />
  );
}

// Shimmer placeholder bar for the loading skeleton card.
function SkeletonBar({ w = '100%', h = 12 }) {
  return <span style={{
    display: 'inline-block', width: w, height: h, borderRadius: 4,
    background: 'var(--color-border)', animation: 'sc-shimmer 1.2s ease-in-out infinite',
  }} />;
}

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
function bandColor(b) { return b === 'green' ? 'var(--chip-green-fg)' : b === 'yellow' ? 'var(--chip-amber-fg)' : 'var(--chip-red-fg)'; }

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

// Plain-English explainer for the "Data confidence" / Trust score — it's a
// ServiceCycle-derived data-trust measure, NOT an industry-standard term and NOT
// a certification of the calculation. Expands to show the factor breakdown.
function ConfidenceExplainer({ c }) {
  const [open, setOpen] = useState(false);
  if (!c || typeof c.score !== 'number') return null;
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
        Data confidence: {c.summary}{' '}
        <button type="button" className="btn-link" onClick={() => setOpen(o => !o)} style={{ fontSize: '0.74rem', padding: 0 }}>
          {open ? 'Hide' : "What's this?"}
        </button>
      </div>
      {open && (
        <div style={{ border: '1px solid var(--color-border)', borderRadius: 6, padding: '10px 12px', marginTop: 6, fontSize: '0.8rem', background: 'var(--color-surface)' }}>
          <p style={{ margin: '0 0 8px' }}>
            <strong>Data confidence</strong> is a ServiceCycle measure (0–100) of how much to trust this bus's posted arc-flash label <em>today</em> — judged on the data on file, not the calculation itself. Higher means the inputs are complete, the study is recent, and the upstream device was field-verified. It is <strong>not</strong> an IEEE or NFPA standard term and <strong>not</strong> a certification of the study — a licensed PE's stamped study is the authority.
          </p>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>How this {c.score}% breaks down:</div>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {(c.factors || []).map((f, i) => (
              <li key={i} style={{ marginBottom: 3 }}>
                <strong>{f.label}</strong>: {f.points}/{f.max} — {f.detail}
              </li>
            ))}
          </ul>
          {c.capped && <div style={{ marginTop: 6, color: 'var(--color-warning, #c2410c)' }}>Capped below “high” because device-setting drift is flagged.</div>}
        </div>
      )}
    </div>
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

  if (loading) return (
    <div id="arc-flash-asset-report" aria-busy="true" aria-label="Loading arc-flash data">
      <style>{'@keyframes sc-shimmer{0%{opacity:.55}50%{opacity:1}100%{opacity:.55}}'}</style>
      <div style={{ ...card, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ flex: '1 1 240px' }}>
          <SkeletonBar w={120} h={15} />
          <div style={{ marginTop: 8 }}><SkeletonBar w="90%" h={10} /></div>
        </div>
        <SkeletonBar w={92} h={24} />
      </div>
      <div style={card}>
        <div style={{ ...dlGrid, marginTop: 0 }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i}><SkeletonBar w="55%" h={9} /><div style={{ marginTop: 6 }}><SkeletonBar w="80%" h={12} /></div></div>
          ))}
        </div>
      </div>
    </div>
  );
  if (err) return <div role="alert" className="alert alert-error mb-16">{err}</div>;

  const current = data?.current || null;
  const sev = data?.labelSeverity;
  const src = current?.study?.sourceModel || null;

  return (
    <div id="arc-flash-asset-report" className="print-doc">
      {/* C2b: shared Field Report print standard (styles/print.css) */}
      <header className="print-masthead print-only">
        <h1 className="print-masthead-title">Arc Flash Report</h1>
        <div className="print-masthead-meta">
          {current?.busName || 'Asset'}<br />
          Generated {new Date().toLocaleDateString()}
        </div>
      </header>
      <div className="print-rule print-only"></div>

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
          {data?.current && <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadAuthedFile(`/api/arc-flash/asset/${assetId}/label.pdf`, `arc-flash-label.pdf`).catch(() => {})} title="Download a print-ready NFPA 70E label (4x6)">Label PDF</button>}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>Print</button>
        </div>
      </div>

      <ConfidenceExplainer c={data?.confidence} />

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
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Current label</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">Current label{current.study?.superseded ? ' (latest study superseded)' : ''}</h3>
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
        </section>
      )}

      {/* IEEE 1584 inputs */}
      {current && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">IEEE 1584-2018 inputs</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">IEEE 1584-2018 inputs</h3>
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
        </section>
      )}

      {/* Source / system model */}
      {src && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Source / system model (PCC)</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">Source / system model (PCC)</h3>
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
        </section>
      )}

      {/* Study coverage */}
      {data?.studyAssets?.length > 1 && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Study coverage</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">Study revisions ({data.studyAssets.length}) — newest first</h3>
          <table className="data-table print-table" style={{ width: '100%', fontSize: '0.78rem' }}>
            <thead><tr><th>Study date</th><th>Method</th><th>IE (cal/cm²)</th><th>PE</th><th>Reason</th><th>Severity</th><th>Trust</th><th>Status</th></tr></thead>
            <tbody>
              {data.studyAssets.map((s, i) => (
                <tr key={s.id || i}>
                  <td>{fmtDate(s.study?.performedDate)}</td>
                  <td>{s.study?.method || '—'}</td>
                  <td>{num(s.incidentEnergyCalCm2)}</td>
                  <td>{s.study?.peName || '—'}</td>
                  <td style={{ color: 'var(--color-text-secondary)' }}>{s.study?.trigger ? String(s.study.trigger).replace(/_/g, ' ') : '—'}</td>
                  <td style={{ fontWeight: 600, color: s.labelSeverity ? sevColor(s.labelSeverity) : 'inherit' }}>{s.labelSeverity ? s.labelSeverity.toUpperCase() : '—'}</td>
                  <td>{s.confidence ? <ConfidenceBadge c={s.confidence} size="sm" /> : '—'}</td>
                  <td>{s.study?.superseded ? 'superseded' : 'current'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </section>
      )}

      {/* Protective devices */}
      {data?.devices?.length > 0 && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Protective devices</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">Protective devices ({data.devices.length})</h3>
          <table className="data-table print-table" style={{ width: '100%', fontSize: '0.78rem' }}>
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
        </section>
      )}

      {/* Open collection tasks */}
      {data?.collectionTasks?.length > 0 && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Open field-collection tasks</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">Open field-collection tasks ({data.collectionTasks.length})</h3>
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
        </section>
      )}

      {/* NETA device tests (as-found / as-left) */}
      <DeviceTests data={data} assetId={assetId} canWrite={canWrite} onChange={load} current={current} />

      {/* Arc-flash custom fields (long tail) */}
      {data?.customFields?.length > 0 && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Arc-flash fields</h2>
        </div>
        <div style={card}>
          <h3 style={h3} className="no-print">Arc-flash fields</h3>
          <div style={dlGrid}>
            {data.customFields.map(f => (
              <Field key={f.definitionId} label={f.name} value={f.value == null || f.value === '' ? '—' : f.value} />
            ))}
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: 8 }}>
            Edit these in the asset Edit form. Admins define arc-flash fields under Settings → Custom Fields.
          </div>
        </div>
        </section>
      )}

      {data?.mitigations?.options?.length > 0 && <div className="no-print"><MitigationCard assetId={assetId} mitigations={data.mitigations} current={current} canWrite={canWrite} /></div>}

      {data?.current && <PermitCard assetId={assetId} />}

      {data?.current && <LabelPortal assetId={assetId} canWrite={canWrite} />}

      {canWrite && <div className="no-print"><TccLookup /></div>}

      <ArcFlashTrend assetId={assetId} />

      <ArcFlashTimelineCard assetId={assetId} />

      <IncidentsCard assetId={assetId} incidents={data?.incidents || []} canWrite={canWrite} onChange={load} />

      <footer className="print-footer print-only">
        <span>ServiceCycle</span>
        <span className="print-footer-pages">Generated {new Date().toLocaleDateString()}</span>
      </footer>
    </div>
  );
}

// Arc-flash incident / near-miss register. Manual entry (manager+); on log the
// server snapshots the current label/study state so the record self-contextualizes.
// SC stores the customer's record and makes no fault or preventability call.
const INCIDENT_TYPE_LABEL = { near_miss: 'Near miss', arc_flash: 'Arc flash', shock: 'Shock', equipment_failure: 'Equipment failure', other: 'Other' };
const WORK_TYPE_LABEL = { energized: 'Energized', de_energized: 'De-energized', inspection: 'Inspection', other: 'Other' };
const INC_EMPTY = { incidentType: 'near_miss', occurredAt: '', description: '', injury: false, injuryDetail: '', ppeWorn: '', workType: '', oshaRecordable: '', correctiveAction: '' };
function IncidentsCard({ assetId, incidents, canWrite, onChange }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [form, setForm] = useState(INC_EMPTY);
  const inp = { width: '100%', padding: '5px 8px', fontSize: '0.82rem', border: '1px solid var(--color-border)', borderRadius: 4, marginTop: 3, background: 'var(--color-bg)', color: 'var(--color-text)' };

  async function submit(e) {
    e.preventDefault();
    if (!form.description.trim()) { setErr('Describe what happened.'); return; }
    setSaving(true); setErr('');
    try {
      await api.post(`/api/arc-flash/asset/${assetId}/incidents`, {
        incidentType: form.incidentType,
        occurredAt: form.occurredAt || undefined,
        description: form.description,
        injury: !!form.injury,
        injuryDetail: form.injuryDetail || undefined,
        ppeWorn: form.ppeWorn || undefined,
        workType: form.workType || undefined,
        oshaRecordable: form.oshaRecordable === '' ? undefined : form.oshaRecordable === 'yes',
        correctiveAction: form.correctiveAction || undefined,
      });
      setForm(INC_EMPTY); setOpen(false);
      onChange && onChange();
    } catch {
      setErr('Could not log the incident.');
    } finally { setSaving(false); }
  }

  return (
    <section className="print-sec">
    <div className="print-sec-head print-only">
      <span className="print-sec-no" />
      <h2 className="print-sec-title">Incidents &amp; near-misses</h2>
    </div>
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ ...h3, marginBottom: 0 }} className="no-print">Incidents &amp; near-misses{incidents.length > 0 ? ` (${incidents.length})` : ''}</h3>
        {canWrite && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(o => !o)}>{open ? 'Cancel' : 'Log an event'}</button>}
      </div>
      <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', marginTop: 4 }}>
        A record of arc-flash events and near-misses on this equipment. Logged by your team; ServiceCycle snapshots the label/study state at the time of each event.
      </div>

      {open && canWrite && (
        <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 12 }}>
          {err && <div role="alert" className="alert alert-error" style={{ fontSize: '0.78rem' }}>{err}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <label style={{ fontSize: '0.78rem' }}>Type
              <select style={inp} value={form.incidentType} onChange={e => setForm(f => ({ ...f, incidentType: e.target.value }))}>
                {Object.entries(INCIDENT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '0.78rem' }}>When
              <input type="date" style={inp} value={form.occurredAt} onChange={e => setForm(f => ({ ...f, occurredAt: e.target.value }))} />
            </label>
            <label style={{ fontSize: '0.78rem' }}>Work type
              <select style={inp} value={form.workType} onChange={e => setForm(f => ({ ...f, workType: e.target.value }))}>
                <option value="">—</option>
                {Object.entries(WORK_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label style={{ fontSize: '0.78rem' }}>OSHA recordable?
              <select style={inp} value={form.oshaRecordable} onChange={e => setForm(f => ({ ...f, oshaRecordable: e.target.value }))}>
                <option value="">Unknown</option><option value="yes">Yes</option><option value="no">No</option>
              </select>
            </label>
          </div>
          <label style={{ fontSize: '0.78rem' }}>What happened
            <textarea style={{ ...inp, minHeight: 60 }} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="Plain-English description of the event" />
          </label>
          <label style={{ fontSize: '0.78rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="checkbox" checked={form.injury} onChange={e => setForm(f => ({ ...f, injury: e.target.checked }))} />
            An injury occurred
          </label>
          {form.injury && (
            <label style={{ fontSize: '0.78rem' }}>Injury detail
              <input style={inp} value={form.injuryDetail} onChange={e => setForm(f => ({ ...f, injuryDetail: e.target.value }))} />
            </label>
          )}
          <label style={{ fontSize: '0.78rem' }}>PPE worn
            <input style={inp} value={form.ppeWorn} onChange={e => setForm(f => ({ ...f, ppeWorn: e.target.value }))} placeholder="e.g. Cat 2 arc-rated PPE" />
          </label>
          <label style={{ fontSize: '0.78rem' }}>Corrective action
            <input style={inp} value={form.correctiveAction} onChange={e => setForm(f => ({ ...f, correctiveAction: e.target.value }))} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving} style={{ justifySelf: 'start' }}>{saving ? 'Saving…' : 'Save event'}</button>
        </form>
      )}

      {incidents.length > 0 ? (
        <table className="data-table" style={{ width: '100%', fontSize: '0.78rem', marginTop: 12 }}>
          <thead><tr><th>When</th><th>Type</th><th>What happened</th><th>Injury</th><th>Label then</th></tr></thead>
          <tbody>
            {incidents.map(i => (
              <tr key={i.id}>
                <td>{fmtDate(i.occurredAt || i.createdAt)}</td>
                <td>{INCIDENT_TYPE_LABEL[i.incidentType] || i.incidentType}</td>
                <td style={{ maxWidth: 280 }}>{i.description}</td>
                <td style={{ fontWeight: 600, color: i.injury ? 'var(--color-danger)' : 'inherit' }}>{i.injury ? 'YES' : 'no'}</td>
                <td>{i.studyStateSnapshot ? `${num(i.studyStateSnapshot.incidentEnergyCalCm2, 'cal/cm²')}${i.studyStateSnapshot.studyExpired ? ' · study expired' : ''}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginTop: 10 }}>No events logged.</div>
      )}
    </div>
    </section>
  );
}

// Slice 11 — time-machine: the bus's arc-flash history as one chronological
// stream. Self-loads; hides entirely when there's nothing to show.
const TL_DOT = { study: 'var(--chip-blue-fg)', label_printed: 'var(--chip-green-fg)', device_test: 'var(--chip-amber-fg)', device_collected: 'var(--chip-slate-fg)' };
function ArcFlashTimelineCard({ assetId }) {
  const [events, setEvents] = useState(null);
  useEffect(() => {
    let live = true;
    api.get(`/api/arc-flash/asset/${assetId}/timeline`)
      .then(r => { if (live) setEvents(r.data?.data?.events || []); })
      .catch(() => { if (live) setEvents([]); });
    return () => { live = false; };
  }, [assetId]);

  if (!events || events.length === 0) return null;
  return (
    <section className="print-sec">
    <div className="print-sec-head print-only">
      <span className="print-sec-no" />
      <h2 className="print-sec-title">History timeline</h2>
    </div>
    <div style={card}>
      <h3 style={h3} className="no-print">History timeline ({events.length})</h3>
      <div style={{ position: 'relative', paddingLeft: 18 }}>
        {events.map((e, i) => (
          <div key={i} style={{ position: 'relative', paddingBottom: 12 }}>
            <span style={{ position: 'absolute', left: -18, top: 3, width: 9, height: 9, borderRadius: '50%', background: TL_DOT[e.type] || 'var(--chip-slate-fg)', boxShadow: '0 0 0 2px var(--color-surface)' }} />
            {i < events.length - 1 && <span style={{ position: 'absolute', left: -14, top: 12, bottom: 0, width: 1, background: 'var(--color-border)' }} />}
            <div style={{ fontSize: '0.74rem', color: 'var(--color-text-secondary)' }}>{fmtDate(e.date)}</div>
            <div style={{ fontSize: '0.84rem', fontWeight: 600, color: e.severity === 'danger' ? 'var(--color-danger, #b91c1c)' : 'inherit' }}>{e.title}</div>
            {e.detail && <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>{e.detail}</div>}
          </div>
        ))}
      </div>
    </div>
    </section>
  );
}

// Slice 5 — energized-work-permit (NFPA 70E 130.2(B)) pre-fill + issuance gate.
function PermitCard({ assetId }) {
  const [permit, setPermit] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function generate() {
    setBusy(true); setErr('');
    try {
      const r = await api.get(`/api/arc-flash/asset/${assetId}/permit`);
      setPermit(r.data?.data?.permit || null);
    } catch (e) { setErr(e?.response?.data?.error || 'Could not build the permit.'); }
    finally { setBusy(false); }
  }

  const h = permit?.hazard || {};
  const canIssue = permit?.validation?.canIssue;
  // Reused verbatim in both the screen and print renderings below -- same
  // expression, no new/altered content.
  const equipmentId = permit ? ([permit.equipment.busName, permit.equipment.equipmentType].filter(Boolean).join(' · ') || '—') : '—';
  return (
    <div style={card} id="arc-flash-permit">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ ...h3, marginBottom: 2 }}>Energized-work permit</h3>
          <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>NFPA 70E 130.2(B) — pre-filled from the current study, with an issuance check.</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={generate} disabled={busy}>{busy ? <><Spinner />Building…</> : (permit ? 'Refresh' : 'Generate permit')}</button>
          {/* C2f: focused print -- isolates just this permit via
              body.print-focus-permit instead of raw window.print() (which
              printed the whole tab, per the C0 finding). */}
          {permit && <button type="button" className="btn btn-secondary btn-sm" onClick={printPermitSheet}>Print</button>}
        </div>
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}

      {permit && (
        <>
          <div className="no-print">
            {canIssue ? (
              <div className="alert alert-success" style={{ marginTop: 12 }}>Study is valid — permit may be issued. A qualified person and the responsible manager complete and sign it.</div>
            ) : (
              <div className="alert alert-error" style={{ marginTop: 12 }}>
                <strong>Do not issue — study not valid:</strong>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{permit.validation.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </div>
            )}

            <div style={{ marginTop: 12, ...dlGrid }}>
              <Field label="Equipment" value={equipmentId} />
              <Field label="Voltage" value={permit.equipment.nominalVoltage || '—'} />
              <Field label="Incident energy" value={num(h.incidentEnergyCalCm2, 'cal/cm²')} />
              <Field label="Arc-flash boundary" value={num(h.arcFlashBoundaryIn, 'in')} />
              <Field label="Limited approach" value={num(h.shockLimitedApproachIn, 'in')} />
              <Field label="Restricted approach" value={num(h.shockRestrictedApproachIn, 'in')} />
              <Field label="PPE category" value={h.ppeCategory != null ? `Cat ${h.ppeCategory}` : '—'} />
              <Field label="Min arc rating" value={num(h.requiredArcRatingCalCm2, 'cal/cm²')} />
              <Field label="Hazard class" value={h.hazardClass || '—'} />
              <Field label="Study date" value={fmtDate(permit.study.performedDate)} />
              <Field label="Study expires" value={fmtDate(permit.study.expiresAt)} />
              <Field label="Engineer" value={permit.study.peName || permit.study.method || '—'} />
            </div>

            <h4 style={{ margin: '14px 0 6px', fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>To complete on the permit</h4>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: '0.8rem' }}>
              {permit.toComplete.map((t, i) => <li key={i} style={{ marginBottom: 2 }}>{t}</li>)}
            </ul>
            <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: 8, fontStyle: 'italic' }}>{permit.disclaimer}</div>
          </div>

          {/* C2f: print-only standalone permit document -- masthead, hairline
              table, checklist, signature lines, footer, all from the shared
              print.css vocabulary (client/src/styles/print.css). Same field
              values and wording as the screen version above -- visual
              framing only, no regulatory content added, changed, or removed. */}
          <div className="print-permit-sheet print-only">
            <header className="print-masthead">
              <h1 className="print-masthead-title">Energized-work permit</h1>
              <div className="print-masthead-meta">
                NFPA 70E 130.2(B)<br />
                {equipmentId}<br />
                Generated {fmtDate(new Date())}
              </div>
            </header>
            <div className="print-rule"></div>

            <p style={{ marginTop: 14, fontSize: '9.5pt' }}>
              {canIssue
                ? 'Study is valid — permit may be issued. A qualified person and the responsible manager complete and sign it.'
                : 'Do not issue — study not valid:'}
            </p>
            {!canIssue && (
              <ul style={{ margin: '0 0 10pt', paddingLeft: 18, fontSize: '9.5pt' }}>
                {permit.validation.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            )}

            <table className="print-table">
              <tbody>
                <tr><td>Equipment</td><td className="num">{equipmentId}</td></tr>
                <tr><td>Voltage</td><td className="num">{permit.equipment.nominalVoltage || '—'}</td></tr>
                <tr><td>Incident energy</td><td className="num">{num(h.incidentEnergyCalCm2, 'cal/cm²')}</td></tr>
                <tr><td>Arc-flash boundary</td><td className="num">{num(h.arcFlashBoundaryIn, 'in')}</td></tr>
                <tr><td>Limited approach</td><td className="num">{num(h.shockLimitedApproachIn, 'in')}</td></tr>
                <tr><td>Restricted approach</td><td className="num">{num(h.shockRestrictedApproachIn, 'in')}</td></tr>
                <tr><td>PPE category</td><td className="num">{h.ppeCategory != null ? `Cat ${h.ppeCategory}` : '—'}</td></tr>
                <tr><td>Min arc rating</td><td className="num">{num(h.requiredArcRatingCalCm2, 'cal/cm²')}</td></tr>
                <tr><td>Hazard class</td><td className="num">{h.hazardClass || '—'}</td></tr>
                <tr><td>Study date</td><td className="num">{fmtDate(permit.study.performedDate)}</td></tr>
                <tr><td>Study expires</td><td className="num">{fmtDate(permit.study.expiresAt)}</td></tr>
                <tr><td>Engineer</td><td className="num">{permit.study.peName || permit.study.method || '—'}</td></tr>
              </tbody>
            </table>

            <div className="print-sec">
              <div className="print-sec-head">
                <span className="print-sec-no" />
                <h2 className="print-sec-title">To complete on the permit</h2>
              </div>
              <ul className="print-checklist">
                {permit.toComplete.map((t, i) => <li key={i}>{t}</li>)}
              </ul>
            </div>

            <p style={{ fontSize: '8pt', fontStyle: 'italic', marginTop: '10pt' }}>{permit.disclaimer}</p>

            {/* Blank signature lines -- structural only. Captions reuse the
                exact "qualified person" / "responsible manager" wording
                already present in the disclaimer/status text above; no new
                regulatory terminology introduced. */}
            <div className="print-sig-block">
              <div className="print-sig-line">Qualified person — signature / date</div>
              <div className="print-sig-line">Responsible manager — signature / date</div>
            </div>

            <footer className="print-footer">
              <span>ServiceCycle</span>
              <span className="print-footer-pages">Generated {fmtDate(new Date())}</span>
            </footer>
          </div>
        </>
      )}
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
              <span style={{ marginLeft: 6, fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: o.category === 'reduce_energy' ? 'var(--color-success, #15803d)' : 'var(--color-info, #2563eb)', padding: '1px 6px', borderRadius: 3 }}>{o.category === 'reduce_energy' ? 'REDUCE ENERGY' : 'WORKER SAFETY'}</span>
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
            <input style={{ fontSize: '0.8rem', width: 130 }} placeholder="reduction %" aria-label="Estimated reduction percentage" value={wf.pct} onChange={e => setWf({ ...wf, pct: e.target.value })} />
            <input style={{ fontSize: '0.8rem', width: 150 }} placeholder="mitigation $ (optional)" aria-label="Mitigation cost in USD (optional)" value={wf.cost} onChange={e => setWf({ ...wf, cost: e.target.value })} />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={busy || !wf.pct}>{busy ? <><Spinner />Modeling…</> : 'Model'}</button>
          </form>
          {roi?.ok && (
            <div style={{ marginTop: 10, fontSize: '0.82rem', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '6px 16px' }}>
              <Field label="Incident energy after" value={`${roi.ieAfterCalCm2} cal/cm²`} />
              <Field label="Reduced by" value={`${roi.calReduced} cal/cm²`} />
              {/* [DEMO-8-9] "Clears DANGER (>40)?" is only meaningful when the bus
                  is DANGER because of incident energy itself (IE > 40). For a bus
                  that is DANGER from system voltage (>600 V) the IE is already <40,
                  so reducing energy can never flip that label and a bare "No" reads
                  as the feature being broken. Show the honest headline instead: the
                  >40 question when it applies, otherwise the required-arc-rating drop that
                  energy reduction actually achieves. */}
              {roi.ieDrivenDanger
                ? <Field label="Clears DANGER (>40)?" value={roi.removesDanger ? 'Yes' : 'No'} />
                : <Field label="Lowers required arc rating?" value={roi.arcRatingReduced ? 'Yes' : 'No'} />}
              <Field label="Required arc rating (cal/cm²)" value={`${roi.requiredArcRatingBeforeCalCm2 ?? '—'} → ${roi.requiredArcRatingAfterCalCm2 ?? '—'}`} />
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
        <button type="submit" className="btn btn-secondary btn-sm" disabled={busy}>{busy ? <><Spinner />Searching…</> : 'Look up'}</button>
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
        <button type="button" className="btn btn-secondary btn-sm" onClick={issue} disabled={busy}>{busy ? <><Spinner />Working…</> : (out ? 'Reprint' : 'Issue QR label')}</button>
      </div>

      {err && <div role="alert" className="alert alert-error" style={{ marginTop: 10 }}>{err}</div>}

      {out && (
        <div className="print-label-sheet" style={{ marginTop: 12, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {out.qrDataUrl && <img src={out.qrDataUrl} alt="Arc flash label QR code" width={140} height={140} style={{ border: '1px solid var(--color-border)', borderRadius: 6 }} />}
          <div style={{ fontSize: '0.8rem' }}>
            <div style={{ color: 'var(--color-text-secondary)' }}>Scan to open the live label:</div>
            <div style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.74rem', marginTop: 4 }}>{out.url}</div>
            <button type="button" className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={printLabelSheet}>Print</button>
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

  // Update one trip-setting field on a JSON-string form field (asFound/asLeft).
  const updateJsonField = (fieldName, key, value) => {
    setForm(f => ({ ...f, [fieldName]: updateJsonFieldInStr(f[fieldName], key, value) }));
  };

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
    <section className="print-sec">
    <div className="print-sec-head print-only">
      <span className="print-sec-no" />
      <h2 className="print-sec-title">NETA test records</h2>
    </div>
    <div style={card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ ...h3, marginBottom: 0 }} className="no-print">NETA test records {tests.length > 0 ? `(${tests.length})` : ''}</h3>
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
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={{ fontSize: '0.78rem', marginBottom: 4 }}>As-Found Trip Settings</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Long-Time Pickup (A)</label>
                  <input type="number" style={inp} placeholder="e.g. 400" aria-label="As-Found Long-Time Pickup in Amps"
                    value={parseJsonField(form.asFound, 'ltPickupA')}
                    onChange={e => updateJsonField('asFound', 'ltPickupA', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Long-Time Delay (s)</label>
                  <input type="number" style={inp} step="0.01" placeholder="e.g. 0.4" aria-label="As-Found Long-Time Delay in seconds"
                    value={parseJsonField(form.asFound, 'ltDelayS')}
                    onChange={e => updateJsonField('asFound', 'ltDelayS', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Short-Time Pickup (A)</label>
                  <input type="number" style={inp} placeholder="e.g. 2000" aria-label="As-Found Short-Time Pickup in Amps"
                    value={parseJsonField(form.asFound, 'stPickupA')}
                    onChange={e => updateJsonField('asFound', 'stPickupA', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Short-Time Delay (s)</label>
                  <input type="number" style={inp} step="0.01" placeholder="e.g. 0.1" aria-label="As-Found Short-Time Delay in seconds"
                    value={parseJsonField(form.asFound, 'stDelayS')}
                    onChange={e => updateJsonField('asFound', 'stDelayS', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Instantaneous Pickup (A)</label>
                  <input type="number" style={inp} placeholder="e.g. 8000" aria-label="As-Found Instantaneous Pickup in Amps"
                    value={parseJsonField(form.asFound, 'instantPickupA')}
                    onChange={e => updateJsonField('asFound', 'instantPickupA', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Ground Fault Pickup (A)</label>
                  <input type="number" style={inp} placeholder="optional" aria-label="As-Found Ground Fault Pickup in Amps"
                    value={parseJsonField(form.asFound, 'groundFaultA')}
                    onChange={e => updateJsonField('asFound', 'groundFaultA', e.target.value)} />
                </div>
              </div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <div style={{ fontSize: '0.78rem', marginBottom: 4 }}>As-Left Trip Settings</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Long-Time Pickup (A)</label>
                  <input type="number" style={inp} placeholder="e.g. 400" aria-label="As-Left Long-Time Pickup in Amps"
                    value={parseJsonField(form.asLeft, 'ltPickupA')}
                    onChange={e => updateJsonField('asLeft', 'ltPickupA', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Long-Time Delay (s)</label>
                  <input type="number" style={inp} step="0.01" placeholder="e.g. 0.4" aria-label="As-Left Long-Time Delay in seconds"
                    value={parseJsonField(form.asLeft, 'ltDelayS')}
                    onChange={e => updateJsonField('asLeft', 'ltDelayS', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Short-Time Pickup (A)</label>
                  <input type="number" style={inp} placeholder="e.g. 2000" aria-label="As-Left Short-Time Pickup in Amps"
                    value={parseJsonField(form.asLeft, 'stPickupA')}
                    onChange={e => updateJsonField('asLeft', 'stPickupA', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Short-Time Delay (s)</label>
                  <input type="number" style={inp} step="0.01" placeholder="e.g. 0.1" aria-label="As-Left Short-Time Delay in seconds"
                    value={parseJsonField(form.asLeft, 'stDelayS')}
                    onChange={e => updateJsonField('asLeft', 'stDelayS', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Instantaneous Pickup (A)</label>
                  <input type="number" style={inp} placeholder="e.g. 8000" aria-label="As-Left Instantaneous Pickup in Amps"
                    value={parseJsonField(form.asLeft, 'instantPickupA')}
                    onChange={e => updateJsonField('asLeft', 'instantPickupA', e.target.value)} />
                </div>
                <div>
                  <label style={{ fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>Ground Fault Pickup (A)</label>
                  <input type="number" style={inp} placeholder="optional" aria-label="As-Left Ground Fault Pickup in Amps"
                    value={parseJsonField(form.asLeft, 'groundFaultA')}
                    onChange={e => updateJsonField('asLeft', 'groundFaultA', e.target.value)} />
                </div>
              </div>
            </div>
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
    </section>
  );
}
