# ============================================================================
# LapseIQ - One-line installer for Windows (Docker Desktop)
# ============================================================================
#
# Pulls pre-built Docker images from GHCR, generates the required secrets,
# writes .env, brings up the stack, and prints the setup-wizard URL.
#
# Mirrors scripts/install.sh semantics for Windows operators. Requires Docker
# Desktop with the WSL 2 or Hyper-V backend, running and reachable on the
# Docker named pipe / TCP socket.
#
# Recommended usage (inspect-then-run):
#
#   iwr -useb https://lapseiq.com/install.ps1 -o install.ps1
#   notepad install.ps1                                # read what it does
#   pwsh -ExecutionPolicy Bypass -File .\install.ps1
#
# Or, if you trust this project, the one-liner is:
#
#   iex (iwr -useb https://lapseiq.com/install.ps1).Content
#
# Idempotent: re-running on an existing install reuses the existing .env and
# does NOT regenerate secrets (would invalidate every encrypted backup and
# document on disk).
# ============================================================================

[CmdletBinding()]
param(
    [switch]$Yes,
    [switch]$AcceptEula,
    [string]$InstallDir = (Join-Path $PWD 'lapseiq'),
    [string]$ComposeUrlBase = 'https://lapseiq.com',
    [string]$GhcrOwner = 'forgerift',
    [string]$EulaUrl = 'https://lapseiq.com/eula'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$ServerImage = "ghcr.io/$GhcrOwner/lapseiq-server:latest"
$ClientImage = "ghcr.io/$GhcrOwner/lapseiq-client:latest"

# --- Tiny logging helpers ---------------------------------------------------
function Write-Info($m)  { Write-Host "==> $m" -ForegroundColor Blue }
function Write-Ok($m)    { Write-Host "[ok] $m" -ForegroundColor Green }
function Write-Warn2($m) { Write-Host "[!] $m"  -ForegroundColor Yellow }
function Write-Err($m)   { Write-Host "[x] $m"  -ForegroundColor Red; throw $m }

# --- 0. Banner --------------------------------------------------------------
Write-Host ""
Write-Host "LapseIQ" -ForegroundColor White -NoNewline
Write-Host " - self-hosted contract renewal management"
Write-Host "Installer (PowerShell) - this is a script, not a service. Everything runs on your box." -ForegroundColor DarkGray
Write-Host "EULA: $EulaUrl  -  License will be confirmed before any work begins." -ForegroundColor DarkGray
Write-Host ""

# --- 0.5. EULA acceptance ---------------------------------------------------
$eulaMarker = Join-Path $InstallDir '.lapseiq-eula-accepted'
$accept = $Yes -or $AcceptEula -or ($env:LAPSEIQ_ACCEPT_EULA -eq '1')

if (Test-Path $eulaMarker) {
    Write-Ok "EULA already accepted (see $eulaMarker)."
} elseif ($accept) {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    "Accepted via -Yes / LAPSEIQ_ACCEPT_EULA=1 on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')" | Set-Content $eulaMarker
    Write-Ok "EULA accepted non-interactively."
} else {
    Write-Host "LapseIQ End-User License Agreement" -ForegroundColor White
    Write-Host ""
    Write-Host "Before installing, please review the LapseIQ EULA:"
    Write-Host "  $EulaUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "Highlights (full text at the URL above governs):"
    Write-Host "  - Self-hosted; no telemetry, no phone-home, no license-validation callback."
    Write-Host "  - Internal-business-use only. No reselling, sublicensing, or building a"
    Write-Host "    competing product. No reverse engineering (except as legally permitted)."
    Write-Host "  - AS-IS, no warranty. Liability cap is the greater of USD `$100 or fees paid"
    Write-Host "    in the prior 12 months. AI outputs require human review."
    Write-Host "  - Wisconsin governing law. Either party can terminate on 90 days notice."
    Write-Host "  - Your data is yours. ForgeRift does not host, store, or have routine"
    Write-Host "    access to anything you process through the Software."
    Write-Host ""

    if (-not [Environment]::UserInteractive -or [Console]::IsInputRedirected) {
        Write-Host "Non-interactive install detected and the EULA has not been accepted." -ForegroundColor Red
        Write-Host "Re-run with one of:"
        Write-Host "  -Yes                        pwsh -File install.ps1 -Yes"
        Write-Host "  LAPSEIQ_ACCEPT_EULA=1       `$env:LAPSEIQ_ACCEPT_EULA=1; pwsh -File install.ps1"
        Write-Host "Both signal acceptance of the EULA at $EulaUrl." -ForegroundColor DarkGray
        exit 1
    }

    $reply = Read-Host "Type 'yes' to accept the EULA and continue (anything else aborts)"
    if ($reply -notin @('yes','YES','Yes','y','Y')) {
        Write-Err "EULA not accepted - installation aborted."
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    "Accepted interactively on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ') by '$(whoami)'" | Set-Content $eulaMarker
    Write-Ok "EULA accepted (logged to $eulaMarker)."
}

# --- 1. Host detection ------------------------------------------------------
Write-Info "Detected: $($PSVersionTable.OS) / $($PSVersionTable.Platform)"

# --- 2. Docker presence -----------------------------------------------------
$dockerExe = (Get-Command docker -ErrorAction SilentlyContinue)
if (-not $dockerExe) {
    Write-Err "Docker not found on PATH. Install Docker Desktop from https://docker.com/products/docker-desktop, start it, then re-run this installer."
}
try {
    docker version --format '{{.Server.Version}}' | Out-Null
} catch {
    Write-Err "Docker is installed but the daemon is not reachable. Start Docker Desktop and wait for the whale icon to settle, then re-run."
}
Write-Ok "Docker daemon reachable."

# Compose v2 plugin check ('docker compose', NOT 'docker-compose')
try {
    docker compose version --short | Out-Null
    Write-Ok "Docker Compose v2 plugin present."
} catch {
    Write-Err "Docker Compose v2 plugin not found. Update Docker Desktop to a recent version (Compose v2 is bundled since 2022)."
}

# --- 3. Working directory ---------------------------------------------------
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Set-Location $InstallDir
Write-Info "Working directory: $InstallDir"

# --- 4. Reuse existing .env or build a fresh one ---------------------------
$envPath = Join-Path $InstallDir '.env'
$domain = $null
if (Test-Path $envPath) {
    Write-Warn2 ".env already present - reusing existing values (safer than rotating MASTER_KEY)."
    Write-Warn2 "If you want a clean slate, move .env aside, remove uploads\, 'docker compose down -v', then re-run."

    # Pull CLIENT_URL from existing .env so the post-install message points
    # somewhere sensible (and so the F-SH-02 https-before-TLS guidance below
    # works for re-runs too). Fall back to localhost default if missing.
    $clientUrlLine = Get-Content $envPath -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '^CLIENT_URL=' } |
        Select-Object -First 1
    if ($clientUrlLine) {
        $domain = $clientUrlLine -replace '^CLIENT_URL=',''
    } else {
        $domain = 'http://localhost:5173'
    }
} else {
    Write-Info "Building a fresh .env. You'll be prompted for a few values."

    $domain = Read-Host "Public domain (e.g. lapseiq.example.com) [http://localhost:5173]"
    if ([string]::IsNullOrWhiteSpace($domain)) { $domain = 'http://localhost:5173' }
    if ($domain -notmatch '^https?://') { $domain = "https://$domain" }

    $adminEmail = Read-Host "Admin email address (used by setup wizard)"
    if ([string]::IsNullOrWhiteSpace($adminEmail)) {
        Write-Err "Admin email is required."
    }

    $brevoKey = Read-Host "Brevo API key for transactional email (leave blank to skip - emails will log to stdout)"

    Write-Info "Generating secrets via .NET RandomNumberGenerator..."
    function New-RandomBase64 {
        param([int]$Bytes)
        $b = New-Object byte[] $Bytes
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
        return [Convert]::ToBase64String($b)
    }

    # POSTGRES_PASSWORD - strip non-alphanumerics for shell-safe value
    $postgresPassword = ((New-RandomBase64 -Bytes 24) -replace '[^A-Za-z0-9]','').Substring(0, 32)
    $jwtSecret  = New-RandomBase64 -Bytes 48
    $masterKey  = New-RandomBase64 -Bytes 32

    if ([string]::IsNullOrWhiteSpace($brevoKey)) {
        $emailMockVal = 'true'
        $emailFromVal = ''
    } else {
        $emailMockVal = 'false'
        $domainHost = $domain -replace '^https?://',''
        $emailFromVal = "LapseIQ <noreply@$domainHost>"
    }

    @"
# Generated by install.ps1 on $(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssZ')
# DO NOT commit this file. Treat MASTER_KEY like a production credential -
# rotating it makes every encrypted document and backup unreadable.

NODE_ENV=production
CLIENT_URL=$domain
TRUST_PROXY=true

POSTGRES_USER=lapseiq
POSTGRES_DB=lapseiq
POSTGRES_PASSWORD=$postgresPassword
DATABASE_URL=postgresql://lapseiq:$postgresPassword@db:5432/lapseiq

JWT_SECRET=$jwtSecret
MASTER_KEY=$masterKey

# Email - Brevo if a key was provided, EMAIL_MOCK otherwise
EMAIL_MOCK=$emailMockVal
BREVO_API_KEY=$brevoKey
EMAIL_FROM=$emailFromVal
SUPPORT_EMAIL=$adminEmail

# Storage / backup - both default to local disk on the host
STORAGE_DEST=local
BACKUP_DEST=local

# AI - opt in by setting AI_ENABLED=true and AI_API_KEY=sk-ant-...
AI_ENABLED=false

# Telemetry: there is none. This block exists to make that explicit.
"@ | Set-Content -Encoding UTF8 -Path $envPath

    Write-Ok "Wrote .env (secrets generated)."
}

# --- 5. Fetch the GHCR docker-compose override -----------------------------
$composePath = Join-Path $InstallDir 'docker-compose.yml'
if (-not (Test-Path $composePath)) {
    Write-Info "Downloading docker-compose.yml (GHCR-image variant)..."
    Invoke-WebRequest -Uri "$ComposeUrlBase/docker-compose.ghcr.yml" -OutFile $composePath -UseBasicParsing
    Write-Ok "Compose file fetched."
}

# --- 5.5. Pre-flight: port conflicts ---------------------------------------
# Mirrors the port-conflict check that install.sh got in v0.6.x. Without it,
# a port already in use produces a cryptic Docker daemon error rather than
# a plain-English diagnosis.
$portConflicts = @()
foreach ($p in 3001, 5173) {
    $listen = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
    if ($listen) { $portConflicts += $p }
}
if ($portConflicts.Count -gt 0) {
    Write-Warn2 "Port(s) already in use on this host: $($portConflicts -join ', ')"
    Write-Warn2 "  3001 is the LapseIQ API; 5173 is the web client. Both must be free."
    Write-Warn2 "  Find what's using them with:"
    Write-Warn2 "    Get-NetTCPConnection -LocalPort 3001 | Select-Object OwningProcess"
    Write-Warn2 "  Then stop that process, OR override the published ports in"
    Write-Warn2 "  docker-compose.yml under the 'ports:' sections, then re-run."
    Write-Err "Aborting - refusing to attempt 'docker compose up' with port conflicts."
}

# --- 6. Pull images --------------------------------------------------------
Write-Info "Pulling LapseIQ images from GHCR..."
docker pull $ServerImage
docker pull $ClientImage

# --- 7. Bring it up --------------------------------------------------------
Write-Info "Starting the stack (db, server, client)..."
docker compose up -d

# --- 8. Health gate --------------------------------------------------------
$healthUrl = "http://localhost:3001/api/health"
Write-Info "Waiting for the API to come online..."
$ready = $false
for ($i = 1; $i -le 30; $i++) {
    try {
        $r = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1 -ErrorAction Stop
        if ($r.success) { $ready = $true; Write-Ok "API healthy at $healthUrl"; break }
    } catch { }
    Start-Sleep -Seconds 1
}
if (-not $ready) {
    Write-Warn2 "API didn't respond at $healthUrl within 30s. Run 'docker compose logs server' to investigate."
}

# --- 9. Done ---------------------------------------------------------------
# Pass-5 F-SH-02 fix: the printed "next step" URL must not be the public
# HTTPS domain unless TLS is actually configured. If the operator entered
# a public domain at the prompt above, $domain now looks like
# 'https://lapseiq.example.com' - but Caddy / Let's Encrypt is Step 4 of
# the install.html walkthrough, which install.ps1 deliberately does not
# handle. Printing the https URL here used to send operators to a
# connection-refused error and look like a failed install.
#
# Branch on $domain: localhost -> no TLS step needed; anything else ->
# print a three-step checklist that lets the operator verify the stack
# on localhost first, then complete TLS, then open the public URL.
$localSetupUrl  = 'http://localhost:5173/setup'
$publicSetupUrl = ($domain.TrimEnd('/')) + '/setup'
$isLocalhost = $domain -match '^http://localhost' -or $domain -match '^http://127\.0\.0\.1'

Write-Host ""
Write-Host "LapseIQ is installed." -ForegroundColor Green
Write-Host ""

if ($isLocalhost) {
    Write-Host "Next step: open the setup wizard and create your admin account:"
    Write-Host ""
    Write-Host "  $localSetupUrl" -ForegroundColor White
    Write-Host ""
} else {
    $domainHost = $domain -replace '^https?://',''
    Write-Host "[!] Two more steps before the public URL is reachable." -ForegroundColor Yellow
    Write-Host "    (TLS + reverse-proxy aren't part of install.ps1 - that's Step 4 of the walkthrough.)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  1. Verify the stack is healthy locally on this host:" -ForegroundColor White
    Write-Host "        Invoke-RestMethod http://localhost:3001/api/health"
    Write-Host "        Start-Process $localSetupUrl   # opens in default browser"
    Write-Host ""
    Write-Host "  2. Configure TLS / reverse-proxy with Caddy (Step 4 of the walkthrough):" -ForegroundColor White
    Write-Host "        https://lapseiq.com/install#step-4"
    Write-Host "        - DNS for $domainHost must already resolve to this host."
    Write-Host "        - Caddy will obtain a Let's Encrypt certificate on first reload"
    Write-Host "          (typically 30-60 seconds after dropping in the Caddyfile)."
    Write-Host ""
    Write-Host "  3. Then open the public setup wizard URL:" -ForegroundColor White
    Write-Host "        $publicSetupUrl" -ForegroundColor White
    Write-Host ""
    Write-Host "Skip step 2 only if you already have TLS / a reverse-proxy in front of" -ForegroundColor DarkGray
    Write-Host "this host. Otherwise $publicSetupUrl will fail with" -ForegroundColor DarkGray
    Write-Host "connection-refused (or a Cloudflare 522) until Caddy is reloaded." -ForegroundColor DarkGray
    Write-Host ""
}

Write-Host "Operational hints:"
Write-Host "  - Logs:           docker compose logs -f server"
Write-Host "  - Stop:           docker compose down"
Write-Host "  - Update images:  docker compose pull; docker compose up -d"
Write-Host "  - Backups:        nightly pg_dump.gz lands in .\backups (retention 30 days)"
Write-Host "  - .env location:  $envPath (back this up off-box)"
Write-Host ""
Write-Host "Source + docs: https://lapseiq.com  -  Security disclosure: support@lapseiq.com" -ForegroundColor DarkGray
