#!/usr/bin/env bash
# First-time installation on Ubuntu Server 24.04. Run from the repository
# root as a user in the `docker` group:  ./deploy/scripts/install.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # deploy/

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
  sed -i "s/^REDIS_PASSWORD=.*/REDIS_PASSWORD=$(openssl rand -hex 24)/" .env
  echo "Created deploy/.env with generated passwords."
  echo "Edit JOBFLOW_HOST and BIND_IP (the server's fixed LAN IP), then run this script again."
  exit 0
fi

set -a; source .env; set +a
: "${JOBFLOW_HOST:?JOBFLOW_HOST missing in deploy/.env}"
: "${DATA_ROOT:?DATA_ROOT missing in deploy/.env}"
if [[ -z "${POSTGRES_PASSWORD:-}" || -z "${REDIS_PASSWORD:-}" ]]; then
  echo "POSTGRES_PASSWORD and REDIS_PASSWORD must be set in deploy/.env" >&2; exit 1
fi

echo "Creating data folders under ${DATA_ROOT} (needs sudo)…"
sudo mkdir -p "${DATA_ROOT}"/{postgres,redis,caddy/data,caddy/config,files,backups,imports,exports}
sudo chmod 700 "${DATA_ROOT}/postgres" "${DATA_ROOT}/backups"
# The API container runs as uid 1000 and must be able to write uploads.
sudo chown -R 1000:1000 "${DATA_ROOT}/files"
sudo chmod 750 "${DATA_ROOT}/files"

echo "Building images…"
docker compose build

echo "Starting services…"
docker compose up -d
docker compose ps

cat <<MSG

Bayan JobFlow is starting at https://${JOBFLOW_HOST}

Next steps:
  1. Create the first administrator:   ./deploy/scripts/create-admin.sh
  2. Export the HTTPS root certificate: ./deploy/scripts/export-ca.sh
     and install it on each office PC (docs/install-ubuntu.md).
MSG
