# Dependency Vulnerability Scan Evidence

Weekly Trivy filesystem/dependency scan of the ServiceCycle repo (npm + pip lockfiles),
run against the live checkout on the ServiceCycle droplet. SOC2/diligence evidence artifact
— shows an ongoing, dated record of dependency vulnerability posture, not a one-time claim.

**Method:** `docker run -v /root/ServiceCycle:/scan aquasec/trivy fs --scanners vuln
--severity HIGH,CRITICAL --format json /scan`, filtered to HIGH/CRITICAL only. Covers
`client/package-lock.json`, `server/package-lock.json`, and `server/pyextract/requirements.txt`.
Raw JSON output is kept on the droplet only (not committed — can run 15K+ lines); this table
is the durable summary. A weekly scheduled task (`servicecycle-weekly-dep-scan`) re-runs the
scan and appends a row here automatically.

**Note on scope:** this is dependency/software-composition scanning, not a full OS-image
vulnerability scan of the running container. Trivy's image-scan mode needs the Docker socket
mounted into the scanner container, which the VPS control MCP hard-blocks (any volume source
outside `/root/ServiceCycle` is refused, by design — a real guardrail, not a workaround
target). Base-OS patching is covered instead by the `node:20-slim` (Debian) base image being
rebuilt on every deploy, which pulls current upstream package versions.

## Scan log

| Date | Commit | HIGH | CRITICAL | Notes |
|------|--------|------|----------|-------|
| 2026-07-07 | `521f812` | 0 | 0 | Clean baseline. First run. |
| 2026-07-12 | `1d99c9b` | 0 | 0 | Clean — 0 HIGH/CRITICAL. |
| 2026-07-19 | TBD | 0 | 0 | Clean scan — 0 HIGH/CRITICAL findings. |
