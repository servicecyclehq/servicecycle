// ─────────────────────────────────────────────────────────────────────────────
// InsurerPackageCard.jsx -- Phase 1 #3 insurer underwriting package + break-glass
// share link (manager+).
//
// Shows a one-click summary of the insurer underwriting packet (compliance %,
// risk posture, capital plan, evidence integrity) and lets a manager mint a
// time-boxed, view-only, revocable "break-glass" link to hand an underwriter.
//
// GET  /api/compliance/underwriting-package  -> summary
// POST /api/share-links { kind:'underwriting', days, label } -> create link
// GET  /api/share-links / POST :id/revoke    -> manage links
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Copy, Check } from 'lucide-react';
import api from '../api/client';

function usd(n) {
  if (n == null || Number.isNaN(Number(n))) return '—';
  return `$${Math.round(Number(n)).toLocaleString('en-US')}`;
}
function range(r) {
  if (!r) return '—';
  return r.min === r.max ? usd(r.min) : `${usd(r.min)}–${usd(r.max)}`;
}
function fmtDate(d) {
  if (!d) return '—';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '—' : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function InsurerPackageCard() {
  const [pkg, setPkg] = useState(null);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [label, setLabel] = useState('');
  const [days, setDays] = useState(14);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState('');

  const loadLinks = useCallback(async () => {
    try {
      const res = await api.get('/api/share-links');
      const all = res.data?.data?.links || [];
      setLinks(all.filter((l) => l.kind === 'underwriting'));
    } catch { /* leave list empty */ }
  }, []);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await api.get('/api/compliance/underwriting-package');
      setPkg(res.data.data);
      await loadLinks();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to load underwriting package');
    } finally { setLoading(false); }
  }, [loadLinks]);

  useEffect(() => { load(); }, [load]);

  const createLink = async () => {
    setCreating(true);
    try {
      await api.post('/api/share-links', { kind: 'underwriting', days, label: label.trim() || null });
      setLabel('');
      await loadLinks();
    } catch (e) {
      setError(e?.response?.data?.error || 'Failed to create insurer link');
    } finally { setCreating(false); }
  };

  const revoke = async (id) => {
    try { await api.post(`/api/share-links/${id}/revoke`); await loadLinks(); } catch { /* noop */ }
  };

  const copyLink = (path, id) => {
    const url = `${window.location.origin}${path}`;
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).catch(() => {});
    setCopied(id);
    setTimeout(() => setCopied(''), 1500);
  };

  if (loading) return <div className="card mb-16"><div className="card-body" style={{ color: 'var(--color-text-secondary)' }}>Loading insurer package…</div></div>;
  if (error)   return <div className="card mb-16"><div className="card-body" style={{ color: '#b91c1c' }}>{error}</div></div>;
  if (!pkg)    return null;

  const rd = pkg.readiness || {};
  const rp = pkg.riskPosture || {};
  const fin = pkg.financial || {};
  const ev = pkg.evidenceIntegrity || {};

  return (
    <div className="card mb-16">
      <div className="card-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ShieldCheck size={18} />
        <div className="card-title" style={{ flex: 1 }}>Insurer Underwriting Package</div>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginBottom: 12 }}>
          <div><div style={{ fontSize: 22, fontWeight: 800 }}>{rd.overallRate ?? '—'}%</div><div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>compliance · maturity {rd.score ?? '—'}</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 800 }}>{rp.totalFindings ?? 0}</div><div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>audit findings</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 800 }}>{(rp.untrackedAssets ?? 0) + (rp.forgottenAssets ?? 0)}</div><div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>off-radar assets</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 800 }}>{range(fin.plan?.year5)}</div><div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>5-yr capital plan</div></div>
          <div><div style={{ fontSize: 22, fontWeight: 800 }}>{ev.snapshotCount ?? 0}</div><div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>immutable snapshots</div></div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
          Mint a time-boxed, view-only "break-glass" link to share this packet with an underwriter — no login, revocable any time, every view logged.
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <input
            className="form-control"
            style={{ maxWidth: 220, height: 32 }}
            placeholder="Insurer / underwriter name"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-label="Insurer name"
          />
          <select className="form-control" style={{ maxWidth: 130, height: 32 }} value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Link lifetime">
            <option value={7}>Expires 7 days</option>
            <option value={14}>Expires 14 days</option>
            <option value={30}>Expires 30 days</option>
            <option value={90}>Expires 90 days</option>
          </select>
          <button className="btn btn-primary" style={{ height: 32 }} disabled={creating} onClick={createLink}>
            {creating ? 'Creating…' : 'Create insurer link'}
          </button>
        </div>

        {links.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {links.map((l) => {
              const active = !l.revokedAt && new Date(l.expiresAt) > new Date();
              return (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '7px 0', borderTop: '1px solid var(--color-border)' }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600 }}>{l.label || 'Unnamed insurer'}</div>
                    <div style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>
                      {active ? `expires ${fmtDate(l.expiresAt)}` : (l.revokedAt ? 'revoked' : 'expired')} · {l.viewCount || 0} view{(l.viewCount || 0) === 1 ? '' : 's'}
                    </div>
                  </div>
                  {active && (
                    <>
                      <button className="btn btn-secondary" style={{ height: 28, fontSize: 12 }} onClick={() => copyLink(l.path, l.id)}>
                        {copied === l.id ? <Check size={13} /> : <Copy size={13} />} {copied === l.id ? 'Copied' : 'Copy link'}
                      </button>
                      <button className="btn btn-danger" style={{ height: 28, fontSize: 12 }} onClick={() => revoke(l.id)}>Revoke</button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
