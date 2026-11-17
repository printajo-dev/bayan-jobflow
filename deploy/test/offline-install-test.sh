#!/usr/bin/env bash
# Release check: installs an offline bundle on a fresh Ubuntu 24.04 machine
# that has NO network (a privileged container started with --network none),
# then starts JobFlow, signs in, updates from the same bundle, backs up and
# runs a restore test. Needs Docker on the machine running the test.
#
#   ./deploy/test/offline-install-test.sh dist/jobflow-offline-<version>.tar
set -euo pipefail
bundle="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mktemp -d)"; cp "$bundle" "$dir/"
vol="jobflow-offline-test-$$"
trap 'docker volume rm -f "$vol" >/dev/null 2>&1; rm -rf "$dir"' EXIT
docker volume create "$vol" >/dev/null
docker run --rm --privileged --network none \
  -v "$dir:/bundle:ro" -v "$here:/test:ro" -v "$vol:/var/lib/docker" \
  ubuntu:24.04 /test/offline-install-inside.sh
