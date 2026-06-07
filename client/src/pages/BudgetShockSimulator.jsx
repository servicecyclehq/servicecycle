import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import api from '../api/client';

function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? '-' : ''}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000)     return `${n < 0 ? '-' : ''}$${(abs / 1_000).toFixed(0)}k`;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
}
function fmtPct(n, showSign = false) {
  if (n == null || isNaN(n)) return '—';
  const sign = showSign && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}
function fmtMonth(m) {
  if (!m) return '';
  const [y, mo] = m.split('-');
  return new Date(parseInt(y), parseInt(mo) - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

const SCENARIO_META = {
  list:      { label: 'List Price',      color: '#dc2626', desc: 'Vendor ask (or current × uplift %)' },
  lastYear:  { label: 'Last Year Flat',  color: 'var(--color-warning)', desc: 'Prior negotiated price (or current × uplift %)' },
  benchmark: { label: 'Benchmark',       color: 'var(--color-success)', desc: 'Category-median discount applied to current' },
};

function ScenarioInput({ id, label, desc, value, onChange, suffix = '%', min = -50, max = 200 }) {
  return (
    <div className="card" style={{ padding: '14px 18px', flex: 1, minWidth: 200 }}>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <input
          id={id}
          type="number"
          step="0.5"
          min={min}
          max={max}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          style={{ width: 72, fontSize: 18, fontWeight: 700, padding: '4px 8px', border: '1px solid var(--color-border)', borderRadius: 6, background: 'var(--color-input-bg, var(--color-surface))', color: 'var(--color-text)' }}
        />
        <span style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)' }}>{suffix}</span>
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{desc}</div>
    </div>
  );
}

function KpiCard({ label, value, delta, deltaPct, color, isCurrent }) {
  return (
    <div className="card" style={{ padding: '14px 18px', flex: 1, minWidth: 160, borderTop: `3px solid ${color}` }}>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)', whiteSpace: 'nowrap' }}>
        {fmtMoney(value)}
      </div>
      {!isCurrent && delta != null && (
        <div style={{ fontSize: 'var(--font-size-sm)', marginTop: 4, color: delta > 0 ? '#dc2626' : delta < 0 ? 'var(--color-success)' : 'var(--color-text-secondary)' }}>
          {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {fmtMoney(Math.abs(delta))} ({fmtPct(deltaPct, true)}) vs. current
        </div>
      )}
      {isCurrent && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Committed spend renewing in 24 months</div>}
    </div>
  );
}

export default function BudgetShockSimulator() {
  const [listUplift,    setListUplift]    = useState(10);
  const [lastYearUplift, setLastYearUplift] = useState(3);
  const [benchmarkDisc, setBenchmarkDisc] = useState(12);

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/api/reports/budget-shock-simulator', {
        params: {
          listUpliftPct:       listUplift,
          lastYearUpliftPct:   lastYearUplift,
          benchmarkDiscountPct: benchmarkDisc,
        },
      });
      setData(res.data.data);
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to load report.');
    } finally {
      setLoading(false);
    }
  }, [listUplift, lastYearUplift, benchmarkDisc]);

  // Auto-load on mount; re-run on explicit "Run" click only (not on input change)
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Chart data: flatten cash-flow months that have any activity
  const chartData = (data?.cashFlow || [])
    .filter((_, i) => i < 24)
    .map(m => ({
      month:     fmtMonth(m.month),
      'List Price':     Math.round(m.listPrice),
      'Last Year':      Math.round(m.lastYear),
      'Benchmark':      Math.round(m.benchmark),
    }));

  const hasAny = chartData.some(m => m['List Price'] || m['Last Year'] || m['Benchmark']);

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Budget Shock Simulator</h1>
          <div className="page-subtitle">
            {data
              ? `${data.contractCount} contract${data.contractCount === 1 ? '' : 's'} renewing in the next 24 months · ${data.generatedBy ? `prepared by ${data.generatedBy}` : ''}`
              : 'Three-scenario renewal P&L — what happens if everything hits list price?'}
          </div>
        </div>
      </div>

      <div className="page-body">
        {/* Scenario inputs */}
        <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 700, marginBottom: 12 }}>Scenario assumptions</div>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
            <ScenarioInput
              id="list-uplift"
              label="List Price uplift %"
              desc="Applied when no original ask is on record"
              value={listUplift}
              onChange={setListUplift}
            />
            <ScenarioInput
              id="lastyear-uplift"
              label="Last Year uplift %"
              desc="Applied when no prior negotiated price on record"
              value={lastYearUplift}
              onChange={setLastYearUplift}
              min={-50}
            />
            <ScenarioInput
              id="benchmark-disc"
              label="Benchmark discount %"
              desc="Category-median discount applied to current committed spend"
              value={benchmarkDisc}
              onChange={setBenchmarkDisc}
              max={99}
            />
          </div>
          <button
            className="btn btn-primary"
            onClick={load}
            disabled={loading}
            style={{ minWidth: 120 }}
          >
            {loading ? 'Running…' : 'Run scenarios'}
          </button>
        </div>

        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
        {loading && <div className="loading">Calculating renewal scenarios…</div>}

        {data && !loading && (
          <>
            {data.contractCount === 0 ? (
              <div className="card" style={{ padding: 32, textAlign: 'center' }}>
                <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, marginBottom: 8 }}>No contracts renewing in the next 24 months</div>
                <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Add end dates to your contracts to use this simulator.</div>
              </div>
            ) : (
              <>
                {/* KPI summary */}
                <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                  <KpiCard label="Current Committed" value={data.totals.current} isCurrent color="#64748b" />
                  <KpiCard
                    label="List Price scenario"
                    value={data.totals.list.total}
                    delta={data.totals.list.delta}
                    deltaPct={data.totals.list.deltaPct}
                    color="#dc2626"
                  />
                  <KpiCard
                    label="Last Year Flat"
                    value={data.totals.lastYear.total}
                    delta={data.totals.lastYear.delta}
                    deltaPct={data.totals.lastYear.deltaPct}
                    color="var(--color-warning)"
                  />
                  <KpiCard
                    label="Benchmark"
                    value={data.totals.benchmark.total}
                    delta={data.totals.benchmark.delta}
                    deltaPct={data.totals.benchmark.deltaPct}
                    color="var(--color-success)"
                  />
                </div>

                {/* 24-month cash-flow chart */}
                {hasAny && (
                  <div className="card" style={{ padding: '16px 20px', marginBottom: 20 }}>
                    <h3 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-data)', fontWeight: 700 }}>24-month renewal cash-flow</h3>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 14 }}>
                      Renewal value landing in each month by scenario
                    </div>
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={chartData} margin={{ left: 0, right: 20 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="month" tick={{ fontSize: 'var(--font-size-2xs)', fill: 'var(--color-text-secondary)' }} interval={2} />
                        <YAxis tickFormatter={v => v >= 1000 ? `$${(v/1000).toFixed(0)}k` : `$${v}`} tick={{ fontSize: 'var(--font-size-2xs)', fill: 'var(--color-text-secondary)' }} width={52} />
                        <Tooltip
                          formatter={(v, name) => [fmtMoney(v), name]}
                          labelStyle={{ fontWeight: 600 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 'var(--font-size-sm)' }} />
                        <Bar dataKey="List Price" fill="#dc2626" opacity={0.85} radius={[2, 2, 0, 0]} />
                        <Bar dataKey="Last Year"  fill="var(--color-warning)" opacity={0.85} radius={[2, 2, 0, 0]} />
                        <Bar dataKey="Benchmark"  fill="var(--color-success)" opacity={0.85} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* Department breakdown */}
                {data.byDepartment.length > 0 && (
                  <div className="card" style={{ overflow: 'hidden', marginBottom: 20 }}>
                    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)' }}>
                      <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Department breakdown</h3>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Department</th>
                            <th style={{ textAlign: 'right' }}>Contracts</th>
                            <th style={{ textAlign: 'right' }}>Current</th>
                            <th style={{ textAlign: 'right', color: '#dc2626' }}>List Price</th>
                            <th style={{ textAlign: 'right', color: 'var(--color-warning)' }}>Last Year</th>
                            <th style={{ textAlign: 'right', color: 'var(--color-success)' }}>Benchmark</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.byDepartment.map(d => (
                            <tr key={d.department}>
                              <td style={{ fontWeight: 600 }}>{d.department}</td>
                              <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{d.count}</td>
                              <td style={{ textAlign: 'right' }}>{fmtMoney(d.current)}</td>
                              <td style={{ textAlign: 'right', color: '#dc2626' }}>
                                {fmtMoney(d.listPrice)}
                                {d.current > 0 && (
                                  <span style={{ fontSize: 'var(--font-size-2xs)', marginLeft: 4, opacity: 0.7 }}>
                                    ({fmtPct(((d.listPrice - d.current) / d.current) * 100, true)})
                                  </span>
                                )}
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--color-warning)' }}>
                                {fmtMoney(d.lastYear)}
                                {d.current > 0 && (
                                  <span style={{ fontSize: 'var(--font-size-2xs)', marginLeft: 4, opacity: 0.7 }}>
                                    ({fmtPct(((d.lastYear - d.current) / d.current) * 100, true)})
                                  </span>
                                )}
                              </td>
                              <td style={{ textAlign: 'right', color: 'var(--color-success)' }}>
                                {fmtMoney(d.benchmark)}
                                {d.current > 0 && (
                                  <span style={{ fontSize: 'var(--font-size-2xs)', marginLeft: 4, opacity: 0.7 }}>
                                    ({fmtPct(((d.benchmark - d.current) / d.current) * 100, true)})
                                  </span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr style={{ fontWeight: 700, borderTop: '2px solid var(--color-border)' }}>
                            <td>Total</td>
                            <td style={{ textAlign: 'right' }}>{data.contractCount}</td>
                            <td style={{ textAlign: 'right' }}>{fmtMoney(data.totals.current)}</td>
                            <td style={{ textAlign: 'right', color: '#dc2626' }}>{fmtMoney(data.totals.list.total)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--color-warning)' }}>{fmtMoney(data.totals.lastYear.total)}</td>
                            <td style={{ textAlign: 'right', color: 'var(--color-success)' }}>{fmtMoney(data.totals.benchmark.total)}</td>
                          </tr>
                        </tfoot>
                      </table>
                    </div>
                  </div>
                )}

                {/* Contract detail table */}
                <div className="card" style={{ overflow: 'hidden' }}>
                  <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'baseline', gap: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 'var(--font-size-data)', fontWeight: 700 }}>Contract detail</h3>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{data.rows.length} renewals in next 24 months</span>
                  </div>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Vendor</th>
                          <th>Product</th>
                          <th>Dept</th>
                          <th style={{ textAlign: 'right' }}>Renews</th>
                          <th style={{ textAlign: 'right' }}>Current</th>
                          <th style={{ textAlign: 'right', color: '#dc2626' }}>List</th>
                          <th style={{ textAlign: 'right', color: 'var(--color-warning)' }}>Last Yr</th>
                          <th style={{ textAlign: 'right', color: 'var(--color-success)' }}>Benchmark</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map(r => (
                          <tr key={r.id}>
                            <td style={{ fontWeight: 600 }}>{r.vendorName || '—'}</td>
                            <td style={{ color: 'var(--color-text-secondary)' }}>{r.product}</td>
                            <td style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>{r.department}</td>
                            <td style={{ textAlign: 'right', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                              {new Date(r.endDate).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
                            </td>
                            <td style={{ textAlign: 'right' }}>{fmtMoney(r.current)}</td>
                            <td style={{ textAlign: 'right', color: '#dc2626' }}>
                              {fmtMoney(r.listPrice)}
                              {r.hasActualAsk && <span title="Using actual original ask" style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>●</span>}
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--color-warning)' }}>
                              {fmtMoney(r.lastYear)}
                              {r.hasActualLast && <span title="Using actual negotiated price" style={{ fontSize: 9, marginLeft: 3, opacity: 0.6 }}>●</span>}
                            </td>
                            <td style={{ textAlign: 'right', color: 'var(--color-success)' }}>{fmtMoney(r.benchmark)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding: '8px 18px', borderTop: '1px solid var(--color-border)', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    ● = actual ask / negotiated price on file (not estimated). Adjust scenario assumptions above and click "Run scenarios" to recalculate.
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
