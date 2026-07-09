# syntax=docker/dockerfile:1.6
#
# ServiceCycle server image â€” Sprint 5 (B1) production-grade rebuild.
#
# Two-stage build:
#   1. deps  â€” installs dependencies and generates the Prisma client. Runs
#              as root so npm/prisma can write into node_modules and
#              hit /tmp without permission warnings.
#   2. runtime â€” slim image carrying only what the tsx runtime needs.
#                Drops to USER node so the Node process never has root
#                inside the container â€” limits the blast radius if a
#                dependency is compromised.
#
# Build-time tools that are NOT shipped in the runtime image:
#   - npm cache (~150 MB)
#   - Prisma engines for non-target platforms
#   - C build toolchains pulled in by sharp/bcryptjs binary fallbacks
#
# Runtime tools that ARE shipped (kept deliberately):
#   - openssl       â€” required by Prisma at startup
#   - postgresql-client (pg_dump) â€” used by lib/backup.js daily cron
#   - wget          â€” used by HEALTHCHECK below
#
# tsx is in dependencies (not devDependencies) so it survives npm prune
# and is available in the runtime stage.
#

# -- Stage 1: deps ------------------------------------------------------------
# Debian (node:20-slim), NOT Alpine: the Prisma engine generated here must match
# the runtime libc (glibc), and the extractor's pypdfium2 needs manylinux wheels.
FROM node:20-slim AS deps

WORKDIR /app

# Build deps for native modules (sharp, bcryptjs etc.). Discarded at end of
# the deps stage â€” never copied into runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ openssl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# `npm ci` is reproducible and fails fast on lockfile drift. We keep dev deps
# here so prisma generate has access to the prisma CLI without --include=dev
# tricks downstream. .npmrc sets ignore-scripts=true repo-wide (2026-07-08
# AI-code-security hardening) so a compromised/malicious transitive dep can't
# run arbitrary code at install time -- but that also skips the install/
# postinstall/preinstall scripts of packages that legitimately need them to
# fetch a platform-specific prebuilt native binary. Audited node_modules for
# every package with such a script (server/.npmrc header has the full list,
# 6 total): of those, sharp, esbuild (tsx's transform engine -- it's in
# tsx's own dependencies, not devDependencies, so it survives the
# `npm prune --omit=dev` below), @prisma/client, @prisma/engines, and prisma
# (CLI) are all reachable from production dependencies and matter here;
# unrs-resolver is jest-only (`npm ls unrs-resolver --omit=dev` -> empty)
# and gets pruned away, so it's a local-dev-only concern, not a production
# one. `npm rebuild <pkg>` explicitly re-runs a named package's lifecycle
# scripts regardless of the ignore-scripts config (that config only
# suppresses the *automatic* run during install/ci) -- this is the
# documented pattern for exactly this ignore-scripts-plus-selective-exception
# setup.
RUN npm ci \
 && npm rebuild sharp esbuild @prisma/client @prisma/engines prisma --foreground-scripts

# Prisma needs the schema present to generate the client. Copy schema only â€”
# the rest of the source comes in the runtime stage so this layer caches well.
COPY prisma ./prisma
RUN npx prisma generate

# Strip dev deps now that the Prisma client is generated. tsx is in
# dependencies so it survives this prune and is available in the runtime stage.
RUN npm prune --omit=dev


# -- Stage 2: runtime ---------------------------------------------------------
FROM node:20-slim AS runtime

# Runtime-only system deps:
#   openssl              -- Prisma probes for libssl at boot
#   postgresql-client-16 -- pg_dump used by lib/backup.js (cron 02:00). Version-
#                           pinned to match db's postgres:16-alpine (see
#                           docker-compose.yml): pg_dump refuses to dump a
#                           server with a NEWER major version than itself, and
#                           Debian bookworm's own default repo only ships the
#                           PG15 client, so the old unversioned
#                           `postgresql-client` package silently resolved to
#                           an incompatible pg_dump (found 2026-07-08 -- every
#                           nightly backup was failing with "aborting because
#                           of server version mismatch", separate from and
#                           unmasked by the fix-perms bug fixed earlier the
#                           same day). Sourced from the official PGDG apt repo
#                           per postgresql.org/download/linux/debian.
#                           NOTE: if db's image ever moves to postgres:17+,
#                           this pin must move with it or backups break again.
#   wget                  -- HEALTHCHECK
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc --fail \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && . /etc/os-release \
 && printf 'Types: deb\nURIs: https://apt.postgresql.org/pub/repos/apt\nSuites: %s-pgdg\nArchitectures: %s\nComponents: main\nSigned-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc\n' \
      "$VERSION_CODENAME" "$(dpkg --print-architecture)" \
      > /etc/apt/sources.list.d/pgdg.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      openssl postgresql-client-16 wget \
      python3 python3-pip tesseract-ocr \
 && rm -rf /var/lib/apt/lists/*

# Python extractor ENABLED on Debian: pypdfium2 ships manylinux/glibc wheels
# (unlike Alpine/musl), so pdfplumber's PowerDB grid parser + Tesseract OCR run
# in prod instead of falling back to the pdfjs parser. --break-system-packages is
# the container-appropriate way past Debian bookworm's PEP-668 lock. requirements
# copied first so this layer caches independently of the app source.
COPY pyextract/requirements.txt /app/pyextract/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r /app/pyextract/requirements.txt

# Run as the unprivileged `node` user shipped in the base image.
# /app is owned by node so the process can write to ./uploads and ./backups
# when those are bind-mounted.
WORKDIR /app

# Copy node_modules + generated Prisma client from the deps stage.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/prisma       ./prisma

# Copy application source. Everything else (env, uploads, backups, logs) is
# excluded by .dockerignore at the repo root.
COPY --chown=node:node . .

# SBOM (2026-05-03 audit). The repository's most recent SBOM (CycloneDX +
# SPDX, generated by syft) is shipped at /app/sbom/ inside the image so
# customers running this image can verify what they're consuming without
# scanning the filesystem themselves. The source of truth lives at
# docs/security/scans/<date>/sbom-server.* in the repo; `npm run sbom:sync`
# copies it into server/sbom/ before the docker build (the build context
# is ./server, so the SBOM has to be inside this directory at build time).
# Operators can pull the SBOM out via:
#     docker cp $(docker create servicecycle-server):/app/sbom ./sbom
COPY --chown=node:node sbom/ /app/sbom/

# Pre-create the bind-mount targets so they exist (and are writable by the
# node user) even when the operator doesn't bind-mount them.
RUN mkdir -p /app/uploads /app/backups && chown -R node:node /app/uploads /app/backups

USER node

EXPOSE 3001

# HEALTHCHECK â€” exercises /api/ready (real DB probe, not just liveness).
# Pre-2026-05-16 this checked /api/health which returns 200 unconditionally
# even when Postgres is down (audit Cluster C P0). /api/ready returns 503
# if the DB is unreachable, so Docker correctly marks the container
# unhealthy and the next restart cycle can recover. Three consecutive
# failures still required to flip the state (handles transient blips).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/ready || exit 1

# Run the TypeScript server via tsx (CommonJS-compatible TS runtime).
# tsx is in dependencies so it survives npm prune in the deps stage.
# S4-FN-01 (v0.75.x): migrations are run by the server-migrate init
# container (Dockerfile.migrate / entrypoint.migrate.sh). The API container
# starts only after service_completed_successfully on server-migrate.
CMD ["node", "node_modules/tsx/dist/cli.mjs", "index.ts"]