/**
 * `components/agreement-kit/` is one set of files kept in four apps: the
 * storefront (and its Seller Hub), the admin console, the carrier portal and
 * the Audit Console. They show the same agreement screen, so a fix to one is a
 * fix to all - but only while the copies are the same. This fails the moment
 * they are not: make the change in one app and copy the folder to the others.
 *
 * The same test is in all four apps, so any one's `npm run verify` catches it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apps = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const kit = (app: string): string => join(apps, app, 'src', 'components', 'agreement-kit');
// Line endings are the checkout's business, not the code's.
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const APPS = ['customer-web', 'admin-web', 'logistics-web', 'audit-web'];

describe('components/agreement-kit', () => {
  it('is the same files in all four apps', () => {
    const reference = readdirSync(kit('customer-web')).sort();
    for (const app of APPS.slice(1)) {
      expect(readdirSync(kit(app)).sort(), app).toEqual(reference);
      for (const file of reference) {
        expect(read(join(kit(app), file)), `${app}/${file}`).toBe(read(join(kit('customer-web'), file)));
      }
    }
  });
});
