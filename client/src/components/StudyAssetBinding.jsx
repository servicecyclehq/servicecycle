import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';

// #25 client: bind assets/buses to an arc-flash (or coordination) SystemStudy
// with the NFPA 70E 130.5(H) incident-energy label fields, show per-label
// completeness, and print the equipment warning labels. Server seams:
//   GET    /api/sites/studies/:id/label-data
//   POST   /api/sites/studies/:id/assets
//   DELETE /api/sites/studies/:id/assets/:assetId

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function methodLine(l) {
  if (l.incidentEnergyCalCm2 != null && l.workingDistanceIn != null) {
    return l.incidentEnergyCalCm2 + ' cal/cm2 at ' + l.workingDistanceIn + ' in working distance';
  }
  if (l.ppeCategory != null) return 'Arc-rated PPE Category ' + l.ppeCategory;
  return 'Incident energy not on file';
}

const EMPTY = {
  assetId: '', busName: '', nominalVoltage: '', incidentEnergyCalCm2: '',
  arcFlashBoundaryIn: '', workingDistanceIn: '', ppeCategory: '', includeDownstream: false,
  // IEEE 1584-2018 inputs (optional)
  boltedFaultCurrentKA: '', arcingCurrentKA: '', electrodeConfig: '',
  conductorGapMm: '', clearingTimeMs: '', upstreamDevice: '',
};

const inputStyle = {
  padding: '0.4rem 0.5rem', fontSize: '0.8rem', borderRadius: 6,
  border: '1px solid var(--color-border)', background: 'var(--color-surface)', color: 'var(--color-text)', width: '100%',
};

export default function StudyAssetBinding({ study, siteAssets = [], canWrite = false, onCoverageChange }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(() => {
    setLoading(true);
    return api.get('/api/sites/studies/' + study.id + '/label-data')
      .then(r => { setData(r.data?.data || null); setErr(null); })
      .catch(() => setErr('Could not load label coverage.'))
      .finally(() => setLoading(false));
  }, [study.id]);

  useEffect(() => { load(); }, [load]);

  const labels = data?.labels || [];
  const boundIds = new Set(labels.map(l => l.assetId));
  const available = siteAssets.filter(a => !boundIds.has(a.id));

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function bind(e) {
    e.preventDefault();
    if (!form.assetId) { setErr('Pick an asset to bind.'); return; }
    setSaving(true); setErr(null);
    try {
      const body = {
        assetId: form.assetId,
        busName: form.busName || undefined,
        nominalVoltage: form.nominalVoltage || undefined,
        incidentEnergyCalCm2: form.incidentEnergyCalCm2 === '' ? undefined : form.incidentEnergyCalCm2,
        arcFlashBoundaryIn: form.arcFlashBoundaryIn === '' ? undefined : form.arcFlashBoundaryIn,
        workingDistanceIn: form.workingDistanceIn === '' ? undefined : form.workingDistanceIn,
        ppeCategory: form.ppeCategory === '' ? undefined : form.ppeCategory,
        includeDownstream: form.includeDownstream,
        // IEEE 1584 inputs
        boltedFaultCurrentKA: form.boltedFaultCurrentKA === '' ? undefined : form.boltedFaultCurrentKA,
        arcingCurrentKA: form.arcingCurrentKA === '' ? undefined : form.arcingCurrentKA,
        electrodeConfig: form.electrodeConfig || undefined,
        conductorGapMm: form.conductorGapMm === '' ? undefined : form.conductorGapMm,
        clearingTimeMs: form.clearingTimeMs === '' ? undefined : form.clearingTimeMs,
        upstreamDevice: form.upstreamDevice || undefined,
      };
      const r = await api.post('/api/sites/studies/' + study.id + '/assets', body);
      setForm(EMPTY);
      await load();
      if (onCoverageChange) onCoverageChange(r.data?.data?.coveredCount);
    } catch (e2) {
      setErr(e2?.response?.data?.error || 'Failed to bind asset.');
    } finally { setSaving(false); }
  }

  async function unbind(assetId, label) {
    if (!window.confirm('Remove "' + label + '" from this study?')) return;
    setErr(null);
    try {
      const r = await api.delete('/api/sites/studies/' + study.id + '/assets/' + assetId);
      await load();
      if (onCoverageChange) onCoverageChange(r.data?.data?.coveredCount);
    } catch { setErr('Failed to remove asset.'); }
  }

  function printLabels() {
    if (!data || labels.length === 0) { window.alert('No assets are bound to this study yet.'); return; }
    const s = data.study;
    const dateStr = s.performedDate ? new Date(s.performedDate).toLocaleDateString() : '';
    const provparts = [dateStr ? 'Study ' + dateStr : '', s.peName ? esc(s.peName) + (s.peLicense ? ' (Lic. ' + esc(s.peLicense) + ')' : '') : '', s.method ? esc(s.method) : ''].filter(Boolean);
    const prov = provparts.join(' &middot; ');
    const cards = labels.map((l) => {
      const isDanger = l.hazardClass === 'DANGER';
      return (
      '<div class="lbl' + (isDanger ? ' dgr' : '') + (l.labelComplete ? '' : ' inc') + '">' +
        '<div class="hd">' + (isDanger ? 'DANGER' : 'WARNING') + '</div>' +
        '<div class="sub">Arc Flash &amp; Shock Hazard &middot; Appropriate PPE Required</div>' +
        '<div class="rows">' +
          '<div class="eq">' + esc(l.busName || l.assetLabel) + '</div>' +
          '<div><span>Nominal voltage</span><b>' + esc(l.nominalVoltage || 'N/A') + '</b></div>' +
          '<div><span>Arc flash boundary</span><b>' + (l.arcFlashBoundaryIn != null ? esc(l.arcFlashBoundaryIn) + ' in' : 'N/A') + '</b></div>' +
          '<div class="m">' + esc(methodLine(l)) + '</div>' +
        '</div>' +
        '<div class="ft">' + prov + '</div>' +
        (l.labelComplete ? '' : '<div class="warn">INCOMPLETE - missing required NFPA 70E label fields</div>') +
      '</div>'
      );
    }).join('');
    const html =
      '<!doctype html><html><head><meta charset="utf-8"><title>Arc-flash labels - ' + esc(s.siteName || '') + '</title>' +
      '<style>' +
      'body{font-family:Arial,Helvetica,sans-serif;margin:18px;color:#111}' +
      'h1{font-size:16px;margin:0 0 12px}' +
      '.grid{display:flex;flex-wrap:wrap;gap:12px}' +
      '.lbl{width:300px;border:2px solid #c2410c;border-radius:6px;overflow:hidden;page-break-inside:avoid}' +
      '.lbl.inc{border-color:#b91c1c}' +
      '.hd{background:#ea580c;color:#fff;font-weight:800;font-size:20px;text-align:center;letter-spacing:.06em;padding:6px}' +
      '.lbl.inc .hd{background:#b91c1c}' +
      '.lbl.dgr{border-color:#b91c1c}' +
      '.lbl.dgr .hd{background:#b91c1c}' +
      '.sub{background:#fff7ed;color:#7c2d12;font-size:11px;text-align:center;padding:4px;border-bottom:1px solid #fed7aa}' +
      '.rows{padding:8px 10px;font-size:12px}' +
      '.rows .eq{font-weight:700;font-size:13px;margin-bottom:4px}' +
      '.rows div{display:flex;justify-content:space-between;margin:2px 0}' +
      '.rows .m{display:block;color:#7c2d12;font-weight:600;margin-top:4px}' +
      '.ft{font-size:10px;color:#555;padding:6px 10px;border-top:1px solid #eee}' +
      '.warn{background:#fef2f2;color:#991b1b;font-size:10px;font-weight:700;text-align:center;padding:4px}' +
      '@media print{body{margin:6px}}' +
      '</style></head><body onload="window.print()">' +
      '<h1>Arc-flash warning labels - ' + esc(s.siteName || '') + ' (' + labels.length + ')</h1>' +
      '<div class="grid">' + cards + '</div></body></html>';
    const w = window.open('', '_blank');
    if (!w) { window.alert('Allow pop-ups to print the labels.'); return; }
    w.document.write(html);
    w.document.close();
  }

  return (
    <div style={{ background: 'var(--color-bg-subtle, #f8fafc)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        <div style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
          {loading ? 'Loading coverage...' : (
            <>
              <strong style={{ color: 'var(--color-text)' }}>{data?.coveredCount || 0}</strong> asset{(data?.coveredCount || 0) === 1 ? '' : 's'} covered
              {' '}&middot;{' '}
              <strong style={{ color: (data?.completeCount || 0) === (data?.coveredCount || 0) ? 'var(--color-success)' : 'var(--color-warning)' }}>{data?.completeCount || 0}</strong> label-ready (NFPA 70E 130.5(H))
            </>
          )}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={printLabels} disabled={loading || labels.length === 0}>
          Print labels
        </button>
      </div>

      {err && <div style={{ fontSize: '0.78rem', color: 'var(--color-danger)', marginBottom: 8 }}>{err}</div>}

      {labels.length > 0 && (
        <table className="data-table" style={{ width: '100%', fontSize: '0.78rem', marginBottom: canWrite ? 12 : 0 }}>
          <thead>
            <tr>
              <th>Equipment / bus</th><th>Voltage</th><th>AFB</th><th>IE / PPE</th><th>Label</th>
              {canWrite && <th></th>}
            </tr>
          </thead>
          <tbody>
            {labels.map(l => (
              <tr key={l.assetId}>
                <td>{l.busName || l.assetLabel}{l.hazardClass === 'DANGER' && <span style={{ marginLeft: 6, fontSize: '0.62rem', fontWeight: 700, color: '#fff', background: 'var(--color-danger, #b91c1c)', padding: '1px 5px', borderRadius: 4 }}>DANGER</span>}</td>
                <td>{l.nominalVoltage || '-'}</td>
                <td>{l.arcFlashBoundaryIn != null ? l.arcFlashBoundaryIn + ' in' : '-'}</td>
                <td>{l.incidentEnergyCalCm2 != null && l.workingDistanceIn != null
                  ? `${l.incidentEnergyCalCm2} cal @ ${l.workingDistanceIn}"`
                  : (l.ppeCategory != null ? `PPE ${l.ppeCategory}` : '-')}</td>
                <td>
                  <span style={{ fontWeight: 600, color: l.labelComplete ? 'var(--color-success)' : 'var(--color-warning)' }}>
                    {l.labelComplete ? 'Complete' : 'Incomplete'}
                  </span>
                </td>
                {canWrite && (
                  <td style={{ textAlign: 'right' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => unbind(l.assetId, l.busName || l.assetLabel)}>Remove</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canWrite && (
        <form onSubmit={bind} style={{ borderTop: labels.length ? '1px solid var(--color-border)' : 'none', paddingTop: labels.length ? 10 : 0 }}>
          <div style={{ fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>Bind an asset / bus</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 8 }}>
            <select value={form.assetId} onChange={e => set('assetId', e.target.value)} style={inputStyle}>
              <option value="">Select asset...</option>
              {available.map(a => <option key={a.id} value={a.id}>{a.serialNumber ? a.serialNumber + ' - ' : ''}{a.manufacturer || ''} {a.model || a.equipmentType}</option>)}
            </select>
            <input placeholder="Bus name (optional)" value={form.busName} onChange={e => set('busName', e.target.value)} style={inputStyle} />
            <input placeholder="Nominal voltage" value={form.nominalVoltage} onChange={e => set('nominalVoltage', e.target.value)} style={inputStyle} />
            <input placeholder="Arc flash boundary (in)" type="number" min="0" value={form.arcFlashBoundaryIn} onChange={e => set('arcFlashBoundaryIn', e.target.value)} style={inputStyle} />
            <input placeholder="Incident energy (cal/cm2)" type="number" min="0" value={form.incidentEnergyCalCm2} onChange={e => set('incidentEnergyCalCm2', e.target.value)} style={inputStyle} />
            <input placeholder="Working distance (in)" type="number" min="0" value={form.workingDistanceIn} onChange={e => set('workingDistanceIn', e.target.value)} style={inputStyle} />
            <select value={form.ppeCategory} onChange={e => set('ppeCategory', e.target.value)} style={inputStyle}>
              <option value="">PPE category (or use IE)</option>
              {['0', '1', '2', '3', '4'].map(p => <option key={p} value={p}>PPE {p}</option>)}
            </select>
          </div>
          <div style={{ fontSize: '0.72rem', fontWeight: 600, color: 'var(--color-text-secondary)', margin: '2px 0 6px' }}>
            Engineering inputs (IEEE 1584-2018, optional &mdash; powers trend &amp; what-if)
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 8, marginBottom: 8 }}>
            <input placeholder="Bolted fault current (kA)" type="number" min="0" step="any" value={form.boltedFaultCurrentKA} onChange={e => set('boltedFaultCurrentKA', e.target.value)} style={inputStyle} />
            <input placeholder="Arcing current (kA)" type="number" min="0" step="any" value={form.arcingCurrentKA} onChange={e => set('arcingCurrentKA', e.target.value)} style={inputStyle} />
            <select value={form.electrodeConfig} onChange={e => set('electrodeConfig', e.target.value)} style={inputStyle}>
              <option value="">Electrode config...</option>
              {['VCB', 'VCBB', 'HCB', 'VOA', 'HOA'].map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <input placeholder="Conductor gap (mm)" type="number" min="0" step="any" value={form.conductorGapMm} onChange={e => set('conductorGapMm', e.target.value)} style={inputStyle} />
            <input placeholder="Clearing time (ms)" type="number" min="0" step="any" value={form.clearingTimeMs} onChange={e => set('clearingTimeMs', e.target.value)} style={inputStyle} />
            <input placeholder="Upstream device" value={form.upstreamDevice} onChange={e => set('upstreamDevice', e.target.value)} style={inputStyle} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: 'var(--color-text-secondary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.includeDownstream} onChange={e => set('includeDownstream', e.target.checked)} />
              Also bind downstream-fed assets
            </label>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !form.assetId}>
              {saving ? 'Binding...' : 'Bind asset'}
            </button>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--color-text-secondary)', marginTop: 6 }}>
            A label is NFPA 70E 130.5(H) complete with nominal voltage, arc flash boundary, and either incident energy + working distance OR a PPE category.
          </div>
        </form>
      )}
    </div>
  );
}
