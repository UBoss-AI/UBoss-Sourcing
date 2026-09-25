/**
 * Available-to-promise, the shortfall, and the two answers a seller can give
 * when a preorder asks for more than is available.
 */
import { describe, expect, it } from 'vitest';

import { canonicalTerms, termsHash, type PreorderTerms } from '../../src/domain/preorder.js';
import {
  assessShortfall,
  availableToPromise,
  validateAvailabilityProposal,
  type ProposalInput,
} from '../../src/domain/preorder-availability.js';

describe('available-to-promise', () => {
  it('is sellable stock less unaccepted orders and safety stock', () => {
    const atp = availableToPromise({
      locations: [
        { locationId: 'A', availableQuantity: 10_000 },
        { locationId: 'B', availableQuantity: 7_000 },
      ],
      unacceptedOrderQuantity: 1_500,
      safetyStock: 500,
    });
    expect(atp).toEqual({
      availableToPromise: 15_000,
      onHand: 17_000,
      unacceptedOrderQuantity: 1_500,
      safetyStock: 500,
    });
  });

  it('is never negative', () => {
    expect(
      availableToPromise({
        locations: [{ locationId: 'A', availableQuantity: 100 }],
        unacceptedOrderQuantity: 500,
        safetyStock: 50,
      }).availableToPromise,
    ).toBe(0);
  });
});

describe('the shortfall', () => {
  it('is nothing when the request fits', () => {
    expect(assessShortfall(12_000, 15_000)).toEqual({
      sufficient: true,
      requested: 12_000,
      availableNow: 12_000,
      remaining: 0,
    });
  });

  it('is what is available now, and the rest', () => {
    expect(assessShortfall(24_000, 15_000)).toEqual({
      sufficient: false,
      requested: 24_000,
      availableNow: 15_000,
      remaining: 9_000,
    });
  });
});

const now = new Date('2026-09-24T10:00:00Z');

function proposal(overrides: Partial<ProposalInput> = {}): ProposalInput {
  return {
    kind: 'SPLIT_DELIVERY',
    totalBaseUnits: 24_000,
    availableToPromise: 15_000,
    requestedDay: '2026-11-15',
    floorDay: '2026-10-01',
    installments: [
      { date: '2026-11-15', baseUnits: 15_000 },
      { date: '2026-11-30', baseUnits: 9_000 },
    ],
    expiresAt: new Date('2026-09-27T10:00:00Z'),
    now,
    maxExpiryHours: 720,
    ...overrides,
  };
}

function codes(input: ProposalInput): string[] {
  const result = validateAvailabilityProposal(input);
  return result.ok ? [] : result.problems.map((problem) => problem.code);
}

describe('a revised date for the complete quantity', () => {
  it('keeps the whole quantity on one later date and holds what is on hand', () => {
    const result = validateAvailabilityProposal(
      proposal({ kind: 'FULL_ON_REVISED_DATE', revisedDate: '2026-11-30', installments: null }),
    );
    expect(result).toEqual({
      ok: true,
      installments: [
        { sequence: 1, date: '2026-11-30', baseUnits: 24_000, source: 'FUTURE_SUPPLY' },
      ],
      stockAllocationBaseUnits: 15_000,
      committedDate: '2026-11-30',
    });
  });

  it('holds nothing when the seller chooses not to', () => {
    const result = validateAvailabilityProposal(
      proposal({
        kind: 'FULL_ON_REVISED_DATE',
        revisedDate: '2026-11-30',
        installments: null,
        reserveAvailableStock: false,
      }),
    );
    expect(result.ok && result.stockAllocationBaseUnits).toBe(0);
  });

  it('must be after the date the buyer asked for, and after the notice floor', () => {
    expect(
      codes(proposal({ kind: 'FULL_ON_REVISED_DATE', revisedDate: '2026-11-15', installments: null })),
    ).toContain('NOT_LATER');
    expect(
      codes(
        proposal({
          kind: 'FULL_ON_REVISED_DATE',
          revisedDate: '2026-09-25',
          requestedDay: '2026-09-20',
          installments: null,
        }),
      ),
    ).toContain('TOO_EARLY');
    expect(
      codes(proposal({ kind: 'FULL_ON_REVISED_DATE', revisedDate: null, installments: null })),
    ).toContain('DATE_REQUIRED');
  });
});

describe('a split delivery', () => {
  it('is what is available first and the rest later, adding up exactly', () => {
    const result = validateAvailabilityProposal(proposal());
    expect(result).toEqual({
      ok: true,
      installments: [
        { sequence: 1, date: '2026-11-15', baseUnits: 15_000, source: 'AVAILABLE_STOCK' },
        { sequence: 2, date: '2026-11-30', baseUnits: 9_000, source: 'FUTURE_SUPPLY' },
      ],
      stockAllocationBaseUnits: 15_000,
      committedDate: '2026-11-30',
    });
  });

  it('supports more than two shipments', () => {
    const result = validateAvailabilityProposal(
      proposal({
        installments: [
          { date: '2026-11-15', baseUnits: 10_000 },
          { date: '2026-11-22', baseUnits: 8_000 },
          { date: '2026-11-30', baseUnits: 6_000 },
        ],
      }),
    );
    expect(result.ok && result.installments.length).toBe(3);
  });

  it('is refused when the shipments do not add up to the request', () => {
    expect(
      codes(
        proposal({
          installments: [
            { date: '2026-11-15', baseUnits: 15_000 },
            { date: '2026-11-30', baseUnits: 8_000 },
          ],
        }),
      ),
    ).toContain('SUM_MISMATCH');
  });

  it('is refused when a shipment is zero or negative', () => {
    expect(
      codes(
        proposal({
          installments: [
            { date: '2026-11-15', baseUnits: 24_000 },
            { date: '2026-11-30', baseUnits: 0 },
          ],
        }),
      ),
    ).toContain('QUANTITY_INVALID');
    expect(
      codes(
        proposal({
          installments: [
            { date: '2026-11-15', baseUnits: 25_000 },
            { date: '2026-11-30', baseUnits: -1_000 },
          ],
        }),
      ),
    ).toContain('QUANTITY_INVALID');
  });

  it('is refused when the first shipment is more than is available now', () => {
    expect(
      codes(
        proposal({
          installments: [
            { date: '2026-11-15', baseUnits: 16_000 },
            { date: '2026-11-30', baseUnits: 8_000 },
          ],
        }),
      ),
    ).toContain('EXCEEDS_AVAILABLE');
  });

  it('is refused when a later shipment is not on a later date', () => {
    expect(
      codes(
        proposal({
          installments: [
            { date: '2026-11-30', baseUnits: 15_000 },
            { date: '2026-11-15', baseUnits: 9_000 },
          ],
        }),
      ),
    ).toContain('NOT_LATER');
  });

  it('is refused with one shipment, or with nothing available to split off', () => {
    expect(codes(proposal({ installments: [{ date: '2026-11-30', baseUnits: 24_000 }] }))).toContain(
      'TOO_FEW',
    );
    expect(codes(proposal({ availableToPromise: 0 }))).toContain('NOTHING_AVAILABLE_NOW');
  });

  it('is refused when the first shipment is not from stock on hand', () => {
    expect(
      codes(
        proposal({
          installments: [
            { date: '2026-11-15', baseUnits: 15_000, source: 'FUTURE_SUPPLY' },
            { date: '2026-11-30', baseUnits: 9_000 },
          ],
        }),
      ),
    ).toContain('FIRST_NOT_FROM_STOCK');
  });
});

describe('the offer expiry', () => {
  it('gives the buyer at least an hour and no more than the configured ceiling', () => {
    expect(codes(proposal({ expiresAt: new Date(now.getTime() + 30 * 60_000) }))).toContain(
      'EXPIRY_TOO_SOON',
    );
    expect(codes(proposal({ expiresAt: new Date(now.getTime() + 800 * 3_600_000) }))).toContain(
      'EXPIRY_TOO_LATE',
    );
  });
});

describe('the terms hash', () => {
  const terms: PreorderTerms = {
    requestId: 'R'.repeat(26),
    revision: 1,
    quantityBaseUnits: 24_000,
    unitPriceMinor: 9_000n,
    goodsTotalMinor: 216_000_000n,
    freightMinor: 0n,
    currency: 'INR',
    committedDeliveryDate: '2026-11-30',
    deliverySplits: null,
  };

  it('is unchanged for terms without a fulfilment plan, so older hashes still match', () => {
    expect(canonicalTerms(terms)).not.toContain('fulfilment');
  });

  it('changes when the schedule or the stock allocation changes', () => {
    const plan = (allocation: number) =>
      termsHash({
        ...terms,
        fulfilment: {
          kind: 'SPLIT_DELIVERY',
          stockAllocationBaseUnits: allocation,
          installments: [
            { sequence: 1, date: '2026-11-15', baseUnits: 15_000, source: 'AVAILABLE_STOCK' },
            { sequence: 2, date: '2026-11-30', baseUnits: 9_000, source: 'FUTURE_SUPPLY' },
          ],
        },
      });
    expect(plan(15_000)).not.toBe(plan(14_000));
    expect(plan(15_000)).not.toBe(termsHash(terms));
  });
});
