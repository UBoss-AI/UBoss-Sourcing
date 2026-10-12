/**
 * `components/ui/scroll-area.tsx` and the `.scroll-area` block at the end of
 * `index.css` are kept the same in all four apps, so every pane that scrolls
 * looks and behaves alike. This fails the moment one copy changes without the
 * others: make the change in one app and copy it to the rest.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const apps = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (app: string, path: string): string =>
  readFileSync(join(apps, app, 'src', path), 'utf8').replace(/\r\n/g, '\n');
const cssBlock = (app: string): string => {
  const css = read(app, 'index.css');
  return css.slice(css.indexOf('/* ---------------------------------------------------------------------------\n * ScrollArea'));
};
const APPS = ['customer-web', 'admin-web', 'logistics-web', 'audit-web'];

describe('components/ui/scroll-area', () => {
  it('is the same component and styles in all four apps', () => {
    for (const app of APPS.slice(1)) {
      expect(read(app, 'components/ui/scroll-area.tsx'), app).toBe(read('customer-web', 'components/ui/scroll-area.tsx'));
      expect(cssBlock(app), `${app}/index.css`).toBe(cssBlock('customer-web'));
      expect(cssBlock(app).length, app).toBeGreaterThan(100);
    }
  });
});
