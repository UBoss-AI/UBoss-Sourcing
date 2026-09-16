/**
 * The production storage driver.
 *
 * Three things are worth testing here and the third is the reason this file
 * exists at all.
 *
 *   1. **The bucket layout.** Where a byte lands decides who can read it. A
 *      public object under `private/`, or the reverse, is a data-protection
 *      incident rather than a bug, and nothing downstream would notice.
 *   2. **The headers written on the way in.** Uploads are sniffed by magic
 *      bytes on the way in; letting the browser sniff them again on the way out
 *      undoes that, so `ContentType` and `ContentDisposition` are part of the
 *      contract and not decoration.
 *   3. **That importing this module at all still works.** index.ts and
 *      s3-storage.ts import each other. That resolves correctly today because
 *      neither reads the other during evaluation - but it is exactly the kind
 *      of thing a later refactor breaks silently, and the failure mode is the
 *      API refusing to boot in production only.
 *
 * The S3 client is a stub. This is a unit test of the driver's behaviour, not
 * of AWS Signature Version 4 - see the note at the bottom about what still has
 * to be proved against a real endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Captured commands, newest last. */
interface SentCommand {
  name: string;
  input: Record<string, unknown>;
}

const sent: SentCommand[] = [];
/** Queue of outcomes for successive `send` calls. `null` means "succeed". */
let outcomes: (Error | null)[] = [];

/** A stub standing in for `S3Client`, recording what the driver asked for. */
class StubS3Client {
  send(command: { constructor: { name: string }; input: Record<string, unknown> }): Promise<unknown> {
    sent.push({ name: command.constructor.name, input: command.input });

    const outcome = outcomes.shift() ?? null;
    if (outcome !== null) return Promise.reject(outcome);

    if (command.constructor.name === 'GetObjectCommand') {
      return Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2, 3, 4])) },
      });
    }
    return Promise.resolve({});
  }
}

const ONE_PIXEL_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
    '01f15c4890000000a49444154789c6360000002000100',
  'hex',
);

describe('bucket layout', () => {
  it('puts catalogue media under products/ and shards it two levels deep', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const stored = await driver.put(ONE_PIXEL_PNG, 'image/png', 'png', 'public');

    expect(stored.storageKey).toMatch(/^products\/[0-9a-z]{2}\/[0-9a-z]{2}\/[0-9A-Z]{26}\.png$/);
  });

  it('puts personal-data bundles under private/', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const stored = await driver.put(Buffer.from('{}'), 'application/json', 'json', 'private');

    expect(stored.storageKey).toMatch(/^private\//);
  });

  it('returns no URL for a private object, and still completes the upload', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    // The regression: `put` used to build the URL unconditionally, so the
    // guard in `urlFor` turned every export bundle, GDPR archive, seller
    // certificate and logistics document into a failed upload.
    const stored = await driver.put(Buffer.from('{}'), 'application/json', 'json', 'private');

    expect(stored.url).toBe('');
    expect(sent.at(-1)?.name).toBe('PutObjectCommand');
  });

  it('defaults to public when no visibility is given, matching the local driver', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const stored = await driver.put(ONE_PIXEL_PNG, 'image/png', 'png');

    expect(stored.storageKey).toMatch(/^products\//);
  });

  it('never reuses a key, so nothing is ever overwritten in place', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const first = await driver.put(ONE_PIXEL_PNG, 'image/png', 'png');
    const second = await driver.put(ONE_PIXEL_PNG, 'image/png', 'png');

    expect(first.storageKey).not.toBe(second.storageKey);
  });
});

describe('what is written', () => {
  it('sets the sniffed content type and refuses to let a browser re-sniff it', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    await driver.put(ONE_PIXEL_PNG, 'image/png', 'png', 'public');

    const put = sent.at(-1);
    expect(put?.name).toBe('PutObjectCommand');
    expect(put?.input.ContentType).toBe('image/png');
    expect(put?.input.ContentDisposition).toBe('inline');
  });

  it('caches public objects for a year, because a key is immutable', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    await driver.put(ONE_PIXEL_PNG, 'image/png', 'png', 'public');

    expect(sent.at(-1)?.input.CacheControl).toBe('public, max-age=31536000, immutable');
  });

  it('sets no cache header on a private object', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    await driver.put(Buffer.from('{}'), 'application/json', 'json', 'private');

    expect(sent.at(-1)?.input.CacheControl).toBeUndefined();
  });

  it('reports the sha256 of the bytes it was handed', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const stored = await driver.put(Buffer.from('hello'), 'text/csv', 'csv', 'private');

    // sha256("hello")
    expect(stored.checksum).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
    expect(stored.sizeBytes).toBe(5);
  });

  it('reads image dimensions, so the catalogue does not have to re-open the file', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const stored = await driver.put(ONE_PIXEL_PNG, 'image/png', 'png');

    expect(stored.width).toBe(1);
    expect(stored.height).toBe(1);
  });
});

describe('urlFor', () => {
  it('builds a public URL under the configured base', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    expect(driver.urlFor('products/ab/cd/X.png')).toMatch(/\/products\/ab\/cd\/X\.png$/);
  });

  it('REFUSES a private key rather than handing out an unauthenticated link', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    // A report export or an Art. 15 bundle. A URL with no token and no expiry
    // would make the unguessable path the only control, and URLs leak.
    expect(() => driver.urlFor('private/ab/cd/X.json')).toThrow(/private storage object/i);
  });
});

describe('get and delete', () => {
  it('returns the object body as a Buffer', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    const body = await driver.get('private/ab/cd/X.json');

    expect(Buffer.isBuffer(body)).toBe(true);
    expect([...body]).toEqual([1, 2, 3, 4]);
  });

  it('deletes by key', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    await driver.delete('products/ab/cd/X.png');

    expect(sent.at(-1)?.name).toBe('DeleteObjectCommand');
    expect(sent.at(-1)?.input.Key).toBe('products/ab/cd/X.png');
  });
});

describe('failure handling', () => {
  it('retries a transport failure and succeeds on a later attempt', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    outcomes = [new Error('ECONNRESET'), null];

    const stored = await driver.put(ONE_PIXEL_PNG, 'image/png', 'png');

    expect(stored.storageKey).toMatch(/^products\//);
    expect(sent).toHaveLength(2);
  });

  it('gives up after three attempts and reports the service as unavailable', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    outcomes = [new Error('ECONNRESET'), new Error('ECONNRESET'), new Error('ECONNRESET')];

    await expect(driver.put(ONE_PIXEL_PNG, 'image/png', 'png')).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(sent).toHaveLength(3);
  });

  it('never leaks a storage key or a provider message to the caller', async () => {
    const { S3StorageDriver } = await import('../../src/infra/storage/s3-storage.js');
    const driver = new S3StorageDriver(new StubS3Client() as never);

    outcomes = [new Error('boom'), new Error('boom'), new Error('boom')];

    // A storage key names somebody's export bundle; a provider message can
    // carry the bucket and the full path.
    await expect(driver.get('private/ab/cd/secret.json')).rejects.toThrow(
      /^Storage is temporarily unavailable\./,
    );
  });
});

describe('module wiring', () => {
  it('STORAGE_DRIVER=s3 selects the S3 driver, and the import cycle resolves', async () => {
    // The regression this guards: index.ts and s3-storage.ts import each other,
    // and `createStorageDriver()` runs at module-evaluation time. If that ever
    // stops working the symptom is an API that boots in development and dies in
    // production, which is the most expensive place to find out.
    vi.resetModules();
    process.env.STORAGE_DRIVER = 's3';
    process.env.S3_BUCKET = 'uboss-test';
    process.env.S3_ACCESS_KEY_ID = 'test-key-id';
    process.env.S3_SECRET_ACCESS_KEY = 'test-secret';

    const { storage, localStorageRoot } = await import('../../src/infra/storage/index.js');

    expect(storage.name).toBe('s3');
    // Null under S3: there is no local directory for the static route to mount,
    // and app.ts branches on exactly this.
    expect(localStorageRoot()).toBeNull();
  });
});

beforeEach(() => {
  sent.length = 0;
  outcomes = [];
  process.env.S3_BUCKET = 'uboss-test';
  process.env.STORAGE_PUBLIC_BASE_URL = 'https://cdn.example.com';
});

afterEach(() => {
  vi.resetModules();
});

/*
 * WHAT THIS FILE DOES NOT PROVE, AND WHERE THAT IS PROVED INSTEAD
 *
 * The S3 client is stubbed, so nothing here exercises AWS Signature Version 4,
 * TLS, bucket policy or a provider's particular dialect. A signature that is
 * wrong for Backblaze but right for MinIO would pass every test above.
 *
 * That is deliberate rather than an omission: signing is the SDK's job, and the
 * only honest test of it is a round trip against the real bucket. The go-live
 * runbook in docs/DEPLOYMENT.md §21 therefore carries an explicit smoke test -
 * upload a product image, fetch it from STORAGE_PUBLIC_BASE_URL, confirm a
 * private key is NOT publicly readable, then delete it - and that step is a
 * no-go condition, not a nice-to-have.
 */
