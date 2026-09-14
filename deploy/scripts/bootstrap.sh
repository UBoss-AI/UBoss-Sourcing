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
# printed list of the four things still to do.
#
# Idempotent: safe to run again after fixing something.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
SERVICE_USER=uboss

# Node 20 is the floor (`engines` in backend/package.json says >=20.11). 22 is
# the current LTS and what this is tested against.
NODE_MAJOR=22

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
  mariadb-server \
  certbot python3-certbot-nginx \
  ufw fail2ban \
  gzip tar gpg coreutils

if ! command -v node >/dev/null || [[ "$(node -v | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
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

log "installing systemd units"
cp "$HERE/systemd/"*.service "$HERE/systemd/"*.timer /etc/systemd/system/
systemctl daemon-reload

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

Four things left, and none of them can be guessed:

  1. Create the database and TWO users. Two, not one - RUNBOOK.md section 7
     explains why, and the short version is that the application must not be
     able to rewrite its own audit trail or alter its own schema:

       sudo mysql_secure_installation
       sudo mariadb <<'SQL'
         CREATE DATABASE uboss CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

         -- What the API and worker run as. No DDL.
         CREATE USER 'uboss_app'@'localhost' IDENTIFIED BY '<long random>';
         GRANT SELECT, INSERT, UPDATE, DELETE ON uboss.* TO 'uboss_app'@'localhost';
         -- Append-only. A compromised application cannot erase what it did.
         REVOKE UPDATE, DELETE ON uboss.audit_logs FROM 'uboss_app'@'localhost';

         -- What 'prisma migrate deploy' runs as, during a release only.
         CREATE USER 'uboss_migrate'@'localhost' IDENTIFIED BY '<different long random>';
         GRANT ALL PRIVILEGES ON uboss.* TO 'uboss_migrate'@'localhost';

         FLUSH PRIVILEGES;
       SQL

     Then in shared/.env:
       DATABASE_URL=...uboss_app...          <- the application reads this
       MIGRATE_DATABASE_URL=...uboss_migrate...  <- release.sh reads this

  2. Write $ROOT/shared/.env
       Start from backend/.env.example. docs/DEPLOYMENT.md lists every value
       that MUST change for production - the secrets, the origins, and
       COOKIE_SECURE/COOKIE_DOMAIN, which sign everybody out if they are wrong.
       chown $SERVICE_USER:$SERVICE_USER $ROOT/shared/.env && chmod 600 it.

  3. Point your DNS at this machine, then:
       sudo certbot --nginx -d shop.example.com -d admin.example.com

  4. Deploy:
       sudo -u $SERVICE_USER $ROOT/repo/deploy/scripts/release.sh
       sudo systemctl enable --now uboss-api@4000 uboss-api@4001 uboss-api@4002
       sudo systemctl enable --now uboss-worker uboss-backup.timer

DONE
