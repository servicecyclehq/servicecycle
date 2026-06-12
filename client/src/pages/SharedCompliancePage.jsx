// ─────────────────────────────────────────────────────────────────────────────
// SharedCompliancePage.jsx — #21 public, read-only compliance package.
//
// Rendered for an auditor / insurer who follows a time-boxed share link. No
// login: the token in the URL is the credential. Shows the honest compliance
// number, the Path-to-100 action list, and the latest hash-chained snapshot —
// watermarked and read-only. Uses a plain fetch (no auth interceptors).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';

function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function SharedCompliancePage() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/public/share/${encodeURIComponent(token)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || 'This link is no longer available.');
        return body.data;
      })
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const wrap = { maxWidth: 760, margin: '0 auto', padding: '32px 20px', fontFamily: 'system-ui, sans-serif', color: '#0a0d12' };

  if (loading) return <div style={wrap}>Loading shared compliance record…</div>;
  if (error) return (
    <div style={wrap}>
      <h1 style={{ fontSize: 22 }}>ServiceCycle</h1>
      <p style={{ color: '#b91c1c' }}>{error}</p>
      <p style={{ color: '#5b6373', fontSize: 14 }}>Ask the facility to send you a fresh link.</p>
    </div>
  );
  if (!data) return null;

  const rate = data.overallRate;
  const rateColor = rate == null ? '#64748b' : rate >= 90 ? '#15803d' : rate >= 70 ? '#92400e' : '#b91c1c';

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>ServiceCycle · Compliance Record</h1>
        <span style={{ fontSize: 12, color: '#6d28d9', fontWeight: 700 }}>READ-ONLY</span>
      </div>
      <div style={{ fontSize: 13, color: '#5b6373', marginTop: 4 }}>{data.watermark}</div>
      <div style={{ fontSize: 13, color: '#5b6373' }}>
        Generated {fmtDate(data.generatedAt)} · link expires {fmtDate(data.expiresAt)}
      </div>

      <h2 style={{ fontSize: 24, marginTop: 24, marginBottom: 2 }}>{data.companyName}</h2>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
        <div style={{ fontSize: 48, fontWeight: 800, color: rateColor }}>{rate == null ? '—' : `${rate}%`}</div>
        <div style={{ fontSize: 13, color: '#5b6373' }}>
          NFPA 70B honest compliance rate<br />
          Schedule compliance {data.compliance?.rate ?? '—'}% · Coverage {data.coverage?.rate ?? '—'}%
          {' '}({data.coverage?.coveredAssets ?? 0}/{data.coverage?.totalAssets ?? 0} assets)
        </div>
      </div>

      {data.latestSnapshot && (
        <div style={{ marginTop: 18, padding: '12px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}>
          <strong>Latest hash-chained snapshot:</strong> {data.latestSnapshot.kind === 'emp' ? 'Electrical Maintenance Program (EMP)' : 'Compliance evidence pack'}
          {' '}generated {fmtDate(data.latestSnapshot.date)}.
          <div style={{ color: '#5b6373', wordBreak: 'break-all', marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>
            SHA-256 {data.latestSnapshot.sha256}
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 16, marginTop: 28 }}>
        {data.summary?.fullyCompliant ? 'Fully compliant — nothing outstanding' : `Path to 100% — ${data.summary?.totalActions ?? 0} open action${(data.summary?.totalActions ?? 0) === 1 ? '' : 's'}`}
      </h3>
      {data.topActions && data.topActions.length > 0 && (
        <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          {data.topActions.map((a, i) => <li key={i} style={{ fontSize: 14 }}>{a.title}</li>)}
        </ul>
      )}

      <div style={{ marginTop: 36, paddingTop: 12, borderTop: '1px solid #e2e8f0', fontSize: 11, color: '#94a3b8' }}>
        This is a read-only summary shared by the facility for audit/underwriting review. Figures reflect live
        system data at the generation time above. Powered by ServiceCycle.
      </div>
    </div>
  );
}
