// PublicArcFlashLabel.jsx — public QR/NFC arc-flash label portal (/l/:token).
// Scanning the sticker resolves here (no login) and shows the LIVE record, plus a
// banner if the printed label no longer matches the current study. The token is
// the credential; the data is the same label posted physically on the equipment.
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

function fmtDate(d) { try { return d ? new Date(d).toLocaleDateString() : '—'; } catch { return '—'; } }
function sevColor(s) { return s === 'danger' ? '#b91c1c' : '#c2410c'; }
const FIELD_LABEL = {
  nominalVoltage: 'Nominal voltage', incidentEnergyCalCm2: 'Incident energy', arcFlashBoundaryIn: 'Arc-flash boundary',
  workingDistanceIn: 'Working distance', ppeCategory: 'PPE category', requiredArcRatingCalCm2: 'Required arc rating', labelSeverity: 'Severity',
};
function fmtVal(field, v) {
  if (v == null || v === '') return '—';
  if (field === 'incidentEnergyCalCm2' || field === 'requiredArcRatingCalCm2') return `${v} cal/cm²`;
  if (field === 'arcFlashBoundaryIn' || field === 'workingDistanceIn') return `${v} in`;
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

  const wrap = { maxWidth: 460, margin: '0 auto', padding: '20px 16px', fontFamily: 'system-ui, sans-serif' };

  if (state === 'loading') return <div style={wrap}>Loading label…</div>;
  if (state === 'notfound') return <div style={wrap}><h1 style={{ fontSize: '1.2rem' }}>Label not found</h1><p>This arc-flash label is no longer available. Check with the facility for a current label.</p></div>;
  if (state === 'error') return <div style={wrap}><h1 style={{ fontSize: '1.2rem' }}>Something went wrong</h1><p>Could not load this label. Please try again.</p></div>;

  const l = data?.label || {};
  const sev = l.labelSeverity;
  const mm = data?.mismatch;

  return (
    <div style={wrap}>
      <div style={{ textAlign: 'center', marginBottom: 14 }}>
        <div style={{ fontSize: '0.74rem', letterSpacing: '0.08em', color: '#6b7280', textTransform: 'uppercase' }}>Arc Flash Label · live record</div>
        <h1 style={{ fontSize: '1.4rem', margin: '4px 0 0' }}>{data?.busName || 'Bus'}</h1>
        <div style={{ color: '#6b7280', fontSize: '0.86rem' }}>{[data?.site, data?.equipmentType].filter(Boolean).join(' · ') || ''}</div>
      </div>

      {sev && (
        <div style={{ textAlign: 'center', marginBottom: 14 }}>
          <span style={{ fontSize: '0.9rem', fontWeight: 800, color: '#fff', background: sevColor(sev), padding: '6px 16px', borderRadius: 6, letterSpacing: '0.05em' }}>
            {sev === 'danger' ? 'DANGER' : 'WARNING'}
          </span>
        </div>
      )}

      {mm?.isMismatch && (
        <div style={{ border: '2px solid #b91c1c', background: '#fef2f2', borderRadius: 8, padding: '10px 12px', marginBottom: 14, fontSize: '0.86rem' }}>
          <strong style={{ color: '#b91c1c' }}>⚠ Printed label out of date</strong>
          <div style={{ marginTop: 4, color: '#7f1d1d' }}>The current study differs from the printed sticker — reprint. Changed: {mm.changes.map(c => c.label).join(', ')}.</div>
        </div>
      )}

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, overflow: 'hidden' }}>
        {Object.keys(FIELD_LABEL).map((f, i) => (
          <div key={f} style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 12px', background: i % 2 ? '#fafafa' : '#fff', fontSize: '0.9rem' }}>
            <span style={{ color: '#6b7280' }}>{FIELD_LABEL[f]}</span>
            <strong>{fmtVal(f, l[f])}</strong>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, fontSize: '0.82rem', color: '#374151' }}>
        <div>Study date: <strong>{fmtDate(data?.study?.performedDate)}</strong>{data?.study?.expiresAt ? <> · expires {fmtDate(data.study.expiresAt)}</> : null}</div>
        {data?.study?.peName && <div>Engineer: <strong>{data.study.peName}</strong></div>}
        {data?.study?.superseded && <div style={{ color: '#b45309' }}>A newer study supersedes this one.</div>}
        {data?.printedAt && <div style={{ color: '#6b7280' }}>Label last printed {fmtDate(data.printedAt)}.</div>}
      </div>

      <p style={{ marginTop: 16, fontSize: '0.74rem', color: '#9ca3af', textAlign: 'center' }}>
        ServiceCycle is the data layer; a licensed PE runs and stamps the study. Always follow the equipment's physical label and your site's electrical safety program.
      </p>
    </div>
  );
}
