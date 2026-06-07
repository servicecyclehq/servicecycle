#!/bin/bash
# ----------------------------------------------------------------------------
# v0.91.0 manual deploy -- paste-ready for the DO console
# Target: lapseiq demo droplet (206.189.200.29)
#
# v0.91.0 ships Phase 0 (global a11y + token system + dark-mode locking) and
# Phase 1a + 1b of the /settings IA refactor, plus the Phase 3a/5a/6a fixes
# that were already on the v0.91-phase-0-global-css branch. NO server code
# changes, NO Prisma migrations, NO new in-image artefacts. This script is
# correspondingly slimmer than the v0.36.x family: just build, push, swap.
#
# Cumulative content vs v0.90.9:
#   - Phase 0:  client/src/styles/tokens.css petrol + slate + dark locks;
#               sidebar aria-hidden / color-contrast / link-in-text fixes;
#               new system primitives (FormField, RowCheckbox)
#   - Phase 3a: /dashboard voice fix ("traps" -> "contracts") + day chip
#               "Xd" -> "X days" spell-outs
#   - Phase 5a: /budget 285 unlabelled checkboxes wrapped in RowCheckbox
#   - Phase 6a: /profile input htmlFor + id associations
#   - Phase 1a: /settings two-level chrome (SettingsTabRouter)
#   - Phase 1b: ApiKeysSection + WebhooksSection extracted to focused files
#
# Rollback target after this deploy lands: v0.90.9.
# Run manually:  bash /root/lapseiq-src/scripts/deploy-v0.91.0-do-console.sh
# ----------------------------------------------------------------------------
set -euo pipefail

VERSION="v0.91.0"
VERSION_NUM="0.91.0"
COMPOSE="docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml"
GHCR_OWNER="forgerift"  # post-v0.71.1 org migration

echo "==============================================================="
echo "  ${VERSION} deploy -- v0.91 Phase 0 + 1a + 1b (CI bypass)"
echo "==============================================================="

# --- 1/10 -- Pre-flight assertions -------------------------------------------
echo ""
echo "[1/10] Pre-flight assertions"
docker info >/dev/null
echo "  docker daemon reachable"

FREE_KB=$(df -Pk /var/lib/docker | tail -1 | awk '{print $4}')
FREE_GB=$(( FREE_KB / 1024 / 1024 ))
echo "  /var/lib/docker free: ${FREE_GB} GB"
if [ "${FREE_GB}" -lt 5 ]; then
  echo "Less than 5 GB free under /var/lib/docker. Run 'docker image prune -a -f' then retry."
  exit 1
fi

# --- 2/10 -- Fetch + checkout tag --------------------------------------------
echo ""
echo "[2/10] Fetching ${VERSION} tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
if ! git rev-parse --verify "${VERSION}" >/dev/null 2>&1; then
  echo "Tag ${VERSION} not present on origin. Push the tag from the workstation first."
  exit 1
fi
git checkout "${VERSION}"
echo "  on tag $(git describe --tags --exact-match HEAD)"

cd /root/lapseiq
${COMPOSE} config -q
echo "  docker-compose.ghcr.yml + docker-compose.demo.yml layer cleanly"

# --- 3/10 -- Build server image ----------------------------------------------
echo ""
echo "[3/10] Building lapseiq-server:${VERSION}"
cd /root/lapseiq-src
docker build \
  -t "ghcr.io/${GHCR_OWNER}/lapseiq-server:${VERSION}" \
  -f server/Dockerfile \
  ./server
echo "  server image built"

# --- 4/10 -- Build client SPA (with bundle guards) ---------------------------
echo ""
echo "[4/10] Building client SPA (npm ci + npm run build with VITE_API_URL='')"
cd /root/lapseiq-src/client
npm ci
VITE_API_URL='' npm run build
TOTAL_BYTES=$(find dist/assets -name '*.js' -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')
echo "  client bundle JS total: ${TOTAL_BYTES} bytes"
if [ "${TOTAL_BYTES}" -lt 800000 ]; then
  echo "Bundle too small (${TOTAL_BYTES} bytes) -- broken build, aborting."
  exit 1
fi
if grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/ >/dev/null 2>&1; then
  echo "Bundle contains localhost:3001 leak -- aborting."
  grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/
  exit 1
fi
echo "  client dist built (${TOTAL_BYTES} bytes, no localhost leak)"

# --- 5/10 -- Build client image ----------------------------------------------
echo ""
echo "[5/10] Building lapseiq-client:${VERSION} image"
cd /root/lapseiq-src/client
docker build \
  -t "ghcr.io/${GHCR_OWNER}/lapseiq-client:${VERSION}" \
  -f Dockerfile.prod \
  .
echo "  client image built"

# --- 6/10 -- Push both images to GHCR (rollback chain integrity) -------------
echo ""
echo "[6/10] Pushing locally-built images to GHCR"
PUSH_OK=true
docker push "ghcr.io/${GHCR_OWNER}/lapseiq-server:${VERSION}" || PUSH_OK=false
docker push "ghcr.io/${GHCR_OWNER}/lapseiq-client:${VERSION}" || PUSH_OK=false
if [ "${PUSH_OK}" = "true" ]; then
  echo "  both images pushed; rollback path functional"
else
  echo "  push failed (likely GHCR PAT scope issue)"
  echo "  Deploy continues with --pull never; rollback to ${VERSION} would use local image only"
fi

# --- 7/10 -- Bump compose .env (with rollback target) ------------------------
echo ""
echo "[7/10] Bumping compose .env (with rollback target)"
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

# --- 8/10 -- Prisma migrate deploy (idempotent / no-op for v0.91.0) ----------
echo ""
echo "[8/10] Running Prisma migrate deploy (no v0.91 schema changes; should be no-op)"
MIGRATE_OUT=$(mktemp)
set +e
${COMPOSE} run --rm \
  --no-deps --entrypoint sh server -c 'npx prisma migrate deploy' \
  2>&1 | tee "${MIGRATE_OUT}"
MIGRATE_EC=${PIPESTATUS[0]}
set -e
if grep -qE "(No pending migrations to apply|All migrations have been successfully applied)" "${MIGRATE_OUT}"; then
  echo "  migrations applied (or no-op)"
elif [ "${MIGRATE_EC}" -eq 0 ]; then
  echo "  migrations completed (exit 0)"
else
  echo "prisma migrate deploy failed (exit ${MIGRATE_EC}). Aborting."
  rm -f "${MIGRATE_OUT}"
  exit 1
fi
rm -f "${MIGRATE_OUT}"

# --- 9/10 -- Rolling restart (use locally-built images) ----------------------
echo ""
echo "[9/10] Rolling containers (--pull never)"
${COMPOSE} up -d --pull never --force-recreate --remove-orphans
${COMPOSE} ps

# --- 10/10 -- Smoke test -----------------------------------------------------
echo ""
echo "[10/10] Smoke test -- wait 20s then probe"
sleep 20

echo "  /api/health (jq-parsed status + version):"
curl -sS -o /tmp/health.json -w "    HTTP %{http_code}\n" https://demo.lapseiq.com/api/health
cat /tmp/health.json && echo ""
H_STATUS=$(jq -r '.data.status // empty' /tmp/health.json)
H_VERSION=$(jq -r '.data.version // empty' /tmp/health.json)
if [ "${H_STATUS}" != "ok" ]; then
  echo "    FAIL: /api/health status=${H_STATUS} (expected 'ok')"
  exit 1
fi
if [ "${H_VERSION}" != "${VERSION_NUM}" ]; then
  echo "    FAIL: /api/health version=${H_VERSION} (expected '${VERSION_NUM}')"
  exit 1
fi
echo "    OK: /api/health status=ok version=${H_VERSION}"

echo "  /api/ready (DB connection probe):"
curl -sS -o /tmp/ready.json -w "    HTTP %{http_code}\n" https://demo.lapseiq.com/api/ready
cat /tmp/ready.json && echo ""

echo "  SPA bundle localhost leak check:"
BUNDLE=$(curl -sS https://demo.lapseiq.com/ | grep -oE '/assets/[^"]+\.js' | head -1)
echo "    bundle: ${BUNDLE}"
if [ -n "${BUNDLE}" ]; then
  LEAK=$(curl -sS "https://demo.lapseiq.com${BUNDLE}" | grep -c 'http://localhost:3001' || true)
  if [ "${LEAK}" -gt 0 ]; then
    echo "    FAIL: found ${LEAK} occurrences of localhost:3001 -- bundle is broken"
    exit 1
  else
    echo "    OK: no localhost:3001 leak"
  fi
fi

echo ""
echo "==============================================================="
echo "  ${VERSION} deploy complete"
echo "==============================================================="
echo ""
echo "Headline:"
echo "  - /settings has two-level chrome (Workspace / Integrations / Security)"
echo "  - /budget 285 unlabelled checkboxes now have sr-only labels"
echo "  - /dashboard 'traps' / 'Xd' wording cleaned up"
echo "  - /profile password inputs labelled"
echo "  - Global token system + slate neutrals (light + dark) locked"
echo ""
echo "Rollback (if anything misbehaves):"
echo "  sed -i 's|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${CURRENT}|' /root/lapseiq/.env"
echo "  ${COMPOSE} up -d --force-recreate"
