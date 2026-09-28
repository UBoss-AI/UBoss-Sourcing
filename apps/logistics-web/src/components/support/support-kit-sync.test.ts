/**
 * The Support page's globe and frame are one pair of files kept in two apps.
 *
 * The storefront (and Seller Hub) and this portal draw the same approved
 * Support design with the same code. This fails the moment the copies differ:
 * make the change in `apps/customer-web/src/components/support/` and copy the
 * two files here. The forms beside them are each app's own, because each app
 * has its own primitives and its own sender.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apps = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const file = (app: string, name: string): string =>
  join(apps, app, 'src', 'components', 'support', name);
// Line endings are the checkout's business, not the code's.
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('components/support', () => {
  it.each(['GlobeWireframe.tsx', 'ContactWithGlobe.tsx'])(
    '%s is the same file as the storefront’s',
    (name) => {
      expect(read(file('logistics-web', name))).toBe(read(file('customer-web', name)));
    },
  );
});
