// ─────────────────────────────────────────────────────────────────────────────
// glossary.js — central source for the in-app InfoTips (the click-to-open
// circled-i tips). One entry per term; the <Tip> component looks them up by key
// and renders them, gated on the user's "show info tips" preference.
//
// WHAT GETS A TIP — the judgment call (kept deliberately lean):
//
//   We do NOT tip the governing standards or terms a working electrical-
//   maintenance professional already knows cold, OR that already have a
//   dedicated plain-language home elsewhere in the app:
//     • NFPA 70B / 70E / 110, NETA MTS/ATS, IEEE 1584 / C57.104 / 43,
//       OSHA Subpart S  → explained in full at /reports/standards-library
//       (the Standards Library page). Tipping them inline would duplicate it.
//     • arc flash, PPE category, incident energy, LOTO, DGA, megohm/IR  →
//       standard field vocabulary for this audience; a tip adds noise, not value.
//
//   We DO tip the terms ServiceCycle COINS or COMPUTES — the numbers and labels
//   a user cannot look up in any standard because they are this product's own
//   roll-ups. These remove real guesswork:
//     • compliance %, maturity score, maintenance debt, priority score,
//       Remaining Useful Life (RUL), revenue attribution.
//   Plus a few inline PILL-GROUP legends where the same coined/condition codes
//   appear as colored chips with no caption (condition ratings, arc-flash
//   label severity).
//
// Underdo over overdo: if a term is borderline, leave it out. New entries are
// cheap to add later — the component reads this file, no code change needed.
//
// Entry shape:
//   { title, body }                       — a plain explanatory tip
//   { title, items: [{ label, meaning }] } — a legend for a group of pills/chips
// ─────────────────────────────────────────────────────────────────────────────

export const GLOSSARY = {
  // ── Computed / coined metrics ────────────────────────────────────────────
  compliancePercent: {
    title: 'Compliance %',
    body:
      "The share of this account's required maintenance tasks that are current — " +
      'completed within their due window. It is a rolling figure: tasks slipping ' +
      'past due pull it down, completed work pushes it up. This is ServiceCycle’s ' +
      'roll-up of your own task records, not an official or certified rating.',
  },
  maturityScore: {
    title: 'Maturity score',
    body:
      'A 0–100 read on how complete and disciplined your maintenance program is — ' +
      'how much equipment is covered, how current the records are, and whether ' +
      'asset conditions are being assessed. Use it to track progress over time. ' +
      'It is a self-assessment ServiceCycle computes, not an industry-certified score.',
  },
  maintenanceDebt: {
    title: 'Maintenance debt',
    body:
      'The estimated cost to catch up everything that is overdue — your backlog ' +
      'expressed in dollars, summed from each asset’s repair estimate. A planning ' +
      'figure to size the gap, not an invoice or a quote.',
  },
  priorityScore: {
    title: 'Priority score',
    body:
      'A ranking ServiceCycle computes to help you decide what to tackle first. ' +
      'It weighs how overdue the work is, the equipment’s assessed condition, and ' +
      'how critical the asset is. Higher means more urgent.',
  },
  rul: {
    title: 'Remaining Useful Life (RUL)',
    body:
      'ServiceCycle’s estimate of how long an asset is likely to keep performing ' +
      'before it needs replacement, drawn from its age, condition trend, and test ' +
      'history. It is a planning estimate to guide repair-vs-replace decisions — ' +
      'not a guaranteed date.',
  },
  revenueAttribution: {
    title: 'Revenue attribution',
    body:
      'Dollars ServiceCycle can trace from a finding to booked work — a deficiency ' +
      'or quote that became a scheduled or completed work order. It is pulled from ' +
      'your own rate cards and repair estimates; nothing here is typed in by hand.',
  },

  // ── Pill-group legends ───────────────────────────────────────────────────
  conditionRating: {
    title: 'Condition ratings',
    body:
      'NFPA 70B condition ratings set how often each asset is maintained. ' +
      'ServiceCycle assigns them from your inspection and test results.',
    items: [
      { label: 'C1 — Good', meaning: 'Acceptable condition — maintain on the normal interval.' },
      { label: 'C2 — Fair', meaning: 'Showing wear — inspect on a tighter interval.' },
      { label: 'C3 — Poor', meaning: 'Deficient — corrective action needed now.' },
    ],
  },
  arcFlashSeverity: {
    title: 'Arc-flash label severity',
    body:
      'Severity comes from the asset’s IEEE 1584 incident-energy study — it is ' +
      'calculated, not entered by hand.',
    items: [
      { label: 'DANGER', meaning: 'Incident energy or required PPE is above the safe working threshold — treat as de-energize / justify energized work.' },
      { label: 'WARNING', meaning: 'Energized work is permitted with the PPE stated on the label.' },
      { label: 'CAUTION', meaning: 'Lower-energy bus — observe the labeled PPE and boundaries.' },
    ],
  },
};

export default GLOSSARY;
