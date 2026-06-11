// ─────────────────────────────────────────────────────────────────────────────
// ArchivedAssets.jsx — soft-deleted asset register (ServiceCycle Assets v1).
//
// GET /api/assets?archived=true shows ONLY archived rows (server convention).
// Unarchive restores the asset to the main register via
// POST /api/assets/:id/unarchive. History (work orders, lab samples,
// deficiencies) is preserved either way — archive is never destructive.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Archive } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { kbdActivate } from '../lib/a11y';
import EmptyState from '../components/EmptyState';
import Toast from '../components/Toast';
import BackLink, { useFromState } from '../components/BackLink';
import { EQUIPMENT_TYPE_LABELS, assetLabel, fmtDate } from '../lib/equipment';

const PAGE_SIZE = 25;

export default function ArchivedAssets() {
  useDocumentTitle('Archived Assets');
  const navigate = useNavigate();
  // C1: row clicks record this list as the origin for AssetDetail's BackLink.
  const fromState = useFromState();
  const confirm = useConfirm();
  const { features } = useAuth();
  // See AssetsList: assets_write with contracts_write fallback.
  const canWrite = features.assets_write ?? features.contracts_write;

  const [assets, setAssets]         = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pages: 1, total: 0 });
  const [page, setPage]             = useState(1);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState('');
  const [toast, setToast]           = useState(null);
  const [busyId, setBusyId]         = useState(null);

  const fetchAssets = useCallback(() => {
    setLoading(true);
    api.get(`/api/assets?archived=true&page=${page}&limit=${PAGE_SIZE}&sort=createdAt&sortDir=desc`)
      .then(r => {
        const d = r.data.data || {};
        setAssets(d.assets || []);
        setPagination(d.pagination || { page: 1, pages: 1, total: 0 });
        setError('');
      })
      .catch(() => setError('Failed to load archived assets.'))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => { fetchAssets(); }, [fetchAssets]);

  async function handleUnarchive(asset) {
    if (busyId) return;
    if (!await confirm({
      title: 'Unarchive asset?',
      message: `${assetLabel(asset)} returns to the main register and resumes appearing in compliance views.`,
      confirmLabel: 'Unarchive',
    })) return;
    setBusyId(asset.id);
    try {
      await api.post(`/api/assets/${asset.id}/unarchive`);
      setToast({ message: `${assetLabel(asset)} unarchived.`, variant: 'success', duration: 4000 });
      fetchAssets();
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to unarchive asset.', variant: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <BackLink fallback="/assets" fallbackLabel="Assets" />
          <h1 className="page-title">Archived Assets</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : `${pagination.total} archived asset${pagination.total !== 1 ? 's' : ''} — history preserved, hidden from the main register`}
          </div>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <div className="card">
          {loading ? (
            <div className="loading">Loading archived assets…</div>
          ) : assets.length === 0 ? (
            <EmptyState
              icon={Archive}
              title="No archived assets"
              sub="Assets you archive from their detail page will show up here, with all their maintenance history intact."
              ctaLabel="Back to Assets"
              ctaTo="/assets"
            />
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Equipment</th>
                      <th>Manufacturer / Model</th>
                      <th>Serial #</th>
                      <th>Site</th>
                      <th>Archived</th>
                      {canWrite && <th style={{ textAlign: 'right' }}></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {assets.map(a => (
                      <tr
                        key={a.id}
                        style={{ opacity: 0.75, cursor: 'pointer' }}
                        onClick={() => navigate(`/assets/${a.id}`, { state: fromState })}
                        tabIndex={0}
                        onKeyDown={kbdActivate(() => navigate(`/assets/${a.id}`, { state: fromState }))}
                      >
                        <td style={{ fontWeight: 600 }}>
                          {EQUIPMENT_TYPE_LABELS[a.equipmentType] || a.equipmentType}
                        </td>
                        <td>
                          {(a.manufacturer || a.model)
                            ? [a.manufacturer, a.model].filter(Boolean).join(' ')
                            : <span className="text-muted">—</span>}
                        </td>
                        <td className="td-muted">{a.serialNumber || '—'}</td>
                        <td>{a.site?.name || '—'}</td>
                        <td className="td-muted">{fmtDate(a.archivedAt)}</td>
                        {canWrite && (
                          <td style={{ textAlign: 'right' }} onClick={e => e.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleUnarchive(a)}
                              disabled={busyId === a.id}
                            >
                              {busyId === a.id ? 'Restoring…' : 'Unarchive'}
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {pagination.pages > 1 && (
                <div className="pagination">
                  <div className="pagination-info">
                    Page {pagination.page} of {pagination.pages} · {pagination.total} assets
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
            </>
          )}
        </div>
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
