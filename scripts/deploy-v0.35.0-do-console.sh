#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# v0.35.0 manual deploy — paste-ready for the DigitalOcean web console
# Target: lapseiq demo droplet (206.189.200.29)
#
# Same build-on-droplet pattern as v0.33.0 + v0.34.0 since CI is still
# billing-blocked. Tag v0.35.0 covers:
#   - 6-agent legal review synthesis applied to 7 legal markdown drafts
#     (privacy / sub-processors / demo-sandbox-notice / eula / terms /
#     dpa-template / tia-us-transfers)
#   - LegalDocPage.jsx OFFLINE_FOR_REVIEW flipped to false; markdown
#     rendering (ReactMarkdown + remark-gfm + mdComponents) restored.
#     All /legal/* routes now render the (DRAFT-banner-tagged) markdown
#     drafts.
#   - Register.jsx REGISTRATION_PAUSED_FOR_LEGAL_REVIEW flipped to false.
#   - D1: Cloudflare Workers AI primary + HuggingFace + Groq fallbacks +
#     $25/mo budget guard in server/lib/aiBudgetGuard.js
#   - (D3 country gate + D6 acceptedEulaVersion enforcement deferred to
#     v0.35.1 fast-follow; not part of this tag.)
#
# Sessions B + C (Tier 4 observability + Tier 5/6 docs cleanup) ride along
# in this same deploy — their commits are already on origin/main.
#
# Generated 2026-05-17 — Pass-5 Tier 2 closure (F-SH-01 + F-SH-03).
# ─────────────────────────────────────────────────────────────────────────────
set -e

VERSION="v0.35.0"

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
echo "▶ [6/10] D1 — Cloudflare Workers AI env vars (operator action required)"
# v0.35.0 swaps demo from Gemini free tier (audit blocker) to Cloudflare
# Workers AI as the primary AI provider. The CF API account ID + token
# must be present in /root/lapseiq/.env for the demo to call CF Workers AI.
# Operator action: add these lines to .env BEFORE running this script:
#   AI_PROVIDER=cloudflare
#   CF_WORKERS_AI_ACCOUNT_ID=<your-cf-account-id>
#   CF_WORKERS_AI_API_KEY=<your-cf-api-token-with-workers-ai-read+edit>
#   HF_TOKEN=<your-huggingface-token>      (fallback for chat/news)
#   GROQ_API_KEY=<your-groq-api-key>       (secondary fallback)
#   AI_BUDGET_MONTHLY_USD=25
#   AI_BUDGET_ALERT_PCT=75
#   AI_BUDGET_HARDSTOP_PCT=90
# If these are missing the demo will hard-fail AI features with a clean
# "Demo AI temporarily unavailable" message rather than try the old
# Gemini provider.
if grep -qE '^AI_PROVIDER=cloudflare' /root/lapseiq/.env; then
  echo "  ✓ AI_PROVIDER=cloudflare is set"
else
  echo "  ⚠️  AI_PROVIDER=cloudflare is NOT set — AI features will hard-fail until operator updates .env"
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
# Apex and demo run on the same droplet. /var/www/lapseiq/ is the Caddy
# file_server root for lapseiq.com. v0.35.0 doesn't change install.sh or
# install.ps1 from v0.34.0 (they were updated in v0.34.0 for F-SH-02),
# but the marketing-site index.html was updated by Session C to remove
# the dead /privacy + /terms footer links — sync that too.
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
echo "  • /legal/privacy renders the live draft (not the takedown notice):"
PRIVACY_HEAD=$(curl -sS https://demo.lapseiq.com/legal/privacy | grep -oE 'This policy is temporarily offline|LapseIQ Privacy Policy|Privacy Policy' | head -1)
if [ "${PRIVACY_HEAD}" = "This policy is temporarily offline" ]; then
  echo "    ❌ /legal/privacy still shows takedown notice — OFFLINE_FOR_REVIEW flip failed"
else
  echo "    ✓ /legal/privacy renders the live draft"
fi
echo "  • Apex install.sh F-SH-02 marker (unchanged from v0.34.0):"
if curl -sS https://lapseiq.com/install.sh | grep -q 'Two more steps before the public URL is reachable'; then
  echo "    ✓ apex serving install.sh with F-SH-02 guidance"
else
  echo "    ⚠️  apex install.sh missing F-SH-02 marker — check /var/www/lapseiq/ sync"
fi
echo "  • Marketing footer Privacy + Terms annotation (Session C):"
if curl -sS https://lapseiq.com/ | grep -q 'Privacy and Terms updating'; then
  echo "    ✓ apex marketing footer updated"
else
  echo "    ⚠️  apex marketing footer still has dead links — check /var/www/lapseiq/index.html sync"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy complete"
echo "═══════════════════════════════════════════════════════════"
