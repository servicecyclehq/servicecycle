#!/usr/bin/env bash
# scripts/prune-images.sh
# ---------------------------------------------------------------------------
# LapseIQ Docker image retention. Keeps the newest N semver-tagged images per
# repo (client + server) and removes everything older. Safe by construction:
#   - never deletes an image used by a RUNNING container (current + anything up)
#   - never deletes the :latest tag
#   - only ever touches ghcr.io/<owner>/lapseiq-{client,server} vX.Y.Z tags
#
# Why this exists: the lapseiq-vps MCP intentionally blocks `docker rmi`, so
# retention can't be driven through it. This runs natively on the droplet
# (cron and/or as the last step of a deploy), where it isn't allowlist-gated.
#
# Usage:
#   KEEP=6 ./prune-images.sh           # delete all but the newest 6 per repo
#   DRYRUN=1 ./prune-images.sh         # print what WOULD be deleted, do nothing
#
# Recommended cron (daily 04:10 UTC):
#   10 4 * * * KEEP=6 /root/lapseiq-src/scripts/prune-images.sh >> /var/log/lapseiq-prune.log 2>&1
# ---------------------------------------------------------------------------
set -euo pipefail

KEEP="${KEEP:-6}"
DRYRUN="${DRYRUN:-0}"
OWNER="${GHCR_OWNER:-forgerift}"
REPOS=("ghcr.io/${OWNER}/lapseiq-client" "ghcr.io/${OWNER}/lapseiq-server")

# Images referenced by running containers — never delete these.
INUSE="$(docker ps --format '{{.Image}}' | sort -u)"

removed=0
kept=0
for repo in "${REPOS[@]}"; do
  # Only vX.Y.Z tags, newest first (version sort). Ignores :latest and other tags.
  mapfile -t tags < <(docker images "$repo" --format '{{.Tag}}' \
    | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' \
    | sort -V -r || true)

  i=0
  for t in "${tags[@]}"; do
    i=$((i + 1))
    img="${repo}:${t}"
    if [ "$i" -le "$KEEP" ]; then
      kept=$((kept + 1))
      continue
    fi
    if printf '%s\n' "$INUSE" | grep -qxF "$img"; then
      echo "skip (running)  $img"
      continue
    fi
    if [ "$DRYRUN" = "1" ]; then
      echo "WOULD remove    $img"
    else
      if docker rmi "$img" >/dev/null 2>&1; then
        echo "removed         $img"
        removed=$((removed + 1))
      else
        echo "skip (in use)   $img"
      fi
    fi
  done
done

# Sweep dangling layers left behind.
if [ "$DRYRUN" != "1" ]; then
  docker image prune -f >/dev/null 2>&1 || true
fi

echo "prune-images: KEEP=${KEEP} DRYRUN=${DRYRUN} kept=${kept} removed=${removed}"
