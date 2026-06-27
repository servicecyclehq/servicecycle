// ─────────────────────────────────────────────────────────────────────────────
// DeficienciesPage.jsx — account-wide deficiency triage list (/deficiencies).
//
// Backed by GET /api/deficiencies (severity / resolved / siteId filters; server
// sorts severity-first then newest — the triage queue ordering). Filters live
// in the URL query string (?severity=IMMEDIATE&resolved=false&siteId=…) so the
// dashboard severity tiles can deep-link straight into a filtered view, and
// browser back/forward + refresh keep the filter state.
//
// Row actions: Resolve (manager+, optional resolution note via a small modal —
// the note is appended to correctiveAction server-side) and Reopen for
// resolved findings (manager+, confirm dialog).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, ShieldCheck } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import Toast from '../components/Toast';
import EmptyState from '../components/EmptyState';
import BackLink, { useFromState } from '../components/BackLink';
import Pagination from '../components/Pagination';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { SEVERITY_META, assetLabel, fmtDate } from '../lib/equipment';

const SEVERITIES = ['IMMEDIATE', 'RECOMMENDED', 'ADVISORY'];

// Whole days since `dateStr`; null-safe so a missing createdAt renders as —.
function ageDays(dateStr) {
  if (!dateStr) return null;
  const t = new Date(dateStr).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000));
}

// ── Filter chip ───────────────────────────────────────────────────────────────
function FilterChip({ label, active, color, bg, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: '4px 12px',
        borderRadius: 999,
        fontSize: 'var(--font-size-sm)',
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        border: `1px solid ${active ? (color || 'var(--color-primary)') : 'var(--color-border-strong)'}`,
        background: active ? (bg || 'var(--color-surface)') : 'transparent',
        color: active ? (color || 'var(--color-primary)') : 'var(--color-text-secondary)',
        transition: 'background 0.1s, color 0.1s, border-color 0.1s',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </button>
  );
}

// ── Severity chip (table cell) ────────────────────────────────────────────────
function SeverityChip({ severity }) {
  const m = SEVERITY_META[severity] || {};
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 999,
      fontSize: 'var(--font-size-xs)', fontWeight: 700, whiteSpace: 'nowrap',
      background: m.bg || 'var(--color-surface)',
      color: m.color || 'var(--color-text-secondary)',
      border: `1px solid ${m.color || 'var(--color-border)'}`,
    }}>
      {m.label || severity}
    </span>
  );
}

// ── Resolve modal ─────────────────────────────────────────────────────────────
// Mirrors AssetDetail's CompleteScheduleModal pattern: small fixed-overlay form
// capturing the optional resolution note before POST /:id/resolve. The server
// appends "[Resolved] <note>" to correctiveAction so the what-was-done
// narrative stays with the finding.
function ResolveModal({ deficiency, onClose, onConfirm, busy }) {
  const [note, setNote] = useState('');
  return (
    <div
      role="dialog" aria-modal="true" aria-label="Resolve deficiency"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <form
        onSubmit={e => { e.preventDefault(); onConfirm(note.trim() || null); }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 460, width: '100%', padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 6 }}>
          Resolve deficiency?
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>
          Marks "{(deficiency.description || '').slice(0, 120)}" as resolved. The resolver
          and timestamp are recorded on the finding.
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>
            Resolution note <span className="text-muted" style={{ fontWeight: 400 }}>— optional</span>
          </label>
          <textarea
            className="form-control form-control-wide"
            rows={3}
            placeholder="What was actually done — e.g. Replaced damaged lug, re-torqued to spec."
            value={note}
            onChange={e => setNote(e.target.value)}
            autoFocus
            style={{ resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Resolving…' : 'Resolve'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Bulk resolve modal (CUST-8-7) ─────────────────────────────────────────────
// Resolves the N selected open findings at once. When the selection contains an
// IMMEDIATE finding, the corrective note is required (≥20 chars) — same rule as
// the single-resolve path, enforced server-side too.
function BulkResolveModal({ count, requireNote, onClose, onConfirm, busy }) {
  const [note, setNote] = useState('');
  const noteTrimmed = note.trim();
  const noteTooShort = requireNote && noteTrimmed.length < 20;
  return (
    <div
      role="dialog" aria-modal="true" aria-label="Resolve selected deficiencies"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <form
        onSubmit={e => { e.preventDefault(); if (!noteTooShort) onConfirm(noteTrimmed || null); }}
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 460, width: '100%', padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 6 }}>
          Resolve {count} deficienc{count === 1 ? 'y' : 'ies'}?
        </div>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5, marginBottom: 14 }}>
          Each selected open finding is marked resolved, stamped with you as the resolver.
          {requireNote && ' The selection includes an IMMEDIATE finding, so a corrective note is required.'}
        </div>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>
            Resolution note{requireNote
              ? <span style={{ color: 'var(--color-danger)', fontWeight: 400 }}> — required (min 20 chars)</span>
              : <span className="text-muted" style={{ fontWeight: 400 }}> — optional</span>}
          </label>
          <textarea
            className="form-control form-control-wide"
            rows={3}
            placeholder="What was done — applied to every selected finding."
            value={note}
            onChange={e => setNote(e.target.value)}
            autoFocus
            style={{ resize: 'vertical', width: '100%', boxSizing: 'border-box' }}
          />
          {noteTooShort && (
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)', marginTop: 4 }}>
              {20 - noteTrimmed.length} more character{20 - noteTrimmed.length !== 1 ? 's' : ''} needed.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || noteTooShort}>
            {busy ? 'Resolving…' : `Resolve ${count}`}
          </button>
        </div>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function DeficienciesPage() {
  useDocumentTitle('Deficiencies');
  const { user } = useAuth();
  const confirm = useConfirm();
  const [searchParams, setSearchParams] = useSearchParams();
  // C1: asset/WO links record this page (incl. active filters) as the origin
  // for their BackLink.
  const fromState = useFromState();

  // ── Filters live in the URL so dashboard tiles can deep-link ──────────────
  const severityParam = searchParams.get('severity');
  const severity = SEVERITIES.includes(severityParam) ? severityParam : '';
  const resolvedParam = searchParams.get('resolved');
  // status: 'open' (default) | 'resolved' | 'all'
  const status = resolvedParam === 'true' ? 'resolved' : resolvedParam === 'all' ? 'all' : 'open';
  const siteId = searchParams.get('siteId') || '';

  function updateFilters(next) {
    const sev = next.severity !== undefined ? next.severity : severity;
    const st  = next.status   !== undefined ? next.status   : status;
    const si  = next.siteId   !== undefined ? next.siteId   : siteId;
    const params = {};
    if (sev) params.severity = sev;
    params.resolved = st === 'resolved' ? 'true' : st === 'all' ? 'all' : 'false';
    if (si) params.siteId = si;
    setSearchParams(params, { replace: true });
  }

  const [deficiencies, setDeficiencies] = useState([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [resolving, setResolving] = useState(null); // deficiency being resolved (modal open)
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  // CUST-8-3: real pagination so items beyond the first page stay reachable.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  // CUST-8-7: multi-select for bulk resolve (open findings only).
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  const canResolve = ['admin', 'manager'].includes(user?.role);

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => { /* dropdown just stays empty */ });
  }, []);

  // Filter changes reset to page 1 (skip the very first mount).
  const filtersKey = `${severity}|${status}|${siteId}`;
  const firstFilterRun = useRef(true);
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return; }
    setPage(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = { page, limit: PAGE_SIZE };
    if (severity) params.severity = severity;
    if (status === 'open') params.resolved = 'false';
    if (status === 'resolved') params.resolved = 'true';
    if (siteId) params.siteId = siteId;
    api.get('/api/deficiencies', { params })
      .then(r => {
        if (cancelled) return;
        const d = r.data?.data || {};
        const list = Array.isArray(d.deficiencies) ? d.deficiencies : [];
        setDeficiencies(list);
        setTotal(d.pagination?.total ?? list.length);
        setTotalPages(d.pagination?.pages ?? 1);
        setSelectedIds(new Set()); // selection is page-scoped — clear on reload
      })
      .catch(() => { if (!cancelled) setError('Failed to load deficiencies.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [severity, status, siteId, page, refreshTick]);

  const refetch = () => setRefreshTick(t => t + 1);

  async function handleResolve(note) {
    if (busy || !resolving) return;
    setBusy(true);
    try {
      await api.post(`/api/deficiencies/${resolving.id}/resolve`, note ? { resolution: note } : {});
      setResolving(null);
      setToast({ message: 'Deficiency resolved.', variant: 'success', duration: 4000 });
      refetch();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to resolve deficiency.', variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  async function handleReopen(def) {
    if (busy) return;
    if (!await confirm({
      title: 'Reopen deficiency?',
      message: `Clears the resolution on "${(def.description || '').slice(0, 120)}" — it returns to the open queue.`,
      confirmLabel: 'Reopen',
    })) return;
    setBusy(true);
    try {
      await api.post(`/api/deficiencies/${def.id}/reopen`);
      setToast({ message: 'Deficiency reopened.', variant: 'success', duration: 4000 });
      refetch();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to reopen deficiency.', variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  // ── Bulk selection (CUST-8-7) ─────────────────────────────────────────────
  // Only OPEN findings on the current page are selectable.
  const openOnPage = deficiencies.filter(d => !d.resolvedAt);
  const allOpenSelected = openOnPage.length > 0 && openOnPage.every(d => selectedIds.has(d.id));
  const anySelected = selectedIds.size > 0;
  // If any selected finding is IMMEDIATE, the bulk note is mandatory (server
  // enforces ≥20 chars too).
  const selectedHasImmediate = deficiencies.some(d => selectedIds.has(d.id) && d.severity === 'IMMEDIATE');

  function toggleOne(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAllOpen() {
    setSelectedIds(prev => {
      if (openOnPage.every(d => prev.has(d.id))) return new Set();
      return new Set(openOnPage.map(d => d.id));
    });
  }

  async function handleBulkResolve(note) {
    if (busy || selectedIds.size === 0) return;
    setBusy(true);
    try {
      const r = await api.post('/api/deficiencies/bulk-resolve', {
        ids: [...selectedIds],
        ...(note ? { resolution: note } : {}),
      });
      const { resolved = 0, skipped = 0 } = r.data?.data || {};
      setBulkOpen(false);
      setSelectedIds(new Set());
      setToast({
        message: skipped
          ? `${resolved} resolved · ${skipped} skipped (already resolved).`
          : `${resolved} deficienc${resolved === 1 ? 'y' : 'ies'} resolved.`,
        variant: 'success', duration: 4000,
      });
      refetch();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to bulk-resolve.', variant: 'error' });
    } finally {
      setBusy(false);
    }
  }

  const statusOptions = [
    { key: 'open',     label: 'Open' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'all',      label: 'All' },
  ];

  return (
    <>
      <div className="page-header">
        <div>
          {/* C1: this page is reached from dashboard tiles, asset pages, … —
              return to the actual origin, defaulting to the dashboard. */}
          <BackLink fallback="/dashboard" fallbackLabel="Dashboard" />
          <h1 className="page-title">Deficiencies</h1>
          <div className="page-subtitle">
            NETA findings across all sites — triage queue, worst severity first
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error">{error}</div>}

        {/* ── Filter row ───────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 16 }}>
          {/* Severity chips */}
          <div role="group" aria-label="Filter by severity" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <FilterChip
              label="All severities"
              active={!severity}
              onClick={() => updateFilters({ severity: '' })}
            />
            {SEVERITIES.map(sev => {
              const m = SEVERITY_META[sev] || {};
              return (
                <FilterChip
                  key={sev}
                  label={m.label || sev}
                  active={severity === sev}
                  color={m.color}
                  bg={m.bg}
                  onClick={() => updateFilters({ severity: severity === sev ? '' : sev })}
                />
              );
            })}
          </div>

          {/* Status chips */}
          <div role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {statusOptions.map(opt => (
              <FilterChip
                key={opt.key}
                label={opt.label}
                active={status === opt.key}
                onClick={() => updateFilters({ status: opt.key })}
              />
            ))}
          </div>

          {/* Site dropdown */}
          <select
            value={siteId}
            onChange={e => updateFilters({ siteId: e.target.value })}
            aria-label="Filter by site"
            style={{
              padding: '4px 10px', fontSize: 'var(--font-size-sm)',
              border: '1px solid var(--color-border-strong)', borderRadius: 'var(--radius)',
              background: 'var(--color-surface)', color: 'var(--color-text)',
              maxWidth: 220,
            }}
          >
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>

        {/* ── Bulk action bar (CUST-8-7) ───────────────────────────────────── */}
        {canResolve && anySelected && (
          <div
            style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '8px 14px', marginBottom: 12, borderRadius: 'var(--radius)',
              background: 'var(--color-primary-light, #eef6f6)',
              border: '1px solid var(--color-primary)',
            }}
          >
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-primary)' }}>
              {selectedIds.size} selected
            </span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => setBulkOpen(true)}
              disabled={busy}
            >
              Resolve selected
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setSelectedIds(new Set())}
              disabled={busy}
            >
              Clear selection
            </button>
          </div>
        )}

        {/* ── List ─────────────────────────────────────────────────────────── */}
        {loading ? (
          <div className="loading">Loading deficiencies…</div>
        ) : deficiencies.length === 0 ? (
          <EmptyState
            icon={status === 'open' ? ShieldCheck : ClipboardCheck}
            title={status === 'open' ? 'No open deficiencies' : 'No deficiencies match these filters'}
            sub={status === 'open'
              ? 'Findings logged from work orders or walkthroughs will show up here for triage.'
              : 'Try widening the severity, status, or site filters.'}
          />
        ) : (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {canResolve && (
                      <th style={{ width: 32 }}>
                        <input
                          type="checkbox"
                          aria-label="Select all open findings on this page"
                          checked={allOpenSelected}
                          ref={el => { if (el) el.indeterminate = anySelected && !allOpenSelected; }}
                          disabled={openOnPage.length === 0 || busy}
                          onChange={toggleAllOpen}
                        />
                      </th>
                    )}
                    <th>Severity</th>
                    <th>Description</th>
                    <th>Asset</th>
                    <th>Site</th>
                    <th style={{ textAlign: 'right' }}>Age</th>
                    <th>Work order</th>
                    {canResolve && <th style={{ textAlign: 'right' }}>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {deficiencies.map(def => {
                    const isResolved = !!def.resolvedAt;
                    const days = ageDays(def.createdAt);
                    // Red age callout: open IMMEDIATE findings older than 90 days.
                    const ageHot = !isResolved && def.severity === 'IMMEDIATE' && days != null && days > 90;
                    const woId = def.workOrder?.id || def.workOrderId || null;
                    return (
                      <tr key={def.id} style={isResolved ? { opacity: 0.75 } : undefined}>
                        {canResolve && (
                          <td style={{ width: 32 }}>
                            {!isResolved && (
                              <input
                                type="checkbox"
                                aria-label={`Select deficiency: ${(def.description || '').slice(0, 60)}`}
                                checked={selectedIds.has(def.id)}
                                disabled={busy}
                                onChange={() => toggleOne(def.id)}
                              />
                            )}
                          </td>
                        )}
                        <td><SeverityChip severity={def.severity} /></td>
                        <td style={{ maxWidth: 380 }}>
                          <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 500, lineHeight: 1.4 }}>
                            {def.description || '—'}
                          </div>
                          {def.correctiveAction && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2, whiteSpace: 'pre-line' }}>
                              {def.correctiveAction}
                            </div>
                          )}
                          {isResolved && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-success, #16a34a)', marginTop: 2 }}>
                              Resolved {fmtDate(def.resolvedAt)}{def.resolvedBy?.name ? ` by ${def.resolvedBy.name}` : ''}
                            </div>
                          )}
                        </td>
                        <td>
                          {def.asset?.id ? (
                            <Link to={`/assets/${def.asset.id}`} state={fromState} style={{ fontWeight: 600, color: 'var(--color-primary)', textDecoration: 'none' }}>
                              {assetLabel(def.asset)}
                            </Link>
                          ) : '—'}
                        </td>
                        <td className="td-muted">{def.asset?.site?.name || '—'}</td>
                        <td style={{ textAlign: 'right' }}>
                          {days == null ? '—' : (
                            <span
                              title={`Logged ${fmtDate(def.createdAt)}`}
                              style={ageHot
                                ? { color: 'var(--color-danger, #dc2626)', fontWeight: 700 }
                                : undefined}
                            >
                              {days}d
                              {ageHot && (
                                <span style={{ display: 'block', fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
                                  &gt;90d open
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td>
                          {woId ? (
                            <Link to={`/work-orders/${woId}`} state={fromState} style={{ color: 'var(--color-primary)', textDecoration: 'none', fontWeight: 600, fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap' }}>
                              View WO →
                            </Link>
                          ) : <span className="td-muted">—</span>}
                        </td>
                        {canResolve && (
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            {isResolved ? (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => handleReopen(def)}
                                disabled={busy}
                              >
                                Reopen
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => setResolving(def)}
                                disabled={busy}
                              >
                                Resolve
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {(totalPages > 1 || total > deficiencies.length) && (
              <Pagination
                page={page}
                totalPages={totalPages}
                disabled={loading}
                label={`${total.toLocaleString()} total · page ${page} of ${totalPages}`}
                onPrev={() => setPage(p => Math.max(1, p - 1))}
                onNext={() => setPage(p => Math.min(totalPages, p + 1))}
              />
            )}
          </div>
        )}
      </div>

      {resolving && (
        <ResolveModal
          deficiency={resolving}
          busy={busy}
          onClose={() => { if (!busy) setResolving(null); }}
          onConfirm={handleResolve}
        />
      )}

      {bulkOpen && (
        <BulkResolveModal
          count={selectedIds.size}
          requireNote={selectedHasImmediate}
          busy={busy}
          onClose={() => { if (!busy) setBulkOpen(false); }}
          onConfirm={handleBulkResolve}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
