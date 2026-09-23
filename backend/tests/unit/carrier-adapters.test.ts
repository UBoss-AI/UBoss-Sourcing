/**
 * Reading what DHL and FedEx send back.
 *
 * WHAT THIS TESTS, AND WHAT IT HONESTLY CANNOT
 *
 * It tests the PARSERS against recorded payload shapes taken from each
 * carrier's published documentation. It does NOT test that those shapes are
 * what the carriers actually send today, because that needs a sandbox
 * credential and in this product the credentials belong to each seller - this
 * repository holds none and is not meant to.
 *
 * That is worth being precise about rather than glossing: a green run here
 * means "given this response, we read it correctly", not "the integration
 * works". The thing that means the integration works is
 * `testCarrierConnection`, which makes a real call against a seller's own
 * account, and which is the only code path that may write
 * `lastTestPassedAt`.
 *
 * The parsers are still the half worth testing. A carrier's response shape is
 * where an integration actually bites - a missing tracking number, a price in
 * the wrong currency, a float turning into a rounding error on an invoice -
 * and every one of those is reachable without a network.
 */
import { describe, expect, it } from 'vitest';
import {
  extractDhlError,
  readDhlRates,
  readDhlShipment,
  readDhlTracking,
} from '../../src/modules/logistics/carrier/dhl.adapter.js';
import {
  extractFedExError,
  readFedExAddress,
  readFedExRates,
  readFedExShipment,
  readFedExTracking,
} from '../../src/modules/logistics/carrier/fedex.adapter.js';
import { safeCarrierMessage } from '../../src/modules/seller/carrier-credential.service.js';

describe('DHL rates', () => {
  it('prefers the billing currency over the others', () => {
    // A product carries several prices. BILLC is the one the seller is
    // actually invoiced in; quoting any other is quoting a number that will
    // not appear on their statement.
    const quotes = readDhlRates(
      {
        products: [
          {
            productName: 'EXPRESS WORLDWIDE',
            productCode: 'P',
            deliveryCapabilities: { totalTransitDays: 2 },
            totalPrice: [
              { currencyType: 'PULCL', price: 99.99, priceCurrency: 'USD' },
              { currencyType: 'BILLC', price: 42.5, priceCurrency: 'EUR' },
            ],
          },
        ],
      },
      1000,
    );

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.currency).toBe('EUR');
    expect(quotes[0]?.amountMinor).toBe(4250n);
  });

  it('converts to minor units without a floating-point residue', () => {
    // 20.1 * 100 is 2009.9999999999998 in IEEE 754. Rounding at the boundary
    // is what stops that becoming a delivery charge of 20.09.
    const quotes = readDhlRates(
      {
        products: [
          {
            productCode: 'N',
            totalPrice: [{ currencyType: 'BILLC', price: 20.1, priceCurrency: 'GBP' }],
          },
        ],
      },
      1000,
    );

    expect(quotes[0]?.amountMinor).toBe(2010n);
    expect(typeof quotes[0]?.amountMinor).toBe('bigint');
  });

  it('skips a product with no readable price rather than inventing one', () => {
    const quotes = readDhlRates({ products: [{ productCode: 'X', totalPrice: [] }] }, 1000);
    expect(quotes).toEqual([]);
  });

  it('returns nothing for a response with no products', () => {
    expect(readDhlRates({}, 1000)).toEqual([]);
    expect(readDhlRates(null, 1000)).toEqual([]);
  });
});

describe('DHL shipment', () => {
  it('reads the tracking number and the inline label', () => {
    const result = readDhlShipment({
      shipmentTrackingNumber: '1234567890',
      trackingUrl: 'https://example.invalid/track',
      documents: [{ typeCode: 'label', imageFormat: 'PDF', content: 'SGVsbG8=' }],
    });

    expect(result.carrierTrackingNumber).toBe('1234567890');
    expect(result.label?.contentType).toBe('application/pdf');
    expect(result.label?.bytes.toString('utf8')).toBe('Hello');
  });

  it('refuses a booking that came back with no tracking number', () => {
    // Never invent one. A consignment this system cannot follow must fail
    // loudly at the moment it is booked, not silently become untrackable.
    expect(() => readDhlShipment({ documents: [] })).toThrow();
  });

  it('recognises a ZPL label as ZPL', () => {
    const result = readDhlShipment({
      shipmentTrackingNumber: '1',
      documents: [{ typeCode: 'label', imageFormat: 'ZPL', content: 'Wg==' }],
    });

    expect(result.label?.contentType).toBe('application/vnd.zebra.zpl');
  });
});

describe('DHL tracking', () => {
  it('leaves the canonical status to the mapping table', () => {
    // An adapter that decided the status itself would bypass the operator's
    // own overrides in `carrier_status_mappings`, which exist so a carrier
    // changing a code on a Tuesday can be fixed that afternoon.
    const result = readDhlTracking(
      {
        shipments: [
          {
            status: { statusCode: 'transit' },
            estimatedDeliveryDate: '2026-10-01',
            events: [
              {
                typeCode: 'PU',
                description: 'Shipment picked up',
                date: '2026-09-28',
                time: '09:14:00',
                serviceArea: [{ description: 'London - UK' }],
              },
            ],
          },
        ],
      },
      'FALLBACK',
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.status).toBeNull();
    expect(result.events[0]?.externalStatusCode).toBe('PU');
    expect(result.events[0]?.occurredAt.toISOString()).toBe('2026-09-28T09:14:00.000Z');
    expect(result.events[0]?.locationLabel).toBe('London - UK');
    expect(result.currentStatusCode).toBe('transit');
  });

  it('carries no event id, so the NOT NULL surrogate is the caller job', () => {
    // DHL sends none. A nullable `externalEventKey` would enforce nothing,
    // every NULL in a MariaDB UNIQUE index being distinct - so the event
    // service supplies the event's own ULID instead.
    const result = readDhlTracking(
      { shipments: [{ events: [{ typeCode: 'OK', date: '2026-09-28' }] }] },
      'X',
    );

    expect(result.events[0]?.externalEventId).toBeNull();
  });

  it('survives a response with no shipments at all', () => {
    const result = readDhlTracking({}, 'X');
    expect(result.events).toEqual([]);
    expect(result.carrierTrackingNumber).toBe('X');
  });
});

describe('FedEx rates', () => {
  it('prefers the account rate over the list rate', () => {
    // The list rate is the published one and is almost always higher. Quoting
    // it to a buyer overcharges them for delivery.
    const quotes = readFedExRates({
      output: {
        rateReplyDetails: [
          {
            serviceType: 'FEDEX_INTERNATIONAL_PRIORITY',
            serviceName: 'FedEx International Priority',
            operationalDetail: { transitTime: 'TWO_DAYS' },
            ratedShipmentDetails: [
              { rateType: 'LIST', totalNetCharge: 120.0, currency: 'GBP' },
              { rateType: 'ACCOUNT', totalNetCharge: 84.35, currency: 'GBP' },
            ],
          },
        ],
      },
    });

    expect(quotes).toHaveLength(1);
    expect(quotes[0]?.amountMinor).toBe(8435n);
    expect(quotes[0]?.estimatedTransitDays).toBe(2);
  });

  it('gives null transit days for a word it does not know', () => {
    // A guess here becomes a delivery date shown to a buyer.
    const quotes = readFedExRates({
      output: {
        rateReplyDetails: [
          {
            serviceType: 'X',
            operationalDetail: { transitTime: 'ELEVEN_DAYS' },
            ratedShipmentDetails: [{ rateType: 'ACCOUNT', totalNetCharge: 1, currency: 'USD' }],
          },
        ],
      },
    });

    expect(quotes[0]?.estimatedTransitDays).toBeNull();
  });

  it('returns nothing for an empty reply', () => {
    expect(readFedExRates({ output: {} })).toEqual([]);
    expect(readFedExRates(null)).toEqual([]);
  });
});

describe('FedEx shipment', () => {
  it('reads the master tracking number and the encoded label', () => {
    const result = readFedExShipment({
      output: {
        transactionShipments: [
          {
            masterTrackingNumber: '794698123456',
            pieceResponses: [{ packageDocuments: [{ encodedLabel: 'SGk=' }] }],
          },
        ],
      },
    });

    expect(result.carrierTrackingNumber).toBe('794698123456');
    expect(result.label?.bytes.toString('utf8')).toBe('Hi');
  });

  it('refuses a booking with no tracking number', () => {
    expect(() => readFedExShipment({ output: { transactionShipments: [{}] } })).toThrow();
  });
});

describe('FedEx tracking and address', () => {
  it('reads scan events and leaves the mapping alone', () => {
    const result = readFedExTracking(
      {
        output: {
          completeTrackResults: [
            {
              trackResults: [
                {
                  latestStatusDetail: { code: 'IT' },
                  scanEvents: [
                    {
                      eventType: 'PU',
                      eventDescription: 'Picked up',
                      date: '2026-09-28T09:00:00Z',
                      scanLocation: { city: 'Leeds', countryCode: 'GB' },
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      'FALLBACK',
    );

    expect(result.events[0]?.externalStatusCode).toBe('PU');
    expect(result.events[0]?.status).toBeNull();
    expect(result.events[0]?.locationCountry).toBe('GB');
    expect(result.currentStatusCode).toBe('IT');
  });

  it('treats an address FedEx cannot deliver to as invalid', () => {
    // Resolved is not the same as deliverable, and the question being asked
    // is whether a parcel can go there.
    expect(readFedExAddress({
      output: { resolvedAddresses: [{ attributes: { Resolved: 'true', DPV: 'false' } }] },
    }).isValid).toBe(false);

    expect(readFedExAddress({
      output: { resolvedAddresses: [{ attributes: { Resolved: 'true', DPV: 'true' } }] },
    }).isValid).toBe(true);
  });
});

describe('what a carrier failure is allowed to say', () => {
  it('redacts anything that looks like a key', () => {
    // A failure message is the commonest place a credential ends up in a log,
    // and this is the last point before it is stored on the connection row.
    const message = safeCarrierMessage(
      'Rejected: authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789',
    );

    expect(message).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(message).toContain('[redacted]');
  });

  it('redacts a named secret field', () => {
    expect(safeCarrierMessage('apiKey=SHORTKEY1 was refused')).toContain('[redacted]');
  });

  it('keeps an ordinary refusal readable', () => {
    const message = safeCarrierMessage('The destination postal code is not serviceable.');
    expect(message).toBe('The destination postal code is not serviceable.');
  });

  it('truncates something enormous', () => {
    expect(safeCarrierMessage('x'.repeat(5000)).length).toBeLessThanOrEqual(480);
  });

  it('says something safe for a value it cannot read', () => {
    expect(safeCarrierMessage(undefined)).toBe('The carrier did not accept the request.');
  });
});

describe('what each carrier tells us went wrong', () => {
  it('reads DHL additionalDetails first', () => {
    expect(
      extractDhlError(
        JSON.stringify({ title: 'Bad request', additionalDetails: ['Postal code is required'] }),
      ),
    ).toBe('Postal code is required');
  });

  it('reads the FedEx error message', () => {
    expect(
      extractFedExError(JSON.stringify({ errors: [{ code: 'NOT.FOUND', message: 'No rates' }] })),
    ).toBe('No rates');
  });

  it('falls back to the raw text when a carrier sends HTML', () => {
    expect(extractDhlError('<html>502</html>')).toContain('502');
  });
});
