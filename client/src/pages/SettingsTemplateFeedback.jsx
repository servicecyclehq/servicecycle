/**
 * SettingsTemplateFeedback — admin-only view of the local Template
 * Feedback table.
 *
 * Phase 4 — v0.4.0. Renders feedback rows submitted by users on AI
 * renewal briefs. Account-scoped on the server side (GET /api/template-
 * feedback is admin-gated and filters by req.user.accountId). XSS-safe
 * render: free-text is shown as plain text via React's default escaping.
 *
 * v0.4.0 is local-only — these rows stay in the customer's own DB.
 * v0.4.1 will add an opt-in upstream sync to a CF Worker.
 */

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const SECTION_LABELS = {
  situation: 'Situation',
  market:    'Market',
  tactics:   'Tactics',
  watchFor:  'Watch For',
};

function fmtDateTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
  } catch { return iso; }
}

const PAGE_SIZE = 50;

export default function SettingsTemplateFeedback() {
  useDocumentTitle('Template feedback');
  const [rows, setRows]           = useState([]);
  const [total, setTotal]         = useState(0);
  const [offset, setOffset]       = useState(0);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [filterCat, setFilterCat] = useState('');
  const [filterSec, setFilterSec] = useState('');

  const load = useCallback(async (off = 0) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('limit', PAGE_SIZE);
      params.set('offset', off);
      if (filterCat) params.set('categorySlug', filterCat);
      if (filterSec) params.set('section', filterSec);
      const res = await api.get(`/api/template-feedback?${params.toString()}`);
      const d = res.data?.data || {};
      setRows(d.rows || []);
      setTotal(d.total || 0);
      setOffset(d.offset || 0);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to load template feedback');
    } finally {
      setLoading(false);
    }
  }, [filterCat, filterSec]);

  useEffect(() => { load(0); }, [load]);

  const pageStart = offset + 1;
  const pageEnd   = Math.min(offset + rows.length, total);

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={{ margin: '0 0 0.4rem', fontSize: '1.05rem' }}>Template Feedback</h2>
      <p style={{ margin: '0 0 1rem', color: 'var(--color-text-secondary)', fontSize: '0.85rem', maxWidth: 720 }}>
        Per-section feedback submitted by users on AI renewal briefs. Rows stay
        local to this instance in v0.4.0; an opt-in upstream sync is planned
        for v0.4.1. Use this view to spot recurring weak spots in specific
        category templates — e.g. consistent thumbs-down on the Market section
        for telecom briefs suggests the Tavily allowlist needs a different
        source.
      </p>

      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
        <label style={{ fontSize: '0.85rem' }}>
          Category:&nbsp;
          <select value={filterCat} onChange={(e) => setFilterCat(e.target.value)}>
            <option value="">All</option>
            <option value="saas">SaaS</option>
            <option value="telecom">Telecom</option>
            <option value="insurance">Insurance</option>
            <option value="lease_rent">Lease / Rent</option>
            <option value="hardware">Hardware</option>
            <option value="services">Services</option>
            <option value="utilities">Utilities</option>
            <option value="supplies">Supplies</option>
            <option value="other">Other</option>
          </select>
        </label>
        <label style={{ fontSize: '0.85rem' }}>
          Section:&nbsp;
          <select value={filterSec} onChange={(e) => setFilterSec(e.target.value)}>
            <option value="">All</option>
            <option value="situation">Situation</option>
            <option value="market">Market</option>
            <option value="tactics">Tactics</option>
            <option value="watchFor">Watch For</option>
          </select>
        </label>
        <span style={{ marginLeft: 'auto', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
          {total === 0 ? '0 rows' : `${pageStart}–${pageEnd} of ${total}`}
        </span>
      </div>

      {error && <div style={{ color: '#c33', fontSize: '0.85rem', marginBottom: 8 }}>{error}</div>}

      {loading && rows.length === 0 ? (
        <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)' }}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ fontSize: '0.9rem', color: 'var(--color-text-secondary)', padding: '1rem 0' }}>
          No feedback submitted yet. The widget appears under each section of a generated brief.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border, #d0d0d0)', textAlign: 'left' }}>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>When</th>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>User</th>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>Contract</th>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>Category</th>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>Section</th>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>Rating</th>
                <th scope="col" style={{ padding: '0.5rem 0.4rem' }}>Comment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--color-border, #eee)' }}>
                  <td style={{ padding: '0.5rem 0.4rem', whiteSpace: 'nowrap' }}>{fmtDateTime(r.createdAt)}</td>
                  <td style={{ padding: '0.5rem 0.4rem' }}>
                    {r.user?.name || r.user?.email || <span style={{ color: 'var(--color-text-muted)' }}>(deleted)</span>}
                  </td>
                  <td style={{ padding: '0.5rem 0.4rem' }}>
                    {r.contract
                      ? `${r.contract.product || '—'}${r.contract.vendor?.name ? ' / ' + r.contract.vendor.name : ''}`
                      : <span style={{ color: 'var(--color-text-muted)' }}>(deleted)</span>}
                  </td>
                  <td style={{ padding: '0.5rem 0.4rem' }}>
                    {r.categorySlug} <span style={{ color: 'var(--color-text-muted)' }}>v{r.templateVersion}</span>
                  </td>
                  <td style={{ padding: '0.5rem 0.4rem' }}>{SECTION_LABELS[r.section] || r.section}</td>
                  <td style={{ padding: '0.5rem 0.4rem' }}>
                    {r.rating ? <span title="thumbs up">👍</span> : <span title="thumbs down">👎</span>}
                  </td>
                  <td style={{ padding: '0.5rem 0.4rem', maxWidth: 360, whiteSpace: 'pre-wrap' }}>
                    {/* React escapes by default — XSS-safe inline render. */}
                    {r.freeText || <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          type="button"
          onClick={() => load(Math.max(0, offset - PAGE_SIZE))}
          disabled={loading || offset === 0}
          style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
        >
          ← Previous
        </button>
        <button
          type="button"
          onClick={() => load(offset + PAGE_SIZE)}
          disabled={loading || offset + rows.length >= total}
          style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
        >
          Next →
        </button>
      </div>
    </section>
  );
}
