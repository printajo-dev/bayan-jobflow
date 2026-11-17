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

SUDO=""; [[ $EUID -eq 0 ]] || SUDO=sudo
set -a; source .env; set +a
: "${JOBFLOW_HOST:?JOBFLOW_HOST missing in deploy/.env}"
: "${DATA_ROOT:?DATA_ROOT missing in deploy/.env}"
if [[ -z "${POSTGRES_PASSWORD:-}" || -z "${REDIS_PASSWORD:-}" ]]; then
  echo "POSTGRES_PASSWORD and REDIS_PASSWORD must be set in deploy/.env" >&2; exit 1
fi

# The web server listens on BIND_IP only. Let it start even when that address
# is not up yet (server booted while the switch or cable was off); it starts
# answering as soon as the network comes up. Without this, Docker refuses to
# start the web container ("cannot assign requested address").
echo "net.ipv4.ip_nonlocal_bind = 1" | $SUDO tee /etc/sysctl.d/90-bayan-jobflow.conf >/dev/null
$SUDO sysctl -q -p /etc/sysctl.d/90-bayan-jobflow.conf
if ! ip -4 -o addr show 2>/dev/null | grep -q " ${BIND_IP}/"; then
  echo "WARNING: ${BIND_IP} is not configured on any network interface of this server."
  echo "         Check BIND_IP in deploy/.env and the server's fixed IP (docs/install-offline.md, Office network)."
fi

echo "Creating data folders under ${DATA_ROOT}…"
$SUDO mkdir -p "${DATA_ROOT}"/{postgres,redis,caddy/data,caddy/config,files,backups,backup-status,imports,exports}
$SUDO chmod 700 "${DATA_ROOT}/postgres" "${DATA_ROOT}/backups"
# The API container runs as uid 1000 and must be able to write uploads.
$SUDO chown -R 1000:1000 "${DATA_ROOT}/files"
$SUDO chmod 750 "${DATA_ROOT}/files"

if ! grep -q '^JOBFLOW_RELEASE=' .env; then echo "JOBFLOW_RELEASE=$(git -C .. describe --tags --always)" >> .env; fi
set -a; source .env; set +a

if docker image inspect "bayan-jobflow-api:${JOBFLOW_VERSION:-local}" >/dev/null 2>&1 \
  && docker image inspect "bayan-jobflow-web:${JOBFLOW_VERSION:-local}" >/dev/null 2>&1 \
  && [[ "${JOBFLOW_REBUILD:-0}" != 1 ]]; then
  echo "Using the images already loaded (offline bundle); set JOBFLOW_REBUILD=1 to build instead."
else
  echo "Building images (needs internet)…"
  docker compose build
fi

echo "Starting services…"
docker compose up -d --no-build
docker compose ps

cat <<MSG

Bayan JobFlow is starting at https://${JOBFLOW_HOST}

Next steps:
  1. Create the first administrator:   ./deploy/scripts/create-admin.sh
  2. Export the HTTPS root certificate: ./deploy/scripts/export-ca.sh
     and install it on each office PC (docs/install-ubuntu.md).
  3. Firewall (office network only):   sudo ./deploy/scripts/firewall.sh install
  4. Set up backups:                    sudo ./deploy/scripts/install-backups.sh
     (docs/maintenance.md; plug in the external backup disk first).
MSG
