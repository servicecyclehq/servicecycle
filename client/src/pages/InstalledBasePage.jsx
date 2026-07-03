// InstalledBasePage.jsx — Installed-Base Intelligence (/installed-base).
// Three surfaces over data the platform already records:
//   1. Fleet Benchmarks — each asset's latest test readings placed in a pool of
//      comparable units (equipmentType + measurement + unit) as a percentile +
//      trend arrow, with small pools flagged "directional only".
//   2. Modernization Pipeline — Watch/Plan/Act ranking off the stored
//      modernizationRiskScore with the score's actual drivers surfaced.
//   3. Attach-Rate Funnel — identified findings → quoted → converted/resolved,
//      with each stage's definition shown verbatim from the server.
// FRAMING: benchmarks are fleet context, not engineering judgment — the server
// ships the caveat text and this page keeps it visible, not buried in a tooltip.
// Manager/admin gated by the route (endpoints are requireManager server-side).
import { useState, useEffect, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Database } from 'lucide-react';
import api from '../api/client';
import BackLink from '../components/BackLink';
import EmptyState from '../components/EmptyState';
import InfoTip from '../components/InfoTip';
import PercentileBar from '../components/installedBase/PercentileBar';
import TrendArrow from '../components/installedBase/TrendArrow';
import ThinPoolBadge from '../components/installedBase/ThinPoolBadge';
import BandChip from '../components/installedBase/BandChip';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EQUIPMENT_TYPE_LABELS, fmtDate, fmtMoney } from '../lib/equipment';

const DAYS_CHOICES = [30, 90, 180, 365];

function metricLabel(t) {
  return String(t || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function typeLabel(t) {
  return EQUIPMENT_TYPE_LABELS[t] || String(t || '').replace(/_/g, ' ');
}
function fmtVal(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return Math.abs(n) >= 1000 ? n.toLocaleString() : String(Math.round(n * 100) / 100);
}

function Tile({ label, value, color }) {
  return (
    <div className="card" style={{ padding: '12px 14px' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em' }}>{label}</div>
      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: color || 'var(--color-text)' }}>{value}</div>
    </div>
  );
}

function CaveatLine({ text }) {
  return (
    <div style={{
      fontSize: '0.76rem', color: 'var(--color-text-secondary)', lineHeight: 1.5,
      padding: '8px 12px', marginBottom: 12, borderRadius: 8,
      background: 'color-mix(in srgb, var(--color-border) 30%, transparent)',
      border: '1px solid var(--color-border)',
    }}>
      {text}
    </div>
  );
}

// ── Fleet benchmarks section ──────────────────────────────────────────────────
function BenchmarksSection({ data }) {
  const [equipFilter, setEquipFilter] = useState('');
  const [onlyDegrading, setOnlyDegrading] = useState(false);

  const equipTypes = useMemo(
    () => [...new Set((data?.pools || []).map((p) => p.equipmentType).filter(Boolean))].sort(),
    [data],
  );
  const rows = useMemo(() => {
    let r = data?.rows || [];
    if (equipFilter) r = r.filter((x) => x.equipmentType === equipFilter);
    if (onlyDegrading) r = r.filter((x) => x.trend === 'degrading');
    return r;
  }, [data, equipFilter, onlyDegrading]);

  const s = data?.summary;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <div>
          <div className="card-title">Fleet benchmarks</div>
          <div className="card-subtitle">
            Each asset's latest reading inside its pool of comparable units — worst fleet position first
          </div>
        </div>
        {s && (
          <span style={{ fontSize: '0.76rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
            {s.assets} assets · {s.pools} pools · <span style={{ color: s.degrading ? 'var(--color-danger)' : 'inherit', fontWeight: s.degrading ? 700 : 400 }}>{s.degrading} degrading</span>
          </span>
        )}
      </div>
      <div style={{ padding: '12px 16px 16px' }}>
        {data?.caveat && <CaveatLine text={data.caveat} />}

        {(data?.rows || []).length === 0 ? (
          <div style={{ padding: '8px 4px', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            No test measurements recorded yet. Import a PowerDB / NETA test report to unlock fleet benchmarks —
            readings attach to assets automatically. <Link to="/test-reports/import">Import test data</Link>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <select value={equipFilter} onChange={(e) => setEquipFilter(e.target.value)} style={{ fontSize: '0.82rem' }} aria-label="Filter by equipment type">
                <option value="">All equipment types</option>
                {equipTypes.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
              </select>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.82rem' }}>
                <input type="checkbox" checked={onlyDegrading} onChange={(e) => setOnlyDegrading(e.target.checked)} />
                Degrading only
              </label>
              <span style={{ fontSize: '0.76rem', color: 'var(--color-text-secondary)', marginLeft: 'auto' }}>
                Trend = same threshold as the ingest "trending since last test" advisories
              </span>
            </div>

            {rows.length === 0 ? (
              <div style={{ padding: '12px 4px', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
                Nothing matches this filter.
              </div>
            ) : (
              <table className="data-table" style={{ width: '100%', fontSize: '0.8rem' }}>
                <thead>
                  <tr>
                    <th>Asset</th><th>Site</th><th>Measurement</th><th style={{ textAlign: 'right' }}>Latest</th>
                    <th>Fleet percentile</th><th>Trend</th><th>Pool</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.assetId}-${r.measurementType}-${r.unit}-${i}`}>
                      <td><Link to={`/assets/${r.assetId}`}>{r.assetLabel}</Link><span style={{ color: 'var(--color-text-secondary)' }}> · {typeLabel(r.equipmentType)}</span></td>
                      <td>{r.siteName || '—'}</td>
                      <td>{metricLabel(r.measurementType)}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap', fontWeight: 600 }}>
                        {fmtVal(r.latestValue)} {r.unit !== '(no unit)' ? r.unit : ''}
                        {r.phase ? <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}> · Ph {r.phase}</span> : null}
                      </td>
                      <td><PercentileBar percentile={r.percentile} orientation={r.orientation} /></td>
                      <td><TrendArrow trend={r.trend} deltaPct={r.deltaPct} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        n={r.poolSize}{' '}
                        {r.thinPool && <ThinPoolBadge poolSize={r.poolSize} />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Modernization pipeline section ────────────────────────────────────────────
function driversText(r) {
  const d = r.drivers || {};
  if (d.path === 'oem_end_of_support') {
    return `OEM support ends ${fmtDate(d.endOfSupport)}${d.obsolescenceStatus ? ` · ${d.obsolescenceStatus}` : ''}`;
  }
  const bits = [];
  if (d.ageYears != null) bits.push(`${d.ageYears} yr old`);
  if (d.governingCondition) bits.push(`condition ${d.governingCondition}`);
  if (d.impliedExpectedLifeYears != null) bits.push(`~${d.impliedExpectedLifeYears} yr expected life`);
  return bits.join(' · ') || '—';
}

function PipelineSection({ data }) {
  const s = data?.summary;
  const rows = data?.rows || [];
  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <div>
          <div className="card-title">Modernization pipeline</div>
          <div className="card-subtitle">
            Assets ranked by modernization score — Act ≥ {Math.round((data?.bands?.act ?? 0.85) * 100)}%, Plan ≥ {Math.round((data?.bands?.plan ?? 0.7) * 100)}%, Watch ≥ {Math.round((data?.bands?.watch ?? 0.5) * 100)}% (presentation bands)
          </div>
        </div>
        {s && (
          <span style={{ fontSize: '0.76rem', color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--color-danger)', fontWeight: 700 }}>{s.act} Act</span> · {s.plan} Plan · {s.watch} Watch
          </span>
        )}
      </div>
      <div style={{ padding: '12px 16px 16px' }}>
        {data?.caveat && <CaveatLine text={data.caveat} />}

        {rows.length === 0 ? (
          <div style={{ padding: '8px 4px', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            No assets in the Watch/Plan/Act bands yet. Scores come from asset age, condition rating, and OEM
            end-of-support dates — record install dates on assets to activate scoring.
            {s ? ` (${s.notScored} asset${s.notScored === 1 ? '' : 's'} without an install date or end-of-support date are unscored.)` : ''}
          </div>
        ) : (
          <>
            <table className="data-table" style={{ width: '100%', fontSize: '0.8rem' }}>
              <thead>
                <tr>
                  <th>Asset</th><th>Site</th><th style={{ textAlign: 'right' }}>Score</th><th>Band</th>
                  <th>What drives it</th><th style={{ textAlign: 'right' }}>Est. repair cost</th>
                  <th style={{ textAlign: 'right' }}>Spare lead</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.assetId}>
                    <td><Link to={`/assets/${r.assetId}`}>{r.assetLabel}</Link><span style={{ color: 'var(--color-text-secondary)' }}> · {typeLabel(r.equipmentType)}</span></td>
                    <td>{r.siteName || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, color: r.band === 'act' ? 'var(--color-danger)' : 'inherit' }}>
                      {Math.round(r.score * 100)}%
                    </td>
                    <td><BandChip band={r.band} /></td>
                    <td style={{ color: 'var(--color-text-secondary)' }}>{driversText(r)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{r.repairCostEstimate != null ? `${fmtMoney(r.repairCostEstimate)} est.` : '—'}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{r.spareLeadTimeWeeks != null ? `${r.spareLeadTimeWeeks} wk` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {s && (
              <div style={{ marginTop: 10, fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                Known repair-cost exposure across the pipeline: <strong>{fmtMoney(s.pipelineCostKnown)}</strong>{' '}
                ({s.pipelineCostAssets} of {rows.length} assets carry an estimate) · {s.longLeadInPipeline} long-lead
                (≥ 12 wk spares){s.notScored ? ` · ${s.notScored} assets unscored (no install / end-of-support date)` : ''}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ── Attach-rate funnel section ────────────────────────────────────────────────
function StageCard({ title, definition, children }) {
  return (
    <div className="card" style={{ flex: '1 1 220px', minWidth: 200, padding: '14px 16px', marginBottom: 0 }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.02em', marginBottom: 6 }}>
        {title}{definition && <InfoTip content={definition} />}
      </div>
      {children}
    </div>
  );
}

function Big({ children, color }) {
  return <div style={{ fontSize: '1.45rem', fontWeight: 700, color: color || 'var(--color-text)' }}>{children}</div>;
}
function Sub({ children }) {
  return <div style={{ fontSize: '0.76rem', color: 'var(--color-text-secondary)', marginTop: 2 }}>{children}</div>;
}

function FunnelSection({ data, days, setDays, loading }) {
  const s = data?.stages;
  const defs = useMemo(() => {
    const m = {};
    for (const d of data?.definitions || []) m[d.key] = d.definition;
    return m;
  }, [data]);

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div className="card-header">
        <div>
          <div className="card-title">Attach rate — identified → quoted → converted</div>
          <div className="card-subtitle">
            How identified work moves toward resolution, over the selected window
          </div>
        </div>
        <div role="group" aria-label="Funnel window" style={{ display: 'flex', gap: 6 }}>
          {DAYS_CHOICES.map((d) => (
            <button
              key={d}
              type="button"
              className={`btn btn-sm ${d === days ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: '12px 16px 16px' }}>
        {loading || !s ? (
          <div style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>Loading funnel…</div>
        ) : s.identified.findings === 0 && s.quoted.quoteRequests === 0
            && s.converted.findingsResolved === 0 && s.converted.quotesAccepted === 0 ? (
          <div style={{ padding: '8px 4px', color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            No findings, quotes, or resolutions in the last {data.days} days. Findings land here automatically
            from test-report ingest, field capture, and inspections.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
              <StageCard title="Identified" definition={defs.identified}>
                <Big>{s.identified.findings}</Big>
                <Sub>findings on {s.identified.assets} asset{s.identified.assets === 1 ? '' : 's'}</Sub>
                <div style={{ marginTop: 8, fontSize: '0.9rem', fontWeight: 700, color: 'var(--color-warning, #b45309)' }}>
                  {fmtMoney(s.identified.estimatedUsd)} <span style={{ fontWeight: 400, fontSize: '0.74rem' }}>est.</span>
                  <InfoTip content={data.estimateBasis} />
                </div>
                <Sub>
                  {s.identified.assetsWithEstimate} of {s.identified.assets} assets carry a recorded estimate
                </Sub>
                <Sub>
                  {s.identified.bySeverity.IMMEDIATE} immediate · {s.identified.bySeverity.RECOMMENDED} recommended · {s.identified.bySeverity.ADVISORY} advisory
                </Sub>
              </StageCard>

              <StageCard title="Quoted" definition={defs.quoted}>
                <Big>{s.quoted.quoteRequests}</Big>
                <Sub>quote request{s.quoted.quoteRequests === 1 ? '' : 's'} opened</Sub>
                <div style={{ marginTop: 8 }}>
                  <Big color={s.quoted.identifiedAssetsQuoted ? 'var(--color-primary)' : undefined}>
                    {data.rates.attachRatePct != null ? `${data.rates.attachRatePct}%` : '—'}
                  </Big>
                  <Sub>of identified assets have a quote request ({s.quoted.identifiedAssetsQuoted} of {s.identified.assets})</Sub>
                </div>
              </StageCard>

              <StageCard title="Converted / resolved" definition={defs.converted}>
                <Big color={s.converted.quotesAccepted ? 'var(--color-success, #15803d)' : undefined}>{s.converted.quotesAccepted}</Big>
                <Sub>quote{s.converted.quotesAccepted === 1 ? '' : 's'} accepted{data.rates.acceptRatePct != null ? ` (${data.rates.acceptRatePct}% of this window's quotes)` : ''}</Sub>
                <div style={{ marginTop: 8 }}>
                  <Big>{s.converted.findingsResolved}</Big>
                  <Sub>finding{s.converted.findingsResolved === 1 ? '' : 's'} resolved</Sub>
                </div>
              </StageCard>
            </div>
            <div style={{ marginTop: 10, fontSize: '0.74rem', color: 'var(--color-text-secondary)' }}>
              Dollar figures are owner-recorded planning estimates, not quotes or offers of work. Hover each stage's (?) for exactly what counts.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function InstalledBasePage() {
  useDocumentTitle('Installed-Base Intelligence');
  const [bench, setBench] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [funnel, setFunnel] = useState(null);
  const [funnelLoading, setFunnelLoading] = useState(true);
  const [days, setDays] = useState(90);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let on = true;
    setLoading(true);
    Promise.all([
      api.get('/api/installed-base/benchmarks', { params: { limit: 200 } }),
      api.get('/api/installed-base/modernization-pipeline'),
    ])
      .then(([b, p]) => {
        if (!on) return;
        setBench(b.data?.data || null);
        setPipeline(p.data?.data || null);
      })
      .catch(() => { if (on) setError('Failed to load installed-base intelligence.'); })
      .finally(() => { if (on) setLoading(false); });
    return () => { on = false; };
  }, []);

  useEffect(() => {
    let on = true;
    setFunnelLoading(true);
    api.get('/api/installed-base/attach-rate', { params: { days } })
      .then((r) => { if (on) setFunnel(r.data?.data || null); })
      .catch(() => { if (on) setFunnel(null); })
      .finally(() => { if (on) setFunnelLoading(false); });
    return () => { on = false; };
  }, [days]);

  const totallyEmpty = !loading && !error
    && (bench?.summary?.assets ?? 0) === 0
    && (pipeline?.rows?.length ?? 0) === 0
    && (funnel?.stages?.identified?.findings ?? 0) === 0;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Installed-Base Intelligence</h1>
          <div className="page-subtitle">Fleet benchmarks, modernization pipeline, and identified-work attach rate</div>
        </div>
        <BackLink fallback="/reports" fallbackLabel="Reports" />
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
        {loading && <div className="card" style={{ padding: 16 }}>Loading…</div>}

        {!loading && !error && totallyEmpty && (
          <EmptyState
            icon={Database}
            title="No installed-base data yet"
            sub="Import test data to unlock fleet benchmarks — readings from PowerDB / NETA reports attach to assets automatically, and findings, quotes, and modernization scores build the rest of this page."
            ctaLabel="Import test data"
            ctaTo="/test-reports/import"
          />
        )}

        {!loading && !error && !totallyEmpty && (
          <>
            {/* Summary tiles */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 16 }}>
              <Tile label="Assets benchmarked" value={bench?.summary?.assets ?? 0} />
              <Tile label="Degrading trends" value={bench?.summary?.degrading ?? 0} color={(bench?.summary?.degrading ?? 0) > 0 ? 'var(--color-danger)' : undefined} />
              <Tile label="Pipeline: Act" value={pipeline?.summary?.act ?? 0} color={(pipeline?.summary?.act ?? 0) > 0 ? 'var(--color-danger)' : undefined} />
              <Tile label="Pipeline est. cost" value={fmtMoney(pipeline?.summary?.pipelineCostKnown ?? 0)} />
              <Tile label={`Identified est. (${funnel?.days ?? days}d)`} value={fmtMoney(funnel?.stages?.identified?.estimatedUsd ?? 0)} color="var(--color-warning, #b45309)" />
            </div>

            <BenchmarksSection data={bench} />
            <PipelineSection data={pipeline} />
            <FunnelSection data={funnel} days={days} setDays={setDays} loading={funnelLoading} />
          </>
        )}
      </div>
    </>
  );
}
