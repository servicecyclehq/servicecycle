// ─────────────────────────────────────────────────────────────────────────────
// TryParserPage.jsx — #17 public parser-as-funnel.
//
// A prospect drops their own test-report PDF + email and instantly sees a
// teaser fix list (findings + criticals) read by the deterministic engine — no
// account, no AI. The full list is gated behind a free signup. Public route,
// plain fetch (no auth interceptors).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';

const SEV = { IMMEDIATE: '#b91c1c', RECOMMENDED: '#92400e', ADVISORY: '#64748b' };

export default function TryParserPage() {
  const fileRef = useRef(null);
  const [email, setEmail] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setError('Enter a valid email.'); return; }
    if (!file) { setError('Choose a test-report PDF.'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('email', email);
      fd.append('file', file);
      const r = await fetch('/api/public/parse-report', { method: 'POST', body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body?.error || 'Could not read that report.');
      setResult(body.data);
    } catch (err) {
      setError(err.message);
    } finally { setBusy(false); }
  }

  const wrap = { maxWidth: 620, margin: '0 auto', padding: '40px 20px', fontFamily: 'system-ui, sans-serif', color: '#0a0d12' };

  return (
    <div style={wrap}>
      <h1 style={{ fontSize: 26, marginBottom: 6 }}>See what your last test report is hiding</h1>
      <p style={{ color: '#5b6373', fontSize: 15, lineHeight: 1.6 }}>
        Drop a PowerDB / Megger / NETA test-report PDF. ServiceCycle reads it and shows you the deficiencies —
        in seconds, on your own data. No account needed to see the count.
      </p>

      {!result ? (
        <form onSubmit={submit} style={{ marginTop: 24 }}>
          <label style={{ fontWeight: 700, fontSize: 13, display: 'block', marginBottom: 4 }}>Work email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@facility.com"
            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #dde2eb', fontSize: 15, marginBottom: 16 }} />
          <input ref={fileRef} type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] || null)}
            style={{ display: 'block', marginBottom: 16 }} />
          {error && <div style={{ color: '#b91c1c', fontSize: 14, marginBottom: 12 }}>{error}</div>}
          <button type="submit" disabled={busy}
            style={{ padding: '12px 20px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
            {busy ? 'Reading your report…' : 'Show me the findings'}
          </button>
          <p style={{ fontSize: 12, color: '#94a3b8', marginTop: 12 }}>
            We don't keep your report. Deterministic parser only — no AI, no data sent to a model.
          </p>
        </form>
      ) : (
        <div style={{ marginTop: 24 }}>
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
            <Stat n={result.measurementCount} label="readings extracted" />
            <Stat n={result.findingsCount} label="findings" color="#92400e" />
            <Stat n={result.criticalCount} label="critical" color="#b91c1c" />
          </div>
          {result.topFindings && result.topFindings.length > 0 && (
            <div style={{ border: '1px solid #dde2eb', borderRadius: 10, padding: '12px 16px', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>A few of what we found</div>
              {result.topFindings.map((f, i) => (
                <div key={i} style={{ fontSize: 14, padding: '4px 0' }}>
                  <strong style={{ color: SEV[f.severity] || '#64748b' }}>{f.severity}</strong>
                  {' '}· {f.label}{f.phase ? ` (Ph ${f.phase})` : ''}
                </div>
              ))}
              <div style={{ fontSize: 13, color: '#5b6373', marginTop: 8 }}>
                {result.findingsCount > (result.topFindings?.length || 0)
                  ? `+ ${result.findingsCount - result.topFindings.length} more — create a free account to keep the full fix list.`
                  : 'Create a free account to keep this and track it to green.'}
              </div>
            </div>
          )}
          {result.findingsCount === 0 && (
            <div style={{ fontSize: 14, color: '#15803d', marginBottom: 16 }}>
              No hard deficiencies in this one — create an account to trend it year over year and catch the slow drift.
            </div>
          )}
          <Link to="/register" style={{ display: 'inline-block', padding: '12px 20px', borderRadius: 8, background: '#2563eb', color: '#fff', fontWeight: 700, fontSize: 15, textDecoration: 'none' }}>
            Create a free account to keep it →
          </Link>
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, color }) {
  return (
    <div>
      <div style={{ fontSize: 36, fontWeight: 800, color: color || '#0a0d12' }}>{n ?? 0}</div>
      <div style={{ fontSize: 12, color: '#5b6373' }}>{label}</div>
    </div>
  );
}
