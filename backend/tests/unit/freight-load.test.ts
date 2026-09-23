/**
 * Which carrier may be asked to carry what.
 *
 * The failure this guards against is not an API error. It is an API SUCCESS: a
 * parcel carrier answering a container request with a price for something
 * nobody will ever collect. The buyer is charged it, the pallet sits on the
 * dock, and the difference is found when somebody rings to ask where it is.
 */
import { describe, expect, it } from 'vitest';
import {
  LOAD_TYPE_ORDER,
  consignmentLoadType,
  loadTypeForPackage,
  needsManualFreight,
  providerLoadTypes,
  providerSupportsLoad,
  requiredCapabilityFor,
  routeConsignment,
} from '../../src/domain/freight-load.js';

describe('what load a package is', () => {
  it('maps each package type to its transport', () => {
    expect(loadTypeForPackage('CARTON', null)).toBe('CARTON');
    expect(loadTypeForPackage('UK_PALLET', null)).toBe('PALLET');
    expect(loadTypeForPackage('US_PALLET', null)).toBe('PALLET');
  });

  it('tells a full container from a shared one, because they are different services', () => {
    // A full container is a box handed over sealed; a part container is goods
    // consolidated with somebody else's at a depot. A carrier commonly does
    // one and not the other.
    expect(loadTypeForPackage('CONTAINER', 'FCL')).toBe('FCL');
    expect(loadTypeForPackage('CONTAINER', 'LCL')).toBe('LCL');
  });

  it('treats a container with no stated mode as full', () => {
    // The safer of the two: FCL is the more restrictive capability, so an
    // unstated mode cannot accidentally widen who may carry it.
    expect(loadTypeForPackage('CONTAINER', null)).toBe('FCL');
  });
});

describe('a mixed consignment', () => {
  it('takes the HEAVIEST load, not the commonest', () => {
    // One pallet and forty loose units is a pallet shipment: the pallet has to
    // go on a lorry whatever else is on the order, and quoting it as a parcel
    // because most of the lines are parcels is the exact mistake this module
    // exists to prevent.
    expect(consignmentLoadType(['PARCEL', 'PARCEL', 'PARCEL', 'PALLET'])).toBe('PALLET');
    expect(consignmentLoadType(['CARTON', 'PALLET', 'FCL'])).toBe('FCL');
    expect(consignmentLoadType(['LCL', 'PALLET'])).toBe('LCL');
  });

  it('is a parcel when nothing else is on it', () => {
    expect(consignmentLoadType([])).toBe('PARCEL');
    expect(consignmentLoadType(['PARCEL'])).toBe('PARCEL');
  });

  it('orders the load types lightest to heaviest', () => {
    expect(LOAD_TYPE_ORDER).toEqual(['PARCEL', 'CARTON', 'PALLET', 'LCL', 'FCL']);
  });
});

describe('what each carrier integration can express', () => {
  it('lets the parcel carriers carry parcels and cartons only', () => {
    // A statement about the ADAPTER, not about the company. DHL Freight moves
    // pallets across Europe every day; DHL's adapter here builds a parcel
    // request against the Express API and cannot describe a pallet booking.
    for (const provider of ['DHL', 'FEDEX', 'UPS', 'INDIA_POST']) {
      expect(providerSupportsLoad(provider, 'PARCEL')).toBe(true);
      expect(providerSupportsLoad(provider, 'CARTON')).toBe(true);
      expect(providerSupportsLoad(provider, 'PALLET')).toBe(false);
      expect(providerSupportsLoad(provider, 'FCL')).toBe(false);
      expect(providerSupportsLoad(provider, 'LCL')).toBe(false);
    }
  });

  it('lets MANUAL and CUSTOM carry everything, which is honest rather than lax', () => {
    // MANUAL means a person books it by telephone and types the reference in;
    // CUSTOM means the operator wired up an API themselves. Neither is a
    // fabricated quote - both end in a human entering a real figure.
    for (const provider of ['MANUAL', 'CUSTOM']) {
      for (const load of LOAD_TYPE_ORDER) {
        expect(providerSupportsLoad(provider, load)).toBe(true);
      }
    }
  });

  it('refuses a provider it has never heard of', () => {
    expect(providerSupportsLoad('SOMETHING_NEW', 'PARCEL')).toBe(false);
    expect(providerLoadTypes('SOMETHING_NEW')).toEqual([]);
  });
});

describe('what capability a load needs of a delivery company', () => {
  it('asks nothing of a parcel', () => {
    // Carrying parcels is what a carrier IS. Requiring a capability for it
    // would make every existing carrier ineligible for the work it already
    // does.
    expect(requiredCapabilityFor('PARCEL')).toBeNull();
    expect(requiredCapabilityFor('CARTON')).toBeNull();
  });

  it('asks for PALLET on pallet freight', () => {
    expect(requiredCapabilityFor('PALLET')).toBe('PALLET');
  });

  it('asks for INTERNATIONAL on a container, not OVERSIZED', () => {
    // A container is not an awkward parcel. What matters is whether the
    // company handles international freight at all.
    expect(requiredCapabilityFor('FCL')).toBe('INTERNATIONAL');
    expect(requiredCapabilityFor('LCL')).toBe('INTERNATIONAL');
  });
});

describe('routing a consignment', () => {
  it('lets a parcel go by a parcel carrier', () => {
    expect(
      routeConsignment({
        loadType: 'PARCEL',
        provider: 'DHL',
        approvedCapabilities: [],
        hasMethod: true,
      }),
    ).toEqual({ kind: 'CARRIER_OK' });
  });

  it('sends a pallet on DHL for a quotation rather than to the API', () => {
    // The whole feature in one assertion. Asking DHL's Express adapter to
    // price a pallet either errors, or - worse - answers.
    expect(
      routeConsignment({
        loadType: 'PALLET',
        provider: 'DHL',
        approvedCapabilities: ['PALLET'],
        hasMethod: true,
      }),
    ).toEqual({ kind: 'QUOTE_REQUIRED', reason: 'PROVIDER_CANNOT_CARRY' });
  });

  it('sends a container for a quotation however capable the carrier claims to be', () => {
    expect(
      routeConsignment({
        loadType: 'FCL',
        provider: 'FEDEX',
        approvedCapabilities: ['INTERNATIONAL', 'PALLET'],
        hasMethod: true,
      }).kind,
    ).toBe('QUOTE_REQUIRED');
  });

  it('lets a pallet through on a seller own operation that has the capability', () => {
    // No provider, because there is no API to be limited by - which is exactly
    // why a seller with their own lorry can move a pallet through this system.
    expect(
      routeConsignment({
        loadType: 'PALLET',
        provider: null,
        approvedCapabilities: ['PALLET'],
        hasMethod: true,
      }),
    ).toEqual({ kind: 'CARRIER_OK' });
  });

  it('stops a pallet on an operation that has not been approved for pallets', () => {
    expect(
      routeConsignment({
        loadType: 'PALLET',
        provider: null,
        approvedCapabilities: ['NEXT_DAY'],
        hasMethod: true,
      }),
    ).toEqual({ kind: 'QUOTE_REQUIRED', reason: 'CAPABILITY_MISSING' });
  });

  it('says so plainly when there is nothing at all to carry it', () => {
    expect(
      routeConsignment({
        loadType: 'PARCEL',
        provider: 'DHL',
        approvedCapabilities: [],
        hasMethod: false,
      }),
    ).toEqual({ kind: 'QUOTE_REQUIRED', reason: 'NO_METHOD' });
  });
});

describe('needsManualFreight', () => {
  it('is true for everything a parcel network cannot take', () => {
    expect(needsManualFreight('PALLET')).toBe(true);
    expect(needsManualFreight('FCL')).toBe(true);
    expect(needsManualFreight('LCL')).toBe(true);
  });

  it('is false for the two a courier handles', () => {
    expect(needsManualFreight('PARCEL')).toBe(false);
    expect(needsManualFreight('CARTON')).toBe(false);
  });
});
