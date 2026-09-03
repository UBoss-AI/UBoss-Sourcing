/**
 * Object storage.
 *
 * `STORAGE_DRIVER=local` writes under STORAGE_LOCAL_DIR and serves through the
 * API. It is a development convenience - local disk is not durable, is not
 * shared between instances, and is rejected at boot in production.
 *
 * Uploaded files are treated as hostile input:
 *   - The extension and the client-supplied MIME type are BOTH ignored for
 *     type decisions. The real type is sniffed from the file's magic bytes.
 *   - The stored key is generated, never derived from the client's filename,
 *     so `../../etc/passwd` and friends have nothing to traverse.
 *   - SVG is refused outright: it is XML, it can carry script, and browsers
 *     execute it when served inline.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env, isProduction } from '../../config/env.js';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { newId } from '../ids.js';

export interface StoredObject {
  storageKey: string;
  url: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
  width?: number;
  height?: number;
}

export interface StorageDriver {
  readonly name: string;
  put(buffer: Buffer, mimeType: string, extension: string): Promise<StoredObject>;
  get(storageKey: string): Promise<Buffer>;
  delete(storageKey: string): Promise<void>;
  urlFor(storageKey: string): string;
}

/**
 * Allowed image types, keyed by the magic bytes that actually identify them.
 *
 * A client can claim any Content-Type; only the bytes are trusted.
 */
const MAGIC_SIGNATURES: readonly {
  mimeType: string;
  extension: string;
  matches: (buffer: Buffer) => boolean;
}[] = [
  {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimeType: 'image/png',
    extension: 'png',
    matches: (b) =>
      b.length > 8 &&
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a,
  },
  {
    mimeType: 'image/webp',
    extension: 'webp',
    // "RIFF" .... "WEBP"
    matches: (b) =>
      b.length > 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
  {
    mimeType: 'image/gif',
    extension: 'gif',
    matches: (b) => b.length > 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('ascii')),
  },
];

export interface SniffedType {
  mimeType: string;
  extension: string;
}

/**
 * Identify an upload by its magic bytes.
 *
 * Throws for anything unrecognised, which includes SVG - deliberately absent
 * from the table above, because an SVG is a script-capable document, not a
 * picture, and serving one inline is a stored-XSS vector.
 */
export function sniffImageType(buffer: Buffer): SniffedType {
  const match = MAGIC_SIGNATURES.find((signature) => signature.matches(buffer));

  if (match === undefined) {
    throw badRequest(
      ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
      'Only JPEG, PNG, WebP and GIF images are accepted.',
      [{ field: 'file', code: 'UNSUPPORTED_IMAGE_TYPE' }],
    );
  }

  return { mimeType: match.mimeType, extension: match.extension };
}

export function assertWithinSizeLimit(sizeBytes: number): void {
  if (sizeBytes > env.UPLOAD_MAX_BYTES) {
    const limitMb = (env.UPLOAD_MAX_BYTES / 1_048_576).toFixed(1);
    throw badRequest(ErrorCode.MEDIA_TOO_LARGE, `Images must be ${limitMb} MB or smaller.`, [
      { field: 'file', code: 'FILE_TOO_LARGE', meta: { maxBytes: env.UPLOAD_MAX_BYTES } },
    ]);
  }

  if (sizeBytes === 0) {
    throw badRequest(ErrorCode.IMPORT_FILE_INVALID, 'The uploaded file is empty.');
  }
}

/**
 * Read PNG/JPEG intrinsic dimensions from the header.
 *
 * Enough to store useful metadata and let the frontend reserve layout space
 * without pulling in an image-processing dependency.
 */
export function readImageDimensions(
  buffer: Buffer,
  mimeType: string,
): { width: number; height: number } | null {
  try {
    if (mimeType === 'image/png' && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }

    if (mimeType === 'image/jpeg') {
      // Walk the segment markers to the first Start-Of-Frame.
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) {
          offset += 1;
          continue;
        }

        const marker = buffer[offset + 1] ?? 0;
        // SOF0..SOF3 and SOF5..SOF15 carry the dimensions; skip DHT/DAC/RSTn.
        const isStartOfFrame =
          marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

        if (isStartOfFrame) {
          return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
        }

        offset += 2 + buffer.readUInt16BE(offset + 2);
      }
    }
  } catch {
    // A truncated or malformed header is not worth failing an upload over;
    // dimensions are optional metadata.
    return null;
  }

  return null;
}

/**
 * Sharded key: `products/ab/cd/<ulid>.jpg`.
 *
 * The two-level prefix keeps any single directory from accumulating tens of
 * thousands of entries on a local filesystem, and matches the prefix layout S3
 * likes for request distribution.
 */
function buildStorageKey(extension: string): string {
  const id = newId();
  return `products/${id.slice(0, 2).toLowerCase()}/${id.slice(2, 4).toLowerCase()}/${id}.${extension}`;
}

class LocalStorageDriver implements StorageDriver {
  readonly name = 'local';
  private readonly root: string;

  constructor() {
    this.root = resolve(process.cwd(), env.STORAGE_LOCAL_DIR);
  }

  /**
   * Resolve a key to an absolute path, refusing anything that escapes the root.
   * Keys are generated internally, but this is the kind of check that must not
   * depend on every future caller remembering.
   */
  private pathFor(storageKey: string): string {
    const target = resolve(this.root, storageKey);
    if (!target.startsWith(this.root)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Invalid storage key.');
    }
    return target;
  }

  async put(buffer: Buffer, mimeType: string, extension: string): Promise<StoredObject> {
    const storageKey = buildStorageKey(extension);
    const target = this.pathFor(storageKey);

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buffer);

    const dimensions = readImageDimensions(buffer, mimeType);

    return {
      storageKey,
      url: this.urlFor(storageKey),
      mimeType,
      sizeBytes: buffer.byteLength,
      checksum: createHash('sha256').update(buffer).digest('hex'),
      ...(dimensions ?? {}),
    };
  }

  get(storageKey: string): Promise<Buffer> {
    return readFile(this.pathFor(storageKey));
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await unlink(this.pathFor(storageKey));
    } catch (error) {
      // Already gone is the desired end state, not an error.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  urlFor(storageKey: string): string {
    return `${env.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, '')}/${storageKey}`;
  }

  /** Absolute directory the static route serves from. */
  get rootDirectory(): string {
    return this.root;
  }
}

function createStorageDriver(): StorageDriver {
  switch (env.STORAGE_DRIVER) {
    case 'local':
      if (isProduction) {
        throw new Error('STORAGE_DRIVER=local is not durable and is not allowed in production.');
      }
      return new LocalStorageDriver();
    case 's3':
      throw new Error(
        'STORAGE_DRIVER=s3 is not implemented yet. Add src/infra/storage/s3-storage.ts ' +
          'implementing StorageDriver.',
      );
    default: {
      const exhaustive: never = env.STORAGE_DRIVER;
      throw new Error(`Unknown STORAGE_DRIVER: ${String(exhaustive)}`);
    }
  }
}

export const storage: StorageDriver = createStorageDriver();

/** Local root directory, for wiring the static media route. Null under S3. */
export function localStorageRoot(): string | null {
  return storage instanceof LocalStorageDriver ? storage.rootDirectory : null;
}

export { join as joinStoragePath };
