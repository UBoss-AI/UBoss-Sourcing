#!/usr/bin/env bash
# =============================================================================
# First-time server setup. Run once, as root, on a fresh Ubuntu 24.04 box.
#
#   sudo bash bootstrap.sh
#
# Creates the service user and the directory layout, installs the packages,
# and puts the nginx, systemd and MariaDB files where they belong. It does NOT
# fill in `.env`, issue certificates or start anything - those need decisions
# and secrets that belong to the operator, and a script that guessed at them
# would produce a site that starts and is wrong.
#
# What it leaves you with is a machine where `release.sh` will work, and a
# printed list of the five things still to do.
#
# Idempotent: safe to run again after fixing something.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
SERVICE_USER=uboss

# Node 24 is Active LTS and is what `.nvmrc` and every `engines` field in this
# repository name. Keeping the server, CI and the development machines on one
# major is the point: three majors in play is how a build passes everywhere
# except the box that matters.
NODE_MAJOR=24

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

trap 'die "failed at line $LINENO"' ERR

[[ $EUID -eq 0 ]] || die "run this as root"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# -----------------------------------------------------------------------------
# Packages
# -----------------------------------------------------------------------------
log "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  curl ca-certificates gnupg git \
  nginx \
  certbot python3-certbot-nginx \
  ufw fail2ban \
  unattended-upgrades apt-listchanges \
  gzip tar gpg coreutils \
  clamav clamav-daemon \
  rclone

# -----------------------------------------------------------------------------
# MariaDB 11.4 LTS, from MariaDB's own repository
#
# NOT `apt-get install mariadb-server`. Ubuntu 24.04 packages 10.11, which is
# supported to February 2028; 11.4 is supported to May 2029. Fifteen months of
# security fixes for one extra apt source is a trade worth making once, at
# install time, rather than a major version upgrade under load in 2027.
#
# Note the counter-intuitive part before "upgrading" this: MariaDB shortened
# its LTS window from five years to three AFTER 11.4, so 11.8 - released a year
# later - runs out in June 2028, EARLIER than 11.4. Newer is not longer.
# docs/DATABASE-PRODUCTION.md section 3 has the full comparison.
#
# The series is pinned, the patch is not: `mariadb-11.4` tracks patch releases
# within the series, which is what unattended-upgrades should be applying. A
# MAJOR upgrade is a project - rehearse it in deploy/compat first.
# -----------------------------------------------------------------------------
MARIADB_SERIES=11.4

if ! command -v mariadbd >/dev/null 2>&1; then
  log "installing MariaDB $MARIADB_SERIES from mariadb.org"

  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://mariadb.org/mariadb_release_signing_key.pgp \
    -o /etc/apt/keyrings/mariadb-keyring.pgp

  # `signed-by` ties the key to this one repository. Without it the key would
  # be trusted for every apt source on the machine.
  cat >/etc/apt/sources.list.d/mariadb.sources <<REPO
X-Repolib-Name: MariaDB
Types: deb
URIs: https://mirror.mariadb.org/repo/$MARIADB_SERIES/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: main main/debug
Signed-By: /etc/apt/keyrings/mariadb-keyring.pgp
REPO

  apt-get update -qq
  apt-get install -y -qq mariadb-server mariadb-client mariadb-backup
else
  log "MariaDB already installed: $(mariadbd --version)"
fi

# The timezone tables, loaded by hand because the Debian packaging does not do
# it. Without them `CONVERT_TZ(..., 'Europe/Warsaw')` returns NULL - silently.
#
# The application does not depend on this: recurrence arithmetic is done in
# Node with Intl, and every stored instant is UTC. But anybody debugging a
# schedule at a SQL prompt gets nulls and concludes the data is wrong, and the
# hour it costs to work that out is worth the thirty seconds this takes.
if [[ "$(mariadb -N -B -e 'SELECT COUNT(*) FROM mysql.time_zone_name;' 2>/dev/null || echo 0)" -eq 0 ]]; then
  log "loading the timezone tables"
  mariadb-tzinfo-to-sql /usr/share/zoneinfo 2>/dev/null | mariadb mysql
fi

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt "$NODE_MAJOR" ]]; then
  log "installing Node $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
fi

log "node $(node -v), npm $(npm -v)"

# -----------------------------------------------------------------------------
# The service user
#
# `--system` and `--shell /usr/sbin/nologin`: this account exists to own files
# and run two units. Nobody logs in as it, so it should not be able to.
# -----------------------------------------------------------------------------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating the $SERVICE_USER user"
  useradd --system --home-dir "$ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# clamd exposes a local Unix socket owned by the clamav group. The application
# receives only access to that socket; the scanner itself remains a separate,
# unprivileged service and malicious bytes are scanned before application
# storage is touched.
usermod -aG clamav "$SERVICE_USER"
systemctl enable --now clamav-freshclam.service clamav-daemon.service

# -----------------------------------------------------------------------------
# The layout
#
#   /srv/uboss/repo       the git checkout that release.sh builds from
#   /srv/uboss/releases   one frozen directory per release
#   /srv/uboss/current -> the release currently being served
#   /srv/uboss/shared    .env, which survives every release
#   /srv/uboss/media     uploaded product images - NEVER inside a release
#   /srv/uboss/backups   nightly dumps
#
# `media` and `shared` sit outside the release directories deliberately: they
# are the two things a deploy must not touch and a rollback must not revert.
# -----------------------------------------------------------------------------
log "creating the directory layout"
mkdir -p "$ROOT"/{repo,releases,shared,media/products,backups}
chown -R "$SERVICE_USER:$SERVICE_USER" "$ROOT"

# `.env` holds every secret this system has. Nothing but the service user reads it.
chmod 750 "$ROOT"
chmod 700 "$ROOT/shared" "$ROOT/backups"

if [[ ! -d "$ROOT/repo/.git" ]]; then
  warn "no checkout at $ROOT/repo yet - clone it as the $SERVICE_USER user:"
  warn "  sudo -u $SERVICE_USER git clone <url> $ROOT/repo"
fi

# -----------------------------------------------------------------------------
# Configuration files
# -----------------------------------------------------------------------------
log "installing nginx configuration"
mkdir -p /etc/nginx/snippets /var/www/certbot
cp "$HERE/nginx/snippets/"*.conf /etc/nginx/snippets/
if [[ -f /etc/nginx/sites-available/uboss.conf ]]; then
  warn "/etc/nginx/sites-available/uboss.conf already exists - leaving it alone"
else
  cp "$HERE/nginx/uboss.conf" /etc/nginx/sites-available/uboss.conf
  ln -sfn /etc/nginx/sites-available/uboss.conf /etc/nginx/sites-enabled/uboss.conf
  rm -f /etc/nginx/sites-enabled/default
  warn "edit /etc/nginx/sites-available/uboss.conf and replace example.com"
fi

# -----------------------------------------------------------------------------
# The backup's own secrets
#
# Root-owned and 0600, read by systemd (which is root) before it drops to the
# uboss user. Created empty rather than left absent on purpose: a missing
# EnvironmentFile makes the unit fail with a systemd error about a file, where
# an empty one lets backup.sh run and print the message that actually says what
# is wrong and why.
# -----------------------------------------------------------------------------
log "creating the backup secrets file"
install -d -m 700 -o root -g root /etc/uboss
if [[ ! -f /etc/uboss/backup.env ]]; then
  cat > /etc/uboss/backup.env <<'BACKUPENV'
# Read by uboss-backup.service. Root-owned, 0600 - keep it that way.
#
# UBOSS_BACKUP_PASSPHRASE encrypts the database dump, the media archive and the
# environment file. STORE IT SOMEWHERE THAT SURVIVES LOSING THIS MACHINE; it is
# deliberately not in the backups, and without it they are noise.
#
#   openssl rand -base64 36
#
# UBOSS_OFFSITE_REMOTE is an rclone destination on a DIFFERENT provider or
# account from this server. Configure it with `rclone config` as root first.
#
# UBOSS_BINLOG_URL points at a MariaDB user holding REPLICATION SLAVE,
# REPLICATION CLIENT and RELOAD - and no SELECT on anything. It lets
# uboss-binlog.timer ship the binary logs off the machine every fifteen minutes,
# which is the difference between losing a quarter of an hour of orders and
# losing everything since last night's dump. Leave it unset and that timer
# refuses to run rather than pretending to protect you.
#
# UBOSS_BACKUP_PASSPHRASE=
# UBOSS_OFFSITE_REMOTE=
# UBOSS_BINLOG_URL=
BACKUPENV
  chmod 600 /etc/uboss/backup.env
fi

# Where alerts go. Separate from the backup's secrets because it is read by a
# different unit and holds a different kind of secret - a chat webhook URL is a
# credential, and anyone holding it can post as this system.
if [[ ! -f /etc/uboss/monitor.env ]]; then
  cat > /etc/uboss/monitor.env <<'MONITORENV'
# Read by uboss-monitor.service. Root-owned, 0600 - keep it that way.
#
# UBOSS_ALERT_COMMAND is anything executable, called with a single argument: the
# message. A one-line script that curls a chat webhook is enough. Without it the
# checks still run and a failure still shows in `systemctl --failed`, but
# nothing goes looking for a person.
#
# Thresholds can be overridden here too; deploy/scripts/monitor.sh names them
# all at the top.
#
# UBOSS_ALERT_COMMAND=
MONITORENV
  chmod 600 /etc/uboss/monitor.env
fi

log "installing systemd units"
cp "$HERE/systemd/"*.service "$HERE/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload

# -----------------------------------------------------------------------------
# Letting release.sh restart the units - and nothing else
#
# release.sh and rollback.sh run as the `uboss` service user, which is a
# --system account with no shell. Without this rule a release builds perfectly,
# migrates, moves the `current` symlink and THEN fails at `systemctl restart` -
# the worst possible place to stop, because the new code is linked and none of
# it is running.
#
# Each unit is named. `systemctl *` would let a compromised application stop,
# mask or start anything on the machine, which is an enormous privilege to hand
# over in exchange for three restarts. `nginx reload` is included because a
# certificate renewal hook needs it.
#
# `visudo -c` before the file is trusted: a syntax error in /etc/sudoers.d
# breaks sudo for EVERY user, including the one you would use to fix it.
# -----------------------------------------------------------------------------
log "installing the release sudoers rule"
cat > /etc/sudoers.d/uboss-release.tmp <<SUDOERS
# Installed by deploy/scripts/bootstrap.sh. Do not add a wildcard here.
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart uboss-api@4000, \\
  /usr/bin/systemctl restart uboss-api@4001, \\
  /usr/bin/systemctl restart uboss-api@4002, \\
  /usr/bin/systemctl restart uboss-worker, \\
  /usr/bin/systemctl reload nginx
SUDOERS
chmod 440 /etc/sudoers.d/uboss-release.tmp
if visudo -cf /etc/sudoers.d/uboss-release.tmp >/dev/null; then
  mv /etc/sudoers.d/uboss-release.tmp /etc/sudoers.d/uboss-release
else
  rm -f /etc/sudoers.d/uboss-release.tmp
  die "the generated sudoers rule did not parse - refusing to install it"
fi

# -----------------------------------------------------------------------------
# Automatic security updates
#
# An unpatched box is the most likely way this deployment is compromised, and
# "somebody will run apt upgrade" is not a plan. Security updates only - the
# whole point is that this file changes nothing anyone has to think about.
#
# No automatic reboot. A machine that reboots itself at 02:00 takes the site
# with it, and there is only one of it; the flag file it writes instead is what
# `deploy/scripts/monitor.sh` reports, so a kernel update is a decision somebody
# makes in the morning rather than an outage nobody scheduled.
# -----------------------------------------------------------------------------
log "enabling unattended security updates"
cat > /etc/apt/apt.conf.d/51-uboss-unattended <<'UNATTENDED'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-New-Unused-Dependencies "true";
// Deliberately false. See bootstrap.sh - one box, no automatic outage.
Unattended-Upgrade::Automatic-Reboot "false";
UNATTENDED

cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTOUPGRADES'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUPGRADES

systemctl enable --now unattended-upgrades >/dev/null 2>&1 || \
  warn "could not enable unattended-upgrades - check 'systemctl status unattended-upgrades'"

# -----------------------------------------------------------------------------
# fail2ban policy
#
# The package was installed above; on its own it bans nobody. Three jails:
#
#   sshd             the constant background of credential stuffing. `backend =
#                    systemd` because Ubuntu 24.04 logs sshd to the journal and
#                    there may be no /var/log/auth.log to read.
#   nginx-http-auth  basic-auth brute force, if any location ever uses it.
#   nginx-limit-req  the one that matters here. nginx's own rate limiter writes
#                    a line to error.log every time it delays or rejects a
#                    request; twenty of those in a minute is a client that has
#                    been told to slow down and has not, so it stops being
#                    nginx's problem and starts being the firewall's.
#
# The nginx jails read a file rather than the journal, so they must NOT inherit
# `backend = systemd` - a systemd backend with no journalmatch makes fail2ban
# skip the jail at start-up, and it says so in a log nobody reads.
# -----------------------------------------------------------------------------
log "configuring fail2ban jails"
cat > /etc/fail2ban/jail.local <<'JAIL'
# Installed by deploy/scripts/bootstrap.sh.
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5

[sshd]
enabled = true
backend = systemd

[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled  = true
filter   = nginx-limit-req
logpath  = /var/log/nginx/error.log
maxretry = 20
findtime = 1m
bantime  = 10m
JAIL

systemctl enable fail2ban >/dev/null 2>&1 || true
systemctl restart fail2ban || warn "fail2ban did not restart - check 'fail2ban-client status'"

# -----------------------------------------------------------------------------
# Journal size and retention
#
# Without a cap the journal grows until the disk is full, and a full disk on
# this machine stops MariaDB rather than just the logging. The retention window
# is also a privacy decision: these logs hold IP addresses and user agents, so
# 30 days is a starting point the operator should confirm against their own
# record of processing (docs/DEPLOYMENT.md section 8).
# -----------------------------------------------------------------------------
log "capping the journal"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/99-uboss.conf <<'JOURNALD'
[Journal]
SystemMaxUse=2G
SystemKeepFree=5G
MaxRetentionSec=30day
Compress=yes
JOURNALD
systemctl restart systemd-journald

log "installing MariaDB tuning"
cp "$HERE/mariadb/uboss.cnf" /etc/mysql/mariadb.conf.d/99-uboss.cnf

# -----------------------------------------------------------------------------
# Firewall
#
# Note what is NOT opened: 3306 and 4000-4002. MariaDB and the API instances
# listen on loopback and must stay there - nginx is the only way in. An API
# reachable from the internet bypasses every rate limit and TLS termination in
# the nginx config.
# -----------------------------------------------------------------------------
log "configuring the firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
ufw --force enable

# -----------------------------------------------------------------------------
# Swap
#
# 2 GB on a 16 GB box, and `swappiness=10`. Not so the machine can run in swap -
# it cannot, and a database in swap is a database that has stopped - but so that
# a brief spike is a slow minute rather than the OOM killer choosing a victim.
# The victim it chooses is usually MariaDB, because it is the largest process.
# -----------------------------------------------------------------------------
if ! swapon --show | grep -q .; then
  log "creating 2G of swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

# -----------------------------------------------------------------------------
# Kernel networking
#
# The default backlog is 128 connections. nginx accepts far faster than that
# under any real burst, and the connections beyond it are dropped - which the
# visitor experiences as a page that never loads rather than as an error.
# -----------------------------------------------------------------------------
log "raising connection limits"
cat > /etc/sysctl.d/99-uboss.conf <<'SYSCTL'
net.core.somaxconn = 4096
net.ipv4.tcp_max_syn_backlog = 4096
net.ipv4.ip_local_port_range = 10240 65535
net.ipv4.tcp_fin_timeout = 20
fs.file-max = 200000
SYSCTL
sysctl -q -p /etc/sysctl.d/99-uboss.conf

systemctl restart mariadb

cat <<DONE

$(printf '\033[1;32m✓\033[0m') bootstrap complete.

Five things left, and none of them can be guessed:

  1. Create the database and FOUR users. Four, not one - the application must
     not be able to rewrite its own audit trail or alter its own schema, and
     the backup and the binary-log shipper have no business reading either.
     docs/DATABASE-PRODUCTION.md section 6 has the full reasoning.

       sudo mariadb-secure-installation
       sudo mariadb <<'SQL'
         CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

         -- What the API and worker run as. No DDL, ever.
         --
         -- SELECT and INSERT only, at this point. UPDATE and DELETE are added
         -- per table by apply-grants.sh in step 1b, AFTER the tables exist,
         -- and deliberately not on audit_logs.
         CREATE USER 'uboss_app'@'localhost' IDENTIFIED BY '<long random>';
         GRANT SELECT, INSERT ON uboss.* TO 'uboss_app'@'localhost';

         -- What 'prisma migrate deploy' runs as, during a release only.
         CREATE USER 'uboss_migrate'@'localhost' IDENTIFIED BY '<different long random>';
         GRANT ALL PRIVILEGES ON uboss.* TO 'uboss_migrate'@'localhost';

         -- What the nightly dump runs as. Reads rows; cannot change one.
         CREATE USER 'uboss_backup'@'localhost' IDENTIFIED BY '<a third long random>';
         GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER ON uboss.* TO 'uboss_backup'@'localhost';

         -- Reads the binary logs so they can be shipped off the machine. This
         -- is what makes point-in-time recovery possible; without it the most
         -- you can lose is a whole day of orders. No SELECT on any table - it
         -- reads the log of changes, never the data.
         CREATE USER 'uboss_binlog'@'localhost' IDENTIFIED BY '<a fourth long random>';
         GRANT REPLICATION SLAVE, BINLOG MONITOR, RELOAD ON *.* TO 'uboss_binlog'@'localhost';

         FLUSH PRIVILEGES;
       SQL

     Then in shared/.env:
       DATABASE_URL=...uboss_app...              <- the application reads this
       MIGRATE_DATABASE_URL=...uboss_migrate...  <- release.sh reads this
       UBOSS_BACKUP_DATABASE_URL=...uboss_backup...  <- backup.sh reads this

  1b. Migrate, THEN tighten. This order is not a preference:

       cd $ROOT/current/backend
       DATABASE_URL="\$MIGRATE_DATABASE_URL" npx prisma migrate deploy
       sudo bash $ROOT/current/deploy/scripts/apply-grants.sh

      apply-grants.sh is what makes audit_logs append-only. It cannot run
      before the migration, because MariaDB refuses a table-level REVOKE
      against a table that does not exist - and it could not be expressed as a
      REVOKE at all, because a privilege granted at DATABASE level cannot be
      taken back at TABLE level:

        ERROR 1147 (42000): There is no such grant defined for user 'uboss_app'
                            on host 'localhost' on table 'audit_logs'

      That is why step 1 grants only SELECT and INSERT on the database, and
      apply-grants.sh grants UPDATE and DELETE on each table individually. It
      prints which tables it protected; two, audit_logs and _prisma_migrations,
      is what success looks like.

      release.sh runs it after every migration, so this is the only time it has
      to be done by hand.

  2. Write $ROOT/shared/.env
       Start from backend/.env.example. docs/DEPLOYMENT.md lists every value
       that MUST change for production - the secrets, the origins, and
       COOKIE_SECURE/COOKIE_DOMAIN, which sign everybody out if they are wrong.
       chown $SERVICE_USER:$SERVICE_USER $ROOT/shared/.env && chmod 600 it.

  3. Point your DNS at this machine, then issue certificates. Include the
     carrier portal host only if FEATURE_LOGISTICS_PORTAL is on:

       sudo certbot --nginx -d shop.example.com -d admin.example.com \\
                            -d carriers.example.com

  4. Fill in /etc/uboss/backup.env - all three values:

       UBOSS_BACKUP_PASSPHRASE   encrypts the dump, the media archive, the
                                 binary logs and .env. Store it somewhere that
                                 survives losing this machine. It is not in the
                                 backups, and without it they are noise.
       UBOSS_OFFSITE_REMOTE      an rclone destination on a DIFFERENT provider
                                 or account. Run 'sudo rclone config' first.
       UBOSS_BINLOG_URL          mysql://uboss_binlog:<pass>@127.0.0.1:3306/
                                 The third user from step 1. Leave it out and
                                 the most this system can lose is everything
                                 since 02:30 this morning; set it and that
                                 becomes fifteen minutes.

     Without the first two the nightly backup refuses to write an unencrypted
     dump, and reports failure rather than quietly keeping the only copy of your
     data on the same disk as the database.

     Somewhere for alerts to go is worth a fourth line, in
     /etc/uboss/monitor.env:

       UBOSS_ALERT_COMMAND       anything executable, called with one argument.
                                 A curl to a chat webhook is enough. Without it
                                 the checks still run and still fail the unit -
                                 but somebody has to be looking.

  5. Deploy:
       sudo -u $SERVICE_USER $ROOT/repo/deploy/scripts/release.sh
       sudo systemctl enable --now uboss-api@4000 uboss-api@4001 uboss-api@4002
       sudo systemctl enable --now uboss-worker uboss-backup.timer
       sudo systemctl enable --now uboss-monitor.timer uboss-binlog.timer

     And then the thing this machine cannot do for itself: point an EXTERNAL
     uptime check at https://<your shop>/health/live, from outside this network.
     uboss-monitor.timer watches the queue, the worker and the backups from the
     inside; it goes quiet exactly when the machine does.

DONE
