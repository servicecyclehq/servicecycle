#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# v0.34.0 manual deploy — paste-ready for the DigitalOcean web console
# Target: lapseiq demo droplet (206.189.200.29)
#
# Same build-on-droplet pattern as v0.33.0 since CI is still billing-blocked.
# Tag v0.34.0 covers Pass-5 F-SH-02 (install.sh/install.ps1 HTTPS-before-TLS)
# and Tier 3 perf (multer cap 25MB, four take(1000) findMany caps, Prisma
# connection_limit). No new GHCR images expected — built locally on droplet
# and used via `docker compose up --pull never`.
#
# Generated 2026-05-17 — Pass-5 Tier 2 + Tier 3 deploy.
# ─────────────────────────────────────────────────────────────────────────────
set -e

VERSION="v0.34.0"

echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy — building on droplet (CI bypass)"
echo "═══════════════════════════════════════════════════════════"

echo ""
echo "▶ [1/8] Fetching ${VERSION} tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
git checkout "${VERSION}"
echo "  ✓ on tag $(git describe --tags --exact-match HEAD)"

echo ""
echo "▶ [2/8] Building lapseiq-server:${VERSION}"
docker build \
  -t "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -f server/Dockerfile \
  ./server
echo "  ✓ server image built"

echo ""
echo "▶ [3/8] Building client SPA (npm ci + npm run build with VITE_API_URL='')"
cd /root/lapseiq-src/client
npm ci
VITE_API_URL='' npm run build
# Guard: same as scripts/manual-ghcr-push.ps1 — fail if bundle is too small
# OR if any chunk contains http://localhost:3001 (the regression that shipped
# in v0.32.0 and forced the v0.32.1 hotfix).
TOTAL_BYTES=$(find dist/assets -name '*.js' -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')
echo "  client bundle JS total: ${TOTAL_BYTES} bytes"
if [ "${TOTAL_BYTES}" -lt 800000 ]; then
  echo "❌ Bundle too small (${TOTAL_BYTES} bytes) — broken build, aborting."
  exit 1
fi
if grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/ >/dev/null 2>&1; then
  echo "❌ Bundle contains localhost:3001 leak — aborting."
  grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/
  exit 1
fi
echo "  ✓ client dist built (${TOTAL_BYTES} bytes, no localhost leak)"

echo ""
echo "▶ [4/8] Building lapseiq-client:${VERSION} image"
docker build \
  -t "ghcr.io/claudedussy/lapseiq-client:${VERSION}" \
  -f Dockerfile.prod \
  .
echo "  ✓ client image built"

echo ""
echo "▶ [5/8] Bumping compose .env (with rollback target)"
cd /root/lapseiq
CURRENT=$(grep -E '^LAPSEIQ_VERSION=' .env | head -1 | cut -d= -f2-)
echo "  current LAPSEIQ_VERSION=${CURRENT}"
# Record rollback target
if grep -q '^LAPSEIQ_VERSION_PREV=' .env; then
  sed -i "s|^LAPSEIQ_VERSION_PREV=.*|LAPSEIQ_VERSION_PREV=${CURRENT}|" .env
else
  echo "LAPSEIQ_VERSION_PREV=${CURRENT}" >> .env
fi
# Bump to new version
sed -i "s|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${VERSION}|" .env
echo "  ✓ LAPSEIQ_VERSION=${VERSION}   LAPSEIQ_VERSION_PREV=${CURRENT}"

echo ""
echo "▶ [6/8] Applying Pass-5 Tier 3 DATABASE_URL pool tuning (if DATABASE_URL is explicit in .env)"
# Pass-5 Agent 3 wants ?connection_limit=10&pool_timeout=30 appended.
# On the demo droplet, docker-compose builds DATABASE_URL from POSTGRES_*
# envs by default; if an explicit DATABASE_URL line is present in .env,
# patch it. Otherwise no-op (the compose-built URL on a single replica
# is fine without explicit limits at current demo scale).
if grep -qE '^DATABASE_URL=' .env; then
  if grep -qE '^DATABASE_URL=.*connection_limit=' .env; then
    echo "  ✓ DATABASE_URL already has connection_limit — no change"
  else
    # Append query params, handling either a URL with no query or one
    # that already has a "?something=..." section.
    sed -i -E 's|^(DATABASE_URL=[^?[:space:]]*)$|\1?connection_limit=10\&pool_timeout=30|' .env
    sed -i -E 's|^(DATABASE_URL=[^?[:space:]]*\?[^[:space:]]*)$|\1\&connection_limit=10\&pool_timeout=30|' .env
    echo "  ✓ DATABASE_URL patched"
  fi
else
  echo "  - no explicit DATABASE_URL in .env (compose builds it from POSTGRES_*) — skipping"
fi

echo ""
echo "▶ [7/9] Rolling containers (--pull never — use locally-built images)"
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml up -d \
  --pull never \
  --force-recreate \
  --remove-orphans
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml ps

echo ""
echo "▶ [8/9] Sync install artefacts to apex (lapseiq.com static root)"
# Apex and demo run on the same droplet (memory: reference_lapseiq_apex_hosting).
# /var/www/lapseiq/ is the Caddy file_server root for lapseiq.com — when
# install.sh or install.ps1 changes in a release, the static-served copy
# at https://lapseiq.com/install.sh has to be refreshed too. Otherwise
# operators curl-piping the installer get the previous version. Regenerate
# the integrity .sha256 files at the same time so the
# `sha256sum -c install.sh.sha256` integrity workflow stays accurate.
if [ -d /var/www/lapseiq ]; then
  cp /root/lapseiq-src/scripts/install.sh  /var/www/lapseiq/install.sh
  cp /root/lapseiq-src/scripts/install.ps1 /var/www/lapseiq/install.ps1
  ( cd /var/www/lapseiq \
    && sha256sum install.sh  > install.sh.sha256 \
    && sha256sum install.ps1 > install.ps1.sha256 )
  ls -la /var/www/lapseiq/install.*
  echo "  ✓ apex install artefacts synced from ${VERSION}"
else
  echo "  - /var/www/lapseiq absent on this host — skipping (apex hosted elsewhere)"
fi

echo ""
echo "▶ [9/9] Smoke test — wait 25s then probe"
sleep 25
echo "  • /api/health:"
curl -sS -o /tmp/health.json -w "    HTTP %{http_code}\n" https://demo.lapseiq.com/api/health
cat /tmp/health.json && echo ""
echo "  • SPA bundle localhost leak check:"
BUNDLE=$(curl -sS https://demo.lapseiq.com/ | grep -oE '/assets/[^"]+\.js' | head -1)
echo "    bundle: ${BUNDLE}"
if [ -n "${BUNDLE}" ]; then
  LEAK=$(curl -sS "https://demo.lapseiq.com${BUNDLE}" | grep -c 'http://localhost:3001' || true)
  if [ "${LEAK}" -gt 0 ]; then
    echo "    ❌ FOUND ${LEAK} occurrences of localhost:3001 — bundle is broken"
  else
    echo "    ✓ no localhost:3001 leak"
  fi
fi
echo "  • Apex install.sh F-SH-02 marker:"
if curl -sS https://lapseiq.com/install.sh | grep -q 'Two more steps before the public URL is reachable'; then
  echo "    ✓ apex serving v0.34.0 install.sh"
else
  echo "    ⚠️  apex install.sh still pre-v0.34.0 — check /var/www/lapseiq/ sync"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy complete"
echo "═══════════════════════════════════════════════════════════"
