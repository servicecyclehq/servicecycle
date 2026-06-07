#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# v0.33.0 manual deploy — paste-ready for the DigitalOcean web console
# Target: lapseiq demo droplet (206.189.200.29)
#
# CI is hard-blocked by billing → images NOT on GHCR yet.
# Solution: build images on the droplet, then compose up with --pull never
# so docker compose uses the locally-built images.
#
# After this block runs cleanly, demo.lapseiq.com is on v0.33.0.
#
# Generated 2026-05-17 — Pass-5 Tier 1 deploy.
# ─────────────────────────────────────────────────────────────────────────────
set -e

echo "═══════════════════════════════════════════════════════════"
echo "  v0.33.0 deploy — building on droplet (CI bypass)"
echo "═══════════════════════════════════════════════════════════"

echo ""
echo "▶ [1/7] Fetching v0.33.0 tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
git checkout v0.33.0
echo "  ✓ on tag $(git describe --tags --exact-match HEAD)"

echo ""
echo "▶ [2/7] Building lapseiq-server:v0.33.0"
docker build \
  -t ghcr.io/claudedussy/lapseiq-server:v0.33.0 \
  -f server/Dockerfile \
  ./server
echo "  ✓ server image built"

echo ""
echo "▶ [3/7] Building client SPA (npm ci + npm run build with VITE_API_URL='')"
cd /root/lapseiq-src/client
npm ci
VITE_API_URL='' npm run build
# Guard: same as manual-ghcr-push.ps1 — fail if bundle is too small OR contains localhost:3001
TOTAL_BYTES=$(find dist/assets -name '*.js' -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')
echo "  client bundle JS total: $TOTAL_BYTES bytes"
if [ "$TOTAL_BYTES" -lt 800000 ]; then
  echo "❌ Bundle too small ($TOTAL_BYTES bytes) — broken build, aborting."
  exit 1
fi
if grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/ >/dev/null 2>&1; then
  echo "❌ Bundle contains localhost:3001 leak — aborting."
  grep -r --include='*.js' -l 'http://localhost:3001' dist/assets/
  exit 1
fi
echo "  ✓ client dist built ($TOTAL_BYTES bytes, no localhost leak)"

echo ""
echo "▶ [4/7] Building lapseiq-client:v0.33.0 image"
docker build \
  -t ghcr.io/claudedussy/lapseiq-client:v0.33.0 \
  -f Dockerfile.prod \
  .
echo "  ✓ client image built"

echo ""
echo "▶ [5/7] Bumping compose .env (with rollback target)"
cd /root/lapseiq
CURRENT=$(grep -E '^LAPSEIQ_VERSION=' .env | head -1 | cut -d= -f2-)
echo "  current LAPSEIQ_VERSION=$CURRENT"
# Record rollback target
if grep -q '^LAPSEIQ_VERSION_PREV=' .env; then
  sed -i "s|^LAPSEIQ_VERSION_PREV=.*|LAPSEIQ_VERSION_PREV=$CURRENT|" .env
else
  echo "LAPSEIQ_VERSION_PREV=$CURRENT" >> .env
fi
# Bump to v0.33.0
sed -i 's|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=v0.33.0|' .env
echo "  ✓ LAPSEIQ_VERSION=v0.33.0   LAPSEIQ_VERSION_PREV=$CURRENT"

echo ""
echo "▶ [6/7] Rolling containers (--pull never — use locally-built images)"
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml up -d \
  --pull never \
  --force-recreate \
  --remove-orphans
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml ps

echo ""
echo "▶ [7/7] Smoke test — wait 25s then probe"
sleep 25
echo "  • /api/health:"
curl -sS -o /tmp/health.json -w "    HTTP %{http_code}\n" https://demo.lapseiq.com/api/health
cat /tmp/health.json && echo ""
echo "  • SPA bundle localhost leak check:"
BUNDLE=$(curl -sS https://demo.lapseiq.com/ | grep -oE '/assets/[^"]+\.js' | head -1)
echo "    bundle: $BUNDLE"
if [ -n "$BUNDLE" ]; then
  LEAK=$(curl -sS "https://demo.lapseiq.com$BUNDLE" | grep -c 'http://localhost:3001' || true)
  if [ "$LEAK" -gt 0 ]; then
    echo "    ❌ FOUND $LEAK occurrences of localhost:3001 — bundle is broken"
  else
    echo "    ✓ no localhost:3001 leak"
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  v0.33.0 deploy complete"
echo "═══════════════════════════════════════════════════════════"
