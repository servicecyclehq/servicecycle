#!/bin/bash
# sync-droplet-compose.sh
#
# Sync docker-compose.ghcr.yml + docker-compose.demo.yml from /root/servicecycle-src/
# (the checked-out git working tree) to /root/servicecycle/ (the deploy directory),
# then force-recreate the server container so it picks up any environment
# block changes.
#
# Why this is its own script:
#   The standard deploy-vX.Y.Z-do-console.sh scripts bump SERVICECYCLE_VERSION in
#   /root/servicecycle/.env and roll containers, but they don't copy the compose
#   files. That means changes to the compose `environment:` whitelist (or any
#   other compose-file mod) ship to the repo but never reach the running
#   droplet. v0.35.2 introduced this exact regression — the new CF_WORKERS_AI_*
#   and AI_BUDGET_* env vars were added to docker-compose.ghcr.yml but the
#   container still didn't see them after deploy.
#
# Run this whenever:
#   - You modify docker-compose.ghcr.yml or docker-compose.demo.yml in the repo
#   - The latest tag has compose changes but the deploy script didn't sync them
#   - You're recovering from a "compose file is stale" situation
#
# Idempotent. Safe to re-run. Doesn't touch .env or images.

set -e

echo "▶ [1/3] Copying compose files from /root/servicecycle-src/ to /root/servicecycle/"
cp /root/servicecycle-src/docker-compose.ghcr.yml /root/servicecycle/docker-compose.ghcr.yml
cp /root/servicecycle-src/docker-compose.demo.yml /root/servicecycle/docker-compose.demo.yml
echo "  ✓ compose files synced"

echo ""
echo "▶ [2/3] Force-recreate server container (.env passthrough refresh)"
docker compose -f /root/servicecycle/docker-compose.ghcr.yml -f /root/servicecycle/docker-compose.demo.yml up -d --pull never --force-recreate server
echo "  ✓ server container recreated"

echo ""
echo "▶ [3/3] Wait + verify env passthrough"
sleep 8
echo "  AI / CF / HF / GROQ / AI_BUDGET env vars now in the running server container:"
docker compose -f /root/servicecycle/docker-compose.ghcr.yml -f /root/servicecycle/docker-compose.demo.yml exec server env | grep -E "^(AI_|CF_|HF_|GROQ|ANTHROPIC|AI_BUDGET)" | sort
echo ""
echo "  /api/health:"
curl -sS https://servicecycle.app/api/health
echo ""
echo "Done. If new env vars now appear above, the compose-sync fix is live."
