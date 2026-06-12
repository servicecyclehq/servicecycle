// ─────────────────────────────────────────────────────────────────────────────
// FieldHome.jsx — Field Mode "My Day" (phone-first).
//
// Layout, top to bottom:
//   • Big SCAN button (→ /field/scan) — the primary field action, pinned first.
//   • Outbox chip (useOutboxStatus): "N queued — sync now" calls flushOutbox().
//   • Site filter <select> (persisted in localStorage 'servicecycle_field_site')
//     + a refresh button (pull-to-refresh substitute).
//   • Four collapsible urgency sections from GET /api/field/summary:
//     Overdue (red) / Due soon / Open work orders / Open deficiencies.
//     Every row is one fat (≥56px) tappable button → /field/asset/:id.
//
// All tap targets ≥48px — built for a gloved hand in a dim electrical room.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { flushOutbox, useOutboxStatus } from '../../lib/fieldApi';
import { assetLabel, fmtDate, EQUIPMENT_TYPE_LABELS, SEVERITY_META, WO_STATUS_META } from '../../lib/equipment';
import { daysUntil } from '../../lib/urgency';

const SITE_KEY = 'servicecycle_field_site';

const chip = (color, bg) => ({
  display: 'inline-block', padding: '4px 10px', borderRadius: 999,
  fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap',
  color, background: bg, flexShrink: 0,
});

function DaysChip({ date, overdue }) {
  const d = daysUntil(date);
  if (d === null) return null;
  if (overdue || d < 0) {
    const n = Math.max(1, Math.abs(d));
    return <span style={chip('#dc2626', '#fef2f2')}>{n}d overdue</span>;
  }
  return <span style={chip('#92400e', '#fffbeb')}>{d === 0 ? 'due today' : `in ${d}d`}</span>;
}

// One fat tappable row: asset label bold, site small, right-side chip.
function AssetRow({ asset, sub, right, onTap, isLast }) {
  return (
    <button
      type="button"
      onClick={onTap}
      style={{
        all: 'unset', boxSizing: 'border-box', cursor: 'pointer',
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        minHeight: 60, padding: '10px 14px',
        borderBottom: isLast ? 'none' : '1px solid var(--color-border)',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontWeight: 700, fontSize: 15, color: 'var(--color-text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {assetLabel(asset)}
        </div>
        <div style={{
          fontSize: 12.5, color: 'var(--color-text-secondary)', marginTop: 2,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {asset?.site?.name ? `${asset.site.name}` : ''}{sub ? `${asset?.site?.name ? ' · ' : ''}${sub}` : ''}
        </div>
      </div>
      {right}
      <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)', fontSize: 18, flexShrink: 0 }}>›</span>
    </button>
  );
}

// Collapsible urgency section: 52px header button with count badge.
function Section({ title, accent, count, open, onToggle, children }) {
  return (
    <div style={{
      background: 'var(--color-surface)', border: '1px solid var(--color-border)',
      borderRadius: 'var(--radius-lg, 12px)', marginBottom: 12, overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          all: 'unset', boxSizing: 'border-box', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          minHeight: 52, padding: '0 14px',
          borderLeft: `4px solid ${accent}`,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <span style={{ fontWeight: 800, fontSize: 15, color: 'var(--color-text)' }}>{title}</span>
        <span style={{
          minWidth: 26, height: 26, padding: '0 7px', borderRadius: 999, boxSizing: 'border-box',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 13, fontWeight: 800, color: count > 0 ? '#fff' : 'var(--color-text-secondary)',
          background: count > 0 ? accent : 'var(--color-bg)',
        }}>
          {count}
        </span>
        <span aria-hidden="true" style={{
          marginLeft: 'auto', color: 'var(--color-text-secondary)',
          transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'none', fontSize: 13,
        }}>
          ▾
        </span>
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--color-border)' }}>
          {count === 0
            ? <div style={{ padding: '14px', fontSize: 13, color: 'var(--color-text-secondary)' }}>Nothing here — clear.</div>
            : children}
        </div>
      )}
    </div>
  );
}

export default function FieldHome() {
  const navigate = useNavigate();
  const { pending, flushing } = useOutboxStatus();

  const [siteId, setSiteId] = useState(() => {
    try { return localStorage.getItem(SITE_KEY) || ''; } catch { return ''; }
  });
  const [sites, setSites] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // All four sections start open — the tech sees the whole day at a glance
  // and collapses what they don't care about.
  const [openSec, setOpenSec] = useState({ overdue: true, dueSoon: true, wo: true, def: true });
  // Quick filters (2026-06-11): equipment type narrows every section's rows;
  // the due-status chips show only the Overdue / Due soon section. Both are
  // client-side over the already-fetched summary.
  const [typeFilter, setTypeFilter] = useState('');
  const [dueFilter, setDueFilter]   = useState(''); // '' | 'overdue' | 'dueSoon'

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => { /* filter just offers "All sites" */ });
  }, []);

  const fetchSummary = useCallback((sid) => {
    setLoading(true);
    setError(null);
    const qs = sid ? `?siteId=${encodeURIComponent(sid)}` : '';
    api.get(`/api/field/summary${qs}`)
      .then(r => setSummary(r.data?.data || null))
      .catch(err => setError(err.response?.data?.error || err.message || 'Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { fetchSummary(siteId); }, [siteId, fetchSummary]);

  function pickSite(e) {
    const v = e.target.value;
    setSiteId(v);
    try {
      if (v) localStorage.setItem(SITE_KEY, v);
      else localStorage.removeItem(SITE_KEY);
    } catch { /* private mode — filter still works for this visit */ }
  }

  const toggle = (k) => setOpenSec(p => ({ ...p, [k]: !p[k] }));
  const go = (assetId) => navigate(`/field/asset/${assetId}`);

  const byType = (rows) => (typeFilter ? rows.filter(r => r.asset?.equipmentType === typeFilter) : rows);
  const overdue = byType(summary?.overdue || []);
  const dueSoon = byType(summary?.dueSoon || []);
  const workOrders = byType(summary?.openWorkOrders || []);
  const deficiencies = byType(summary?.openDeficiencies || []);

  // Equipment types present in today's summary (unfiltered) — drives the
  // quick-filter select so it only offers types the tech can actually see.
  const typeOptions = [...new Set(
    ['overdue', 'dueSoon', 'openWorkOrders', 'openDeficiencies']
      .flatMap(k => summary?.[k] || [])
      .map(r => r.asset?.equipmentType)
      .filter(Boolean)
  )].sort((a, b) => (EQUIPMENT_TYPE_LABELS[a] || a).localeCompare(EQUIPMENT_TYPE_LABELS[b] || b));

  const dueChip = (active) => ({
    flex: 1, minHeight: 44, boxSizing: 'border-box', padding: '0 12px',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    fontSize: 14, fontWeight: 700, borderRadius: 'var(--radius)', cursor: 'pointer',
    background: active ? 'var(--color-primary)' : 'var(--color-surface)',
    color: active ? '#fff' : 'var(--color-text-secondary)',
    border: `1px solid ${active ? 'var(--color-primary)' : 'var(--color-border)'}`,
    WebkitTapHighlightColor: 'transparent',
  });

  return (
    <div>
      {/* ── Big scan button — the field action ─────────────────────────────── */}
      <button
        type="button"
        onClick={() => navigate('/field/scan')}
        style={{
          boxSizing: 'border-box', width: '100%', minHeight: 64,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          background: 'var(--color-primary)', color: '#fff',
          border: 'none', borderRadius: 'var(--radius-lg, 12px)', cursor: 'pointer',
          fontSize: 18, fontWeight: 800, letterSpacing: '0.01em',
          boxShadow: '0 2px 8px rgba(0,0,0,0.18)', marginBottom: 12,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        {/* QR glyph */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          style={{ width: 26, height: 26, flexShrink: 0 }} aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" />
          <rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" />
          <path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h.01M20 17v.01M20 20v.01" />
        </svg>
        Scan equipment
      </button>

      {/* ── Add new equipment from a nameplate photo ───────────────────────── */}
      <button
        type="button"
        onClick={() => navigate('/field/new')}
        style={{
          boxSizing: 'border-box', width: '100%', minHeight: 56,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
          background: '#fff', color: 'var(--color-primary)',
          border: '2px solid var(--color-primary)', borderRadius: 'var(--radius-lg, 12px)', cursor: 'pointer',
          fontSize: 16, fontWeight: 700, marginBottom: 12,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        + Add equipment
      </button>

      {/* ── Outbox status chip ─────────────────────────────────────────────── */}
      {pending > 0 && (
        <button
          type="button"
          onClick={() => flushOutbox()}
          disabled={flushing}
          style={{
            boxSizing: 'border-box', width: '100%', minHeight: 48, marginBottom: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            background: '#fffbeb', color: '#92400e', border: '1px solid #fde68a',
            borderRadius: 'var(--radius-lg, 12px)', cursor: flushing ? 'default' : 'pointer',
            fontSize: 14, fontWeight: 700, opacity: flushing ? 0.7 : 1,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span aria-hidden="true">⇅</span>
          {flushing
            ? 'Syncing…'
            : `${pending} change${pending === 1 ? '' : 's'} queued — sync now`}
        </button>
      )}

      {/* ── Site filter + refresh ──────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <select
          value={siteId}
          onChange={pickSite}
          aria-label="Filter by site"
          style={{
            flex: 1, minHeight: 48, boxSizing: 'border-box', padding: '0 12px',
            fontSize: 15, fontWeight: 600,
            color: 'var(--color-text)', background: 'var(--color-surface)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
          }}
        >
          <option value="">All sites</option>
          {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <button
          type="button"
          onClick={() => fetchSummary(siteId)}
          disabled={loading}
          aria-label="Refresh"
          title="Refresh"
          style={{
            minWidth: 52, minHeight: 48, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--color-surface)', color: 'var(--color-primary)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
            cursor: loading ? 'default' : 'pointer', fontSize: 20,
            WebkitTapHighlightColor: 'transparent',
          }}
        >
          <span aria-hidden="true" style={loading ? { animation: 'fieldspin 0.9s linear infinite', display: 'inline-block' } : undefined}>⟳</span>
          <style>{'@keyframes fieldspin { to { transform: rotate(360deg); } }'}</style>
        </button>
      </div>

      {/* ── Quick filters: equipment type + due status ─────────────────────── */}
      {summary && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {typeOptions.length > 0 && (
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              aria-label="Filter by equipment type"
              style={{
                minHeight: 44, boxSizing: 'border-box', padding: '0 12px',
                fontSize: 14, fontWeight: 600,
                color: typeFilter ? 'var(--color-primary)' : 'var(--color-text)',
                background: 'var(--color-surface)',
                border: `1px solid ${typeFilter ? 'var(--color-primary)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius)',
              }}
            >
              <option value="">All equipment types</option>
              {typeOptions.map(t => (
                <option key={t} value={t}>{EQUIPMENT_TYPE_LABELS[t] || t}</option>
              ))}
            </select>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              aria-pressed={dueFilter === 'overdue'}
              onClick={() => setDueFilter(f => (f === 'overdue' ? '' : 'overdue'))}
              style={dueChip(dueFilter === 'overdue')}
            >
              {dueFilter === 'overdue' ? '✓ ' : ''}Overdue only
            </button>
            <button
              type="button"
              aria-pressed={dueFilter === 'dueSoon'}
              onClick={() => setDueFilter(f => (f === 'dueSoon' ? '' : 'dueSoon'))}
              style={dueChip(dueFilter === 'dueSoon')}
            >
              {dueFilter === 'dueSoon' ? '✓ ' : ''}Due soon only
            </button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" style={{
          padding: '12px 14px', marginBottom: 12, borderRadius: 'var(--radius)',
          background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontSize: 14,
        }}>
          {error}
        </div>
      )}

      {loading && !summary && (
        <div role="status" style={{ padding: 24, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
          Loading your day…
        </div>
      )}

      {summary && (
        <>
          {(!dueFilter || dueFilter === 'overdue') && (
          <Section title="Overdue" accent="#dc2626" count={overdue.length}
            open={openSec.overdue} onToggle={() => toggle('overdue')}>
            {overdue.map((row, i) => (
              <AssetRow
                key={row.schedule.id}
                asset={row.asset}
                sub={row.schedule.taskDefinition?.taskName}
                right={<DaysChip date={row.schedule.nextDueDate} overdue />}
                onTap={() => go(row.asset.id)}
                isLast={i === overdue.length - 1}
              />
            ))}
          </Section>
          )}

          {(!dueFilter || dueFilter === 'dueSoon') && (
          <Section title="Due soon" accent="#d97706" count={dueSoon.length}
            open={openSec.dueSoon} onToggle={() => toggle('dueSoon')}>
            {dueSoon.map((row, i) => (
              <AssetRow
                key={row.schedule.id}
                asset={row.asset}
                sub={row.schedule.taskDefinition?.taskName}
                right={<DaysChip date={row.schedule.nextDueDate} />}
                onTap={() => go(row.asset.id)}
                isLast={i === dueSoon.length - 1}
              />
            ))}
          </Section>
          )}

          {!dueFilter && (
          <Section title="Open work orders" accent="#2563eb" count={workOrders.length}
            open={openSec.wo} onToggle={() => toggle('wo')}>
            {workOrders.map((row, i) => {
              const meta = WO_STATUS_META[row.workOrder.status];
              return (
                <AssetRow
                  key={row.workOrder.id}
                  asset={row.asset}
                  sub={row.workOrder.taskName || (row.workOrder.scheduledDate ? `Scheduled ${fmtDate(row.workOrder.scheduledDate)}` : null)}
                  right={meta ? <span style={chip(meta.color, meta.bg)}>{meta.label}</span> : null}
                  onTap={() => go(row.asset.id)}
                  isLast={i === workOrders.length - 1}
                />
              );
            })}
          </Section>
          )}

          {!dueFilter && (
          <Section title="Open deficiencies" accent="#7c3aed" count={deficiencies.length}
            open={openSec.def} onToggle={() => toggle('def')}>
            {deficiencies.map((row, i) => {
              const meta = SEVERITY_META[row.deficiency.severity];
              return (
                <AssetRow
                  key={row.deficiency.id}
                  asset={row.asset}
                  sub={row.deficiency.description}
                  right={meta ? <span style={chip(meta.color, meta.bg)}>{meta.label}</span> : null}
                  onTap={() => go(row.asset.id)}
                  isLast={i === deficiencies.length - 1}
                />
              );
            })}
          </Section>
          )}
        </>
      )}

      {/* Exit back to the desktop app */}
      <div style={{ textAlign: 'center', marginTop: 18 }}>
        <Link
          to="/dashboard"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 48, padding: '0 18px',
            color: 'var(--color-primary)', fontWeight: 600, fontSize: 14, textDecoration: 'none',
          }}
        >
          ← Back to the full site
        </Link>
      </div>
    </div>
  );
}
