# Installing Bayan JobFlow on Ubuntu Server 24.04 (office LAN)

This guide installs JobFlow on one server in the office. Staff open it at
`https://<server IP>` from office PCs and tablets. Nothing is exposed to the
internet, and the system keeps working when the internet connection is down.

Internet is needed only during installation and updates (to download Docker,
base images and packages).

## 1. Prepare the server

1. Install Ubuntu Server 24.04 LTS. Create an admin user (not root).
2. **Give the server a fixed LAN IP**, either in netplan or as a DHCP
   reservation on the router. Example used below: `192.168.1.50`.
   Bookmarks and the HTTPS certificate are tied to this address, so it must
   not change.
3. Update the system and set the time zone:

   ```bash
   sudo apt update && sudo apt -y upgrade
   sudo timedatectl set-timezone Asia/Dubai
   ```

4. Install Docker Engine and the Compose plugin from Docker's repository
   (follow https://docs.docker.com/engine/install/ubuntu/), then let your user
   run Docker:

   ```bash
   sudo usermod -aG docker "$USER"   # log out and back in afterwards
   docker compose version            # must print v2.x or newer
   ```

## 2. Get the application

```bash
sudo mkdir -p /srv/bayan-jobflow && sudo chown "$USER" /srv/bayan-jobflow
git clone https://github.com/printajo-dev/bayan-jobflow.git /srv/bayan-jobflow
cd /srv/bayan-jobflow
```

## 3. Configure and start

```bash
./deploy/scripts/install.sh      # first run creates deploy/.env with random passwords
nano deploy/.env                 # set JOBFLOW_HOST and BIND_IP to the server IP
./deploy/scripts/install.sh      # second run creates /srv/company-data/*, builds and starts
```

`deploy/.env` holds the database and Redis passwords. It is created with
permissions `600`; keep it that way and never commit it.

Business data lives under `/srv/company-data/` (separate from the code):

| Folder | Contents |
|---|---|
| `postgres/` | PostgreSQL data (do not copy while running; use the backup script) |
| `redis/` | Redis queue data |
| `caddy/data/` | Caddy's HTTPS root certificate and key — **back this up** |
| `files/` | Uploaded files (from Phase 3) |
| `backups/` | Database dumps and the encrypted Restic repository (`docs/maintenance.md`) |
| `backup-status/` | Last backup results, shown on *Administration → System* (no secrets) |
| `imports/`, `exports/` | Controlled import/export |

Check the services:

```bash
cd /srv/bayan-jobflow/deploy
docker compose ps        # api healthy, migrate "Exited (0)", others Up
docker compose logs -f api
```

## 4. Create the first administrator

```bash
./deploy/scripts/create-admin.sh
```

It asks for a username, full name and password (at least 12 characters; not
shown while typing). Sign in with it, then create departments, roles and users
from the Administration menu (see `docs/admin-guide.md`).

## 5. Install the HTTPS certificate on each office PC

Browsers only allow microphone access (voice notes) on HTTPS, so JobFlow always
uses HTTPS, with a certificate from Caddy's own internal certificate authority.
Each PC must trust that authority once.

Export the root certificate on the server:

```bash
./deploy/scripts/export-ca.sh    # writes bayan-jobflow-root-ca.crt and prints its fingerprint
```

Copy `bayan-jobflow-root-ca.crt` to each PC (USB stick or shared folder) and
compare the SHA-256 fingerprint with the one printed on the server.

**Windows 10/11** (as administrator, in Command Prompt):

```bat
certutil -addstore -f Root bayan-jobflow-root-ca.crt
```

or double-click the file → *Install Certificate* → *Local Machine* → *Place all
certificates in the following store* → *Trusted Root Certification
Authorities*. Chrome and Edge use this store; Firefox does too when
`security.enterprise_roots.enabled` is on (the default on Windows).

**macOS**: double-click the file to add it to the *System* keychain, open it in
Keychain Access, expand *Trust* and choose *Always Trust*.

**iPad**: AirDrop or email the file, install the profile in *Settings*, then
enable it under *Settings → General → About → Certificate Trust Settings*.

**Android tablets**: *Settings → Security → Encryption & credentials → Install
a certificate → CA certificate*.

Then open `https://192.168.1.50` — there must be no certificate warning.

The root certificate is valid for 10 years and survives restarts and updates as
long as `/srv/company-data/caddy/data` is kept. If that folder is lost, every PC
needs the new certificate.

## 6. Firewall

Only ports 443 and 80 (redirects to HTTPS) should be reachable, and only from
the office LAN. PostgreSQL and Redis publish no ports at all.

Docker publishes ports by writing its own iptables rules, which **bypass UFW's
normal rules**. JobFlow limits this in two ways:

1. Caddy binds only to `BIND_IP` (the LAN address), not to every interface.
2. Add a `DOCKER-USER` rule so only the LAN subnet reaches published ports.
   Replace `192.168.1.0/24` with your subnet:

   ```bash
   sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp   # SSH from LAN only
   sudo ufw default deny incoming
   sudo ufw enable
   # Docker-published ports: allow the LAN, drop everything else.
   # (The first rule keeps replies to the server's own outgoing connections,
   # needed for updates and image builds.)
   IFACE="$(ip route show default | awk '{print $5}')"
   sudo iptables -I DOCKER-USER -i "$IFACE" ! -s 192.168.1.0/24 -j DROP
   sudo iptables -I DOCKER-USER -i "$IFACE" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
   sudo apt install -y iptables-persistent && sudo netfilter-persistent save
   ```

Verify **from another PC on the LAN**:

```bash
nmap -p 22,80,443,3000,5432,6379 192.168.1.50
```

Expected: 22, 80 and 443 open; 3000, 5432 and 6379 closed or filtered. Do not
set up port forwarding on the router.

## 7. Backups

Set up backups before anyone uses the system:

```bash
sudo ./deploy/scripts/install-backups.sh
```

It installs Restic, creates the encrypted backup repository and the daily,
nightly, weekly and monthly timers, and prints the backup password — print it
and keep it in the office safe. Prepare the external backup disk first; see
`docs/maintenance.md` §2. Then run the acceptance checks in `docs/acceptance.md`
(*On the target server*).

## 8. Updates

```bash
sudo ./deploy/scripts/update.sh
```

It turns maintenance mode on, backs up the database, builds and starts the new
version and turns maintenance mode off; `deploy/scripts/rollback.sh` returns to
the previous version. Details: `docs/maintenance.md` §7–8.

## Optional: an internal DNS name

If you later add a DNS name (for example `jobflow.bayan.lan`) on the router,
add a second site block to `deploy/Caddyfile` with the same contents as the
`{$JOBFLOW_HOST}` block, rebuild the `caddy` image and restart it. Caddy will
issue a certificate for the name from the same root, so PCs need nothing new.

## Troubleshooting

| Symptom | Check |
|---|---|
| Browser warns about the certificate | The root certificate is not installed on that PC, or you opened a different address than `JOBFLOW_HOST`. |
| Site does not load from other PCs | `docker compose ps`; firewall rules; `BIND_IP` matches the server's LAN IP. |
| `migrate` exited with an error | `docker compose logs migrate` — usually the database password in `.env` changed after the first start. |
| Microphone does not work | The page must be opened over `https://` with a trusted certificate. |
