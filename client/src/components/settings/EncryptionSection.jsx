import React, { useState, useEffect, useCallback } from 'react';
import { useConfirm } from '../../context/ConfirmContext';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnPrimary, btnSecondary } from './sharedStyles';

// ── Document Encryption Section ───────────────────────────────────────────────

const ENCRYPTION_ACKNOWLEDGE_TEXT =
  'I understand that document encryption uses my server\'s MASTER_KEY. ' +
  'If that key is lost or changed, every encrypted document stored in ServiceCycle ' +
  'becomes permanently and irrecoverably unreadable — including by ForgeRift LLC. ' +
  'I have backed up my MASTER_KEY in a secure location separate from this server ' +
  'before enabling this feature.';

// Form-field style primitives used by the enable-encryption modal (step 2).
// Referenced as ...fieldLabel / ...input but never declared after an earlier
// refactor; that crashed the Verify-Key step with a ReferenceError.
const fieldLabel = { fontSize: '0.8rem', fontWeight: 600, color: 'var(--color-text)' };
const input = {
  padding: '8px 11px',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  background: 'var(--color-surface)',
  color: 'var(--color-text)',
  fontSize: '0.85rem',
  width: '100%',
  boxSizing: 'border-box',
};

export default function EncryptionSection() {
  const confirm = useConfirm();
  const [encStatus,  setEncStatus]  = useState(null);   // { enabled, acknowledgedAt, masterKeyHint, masterKeyPresent }
  const [loading,    setLoading]    = useState(true);
  const [modal,      setModal]      = useState(false);   // show opt-in modal
  const [step,       setStep]       = useState(1);       // 1=explain 2=verify 3=confirm
  const [keyTail,    setKeyTail]    = useState('');
  const [keyMatch,   setKeyMatch]   = useState(null);    // null | true | false
  const [verifying,  setVerifying]  = useState(false);
  const [checked,    setChecked]    = useState(false);
  const [enabling,   setEnabling]   = useState(false);
  const [disabling,  setDisabling]  = useState(false);
  const [msg,        setMsg]        = useState(null);
  // #12: which roles may reveal (decrypt+view) contract license keys.
  const [revealRoles,  setRevealRoles]  = useState(['admin', 'manager']);
  const [revealSaving, setRevealSaving] = useState(false);
  const [revealMsg,    setRevealMsg]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/settings/encryption/status');
      setEncStatus(res.data.data);
    } catch {
      setMsg({ ok: false, text: 'Failed to load encryption status.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // #12: load + persist the license-key reveal-roles policy (admin-only setting).
  const loadRevealRoles = useCallback(async () => {
    try {
      const res = await api.get('/api/settings');
      const raw = res.data?.data?.LICENSE_REVEAL_ROLES;
      let roles = ['admin', 'manager'];
      if (raw) { try { const a = JSON.parse(raw); if (Array.isArray(a) && a.length) roles = a; } catch { /* keep default */ } }
      if (!roles.includes('admin')) roles.push('admin');
      setRevealRoles(roles);
    } catch { /* non-admins cannot read settings; keep default */ }
  }, []);
  useEffect(() => { loadRevealRoles(); }, [loadRevealRoles]);

  const toggleRevealRole = (role) => {
    if (role === 'admin') return; // admin can never be removed
    setRevealMsg(null);
    setRevealRoles((prev) => prev.includes(role) ? prev.filter((r) => r !== role) : [...prev, role]);
  };
  const saveRevealRoles = async () => {
    setRevealSaving(true); setRevealMsg(null);
    try {
      const roles = revealRoles.includes('admin') ? revealRoles : ['admin', ...revealRoles];
      await api.put('/api/settings', { LICENSE_REVEAL_ROLES: JSON.stringify(roles) });
      setRevealMsg({ ok: true, text: 'License key reveal access saved.' });
    } catch (err) {
      setRevealMsg({ ok: false, text: err.response?.data?.error || 'Failed to save reveal access.' });
    } finally { setRevealSaving(false); }
  };

  function openModal() {
    setStep(1); setKeyTail(''); setKeyMatch(null);
    setChecked(false); setMsg(null); setModal(true);
  }
  function closeModal() { setModal(false); }

  async function verifyKey() {
    if (keyTail.length !== 8) return;
    setVerifying(true); setKeyMatch(null);
    try {
      const res = await api.post('/api/settings/encryption/verify-key', { tail: keyTail });
      setKeyMatch(res.data.data.match);
      if (res.data.data.match) setStep(3);
    } catch {
      setKeyMatch(false);
    } finally {
      setVerifying(false);
    }
  }

  async function enableEncryption() {
    if (!checked || keyTail.length !== 8) return;
    setEnabling(true);
    try {
      await api.post('/api/settings/encryption/enable', { tail: keyTail, acknowledged: true });
      setModal(false);
      setMsg({ ok: true, text: 'Document encryption is now enabled. New uploads will be encrypted at rest.' });
      load();
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'Failed to enable encryption.' });
      setModal(false);
    } finally {
      setEnabling(false);
    }
  }

  async function disableEncryption() {
    if (!await confirm({
      title: 'Disable encryption',
      message:
        'Disable encryption for new uploads?\n\n' +
        'Already-encrypted documents will remain encrypted and will still open correctly ' +
        'as long as your MASTER_KEY is unchanged.\n\n' +
        'New documents uploaded after disabling will NOT be encrypted.',
      confirmLabel: 'Disable encryption',
      danger: true,
    })) return;
    setDisabling(true);
    try {
      await api.post('/api/settings/encryption/disable');
      setMsg({ ok: true, text: 'Encryption disabled. New uploads will be stored unencrypted.' });
      load();
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'Failed to disable encryption.' });
    } finally {
      setDisabling(false);
    }
  }

  function fmtDate(d) {
    if (!d) return '—';
    return new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Document Encryption at Rest</h2>
      <p className={sectionDesc}>
        When enabled, every document uploaded to ServiceCycle is encrypted with AES-256-GCM
        before being written to disk or cloud storage. This protects contract documents
        against unauthorized access at the storage layer — disk theft, unauthorized
        filesystem access, or a storage bucket being accessed without permission.
      </p>
      <p className={sectionDesc} style={{ color: 'var(--color-warning)', background: 'var(--color-warning-bg)', border: '1px solid #fde68a', borderRadius: 6, padding: '0.625rem 0.875rem' }}>
        <strong>This feature is opt-in and irreversible per document.</strong> Encrypted
        documents can only be decrypted with the MASTER_KEY that was active when they were
        uploaded. If that key is lost, those documents are permanently unreadable — by you,
        by your team, and by ForgeRift LLC. Read the confirmation steps carefully before enabling.
      </p>

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Loading…</div>
      ) : (
        <>
          {/* Status row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.875rem 1rem', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)', marginBottom: '1rem' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span style={{
                  display: 'inline-block', width: 10, height: 10, borderRadius: '50%',
                  background: encStatus?.enabled ? 'var(--color-success)' : '#9ca3af', // inactive status dot -- no existing token for muted-circle gray; defer to soft-tints pass
                }} />
                <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--color-text)' }}>
                  {encStatus?.enabled ? 'Encryption enabled' : 'Encryption disabled'}
                </span>
              </div>
              {encStatus?.enabled ? (
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                  Enabled {fmtDate(encStatus.acknowledgedAt)} · Active key ends in{' '}
                  <code style={{ fontSize: '0.78rem' }}>{encStatus.masterKeyHint}</code>
                </div>
              ) : (
                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>
                  New uploads are stored unencrypted. Encryption can be enabled below.
                </div>
              )}
            </div>
            {encStatus?.enabled ? (
              <button type="button" onClick={disableEncryption} disabled={disabling}
                className={btnSecondary} style={{ color: 'var(--color-danger)', borderColor: 'var(--color-danger)', whiteSpace: 'nowrap' }}>
                {disabling ? 'Disabling…' : 'Disable'}
              </button>
            ) : (
              <button type="button" onClick={openModal} disabled={!encStatus?.masterKeyPresent}
                className={btnPrimary} style={{ whiteSpace: 'nowrap', opacity: encStatus?.masterKeyPresent ? 1 : 0.5 }}>
                Enable Encryption
              </button>
            )}
          </div>

          {!encStatus?.masterKeyPresent && (
            <div style={{ fontSize: '0.8rem', color: 'var(--color-danger)', marginBottom: '1rem' }}>
              MASTER_KEY is not set on this server. Set it in your .env file to use document encryption.
            </div>
          )}

          {msg && (
            <div style={{ padding: '0.625rem 0.875rem', borderRadius: 6, marginBottom: '1rem', background: msg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)', border: `1px solid ${msg.ok ? 'var(--color-success-bg-strong)' : 'var(--color-danger)'}`, color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.825rem' }}>
              {msg.text}
            </div>
          )}
        </>
      )}

      {/* #12: License Key Reveal Access -- which roles may decrypt + view contract
          license keys. Admin is always allowed; every reveal is audited. */}
      <div style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
        <h2 className={sectionHeading}>License Key Reveal Access</h2>
        <p className={sectionDesc}>
          Contract license keys are encrypted at rest and masked by default. Choose which roles
          may reveal (decrypt and view) them on a contract. Every reveal is recorded in the
          activity audit. Administrators can always reveal.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: '1rem' }}>
          {[
            { role: 'admin',   label: 'Administrators', always: true },
            { role: 'manager', label: 'Managers',       always: false },
            { role: 'viewer',  label: 'Viewers',        always: false },
          ].map(({ role, label, always }) => (
            <label key={role} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '0.9rem', color: 'var(--color-text)' }}>
              <input type="checkbox" checked={revealRoles.includes(role)} disabled={always} onChange={() => toggleRevealRole(role)} style={{ width: 16, height: 16 }} />
              {label}{always ? ' (always allowed)' : ''}
            </label>
          ))}
        </div>
        {revealMsg && (
          <div style={{ padding: '0.5rem 0.875rem', borderRadius: 6, marginBottom: '0.75rem', background: revealMsg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)', color: revealMsg.ok ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.825rem' }}>
            {revealMsg.text}
          </div>
        )}
        <button type="button" onClick={saveRevealRoles} disabled={revealSaving} className={btnPrimary}>
          {revealSaving ? 'Saving...' : 'Save reveal access'}
        </button>
      </div>

      {/* ── Opt-in modal ─────────────────────────────────────────────────── */}
      {modal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 12, maxWidth: 560, width: '100%', padding: '2rem', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', maxHeight: '90vh', overflowY: 'auto' }}>

            {/* Step indicators */}
            <div style={{ display: 'flex', gap: 8, marginBottom: '1.5rem' }}>
              {[1,2,3].map(n => (
                <div key={n} style={{ flex: 1, height: 3, borderRadius: 2, background: step >= n ? 'var(--accent)' : 'var(--color-border)' }} />
              ))}
            </div>

            {/* ── Step 1: Understand what this does ── */}
            {step === 1 && (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-text)', marginBottom: '0.75rem' }}>
                  Before you enable encryption
                </h3>
                <div style={{ fontSize: '0.875rem', color: 'var(--color-text)', lineHeight: 1.7, marginBottom: '1.25rem' }}>
                  <p style={{ marginBottom: '0.75rem' }}>
                    Document encryption uses AES-256-GCM — the same standard used by banks and
                    government systems. Every file uploaded after enabling will be encrypted before
                    it is written to your storage.
                  </p>
                  <div style={{ background: 'var(--color-danger-bg)', border: '1px solid #fecaca', borderRadius: 8, padding: '0.875rem 1rem', marginBottom: '0.875rem' }}>
                    <div style={{ fontWeight: 700, color: 'var(--color-danger-strong)', marginBottom: 6, fontSize: '0.875rem' }}>
                      ⚠ PERMANENT RISK — READ THIS
                    </div>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--color-danger-strong)', fontSize: '0.85rem', lineHeight: 1.8 }}>
                      <li>Encrypted documents can <strong>only</strong> be decrypted using the <strong>MASTER_KEY</strong> that was set on your server when they were uploaded.</li>
                      <li>If your MASTER_KEY is lost, deleted, or changed, <strong>every encrypted document becomes permanently unreadable.</strong> There is no recovery process — not by you, not by your IT team, and not by ForgeRift LLC.</li>
                      <li>A database backup does not contain your MASTER_KEY. You must back it up separately.</li>
                      <li>Documents uploaded <strong>before</strong> enabling encryption are not affected. Only new uploads are encrypted going forward.</li>
                    </ul>
                  </div>
                  <div style={{ background: 'var(--color-success-bg)', border: '1px solid #bbf7d0', borderRadius: 8, padding: '0.875rem 1rem' }}>
                    <div style={{ fontWeight: 700, color: 'var(--color-success)', marginBottom: 6, fontSize: '0.875rem' }}>
                      ✓ What you must do before enabling
                    </div>
                    <ul style={{ margin: 0, paddingLeft: '1.25rem', color: 'var(--color-success-bg-strong)', fontSize: '0.85rem', lineHeight: 1.8 }}>
                      <li>Copy your MASTER_KEY from your server's .env file right now.</li>
                      <li>Store it in a <strong>team password manager</strong> (1Password, Bitwarden, etc.) so it is not tied to one person.</li>
                      <li>Optionally, store an offline copy (printed, encrypted USB) in a physically secure location.</li>
                      <li>Verify your backup is current — you will be asked to confirm this on the next screen.</li>
                    </ul>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={closeModal} className={btnSecondary}>Cancel</button>
                  <button type="button" onClick={() => setStep(2)} className={btnPrimary}>I've Read This — Continue</button>
                </div>
              </>
            )}

            {/* ── Step 2: Prove you have the key ── */}
            {step === 2 && (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-text)', marginBottom: '0.5rem' }}>
                  Verify your MASTER_KEY backup
                </h3>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
                  To prove you have your MASTER_KEY accessible from somewhere other than this server,
                  enter the <strong>last 8 characters</strong> of your MASTER_KEY exactly as it appears in your .env file.
                </p>
                <div style={{ background: 'var(--color-warning-bg)', border: '1px solid #fde68a', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem', fontSize: '0.825rem', color: 'var(--color-warning)' }}>
                  <strong>This is not your login password.</strong> Open your server's .env file
                  (or your password manager) and find the line that starts with <code>MASTER_KEY=</code>.
                  Copy the last 8 characters of that value and enter them below.
                  The active key on this server ends in{' '}
                  <code style={{ background: 'var(--color-warning-bg)', padding: '1px 4px', borderRadius: 3 }}>{encStatus?.masterKeyHint}</code>.
                </div>
                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ ...fieldLabel, display: 'block', marginBottom: 6 }}>
                    Last 8 characters of MASTER_KEY
                  </label>
                  <input
                    type="text"
                    value={keyTail}
                    onChange={e => { setKeyTail(e.target.value.slice(0, 8)); setKeyMatch(null); }}
                    placeholder="e.g. aB3xQ9rZ"
                    maxLength={8}
                    style={{ ...input, fontFamily: 'monospace', letterSpacing: '0.1em', fontSize: '1rem', maxWidth: 200 }}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {keyMatch === false && (
                    <div style={{ color: 'var(--color-danger)', fontSize: '0.8rem', marginTop: 6 }}>
                      Those characters don't match the MASTER_KEY on this server. Check your backup and try again.
                    </div>
                  )}
                  {keyMatch === true && (
                    <div style={{ color: 'var(--color-success)', fontSize: '0.8rem', marginTop: 6 }}>
                      ✓ Verified — your backup matches the active key.
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setStep(1)} className={btnSecondary}>Back</button>
                  <button
                    type="button"
                    onClick={verifyKey}
                    disabled={keyTail.length !== 8 || verifying}
                    className={btnPrimary} style={{ opacity: keyTail.length !== 8 ? 0.5 : 1 }}
                  >
                    {verifying ? 'Checking…' : 'Verify Key'}
                  </button>
                </div>
              </>
            )}

            {/* ── Step 3: Final acknowledgment ── */}
            {step === 3 && (
              <>
                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--color-text)', marginBottom: '0.5rem' }}>
                  Final confirmation
                </h3>
                <p style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
                  Key verified. Read the statement below carefully, then check the box to confirm.
                </p>

                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '1rem', background: 'var(--color-danger-bg)', border: `2px solid ${checked ? 'var(--color-success)' : 'var(--color-danger)'}`, borderRadius: 8, cursor: 'pointer', marginBottom: '1.25rem', transition: 'border-color 0.15s' }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={e => setChecked(e.target.checked)}
                    style={{ marginTop: 3, flexShrink: 0, width: 16, height: 16, cursor: 'pointer' }}
                  />
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-danger-strong)', lineHeight: 1.7 }}>
                    {ENCRYPTION_ACKNOWLEDGE_TEXT}
                  </span>
                </label>

                <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: '1.25rem', lineHeight: 1.5 }}>
                  This acknowledgment will be recorded with your name and timestamp for audit purposes.
                </div>

                <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                  <button type="button" onClick={() => setStep(2)} className={btnSecondary}>Back</button>
                  <button
                    type="button"
                    onClick={enableEncryption}
                    disabled={!checked || enabling}
                    className={btnPrimary} style={{ background: checked ? 'var(--color-success)' : undefined, opacity: checked ? 1 : 0.5 }}
                  >
                    {enabling ? 'Enabling…' : 'Enable Document Encryption'}
                  </button>
                </div>
              </>
            )}

          </div>
        </div>
      )}
    </section>
  );
}
