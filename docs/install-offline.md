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
fixed LAN IP address (e.g. `192.168.1.50`). Nothing else is needed.

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
sudo ./deploy/scripts/install-backups.sh
```

Continue with *Install the HTTPS certificate on each office PC* and *Firewall*
in `docs/install-ubuntu.md` (sections 5 and 6), and the go-live checks in
`docs/acceptance.md`.

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
