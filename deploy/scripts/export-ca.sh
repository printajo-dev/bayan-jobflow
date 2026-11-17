#!/usr/bin/env bash
# Copies Caddy's internal root certificate out of the container so it can be
# installed on office PCs. The file is public (no private key).
set -euo pipefail
cd "$(dirname "$0")/.."
out="${1:-bayan-jobflow-root-ca.crt}"
docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > "$out"
echo "Saved $out"
openssl x509 -in "$out" -noout -subject -enddate -fingerprint -sha256
