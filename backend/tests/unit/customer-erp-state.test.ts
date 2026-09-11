/**
 * The two state machines behind a buyer's own ERP.
 *
 * Pure modules, so these are cheap tests - and they are the ones worth having,
 * because between them these two tables decide whether somebody else's purchase
 * orders get raised and whether somebody else's stock figures get written.
 *
 * The single most important assertion in this file is that SUCCEEDED has no way
 * out. An event that succeeded is one whose purchase order exists in a real
 * SAP; a path back to QUEUED would be a path to a second one.
 */
import { describe, expect, it } from 'vitest';
import {
  CustomerErpConnectionStateValues,
  CustomerErpEventStateValues,
  acceptsWebhooks,
  assertConnectionTransition,
  assertEventTransition,
  assertReadyToActivate,
  availableConnectionActions,
  canPerformConnectionAction,
  canPerformEventAction,
  carriesTraffic,
  connectionStateLabel,
  eventStateLabel,
  isCallable,
  isEventSettled,
  type CustomerErpEventStateName,
} from '../../src/domain/customer-erp-state.js';

describe('connection activation', () => {
  it('is reachable only from DRAFT', () => {
    expect(assertConnectionTransition('DRAFT', 'ACTIVATE')).toBe('ACTIVE');

    for (const state of CustomerErpConnectionStateValues) {
      if (state === 'DRAFT') continue;
      expect(() => assertConnectionTransition(state, 'ACTIVATE')).toThrow();
    }
  });

  it('is refused while a test is still in flight', () => {
    // A test that has not come back has proved nothing. Activating on the
    // strength of one is activating on hope.
    expect(canPerformConnectionAction('TESTING', 'ACTIVATE')).toBe(false);
  });

  it('needs a passing test, a checked mapping, and the endpoints the policy uses', () => {
    expect(() =>
      assertReadyToActivate({ lastTestOk: null, mappingVerifiedAt: null, missingEndpoints: [] }),
    ).toThrow(/Test connection/i);

    expect(() =>
      assertReadyToActivate({ lastTestOk: false, mappingVerifiedAt: new Date(), missingEndpoints: [] }),
    ).toThrow(/Test connection/i);

    expect(() =>
      assertReadyToActivate({ lastTestOk: true, mappingVerifiedAt: null, missingEndpoints: [] }),
    ).toThrow(/mapping/i);

    expect(() =>
      assertReadyToActivate({
        lastTestOk: true,
        mappingVerifiedAt: new Date(),
        missingEndpoints: ['invoices'],
      }),
    ).toThrow(/invoices/);

    expect(() =>
      assertReadyToActivate({
        lastTestOk: true,
        mappingVerifiedAt: new Date(),
        missingEndpoints: [],
      }),
    ).not.toThrow();
  });
});

describe('editing a connection', () => {
  it('takes it out of service whatever state it was in', () => {
    for (const state of CustomerErpConnectionStateValues) {
      if (state === 'DISCONNECTED') continue;

      // Whatever the last test proved, it proved about settings that have just
      // been replaced - so an edit lands in DRAFT and activation starts again.
      expect(assertConnectionTransition(state, 'EDIT')).toBe('DRAFT');
    }
  });

  it('refuses a disconnected connection until it is reconnected', () => {
    expect(() => assertConnectionTransition('DISCONNECTED', 'EDIT')).toThrow();
    expect(assertConnectionTransition('DISCONNECTED', 'RECONNECT')).toBe('DRAFT');
  });
});

describe('what a state permits', () => {
  it('carries traffic only when ACTIVE', () => {
    for (const state of CustomerErpConnectionStateValues) {
      expect(carriesTraffic(state)).toBe(state === 'ACTIVE');
    }
  });

  it('allows a call while testing but never business traffic', () => {
    // A test IS a call. It is also the only traffic that state permits.
    expect(isCallable('TESTING')).toBe(true);
    expect(carriesTraffic('TESTING')).toBe(false);
  });

  it('refuses webhooks while paused and accepts them while waiting on somebody', () => {
    // Looks inconsistent and is not: a connection somebody deliberately
    // stopped must not have its stock rewritten, and one waiting on an
    // approval is still a connection whose ERP may tell us things.
    expect(acceptsWebhooks('PAUSED')).toBe(false);
    expect(acceptsWebhooks('ACTION_REQUIRED')).toBe(true);
    expect(acceptsWebhooks('ACTIVE')).toBe(true);
    expect(acceptsWebhooks('DISCONNECTED')).toBe(false);
  });

  it('never offers a machinery-only action to a screen', () => {
    for (const state of CustomerErpConnectionStateValues) {
      const actions = availableConnectionActions(state);

      expect(actions).not.toContain('SUSPEND');
      expect(actions).not.toContain('NEEDS_ATTENTION');
      expect(actions).not.toContain('TEST_FINISHED');
    }
  });

  it('gives every state words a buyer can read', () => {
    for (const state of CustomerErpConnectionStateValues) {
      expect(connectionStateLabel(state).length).toBeGreaterThan(3);
    }
  });
});

describe('the event lifecycle', () => {
  it('has no way out of SUCCEEDED', () => {
    // The load-bearing assertion of the whole feature. An event that succeeded
    // is one whose purchase order exists in somebody's ERP; any path back to
    // QUEUED is a path to a second one.
    const actions = ['CLAIM', 'SUCCEED', 'SCHEDULE_RETRY', 'ABANDON', 'SKIP', 'REQUEUE'] as const;

    for (const action of actions) {
      expect(canPerformEventAction('SUCCEEDED', action)).toBe(false);
      expect(() => assertEventTransition('SUCCEEDED', action)).toThrow();
    }
  });

  it('lets a failed or skipped event be queued again by hand', () => {
    expect(assertEventTransition('FAILED', 'REQUEUE')).toBe('QUEUED');
    expect(assertEventTransition('SKIPPED', 'REQUEUE')).toBe('QUEUED');
  });

  it('claims only what is waiting', () => {
    expect(assertEventTransition('QUEUED', 'CLAIM')).toBe('PROCESSING');
    expect(assertEventTransition('RETRYING', 'CLAIM')).toBe('PROCESSING');

    for (const state of ['PROCESSING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const) {
      expect(() => assertEventTransition(state, 'CLAIM')).toThrow();
    }
  });

  it('can skip before anything has been attempted', () => {
    // Some skips are decided before a call is made: a paused connection, a
    // policy that switched this event type off, a refused approval.
    expect(assertEventTransition('QUEUED', 'SKIP')).toBe('SKIPPED');
  });

  it('knows which states are settled', () => {
    const settled: CustomerErpEventStateName[] = ['SUCCEEDED', 'FAILED', 'SKIPPED'];

    for (const state of CustomerErpEventStateValues) {
      expect(isEventSettled(state)).toBe(settled.includes(state));
    }
  });

  it('gives every state words a buyer can read', () => {
    for (const state of CustomerErpEventStateValues) {
      expect(eventStateLabel(state).length).toBeGreaterThan(3);
    }
  });
});

describe('the refusal messages', () => {
  it('names the current state so somebody can act on it', () => {
    let message = '';

    try {
      assertConnectionTransition('PAUSED', 'ACTIVATE');
    } catch (error) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).toContain('paused');
  });
});
