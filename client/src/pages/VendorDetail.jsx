import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useLocation, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useAiConsent } from '../context/AiConsentContext';
import { useConfirm } from '../context/ConfirmContext';
import AiDisclaimer from '../components/AiDisclaimer';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { readContractOrigin, clearContractOrigin } from '../lib/contractOrigin';

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fmtMoney(cost, qty) {
  if (!cost || !qty) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
    .format(parseFloat(cost) * parseInt(qty));
}
const STATUS_LABELS = { active: 'Active', under_review: 'Under Review', renewed: 'Renewed', cancelled: 'Cancelled', expired: 'Expired' };
function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABELS[status] || status}</span>;
}
const COMM_LABELS = { call: 'Call', email_thread: 'Email', meeting: 'Meeting', note: 'Note' };
const COMM_COLORS = { call: 'var(--color-info)', email_thread: 'var(--color-primary)', meeting: 'var(--color-renewal-text)', note: 'var(--color-text-secondary)' };

// ── Signature Import Modal ────────────────────────────────────────────────────
function SignatureImportModal({ vendorId, onImported, onClose }) {
  const [mode, setMode] = useState('text'); // 'text' | 'image'
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [extracted, setExtracted] = useState(null);
  const { requestConsent } = useAiConsent(); // Phase 4: gate signature AI extraction
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef();

  async function handleExtract() {
    // Phase 4: gate signature AI extraction behind the consent modal.
    requestConsent(() => doExtract());
  }

  async function doExtract() {
    setLoading(true); setError('');
    try {
      let data;
      if (mode === 'text') {
        const res = await api.post('/api/signature/extract', { text });
        data = res.data.data.contact;
      } else {
        const form = new FormData();
        form.append('image', file);
        const res = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/signature/extract`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${localStorage.getItem('lapseiq_token')}` },
          body: form,
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error);
        data = json.data.contact;
      }
      setExtracted(data);
    } catch (err) {
      // L1: AI daily-cap (per user, per action, per UTC day). Surfaces in
      // demo mode where the cap is forced to 2; on self-hosted the cap is
      // unlimited by default so this branch effectively never fires.
      // axios surfaces the server error on err.response.data.error; the
      // fetch() image path puts it directly on err.message.
      const code = err?.response?.data?.error || err?.message;
      if (code === 'ai_daily_cap_reached') {
        setError('You’ve hit today’s AI extraction limit on this demo. Resets at midnight UTC.');
      } else {
        setError(err.message || 'Extraction failed');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      await api.post(`/api/vendors/${vendorId}/contacts`, {
        name: extracted.name,
        title: extracted.title,
        email: extracted.email,
        phone: extracted.phone,
        notes: [
          extracted.fax ? `Fax: ${extracted.fax}` : null,
          extracted.address ? `Address: ${extracted.address}` : null,
          extracted.notes || null,
        ].filter(Boolean).join('\n') || null,
      });
      onImported();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ width: '100%', maxWidth: 520, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="card-title">✉️ Signature Import</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--color-text-secondary)' }}>×</button>
        </div>
        <div className="card-body">
          {!extracted ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button className={`btn ${mode === 'text' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('text')} style={{ fontSize: 'var(--font-size-ui)' }}>
                  Paste Signature
                </button>
                <button className={`btn ${mode === 'image' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setMode('image')} style={{ fontSize: 'var(--font-size-ui)' }}>
                  Upload Business Card
                </button>
              </div>

              {mode === 'text' ? (
                <>
                  <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                    Paste an email signature below — Claude will extract the contact details.
                  </p>
                  <textarea
                    className="form-input"
                    rows={8}
                    value={text}
                    onChange={e => setText(e.target.value)}
                    placeholder={`John Smith\nSenior Account Executive\nAcme Software Inc.\njohn.smith@acme.com\n+1 (555) 234-5678\nwww.acme.com`}
                    style={{ width: '100%', resize: 'vertical', fontFamily: 'monospace', fontSize: 'var(--font-size-ui)' }}
                  />
                </>
              ) : (
                <>
                  <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                    Upload a photo of a business card — Claude will read and extract the contact info.
                  </p>
                  <input ref={fileRef} type="file" accept=".jpg,.jpeg,.png,.webp,.tiff,.tif" style={{ display: 'none' }} onChange={e => setFile(e.target.files[0])} />
                  <div
                    onClick={() => fileRef.current.click()} role="button" tabIndex={0} onKeyDown={kbdActivate(() => fileRef.current.click())}
                    style={{ border: '2px dashed var(--color-border-strong)', borderRadius: 'var(--radius)', padding: '24px', textAlign: 'center', cursor: 'pointer', background: 'var(--color-bg)' }}
                  >
                    {file ? (
                      <div style={{ fontWeight: 600 }}>{file.name}</div>
                    ) : (
                      <div style={{ color: 'var(--color-text-secondary)' }}>Click to upload JPG, PNG, or TIFF</div>
                    )}
                  </div>
                </>
              )}

              {error && <div role="alert" className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}

              <button
                className="btn btn-primary"
                style={{ width: '100%', marginTop: 16 }}
                onClick={handleExtract}
                disabled={loading || (mode === 'text' ? !text.trim() : !file)}
              >
                {loading ? '⏳ Extracting…' : 'Extract Contact Info'}
              </button>
            </>
          ) : (
            <>
              <AiDisclaimer variant="extract" style={{ marginBottom: 12 }} />
              <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 16 }}>Review the extracted info before saving.</p>
              {[
                ['Name', 'name'], ['Title', 'title'], ['Company', 'company'],
                ['Email', 'email'], ['Phone', 'phone'], ['Fax', 'fax'],
                ['Address', 'address'], ['Website', 'website'],
              ].map(([label, key]) => extracted[key] ? (
                <div key={key} style={{ marginBottom: 10 }}>
                  <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 700, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{label}</div>
                  <input
                    className="form-input"
                    value={extracted[key] || ''}
                    onChange={e => setExtracted(prev => ({ ...prev, [key]: e.target.value }))}
                    style={{ width: '100%' }}
                  />
                </div>
              ) : null)}

              {error && <div role="alert" className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}

              <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                <button className="btn btn-secondary" onClick={() => setExtracted(null)} disabled={saving}>Back</button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleSave} disabled={saving}>
                  {saving ? 'Saving…' : '✓ Save Contact'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Contact card ──────────────────────────────────────────────────────────────
function ContactCard({ contact, onEdit, onDelete, canEdit }) {
  return (
    <div style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '14px 16px', background: 'var(--color-surface)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 'var(--font-size-base)' }}>{contact.name}</div>
          {contact.title && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>{contact.title}</div>}
        </div>
        {canEdit && (
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => onEdit(contact)} style={{ fontSize: 'var(--font-size-sm)', padding: '3px 10px' }}>Edit</button>
            <button className="btn btn-secondary btn-sm" onClick={() => onDelete(contact.id)} style={{ fontSize: 'var(--font-size-sm)', padding: '3px 10px', color: 'var(--color-danger)' }}>Delete</button>
          </div>
        )}
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: '6px 20px' }}>
        {contact.email && <a href={`mailto:${contact.email}`} style={{ fontSize: 'var(--font-size-ui)' }}>✉ {contact.email}</a>}
        {contact.phone && <span style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)' }}>📞 {contact.phone}</span>}
      </div>
      {contact.notes && <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 8, whiteSpace: 'pre-line' }}>{contact.notes}</div>}
    </div>
  );
}

// ── Contact form (add/edit) ───────────────────────────────────────────────────
function ContactForm({ vendorId, initial, onSaved, onCancel }) {
  const [form, setForm] = useState({ name: '', title: '', email: '', phone: '', notes: '', ...initial });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (initial?.id) {
        await api.put(`/api/vendors/${vendorId}/contacts/${initial.id}`, form);
      } else {
        await api.post(`/api/vendors/${vendorId}/contacts`, form);
      }
      onSaved();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ background: 'var(--color-primary-light)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 12 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
        {[['Name *', 'name', true], ['Title', 'title', false], ['Email', 'email', false], ['Phone', 'phone', false]].map(([label, key, required]) => (
          <div key={key} style={{ marginBottom: 10 }}>
            <label className="form-label">{label}</label>
            <input className="form-input" value={form[key] || ''} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} required={required} style={{ width: '100%' }} />
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 10 }}>
        <label className="form-label">Notes</label>
        <textarea className="form-input" value={form.notes || ''} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={2} style={{ width: '100%', resize: 'vertical' }} />
      </div>
      {error && <div role="alert" className="alert alert-error" style={{ marginBottom: 10 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={saving}>Cancel</button>
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : initial?.id ? 'Save Changes' : 'Add Contact'}</button>
      </div>
    </form>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function VendorDetail() {
  useDocumentTitle('Vendor');
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // #4 contract-section-refresh: if we arrived here from a contract, the origin
  // context lets us render a persistent "Back to [contract]" link that returns
  // to the exact contract + tab + section + scroll. Captured once on mount
  // (router state preferred, sessionStorage mirror as the hard-reload fallback).
  const [contractOrigin] = useState(() => readContractOrigin(location.state?.contractOrigin));
  const goBackToContract = () => {
    if (!contractOrigin) { navigate('/vendors'); return; }
    clearContractOrigin();
    navigate(contractOrigin.url, { state: { restoreScroll: contractOrigin.scrollY } });
  };
  const { features } = useAuth();
  const confirm = useConfirm();
  const canEdit = features.vendors_write;

  const [vendor, setVendor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('contracts'); // 'contracts' | 'contacts' | 'communications'
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContact, setEditingContact] = useState(null);
  const [showSignatureImport, setShowSignatureImport] = useState(false);
  const [showCommForm, setShowCommForm] = useState(false);
  const [commForm, setCommForm] = useState({ type: 'note', subject: '', body: '', occurredAt: new Date().toISOString().split('T')[0] });

  function load() {
    setLoading(true);
    api.get(`/api/vendors/${id}`)
      .then(r => { setVendor(r.data.data.vendor); setLoading(false); })
      .catch(() => { setError('Failed to load vendor.'); setLoading(false); });
  }

  useEffect(() => { load(); }, [id]);

  function startEdit() {
    setForm({
      name: vendor.name,
      vendorType: vendor.vendorType || '',
      criticalityTier: vendor.criticalityTier || '',
      notes: vendor.notes || '',
      cotermComplexity: vendor.cotermComplexity || 'none',
      cotermNotes: vendor.cotermNotes || '',
      supportEmail: vendor.supportEmail || '',
      supportPhone: vendor.supportPhone || '',
      supportPortalUrl: vendor.supportPortalUrl || '',
    });
    setEditing(true);
  }

  async function handleSave() {
    setSaving(true); setSaveError('');
    try {
      const res = await api.put(`/api/vendors/${id}`, form);
      setVendor(prev => ({ ...prev, ...res.data.data.vendor }));
      setEditing(false);
    } catch (err) {
      setSaveError(err.response?.data?.error || 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteContact(contactId) {
    if (!await confirm({
      title: 'Remove contact',
      message: 'Remove this contact from the vendor?',
      confirmLabel: 'Remove',
      danger: true,
    })) return;
    await api.delete(`/api/vendors/${id}/contacts/${contactId}`);
    load();
  }

  async function handleAddComm(e) {
    e.preventDefault();
    try {
      await api.post(`/api/vendors/${id}/communications`, commForm);
      setShowCommForm(false);
      setCommForm({ type: 'note', subject: '', body: '', occurredAt: new Date().toISOString().split('T')[0] });
      load();
    } catch {}
  }

  if (loading) return <div className="loading">Loading vendor…</div>;
  if (error) return <div className="page-body"><div role="alert" className="alert alert-error">{error}</div></div>;
  if (!vendor) return null;

  const totalSpend = vendor.contracts
    .filter(c => c.status === 'active')
    .reduce((sum, c) => sum + (c.costPerLicense && c.quantity ? parseFloat(c.costPerLicense) * c.quantity : 0), 0);

  return (
    <>
      {/* Header */}
      <div className="page-header">
        <div>
          {contractOrigin ? (
            <button type="button" onClick={goBackToContract} className="back-link" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}>← Back to {contractOrigin.label}</button>
          ) : (
            <Link to="/vendors" className="back-link">← All Vendors</Link>
          )}
          <h1 className="page-title">{vendor.name}</h1>
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            {/* 2026-05-10 review M8 fix: drop the dangling " ·" when there's
                no active-spend value to follow (Atlassian-like vendors with
                only expired contracts had a trailing separator). */}
            {vendor.vendorType && (
              <span style={{ marginRight: 8 }}>
                <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, padding: '2px 8px', borderRadius: 4, background: 'var(--color-surface)', border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}>
                  {vendor.vendorType}
                </span>
                {' '}
              </span>
            )}
            {vendor.criticalityTier && (
              <span style={{ marginRight: 8 }}>
                <span title="Strategic tier (vendor criticality, distinct from spend)" style={{
                  fontSize: 'var(--font-size-xs)', fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                  background: vendor.criticalityTier === 'tier_1' ? '#fee2e2' : vendor.criticalityTier === 'tier_2' ? '#fef3c7' : 'var(--color-surface)',
                  color:      vendor.criticalityTier === 'tier_1' ? '#991b1b' : vendor.criticalityTier === 'tier_2' ? '#92400e' : 'var(--color-text-secondary)',
                  border: '1px solid var(--color-border)',
                  textTransform: 'uppercase', letterSpacing: '0.05em',
                }}>
                  {vendor.criticalityTier === 'tier_1' ? 'Tier 1' : vendor.criticalityTier === 'tier_2' ? 'Tier 2' : vendor.criticalityTier === 'tier_3' ? 'Tier 3' : 'Tier 4'}
                </span>
                {' '}
              </span>
            )}
            {vendor.contracts.length} contract{vendor.contracts.length !== 1 ? 's' : ''}
            {totalSpend > 0 && (
              <>
                {' · '}
                {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalSpend)} active spend
              </>
            )}
          </div>
        </div>
        {canEdit && !editing && (
          <button className="btn btn-secondary" onClick={startEdit}>Edit Vendor</button>
        )}
        {editing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary" onClick={() => setEditing(false)} disabled={saving}>Discard</button>
            <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</button>
          </div>
        )}
      </div>

      <div className="page-body">
        {saveError && <div role="alert" className="alert alert-error" style={{ marginBottom: 16 }}>{saveError}</div>}

        {/* Edit form */}
        {editing && (
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header"><h2 className="card-title">Edit Vendor</h2></div>
            <div className="card-body">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px' }}>
                {[['Vendor Name', 'name'], ['Support Email', 'supportEmail'], ['Support Phone', 'supportPhone'], ['Support Portal URL', 'supportPortalUrl']].map(([label, key]) => (
                  <div key={key} style={{ marginBottom: 14 }}>
                    <label className="form-label">{label}</label>
                    <input className="form-input" value={form[key] || ''} onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))} style={{ width: '100%' }} />
                  </div>
                ))}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 20px', marginBottom: 14 }}>
                <div>
                  <label className="form-label">Vendor Type</label>
                  <select aria-label="Vendor type" className="form-input" value={form.vendorType || ''} onChange={e => setForm(p => ({ ...p, vendorType: e.target.value }))} style={{ width: '100%' }}>
                    <option value="">— Unclassified —</option>
                    {['SaaS', 'Hardware', 'Professional Services', 'Cloud / Hosting', 'Telecom', 'Staffing', 'Facilities', 'Other'].map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    Strategic Tier
                    <span
                      title="Strategic importance, distinct from spend size. Tier 1 = revenue-impacting; Tier 4 = nice-to-have. Used by the Vendor Portfolio Heat Map and risk weighting."
                      style={{
                        fontSize: 'var(--font-size-2xs)', fontWeight: 600, padding: '0 5px', borderRadius: 999,
                        background: 'var(—color-surface)', border: '1px solid var(—color-border)',
                        color: 'var(—color-text-secondary)', cursor: 'help',
                      }}
                    >?</span>
                  </label>
                  <select aria-label="Criticality tier" className="form-input" value={form.criticalityTier || ''} onChange={e => setForm(p => ({ ...p, criticalityTier: e.target.value }))} style={{ width: '100%' }}>
                    <option value="">— Unset —</option>
                    <option value="tier_1">Tier 1 — Revenue-impacting</option>
                    <option value="tier_2">Tier 2 — Operationally important</option>
                    <option value="tier_3">Tier 3 — Supporting</option>
                    <option value="tier_4">Tier 4 — Nice-to-have</option>
                  </select>
                </div>              </div>
              <div style={{ marginBottom: 14 }}>
                <label className="form-label">Notes</label>
                <textarea className="form-input" value={form.notes || ''} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3} style={{ width: '100%', resize: 'vertical' }} />
              </div>
            </div>
          </div>
        )}

        {/* Support info strip */}
        {!editing && (vendor.supportEmail || vendor.supportPhone || vendor.supportPortalUrl) && (
          <div style={{ background: 'var(--color-primary-light)', border: '1px solid #bfdbfe', borderRadius: 'var(--radius)', padding: '10px 16px', marginBottom: 20, display: 'flex', flexWrap: 'wrap', gap: '8px 24px', alignItems: 'center' }}>
            <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: 'var(--color-primary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Support</span>
            {vendor.supportEmail && <a href={`mailto:${vendor.supportEmail}`} style={{ fontSize: 'var(--font-size-ui)' }}>✉ {vendor.supportEmail}</a>}
            {vendor.supportPhone && <span style={{ fontSize: 'var(--font-size-ui)' }}>📞 {vendor.supportPhone}</span>}
            {vendor.supportPortalUrl && <a href={vendor.supportPortalUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 'var(--font-size-ui)' }}>🔗 Support Portal</a>}
          </div>
        )}

        {/* ── Spend Summary ── */}
        {!editing && (() => {
          const byStatus = vendor.contracts.reduce((acc, c) => {
            acc[c.status] = (acc[c.status] || 0) + 1;
            return acc;
          }, {});
          const activeContracts = vendor.contracts.filter(c => c.status === 'active');
          const underReview = vendor.contracts.filter(c => c.status === 'under_review');
          const activeSpend = [...activeContracts, ...underReview].reduce((s, c) =>
            s + (c.costPerLicense && c.quantity ? parseFloat(c.costPerLicense) * parseInt(c.quantity) : 0), 0);
          const reviewSpend = underReview.reduce((s, c) =>
            s + (c.costPerLicense && c.quantity ? parseFloat(c.costPerLicense) * parseInt(c.quantity) : 0), 0);
          const topContracts = [...activeContracts].sort((a, b) => {
            const va = a.costPerLicense && a.quantity ? parseFloat(a.costPerLicense) * parseInt(a.quantity) : 0;
            const vb = b.costPerLicense && b.quantity ? parseFloat(b.costPerLicense) * parseInt(b.quantity) : 0;
            return vb - va;
          }).slice(0, 3);
          const fmtCurrency = v => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
          const statusColors = { active: 'var(--color-success)', under_review: 'var(--color-primary)', renewed: 'var(--color-renewal-text)', expired: 'var(--color-text-muted)', cancelled: 'var(--color-danger)' };
          const statusLabels = { active: 'Active', under_review: 'In Review', renewed: 'Renewed', expired: 'Expired', cancelled: 'Cancelled' };

          return (
            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-body" style={{ padding: '14px 20px' }}>
                <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  {/* Spend figure */}
                  <div>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 4 }}>Active Spend</div>
                    <div style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700, color: activeSpend > 0 ? 'var(--color-text)' : 'var(--color-text-secondary)' }}>
                      {activeSpend > 0 ? fmtCurrency(activeSpend) : '—'}
                    </div>
                    <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 2 }}>
                      Active: {activeContracts.length}
                      {underReview.length > 0 && (
                        <> · In review: {underReview.length}{reviewSpend > 0 ? ` (${fmtCurrency(reviewSpend)})` : ''}</>
                      )}
                    </div>
                  </div>
                  {/* Status breakdown */}
                  <div>
                    <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>By Status</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {Object.entries(byStatus).map(([status, count]) => (
                        <span key={status} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '3px 10px', borderRadius: 20, background: `${statusColors[status]}15`, color: statusColors[status], fontSize: 'var(--font-size-sm)', fontWeight: 600, border: `1px solid ${statusColors[status]}30` }}>
                          {count} {statusLabels[status] || status}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Top contracts */}
                  {topContracts.length > 0 && (
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>Top Active Contracts</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {topContracts.map(c => {
                          const val = c.costPerLicense && c.quantity ? parseFloat(c.costPerLicense) * parseInt(c.quantity) : null;
                          return (
                            <div key={c.id} onClick={() => navigate(`/contracts/${c.id}`)} role="button" tabIndex={0} onKeyDown={kbdActivate(() => navigate(`/contracts/${c.id}`))} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, cursor: 'pointer', fontSize: 'var(--font-size-sm)', padding: '2px 0' }}>
                              <span style={{ color: 'var(--color-primary)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.product}</span>
                              <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{val ? fmtCurrency(val) : '—'}</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--color-border)', marginBottom: 20 }}>
          {[['contracts', `Contracts (${vendor.contracts.length})`], ['contacts', `Contacts (${vendor.contacts.length})`], ['communications', `Communications (${vendor.communications.length})`]].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                padding: '10px 18px', border: 'none', background: 'none', cursor: 'pointer', fontSize: 'var(--font-size-data)', fontWeight: tab === key ? 600 : 400,
                color: tab === key ? 'var(--color-primary)' : 'var(--color-text-secondary)',
                borderBottom: tab === key ? '2px solid var(--color-primary)' : '2px solid transparent',
                marginBottom: -1,
              }}
            >{label}</button>
          ))}
        </div>

        {/* ── Contracts tab ── */}
        {tab === 'contracts' && (
          <div className="card">
            {vendor.contracts.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-secondary)' }}>No contracts yet.</div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Contract #</th>
                    <th>Status</th>
                    <th>Start</th>
                    <th>End</th>
                    <th>Total Value</th>
                    <th>Reseller</th>
                  </tr>
                </thead>
                <tbody>
                  {vendor.contracts.map(c => (
                    <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/contracts/${c.id}`)} tabIndex={0} onKeyDown={kbdActivate(() => navigate(`/contracts/${c.id}`))}>
                      <td style={{ fontWeight: 500 }}>{c.product}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 'var(--font-size-sm)' }}>{c.contractNumber || '—'}</td>
                      <td><StatusBadge status={c.status} /></td>
                      <td>{fmt(c.startDate)}</td>
                      <td>{fmt(c.endDate)}</td>
                      <td>{fmtMoney(c.costPerLicense, c.quantity)}</td>
                      <td style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>{c.resellerName || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {/* ── Contacts tab ── */}
        {tab === 'contacts' && (
          <div>
            {canEdit && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button className="btn btn-primary" onClick={() => { setShowContactForm(true); setEditingContact(null); }}>+ Add Contact</button>
                <button className="btn btn-secondary" onClick={() => setShowSignatureImport(true)}>✉️ Signature Import</button>
              </div>
            )}

            {showContactForm && !editingContact && (
              <ContactForm vendorId={id} onSaved={() => { setShowContactForm(false); load(); }} onCancel={() => setShowContactForm(false)} />
            )}

            {vendor.contacts.length === 0 && !showContactForm ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-secondary)', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius)' }}>
                No contacts yet. Add one manually or use Signature Import to paste an email signature.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {vendor.contacts.map(c => (
                  editingContact?.id === c.id ? (
                    <ContactForm key={c.id} vendorId={id} initial={c} onSaved={() => { setEditingContact(null); load(); }} onCancel={() => setEditingContact(null)} />
                  ) : (
                    <ContactCard key={c.id} contact={c} canEdit={canEdit} onEdit={setEditingContact} onDelete={handleDeleteContact} />
                  )
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Communications tab ── */}
        {tab === 'communications' && (
          <div>
            {features.communications && (
              <button className="btn btn-primary" style={{ marginBottom: 16 }} onClick={() => setShowCommForm(p => !p)}>
                {showCommForm ? 'Cancel' : '+ Log Communication'}
              </button>
            )}

            {showCommForm && (
              <form onSubmit={handleAddComm} style={{ background: 'var(--color-primary-light)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: 16, marginBottom: 16 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 16px' }}>
                  <div style={{ marginBottom: 12 }}>
                    <label className="form-label">Type</label>
                    <select aria-label="Communication type" className="form-input" value={commForm.type} onChange={e => setCommForm(p => ({ ...p, type: e.target.value }))} style={{ width: '100%' }}>
                      {['call', 'email_thread', 'meeting', 'note'].map(t => <option key={t} value={t}>{COMM_LABELS[t]}</option>)}
                    </select>
                  </div>
                  <div style={{ marginBottom: 12 }}>
                    <label className="form-label">Date</label>
                    <input type="date" className="form-input" value={commForm.occurredAt} onChange={e => setCommForm(p => ({ ...p, occurredAt: e.target.value }))} style={{ width: '100%' }} />
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className="form-label">Subject</label>
                  <input className="form-input" value={commForm.subject} onChange={e => setCommForm(p => ({ ...p, subject: e.target.value }))} style={{ width: '100%' }} />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className="form-label">Notes</label>
                  <textarea className="form-input" value={commForm.body} onChange={e => setCommForm(p => ({ ...p, body: e.target.value }))} rows={3} style={{ width: '100%', resize: 'vertical' }} />
                </div>
                <button type="submit" className="btn btn-primary">Save</button>
              </form>
            )}

            {vendor.communications.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-secondary)', border: '1px dashed var(--color-border)', borderRadius: 'var(--radius)' }}>
                No communications logged yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {vendor.communications.map(c => (
                  <div key={c.id} style={{ border: '1px solid var(--color-border)', borderRadius: 'var(--radius)', padding: '12px 16px', background: 'var(--color-surface)', borderLeft: `3px solid ${COMM_COLORS[c.type] || '#9aa3b2'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 700, color: COMM_COLORS[c.type], textTransform: 'uppercase', letterSpacing: '0.05em' }}>{COMM_LABELS[c.type]}</span>
                      <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>{fmt(c.occurredAt)} · {c.createdByUser?.name}</span>
                    </div>
                    {c.subject && <div style={{ fontWeight: 600, marginBottom: 4 }}>{c.subject}</div>}
                    {c.body && <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text)', whiteSpace: 'pre-line' }}>{c.body}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {showSignatureImport && (
        <SignatureImportModal vendorId={id} onImported={load} onClose={() => setShowSignatureImport(false)} />
      )}
    </>
  );
}
