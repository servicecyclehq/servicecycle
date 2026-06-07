import ReportBackLink from '../components/ReportBackLink';
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';
import { useAuth } from '../context/AuthContext';

// ── Formatters ────────────────────────────────────────────────────────────────
function fmtMoney(n) {
  if (n == null || isNaN(n)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(n);
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}%`;
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// Color tokens — green = lower spend (good), red = higher spend (worse)
function deltaColor(n) {
  if (n == null || n === 0) return 'var(--color-text-secondary)';
  return n > 0 ? 'var(--color-danger)' : 'var(--color-success)';
}

// ── Components ────────────────────────────────────────────────────────────────
function SummaryCard({ label, value, subtitle, valueColor }) {
  return (
    <div className="card" style={{ padding: '14px 18px', minWidth: 180, flex: 1 }}>
      <div style={{
        fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase',
        letterSpacing: '0.05em', color: 'var(--color-text-secondary)',
        marginBottom: 6,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 'var(--font-size-xl)', fontWeight: 700,
        color: valueColor || 'var(--color-text)',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}>
        {value}
      </div>
      {subtitle && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
          {subtitle}
        </div>
      )}
    </div>
  );
}

function ComparisonTable({ rows, nameKey, nameHeader, currentLabel, priorLabel, emptyMessage, renderName }) {
  if (!rows.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">{emptyMessage || 'No data'}</div>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ maxWidth: 200 }}>{nameHeader}</th>
            <th style={{ textAlign: 'right' }}>Contracts</th>
            <th style={{ textAlign: 'right' }}>{currentLabel}</th>
            <th style={{ textAlign: 'right' }}>{priorLabel}</th>
            <th style={{ textAlign: 'right' }}>$ Change</th>
            <th style={{ textAlign: 'right' }}>% Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = deltaColor(r.delta);
            return (
              <tr key={r[nameKey] ?? r.categoryId ?? Math.random()}>
                <td style={{ fontWeight: 600, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {renderName ? renderName(r) : (r[nameKey] || '—')}
                </td>
                <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                  {r.contractCount}
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.current)}</td>
                <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                  {fmtMoney(r.prior)}
                </td>
                <td style={{ textAlign: 'right', color, fontWeight: 600 }}>{fmtMoney(r.delta)}</td>
                <td style={{ textAlign: 'right', color }}>{fmtPct(r.percent)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TopContractsTable({ rows }) {
  if (!rows.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-title">No contracts in this period</div>
      </div>
    );
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 36, textAlign: 'right' }}>#</th>
            {/* Vendor leads for consistency. Reordered 2026-05-08. */}
            <th>Vendor</th>
            <th>Product</th>
            <th>Department</th>
            <th style={{ textAlign: 'right' }}>Renewal</th>
            <th style={{ textAlign: 'right' }}>Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={`${c.product}-${i}`}>
              <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>{i + 1}</td>
              <td style={{ fontWeight: 600 }}>{c.vendorName || '—'}</td>
              <td>{c.product || '—'}</td>
              <td style={{ color: 'var(--color-text-secondary)' }}>{c.department || '—'}</td>
              <td style={{ textAlign: 'right', color: 'var(--color-text-secondary)' }}>
                {fmtDate(c.endDate)}
              </td>
              <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(c.totalValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ExecutiveSpendReport() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const res = await api.get('/api/reports/executive-spend');
        if (!cancelled) { setData(res.data.data); setMeta(res.data.meta ?? null); }
      } catch (err) {
        if (!cancelled) {
          setError(err?.response?.data?.error || 'Failed to load report.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  async function handleDownload() {
    setDownloading(true);
    setError('');
    try {
      const response = await api.get('/api/reports/executive-spend/pdf', {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
      const link = document.createElement('a');
      link.href = url;
      const date = new Date().toISOString().split('T')[0];
      const label = data?.currentFY?.label || 'Report';
      link.setAttribute('download', `LapseIQ_Executive_Spend_${label}_${date}.pdf`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError('PDF download failed. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Executive Spend Report</h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : data
                ? `${data.currentFY.label} actuals vs. ${data.priorFY.label} · ${data.companyName}`
                : 'Backward-looking actuals — vendor and department spend, year-over-year.'}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-primary"
            onClick={handleDownload}
            disabled={loading || downloading || !data}
            title="Download a board-ready PDF of this report"
          >
            {downloading ? 'Generating…' : '↓ Download PDF'}
          </button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
            <ReportAiNarrative reportId="executive-spend" params={{}} paramsKey={"_static"} />
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        {data?.scopeRestricted && (
          <div
            className="alert"
            style={{
              marginBottom: 16,
              background: 'rgba(234, 179, 8, 0.10)',
              border: '1px solid rgba(234, 179, 8, 0.35)',
              color: 'var(--color-text)',
              fontSize: 'var(--font-size-ui)',
            }}
          >
            <strong>Scoped view —</strong> totals reflect only the contracts assigned to you.
          </div>
        )}

        {loading ? (
          <div className="loading">Building report…</div>
        ) : !data ? (
          <div className="empty-state">
            <div className="empty-state-title">No data</div>
          </div>
        ) : (
          <>
            {/* Summary cards */}
            <div style={{ display: 'flex', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
              <SummaryCard
                label={`${data.currentFY.label} Spend`}
                value={fmtMoney(data.currentFY.totalSpend)}
                subtitle={`${data.currentFY.contractCount} contract${data.currentFY.contractCount === 1 ? '' : 's'}`}
              />
              <SummaryCard
                label={`${data.priorFY.label} Spend`}
                value={fmtMoney(data.priorFY.totalSpend)}
                subtitle={`${data.priorFY.contractCount} contract${data.priorFY.contractCount === 1 ? '' : 's'}`}
              />
              <SummaryCard
                label="YoY Change"
                value={fmtMoney(data.yoy.absolute)}
                subtitle={fmtPct(data.yoy.percent)}
                valueColor={deltaColor(data.yoy.absolute)}
              />
              <SummaryCard
                label="Top Vendor"
                value={data.byVendor[0]?.vendorName || '—'}
                subtitle={data.byVendor[0] ? fmtMoney(data.byVendor[0].current) : ''}
              />
            </div>

            {/* Vendor table */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{
                padding: '14px 18px', borderBottom: '1px solid var(--color-border)',
                display: 'flex', alignItems: 'baseline', gap: 10,
              }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700 }}>Spend by Vendor</h3>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                  Top {Math.min(data.byVendor.length, 15)} of {data.byVendor.length}
                </span>
              </div>
              <ComparisonTable
                rows={data.byVendor.slice(0, 15)}
                nameKey="vendorName"
                nameHeader="Vendor"
                currentLabel={data.currentFY.label}
                priorLabel={data.priorFY.label}
                emptyMessage="No vendor spend in either period."
              />
            </div>

            {/* Department table */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{
                padding: '14px 18px', borderBottom: '1px solid var(--color-border)',
                display: 'flex', alignItems: 'baseline', gap: 10,
              }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700 }}>Spend by Department</h3>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                  {data.byDepartment.length} department{data.byDepartment.length === 1 ? '' : 's'}
                </span>
              </div>
              <ComparisonTable
                rows={data.byDepartment}
                nameKey="department"
                nameHeader="Department"
                currentLabel={data.currentFY.label}
                priorLabel={data.priorFY.label}
                emptyMessage="No departmental spend in either period."
              />
            </div>

            {/* (Phase 3) Category table — same ComparisonTable component;
                rows carry categoryIcon/categoryColor metadata so the name
                cell can render the badge inline via the renderName hook. */}
            {data.byCategory && data.byCategory.length > 0 && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div style={{
                  padding: '14px 18px', borderBottom: '1px solid var(--color-border)',
                  display: 'flex', alignItems: 'baseline', gap: 10,
                }}>
                  <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700 }}>Spend by Category</h3>
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    {data.byCategory.length} categor{data.byCategory.length === 1 ? 'y' : 'ies'}
                  </span>
                </div>
                <ComparisonTable
                  rows={data.byCategory}
                  nameKey="categoryName"
                  nameHeader="Category"
                  currentLabel={data.currentFY.label}
                  priorLabel={data.priorFY.label}
                  emptyMessage="No category spend in either period."
                  renderName={(row) => (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span style={{
                        display: 'inline-block',
                        width: 4,
                        height: 14,
                        background: row.categoryColor || 'var(--color-border)',
                        borderRadius: 2,
                      }} />
                      {row.categoryIcon && <span>{row.categoryIcon}</span>}
                      <span>{row.categoryName}</span>
                    </span>
                  )}
                />
              </div>
            )}

            {/* Top 10 contracts */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div style={{
                padding: '14px 18px', borderBottom: '1px solid var(--color-border)',
                display: 'flex', alignItems: 'baseline', gap: 10,
              }}>
                <h3 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700 }}>
                  Top {Math.min(data.topContracts.length, 10)} Contracts by Value
                </h3>
                <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                  {data.currentFY.label}
                </span>
              </div>
              <TopContractsTable rows={data.topContracts} />
            </div>

            <div style={{
              fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'right',
              marginTop: 8,
            }}>
              Generated {fmtDate(data.generatedAt)}
              {data.generatedBy ? ` · by ${data.generatedBy}` : ''}
            </div>
          </>
        )}
      </div>
    </>
  );
}
