// ─────────────────────────────────────────────────────────────────────────────
// DisasterResponsePage.jsx — Disaster Response Mode hub.
//
// Shows:
//   1. Active weather events affecting this account's sites (system-detected
//      via NWS + FEMA + any manual declarations by this account).
//   2. "Declare Emergency" panel — lets the customer formally declare that
//      they are in an emergency and need to jump the service queue. Notifies
//      their assigned service rep immediately.
//   3. Queue position — once declared, shows the account's position in the
//      emergency service queue for their region.
//   4. Service rep contact — prominent "CALL NOW" section with the rep's
//      phone number (from Account.serviceRepPhone).
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, Phone, CheckCircle, Clock, Loader } from 'lucide-react';
import api from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import Toast from '../components/Toast';

// ── Severity badge ────────────────────────────────────────────────────────────
const SEV_META = {
  emergency: { bg: '#fef2f2', color: '#dc2626', border: '#ef4444', label: 'EMERGENCY' },
  warning:   { bg: '#fffbeb', color: '#d97706', border: '#f59e0b', label: 'WARNING'   },
  watch:     { bg: '#fff7ed', color: '#ea580c', border: '#f97316', label: 'WATCH'     },
};

function SeverityBadge({ severity }) {
  const m = SEV_META[severity] || SEV_META.watch;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 10px', borderRadius: 20,
      fontSize: 'var(--font-size-xs)', fontWeight: 700,
      background: m.bg, color: m.color, border: `1px solid ${m.border}`,
      whiteSpace: 'nowrap',
    }}>
      {m.label}
    </span>
  );
}

// ── Event type label ──────────────────────────────────────────────────────────
const EVENT_LABELS = {
  hurricane:            'Hurricane',
  tornado:              'Tornado',
  ice_storm:            'Ice Storm',
  blizzard:             'Blizzard',
  flash_flood:          'Flash Flood',
  severe_thunderstorm:  'Severe Thunderstorm',
  wildfire:             'Wildfire',
  extreme_heat:         'Extreme Heat',
  grid_failure:         'Grid Failure',
  earthquake:           'Earthquake',
  manual:               'Emergency Declaration',
};

// ── Declare Emergency modal ───────────────────────────────────────────────────
function DeclareModal({ sites, onClose, onDeclared }) {
  const [title, setTitle]             = useState('');
  const [eventType, setEventType]     = useState('manual');
  const [selectedSites, setSelected]  = useState([]);
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');

  function toggleSite(id) {
    setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) { setError('Please describe the emergency.'); return; }
    setSubmitting(true);
    setError('');
    try {
      const r = await api.post('/api/disaster-events/declare', {
        title,
        eventType,
        affectedSiteIds: selectedSites,
      });
      onDeclared(r.data.data.event);
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to submit declaration.');
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Declare Emergency"
      style={{
        position: 'fixed', inset: 0, zIndex: 500,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={{
        background: 'var(--color-card)',
        borderRadius: 12, padding: 28, width: '100%', maxWidth: 500,
        boxShadow: '0 20px 40px rgba(0,0,0,0.3)',
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: 'var(--font-size-lg)', color: '#dc2626', fontWeight: 700 }}>
          🚨 Declare Emergency
        </h2>
        <p style={{ margin: '0 0 20px', color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          This flags your account for priority service and immediately notifies your assigned service rep.
        </p>

        {error && <div className="alert alert-error mb-16">{error}</div>}

        <form onSubmit={handleSubmit}>
          {/* Description */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
              Describe the emergency *
            </label>
            <input
              type="text"
              className="form-input"
              placeholder="e.g. Main transformer is down after flood damage"
              value={title}
              onChange={e => setTitle(e.target.value)}
              required
              autoFocus
              style={{ width: '100%' }}
            />
          </div>

          {/* Event type */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
              Event type
            </label>
            <select
              className="filter-select"
              value={eventType}
              onChange={e => setEventType(e.target.value)}
              style={{ width: '100%' }}
            >
              {Object.entries(EVENT_LABELS).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>

          {/* Site selection */}
          {sites.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <label style={{ display: 'block', fontWeight: 600, marginBottom: 6, fontSize: 'var(--font-size-sm)' }}>
                Affected sites (optional — leave blank to include all)
              </label>
              <div style={{
                border: '1px solid var(--color-border)', borderRadius: 8,
                maxHeight: 140, overflowY: 'auto', padding: '4px 0',
              }}>
                {sites.map(s => (
                  <label key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '6px 12px', cursor: 'pointer',
                    fontSize: 'var(--font-size-sm)',
                  }}>
                    <input
                      type="checkbox"
                      checked={selectedSites.includes(s.id)}
                      onChange={() => toggleSite(s.id)}
                    />
                    {s.name}
                    {s.city && s.state && (
                      <span style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
                        — {s.city}, {s.state}
                      </span>
                    )}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              style={{
                padding: '8px 22px', borderRadius: 8, cursor: submitting ? 'not-allowed' : 'pointer',
                background: '#dc2626', color: '#fff', border: 'none',
                fontWeight: 700, fontSize: 'var(--font-size-sm)',
                opacity: submitting ? 0.7 : 1,
              }}
            >
              {submitting ? 'Submitting…' : '🚨 Declare Emergency'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export default function DisasterResponsePage() {
  useDocumentTitle('Disaster Response');
  const { user } = useAuth();

  const [events, setEvents]               = useState([]);
  const [queueInfo, setQueueInfo]         = useState(null);
  const [account, setAccount]             = useState(null);
  const [sites, setSites]                 = useState([]);
  const [loading, setLoading]             = useState(true);
  const [showDeclare, setShowDeclare]     = useState(false);
  const [toast, setToast]                 = useState(null);
  const [resolving, setResolving]         = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [eventsRes, queueRes, repRes, sitesRes] = await Promise.allSettled([
        api.get('/api/disaster-events'),
        api.get('/api/disaster-events/queue-position'),
        api.get('/api/settings/service-rep'),
        api.get('/api/sites'),
      ]);

      if (eventsRes.status === 'fulfilled') {
        setEvents(eventsRes.value.data?.data?.events || []);
      }
      if (queueRes.status === 'fulfilled') {
        setQueueInfo(queueRes.value.data?.data || null);
      }
      if (repRes.status === 'fulfilled') {
        setAccount(repRes.value.data?.data || null);
      }
      if (sitesRes.status === 'fulfilled') {
        setSites(sitesRes.value.data?.data?.sites || []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleResolve(eventId) {
    setResolving(eventId);
    try {
      await api.post(`/api/disaster-events/${eventId}/resolve`);
      setToast({ title: 'Event resolved', message: 'The emergency declaration has been closed.', variant: 'success', duration: 4000 });
      load();
    } catch (err) {
      setToast({ title: 'Error', message: err.response?.data?.error || 'Could not resolve event.', variant: 'error' });
    } finally {
      setResolving(null);
    }
  }

  function handleDeclared(event) {
    setShowDeclare(false);
    setToast({
      title: '🚨 Emergency declared',
      message: 'Your service rep has been notified. You are now in the priority queue.',
      variant: 'success',
      duration: 6000,
    });
    load();
  }

  const hasMyDeclaration  = queueInfo?.declaration != null;
  const activeEventCount  = events.length;
  const repPhone          = account?.serviceRepPhone;
  const repName           = account?.serviceRepName;
  const repEmail          = account?.serviceRepEmail;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <AlertTriangle size={22} strokeWidth={2} style={{ color: '#dc2626' }} />
            Disaster Response
          </h1>
          <div className="page-subtitle">
            {loading
              ? 'Loading…'
              : activeEventCount > 0
                ? `${activeEventCount} active event${activeEventCount !== 1 ? 's' : ''} in your region`
                : 'No active weather alerts affecting your facilities'}
          </div>
        </div>
        {!hasMyDeclaration && (
          <button
            type="button"
            onClick={() => setShowDeclare(true)}
            style={{
              padding: '10px 20px', borderRadius: 8, cursor: 'pointer',
              background: '#dc2626', color: '#fff', border: 'none',
              fontWeight: 700, fontSize: 'var(--font-size-sm)',
              display: 'flex', alignItems: 'center', gap: 8,
            }}
          >
            <AlertTriangle size={14} strokeWidth={2} />
            Declare Emergency
          </button>
        )}
      </div>

      <div className="page-body">
        {/* ── Queue position card (shown once declared) ── */}
        {hasMyDeclaration && (
          <div style={{
            background: '#fef2f2', border: '2px solid #ef4444',
            borderRadius: 12, padding: 20, marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div style={{ fontWeight: 700, color: '#dc2626', fontSize: 'var(--font-size-md)', marginBottom: 4 }}>
                🚨 Emergency declared — you are in the priority queue
              </div>
              <div style={{ color: 'var(--color-text)', fontSize: 'var(--font-size-sm)' }}>
                {queueInfo.position != null && (
                  <>
                    Queue position: <strong>#{queueInfo.position}</strong> in your region
                    {queueInfo.totalAheadInRegion > 0 && (
                      <span style={{ color: 'var(--color-text-secondary)', marginLeft: 8 }}>
                        ({queueInfo.totalAheadInRegion} declaration{queueInfo.totalAheadInRegion !== 1 ? 's' : ''} ahead of you)
                      </span>
                    )}
                  </>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                {queueInfo.declaration?.title}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {repPhone && (
                <a
                  href={`tel:${repPhone}`}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '10px 18px', borderRadius: 8,
                    background: '#dc2626', color: '#fff', textDecoration: 'none',
                    fontWeight: 700, fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
                  }}
                >
                  <Phone size={14} strokeWidth={2} />
                  CALL NOW — {repPhone}
                </a>
              )}
              {(user?.role === 'admin' || user?.role === 'manager') && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => handleResolve(queueInfo.declaration.id)}
                  disabled={resolving === queueInfo.declaration.id}
                >
                  {resolving === queueInfo.declaration.id ? 'Resolving…' : 'Mark Resolved'}
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Service rep contact ── */}
        {(repPhone || repEmail) && !hasMyDeclaration && (
          <div style={{
            background: 'var(--color-card)', border: '1px solid var(--color-border)',
            borderRadius: 12, padding: 20, marginBottom: 20,
            display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap',
          }}>
            <Phone size={20} strokeWidth={1.75} style={{ color: 'var(--color-primary)', flexShrink: 0 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, marginBottom: 2 }}>
                {repName || 'Your Service Representative'}
              </div>
              <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)' }}>
                {repEmail && <span>{repEmail}</span>}
                {repEmail && repPhone && <span style={{ margin: '0 8px' }}>·</span>}
                {repPhone && <span>{repPhone}</span>}
              </div>
            </div>
            {repPhone && (
              <a
                href={`tel:${repPhone}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                  padding: '8px 16px', borderRadius: 8,
                  background: 'var(--color-primary)', color: '#fff',
                  textDecoration: 'none', fontWeight: 700,
                  fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
                }}
              >
                <Phone size={13} strokeWidth={2} />
                Call Now
              </a>
            )}
          </div>
        )}

        {/* ── Active events list ── */}
        {loading ? (
          <div className="card">
            <div className="loading">Loading disaster events…</div>
          </div>
        ) : activeEventCount === 0 ? (
          <div className="card">
            <div style={{ padding: 48, textAlign: 'center' }}>
              <CheckCircle size={40} strokeWidth={1.5} style={{ color: 'var(--color-success)', margin: '0 auto 16px' }} />
              <div style={{ fontWeight: 700, fontSize: 'var(--font-size-md)', marginBottom: 8 }}>
                No active weather alerts
              </div>
              <div style={{ color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-sm)' }}>
                ServiceCycle monitors NWS active alerts for Extreme and Severe weather events every 15 minutes.
                If an event affects your facility region, it will appear here automatically.
              </div>
              <div style={{ marginTop: 24 }}>
                <button
                  type="button"
                  onClick={() => setShowDeclare(true)}
                  style={{
                    padding: '9px 20px', borderRadius: 8, cursor: 'pointer',
                    background: '#dc2626', color: '#fff', border: 'none',
                    fontWeight: 700, fontSize: 'var(--font-size-sm)',
                  }}
                >
                  Manually Declare Emergency
                </button>
                <div style={{ marginTop: 10, color: 'var(--color-text-secondary)', fontSize: 'var(--font-size-xs)' }}>
                  Use this if a local emergency isn't yet in the national alert system.
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {events.map(ev => {
              const isOwn   = ev.accountId != null;
              const sevMeta = SEV_META[ev.severity] || SEV_META.watch;
              return (
                <div
                  key={ev.id}
                  className="card"
                  style={{ borderLeft: `4px solid ${sevMeta.border}`, padding: 20 }}
                >
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                        <SeverityBadge severity={ev.severity} />
                        <span style={{
                          padding: '2px 8px', borderRadius: 20,
                          fontSize: 'var(--font-size-xs)', fontWeight: 600,
                          background: 'var(--color-bg)', border: '1px solid var(--color-border)',
                          color: 'var(--color-text-secondary)',
                        }}>
                          {EVENT_LABELS[ev.eventType] || ev.eventType}
                        </span>
                        {isOwn && (
                          <span style={{
                            padding: '2px 8px', borderRadius: 20,
                            fontSize: 'var(--font-size-xs)', fontWeight: 600,
                            background: '#fef2f2', border: '1px solid #ef4444',
                            color: '#dc2626',
                          }}>
                            Your Declaration
                          </span>
                        )}
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                          {ev.source === 'nws' ? 'NWS Alert' : ev.source === 'fema' ? 'FEMA' : 'Manual'}
                        </span>
                      </div>

                      <div style={{ fontWeight: 700, marginBottom: 4 }}>{ev.title}</div>

                      {ev.region && (
                        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)', marginBottom: 4 }}>
                          📍 {ev.region}
                        </div>
                      )}

                      {ev.affectedSiteIds?.length > 0 && (
                        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)' }}>
                          {ev.affectedSiteIds.length} of your site{ev.affectedSiteIds.length !== 1 ? 's' : ''} in the impact zone
                        </div>
                      )}

                      <div style={{ marginTop: 6, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <Clock size={11} strokeWidth={1.75} />
                        Declared {new Date(ev.declaredAt).toLocaleString()}
                      </div>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flexShrink: 0 }}>
                      {!hasMyDeclaration && !isOwn && (
                        <button
                          type="button"
                          onClick={() => setShowDeclare(true)}
                          style={{
                            padding: '7px 16px', borderRadius: 8, cursor: 'pointer',
                            background: '#dc2626', color: '#fff', border: 'none',
                            fontWeight: 700, fontSize: 'var(--font-size-xs)',
                            display: 'flex', alignItems: 'center', gap: 6,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          <AlertTriangle size={12} strokeWidth={2} />
                          Declare Emergency
                        </button>
                      )}
                      {isOwn && (user?.role === 'admin' || user?.role === 'manager') && (
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => handleResolve(ev.id)}
                          disabled={resolving === ev.id}
                        >
                          {resolving === ev.id ? 'Resolving…' : 'Mark Resolved'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* ── No rep configured notice ── */}
        {!repPhone && !repEmail && !loading && (
          <div style={{
            marginTop: 20, padding: 16, borderRadius: 10,
            background: 'var(--color-bg)', border: '1px dashed var(--color-border)',
            fontSize: 'var(--font-size-sm)', color: 'var(--color-text-secondary)',
            textAlign: 'center',
          }}>
            No service rep contact configured. Ask your account administrator to add rep contact info in{' '}
            <a href="/settings" style={{ color: 'var(--color-primary)' }}>Settings → Workspace</a>.
          </div>
        )}
      </div>

      {showDeclare && (
        <DeclareModal
          sites={sites}
          onClose={() => setShowDeclare(false)}
          onDeclared={handleDeclared}
        />
      )}

      <Toast toast={toast} onClose={() => setToast(null)} />
    </>
  );
}
