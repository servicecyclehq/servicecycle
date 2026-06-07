import ReportBackLink from '../components/ReportBackLink';
// ─────────────────────────────────────────────────────────────────────────────
// AuditEvidencePackReport.jsx — v0.59.0 Tier-3 risk/compliance report
//
// Composition report for SOC2 / SOX-curious prospects. Surfaces the evidence
// an auditor typically requests against the LapseIQ schema that exists today.
// Where a first-class field doesn't exist (e.g. DPA status, data classifica-
// tion) the report calls out the gap rather than hiding it — see the
// "Missing evidence" section.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, Download, FileSpreadsheet, FileText, FileCheck2 } from 'lucide-react';
import api from '../api/client';
import TruncationBanner from '../components/TruncationBanner';
import ReportAiNarrative from '../components/ReportAiNarrative';

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}
function fmtDate(v) {
  if (!v) return '—';
  return new Date(v).toISOString().split('T')[0];
}

function SectionCard({ title, count, children }) {
  return (
    <div className="card" style={{ padding: 0, marginBottom: 16, overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', background: 'var(--color-bg-subtle, #f1f5f9)', borderBottom: '1px solid var(--color-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ fontSize: 'var(--font-size-ui)', fontWeight: 700, color: 'var(--color-text)' }}>{title}</div>
        {count != null && (
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{count} row{count === 1 ? '' : 's'}</div>
        )}
      </div>
      {children}
    </div>
  );
}

export default function AuditEvidencePackReport() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get('/api/reports/audit-evidence-pack')
      .then(r => { if (!cancelled) { setData(r?.data?.data || null); setMeta(r?.data?.meta ?? null); } })
      .catch(err => { if (!cancelled) setError(err?.response?.data?.error || 'Failed to load report'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function downloadExport(format) {
    try {
      const res = await api.get(`/api/reports/audit-evidence-pack/${format}`, { responseType: 'blob' });
      const cd = res.headers['content-disposition'] || '';
      const m = cd.match(/filename="([^"]+)"/);
      const filename = m ? m[1] : `audit-evidence-pack.${format}`;
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      window.URL.revokeObjectURL(url);
    } catch (e) {
      setError('Export failed');
    }
  }

  return (
    <>
      <div className="page-header">
        <div>
          <ReportBackLink />
          <h1 className="page-title">Audit Evidence Pack</h1>
          <div className="page-subtitle">
            SOC2 / SOX-style evidence dump of active vendor relationships, contract
            inventory, override flags, and reachability of vendor contacts. Anything
            the schema can't yet attest to appears as a gap, not a silent omission.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-secondary" onClick={() => downloadExport('csv')}>
            <Download size={14} /> CSV
          </button>
          <button className="btn btn-secondary" onClick={() => downloadExport('xlsx')}>
            <FileSpreadsheet size={14} /> XLSX
          </button>
          <button className="btn btn-secondary" onClick={() => downloadExport('pdf')}>
            <FileText size={14} /> PDF
          </button>
        </div>
      </div>

      <div className="page-body">
        <TruncationBanner meta={meta} />
        <ReportAiNarrative reportId="audit-evidence-pack" paramsKey="_static" />

        {error && (
          <div className="card" style={{ padding: 16, marginBottom: 16, color: '#991b1b', background: '#fee2e2' }}>
            {error}
          </div>
        )}

        {/* KPI band */}
        <div className="card" style={{ padding: 0, marginBottom: 20, overflow: 'hidden' }}>
          <div style={{ height: 3, background: '#dc2626' }} />
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 0 }}>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Active Contracts</div>
              <div style={{ fontSize: 'var(--font-size-3xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{data?.activeCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>across {data?.vendorCount ?? 0} vendors</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#991b1b', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Past Cancel-By, Still Active</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: '#dc2626', lineHeight: 1 }}>{data?.pastCancelByCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>auto-renewed despite policy</div>
            </div>
            <div style={{ padding: 20, borderRight: '1px solid var(--color-border)' }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: '#92400e', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, fontWeight: 600 }}>Missing Signer</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-warning)', lineHeight: 1 }}>{data?.missingSignerCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>active contracts</div>
            </div>
            <div style={{ padding: 20 }}>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Missing End Date</div>
              <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: 'var(--color-text)', lineHeight: 1 }}>{data?.missingEndDateCount ?? 0}</div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 4 }}>active contracts</div>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            Loading evidence…
          </div>
        ) : !data ? (
          <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            <FileCheck2 size={28} style={{ marginBottom: 8, opacity: 0.6 }} />
            <div>No data.</div>
          </div>
        ) : (
          <>
            {/* Section 1 — Active contracts inventory */}
            <SectionCard title="Active contracts inventory" count={data.activeInventory?.length ?? 0}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Vendor</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Product</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Signer</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>End Date</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Auto-Renew</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Cancel By</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.activeInventory || []).slice(0, 200).map(r => (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)' }}>{r.vendorName || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)' }}>{r.product}</td>
                        <td style={{ padding: '8px 12px', color: r.signerName ? 'var(--color-text)' : '#92400e' }}>{r.signerName || 'missing'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)', fontFamily: 'monospace' }}>{fmtDate(r.endDate)}</td>
                        <td style={{ padding: '8px 12px', color: r.autoRenewal ? 'var(--color-warning)' : 'var(--color-text-secondary)' }}>{r.autoRenewal ? 'Yes' : 'No'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)', fontFamily: 'monospace' }}>{fmtDate(r.cancelByDate)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--color-text)', fontWeight: 600 }}>{fmtCurrency(r.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {data.activeInventory?.length > 200 && (
                  <div style={{ padding: '8px 12px', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    Showing first 200 rows on screen. Full inventory is in the CSV/XLSX/PDF export.
                  </div>
                )}
              </div>
            </SectionCard>

            {/* Section 2 — Sensitive-data flagged vendors */}
            <SectionCard title="Sensitive-data flagged vendors" count={data.sensitiveDataVendors?.length ?? 0}>
              <div style={{ padding: '8px 16px 0', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Heuristic: vendor category slug matches <code>saas</code>, <code>services</code>, or <code>cloud</code>.
                LapseIQ does not yet have a first-class <code>dataClassification</code> field — see Missing evidence below.
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Vendor</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Category Reason</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Active Contracts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.sensitiveDataVendors || []).map(v => (
                      <tr key={v.vendorId} style={{ borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => navigate(`/vendors/${v.vendorId}`)}>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)' }}>{v.vendorName}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{v.reason}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--color-text)' }}>{v.contractCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            {/* Section 3 — Past cancel-by, still active */}
            <SectionCard title="Past cancel-by — still active (auto-renewed)" count={data.pastCancelBy?.length ?? 0}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Vendor</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Product</th>
                      <th style={{ textAlign: 'left',  padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Cancel By</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Days Overdue</th>
                      <th style={{ textAlign: 'right', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.pastCancelBy || []).map(r => (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--color-border)', background: '#fef2f2', cursor: 'pointer' }} onClick={() => navigate(`/contracts/${r.id}`)}>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)' }}>{r.vendorName || '—'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)' }}>{r.product}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)', fontFamily: 'monospace' }}>{fmtDate(r.cancelByDate)}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: '#dc2626', fontWeight: 600 }}>{r.daysOverdue ?? '—'}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', color: 'var(--color-text)', fontWeight: 600 }}>{fmtCurrency(r.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.pastCancelBy?.length && (
                  <div style={{ padding: '12px 16px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>Clean. No active contracts have rolled past their cancel-by date.</div>
                )}
              </div>
            </SectionCard>

            {/* Section 4 — Vendor support contacts */}
            <SectionCard title="Vendor support contacts on file" count={data.supportContacts?.length ?? 0}>
              <div style={{ padding: '8px 16px 0', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Used by auditors to verify a vendor is reachable for breach notification, incident response, or
                contract dispute escalation.
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Vendor</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Email</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Phone</th>
                      <th style={{ textAlign: 'left', padding: '8px 12px', fontWeight: 600, fontSize: 'var(--font-size-2xs)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-secondary)' }}>Portal</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.supportContacts || []).map(v => (
                      <tr key={v.vendorId} style={{ borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }} onClick={() => navigate(`/vendors/${v.vendorId}`)}>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text)' }}>{v.vendorName}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{v.email || 'missing'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{v.phone || 'missing'}</td>
                        <td style={{ padding: '8px 12px', color: 'var(--color-text-secondary)' }}>{v.portalUrl ? 'on file' : 'missing'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>

            {/* Section 5 — Missing evidence callouts */}
            <SectionCard title="Missing evidence callouts" count={data.missingEvidence?.length ?? 0}>
              <div style={{ padding: '8px 16px 0', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                Auditors will ask for these even when LapseIQ doesn't track them as first-class fields. Filed here
                as gaps so the customer can answer the question explicitly rather than the report silently omitting it.
              </div>
              <ul style={{ listStyle: 'none', padding: '8px 16px 16px', margin: 0, fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>
                {(data.missingEvidence || []).map((m, i) => (
                  <li key={i} style={{ padding: '6px 0', borderTop: i === 0 ? 0 : '1px solid var(--color-border)' }}>
                    <strong style={{ color: 'var(--color-text)' }}>{m.field}:</strong>
                    <span style={{ color: 'var(--color-text-secondary)', marginLeft: 6 }}>{m.note}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </>
        )}
      </div>
    </>
  );
}
