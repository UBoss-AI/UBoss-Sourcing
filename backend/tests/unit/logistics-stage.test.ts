/**
 * The stage every portal shows, the seller's reassignment window, and what a
 * carrier setup screen may claim.
 *
 * Pure functions, so every rule here is tested without a database. The
 * rules that matter most are the negative ones: nothing becomes CONNECTED
 * without a passed test, a refusal never reaches the buyer as a refusal, and
 * a collected parcel cannot be moved by the seller.
 */
import { describe, expect, it } from 'vitest';
import {
  assertShipmentTransition,
  canTransitionShipment,
  type ShipmentStatusName,
} from '../../src/domain/logistics-shipment-state.js';
import {
  customerDeliveryStage,
  logisticsStage,
  sellerHasConfirmed,
  sellerMayReassign,
  sellerOrderStage,
} from '../../src/domain/logistics-stage.js';
import {
  carrierFromMethodKey,
  carrierSetupStatus,
  methodKeyFor,
} from '../../src/domain/seller-fulfilment.js';
import { CREDENTIAL_FIELDS } from '../../src/modules/seller/carrier-credential.service.js';

const facts = (
  shipmentStatus: ShipmentStatusName,
  extra: Partial<Parameters<typeof logisticsStage>[0]> = {},
): Parameters<typeof logisticsStage>[0] => ({
  shipmentStatus,
  latestAssignmentState: null,
  hasActiveDriver: false,
  manualBookingStatus: null,
  ...extra,
});

describe('the provider a method is for', () => {
  it('reads each carrier back out of the key it was written with', () => {
    for (const provider of ['DHL', 'FEDEX', 'INDIA_POST'] as const) {
      const key = methodKeyFor({ mode: 'INTEGRATED_CARRIER', provider, environment: 'SANDBOX' });
      expect(carrierFromMethodKey(key)).toEqual({ provider, environment: 'SANDBOX' });
    }
  });

  it('never guesses: other modes and unknown keys have no provider', () => {
    expect(carrierFromMethodKey('OPERATOR')).toBeNull();
    expect(carrierFromMethodKey('PENDING:SELF_MANAGED')).toBeNull();
    expect(carrierFromMethodKey('CARRIER:ACME:SANDBOX')).toBeNull();
  });

  it('keeps FedEx FedEx: a FedEx key is never read as DHL', () => {
    const key = methodKeyFor({ mode: 'INTEGRATED_CARRIER', provider: 'FEDEX', environment: 'PRODUCTION' });
    expect(carrierFromMethodKey(key)?.provider).toBe('FEDEX');
  });
});

describe('what a carrier setup screen may claim', () => {
  const connection = (over: Partial<NonNullable<Parameters<typeof carrierSetupStatus>[0]['connection']>> = {}) => ({
    state: 'NOT_CONFIGURED',
    hasCredential: false,
    lastTestAt: null,
    lastTestPassedAt: null,
    ...over,
  });

  it('India Post is manual-only, whatever is stored', () => {
    expect(carrierSetupStatus({ provider: 'INDIA_POST', connection: null })).toBe('MANUAL_MODE_AVAILABLE');
    expect(
      carrierSetupStatus({ provider: 'INDIA_POST', connection: connection({ state: 'ACTIVE' }) }),
    ).toBe('MANUAL_MODE_AVAILABLE');
  });

  it('no account at all is NOT_CONFIGURED, and an account without a key is CREDENTIALS_REQUIRED', () => {
    expect(carrierSetupStatus({ provider: 'FEDEX', connection: null })).toBe('NOT_CONFIGURED');
    expect(carrierSetupStatus({ provider: 'FEDEX', connection: connection() })).toBe('CREDENTIALS_REQUIRED');
  });

  it('a saved key is not a connection: it is pending until a real test passes', () => {
    expect(
      carrierSetupStatus({
        provider: 'DHL',
        connection: connection({ state: 'CREDENTIALS_SET', hasCredential: true }),
      }),
    ).toBe('PENDING_VERIFICATION');
  });

  it('a failed test says so', () => {
    expect(
      carrierSetupStatus({
        provider: 'DHL',
        connection: connection({ state: 'CREDENTIALS_SET', hasCredential: true, lastTestAt: new Date() }),
      }),
    ).toBe('CONNECTION_FAILED');
    expect(carrierSetupStatus({ provider: 'DHL', connection: connection({ state: 'ERROR' }) })).toBe(
      'CONNECTION_FAILED',
    );
  });

  it('CONNECTED only when ACTIVE and a test passed; never from ACTIVE alone', () => {
    expect(
      carrierSetupStatus({ provider: 'FEDEX', connection: connection({ state: 'ACTIVE', hasCredential: true }) }),
    ).toBe('PENDING_VERIFICATION');
    expect(
      carrierSetupStatus({
        provider: 'FEDEX',
        connection: connection({ state: 'ACTIVE', hasCredential: true, lastTestPassedAt: new Date() }),
      }),
    ).toBe('CONNECTED');
  });

  it('the credential fields each carrier asks for are the ones its own screen labels', () => {
    // Held together with apps/customer-web/src/lib/carrier-providers.ts. If
    // this changes, that file's credentialFields must change with it.
    expect(CREDENTIAL_FIELDS['DHL']).toEqual(['apiKey', 'apiSecret']);
    expect(CREDENTIAL_FIELDS['FEDEX']).toEqual(['clientId', 'clientSecret']);
    expect(CREDENTIAL_FIELDS['INDIA_POST']).toBeUndefined();
  });
});

describe('the seller side of an order', () => {
  it('only a confirmed order may be handed to a carrier', () => {
    expect(sellerHasConfirmed('NEW')).toBe(false);
    expect(sellerHasConfirmed('CANCELLED')).toBe(false);
    for (const status of ['ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH']) {
      expect(sellerHasConfirmed(status)).toBe(true);
    }
  });

  it('names the order-side stages separately from logistics', () => {
    expect(sellerOrderStage('NEW')).toBe('SELLER_CONFIRMATION_REQUIRED');
    expect(sellerOrderStage('ACCEPTED')).toBe('SELLER_CONFIRMED');
    expect(sellerOrderStage('CANCELLED')).toBe('SELLER_REJECTED');
  });
});

describe('the logistics stage', () => {
  it('nobody named is awaiting assignment; nobody named after a refusal says so', () => {
    expect(logisticsStage(facts('CREATED'))).toBe('AWAITING_LOGISTICS_ASSIGNMENT');
    expect(logisticsStage(facts('AWAITING_ASSIGNMENT', { latestAssignmentState: 'REJECTED' }))).toBe(
      'PARTNER_REJECTED',
    );
    expect(logisticsStage(facts('AWAITING_ASSIGNMENT', { latestAssignmentState: 'EXPIRED' }))).toBe(
      'PARTNER_REJECTED',
    );
  });

  it('an offer is pending; a hand booking is a booking pending, not an offer', () => {
    expect(logisticsStage(facts('ACCEPTANCE_PENDING', { latestAssignmentState: 'OFFERED' }))).toBe(
      'ASSIGNMENT_PENDING',
    );
    expect(logisticsStage(facts('ASSIGNED', { manualBookingStatus: 'BOOKING_REQUIRED' }))).toBe(
      'CARRIER_BOOKING_PENDING',
    );
  });

  it('acceptance asks for a driver until there is one', () => {
    expect(logisticsStage(facts('ACCEPTED', { latestAssignmentState: 'ACCEPTED' }))).toBe(
      'DRIVER_ASSIGNMENT_REQUIRED',
    );
    expect(
      logisticsStage(facts('ACCEPTED', { latestAssignmentState: 'ACCEPTED', hasActiveDriver: true })),
    ).toBe('DRIVER_ASSIGNED');
  });

  it('the journey maps through, and an attempt is not a failure', () => {
    expect(logisticsStage(facts('PICKED_UP'))).toBe('PICKED_UP');
    expect(logisticsStage(facts('AT_ORIGIN_HUB'))).toBe('IN_TRANSIT');
    expect(logisticsStage(facts('DELIVERY_ATTEMPTED'))).toBe('OUT_FOR_DELIVERY');
    expect(logisticsStage(facts('DELIVERY_FAILED'))).toBe('DELIVERY_FAILED');
    expect(logisticsStage(facts('RETURN_IN_TRANSIT'))).toBe('RETURNING');
    expect(logisticsStage(facts('DELIVERED'))).toBe('DELIVERED');
  });
});

describe('what the buyer is told', () => {
  it('a refusal or a pending offer reads as "awaiting a carrier", never as a refusal', () => {
    for (const stage of ['PARTNER_REJECTED', 'ASSIGNMENT_PENDING', 'AWAITING_LOGISTICS_ASSIGNMENT'] as const) {
      expect(customerDeliveryStage({ sellerOrderStatus: 'ACCEPTED', stage })).toBe(
        'AWAITING_LOGISTICS_ASSIGNMENT',
      );
    }
  });

  it('an unconfirmed order is waiting for the seller; a refused one is cancelled', () => {
    expect(customerDeliveryStage({ sellerOrderStatus: 'NEW', stage: 'AWAITING_LOGISTICS_ASSIGNMENT' })).toBe(
      'SELLER_CONFIRMATION_REQUIRED',
    );
    expect(customerDeliveryStage({ sellerOrderStatus: 'CANCELLED', stage: 'CANCELLED' })).toBe('CANCELLED');
  });

  it('driver detail folds into "partner assigned"', () => {
    expect(customerDeliveryStage({ sellerOrderStatus: 'ACCEPTED', stage: 'DRIVER_ASSIGNED' })).toBe(
      'LOGISTICS_PARTNER_ASSIGNED',
    );
    expect(customerDeliveryStage({ sellerOrderStatus: 'ACCEPTED', stage: 'IN_TRANSIT' })).toBe('IN_TRANSIT');
    expect(customerDeliveryStage({ sellerOrderStatus: 'ACCEPTED', stage: null })).toBe('SELLER_CONFIRMED');
  });
});

describe('the seller reassignment window', () => {
  it('open until the carrier has the goods', () => {
    for (const status of ['CREATED', 'AWAITING_ASSIGNMENT', 'ACCEPTANCE_PENDING', 'ACCEPTED', 'PICKUP_SCHEDULED'] as const) {
      expect(sellerMayReassign(status)).toBe(true);
    }
  });

  it('closed from collection onwards, and for anything finished', () => {
    for (const status of ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED', 'RETURNED'] as const) {
      expect(sellerMayReassign(status)).toBe(false);
    }
  });
});

describe('the SELLER actor in the shipment state machine', () => {
  it('can walk a hand-booked parcel forward', () => {
    const route: [ShipmentStatusName, ShipmentStatusName][] = [
      ['CREATED', 'ASSIGNED'],
      ['ASSIGNED', 'PICKUP_SCHEDULED'],
      ['PICKUP_SCHEDULED', 'PICKED_UP'],
      ['PICKED_UP', 'IN_TRANSIT'],
      ['IN_TRANSIT', 'OUT_FOR_DELIVERY'],
    ];
    for (const [from, to] of route) {
      expect(canTransitionShipment({ from, to, actor: 'SELLER' })).toBe(true);
    }
  });

  it('cannot deliver without proof', () => {
    expect(() =>
      assertShipmentTransition({ from: 'OUT_FOR_DELIVERY', to: 'DELIVERED', actor: 'SELLER' }),
    ).toThrow(/Proof of Delivery/);
    expect(() =>
      assertShipmentTransition({
        from: 'OUT_FOR_DELIVERY',
        to: 'DELIVERED',
        actor: 'SELLER',
        hasProofOfDelivery: true,
      }),
    ).not.toThrow();
  });

  it('cannot take a partner-only edge: accepting, dispatching, cancelling, un-delivering', () => {
    expect(canTransitionShipment({ from: 'ACCEPTANCE_PENDING', to: 'ACCEPTED', actor: 'SELLER' })).toBe(false);
    expect(canTransitionShipment({ from: 'PICKED_UP', to: 'DISPATCHED', actor: 'SELLER' })).toBe(false);
    expect(canTransitionShipment({ from: 'ASSIGNED', to: 'CANCELLED', actor: 'SELLER' })).toBe(false);
    expect(canTransitionShipment({ from: 'DELIVERED', to: 'RETURN_REQUESTED', actor: 'SELLER' })).toBe(false);
    expect(canTransitionShipment({ from: 'CREATED', to: 'DELIVERED', actor: 'SELLER' })).toBe(false);
  });

  it('cannot give a collected parcel back to the pool', () => {
    expect(canTransitionShipment({ from: 'PICKED_UP', to: 'AWAITING_ASSIGNMENT', actor: 'SELLER' })).toBe(false);
  });

  it('owes a reason for a delay or a failure', () => {
    expect(() => assertShipmentTransition({ from: 'IN_TRANSIT', to: 'DELAYED', actor: 'SELLER' })).toThrow(/reason/);
  });
});

describe('the transition table itself', () => {
  it('has at most one rule per target from any status, so adding an actor never shadows another', async () => {
    const { ShipmentStatusValues, allowedShipmentTransitions } = await import(
      '../../src/domain/logistics-shipment-state.js'
    );
    const { LogisticsPermission } = await import('../../src/domain/logistics-permissions.js');
    for (const from of ShipmentStatusValues) {
      for (const actor of ['PARTNER', 'DRIVER', 'CARRIER', 'UBOSS_ADMIN', 'SYSTEM', 'SELLER'] as const) {
        const targets = allowedShipmentTransitions(from, actor, Object.values(LogisticsPermission)).map((rule) => rule.to);
        expect(new Set(targets).size, `${from} as ${actor}`).toBe(targets.length);
      }
    }
  });
});
