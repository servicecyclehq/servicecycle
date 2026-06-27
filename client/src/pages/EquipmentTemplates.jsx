// ─────────────────────────────────────────────────────────────────────────────
// EquipmentTemplates.jsx — Equipment Template Library (/equipment-templates).
//
// Browse global + account-custom equipment profiles. Each template pre-fills
// New Asset fields and auto-schedules its task list.
//
// Managers+ can create / edit / delete account-custom templates.
// Global (platform-seeded) templates are read-only.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Layers, Plus, Pencil, Trash2, ChevronRight, Zap } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EQUIPMENT_TYPE_LABELS } from '../lib/equipment';
import Toast from '../components/Toast';

// ── helpers ───────────────────────────────────────────────────────────────────

const CRITICALITY_LABELS = { 1: 'Very Low', 2: 'Low', 3: 'Moderate', 4: 'High', 5: 'Critical' };
const REDUNDANCY_LABELS  = { N: 'N (none)', N_PLUS_1: 'N+1', TWO_N: '2N (full)' };

function CritBadge({ score }) {
  if (!score) return <span style={{ color: 'var(--color-text-secondary)' }}>—</span>;
  // A2 (2026-06-11): semantic chip tokens — the old literal pastels
  // (#84cc16 lime, #f59e0b amber) were near-invisible text on a white card.
  const colors = [
    '',
    'var(--chip-green-fg, #166534)',
    'var(--chip-green-fg, #166534)',
    'var(--chip-amber-fg, #854d0e)',
    'var(--chip-orange-fg, #9a3412)',
    'var(--chip-red-fg, #991b1b)',
  ];
  return (
    <span style={{ color: colors[score] || 'inherit', fontWeight: 700 }}>
      {score} — {CRITICALITY_LABELS[score]}
    </span>
  );
}

function TemplateBadge({ isGlobal }) {
  // A2 (2026-06-11): both badges route through the --chip-* tokens so they
  // stay readable in dark mode (the old grey/white literals didn't).
  return isGlobal ? (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      padding: '2px 7px', borderRadius: 4,
      background: 'var(--chip-slate-bg, #f1f5f9)',
      color: 'var(--chip-slate-fg, #334155)', marginLeft: 6,
    }}>PLATFORM</span>
  ) : (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
      padding: '2px 7px', borderRadius: 4,
      background: 'var(--chip-blue-bg, #eff6ff)',
      color: 'var(--chip-blue-fg, #1d4ed8)', marginLeft: 6,
    }}>CUSTOM</span>
  );
}

// ── Template form modal ───────────────────────────────────────────────────────

function TemplateFormModal({ existing, allTasks, onSave, onClose }) {
  const isEdit = !!existing;
  const [form, setForm] = useState({
    name:                                existing?.name ?? '',
    description:                         existing?.description ?? '',
    equipmentType:                       existing?.equipmentType ?? '',
    defaultCriticalityScore:             existing?.defaultCriticalityScore ?? '',
    defaultRedundancyStatus:             existing?.defaultRedundancyStatus ?? '',
    defaultRequiresPredictiveMaintenance: existing?.defaultRequiresPredictiveMaintenance ?? false,
  });
  const [nameplateKeys, setNameplateKeys] = useState(
    existing?.nameplateDefaults
      ? Object.entries(existing.nameplateDefaults).map(([k, v]) => ({ key: k, hint: String(v) }))
      : [{ key: '', hint: '' }]
  );
  const [selectedTaskIds, setSelectedTaskIds] = useState(
    new Set((existing?.taskDefinitions ?? []).map(t => t.id))
  );
  const [saving, setSaving] = useState(false);
  const [err,    setErr]    = useState('');

  const field = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));
  const check = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.checked }));

  function toggleTask(id) {
    setSelectedTaskIds(s => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function addNpRow() { setNameplateKeys(r => [...r, { key: '', hint: '' }]); }
  function removeNpRow(i) { setNameplateKeys(r => r.filter((_, idx) => idx !== i)); }
  function setNpField(i, field, val) {
    setNameplateKeys(r => r.map((row, idx) => idx === i ? { ...row, [field]: val } : row));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    setSaving(true);
    try {
      const nameplateDefaults = {};
      for (const { key, hint } of nameplateKeys) {
        if (key.trim()) nameplateDefaults[key.trim()] = hint;
      }
      const payload = {
        ...form,
        defaultCriticalityScore: form.defaultCriticalityScore !== '' ? Number(form.defaultCriticalityScore) : null,
        defaultRedundancyStatus: form.defaultRedundancyStatus || null,
        nameplateDefaults: Object.keys(nameplateDefaults).length ? nameplateDefaults : null,
        taskDefinitionIds: Array.from(selectedTaskIds),
      };
      if (isEdit) {
        await api.put(`/api/asset-templates/${existing.id}`, payload);
      } else {
        await api.post('/api/asset-templates', payload);
      }
      onSave();
    } catch (e) {
      setErr(e?.response?.data?.error || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  // Filter tasks to the selected equipment type
  const relevantTasks = form.equipmentType
    ? allTasks.filter(t => t.equipmentType === form.equipmentType)
    : allTasks;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 1000,
      display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
      overflowY: 'auto', padding: '40px 16px',
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="card" style={{ width: '100%', maxWidth: 640, padding: 0, overflow: 'hidden' }}>
        <div className="card-header">
          <div className="card-title">{isEdit ? 'Edit Template' : 'New Template'}</div>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {err && (
              <div style={{ padding: '8px 12px', background: '#fff1f1', border: '1px solid #fecaca',
                borderRadius: 6, color: '#b91c1c', fontSize: 'var(--font-size-sm)' }}>{err}</div>
            )}

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 240px' }}>
                <label className="form-label">Name *</label>
                <input className="input" value={form.name} onChange={field('name')} required placeholder="e.g. Pad-Mount Transformer 500 kVA" />
              </div>
              <div style={{ flex: '1 1 200px' }}>
                <label className="form-label">Equipment Type *</label>
                <select className="input" value={form.equipmentType} onChange={field('equipmentType')} required>
                  <option value="">— select —</option>
                  {Object.entries(EQUIPMENT_TYPE_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="form-label">Description</label>
              <textarea className="input" value={form.description} onChange={field('description')}
                rows={2} placeholder="Short description for users browsing templates" style={{ resize: 'vertical' }} />
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 160px' }}>
                <label className="form-label">Default Criticality (1–5)</label>
                <select className="input" value={form.defaultCriticalityScore} onChange={field('defaultCriticalityScore')}>
                  <option value="">Not set</option>
                  {[1,2,3,4,5].map(n => <option key={n} value={n}>{n} — {CRITICALITY_LABELS[n]}</option>)}
                </select>
              </div>
              <div style={{ flex: '1 1 160px' }}>
                <label className="form-label">Default Redundancy</label>
                <select className="input" value={form.defaultRedundancyStatus} onChange={field('defaultRedundancyStatus')}>
                  <option value="">Not set</option>
                  {Object.entries(REDUNDANCY_LABELS).map(([val, label]) => (
                    <option key={val} value={val}>{label}</option>
                  ))}
                </select>
              </div>
              <div style={{ flex: '1 1 auto', paddingBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.defaultRequiresPredictiveMaintenance}
                    onChange={check('defaultRequiresPredictiveMaintenance')} />
                  <span className="form-label" style={{ marginBottom: 0 }}>Requires predictive maintenance</span>
                </label>
              </div>
            </div>

            {/* Nameplate defaults */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <label className="form-label" style={{ marginBottom: 0 }}>Nameplate field hints</label>
                <button type="button" className="btn btn-secondary btn-sm" onClick={addNpRow}>+ Add field</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {nameplateKeys.map((row, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="input" value={row.key} onChange={e => setNpField(i, 'key', e.target.value)}
                      placeholder="Field name (e.g. kVA)" style={{ flex: '0 0 160px' }} />
                    <input className="input" value={row.hint} onChange={e => setNpField(i, 'hint', e.target.value)}
                      placeholder="Default / hint value" style={{ flex: 1 }} />
                    <button type="button" onClick={() => removeNpRow(i)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-danger)', padding: 4 }}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Task definitions */}
            {relevantTasks.length > 0 && (
              <div>
                <label className="form-label">Tasks to auto-schedule ({selectedTaskIds.size} selected)</label>
                <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--color-border)',
                  borderRadius: 6, padding: '6px 0' }}>
                  {relevantTasks.map(t => (
                    <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10,
                      padding: '5px 12px', cursor: 'pointer',
                      background: selectedTaskIds.has(t.id) ? 'var(--color-bg-secondary)' : 'transparent',
                    }}>
                      <input type="checkbox" checked={selectedTaskIds.has(t.id)}
                        onChange={() => toggleTask(t.id)} />
                      <span style={{ flex: 1, fontSize: 'var(--font-size-sm)' }}>{t.taskName}</span>
                      {t.standardRef && (
                        <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{t.standardRef}</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}

          </div>
          <div style={{ padding: '12px 20px', borderTop: '1px solid var(--color-border)',
            display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Create Template')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function EquipmentTemplates() {
  useDocumentTitle('Equipment Templates');
  const { role } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const canWrite = ['admin','manager'].includes(role);

  const [templates,  setTemplates]  = useState([]);
  const [allTasks,   setAllTasks]   = useState([]);
  const [filter,     setFilter]     = useState('');
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [toast,      setToast]      = useState(null);
  const [showForm,   setShowForm]   = useState(false);
  const [editTarget, setEditTarget] = useState(null); // template to edit

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [tmplRes, taskRes] = await Promise.all([
        api.get('/api/asset-templates'),
        api.get('/api/standards/task-definitions'),
      ]);
      setTemplates(tmplRes.data?.data?.templates ?? []);
      setAllTasks(taskRes.data?.data?.taskDefinitions ?? []);
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(t) {
    if (!await confirm({
      title: 'Delete template?',
      message: `Delete template "${t.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
    })) return;
    try {
      await api.delete(`/api/asset-templates/${t.id}`);
      setToast({ message: `Deleted "${t.name}"`, type: 'success' });
      load();
    } catch (e) {
      setToast({ message: e?.response?.data?.error || 'Delete failed', type: 'error' });
    }
  }

  const filtered = filter
    ? templates.filter(t =>
        t.equipmentType === filter ||
        t.name.toLowerCase().includes(filter.toLowerCase())
      )
    : templates;

  return (
    <div className="page-container">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      {(showForm || editTarget) && (
        <TemplateFormModal
          existing={editTarget}
          allTasks={allTasks}
          onSave={() => { setShowForm(false); setEditTarget(null); setToast({ message: 'Template saved', type: 'success' }); load(); }}
          onClose={() => { setShowForm(false); setEditTarget(null); }}
        />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        flexWrap: 'wrap', gap: 12, marginBottom: 24 }}>
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Layers size={22} strokeWidth={1.75} />
            Equipment Templates
          </h1>
          <p style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)', margin: '4px 0 0' }}>
            Pre-built equipment profiles — pick a template when adding an asset to pre-fill fields and auto-schedule its task list.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link to="/assets/new" className="btn btn-secondary btn-sm">
            <Zap size={14} style={{ marginRight: 5 }} /> New Asset
          </Link>
          {canWrite && (
            <button className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
              <Plus size={14} style={{ marginRight: 5 }} /> New Template
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ marginBottom: 20 }}>
        <input
          className="input"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by name or equipment type…"
          style={{ maxWidth: 360 }}
        />
      </div>

      {loading && <div style={{ color: 'var(--color-text-secondary)', padding: 32, textAlign: 'center' }}>Loading…</div>}
      {error   && <div style={{ color: 'var(--color-danger)', padding: 16 }}>{error}</div>}

      {!loading && !error && filtered.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--color-text-secondary)' }}>
          <Layers size={40} strokeWidth={1} style={{ marginBottom: 12 }} />
          <div style={{ fontWeight: 600 }}>No templates found</div>
          <div style={{ fontSize: 'var(--font-size-sm)', marginTop: 4 }}>
            {filter ? 'Try a different filter.' : 'Templates will appear here once the seed data is applied.'}
          </div>
        </div>
      )}

      {/* Template cards — flat 3-per-row grid (A6, 2026-06-11; was one
          section per equipment type, each card on its own row). The type
          now renders as an eyebrow label inside each card. */}
      {!loading && !error && filtered.length > 0 && (
          <div className="template-grid">
            {filtered.map(t => (
              <div key={t.id} className="card" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <div style={{ padding: '14px 16px 12px', flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--font-size-2xs, 10px)', fontWeight: 700, letterSpacing: '0.06em',
                        textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 3 }}>
                        {EQUIPMENT_TYPE_LABELS[t.equipmentType] || t.equipmentType}
                      </div>
                      <div style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
                        {t.name}
                        <TemplateBadge isGlobal={t.isGlobal} />
                      </div>
                      {t.description && (
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)',
                          marginTop: 4, lineHeight: 1.4 }}>
                          {t.description}
                        </div>
                      )}
                    </div>
                    {/* Action buttons — only for account-custom */}
                    {!t.isGlobal && canWrite && (
                      <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                        <button onClick={() => setEditTarget(t)} title="Edit"
                          style={{ background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--color-text-secondary)', padding: 4 }}>
                          <Pencil size={14} />
                        </button>
                        <button onClick={() => handleDelete(t)} title="Delete"
                          style={{ background: 'none', border: 'none', cursor: 'pointer',
                            color: 'var(--color-danger)', padding: 4 }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Defaults summary */}
                  <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10,
                    fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                    <span>Criticality: <CritBadge score={t.defaultCriticalityScore} /></span>
                    {t.defaultRedundancyStatus && (
                      <span>Redundancy: <strong style={{ color: 'var(--color-text)' }}>
                        {REDUNDANCY_LABELS[t.defaultRedundancyStatus] || t.defaultRedundancyStatus}
                      </strong></span>
                    )}
                    {t.defaultRequiresPredictiveMaintenance && (
                      <span style={{ color: '#7c3aed' }}>Predictive mtce.</span>
                    )}
                  </div>

                  {/* Tasks */}
                  {t.taskDefinitions.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, marginBottom: 4 }}>
                        {t.taskDefinitions.length} task{t.taskDefinitions.length !== 1 ? 's' : ''}
                      </div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {t.taskDefinitions.slice(0, 4).map(td => (
                          <span key={td.id} style={{
                            fontSize: 11, padding: '2px 7px', borderRadius: 10,
                            background: 'var(--chip-slate-bg, #f1f5f9)',
                            color: 'var(--chip-slate-fg, #334155)',
                          }}>
                            {td.taskName}
                          </span>
                        ))}
                        {t.taskDefinitions.length > 4 && (
                          <span style={{ fontSize: 11, color: 'var(--color-text-secondary)', padding: '2px 4px' }}>
                            +{t.taskDefinitions.length - 4} more
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Use template CTA */}
                <div style={{ borderTop: '1px solid var(--color-border)', padding: '8px 16px',
                  background: 'var(--color-bg-secondary)' }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    style={{ width: '100%', justifyContent: 'center' }}
                    onClick={() => navigate(`/assets/new?templateId=${t.id}`)}
                  >
                    Use this template <ChevronRight size={13} style={{ marginLeft: 4 }} />
                  </button>
                </div>
              </div>
            ))}
          </div>
      )}
    </div>
  );
}
