/**
 * Order state machine.
 *
 * The tests that matter here are the negative ones: the transitions that must
 * NOT be possible. A permissive state machine is how an order gets paid twice,
 * or cancelled after it was delivered.
 */
import { describe, expect, it } from 'vitest';
import { AppError, ErrorCode } from '../../src/domain/errors.js';
import {
  OrderStatusValues,
  allowedTransitions,
  assertTransition,
  canTransition,
  holdsCommittedStock,
  isTerminal,
  type OrderStatusName,
} from '../../src/domain/order-state-machine.js';
// Read rather than restated: the point of the cancellation tests below is that
// the state machine and the role catalogue agree, so restating either one here
// would test this file against itself.
import {
  ALL_PERMISSIONS,
  ROLE_DEFINITIONS,
  Role,
  type RoleKey,
} from '../../src/domain/permissions.js';

describe('allowed transitions', () => {
  it('lets the system confirm an order awaiting payment', () => {
    expect(canTransition({ from: 'PENDING_PAYMENT', to: 'CONFIRMED', actor: 'SYSTEM' })).toBe(true);
  });

  it('lets an admin with order.fulfil move CONFIRMED to PROCESSING', () => {
    expect(
      canTransition({
        from: 'CONFIRMED',
        to: 'PROCESSING',
        actor: 'ADMIN',
        permissions: ['order.fulfil'],
      }),
    ).toBe(true);
  });

  it('reports what an actor may do, with the reason requirement attached', () => {
    const options = allowedTransitions('CONFIRMED', 'ADMIN', ['order.fulfil', 'order.cancel']);
    expect(options).toEqual(
      expect.arrayContaining([
        { to: 'PROCESSING', requiresReason: false, permission: 'order.fulfil' },
        { to: 'CANCELLED', requiresReason: true, permission: 'order.cancel' },
      ]),
    );
  });

  it('hides transitions the admin lacks permission for', () => {
    const options = allowedTransitions('CONFIRMED', 'ADMIN', ['order.fulfil']);
    expect(options.map((option) => option.to)).not.toContain('CANCELLED');
  });
});

describe('forbidden transitions', () => {
  it('never reopens payment on a confirmed order', () => {
    // Reopening would let a second charge attach to an order already paid for.
    expect(canTransition({ from: 'CONFIRMED', to: 'PENDING_PAYMENT', actor: 'SYSTEM' })).toBe(false);
  });

  it('does not let a delivered order be cancelled', () => {
    expect(
      canTransition({
        from: 'DELIVERED',
        to: 'CANCELLED',
        actor: 'ADMIN',
        permissions: ['order.cancel'],
      }),
    ).toBe(false);
  });

  it('treats REFUNDED as terminal', () => {
    expect(isTerminal('REFUNDED')).toBe(true);
    for (const target of OrderStatusValues) {
      expect(canTransition({ from: 'REFUNDED', to: target, actor: 'ADMIN' })).toBe(false);
    }
  });

  it('does not let a customer fulfil their own order', () => {
    expect(canTransition({ from: 'CONFIRMED', to: 'PROCESSING', actor: 'CUSTOMER' })).toBe(false);
    expect(canTransition({ from: 'SHIPPED', to: 'DELIVERED', actor: 'CUSTOMER' })).toBe(false);
  });

  it('does not let a customer approve their own order', () => {
    expect(
      canTransition({ from: 'PENDING_APPROVAL', to: 'PENDING_PAYMENT', actor: 'CUSTOMER' }),
    ).toBe(false);
  });

  it('does not let an admin skip payment straight to CONFIRMED', () => {
    // Only SYSTEM reaches CONFIRMED, and only from a verified provider event.
    expect(
      canTransition({
        from: 'PENDING_PAYMENT',
        to: 'CONFIRMED',
        actor: 'ADMIN',
        permissions: ['order.fulfil', 'order.approve', 'order.cancel'],
      }),
    ).toBe(false);
  });

  it('does not allow a jump from DRAFT to SHIPPED', () => {
    expect(canTransition({ from: 'DRAFT', to: 'SHIPPED', actor: 'ADMIN' })).toBe(false);
  });
});

describe('assertTransition', () => {
  it('passes silently for a legal transition', () => {
    expect(() =>
      assertTransition({ from: 'PENDING_PAYMENT', to: 'CONFIRMED', actor: 'SYSTEM' }),
    ).not.toThrow();
  });

  it('rejects a no-op transition with a clear code', () => {
    try {
      assertTransition({ from: 'CONFIRMED', to: 'CONFIRMED', actor: 'SYSTEM' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe(ErrorCode.ORDER_TRANSITION_NOT_ALLOWED);
      expect((error as AppError).statusCode).toBe(409);
    }
  });

  it('rejects an undefined transition', () => {
    expect(() => assertTransition({ from: 'DELIVERED', to: 'DRAFT', actor: 'ADMIN' })).toThrow(
      AppError,
    );
  });

  it('requires the permission the rule names', () => {
    try {
      assertTransition({
        from: 'CONFIRMED',
        to: 'CANCELLED',
        actor: 'ADMIN',
        permissions: [],
        reason: 'customer changed their mind',
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCode.PERMISSION_DENIED);
    }
  });

  it('requires a reason where the rule demands one', () => {
    try {
      assertTransition({
        from: 'CONFIRMED',
        to: 'CANCELLED',
        actor: 'ADMIN',
        permissions: ['order.cancel'],
      });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).details[0]?.field).toBe('reason');
    }
  });

  it('does not accept whitespace as a reason', () => {
    expect(() =>
      assertTransition({
        from: 'CONFIRMED',
        to: 'CANCELLED',
        actor: 'ADMIN',
        permissions: ['order.cancel'],
        reason: '   ',
      }),
    ).toThrow(AppError);
  });
});

describe('stock commitment', () => {
  it('holds stock exactly for the statuses where the customer has committed', () => {
    const holding: OrderStatusName[] = ['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
    const notHolding: OrderStatusName[] = [
      'DRAFT',
      'PENDING_APPROVAL',
      'PENDING_PAYMENT',
      'CANCELLED',
      'RETURNED',
      'REFUNDED',
    ];

    for (const status of holding) expect(holdsCommittedStock(status)).toBe(true);
    for (const status of notHolding) expect(holdsCommittedStock(status)).toBe(false);
  });
});

describe('graph integrity', () => {
  it('can reach every non-draft status from DRAFT', () => {
    // Guards against a rule edit that silently orphans a status.
    const reachable = new Set<OrderStatusName>(['DRAFT']);
    const allActors = ['SYSTEM', 'ADMIN', 'CUSTOMER'] as const;
    const allPermissions = [
      'order.approve',
      'order.fulfil',
      'order.cancel',
      'order.return',
      'refund.create',
    ];

    let grew = true;
    while (grew) {
      grew = false;
      for (const status of [...reachable]) {
        for (const actor of allActors) {
          for (const option of allowedTransitions(status, actor, allPermissions)) {
            if (!reachable.has(option.to)) {
              reachable.add(option.to);
              grew = true;
            }
          }
        }
      }
    }

    for (const status of OrderStatusValues) {
      expect(reachable.has(status), `${status} is unreachable from DRAFT`).toBe(true);
    }
  });
});

/**
 * Cancellation authority, checked against the real role catalogue.
 *
 * Two bugs lived here, and both were invisible from any single screen.
 *
 * The first: `PENDING_APPROVAL -> CANCELLED` demanded `order.approve`. The
 * Order Manager - "Orders, fulfilment, cancellation and return handling" -
 * holds `order.cancel` and not `order.approve`, so the status where an order
 * most often needs cancelling was the one they could not cancel from, and the
 * button was filtered out rather than refused.
 *
 * The second: `DRAFT -> CANCELLED` and `PENDING_PAYMENT -> CANCELLED` named no
 * permission at all. `POST /admin/orders/:id/transition` is guarded by
 * `order.read` alone and hands the decision to this table, so "no permission"
 * meant every member of staff who can look at an order could cancel one - the
 * Inventory Manager included.
 *
 * These assertions read the catalogue rather than restating it, so a future
 * role that breaks the relationship fails here instead of in production.
 */
describe('cancellation authority', () => {
  const ROLE_PERMISSIONS = new Map(
    ROLE_DEFINITIONS.map((role) => [role.key, [...role.permissions] as string[]]),
  );

  function permissionsFor(role: RoleKey): string[] {
    return ROLE_PERMISSIONS.get(role) ?? [];
  }

  const CANCELLABLE_FROM: OrderStatusName[] = [
    'DRAFT',
    'PENDING_APPROVAL',
    'PENDING_PAYMENT',
    'CONFIRMED',
    'PROCESSING',
  ];

  it('lets the Order Manager cancel from every status an order can be cancelled from', () => {
    const held = permissionsFor(Role.ORDER_MANAGER);

    for (const status of CANCELLABLE_FROM) {
      const options = allowedTransitions(status, 'ADMIN', held).map((option) => option.to);
      expect(options, `Order Manager cannot cancel from ${status}`).toContain('CANCELLED');
    }
  });

  it('lets the Finance Approver reject an order awaiting their approval', () => {
    const held = permissionsFor(Role.FINANCE_APPROVER);

    // `decideApproval(approved: false)` reaches CANCELLED through this rule,
    // so an approver who could not take it would be unable to reject.
    expect(
      allowedTransitions('PENDING_APPROVAL', 'ADMIN', held).map((option) => option.to),
    ).toContain('CANCELLED');
  });

  it('never lets a role that can only read an order cancel one', () => {
    const held = permissionsFor(Role.INVENTORY_MANAGER);

    // Holds `order.read` - it needs to see what stock is committed - and not
    // `order.cancel`. That combination is exactly what the missing permission
    // on DRAFT and PENDING_PAYMENT used to let through.
    expect(held).toContain('order.read');
    expect(held).not.toContain('order.cancel');

    for (const status of CANCELLABLE_FROM) {
      const options = allowedTransitions(status, 'ADMIN', held).map((option) => option.to);
      expect(options, `Inventory Manager can cancel from ${status}`).not.toContain('CANCELLED');
    }
  });

  it('asks for order.cancel on every admin cancellation, and never for anything else', () => {
    for (const status of CANCELLABLE_FROM) {
      const cancel = allowedTransitions(status, 'ADMIN', [...ALL_PERMISSIONS]).find(
        (option) => option.to === 'CANCELLED',
      );

      expect(cancel, `${status} has no admin cancellation`).toBeDefined();
      expect(cancel?.permission, `${status} cancels under the wrong permission`).toBe(
        'order.cancel',
      );
      // A cancellation without a stated reason is a dispute nobody can answer.
      expect(cancel?.requiresReason, `${status} cancels without a reason`).toBe(true);
    }
  });

  /**
   * The relationship the PENDING_APPROVAL fix rests on.
   *
   * Changing that rule from `order.approve` to `order.cancel` only takes
   * nothing away because no role holds the first without the second. If a
   * future role does, this fails and says so.
   */
  it('gives every role that can approve an order the right to cancel one', () => {
    for (const role of ROLE_DEFINITIONS) {
      const held = [...role.permissions] as string[];
      if (!held.includes('order.approve')) continue;

      expect(held, `${role.key} can approve but not cancel`).toContain('order.cancel');
    }
  });

  it('still lets a customer cancel their own order without holding any permission', () => {
    for (const status of ['DRAFT', 'PENDING_APPROVAL', 'PENDING_PAYMENT'] as OrderStatusName[]) {
      const options = allowedTransitions(status, 'CUSTOMER', []).map((option) => option.to);
      expect(options, `a customer cannot cancel from ${status}`).toContain('CANCELLED');
    }
  });

  it('still lets the system cancel after a failed charge without holding any permission', () => {
    expect(
      allowedTransitions('PENDING_PAYMENT', 'SYSTEM', []).map((option) => option.to),
    ).toContain('CANCELLED');
  });
});
