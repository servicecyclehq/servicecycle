#!/usr/bin/env bash
# Generates a .env + seaweedfs-s3-config.json for the Probo deploy prep in
# this folder. Run ONCE per environment, on the target droplet, right before
# the first `docker compose up -d` — not before, since re-running overwrites
# previously-generated secrets and would orphan any data already encrypted
# with the old PROBOD_ENCRYPTION_KEY.
#
# NOT run tonight (2026-07-07) — this is prep, no droplet exists yet to run
# it on. Kept here so standing this up later is a copy-paste-run, not a
# from-scratch research task.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f .env ]; then
  echo "Refusing to overwrite an existing .env -- delete it first if you really want to regenerate secrets." >&2
  exit 1
fi

SEAWEEDFS_ACCESS_KEY=$(openssl rand -hex 16)
SEAWEEDFS_SECRET_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -base64 24)

cat > .env <<EOF
# Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) -- keep this file out of git (see .gitignore in this folder).

# --- Probo core secrets ---
PROBOD_ENCRYPTION_KEY=$(openssl rand -base64 32)
AUTH_COOKIE_SECRET=$(openssl rand -base64 32)
AUTH_PASSWORD_PEPPER=$(openssl rand -base64 32)
TRUST_AUTH_TOKEN_SECRET=$(openssl rand -base64 32)

# --- Fill these in before first run ---
PROBOD_BASE_URL=https://CHANGE-ME.example.com
SMTP_ADDR=smtp.CHANGE-ME.example.com:587
SMTP_USER=CHANGE-ME
SMTP_PASSWORD=CHANGE-ME
MAILER_SENDER_EMAIL=no-reply@CHANGE-ME.example.com

# --- Generated, don't touch ---
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
SEAWEEDFS_ACCESS_KEY=${SEAWEEDFS_ACCESS_KEY}
SEAWEEDFS_SECRET_KEY=${SEAWEEDFS_SECRET_KEY}
EOF

cat > seaweedfs-s3-config.json <<EOF
{
  "identities": [
    {
      "name": "probod",
      "credentials": [{"accessKey": "${SEAWEEDFS_ACCESS_KEY}", "secretKey": "${SEAWEEDFS_SECRET_KEY}"}],
      "actions": ["Admin", "Read", "Write"]
    }
  ]
}
EOF

chmod 600 .env seaweedfs-s3-config.json
echo "Wrote .env and seaweedfs-s3-config.json. Edit the CHANGE-ME values in .env before 'docker compose up -d'."
