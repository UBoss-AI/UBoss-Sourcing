#!/usr/bin/env bash
# =============================================================================
# Create the key files MariaDB data-at-rest encryption reads.
#
#   sudo deploy/scripts/mariadb-encryption-keys.sh [KEY_DIR]
#
# Writes, in KEY_DIR (default /etc/mysql/encryption):
#
#   keyfile.key   the key-encryption key ("filekey"): 64 random bytes, hex.
#   keyfile.enc   the data keys - `1;<hex>` and `2;<hex>` - encrypted with the
#                 filekey (AES-256-CBC, as file_key_management expects).
#
# Both owned by mysql:mysql, mode 0400, in a 0750 directory. The plaintext key
# list exists only in a private temporary file and is shredded before exit.
#
# Refuses to overwrite existing keys: replacing them makes every encrypted
# table unreadable. There is no recovering data whose key was overwritten.
#
# BACK THE TWO FILES UP, separately from the database backups, before the
# first encrypted table is written. A backup of an encrypted database without
# its keys is not a backup. docs/DEPLOYMENT.md "Encryption at rest".
# =============================================================================
set -euo pipefail

KEY_DIR="${1:-/etc/mysql/encryption}"
OWNER="${MARIADB_KEY_OWNER:-mysql}"

if [[ -e "$KEY_DIR/keyfile.enc" || -e "$KEY_DIR/keyfile.key" ]]; then
  echo "Keys already exist in $KEY_DIR - refusing to overwrite them." >&2
  echo "Replacing them would make every encrypted table unreadable." >&2
  exit 1
fi

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
install -d -m 0750 "$KEY_DIR"

plain="$(mktemp)"
trap 'shred -u "$plain" 2>/dev/null || rm -f "$plain"' EXIT

openssl rand -hex 64 > "$KEY_DIR/keyfile.key"
{
  echo "1;$(openssl rand -hex 32)"
  echo "2;$(openssl rand -hex 32)"
} > "$plain"

openssl enc -aes-256-cbc -md sha1 -pass "file:$KEY_DIR/keyfile.key" \
  -in "$plain" -out "$KEY_DIR/keyfile.enc"

chown "$OWNER:$OWNER" "$KEY_DIR" "$KEY_DIR/keyfile.key" "$KEY_DIR/keyfile.enc"
chmod 0400 "$KEY_DIR/keyfile.key" "$KEY_DIR/keyfile.enc"

echo "Created $KEY_DIR/keyfile.enc and $KEY_DIR/keyfile.key (owner $OWNER, mode 0400)."
echo "Back both up now, somewhere other than this server and other than the database backups."
