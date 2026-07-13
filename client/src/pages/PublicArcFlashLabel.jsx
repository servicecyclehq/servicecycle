// PublicArcFlashLabel.jsx — public QR/NFC arc-flash label portal (/l/:token).
// Scanning the sticker resolves here (no login) and shows the LIVE record, plus a
// banner if the printed label no longer matches the current study. The token is
// the credential; the data is the same label posted physically on the equipment.
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

// [UX-8-12] Fixed, locale-INDEPENDENT date format (DD Mon YYYY). A buyer scanning
// a sticker on any device/locale sees the same unambiguous date — never M/D vs D/M.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return `${String(dt.getUTCDate()).padStart(2, '0')} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
}
function sevColor(s) { return s === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)'; }

// [NETA-8-2] Shock approach boundaries (NFPA 70E §130.5(H)) are now part of the
// label payload (server derives them from Table 130.4 when not on file), so the
// QR portal carries the same mandatory fields as the printed PDF.
const FIELD_LABEL = {
  nominalVoltage: 'Nominal voltage', incidentEnergyCalCm2: 'Incident energy', arcFlashBoundaryIn: 'Arc-flash boundary',
  workingDistanceIn: 'Working distance', ppeCategory: 'PPE category', requiredArcRatingCalCm2: 'Required arc rating',
  shockLimitedApproachIn: 'Limited approach boundary', shockRestrictedApproachIn: 'Restricted approach boundary',
  labelSeverity: 'Severity',
};
function fmtVal(field, v, label) {
  if (v == null || v === '') {
    // Restricted approach has no distance in the 50–150 V band ("avoid contact").
    // Only say so when a limited boundary IS present (i.e. the voltage is in-table);
    // otherwise the value is genuinely unknown -> defer to the study.
    if (field === 'shockRestrictedApproachIn') {
      return (label && label.shockLimitedApproachIn != null) ? 'Avoid contact (≤150 V)' : 'See study';
    }
    return '—';
  }
  if (field === 'incidentEnergyCalCm2' || field === 'requiredArcRatingCalCm2') return `${v} cal/cm²`;
  if (field === 'arcFlashBoundaryIn' || field === 'workingDistanceIn'
    || field === 'shockLimitedApproachIn' || field === 'shockRestrictedApproachIn') return `${v} in`;
  if (field === 'ppeCategory') return `Cat ${v}`;
  if (field === 'labelSeverity') return String(v).toUpperCase();
  return String(v);
}

export default function PublicArcFlashLabel() {
  useDocumentTitle('Arc Flash Label');
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [state, setState] = useState('loading'); // loading | ok | notfound | error

  useEffect(() => {
    let live = true;
    fetch(`/api/public/arc-flash-label/${encodeURIComponent(token)}`)
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(j => { if (live) { setData(j.data || null); setState('ok'); } })
      .catch(err => { if (live) setState(err === 404 ? 'notfound' : 'error'); });
    return () => { live = false; };
  }, [token]);

  // [UX-8-4] Use the app's design tokens (petrol/ink palette, surface, borders)
  // so a scanned sticker reads on-brand and inherits dark mode where set. Kept
  // standalone + printable (no app chrome).
  const wrap = {
    maxWidth: 460, margin: '0 auto', padding: '20px 16px',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: 'var(--color-text)',
  };

  if (state === 'loading') return (
    <div style={{ ...wrap, textAlign: 'center', paddingTop: 48 }} role="status" aria-live="polite">
      <span aria-hidden="true" style={{
        display: 'inline-block', width: 22, height: 22,
        border: '2.5px solid var(--color-border)', borderTopColor: 'var(--color-primary)',
        borderRadius: '50%', animation: 'spin 0.9s linear infinite',
      }} />
      <div style={{ marginTop: 12, fontSize: '0.86rem', color: 'var(--color-text-secondary)' }}>Loading label…</div>
    </div>
  );
  if (state === 'notfound') return <div style={wrap}><h1 style={{ fontSize: '1.2rem' }}>Label not found</h1><p style={{ color: 'var(--color-text-secondary)' }}>This arc-flash label is no longer available. Check with the facility for a current label.</p></div>;
  if (state === 'error') return <div style={wrap}><h1 style={{ fontSize: '1.2rem' }}>Something went wrong</h1><p style={{ color: 'var(--color-text-secondary)' }}>Could not load this label. Please try again.</p></div>;

  const l = data?.label || {};
  const sev = l.labelSeverity;
  const mm = data?.mismatch;

  return (
    <div style={wrap} className="print-doc">
      {/* C2c: print masthead/footer treatment for the portal's own chrome ONLY
          (title block + page footer). The label content below -- severity
          banner, mismatch banner, field grid -- mirrors the regulatory label
          and is deliberately untouched (ANSI-aligned severity colors). */}
      <header className="print-masthead print-only">
        <h1 className="print-masthead-title">Arc Flash Label</h1>
        <div className="print-masthead-meta">
          {data?.busName || 'Bus'}<br />
          {[data?.site, data?.equipmentType].filter(Boolean).join(' · ') || 'Live record'}
        </div>
      </header>
      <div className="print-rule print-only"></div>

      <div className="no-print" style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: '0.74rem', letterSpacing: '0.08em', color: 'var(--color-text-secondary)', textTransform: 'uppercase' }}>Arc Flash Label · live record</div>
        <h1 style={{ fontSize: '1.4rem', margin: '4px 0 0', color: 'var(--color-text)' }}>{data?.busName || 'Bus'}</h1>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.86rem' }}>{[data?.site, data?.equipmentType].filter(Boolean).join(' · ') || ''}</div>
      </div>

      {sev && (
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 800, color: '#fff', background: sevColor(sev), padding: '6px 16px', borderRadius: 'var(--radius, 6px)', letterSpacing: '0.05em' }}>
            {sev === 'danger' ? 'DANGER' : 'WARNING'}
          </span>
        </div>
      )}

      {mm?.isMismatch && (
        <div style={{ border: '2px solid var(--color-danger)', background: 'var(--color-danger-bg)', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: '0.86rem' }}>
          <strong style={{ color: 'var(--color-danger)' }}>⚠ Printed label out of date</strong>
          <div style={{ marginTop: 4, color: 'var(--color-danger)' }}>The current study differs from the printed sticker — reprint. Changed: {mm.changes.map(c => c.label).join(', ')}.</div>
        </div>
      )}

      <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius-lg, 10px)', overflow: 'hidden', background: 'var(--color-surface)' }}>
        {Object.keys(FIELD_LABEL).map((f, i) => (
          <div key={f} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 12px', background: i % 2 ? 'var(--color-bg)' : 'var(--color-surface)', fontSize: '0.9rem' }}>
            <span style={{ color: 'var(--color-text-secondary)' }}>{FIELD_LABEL[f]}</span>
            <strong style={{ color: 'var(--color-text)', textAlign: 'right' }}>{fmtVal(f, l[f], l)}</strong>
          </div>
        ))}
      </div>

      <p style={{ marginTop: 8, fontSize: '0.72rem', color: 'var(--color-text-muted)' }}>
        Shock approach boundaries follow NFPA 70E Table 130.4 where not separately recorded in the study; verify against the stamped study.
      </p>

      <div style={{ marginTop: 14, fontSize: '0.82rem', color: 'var(--color-text-secondary)' }}>
        <div>Study date: <strong style={{ color: 'var(--color-text)' }}>{fmtDate(data?.study?.performedDate)}</strong>{data?.study?.expiresAt ? <> · expires {fmtDate(data.study.expiresAt)}</> : null}</div>
        {data?.study?.peName && <div>Engineer: <strong style={{ color: 'var(--color-text)' }}>{data.study.peName}</strong></div>}
        {data?.study?.superseded && <div style={{ color: 'var(--color-warning)' }}>A newer study supersedes this one.</div>}
        {data?.printedAt && <div style={{ color: 'var(--color-text-muted)' }}>Label last printed {fmtDate(data.printedAt)}.</div>}
      </div>

      <p style={{ marginTop: 16, fontSize: '0.74rem', color: 'var(--color-text-muted)', textAlign: 'center' }}>
        ServiceCycle is the data layer; a licensed PE runs and stamps the study. Always follow the equipment's physical label and your site's electrical safety program.
      </p>

      <footer className="print-footer print-only">
        <span>ServiceCycle</span>
        <span className="print-footer-pages">Live record · {fmtDate(new Date())}</span>
      </footer>
    </div>
  );
}
