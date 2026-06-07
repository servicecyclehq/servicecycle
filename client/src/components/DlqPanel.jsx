import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

// v0.73.7: added Retry button (POST /api/webhooks/dlq/:id/retry)
// v0.67.12 (audit High H33): DLQ inspection panel for SettingsPage
// WebhooksSection. Lists failed webhook deliveries + lets admins retry or
// dismiss rows.
//
// Retry semantic: backend re-fires the delivery. On success the DLQ row is
// auto-purged server-side and we reload. On failure the row stays and we show
// the reason inline so the admin knows what's still broken.

export default function DlqPanel() {
  const [rows, setRows]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [dismissing, setDismissing] = useState(null);
  const [retrying, setRetrying]   = useState(null);
  // Map of id -> { ok: bool, message: string } for inline retry feedback
  const [retryFeedback, setRetryFeedback] = useState({});

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const { data } = await api.get('/api/webhooks/dlq');
      setRows(Array.isArray(data?.data) ? data.data : []);
      // Clear feedback for rows that are no longer present
      setRetryFeedback(prev => {
        const ids = new Set((Array.isArray(data?.data) ? data.data : []).map(r => r.id));
        const next = {};
        for (const [k, v] of Object.entries(prev)) {
          if (ids.has(k)) next[k] = v;
        }
        return next;
      });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function dismiss(id) {
    setDismissing(id);
    try {
      await api.delete(`/api/webhooks/dlq/${id}`);
      await load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setDismissing(null);
    }
  }

  async function retry(id) {
    setRetrying(id);
    setRetryFeedback(prev => ({ ...prev, [id]: null }));
    try {
      const { data } = await api.post(`/api/webhooks/dlq/${id}/retry`);
      if (data?.success) {
        // Backend purged the row on success — reload to reflect that
        await load();
      } else {
        const reason = data?.reason || 'Retry failed';
        setRetryFeedback(prev => ({ ...prev, [id]: { ok: false, message: reason } }));
      }
    } catch (e) {
      const reason = e.response?.data?.error || e.message || 'Retry failed';
      setRetryFeedback(prev => ({ ...prev, [id]: { ok: false, message: reason } }));
    } finally {
      setRetrying(null);
    }
  }

  const sectionHead = {
    fontSize: 'var(--font-size-ui)', fontWeight: 600, color: 'var(--color-text-secondary)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginBottom: 8, marginTop: 24,
  };

  if (loading) return <div style={sectionHead}>Failed deliveries</div>;

  return (
    <section>
      <div style={sectionHead}>
        Failed deliveries {rows.length > 0 && `(${rows.length})`}
      </div>
      <p style={{ margin: '4px 0 12px', fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
        Recent webhook deliveries that failed and have not yet been retried into
        success. The retry cron walks these every 30 minutes; rows older than 30
        days are pruned automatically.
      </p>

      {error && (
        <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>
          {error}
        </div>
      )}

      {rows.length === 0 ? (
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', padding: '8px 0' }}>
          No failed deliveries — webhook fleet healthy.
        </div>
      ) : (
        <table style={{ width: '100%', fontSize: 'var(--font-size-sm)', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border)' }}>
              <th scope="col" style={{ padding: '6px 6px' }}>Event</th>
              <th scope="col" style={{ padding: '6px 6px' }}>Target</th>
              <th scope="col" style={{ padding: '6px 6px', width: 70 }}>Tries</th>
              <th scope="col" style={{ padding: '6px 6px' }}>Last error</th>
              <th scope="col" style={{ padding: '6px 6px', width: 140 }}>Last try</th>
              <th scope="col" style={{ padding: '6px 6px', width: 160 }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const fb = retryFeedback[r.id];
              const busy = retrying === r.id || dismissing === r.id;
              return (
                <tr key={r.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px 6px' }}>{r.eventType}</td>
                  <td style={{ padding: '6px 6px', fontFamily: 'monospace', fontSize: 'var(--font-size-xs)' }}>
                    {r.targetUrlMasked}
                  </td>
                  <td style={{ padding: '6px 6px' }}>{r.attemptCount}</td>
                  <td
                    style={{
                      padding: '6px 6px',
                      color: 'var(--color-danger)',
                      maxWidth: 220,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={r.lastError || ''}
                  >
                    {fb && !fb.ok ? (
                      <span title={fb.message} style={{ color: 'var(--color-danger)' }}>
                        Retry failed: {fb.message.slice(0, 60)}{fb.message.length > 60 ? '…' : ''}
                      </span>
                    ) : (
                      r.lastError || '—'
                    )}
                  </td>
                  <td style={{ padding: '6px 6px' }} title={r.lastAttemptAt}>
                    {r.lastAttemptAt ? new Date(r.lastAttemptAt).toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '6px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => retry(r.id)}
                      style={{
                        padding: '3px 9px',
                        borderRadius: 4,
                        border: '1px solid var(--color-primary)',
                        background: 'var(--color-primary)',
                        color: '#fff',
                        cursor: busy ? 'default' : 'pointer',
                        fontSize: 'var(--font-size-xs)',
                        opacity: busy ? 0.6 : 1,
                        marginRight: 6,
                      }}
                    >
                      {retrying === r.id ? 'Retrying…' : 'Retry'}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => dismiss(r.id)}
                      style={{
                        padding: '3px 9px',
                        borderRadius: 4,
                        border: '1px solid var(--color-border)',
                        background: 'transparent',
                        cursor: busy ? 'default' : 'pointer',
                        fontSize: 'var(--font-size-xs)',
                        opacity: busy ? 0.6 : 1,
                      }}
                    >
                      {dismissing === r.id ? 'Dismissing…' : 'Dismiss'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}