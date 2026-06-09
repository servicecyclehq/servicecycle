// BrandingSection.jsx — White-label branding settings
// Lets admins set a custom logo URL, primary color, and display name.
// Changes take effect on next page load (CSS vars re-applied via useBranding).

import { useState, useEffect } from 'react';
import api from '../../api/client';

export default function BrandingSection({ isAdmin }) {
  const [logoUrl,      setLogoUrl]      = useState('');
  const [primaryColor, setPrimaryColor] = useState('');
  const [displayName,  setDisplayName]  = useState('');
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState(null);

  useEffect(() => {
    api.get('/api/settings/branding')
      .then((r) => {
        const d = r.data.data;
        setLogoUrl(d.logoUrl      ?? '');
        setPrimaryColor(d.primaryColor ?? '');
        setDisplayName(d.displayName  ?? '');
      })
      .catch(() => setError('Failed to load branding settings.'))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true); setSaved(false); setError(null);
    try {
      await api.put('/api/settings/branding', {
        logoUrl:      logoUrl.trim()      || null,
        primaryColor: primaryColor.trim() || null,
        displayName:  displayName.trim()  || null,
      });
      setSaved(true);
      // Apply new color immediately without a reload
      if (primaryColor && /^#[0-9a-fA-F]{6}$/.test(primaryColor)) {
        document.documentElement.style.setProperty('--color-primary', primaryColor);
      }
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err.response?.data?.error ?? 'Failed to save branding.');
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div style={{ padding: 32, color: 'var(--color-text-secondary)' }}>Loading…</div>;

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={sectionHeader}>
        <h2 style={sectionTitle}>White-Label Branding</h2>
        <p style={sectionDesc}>
          Customize the app's appearance for your organization or an OEM partner deployment.
          Changes apply to all users in this account.
        </p>
      </div>

      {error && <div style={alertError}>{error}</div>}
      {saved && <div style={alertSuccess}>Branding saved. Reload the page to see all changes.</div>}

      <form onSubmit={handleSave}>
        <div className="form-group">
          <label className="form-label">Display Name</label>
          <input
            className="form-control"
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="e.g. Eaton Service Portal"
            disabled={!isAdmin}
            maxLength={80}
          />
          <p className="form-hint">Replaces "ServiceCycle" in the sidebar and browser tab.</p>
        </div>

        <div className="form-group">
          <label className="form-label">Logo URL</label>
          <input
            className="form-control"
            type="url"
            value={logoUrl}
            onChange={(e) => setLogoUrl(e.target.value)}
            placeholder="https://example.com/logo.png"
            disabled={!isAdmin}
          />
          <p className="form-hint">
            HTTPS image URL. Recommended: PNG or SVG, max 200×48px, transparent background.
          </p>
          {logoUrl && (
            <div style={logoPreview}>
              <img src={logoUrl} alt="Brand logo preview" style={{ maxHeight: 40, maxWidth: 180 }}
                   onError={(e) => { e.target.style.display = 'none'; }} />
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">Primary Color</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input
              className="form-control"
              type="text"
              value={primaryColor}
              onChange={(e) => setPrimaryColor(e.target.value)}
              placeholder="#073a52"
              disabled={!isAdmin}
              style={{ maxWidth: 160, fontFamily: 'var(--font-mono, monospace)' }}
              maxLength={7}
            />
            <input
              type="color"
              value={/^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : '#073a52'}
              onChange={(e) => setPrimaryColor(e.target.value)}
              disabled={!isAdmin}
              style={{ width: 40, height: 36, padding: 2, border: '1px solid var(--color-border)', borderRadius: 6, cursor: isAdmin ? 'pointer' : 'not-allowed' }}
              title="Pick a color"
            />
            {/^#[0-9a-fA-F]{6}$/.test(primaryColor) && (
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                background: primaryColor,
                border: '1px solid var(--color-border)',
                flexShrink: 0,
              }} />
            )}
          </div>
          <p className="form-hint">6-digit hex (e.g. #0057b8). Used for buttons, active nav, and focus rings.</p>
        </div>

        {isAdmin && (
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Branding'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={saving}
              onClick={() => {
                setLogoUrl('');
                setPrimaryColor('');
                setDisplayName('');
              }}
            >
              Reset to Defaults
            </button>
          </div>
        )}
      </form>

      <div style={previewBox}>
        <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          Preview
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          {logoUrl
            ? <img src={logoUrl} alt="" style={{ height: 28 }} onError={(e) => { e.target.style.display = 'none'; }} />
            : <div style={{ fontWeight: 600, fontSize: 16, color: primaryColor || 'var(--color-primary)' }}>
                {displayName || 'ServiceCycle'}
              </div>
          }
        </div>
        <button style={{
          padding: '7px 16px',
          background: /^#[0-9a-fA-F]{6}$/.test(primaryColor) ? primaryColor : 'var(--color-primary)',
          color: '#fff',
          border: 'none',
          borderRadius: 6,
          fontSize: 13,
          fontWeight: 500,
          cursor: 'default',
        }}>
          Sample Button
        </button>
      </div>
    </div>
  );
}

const sectionHeader = { marginBottom: 24 };
const sectionTitle  = { fontSize: 16, fontWeight: 600, marginBottom: 6 };
const sectionDesc   = { fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.5, margin: 0 };
const alertError    = { padding: '10px 14px', background: 'var(--color-danger-bg, #fee2e2)', color: 'var(--color-danger, #dc2626)', borderRadius: 6, fontSize: 13, marginBottom: 16 };
const alertSuccess  = { padding: '10px 14px', background: 'var(--color-success-bg, #dcfce7)', color: 'var(--color-success, #15803d)', borderRadius: 6, fontSize: 13, marginBottom: 16 };
const logoPreview   = { marginTop: 8, padding: '10px 14px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 6, display: 'inline-block' };
const previewBox    = { marginTop: 24, padding: '16px 18px', background: 'var(--color-bg)', border: '1px solid var(--color-border)', borderRadius: 8 };
