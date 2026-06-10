// ─────────────────────────────────────────────────────────────────────────────
// PartnerSection.jsx — Customer-facing "Connected Partner" settings
//
// Shown only when the account has account.partnerOrgId set.
// Provides:
//   1. Four consent toggles (partner event categories)
//   2. Read-only audit log of partner events visible to the partner
//   3. "Revoke partner access" danger link
// ─────────────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import { sectionHeading, sectionDesc } from './sharedStyles';

// Consent AccountSetting keys (all default false — opt-in)
const CONSENT_KEYS = [
  {
    key:   'partner.consent.immediateDeficiency',
    label: 'Share IMMEDIATE deficiencies',
    desc:  'Notify your service partner when an IMMEDIATE-severity deficiency is logged.',
  },
  {
    key:   'partner.consent.taskOverdue',
    label: 'Share overdue task alerts',
    desc:  'Let your partner see when inspection tasks become overdue.',
  },
  {
    key:   'partner.consent.inspectionCompleted',
    label: 'Share inspection completions',
    desc:  'Notify your partner when a work order inspection is completed.',
  },
  {
    key:   'partner.consent.quoteRequest',
    label: 'Share quote requests',
    desc:  'Allow your partner to see new quote requests you submit.',
  },
];

const EVENT_TYPE_LABELS = {
  IMMEDIATE_DEFICIENCY:  'IMMEDIATE Deficiency',
  TASK_OVERDUE:          'Task Overdue',
  INSPECTION_COMPLETED:  'Inspection Completed',
  QUOTE_REQUEST_CREATED: 'Quote Request',
};

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function PartnerSection({ partnerOrgId, partnerOrgName, isAdmin }) {
  // Consent state: key → 'true' | 'false'
  const [consent, setConsent] = useState(
    Object.fromEntries(CONSENT_KEYS.map((c) => [c.key, 'false']))
  );
  const [consentLoading, setConsentLoading] = useState(true);
  const [consentSaving, setConsentSaving] = useState(null); // key currently saving

  // Audit log state
  const [events, setEvents] = useState([]);
  const [eventsLoading, setEventsLoading] = useState(true);

  // Revoke state
  const [revoking, setRevoking] = useState(false);
  const [revokeConfirm, setRevokeConfirm] = useState(false);
  const [revokeError, setRevokeError] = useState('');

  // ── Load consent settings ────────────────────────────────────────────────
  useEffect(() => {
    if (!partnerOrgId) return;
    setConsentLoading(true);
    api.get('/api/settings')
      .then((r) => {
        const settings = r.data?.settings ?? r.data ?? {};
        const loaded = { ...consent };
        for (const c of CONSENT_KEYS) {
          if (settings[c.key] !== undefined) loaded[c.key] = String(settings[c.key]);
        }
        setConsent(loaded);
      })
      .catch(() => {})
      .finally(() => setConsentLoading(false));
  }, [partnerOrgId]);

  // ── Load audit log ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!partnerOrgId) return;
    setEventsLoading(true);
    api.get('/api/settings/partner-events')
      .then((r) => setEvents(r.data.events ?? r.data ?? []))
      .catch(() => {})
      .finally(() => setEventsLoading(false));
  }, [partnerOrgId]);

  // ── Toggle a single consent key ──────────────────────────────────────────
  async function toggleConsent(key) {
    if (!isAdmin || consentSaving) return;
    const next = consent[key] === 'true' ? 'false' : 'true';
    setConsent((prev) => ({ ...prev, [key]: next })); // optimistic
    setConsentSaving(key);
    try {
      await api.put('/api/settings', { [key]: next });
    } catch (e) {
      // Roll back on failure
      setConsent((prev) => ({ ...prev, [key]: consent[key] }));
      console.error('Consent save failed', e);
    } finally {
      setConsentSaving(null);
    }
  }

  // ── Revoke partner access ────────────────────────────────────────────────
  async function handleRevoke() {
    if (revoking) return;
    setRevoking(true);
    setRevokeError('');
    try {
      await api.post('/api/settings/partner-revoke');
      // Hard reload so the section disappears (account.partnerOrgId is now null)
      window.location.reload();
    } catch (e) {
      setRevokeError(e.response?.data?.error ?? 'Failed to revoke access. Please try again.');
      setRevoking(false);
      setRevokeConfirm(false);
    }
  }

  if (!partnerOrgId) return null;

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2 style={sectionHeading}>Connected Partner</h2>
      <p style={sectionDesc}>
        Your account is connected to <strong>{partnerOrgName ?? 'a service partner'}</strong>.
        Control what information they can see below.
      </p>

      {/* ── Consent toggles ─────────────────────────────────────────────── */}
      <div style={S.card}>
        <div style={S.cardTitle}>Event sharing preferences</div>
        <p style={S.cardDesc}>
          All options are <strong>off by default</strong>. Enable categories you're comfortable
          sharing with your service partner.
        </p>

        {consentLoading ? (
          <div style={S.loading}>Loading preferences…</div>
        ) : (
          CONSENT_KEYS.map((c) => {
            const enabled = consent[c.key] === 'true';
            const saving  = consentSaving === c.key;
            return (
              <div key={c.key} style={S.toggleRow}>
                <div style={S.toggleMeta}>
                  <div style={S.toggleLabel}>{c.label}</div>
                  <div style={S.toggleDesc}>{c.desc}</div>
                </div>
                <button
                  role="switch"
                  aria-checked={enabled}
                  aria-label={c.label}
                  disabled={!isAdmin || !!consentSaving}
                  style={{
                    ...S.toggle,
                    background: enabled ? 'var(--accent)' : 'var(--color-text-muted)',
                    cursor: isAdmin && !consentSaving ? 'pointer' : 'not-allowed',
                    opacity: isAdmin ? 1 : 0.55,
                  }}
                  onClick={() => toggleConsent(c.key)}
                >
                  <div style={{
                    ...S.toggleThumb,
                    transform: enabled ? 'translateX(18px)' : 'translateX(2px)',
                  }} />
                </button>
                {saving && <span style={S.saving}>Saving…</span>}
              </div>
            );
          })
        )}

        {!isAdmin && (
          <p style={S.adminNote}>Admin access required to change sharing preferences.</p>
        )}
      </div>

      {/* ── Audit log ───────────────────────────────────────────────────── */}
      <div style={{ ...S.card, marginTop: 16 }}>
        <div style={S.cardTitle}>Partner event log</div>
        <p style={S.cardDesc}>
          Events your service partner has received about this account. Read-only.
        </p>

        {eventsLoading ? (
          <div style={S.loading}>Loading event log…</div>
        ) : events.length === 0 ? (
          <div style={S.empty}>No partner events recorded yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={S.table}>
              <thead>
                <tr>
                  <th style={S.th}>Event</th>
                  <th style={S.th}>Asset</th>
                  <th style={S.th}>Sent</th>
                  <th style={S.th}>Actioned</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => {
                  const p = ev.payload ?? {};
                  return (
                    <tr key={ev.id} style={S.tr}>
                      <td style={S.td}>
                        <span style={S.eventBadge}>
                          {EVENT_TYPE_LABELS[ev.eventType] ?? ev.eventType}
                        </span>
                      </td>
                      <td style={S.td}>{p.assetName ?? '—'}</td>
                      <td style={S.td}>{fmtDate(ev.digestSentAt ?? ev.immediateEmailSentAt ?? ev.createdAt)}</td>
                      <td style={S.td}>{ev.actionedAt ? fmtDate(ev.actionedAt) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Revoke access ───────────────────────────────────────────────── */}
      {isAdmin && (
        <div style={{ ...S.card, marginTop: 16, borderColor: '#fca5a5' }}>
          <div style={S.cardTitle}>Disconnect partner</div>
          <p style={S.cardDesc}>
            Removes this account's link to {partnerOrgName ?? 'the partner org'} and resets all
            sharing preferences to off. This cannot be undone — you would need a new invite to
            reconnect.
          </p>
          {!revokeConfirm ? (
            <button style={S.revokeLink} onClick={() => setRevokeConfirm(true)}>
              Revoke partner access entirely →
            </button>
          ) : (
            <div style={S.revokeConfirmBox}>
              <p style={{ margin: '0 0 12px', fontSize: 13, color: '#b91c1c' }}>
                This will immediately disconnect the partner and clear all shared settings.
                Are you sure?
              </p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  style={S.revokeDangerBtn}
                  onClick={handleRevoke}
                  disabled={revoking}
                >
                  {revoking ? 'Revoking…' : 'Yes, revoke access'}
                </button>
                <button
                  style={S.revokeCancelBtn}
                  onClick={() => setRevokeConfirm(false)}
                  disabled={revoking}
                >
                  Cancel
                </button>
              </div>
              {revokeError && <p style={{ marginTop: 8, fontSize: 12, color: '#b91c1c' }}>{revokeError}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────
const S = {
  card: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '16px 20px',
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
    marginBottom: 4,
  },
  cardDesc: {
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    margin: '0 0 14px',
  },
  loading: {
    fontSize: 13,
    color: 'var(--color-text-secondary)',
    padding: '8px 0',
  },
  empty: {
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    fontStyle: 'italic',
    padding: '6px 0',
  },
  adminNote: {
    marginTop: 10,
    fontSize: 12,
    color: 'var(--color-text-secondary)',
    fontStyle: 'italic',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 0',
    borderBottom: '1px solid var(--border)',
  },
  toggleMeta: {
    flex: 1,
  },
  toggleLabel: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text-primary)',
  },
  toggleDesc: {
    fontSize: 11,
    color: 'var(--color-text-secondary)',
    marginTop: 2,
  },
  toggle: {
    width: 40,
    height: 22,
    borderRadius: 11,
    border: 'none',
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    transition: 'background 0.2s',
    padding: 0,
  },
  toggleThumb: {
    width: 18,
    height: 18,
    borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    transition: 'transform 0.2s',
    flexShrink: 0,
  },
  saving: {
    fontSize: 11,
    color: 'var(--color-text-secondary)',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
  },
  th: {
    padding: '6px 10px',
    textAlign: 'left',
    fontWeight: 600,
    fontSize: 11,
    color: 'var(--color-text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    borderBottom: '1px solid var(--border)',
    whiteSpace: 'nowrap',
  },
  tr: {
    borderBottom: '1px solid var(--border)',
  },
  td: {
    padding: '8px 10px',
    color: 'var(--text-primary)',
    verticalAlign: 'middle',
  },
  eventBadge: {
    fontSize: 11,
    padding: '2px 7px',
    borderRadius: 10,
    background: 'var(--surface-2, #f3f4f6)',
    color: 'var(--text-primary)',
    fontWeight: 600,
    whiteSpace: 'nowrap',
  },
  revokeLink: {
    background: 'none',
    border: 'none',
    color: '#b91c1c',
    fontSize: 13,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
  },
  revokeConfirmBox: {
    marginTop: 4,
  },
  revokeDangerBtn: {
    padding: '7px 16px',
    fontSize: 13,
    background: '#b91c1c',
    color: '#fff',
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    fontWeight: 600,
  },
  revokeCancelBtn: {
    padding: '7px 16px',
    fontSize: 13,
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
  },
};
