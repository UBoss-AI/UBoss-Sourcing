/**
 * The seller state machines.
 *
 * These tests are about the transitions that must NOT exist as much as the
 * ones that must. A state machine's value is entirely in what it refuses, and
 * a refusal that quietly stops refusing is invisible until somebody exploits
 * it - so the absences are asserted explicitly rather than left implied by the
 * table.
 */
import { describe, expect, it } from 'vitest';
import {
  allowedApplicationTransitions,
  allowedListingTransitions,
  allowedSellerOrderTransitions,
  assertListingTransition,
  assertSellerApplicationTransition,
  assertSellerOrderTransition,
  ListingDraftStatusValues,
  SellerApplicationStatusValues,
  SELLER_TRADING_STATUSES,
} from '../../src/domain/seller-state.js';

describe('seller application transitions', () => {
  it('lets a seller submit a draft and an operator approve it', () => {
    expect(() =>
      assertSellerApplicationTransition({ from: 'DRAFT', to: 'SUBMITTED', actor: 'SELLER' }),
    ).not.toThrow();

    expect(() =>
      assertSellerApplicationTransition({ from: 'SUBMITTED', to: 'APPROVED', actor: 'OPERATOR' }),
    ).not.toThrow();
  });

  it('refuses to let a seller approve their own application', () => {
    // The single most important refusal in the file. A seller who could
    // approve themselves is not being reviewed at all.
    expect(() =>
      assertSellerApplicationTransition({ from: 'SUBMITTED', to: 'APPROVED', actor: 'SELLER' }),
    ).toThrow(/cannot move an application/i);
  });

  it('refuses to let a seller lift their own suspension', () => {
    expect(() =>
      assertSellerApplicationTransition({
        from: 'SUSPENDED',
        to: 'APPROVED',
        actor: 'SELLER',
        reason: 'we fixed it',
      }),
    ).toThrow();
  });

  it('never lets an approved seller be rejected', () => {
    // An approved seller has live listings, open orders and money owed.
    // "Rejected" is a decision about an application and covers none of that;
    // stopping them is SUSPENDED.
    expect(() =>
      assertSellerApplicationTransition({
        from: 'APPROVED',
        to: 'REJECTED',
        actor: 'OPERATOR',
        reason: 'no longer wanted',
      }),
    ).toThrow(/cannot move from APPROVED to REJECTED/i);

    expect(() =>
      assertSellerApplicationTransition({
        from: 'APPROVED',
        to: 'SUSPENDED',
        actor: 'OPERATOR',
        reason: 'certificate lapsed',
      }),
    ).not.toThrow();
  });

  it('never approves straight out of rejection', () => {
    // Approving from REJECTED would be approving the version that was refused.
    expect(() =>
      assertSellerApplicationTransition({ from: 'REJECTED', to: 'APPROVED', actor: 'OPERATOR' }),
    ).toThrow();
  });

  it('demands a seller-readable reason on every refusal and every stop', () => {
    for (const to of ['ACTION_REQUIRED', 'REJECTED'] as const) {
      expect(() =>
        assertSellerApplicationTransition({ from: 'SUBMITTED', to, actor: 'OPERATOR' }),
      ).toThrow(/needs a reason/i);

      expect(() =>
        assertSellerApplicationTransition({
          from: 'SUBMITTED',
          to,
          actor: 'OPERATOR',
          // Whitespace is not a reason.
          reason: '   ',
        }),
      ).toThrow(/needs a reason/i);
    }
  });

  it('refuses a transition to the same status', () => {
    expect(() =>
      assertSellerApplicationTransition({ from: 'APPROVED', to: 'APPROVED', actor: 'OPERATOR' }),
    ).toThrow(/already/i);
  });

  it('only lets a seller trade while APPROVED', () => {
    for (const status of SellerApplicationStatusValues) {
      expect(SELLER_TRADING_STATUSES.includes(status)).toBe(status === 'APPROVED');
    }
  });

  it('offers an operator nothing to do with an application still in DRAFT', () => {
    // It has not been handed to them yet. A review queue that offered a
    // decision on somebody's unfinished form would be reviewing a blank.
    expect(allowedApplicationTransitions('DRAFT', 'OPERATOR')).toHaveLength(0);
    expect(allowedApplicationTransitions('DRAFT', 'SELLER')).toEqual([
      { to: 'SUBMITTED', requiresReason: false },
    ]);
  });
});

describe('listing transitions', () => {
  it('only ever reaches APPROVED from PENDING_REVIEW, and only by an operator', () => {
    // The guarantee the whole table exists to make: nothing becomes publicly
    // buyable without having been looked at.
    for (const from of ListingDraftStatusValues) {
      for (const actor of ['SELLER', 'OPERATOR', 'SYSTEM'] as const) {
        const reachesApproved = allowedListingTransitions(from, actor).some(
          (entry) => entry.to === 'APPROVED',
        );

        expect(reachesApproved).toBe(from === 'PENDING_REVIEW' && actor === 'OPERATOR');
      }
    }
  });

  it('does not let a seller declare their own listing ready', () => {
    // READY_FOR_SUBMISSION is the RESULT of the checks passing, not a claim
    // the seller makes. A seller who could set it could submit an incomplete
    // listing.
    expect(() =>
      assertListingTransition({ from: 'DRAFT', to: 'READY_FOR_SUBMISSION', actor: 'SELLER' }),
    ).toThrow();

    expect(() =>
      assertListingTransition({ from: 'DRAFT', to: 'READY_FOR_SUBMISSION', actor: 'SYSTEM' }),
    ).not.toThrow();
  });

  it('lets a seller submit only from READY_FOR_SUBMISSION', () => {
    expect(() =>
      assertListingTransition({ from: 'READY_FOR_SUBMISSION', to: 'PENDING_REVIEW', actor: 'SELLER' }),
    ).not.toThrow();

    expect(() =>
      assertListingTransition({ from: 'DRAFT', to: 'PENDING_REVIEW', actor: 'SELLER' }),
    ).toThrow();

    expect(() =>
      assertListingTransition({ from: 'VALIDATION_FAILED', to: 'PENDING_REVIEW', actor: 'SELLER' }),
    ).toThrow();
  });

  it('treats APPROVED as terminal for the draft', () => {
    // The listing now lives as an offer. Pausing and republishing happen
    // there, and a second edit starts a new draft - which is what keeps "what
    // exactly was approved" answerable.
    for (const actor of ['SELLER', 'OPERATOR', 'SYSTEM'] as const) {
      expect(allowedListingTransitions('APPROVED', actor)).toHaveLength(0);
    }
  });

  it('demands a comment when a moderator sends a listing back', () => {
    expect(() =>
      assertListingTransition({ from: 'PENDING_REVIEW', to: 'ACTION_REQUIRED', actor: 'OPERATOR' }),
    ).toThrow(/needs a comment/i);

    expect(() =>
      assertListingTransition({
        from: 'PENDING_REVIEW',
        to: 'ACTION_REQUIRED',
        actor: 'OPERATOR',
        reason: 'The UDI label photograph is unreadable.',
      }),
    ).not.toThrow();
  });
});

describe('seller order transitions', () => {
  it('walks a seller through accept, pick, ready, ship', () => {
    const path = [
      ['NEW', 'ACCEPTED'],
      ['ACCEPTED', 'PROCESSING'],
      ['PROCESSING', 'READY_FOR_DISPATCH'],
      ['READY_FOR_DISPATCH', 'SHIPPED'],
      ['SHIPPED', 'DELIVERED'],
    ] as const;

    for (const [from, to] of path) {
      expect(() => assertSellerOrderTransition({ from, to, actor: 'SELLER' })).not.toThrow();
    }
  });

  it('does not let a seller cancel after it has left the building', () => {
    expect(() =>
      assertSellerOrderTransition({
        from: 'SHIPPED',
        to: 'CANCELLED',
        actor: 'SELLER',
        reason: 'changed our mind',
      }),
    ).toThrow();
  });

  it('never lets a seller refund', () => {
    // The marketplace took the payment, so the marketplace returns it. A
    // seller moving an order to REFUNDED would be asserting a transfer that
    // nobody made.
    for (const from of ['CANCELLED', 'RETURNED', 'DISPUTED'] as const) {
      const sellerCanRefund = allowedSellerOrderTransitions(from, 'SELLER').some(
        (entry) => entry.to === 'REFUNDED',
      );
      expect(sellerCanRefund).toBe(false);
    }

    expect(() =>
      assertSellerOrderTransition({ from: 'RETURNED', to: 'REFUNDED', actor: 'OPERATOR' }),
    ).not.toThrow();
  });

  it('demands a reason for a rejection and for a dispute', () => {
    expect(() =>
      assertSellerOrderTransition({ from: 'NEW', to: 'CANCELLED', actor: 'SELLER' }),
    ).toThrow(/needs a reason/i);

    expect(() =>
      assertSellerOrderTransition({
        from: 'RETURN_REQUESTED',
        to: 'DISPUTED',
        actor: 'SELLER',
      }),
    ).toThrow(/needs a reason/i);
  });

  it('treats REFUNDED as terminal', () => {
    for (const actor of ['SELLER', 'OPERATOR', 'SYSTEM'] as const) {
      expect(allowedSellerOrderTransitions('REFUNDED', actor)).toHaveLength(0);
    }
  });
});
