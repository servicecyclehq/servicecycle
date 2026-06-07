import { useState, useEffect, useCallback, useMemo } from 'react';
import { BarChart3 } from 'lucide-react';
import api from '../api/client';
import RowCheckbox from '../components/system/RowCheckbox';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import EmptyState from '../components/EmptyState';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function fmtMoney(val) {
  if (val == null || isNaN(val)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtPct(curr, delta) {
  if (!curr || curr === 0) return null;
  return ((delta / curr) * 100).toFixed(1);
}

function DeptRollupCard({ loading, byDepartment, rows, totalCurrent, totalProjected, totalDelta, pctChange }) {
  return (
    <div className="card">
      {loading ? (
        <div className="loading">Building department rollup…</div>
      ) : !byDepartment || byDepartment.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No active contracts to forecast"
          sub="The budget projection draws from your active contracts' renewal dates and amounts. Add a few contracts to see the curve fill in."
          ctaLabel="+ New contract"
          ctaTo="/contracts/new"
        />
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th scope="col" scope="col">Department</th>
                <th scope="col" style={{ textAlign: 'right' }}>Contracts</th>
                <th scope="col" style={{ textAlign: 'right' }}>Current Spend</th>
                <th scope="col" style={{ textAlign: 'right' }}>Projected Spend</th>
                <th scope="col" style={{ textAlign: 'right' }}>Delta</th>
                <th scope="col" style={{ textAlign: 'right' }}>% Change</th>
              </tr>
            </thead>
            <tbody>
              {byDepartment.map(d => {
                const pct = fmtPct(d.currentTotal, d.delta);
                const color = d.delta > 0
                  ? 'var(--color-danger)'
                  : d.delta < 0 ? 'var(--color-success)' : 'var(--color-text-secondary)';
                return (
                  <tr key={d.department}>
                    <td style={{ fontWeight: 600 }}>{d.department}</td>
                    <td style={{ textAlign: 'right' }}>{d.count}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(d.currentTotal)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(d.projectedTotal)}</td>
                    <td style={{ textAlign: 'right', color, fontWeight: 600 }}>{fmtMoney(d.delta)}</td>
                    <td style={{ textAlign: 'right', color }}>{pct != null ? `${pct}%` : '—'}</td>
                  </tr>
                );
              })}
              <tr style={{ background: 'var(--color-surface)', fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{rows.length}</td>
                <td style={{ textAlign: 'right' }}>{fmtMoney(totalCurrent)}</td>
                <td style={{ textAlign: 'right' }}>{fmtMoney(totalProjected)}</td>
                <td style={{ textAlign: 'right', color: totalDelta > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>{fmtMoney(totalDelta)}</td>
                <td style={{ textAlign: 'right' }}>{pctChange != null ? `${pctChange}%` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// (Phase 3) Category rollup — mirrors DeptRollupCard. First column shows
// icon + name with the category's color band.
function CatRollupCard({ loading, byCategory, rows, totalCurrent, totalProjected, totalDelta, pctChange }) {
  return (
    <div className="card">
      {loading ? (
        <div className="loading">Building category rollup…</div>
      ) : !byCategory || byCategory.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title="No active contracts to forecast"
          sub="The budget projection draws from your active contracts' renewal dates and amounts. Add a few contracts to see the curve fill in."
          ctaLabel="+ New contract"
          ctaTo="/contracts/new"
        />
      ) : (
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th scope="col" scope="col">Category</th>
                <th scope="col" style={{ textAlign: 'right' }}>Contracts</th>
                <th scope="col" style={{ textAlign: 'right' }}>Current Spend</th>
                <th scope="col" style={{ textAlign: 'right' }}>Projected Spend</th>
                <th scope="col" style={{ textAlign: 'right' }}>Delta</th>
                <th scope="col" style={{ textAlign: 'right' }}>% Change</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.map(c => {
                const pct = fmtPct(c.currentTotal, c.delta);
                const color = c.delta > 0
                  ? 'var(--color-danger)'
                  : c.delta < 0 ? 'var(--color-success)' : 'var(--color-text-secondary)';
                return (
                  <tr key={c.categoryId || 'uncategorized'}>
                    <td style={{ fontWeight: 600 }}>
                      <span style={{
                        display: 'inline-block',
                        width: 4,
                        height: 14,
                        marginRight: 8,
                        verticalAlign: 'middle',
                        background: c.categoryColor || 'var(--color-border)',
                        borderRadius: 2,
                      }} />
                      {c.categoryIcon && <span style={{ marginRight: 4 }}>{c.categoryIcon}</span>}
                      {c.categoryName}
                    </td>
                    <td style={{ textAlign: 'right' }}>{c.count}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(c.currentTotal)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(c.projectedTotal)}</td>
                    <td style={{ textAlign: 'right', color, fontWeight: 600 }}>{fmtMoney(c.delta)}</td>
                    <td style={{ textAlign: 'right', color }}>{pct != null ? `${pct}%` : '—'}</td>
                  </tr>
                );
              })}
              <tr style={{ background: 'var(--color-surface)', fontWeight: 700 }}>
                <td>TOTAL</td>
                <td style={{ textAlign: 'right' }}>{rows.length}</td>
                <td style={{ textAlign: 'right' }}>{fmtMoney(totalCurrent)}</td>
                <td style={{ textAlign: 'right' }}>{fmtMoney(totalProjected)}</td>
                <td style={{ textAlign: 'right', color: totalDelta > 0 ? 'var(--color-danger)' : 'var(--color-success)' }}>{fmtMoney(totalDelta)}</td>
                <td style={{ textAlign: 'right' }}>{pctChange != null ? `${pctChange}%` : '—'}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ label, value, sub, highlight }) {
  return (
    <div className="card" style={{ padding: '16px 20px', minWidth: 180 }}>
      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: highlight || 'var(--color-text)' }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export default function BudgetForecast() {
  useDocumentTitle('Budget forecast');
  const { user } = useAuth();
  const confirm = useConfirm();
  const canEdit = ['admin', 'manager'].includes(user?.role);

  const [rows, setRows] = useState([]);
  const [byDepartment, setByDepartment] = useState(null); // (A2 5/02) dept rollup
  const [byCategory, setByCategory] = useState(null);     // (Phase 3) category rollup
  const [viewBy, setViewBy] = useState('contract');        // 'contract' | 'department' | 'category'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');

  // ── Bulk-edit state (2026-05-02 session 4) ────────────────────────────────
  const [selected, setSelected] = useState(() => new Set()); // contract IDs
  const [searchQuery, setSearchQuery] = useState('');
  const [deptFilter, setDeptFilter] = useState('');          // '' = all
  const [vendorFilter, setVendorFilter] = useState('');      // '' = all vendors
  const [ownerFilter, setOwnerFilter] = useState('');        // '' = all owners
  const [bulkUplift, setBulkUplift] = useState('');
  const [bulkQty, setBulkQty] = useState('');
  const [savingAll, setSavingAll] = useState(false);

  // v0.92.3 (QA CLS/DOM fix): display-only pagination. The edit model, totals,
  // dirty-tracking, Save All and bulk-apply all operate on the full rows/
  // filteredRows sets; only the rendered slice is paged, to cap DOM size
  // (was ~2,437 nodes on /budget) and the layout shift when data lands.
  const PAGE_SIZE = 25;
  const [page, setPage] = useState(1);

  // Fetch base forecast data from server. When viewBy === 'department' we
  // ask the server for the rollup so the dept totals come from the same code
  // path as the Excel export -- no client-side drift.
  const loadForecast = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = viewBy === 'department' ? { groupBy: 'department' }
                   : viewBy === 'category'   ? { groupBy: 'category' }
                   : {};
      const res = await api.get('/api/budget/forecast', { params });
      setByDepartment(res.data.data.byDepartment || null);
      setByCategory(res.data.data.byCategory || null);   // (Phase 3)
      setRows(res.data.data.rows.map((r) => ({
        ...r,
        neededQty: r.neededQty,
        upliftPct: r.upliftPct,
        // Track saved state per-row; initially "saved" (no pending changes)
        neededQtySaved: r.savedNeededQty != null,
        upliftSaved: true,
        rowDirty: false,
      })));
    } catch (err) {
      setError('Failed to load forecast data.');
    } finally {
      setLoading(false);
    }
  }, [viewBy]);

  useEffect(() => { loadForecast(); }, [loadForecast]);

  // Recompute projections + delta after a field change. Pure helper so we can
  // reuse it for per-vendor uplift propagation and bulk-apply.
  function recalc(row) {
    const uplift = parseFloat(row.upliftPct) || 0;
    const needed = parseInt(row.neededQty) || 0;
    const unitPrice = row.currentUnitPrice;
    const projectedUnitPrice = unitPrice != null ? unitPrice * (1 + uplift / 100) : null;
    const projectedTotal = projectedUnitPrice != null ? projectedUnitPrice * needed : null;
    const delta = row.currentTotal != null && projectedTotal != null
      ? projectedTotal - row.currentTotal
      : null;
    return { ...row, projectedUnitPrice, projectedTotal, delta };
  }

  // Update a single field on a row. Uplift % is a vendor-level field on the
  // server (vendor.budgetUpliftPercent), so editing it on one row must
  // propagate to all other rows for the same vendor — otherwise the user
  // sees stale values on sibling rows until the next reload.
  const updateRow = (id, field, value) => {
    setRows((prev) => {
      const target = prev.find((r) => r.id === id);
      if (!target) return prev;

      if (field === 'upliftPct') {
        return prev.map((r) =>
          r.vendorId === target.vendorId
            ? recalc({ ...r, upliftPct: value, upliftSaved: false, rowDirty: true })
            : r
        );
      }

      // Per-row fields (neededQty)
      return prev.map((r) =>
        r.id === id
          ? recalc({ ...r, [field]: value, neededQtySaved: false, rowDirty: true })
          : r
      );
    });
  };

  // (saveUplift / saveNeededQty removed — superseded by saveRow + saveAllDirty
  // and the per-vendor propagation in updateRow. The per-row Save button now
  // handles both fields and the global Save handles batches.)

  // Save both neededQty and uplift% for a row in one click. Saving a row also
  // saves its vendor's uplift, which clears dirty flags on every sibling row
  // for the same vendor.
  const saveRow = async (row) => {
    try {
      await Promise.all([
        api.put(`/api/budget/contract-needed-qty/${row.id}`, { budgetNeededQty: row.neededQty }),
        api.put(`/api/budget/vendor-uplift/${row.vendorId}`, { budgetUpliftPercent: row.upliftPct }),
      ]);
      setRows((prev) =>
        prev.map((r) => {
          // The just-saved row is fully clean.
          if (r.id === row.id) return { ...r, neededQtySaved: true, upliftSaved: true, rowDirty: r.neededQty !== row.neededQty ? r.rowDirty : false };
          // Sibling rows for the same vendor: their uplift is now in sync;
          // they remain dirty only if their own neededQty is still pending.
          if (r.vendorId === row.vendorId) return { ...r, upliftSaved: true, rowDirty: !r.neededQtySaved };
          return r;
        })
      );
      setSavedMsg(`Saved ${row.product}`);
      setTimeout(() => setSavedMsg(''), 3000);
    } catch (err) {
      // See saveAllDirty's matching catch for the rationale on
      // demoBlocked. Same pattern: row stays dirty (correct), toast
      // already informed the user, suppress the local error string.
      if (!err?.demoBlocked) {
        setError('Failed to save row.');
      }
    }
  };

  // Save every dirty row in one shot. Vendor uplifts are deduplicated (uplift
  // is a vendor-level field, so two rows for the same vendor only need one
  // PUT). Per-contract neededQty is saved per dirty row.
  //
  // Lost-edit protection: capture the snapshot of dirty IDs at save initiation
  // and only clear flags for THOSE rows on success. If the user types into a
  // different row mid-save, that edit stays dirty and is included in the next
  // Save All click instead of being silently marked clean.
  const saveAllDirty = async () => {
    const dirty = rows.filter((r) => r.rowDirty);
    if (dirty.length === 0) return;

    // Snapshot the EXACT values we're sending to the server, keyed by row
    // id. Mid-save edits are detected by comparing post-save row state to
    // this snapshot — the prior version of this code cleared rowDirty
    // unconditionally for every row in `dirtyIds`, silently losing any
    // edits the user made during the round-trip.
    const snapshotByRowId = new Map(
      dirty.map((r) => [r.id, {
        upliftPct: r.upliftPct,
        neededQty: r.neededQty,
        vendorId:  r.vendorId,
      }]),
    );

    // Deduplicate vendor uplifts — last-write-wins per vendor. Capture the
    // exact uplift sent per vendor so sibling-row dirty detection compares
    // against what actually hit the server.
    const upliftByVendor = new Map();
    for (const r of dirty) {
      if (!r.upliftSaved) upliftByVendor.set(r.vendorId, r.upliftPct);
    }

    setSavingAll(true);
    setError('');
    try {
      const promises = [];
      for (const [vendorId, upliftPct] of upliftByVendor.entries()) {
        promises.push(api.put(`/api/budget/vendor-uplift/${vendorId}`, { budgetUpliftPercent: upliftPct }));
      }
      for (const r of dirty) {
        if (!r.neededQtySaved) {
          promises.push(api.put(`/api/budget/contract-needed-qty/${r.id}`, { budgetNeededQty: r.neededQty }));
        }
      }
      await Promise.all(promises);

      // Only mark fields clean that match what we actually sent. If the user
      // typed a new value during the round-trip, keep that row dirty and
      // reset the relevant saved flag so the next Save All re-sends it.
      setRows((prev) => prev.map((r) => {
        const snap = snapshotByRowId.get(r.id);
        const sentUpliftForVendor = upliftByVendor.get(r.vendorId);

        if (snap) {
          const upliftMatchesSent =
            sentUpliftForVendor === undefined || r.upliftPct === sentUpliftForVendor;
          const neededQtyMatchesSent = r.neededQty === snap.neededQty;

          return {
            ...r,
            upliftSaved:    upliftMatchesSent ? true  : false,
            neededQtySaved: neededQtyMatchesSent ? true : false,
            rowDirty:       !(upliftMatchesSent && neededQtyMatchesSent),
          };
        }

        // Sibling row: same vendor as a row we saved, so its vendor uplift
        // just got persisted server-side. Clean the upliftSaved flag only if
        // the row's local upliftPct still matches what we sent.
        if (sentUpliftForVendor !== undefined) {
          const upliftMatchesSent = r.upliftPct === sentUpliftForVendor;
          return {
            ...r,
            upliftSaved: upliftMatchesSent ? true : false,
            rowDirty:    upliftMatchesSent ? !r.neededQtySaved : true,
          };
        }
        return r;
      }));
      setSavedMsg(`Saved ${dirty.length} row${dirty.length === 1 ? '' : 's'} · ${promises.length} update${promises.length === 1 ? '' : 's'}`);
      setTimeout(() => setSavedMsg(''), 4000);
    } catch (err) {
      // Audit Cluster D P0 (W7 polish): demoGuard 403 used to show the
      // alarming "Failed to save all changes" message on top of the
      // DemoBlockedToast banner — confusing in demo mode where the
      // 403 is the intended behaviour. api/client.js tags demo-blocked
      // errors with `error.demoBlocked = true`; suppress the local error
      // text in that case (the toast already explained what happened).
      // The dirty-row state was never cleared in this branch, so the
      // user can still see their edits weren't persisted.
      if (err?.demoBlocked) {
        // Toast was already fired by the interceptor. No-op locally so
        // the row dirty state stays visible as the only "this didn't
        // save" signal.
      } else {
        setError('Failed to save all changes. Some rows may have saved — reload to verify.');
      }
    } finally {
      setSavingAll(false);
    }
  };

  // Re-fetch from server to discard local edits.
  const discardAllChanges = async () => {
    if (!await confirm({
      title: 'Discard unsaved changes',
      message: 'Discard all unsaved changes? This will reload values from the server.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    setSelected(new Set());
    await loadForecast();
  };

  // ── Bulk apply to selected rows ───────────────────────────────────────────
  const applyBulkUplift = () => {
    if (bulkUplift === '' || isNaN(parseFloat(bulkUplift))) {
      setError('Enter a valid uplift % to apply.');
      return;
    }
    const value = bulkUplift;
    setRows((prev) => {
      const selectedVendorIds = new Set(prev.filter((r) => selected.has(r.id)).map((r) => r.vendorId));
      return prev.map((r) =>
        selectedVendorIds.has(r.vendorId)
          ? recalc({ ...r, upliftPct: value, upliftSaved: false, rowDirty: true })
          : r
      );
    });
    setBulkUplift('');
  };

  const applyBulkQty = () => {
    if (bulkQty === '' || isNaN(parseInt(bulkQty))) {
      setError('Enter a valid needed qty to apply.');
      return;
    }
    const value = bulkQty;
    setRows((prev) =>
      prev.map((r) =>
        selected.has(r.id)
          ? recalc({ ...r, neededQty: value, neededQtySaved: false, rowDirty: true })
          : r
      )
    );
    setBulkQty('');
  };

  const toggleSelected = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelected(new Set());

  // Export to Excel
  const handleExport = async () => {
    setExporting(true);
    try {
      const response = await api.post(
        '/api/budget/export',
        { rows, companyName: user?.account?.companyName },
        { responseType: 'blob' }
      );
      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement('a');
      link.href = url;
      const date = new Date().toISOString().split('T')[0];
      link.setAttribute('download', `LapseIQ_Budget_Forecast_${date}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      setError('Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  // Totals — over the *full* dataset, not the filtered view, so summary cards
  // remain a stable reference even while the user narrows the table.
  const totalCurrent   = rows.reduce((s, r) => s + (r.currentTotal   || 0), 0);
  const totalProjected = rows.reduce((s, r) => s + (r.projectedTotal  || 0), 0);
  const totalDelta     = totalProjected - totalCurrent;
  const pctChange      = totalCurrent > 0 ? ((totalDelta / totalCurrent) * 100).toFixed(1) : null;

  // ── Filtering + dirty derivation ──────────────────────────────────────────
  const departments = useMemo(() => {
    const seen = new Set();
    for (const r of rows) {
      if (r.department) seen.add(r.department);
    }
    return Array.from(seen).sort();
  }, [rows]);

  const vendors = useMemo(() => {
    const seen = new Set();
    for (const r of rows) {
      if (r.vendorName) seen.add(r.vendorName);
    }
    return Array.from(seen).sort();
  }, [rows]);

  const owners = useMemo(() => {
    const seen = new Set();
    for (const r of rows) {
      if (r.internalOwner) seen.add(r.internalOwner);
    }
    return Array.from(seen).sort();
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (deptFilter   && r.department   !== deptFilter)   return false;
      if (vendorFilter && r.vendorName   !== vendorFilter) return false;
      if (ownerFilter  && r.internalOwner !== ownerFilter)  return false;
      if (q) {
        const hay = `${r.vendorName} ${r.product} ${r.department || ''} ${r.internalOwner || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, searchQuery, deptFilter, vendorFilter, ownerFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  useEffect(() => { if (page > pageCount) setPage(1); }, [pageCount, page]);
  useEffect(() => { setPage(1); }, [searchQuery, deptFilter, vendorFilter, ownerFilter]);
  const pageRows = useMemo(
    () => filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [filteredRows, page]
  );

  const dirtyCount = useMemo(() => rows.filter((r) => r.rowDirty).length, [rows]);

  // Header checkbox state: count of selected within the *filtered* set
  const filteredSelectedCount = useMemo(
    () => filteredRows.reduce((n, r) => n + (selected.has(r.id) ? 1 : 0), 0),
    [filteredRows, selected]
  );
  const allFilteredSelected = filteredRows.length > 0 && filteredSelectedCount === filteredRows.length;
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const r of filteredRows) next.delete(r.id);
      } else {
        for (const r of filteredRows) next.add(r.id);
      }
      return next;
    });
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Budget Forecast</h1>
          <div className="page-subtitle">
            Annual renewal cost projections with YoY uplift · {rows.length} active contract{rows.length !== 1 ? 's' : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* (A2 5/02) View toggle: per-contract editing vs department rollup. */}
          <div style={{ display: 'inline-flex', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
            {[
              { id: 'contract',   label: '≡ By Contract' },
              { id: 'department', label: '🏷 By Department' },
              { id: 'category',   label: '📂 By Category' },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setViewBy(t.id)}
                style={{
                  padding: '6px 12px', fontSize: 'var(--font-size-sm)', fontWeight: 600,
                  border: 'none', cursor: 'pointer',
                  background: viewBy === t.id ? 'var(--color-primary)' : 'var(--color-surface)',
                  color:      viewBy === t.id ? 'var(--color-on-primary, white)' : 'var(--color-text-secondary)',
                  transition: 'background 0.15s, color 0.15s',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={exporting || rows.length === 0}
          >
            {exporting ? 'Generating…' : '↓ Export to Excel'}
          </button>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error">{error}</div>}
        {savedMsg && <div className="alert alert-success">{savedMsg}</div>}

        {/* Summary cards */}
        {!loading && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <SummaryCard
              label="Current Annual Spend"
              value={fmtMoney(totalCurrent)}
              sub="Based on current qty × unit price"
            />
            <SummaryCard
              label="Projected Annual Spend"
              value={fmtMoney(totalProjected)}
              sub="Based on needed qty × uplifted price"
              highlight="var(--color-primary)"
            />
            <SummaryCard
              label="Total Budget Variance"
              value={fmtMoney(totalDelta)}
              sub={pctChange != null ? `${pctChange}% increase` : undefined}
              highlight={totalDelta > 0 ? 'var(--color-danger)' : 'var(--color-success)'}
            />
            <SummaryCard
              label="Contracts"
              value={rows.length}
              sub="Active + under review"
            />
          </div>
        )}

        {/* Instructions */}
        <div className="alert alert-info" style={{ marginBottom: 16, whiteSpace: 'normal', overflowWrap: 'break-word' }}>
          <strong>How to use:</strong> Edit <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Needed Qty</span> and <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>Uplift %</span> on any row. Use the checkboxes to <strong>bulk-apply</strong> a value to many rows at once, then hit <strong>Save All</strong> at the bottom. A ✓ means the row is saved — values reload next session. Export when ready.
        </div>

        {/* Filter row — search + vendor + department + owner, only shown in contract view */}
        {viewBy === 'contract' && rows.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              type="search"
              placeholder="Search vendor, product, owner…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                flex: '1 1 200px', maxWidth: 300, padding: '6px 10px',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)',
                background: 'var(--color-surface)', color: 'var(--color-text)',
              }}
            />
            <select
              aria-label="Filter by vendor"
              value={vendorFilter}
              onChange={(e) => setVendorFilter(e.target.value)}
              style={{
                padding: '6px 10px', border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', minWidth: 150,
                background: 'var(--color-surface)', color: 'var(--color-text)',
              }}
            >
              <option value="">All vendors</option>
              {vendors.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <select
              aria-label="Filter by department"
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
              style={{
                padding: '6px 10px', border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', minWidth: 150,
                background: 'var(--color-surface)', color: 'var(--color-text)',
              }}
            >
              <option value="">All departments</option>
              {departments.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select
              aria-label="Filter by owner"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              style={{
                padding: '6px 10px', border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', minWidth: 140,
                background: 'var(--color-surface)', color: 'var(--color-text)',
              }}
            >
              <option value="">All owners</option>
              {owners.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            {(searchQuery || deptFilter || vendorFilter || ownerFilter) && (
              <button
                onClick={() => { setSearchQuery(''); setDeptFilter(''); setVendorFilter(''); setOwnerFilter(''); }}
                style={{
                  padding: '6px 10px', fontSize: 'var(--font-size-sm)', background: 'none',
                  border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
                  cursor: 'pointer', color: 'var(--color-text-secondary)',
                }}
              >
                Clear
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              {filteredRows.length === rows.length
                ? `${rows.length} row${rows.length === 1 ? '' : 's'}`
                : `${filteredRows.length} of ${rows.length} rows`}
            </span>
          </div>
        )}

        {/* Bulk-apply toolbar — appears when rows are selected */}
        {viewBy === 'contract' && canEdit && selected.size > 0 && (
          <div style={{
            display: 'flex', gap: 12, marginBottom: 12, padding: '10px 14px',
            background: 'var(--color-primary-light)',
            border: '1px solid var(--color-primary)', borderRadius: 'var(--radius)',
            flexWrap: 'wrap', alignItems: 'center',
          }}>
            <strong style={{ fontSize: 'var(--font-size-ui)' }}>{selected.size} selected</strong>
            <span style={{ color: 'var(--color-text-secondary)' }}>·</span>

            <label style={{ fontSize: 'var(--font-size-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Apply Uplift %
              <input
                type="number"
                aria-label="Bulk uplift % to apply to selected rows"
                min="0"
                max="100"
                step="0.5"
                placeholder="e.g. 10"
                value={bulkUplift}
                onChange={(e) => setBulkUplift(e.target.value)}
                style={{ width: 70, padding: '4px 6px', border: '1px solid var(--color-primary)', borderRadius: 4, fontSize: 'var(--font-size-sm)' }}
              />
              <button
                type="button"
                onClick={applyBulkUplift}
                disabled={bulkUplift === ''}
                style={{
                  fontSize: 'var(--font-size-xs)', padding: '4px 10px', cursor: bulkUplift === '' ? 'not-allowed' : 'pointer',
                  background: 'var(--color-primary)', color: 'var(--color-surface)', border: 'none', borderRadius: 4,
                  fontWeight: 600, opacity: bulkUplift === '' ? 0.5 : 1,
                }}
              >
                Apply to {selected.size}
              </button>
            </label>

            <span style={{ color: 'var(--color-text-secondary)' }}>·</span>

            <label style={{ fontSize: 'var(--font-size-sm)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              Apply Needed Qty
              <input
                type="number"
                aria-label="Bulk Needed Qty to apply to selected rows"
                min="0"
                placeholder="e.g. 100"
                value={bulkQty}
                onChange={(e) => setBulkQty(e.target.value)}
                style={{ width: 80, padding: '4px 6px', border: '1px solid var(--color-primary)', borderRadius: 4, fontSize: 'var(--font-size-sm)' }}
              />
              <button
                type="button"
                onClick={applyBulkQty}
                disabled={bulkQty === ''}
                style={{
                  fontSize: 'var(--font-size-xs)', padding: '4px 10px', cursor: bulkQty === '' ? 'not-allowed' : 'pointer',
                  background: 'var(--color-primary)', color: 'var(--color-surface)', border: 'none', borderRadius: 4,
                  fontWeight: 600, opacity: bulkQty === '' ? 0.5 : 1,
                }}
              >
                Apply to {selected.size}
              </button>
            </label>

            <button
              type="button"
              onClick={clearSelection}
              style={{
                marginLeft: 'auto', fontSize: 'var(--font-size-sm)', padding: '4px 10px',
                background: 'none', border: '1px solid var(--color-border)', borderRadius: 4,
                cursor: 'pointer', color: 'var(--color-text-secondary)',
              }}
            >
              Clear selection
            </button>
          </div>
        )}

        {viewBy === 'department' ? (
          <DeptRollupCard
            loading={loading}
            byDepartment={byDepartment}
            rows={rows}
            totalCurrent={totalCurrent}
            totalProjected={totalProjected}
            totalDelta={totalDelta}
            pctChange={pctChange}
          />
        ) : viewBy === 'category' ? (
          <CatRollupCard
            loading={loading}
            byCategory={byCategory}
            rows={rows}
            totalCurrent={totalCurrent}
            totalProjected={totalProjected}
            totalDelta={totalDelta}
            pctChange={pctChange}
          />
        ) : (
        <div className="card">
          {loading ? (
            <div className="loading" style={{ minHeight: 520 }}>Building forecast…</div>
          ) : rows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-title">No active contracts</div>
              <div className="empty-state-sub">Add contracts to generate a budget forecast.</div>
            </div>
          ) : (
            <>
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="budget-forecast-table" style={{ minWidth: 980 }}>
                <thead>
                  <tr>
                    {canEdit && (
                      <th scope="col" style={{ width: 28, textAlign: 'center' }}>
                        <RowCheckbox
                          checked={allFilteredSelected}
                          indeterminate={filteredSelectedCount > 0 && !allFilteredSelected}
                          onChange={toggleSelectAll}
                          label="Select all filtered rows"
                        />
                      </th>
                    )}
                    <th scope="col" scope="col">Vendor</th>
                    <th scope="col" scope="col">Product</th>
                    <th scope="col" scope="col">Dept</th>
                    <th scope="col" scope="col">Owner</th>
                    <th scope="col" scope="col">Renewal</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Current Qty</th>
                    <th scope="col" style={{ textAlign: 'right', color: 'var(--color-primary)' }}>Needed Qty ✎</th>
                    <th scope="col" style={{ textAlign: 'right', color: 'var(--color-primary)' }}>Uplift % ✎</th>
                    <th scope="col" style={{ textAlign: 'center' }}></th>
                    <th scope="col" style={{ textAlign: 'right' }}>Current Unit $</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Proj. Unit $</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Current Total</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Projected Total</th>
                    <th scope="col" style={{ textAlign: 'right' }}>Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r) => (
                    <tr
                      key={r.id}
                      style={{ background: selected.has(r.id) ? 'var(--color-primary-light)' : undefined }}
                    >
                      {canEdit && (
                        <td style={{ textAlign: 'center' }}>
                          <RowCheckbox
                            checked={selected.has(r.id)}
                            onChange={() => toggleSelected(r.id)}
                            label={`Select ${r.vendorName} - ${r.product}`}
                          />
                        </td>
                      )}
                      <td style={{ fontWeight: 600 }}>{r.vendorName}</td>
                      <td>{r.product}</td>
                      <td className="td-muted">{r.department || '—'}</td>
                      <td className="td-muted">{r.internalOwner || '—'}</td>
                      <td className="td-muted">{fmtDate(r.endDate)}</td>

                      {/* Current qty — read only */}
                      <td style={{ textAlign: 'right' }}>{r.currentQty ?? '—'}</td>

                      {/* Needed qty — editable. updateRow handles dirty tracking. */}
                      <td style={{ textAlign: 'right' }}>
                        <input
                          type="number"
                          aria-label={`Needed Qty for ${r.vendorName} - ${r.product}`}
                          min="0"
                          value={r.neededQty ?? ''}
                          onChange={(e) => updateRow(r.id, 'neededQty', e.target.value)}
                          disabled={!canEdit}
                          style={{
                            width: 70, textAlign: 'right', padding: '3px 6px',
                            border: '1px solid var(--color-primary)', borderRadius: 4,
                            fontSize: 'var(--font-size-ui)', color: 'var(--color-primary)', fontWeight: 600,
                            background: 'var(--color-primary-light)',
                          }}
                        />
                      </td>

                      {/* Uplift % — editable. Vendor-level field: editing here
                          propagates to all rows for the same vendor (handled
                          inside updateRow). */}
                      <td style={{ textAlign: 'right' }}>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          <input
                            type="number"
                            aria-label={`Uplift % for ${r.vendorName} - ${r.product}`}
                            min="0"
                            max="100"
                            step="0.5"
                            value={r.upliftPct ?? ''}
                            onChange={(e) => updateRow(r.id, 'upliftPct', e.target.value)}
                            disabled={!canEdit}
                            style={{
                              width: 55, textAlign: 'right', padding: '3px 6px',
                              border: '1px solid var(--color-primary)', borderRadius: 4,
                              fontSize: 'var(--font-size-ui)', color: 'var(--color-primary)', fontWeight: 600,
                              background: 'var(--color-primary-light)',
                            }}
                          />
                          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>%</span>
                        </div>
                      </td>

                      {/* Merged per-row Save */}
                      <td style={{ textAlign: 'center' }}>
                        {canEdit && (
                          r.rowDirty ? (
                            <button
                              onClick={() => saveRow(r)}
                              title="Save Needed Qty and Uplift % for this row"
                              style={{
                                fontSize: 'var(--font-size-xs)', padding: '3px 8px', cursor: 'pointer',
                                border: '1px solid var(--color-primary)',
                                borderRadius: 4, background: 'var(--color-primary)',
                                color: 'var(--color-surface)', fontWeight: 600, whiteSpace: 'nowrap',
                              }}
                            >
                              Save
                            </button>
                          ) : (
                            <span title="Saved" style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-success)' }}>✓</span>
                          )
                        )}
                      </td>

                      {/* Calculated columns */}
                      <td style={{ textAlign: 'right' }}>{fmtMoney(r.currentUnitPrice)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtMoney(r.projectedUnitPrice)}</td>
                      <td style={{ textAlign: 'right' }}>{fmtMoney(r.currentTotal)}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{fmtMoney(r.projectedTotal)}</td>
                      <td style={{
                        textAlign: 'right', fontWeight: 600,
                        color: r.delta > 0 ? 'var(--color-danger)' : r.delta < 0 ? 'var(--color-success)' : undefined,
                      }}>
                        {r.delta != null ? (r.delta >= 0 ? '+' : '') + fmtMoney(r.delta) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>

                {/* Totals footer */}
                <tfoot>
                  <tr style={{ background: 'var(--color-primary-light)', borderTop: '2px solid var(--color-primary)' }}>
                    <td colSpan={canEdit ? 12 : 11} style={{ fontWeight: 700, padding: '10px 14px' }}>
                      Total{filteredRows.length !== rows.length ? ` · all ${rows.length} contracts (filter narrows table only)` : ''}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 700, padding: '10px 14px' }}>{fmtMoney(totalCurrent)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700, padding: '10px 14px', color: 'var(--color-primary)' }}>{fmtMoney(totalProjected)}</td>
                    <td style={{
                      textAlign: 'right', fontWeight: 700, padding: '10px 14px',
                      color: totalDelta > 0 ? 'var(--color-danger)' : 'var(--color-success)',
                    }}>
                      {totalDelta >= 0 ? '+' : ''}{fmtMoney(totalDelta)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {pageCount > 1 && (
              <div className="pagination">
                <div className="pagination-info">
                  Showing {(page - 1) * PAGE_SIZE + 1}-{Math.min(page * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}
                </div>
                <div className="pagination-controls">
                  <button type="button" className="page-btn" onClick={() => setPage((pn) => Math.max(1, pn - 1))} disabled={page <= 1}>Prev</button>
                  <span className="pagination-info" style={{ padding: '0 8px' }}>Page {page} of {pageCount}</span>
                  <button type="button" className="page-btn" onClick={() => setPage((pn) => Math.min(pageCount, pn + 1))} disabled={page >= pageCount}>Next</button>
                </div>
              </div>
            )}
            </>
          )}
        </div>
        )}

        <p style={{ marginTop: 10, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
          Default uplift is 10% YoY. Update per-vendor rates to reflect known price escalation clauses or historical increases. Use the per-row <strong>Save</strong> button for one row at a time, or check several rows and use the bulk-apply toolbar plus <strong>Save All</strong>. Saved values reload automatically next session.
        </p>

        {/* Sticky Save All bar — appears when any row has unsaved edits.
            Stays anchored to the viewport bottom so users always see how many
            edits are pending and how to save them. */}
        {viewBy === 'contract' && canEdit && dirtyCount > 0 && (
          <div style={{
            position: 'sticky', bottom: 0, marginTop: 14,
            display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
            padding: '12px 18px',
            background: 'var(--color-surface)',
            border: '1px solid var(--color-primary)',
            borderRadius: 'var(--radius)',
            boxShadow: '0 -4px 12px rgba(15, 23, 42, 0.08)',
            zIndex: 10,
          }}>
            <strong style={{ fontSize: 'var(--font-size-data)' }}>
              {dirtyCount} row{dirtyCount === 1 ? '' : 's'} with unsaved changes
            </strong>
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
              Save persists Needed Qty per contract and Uplift % per vendor.
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={discardAllChanges}
                disabled={savingAll}
                style={{
                  fontSize: 'var(--font-size-ui)', padding: '6px 14px', cursor: savingAll ? 'not-allowed' : 'pointer',
                  background: 'none', color: 'var(--color-text)',
                  border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
                }}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={saveAllDirty}
                disabled={savingAll}
                className="btn btn-primary"
                style={{ fontSize: 'var(--font-size-ui)', padding: '6px 14px' }}
              >
                {savingAll ? 'Saving…' : `Save All (${dirtyCount})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
