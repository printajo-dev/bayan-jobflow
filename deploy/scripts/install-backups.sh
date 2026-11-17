#!/usr/bin/env bash
# Sets up backups once: installs Restic, creates the encryption password and
# repository, and installs the systemd timers. Run as root:
#   sudo /srv/bayan-jobflow/deploy/scripts/install-backups.sh
source "$(dirname "$0")/lib.sh"
[[ $EUID -eq 0 ]] || die "Run as root (sudo)"
command -v restic >/dev/null || apt-get install -y restic
command -v jq >/dev/null || apt-get install -y jq
command -v rsync >/dev/null || apt-get install -y rsync

if [[ ! -s "$RESTIC_PASSWORD_FILE" ]]; then
  umask 077; openssl rand -base64 32 > "$RESTIC_PASSWORD_FILE"
  echo "Created the backup encryption password in $RESTIC_PASSWORD_FILE."
  echo "WITHOUT IT THE BACKUPS CANNOT BE RESTORED. Print it and keep it in the office safe:"
  echo; cat "$RESTIC_PASSWORD_FILE"; echo
fi
mkdir -p "$BACKUP_ROOT" "$STATUS_DIR"; chmod 700 "$BACKUP_ROOT"; chmod 755 "$STATUS_DIR"
restic cat config >/dev/null 2>&1 || restic init

for unit in "$DEPLOY_DIR"/systemd/*.{service,timer}; do
  sed "s#/srv/bayan-jobflow#$REPO_DIR#g" "$unit" > "/etc/systemd/system/$(basename "$unit")"
done
systemctl daemon-reload
systemctl enable --now jobflow-backup-db.timer jobflow-backup-files.timer jobflow-backup-offsite.timer jobflow-restore-test.timer
systemctl list-timers 'jobflow-*'
log "Running a first backup now"
"$DEPLOY_DIR/scripts/backup.sh" all
