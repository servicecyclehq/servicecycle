/**
 * DobleImportPage — thin page wrapper for the Doble (TestGuide/TDMS-style)
 * import panel. The panel itself (components/import/DobleImportPanel) owns the
 * upload -> preview -> commit flow; this wrapper just gives it a route
 * (/import/doble, admin/manager via App.jsx RequireRole) and a page frame
 * consistent with the other import screens.
 */
import { Link } from 'react-router-dom';
import DobleImportPanel from '../components/import/DobleImportPanel';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export default function DobleImportPage() {
  useDocumentTitle('Doble Import');
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Doble Import</h1>
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            Bring in Doble TestGuide / TDMS-style test exports (XML or CSV). Readings land in the
            same measurement pool as PowerDB and PDF imports, so trends and benchmarks see one
            unified history.
          </div>
        </div>
        <Link to="/add-data" style={{ fontSize: 'var(--font-size-xs)' }}>All import options</Link>
      </div>
      <DobleImportPanel />
    </div>
  );
}
