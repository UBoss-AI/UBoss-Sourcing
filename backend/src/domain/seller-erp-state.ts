/**
 * What a seller's Tally connection is actually doing, decided from facts.
 *
 * THE RULE THIS FILE ENFORCES
 *
 * "Connected" is not a stored flag that somebody sets. It is a CONCLUSION,
 * reached here, from four things that each have a timestamp:
 *
 *   - a bridge heartbeat inside the freshness window,
 *   - a connection test that passed, recently enough to still mean something,
 *   - the configured company present in what that test found open,
 *   - every mapping a sync would need, confirmed.
 *
 * Take away any one and the state is a different word with a different
 * instruction beside it. There is no branch that produces `CONNECTED` because
 * nothing has gone wrong lately; a connection nobody has tested is
 * `BRIDGE_OFFLINE` or worse, never "probably fine".
 *
 * WHY THE STATES ARE SO MANY
 *
 * Because each one is a different thing for the seller to DO, and collapsing
 * any two of them wastes somebody's afternoon:
 *
 *   BRIDGE_OFFLINE      their machine is off, or the agent stopped.
 *   TALLY_UNAVAILABLE   the machine is on; TallyPrime is closed.
 *   COMPANY_NOT_LOADED  Tally is open; the right company is not.
 *   MAPPING_INCOMPLETE  everything talks; a ledger has not been chosen.
 *
 * The third is the commonest real failure and looks nothing like a broken
 * connection to the person standing at the machine. Told "disconnected", they
 * reinstall an agent that was running perfectly.
 */

export type SellerErpState =
  | 'NOT_CONFIGURED'
  | 'BRIDGE_REQUIRED'
  | 'AWAITING_PAIRING'
  | 'BRIDGE_OFFLINE'
  | 'TALLY_UNAVAILABLE'
  | 'COMPANY_NOT_LOADED'
  | 'MAPPING_INCOMPLETE'
  | 'VALIDATION_FAILED'
  | 'CONNECTED'
  | 'SYNCING'
  | 'CONNECTED_WITH_WARNINGS'
  | 'PAIRING_EXPIRED'
  | 'DISABLED';

/**
 * How long a heartbeat means the bridge is alive.
 *
 * The agent beats every 60 seconds. Three minutes tolerates two missed beats
 * and a slow network without letting a machine that was switched off at five
 * o'clock still read as online at six. A seller watching the screen after
 * closing their laptop sees it go offline inside the time it takes to make
 * tea, which is the point: a status that lags reality is a status nobody
 * trusts.
 */
export const HEARTBEAT_FRESH_SECONDS = 180;

/**
 * How long a passing test stays evidence.
 *
 * Fifteen minutes. Long enough that the screen does not re-test on every
 * refresh; short enough that "Connected" never describes a company somebody
 * closed in Tally over lunch. Beyond it the connection is not reported as
 * broken - it is reported as needing a test, which is the honest distinction.
 */
export const TEST_FRESH_SECONDS = 900;

/** Everything the decision is made from. Facts, all of them with a time. */
export interface ConnectionFacts {
  /** Set only when the seller deliberately switched it off. */
  disabledAt: Date | null;
  networkMode: 'BRIDGE' | 'DIRECT_PRIVATE';
  /** Has a company actually been chosen? */
  companyName: string | null;
  /** Is there a paired device that has not been revoked? */
  hasActiveBridge: boolean;
  /** Is a pairing code outstanding and still valid? */
  hasPendingPairing: boolean;
  /** Did a pairing code lapse unused, or was a token revoked? */
  pairingExpired: boolean;
  lastHeartbeatAt: Date | null;
  lastTestAt: Date | null;
  lastTestOk: boolean;
  /** Did the last test find Tally answering at all? */
  tallyReachable: boolean;
  /** Did the last test find the CONFIGURED company among the open ones? */
  companyLoaded: boolean;
  /** Every mapping a switched-on sync would need, confirmed. */
  mappingComplete: boolean;
  /** The last validation run found something that would post wrongly. */
  validationFailed: boolean;
  /** Jobs in flight right now. */
  hasJobsInFlight: boolean;
  /** Something non-blocking wants attention. */
  hasWarnings: boolean;
  now: Date;
}

function isFresh(at: Date | null, seconds: number, now: Date): boolean {
  if (at === null) return false;
  return now.getTime() - at.getTime() <= seconds * 1000;
}

/**
 * The state, and a sentence saying why.
 *
 * The reason is English. Each frontend maps the STATE to its own translated
 * wording; this string is for the API's fallback, for a log, and for a
 * deployment reading the database directly. Nothing renders it to a seller who
 * has a language set.
 */
export interface StateDecision {
  state: SellerErpState;
  reason: string;
}

/**
 * Decide, in one pass, with the most specific answer winning.
 *
 * The order is the whole of the logic and it runs from "nothing exists" to
 * "everything works". Each branch is a thing that makes every branch below it
 * unanswerable: there is no point asking whether the mappings are complete
 * when the bridge has not phoned home for an hour, because nothing has been
 * able to check them.
 */
export function decideConnectionState(facts: ConnectionFacts): StateDecision {
  if (facts.disabledAt !== null) {
    return { state: 'DISABLED', reason: 'Switched off by the seller.' };
  }

  /*
   * A direct connection has no bridge, and everything about a bridge is
   * skipped for it.
   *
   * It exists for one deployment shape - the marketplace running inside the
   * same private network as the seller's Tally, on hosts the operator
   * controls - and it is never the default and never offered as a way to avoid
   * installing the agent. See the schema's note on `SellerErpNetworkMode`.
   */
  if (facts.networkMode === 'DIRECT_PRIVATE') {
    if (facts.companyName === null) {
      return { state: 'NOT_CONFIGURED', reason: 'No company has been chosen yet.' };
    }
    return decideFromTest(facts);
  }

  if (facts.companyName === null && !facts.hasActiveBridge && !facts.hasPendingPairing) {
    return { state: 'NOT_CONFIGURED', reason: 'Nothing has been set up yet.' };
  }

  if (facts.pairingExpired && !facts.hasActiveBridge) {
    return {
      state: 'PAIRING_EXPIRED',
      reason: 'The pairing code or the bridge token is no longer valid. Pair the machine again.',
    };
  }

  if (facts.hasPendingPairing && !facts.hasActiveBridge) {
    return {
      state: 'AWAITING_PAIRING',
      reason: 'A pairing code has been issued and the bridge has not used it yet.',
    };
  }

  if (!facts.hasActiveBridge) {
    return {
      state: 'BRIDGE_REQUIRED',
      reason: 'Install the Glovia Tally Bridge on the machine that runs TallyPrime, then pair it.',
    };
  }

  if (!isFresh(facts.lastHeartbeatAt, HEARTBEAT_FRESH_SECONDS, facts.now)) {
    return {
      state: 'BRIDGE_OFFLINE',
      reason:
        'The bridge has not checked in. The machine may be switched off, asleep, or the agent may have stopped.',
    };
  }

  if (facts.companyName === null) {
    return {
      state: 'NOT_CONFIGURED',
      reason: 'The bridge is connected. Choose which Tally company to use.',
    };
  }

  return decideFromTest(facts);
}

/**
 * The half of the decision that is about Tally rather than about the bridge.
 *
 * Shared by both network modes deliberately: a direct connection and a bridged
 * one ask Tally exactly the same questions and must not answer them
 * differently. The only thing that differs is how the question travels.
 */
function decideFromTest(facts: ConnectionFacts): StateDecision {
  if (!isFresh(facts.lastTestAt, TEST_FRESH_SECONDS, facts.now)) {
    /*
     * No recent test. NOT reported as connected, and not reported as broken.
     *
     * `TALLY_UNAVAILABLE` is the honest answer: we do not currently know that
     * Tally is there. A state that meant "probably still fine" is exactly the
     * lie this module exists to refuse - and the screen's wording for it asks
     * the seller to test rather than telling them something is wrong.
     */
    return {
      state: 'TALLY_UNAVAILABLE',
      reason: 'No recent connection test. Run one to confirm TallyPrime is answering.',
    };
  }

  if (!facts.lastTestOk || !facts.tallyReachable) {
    return {
      state: 'TALLY_UNAVAILABLE',
      reason: 'TallyPrime is not answering on the machine the bridge is running on.',
    };
  }

  if (!facts.companyLoaded) {
    return {
      state: 'COMPANY_NOT_LOADED',
      reason: 'TallyPrime is running, and the company this connection uses is not open in it.',
    };
  }

  if (facts.validationFailed) {
    return {
      state: 'VALIDATION_FAILED',
      reason: 'The last validation found something that would post incorrectly. Nothing will sync until it is fixed.',
    };
  }

  if (!facts.mappingComplete) {
    return {
      state: 'MAPPING_INCOMPLETE',
      reason: 'Everything is talking. Some ledgers or items still need matching to Tally.',
    };
  }

  if (facts.hasJobsInFlight) {
    return { state: 'SYNCING', reason: 'Work is being sent to Tally right now.' };
  }

  if (facts.hasWarnings) {
    return {
      state: 'CONNECTED_WITH_WARNINGS',
      reason: 'Connected. Something non-urgent needs attention.',
    };
  }

  return { state: 'CONNECTED', reason: 'Connected to TallyPrime.' };
}

/**
 * May work actually be sent in this state?
 *
 * Only three of the thirteen, and the list is short on purpose. Every other
 * state means something a post would depend on is unknown or wrong, and
 * queueing against it produces a pile of dead-lettered jobs rather than an
 * error somebody can act on.
 *
 * `MAPPING_INCOMPLETE` is deliberately NOT here even though the bridge would
 * accept the task: a voucher posted against a missing ledger is refused by
 * Tally, and eight retries of a refusal is noise rather than resilience.
 */
export function canDispatch(state: SellerErpState): boolean {
  return state === 'CONNECTED' || state === 'SYNCING' || state === 'CONNECTED_WITH_WARNINGS';
}

/**
 * May an event be QUEUED in this state?
 *
 * Far more permissive than `canDispatch`, and the difference is the feature.
 * An order confirmed at two in the morning, while the seller's PC is off, must
 * still produce a job - it is queued, it waits, and it posts when the bridge
 * comes back. Refusing to queue would lose the event entirely, because nothing
 * comes back later to ask whether that order was ever recorded.
 *
 * Only a connection somebody switched off, or one that was never set up,
 * refuses to queue.
 */
export function canQueue(state: SellerErpState): boolean {
  return state !== 'DISABLED' && state !== 'NOT_CONFIGURED';
}

/** Is this a state the seller has to do something about? */
export function needsSellerAction(state: SellerErpState): boolean {
  return (
    state === 'BRIDGE_REQUIRED' ||
    state === 'BRIDGE_OFFLINE' ||
    state === 'TALLY_UNAVAILABLE' ||
    state === 'COMPANY_NOT_LOADED' ||
    state === 'MAPPING_INCOMPLETE' ||
    state === 'VALIDATION_FAILED' ||
    state === 'PAIRING_EXPIRED'
  );
}

// ---------------------------------------------------------------------------
// Retries
// ---------------------------------------------------------------------------

/**
 * How long before trying a failed job again.
 *
 * Exponential, capped, with jitter. Each part earns its place:
 *
 *   - **Exponential**, because a Tally that refused once because the company
 *     was closed will refuse the next nine times in the same second.
 *   - **Capped** at an hour, because a seller who fixes a ledger at nine
 *     should not wait until the afternoon for the backlog to move.
 *   - **Jittered**, because every one of a seller's queued jobs failed at the
 *     same instant when their machine went to sleep, and without jitter all
 *     forty come back together and fail together for ever.
 *
 * The jitter is full - a uniform draw across the whole window rather than a
 * small wobble around it. A small wobble still leaves the herd recognisably a
 * herd.
 */
export function retryDelaySeconds(input: {
  attemptCount: number;
  baseSeconds: number;
  /** Injectable so a test is deterministic. Defaults to `Math.random`. */
  random?: () => number;
}): number {
  const MAX_SECONDS = 3600;
  const random = input.random ?? Math.random;

  const exponent = Math.min(Math.max(0, input.attemptCount - 1), 12);
  const window = Math.min(MAX_SECONDS, Math.max(1, input.baseSeconds) * 2 ** exponent);

  // At least the base: a "retry" that comes back in under a second is a
  // retry storm with extra steps.
  return Math.max(input.baseSeconds, Math.round(random() * window));
}

/**
 * Is this failure one that could pass on its own?
 *
 * The distinction decides whether a job is retried or handed to a person, and
 * getting it wrong is expensive in both directions. Retrying a permanent
 * failure eight times delays the moment somebody is told; NOT retrying a
 * transient one loses the sale from the seller's books until they notice.
 *
 * So the rule is: a failure of the CONNECTION is transient, a failure of the
 * CONTENT is not. Tally being closed is transient. Tally saying the ledger
 * does not exist is not - it will say the same thing for ever, until a person
 * maps it, and the job's place is the failed list where they will see it.
 */
export function isTransientFailure(code: string): boolean {
  return (
    code === 'SELLER_ERP_BRIDGE_UNAVAILABLE' ||
    code === 'SELLER_ERP_COMPANY_NOT_LOADED' ||
    code === 'TIMEOUT' ||
    code === 'NETWORK' ||
    code === 'LEASE_EXPIRED' ||
    code === 'SERVICE_UNAVAILABLE'
  );
}
