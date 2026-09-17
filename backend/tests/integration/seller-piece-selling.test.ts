/**
 * A seller's product sold by the piece, beside the operator's sold by the carton.
 *
 * THE BUG THIS FILE EXISTS TO KEEP FIXED
 *
 * The shop began as an operator selling cartons of 500, and the conversion was
 * applied to every basket line there was, because for a while every basket line
 * there was belonged to the operator. Then sellers arrived. A seller listing a
 * ten-rupee item priced it per piece, a buyer asked for twelve, and the basket
 * converted "twelve pieces" into one carton of five hundred and charged five
 * thousand rupees for it. Nothing in the path was broken in a way that would
 * show up as an error - the arithmetic was right, it was simply the operator's
 * arithmetic applied to somebody else's offer.
 *
 * The fix is an ordering, not a formula: **resolve who is selling the line
 * before deciding what the line is counted in.** So the claims below are about
 * both halves at once, because either alone is satisfiable by a wrong shop:
 *
 *   - The operator's carton still converts. A shop that sells pieces to
 *     everybody is not fixed, it is differently broken.
 *   - A seller's piece does not.
 *   - The two sit in one basket, each keeping its own unit, and the total is
 *     the sum of two different bases rather than one rule applied twice.
 *
 * WHY THIS FILE SETS THE CARTON ITSELF
 *
 * The rest of the suite runs with a carton of ONE piece - see the note in
 * `tests/setup.ts` - which keeps every other file's figures checkable by hand.
 * It would also make every assertion here pass against the unfixed code, since
 * multiplying by one is what the fix does anyway. At 500 the difference between
 * right and wrong is a factor of five hundred, which is the point.
 *
 * The dynamic imports in `beforeAll` are what make that possible: a static
 * import is evaluated before any statement in the file body, and `config/env.ts`
 * reads the environment once, when it is first imported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PIECES_PER_CARTON = '500';

const PER_CARTON = 500;

/** The operator's price, per piece. A carton is five hundred of these. */
const OPERATOR_PIECE_PRICE = 40n;

/** The seller's price, per piece. This is the whole price of one piece. */
const SELLER_PIECE_PRICE = 1_000n;

// Type-only, so nothing here loads a module before the line above has run.
import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;

const EMAIL = 'piece-buyer@test.local';
const PASSWORD = 'PieceBuyer!2026';
const CATEGORY_SLUG = 'piece-selling-test';
const SELLER_SLUG = 'pst-acme';

let operatorProductId = '';
let sellerProductId = '';
let sellerAccountId = '';
let sellerOfferId = '';
let cookieHeader = '';
let csrfToken = '';

interface CartLineBody {
  productId: string;
  quantity: number;
  unitPrice: { minor: string };
  lineSubtotal: { minor: string };
  sellerOfferId: string | null;
  ordering?: { unit: string; unitQuantity: number; piecesPerUnit: number };
}

interface CartBody {
  cart?: {
    itemCount?: number;
    lines?: CartLineBody[];
    totals?: { subtotal?: { minor: string } };
  };
}

function lineFor(body: string, productId: string): CartLineBody | undefined {
  return (JSON.parse(body) as CartBody).cart?.lines?.find((line) => line.productId === productId);
}

async function emptyCart(): Promise<void> {
  await app.inject({
    method: 'DELETE',
    url: '/api/v1/cart',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
  });
}

async function addToCart(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/cart/items',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    payload,
  });
}

/**
 * Scoped to what this file made, and nothing else.
 *
 * Orders reference offers with ON DELETE RESTRICT, and a neighbouring file's
 * warehouse is not this file's to remove - both are ways a cleanup has broken
 * the next run's first test here before.
 */
async function cleanUp(): Promise<void> {
  await prisma.cartItem.deleteMany({
    where: { cart: { customerProfile: { user: { emailNormalized: EMAIL } } } },
  });
  await prisma.cart.deleteMany({
    where: { customerProfile: { user: { emailNormalized: EMAIL } } },
  });
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'pst-' } } },
  });
  await prisma.sellerInventoryMovement.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'pst-' } } },
  });
  await prisma.sellerInventory.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'pst-' } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'pst-' } } },
  });
  await prisma.sellerLocation.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'pst-' } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'pst-' } } });
  await prisma.productPrice.deleteMany({
    where: { product: { category: { slug: CATEGORY_SLUG } } },
  });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { Role } = await import('../../src/domain/permissions.js');

  app = await buildApp();
  await app.ready();

  await cleanUp();

  /*
   * A default warehouse, only if the deployment has none.
   *
   * The cart refuses to price anything without one. Created rather than
   * assumed because a neighbouring file wipes every location, and NOT removed
   * in cleanup for the same reason - it is shared furniture, not this file’s.
   */
  const anyLocation = await prisma.inventoryLocation.findFirst({ select: { id: true } });
  if (anyLocation === null) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'PST-MAIN', name: 'Main', isDefault: true, isActive: true },
    });
  }

  const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });
  const taxClassId =
    taxClass?.id ??
    (
      await prisma.taxClass.create({
        data: { id: newId(), code: 'PST18', name: 'GST 18%', ratePercent: '18.000000', isActive: true },
      })
    ).id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Piece selling', slug: CATEGORY_SLUG, isActive: true },
  });

  /** The operator's own line. Priced per piece, sold by the carton. */
  const operatorProduct = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId,
      name: 'Operator syringe',
      slug: 'pst-operator-syringe',
      sku: 'PST-OP-1',
      basePriceMinor: OPERATOR_PIECE_PRICE,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  operatorProductId = operatorProduct.id;

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: operatorProductId,
      variantKey: '',
      currencyCode: 'INR',
      basePriceMinor: OPERATOR_PIECE_PRICE,
    },
  });

  /**
   * The product a SELLER described.
   *
   * Exactly the shape `publishApprovedListing` writes: marked as the
   * marketplace's, with no price row of its own until an offer projects one.
   */
  const sellerProduct = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId,
      name: 'Seller tubing',
      slug: 'pst-seller-tubing',
      sku: 'PST-SELLER-1',
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      isStockTracked: false,
      // Deliberately a thousand. This is the OPERATOR's minimum, written in
      // pieces, for a product the operator does not sell - it must not reach
      // the seller's line. See the note in the cart's add path.
      minOrderQty: 1_000,
      qtyIncrement: 1,
    },
  });
  sellerProductId = sellerProduct.id;

  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'PST Acme Ltd',
      displayName: 'PST Acme',
      displayNameNormalized: 'pst acme',
      slug: SELLER_SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  sellerOfferId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: sellerOfferId,
      sellerAccountId,
      productId: sellerProductId,
      variantKey: '',
      sellerSku: 'PST-ACME-TUBING',
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: SELLER_PIECE_PRICE,
      currency: 'INR',
      minimumOrderQuantity: 5,
      orderIncrement: 1,
      availableQuantity: 25,
    },
  });

  const { syncMarketplacePrice } = await import(
    '../../src/modules/catalog/marketplace-price.service.js'
  );
  await syncMarketplacePrice(prisma, sellerProductId);

  const customerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CUSTOMER },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: customerRole.id } },
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Piece Buyer', activatedAt: new Date() },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];
  cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  csrfToken = jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '';
  expect(csrfToken).not.toBe('');
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('a seller sells by the piece', () => {
  it('charges twelve pieces at twelve times the piece price', async () => {
    await emptyCart();

    const response = await addToCart({ productId: sellerProductId, quantity: 12 });
    expect(response.statusCode, response.body).toBe(201);

    const line = lineFor(response.body, sellerProductId);

    // Twelve. Not one carton, and emphatically not five hundred.
    expect(line?.quantity).toBe(12);
    expect(line?.ordering).toMatchObject({
      unit: 'PIECE',
      unitQuantity: 12,
      piecesPerUnit: 1,
      // The seller's own terms, sent so the basket's stepper can be right
      // rather than approximately right.
      minimumOrderQuantity: 5,
      orderIncrement: 1,
    });

    // The price is per piece, and the line is twelve of them. This is the
    // assertion the whole file is for: against the unfixed code the subtotal
    // was 500_000 - five hundred pieces at the seller's piece price.
    expect(line?.unitPrice.minor).toBe(SELLER_PIECE_PRICE.toString());
    expect(line?.lineSubtotal.minor).toBe((SELLER_PIECE_PRICE * 12n).toString());
  });

  it('takes the unit the storefront names on a seller’s line', async () => {
    await emptyCart();

    /*
     * What the product page actually posts.
     *
     * It names the unit the server itself published for the product, and on a
     * seller's line that is `PIECE`. A schema that accepted only the carton
     * refused this outright - every attempt to buy a seller's product came
     * back as "the request contains invalid data", with no way for the shopper
     * to make it valid, because the only unit the seller sells in was not one
     * the route would take.
     */
    const response = await addToCart({
      productId: sellerProductId,
      variantId: null,
      quantity: 7,
      orderingUnit: 'PIECE',
      unitQuantity: 7,
    });

    expect(response.statusCode, response.body).toBe(201);

    const line = lineFor(response.body, sellerProductId);
    expect(line?.quantity).toBe(7);
    expect(line?.ordering).toMatchObject({ unit: 'PIECE', unitQuantity: 7, piecesPerUnit: 1 });
    expect(line?.lineSubtotal.minor).toBe((SELLER_PIECE_PRICE * 7n).toString());
  });

  it('never multiplies a seller line by the operator’s carton', async () => {
    await emptyCart();
    await addToCart({ productId: sellerProductId, quantity: 1 });

    const item = await prisma.cartItem.findFirstOrThrow({
      where: { sellerOfferId },
      select: { quantity: true, unitQuantity: true, piecesPerUnitSnapshot: true, orderingUnit: true },
    });

    // The snapshot factor is one. Every downstream reader - tax, commission,
    // the invoice, the ERP push - multiplies by this, so one is the number
    // that makes all of them right at once.
    expect(item.piecesPerUnitSnapshot).toBe(1);
    expect(item.orderingUnit).toBe('PIECE');
    expect(item.quantity).not.toBe(PER_CARTON);
  });

  it('raises a request below the seller’s minimum to the seller’s minimum', async () => {
    await emptyCart();

    const response = await addToCart({ productId: sellerProductId, quantity: 2 });
    expect(response.statusCode, response.body).toBe(201);

    // The seller takes five at a time. Not the operator's thousand-piece
    // minimum sitting on the product row, which belongs to a product the
    // operator does not sell.
    expect(lineFor(response.body, sellerProductId)?.quantity).toBe(5);
  });

  it('steps a quantity onto the seller’s own increment', async () => {
    await prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: { orderIncrement: 4 },
    });

    await emptyCart();
    const response = await addToCart({ productId: sellerProductId, quantity: 6 });
    expect(response.statusCode, response.body).toBe(201);

    // Minimum 5, stepping in 4s: the first buyable quantity at or above 6 is
    // 8. Applied in sell units before the piece count is derived, which is why
    // it lands on the step rather than merely above the minimum.
    expect(lineFor(response.body, sellerProductId)?.quantity).toBe(8);

    await prisma.sellerOffer.update({
      where: { id: sellerOfferId },
      data: { orderIncrement: 1 },
    });
  });

  it('refuses a client that asks for a seller’s piece offer by the carton', async () => {
    await emptyCart();

    // The generous reading of this request hands the buyer five hundred pieces
    // at the price of one, so it is refused rather than reinterpreted.
    const response = await addToCart({
      productId: sellerProductId,
      orderingUnit: 'OUTER_CARTON',
      unitQuantity: 2,
      quantity: 1,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'SELLER_OFFER_UNIT_MISMATCH',
    );
  });

  it('ignores a pieces-per-unit the client tries to state for itself', async () => {
    await emptyCart();

    // There is no request shape that carries one, and adding one would be the
    // whole vulnerability. Asserted from the stored row rather than the
    // response, because the response could echo a figure it never used.
    await addToCart({ productId: sellerProductId, quantity: 5, piecesPerUnitSnapshot: 500 });

    const item = await prisma.cartItem.findFirstOrThrow({
      where: { sellerOfferId },
      select: { piecesPerUnitSnapshot: true, quantity: true },
    });

    expect(item.piecesPerUnitSnapshot).toBe(1);
    expect(item.quantity).toBe(5);
  });
});

describe('the operator still sells by the carton', () => {
  it('turns two cartons into a thousand pieces, unchanged', async () => {
    await emptyCart();

    const response = await addToCart({
      productId: operatorProductId,
      orderingUnit: 'OUTER_CARTON',
      unitQuantity: 2,
      quantity: 1,
    });
    expect(response.statusCode, response.body).toBe(201);

    const line = lineFor(response.body, operatorProductId);

    expect(line?.quantity).toBe(2 * PER_CARTON);
    expect(line?.ordering).toMatchObject({
      unit: 'OUTER_CARTON',
      unitQuantity: 2,
      piecesPerUnit: PER_CARTON,
    });
    expect(line?.lineSubtotal.minor).toBe((OPERATOR_PIECE_PRICE * BigInt(2 * PER_CARTON)).toString());
  });

  it('still takes a caller that speaks in pieces up to whole cartons', async () => {
    await emptyCart();

    // The documented route for a reorder of a pre-carton line and for an ERP
    // client that counts in pieces. It rounds UP, and it must keep doing so.
    const response = await addToCart({ productId: operatorProductId, quantity: 600 });
    expect(response.statusCode, response.body).toBe(201);

    expect(lineFor(response.body, operatorProductId)?.quantity).toBe(2 * PER_CARTON);
  });
});

describe('a basket holding both', () => {
  it('totals each line on its own basis rather than one rule twice', async () => {
    await emptyCart();

    await addToCart({
      productId: operatorProductId,
      orderingUnit: 'OUTER_CARTON',
      unitQuantity: 2,
      quantity: 1,
    });
    const response = await addToCart({ productId: sellerProductId, quantity: 12 });
    expect(response.statusCode, response.body).toBe(201);

    const operatorLine = lineFor(response.body, operatorProductId);
    const sellerLine = lineFor(response.body, sellerProductId);

    // Two cartons of five hundred, and twelve pieces. Side by side, each
    // keeping its own unit, its own factor and its own price basis.
    expect(operatorLine?.quantity).toBe(1_000);
    expect(operatorLine?.ordering?.piecesPerUnit).toBe(PER_CARTON);

    expect(sellerLine?.quantity).toBe(12);
    expect(sellerLine?.ordering?.piecesPerUnit).toBe(1);
    expect(sellerLine?.sellerOfferId).toBe(sellerOfferId);

    // And the basket is the sum of the two bases, not either one applied to
    // both: 1,000 x 40 from the operator, 12 x 1,000 from the seller.
    const expected = OPERATOR_PIECE_PRICE * 1_000n + SELLER_PIECE_PRICE * 12n;
    expect((JSON.parse(response.body) as CartBody).cart?.totals?.subtotal?.minor).toBe(
      expected.toString(),
    );
  });
});
