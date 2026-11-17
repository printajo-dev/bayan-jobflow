#!/usr/bin/env bash
# First installation on an Ubuntu Server 24.04 machine with NO internet, from
# a bundle made by make-offline-bundle.sh. Run as root from the unpacked bundle:
#
#   tar -xf jobflow-offline-<version>.tar -C /tmp
#   sudo /tmp/jobflow-offline-<version>/install-offline.sh
#
# Installs Docker, Restic, jq and rsync from the bundled packages (only those
# missing or older on the server), loads the images, puts the code in
# /srv/bayan-jobflow and prepares deploy/.env. Then run install.sh as printed.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
target="${JOBFLOW_DIR:-/srv/bayan-jobflow}"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "Run as root (sudo)"
[[ "$(dpkg --print-architecture)" == amd64 ]] || die "This bundle is for amd64 servers"
grep -q 'VERSION_ID="24.04"' /etc/os-release || log "warning: this bundle was prepared for Ubuntu 24.04"

cd "$here"
log "Checking the bundle"
sha256sum -c --quiet SHA256SUMS || die "The bundle is damaged (checksum mismatch); copy it again"

log "Installing system packages from the bundle"
pick="$(mktemp -d)"; trap 'rm -rf "$pick"' EXIT
for deb in debs/*.deb; do
  pkg="$(dpkg-deb -f "$deb" Package)"; ver="$(dpkg-deb -f "$deb" Version)"
  # dpkg-query fails for packages that are not installed: that is expected here.
  status="$(dpkg-query -W -f='${Status} ${Version}' "$pkg" 2>/dev/null || true)"
  have="$(awk '/install ok installed/ {print $4}' <<<"$status")"
  # Never downgrade what the server already has.
  if [[ -z "$have" ]] || dpkg --compare-versions "$have" lt "$ver"; then cp "$deb" "$pick/"; fi
done
if compgen -G "$pick/*.deb" >/dev/null; then
  # dpkg installs the whole set in one go and orders it itself (apt refuses to
  # upgrade essential packages such as perl-base from local files).
  DEBIAN_FRONTEND=noninteractive dpkg -i --force-confold "$pick"/*.deb >/dev/null || DEBIAN_FRONTEND=noninteractive dpkg --configure -a
  [[ -z "$(dpkg --audit)" ]] || { dpkg --audit; die "Some packages are not fully installed"; }
else
  log "All packages already installed"
fi
if [[ -d /run/systemd/system ]]; then
  systemctl enable --now docker
else
  log "warning: systemd is not running; start dockerd yourself"
fi
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker compose version >/dev/null || die "Docker Compose did not install"

log "Loading images (this takes a few minutes)"
docker load -i images.tar

if [[ -d "$target/.git" ]]; then
  log "$target already exists; leaving the code as it is (use update.sh for updates)"
else
  log "Putting the code in $target"
  git --version >/dev/null 2>&1 || die "git is missing (it is part of Ubuntu Server; install it from the Ubuntu ISO)"
  git clone -q repo.bundle "$target"
  git -C "$target" remote remove origin 2>/dev/null || true
fi

cat <<MSG

Offline installation prepared ($(cat VERSION)).

Next:
  cd $target
  ./deploy/scripts/install.sh      # first run creates deploy/.env; edit JOBFLOW_HOST and BIND_IP
  ./deploy/scripts/install.sh      # second run starts JobFlow (no build, no internet)
  ./deploy/scripts/create-admin.sh
  sudo ./deploy/scripts/install-backups.sh
See docs/install-offline.md.
MSG
