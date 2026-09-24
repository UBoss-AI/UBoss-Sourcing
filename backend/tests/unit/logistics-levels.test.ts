/**
 * The four delivery levels, as pure rules: who controls each one in each
 * mode, what an entered price means, what a carrier can do, how a route is
 * priced, and the order the legs move in.
 */
import { describe, expect, it } from 'vitest';
import {
  assertLegTransition,
  carrierProblem,
  checkEnteredPrice,
  deliveryTotal,
  levelPricingStatus,
  ownersForMode,
  ownershipChanged,
  partnerMayCarryLevel,
  policyForLevelChange,
  policyShapeProblem,
  providerConnectionState,
  rateIsComplete,
  resolveRoute,
  type LevelOwners,
  type RouteRate,
} from '../../src/domain/logistics-levels.js';

describe('who controls each level', () => {
  it('Self gives the seller all four levels', () => {
    expect(ownersForMode('SELF', { l2Owner: 'UBOSS', l3Owner: 'UBOSS', l4Owner: 'UBOSS' })).toEqual({
      L1: 'SELLER',
      L2: 'SELLER',
      L3: 'SELLER',
      L4: 'SELLER',
    });
  });

  it('UBOSS keeps L1 with the seller and gives UBOSS L2 to L4', () => {
    expect(ownersForMode('UBOSS', { l2Owner: 'SELLER', l3Owner: 'SELLER', l4Owner: 'SELLER' })).toEqual({
      L1: 'SELLER',
      L2: 'UBOSS',
      L3: 'UBOSS',
      L4: 'UBOSS',
    });
  });

  it('Self + UBOSS keeps what the seller chose for each of L2 to L4', () => {
    // The example from the brief: seller on L2 and L4, UBOSS on L3.
    expect(ownersForMode('HYBRID', { l2Owner: 'SELLER', l3Owner: 'UBOSS', l4Owner: 'SELLER' })).toEqual({
      L1: 'SELLER',
      L2: 'SELLER',
      L3: 'UBOSS',
      L4: 'SELLER',
    });
  });

  it('never lets L1 go to UBOSS, in any mode', () => {
    for (const mode of ['SELF', 'UBOSS', 'HYBRID'] as const) {
      expect(
        policyShapeProblem({ mode, l1Owner: 'UBOSS', l2Owner: 'UBOSS', l3Owner: 'UBOSS', l4Owner: 'UBOSS' }),
      ).toBe('L1_OWNER_FIXED');
    }
  });

  it('refuses Self + UBOSS with the seller on all three of L2, L3 and L4', () => {
    expect(policyShapeProblem({ mode: 'HYBRID', l2Owner: 'SELLER', l3Owner: 'SELLER', l4Owner: 'SELLER' })).toBe(
      'HYBRID_ALL_SELLER',
    );
  });

  it('accepts every Self + UBOSS choice that leaves at least one level with UBOSS', () => {
    const owners = ['SELLER', 'UBOSS'] as const;
    for (const l2 of owners) {
      for (const l3 of owners) {
        for (const l4 of owners) {
          const problem = policyShapeProblem({ mode: 'HYBRID', l2Owner: l2, l3Owner: l3, l4Owner: l4 });
          const allSeller = l2 === 'SELLER' && l3 === 'SELLER' && l4 === 'SELLER';
          expect(problem).toBe(allSeller ? 'HYBRID_ALL_SELLER' : null);
        }
      }
    }
  });

  it('refuses owners the mode does not allow', () => {
    expect(policyShapeProblem({ mode: 'SELF', l2Owner: 'SELLER', l3Owner: 'UBOSS', l4Owner: 'SELLER' })).toBe(
      'MODE_OWNERS_MISMATCH',
    );
    expect(policyShapeProblem({ mode: 'UBOSS', l2Owner: 'UBOSS', l3Owner: 'SELLER', l4Owner: 'UBOSS' })).toBe(
      'MODE_OWNERS_MISMATCH',
    );
  });

  it('notices when a level moves to a different owner', () => {
    const before: LevelOwners = { L1: 'SELLER', L2: 'SELLER', L3: 'UBOSS', L4: 'SELLER' };
    expect(ownershipChanged(before, { ...before })).toBe(false);
    expect(ownershipChanged(before, { ...before, L3: 'SELLER' })).toBe(true);
  });
});

describe('an entered price', () => {
  it('treats empty as not priced, never as zero', () => {
    expect(checkEnteredPrice({ amountMinor: '', isFree: false, freeConfirmed: false })).toEqual({
      amountMinor: null,
      problem: null,
    });
    expect(checkEnteredPrice({ amountMinor: null, isFree: false, freeConfirmed: false }).amountMinor).toBeNull();
  });

  it('refuses zero unless the level is marked free', () => {
    expect(checkEnteredPrice({ amountMinor: '0', isFree: false, freeConfirmed: false }).problem).toBe('ZERO_WITHOUT_FREE');
  });

  it('needs an explicit confirmation for free delivery', () => {
    expect(checkEnteredPrice({ amountMinor: null, isFree: true, freeConfirmed: false }).problem).toBe('FREE_NOT_CONFIRMED');
    expect(checkEnteredPrice({ amountMinor: null, isFree: true, freeConfirmed: true })).toEqual({
      amountMinor: 0n,
      problem: null,
    });
  });

  it('refuses a free level that also carries an amount', () => {
    expect(checkEnteredPrice({ amountMinor: '500', isFree: true, freeConfirmed: true }).problem).toBe('FREE_WITH_AMOUNT');
  });

  it('keeps minor units exact and refuses decimals and negatives', () => {
    expect(checkEnteredPrice({ amountMinor: '10000', isFree: false, freeConfirmed: false }).amountMinor).toBe(10000n);
    expect(checkEnteredPrice({ amountMinor: '100.5', isFree: false, freeConfirmed: false }).problem).toBe('NOT_A_NUMBER');
    expect(checkEnteredPrice({ amountMinor: '-1', isFree: false, freeConfirmed: false }).problem).toBe('NEGATIVE');
  });

  it('is complete only with a price and a carrier', () => {
    expect(rateIsComplete({ amountMinor: null, isFree: false, provider: 'DHL', logisticsPartnerId: null })).toBe(false);
    expect(rateIsComplete({ amountMinor: 100n, isFree: false, provider: null, logisticsPartnerId: null })).toBe(false);
    expect(rateIsComplete({ amountMinor: 100n, isFree: false, provider: 'DHL', logisticsPartnerId: null })).toBe(true);
    expect(rateIsComplete({ amountMinor: 0n, isFree: true, provider: 'MANUAL', logisticsPartnerId: null })).toBe(true);
  });

  it('reports a level with no price as the owner’s job', () => {
    const empty = { publishedCount: 0, draftCount: 0, readyDraftCount: 0, inactiveCount: 0 };
    expect(levelPricingStatus({ owner: 'SELLER', ...empty })).toBe('PRICE_REQUIRED');
    expect(levelPricingStatus({ owner: 'UBOSS', ...empty })).toBe('PENDING_UBOSS_PRICE');
    expect(levelPricingStatus({ owner: 'SELLER', ...empty, draftCount: 1, readyDraftCount: 1 })).toBe('READY');
    expect(levelPricingStatus({ owner: 'SELLER', ...empty, publishedCount: 1 })).toBe('PUBLISHED');
  });
});

describe('what a carrier can do', () => {
  it('does not treat DHL or FedEx as an ocean-container service', () => {
    expect(carrierProblem({ level: 'L2', carrier: 'DHL', transportMode: 'SEA', packageClass: 'CONTAINER' })).toBe(
      'CARRIER_CANNOT_DO_MODE',
    );
    expect(carrierProblem({ level: 'L2', carrier: 'FEDEX', transportMode: 'SEA', packageClass: null })).toBe(
      'CARRIER_CANNOT_DO_MODE',
    );
    expect(carrierProblem({ level: 'L2', carrier: 'DHL', transportMode: 'AIR', packageClass: 'PARCEL' })).toBeNull();
  });

  it('lets a forwarder booked by hand carry a container by sea', () => {
    expect(carrierProblem({ level: 'L2', carrier: 'MANUAL', transportMode: 'SEA', packageClass: 'CONTAINER' })).toBeNull();
  });

  it('keeps India Post to post and parcels', () => {
    expect(carrierProblem({ level: 'L4', carrier: 'INDIA_POST', transportMode: 'POSTAL', packageClass: 'PARCEL' })).toBeNull();
    expect(carrierProblem({ level: 'L4', carrier: 'INDIA_POST', transportMode: 'POSTAL', packageClass: 'PALLET' })).toBe(
      'CARRIER_CANNOT_TAKE_PACKAGE',
    );
  });

  it('refuses a way of moving goods the level does not use', () => {
    expect(carrierProblem({ level: 'L1', carrier: 'MANUAL', transportMode: 'SEA', packageClass: null })).toBe('MODE_NOT_ON_LEVEL');
  });
});

describe('a carrier with no credentials', () => {
  it('is MANUAL_ONLY when switched on, and never CONNECTED', () => {
    for (const provider of [null, 'NOT_CONFIGURED', 'MANUAL_MODE_AVAILABLE'] as const) {
      expect(providerConnectionState({ setupStatus: provider, enabled: true, requestedMode: 'MANUAL_ONLY' })).toBe('MANUAL_ONLY');
    }
  });

  it('is NOT_CONFIGURED when nobody switched it on', () => {
    expect(providerConnectionState({ setupStatus: null, enabled: false, requestedMode: null })).toBe('NOT_CONFIGURED');
  });

  it('asks for credentials when an API account was declared without a key', () => {
    expect(providerConnectionState({ setupStatus: 'CREDENTIALS_REQUIRED', enabled: true, requestedMode: 'API' })).toBe(
      'CREDENTIALS_REQUIRED',
    );
  });

  it('is CONNECTED only when the carrier setup itself says so', () => {
    expect(providerConnectionState({ setupStatus: 'CONNECTED', enabled: true, requestedMode: 'API' })).toBe('CONNECTED');
    expect(providerConnectionState({ setupStatus: 'PAUSED', enabled: true, requestedMode: 'API' })).toBe('MANUAL_ONLY');
  });
});

// --- Route pricing -------------------------------------------------------------

function rate(partial: Partial<RouteRate> & Pick<RouteRate, 'id' | 'level' | 'amountMinor'>): RouteRate {
  return {
    owner: 'SELLER',
    originLocationId: null,
    originPortCode: null,
    destinationPortCode: null,
    destinationHubCode: null,
    destinationHubName: null,
    destinationCountry: null,
    destinationPostalPrefix: '',
    packageClass: null,
    minWeightGrams: null,
    maxWeightGrams: null,
    isWorldwideFlat: false,
    currency: 'INR',
    publishedAt: new Date('2026-09-01T00:00:00Z'),
    ...partial,
  };
}

const SELF: LevelOwners = { L1: 'SELLER', L2: 'SELLER', L3: 'SELLER', L4: 'SELLER' };

/** The brief's fixture: L1 100, L2 200, L3 300, L4 400, Mumbai to Rotterdam. */
const FIXTURE = [
  rate({ id: 'L1-BOM', level: 'L1', amountMinor: 10_000n, originLocationId: 'PLANT', originPortCode: 'INNSA' }),
  rate({ id: 'L2-NL', level: 'L2', amountMinor: 20_000n, originPortCode: 'INNSA', destinationPortCode: 'NLRTM', destinationCountry: 'NL' }),
  rate({ id: 'L3-NL', level: 'L3', amountMinor: 30_000n, destinationPortCode: 'NLRTM', destinationHubCode: 'RTM-DC', destinationCountry: 'NL' }),
  rate({ id: 'L4-NL', level: 'L4', amountMinor: 40_000n, destinationHubCode: 'RTM-DC', destinationCountry: 'NL' }),
  // A different route, to Dubai. It must never price the Rotterdam basket.
  rate({ id: 'L2-AE', level: 'L2', amountMinor: 99_000n, originPortCode: 'INNSA', destinationPortCode: 'AEJEA', destinationCountry: 'AE' }),
];

describe('pricing a route', () => {
  it('adds L1 + L2 + L3 + L4 to the delivery total', () => {
    const route = resolveRoute(FIXTURE, SELF, {
      originLocationId: 'PLANT',
      destinationCountry: 'NL',
      destinationPostcode: '3011 AA',
      weightGrams: null,
      packageClass: 'PARCEL',
    });
    expect(route.map((step) => step.rate?.id)).toEqual(['L1-BOM', 'L2-NL', 'L3-NL', 'L4-NL']);

    const delivery = deliveryTotal(route.map((step) => step.rate?.amountMinor ?? 0n));
    expect(delivery).toBe(100_000n); // ₹1,000
    // Product subtotal ₹10,000 + delivery ₹1,000 = ₹11,000.
    expect(1_000_000n + delivery).toBe(1_100_000n);
  });

  it('never lets another route’s price leak in', () => {
    const route = resolveRoute(FIXTURE, SELF, {
      originLocationId: 'PLANT',
      destinationCountry: 'DE',
      destinationPostcode: null,
      weightGrams: null,
      packageClass: 'PARCEL',
    });
    // Nothing is priced to Germany beyond L1, and the Dubai and Rotterdam
    // prices are not borrowed for it.
    expect(route.map((step) => step.rate?.id ?? null)).toEqual(['L1-BOM', null, null, null]);
  });

  it('does not treat a price with no destination as worldwide unless it says so', () => {
    const vague = [rate({ id: 'L4-ANY', level: 'L4', amountMinor: 5_000n })];
    const flat = [rate({ id: 'L4-FLAT', level: 'L4', amountMinor: 5_000n, isWorldwideFlat: true })];
    const request = { originLocationId: null, destinationCountry: 'NL', destinationPostcode: null, weightGrams: null, packageClass: null };

    expect(resolveRoute(vague, SELF, request)[3]?.rate).toBeNull();
    expect(resolveRoute(flat, SELF, request)[3]?.rate?.id).toBe('L4-FLAT');
  });

  it('only uses prices set by whoever controls the level now', () => {
    const owners: LevelOwners = { L1: 'SELLER', L2: 'SELLER', L3: 'UBOSS', L4: 'SELLER' };
    const route = resolveRoute(FIXTURE, owners, {
      originLocationId: 'PLANT',
      destinationCountry: 'NL',
      destinationPostcode: null,
      weightGrams: null,
      packageClass: null,
    });
    // The seller's old L3 price is ignored: UBOSS controls L3 and has none.
    expect(route[2]?.rate).toBeNull();
    expect(route[2]?.owner).toBe('UBOSS');
  });

  it('prefers the longer postcode prefix and a weight band only matches a known weight', () => {
    const rates = [
      rate({ id: 'NL', level: 'L4', amountMinor: 1n, destinationCountry: 'NL' }),
      rate({ id: 'NL-30', level: 'L4', amountMinor: 2n, destinationCountry: 'NL', destinationPostalPrefix: '30' }),
      rate({ id: 'NL-30-HEAVY', level: 'L4', amountMinor: 3n, destinationCountry: 'NL', destinationPostalPrefix: '30', minWeightGrams: 50_000 }),
    ];
    const base = { originLocationId: null, destinationCountry: 'NL', packageClass: null } as const;
    expect(resolveRoute(rates, SELF, { ...base, destinationPostcode: '3011AA', weightGrams: null })[3]?.rate?.id).toBe('NL-30');
    expect(resolveRoute(rates, SELF, { ...base, destinationPostcode: '1011AA', weightGrams: null })[3]?.rate?.id).toBe('NL');
    expect(resolveRoute(rates, SELF, { ...base, destinationPostcode: '3011AA', weightGrams: 80_000 })[3]?.rate?.id).toBe('NL-30-HEAVY');
  });
});

describe('the order the legs move in', () => {
  it('lets a leg start only when it is its turn', () => {
    expect(() => assertLegTransition('PENDING', 'IN_PROGRESS', 'OWNER')).toThrow();
    expect(() => assertLegTransition('PENDING', 'AWAITING_ASSIGNMENT', 'SYSTEM')).not.toThrow();
  });

  it('lets the partner accept, start and hand over, and the owner not accept for it', () => {
    expect(() => assertLegTransition('ASSIGNED', 'ACCEPTED', 'PARTNER')).not.toThrow();
    expect(() => assertLegTransition('ASSIGNED', 'ACCEPTED', 'OWNER')).toThrow();
    expect(() => assertLegTransition('ACCEPTED', 'IN_PROGRESS', 'PARTNER')).not.toThrow();
    expect(() => assertLegTransition('IN_PROGRESS', 'COMPLETED', 'PARTNER')).not.toThrow();
  });

  it('never moves a finished leg', () => {
    expect(() => assertLegTransition('COMPLETED', 'IN_PROGRESS', 'OWNER')).toThrow();
    expect(() => assertLegTransition('CANCELLED', 'ASSIGNED', 'OWNER')).toThrow();
  });
});

describe('who may carry a level', () => {
  const SELLER_ID = 'S'.repeat(26);
  const partner = (overrides: Partial<Parameters<typeof partnerMayCarryLevel>[2] & object> = {}) => ({
    status: 'ACTIVE',
    archivedAt: null,
    partnerKind: 'MARKETPLACE_CARRIER' as const,
    ownerSellerAccountId: null,
    sellerLinkStatuses: [] as string[],
    ...overrides,
  });

  it('gives a UBOSS level only to a marketplace carrier, never a seller’s own fleet', () => {
    expect(partnerMayCarryLevel('UBOSS', SELLER_ID, partner())).toBe(true);
    expect(
      partnerMayCarryLevel('UBOSS', SELLER_ID, partner({ partnerKind: 'SELLER_SELF_MANAGED', ownerSellerAccountId: SELLER_ID })),
    ).toBe(false);
    expect(
      partnerMayCarryLevel('UBOSS', SELLER_ID, partner({ partnerKind: 'SELLER_DEDICATED', sellerLinkStatuses: ['APPROVED'] })),
    ).toBe(false);
  });

  it('gives a seller level to the seller’s own operation or an approved company only', () => {
    expect(partnerMayCarryLevel('SELLER', SELLER_ID, partner({ partnerKind: 'SELLER_SELF_MANAGED', ownerSellerAccountId: SELLER_ID }))).toBe(true);
    expect(partnerMayCarryLevel('SELLER', SELLER_ID, partner({ sellerLinkStatuses: ['APPROVED'] }))).toBe(true);
    expect(partnerMayCarryLevel('SELLER', SELLER_ID, partner({ sellerLinkStatuses: ['PENDING'] }))).toBe(false);
    expect(partnerMayCarryLevel('SELLER', SELLER_ID, partner())).toBe(false);
  });

  it('never names a suspended, archived or missing company', () => {
    expect(partnerMayCarryLevel('UBOSS', SELLER_ID, partner({ status: 'SUSPENDED' }))).toBe(false);
    expect(partnerMayCarryLevel('UBOSS', SELLER_ID, partner({ archivedAt: new Date() }))).toBe(false);
    expect(partnerMayCarryLevel('SELLER', SELLER_ID, null)).toBe(false);
  });
});

describe('one level’s checkbox', () => {
  const SELF_OWNERS: LevelOwners = { L1: 'SELLER', L2: 'SELLER', L3: 'SELLER', L4: 'SELLER' };
  const UBOSS_OWNERS: LevelOwners = { L1: 'SELLER', L2: 'UBOSS', L3: 'UBOSS', L4: 'UBOSS' };

  it('keeps a Self or UBOSS policy in its mode when the box already says so', () => {
    expect(policyForLevelChange({ mode: 'SELF', owners: SELF_OWNERS }, 'L3', 'SELLER')).toEqual({
      mode: 'SELF',
      l2Owner: 'SELLER',
      l3Owner: 'SELLER',
      l4Owner: 'SELLER',
    });
    expect(policyForLevelChange({ mode: 'UBOSS', owners: UBOSS_OWNERS }, 'L2', 'UBOSS').mode).toBe('UBOSS');
  });

  it('keeps the mode for L1 too, so ticking L1 never changes a published mode', () => {
    expect(policyForLevelChange({ mode: 'SELF', owners: SELF_OWNERS }, 'L1', 'SELLER')).toEqual({
      mode: 'SELF',
      l1Owner: 'SELLER',
      l2Owner: 'SELLER',
      l3Owner: 'SELLER',
      l4Owner: 'SELLER',
    });
    expect(policyForLevelChange({ mode: 'UBOSS', owners: UBOSS_OWNERS }, 'L1', 'SELLER').mode).toBe('UBOSS');
  });

  it('passes an L1 hand-over to UBOSS through, to be refused', () => {
    const shape = policyForLevelChange({ mode: 'UBOSS', owners: UBOSS_OWNERS }, 'L1', 'UBOSS');
    expect(policyShapeProblem(shape)).toBe('L1_OWNER_FIXED');
  });

  it('makes a level moved out of Self or UBOSS the mixed mode', () => {
    expect(policyForLevelChange({ mode: 'SELF', owners: SELF_OWNERS }, 'L3', 'UBOSS')).toEqual({
      mode: 'HYBRID',
      l2Owner: 'SELLER',
      l3Owner: 'UBOSS',
      l4Owner: 'SELLER',
    });
    expect(policyForLevelChange({ mode: 'UBOSS', owners: UBOSS_OWNERS }, 'L4', 'SELLER')).toEqual({
      mode: 'HYBRID',
      l2Owner: 'UBOSS',
      l3Owner: 'UBOSS',
      l4Owner: 'SELLER',
    });
  });

  it('keeps a mixed policy mixed, so the seller on all three is still refused', () => {
    const shape = policyForLevelChange(
      { mode: 'HYBRID', owners: { L1: 'SELLER', L2: 'SELLER', L3: 'UBOSS', L4: 'SELLER' } },
      'L3',
      'SELLER',
    );
    expect(shape.mode).toBe('HYBRID');
    expect(policyShapeProblem(shape)).toBe('HYBRID_ALL_SELLER');
  });
});
