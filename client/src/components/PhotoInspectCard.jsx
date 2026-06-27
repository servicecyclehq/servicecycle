// ─────────────────────────────────────────────────────────────────────────────
// PhotoInspectCard.jsx — AI photo inspection for one asset (AssetDetail).
//
// Self-contained card taking { asset, onApplied }. Lets the user snap or pick
// an equipment photo, runs it through POST /api/assets/photo-inspect, and
// renders the analysis in three blocks (identification / visible condition /
// connection clues) plus a manager+ "apply" section that writes selected
// suggestions back via one PUT /api/assets/:id.
//
// Gating + consent + quota/error handling intentionally mirror
// MaintenanceBriefCard end to end (client-side mirror of the server gates —
// the server enforces everything independently):
//   - features.maintenance_brief  → card hidden entirely without the feature.
//   - aiEnabled && aiConfigured   → card hidden when the instance has AI
//     off or no provider key configured.
//   - requestConsent(fn) routes the analyze click through the app-level
//     AiConsentModal; server 403 ai_consent_required → retry hint.
//   - 429 ai_daily_cap_reached / 503 ai_disabled handled with the same copy
//     patterns as the brief card.
//
// Server contract (built in parallel — everything below is read defensively):
//   POST /api/assets/photo-inspect  (multipart: file + assetId + siteId) →
//   data { analysis: { identification: { equipmentTypeGuess, manufacturer,
//          model, serialNumber, nameplate {…}, confidence },
//          visibleCondition: { observations: [{finding, severity}],
//          suggestedConditionPhysical, suggestedConditionEnvironment,
//          rationale, limitations },
//          connectionClues: { visibleLabels[], feedHints[],
//          suggestedUpstreamCandidateIds[] }, notes },
//        model, generatedAt, documentId? }
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useAiConsent } from '../context/AiConsentContext';
import Toast from './Toast';
import { EQUIPMENT_TYPE_LABELS, CONDITION_META, assetLabel } from '../lib/equipment';

const MAX_BYTES = 10 * 1024 * 1024; // 10MB client-side cap (server enforces too)
const ACCEPT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Observation severity chips — same literal-hex traffic-light convention as
// the brief card's urgency chips (domain palette, not theme-dependent).
const SEVERITY_CHIPS = {
  normal: {
    label: 'Normal',
    color: 'var(--chip-slate-fg)', background: 'var(--chip-slate-bg)', border: '1px solid var(--chip-slate-fg)',
  },
  monitor: {
    label: 'Monitor',
    color: 'var(--chip-amber-fg)', background: 'var(--chip-amber-bg)', border: '1px solid var(--chip-amber-fg)',
  },
  concern: {
    label: 'Concern',
    color: 'var(--chip-red-fg)', background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)',
  },
};

function SeverityChip({ severity }) {
  const chip = SEVERITY_CHIPS[severity] || SEVERITY_CHIPS.normal;
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      color: chip.color, background: chip.background, border: chip.border,
    }}>
      {SEVERITY_CHIPS[severity] ? chip.label : String(severity || 'Normal')}
    </span>
  );
}

// Small condition pill reusing the shared CONDITION_META palette.
function CondChip({ cond, prefix }) {
  const meta = CONDITION_META[cond];
  if (!meta) return <span className="text-muted">—</span>;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 20,
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.03em',
      background: meta.bg, color: meta.color, border: `1px solid color-mix(in srgb, ${meta.color} 40%, transparent)`,
      whiteSpace: 'nowrap',
    }}>
      {prefix ? `${prefix} ${cond}` : meta.label}
    </span>
  );
}

// Amber "differs from record" badge next to identification fields whose
// photo-read value doesn't match what's stored on the asset.
function DiffersBadge() {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 999,
      fontSize: 10.5, fontWeight: 600, whiteSpace: 'nowrap',
      color: 'var(--chip-amber-fg)', background: 'var(--chip-amber-bg)', border: '1px solid var(--chip-amber-fg)',
    }}>
      differs from record
    </span>
  );
}

function ConfidenceChip({ confidence }) {
  if (confidence == null || confidence === '') return null;
  let label; let tone;
  if (typeof confidence === 'number') {
    const pct = confidence <= 1 ? Math.round(confidence * 100) : Math.round(confidence);
    label = `${pct}% confidence`;
    tone = pct >= 75 ? 'good' : pct >= 45 ? 'mid' : 'low';
  } else {
    const c = String(confidence).toLowerCase();
    label = `${c.charAt(0).toUpperCase()}${c.slice(1)} confidence`;
    tone = c === 'high' ? 'good' : (c === 'medium' || c === 'moderate') ? 'mid' : 'low';
  }
  const palettes = {
    good: { color: 'var(--chip-green-fg)', background: 'var(--chip-green-bg)', border: '1px solid var(--chip-green-fg)' },
    mid:  { color: 'var(--chip-amber-fg)', background: 'var(--chip-amber-bg)', border: '1px solid var(--chip-amber-fg)' },
    low:  { color: 'var(--chip-red-fg)', background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)' },
  };
  const p = palettes[tone];
  return (
    <span style={{
      display: 'inline-block', padding: '1px 8px', borderRadius: 999,
      fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
      color: p.color, background: p.background, border: p.border,
    }}>
      {label}
    </span>
  );
}

// Tiny inline spinner (reuses the global `spin` keyframe) for active button states.
function Spinner({ size = 13 }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: size, height: size, verticalAlign: '-2px', marginRight: 6,
      border: '2px solid currentColor', borderTopColor: 'transparent', borderRadius: '50%',
      opacity: 0.85, animation: 'spin 0.7s linear infinite',
    }} />
  );
}

function SectionHeading({ children }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: 'var(--color-text-secondary)',
      margin: '14px 0 6px',
    }}>
      {children}
    </div>
  );
}

// Loose string compare for "differs from record" — trims + case-folds so
// "square d" vs "Square D" doesn't false-flag.
function differs(photoVal, recordVal) {
  const p = String(photoVal ?? '').trim().toLowerCase();
  const r = String(recordVal ?? '').trim().toLowerCase();
  if (!p) return false;          // nothing read from the photo → no claim
  return p !== r;
}

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

export default function PhotoInspectCard({ asset, onApplied }) {
  const { aiEnabled, aiConfigured, features } = useAuth();
  const { requestConsent } = useAiConsent();

  // Manager+ apply gate — same flag fallback AssetDetail uses for canWrite.
  const canApply = features?.assets_write ?? features?.contracts_write;

  const [file, setFile]         = useState(null);
  const [preview, setPreview]   = useState(null); // object URL for the thumbnail
  const [result, setResult]     = useState(null); // full response data {analysis, model, generatedAt, documentId}
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  // Site assets (id → asset) for resolving suggestedUpstreamCandidateIds.
  const [siteAssets, setSiteAssets] = useState(null);
  // Apply section state.
  const [checks, setChecks]     = useState({});
  const [fedFromId, setFedFromId] = useState('');
  const [applying, setApplying] = useState(false);
  const [toast, setToast]       = useState(null);
  const fileInputRef = useRef(null);

  // Revoke the preview object URL when it's replaced / on unmount.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const analysis = result?.analysis || null;
  const candidateIds = analysis?.connectionClues?.suggestedUpstreamCandidateIds || [];

  // Resolve upstream candidate ids → labels with one site-scoped asset fetch.
  useEffect(() => {
    if (!analysis || candidateIds.length === 0) return;
    const siteId = asset?.siteId || asset?.site?.id;
    if (!siteId) return;
    let cancelled = false;
    api.get(`/api/assets?siteId=${encodeURIComponent(siteId)}&limit=100`)
      .then(r => {
        if (cancelled) return;
        const map = new Map();
        for (const a of (r.data?.data?.assets || [])) map.set(a.id, a);
        setSiteAssets(map);
      })
      .catch(() => { /* candidates fall back to raw ids */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis]);

  // Hidden entirely when the feature isn't granted or AI isn't available —
  // exact mirror of MaintenanceBriefCard's gate.
  if (!features?.maintenance_brief || !aiEnabled || !aiConfigured) return null;
  if (!asset?.id) return null;

  function handleFileChange(e) {
    const f = e.target.files?.[0];
    setError(null);
    setResult(null);
    setChecks({});
    if (!f) { setFile(null); setPreview(null); return; }
    if (!ACCEPT_TYPES.includes(f.type)) {
      setFile(null); setPreview(null);
      setError('Unsupported image type — please use a JPEG, PNG, or WebP photo.');
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (f.size > MAX_BYTES) {
      setFile(null); setPreview(null);
      setError(`Photo is too large (${(f.size / 1024 / 1024).toFixed(1)}MB) — the limit is 10MB.`);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(f);
    setPreview(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(f);
    });
  }

  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('assetId', asset.id);
      const siteId = asset.siteId || asset.site?.id;
      if (siteId) fd.append('siteId', siteId);
      const res = await api.post('/api/assets/photo-inspect', fd);
      const data = res.data?.data || null;
      setResult(data);
      setChecks({});
      // Default the fed-from selection to the first suggested candidate.
      const ids = data?.analysis?.connectionClues?.suggestedUpstreamCandidateIds || [];
      setFedFromId(ids[0] || '');
    } catch (err) {
      // Error vocabulary copied from MaintenanceBriefCard — same server gates.
      const status = err.response?.status;
      const data   = err.response?.data;
      if (status === 429 && data?.error === 'ai_daily_cap_reached') {
        const { count, cap, resetAt } = data.data || {};
        const resetStr = resetAt ? new Date(resetAt).toLocaleString() : 'midnight UTC';
        setError(`Daily AI limit reached${cap ? ` (${count}/${cap})` : ''}. Resets at ${resetStr}.`);
      } else if (status === 429) {
        setError('Too many AI requests right now — please try again in a little while.');
      } else if (data?.error === 'ai_consent_required' || data?.error === 'ai_consent_outdated') {
        setError('AI consent needs to be re-acknowledged — please click Analyze again and accept the consent dialog.');
      } else if (status === 413) {
        setError('The server rejected this photo as too large — try a smaller image.');
      } else if (status === 503) {
        setError(data?.message || 'AI is temporarily unavailable on this instance. Please try again later.');
      } else if (err.demoBlocked) {
        setError(null); // global demo banner already showed
      } else {
        setError(data?.message || data?.error || err.message || 'Failed to analyze photo.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleAnalyze = () => {
    if (loading || !file) return;
    // Same consent flow as the brief card: runs now if already acknowledged
    // this session / silenced, else opens the app-level AiConsentModal first.
    requestConsent(runAnalysis);
  };

  // ── Derived apply options ───────────────────────────────────────────────────
  const ident = analysis?.identification || {};
  const vis   = analysis?.visibleCondition || {};
  const clues = analysis?.connectionClues || {};

  const typeGuessKey   = matchEquipmentType(ident.equipmentTypeGuess);
  const typeMismatch   = !!ident.equipmentTypeGuess
    && (typeGuessKey ? typeGuessKey !== asset.equipmentType : true);

  const identityDiffs = {
    manufacturer: differs(ident.manufacturer, asset.manufacturer),
    model:        differs(ident.model, asset.model),
    serialNumber: differs(ident.serialNumber, asset.serialNumber),
  };
  const hasIdentityToApply =
    (ident.manufacturer && identityDiffs.manufacturer) ||
    (ident.model && identityDiffs.model) ||
    (ident.serialNumber && identityDiffs.serialNumber);

  const photoNameplate = (ident.nameplate && typeof ident.nameplate === 'object')
    ? Object.fromEntries(Object.entries(ident.nameplate).filter(([k, v]) => k && v != null && String(v).trim() !== ''))
    : {};
  const hasNameplateToMerge = Object.keys(photoNameplate).length > 0;

  const suggPhys = validCond(vis.suggestedConditionPhysical);
  const suggEnv  = validCond(vis.suggestedConditionEnvironment);
  const physApplicable = suggPhys && suggPhys !== asset.conditionPhysical;
  const envApplicable  = suggEnv && suggEnv !== asset.conditionEnvironment;

  const resolvedCandidates = candidateIds.map(id => ({
    id,
    asset: siteAssets?.get(id) || null,
  }));
  const candidateLabel = (c) => c.asset ? assetLabel(c.asset) : `Asset ${String(c.id).slice(0, 8)}…`;
  const fedFromApplicable = resolvedCandidates.length > 0;

  const anyApplicable = hasIdentityToApply || hasNameplateToMerge
    || physApplicable || envApplicable || fedFromApplicable;
  const anyChecked = Object.values(checks).some(Boolean);

  const toggle = (k) => setChecks(p => ({ ...p, [k]: !p[k] }));

  async function handleApply() {
    if (applying || !anyChecked) return;
    const body = {};
    if (checks.identity && hasIdentityToApply) {
      // Only send fields the photo actually read — never null-out the record.
      if (ident.manufacturer) body.manufacturer = String(ident.manufacturer).trim();
      if (ident.model)        body.model        = String(ident.model).trim();
      if (ident.serialNumber) body.serialNumber = String(ident.serialNumber).trim();
    }
    if (checks.nameplate && hasNameplateToMerge) {
      // Merge: existing keys are kept, photo-read keys are added; on a key
      // collision the photo value wins (that's the point of re-reading the
      // nameplate). Review happens visually in the results block above.
      body.nameplateData = { ...(asset.nameplateData || {}), ...photoNameplate };
    }
    if (checks.condPhys && physApplicable) body.conditionPhysical   = suggPhys;
    if (checks.condEnv && envApplicable)   body.conditionEnvironment = suggEnv;
    if (checks.fedFrom && fedFromApplicable && fedFromId) body.fedFromAssetId = fedFromId;
    if (Object.keys(body).length === 0) return;

    setApplying(true);
    try {
      await api.put(`/api/assets/${asset.id}`, body);
      setToast({ message: 'Photo suggestions applied to the asset.', variant: 'success', duration: 4000 });
      setChecks({});
      onApplied?.();
    } catch (err) {
      if (err.demoBlocked) {
        // global demo banner already showed
      } else {
        const msg = err.response?.data?.error || err.response?.data?.message || 'Failed to apply changes.';
        setToast({ message: /loop/i.test(String(msg)) ? 'Feed loop detected — that upstream choice would feed the asset from its own downstream.' : msg, variant: 'error' });
      }
    } finally {
      setApplying(false);
    }
  }

  const checkboxRow = (key, label, disabled = false) => (
    <div className="checkbox-group" key={key}>
      <input
        id={`photo-apply-${key}`}
        type="checkbox"
        checked={!!checks[key]}
        disabled={disabled || applying}
        onChange={() => toggle(key)}
      />
      <label htmlFor={`photo-apply-${key}`} className="checkbox-label">{label}</label>
    </div>
  );

  return (
    <div className="card mb-16">
      <div
        className="card-header"
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}
      >
        <div className="card-title">📷 Photo Inspection</div>
        {analysis && !loading && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleAnalyze}
            disabled={!file}
          >
            Re-analyze
          </button>
        )}
      </div>
      <div className="card-body">
        {!analysis && !loading && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 12 }}>
            Snap or upload a photo of the equipment — AI reads the nameplate, checks the visible
            condition, and looks for upstream-feed clues.
          </div>
        )}

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Equipment photo"
            onChange={handleFileChange}
            disabled={loading}
            style={{ fontSize: 'var(--font-size-ui)' }}
          />
          {preview && (
            <img
              src={preview}
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
            onClick={handleAnalyze}
            disabled={!file || loading}
          >
            Analyze photo
          </button>
        </div>

        {loading && (
          <div
            role="status"
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)',
              padding: '8px 0',
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

        {error && !loading && (
          <div
            role="alert"
            style={{
              marginTop: 4, padding: '8px 12px', borderRadius: 8,
              background: 'var(--chip-red-bg)', border: '1px solid var(--chip-red-fg)', color: 'var(--chip-red-fg)',
              fontSize: 'var(--font-size-ui)',
            }}
          >
            {error}
          </div>
        )}

        {analysis && !loading && (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>
            {/* ── Identification ─────────────────────────────────────────── */}
            <SectionHeading>Identification</SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--color-text-secondary)', minWidth: 110 }}>Type guess</span>
                <span style={typeMismatch ? {
                  fontWeight: 700, color: 'var(--chip-amber-fg)', background: 'var(--chip-amber-bg)',
                  border: '1px solid var(--chip-amber-fg)', borderRadius: 6, padding: '0 6px',
                } : { fontWeight: 600 }}>
                  {typeGuessKey ? EQUIPMENT_TYPE_LABELS[typeGuessKey] : (ident.equipmentTypeGuess || '—')}
                </span>
                {typeMismatch && (
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    record says {EQUIPMENT_TYPE_LABELS[asset.equipmentType] || asset.equipmentType}
                  </span>
                )}
                <ConfidenceChip confidence={ident.confidence} />
              </div>
              {[
                ['Manufacturer', ident.manufacturer, identityDiffs.manufacturer],
                ['Model',        ident.model,        identityDiffs.model],
                ['Serial',       ident.serialNumber, identityDiffs.serialNumber],
              ].map(([label, value, diff]) => (
                <div key={label} style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ color: 'var(--color-text-secondary)', minWidth: 110 }}>{label}</span>
                  <span style={{ fontWeight: 600 }}>{value || <span className="text-muted">not read</span>}</span>
                  {value && diff && <DiffersBadge />}
                </div>
              ))}
            </div>
            {hasNameplateToMerge && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                  Nameplate read from photo
                </div>
                <div className="detail-grid">
                  {Object.entries(photoNameplate).map(([k, v]) => (
                    <div className="detail-item" key={k}>
                      <div className="detail-label">{k}</div>
                      <div className="detail-value">{String(v)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Visible condition ──────────────────────────────────────── */}
            <SectionHeading>Visible Condition</SectionHeading>
            {(vis.observations || []).length > 0 ? (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {vis.observations.map((o, i) => (
                  <li
                    key={i}
                    style={{
                      display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap',
                      padding: '7px 0',
                      borderBottom: i < vis.observations.length - 1 ? '1px solid var(--color-border)' : 'none',
                    }}
                  >
                    <SeverityChip severity={o.severity} />
                    <span style={{ lineHeight: 1.5 }}>{o.finding}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p style={{ margin: 0, color: 'var(--color-text-secondary)' }}>No visible findings reported.</p>
            )}
            {(suggPhys || suggEnv) && (
              <div style={{ marginTop: 10, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                {suggPhys && (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>Physical:</span>
                    <CondChip cond={asset.conditionPhysical} prefix="current" />
                    <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)' }}>→</span>
                    <CondChip cond={suggPhys} prefix="suggested" />
                  </span>
                )}
                {suggEnv && (
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>Environment:</span>
                    <CondChip cond={asset.conditionEnvironment} prefix="current" />
                    <span aria-hidden="true" style={{ color: 'var(--color-text-secondary)' }}>→</span>
                    <CondChip cond={suggEnv} prefix="suggested" />
                  </span>
                )}
              </div>
            )}
            {vis.rationale && (
              <div style={{ marginTop: 6, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {vis.rationale}
              </div>
            )}
            <div style={{
              marginTop: 8, fontSize: 'var(--font-size-xs)', fontStyle: 'italic',
              color: 'var(--color-text-muted, var(--color-text-secondary))',
            }}>
              Visual assessment only — not a substitute for testing.
              {vis.limitations ? ` ${vis.limitations}` : ''}
            </div>

            {/* ── Connection clues ───────────────────────────────────────── */}
            {((clues.visibleLabels || []).length > 0
              || (clues.feedHints || []).length > 0
              || resolvedCandidates.length > 0) && (
              <>
                <SectionHeading>Connection Clues</SectionHeading>
                {(clues.visibleLabels || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    {clues.visibleLabels.map((l, i) => (
                      <span key={i} style={{
                        display: 'inline-block', padding: '1px 8px', borderRadius: 6,
                        fontSize: 'var(--font-size-xs)', fontWeight: 600,
                        background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                        color: 'var(--color-text)',
                      }}>
                        {l}
                      </span>
                    ))}
                  </div>
                )}
                {(clues.feedHints || []).length > 0 && (
                  <ul style={{ margin: '0 0 6px', paddingLeft: 18, color: 'var(--color-text-secondary)', lineHeight: 1.55 }}>
                    {clues.feedHints.map((h, i) => <li key={i}>{h}</li>)}
                  </ul>
                )}
                {resolvedCandidates.length > 0 && (
                  <div style={{ fontSize: 'var(--font-size-ui)' }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>Possible upstream feed: </span>
                    {resolvedCandidates.map((c, i) => (
                      <span key={c.id} style={{ fontWeight: 600 }}>
                        {i > 0 && <span style={{ fontWeight: 400 }}>, </span>}
                        {candidateLabel(c)}
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}

            {analysis.notes && (
              <div style={{ marginTop: 10, color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                {analysis.notes}
              </div>
            )}

            {/* ── Apply (manager+) ───────────────────────────────────────── */}
            {canApply && anyApplicable && (
              <>
                <SectionHeading>Apply to Asset Record</SectionHeading>
                {hasIdentityToApply && checkboxRow('identity', `Set manufacturer / model / serial from photo`)}
                {hasNameplateToMerge && checkboxRow('nameplate', `Merge nameplate data (${Object.keys(photoNameplate).length} field${Object.keys(photoNameplate).length !== 1 ? 's' : ''})`)}
                {physApplicable && checkboxRow('condPhys', `Set physical condition → ${suggPhys}`)}
                {envApplicable && checkboxRow('condEnv', `Set environment condition → ${suggEnv}`)}
                {fedFromApplicable && (
                  <div className="checkbox-group" style={{ alignItems: 'center', gap: 8, flexWrap: 'wrap', display: 'flex' }}>
                    <input
                      id="photo-apply-fedFrom"
                      type="checkbox"
                      checked={!!checks.fedFrom}
                      disabled={applying}
                      onChange={() => toggle('fedFrom')}
                    />
                    <label htmlFor="photo-apply-fedFrom" className="checkbox-label">
                      Set fed-from →{' '}
                      {resolvedCandidates.length === 1
                        ? candidateLabel(resolvedCandidates[0])
                        : null}
                    </label>
                    {resolvedCandidates.length > 1 && (
                      <select
                        aria-label="Upstream feed candidate"
                        className="form-control"
                        style={{ maxWidth: 280, display: 'inline-block' }}
                        value={fedFromId}
                        disabled={applying}
                        onChange={e => setFedFromId(e.target.value)}
                      >
                        {resolvedCandidates.map(c => (
                          <option key={c.id} value={c.id}>{candidateLabel(c)}</option>
                        ))}
                      </select>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ marginTop: 8 }}
                  onClick={handleApply}
                  disabled={!anyChecked || applying}
                >
                  {applying ? <><Spinner />Applying…</> : 'Apply selected'}
                </button>
              </>
            )}

            <div style={{ marginTop: 14, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              Analyzed {result.generatedAt ? new Date(result.generatedAt).toLocaleString() : ''}
              {result.model ? ` · ${result.model}` : ''}
              {result.documentId ? ' · Photo saved to this asset’s documents.' : ''}
            </div>
          </div>
        )}
      </div>
      <Toast toast={toast} onClose={() => setToast(null)} />
    </div>
  );
}
