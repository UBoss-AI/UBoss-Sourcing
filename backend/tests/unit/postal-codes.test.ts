/** Postal-code shapes (JOURNEY-022 address validation), and the storefront copy agrees. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isPlausiblePostalCode } from '../../src/domain/postal-codes.js';

describe('isPlausiblePostalCode', () => {
  it('accepts the shape each listed market uses', () => {
    for (const [country, code] of [['IN', '411019'], ['DE', '10115'], ['PL', '00-001'], ['NL', '3011 AA'], ['GR', '105 57'], ['US', '94105-1234'], ['GB', 'SW1A 1AA']]) {
      expect(isPlausiblePostalCode(country as string, code as string), `${country} ${code}`).toBe(true);
    }
  });

  it('refuses the wrong shape, and lets an unlisted country through', () => {
    for (const [country, code] of [['IN', '012345'], ['IN', '4110'], ['DE', '1011'], ['PL', '00001'], ['NL', 'AA3011']]) {
      expect(isPlausiblePostalCode(country as string, code as string), `${country} ${code}`).toBe(false);
    }
    expect(isPlausiblePostalCode('BR', 'anything')).toBe(true);
  });

  it('is the same table the storefront checks against', () => {
    const backend = readFileSync(new URL('../../src/domain/postal-codes.ts', import.meta.url), 'utf8');
    const storefront = readFileSync(new URL('../../../apps/customer-web/src/lib/postal-codes.ts', import.meta.url), 'utf8');
    const table = (source: string) => source.slice(source.indexOf('export const POSTAL_CODE_PATTERNS'));
    expect(table(storefront)).toBe(table(backend));
  });
});
