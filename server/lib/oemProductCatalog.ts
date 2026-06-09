/**
 * oemProductCatalog.ts — obsolete model-series → replacement recommendations.
 *
 * Used by modernizationAlerts.ts to populate QuoteRequest body text when an
 * asset's modernizationRiskScore crosses the 0.70 threshold.
 *
 * Entries are keyed by a substring match against Asset.model (case-insensitive).
 * The replacement text is plain English for field reps + facility managers.
 *
 * Backlog: wire via outbound webhook/API to OEM CRMs (Brightlayer, EcoStruxure,
 * ABB Ability, Xcelerator) once the webhook layer is extended (see schema.prisma
 * modernizationRiskScore backlog note). Don't bury these strings — they belong
 * in the asset record and should be queryable.
 */

export interface CatalogEntry {
  modelPattern: RegExp;        // matches against asset.model (case-insensitive)
  assetClasses: string[];      // EquipmentType values this applies to (empty = any)
  description:  string;        // obsolete series name for display
  replacement:  string;        // recommended replacement product/path
  oemNote:      string;        // OEM program / part-number clue for the quote
}

export const OEM_PRODUCT_CATALOG: CatalogEntry[] = [
  // Eaton Cutler-Hammer
  {
    modelPattern: /\b(ds|dsii|dsr|dsrr|type\s*ds)\b/i,
    assetClasses: ['CIRCUIT_BREAKER'],
    description:  'Eaton DS/DSR/DSII series power air circuit breaker',
    replacement:  'Eaton Magnum DS or PowerDefense retrofit kit',
    oemNote:      'Eaton Retrofit Solutions catalog form # 4BRO19 — mechanical retrofit keeps existing cubicle, replaces only the interrupter module.',
  },
  // Square D / Schneider
  {
    modelPattern: /\b(la\s*48|lc\s*48|lair|la\s*36)\b/i,
    assetClasses: ['CIRCUIT_BREAKER'],
    description:  'Square D LA/LC 48/36 series obsolete MCCB',
    replacement:  'Schneider Electric QO or PowerPact H/J/L series',
    oemNote:      'Schneider obsolescence bulletin SQD-2019-008. Direct replacements available through distribution; cubicle adapters may be required for panel mounting.',
  },
  // GE PowerVac
  {
    modelPattern: /\b(powervac|power\s*vac|pvac)\b/i,
    assetClasses: ['SWITCHGEAR_MV', 'CIRCUIT_BREAKER'],
    description:  'GE PowerVac vacuum switchgear / breaker',
    replacement:  'ABB VD4 or Eaton VCP-W vacuum circuit breaker',
    oemNote:      'GE Prolec-GE and Vernova no longer support PowerVac. ABB VD4 is a dimension-compatible drop-in for 15 kV class. Request factory application engineering review.',
  },
  // ABB K-Series
  {
    modelPattern: /\bk\s*series|k\s*line|type\s*k\b/i,
    assetClasses: ['PROTECTION_RELAY'],
    description:  'ABB K-series electromechanical overcurrent relay',
    replacement:  'SEL-751 or ABB REF615 feeder protection relay',
    oemNote:      'Relay replacement must be followed by coordination study update (NFPA 70E §205.4; insurer expectation). Allow 60-day lead for SEL factory delivery.',
  },
  // Westinghouse Type DS
  {
    modelPattern: /\b(type\s*ds|buss|bussmann\s*ds)\b/i,
    assetClasses: ['SWITCHGEAR'],
    description:  'Westinghouse Type DS metal-clad switchgear (pre-1985)',
    replacement:  'Eaton VacClad-W or Schneider GM-SG class switchgear',
    oemNote:      'Westinghouse switchgear pre-1985 uses asbestos arc chute material — hazmat survey required before any internal work. Budget for asbestos abatement in replacement cost.',
  },
  // Schweitzer (electromechanical relay era)
  {
    modelPattern: /\bsel[\s-]?(5|7|9)\d{1,2}[^0-9]/i,
    assetClasses: ['PROTECTION_RELAY'],
    description:  'SEL legacy relay (SEL-5xx / 7xx / 9xx series)',
    replacement:  'SEL-451, SEL-751, or SEL-351 current-generation relay',
    oemNote:      'SEL end-of-support varies by model. Check SEL product lifecycle page or contact SEL Field Application Engineer. Migration tool available for settings conversion.',
  },
  // GE IAC relay series (electromechanical)
  {
    modelPattern: /\b(iac\s*51|iac\s*53|iac\s*77|iac\s*66)\b/i,
    assetClasses: ['PROTECTION_RELAY'],
    description:  'GE IAC electromechanical induction relay',
    replacement:  'Beckwith M-3425A or SEL-751 microprocessor relay',
    oemNote:      'GE IAC series has been out of manufacture since 2001. Calibration parts are no longer available through official channels. Replacement budgeted at $2,000–$6,000 per device installed.',
  },
  // Liquid-filled transformers — PCB contamination flag
  {
    modelPattern: /\b(pcb|askarel|inerteen|pyranol|aroclor)\b/i,
    assetClasses: ['TRANSFORMER_LIQUID'],
    description:  'PCB/Askarel-filled transformer (pre-1979 manufacture)',
    replacement:  'Modern FR3/MIDEL ester or dry-type transformer',
    oemNote:      'EPA 40 CFR Part 761 requires PCB transformers in or near buildings to be retrofilled or removed. EPA registered disposal required. Budget significantly above standard transformer replacement — include remediation, registration, and manifesting costs.',
  },
  // Allis-Chalmers/McGraw-Edison
  {
    modelPattern: /\b(allis[\s-]chalmers|mcgraw[\s-]edison|al[\s-]ch)\b/i,
    assetClasses: ['TRANSFORMER_LIQUID', 'SWITCHGEAR'],
    description:  'Allis-Chalmers / McGraw-Edison electrical equipment',
    replacement:  'Modern equivalent — consult OEM application engineering',
    oemNote:      'Allis-Chalmers electrical division acquired by Siemens (1984); McGraw-Edison by Cooper (1985), then Eaton (2012). Parts support through Eaton legacy parts program or third-party rebuilders.',
  },
  // GE AKR / AK series air circuit breaker
  {
    modelPattern: /\b(akr[\s-]?\d|ak[\s-]?\d|type\s*ak)\b/i,
    assetClasses: ['CIRCUIT_BREAKER'],
    description:  'GE AK/AKR series air circuit breaker',
    replacement:  'ABB SACE Emax2 or GE EntelliGuard G retrofit',
    oemNote:      'GE AKR series: end of parts support approximately 2020. GE EntelliGuard retrofit kit available for many frame sizes through GE Vernova distribution — verify frame dimensions before quoting.',
  },
];

/**
 * Look up catalog entry for an asset by model string.
 * Returns the first matching entry, or null.
 */
export function lookupCatalogEntry(
  modelStr: string | null | undefined,
  equipmentType?: string,
): CatalogEntry | null {
  if (!modelStr) return null;
  for (const entry of OEM_PRODUCT_CATALOG) {
    if (!entry.modelPattern.test(modelStr)) continue;
    if (entry.assetClasses.length > 0 && equipmentType) {
      // Normalize: CIRCUIT_BREAKER matches breaker_lv_mccb / breaker_lv_power / breaker_mv_vacuum
      const typeUpper = equipmentType.toUpperCase();
      const classMatch = entry.assetClasses.some((c) => typeUpper.includes(c.replace('_', '')));
      if (!classMatch) continue;
    }
    return entry;
  }
  return null;
}
