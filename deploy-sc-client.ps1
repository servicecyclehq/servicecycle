# ============================================================================
# ServiceCycle CLIENT deploy  (run in YOUR PowerShell terminal — SSH works there)
#
# ⚠ DEPLOY-PATH NOTE: legacy path — builds the SPA on this laptop and scp's the
#   dist to the live web root (/var/www/servicecycle/html) on the :3002 box.
#   The CANONICAL path is a git-commit-based deploy via the VPS ops MCP (build
#   + publish from a reviewed commit), not from the local working tree. Keep
#   this only as a manual fallback; see deploy-sc-server.ps1 for the full note.
#
# Ships the client-side LapseIQ scrub (index.html, theme-bootstrap, CategoriesSection).
# Cosmetic only; the current bundle works, so this just finishes the scrub.
# Backs up the live web root first, preserves .well-known.
#
# Run:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\ddeni\Desktop\ServiceCycle\deploy-sc-client.ps1"
# ============================================================================
$ErrorActionPreference = 'Stop'

$SC    = 'root@198.211.99.45'                 # ServiceCycle droplet (NOT lapseiq)
$REPO  = 'C:\Users\ddeni\Desktop\ServiceCycle'
$TGZ   = "$env:TEMP\sc-client.tgz"
$STAMP = Get-Date -Format 'yyyyMMdd-HHmm'

Write-Host "[1/5] Building SPA (VITE_API_URL='')..." -ForegroundColor Cyan
Push-Location "$REPO\client"
$env:VITE_API_URL = ''
npm run build
Pop-Location
if (-not (Test-Path "$REPO\client\dist\index.html")) { throw "build produced no dist/index.html - aborting" }

Write-Host "[2/5] Tarring dist..." -ForegroundColor Cyan
tar -czf "$TGZ" -C "$REPO\client" dist
Write-Host ("      -> {0} ({1} MB)" -f $TGZ, [math]::Round((Get-Item $TGZ).Length/1MB,1))

Write-Host "[3/5] Uploading..." -ForegroundColor Cyan
scp "$TGZ" "${SC}:/root/sc-client.tgz"

Write-Host "[4/5] Backup live web root, then deploy (preserves .well-known)..." -ForegroundColor Cyan
ssh $SC "cp -a /var/www/servicecycle/html /root/html-backup-$STAMP && rm -rf /var/www/servicecycle/html/assets && tar xzf /root/sc-client.tgz --strip-components=1 -C /var/www/servicecycle/html && rm /root/sc-client.tgz && echo DEPLOYED"

Write-Host "[5/5] Done. Rollback if needed:" -ForegroundColor Green
Write-Host "      ssh $SC `"rm -rf /var/www/servicecycle/html && mv /root/html-backup-$STAMP /var/www/servicecycle/html`"" -ForegroundColor DarkGray
Write-Host "Hard-refresh https://servicecycle.app (Ctrl+Shift+R) to confirm the SPA loads." -ForegroundColor Yellow
