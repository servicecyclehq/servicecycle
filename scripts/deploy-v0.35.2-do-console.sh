#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# v0.35.1 manual deploy — paste-ready for the DigitalOcean web console
# Target: lapseiq demo droplet (206.189.200.29)
#
# Same build-on-droplet pattern as v0.33.0/v0.34.0/v0.35.0 since CI is still
# billing-blocked.
#
# Tag v0.35.2 is a fast-follow hotfix on top of v0.35.1:
#   - fix(compose): docker-compose.ghcr.yml environment block now
#     passes CF_WORKERS_AI_*, HF_TOKEN, GROQ_API_KEY, AI_BUDGET_*,
#     and the per-action AI quota vars through to the server container.
#     v0.35.1 had the vars in /root/lapseiq/.env but the compose
#     whitelist filtered them out, so the cloudflare adapter saw an
#     empty CF_WORKERS_AI_ACCOUNT_ID and threw on every Ask LapseIQ
#     call.
#
# (Original v0.35.1 fix lives at HEAD~1 and is also in this tag:)
#   - fix(startup): server/index.js env validator now accepts
#     CF_WORKERS_AI_API_KEY (and other provider-specific keys like
#     OPENAI_API_KEY, GEMINI_API_KEY, AZURE_OPENAI_API_KEY) as
#     satisfying the AI-key gate. The legacy gate only knew about
#     AI_API_KEY + ANTHROPIC_API_KEY, which crash-looped the server
#     during the v0.35.0 deploy when AI_PROVIDER=cloudflare was set
#     with only CF_WORKERS_AI_API_KEY (no legacy AI_API_KEY).
#
# After this deploy succeeds, operator MAY remove the placeholder
# 'AI_API_KEY=placeholder-...' line from /root/lapseiq/.env that was
# added as the v0.35.0 workaround. Optional cleanup; harmless if left.
#
# All other v0.35.0 deliverables (legal markdown synthesis, LegalDocPage
# flip, Register unpause, D1 Cloudflare Workers AI + cascade + budget
# guard) carry forward unchanged.
#
# Generated 2026-05-17.
# ─────────────────────────────────────────────────────────────────────────────
set -e

VERSION="v0.35.2"

echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy — building on droplet (CI bypass)"
echo "═══════════════════════════════════════════════════════════"

echo ""
echo "▶ [1/10] Fetching ${VERSION} tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
git checkout "${VERSION}"
echo "  ✓ on tag $(git describe --tags --exact-match HEAD)"

echo ""
echo "▶ [2/10] Building lapseiq-server:${VERSION}"
docker build \
  -t "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -f server/Dockerfile \
  ./server
echo "  ✓ server image built"

echo ""
echo "▶ [3/10] Building client SPA (npm ci + npm run build with VITE_API_URL='')"
cd /root/lapseiq-src/client
npm ci
VITE_API_URL='' npm run build
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
echo "▶ [4/10] Building lapseiq-client:${VERSION} image"
docker build \
  -t "ghcr.io/claudedussy/lapseiq-client:${VERSION}" \
  -f Dockerfile.prod \
  .
echo "  ✓ client image built"

echo ""
echo "▶ [5/10] Bumping compose .env (with rollback target)"
cd /root/lapseiq
CURRENT=$(grep -E '^LAPSEIQ_VERSION=' .env | head -1 | cut -d= -f2-)
echo "  current LAPSEIQ_VERSION=${CURRENT}"
if grep -q '^LAPSEIQ_VERSION_PREV=' .env; then
  sed -i "s|^LAPSEIQ_VERSION_PREV=.*|LAPSEIQ_VERSION_PREV=${CURRENT}|" .env
else
  echo "LAPSEIQ_VERSION_PREV=${CURRENT}" >> .env
fi
sed -i "s|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${VERSION}|" .env
echo "  ✓ LAPSEIQ_VERSION=${VERSION}   LAPSEIQ_VERSION_PREV=${CURRENT}"

echo ""
echo "▶ [6/10] Cloudflare Workers AI env vars (verify operator state)"
if grep -qE '^AI_PROVIDER=cloudflare' /root/lapseiq/.env; then
  echo "  ✓ AI_PROVIDER=cloudflare is set"
else
  echo "  ⚠️  AI_PROVIDER=cloudflare is NOT set"
fi
if grep -qE '^CF_WORKERS_AI_API_KEY=' /root/lapseiq/.env; then
  echo "  ✓ CF_WORKERS_AI_API_KEY is set (startup gate accepts this in v0.35.1)"
else
  echo "  ⚠️  CF_WORKERS_AI_API_KEY missing — server startup will fail v0.35.1 env gate"
fi

echo ""
echo "▶ [7/10] Applying Pass-5 Tier 3 DATABASE_URL pool tuning (if DATABASE_URL is explicit in .env)"
if grep -qE '^DATABASE_URL=' .env; then
  if grep -qE '^DATABASE_URL=.*connection_limit=' .env; then
    echo "  ✓ DATABASE_URL already has connection_limit — no change"
  else
    sed -i -E 's|^(DATABASE_URL=[^?[:space:]]*)$|\1?connection_limit=10\&pool_timeout=30|' .env
    sed -i -E 's|^(DATABASE_URL=[^?[:space:]]*\?[^[:space:]]*)$|\1\&connection_limit=10\&pool_timeout=30|' .env
    echo "  ✓ DATABASE_URL patched"
  fi
else
  echo "  - no explicit DATABASE_URL in .env (compose builds it from POSTGRES_*) — skipping"
fi

echo ""
echo "▶ [8/10] Rolling containers (--pull never — use locally-built images)"
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml up -d \
  --pull never \
  --force-recreate \
  --remove-orphans
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml ps

echo ""
echo "▶ [9/10] Sync install artefacts + marketing landing to apex"
if [ -d /var/www/lapseiq ]; then
  cp /root/lapseiq-src/scripts/install.sh  /var/www/lapseiq/install.sh
  cp /root/lapseiq-src/scripts/install.ps1 /var/www/lapseiq/install.ps1
  cp /root/lapseiq-src/marketing-site/index.html /var/www/lapseiq/index.html
  ( cd /var/www/lapseiq \
    && sha256sum install.sh  > install.sh.sha256 \
    && sha256sum install.ps1 > install.ps1.sha256 )
  ls -la /var/www/lapseiq/install.* /var/www/lapseiq/index.html
  echo "  ✓ apex install artefacts + marketing landing synced from ${VERSION}"
else
  echo "  - /var/www/lapseiq absent on this host — skipping (apex hosted elsewhere)"
fi

echo ""
echo "▶ [10/10] Smoke test — wait 25s then probe"
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
echo "  • /legal/privacy reachable (SPA shell returns 200):"
PRIVACY_CODE=$(curl -sS -o /dev/null -w "%{http_code}" https://demo.lapseiq.com/legal/privacy)
if [ "${PRIVACY_CODE}" = "200" ]; then
  echo "    ✓ /legal/privacy HTTP ${PRIVACY_CODE}"
else
  echo "    ❌ /legal/privacy HTTP ${PRIVACY_CODE}"
fi
echo "  • Apex install.sh F-SH-02 marker:"
if curl -sS https://lapseiq.com/install.sh | grep -q 'Two more steps before the public URL is reachable'; then
  echo "    ✓ apex serving install.sh with F-SH-02 guidance"
else
  echo "    ⚠️  apex install.sh missing F-SH-02 marker — check /var/www/lapseiq/ sync"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy complete"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "NOTE: You can now safely remove the 'AI_API_KEY=placeholder-...' line"
echo "      from /root/lapseiq/.env if you added it as a v0.35.0 workaround."
echo "      It's a no-op when AI_PROVIDER=cloudflare; cleanup is optional."
