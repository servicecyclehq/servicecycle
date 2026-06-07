import React, { useState, useEffect, useCallback } from 'react';
import api from '../../api/client';
import { sectionHeading, sectionDesc, btnPrimary, btnSecondary } from './sharedStyles';
import { parseEvalLeadTimes, evalDaysBack, DEFAULT_EVAL_LEAD_TIMES } from '../../lib/urgency';

// #28: configurable evaluation lead times (admin-only). Edits the
// EVALUATION_LEAD_TIMES AccountSetting that drives BOTH the server-side
// evaluationStartByDate calc (server/utils/dates.ts) and the client urgency
// color model (client/src/lib/urgency.js) -- they share one model so they
// stay in lockstep.

const inputStyle = {
  width: 120, padding: '0.4rem 0.55rem', borderRadius: 6,
  border: '1px solid var(--color-border)', background: 'var(--color-surface)',
  color: 'var(--color-text)', fontSize: '0.9rem',
};
const numFmt = new Intl.NumberFormat('en-US');

function cfgToRows(cfg) {
  return cfg.tiers.map((t) => ({
    minValue: String(t.minValue),
    daysBack: String(t.daysBack),
    fixed: t.minValue === 0,
  }));
}

export default function EvaluationLeadTimesSection() {
  const [rows, setRows]               = useState(() => cfgToRows(DEFAULT_EVAL_LEAD_TIMES));
  const [noValueDays, setNoValueDays] = useState(String(DEFAULT_EVAL_LEAD_TIMES.noValueDaysBack));
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [msg, setMsg]                 = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/api/settings');
      const cfg = parseEvalLeadTimes(res.data?.data?.EVALUATION_LEAD_TIMES);
      setRows(cfgToRows(cfg));
      setNoValueDays(String(cfg.noValueDaysBack));
    } catch {
      // non-admins can't read settings; keep defaults
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const updateRow = (i, key, val) => {
    setMsg(null);
    const clean = String(val).replace(/[^0-9]/g, '');
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, [key]: clean } : r)));
  };

  // Build a config object from the current edited rows. The server (and the
  // shared normalizer) re-sorts, de-dupes and guarantees a catch-all tier.
  const buildConfig = () => ({
    tiers: rows.map((r) => ({
      minValue: parseInt(r.minValue || '0', 10),
      daysBack: parseInt(r.daysBack || '0', 10),
    })),
    noValueDaysBack: parseInt(noValueDays || '0', 10),
  });

  // Preview uses the SAME helpers the server mirrors, so what you see is what
  // the server will compute.
  const previewCfg = parseEvalLeadTimes(JSON.stringify(buildConfig()));
  const samples = [150000, 50000, 5000, null];

  const save = async () => {
    for (const r of rows) {
      const db = parseInt(r.daysBack || '0', 10);
      if (!(db >= 1 && db <= 3650)) {
        setMsg({ ok: false, text: 'Lead times must be between 1 and 3650 days.' });
        return;
      }
    }
    const nv = parseInt(noValueDays || '0', 10);
    if (!(nv >= 1 && nv <= 3650)) {
      setMsg({ ok: false, text: 'The no-value default must be between 1 and 3650 days.' });
      return;
    }
    setSaving(true); setMsg(null);
    try {
      await api.put('/api/settings', { EVALUATION_LEAD_TIMES: JSON.stringify(buildConfig()) });
      const fresh = parseEvalLeadTimes(JSON.stringify(buildConfig()));
      setRows(cfgToRows(fresh));
      setNoValueDays(String(fresh.noValueDaysBack));
      setMsg({ ok: true, text: 'Evaluation lead times saved. New review-by dates apply going forward.' });
    } catch (err) {
      setMsg({ ok: false, text: err.response?.data?.error || 'Failed to save evaluation lead times.' });
    } finally {
      setSaving(false);
    }
  };

  const resetDefaults = () => {
    setRows(cfgToRows(DEFAULT_EVAL_LEAD_TIMES));
    setNoValueDays(String(DEFAULT_EVAL_LEAD_TIMES.noValueDaysBack));
    setMsg(null);
  };

  return (
    <section style={{ marginTop: '2.5rem', paddingTop: '2rem', borderTop: '1px solid var(--color-border)' }}>
      <h2 className={sectionHeading}>Evaluation Lead Times</h2>
      <p className={sectionDesc}>
        LapseIQ automatically sets each contract&apos;s <strong>review-by date</strong> (when its
        renewal should surface for evaluation) a number of days before the end date, scaled by
        contract value &mdash; higher-value contracts get a longer runway. These tiers also drive the
        green / amber / red urgency colors shown across LapseIQ. Adjust the value breakpoints and
        lead times below.
      </p>

      {loading ? (
        <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.875rem' }}>Loading...</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: '1.25rem' }}>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.9rem', color: 'var(--color-text)' }}>
                <span style={{ minWidth: 110 }}>{r.fixed ? 'Below that' : 'Contracts \u2265'}</span>
                {!r.fixed && (
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ color: 'var(--color-text-secondary)' }}>$</span>
                    <input type="text" inputMode="numeric" value={r.minValue} onChange={(e) => updateRow(i, 'minValue', e.target.value)} style={inputStyle} aria-label="Value breakpoint (dollars)" />
                  </span>
                )}
                <span style={{ color: 'var(--color-text-secondary)' }}>review</span>
                <input type="text" inputMode="numeric" value={r.daysBack} onChange={(e) => updateRow(i, 'daysBack', e.target.value)} style={{ ...inputStyle, width: 80 }} aria-label="Lead time (days before renewal)" />
                <span style={{ color: 'var(--color-text-secondary)' }}>days before renewal</span>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: '0.9rem', color: 'var(--color-text)' }}>
              <span style={{ minWidth: 110 }}>No cost data</span>
              <span style={{ color: 'var(--color-text-secondary)' }}>review</span>
              <input type="text" inputMode="numeric" value={noValueDays} onChange={(e) => { setMsg(null); setNoValueDays(e.target.value.replace(/[^0-9]/g, '')); }} style={{ ...inputStyle, width: 80 }} aria-label="No-value default lead time (days)" />
              <span style={{ color: 'var(--color-text-secondary)' }}>days before renewal</span>
            </div>
          </div>

          <div style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '0.75rem 1rem', marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.04em', color: 'var(--color-text-secondary)', marginBottom: 6 }}>PREVIEW</div>
            {samples.map((v, idx) => (
              <div key={idx} style={{ fontSize: '0.83rem', color: 'var(--color-text-secondary)', lineHeight: 1.8 }}>
                {v == null ? 'A contract with no cost data' : ('A $' + numFmt.format(v) + ' contract')}
                {' '}&rarr; review starts <strong style={{ color: 'var(--color-text)' }}>{evalDaysBack(v, previewCfg)}</strong> days before renewal
              </div>
            ))}
          </div>

          <p style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)', marginBottom: '1rem', lineHeight: 1.5 }}>
            Changes apply <strong>going forward</strong>: each contract&apos;s review-by date is recomputed
            the next time the contract is saved or renewed. Existing review-by dates are not
            recalculated in bulk.
          </p>

          {msg && (
            <div style={{ padding: '0.5rem 0.875rem', borderRadius: 6, marginBottom: '0.75rem', background: msg.ok ? 'var(--color-success-soft)' : 'var(--color-danger-bg)', color: msg.ok ? 'var(--color-success)' : 'var(--color-danger)', fontSize: '0.825rem' }}>
              {msg.text}
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={save} disabled={saving} className={btnPrimary}>
              {saving ? 'Saving...' : 'Save lead times'}
            </button>
            <button type="button" onClick={resetDefaults} disabled={saving} className={btnSecondary}>
              Reset to defaults
            </button>
          </div>
        </>
      )}
    </section>
  );
}