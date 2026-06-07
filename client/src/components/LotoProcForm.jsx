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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10 }}>
        <div>
          <FieldLabel required>Energy type</FieldLabel>
          <select className="input" value={src.energyType} onChange={e => onChange({ ...src, energyType: e.target.value })}>
            {ENERGY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div style={{ gridColumn: 'span 2' }}>
          <FieldLabel required>Description</FieldLabel>
          <input className="input" type="text" placeholder="e.g. 480V feed from MCC-1, breaker 14"
            value={src.description} onChange={e => onChange({ ...src, description: e.target.value })} />
        </div>
        <div>
          <FieldLabel required>Isolation point</FieldLabel>
          <input className="input" type="text" placeholder="e.g. Breaker 14 in MCC-1"
            value={src.isolationPoint} onChange={e => onChange({ ...src, isolationPoint: e.target.value })} />
        </div>
        <div>
          <FieldLabel required>Isolation method</FieldLabel>
          <input className="input" type="text" placeholder="e.g. Open breaker, apply LOTO hasp"
            value={src.isolationMethod} onChange={e => onChange({ ...src, isolationMethod: e.target.value })} />
        </div>
        <div>
          <FieldLabel required>Verification method</FieldLabel>
          <input className="input" type="text" placeholder="e.g. Test load terminals with Fluke T6"
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

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 10, alignItems: 'center' }}>
        <div>
          <FieldLabel required>Instruction</FieldLabel>
          <input className="input" type="text" placeholder="Describe this step…"
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
export default function LotoProcForm({ assetId, proc, onSaved, onCancel }) {
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
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', marginBottom: 4 }}>
          {isEdit ? `Edit Procedure — Rev ${(proc.version || 1) + 1}` : 'New LOTO Procedure'}
        </div>
        {isEdit && (
          <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
            Saving will increment the revision to {(proc.version || 1) + 1} and reset status to Draft (re-approval required).
          </div>
        )}
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
