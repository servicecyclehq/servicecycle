#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# v0.35.3 manual deploy — paste-ready for the DigitalOcean web console
# Target: lapseiq demo droplet (206.189.200.29)
#
# Same build-on-droplet pattern as v0.33.0/v0.34.0/v0.35.0/v0.35.1/v0.35.2
# since CI is still billing-blocked (or 2FA-pending). Builds the image
# locally on the droplet from the freshly-fetched v0.35.3 tag so we don't
# depend on GHCR for the deploy.
#
# v0.35.3 highlights:
#   - feat(ai): tool-call retrieval for Ask LapseIQ. Compact ~700-token
#     system prompt + 9 named knowledge sections + LOAD_SECTION text
#     protocol. Per-call payload drops ~8x (16K → 2K). Fits CF Llama-8B
#     (7968 tok), HF (8K), Groq llama-3.1-8b-instant (8K), Anthropic
#     Haiku.
#       new: server/lib/guideRetrieval.js
#       new: server/data/guide-sections/*.txt (9 sections)
#       rewrite: server/routes/ask.js (back-compat shims kept so the
#                 ask-smoke-test.js script imports cleanly)
#   - fix(seed): three Dashboard / Risk Radar gaps closed
#       • 5 "approaching trap" contracts (cancel-by +3/+6/+12/+18/+25d)
#         → populates the Dashboard `autoRenewalTraps` tile + the
#         "Cancel-by Urgent" sub-card.
#       • 3 "expired-but-active" contracts (status=active, endDate -12/
#         -22/-35d, autoRenewal=false) → populates Risk Radar's
#         `expiredActive` bucket which the existing `expired` bucket
#         (status='expired') couldn't.
#       • 8 unacknowledged `Alert` rows planted on the soonest-due
#         contracts → Dashboard `openAlerts` tile non-zero from second
#         the seed completes.
#
# AFTER this deploy succeeds the operator should reset the .env
# workarounds that were keeping the demo limping along on v0.35.2 (see
# step [11/12] below — script handles it automatically).
#
# Generated 2026-05-18.
# ─────────────────────────────────────────────────────────────────────────────
set -e

VERSION="v0.35.3"

echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy — building on droplet (CI bypass)"
echo "═══════════════════════════════════════════════════════════"

echo ""
echo "▶ [1/12] Fetching ${VERSION} tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
git checkout "${VERSION}"
echo "  ✓ on tag $(git describe --tags --exact-match HEAD)"

echo ""
echo "▶ [2/12] Building lapseiq-server:${VERSION}"
docker build \
  -t "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -f server/Dockerfile \
  ./server
echo "  ✓ server image built"

echo ""
echo "▶ [3/12] Building client SPA (npm ci + npm run build with VITE_API_URL='')"
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
echo "▶ [4/12] Building lapseiq-client:${VERSION} image"
docker build \
  -t "ghcr.io/claudedussy/lapseiq-client:${VERSION}" \
  -f Dockerfile.prod \
  .
echo "  ✓ client image built"

echo ""
echo "▶ [5/12] Bumping compose .env (with rollback target)"
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
echo "▶ [6/12] Verifying guide-sections shipped inside the v0.35.3 server image"
SECTION_COUNT=$(docker run --rm --entrypoint sh \
  "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -c 'ls /app/data/guide-sections/*.txt 2>/dev/null | wc -l')
if [ "${SECTION_COUNT}" -ne 9 ]; then
  echo "❌ Expected 9 section .txt files inside /app/data/guide-sections/, found ${SECTION_COUNT}. Aborting."
  exit 1
fi
echo "  ✓ ${SECTION_COUNT} guide sections baked into the image"

echo ""
echo "▶ [7/12] Verifying lib/guideRetrieval.js shipped inside the v0.35.3 server image"
if ! docker run --rm --entrypoint sh \
  "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -c 'test -f /app/lib/guideRetrieval.js'; then
  echo "❌ /app/lib/guideRetrieval.js missing from server image. Aborting."
  exit 1
fi
echo "  ✓ guideRetrieval.js present"

echo ""
echo "▶ [8/12] Cloudflare Workers AI env vars (verify operator state)"
if grep -qE '^AI_PROVIDER=cloudflare' /root/lapseiq/.env; then
  echo "  ✓ AI_PROVIDER=cloudflare is set"
else
  echo "  ⚠️  AI_PROVIDER=cloudflare is NOT set"
fi
if grep -qE '^CF_WORKERS_AI_API_KEY=' /root/lapseiq/.env; then
  echo "  ✓ CF_WORKERS_AI_API_KEY is set (startup gate accepts this since v0.35.1)"
else
  echo "  ⚠️  CF_WORKERS_AI_API_KEY missing — server startup will fail v0.35.1 env gate"
fi

echo ""
echo "▶ [9/12] Rolling containers (--pull never — use locally-built images)"
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml up -d \
  --pull never \
  --force-recreate \
  --remove-orphans
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml ps

echo ""
echo "▶ [10/12] Wait 25s, then re-seed the demo account so the new tile-coverage rows land"
sleep 25
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml \
  exec -T server node scripts/seed-demo.js
echo "  ✓ demo account reseeded — approachingTraps/expiredActive/alerts counts should be in the seed summary above"

echo ""
echo "▶ [11/12] Reset .env workarounds (v0.35.x morning cleanup)"
# These three were the v0.35.2-era workarounds keeping the demo limping.
# v0.35.3 ships the cred-resolution fix + the tool-call retrieval refactor,
# so all three can be emptied and the full CF → HF → Groq cascade will fire.
sed -i -E 's|^AI_API_KEY=.+|AI_API_KEY=|' /root/lapseiq/.env || true
sed -i -E 's|^AI_MODEL_OVERRIDE=.+|AI_MODEL_OVERRIDE=|' /root/lapseiq/.env || true
sed -i -E 's|^AI_DISABLED_PROVIDERS=.+|AI_DISABLED_PROVIDERS=|' /root/lapseiq/.env || true
echo "  current values:"
grep -E '^(AI_API_KEY|AI_MODEL_OVERRIDE|AI_DISABLED_PROVIDERS)=' /root/lapseiq/.env || true
echo "  Restarting server to pick up cleaned .env"
docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml up -d \
  --pull never \
  --force-recreate \
  --remove-orphans \
  server

echo ""
echo "▶ [12/12] Smoke test — wait 20s then probe"
sleep 20
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

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy complete"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next: Dustin to spot-check the demo at https://demo.lapseiq.com"
echo "  Ask LapseIQ:"
echo "    1. 'What is the difference between the review-by date and the cancel-by date?'"
echo "       → should answer directly (no LOAD_SECTION fetch needed)"
echo "    2. 'How do I add a vendor in LapseIQ?'"
echo "       → should fetch vendors_alerts_workflow section, then answer"
echo "    3. 'Is LapseIQ HIPAA compliant?'"
echo "       → should return the verbatim security refusal"
echo "  Dashboard tiles:"
echo "    1. Auto-Renewal Traps tile = 5 (was 0)"
echo "    2. Cancel-by Urgent sub-card = 2"
echo "    3. Open Alerts count = 8 (was 0)"
echo "    4. Risk Radar → Expired (Still Active) = 3"
echo "    5. YTD Savings tile non-zero, Savings Ledger has both FY columns"
echo ""
echo "Still queued: rotate CF / HF / Groq tokens (they leaked in yesterday's chat logs)."
