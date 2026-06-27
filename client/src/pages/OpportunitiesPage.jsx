import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import useDocumentTitle from '../hooks/useDocumentTitle';

/**
 * OpportunitiesPage — Revenue Intelligence (super_admin only).
 *
 * A READ-ONLY field-intelligence feed. SC detects condition-driven pull-through
 * opportunities; the acquirer's CRM manages them. There is deliberately no
 * pipeline state here (no stages, owners, or forecasting). The one editable
 * field is "CRM Value" — a rep-owned dollar number that exports to the CRM. It
 * never pre-populates from SC's estimate; the rep is fully responsible for it.
 *
 * Visual language mirrors AdminMetrics.jsx: inline styles + CSS variables,
 * clean tables, no charts.
 */

// ── Formatting helpers ───────────────────────────────────────────────────────

const EN_DASH = '–';

function fmtUsd0(cents) {
  if (cents == null) return '';
  return '$' + Math.round(cents / 100).toLocaleString('en-US');
}
function abbrevUsd(cents) {
  const d = cents / 100;
  if (d >= 1000) {
    const k = d / 1000;
    const s = k >= 10 ? Math.round(k).toString() : k.toFixed(1).replace(/\.0$/, '');
    return '$' + s + 'K';
  }
  return '$' + Math.round(d);
}
function rangeShort(lo, hi) {
  if (lo == null || hi == null) return null;
  return lo === hi ? abbrevUsd(lo) : abbrevUsd(lo) + EN_DASH + abbrevUsd(hi);
}
function rangeFull(lo, hi) {
  if (lo == null || hi == null) return '';
  return lo === hi ? fmtUsd0(lo) : fmtUsd0(lo) + EN_DASH + fmtUsd0(hi);
}
function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}
function yearsSince(d) {
  if (!d) return '';
  const yrs = (Date.now() - new Date(d).getTime()) / (365.25 * 86400000);
  return yrs.toFixed(1) + 'y';
}

// ── Shared styles ────────────────────────────────────────────────────────────

const S = {
  card: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 20, marginBottom: 18 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' },
  cell: { padding: '7px 10px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', verticalAlign: 'top' },
  th: { padding: '7px 10px', borderBottom: '2px solid var(--color-border)', color: 'var(--color-text)', fontWeight: 600, textAlign: 'left', whiteSpace: 'nowrap' },
  h3: { margin: '0 0 4px', fontSize: 'var(--font-size-lg)', fontWeight: 600, color: 'var(--color-text)' },
  sub: { margin: '0 0 14px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' },
};

const STATUS_COLORS = {
  expired:  { bg: 'var(--color-danger-bg)',  fg: 'var(--color-danger)' },
  critical: { bg: 'var(--color-warning-bg)', fg: 'var(--color-warning)' },
  warning:  { bg: 'var(--color-warning-bg)', fg: 'var(--color-warning)' },
  ok:       { bg: 'var(--color-success-bg)', fg: 'var(--color-success)' },
};

function Badge({ text, bg, fg }) {
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 999, background: bg, color: fg, fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'capitalize' }}>
      {text}
    </span>
  );
}
function StatusBadge({ status, days }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.ok;
  let hint = '';
  if (days != null) hint = days < 0 ? `expired ${Math.abs(days)}d` : `${days}d left`;
  return (
    <div>
      <Badge text={status} bg={c.bg} fg={c.fg} />
      {hint && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}
function ScoreBadge({ score }) {
  let c;
  if (score >= 70) c = STATUS_COLORS.expired;
  else if (score >= 45) c = STATUS_COLORS.critical;
  else if (score >= 25) c = { bg: 'var(--color-info-bg)', fg: 'var(--color-info)' };
  else c = { bg: 'var(--color-bg)', fg: 'var(--color-text-muted)' };
  return <Badge text={String(score)} bg={c.bg} fg={c.fg} />;
}

// ── CRM Value input (rep-owned; never pre-populated from SC estimate) ─────────

function CrmInput({ value, estimateText, onChange }) {
  const has = value != null && value !== '';
  return (
    <div style={{ minWidth: 130 }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <span style={{ position: 'absolute', left: 8, color: 'var(--color-text-muted)', fontSize: 'var(--font-size-ui)' }}>$</span>
        <input
          type="number" min="0" inputMode="numeric"
          value={has ? value : ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Enter $ amount"
          style={{
            width: '100%', padding: '5px 22px 5px 18px', fontSize: 'var(--font-size-ui)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
            background: 'var(--color-surface)', color: 'var(--color-text)',
          }}
        />
        {has && (
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="var(--color-emerald)" strokeWidth="1.6"
            style={{ position: 'absolute', right: 7 }} aria-label="Manually entered">
            <path d="M11.5 2.5l2 2L6 12l-3 1 1-3z" />
          </svg>
        )}
      </div>
      {estimateText
        ? <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 3 }}>SC est: {estimateText}</div>
        : null}
    </div>
  );
}

// ── CSV ──────────────────────────────────────────────────────────────────────

const CSV_HEADERS = [
  'Company Name', 'Site Name', 'Contact Name', 'Contact Email', 'Contact Phone',
  'Lead Source', 'Opportunity Type', 'Priority Score', 'Study Expiry / Event Date',
  'Days Until Expiry', 'System Changes Since Study', 'Drift Device Count', 'One-Line On File',
  'Asset Count', 'Last PM Completed', 'Estimated Range', 'CRM Value', 'SC Account ID', 'Date Generated',
];

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function downloadCsv(rows, generatedAt) {
  const lines = [CSV_HEADERS.join(',')];
  for (const r of rows) lines.push(CSV_HEADERS.map((h) => csvCell(r[h])).join(','));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `servicecycle-opportunities-${(generatedAt || new Date().toISOString()).slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function OpportunitiesPage() {
  useDocumentTitle('Revenue Intelligence — ServiceCycle');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  const [rejected, setRejected] = useState(() => new Set());
  const [crmValues, setCrmValues] = useState({});
  const [rejectReason, setRejectReason] = useState('already_in_progress');
  const [exportPrompt, setExportPrompt] = useState(null); // { eligible, empty, rows }
  const [confirming, setConfirming] = useState(false);

  async function load() {
    setLoading(true); setErr('');
    try {
      const resp = await api.get('/api/admin/opportunities');
      setData(resp.data?.data || null);
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not load the opportunities feed. Please refresh or try again shortly.');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function confirmRates() {
    setConfirming(true);
    try { await api.post('/api/admin/rate-sheet/confirm'); await load(); }
    catch (e) { setErr(e.response?.data?.error || 'Failed to confirm rates.'); }
    finally { setConfirming(false); }
  }

  // Build sections with STABLE per-row keys (computed from the raw feed so
  // selection / CRM values / rejection survive re-render and filtering).
  const sections = useMemo(() => {
    if (!data) return [];
    const fresh = data.rateSheetStatus === 'fresh';
    const mk = (id, i) => `${id}:${i}`;
    return [
      {
        id: 'study',
        title: 'Arc Flash Study Pipeline',
        subtitle: 'Sites with a study on record, ranked by composite risk/opportunity score.',
        crm: true,
        rows: (data.studyOpportunities || []).map((r, i) => ({ ...r, _key: mk('study', i), _type: 'Arc Flash Study' })),
        columns: [
          { label: 'Account', render: (r) => <strong style={{ color: 'var(--color-text)' }}>{r.accountName}</strong> },
          { label: 'Site', render: (r) => r.siteName },
          { label: 'Status', render: (r) => <StatusBadge status={r.planningStatus} days={r.daysUntilExpiry} /> },
          { label: 'Score', render: (r) => <ScoreBadge score={r.score} /> },
          { label: 'Study Age', render: (r) => yearsSince(r.studyPerformedDate) },
          { label: 'System Changes', align: 'right', render: (r) => r.systemChangesSinceStudy },
          { label: 'Drift Devices', align: 'right', render: (r) => r.driftFlaggedDevices },
          { label: 'One-Line', render: (r) => (r.oneLineDiagramOnFile ? 'Yes' : <span style={{ color: 'var(--color-danger)' }}>No</span>) },
          { label: 'SC Estimate', render: (r) => estimateCell(r, fresh) },
        ],
      },
      {
        id: 'syschange',
        title: 'System-Change Alerts',
        subtitle: 'Equipment changes detected after the most recent arc flash study — labels may be invalid.',
        crm: true,
        rows: (data.systemChangeOpportunities || []).map((r, i) => ({ ...r, _key: mk('syschange', i), _type: 'System-Change Alert' })),
        columns: [
          { label: 'Account', render: (r) => <strong style={{ color: 'var(--color-text)' }}>{r.accountName}</strong> },
          { label: 'Site', render: (r) => r.siteName },
          { label: 'Asset Changed', render: (r) => r.assetName },
          { label: 'Asset Type', render: (r) => prettyType(r.assetType) },
          { label: 'WO Completed', render: (r) => fmtDate(r.workOrderCompletedAt) },
          { label: 'Study Age', render: (r) => `${(r.daysSinceStudy / 365).toFixed(1)}y` },
          { label: 'Score', render: (r) => <ScoreBadge score={r.score} /> },
          { label: 'SC Estimate', render: (r) => estimateCell(r, fresh) },
        ],
      },
      {
        id: 'nostudy',
        title: 'No Arc Flash Study on Record',
        subtitle: 'Accounts with energized assets but no arc flash study — net-new study leads.',
        crm: true,
        rows: (data.noStudyAccounts || []).map((r, i) => ({ ...r, _key: mk('nostudy', i), _type: 'No Study' })),
        columns: [
          { label: 'Account', render: (r) => <strong style={{ color: 'var(--color-text)' }}>{r.accountName}</strong> },
          { label: 'Assets', align: 'right', render: (r) => r.assetCount },
          { label: 'Created', render: (r) => fmtDate(r.createdAt) },
          { label: 'Score', render: (r) => <ScoreBadge score={r.score} /> },
        ],
      },
      {
        id: 'imm',
        title: 'Open IMMEDIATE Deficiencies',
        subtitle: 'Unresolved IMMEDIATE-severity findings — service leads, not study leads.',
        crm: false,
        rows: (data.immediateDeficiencies || []).map((r, i) => ({ ...r, _key: mk('imm', i), _type: 'Immediate Deficiency' })),
        columns: [
          { label: 'Account', render: (r) => <strong style={{ color: 'var(--color-text)' }}>{r.accountName}</strong> },
          { label: 'Count', align: 'right', render: (r) => <span style={{ color: 'var(--color-danger)', fontWeight: 600 }}>{r.count}</span> },
          { label: 'Oldest Open', render: (r) => fmtDate(r.oldestOpenedAt) },
          { label: 'Affected Assets', render: (r) => (r.assetNames || []).join(', ') },
        ],
      },
      {
        id: 'dormant',
        title: 'Dormant Accounts (No PM in 12+ Months)',
        subtitle: 'Previously serviced, now quiet — reactivation leads.',
        crm: true,
        rows: (data.dormantAccounts || []).map((r, i) => ({ ...r, _key: mk('dormant', i), _type: 'Dormant' })),
        columns: [
          { label: 'Account', render: (r) => <strong style={{ color: 'var(--color-text)' }}>{r.accountName}</strong> },
          { label: 'Last Activity', render: (r) => fmtDate(r.lastCompletedAt) },
          { label: 'Months Dormant', align: 'right', render: (r) => r.monthsSinceActivity },
          { label: 'Assets', align: 'right', render: (r) => r.assetCount },
        ],
      },
      {
        id: 'green',
        title: 'Greenfield Accounts (Never Serviced)',
        subtitle: 'Assets on file but never serviced — onboarding leads.',
        crm: true,
        rows: (data.greenfieldAccounts || []).map((r, i) => ({ ...r, _key: mk('green', i), _type: 'Greenfield' })),
        columns: [
          { label: 'Account', render: (r) => <strong style={{ color: 'var(--color-text)' }}>{r.accountName}</strong> },
          { label: 'Created', render: (r) => fmtDate(r.createdAt) },
          { label: 'Assets', align: 'right', render: (r) => r.assetCount },
        ],
      },
    ];
  }, [data]);

  // Flat lookup for export / selection.
  const rowByKey = useMemo(() => {
    const m = new Map();
    for (const sec of sections) for (const r of sec.rows) m.set(r._key, { sec, row: r });
    return m;
  }, [sections]);

  function toggle(key) {
    setSelected((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function setCrm(key, val) { setCrmValues((prev) => ({ ...prev, [key]: val })); }

  function rejectSelected() {
    if (selected.size === 0) return;
    setRejected((prev) => new Set([...prev, ...selected]));
    setSelected(new Set());
  }

  function buildCsvRow(key) {
    const entry = rowByKey.get(key); if (!entry) return null;
    const { sec, row } = entry;
    const crm = crmValues[key];
    return {
      'Company Name': row.accountName,
      'Site Name': row.siteName || '',
      'Contact Name': row.contactName || '',
      'Contact Email': row.contactEmail || '',
      'Contact Phone': row.contactPhone || '',
      'Lead Source': 'ServiceCycle Field Intelligence',
      'Opportunity Type': row._type,
      'Priority Score': row.score != null ? row.score : '',
      'Study Expiry / Event Date': fmtDate(row.studyExpiresAt || row.workOrderCompletedAt || row.oldestOpenedAt || row.lastCompletedAt || row.createdAt),
      'Days Until Expiry': row.daysUntilExpiry != null ? row.daysUntilExpiry : '',
      'System Changes Since Study': row.systemChangesSinceStudy != null ? row.systemChangesSinceStudy : '',
      'Drift Device Count': row.driftFlaggedDevices != null ? row.driftFlaggedDevices : '',
      'One-Line On File': row.oneLineDiagramOnFile == null ? '' : (row.oneLineDiagramOnFile ? 'Yes' : 'No'),
      'Asset Count': row.assetCount != null ? row.assetCount : (row.totalAssets != null ? row.totalAssets : ''),
      'Last PM Completed': fmtDate(row.lastCompletedAt),
      'Estimated Range': rangeFull(row.estimatedRangeLowCents, row.estimatedRangeHighCents),
      'CRM Value': crm != null && crm !== '' ? crm : '',
      'SC Account ID': row.accountId,
      'Date Generated': (data?.generatedAt || new Date().toISOString()),
      _crmEligible: sec.crm,
      _key: key,
    };
  }

  function startExport() {
    if (selected.size === 0) return;
    const built = [...selected].map(buildCsvRow).filter(Boolean);
    const eligible = built.filter((r) => r._crmEligible);
    const empty = eligible.filter((r) => r['CRM Value'] === '');
    if (empty.length > 0) {
      setExportPrompt({ total: eligible.length, empty: empty.length, rows: built });
    } else {
      finishExport(built, 'all');
    }
  }
  function finishExport(built, mode) {
    let out = built;
    if (mode === 'zero') out = built.map((r) => (r._crmEligible && r['CRM Value'] === '' ? { ...r, 'CRM Value': '0' } : r));
    else if (mode === 'entered') out = built.filter((r) => !r._crmEligible || r['CRM Value'] !== '');
    downloadCsv(out, data?.generatedAt);
    setExportPrompt(null);
  }

  // ── Render states ──────────────────────────────────────────────────────────
  if (loading) return <div style={{ padding: 24 }}>Loading revenue intelligence{'…'}</div>;
  if (err) return <div style={{ padding: 24, color: 'var(--color-danger)' }}>Error: {err}</div>;
  if (!data) return <div style={{ padding: 24 }}>No data.</div>;

  const sm = data.summary || {};
  const status = data.rateSheetStatus;
  const hasStudies = (data.studyOpportunities || []).length > 0;

  const cards = [
    { label: 'Expired Studies', value: sm.totalExpiredStudies, color: 'var(--color-danger)' },
    { label: 'System-Change Alerts', value: sm.totalSystemChangeAlerts, color: 'var(--color-warning)' },
    { label: 'Critical (<60d)', value: sm.totalCriticalStudies, color: 'var(--color-warning)' },
    { label: 'IMMEDIATE Deficiencies', value: sm.totalImmediateDeficiencies, color: 'var(--color-danger)' },
    { label: 'Dormant', value: sm.totalDormant, color: 'var(--color-text-secondary)' },
    { label: 'Greenfield', value: sm.totalGreenfield, color: 'var(--color-info)' },
  ];

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px 120px' }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)' }}>Revenue Intelligence</h1>
      <p style={{ margin: '0 0 20px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', maxWidth: 720 }}>
        Field-detected pull-through opportunities &mdash; super_admin only. SC identifies; your CRM manages.
      </p>

      {/* Rate sheet status banner */}
      {status === 'not_configured' && (
        <Banner color="warning">
          Rate sheet not configured. Dollar estimates are disabled until rates are entered. Configure in Settings &rarr; Rate Sheet.
        </Banner>
      )}
      {status === 'stale' && (
        <Banner color="warning">
          <div style={{ flex: 1 }}>
            Rate sheet last confirmed {staleDays(data)} days ago (expires at {data.rateSheetExpiresAfterDays} days).
            Dollar estimates are hidden in CSV exports until rates are reconfirmed.
          </div>
          <button onClick={confirmRates} disabled={confirming} style={btn('solid')}>
            {confirming ? 'Confirming…' : 'Confirm Rates Are Current'}
          </button>
        </Banner>
      )}

      {/* Planning horizon callout */}
      {hasStudies && (
        <div style={{ ...S.card, background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger)', padding: '14px 18px' }}>
          <strong style={{ color: 'var(--color-danger)' }}>Planning horizon:</strong>{' '}
          <span style={{ color: 'var(--color-text-secondary)' }}>
            Arc flash studies require 2&ndash;4 months of preparation. Accounts at Critical or Expired status may already be
            inside &mdash; or past &mdash; the safe planning window. Every day without a renewed study is accruing liability.
          </span>
        </div>
      )}

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 12, marginBottom: 22 }}>
        {cards.map((c) => (
          <div key={c.label} style={{ ...S.card, marginBottom: 0, padding: 16 }}>
            <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: c.color }}>{c.value ?? 0}</div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>{c.label}</div>
          </div>
        ))}
        {status === 'fresh' && (
          <div style={{ ...S.card, marginBottom: 0, padding: 16, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
            <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-success)' }}>● Rates current</div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>
              as of {fmtDate(data.rateSheetLastConfirmedAt || data.rateSheetUpdatedAt)}
            </div>
          </div>
        )}
      </div>

      {/* Sections */}
      {sections.map((sec) => {
        const visible = sec.rows.filter((r) => !rejected.has(r._key));
        return (
          <section key={sec.id} style={S.card}>
            <h3 style={S.h3}>{sec.title} <span style={{ color: 'var(--color-text-muted)', fontWeight: 400, fontSize: 'var(--font-size-sm)' }}>({visible.length})</span></h3>
            <p style={S.sub}>{sec.subtitle}</p>
            {visible.length === 0 ? (
              <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>None.</p>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={{ ...S.th, width: 28 }} />
                      {sec.columns.map((c) => <th key={c.label} style={{ ...S.th, textAlign: c.align === 'right' ? 'right' : 'left' }}>{c.label}</th>)}
                      {sec.crm && <th style={S.th}>CRM Value</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r._key} style={selected.has(r._key) ? { background: 'var(--color-primary-light)' } : undefined}>
                        <td style={S.cell}>
                          <input type="checkbox" checked={selected.has(r._key)} onChange={() => toggle(r._key)} aria-label="Select opportunity" />
                        </td>
                        {sec.columns.map((c) => (
                          <td key={c.label} style={{ ...S.cell, textAlign: c.align === 'right' ? 'right' : 'left' }}>{c.render(r)}</td>
                        ))}
                        {sec.crm && (
                          <td style={S.cell}>
                            <CrmInput
                              value={crmValues[r._key]}
                              estimateText={rangeShort(r.estimatedRangeLowCents, r.estimatedRangeHighCents)}
                              onChange={(v) => setCrm(r._key, v)}
                            />
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {/* Sticky triage controls */}
      <div style={{
        position: 'sticky', bottom: 0, marginTop: 8,
        background: 'var(--color-surface)', borderTop: '1px solid var(--color-border-strong)',
        boxShadow: '0 -2px 8px rgba(0,0,0,0.06)', padding: '12px 16px',
        display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
      }}>
        <strong style={{ color: 'var(--color-text)' }}>{selected.size} selected</strong>
        {selected.size > 0 && (
          <>
            <label style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
              Rejection reason:
              <select value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                style={{ padding: '5px 8px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 'var(--font-size-ui)' }}>
                <option value="already_in_progress">Already in progress</option>
                <option value="not_qualified">Not qualified</option>
                <option value="timing_wrong">Timing wrong</option>
                <option value="duplicate">Duplicate</option>
                <option value="data_error">Data error</option>
              </select>
            </label>
            <button onClick={rejectSelected} style={btn('ghost')}>Reject Selected</button>
          </>
        )}
        <div style={{ flex: 1 }} />
        <button onClick={startExport} disabled={selected.size === 0} style={btn(selected.size === 0 ? 'disabled' : 'solid')}>
          Export Selected to CSV
        </button>
      </div>

      {/* Export modal */}
      {exportPrompt && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: 'var(--color-surface)', borderRadius: 'var(--radius-lg)', padding: 24, maxWidth: 480, width: '90%', border: '1px solid var(--color-border)' }}>
            <h3 style={{ margin: '0 0 10px', fontSize: 'var(--font-size-lg)', color: 'var(--color-text)' }}>Export without all values?</h3>
            <p style={{ margin: '0 0 18px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
              {exportPrompt.empty} of {exportPrompt.total} selected opportunities have no CRM dollar value entered.
              Export with $0 for those rows, or go back to enter values?
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button onClick={() => setExportPrompt(null)} style={btn('ghost')}>Go Back</button>
              <button onClick={() => finishExport(exportPrompt.rows, 'zero')} style={btn('outline')}>Export with $0</button>
              <button onClick={() => finishExport(exportPrompt.rows, 'entered')} style={btn('solid')}>Export Entered Values Only</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small presentational helpers ─────────────────────────────────────────────

function Banner({ color, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 14,
      background: `var(--color-${color}-bg)`, border: `1px solid var(--color-${color})`,
      color: 'var(--color-text-secondary)', borderRadius: 8, padding: '12px 16px', marginBottom: 18,
      fontSize: 'var(--font-size-ui)',
    }}>
      {children}
    </div>
  );
}

function estimateCell(r, fresh) {
  const txt = fresh ? rangeShort(r.estimatedRangeLowCents, r.estimatedRangeHighCents) : null;
  if (!txt) return <span style={{ color: 'var(--color-text-muted)' }}>{'—'}</span>;
  return <span title={r.estimatedRangeCalcDetail || ''} style={{ cursor: 'help', borderBottom: '1px dotted var(--color-border-strong)' }}>{txt}</span>;
}

function prettyType(t) {
  if (!t) return '';
  const map = {
    CIRCUIT_BREAKER: 'Circuit Breaker', TRANSFORMER_LIQUID: 'Transformer (Liquid)', TRANSFORMER_DRY: 'Transformer (Dry)',
    SWITCHGEAR: 'Switchgear', SWITCHBOARD: 'Switchboard', PANELBOARD: 'Panelboard', MCC: 'Motor Control Center',
    PROTECTION_RELAY: 'Protection Relay',
  };
  return map[t] || String(t).toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function staleDays(data) {
  const t = data.rateSheetLastConfirmedAt || data.rateSheetUpdatedAt;
  if (!t) return '?';
  return Math.floor((Date.now() - new Date(t).getTime()) / 86400000);
}

function btn(variant) {
  const base = { padding: '7px 14px', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', fontWeight: 600, cursor: 'pointer', border: '1px solid transparent', whiteSpace: 'nowrap' };
  if (variant === 'solid') return { ...base, background: 'var(--color-primary)', color: '#fff', borderColor: 'var(--color-primary)' };
  if (variant === 'outline') return { ...base, background: 'var(--color-surface)', color: 'var(--color-primary)', borderColor: 'var(--color-primary)' };
  if (variant === 'ghost') return { ...base, background: 'transparent', color: 'var(--color-text-secondary)', borderColor: 'var(--color-border)' };
  if (variant === 'disabled') return { ...base, background: 'var(--color-bg)', color: 'var(--color-text-muted)', borderColor: 'var(--color-border)', cursor: 'not-allowed' };
  return base;
}
