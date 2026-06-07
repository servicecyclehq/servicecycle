#!/bin/bash
# ----------------------------------------------------------------------------
# v0.92.37 manual deploy -- paste-ready for the DO console
# Target: lapseiq demo droplet (206.189.200.29)
#
# v0.92.37 ships the 2026-06-02 pre-launch security pass. SERVER code changes,
# one trivial CLIENT change, NO Prisma migrations, NO new in-image artefacts.
#
# Cumulative content vs v0.92.36:
#   - SSRF: webhook delivery now pins the TCP connection to the pre-validated
#           IP (https.request + pinned lookup + SNI) -- closes the DNS-rebinding
#           TOCTOU.                                              [server]
#   - AI LLM07: system-prompt-leak output guard centralized in
#           lib/aiOutputGuard and applied in lib/ai complete(), covering Ask,
#           renewal briefs, report narration, personas, extractors.  [server]
#   - Demo: demoGuard Rule 8 blocks outbound webhook creation/modification/test
#           in DEMO_MODE (GET still allowed).                     [server]
#   - a11y: sidebar "Search contracts" input gets an aria-label.  [client]
#   - Dev-only (no runtime effect): Jest esbuild TS transform so the security
#           test suite runs (0 -> 30 passing); findings.csv F004 marked resolved.
#
# Rollback target after this deploy lands: v0.92.36.
# Run:  paste this whole script into the DO web console (root shell) and Enter.
#       (It self-fetches the v0.92.37 tag, builds, pushes, swaps, smoke-tests.)
# ----------------------------------------------------------------------------
set -euo pipefail

VERSION="v0.92.37"
VERSION_NUM="0.92.37"
PREV="v0.92.36"
COMPOSE="docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml"
GHCR_OWNER="forgerift"

echo "==============================================================="
echo "  ${VERSION} deploy -- pre-launch security pass (CI bypass)"
echo "==============================================================="

# --- 1/10 -- Pre-flight assertions -------------------------------------------
echo ""; echo "[1/10] Pre-flight assertions"
docker info >/dev/null && echo "  docker daemon reachable"
echo "  memory + swap:"; free -h | sed 's/^/    /'
FREE_KB=$(df -Pk /var/lib/docker | tail -1 | awk '{print $4}')
FREE_GB=$(( FREE_KB / 1024 / 1024 ))
echo "  /var/lib/docker free: ${FREE_GB} GB"
if [ "${FREE_GB}" -lt 5 ]; then
  echo "Less than 5 GB free under /var/lib/docker. Run 'docker image prune -a -f' then retry."; exit 1
fi

# --- 2/10 -- Fetch + checkout tag --------------------------------------------
echo ""; echo "[2/10] Fetching ${VERSION} tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
if ! git rev-parse --verify "${VERSION}" >/dev/null 2>&1; then
  echo "Tag ${VERSION} not present on origin. Push the tag from the workstation first."; exit 1
fi
git checkout "${VERSION}"
echo "  on tag $(git describe --tags --exact-match HEAD)"
cd /root/lapseiq
${COMPOSE} config -q && echo "  compose files layer cleanly"

# --- 3/10 -- Build server image ----------------------------------------------
echo ""; echo "[3/10] Building lapseiq-server:${VERSION}"
cd /root/lapseiq-src
docker build -t "ghcr.io/${GHCR_OWNER}/lapseiq-server:${VERSION}" -f server/Dockerfile ./server
echo "  server image built"

# --- 4/10 -- Build client SPA (with bundle guards) ---------------------------
echo ""; echo "[4/10] Building client SPA (npm ci + npm run build, VITE_API_URL='')"
cd /root/lapseiq-src/client
npm ci
VITE_API_URL='' npm run build
TOTAL_BYTES=$(find dist/assets -name '*.js' -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')
echo "  client bundle JS total: ${TOTAL_BYTES} bytes"
if [ "${TOTAL_BYTES}" -lt 800000 ]; then
  echo "Bundle too small (${TOTAL_BYTES} bytes) -- broken build, aborting."; exit 1
fi
if grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/ >/dev/null 2>&1; then
  echo "Bundle contains localhost:3001 leak -- aborting."; exit 1
fi
echo "  client dist built (${TOTAL_BYTES} bytes, no localhost leak)"

# --- 5/10 -- Build client image ----------------------------------------------
echo ""; echo "[5/10] Building lapseiq-client:${VERSION} image"
cd /root/lapseiq-src/client
docker build -t "ghcr.io/${GHCR_OWNER}/lapseiq-client:${VERSION}" -f Dockerfile.prod .
echo "  client image built"

# --- 6/10 -- Push both images to GHCR (rollback chain integrity) -------------
echo ""; echo "[6/10] Pushing locally-built images to GHCR"
PUSH_OK=true
docker push "ghcr.io/${GHCR_OWNER}/lapseiq-server:${VERSION}" || PUSH_OK=false
docker push "ghcr.io/${GHCR_OWNER}/lapseiq-client:${VERSION}" || PUSH_OK=false
[ "${PUSH_OK}" = "true" ] && echo "  both images pushed; rollback path functional" \
  || echo "  push failed (likely GHCR PAT scope) -- deploy continues with --pull never"

# --- 7/10 -- Bump compose .env (with rollback target) ------------------------
echo ""; echo "[7/10] Bumping compose .env (with rollback target)"
cd /root/lapseiq
CURRENT=$(grep -E '^LAPSEIQ_VERSION=' .env | head -1 | cut -d= -f2-)
echo "  current LAPSEIQ_VERSION=${CURRENT}"
if grep -q '^LAPSEIQ_VERSION_PREV=' .env; then
  sed -i "s|^LAPSEIQ_VERSION_PREV=.*|LAPSEIQ_VERSION_PREV=${CURRENT}|" .env
else
  echo "LAPSEIQ_VERSION_PREV=${CURRENT}" >> .env
fi
sed -i "s|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${VERSION}|" .env
echo "  LAPSEIQ_VERSION=${VERSION}   LAPSEIQ_VERSION_PREV=${CURRENT}"

# --- 8/10 -- Prisma migrate deploy (no schema changes in v0.92.37; no-op) -----
echo ""; echo "[8/10] Prisma migrate deploy (expected no-op)"
MIGRATE_OUT=$(mktemp); set +e
${COMPOSE} run --rm --no-deps --entrypoint sh server -c 'npx prisma migrate deploy' 2>&1 | tee "${MIGRATE_OUT}"
MIGRATE_EC=${PIPESTATUS[0]}; set -e
if grep -qE "(No pending migrations to apply|All migrations have been successfully applied)" "${MIGRATE_OUT}"; then
  echo "  migrations applied (or no-op)"
elif [ "${MIGRATE_EC}" -eq 0 ]; then echo "  migrations completed (exit 0)"
else echo "prisma migrate deploy failed (exit ${MIGRATE_EC}). Aborting."; rm -f "${MIGRATE_OUT}"; exit 1; fi
rm -f "${MIGRATE_OUT}"

# --- 9/10 -- Rolling restart (use locally-built images) ----------------------
echo ""; echo "[9/10] Rolling containers (--pull never)"
${COMPOSE} up -d --pull never --force-recreate --remove-orphans
${COMPOSE} ps

# --- 10/10 -- Smoke test -----------------------------------------------------
echo ""; echo "[10/10] Smoke test -- wait 20s then probe"
sleep 20
curl -sS -o /tmp/health.json -w "    /api/health HTTP %{http_code}\n" https://demo.lapseiq.com/api/health
cat /tmp/health.json && echo ""
H_STATUS=$(jq -r '.data.status // empty' /tmp/health.json)
H_VERSION=$(jq -r '.data.version // empty' /tmp/health.json)
[ "${H_STATUS}" = "ok" ] || { echo "    FAIL: status=${H_STATUS} (expected ok)"; exit 1; }
[ "${H_VERSION}" = "${VERSION_NUM}" ] || { echo "    FAIL: version=${H_VERSION} (expected ${VERSION_NUM})"; exit 1; }
echo "    OK: /api/health status=ok version=${H_VERSION}"
curl -sS -o /tmp/ready.json -w "    /api/ready HTTP %{http_code}\n" https://demo.lapseiq.com/api/ready; cat /tmp/ready.json && echo ""

# --- Post-deploy verification of THIS release's fixes ------------------------
echo ""; echo "[verify] webhook-creation lockdown live in demo (expect 403):"
curl -sS -o /dev/null -w "    POST /api/webhooks -> HTTP %{http_code} (want 401/403, NOT 201)\n" \
  -X POST -H 'Content-Type: application/json' --data '{"url":"https://example.com/x"}' \
  https://demo.lapseiq.com/api/webhooks || true

echo ""
echo "==============================================================="
echo "  ${VERSION} deploy complete -- pre-launch security pass live"
echo "==============================================================="
echo ""
echo "Rollback (if anything misbehaves):"
echo "  cd /root/lapseiq"
echo "  sed -i 's|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${PREV}|' .env"
echo "  ${COMPOSE} up -d --force-recreate"
