/**
 * The console bell - integration, against a real MariaDB.
 *
 * The claims under test:
 *   - A completed checkout leaves exactly one notification, carrying the
 *     buyer, the product and the order it came from.
 *   - It commits with the order and not before it: a checkout that fails
 *     leaves no notification claiming somebody bought something.
 *   - The permission on the row is enforced on read. A member of staff who
 *     cannot read orders cannot read about them through the bell either.
 *   - Read state is per person. Several people share one console and clearing
 *     one badge must not clear the others.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Permission } from '../../src/domain/permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
  listAdminNotifications,
  markAdminNotificationsRead,
  markAllAdminNotificationsRead,
  type NotificationViewer,
} from '../../src/modules/notifications/admin-notification.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';

let adminActor: { userId: string; email: string };
let ordersViewer: NotificationViewer;
let secondOrdersViewer: NotificationViewer;
let catalogViewer: NotificationViewer;
let customerProfileId: string;
let customerUserId: string;
let productId: string;
let addressId: string;

async function resetAll(): Promise<void> {
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({});
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

async function makeAdmin(email: string): Promise<string> {
  const id = newId();
  await prisma.user.create({
    data: { id, type: 'ADMIN', email, emailNormalized: email, status: 'ACTIVE' },
  });
  return id;
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

  const adminId = await makeAdmin('admin@bell.test');
  adminActor = { userId: adminId, email: 'admin@bell.test' };
  ordersViewer = { userId: adminId, permissions: [Permission.ORDER_READ] };

  secondOrdersViewer = {
    userId: await makeAdmin('second@bell.test'),
    permissions: [Permission.ORDER_READ],
  };

  // Everything except the grant the order notification carries.
  catalogViewer = {
    userId: await makeAdmin('catalog@bell.test'),
    permissions: [Permission.PRODUCT_READ, Permission.CATEGORY_READ],
  };

  const buyerUserId = newId();
  await prisma.user.create({
    data: {
      id: buyerUserId,
      type: 'CUSTOMER',
      email: 'buyer@bell.test',
      emailNormalized: 'buyer@bell.test',
      status: 'ACTIVE',
    },
  });
  customerUserId = buyerUserId;

  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: buyerUserId,
      fullName: 'Asha Menon',
      organization: 'Menon Clinic',
    },
  });
  customerProfileId = profile.id;

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Asha Menon',
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
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile Gloves M',
      slug: 'nitrile-gloves-m',
      sku: 'GLV-M',
      basePriceMinor: 45_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
    },
  });
  productId = product.id;

  await receiveStock({ productId, quantity: 100 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

async function checkout(): Promise<{ orderId: string; orderNumber: string }> {
  const result = await submitCheckout({
    customerProfileId,
    shippingAddressId: addressId,
    paymentMode: 'ONLINE',
    actor: { userId: customerUserId, email: 'buyer@bell.test', type: 'CUSTOMER' },
  });
  return { orderId: result.orderId, orderNumber: result.orderNumber };
}

describe('a customer buying something', () => {
  it('leaves one notification naming the buyer, the product and the order', async () => {
    await addItem(customerProfileId, { productId, quantity: 2 });
    const order = await checkout();

    const feed = await listAdminNotifications(ordersViewer);

    expect(feed.items).toHaveLength(1);
    expect(feed.unreadCount).toBe(1);

    const [notification] = feed.items;
    expect(notification?.kind).toBe(AdminNotificationKind.ORDER_PLACED);
    expect(notification?.isRead).toBe(false);
    expect(notification?.linkPath).toBe(`/orders/${order.orderId}`);

    // The organization is carried alongside the name: two people called Asha
    // is an ordinary case, two clinics of the same name is not.
    expect(notification?.variables['customerName']).toBe('Asha Menon (Menon Clinic)');
    expect(notification?.variables['itemName']).toBe('Nitrile Gloves M');
    expect(notification?.variables['orderNumber']).toBe(order.orderNumber);
    expect(notification?.variables['orderTotal']).toBe('1062.00');
  });

  /**
   * No English sentence is stored. If one ever is, a Polish console goes
   * permanently half-translated and nothing fails - which is why this is
   * asserted rather than left to the code review.
   */
  it('stores ingredients, not prose', async () => {
    await addItem(customerProfileId, { productId, quantity: 1 });
    await checkout();

    const row = await prisma.adminNotification.findFirstOrThrow();
    const columns = Object.keys(row);

    expect(columns).not.toContain('title');
    expect(columns).not.toContain('body');
    expect(row.requiredPermission).toBe(Permission.ORDER_READ);
  });

  /**
   * The bell commits with the order. A checkout that cannot be honoured must
   * not leave the panel claiming somebody bought something.
   */
  it('writes nothing when the checkout fails', async () => {
    await addItem(customerProfileId, { productId, quantity: 2 });

    // Stock disappears between the cart being filled and the checkout landing.
    await prisma.inventoryBalance.updateMany({ data: { onHandQty: 0 } });

    await expect(checkout()).rejects.toThrow();

    expect(await prisma.adminNotification.count()).toBe(0);
  });

  it('rings once for a repeated dedupe key', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createAdminNotification({
        kind: AdminNotificationKind.ORDER_PLACED,
        variables: { customerName: 'Asha Menon' },
        requiredPermission: Permission.ORDER_READ,
        dedupeKey: 'order_placed:retried',
      });
    }

    expect(await prisma.adminNotification.count()).toBe(1);
  });
});

describe('who sees what', () => {
  it('hides an order notification from staff who cannot read orders', async () => {
    await addItem(customerProfileId, { productId, quantity: 1 });
    await checkout();

    const feed = await listAdminNotifications(catalogViewer);

    expect(feed.items).toEqual([]);
    expect(feed.unreadCount).toBe(0);
  });

  it('shows an unpermissioned notification to everyone', async () => {
    await createAdminNotification({
      kind: 'system.announcement',
      variables: { message: 'Anyone may read this.' },
    });

    expect((await listAdminNotifications(catalogViewer)).items).toHaveLength(1);
    expect((await listAdminNotifications(ordersViewer)).items).toHaveLength(1);
  });

  it('refuses to mark read an id the caller cannot see', async () => {
    await addItem(customerProfileId, { productId, quantity: 1 });
    await checkout();

    const hidden = await prisma.adminNotification.findFirstOrThrow();

    expect(await markAdminNotificationsRead(catalogViewer, [hidden.id])).toBe(0);
    expect((await listAdminNotifications(ordersViewer)).unreadCount).toBe(1);
  });
});

describe('read state', () => {
  beforeEach(async () => {
    await addItem(customerProfileId, { productId, quantity: 1 });
    await checkout();
  });

  it('belongs to one member of staff, not to the row', async () => {
    const [notification] = (await listAdminNotifications(ordersViewer)).items;
    expect(notification).toBeDefined();

    await markAdminNotificationsRead(ordersViewer, [notification?.id ?? '']);

    const mine = await listAdminNotifications(ordersViewer);
    const theirs = await listAdminNotifications(secondOrdersViewer);

    expect(mine.unreadCount).toBe(0);
    expect(mine.items[0]?.isRead).toBe(true);

    // The colleague's badge is untouched.
    expect(theirs.unreadCount).toBe(1);
    expect(theirs.items[0]?.isRead).toBe(false);
  });

  it('is idempotent - marking the same row twice is not an error', async () => {
    const [notification] = (await listAdminNotifications(ordersViewer)).items;
    const id = notification?.id ?? '';

    expect(await markAdminNotificationsRead(ordersViewer, [id])).toBe(1);
    expect(await markAdminNotificationsRead(ordersViewer, [id])).toBe(0);
    expect((await listAdminNotifications(ordersViewer)).unreadCount).toBe(0);
  });

  it('clears the whole visible feed at once, and only the visible part', async () => {
    await createAdminNotification({ kind: 'system.announcement', variables: {} });

    expect(await markAllAdminNotificationsRead(ordersViewer)).toBe(2);
    expect((await listAdminNotifications(ordersViewer)).unreadCount).toBe(0);

    // The catalogue reader never saw the order one, so only the announcement
    // was theirs to clear.
    expect(await markAllAdminNotificationsRead(catalogViewer)).toBe(1);
  });
});
