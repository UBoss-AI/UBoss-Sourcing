/**
 * The marketplace's name in text a person reads.
 *
 * Every buyer of this software runs their own marketplace under their own
 * name. These pin the places that used to print the vendor's name instead -
 * the payment sheet a customer pays through, the issuer an authenticator app
 * files a code under - to the deployment's business profile, and pin the
 * fallback for a fresh install to the product's own name rather than the
 * vendor's.
 *
 * Nothing here reaches the network or the database.
 */
import { describe, expect, it } from 'vitest';
import { RazorpayAdapter } from '../../src/modules/payments/razorpay.adapter.js';
import type { CreatePaymentInput } from '../../src/modules/payments/provider.js';
import { mfaIssuerName } from '../../src/modules/logistics/mfa.service.js';
import {
  PRODUCT_NAME,
  getMarketplaceName,
  marketplaceNameFrom,
} from '../../src/modules/settings/marketplace-name.js';

const razorpayCredentials = {
  keyId: 'rzp_test_key',
  keySecret: 'rzp_test_secret',
  webhookSecret: 'rzp_test_webhook',
};

function paymentInput(
  overrides: Partial<Omit<CreatePaymentInput, 'idempotencyKey'>> = {},
): Omit<CreatePaymentInput, 'idempotencyKey'> {
  return {
    orderId: 'order_test_1',
    orderNumber: 'NW-1001',
    amountMinor: 245_700n,
    currency: 'INR',
    customerEmail: 'buyer@example.test',
    customerName: 'A Buyer',
    customerPhone: '+911234567890',
    ...overrides,
  };
}

describe('marketplace name', () => {
  it('is the operator’s own trading name, trimmed', () => {
    expect(marketplaceNameFrom('  Northwind Supply  ')).toBe('Northwind Supply');
  });

  it('falls back to the product’s name, never the vendor’s, when there is none', () => {
    expect(PRODUCT_NAME).toBe('Glovia');
    for (const missing of [null, undefined, '', '   ']) {
      expect(marketplaceNameFrom(missing)).toBe('Glovia');
    }
  });

  it('reads the business profile it is handed', async () => {
    const client = {
      businessProfile: {
        findFirst: () => Promise.resolve({ displayName: 'Northwind Supply' }),
      },
    };
    expect(await getMarketplaceName(client)).toBe('Northwind Supply');

    const empty = { businessProfile: { findFirst: () => Promise.resolve(null) } };
    expect(await getMarketplaceName(empty)).toBe('Glovia');
  });
});

describe('the name on the payment sheet', () => {
  it('is the merchant name the payment service passes', async () => {
    const payload = await new RazorpayAdapter(razorpayCredentials).buildCheckoutPayload(
      'order_rzp_1',
      paymentInput({ merchantName: 'Northwind Supply' }),
    );

    expect(payload.name).toBe('Northwind Supply');
  });

  it('is never the vendor’s name', async () => {
    const payload = await new RazorpayAdapter(razorpayCredentials).buildCheckoutPayload(
      'order_rzp_1',
      paymentInput(),
    );

    expect(String(payload.name)).not.toMatch(/UBOSS/i);
    expect(payload.name).toBe('Glovia');
  });
});

describe('the logistics portal’s authenticator issuer', () => {
  it('names the operator', () => {
    expect(mfaIssuerName('Northwind Supply Pvt Ltd')).toBe('Northwind Supply Pvt Ltd Logistics');
  });

  it('falls back to the product’s portal name, not the vendor’s', () => {
    expect(mfaIssuerName(null)).toBe('Glovia Logistics');
    expect(mfaIssuerName('  ')).toBe('Glovia Logistics');
  });
});
