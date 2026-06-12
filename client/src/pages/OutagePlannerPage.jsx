// ─────────────────────────────────────────────────────────────────────────────
// OutagePlannerPage.jsx — Account-wide Outage Consolidation Planner.
//
// Shows every asset across the account that has outage-requiring maintenance
// tasks due within ±90 days, grouped by site. Each site section shows a
// savings banner ("N shutdowns avoided by consolidating") and lets you
// schedule a single consolidated work order covering all assets at that site.
//
// Per-asset detail still lives on the AssetDetail page (OutageConsolidationCard).
// This page is the fleet-level view — "where do I need planned outages and
// what's the most efficient way to schedule them?"
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Bolt, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { fmtDate } from '../lib/equipment';
import Toast from '../components/Toast';
import { useFromState } from '../components/BackLink';

// ── sub-components ────────────────────────────────────────────────────────────

const STATUS_META = {
  overdue:  { bg: '#fff1f1', color: '#b91c1c', label: 'Overdue' },
  due:      { bg: '#fffbeb', color: '#92400e', label: 'Due soon' },
  upcoming: { bg: 'var(--color-bg-subtle, #f1f5f9)', color: 'var(--color-text-secondary)', label: 'Upcoming' },
};

function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.upcoming;
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
      background: m.bg, color: m.color }}>{m.label}</span>
  );
}

function SavingsBanner({ shutdownsAvoided, totalTasks, assetCount }) {
  if (shutdownsAvoided < 1) return null;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      padding: '10px 14px', marginBottom: 14, borderRadius: 8,
      background: 'var(--color-success-bg, #f0fdf4)',
      border: '1px solid var(--color-success-border, #bbf7d0)' }}>
      <span style={{ fontSize: 20 }}>⚡</span>
      <div>
        <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text)' }}>
          {shutdownsAvoided} shutdown{shutdownsAvoided !== 1 ? 's' : ''} avoided
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          {totalTasks} outage task{totalTasks !== 1 ? 's' : ''} across {assetCount} asset{assetCount !== 1 ? 's' : ''} — consolidated into 1 planned window
        </div>
      </div>
    </div>
  );
}

// ── Consolidated WO form ──────────────────────────────────────────────────────

function ConsolidateForm({ site, canWrite, onSuccess, onCancel }) {
  const [date,        setDate]        = useState('');
  const [notes,       setNotes]       = useState('');
  const [selectedIds, setSelectedIds] = useState(
    new Set(site.assets.map(a => a.assetId))
  );
  const [submitting, setSubmitting]   = useState(false);
  const [err,        setErr]          = useState('');

  function toggle(id) {
    setSelectedIds(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    if (!date) { setErr('Outage date required'); return; }
    const chosen = site.assets.filter(a => selectedIds.has(a.assetId));
    if (chosen.length === 0) { setErr('Select at least one asset'); return; }

    setSubmitting(true);
    try {
      await api.post('/api/outage-planner/work-order', {
        siteId: site.siteId,
        scheduledDate: date,
        notes: notes || undefined,
        assetSchedules: chosen.map(a => ({
          assetId: a.assetId,
          scheduleIds: a.tasks.map(t => t.scheduleId),
        })),
      });
      onSuccess(chosen.length);
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to create work orders');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ background: 'var(--color-bg-secondary)',
      border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 12 }}>Schedule Consolidated Outage — {site.siteName}</div>
      {err && <div style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginBottom: 10 }}>{err}</div>}

      {/* Asset checkboxes */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary)', marginBottom: 6 }}>
          Include assets ({selectedIds.size} of {site.assets.length} selected)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {site.assets.map(a => (
            <label key={a.assetId} style={{ display: 'flex', alignItems: 'center', gap: 8,
              cursor: 'pointer', fontSize: 'var(--font-size-sm)' }}>
              <input type="checkbox" checked={selectedIds.has(a.assetId)} onChange={() => toggle(a.assetId)} />
              <span style={{ flex: 1 }}>{a.assetName}</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                {a.tasks.length} task{a.tasks.length !== 1 ? 's' : ''}
              </span>
              {a.hasOpenWO && (
                <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4,
                  background: '#eff6ff', color: '#1d4ed8' }}>WO open</span>
              )}
            </label>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <div>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 3 }}>
            Outage date *
          </label>
          <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} required style={{ width: 160 }} />
        </div>
        <div style={{ flex: '1 1 200px' }}>
          <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 3 }}>
            Notes (optional)
          </label>
          <input type="text" className="input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Shutdown window, contact, special instructions…" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary btn-sm" disabled={submitting || selectedIds.size === 0}>
          {submitting ? 'Creating…' : `Create ${selectedIds.size} Work Order${selectedIds.size !== 1 ? 's' : ''}`}
        </button>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 8 }}>
        One work order per asset will be created, all scheduled for the same outage date.
      </div>
    </form>
  );
}

// ── Site section ──────────────────────────────────────────────────────────────

function SiteSection({ site, canWrite, onScheduled }) {
  const fromState = useFromState();
  const [expanded,    setExpanded]    = useState(true);
  const [showForm,    setShowForm]    = useState(false);
  const [toast,       setToast]       = useState(null);

  function handleSuccess(count) {
    setShowForm(false);
    setToast({ message: `Created ${count} consolidated work order${count !== 1 ? 's' : ''} for ${site.siteName}`, type: 'success' });
    onScheduled();
  }

  return (
    <div className="card mb-16" style={{ overflow: 'hidden' }}>
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Site header */}
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        flexWrap: 'wrap' }} onClick={() => setExpanded(e => !e)}>
        <div style={{ flex: 1 }}>
          <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            {site.siteName}
          </div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, paddingLeft: 22 }}>
            {site.totalAssets} asset{site.totalAssets !== 1 ? 's' : ''} · {site.totalTasks} outage task{site.totalTasks !== 1 ? 's' : ''}
            {site.overdueTasks > 0 && (
              <span style={{ color: '#b91c1c', fontWeight: 700, marginLeft: 8 }}>
                {site.overdueTasks} overdue
              </span>
            )}
          </div>
        </div>
        {canWrite && expanded && !showForm && (
          <button
            className="btn btn-primary btn-sm"
            onClick={e => { e.stopPropagation(); setShowForm(true); }}
          >
            Schedule consolidated outage
          </button>
        )}
      </div>

      {expanded && (
        <div className="card-body">
          <SavingsBanner
            shutdownsAvoided={site.shutdownsAvoided}
            totalTasks={site.totalTasks}
            assetCount={site.totalAssets}
          />

          {showForm && (
            <ConsolidateForm
              site={site}
              canWrite={canWrite}
              onSuccess={handleSuccess}
              onCancel={() => setShowForm(false)}
            />
          )}

          {/* Asset rows */}
          {site.assets.map(asset => (
            <div key={asset.assetId} style={{ marginBottom: 16, paddingBottom: 16,
              borderBottom: '1px solid var(--color-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                <div style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  {asset.assetName}
                  {asset.criticalityScore >= 4 && (
                    <span title="High criticality" style={{ fontSize: 11, padding: '1px 6px',
                      borderRadius: 4, background: '#fff1f1', color: '#b91c1c' }}>
                      Crit {asset.criticalityScore}
                    </span>
                  )}
                  {asset.hasOpenWO && (
                    <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4,
                      background: '#eff6ff', color: '#1d4ed8' }}>WO already open</span>
                  )}
                </div>
                {/* C1: record the planner as the origin so AssetDetail's
                    BackLink returns here instead of the Assets list. */}
                <Link to={`/assets/${asset.assetId}`} state={fromState} style={{ fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                  View asset <ExternalLink size={11} />
                </Link>
              </div>

              {/* Task list */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {asset.tasks.map((task, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                    fontSize: 'var(--font-size-sm)' }}>
                    <StatusPill status={task.status} />
                    <span style={{ flex: 1, minWidth: 120 }}>{task.taskName}</span>
                    <span style={{ color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>
                      {task.dueDate ? fmtDate(task.dueDate) : '—'}
                    </span>
                    {task.standardRef && (
                      <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{task.standardRef}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function OutagePlannerPage() {
  useDocumentTitle('Outage Planner');
  const { role } = useAuth();
  const canWrite  = ['admin', 'manager'].includes(role);

  const [data,    setData]    = useState(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/api/outage-planner/summary');
      setData(res.data.data);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load outage plan');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="page-container">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Bolt size={22} strokeWidth={1.75} />
            Outage Planner
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 0', maxWidth: 720, lineHeight: 1.6 }}>
            Some maintenance tasks — insulation testing, breaker servicing, busway inspection — can only
            be done with the equipment de-energized. Each de-energization is an <strong>outage window</strong>:
            a planned shutdown that interrupts the power your facility depends on. This planner finds every
            asset with outage-requiring tasks due within ±90 days and groups them by site, so instead of
            shutting the same site down once per task, you schedule <em>one</em> window that knocks out all
            of them together.
          </p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* How to read this page — brief helper for the key sections. */}
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: '6px 24px',
        padding: '10px 14px', marginBottom: 20, borderRadius: 8,
        background: 'var(--color-bg-secondary, var(--color-bg))',
        border: '1px solid var(--color-border)',
        fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', lineHeight: 1.6,
      }}>
        <span><strong style={{ color: 'var(--color-text)' }}>⚡ Shutdowns avoided</strong> — how many separate de-energizations you skip by combining a site&rsquo;s tasks into one window.</span>
        <span><strong style={{ color: 'var(--color-text)' }}>Status pills</strong> — <span style={{ color: '#b91c1c', fontWeight: 600 }}>Overdue</span> is past its due date, <span style={{ color: '#92400e', fontWeight: 600 }}>Due soon</span> falls inside the next 90 days, Upcoming is further out but still in the window.</span>
        <span><strong style={{ color: 'var(--color-text)' }}>Schedule consolidated outage</strong> — pick a date and which assets to include; one work order per asset is created, all on the same outage date.</span>
        <span><strong style={{ color: 'var(--color-text)' }}>WO open</strong> — that asset already has a work order in flight; including it again may duplicate effort.</span>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-secondary)' }}>
          Loading outage plan…
        </div>
      )}

      {error && (
        <div style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca',
          borderRadius: 8, color: '#b91c1c', marginBottom: 16 }}>{error}</div>
      )}

      {!loading && !error && data && (
        <>
          {/* Account-level savings banner */}
          {data.totalShutdownsAvoided > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '12px 16px',
              marginBottom: 20, borderRadius: 8, flexWrap: 'wrap',
              background: 'var(--color-success-bg, #f0fdf4)',
              border: '1px solid var(--color-success-border, #bbf7d0)' }}>
              <span style={{ fontSize: 28 }}>⚡</span>
              <div>
                <div style={{ fontWeight: 700, color: 'var(--color-text)' }}>
                  Consolidating saves {data.totalShutdownsAvoided} shutdown{data.totalShutdownsAvoided !== 1 ? 's' : ''} across your entire facility
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                  {data.sites.length} site{data.sites.length !== 1 ? 's' : ''} with upcoming outage-required work · plan scheduled as of {new Date(data.generatedAt).toLocaleString()}
                </div>
              </div>
            </div>
          )}

          {data.sites.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-secondary)' }}>
              <Bolt size={40} strokeWidth={1} style={{ marginBottom: 12 }} />
              <div style={{ fontWeight: 600, marginBottom: 4 }}>No outage work due in the next 90 days</div>
              <div style={{ fontSize: 'var(--font-size-sm)' }}>
                Outage-requiring tasks outside the ±90-day window won't appear here.
              </div>
            </div>
          )}

          {data.sites.map(site => (
            <SiteSection
              key={site.siteId}
              site={site}
              canWrite={canWrite}
              onScheduled={load}
            />
          ))}
        </>
      )}
    </div>
  );
}
