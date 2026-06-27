import { useEffect, useState } from 'react';
import api from '../api/client';
import useDocumentTitle from '../hooks/useDocumentTitle';

/**
 * AdminMetrics — audit 3.2.6 / 6.3.3 / 6.4.1 / 6.4.2.
 *
 * Six metric groups on one page, no charts (yet): totals, signups-by-day,
 * assets-by-day, DAU, retention cohort, top actions. Each renders as a
 * small table; the page is intentionally low-design so adding a chart
 * layer later is a styling change, not a refactor.
 *
 * super_admin-only route gated at App.jsx via RequireRole. The data endpoint
 * (/api/admin/metrics/overview) is platform-wide BI, so it requires super_admin
 * server-side too (F1 security fix — was admin, which leaked to every tenant).
 */
export default function AdminMetrics() {
  useDocumentTitle('Metrics — ServiceCycle');
  const [data, setData] = useState(null);
  const [err, setErr]   = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await api.get('/api/admin/metrics/overview');
        if (cancelled) return;
        setData(resp.data?.data || null);
      } catch (e) {
        if (cancelled) return;
        // Prefer a server-supplied message, but never surface a raw axios
        // string (e.g. "Network Error" / "Request failed with status code
        // 500") to the user — fall back to a friendly line instead.
        const serverMsg = e.response?.data?.error;
        setErr(serverMsg || 'Could not load metrics right now. Please refresh or try again shortly.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div style={{ padding: 24 }}>Loading metrics…</div>;
  if (err)     return <div style={{ padding: 24, color: 'var(--color-danger)' }}>Error: {err}</div>;
  if (!data)   return <div style={{ padding: 24 }}>No data.</div>;

  const cardStyle = {
    background: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: 8,
    padding: 20,
    marginBottom: 18,
  };
  const h3 = { margin: '0 0 12px', fontSize: 'var(--font-size-data)', fontWeight: 600, color: 'var(--color-text-primary)' };
  const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' };
  const cellStyle = { padding: '6px 10px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' };
  const thStyle   = { ...cellStyle, color: 'var(--color-text-primary)', fontWeight: 600, textAlign: 'left' };

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-xl)', fontWeight: 700 }}>Metrics</h1>
      <p style={{ margin: '0 0 24px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
        Sampled at {new Date(data.sampledAt).toLocaleString()}. Admin-only.
      </p>

      <section style={cardStyle}>
        <h3 style={h3}>Totals</h3>
        <table style={tableStyle}>
          <tbody>
            <tr><td style={cellStyle}>Users</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.totals.users.toLocaleString()}</td></tr>
            <tr><td style={cellStyle}>Accounts</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.totals.accounts.toLocaleString()}</td></tr>
            <tr><td style={cellStyle}>Assets (active)</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.totals.assetsActive.toLocaleString()}</td></tr>
            <tr><td style={cellStyle}>Assets (archived)</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.totals.assetsArchived.toLocaleString()}</td></tr>
          </tbody>
        </table>
      </section>

      <section style={cardStyle}>
        <h3 style={h3}>Signups — last 30 days ({data.signupsByDay.reduce((a, r) => a + r.count, 0)} total)</h3>
        <DayCountTable rows={data.signupsByDay} thStyle={thStyle} cellStyle={cellStyle} tableStyle={tableStyle} />
      </section>

      <section style={cardStyle}>
        <h3 style={h3}>Assets created — last 30 days ({data.assetsByDay.reduce((a, r) => a + r.count, 0)} total)</h3>
        <DayCountTable rows={data.assetsByDay} thStyle={thStyle} cellStyle={cellStyle} tableStyle={tableStyle} />
      </section>

      <section style={cardStyle}>
        <h3 style={h3}>Daily active users (login_success) — last 7 days</h3>
        <DayCountTable rows={data.dauByDay} thStyle={thStyle} cellStyle={cellStyle} tableStyle={tableStyle} />
      </section>

      <section style={cardStyle}>
        <h3 style={h3}>Retention — {data.retention.cohortWindow}</h3>
        <p style={{ margin: '0 0 10px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
          Cohort size: <strong>{data.retention.cohortSize}</strong> users.
        </p>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Window</th><th style={{ ...thStyle, textAlign: 'right' }}>Returned</th><th style={{ ...thStyle, textAlign: 'right' }}>%</th></tr></thead>
          <tbody>
            <tr><td style={cellStyle}>Day 1+</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.retention.d1.count}</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.retention.d1.pct}%</td></tr>
            <tr><td style={cellStyle}>Day 3+</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.retention.d3.count}</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.retention.d3.pct}%</td></tr>
            <tr><td style={cellStyle}>Day 7+</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.retention.d7.count}</td><td style={{ ...cellStyle, textAlign: 'right' }}>{data.retention.d7.pct}%</td></tr>
          </tbody>
        </table>
      </section>

      <section style={cardStyle}>
        <h3 style={h3}>Top actions — last 7 days</h3>
        <table style={tableStyle}>
          <thead><tr><th style={thStyle}>Action</th><th style={{ ...thStyle, textAlign: 'right' }}>Count</th></tr></thead>
          <tbody>
            {data.topActions7d.length === 0
              ? <tr><td colSpan={2} style={{ ...cellStyle, textAlign: 'center' }}>No activity in the last 7 days.</td></tr>
              : data.topActions7d.map(r => (
                  <tr key={r.action}>
                    <td style={cellStyle}>{r.action}</td>
                    <td style={{ ...cellStyle, textAlign: 'right' }}>{r.count.toLocaleString()}</td>
                  </tr>
                ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function DayCountTable({ rows, thStyle, cellStyle, tableStyle }) {
  if (!rows || rows.length === 0) {
    return <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>No data in this window.</p>;
  }
  return (
    <table style={tableStyle}>
      <thead><tr><th style={thStyle}>Day</th><th style={{ ...thStyle, textAlign: 'right' }}>Count</th></tr></thead>
      <tbody>
        {rows.map(r => (
          <tr key={r.day}>
            <td style={cellStyle}>{r.day}</td>
            <td style={{ ...cellStyle, textAlign: 'right' }}>{r.count.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}