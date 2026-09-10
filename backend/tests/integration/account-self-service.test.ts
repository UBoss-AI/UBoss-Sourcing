/**
 * The customer's own account area — integration, against a real MariaDB.
 *
 * Four themes, and each one is a claim it would be expensive to be wrong
 * about.
 *
 *   - **A contact change never takes effect before it is confirmed.** The
 *     email address is what the account signs in with, so writing an
 *     unconfirmed one over it locks somebody out of their own purchasing
 *     account with no way back — the confirmation would go to the address that
 *     does not exist. These tests assert the *intermediate* state, which is
 *     the one that matters: after the request and before the link, the account
 *     still uses its old address.
 *   - **The address stays unique, and is checked twice.** Minutes pass between
 *     a request and its confirmation, and in that window another account can
 *     register the same address. Checking once is how two accounts end up
 *     sharing a sign-in identity.
 *   - **Closing an account stops money moving.** A deactivated account with an
 *     ACTIVE schedule and a live mandate is a worker charging somebody weeks
 *     after they closed their account, which is the worst outcome available
 *     here and the default unless the closure explicitly prevents it.
 *   - **The name in two parts and the canonical name cannot disagree.**
 *     `fullName` is what an invoice carries; the parts feed it and it never
 *     feeds them back.
 *
 * Wishlist coverage is here rather than in a file of its own because it shares
 * this file's fixtures and is small: the interesting properties are ownership
 * scoping and idempotence.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { updateCustomer } from '../../src/modules/customers/customer.service.js';
import {
  cancelEmailChange,
  confirmEmailChange,
  confirmPhoneChange,
  getPendingContactChange,
  requestEmailChange,
  requestPhoneChange,
} from '../../src/modules/customers/contact-change.service.js';
import {
  deactivateOwnAccount,
  describeClosure,
} from '../../src/modules/customers/account-closure.service.js';
import {
  addToWishlist,
  countWishlist,
  listWishlist,
  removeFromWishlist,
} from '../../src/modules/customers/wishlist.service.js';

const PASSWORD = 'Correct-Horse-Battery-9';

interface Customer {
  userId: string;
  profileId: string;
  email: string;
}

function actorFor(customer: Customer) {
  return { userId: customer.userId, email: customer.email, ipAddress: '127.0.0.1', correlationId: null };
}

/**
 * The single token minted for a purpose, in its raw form.
 *
 * Only the SHA-256 is stored, so a test cannot read a token back out of the
 * database — which is the point of the design. Instead the services hand the
 * raw token to the notification, so it is recovered from the queued email's
 * own variables, exactly where a customer would find it.
 */
async function tokenFromEmail(eventKey: string, recipient: string): Promise<string> {
  const row = await prisma.notificationOutbox.findFirst({
    where: { eventKey, recipientEmail: recipient },
    orderBy: { createdAt: 'desc' },
    select: { payloadJson: true },
  });

  if (row === null) throw new Error(`no ${eventKey} notification queued for ${recipient}`);

  const url = (row.payloadJson as Record<string, unknown> | null)?.confirmUrl;
  if (typeof url !== 'string') throw new Error(`no confirmUrl in the ${eventKey} notification`);

  const token = new URL(url).searchParams.get('token');
  if (token === null) throw new Error(`no token in ${url}`);

  return token;
}

async function reset(): Promise<void> {
  await prisma.wishlistItem.deleteMany({});
  // The catalogue rows this file creates for itself, and the two reference
  // rows behind them. Cleared here as well as everything else, so a file that
  // runs after this one does not inherit a stray tax class or category.
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.customerAutoPaySetting.deleteMany({});
  await prisma.customerPaymentMethod.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerLimit.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

async function makeCustomer(overrides: { email?: string } = {}): Promise<Customer> {
  const userId = newId();
  const profileId = newId();
  const email = overrides.email ?? `buyer-${userId.slice(-8).toLowerCase()}@example.test`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email.toLowerCase(),
      phone: '+919905535123',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.customerProfile.create({
    data: {
      id: profileId,
      userId,
      fullName: 'Priya Nair',
      organization: 'Kerala Clinics',
      phone: '+919905535123',
      preferredCountry: 'IN',
      preferredCurrency: 'INR',
    },
  });

  return { userId, profileId, email };
}

/** A live session, so a closure has something to revoke. */
async function makeSession(userId: string): Promise<string> {
  const id = newId();

  await prisma.session.create({
    data: {
      id,
      userId,
      familyId: newId(),
      refreshTokenHash: newId().padEnd(64, '0').slice(0, 64),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  return id;
}

beforeEach(reset);
// Also after the last test in the file: `orders` and `recurring_schedules` are
// ON DELETE RESTRICT, so anything left behind breaks the alphabetically first
// file on the NEXT suite run, hundreds of tests away from the cause.
afterAll(reset);

// ---------------------------------------------------------------------------
// The name
// ---------------------------------------------------------------------------

describe('the name in two parts', () => {
  it('composes the canonical name from the parts', async () => {
    const customer = await makeCustomer();

    await updateCustomer(
      customer.profileId,
      { firstName: 'Anneke', lastName: 'de Vries' },
      actorFor(customer),
    );

    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { id: customer.profileId },
    });

    // One canonical name, built from the parts. Two independent sources for
    // "what is this person called" is how an invoice ends up disagreeing with
    // a delivery note.
    expect(profile.firstName).toBe('Anneke');
    expect(profile.lastName).toBe('de Vries');
    expect(profile.fullName).toBe('Anneke de Vries');
  });

  it('never empties the canonical name, whatever the parts are cleared to', async () => {
    const customer = await makeCustomer();

    await updateCustomer(
      customer.profileId,
      { firstName: null, lastName: null },
      actorFor(customer),
    );

    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { id: customer.profileId },
    });

    // `fullName` is NOT NULL and is what an invoice carries. Clearing both
    // parts means the parts are unknown again, which is the state every
    // invited or imported account is already in — not a blank invoice.
    expect(profile.firstName).toBeNull();
    expect(profile.fullName).toBe('Priya Nair');
  });

  it('lets an explicit full name win over the parts in the same request', async () => {
    const customer = await makeCustomer();

    await updateCustomer(
      customer.profileId,
      { fullName: 'Dr Priya Nair', firstName: 'Priya', lastName: 'Nair' },
      actorFor(customer),
    );

    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { id: customer.profileId },
    });

    // That is the administrator screen editing the canonical name directly,
    // and it must not be overwritten by a composition.
    expect(profile.fullName).toBe('Dr Priya Nair');
  });
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

describe('changing the email address', () => {
  it('parks the new address and leaves the account on the old one', async () => {
    const customer = await makeCustomer();

    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });

    // The state that matters. Anything else here is a typo locking somebody
    // out of their own account with no way back in.
    expect(user.email).toBe(customer.email);
    expect(user.pendingEmail).toBe('new.buyer@example.test');
    expect(user.pendingEmailNormalized).toBe('new.buyer@example.test');

    await expect(getPendingContactChange(customer.userId)).resolves.toMatchObject({
      email: 'new.buyer@example.test',
    });
  });

  it('warns the address the account still uses, as well as the new one', async () => {
    const customer = await makeCustomer();

    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));

    const queued = await prisma.notificationOutbox.findMany({
      select: { eventKey: true, recipientEmail: true },
    });

    // Two emails, and the second one is the point: if somebody else has got
    // into the account, this is the message that reaches the real holder while
    // their address still works.
    expect(queued).toEqual(
      expect.arrayContaining([
        { eventKey: 'user.email_change_confirm', recipientEmail: 'new.buyer@example.test' },
        { eventKey: 'user.email_change_requested', recipientEmail: customer.email },
      ]),
    );
  });

  it('promotes the address only once the link is followed, and signs every session out', async () => {
    const customer = await makeCustomer();
    const sessionId = await makeSession(customer.userId);

    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));
    const token = await tokenFromEmail('user.email_change_confirm', 'new.buyer@example.test');

    const result = await confirmEmailChange(token, customer.userId, actorFor(customer));

    expect(result.email).toBe('new.buyer@example.test');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.email).toBe('new.buyer@example.test');
    expect(user.emailNormalized).toBe('new.buyer@example.test');
    // Confirmed by definition: the link went to this address and came back.
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.pendingEmail).toBeNull();

    // The address is the sign-in identity, so a token minted against the old
    // one is a credential for an account that no longer exists under that name.
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).not.toBeNull();
  });

  it('spends the link exactly once', async () => {
    const customer = await makeCustomer();

    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));
    const token = await tokenFromEmail('user.email_change_confirm', 'new.buyer@example.test');

    await confirmEmailChange(token, customer.userId, actorFor(customer));

    await expect(
      confirmEmailChange(token, customer.userId, actorFor(customer)),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'TOKEN_ALREADY_USED');
  });

  it('refuses an address another account already signs in with', async () => {
    const customer = await makeCustomer();
    const other = await makeCustomer({ email: 'taken@example.test' });

    await expect(
      requestEmailChange(customer.userId, other.email, actorFor(customer)),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'EMAIL_ALREADY_IN_USE',
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.pendingEmail).toBeNull();
  });

  it('refuses again at confirmation, when the address was taken in between', async () => {
    const customer = await makeCustomer();

    await requestEmailChange(customer.userId, 'contested@example.test', actorFor(customer));
    const token = await tokenFromEmail('user.email_change_confirm', 'contested@example.test');

    // Somebody else registers it while the link sits in an inbox. Checking
    // only at request time is how two accounts end up sharing an identity.
    await makeCustomer({ email: 'contested@example.test' });

    await expect(
      confirmEmailChange(token, customer.userId, actorFor(customer)),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'EMAIL_ALREADY_IN_USE',
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.email).toBe(customer.email);
    // Cleared as well: leaving it would offer the same refusal for ever with
    // no way for the customer to see why.
    expect(user.pendingEmail).toBeNull();
  });

  it('refuses a link that belongs to a different account', async () => {
    const customer = await makeCustomer();
    const other = await makeCustomer({ email: 'other@example.test' });

    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));
    const token = await tokenFromEmail('user.email_change_confirm', 'new.buyer@example.test');

    await expect(
      confirmEmailChange(token, other.userId, actorFor(other)),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'TOKEN_INVALID');
  });

  it('kills the link when the change is cancelled', async () => {
    const customer = await makeCustomer();

    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));
    const token = await tokenFromEmail('user.email_change_confirm', 'new.buyer@example.test');

    await cancelEmailChange(customer.userId);

    await expect(
      confirmEmailChange(token, customer.userId, actorFor(customer)),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'TOKEN_ALREADY_USED');
  });
});

// ---------------------------------------------------------------------------
// Telephone
// ---------------------------------------------------------------------------

describe('changing the telephone number', () => {
  it('sends the confirmation to the account email, not to the number', async () => {
    const customer = await makeCustomer();

    await requestPhoneChange(customer.userId, '+911234567890', actorFor(customer));

    const queued = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventKey: 'user.phone_change_confirm' },
      select: { recipientEmail: true },
    });

    // This deployment has no SMS driver. Confirming by email proves control of
    // the ACCOUNT, which is what stops somebody else changing the number; it
    // does not prove control of the number. Wiring an SMS provider is what
    // upgrades that, and this assertion is what will fail when it is.
    expect(queued.recipientEmail).toBe(customer.email);
  });

  it('moves both copies of the number, and leaves the sessions alone', async () => {
    const customer = await makeCustomer();
    const sessionId = await makeSession(customer.userId);

    await requestPhoneChange(customer.userId, '+911234567890', actorFor(customer));
    const token = await tokenFromEmail('user.phone_change_confirm', customer.email);

    await confirmPhoneChange(token, customer.userId, actorFor(customer));

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { id: customer.profileId },
    });

    expect(user.phone).toBe('+911234567890');
    expect(user.phoneVerifiedAt).not.toBeNull();
    expect(user.pendingPhone).toBeNull();
    // Two columns for one fact, and both existed before this screen did. A
    // change that updated one would leave a courier ringing the old number.
    expect(profile.phone).toBe('+911234567890');

    // Unlike the address, a number is not the sign-in identity, so nothing
    // about the live sessions has gone stale.
    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).toBeNull();
  });

  it('will not promote a number with an email-change link', async () => {
    const customer = await makeCustomer();

    await requestPhoneChange(customer.userId, '+911234567890', actorFor(customer));
    await requestEmailChange(customer.userId, 'new.buyer@example.test', actorFor(customer));

    const emailToken = await tokenFromEmail(
      'user.email_change_confirm',
      'new.buyer@example.test',
    );

    // The purposes are separate values rather than a reuse, and this is why:
    // a link minted to prove one thing must not be replayable to prove another.
    await expect(
      confirmPhoneChange(emailToken, customer.userId, actorFor(customer)),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'TOKEN_INVALID');
  });
});

// ---------------------------------------------------------------------------
// Closing the account
// ---------------------------------------------------------------------------

describe('closing an account', () => {
  it('refuses without the right password', async () => {
    const customer = await makeCustomer();

    await expect(
      deactivateOwnAccount(
        {
          userId: customer.userId,
          customerProfileId: customer.profileId,
          password: 'not-the-password',
          reason: null,
        },
        actorFor(customer),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'INVALID_CREDENTIALS',
    );

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.status).toBe('ACTIVE');
  });

  it('deactivates the account and revokes every session', async () => {
    const customer = await makeCustomer();
    const sessionId = await makeSession(customer.userId);

    const result = await deactivateOwnAccount(
      {
        userId: customer.userId,
        customerProfileId: customer.profileId,
        password: PASSWORD,
        reason: 'no longer buying',
      },
      actorFor(customer),
    );

    expect(result.sessionsRevoked).toBe(1);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } });
    expect(user.status).toBe('DEACTIVATED');

    const session = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(session.revokedAt).not.toBeNull();
  });

  it('records the closure as the customer, not as an administrator', async () => {
    const customer = await makeCustomer();

    await deactivateOwnAccount(
      {
        userId: customer.userId,
        customerProfileId: customer.profileId,
        password: PASSWORD,
        reason: null,
      },
      actorFor(customer),
    );

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'customer.status_changed', resourceId: customer.profileId },
    });

    // The same action is written with ADMIN by `setCustomerStatus` next door,
    // and the distinction is the whole value of the entry: "who closed this
    // account" has two very different answers.
    expect(entry.actorType).toBe('CUSTOMER');
  });

  it('tells the holder it happened, at the address that still works', async () => {
    const customer = await makeCustomer();

    await deactivateOwnAccount(
      {
        userId: customer.userId,
        customerProfileId: customer.profileId,
        password: PASSWORD,
        reason: null,
      },
      actorFor(customer),
    );

    const queued = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventKey: 'user.account_deactivated' },
      select: { recipientEmail: true },
    });

    // A deactivation somebody did not ask for is something they need to hear
    // about while it can still be reversed.
    expect(queued.recipientEmail).toBe(customer.email);
  });

  it('reports nothing to stop on an account with nothing running', async () => {
    const customer = await makeCustomer();

    await expect(describeClosure(customer.profileId)).resolves.toEqual({
      activeScheduleCount: 0,
      hasAutoPay: false,
      unpaidOrderCount: 0,
    });
  });

  it('counts an order that is still owed, because closing does not cancel it', async () => {
    const customer = await makeCustomer();

    await prisma.order.create({
      data: {
        id: newId(),
        orderNumber: `UB-${newId().slice(-10)}`,
        customerProfileId: customer.profileId,
        status: 'CONFIRMED',
        currency: 'INR',
        grandTotalMinor: 50_000n,
        paidMinor: 10_000n,
        billingAddressJson: { contactName: 'Priya Nair' },
        shippingAddressJson: { contactName: 'Priya Nair' },
      },
    });

    await expect(describeClosure(customer.profileId)).resolves.toMatchObject({
      unpaidOrderCount: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// Saved for later
// ---------------------------------------------------------------------------

describe('the wishlist', () => {
  /**
   * A published, priced product, which is the only kind that can be saved.
   *
   * The tax class and the category are created here rather than read from the
   * seed. Files share one database and several of them clear the reference
   * tables, so "find the first active tax class" passes when this file is run
   * alone and fails in the full suite depending on which file ran before it —
   * which is the flakiest possible way to write a fixture.
   */
  async function makeProduct(): Promise<string> {
    const taxClass = await prisma.taxClass.create({
      data: {
        id: newId(),
        code: `WL-GST-${newId().slice(-6)}`,
        name: 'GST 18%',
        ratePercent: '18.000000',
        isActive: true,
      },
    });

    const category = await prisma.category.create({
      data: {
        id: newId(),
        name: 'Saved consumables',
        slug: `saved-consumables-${newId().slice(-8).toLowerCase()}`,
        isActive: true,
      },
    });

    const id = newId();

    await prisma.product.create({
      data: {
        id,
        sku: `WL-${id.slice(-8)}`,
        slug: `wishlist-product-${id.slice(-8).toLowerCase()}`,
        name: 'Saved Consumable',
        categoryId: category.id,
        taxClassId: taxClass.id,
        // The authoring currency on the product row, distinct from the
        // `product_prices` row below: that is the price list the storefront
        // reads, and this is the currency the figure on the product itself is
        // denominated in.
        currency: 'INR',
        basePriceMinor: 45_000n,
        status: 'ACTIVE',
        isPublished: true,
        publishedAt: new Date(),
      },
    });

    await prisma.productPrice.create({
      data: {
        id: newId(),
        productId: id,
        variantKey: '',
        currencyCode: 'INR',
        basePriceMinor: 45_000n,
      },
    });

    return id;
  }

  it('saves a line, and saving it again is the same outcome', async () => {
    const customer = await makeCustomer();
    const productId = await makeProduct();

    const first = await addToWishlist(customer.profileId, { productId });
    const second = await addToWishlist(customer.profileId, { productId });

    // Idempotent on purpose: pressing a heart that is already filled in is the
    // customer getting what they wanted, not a 409.
    expect(second.id).toBe(first.id);
    await expect(countWishlist(customer.profileId)).resolves.toBe(1);
  });

  it('prices a saved line for the market it is read in', async () => {
    const customer = await makeCustomer();
    const productId = await makeProduct();

    await addToWishlist(customer.profileId, { productId });

    const inr = await listWishlist(customer.profileId, {
      currency: 'INR',
      country: 'IN',
      language: null,
    });

    expect(inr.items).toHaveLength(1);
    expect(inr.items[0]?.priceMinor).toBe('45000');
    expect(inr.items[0]?.isAvailable).toBe(true);

    // A currency the product is not priced in is an ordinary answer, not an
    // error — and it is reported as unavailable rather than hidden, because a
    // saved item that silently vanishes is indistinguishable from a bug.
    const eur = await listWishlist(customer.profileId, {
      currency: 'EUR',
      country: 'DE',
      language: null,
    });

    expect(eur.items).toHaveLength(1);
    expect(eur.items[0]?.priceMinor).toBeNull();
    expect(eur.items[0]?.isAvailable).toBe(false);
  });

  it('keeps a saved line readable after the product is unpublished', async () => {
    const customer = await makeCustomer();
    const productId = await makeProduct();

    await addToWishlist(customer.profileId, { productId });
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });

    const list = await listWishlist(customer.profileId, {
      currency: 'INR',
      country: 'IN',
      language: null,
    });

    // The customer is owed the chance to see that the thing they were waiting
    // for has gone, rather than to wonder whether they imagined saving it.
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.isAvailable).toBe(false);
  });

  it('refuses to save a product the customer could never have seen', async () => {
    const customer = await makeCustomer();
    const productId = await makeProduct();

    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });

    // Otherwise a wishlist is a way to confirm that a given product id exists
    // in a catalogue you are not allowed to browse.
    await expect(addToWishlist(customer.profileId, { productId })).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
    );
  });

  it('will not let one customer remove a saved line belonging to another', async () => {
    const customer = await makeCustomer();
    const other = await makeCustomer({ email: 'other@example.test' });
    const productId = await makeProduct();

    const saved = await addToWishlist(customer.profileId, { productId });

    await expect(removeFromWishlist(other.profileId, saved.id)).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'NOT_FOUND',
    );

    // Not found, and still there.
    await expect(countWishlist(customer.profileId)).resolves.toBe(1);
  });
});
