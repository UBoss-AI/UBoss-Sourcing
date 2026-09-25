/**
 * The preorder rules, exhaustively, without a database.
 *
 * These are the verdicts the product page's button, the form, the preview and
 * the submission all reach by calling the same functions - so a mistake here
 * is a mistake everywhere at once, and the place to catch it is here.
 */
import { describe, expect, it } from 'vitest';

import {
  baseUnitsFor,
  canonicalTerms,
  capacityPeriodKey,
  checkDeliveryDate,
  checkDeliverySplits,
  checkPreorderQuantity,
  indicativePrice,
  orderableUnits,
  preorderDeliveryWindow,
  quantityRulesFor,
  resolvePolicy,
  termsHash,
  type PolicyTerms,
} from '../../src/domain/preorder.js';
import {
  AWAITING_BUYER,
  HOLDS_CAPACITY,
  allowedPreorderTransitions,
  assertPreorderTransition,
  canTransitionPreorder,
} from '../../src/domain/preorder-state.js';

function policy(overrides: Partial<PolicyTerms> = {}): PolicyTerms {
  return {
    id: 'P'.repeat(26),
    scope: 'OFFER',
    version: 1,
    isEnabled: true,
    moqUnit: 'PIECE',
    moqQuantity: 1000,
    incrementQuantity: 100,
    maxQuantity: null,
    capacityBaseUnits: null,
    capacityPeriod: 'MONTH',
    safetyStockBaseUnits: 0,
    minLeadTimeDays: null,
    maxAdvanceDays: null,
    deliveryCountries: [],
    eligibleLocationIds: [],
    packagingTypes: null,
    pricingMode: 'QUOTE_REQUIRED',
    allowPartialFulfilment: false,
    allowSplitDelivery: false,
    requestExpiryHours: null,
    offerExpiryHours: null,
    cancellationTerms: null,
    specialInstructions: null,
    tiers: [],
    ...overrides,
  };
}

describe('which policy applies', () => {
  it('takes the most specific level that exists, whole', () => {
    const chain = [
      { scope: 'SELLER_DEFAULT' as const, id: 'seller' },
      { scope: 'OFFER' as const, id: 'offer' },
      { scope: 'PRODUCT' as const, id: 'product' },
    ];
    expect(resolvePolicy(chain)?.id).toBe('offer');
    expect(resolvePolicy(chain.filter((row) => row.scope !== 'OFFER'))?.id).toBe('product');
    expect(resolvePolicy(chain.filter((row) => row.scope === 'SELLER_DEFAULT'))?.id).toBe('seller');
  });

  it('answers nothing, rather than a platform MOQ, when no level exists', () => {
    expect(resolvePolicy([])).toBeNull();
  });
});

describe('the minimum, in pieces', () => {
  it('converts a pallet minimum and its step through the same pallet size', () => {
    const result = quantityRulesFor(
      policy({ moqUnit: 'UK_PALLET', moqQuantity: 10, incrementQuantity: 2 }),
      { PIECE: 1, UK_PALLET: 1200 },
    );
    expect(result.rules).toEqual({
      minimumBaseUnits: 12_000,
      incrementBaseUnits: 2_400,
      maximumBaseUnits: null,
    });
  });

  it('refuses a minimum set in a unit the offer has no active packaging for', () => {
    const result = quantityRulesFor(policy({ moqUnit: 'CONTAINER', moqQuantity: 1 }), { PIECE: 1 });
    expect(result.rules).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain('moqUnit');
  });

  it('refuses a policy with no minimum instead of inventing one', () => {
    const result = quantityRulesFor(policy({ moqQuantity: null }), { PIECE: 1 });
    expect(result.rules).toBeNull();
    expect(result.issues.map((issue) => issue.field)).toContain('moqQuantity');
  });

  it('refuses fixed pricing with no price band', () => {
    const result = quantityRulesFor(policy({ pricingMode: 'FIXED', tiers: [] }), { PIECE: 1 });
    expect(result.rules).toBeNull();
  });
});

describe('quantity checks', () => {
  const rules = { minimumBaseUnits: 1000, incrementBaseUnits: 100, maximumBaseUnits: 50_000 };

  it('rejects below the minimum, naming it', () => {
    expect(checkPreorderQuantity(999, rules)).toEqual({
      code: 'BELOW_MINIMUM',
      minimumBaseUnits: 1000,
    });
  });

  it('rejects a quantity off the increment, counted from the minimum', () => {
    expect(checkPreorderQuantity(1050, rules)?.code).toBe('INCREMENT');
    expect(checkPreorderQuantity(1100, rules)).toBeNull();
  });

  it('counts the step from the minimum even when the minimum is not a multiple of it', () => {
    const odd = { minimumBaseUnits: 1000, incrementBaseUnits: 300, maximumBaseUnits: null };
    expect(checkPreorderQuantity(1000, odd)).toBeNull();
    expect(checkPreorderQuantity(1300, odd)).toBeNull();
    expect(checkPreorderQuantity(1200, odd)?.code).toBe('INCREMENT');
  });

  it('rejects above the maximum', () => {
    expect(checkPreorderQuantity(50_100, rules)?.code).toBe('ABOVE_MAXIMUM');
  });

  it('counts pieces through the chosen unit', () => {
    expect(baseUnitsFor(3, 'CARTON', { CARTON: 48 })).toBe(144);
    expect(baseUnitsFor(3, 'CARTON', {})).toBeNull();
    expect(baseUnitsFor(3, 'PIECE', {})).toBe(3);
  });

  it('offers only the units the policy permits and the offer has active', () => {
    const sizes = { PIECE: 1, CARTON: 48, UK_PALLET: 1200 };
    expect(orderableUnits(policy(), sizes)).toEqual(['PIECE', 'CARTON', 'UK_PALLET']);
    expect(orderableUnits(policy({ packagingTypes: ['UK_PALLET', 'CONTAINER'] }), sizes)).toEqual([
      'UK_PALLET',
    ]);
  });
});

describe('the earliest delivery date', () => {
  // 10:00 UTC on 24 September 2026.
  const now = new Date(Date.UTC(2026, 8, 24, 10, 0, 0));

  it('keeps the seven-day notice when nothing else is longer', () => {
    const window = preorderDeliveryWindow({
      timezone: 'Europe/Amsterdam',
      minNoticeDays: 7,
      productionLeadDays: 3,
      routeLeadDays: 2,
      maxAdvanceDays: null,
      now,
    });
    expect(window.earliest).toBe('2026-10-01');
    expect(window.decidedBy).toBe('NOTICE');
  });

  it('moves later for the production lead time', () => {
    const window = preorderDeliveryWindow({
      timezone: 'Europe/Amsterdam',
      minNoticeDays: 7,
      productionLeadDays: 45,
      routeLeadDays: 10,
      maxAdvanceDays: null,
      now,
    });
    expect(window.earliest).toBe('2026-11-08');
    expect(window.decidedBy).toBe('PRODUCTION');
  });

  it('moves later for the route', () => {
    const window = preorderDeliveryWindow({
      timezone: 'UTC',
      minNoticeDays: 7,
      productionLeadDays: 5,
      routeLeadDays: 21,
      maxAdvanceDays: null,
      now,
    });
    expect(window.earliest).toBe('2026-10-15');
    expect(window.decidedBy).toBe('ROUTE');
  });

  it('counts on the buyer’s own clock: 23:30 UTC is already tomorrow in Kolkata', () => {
    const late = new Date(Date.UTC(2026, 8, 24, 23, 30, 0));
    const utc = preorderDeliveryWindow({
      timezone: 'UTC',
      minNoticeDays: 7,
      productionLeadDays: null,
      routeLeadDays: 0,
      maxAdvanceDays: null,
      now: late,
    });
    const kolkata = preorderDeliveryWindow({
      timezone: 'Asia/Kolkata',
      minNoticeDays: 7,
      productionLeadDays: null,
      routeLeadDays: 0,
      maxAdvanceDays: null,
      now: late,
    });
    expect(utc.earliest).toBe('2026-10-01');
    expect(kolkata.earliest).toBe('2026-10-02');
  });

  it('never allows today, even with no notice configured', () => {
    const window = preorderDeliveryWindow({
      timezone: 'UTC',
      minNoticeDays: 0,
      productionLeadDays: 0,
      routeLeadDays: 0,
      maxAdvanceDays: null,
      now,
    });
    expect(window.earliest).toBe('2026-09-25');
    expect(checkDeliveryDate('2026-09-24', window)?.code).toBe('TOO_EARLY');
  });

  it('refuses beyond the advance-booking window and a date that does not exist', () => {
    const window = preorderDeliveryWindow({
      timezone: 'UTC',
      minNoticeDays: 7,
      productionLeadDays: null,
      routeLeadDays: 0,
      maxAdvanceDays: 90,
      now,
    });
    expect(checkDeliveryDate('2026-12-24', window)?.code).toBe('TOO_FAR');
    expect(checkDeliveryDate('2026-02-30', window)?.code).toBe('INVALID');
    expect(checkDeliveryDate('2026-10-05', window)).toBeNull();
  });
});

describe('the indicative price', () => {
  const tiers = [
    { minBaseUnits: 1000, unitPriceMinor: 9_000n, currency: 'INR' },
    { minBaseUnits: 10_000, unitPriceMinor: 8_000n, currency: 'INR' },
  ];

  it('takes the highest band reached, in exact minor units', () => {
    const price = indicativePrice({
      pricingMode: 'FIXED',
      tiers,
      baseUnits: 12_000,
      offerUnitPriceMinor: 10_000n,
      offerCurrency: 'INR',
    });
    expect(price).toEqual({
      unitPriceMinor: 8_000n,
      goodsTotalMinor: 96_000_000n,
      tierMinBaseUnits: 10_000,
      currency: 'INR',
    });
  });

  it('gives no price at all under quote pricing', () => {
    expect(
      indicativePrice({
        pricingMode: 'QUOTE_REQUIRED',
        tiers,
        baseUnits: 12_000,
        offerUnitPriceMinor: 1n,
        offerCurrency: 'INR',
      }),
    ).toBeNull();
  });

  it('ignores a band priced in a currency the offer is not sold in', () => {
    const price = indicativePrice({
      pricingMode: 'FIXED',
      tiers: [{ minBaseUnits: 1, unitPriceMinor: 1n, currency: 'EUR' }],
      baseUnits: 5,
      offerUnitPriceMinor: 700n,
      offerCurrency: 'INR',
    });
    expect(price?.unitPriceMinor).toBe(700n);
    expect(price?.tierMinBaseUnits).toBeNull();
  });
});

describe('capacity periods', () => {
  it('buckets by day, ISO week and month', () => {
    expect(capacityPeriodKey('2026-12-15', 'DAY')).toBe('2026-12-15');
    expect(capacityPeriodKey('2026-12-15', 'MONTH')).toBe('2026-12');
    expect(capacityPeriodKey('2026-12-15', 'WEEK')).toBe('2026-W51');
  });

  it('puts the last days of December in week 1 of the next ISO year when they belong there', () => {
    // 31 December 2024 was a Tuesday, in ISO week 2025-W01.
    expect(capacityPeriodKey('2024-12-31', 'WEEK')).toBe('2025-W01');
    // 1 January 2027 is a Friday, in ISO week 2026-W53.
    expect(capacityPeriodKey('2027-01-01', 'WEEK')).toBe('2026-W53');
  });
});

describe('terms', () => {
  const terms = {
    requestId: 'R'.repeat(26),
    revision: 2,
    quantityBaseUnits: 12_000,
    unitPriceMinor: 8_000n,
    goodsTotalMinor: 96_000_000n,
    freightMinor: 1_500_000n,
    currency: 'INR',
    committedDeliveryDate: '2026-12-15',
    deliverySplits: null,
  };

  it('hashes the same terms to the same value, and any change to a different one', () => {
    expect(termsHash(terms)).toBe(termsHash({ ...terms }));
    expect(termsHash({ ...terms, unitPriceMinor: 7_999n })).not.toBe(termsHash(terms));
    expect(termsHash({ ...terms, committedDeliveryDate: '2026-12-16' })).not.toBe(termsHash(terms));
    expect(canonicalTerms(terms)).toContain('"unitPriceMinor":"8000"');
  });

  it('checks that split deliveries add up and end on the committed date', () => {
    expect(
      checkDeliverySplits(
        [
          { date: '2026-11-15', baseUnits: 6000 },
          { date: '2026-12-15', baseUnits: 6000 },
        ],
        12_000,
        '2026-12-15',
      ),
    ).toBeNull();
    expect(
      checkDeliverySplits([{ date: '2026-12-15', baseUnits: 12_000 }], 12_000, '2026-12-15'),
    ).not.toBeNull();
    expect(
      checkDeliverySplits(
        [
          { date: '2026-11-15', baseUnits: 6000 },
          { date: '2026-12-15', baseUnits: 5000 },
        ],
        12_000,
        '2026-12-15',
      ),
    ).toContain('add up');
    expect(
      checkDeliverySplits(
        [
          { date: '2026-11-15', baseUnits: 6000 },
          { date: '2026-12-10', baseUnits: 6000 },
        ],
        12_000,
        '2026-12-15',
      ),
    ).toContain('committed date');
  });
});

describe('the state machine', () => {
  it('never lets a seller move a request to anything the buyer pays for', () => {
    for (const from of [
      'SUBMITTED',
      'SELLER_ACCEPTED',
      'SELLER_COUNTERED',
      'SELLER_REVIEW_REQUIRED',
    ] as const) {
      const allowed = allowedPreorderTransitions(from, 'SELLER');
      expect(allowed).not.toContain('BUYER_CONFIRMED');
      expect(allowed).not.toContain('PAYMENT_REQUIRED');
      expect(allowed).not.toContain('CONFIRMED');
    }
  });

  it('lets only the system confirm, after payment', () => {
    for (const actor of ['BUYER', 'SELLER', 'ADMIN'] as const) {
      expect(canTransitionPreorder({ from: 'PAYMENT_REQUIRED', to: 'CONFIRMED', actor })).toBe(
        false,
      );
    }
    expect(
      canTransitionPreorder({ from: 'PAYMENT_REQUIRED', to: 'CONFIRMED', actor: 'SYSTEM' }),
    ).toBe(true);
  });

  it('requires the buyer, not the seller, to confirm an acceptance or a counter', () => {
    for (const from of AWAITING_BUYER) {
      expect(canTransitionPreorder({ from, to: 'BUYER_CONFIRMED', actor: 'BUYER' })).toBe(true);
      expect(canTransitionPreorder({ from, to: 'BUYER_CONFIRMED', actor: 'SELLER' })).toBe(false);
    }
  });

  it('never returns to negotiation once an order exists', () => {
    for (const from of HOLDS_CAPACITY) {
      for (const actor of ['BUYER', 'SELLER', 'SYSTEM', 'ADMIN'] as const) {
        const allowed = allowedPreorderTransitions(from, actor);
        for (const negotiating of [
          'SUBMITTED',
          'SELLER_ACCEPTED',
          'SELLER_COUNTERED',
          'SELLER_REVIEW_REQUIRED',
        ] as const) {
          expect(allowed).not.toContain(negotiating);
        }
      }
    }
  });

  it('demands a reason for a rejection', () => {
    expect(() => {
      assertPreorderTransition({ from: 'SUBMITTED', to: 'REJECTED', actor: 'SELLER', reason: '' });
    }).toThrow(/why/);
    expect(() => {
      assertPreorderTransition({
        from: 'SUBMITTED',
        to: 'REJECTED',
        actor: 'SELLER',
        reason: 'No capacity',
      });
    }).not.toThrow();
  });

  it('treats every terminal status as terminal', () => {
    for (const status of ['CONVERTED_TO_ORDER', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const) {
      for (const actor of ['BUYER', 'SELLER', 'SYSTEM', 'ADMIN'] as const) {
        expect(allowedPreorderTransitions(status, actor)).toEqual([]);
      }
    }
  });
});
