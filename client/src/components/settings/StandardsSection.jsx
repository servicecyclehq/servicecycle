/**
 * StandardsSection â€” per-account "which standards do we track" selector.
 *
 * The seed ships a library of compliance standards; this lets an account scope
 * its maintenance program to the standards its facilities actually answer to.
 * "Track all" (the default) applies every standard's tasks on bulk-apply;
 * narrowing applies only the chosen standards. Reads/writes /api/standards/tracked.
 */
import { useState, useEffect, useMemo } from 'react';
import api from '../../api/client';

export default function StandardsSection({ isAdmin }) {
  const [standards, setStandards] = useState([]); // [{code, title}]
  const [allMode, setAllMode]     = useState(true);
  const [selected, setSelected]   = useState(() => new Set());
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [saved, setSaved]         = useState(false);
  const [error, setError]         = useState('');

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.get('/api/standards'), api.get('/api/standards/tracked')])
      .then(([sRes, tRes]) => {
        if (cancelled) return;
        // Dedupe the library by code (multiple editions share a code).
        const byCode = new Map();
        for (const s of (sRes.data?.data?.standards || [])) {
          if (!byCode.has(s.code)) byCode.set(s.code, { code: s.code, title: s.title });
        }
        const list = [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
        setStandards(list);
        const tracked = tRes.data?.data?.trackedCodes;
        if (tracked == null) { setAllMode(true); setSelected(new Set(list.map(s => s.code))); }
        else { setAllMode(false); setSelected(new Set(tracked)); }
      })
      .catch(() => setError('Failed to load standards.'))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const allCodes = useMemo(() => standards.map(s => s.code), [standards]);

  function toggleAll() {
    if (!isAdmin) return;
    if (allMode) { setAllMode(false); /* keep current selection as the explicit set */ }
    else { setAllMode(true); setSelected(new Set(allCodes)); }
    setSaved(false);
  }
  function toggleCode(code) {
    if (!isAdmin || allMode) return;
    setSelected(prev => { const n = new Set(prev); n.has(code) ? n.delete(code) : n.add(code); return n; });
    setSaved(false);
  }

  async function handleSave() {
    if (!isAdmin) return;
    setSaving(true); setError(''); setSaved(false);
    try {
      const body = allMode ? { allTracked: true } : { codes: [...selected] };
      await api.put('/api/standards/tracked', body);
      setSaved(true);
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to save.');
    } finally { setSaving(false); }
  }

  if (loading) return <div className="card" style={{ padding: 20 }}>Loading standardsâ€¦</div>;

  return (
    <section className="card" style={{ padding: 20, marginBottom: 20 }}>
      <h2 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: 4 }}>Standards &amp; programs</h2>
      <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem', marginBottom: 16 }}>
        Choose which compliance standards this account tracks. New assets get the maintenance
        program for the standards you track (NFPA 70B is the core industry-standard program; the
        rest apply where your facilities have that equipment). Manufacturer instructions always
        take precedence over these defaults.
      </p>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontWeight: 600 }}>
        <input type="checkbox" checked={allMode} disabled={!isAdmin} onChange={toggleAll} />
        Track all standards
      </label>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8, opacity: allMode ? 0.55 : 1 }}>
        {standards.map(s => (
          <label key={s.code} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem' }}>
            <input
              type="checkbox"
              checked={allMode || selected.has(s.code)}
              disabled={!isAdmin || allMode}
              onChange={() => toggleCode(s.code)}
              style={{ marginTop: 2 }}
            />
            <span><strong>{s.code}</strong><br /><span style={{ color: 'var(--color-text-secondary)' }}>{s.title}</span></span>
          </label>
        ))}
      </div>

      {error && <div className="alert alert-danger" style={{ marginTop: 12 }}>{error}</div>}
      {isAdmin && (
        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button type="button" className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Savingâ€¦' : 'Save standards'}
          </button>
          {saved && <span style={{ color: 'var(--color-success, #15803d)', fontWeight: 600 }}>âœ“ Saved</span>}
        </div>
      )}
      {!isAdmin && <p style={{ marginTop: 12, fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>Only admins can change tracked standards.</p>}
    </section>
  );
}