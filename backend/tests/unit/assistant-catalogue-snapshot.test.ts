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
    },
    categories: [{ name: 'Fasteners & Fixings', productCount: 3 }],
    products: [product()],
    piecesPerCarton: 500,
    ...overrides,
  });
}

describe('the catalogue snapshot', () => {
  it("quotes the operator's own product by the carton", () => {
    // 4250 minor per piece, 500 to a carton: INR 21,250.00.
    expect(snapshot()).toContain('- price: INR 21250.00 per carton');
    expect(snapshot()).toContain('- sold by: this store itself, by the carton of 500 pieces');
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
});
