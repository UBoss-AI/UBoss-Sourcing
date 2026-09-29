/**
 * The dispatch gate: when goods that need an inspection may leave.
 *
 * `inspection-gate.ts` is pure - it turns facts into an open-or-shut verdict -
 * and the two state machines refuse a guarded move unless they are handed an
 * OPEN one. Both halves are held down here, in the order a person would ask:
 * is inspection needed, have the goods already gone, is there a release, is it
 * approved, does it still describe what is being sent, is anything holding it.
 *
 * The property that matters most is fail-closed: a guarded move with no
 * verdict at all is refused, so a new code path that forgets to ask cannot
 * quietly let a consignment go.
 */
import { describe, expect, it } from 'vitest';
import {
  assertInspectionGateOpen,
  evaluateInspectionGate,
  GATE_NOT_APPLICABLE,
  scopeFingerprint,
  type InspectionGateFacts,
  type InspectionGateVerdict,
} from '../../src/domain/inspection-gate.js';
import {
  assertSellerOrderTransition,
  allowedSellerOrderTransitions,
} from '../../src/domain/seller-state.js';
import { ALL_LOGISTICS_PERMISSIONS } from '../../src/domain/logistics-permissions.js';
import {
  assertShipmentTransition,
  INSPECTION_GATED_SHIPMENT_STATUSES,
} from '../../src/domain/logistics-shipment-state.js';

const FULL = [...ALL_LOGISTICS_PERMISSIONS];
const NOW = new Date('2026-10-01T10:00:00.000Z');

function facts(overrides: Partial<InspectionGateFacts> = {}): InspectionGateFacts {
  return {
    requirementId: 'req-1',
    level: 'MANDATORY',
    release: null,
    latestSignedResult: null,
    hasOpenJob: false,
    blockingNcrCount: 0,
    currentScopeHash: 'scope-a',
    alreadyCollected: false,
    buyerReviewEndsAt: null,
    now: NOW,
    ...overrides,
  };
}

const passRelease = { kind: 'PASS', state: 'ACTIVE', boundScopeHash: 'scope-a' } as const;

describe('when the gate is open', () => {
  it('is open when no inspection is required', () => {
    expect(evaluateInspectionGate(facts({ level: 'NOT_REQUIRED' }))).toMatchObject({
      open: true,
      reason: 'NOT_REQUIRED',
    });
  });

  it('is open on a live PASS release that describes what is being sent', () => {
    expect(
      evaluateInspectionGate(facts({ release: passRelease, latestSignedResult: 'PASS' })),
    ).toMatchObject({
      open: true,
      reason: 'PASSED',
      requirementId: 'req-1',
      level: 'MANDATORY',
    });
  });

  it('is open on an approved conditional release, even after a FAIL', () => {
    const verdict = evaluateInspectionGate(
      facts({
        release: { kind: 'CONDITIONAL', state: 'ACTIVE', boundScopeHash: 'scope-a' },
        latestSignedResult: 'FAIL',
        blockingNcrCount: 2,
      }),
    );
    expect(verdict).toMatchObject({ open: true, reason: 'CONDITIONALLY_RELEASED' });
  });

  it('stays open for goods already collected, so a carrier’s later scans are still recorded', () => {
    expect(evaluateInspectionGate(facts({ alreadyCollected: true, release: null }))).toMatchObject({
      open: true,
      reason: 'ALREADY_RELEASED',
    });
  });

  it('is open again once the buyer’s review period has ended', () => {
    const verdict = evaluateInspectionGate(
      facts({ release: passRelease, buyerReviewEndsAt: new Date(NOW.getTime() - 1) }),
    );
    expect(verdict.open).toBe(true);
  });
});

describe('when the gate is shut', () => {
  const shut = (overrides: Partial<InspectionGateFacts>): InspectionGateVerdict =>
    evaluateInspectionGate(facts(overrides));

  it('is shut, as NOT_BOOKED, when nothing has been arranged', () => {
    expect(shut({})).toMatchObject({ open: false, reason: 'NOT_BOOKED' });
  });

  it('is shut, as IN_PROGRESS, while a job is booked and not finished', () => {
    expect(shut({ hasOpenJob: true })).toMatchObject({ open: false, reason: 'IN_PROGRESS' });
  });

  it('is shut, as FAILED, after a signed FAIL with no release', () => {
    expect(shut({ latestSignedResult: 'FAIL' })).toMatchObject({ open: false, reason: 'FAILED' });
  });

  it('a FAIL outranks a job that is booked again', () => {
    expect(shut({ latestSignedResult: 'FAIL', hasOpenJob: true }).reason).toBe('FAILED');
  });

  it('is shut, as SCOPE_CHANGED, when a PASS has lost its release because the goods changed', () => {
    expect(shut({ latestSignedResult: 'PASS', release: null })).toMatchObject({
      open: false,
      reason: 'SCOPE_CHANGED',
    });
  });

  it('is shut, as SCOPE_CHANGED, when the release describes different goods from those being sent', () => {
    expect(shut({ release: passRelease, currentScopeHash: 'scope-b' })).toMatchObject({
      open: false,
      reason: 'SCOPE_CHANGED',
    });
    expect(
      shut({
        release: { kind: 'CONDITIONAL', state: 'ACTIVE', boundScopeHash: 'scope-a' },
        currentScopeHash: 'scope-b',
      }).open,
    ).toBe(false);
  });

  it('is shut while a conditional release waits for its second approver', () => {
    expect(
      shut({
        release: { kind: 'CONDITIONAL', state: 'PENDING_APPROVAL', boundScopeHash: 'scope-a' },
      }),
    ).toMatchObject({ open: false, reason: 'RELEASE_PENDING_APPROVAL' });
  });

  it('is shut on a PASS while a blocking non-conformance is still open', () => {
    expect(shut({ release: passRelease, blockingNcrCount: 1 })).toMatchObject({
      open: false,
      reason: 'BLOCKING_NCR_OPEN',
    });
  });

  it('is shut during the buyer’s review period, and says when it ends', () => {
    const ends = new Date(NOW.getTime() + 3_600_000);
    expect(shut({ release: passRelease, buyerReviewEndsAt: ends })).toMatchObject({
      open: false,
      reason: 'BUYER_REVIEW_PERIOD',
      reviewEndsAt: ends.toISOString(),
    });
  });
});

describe('refusing a guarded move', () => {
  const META = { from: 'PROCESSING', to: 'READY_FOR_DISPATCH' };

  it('lets an open verdict through', () => {
    expect(() => {
      assertInspectionGateOpen(
        evaluateInspectionGate(facts({ release: passRelease })),
        'SELLER_ORDER',
        META,
      );
    }).not.toThrow();
  });

  it('refuses a shut verdict with INSPECTION_GATE_CLOSED and the reason', () => {
    expect(() => {
      assertInspectionGateOpen(evaluateInspectionGate(facts()), 'SELLER_ORDER', META);
    }).toThrowError(
      expect.objectContaining({
        code: 'INSPECTION_GATE_CLOSED',
        statusCode: 409,
        details: [expect.objectContaining({ code: 'NOT_BOOKED' })],
      }) as Error,
    );
  });

  it('refuses a move that arrives with NO verdict, rather than assuming it is fine', () => {
    expect(() => {
      assertInspectionGateOpen(undefined, 'SHIPMENT', {
        from: 'READY_FOR_PICKUP',
        to: 'PICKED_UP',
      });
    }).toThrowError(expect.objectContaining({ code: 'INSPECTION_GATE_NOT_EVALUATED' }) as Error);
  });
});

describe('the seller order moves it guards', () => {
  const shutVerdict = evaluateInspectionGate(facts());
  const openVerdict = evaluateInspectionGate(facts({ release: passRelease }));

  it('refuses READY_FOR_DISPATCH with no verdict, and with a shut one', () => {
    const move = { from: 'PROCESSING', to: 'READY_FOR_DISPATCH', actor: 'SELLER' } as const;

    expect(() => {
      assertSellerOrderTransition(move);
    }).toThrowError(expect.objectContaining({ code: 'INSPECTION_GATE_NOT_EVALUATED' }) as Error);
    expect(() => {
      assertSellerOrderTransition({ ...move, inspectionGate: shutVerdict });
    }).toThrowError(expect.objectContaining({ code: 'INSPECTION_GATE_CLOSED' }) as Error);
    expect(() => {
      assertSellerOrderTransition({ ...move, inspectionGate: openVerdict });
    }).not.toThrow();
  });

  it('refuses SHIPPED the same way', () => {
    const move = { from: 'READY_FOR_DISPATCH', to: 'SHIPPED', actor: 'SELLER' } as const;

    expect(() => {
      assertSellerOrderTransition({ ...move, inspectionGate: shutVerdict });
    }).toThrowError(expect.objectContaining({ code: 'INSPECTION_GATE_CLOSED' }) as Error);
    expect(() => {
      assertSellerOrderTransition({ ...move, inspectionGate: openVerdict });
    }).not.toThrow();
  });

  it('does not ask about moves that let nothing leave', () => {
    expect(() => {
      assertSellerOrderTransition({ from: 'NEW', to: 'ACCEPTED', actor: 'SELLER' });
    }).not.toThrow();
    expect(() => {
      assertSellerOrderTransition({
        from: 'PROCESSING',
        to: 'CANCELLED',
        actor: 'SELLER',
        reason: 'out of stock',
      });
    }).not.toThrow();
  });

  it('leaves the guarded buttons out while the gate is shut, and puts them back when it opens', () => {
    const shut = allowedSellerOrderTransitions('PROCESSING', 'SELLER', shutVerdict).map(
      (rule) => rule.to,
    );
    const open = allowedSellerOrderTransitions('PROCESSING', 'SELLER', openVerdict).map(
      (rule) => rule.to,
    );

    expect(shut).not.toContain('READY_FOR_DISPATCH');
    expect(open).toContain('READY_FOR_DISPATCH');
    // Cancelling is never held back by an inspection.
    expect(shut).toContain('CANCELLED');
  });

  it('does not interfere with an order that needs no inspection', () => {
    expect(() => {
      assertSellerOrderTransition({
        from: 'PROCESSING',
        to: 'READY_FOR_DISPATCH',
        actor: 'SELLER',
        inspectionGate: GATE_NOT_APPLICABLE,
      });
    }).not.toThrow();
  });
});

describe('the shipment moves it guards', () => {
  const shutVerdict = evaluateInspectionGate(facts());

  it('guards every status that means the goods have been collected or are moving', () => {
    expect(INSPECTION_GATED_SHIPMENT_STATUSES).toEqual(
      expect.arrayContaining([
        'PICKED_UP',
        'DISPATCHED',
        'IN_TRANSIT',
        'OUT_FOR_DELIVERY',
        'DELIVERED',
      ]),
    );
    // Reporting a delay, or bringing goods back, is never blocked.
    expect(INSPECTION_GATED_SHIPMENT_STATUSES).not.toContain('DELAYED');
    expect(INSPECTION_GATED_SHIPMENT_STATUSES).not.toContain('RETURNED');
  });

  it('refuses collection with no verdict and with a shut one, even for a partner holding every permission', () => {
    for (const actor of ['PARTNER', 'DRIVER'] as const) {
      const move = { from: 'READY_FOR_PICKUP', to: 'PICKED_UP', actor, permissions: FULL } as const;
      expect(() => {
        assertShipmentTransition(move);
      }).toThrowError(expect.objectContaining({ code: 'INSPECTION_GATE_NOT_EVALUATED' }) as Error);
      expect(() => {
        assertShipmentTransition({ ...move, inspectionGate: shutVerdict });
      }).toThrowError(expect.objectContaining({ code: 'INSPECTION_GATE_CLOSED' }) as Error);
    }
  });

  it('lets collection through once the verdict is open', () => {
    expect(() => {
      assertShipmentTransition({
        from: 'READY_FOR_PICKUP',
        to: 'PICKED_UP',
        actor: 'PARTNER',
        permissions: FULL,
        inspectionGate: evaluateInspectionGate(facts({ release: passRelease })),
      });
    }).not.toThrow();
  });
});

describe('what was inspected', () => {
  const pack = (sequence: number, sealNumber: string | null = null) => ({
    sequence,
    packagingType: 'CARTON',
    containerNumber: null,
    sealNumber,
    weightGrams: 5000,
    lengthMm: 400,
    widthMm: 300,
    heightMm: 200,
    contents: [{ orderItemId: 'item-1', quantity: 10, batchNumber: 'B1' }],
  });
  const base = {
    lines: [{ orderItemId: 'item-1', quantity: 10 }],
    consignments: [{ shipmentId: 'ship-1', packages: [pack(1), pack(2)] }],
  };

  it('gives the same fingerprint however the same facts are ordered or written', () => {
    const reordered = {
      lines: [{ orderItemId: 'item-1', quantity: 10 }],
      consignments: [{ shipmentId: 'ship-1', packages: [pack(2), pack(1)] }],
    };
    expect(scopeFingerprint(reordered).hash).toBe(scopeFingerprint(base).hash);

    const lowercaseSeal = {
      ...base,
      consignments: [{ shipmentId: 'ship-1', packages: [pack(1, ' s-100 '), pack(2)] }],
    };
    const uppercaseSeal = {
      ...base,
      consignments: [{ shipmentId: 'ship-1', packages: [pack(1, 'S-100'), pack(2)] }],
    };
    expect(scopeFingerprint(lowercaseSeal).hash).toBe(scopeFingerprint(uppercaseSeal).hash);
  });

  it('moves the fingerprint when anything that was inspected changes', () => {
    const original = scopeFingerprint(base).hash;

    const moreOrdered = { ...base, lines: [{ orderItemId: 'item-1', quantity: 11 }] };
    const extraPackage = {
      ...base,
      consignments: [{ shipmentId: 'ship-1', packages: [pack(1), pack(2), pack(3)] }],
    };
    const newSeal = {
      ...base,
      consignments: [{ shipmentId: 'ship-1', packages: [pack(1, 'S-1'), pack(2)] }],
    };

    for (const changed of [moreOrdered, extraPackage, newSeal]) {
      expect(scopeFingerprint(changed).hash).not.toBe(original);
    }
  });

  it('summarises the containers and seals so a release screen can show what it is bound to', () => {
    const summary = scopeFingerprint({
      ...base,
      consignments: [
        { shipmentId: 'ship-1', packages: [pack(1, 'S-2'), pack(2, 'S-1'), pack(3, 'S-1')] },
      ],
    }).summary;

    expect(summary.consignments[0]).toMatchObject({ packageCount: 3, seals: ['S-1', 'S-2'] });
  });
});
