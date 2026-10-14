#!/bin/sh
# Creates .env from .env.example with fresh random secrets. Safe to re-run: never overwrites .env.
set -eu
cd "$(dirname "$0")/.."
if [ -f .env ]; then echo ".env already exists; leaving it alone."; exit 0; fi
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
sed -e "s/^APP_SECRET=$/APP_SECRET=$(rand 32)/" \
    -e "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(rand 16)/" \
    -e "s/^DB_APP_PASSWORD=$/DB_APP_PASSWORD=$(rand 16)/" \
    -e "s/^DB_SYSTEM_PASSWORD=$/DB_SYSTEM_PASSWORD=$(rand 16)/" \
    .env.example > .env
echo "Wrote .env with new secrets. Review APP_URL and SMTP_URL, then run: docker compose up -d"
