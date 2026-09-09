/**
 * The state machine for an ERP connection.
 *
 * The same rule as `order-state-machine.ts` and `schedule-state.ts`: no service
 * writes `status` on an `erp_connections` row. Every change goes
 * through `assertErpTransition`, so the screen's buttons and the API's answers
 * are derived from one table rather than two that drift.
 *
 * It matters more here than the shape of the enum suggests, because two of
 * these transitions are the difference between a connection that carries the
 * shop's orders and one that does not:
 *
 *   CONNECTED -> ACTIVE  is the only way traffic ever starts. It requires a
 *   test that passed and a mapping that has been checked against a real
 *   response. A connection cannot reach ACTIVE from DRAFT, from ERROR, or by
 *   any path that skips those two facts.
 *
 *   ERROR is entered by the machinery, never by a person. It means repeated
 *   failures took the connection out of service, and the only way out is a test
 *   that passes - which is deliberately the same door setup came through, so
 *   "it is broken" and "it has never worked" are recovered the same way.
 *
 * PAUSED and DISABLED look similar and are not. PAUSED is a customer saying
 * "stop for now", keeps every setting, needs no re-test, and refuses inbound
 * webhooks while it lasts. DISABLED is "stop, and I am not coming back soon" -
 * it survives so the integration ledger still reads, and coming back out of it
 * goes through a test like any other cold start.
 */
import { ErrorCode, conflict } from './errors.js';

export const ErpConnectionStatusValues = [
  'DRAFT',
  'TESTING',
  'CONNECTED',
  'ACTIVE',
  'PAUSED',
  'ERROR',
  'DISABLED',
] as const;

export type ErpConnectionStatusName = (typeof ErpConnectionStatusValues)[number];

/**
 * What a caller is asking to do, rather than which status it wants.
 *
 * Named for the button rather than the destination because two different
 * actions can land on the same status - TEST_PASSED and RESUME both reach a
 * usable connection - and the reason they were allowed is different.
 */
export type ErpConnectionAction =
  | 'START_TEST'
  | 'TEST_PASSED'
  | 'TEST_FAILED'
  | 'ACTIVATE'
  | 'PAUSE'
  | 'RESUME'
  | 'SUSPEND'
  | 'DISABLE'
  | 'REOPEN'
  | 'EDIT';

interface TransitionRule {
  from: readonly ErpConnectionStatusName[];
  to: ErpConnectionStatusName;
  /** Shown when the current status is not in `from`. */
  refusal: string;
}

/**
 * Every legal move, and the ones deliberately missing.
 *
 * Absent on purpose:
 *
 *   - ACTIVATE from DRAFT or ERROR. Both mean "no test has passed since this
 *     configuration was last touched", and activating either would put a
 *     customer's orders through a connector nobody has proved answers.
 *   - START_TEST from TESTING. One test at a time per connection: two tabs
 *     pressing the button together would otherwise race, and the loser would
 *     overwrite the winner's result.
 *   - Anything but REOPEN out of DISABLED, so a retired connection cannot
 *     quietly start carrying traffic again.
 */
const RULES: Readonly<Record<ErpConnectionAction, TransitionRule>> = Object.freeze({
  START_TEST: {
    from: ['DRAFT', 'CONNECTED', 'ACTIVE', 'PAUSED', 'ERROR'],
    to: 'TESTING',
    refusal: 'A test is already running for this connection.',
  },
  TEST_PASSED: {
    from: ['TESTING'],
    to: 'CONNECTED',
    refusal: 'This connection is not currently being tested.',
  },
  TEST_FAILED: {
    from: ['TESTING'],
    to: 'ERROR',
    refusal: 'This connection is not currently being tested.',
  },
  ACTIVATE: {
    from: ['CONNECTED'],
    to: 'ACTIVE',
    refusal: 'Test the connection successfully before switching it on.',
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
  /// Entered by the machinery after repeated failures. Not a button.
  SUSPEND: {
    from: ['ACTIVE', 'CONNECTED', 'TESTING'],
    to: 'ERROR',
    refusal: 'This connection is not in service.',
  },
  DISABLE: {
    from: ['DRAFT', 'CONNECTED', 'ACTIVE', 'PAUSED', 'ERROR'],
    to: 'DISABLED',
    refusal: 'This connection is already switched off.',
  },
  REOPEN: {
    from: ['DISABLED'],
    to: 'DRAFT',
    refusal: 'Only a switched-off connection can be reopened.',
  },
  /// Editing configuration. Lands back in DRAFT because whatever the last test
  /// proved, it proved about the settings that have just been replaced.
  EDIT: {
    from: ['DRAFT', 'TESTING', 'CONNECTED', 'ACTIVE', 'PAUSED', 'ERROR'],
    to: 'DRAFT',
    refusal: 'A switched-off connection has to be reopened before it can be edited.',
  },
});

/**
 * The status a connection ends in after `action`, or a 409 explaining why not.
 *
 * Callers use the return value; nothing derives a status any other way.
 */
export function assertErpTransition(
  current: ErpConnectionStatusName,
  action: ErpConnectionAction,
): ErpConnectionStatusName {
  const rule = RULES[action];

  if (!rule.from.includes(current)) {
    throw conflict(
      ErrorCode.ERP_CONNECTION_STATE_INVALID,
      `${rule.refusal} It is currently ${statusLabel(current)}.`,
    );
  }

  return rule.to;
}

/** Whether an action is available, for rendering buttons rather than guarding. */
export function canPerform(
  current: ErpConnectionStatusName,
  action: ErpConnectionAction,
): boolean {
  return RULES[action].from.includes(current);
}

/** Every action available from a status, for the screen to render. */
export function availableActions(
  current: ErpConnectionStatusName,
): ErpConnectionAction[] {
  return (Object.keys(RULES) as ErpConnectionAction[]).filter((action) =>
    canPerform(current, action),
  );
}

/**
 * Whether a connection in this status may be called at all.
 *
 * The single question the order push, the poller and the webhook handler each
 * ask, so that "what does ACTIVE mean" has one answer. TESTING is deliberately
 * true: a test IS a call, and it is the only traffic that status permits.
 */
export function isCallable(current: ErpConnectionStatusName): boolean {
  return current === 'ACTIVE' || current === 'TESTING';
}

/**
 * Whether a connection carries business traffic - orders and scheduled syncs.
 *
 * Narrower than `isCallable`, and the distinction is the point: a connection
 * being tested may be called, but an order must never be pushed down it.
 */
export function carriesTraffic(current: ErpConnectionStatusName): boolean {
  return current === 'ACTIVE';
}

/** Words for a status, for an error message a customer reads. */
export function statusLabel(status: ErpConnectionStatusName): string {
  switch (status) {
    case 'DRAFT':
      return 'a draft';
    case 'TESTING':
      return 'being tested';
    case 'CONNECTED':
      return 'connected but not switched on';
    case 'ACTIVE':
      return 'switched on';
    case 'PAUSED':
      return 'paused';
    case 'ERROR':
      return 'out of service after repeated failures';
    case 'DISABLED':
      return 'switched off';
  }
}
