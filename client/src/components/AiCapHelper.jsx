/**
 * AiCapHelper — small inline helper line shown under any AI input box
 * in DEMO_MODE only. v0.32.4.
 *
 * Renders one of two states:
 *
 *   1. Calls remaining: "Demo: 2 of 3 daily AI extractions remaining.
 *      Self-host to remove caps →"
 *
 *   2. Calls exhausted: "You've used today's demo AI extractions. Resets
 *      at midnight UTC. Self-host to keep going →"
 *
 * Always renders the install link to https://lapseiq.com/install.
 *
 * Props:
 *   action   — 'extract' | 'ask' | 'brief' | 'brief_search'
 *   label    — short human label for the action ("AI extractions",
 *              "Ask LapseIQ questions", "brief generations", ...)
 *
 * In self-host mode (demoMode=false from useAuth), this component returns
 * null — there's no cap to disclose.
 */

import { useAiUsage } from '../hooks/useAiUsage';
import { useAuth } from '../context/AuthContext';

const INSTALL_URL = 'https://lapseiq.com/install';

export default function AiCapHelper({ action, label, scope = 'the demo' }) {
  const { demoMode } = useAuth();
  const { usage, loading } = useAiUsage();

  // No-op on self-host. Also no-op while the initial fetch is in flight —
  // we'd rather show nothing for 200ms than flash an incorrect number.
  if (!demoMode || loading) return null;
  if (!usage?.actions?.[action]) return null;

  const a = usage.actions[action];
  if (a.cap === null) return null; // self-host shape (Infinity)

  const remaining = Math.max(0, a.cap - a.count);
  const exhausted = remaining <= 0;

  return (
    <p
      role="note"
      style={{
        margin:     '6px 0 0',
        fontSize: 'var(--font-size-sm)',
        lineHeight: 1.5,
        color:      exhausted ? 'var(--color-danger, #b91c1c)' : 'var(--color-text-secondary, #5b6373)',
      }}
    >
      {exhausted
        ? <>You've used today's demo {label}. Resets at midnight UTC. </>
        : <>Demo: <strong>{remaining} of {a.cap}</strong> {label} left today, from one daily cap shared across {scope}. </>}
      <a
        href={INSTALL_URL}
        target="_blank"
        rel="noopener noreferrer"
        style={{
          color: 'var(--color-primary, #0d4f6e)',
          textDecoration: 'underline',
          fontWeight: 600,
        }}
      >
        {exhausted ? 'Self-host to keep going →' : 'Self-host to remove caps →'}
      </a>
    </p>
  );
}
