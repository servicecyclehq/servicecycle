import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import ColumnFilterDropdown from '../components/ColumnFilterDropdown';

// ── Category config ───────────────────────────────────────────────────────────

const CATEGORY_META = {
  security:    { label: 'Security',     bg: 'var(--color-danger-bg)', text: 'var(--color-danger)', border: 'var(--color-danger)',  icon: '🔒' },
  outage:      { label: 'Outage',       bg: 'var(--color-warning-bg)', text: 'var(--color-warning)', border: '#fed7aa',  icon: '⚠️' },
  acquisition: { label: 'Acquisition',  bg: 'var(--color-success-bg)', text: 'var(--color-success)', border: 'var(--color-success)',  icon: '🤝' },
  pricing:     { label: 'Pricing',      bg: 'var(--color-warning-bg)', text: 'var(--color-warning)', border: 'var(--color-warning)',  icon: '💰' },
  new_feature: { label: 'New Feature',  bg: 'var(--color-primary-light)', text: 'var(--color-primary)', border: 'var(--color-info)',  icon: '✨' },
  eol:         { label: 'End of Life',  bg: '#fdf4ff', text: '#9333ea', border: '#e9d5ff',  icon: '🔚' },
  legal:       { label: 'Legal',        bg: 'var(--color-renewal-bg)', text: 'var(--color-renewal-text)', border: 'var(--color-renewal-border)',  icon: '⚖️' },
  general:     { label: 'General',      bg: 'var(--color-surface)', text: 'var(--color-text-secondary)', border: 'var(--color-border)', icon: '📰' },
};

const ALL_CATEGORIES = Object.keys(CATEGORY_META);

function CategoryBadge({ category }) {
  const m = CATEGORY_META[category] || CATEGORY_META.general;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 12, fontSize: 'var(--font-size-xs)', fontWeight: 700,
      background: m.bg, color: m.text, border: `1px solid ${m.border}`,
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {m.icon} {m.label}
    </span>
  );
}

// Whitelist URL protocols. Without this guard, an upstream RSS feed
// emitting `javascript:alert(1)` would persist as VendorNews.url and
// then render as <a href="javascript:..."> here — a click would execute.
// The server-side scanner now also gates this before insert, but
// defense-in-depth keeps any DB-seeded bad row from firing in the SPA.
function safeHref(url) {
  if (typeof url !== 'string') return '#';
  return /^https?:\/\//i.test(url) ? url : '#';
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  const secs = Math.floor((Date.now() - d) / 1000);
  if (secs < 60)   return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  if (days < 7)   return `${days} days ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── News item row ─────────────────────────────────────────────────────────────

function NewsItem({ item, onRead }) {
  // Watch-term items have no vendor (vendorId is null)
  const isWatchItem = !item.vendor || !item.vendor.id;

  return (
    <div
      style={{
        display: 'flex', gap: 14, padding: '14px 20px',
        borderBottom: '1px solid var(--color-border)',
        background: item.isRead ? '' : 'rgba(var(--color-primary-rgb, 99, 102, 241), 0.03)',
        transition: 'background 0.1s',
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--color-surface)'}
      onMouseLeave={e => e.currentTarget.style.background = item.isRead ? '' : 'rgba(99,102,241,0.03)'}
    >
      {/* Unread dot */}
      <div style={{ paddingTop: 6, flexShrink: 0 }}>
        <div style={{
          width: 8, height: 8, borderRadius: '50%',
          background: item.isRead ? 'transparent' : 'var(--color-primary)',
          border: item.isRead ? '1px solid var(--color-border-strong)' : 'none',
        }} />
      </div>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <a
            href={safeHref(item.url)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => !item.isRead && onRead(item.id)}
            style={{ fontSize: 'var(--font-size-data)', fontWeight: item.isRead ? 400 : 600, color: 'var(--color-text)', textDecoration: 'none', flex: 1, minWidth: 0 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--color-primary)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--color-text)'}
          >
            {item.title}
          </a>
          <CategoryBadge category={item.category} />
        </div>

        {item.summary && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 6, lineHeight: 1.5 }}>
            {item.summary}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          {isWatchItem ? (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '1px 7px', borderRadius: 10, fontSize: 'var(--font-size-xs)', fontWeight: 600,
              background: 'var(--color-surface)', border: '1px solid var(--color-border)',
              color: 'var(--color-text-secondary)',
            }}>
              👁 {item.watchTerm}
            </span>
          ) : (
            <Link
              to={`/vendors/${item.vendor.id}`}
              style={{ fontWeight: 600, color: 'var(--color-text-secondary)', textDecoration: 'none' }}
              onMouseEnter={e => e.currentTarget.style.color = 'var(--color-primary)'}
              onMouseLeave={e => e.currentTarget.style.color = 'var(--color-text-secondary)'}
            >
              {item.vendor.name}
            </Link>
          )}
          <span>·</span>
          <span>{item.source}</span>
          <span>·</span>
          <span title={new Date(item.publishedAt).toLocaleString()}>{timeAgo(item.publishedAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ── Watch Terms Panel ─────────────────────────────────────────────────────────

function WatchTermsPanel() {
  const [watches, setWatches]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [newTerm, setNewTerm]     = useState('');
  const [adding, setAdding]       = useState(false);
  const [error, setError]         = useState('');
  const [expanded, setExpanded]   = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    api.get('/api/news/watches')
      .then(r => setWatches(r.data.data.watches))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function addTerm(e) {
    e.preventDefault();
    const term = newTerm.trim();
    if (!term) return;
    setAdding(true);
    setError('');
    try {
      const r = await api.post('/api/news/watches', { term });
      setWatches(prev => [...prev, r.data.data.watch]);
      setNewTerm('');
      inputRef.current?.focus();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add term');
    } finally {
      setAdding(false);
    }
  }

  async function removeTerm(id) {
    try {
      await api.delete(`/api/news/watches/${id}`);
      setWatches(prev => prev.filter(w => w.id !== id));
    } catch {
      // silently ignore
    }
  }

  return (
    <div style={{
      border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
      background: 'var(--color-surface)', marginBottom: 16, overflow: 'hidden',
    }}>
      {/* Header */}
      <button
        onClick={() => setExpanded(e => !e)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--color-text)', fontSize: 'var(--font-size-ui)', fontWeight: 600,
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          👁 My Watch List
          {watches.length > 0 && (
            <span style={{
              fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '1px 7px', borderRadius: 10,
              background: 'var(--color-border)', color: 'var(--color-text-secondary)',
            }}>
              {watches.length}
            </span>
          )}
        </span>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', userSelect: 'none' }}>
          {expanded ? '▲ Hide' : '▼ Manage'}
        </span>
      </button>

      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid var(--color-border)' }}>
          <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', margin: '12px 0 12px' }}>
            Add any vendor, product, or topic you want to track — the scanner picks these up on every run.
          </p>

          {/* Add form */}
          <form onSubmit={addTerm} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
            <input
              ref={inputRef}
              value={newTerm}
              onChange={e => setNewTerm(e.target.value)}
              placeholder="e.g. Nutanix, HashiCorp, AI licensing…"
              maxLength={100}
              style={{
                flex: 1, padding: '7px 12px', fontSize: 'var(--font-size-ui)',
                border: '1px solid var(--color-border)', borderRadius: 'var(--radius)',
                background: 'var(--color-bg)', color: 'var(--color-text)',
                outline: 'none',
              }}
              onFocus={e => e.target.style.borderColor = 'var(--color-primary)'}
              onBlur={e => e.target.style.borderColor = 'var(--color-border)'}
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={adding || !newTerm.trim()}
            >
              {adding ? '…' : '+ Add'}
            </button>
          </form>

          {error && (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)', marginBottom: 8 }}>{error}</div>
          )}

          {/* Term chips */}
          {loading ? (
            <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading…</div>
          ) : watches.length === 0 ? (
            <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
              No watch terms yet. Add one above to start tracking custom topics.
            </div>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {watches.map(w => (
                <span key={w.id} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '4px 10px', borderRadius: 16, fontSize: 'var(--font-size-sm)', fontWeight: 500,
                  background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                  color: 'var(--color-text)',
                }}>
                  {w.term}
                  <button
                    onClick={() => removeTerm(w.id)}
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--color-text-secondary)', padding: 0, fontSize: 'var(--font-size-ui)',
                      lineHeight: 1, display: 'flex', alignItems: 'center',
                    }}
                    title={`Remove "${w.term}"`}
                    onMouseEnter={e => e.currentTarget.style.color = '#b91c1c'}
                    onMouseLeave={e => e.currentTarget.style.color = 'var(--color-text-secondary)'}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 10 }}>
            Up to 20 terms · Results appear after the next scanner run
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

// === Multi-region selector (v0.89.6) =========================================
// Shared inline between NewsPage Outages tab and (planned) SettingsPage.
// Value shape: a comma-separated string. "global" (or empty) = no filter.
// Otherwise a sorted list of tokens from {us, eu, apac}. Selecting Global
// clears the per-region checks; selecting any per-region check clears Global.
function OutageRegionCheckboxes({ value, onChange }) {
  const parsed = String(value || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const isGlobal = parsed.length === 0 || parsed.includes('global');
  const has = key => isGlobal ? false : parsed.includes(key);

  function toggle(key) {
    if (key === 'global') {
      onChange('global');
      return;
    }
    const next = new Set(parsed.filter(t => t !== 'global'));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (next.size === 0) {
      onChange('global');
      return;
    }
    onChange([...next].sort().join(','));
  }

  const opts = [
    { key: 'global', label: 'Global (show all regions)',         hint: 'No filter applied' },
    { key: 'us',     label: 'Americas (US, Canada, LATAM)',      hint: null },
    { key: 'eu',     label: 'EMEA (Europe + Middle East)',        hint: null },
    { key: 'apac',   label: 'APAC (Asia, Pacific)',              hint: null },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {opts.map(opt => {
        const checked = opt.key === 'global' ? isGlobal : has(opt.key);
        const dimmed  = isGlobal && opt.key !== 'global';
        return (
          <label
            key={opt.key}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              cursor: 'pointer',
              fontSize: 'var(--font-size-ui)',
              color: dimmed ? 'var(--color-text-secondary)' : 'var(--color-text)',
              opacity: dimmed ? 0.7 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={() => toggle(opt.key)}
              aria-label={opt.label}
            />
            <span>{opt.label}</span>
            {opt.hint && checked && (
              <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                {opt.hint}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}

export default function NewsPage() {
  useDocumentTitle('Vendor news');
  const { demoMode, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [items, setItems]             = useState([]);
  const [total, setTotal]             = useState(0);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading]         = useState(true);
  const [scanning, setScanning]       = useState(false);
  const [scanMsg, setScanMsg]         = useState('');
  const [error, setError]             = useState('');

  // v0.89.5: top-level view - Headlines (default, excludes outage category)
  // or Outages (outage-only, region-filtered via account.newsOutageRegion).
  // Each tab has its own unread badge sourced from /api/news/summary.
  const [view, setView]                       = useState('headlines');
  const [unreadHeadlines, setUnreadHeadlines] = useState(0);
  const [unreadOutages, setUnreadOutages]     = useState(0);
  const [outageRegion, setOutageRegion]       = useState('global'); // admin-only inline selector

  // v0.89.7: multi-select vendor filter (matches ContractsList toolbar UX).
  // Array of vendor NAMES; empty array = no filter.
  const [selectedVendorNames, setSelectedVendorNames] = useState([]);

  // Filters
  const [category, setCategory]     = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [offset, setOffset]         = useState(0);
  const LIMIT = 40;

  const fetchNews = useCallback(async (opts = {}) => {
    setLoading(true);
    setError('');
    try {
      const params = { limit: LIMIT, offset: opts.offset ?? offset, view };
      if (category)   params.category = category;
      if (unreadOnly) params.unread   = 'true';
      if (selectedVendorNames.length > 0) params.vendorNames = selectedVendorNames.join(',');
      const res = await api.get('/api/news', { params });
      const d = res.data.data;
      setItems(d.items);
      setTotal(d.total);
      setUnreadCount(d.unreadCount);
    } catch {
      setError('Failed to load news.');
    } finally {
      setLoading(false);
    }
  }, [category, unreadOnly, offset, view, selectedVendorNames]);

  // v0.89.5: pull split unread counts so each tab badge stays accurate.
  const fetchSummary = useCallback(async () => {
    try {
      const res = await api.get('/api/news/summary');
      const d = res.data.data || {};
      setUnreadHeadlines(d.unreadHeadlines || 0);
      setUnreadOutages(d.unreadOutages || 0);
      setOutageRegion(d.newsOutageRegion || 'global');
    } catch { /* non-fatal; tab badges just won't update this round */ }
  }, []);

  useEffect(() => { fetchNews(); }, [fetchNews]);
  useEffect(() => { fetchSummary(); }, [fetchSummary]);

  async function markRead(id) {
    await api.put(`/api/news/${id}/read`).catch(() => {});
    setItems(prev => prev.map(i => i.id === id ? { ...i, isRead: true } : i));
    setUnreadCount(c => Math.max(0, c - 1));
    // Optimistic per-tab decrement so the badge that the user just acted in
    // moves immediately; the /summary refetch reconciles any drift.
    if (view === 'headlines')    setUnreadHeadlines(c => Math.max(0, c - 1));
    else if (view === 'outages') setUnreadOutages(c => Math.max(0, c - 1));
    fetchSummary();
  }

  async function markAllRead() {
    await api.put('/api/news/read-all').catch(() => {});
    setItems(prev => prev.map(i => ({ ...i, isRead: true })));
    setUnreadCount(0);
    fetchSummary();
  }

  async function triggerScan() {
    setScanning(true);
    setScanMsg('');
    try {
      const res = await api.post('/api/news/scan');
      setScanMsg(res.data.message || 'Scanner started.');
      setTimeout(() => fetchNews({ offset: 0 }), 4000);
    } catch {
      setScanMsg('Failed to start scanner.');
    } finally {
      setScanning(false);
    }
  }

  function applyFilter(newCategory, newUnread) {
    setCategory(newCategory);
    setUnreadOnly(newUnread);
    setOffset(0);
  }

  // v0.89.5: switching tabs resets the category sub-filter (since the
  // category meanings differ across tabs) and the offset.
  function switchView(nextView) {
    if (nextView === view) return;
    setView(nextView);
    setCategory('');
    setUnreadOnly(false);
    setOffset(0);
  }

  // v0.89.14: wipe every active filter on this page in one shot. Matches
  // ContractsList.clearAllFilters() pattern. Does NOT touch outageRegion
  // (account-level admin preference, not a per-session filter).
  function clearAllFilters() {
    setView('headlines');
    setCategory('');
    setUnreadOnly(false);
    setSelectedVendorNames([]);
    setOffset(0);
  }

  const hasFilters = view !== 'headlines' || !!category || unreadOnly || selectedVendorNames.length > 0;

  // v0.89.14: when the user clicks the sidebar "Vendor News" link while
  // already on /news with filters applied, Sidebar pushes location.state.
  // clearFilters with a Date.now() token. Mirror /contracts behavior:
  // wipe filters and consume the state so the effect doesn't re-fire on
  // unrelated re-renders.
  useEffect(() => {
    if (location.state && location.state.clearFilters) {
      clearAllFilters();
      navigate('/news', { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state && location.state.clearFilters]);

  // v0.89.5: admin-only inline change to the account region preference.
  async function updateOutageRegion(nextRegion) {
    if (nextRegion === outageRegion) return;
    const prev = outageRegion;
    setOutageRegion(nextRegion);
    try {
      await api.put('/api/news/region', { region: nextRegion });
      fetchNews({ offset: 0 });
      fetchSummary();
    } catch {
      setOutageRegion(prev);
      setError('Failed to update region.');
    }
  }

  const totalPages  = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            Vendor News
            {unreadCount > 0 && (
              <span style={{
                marginLeft: 10, fontSize: 'var(--font-size-sm)', fontWeight: 700,
                background: 'var(--color-primary)', color: 'var(--color-surface)',
                borderRadius: 12, padding: '2px 8px', verticalAlign: 'middle',
              }}>
                {unreadCount} new
              </span>
            )}
          </h1>
          <div className="page-subtitle">
            AI-curated news matched to your vendor portfolio and personal watch list — updated every 6 hours
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {hasFilters && (
            <button
              className="btn btn-secondary btn-sm"
              onClick={clearAllFilters}
              title="Reset every active filter: tab, unread, category, vendor"
            >
              Clear filters
            </button>
          )}
          {unreadCount > 0 && (
            <button className="btn btn-secondary btn-sm" onClick={markAllRead}>
              Mark all read
            </button>
          )}
          <button
            className="btn btn-secondary btn-sm"
            onClick={triggerScan}
            disabled={scanning}
            title="Manually trigger the news scanner (admin only)"
          >
            {scanning ? 'Scanning…' : 'Scan now'}
          </button>
        </div>
      </div>

      {scanMsg && (
        <div style={{ margin: '0 0 16px', padding: '10px 20px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
          {scanMsg}
        </div>
      )}

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        {/* v0.89.3: demo-mode explanatory banner. Demo only sees news for the 12 seeded
            vendors; self-hosted operators can add their own vendors + watch terms. */}
        {demoMode && (
          <div
            role="note"
            style={{
              margin: '0 0 16px',
              padding: '10px 16px',
              background: 'var(--color-warning-bg, #fffbeb)',
              border: '1px solid var(--color-warning, #b45309)',
              borderRadius: 'var(--radius)',
              fontSize: 'var(--font-size-ui)',
              lineHeight: 1.5,
              color: 'var(--color-warning, #b45309)',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <span>
              <strong>Demo mode:</strong> news is matched to the 12 seeded demo vendors and your personal watch terms.
              In a self-hosted LapseIQ instance, the scanner picks up <em>your</em> vendors + watch terms across ~20 curated RSS feeds.
            </span>
          </div>
        )}
        {/* Personal watch list management */}
        <WatchTermsPanel />

        {/* v0.89.5: top-level tabs - Headlines (default) and Outages.
            Each shows its own unread badge from /api/news/summary. */}
        <div
          role="tablist"
          aria-label="News view"
          style={{
            display: 'flex',
            gap: 4,
            marginBottom: 12,
            borderBottom: '1px solid var(--color-border)',
          }}
        >
          {[
            { key: 'headlines', label: 'Headlines',  unread: unreadHeadlines },
            { key: 'outages',   label: 'Outages',    unread: unreadOutages   },
          ].map(tab => {
            const active = view === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={active}
                onClick={() => switchView(tab.key)}
                style={{
                  border: 'none',
                  borderBottom: active ? '2px solid var(--color-primary)' : '2px solid transparent',
                  background: 'transparent',
                  padding: '8px 16px',
                  cursor: 'pointer',
                  fontSize: 'var(--font-size-data)',
                  fontWeight: active ? 600 : 500,
                  color: active ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                  marginBottom: -1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  transition: 'color 0.1s, border-color 0.1s',
                }}
              >
                {tab.label}
                {tab.unread > 0 && (
                  <span style={{
                    fontSize: 'var(--font-size-xs)',
                    fontWeight: 700,
                    padding: '1px 7px',
                    borderRadius: 10,
                    background: active ? 'var(--color-primary)' : 'var(--color-border)',
                    color: active ? 'var(--color-surface)' : 'var(--color-text-secondary)',
                  }}>
                    {tab.unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* v0.89.6: admin-only multi-region selector for the Outages tab. */}
        {view === 'outages' && user && user.role === 'admin' && (
          <div style={{ marginBottom: 12, padding: '10px 14px', background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)' }}>
            <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, marginBottom: 8, color: 'var(--color-text)' }}>
              Filter outages by region
            </div>
            <OutageRegionCheckboxes value={outageRegion} onChange={updateOutageRegion} />
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 8, fontStyle: 'italic' }}>
              Outages with no detected region stay visible to everyone (fail-open).
            </div>
          </div>
        )}

        {/* Filter bar */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            className={`btn btn-sm ${!category && !unreadOnly ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => applyFilter('', false)}
          >
            All
          </button>
          <button
            className={`btn btn-sm ${unreadOnly ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => applyFilter('', !unreadOnly)}
          >
            Unread {unreadCount > 0 && `(${unreadCount})`}
          </button>
          <div style={{ width: 1, height: 20, background: 'var(--color-border)', margin: '0 4px' }} />
          {ALL_CATEGORIES.filter(c => {
            if (c === 'general') return false;
            if (view === 'headlines' && c === 'outage') return false; // already excluded by view
            if (view === 'outages'   && c !== 'outage') return false; // only outage relevant
            return true;
          }).map(cat => (
            <button
              key={cat}
              className={`btn btn-sm ${category === cat ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => applyFilter(category === cat ? '' : cat, unreadOnly)}
            >
              {CATEGORY_META[cat].icon} {CATEGORY_META[cat].label}
            </button>
          ))}

          {/* v0.89.7: vendor multi-select. Same Excel-style dropdown that
              ContractsList uses for its per-column Vendor filter. */}
          <div style={{ minWidth: 140, maxWidth: 220 }}>
            <ColumnFilterDropdown
              columnId="vendor"
              label="Vendor"
              emptyLabel="Vendors"
              value={selectedVendorNames}
              onChange={vals => { setSelectedVendorNames(vals); setOffset(0); }}
              fetchDistinct={async () => {
                const r = await api.get('/api/news/distinct/vendor');
                return Array.isArray(r.data && r.data.values) ? r.data.values : [];
              }}
            />
          </div>
        </div>

        {/* Results */}
        <div className="card">
          {loading && (
            <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)' }}>
              Loading news…
            </div>
          )}

          {!loading && items.length === 0 && (
            <div style={{ padding: '48px 24px', textAlign: 'center' }}>
              <div style={{ fontSize: 'var(--font-size-hero)', marginBottom: 12 }}>📰</div>
              <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No news yet</div>
              <div style={{ fontSize: 'var(--font-size-data)', color: 'var(--color-text-secondary)', marginBottom: 20 }}>
                {!category && !unreadOnly
                  ? 'The scanner runs every 6 hours. Click "Scan now" to fetch articles immediately.'
                  : 'No articles match the current filter.'}
              </div>
              {/* 2026-05-10 review M5: align with the header button so the
                  in-line prose ("Click 'Scan now'…") matches the actual
                  CTA wording. Previously said "Run scan now". */}
              <button className="btn btn-secondary btn-sm" onClick={triggerScan} disabled={scanning}>
                {scanning ? 'Scanning…' : 'Scan now'}
              </button>
            </div>
          )}

          {!loading && items.map(item => (
            <NewsItem key={item.id} item={item} onRead={markRead} />
          ))}
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginTop: 20, alignItems: 'center' }}>
            <button
              className="btn btn-secondary btn-sm"
              disabled={currentPage === 1}
              onClick={() => setOffset(o => Math.max(0, o - LIMIT))}
            >
              ← Previous
            </button>
            <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
              Page {currentPage} of {totalPages} ({total} articles)
            </span>
            <button
              className="btn btn-secondary btn-sm"
              disabled={currentPage === totalPages}
              onClick={() => setOffset(o => o + LIMIT)}
            >
              Next →
            </button>
          </div>
        )}
      </div>
    </>
  );
}
