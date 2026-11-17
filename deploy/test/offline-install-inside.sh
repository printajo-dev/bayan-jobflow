#!/usr/bin/env bash
# Runs INSIDE a fresh ubuntu:24.04 container started with --network none
# (see offline-install-test.sh). Simulates the office server with no internet.
set -euo pipefail
# shellcheck disable=SC2154  # rc is assigned inside the trap
trap 'rc=$?; [ $rc -ne 0 ] && { echo "== dockerd log:"; tail -n 8 /var/log/dockerd.log; }' EXIT
echo "== network check (must fail):"; (getent hosts registry.npmjs.org || echo "no DNS, no internet: OK")
mkdir -p /tmp/b && tar -xf /bundle/*.tar -C /tmp/b
cd /tmp/b/*/
# No systemd in a container: start dockerd once the packages are installed.
( while ! { command -v dockerd && command -v iptables && [ -x /usr/libexec/docker/cli-plugins/docker-compose ] && [ -z "$(dpkg --audit 2>/dev/null)" ]; } >/dev/null 2>&1; do sleep 1; done; sleep 3; dockerd >/var/log/dockerd.log 2>&1 ) &
./install-offline.sh
cd /srv/bayan-jobflow
./deploy/scripts/install.sh >/dev/null            # first run: creates deploy/.env
sed -i 's/^JOBFLOW_HOST=.*/JOBFLOW_HOST=127.0.0.1/; s/^BIND_IP=.*/BIND_IP=127.0.0.1/' deploy/.env
./deploy/scripts/install.sh 2>&1 | grep -E "Using the images|Building|Starting|healthy|Error" || true
for _ in $(seq 1 60); do curl -skf https://127.0.0.1/api/v1/health/ready >/dev/null && break; sleep 2; done
echo "== health: $(curl -sk https://127.0.0.1/api/v1/health/ready)"
cd deploy && JOBFLOW_ADMIN_PASSWORD='Offline-Admin-2026' docker compose run --rm -e JOBFLOW_ADMIN_PASSWORD api node dist/cli/create-admin.js --username admin --full-name "Offline Admin" 2>&1 | tail -1
login=$(curl -sk -H 'Content-Type: application/json' -d '{"username":"admin","password":"Offline-Admin-2026"}' https://127.0.0.1/api/v1/auth/login -o /dev/null -w '%{http_code}')
echo "== admin sign-in over HTTPS: $login"
echo "== web app: $(curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1/)"
docker compose ps --format '{{.Name}} {{.Status}}'
echo "== versions: $(docker --version); $(restic version | cut -d' ' -f1-2); $(jq --version)"
cd /srv/bayan-jobflow
echo "== offline update from the bundle:"
./deploy/scripts/update.sh /bundle/*.tar 2>&1 | grep -E "Unpacking|Pre-update|Loading|Starting|Updated|ERROR" | sed 's/^[0-9-]* [0-9:]* //'
grep '^status=' /srv/company-data/backups/last-update
echo "== maintenance after update: $(curl -sk https://127.0.0.1/api/v1/system/maintenance)"
echo "== offline backup + restore test:"
(umask 077; openssl rand -base64 32 > deploy/restic-password)
./deploy/scripts/backup.sh all >/dev/null 2>&1 && echo "backup ok"
./deploy/scripts/restore.sh test 2>/dev/null | tail -n 1
