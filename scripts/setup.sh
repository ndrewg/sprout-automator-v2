#!/usr/bin/env bash
# First-run setup for Sprout Automator — twin of scripts/setup.ps1. Both must
# behave identically.
#
# Creates .env from .env.example with freshly generated secrets, starts the
# stack, applies migrations, and health-checks the database.
#
# REFUSES to touch an existing .env: the APP_ENCRYPTION_KEY inside it is what
# makes stored credentials decryptable, so overwriting it would lock them
# forever. Setup is NOT finished when this script exits — see the last step:
# the app still needs a human to sign up and configure credentials in the UI.

set -euo pipefail

# Run from anywhere in the tree: the scripts live in scripts/, everything else
# resolves from the repo root.
cd "$(dirname "$0")/.."

# --- 1. Prerequisites ----------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  echo "setup: Docker is not installed. Install Docker Desktop and run this again." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "setup: Docker is not running. Start Docker (Desktop) and run this again." >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "setup: Node.js is not installed. Install Node 22+ and run this again." >&2
  exit 1
fi

# --- 2. Refuse to overwrite an existing .env ----------------------------------

if [ -f .env ]; then
  echo "setup: .env already exists. Refusing to overwrite it — the APP_ENCRYPTION_KEY inside it decrypts stored credentials, and replacing it would make every saved Sprout/Gmail credential permanently undecryptable." >&2
  echo "If this is a fresh start you are SURE about, move the existing .env aside (e.g. mv .env .env.old) and run this again." >&2
  exit 1
fi

if [ ! -f .env.example ]; then
  echo "setup: .env.example not found. Run this from the repo root (or the scripts/ directory)." >&2
  exit 1
fi

# --- 3. Generate secrets, write .env ------------------------------------------

echo "setup: generating secrets (they will live only in .env, not in this terminal)…"
APP_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")"
POSTGRES_PASSWORD="$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")"

# --- 4. Signup allowlist -------------------------------------------------------

read -r -p "setup: allow signup for these domains/addresses, comma-separated [orchard.com.au]: " signup_allowed || true
signup_allowed="${signup_allowed:-orchard.com.au}"

sed \
  -e "s|^APP_ENCRYPTION_KEY=.*|APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY}|" \
  -e "s|^SESSION_SECRET=.*|SESSION_SECRET=${SESSION_SECRET}|" \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${POSTGRES_PASSWORD}|" \
  -e "s|^# SIGNUP_ALLOWED=.*|SIGNUP_ALLOWED=${signup_allowed}|" \
  .env.example > .env
echo "setup: wrote .env (never commit this file)."

# --- 5. Start the stack, wait for Postgres -------------------------------------

echo "setup: starting containers…"
docker compose up -d

echo "setup: waiting for Postgres to be healthy…"
attempts=0
until [ "$(docker inspect -f '{{.State.Health.Status}}' sprout-postgres 2>/dev/null)" = "healthy" ]; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 120 ]; then
    echo "setup: Postgres did not become healthy in time. Check: docker compose ps / docker compose logs postgres" >&2
    exit 1
  fi
  sleep 2
done

# --- 6. Migrations -------------------------------------------------------------

echo "setup: applying database migrations…"
docker compose run --rm backend pnpm db:migrate
docker compose restart backend

# --- 7. Health check (db must be ok) --------------------------------------------

echo "setup: waiting for the backend health check…"
attempts=0
until curl -s --noproxy '*' http://127.0.0.1:3000/health >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if [ "$attempts" -ge 60 ]; then
    echo "setup: backend did not answer /health. Check: docker compose logs backend" >&2
    exit 1
  fi
  sleep 2
done

health="$(curl -s --noproxy '*' http://127.0.0.1:3000/health)"
if ! printf '%s' "$health" | grep -q '"db":"ok"'; then
  echo "setup: backend is up but the database health check failed — $health" >&2
  echo "       Check: docker compose logs backend / docker compose ps" >&2
  exit 1
fi
echo "setup: health OK — $health"

# --- 8. Remaining human steps ---------------------------------------------------

cat <<'EOF'

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
EOF
