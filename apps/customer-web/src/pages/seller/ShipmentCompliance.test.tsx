/**
 * JOURNEY-046 and JOURNEY-049 in the browser: cargo insurance, freight
 * options with their validity and the dispatch-readiness note on the booking
 * form; destination holds and responsible parties on the trade documents
 * panel; the HS code review state on a listing; and what the buyer is asked
 * to provide. Assertions read what is sent and drawn, not the copy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { OrderShipmentDetails } from '@/components/OrderShipmentDetails';
import { SellerTradeCodesPanel } from './SellerTradeCodesPanel';
import { ShipmentBookingPanel } from './ShipmentBookingPanel';
import { TradeDocumentsPanel } from './TradeDocumentsPanel';

const SHIP = 'S'.repeat(26);
type Call = { url: string; method: string; body: unknown };

function stub(routes: Record<string, (call: Call) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body;
      const call = { url, method, body };
      calls.push(call);
      for (const [fragment, respond] of Object.entries(routes)) {
        if (url.includes(fragment)) return Promise.resolve(respond(call));
      }
      return Promise.resolve(jsonResponse({}));
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const BOOKING = {
  shipmentId: SHIP,
  reference: 'LS-2026-000009',
  crossBorder: true,
  originCountry: 'IN',
  destinationCountry: 'DE',
  insurance: {
    offered: true,
    basisPoints: 35,
    maxInsuredBasisPoints: 11000,
    goodsValueMinor: '100000',
    maxInsuredValueMinor: '110000',
    currency: 'INR',
  },
  dispatchReadiness: {
    inspection: { open: false, reason: 'NOT_BOOKED' },
    compliance: { open: false, holds: 2, overridden: false },
  },
  terms: null,
  carrier: { kind: 'NONE', name: null, trackingNumber: null },
  canEdit: true,
};

describe('ShipmentBookingPanel (JOURNEY-046)', () => {
  it('shows the route countries, why dispatch waits, and each freight option with its validity', async () => {
    stub({
      '/booking': () => jsonResponse({ booking: BOOKING }),
      '/freight-options': () =>
        jsonResponse({
          originCountry: 'IN',
          destinationCountry: 'DE',
          weightGrams: 12000,
          options: [
            {
              laneId: 'l1',
              laneName: 'Nhava Sheva to Hamburg',
              mode: 'SEA',
              carrierName: 'Ocean Line',
              serviceLevel: 'STANDARD',
              transitDaysMin: 20,
              transitDaysMax: 28,
              currency: 'INR',
              totalMinor: '50000',
              validFrom: '2026-10-01T00:00:00.000Z',
              validTo: '2026-12-31T00:00:00.000Z',
            },
          ],
        }),
    });
    renderWithProviders(<ShipmentBookingPanel shipmentId={SHIP} />);

    expect((await screen.findByTestId('booking-route')).textContent).toMatch(/IN.*DE/);
    expect((await screen.findByTestId('booking-readiness')).querySelectorAll('li')).toHaveLength(2);
    const freight = await screen.findByTestId('freight-options');
    expect(freight.textContent).toContain('Ocean Line');
    expect(freight.textContent).toContain('2026');
  });

  it('sends the insured value in minor units as a string', async () => {
    const calls = stub({
      '/booking': (call) =>
        jsonResponse({ booking: call.method === 'PUT' ? { ...BOOKING, terms: null } : BOOKING }),
    });
    const { container } = renderWithProviders(<ShipmentBookingPanel shipmentId={SHIP} />);
    const insurance = await screen.findByTestId('booking-insurance');

    fireEvent.click(insurance.querySelector('input[type=checkbox]') as HTMLInputElement);
    const value = await waitFor(() => {
      const input = insurance.querySelector('input[inputmode=decimal]');
      expect(input).not.toBeNull();
      return input as HTMLInputElement;
    });
    fireEvent.change(value, { target: { value: '1100.00' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ insured: true, insuredValueMinor: '110000' });
  });
});

describe('TradeDocumentsPanel holds (JOURNEY-049)', () => {
  it('shows who provides each document, the restriction, and every open hold', async () => {
    stub({
      '/trade-documents': () =>
        jsonResponse({
          documents: [],
          required: [
            { kind: 'IMPORT_LICENCE', name: 'Import licence', ruleName: 'Licence', note: null, satisfied: false, responsibleParty: 'BUYER', restriction: 'NONE', status: 'MISSING' },
            { kind: 'CATEGORY:CE', name: 'EU declaration', ruleName: 'CE', note: null, satisfied: false, responsibleParty: 'SELLER', restriction: 'RESTRICTED', status: 'MISSING' },
          ],
          compliance: {
            destination: 'DE',
            restrictions: [{ ruleName: 'CE', restriction: 'RESTRICTED', requiresHsVerification: true, note: null, skus: ['M-50'] }],
            holds: [
              { key: 'a', code: 'DOCUMENT_MISSING', ruleName: 'CE', responsibleParty: 'SELLER', documentKind: 'CATEGORY:CE', sku: null, covered: false },
              { key: 'b', code: 'HS_UNVERIFIED', ruleName: 'CE', responsibleParty: 'SELLER', documentKind: null, sku: 'M-50', covered: false },
            ],
            open: false,
            overridden: false,
            override: null,
          },
          issued: { commercialInvoices: 0, packingLists: 0 },
          consignments: [],
        }),
    });
    renderWithProviders(<TradeDocumentsPanel sellerOrderId="g1" canAct={false} />);

    const panel = await screen.findByTestId('trade-docs-compliance');
    expect(panel.querySelectorAll('[role=status] li')).toHaveLength(2);
    expect(panel.textContent).toContain('M-50');
    expect(panel.textContent).toContain('DE');
  });
});

describe('SellerTradeCodesPanel (JOURNEY-049)', () => {
  it('shows the corrected code once the marketplace verified it', async () => {
    stub({
      '/trade-codes': () =>
        jsonResponse({
          id: 'o1',
          hsnCode: '63079090',
          countryOfOrigin: 'IN',
          hsVerification: { state: 'VERIFIED', verifiedCode: '63079098', note: null, verifiedAt: '2026-10-02T00:00:00.000Z' },
        }),
    });
    renderWithProviders(<SellerTradeCodesPanel offerId="o1" />);
    expect((await screen.findByTestId('hs-verification')).textContent).toContain('63079098');
  });
});

describe('OrderShipmentDetails (JOURNEY-046, 049)', () => {
  it('shows the buyer the insurance and the documents they must provide', async () => {
    stub({
      '/shipment-details': () =>
        jsonResponse({
          shipments: [
            {
              shipmentId: SHIP,
              reference: 'LS-2026-000009',
              sellerName: 'Omega Exports',
              terms: {
                mode: 'SEA',
                incoterm: 'CIF',
                incotermPlace: null,
                originPort: 'INNSA',
                destinationPort: 'DEHAM',
                routeNote: null,
                pickupDate: null,
                pickupWindowFrom: null,
                pickupWindowTo: null,
                insured: true,
                insuredValueMinor: '110000',
                insurancePremiumMinor: '385',
                insuranceBasisPointsApplied: 35,
                insuranceCurrency: 'INR',
              },
              carrier: { kind: 'NONE', name: null, trackingNumber: null },
            },
          ],
          documents: [],
          buyerActions: [
            { sellerName: 'Omega Exports', ruleName: 'Licence', documentName: 'Import licence', restriction: 'NONE', note: 'Apply early' },
          ],
        }),
    });
    renderWithProviders(<OrderShipmentDetails orderId="o1" />);
    expect((await screen.findByTestId('buyer-insurance')).textContent).toMatch(/1,?100/);
    const actions = await screen.findByTestId('buyer-actions');
    expect(actions.textContent).toContain('Import licence');
    expect(actions.textContent).toContain('Apply early');
  });
});
