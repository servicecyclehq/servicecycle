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

import { useState, useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Layers } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useAiConsent } from '../context/AiConsentContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import InfoTip from '../components/InfoTip';
import CustomFieldInputs from '../components/CustomFieldInputs';
import Toast from '../components/Toast';
import BackLink from '../components/BackLink';
import { EQUIPMENT_TYPE_LABELS, CONDITION_META, REDUNDANCY_META, CRITICALITY_SCORE_META } from '../lib/equipment';

// ── "Start from a photo" helpers ─────────────────────────────────────────────
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PHOTO_ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Best-effort map of the model's free-text equipment guess onto our enum.
function matchEquipmentType(guess) {
  if (!guess) return null;
  const raw = String(guess).trim();
  if (EQUIPMENT_TYPE_LABELS[raw]) return raw;
  const up = raw.toUpperCase().replace(/[\s/()-]+/g, '_').replace(/_+/g, '_');
  if (EQUIPMENT_TYPE_LABELS[up]) return up;
  const byLabel = Object.entries(EQUIPMENT_TYPE_LABELS)
    .find(([, label]) => label.toLowerCase() === raw.toLowerCase());
  return byLabel ? byLabel[0] : null;
}

// Normalize a suggested condition to C1/C2/C3 or null.
function validCond(v) {
  const c = String(v ?? '').trim().toUpperCase();
  return /^C[123]$/.test(c) ? c : null;
}

const CONDITION_TIP =
  'NFPA 70B:2023 condition of maintenance. Each asset is rated C1 (good), ' +
  'C2 (fair), or C3 (poor) on three axes — physical condition, criticality, ' +
  'and operating environment. The WORST of the three governs and selects the ' +
  'maintenance interval for every task on this asset. Unassessed assets ' +
  'default to C2.';

export default function NewAsset() {
  useDocumentTitle('New Asset');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const confirm = useConfirm();
  // AI photo-identify gating — exact mirror of MaintenanceBriefCard's gate
  // (maintenance_brief feature + AI enabled + provider configured). The
  // panel is hidden entirely when any leg is missing; the server enforces
  // everything independently.
  const { aiEnabled, aiConfigured, features } = useAuth();
  const { requestConsent } = useAiConsent();
  const photoPanelAvailable = !!(features?.maintenance_brief && aiEnabled && aiConfigured);

  const [sites, setSites]         = useState([]);
  const [showNewSite, setShowNewSite] = useState(false);
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteBusy, setNewSiteBusy] = useState(false);
  const [siteTree, setSiteTree]   = useState(null); // GET /api/sites/:id payload
  const [treeLoading, setTreeLoading] = useState(false);
  const [error, setError]   = useState('');
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    siteId: '', buildingId: '', areaId: '', positionId: '',
    equipmentType: '', ownerId: '',
    manufacturer: '', model: '', serialNumber: '',
    installDate: '', lastCommissionedDate: '',
    conditionPhysical: 'C2', conditionCriticality: 'C2', conditionEnvironment: 'C2',
    inService: true, isEnergized: true,
    notes: '',
    // Risk & criticality — '' in the selects/inputs means unset (sent as null).
    criticalityScore: '', repairCostEstimate: '', spareLeadTimeWeeks: '',
    redundancyStatus: '', requiresPredictiveMaintenance: false,
  });
  // Nameplate data as ordered key/value pairs; collapsed to an object on save.
  const [nameplate, setNameplate] = useState([{ key: '', value: '' }]);
  // Admin-defined custom fields: active definitions drive the inputs, and
  // values ride along keyed by definitionId (the server's customFields shape).
  const [fieldDefs, setFieldDefs] = useState([]);
  const [customFields, setCustomFields] = useState({});
  // Account members ({id, name}) for the optional owner picker.
  const [members, setMembers] = useState([]);

  // "Start from template" panel
  const [templateApplied, setTemplateApplied] = useState(null); // { id, name } of applied template
  const [templateTaskIds, setTemplateTaskIds] = useState([]);   // task def IDs to bulk-apply

  // "Start from a photo" panel — collapsed by default so the manual flow
  // stays primary; only mounted at all when photoPanelAvailable.
  const [photoOpen, setPhotoOpen]       = useState(false);
  const [photoFile, setPhotoFile]       = useState(null);
  const [photoPreview, setPhotoPreview] = useState(null);
  const [photoBusy, setPhotoBusy]       = useState(false);
  const [photoError, setPhotoError]     = useState(null);
  // True once a photo analysis has pre-filled the form — drives the
  // visual-only disclaimer under the condition selects.
  const [photoApplied, setPhotoApplied] = useState(false);
  const [toast, setToast]               = useState(null);
  const photoInputRef = useRef(null);

  // Revoke the preview object URL when replaced / on unmount.
  useEffect(() => () => { if (photoPreview) URL.revokeObjectURL(photoPreview); }, [photoPreview]);

  const setF = (k, v) => setForm(p => ({ ...p, [k]: v }));

  useEffect(() => {
    api.get('/api/sites')
      .then(r => setSites(r.data.data?.sites || []))
      .catch(() => setError('Failed to load sites.'));
    api.get('/api/custom-fields')
      .then(r => setFieldDefs((r.data.data?.fields || []).filter(d => !d.archivedAt)))
      .catch(() => { /* non-fatal — the section simply doesn't render */ });
    api.get('/api/bootstrap?limit=1')
      .then(r => setMembers(r.data.data?.members || []))
      .catch(() => { /* non-fatal — owner picker renders empty */ });

    // If ?templateId= is in the URL, fetch the template and pre-fill the form.
    const templateId = searchParams.get('templateId');
    if (templateId) {
      api.get(`/api/asset-templates/${templateId}`)
        .then(r => {
          const t = r.data.data?.template;
          if (!t) return;
          setForm(f => ({
            ...f,
            equipmentType:               t.equipmentType || f.equipmentType,
            criticalityScore:            t.defaultCriticalityScore != null ? String(t.defaultCriticalityScore) : f.criticalityScore,
            redundancyStatus:            t.defaultRedundancyStatus || f.redundancyStatus,
            requiresPredictiveMaintenance: t.defaultRequiresPredictiveMaintenance ?? f.requiresPredictiveMaintenance,
          }));
          // Pre-populate nameplate from template hints
          if (t.nameplateDefaults && Object.keys(t.nameplateDefaults).length) {
            setNameplate(
              Object.entries(t.nameplateDefaults).map(([key, value]) => ({ key, value: String(value) }))
            );
          }
          // Stash task definition IDs for bulk-apply after creation
          if (t.taskDefinitions?.length) {
            setTemplateTaskIds(t.taskDefinitions.map(td => td.id));
          }
          setTemplateApplied({ id: t.id, name: t.name });
        })
        .catch(() => { /* silently skip — form still usable */ });
    }
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

  // ── "Start from a photo" handlers ──────────────────────────────────────────
  function handlePhotoFileChange(e) {
    const f = e.target.files?.[0];
    setPhotoError(null);
    if (!f) { setPhotoFile(null); setPhotoPreview(null); return; }
    if (!PHOTO_ACCEPT_TYPES.includes(f.type)) {
      setPhotoFile(null); setPhotoPreview(null);
      setPhotoError('Unsupported image type — please use a JPEG, PNG, or WebP photo.');
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    if (f.size > PHOTO_MAX_BYTES) {
      setPhotoFile(null); setPhotoPreview(null);
      setPhotoError(`Photo is too large (${(f.size / 1024 / 1024).toFixed(1)}MB) — the limit is 10MB.`);
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    setPhotoFile(f);
    setPhotoPreview(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
  }

  const runPhotoInspect = async () => {
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      const fd = new FormData();
      fd.append('file', photoFile);
      // No assetId — this is a pre-creation identify. Site context helps the
      // server scope upstream-candidate matching when one is already chosen.
      if (form.siteId) fd.append('siteId', form.siteId);
      const res = await api.post('/api/assets/photo-inspect', fd);
      const analysis = res.data?.data?.analysis || {};
      const ident = analysis.identification || {};
      const vis   = analysis.visibleCondition || {};

      // Pre-fill only what the photo actually yielded; never blank a field
      // the user already typed.
      const typeKey = matchEquipmentType(ident.equipmentTypeGuess);
      const sPhys = validCond(vis.suggestedConditionPhysical);
      const sEnv  = validCond(vis.suggestedConditionEnvironment);
      setForm(p => ({
        ...p,
        equipmentType: typeKey || p.equipmentType,
        manufacturer:  String(ident.manufacturer || '').trim() || p.manufacturer,
        model:         String(ident.model || '').trim() || p.model,
        serialNumber:  String(ident.serialNumber || '').trim() || p.serialNumber,
        conditionPhysical:    sPhys || p.conditionPhysical,
        conditionEnvironment: sEnv || p.conditionEnvironment,
      }));
      // Nameplate rows: append photo-read pairs the user hasn't already keyed.
      const photoPairs = Object.entries(ident.nameplate || {})
        .filter(([k, v]) => k && v != null && String(v).trim() !== '')
        .map(([key, value]) => ({ key, value: String(value) }));
      if (photoPairs.length > 0) {
        setNameplate(prev => {
          const kept = prev.filter(p => p.key.trim());
          const have = new Set(kept.map(p => p.key.trim().toLowerCase()));
          const added = photoPairs.filter(p => !have.has(p.key.trim().toLowerCase()));
          const next = [...kept, ...added];
          return next.length > 0 ? next : [{ key: '', value: '' }];
        });
      }
      setPhotoApplied(true);
      setToast({
        message: 'Form pre-filled from photo — review before saving',
        variant: 'success',
        duration: 6000,
      });
    } catch (err) {
      // Error vocabulary copied from MaintenanceBriefCard — same server gates.
      const status = err.response?.status;
      const data   = err.response?.data;
      if (status === 429 && data?.error === 'ai_daily_cap_reached') {
        const { count, cap, resetAt } = data.data || {};
        const resetStr = resetAt ? new Date(resetAt).toLocaleString() : 'midnight UTC';
        setPhotoError(`Daily AI limit reached${cap ? ` (${count}/${cap})` : ''}. Resets at ${resetStr}.`);
      } else if (status === 429) {
        setPhotoError('Too many AI requests right now — please try again in a little while.');
      } else if (data?.error === 'ai_consent_required' || data?.error === 'ai_consent_outdated') {
        setPhotoError('AI consent needs to be re-acknowledged — please click Identify again and accept the consent dialog.');
      } else if (status === 413) {
        setPhotoError('The server rejected this photo as too large — try a smaller image.');
      } else if (status === 503) {
        setPhotoError(data?.message || 'AI is temporarily unavailable on this instance. Please try again later.');
      } else if (err.demoBlocked) {
        setPhotoError(null); // global demo banner already showed
      } else {
        setPhotoError(data?.message || data?.error || err.message || 'Failed to analyze photo.');
      }
    } finally {
      setPhotoBusy(false);
    }
  };

  const handleIdentify = () => {
    if (photoBusy || !photoFile) return;
    // Same consent flow as the brief card: runs now if already acknowledged
    // this session / silenced, else opens the app-level AiConsentModal first.
    requestConsent(runPhotoInspect);
  };

  async function createSite() {
    const name = newSiteName.trim();
    if (!name || newSiteBusy) return;
    setNewSiteBusy(true);
    try {
      const res = await api.post('/api/sites', { name });
      const site = res.data?.data?.site || res.data?.data;
      if (site?.id) {
        setSites(prev => [...prev, { id: site.id, name: site.name }].sort((a, b) => a.name.localeCompare(b.name)));
        setF('siteId', site.id);
        setShowNewSite(false);
        setNewSiteName('');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.response?.data?.message || 'Could not create the site.');
    } finally {
      setNewSiteBusy(false);
    }
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
        ownerId:       form.ownerId || null,
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
        criticalityScore:   form.criticalityScore ? Number(form.criticalityScore) : null,
        repairCostEstimate: form.repairCostEstimate.trim() || null,
        spareLeadTimeWeeks: form.spareLeadTimeWeeks !== '' ? Number(form.spareLeadTimeWeeks) : null,
        redundancyStatus:   form.redundancyStatus || null,
        requiresPredictiveMaintenance: form.requiresPredictiveMaintenance,
        ...(Object.keys(nameplateData).length > 0 ? { nameplateData } : {}),
        // Empty strings are dropped server-side; only send when touched.
        ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
      };
      const res = await api.post('/api/assets', body);
      const asset = res.data.data.asset;

      // If the user started from an equipment template, its tasks are applied first
      // (silent — template tasks are a curated subset of the full NFPA 70B matrix).
      if (templateTaskIds.length > 0) {
        try {
          await api.post('/api/schedules/bulk-apply', {
            assetId: asset.id,
            taskDefinitionIds: templateTaskIds,
          });
        } catch {
          // Non-fatal — schedules can be applied from the detail page.
        }
      }

      const applyTemplate = await confirm({
        title: templateApplied
          ? `Apply the industry-standard program too?`
          : 'Apply the industry-standard maintenance program?',
        message: templateApplied
          ? `The template "${templateApplied.name}" has already applied ${templateTaskIds.length} task(s). Apply the industry-standard maintenance program (NFPA 70B) for this equipment type on top?`
          : 'This pairs the asset with its industry-standard maintenance program (NFPA 70B) — inspection, cleaning, lubrication, insulation-resistance ("megger"), and infrared scanning, sized to this equipment type. Manufacturer instructions take precedence, so adjust each interval to the OEM and your program. Customers who require more extensive testing can enable the extended (NETA) battery. You can add or remove schedules later; re-running is safe — existing pairings are kept.',
        confirmLabel: 'Apply program',
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
          <BackLink fallback="/assets" fallbackLabel="Assets" />
          <h1 className="page-title">New Asset</h1>
          <div className="page-subtitle">Register a piece of electrical equipment for maintenance tracking</div>
        </div>
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}

        <form onSubmit={handleSubmit}>
          {/* ── Template applied banner ──────────────────────────────────────── */}
          {templateApplied && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16,
              padding: '10px 14px', borderRadius: 8,
              background: 'var(--chip-blue-bg)', border: '1px solid var(--chip-blue-fg)',
            }}>
              <Layers size={16} color="var(--chip-blue-fg)" />
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--chip-blue-fg)' }}>
                <strong>Template applied:</strong> {templateApplied.name} — fields and nameplate pre-filled.{' '}
                {templateTaskIds.length > 0 && `${templateTaskIds.length} tasks will be scheduled after creation.`}
              </span>
              <button
                type="button"
                style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                  color: 'var(--chip-blue-fg)', fontSize: 12, padding: 4 }}
                onClick={() => { setTemplateApplied(null); setTemplateTaskIds([]); }}
              >
                Clear
              </button>
            </div>
          )}

          {/* Template picker (when no template applied yet) */}
          {!templateApplied && (
            <div className="card mb-16">
              <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary"
                  onClick={() => navigate('/equipment-templates')}>
                  <Layers size={14} style={{ marginRight: 6 }} />
                  Start from a template
                </button>
                <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                  Optional — pick an equipment profile to pre-fill fields and auto-schedule its task list.
                </span>
              </div>
            </div>
          )}

          {/* ── Start from a photo (AI, optional) ──────────────────────────── */}
          {/* Hidden unless AI is enabled+configured and the user's role has
              the maintenance_brief feature — and collapsed behind a button so
              the manual flow stays primary. */}
          {photoPanelAvailable && (
            <div className="card mb-16">
              {!photoOpen ? (
                <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-secondary" onClick={() => setPhotoOpen(true)}>
                    📷 Start from a photo
                  </button>
                  <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
                    Optional — AI reads the nameplate and pre-fills the form below.
                  </span>
                </div>
              ) : (
                <>
                  <div
                    className="card-header"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
                  >
                    <div className="card-title">📷 Start from a Photo</div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setPhotoOpen(false)}
                      disabled={photoBusy}
                    >
                      Hide
                    </button>
                  </div>
                  <div className="card-body">
                    <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
                      Snap or upload a photo of the equipment nameplate — AI identifies the type,
                      manufacturer, model, serial, and nameplate ratings and pre-fills the form.
                      Everything stays editable before you save.
                    </div>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                      <input
                        ref={photoInputRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        aria-label="Equipment photo"
                        onChange={handlePhotoFileChange}
                        disabled={photoBusy}
                        style={{ fontSize: 'var(--font-size-ui)' }}
                      />
                      {photoPreview && (
                        <img
                          src={photoPreview}
                          alt="Selected equipment"
                          style={{
                            width: 72, height: 72, objectFit: 'cover',
                            borderRadius: 8, border: '1px solid var(--color-border)', flexShrink: 0,
                          }}
                        />
                      )}
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={handleIdentify}
                        disabled={!photoFile || photoBusy}
                      >
                        Identify equipment
                      </button>
                    </div>
                    {photoBusy && (
                      <div
                        role="status"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10, marginTop: 10,
                          fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)',
                        }}
                      >
                        <span
                          aria-hidden="true"
                          style={{
                            width: 14, height: 14, flexShrink: 0,
                            border: '2px solid var(--color-border)',
                            borderTopColor: 'var(--color-primary, #2563eb)',
                            borderRadius: '50%',
                            animation: 'spin 0.9s linear infinite',
                          }}
                        />
                        <style>{'@keyframes spin { to { transform: rotate(360deg); } }'}</style>
                        Reading the nameplate and inspecting…
                      </div>
                    )}
                    {photoError && !photoBusy && (
                      <div
                        role="alert"
                        style={{
                          marginTop: 10, padding: '8px 12px', borderRadius: 8,
                          background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', color: 'var(--chip-red-fg)',
                          fontSize: 'var(--font-size-ui)',
                        }}
                      >
                        {photoError}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="card mb-16">
            <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div className="card-title">Location</div>
              {!showNewSite && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowNewSite(true)}>
                  + New site
                </button>
              )}
            </div>
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
                  {sites.length === 0 && !showNewSite && (
                    <div className="form-hint">No sites yet — use “+ New site” to create one.</div>
                  )}
                  {showNewSite && (
                    <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-bg-subtle, #f8fafc)' }}>
                      <label className="form-label" style={{ fontSize: 12 }}>New site name</label>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          className="form-control"
                          value={newSiteName}
                          onChange={e => setNewSiteName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); createSite(); } }}
                          placeholder="e.g. North Substation"
                          autoFocus
                        />
                        <button type="button" className="btn btn-primary btn-sm" onClick={createSite} disabled={newSiteBusy || !newSiteName.trim()}>
                          {newSiteBusy ? '…' : 'Create'}
                        </button>
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => { setShowNewSite(false); setNewSiteName(''); }}>
                          Cancel
                        </button>
                      </div>
                      <div className="form-hint">Creates the site and selects it. Add buildings/areas later under Sites.</div>
                    </div>
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
                <div className="form-group">
                  <label className="form-label">Owner</label>
                  <select
                    aria-label="Asset owner"
                    className="form-control"
                    value={form.ownerId}
                    onChange={e => setF('ownerId', e.target.value)}
                  >
                    <option value="">— Unassigned —</option>
                    {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                  </select>
                  <div className="form-hint">Owner receives every maintenance alert for this asset.</div>
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
              {photoApplied && (
                <div style={{
                  marginTop: 8, fontSize: 'var(--font-size-xs)', fontStyle: 'italic',
                  color: 'var(--color-text-muted, var(--color-text-secondary))',
                }}>
                  Photo-suggested conditions are a visual assessment only — not a substitute for testing.
                </div>
              )}
            </div>
          </div>

          <div className="card mb-16">
            <div className="card-header"><div className="card-title">Risk &amp; Criticality</div></div>
            <div className="card-body">
              <div className="form-hint" style={{ marginBottom: 10 }}>
                Optional — feeds the priority views on the dashboard. Score what failure of this asset would cost the business.
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Criticality Score</label>
                  <select
                    aria-label="Criticality score"
                    className="form-control"
                    value={form.criticalityScore}
                    onChange={e => setF('criticalityScore', e.target.value)}
                  >
                    <option value="">— Not scored —</option>
                    {[5, 4, 3, 2, 1].map(n => (
                      <option key={n} value={n}>{n} — {CRITICALITY_SCORE_META[n].label}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Repair Cost Estimate ($)</label>
                  <input
                    type="number" min="0" step="0.01" className="form-control"
                    aria-label="Repair cost estimate in dollars" placeholder="e.g. 25000"
                    value={form.repairCostEstimate}
                    onChange={e => setF('repairCostEstimate', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Spare Lead Time (weeks)</label>
                  <input
                    type="number" min="0" step="1" className="form-control"
                    aria-label="Spare lead time in weeks" placeholder="e.g. 12"
                    value={form.spareLeadTimeWeeks}
                    onChange={e => setF('spareLeadTimeWeeks', e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">Redundancy</label>
                  <select
                    aria-label="Redundancy status"
                    className="form-control"
                    value={form.redundancyStatus}
                    onChange={e => setF('redundancyStatus', e.target.value)}
                  >
                    <option value="">— Unknown —</option>
                    {Object.entries(REDUNDANCY_META).map(([k, m]) => (
                      <option key={k} value={k}>{m.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="checkbox-group">
                <input
                  id="new-asset-predictive"
                  type="checkbox"
                  checked={form.requiresPredictiveMaintenance}
                  onChange={e => setF('requiresPredictiveMaintenance', e.target.checked)}
                />
                <label htmlFor="new-asset-predictive" className="checkbox-label">
                  Requires predictive maintenance (IR scans, oil analysis, partial discharge…)
                </label>
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

          {fieldDefs.length > 0 && (
            <div className="card mb-16">
              <div className="card-header"><div className="card-title">Custom Fields</div></div>
              <div className="card-body">
                <div className="form-hint" style={{ marginBottom: 10 }}>
                  Defined by your admin in Settings → Custom Fields.
                </div>
                <CustomFieldInputs
                  definitions={fieldDefs}
                  values={customFields}
                  onChange={(id, v) => setCustomFields(p => ({ ...p, [id]: v }))}
                  disabled={saving}
                />
              </div>
            </div>
          )}

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
      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
