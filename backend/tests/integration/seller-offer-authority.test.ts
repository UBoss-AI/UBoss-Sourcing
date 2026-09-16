/**
 * Who decides a seller's terms, and who may change them.
 *
 * Everything in the previous file is about arithmetic - twelve pieces costing
 * twelve times the piece price. This one is about the question underneath it:
 * **where the numbers in that arithmetic are allowed to come from.**
 *
 * The answer is the offer row, written by its own seller, and nothing else. It
 * matters because each of the alternatives is an exploit rather than a bug:
 *
 *   - A seller who could state their own pieces-per-unit could state 500 and
 *     take five hundred pieces out of their competitor's stock for one piece
 *     of revenue.
 *   - A seller who could edit another seller's offer could price a rival out
 *     of the market, or into selling at a loss.
 *   - A minimum of zero or a step of zero makes an offer unbuyable at every
 *     quantity, and the seller finds out from a buyer.
 *
 * None of these are reachable from the storefront's own screens. All of them
 * are reachable from a request somebody writes by hand, which is the only kind
 * of request that matters here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import {
  SELLER_SELLING_UNIT,
  isValidUnitQuantity,
  operatorSellUnit,
  resolveSellUnitQuantity,
  sellerSellUnit,
} from '../../src/domain/ordering-unit.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { setOfferStatus, updateOfferPrice } from '../../src/modules/seller/offer.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

const CATEGORY_SLUG = 'soa-test-category';

let productId = '';
let acmeOfferId = '';
let acme: SellerMembership;
let rival: SellerMembership;
let suspended: SellerMembership;
let suspendedOfferId = '';

function membershipFor(
  accountId: string,
  displayName: string,
  slug: string,
  status: 'APPROVED' | 'SUSPENDED',
): SellerMembership {
  return {
    sellerAccountId: accountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName,
    legalName: `${displayName} Ltd`,
    slug,
    status,
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    // The two that actually gate anything. A suspended seller is not trading,
    // and `assertSellerTrading` is what every write consults.
    isTrading: status === 'APPROVED',
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

async function makeSeller(
  slug: string,
  displayName: string,
  status: 'APPROVED' | 'SUSPENDED',
): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status,
    },
  });

  return id;
}

async function cleanUp(): Promise<void> {
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'soa-' } } },
  });
  await prisma.sellerPriceTier.deleteMany({
    where: { offer: { sellerAccount: { slug: { startsWith: 'soa-' } } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'soa-' } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'soa-' } } });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
}

beforeAll(async () => {
  await cleanUp();

  const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });
  const taxClassId =
    taxClass?.id ??
    (
      await prisma.taxClass.create({
        data: {
          id: newId(),
          code: 'SOA18',
          name: 'GST 18%',
          ratePercent: '18.000000',
          isActive: true,
        },
      })
    ).id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Offer authority', slug: CATEGORY_SLUG, isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId,
      name: 'Seller widget',
      slug: 'soa-seller-widget',
      sku: 'SOA-1',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

  const acmeId = await makeSeller('soa-acme', 'SOA Acme', 'APPROVED');
  const rivalId = await makeSeller('soa-rival', 'SOA Rival', 'APPROVED');
  const suspendedId = await makeSeller('soa-stopped', 'SOA Stopped', 'SUSPENDED');

  acme = membershipFor(acmeId, 'SOA Acme', 'soa-acme', 'APPROVED');
  rival = membershipFor(rivalId, 'SOA Rival', 'soa-rival', 'APPROVED');
  suspended = membershipFor(suspendedId, 'SOA Stopped', 'soa-stopped', 'SUSPENDED');

  acmeOfferId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: acmeOfferId,
      sellerAccountId: acmeId,
      productId,
      variantKey: '',
      sellerSku: 'SOA-ACME-1',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 1_000n,
      currency: 'INR',
      minimumOrderQuantity: 1,
      orderIncrement: 1,
    },
  });

  /*
   * An offer that was approved before its seller was stopped.
   *
   * INACTIVE, because the interesting question is whether a suspended seller
   * can switch it ON - an approval granted last month must not survive a
   * suspension granted today.
   */
  suspendedOfferId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: suspendedOfferId,
      sellerAccountId: suspendedId,
      productId,
      variantKey: '',
      sellerSku: 'SOA-STOPPED-1',
      status: 'INACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: 900n,
      currency: 'INR',
    },
  });
});

afterAll(async () => {
  await cleanUp();
});

describe('the unit factor is the server’s to decide', () => {
  it('gives a seller’s offer a factor of exactly one', () => {
    const spec = sellerSellUnit({
      orderingUnit: SELLER_SELLING_UNIT,
      minimumOrderQuantity: 5,
      orderIncrement: 5,
      maximumOrderQuantity: 100,
    });

    // One selected unit is one physical piece. Every downstream reader - tax,
    // commission, the invoice, the ERP push - multiplies by this.
    expect(spec.piecesPerUnit).toBe(1);
    expect(spec.unit).toBe('PIECE');
  });

  it('refuses to price an offer stored in a unit a seller may not sell in', () => {
    /*
     * There is no safe fallback available here, which is the whole reason this
     * throws rather than choosing one: reading a carton offer as pieces divides
     * the seller's price by five hundred, and reading it as cartons multiplies
     * the buyer's basket by the same. The migration takes such an offer off
     * sale and asks the seller to restate it.
     */
    expect(() =>
      sellerSellUnit({
        orderingUnit: 'OUTER_CARTON',
        minimumOrderQuantity: 1,
        orderIncrement: 1,
        maximumOrderQuantity: null,
      }),
    ).toThrowError(/pieces/i);
  });

  it('applies the minimum and the step in sell units, not in pieces', () => {
    const spec = sellerSellUnit({
      orderingUnit: SELLER_SELLING_UNIT,
      minimumOrderQuantity: 5,
      orderIncrement: 4,
      maximumOrderQuantity: null,
    });

    // Minimum 5 stepping in 4s: the first buyable quantity is 8, not 5. The
    // step is a rule about what the seller can actually pick and pack, and the
    // minimum does not exempt a buyer from it.
    const resolved = resolveSellUnitQuantity({
      spec,
      unit: 'PIECE',
      unitQuantity: 5,
      pieces: 0,
      field: 'unitQuantity',
    });

    expect(resolved.quantity).toBe(8);
    expect(resolved.piecesPerUnitSnapshot).toBe(1);

    expect(isValidUnitQuantity(spec, 8)).toBe(true);
    expect(isValidUnitQuantity(spec, 5)).toBe(false);
    expect(isValidUnitQuantity(spec, 7)).toBe(false);
  });

  it('refuses a request that asks for a seller’s piece offer by the carton', () => {
    const spec = sellerSellUnit({
      orderingUnit: SELLER_SELLING_UNIT,
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      maximumOrderQuantity: null,
    });

    try {
      resolveSellUnitQuantity({
        spec,
        unit: 'OUTER_CARTON',
        unitQuantity: 2,
        pieces: 1,
        field: 'unitQuantity',
      });
      expect.unreachable('a carton request on a piece offer must be refused');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.SELLER_OFFER_UNIT_MISMATCH });
    }
  });

  it('still reads a piece count as whole cartons on the operator’s own line', () => {
    /*
     * The asymmetry is deliberate. This is the documented route for a reorder
     * of a pre-carton line and for an ERP client that counts in pieces, it
     * rounds UP, and breaking it would break those callers for no gain - the
     * worst it can do is deliver a whole carton to somebody who asked for most
     * of one.
     */
    const resolved = resolveSellUnitQuantity({
      spec: operatorSellUnit(500),
      unit: 'PIECE',
      unitQuantity: null,
      pieces: 600,
      field: 'quantity',
    });

    expect(resolved.quantity).toBe(1_000);
    expect(resolved.orderingUnit).toBe('OUTER_CARTON');
  });
});

describe('whose offer it is', () => {
  /*
   * NOT_FOUND rather than "denied", and that is the right answer.
   *
   * "You may not touch this" confirms the offer exists, which lets a
   * competitor walk ids to map out who is selling what and at what SKU.
   * "No such listing" is the same answer they would get for an id that was
   * never issued, and the two being indistinguishable is the point.
   */
  it('answers a seller reaching for another seller’s price as if it were not there', async () => {
    await expect(
      updateOfferPrice(rival, acmeOfferId, { priceMinor: '1' }),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });

    // Unchanged. Not "changed and then complained about".
    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: acmeOfferId } });
    expect(offer.priceMinor).toBe(1_000n);
  });

  it('answers the same way for switching another seller’s listing on or off', async () => {
    await expect(setOfferStatus(rival, acmeOfferId, 'PAUSED')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });

    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: acmeOfferId } });
    expect(offer.status).toBe('ACTIVE');
  });

  it('refuses a suspended seller putting an approved listing on sale', async () => {
    /*
     * The listing was approved. The seller was then stopped. An approval is
     * not a standing permission to trade - if it were, a suspension would be a
     * suggestion.
     */
    await expect(setOfferStatus(suspended, suspendedOfferId, 'ACTIVE')).rejects.toMatchObject({
      code: ErrorCode.SELLER_SUSPENDED,
    });

    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: suspendedOfferId } });
    expect(offer.status).toBe('INACTIVE');
  });
});

describe('terms that would make an offer unbuyable', () => {
  it('refuses a minimum below one piece', async () => {
    await expect(
      updateOfferPrice(acme, acmeOfferId, { priceMinor: '1000', minimumOrderQuantity: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('refuses a step below one piece', async () => {
    // A step of zero divides by zero on every quantity check.
    await expect(
      updateOfferPrice(acme, acmeOfferId, { priceMinor: '1000', orderIncrement: 0 }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('refuses a ceiling below the minimum', async () => {
    await expect(
      updateOfferPrice(acme, acmeOfferId, {
        priceMinor: '1000',
        minimumOrderQuantity: 10,
        maximumOrderQuantity: 5,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('refuses a minimum, step and ceiling that no quantity satisfies', async () => {
    // Minimum 5 stepping in 4s means the first buyable quantity is 8, which is
    // above a ceiling of 6. Legal individually, unbuyable together.
    await expect(
      updateOfferPrice(acme, acmeOfferId, {
        priceMinor: '1000',
        minimumOrderQuantity: 5,
        orderIncrement: 4,
        maximumOrderQuantity: 6,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('accepts terms a buyer can actually meet', async () => {
    await updateOfferPrice(acme, acmeOfferId, {
      priceMinor: '1200',
      minimumOrderQuantity: 5,
      orderIncrement: 5,
      maximumOrderQuantity: 100,
    });

    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: acmeOfferId } });

    expect(offer.priceMinor).toBe(1_200n);
    expect(offer.minimumOrderQuantity).toBe(5);
    expect(offer.orderIncrement).toBe(5);
    expect(offer.maximumOrderQuantity).toBe(100);
    // And it is still sold by the piece. A price change is not a unit change.
    expect(offer.orderingUnit).toBe('PIECE');
  });
});
