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

import { useState, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ClipboardCheck, ShieldCheck } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import Toast from '../components/Toast';
import EmptyState from '../components/EmptyState';
import BackLink, { useFromState } from '../components/BackLink';
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
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [resolving, setResolving] = useState(null); // deficiency being resolved (modal open)
  const [busy, setBusy] = useState(false);
  const [refreshTick, setRefreshTick] = useState(0);

  const canResolve = ['admin', 'manager'].includes(user?.role);

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => { /* dropdown just stays empty */ });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const params = { limit: 200 };
    if (severity) params.severity = severity;
    if (status === 'open') params.resolved = 'false';
    if (status === 'resolved') params.resolved = 'true';
    if (siteId) params.siteId = siteId;
    api.get('/api/deficiencies', { params })
      .then(r => {
        if (cancelled) return;
        const d = r.data?.data || {};
        setDeficiencies(Array.isArray(d.deficiencies) ? d.deficiencies : []);
        setTotal(d.pagination?.total ?? (Array.isArray(d.deficiencies) ? d.deficiencies.length : 0));
      })
      .catch(() => { if (!cancelled) setError('Failed to load deficiencies.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [severity, status, siteId, refreshTick]);

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
            {total > deficiencies.length && (
              <div style={{ padding: '10px 16px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', borderTop: '1px solid var(--color-border)' }}>
                Showing the first {deficiencies.length} of {total} — narrow the filters to see the rest.
              </div>
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

      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
