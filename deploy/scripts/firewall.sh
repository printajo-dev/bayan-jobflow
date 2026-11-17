#!/usr/bin/env bash
# Office-network firewall for the JobFlow server. Works with no internet.
#
#   sudo ./deploy/scripts/firewall.sh install [SUBNET]   set up once (default: BIND_IP's /24, e.g. 192.168.0.0/24)
#   sudo ./deploy/scripts/firewall.sh apply              re-apply the Docker rule (run at every boot by systemd)
#   sudo ./deploy/scripts/firewall.sh status
#
# - UFW: SSH only from the office network, everything else incoming denied.
# - Docker publishes ports outside UFW, so a rule in Docker's DOCKER-USER
#   chain lets only the office network reach JobFlow's ports 80/443.
source "$(dirname "$0")/lib.sh"
[[ $EUID -eq 0 ]] || die "Run as root (sudo)"
CONF=/etc/bayan-jobflow-firewall.conf
TAG="bayan-jobflow"

iface_of_bind_ip() { ip -4 -o addr show | awk -v ip="$BIND_IP" '{split($4, a, "/"); if (a[1] == ip) {print $2; exit}}'; }

apply_docker_rule() {
  # shellcheck disable=SC1090
  source "$CONF"
  iptables -n -L DOCKER-USER >/dev/null 2>&1 || iptables -N DOCKER-USER
  # Remove our earlier rules (marked with a comment), then add them again.
  while read -r num; do iptables -D DOCKER-USER "$num"; done < <(iptables -L DOCKER-USER --line-numbers -n | awk -v t="$TAG" '$0 ~ t {print $1}' | sort -rn)
  iptables -I DOCKER-USER -i "$IFACE" ! -s "$SUBNET" -j DROP -m comment --comment "$TAG: only the office network"
  iptables -I DOCKER-USER -i "$IFACE" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN -m comment --comment "$TAG: replies"
  log "Docker ports on $IFACE reachable only from $SUBNET"
}

case "${1:-}" in
  install)
    iface="$(iface_of_bind_ip)"
    [[ -n "$iface" ]] || die "$BIND_IP is not configured on this server; set the fixed IP first (docs/install-offline.md, Office network)"
    subnet="${2:-$(cut -d. -f1-3 <<<"$BIND_IP").0/24}"
    [[ "$subnet" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+$ ]] || die "Subnet must look like 192.168.0.0/24"
    printf 'IFACE=%s\nSUBNET=%s\n' "$iface" "$subnet" > "$CONF"
    if command -v ufw >/dev/null; then
      ufw allow from "$subnet" to any port 22 proto tcp >/dev/null
      ufw default deny incoming >/dev/null
      ufw --force enable >/dev/null
      log "UFW: SSH allowed from $subnet only; other incoming connections denied"
    else
      log "warning: ufw not found; only the Docker rule is applied"
    fi
    cat > /etc/systemd/system/bayan-jobflow-firewall.service <<UNIT
[Unit]
Description=Bayan JobFlow office-network rule for Docker ports
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=$DEPLOY_DIR/scripts/firewall.sh apply
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
UNIT
    if [[ -d /run/systemd/system ]]; then
      systemctl daemon-reload
      systemctl enable bayan-jobflow-firewall.service >/dev/null 2>&1
    else
      log "warning: systemd is not running; run '$0 apply' after each boot"
    fi
    apply_docker_rule
    log "Firewall installed; it is re-applied at every boot. Test from a PC: https://$BIND_IP"
    ;;
  apply)
    [[ -f "$CONF" ]] || die "Run '$0 install' first"
    apply_docker_rule
    ;;
  status)
    [[ -f "$CONF" ]] && cat "$CONF"
    command -v ufw >/dev/null && ufw status verbose
    iptables -L DOCKER-USER -n -v | grep -E "Chain|$TAG" || true
    ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
