/**
 * Cart, checkout and the order lifecycle - integration, against a real MariaDB.
 *
 * The claims under test:
 *   - The cart holds no prices. Everything is repriced from the catalog on
 *     every read, so a price change is picked up and a client cannot influence
 *     what anything costs.
 *   - Checkout is atomic: order, immutable snapshots and reserved stock commit
 *     together or not at all.
 *   - A retried checkout produces one order, never two.
 *   - Order history is immutable. Editing a product later must not rewrite it.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  addItem,
  clearCart,
  removeItem,
  resolveCart,
  toCartView,
  updateItemQuantity,
} from '../../src/modules/cart/cart.service.js';
import { receiveStock, getAvailability } from '../../src/modules/inventory/inventory.service.js';
import {
  IdempotencyScope,
  runIdempotent,
} from '../../src/modules/orders/idempotency.service.js';
import { submitCheckout, transitionOrder } from '../../src/modules/orders/order.service.js';

let adminActor: { userId: string; email: string };
let customerProfileId: string;
let otherProfileId: string;
let customerUserId: string;
let productId: string;
let addressId: string;

const CUSTOMER_ACTOR = () => ({
  userId: customerUserId,
  email: 'buyer@checkout.test',
  type: 'CUSTOMER' as const,
});

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderApproval.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.numberSequence.deleteMany({});
  await prisma.productMedia.deleteMany({});
  await prisma.mediaAsset.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

async function makeCustomer(email: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Test Buyer' },
  });
  return { userId, profileId: profile.id };
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Test',
      displayName: 'UBOSS',
      supportEmail: 'support@test.local',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      orderPrefix: 'UB',
    },
  });

  const adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@checkout.test',
      emailNormalized: 'admin@checkout.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@checkout.test' };

  const buyer = await makeCustomer('buyer@checkout.test');
  customerUserId = buyer.userId;
  customerProfileId = buyer.profileId;

  const other = await makeCustomer('other@checkout.test');
  otherProfileId = other.profileId;

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Test Buyer',
      contactPhone: '+91 90000 00000',
      line1: 'Gate 3',
      city: 'Pune',
      state: 'MH',
      postalCode: '411019',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });
  addressId = address.id;

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  await prisma.shippingMethod.create({
    data: {
      id: newId(),
      code: 'STANDARD',
      name: 'Standard delivery',
      priceMinor: 9900n,
      freeAboveMinor: 500_000n,
      isActive: true,
    },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isDefault: true,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Fasteners', slug: 'fasteners', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Hex Bolt M12',
      slug: 'hex-bolt-m12',
      sku: 'HEX-M12',
      shortDescription: 'Grade 8.8',
      basePriceMinor: 4550n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      minOrderQty: 10,
      qtyIncrement: 5,
    },
  });
  productId = product.id;

  await receiveStock({ productId, quantity: 100 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

async function checkout(overrides: Record<string, unknown> = {}) {
  return submitCheckout({
    customerProfileId,
    shippingAddressId: addressId,
    shippingMethodCode: 'STANDARD',
    paymentMode: 'ONLINE',
    actor: CUSTOMER_ACTOR(),
    ...overrides,
  });
}

describe('cart pricing', () => {
  it('prices from the catalog, exactly', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const view = toCartView(await resolveCart(customerProfileId));

    // 20 x 45.50 = 910.00; 18% = 163.80; total 1073.80.
    expect(view.totals.subtotal.formatted).toBe('910.00');
    expect(view.totals.tax.formatted).toBe('163.80');
    expect(view.totals.grandTotal.formatted).toBe('1073.80');
  });

  /**
   * The cart stores no price, so it cannot go stale. This is what makes SOP
   * 5.3's "existing paid orders retain the price captured at checkout" safe:
   * an unpaid cart tracks the catalog.
   */
  it('picks up a price change automatically', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const before = toCartView(await resolveCart(customerProfileId));
    expect(before.totals.subtotal.formatted).toBe('455.00');

    await prisma.product.update({ where: { id: productId }, data: { basePriceMinor: 5000n } });

    const after = toCartView(await resolveCart(customerProfileId));
    expect(after.totals.subtotal.formatted).toBe('500.00');
  });

  it('adds shipping, and waives it above the threshold', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const small = toCartView(
      await resolveCart(customerProfileId, { shippingMethodCode: 'STANDARD' }),
    );
    expect(small.totals.shipping.formatted).toBe('99.00');

    // 200 x 45.50 = 9100.00, above the 5000.00 free-shipping threshold.
    await updateItemQuantity(
      customerProfileId,
      (await resolveCart(customerProfileId)).lines[0]?.itemId ?? '',
      200,
    );
    const large = toCartView(
      await resolveCart(customerProfileId, { shippingMethodCode: 'STANDARD' }),
    );
    expect(large.totals.shipping.formatted).toBe('0.00');
  });

  it('serialises money as strings, never as JS numbers', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const view = toCartView(await resolveCart(customerProfileId));

    expect(typeof view.totals.grandTotal.minor).toBe('string');
    expect(typeof view.lines[0]?.unitPrice.minor).toBe('string');
  });
});

describe('cart mutations', () => {
  it('raises an under-minimum quantity to the product minimum', async () => {
    // A B2B product with a minimum of 10 should not sit at 1 and fail only at
    // checkout.
    const result = await addItem(customerProfileId, { productId, quantity: 1 });
    expect(result.quantity).toBe(10);
  });

  it('merges a repeat add into the existing line', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    await addItem(customerProfileId, { productId, quantity: 10 });

    const resolved = await resolveCart(customerProfileId);
    expect(resolved.lines).toHaveLength(1);
    expect(resolved.lines[0]?.quantity).toBe(20);
  });

  it('treats quantity zero as a removal', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const itemId = (await resolveCart(customerProfileId)).lines[0]?.itemId ?? '';

    await updateItemQuantity(customerProfileId, itemId, 0);
    expect((await resolveCart(customerProfileId)).lines).toHaveLength(0);
  });

  it('refuses to add an unpublished product', async () => {
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });

    await expect(addItem(customerProfileId, { productId, quantity: 10 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  /** The IDOR case: a cart item id from another customer must not resolve. */
  it('scopes item edits to the owning cart', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const itemId = (await resolveCart(customerProfileId)).lines[0]?.itemId ?? '';

    await expect(updateItemQuantity(otherProfileId, itemId, 50)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(removeItem(otherProfileId, itemId)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const unchanged = await resolveCart(customerProfileId);
    expect(unchanged.lines[0]?.quantity).toBe(10);
  });

  it('clears the cart', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const result = await clearCart(customerProfileId);
    expect(result.removed).toBe(1);
  });
});

describe('cart revalidation', () => {
  it('flags a product unpublished while it sits in the cart', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });

    const view = toCartView(await resolveCart(customerProfileId));
    expect(view.checkoutReady).toBe(false);
    expect(view.lines[0]?.issues[0]?.code).toBe('CART_ITEM_UNAVAILABLE');
  });

  it('flags insufficient stock without failing the whole read', async () => {
    await addItem(customerProfileId, { productId, quantity: 200 });

    const view = toCartView(await resolveCart(customerProfileId));
    expect(view.checkoutReady).toBe(false);
    expect(view.lines[0]?.issues[0]?.code).toBe('INSUFFICIENT_STOCK');
    // The line is still priced, so the customer can see and correct it.
    expect(view.lines[0]?.lineTotal.minor).not.toBe('0');
  });

  it('flags an invalid quantity increment', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const itemId = (await resolveCart(customerProfileId)).lines[0]?.itemId ?? '';
    await updateItemQuantity(customerProfileId, itemId, 13);

    const view = toCartView(await resolveCart(customerProfileId));
    expect(view.lines[0]?.issues[0]?.code).toBe('QUANTITY_INCREMENT_INVALID');
  });

  it('is checkout-ready when nothing is wrong', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const view = toCartView(await resolveCart(customerProfileId));

    expect(view.checkoutReady).toBe(true);
    expect(view.lines[0]?.issues).toHaveLength(0);
  });
});

describe('checkout', () => {
  it('creates an order with immutable snapshots and reserved stock', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const result = await checkout();

    expect(result.orderNumber).toMatch(/^UB-\d{4}-\d{6}$/);
    expect(result.status).toBe('PENDING_PAYMENT');
    // 910.00 + 163.80 tax + 99.00 shipping.
    expect(result.totals.grandTotal.formatted).toBe('1172.80');

    const items = await prisma.orderItem.findMany({ where: { orderId: result.orderId } });
    expect(items[0]?.nameSnapshot).toBe('Hex Bolt M12');
    expect(items[0]?.skuSnapshot).toBe('HEX-M12');
    expect(items[0]?.unitPriceMinor).toBe(4550n);

    const availability = await getAvailability({ productId });
    expect(availability.reservedQty).toBe(20);
    // Stock is held, not yet deducted - the customer has not paid.
    expect(availability.onHandQty).toBe(100);
  });

  it('converts the cart', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    await checkout();

    expect((await resolveCart(customerProfileId)).lines).toHaveLength(0);
  });

  it('refuses an empty cart', async () => {
    await expect(checkout()).rejects.toMatchObject({ code: 'CART_EMPTY' });
  });

  it('refuses when a line has an issue', async () => {
    await addItem(customerProfileId, { productId, quantity: 200 });
    await expect(checkout()).rejects.toMatchObject({ code: 'CART_ITEM_UNAVAILABLE' });
  });

  it('refuses another customer address', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });

    const foreign = await prisma.address.create({
      data: {
        id: newId(),
        customerProfileId: otherProfileId,
        contactName: 'Other',
        contactPhone: '+91 90000 00001',
        line1: 'Elsewhere',
        city: 'Mumbai',
        state: 'MH',
        postalCode: '400001',
        country: 'IN',
      },
    });

    await expect(checkout({ shippingAddressId: foreign.id })).rejects.toMatchObject({
      code: 'ADDRESS_REQUIRED',
    });
  });

  /** Nothing may commit if the stock cannot be held. */
  it('writes no order when the reservation fails', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });

    // Drain the stock between cart resolution and the reservation.
    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { onHandQty: 5 } });

    await expect(checkout()).rejects.toBeTruthy();

    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
    expect(await prisma.stockReservation.count()).toBe(0);
  });

  it('allocates sequential order numbers', async () => {
    await addItem(customerProfileId, { productId, quantity: 10 });
    const first = await checkout();
    await addItem(customerProfileId, { productId, quantity: 10 });
    const second = await checkout();

    expect(first.orderNumber).toMatch(/-000001$/);
    expect(second.orderNumber).toMatch(/-000002$/);
  });

  it('routes to approval when the account requires it', async () => {
    await prisma.customerProfile.update({
      where: { id: customerProfileId },
      data: { requiresOrderApproval: true },
    });

    await addItem(customerProfileId, { productId, quantity: 20 });
    const result = await checkout();

    // Reaching PENDING_PAYMENT would let it be paid before the decision.
    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.requiresApproval).toBe(true);
    expect(await prisma.orderApproval.count({ where: { status: 'PENDING' } })).toBe(1);
  });
});

describe('checkout idempotency', () => {
  const runCheckout = (key: string, body: Record<string, unknown>) =>
    runIdempotent({
      scope: IdempotencyScope.CHECKOUT_SUBMIT,
      key,
      ownerId: customerProfileId,
      body,
      operation: () => checkout(body),
    });

  it('replays the first response instead of creating a second order', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const body = { shippingAddressId: addressId, paymentMode: 'ONLINE' as const };

    const first = await runCheckout('key-1', body);
    const second = await runCheckout('key-1', body);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.value.orderNumber).toBe(first.value.orderNumber);
    // The decisive assertion.
    expect(await prisma.order.count()).toBe(1);
  });

  /**
   * The dangerous case. Replaying the old response would tell the caller their
   * NEW order succeeded when it was never placed.
   */
  it('rejects the same key with a different body', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });

    await runCheckout('key-1', { shippingAddressId: addressId, paymentMode: 'ONLINE' as const });

    await expect(
      runCheckout('key-1', { shippingAddressId: addressId, paymentMode: 'PAYMENT_LINK' as const }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY' });
  });

  it('does not let one customer replay another customer response', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const body = { shippingAddressId: addressId, paymentMode: 'ONLINE' as const };

    await runCheckout('shared-key', body);

    await expect(
      runIdempotent({
        scope: IdempotencyScope.CHECKOUT_SUBMIT,
        key: 'shared-key',
        ownerId: otherProfileId,
        body,
        operation: () => checkout(body),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY' });
  });

  /** A failed attempt must not lock the customer out of their own order. */
  it('releases the key when the operation fails', async () => {
    const body = { shippingAddressId: addressId, paymentMode: 'ONLINE' as const };

    // Empty cart: the operation throws.
    await expect(runCheckout('retry-key', body)).rejects.toMatchObject({ code: 'CART_EMPTY' });

    await addItem(customerProfileId, { productId, quantity: 20 });
    const retried = await runCheckout('retry-key', body);

    expect(retried.replayed).toBe(false);
    expect(retried.value.orderNumber).toBeTruthy();
  });

  it('survives two concurrent submissions of the same key', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const body = { shippingAddressId: addressId, paymentMode: 'ONLINE' as const };

    const results = await Promise.allSettled([
      runCheckout('race-key', body),
      runCheckout('race-key', body),
    ]);

    // One wins; the other either replays or is told the request is in flight.
    // Neither outcome may produce a second order.
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.order.count()).toBe(1);
  });
});

describe('order lifecycle', () => {
  async function placedOrder(): Promise<string> {
    await addItem(customerProfileId, { productId, quantity: 20 });
    return (await checkout()).orderId;
  }

  it('commits stock on confirmation', async () => {
    const orderId = await placedOrder();

    await transitionOrder({
      orderId,
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
    });

    const availability = await getAvailability({ productId });
    expect(availability.onHandQty).toBe(80);
    expect(availability.reservedQty).toBe(0);
  });

  /** A duplicate webhook must not deduct stock twice. */
  it('is idempotent on a duplicate confirmation', async () => {
    const orderId = await placedOrder();
    const systemActor = { userId: null, email: null, type: 'SYSTEM' as const };

    await transitionOrder({ orderId, to: 'CONFIRMED', actor: systemActor });
    await transitionOrder({ orderId, to: 'CONFIRMED', actor: systemActor }).catch(() => undefined);

    expect((await getAvailability({ productId })).onHandQty).toBe(80);
    expect(
      await prisma.inventoryMovement.count({ where: { type: 'RESERVATION_COMMIT' } }),
    ).toBe(1);
  });

  it('releases a reservation when an unpaid order is cancelled', async () => {
    const orderId = await placedOrder();

    await transitionOrder({
      orderId,
      to: 'CANCELLED',
      actor: { userId: adminActor.userId, email: adminActor.email, type: 'ADMIN' },
      reason: 'Customer changed their mind',
    });

    const availability = await getAvailability({ productId });
    expect(availability.reservedQty).toBe(0);
    expect(availability.availableQty).toBe(100);
  });

  it('restocks committed stock when a confirmed order is cancelled', async () => {
    const orderId = await placedOrder();
    await transitionOrder({
      orderId,
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
    });

    await transitionOrder({
      orderId,
      to: 'CANCELLED',
      actor: {
        userId: adminActor.userId,
        email: adminActor.email,
        type: 'ADMIN',
        permissions: ['order.cancel'],
      },
      reason: 'Out of stock at the warehouse',
    });

    expect((await getAvailability({ productId })).onHandQty).toBe(100);
  });

  it('appends every transition to the timeline', async () => {
    const orderId = await placedOrder();
    await transitionOrder({
      orderId,
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
    });

    const history = await prisma.orderStatusHistory.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });

    expect(history).toHaveLength(2);
    expect(history[0]?.toStatus).toBe('PENDING_PAYMENT');
    expect(history[1]?.fromStatus).toBe('PENDING_PAYMENT');
    expect(history[1]?.toStatus).toBe('CONFIRMED');
  });

  it('refuses an illegal transition', async () => {
    const orderId = await placedOrder();

    await expect(
      transitionOrder({
        orderId,
        to: 'DELIVERED',
        actor: { userId: adminActor.userId, email: adminActor.email, type: 'ADMIN' },
      }),
    ).rejects.toMatchObject({ code: 'ORDER_TRANSITION_NOT_ALLOWED' });
  });

  /** Only a verified provider event reaches CONFIRMED. */
  it('does not let an admin skip payment', async () => {
    const orderId = await placedOrder();

    await expect(
      transitionOrder({
        orderId,
        to: 'CONFIRMED',
        actor: {
          userId: adminActor.userId,
          email: adminActor.email,
          type: 'ADMIN',
          permissions: ['order.fulfil', 'order.approve', 'order.cancel'],
        },
      }),
    ).rejects.toMatchObject({ code: 'ORDER_TRANSITION_NOT_ALLOWED' });
  });

  it('requires a reason to cancel', async () => {
    const orderId = await placedOrder();

    await expect(
      transitionOrder({
        orderId,
        to: 'CANCELLED',
        actor: { userId: adminActor.userId, email: adminActor.email, type: 'ADMIN' },
      }),
    ).rejects.toMatchObject({ code: 'ORDER_TRANSITION_NOT_ALLOWED' });
  });
});

describe('order history immutability', () => {
  /**
   * SOP 5.3. The whole reason `order_items` carries snapshots rather than
   * joining the catalog.
   */
  it('does not rewrite a placed order when the product changes', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const order = await checkout();

    await prisma.product.update({
      where: { id: productId },
      data: { name: 'Renamed Bolt', sku: 'NEW-SKU', basePriceMinor: 99_999n },
    });

    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(item.nameSnapshot).toBe('Hex Bolt M12');
    expect(item.skuSnapshot).toBe('HEX-M12');
    expect(item.unitPriceMinor).toBe(4550n);

    const stored = await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } });
    expect(stored.grandTotalMinor).toBe(117_280n);
  });

  it('survives the product being archived', async () => {
    await addItem(customerProfileId, { productId, quantity: 20 });
    const order = await checkout();

    await prisma.product.update({
      where: { id: productId },
      data: { archivedAt: new Date(), isPublished: false },
    });

    // A hard delete would break this. Soft delete keeps history readable.
    const items = await prisma.orderItem.findMany({ where: { orderId: order.orderId } });
    expect(items).toHaveLength(1);
    expect(items[0]?.nameSnapshot).toBe('Hex Bolt M12');
  });
});
