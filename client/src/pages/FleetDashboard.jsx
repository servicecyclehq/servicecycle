// ─────────────────────────────────────────────────────────────────────────────
// FleetDashboard.jsx — OEM cross-account fleet view  (Partner Flywheel v2)
//
// Tabs: Overview | Inbox | Accounts & Invites
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { downloadAuthedFile } from '../api/download';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { fmtDate } from '../lib/equipment';
import FlywheelExplainer from '../components/FlywheelExplainer';

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

function relTime(dateStr) {
  if (!dateStr) return '—';
  const ms = Date.now() - new Date(dateStr).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 2) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function RiskBadge({ score }) {
  if (score === 0) return <span style={styles.badge.green}>No Issues Flagged</span>;
  if (score < 10) return <span style={styles.badge.yellow}>Monitor</span>;
  if (score < 25) return <span style={styles.badge.orange}>At Risk</span>;
  return <span style={styles.badge.red}>Action Required</span>;
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

const EVENT_META = {
  IMMEDIATE_DEFICIENCY:  { bg: '#fee2e2', color: '#b91c1c', label: 'IMMEDIATE' },
  TASK_OVERDUE:          { bg: '#fef3c7', color: '#b45309', label: 'OVERDUE' },
  INSPECTION_COMPLETED:  { bg: '#dbeafe', color: '#1d4ed8', label: 'COMPLETED' },
  QUOTE_REQUEST_CREATED: { bg: '#ede9fe', color: '#7c3aed', label: 'QUOTE REQ' },
  PROPOSAL_DISCUSSION_REQUESTED: { bg: '#dcfce7', color: '#15803d', label: 'PROPOSAL' },
};

function EventBadge({ type }) {
  const m = EVENT_META[type] ?? { bg: '#f3f4f6', color: '#374151', label: type };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700,
      background: m.bg, color: m.color, whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

// ── AccountDetailPanel ────────────────────────────────────────────────────────
function AccountDetailPanel({ accountId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            style={styles.inboxBtn}
            onClick={() => downloadAuthedFile(`/api/proposals/proposal.pdf?accountId=${accountId}`, 'proposal.pdf').catch(() => {})}
          >
            Proposal PDF
          </button>
          <button onClick={onClose} style={styles.closeBtn}>✕</button>
        </div>
      </div>

      <div style={styles.panelGrid}>
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
                {wo.asLeftCondition && (
                  <span style={{ marginLeft: 4, color: '#94a3b8' }}>→ {wo.asLeftCondition}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {data.account.serviceRepName ? (
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
      ) : (
        <div style={styles.repBar}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>Service rep:</span>
          <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic' }}>
            No rep assigned yet
          </span>
        </div>
      )}
    </div>
  );
}

// ── AccountCard (with rep selects) ────────────────────────────────────────────
function AccountCard({ account, expanded, onToggle, reps, onRepChange }) {
  const { metrics, riskScore, companyName, planTier } = account;
  const lastWoDays = daysAgo(metrics.lastWorkOrderDate);
  const [saving, setSaving] = useState(false);

  async function handleRepChange(field, value) {
    setSaving(true);
    try {
      await api.patch(`/api/fleet/accounts/${account.id}/assign-rep`, { [field]: value || null });
      onRepChange(account.id, field, value || null);
    } catch (e) {
      console.error('Rep assign failed', e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ ...styles.card, outline: expanded ? '2px solid var(--accent)' : 'none' }}>
      <div
        style={styles.cardHeader}
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
      >
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
        <MetricTile label="Open WOs" value={metrics.openWorkOrders} accent="#6366f1" />
        <MetricTile
          label="Last Service"
          value={lastWoDays !== null ? `${lastWoDays}d` : '—'}
          accent="#94a3b8"
          sub={lastWoDays !== null ? 'ago' : 'never'}
        />
      </div>

      {reps.length > 0 && (
        <div style={styles.repSelectRow} onClick={(e) => e.stopPropagation()}>
          <label style={styles.repSelectLabel}>
            Primary rep
            <select
              style={styles.repSelectInput}
              disabled={saving}
              value={account.assignedRepId ?? ''}
              onChange={(e) => handleRepChange('assignedRepId', e.target.value)}
            >
              <option value="">— unassigned —</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>{r.name || r.email}</option>
              ))}
            </select>
          </label>
          <label style={styles.repSelectLabel}>
            Backup rep
            <select
              style={styles.repSelectInput}
              disabled={saving}
              value={account.fallbackRepId ?? ''}
              onChange={(e) => handleRepChange('fallbackRepId', e.target.value)}
            >
              <option value="">— unassigned —</option>
              {reps.map((r) => (
                <option key={r.id} value={r.id}>{r.name || r.email}</option>
              ))}
            </select>
          </label>
          {saving && <span style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'center' }}>Saving…</span>}
        </div>
      )}

      {expanded && <AccountDetailPanel accountId={account.id} onClose={onToggle} />}
    </div>
  );
}

// ── InboxTab ──────────────────────────────────────────────────────────────────
function InboxTab({ reps, onUnseenCountChange }) {
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filters, setFilters] = useState({ repId: '', eventType: '', unseenOnly: false });

  function buildQS(cursor) {
    const p = new URLSearchParams();
    if (filters.repId) p.set('repId', filters.repId);
    if (filters.eventType) p.set('eventType', filters.eventType);
    if (filters.unseenOnly) p.set('unseenOnly', 'true');
    if (cursor) p.set('cursor', cursor);
    p.set('limit', '20');
    return p.toString();
  }

  useEffect(() => {
    setLoading(true);
    setItems([]);
    setNextCursor(null);
    api.get(`/api/fleet/inbox?${buildQS(null)}`)
      .then((r) => {
        setItems(r.data.items ?? []);
        setTotal(r.data.total ?? 0);
        setNextCursor(r.data.nextCursor ?? null);
        const unseen = (r.data.items ?? []).filter((i) => !i.seenAt).length;
        onUnseenCountChange?.(unseen);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filters]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const r = await api.get(`/api/fleet/inbox?${buildQS(nextCursor)}`);
      setItems((prev) => [...prev, ...(r.data.items ?? [])]);
      setNextCursor(r.data.nextCursor ?? null);
    } finally {
      setLoadingMore(false);
    }
  }

  async function markSeen(id) {
    await api.patch(`/api/fleet/inbox/${id}/seen`).catch(() => {});
    setItems((prev) =>
      prev.map((i) => i.id === id ? { ...i, seenAt: new Date().toISOString() } : i)
    );
  }

  async function markActioned(id) {
    await api.patch(`/api/fleet/inbox/${id}/actioned`).catch(() => {});
    setItems((prev) =>
      prev.map((i) =>
        i.id === id
          ? { ...i, actionedAt: new Date().toISOString(), seenAt: i.seenAt ?? new Date().toISOString() }
          : i
      )
    );
  }

  const unseenOnPage = items.filter((i) => !i.seenAt).length;

  return (
    <div>
      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          style={styles.filterSelect}
          value={filters.repId}
          onChange={(e) => setFilters((f) => ({ ...f, repId: e.target.value }))}
        >
          <option value="">All reps</option>
          {reps.map((r) => (
            <option key={r.id} value={r.id}>{r.name || r.email}</option>
          ))}
        </select>

        <select
          style={styles.filterSelect}
          value={filters.eventType}
          onChange={(e) => setFilters((f) => ({ ...f, eventType: e.target.value }))}
        >
          <option value="">All event types</option>
          <option value="IMMEDIATE_DEFICIENCY">IMMEDIATE Deficiency</option>
          <option value="TASK_OVERDUE">Task Overdue</option>
          <option value="INSPECTION_COMPLETED">Inspection Completed</option>
          <option value="QUOTE_REQUEST_CREATED">Quote Request</option>
          <option value="PROPOSAL_DISCUSSION_REQUESTED">Proposal Request</option>
        </select>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={filters.unseenOnly}
            onChange={(e) => setFilters((f) => ({ ...f, unseenOnly: e.target.checked }))}
          />
          Unseen only
        </label>

        {!loading && (
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-secondary)' }}>
            {total} total · {unseenOnPage} unseen on page
          </span>
        )}
      </div>

      {loading && <div style={styles.panelLoading}>Loading inbox…</div>}

      {!loading && items.length === 0 && (
        <div style={{ padding: '48px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
          No events match your filters.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item) => {
          const p = item.payload ?? {};
          const unseen = !item.seenAt;
          const actioned = !!item.actionedAt;
          const borderColor = EVENT_META[item.eventType]?.color ?? '#94a3b8';

          return (
            <div
              key={item.id}
              style={{
                ...styles.card,
                borderLeft: `4px solid ${borderColor}`,
                opacity: actioned ? 0.65 : 1,
                background: unseen ? 'var(--surface)' : 'var(--bg)',
              }}
            >
              <div style={{ padding: '12px 16px' }}>
                {/* Top row */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <EventBadge type={item.eventType} />
                    {unseen && (
                      <span style={{
                        width: 8, height: 8, borderRadius: '50%', background: '#3b82f6',
                        display: 'inline-block', flexShrink: 0,
                      }} />
                    )}
                    <span style={{ fontWeight: 600, fontSize: 13 }}>
                      {item.account?.companyName ?? item.accountId}
                    </span>
                    {p.assetName && (
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        · {p.assetName}
                      </span>
                    )}
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                    {relTime(item.createdAt)}
                  </span>
                </div>

                {/* Detail line */}
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, lineHeight: 1.4 }}>
                  {item.eventType === 'IMMEDIATE_DEFICIENCY' && p.description && (
                    <span>{p.description.slice(0, 140)}{p.description.length > 140 ? '…' : ''}</span>
                  )}
                  {item.eventType === 'TASK_OVERDUE' && (
                    <span>{p.overdueCount ?? 0} overdue task{p.overdueCount !== 1 ? 's' : ''}</span>
                  )}
                  {item.eventType === 'INSPECTION_COMPLETED' && (
                    <span>
                      {p.deficiencyCount ?? 0} open deficienc{p.deficiencyCount !== 1 ? 'ies' : 'y'}
                      {p.immediateCount > 0 ? ` (${p.immediateCount} IMMEDIATE)` : ''}
                    </span>
                  )}
                  {item.eventType === 'QUOTE_REQUEST_CREATED' && p.estimatedMin != null && (
                    <span>
                      Est. ${Math.round(p.estimatedMin / 100).toLocaleString()} –{' '}
                      ${Math.round(p.estimatedMax / 100).toLocaleString()}
                    </span>
                  )}
                  {item.eventType === 'PROPOSAL_DISCUSSION_REQUESTED' && (
                    <span>
                      Requested {p.mode === 'call' ? 'a call' : p.mode === 'meeting' ? 'a meeting' : 'a quote'} about their maintenance program
                      {p.note ? ` — ${String(p.note).slice(0, 120)}` : ''}
                    </span>
                  )}
                </div>

                {item.rep && (
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
                    Rep: {item.rep.name || item.rep.email}
                  </div>
                )}

                {/* Actions */}
                <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center' }}>
                  {!item.seenAt && (
                    <button style={styles.inboxBtn} onClick={() => markSeen(item.id)}>
                      Mark seen
                    </button>
                  )}
                  {!item.actionedAt && (
                    <button
                      style={{ ...styles.inboxBtn, background: 'var(--accent)', color: '#fff', borderColor: 'transparent' }}
                      onClick={() => markActioned(item.id)}
                    >
                      Mark actioned
                    </button>
                  )}
                  {item.actionedAt && (
                    <span style={{ fontSize: 11, color: '#059669' }}>
                      ✓ Actioned {relTime(item.actionedAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {nextCursor && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button style={styles.loadMoreBtn} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── AccountsInvitesTab ────────────────────────────────────────────────────────
function AccountsInvitesTab({ accounts }) {
  const [invites, setInvites] = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteSending, setInviteSending] = useState(false);
  const [inviteError, setInviteError] = useState('');
  const [inviteSuccess, setInviteSuccess] = useState('');

  useEffect(() => {
    api.get('/api/fleet/invites')
      .then((r) => setInvites(r.data.invites ?? r.data ?? []))
      .catch(() => {})
      .finally(() => setInvitesLoading(false));
  }, []);

  async function sendInvite(e) {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviteSending(true);
    setInviteError('');
    setInviteSuccess('');
    try {
      const r = await api.post('/api/fleet/invites', { email: inviteEmail.trim() });
      setInvites((prev) => [r.data.invite ?? r.data, ...prev]);
      setInviteSuccess(`Invite sent to ${inviteEmail}`);
      setInviteEmail('');
    } catch (err) {
      setInviteError(err.response?.data?.error ?? 'Failed to send invite.');
    } finally {
      setInviteSending(false);
    }
  }

  async function revokeInvite(id) {
    await api.delete(`/api/fleet/invites/${id}`).catch(() => {});
    setInvites((prev) =>
      prev.map((i) => i.id === id ? { ...i, revokedAt: new Date().toISOString() } : i)
    );
  }

  async function resendInvite(id) {
    try {
      const r = await api.post(`/api/fleet/invites/${id}/resend`);
      setInvites((prev) =>
        prev.map((i) => i.id === id ? { ...i, ...(r.data.invite ?? r.data) } : i)
      );
    } catch (err) {
      console.error('Resend failed', err);
    }
  }

  function inviteStatus(inv) {
    if (inv.revokedAt) return { label: 'Revoked', color: '#94a3b8' };
    if (inv.acceptedAt) return { label: 'Accepted', color: '#059669' };
    if (inv.expiresAt && new Date(inv.expiresAt) < new Date()) return { label: 'Expired', color: '#f59e0b' };
    return { label: 'Pending', color: '#3b82f6' };
  }

  const linked = accounts.filter((a) => a.partnerOrgId);

  return (
    <div>
      {/* Connected accounts */}
      <div style={styles.sectionCard}>
        <div style={styles.sectionTitle}>Connected Accounts ({linked.length})</div>
        {linked.length === 0 && (
          <div style={styles.empty}>No accounts linked yet. Send an invite below to get started.</div>
        )}
        {linked.map((a) => (
          <div
            key={a.id}
            style={{
              ...styles.listRow,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>{a.companyName}</div>
              {a.assignedRepId && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Primary rep assigned</div>
              )}
            </div>
            <span style={styles.badge.green}>Linked</span>
          </div>
        ))}
      </div>

      {/* Invite new account */}
      <div style={{ ...styles.sectionCard, marginTop: 16 }}>
        <div style={styles.sectionTitle}>Invite new account</div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
          An email will be sent to the customer's admin. When they accept, their account links to your partner org.
        </p>
        <form onSubmit={sendInvite} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <input
            type="email"
            placeholder="admin@customer.com"
            style={{ ...styles.filterSelect, flex: 1, minWidth: 220 }}
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            required
          />
          <button
            type="submit"
            disabled={inviteSending}
            style={{
              ...styles.inboxBtn,
              background: 'var(--accent)',
              color: '#fff',
              borderColor: 'transparent',
              padding: '8px 18px',
              fontWeight: 600,
            }}
          >
            {inviteSending ? 'Sending…' : 'Send invite'}
          </button>
        </form>
        {inviteError && <div style={{ marginTop: 8, fontSize: 12, color: '#b91c1c' }}>{inviteError}</div>}
        {inviteSuccess && <div style={{ marginTop: 8, fontSize: 12, color: '#059669' }}>✓ {inviteSuccess}</div>}
      </div>

      {/* Invite list */}
      <div style={{ ...styles.sectionCard, marginTop: 16 }}>
        <div style={styles.sectionTitle}>All Invites</div>
        {invitesLoading && <div style={styles.panelLoading}>Loading…</div>}
        {!invitesLoading && invites.length === 0 && (
          <div style={styles.empty}>No invites sent yet.</div>
        )}
        {invites.map((inv) => {
          const st = inviteStatus(inv);
          const isPending = st.label === 'Pending';
          return (
            <div
              key={inv.id}
              style={{
                ...styles.listRow,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: 10,
              }}
            >
              <div>
                <div style={{ fontWeight: 500, fontSize: 13 }}>
                  {inv.inviteeEmail ?? inv.email ?? '—'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  Sent {fmtDate(inv.createdAt)}
                  {inv.expiresAt && !inv.acceptedAt && !inv.revokedAt
                    ? ` · Expires ${fmtDate(inv.expiresAt)}`
                    : ''}
                  {inv.acceptedAt ? ` · Accepted ${fmtDate(inv.acceptedAt)}` : ''}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: st.color }}>{st.label}</span>
                {isPending && (
                  <>
                    <button style={styles.inboxBtn} onClick={() => resendInvite(inv.id)}>
                      Resend
                    </button>
                    <button
                      style={{ ...styles.inboxBtn, color: '#b91c1c', borderColor: '#fca5a5' }}
                      onClick={() => revokeInvite(inv.id)}
                    >
                      Revoke
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
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
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [forecast, setForecast] = useState(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const [reps, setReps] = useState([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [unseenCount, setUnseenCount] = useState(0);
  const [path100, setPath100] = useState(null); // #23 fleet path-to-100
  const [path100Loading, setPath100Loading] = useState(false);
  const [portfolio, setPortfolio] = useState(null); // B2 portfolio rank (contractor-only)
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  useEffect(() => {
    if (user?.role !== 'oem_admin') {
      navigate('/');
      return;
    }
    setLoading(true);
    api.get('/api/fleet/dashboard')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || 'Could not load the fleet dashboard. Please try again.'))
      .finally(() => setLoading(false));

    setForecastLoading(true);
    api.get('/api/fleet/forecast')
      .then((r) => setForecast(r.data.forecast))
      .catch(() => {})
      .finally(() => setForecastLoading(false));

    api.get('/api/fleet/reps')
      .then((r) => setReps(r.data.reps ?? r.data ?? []))
      .catch(() => {});

    // Quick unseen badge
    api.get('/api/fleet/inbox?unseenOnly=true&limit=1')
      .then((r) => setUnseenCount(r.data.total ?? 0))
      .catch(() => {});

    // #23 fleet path-to-100 — ranked compliance gap across the book.
    setPath100Loading(true);
    api.get('/api/fleet/path-to-100')
      .then((r) => setPath100(r.data))
      .catch(() => {})
      .finally(() => setPath100Loading(false));

    // B2 portfolio rank — contractor-only ranking of the book + talking points.
    setPortfolioLoading(true);
    api.get('/api/fleet/portfolio-rank')
      .then((r) => setPortfolio(r.data))
      .catch(() => {})
      .finally(() => setPortfolioLoading(false));
  }, []);

  const toggle = useCallback((id) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  function handleRepChange(accountId, field, value) {
    setData((prev) => ({
      ...prev,
      accounts: prev.accounts.map((a) =>
        a.id === accountId ? { ...a, [field]: value } : a
      ),
    }));
  }

  if (loading) return <div style={styles.page}><div style={styles.loading}>Loading fleet data…</div></div>;
  if (error) return <div style={styles.page}><div style={styles.errorBox}>{error}</div></div>;
  if (!data) return null;

  const { totals, accounts, partnerOrg } = data;
  const accountsWithIssues = accounts.filter((a) => a.needsAttention).length;

  const filtered = accounts.filter((a) => {
    if (search && !a.companyName.toLowerCase().includes(search.toLowerCase())) return false;
    if (filter === 'attention') return a.needsAttention;
    if (filter === 'healthy') return !a.needsAttention;
    return true;
  });

  const topTabs = [
    { key: 'overview', label: 'Overview' },
    { key: 'path100', label: 'Path to 100%' },
    { key: 'portfolioRank', label: 'Portfolio Rank' },
    { key: 'inbox', label: unseenCount > 0 ? `Inbox (${unseenCount})` : 'Inbox' },
    { key: 'accounts', label: 'Accounts & Invites' },
  ];

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

      {/* Top-level tab bar */}
      <div style={styles.topTabBar}>
        {topTabs.map(({ key, label }) => (
          <button
            key={key}
            style={{ ...styles.topTab, ...(activeTab === key ? styles.topTabActive : {}) }}
            onClick={() => setActiveTab(key)}
          >
            {label}
            {key === 'inbox' && unseenCount > 0 && (
              <span style={styles.unseenPip} />
            )}
          </button>
        ))}
      </div>

      {/* ── OVERVIEW TAB ── */}
      {activeTab === 'overview' && (
        <>
          {/* R5: name the two-sided flywheel + surface its entry points. */}
          <FlywheelExplainer
            onOnboard={() => setActiveTab('accounts')}
            onPipeline={() => setActiveTab('inbox')}
            accountCount={data?.accounts?.length}
          />
          {/* Fleet totals bar — D3 (2026-06-11): severity-first order,
              IMMEDIATE → Overdue → Svc Opps → Accounts w/ issues → Open WOs
              → Total Assets. */}
          <div style={styles.totalsBar}>
            <MetricTile
              label="IMMEDIATE Open"
              value={totals.immediateDeficiencies}
              accent={totals.immediateDeficiencies > 0 ? '#dc2626' : '#22c55e'}
            />
            <MetricTile
              label="Overdue Schedules"
              value={totals.overdueSchedules}
              accent={totals.overdueSchedules > 0 ? '#ef4444' : '#22c55e'}
            />
            <MetricTile
              label="Service Opportunities"
              value={totals.serviceOpportunities}
              accent={totals.serviceOpportunities > 0 ? '#f59e0b' : '#64748b'}
            />
            <MetricTile
              label="Accounts w/ Issues"
              value={accountsWithIssues}
              accent={accountsWithIssues > 0 ? '#f97316' : '#22c55e'}
              sub={`of ${accounts.length}`}
            />
            <MetricTile label="Open Work Orders" value={totals.openWorkOrders} accent="#6366f1" />
            <MetricTile label="Total Assets" value={totals.assets} accent="#64748b" />
          </div>

          {/* Fleet Modernization Forecast — D3: lifted to directly under the
              totals bar (the CapEx table is the page's headline artifact). */}
          <div style={{ ...styles.forecastSection, marginTop: 0, marginBottom: 24 }}>
            <h2 style={styles.forecastTitle}>Fleet Modernization Forecast — 3-Year Rolling CapEx Exposure</h2>
            <p style={styles.forecastNote}>
              <strong>Budget planning estimates only.</strong> Figures are probabilistic ranges derived from
              IEEE/NFPA/NETA equipment-life models, customer-provided condition ratings, and published service
              rate benchmarks. Actual costs vary by site, equipment configuration, labor market, and factors
              not captured in this model. These estimates are <strong>not formal quotes, engineering assessments,
              or guarantees of equipment condition or remaining useful life.</strong> Consult a licensed
              electrical engineer before making capital replacement decisions.
            </p>
            {forecastLoading && <div style={styles.forecastLoading}>Loading forecast…</div>}
            {!forecastLoading && forecast && forecast.length === 0 && (
              <div style={styles.forecastEmpty}>No at-risk assets flagged. Fleet is in good standing.</div>
            )}
            {!forecastLoading && forecast && forecast.length > 0 && (
              <div style={{ overflowX: 'auto' }}>
                <table style={styles.forecastTable}>
                  <thead>
                    <tr style={styles.forecastThead}>
                      {['Account', ...forecast.map((f) => `${f.year} CapEx Range`), 'Assets'].map((h) => (
                        <th key={h} style={styles.forecastTh}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(() => {
                      const allAccountIds = [
                        ...new Set(forecast.flatMap((f) => f.accounts.map((a) => a.accountId))),
                      ];
                      return allAccountIds.map((accountId) => {
                        const firstMatch = forecast.flatMap((f) => f.accounts).find((a) => a.accountId === accountId);
                        const companyName = firstMatch?.companyName ?? accountId;
                        const totalAssets = Math.max(...forecast.map((f) => {
                          const a = f.accounts.find((x) => x.accountId === accountId);
                          return a ? a.assetCount : 0;
                        }));
                        return (
                          <tr key={accountId} style={styles.forecastTr}>
                            <td style={styles.forecastTd}>{companyName}</td>
                            {forecast.map((f) => {
                              const a = f.accounts.find((x) => x.accountId === accountId);
                              if (!a) return (
                                <td key={f.year} style={{ ...styles.forecastTd, color: 'var(--text-secondary)' }}>—</td>
                              );
                              const fmt = (c) => `$${Math.round(c / 100).toLocaleString()}`;
                              return (
                                <td key={f.year} style={styles.forecastTd}>
                                  {fmt(a.minCents)} – {fmt(a.maxCents)}
                                </td>
                              );
                            })}
                            <td style={{ ...styles.forecastTd, textAlign: 'center' }}>{totalAssets}</td>
                          </tr>
                        );
                      });
                    })()}
                  </tbody>
                </table>
              </div>
            )}
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
                    {f === 'all'
                      ? accounts.length
                      : f === 'attention'
                      ? accounts.filter((a) => a.needsAttention).length
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
            {filtered.length === 0 && <div style={styles.empty}>No accounts match your filter.</div>}
            {filtered.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                expanded={expandedId === account.id}
                onToggle={() => toggle(account.id)}
                reps={reps}
                onRepChange={handleRepChange}
              />
            ))}
          </div>

        </>
      )}

      {/* ── PATH TO 100% TAB (#23) ── */}
      {activeTab === 'path100' && (
        <div style={{ marginTop: 8 }}>
          <p style={styles.subtitle}>
            Every customer ranked by how far they are from 100% compliant — worst first. Each row is a
            ready-made action list that is also genuinely the customer's compliance need.
            {path100?.summary ? ` ${path100.summary.totalActions} total actions across ${path100.summary.customerCount} accounts.` : ''}
          </p>
          {path100Loading && !path100 ? (
            <div style={styles.loading}>Loading compliance gaps…</div>
          ) : !path100 || path100.customers.length === 0 ? (
            <div style={{ color: 'var(--color-text-secondary)' }}>No customer accounts to rank yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {path100.customers.map((c) => {
                const rate = c.overallRate;
                const rateColor = rate == null ? '#64748b' : rate >= 90 ? '#15803d' : rate >= 70 ? '#92400e' : '#b91c1c';
                return (
                  <div key={c.accountId}
                    onClick={() => { setActiveTab('overview'); setExpandedId(c.accountId); }}
                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                      padding: '12px 14px', border: '1px solid var(--color-border)', borderRadius: 10, background: 'var(--color-surface, #fff)' }}>
                    <div style={{ fontSize: 22, fontWeight: 800, color: rateColor, minWidth: 64 }}>
                      {rate == null ? '—' : `${rate}%`}
                    </div>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontWeight: 700 }}>{c.companyName}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {c.error ? 'Could not compute gap'
                          : c.fullyCompliant ? 'Fully compliant — nothing to fix'
                          : `${c.totalActions} action${c.totalActions === 1 ? '' : 's'} to 100% · ${c.overdueCount} overdue, ${c.uncoveredCount} uncovered${c.empGapCount ? `, ${c.empGapCount} EMP` : ''}`}
                        {c.serviceRepName ? ` · rep: ${c.serviceRepName}` : ''}
                      </div>
                      {c.topActions && c.topActions.length > 0 && (
                        <div style={{ fontSize: 11.5, color: 'var(--color-text-secondary)', marginTop: 4 }}>
                          Next: {c.topActions[0].title}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); navigate(`/test-reports/import?targetAccountId=${encodeURIComponent(c.accountId)}&customer=${encodeURIComponent(c.companyName)}`); }}
                      style={{ fontSize: 12, fontWeight: 700, color: '#6d28d9', background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 8, padding: '6px 10px', cursor: 'pointer' }}>
                      Ingest report
                    </button>
                    <div style={{ fontSize: 12, color: 'var(--color-primary, #2563eb)' }}>Open →</div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── PORTFOLIO RANK TAB (B2 — contractor-only) ── */}
      {activeTab === 'portfolioRank' && (
        <div style={{ marginTop: 8 }}>
          <p style={styles.subtitle}>
            Every customer ranked across your book on five owned signals — work-order completion, overdue %,
            asset condition, deficiency clearance, and NFPA 70B maturity. Each row carries auto-generated
            talking points for the rep. <strong>Contractor-only — never shown to customers.</strong>
          </p>
          {portfolioLoading && !portfolio ? (
            <div style={styles.loading}>Loading portfolio rank…</div>
          ) : !portfolio || portfolio.accounts.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)' }}>No customer accounts to rank yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {portfolio.accounts.map((c) => {
                const pp = c.portfolioPercentile;
                const ppColor = pp == null ? '#64748b' : pp >= 75 ? '#15803d' : pp >= 40 ? '#92400e' : '#b91c1c';
                const sevColor = { lead: '#b91c1c', opportunity: '#92400e', positive: '#15803d' };
                const fmtPct = (v) => (v == null ? '—' : `${v}`);
                return (
                  <div key={c.accountId} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)', padding: '12px 14px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                      <div style={{ textAlign: 'center', minWidth: 54 }}>
                        <div style={{ fontSize: 20, fontWeight: 800, color: ppColor }}>#{c.rank}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>of {c.rankOf}</div>
                      </div>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ fontWeight: 700 }}>{c.companyName}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                          Portfolio percentile {fmtPct(pp)}
                          {c.detail?.maturityLevel != null ? ` · Maturity L${c.detail.maturityLevel} (${c.detail.maturityLevelLabel})` : ''}
                          {c.serviceRepName ? ` · rep: ${c.serviceRepName}` : ''}
                        </div>
                      </div>
                      <button
                        onClick={() => { setActiveTab('overview'); setExpandedId(c.accountId); }}
                        style={{ fontSize: 12, color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
                        Open →
                      </button>
                    </div>
                    {/* Metric percentiles */}
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 8, fontSize: 11, color: 'var(--text-secondary)' }}>
                      <span title="Work-order completion">Completion: {fmtPct(c.percentiles?.completionRate)}</span>
                      <span title="Overdue maintenance (inverted: higher=better)">Overdue: {fmtPct(c.percentiles?.overduePct)}</span>
                      <span title="Asset condition (inverted: higher=better)">Condition: {fmtPct(c.percentiles?.avgCondition)}</span>
                      <span title="Deficiency clearance">Clearance: {fmtPct(c.percentiles?.clearanceRate)}</span>
                      <span title="NFPA 70B program maturity">Maturity: {fmtPct(c.percentiles?.maturityScore)}</span>
                    </div>
                    {/* Discussion points */}
                    {c.discussionPoints && c.discussionPoints.length > 0 && (
                      <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {c.discussionPoints.map((p, i) => (
                          <div key={i} style={{ fontSize: 12, color: 'var(--text-primary)', display: 'flex', gap: 6, alignItems: 'baseline' }}>
                            <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', color: sevColor[p.severity] || '#64748b', whiteSpace: 'nowrap' }}>{p.severity}</span>
                            <span>{p.text}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ── INBOX TAB ── */}
      {activeTab === 'inbox' && (
        <InboxTab reps={reps} onUnseenCountChange={setUnseenCount} />
      )}

      {/* ── ACCOUNTS & INVITES TAB ── */}
      {activeTab === 'accounts' && (
        <AccountsInvitesTab accounts={accounts} />
      )}
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
    marginBottom: 20,
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
  // Top-level tab bar
  topTabBar: {
    display: 'flex',
    gap: 2,
    borderBottom: '2px solid var(--border)',
    marginBottom: 24,
  },
  topTab: {
    padding: '9px 18px',
    fontSize: 13,
    fontWeight: 500,
    background: 'transparent',
    border: 'none',
    borderBottom: '2px solid transparent',
    marginBottom: -2,
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
  },
  topTabActive: {
    color: 'var(--accent)',
    borderBottomColor: 'var(--accent)',
    fontWeight: 600,
  },
  unseenPip: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#ef4444',
    flexShrink: 0,
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
    background: 'rgba(0,0,0,0.12)',
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
  // Rep select row inside account card
  repSelectRow: {
    display: 'flex',
    gap: 12,
    alignItems: 'center',
    padding: '10px 18px',
    borderTop: '1px solid var(--border)',
    background: 'var(--bg)',
    flexWrap: 'wrap',
  },
  repSelectLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: 3,
    fontSize: 11,
    color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  repSelectInput: {
    padding: '5px 8px',
    fontSize: 12,
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    outline: 'none',
    minWidth: 160,
  },
  // Inbox / generic
  filterSelect: {
    padding: '7px 10px',
    fontSize: 12,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    outline: 'none',
  },
  inboxBtn: {
    padding: '5px 12px',
    fontSize: 12,
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  loadMoreBtn: {
    padding: '8px 24px',
    fontSize: 13,
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
  },
  // Accounts & Invites tab
  sectionCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '16px 20px',
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 14,
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
    padding: '8px 0',
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
  forecastSection: {
    marginTop: 40,
    padding: '24px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
  },
  forecastTitle: {
    fontSize: 16,
    fontWeight: 700,
    margin: '0 0 6px',
    color: 'var(--text-primary)',
  },
  forecastNote: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    margin: '0 0 16px',
    fontStyle: 'italic',
  },
  forecastLoading: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    padding: '12px 0',
  },
  forecastEmpty: {
    fontSize: 13,
    color: '#059669',
    padding: '12px 0',
  },
  forecastTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13,
  },
  forecastThead: {
    background: 'var(--surface-2, #f3f4f6)',
  },
  forecastTh: {
    padding: '8px 12px',
    textAlign: 'left',
    fontWeight: 600,
    fontSize: 11,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  },
  forecastTr: {
    borderBottom: '1px solid var(--border)',
  },
  forecastTd: {
    padding: '10px 12px',
    color: 'var(--text-primary)',
    verticalAlign: 'middle',
  },
};
