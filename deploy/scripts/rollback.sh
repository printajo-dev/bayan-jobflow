#!/usr/bin/env bash
# Return to the version that was running before the last update.sh (also
# after an update that failed to start). Run as root:
#   sudo /srv/bayan-jobflow/deploy/scripts/rollback.sh
# If the update changed the database (new migrations), the database is
# restored from the backup taken just before the update: anything entered
# after the update is lost, so roll back quickly or fix forward instead.
source "$(dirname "$0")/lib.sh"
# The whole script is read before it runs: it checks out another version of
# itself part-way through, and bash otherwise reads scripts as they execute.
main() {
state="$BACKUP_ROOT/last-update"
TAG="${JOBFLOW_VERSION:-local}"
[[ -f "$state" ]] || die "No previous update recorded ($state)"
previous_commit="" pre_update_dump="" updated_at="" status=""
# shellcheck disable=SC1090
source "$state"
cd "$REPO_DIR" || die "cannot enter $REPO_DIR"
current="$(git rev-parse HEAD)"
[[ "$current" != "$previous_commit" ]] || die "Already at $previous_commit"
git cat-file -e "$previous_commit^{commit}" 2>/dev/null || die "Commit $previous_commit is not in this checkout"
migrations_changed="$(git diff --name-only "$previous_commit" "$current" -- apps/api/prisma/migrations)"

# Check everything before changing anything.
for img in api web; do
  docker image inspect "bayan-jobflow-$img:previous" >/dev/null 2>&1 || die "Image bayan-jobflow-$img:previous is missing; cannot roll back without internet"
done
if [[ -n "$migrations_changed" ]]; then
  [[ -f "$pre_update_dump" ]] || die "The pre-update database backup $pre_update_dump is missing; rolling back would start old code on the new database. Fix forward instead."
fi

echo "Roll back from $(cut -c1-12 <<<"$current") to $(cut -c1-12 <<<"$previous_commit") (update started $updated_at, status $status)."
[[ -n "$migrations_changed" ]] && echo "The update changed the database: it will be restored from $pre_update_dump. Data entered since then is LOST."
read -r -p "Type ROLLBACK to continue: " answer
[[ "$answer" == "ROLLBACK" ]] || die "Cancelled"

cd "$DEPLOY_DIR" || die "cannot enter $DEPLOY_DIR"
maintenance on "Returning to the previous version"
git -C "$REPO_DIR" checkout -q --detach "$previous_commit"
sed -i "s/^JOBFLOW_RELEASE=.*/JOBFLOW_RELEASE=$(git -C "$REPO_DIR" describe --tags --always)/" .env
for img in api web; do
  docker tag "bayan-jobflow-$img:previous" "bayan-jobflow-$img:$TAG"
done
if [[ -n "$migrations_changed" ]]; then
  ASSUME_YES=1 "$DEPLOY_DIR/scripts/restore.sh" production --dump "$pre_update_dump"
else
  dc up -d --no-build --wait --wait-timeout 300
  maintenance off
fi
sed -i 's/^status=.*/status=rolled-back/' "$state"
log "Rolled back to $(cut -c1-12 <<<"$previous_commit")."
}
main "$@"
