/**
 * BriefSection — typed render of one section of an AI renewal brief.
 *
 * Phase 4 — v0.4.0. Renders the section title + body, then embeds the
 * BriefFeedbackWidget for per-section thumbs+comment. The widget is
 * gated by `showFeedback` so the cached-but-not-yet-saved state can
 * suppress it while waiting for the brief row to persist.
 *
 * v0.36.3 — extended SECTION_LABELS with the five opt-in renewal-brief
 * section keys so ContractDetail.jsx can render them through the same
 * component path as the always-on four. Opt-in sections currently pass
 * showFeedback={false} from the caller (per-section thumbs aren't wired
 * up for opt-ins yet — separate scope).
 *
 * v0.37.2 W6 MT-156 — added an `isOptIn` prop so opt-in sections render
 * with a subtle visual marker (left-border accent + "Optional" tag +
 * fainter heading weight). Closes Pass-3 E's "opt-in BriefSections look
 * identical to always-on — operators don't know which they configured"
 * finding. Default false; ContractDetail.jsx flips it true for the five
 * opt-in keys.
 *
 * Body is rendered with `whiteSpace: pre-wrap` so the LLM's paragraph
 * breaks are preserved. React's default escaping covers XSS — no
 * markdown / HTML render path. (If/when we want rendered markdown
 * inline, do it via a sanitising library AND review the AI consent +
 * prompt-injection threat model.)
 */

import BriefFeedbackWidget from './BriefFeedbackWidget';

const SECTION_LABELS = {
  // Always-on (v0.4.0): the four sections every brief carries.
  situation:               'Situation',
  market:                  'Market',
  tactics:                 'Tactics',
  watchFor:                'Watch For',
  // Opt-in (v0.36.x): admin-toggleable in Settings -> AI -> Renewal Brief
  // Sections. Keys mirror SECTIONS_BY_SLUG[].key in
  // server/lib/aiBrief/optInSections.js; labels mirror SECTIONS[].header.
  // Keep these in sync with the server catalog when adding new sections.
  recommendedStrategy:     'Recommended Strategy',
  licenseUtilization:      'License Utilization',
  cotermOpportunities:     'Co-Term Opportunities',
  quoteRequestHygiene:     'Quote-Request Hygiene',
  internalStakeholderMap:  'Internal Stakeholder Map',
};

// v0.37.2 W6 MT-156: keys for which the BriefSection is opt-in (admin
// has toggled it on in Settings). Used by ContractDetail.jsx to set
// isOptIn={OPT_IN_SECTION_KEYS.has(key)} when fanning out sections.
// Single source of truth so future opt-in additions only have to update
// this set + server/lib/aiBrief/optInSections.js.
export const OPT_IN_SECTION_KEYS = new Set([
  'recommendedStrategy',
  'licenseUtilization',
  'cotermOpportunities',
  'quoteRequestHygiene',
  'internalStakeholderMap',
]);

export default function BriefSection({
  sectionKey,
  body,
  contractId,
  categorySlug,
  templateVersion,
  showFeedback = true,
  isOptIn = false,
}) {
  const title = SECTION_LABELS[sectionKey] || sectionKey;
  const isEmpty = !body || body.trim().length === 0;

  // v0.37.2 W6 MT-156: opt-in styling — left-border accent + slightly
  // muted heading colour + "Optional" inline tag. Subtle on purpose; we
  // want the operator to notice the difference without it shouting.
  // sr-only span carries the same "Optional section" hint for screen
  // readers (the visual tag is decorative).
  const wrapperStyle = {
    marginBottom:  '1.4rem',
    paddingBottom: '1.2rem',
    borderBottom:  '1px solid var(--color-border, #eaeaea)',
    ...(isOptIn ? {
      paddingLeft:    '0.85rem',
      borderLeft:     '3px solid var(--color-border-strong, #cbd5e1)',
      marginLeft:     '-0.85rem', // null the indent so opt-in + always-on left-align
    } : {}),
  };
  const titleStyle = {
    fontSize:      '0.95rem',
    fontWeight:    isOptIn ? 600 : 700,
    margin:        '0 0 0.4rem',
    color:         isOptIn ? 'var(--text-secondary, #475569)' : 'var(--text-primary, #111)',
    letterSpacing: '0.01em',
    display:       'flex',
    alignItems:    'baseline',
    gap:           8,
  };

  return (
    <div style={wrapperStyle}>
      <h4 style={titleStyle}>
        <span>{title}</span>
        {isOptIn && (
          <>
            <span
              aria-hidden="true"
              style={{
                fontSize: 'var(--font-size-2xs)',
                fontWeight:   600,
                color:        'var(--text-secondary, #64748b)',
                background:   'var(--color-surface-alt, #f1f5f9)',
                border:       '1px solid var(--color-border, #e2e8f0)',
                borderRadius: 4,
                padding:      '1px 6px',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Optional
            </span>
            <span className="sr-only">(optional section, enabled in account settings)</span>
          </>
        )}
      </h4>
      <div
        style={{
          whiteSpace: 'pre-wrap',
          fontSize:   '0.92rem',
          lineHeight: 1.55,
          color:      'var(--text-primary, #222)',
        }}
      >
        {isEmpty ? (
          <span style={{ color: 'var(--text-secondary, #888)', fontStyle: 'italic' }}>
            (this section was empty in the model's response - try regenerating)
          </span>
        ) : (
          body
        )}
      </div>

      {showFeedback && !isEmpty && contractId && categorySlug && templateVersion && (
        <BriefFeedbackWidget
          contractId={contractId}
          categorySlug={categorySlug}
          templateVersion={templateVersion}
          section={sectionKey}
        />
      )}
    </div>
  );
}
