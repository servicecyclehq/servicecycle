// ProvenanceBadge — shows a document's trust status (where it came from / how
// authoritative it is). Conservative by default: unverified reads as cautionary.
// Used on the asset card, the field view, and the document library so the
// "made-up vs stamped" distinction is visible, not buried in a disclaimer.

const META = {
  pe_sealed:  { label: 'PE-SEALED',  fg: 'var(--color-success)', bg: 'var(--color-success-bg)' },
  engineered: { label: 'Engineered', fg: 'var(--color-info)',    bg: 'var(--color-info-bg)' },
  vendor:     { label: 'Vendor',     fg: 'var(--color-text-secondary)', bg: 'var(--color-section-bg)' },
  as_built:   { label: 'As-built',   fg: 'var(--color-warning)', bg: 'var(--color-warning-bg)' },
  unverified: { label: 'Unverified', fg: 'var(--color-danger)',  bg: 'var(--color-danger-bg)' },
};

// Order for dropdowns: most cautionary first, authoritative last.
export const PROVENANCE_OPTIONS = [
  { value: 'unverified', label: 'Unverified (default)' },
  { value: 'as_built',   label: 'As-built / field sketch' },
  { value: 'vendor',     label: 'Vendor / OEM supplied' },
  { value: 'engineered', label: 'Engineered (unsealed)' },
  { value: 'pe_sealed',  label: 'PE-sealed (stamped)' },
];

export default function ProvenanceBadge({ value, big = false }) {
  const m = META[value] || META.unverified;
  return (
    <span
      title={value === 'pe_sealed'
        ? 'A licensed PE seal is on file (manager-attested).'
        : 'Not a PE-sealed document — verify before relying on it for switching/LOTO.'}
      style={{
        display: 'inline-block', padding: big ? '2px 9px' : '1px 7px', borderRadius: 999,
        fontSize: big ? 'var(--font-size-sm)' : 'var(--font-size-xs)', fontWeight: 700,
        color: m.fg, background: m.bg, whiteSpace: 'nowrap',
      }}
    >
      {m.label}
    </span>
  );
}
