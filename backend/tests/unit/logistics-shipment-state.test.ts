/**
 * The shipment transition matrix.
 *
 * Every rule in this file is one the brief states explicitly, and every one of
 * them is a rule somebody would otherwise "simplify" during a refactor. The
 * three that matter most are the three the brief calls out by name: an
 * ASSIGNED consignment cannot be marked DELIVERED, a partner cannot reverse a
 * DELIVERED one, and a CANCELLED one accepts no further tracking except the
 * return workflow.
 */
import { describe, expect, it } from 'vitest';
import {
  EXCEPTION_SHIPMENT_STATUSES,
  ShipmentStatusValues,
  allowedShipmentTransitions,
  assertShipmentCorrection,
  assertShipmentTransition,
  canTransitionShipment,
  isShipmentStatus,
  isTerminalShipmentStatus,
  isTrackingComplete,
  type ShipmentStatusName,
} from '../../src/domain/logistics-shipment-state.js';
import {
  ALL_LOGISTICS_PERMISSIONS,
  LogisticsPermission,
} from '../../src/domain/logistics-permissions.js';

/** A partner holding everything, so a refusal is never about a missing key. */
const FULL = [...ALL_LOGISTICS_PERMISSIONS];

describe('shipment status vocabulary', () => {
  it('carries the twenty-seven statuses the brief names', () => {
    // Fifteen forward, twelve exception and terminal. A count rather than a
    // list, so adding one deliberately fails here and makes somebody read the
    // matrix below before they do.
    expect(ShipmentStatusValues).toHaveLength(27);
  });

  it('recognises its own members and nothing else', () => {
    expect(isShipmentStatus('IN_TRANSIT')).toBe(true);
    expect(isShipmentStatus('in_transit')).toBe(false);
    expect(isShipmentStatus('TELEPORTED')).toBe(false);
  });

  it('treats RETURNED and LOST as terminal and everything else as not', () => {
    expect(isTerminalShipmentStatus('RETURNED')).toBe(true);
    expect(isTerminalShipmentStatus('LOST')).toBe(true);
    expect(isTerminalShipmentStatus('DELIVERED')).toBe(false);
  });

  it('stops polling a carrier once nothing more will be heard', () => {
    for (const status of ['DELIVERED', 'RETURNED', 'LOST', 'CANCELLED'] as const) {
      expect(isTrackingComplete(status)).toBe(true);
    }
    expect(isTrackingComplete('IN_TRANSIT')).toBe(false);
  });
});

describe('the three rules the brief states explicitly', () => {
  it('refuses ASSIGNED -> DELIVERED', () => {
    expect(
      canTransitionShipment({
        from: 'ASSIGNED',
        to: 'DELIVERED',
        actor: 'PARTNER',
        permissions: FULL,
      }),
    ).toBe(false);

    expect(() =>
      assertShipmentTransition({
        from: 'ASSIGNED',
        to: 'DELIVERED',
        actor: 'PARTNER',
        permissions: FULL,
        hasProofOfDelivery: true,
      }),
    ).toThrow(/cannot move from ASSIGNED to DELIVERED/);
  });

  it('lets nothing but OUT_FOR_DELIVERY and DELIVERY_ATTEMPTED reach DELIVERED', () => {
    const reaching = ShipmentStatusValues.filter((from) =>
      canTransitionShipment({
        from,
        to: 'DELIVERED',
        actor: 'PARTNER',
        permissions: FULL,
        hasProofOfDelivery: true,
      }),
    );

    expect(reaching.sort()).toEqual(['DELIVERY_ATTEMPTED', 'OUT_FOR_DELIVERY']);
  });

  it('will not let a partner reverse a delivery', () => {
    const partnerMoves = allowedShipmentTransitions('DELIVERED', 'PARTNER', FULL);
    expect(partnerMoves).toEqual([]);

    const driverMoves = allowedShipmentTransitions('DELIVERED', 'DRIVER', FULL);
    expect(driverMoves).toEqual([]);

    // The marketplace may start a return, and that is the only edge out.
    const adminMoves = allowedShipmentTransitions('DELIVERED', 'UBOSS_ADMIN');
    expect(adminMoves.map((move) => move.to)).toEqual(['RETURN_REQUESTED']);
  });

  it('accepts no tracking on a cancelled shipment except the return workflow', () => {
    const moves = allowedShipmentTransitions('CANCELLED', 'UBOSS_ADMIN');
    expect(moves.map((move) => move.to)).toEqual(['RETURN_REQUESTED']);

    // A carrier feed cannot reanimate it at all.
    expect(allowedShipmentTransitions('CANCELLED', 'CARRIER')).toEqual([]);
    expect(allowedShipmentTransitions('CANCELLED', 'PARTNER', FULL)).toEqual([]);
  });
});

describe('reasons and proof', () => {
  it('demands a reason wherever the matrix says so', () => {
    expect(() =>
      assertShipmentTransition({
        from: 'IN_TRANSIT',
        to: 'DELAYED',
        actor: 'PARTNER',
        permissions: FULL,
      }),
    ).toThrow(/requires a reason/);

    expect(() =>
      assertShipmentTransition({
        from: 'IN_TRANSIT',
        to: 'DELAYED',
        actor: 'PARTNER',
        permissions: FULL,
        reason: 'Ferry cancelled at Calais.',
      }),
    ).not.toThrow();
  });

  it('treats whitespace as no reason at all', () => {
    expect(() =>
      assertShipmentTransition({
        from: 'IN_TRANSIT',
        to: 'DELAYED',
        actor: 'PARTNER',
        permissions: FULL,
        reason: '   ',
      }),
    ).toThrow(/requires a reason/);
  });

  it('refuses DELIVERED without a proof of delivery', () => {
    expect(() =>
      assertShipmentTransition({
        from: 'OUT_FOR_DELIVERY',
        to: 'DELIVERED',
        actor: 'DRIVER',
        permissions: FULL,
        hasProofOfDelivery: false,
      }),
    ).toThrow(/Proof of Delivery is required/);

    expect(() =>
      assertShipmentTransition({
        from: 'OUT_FOR_DELIVERY',
        to: 'DELIVERED',
        actor: 'DRIVER',
        permissions: FULL,
        hasProofOfDelivery: true,
      }),
    ).not.toThrow();
  });

  it('refuses a move to the status it is already in', () => {
    expect(() =>
      assertShipmentTransition({
        from: 'IN_TRANSIT',
        to: 'IN_TRANSIT',
        actor: 'PARTNER',
        permissions: FULL,
      }),
    ).toThrow(/already IN_TRANSIT/);
  });
});

describe('permissions', () => {
  it('refuses a partner who does not hold the key the move needs', () => {
    expect(() =>
      assertShipmentTransition({
        from: 'IN_TRANSIT',
        to: 'OUT_FOR_DELIVERY',
        actor: 'PARTNER',
        permissions: [LogisticsPermission.SHIPMENT_READ],
      }),
    ).toThrow(/permission/);
  });

  it('does not check permissions for a carrier feed or the system', () => {
    // A webhook holds no permissions and must still be able to move a parcel.
    expect(() =>
      assertShipmentTransition({
        from: 'IN_TRANSIT',
        to: 'OUT_FOR_DELIVERY',
        actor: 'CARRIER',
      }),
    ).not.toThrow();
  });

  it('only offers a driver the moves a driver may make', () => {
    const driverMoves = allowedShipmentTransitions('ACCEPTED', 'DRIVER', FULL).map((m) => m.to);

    // A driver may not put a shipment on hold or cancel it from the doorstep.
    expect(driverMoves).not.toContain('ON_HOLD');
    expect(driverMoves).not.toContain('CANCELLED');
  });
});

describe('the matrix as a whole', () => {
  it('leads somewhere from every non-terminal status', () => {
    const deadEnds = ShipmentStatusValues.filter((status) => {
      const anyActorCanMove = (['PARTNER', 'UBOSS_ADMIN', 'SYSTEM', 'CARRIER'] as const).some(
        (actor) => allowedShipmentTransitions(status, actor, FULL).length > 0,
      );
      return !anyActorCanMove;
    });

    // RETURNED and LOST are terminal by design. Anything else appearing here
    // is a consignment that can enter a status and never leave it, which is a
    // parcel nobody can finish.
    expect(deadEnds.sort()).toEqual(['LOST', 'RETURNED']);
  });

  it('can reach every status from CREATED', () => {
    // A breadth-first walk of the matrix, ignoring actors and permissions: a
    // status no path reaches is a status that can never occur, which means it
    // is either dead code or a hole in the matrix.
    const seen = new Set<ShipmentStatusName>(['CREATED']);
    const queue: ShipmentStatusName[] = ['CREATED'];

    while (queue.length > 0) {
      const current = queue.shift() as ShipmentStatusName;

      for (const actor of ['PARTNER', 'DRIVER', 'CARRIER', 'UBOSS_ADMIN', 'SYSTEM'] as const) {
        for (const move of allowedShipmentTransitions(current, actor, FULL)) {
          if (seen.has(move.to)) continue;
          seen.add(move.to);
          queue.push(move.to);
        }
      }
    }

    const unreachable = ShipmentStatusValues.filter((status) => !seen.has(status));
    expect(unreachable).toEqual([]);
  });

  it('names the exception statuses the operations queue works', () => {
    expect([...EXCEPTION_SHIPMENT_STATUSES].sort()).toEqual([
      'ADDRESS_ISSUE',
      'CUSTOMS_HOLD',
      'DAMAGED',
      'DELAYED',
      'DELIVERY_FAILED',
      'LOST',
      'ON_HOLD',
      'TEMPERATURE_EXCEPTION',
    ]);
  });
});

describe('operator corrections', () => {
  it('is the only way out of DELIVERED in the wrong direction', () => {
    expect(() =>
      assertShipmentCorrection({
        from: 'DELIVERED',
        to: 'IN_TRANSIT',
        actor: 'UBOSS_ADMIN',
        reason: 'Scanned against the wrong consignment at the depot.',
      }),
    ).not.toThrow();
  });

  it('refuses a partner, however good their reason', () => {
    expect(() =>
      assertShipmentCorrection({
        from: 'DELIVERED',
        to: 'IN_TRANSIT',
        actor: 'PARTNER',
        reason: 'Scanned against the wrong consignment at the depot.',
      }),
    ).toThrow(/Only the marketplace/);
  });

  it('demands a written reason of real length', () => {
    for (const reason of [undefined, '', 'oops', '   ']) {
      expect(() =>
        assertShipmentCorrection({
          from: 'DELIVERED',
          to: 'IN_TRANSIT',
          actor: 'UBOSS_ADMIN',
          ...(reason === undefined ? {} : { reason }),
        }),
      ).toThrow(/reason/);
    }
  });

  it('refuses a correction to the status it already holds', () => {
    expect(() =>
      assertShipmentCorrection({
        from: 'DELIVERED',
        to: 'DELIVERED',
        actor: 'UBOSS_ADMIN',
        reason: 'This is a long enough reason.',
      }),
    ).toThrow(/already DELIVERED/);
  });
});
