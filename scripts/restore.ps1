#!/usr/bin/env pwsh
# Restore a Sprout Automator backup into a SCRATCH database (Windows host) -
# twin of scripts/restore.sh. Both must behave identically. Requires PowerShell
# 7+ and gzip on PATH.
#
# The restore path is deliberately a scratch database, never the live one: it
# proves a backup restores without touching production data. The `--clean
# --if-exists` flags (mandated by the spec) drop whatever is in the scratch DB
# first, so re-running against the same name is safe.
#
# Usage:
#   scripts/restore.ps1 /path/to/sprout-<stamp>.dump.gz [scratch-db-name]
#
# The scratch database defaults to sprout_restore_<epoch>. After it finishes,
# verify and drop it:
#   docker exec sprout-postgres psql -U sprout -d <scratch> -c '\dt'
#   docker exec sprout-postgres dropdb -U sprout <scratch>
#
# Overridable env: POSTGRES_USER, SPROUT_POSTGRES_CONTAINER (default
# sprout-postgres).

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

Set-Location (Join-Path $PSScriptRoot "..")

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Error "restore: PowerShell 7+ is required. Run scripts/restore.ps1 with pwsh."
  exit 1
}

if ($args.Count -lt 1 -or [string]::IsNullOrWhiteSpace($args[0])) {
  Write-Error "usage: restore.ps1 <backup.dump.gz> [scratch-db-name]"
  exit 1
}
$BACKUP_FILE = (Resolve-Path -LiteralPath $args[0]).Path
$SCRATCH_DB = if ($args.Count -ge 2) { $args[1] } else { "sprout_restore_$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())" }
$PG_USER = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "sprout" }
$CONTAINER = if ($env:SPROUT_POSTGRES_CONTAINER) { $env:SPROUT_POSTGRES_CONTAINER } else { "sprout-postgres" }

docker exec $CONTAINER dropdb -U $PG_USER --if-exists $SCRATCH_DB
if ($LASTEXITCODE -ne 0) { exit 1 }
docker exec $CONTAINER createdb -U $PG_USER $SCRATCH_DB
if ($LASTEXITCODE -ne 0) { exit 1 }

# gzip -dc writes the raw custom-format dump to stdout; pipe it into the
# container via cmd's byte-exact redirection (PowerShell's own pipeline would
# decode the binary dump as text and corrupt it).
$TMP = Join-Path $env:TEMP "sprout-restore-$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()).dump"
cmd /c "gzip -dc `"$BACKUP_FILE`" > `"$TMP`" 2>nul"
if ($LASTEXITCODE -ne 0) {
  Write-Error "restore: gzip -dc failed (exit $LASTEXITCODE). Is gzip on PATH?"
  exit 1
}
cmd /c "docker exec -i $CONTAINER pg_restore -U $PG_USER -d $SCRATCH_DB --clean --if-exists < `"$TMP`""
$RESTORE_EXIT = $LASTEXITCODE
Remove-Item -LiteralPath $TMP -Force
if ($RESTORE_EXIT -ne 0) {
  Write-Error "restore: pg_restore failed (exit $RESTORE_EXIT)."
  exit 1
}

Write-Output "restored $BACKUP_FILE into scratch database $SCRATCH_DB"
Write-Output "verify: docker exec $CONTAINER psql -U $PG_USER -d $SCRATCH_DB -c '\dt'"
Write-Output "cleanup: docker exec $CONTAINER dropdb -U $PG_USER $SCRATCH_DB"
