#!/usr/bin/env bash
# Builds everything the office server needs into ONE file, on a computer that
# has internet and Docker (any Linux PC, or Windows/macOS with Docker Desktop
# and Git Bash/WSL). The server itself never needs internet.
#
#   ./deploy/scripts/make-offline-bundle.sh            # current checkout
#   ./deploy/scripts/make-offline-bundle.sh v1.2.0     # a tag or commit
#
# Output: dist/jobflow-offline-<version>.tar containing
#   images.tar     JobFlow API and web images, PostgreSQL, Redis
#   debs/          Docker Engine + Compose, Restic, jq, rsync, git for Ubuntu 24.04 (amd64)
#   repo.bundle    the source code (git bundle) with this version checked out
#   install-offline.sh, VERSION, SHA256SUMS
# Copy it to the server (USB disk) and follow docs/install-offline.md.
set -euo pipefail
REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR"
ref="${1:-HEAD}"
PG_IMAGE="postgres:17.12-bookworm"
REDIS_IMAGE="redis:8.2.11-bookworm"
UBUNTU_IMAGE="ubuntu:24.04"
# Extra `docker run`/`docker build` options for networks that need them
# (e.g. a proxy certificate); empty by default.
read -r -a EXTRA_RUN <<<"${BUNDLE_DOCKER_RUN_ARGS:-}"
read -r -a EXTRA_BUILD <<<"${BUNDLE_DOCKER_BUILD_ARGS:-}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Commit or stash local changes first" >&2; exit 1; }

version="$(git describe --tags --always "$ref")"
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
out="$work/jobflow-offline-$version"; mkdir -p "$out/debs"

log "Source code at $version"
git worktree add -q --detach "$work/src" "$ref"
trap 'git -C "$REPO_DIR" worktree remove --force "$work/src" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git -C "$work/src" bundle create -q "$out/repo.bundle" HEAD

if [[ "${BUNDLE_SKIP_BUILD:-0}" == 1 ]]; then
  # Images already built from this exact version (e.g. by CI).
  docker image inspect bayan-jobflow-api:local bayan-jobflow-web:local >/dev/null || { echo "Images not found" >&2; exit 1; }
  log "Using the existing bayan-jobflow-api:local and bayan-jobflow-web:local images"
else
  log "Building the JobFlow images (linux/amd64)"
  docker build "${EXTRA_BUILD[@]}" --platform linux/amd64 --target api -t bayan-jobflow-api:local "$work/src"
  docker build "${EXTRA_BUILD[@]}" --platform linux/amd64 --target web -t bayan-jobflow-web:local "$work/src"
fi
docker pull -q --platform linux/amd64 "$PG_IMAGE"
docker pull -q --platform linux/amd64 "$REDIS_IMAGE"
log "Saving images"
docker save -o "$out/images.tar" bayan-jobflow-api:local bayan-jobflow-web:local "$PG_IMAGE" "$REDIS_IMAGE"

log "Downloading Ubuntu 24.04 packages (Docker, Restic, jq, rsync, git)"
mkdir -p "$work/keys"
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$work/keys/docker.asc"
# Downloaded in a CLEAN Ubuntu 24.04 container, so every dependency that a
# minimal server might lack is included. Nothing may be installed in it before
# the download, or those packages' dependencies would be left out.
docker run --rm --platform linux/amd64 "${EXTRA_RUN[@]}" -v "$out/debs:/out" -v "$work/keys:/keys:ro" "$UBUNTU_IMAGE" bash -euc '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --download-only --no-install-recommends \
    ca-certificates openssl curl git restic jq rsync iptables >/dev/null
  cp /var/cache/apt/archives/*.deb /out/
  # Docker packages come from Docker'"'"'s HTTPS repository: certificates are
  # needed now (already part of the download above).
  apt-get install -y -qq --no-install-recommends ca-certificates >/dev/null
  if [ -d /extra-ca ]; then cp /extra-ca/*.crt /usr/local/share/ca-certificates/ && update-ca-certificates >/dev/null 2>&1; fi
  install -m 0755 -d /etc/apt/keyrings && cp /keys/docker.asc /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  rm -f /var/cache/apt/archives/*.deb
  apt-get install -y -qq --download-only --no-install-recommends \
    docker-ce docker-ce-cli containerd.io docker-compose-plugin docker-buildx-plugin >/dev/null
  cp -n /var/cache/apt/archives/*.deb /out/
  chown -R '"$(id -u):$(id -g)"' /out'

cp deploy/scripts/install-offline.sh "$out/"
echo "$version" > "$out/VERSION"
(cd "$out" && find . -type f ! -name SHA256SUMS -printf '%P\n' | sort | xargs sha256sum > SHA256SUMS)

mkdir -p "$REPO_DIR/dist"
tar -cf "$REPO_DIR/dist/jobflow-offline-$version.tar" -C "$work" "jobflow-offline-$version"
log "Done: dist/jobflow-offline-$version.tar ($(du -h "$REPO_DIR/dist/jobflow-offline-$version.tar" | cut -f1))"
echo "SHA-256: $(sha256sum "$REPO_DIR/dist/jobflow-offline-$version.tar" | cut -d' ' -f1)"
