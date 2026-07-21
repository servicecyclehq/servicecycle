// ─────────────────────────────────────────────────────────────────────────────
// InstrumentBand.jsx -- Direction B "Control Room" dashboard header.
//
// Dark ink band (theme-invariant, matches the sidebar) that replaces the
// dashboard's light .page-header. Carries the org/date row moved out of the
// old operational header, a docked disaster-event line (replaces the global
// full-width DisasterBanner on /dashboard only -- see Layout.jsx), and four
// read-at-a-glance instruments: overall compliance %, NFPA 70B maturity,
// arc-flash hottest bus, and inspector-visible open items.
//
// Self-fetches all four instruments from the same endpoints their full-size
// card counterparts already use (PathTo100, MaturityScoreCard,
// ArcFlashDashboardCard, AuditReadyBanner, DisasterBanner) -- same
// self-contained-data convention as those components, no prop drilling of
// dashboard data required.
//
// Theme-invariance: wrapped in data-theme="dark" so every var(--token) below
// resolves to its dark-mode value regardless of the app's light/dark toggle
// (same "the chrome is the chrome" principle as the sidebar) -- tokens only,
// no new hexes.
//
// B1 (2026-07-13): docs/design/direction-board-2026-07-12.html #dir-b +
// the B+C execution plan (2026-07-12).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import api from '../api/client';
import { useDisasterEvents, severityLabel } from '../hooks/useDisasterEvents';

// Instrument (2026-07-13 fix): tiles were previously inert display-only
// <div>s with no way to drill into the underlying data -- Dustin flagged
// this in local review ("these cards don't link to anything so how do I
// know what data needs my review?"). Each tile now renders as a real link
// (keyboard-focusable, Enter activates) to the report page that carries the
// detail behind its headline number. `to` is required; ariaLabel/label still
// drive the accessible name so screen-reader behavior is unchanged.
function Instrument({ to, label, value, unit, detail, danger, ariaLabel }) {
  return (
    <Link
      to={to}
      aria-label={ariaLabel ? `${ariaLabel}. View details.` : undefined}
      style={{
        display: 'block',
        background: 'var(--color-sidebar-hover)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-lg)',
        padding: '14px 16px',
        minWidth: 0,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color .15s, background .15s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--color-border-strong)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--color-border)'; }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
        <div style={{
          font: '500 10px var(--font-mono)', letterSpacing: '.12em',
          textTransform: 'uppercase', color: 'var(--color-text-muted)',
        }}>
          {label}
        </div>
        <ChevronRight size={13} aria-hidden="true" style={{ color: 'var(--color-text-muted)', flexShrink: 0 }} />
      </div>
      <div style={{
        font: '600 30px var(--font-mono)', letterSpacing: '-.03em',
        color: danger ? 'var(--color-danger)' : 'var(--color-text)',
        marginTop: 6, lineHeight: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {value}{unit && <small style={{ fontSize: 14, color: 'var(--color-text-muted)' }}> {unit}</small>}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--color-text-muted)', marginTop: 7 }}>
        {detail}
      </div>
    </Link>
  );
}

export default function InstrumentBand({ companyName, siteCount, canWrite, onNewAsset }) {
  const navigate = useNavigate();
  const [path, setPath] = useState(null);
  const [maturity, setMaturity] = useState(null);
  const [arcFlash, setArcFlash] = useState(null);
  // Dashboard cleanup pass (2026-07-13): fetch + severity-label mapping now
  // live in useDisasterEvents (shared with DisasterBanner.jsx); dismiss
  // state stays local -- this docked line and the global banner dismiss
  // independently.
  const { topEvent } = useDisasterEvents();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let on = true;
    api.get('/api/compliance/path-to-100').then(r => { if (on) setPath(r.data.data); }).catch(() => {});
    api.get('/api/compliance/maturity').then(r => { if (on) setMaturity(r.data.data); }).catch(() => {});
    api.get('/api/arc-flash/dashboard').then(r => { if (on) setArcFlash(r.data?.data || null); }).catch(() => {});
    return () => { on = false; };
  }, []);

  const complianceReady = path && path.summary.fullyCompliant;
  const inspectorCount = path ? path.summary.totalActions : null;
  const hottest = arcFlash?.topDanger?.[0];

  return (
    <div data-theme="dark" style={{ background: 'var(--color-sidebar-bg)' }}>
      <div style={{
        padding: '16px max(32px, calc((100% - var(--content-max, 1160px)) / 2)) 22px',
      }}>
        {/* org / date row -- moved here from the old .page-header (v0.95) */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, paddingBottom: 14 }}>
          <div>
            <div style={{ font: '500 11px var(--font-mono)', letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--color-text-muted)', marginBottom: 3 }}>
              {companyName || 'Your organization'}{siteCount > 0 ? ` · ${siteCount} site${siteCount !== 1 ? 's' : ''}` : ''}
            </div>
            <h1 style={{ fontSize: 16, fontWeight: 700, letterSpacing: '-.01em', color: 'var(--color-text)', margin: 0 }}>
              Compliance overview
            </h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, font: '500 11.5px var(--font-mono)', color: 'var(--color-emerald)' }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-emerald)', boxShadow: '0 0 8px var(--color-emerald)', display: 'block' }} />
              Data current {'·'} {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
            </span>
            {canWrite && (
              <button className="btn btn-primary btn-sm" onClick={onNewAsset}>+ New asset</button>
            )}
          </div>
        </div>

        {/* docked disaster line -- replaces the global full-width banner on
            this page only (see Layout.jsx); same source + self-hide logic
            as DisasterBanner.jsx, styled to sit inside the band. */}
        {topEvent && !dismissed && (
          <div role="alert" style={{
            display: 'flex', alignItems: 'center', gap: 10,
            background: 'var(--color-warning-soft)',
            border: '1px solid var(--color-warning-bg)',
            color: 'var(--color-warning-strong)', fontSize: 12.5,
            borderRadius: 'var(--radius)', padding: '7px 12px', marginBottom: 14,
          }}>
            <AlertTriangle size={14} strokeWidth={2} aria-hidden="true" />
            <strong style={{ whiteSpace: 'nowrap' }}>{severityLabel(topEvent.severity)}:</strong>
            <span style={{ flex: 1 }}>{topEvent.title}</span>
            <button
              type="button"
              onClick={() => navigate('/disaster-response')}
              style={{
                marginLeft: 'auto', border: '1px solid var(--color-warning-strong)',
                color: 'var(--color-warning-strong)',
                borderRadius: 5, fontSize: 11.5, fontWeight: 600, padding: '4px 10px',
                background: 'transparent', whiteSpace: 'nowrap', cursor: 'pointer',
              }}
            >
              View &amp; declare emergency
            </button>
            <button
              type="button"
              aria-label="Dismiss weather banner"
              onClick={() => setDismissed(true)}
              style={{ background: 'none', border: 'none', color: 'var(--color-warning-strong)', cursor: 'pointer', padding: 2, lineHeight: 1 }}
            >
              {'×'}
            </button>
          </div>
        )}

        {/* four instruments -- 2x2 under 900px, see .instrument-band-grid in index.css */}
        <div className="instrument-band-grid">
          <Instrument
            to="/reports/compliance"
            label="Compliance"
            value={path ? `${path.overallRate}%` : '—'}
            detail={path ? `${path.coverage.coveredAssets}/${path.coverage.totalAssets} tracked` : 'Loading…'}
            ariaLabel={path
              ? `Overall compliance ${path.overallRate} percent, ${path.coverage.coveredAssets} of ${path.coverage.totalAssets} assets tracked`
              : 'Overall compliance, loading'}
          />
          <Instrument
            to="/reports/compliance"
            label="NFPA 70B maturity"
            value={maturity ? Math.round(maturity.score) : '—'}
            unit={maturity ? '/100' : undefined}
            detail={maturity ? `Level ${maturity.level} · ${maturity.levelLabel}` : 'Loading…'}
            ariaLabel={maturity
              ? `NFPA 70B maturity score ${Math.round(maturity.score)} of 100, level ${maturity.level}, ${maturity.levelLabel}`
              : 'NFPA 70B maturity, loading'}
          />
          <Instrument
            to="/reports/arc-flash-fleet"
            label="Arc flash"
            value={hottest ? (hottest.incidentEnergyCalCm2 ?? 'DANGER') : '—'}
            unit={hottest?.incidentEnergyCalCm2 != null ? 'cal/cm²' : undefined}
            detail={hottest ? `hottest: ${hottest.busName}` : (arcFlash ? 'No arc-flash data yet' : 'Loading…')}
            danger={!!hottest}
            ariaLabel={hottest
              ? `Arc flash hottest bus ${hottest.busName}, ${hottest.incidentEnergyCalCm2 != null ? hottest.incidentEnergyCalCm2 + ' calories per square centimeter' : 'danger, incident energy not yet calculated'}`
              : 'Arc flash, no data yet'}
          />
          <Instrument
            to="/reports/compliance"
            label="Inspector-visible"
            value={inspectorCount != null ? inspectorCount : '—'}
            detail={path ? (complianceReady ? 'Audit-ready' : `item${inspectorCount !== 1 ? 's' : ''} open`) : 'Loading…'}
            danger={!!inspectorCount}
            ariaLabel={path
              ? (complianceReady
                ? 'Inspector-visible: audit-ready, zero open items'
                : `Inspector-visible: ${inspectorCount} items would look incomplete to an inspector`)
              : 'Inspector-visible items, loading'}
          />
        </div>
      </div>
    </div>
  );
}
