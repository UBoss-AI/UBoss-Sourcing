/**
 * How a seller's own goods get delivered.
 *
 * Every rule that decides which of a seller's methods carries a consignment,
 * tested without a database. Worth testing individually rather than only
 * through the endpoint for the same reason the carrier rules are: each of
 * these is a way for a parcel to leave by a route nobody approved, and an
 * endpoint test only ever exercises whichever rule happened to fire first.
 *
 * Two of these tests exist because of a specific way this goes wrong in
 * production, and they are marked where they appear:
 *
 *   - a seller pauses their primary method and every rule still points at it
 *   - a rule matches on a postcode that arrives formatted differently
 */
import { describe, expect, it } from 'vitest';
import {
  FULFILMENT_MODE_PROFILES,
  assertMethodTransition,
  canTransitionMethod,
  defaultTrackingModeFor,
  describeMethodStatus,
  driversAreManagedHere,
  explainMethodRefusal,
  hasVerifiedOfficialApi,
  methodAcceptsNewWork,
  methodAllowsExistingWork,
  methodKeyFor,
  methodTransitionRequiresReason,
  normalisePostalPrefix,
  precedenceForScope,
  refuseMethod,
  ruleKeyFor,
  selectFulfilmentMethod,
  type CandidateMethod,
  type CandidateRule,
  type ConsignmentNeeds,
  type RuleContext,
} from '../../src/domain/seller-fulfilment.js';

const NOW = new Date('2026-09-22T12:00:00.000Z');

function method(overrides: Partial<CandidateMethod> = {}): CandidateMethod {
  return {
    id: 'method-a',
    mode: 'SELF_MANAGED',
    status: 'APPROVED',
    role: 'ADDITIONAL',
    publicDisplayName: 'Our own vans',
    allowsInternational: false,
    targetIsLive: true,
    serviceCountries: null,
    approvedCapabilities: null,
    maxWeightGrams: null,
    ...overrides,
  };
}

function rule(overrides: Partial<CandidateRule> = {}): CandidateRule {
  return {
    id: 'rule-a',
    scope: 'SELLER_DEFAULT',
    precedence: 40,
    fulfilmentMethodId: 'method-a',
    isActive: true,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    note: null,
    sellerOfferId: null,
    sellerLocationId: null,
    destinationCountry: null,
    destinationPostalPrefix: null,
    ...overrides,
  };
}

function needs(overrides: Partial<ConsignmentNeeds> = {}): ConsignmentNeeds {
  return {
    originCountry: 'IN',
    destinationCountry: 'IN',
    requiredCapabilities: [],
    weightGrams: 2000,
    ...overrides,
  };
}

function context(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    sellerOfferIds: ['offer-1'],
    sellerLocationId: 'location-1',
    destinationCountry: 'IN',
    destinationPostalCode: '110001',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('who does what', () => {
  it('never manages drivers for an external carrier', () => {
    // The single most important row in the matrix. DHL's couriers are DHL's
    // staff; a screen offering to assign one would be inventing a person.
    expect(driversAreManagedHere('INTEGRATED_CARRIER')).toBe(false);
  });

  it('manages drivers for the two modes whose fleet is inside this portal', () => {
    expect(driversAreManagedHere('SELF_MANAGED')).toBe(true);
    expect(driversAreManagedHere('DEDICATED_PARTNER')).toBe(true);
  });

  it('leaves the operator mode exactly as it was', () => {
    expect(FULFILMENT_MODE_PROFILES.OPERATOR_FULFILLED).toEqual({
      mode: 'OPERATOR_FULFILLED',
      storage: 'OPERATOR',
      packing: 'OPERATOR',
      carrierSelection: 'OPERATOR',
      driversManagedHere: true,
      requiresSellerCredentials: false,
      requiresMarketplaceApproval: false,
    });
  });

  it('asks for credentials only where the seller has an account of their own', () => {
    expect(FULFILMENT_MODE_PROFILES.INTEGRATED_CARRIER.requiresSellerCredentials).toBe(true);
    expect(FULFILMENT_MODE_PROFILES.SELF_MANAGED.requiresSellerCredentials).toBe(false);
  });
});

describe('what a provider can honestly claim', () => {
  it('does not claim an official API for India Post', () => {
    // The whole India Post posture in one assertion. If this ever returns
    // true without a contract behind it, a screen starts saying "connected"
    // about something nobody connected.
    expect(hasVerifiedOfficialApi('INDIA_POST')).toBe(false);
    expect(defaultTrackingModeFor('INDIA_POST')).toBe('EXTERNAL_LINK');
  });

  it('starts the manual provider on manual tracking', () => {
    expect(defaultTrackingModeFor('MANUAL')).toBe('MANUAL_ENTRY');
    expect(hasVerifiedOfficialApi('MANUAL')).toBe(false);
  });

  it('allows automatic tracking for the three carriers that publish an API', () => {
    for (const provider of ['DHL', 'FEDEX', 'UPS'] as const) {
      expect(defaultTrackingModeFor(provider)).toBe('AUTOMATIC_API');
      expect(hasVerifiedOfficialApi(provider)).toBe(true);
    }
  });
});

describe('the surrogate keys', () => {
  it('keeps a sandbox account and a production account apart', () => {
    // Two different accounts at the same carrier. One key for both would make
    // a seller unable to hold a test connection and a live one at once.
    expect(methodKeyFor({ mode: 'INTEGRATED_CARRIER', provider: 'DHL', environment: 'SANDBOX' })).toBe(
      'CARRIER:DHL:SANDBOX',
    );
    expect(
      methodKeyFor({ mode: 'INTEGRATED_CARRIER', provider: 'DHL', environment: 'PRODUCTION' }),
    ).toBe('CARRIER:DHL:PRODUCTION');
  });

  it('gives a draft method a key that stops a seller creating two of them', () => {
    expect(methodKeyFor({ mode: 'SELF_MANAGED', logisticsPartnerId: null })).toBe(
      'PENDING:SELF_MANAGED',
    );
  });

  it('refuses an integrated-carrier key with no provider', () => {
    expect(() => methodKeyFor({ mode: 'INTEGRATED_CARRIER' })).toThrow();
  });

  it('numbers precedence exactly as the database CHECK constraint does', () => {
    // These four numbers are duplicated in
    // `chk_seller_fulfilment_rule_precedence`. A change here without a
    // migration makes every insert fail, which is the failure direction to
    // want - but this test is what names the reason.
    expect(precedenceForScope('PRODUCT')).toBe(10);
    expect(precedenceForScope('WAREHOUSE')).toBe(20);
    expect(precedenceForScope('DESTINATION')).toBe(30);
    expect(precedenceForScope('SELLER_DEFAULT')).toBe(40);
  });

  it('normalises a postcode prefix so formatting cannot stop a rule matching', () => {
    // The production failure this exists for: the same district arrives as
    // "SW1", "sw1 " and "SW-1" from three different address forms, and a rule
    // silently stops applying the day somebody types a space.
    expect(normalisePostalPrefix('sw1 ')).toBe('SW1');
    expect(normalisePostalPrefix('SW-1')).toBe('SW1');
    expect(ruleKeyFor({ scope: 'DESTINATION', destinationCountry: 'gb', destinationPostalPrefix: 'sw1' })).toBe(
      'DESTINATION:GB:SW1',
    );
  });

  it('gives every default rule the same key, so a seller can only have one', () => {
    expect(ruleKeyFor({ scope: 'SELLER_DEFAULT' })).toBe('DEFAULT');
  });
});

describe('the state machine', () => {
  it('lets a refused method be fixed and tried again', () => {
    // REJECTED is not terminal on purpose: the seller moves this one row back
    // rather than creating a second, so "how does this seller ship" always has
    // one answer.
    expect(canTransitionMethod('REJECTED', 'PENDING_SETUP')).toBe(true);
  });

  it('makes disconnection terminal', () => {
    for (const to of ['DRAFT', 'PENDING_SETUP', 'APPROVED', 'PAUSED'] as const) {
      expect(canTransitionMethod('DISCONNECTED', to)).toBe(false);
    }
  });

  it('refuses a move nothing defines', () => {
    expect(() => {
      assertMethodTransition('DRAFT', 'APPROVED', null);
    }).toThrow(/cannot move/);
  });

  it('refuses a move to the status it is already in', () => {
    expect(() => {
      assertMethodTransition('APPROVED', 'APPROVED', null);
    }).toThrow(/already/);
  });

  it('demands a reason for the three states somebody will ask about', () => {
    for (const to of ['REJECTED', 'CHANGES_REQUESTED', 'PAUSED'] as const) {
      expect(methodTransitionRequiresReason(to)).toBe(true);
    }

    expect(methodTransitionRequiresReason('APPROVED')).toBe(false);
  });

  it('refuses a pause with no reason', () => {
    expect(() => {
      assertMethodTransition('APPROVED', 'PAUSED', '   ');
    }).toThrow(/needs a reason/);
  });

  it('accepts a pause with one', () => {
    expect(() => {
      assertMethodTransition('APPROVED', 'PAUSED', 'Van off the road until Friday.');
    }).not.toThrow();
  });

  it('lets a paused method finish what it holds but take nothing new', () => {
    // The distinction PAUSED exists for. Stopping it the other way would
    // strand every parcel already on a van.
    expect(methodAcceptsNewWork('PAUSED')).toBe(false);
    expect(methodAllowsExistingWork('PAUSED')).toBe(true);
  });

  it('describes a status in words rather than as a stored token', () => {
    expect(describeMethodStatus('PENDING_APPROVAL')).toBe('with us for review');
    expect(describeMethodStatus('PENDING_SETUP')).toBe('waiting for you to finish setting it up');
  });
});

describe('whether one method can carry one consignment', () => {
  it('allows the ordinary case', () => {
    expect(refuseMethod(method(), needs())).toBeNull();
  });

  it('refuses a method that is not approved', () => {
    expect(refuseMethod(method({ status: 'PENDING_APPROVAL' }), needs())).toBe('NOT_APPROVED');
  });

  it('refuses a method whose connection is not live', () => {
    expect(refuseMethod(method({ targetIsLive: false }), needs())).toBe('CONNECTION_NOT_ACTIVE');
  });

  it('refuses a cross-border consignment on a method not set up for one', () => {
    expect(
      refuseMethod(method(), needs({ originCountry: 'IN', destinationCountry: 'DE' })),
    ).toBe('INTERNATIONAL_NOT_ENABLED');
  });

  it('checks both ends of the journey against the service area', () => {
    // A method set up to collect in India and deliver in India has not agreed
    // to take a parcel from India to Germany, and checking only the
    // destination would let exactly that through.
    const crossBorder = method({ serviceCountries: ['IN'], allowsInternational: true });

    expect(refuseMethod(crossBorder, needs({ destinationCountry: 'DE' }))).toBe(
      'OUTSIDE_SERVICE_AREA',
    );
  });

  it('treats an unconfigured service area as no restriction rather than as none', () => {
    // An empty service-area table means "nobody has said", not "nowhere".
    expect(refuseMethod(method({ serviceCountries: null }), needs())).toBeNull();
  });

  it('refuses handling the method is not approved for', () => {
    expect(
      refuseMethod(
        method({ approvedCapabilities: ['STANDARD_DELIVERY'] }),
        needs({ requiredCapabilities: ['COLD_CHAIN_2_8'] }),
      ),
    ).toBe('CAPABILITY_MISSING');
  });

  it('compares capabilities without caring about case', () => {
    expect(
      refuseMethod(
        method({ approvedCapabilities: ['cold_chain_2_8'] }),
        needs({ requiredCapabilities: ['COLD_CHAIN_2_8'] }),
      ),
    ).toBeNull();
  });

  it('refuses a consignment heavier than the method takes', () => {
    expect(refuseMethod(method({ maxWeightGrams: 1000 }), needs({ weightGrams: 2000 }))).toBe(
      'EXCEEDS_LIMITS',
    );
  });

  it('gives the most general true reason first', () => {
    // A method that is both unapproved and out of area is reported as
    // unapproved: sending the seller to fix their service area when the real
    // problem is that nobody approved it wastes their afternoon.
    const broken = method({ status: 'DRAFT', serviceCountries: ['DE'] });

    expect(refuseMethod(broken, needs())).toBe('NOT_APPROVED');
  });

  it('explains a refusal without disclosing another tenant state', () => {
    const message = explainMethodRefusal('CONNECTION_NOT_ACTIVE', 'MediCourier');

    expect(message).toContain('MediCourier');
    expect(message).not.toMatch(/suspend|terminat|breach/i);
  });
});

describe('picking a method for a consignment', () => {
  it('prefers a product rule over the seller default', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({ id: 'default', scope: 'SELLER_DEFAULT', precedence: 40, fulfilmentMethodId: 'van' }),
        rule({
          id: 'product',
          scope: 'PRODUCT',
          precedence: 10,
          fulfilmentMethodId: 'courier',
          sellerOfferId: 'offer-1',
        }),
      ],
      [
        method({ id: 'van', publicDisplayName: 'Our own vans' }),
        method({ id: 'courier', publicDisplayName: 'MediCourier' }),
      ],
      needs(),
      context(),
      NOW,
    );

    expect(selection).toMatchObject({
      chosen: true,
      source: 'AUTOMATIC_RULE',
      ruleId: 'product',
    });
    expect(selection.chosen && selection.method.id).toBe('courier');
  });

  it('runs the hierarchy in the documented order', () => {
    const rules = [
      rule({ id: 'default', scope: 'SELLER_DEFAULT', precedence: 40, fulfilmentMethodId: 'd' }),
      rule({
        id: 'destination',
        scope: 'DESTINATION',
        precedence: 30,
        fulfilmentMethodId: 'c',
        destinationCountry: 'IN',
      }),
      rule({
        id: 'warehouse',
        scope: 'WAREHOUSE',
        precedence: 20,
        fulfilmentMethodId: 'b',
        sellerLocationId: 'location-1',
      }),
    ];

    const methods = [
      method({ id: 'b' }),
      method({ id: 'c' }),
      method({ id: 'd' }),
    ];

    const selection = selectFulfilmentMethod(rules, methods, needs(), context(), NOW);

    expect(selection.chosen && selection.ruleId).toBe('warehouse');
  });

  it('falls past a rule whose method has been paused', () => {
    // THE PRODUCTION FAILURE THIS EXISTS FOR. A seller pauses their primary
    // method on a Friday afternoon; every rule they ever wrote still points at
    // it. Without this, Monday's orders stop rather than falling through to
    // something that works.
    const selection = selectFulfilmentMethod(
      [
        rule({
          id: 'product',
          scope: 'PRODUCT',
          precedence: 10,
          fulfilmentMethodId: 'paused',
          sellerOfferId: 'offer-1',
        }),
        rule({ id: 'default', scope: 'SELLER_DEFAULT', precedence: 40, fulfilmentMethodId: 'van' }),
      ],
      [
        method({ id: 'paused', status: 'PAUSED', publicDisplayName: 'MediCourier' }),
        method({ id: 'van', publicDisplayName: 'Our own vans' }),
      ],
      needs(),
      context(),
      NOW,
    );

    expect(selection.chosen && selection.method.id).toBe('van');
  });

  it('matches a destination rule on a postcode prefix', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({
          id: 'delhi',
          scope: 'DESTINATION',
          precedence: 30,
          fulfilmentMethodId: 'city',
          destinationCountry: 'IN',
          destinationPostalPrefix: '1100',
        }),
      ],
      [method({ id: 'city' })],
      needs(),
      context({ destinationPostalCode: '110001' }),
      NOW,
    );

    expect(selection.chosen && selection.ruleId).toBe('delhi');
  });

  it('does not match a destination rule whose prefix is for somewhere else', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({
          id: 'mumbai',
          scope: 'DESTINATION',
          precedence: 30,
          fulfilmentMethodId: 'city',
          destinationCountry: 'IN',
          destinationPostalPrefix: '4000',
        }),
      ],
      [method({ id: 'city', role: 'PRIMARY' })],
      needs(),
      context({ destinationPostalCode: '110001' }),
      NOW,
    );

    // No rule matched, so it lands on the primary - by role, not by rule.
    expect(selection).toMatchObject({ chosen: true, source: 'SELLER_DEFAULT', ruleId: null });
  });

  it('ignores a rule that is not yet in effect', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({
          id: 'future',
          scope: 'PRODUCT',
          precedence: 10,
          fulfilmentMethodId: 'courier',
          sellerOfferId: 'offer-1',
          effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
        }),
      ],
      [method({ id: 'courier', role: 'PRIMARY', publicDisplayName: 'MediCourier' })],
      needs(),
      context(),
      NOW,
    );

    expect(selection.chosen && selection.ruleId).toBeNull();
  });

  it('uses the fallback only when the primary genuinely cannot take it', () => {
    const selection = selectFulfilmentMethod(
      [],
      [
        method({ id: 'primary', role: 'PRIMARY', status: 'PAUSED' }),
        method({ id: 'fallback', role: 'FALLBACK', publicDisplayName: 'Backup courier' }),
      ],
      needs(),
      context(),
      NOW,
    );

    expect(selection).toMatchObject({ chosen: true, source: 'FALLBACK' });
    expect(selection.chosen && selection.method.id).toBe('fallback');
  });

  it('uses a seller with one approved method and no rules at all', () => {
    // Day one for every seller. Refusing them because they never pressed
    // "make this primary" would be refusing them over a checkbox.
    const selection = selectFulfilmentMethod([], [method({ id: 'only' })], needs(), context(), NOW);

    expect(selection.chosen && selection.method.id).toBe('only');
  });

  it('refuses rather than picking something unapproved when nothing is eligible', () => {
    // A parcel that waits is recoverable. A parcel sent by a carrier that is
    // not allowed to hold it is not.
    const selection = selectFulfilmentMethod(
      [],
      [
        method({ id: 'a', status: 'PENDING_APPROVAL', publicDisplayName: 'MediCourier' }),
        method({ id: 'b', targetIsLive: false, publicDisplayName: 'Our own vans' }),
      ],
      needs(),
      context(),
      NOW,
    );

    expect(selection.chosen).toBe(false);
    expect(!selection.chosen && selection.considered).toEqual([
      { methodId: 'a', name: 'MediCourier', refusal: 'NOT_APPROVED' },
      { methodId: 'b', name: 'Our own vans', refusal: 'CONNECTION_NOT_ACTIVE' },
    ]);
  });

  it('lists each rejected method once, however many rules named it', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({ id: 'r1', scope: 'PRODUCT', precedence: 10, fulfilmentMethodId: 'a', sellerOfferId: 'offer-1' }),
        rule({ id: 'r2', scope: 'SELLER_DEFAULT', precedence: 40, fulfilmentMethodId: 'a' }),
      ],
      [method({ id: 'a', status: 'REJECTED' })],
      needs(),
      context(),
      NOW,
    );

    expect(!selection.chosen && selection.considered).toHaveLength(1);
  });

  it('carries the seller own words into the reason where they wrote any', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({
          id: 'cold',
          scope: 'PRODUCT',
          precedence: 10,
          fulfilmentMethodId: 'a',
          sellerOfferId: 'offer-1',
          note: 'Reagents always go by MediCourier.',
        }),
      ],
      [method({ id: 'a' })],
      needs(),
      context(),
      NOW,
    );

    expect(selection.chosen && selection.reason).toBe('Reagents always go by MediCourier.');
  });

  it('writes a readable reason where the seller wrote none', () => {
    const selection = selectFulfilmentMethod(
      [
        rule({
          id: 'warehouse',
          scope: 'WAREHOUSE',
          precedence: 20,
          fulfilmentMethodId: 'a',
          sellerLocationId: 'location-1',
        }),
      ],
      [method({ id: 'a', publicDisplayName: 'Our own vans' })],
      needs(),
      context(),
      NOW,
    );

    expect(selection.chosen && selection.reason).toBe(
      'Warehouse rule: anything leaving this place ships by Our own vans.',
    );
  });

  it('resolves two rules of the same scope the same way every time', () => {
    // Without a stable tie-break the answer depends on row order, which
    // changes when a seller edits something unrelated.
    const rules = [
      rule({ id: 'zzz', scope: 'PRODUCT', precedence: 10, fulfilmentMethodId: 'b', sellerOfferId: 'offer-1' }),
      rule({ id: 'aaa', scope: 'PRODUCT', precedence: 10, fulfilmentMethodId: 'a', sellerOfferId: 'offer-1' }),
    ];

    const methods = [method({ id: 'a' }), method({ id: 'b' })];

    const first = selectFulfilmentMethod(rules, methods, needs(), context(), NOW);
    const second = selectFulfilmentMethod([...rules].reverse(), methods, needs(), context(), NOW);

    expect(first.chosen && first.ruleId).toBe('aaa');
    expect(second.chosen && second.ruleId).toBe('aaa');
  });
});
