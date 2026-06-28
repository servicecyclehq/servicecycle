// ─────────────────────────────────────────────────────────────────────────────
// DocumentsLibrary.jsx — account-wide searchable document library.
//
// One component, two uses:
//   • Top-nav page  → <DocumentsLibrary />                (full chrome + site filter)
//   • Site tab      → <DocumentsLibrary siteId={id} embedded />  (locked to a site)
//
// Lists customer-UPLOADED documents only (the platform never generates them).
// Every open/download passes through the shared accuracy-acknowledgment gate.
// Data: GET /api/documents?q=&docType=&siteId=  (asset->site joined server-side).
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from 'react';
import api from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { DOWNLOAD_DISCLAIMER } from '../lib/documentDisclaimer';
import ProvenanceBadge from '../components/ProvenanceBadge';

const DOC_TYPES = [
  { value: '', label: 'All types' },
  { value: 'wiring_diagram', label: 'One-line / wiring diagram' },
  { value: 'oem_manual', label: 'OEM manual' },
  { value: 'test_report', label: 'Test report' },
  { value: 'inspection_report', label: 'Inspection report' },
  { value: 'commissioning_report', label: 'Commissioning report' },
  { value: 'loto_pdf', label: 'LOTO procedure' },
  { value: 'warranty', label: 'Warranty / contract' },
  { value: 'other', label: 'Other' },
];
const TYPE_LABEL = Object.fromEntries(DOC_TYPES.filter((t) => t.value).map((t) => [t.value, t.label]));

function fmtDate(d) {
  if (!d) return '';
  try { return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); }
  catch { return ''; }
}

const S = {
  card: { background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 16 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-ui)' },
  th: { padding: '8px 10px', borderBottom: '2px solid var(--color-border)', color: 'var(--color-text)', fontWeight: 600, textAlign: 'left', whiteSpace: 'nowrap' },
  cell: { padding: '8px 10px', borderBottom: '1px solid var(--color-border)', color: 'var(--color-text-secondary)', verticalAlign: 'top' },
  input: { padding: '7px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius, 8px)', background: 'var(--color-surface)', color: 'var(--color-text)', fontSize: 'var(--font-size-ui)' },
};

export default function DocumentsLibrary({ siteId = null, embedded = false }) {
  const confirm = useConfirm();
  const [docs, setDocs] = useState([]);
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [busyId, setBusyId] = useState(null);

  // Site dropdown (only for the standalone page, not when locked to one site)
  useEffect(() => {
    if (embedded || siteId) return;
    api.get('/api/sites').then((r) => setSites(r.data?.data || r.data || [])).catch(() => {});
  }, [embedded, siteId]);

  // Fetch (debounced on the search box)
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setLoading(true); setErr('');
      try {
        const params = {};
        const sid = siteId || siteFilter;
        if (sid) params.siteId = sid;
        if (typeFilter) params.docType = typeFilter;
        if (q.trim()) params.q = q.trim();
        const r = await api.get('/api/documents', { params });
        if (!cancelled) setDocs(r.data?.data || []);
      } catch (e) {
        if (!cancelled) setErr(e.response?.data?.error || 'Could not load documents right now.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);
    return () => { cancelled = true; clearTimeout(t); };
  }, [q, siteFilter, typeFilter, siteId]);

  async function open(doc) {
    if (!await confirm({ title: 'Before you download', message: DOWNLOAD_DISCLAIMER, confirmLabel: 'Acknowledge & Download' })) return;
    setBusyId(doc.id);
    setErr('');
    try {
      if (doc.external) {
        if (doc.externalUrl) window.open(doc.externalUrl, '_blank', 'noopener');
        else setErr('That link is unavailable.');
      } else {
        const { data } = await api.get(`/api/documents/${doc.id}/url`);
        const href = data.data?.url || data.data?.apiPath;
        if (href) window.open(href, '_blank', 'noopener');
        else setErr('Could not open that document right now.');
      }
    } catch (e) {
      setErr(e.response?.data?.error || 'Could not open that document. Please try again.');
    } finally { setBusyId(null); }
  }

  const filterBar = (
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by file name…"
        style={{ ...S.input, flex: '1 1 240px', minWidth: 180 }}
        aria-label="Search documents by file name"
      />
      {!embedded && !siteId && (
        <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} style={{ ...S.input, minWidth: 160 }} aria-label="Filter by site">
          <option value="">All sites</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      )}
      <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ ...S.input, minWidth: 180 }} aria-label="Filter by document type">
        {DOC_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
    </div>
  );

  const table = (
    <div style={{ overflowX: 'auto' }}>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Document</th>
            <th style={S.th}>Type</th>
            <th style={S.th}>Trust</th>
            <th style={S.th}>Asset</th>
            {!siteId && <th style={S.th}>Site</th>}
            <th style={S.th}>Uploaded</th>
            <th style={{ ...S.th, textAlign: 'right' }}>{''}</th>
          </tr>
        </thead>
        <tbody>
          {docs.length === 0 ? (
            <tr><td style={{ ...S.cell, textAlign: 'center', color: 'var(--color-text-muted)' }} colSpan={siteId ? 6 : 7}>
              {loading ? 'Loading…' : 'No documents match.'}
            </td></tr>
          ) : docs.map((d) => (
            <tr key={d.id}>
              <td style={{ ...S.cell, color: 'var(--color-text)', fontWeight: 600, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {d.filename}{d.external && <span style={{ marginLeft: 6, fontWeight: 400, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>(link)</span>}
              </td>
              <td style={S.cell}>{TYPE_LABEL[d.docType] || 'Unclassified'}</td>
              <td style={S.cell}><ProvenanceBadge value={d.provenance} /></td>
              <td style={S.cell}>{d.asset?.name || '—'}</td>
              {!siteId && <td style={S.cell}>{d.site?.name || '—'}</td>}
              <td style={{ ...S.cell, whiteSpace: 'nowrap' }}>{fmtDate(d.uploadedAt)}</td>
              <td style={{ ...S.cell, textAlign: 'right' }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => open(d)} disabled={busyId === d.id}>
                  {busyId === d.id ? '…' : d.external ? 'Open' : 'Download'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  if (embedded) {
    return (
      <div>
        {filterBar}
        {err && <div style={{ color: 'var(--color-danger)', marginBottom: 10, fontSize: 'var(--font-size-ui)' }}>{err}</div>}
        {table}
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--color-text)' }}>Documents</h1>
      <p style={{ margin: '0 0 18px', fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', maxWidth: 720 }}>
        Search and download documents uploaded for your equipment — one-lines, manuals, test reports, LOTO procedures.
        ServiceCycle stores these; it does not author or verify them.
      </p>
      <div style={S.card}>
        {filterBar}
        {err && <div style={{ color: 'var(--color-danger)', marginBottom: 10, fontSize: 'var(--font-size-ui)' }}>{err}</div>}
        {table}
      </div>
    </div>
  );
}
