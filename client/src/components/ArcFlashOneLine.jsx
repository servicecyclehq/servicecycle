// ArcFlashOneLine.jsx — Slice 6: auto-built power-path one-line for a site.
// Fetches GET /api/arc-flash/site/:siteId/one-line and lays the asset graph out
// in cascading levels (source at top), hazard-colored. Lazy (button) so it only
// loads when the user wants the diagram.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/client';

function sevFill(s) { return s === 'danger' ? 'var(--chip-red-fg)' : s === 'warning' ? 'var(--chip-amber-fg)' : 'var(--chip-slate-fg)'; }

const NODE_W = 150, NODE_H = 46, ROW_H = 96, PAD_X = 20, PAD_Y = 16;

export default function ArcFlashOneLine({ siteId }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');

  async function load() {
    setOpen(true);
    if (data) return;
    setLoading(true); setErr('');
    try {
      const r = await api.get(`/api/arc-flash/site/${siteId}/one-line`);
      setData(r.data?.data || null);
    } catch { setErr('Could not build the one-line.'); }
    finally { setLoading(false); }
  }

  const nodes = data?.nodes || [];
  // Group by level and compute positions.
  const byLevel = {};
  for (const n of nodes) (byLevel[n.level] = byLevel[n.level] || []).push(n);
  const levels = Object.keys(byLevel).map(Number).sort((a, b) => a - b);
  const maxPerRow = Math.max(1, ...levels.map(l => byLevel[l].length));
  const width = Math.max(360, maxPerRow * (NODE_W + 24) + PAD_X * 2);
  const height = (data?.maxLevel != null ? data.maxLevel + 1 : levels.length) * ROW_H + PAD_Y * 2;

  const pos = {};
  for (const l of levels) {
    const row = byLevel[l];
    row.forEach((n, i) => {
      pos[n.id] = { x: ((i + 1) / (row.length + 1)) * width, y: PAD_Y + l * ROW_H + NODE_H / 2 };
    });
  }

  return (
    <div style={{ marginTop: 14, borderTop: '1px dashed var(--color-border)', paddingTop: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <strong style={{ fontSize: '0.82rem' }}>Power-path one-line (auto-built)</strong>
        <button type="button" className="btn-link" style={{ fontSize: '0.76rem' }} onClick={() => (open ? setOpen(false) : load())}>{open ? 'Hide' : 'Show one-line'}</button>
      </div>

      {open && (
        <div style={{ marginTop: 8 }}>
          {loading && <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>Building…</div>}
          {err && <div style={{ color: 'var(--color-danger)', fontSize: '0.78rem' }}>{err}</div>}
          {!loading && !err && nodes.length === 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--color-text-secondary)' }}>No connected assets yet. The diagram fills in as assets are collected and feed links are wired (confirm an ingest, or set “fed from” on assets).</div>
          )}
          {nodes.length > 0 && (
            <div style={{ overflowX: 'auto', border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface)' }}>
              <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ maxWidth: '100%', display: 'block' }} role="img" aria-label="Power-path one-line diagram">
                {data.edges.map((e, i) => {
                  const a = pos[e.from], b = pos[e.to];
                  if (!a || !b) return null;
                  return <line key={i} x1={a.x} y1={a.y + NODE_H / 2} x2={b.x} y2={b.y - NODE_H / 2} stroke="var(--color-border)" strokeWidth="1.5" />;
                })}
                {nodes.map(n => {
                  const p = pos[n.id];
                  if (!p) return null;
                  return (
                    <g key={n.id} transform={`translate(${p.x - NODE_W / 2}, ${p.y - NODE_H / 2})`}>
                      <rect width={NODE_W} height={NODE_H} rx="6" fill={sevFill(n.labelSeverity)} />
                      <text x={NODE_W / 2} y={17} textAnchor="middle" fill="#fff" fontSize="11" fontWeight="700">{(n.name || '').slice(0, 20)}</text>
                      <text x={NODE_W / 2} y={32} textAnchor="middle" fill="#fff" fontSize="9" opacity="0.95">
                        {[n.nominalVoltage, n.incidentEnergyCalCm2 != null ? `${n.incidentEnergyCalCm2} cal` : null].filter(Boolean).join(' · ')}
                      </text>
                      <a href={`/assets/${n.id}`} target="_self"><rect width={NODE_W} height={NODE_H} rx="6" fill="transparent" style={{ cursor: 'pointer' }} /></a>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
          <div style={{ fontSize: '0.7rem', color: 'var(--color-text-secondary)', marginTop: 6 }}>
            Red = DANGER, orange = WARNING, slate = unclassified. Click a node to open the asset. ServiceCycle is the data layer; a PE confirms the study.
          </div>
        </div>
      )}
    </div>
  );
}
