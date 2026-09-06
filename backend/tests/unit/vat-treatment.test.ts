/**
 * The VAT decision table.
 *
 * `resolveTaxTreatment` is pure, so the whole table can be asserted without a
 * database — which matters, because these are the branches where being wrong
 * is expensive in both directions. Zero-rate a supply that should have been
 * taxed and the seller pays the VAT out of their own margin; tax one that
 * should have been zero-rated and the customer is overcharged 19-27% and
 * reasonably angry.
 *
 * The case that earns the most attention is `vatNumberValid: null`. A VAT
 * number nobody has been able to confirm is not a valid one, and the whole
 * file exists to make sure that distinction never quietly collapses.
 */
import { describe, expect, it } from 'vitest';
import {
  TaxTreatment,
  VatCategory,
  applyLineTax,
  rateForLine,
  resolveTaxTreatment,
  type TaxSetup,
} from '../../src/modules/tax/vat.service.js';
import { Prisma } from '../../src/generated/prisma/client.js';

/** A handful of member states plus one third country, which is all the table needs. */
const EU = new Set(['NL', 'DE', 'FR', 'IT', 'PL']);

const DUTCH_SELLER = { vatCountry: 'NL', vatNumber: 'NL123456789B01' };

function decimal(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('resolveTaxTreatment', () => {
  it('falls back to the flat rate when the seller has no VAT country', () => {
    const result = resolveTaxTreatment(
      { vatCountry: null, vatNumber: null },
      { destinationCountry: 'DE', vatNumber: 'DE811569869', vatNumberValid: true },
      EU,
    );

    // An Indian GST deployment must behave exactly as it did before EU VAT
    // existed in this codebase, whatever a customer's profile happens to say.
    expect(result.treatment).toBe(TaxTreatment.FLAT_RATE);
    expect(result.rateCountry).toBeNull();
  });

  it('falls back to the flat rate when the seller is outside the EU VAT area', () => {
    const result = resolveTaxTreatment(
      { vatCountry: 'IN', vatNumber: null },
      { destinationCountry: 'DE', vatNumber: null, vatNumberValid: null },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.FLAT_RATE);
  });

  it('charges domestic VAT within the seller’s own member state', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'NL', vatNumber: null, vatNumberValid: null },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.DOMESTIC);
    expect(result.rateCountry).toBe('NL');
    expect(result.zeroRated).toBe(false);
  });

  it('charges domestic VAT within the seller’s state even to a valid VAT number', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'NL', vatNumber: 'NL987654321B01', vatNumberValid: true },
      EU,
    );

    // A domestic B2B sale is NOT reverse-charged. Getting this wrong is the
    // classic mistake: the reverse charge is an intra-Community mechanism, not
    // a business-customer discount.
    expect(result.treatment).toBe(TaxTreatment.DOMESTIC);
    expect(result.zeroRated).toBe(false);
  });

  it('zero-rates an intra-Community supply to a confirmed VAT number', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'DE', vatNumber: 'DE811569869', vatNumberValid: true },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.INTRA_EU_REVERSE_CHARGE);
    expect(result.zeroRated).toBe(true);
    // Art. 226(11): the invoice has to name the provision it relies on.
    expect(result.exemptionNote).toContain('Article 138');
    expect(result.exemptionNote).toContain('Article 196');
  });

  it('taxes an intra-Community supply when the VAT number is UNCHECKED', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      // null, not false: nobody has asked VIES yet.
      { destinationCountry: 'DE', vatNumber: 'DE811569869', vatNumberValid: null },
      EU,
    );

    // Art. 138(1)(b) puts the burden of the customer's status on the seller.
    // An unconfirmed number is not evidence, so the destination's VAT applies.
    expect(result.treatment).toBe(TaxTreatment.INTRA_EU_B2C);
    expect(result.rateCountry).toBe('DE');
    expect(result.zeroRated).toBe(false);
    expect(result.reason).toContain('not confirmed');
  });

  it('taxes an intra-Community supply when VIES said the number is invalid', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'DE', vatNumber: 'DE000000000', vatNumberValid: false },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.INTRA_EU_B2C);
    expect(result.rateCountry).toBe('DE');
  });

  it('charges the DESTINATION state’s rate to a consumer, not the seller’s', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'PL', vatNumber: null, vatNumberValid: null },
      EU,
    );

    // Art. 33: a distance sale is taxed where the goods arrive. Charging the
    // seller's 21% to a Polish buyer who owes 23% leaves the seller two points
    // short on every order.
    expect(result.treatment).toBe(TaxTreatment.INTRA_EU_B2C);
    expect(result.rateCountry).toBe('PL');
  });

  it('zero-rates goods leaving the Union', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'CH', vatNumber: null, vatNumberValid: null },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.EXPORT);
    expect(result.zeroRated).toBe(true);
    expect(result.exemptionNote).toContain('Article 146');
    // The condition the software cannot discharge for them.
    expect(result.reason).toContain('proof of export');
  });

  it('quotes at the seller’s own rate before an address exists', () => {
    const result = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: null, vatNumber: null, vatNumberValid: null },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.DOMESTIC);
    expect(result.rateCountry).toBe('NL');
    // And says so, because the number on the page may change at checkout.
    expect(result.reason).toContain('recalculated');
  });

  it('is case-insensitive about country codes', () => {
    const result = resolveTaxTreatment(
      { vatCountry: 'nl', vatNumber: 'NL123456789B01' },
      { destinationCountry: 'de', vatNumber: 'DE811569869', vatNumberValid: true },
      EU,
    );

    expect(result.treatment).toBe(TaxTreatment.INTRA_EU_REVERSE_CHARGE);
  });
});

describe('rateForLine', () => {
  const rates = new Map([
    [VatCategory.STANDARD, decimal('19')],
    [VatCategory.REDUCED, decimal('7')],
  ]);

  const german = resolveTaxTreatment(
    DUTCH_SELLER,
    { destinationCountry: 'DE', vatNumber: null, vatNumberValid: null },
    EU,
  );

  it('uses the destination state’s rate for the product’s band', () => {
    const result = rateForLine(
      german,
      { vatCategory: VatCategory.STANDARD, flatRatePercent: '21', productName: 'Gloves' },
      rates,
    );

    expect(result.ratePercent).toBe('19');
    expect(result.problem).toBeNull();
  });

  it('uses the reduced band when the product is in it', () => {
    const result = rateForLine(
      german,
      { vatCategory: VatCategory.REDUCED, flatRatePercent: '21', productName: 'Dressing' },
      rates,
    );

    expect(result.ratePercent).toBe('7');
  });

  it('refuses rather than falling back to 0% when a band has no rate', () => {
    const result = rateForLine(
      german,
      { vatCategory: VatCategory.SUPER_REDUCED, flatRatePercent: '21', productName: 'Gloves' },
      rates,
    );

    // The important assertion in this file. A silent 0% is an undercharge that
    // surfaces at a VAT audit rather than at checkout, so a missing rate has
    // to stop the sale.
    expect(result.problem).not.toBeNull();
    expect(result.problem).toContain('SUPER_REDUCED');
  });

  it('flags a product whose tax class was never given a band', () => {
    const result = rateForLine(
      german,
      { vatCategory: null, flatRatePercent: '21', productName: 'Gloves' },
      rates,
    );

    expect(result.problem).toContain('no EU VAT band');
  });

  it('is 0% for a zero-rated treatment whatever the product’s band', () => {
    const reverseCharged = resolveTaxTreatment(
      DUTCH_SELLER,
      { destinationCountry: 'DE', vatNumber: 'DE811569869', vatNumberValid: true },
      EU,
    );

    const result = rateForLine(
      reverseCharged,
      { vatCategory: VatCategory.REDUCED, flatRatePercent: '21', productName: 'Dressing' },
      rates,
    );

    expect(result.ratePercent).toBe('0');
    expect(result.problem).toBeNull();
  });

  it('is 0% for an exempt band without needing a rate row', () => {
    const result = rateForLine(
      german,
      { vatCategory: VatCategory.EXEMPT, flatRatePercent: '21', productName: 'Consultation' },
      rates,
    );

    expect(result.ratePercent).toBe('0');
    expect(result.problem).toBeNull();
  });

  it('leaves the flat rate alone under FLAT_RATE', () => {
    const flat = resolveTaxTreatment(
      { vatCountry: null, vatNumber: null },
      { destinationCountry: 'DE', vatNumber: null, vatNumberValid: null },
      EU,
    );

    const result = rateForLine(
      flat,
      { vatCategory: VatCategory.STANDARD, flatRatePercent: '18', productName: 'Gloves' },
      rates,
    );

    // An Indian GST rate, untouched by anything in this module.
    expect(result.ratePercent).toBe('18');
  });
});

describe('applyLineTax with a tax-inclusive catalogue', () => {
  /** A Dutch shop listing gross prices: €121 is €100 plus 21% Dutch VAT. */
  function dutchInclusiveSetup(buyer: Parameters<typeof resolveTaxTreatment>[1]): TaxSetup {
    const context = resolveTaxTreatment(DUTCH_SELLER, buyer, EU);

    const table = new Map([
      [VatCategory.STANDARD, decimal('19')],
      [VatCategory.REDUCED, decimal('7')],
    ]);

    return {
      context,
      rates: context.rateCountry === 'DE' ? table : new Map([[VatCategory.STANDARD, decimal('21')]]),
      domesticRates: new Map([[VatCategory.STANDARD, decimal('21')]]),
    };
  }

  const line = {
    vatCategory: VatCategory.STANDARD,
    flatRatePercent: '21',
    taxInclusive: true,
    productName: 'Gloves',
  };

  it('strips the seller’s VAT out of a gross price when zero-rating', () => {
    const setup = dutchInclusiveSetup({
      destinationCountry: 'DE',
      vatNumber: 'DE811569869',
      vatNumberValid: true,
    });

    const result = applyLineTax(setup, line, 12_100n);

    // The whole point. Keeping €121 and setting the tax line to zero would
    // charge a German wholesaler 21% more than they owe and hand the seller
    // money that is not theirs.
    expect(result.unitPriceMinor).toBe(10_000n);
    expect(result.taxRatePercent).toBe('0');
    expect(result.taxInclusive).toBe(false);
  });

  it('re-taxes a gross price at the destination’s rate for a consumer', () => {
    const setup = dutchInclusiveSetup({
      destinationCountry: 'DE',
      vatNumber: null,
      vatNumberValid: null,
    });

    const result = applyLineTax(setup, line, 12_100n);

    // €121 gross becomes €100 net, then German 19% goes on top: €119.
    expect(result.unitPriceMinor).toBe(10_000n);
    expect(result.taxRatePercent).toBe('19');
    expect(result.taxInclusive).toBe(false);
  });

  it('leaves an inclusive price completely alone under FLAT_RATE', () => {
    const context = resolveTaxTreatment(
      { vatCountry: null, vatNumber: null },
      { destinationCountry: 'DE', vatNumber: null, vatNumberValid: null },
      EU,
    );

    const result = applyLineTax(
      { context, rates: new Map(), domesticRates: new Map() },
      { ...line, flatRatePercent: '18' },
      12_100n,
    );

    // A GST deployment's inclusive pricing must not be rewritten by a module
    // it has not opted into.
    expect(result.unitPriceMinor).toBe(12_100n);
    expect(result.taxRatePercent).toBe('18');
    expect(result.taxInclusive).toBe(true);
  });

  it('leaves an exclusive price’s amount alone and only changes the rate', () => {
    const setup = dutchInclusiveSetup({
      destinationCountry: 'DE',
      vatNumber: null,
      vatNumberValid: null,
    });

    const result = applyLineTax(setup, { ...line, taxInclusive: false }, 10_000n);

    expect(result.unitPriceMinor).toBe(10_000n);
    expect(result.taxRatePercent).toBe('19');
  });
});
