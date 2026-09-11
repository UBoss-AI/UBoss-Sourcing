/**
 * The two state machines behind a buyer's own ERP integration.
 *
 * Same rule as `order-state-machine.ts`, `schedule-state.ts` and
 * `erp-connection-state.ts`, and it is not a stylistic preference: **no service
 * writes `state` on a `customer_erp_connections` or `customer_erp_sync_events`
 * row.** Every change comes through one of the two assertions below, so the
 * buttons a screen offers and the moves the API permits are derived from one
 * table instead of two that drift apart over a year.
 *
 * It matters more here than in most places, because these states decide whether
 * somebody else's purchase orders get raised and whether somebody else's stock
 * figures get written. An event that moved from FAILED to QUEUED by an
 * `update()` nobody reviewed is a duplicate purchase order waiting to happen.
 *
 * WHY THERE IS NO "CONNECTED" STATE
 *
 * The seller-side machine next door has one, sitting between TESTING and
 * ACTIVE, to mean "tested and ready, not yet switched on". This one does not,
 * and the reason is that a buyer's connection accumulates readiness in pieces
 * rather than all at once: the credentials work, and then the mapping is
 * checked, and then a dry run is looked at. Those are three facts recorded in
 * three columns (`lastTestOk`, `mappingVerifiedAt`, and the endpoints
 * themselves), not one status. Modelling "ready" as a state would mean deciding
 * which of the three earns it.
 *
 * So the setup path is DRAFT -> TESTING -> DRAFT, as many times as it takes,
 * and ACTIVATE is refused out of DRAFT until all three facts hold - see
 * `assertReadyToActivate`, which is where the refusal names the missing one.
 *
 * ACTION_REQUIRED AND FAILED ARE DIFFERENT THINGS
 *
 * ACTION_REQUIRED means the connection is fine and is waiting for a person: a
 * refresh token that expired, an approval nobody has decided, a mapping the ERP
 * has started rejecting. FAILED means repeated failures took it out of service
 * and nobody chose that. A buyer reads the two very differently and so does
 * support, which is why one enum member would have been cheaper and wrong.
 */
import { ErrorCode, conflict } from './errors.js';

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export const CustomerErpConnectionStateValues = [
  'DRAFT',
  'TESTING',
  'ACTIVE',
  'PAUSED',
  'ACTION_REQUIRED',
  'FAILED',
  'DISCONNECTED',
] as const;

export type CustomerErpConnectionStateName =
  (typeof CustomerErpConnectionStateValues)[number];

/**
 * What a caller is asking to do, rather than which state it wants.
 *
 * Named for the button because two actions can land on the same state for
 * entirely different reasons - RESUME and RECONNECT both reach ACTIVE - and
 * "why was this allowed" is a question the audit trail has to answer.
 */
export type CustomerErpConnectionAction =
  | 'EDIT'
  | 'START_TEST'
  | 'TEST_FINISHED'
  | 'ACTIVATE'
  | 'PAUSE'
  | 'RESUME'
  | 'NEEDS_ATTENTION'
  | 'RESOLVE_ATTENTION'
  | 'SUSPEND'
  | 'RECONNECT'
  | 'DISCONNECT';

interface ConnectionRule {
  from: readonly CustomerErpConnectionStateName[];
  to: CustomerErpConnectionStateName;
  /** Shown when the current state is not in `from`. */
  refusal: string;
}

/**
 * Every legal move, and the ones deliberately missing.
 *
 * Absent on purpose:
 *
 *   - START_TEST from TESTING. One test at a time per connection. Two tabs
 *     pressing the button together would otherwise race, and the loser would
 *     write its result over the winner's.
 *   - ACTIVATE from TESTING. A test in flight has not finished; activating
 *     on the strength of one that has not come back yet is activating on hope.
 *   - Anything but RECONNECT out of DISCONNECTED. A disconnected connection has
 *     had its credentials destroyed, so it cannot quietly start carrying
 *     traffic again - it has to be set up, and RECONNECT lands it in DRAFT
 *     where setting up happens.
 *   - PAUSE from FAILED or ACTION_REQUIRED. Neither is running, so there is
 *     nothing to pause; offering the button would suggest otherwise.
 */
const CONNECTION_RULES: Readonly<
  Record<CustomerErpConnectionAction, ConnectionRule>
> = Object.freeze({
  /**
   * Editing configuration. Lands back in DRAFT from wherever it was, because
   * whatever the last test proved, it proved about settings that have just
   * been replaced. That is also what stops a live connection being edited
   * underneath the traffic it is carrying: the edit takes it out of ACTIVE,
   * and switching it on again is a deliberate second act.
   */
  EDIT: {
    from: ['DRAFT', 'TESTING', 'ACTIVE', 'PAUSED', 'ACTION_REQUIRED', 'FAILED'],
    to: 'DRAFT',
    refusal: 'A disconnected connection has to be reconnected before it can be edited.',
  },
  START_TEST: {
    from: ['DRAFT', 'ACTIVE', 'PAUSED', 'ACTION_REQUIRED', 'FAILED'],
    to: 'TESTING',
    refusal: 'A test is already running for this connection.',
  },
  /**
   * A test came back, pass or fail. The OUTCOME is recorded in `lastTestOk`,
   * not in the state: a failed test leaves a draft a draft, which is what it
   * is. Marking it FAILED would say repeated failures took a working
   * connection out of service, and nothing of the sort happened.
   */
  TEST_FINISHED: {
    from: ['TESTING'],
    to: 'DRAFT',
    refusal: 'This connection is not currently being tested.',
  },
  ACTIVATE: {
    from: ['DRAFT'],
    to: 'ACTIVE',
    refusal: 'Only a connection that has been set up and tested can be switched on.',
  },
  PAUSE: {
    from: ['ACTIVE'],
    to: 'PAUSED',
    refusal: 'Only a connection that is switched on can be paused.',
  },
  RESUME: {
    from: ['PAUSED'],
    to: 'ACTIVE',
    refusal: 'Only a paused connection can be resumed.',
  },
  /// Something needs a person. Entered by the machinery; not a button.
  NEEDS_ATTENTION: {
    from: ['ACTIVE', 'TESTING', 'PAUSED'],
    to: 'ACTION_REQUIRED',
    refusal: 'This connection is not in service.',
  },
  /// The person dealt with it - reauthorised, approved, remapped.
  RESOLVE_ATTENTION: {
    from: ['ACTION_REQUIRED'],
    to: 'ACTIVE',
    refusal: 'Nothing is currently waiting on this connection.',
  },
  /// Repeated failures. Entered by the machinery; not a button either.
  SUSPEND: {
    from: ['ACTIVE', 'TESTING', 'ACTION_REQUIRED'],
    to: 'FAILED',
    refusal: 'This connection is not in service.',
  },
  /**
   * Recovering a FAILED or DISCONNECTED connection. Lands in DRAFT rather than
   * ACTIVE, deliberately: coming back from the dead goes through the same door
   * as arriving for the first time, so "it is broken" and "it has never
   * worked" are fixed the same way and neither has a shortcut.
   */
  RECONNECT: {
    from: ['FAILED', 'DISCONNECTED', 'ACTION_REQUIRED'],
    to: 'DRAFT',
    refusal: 'This connection does not need reconnecting.',
  },
  DISCONNECT: {
    from: ['DRAFT', 'TESTING', 'ACTIVE', 'PAUSED', 'ACTION_REQUIRED', 'FAILED'],
    to: 'DISCONNECTED',
    refusal: 'This connection is already disconnected.',
  },
});

/**
 * The state a connection ends in after `action`, or a 409 explaining why not.
 *
 * Callers use the return value. Nothing derives a state any other way.
 */
export function assertConnectionTransition(
  current: CustomerErpConnectionStateName,
  action: CustomerErpConnectionAction,
): CustomerErpConnectionStateName {
  const rule = CONNECTION_RULES[action];

  if (!rule.from.includes(current)) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_STATE_INVALID,
      `${rule.refusal} It is currently ${connectionStateLabel(current)}.`,
    );
  }

  return rule.to;
}

/** Whether an action is available, for rendering buttons rather than guarding. */
export function canPerformConnectionAction(
  current: CustomerErpConnectionStateName,
  action: CustomerErpConnectionAction,
): boolean {
  return CONNECTION_RULES[action].from.includes(current);
}

/**
 * Every action available from a state, for the screen to render.
 *
 * The machinery-only moves are filtered out: a screen that offered "Suspend"
 * would be offering to break something on purpose, and NEEDS_ATTENTION is not
 * a decision anybody makes.
 */
export function availableConnectionActions(
  current: CustomerErpConnectionStateName,
): CustomerErpConnectionAction[] {
  const machineryOnly = new Set<CustomerErpConnectionAction>([
    'NEEDS_ATTENTION',
    'SUSPEND',
    'TEST_FINISHED',
  ]);

  return (Object.keys(CONNECTION_RULES) as CustomerErpConnectionAction[]).filter(
    (action) => !machineryOnly.has(action) && canPerformConnectionAction(current, action),
  );
}

/**
 * Whether the connection may be called at all right now.
 *
 * TESTING is deliberately true: a test IS a call, and it is the only traffic
 * that state permits.
 */
export function isCallable(current: CustomerErpConnectionStateName): boolean {
  return current === 'ACTIVE' || current === 'TESTING';
}

/**
 * Whether the connection carries business traffic - purchase orders, goods
 * receipts, invoices, scheduled polls.
 *
 * Narrower than `isCallable`, and the distinction is the entire point of
 * having both: a connection being tested may be called, and an order must
 * never be pushed down it. This is also the single question that makes
 * "pausing stops automatic writes" true - see `dispatchEvent`, which asks it
 * before every attempt rather than only when the event was queued.
 */
export function carriesTraffic(current: CustomerErpConnectionStateName): boolean {
  return current === 'ACTIVE';
}

/**
 * Whether inbound webhooks are accepted.
 *
 * ACTION_REQUIRED is true and PAUSED is false, which is worth stating because
 * it looks inconsistent and is not. A connection waiting on an approval is
 * still a connection whose ERP is entitled to tell us things; one somebody
 * deliberately paused is not, because accepting stock updates for a connection
 * that was stopped on purpose is the opposite of what pausing means.
 */
export function acceptsWebhooks(current: CustomerErpConnectionStateName): boolean {
  return current === 'ACTIVE' || current === 'ACTION_REQUIRED';
}

/** Words for a state, for a message a buyer reads. */
export function connectionStateLabel(state: CustomerErpConnectionStateName): string {
  switch (state) {
    case 'DRAFT':
      return 'a draft';
    case 'TESTING':
      return 'being tested';
    case 'ACTIVE':
      return 'switched on';
    case 'PAUSED':
      return 'paused';
    case 'ACTION_REQUIRED':
      return 'waiting for someone to act';
    case 'FAILED':
      return 'out of service after repeated failures';
    case 'DISCONNECTED':
      return 'disconnected';
  }
}

/**
 * The three facts a connection needs before it may be switched on, checked
 * together so the refusal can name the one that is missing.
 *
 * Kept here rather than in the service because it is the other half of the
 * ACTIVATE rule above: the state machine says which states may activate, this
 * says what has to be true of the row. Splitting the two across files is how a
 * connection ends up activatable through one path and not another.
 */
export interface ActivationReadiness {
  lastTestOk: boolean | null;
  mappingVerifiedAt: Date | null;
  /** Whether an endpoint exists for everything the policy says will be sent. */
  missingEndpoints: readonly string[];
}

export function assertReadyToActivate(readiness: ActivationReadiness): void {
  if (readiness.lastTestOk !== true) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_UNTESTED,
      'Run Test connection and get a pass before switching this on. A connection that ' +
        'has never answered cannot carry your purchase orders.',
    );
  }

  if (readiness.mappingVerifiedAt === null) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_MAPPING_UNVERIFIED,
      'Check the field mapping against a real response first. A mapping that only ' +
        'validates structurally is still a guess about your own data.',
    );
  }

  if (readiness.missingEndpoints.length > 0) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_ENDPOINT_MISSING,
      `Your sync rules send ${readiness.missingEndpoints.join(', ')}, but no endpoint is ` +
        'configured for that. Add the endpoint or switch that off in Sync rules.',
    );
  }
}

// ---------------------------------------------------------------------------
// Event state
// ---------------------------------------------------------------------------

export const CustomerErpEventStateValues = [
  'QUEUED',
  'PROCESSING',
  'SUCCEEDED',
  'RETRYING',
  'FAILED',
  'SKIPPED',
] as const;

export type CustomerErpEventStateName = (typeof CustomerErpEventStateValues)[number];

export type CustomerErpEventAction =
  | 'CLAIM'
  | 'SUCCEED'
  | 'SCHEDULE_RETRY'
  | 'ABANDON'
  | 'SKIP'
  | 'REQUEUE';

interface EventRule {
  from: readonly CustomerErpEventStateName[];
  to: CustomerErpEventStateName;
  refusal: string;
}

/**
 * The event lifecycle.
 *
 * SUCCEEDED is terminal and has no way out, and that is the load-bearing
 * property of this whole feature. An event that succeeded is one whose
 * purchase order exists in somebody's ERP; a path back to QUEUED would be a
 * path to a second one. A genuinely new thing to say about the same order is a
 * new event with a higher `eventVersion` and therefore a different idempotency
 * key - never this row again.
 *
 * REQUEUE out of FAILED and SKIPPED is the manual retry, and it deliberately
 * reuses the SAME row and the SAME idempotency key. That is what makes
 * pressing Retry safe: if the earlier attempt in fact reached the ERP, the
 * ERP's own idempotency handling recognises the key, and where the ERP has
 * none, `erpReference` on the row is checked first.
 */
const EVENT_RULES: Readonly<Record<CustomerErpEventAction, EventRule>> = Object.freeze({
  CLAIM: {
    from: ['QUEUED', 'RETRYING'],
    to: 'PROCESSING',
    refusal: 'This event is not waiting to be processed.',
  },
  SUCCEED: {
    from: ['PROCESSING'],
    to: 'SUCCEEDED',
    refusal: 'Only an event being processed can be completed.',
  },
  SCHEDULE_RETRY: {
    from: ['PROCESSING'],
    to: 'RETRYING',
    refusal: 'Only an event being processed can be scheduled for a retry.',
  },
  /// Retries exhausted, or a failure no retry can fix. The dead letter.
  ABANDON: {
    from: ['PROCESSING', 'RETRYING'],
    to: 'FAILED',
    refusal: 'This event is not in flight.',
  },
  /**
   * Deliberately not done. Reachable from QUEUED as well as PROCESSING because
   * some skips are decided before anything is attempted - a paused connection,
   * a policy that switched this event type off, an approval that was refused.
   */
  SKIP: {
    from: ['QUEUED', 'PROCESSING', 'RETRYING'],
    to: 'SKIPPED',
    refusal: 'This event has already been settled.',
  },
  /// The manual retry, and the release of an event that was waiting on an
  /// approval which has now been granted.
  REQUEUE: {
    from: ['FAILED', 'SKIPPED'],
    to: 'QUEUED',
    refusal: 'Only a failed or skipped event can be queued again.',
  },
});

export function assertEventTransition(
  current: CustomerErpEventStateName,
  action: CustomerErpEventAction,
): CustomerErpEventStateName {
  const rule = EVENT_RULES[action];

  if (!rule.from.includes(current)) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_EVENT_STATE_INVALID,
      `${rule.refusal} It is currently ${eventStateLabel(current)}.`,
    );
  }

  return rule.to;
}

export function canPerformEventAction(
  current: CustomerErpEventStateName,
  action: CustomerErpEventAction,
): boolean {
  return EVENT_RULES[action].from.includes(current);
}

/** Whether nothing further will happen to this event on its own. */
export function isEventSettled(state: CustomerErpEventStateName): boolean {
  return state === 'SUCCEEDED' || state === 'FAILED' || state === 'SKIPPED';
}

export function eventStateLabel(state: CustomerErpEventStateName): string {
  switch (state) {
    case 'QUEUED':
      return 'queued';
    case 'PROCESSING':
      return 'being processed';
    case 'SUCCEEDED':
      return 'done';
    case 'RETRYING':
      return 'waiting to be retried';
    case 'FAILED':
      return 'failed';
    case 'SKIPPED':
      return 'skipped';
  }
}
