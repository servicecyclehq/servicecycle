// ─────────────────────────────────────────────────────────────────────────────
// AddData.jsx — gem W2: one "drop anything" door. The user shouldn't have to
// know our parser taxonomy (asset CSV vs CMMS export vs test-report PDF). Drop
// a file; we sniff it and route to the right importer, carrying the file so
// they don't re-pick it.
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { UploadCloud, FileText, Table2, Database, Mail } from 'lucide-react';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { setPendingImport } from '../lib/pendingImport';

function sniff(file) {
  const name = (file.name || '').toLowerCase();
  if (name.endsWith('.pdf')) return { kind: 'test-report', route: '/test-reports/import', label: 'test-report PDF' };
  if (/\.(csv|xlsx|xls)$/.test(name)) return { kind: 'assets', route: '/assets/import', label: 'asset / schedule spreadsheet' };
  return null;
}

export default function AddData() {
  useDocumentTitle('Add data');
  const navigate = useNavigate();
  const [err, setErr] = useState('');

  function onFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const s = sniff(file);
    if (!s) { setErr(`Not sure how to read "${file.name}". Use a PDF test report, or a CSV/XLSX spreadsheet.`); return; }
    setPendingImport(file);
    navigate(s.route);
  }

  return (
    <div className="page-container">
      <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <UploadCloud size={22} strokeWidth={1.75} /> Add data
      </h1>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 20px', maxWidth: 720, lineHeight: 1.6 }}>
        Drop whatever you have — we'll figure out what it is. A contractor's test-report PDF, an asset
        spreadsheet, a CMMS export. No need to know which importer it belongs to.
      </p>

      {err && <div style={{ padding: '12px 16px', background: '#fff1f1', border: '1px solid #fecaca', borderRadius: 8, color: '#b91c1c', marginBottom: 16 }}>{err}</div>}

      <div className="card"><div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
        <UploadCloud size={40} strokeWidth={1.25} style={{ color: 'var(--color-text-secondary)', marginBottom: 12 }} />
        <div style={{ fontWeight: 600, marginBottom: 8 }}>Drop a file or choose one</div>
        <input type="file" accept=".pdf,.csv,.xlsx,.xls" onChange={onFile} />
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 10 }}>
          PDF test report · asset CSV/XLSX
        </div>
      </div></div>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
        <Link to="/test-reports/import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><FileText size={16} /> Test report (PDF)</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>PowerDB / Megger / NETA → fix list</div>
        </Link>
        <Link to="/assets/import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Table2 size={16} /> Assets (CSV/XLSX)</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Bulk import equipment + schedules</div>
        </Link>
        <Link to="/import" className="card" style={{ flex: '1 1 200px', padding: 16, textDecoration: 'none', color: 'inherit' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Database size={16} /> CMMS export</div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Maximo / SAP PM / Oracle EAM</div>
        </Link>
        <div className="card" style={{ flex: '1 1 200px', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}><Mail size={16} /> Email-in <span style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 700, color: 'var(--color-success)', border: '1px solid var(--color-success)', borderRadius: 4, padding: '1px 5px' }}>LIVE</span></div>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>Forward a test report to your account's <code>reports-…@servicecycle.app</code> address — it parses every line and creates the asset cards automatically. No upload step.</div>
        </div>
      </div>
    </div>
  );
}
