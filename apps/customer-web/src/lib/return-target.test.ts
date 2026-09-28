/**
 * Where a sign-in sends somebody afterwards. Same-origin paths only: anything
 * that could leave the site is dropped for the home page, never "corrected".
 */
import { describe, expect, it } from 'vitest';
import { HOME, returnTarget } from './return-target';

describe('returnTarget', () => {
  it('lands on /home when nothing asked for anywhere else', () => {
    expect(HOME).toBe('/home');
    expect(returnTarget(null, '')).toBe('/home');
  });

  it('honours router state and ?next= on this site', () => {
    expect(returnTarget({ from: '/cart' }, '')).toBe('/cart');
    expect(returnTarget(null, '?next=%2Faccount%2Fcompanies')).toBe('/account/companies');
  });

  it.each([
    'https://evil.example/',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    'evil.example',
  ])('refuses %s', (target) => {
    expect(returnTarget({ from: target }, '')).toBe('/home');
    expect(returnTarget(null, `?next=${encodeURIComponent(target)}`)).toBe('/home');
  });
});
