/**
 * HelpDrawer — slide-out panel rendering per-module help content.
 *
 * Two modes:
 *   1. Picker — opened without a slug. Renders a grid of module cards;
 *      clicking one loads that module's content.
 *   2. Content — opened with a slug (`{ detail: { moduleSlug: 'assets' } }`)
 *      OR after the user clicks a module card. Renders title, TOC,
 *      markdown body, "Back to all modules", "Export PDF", "Contact support".
 *
 * Listens for the global `servicecycle:open-help` CustomEvent. Fired by
 *   - the sidebar "Help" entry (opens picker)
 *   - any future page-context HelpButton (opens directly to a module)
 *
 * UX:
 *   - 420px wide, slides in from the right
 *   - Backdrop is transparent — users can keep reading help while they
 *     interact with the page (no modal lock-out)
 *   - Escape closes
 *
 * Public surface — no auth required. Works on the login screen so a
 * prospect on the demo can read help without signing up. As of v0.37.1
 * (W5 MT-023) the drawer is mounted at the App root (next to
 * <AiConsentModal />) instead of inside <Layout />, so the docstring
 * claim is real — public routes (Login, Register, Forgot, Legal pages)
 * can fire the `servicecycle:open-help` event and the drawer responds.
 *
 * v0.37.1 W5 MT-025: markdown rendering switched from a hand-rolled
 * dangerouslySetInnerHTML pipeline to react-markdown + remark-gfm
 * (matching LegalDocPage.jsx convention). Eliminates the F021-era XSS
 * surface Pass-1 flagged (the previous renderer escaped angle brackets
 * but the surrounding helper code repeatedly tempted future regressions
 * to drop the escape pass for "richer" inline behaviour). react-markdown
 * never executes script tags and never renders raw HTML by default —
 * the entire trust boundary disappears.
 */

import { useEffect, useRef, useState, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import api from '../api/client';

// Extract `## ` h2 headings from raw markdown so the drawer can build a
// fly-to-section TOC strip above the body. We keep this as a small util
// instead of letting react-markdown render the TOC because the chip-row
// styling is drawer-specific (not appropriate for legal pages).
function extractToc(md) {
  if (!md) return [];
  const toc = [];
  for (const line of md.split('\n')) {
    const m = line.trim().match(/^##\s+(.+)$/);
    if (m) {
      const text = m[1];
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      toc.push({ slug, text });
    }
  }
  return toc;
}

// Build a stable slug for an h2 so the TOC chip click can scrollIntoView
// to the exact element react-markdown renders. Mirrors the extractToc
// slug derivation so the two stay in sync.
function headingId(children) {
  // children from react-markdown is usually a single string for plain
  // headings; for headings with inline formatting it's an array of
  // strings + React nodes. Flatten to plain text before slugifying.
  function asText(node) {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(asText).join('');
    if (node && typeof node === 'object' && node.props) return asText(node.props.children);
    return '';
  }
  const text = asText(children);
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// H2-4/H4-4 (v0.76.7): route → module slug map for context-sensitive open
const ROUTE_MODULE_MAP = {
  '/dashboard':          'dashboard',
  '/assets':             'assets',
  '/sites':              'sites',
  '/work-orders':        'work-orders',
  // The compliance calendar is the schedules module's surface — there is no
  // 'calendar' help doc, so mapping it here previously 404'd the drawer.
  '/calendar':           'schedules',
  // Outage Planner is a schedules surface (account-wide due/outage view).
  '/outage-planner':     'schedules',
  '/contractors':        'contractors',
  '/alerts':             'alerts',
  '/reports':            'reports',
  '/reports/arc-flash':         'arc-flash',
  '/reports/arc-flash-fleet':   'arc-flash',
  '/reports/arc-flash-heatmap': 'arc-flash',
  '/reports/arc-flash-search':  'arc-flash',
  // All the data-in surfaces share the 'imports' module.
  '/add-data':           'imports',
  '/test-reports/import': 'imports',
  '/backfill':           'imports',
  // Review queue is the human-OK step on the ingest paths — same module.
  '/review':             'imports',
  // Deficiencies are captured/triaged in the work-order flow.
  '/deficiencies':       'work-orders',
  // Fleet View is OEM cross-account reporting.
  '/fleet':              'reports',
  '/settings':           'settings',
  '/users':              'settings',
  '/activity':           'settings',
  '/parts':              'parts',
  '/quote-requests':     'quote-requests',
};
function slugForPath(p) {
  if (!p) return null;
  if (ROUTE_MODULE_MAP[p]) return ROUTE_MODULE_MAP[p];
  for (const [prefix, s] of Object.entries(ROUTE_MODULE_MAP)) {
    if (p.startsWith(prefix + '/')) return s;
  }
  return null;
}

export default function HelpDrawer({ currentPath = '' }) {
  const [open, setOpen]       = useState(false);
  const [slug, setSlug]       = useState(null);
  const [title, setTitle]     = useState('');
  const [markdown, setMd]     = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [modules, setModules] = useState(null);
  const bodyRef = useRef(null);

  // Live ref to currentPath so the open-help listener (registered once below)
  // resolves help for the CURRENT route, not the route captured when the drawer
  // first mounted. Without this, every Help click opened the page you FIRST
  // clicked Help on (e.g. on /alerts you'd get Contracts help).
  const pathRef = useRef(currentPath);
  useEffect(() => { pathRef.current = currentPath; }, [currentPath]);

  // 1.4: dismiss any open help panel when the user navigates to a different
  // route, so help doesn't persist across pages (repro: open Reports help,
  // click Contractors -> the Reports help used to stay open). Keyed on
  // currentPath; the first run is skipped so the initial mount never fights a
  // deep-link open.
  const helpMountedRef = useRef(false);
  useEffect(() => {
    if (!helpMountedRef.current) { helpMountedRef.current = true; return; }
    setOpen(false);
  }, [currentPath]);

  // Listen for the global open event.
  useEffect(() => {
    function handler(e) {
      // H2-4/H4-4 (v0.76.7): if no explicit moduleSlug, auto-detect from currentPath
      const s = e?.detail?.moduleSlug || slugForPath(pathRef.current) || null;
      setSlug(s);
      setOpen(true);
    }
    window.addEventListener('servicecycle:open-help', handler);
    return () => window.removeEventListener('servicecycle:open-help', handler);
  }, []);

  // Fetch the module list once on first open (cached after).
  useEffect(() => {
    if (!open || modules) return;
    api.get('/api/help/modules')
      .then(r => setModules(r.data?.data?.modules || []))
      .catch(err => console.warn('[HelpDrawer] modules fetch failed', err));
  }, [open, modules]);

  // Fetch content when slug changes.
  useEffect(() => {
    if (!slug) { setMd(''); setTitle(''); return; }
    let cancelled = false;
    setLoading(true);
    setError('');
    api.get(`/api/help/modules/${encodeURIComponent(slug)}`)
      .then(r => {
        if (cancelled) return;
        setTitle(r.data?.data?.title || slug);
        setMd(r.data?.data?.markdown || '');
      })
      .catch(err => {
        if (cancelled) return;
        setError('Help content for this module could not be loaded. Try again or contact your operator.');
        console.warn('[HelpDrawer] fetch failed', err);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  // Escape closes the drawer — but ONLY when focus is inside the drawer.
  //
  // v0.36.5 polish (Pass-3 C MF-1): pre-patch, this was a window-level
  // listener that closed the drawer on ANY Escape press regardless of
  // focus context. A user typing in a textarea on the page underneath
  // hitting Escape (to cancel a draft, for instance) would also dismiss
  // the drawer behind their back. Scoping to drawer focus matches the
  // role="complementary" / non-modal intent: the drawer doesn't claim
  // exclusive focus, so it shouldn't claim exclusive keyboard either.
  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key !== 'Escape') return;
      const active = document.activeElement;
      // Resolve the drawer root via bodyRef (drawer body) and walk up to
      // the outer <aside>. If activeElement is inside that subtree the
      // Escape was directed at the drawer; otherwise leave it for the
      // surface the user actually has focus in.
      const drawerRoot = bodyRef.current ? bodyRef.current.closest('aside') : null;
      if (drawerRoot && active && drawerRoot.contains(active)) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [slug]);

  const toc = useMemo(() => extractToc(markdown), [markdown]);

  function handlePdfExport() {
    if (!slug) return;
    window.open(`/api/help/modules/${encodeURIComponent(slug)}/pdf`, '_blank', 'noopener');
  }

  function handleJump(sectionSlug) {
    if (!bodyRef.current) return;
    const el = bodyRef.current.querySelector(`#${sectionSlug}`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const pickerMode = !slug;

  // v0.37.1 W5 MT-025: react-markdown component map. Each tag gets a
  // tiny inline-styled wrapper that mirrors the previous .help-doc-body
  // CSS rules (kept verbatim below for the picker-mode header chrome).
  // Headings get an `id` so the TOC chip jump-to-section keeps working.
  const mdComponents = {
    h1: ({ children, ...p }) => (
      <h1 id={headingId(children)} style={{ fontSize: 20, fontWeight: 700, margin: '0 0 12px', color: 'var(--color-text, #0f172a)' }} {...p}>{children}</h1>
    ),
    h2: ({ children, ...p }) => (
      <h2 id={headingId(children)} style={{ fontSize: 'var(--font-size-base)', fontWeight: 700, margin: '22px 0 8px', color: 'var(--color-text, #0f172a)', paddingBottom: 4, borderBottom: '1px solid var(--color-border, #e2e8f0)' }} {...p}>{children}</h2>
    ),
    h3: ({ children, ...p }) => (
      <h3 id={headingId(children)} style={{ fontSize: 'var(--font-size-ui)', fontWeight: 600, margin: '16px 0 6px', color: 'var(--color-text, #0f172a)' }} {...p}>{children}</h3>
    ),
    p:  ({ children, ...p }) => <p style={{ margin: '0 0 10px' }} {...p}>{children}</p>,
    ul: ({ children, ...p }) => <ul style={{ margin: '0 0 12px', paddingLeft: 22 }} {...p}>{children}</ul>,
    ol: ({ children, ...p }) => <ol style={{ margin: '0 0 12px', paddingLeft: 22 }} {...p}>{children}</ol>,
    li: ({ children, ...p }) => <li style={{ marginBottom: 4 }} {...p}>{children}</li>,
    strong: ({ children, ...p }) => <strong style={{ fontWeight: 700 }} {...p}>{children}</strong>,
    em: ({ children, ...p }) => <em style={{ fontStyle: 'italic', color: 'var(--color-text-secondary, #475569)' }} {...p}>{children}</em>,
    code: ({ inline, children, ...p }) => inline === false
      ? <code {...p}>{children}</code>
      : <code style={{ background: 'var(--color-surface-alt, #f1f5f9)', padding: '1px 4px', borderRadius: 3, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 'var(--font-size-sm)' }} {...p}>{children}</code>,
    a: ({ href, children, ...p }) => (
      <a
        href={href}
        target={href?.startsWith('http') ? '_blank' : undefined}
        rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
        style={{ color: 'var(--color-primary, #0d4f6e)', textDecoration: 'underline' }}
        {...p}
      >{children}</a>
    ),
    // Tables (needed for the api-and-integrations + imports modules,
    // which use markdown tables to compare options + dedup keys).
    table: ({ children, ...p }) => (
      <div style={{ overflowX: 'auto', margin: '12px 0' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, border: '1px solid var(--color-border, #e2e8f0)', borderRadius: 4 }} {...p}>{children}</table>
      </div>
    ),
    thead: ({ children, ...p }) => <thead style={{ background: 'var(--color-surface-alt, #f1f5f9)' }} {...p}>{children}</thead>,
    tr: ({ children, ...p }) => <tr style={{ borderTop: '1px solid var(--color-border, #e2e8f0)' }} {...p}>{children}</tr>,
    th: ({ children, ...p }) => <th scope="col" style={{ padding: '6px 8px', textAlign: 'left', fontWeight: 700, fontSize: 'var(--font-size-sm)', color: 'var(--color-text, #0f172a)' }} {...p}>{children}</th>,
    td: ({ children, ...p }) => <td style={{ padding: '6px 8px', color: 'var(--color-text, #0f172a)', verticalAlign: 'top' }} {...p}>{children}</td>,
    hr: () => <hr style={{ border: 0, borderTop: '1px solid var(--color-border, #e2e8f0)', margin: '16px 0' }} />,
    blockquote: ({ children, ...p }) => (
      <blockquote style={{ borderLeft: '3px solid var(--color-border, #c7cfdb)', margin: '8px 0', padding: '4px 12px', color: 'var(--color-text-secondary, #475569)', background: 'var(--color-surface-alt, #fafbfd)' }} {...p}>{children}</blockquote>
    ),
  };

  return (
    <aside
      role="complementary"
      inert={!open ? '' : undefined}
      aria-label="Help drawer"
      style={{
        position: 'fixed',
        top: 0, right: 0, bottom: 0,
        width: 420,
        maxWidth: '95vw',
        background: 'var(--color-surface, #ffffff)',
        borderLeft: '1px solid var(--color-border, #cbd5e1)',
        boxShadow: open ? '-8px 0 32px rgba(15,23,42,0.18)' : 'none',
        transform: open ? 'translateX(0)' : 'translateX(105%)',
        transition: 'transform 0.22s ease-out, box-shadow 0.22s ease-out',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'inherit',
      }}
    >
      {/* Header */}
      <div style={{
        padding: '14px 18px',
        borderBottom: '1px solid var(--color-border, #e2e8f0)',
        background: 'var(--color-surface-alt, #f8fafc)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--color-text-secondary, #64748b)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
            {pickerMode ? 'Help' : (
              <button
                type="button"
                onClick={() => setSlug(null)}
                style={{ background: 'none', border: 'none', padding: 0, color: 'inherit', font: 'inherit', cursor: 'pointer', textTransform: 'inherit', letterSpacing: 'inherit' }}
              >
                ← All modules
              </button>
            )}
          </div>
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--color-text, #0f172a)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {pickerMode ? 'Help · Module reference' : (loading ? 'Loading…' : (title || slug || '—'))}
          </div>
        </div>
        {!pickerMode && (
          <button
            type="button"
            onClick={handlePdfExport}
            disabled={!slug || loading}
            title="Export this page as PDF"
            style={{
              background: 'transparent',
              border: '1px solid var(--color-border, #cbd5e1)',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 'var(--font-size-sm)',
              cursor: slug && !loading ? 'pointer' : 'not-allowed',
              color: 'var(--color-text-secondary, #64748b)',
            }}
          >
            PDF
          </button>
        )}
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close help"
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 'var(--font-size-xl)',
            color: 'var(--color-text-secondary, #64748b)',
            padding: '0 4px',
            lineHeight: 1,
          }}
        >
          {'×'}
        </button>
      </div>

      {/* Picker mode: module grid */}
      {pickerMode && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 80px' }}>
          <p style={{ fontSize: 'var(--font-size-ui)', color: 'var(--color-text-secondary, #475569)', margin: '0 0 14px' }}>
            Pick a module to read its quick-reference guide. Each one covers what the module is, how to use it, common workflows, and what to check when something looks wrong.
          </p>
          {!modules && (
            <div style={{ color: 'var(--color-text-secondary, #64748b)', padding: '20px 0' }}>
              Loading modules…
            </div>
          )}
          {modules && modules.length === 0 && (
            <div style={{ color: 'var(--color-text-secondary, #64748b)', padding: '20px 0' }}>
              No help modules are configured on this instance.
            </div>
          )}
          {modules && modules.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {modules.map(m => (
                <button
                  key={m.slug}
                  type="button"
                  onClick={() => setSlug(m.slug)}
                  style={{
                    textAlign: 'left',
                    background: 'var(--color-surface, #fff)',
                    border: '1px solid var(--color-border, #e2e8f0)',
                    borderRadius: 6,
                    padding: '12px 14px',
                    cursor: 'pointer',
                    transition: 'border-color 0.1s, box-shadow 0.1s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = 'var(--color-primary, #0d4f6e)';
                    e.currentTarget.style.boxShadow = '0 1px 4px rgba(15,23,42,0.08)';
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = 'var(--color-border, #e2e8f0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <div style={{ fontSize: 'var(--font-size-data)', fontWeight: 600, color: 'var(--color-text, #0f172a)', marginBottom: 3 }}>
                    {m.title}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--color-text-secondary, #64748b)', lineHeight: 1.45 }}>
                    {m.description}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content mode: TOC + body */}
      {!pickerMode && toc.length > 0 && (
        <nav
          aria-label="Table of contents"
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid var(--color-border, #e2e8f0)',
            fontSize: 'var(--font-size-sm)',
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          {toc.map(t => (
            <button
              key={t.slug}
              type="button"
              onClick={() => handleJump(t.slug)}
              style={{
                background: 'var(--color-surface-alt, #f1f5f9)',
                border: '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 12,
                padding: '3px 10px',
                fontSize: 'var(--font-size-xs)',
                cursor: 'pointer',
                color: 'var(--color-text-secondary, #475569)',
              }}
            >
              {t.text}
            </button>
          ))}
        </nav>
      )}

      {!pickerMode && (
        <div
          ref={bodyRef}
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px 22px 80px',
            fontSize: 13.5,
            lineHeight: 1.55,
            color: 'var(--color-text, #0f172a)',
          }}
        >
          {error && (
            <div style={{
              padding: '12px 14px',
              borderRadius: 6,
              background: 'var(--chip-red-bg)',
              color: 'var(--chip-red-fg)',
              fontSize: 'var(--font-size-ui)',
            }}>
              {error}
            </div>
          )}
          {!error && !loading && (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={mdComponents}
            >
              {markdown}
            </ReactMarkdown>
          )}
          {loading && !error && (
            <div style={{ color: 'var(--color-text-secondary, #64748b)', padding: '20px 0' }}>
              Loading help content...
            </div>
          )}
        </div>
      )}

      {/* Footer cross-link - visible only in content mode */}
      {!pickerMode && (
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          padding: '12px 18px',
          background: 'var(--color-surface, #ffffff)',
          borderTop: '1px solid var(--color-border, #e2e8f0)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: 'var(--font-size-sm)',
        }}>
          <span style={{ color: 'var(--color-text-secondary, #64748b)' }}>
            Still confused?
          </span>
          <a
            href="mailto:support@servicecycle.app"
            style={{
              background: 'var(--color-primary, #0d4f6e)',
              color: 'var(--color-surface, #fff)',
              border: 'none',
              padding: '6px 12px',
              borderRadius: 4,
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              cursor: 'pointer',
              textDecoration: 'none',
            }}
          >
            Contact support &rarr;
          </a>
        </div>
      )}
    </aside>
  );
}
