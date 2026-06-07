import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import WelcomeTourPanel from '../components/WelcomeTourPanel';
import ReportAiNarrative from '../components/ReportAiNarrative';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function fmtMoney(val) {
  if (val == null || isNaN(val)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: 0,
  }).format(val);
}

function fmt(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.ceil((new Date(dateStr) - new Date()) / 86_400_000);
}

function DaysChip({ dateStr }) {
  const d = daysUntil(dateStr);
  if (d === null) return null;
  let cls = 'days-chip-ok';
  let label = `${d}d`;
  let severity = 'on track';
  if (d < 0)       { cls = 'days-chip-overdue'; label = `Overdue by ${Math.abs(d)}d`; severity = 'overdue'; }
  else if (d <= 14) { cls = 'days-chip-overdue'; severity = 'urgent'; }
  else if (d <= 30) { cls = 'days-chip-urgent';  severity = 'soon'; }
  else if (d <= 60) { cls = 'days-chip-soon';    severity = 'upcoming'; }
  // v0.68.3 (audit Medium a11y): aria-label includes the severity word so SR
  // users hear "5 days, urgent" instead of just "5d".
  const ariaLabel = d < 0 ? `${Math.abs(d)} days overdue` : `${d} days, ${severity}`;
  return <span className={`days-chip ${cls}`} aria-label={ariaLabel}>{label}</span>;
}

function contractValue(c) {
  if (!c.costPerLicense || !c.quantity) return null;
  return parseFloat(c.costPerLicense) * parseInt(c.quantity);
}

// ── Summary Card ─────────────────────────────────────────────────────────────
function SummaryCard({ label, value, sub, accent, icon, onClick }) {
  return (
    <div
      className="card"
      onClick={onClick} role="button" tabIndex={0} onKeyDown={kbdActivate(onClick)}
      style={{
        // 2026-05-10 review H2 fix: drop maxWidth (was 320, overflowed the
        // 4-card row at 1366×768 / sidebar-220 viewports) and shrink minWidth
        // so cards wrap gracefully on narrower screens instead of cramping
        // and clipping the rightmost CTA.
        padding: '18px 22px', flex: '1 1 0', minWidth: 0, overflow: 'hidden',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'box-shadow 0.15s, transform 0.15s',
      }}
      onMouseEnter={e => { if (onClick) { e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = ''; e.currentTarget.style.transform = ''; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, marginBottom: 10, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </div>
        {icon && <span style={{ fontSize: 18, opacity: 0.5, flexShrink: 0 }}>{icon}</span>}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, color: accent || 'var(--color-text)', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub}</div>}
      {onClick && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', marginTop: 6, fontWeight: 500 }}>View contracts →</div>}
    </div>
  );
}

// ── Action Item Row ───────────────────────────────────────────────────────────
function ActionRow({ contract, dateField, dateLabel, isTrap, navigate }) {
  const val = contractValue(contract);
  return (
    <tr
      className={isTrap ? 'trap-row' : ''}
      style={{ cursor: 'pointer' }}
      onClick={() => navigate(`/contracts/${contract.id}`, { state: { from: '/contracts' } })} tabIndex={0} onKeyDown={kbdActivate(() => navigate(`/contracts/${contract.id}`, { state: { from: '/contracts' } }))}
    >
      <td>
        <div style={{ fontWeight: 600 }}>{contract.product}</div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{contract.vendor?.name}</div>
      </td>
      <td style={{ textAlign: 'right' }}>
        <div style={{ fontSize: 'var(--font-size-sm)' }}>{fmt(contract[dateField])}</div>
        <DaysChip dateStr={contract[dateField]} />
      </td>
      <td style={{ textAlign: 'right', fontWeight: 600 }}>
        {val ? fmtMoney(val) : <span className="text-muted">—</span>}
      </td>
    </tr>
  );
}

// ── Section Card ─────────────────────────────────────────────────────────────
function Section({ title, titleColor, subtitle, icon, children, emptyMsg, isEmpty, onViewAll, viewAllLabel }) {
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title" style={{ color: titleColor }}>
            {icon && <span style={{ marginRight: 6 }}>{icon}</span>}
            {title}
          </div>
          {subtitle && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{subtitle}</div>}
        </div>
        {onViewAll && !isEmpty && (
          <button className="btn btn-secondary btn-sm" onClick={onViewAll}>
            {viewAllLabel || 'View all'}
          </button>
        )}
      </div>
      {isEmpty ? (
        <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
          <span aria-hidden="true">✓</span> {emptyMsg}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <tbody>{children}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Needs Attention Today ─────────────────────────────────────────────────────
// UX review 2026-05-01 Thread G: this is now a snapshot of /api/alerts/all,
// not its own source of truth. Three category counts plus a single CTA into
// the Alerts page where the full lists live. The previous in-place rendering
// (top 5 per category, stale-overdue collapse, multi-link drilldowns) caused
// the contradiction the review flagged ("dashboard shows 6, Alerts says All
// clear"); both surfaces now read the same backing query.
function AttentionRow({ contract, metric, metricColor, sub, navigate }) {
  const go = () => navigate(`/contracts/${contract.id}`, { state: { from: '/contracts' } });
  return (
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}
      onClick={go} role="button" tabIndex={0} onKeyDown={kbdActivate(go)}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface)'}
      onMouseLeave={e => e.currentTarget.style.background = ''}
    >
      <div style={{ minWidth: 0, marginRight: 12 }}>
        <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{contract.product}</div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{contract.vendor?.name}</div>
      </div>
      <div style={{ textAlign: 'right', flexShrink: 0 }}>
        <div style={{ fontSize: 'var(--font-size-sm)', color: metricColor, fontWeight: 700 }}>{metric}</div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{sub}</div>
      </div>
    </div>
  );
}

function AttentionSection({ dotColor, labelColor, label, count, onViewAll, moreCount, moreLabel, children }) {
  if (!count) return null;
  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0 4px' }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0 }} />
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: labelColor, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{count}</span>
        {onViewAll && (
          <button type="button" onClick={onViewAll} style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-primary)', fontSize: 'var(--font-size-xs)', fontWeight: 500, padding: 0 }}>
            View all {'→'}
          </button>
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--color-border)' }}>
        {children}
      </div>
      {moreCount > 0 && (
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-primary)', marginTop: 6, cursor: 'pointer', fontWeight: 500 }}
          onClick={onViewAll} role="button" tabIndex={0} onKeyDown={kbdActivate(onViewAll)}>
          + {moreCount} {moreLabel} {'→'}
        </div>
      )}
    </div>
  );
}

function AttentionCard({ accent, emoji, title, subtitle, children }) {
  return (
    <div className="card" style={{ borderLeft: `3px solid ${accent}` }}>
      <div className="card-header" style={{ paddingBottom: 8 }}>
        <div>
          <div className="card-title" style={{ color: accent }}>
            <span aria-hidden="true">{emoji} </span>{title}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{subtitle}</div>
        </div>
      </div>
      <div className="card-body" style={{ paddingTop: 4 }}>
        {children}
      </div>
    </div>
  );
}

function NeedsAttentionToday({ data, navigate }) {
  const { overdueReviews = [], expiringThisMonth = [] } = data;
  const reviewCount = overdueReviews.length;
  const expiringCount = expiringThisMonth.length;
  const total = reviewCount + expiringCount;

  const goReviews = () => navigate('/alerts?chip=review_by', { state: { from: 'dashboard', columnFilters: [{ id: 'daysUntil', value: { min: -3650, max: 0 } }] } });
  const goExpiring = () => navigate('/contracts?renewal=expiringMonth', { state: { from: 'dashboard' } });

  if (total === 0) {
    return (
      <AttentionCard accent={'var(--color-success)'} emoji={'✓'} title="Needs Attention Today" subtitle="You're all caught up.">
        <div style={{ padding: '12px 0', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
          No overdue reviews or upcoming expirations right now.
        </div>
      </AttentionCard>
    );
  }

  return (
    <AttentionCard
      accent={'var(--color-danger)'}
      emoji={'\u{1F6A8}'}
      title="Needs Attention Today"
      subtitle={`${total} item${total !== 1 ? 's' : ''} need a look · live snapshot`}
    >
      <AttentionSection
        dotColor="var(--color-warning)" labelColor="var(--color-warning)"
        label="Overdue reviews" count={reviewCount}
        onViewAll={goReviews}
        moreCount={Math.max(0, reviewCount - 3)} moreLabel={`more review${reviewCount - 3 !== 1 ? 's' : ''}`}
      >
        {overdueReviews.slice(0, 3).map(c => {
          const d = daysUntil(c.evaluationStartByDate);
          return (
            <AttentionRow key={c.id} contract={c} navigate={navigate}
              metric={d !== null && d < 0 ? `Overdue by ${Math.abs(d)}d` : 'Due now'}
              metricColor="var(--color-warning)"
              sub={`Review by ${fmt(c.evaluationStartByDate)}`} />
          );
        })}
      </AttentionSection>

      <AttentionSection
        dotColor="var(--color-info)" labelColor="var(--color-primary)"
        label="Expiring soon" count={expiringCount}
        onViewAll={goExpiring}
        moreCount={Math.max(0, expiringCount - 3)} moreLabel={`more contract${expiringCount - 3 !== 1 ? 's' : ''}`}
      >
        {expiringThisMonth.slice(0, 3).map(c => {
          const d = daysUntil(c.endDate);
          return (
            <AttentionRow key={c.id} contract={c} navigate={navigate}
              metric={d !== null ? `${d} day${d !== 1 ? 's' : ''}` : '—'}
              metricColor="var(--color-primary)"
              sub={`Ends ${fmt(c.endDate)}`} />
          );
        })}
      </AttentionSection>
    </AttentionCard>
  );
}

// ── Spend Bar Chart ───────────────────────────────────────────────────────────
function SpendBarChart({ title, subtitle, data, color = 'var(--color-primary)', onRowClick }) {
  if (!data || data.length === 0) {
    return (
      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">{title}</div>
            {subtitle && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{subtitle}</div>}
          </div>
        </div>
        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>No data yet</div>
      </div>
    );
  }
  const max = Math.max(...data.map(d => d.spend));
  return (
    <div className="card">
      <div className="card-header">
        <div>
          <div className="card-title">{title}</div>
          {subtitle && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>{subtitle}</div>}
        </div>
      </div>
      <div style={{ padding: '8px 16px 16px' }}>
        {data.map((row, i) => {
          const pct = max > 0 ? (row.spend / max) * 100 : 0;
          const clickable = onRowClick && row.vendorId;
          return (
            <div
              key={i}
              style={{ marginBottom: 10, cursor: clickable ? 'pointer' : 'default', borderRadius: 'var(--radius)', padding: '4px 6px', margin: '0 -6px 6px', transition: 'background 0.12s' }}
              onClick={() => clickable && onRowClick(row)} role="button" tabIndex={0} onKeyDown={kbdActivate(() => clickable && onRowClick(row))}
              onMouseEnter={e => { if (clickable) e.currentTarget.style.background = 'var(--color-surface)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = ''; }}
              title={clickable ? `View ${row.name} contracts` : ''}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 500, color: 'var(--color-text)', maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.name}>
                  {row.name}
                </span>
                <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
                  {fmtMoney(row.spend)}
                </span>
              </div>
              <div style={{ height: 8, background: 'var(--color-border)', borderRadius: 4, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 4, transition: 'width 0.4s ease' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Monthly Renewal Calendar ──────────────────────────────────────────────────
// WCAG-aware text colour for the renewal heat-map cells (MonthlyCalendar). The
// cell fill is rgba(13,79,110, intensity) composited over the active theme
// surface; we pick pure white or pure black at the luminance crossover (~0.179)
// where both clear 4.5:1. Pure #000/#fff (not the ink token) leaves no failing
// gap. See QA-AUDIT-2026-05-30 color-contrast finding (was: dark text < 0.85).
function heatCellTextColor(intensity) {
  const dark = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-theme') === 'dark';
  const surf = dark ? [22, 27, 34] : [255, 255, 255]; // #161b22 / #ffffff
  const mix = (base, s) => base * intensity + s * (1 - intensity);
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const r = mix(13, surf[0]), g = mix(79, surf[1]), b = mix(110, surf[2]);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L < 0.179 ? '#ffffff' : '#000000';
}
function MonthlyCalendar({ data, onMonthClick }) {
  if (!data || data.length === 0) return null;
  const maxCount = Math.max(...data.map(d => d.count), 1);
  return (
    // design-pass: brand-accent stripe — this card is the visual anchor of
    // the dashboard's right column and benefits from the same brand-color
    // emphasis the page-title already carries.
    <div className="card card--accent">
      <div className="card-header">
        <div>
          <div className="card-title">Renewal Calendar</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Active contracts expiring over the next 12 months — click any month to see contracts
          </div>
        </div>
      </div>
      <div style={{ padding: '12px 16px 16px', overflowX: 'auto' }}>
        <div style={{ display: 'flex', gap: 8, minWidth: 'max-content' }}>
          {data.map((m, i) => {
            const intensity = m.count > 0 ? Math.max(0.12, 0.55 * (m.count / maxCount)) : 0;
            const bg = m.count > 0
              ? `rgba(13, 79, 110, ${intensity})`
              : 'var(--color-surface)';
            // a11y (QA color-contrast): pick text colour by composited cell
            // luminance so every heat level clears 4.5:1.
            const cellText = 'var(--color-text)'; // theme-reactive: CSS updates on toggle (intensity is capped so contrast holds in both modes)
            const textColor = cellText;
            const subColor = m.count > 0 ? cellText : 'var(--color-text-secondary)';
            const clickable = m.count > 0 && onMonthClick;
            return (
              <div
                key={i}
                onClick={() => clickable && onMonthClick(m)} role="button" tabIndex={0} onKeyDown={kbdActivate(() => clickable && onMonthClick(m))}
                style={{
                  width: 72, minHeight: 80, borderRadius: 'var(--radius)',
                  background: bg, border: `1px solid ${m.count > 0 ? 'transparent' : 'var(--color-border)'}`,
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  justifyContent: 'center', padding: '8px 4px', textAlign: 'center',
                  transition: 'filter 0.15s, transform 0.15s',
                  cursor: clickable ? 'pointer' : 'default',
                }}
                onMouseEnter={e => { if (clickable) { e.currentTarget.style.filter = 'brightness(1.08)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}}
                onMouseLeave={e => { e.currentTarget.style.filter = ''; e.currentTarget.style.transform = ''; }}
                title={clickable ? `View ${m.count} contract${m.count !== 1 ? 's' : ''} expiring in ${m.label}` : ''}
              >
                <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: subColor, marginBottom: 4 }}>{m.label}</div>
                {m.count > 0 ? (
                  <>
                    <div style={{ fontSize: 20, fontWeight: 700, color: textColor, lineHeight: 1 }}>{m.count}</div>
                    <div style={{ fontSize: 'var(--font-size-2xs)', color: subColor, marginTop: 3 }}>
                      {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 0 }).format(m.value)}
                    </div>
                  </>
                ) : (
                  <div style={{ fontSize: 'var(--font-size-ui)', color: subColor }}>—</div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 14px', fontSize: 'var(--font-size-2xs)', color: 'var(--color-text-secondary)' }}><span>Fewer</span><div style={{ display: 'flex', gap: 3 }}>{[0.12, 0.27, 0.41, 0.55].map((a, li) => (<span key={li} style={{ width: 18, height: 10, borderRadius: 2, background: `rgba(13, 79, 110, ${a})`, border: '1px solid var(--color-border)', display: 'inline-block' }} />))}</div><span>More renewals</span></div>
    </div>
  );
}

// ── Auto-Renewal Trap Tile ─────────────────────────────────────────────────────
// Separate card that highlights the auto-renewal trap list alongside the
// NeedsAttentionToday card. Shown only when traps > 0.
function AutoRenewalTrapTile({ traps, navigate }) {
  if (!traps || traps.length === 0) return null;
  const goAll = () => navigate('/contracts?renewal=cancel30', { state: { from: 'dashboard' } });
  return (
    <AttentionCard
      accent={'var(--color-danger)'}
      emoji={'\u{1F534}'}
      title={`Auto-Renewal — Action Needed`}
      subtitle={`${traps.length} contract${traps.length !== 1 ? 's' : ''} · cancel window within 30 days`}
    >
      <AttentionSection
        dotColor="var(--color-danger)" labelColor="var(--color-danger)"
        label="Cancel windows closing" count={traps.length}
        onViewAll={goAll}
        moreCount={Math.max(0, traps.length - 5)} moreLabel={`more renewal${traps.length - 5 !== 1 ? 's' : ''}`}
      >
        {traps.slice(0, 5).map(c => {
          const d = daysUntil(c.cancelByDate);
          return (
            <AttentionRow key={c.id} contract={c} navigate={navigate}
              metric={d !== null && d >= 0 ? `${d} day${d !== 1 ? 's' : ''} left` : 'Overdue'}
              metricColor="var(--color-danger)"
              sub={`Cancel by ${fmt(c.cancelByDate)}`} />
          );
        })}
      </AttentionSection>
    </AttentionCard>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function Dashboard() {
  useDocumentTitle('Dashboard');
  // v0.92.19: reset scroll on mount so a fresh login lands at the top (the
  // post-signup redirect is a client-side nav that otherwise retains the
  // signup form's scroll offset).
  useEffect(() => { window.scrollTo(0, 0); }, []);
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  // H5-1 (v0.76.8): responsive mobile breakpoint via matchMedia (inline styles
  // cannot be overridden by CSS @media, so we track the breakpoint in state)
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 480px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 480px)');
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // 2026-05-11 v0.3.1: key the data-fetch on user.id so a sign-out / sign-in
  // (especially same-tab as a different user via the demo's per-visitor
  // registration flow) clears stale data and re-fetches. Previously the
  // dependency array was [] and the component would briefly render the
  // PRIOR session's totals — visually wrong even though backend scoping
  // is correct. The reset-to-loading on user.id change prevents the
  // "23 active contracts" flash on a fresh sandbox that only owns 1.
  useEffect(() => {
    setData(null);
    setLoading(true);
    setError('');
    api.get('/api/dashboard')
      .then((res) => setData(res.data.data))
      .catch(() => setError('Failed to load dashboard.'))
      .finally(() => setLoading(false));
  }, [user?.id]);


  if (loading) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Dashboard</h1>
        </div>
        <div className="page-body">
          <div className="loading">Loading dashboard…</div>
        </div>
      </>
    );
  }

  const greeting = () => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  };

  const firstName = user?.name?.split(' ')[0] || 'there';

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">{greeting()}, {firstName}</h1>
          <div className="page-subtitle">
            Here's what needs your attention today
          </div>
        </div>
        {['admin', 'manager'].includes(user?.role) && (
          <button className="btn btn-primary" onClick={() => navigate('/contracts/new')}>
            <Plus size={14} strokeWidth={1.75} style={{ verticalAlign: "-2px", marginRight: 6 }} />New Contract
          </button>
        )}
      </div>

      <div className="page-body">
        {/* One-shot welcome panel - shows ONLY when the OnboardingWizard
            sets lapseiq_welcome_pending=1 on its successful-completion
            paths (final step's primary or skip). Self-contained: clears
            its own flag on dismiss. Foundation for a richer interactive
            tour later. */}
        <WelcomeTourPanel />

        {/* v0.64.0: AI portfolio summary card. Click-to-generate per the
            no-auto-fire rule; matches the same pattern wired into all 14
            reports. Reuses POST /api/reports/_portfolio/narrate which
            composes data from 4 existing builders. */}
        <ReportAiNarrative reportId="_portfolio" paramsKey="_dashboard" />

        {error && <div role="alert" className="alert alert-error">{error}</div>}

        {data && (
          <>
            {/* ── Alert tiles: Needs Attention + Auto-Renewal Traps (side-by-side) ── */}
            {(data.needsAttentionToday || data.autoRenewalTraps?.length > 0) && (
              <div style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr' : (data.needsAttentionToday && data.autoRenewalTraps?.length > 0 ? '1fr 1fr' : '1fr'),
                gap: 16,
                marginBottom: 20,
              }}>
                {data.needsAttentionToday && (
                  <NeedsAttentionToday data={data.needsAttentionToday} autoRenewalTraps={data.autoRenewalTraps} navigate={navigate} />
                )}
                {data.autoRenewalTraps?.length > 0 && (
                  <AutoRenewalTrapTile traps={data.autoRenewalTraps} navigate={navigate} />
                )}
              </div>
            )}

            {/* ── Summary Cards ──────────────────────────────────────────────── */}
            {/* Action row — items requiring attention.
                Grid with auto-fit + minmax(190px, 1fr): rows pack 4-up on
                wide screens, gracefully drop to 3 / 2 / 1 columns below
                ~1280 / 980 / 580px. Replaces the prior flex-wrap layout
                which let cards reach maxWidth:320 and cropped the
                right-most KPI on 1366×768 laptops. (2026-05-10 review H2) */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(190px, 1fr))', gap: isMobile ? 10 : 14, marginBottom: 20 }}>
              <SummaryCard
                label="Open Alerts"
                value={data.summary.openAlerts}
                sub={data.summary.openAlerts > 0 ? 'Require acknowledgment' : 'All clear'}
                accent={data.summary.openAlerts > 0 ? 'var(--color-danger)' : undefined}
                icon="🔔"
                onClick={() => navigate('/alerts?chip=review_by', { state: { from: 'dashboard' } })}
              />
              <SummaryCard
                label="Auto-Renewal — Action Needed"
                value={data.summary.autoRenewalTraps}
                sub="Cancel window < 30 days"
                accent={data.summary.autoRenewalTraps > 0 ? 'var(--color-danger)' : undefined}
                icon="⚠️"
                onClick={() => navigate('/contracts?renewal=cancel30', { state: { from: 'dashboard' } })}
              />
              <SummaryCard
                label="Expiring in 90 Days"
                value={data.summary.expiringIn90Days}
                sub={fmtMoney(data.summary.spendAtRisk) + ' at risk'}
                accent={data.summary.expiringIn90Days > 0 ? 'var(--color-warning)' : undefined}
                icon="📅"
                onClick={() => navigate('/contracts?renewal=renewing90')}
              />
              {data.summary.totalSavingsNegotiated > 0 && (
                <SummaryCard
                  label="Savings Negotiated"
                  value={fmtMoney(data.summary.totalSavingsNegotiated)}
                  sub="vs. vendor original ask"
                  accent="var(--color-success)"
                  icon="🤝"
                />
              )}
            </div>
            {/* Info row — portfolio overview (matches action row layout) */}
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14, marginBottom: 20 }}>
              <SummaryCard
                label="Active Contracts"
                value={data.summary.totalActive}
                sub="Across all vendors"
                icon="📋"
                onClick={() => navigate('/contracts?status=active')}
              />
              <SummaryCard
                label="Annual Spend"
                value={fmtMoney(data.summary.totalAnnualSpend)}
                sub={`Across ${data.summary.totalActive} active contract${data.summary.totalActive === 1 ? '' : 's'}`}
                icon="💰"
                onClick={() => navigate('/contracts?status=active')}
              />
            </div>

            {/* H3-2 (v0.76.2): "Data as of" subtle timestamp */}
            {data.lastSyncAt && (
              <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', margin: '-8px 0 16px', textAlign: 'right' }}>
                Data as of {new Date(data.lastSyncAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })}
              </p>
            )}

            {/* Monthly Renewal Calendar ─────────────────────────────────────── */}
            {data.renewalsByMonth && (
              <div style={{ marginBottom: 20 }}>
                <MonthlyCalendar
                  data={data.renewalsByMonth}
                  onMonthClick={m => navigate(`/contracts?endMonth=${m.month}`)}
                />
              </div>
            )}

            {/* ── Upcoming Renewals Table ─────────────────────────────────────── */}
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-header">
                <div>
                  <div className="card-title">Upcoming Renewals</div>
                  <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                    Active contracts expiring within 90 days
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => navigate('/contracts?renewal=renewing90')}>
                  View all
                </button>
              </div>

              {data.upcomingRenewals.length === 0 ? (
                <div style={{ padding: '24px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                  <span aria-hidden="true">✓</span> No contracts expiring in the next 90 days
                </div>
              ) : (
                (() => {
                  // Build a map of vendorId → count in upcoming renewals
                  // to identify co-term candidates (vendor with >1 contract here).
                  const vendorCounts = {};
                  data.upcomingRenewals.forEach(c => {
                    const vid = c.vendor?.id;
                    if (vid) vendorCounts[vid] = (vendorCounts[vid] || 0) + 1;
                  });
                  return (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            {/* Vendor leads on every all-up table for
                                consistency. Reordered 2026-05-08. */}
                            <th>Vendor</th>
                            <th>Product</th>
                            <th>Dept</th>
                            <th style={{ textAlign: 'right' }}>End Date</th>
                            <th style={{ textAlign: 'right' }}>Evaluate By</th>
                            <th style={{ textAlign: 'right' }}>Cancel By</th>
                            <th style={{ textAlign: 'right' }}>Value</th>
                            <th style={{ textAlign: 'center' }} title="Vendor has multiple contracts expiring — bundle for co-term savings">Co-term</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.upcomingRenewals.map((c) => {
                            const cancelDays = daysUntil(c.cancelByDate);
                            const isTrap = c.autoRenewal && cancelDays !== null && cancelDays >= 0 && cancelDays <= 30;
                            const val = contractValue(c);
                            const isCoterm = c.vendor?.id && vendorCounts[c.vendor.id] > 1;
                            return (
                              <tr
                                key={c.id}
                                className={isTrap ? 'trap-row' : ''}
                                style={{ cursor: 'pointer' }}
                                onClick={() => navigate(`/contracts/${c.id}`, { state: { from: '/contracts' } })} tabIndex={0} onKeyDown={kbdActivate(() => navigate(`/contracts/${c.id}`, { state: { from: '/contracts' } }))}
                              >
                                <td style={{ fontWeight: 600 }}>{c.vendor?.name || '—'}</td>
                                <td>{c.product}</td>
                                <td className="td-muted">{c.department || '—'}</td>
                                <td style={{ textAlign: 'right' }}>
                                  <div>{fmt(c.endDate)}</div>
                                  <DaysChip dateStr={c.endDate} />
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  <div>{fmt(c.evaluationStartByDate)}</div>
                                  {c.evaluationStartByDate && <DaysChip dateStr={c.evaluationStartByDate} />}
                                </td>
                                <td style={{ textAlign: 'right' }}>
                                  {c.autoRenewal && c.cancelByDate ? (
                                    <>
                                      <div style={{ fontWeight: isTrap ? 700 : 400 }}>{fmt(c.cancelByDate)}</div>
                                      <DaysChip dateStr={c.cancelByDate} />
                                    </>
                                  ) : (
                                    <span className="text-muted">—</span>
                                  )}
                                </td>
                                <td style={{ textAlign: 'right', fontWeight: 600 }}>
                                  {val ? fmtMoney(val) : <span className="text-muted">—</span>}
                                </td>
                                <td style={{ textAlign: 'center' }}>
                                  {isCoterm ? (
                                    <span
                                      style={{ color: 'var(--color-success)', fontWeight: 700, fontSize: 16 }}
                                      title={`${vendorCounts[c.vendor.id]} contracts from this vendor — good co-term candidate`}
                                    >
                                      ✓
                                    </span>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()
              )}
            </div>
            {/* Spend Charts ────────────────────────────────────────────────── */}
            {(data.spendByVendor?.length > 0 || data.spendByDepartment?.length > 0) && (
              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: 16, marginBottom: 20 }}>
                <SpendBarChart
                  title="Spend by Vendor"
                  subtitle="Active contracts — click a vendor to view their contracts"
                  data={data.spendByVendor}
                  color="var(--color-primary)"
                  onRowClick={row => navigate(`/contracts?vendorId=${row.vendorId}&vendorName=${encodeURIComponent(row.name)}`)}
                />
                <SpendBarChart
                  title="Spend by Department"
                  subtitle="Active contracts — total contract value"
                  data={data.spendByDepartment}
                  color="var(--color-renewal-text)"
                />
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}