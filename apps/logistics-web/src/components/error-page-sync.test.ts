/**
 * The full-page error kit is one folder kept in three apps.
 *
 * `components/error-page/` is written once, in the storefront, and copied here
 * and to the admin panel, so a 403 cannot say one thing in one app and
 * something else in another, and the rule about when "Try again" is safe
 * lives in one place. Edit the storefront's copy and copy it across; this
 * fails the build until the copies agree again.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const THIS_APP = 'logistics-web';
const apps = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const kit = (app: string): string => join(apps, app, 'src', 'components', 'error-page');
// Line endings are the checkout's business, not the code's.
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('components/error-page', () => {
  it('is the same files here as in the storefront', () => {
    const storefront = readdirSync(kit('customer-web')).sort();
    const here = readdirSync(kit(THIS_APP)).sort();
    expect(here).toEqual(storefront);
    for (const file of storefront) {
      expect(read(join(kit(THIS_APP), file)), file).toBe(read(join(kit('customer-web'), file)));
    }
  });
});
