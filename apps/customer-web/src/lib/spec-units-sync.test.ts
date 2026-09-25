/**
 * The specification units and groups the Seller Hub offers are the server's.
 *
 * The server refuses a unit or a group it does not know, so a unit added on
 * one side and not the other is a dropdown option that fails every save. This
 * reads the server's own list and compares.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SPEC_UNITS } from './seller';
import { SPEC_GROUP_KEYS } from './types';

const domain = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'backend', 'src', 'domain', 'product-specifications.ts'),
  'utf8',
);

function listNamed(name: string): string[] {
  const start = domain.indexOf(`export const ${name} = [`);
  const end = domain.indexOf('] as const;', start);
  if (start < 0 || end < 0) throw new Error(`${name} not found`);
  return [...domain.slice(start, end).matchAll(/'([^']+)'/g)].map((entry) => entry[1] ?? '');
}

describe('specification lists', () => {
  it('offers exactly the server’s units', () => {
    expect([...SPEC_UNITS]).toEqual(listNamed('SPEC_UNITS'));
  });

  it('offers exactly the server’s groups, in its order', () => {
    expect([...SPEC_GROUP_KEYS]).toEqual(listNamed('SPEC_GROUPS'));
  });
});
