/**
 * LegalDocPage — shared chrome for any markdown-backed public legal page.
 *
 * Used by EulaPage, SubProcessorsPage, TermsPage, PrivacyPage, DPAPage,
 * DemoSandboxNoticePage, TIAPage. Renders the corresponding markdown
 * source string via react-markdown (with remark-gfm for tables) inside
 * the same nav + page shell as the rest of the marketing site.
 *
 * Markdown source is loaded via Vite's `?raw` import in the wrapper
 * pages — single source of truth in legal/, no duplicated content.
 *
 * History:
 *   - v0.32.0 — initial implementation with ReactMarkdown rendering.
 *   - v0.32.1 — temporary takedown: OFFLINE_FOR_REVIEW set to true so
 *     every /privacy /terms /eula /sub-processors /demo-sandbox-notice
 *     route rendered a "policy temporarily offline" notice, pending
 *     counsel review of the AI-drafted markdown sources. Imports of
 *     ReactMarkdown / remark-gfm / mdComponents were stripped to keep
 *     the bundle clean during takedown.
 *   - v0.35.0 — restored: OFFLINE_FOR_REVIEW back to false. The
 *     drafts in legal/*-draft-2026-05.md have been substantively
 *     revised against the 6-agent legal review (audit/legal-pass-
 *     2026-05-17/SYNTHESIS.md) and are now live. The "DRAFT — pending
 *     counsel review" banner remains so visitors know these are
 *     pre-counsel drafts. The takedown-page fallback is preserved for
 *     future use if we ever need to re-take down for further revision.
 *
 * To re-take docs down for further revision:
 *   1. Set OFFLINE_FOR_REVIEW = true in the constant below.
 *   2. The takedown notice rendered by the OFFLINE_FOR_REVIEW=true
 *      branch will be served at every legal route.
 *
 * To swap a draft for a counsel-reviewed version:
 *   1. Rename `legal/<name>-draft-2026-05.md` → `legal/<name>-2026-XX.md`
 *      (drop the "-draft" suffix) per legal/README.md.
 *   2. Delete the disclaimer header from the file.
 *   3. Update the wrapper page in client/src/pages/{Eula,Privacy,Terms,
 *      DemoSandboxNotice,SubProcessors}Page.jsx to import the new path.
 *   4. Set the draftBanner prop to false on the LegalDocPage for that
 *      specific page (or omit it — default below changes to false once
 *      no drafts are left).
 */

import { Link, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Flip to true to re-take docs down for further revision; the
// takedown-notice JSX below the early return is preserved so the
// behaviour switch is a one-line change.
const OFFLINE_FOR_REVIEW = false;

export default function LegalDocPage({ source, lastUpdated, draftBanner = true }) {
  const navigate = useNavigate();

  // ── v0.32.1 takedown branch (preserved for future re-takedown) ───────────
  if (OFFLINE_FOR_REVIEW) {
    return (
      <div style={s.page}>
        <header style={s.nav}>
          <div style={s.navInner}>
            <Link to="/" style={s.logo}>
              <span style={s.logoMark}>L</span>
              <span style={s.logoText}>ServiceCycle</span>
            </Link>
            <button style={s.navCta} onClick={() => navigate('/login')}>Sign in</button>
          </div>
        </header>

        <main style={s.main}>
          <h1 style={s.h1}>This policy is temporarily offline</h1>

          <div style={s.callout} role="note">
            <p style={s.calloutP}>
              <strong>We're updating our legal documents and they are not
              available for public reading right now.</strong>
            </p>
            <p style={s.calloutP}>
              ForgeRift LLC, the company behind ServiceCycle, is in the middle
              of revising our public-facing legal documents — Terms of
              Service, Privacy Policy, End-User License Agreement, Demo
              Sandbox Notice, and Sub-processor List. While that revision
              is in progress, we have taken the previous draft versions
              down rather than leave them rendering as live policy.
            </p>
            <p style={s.calloutP}>
              Updated versions will be published at the same URLs
              (<code>/privacy</code>, <code>/terms</code>,
              <code> /eula</code>, <code>/sub-processors</code>,
              <code> /demo-sandbox-notice</code>) when the revision is
              complete. If you need a copy of any document for
              procurement, due-diligence, or regulatory purposes before
              then, email <a style={s.link} href="mailto:privacy@servicecycle.com">privacy@servicecycle.com</a>
              {' '}and we will send the most recent draft along with the
              status of the revision.
            </p>
            <p style={s.calloutP}>
              We continue to honor the data-protection and security
              commitments described to you at the time you created your
              account. Personal-data export and deletion requests can be
              sent to{' '}
              <a style={s.link} href="mailto:privacy@servicecycle.com">privacy@servicecycle.com</a>
              {' '}and security-vulnerability reports to{' '}
              <a style={s.link} href="mailto:security@servicecycle.com">security@servicecycle.com</a>.
            </p>
            <p style={{ ...s.calloutP, marginBottom: 0, color: '#5b6373', fontSize: 'var(--font-size-ui)' }}>
              — ForgeRift LLC, the team behind ServiceCycle
            </p>
          </div>

          <div style={s.footerNav}>
            <Link to="/"      style={s.footerLink}>← Home</Link>
            <a href="mailto:privacy@servicecycle.com" style={s.footerLink}>privacy@servicecycle.com</a>
            <a href="mailto:security@servicecycle.com" style={s.footerLink}>security@servicecycle.com</a>
          </div>
        </main>
      </div>
    );
  }

  // ── v0.35.0 live-draft branch ─────────────────────────────────────────────
  // Strip the standard "DISCLAIMER — DRAFT…" blockquote header from the
  // markdown body so we can render it as our own styled callout instead
  // of an inline quote. Pattern-match conservatively: only strip the
  // leading blockquote block IF it begins with "> **DISCLAIMER".
  //
  // v0.36.5 polish (Pass-3 E MF-1): also strip the two inline "draft"
  // metadata lines (Effective Date: To be set on publication / Version:
  // Draft v1 — ...) so the word "Draft" stops appearing 4-5x in the
  // first viewport for any legal reviewer. The styled callout above
  // already names the document as a pre-counsel draft.
  let body = source || '';
  let strippedDisclaimer = false;
  const disclaimerRe = /^>[ \t]*\*\*DISCLAIMER[\s\S]*?(?:\n\n|\n(?=[^>\s]))/;
  if (draftBanner && disclaimerRe.test(body)) {
    body = body.replace(disclaimerRe, '').trimStart();
    strippedDisclaimer = true;
  }
  if (draftBanner) {
    // Only strip within the first ~2KB so we never accidentally drop
    // identical-looking phrasing deeper in the document body.
    const head = body.slice(0, 2000);
    const tail = body.slice(2000);
    const headStripped = head
      .replace(/^\*\*Effective Date:\*\*[ \t]*\*?To be set on publication\.?\*?[ \t]*\n/m, '')
      .replace(/^\*\*Version:\*\*[ \t]*[^\n]*Draft[^\n]*\n/m, '');
    body = headStripped + tail;
  }

  return (
    <div style={s.page}>
      <header style={s.nav}>
        <div style={s.navInner}>
          <Link to="/" style={s.logo}>
            <span style={s.logoMark}>L</span>
            <span style={s.logoText}>ServiceCycle</span>
          </Link>
          <button style={s.navCta} onClick={() => navigate('/login')}>Sign in</button>
        </div>
      </header>

      <main style={s.main}>
        {strippedDisclaimer && (
          <div style={s.disclaimer} role="note">
            <strong>Draft — pending counsel review, not yet legally binding.</strong>{' '}
            This document is an AI-assisted draft published while
            ForgeRift LLC's counsel completes their review. It reflects
            ForgeRift's current intent and operating practices but is
            not the counsel-approved authoritative version. When counsel
            review is complete, the authoritative version will replace
            this draft at the same URL and existing account holders will
            be notified by email with a reasonable period to re-affirm
            acceptance.
          </div>
        )}

        <article style={s.article}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={mdComponents}
          >
            {body}
          </ReactMarkdown>
        </article>

        {lastUpdated && (
          <p style={s.meta}>
            Source: <code style={s.code}>{lastUpdated}</code>
          </p>
        )}

        <div style={s.footerNav}>
          <Link to="/"                      style={s.footerLink}>← Home</Link>
          <Link to="/terms"                 style={s.footerLink}>Terms</Link>
          <Link to="/privacy"               style={s.footerLink}>Privacy</Link>
          <Link to="/eula"                  style={s.footerLink}>EULA</Link>
          <Link to="/demo-sandbox-notice"   style={s.footerLink}>Demo Sandbox Notice</Link>
          <Link to="/sub-processors"        style={s.footerLink}>Sub-processors</Link>
        </div>
      </main>
    </div>
  );
}

// ── Markdown → styled React components ──────────────────────────────────────
const mdComponents = {
  h1:   ({ node, ...p }) => <h1 style={s.h1} {...p} />,
  h2:   ({ node, ...p }) => <h2 style={s.h2} {...p} />,
  h3:   ({ node, ...p }) => <h3 style={s.h3} {...p} />,
  p:    ({ node, ...p }) => <p  style={s.p}  {...p} />,
  ul:   ({ node, ...p }) => <ul style={s.ul} {...p} />,
  ol:   ({ node, ...p }) => <ol style={s.ol} {...p} />,
  li:   ({ node, ...p }) => <li style={s.li} {...p} />,
  a:    ({ node, ...p }) => <a
    style={s.link}
    target={p.href?.startsWith('http') ? '_blank' : undefined}
    rel={p.href?.startsWith('http') ? 'noopener noreferrer' : undefined}
    {...p}
  />,
  strong: ({ node, ...p }) => <strong style={{ color: '#0a0d12', fontWeight: 700 }} {...p} />,
  em:     ({ node, ...p }) => <em style={{ color: '#5b6373' }} {...p} />,
  code:   ({ node, inline, ...p }) => inline
    ? <code style={s.codeInline} {...p} />
    : <code {...p} />,
  pre:  ({ node, ...p }) => <pre style={s.pre} {...p} />,
  blockquote: ({ node, ...p }) => <blockquote style={s.blockquote} {...p} />,
  hr:   ({ node, ...p }) => <hr style={s.hr} {...p} />,
  table:({ node, ...p }) => <div style={{ overflowX: 'auto', margin: '1.4rem 0' }}><table style={s.table} {...p} /></div>,
  thead:({ node, ...p }) => <thead style={s.thead} {...p} />,
  tbody:({ node, ...p }) => <tbody {...p} />,
  tr:   ({ node, ...p }) => <tr style={s.tr} {...p} />,
  th:   ({ node, ...p }) => <th scope="col" style={s.th} {...p} />,
  td:   ({ node, ...p }) => <td style={s.td} {...p} />,
};

// ── Styles ───────────────────────────────────────────────────────────────────
// Mirrors the TermsPage / EulaPage chrome from pre-takedown for visual
// continuity. Takedown-page styles (callout, h1, calloutP) are preserved
// so the OFFLINE_FOR_REVIEW=true branch above continues to render
// correctly if re-enabled.
const s = {
  page: {
    minHeight: '100vh',
    background: '#fff',
    fontFamily: "var(--font-sans)",  /* BRT-BRAND-002 */
    color: '#0a0d12',
  },
  nav: {
    position: 'sticky', top: 0,
    background: 'rgba(255,255,255,0.95)',
    backdropFilter: 'blur(8px)',
    borderBottom: '1px solid #dde2eb',
    zIndex: 100,
  },
  navInner: {
    maxWidth: 800, margin: '0 auto',
    padding: '0 1.5rem', height: 60,
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  logo: { display: 'flex', alignItems: 'center', gap: 8, textDecoration: 'none' },
  logoMark: {
    width: 30, height: 30, background: '#0d4f6e', color: '#fff',
    borderRadius: 7, display: 'inline-flex', alignItems: 'center',
    justifyContent: 'center', fontWeight: 800, fontSize: 16,
  },
  logoText: { fontWeight: 700, fontSize: 'var(--font-size-lg)', color: '#0a0d12' },
  navCta: {
    background: '#0d4f6e', color: '#fff', border: 'none', borderRadius: 7,
    padding: '0.45rem 1rem', fontSize: 'var(--font-size-ui)', fontWeight: 600, cursor: 'pointer',
  },

  main: { maxWidth: 760, margin: '0 auto', padding: '3rem 1.5rem 5rem' },

  // ── Live-draft chrome (v0.35.0 active branch) ────────────────────────────
  disclaimer: {
    background: '#fef3c7',
    border: '1px solid #fcd34d',
    color: '#78350f',
    borderRadius: 8,
    padding: '1rem 1.25rem',
    fontSize: 'var(--font-size-data)',
    lineHeight: 1.55,
    marginBottom: '2.5rem',
  },
  article: { lineHeight: 1.65, fontSize: 15.5, color: '#2a3140' },

  // Headings
  h1: { fontSize: '2.2rem', fontWeight: 800, letterSpacing: '-0.025em', margin: '0 0 1.5rem', color: '#0a0d12' },
  h2: { fontSize: '1.3rem', fontWeight: 700, color: '#0a0d12', margin: '2.4rem 0 0.75rem' },
  h3: { fontSize: '1.05rem', fontWeight: 700, color: '#0a0d12', margin: '1.6rem 0 0.5rem' },

  // Paragraph + lists
  p:  { fontSize: 'var(--font-size-base)', lineHeight: 1.7, color: '#2a3140', margin: '0 0 0.95rem' },
  ul: { fontSize: 'var(--font-size-base)', lineHeight: 1.7, color: '#2a3140', paddingLeft: '1.4rem', margin: '0 0 1rem' },
  ol: { fontSize: 'var(--font-size-base)', lineHeight: 1.7, color: '#2a3140', paddingLeft: '1.4rem', margin: '0 0 1rem' },
  li: { marginBottom: '0.4rem' },

  // Inline
  link:       { color: '#0d4f6e', textDecoration: 'underline' },
  codeInline: {
    background: '#eef1f6', color: '#0a0d12',
    padding: '1px 6px', borderRadius: 4,
    fontFamily: 'Menlo, Consolas, monospace', fontSize: '0.88em',
  },
  pre: {
    background: '#0a0d12', color: '#dde2eb',
    padding: '1rem 1.25rem', borderRadius: 8,
    overflowX: 'auto', fontSize: 'var(--font-size-ui)', lineHeight: 1.5,
    margin: '1rem 0',
  },
  blockquote: {
    borderLeft: '3px solid #c7cfdb',
    margin: '1rem 0',
    padding: '0.4rem 1rem',
    color: '#5b6373',
    background: '#fafbfd',
    fontStyle: 'normal',
  },
  hr: { border: 0, borderTop: '1px solid #dde2eb', margin: '2rem 0' },

  // Tables (DPA Annexes, Sub-processor list, CCPA categories, state matrix, etc.)
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 13.5,
    background: '#fff',
    border: '1px solid #dde2eb',
    borderRadius: 6,
  },
  thead: { background: '#fafbfd' },
  tr:    { borderTop: '1px solid #dde2eb' },
  th:    {
    padding: '0.6rem 0.85rem', textAlign: 'left',
    fontWeight: 700, color: '#0a0d12', fontSize: 'var(--font-size-ui)',
    borderBottom: '1px solid #dde2eb',
  },
  td: { padding: '0.55rem 0.85rem', color: '#5b6373', verticalAlign: 'top' },

  meta: { fontSize: 'var(--font-size-sm)', color: '#9aa3b2', marginTop: '2.5rem', textAlign: 'right' },
  code: { fontFamily: 'Menlo, Consolas, monospace', fontSize: 'var(--font-size-sm)' },

  footerNav: {
    marginTop: '2.5rem',
    paddingTop: '1.5rem',
    borderTop: '1px solid #dde2eb',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '1.5rem',
    justifyContent: 'center',
  },
  footerLink: { color: '#5b6373', textDecoration: 'none', fontSize: 'var(--font-size-ui)', fontWeight: 500 },

  // ── Takedown chrome (preserved for OFFLINE_FOR_REVIEW=true branch) ───────
  callout: {
    background: '#fef3c7',
    border: '1px solid #fcd34d',
    color: '#3f2a00',
    borderRadius: 10,
    padding: '1.5rem 1.75rem',
    lineHeight: 1.65,
    fontSize: 'var(--font-size-base)',
  },
  calloutP: { margin: '0 0 1rem' },
};
