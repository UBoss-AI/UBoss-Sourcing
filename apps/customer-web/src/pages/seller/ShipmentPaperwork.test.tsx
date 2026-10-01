/**
 * Master rows 42 and 56 in the browser: the seller's trade documents panel,
 * the consignment booking form, and the buyer's shipment details card. The
 * assertions read what is sent and what is drawn, not the copy, so they hold
 * in any language.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { jsonResponse, renderWithProviders } from '@/test/harness';
import { OrderShipmentDetails } from '@/components/OrderShipmentDetails';
import { ShipmentBookingPanel } from './ShipmentBookingPanel';
import { TradeDocumentsPanel } from './TradeDocumentsPanel';

const SHIP = 'S'.repeat(26);

function version(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v2',
    version: 2,
    source: 'UPLOADED',
    referenceNumber: 'COO-778',
    issuerName: 'Chamber of Commerce',
    issuedOn: '2026-10-01',
    expiresOn: '2027-10-01',
    fileName: 'coo.pdf',
    hasFile: true,
    validation: 'VALID',
    validationNote: null,
    superseded: false,
    createdByLabel: 'Omega',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

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

describe('TradeDocumentsPanel', () => {
  const listing = {
    documents: [
      {
        id: 'd1',
        kind: 'CERTIFICATE_OF_ORIGIN',
        title: 'Certificate of origin',
        shipmentId: SHIP,
        buyerVisible: true,
        currentVersion: 2,
        current: version(),
        versions: [version(), version({ id: 'v1', version: 1, source: 'GENERATED', superseded: true, validation: 'PENDING_REVIEW' })],
      },
    ],
    required: [{ kind: 'CATEGORY:CE', name: 'EU declaration of conformity', ruleName: 'EU', note: null, satisfied: false }],
    issued: { commercialInvoices: 1, packingLists: 1 },
    consignments: [{ id: SHIP, reference: 'LS-2026-000001' }],
  };

  it('shows each document with its version, issuer, expiry and a link to its file, and what a rule still requires', async () => {
    stub({ '/trade-documents': () => jsonResponse(listing) });
    renderWithProviders(<TradeDocumentsPanel sellerOrderId="g1" canAct />);

    const row = await screen.findByTestId('trade-doc-CERTIFICATE_OF_ORIGIN');
    expect(row.textContent).toContain('LS-2026-000001');
    expect(row.textContent).toContain('Chamber of Commerce');
    expect(row.textContent).toContain('2027-10-01');
    expect(row.querySelector('a[href$="/seller/trade-documents/versions/v2/file"]')).not.toBeNull();
    expect(row.querySelector('a[href$="/seller/trade-documents/versions/v1/file"]')).not.toBeNull();
    // In the required list, and offered as a kind in the form.
    expect(screen.getAllByText('EU declaration of conformity')).toHaveLength(2);
  });

  it('records a waybill by its number, for the consignment chosen', async () => {
    const calls = stub({
      '/trade-documents': (call) =>
        call.method === 'POST' ? jsonResponse({ document: listing.documents[0] }, 201) : jsonResponse(listing),
    });
    const { container } = renderWithProviders(<TradeDocumentsPanel sellerOrderId="g1" canAct />);
    await screen.findByTestId('trade-doc-CERTIFICATE_OF_ORIGIN');

    const selects = container.querySelectorAll('form select');
    fireEvent.change(selects[0] as Element, { target: { value: 'AIR_WAYBILL' } });
    fireEvent.change(selects[1] as Element, { target: { value: SHIP } });
    const inputs = container.querySelectorAll('form input:not([type=file]):not([type=date])');
    fireEvent.change(inputs[0] as Element, { target: { value: 'Lufthansa Cargo' } });
    fireEvent.change(inputs[1] as Element, { target: { value: '020-12345675' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'POST')).toBe(true);
    });
    const post = calls.find((call) => call.method === 'POST');
    expect(post?.url).toContain('/seller/orders/g1/trade-documents');
    expect(post?.body).toMatchObject({
      kind: 'AIR_WAYBILL',
      shipmentId: SHIP,
      issuerName: 'Lufthansa Cargo',
      referenceNumber: '020-12345675',
    });
  });

  it('offers no form when the seller cannot act', async () => {
    stub({ '/trade-documents': () => jsonResponse(listing) });
    const { container } = renderWithProviders(<TradeDocumentsPanel sellerOrderId="g1" canAct={false} />);
    await screen.findByTestId('trade-doc-CERTIFICATE_OF_ORIGIN');
    expect(container.querySelector('form')).toBeNull();
  });
});

describe('ShipmentBookingPanel', () => {
  const booking = {
    shipmentId: SHIP,
    reference: 'LS-2026-000001',
    crossBorder: true,
    terms: null,
    carrier: { kind: 'NONE', name: null, trackingNumber: null },
    canEdit: true,
  };

  it('sends mode, Incoterm, ports, pickup window and a hand-booked carrier', async () => {
    const calls = stub({
      '/booking': (call) =>
        call.method === 'PUT'
          ? jsonResponse({ booking: { ...booking, carrier: { kind: 'MANUAL_CARRIER', name: 'DHL', trackingNumber: null } } })
          : jsonResponse({ booking }),
    });
    const { container } = renderWithProviders(<ShipmentBookingPanel shipmentId={SHIP} />);
    await screen.findByTestId('booking-carrier');

    const selects = container.querySelectorAll('select');
    // Cross-border defaults: sea freight, FOB.
    expect((selects[0] as HTMLSelectElement).value).toBe('SEA');
    expect((selects[1] as HTMLSelectElement).value).toBe('FOB');
    fireEvent.change(selects[2] as Element, { target: { value: 'DHL' } });

    const text = container.querySelectorAll('input:not([type=date]):not([type=time])');
    fireEvent.change(text[0] as Element, { target: { value: 'Nhava Sheva' } });
    fireEvent.change(text[1] as Element, { target: { value: 'INNSA' } });
    fireEvent.change(text[2] as Element, { target: { value: 'DEHAM' } });
    fireEvent.change(container.querySelector('input[type=date]') as Element, { target: { value: '2026-10-20' } });
    const times = container.querySelectorAll('input[type=time]');
    fireEvent.change(times[0] as Element, { target: { value: '09:00' } });
    fireEvent.change(times[1] as Element, { target: { value: '13:00' } });
    fireEvent.submit(container.querySelector('form') as HTMLFormElement);

    await waitFor(() => {
      expect(calls.some((call) => call.method === 'PUT')).toBe(true);
    });
    expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
      mode: 'SEA',
      incoterm: 'FOB',
      incotermPlace: 'Nhava Sheva',
      originPort: 'INNSA',
      destinationPort: 'DEHAM',
      routeNote: null,
      pickupDate: '2026-10-20',
      pickupWindowFrom: '09:00',
      pickupWindowTo: '13:00',
      manualCarrier: 'DHL',
    });
  });

  it('locks the form once the consignment has been collected', async () => {
    stub({ '/booking': () => jsonResponse({ booking: { ...booking, canEdit: false } }) });
    const { container } = renderWithProviders(<ShipmentBookingPanel shipmentId={SHIP} />);
    await screen.findByTestId('booking-carrier');
    expect((container.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(container.querySelector('button[type=submit]')).toBeNull();
  });
});

describe('OrderShipmentDetails', () => {
  it('shows the buyer the booking and the documents they may open', async () => {
    stub({
      '/shipment-details': () =>
        jsonResponse({
          shipments: [
            {
              shipmentId: SHIP,
              reference: 'LS-2026-000001',
              sellerName: 'Omega Exports',
              terms: {
                mode: 'SEA',
                incoterm: 'FOB',
                incotermPlace: 'Nhava Sheva',
                originPort: 'INNSA',
                destinationPort: 'DEHAM',
                routeNote: null,
                pickupDate: '2026-10-20',
                pickupWindowFrom: '09:00',
                pickupWindowTo: '13:00',
              },
              carrier: { kind: 'MANUAL_CARRIER', name: 'DHL', trackingNumber: '1234567890' },
            },
          ],
          documents: [
            {
              id: 'd1',
              kind: 'BILL_OF_LADING',
              title: 'Bill of lading',
              shipmentReference: 'LS-2026-000001',
              sellerName: 'Omega Exports',
              versionId: 'v9',
              version: 1,
              referenceNumber: 'MAEU123',
              issuerName: 'Maersk',
              issuedOn: null,
              expiresOn: null,
              hasFile: true,
              validation: 'VALID',
            },
          ],
        }),
    });
    const { container } = renderWithProviders(<OrderShipmentDetails orderId="o1" />);
    const section = await screen.findByTestId('shipment-LS-2026-000001');
    expect(section.textContent).toContain('FOB Nhava Sheva');
    expect(section.textContent).toContain('INNSA → DEHAM');
    expect(section.textContent).toContain('2026-10-20 09:00–13:00');
    expect(section.textContent).toContain('DHL · 1234567890');
    expect(container.textContent).toContain('MAEU123');
    expect(container.querySelector('a[href$="/orders/o1/trade-documents/v9/file"]')).not.toBeNull();
  });

  it('draws nothing when there is nothing booked and no document', async () => {
    const calls = stub({ '/shipment-details': () => jsonResponse({ shipments: [], documents: [] }) });
    const { container } = renderWithProviders(<OrderShipmentDetails orderId="o1" />);
    await waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });
    expect(container.textContent).toBe('');
  });
});
