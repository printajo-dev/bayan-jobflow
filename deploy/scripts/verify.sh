#!/usr/bin/env bash
# Post-install / post-reboot check (acceptance test 24). Run as root.
#   verify.sh             services healthy, HTTPS answers, database reachable
#   verify.sh snapshot    also save row counts and a checksum of all uploads
#   verify.sh compare     check again and compare with the saved snapshot
# Typical reboot test:  verify.sh snapshot && sudo reboot   … then: verify.sh compare
source "$(dirname "$0")/lib.sh"
state="$BACKUP_ROOT/verify-snapshot"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then log "OK    $1"; else log "FAIL  $1"; fail=1; fi; }

check "Docker starts on boot" "systemctl is-enabled docker"
for s in postgres redis api worker caddy; do
  check "service $s running" "[[ \$(docker inspect -f '{{.State.Running}}' \$(dc ps -q $s)) == true ]]"
done
check "API healthy" "[[ \$(docker inspect -f '{{.State.Health.Status}}' \$(dc ps -q api)) == healthy ]]"
check "HTTPS answers on https://$JOBFLOW_HOST" "curl -sfk --resolve '$JOBFLOW_HOST:443:$BIND_IP' https://$JOBFLOW_HOST/api/v1/health/ready"
check "PostgreSQL and Redis publish no ports" "[[ -z \$(dc port postgres 5432 2>/dev/null) && -z \$(dc port redis 6379 2>/dev/null) ]]"

fingerprint() {
  dc exec -T postgres psql -U jobflow -d jobflow -At -c \
    "SELECT 'jobs=' || (SELECT count(*) FROM jobs) || ' users=' || (SELECT count(*) FROM users) || ' files=' || (SELECT count(*) FROM files) || ' messages=' || (SELECT count(*) FROM discussion_messages) || ' audit=' || (SELECT count(*) FROM audit_logs)"
  echo "uploads=$(find "$DATA_ROOT/files" -mindepth 3 -type f -exec sha256sum {} + | sort | sha256sum | cut -c1-16)"
  echo "ca=$(sha256sum "$DATA_ROOT/caddy/data/caddy/pki/authorities/local/root.crt" 2>/dev/null | cut -c1-16)"
}

case "${1:-}" in
  snapshot) fingerprint > "$state"; log "Saved snapshot:"; cat "$state" ;;
  compare)
    [[ -f "$state" ]] || die "No snapshot; run verify.sh snapshot before the reboot"
    if diff <(cat "$state") <(fingerprint); then log "OK    data identical to the snapshot (rows, uploads, HTTPS root certificate)"; else log "FAIL  data differs from the snapshot"; fail=1; fi ;;
esac
exit $fail
