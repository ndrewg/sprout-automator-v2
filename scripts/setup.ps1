#!/usr/bin/env pwsh
# First-run setup for Sprout Automator — twin of scripts/setup.sh. Both must
# behave identically. Requires PowerShell 7+ (for Invoke-RestMethod -NoProxy).
#
# Creates .env from .env.example with freshly generated secrets, starts the
# stack, applies migrations, and health-checks the database.
#
# REFUSES to touch an existing .env: the APP_ENCRYPTION_KEY inside it is what
# makes stored credentials decryptable, so overwriting it would lock them
# forever. Setup is NOT finished when this script exits — see the last step:
# the app still needs a human to sign up and configure credentials in the UI.

$ErrorActionPreference = "Stop"
# Native commands (docker, node) report failures via $LASTEXITCODE, not as
# terminating errors — checked explicitly below.
$PSNativeCommandUseErrorActionPreference = $false

# Run from anywhere in the tree: the scripts live in scripts/, everything else
# resolves from the repo root.
Set-Location (Join-Path $PSScriptRoot "..")

if ($PSVersionTable.PSVersion.Major -lt 7) {
  Write-Error "setup: PowerShell 7+ is required (found $($PSVersionTable.PSVersion)). Install pwsh and run scripts/setup.ps1 with it."
  exit 1
}

# --- 1. Prerequisites -----------------------------------------------------------

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "setup: Docker is not installed. Install Docker Desktop and run this again."
  exit 1
}
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Error "setup: Docker is not running. Start Docker Desktop and run this again."
  exit 1
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "setup: Node.js is not installed. Install Node 22+ and run this again."
  exit 1
}

# --- 2. Refuse to overwrite an existing .env -------------------------------------

if (Test-Path -LiteralPath ".env") {
  [Console]::Error.WriteLine("setup: .env already exists. Refusing to overwrite it — the APP_ENCRYPTION_KEY inside it decrypts stored credentials, and replacing it would make every saved Sprout/Gmail credential permanently undecryptable.")
  [Console]::Error.WriteLine("If this is a fresh start you are SURE about, move the existing .env aside (e.g. Rename-Item .env .env.old) and run this again.")
  exit 1
}

if (-not (Test-Path -LiteralPath ".env.example")) {
  Write-Error "setup: .env.example not found. Run this from the repo root (or the scripts/ directory)."
  exit 1
}

# --- 3. Generate secrets, write .env ----------------------------------------------

Write-Host "setup: generating secrets (they will live only in .env, not in this terminal)…"
$appEncryptionKey = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
$sessionSecret = node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
$postgresPassword = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

# --- 4. Signup allowlist ----------------------------------------------------------

$signupAllowed = Read-Host "setup: allow signup for these domains/addresses, comma-separated [orchard.com.au]"
if ([string]::IsNullOrWhiteSpace($signupAllowed)) {
  $signupAllowed = "orchard.com.au"
}

$template = Get-Content -LiteralPath ".env.example"
$template = $template -replace '^APP_ENCRYPTION_KEY=.*', "APP_ENCRYPTION_KEY=$appEncryptionKey"
$template = $template -replace '^SESSION_SECRET=.*', "SESSION_SECRET=$sessionSecret"
$template = $template -replace '^POSTGRES_PASSWORD=.*', "POSTGRES_PASSWORD=$postgresPassword"
$template = $template -replace '^# SIGNUP_ALLOWED=.*', "SIGNUP_ALLOWED=$signupAllowed"
Set-Content -LiteralPath ".env" -Value $template -Encoding utf8
Write-Host "setup: wrote .env (never commit this file)."

# --- 5. Start the stack, wait for Postgres ----------------------------------------

Write-Host "setup: starting containers…"
docker compose up -d
if ($LASTEXITCODE -ne 0) {
  Write-Error "setup: docker compose up failed."
  exit 1
}

Write-Host "setup: waiting for Postgres to be healthy…"
$attempts = 0
while (-not ((docker inspect -f '{{.State.Health.Status}}' sprout-postgres 2>$null) -eq "healthy")) {
  $attempts++
  if ($attempts -ge 120) {
    Write-Error "setup: Postgres did not become healthy in time. Check: docker compose ps / docker compose logs postgres"
    exit 1
  }
  Start-Sleep -Seconds 2
}

# --- 6. Migrations ----------------------------------------------------------------

Write-Host "setup: applying database migrations…"
docker compose run --rm backend pnpm db:migrate
if ($LASTEXITCODE -ne 0) {
  Write-Error "setup: migrations failed."
  exit 1
}
docker compose restart backend

# --- 7. Health check (db must be ok) -----------------------------------------------

Write-Host "setup: waiting for the backend health check…"
$attempts = 0
$health = $null
while ($null -eq $health) {
  $attempts++
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/health" -NoProxy -TimeoutSec 5
  } catch {
    $health = $null
  }
  if ($attempts -ge 60) {
    Write-Error "setup: backend did not answer /health. Check: docker compose logs backend"
    exit 1
  }
  if ($null -eq $health) {
    Start-Sleep -Seconds 2
  }
}
if ($health.db -ne "ok") {
  Write-Error "setup: backend is up but the database health check failed (db=$($health.db)). Check: docker compose logs backend / docker compose ps"
  exit 1
}
Write-Host "setup: health OK — status=$($health.status) db=$($health.db)"

# --- 8. Remaining human steps -------------------------------------------------------

@'

setup: DONE — infrastructure is up. Setup is NOT finished yet: the app still
       needs a human, one-time, in the browser at http://localhost:3000:

  1. Sign up (your first account).
  2. Sprout HRHub card → enter your Sprout username + password → Save.
  3. Gmail card → enter your Gmail address + a Gmail App Password → Save →
     press "Test Gmail connection" and wait for it to confirm the connection.
  4. Notifications card → create a Telegram bot with @BotFather, paste its
     token + your chat id → Save → send the bot any message once so it can
     reach you.
  5. Schedule card → set your clock-in / clock-out times → tick
     "Run automatically Mon–Fri" → Save.

Until 1–5 are done, nothing will clock anyone in or out.
'@
