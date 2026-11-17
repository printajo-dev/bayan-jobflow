# Shared helpers for the JobFlow operations scripts. Sourced, not run.
# shellcheck shell=bash
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034  # used by the scripts that source this file
REPO_DIR="$(dirname "$DEPLOY_DIR")"
cd "$DEPLOY_DIR"

if [[ ! -f .env ]]; then echo "deploy/.env not found. Run deploy/scripts/install.sh first." >&2; exit 1; fi
set -a; source ./.env; set +a

DATA_ROOT="${DATA_ROOT:-/srv/company-data}"
BACKUP_ROOT="${BACKUP_ROOT:-$DATA_ROOT/backups}"
# Readable by the API (shown on Administration → System); holds no secrets.
STATUS_DIR="${STATUS_DIR:-$DATA_ROOT/backup-status}"
export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-$BACKUP_ROOT/restic}"
export RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-$DEPLOY_DIR/restic-password}"
OFFSITE_REPOSITORY="${OFFSITE_REPOSITORY:-/media/jobflow-backup/restic}"
DB_DUMP_KEEP_DAYS="${DB_DUMP_KEEP_DAYS:-14}"
RESTIC_KEEP="${RESTIC_KEEP:---keep-daily 14 --keep-weekly 8 --keep-monthly 12}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-bayan-jobflow}"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
dc() { docker compose -p "$COMPOSE_PROJECT" "$@"; }

# record_status <name> <ok:true|false> [detail]
record_status() {
  mkdir -p "$STATUS_DIR"; chmod 755 "$STATUS_DIR"
  local file="$STATUS_DIR/status.json" tmp
  tmp="$(mktemp "$STATUS_DIR/.status.XXXXXX")"
  [[ -s "$file" ]] || echo '{}' > "$file"
  jq --arg k "$1" --argjson ok "$2" --arg at "$(date -u +%FT%TZ)" --arg d "${3:-}" \
    '.[$k] = {ok: $ok, at: $at, detail: $d}' "$file" > "$tmp"
  chmod 644 "$tmp"; mv "$tmp" "$file"
}

maintenance() { dc exec -T api node dist/cli/maintenance.js "$@" || log "warning: could not change maintenance mode"; }

need() { command -v "$1" >/dev/null || die "$1 is not installed (sudo apt install $2)"; }
