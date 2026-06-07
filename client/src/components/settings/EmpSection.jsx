// ─────────────────────────────────────────────────────────────────────────────
// EmpSection.jsx — Electrical Maintenance Program (EMP) settings.
//
// NFPA 70B:2023 made an effective EMP mandatory ("shall"); §4.2 requires the
// program to be documented in writing, and the standard requires the program
// to be reviewed at intervals not exceeding 5 years. This section owns the
// program-level metadata that feeds the generated EMP document:
//
//   GET/PUT /api/compliance/emp-settings →
//     { empCoordinatorUserId, retentionPolicyText, empLastReviewedAt }
//   (PUT is admin-only server-side; SettingsPage is already admin-routed but
//    we gate the buttons on isAdmin anyway.)
//
// "Mark program reviewed today" stamps empLastReviewedAt = now. A red warning
// renders when the last review is missing or older than 4.5 years — surfaced
// six months early so the operator isn't already out of compliance when they
// first see it.
//
// "Generate EMP document" POSTs /api/compliance/emp-document (same endpoint
// the Reports → Snapshots page uses) and points the user at Reports →
// Snapshots where the hash-anchored PDF lands.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BookOpenCheck } from 'lucide-react';
import api from '../../api/client';
import { useConfirm } from '../../context/ConfirmContext';
import Toast from '../Toast';
import { fmtDate } from '../../lib/equipment';
import { sectionHeading, sectionDesc, btnPrimary, btnSecondary } from './sharedStyles';

// 4.5 years in milliseconds — review warning threshold (5-year max interval,
// warned six months early).
const REVIEW_WARN_MS = 4.5 * 365.25 * 24 * 60 * 60 * 1000;

const fieldLabel = {
  display: 'block', fontSize: '0.8rem', fontWeight: 600,
  color: 'var(--color-text)', marginBottom: 4,
};
const control = {
  width: '100%', boxSizing: 'border-box',
  padding: '0.55rem 0.75rem', borderRadius: 6,
  border: '1px solid var(--color-border-strong)',
  fontSize: '0.875rem',
  background: 'var(--color-surface)', color: 'var(--color-text)',
};

export default function EmpSection({ isAdmin = false }) {
  const confirm = useConfirm();

  const [loading, setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving]     = useState(false);
  const [marking, setMarking]   = useState(false);
  const [generating, setGenerating] = useState(false);
  const [toast, setToast]       = useState(null);

  const [members, setMembers]   = useState([]);
  const [form, setForm] = useState({
    empCoordinatorUserId: '',
    retentionPolicyText:  '',
    empLastReviewedAt:    null, // read-only here; written via "Mark reviewed"
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get('/api/compliance/emp-settings'),
      // Members for the coordinator picker — bootstrap carries them; limit=1
      // keeps the asset payload negligible.
      api.get('/api/bootstrap', { params: { limit: 1 } }).catch(() => null),
    ])
      .then(([settingsRes, bootstrapRes]) => {
        if (cancelled) return;
        const s = settingsRes.data?.data || {};
        // Defensive: settings may arrive nested (data.settings) or flat.
        const settings = s.settings || s;
        setForm({
          empCoordinatorUserId: settings.empCoordinatorUserId || '',
          retentionPolicyText:  settings.retentionPolicyText || '',
          empLastReviewedAt:    settings.empLastReviewedAt || null,
        });
        const m = bootstrapRes?.data?.data?.members || bootstrapRes?.data?.data?.users || [];
        setMembers(m);
      })
      .catch(err => {
        if (!cancelled) setLoadError(err.response?.data?.error || 'Failed to load EMP settings.');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function putSettings(patch, successMessage) {
    const body = {
      empCoordinatorUserId: form.empCoordinatorUserId || null,
      retentionPolicyText:  form.retentionPolicyText || null,
      empLastReviewedAt:    form.empLastReviewedAt || null,
      ...patch,
    };
    const res = await api.put('/api/compliance/emp-settings', body);
    const s = res.data?.data || {};
    const settings = s.settings || s;
    setForm(f => ({
      empCoordinatorUserId: settings.empCoordinatorUserId ?? (body.empCoordinatorUserId || ''),
      retentionPolicyText:  settings.retentionPolicyText ?? (body.retentionPolicyText || ''),
      empLastReviewedAt:    settings.empLastReviewedAt ?? body.empLastReviewedAt ?? f.empLastReviewedAt,
    }));
    setToast({ message: successMessage, variant: 'success', duration: 5000 });
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!isAdmin || saving) return;
    setSaving(true);
    try {
      await putSettings({}, 'EMP settings saved.');
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to save EMP settings.', variant: 'error' });
    } finally {
      setSaving(false);
    }
  }

  async function handleMarkReviewed() {
    if (!isAdmin || marking) return;
    if (!await confirm({
      title: 'Mark program reviewed',
      message: 'Record that the electrical maintenance program was reviewed today? This sets the program review date used for the NFPA 70B 5-year interval check.',
      confirmLabel: 'Mark reviewed today',
    })) return;
    setMarking(true);
    try {
      await putSettings(
        { empLastReviewedAt: new Date().toISOString() },
        'Program review recorded for today.',
      );
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to record the program review.', variant: 'error' });
    } finally {
      setMarking(false);
    }
  }

  async function handleGenerateEmp() {
    if (generating) return;
    setGenerating(true);
    setToast({ message: 'Generating EMP document — rendering from live system data…', variant: 'info', duration: 8000 });
    try {
      const res = await api.post('/api/compliance/emp-document');
      const snap = res.data?.data?.snapshot || {};
      const shaPrefix = (snap.sha256 || '').slice(0, 12);
      setToast({
        message: shaPrefix
          ? `EMP document generated (hash ${shaPrefix}…). Find it under Reports → Snapshots.`
          : 'EMP document generated. Find it under Reports → Snapshots.',
        variant: 'success',
        duration: 10000,
      });
    } catch (err) {
      setToast({ message: err.response?.data?.error || 'Failed to generate the EMP document.', variant: 'error' });
    } finally {
      setGenerating(false);
    }
  }

  // Review-age warning: missing or older than 4.5 years → red banner.
  const lastReviewed = form.empLastReviewedAt ? new Date(form.empLastReviewedAt) : null;
  const lastReviewedValid = lastReviewed && !Number.isNaN(lastReviewed.getTime());
  const reviewStale = !lastReviewedValid || (Date.now() - lastReviewed.getTime()) > REVIEW_WARN_MS;

  if (loading) {
    return (
      <section style={{ marginTop: '0.5rem' }}>
        <h2 className={sectionHeading}>Electrical Maintenance Program (EMP)</h2>
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Loading…</div>
      </section>
    );
  }

  if (loadError) {
    return (
      <section style={{ marginTop: '0.5rem' }}>
        <h2 className={sectionHeading}>Electrical Maintenance Program (EMP)</h2>
        <div role="alert" style={{ padding: '0.75rem 1rem', borderRadius: 8, background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger)', color: 'var(--color-danger)', fontSize: '0.875rem' }}>
          {loadError}
        </div>
      </section>
    );
  }

  return (
    <section style={{ marginTop: '0.5rem' }}>
      <h2 className={sectionHeading}>Electrical Maintenance Program (EMP)</h2>
      <p className={sectionDesc}>
        NFPA 70B:2023 §4.2 requires your electrical maintenance program to be documented in writing.
        The settings here feed the generated EMP document — coordinator, records-retention policy,
        and the program review date.
      </p>

      {/* Review-interval warning — red when missing or >4.5 years old. */}
      {reviewStale && (
        <div
          role="alert"
          style={{
            display: 'flex', gap: 10, alignItems: 'flex-start',
            padding: '0.75rem 1rem', borderRadius: 8, marginBottom: '1.25rem',
            background: 'var(--color-danger-bg, #fef2f2)',
            border: '1px solid var(--color-danger, #dc2626)',
            color: 'var(--color-danger, #dc2626)',
            fontSize: '0.875rem', lineHeight: 1.5,
          }}
        >
          <AlertTriangle size={18} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} aria-hidden="true" />
          <div>
            <strong>
              {lastReviewedValid
                ? `Program review is due — last reviewed ${fmtDate(form.empLastReviewedAt)}, more than 4.5 years ago.`
                : 'No program review on record.'}
            </strong>{' '}
            NFPA 70B requires the EMP to be reviewed at intervals not exceeding 5 years.
            {isAdmin && ' Use "Mark program reviewed today" below after completing a review.'}
          </div>
        </div>
      )}

      <form onSubmit={handleSave} style={{ maxWidth: 560 }}>
        <div style={{ marginBottom: 14 }}>
          <label style={fieldLabel} htmlFor="emp-coordinator">EMP coordinator</label>
          <select
            id="emp-coordinator"
            style={{ ...control, cursor: isAdmin ? 'pointer' : 'not-allowed' }}
            value={form.empCoordinatorUserId || ''}
            onChange={e => setForm(f => ({ ...f, empCoordinatorUserId: e.target.value }))}
            disabled={!isAdmin}
          >
            <option value="">— Not assigned —</option>
            {members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
          <p style={{ fontSize: '0.775rem', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            The person responsible for the maintenance program. Named in the generated EMP document.
          </p>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={fieldLabel} htmlFor="emp-retention">Records-retention policy</label>
          <textarea
            id="emp-retention"
            rows={5}
            style={control}
            value={form.retentionPolicyText}
            onChange={e => setForm(f => ({ ...f, retentionPolicyText: e.target.value }))}
            disabled={!isAdmin}
            placeholder="e.g. Test reports and maintenance records are retained for the life of the equipment plus 7 years…"
          />
          <p style={{ fontSize: '0.775rem', color: 'var(--color-text-secondary)', marginTop: 4 }}>
            NFPA 70B requires a written policy for how long equipment maintenance and test records are
            retained. This text is included verbatim in the generated EMP document.
          </p>
        </div>

        {isAdmin && (
          <button type="submit" className={btnPrimary} disabled={saving}>
            {saving ? 'Saving…' : 'Save EMP settings'}
          </button>
        )}
      </form>

      {/* ── Program review ──────────────────────────────────────────────── */}
      <div style={{ marginTop: '1.75rem', paddingTop: '1.25rem', borderTop: '1px solid var(--color-border)' }}>
        <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--color-text)', marginBottom: 4 }}>
          Program review
        </div>
        <p style={{ fontSize: '0.825rem', color: 'var(--color-text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
          Last reviewed:{' '}
          <strong style={{ color: reviewStale ? 'var(--color-danger)' : 'var(--color-text)' }}>
            {lastReviewedValid ? fmtDate(form.empLastReviewedAt) : 'never'}
          </strong>
          {' '}— NFPA 70B requires review at intervals not exceeding 5 years.
        </p>
        {isAdmin && (
          <button type="button" className={btnSecondary} onClick={handleMarkReviewed} disabled={marking}>
            {marking ? 'Recording…' : 'Mark program reviewed today'}
          </button>
        )}
      </div>

      {/* ── Generate document ───────────────────────────────────────────── */}
      <div style={{ marginTop: '1.75rem', paddingTop: '1.25rem', borderTop: '1px solid var(--color-border)' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <BookOpenCheck size={16} color="var(--color-primary)" strokeWidth={1.75} aria-hidden="true" />
          <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--color-text)' }}>
            Written EMP document
          </div>
        </div>
        <p style={{ fontSize: '0.825rem', color: 'var(--color-text-secondary)', marginBottom: 10, lineHeight: 1.5 }}>
          Renders the written program document from live system data and anchors its integrity hash in the
          audit log. The PDF lands in{' '}
          <Link to="/reports/snapshots" style={{ color: 'var(--color-primary)' }}>Reports → Snapshots</Link>.
        </p>
        <button type="button" className={btnPrimary} onClick={handleGenerateEmp} disabled={generating}>
          {generating ? 'Generating…' : 'Generate EMP document'}
        </button>
      </div>

      <Toast toast={toast} onClose={() => setToast(null)} />
    </section>
  );
}
