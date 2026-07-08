import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';

import { sectionHeading, sectionDesc, btnPrimary } from './sharedStyles';

// ── Document Encryption Section ───────────────────────────────────────────────
//
// [2026-07-08 acquisition-audit fix, W1-H8/Security Architect] This used to be
// an in-app enable/disable toggle (POST /api/settings/encryption/enable etc.)
// that recorded a hash-chained "encryption_enabled" audit event even though
// nothing in the server ever read that flag — document encryption was, and
// still is, gated purely by the server-level ENCRYPT_DOCS env var (see
// routes/documents.ts, routes/settings.ts:1005). A tamper-evident audit log
// faithfully attesting to a control that did nothing was judged the single
// worst artifact a security reviewer could find here, so the backend routes
// were removed rather than built out into real per-account gating (that's a
// genuine feature project — env-level toggle -> per-account DB-driven gate,
// plus bringing photo uploads to parity — tracked as a future item, not done
// in this pass). There is no API surface left that can honestly report a
// live on/off status (GET /api/settings does not expose ENCRYPT_DOCS, and
// adding a status-only endpoint just to back this panel felt like exactly
// the kind of paper-vs-reality gap this fix is closing) — so this panel is
// now a static explanation of how encryption actually works today, not a
// dynamic toggle or status readout.

export default function EncryptionSection() {
  // #12: which roles may reveal (decrypt+view) contract license keys.
  const [revealRoles,  setRevealRoles]  = useState(['admin', 'manager']);
  const [revealSaving, setRevealSaving] = useState(false);
  const [revealMsg,    setRevealMsg]    = useState(null);

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

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Document Encryption at Rest</h2>
      <p className={sectionDesc}>
        Documents can be encrypted with AES-256-GCM before being written to disk or cloud
        storage, protecting them against unauthorized access at the storage layer — disk theft,
        unauthorized filesystem access, or a storage bucket being accessed without permission.
      </p>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', padding: '0.875rem 1rem', borderRadius: 8, border: '1px solid var(--color-border)', background: 'var(--color-surface)', marginBottom: '1rem' }}>
        <span style={{
          display: 'inline-block', width: 10, height: 10, borderRadius: '50%', marginTop: 4, flexShrink: 0,
          background: '#9ca3af', // operator-controlled, not a runtime-known on/off state from here
        }} />
        <div style={{ fontSize: '0.85rem', color: 'var(--color-text)', lineHeight: 1.6 }}>
          This is an operator-level setting, not an in-app toggle. Your server administrator
          enables it by setting <code>ENCRYPT_DOCS=true</code> and a <code>MASTER_KEY</code>{' '}
          in the server's environment configuration — ask your ServiceCycle administrator if
          you need to confirm whether it's currently active. When it is, new document uploads
          are encrypted with that key going forward; existing uploads and photo captures are not
          affected by this setting.
        </div>
      </div>
      <p className={sectionDesc} style={{ color: 'var(--color-warning)', background: 'var(--color-warning-bg)', border: '1px solid #fde68a', borderRadius: 6, padding: '0.625rem 0.875rem' }}>
        <strong>The MASTER_KEY is not recoverable if lost.</strong> Encrypted documents can only
        be decrypted with the MASTER_KEY that was active when they were uploaded. A database
        backup does not contain it — it must be backed up separately by whoever manages the
        server, in a secure location apart from the server itself.
      </p>

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
    </section>
  );
}
