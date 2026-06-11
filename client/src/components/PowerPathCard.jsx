// ─────────────────────────────────────────────────────────────────────────────
// PowerPathCard.jsx — upstream/downstream electrical feed path for one asset.
//
// Card taking { asset, canWrite, onChanged }. Reads
//   GET /api/assets/:id/power-path →
//     data { upstream:   [{id, equipmentType, manufacturer, model,
//                          serialNumber, inService, governingCondition}, …]
//                          (immediate parent FIRST → source LAST),
//            downstream: [{ …same, downstreamCount }],   // direct children
//            totalDownstream }
//
// Renders the upstream chain breadcrumb-style from source → … → parent →
// THIS asset, the direct downstream children with their own subtree counts,
// and a blast-radius summary line. Out-of-service assets in either direction
// render struck-through + muted.
//
// Edit (canWrite): "Set upstream feed" opens an inline picker — debounced
// search within the same site (GET /api/assets?search=&siteId=&limit=20,
// self excluded client-side) — and writes PUT /api/assets/:id
// { fedFromAssetId } (uuid or null for "Clear feed"). A 400 feed-loop
// rejection surfaces as a clear toast. Server contract built in parallel —
// everything is read defensively.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback, Fragment } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';
import Toast from './Toast';
import { EQUIPMENT_TYPE_LABELS, CONDITION_META, assetLabel } from '../lib/equipment';

function SectionHeading({ children, style }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: 'var(--color-text-secondary)',
      margin: '0 0 8px',
      ...(style || {}),
    }}>
      {children}
    </div>
  );
}

// Tiny C1/C2/C3 pill for chain nodes.
function CondDot({ cond }) {
  const meta = CONDITION_META[cond];
  if (!meta) return null;
  return (
    <span
      title={meta.label}
      style={{
        display: 'inline-block', padding: '0 6px', borderRadius: 999,
        fontSize: 10.5, fontWeight: 700, marginLeft: 5, verticalAlign: 'middle',
        background: meta.bg, color: meta.color, border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
      }}
    >
      {cond}
    </span>
  );
}

// One linked node in the path. Out-of-service → muted strike-through.
function NodeLink({ node }) {
  const out = node.inService === false;
  return (
    <span style={{ whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center' }}>
      <Link
        to={`/assets/${node.id}`}
        title={`${EQUIPMENT_TYPE_LABELS[node.equipmentType] || node.equipmentType || 'Asset'}${out ? ' — out of service' : ''}`}
        style={{
          fontWeight: 600,
          color: out ? 'var(--color-text-muted, var(--color-text-secondary))' : 'var(--color-primary)',
          textDecoration: out ? 'line-through' : 'none',
        }}
      >
        {assetLabel(node)}
      </Link>
      <CondDot cond={node.governingCondition} />
      {out && (
        <span style={{
          marginLeft: 5, fontSize: 10.5, fontWeight: 600,
          color: 'var(--color-text-muted, var(--color-text-secondary))',
          border: '1px solid var(--color-border)', borderRadius: 999, padding: '0 6px',
          whiteSpace: 'nowrap',
        }}>
          out of service
        </span>
      )}
    </span>
  );
}

export default function PowerPathCard({ asset, canWrite, onChanged }) {
  const [path, setPath]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [toast, setToast]     = useState(null);

  // Inline upstream-feed picker state.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery]           = useState('');
  const [results, setResults]       = useState([]);
  const [searching, setSearching]   = useState(false);
  const [saving, setSaving]         = useState(false);

  const assetId = asset?.id;
  const siteId  = asset?.siteId || asset?.site?.id;

  const fetchPath = useCallback(() => {
    if (!assetId) return Promise.resolve();
    return api.get(`/api/assets/${assetId}/power-path`)
      .then(r => { setPath(r.data?.data || null); setError(''); })
      .catch(() => { setError('Failed to load the power path.'); });
  }, [assetId]);

  // Refetch on mount and whenever the parent refetches the asset (the asset
  // object identity changes on every AssetDetail refetch, so an edit made
  // elsewhere on the page keeps this card current too).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchPath().finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [fetchPath, asset]);

  // Debounced asset search for the picker — same-site only, self excluded.
  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (query.trim()) params.set('search', query.trim());
      if (siteId) params.set('siteId', siteId);
      params.set('limit', '20');
      api.get(`/api/assets?${params.toString()}`)
        .then(r => {
          if (cancelled) return;
          setResults((r.data?.data?.assets || []).filter(a => a.id !== assetId));
        })
        .catch(() => { if (!cancelled) setResults([]); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
  }, [pickerOpen, query, siteId, assetId]);

  if (!assetId) return null;

  const upstream   = path?.upstream || [];
  const downstream = path?.downstream || [];
  const totalDownstream = path?.totalDownstream ?? downstream.length;
  // Server returns immediate parent first → source last; the breadcrumb
  // reads source-first, so reverse for display.
  const chain = [...upstream].reverse();
  const currentFeed = upstream[0] || asset.fedFrom || null;

  async function setFeed(fedFromAssetId) {
    if (saving) return;
    setSaving(true);
    try {
      await api.put(`/api/assets/${assetId}`, { fedFromAssetId });
      setToast({
        message: fedFromAssetId ? 'Upstream feed updated.' : 'Upstream feed cleared.',
        variant: 'success', duration: 4000,
      });
      setPickerOpen(false);
      setQuery('');
      fetchPath();
      onChanged?.();
    } catch (err) {
      const data = err.response?.data;
      const msg  = String(data?.error || data?.message || '');
      if (err.demoBlocked) {
        // global demo banner already showed
      } else if (err.response?.status === 400 && /loop/i.test(msg)) {
        setToast({
          message: 'Feed loop detected — that asset is downstream of this one, so it can’t also be the upstream feed.',
          variant: 'error',
        });
      } else {
        setToast({ message: msg || 'Failed to update the upstream feed.', variant: 'error' });
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card mb-16">
      <div
        className="card-header"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
      >
        <div className="card-title">Power Path</div>
        {canWrite && !loading && !error && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => { setPickerOpen(v => !v); setQuery(''); }}
              disabled={saving}
            >
              {pickerOpen ? 'Close picker' : 'Set upstream feed'}
            </button>
            {currentFeed && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setFeed(null)}
                disabled={saving}
                title="Remove the recorded upstream feed for this asset"
              >
                Clear feed
              </button>
            )}
          </div>
        )}
      </div>
      <div className="card-body">
        {loading ? (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            Loading power path…
          </div>
        ) : error ? (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
            {error}
          </div>
        ) : (
          <>
            {/* ── Upstream chain ─────────────────────────────────────────── */}
            <SectionHeading>Upstream (source path)</SectionHeading>
            {chain.length === 0 ? (
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No upstream recorded.
                {canWrite && ' Use "Set upstream feed" to record what feeds this asset.'}
              </div>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                fontSize: 'var(--font-size-ui)', lineHeight: 1.7,
              }}>
                <span style={{
                  fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em',
                  textTransform: 'uppercase', color: 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)', borderRadius: 999,
                  padding: '1px 8px', background: 'var(--color-bg)', whiteSpace: 'nowrap',
                }}>
                  Source
                </span>
                {chain.map(node => (
                  <Fragment key={node.id}>
                    <NodeLink node={node} />
                    <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)' }}>→</span>
                  </Fragment>
                ))}
                <span style={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {assetLabel(asset)}
                  <span style={{
                    marginLeft: 6, fontSize: 10.5, fontWeight: 600,
                    color: 'var(--color-text-secondary)',
                  }}>
                    (this asset)
                  </span>
                </span>
              </div>
            )}

            {/* ── Inline upstream picker ─────────────────────────────────── */}
            {canWrite && pickerOpen && (
              <div style={{
                marginTop: 10, padding: 12, borderRadius: 8,
                border: '1px solid var(--color-border)', background: 'var(--color-bg)',
              }}>
                <input
                  className="form-control form-control-wide"
                  placeholder="Search assets at this site by manufacturer, model, serial…"
                  aria-label="Search upstream feed candidates"
                  value={query}
                  onChange={e => setQuery(e.target.value)}
                  autoFocus
                  disabled={saving}
                />
                <div style={{ marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                  {searching ? (
                    <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', padding: '6px 0' }}>
                      Searching…
                    </div>
                  ) : results.length === 0 ? (
                    <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', padding: '6px 0' }}>
                      No matching assets at this site.
                    </div>
                  ) : (
                    results.map(a => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => setFeed(a.id)}
                        disabled={saving}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left',
                          padding: '7px 8px', border: 'none', borderRadius: 6,
                          background: 'transparent', cursor: 'pointer',
                          fontSize: 'var(--font-size-ui)', color: 'var(--color-text)',
                        }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--color-surface)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{ fontWeight: 600 }}>{assetLabel(a)}</span>
                        <span style={{ marginLeft: 8, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                          {EQUIPMENT_TYPE_LABELS[a.equipmentType] || a.equipmentType}
                          {a.inService === false ? ' · out of service' : ''}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* ── Downstream ─────────────────────────────────────────────── */}
            <SectionHeading style={{ marginTop: 18 }}>Downstream</SectionHeading>
            {downstream.length === 0 ? (
              <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                No downstream assets recorded.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                {downstream.map((node, i) => (
                  <div
                    key={node.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                      padding: '6px 0',
                      borderBottom: i < downstream.length - 1 ? '1px solid var(--color-border)' : 'none',
                      fontSize: 'var(--font-size-ui)',
                    }}
                  >
                    <NodeLink node={node} />
                    {(node.downstreamCount ?? 0) > 0 && (
                      <span
                        title={`${node.downstreamCount} asset${node.downstreamCount !== 1 ? 's' : ''} fed below this one`}
                        style={{
                          fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
                          color: 'var(--color-text-secondary)',
                          border: '1px solid var(--color-border)', borderRadius: 999,
                          padding: '0 7px', background: 'var(--color-bg)',
                        }}
                      >
                        +{node.downstreamCount} downstream
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div
              style={{
                marginTop: 10, padding: '7px 10px', borderRadius: 8,
                fontSize: 'var(--font-size-ui)',
                ...(totalDownstream > 0
                  ? { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', fontWeight: 600 }
                  : { color: 'var(--color-text-secondary)' }),
              }}
            >
              De-energizing this asset affects {totalDownstream} downstream asset{totalDownstream !== 1 ? 's' : ''}.
            </div>
          </>
        )}
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
