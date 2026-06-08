// ─────────────────────────────────────────────────────────────────────────────
// AssetLotoCard.jsx — LOTO Procedures section on the asset detail page.
//
// Fetches all LOTO procedures for the asset and renders:
//   • Active procedure at the top (prominent border)
//   • Draft procedures (ready to be edited / activated)
//   • Archived procedures (collapsed by default)
//   • "New Procedure" button (manager+)
//   • Inline LotoProcForm for create / edit
//
// Takes { asset, canWrite }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import Toast from './Toast';
import LotoProcCard from './LotoProcCard';
import LotoProcForm from './LotoProcForm';

export default function AssetLotoCard({ asset, canWrite }) {
  const [procs,         setProcs]        = useState([]);
  const [loading,       setLoading]      = useState(false);
  const [err,           setErr]          = useState(null);
  const [toast,         setToast]        = useState(null);
  const [editing,       setEditing]      = useState(null); // proc to edit, or 'new'
  const [showArchived,  setShowArchived] = useState(false);

  const fetchProcs = useCallback(async () => {
    if (!asset?.id) return;
    setLoading(true);
    setErr(null);
    try {
      const { data } = await api.get(`/api/assets/${asset.id}/loto`);
      setProcs(data.data || []);
    } catch (e) {
      // Surface the failure instead of silently showing the empty state — a
      // dropped fetch must not read as "no LOTO procedure on file" for a
      // compliance-critical card.
      setErr(e?.response?.data?.error || 'Failed to load LOTO procedures.');
    }
    finally { setLoading(false); }
  }, [asset?.id]);

  useEffect(() => { fetchProcs(); }, [fetchProcs]);

  function handleSaved() {
    setEditing(null);
    fetchProcs();
    setToast({ message: 'Procedure saved', type: 'success' });
  }

  const active   = procs.filter(p => p.status === 'active');
  const drafts   = procs.filter(p => p.status === 'draft');
  const archived = procs.filter(p => p.status === 'archived');

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="card-title">
          🔒 LOTO Procedures
          {active.length > 0 && (
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 700, color: '#15803d',
              background: '#f0fdf4', padding: '2px 8px', borderRadius: 10 }}>
              Active ✓
            </span>
          )}
        </div>
        {canWrite && !editing && (
          <button className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>
            + New procedure
          </button>
        )}
      </div>

      <div className="card-body">

        {/* ── Editor ───────────────────────────────────────────────────────── */}
        {editing && (
          <div style={{
            border: '1px solid var(--color-border)', borderRadius: 8, padding: 16, marginBottom: 16,
            background: 'var(--color-bg-secondary)',
          }}>
            <LotoProcForm
              assetId={asset.id}
              proc={editing === 'new' ? null : editing}
              onSaved={handleSaved}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}

        {/* ── Loading ───────────────────────────────────────────────────────── */}
        {loading && procs.length === 0 && (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Loading…</div>
        )}

        {/* ── Error ─────────────────────────────────────────────────────────── */}
        {!loading && err && (
          <div role="alert" style={{ color: '#991b1b', fontSize: 'var(--font-size-sm)' }}>
            {err}{' '}
            <button
              type="button"
              onClick={fetchProcs}
              style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
                color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer' }}
            >
              Retry
            </button>
          </div>
        )}

        {/* ── Empty state ───────────────────────────────────────────────────── */}
        {!loading && !err && procs.length === 0 && !editing && (
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
            No LOTO procedure on file for this asset.
            {canWrite
              ? ' OSHA 29 CFR 1910.147 requires a written procedure for equipment with multiple energy sources. Create one above.'
              : ' No procedure has been created yet.'}
          </div>
        )}

        {/* ── Active ───────────────────────────────────────────────────────── */}
        {active.map(p => (
          <LotoProcCard key={p.id} proc={p} canWrite={canWrite}
            onStatusChange={fetchProcs}
            onEdit={() => setEditing(p)} />
        ))}

        {/* ── Drafts ───────────────────────────────────────────────────────── */}
        {drafts.length > 0 && (
          <>
            {active.length > 0 && (
              <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
                textTransform: 'uppercase', color: 'var(--color-text-secondary)', margin: '12px 0 8px' }}>
                Drafts ({drafts.length})
              </div>
            )}
            {drafts.map(p => (
              <LotoProcCard key={p.id} proc={p} canWrite={canWrite}
                onStatusChange={fetchProcs}
                onEdit={() => setEditing(p)} />
            ))}
          </>
        )}

        {/* ── Archived ─────────────────────────────────────────────────────── */}
        {archived.length > 0 && (
          <>
            <button type="button"
              onClick={() => setShowArchived(v => !v)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)',
                fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '8px 0', letterSpacing: '0.04em',
                textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 6 }}>
              {showArchived ? '▾' : '▸'} Archived ({archived.length})
            </button>
            {showArchived && archived.map(p => (
              <LotoProcCard key={p.id} proc={p} canWrite={false}
                onStatusChange={fetchProcs}
                onEdit={() => {}} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
