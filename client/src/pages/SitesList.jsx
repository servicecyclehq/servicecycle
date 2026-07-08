// ─────────────────────────────────────────────────────────────────────────────
// SitesList.jsx — facility directory.
//
// GET /api/sites → data.sites, each decorated server-side with assetCount and
// openDeficiencyCount (archived sites are excluded by default). Row click
// drills into /sites/:id. Admin/manager get an "Add site" modal → POST /api/sites.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, MapPin } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import EmptyState from '../components/EmptyState';
import { useFromState } from '../components/BackLink';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useFocusTrap } from '../hooks/useFocusTrap';

const EMPTY_FORM = {
  name: '', address: '', city: '', state: '', postalCode: '',
  primaryContactName: '', primaryContactEmail: '', primaryContactPhone: '',
  notes: '',
};

function Field({ label, required, children }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 'var(--font-size-sm)', fontWeight: 600, marginBottom: 4 }}>
        {label}{required && <span style={{ color: 'var(--color-danger)' }}> *</span>}
      </label>
      {children}
    </div>
  );
}

function AddSiteModal({ onClose, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  // Audit 2026-07-08 (~9 of 16 dialogs missing useFocusTrap).
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, { onClose, autoFocus: true });

  async function submit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Site name is required.'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await api.post('/api/sites', form);
      onCreated(res.data?.data?.site);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create site.');
      setSaving(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog" aria-modal="true" aria-label="Add site"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1050, background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--color-surface)', color: 'var(--color-text)',
          borderRadius: 'var(--radius-lg)', boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          maxWidth: 520, width: '100%', maxHeight: '90vh', overflowY: 'auto',
          padding: '20px 24px',
        }}
      >
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, marginBottom: 14 }}>Add site</div>
        {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

        <Field label="Name" required>
          <input className="form-control form-control-wide" value={form.name} onChange={set('name')} maxLength={200} autoFocus required />
        </Field>
        <Field label="Address">
          <input className="form-control form-control-wide" value={form.address} onChange={set('address')} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 10 }}>
          <Field label="City">
            <input className="form-control form-control-wide" value={form.city} onChange={set('city')} />
          </Field>
          <Field label="State">
            <input className="form-control form-control-wide" value={form.state} onChange={set('state')} />
          </Field>
          <Field label="Postal code">
            <input className="form-control form-control-wide" value={form.postalCode} onChange={set('postalCode')} />
          </Field>
        </div>
        <Field label="Primary contact name">
          <input className="form-control form-control-wide" value={form.primaryContactName} onChange={set('primaryContactName')} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Contact email">
            <input type="email" className="form-control form-control-wide" value={form.primaryContactEmail} onChange={set('primaryContactEmail')} />
          </Field>
          <Field label="Contact phone">
            <input className="form-control form-control-wide" value={form.primaryContactPhone} onChange={set('primaryContactPhone')} />
          </Field>
        </div>
        <Field label="Notes">
          <textarea className="form-control" rows={3} value={form.notes} onChange={set('notes')} />
        </Field>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving || !form.name.trim()}>
            {saving ? 'Creating…' : 'Create site'}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function SitesList() {
  useDocumentTitle('Sites');
  const { user } = useAuth();
  const navigate = useNavigate();
  // C1: row clicks record this list as the origin for SiteDetail's BackLink.
  const fromState = useFromState();
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdd, setShowAdd] = useState(false);

  const canWrite = ['admin', 'manager'].includes(user?.role);

  function fetchSites() {
    setLoading(true);
    api.get('/api/sites')
      .then(r => setSites(r.data?.data?.sites || []))
      .catch(() => setError('Failed to load sites.'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { fetchSites(); }, []);

  function handleCreated(site) {
    setShowAdd(false);
    if (site?.id) navigate(`/sites/${site.id}`, { state: fromState });
    else fetchSites();
  }

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Sites</h1>
          <div className="page-subtitle">
            {loading ? 'Loading…' : `${sites.length} site${sites.length !== 1 ? 's' : ''}`}
          </div>
        </div>
        {canWrite && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={14} strokeWidth={1.75} style={{ verticalAlign: '-2px', marginRight: 6 }} />
            Add site
          </button>
        )}
      </div>

      <div className="page-body">
        {error && <div role="alert" className="alert alert-error mb-16">{error}</div>}
        {loading && <div className="loading">Loading sites…</div>}

        {!loading && sites.length === 0 && !error && (
          <div className="card">
            <EmptyState
              icon={MapPin}
              title="No sites yet"
              sub="Sites are the top of your facility hierarchy — buildings, areas, and equipment positions all hang off a site."
              ctaLabel={canWrite ? 'Add your first site' : undefined}
              ctaOnClick={canWrite ? () => setShowAdd(true) : undefined}
            />
          </div>
        )}

        {!loading && sites.length > 0 && (
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Location</th>
                    <th style={{ textAlign: 'right' }}>Assets</th>
                    <th style={{ textAlign: 'right' }}>Open deficiencies</th>
                  </tr>
                </thead>
                <tbody>
                  {sites.map(s => {
                    const go = () => navigate(`/sites/${s.id}`, { state: fromState });
                    const loc = [s.city, s.state].filter(Boolean).join(', ');
                    const defCount = s.openDeficiencyCount ?? 0;
                    return (
                      <tr
                        key={s.id}
                        style={{ cursor: 'pointer' }}
                        onClick={go} tabIndex={0} onKeyDown={kbdActivate(go)}
                      >
                        <td>
                          <div style={{ fontWeight: 600 }}>{s.name}</div>
                          {s.address && (
                            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>{s.address}</div>
                          )}
                        </td>
                        <td className="td-muted">{loc || '—'}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>
                          {s.assetCount ?? s._count?.assets ?? 0}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          {defCount > 0 ? (
                            <span style={{ fontWeight: 700, color: 'var(--color-danger)' }}>{defCount}</span>
                          ) : (
                            <span className="text-muted">0</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {showAdd && <AddSiteModal onClose={() => setShowAdd(false)} onCreated={handleCreated} />}
    </>
  );
}
