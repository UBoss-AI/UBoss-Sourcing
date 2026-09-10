/**
 * What the customer is offered, and what a stored card may be used for.
 *
 * Two rules with quite different failure modes, tested together because they
 * are the two halves of the same change — asking people which *instrument*
 * they are paying with rather than which gateway should settle it.
 *
 * The first is about not lying to a customer. An instrument named on a
 * checkout page is a promise: choose UPI and you get a UPI tab. Every
 * substitution this module could quietly make — UPI resolving onto Stripe, a
 * card offered in a currency nothing settles — lands the customer somewhere
 * they did not ask to be, with nothing on screen to explain it. So the rule is
 * that `resolveInstrument` refuses rather than substitutes, and these tests are
 * mostly about the refusals.
 *
 * The second is about not taking money nobody authorised. A card saved at a
 * checkout carries a narrower consent than one enrolled for auto-pay, and
 * `assertChargeable` is the single place that difference is enforced — ten
 * call sites reach it, and a new one that forgets is refused rather than
 * trusted. That test is short and it is the most important one in the file.
 *
 * Nothing here touches the network or the database. Both units are pure.
 */
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import {
  cardSuitsInstrument,
  fundingFor,
  offerableInstruments,
  resolveInstrument,
  type GatewayOffer,
} from '../../src/domain/payment-instrument.js';
import { assertChargeable } from '../../src/modules/payments/payment-method.service.js';

const stripe: GatewayOffer = {
  provider: 'STRIPE',
  currencies: null,
  hasUpi: false,
  canStoreCards: true,
};

const razorpay: GatewayOffer = {
  provider: 'RAZORPAY',
  currencies: ['INR'],
  hasUpi: true,
  canStoreCards: true,
};

/** A card row, reduced to the three fields `assertChargeable` reads. */
function card(overrides: Partial<Parameters<typeof assertChargeable>[0]> = {}) {
  return {
    status: 'ACTIVE',
    consentScope: 'OFF_SESSION',
    expMonth: 12,
    expYear: 2099,
    ...overrides,
  };
}

describe('which instruments are offered', () => {
  it('offers both card options wherever any gateway can settle the currency', () => {
    expect(offerableInstruments([stripe], 'EUR')).toEqual(['CREDIT_CARD', 'DEBIT_CARD']);
  });

  it('offers nothing at all when no gateway settles the currency', () => {
    // Not "offer cards anyway and fail later". A customer shown a card button
    // that cannot work has been told something untrue.
    expect(offerableInstruments([razorpay], 'EUR')).toEqual([]);
  });

  it('offers UPI only when a gateway actually has it switched on', () => {
    expect(offerableInstruments([razorpay], 'INR')).toContain('UPI');

    // The same gateway, same currency, UPI turned off in its dashboard. This
    // is the case that matters: UPI is never inferred from the gateway being
    // Razorpay, because a Razorpay account can have no UPI tab to open on.
    expect(offerableInstruments([{ ...razorpay, hasUpi: false }], 'INR')).not.toContain('UPI');
  });

  it('puts the card options first, in a fixed order', () => {
    // Fixed rather than derived from whatever is connected: a list whose first
    // entry moves about is one nobody can build a habit on.
    expect(offerableInstruments([razorpay, stripe], 'INR')).toEqual([
      'CREDIT_CARD',
      'DEBIT_CARD',
      'UPI',
    ]);
  });
});

describe('resolving an instrument to a gateway', () => {
  it('honours the operator default when it can serve the request', () => {
    const resolved = resolveInstrument('CREDIT_CARD', 'INR', [razorpay, stripe], 'STRIPE');
    expect(resolved.provider).toBe('STRIPE');
  });

  it('uses another gateway when the default cannot settle the currency', () => {
    // Razorpay is the configured default but cannot take euros. Falling
    // through to Stripe takes the payment; refusing would lose a sale for a
    // reason the customer could do nothing about.
    const resolved = resolveInstrument('CREDIT_CARD', 'EUR', [razorpay, stripe], 'RAZORPAY');
    expect(resolved.provider).toBe('STRIPE');
  });

  it('sends UPI only to a gateway that has it', () => {
    const resolved = resolveInstrument('UPI', 'INR', [razorpay, stripe], 'STRIPE');

    // The configured default is Stripe and it is deliberately NOT chosen.
    // Stripe cannot settle UPI, and opening its card form for a customer who
    // asked for UPI is the exact substitution this function exists to refuse.
    expect(resolved.provider).toBe('RAZORPAY');
    expect(resolved.methodHint).toBe('UPI');
  });

  it('refuses UPI rather than substituting a card sheet', () => {
    expect(() =>
      resolveInstrument('UPI', 'INR', [{ ...razorpay, hasUpi: false }, stripe], 'RAZORPAY'),
    ).toThrow(AppError);

    try {
      resolveInstrument('UPI', 'INR', [stripe], 'STRIPE');
      expect.unreachable('a UPI payment with no UPI gateway must not resolve');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PAYMENT_INSTRUMENT_UNAVAILABLE');
    }
  });

  it('refuses a card in a currency no connected gateway settles', () => {
    expect(() => resolveInstrument('DEBIT_CARD', 'EUR', [razorpay], 'RAZORPAY')).toThrow(
      AppError,
    );
  });

  it('never promises a saved card for UPI', () => {
    // A UPI payment produces nothing to store, whatever the gateway can do
    // with cards. Offering the tick would be offering a promise nothing
    // downstream could honour.
    const resolved = resolveInstrument('UPI', 'INR', [razorpay], 'RAZORPAY');
    expect(resolved.canStoreCards).toBe(false);
  });

  it('does not promise a saved card where the gateway cannot store one', () => {
    const resolved = resolveInstrument(
      'CREDIT_CARD',
      'EUR',
      [{ ...stripe, canStoreCards: false }],
      'STRIPE',
    );
    expect(resolved.canStoreCards).toBe(false);
  });
});

describe('filing a card under credit or debit', () => {
  it('maps the providers own word for it', () => {
    // Stripe says `funding`, Razorpay says `card.type`, and both spell these
    // two the same way.
    expect(fundingFor('credit')).toBe('CREDIT_CARD');
    expect(fundingFor('debit')).toBe('DEBIT_CARD');
    expect(fundingFor('CREDIT')).toBe('CREDIT_CARD');
  });

  it('files a card of unknown funding under neither, and offers it under both', () => {
    // A prepaid card, or one the provider will not describe. It is perfectly
    // usable, so it appears under both headings rather than being filed
    // wrongly under one — telling somebody their credit card is a debit card
    // is worse than telling them nothing.
    expect(fundingFor('prepaid')).toBeNull();
    expect(fundingFor(null)).toBeNull();

    expect(cardSuitsInstrument(null, 'CREDIT_CARD')).toBe(true);
    expect(cardSuitsInstrument(null, 'DEBIT_CARD')).toBe(true);
  });

  it('keeps a known card out of the other list', () => {
    expect(cardSuitsInstrument('debit', 'CREDIT_CARD')).toBe(false);
    expect(cardSuitsInstrument('debit', 'DEBIT_CARD')).toBe(true);
  });

  it('never offers a card under UPI', () => {
    expect(cardSuitsInstrument('credit', 'UPI')).toBe(false);
    expect(cardSuitsInstrument(null, 'UPI')).toBe(false);
  });
});

describe('what a stored card may be charged for', () => {
  it('allows an off-session charge against an auto-pay mandate', () => {
    expect(() => {
      assertChargeable(card());
    }).not.toThrow();
  });

  /**
   * The most important assertion in this file.
   *
   * A card saved at a checkout was saved under "keep this so I need not type
   * it again". The row is indistinguishable from an auto-pay mandate in every
   * other respect — same table, same token, same brand and last four — so
   * without this check a scheduled order would charge it in the night under an
   * authority nobody gave.
   */
  it('refuses to charge a checkout-saved card off-session', () => {
    try {
      assertChargeable(card({ consentScope: 'CHECKOUT' }));
      expect.unreachable('a card saved at a checkout must not be chargeable off-session');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('PAYMENT_METHOD_NOT_CHARGEABLE');
    }
  });

  it('checks consent before it checks whether the card still works', () => {
    // A card can be perfectly good and still not be ours to charge, so the
    // consent refusal must win over the expiry one. Reported the other way
    // round, a customer would be told to add a new card when the real problem
    // is that this one was never authorised for this.
    try {
      assertChargeable(card({ consentScope: 'CHECKOUT', expMonth: 1, expYear: 2000 }));
      expect.unreachable('expected a refusal');
    } catch (error) {
      expect((error as AppError).code).toBe('PAYMENT_METHOD_NOT_CHARGEABLE');
    }
  });

  it('still refuses a detached or expired mandate', () => {
    expect(() => {
      assertChargeable(card({ status: 'DETACHED' }));
    }).toThrow(AppError);

    expect(() => {
      assertChargeable(card({ expMonth: 1, expYear: 2000 }));
    }).toThrow(AppError);
  });

  it('treats a card as good through the last day of its expiry month', () => {
    const now = new Date();

    expect(() => {
      assertChargeable(card({ expMonth: now.getUTCMonth() + 1, expYear: now.getUTCFullYear() }));
    }).not.toThrow();
  });
});
