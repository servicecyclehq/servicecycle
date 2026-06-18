# ServiceCycle Server SBOM

Source: `docs/security/scans/2026-05-03/sbom-server.{cdx,spdx}.json`
Synced via `npm run sbom:sync` on 2026-05-03T13:50:18.323Z.

CycloneDX (cyclonedx.json) is the primary format; SPDX (spdx.json)
is provided for ecosystems that prefer it. Both list every direct +
transitive Node dependency the runtime image carries.

To regenerate, run `syft scan dir:server` from the repo root and
check the new files into the next `docs/security/scans/<date>/`.
