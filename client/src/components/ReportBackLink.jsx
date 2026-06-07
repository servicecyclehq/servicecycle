import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

// #5: canonical "back to the Reports hub" affordance. Every report renders
// this so the back link is identical everywhere -- it mirrors the original
// Renewal Horizon pattern (left arrow + "Reports"). The arrow is a lucide
// icon, never a raw glyph byte.
export default function ReportBackLink({ style }) {
  return (
    <Link
      to="/reports"
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
    >
      <ArrowLeft size={14} strokeWidth={2} /> Reports
    </Link>
  );
}
