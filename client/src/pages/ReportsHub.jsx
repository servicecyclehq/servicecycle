// ─────────────────────────────────────────────────────────────────────────────
// ReportsHub.jsx — v0.58.0 IA redesign
//
// Three tiers:
//   1) KPI strip — 4 tiles bound to the /api/reports/hub-kpis bundle.
//   2) Grouped report library — sections by persona.
//   3) Search + favorites — search filters by name/description; favorites
//      surface above the grouped sections via useUserPreference.
//
// The registry (client/src/tables/reportsRegistry.js) is the single source of
// truth for what shows where. Adding a new report = one entry, no edits here.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Search, Star, ChevronRight, TrendingUp, TrendingDown, Minus, MessageSquarePlus, X, Send } from 'lucide-react';
import { useUserPreference } from '../hooks/useUserPreference';
import api from '../api/client';
import { kbdActivate } from '../lib/a11y';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useAuth } from '../context/AuthContext';
import {
  REPORTS, PERSONAS, KPI_TILES, reportsByPersona,
} from '../tables/reportsRegistry';

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1_000_000) return '$' + (v / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(v) >= 1_000)     return '$' + (v / 1_000).toFixed(1) + 'k';
  return '$' + v.toFixed(0);
}
function fmtPercent(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return v.toFixed(1) + '%';
}
function fmtKpi(value, format) {
  return format === 'currency' ? fmtCurrency(value) : fmtPercent(value);
}

function KpiTile({ tile, kpi, onClick }) {
  const Icon = tile.icon;
  const hasData = kpi && kpi.value != null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="card"
      style={{
        padding: 0,
        border: 0,
        background: 'var(--color-card-bg)',
        cursor: 'pointer',
        textAlign: 'left',
        overflow: 'hidden',
        transition: 'box-shadow 0.15s, transform 0.1s',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.transform = '';
      }}
    >
      <div style={{ height: 3, background: tile.color }} />
      <div style={{ padding: '14px 16px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 6,
            background: `${tile.color}14`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon size={15} color={tile.color} strokeWidth={1.85} />
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {tile.label}
          </div>
        </div>
        <div style={{ fontSize: 26, fontWeight: 700, color: 'var(--color-text)', lineHeight: 1.1 }}>
          {hasData ? fmtKpi(kpi.value, tile.format) : '—'}
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', marginTop: 4, minHeight: 14 }}>
          {hasData && kpi.sublabel ? kpi.sublabel
            : kpi && kpi.hasData === false ? 'Connect cloud accounts'
            : 'No data'}
        </div>
      </div>
    </button>
  );
}

function ReportCard({ report, isFavorite, onToggleFavorite }) {
  const Icon = report.icon;
  const navigate = useNavigate();
  const stub = !!report.stub;

  return (
    <div
      className="card"
      style={{
        padding: 0,
        overflow: 'hidden',
        cursor: stub ? 'default' : 'pointer',
        display: 'flex',
        flexDirection: 'column',
        opacity: stub ? 0.72 : 1,
        transition: 'box-shadow 0.15s, transform 0.1s',
      }}
      onClick={() => !stub && navigate(report.route)}
      onMouseEnter={e => {
        if (stub) return;
        e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,0.10)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      }}
      onMouseLeave={e => {
        e.currentTarget.style.boxShadow = '';
        e.currentTarget.style.transform = '';
      }}
    >
      <div style={{ padding: '14px 16px 16px', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
          <div style={{
            width: 32, height: 32, borderRadius: 7,
            background: 'var(--color-bg-subtle, #f1f5f9)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Icon size={16} color="var(--color-text-secondary)" strokeWidth={1.75} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              {stub ? (
                <span style={{ fontWeight: 600, fontSize: 'var(--font-size-data)', color: 'var(--color-text)', lineHeight: 1.3 }}>
                  {report.name}
                </span>
              ) : (
                <Link
                  to={report.route}
                  onClick={e => e.stopPropagation()}
                  style={{ background: 'none', border: 0, padding: 0, margin: 0, cursor: 'pointer', fontWeight: 600, fontSize: 'var(--font-size-data)', fontFamily: 'inherit', color: 'var(--color-text)', lineHeight: 1.3, textAlign: 'left', textDecoration: 'none' }}
                >
                  {report.name}
                </Link>
              )}
              {report.newInVersion && (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '2px 6px', borderRadius: 4,
                  background: '#fef3c7', color: '#92400e', textTransform: 'uppercase',
                }}>
                  New
                </span>
              )}
              {/* v0.62.0: AI badge on cards with hasAiNarrative === true.
                  Surfaces which reports have the AI-narrated summary banner. */}
              {report.hasAiNarrative && (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '2px 6px', borderRadius: 4,
                  background: '#0d4f6e', color: '#fff', textTransform: 'uppercase',
                  display: 'inline-flex', alignItems: 'center', gap: 3,
                }} title="This report has an AI-generated executive summary you can click to generate">
                  AI
                </span>
              )}
              {stub && (
                <span style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.06em',
                  padding: '2px 6px', borderRadius: 4,
                  background: 'var(--color-bg-subtle, #f1f5f9)',
                  color: 'var(--color-text-secondary)', textTransform: 'uppercase',
                }}>
                  Coming soon
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            aria-label={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={e => { e.stopPropagation(); onToggleFavorite(report.id); }}
            style={{
              background: 'transparent', border: 0, cursor: 'pointer',
              padding: 4, color: isFavorite ? '#f59e0b' : 'var(--color-text-secondary)',
              flexShrink: 0,
            }}
          >
            <Star size={16} fill={isFavorite ? '#f59e0b' : 'transparent'} strokeWidth={1.75} />
          </button>
        </div>

        <p style={{
          fontSize: 12.5, color: 'var(--color-text-secondary)',
          lineHeight: 1.55, margin: '0 0 12px', flex: 1,
        }}>
          {report.description}
        </p>

        {!stub && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
            fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-primary)',
          }}>
            Open <ChevronRight size={14} style={{ marginLeft: 2 }} />
          </div>
        )}
      </div>
    </div>
  );
}

function PersonaSection({ persona, reports, favorites, toggleFavorite, search }) {
  if (reports.length === 0) return null;
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
        paddingBottom: 6, borderBottom: '1px solid var(--color-border)',
      }}>
        <div style={{ width: 4, height: 18, background: persona.color, borderRadius: 2 }} />
        <h2 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text)', letterSpacing: '0.01em' }}>
          {persona.label}
        </h2>
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginLeft: 4 }}>
          {reports.length} report{reports.length === 1 ? '' : 's'}
        </span>
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 14,
      }}>
        {reports.map(r => (
          <ReportCard
            key={r.id}
            report={r}
            isFavorite={favorites.includes(r.id)}
            onToggleFavorite={toggleFavorite}
          />
        ))}
      </div>
    </div>
  );
}

function RequestReportModal({ onClose }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitted, setSubmitted] = useState(false);

  function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) return;
    const subject = encodeURIComponent(`Report Request: ${title.trim()}`);
    const body = encodeURIComponent(
      `Report name / idea:\n${title.trim()}\n\n` +
      `What problem does this report solve?\n${description.trim() || '(not specified)'}\n\n` +
      `Submitted from LapseIQ Reports hub.`
    );
    window.open(`mailto:reports@lapseiq.com?subject=${subject}&body=${body}`, '_blank');
    setSubmitted(true);
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="request-report-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.45)',
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="card"
        style={{
          width: '100%', maxWidth: 480, margin: 16,
          padding: 24, position: 'relative',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 12, right: 12,
            background: 'transparent', border: 0, cursor: 'pointer',
            color: 'var(--color-text-secondary)', padding: 4, borderRadius: 4,
          }}
        >
          <X size={18} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8,
            background: '#0d4f6e14',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <MessageSquarePlus size={17} color="#0d4f6e" strokeWidth={1.85} />
          </div>
          <div>
            <h2 id="request-report-title" style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text)' }}>
              Request a Report
            </h2>
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginTop: 1 }}>
              We review every request and build the most-requested ones.
            </div>
          </div>
        </div>

        {submitted ? (
          <div style={{ textAlign: 'center', padding: '20px 0 8px' }}>
            <div style={{ fontSize: 'var(--font-size-hero)', marginBottom: 12 }}>✅</div>
            <div style={{ fontWeight: 600, color: 'var(--color-text)', marginBottom: 6 }}>Request sent!</div>
            <div style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary)', marginBottom: 20 }}>
              Your email client opened with the request pre-filled. Send it to submit to the LapseIQ team.
            </div>
            <button
              type="button"
              onClick={onClose}
              className="btn-primary"
              style={{ padding: '8px 20px', fontSize: 'var(--font-size-ui)' }}
            >
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 5 }}>
                Report name or idea <span style={{ color: '#dc2626' }}>*</span>
              </label>
              <input
                type="text"
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="e.g. License expiry by cost center, Vendor SLA compliance tracker…"
                required
                autoFocus
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 'var(--font-size-ui)',
                  borderRadius: 6, border: '1px solid var(--color-border)',
                  background: 'var(--color-input-bg, var(--color-card-bg))',
                  color: 'var(--color-text)', boxSizing: 'border-box',
                }}
              />
            </div>

            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontSize: 12.5, fontWeight: 600, color: 'var(--color-text)', marginBottom: 5 }}>
                What decision does this report help you make? <span style={{ color: 'var(--color-text-secondary)', fontWeight: 400 }}>(optional)</span>
              </label>
              <textarea
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="e.g. Every quarter I need to show Finance which departments are overspending on SaaS vs. their approved budget. There's no clean way to pull this today."
                rows={4}
                style={{
                  width: '100%', padding: '8px 10px', fontSize: 'var(--font-size-ui)',
                  borderRadius: 6, border: '1px solid var(--color-border)',
                  background: 'var(--color-input-bg, var(--color-card-bg))',
                  color: 'var(--color-text)', resize: 'vertical', boxSizing: 'border-box',
                  lineHeight: 1.5,
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                type="button"
                onClick={onClose}
                style={{
                  padding: '8px 16px', fontSize: 'var(--font-size-ui)', fontWeight: 500,
                  border: '1px solid var(--color-border)', borderRadius: 6,
                  background: 'transparent', cursor: 'pointer',
                  color: 'var(--color-text)',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim()}
                className="btn-primary"
                style={{
                  padding: '8px 18px', fontSize: 'var(--font-size-ui)',
                  display: 'flex', alignItems: 'center', gap: 6,
                  opacity: title.trim() ? 1 : 0.5,
                  cursor: title.trim() ? 'pointer' : 'not-allowed',
                }}
              >
                <Send size={13} />
                Submit request
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default function ReportsHub() {
  useDocumentTitle('Reports');
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [favorites, setFavorites] = useUserPreference('reports.favorites', []);
  const { demoMode } = useAuth();
  const [kpis, setKpis] = useState(null);
  const [kpisLoading, setKpisLoading] = useState(true);
  const [showRequest, setShowRequest] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setKpisLoading(true);
    api.get('/api/reports/hub-kpis')
      .then(r => { if (!cancelled) setKpis(r?.data?.data || null); })
      .catch(() => { /* tile renders "—" */ })
      .finally(() => { if (!cancelled) setKpisLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function toggleFavorite(reportId) {
    setFavorites(prev => {
      const list = Array.isArray(prev) ? prev : [];
      return list.includes(reportId)
        ? list.filter(id => id !== reportId)
        : [...list, reportId];
    });
  }

  const search_norm = search.trim().toLowerCase();
  const matchesSearch = (r) => {
    if (!search_norm) return true;
    return r.name.toLowerCase().includes(search_norm)
        || r.description.toLowerCase().includes(search_norm);
  };

  // #19 part 2: reports with a `conditional` flag only appear when the matching
  // hub-kpis probe says so (the M365 Overlap card hides until overlap exists).
  const m365HasOverlap = kpis?.m365Overlap?.hasOverlap === true;
  const isConditionalVisible = (r) => {
    if (!r.conditional) return true;
    if (r.conditional === 'm365Overlap') return m365HasOverlap;
    return true;
  };
  const filtered = useMemo(
    () => REPORTS.filter(r => matchesSearch(r) && isConditionalVisible(r)),
    [search_norm, m365HasOverlap]
  );
  const favoriteList = useMemo(
    () => filtered.filter(r => Array.isArray(favorites) && favorites.includes(r.id)),
    [filtered, favorites]
  );

  // Per-persona view excludes favorites (they show in their own section above)
  // so the user doesn't see the same card twice. Searching restores the full
  // grouping (favorites still appear in their own section if matched).
  const grouped = useMemo(() => {
    const out = reportsByPersona();
    for (const key of Object.keys(out)) {
      out[key] = out[key].filter(r => filtered.includes(r));
    }
    return out;
  }, [filtered]);

  return (
    <>
      {showRequest && <RequestReportModal onClose={() => setShowRequest(false)} />}

      <div className="page-header">
        <div>
          <h1 className="page-title">Reports</h1>
          <div className="page-subtitle">
            Run a canned report, or star the ones you use most for quick access.
          </div>
        </div>
        <div className="page-header-actions">
          <button
            type="button"
            onClick={() => setShowRequest(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '7px 14px', fontSize: 'var(--font-size-ui)', fontWeight: 500,
              border: '1px solid var(--color-border)', borderRadius: 6,
              background: 'var(--color-card-bg)', cursor: 'pointer',
              color: 'var(--color-text)',
              transition: 'background 0.15s, box-shadow 0.15s',
            }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.08)'}
            onMouseLeave={e => e.currentTarget.style.boxShadow = ''}
            aria-label="Request a report"
          >
            <MessageSquarePlus size={15} strokeWidth={1.85} />
            Request a report
          </button>
        </div>
      </div>

      <div className="page-body">
        {/* KPI strip */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 12,
          marginBottom: 28,
        }}>
          {KPI_TILES.filter(t => !(demoMode && t.id === 'cloudCommitBurn')).map(tile => (
            <KpiTile
              key={tile.id}
              tile={tile}
              kpi={kpisLoading ? { value: null, sublabel: 'Loading…' } : (kpis?.[tile.id] || null)}
              onClick={() => navigate(tile.linkTo)}
            />
          ))}
        </div>

        {/* Search */}
        <div style={{ marginBottom: 20, position: 'relative', maxWidth: 480 }}>
          <Search
            size={15}
            style={{
              position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)',
              color: 'var(--color-text-secondary)',
            }}
          />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search reports by name or description"
            aria-label="Search reports"
            style={{
              width: '100%',
              padding: '8px 12px 8px 34px',
              fontSize: 'var(--font-size-ui)',
              borderRadius: 6,
              border: '1px solid var(--color-border)',
              background: 'var(--color-input-bg, var(--color-card-bg))',
              color: 'var(--color-text)',
            }}
          />
        </div>

        {/* Favorites */}
        {favoriteList.length > 0 && (
          <div style={{ marginBottom: 28 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12,
              paddingBottom: 6, borderBottom: '1px solid var(--color-border)',
            }}>
              <Star size={16} color="#f59e0b" fill="#f59e0b" strokeWidth={1.75} />
              <h2 style={{ margin: 0, fontSize: 'var(--font-size-base)', fontWeight: 700, color: 'var(--color-text)' }}>
                Your favorites
              </h2>
              <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginLeft: 4 }}>
                {favoriteList.length}
              </span>
            </div>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
              gap: 14,
            }}>
              {favoriteList.map(r => (
                <ReportCard
                  key={r.id}
                  report={r}
                  isFavorite={true}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </div>
          </div>
        )}

        {/* Grouped report library */}
        {PERSONAS.map(p => (
          <PersonaSection
            key={p.id}
            persona={p}
            reports={grouped[p.id] || []}
            favorites={favorites || []}
            toggleFavorite={toggleFavorite}
            search={search_norm}
          />
        ))}

        {filtered.length === 0 && (
          <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--color-text-secondary)' }}>
            No reports match “{search}”.
          </div>
        )}
      </div>
    </>
  );
}
