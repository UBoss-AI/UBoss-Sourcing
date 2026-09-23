/**
 * What "Connected" is allowed to mean.
 *
 * Every test in the first block is a different way of NOT being connected, and
 * each one asserts that the state is the specific word for that situation
 * rather than a generic failure. That is the whole point: "the bridge is off",
 * "Tally is closed" and "the wrong company is open" look identical from a
 * marketplace and are three different walks to the same machine, and a seller
 * told the wrong one spends an afternoon reinstalling software that was
 * running perfectly.
 */
import { describe, expect, it } from 'vitest';
import {
  HEARTBEAT_FRESH_SECONDS,
  TEST_FRESH_SECONDS,
  canDispatch,
  canQueue,
  decideConnectionState,
  isTransientFailure,
  needsSellerAction,
  retryDelaySeconds,
  type ConnectionFacts,
} from '../../src/domain/seller-erp-state.js';

const NOW = new Date('2026-09-23T12:00:00Z');

const secondsAgo = (seconds: number): Date => new Date(NOW.getTime() - seconds * 1000);

/** A fully working connection. Each test takes one thing away. */
function healthy(overrides: Partial<ConnectionFacts> = {}): ConnectionFacts {
  return {
    disabledAt: null,
    networkMode: 'BRIDGE',
    companyName: 'Acme Medical',
    hasActiveBridge: true,
    hasPendingPairing: false,
    pairingExpired: false,
    lastHeartbeatAt: secondsAgo(30),
    lastTestAt: secondsAgo(60),
    lastTestOk: true,
    tallyReachable: true,
    companyLoaded: true,
    mappingComplete: true,
    validationFailed: false,
    hasJobsInFlight: false,
    hasWarnings: false,
    now: NOW,
    ...overrides,
  };
}

describe('"Connected" is a conclusion, not a flag', () => {
  it('is reached only when all four facts hold', () => {
    expect(decideConnectionState(healthy()).state).toBe('CONNECTED');
  });

  it('is not reached when the bridge has stopped beating', () => {
    const decision = decideConnectionState(
      healthy({ lastHeartbeatAt: secondsAgo(HEARTBEAT_FRESH_SECONDS + 1) }),
    );

    // Not "disconnected". The machine is off or asleep, and that is what the
    // seller has to act on.
    expect(decision.state).toBe('BRIDGE_OFFLINE');
  });

  it('is not reached when nobody has tested recently', () => {
    const decision = decideConnectionState(
      healthy({ lastTestAt: secondsAgo(TEST_FRESH_SECONDS + 1) }),
    );

    // The honest answer is "we do not currently know Tally is there", NOT
    // "probably still fine". There is no state that means the second thing.
    expect(decision.state).toBe('TALLY_UNAVAILABLE');
  });

  it('is not reached when Tally is not answering', () => {
    expect(decideConnectionState(healthy({ lastTestOk: false })).state).toBe('TALLY_UNAVAILABLE');
  });

  it('says COMPANY_NOT_LOADED rather than a generic failure', () => {
    // THE COMMONEST REAL FAILURE, and it looks nothing like a broken
    // connection to the person standing at the machine.
    const decision = decideConnectionState(healthy({ companyLoaded: false }));

    expect(decision.state).toBe('COMPANY_NOT_LOADED');
    expect(decision.reason).toContain('not open');
  });

  it('says MAPPING_INCOMPLETE when everything talks and a ledger is unmatched', () => {
    expect(decideConnectionState(healthy({ mappingComplete: false })).state).toBe(
      'MAPPING_INCOMPLETE',
    );
  });

  it('puts a failed validation ahead of an incomplete mapping', () => {
    // Both are true at once frequently. The validation is the more specific
    // answer, and it is the one that says nothing will sync.
    const decision = decideConnectionState(
      healthy({ validationFailed: true, mappingComplete: false }),
    );

    expect(decision.state).toBe('VALIDATION_FAILED');
  });
});

describe('the states before anything is connected', () => {
  it('is NOT_CONFIGURED with nothing set up at all', () => {
    expect(
      decideConnectionState(
        healthy({ companyName: null, hasActiveBridge: false, hasPendingPairing: false }),
      ).state,
    ).toBe('NOT_CONFIGURED');
  });

  it('is BRIDGE_REQUIRED once a company is chosen and no machine is paired', () => {
    const decision = decideConnectionState(healthy({ hasActiveBridge: false }));

    expect(decision.state).toBe('BRIDGE_REQUIRED');
    expect(decision.reason).toContain('Bridge');
  });

  it('is AWAITING_PAIRING while a code is outstanding', () => {
    expect(
      decideConnectionState(healthy({ hasActiveBridge: false, hasPendingPairing: true })).state,
    ).toBe('AWAITING_PAIRING');
  });

  it('is PAIRING_EXPIRED when a code lapsed unused', () => {
    expect(
      decideConnectionState(
        healthy({ hasActiveBridge: false, hasPendingPairing: false, pairingExpired: true }),
      ).state,
    ).toBe('PAIRING_EXPIRED');
  });

  it('is NOT_CONFIGURED when the bridge is up and no company is chosen', () => {
    const decision = decideConnectionState(healthy({ companyName: null }));

    expect(decision.state).toBe('NOT_CONFIGURED');
    expect(decision.reason).toContain('Choose');
  });

  it('is DISABLED whatever else is true, when the seller switched it off', () => {
    expect(
      decideConnectionState(healthy({ disabledAt: new Date(), lastTestOk: false })).state,
    ).toBe('DISABLED');
  });
});

describe('a direct connection skips the bridge entirely', () => {
  it('needs no heartbeat', () => {
    const decision = decideConnectionState(
      healthy({ networkMode: 'DIRECT_PRIVATE', hasActiveBridge: false, lastHeartbeatAt: null }),
    );

    expect(decision.state).toBe('CONNECTED');
  });

  it('asks Tally the same questions, and answers them the same way', () => {
    // The only thing that differs between the two modes is how the question
    // travels. A direct connection and a bridged one must not be able to
    // disagree about whether the company is open.
    const decision = decideConnectionState(
      healthy({ networkMode: 'DIRECT_PRIVATE', hasActiveBridge: false, companyLoaded: false }),
    );

    expect(decision.state).toBe('COMPANY_NOT_LOADED');
  });
});

describe('the busy and warning states', () => {
  it('is SYNCING while work is in flight', () => {
    expect(decideConnectionState(healthy({ hasJobsInFlight: true })).state).toBe('SYNCING');
  });

  it('is CONNECTED_WITH_WARNINGS when something non-urgent wants attention', () => {
    expect(decideConnectionState(healthy({ hasWarnings: true })).state).toBe(
      'CONNECTED_WITH_WARNINGS',
    );
  });
});

describe('dispatching and queueing are different questions', () => {
  it('dispatches only from the three states where a post would land', () => {
    expect(canDispatch('CONNECTED')).toBe(true);
    expect(canDispatch('SYNCING')).toBe(true);
    expect(canDispatch('CONNECTED_WITH_WARNINGS')).toBe(true);

    // Not from here. A voucher posted against a missing ledger is refused by
    // Tally, and eight retries of a refusal is noise rather than resilience.
    expect(canDispatch('MAPPING_INCOMPLETE')).toBe(false);
    expect(canDispatch('BRIDGE_OFFLINE')).toBe(false);
    expect(canDispatch('DISABLED')).toBe(false);
  });

  it('queues from almost everywhere, which is the whole point of a queue', () => {
    // An order confirmed at two in the morning, while the seller's PC is off,
    // must still produce a job. Refusing to queue would lose the event
    // entirely: nothing comes back later to ask whether it was recorded.
    expect(canQueue('BRIDGE_OFFLINE')).toBe(true);
    expect(canQueue('TALLY_UNAVAILABLE')).toBe(true);
    expect(canQueue('MAPPING_INCOMPLETE')).toBe(true);
    expect(canQueue('COMPANY_NOT_LOADED')).toBe(true);

    // Only these two refuse.
    expect(canQueue('DISABLED')).toBe(false);
    expect(canQueue('NOT_CONFIGURED')).toBe(false);
  });

  it('names the states a seller has to act on', () => {
    expect(needsSellerAction('BRIDGE_OFFLINE')).toBe(true);
    expect(needsSellerAction('COMPANY_NOT_LOADED')).toBe(true);
    expect(needsSellerAction('MAPPING_INCOMPLETE')).toBe(true);

    // Nothing to do about these.
    expect(needsSellerAction('CONNECTED')).toBe(false);
    expect(needsSellerAction('SYNCING')).toBe(false);
    expect(needsSellerAction('DISABLED')).toBe(false);
  });
});

describe('retries', () => {
  it('backs off exponentially', () => {
    // `random: () => 1` takes the top of each window, which is what makes the
    // growth visible without the jitter hiding it.
    const at = (attempt: number): number =>
      retryDelaySeconds({ attemptCount: attempt, baseSeconds: 30, random: () => 1 });

    expect(at(1)).toBe(30);
    expect(at(2)).toBe(60);
    expect(at(3)).toBe(120);
    expect(at(4)).toBe(240);
  });

  it('caps at an hour, so a fixed mapping is not waited out until the afternoon', () => {
    expect(retryDelaySeconds({ attemptCount: 20, baseSeconds: 30, random: () => 1 })).toBe(3600);
  });

  it('never comes back faster than the base', () => {
    // A "retry" that returns in under a second is a retry storm with extra
    // steps.
    expect(retryDelaySeconds({ attemptCount: 5, baseSeconds: 30, random: () => 0 })).toBe(30);
  });

  it('jitters across the whole window rather than wobbling around it', () => {
    // Every one of a seller's queued jobs failed at the same instant when
    // their machine slept. Without FULL jitter all forty come back together
    // and fail together for ever - a small wobble still leaves the herd a herd.
    const low = retryDelaySeconds({ attemptCount: 6, baseSeconds: 30, random: () => 0.01 });
    const high = retryDelaySeconds({ attemptCount: 6, baseSeconds: 30, random: () => 0.99 });

    expect(high - low).toBeGreaterThan(500);
  });
});

describe('which failures come back on their own', () => {
  it('treats a failure of the CONNECTION as transient', () => {
    expect(isTransientFailure('SELLER_ERP_BRIDGE_UNAVAILABLE')).toBe(true);
    expect(isTransientFailure('SELLER_ERP_COMPANY_NOT_LOADED')).toBe(true);
    expect(isTransientFailure('TIMEOUT')).toBe(true);
    expect(isTransientFailure('LEASE_EXPIRED')).toBe(true);
  });

  it('treats a failure of the CONTENT as permanent', () => {
    // Tally saying a ledger does not exist will say it for ever, until a
    // person maps it. Eight goes at a refusal is noise that delays the moment
    // somebody is told.
    expect(isTransientFailure('SELLER_ERP_TALLY_REJECTED')).toBe(false);
    expect(isTransientFailure('SELLER_ERP_MAPPING_INCOMPLETE')).toBe(false);
    expect(isTransientFailure('PAYLOAD_BUILD_FAILED')).toBe(false);
    expect(isTransientFailure('UNKNOWN')).toBe(false);
  });
});
