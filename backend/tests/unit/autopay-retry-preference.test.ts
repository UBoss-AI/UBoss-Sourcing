/**
 * The customer's "if a payment fails" choice narrows the plan's retry budget
 * for a declined automatic charge, and never widens it (JOURNEY-051).
 */
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { attemptsAllowed, retryAttemptsFor } from '../../src/modules/payments/autopay.service.js';

describe('attempts allowed for a declined automatic charge', () => {
  it('"tell me, and do not try again" allows the first attempt only', () => {
    expect(retryAttemptsFor('NONE')).toBe(0);
    expect(attemptsAllowed(5, 'NONE')).toBe(1);
  });

  it('"try once more" allows two attempts', () => {
    expect(attemptsAllowed(5, 'ONCE')).toBe(2);
  });

  it('the standard choice follows the deployment ceiling', () => {
    expect(attemptsAllowed(99, 'STANDARD')).toBe(Math.max(0, env.SCHEDULE_MAX_PAYMENT_ATTEMPTS - 1) + 1);
  });

  it("never allows more than the plan's own budget", () => {
    expect(attemptsAllowed(1, 'ONCE')).toBe(1);
    expect(attemptsAllowed(1, 'STANDARD')).toBe(1);
  });

  it('leaves every other failure to the plan budget', () => {
    expect(attemptsAllowed(3, null)).toBe(3);
  });
});
