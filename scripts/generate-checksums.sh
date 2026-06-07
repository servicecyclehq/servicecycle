#!/usr/bin/env bash
# ============================================================================
# generate-checksums.sh
# ============================================================================
#
# Emits SHA256 checksums for the installer scripts served at lapseiq.com:
#
#   scripts/install.sh    -> scripts/install.sh.sha256
#   scripts/install.ps1   -> scripts/install.ps1.sha256
#
# Operators can use these to verify the integrity of a downloaded installer
# before running it:
#
#   curl -sLO https://lapseiq.com/install.sh
#   curl -sLO https://lapseiq.com/install.sh.sha256
#   sha256sum -c install.sh.sha256
#   bash install.sh
#
# Run this after EVERY edit to install.sh / install.ps1 and commit the
# updated .sha256 files. The repo's apex Caddy serves whichever pair of
# files is at the latest committed state.
# ============================================================================

set -euo pipefail

cd "$(dirname "$0")"

for f in install.sh install.ps1; do
  if [ ! -f "$f" ]; then
    echo "warn: $f not found, skipping" >&2
    continue
  fi
  hash="$(sha256sum "$f" | awk '{print $1}')"
  # GNU sha256sum format: '<hash>  <filename>'
  # Two-space separator is significant; sha256sum -c expects it.
  printf "%s  %s\n" "$hash" "$f" > "${f}.sha256"
  echo "wrote ${f}.sha256 (${hash})"
done
