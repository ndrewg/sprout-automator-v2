#!/usr/bin/env pwsh
# Nightly Postgres backup for Sprout Automator (Windows host) - twin of
# scripts/backup.sh. Both must behave identically. Requires PowerShell 7+.
#
# Runs on the HOST (not inside a container) and calls into the running postgres
# container, so it needs Docker and nothing else. Produces a custom-format
# pg_dump (restoreable with scripts/restore.ps1), gzip-compressed, written to
# $BACKUP_DIR (default ~/backups), and prunes files older than $RETENTION_DAYS.
#
# Install as a Windows Task Scheduler job (03:00 Asia/Manila, per phase-5 5.5).
# In an elevated PowerShell, from the repo root:
#
#   $action  = New-ScheduledTaskAction -Execute "pwsh.exe" `
#     -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$PWD\scripts\backup.ps1`""
#   $trigger = New-ScheduledTaskTrigger -Daily -At 03:00
#   $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable
#   $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
#     -LogonType S4U -RunLevel Highest
#   Register-ScheduledTask -TaskName "SproutBackup" -Action $action `
#     -Trigger $trigger -Settings $settings -Principal $principal -Force
#
# The task MUST run whether or not the user is logged on. That is what the
# -LogonType S4U principal above does: S4U runs the task without a saved
# password and without requiring an interactive session. Do NOT use Interactive
# logon type — an interactive task inherits the "Docker Desktop needs a signed-in
# session" problem that is already the largest risk on this host (phase-12 12B).
# (If Docker Desktop is set to start only on login, either keep it running or
# configure it to start at sign-in; the task itself needs no session.)
#
# Overridable env: BACKUP_DIR, RETENTION_DAYS, POSTGRES_USER, POSTGRES_DB,
# SPROUT_POSTGRES_CONTAINER (default sprout-postgres).

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

# Run from anywhere in the tree: scripts live in scripts/, everything else
# resolves from the repo root.
Set-Location (Join-Path $PSScriptRoot "..")

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Error "backup: PowerShell 7+ is required. Run scripts/backup.ps1 with pwsh."
  exit 1
}

$BACKUP_DIR = if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { Join-Path $HOME "backups" }
$RETENTION_DAYS = if ($env:RETENTION_DAYS) { [int]$env:RETENTION_DAYS } else { 14 }
$PG_USER = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { "sprout" }
$PG_DB = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { "sprout" }
$CONTAINER = if ($env:SPROUT_POSTGRES_CONTAINER) { $env:SPROUT_POSTGRES_CONTAINER } else { "sprout-postgres" }

$STAMP = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$DEST = Join-Path $BACKUP_DIR "sprout-$STAMP.dump.gz"

New-Item -ItemType Directory -Force -Path $BACKUP_DIR | Out-Null

# A custom-format pg_dump is BINARY; PowerShell's native-command pipeline
# decodes output as text, which would corrupt it. So we write the raw bytes via
# cmd's byte-exact redirection to a temp file, then gzip that file — the same
# `docker exec ... | gzip > file` shape as backup.sh, done byte-safely.
$TMP = Join-Path $env:TEMP "sprout-$STAMP.dump"

# docker exec -i (NOT -T — the -T flag was removed in Docker 29.5, phase-5 5.4).
cmd /c "docker exec $CONTAINER pg_dump -U $PG_USER -d $PG_DB -Fc > `"$TMP`" 2>nul"
if ($LASTEXITCODE -ne 0) {
  Write-Error "backup: pg_dump failed (exit $LASTEXITCODE). Is the sprout-postgres container running?"
  exit 1
}

cmd /c "gzip -c `"$TMP`" > `"$DEST`""
if ($LASTEXITCODE -ne 0) {
  Write-Error "backup: gzip failed (exit $LASTEXITCODE). Is gzip on PATH?"
  exit 1
}
Remove-Item -LiteralPath $TMP -Force

# Prune dumps older than the retention window.
$cutoff = (Get-Date).AddDays(-$RETENTION_DAYS)
Get-ChildItem -LiteralPath $BACKUP_DIR -Filter "sprout-*.dump.gz" |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  Remove-Item -Force

Write-Output "backup written to $DEST"
