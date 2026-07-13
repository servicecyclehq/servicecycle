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

function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}

function fmtRange(r) {
  if (!r) return '—';
  if (r.min === r.max) return fmtUsd(r.min);
  return `${fmtUsd(r.min)} – ${fmtUsd(r.max)}`;
}

const SEV_COLOR = { critical: '#b91c1c', high: '#c2410c', medium: '#b45309', low: '#3f6212' };

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

  // #3 -- insurer underwriting packet layout (richer than the auditor view).
  if (data.kind === 'underwriting') {
    const rd = data.readiness || {};
    const rp = data.riskPosture || {};
    const fin = data.financial || {};
    const ev = data.evidenceIntegrity || {};
    const sev = rp.bySeverity || {};
    const uwColor = rd.overallRate == null ? '#64748b' : rd.overallRate >= 90 ? '#15803d' : rd.overallRate >= 70 ? '#92400e' : '#b91c1c';
    const cell = { padding: '12px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 };
    return (
      <div style={wrap} className="print-doc">
        {/* C2c: shared Field Report print standard (styles/print.css). Screen
            layout unchanged; print swaps the app-ish header for the masthead.
            Watermark line below prints untouched. */}
        <header className="print-masthead print-only">
          <h1 className="print-masthead-title">Insurer Underwriting Package</h1>
          <div className="print-masthead-meta">
            {data.companyName}<br />
            Read-only · Generated {fmtDate(data.generatedAt)}
          </div>
        </header>
        <div className="print-rule print-only"></div>

        <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
          <h1 style={{ fontSize: 20, margin: 0 }}>ServiceCycle · Insurer Underwriting Package</h1>
          <span style={{ fontSize: 12, color: '#6d28d9', fontWeight: 700 }}>READ-ONLY</span>
        </div>
        <div style={{ fontSize: 13, color: '#5b6373', marginTop: 4 }}>{data.watermark}</div>
        <div style={{ fontSize: 13, color: '#5b6373' }}>
          {data.standard || 'NFPA 70B'} · generated {fmtDate(data.generatedAt)} · link expires {fmtDate(data.expiresAt)}
        </div>

        <h2 style={{ fontSize: 24, marginTop: 24, marginBottom: 2 }}>{data.companyName}</h2>

        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Readiness</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          <div style={{ fontSize: 48, fontWeight: 800, color: uwColor }}>{rd.overallRate == null ? '—' : `${rd.overallRate}%`}</div>
          <div style={{ fontSize: 13, color: '#5b6373' }}>
            NFPA 70B honest compliance rate · maturity {rd.score ?? '—'}/100 ({rd.levelLabel || '—'})<br />
            Schedule compliance {rd.complianceRate ?? '—'}% · Coverage {rd.coverageRate ?? '—'}%
            {' '}({rd.coveredAssets ?? 0}/{rd.totalAssets ?? 0} assets) · Evidence on file {rd.documentedPct ?? '—'}%
          </div>
        </div>
        </section>

        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Risk posture</h2>
        </div>
        <h3 className="no-print" style={{ fontSize: 16, marginTop: 28 }}>Risk posture</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div style={cell}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{rp.totalFindings ?? 0}</div>
            <div style={{ fontSize: 12, color: '#5b6373' }}>likely audit findings ({rp.categories ?? 0} categories)</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {['critical', 'high', 'medium', 'low'].filter((k) => sev[k] > 0).map((k) => (
                <span key={k} style={{ color: SEV_COLOR[k], fontWeight: 700, marginRight: 8 }}>{sev[k]} {k}</span>
              ))}
            </div>
          </div>
          <div style={cell}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{rp.untrackedAssets ?? 0}</div>
            <div style={{ fontSize: 12, color: '#5b6373' }}>assets on no maintenance program</div>
          </div>
          <div style={cell}>
            <div style={{ fontSize: 22, fontWeight: 800 }}>{rp.forgottenAssets ?? 0}</div>
            <div style={{ fontSize: 12, color: '#5b6373' }}>not serviced in 3+ yrs{rp.neverServiced > 0 ? ` (${rp.neverServiced} never)` : ''}</div>
          </div>
        </div>
        {rp.topFindings && rp.topFindings.length > 0 && (
          <ul style={{ paddingLeft: 18, lineHeight: 1.7, marginTop: 12 }}>
            {rp.topFindings.map((f, i) => (
              <li key={i} style={{ fontSize: 14 }}>
                <span style={{ color: SEV_COLOR[f.severity] || '#5b6373', fontWeight: 700 }}>{f.title}</span>
                <span style={{ color: '#5b6373' }}> — {f.count}</span>
              </li>
            ))}
          </ul>
        )}
        </section>

        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Capital plan ({fin.currency || 'USD'} ranges)</h2>
        </div>
        <h3 className="no-print" style={{ fontSize: 16, marginTop: 28 }}>Capital plan ({fin.currency || 'USD'} ranges)</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div style={cell}><div style={{ fontSize: 12, color: '#5b6373' }}>1-year</div><div style={{ fontSize: 16, fontWeight: 700 }}>{fmtRange(fin.plan?.year1)}</div></div>
          <div style={cell}><div style={{ fontSize: 12, color: '#5b6373' }}>3-year (cumulative)</div><div style={{ fontSize: 16, fontWeight: 700 }}>{fmtRange(fin.plan?.year3)}</div></div>
          <div style={cell}><div style={{ fontSize: 12, color: '#5b6373' }}>5-year (cumulative)</div><div style={{ fontSize: 16, fontWeight: 700 }}>{fmtRange(fin.plan?.year5)}</div></div>
        </div>
        <div style={{ fontSize: 12, color: '#5b6373', marginTop: 8 }}>
          Total maintenance debt {fmtRange(fin.debtTotal)} · repair backlog {fmtUsd(fin.repairBacklog?.amount)} across {fin.repairBacklog?.assets ?? 0} asset(s).
        </div>
        </section>

        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Evidence integrity</h2>
        </div>
        <div style={{ marginTop: 24, ...cell }}>
          <strong className="no-print">Evidence integrity:</strong>{' '}
          {ev.snapshotCount ?? 0} immutable, hash-chained snapshot(s) on file.
          {ev.latestSnapshot ? (
            <>
              {' '}Latest {ev.latestSnapshot.kind === 'emp' ? 'EMP document' : 'compliance pack'} generated {fmtDate(ev.latestSnapshot.date)}.
              <div style={{ color: '#5b6373', wordBreak: 'break-all', marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>SHA-256 {ev.latestSnapshot.sha256}</div>
            </>
          ) : ' No snapshot generated yet.'}
        </div>
        </section>

        <div style={{ marginTop: 24, fontSize: 11, color: '#94a3b8' }}>{data.disclaimer}</div>
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #e2e8f0', fontSize: 11, color: '#94a3b8' }}>
          Read-only summary shared by the facility for underwriting review. Powered by ServiceCycle.
        </div>

        <footer className="print-footer print-only">
          <span>ServiceCycle</span>
          <span className="print-footer-pages">Generated {fmtDate(data.generatedAt)}</span>
        </footer>
      </div>
    );
  }

  const rate = data.overallRate;
  const rateColor = rate == null ? '#64748b' : rate >= 90 ? '#15803d' : rate >= 70 ? '#92400e' : '#b91c1c';
  const pathTitle = data.summary?.fullyCompliant
    ? 'Fully compliant — nothing outstanding'
    : `Path to 100% — ${data.summary?.totalActions ?? 0} open action${(data.summary?.totalActions ?? 0) === 1 ? '' : 's'}`;

  return (
    <div style={wrap} className="print-doc">
      {/* C2c: shared Field Report print standard (styles/print.css). Screen
          layout unchanged; print swaps the app-ish header for the masthead.
          Watermark line below prints untouched. */}
      <header className="print-masthead print-only">
        <h1 className="print-masthead-title">Compliance Record</h1>
        <div className="print-masthead-meta">
          {data.companyName}<br />
          Read-only · Generated {fmtDate(data.generatedAt)}
        </div>
      </header>
      <div className="print-rule print-only"></div>

      <div className="no-print" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>ServiceCycle · Compliance Record</h1>
        <span style={{ fontSize: 12, color: '#6d28d9', fontWeight: 700 }}>READ-ONLY</span>
      </div>
      <div style={{ fontSize: 13, color: '#5b6373', marginTop: 4 }}>{data.watermark}</div>
      <div style={{ fontSize: 13, color: '#5b6373' }}>
        Generated {fmtDate(data.generatedAt)} · link expires {fmtDate(data.expiresAt)}
      </div>

      <h2 style={{ fontSize: 24, marginTop: 24, marginBottom: 2 }}>{data.companyName}</h2>

      <section className="print-sec">
      <div className="print-sec-head print-only">
        <span className="print-sec-no" />
        <h2 className="print-sec-title">Compliance status</h2>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
        <div style={{ fontSize: 48, fontWeight: 800, color: rateColor }}>{rate == null ? '—' : `${rate}%`}</div>
        <div style={{ fontSize: 13, color: '#5b6373' }}>
          NFPA 70B honest compliance rate<br />
          Schedule compliance {data.compliance?.rate ?? '—'}% · Coverage {data.coverage?.rate ?? '—'}%
          {' '}({data.coverage?.coveredAssets ?? 0}/{data.coverage?.totalAssets ?? 0} assets)
        </div>
      </div>
      </section>

      {data.latestSnapshot && (
        <section className="print-sec">
        <div className="print-sec-head print-only">
          <span className="print-sec-no" />
          <h2 className="print-sec-title">Evidence integrity</h2>
        </div>
        <div style={{ marginTop: 18, padding: '12px 14px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 13 }}>
          <strong>Latest hash-chained snapshot:</strong> {data.latestSnapshot.kind === 'emp' ? 'Electrical Maintenance Program (EMP)' : 'Compliance evidence pack'}
          {' '}generated {fmtDate(data.latestSnapshot.date)}.
          <div style={{ color: '#5b6373', wordBreak: 'break-all', marginTop: 4, fontFamily: 'monospace', fontSize: 11 }}>
            SHA-256 {data.latestSnapshot.sha256}
          </div>
        </div>
        </section>
      )}

      <section className="print-sec">
      <div className="print-sec-head print-only">
        <span className="print-sec-no" />
        <h2 className="print-sec-title">{pathTitle}</h2>
      </div>
      <h3 className="no-print" style={{ fontSize: 16, marginTop: 28 }}>{pathTitle}</h3>
      {data.topActions && data.topActions.length > 0 && (
        <ul style={{ paddingLeft: 18, lineHeight: 1.7 }}>
          {data.topActions.map((a, i) => <li key={i} style={{ fontSize: 14 }}>{a.title}</li>)}
        </ul>
      )}
      </section>

      <div style={{ marginTop: 36, paddingTop: 12, borderTop: '1px solid #e2e8f0', fontSize: 11, color: '#94a3b8' }}>
        This is a read-only summary shared by the facility for audit/underwriting review. Figures reflect live
        system data at the generation time above. Powered by ServiceCycle.
      </div>

      <footer className="print-footer print-only">
        <span>ServiceCycle</span>
        <span className="print-footer-pages">Generated {fmtDate(data.generatedAt)}</span>
      </footer>
    </div>
  );
}
