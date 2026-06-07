<#
.SYNOPSIS
    Manual GHCR build + push for the LapseIQ server + client images.
    Bypasses GitHub Actions CI when you don't feel like waiting on the queue.

.DESCRIPTION
    Builds linux/amd64 images (DigitalOcean droplets are amd64) and pushes
    both with the supplied tag. Mirrors the matrix in
    .github/workflows/release.yml so the resulting images are byte-equivalent
    to what CI would produce.

    v0.33.0 (Pass-5 Theme A): the client build now runs `npm ci && npm run
    build` HERE on Windows before invoking docker buildx, with the same
    VITE_API_URL='' env var and the same bundle-size + localhost-grep
    guards CI uses. Without this, the manual fallback shipped a broken
    bundle on 2026-05-17 that hardcoded http://localhost:3001 because
    Vite was run inside the Docker stage with no env injection. The
    manual fallback now matches CI's coverage exactly.

    Pre-requirements:
      1. Docker Desktop running on Windows with buildx enabled.
      2. Node 20+ on PATH (for the client pre-build).
      3. GHCR PAT available via one of:
           - $env:GHCR_PAT
           - $env:GITHUB_TOKEN
           - already logged in via `docker login ghcr.io`
         If none are set, the script will prompt.
      4. Working directory = the LapseIQ repo root.

.PARAMETER Tag
    The version tag, e.g. "v0.32.4". Required. Both server + client images
    get pushed with this exact tag plus a 'latest' alias if -Latest is set.

.PARAMETER Latest
    Also push the :latest alias for both images. Default off — leaving
    :latest pointed at whatever the prior release built so a half-done
    manual push doesn't leak forward.

.PARAMETER Server
    Push only the server image. Skip the client build.

.PARAMETER Client
    Push only the client image. Skip the server build.

.PARAMETER SkipClientBuild
    Skip `npm ci && npm run build` and use the dist/ already present in
    .\client\dist. Useful when iterating on the Dockerfile and the SPA
    bundle is known-good. The bundle-size + localhost-grep guards still
    run against the existing dist/ before docker buildx.

.EXAMPLE
    .\scripts\manual-ghcr-push.ps1 -Tag v0.32.4
        Build + push BOTH images at v0.32.4. Leaves :latest alone.

.EXAMPLE
    .\scripts\manual-ghcr-push.ps1 -Tag v0.32.4 -Server
        Push only the server image. Useful when only server-side changes
        landed in the new release.

.EXAMPLE
    .\scripts\manual-ghcr-push.ps1 -Tag v0.32.5 -Latest
        Push v0.32.5 AND repoint :latest. Use when this is a real release
        intended to be the new rolling-update default for self-host pulls.
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^v\d+\.\d+\.\d+(-.+)?$')]
  [string]$Tag,
  [switch]$Latest,
  [switch]$Server,
  [switch]$Client,
  [switch]$SkipClientBuild
)

$ErrorActionPreference = 'Stop'
$OWNER = 'forgerift'
$REGISTRY = 'ghcr.io'

function Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}
function Ok([string]$msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "    FAIL: $msg" -ForegroundColor Red; exit 1 }

# ── 0. Sanity checks ────────────────────────────────────────────────────────
Step "Pre-flight checks"

if (-not (Test-Path '.\server\Dockerfile')) {
  Fail "Run this script from the LapseIQ repo root (no ./server/Dockerfile found here)."
}
if (-not (Test-Path '.\client\Dockerfile.prod')) {
  Fail "Run this script from the LapseIQ repo root (no ./client/Dockerfile.prod found here)."
}

try {
  docker version --format '{{.Server.Version}}' | Out-Null
} catch {
  Fail "Docker Desktop is not running. Start it and re-run."
}

$buildx = & docker buildx version 2>$null
if (-not $buildx) {
  Fail "Docker buildx is not installed. Enable buildx in Docker Desktop and re-run."
}

Ok "Repo + Docker + buildx ready."

# Decide which images to push.
$BuildServer = (-not $Client) -or $Server
$BuildClient = (-not $Server) -or $Client

# ── 1. Authenticate to GHCR ─────────────────────────────────────────────────
Step "Authenticate to ${REGISTRY}"

$token = $env:GHCR_PAT
if (-not $token) { $token = $env:GITHUB_TOKEN }

if ($token) {
  $token | & docker login $REGISTRY -u $OWNER --password-stdin | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "docker login failed with the provided token." }
  Ok "Logged in as ${OWNER} via token env var."
} else {
  # Probe whether already logged in by attempting a no-op auth check.
  Warn "No GHCR_PAT or GITHUB_TOKEN env var set."
  Warn "If you've previously run 'docker login ghcr.io' on this machine the push will still succeed."
  Warn "Otherwise: set `$env:GHCR_PAT to a PAT with 'write:packages' scope and re-run."
}

# ── 2. Build + push server ──────────────────────────────────────────────────
if ($BuildServer) {
  Step "Build + push lapseiq-server:${Tag}"

  $tagArgs = @("--tag", "${REGISTRY}/${OWNER}/lapseiq-server:${Tag}")
  if ($Latest) { $tagArgs += @("--tag", "${REGISTRY}/${OWNER}/lapseiq-server:latest") }

  docker buildx build `
    --platform linux/amd64 `
    --file .\server\Dockerfile `
    @tagArgs `
    --push `
    .\server
  if ($LASTEXITCODE -ne 0) { Fail "Server build/push failed." }
  Ok "lapseiq-server:${Tag} pushed."
}

# ── 3. Build + push client ──────────────────────────────────────────────────
if ($BuildClient) {
  # ── 3a. Pre-build the Vite dist on Windows (v0.33.0, Pass-5 Theme A) ────
  # Dockerfile.prod expects dist/ to already exist in the build context
  # (the multi-stage Vite build inside node:20-alpine produces a broken
  # 185KB stub — see v0.5.3 incident notes in the Dockerfile). CI's
  # release.yml runs the build on the GH Ubuntu runner with the
  # VITE_API_URL='' env var; the manual fallback used to delegate this
  # to docker buildx and silently shipped a broken bundle on 2026-05-17
  # because VITE_API_URL never reached Vite.
  #
  # We now mirror CI's sequence exactly: install deps, build with
  # VITE_API_URL='', then enforce the same two guards CI enforces:
  #   - total dist/assets/*.js byte count above the stub threshold
  #   - no hardcoded http://localhost:3001 in any chunk
  #
  # Operators who already have a known-good dist/ can pass
  # -SkipClientBuild to skip the npm phase and just re-run the guards
  # against the existing dist before the docker build.
  if (-not $SkipClientBuild) {
    Step "Pre-build client dist (npm ci && npm run build) on Windows"

    $node = (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $node) {
      Fail "Node is not on PATH. Install Node 20+ or pass -SkipClientBuild if dist/ is already known good."
    }
    Push-Location .\client
    try {
      $env:VITE_API_URL = ''   # CI uses '' for same-origin API calls
      & npm ci
      if ($LASTEXITCODE -ne 0) { Fail "npm ci failed in client/." }
      & npm run build
      if ($LASTEXITCODE -ne 0) { Fail "npm run build failed in client/." }
    } finally {
      Pop-Location
      Remove-Item Env:\VITE_API_URL -ErrorAction SilentlyContinue
    }
    Ok "client/dist built."
  } else {
    Warn "-SkipClientBuild: using existing client/dist (guards still run)."
  }

  # ── 3b. Bundle-size + localhost-regression guards ──────────────────────
  # Mirrors release.yml's "Build client dist on runner" step. These run
  # whether or not we just built the dist, so even -SkipClientBuild can't
  # ship a broken bundle.
  Step "Guard: client bundle size + VITE_API_URL regression"

  $distAssets = '.\client\dist\assets'
  if (-not (Test-Path $distAssets)) {
    Fail "Expected $distAssets to exist. Did the build complete? Try without -SkipClientBuild."
  }
  $jsFiles = Get-ChildItem -Path $distAssets -Filter '*.js' -File
  if ($jsFiles.Count -eq 0) {
    Fail "$distAssets contains no *.js files."
  }
  $totalBytes = ($jsFiles | Measure-Object -Property Length -Sum).Sum
  Write-Host ("    Built JS total: {0:N0} bytes across {1} chunks" -f $totalBytes, $jsFiles.Count)
  if ($totalBytes -lt 800000) {
    Fail "Total JS dist is only $totalBytes bytes - broken build, refusing to ship."
  }
  $localhostHits = $jsFiles | Where-Object {
    Select-String -Path $_.FullName -Pattern 'http://localhost:3001' -SimpleMatch -Quiet
  }
  if ($localhostHits) {
    Fail "Bundle contains hardcoded http://localhost:3001 — VITE_API_URL wasn't set at build time. Hits in: $($localhostHits.Name -join ', ')"
  }
  Ok "Bundle guards passed: size + no localhost regression."

  # ── 3c. Build + push the image ─────────────────────────────────────────
  Step "Build + push lapseiq-client:${Tag}"

  $tagArgs = @("--tag", "${REGISTRY}/${OWNER}/lapseiq-client:${Tag}")
  if ($Latest) { $tagArgs += @("--tag", "${REGISTRY}/${OWNER}/lapseiq-client:latest") }

  docker buildx build `
    --platform linux/amd64 `
    --file .\client\Dockerfile.prod `
    @tagArgs `
    --push `
    .\client
  if ($LASTEXITCODE -ne 0) { Fail "Client build/push failed." }
  Ok "lapseiq-client:${Tag} pushed."
}

# ── 4. Done ─────────────────────────────────────────────────────────────────
Step "Done"
Write-Host ""
Write-Host "Verify on the droplet with:" -ForegroundColor Cyan
Write-Host "  docker manifest inspect ${REGISTRY}/${OWNER}/lapseiq-server:${Tag}" -ForegroundColor Gray
Write-Host "  docker manifest inspect ${REGISTRY}/${OWNER}/lapseiq-client:${Tag}" -ForegroundColor Gray
Write-Host ""
Write-Host "Then on the droplet:" -ForegroundColor Cyan
Write-Host "  cd /root/lapseiq" -ForegroundColor Gray
Write-Host "  sed -i 's/^LAPSEIQ_VERSION=.*/LAPSEIQ_VERSION=${Tag}/' .env" -ForegroundColor Gray
Write-Host "  docker compose -f docker-compose.ghcr.yml pull" -ForegroundColor Gray
Write-Host "  docker compose -f docker-compose.ghcr.yml up -d" -ForegroundColor Gray
