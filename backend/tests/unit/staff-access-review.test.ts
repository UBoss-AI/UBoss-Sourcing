/**
 * When a staff account counts as dormant on the access review (LIVE-015).
 */
import { describe, expect, it } from 'vitest';
import { isDormant } from '../../src/modules/identity/staff-access-review.service.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * 86_400_000);

describe('isDormant', () => {
  it('flags an account whose last sign-in is at least the threshold ago', () => {
    expect(isDormant({ lastLoginAt: daysAgo(90), createdAt: daysAgo(400), deactivated: false }, 90, NOW)).toBe(true);
    expect(isDormant({ lastLoginAt: daysAgo(89), createdAt: daysAgo(400), deactivated: false }, 90, NOW)).toBe(false);
  });

  it('counts from creation for an account that never signed in', () => {
    expect(isDormant({ lastLoginAt: null, createdAt: daysAgo(120), deactivated: false }, 90, NOW)).toBe(true);
    // A brand-new invitation is not dormant just because nobody has used it yet.
    expect(isDormant({ lastLoginAt: null, createdAt: daysAgo(3), deactivated: false }, 90, NOW)).toBe(false);
  });

  it('never flags a deactivated account, and never flags anything when switched off', () => {
    expect(isDormant({ lastLoginAt: daysAgo(500), createdAt: daysAgo(900), deactivated: true }, 90, NOW)).toBe(false);
    expect(isDormant({ lastLoginAt: daysAgo(500), createdAt: daysAgo(900), deactivated: false }, 0, NOW)).toBe(false);
  });
});
