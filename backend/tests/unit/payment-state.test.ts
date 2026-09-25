/**
 * Payment attempt states.
 *
 * The two properties that matter most: a captured payment can never move
 * again, and a capture can always be recorded - even against an attempt this
 * system had given up on, because money that moved has moved.
 */
import { describe, expect, it } from 'vitest';
import {
  PAYMENT_STATUSES,
  PaymentTransitionError,
  assertPaymentTransition,
  canTransitionPayment,
  isOpenPayment,
  lifecycleState,
  paymentSourcesOf,
} from '../../src/domain/payment-state.js';

describe('payment transitions', () => {
  it('lets nothing leave CAPTURED', () => {
    for (const to of PAYMENT_STATUSES) {
      expect(canTransitionPayment('CAPTURED', to)).toBe(false);
    }
  });

  it('lets a capture follow every other state', () => {
    expect(paymentSourcesOf('CAPTURED').sort()).toEqual(
      PAYMENT_STATUSES.filter((status) => status !== 'CAPTURED').sort(),
    );
  });

  it('closes an attempt only from an open one', () => {
    expect(paymentSourcesOf('EXPIRED').sort()).toEqual(['AUTHORIZED', 'CREATED', 'PENDING']);
    expect(paymentSourcesOf('CANCELLED').sort()).toEqual(['AUTHORIZED', 'CREATED', 'PENDING']);
  });

  it('does not reopen a cancelled or expired attempt', () => {
    expect(canTransitionPayment('CANCELLED', 'PENDING')).toBe(false);
    expect(canTransitionPayment('EXPIRED', 'CREATED')).toBe(false);
  });

  it('throws a typed error on a move that is not allowed', () => {
    expect(() => {
      assertPaymentTransition('CAPTURED', 'FAILED');
    }).toThrow(PaymentTransitionError);
  });

  it('counts only the three open states as holding an order', () => {
    expect(PAYMENT_STATUSES.filter(isOpenPayment).sort()).toEqual(['AUTHORIZED', 'CREATED', 'PENDING']);
  });
});

describe('lifecycleState', () => {
  const base = {
    status: 'CAPTURED' as const,
    providerSessionId: 'cs_test_1',
    failureCode: null,
    capturedMinor: 10_000n,
    refundedMinor: 0n,
    disputedAt: null,
  };

  it('names the richer states from the facts beside the stored one', () => {
    expect(lifecycleState({ ...base, status: 'CREATED', providerSessionId: null })).toBe('CREATED');
    expect(lifecycleState({ ...base, status: 'CREATED' })).toBe('CHECKOUT_SESSION_CREATED');
    expect(lifecycleState({ ...base, status: 'PENDING' })).toBe('PROCESSING');
    expect(
      lifecycleState({ ...base, status: 'PENDING', failureCode: 'authentication_required' }),
    ).toBe('REQUIRES_ACTION');
    expect(lifecycleState(base)).toBe('SUCCEEDED');
    expect(lifecycleState({ ...base, refundedMinor: 2_500n })).toBe('PARTIALLY_REFUNDED');
    expect(lifecycleState({ ...base, refundedMinor: 10_000n })).toBe('REFUNDED');
  });

  it('puts a dispute above any refund, because it needs a person', () => {
    expect(lifecycleState({ ...base, refundedMinor: 10_000n, disputedAt: new Date() })).toBe(
      'DISPUTED',
    );
  });
});
