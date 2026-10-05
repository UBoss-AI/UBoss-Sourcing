#!/usr/bin/env bash
# =============================================================================
# One-time server setup for automatic deploys from GitHub. Run as root.
#
#   sudo bash /srv/uboss/repo/deploy-vps/setup-deploy-user.sh
#   sudo bash /srv/uboss/repo/deploy-vps/setup-deploy-user.sh "ssh-ed25519 AAAA... uboss-deploy"
#
# With a public key as the argument it also writes the restricted
# authorized_keys line. Without one it prints the line for you to fill in.
#
# What it sets up, and nothing else:
#
#   deploy user          a separate login for GitHub Actions. Not root, not the
#                        `uboss` service user, password locked. Its key can run
#                        exactly one program (the forced command).
#   /srv/uboss/incoming  where uploads land. deploy:uboss, mode 2750 - deploy
#                        writes, uboss reads, nobody else sees in.
#   /srv/uboss/bin/deploy-activate
#                        the forced command (deploy-vps/deploy-activate.sh).
#   /usr/local/lib/uboss/
#                        root-owned copies of deploy/scripts/apply-grants.sh and
#                        deploy/mariadb/post-migrate-grants.sql, plus a wrapper.
#                        Root runs these through sudo, so they must live where
#                        `uboss` cannot write - /srv/uboss is uboss's own.
#   /etc/sudoers.d/uboss-deploy-vps
#                        the exact commands each user may run as another,
#                        checked with `visudo -cf` before it is installed.
#
# It does not modify anything in deploy/, and reads the existing scripts only
# to copy them. Safe to run again: every step checks before it acts, and a
# re-run refreshes the installed copies from the checkout.
# =============================================================================
set -Eeuo pipefail

ROOT=/srv/uboss
SERVICE_USER=uboss
DEPLOY_USER=deploy
LIB=/usr/local/lib/uboss
SUDOERS=/etc/sudoers.d/uboss-deploy-vps
CONF=/etc/uboss/deploy-vps.conf

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO"' ERR

[[ $EUID -eq 0 ]] || die "run this as root (sudo bash $0)"
id "$SERVICE_USER" >/dev/null 2>&1 || die "the $SERVICE_USER user does not exist yet - do the first install first"
[[ -d "$ROOT" ]] || die "$ROOT does not exist - do the first install first"
[[ -f "$HERE/deploy-activate.sh" ]] || die "missing $HERE/deploy-activate.sh"
[[ -f "$REPO/deploy/scripts/apply-grants.sh" ]] || die "missing $REPO/deploy/scripts/apply-grants.sh"
[[ -f "$REPO/deploy/mariadb/post-migrate-grants.sql" ]] || die "missing $REPO/deploy/mariadb/post-migrate-grants.sql"
command -v flock >/dev/null || die "flock is missing (apt install util-linux)"
command -v curl  >/dev/null || die "curl is missing (apt install curl)"

PUBKEY="${1:-}"
if [[ -n "$PUBKEY" && ! "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/]+={0,2}(\ [A-Za-z0-9@._-]+)?$ ]]; then
  die "that does not look like an ed25519 public key. Paste the ONE line from uboss_deploy.pub."
fi

# -----------------------------------------------------------------------------
# The deploy user
#
# It needs a real shell: sshd runs the forced command THROUGH the user's shell,
# so /usr/sbin/nologin would refuse every deploy. The restriction is the
# authorized_keys line instead - with `restrict` and `command=`, the key cannot
# open a terminal, forward anything, or run any other program. The password is
# locked, so the key is the only way in.
# -----------------------------------------------------------------------------
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  log "creating the $DEPLOY_USER user"
  useradd --create-home --shell /bin/bash "$DEPLOY_USER"
fi
passwd -l "$DEPLOY_USER" >/dev/null

# .ssh and authorized_keys are root-owned: even if the deploy account were
# misused, it could not add a key or loosen its own restriction.
DEPLOY_HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)"
install -d -m 755 -o root -g "$DEPLOY_USER" "$DEPLOY_HOME/.ssh"
[[ -f "$DEPLOY_HOME/.ssh/authorized_keys" ]] || install -m 644 -o root -g "$DEPLOY_USER" /dev/null "$DEPLOY_HOME/.ssh/authorized_keys"
chown root:"$DEPLOY_USER" "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 644 "$DEPLOY_HOME/.ssh/authorized_keys"

KEY_OPTS='restrict,command="/srv/uboss/bin/deploy-activate"'
if [[ -n "$PUBKEY" ]]; then
  KEY_BODY="$(printf '%s' "$PUBKEY" | awk '{print $2}')"
  if grep -qF "$KEY_BODY" "$DEPLOY_HOME/.ssh/authorized_keys"; then
    log "that key is already in $DEPLOY_HOME/.ssh/authorized_keys"
  else
    log "adding the key with its forced command"
    printf '%s %s\n' "$KEY_OPTS" "$PUBKEY" >> "$DEPLOY_HOME/.ssh/authorized_keys"
  fi
fi

# -----------------------------------------------------------------------------
# Folders
#
# /srv/uboss gets o+x (traverse, NOT list) so the deploy user can reach
# incoming/ and bin/. shared/ and backups/ keep their own 700 and stay closed.
# -----------------------------------------------------------------------------
log "creating the folders"
chmod o+x "$ROOT"
install -d -m 755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ROOT/releases"
install -d -m 700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$ROOT/shared"
install -d -m 2750 -o "$DEPLOY_USER" -g "$SERVICE_USER" "$ROOT/incoming"
install -d -m 755 -o root -g root "$ROOT/bin"
install -m 755 -o root -g root "$HERE/deploy-activate.sh" "$ROOT/bin/deploy-activate"

if [[ -e "$ROOT/current" && ! -L "$ROOT/current" ]]; then
  warn "$ROOT/current is a real folder, not a link. Automatic deploys need the"
  warn "releases/ + current-link layout - see deploy-vps/README.md, 'Switch to the release layout'."
fi

# -----------------------------------------------------------------------------
# What root runs on uboss's behalf
#
# apply-grants.sh reads the database name by SOURCING shared/.env - a file
# uboss owns. Run as root, that would let anything that can write .env run
# code as root. So root never runs it with .env: the wrapper sets UBOSS_DB_NAME
# from a root-owned config file, which makes apply-grants.sh skip .env entirely.
# -----------------------------------------------------------------------------
log "installing root-owned copies of the grants script"
install -d -m 755 -o root -g root "$LIB" "$LIB/scripts" "$LIB/mariadb" /etc/uboss
install -m 755 -o root -g root "$REPO/deploy/scripts/apply-grants.sh" "$LIB/scripts/apply-grants.sh"
install -m 644 -o root -g root "$REPO/deploy/mariadb/post-migrate-grants.sql" "$LIB/mariadb/post-migrate-grants.sql"

if [[ ! -f "$CONF" ]]; then
  DB_NAME="$(sed -n 's#^[[:space:]]*DATABASE_URL[[:space:]]*=[[:space:]]*["'\'']\{0,1\}[a-z]*://[^/]*/\([A-Za-z0-9_]*\).*#\1#p' "$ROOT/shared/.env" 2>/dev/null | tail -n1 || true)"
  DB_NAME="${DB_NAME:-uboss}"
  printf '# Read by %s/apply-grants. Root-owned on purpose.\nUBOSS_DB_NAME=%s\n' "$LIB" "$DB_NAME" > "$CONF"
  chmod 644 "$CONF"
  log "database name for the grants step: $DB_NAME (change it in $CONF if wrong)"
fi

cat > "$LIB/apply-grants" <<'WRAPPER'
#!/usr/bin/env bash
# Installed by deploy-vps/setup-deploy-user.sh. Runs apply-grants.sh as root
# WITHOUT sourcing the uboss-owned shared/.env (see the setup script).
set -euo pipefail
name="$(sed -n 's/^UBOSS_DB_NAME=\([A-Za-z0-9_]\{1,64\}\)$/\1/p' /etc/uboss/deploy-vps.conf | tail -n1)"
[[ -n "$name" ]] || { echo "xx no valid UBOSS_DB_NAME in /etc/uboss/deploy-vps.conf" >&2; exit 1; }
export UBOSS_DB_NAME="$name"
exec /usr/bin/bash /usr/local/lib/uboss/scripts/apply-grants.sh
WRAPPER
chown root:root "$LIB/apply-grants"
chmod 755 "$LIB/apply-grants"

# -----------------------------------------------------------------------------
# sudoers - one exact command per line, no wildcard except the release name
# (which deploy-activate checks against a strict pattern before using it).
# -----------------------------------------------------------------------------
log "installing $SUDOERS"
TMP="$(mktemp /etc/sudoers.d/.uboss-deploy-vps.XXXXXX)"
cat > "$TMP" <<SUDO
# Installed by deploy-vps/setup-deploy-user.sh. Do not add wildcards: the one
# below is the release name, which deploy-activate checks against a strict pattern.
$DEPLOY_USER ALL=($SERVICE_USER) NOPASSWD: $ROOT/bin/deploy-activate --stage2 *
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart uboss-api@4000, \\
  /usr/bin/systemctl restart uboss-api@4001, \\
  /usr/bin/systemctl restart uboss-api@4002, \\
  /usr/bin/systemctl restart uboss-worker, \\
  /usr/bin/systemctl start uboss-backup.service, \\
  $LIB/apply-grants ""
SUDO
chmod 440 "$TMP"
if visudo -cf "$TMP" >/dev/null; then
  mv -f "$TMP" "$SUDOERS"
else
  rm -f "$TMP"
  die "the generated sudoers file did not parse - nothing was installed"
fi

cat <<DONE

$(printf '\033[1;32mOK\033[0m') automatic deploy setup is in place.

DONE

if [[ -z "$PUBKEY" ]]; then
  cat <<DONE
No key was given. Add ONE line to $DEPLOY_HOME/.ssh/authorized_keys,
or run this script again with the public key in quotes:

  $KEY_OPTS ssh-ed25519 AAAA...your-key... uboss-deploy

DONE
fi

cat <<DONE
GitHub's DEPLOY_KNOWN_HOSTS secret is the output of this, run on YOUR computer:

  ssh-keyscan -t ed25519 <your server IP>

Test from your computer (it must say "request refused", nothing else):

  ssh -i ~/.ssh/uboss_deploy $DEPLOY_USER@<your server IP> hello
DONE
