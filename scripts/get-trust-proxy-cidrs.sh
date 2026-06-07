#!/usr/bin/env bash
# scripts/get-trust-proxy-cidrs.sh
# --------------------------------
# Pass-7 helper: prints a paste-ready TRUST_PROXY value for a Cloudflare-
# fronted self-hosted deployment. Pulls the canonical Cloudflare IP ranges
# from cloudflare.com and combines them with localhost + the standard
# Docker bridge subnets so the on-host reverse-proxy hop and the CF edge
# are both trusted by Express.
#
# Usage:
#   bash scripts/get-trust-proxy-cidrs.sh
#   bash scripts/get-trust-proxy-cidrs.sh > /tmp/trust_proxy.txt
#
# Then paste the single-line output into your .env file as:
#   TRUST_PROXY=127.0.0.1,172.16.0.0/12,...,2400:cb00::/32,...
#
# Operators not running behind Cloudflare can drop the CF lines and keep
# only 127.0.0.1 + 172.16.0.0/12 (or whatever their proxy's network CIDR
# is). See server/.env.example for the full pattern reference.
#
# Re-run this script periodically (cron weekly is fine) and update .env
# whenever Cloudflare expands their published ranges.

set -euo pipefail

CF_V4_URL="https://www.cloudflare.com/ips-v4"
CF_V6_URL="https://www.cloudflare.com/ips-v6"

command -v curl >/dev/null 2>&1 || {
  echo "ERROR: curl is required." >&2
  exit 1
}

# Always trust the on-host loopback (Caddy/nginx/Traefik on the same VPS
# typically forward via 127.0.0.1) and the standard Docker bridge subnet.
LOCAL_CIDRS=( "127.0.0.1" "172.16.0.0/12" )

CF_V4="$(curl -fsSL "$CF_V4_URL" | tr '\n' ' ' | sed 's/ $//')"
CF_V6="$(curl -fsSL "$CF_V6_URL" | tr '\n' ' ' | sed 's/ $//')"

if [ -z "$CF_V4" ] || [ -z "$CF_V6" ]; then
  echo "ERROR: failed to fetch Cloudflare IP ranges." >&2
  exit 1
fi

# Emit one comma-separated line.
{
  for c in "${LOCAL_CIDRS[@]}"; do printf '%s\n' "$c"; done
  echo "$CF_V4" | tr ' ' '\n'
  echo "$CF_V6" | tr ' ' '\n'
} | grep -v '^$' | tr '\n' ',' | sed 's/,$/\n/'
