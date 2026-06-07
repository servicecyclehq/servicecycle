# setup-lt-mcp-personal-env.ps1
#
# Recreates Dustin's personal .env override file for the installed
# local-terminal-mcp plugin. Run this after a plugin reinstall (which
# wipes the .env that lives in the install dir).
#
# What it does:
#   - Writes %APPDATA%\Claude\Claude Extensions\local.mcpb.forgerift-llc.local-terminal\.env
#   - Sets BYPASS_BINARIES so SSH / scp / sftp / rsync / curl / wget / cd&& / git&& / docker&& / npm&& work
#   - Sets LAYER_STRICT_MODE=false so AI-review failures fall back to manual confirmation
#
# After running this you MUST restart Claude Desktop (right-click tray icon -> Quit, then reopen).
#
# See memory/reference_lt_mcp_personal_env.md for the full rationale + safety analysis.

$ErrorActionPreference = 'Stop'

$installDir = "$env:APPDATA\Claude\Claude Extensions\local.mcpb.forgerift-llc.local-terminal"

if (-not (Test-Path $installDir)) {
    Write-Host "ERROR: local-terminal-mcp plugin is not installed at $installDir"
    Write-Host "Install it from the Claude marketplace first, then re-run this."
    exit 1
}

$envPath = Join-Path $installDir '.env'

$content = @'
# Personal overrides for the local-terminal-mcp plugin.
#
# This file is intentionally NOT part of the marketplace bundle (the source
# .mcpbignore excludes .env*), so a fresh install always lands without it.
# When present, dist/index.js loads it via dotenv on startup and the values
# become available as process.env.* in the running plugin.
#
# Lifecycle:
#   - Survives Claude Desktop restarts
#   - Wiped if the plugin is uninstalled and reinstalled (recreate with
#     scripts/setup-lt-mcp-personal-env.ps1 in the LapseIQ repo)
#   - May be overwritten by future plugin updates that change the install dir
#
# BYPASS_BINARIES -- comma-separated binary:category pairs.
#
# A bypass demotes a RED hard-block to AI-review (Layer 2/3) for that
# specific binary+category combination only. The other RED-tier patterns
# in the BLOCKLIST still apply to the FULL command string, so chained
# destructive ops are still caught.
#
# Categories deliberately LEFT IN PLACE (never bypassed):
#   file-delete, disk-ops, system-state, system-power-state,
#   recursive-file-deletion, data-destruction, credential-key-destruction,
#   os-permission-destruction, persistence, priv-esc, env-manip,
#   service-mgmt, scheduled-exec, registry, code-exec, com-exec,
#   firewall-destruction, etc.
#
# Active bypasses:
#   ssh / scp / sftp / rsync : data-exfil    -- connect to droplets we own
#   curl / wget              : data-exfil    -- fetch from known APIs
#   cd / git / docker / npm  : chaining      -- multi-step deploy / ops
BYPASS_BINARIES=ssh:data-exfil,scp:data-exfil,sftp:data-exfil,rsync:data-exfil,curl:data-exfil,wget:data-exfil,cd:chaining,git:chaining,docker:chaining,npm:chaining

# LAYER_STRICT_MODE controls AI layer failure behavior.
#   false (default) = if AI classification fails (no API key, network error,
#                     timeout, etc.), fall back to manual confirmation
#   true            = block the command if AI classification fails
# Leave at default so commands still work when offline.
LAYER_STRICT_MODE=false
'@

# Normalize to LF and write as UTF-8 without BOM
$content = $content -replace "`r`n", "`n"
[System.IO.File]::WriteAllText($envPath, $content, [System.Text.UTF8Encoding]::new($false))

Write-Host ('Wrote: ' + $envPath)
Write-Host ('Bytes: ' + (Get-Item $envPath).Length)
Write-Host ''
Write-Host 'NEXT: restart Claude Desktop -- right-click tray icon -> Quit, then reopen.'
Write-Host 'After restart, SSH/scp/curl/wget/chaining commands should be allowed via Local Terminal MCP.'
