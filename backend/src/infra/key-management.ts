/**
 * Where the credential vault's key comes from, and which keys it may use.
 *
 * `infra/crypto.ts` encrypts every stored credential - payment gateway keys,
 * ERP and carrier credentials, MFA secrets - with AES-256-GCM. This module
 * answers the only question it cannot answer itself: which 32 bytes.
 *
 * A KEYRING, NOT A KEY
 *
 * One key is CURRENT: everything written is written under it. Any number are
 * PREVIOUS: they are tried, in order, when the current one does not open an
 * envelope. GCM's authentication tag makes that safe - a wrong key fails the
 * tag, it never "decrypts" into garbage - so an envelope needs no key id and
 * the stored format (`v1:iv:tag:ciphertext`) did not have to change.
 *
 * That is what makes rotation a no-downtime operation:
 *
 *   1. Generate a new key. Put it in SECRETS_ENCRYPTION_KEY and move the old
 *      one to SECRETS_ENCRYPTION_KEY_PREVIOUS. Restart instance by instance -
 *      every instance can read both the whole time.
 *   2. `npm run secrets:reencrypt` rewrites every stored envelope under the new
 *      key, in batches, and reports what is left under the old one.
 *   3. When it reports nothing left, drop the old key.
 *
 * PROVIDERS
 *
 *   env      the key is SECRETS_ENCRYPTION_KEY itself. The default, and what a
 *            single-server deployment with a 0600 `.env` needs.
 *   file     the key is read from SECRETS_ENCRYPTION_KEY_FILE. What a secret
 *            manager's agent (Vault Agent, the AWS/GCP secret CSI drivers),
 *            systemd `LoadCredential=` or a mounted Kubernetes secret writes -
 *            the key never appears in the process environment.
 *   command  SECRETS_ENCRYPTION_KEY_COMMAND (a JSON argv, never a shell line)
 *            is run once at start-up and prints the key on stdout. This is the
 *            KMS option, envelope style: the data key is stored WRAPPED by a
 *            KMS master key that never leaves the KMS, and the command unwraps
 *            it - `aws kms decrypt`, `gcloud kms decrypt`, `az keyvault key
 *            decrypt`, `vault write transit/decrypt/...`. Revoking the
 *            machine's KMS permission revokes its ability to start.
 *
 * A deployment with its own KMS client can implement `KeyProvider` and pass it
 * to `loadKeyring` - nothing else changes.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export interface Keyring {
  /** Which provider produced this - for the start-up log line. */
  provider: string;
  /** Everything written is written under this. */
  current: Buffer;
  /** Tried in order when `current` does not open an envelope. Read-only. */
  previous: readonly Buffer[];
}

export interface KeyProvider {
  readonly name: string;
  /** The current key, 32 bytes. Throw rather than return something shorter. */
  loadCurrentKey(): Buffer;
}

export class KeyManagementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyManagementError';
  }
}

export interface KeySettings {
  SECRETS_KEY_PROVIDER: 'env' | 'file' | 'command';
  SECRETS_ENCRYPTION_KEY: string;
  SECRETS_ENCRYPTION_KEY_FILE: string;
  SECRETS_ENCRYPTION_KEY_COMMAND: string;
  SECRETS_ENCRYPTION_KEY_PREVIOUS: string;
}

/** Decode a base64 key and insist on 32 bytes. The message never holds the key. */
export function decodeKey(encoded: string, source: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== 32) {
    throw new KeyManagementError(
      `${source} did not yield a 32-byte base64 key (got ${key.length} bytes).`,
    );
  }
  return key;
}

/**
 * A short, non-reversible label for a key or secret - safe to log, store and
 * compare. Domain-separated so it cannot be confused with any other hash of
 * the same value.
 */
export function fingerprint(material: Buffer | string): string {
  return createHash('sha256')
    .update('uboss-key-fingerprint:v1:')
    .update(material)
    .digest('hex')
    .slice(0, 16);
}

export function providerFor(settings: KeySettings): KeyProvider {
  switch (settings.SECRETS_KEY_PROVIDER) {
    case 'env':
      return {
        name: 'env',
        loadCurrentKey: () => decodeKey(settings.SECRETS_ENCRYPTION_KEY, 'SECRETS_ENCRYPTION_KEY'),
      };
    case 'file':
      return {
        name: 'file',
        loadCurrentKey: () => {
          let text: string;
          try {
            text = readFileSync(settings.SECRETS_ENCRYPTION_KEY_FILE, 'utf8');
          } catch {
            throw new KeyManagementError('SECRETS_ENCRYPTION_KEY_FILE could not be read.');
          }
          return decodeKey(text, 'SECRETS_ENCRYPTION_KEY_FILE');
        },
      };
    case 'command':
      return {
        name: 'command',
        loadCurrentKey: () => {
          const argv = JSON.parse(settings.SECRETS_ENCRYPTION_KEY_COMMAND) as string[];
          const [program, ...args] = argv;
          if (program === undefined) {
            throw new KeyManagementError('SECRETS_ENCRYPTION_KEY_COMMAND is empty.');
          }
          let output: string;
          try {
            output = execFileSync(program, args, {
              encoding: 'utf8',
              timeout: 30_000,
              // stderr is the operator's; stdout is the key and is never logged.
              stdio: ['ignore', 'pipe', 'inherit'],
              windowsHide: true,
            });
          } catch {
            throw new KeyManagementError(
              'SECRETS_ENCRYPTION_KEY_COMMAND failed - the key could not be unwrapped.',
            );
          }
          return decodeKey(output, 'SECRETS_ENCRYPTION_KEY_COMMAND');
        },
      };
  }
}

export function loadKeyring(settings: KeySettings, provider = providerFor(settings)): Keyring {
  const current = provider.loadCurrentKey();
  const previous = settings.SECRETS_ENCRYPTION_KEY_PREVIOUS.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry, index) => decodeKey(entry, `SECRETS_ENCRYPTION_KEY_PREVIOUS[${index}]`))
    // The current key listed as previous as well is harmless but pointless.
    .filter((key) => !key.equals(current));

  return { provider: provider.name, current, previous };
}
