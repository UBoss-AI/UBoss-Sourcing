/**
 * S3-compatible object storage.
 *
 * The production storage driver. `local` writes to one disk on one machine and
 * is refused at boot in production for the reason that matters more than
 * durability: product images and generated invoices are not in the database,
 * not in git, and not recoverable from anywhere else. A VPS disk is one disk.
 *
 * Speaks plain S3, so it works unchanged against AWS S3, Cloudflare R2,
 * Backblaze B2, DigitalOcean Spaces, Wasabi and MinIO. What differs between
 * them is configuration, not code:
 *
 *   | Provider      | S3_ENDPOINT                          | S3_REGION   | path style |
 *   |---------------|--------------------------------------|-------------|------------|
 *   | AWS S3        | (empty - the SDK derives it)         | eu-central-1| false      |
 *   | Cloudflare R2 | https://<account>.r2.cloudflarestorage.com | auto   | true       |
 *   | Backblaze B2  | https://s3.<region>.backblazeb2.com  | <region>    | true       |
 *   | DO Spaces     | https://<region>.digitaloceanspaces.com | <region> | false      |
 *   | MinIO         | http://127.0.0.1:9000                | us-east-1   | true       |
 *
 * WHY THE SDK RATHER THAN A HAND-ROLLED SIGNER
 *
 * The rest of this codebase talks to Stripe and Razorpay over `fetch` with its
 * own HMAC, because a webhook signature has to be computed over the raw bytes
 * and a client library that re-serialises the body breaks it. None of that
 * applies here. AWS Signature Version 4 is a large, fiddly specification whose
 * failure mode is a 403 from one provider and not another, and this deployment
 * has no S3 endpoint to test a hand-written signer against before it is live.
 * The assistant already uses the official Anthropic and Google SDKs for the
 * same reason: where a maintained official client exists and carries no
 * correctness cost, it is the smaller risk.
 *
 * WHAT THE BUCKET MUST LOOK LIKE
 *
 * One bucket, two prefixes, and the separation is enforced by the bucket policy
 * rather than by this code:
 *
 *   products/   public read. Catalogue photographs, served straight to browsers
 *               that have never signed in, ideally through a CDN.
 *   private/    NO public read, ever. Report exports and Art. 15 personal-data
 *               bundles. These are read back through `get()` by code that has
 *               already checked a hashed, expiring token.
 *
 * `urlFor()` therefore only ever names something under `products/`, and it
 * throws if asked for a private key - see the note on that method. Block public
 * access at the bucket level and grant `s3:GetObject` on the `products/*` ARN
 * only. Listing must be off for both: an enumerable bucket turns an unguessable
 * key into a directory index.
 *
 * docs/DEPLOYMENT.md has the provider setup and the go-live smoke test.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { internal, serviceUnavailable } from '../../domain/errors.js';
import { logger } from '../logger.js';
import {
  PRIVATE_PREFIX,
  buildStorageKey,
  readImageDimensions,
  type StorageDriver,
  type StorageVisibility,
  type StoredObject,
} from './index.js';

/**
 * How long a single object operation may take before it is abandoned.
 *
 * An upload happens inside a request a person is waiting on, so this cannot be
 * generous. The ceiling that matters is `UPLOAD_MAX_BYTES` (5 MB by default);
 * 30 seconds is many times what that needs on any link worth deploying to, and
 * short enough that a wedged endpoint fails rather than holding a connection.
 */
const OPERATION_TIMEOUT_MS = 30_000;

/**
 * Attempts per operation, including the first.
 *
 * Small on purpose. The SDK already retries transient failures internally with
 * its own backoff; this is the outer bound that decides how long a caller
 * waits in total, not a second retry policy layered on top.
 */
const MAX_ATTEMPTS = 3;

/**
 * Cache-Control written on public objects.
 *
 * A stored key is immutable - `buildStorageKey` mints a fresh ULID for every
 * upload and nothing is ever overwritten in place - so a year is safe and it is
 * what makes a CDN in front of the bucket worth having. Private objects get no
 * cache header at all.
 */
const PUBLIC_CACHE_CONTROL = 'public, max-age=31536000, immutable';

function isPrivateKey(storageKey: string): boolean {
  return storageKey === PRIVATE_PREFIX || storageKey.startsWith(`${PRIVATE_PREFIX}/`);
}

/**
 * Is this failure worth another attempt?
 *
 * Deliberately narrow. A 403 means the credentials or the bucket policy are
 * wrong and retrying turns one clear failure into three slow ones; a 404 on
 * `get` means the object is not there. Only transport faults and the server
 * saying it is busy are retried.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode ?? 0;
    return status === 429 || status >= 500;
  }
  // Connection reset, DNS blip, socket timeout: no HTTP response at all.
  return error instanceof Error && !(error instanceof S3ServiceException);
}

function statusOf(error: unknown): number | undefined {
  return error instanceof S3ServiceException ? error.$metadata.httpStatusCode : undefined;
}

export class S3StorageDriver implements StorageDriver {
  readonly name = 's3';
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(client?: S3Client) {
    this.bucket = env.S3_BUCKET;
    this.client =
      client ??
      new S3Client({
        // R2 requires the literal region "auto"; AWS requires a real one. An
        // empty S3_REGION lets the SDK fall back to its own resolution chain,
        // which is right for an AWS deployment using an instance profile.
        ...(env.S3_REGION.length > 0 ? { region: env.S3_REGION } : {}),
        ...(env.S3_ENDPOINT.length > 0 ? { endpoint: env.S3_ENDPOINT } : {}),
        // Path style (`endpoint/bucket/key`) rather than virtual-hosted
        // (`bucket.endpoint/key`). Required by MinIO and by R2, harmless
        // elsewhere, and it is the default here because getting it wrong
        // produces a DNS failure that reads like an outage.
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        ...(env.S3_ACCESS_KEY_ID.length > 0 && env.S3_SECRET_ACCESS_KEY.length > 0
          ? {
              credentials: {
                accessKeyId: env.S3_ACCESS_KEY_ID,
                secretAccessKey: env.S3_SECRET_ACCESS_KEY,
              },
            }
          : {}),
        maxAttempts: 1, // retrying is this class's job - see `run`
      });
  }

  /**
   * Run one S3 call with a timeout and a bounded retry.
   *
   * `operation` is a label for the log line, never anything derived from a
   * caller's input: a storage key names a person's export bundle.
   */
  private async run<T>(operation: string, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);

      try {
        return await call(controller.signal);
      } catch (error) {
        lastError = error;

        if (!isRetryable(error) || attempt === MAX_ATTEMPTS) break;

        // 200ms, 400ms. Short: a person is waiting on the other end of this.
        const delayMs = 200 * 2 ** (attempt - 1);
        logger.warn(
          { operation, attempt, delayMs, status: statusOf(error) },
          'object storage call failed; retrying',
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      } finally {
        clearTimeout(timer);
      }
    }

    logger.error(
      { err: lastError, operation, status: statusOf(lastError) },
      'object storage call failed',
    );
    throw serviceUnavailable('Storage is temporarily unavailable. Please try again.', lastError);
  }

  async put(
    buffer: Buffer,
    mimeType: string,
    extension: string,
    visibility: StorageVisibility = 'public',
  ): Promise<StoredObject> {
    const storageKey = buildStorageKey(extension, visibility);
    const checksum = createHash('sha256').update(buffer).digest('hex');

    await this.run('put', (signal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: storageKey,
          Body: buffer,
          ContentType: mimeType,
          // Not decoration. Without it a browser sniffs the bytes, and the
          // whole point of sniffing the magic bytes on the way IN is undone if
          // the way OUT lets the browser decide for itself. The local driver's
          // static route and the nginx `/media/` block set the same three.
          ContentDisposition: 'inline',
          ...(visibility === 'public' ? { CacheControl: PUBLIC_CACHE_CONTROL } : {}),
          // Integrity end to end: the service rejects the upload if what
          // arrived does not hash to this.
          ChecksumSHA256: createHash('sha256').update(buffer).digest('base64'),
        }),
        { abortSignal: signal },
      ),
    );

    const dimensions = readImageDimensions(buffer, mimeType);

    return {
      storageKey,
      // Empty for a private object, and deliberately not a URL.
      //
      // `urlFor` refuses a private key outright (see below), so this cannot
      // call it unconditionally - that would make every export bundle and
      // every seller document fail to upload at all. No caller reads `url`
      // after a private put; they all take `storageKey` and read the bytes
      // back through `get()` behind a token check. An empty string is a
      // visibly broken link if one ever starts to, which is the direction to
      // fail in.
      url: visibility === 'private' ? '' : this.urlFor(storageKey),
      mimeType,
      sizeBytes: buffer.byteLength,
      checksum,
      ...(dimensions ?? {}),
    };
  }

  async get(storageKey: string): Promise<Buffer> {
    const response = await this.run('get', (signal) =>
      this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: storageKey }),
        { abortSignal: signal },
      ),
    );

    if (response.Body === undefined) {
      throw internal('Storage returned an object with no body.');
    }

    // `transformToByteArray` buffers the whole object. Every caller of `get`
    // already does - an export bundle is assembled in memory and a document is
    // streamed to the client by the route - so this adds no ceiling that was
    // not already there.
    return Buffer.from(await response.Body.transformToByteArray());
  }

  async delete(storageKey: string): Promise<void> {
    // S3 DELETE is idempotent: removing a key that is not there is a 204, not
    // a 404. Already gone is the desired end state, which is what the local
    // driver's ENOENT branch is saying too.
    await this.run('delete', (signal) =>
      this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }),
        { abortSignal: signal },
      ),
    );
  }

  /**
   * The public URL for a stored object.
   *
   * Refuses a private key, and that refusal is the point. `urlFor` produces a
   * link with no token and no expiry; handing one out for a report export or an
   * Art. 15 bundle would make an unguessable path the only thing between a
   * person's data and anyone who ever saw the URL - in a referrer header, a
   * proxy log, a pasted message. Private objects are read back through `get()`
   * behind a token check, and there is no legitimate caller that needs a URL
   * for one. Throwing here turns a future mistake into a 500 in staging rather
   * than a quiet disclosure in production.
   */
  urlFor(storageKey: string): string {
    if (isPrivateKey(storageKey)) {
      throw internal('Refusing to build a public URL for a private storage object.');
    }
    return `${env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '')}/${storageKey}`;
  }
}
