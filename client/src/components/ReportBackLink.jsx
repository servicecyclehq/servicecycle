import BackLink from './BackLink';

// #5: canonical "back to the Reports hub" affordance. Every report renders
// this so the back link is identical everywhere. C1 (2026-06-11): now a thin
// wrapper over <BackLink>, so reports return to the actual previous page
// (dashboard drill-down, another report, …) and only fall back to /reports
// on deep links. The arrow is a lucide icon, never a raw glyph byte.
export default function ReportBackLink({ style }) {
  return (
    <BackLink
      fallback="/reports"
      fallbackLabel="Reports"
      style={{
        fontSize: 'var(--font-size-sm)',
        color: 'var(--color-text-secondary)',
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        marginBottom: 4,
        ...style,
      }}
    />
  );
}
