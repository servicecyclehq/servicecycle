# ============================================================================
# ServiceCycle SERVER deploy  (run in YOUR PowerShell terminal — SSH works there)
# Ships: email-in ack, #34 backfill, LapseIQ scrub (server), FAQ help module.
# NO new migrations this session (server-migrate init will be a no-op).
# Mirrors the proven 2026-06-14 procedure. Server-only; client is a separate step.
#
# Run:
#   cd C:\Users\ddeni\Desktop\ServiceCycle
#   powershell -ExecutionPolicy Bypass -File .\deploy-sc-server.ps1
# ============================================================================
$ErrorActionPreference = 'Stop'

$SC    = 'root@198.211.99.45'                 # ServiceCycle droplet (NOT lapseiq 206.189.200.29)
$REPO  = 'C:\Users\ddeni\Desktop\ServiceCycle'
$TGZ   = "$env:TEMP\sc-server.tgz"
$STAMP = Get-Date -Format 'yyyyMMdd-HHmm'

Write-Host "[1/6] Pre-deploy DB backup on the droplet..." -ForegroundColor Cyan
ssh $SC "docker exec servicecycle-db pg_dump -U servicecycle -d servicecycle | gzip > /root/predeploy-sc-$STAMP.sql.gz && ls -lh /root/predeploy-sc-$STAMP.sql.gz"

Write-Host "[2/6] Tarring server/ (excluding node_modules/.env/uploads/backups)..." -ForegroundColor Cyan
tar --exclude='server/node_modules' --exclude='server/.env' --exclude='server/uploads' --exclude='server/backups' --exclude='server/pyextract/__pycache__' -czf "$TGZ" -C "$REPO" server
Write-Host ("      -> {0} ({1} MB)" -f $TGZ, [math]::Round((Get-Item $TGZ).Length/1MB,1))

Write-Host "[3/6] Uploading to droplet..." -ForegroundColor Cyan
scp "$TGZ" "${SC}:/root/sc-server.tgz"

Write-Host "[4/6] Extracting over /root/ServiceCycle/server (keeps .env/uploads)..." -ForegroundColor Cyan
ssh $SC "tar xzf /root/sc-server.tgz -C /root/ServiceCycle && rm -f /root/sc-server.tgz"

Write-Host "[5/6] Rebuild + restart server container (server-migrate runs migrate deploy = no-op)..." -ForegroundColor Cyan
ssh $SC "cd /root/ServiceCycle && docker compose up -d --build server"

Write-Host "[6/6] Waiting 20s, then health check..." -ForegroundColor Cyan
Start-Sleep -Seconds 20
ssh $SC "curl -sS -o /dev/null -w 'api/health HTTP %{http_code}\n' http://127.0.0.1:3002/api/health"
ssh $SC "docker ps --filter name=servicecycle-server --format '{{.Names}} {{.Status}}'"

Write-Host "`nDONE. Expect 'api/health HTTP 200' and server container 'Up (healthy)'." -ForegroundColor Green
Write-Host "Paste me the output and I'll verify, then give you the client step." -ForegroundColor Yellow
