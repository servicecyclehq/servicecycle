// ─────────────────────────────────────────────────────────────────────────────
// NewAsset.jsx — create an equipment asset (ServiceCycle Assets v1).
//
// Site is required; the intermediate hierarchy levels (building → area →
// position) cascade from GET /api/sites/:id and can each be skipped — a
// single-room facility goes straight from site to asset. The three NFPA 70B
// condition axes default to C2 ("fair") per the server convention; the worst
// axis governs and is recomputed server-side.
//
// On create, offers POST /api/schedules/bulk-apply {assetId} so the asset
// picks up the global NFPA 70B task matrix for its equipment type in one
// click, then lands on /assets/:id.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import InfoTip from '../components/InfoTip';
import { EQUIPMENT_TYPE_LABELS, CONDITION_META } from '../lib/equipment';

const CONDITION_TIP =
  'NFPA 70B:2023 condition of maintenance. Each asset is rated C1 (good), ' +
  'C2 (fair), or C3 (poor) on three axes — physical condition, criticality, ' +
  'and operating environment. The WORST of the three governs and selects the ' +
  'maintenance interval for every task on this asset. Unassessed assets ' +
  'default to C2.';

export default function NewAsset() {
  useDocumentTitle('New Asset');
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [sites, setSites]         = useState([]);
  const [siteTree, setSiteTree]   = useState(null); // GET /api/sites/:id payload
  const [treeLoading, setTreeLoading] = useState(false);
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    siteId: '', buildingId: '', areaId: '', positionId: '',
    equipmentType: '',
    manufacturer: '', model: '', serialNumber: '',
    installDate: '', lastCommissionedDate: '',
    conditionPhysical: 'C2', conditionCriticality: 'C2', conditionEnvironment: 'C2',
    inService: true, isEnergized: true,
    notes: '',
  });
  // Nameplate data as ordered key/value pairs; collapsed to an object on save.
  const [nameplate, setNameplate] = useState([{ key: '', value: '' }]);

  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data.data?.sites || []))
      .catch(() => setError('Failed to load sites.'));
  }, []);

  // Cascade: fetching the hierarchy tree whenever the site changes, and
  // clearing the downstream selections so a stale building can't ride along.
  useEffect(() => {
    setSiteTree(null);
    setForm(p => ({ ...p, buildingId: '', areaId: '', positionId: '' }));
    if (!form.siteId) return;
    let cancelled = false;
    setTreeLoading(true);
    api.get(`/api/sites/${form.siteId}`)
      .then(r => { if (!cancelled) setSiteTree(r.data.data?.site || null); })
      .catch(() => { if (!cancelled) setSiteTree(null); })
      .finally(() => { if (!cancelled) setTreeLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.siteId]);

  // Options at each level. Skipping a level is always allowed: with no
  // building selected, the area list shows the site-direct areas; with no
  // area selected, the position list shows the site-direct positions.
  const buildingOptions = siteTree?.buildings || [];
  const selectedBuilding = buildingOptions.find(b => b.id === form.buildingId) || null;
  const areaOptions = form.buildingId
    ? (selectedBuilding?.areas || [])
    : (siteTree?.areas || []);
  const selectedArea = areaOptions.find(a => a.id === form.areaId) || null;
  const positionOptions = form.areaId
    ? (selectedArea?.positions || [])
    : (siteTree?.positions || []);

  function setNameplatePair(idx, field, value) {
    setNameplate(prev => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }
  function addNameplatePair() {
    setNameplate(prev => [...prev, { key: '', value: '' }]);
  }
  function removeNameplatePair(idx) {
    setNameplate(prev => prev.length === 1 ? [{ key: '', value: '' }] : prev.filter((_, i) => i !== idx));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.siteId)        { setError('Site is required.'); return; }
    if (!form.equipmentType) { setError('Equipment type is required.'); return; }

    const nameplateData = {};
    for (const { key, value } of nameplate) {
      const k = key.trim();
      if (k) nameplateData[k] = value;
    }

    setSaving(true); setError('');
    try {
      const body = {
        siteId:        form.siteId,
        buildingId:    form.buildingId || null,
        areaId:        form.areaId || null,
        positionId:    form.positionId || null,
        equipmentType: form.equipmentType,
        manufacturer:  form.manufacturer.trim() || null,
        model:         form.model.trim() || null,
        serialNumber:  form.serialNumber.trim() || null,
        installDate:          form.installDate || null,
        lastCommissionedDate: form.lastCommissionedDate || null,
        conditionPhysical:    form.conditionPhysical,
        conditionCriticality: form.conditionCriticality,
        conditionEnvironment: form.conditionEnvironment,
        inService:   form.inService,
        isEnergized: form.isEnergized,
        notes:       form.notes.trim() || null,
        ...(Object.keys(nameplateData).length > 0 ? { nameplateData } : {}),
      };
      const res = await api.post('/api/assets', body);
      const asset = res.data.data.asset;

      const applyTemplate = await confirm({
        title: 'Apply NFPA 70B schedule template?',
        message: 'This pairs the asset with every standard NFPA 70B maintenance task for its equipment type. You can add or remove individual schedules later. Re-running is safe — existing pairings are kept.',
        confirmLabel: 'Apply template',
        cancelLabel: 'Skip for now',
      });
      if (applyTemplate) {
        try {
          await api.post('/api/schedules/bulk-apply', { assetId: asset.id });
        } catch {
          // Non-fatal — the detail page has an "Apply schedule template" action.
        }
      }
      navigate(`/assets/${asset.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create asset.');
      setSaving(false);
    }
  }

  const conditionSelect = (field, label) => (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <select
        aria-label={label}
        className="form-control"
        value={form[field]}
        onChange={e => setF(field, e.target.value)}
      >
        {Object.entries(CONDITION_META).map(([k, m]) => (
          <option key={k} value={k}>{m.label}</option>
        ))}
      </select>
    </div>
  );

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/assets" className="back-link">← Assets</Link>
          <h1 className="page-title">New Asset</h1>
          <div className="page-subtitle">Register a piece of electrical equipment for maintenance tracking</div>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <form onSubmit={handleSubmit}>
          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Location</div></div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Site <span className="required">*</span></label>
                  <select
                    aria-label="Site"
                    className="form-control"
                    value={form.siteId}
                    onChange={e => setF('siteId', e.target.value)}
                    autoFocus
                  >
                    <option value="">— Select a site —</option>
                    {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  {sites.length === 0 && (
                    <div className="form-hint">No sites yet — create one under Sites first.</div>
                  )}
                </div>
                <div className="form-group">
                  <label className="form-label">Building</label>
                  <select
                    aria-label="Building"
                    className="form-control"
                    value={form.buildingId}
                    onChange={e => setForm(p => ({ ...p, buildingId: e.target.value, areaId: '', positionId: '' }))}
                    disabled={!form.siteId || treeLoading || buildingOptions.length === 0}
                  >
                    <option value="">{treeLoading ? 'Loading…' : '— None / skip —'}</option>
                    {buildingOptions.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Area</label>
                  <select
                    aria-label="Area"
                    className="form-control"
                    value={form.areaId}
                    onChange={e => setForm(p => ({ ...p, areaId: e.target.value, positionId: '' }))}
                    disabled={!form.siteId || treeLoading || areaOptions.length === 0}
                  >
                    <option value="">— None / skip —</option>
                    {areaOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Position</label>
                  <select
                    aria-label="Equipment position"
                    className="form-control"
                    value={form.positionId}
                    onChange={e => setF('positionId', e.target.value)}
                    disabled={!form.siteId || treeLoading || positionOptions.length === 0}
                  >
                    <option value="">— None / skip —</option>
                    {positionOptions.map(p => (
                      <option key={p.id} value={p.id}>{p.code ? `${p.code} — ${p.name}` : p.name}</option>
                    ))}
                  </select>
                  <div className="form-hint">Intermediate levels are optional — skip what your site doesn’t use.</div>
                </div>
              </div>
            </div>
          </div>

          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Equipment</div></div>
            <div className="card-body">
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Equipment Type <span className="required">*</span></label>
                  <select
                    aria-label="Equipment type"
                    className="form-control"
                    value={form.equipmentType}
                    onChange={e => setF('equipmentType', e.target.value)}
                  >
                    <option value="">— Select —</option>
                    {Object.entries(EQUIPMENT_TYPE_LABELS).map(([k, label]) => (
                      <option key={k} value={k}>{label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Manufacturer</label>
                  <input className="form-control" value={form.manufacturer} onChange={e => setF('manufacturer', e.target.value)} placeholder="e.g. Square D" />
                </div>
                <div className="form-group">
                  <label className="form-label">Model</label>
                  <input className="form-control" value={form.model} onChange={e => setF('model', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Serial Number</label>
                  <input className="form-control" value={form.serialNumber} onChange={e => setF('serialNumber', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Install Date</label>
                  <input type="date" className="form-control" aria-label="Install date" value={form.installDate} onChange={e => setF('installDate', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">Last Commissioned</label>
                  <input type="date" className="form-control" aria-label="Last commissioned date" value={form.lastCommissionedDate} onChange={e => setF('lastCommissionedDate', e.target.value)} />
                </div>
              </div>

              <div className="checkbox-group">
                <input
                  id="new-asset-in-service"
                  type="checkbox"
                  checked={form.inService}
                  onChange={e => setF('inService', e.target.checked)}
                />
                <label htmlFor="new-asset-in-service" className="checkbox-label">In service</label>
              </div>
              <div className="checkbox-group">
                <input
                  id="new-asset-energized"
                  type="checkbox"
                  checked={form.isEnergized}
                  onChange={e => setF('isEnergized', e.target.checked)}
                />
                <label htmlFor="new-asset-energized" className="checkbox-label">Energized</label>
              </div>
            </div>
          </div>

          <div className="card mb-16">
            <div className="card-header">
              <div className="card-title">
                Condition of Maintenance <InfoTip content={CONDITION_TIP} />
              </div>
            </div>
            <div className="card-body">
              <div className="form-row">
                {conditionSelect('conditionPhysical', 'Physical Condition')}
                {conditionSelect('conditionCriticality', 'Criticality')}
                {conditionSelect('conditionEnvironment', 'Environment')}
              </div>
              <div className="form-hint">
                The worst of the three axes governs the asset’s maintenance intervals (C3 wins over C2 over C1).
              </div>
            </div>
          </div>

          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Nameplate Data</div></div>
            <div className="card-body">
              <div className="form-hint" style={{ marginBottom: 10 }}>
                Free-form key/value pairs from the equipment nameplate — kVA, voltages, AIC rating, RPM…
              </div>
              {nameplate.map((pair, idx) => (
                <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <input
                    className="form-control"
                    style={{ maxWidth: 200 }}
                    placeholder="Key (e.g. kVA)"
                    aria-label={`Nameplate key ${idx + 1}`}
                    value={pair.key}
                    onChange={e => setNameplatePair(idx, 'key', e.target.value)}
                  />
                  <input
                    className="form-control"
                    style={{ maxWidth: 280 }}
                    placeholder="Value (e.g. 1500)"
                    aria-label={`Nameplate value ${idx + 1}`}
                    value={pair.value}
                    onChange={e => setNameplatePair(idx, 'value', e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => removeNameplatePair(idx)}
                    aria-label={`Remove nameplate pair ${idx + 1}`}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-sm" onClick={addNameplatePair}>
                + Add field
              </button>
            </div>
          </div>

          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Notes</div></div>
            <div className="card-body">
              <textarea
                className="form-control form-control-wide"
                aria-label="Notes"
                rows={4}
                value={form.notes}
                onChange={e => setF('notes', e.target.value)}
                placeholder="Anything the next tech should know…"
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Creating…' : 'Create Asset'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => navigate('/assets')}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
