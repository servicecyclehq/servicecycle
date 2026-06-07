import { useState, useEffect, useRef } from 'react';
import { InfoTip } from '../components/InfoTip';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useConfirm } from '../context/ConfirmContext';
import CustomFieldInputs from '../components/CustomFieldInputs';

const DELIVERY_LABELS = { user: 'Per User', device: 'Per Device', shared_pool: 'Shared Pool' };

// ── Draft auto-save helpers ────────────────────────────────────────────────
const DRAFT_KEY_PREFIX = 'lapseiq_draft_contract_new';
// Treat the form as "has content" if any field is non-default.
// Defaults: '' for strings/numbers, false for autoRenewal, 'active' for status.
const formHasContent = (f) =>
  Object.values(f).some((v) => v !== '' && v !== false && v !== 'active');

function timeAgo(ts) {
  if (!ts) return '';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 5)     return 'just now';
  if (secs < 60)    return `${secs}s ago`;
  if (secs < 3600)  return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Single source of truth for the form's expected key set + default values.
// Used both as the initial state of the form and as the whitelist when
// restoring a draft that was saved by an older or newer build of the page.
const INITIAL_FORM = Object.freeze({
  vendorId: '',
  product: '',
  contractNumber: '',
  customerNumber: '',
  quantity: '',
  costPerLicense: '',
  startDate: '',
  endDate: '',
  autoRenewal: false,
  autoRenewalNoticeDays: '',
  poNumber: '',
  invoiceNumber: '',
  requestor: '',
  internalOwnerId: '',
  // v0.5.14: free-text fallback when the contract owner is NOT a LapseIQ
  // user. UI shows the user dropdown with "Other..." at the bottom;
  // picking "Other" reveals name + email inputs.
  internalOwnerName: '',
  internalOwnerEmail: '',
  deliveryEmail: '',
  deliveryMethod: '',
  department: '',
  team: '',
  costCenter: '',
  glCode: '',
  // v0.36.3: Co-term group input added to create form. Previously
  // only on /contracts/:id edit, which forced a 2-step flow.
  coTermGroup: '',
  endUserName: '',
  endUserEmail: '',
  licenseKeys: '',
  notes: '',
  status: 'active',
  resellerName: '',
  resellerAccountNumber: '',
  resellerContactName: '',
  resellerContactEmail: '',
  seatsLicensed: '',
  seatsActivelyInUse: '',
  annualUpliftPercent: '',
  // (Phase 2) Category selection. Empty means "let the server default to
  // the account's saas category"; the UI defaults to saas explicitly once
  // categories load (see fetch effect below).
  categoryId: '',
});

export default function NewContract() {
  const navigate = useNavigate();
  const { user: currentUser } = useAuth();
  const confirm = useConfirm();
  const [vendors, setVendors] = useState([]);
  const [members, setMembers] = useState([]);
  const [categories, setCategories] = useState([]);  // (Phase 2)
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // H1-2/H2-2 (v0.76.5): field-level validation state
  const [validationErrors, setValidationErrors] = useState({});
  const canAssignOwner = ['admin', 'manager'].includes(currentUser?.role);

  const [form, setForm] = useState({ ...INITIAL_FORM });
  // Custom field values keyed by definition.fieldKey. Tracked separately
  // so the standard auto-save / restore-draft envelope keeps working
  // unchanged; merged in at submit time.
  const [customFields, setCustomFields] = useState({});
  const setCustom = (key, val) => setCustomFields(prev => ({ ...prev, [key]: val }));

  useEffect(() => {
    Promise.all([
      api.get('/api/vendors'),
      canAssignOwner ? api.get('/api/users/members') : Promise.resolve(null),
      api.get('/api/categories'),                                        // (Phase 2)
    ])
      .then(([vendorRes, memberRes, categoryRes]) => {
        setVendors(vendorRes.data.data.vendors);
        // Do NOT auto-select the first vendor — require explicit selection to
        // prevent silently attributing every new contract to the wrong vendor.
        if (memberRes) setMembers(memberRes.data.data.users);
        // (Phase 2) Filter out archived categories from the picker. Default
        // categoryId on the form to the saas category so back-compat behavior
        // is preserved for users who don't touch the picker.
        const cats = (categoryRes.data.data?.categories || []).filter(c => !c.archivedAt);
        setCategories(cats);
        const saasCat = cats.find(c => c.slug === 'saas');
        if (saasCat) {
          setForm(prev => prev.categoryId ? prev : { ...prev, categoryId: saasCat.id });
        }
      })
      .catch(() => setError('Failed to load vendors.'))
      .finally(() => setLoading(false));
  }, [canAssignOwner]);

  // ── Draft auto-save (local-first: persists across tab close / refresh) ──────
  // Namespace by user id so a shared workstation never surfaces another
  // user's in-progress contract draft.
  const draftKey = currentUser?.id
    ? `${DRAFT_KEY_PREFIX}:${currentUser.id}`
    : DRAFT_KEY_PREFIX;

  const [showDraftBanner, setShowDraftBanner] = useState(false);
  const [draftAgeOnLoad, setDraftAgeOnLoad] = useState(null); // ms epoch of pre-existing draft
  const [draftSavedAt, setDraftSavedAt] = useState(null);     // ms epoch of most recent save
  const [, forceTick] = useState(0);                          // 30s tick for "Saved Xm ago"

  // Refs let the unmount cleanup read the latest form/state without recreating
  // the cleanup effect (which would make it run on every keystroke instead of
  // only on unmount).
  const formRef = useRef(form);
  useEffect(() => { formRef.current = form; }, [form]);
  const submittedRef = useRef(false);

  // On mount: offer to restore a saved draft if one exists
  useEffect(() => {
    if (!currentUser?.id) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      // Backwards compat: pre-2026-05-02 drafts were the form object directly,
      // not wrapped in a {data, savedAt} envelope.
      const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
      const savedAt = parsed && typeof parsed === 'object' && 'savedAt' in parsed ? parsed.savedAt : null;
      if (data && formHasContent(data)) {
        setShowDraftBanner(true);
        setDraftAgeOnLoad(savedAt);
      }
    } catch { /* malformed draft — ignore */ }
  }, [currentUser?.id, draftKey]);

  // Debounced save: every form change schedules a write 1s later. A subsequent
  // change clears the pending timer, so we only persist when the user has
  // paused typing. Replaces the previous 5s setInterval that ran indefinitely.
  useEffect(() => {
    if (!currentUser?.id) return;
    if (!formHasContent(form)) return;
    const id = setTimeout(() => {
      try {
        const ts = Date.now();
        localStorage.setItem(draftKey, JSON.stringify({ data: form, savedAt: ts }));
        setDraftSavedAt(ts);
      } catch { /* quota or private mode — silent */ }
    }, 1000);
    return () => clearTimeout(id);
  }, [form, draftKey, currentUser?.id]);

  // Save-on-unmount safety net: if the user navigates away (sidebar nav,
  // back button, tab close handled by browser) before the 1s debounce fires,
  // synchronously flush the latest form to localStorage. Skipped after a
  // successful submit so we don't immediately re-create the draft we just
  // cleared.
  useEffect(() => {
    return () => {
      if (submittedRef.current) return;
      if (!currentUser?.id) return;
      const f = formRef.current;
      if (!formHasContent(f)) return;
      try {
        localStorage.setItem(draftKey, JSON.stringify({ data: f, savedAt: Date.now() }));
      } catch { /* silent */ }
    };
  }, [draftKey, currentUser?.id]);

  // 30s tick so the "Saved Xm ago" indicator stays roughly fresh without
  // re-rendering on every keystroke.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const restoreDraft = () => {
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) { setShowDraftBanner(false); return; }
      const parsed = JSON.parse(raw);
      const data = parsed && typeof parsed === 'object' && 'data' in parsed ? parsed.data : parsed;
      if (data && typeof data === 'object') {
        // Restore only keys present in the current form schema. Old drafts
        // may carry removed fields (would 500 Prisma via passthrough on POST)
        // or be missing fields added since the draft was saved (those go
        // uncontrolled in React). Either way: project onto INITIAL_FORM.
        const cleaned = { ...INITIAL_FORM };
        for (const key of Object.keys(INITIAL_FORM)) {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            cleaned[key] = data[key];
          }
        }
        setForm(cleaned);
      }
    } catch { /* ignore */ }
    setShowDraftBanner(false);
  };

  const discardDraft = async () => {
    if (!await confirm({
      title: 'Discard draft',
      message: 'Discard the saved draft? This cannot be undone.',
      confirmLabel: 'Discard',
      danger: true,
    })) return;
    localStorage.removeItem(draftKey);
    setShowDraftBanner(false);
    setDraftAgeOnLoad(null);
    setDraftSavedAt(null);
  };

  const setF = (key, val) => setForm((prev) => ({ ...prev, [key]: val }));

  // Preview calculated dates before submission
  const totalValue =
    form.costPerLicense && form.quantity
      ? parseFloat(form.costPerLicense) * parseInt(form.quantity)
      : null;

  let evalStartDays = null;
  let evalStartByPreview = null;
  let cancelByPreview = null;
  if (form.endDate) {
    if (totalValue === null) evalStartDays = 60;
    else if (totalValue >= 100000) evalStartDays = 180;
    else if (totalValue >= 25000) evalStartDays = 90;
    else evalStartDays = 30;
    const end = new Date(form.endDate);
    const rb = new Date(end);
    rb.setDate(rb.getDate() - evalStartDays);
    evalStartByPreview = rb.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (form.autoRenewal && form.autoRenewalNoticeDays) {
      const cb = new Date(end);
      cb.setDate(cb.getDate() - parseInt(form.autoRenewalNoticeDays));
      cancelByPreview = cb.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    setValidationErrors({});
    const _verr = {};
    if (!form.vendorId)        _verr.vendorId   = 'Please select a vendor.';
    if (!form.product.trim())  _verr.product    = 'Product name is required.';
    if (!form.startDate)       _verr.startDate  = 'Start date is required.';
    if (!form.endDate)         _verr.endDate    = 'Renewal / end date is required.';
    if (Object.keys(_verr).length > 0) {
      setValidationErrors(_verr);
      const _fm = { vendorId: 'nc-vendor-id', product: 'nc-product', startDate: 'nc-start-date', endDate: 'nc-end-date' };
      document.getElementById(_fm[Object.keys(_verr)[0]])?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setSaving(true);
    try {
      // v0.5.14: '__OTHER__' is a UI sentinel — strip before submit
      // so the server sees an empty internalOwnerId. The free-text
      // name/email pair carries through as-is.
      const payload = { ...form, customFields };
      if (payload.internalOwnerId === '__OTHER__') payload.internalOwnerId = '';
      const res = await api.post('/api/contracts', payload);
      // Mark BEFORE removing + navigating so the unmount cleanup respects it.
      submittedRef.current = true;
      localStorage.removeItem(draftKey);
      navigate(`/contracts/${res.data.data.contract.id}`);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to create contract.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="loading">Loading…</div>;

  return (
    <>
      <div className="page-header">
        <div>
          <Link to="/contracts" className="back-link">← All Contracts</Link>
          <h1 className="page-title">New Contract</h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {draftSavedAt && (
            <span
              title={`Auto-saved locally at ${new Date(draftSavedAt).toLocaleTimeString()}`}
              style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}
            >
              ✓ Draft saved {timeAgo(draftSavedAt)}
            </span>
          )}
          {/* Cancel does NOT discard the draft — the unmount cleanup will
              flush the latest form so a user can resume on next visit. Use
              the Discard button on the restore banner to wipe explicitly. */}
          <button
            type="button"
            className="btn btn-secondary"
            style={{ minWidth: 120 }}
            onClick={() => navigate('/ingest')}
            title="Let AI scan a contract document and fill in fields automatically"
          >
            ↑ Upload Document
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ minWidth: 120 }}
            onClick={() => navigate('/contracts')}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="new-contract-form"
            className="btn btn-primary"
            style={{ minWidth: 120 }}
            disabled={saving}
          >
            {saving ? 'Creating…' : 'Create Contract'}
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* ── Draft restore banner ────────────────────────────────── */}
        {showDraftBanner && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10,
            padding: '10px 16px', marginBottom: 14,
            background: 'var(--color-warning-bg)', border: '1px solid #fde047', borderRadius: 'var(--radius)',
            fontSize: 'var(--font-size-ui)',
          }}>
            <span>
              📝 <strong>Unsaved draft found</strong>
              {draftAgeOnLoad
                ? <> — last saved <span title={new Date(draftAgeOnLoad).toLocaleString()}>{timeAgo(draftAgeOnLoad)}</span>.</>
                : <> — you started this form before and left without saving.</>
              }
            </span>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                type="button"
                onClick={restoreDraft}
                style={{ fontSize: 'var(--font-size-sm)', padding: '4px 12px', cursor: 'pointer', background: '#fbbf24', border: 'none', borderRadius: 4, fontWeight: 600, color: '#1c1917' }}
              >
                Restore draft
              </button>
              <button
                type="button"
                onClick={discardDraft}
                style={{ fontSize: 'var(--font-size-sm)', padding: '4px 10px', cursor: 'pointer', background: 'none', border: '1px solid var(--color-warning)', borderRadius: 4, color: 'var(--color-warning)' }}
              >
                Discard
              </button>
            </div>
          </div>
        )}

        {vendors.length === 0 && (
          <div className="alert alert-info">
            No vendors yet. <Link to="/vendors">Create a vendor</Link> before adding a contract.
          </div>
        )}

        {error && <div role="alert" className="alert alert-error">{error}</div>}

        <form id="new-contract-form" onSubmit={handleSubmit}>
          <div className="card">
            <div className="card-body">

              {/* Core */}
              <div className="form-section">
                <div className="form-section-title">Contract Details</div>
                {/* (Phase 2) Category picker — first form field. Defaults to
                    SaaS for back-compat; users can switch to telecom /
                    insurance / lease / etc. Behavioural defaults attached
                    to each category (notice days, auto-renewal) inform the
                    later fields' starting values once the user picks.
                    Hidden when no categories exist yet (pre-Phase-1 demos). */}
                {categories.length > 0 && (
                  <div className="form-row">
                    <div className="form-group">
                      <label className="form-label" htmlFor="nc-category-id">Category</label>
                      <select id="nc-category-id"
                        className="form-control"
                        value={form.categoryId}
                        onChange={(e) => {
                          const newId = e.target.value;
                          const cat = categories.find(c => c.id === newId);
                          // Apply the category's defaults to other form
                          // fields IF those fields haven't been touched yet
                          // (still at the form's initial values). This is
                          // an opinionated nudge, not a hard rule — users
                          // who deliberately set autoRenewal=true and then
                          // switch category don't get their pick overwritten.
                          setForm(prev => {
                            const next = { ...prev, categoryId: newId };
                            if (cat) {
                              if (prev.autoRenewalNoticeDays === '' && cat.defaultNoticeDays != null) {
                                next.autoRenewalNoticeDays = String(cat.defaultNoticeDays);
                              }
                              if (prev.autoRenewal === false && cat.defaultAutoRenewal === true) {
                                next.autoRenewal = true;
                              }
                            }
                            return next;
                          });
                        }}
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.icon ? `${c.icon} ${c.name}` : c.name}
                          </option>
                        ))}
                      </select>
                      <div style={{ marginTop: 5, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                        Picking a category applies sensible defaults for notice period and auto-renewal.{' '}
                        <Link to="/settings#categories" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                          Manage categories →
                        </Link>
                      </div>
                    </div>
                  </div>
                )}
                <div className="form-row form-row-2">
                  {/* Vendor is the first field on this form. Most users
                      think "I'm renewing the contract WITH X for product Y" -
                      vendor is the anchor and product narrows it down.
                      Reordered 2026-05-08 (was Product then Vendor). */}
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-vendor-id">Vendor <span className="required">*</span></label>
                    <select id="nc-vendor-id"
                      className="form-control"
                      value={form.vendorId}
                      onChange={(e) => setF('vendorId', e.target.value)}
                      required
                      autoFocus
                    >
                      <option value="">Select vendor…</option>
                      {vendors.map((v) => (
                        <option key={v.id} value={v.id}>{v.name}</option>
                      ))}
                    </select>
                    <div style={{ marginTop: 5, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                      Vendor not listed?{' '}
                      <Link to="/vendors?new=1" style={{ color: 'var(--color-primary)', fontWeight: 600 }}>
                        Add a new vendor →
                      </Link>
                    </div>
                    {validationErrors.vendorId && (
                      <p style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginTop: 4, marginBottom: 0 }}>{validationErrors.vendorId}</p>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-product">Product <span className="required">*</span></label>
                    <input id="nc-product"
                      className="form-control"
                      placeholder="e.g. Microsoft 365 E3"
                      value={form.product}
                      onChange={(e) => setF('product', e.target.value)}
                      required
                    />
                    {validationErrors.product && (
                      <p style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginTop: 4, marginBottom: 0 }}>{validationErrors.product}</p>
                    )}
                  </div>
                </div>
                <div className="form-row form-row-3">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-contract-number">Contract #</label>
                    <input id="nc-contract-number" className="form-control" placeholder="e.g. MS-2024-00847" value={form.contractNumber} onChange={(e) => setF('contractNumber', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-customer-number">Customer #</label>
                    <input id="nc-customer-number" className="form-control" value={form.customerNumber} onChange={(e) => setF('customerNumber', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-status">Status</label>
                    <select id="nc-status" className="form-control" value={form.status} onChange={(e) => setF('status', e.target.value)}>
                      <option value="active">Active</option>
                      <option value="under_review">Under Review</option>
                      <option value="renewed">Renewed</option>
                      {/* Expired and Cancelled added 2026-05-08 so users can
                          enter historical agreements at creation time for
                          cost-trend / vendor-history tracking. Backend has
                          always supported these values; the form was just
                          missing them. The dashboard's autoExpireContracts
                          will also flip Active -> Expired when endDate is
                          in the past, so this is purely a "let me say so
                          up front" affordance. */}
                      <option value="expired">Expired (historical)</option>
                      <option value="cancelled">Cancelled (historical)</option>
                    </select>
                    {(form.status === 'expired' || form.status === 'cancelled') && (
                      <div style={{ marginTop: 5, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
                        Adding a historical contract for tracking. After creating it you can archive it from the contract detail page to keep it out of the main list while preserving the record.
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Dates - both required because LapseIQ's whole job is
                  tracking renewal windows; without endDate the alert
                  calendar can't fire and without startDate the renewal-
                  chain / cost-trend reports break. Marked required
                  2026-05-08. */}
              <div className="form-section">
                <div className="form-section-title">Dates</div>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-start-date">Start Date <span className="required">*</span></label>
                    <input id="nc-start-date" type="date" className="form-control" value={form.startDate} onChange={(e) => setF('startDate', e.target.value)} required />
                    {validationErrors.startDate && (
                      <p style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginTop: 4, marginBottom: 0 }}>{validationErrors.startDate}</p>
                    )}
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-end-date">Renewal / End Date <span className="required">*</span></label>
                    <input id="nc-end-date" type="date" className="form-control" value={form.endDate} onChange={(e) => setF('endDate', e.target.value)} required />
                    {validationErrors.endDate && (
                      <p style={{ color: 'var(--color-danger)', fontSize: 'var(--font-size-sm)', marginTop: 4, marginBottom: 0 }}>{validationErrors.endDate}</p>
                    )}
                    <div className="form-hint" style={{ marginTop: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>Dates store as UTC midnight; the wall-clock day stays correct regardless of the timezone you set on your droplet.</div>
                  {form.endDate && evalStartDays !== null && (
                      <div className="form-hint">
                        Evaluate by <InfoTip content="The period before the renewal date to begin your evaluation - auto-calculated from contract value." />: <strong>{evalStartByPreview}</strong> ({evalStartDays} days before renewal
                        {totalValue != null && `, based on ${new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalValue)} total value`})
                        {cancelByPreview && <span> · Cancel-by <InfoTip content="The last date to notify the vendor of non-renewal without triggering auto-renewal." />: <strong>{cancelByPreview}</strong></span>}
                      </div>
                    )}
                  </div>
                </div>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <div className="checkbox-group">
                      <input
                        type="checkbox"
                        id="autoRenewal"
                        checked={form.autoRenewal}
                        onChange={(e) => setF('autoRenewal', e.target.checked)}
                      />
                      <label htmlFor="autoRenewal" className="checkbox-label">Auto-renewal enabled</label>
                    </div>
                  </div>
                  {form.autoRenewal && (
                    <div className="form-group">
                      <label className="form-label" htmlFor="nc-auto-renewal-notice-days">Notice Period (days)</label>
                      <input id="nc-auto-renewal-notice-days"
                        type="number"
                        className="form-control"
                        placeholder="e.g. 30"
                        value={form.autoRenewalNoticeDays}
                        onChange={(e) => setF('autoRenewalNoticeDays', e.target.value)}
                      />
                      <div className="form-hint">Days before end date you must cancel to avoid auto-renewal.</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Financial */}
              <div className="form-section">
                <div className="form-section-title">Financial</div>
                <div className="form-row form-row-3">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-quantity">Quantity</label>
                    <input id="nc-quantity" type="number" min="0" className="form-control" placeholder="e.g. 100" value={form.quantity} onChange={(e) => setF('quantity', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-cost-per-license">Cost Per License ($)</label>
                    <input id="nc-cost-per-license" type="number" step="0.01" min="0" className="form-control" placeholder="e.g. 25.00" value={form.costPerLicense} onChange={(e) => setF('costPerLicense', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Total Value</label>
                    <div className="form-control" style={{ background: 'var(--color-bg)', cursor: 'default', color: 'var(--color-text-secondary)' }}>
                      {totalValue != null
                        ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(totalValue)
                        : '—'}
                    </div>
                    <div className="form-hint">Calculated from quantity × cost per license.</div>
                  </div>
                </div>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-po-number">PO Number</label>
                    <input id="nc-po-number" className="form-control" value={form.poNumber} onChange={(e) => setF('poNumber', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-invoice-number">Invoice Number</label>
                    <input id="nc-invoice-number" className="form-control" value={form.invoiceNumber} onChange={(e) => setF('invoiceNumber', e.target.value)} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="nc-requestor">Requestor</label>
                  <input id="nc-requestor" className="form-control" value={form.requestor} onChange={(e) => setF('requestor', e.target.value)} />
                </div>
              </div>

              {/* Ownership — v0.5.14: dropdown of LapseIQ users + "Other..."
                  option which reveals free-text name + email fields. Lets
                  procurement record a non-LapseIQ owner (operations manager,
                  CFO, branch manager) without forcing them to be an account.
                  Sentinel '__OTHER__' lives in form.internalOwnerId during
                  edit; the submit handler maps it to empty string + carries
                  internalOwnerName/Email through. */}
              {canAssignOwner && (
                <div className="form-section">
                  <div className="form-section-title">Contract Ownership</div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-internal-owner-id">Internal Owner</label>
                    <select id="nc-internal-owner-id"
                      className="form-control"
                      value={form.internalOwnerId}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v !== '__OTHER__') {
                          // Picking a real user (or Unassigned) clears the
                          // free-text fallback fields.
                          setForm(prev => ({ ...prev, internalOwnerId: v, internalOwnerName: '', internalOwnerEmail: '' }));
                        } else {
                          setF('internalOwnerId', '__OTHER__');
                        }
                      }}
                    >
                      <option value="">Unassigned</option>
                      {members.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                      <option value="__OTHER__">Other (not a LapseIQ user)…</option>
                    </select>
                    <div className="form-hint">The person responsible for managing this contract's renewal. Pick a LapseIQ user, or choose "Other" to record a non-LapseIQ contact.</div>
                  </div>
                  {form.internalOwnerId === '__OTHER__' && (
                    <div className="form-row form-row-2">
                      <div className="form-group">
                        <label className="form-label" htmlFor="nc-internal-owner-name">Owner Name</label>
                        <input id="nc-internal-owner-name"
                          className="form-control"
                          placeholder="e.g. John Smith"
                          value={form.internalOwnerName}
                          onChange={(e) => setF('internalOwnerName', e.target.value)}
                        />
                      </div>
                      <div className="form-group">
                        <label className="form-label" htmlFor="nc-internal-owner-email">Owner Email (optional)</label>
                        <input id="nc-internal-owner-email"
                          type="email"
                          className="form-control"
                          placeholder="e.g. john.smith@company.com"
                          value={form.internalOwnerEmail}
                          onChange={(e) => setF('internalOwnerEmail', e.target.value)}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Delivery */}
              <div className="form-section">
                <div className="form-section-title">Delivery &amp; Assignment</div>
                <div className="form-row form-row-3">
                  {/* v0.5.13: License Type (renamed from "Delivery Method").
                      Concept is SaaS-specific (per-user/per-device/shared-pool licensing
                      models). Hidden for non-SaaS categories where the field has no
                      semantic meaning (an insurance policy doesn't have "Per User"). */}
                  {(categories.find(c => c.id === form.categoryId)?.slug === 'saas') && (
                    <div className="form-group">
                      <label className="form-label" htmlFor="nc-delivery-method">License Type</label>
                      <select id="nc-delivery-method" className="form-control" value={form.deliveryMethod} onChange={(e) => setF('deliveryMethod', e.target.value)}>
                        <option value="">Select…</option>
                        <option value="user">Per User</option>
                        <option value="device">Per Device</option>
                        <option value="shared_pool">Shared Pool</option>
                      </select>
                    </div>
                  )}
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-delivery-email">Delivery Email</label>
                    <input id="nc-delivery-email" type="email" className="form-control" value={form.deliveryEmail} onChange={(e) => setF('deliveryEmail', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-department">Department</label>
                    <input id="nc-department" className="form-control" placeholder="e.g. IT" value={form.department} onChange={(e) => setF('department', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-team">Team</label>
                    <input id="nc-team" className="form-control" value={form.team} onChange={(e) => setF('team', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-cost-center">Cost Center</label>
                    <input id="nc-cost-center" className="form-control" value={form.costCenter} onChange={(e) => setF('costCenter', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-gl-code">GL Code</label>
                    <input id="nc-gl-code" className="form-control" placeholder="e.g. 6230-OPEX-IT" maxLength={50} value={form.glCode} onChange={(e) => setF('glCode', e.target.value)} />
                  </div>
                </div>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-end-user-name">End User Name</label>
                    <input id="nc-end-user-name" className="form-control" value={form.endUserName} onChange={(e) => setF('endUserName', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-end-user-email">End User Email</label>
                    <input id="nc-end-user-email" type="email" className="form-control" value={form.endUserEmail} onChange={(e) => setF('endUserEmail', e.target.value)} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="nc-license-keys">License Keys</label>
                  <textarea id="nc-license-keys" className="form-control" rows={3} value={form.licenseKeys} onChange={(e) => setF('licenseKeys', e.target.value)} placeholder="Paste license keys…" />
                </div>
                {/* v0.37.2 W6 MT-114: a11y — programmatically associate label,
                    input, and hint text so screen readers announce the full
                    context. Pre-fix the <label> had no htmlFor + the hint was
                    a visually-adjacent <div> with no aria relationship to the
                    input, so SR users heard "edit text, Co-Term Group" with
                    no explanation of what the field does. */}
                <div className="form-group">
                  <label className="form-label" htmlFor="new-contract-coterm-group">
                    Co-Term Group <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>(optional)</span>
                  </label>
                  <input
                    id="new-contract-coterm-group"
                    className="form-control"
                    value={form.coTermGroup}
                    onChange={(e) => setF('coTermGroup', e.target.value)}
                    placeholder="e.g. Microsoft Q4 2027"
                    aria-describedby="new-contract-coterm-group-hint"
                  />
                  <div className="form-hint" id="new-contract-coterm-group-hint">
                    A label that links related contracts so you can renew them
                    together. Type the same label on every contract that
                    should share a renewal cycle (vendor + quarter is a common
                    convention, e.g. "Microsoft Q4 2027"). Combined annual
                    spend then shows up in the Co-Term view on the Contracts
                    list, which makes the multi-contract negotiation lever
                    obvious.
                  </div>
                </div>
              </div>

              {/* Notes */}
              <div className="form-section">
                <div className="form-section-title">Notes</div>
                <div className="form-group">
                  <textarea
                    className="form-control"
                    rows={4}
                    value={form.notes}
                    onChange={(e) => setF('notes', e.target.value)}
                    placeholder="Renewal strategy, vendor history, price escalation clauses, anything to know at renewal…"
                  />
                </div>
              </div>

              {/* Reseller */}
              <div className="form-section">
                <div className="form-section-title">Purchase Source / Reseller</div>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-reseller-name">Reseller / Distributor</label>
                    <input id="nc-reseller-name" className="form-control" placeholder="e.g. SoftwareOne, SHI, Insight" value={form.resellerName} onChange={(e) => setF('resellerName', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-reseller-account-number">Account # with Reseller</label>
                    <input id="nc-reseller-account-number" className="form-control" value={form.resellerAccountNumber} onChange={(e) => setF('resellerAccountNumber', e.target.value)} />
                  </div>
                </div>
                <div className="form-row form-row-2">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-reseller-contact-name">Reseller Contact Name</label>
                    <input id="nc-reseller-contact-name" className="form-control" value={form.resellerContactName} onChange={(e) => setF('resellerContactName', e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-reseller-contact-email">Reseller Contact Email</label>
                    <input id="nc-reseller-contact-email" type="email" className="form-control" value={form.resellerContactEmail} onChange={(e) => setF('resellerContactEmail', e.target.value)} />
                  </div>
                </div>
              </div>

              {/* License Utilization */}
              <div className="form-section">
                <div className="form-section-title">License Utilization</div>
                <div className="form-row form-row-3">
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-seats-licensed">Seats Licensed</label>
                    <input id="nc-seats-licensed" type="number" min="0" className="form-control" value={form.seatsLicensed} onChange={(e) => setF('seatsLicensed', e.target.value)} placeholder="Total purchased" />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-seats-actively-in-use">Seats In Use</label>
                    <input id="nc-seats-actively-in-use" type="number" min="0" className="form-control" value={form.seatsActivelyInUse} onChange={(e) => setF('seatsActivelyInUse', e.target.value)} placeholder="Confirmed active" />
                  </div>
                  <div className="form-group">
                    <label className="form-label" htmlFor="nc-annual-uplift-percent">Expected Annual Uplift (%)</label>
                    <input id="nc-annual-uplift-percent" type="number" min="0" step="0.1" className="form-control" value={form.annualUpliftPercent} onChange={(e) => setF('annualUpliftPercent', e.target.value)} placeholder="e.g. 5" />
                    <div className="form-hint">Used to calculate estimated downsizing savings at renewal</div>
                  </div>
                </div>
              </div>

              {/* Admin-defined custom fields */}
              <CustomFieldInputs
                values={customFields}
                onChange={setCustom}
                categoryId={form.categoryId || undefined}
              />

            </div>
          </div>
        </form>
      </div>
    </>
  );
}
