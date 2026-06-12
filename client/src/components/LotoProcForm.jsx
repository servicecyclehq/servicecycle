// ─────────────────────────────────────────────────────────────────────────────
// LotoProcForm.jsx — Create / edit a structured LOTO procedure.
//
// Handles both POST (new) and PUT (full revision) by detecting whether proc is
// passed in (edit) or null (create).
//
// Sections:
//   1. Title + notes
//   2. Energy sources — add/remove rows with type, description, isolation fields
//   3. Procedure steps — add/remove/reorder with instruction, category, verify flag
//
// Takes { assetId, proc, onSaved, onCancel }
//   assetId: the asset this procedure belongs to
//   proc:    existing LotoProc (edit) or null (create)
//   onSaved: callback after successful save
//   onCancel: callback to dismiss
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react';
import api from '../api/client';
import { EQUIPMENT_TYPE_LABELS } from '../lib/equipment';

const ENERGY_TYPES = [
  { value: 'electrical', label: 'Electrical' },
  { value: 'pneumatic',  label: 'Pneumatic'  },
  { value: 'hydraulic',  label: 'Hydraulic'  },
  { value: 'mechanical', label: 'Mechanical' },
  { value: 'thermal',    label: 'Thermal'    },
  { value: 'chemical',   label: 'Chemical'   },
  { value: 'gravity',    label: 'Gravity'    },
];

const STEP_CATS = [
  { value: 'shutdown',  label: 'Shutdown'  },
  { value: 'isolation', label: 'Isolation' },
  { value: 'lockout',   label: 'Lockout'   },
  { value: 'verify',    label: 'Verify'    },
  { value: 'restore',   label: 'Restore'   },
  { value: 'release',   label: 'Release'   },
];

// ── Standard LOTO templates by equipment type ─────────────────────────────────
// OSHA 29 CFR 1910.147-style step sequences (notify → shutdown → isolate →
// lock → tag → dissipate stored energy → verify zero energy → ground as
// applicable), tailored per equipment family. Loaded as an EDITABLE starting
// point via the "Load standard template" button — never auto-applied. Every
// energy-source row is generic on purpose; the user must replace the
// EDIT-flagged text with the real isolation points before activating.
const GENERIC_STEPS_HEAD = [
  { category: 'shutdown',  instruction: 'Notify all affected employees that the equipment will be locked out for service.' },
  { category: 'shutdown',  instruction: 'Perform normal shutdown of the equipment using the established operating procedure.' },
];
const GENERIC_STEPS_TAIL = [
  { category: 'lockout',   instruction: 'Apply a personal LOTO lock to each isolation device — one lock per authorized employee.' },
  { category: 'lockout',   instruction: 'Attach a danger tag to each lock identifying the authorized employee, date, and reason.' },
  { category: 'verify',    instruction: 'Attempt to restart / operate the equipment to verify it cannot be energized; return controls to OFF.', requiresVerification: true },
  { category: 'verify',    instruction: 'Test for absence of voltage on all conductors phase-to-phase and phase-to-ground with a meter verified on a known live source before and after (live-dead-live).', requiresVerification: true },
  { category: 'restore',   instruction: 'Restore: confirm tools/personnel clear, remove grounds, remove locks and tags (each by its owner), and notify affected employees before re-energizing.' },
];
const LOTO_TEMPLATES = {
  transformer: {
    sources: [{ energyType: 'electrical', description: 'EDIT: Primary (HV) feed — identify upstream switch/breaker', isolationPoint: 'EDIT: upstream disconnect / breaker', isolationMethod: 'Open and rack out / lock open', verificationMethod: 'Test for absence of voltage (live-dead-live)' },
              { energyType: 'electrical', description: 'EDIT: Secondary (LV) side — possible backfeed source', isolationPoint: 'EDIT: secondary main breaker', isolationMethod: 'Open and lock', verificationMethod: 'Test for absence of voltage on secondary terminals' }],
    steps: [
      ...GENERIC_STEPS_HEAD,
      { category: 'isolation', instruction: 'Open and lock the PRIMARY (HV) disconnect or breaker feeding the transformer.' },
      { category: 'isolation', instruction: 'Open and lock the SECONDARY (LV) main breaker — treat the secondary as a possible backfeed source.' },
      ...GENERIC_STEPS_TAIL.slice(0, 4),
      { category: 'verify',    instruction: 'Apply temporary protective grounds to primary and secondary terminals after verifying zero energy.', requiresVerification: true },
      { category: 'verify',    instruction: 'Allow liquid-filled units to cool before opening — hot oil and pressurized tanks are stored thermal energy.' },
      GENERIC_STEPS_TAIL[4],
    ],
  },
  breaker: {
    sources: [{ energyType: 'electrical', description: 'EDIT: Upstream feed to this device / section', isolationPoint: 'EDIT: upstream breaker or disconnect', isolationMethod: 'Open, rack to disconnected position, lock', verificationMethod: 'Test for absence of voltage (live-dead-live)' },
              { energyType: 'mechanical', description: 'Charged closing/opening springs in the breaker mechanism', isolationPoint: 'Breaker operating mechanism', isolationMethod: 'Discharge springs (close + trip with control power off)', verificationMethod: 'Confirm spring-charge indicator shows DISCHARGED' }],
    steps: [
      ...GENERIC_STEPS_HEAD,
      { category: 'isolation', instruction: 'Open the breaker, then rack it to the DISCONNECTED / withdrawn position where applicable.' },
      { category: 'isolation', instruction: 'Open and lock the upstream source disconnect; isolate control power (CPT / station battery) to the cubicle.' },
      { category: 'isolation', instruction: 'Discharge stored spring energy: with control power isolated, press CLOSE then TRIP and confirm the charge indicator reads discharged.' },
      ...GENERIC_STEPS_TAIL.slice(0, 4),
      { category: 'verify',    instruction: 'Apply temporary protective grounds where required for the work before contact with conductors.', requiresVerification: true },
      GENERIC_STEPS_TAIL[4],
    ],
  },
  battery: {
    sources: [{ energyType: 'electrical', description: 'EDIT: AC input feed to the UPS / charger', isolationPoint: 'EDIT: AC input breaker', isolationMethod: 'Open and lock', verificationMethod: 'Test for absence of AC voltage' },
              { energyType: 'electrical', description: 'Battery string — DC energy CANNOT be de-energized, only isolated', isolationPoint: 'EDIT: DC disconnect / battery breaker', isolationMethod: 'Open and lock the DC disconnect', verificationMethod: 'Verify no DC voltage downstream of the disconnect' },
              { energyType: 'chemical',   description: 'Electrolyte hazard (vented / VRLA cells)', isolationPoint: 'Battery cells', isolationMethod: 'PPE + insulated tools — cells remain live', verificationMethod: 'N/A — treat cells as always energized' }],
    steps: [
      ...GENERIC_STEPS_HEAD,
      { category: 'isolation', instruction: 'Open and lock the AC input and output/bypass breakers of the UPS or charger.' },
      { category: 'isolation', instruction: 'Open and lock the DC battery disconnect. The battery string itself stays energized — it cannot be locked out, only isolated.' },
      ...GENERIC_STEPS_TAIL.slice(0, 4),
      { category: 'verify',    instruction: 'Wait for internal DC bus capacitors to discharge per the manufacturer (typically ≥5 minutes), then verify zero volts on the bus.', requiresVerification: true },
      { category: 'verify',    instruction: 'Work on or near the battery string with insulated tools, voltage-rated gloves, and face protection — do NOT apply grounds to a battery.', requiresVerification: false },
      GENERIC_STEPS_TAIL[4],
    ],
  },
  generator: {
    sources: [{ energyType: 'electrical', description: 'EDIT: Generator output breaker', isolationPoint: 'EDIT: generator output breaker', isolationMethod: 'Open and lock', verificationMethod: 'Test for absence of voltage at the terminals' },
              { energyType: 'electrical', description: 'Starting battery / control power — auto-start hazard', isolationPoint: 'Battery disconnect + control switch', isolationMethod: 'Switch to OFF/RESET, disconnect starting battery, lock', verificationMethod: 'Confirm engine cannot crank' },
              { energyType: 'chemical',   description: 'Fuel supply to the engine', isolationPoint: 'EDIT: fuel shutoff valve', isolationMethod: 'Close and lock the valve', verificationMethod: 'Confirm valve position indicator shows closed' }],
    steps: [
      ...GENERIC_STEPS_HEAD,
      { category: 'isolation', instruction: 'Place the control switch in OFF/RESET so the unit cannot auto-start; lock the control panel.' },
      { category: 'isolation', instruction: 'Disconnect and lock out the starting battery (negative lead first) and any block-heater / jacket-water heater circuits.' },
      { category: 'isolation', instruction: 'Open and lock the generator output breaker; verify the transfer switch cannot backfeed the machine.' },
      { category: 'isolation', instruction: 'Close and lock the fuel supply valve.' },
      ...GENERIC_STEPS_TAIL.slice(0, 4),
      { category: 'verify',    instruction: 'Allow rotating parts and exhaust components to come to rest and cool before opening guards.', requiresVerification: false },
      GENERIC_STEPS_TAIL[4],
    ],
  },
  motor: {
    sources: [{ energyType: 'electrical', description: 'EDIT: Motor branch circuit / drive input', isolationPoint: 'EDIT: local disconnect or MCC bucket', isolationMethod: 'Open and lock the disconnect', verificationMethod: 'Test for absence of voltage at the motor leads (live-dead-live)' },
              { energyType: 'mechanical', description: 'Coupled load — rotation, gravity, or tension on the driven equipment', isolationPoint: 'EDIT: driven equipment (block / pin / brake)', isolationMethod: 'Block or restrain the load', verificationMethod: 'Confirm the shaft cannot rotate' }],
    steps: [
      ...GENERIC_STEPS_HEAD,
      { category: 'isolation', instruction: 'Open and lock the local disconnect or MCC bucket feeding the motor / drive.' },
      { category: 'isolation', instruction: 'For VFDs: wait the manufacturer-specified DC-bus discharge time (typically ≥5 minutes) before opening the drive enclosure.' },
      { category: 'isolation', instruction: 'Block, pin, or brake the driven equipment so stored mechanical energy (rotation, gravity, tension) cannot move it.' },
      ...GENERIC_STEPS_TAIL.slice(0, 4),
      { category: 'verify',    instruction: 'Verify zero volts on the drive DC bus terminals before touching internal components.', requiresVerification: true },
      GENERIC_STEPS_TAIL[4],
    ],
  },
  generic: {
    sources: [{ energyType: 'electrical', description: 'EDIT: Primary electrical feed — identify the upstream device', isolationPoint: 'EDIT: upstream disconnect / breaker', isolationMethod: 'Open and lock', verificationMethod: 'Test for absence of voltage (live-dead-live)' }],
    steps: [
      ...GENERIC_STEPS_HEAD,
      { category: 'isolation', instruction: 'Locate and operate every energy-isolating device (disconnects, breakers, valves) feeding this equipment.' },
      { category: 'isolation', instruction: 'Dissipate or restrain stored energy: discharge capacitors, release springs, block elevated parts, relieve pressure.' },
      ...GENERIC_STEPS_TAIL.slice(0, 4),
      { category: 'verify',    instruction: 'Apply temporary protective grounds where the work requires them, after verifying zero energy.', requiresVerification: false },
      GENERIC_STEPS_TAIL[4],
    ],
  },
};

// EquipmentType enum → template family.
function lotoTemplateFor(equipmentType) {
  const map = {
    TRANSFORMER_LIQUID: 'transformer', TRANSFORMER_DRY: 'transformer',
    UPS_BATTERY: 'battery', BATTERY_SYSTEM: 'battery',
    GENERATOR: 'generator', TRANSFER_SWITCH: 'generator',
    MOTOR: 'motor', VFD: 'motor',
    CIRCUIT_BREAKER: 'breaker', SWITCHGEAR: 'breaker', SWITCHBOARD: 'breaker',
    PANELBOARD: 'breaker', MCC: 'breaker', FUSE_GEAR: 'breaker',
    DISCONNECT_SWITCH: 'breaker', BUSWAY: 'breaker',
  };
  return LOTO_TEMPLATES[map[equipmentType]] || LOTO_TEMPLATES.generic;
}

function mkSource(overrides = {}) {
  return {
    _key: Math.random().toString(36).slice(2),
    energyType: 'electrical',
    description: '',
    isolationPoint: '',
    isolationMethod: '',
    verificationMethod: '',
    ...overrides,
  };
}

function mkStep(overrides = {}) {
  return {
    _key: Math.random().toString(36).slice(2),
    instruction: '',
    category: 'lockout',
    requiresVerification: false,
    ...overrides,
  };
}

function SectionHead({ children }) {
  return (
    <div style={{
      fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
      textTransform: 'uppercase', color: 'var(--color-text-secondary)', margin: '20px 0 10px',
      paddingBottom: 6, borderBottom: '1px solid var(--color-border)',
    }}>
      {children}
    </div>
  );
}

function FieldLabel({ children, required }) {
  return (
    <label style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
      {children}{required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
    </label>
  );
}

// ── Energy source row ─────────────────────────────────────────────────────────
function EnergySourceRow({ src, onChange, onRemove, idx }) {
  return (
    <div style={{
      background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
      borderRadius: 8, padding: 12, marginBottom: 10, position: 'relative',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
          Energy Source #{idx + 1}
        </span>
        <button type="button" onClick={onRemove}
          style={{ color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
      </div>
      {/* 2026-06-11: widened manual-entry inputs — description spans the full
          row and the remaining text fields flow on a wide auto-fit grid
          (min 240px each) instead of narrow 200px boxes, so typed text isn't
          cut off. The inputs themselves stretch to 100% of their cell. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
        <div>
          <FieldLabel required>Energy type</FieldLabel>
          <select className="input" style={{ width: '100%' }} value={src.energyType} onChange={e => onChange({ ...src, energyType: e.target.value })}>
            {ENERGY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <FieldLabel required>Description</FieldLabel>
          <input className="input" type="text" style={{ width: '100%' }} placeholder="e.g. 480V feed from MCC-1, breaker 14"
            value={src.description} onChange={e => onChange({ ...src, description: e.target.value })} />
        </div>
        <div>
          <FieldLabel required>Isolation point</FieldLabel>
          <input className="input" type="text" style={{ width: '100%' }} placeholder="e.g. Breaker 14 in MCC-1"
            value={src.isolationPoint} onChange={e => onChange({ ...src, isolationPoint: e.target.value })} />
        </div>
        <div>
          <FieldLabel required>Isolation method</FieldLabel>
          <input className="input" type="text" style={{ width: '100%' }} placeholder="e.g. Open breaker, apply LOTO hasp"
            value={src.isolationMethod} onChange={e => onChange({ ...src, isolationMethod: e.target.value })} />
        </div>
        <div style={{ gridColumn: '1 / -1' }}>
          <FieldLabel required>Verification method</FieldLabel>
          <input className="input" type="text" style={{ width: '100%' }} placeholder="e.g. Test load terminals with Fluke T6"
            value={src.verificationMethod} onChange={e => onChange({ ...src, verificationMethod: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

// ── Step row ──────────────────────────────────────────────────────────────────
function StepRow({ step, onChange, onRemove, onMoveUp, onMoveDown, idx, total }) {
  return (
    <div style={{
      background: 'var(--color-bg-secondary)', border: '1px solid var(--color-border)',
      borderRadius: 8, padding: 12, marginBottom: 8,
      display: 'flex', gap: 10, alignItems: 'flex-start',
    }}>
      {/* Order controls */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', textAlign: 'center', marginBottom: 4 }}>
          {idx + 1}
        </span>
        <button type="button" onClick={onMoveUp} disabled={idx === 0}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 14, padding: 0 }}>▲</button>
        <button type="button" onClick={onMoveDown} disabled={idx === total - 1}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-secondary)', fontSize: 14, padding: 0 }}>▼</button>
      </div>

      {/* 2026-06-11: flex-wrap layout — the instruction input takes the full
          remaining width (flex 1, min 320px) and wraps above the category /
          verify controls on narrow screens instead of squeezing. */}
      <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', minWidth: 0 }}>
        <div style={{ flex: '1 1 320px', minWidth: 0 }}>
          <FieldLabel required>Instruction</FieldLabel>
          <input className="input" type="text" style={{ width: '100%' }} placeholder="Describe this step…"
            value={step.instruction} onChange={e => onChange({ ...step, instruction: e.target.value })} />
        </div>
        <div>
          <FieldLabel>Category</FieldLabel>
          <select className="input" value={step.category} onChange={e => onChange({ ...step, category: e.target.value })}>
            {STEP_CATS.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div style={{ alignSelf: 'flex-end', paddingBottom: 4 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-xs)', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={step.requiresVerification}
              onChange={e => onChange({ ...step, requiresVerification: e.target.checked })} />
            Verification required
          </label>
        </div>
        <button type="button" onClick={onRemove}
          style={{ color: 'var(--color-danger)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1, alignSelf: 'flex-end', paddingBottom: 4 }}>×</button>
      </div>
    </div>
  );
}

// ── Main form ─────────────────────────────────────────────────────────────────
export default function LotoProcForm({ assetId, proc, equipmentType, onSaved, onCancel }) {
  const isEdit = Boolean(proc);

  const [title,   setTitle]   = useState(proc?.title || '');
  const [notes,   setNotes]   = useState(proc?.notes || '');
  const [sources, setSources] = useState(
    proc?.energySources?.length
      ? proc.energySources.map(s => ({ ...s, _key: s.id }))
      : [mkSource()]
  );
  const [steps, setSteps] = useState(
    proc?.steps?.length
      ? proc.steps.map(s => ({ ...s, _key: s.id }))
      : [
          mkStep({ category: 'shutdown',  instruction: 'Perform normal shutdown of the equipment.' }),
          mkStep({ category: 'isolation', instruction: 'Locate and operate all isolating devices.' }),
          mkStep({ category: 'lockout',   instruction: 'Apply personal LOTO lock to each isolation device.' }),
          mkStep({ category: 'verify',    instruction: 'Attempt restart to verify equipment cannot be energised.', requiresVerification: true }),
          mkStep({ category: 'verify',    instruction: 'Test all energy sources with appropriate meter to confirm zero-energy state.', requiresVerification: true }),
        ]
  );
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState(null);

  // Source mutations
  function updateSource(i, val) { setSources(s => s.map((x, j) => j === i ? val : x)); }
  function removeSource(i)      { setSources(s => s.filter((_, j) => j !== i)); }
  function addSource()          { setSources(s => [...s, mkSource()]); }

  // Step mutations
  function updateStep(i, val) { setSteps(s => s.map((x, j) => j === i ? val : x)); }
  function removeStep(i)      { setSteps(s => s.filter((_, j) => j !== i)); }
  function addStep()          { setSteps(s => [...s, mkStep()]); }
  function moveStep(i, dir)   {
    setSteps(s => {
      const a = [...s];
      const j = i + dir;
      if (j < 0 || j >= a.length) return a;
      [a[i], a[j]] = [a[j], a[i]];
      return a;
    });
  }

  // Pre-fill from the per-equipment-type standard template (OSHA
  // 1910.147-style sequence). Replaces current sources + steps with an
  // editable starting point — the user reviews, edits the EDIT-flagged
  // placeholders, and saves; nothing is applied automatically.
  function loadStandardTemplate() {
    if (!window.confirm('Replace the current energy sources and steps with the standard template for this equipment type? Your edits so far in this editor will be overwritten.')) return;
    const tpl = lotoTemplateFor(equipmentType);
    setSources(tpl.sources.map(s => mkSource(s)));
    setSteps(tpl.steps.map(s => mkStep(s)));
    if (!title.trim()) {
      const typeLabel = EQUIPMENT_TYPE_LABELS[equipmentType] || 'Equipment';
      setTitle(`${typeLabel} LOTO Procedure`);
    }
    setErr(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr(null);
    if (!title.trim()) { setErr('Title is required'); return; }

    // Validate sources
    for (const s of sources) {
      if (!s.description || !s.isolationPoint || !s.isolationMethod || !s.verificationMethod) {
        setErr('All energy source fields are required'); return;
      }
    }
    for (const s of steps) {
      if (!s.instruction.trim()) { setErr('All step instructions are required'); return; }
    }

    const payload = {
      title: title.trim(),
      notes: notes.trim() || null,
      energySources: sources.map((s, i) => ({
        energyType: s.energyType, description: s.description,
        isolationPoint: s.isolationPoint, isolationMethod: s.isolationMethod,
        verificationMethod: s.verificationMethod, sortOrder: i,
      })),
      steps: steps.map((s, i) => ({
        instruction: s.instruction, category: s.category,
        requiresVerification: s.requiresVerification, sortOrder: i,
      })),
    };

    setSaving(true);
    try {
      if (isEdit) {
        await api.put(`/api/assets/${assetId}/loto/${proc.id}`, payload);
      } else {
        await api.post(`/api/assets/${assetId}/loto`, payload);
      }
      onSaved();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to save procedure');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', marginBottom: 4 }}>
            {isEdit ? `Edit Procedure — Rev ${(proc.version || 1) + 1}` : 'New LOTO Procedure'}
          </div>
          {isEdit && (
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
              Saving will increment the revision to {(proc.version || 1) + 1} and reset status to Draft (re-approval required).
            </div>
          )}
        </div>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={loadStandardTemplate}
          title={`Pre-fills an editable OSHA 1910.147-style step sequence (de-energize, isolate, lock, tag, verify zero energy, ground as applicable) tailored to ${EQUIPMENT_TYPE_LABELS[equipmentType] || 'this equipment type'}. You review and edit before saving — nothing is applied automatically.`}
        >
          ⚡ Load standard template
        </button>
      </div>

      {/* ── Title + Notes ──────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 4 }}>
        <div>
          <FieldLabel required>Procedure title</FieldLabel>
          <input className="input" type="text" placeholder="e.g. 480V MCC-1 Lockout Procedure"
            value={title} onChange={e => setTitle(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Notes / scope limitations</FieldLabel>
          <input className="input" type="text" placeholder="Optional notes for this revision…"
            value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      {/* ── Energy Sources ─────────────────────────────────────────────────── */}
      <SectionHead>⚡ Energy Sources ({sources.length})</SectionHead>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
        List every energy source that must be isolated. OSHA 1910.147 requires all sources enumerated.
      </div>
      {sources.map((s, i) => (
        <EnergySourceRow key={s._key} src={s} idx={i}
          onChange={val => updateSource(i, val)}
          onRemove={() => removeSource(i)} />
      ))}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addSource} style={{ marginBottom: 8 }}>
        + Add energy source
      </button>

      {/* ── Steps ──────────────────────────────────────────────────────────── */}
      <SectionHead>📋 Procedure Steps ({steps.length})</SectionHead>
      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
        Ordered steps from shutdown through release. Mark verification steps so field workers know to record a reading.
      </div>
      {steps.map((s, i) => (
        <StepRow key={s._key} step={s} idx={i} total={steps.length}
          onChange={val => updateStep(i, val)}
          onRemove={() => removeStep(i)}
          onMoveUp={() => moveStep(i, -1)}
          onMoveDown={() => moveStep(i, 1)} />
      ))}
      <button type="button" className="btn btn-secondary btn-sm" onClick={addStep} style={{ marginBottom: 16 }}>
        + Add step
      </button>

      {/* ── Error + submit ─────────────────────────────────────────────────── */}
      {err && (
        <div style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginBottom: 12 }}>{err}</div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : isEdit ? 'Save Revision' : 'Create Procedure'}
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </form>
  );
}
