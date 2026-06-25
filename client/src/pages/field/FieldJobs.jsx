// ─────────────────────────────────────────────────────────────────────────────
// FieldJobs.jsx — the field-labor (field_tech / subcontractor) home: "My Jobs".
//
// A sub sees ONLY their assigned work (GET /api/field/assignments). Big scan
// button up top (QR → the job card), then a tappable list of assigned work
// orders. No site picker, no add-equipment, no "full site" — a sub has none of
// that; the server default-denies it and this screen never offers it.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../../api/client';
import { assetLabel, EQUIPMENT_TYPE_LABELS, WO_STATUS_META } from '../../lib/equipment';

const STATUS_FILTERS = [
  { key: '',            label: 'All' },
  { key: 'IN_PROGRESS', label: 'In Progress' },
  { key: 'SCHEDULED',  label: 'Scheduled' },
  { key: 'COMPLETE',   label: 'Done' },
];

export default function FieldJobs() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState(null);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const fetchJobs = useCallback(() => {
    setError(null);
    api.get('/api/field/assignments')
      .then((r) => setJobs(r.data?.data?.assignments || []))
      .catch((err) => setError(err.response?.data?.error || err.message || 'Failed to load your jobs'));
  }, []);

  useEffect(() => { fetchJobs(); }, [fetchJobs]);

  const visibleJobs = useMemo(() => {
    if (!jobs) return [];
    const q = search.trim().toLowerCase();
    return jobs.filter(j => {
      if (statusFilter && j.status !== statusFilter) return false;
      if (q) {
        const haystack = [
          j.asset ? assetLabel(j.asset) : '',
          j.taskName,
          j.asset?.site?.name,
          EQUIPMENT_TYPE_LABELS[j.asset?.equipmentType],
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [jobs, search, statusFilter]);

  return (
    <div>
      {/* Scan — the primary field action */}
      <button
        type="button"
        onClick={() => navigate('/field/scan')}
        style={{
          boxSizing: 'border-box', width: '100%', minHeight: 64,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
          background: 'var(--color-primary)', color: '#fff', border: 'none',
          borderRadius: 12, cursor: 'pointer', fontSize: 18, fontWeight: 800,
          boxShadow: '0 2px 8px rgba(0,0,0,0.18)', marginBottom: 14,
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ width: 26, height: 26 }} aria-hidden="true">
          <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
          <rect x="3" y="14" width="7" height="7" rx="1" /><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h.01M20 17v.01M20 20v.01" />
        </svg>
        Scan equipment
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <h1 style={{ fontSize: 17, fontWeight: 800, color: 'var(--color-text)', margin: 0 }}>My jobs</h1>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={fetchJobs} aria-label="Refresh"
          style={{ minWidth: 44, minHeight: 40, border: '1px solid var(--color-border)', borderRadius: 8, background: 'var(--color-surface)', color: 'var(--color-primary)', cursor: 'pointer', fontSize: 18 }}>⟳</button>
      </div>

      {/* Quick filters — shown once jobs have loaded */}
      {jobs && jobs.length > 0 && (
        <>
          <input
            type="search"
            placeholder="Search jobs…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ boxSizing: 'border-box', width: '100%', padding: '10px 14px', borderRadius: 10,
              border: '1px solid var(--color-border-strong)', background: 'var(--color-surface)',
              fontSize: 15, marginBottom: 10, color: 'var(--color-text)', outline: 'none' }}
          />
          <div role="group" aria-label="Filter by status" style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {STATUS_FILTERS.map(f => {
              const active = statusFilter === f.key;
              const m = f.key ? WO_STATUS_META[f.key] : null;
              return (
                <button key={f.key} type="button" onClick={() => setStatusFilter(f.key)}
                  style={{ padding: '5px 12px', borderRadius: 999, fontSize: 13, fontWeight: active ? 700 : 500,
                    border: active ? 'none' : '1px solid var(--color-border-strong)',
                    background: active ? (m?.bg || 'var(--color-primary)') : 'var(--color-surface)',
                    color: active ? (m?.color || '#fff') : 'var(--color-text-secondary)',
                    cursor: 'pointer', WebkitTapHighlightColor: 'transp