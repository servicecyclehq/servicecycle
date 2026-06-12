// ─────────────────────────────────────────────────────────────────────────────
// OutagePlannerPage.jsx — Date-first Outage Plan Generator (gem N1 / §J).
//
// "My outage is July 18 — what should we do that day?"  Pick a date + a
// de-energization scope, and the planner builds the work list from the union
// of three rules (due-by-date, carry-over, opportunistic-while-de-energized),
// grouped Location -> Panel/Equipment -> Device, each task tagged with WHY it's
// included. Export the field check-off (PDF/Excel) or create the blackout
// window + work orders in one click.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Bolt, ChevronDown, ChevronRight, Download, Sliders } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { fmtDate } from '../lib/equipment';
import Toast from '../components/Toast';

const REASON_META = {
  overdue:        { bg: '#fff1f1', color: '#b91c1c', label: 'Overdue' },
  'carry-over':   { bg: '#fffbeb', color: '#92400e', label: 'Carry-over' },
  due:            { bg: '#eff6ff', color: '#1d4ed8', label: 'Due' },
  opportunistic:  { bg: '#f0fdf4', color: '#15803d', label: 'While de-energized' },
};

function ReasonPill({ reason }) {
  const m = REASON_META[reason] || REASON_META.opportunistic;
  return (
    <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 10,
      background: m.bg, color: m.color, whiteSpace: 'nowrap' }}>{m.label}</span>
  );
}

function plusDays(n) {
  const d = new Date(Date.now() + n * 86400000);
  return d.toISOString().slice(0, 10);
}

// ── Device row (with include checkbox) ─────────────────────────────────────────
function DeviceBlock({ device, checked, onToggle }) {
  return (
    <div style={{ padding: '8px 0', borderTop: '1px solid var(--color-border)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
        <input type="checkbox" checked={checked} onChange={() => onToggle(device.assetId)} />
        <span style={{ fontWeight: 600, fontSize: 'var(--font-size-data)' }}>{device.assetName}</span>
        <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: 'var(--color-bg-subtle, #f1f5f9)', color: 'var(--color-text-secondary)' }}>
          {device.condition}
        </span>
        {device.criticalityScore >= 4 && (
          <span title="High criticality" style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#fff1f1', color: '#b91c1c' }}>
            Crit {device.criticalityScore}
          </span>
        )}
        {device.hasOpenWO && (
          <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 4, background: '#eff6ff', color: '#1d4ed8' }}>WO open</span>
        )}
      </label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4, paddingLeft: 24 }}>
        {device.tasks.map((t, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 'var(--font-size-sm)' }}>
            <ReasonPill reason={t.reason} />
            <span style={{ flex: 1, minWidth: 140 }}>{t.taskName}</span>
            <span style={{ color: 'var(--color-text-secondary)', whiteSpace: 'nowrap' }}>{t.dueDate ? fmtDate(t.dueDate) : '—'}</span>
            {t.standardRef && <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{t.standardRef}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Location (site) section ────────────────────────────────────────────────────
function LocationSection({ loc, selected, onToggleDevice }) {
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="card mb-16" style={{ overflow: 'hidden' }}>
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
        onClick={() => setExpanded(e => !e)}>
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <div style={{ flex: 1 }}>
          <div className="card-title">{loc.siteName}</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
            {loc.totalDevices} device{loc.totalDevices !== 1 ? 's' : ''} · {loc.totalTasks} task{loc.totalTasks !== 1 ? 's' : ''}
          </div>
        </div>
      </div>
      {expanded && (
        <div className="card-body">
          {loc.equipment.map(eq => (
            <div key={eq.equipmentId} style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)',
                display: 'flex', alignItems: 'center', gap: 6 }}>
                {eq.isFeeder ? <Bolt size={13} /> : null}
                {eq.equipmentName}
                {!eq.isFeeder && <span style={{ fontWeight: 400, fontSize: 11 }}>(standalone)</span>}
              </div>
              {eq.devices.map(d => (
                <DeviceBlock key={d.assetId} device={d} checked={selected.has(d.assetId)} onToggle={onToggleDevice} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function OutagePlannerPage() {
  useDocumentTitle('Outage Planner');
  const { role } = useAuth();
  const canWrite = ['admin', 'manager'].includes(role);

  // controls
  const [date, setDate]   = useState(plusDays(90));
  const [scope, setScope] = useState('facility');
  const [sites, setSites] = useState([]);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [rules, setRules] = useState({ dueByDate: true, carryOver: true, opportunistic: true });
  const [filters, setFilters] = useState({ minCondition: '', minCriticality: '', standard: '' });

  // data
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [selected, setSelected] = useState(new Set());
  const [committing, setCommitting] = useState(false);
  const [toast, setToast]     = useState(null);

  useEffect(() => { api.get('/api/sites').then(r => setSites(r.data?.data?.sites || [])).catch(() => {}); }, []);

  const queryString = useMemo(() => {
    const p = new URLSearchParams();
    if (date) p.set('date', date);
    p.set('scope', scope);
    p.set('dueByDate', rules.dueByDate ? '1' : '0');
    p.set('carryOver', rules.carryOver ? '1' : '0');
    p.set('opportunistic', rules.opportunistic ? '1' : '0');
    if (filters.minCondition)   p.set('minCondition', filters.minCondition);
    if (filters.minCriticality) p.set('minCriticality', filters.minCriticality);
    if (filters.standard)       p.set('standard', filters.standard);
    return p.toString();
  }, [date, scope, rules, filters]);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get(`/api/outage-planner/plan?${queryString}`);
      setData(res.data.data);
      // default: everything selected
      const ids = new Set();
      for (const loc of res.data.data.locations)
        for (const eq of loc.equipment)
          for (const d of eq.devices) ids.add(d.assetId);
      setSelected(ids);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to build outage plan');
    } finally { setLoading(false); }
  }, [queryString]);

  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  function toggleDevice(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function downloadExport(fmt) {
    try {
      const res = await api.get(`/api/outage-planner/plan/export.${fmt}?${queryString}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `outage-plan-${date || 'window'}.${fmt}`;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setToast({ message: 'Export failed', type: 'error' });
    }
  }

  async function commit() {
    if (!date) { setToast({ message: 'Pick an outage date first', type: 'error' }); return; }
    // build selections from the currently-selected devices
    const selections = [];
    for (const loc of data.locations)
      for (const eq of loc.equipment)
        for (const d of eq.devices)
          if (selected.has(d.assetId))
            selections.push({ assetId: d.assetId, scheduleIds: d.tasks.map(t => t.scheduleId) });
    if (!selections.length) { setToast({ message: 'Select at least one device', type: 'error' }); return; }
    setCommitting(true);
    try {
      const res = await api.post('/api/outage-planner/commit', { date, createBlackout: true, selections });
      const { blackoutCount, workOrderCount } = res.data.data;
      setToast({ message: `Created ${workOrderCount} work order${workOrderCount !== 1 ? 's' : ''} + ${blackoutCount} blackout window${blackoutCount !== 1 ? 's' : ''}`, type: 'success' });
      load();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Failed to create plan', type: 'error' });
    } finally { setCommitting(false); }
  }

  const s = data?.summary;

  return (
    <div className="page-container">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Bolt size={22} strokeWidth={1.75} /> Outage Planner
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 0', maxWidth: 760, lineHeight: 1.6 }}>
          Tell the planner your outage date and what you&rsquo;re de-energizing. It pulls everything coming
          due by then, everything deferred since your last outage, and&mdash;since the gear is already
          dark&mdash;every device in scope, so you do the work once instead of buying another shutdown later.
        </p>
      </div>

      {/* Controls */}
      <div className="card mb-16">
        <div className="card-body" style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>Outage date</label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} style={{ width: 170 }} />
          </div>
          <div>
            <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, display: 'block', marginBottom: 4 }}>De-energization scope</label>
            <select className="input" value={scope} onChange={e => setScope(e.target.value)} style={{ width: 240 }}>
              <option value="facility">Whole facility</option>
              {sites.map(site => <option key={site.id} value={`site:${site.id}`}>{site.name}</option>)}
            </select>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowAdvanced(a => !a)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sliders size={14} /> Advanced
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn btn-secondary btn-sm" onClick={() => downloadExport('pdf')} disabled={!data} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} /> PDF
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => downloadExport('xlsx')} disabled={!data} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download size={14} /> Excel
          </button>
        </div>

        {showAdvanced && (
          <div className="card-body" style={{ borderTop: '1px solid var(--color-border)', display: 'flex', flexWrap: 'wrap', gap: 20 }}>
            <div>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, marginBottom: 6 }}>Include rules</div>
              {[['dueByDate', 'Due by the outage date'], ['carryOver', 'Carry-over from last outage'], ['opportunistic', 'Everything de-energized (recommended)']].map(([k, lbl]) => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 'var(--font-size-sm)', marginBottom: 4 }}>
                  <input type="checkbox" checked={rules[k]} onChange={() => setRules(r => ({ ...r, [k]: !r[k] }))} /> {lbl}
                </label>
              ))}
            </div>
            <div>
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, marginBottom: 6 }}>Filters (narrow the opportunistic set)</div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div>
                  <label style={{ fontSize: 11, display: 'block' }}>Min condition</label>
                  <select className="input" value={filters.minCondition} onChange={e => setFilters(f => ({ ...f, minCondition: e.target.value }))} style={{ width: 110 }}>
                    <option value="">Any</option><option value="C2">C2+</option><option value="C3">C3 only</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block' }}>Min criticality</label>
                  <input type="number" min="1" max="5" className="input" value={filters.minCriticality} onChange={e => setFilters(f => ({ ...f, minCriticality: e.target.value }))} style={{ width: 90 }} placeholder="1-5" />
                </div>
                <div>
                  <label style={{ fontSize: 11, display: 'block' }}>Standard</label>
                  <input type="text" className="input" value={filters.standard} onChange={e => setFilters(f => ({ ...f, standard: e.target.value }))} style={{ width: 130 }} placeholder="e.g. NFPA 70B" />
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Summary banner */}
      {s && !loading && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', padding: '12px 16px', marginBottom: 16, borderRadius: 8,
          background: 'var(--color-success-bg, #f0fdf4)', border: '1px solid var(--color-success-border, #bbf7d0)' }}>
          <span style={{ fontSize: 26 }}>⚡</span>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ fontWeight: 700, color: 'var(--color-text)' }}>
              {s.totalTasks} task{s.totalTasks !== 1 ? 's' : ''} on {s.totalDevices} device{s.totalDevices !== 1 ? 's' : ''} for {date ? new Date(date + 'T00:00:00').toLocaleDateString() : 'the next 90 days'}
            </div>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
              {s.overdueCount} overdue · {s.carryOverCount} carry-over · {s.dueCount} due · {s.opportunisticCount} while-de-energized
              {s.pulledForwardCount > 0 && <> · <strong>{s.pulledForwardCount} pulled forward</strong> (future shutdowns avoided)</>}
              {s.shutdownsAvoided > 0 && <> · saves {s.shutdownsAvoided} separate shutdown{s.shutdownsAvoided !== 1 ? 's' : ''}</>}
            </div>
          </div>
          {canWrite && (
            <button className="btn btn-primary btn-sm" onClick={commit} disabled={committing || selected.size === 0}>
              {committing ? 'Creating…' : `Create plan (${selected.size} device${selected.size !== 1 ? 's' : ''})`}
            </button>
          )}
        </div>
      )}

      {loading && <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-secondary)' }}>Building outage plan…</div>}
      {error && <div style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 16 }}>{error}</div>}

      {!loading && !error && data && data.locations.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-secondary)' }}>
          <Bolt size={40} strokeWidth={1} style={{ marginBottom: 12 }} />
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Nothing to do in this scope for that date</div>
          <div style={{ fontSize: 'var(--font-size-sm)' }}>Try a later date, a broader scope, or enable the &ldquo;everything de-energized&rdquo; rule under Advanced.</div>
        </div>
      )}

      {!loading && !error && data && data.locations.map(loc => (
        <LocationSection key={loc.siteId} loc={loc} selected={selected} onToggleDevice={toggleDevice} />
      ))}
    </div>
  );
}
