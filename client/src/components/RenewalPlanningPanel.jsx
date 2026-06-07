// ─────────────────────────────────────────────────────────────────────────────
// RenewalPlanningPanel.jsx — v0.55.0 contract renewal planning UI
//
// Editable per-SKU planning table mounted ABOVE the AI Renewal Brief on
// ContractDetail. The user types into the inputs, the panel debounces 500ms
// after the last keystroke, then fires PUT /api/contracts/:id/line-items/:lid
// with If-Match for concurrent safety. Result: planning persists across
// sessions / browsers / machines.
//
// Columns:
//   SKU · Product · Original count · Planned new count · Original $/unit ·
//   Planned $/unit · Notes · Last saved
//
// State machine per row:
//   pristine → dirty → saving → saved (or error)
//
// Save-status indicator at the top of the panel summarizes across all rows.
//
// Phase 1a scope (this ship):
//   - List + create + edit (auto-save) + soft-archive
//   - 409 conflict surfaces a toast with "Reload to see latest" — full
//     three-way merge UI lands in Phase 2 (v0.56).
//   - No snapshots / restore yet — also v0.56.
//
// Backend contract: see server/routes/lineItems.js.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Plus, Trash2, RefreshCw, AlertTriangle } from 'lucide-react';
import api from '../api/client';

const DEBOUNCE_MS = 500;

// State per-row for the optimistic / dirty / saving / saved indicator. Lives
// outside the row component so toggling state on one row doesn't re-mount
// inputs in sibling rows. Keyed by lineItem.id.
const ROW_STATE_PRISTINE = 'pristine';
const ROW_STATE_DIRTY    = 'dirty';
const ROW_STATE_SAVING   = 'saving';
const ROW_STATE_SAVED    = 'saved';
const ROW_STATE_ERROR    = 'error';

function fmtMoney(val) {
  if (val == null || val === '') return '—';
  const n = Number(val);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
}

function fmtRelativeTime(date) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  const diffSec = Math.round((Date.now() - d.getTime()) / 1000);
  if (diffSec < 5)  return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const m = Math.round(diffSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return d.toLocaleDateString();
}

export default function RenewalPlanningPanel({ contract, canEdit }) {
  const [lineItems, setLineItems]       = useState([]);
  const [cover, setCover]               = useState({ originalTotal: 0, projectedTotal: 0, delta: 0 });
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [rowStates, setRowStates]       = useState({}); // { [id]: { state, lastSavedAt, error } }
  const [creating, setCreating]         = useState(false);

  // Debounce timers keyed by lineItem.id so multiple rows being edited
  // simultaneously each get their own 500ms timer.
  const debounceTimers = useRef({});
  // Current PUT bodies keyed by lineItem.id — when the timer fires it picks
  // up the latest pending body and ships it.
  const pendingPayloads = useRef({});

  // Initial load
  useEffect(() => {
    if (!contract?.id) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await api.get(`/api/contracts/${contract.id}/line-items`);
        if (cancelled) return;
        const data = res.data?.data || {};
        let items = data.lineItems || [];
        // #14: auto-seed on first view from the contract's invoiced baseline.
        // Server /seed is idempotent (no-op if any line item ever existed, incl.
        // archived) so this never re-creates a row the user deleted.
        if (items.length === 0 && canEdit) {
          try {
            const seedRes = await api.post(`/api/contracts/${contract.id}/line-items/seed`);
            const sd = seedRes.data?.data;
            if (sd && sd.seeded && sd.lineItem) items = [sd.lineItem];
          } catch (e) { /* best-effort: seeding never blocks the panel */ }
        }
        if (cancelled) return;
        setLineItems(items);
        setCover({
          originalTotal:  data.originalTotal  || 0,
          projectedTotal: data.projectedTotal || 0,
          delta:          data.delta          || 0,
        });
        setError('');
      } catch (err) {
        if (!cancelled) setError(err?.response?.data?.error || 'Failed to load line items.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [contract?.id, canEdit]);

  // Recompute the cover summary client-side so the totals update during the
  // debounce window (before the server confirms the save). Server is still
  // authoritative on the next refetch — this is just for instant feedback.
  const liveCover = useMemo(() => {
    let orig = 0, proj = 0;
    for (const r of lineItems) {
      const origUnit = r.originalCostPerUnit == null ? 0 : Number(r.originalCostPerUnit);
      const planUnit = r.plannedNewCostPerUnit == null ? origUnit : Number(r.plannedNewCostPerUnit);
      const planCnt  = r.plannedNewCount == null ? r.originalCount : r.plannedNewCount;
      orig += (r.originalCount || 0) * origUnit;
      proj += (planCnt || 0) * planUnit;
    }
    return {
      originalTotal:  Math.round(orig * 100) / 100,
      projectedTotal: Math.round(proj * 100) / 100,
      delta:          Math.round((proj - orig) * 100) / 100,
    };
  }, [lineItems]);

  const setRowState = useCallback((id, patch) => {
    setRowStates(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }, []);

  // Patch the row optimistically, schedule a debounced PUT carrying everything
  // that's accumulated in the pendingPayloads map for this row.
  const handleRowFieldChange = useCallback((id, field, value) => {
    if (!canEdit) return;

    // Optimistic local update.
    setLineItems(prev => prev.map(li => li.id === id ? { ...li, [field]: value } : li));
    setRowState(id, { state: ROW_STATE_DIRTY, error: null });

    // Stash the field in the pending payload for this row. We merge so a
    // burst of edits across several fields ships in one PUT.
    pendingPayloads.current[id] = {
      ...(pendingPayloads.current[id] || {}),
      [field]: value,
    };

    // Reset the debounce timer.
    if (debounceTimers.current[id]) clearTimeout(debounceTimers.current[id]);
    debounceTimers.current[id] = setTimeout(() => flushRow(id), DEBOUNCE_MS);
  }, [canEdit, setRowState]);

  const flushRow = useCallback(async (id) => {
    const payload = pendingPayloads.current[id];
    if (!payload || Object.keys(payload).length === 0) return;

    // Take a snapshot of what we're shipping and clear the pending map.
    const body = { ...payload };
    delete pendingPayloads.current[id];

    setRowState(id, { state: ROW_STATE_SAVING });

    // Look up the current updatedAt for If-Match. We use the most recent value
    // we know about (either from initial load or the last successful save).
    let ifMatch = null;
    setLineItems(prev => {
      const found = prev.find(li => li.id === id);
      if (found?.updatedAt) ifMatch = found.updatedAt;
      return prev;
    });

    try {
      const res = await api.put(
        `/api/contracts/${contract.id}/line-items/${id}`,
        body,
        { headers: ifMatch ? { 'If-Match': ifMatch } : {} }
      );
      const saved = res.data?.data?.lineItem;
      if (saved) {
        setLineItems(prev => prev.map(li => li.id === id ? saved : li));
      }
      setRowState(id, { state: ROW_STATE_SAVED, lastSavedAt: new Date(), error: null });
    } catch (err) {
      // 409 = concurrent edit. For Phase 1a we surface the message and let
      // the user reload; full three-way merge UI lands in Phase 2.
      const isConflict = err?.response?.status === 409;
      const msg = isConflict
        ? 'Another editor changed this row. Reload the page to see the latest values.'
        : (err?.response?.data?.error || 'Failed to save.');
      setRowState(id, { state: ROW_STATE_ERROR, error: msg });
    }
  }, [contract?.id, setRowState]);

  // Flush any pending edits when the panel unmounts (e.g. user clicks Edit
  // on the contract and the read-mode tree unmounts). Best-effort — if the
  // browser kills the tab there's no way to send the request, but the
  // common nav-away case is covered.
  useEffect(() => {
    return () => {
      for (const id of Object.keys(debounceTimers.current)) {
        clearTimeout(debounceTimers.current[id]);
        flushRow(id);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAddLineItem = useCallback(async () => {
    if (!canEdit) return;
    setCreating(true);
    try {
      const res = await api.post(`/api/contracts/${contract.id}/line-items`, {
        productName:           '',
        originalCount:         0,
        originalCostPerUnit:   null,
        plannedNewCount:       null,
        plannedNewCostPerUnit: null,
        sortOrder:             lineItems.length,
      });
      const created = res.data?.data?.lineItem;
      if (created) {
        setLineItems(prev => [...prev, created]);
        setRowState(created.id, { state: ROW_STATE_PRISTINE });
      }
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to add line item.');
    } finally {
      setCreating(false);
    }
  }, [canEdit, contract?.id, lineItems.length, setRowState]);

  const handleArchive = useCallback(async (id) => {
    if (!canEdit) return;
    // No confirm — soft-archive is reversible (admin can clear archivedAt
    // via SQL in Phase 1a; restore UI lands in v0.56).
    try {
      await api.delete(`/api/contracts/${contract.id}/line-items/${id}`);
      setLineItems(prev => prev.filter(li => li.id !== id));
      setRowStates(prev => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      setError(err?.response?.data?.error || 'Failed to remove line item.');
    }
  }, [canEdit, contract?.id]);

  // Aggregate row state into a single save-status indicator for the header.
  const headerSaveStatus = useMemo(() => {
    const states = Object.values(rowStates);
    if (states.some(s => s.state === ROW_STATE_ERROR))  return { kind: 'error',  text: 'Some changes failed to save' };
    if (states.some(s => s.state === ROW_STATE_SAVING)) return { kind: 'saving', text: 'Saving…' };
    if (states.some(s => s.state === ROW_STATE_DIRTY))  return { kind: 'dirty',  text: 'Unsaved changes' };
    const mostRecent = states
      .filter(s => s.lastSavedAt)
      .map(s => s.lastSavedAt.getTime())
      .reduce((a, b) => Math.max(a, b), 0);
    if (mostRecent > 0)  return { kind: 'saved', text: `Saved ${fmtRelativeTime(new Date(mostRecent))}` };
    return { kind: 'idle', text: null }; // H3-1: don't show until a real save occurs
  }, [rowStates]);

  if (loading) {
    return (
      <div className="card mb-16" id="cd-planning" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
        <div className="card-header"><div className="card-title">📋 Renewal Planning</div></div>
        <div className="card-body"><div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>Loading…</div></div>
      </div>
    );
  }

  return (
    <div className="card mb-16" id="cd-planning" style={{ scrollMarginTop: 'calc(var(--demo-banner-height, 0px) + var(--contract-header-height, 96px) + 56px)' }}>
      <div className="card-header" style={{ alignItems: 'center' }}>
        <div>
          <div className="card-title">📋 Renewal Planning</div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            Edit each line as the renewal cycle progresses — changes auto-save.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <SaveStatusBadge status={headerSaveStatus} />
          {canEdit && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={handleAddLineItem}
              disabled={creating}
              title="Add a new line item / SKU to this contract"
            >
              <Plus size={14} strokeWidth={2} /> Add line item
            </button>
          )}
        </div>
      </div>
      <div className="card-body">
        {error && (
          <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>
            <AlertTriangle size={14} strokeWidth={2} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {error}
          </div>
        )}

        {/* Cover summary */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 16,
          marginBottom: 16,
          padding: '12px 14px',
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius)',
        }}>
          <SummaryStat label="Original annual total" value={fmtMoney(liveCover.originalTotal)} />
          <SummaryStat label="Projected new total"   value={fmtMoney(liveCover.projectedTotal)} />
          <SummaryStat
            label="Delta"
            value={fmtMoney(liveCover.delta)}
            color={liveCover.delta < 0 ? 'var(--color-success)' : liveCover.delta > 0 ? 'var(--color-warning)' : 'var(--color-text-secondary)'}
          />
        </div>

        {lineItems.length === 0 ? (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
            No line items yet.
            {canEdit && <> Click <strong>Add line item</strong> above to plan this renewal SKU-by-SKU.</>}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' }}>
              <thead>
                <tr>
                  <Th>SKU</Th>
                  <Th>Product</Th>
                  <Th align="right">Original count</Th>
                  <Th align="right">Planned</Th>
                  <Th align="right">Original $/unit</Th>
                  <Th align="right">Planned $/unit</Th>
                  <Th>Notes</Th>
                  <Th align="right">Status</Th>
                  {canEdit && <Th align="right" />}
                </tr>
              </thead>
              <tbody>
                {lineItems.map(li => (
                  <LineItemRow
                    key={li.id}
                    lineItem={li}
                    canEdit={canEdit}
                    rowState={rowStates[li.id]}
                    onFieldChange={handleRowFieldChange}
                    onArchive={handleArchive}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function Th({ children, align }) {
  return (
    <th scope="col" style={{
      textAlign: align || 'left',
      fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em',
      color: 'var(--color-text-secondary)',
      padding: '8px 10px',
      borderBottom: '1px solid var(--color-border)',
      background: 'var(--color-bg)',
      whiteSpace: 'nowrap',
    }}>
      {children}
    </th>
  );
}

function SummaryStat({ label, value, color }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 3 }}>
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 500, color: color || 'var(--color-text)' }}>{value}</div>
    </div>
  );
}

function SaveStatusBadge({ status }) {
  const map = {
    saving: { color: 'var(--color-warning)', icon: <RefreshCw size={12} strokeWidth={2} style={{ animation: 'spin 1s linear infinite' }} /> },
    saved:  { color: 'var(--color-success)', icon: null },
    dirty:  { color: 'var(--color-warning)', icon: null },
    error:  { color: 'var(--color-danger)',  icon: <AlertTriangle size={12} strokeWidth={2} /> },
    idle:   { color: 'var(--color-text-secondary)', icon: null },
  };
  const cfg = map[status.kind] || map.idle;
  return (
    <span style={{ fontSize: 'var(--font-size-sm)', color: cfg.color, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {cfg.icon}
      {status.text}
    </span>
  );
}

function LineItemRow({ lineItem, canEdit, rowState, onFieldChange, onArchive }) {
  const li = lineItem;

  // Parse numeric input strings into either Number, null (empty), or undefined
  // (skip). Empty string explicitly resolves to null so "I cleared this" is
  // distinguishable from "I haven't touched this."
  const parseNum = (s) => {
    if (s === '' || s == null) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  };

  const onChangeText = (field) => (e) => onFieldChange(li.id, field, e.target.value === '' ? null : e.target.value);
  const onChangeInt  = (field) => (e) => {
    const v = parseNum(e.target.value);
    if (v === undefined) return; // invalid input, ignore
    onFieldChange(li.id, field, v);
  };
  const onChangeDec  = (field) => (e) => {
    const v = parseNum(e.target.value);
    if (v === undefined) return;
    onFieldChange(li.id, field, v);
  };
  // #15: originalCount is NOT NULL in the DB; empty input coerces to 0 (not null).
  const onChangeIntZero = (field) => (e) => {
    const s = e.target.value;
    if (s === '') { onFieldChange(li.id, field, 0); return; }
    const n = Number(s);
    if (Number.isFinite(n)) onFieldChange(li.id, field, n);
  };

  // v0.55.1: always-visible dashed border at rest so the input affordance is
  // obvious in dark mode. Hover bumps to solid border + a faint background tint.
  // Focus state takes over with the full surface background. Pattern matches
  // Airtable / Notion spreadsheet cells.
  const inputStyle = {
    width: '100%',
    padding: '4px 8px',
    border: '1px dashed var(--color-border)',
    borderRadius: 4,
    fontSize: 'var(--font-size-ui)',
    background: 'transparent',
    color: 'var(--color-text)',
    outline: 'none',
    transition: 'border-color 0.1s ease, background 0.1s ease',
  };
  const inputHoverStyle = {
    border: '1px solid var(--color-border-strong)',
    background: 'var(--color-bg)',
  };
  const inputFocusStyle = {
    border: '1px solid var(--color-primary)',
    background: 'var(--color-surface)',
  };
  const inputRestStyle = {
    border: '1px dashed var(--color-border)',
    background: 'transparent',
  };

  const td = { padding: '6px 10px', borderBottom: '1px solid var(--color-border)', verticalAlign: 'middle' };

  const state = rowState?.state || ROW_STATE_PRISTINE;
  const statusDot = state === ROW_STATE_SAVING ? 'var(--color-warning)'
                  : state === ROW_STATE_DIRTY  ? 'var(--color-warning)'
                  : state === ROW_STATE_SAVED  ? 'var(--color-success)'
                  : state === ROW_STATE_ERROR  ? 'var(--color-danger)'
                  : null;

  return (
    <tr>
      <td style={td}>
        <input
          type="text"
          value={li.sku || ''}
          onChange={onChangeText('sku')}
          disabled={!canEdit}
          aria-label="SKU" placeholder="Add SKU"
          style={inputStyle}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
      <td style={td}>
        <input
          type="text"
          value={li.productName || ''}
          onChange={onChangeText('productName')}
          disabled={!canEdit}
          aria-label="Product name" placeholder="Enter product name"
          style={{ ...inputStyle, fontWeight: 500 }}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
            <td style={{ ...td, textAlign: 'right' }}>
        <input
          type="number"
          inputMode="numeric"
          min="0"
          value={li.originalCount ?? ''}
          onChange={onChangeIntZero('originalCount')}
          disabled={!canEdit}
          aria-label="Original quantity" placeholder="Enter qty"
          style={{ ...inputStyle, textAlign: 'right', maxWidth: 100 }}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <input
          type="number"
          inputMode="numeric"
          min="0"
          value={li.plannedNewCount ?? ''}
          onChange={onChangeInt('plannedNewCount')}
          disabled={!canEdit}
          aria-label="Planned quantity" placeholder="Enter qty"
          style={{ ...inputStyle, textAlign: 'right', maxWidth: 100 }}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
            <td style={{ ...td, textAlign: 'right' }}>
        <input
          type="number"
          inputMode="decimal"
          step="0.0001"
          min="0"
          value={li.originalCostPerUnit ?? ''}
          onChange={onChangeDec('originalCostPerUnit')}
          disabled={!canEdit}
          aria-label="Original price per unit" placeholder="Enter price"
          style={{ ...inputStyle, textAlign: 'right', maxWidth: 110 }}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        <input
          type="number"
          inputMode="decimal"
          step="0.0001"
          min="0"
          value={li.plannedNewCostPerUnit ?? ''}
          onChange={onChangeDec('plannedNewCostPerUnit')}
          disabled={!canEdit}
          aria-label="Planned price per unit" placeholder="Enter price"
          style={{ ...inputStyle, textAlign: 'right', maxWidth: 110 }}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
      <td style={td}>
        <input
          type="text"
          value={li.notes || ''}
          onChange={onChangeText('notes')}
          disabled={!canEdit}
          aria-label="Notes" placeholder="Add notes"
          style={inputStyle}
          onFocus={(e) => Object.assign(e.target.style, inputFocusStyle)}
          onBlur={(e) => Object.assign(e.target.style, inputRestStyle)}
        />
      </td>
      <td style={{ ...td, textAlign: 'right' }}>
        {statusDot ? (
          <span
            role="img"
            aria-label={`Row status: ${rowState?.error || state}`}
            title={rowState?.error || state}
            style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: statusDot }}
          />
        ) : null}
      </td>
      {canEdit && (
        <td style={{ ...td, textAlign: 'right' }}>
          <button
            type="button"
            onClick={() => onArchive(li.id)}
            title="Remove this line item (soft-archive, reversible)"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', padding: 4 }}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-danger)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)'; }}
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </td>
      )}
    </tr>
  );
}
