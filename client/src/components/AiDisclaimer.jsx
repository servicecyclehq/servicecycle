import React from 'react';

/**
 * AiDisclaimer
 * ------------
 * One reusable AI-output disclaimer rendered in three contexts (the
 * three keys in VARIANTS below — keep this list in sync with that map):
 *
 *   - extract          : ingest / extracted-field review (IngestReview)
 *                        and the signature-extract review surface.
 *                        Amber tone — the AI is parsing arbitrary
 *                        user-supplied PDFs / text where hallucination
 *                        is a real risk.
 *   - maintenanceBrief : AI maintenance recommendation + NFPA compliance
 *                        summary (MaintenanceBriefCard). Strong amber
 *                        tone — the output sits adjacent to electrical
 *                        safety decisions, so the copy is explicit that
 *                        it is not an engineering determination.
 *   - ask              : Ask ServiceCycle Q&A modal. Slate (info) tone —
 *                        this surface is grounded in the curated
 *                        ServiceCycle product guide (RAG-lite over an
 *                        internal knowledge base, not free-form AI on
 *                        user content), so a strong amber warning would
 *                        overstate the risk and make the help system
 *                        look unreliable. Note still names AI as the
 *                        generator and points to the docs as the
 *                        authoritative source of truth.
 *
 * Centralized so wording stays consistent and reviewable in one
 * place. Each variant carries its own tone so callers don't need
 * to know the visual treatment. An unknown `variant` falls back to
 * `extract` (the most conservative amber warning).
 */

const TONES = {
  // Amber — caution. For AI output on arbitrary user content where
  // misread / hallucination has a real consequence.
  amber: {
    background: 'var(--color-warning-bg)',
    border: '1px solid #fde68a',
    iconColor: 'var(--color-warning)',
    bodyColor: 'var(--color-warning)',
  },
  // Slate — informational. For grounded-AI surfaces where a warning
  // tone would undercut trust unnecessarily.
  slate: {
    background: 'var(--color-bg)',
    border: '1px solid #dde2eb',
    iconColor: 'var(--color-text-secondary)',
    bodyColor: 'var(--color-text-secondary)',
  },
};

const VARIANTS = {
  extract: {
    text: 'AI can make mistakes — please verify each field before approving.',
    tone: 'amber',
  },
  maintenanceBrief: {
    // AI maintenance recommendation + NFPA compliance summary. Strong
    // amber framing: this output sits adjacent to electrical safety
    // decisions, so the disclaimer must be unambiguous that it is not
    // an engineering determination. Standard references are restricted
    // server-side to refs present in the asset's own task definitions,
    // but the interpretation is still model-generated.
    text: 'AI-generated summary based on this asset’s recorded data only. It is not an engineering assessment — verify recommendations against the cited standards and consult a qualified electrical engineer or NETA-certified contractor before acting on them.',
    tone: 'amber',
  },
  ask: {
    text: 'Answers come from the ServiceCycle product guide — AI-generated. Refer to the docs if anything looks off.',
    tone: 'slate',
  },
};

export default function AiDisclaimer({ variant = 'extract', compact = false, style: extraStyle }) {
  const v = VARIANTS[variant] || VARIANTS.extract;
  const t = TONES[v.tone] || TONES.amber;
  const padding = compact ? '6px 10px' : '10px 14px';
  const fontSize = compact ? 11.5 : 12.5;
  return (
    <div
      role="note"
      aria-label="AI output disclaimer"
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding,
        background: t.background,
        border: t.border,
        borderRadius: 8,
        fontSize,
        lineHeight: 1.5,
        color: t.bodyColor,
        ...(extraStyle || {}),
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        style={{ width: 14, height: 14, color: t.iconColor, flexShrink: 0, marginTop: 2 }}
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      <span>{v.text}</span>
    </div>
  );
}
