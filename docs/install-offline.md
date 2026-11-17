# Installing and updating with no internet

The office server never needs internet: not to install, not to run, not to
update. Everything comes on one file, the **offline bundle**, made on any
computer that has internet and Docker, and carried to the server on a USB
disk.

```
 PC with internet + Docker                         Office server (no internet)
 ─────────────────────────                         ───────────────────────────
 make-offline-bundle.sh  ──► jobflow-offline-<version>.tar ──USB──► install-offline.sh / update.sh
```

## 1. Make the bundle (PC with internet)

Needs: Docker (Linux, or Docker Desktop on Windows/macOS with WSL or Git Bash)
and Git.

```bash
git clone https://github.com/printajo-dev/bayan-jobflow.git
cd bayan-jobflow
./deploy/scripts/make-offline-bundle.sh            # this version
./deploy/scripts/make-offline-bundle.sh v1.2.0     # or a specific release
```

Result: `dist/jobflow-offline-<version>.tar` (about 1–1.5 GB) and its SHA-256.
It contains:

| Part | What |
|---|---|
| `images.tar` | JobFlow API/worker and web/HTTPS images, PostgreSQL 17, Redis 8 |
| `debs/` | Docker Engine and Compose, Restic, jq, rsync, git for Ubuntu 24.04 (amd64), with their dependencies |
| `repo.bundle` | The source code and scripts at that version |
| `install-offline.sh`, `VERSION`, `SHA256SUMS` | Installer, version, checksums of every part |

Copy the `.tar` to a USB disk and write down the SHA-256.

## 2. First installation (office server)

The server: Ubuntu Server 24.04 LTS (amd64), installed from the ISO with a
fixed LAN IP address (e.g. `192.168.0.1`). Nothing else is needed.

```bash
sudo mount /dev/sdb1 /mnt                       # the USB disk
sha256sum /mnt/jobflow-offline-*.tar            # must match what you wrote down
sudo tar -xf /mnt/jobflow-offline-*.tar -C /tmp
sudo /tmp/jobflow-offline-*/install-offline.sh
```

`install-offline.sh` checks the bundle, installs Docker, Restic, jq, rsync and
git from the bundle (only what is missing or older; it never downgrades), loads
the images and puts the code in `/srv/bayan-jobflow`. Then:

```bash
cd /srv/bayan-jobflow
sudo ./deploy/scripts/install.sh       # creates deploy/.env with random passwords
sudo nano deploy/.env                  # JOBFLOW_HOST and BIND_IP = the server's LAN IP
sudo ./deploy/scripts/install.sh       # creates the data folders and starts JobFlow (no build, no download)
sudo ./deploy/scripts/create-admin.sh  # the first administrator
sudo ./deploy/scripts/export-ca.sh     # HTTPS certificate for the office PCs
sudo ./deploy/scripts/firewall.sh install
sudo ./deploy/scripts/install-backups.sh
```

Set the server's fixed address first (§2a). Then install the HTTPS
certificate on each office PC (`docs/install-ubuntu.md` §5) and run the
go-live checks in `docs/acceptance.md`.

## 2a. Office network: server and PCs on one switch

JobFlow is reached by the server's fixed IP address over the office cable
network, for example `https://192.168.0.1`. No internet, router, domain name
or DNS server is needed.

### Choose the addresses

All devices must be in the same network, e.g. `192.168.0.0/24` (addresses
`192.168.0.1` to `192.168.0.254`, subnet mask `255.255.255.0`), and **no two
devices may have the same address**.

| Your network | Server address | Office PCs |
|---|---|---|
| **Only a switch, no router** (no internet) | `192.168.0.1` is fine | Nothing hands out addresses automatically: give each PC a fixed address, e.g. `192.168.0.11`, `192.168.0.12`, … (keep a list) |
| **A router is also on the switch** | The router usually already uses `192.168.0.1`: give the server another one, e.g. `192.168.0.10`, outside the router's DHCP range (or reserve it in the router) | Usually automatic (DHCP) from the router |

Write the server's address on a label on the server.

### Fixed address on the server (Ubuntu)

Find the network port name with `ip -br link` (e.g. `enp1s0`), then create
`/etc/netplan/01-office.yaml` (replace the port name and address):

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      addresses: [192.168.0.1/24]
      # No gateway and no DNS: the office network has no internet.
      # Keep the address even while the cable or switch is off.
      ignore-carrier: true
```

```bash
sudo chmod 600 /etc/netplan/01-office.yaml
sudo netplan apply
ip -4 addr show enp1s0          # must show 192.168.0.1/24
```

Then put the same address in `deploy/.env`:

```
JOBFLOW_HOST=192.168.0.1
BIND_IP=192.168.0.1
```

`install.sh` also lets the web server start before the network is up (for
example after a power cut, when the server boots faster than the switch). It
starts answering as soon as the cable is connected.

### Office PCs (Windows 10/11), only when there is no router

*Settings → Network & internet → Ethernet → IP assignment → Edit → Manual →
IPv4 on*:

- IP address: `192.168.0.11` (a different number for each PC)
- Subnet mask: `255.255.255.0` (or prefix length `24`)
- Gateway and DNS: leave empty

Check from the PC: `ping 192.168.0.1` in Command Prompt must answer.

### Then, on every PC

1. Install the HTTPS certificate once (`docs/install-ubuntu.md` §5); without
   it the browser warns and the microphone (voice notes) does not work.
2. Open `https://192.168.0.1` in Chrome or Edge and bookmark it, or create a
   desktop shortcut to that address.

Tablets on Wi-Fi work the same way if the Wi-Fi access point is connected to
the same switch and gives addresses in the same network.

### Firewall

One command, no internet needed:

```bash
sudo ./deploy/scripts/firewall.sh install          # office network = BIND_IP's /24, e.g. 192.168.0.0/24
sudo ./deploy/scripts/firewall.sh status
```

It allows SSH only from the office network, denies all other incoming
connections, and lets only the office network reach JobFlow (ports 80/443;
Docker's ports bypass UFW, so a rule in Docker's `DOCKER-USER` chain does
this). The rule is re-applied at every boot. For a different range:
`firewall.sh install 192.168.0.0/23`.

### Changing the server's address later

Change the netplan file and `deploy/.env`, run `sudo netplan apply` and
`cd deploy && docker compose up -d`. JobFlow issues a certificate for the new
address from the same certificate authority, so the PCs need nothing new; only
their bookmarks change.

### Time on the PCs

All dates and times in JobFlow (deadlines, history, approvals) come from the
server's clock, not the PCs', so keep the server's time right (§4).

## 3. Updating (office server)

Make a bundle of the new version on the internet PC, copy it to the server,
then:

```bash
sudo /srv/bayan-jobflow/deploy/scripts/update.sh /mnt/jobflow-offline-v1.2.0.tar
```

The update checks the bundle, turns maintenance mode on, backs up the database
(kept in `/srv/company-data/backups/pre-update/`), keeps the running version's
images as `:previous`, loads the new images and code, starts them (database
migrations run first) and turns maintenance mode off. If anything fails before
the new version starts, the running version stays as it was and users are let
back in. To go back: `sudo ./deploy/scripts/rollback.sh` (see
`docs/maintenance.md` §8). No internet is used at any point.

## 4. Clock

With no internet the server cannot set its clock from the internet. Deadlines,
reminders, the audit history and the HTTPS certificates depend on the right
time:

- If the router or another server on the LAN provides time (NTP), point the
  server at it: set `NTP=<router IP>` in `/etc/systemd/timesyncd.conf`, then
  `sudo systemctl restart systemd-timesyncd` and check `timedatectl`.
- Otherwise check `timedatectl` once a month and correct it with
  `sudo timedatectl set-time "2026-11-17 09:30:00"`.

The time zone is `Asia/Dubai` (`TZ` in `deploy/.env`); `sudo timedatectl
set-timezone Asia/Dubai` sets it for the server itself.

## 5. What runs where

Nothing in JobFlow contacts the internet: the web app loads no fonts, scripts
or images from outside, HTTPS uses JobFlow's own certificate authority,
notifications are in-app only, and backups go to local and external disks.
This was tested with all internet traffic blocked (`docs/acceptance.md`, test
22).
