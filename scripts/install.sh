#!/usr/bin/env bash
# ============================================================================
# LapseIQ — One-line installer
# ============================================================================
#
# Pulls pre-built Docker images from GHCR, generates the required secrets,
# writes .env, brings up the stack, and prints the setup-wizard URL.
#
# Recommended usage (inspect-then-run, avoids the curl|bash anti-pattern):
#
#   curl -fsSLO https://lapseiq.com/install.sh
#   less install.sh                          # read what it's about to do
#   bash install.sh
#
# Or, if you trust this project:
#
#   curl -fsSL https://lapseiq.com/install.sh | bash
#
# Supports: Ubuntu 22.04+ / Debian 12 / macOS (with Docker Desktop).
# Idempotent: re-running on an existing install reuses the existing .env
# and does NOT regenerate secrets (would invalidate every encrypted backup
# and document on disk).
# ============================================================================

set -euo pipefail

# ── Constants ────────────────────────────────────────────────────────────────
GHCR_OWNER="${GHCR_OWNER:-forgerift}"
GHCR_REGISTRY="ghcr.io/${GHCR_OWNER}"

# S6-FN-01 (v0.74.1): resolve LAPSEIQ_VERSION from the latest GitHub release tag
# rather than a static placeholder. Operators can pin a specific version with:
#   LAPSEIQ_VERSION=v0.74.0 bash install.sh
if [ -z "${LAPSEIQ_VERSION:-}" ]; then
  # Probe the GitHub releases API (unauthenticated; works on public repos).
  _gh_json=$(curl -fsSL --connect-timeout 5 \
    "https://api.github.com/repos/${GHCR_OWNER}/lapseiq/releases/latest" 2>/dev/null) || _gh_json=""
  if command -v jq >/dev/null 2>&1; then
    _gh_latest=$(printf '%s' "$_gh_json" | jq -r '.tag_name // empty' 2>/dev/null) || _gh_latest=""
  else
    _gh_latest=$(printf '%s' "$_gh_json" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": "\([^"]*\)".*/\1/') || _gh_latest=""
  fi
  if [ -n "${_gh_latest:-}" ] && [ "$_gh_latest" != "null" ]; then
    LAPSEIQ_VERSION="$_gh_latest"
  else
    LAPSEIQ_VERSION="latest"
    echo "[install] WARN: Could not fetch latest release tag from GitHub -- falling back to :latest image tag."
  fi
fi
SERVER_IMAGE="${GHCR_REGISTRY}/lapseiq-server:${LAPSEIQ_VERSION}"
CLIENT_IMAGE="${GHCR_REGISTRY}/lapseiq-client:${LAPSEIQ_VERSION}"
COMPOSE_URL_BASE="https://lapseiq.com"   # served via Caddy on the demo droplet
INSTALL_DIR="${INSTALL_DIR:-$PWD/lapseiq}"
EULA_URL="${EULA_URL:-https://lapseiq.com/eula}"

# ── Tiny terminal helpers ────────────────────────────────────────────────────
if [ -t 1 ] && command -v tput >/dev/null 2>&1 && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  C_BOLD=$(tput bold);  C_RED=$(tput setaf 1);  C_GREEN=$(tput setaf 2)
  C_YELLOW=$(tput setaf 3);  C_BLUE=$(tput setaf 4);  C_DIM=$(tput dim);  C_RESET=$(tput sgr0)
else
  C_BOLD=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_DIM=""; C_RESET=""
fi
msg()  { printf "%s\n" "$*"; }
info() { printf "${C_BLUE}==>${C_RESET} %s\n" "$*"; }
ok()   { printf "${C_GREEN}✓${C_RESET} %s\n" "$*"; }
warn() { printf "${C_YELLOW}!${C_RESET} %s\n" "$*"; }
die()  { printf "${C_RED}✗${C_RESET} %s\n" "$*" >&2; exit 1; }

# ── 0. Banner ────────────────────────────────────────────────────────────────
cat <<EOF
${C_BOLD}LapseIQ${C_RESET} — self-hosted contract renewal management
${C_DIM}Installer · this is a script, not a service. Everything runs on your box.${C_RESET}
${C_DIM}EULA: ${EULA_URL}  ·  License will be confirmed before any work begins.${C_RESET}

EOF

# ── 0.5. EULA acceptance ────────────────────────────────────────────────────
# License-agreement gate. Required for an interactive install. CI / IaC /
# anyone scripting around install.sh can bypass with one of:
#   --yes   (positional flag)
#   LAPSEIQ_ACCEPT_EULA=1   (environment variable)
# Either acceptance path is logged to .lapseiq-eula-accepted in INSTALL_DIR
# so re-runs don't re-prompt.
ACCEPT_EULA_FLAG=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y|--accept-eula) ACCEPT_EULA_FLAG=1;;
  esac
done
if [ "${LAPSEIQ_ACCEPT_EULA:-0}" = "1" ]; then
  ACCEPT_EULA_FLAG=1
fi

if [ -f "${INSTALL_DIR}/.lapseiq-eula-accepted" ]; then
  ok "EULA already accepted (see ${INSTALL_DIR}/.lapseiq-eula-accepted)."
elif [ "$ACCEPT_EULA_FLAG" = 1 ]; then
  mkdir -p "$INSTALL_DIR"
  echo "Accepted via --yes / LAPSEIQ_ACCEPT_EULA=1 on $(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    > "${INSTALL_DIR}/.lapseiq-eula-accepted"
  ok "EULA accepted non-interactively."
else
  cat <<EOF
${C_BOLD}LapseIQ End-User License Agreement${C_RESET}

Before installing, please review the LapseIQ EULA:

  ${C_BOLD}${EULA_URL}${C_RESET}

Highlights (full text at the URL above governs):

  - Self-hosted; no telemetry, no phone-home, no license-validation callback.
  - Internal-business-use only. No reselling, sublicensing, or building a
    competing product. No reverse engineering (except as legally permitted).
  - AS-IS, no warranty. Liability cap is the greater of USD \$100 or
    fees paid in the prior 12 months. AI outputs require human review.
  - Wisconsin governing law. Either party can terminate on 90 days notice.
  - Your data is yours. ForgeRift does not host, store, or have routine
    access to anything you process through the Software.

EOF

  if [ ! -t 0 ]; then
    cat <<EOF
${C_RED}Non-interactive install detected (stdin is not a TTY) and the EULA has
not been accepted. Re-run with one of:${C_RESET}

  --yes                                bash install.sh --yes
  LAPSEIQ_ACCEPT_EULA=1                LAPSEIQ_ACCEPT_EULA=1 bash install.sh

${C_DIM}Both signal acceptance of the EULA at ${EULA_URL}.${C_RESET}
EOF
    exit 1
  fi

  printf "Type ${C_BOLD}yes${C_RESET} to accept the EULA and continue (anything else aborts): "
  read -r EULA_REPLY
  case "${EULA_REPLY:-}" in
    yes|YES|Yes|y|Y) ;;
    *) die "EULA not accepted — installation aborted." ;;
  esac
  mkdir -p "$INSTALL_DIR"
  echo "Accepted interactively on $(date -u +"%Y-%m-%dT%H:%M:%SZ") by '$(whoami)'" \
    > "${INSTALL_DIR}/.lapseiq-eula-accepted"
  ok "EULA accepted (logged to ${INSTALL_DIR}/.lapseiq-eula-accepted)."
fi

# ── 1. OS / arch detection ───────────────────────────────────────────────────
OS="$(uname -s)"
ARCH="$(uname -m)"
info "Detected: $OS / $ARCH"

if [ "$OS" != "Linux" ] && [ "$OS" != "Darwin" ]; then
  die "Unsupported OS: $OS. Use Ubuntu 22+, Debian 12, or macOS with Docker Desktop."
fi

# ── 2. Docker presence (install on Ubuntu/Debian if missing) ────────────────
need_docker_install=0
if ! command -v docker >/dev/null 2>&1; then
  need_docker_install=1
fi

if [ "$need_docker_install" = 1 ]; then
  if [ "$OS" = "Darwin" ]; then
    die "Docker not found. Install Docker Desktop from https://docker.com/products/docker-desktop and re-run."
  fi
  info "Docker not found — installing via the official convenience script…"
  if [ "$EUID" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
    die "Need sudo (or root) to install Docker. Re-run as root or install sudo first."
  fi
  SUDO=""; [ "$EUID" -ne 0 ] && SUDO="sudo"
  curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
  $SUDO sh /tmp/get-docker.sh
  rm /tmp/get-docker.sh
  ok "Docker installed."
fi

# Compose plugin check — `docker compose` (v2 subcommand), NOT `docker-compose`.
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 plugin not found. On Linux: 'apt install docker-compose-plugin'. On macOS: included with Docker Desktop."
fi
ok "Docker Compose v2 present."

# ── 3. Working directory ─────────────────────────────────────────────────────
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"
info "Working directory: $INSTALL_DIR"

# Track whether THIS install run generated a fresh MASTER_KEY (so we know
# whether to show the password-manager save gate later). On a re-run with
# an existing .env, we skip the gate because the operator presumably
# already acknowledged it on first install.
FRESH_MASTER_KEY=0

# ── 4. Reuse existing .env or build a fresh one ──────────────────────────────
if [ -f .env ]; then
  warn ".env already present — reusing existing values (safer than rotating MASTER_KEY)."
  warn "If you want a clean slate, move .env aside, rm uploads/ and 'docker compose down -v', then re-run."
  # S6-FN-01 (v0.75.1): keep LAPSEIQ_VERSION in sync so rollback runbook sed is not a no-op.
  if grep -q '^LAPSEIQ_VERSION=' .env 2>/dev/null; then
    sed -i.bak "s|^LAPSEIQ_VERSION=.*|LAPSEIQ_VERSION=${LAPSEIQ_VERSION}|" .env && rm -f .env.bak
  else
    echo "LAPSEIQ_VERSION=${LAPSEIQ_VERSION}" >> .env
  fi
else
  info "Building a fresh .env. You'll be prompted for a few values."

  # Prompt: domain
  read -r -p "Public domain (e.g. lapseiq.example.com) [http://localhost:5173]: " DOMAIN
  DOMAIN="${DOMAIN:-http://localhost:5173}"
  # Normalise — accept bare hostname, prepend https://
  case "$DOMAIN" in
    http://*|https://*) ;;
    *) DOMAIN="https://${DOMAIN}";;
  esac

  # Prompt: admin email
  read -r -p "Admin email address (used by setup wizard): " ADMIN_EMAIL
  if [ -z "$ADMIN_EMAIL" ]; then
    die "Admin email is required."
  fi

  # Prompt: Brevo API key (optional)
  read -r -p "Brevo API key for transactional email (leave blank to skip — emails will be logged to stdout): " BREVO_API_KEY

  info "Generating secrets via openssl rand…"
  if ! command -v openssl >/dev/null 2>&1; then
    die "openssl not found. Install it and re-run (it's used to generate JWT_SECRET / MASTER_KEY / POSTGRES_PASSWORD)."
  fi
  POSTGRES_PASSWORD="$(openssl rand -base64 24 | tr -d '+/=' | head -c 32)"
  JWT_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  MASTER_KEY="$(openssl rand -base64 32 | tr -d '\n')"
  FRESH_MASTER_KEY=1

  # Decide email mode
  if [ -n "$BREVO_API_KEY" ]; then
    EMAIL_MOCK_VAL="false"
    EMAIL_FROM_VAL="LapseIQ <noreply@${DOMAIN#https://}>"
  else
    EMAIL_MOCK_VAL="true"
    EMAIL_FROM_VAL=""
  fi

  cat > .env <<EOF
# Generated by install.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
# DO NOT commit this file. Treat MASTER_KEY like a production credential —
# rotating it makes every encrypted document and backup unreadable.

NODE_ENV=production
LAPSEIQ_VERSION=
CLIENT_URL=${DOMAIN}
TRUST_PROXY=true

POSTGRES_USER=lapseiq
POSTGRES_DB=lapseiq
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
DATABASE_URL=postgresql://lapseiq:${POSTGRES_PASSWORD}@db:5432/lapseiq

JWT_SECRET=${JWT_SECRET}
MASTER_KEY=${MASTER_KEY}

# Email — Resend if a key was provided, EMAIL_MOCK otherwise
EMAIL_MOCK=${EMAIL_MOCK_VAL}
BREVO_API_KEY=${BREVO_API_KEY}
EMAIL_FROM=${EMAIL_FROM_VAL}
SUPPORT_EMAIL=${ADMIN_EMAIL}

# Storage / backup — both default to local disk on the host
STORAGE_DEST=local
BACKUP_DEST=local

# AI — opt in by setting AI_ENABLED=true and AI_API_KEY=sk-ant-...
AI_ENABLED=false

# Telemetry: there is none. This block exists to make that explicit.
EOF
  chmod 600 .env
  ok "Wrote .env (secrets generated, mode 600)."

  # ── C6: off-host backup prompt ────────────────────────────────────────
  # New install defaulted BACKUP_DEST=local above. On a TTY, ask whether
  # the operator wants to configure S3-compatible off-host backup now.
  # On non-interactive runs we leave local + let the server's startup
  # warning nag every boot until BACKUP_DEST != local.
  if [ -t 0 ] && [ -t 1 ]; then
    printf "\n${C_BOLD}${C_YELLOW}Off-host backup${C_RESET}\n"
    printf "BACKUP_DEST currently set to ${C_BOLD}local${C_RESET}. If this host fails,\n"
    printf "your backups die with it -- there is no separate copy.\n"
    printf "\n"
    printf "S3-compatible targets that work here: Cloudflare R2, Backblaze B2,\n"
    printf "Wasabi, AWS S3, MinIO, DigitalOcean Spaces.\n"
    printf "\n"
    printf "Configure off-host backup now? [Y/n]: "
    read -r BK_REPLY
    case "${BK_REPLY:-Y}" in
      n|N|no|NO|No)
        warn "Off-host backup skipped. Server will warn at every boot until BACKUP_DEST != local."
        warn "Edit .env later to set BACKUP_DEST=s3 + BACKUP_S3_* and 'docker compose restart server'."
        ;;
      *)
        printf "  S3 endpoint URL (e.g. https://<account>.r2.cloudflarestorage.com): "
        read -r BK_ENDPOINT
        printf "  Bucket name: "
        read -r BK_BUCKET
        printf "  Region (e.g. auto / us-east-1): "
        read -r BK_REGION
        printf "  Access key ID: "
        read -r BK_KEY_ID
        printf "  Secret access key (input hidden): "
        stty -echo 2>/dev/null || true
        read -r BK_SECRET
        stty echo 2>/dev/null || true
        printf "\n"
        # Rewrite BACKUP_DEST + append S3 creds. Idempotent on re-runs:
        # sed replaces the literal default we just wrote.
        sed -i.bak 's/^BACKUP_DEST=local$/BACKUP_DEST=s3/' .env && rm -f .env.bak
        {
          printf "\n# Off-host backup (configured by install.sh on %s)\n" "$(date -u +%FT%TZ)"
          printf "BACKUP_S3_ENDPOINT=%s\n" "$BK_ENDPOINT"
          printf "BACKUP_S3_BUCKET=%s\n"   "$BK_BUCKET"
          printf "BACKUP_S3_REGION=%s\n"   "$BK_REGION"
          printf "BACKUP_S3_KEY_ID=%s\n"   "$BK_KEY_ID"
          printf "BACKUP_S3_SECRET=%s\n"   "$BK_SECRET"
          printf "BACKUP_ENCRYPT=true\n"
        } >> .env
        chmod 600 .env
        ok "BACKUP_DEST set to s3; nightly backups will upload to ${BK_BUCKET}."
        ;;
    esac
  else
    warn "Non-interactive install: BACKUP_DEST left as 'local'."
    warn "Server will warn at every boot until BACKUP_DEST != local. See docs/dr.md."
  fi
fi

# ── 4.5. MASTER_KEY save gate (Pass-6 W4 MT-039) ────────────────────────────
# This is the single most important thing an operator must do correctly on a
# fresh install. Without MASTER_KEY, everything downstream is data-loss:
#   - every encrypted document on disk is unrecoverable
#   - every encrypted backup is unrecoverable
#   - every cloud-connector credential in the DB is unrecoverable
#   - rotation requires an off-host re-encrypt window
#
# We print the value once, prominently, and require an explicit "saved"
# acknowledgement on a TTY. Non-interactive installs can bypass with
# LAPSEIQ_ACCEPT_MASTER_KEY_RISK=1 (paired with LAPSEIQ_ACCEPT_EULA=1).
#
# Idempotent: an .lapseiq-master-key-saved sentinel file in INSTALL_DIR
# means the operator has already gone through this gate; subsequent runs
# skip it. We also skip on re-runs that didn't generate a fresh key.

if [ "$FRESH_MASTER_KEY" = "1" ] && [ ! -f "${INSTALL_DIR}/.lapseiq-master-key-saved" ]; then
  printf "\n"
  printf "${C_BOLD}${C_YELLOW}━━━ IMPORTANT — Save your MASTER_KEY now ━━━${C_RESET}\n"
  printf "\n"
  printf "Your fresh MASTER_KEY (printed once):\n"
  printf "    ${C_BOLD}%s${C_RESET}\n" "$MASTER_KEY"
  printf "\n"
  printf "Save this to a password manager (1Password, Bitwarden, Vaultwarden, etc.)\n"
  printf "${C_BOLD}before continuing${C_RESET}. Why this matters:\n"
  printf "\n"
  printf "  • All encrypted documents on disk are decrypted with this key.\n"
  printf "  • Every nightly backup in ./backups/*.sql.gz.enc is encrypted with it.\n"
  printf "  • Cloud-connector credentials in the database are encrypted with it.\n"
  printf "  • TOTP secrets, AI API keys, and outbound-webhook signing secrets\n"
  printf "    are also encrypted with it.\n"
  printf "\n"
  printf "If you lose this key, that data is unrecoverable. ForgeRift cannot\n"
  printf "recover it for you — LapseIQ is self-hosted and there is no central\n"
  printf "key escrow.\n"
  printf "\n"
  printf "The key is also in ${INSTALL_DIR}/.env (mode 600), but that file lives\n"
  printf "on this host. If this host dies, you'll need the key from your password\n"
  printf "manager to restore from off-host backups. Don't store the password\n"
  printf "manager backup on the same host as LapseIQ.\n"
  printf "\n"

  if [ "${LAPSEIQ_ACCEPT_MASTER_KEY_RISK:-0}" = "1" ]; then
    echo "Acknowledged via LAPSEIQ_ACCEPT_MASTER_KEY_RISK=1 on $(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
      > "${INSTALL_DIR}/.lapseiq-master-key-saved"
    chmod 600 "${INSTALL_DIR}/.lapseiq-master-key-saved"
    ok "MASTER_KEY save acknowledged non-interactively."
  elif [ ! -t 0 ]; then
    cat <<EOF
${C_RED}Non-interactive install detected — cannot prompt for MASTER_KEY
acknowledgement. Re-run with the env var set:${C_RESET}

  LAPSEIQ_ACCEPT_EULA=1 LAPSEIQ_ACCEPT_MASTER_KEY_RISK=1 bash install.sh

${C_DIM}LAPSEIQ_ACCEPT_MASTER_KEY_RISK=1 means: "I'm scripting this install
and I take responsibility for capturing MASTER_KEY out-of-band before
this host runs unattended." Don't set it unless that's true.${C_RESET}
EOF
    exit 1
  else
    printf "Type ${C_BOLD}saved${C_RESET} once MASTER_KEY is stored in your password manager: "
    read -r MK_REPLY
    case "${MK_REPLY:-}" in
      saved|SAVED|Saved)
        echo "Acknowledged interactively on $(date -u +"%Y-%m-%dT%H:%M:%SZ") by '$(whoami)'" \
          > "${INSTALL_DIR}/.lapseiq-master-key-saved"
        chmod 600 "${INSTALL_DIR}/.lapseiq-master-key-saved"
        ok "MASTER_KEY save acknowledged."
        ;;
      *)
        die "MASTER_KEY save not acknowledged — installation aborted.
Re-run install.sh after you've stored the key. The same key is in
${INSTALL_DIR}/.env if you need to recover it from this host."
        ;;
    esac
  fi
fi

# ── 5. Fetch the GHCR docker-compose override ────────────────────────────────
# This compose file references the published images instead of building from
# source. Lets the operator install without cloning the repo.
if [ ! -f docker-compose.yml ]; then
  info "Downloading docker-compose.yml (GHCR-image variant)…"
  curl -fsSL "${COMPOSE_URL_BASE}/docker-compose.ghcr.yml" -o docker-compose.yml
  ok "Compose file fetched."
fi

# ── 5.5. Verify image signatures (Pass-6 supply-chain hardening) ────────────
# If cosign is on PATH and a cosign.pub is available, cryptographically
# verify the GHCR images before pulling. If either is missing, warn loudly
# and continue — we don't want a fresh install to fail on a missing optional
# tool, but we do want the operator to see the gap so they can plug it.
#
# To enable strict verification (fail-closed instead of warn-and-continue):
#   LAPSEIQ_REQUIRE_COSIGN=1 bash install.sh
#
# Set up: download cosign.pub from the LapseIQ release page (or your own
# trusted out-of-band channel) and place it alongside install.sh, OR set
# COSIGN_PUB_URL to a URL the script can fetch. install.sh prefers a local
# cosign.pub over the URL because the local one is what the operator
# inspected before running.

verify_image_signature() {
  local image="$1"
  if ! command -v cosign >/dev/null 2>&1; then
    if [ "${LAPSEIQ_REQUIRE_COSIGN:-0}" = "1" ]; then
      die "LAPSEIQ_REQUIRE_COSIGN=1 but cosign is not installed. See https://docs.sigstore.dev/cosign/installation/"
    fi
    warn "cosign not found on PATH — skipping signature verification for $image."
    warn "  Recommend installing cosign before production use:"
    warn "    https://docs.sigstore.dev/cosign/installation/"
    return 0
  fi

  local pubkey=""
  if [ -f "./cosign.pub" ]; then
    pubkey="./cosign.pub"
  elif [ -f "${INSTALL_DIR}/cosign.pub" ]; then
    pubkey="${INSTALL_DIR}/cosign.pub"
  elif [ -n "${COSIGN_PUB_URL:-}" ]; then
    info "Fetching cosign public key from ${COSIGN_PUB_URL}…"
    if curl -fsSL "${COSIGN_PUB_URL}" -o "${INSTALL_DIR}/cosign.pub"; then
      pubkey="${INSTALL_DIR}/cosign.pub"
      ok "Public key downloaded to ${pubkey}"
    fi
  fi

  if [ -z "$pubkey" ]; then
    if [ "${LAPSEIQ_REQUIRE_COSIGN:-0}" = "1" ]; then
      die "LAPSEIQ_REQUIRE_COSIGN=1 but no cosign.pub found. Place one alongside install.sh or set COSIGN_PUB_URL."
    fi
    warn "No cosign.pub found alongside install.sh — skipping signature verification for $image."
    warn "  To enable: download the LapseIQ public key and place it at ${INSTALL_DIR}/cosign.pub"
    return 0
  fi

  info "Verifying $image with $pubkey…"
  if cosign verify --key "$pubkey" "$image" >/dev/null 2>&1; then
    ok "Signature verified for $image"
  else
    if [ "${LAPSEIQ_REQUIRE_COSIGN:-0}" = "1" ]; then
      die "Signature verification FAILED for $image. Refusing to pull. Possible tampering or stale public key."
    fi
    warn "Signature verification failed for $image. Continuing anyway (LAPSEIQ_REQUIRE_COSIGN=0)."
    warn "  This may indicate tampering or that signing is not yet configured on the publisher side."
  fi
}

info "Verifying GHCR image signatures (cosign)…"
verify_image_signature "$SERVER_IMAGE"
verify_image_signature "$CLIENT_IMAGE"

# ── 5.6. Pre-flight: port conflicts ─────────────────────────────────────────
# Without this check, a port already held by another process produces a
# cryptic Docker daemon error like:
#   "Error response from daemon: failed to set up container networking:
#    listen tcp 0.0.0.0:3001: bind: address already in use"
# which is no fun for a first-time operator. Surface it as plain English
# instead. We check the published ports from docker-compose.ghcr.yml.
port_in_use() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :${port}" 2>/dev/null | grep -q LISTEN
  elif command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"${port}" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -Eq ":${port}\$"
  else
    # No detection tool — silently skip; the Docker error path still fires.
    return 1
  fi
}

PORT_CONFLICTS=""
for p in 3001 5173; do
  if port_in_use "$p"; then
    PORT_CONFLICTS="${PORT_CONFLICTS} ${p}"
  fi
done
if [ -n "$PORT_CONFLICTS" ]; then
  warn "Port(s) already in use on this host:${PORT_CONFLICTS}"
  warn "  3001 is the LapseIQ API; 5173 is the web client. Both must be free."
  warn "  Find what's using them with:  sudo lsof -iTCP:3001 -sTCP:LISTEN"
  warn "  Then stop that process, OR override the published ports in"
  warn "  docker-compose.yml under the 'ports:' sections, then re-run."
  die "Aborting — refusing to attempt 'docker compose up' with port conflicts."
fi

# ── 6. Pull images ───────────────────────────────────────────────────────────
info "Pulling LapseIQ images from GHCR…"
docker pull "$SERVER_IMAGE"
docker pull "$CLIENT_IMAGE"

# ── 7. Bring it up ───────────────────────────────────────────────────────────
info "Starting the stack (db, server, client)…"
docker compose up -d

# ── 8. Health gate ───────────────────────────────────────────────────────────
info "Waiting for the API to come online…"
HEALTH_URL="http://localhost:${SERVER_PORT:-3001}/api/health"
for i in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    ok "API healthy at $HEALTH_URL"
    break
  fi
  if [ "$i" = 30 ]; then
    warn "API didn't respond at $HEALTH_URL within 30s. Run 'docker compose logs server' to investigate."
    break
  fi
  sleep 1
done

# ── 9. Done ─────────────────────────────────────────────────────────────────
# Pass-5 F-SH-02 fix: the printed "next step" URL must not be the public
# HTTPS domain unless TLS is actually configured. If the operator entered
# a public domain at the prompt above, $DOMAIN now looks like
# `https://lapseiq.example.com` — but Caddy / Let's Encrypt is Step 4 of
# the install.html walkthrough, which install.sh deliberately does not
# handle. Printing the https:// URL here used to send operators to a
# connection-refused error and look like a failed install.
#
# Branch on $DOMAIN: localhost → no TLS step needed; anything else →
# print a three-step checklist that lets the operator verify the stack
# on localhost first, then complete TLS, then open the public URL.
LOCAL_SETUP_URL="http://localhost:${CLIENT_PORT:-5173}/setup"
PUBLIC_SETUP_URL="${DOMAIN%/}/setup"

printf "\n${C_GREEN}${C_BOLD}LapseIQ is installed.${C_RESET}\n\n"

case "$DOMAIN" in
  http://localhost*|http://127.0.0.1*)
    cat <<EOF
Next step: open the setup wizard and create your admin account:

  ${C_BOLD}${LOCAL_SETUP_URL}${C_RESET}

EOF
    ;;
  *)
    cat <<EOF
${C_YELLOW}!${C_RESET} ${C_BOLD}Two more steps before the public URL is reachable.${C_RESET}
   ${C_DIM}(TLS + reverse-proxy aren't part of install.sh — that's Step 4 of the walkthrough.)${C_RESET}

  ${C_BOLD}1. Verify the stack is healthy locally on this host:${C_RESET}
        curl -fsS http://localhost:${SERVER_PORT:-3001}/api/health
        open ${LOCAL_SETUP_URL} in a browser on this host
        (or open via SSH tunnel:  ssh -L 5173:localhost:5173 user@host)

  ${C_BOLD}2. Configure TLS / reverse-proxy with Caddy (Step 4 of the walkthrough):${C_RESET}
        https://lapseiq.com/install#step-4
        — DNS for ${DOMAIN#https://} must already resolve to this host.
        — Caddy will obtain a Let's Encrypt certificate on first reload
          (typically 30-60 seconds after dropping in the Caddyfile).

  ${C_BOLD}3. Then open the public setup wizard URL:${C_RESET}
        ${C_BOLD}${PUBLIC_SETUP_URL}${C_RESET}

${C_DIM}Skip step 2 only if you already have TLS / a reverse-proxy in front
of this host. Otherwise ${PUBLIC_SETUP_URL} will fail with
connection-refused (or a Cloudflare 522) until Caddy is reloaded.${C_RESET}

EOF
    ;;
esac

cat <<EOF
Operational hints:

  - Logs:           docker compose logs -f server
  - Stop:           docker compose down
  - Update images:  docker compose pull && docker compose up -d
  - Backups:        nightly pg_dump.gz lands in ./backups (retention 30 days)
  - .env location:  $INSTALL_DIR/.env  (mode 600 — back this up off-box)
  - MASTER_KEY:     also in your password manager (acknowledged at install)

${C_DIM}Source + docs: https://lapseiq.com  ·  Security disclosure: support@lapseiq.com${C_RESET}
EOF
