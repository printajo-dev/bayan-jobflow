#!/usr/bin/env bash
# Return to the version that was running before the last update.sh.
#   sudo /srv/bayan-jobflow/deploy/scripts/rollback.sh
# If the update changed the database (new migrations), the database is
# restored from the backup taken just before the update: anything entered
# after the update is lost, so roll back quickly or fix forward instead.
source "$(dirname "$0")/lib.sh"
state="$BACKUP_ROOT/last-update"
[[ -f "$state" ]] || die "No previous update recorded ($state)"
previous_commit="" pre_update_dump="" updated_at=""
# shellcheck disable=SC1090
source "$state"
cd "$REPO_DIR"
current="$(git rev-parse HEAD)"
[[ "$current" != "$previous_commit" ]] || die "Already at $previous_commit"
migrations_changed="$(git diff --name-only "$previous_commit" "$current" -- apps/api/prisma/migrations)"

echo "Roll back from $(cut -c1-12 <<<"$current") to $(cut -c1-12 <<<"$previous_commit") (updated $updated_at)."
[[ -n "$migrations_changed" ]] && echo "The update changed the database: it will be restored from $pre_update_dump. Data entered since then is LOST."
read -r -p "Type ROLLBACK to continue: " answer
[[ "$answer" == "ROLLBACK" ]] || die "Cancelled"

cd "$DEPLOY_DIR"
maintenance on "Returning to the previous version"
cd "$REPO_DIR"; git checkout --detach "$previous_commit"; cd "$DEPLOY_DIR"
sed -i "s/^JOBFLOW_RELEASE=.*/JOBFLOW_RELEASE=$(git -C "$REPO_DIR" describe --tags --always)/" .env
for img in api web; do
  if docker image inspect "bayan-jobflow-$img:previous" >/dev/null 2>&1; then
    docker tag "bayan-jobflow-$img:previous" "bayan-jobflow-$img:${JOBFLOW_VERSION:-local}"
  else
    log "No previous $img image; rebuilding"; dc build
  fi
done
if [[ -n "$migrations_changed" ]]; then
  ASSUME_YES=1 "$DEPLOY_DIR/scripts/restore.sh" production --dump "$pre_update_dump"
else
  dc up -d --wait --wait-timeout 300
  maintenance off
fi
log "Rolled back to $(cut -c1-12 <<<"$previous_commit")."
