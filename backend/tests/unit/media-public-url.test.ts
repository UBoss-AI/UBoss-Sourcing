/**
 * The URL a stored picture is served from.
 *
 * One setting decides this - `STORAGE_PUBLIC_BASE_URL` - and getting it wrong
 * is invisible on the machine that made the upload. An absolute
 * `http://localhost:4000/media` puts that host into every picture's URL; a
 * browser anywhere else resolves `localhost` to its OWN device, and an HTTPS
 * page refuses an `http://` image outright. The upload succeeds, the row is
 * written, and the seller who just added a photograph is looking at an empty
 * box with nothing in the console to explain it.
 *
 * So the shape of that setting is worth a test of its own:
 *
 *   - a **root-relative** base gives back a root-relative URL, which is
 *     correct on whatever origin the page was opened from,
 *   - an **absolute** base still gives back an absolute URL, because that is
 *     what a CDN in front of an object store needs,
 *   - and a **protocol-relative** base is refused, because it points at
 *     another origin while looking like a path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_BASE = process.env.STORAGE_PUBLIC_BASE_URL;
const ORIGINAL_DRIVER = process.env.STORAGE_DRIVER;

beforeEach(() => {
  process.env.STORAGE_DRIVER = 'local';
});

afterEach(() => {
  process.env.STORAGE_PUBLIC_BASE_URL = ORIGINAL_BASE;
  process.env.STORAGE_DRIVER = ORIGINAL_DRIVER;
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('the public URL of a stored object', () => {
  it('stays on the page own origin when the base is root-relative', async () => {
    process.env.STORAGE_PUBLIC_BASE_URL = '/media';
    vi.resetModules();

    const { storage } = await import('../../src/infra/storage/index.js');

    expect(storage.urlFor('products/ab/cd/X.png')).toBe('/media/products/ab/cd/X.png');
  });

  it('is absolute when the base names a CDN', async () => {
    process.env.STORAGE_PUBLIC_BASE_URL = 'https://cdn.example.com/';
    vi.resetModules();

    const { storage } = await import('../../src/infra/storage/index.js');

    // The trailing slash on the base must not double up.
    expect(storage.urlFor('products/ab/cd/X.png')).toBe(
      'https://cdn.example.com/products/ab/cd/X.png',
    );
  });

  it('refuses a protocol-relative base, which would point off this origin', async () => {
    process.env.STORAGE_PUBLIC_BASE_URL = '//cdn.example.com';
    vi.resetModules();

    // The environment loader writes the reason out and exits; stubbed here so
    // that the refusal can be observed instead of taking the runner with it.
    const exit = vi.spyOn(process, 'exit').mockImplementation((): never => {
      throw new Error('process.exit');
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(import('../../src/config/env.js')).rejects.toThrow('process.exit');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
