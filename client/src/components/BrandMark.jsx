// ─────────────────────────────────────────────────────────────────────────────
// BrandMark.jsx — the canonical ServiceCycle brand mark.
//
// ONE geometry at every size (Dustin's standardization request — do NOT add
// size variants). Ring + two terminals + gradient "service arc". Only colors
// change between variants; geometry is identical everywhere:
//
//   viewBox 0 0 64 64
//   ring       circle cx32 cy32 r26, stroke-width 4
//   terminals  circles at (12,32) and (52,32), r 4.4
//   arc        M14 32 L22 25 L28 34 L35 24 L42 34 L50 32, stroke-width 4.6,
//              round caps/joins, horizontal gradient stroke
//
// variant 'dark'  → onDark colors (dark sidebars / dark backgrounds)
// variant 'light' → onLight colors (light backgrounds)
//
// Gradient ids are namespaced per variant (scmark-dark / scmark-light) so
// multiple simultaneous mounts (sidebar + modal, etc.) never collide.
// ─────────────────────────────────────────────────────────────────────────────

const COLORS = {
  dark: {
    ring:      '#94a3b8',
    terminals: '#cbd5e1',
    arcFrom:   '#60a5fa',
    arcTo:     '#a3e635',
  },
  light: {
    ring:      '#475569',
    terminals: '#334155',
    arcFrom:   '#2563eb',
    arcTo:     '#65a30d',
  },
};

// ── Wordmark (Mod A, Dustin 2026-06-07) ──────────────────────────────────────
// "Service" + "ycle" in solid ink; ONLY the "C" carries the brand green
// (echoes the arc's lime endpoint). No gradients in the name — solid ink
// survives grayscale printers, which matters because this wordmark lands on
// compliance PDFs handed to auditors. Ink flips near-white on dark, the
// green stays green.
const WORDMARK_COLORS = {
  dark:  { ink: '#f8fafc', c: '#a3e635' },
  light: { ink: '#111827', c: '#65a30d' },
};

export function BrandWordmark({ variant = 'dark', fontSize, style }) {
  const v = variant === 'light' ? 'light' : 'dark';
  const w = WORDMARK_COLORS[v];
  return (
    <span
      style={{
        fontWeight: 750,
        letterSpacing: '-0.03em',
        whiteSpace: 'nowrap',
        color: w.ink,
        ...(fontSize ? { fontSize } : {}),
        ...(style || {}),
      }}
    >
      Service<span style={{ color: w.c }}>C</span>ycle
    </span>
  );
}

export default function BrandMark({ size = 24, variant = 'dark' }) {
  const v = variant === 'light' ? 'light' : 'dark';
  const c = COLORS[v];
  const gradId = `scmark-${v}`;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={c.arcFrom} />
          <stop offset="1" stopColor={c.arcTo} />
        </linearGradient>
      </defs>
      <circle cx="32" cy="32" r="26" fill="none" stroke={c.ring} strokeWidth="4" />
      <circle cx="12" cy="32" r="4.4" fill={c.terminals} />
      <circle cx="52" cy="32" r="4.4" fill={c.terminals} />
      <path
        d="M14 32 L22 25 L28 34 L35 24 L42 34 L50 32"
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth="4.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
