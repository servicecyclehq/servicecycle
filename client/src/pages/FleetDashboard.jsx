// ─────────────────────────────────────────────────────────────────────────────
// FleetDashboard.jsx — OEM cross-account fleet view
//
// Visible to users with role=oem_admin only.
// Shows a grid of customer accounts ranked by risk, with summary metrics and
// drill-down to per-account detail.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EQUIPMENT_TYPE_LABELS, fmtDate } from '../lib/equipment';

// ── Helpers ───────────────────────────────────────────────────────────────────
function msAgo(dateStr) {
  if (!dateStr) return null;
  return Date.now() - new Date(dateStr).getTime();
}

function daysAgo(dateStr) {
  const ms = msAgo(dateStr);
  if (ms === null) return null;
  return Math.floor(ms / 86_400_000);
}

function RiskBadge({ score }) {
  if (score === 0) return <span style={styles.badge.green}>Healthy</span>;
  if (score < 10) return <span style={styles.badge.yellow}>Monitor</span>;
  if (score < 25) return <span style={styles.badge.orange}>At Risk</span>;
  return <span style={styles.badge.red}>Critical</span>;
}

function MetricTile({ label, value, accent, sub }) {
  return (
    <div style={{ ...styles.metricTile, borderTop: `3px solid ${accent}` }}>
      <div style={{ fontSize: 24, fontWeight: 700, color: accent }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

// ── Detail panel shown inline below the account card ─────────────────────────
function AccountDetailPanel({ accountId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    setLoading(true);
    api.get(`/api/fleet/accounts/${accountId}`)
      .then((r) => setData(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [accountId]);

  if (loading) return <div style={styles.panelLoading}>Loading account detail…</div>;
  if (!data) return <div style={styles.panelLoading}>Failed to load.</div>;

  const { overdueSchedules, immediateDeficiencies, serviceOpportunities, recentWorkOrders } = data;

  return (
    <div style={styles.detailPanel}>
      <div style={styles.panelHeader}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>Account Detail — {data.account.companyName}</span>
        <button onClick={onClose} style={styles.closeBtn}>✕</button>
      </div>

      <div style={styles.panelGrid}>
        {/* Overdue schedules */}
        <div style={styles.panelSection}>
          <div style={styles.panelSectionTitle}>
            <span style={{ color: '#ef4444' }}>⚠</span> Overdue Schedules ({overdueSchedules.length})
          </div>
          {overdueSchedules.length === 0 && <div style={styles.empty}>None overdue</div>}
          {overdueSchedules.map((s) => (
            <div key={s.id} style={styles.listRow}>
              <div style={{ fontWeight: 500, fontSize: 12 }}>{s.asset?.name ?? 'Unknown asset'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {s.taskDefinition?.taskName ?? s.taskDefinition?.taskCode ?? '—'} · Due {fmtDate(s.nextDueDate)}
              </div>
            </div>
          ))}
        </div>

        {/* Immediate deficiencies */}
        <div style={styles.panelSection}>
          <div style={styles.panelSectionTitle}>
            <span style={{ color: '#dc2626' }}>🔴</span> IMMEDIATE Deficiencies ({immediateDeficiencies.length})
          </div>
          {immediateDeficiencies.length === 0 && <div style={styles.empty}>None open</div>}
          {immediateDeficiencies.map((d) => (
            <div key={d.id} style={styles.listRow}>
              <div style={{ fontWeight: 500, fontSize: 12 }}>{d.asset?.name ?? 'Unknown'}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {d.description.slice(0, 80)}{d.description.length > 80 ? '…' : ''} · {daysAgo(d.createdAt)}d open
              </div>
            </div>
          ))}
        </div>

        {/* Service opportunities */}
        <div style={styles.panelSection}>
          <div style={styles.panelSectionTitle}>
            <span style={{ color: '#f59e0b' }}>💰</span> Service Opportunities ({serviceOpportunities.length})
          </div>
          {serviceOpportunities.length === 0 && <div style={styles.empty}>No escalated items</div>}
          {serviceOpportunities.map((d) => (
            <div key={d.id} style={styles.listRow}>
              <div style={{ fontWeight: 500, fontSize: 12 }}>{d.asset?.name ?? 'Unknown'}</div>
              <div style={{ fontSize: 11, color: '#f59e0b' }}>
                IMMEDIATE open {daysAgo(d.createdAt)}d — ready for quote
              </div>
            </div>
          ))}
        </div>

        {/* Recent work orders */}
        <div style={styles.panelSection}>
          <div style={styles.panelSectionTitle}>
            <span style={{ color: '#22c55e' }}>✓</span> Recent Work Orders
          </div>
          {recentWorkOrders.length === 0 && <div style={styles.empty}>No completed WOs</div>}
          {recentWorkOrders.map((wo) => (
            <div key={wo.id} style={styles.listRow}>
              <div style={{ fontWeight: 500, fontSize: 12 }}>{wo.title}</div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {wo.asset?.name} · Completed {fmtDate(wo.completedDate)}
                {wo.asLeftCondition && <span style={{ marginLeft: 4, color: '#94a3b8' }}>→ {wo.asLeftCondition}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {data.account.serviceRep && (
        <div style={styles.repBar}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Service rep:</span>
          <strong style={{ marginLeft: 6, fontSize: 12 }}>{data.account.serviceRepName}</strong>
          {data.account.serviceRepEmail && (
            <a href={`mailto:${data.account.serviceRepEmail}`} style={styles.repLink}>
              {data.account.serviceRepEmail}
            </a>
          )}
          {data.account.serviceRepPhone && (
            <a href={`tel:${data.account.serviceRepPhone}`} style={styles.repLink}>
              {data.account.serviceRepPhone}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ── Account card ──────────────────────────────────────────────────────────────
function AccountCard({ account, expanded, onToggle }) {
  const { metrics, riskScore, companyName, planTier } = account;
  const lastWoDays = daysAgo(metrics.lastWorkOrderDate);

  return (
    <div style={{ ...styles.card, outline: expanded ? '2px solid var(--accent)' : 'none' }}>
      <div style={styles.cardHeader} onClick={onToggle} role="button" tabIndex={0}
           onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}>
        <div style={styles.cardTitle}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>{companyName}</span>
          {planTier && <span style={styles.tierBadge}>{planTier}</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <RiskBadge score={riskScore} />
          <span style={{ color: 'var(--text-secondary)', fontSize: 18, userSelect: 'none' }}>
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      <div style={styles.cardMetrics}>
        <MetricTile label="Assets" value={metrics.assets} accent="#64748b" />
        <MetricTile
          label="Overdue"
          value={metrics.overdueSchedules}
          accent={metrics.overdueSchedules > 0 ? '#ef4444' : '#22c55e'}
        />
        <MetricTile
          label="IMMEDIATE"
          value={metrics.immediateDeficiencies}
          accent={metrics.immediateDeficiencies > 0 ? '#dc2626' : '#22c55e'}
        />
        <MetricTile
          label="Svc Opps"
          value={metrics.serviceOpportunities}
          accent={metrics.serviceOpportunities > 0 ? '#f59e0b' : '#64748b'}
        />
        <MetricTile
          label="Open WOs"
          value={metrics.openWorkOrders}
          accent="#6366f1"
        />
        <MetricTile
          label="Last Service"
          value={lastWoDays !== null ? `${lastWoDays}d` : '—'}
          accent="#94a3b8"
          sub={lastWoDays !== null ? 'ago' : 'never'}
        />
      </div>

      {expanded && (
        <AccountDetailPanel accountId={account.id} onClose={onToggle} />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function FleetDashboard() {
  useDocumentTitle('Fleet Dashboard');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [filter, setFilter] = useState('all'); // all | attention | healthy
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (user?.role !== 'oem_admin') {
      navigate('/');
      return;
    }
    setLoading(true);
    api.get('/api/fleet/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error ?? e.message))
      .finally(() => setLoading(false));
  }, []);

  const toggle = useCallback((id) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (loading) return <div style={styles.page}><div style={styles.loading}>Loading fleet data…</div></div>;
  if (error) return <div style={styles.page}><div style={styles.errorBox}>{error}</div></div>;
  if (!data) return null;

  const { totals, accounts, partnerOrg } = data;

  const filtered = accounts.filter((a) => {
    if (search && !a.companyName.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'attention') return a.needsAttention;
    if (filter === 'healthy') return !a.needsAttention;
    return true;
  });

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.header}>
        <div>
          <h1 style={styles.h1}>
            {partnerOrg ? `${partnerOrg.name} Fleet` : 'Fleet Dashboard'}
          </h1>
          <p style={styles.subtitle}>
            {accounts.length} customer account{accounts.length !== 1 ? 's' : ''} · OEM service view
          </p>
        </div>
      </div>

      {/* Fleet totals bar */}
      <div style={styles.totalsBar}>
        <MetricTile label="Total Assets" value={totals.assets} accent="#64748b" />
        <MetricTile
          label="Overdue Schedules"
          value={totals.overdueSchedules}
          accent={totals.overdueSchedules > 0 ? '#ef4444' : '#22c55e'}
        />
        <MetricTile
          label="IMMEDIATE Open"
          value={totals.immediateDeficiencies}
          accent={totals.immediateDeficiencies > 0 ? '#dc2626' : '#22c55e'}
        />
        <MetricTile
          label="Service Opportunities"
          value={totals.serviceOpportunities}
          accent={totals.serviceOpportunities > 0 ? '#f59e0b' : '#64748b'}
        />
        <MetricTile label="Open Work Orders" value={totals.openWorkOrders} accent="#6366f1" />
        <MetricTile
          label="Accounts w/ Issues"
          value={accounts.filter((a) => a.needsAttention).length}
          accent={accounts.filter((a) => a.needsAttention).length > 0 ? '#f97316' : '#22c55e'}
          sub={`of ${accounts.length}`}
        />
      </div>

      {/* Filter row */}
      <div style={styles.filterRow}>
        <div style={styles.filterTabs}>
          {['all', 'attention', 'healthy'].map((f) => (
            <button
              key={f}
              style={{ ...styles.tab, ...(filter === f ? styles.tabActive : {}) }}
              onClick={() => setFilter(f)}
            >
              {f === 'all' ? 'All Accounts' : f === 'attention' ? '⚠ Needs Attention' : '✓ Healthy'}
              <span style={styles.tabCount}>
                {f === 'all' ? accounts.length
                  : f === 'attention' ? accounts.filter((a) => a.needsAttention).length
                  : accounts.filter((a) => !a.needsAttention).length}
              </span>
            </button>
          ))}
        </div>
        <input
          style={styles.searchInput}
          placeholder="Search accounts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {/* Account cards */}
      <div style={styles.cardList}>
        {filtered.length === 0 && (
          <div style={styles.empty}>No accounts match your filter.</div>
        )}
        {filtered.map((account) => (
          <AccountCard
            key={account.id}
            account={account}
            expanded={expandedId === account.id}
            onToggle={() => toggle(account.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const styles = {
  page: {
    padding: '24px 32px',
    maxWidth: 1200,
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  h1: {
    fontSize: 22,
    fontWeight: 700,
    margin: 0,
    color: 'var(--text-primary)',
  },
  subtitle: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    margin: '4px 0 0',
  },
  totalsBar: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 12,
    marginBottom: 20,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '16px 20px',
  },
  metricTile: {
    padding: '8px 4px',
    textAlign: 'center',
  },
  filterRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
    gap: 12,
  },
  filterTabs: {
    display: 'flex',
    gap: 4,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 4,
  },
  tab: {
    padding: '6px 14px',
    fontSize: 13,
    background: 'transparent',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  tabActive: {
    background: 'var(--accent)',
    color: '#fff',
  },
  tabCount: {
    fontSize: 11,
    background: 'rgba(255,255,255,0.2)',
    borderRadius: 10,
    padding: '1px 6px',
  },
  searchInput: {
    padding: '7px 12px',
    fontSize: 13,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    width: 220,
    outline: 'none',
  },
  cardList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    overflow: 'hidden',
    transition: 'box-shadow 0.15s',
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '14px 18px',
    cursor: 'pointer',
    userSelect: 'none',
  },
  cardTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  tierBadge: {
    fontSize: 10,
    padding: '2px 7px',
    borderRadius: 10,
    background: 'var(--accent)',
    color: '#fff',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  cardMetrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    borderTop: '1px solid var(--border)',
    padding: '12px 18px',
    gap: 8,
  },
  badge: {
    green: {
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: '#dcfce7', color: '#15803d',
    },
    yellow: {
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: '#fef9c3', color: '#854d0e',
    },
    orange: {
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: '#ffedd5', color: '#c2410c',
    },
    red: {
      padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 600,
      background: '#fee2e2', color: '#b91c1c',
    },
  },
  // Detail panel
  detailPanel: {
    borderTop: '1px solid var(--border)',
    background: 'var(--bg)',
    padding: '16px 18px',
  },
  panelLoading: {
    padding: 20,
    color: 'var(--text-secondary)',
    fontSize: 13,
    textAlign: 'center',
  },
  panelHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 16,
    color: 'var(--text-secondary)',
    padding: '2px 6px',
  },
  panelGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 16,
  },
  panelSection: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '12px 14px',
  },
  panelSectionTitle: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 10,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
  },
  listRow: {
    padding: '6px 0',
    borderBottom: '1px solid var(--border)',
  },
  empty: {
    fontSize: 12,
    color: 'var(--text-tertiary)',
    fontStyle: 'italic',
    padding: '4px 0',
  },
  repBar: {
    marginTop: 12,
    padding: '8px 12px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  repLink: {
    fontSize: 12,
    color: 'var(--accent)',
    marginLeft: 8,
  },
  loading: {
    padding: 40,
    textAlign: 'center',
    color: 'var(--text-secondary)',
    fontSize: 14,
  },
  errorBox: {
    padding: 20,
    background: '#fee2e2',
    color: '#b91c1c',
    borderRadius: 8,
    fontSize: 13,
  },
};
