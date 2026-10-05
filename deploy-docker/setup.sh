#!/usr/bin/env bash
# =============================================================================
# One-time server setup for push-to-live on a Docker Compose install.
# Run as root:
#
#   bash setup.sh "ssh-ed25519 AAAA... uboss-deploy" [/srv/your-compose-dir]
#
# The compose directory is the one holding compose.yml, with the three built
# front ends bind-mounted from apps/customer-web/dist, apps/admin-web/dist and
# apps/logistics-web/dist. It defaults to /srv/gloviaa.
#
# What it sets up, and nothing else:
#
#   deploy user        a separate login for GitHub Actions. Not root, password
#                      locked. Its key runs exactly one program (the gate).
#   /var/lib/uboss-deploy/incoming
#                      where uploads land. deploy-owned, mode 0700.
#   /usr/local/bin/uboss-deploy-gate
#                      the forced command. Accepts only `receive <release>` and
#                      `activate <release>`; refuses everything else.
#   /usr/local/sbin/uboss-docker-activate
#                      verifies the checksum, backs up the live front ends,
#                      swaps the new ones in. The only thing deploy may sudo.
#   /etc/uboss-docker-deploy.conf, /etc/sudoers.d/uboss-docker-deploy
#
# It never reads or touches .env, db.env, the database or any container.
# Safe to run again: every step checks before it acts, and a re-run refreshes
# the installed programs and the key.
# =============================================================================
set -euo pipefail

PUBKEY="${1:-}"
COMPOSE_DIR="${2:-/srv/gloviaa}"
STATE=/var/lib/uboss-deploy

say() { printf '\033[1;32m==\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root"
[[ "$PUBKEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || die 'pass the public key line: bash setup.sh "ssh-ed25519 AAAA... uboss-deploy"'
for a in customer-web admin-web logistics-web; do
  [ -d "$COMPOSE_DIR/apps/$a/dist" ] || die "$COMPOSE_DIR/apps/$a/dist does not exist - is $COMPOSE_DIR the compose directory?"
done

command -v rsync >/dev/null || { say "installing rsync"; apt-get install -y rsync >/dev/null; }

# --- the deploy user ---------------------------------------------------------
# A real shell: sshd runs the forced command through it.
if ! id deploy >/dev/null 2>&1; then
  say "creating the deploy user"
  useradd --create-home --shell /bin/bash deploy
fi
passwd -l deploy >/dev/null

install -d -o deploy -g deploy -m 0700 "$STATE/incoming"
install -d -o root -g root -m 0700 "$STATE/backups"

cat > /etc/uboss-docker-deploy.conf <<EOF
COMPOSE_DIR=$COMPOSE_DIR
STATE=$STATE
EOF
chmod 0644 /etc/uboss-docker-deploy.conf

# --- the gate (forced command) -----------------------------------------------
cat > /usr/local/bin/uboss-deploy-gate <<'GATE'
#!/usr/bin/env bash
# Forced command for the deploy key. Two requests, nothing else.
set -euo pipefail
. /etc/uboss-docker-deploy.conf
RELEASE='^uboss-web-[0-9a-f]{40}\.tgz$'
read -r cmd arg extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
refuse() { echo "request refused"; exit 1; }
[ -z "${extra:-}" ] || refuse
case "${cmd:-}" in
  receive)
    [[ "$arg" =~ $RELEASE || "${arg%.sha256}" =~ $RELEASE && "$arg" == *.sha256 ]] || refuse
    # 200 MB is far above a real release; a larger stream fails its checksum.
    head -c 200000000 > "$STATE/incoming/$arg.part"
    mv -f "$STATE/incoming/$arg.part" "$STATE/incoming/$arg"
    echo "received $arg"
    ;;
  activate)
    [[ "$arg" =~ $RELEASE ]] || refuse
    exec sudo -n /usr/local/sbin/uboss-docker-activate "$arg"
    ;;
  *) refuse ;;
esac
GATE

# --- activation (runs as root through sudo) ----------------------------------
cat > /usr/local/sbin/uboss-docker-activate <<'ACT'
#!/usr/bin/env bash
# Puts a received front-end release live. Run by the gate through sudo.
set -euo pipefail
umask 022
. /etc/uboss-docker-deploy.conf
name="${1:-}"
[[ "$name" =~ ^uboss-web-[0-9a-f]{40}\.tgz$ ]] || { echo "bad release name"; exit 2; }
in="$STATE/incoming"
[ -f "$in/$name" ] && [ -f "$in/$name.sha256" ] || { echo "release not received"; exit 2; }

exec 9>"$STATE/lock"; flock -n 9 || { echo "another deploy is running"; exit 3; }

( cd "$in" && sha256sum --check --strict --status "$name.sha256" ) || { echo "checksum mismatch"; exit 4; }

work=$(mktemp -d "$STATE/work.XXXXXX"); trap 'rm -rf "$work"' EXIT
tar -xzf "$in/$name" -C "$work" --no-same-owner --no-same-permissions
[ -z "$(find "$work" -type l -print -quit)" ] || { echo "release contains links; refused"; exit 4; }
apps="customer-web admin-web logistics-web"
for a in $apps; do
  [ -f "$work/apps/$a/dist/index.html" ] || { echo "release is missing apps/$a/dist"; exit 4; }
done

# Back up what is live now, keep the newest ten.
backup="$STATE/backups/web-$(date -u +%Y%m%d-%H%M%S).tgz"
tar -czf "$backup" -C "$COMPOSE_DIR" apps/customer-web/dist apps/admin-web/dist apps/logistics-web/dist
ls -1t "$STATE"/backups/web-*.tgz | tail -n +11 | xargs -r rm -f

# Into the same folders: nginx bind-mounts these exact directories, so a
# replaced directory would never be seen. New assets land before index.html
# points at them, and old ones go only after, so a page mid-load still works.
for a in $apps; do
  rsync -a --delete-after --exclude index.html "$work/apps/$a/dist/" "$COMPOSE_DIR/apps/$a/dist/"
  install -m 0644 "$work/apps/$a/dist/index.html" "$COMPOSE_DIR/apps/$a/dist/index.html"
done

rm -f "$in/$name" "$in/$name.sha256"
echo "OK live: $name (previous version saved in $backup)"
ACT

chmod 0755 /usr/local/bin/uboss-deploy-gate /usr/local/sbin/uboss-docker-activate
chown root:root /usr/local/bin/uboss-deploy-gate /usr/local/sbin/uboss-docker-activate

# --- sudo: exactly one program -----------------------------------------------
tmp=$(mktemp)
echo 'deploy ALL=(root) NOPASSWD: /usr/local/sbin/uboss-docker-activate' > "$tmp"
visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "sudoers line failed visudo"; }
install -m 0440 -o root -g root "$tmp" /etc/sudoers.d/uboss-docker-deploy
rm -f "$tmp"

# --- the key, locked to the gate ---------------------------------------------
say "adding the key with its forced command"
install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
printf 'restrict,command="/usr/local/bin/uboss-deploy-gate" %s\n' "$PUBKEY" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys

if command -v sshd >/dev/null && sshd -T 2>/dev/null | grep -qiE '^allowusers '; then
  sshd -T | grep -qiE '^allowusers .*\bdeploy\b' || say "WARNING: sshd has AllowUsers and deploy is not in it - add it or GitHub cannot log in"
fi

say "OK push-to-live setup is in place for $COMPOSE_DIR"
