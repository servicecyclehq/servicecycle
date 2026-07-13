// ─────────────────────────────────────────────────────────────────────────────
// QuoteRequestButton.jsx — "Request Quote / Call Service Rep" per-asset button.
//
// "The dossier is the feature, not the button."
//
// Renders a "Request Service Quote" button on the asset detail page.
// On click, opens a form with:
//   • Full asset dossier preview (nameplate, age, criticality, open deficiencies,
//     downstream impact, overdue tasks) — assembled server-side and stored with
//     the request so the rep sees it even when the asset changes.
//
// 5 standard questions:
//   Q1. Driver (why are you requesting this?) — required
//   Q2. Timeline (how urgently needed?) — required
//   Q3. Outage availability + when — optional
//   Q4. Budget status — optional
//   Q5. Attachments / notes (photos, IR scans, test reports) — optional
//
// EMERGENCY mode:
//   When driver = 'down_now', the form switches to EMERGENCY mode:
//   - Rep phone number displayed large with "CALL NOW — do not wait on email"
//   - Email still sent as paper trail, flagged [EMERGENCY] in subject
//   - Form submit button reads "Submit Emergency Request" in red
//
// Status history (below button): shows previous requests for this asset
// in a compact timeline.
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import api from '../api/client';
import Toast from './Toast';
import { fmtDate } from '../lib/equipment';

// ── Driver / timeline option copy ──────────────────────────────────────────
const DRIVER_OPTIONS = [
  { value: 'down_now',           label: 'Equipment is down right now',         emergency: true  },
  { value: 'suspected_failing',  label: 'Suspected failing / degraded',        emergency: false },
  { value: 'failed_inspection',  label: 'Failed inspection or has deficiency', emergency: false },
  { value: 'planned_replacement',label: 'Planned replacement / upgrade',       emergency: false },
  { value: 'budgetary',          label: 'Budgetary / planning purposes only',  emergency: false },
];

// Timeline options (2026-06-11 copy pass). The server's QuoteTimeline enum is
// fixed at immediately | within_1_week | within_30_days | next_budget_cycle,
// so the finer-grained labels MAP onto those values (`value` is what we
// submit). Options whose label is more specific than the enum value set
// `appendNote: true` — the exact wording is prepended to the notes field so
// the service rep still sees precisely what the customer picked.
const TIMELINE_OPTIONS = [
  { id: 'immediately',     value: 'immediately',       label: 'Immediately (emergency)' },
  { id: 'within_1_week',   value: 'within_1_week',     label: 'Within a week' },
  { id: 'within_30_days',  value: 'within_30_days',    label: 'Within a month' },
  { id: 'within_3_months', value: 'next_budget_cycle', label: 'Within 3 months',      appendNote: true },
  { id: 'within_6_months', value: 'next_budget_cycle', label: 'Within 6 months',      appendNote: true },
  { id: 'planned',         value: 'next_budget_cycle', label: 'Planned — no urgency' },
];

// Display labels for the server enum values (request history rows carry the
// stored enum, not the form option id).
const TIMELINE_VALUE_LABELS = {
  immediately:       'Immediately (emergency)',
  within_1_week:     'Within a week',
  within_30_days:    'Within a month',
  next_budget_cycle: 'Planned / longer horizon',
};

const STATUS_META = {
  draft:     { label: 'Draft',      color: 'var(--chip-amber-fg)', bg: 'var(--chip-amber-bg)' },
  requested: { label: 'Requested',  color: 'var(--chip-blue-fg)', bg: 'var(--chip-blue-bg)' },
  quoted:    { label: 'Quote sent', color: 'var(--chip-slate-fg)', bg: 'var(--chip-slate-bg)' }, // v0.95: purple retired; slate = in customer's court
  accepted:  { label: 'Accepted',   color: 'var(--chip-green-fg)', bg: 'var(--chip-green-bg)' },
  declined:  { label: 'Declined',   color: 'var(--chip-red-fg)', bg: 'var(--chip-red-bg)' },
};

function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META.requested;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 10,
      fontSize: 11, fontWeight: 700, background: m.bg, color: m.color,
    }}>
      {m.label}
    </span>
  );
}

export default function QuoteRequestButton({ asset }) {
  const [open,       setOpen]       = useState(false);
  const [history,    setHistory]    = useState([]);
  const [histLoading,setHistLoading]= useState(false);
  const [histError,  setHistError]  = useState(null);
  const [serviceRep, setServiceRep] = useState(null);

  // Form state
  const [driver,          setDriver]          = useState('');
  const [timeline,        setTimeline]        = useState('');
  const [outageAvailable, setOutageAvailable] = useState('');
  const [outageWindow,    setOutageWindow]    = useState('');
  const [budgeted,        setBudgeted]        = useState('');
  const [budgetNotes,     setBudgetNotes]     = useState('');
  const [attachmentNotes, setAttachmentNotes] = useState('');
  const [notes,           setNotes]           = useState('');
  const [submitting,      setSubmitting]      = useState(false);
  const [toast,           setToast]           = useState(null);

  const isEmergency = DRIVER_OPTIONS.find(d => d.value === driver)?.emergency === true;

  const fetchHistory = useCallback(async () => {
    if (!asset?.id) return;
    setHistLoading(true);
    setHistError(null);
    try {
      const { data } = await api.get(`/api/quote-requests/asset/${asset.id}`);
      setHistory(data.data || []);
    } catch (e) {
      setHistory([]);
      setHistError(e?.response?.data?.error || 'Failed to load request history.');
    } finally { setHistLoading(false); }
  }, [asset?.id]);

  const fetchServiceRep = useCallback(async () => {
    try {
      const { data } = await api.get('/api/settings/service-rep');
      setServiceRep(data.data);
    } catch { setServiceRep(null); }
  }, []);

  useEffect(() => {
    fetchHistory();
    fetchServiceRep();
  }, [fetchHistory, fetchServiceRep]);

  function resetForm() {
    setDriver(''); setTimeline(''); setOutageAvailable('');
    setOutageWindow(''); setBudgeted(''); setBudgetNotes('');
    setAttachmentNotes(''); setNotes('');
  }

  async function handleSubmit(e, asDraft = false) {
    if (e?.preventDefault) e.preventDefault();
    if (!driver || !timeline) return;
    // Map the form option onto the server's fixed QuoteTimeline enum; when the
    // label is finer-grained than the enum, carry the exact wording in notes.
    const tlOpt = TIMELINE_OPTIONS.find(t => t.id === timeline);
    if (!tlOpt) return;
    const mergedNotes = [
      tlOpt.appendNote ? `Requested timeline: ${tlOpt.label}.` : null,
      notes || null,
    ].filter(Boolean).join('\n');
    setSubmitting(true);
    try {
      await api.post('/api/quote-requests', {
        assetId:  asset.id,
        driver,
        timeline:        tlOpt.value,
        outageAvailable: outageAvailable !== '' ? outageAvailable === 'yes' : undefined,
        outageWindow:    outageWindow    || undefined,
        budgeted:        budgeted        !== '' ? budgeted === 'yes' : undefined,
        budgetNotes:     budgetNotes     || undefined,
        attachmentNotes: attachmentNotes || undefined,
        notes:           mergedNotes     || undefined,
        draft:           asDraft || undefined,
      });
      setToast({
        message: asDraft
          ? 'Saved as draft — not sent yet. Send it from Previous Requests when ready.'
          : (isEmergency ? 'Emergency request submitted — call your rep now!' : 'Quote request submitted successfully'),
        type: 'success',
      });
      resetForm();
      setOpen(false);
      fetchHistory();
    } catch (err) {
      setToast({ message: err?.response?.data?.error || 'Failed to submit request', type: 'error' });
    } finally {
      setSubmitting(false);
    }
  }

  async function sendDraft(id) {
    try {
      await api.post(`/api/quote-requests/${id}/send`);
      setToast({ message: 'Draft sent to your service rep', type: 'success' });
      fetchHistory();
    } catch (err) {
      setToast({ message: err?.response?.data?.error || 'Failed to send draft', type: 'error' });
    }
  }

  return (
    <div className="card mb-16">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="card-title">Service Quote Request</div>
        {!open && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setOpen(true)}
          >
            Request Quote / Call Rep
          </button>
        )}
      </div>

      {/* ── Request form ─────────────────────────────────────────────────────── */}
      {open && (
        <div className="card-body" style={{ borderTop: '1px solid var(--color-border)' }}>

          {/* ── EMERGENCY banner ─────────────────────────────────────────────── */}
          {isEmergency && serviceRep && (serviceRep.serviceRepPhone || serviceRep.serviceRepName) && (
            <div style={{
              background: 'var(--chip-red-bg)', border: '2px solid var(--chip-red-fg)', borderRadius: 10,
              padding: '18px 20px', marginBottom: 20, textAlign: 'center',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--chip-red-fg)', marginBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                ⚠️ Emergency — Do Not Wait on Email
              </div>
              {serviceRep.serviceRepPhone && (
                <a
                  href={`tel:${serviceRep.serviceRepPhone.replace(/\D/g, '')}`}
                  style={{
                    display: 'block', fontSize: 28, fontWeight: 900, color: 'var(--chip-red-fg)',
                    textDecoration: 'none', letterSpacing: '0.03em', margin: '8px 0',
                  }}
                >
                  📞 {serviceRep.serviceRepPhone}
                </a>
              )}
              <div style={{ fontWeight: 700, fontSize: 'var(--font-size-sm)' }}>
                CALL NOW{serviceRep.serviceRepName ? ` — ${serviceRep.serviceRepName}` : ''}
              </div>
              <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--chip-red-fg)', marginTop: 4 }}>
                Submit this form too — it creates an email paper trail marked [EMERGENCY].
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit}>

            {/* Q1 — Driver */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 700, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                1. What prompted this request? <span style={{ color: 'var(--chip-red-fg)' }}>*</span>
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {DRIVER_OPTIONS.map(opt => (
                  <label key={opt.value} style={{
                    display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
                    padding: '8px 12px', borderRadius: 6, fontSize: 'var(--font-size-sm)',
                    border: `1px solid ${driver === opt.value ? (opt.emergency ? '#dc2626' : 'var(--color-primary)') : 'var(--color-border)'}`,
                    background: driver === opt.value ? (opt.emergency ? '#fef2f2' : 'var(--color-primary-light, #eff6ff)') : 'var(--color-bg)',
                    fontWeight: driver === opt.value ? 600 : 400,
                  }}>
                    <input
                      type="radio"
                      name="driver"
                      value={opt.value}
                      checked={driver === opt.value}
                      onChange={() => setDriver(opt.value)}
                      required
                      style={{ accentColor: opt.emergency ? '#dc2626' : 'var(--color-primary)' }}
                    />
                    {opt.emergency && <span>🚨</span>}
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>

            {/* Q2 — Timeline */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 700, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                2. How quickly is service needed? <span style={{ color: 'var(--chip-red-fg)' }}>*</span>
              </label>
              <select
                className="input"
                value={timeline}
                onChange={e => setTimeline(e.target.value)}
                required
                style={{ maxWidth: 360 }}
              >
                <option value="">— Select timeline —</option>
                {TIMELINE_OPTIONS.map(o => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>

            {/* Q3 — Outage availability */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 700, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                3. Can this equipment be de-energised for service?
              </label>
              <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                {[['yes', 'Yes'], ['no', 'No'], ['', 'Not sure']].map(([v, l]) => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="outageAvailable"
                      value={v}
                      checked={outageAvailable === v}
                      onChange={() => setOutageAvailable(v)}
                    />
                    {l}
                  </label>
                ))}
              </div>
              {outageAvailable === 'yes' && (
                <input
                  type="text"
                  className="input"
                  value={outageWindow}
                  onChange={e => setOutageWindow(e.target.value)}
                  placeholder="When? (e.g. weekend of July 12, weekday evenings, etc.)"
                  style={{ maxWidth: 400 }}
                />
              )}
            </div>

            {/* Q4 — Budget */}
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'block', fontWeight: 700, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                4. Is budget already approved for this work?
              </label>
              <div style={{ display: 'flex', gap: 12, marginBottom: 8 }}>
                {[['yes', 'Yes — approved'], ['no', 'No — need a number for approval'], ['', 'Not sure']].map(([v, l]) => (
                  <label key={v} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-sm)', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="budgeted"
                      value={v}
                      checked={budgeted === v}
                      onChange={() => setBudgeted(v)}
                    />
                    {l}
                  </label>
                ))}
              </div>
              {budgeted === 'no' && (
                <input
                  type="text"
                  className="input"
                  value={budgetNotes}
                  onChange={e => setBudgetNotes(e.target.value)}
                  placeholder="Any budget notes or approval target?"
                  style={{ maxWidth: 400 }}
                />
              )}
            </div>

            {/* Q5 — Attachments / notes */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontWeight: 700, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                5. Attachments or additional context
              </label>
              <textarea
                className="input"
                value={attachmentNotes}
                onChange={e => setAttachmentNotes(e.target.value)}
                placeholder="Describe any photos, IR scans, test reports, or other info you can provide. List filenames you plan to email separately."
                rows={3}
                style={{ maxWidth: '100%', width: '100%', resize: 'vertical' }}
              />
            </div>

            {/* Optional free-text notes */}
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                Anything else your rep should know?
              </label>
              <textarea
                className="input"
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Optional — symptoms, operating history, previous repairs, access restrictions…"
                rows={2}
                style={{ maxWidth: '100%', width: '100%', resize: 'vertical' }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="submit"
                className="btn btn-sm"
                disabled={!driver || !timeline || submitting}
                style={{
                  background: isEmergency ? '#dc2626' : 'var(--color-primary)',
                  color: '#fff', border: 'none', fontWeight: 700,
                  opacity: (!driver || !timeline || submitting) ? 0.6 : 1,
                }}
              >
                {submitting
                  ? 'Submitting…'
                  : isEmergency
                    ? '🚨 Submit Emergency Request'
                    : 'Submit Quote Request'}
              </button>
              {!isEmergency && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => handleSubmit(e, true)}
                  disabled={!driver || !timeline || submitting}
                  title="Save without sending — you can send it later from Previous Requests"
                >
                  Save as draft
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { resetForm(); setOpen(false); }}
                disabled={submitting}
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Request history ──────────────────────────────────────────────────── */}
      {history.length > 0 && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '12px 16px' }}>
          <div style={{
            fontSize: 'var(--font-size-xs)', fontWeight: 700, letterSpacing: '0.04em',
            textTransform: 'uppercase', color: 'var(--color-text-secondary)', marginBottom: 10,
          }}>
            Previous Requests
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.slice(0, 5).map(qr => {
              const driverLabel = DRIVER_OPTIONS.find(d => d.value === qr.driver)?.label || qr.driver;
              const timelineLabel = TIMELINE_VALUE_LABELS[qr.timeline] || qr.timeline;
              return (
                <div key={qr.id} style={{
                  display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
                  fontSize: 'var(--font-size-sm)', padding: '6px 0',
                  borderBottom: '1px solid var(--color-border)',
                }}>
                  <StatusBadge status={qr.status} />
                  {qr.emergencyMode && <span title="Emergency request" style={{ color: 'var(--chip-red-fg)', fontWeight: 700 }}>🚨</span>}
                  <span style={{ color: 'var(--color-text-secondary)' }}>{fmtDate(qr.createdAt)}</span>
                  <span>{driverLabel}</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>·</span>
                  <span style={{ color: 'var(--color-text-secondary)' }}>{timelineLabel}</span>
                  {qr.requestedBy?.name && (
                    <span style={{ color: 'var(--color-text-secondary)', fontSize: 11 }}>
                      by {qr.requestedBy.name}
                    </span>
                  )}
                  {qr.status === 'draft' && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      style={{ marginLeft: 'auto' }}
                      onClick={() => sendDraft(qr.id)}
                    >
                      Send now
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── History load error ──────────────────────────────────────────────── */}
      {!open && histError && (
        <div className="card-body" role="alert" style={{ color: 'var(--chip-red-fg)', fontSize: 'var(--font-size-sm)' }}>
          {histError}{' '}
          <button
            type="button"
            onClick={fetchHistory}
            style={{ background: 'none', border: 'none', padding: 0, font: 'inherit',
              color: 'var(--color-primary)', textDecoration: 'underline', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Empty state ─────────────────────────────────────────────────────── */}
      {!open && !histError && history.length === 0 && !histLoading && (
        <div className="card-body" style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          No quote requests yet for this asset.
          {serviceRep?.serviceRepName && (
            <span> Your rep is <strong>{serviceRep.serviceRepName}</strong>
              {serviceRep.serviceRepEmail && <> · <a href={`mailto:${serviceRep.serviceRepEmail}`}>{serviceRep.serviceRepEmail}</a></>}
              {serviceRep.serviceRepPhone && <> · {serviceRep.serviceRepPhone}</>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
