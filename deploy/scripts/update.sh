#!/usr/bin/env bash
# Update JobFlow to a newer version. Run as root from anywhere:
#   sudo /srv/bayan-jobflow/deploy/scripts/update.sh            # latest commit of the current branch
#   sudo /srv/bayan-jobflow/deploy/scripts/update.sh v1.2.0     # a tag or commit
# Takes a database backup, keeps the current images as :previous so
# rollback.sh can return to them, then builds and starts the new version.
source "$(dirname "$0")/lib.sh"
ref="${1:-}"
cd "$REPO_DIR"
[[ -z "$(git status --porcelain --untracked-files=no)" ]] || die "Local changes in $REPO_DIR; commit or discard them first"
prev="$(git rev-parse HEAD)"

cd "$DEPLOY_DIR"
maintenance on "Updating JobFlow; back in a few minutes"
log "Pre-update database backup"
"$DEPLOY_DIR/scripts/backup.sh" db || { maintenance off; die "Backup failed; update cancelled"; }
dump="$(find "$BACKUP_ROOT/db" -name 'jobflow-*.dump' | sort | tail -n 1)"

for img in api web; do
  docker image inspect "bayan-jobflow-$img:${JOBFLOW_VERSION:-local}" >/dev/null 2>&1 &&
    docker tag "bayan-jobflow-$img:${JOBFLOW_VERSION:-local}" "bayan-jobflow-$img:previous"
done
printf 'previous_commit=%s\npre_update_dump=%s\nupdated_at=%s\n' "$prev" "$dump" "$(date -u +%FT%TZ)" > "$BACKUP_ROOT/last-update"

cd "$REPO_DIR"
log "Fetching the new version"
if [[ -n "$ref" ]]; then git fetch --tags origin && git checkout --detach "$ref"; else git pull --ff-only; fi
release="$(git describe --tags --always)"
cd "$DEPLOY_DIR"
if grep -q '^JOBFLOW_RELEASE=' .env; then sed -i "s/^JOBFLOW_RELEASE=.*/JOBFLOW_RELEASE=$release/" .env; else echo "JOBFLOW_RELEASE=$release" >> .env; fi

log "Building $release"
dc build
log "Starting (database migrations run first)"
if ! dc up -d --wait --wait-timeout 300; then
  dc logs --tail 50 migrate api || true
  die "The new version did not start. Run deploy/scripts/rollback.sh to return to $prev"
fi
maintenance off
log "Updated $(cut -c1-12 <<<"$prev") → $release. Rollback: deploy/scripts/rollback.sh"
