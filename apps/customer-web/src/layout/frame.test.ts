/**
 * Which pages get the full-bleed frame. The reason each case matters is in
 * `frame.ts`; the company sign-up is the one that was wrong.
 */
import { describe, expect, it } from 'vitest';
import { CHECK_EMAIL_PATH } from '@/lib/sign-up';
import { COMPANY_SIGN_UP_PATH, isFullBleedPath } from './frame';

describe('isFullBleedPath', () => {
  it('frames the company sign-up like the other sign-up while signed out', () => {
    expect(isFullBleedPath(COMPANY_SIGN_UP_PATH, false)).toBe(true);
    expect(isFullBleedPath('/register', false)).toBe(true);
  });

  it('gives the signed-in company page the ordinary frame, so nothing below the fold is clipped', () => {
    expect(isFullBleedPath(COMPANY_SIGN_UP_PATH, true)).toBe(false);
  });

  it('frames the verification page like the form before it, signed in or out', () => {
    expect(isFullBleedPath(CHECK_EMAIL_PATH, false)).toBe(true);
    expect(isFullBleedPath(CHECK_EMAIL_PATH, true)).toBe(true);
  });

  it('leaves every other page - the application itself included - in the ordinary frame', () => {
    for (const path of ['/', '/products', '/account/companies', '/account/companies/01X', '/register/company/extra']) {
      expect(isFullBleedPath(path, true)).toBe(false);
      expect(isFullBleedPath(path, false)).toBe(false);
    }
  });
});
