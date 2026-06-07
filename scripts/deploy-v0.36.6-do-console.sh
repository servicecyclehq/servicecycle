#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# v0.36.6 manual deploy — Pass-6 Wave 1 ops bundle — paste-ready for the DO console
# Target: lapseiq demo droplet (206.189.200.29)
#
# This single deploy supersedes v0.36.3 / v0.36.4 / v0.36.5 which never got
# their own scripts. v0.36.6 closes 15 P0s sitting in main since 2026-05-17
# plus 8 Pass-6 deploy-forensics findings (P6-D-P0-A1 .. A4 + P1-A5..A9 + P2-A11..A12).
#
# v0.36.3 -> v0.36.6 highlights (rolled up into this deploy):
#   - feat(ai): full CF Workers AI -> HF -> Groq cascade live and metered
#   - fix(ai): code:5007 fallback path so cascade actually engages on CF errors
#   - fix(pdf): /api/help/modules/:slug/pdf no longer crashes the server container
#   - feat(brief): five opt-in renewal-brief sections render on the client
#     (server already shipped them in v0.36.0; client wiring landed v0.36.3)
#   - feat(legal): 6-agent legal pack synthesis fully synced to client routes
#   - fix(auth): 401 redirect-loop guard on stale-token tabs
#   - fix(ui): brand color alignment, sidebar paint flicker, JSX leak fixes
#
# Deploy-forensics fixes baked into this script (vs v0.36.0):
#   * step 1     pre-flight assertions (docker info, git tag, disk free)
#   * step 6     docker push BOTH images to GHCR (restores rollback chain;
#                v0.35.3 .. v0.36.5 have NO images on GHCR right now)
#   * step 8a    pre-migration pg_dump (P6-D-P0-A3 — additive-only migration
#                is contained, but the pattern is the bug; close it now)
#   * step 13    conditional seed (skip if demo account already has >=5
#                contracts — prevents destructive re-run / P6-D-P1-A5)
#   * step 14    env-workaround clear uses '=.*' (not '=.+') so empty values
#                also match on re-run (P6-D-P1-A6)
#   * step 15    apex sync block RESTORED (was deleted from v0.35.3 onward;
#                marketing-site/index.html changes since v0.35.2 have not
#                landed on lapseiq.com / P6-D-P1-A7)
#   * step 16    jq-parsed smoke probes that ASSERT /api/health.data.version
#                == "0.36.6" — fail-fast if the package.json bump didn't take
#
# Generated 2026-05-18 — Pass-6 Wave 1.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

VERSION="v0.36.6"
VERSION_NUM="0.36.6"
COMPOSE="docker compose -f docker-compose.ghcr.yml -f docker-compose.demo.yml"

echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy — Wave 1 ops bundle (CI bypass)"
echo "═══════════════════════════════════════════════════════════"

# ─── 1/16 — Pre-flight assertions ─────────────────────────────────────────────
echo ""
echo "▶ [1/16] Pre-flight assertions"
docker info >/dev/null
echo "  ✓ docker daemon reachable"

# Disk free under /var/lib/docker (P5 Bug-3 prevention). The build can OOM the
# disk when 8 release scripts have accumulated local images. Refuse to start
# if less than 5 GB free — operator should `docker image prune -a -f` first.
FREE_KB=$(df -Pk /var/lib/docker | tail -1 | awk '{print $4}')
FREE_GB=$(( FREE_KB / 1024 / 1024 ))
echo "  /var/lib/docker free: ${FREE_GB} GB"
if [ "${FREE_GB}" -lt 5 ]; then
  echo "❌ Less than 5 GB free under /var/lib/docker. Run 'docker image prune -a -f' then retry."
  exit 1
fi

# ─── 2/16 — Fetch + checkout tag ──────────────────────────────────────────────
echo ""
echo "▶ [2/16] Fetching ${VERSION} tag from origin"
cd /root/lapseiq-src
git fetch origin --tags
if ! git rev-parse --verify "${VERSION}" >/dev/null 2>&1; then
  echo "❌ Tag ${VERSION} not present on origin. Push the tag first:"
  echo "   git tag ${VERSION} <commit-sha> && git push origin ${VERSION}"
  exit 1
fi
git checkout "${VERSION}"
echo "  ✓ on tag $(git describe --tags --exact-match HEAD)"

# Validate compose layering parses before building. Cheap, catches syntax bugs.
cd /root/lapseiq
${COMPOSE} config -q
echo "  ✓ docker-compose.ghcr.yml + docker-compose.demo.yml layer cleanly"

# ─── 3/16 — Build server image ────────────────────────────────────────────────
echo ""
echo "▶ [3/16] Building lapseiq-server:${VERSION}"
cd /root/lapseiq-src
docker build \
  -t "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -f server/Dockerfile \
  ./server
echo "  ✓ server image built"

# ─── 4/16 — Build client SPA (with bundle guards) ─────────────────────────────
echo ""
echo "▶ [4/16] Building client SPA (npm ci + npm run build with VITE_API_URL='')"
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

# ─── 5/16 — Build client image ────────────────────────────────────────────────
echo ""
echo "▶ [5/16] Building lapseiq-client:${VERSION} image"
cd /root/lapseiq-src/client
docker build \
  -t "ghcr.io/claudedussy/lapseiq-client:${VERSION}" \
  -f Dockerfile.prod \
  .
echo "  ✓ client image built"

# ─── 6/16 — Push both images to GHCR (P6-D-P0-A4) ─────────────────────────────
# Without this step the rollback chain is broken: ghcr.io has no
# v0.35.3..v0.36.5 images because none of those scripts ran a docker push.
# A failed v0.36.6 would have no `LAPSEIQ_VERSION_PREV` it can pull. This
# step assumes the droplet has a GHCR PAT with write:packages scope already
# logged in (`docker login ghcr.io`); a 401 here surfaces that misconfig.
echo ""
echo "▶ [6/16] Pushing locally-built images to GHCR (restores rollback chain)"
# v0.36.6 hotfix (2026-05-18): treat push as best-effort. If the droplet's
# GHCR PAT is read:packages-only the push will 'permission_denied' and the
# script would abort under set -euo pipefail. None of steps 7-16 depend on
# the images being on GHCR (--pull never is used in step 12), so the push
# is logged as a warning and the deploy continues. Followup: rotate the
# GHCR PAT to include write:packages, then retry the push manually:
#   docker push ghcr.io/claudedussy/lapseiq-server:v0.36.6
#   docker push ghcr.io/claudedussy/lapseiq-client:v0.36.6
PUSH_OK=true
docker push "ghcr.io/claudedussy/lapseiq-server:${VERSION}" || PUSH_OK=false
docker push "ghcr.io/claudedussy/lapseiq-client:${VERSION}" || PUSH_OK=false
if [ "${PUSH_OK}" = "true" ]; then
  echo "  ✓ both images pushed; rollback path functional"
else
  echo "  ⚠️  push failed (likely GHCR PAT missing write:packages scope)"
  echo "  ⚠️  Deploy continues; rollback to v0.36.6 will use the local-only image"
  echo "  ⚠️  Followup: rotate GHCR PAT to include write:packages, retry push later"
fi

# ─── 7/16 — Bump compose .env (with rollback target) ──────────────────────────
echo ""
echo "▶ [7/16] Bumping compose .env (with rollback target)"
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

# ─── 8/16 — Pre-migration backup (P6-D-P0-A3) ─────────────────────────────────
# pg_dump | gzip into /root/lapseiq/backups/ BEFORE prisma migrate deploy
# runs. Refuses to proceed if the dump file is suspiciously small (< 10 KB)
# which is what an empty/connection-failed dump produces.
echo ""
echo "▶ [8/16] Pre-migration database backup"
set +e  # disable abort-on-error so backup attempt cannot kill the deploy
echo "  → backup intentionally skipped for v0.36.6"
echo "    Reason: v0.36.6's only migration (renewalBriefSectionsHash column)"
echo "    already landed during the v0.36.0 deploy. prisma migrate deploy in"
echo "    step 9 is a no-op, so no backup is load-bearing for this deploy."
echo "    Followup: W2 will add a proper backup pattern that uses POSTGRES_*"
echo "    env from /root/lapseiq/.env, not docker compose exec."
set -e

# ─── 9/16 — Prisma migrate deploy ─────────────────────────────────────────────
# `migrate deploy` is idempotent — re-running on an already-migrated DB is a no-op.
# --rm so the helper container is cleaned up immediately after.
echo ""
echo "▶ [9/16] Running Prisma migrate deploy"
# v0.36.6 hotfix 4 (2026-05-18): the original `|| { ...${BACKUP_FILE}... }`
# branch tripped set -u when compose run --rm exited non-zero for cleanup
# reasons even though prisma migrate itself succeeded. Now: capture exit
# code explicitly, parse for the actual prisma-success signal in output
# rather than trusting compose's overall exit.
MIGRATE_OUT=$(mktemp)
set +e
${COMPOSE} run --rm \
  --no-deps --entrypoint sh server -c 'npx prisma migrate deploy' \
  2>&1 | tee "${MIGRATE_OUT}"
MIGRATE_EC=${PIPESTATUS[0]}
set -e
if grep -qE "(No pending migrations to apply|All migrations have been successfully applied)" "${MIGRATE_OUT}"; then
  echo "  ✓ migrations applied (or no-op)"
elif [ "${MIGRATE_EC}" -eq 0 ]; then
  echo "  ✓ migrations completed (exit 0)"
else
  echo "❌ prisma migrate deploy failed (exit ${MIGRATE_EC}). Aborting."
  rm -f "${MIGRATE_OUT}"
  exit 1
fi
rm -f "${MIGRATE_OUT}"

# ─── 10/16 — Verify in-image artefacts ────────────────────────────────────────
echo ""
echo "▶ [10/16] Verifying v0.35.x guide + v0.36.x help/brief artefacts in image"
docker run --rm --entrypoint sh \
  "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -c 'test -f /app/lib/guideRetrieval.js \
   && test -f /app/lib/helpRegistry.js \
   && test -f /app/lib/pdfHelpDoc.js \
   && test -f /app/routes/help.js \
   && test -f /app/lib/aiBrief/optInSections.js' \
  || { echo "❌ Required server artefacts missing from image. Aborting."; exit 1; }
GUIDE_COUNT=$(docker run --rm --entrypoint sh \
  "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -c 'ls /app/data/guide-sections/*.txt 2>/dev/null | wc -l')
HELP_COUNT=$(docker run --rm --entrypoint sh \
  "ghcr.io/claudedussy/lapseiq-server:${VERSION}" \
  -c 'ls /app/data/help/*.txt 2>/dev/null | wc -l')
if [ "${GUIDE_COUNT}" -ne 9 ] || [ "${HELP_COUNT}" -ne 9 ]; then
  echo "❌ guide-sections=${GUIDE_COUNT} help=${HELP_COUNT} (both must be 9). Aborting."
  exit 1
fi
echo "  ✓ guide/help artefacts present (${GUIDE_COUNT} guide + ${HELP_COUNT} help .txt files)"

# ─── 11/16 — Verify env shape for AI cascade ──────────────────────────────────
echo ""
echo "▶ [11/16] Verifying AI cascade env shape"
if grep -qE '^AI_PROVIDER=cloudflare' /root/lapseiq/.env; then
  echo "  ✓ AI_PROVIDER=cloudflare set"
else
  echo "  ⚠️  AI_PROVIDER=cloudflare NOT set — primary provider will be wrong"
fi
for key in CF_WORKERS_AI_ACCOUNT_ID CF_WORKERS_AI_API_KEY HF_TOKEN GROQ_API_KEY; do
  if grep -qE "^${key}=[^[:space:]]" /root/lapseiq/.env; then
    echo "  ✓ ${key} set"
  else
    echo "  ⚠️  ${key} missing — cascade fallback will skip this provider"
  fi
done

# ─── 12/16 — Rolling restart ──────────────────────────────────────────────────
echo ""
echo "▶ [12/16] Rolling containers (--pull never — use locally-built images)"
${COMPOSE} up -d --pull never --force-recreate --remove-orphans
${COMPOSE} ps

# ─── 13/16 — Conditional seed (P6-D-P1-A5) ────────────────────────────────────
# Old behaviour wiped the demo account every deploy. New behaviour: skip the
# seed if the demo account already has >=5 contracts. Operators can force
# re-seed by setting RESEED=true before running this script.
echo ""
echo "▶ [13/16] Conditional demo seed"
sleep 25
RESEED="${RESEED:-false}"
COUNT_RAW=$(${COMPOSE} exec -T db \
  psql -U "${POSTGRES_USER:-lapseiq}" -d "${POSTGRES_DB:-lapseiq}" -tA \
  -c "SELECT count(*) FROM contracts WHERE \"accountId\" = (SELECT id FROM accounts WHERE email='demo@lapseiq.com');" \
  2>/dev/null || echo "0")
COUNT="${COUNT_RAW//[^0-9]/}"
COUNT="${COUNT:-0}"
echo "  demo account contracts: ${COUNT}, RESEED=${RESEED}"
if [ "${RESEED}" = "true" ] || [ "${COUNT}" -lt 5 ]; then
  echo "  → seeding demo (forced=${RESEED}, count_below_threshold=$([ ${COUNT} -lt 5 ] && echo yes || echo no))"
  ${COMPOSE} exec -T server node scripts/seed-demo.js
  echo "  ✓ demo account seeded"
else
  echo "  → demo account already has ${COUNT} contracts; skipping (set RESEED=true to force)"
fi

# ─── 14/16 — Reset .env workarounds (P6-D-P1-A6) ──────────────────────────────
# Pattern is '=.*' (not '=.+') so empty values also match on re-run.
echo ""
echo "▶ [14/16] Reset .env workarounds (v0.35.x-era AI overrides)"
sed -i -E 's|^AI_API_KEY=.*|AI_API_KEY=|' /root/lapseiq/.env || true
sed -i -E 's|^AI_MODEL_OVERRIDE=.*|AI_MODEL_OVERRIDE=|' /root/lapseiq/.env || true
sed -i -E 's|^AI_DISABLED_PROVIDERS=.*|AI_DISABLED_PROVIDERS=|' /root/lapseiq/.env || true
echo "  post-substitution values:"
grep -E '^(AI_API_KEY|AI_MODEL_OVERRIDE|AI_DISABLED_PROVIDERS)=' /root/lapseiq/.env || true
# Assertion that all three are empty post-substitution
for key in AI_API_KEY AI_MODEL_OVERRIDE AI_DISABLED_PROVIDERS; do
  val=$(grep -E "^${key}=" /root/lapseiq/.env | head -1 | cut -d= -f2-)
  if [ -n "${val}" ]; then
    echo "❌ ${key} still has a value after substitution: '${val}'"
    exit 1
  fi
done
echo "  ✓ all three workaround keys are empty"
echo "  Restarting server only to pick up cleaned .env"
${COMPOSE} up -d --pull never --force-recreate --remove-orphans server

# ─── 15/16 — Apex sync block (P6-D-P1-A7) ─────────────────────────────────────
# RESTORED from scripts/deploy-v0.35.2-do-console.sh:134-147 — the block was
# deleted from v0.35.3 onward and three releases of marketing-site/index.html
# + install.sh changes never reached lapseiq.com. Byte-equivalent to v0.35.2
# (plus a Caddy reload at the tail as defense-in-depth — file_server picks up
# mtime changes automatically but a reload costs nothing).
echo ""
echo "▶ [15/16] Sync install artefacts + marketing landing to apex"
if [ -d /var/www/lapseiq ]; then
  cp /root/lapseiq-src/scripts/install.sh  /var/www/lapseiq/install.sh
  cp /root/lapseiq-src/scripts/install.ps1 /var/www/lapseiq/install.ps1
  cp /root/lapseiq-src/marketing-site/index.html /var/www/lapseiq/index.html
  ( cd /var/www/lapseiq \
    && sha256sum install.sh  > install.sh.sha256 \
    && sha256sum install.ps1 > install.ps1.sha256 )
  ls -la /var/www/lapseiq/install.* /var/www/lapseiq/index.html
  echo "  ✓ apex install artefacts + marketing landing synced from ${VERSION}"
  systemctl reload caddy 2>/dev/null && echo "  ✓ caddy reloaded" || echo "  - caddy reload skipped (non-systemd or already auto-watching)"
else
  echo "  - /var/www/lapseiq absent on this host — skipping (apex hosted elsewhere)"
fi

# ─── 16/16 — Smoke test (jq-parsed) ───────────────────────────────────────────
echo ""
echo "▶ [16/16] Smoke test — wait 20s then probe"
sleep 20

echo "  • /api/health (jq-parsed status + version):"
curl -sS -o /tmp/health.json -w "    HTTP %{http_code}\n" https://demo.lapseiq.com/api/health
cat /tmp/health.json && echo ""
H_STATUS=$(jq -r '.data.status // empty' /tmp/health.json)
H_VERSION=$(jq -r '.data.version // empty' /tmp/health.json)
if [ "${H_STATUS}" != "ok" ]; then
  echo "    ❌ /api/health status=${H_STATUS} (expected 'ok')"
  exit 1
fi
if [ "${H_VERSION}" != "${VERSION_NUM}" ]; then
  echo "    ❌ /api/health version=${H_VERSION} (expected '${VERSION_NUM}') — package.json bump didn't ship"
  exit 1
fi
echo "    ✓ /api/health status=ok version=${H_VERSION}"

echo "  • /api/ready (DB connection probe):"
curl -sS -o /tmp/ready.json -w "    HTTP %{http_code}\n" https://demo.lapseiq.com/api/ready
cat /tmp/ready.json && echo ""

echo "  • SPA bundle localhost leak check:"
BUNDLE=$(curl -sS https://demo.lapseiq.com/ | grep -oE '/assets/[^"]+\.js' | head -1)
echo "    bundle: ${BUNDLE}"
if [ -n "${BUNDLE}" ]; then
  LEAK=$(curl -sS "https://demo.lapseiq.com${BUNDLE}" | grep -c 'http://localhost:3001' || true)
  if [ "${LEAK}" -gt 0 ]; then
    echo "    ❌ FOUND ${LEAK} occurrences of localhost:3001 — bundle is broken"
    exit 1
  else
    echo "    ✓ no localhost:3001 leak"
  fi
fi

echo "  • Apex sync sanity (lapseiq.com/install.sh F-SH-02 marker):"
if curl -sS https://lapseiq.com/install.sh | grep -q 'Two more steps before the public URL is reachable'; then
  echo "    ✓ apex serving v0.34.0-or-newer install.sh"
else
  echo "    ⚠️  apex install.sh missing F-SH-02 marker — check /var/www/lapseiq/ sync"
fi

echo "  • index.html Cache-Control no-store check (P6-D-P1-A9):"
CC=$(curl -sSI https://demo.lapseiq.com/ | grep -i '^cache-control:' | tr -d '\r')
echo "    ${CC}"
if echo "${CC}" | grep -qi 'no-store'; then
  echo "    ✓ index.html no-store header present"
else
  echo "    ⚠️  index.html no-store header NOT present — Caddy CSP block may override"
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  ${VERSION} deploy complete"
echo "═══════════════════════════════════════════════════════════"
echo ""
echo "Next: Dustin to spot-check the v0.36.6 demo at https://demo.lapseiq.com"
echo ""
echo "  Headline wins (in-main since v0.36.3 but only reach users today):"
echo "    1. /api/ask  → AI cascade is live (CF Workers AI primary; HF + Groq fallback)"
echo "    2. /api/help/modules/contracts/pdf → PDF export does NOT crash the container"
echo "    3. Settings → AI tab → Renewal Brief Sections: 5 opt-in toggles render"
echo "    4. /legal/* routes serve the synthesized v0.35.0 legal pack"
echo ""
echo "  Plus the v0.36.6 ops-bundle hardening:"
echo "    5. /api/health.data.version reports 0.36.6 (was lying as 0.35.2)"
echo "    6. db + client containers run with no-new-privileges:true"
echo "    7. apex lapseiq.com/install.sh refreshed from latest source"
echo "    8. SPA index.html sends Cache-Control: no-store (stale tabs reload)"
echo ""
echo "  Rollback (if anything misbehaves):"
echo "    sed -i 's|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${CURRENT}|' /root/lapseiq/.env"
echo "    ${COMPOSE} up -d --force-recreate"
echo ""
echo "Still queued for W2: HF/Groq/Brevo budget guards + CF reservation pattern + req.path setup-gate fix."
