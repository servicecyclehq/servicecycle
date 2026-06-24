# AFX — Arc Flash Data Exchange

**Version 1.0** · Open specification · Maintained by ServiceCycle

AFX is an open, versioned schema for moving **arc-flash study inputs and label
outputs** between tools — study software (ETAP, EasyPower, SKM PTW), data-collection
forms (ARCAD), CMMS/EAM systems, and spreadsheets. It is anchored on the
**IEEE 1584-2018** input set and the **NFPA 70E §130.5(H)** label output set, not on
any single vendor's file quirks.

The goal is boring on purpose: one documented column vocabulary, exact-string keys,
and a conformance check, so a file can be trusted before anyone relies on it.

> **Scope / disclaimer.** AFX carries *collected inputs* and *captured label
> outputs*. It does **not** imply the exporting system ran or stamped the IEEE 1584
> study. A licensed Professional Engineer owns the calculation and the label. AFX is
> a data-interchange format, not a calculation engine or a safety authority.

---

## 1. Two forms

AFX has two interchange forms. They share the same field vocabulary and units.

| Form | Shape | Use |
|------|-------|-----|
| **Flat** | One CSV/JSON, one row per bus, all fields as columns | Quick handoff, spreadsheets, label data, round-tripping PE results |
| **Multi-table** | Related tables (Buses / Cables / Transformers / Devices) keyed by string IDs | Feeds tools that ingest topology (ETAP DataX, EasyPower, SKM) |

Both forms are versioned together under the same `afxVersion`.

---

## 2. Versioning

- `afxVersion` is `MAJOR.MINOR` (currently `1.0`).
- **MINOR** bumps add optional fields or tolerated value aliases — backward compatible.
- **MAJOR** bumps may rename or remove fields, or change required-field rules.
- A conforming reader MUST ignore unknown columns (forward compatibility) and MUST
  NOT fail on optional fields being absent.

---

## 3. Flat form — field catalog

One row per bus. `Bus` and `Nominal Voltage (V)` are the only required fields (the
minimum to identify a usable bus row); everything else is optional. Types:
`string | number | enum | json`. Units are fixed and SI/imperial as noted — values
are **not** unit-tagged in the cell, the column defines the unit.

### Identity
| Column | Key | Type | Required |
|--------|-----|------|----------|
| Site | `site` | string | no |
| **Bus** | `busName` | string | **yes** |
| Equipment Type | `equipmentType` | string | no |

### IEEE 1584-2018 inputs
| Column | Key | Type | Unit |
|--------|-----|------|------|
| **Nominal Voltage (V)** | `nominalVoltageV` | number | V (**required**) |
| Bolted Fault (kA) | `boltedFaultCurrentKA` | number | kA |
| Arcing Current (kA) | `arcingCurrentKA` | number | kA |
| Electrode Config | `electrodeConfig` | enum | `VCB, VCBB, HCB, VOA, HOA` |
| Gap (mm) | `conductorGapMm` | number | mm |
| Working Distance (in) | `workingDistanceIn` | number | in |
| Clearing Time (ms) | `clearingTimeMs` | number | ms |
| Enclosure | `enclosureType` | enum | `panelboard, mcc, lv_switchgear, mv_switchgear, cable, open_air, other` |

### Upstream protective device (drives clearing time via its TCC)
| Column | Key | Type |
|--------|-----|------|
| Upstream Device | `deviceType` | enum `breaker, fuse, relay, switch` |
| Trip Unit | `tripUnitType` | enum `none, thermal_magnetic, electronic_lsi, electronic_lsig` |
| Fuse Class | `fuseClass` | enum `L, RK1, RK5, J, T, CC, G, CF, H, K, other` |
| Device Mfr | `deviceManufacturer` | string |
| Device Model | `deviceModel` | string |
| Device Rating (A) | `deviceRatingA` | number (A) |
| Trip Settings (JSON) | `deviceSettings` | json |

### Feeder cable / conduit
| Column | Key | Type |
|--------|-----|------|
| Cable Length (ft) | `cableLengthFt` | number (ft) |
| Cable Size | `cableSize` | string |
| Cable Material | `cableMaterial` | enum `Cu, Al` |
| Conductors / Phase | `conductorsPerPhase` | number |
| Conduit | `conduitType` | string |

### Utility / transformer source model
| Column | Key | Type | Unit |
|--------|-----|------|------|
| Utility Max Fault (kA) | `utilityMaxFaultKA` | number | kA |
| Utility Min Fault (kA) | `utilityMinFaultKA` | number | kA |
| Utility X/R | `utilityXr` | number | — |
| Transformer (kVA) | `transformerKva` | number | kVA |
| Transformer %Z | `transformerImpedancePct` | number | % |
| Transformer Primary (V) | `transformerPrimaryV` | number | V |
| Transformer Secondary (V) | `transformerSecondaryV` | number | V |

### NFPA 70E §130.5(H) label outputs (captured, not computed by SC)
| Column | Key | Type | Unit |
|--------|-----|------|------|
| Incident Energy (cal/cm2) | `incidentEnergyCalCm2` | number | cal/cm² |
| Arc Flash Boundary (in) | `arcFlashBoundaryIn` | number | in |
| PPE Category | `ppeCategory` | number | — |
| Required Arc Rating (cal/cm2) | `requiredArcRatingCalCm2` | number | cal/cm² |

### Tolerated value aliases
On import, readers SHOULD accept documented vendor spellings of a canonical value.
v1.0 ships one: `electrodeConfig` `VCCB` → `VCBB` (ARCAD's spelling of the standard
IEEE 1584 vertical-conductors-in-a-box-barrier configuration).

---

## 4. Multi-table form

Tools that reconstruct topology don't want one fat row — they want related tables
where branches reference buses by an **exact string ID**. AFX multi-table is four
tabs:

- **Buses** — `BusID`, `Nominal Voltage (V)`, `Equipment Type`, plus captured
  `Incident Energy (cal/cm2)` / `Label Severity`.
- **Cables** — `CableID`, `From Bus`, `To Bus`, `Length (ft)`, `Size`, `Material`,
  `Conductors/Phase`.
- **Transformers** — `XfmrID`, `From Bus`, `To Bus`, `Rating (kVA)`, `Primary (V)`,
  `Secondary (V)`, `%Z`.
- **Devices** — `DeviceID`, `Protects Bus`, `Type`, `Mfr`, `Model`, `Rating (A)`,
  `Settings (JSON)`.

### ID rules (the part everyone gets wrong)
Connectivity is matched on **exact string equality**. A trailing space or a casing
difference silently drops the link with no error in most tools. AFX therefore
requires:

1. IDs are **trimmed**, internal whitespace **collapsed to `_`**, and characters
   outside `[A-Za-z0-9_-]` **stripped**.
2. IDs are **unique within their table**. Collisions get a numeric suffix.
3. `From Bus` / `To Bus` / `Protects Bus` MUST exactly equal a `BusID` in the Buses
   tab. A blank reference is allowed (unknown topology); a non-blank reference that
   doesn't resolve is an **error**.

---

## 5. Conformance

A file is **AFX-conforming** if:

- **Flat:** required columns present (`Bus`, `Nominal Voltage (V)`); enum values are
  in-range (after alias resolution); numeric fields parse as numbers.
- **Multi-table:** no duplicate IDs within a table; every non-blank `From/To/Protects`
  reference resolves to a `BusID`.

ServiceCycle ships a validator that returns **errors** (will break an import) and
**warnings** (e.g. whitespace/case drift where a reference *looks* matched but isn't
byte-equal, with a "did you mean" suggestion). The export round-trips losslessly
through the validator.

---

## 6. Per-tool crosswalk

AFX is the hub; each tool is a spoke. ServiceCycle publishes per-tool templates that
map AFX columns to a tool's header names. AFX/EasyPower/SKM mappings are grounded in
real vendor files; the ETAP mapping is a **draft** until verified against a live
`File > Export > ETAP DataX` CSV. Units may differ (e.g. ETAP carries voltage in kV);
the multi-table exporter converts where the mapping documents it.

---

## 7. Getting AFX

- **In ServiceCycle:** the arc-flash fleet page exports AFX (flat CSV and multi-table
  XLSX), serves the machine-readable spec at `GET /api/arc-flash/afx/spec`, and
  validates uploads against it.
- **This document** is the human-readable companion to that machine spec; both move
  together with `afxVersion`.

AFX is open. Implement it, extend it under the versioning rules, and exchange data
without lock-in.
