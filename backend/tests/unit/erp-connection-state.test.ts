/**
 * The connection state machine.
 *
 * Two transitions carry real weight and the rest exist to make those two
 * unambiguous:
 *
 *   CONNECTED -> ACTIVE is the only way a customer's orders ever start flowing
 *   to their ERP. If it were reachable from DRAFT or ERROR, somebody could
 *   change a base URL and have the next paid order posted to the new address
 *   without a single successful request having been made to it.
 *
 *   EDIT lands back in DRAFT from wherever it started. Whatever the last test
 *   proved, it proved about settings that have just been replaced.
 *
 * These are cheap tests of a pure module, which is exactly why the machine is a
 * pure module: the same table decides what the API accepts and what buttons the
 * screen offers, so the two cannot drift.
 */
import { describe, expect, it } from 'vitest';
import {
  ErpConnectionStatusValues,
  assertErpTransition,
  availableActions,
  canPerform,
  carriesTraffic,
  isCallable,
  statusLabel,
} from '../../src/domain/erp-connection-state.js';

describe('activation', () => {
  it('is reachable only from CONNECTED', () => {
    expect(assertErpTransition('CONNECTED', 'ACTIVATE')).toBe('ACTIVE');

    for (const status of ErpConnectionStatusValues) {
      if (status === 'CONNECTED') continue;

      expect(() => assertErpTransition(status, 'ACTIVATE')).toThrowError(
        /test the connection successfully/i,
      );
    }
  });

  it('refuses from DRAFT, which is where an untested connection sits', () => {
    // The case this rule exists for. A DRAFT connection has never answered a
    // request, and activating one would send a customer's paid orders into the
    // dark.
    expect(() => assertErpTransition('DRAFT', 'ACTIVATE')).toThrowError(/currently a draft/i);
  });

  it('refuses from ERROR, where the last thing that happened was a failure', () => {
    expect(() => assertErpTransition('ERROR', 'ACTIVATE')).toThrowError(
      /out of service after repeated failures/i,
    );
  });
});

describe('testing', () => {
  it('can be started from any state except a test already running', () => {
    for (const status of ['DRAFT', 'CONNECTED', 'ACTIVE', 'PAUSED', 'ERROR'] as const) {
      expect(assertErpTransition(status, 'START_TEST')).toBe('TESTING');
    }

    // One at a time. Two tabs pressing the button together would otherwise
    // race, and the loser would overwrite the winner's result.
    expect(() => assertErpTransition('TESTING', 'START_TEST')).toThrowError(/already running/i);
  });

  it('lands in CONNECTED on success and ERROR on failure', () => {
    expect(assertErpTransition('TESTING', 'TEST_PASSED')).toBe('CONNECTED');
    // ERROR rather than back where it started, so the list screen shows the
    // problem rather than a connection that looks fine and silently is not.
    expect(assertErpTransition('TESTING', 'TEST_FAILED')).toBe('ERROR');
  });

  it('cannot report a result for a test that was never started', () => {
    expect(() => assertErpTransition('ACTIVE', 'TEST_PASSED')).toThrowError(/not currently being tested/i);
  });
});

describe('pause and resume', () => {
  it('pauses only what is running, and resumes only what is paused', () => {
    expect(assertErpTransition('ACTIVE', 'PAUSE')).toBe('PAUSED');
    expect(assertErpTransition('PAUSED', 'RESUME')).toBe('ACTIVE');

    expect(() => assertErpTransition('PAUSED', 'PAUSE')).toThrowError(/switched on can be paused/i);
    expect(() => assertErpTransition('ACTIVE', 'RESUME')).toThrowError(/paused connection/i);
  });

  it('keeps PAUSED and DISABLED apart', () => {
    // Pause is "stop for now" and needs no re-test to undo. Disable is "stop,
    // and I am not coming back soon" - reopening goes through DRAFT, and
    // therefore through a test, like any other cold start.
    expect(assertErpTransition('PAUSED', 'RESUME')).toBe('ACTIVE');
    expect(assertErpTransition('DISABLED', 'REOPEN')).toBe('DRAFT');
    expect(() => assertErpTransition('DISABLED', 'RESUME')).toThrowError();
  });

  it('lets nothing but REOPEN out of DISABLED', () => {
    for (const action of ['ACTIVATE', 'PAUSE', 'RESUME', 'START_TEST', 'EDIT'] as const) {
      expect(canPerform('DISABLED', action)).toBe(false);
    }

    expect(canPerform('DISABLED', 'REOPEN')).toBe(true);
  });
});

describe('suspension by the machinery', () => {
  it('takes a live connection out of service', () => {
    expect(assertErpTransition('ACTIVE', 'SUSPEND')).toBe('ERROR');
  });

  it('will not report a deliberately stopped connection as broken', () => {
    // A customer who paused their connection has not got a fault, and telling
    // them they have would be noise about a decision they made.
    expect(() => assertErpTransition('PAUSED', 'SUSPEND')).toThrowError();
    expect(() => assertErpTransition('DISABLED', 'SUSPEND')).toThrowError();
  });
});

describe('editing', () => {
  it('drops the connection back to DRAFT from anywhere it is editable', () => {
    for (const status of ['DRAFT', 'TESTING', 'CONNECTED', 'ACTIVE', 'PAUSED', 'ERROR'] as const) {
      expect(assertErpTransition(status, 'EDIT')).toBe('DRAFT');
    }
  });

  it('is refused on a switched-off connection', () => {
    expect(() => assertErpTransition('DISABLED', 'EDIT')).toThrowError(/reopened/i);
  });
});

describe('what a status permits', () => {
  it('lets only ACTIVE carry business traffic', () => {
    for (const status of ErpConnectionStatusValues) {
      expect(carriesTraffic(status)).toBe(status === 'ACTIVE');
    }
  });

  it('lets TESTING be called but not carry traffic', () => {
    // A test IS a call, and it is the only traffic that status permits. An
    // order must never go down a connection that is mid-test.
    expect(isCallable('TESTING')).toBe(true);
    expect(carriesTraffic('TESTING')).toBe(false);
  });

  it('refuses every call on a paused, errored or disabled connection', () => {
    for (const status of ['PAUSED', 'ERROR', 'DISABLED', 'DRAFT'] as const) {
      expect(isCallable(status)).toBe(false);
    }
  });
});

describe('what the screen renders', () => {
  it('offers exactly the actions the machine would accept', () => {
    for (const status of ErpConnectionStatusValues) {
      for (const action of availableActions(status)) {
        // The property that keeps the buttons and the API in step: anything
        // offered must be accepted.
        expect(() => assertErpTransition(status, action)).not.toThrow();
      }
    }
  });

  it('has words for every status, so no error message says "undefined"', () => {
    for (const status of ErpConnectionStatusValues) {
      expect(statusLabel(status)).toMatch(/\w/);
    }
  });
});
