# Maintenance, backups, updates and rollback

For the person who looks after the JobFlow server. All commands run on the
server, as root (`sudo -i`), from `/srv/bayan-jobflow`.

| Task | Command | How often |
|---|---|---|
| Check health, disk, backups, failed events | *Administration → System* in the browser | weekly, and when something looks wrong |
| Database backup | automatic (`jobflow-backup-db.timer`, 01:30) | daily |
| File backup | automatic (`jobflow-backup-files.timer`, 02:30) | nightly |
| Copy to the external disk | plug the disk in on Sunday; automatic at 04:00 | weekly |
| Restore test | automatic (`jobflow-restore-test.timer`, 1st of the month) | monthly, and before go-live |
| Update | `deploy/scripts/update.sh` | when a new version is released |
| Roll back an update | `deploy/scripts/rollback.sh` | only if an update goes wrong |
| Check after a reboot | `deploy/scripts/verify.sh compare` | after every reboot |

## 1. What is backed up

| Data | Where it lives | How it is backed up |
|---|---|---|
| Database (jobs, workflow, tasks, messages, approvals, users, audit history) | `/srv/company-data/postgres` | `pg_dump` every night into `/srv/company-data/backups/db/` (kept 14 days), each dump checked with `pg_restore --list` and given a SHA-256 checksum |
| Uploaded files (briefs, artwork, voice notes, photos, evidence) | `/srv/company-data/files` | Restic snapshot every night |
| HTTPS root certificate (installed on every PC) | `/srv/company-data/caddy/data` | in the same Restic snapshot |
| Configuration and passwords (`deploy/.env`) | `/srv/bayan-jobflow/deploy/.env` | in the same Restic snapshot (encrypted) |
| Database dumps | `/srv/company-data/backups/db` | in the same Restic snapshot, so older dumps survive in the repository |

The Restic repository is at `/srv/company-data/backups/restic`, **encrypted**
with the password in `/srv/bayan-jobflow/deploy/restic-password`. Snapshots are
kept for 14 days, 8 weeks and 12 months (`RESTIC_KEEP` in `deploy/.env`).

> **Never** copy `/srv/company-data/postgres` while PostgreSQL is running and
> call it a backup. Only the `pg_dump` files are valid database backups.

### Restic password

Without the Restic password the backups cannot be read by anyone, including
you. `install-backups.sh` prints it once. **Print it, write the date on it and
keep it in the office safe**, separately from the external disk. If the server
is lost, the disk plus that password is everything you need.

## 2. Setting up backups (once)

1. Prepare the external disk (USB disk, ext4 recommended):

   ```bash
   lsblk                                   # find the disk, e.g. /dev/sdb1
   sudo mkfs.ext4 -L jobflow-backup /dev/sdb1     # ERASES the disk
   sudo mkdir -p /media/jobflow-backup
   echo 'LABEL=jobflow-backup /media/jobflow-backup ext4 noauto,nofail 0 2' | sudo tee -a /etc/fstab
   sudo mount /media/jobflow-backup
   sudo touch /media/jobflow-backup/.jobflow-backup-disk    # marker: "this is the backup disk"
   ```

   The marker file stops the weekly copy from ever writing into the empty
   `/media/jobflow-backup` folder on the system disk when the external disk is
   not plugged in.

2. Install Restic, the password, the repository and the timers, and run the
   first backup:

   ```bash
   sudo ./deploy/scripts/install-backups.sh
   ```

3. Check the timers: `systemctl list-timers 'jobflow-*'`.

4. Run the first restore test and the first external copy by hand:

   ```bash
   sudo ./deploy/scripts/restore.sh test
   sudo ./deploy/scripts/backup.sh offsite
   ```

### Weekly external copy

Every Sunday (or before 04:00 on Sunday) plug in the external disk and run
`sudo mount /media/jobflow-backup`. The timer copies the new snapshots, checks
them, and the System page shows *External copy: Succeeded*. Then
`sudo umount /media/jobflow-backup`, unplug the disk and store it away from the
server (another room, or taken home by the manager). Two disks used in
alternate weeks are better than one.

If the disk was not plugged in, the System page shows *External copy failed*
or *older than 8 days*; plug it in and run `sudo ./deploy/scripts/backup.sh offsite`.

## 3. Checking backups

*Administration → System* shows the last database backup, file backup,
external copy and restore test, and warns when any of them failed or is too
old. On the server:

```bash
systemctl list-timers 'jobflow-*'
journalctl -u 'jobflow-backup@*' -u jobflow-restore-test --since -2d
sudo ./deploy/scripts/restore.sh list        # snapshots and local dumps
```

## 4. Restore test (does not touch the live system)

```bash
sudo ./deploy/scripts/restore.sh test            # latest snapshot
sudo ./deploy/scripts/restore.sh test 4f1a2b3c   # a specific snapshot
```

It restores the snapshot to a temporary folder, starts a separate PostgreSQL
with no network, restores the database dump into it, checks that all tables
and users are there, and then checks **every file recorded in the database
exists in the backup with the same SHA-256 checksum**. It ends with a line such
as `snapshot latest: 70 tables, 17 users, 15 jobs, 22 files verified in 6s`,
records the result on the System page and removes everything it created.

It runs automatically every month. Run it by hand before go-live and after any
change to the server's disks.

## 5. Restoring the live system

Only when data was lost or damaged. Everything entered after the chosen backup
is lost, so first decide with management which backup to use.

```bash
sudo ./deploy/scripts/restore.sh list                         # choose a snapshot
sudo ./deploy/scripts/restore.sh production                   # latest snapshot: database + files
sudo ./deploy/scripts/restore.sh production 4f1a2b3c          # a specific snapshot
sudo ./deploy/scripts/restore.sh production --dump /srv/company-data/backups/db/jobflow-20261117-013000.dump   # database only
```

The script asks you to type `RESTORE`, then:

1. turns maintenance mode on;
2. takes a safety backup of the current database (so the restore can itself be undone);
3. stops the web server, API and worker;
4. drops and recreates the database from the dump;
5. replaces `/srv/company-data/files` with the snapshot's files (when restoring a snapshot);
6. starts everything again (any newer migrations are applied automatically) and turns maintenance mode off.

### Server lost completely

1. Install Ubuntu and Docker and clone JobFlow as in `docs/install-ubuntu.md`
   (do not run `install.sh` yet).
2. Mount the external disk at `/media/jobflow-backup`, put the printed Restic
   password into `/srv/bayan-jobflow/deploy/restic-password` (`chmod 600`).
3. Restore the configuration and the HTTPS certificate:

   ```bash
   export RESTIC_REPOSITORY=/media/jobflow-backup/restic RESTIC_PASSWORD_FILE=/srv/bayan-jobflow/deploy/restic-password
   restic snapshots
   restic restore latest --target / --include /srv/bayan-jobflow/deploy/.env --include /srv/company-data/caddy/data
   ```

4. Run `./deploy/scripts/install.sh` (it keeps the restored `.env`), then
   `sudo RESTIC_REPOSITORY=/media/jobflow-backup/restic ./deploy/scripts/restore.sh production`.
5. Run `sudo ./deploy/scripts/install-backups.sh` to set up the timers again.

Because the HTTPS root certificate was restored, the office PCs need nothing new.

## 6. Maintenance mode

While maintenance mode is on, only administrators can use JobFlow. Everyone
else sees *JobFlow is under maintenance* with your message, and the page comes
back by itself when you turn it off. Nothing users already saved is affected.

- In the browser: *Administration → System → Maintenance mode*.
- On the server:

  ```bash
  cd /srv/bayan-jobflow/deploy
  docker compose exec api node dist/cli/maintenance.js on "Server update until 18:00"
  docker compose exec api node dist/cli/maintenance.js off
  docker compose exec api node dist/cli/maintenance.js status
  ```

`update.sh`, `rollback.sh` and `restore.sh production` turn it on and off
themselves. Turning it on or off is recorded in the audit log.

## 7. Updating

The server has no internet, so updates come as an offline bundle made on a PC
with internet (`docs/install-offline.md` §1):

```bash
sudo ./deploy/scripts/update.sh /mnt/jobflow-offline-v1.2.0.tar
```

(With internet on the server, `update.sh v1.2.0` or plain `update.sh` fetch
and build from GitHub instead.)

The script checks the bundle's checksums, turns maintenance mode on, takes a
database backup kept in `/srv/company-data/backups/pre-update/` (the last three
are kept, outside the 14-day cleanup), keeps the running images as `:previous`,
loads the new images and code, starts them (database migrations run first, on
their own), waits until they are healthy and turns maintenance mode off. Read
the CHANGELOG first and update outside working hours.

- If anything fails **before** the new version starts (damaged bundle, backup
  error), the running version is left untouched and maintenance mode is turned
  off again.
- If the new version **does not start**, the script prints the logs and
  maintenance mode stays on. Roll back (§8).
- `update.sh` refuses to run again while the last update is unfinished, so a
  broken version can never become the "previous" one.

## 8. Rolling back

```bash
sudo ./deploy/scripts/rollback.sh
```

Returns to the version that ran before the last `update.sh`, also when that
update failed to start: the code and the `:previous` images are already on the
server, so no internet is needed. Migrations only move forward, so **if the
update changed the database**, the rollback also restores the database backup
taken just before the update, and the script says so before you confirm.
Anything entered between the update and the rollback is then lost; roll back
quickly, or ask for a fix instead if users have already entered a lot of work.

Before it changes anything, the script checks that the previous images and
(when needed) the pre-update backup exist, and stops if not.

## 9. Reboots and power cuts

All services restart on their own (`restart: unless-stopped`, Docker enabled
at boot). PostgreSQL recovers from its write-ahead log after a power cut. To
confirm nothing was lost:

```bash
sudo ./deploy/scripts/verify.sh snapshot    # before a planned reboot
sudo reboot
sudo ./deploy/scripts/verify.sh compare     # after: services, HTTPS, row counts, upload checksums, certificate
```

After an unplanned power cut, `verify.sh` (no argument) checks the services;
then look at *Administration → System*.

A small UPS that lets the server shut down cleanly is strongly recommended.

## 10. Monitoring

*Administration → System* (needs the *outbox.manage* permission) shows:

- database, background worker (heartbeat every minute) and API uptime;
- free space on the data disk, with a red warning above 85% used;
- background events waiting, retrying and failed permanently, with **Retry**
  for each failed event (safe: every consumer ignores duplicates);
- the four backup jobs and any warning (failed, missing or too old);
- maintenance mode.

Logs: `docker compose logs --since 1h api worker` (JSON lines, one per request,
with a `requestId` that also appears in error messages users see).

## 11. Disk space

Uploads grow over time. When the System page warns about disk space:

- check what grows: `sudo du -sh /srv/company-data/*`;
- old database dumps are already pruned after 14 days, and Restic prunes
  snapshots by the retention rules;
- `docker image prune` removes old JobFlow images (keep `:previous` until the
  next update has proven itself);
- add a disk and move `/srv/company-data` to it (stop the stack, copy with
  `rsync -aHAX`, update `DATA_ROOT` in `deploy/.env`, start).

## 12. Version pins

Pinned versions (Node.js 26 LTS, PostgreSQL 17.12, Redis 8.2.11, Caddy 2.11.9,
npm packages in `package-lock.json`) are listed in `docs/development.md`. Check
for security releases every quarter, update the pins in a branch, run the test
suite, then deploy with `update.sh`.

## 13. More users: scaling

One server comfortably handles an office of 50 users (`docs/acceptance.md`,
load check). If it ever gets slow at busy times:

1. Check *Administration → System* and `docker stats` for the bottleneck.
2. Run more API containers (the web server spreads the load over them on its
   own; live updates keep working through Redis):

   ```bash
   cd /srv/bayan-jobflow/deploy
   docker compose up -d --scale api=3
   ```

   Each API container keeps up to `DB_POOL_MAX` (default 20) database
   connections; keep `api containers × DB_POOL_MAX + 15` under 100, or lower
   `DB_POOL_MAX` in `deploy/.env`.
3. More memory and faster disks for PostgreSQL help most with large reports.

To make the number permanent, add `deploy: { replicas: 3 }` under `api:` in a
`docker-compose.override.yml` next to `docker-compose.yml`.
