import { useState, useId } from 'react';

/**
 * InfoTip — tap/hover/focus accessible tooltip.
 * Replaces <abbr title="...">(?)</abbr> which does not work on touch devices.
 * T3-N2 (Pass-6 accessibility audit).
 *
 * Usage:
 *   <InfoTip content="Explanatory text shown on hover/focus/tap." />
 */
export function InfoTip({ content }) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  return (
    <span className="infotip" style={{ position: 'relative', display: 'inline-block' }}>
      <span
        className="infotip-trigger"
        tabIndex={0}
        role="button"
        aria-label="More information"
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(v => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(v => !v); } }}
        style={{ cursor: 'help', fontSize: '0.8em', marginLeft: 2, userSelect: 'none' }}
      >(?)</span>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          style={{
            position: 'absolute',
            bottom: '130%',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--color-bg-elevated, #fff)',
            border: '1px solid var(--color-border, #ddd)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: '0.85rem',
            lineHeight: 1.4,
            whiteSpace: 'normal',
            width: 240,
            boxShadow: '0 2px 8px rgba(0,0,0,0.18)',
            zIndex: 9999,
            color: 'var(--color-text, #222)',
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
}

export default InfoTip;