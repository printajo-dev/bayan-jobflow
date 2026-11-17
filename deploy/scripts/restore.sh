#!/usr/bin/env bash
# Restore JobFlow from backups. Run as root. See docs/maintenance.md.
#
#   restore.sh list
#       Show Restic snapshots and local database dumps.
#   restore.sh test [snapshot]
#       Restore a snapshot (default: latest) into a throw-away PostgreSQL
#       container and a temporary folder, then check that every table restored
#       and that every file recorded in the database exists with the right
#       SHA-256. Production is not touched. Runs monthly from a timer.
#   restore.sh production [snapshot] [--dump FILE]
#       Replace the live database and uploads with a snapshot (or only the
#       database with a given dump file). Takes a safety backup first, turns on
#       maintenance mode and asks for confirmation.
source "$(dirname "$0")/lib.sh"

PG_IMAGE="postgres:17.12-bookworm"
WORK="$BACKUP_ROOT/restore-work"

restore_snapshot() { # restore_snapshot <snapshot> <target>
  need restic restic
  rm -rf "$2"; mkdir -p "$2"; chmod 700 "$2"
  log "Restoring snapshot $1 to $2"
  restic restore "$1" --tag jobflow --host jobflow --target "$2" >/dev/null
}

latest_dump_in() { find "$1" -path '*/db/jobflow-*.dump' -type f | sort | tail -n 1; }

cmd_list() {
  need restic restic
  restic snapshots --tag jobflow
  echo; echo "Local database dumps:"; find "$BACKUP_ROOT/db" -name 'jobflow-*.dump' -printf '  %TF %TH:%TM  %10s  %f\n' 2>/dev/null | sort
}

cmd_test() {
  local snap="${1:-latest}" target="$WORK/test" name="jobflow-restore-test-$$" dump started
  started=$(date +%s)
  restore_snapshot "$snap" "$target"
  dump="$(latest_dump_in "$target")"; [[ -n "$dump" ]] || die "No database dump in the snapshot"
  log "Checking dump checksum"
  (cd "$(dirname "$dump")" && sha256sum -c "$(basename "$dump").sha256" >/dev/null) || die "Dump checksum mismatch"

  log "Starting a temporary PostgreSQL (no network)"
  docker run -d --rm --name "$name" --network none -e POSTGRES_PASSWORD=restore-test -e POSTGRES_USER=jobflow -e POSTGRES_DB=jobflow \
    --tmpfs /var/lib/postgresql/data:rw,size=4g "$PG_IMAGE" >/dev/null
  trap 'docker rm -f '"$name"' >/dev/null 2>&1 || true; rm -rf '"$target"'' EXIT
  for _ in $(seq 1 60); do docker exec "$name" pg_isready -U jobflow -d jobflow >/dev/null 2>&1 && break; sleep 1; done
  sleep 2
  log "Restoring $(basename "$dump")"
  docker exec -i "$name" pg_restore -U jobflow -d jobflow --no-owner --exit-on-error < "$dump"

  local q="docker exec -i $name psql -U jobflow -d jobflow -At -v ON_ERROR_STOP=1 -c"
  local tables users jobs files
  tables=$($q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
  users=$($q "SELECT count(*) FROM users"); jobs=$($q "SELECT count(*) FROM jobs"); files=$($q "SELECT count(*) FROM files")
  [[ "$tables" -gt 30 ]] || die "Only $tables tables restored"
  [[ "$users" -gt 0 ]] || die "No users in the restored database"
  $q "SELECT migration_name FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 1" >/dev/null

  log "Verifying $files files against the database checksums"
  local root="$target$DATA_ROOT/files" missing=0 bad=0 key sum
  while IFS='|' read -r key sum; do
    [[ -z "$key" ]] && continue
    if [[ ! -f "$root/$key" ]]; then missing=$((missing + 1))
    elif [[ "$(sha256sum "$root/$key" | cut -d' ' -f1)" != "$sum" ]]; then bad=$((bad + 1)); fi
  done < <($q "SELECT storage_key || '|' || sha256 FROM files")
  # Files uploaded after the dump was taken are in the snapshot but not in the
  # dump; that is expected. Files in the dump but missing are not.
  [[ $missing -eq 0 && $bad -eq 0 ]] || die "$missing files missing and $bad files damaged in the backup"
  [[ -f "$target$DATA_ROOT/caddy/data/caddy/pki/authorities/local/root.crt" ]] || log "warning: Caddy root certificate not in the snapshot"

  local msg="snapshot $snap: $tables tables, $users users, $jobs jobs, $files files verified in $(( $(date +%s) - started ))s"
  log "Restore test OK — $msg"
  echo "$msg"
}

cmd_production() {
  local snap="latest" dump=""
  while [[ $# -gt 0 ]]; do
    case "$1" in --dump) dump="$2"; shift 2 ;; *) snap="$1"; shift ;; esac
  done
  echo "This REPLACES the live JobFlow database${dump:+ with $dump}${dump:- and uploaded files with snapshot $snap}."
  echo "Everything entered since that backup will be lost. A safety backup is taken first."
  if [[ "${ASSUME_YES:-}" == "1" ]]; then answer=RESTORE; else read -r -p "Type RESTORE to continue: " answer; fi
  [[ "$answer" == "RESTORE" ]] || die "Cancelled"
  # Check every tool before anything is stopped.
  need restic restic; need rsync rsync; need jq jq
  [[ -z "$dump" || -f "$dump" ]] || die "Dump $dump not found"

  maintenance on "Restoring from backup"
  log "Safety backup of the current state"
  "$(dirname "$0")/backup.sh" db || die "Safety backup failed; nothing was changed"

  local target="$WORK/production" with_files=0
  rm -rf "$target"   # never reuse files left by an earlier, interrupted restore
  if [[ -z "$dump" ]]; then
    restore_snapshot "$snap" "$target"
    with_files=1
    dump="$(latest_dump_in "$target")"; [[ -n "$dump" ]] || die "No database dump in the snapshot"
  fi
  [[ -f "$dump" ]] || die "Dump $dump not found"

  log "Stopping the API and worker"
  dc stop caddy api worker
  log "Recreating the database"
  dc exec -T postgres psql -U jobflow -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='jobflow' AND pid <> pg_backend_pid()" \
    -c "DROP DATABASE jobflow" -c "CREATE DATABASE jobflow OWNER jobflow" >/dev/null
  dc exec -T postgres pg_restore -U jobflow -d jobflow --no-owner --exit-on-error < "$dump"

  if [[ $with_files -eq 1 && -d "$target$DATA_ROOT/files" ]]; then
    log "Restoring uploaded files"
    rsync -a --delete "$target$DATA_ROOT/files/" "$DATA_ROOT/files/"
    chown -R 1000:1000 "$DATA_ROOT/files"
  fi
  rm -rf "$target"

  log "Starting services (pending migrations are applied automatically)"
  dc up -d
  for _ in $(seq 1 60); do [[ "$(docker inspect -f '{{.State.Health.Status}}' "$(dc ps -q api)" 2>/dev/null)" == healthy ]] && break; sleep 2; done
  # Maintenance state was restored with the database; make sure it is off.
  maintenance off
  log "Restore finished. Check the application, then tell users they can continue."
}

case "${1:-}" in
  list) cmd_list ;;
  test)
    shift
    errfile="$(mktemp)"
    # Outside any `if` so that `set -e` applies inside the test.
    set +e
    out=$( set -e; cmd_test "$@" 2> >(tee "$errfile" >&2) )
    rc=$?
    set -e
    if [[ $rc -eq 0 ]]; then
      echo "$out"; record_status restore_test true "$(tail -n 1 <<<"$out")"
    else
      record_status restore_test false "$(grep -v '^\s*$' "$errfile" | tail -n 1 | cut -c1-300)"
    fi
    rm -f "$errfile"; exit $rc ;;
  production) shift; cmd_production "$@" ;;
  *) sed -n '2,18p' "$0"; exit 2 ;;
esac
