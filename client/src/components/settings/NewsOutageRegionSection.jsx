import React, { useState, useEffect } from 'react';
import api from '../../api/client';

export default function NewsOutageRegionSection() {
  const [value, setValue]   = useState('global');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  useEffect(() => {
    api.get('/api/news/summary')
      .then(r => {
        const d = r.data && r.data.data;
        setValue((d && d.newsOutageRegion) || 'global');
      })
      .catch(() => setValue('global'))
      .finally(() => setLoaded(true));
  }, []);

  async function onChange(next) {
    if (next === value) return;
    const prev = value;
    setValue(next);
    setSaving(true);
    setError(null);
    try {
      const r = await api.put('/api/news/region', { region: next });
      const stored = (r.data && r.data.data && r.data.data.newsOutageRegion) || next;
      setValue(stored);
    } catch (e) {
      setValue(prev);
      setError(e?.response?.data?.error || 'Failed to save region preference');
    } finally {
      setSaving(false);
    }
  }

  const parsed = String(value || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const isGlobal = parsed.length === 0 || parsed.includes('global');
  const has = key => isGlobal ? false : parsed.includes(key);

  function toggle(key) {
    if (key === 'global') { onChange('global'); return; }
    const next = new Set(parsed.filter(t => t !== 'global'));
    if (next.has(key)) next.delete(key);
    else next.add(key);
    if (next.size === 0) { onChange('global'); return; }
    onChange([...next].sort().join(','));
  }

  const opts = [
    { key: 'global', label: 'Global (show all regions)',         hint: 'No filter applied' },
    { key: 'us',     label: 'Americas (US, Canada, LATAM)',      hint: null },
    { key: 'eu',     label: 'EMEA (Europe + Middle East)',        hint: null },
    { key: 'apac',   label: 'APAC (Asia, Pacific)',              hint: null },
  ];

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--color-border)' }}>
        <div style={{ fontSize: 'var(--font-size-base)', fontWeight: 600, marginBottom: 4 }}>
          News Outage Region Filter
        </div>
        <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>
          Choose the geographies your organization cares about. Outages flagged for other regions will be hidden from the Outages tab on /news. Outages without a detected region remain visible to everyone.
        </div>
      </div>
      <div style={{ padding: '16px 20px' }}>
        {!loaded ? (
          <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)' }}>Loading...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {opts.map(opt => {
              const checked = opt.key === 'global' ? isGlobal : has(opt.key);
              const dimmed  = isGlobal && opt.key !== 'global';
              return (
                <label
                  key={opt.key}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    fontSize: 'var(--font-size-data)',
                    color: dimmed ? 'var(--color-text-secondary)' : 'var(--color-text)',
                    opacity: dimmed ? 0.7 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(opt.key)}
                    disabled={saving}
                    aria-label={opt.label}
                  />
                  <span style={{ fontWeight: checked ? 600 : 400 }}>{opt.label}</span>
                  {opt.hint && checked && (
                    <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', fontStyle: 'italic' }}>
                      ({opt.hint})
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}
        {saving && (
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 10 }}>Saving...</div>
        )}
        {error && (
          <div role="alert" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger)', marginTop: 10 }}>{error}</div>
        )}
      </div>
    </div>
  );
}
