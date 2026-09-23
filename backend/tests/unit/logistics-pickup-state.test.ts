/**
 * Which way a collection may move.
 *
 * Pure, so the whole table is cheap to assert - and worth asserting, because
 * the states arrive from three places that do not coordinate: a seller's
 * screen cancels, a driver's phone completes, a carrier's webhook fails. Over a
 * flaky mobile connection they arrive in any order, and without one place that
 * says what may follow what, a late "cancelled" silently un-completes a
 * collection that already happened - leaving the parcels on a van the system
 * believes never came.
 */
import { describe, expect, it } from 'vitest';
import type { LogisticsPickupState } from '../../src/generated/prisma/enums.js';
import {
  assertPickupTransition,
  isLivePickupState,
  LIVE_PICKUP_STATES,
  PICKUP_TRANSITIONS,
} from '../../src/domain/logistics-pickup-state.js';

const TERMINAL: LogisticsPickupState[] = ['COMPLETED', 'FAILED', 'CANCELLED'];

describe('the shape of the table', () => {
  it('lets nothing leave a terminal state', () => {
    // A collection that failed and was rebooked is a NEW collection, because
    // it is: a different van, a different window, usually a different driver.
    for (const state of TERMINAL) {
      expect(PICKUP_TRANSITIONS[state]).toHaveLength(0);
    }
  });

  it('agrees with itself about which states are live', () => {
    for (const state of Object.keys(PICKUP_TRANSITIONS) as LogisticsPickupState[]) {
      // A state is live exactly when it has somewhere to go. Two lists that
      // disagreed would let a finished collection keep its claim on a
      // consignment and block every later booking.
      expect(isLivePickupState(state)).toBe(PICKUP_TRANSITIONS[state].length > 0);
    }

    expect(LIVE_PICKUP_STATES).toHaveLength(3);
  });
});

describe('moves that are allowed', () => {
  it('lets a request be scheduled, confirmed and completed in order', () => {
    expect(() => {
      assertPickupTransition('REQUESTED', 'SCHEDULED');
    }).not.toThrow();
    expect(() => {
      assertPickupTransition('SCHEDULED', 'CONFIRMED');
    }).not.toThrow();
    expect(() => {
      assertPickupTransition('CONFIRMED', 'COMPLETED');
    }).not.toThrow();
  });

  it('lets a confirmed collection still be cancelled', () => {
    // The goods being ready does not mean the van has left. A seller who has
    // just been told their customer cancelled should not have to let the
    // collection happen anyway.
    expect(() => {
      assertPickupTransition('CONFIRMED', 'CANCELLED');
    }).not.toThrow();
  });

  it('treats a move to the state it is already in as nothing to do', () => {
    // Retries land here constantly. A phone that resent "collected" over a bad
    // connection asked for something already true.
    for (const state of Object.keys(PICKUP_TRANSITIONS) as LogisticsPickupState[]) {
      expect(() => {
        assertPickupTransition(state, state);
      }).not.toThrow();
    }
  });
});

describe('moves that are refused', () => {
  it('will not un-complete a collection that happened', () => {
    // The one that matters. The parcels are gone; a late cancel that won would
    // leave the system believing the van never came.
    expect(() => {
      assertPickupTransition('COMPLETED', 'CANCELLED');
    }).toThrow(/cannot become/);
  });

  it('will not revive a cancelled or failed one', () => {
    expect(() => {
      assertPickupTransition('CANCELLED', 'SCHEDULED');
    }).toThrow();
    expect(() => {
      assertPickupTransition('FAILED', 'COMPLETED');
    }).toThrow();
  });

  it('will not run a collection backwards', () => {
    expect(() => {
      assertPickupTransition('SCHEDULED', 'REQUESTED');
    }).toThrow();
    expect(() => {
      assertPickupTransition('CONFIRMED', 'SCHEDULED');
    }).toThrow();
  });

  it('refuses with a conflict, and names both ends', () => {
    // A 409 rather than a 400: the request was well formed and the answer
    // depends on what has happened since. The two states are in the details so
    // a screen can say which collection it is talking about.
    try {
      assertPickupTransition('COMPLETED', 'CANCELLED');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toMatchObject({
        statusCode: 409,
        code: 'PICKUP_TRANSITION_INVALID',
        details: [{ meta: { from: 'COMPLETED', to: 'CANCELLED' } }],
      });
    }
  });
});
