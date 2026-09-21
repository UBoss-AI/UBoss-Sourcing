/**
 * Who may hand which parcel to whom.
 *
 * Every rule in the seller half of the fulfilment split, tested without a
 * database. The reason these are worth testing individually rather than only
 * through the endpoint: each one is a way for a seller to create an obligation
 * on a carrier who never agreed to it, and the endpoint test would only ever
 * exercise whichever one happened to fire first.
 */
import { describe, expect, it } from 'vitest';
import {
  canSellerOfferToCarrier,
  canTransitionLink,
  explainSellerCarrierRefusal,
  linkAllowsExistingWork,
  transitionRequiresReason,
  type CarrierFacts,
  type SellerCarrierLink,
  type ShipmentFacts,
} from '../../src/domain/seller-logistics.js';

const NOW = new Date('2026-09-21T12:00:00.000Z');

function link(overrides: Partial<SellerCarrierLink> = {}): SellerCarrierLink {
  return {
    status: 'APPROVED',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
    archivedAt: null,
    serviceCountries: null,
    approvedCapabilities: null,
    ...overrides,
  };
}

function carrier(overrides: Partial<CarrierFacts> = {}): CarrierFacts {
  return { status: 'ACTIVE', archivedAt: null, ...overrides };
}

function shipment(overrides: Partial<ShipmentFacts> = {}): ShipmentFacts {
  return {
    originCountry: 'PL',
    destinationCountry: 'PL',
    requiredCapabilities: [],
    ...overrides,
  };
}

describe('the ordinary case', () => {
  it('allows an approved, in-date arrangement with an active carrier', () => {
    expect(canSellerOfferToCarrier(link(), carrier(), shipment(), NOW)).toEqual({ allowed: true });
  });
});

describe('the arrangement itself', () => {
  it('refuses a carrier the seller has no arrangement with', () => {
    // The default state for every seller and every carrier. An empty table
    // means nobody can offer anything, which is the correct starting point.
    expect(canSellerOfferToCarrier(null, carrier(), shipment(), NOW)).toEqual({
      allowed: false,
      refusal: 'NOT_LINKED',
    });
  });

  it('refuses an archived arrangement as though it were absent', () => {
    expect(
      canSellerOfferToCarrier(link({ archivedAt: NOW }), carrier(), shipment(), NOW),
    ).toMatchObject({ refusal: 'NOT_LINKED' });
  });

  it('refuses a request nobody has approved yet', () => {
    // The gate that makes approval mean anything. A seller who could offer
    // work the moment they asked would make the queue decorative.
    expect(
      canSellerOfferToCarrier(link({ status: 'REQUESTED' }), carrier(), shipment(), NOW),
    ).toMatchObject({ refusal: 'LINK_NOT_APPROVED' });
  });

  it('refuses a rejected and an ended arrangement', () => {
    for (const status of ['REJECTED', 'ENDED'] as const) {
      expect(
        canSellerOfferToCarrier(link({ status }), carrier(), shipment(), NOW),
        status,
      ).toMatchObject({ refusal: 'LINK_NOT_APPROVED' });
    }
  });

  it('reports a suspension as its own reason, not as "not approved"', () => {
    // They lead to different actions: one is a conversation with the
    // marketplace about a suspension, the other is a request that was never
    // made. Collapsing them sends the seller to the wrong screen.
    expect(
      canSellerOfferToCarrier(link({ status: 'SUSPENDED' }), carrier(), shipment(), NOW),
    ).toMatchObject({ refusal: 'LINK_SUSPENDED' });
  });
});

describe('effective dates', () => {
  it('refuses an arrangement that has not started', () => {
    expect(
      canSellerOfferToCarrier(
        link({ effectiveFrom: new Date('2026-12-01T00:00:00.000Z') }),
        carrier(),
        shipment(),
        NOW,
      ),
    ).toMatchObject({ refusal: 'LINK_NOT_IN_EFFECT' });
  });

  it('refuses one that has lapsed, without anybody running a job', () => {
    // A fixed-term contract stops being offerable at midnight because the
    // check reads the clock, not because a sweep got round to it.
    expect(
      canSellerOfferToCarrier(
        link({ effectiveTo: new Date('2026-09-01T00:00:00.000Z') }),
        carrier(),
        shipment(),
        NOW,
      ),
    ).toMatchObject({ refusal: 'LINK_NOT_IN_EFFECT' });
  });

  it('treats the end instant as already over', () => {
    expect(
      canSellerOfferToCarrier(link({ effectiveTo: NOW }), carrier(), shipment(), NOW),
    ).toMatchObject({ refusal: 'LINK_NOT_IN_EFFECT' });
  });

  it('allows one that is still running', () => {
    expect(
      canSellerOfferToCarrier(
        link({ effectiveTo: new Date('2026-12-31T00:00:00.000Z') }),
        carrier(),
        shipment(),
        NOW,
      ),
    ).toEqual({ allowed: true });
  });
});

describe('the carrier overrides the arrangement', () => {
  it('refuses a suspended carrier however old the arrangement is', () => {
    // An approval granted last year cannot grant an exception to a suspension
    // imposed this morning.
    expect(
      canSellerOfferToCarrier(link(), carrier({ status: 'SUSPENDED' }), shipment(), NOW),
    ).toMatchObject({ refusal: 'PARTNER_NOT_ACTIVE' });
  });

  it('refuses an archived carrier', () => {
    expect(
      canSellerOfferToCarrier(link(), carrier({ archivedAt: NOW }), shipment(), NOW),
    ).toMatchObject({ refusal: 'PARTNER_NOT_ACTIVE' });
  });
});

describe('agreed countries narrow, never widen', () => {
  it('allows a route inside the agreed list', () => {
    expect(
      canSellerOfferToCarrier(
        link({ serviceCountries: ['PL', 'DE'] }),
        carrier(),
        shipment({ originCountry: 'PL', destinationCountry: 'DE' }),
        NOW,
      ),
    ).toEqual({ allowed: true });
  });

  it('checks BOTH ends of the route', () => {
    // A carrier agreed for Poland has not agreed to take a parcel from Poland
    // to Portugal. Checking only the destination - the obvious implementation
    // - lets exactly that through.
    expect(
      canSellerOfferToCarrier(
        link({ serviceCountries: ['PL'] }),
        carrier(),
        shipment({ originCountry: 'PL', destinationCountry: 'PT' }),
        NOW,
      ),
    ).toMatchObject({ refusal: 'OUTSIDE_AGREED_COUNTRIES' });

    expect(
      canSellerOfferToCarrier(
        link({ serviceCountries: ['PL'] }),
        carrier(),
        shipment({ originCountry: 'PT', destinationCountry: 'PL' }),
        NOW,
      ),
    ).toMatchObject({ refusal: 'OUTSIDE_AGREED_COUNTRIES' });
  });

  it('is case-insensitive about country codes', () => {
    expect(
      canSellerOfferToCarrier(
        link({ serviceCountries: ['pl'] }),
        carrier(),
        shipment({ originCountry: 'PL', destinationCountry: 'PL' }),
        NOW,
      ),
    ).toEqual({ allowed: true });
  });

  it('treats a null list as the carrier own coverage, not as none', () => {
    // The common case. Duplicating the carrier's declared regions per seller
    // would be a second copy to keep in step.
    expect(
      canSellerOfferToCarrier(
        link({ serviceCountries: null }),
        carrier(),
        shipment({ originCountry: 'JP', destinationCountry: 'BR' }),
        NOW,
      ),
    ).toEqual({ allowed: true });
  });
});

describe('agreed capabilities narrow, never widen', () => {
  it('allows a consignment needing nothing special', () => {
    expect(
      canSellerOfferToCarrier(
        link({ approvedCapabilities: ['INTERNATIONAL'] }),
        carrier(),
        shipment({ requiredCapabilities: [] }),
        NOW,
      ),
    ).toEqual({ allowed: true });
  });

  it('refuses a consignment needing handling the arrangement does not cover', () => {
    expect(
      canSellerOfferToCarrier(
        link({ approvedCapabilities: ['INTERNATIONAL'] }),
        carrier(),
        shipment({ requiredCapabilities: ['COLD_CHAIN_2_8'] }),
        NOW,
      ),
    ).toMatchObject({ refusal: 'CAPABILITY_NOT_AGREED' });
  });

  it('requires every capability, not merely one of them', () => {
    expect(
      canSellerOfferToCarrier(
        link({ approvedCapabilities: ['COLD_CHAIN_2_8'] }),
        carrier(),
        shipment({ requiredCapabilities: ['COLD_CHAIN_2_8', 'DANGEROUS_GOODS'] }),
        NOW,
      ),
    ).toMatchObject({ refusal: 'CAPABILITY_NOT_AGREED' });
  });
});

describe('the reason a seller is shown', () => {
  it('is the most general true one', () => {
    // A suspended carrier whose arrangement ALSO does not cover the route
    // should be reported as suspended. Telling the seller about the route
    // sends them to negotiate a coverage change that would not help.
    const verdict = canSellerOfferToCarrier(
      link({ serviceCountries: ['DE'] }),
      carrier({ status: 'SUSPENDED' }),
      shipment({ originCountry: 'PL', destinationCountry: 'PL' }),
      NOW,
    );

    expect(verdict).toMatchObject({ refusal: 'PARTNER_NOT_ACTIVE' });
  });

  it('never discloses why the carrier itself is suspended', () => {
    // That is between the carrier and the marketplace. A seller learning it
    // from a dropdown is a disclosure nobody authorised.
    const message = explainSellerCarrierRefusal('PARTNER_NOT_ACTIVE', 'Vistula Freight');

    expect(message).toContain('Vistula Freight');
    expect(message.toLowerCase()).not.toContain('suspend');
  });

  it('gives a distinct sentence for every refusal', () => {
    const refusals = [
      'NOT_LINKED',
      'LINK_NOT_APPROVED',
      'LINK_SUSPENDED',
      'LINK_NOT_IN_EFFECT',
      'PARTNER_NOT_ACTIVE',
      'OUTSIDE_AGREED_COUNTRIES',
      'CAPABILITY_NOT_AGREED',
    ] as const;

    const messages = refusals.map((refusal) => explainSellerCarrierRefusal(refusal, 'Acme'));

    expect(new Set(messages).size).toBe(refusals.length);
    for (const message of messages) expect(message).toContain('Acme');
  });
});

describe('suspension versus ending', () => {
  it('lets a suspended arrangement finish what it holds', () => {
    // The whole reason the two states are separate. Ending an arrangement the
    // other way would strand every parcel already on a van.
    expect(linkAllowsExistingWork('SUSPENDED')).toBe(true);
    expect(linkAllowsExistingWork('APPROVED')).toBe(true);
  });

  it('does not let an ended or refused one carry anything', () => {
    expect(linkAllowsExistingWork('ENDED')).toBe(false);
    expect(linkAllowsExistingWork('REJECTED')).toBe(false);
    expect(linkAllowsExistingWork('REQUESTED')).toBe(false);
  });
});

describe('status transitions', () => {
  it('allows the decisions the approvals queue makes', () => {
    expect(canTransitionLink('REQUESTED', 'APPROVED')).toBe(true);
    expect(canTransitionLink('REQUESTED', 'REJECTED')).toBe(true);
    expect(canTransitionLink('APPROVED', 'SUSPENDED')).toBe(true);
    expect(canTransitionLink('SUSPENDED', 'APPROVED')).toBe(true);
    expect(canTransitionLink('APPROVED', 'ENDED')).toBe(true);
  });

  it('refuses an approval that skips the request', () => {
    expect(canTransitionLink('REJECTED', 'APPROVED')).toBe(false);
    expect(canTransitionLink('ENDED', 'APPROVED')).toBe(false);
  });

  it('lets a seller ask again after a refusal or an ending', () => {
    // Which moves the one row back to REQUESTED rather than creating a second
    // arrangement that could disagree with the first.
    expect(canTransitionLink('REJECTED', 'REQUESTED')).toBe(true);
    expect(canTransitionLink('ENDED', 'REQUESTED')).toBe(true);
  });

  it('refuses a no-op transition', () => {
    expect(canTransitionLink('APPROVED', 'APPROVED')).toBe(false);
  });

  it('demands a reason for every adverse decision', () => {
    expect(transitionRequiresReason('REJECTED')).toBe(true);
    expect(transitionRequiresReason('SUSPENDED')).toBe(true);
    expect(transitionRequiresReason('ENDED')).toBe(true);
    // An approval needs no justification; a refusal does.
    expect(transitionRequiresReason('APPROVED')).toBe(false);
  });
});
