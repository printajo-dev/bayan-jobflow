#!/usr/bin/env bash
# Creates a System Administrator interactively (password is not echoed).
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose run --rm -it --no-deps api node dist/cli/create-admin.js "$@"
