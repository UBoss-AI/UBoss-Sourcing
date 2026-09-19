/**
 * What the storefront assistant is allowed to be told about the catalogue.
 *
 * The snapshot is the assistant's only source of product truth, so a defect in
 * it is invisible in exactly the way that matters: the model answers fluently,
 * every figure it quotes is a real number from the database, and the answer is
 * wrong. Three such defects are guarded here, and all three shipped.
 *
 *   1. **Every price was multiplied by the carton size.** The operator sells
 *      cartons and a third-party seller sells pieces - `ordering-unit.ts` is
 *      about nothing else - and the renderer applied the operator's factor to
 *      both. A seller's item was quoted to customers at five hundred times the
 *      figure on its own product page.
 *   2. **Marketplace listings had no seller and no live price.** The price
 *      came off the mirror on the product row rather than off the offer that
 *      the basket actually charges, so a paused listing still quoted a price.
 *   3. **There was no way to answer "what do you sell".** A flat list of
 *      several hundred products cannot answer a question about the range, and
 *      the assistant answered it from whichever trade happened to be at the
 *      top of the list.
 *
 * `renderCatalogueSnapshot` is pure, so all of this is exercised without a
 * database. What the queries feeding it select is a separate question, and the
 * integration suite's business is.
 */
import { describe, expect, it } from 'vitest';
import {
  renderCatalogueSnapshot,
  type SnapshotInput,
  type SnapshotProduct,
} from '../../src/modules/assistant/assistant.service.js';

function product(overrides: Partial<SnapshotProduct> = {}): SnapshotProduct {
  return {
    name: 'Hex head bolt M6',
    slug: 'hex-head-bolt-m6',
    sku: 'HB-M6',
    shortDescription: null,
    basePriceMinor: 4250n,
    currency: 'INR',
    isPriceOnRequest: false,
    isOrderable: true,
    unavailabilityReason: null,
    isMarketplaceProduct: false,
    // The fixture is the cartoned consumable this snapshot was written for;
    // a product sold one at a time passes null and is quoted per piece.
    piecesPerCarton: 500,
    minOrderQty: 1,
    qtyIncrement: 1,
    isRecurringEligible: false,
    category: { name: 'Fasteners & Fixings' },
    taxClass: { ratePercent: '18.00', isInclusive: false },
    attributes: [],
    variants: [],
    sellerOffers: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<SnapshotInput> = {}): string {
  return renderCatalogueSnapshot({
    store: {
      displayName: 'Test Supplies',
      supportEmail: 'help@example.test',
      supportPhone: null,
      currency: 'INR',
      // The identity and policy fields default to "the operator has stated
      // nothing", which is the case worth having as the default: the renderer
      // must omit each line entirely rather than print an empty one, and a
      // fixture that filled them all in would never exercise that.
      legalName: null,
      vatNumber: null,
      gstin: null,
      timezone: null,
      address: null,
      policies: [],
    },
    howItWorks: { delivery: [], markets: [], currencies: [] },
    categories: [{ name: 'Fasteners & Fixings', productCount: 3 }],
    products: [product()],
    ...overrides,
  });
}

describe('the catalogue snapshot', () => {
  it("quotes the operator's own product by the carton", () => {
    // 4250 minor per piece, 500 to a carton: INR 21,250.00.
    expect(snapshot()).toContain('- price: INR 21250.00 per carton');
    expect(snapshot()).toContain('- sold by: this store itself, by the carton of 500 pieces');
  });

  it('quotes an operator product sold one at a time by the piece', () => {
    // The catalogue holds both. A drill has no carton, and quoting it as one
    // put it on the page at five hundred times its price.
    const single = snapshot({ products: [product({ piecesPerCarton: null })] });

    expect(single).toContain('- price: INR 42.50 per piece');
    expect(single).toContain('- sold by: this store itself, by the piece');

    // Scoped to the price and selling lines rather than the whole snapshot:
    // the preamble explains what "per carton" means where it appears, and is
    // supposed to, because the same catalogue holds products that are.
    expect(single).not.toContain('- price: INR 21250.00 per carton');
    expect(single).not.toContain('by the carton of');
  });

  it("quotes a seller's product by the piece, at the offer's own price", () => {
    const text = snapshot({
      products: [
        product({
          name: 'Nike Air Jordan',
          isMarketplaceProduct: true,
          // The mirror on the product row. Never the figure to quote.
          basePriceMinor: 249900n,
          sellerOffers: [
            {
              priceMinor: 249900n,
              currency: 'INR',
              minimumOrderQuantity: 1,
              orderIncrement: 1,
              sellerAccount: { displayName: 'Nova Traders' },
            },
          ],
        }),
      ],
    });

    expect(text).toContain('- price: INR 2499.00 per piece');
    // The bug, stated as the thing that must not appear: 2,499 × 500.
    expect(text).not.toContain('1249500.00');
    expect(text).toContain('- sold by: Nova Traders, an independent seller');
  });

  it('names the cheapest seller and says how many others there are', () => {
    const text = snapshot({
      products: [
        product({
          isMarketplaceProduct: true,
          sellerOffers: [
            {
              priceMinor: 1000n,
              currency: 'INR',
              minimumOrderQuantity: 10,
              orderIncrement: 5,
              sellerAccount: { displayName: 'Cheaper Ltd' },
            },
            {
              priceMinor: 1500n,
              currency: 'INR',
              minimumOrderQuantity: 1,
              orderIncrement: 1,
              sellerAccount: { displayName: 'Dearer Ltd' },
            },
          ],
        }),
      ],
    });

    expect(text).toContain('- price: INR 10.00 per piece');
    expect(text).toContain('Cheaper Ltd');
    expect(text).toContain('also offered by 1 other seller)');
    // The quoted seller's terms, not the other one's and not the operator's.
    expect(text).toContain('- ordering rules: minimum 10 pieces, in multiples of 5 pieces');
  });

  it('refuses to quote a price for a marketplace product nobody has on sale', () => {
    const text = snapshot({
      products: [product({ isMarketplaceProduct: true, basePriceMinor: 999900n, sellerOffers: [] })],
    });

    expect(text).toContain('no seller has this on sale at the moment');
    expect(text).toContain('- availability: no seller has it on sale at the moment');
    expect(text).not.toContain('9999.00');
  });

  it('refuses to quote a price that is not published', () => {
    const text = snapshot({ products: [product({ isPriceOnRequest: true })] });

    expect(text).toContain('- price: not published');
    expect(text).not.toContain('21250.00');
  });

  it('says when a product cannot be ordered, and why', () => {
    const text = snapshot({
      products: [product({ isOrderable: false, unavailabilityReason: 'Recalled by the maker' })],
    });

    expect(text).toContain('- availability: cannot be ordered at the moment — Recalled by the maker');
  });

  it('leads with the whole range, so a question about it has an answer', () => {
    const text = snapshot({
      categories: [
        { name: 'Fasteners & Fixings', productCount: 120 },
        { name: 'Musical Instruments', productCount: 4 },
      ],
    });

    const index = text.indexOf('WHAT THIS STORE SELLS');
    const products = text.indexOf('PUBLISHED PRODUCTS');

    expect(index).toBeGreaterThan(-1);
    // Before the product list, not after it: the model reads a prompt in order
    // and a range stated under six hundred lines of one trade is not read.
    expect(index).toBeLessThan(products);
    expect(text).toContain('- Fasteners & Fixings (120)');
    expect(text).toContain('- Musical Instruments (4)');
  });

  it('never describes the shop as being in one trade', () => {
    // The catalogue says what is sold. Nothing the renderer writes may.
    expect(snapshot()).not.toMatch(/medical|clinical|hospital|laborator/i);
  });

  it("prices a variant in its own product's unit", () => {
    const operator = snapshot({
      products: [product({ variants: [{ sku: 'V1', name: 'M6 × 30', priceMinor: 4250n }] })],
    });
    expect(operator).toContain('V1: M6 × 30 — INR 21250.00 per carton');

    const seller = snapshot({
      products: [
        product({
          isMarketplaceProduct: true,
          variants: [{ sku: 'V1', name: 'M6 × 30', priceMinor: 4250n }],
          sellerOffers: [
            {
              priceMinor: 4250n,
              currency: 'INR',
              minimumOrderQuantity: 1,
              orderIncrement: 1,
              sellerAccount: { displayName: 'Nova Traders' },
            },
          ],
        }),
      ],
    });
    expect(seller).toContain('V1: M6 × 30 — INR 42.50 per piece');
  });

  /*
   * What the assistant knows BESIDES the catalogue.
   *
   * A buyer asks "who am I actually buying from", "what is your VAT number",
   * "do you ship to Rotterdam" and "what does delivery cost" at least as often
   * as anything about a SKU. Every one of those is a question of fact, and a
   * model with no grounding for it either declines or answers from general
   * knowledge about shops — which on a question of fact is the same thing as
   * inventing an answer.
   *
   * The thing worth testing is not that each field appears. It is the rule
   * that decides whether it appears at all: a field the operator has not
   * filled in must be ABSENT, never printed empty. A model that reads "VAT
   * NUMBER: not set" has been told there is one to find and will helpfully
   * offer to find it.
   */
  describe('what it knows besides the catalogue', () => {
    it('states the trading entity, where the operator has stated it', () => {
      const text = snapshot({
        store: {
          displayName: 'Test Supplies',
          supportEmail: 'help@example.test',
          supportPhone: null,
          currency: 'INR',
          legalName: 'Test Supplies Trading BV',
          vatNumber: 'NL123456789B01',
          gstin: null,
          timezone: 'Europe/Amsterdam',
          address: '42 Havenstraat, Rotterdam, 3011 AA, NL',
          policies: [{ label: 'Returns', url: '/policies/returns' }],
        },
      });

      expect(text).toContain('LEGAL ENTITY: Test Supplies Trading BV');
      expect(text).toContain('VAT NUMBER: NL123456789B01');
      expect(text).toContain('STORE TIME ZONE: Europe/Amsterdam');
      expect(text).toContain('REGISTERED ADDRESS: 42 Havenstraat, Rotterdam, 3011 AA, NL');
      expect(text).toContain('- Returns: /policies/returns');
    });

    it('says nothing at all about a detail the operator has not given', () => {
      // The default fixture has none of them. Absent, not blank: the whole
      // point of the rule.
      const text = snapshot();

      expect(text).not.toContain('LEGAL ENTITY');
      expect(text).not.toContain('VAT NUMBER');
      expect(text).not.toContain('GSTIN');
      expect(text).not.toContain('REGISTERED ADDRESS');
      expect(text).not.toContain('PUBLISHED POLICIES');
      // And the whole "how buying works" heading goes with it, rather than
      // standing over three empty lists.
      expect(text).not.toContain('BUYING FROM THIS STORE');
    });

    it('answers delivery, markets and currencies from the live rows', () => {
      const text = snapshot({
        howItWorks: {
          delivery: [
            {
              name: 'Standard',
              description: 'Kerbside',
              price: 'INR 125.00',
              freeAbove: 'INR 5000.00',
              estimatedDays: 'about 2-4 days',
            },
            {
              name: 'Collection',
              description: null,
              // Free, which is a null price rather than a zero — a delivery
              // option quoted as "INR 0.00" reads as a missing figure.
              price: null,
              freeAbove: null,
              estimatedDays: null,
            },
          ],
          markets: [
            { name: 'India', currencyCode: 'INR' },
            { name: 'Netherlands', currencyCode: 'EUR' },
          ],
          currencies: ['EUR', 'INR'],
        },
      });

      expect(text).toContain('- Standard: INR 125.00; free on orders over INR 5000.00');
      expect(text).toContain('- Collection: free');
      expect(text).toContain('- India (INR)');
      expect(text).toContain('- Netherlands (EUR)');
      expect(text).toContain('Currencies prices are held in: EUR, INR.');

      // The instruction that makes the country list usable as an answer. A
      // list with no rule attached is one the model reads as examples.
      expect(text).toContain('A country not on that list is one this store does not serve');
    });
  });
});
