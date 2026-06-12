/**
 * partnerBranding.ts — #15 co-branded customer artifacts.
 *
 * Resolves the contractor (PartnerOrganization) brand for an account so the
 * customer-facing PDFs (leave-behind, EMP, compliance, label sheets) can carry
 * "Prepared by {Contractor} · powered by ServiceCycle" plus the partner's
 * accent color. Returns null for direct (non-channel) accounts, in which case
 * callers fall back to the plain ServiceCycle styling.
 */

import prisma from './prisma';

export interface PartnerBranding {
  name: string;
  primaryColor: string | null; // validated #rrggbb or null
  logoUrl: string | null;
}

/** A 6-digit hex color, or null if missing/malformed (so pdfkit never throws). */
function safeHex(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = String(v).trim();
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : null;
}

/**
 * The co-brand line every artifact shares. With a partner:
 *   "Prepared by Acme Electrical · powered by ServiceCycle"
 * Without one: "Prepared by ServiceCycle".
 */
export function coBrandLine(branding: PartnerBranding | null | undefined): string {
  return branding?.name ? `Prepared by ${branding.name} · powered by ServiceCycle` : 'Prepared by ServiceCycle';
}

export async function getAccountBranding(accountId: string): Promise<PartnerBranding | null> {
  try {
    const acct = await prisma.account.findUnique({
      where:  { id: accountId },
      select: { partnerOrg: { select: { name: true, primaryColor: true, logoUrl: true } } },
    });
    const p: any = acct?.partnerOrg;
    if (!p || !p.name) return null;
    return { name: p.name, primaryColor: safeHex(p.primaryColor), logoUrl: p.logoUrl || null };
  } catch {
    return null; // branding is cosmetic — never block artifact generation
  }
}
