/**
 * EarlyAccessLeadsPage — admin view of landing-page lead-form submissions.
 *
 * Consumes GET /api/admin/early-access/list (built in L7). Mounted under
 * the authenticated Layout shell, gated to admin role only.
 *
 * Read-only: no row mutation. Replying to a lead = clicking the email
 * address (mailto). The API row is kept indefinitely for audit; the
 * privacy policy commits to deletion-on-request via support@servicecycle.app.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

const TIMING_LABEL = {
  now:        'Now (this week)',
  this_week:  'This week',
  this_month: 'This month',
  browsing:   'Just browsing',
};

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now - d;
  const diffDays = Math.floor(diffMs / 86400000);
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  let rel = '';
  if (diffDays === 0) rel = ' (today)';
  else if (diffDays === 1) rel = ' (yesterday)';
  else if (diffDays < 30) rel = ` (${diffDays} days ago)`;
  return `${day} ${time}${rel}`;
}

export default function EarlyAccessLeadsPage() {
  useDocumentTitle('Early access leads');
  const { user } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | timing value

  useEffect(() => {
    if (user && user.role !== 'admin') {
      navigate('/dashboard');
    }
  }, [user, navigate]);

  useEffect(() => {
    let cancelled = false;
    api.get('/api/admin/early-access/list?take=200')
      .then(r => { if (!cancelled) setRows(r.data?.data?.rows || []); })
      .catch(e => { if (!cancelled) setError(e.response?.data?.error || 'Failed to load leads'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const filtered = rows.filter(r => {
    if (filter !== 'all' && r.timing !== filter) return false;
    if (search) {
      const q = search.toLowerCase();
      return [r.name, r.email, r.company].some(v => (v || '').toLowerCase().includes(q));
    }
    return true;
  });

  const counts = rows.reduce((acc, r) => {
    acc[r.timing || 'unknown'] = (acc[r.timing || 'unknown'] || 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ padding: '1.5rem 2rem', maxWidth: 1180 }}>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, marginBottom: 4 }}>Early-access leads</h1>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-data)', margin: 0 }}>
          Submissions from the landing-page form at{' '}
          <a href="/" style={{ color: 'var(--color-primary)' }}>servicecycle.app/#early-access</a>.
          Click any email to reply.
        </p>
      </div>

      {/* Summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
        {[
          { key: 'all',        label: 'Total',       n: rows.length },
          { key: 'now',        label: 'Now (hot)',   n: counts.now || 0 },
          { key: 'this_week',  label: 'This week',   n: counts.this_week || 0 },
          { key: 'this_month', label: 'This month',  n: counts.this_month || 0 },
          { key: 'browsing',   label: 'Browsing',    n: counts.browsing || 0 },
        ].map(c => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            style={{
              background: filter === c.key ? 'var(--color-primary-light, #e6f0f5)' : 'var(--color-surface, #fafbfd)',
              border: `1px solid ${filter === c.key ? 'var(--color-primary)' : 'var(--color-border)'}`,
              borderRadius: 8,
              padding: '12px 14px',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{c.label}</div>
            <div style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)', marginTop: 4 }}>{c.n}</div>
          </button>
        ))}
      </div>

      {/* Search */}
      <div style={{ marginBottom: 14 }}>
        <input
          type="search"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, email, or company…"
          className="form-control"
          style={{ maxWidth: 340 }}
        />
      </div>

      {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

      {loading ? (
        <p style={{ color: 'var(--color-text-secondary)' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <div style={{
          padding: '3rem 1rem',
          textAlign: 'center',
          color: 'var(--color-text-secondary)',
          background: 'var(--color-surface, #fafbfd)',
          borderRadius: 8,
          border: '1px dashed var(--color-border)',
        }}>
          {rows.length === 0
            ? 'No leads yet. Once visitors submit the early-access form on the landing page, they show up here.'
            : 'No leads match the current filter.'}
        </div>
      ) : (
        <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-data)' }}>
            <thead>
              <tr style={{ background: 'var(--color-surface, #fafbfd)' }}>
                <th scope="col" style={th}>Name</th>
                <th scope="col" style={th}>Email</th>
                <th scope="col" style={th}>Company</th>
                <th scope="col" style={th}>Timing</th>
                <th scope="col" style={{ ...th, textAlign: 'right' }}>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--color-border)' }}>
                  <td style={td}>{r.name}</td>
                  <td style={td}>
                    <a href={`mailto:${r.email}?subject=${encodeURIComponent('Re: Your ServiceCycle early-access request')}`} style={{ color: 'var(--color-primary)' }}>
                      {r.email}
                    </a>
                  </td>
                  <td style={td}>{r.company || <span style={{ color: 'var(--color-text-secondary)' }}>—</span>}</td>
                  <td style={td}>
                    <span style={{
                      fontSize: 'var(--font-size-sm)', fontWeight: 600,
                      padding: '3px 8px', borderRadius: 11,
                      background: r.timing === 'now' ? '#fee2e2' : r.timing === 'this_week' ? '#fef3c7' : 'var(--color-surface)',
                      color:      r.timing === 'now' ? '#991b1b' : r.timing === 'this_week' ? '#854d0e' : 'var(--color-text-secondary)',
                    }}>
                      {TIMING_LABEL[r.timing] || r.timing || 'unspecified'}
                    </span>
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-ui)' }}>
                    {fmtDate(r.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const th = {
  padding: '10px 14px', textAlign: 'left',
  fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-text-secondary)',
  textTransform: 'uppercase', letterSpacing: '0.04em',
};
const td = { padding: '10px 14px', verticalAlign: 'top' };
