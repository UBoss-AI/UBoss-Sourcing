/**
 * `lib/chat-kit/` is one set of files kept in two apps.
 *
 * The storefront's Account -> Messages and the console's Preorder Chats scroll,
 * send and draw messages with the same code, so a fix to one is a fix to both
 * - but only while the copies are the same. This fails the moment they are
 * not: make the change in one app and copy the folder to the other.
 *
 * The same test is in both apps, so either one's `npm run verify` catches it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apps = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const kit = (app: string): string => join(apps, app, 'src', 'lib', 'chat-kit');
// Line endings are the checkout's business, not the code's.
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('lib/chat-kit', () => {
  it('is the same files in the storefront and the console', () => {
    const storefront = readdirSync(kit('customer-web')).sort();
    const console = readdirSync(kit('admin-web')).sort();
    expect(console).toEqual(storefront);
    for (const file of storefront) {
      expect(read(join(kit('admin-web'), file)), file).toBe(read(join(kit('customer-web'), file)));
    }
  });
});
