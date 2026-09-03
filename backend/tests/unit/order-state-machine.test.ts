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
