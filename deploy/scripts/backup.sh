#!/usr/bin/env bash
# JobFlow backups. Run as root (systemd timers do this; see docs/maintenance.md).
#
#   backup.sh db       PostgreSQL logical backup (pg_dump, custom format), verified
#   backup.sh files    Restic snapshot of uploads, database dumps, Caddy CA and deploy/.env
#   backup.sh offsite  Copy the Restic repository to the external disk
#   backup.sh all      db + files
#
# Never copy /srv/company-data/postgres while PostgreSQL runs: that is not a backup.
source "$(dirname "$0")/lib.sh"

backup_db() {
  local dir="$BACKUP_ROOT/db" ts out
  ts="$(date +%Y%m%d-%H%M%S)"; out="$dir/jobflow-$ts.dump"
  mkdir -p "$dir"; chmod 700 "$BACKUP_ROOT" "$dir"
  log "Database backup → $out"
  if ! dc exec -T postgres pg_dump -U jobflow -d jobflow --format=custom --compress=6 > "$out.partial"; then
    rm -f "$out.partial"; die "pg_dump failed"
  fi
  # A dump that pg_restore cannot read is not a backup.
  dc exec -T postgres pg_restore --list < "$out.partial" > /dev/null || die "pg_restore cannot read the new dump"
  mv "$out.partial" "$out"; chmod 600 "$out"
  sha256sum "$out" | sed "s#  .*/#  #" > "$out.sha256"
  find "$dir" -name 'jobflow-*.dump*' -mtime +"$DB_DUMP_KEEP_DAYS" -delete
  log "Database backup OK ($(du -h "$out" | cut -f1))"
}

restic_init() {
  [[ -s "$RESTIC_PASSWORD_FILE" ]] || die "Restic password file $RESTIC_PASSWORD_FILE is missing (run deploy/scripts/install-backups.sh)"
  if ! restic cat config >/dev/null 2>&1; then
    if [[ -e "$RESTIC_REPOSITORY/config" ]]; then
      die "Cannot open the Restic repository: wrong password in $RESTIC_PASSWORD_FILE, or the repository is damaged"
    fi
    log "Creating Restic repository $RESTIC_REPOSITORY"
    restic init >/dev/null
  fi
}

backup_files() {
  need restic restic
  restic_init
  log "File backup → $RESTIC_REPOSITORY"
  restic backup --tag jobflow --host jobflow \
    "$DATA_ROOT/files" "$BACKUP_ROOT/db" "$DATA_ROOT/caddy/data" "$DEPLOY_DIR/.env" \
    --exclude "$DATA_ROOT/files/tmp"
  restic forget --tag jobflow --host jobflow $RESTIC_KEEP --prune
  restic check --read-data-subset=5%
  log "File backup OK"
}

backup_offsite() {
  need restic restic
  local mountdir; mountdir="$(dirname "$OFFSITE_REPOSITORY")"
  # The disk carries a marker file so we never write to an empty mount point
  # on the system disk when the external disk is not plugged in.
  [[ -f "$mountdir/.jobflow-backup-disk" ]] || die "External backup disk not mounted at $mountdir (marker .jobflow-backup-disk missing)"
  if ! RESTIC_REPOSITORY="$OFFSITE_REPOSITORY" restic cat config >/dev/null 2>&1; then
    log "Creating Restic repository on the external disk"
    # shellcheck disable=SC2097,SC2098  # --from-repo must expand to the local repository
    RESTIC_REPOSITORY="$OFFSITE_REPOSITORY" restic init --from-repo "$RESTIC_REPOSITORY" --from-password-file "$RESTIC_PASSWORD_FILE" --copy-chunker-params >/dev/null
  fi
  log "Copying snapshots to $OFFSITE_REPOSITORY"
  # shellcheck disable=SC2097,SC2098
  RESTIC_REPOSITORY="$OFFSITE_REPOSITORY" restic copy --from-repo "$RESTIC_REPOSITORY" --from-password-file "$RESTIC_PASSWORD_FILE"
  RESTIC_REPOSITORY="$OFFSITE_REPOSITORY" restic forget --tag jobflow --host jobflow $RESTIC_KEEP --prune
  RESTIC_REPOSITORY="$OFFSITE_REPOSITORY" restic check --read-data-subset=10%
  log "External copy OK. You can unmount the disk and store it away from the server."
}

run() { # run <status-name> <function>
  local name="$1" fn="$2" errfile rc
  errfile="$(mktemp)"
  # Not inside an `if`: bash ignores `set -e` in conditions, which would let a
  # failed step continue and be recorded as a success.
  set +e
  ( set -e; "$fn" ) 2> >(tee "$errfile" >&2)
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    record_status "$name" true
  else
    record_status "$name" false "$(grep -v '^\s*$' "$errfile" | tail -n 1 | cut -c1-300)"
  fi
  rm -f "$errfile"
  return $rc
}

case "${1:-}" in
  db) run database backup_db ;;
  files) run files backup_files ;;
  offsite) run offsite backup_offsite ;;
  all) run database backup_db && run files backup_files ;;
  *) echo "Usage: $0 db|files|offsite|all" >&2; exit 2 ;;
esac
