// ─────────────────────────────────────────────────────────────────────────────
// NewsPage.jsx — Industry & Regulatory News feed.
//
// GET /api/news?category=&search=&page= → data { items, pagination? } where
// each item is { id, title, url, source, category, summary, matchedTerm,
// publishedAt }. Categories: regulatory | standards | safety | industry.
//
// The feed is populated by a server-side scanner that runs every 6 hours
// against the OSHA newsroom + electrical trade press, keyword-filtered to
// maintenance-compliance topics. Manager+ can force an immediate pass via
// POST /api/news/refresh (returns counts, surfaced in a toast).
//
// Parallel build note: the news routes are landing in a sibling branch —
// every response read here is defensive (`?.` + fallbacks) so this page
// renders an explanatory empty state rather than crashing if the endpoint
// shape drifts or isn't mounted yet.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Newspaper, RefreshCw, ExternalLink } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import EmptyState from '../components/EmptyState';
import Toast from '../components/Toast';
import { fmtDate } from '../lib/equipment';

// Literal hexes (house convention for domain chips — match CONDITION_META /
// SEVERITY_META palette so categories read identically in light + dark mode).
const CATEGORY_META = {
  regulatory: { label: 'Regulatory', color: '#dc2626', bg: '#fef2f2' },
  standards:  { label: 'Standards',  color: '#2563eb', bg: '#eff6ff' },
  safety:     { label: 'Safety',     color: '#d97706', bg: '#fffbeb' },
  industry:   { label: 'Industry',   color: '#64748b', bg: '#f1f5f9' },
};

function CategoryChip({ category }) {
  const meta = CATEGORY_META[category] || { label: category || '—', color: '#64748b', bg: '#f1f5f9' };
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.03em',
      background: meta.bg, color: meta.color, border: `1px solid ${meta.color}`,
      whiteSpace: 'nowrap', flexShrink: 0,
    }}>
      {meta.label}
    </span>
  );
}

// Filter chips: All + the four categories, rendered as toggle pills.
function CategoryFilterChips({ value, onChange }) {
  const options = [{ key: '', label: 'All' }, ...Object.entries(CATEGORY_META).map(([key, m]) => ({ key, label: m.label, meta: m }))];
  return (
    <div role="group" aria-label="Filter by category" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(opt => {
        const active = value === opt.key;
        const color = opt.meta?.color || 'var(--color-text-secondary)';
        return (
          <button
            key={opt.key || 'all'}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.key)}
            style={{
              padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
              fontSize: 'var(--font-size-xs)', fontWeight: 700,
              background: active ? (opt.meta?.bg || 'var(--color-primary-light, #eef6f6)') : 'var(--color-surface)',
              color: active ? (opt.meta?.color || 'var(--color-primary)') : 'var(--color-text-secondary)',
              border: `1px solid ${active ? color : 'var(--color-border-strong)'}`,
              whiteSpace: 'nowrap',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// Turn the refresh-counts payload into a human line without assuming exact
// keys (parallel build — the server decides the count names).
function describeCounts(counts) {
  if (!counts || typeof counts !== 'object') return 'Feed refreshed.';
  const parts = Object.entries(counts)
    .filter(([, v]) => typeof v === 'number')
    .map(([k, v]) => `${v} ${k.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
  return parts.length ? parts.join(' · ') : 'Feed refreshed.';
}

export default function NewsPage() {
  useDocumentTitle('Industry & Regulatory News');
  const { user } = useAuth();
  const canRefresh = user?.role === 'admin' || user?.role === 'manager';

  const [items, setItems]           = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage]             = useState(1);
  const [category, setCategory]     = useState('');
  const [search, setSearch]         = useState('');
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError]           = useState('');
  const [toast, setToast]           = useState(null);
  const [reloadKey, setReloadKey]   = useState(0);

  // Debounce search so we don't hit /api/news per keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  // Filter changes reset to page 1.
  useEffect(() => { setPage(1); }, [category, debouncedSearch]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams();
    if (category)        params.set('category', category);
    if (debouncedSearch) params.set('search', debouncedSearch);
    params.set('page', String(page));
    api.get(`/api/news?${params}`)
      .then(r => {
        if (cancelled) return;
        const d = r.data?.data || {};
        setItems(Array.isArray(d.items) ? d.items : []);
        setPagination(d.pagination || null);
        setError('');
      })
      .catch(err => {
        if (cancelled) return;
        setItems([]);
        setPagination(null);
        setError(err.response?.data?.error || 'Failed to load the news feed.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [category, debouncedSearch, page, reloadKey]);

  async function handleRefresh() {
    if (refreshing) return;
    setRefreshing(true);
    setToast({ title: 'Refreshing feed…', message: 'Scanning sources for new matching articles.', variant: 'info', duration: 6000 });
    try {
      const r = await api.post('/api/news/refresh');
      setToast({ title: 'Feed refreshed', message: describeCounts(r.data?.data), variant: 'success', duration: 6000 });
      setPage(1);
      setReloadKey(k => k + 1);
    } catch (err) {
      if (!err.demoBlocked) {
        setToast({ title: 'Refresh failed', message: err.response?.data?.error || err.message || 'Could not refresh the feed.', variant: 'error' });
      }
    } finally {
      setRefreshing(false);
    }
  }

  const hasFilters = !!(category || debouncedSearch);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Industry &amp; Regulatory News</h1>
          <div className="page-subtitle">
            Drawn from the OSHA newsroom and electrical trade press, filtered to maintenance-compliance
            topics — standards revisions, enforcement actions, and equipment safety notices.
          </div>
        </div>
        {canRefresh && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Run the news scanner now instead of waiting for the next 6-hour pass"
          >
            <RefreshCw size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            {refreshing ? 'Refreshing…' : 'Refresh feed'}
          </button>
        )}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div className="filters-bar" style={{ marginBottom: 16 }}>
          <input
            type="search"
            className="search-input"
            placeholder="Search title, source, summary…"
            aria-label="Search news"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <CategoryFilterChips value={category} onChange={setCategory} />
        </div>

        <div className="card">
          {loading ? (
            <div className="loading">Loading news…</div>
          ) : items.length === 0 ? (
            <EmptyState
              icon={Newspaper}
              title={hasFilters ? 'No articles match these filters' : 'No articles yet'}
              sub={hasFilters
                ? 'Try a different category or search term.'
                : 'The scanner checks the OSHA newsroom and trade press every 6 hours and keeps only maintenance-compliance stories — the feed fills in as matches land.'}
              ctaLabel={!hasFilters && canRefresh ? (refreshing ? 'Refreshing…' : 'Refresh feed now') : undefined}
              ctaOnClick={!hasFilters && canRefresh ? handleRefresh : undefined}
            />
          ) : (
            <div>
              {items.map((item, i) => (
                <div
                  key={item.id || `${item.url}-${i}`}
                  style={{
                    padding: '14px 16px',
                    borderBottom: i < items.length - 1 ? '1px solid var(--color-border)' : 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
                    <CategoryChip category={item.category} />
                    <div style={{ flex: 1, minWidth: 240 }}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                        {item.url ? (
                          <a
                            href={item.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', color: 'var(--color-text)', textDecoration: 'none' }}
                            onMouseEnter={e => { e.currentTarget.style.textDecoration = 'underline'; }}
                            onMouseLeave={e => { e.currentTarget.style.textDecoration = 'none'; }}
                          >
                            {item.title || 'Untitled'}
                            <ExternalLink size={12} strokeWidth={1.75} style={{ marginLeft: 5, verticalAlign: '-1px', color: 'var(--color-text-secondary)' }} />
                          </a>
                        ) : (
                          <span style={{ fontWeight: 600, fontSize: 'var(--font-size-data)' }}>{item.title || 'Untitled'}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                        {[item.source, item.publishedAt ? fmtDate(item.publishedAt) : null].filter(Boolean).join(' · ') || '—'}
                      </div>
                      {item.summary && (
                        <p style={{
                          margin: '6px 0 0',
                          fontSize: 'var(--font-size-sm)',
                          color: 'var(--color-text-secondary)',
                          lineHeight: 1.5,
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}>
                          {item.summary}
                        </p>
                      )}
                      {item.matchedTerm && (
                        <span style={{
                          display: 'inline-block', marginTop: 6,
                          padding: '1px 7px', borderRadius: 4,
                          fontSize: 10, fontWeight: 600, letterSpacing: '0.03em',
                          /* A2 (2026-06-11): route through the semantic chip
                             tokens — the old --color-bg-subtle fallback painted
                             light-grey-on-white in dark mode. */
                          background: 'var(--chip-slate-bg, #f1f5f9)',
                          color: 'var(--chip-slate-fg, #334155)',
                          border: '1px solid var(--color-border)',
                        }}>
                          matched: {item.matchedTerm}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {pagination && pagination.pages > 1 && (
                <div className="pagination">
                  <div className="pagination-info">
                    Page {pagination.page || page} of {pagination.pages}
                    {typeof pagination.total === 'number' ? ` · ${pagination.total} articles` : ''}
                  </div>
                  <div className="pagination-controls">
                    <button
                      type="button"
                      className="page-btn"
                      disabled={page <= 1}
                      onClick={() => setPage(p => Math.max(1, p - 1))}
                    >
                      ‹ Prev
                    </button>
                    <button
                      type="button"
                      className="page-btn"
                      disabled={page >= pagination.pages}
                      onClick={() => setPage(p => Math.min(pagination.pages, p + 1))}
                    >
                      Next ›
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
