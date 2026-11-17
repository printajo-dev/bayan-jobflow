#!/usr/bin/env bash
# Update JobFlow to a newer version. Run as root.
#
#   update.sh /media/usb/jobflow-offline-v1.2.0.tar   offline: from a bundle made by make-offline-bundle.sh
#   update.sh v1.2.0                                   online: a git tag or commit (needs internet)
#   update.sh                                          online: latest commit of the current branch
#
# Steps: maintenance mode on, database backup (kept apart from the daily
# ones), current images kept as :previous, new code and images, start
# (migrations run first), maintenance mode off. If anything fails before the
# new version starts, the running version is left as it was and maintenance
# mode is turned off again. Use rollback.sh to return to the previous version.
source "$(dirname "$0")/lib.sh"
# The whole script is read before it runs: it checks out another version of
# itself part-way through, and bash otherwise reads scripts as they execute.
main() {
local arg="${1:-}"
state="$BACKUP_ROOT/last-update"
TAG="${JOBFLOW_VERSION:-local}"

if [[ -f "$state" ]] && grep -q '^status=in-progress' "$state"; then
  die "The last update did not finish. Run deploy/scripts/rollback.sh first (or delete $state if you fixed it by hand)."
fi

cd "$REPO_DIR" || die "cannot enter $REPO_DIR"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "Local changes in $REPO_DIR; commit or discard them first"
prev="$(git rev-parse HEAD)"
mode=git bundle_dir=""
if [[ -n "$arg" && -f "$arg" ]]; then
  mode=bundle
elif [[ -z "$arg" ]] && ! git symbolic-ref -q HEAD >/dev/null; then
  die "This checkout is not on a branch. Give the version: update.sh <bundle file | tag>"
fi

cleanup() { [[ -n "$bundle_dir" ]] && rm -rf "$bundle_dir"; return 0; }
trap cleanup EXIT

if [[ $mode == bundle ]]; then
  bundle_dir="$(mktemp -d "$BACKUP_ROOT/.bundle.XXXXXX")"
  log "Unpacking $(basename "$arg")"
  tar -xf "$arg" -C "$bundle_dir" --strip-components=1
  (cd "$bundle_dir" && sha256sum -c --quiet SHA256SUMS) || die "The bundle is damaged (checksum mismatch); copy it again"
fi

cd "$DEPLOY_DIR" || die "cannot enter $DEPLOY_DIR"
maintenance on "Updating JobFlow; back in a few minutes"
# Until the new version is up, any failure returns users to the running version.
trap 'log "Update failed; the running version was left in place"; maintenance off; cleanup' ERR

log "Pre-update database backup"
"$DEPLOY_DIR/scripts/backup.sh" db
mkdir -p "$BACKUP_ROOT/pre-update"; chmod 700 "$BACKUP_ROOT/pre-update"
latest="$(find "$BACKUP_ROOT/db" -name 'jobflow-*.dump' | sort | tail -n 1)"
dump="$BACKUP_ROOT/pre-update/$(basename "$latest")"
cp -p "$latest" "$dump"
# Keep the three most recent pre-update dumps (rollback needs the last one).
find "$BACKUP_ROOT/pre-update" -name 'jobflow-*.dump' | sort | head -n -3 | xargs -r rm -f

for img in api web; do
  docker tag "bayan-jobflow-$img:$TAG" "bayan-jobflow-$img:previous"
done
printf 'status=in-progress\nprevious_commit=%s\npre_update_dump=%s\nupdated_at=%s\n' "$prev" "$dump" "$(date -u +%FT%TZ)" > "$state"

cd "$REPO_DIR" || die "cannot enter $REPO_DIR"
if [[ $mode == bundle ]]; then
  log "Loading the new images (no internet needed)"
  docker load -i "$bundle_dir/images.tar"
  git fetch -q "$bundle_dir/repo.bundle" HEAD
  git checkout -q --detach FETCH_HEAD
else
  log "Fetching the new version"
  if [[ -n "$arg" ]]; then git fetch -q --tags origin && git checkout -q --detach "$arg"; else git pull -q --ff-only; fi
fi
release="$(git describe --tags --always)"
cd "$DEPLOY_DIR" || die "cannot enter $DEPLOY_DIR"
if grep -q '^JOBFLOW_RELEASE=' .env; then sed -i "s/^JOBFLOW_RELEASE=.*/JOBFLOW_RELEASE=$release/" .env; else echo "JOBFLOW_RELEASE=$release" >> .env; fi

if [[ $mode == git ]]; then
  log "Building $release"
  dc build
fi
trap - ERR
log "Starting $release (database migrations run first)"
if ! dc up -d --no-build --wait --wait-timeout 300; then
  dc logs --tail 50 migrate api || true
  die "The new version did not start; maintenance mode stays on. Run deploy/scripts/rollback.sh to return to $(cut -c1-12 <<<"$prev")."
fi
sed -i 's/^status=in-progress/status=done/' "$state"
maintenance off
log "Updated $(cut -c1-12 <<<"$prev") → $release. To undo: deploy/scripts/rollback.sh"
}
main "$@"
