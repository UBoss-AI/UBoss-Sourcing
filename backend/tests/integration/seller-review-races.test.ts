/**
 * Two people deciding one listing, and neither of them in the room.
 *
 * The Seller Hub's review flow is asynchronous by design: a seller submits and
 * signs out, a moderator opens the queue hours later. Everything good about
 * that arrangement comes from nobody having to wait, and everything dangerous
 * about it comes from the same place - between the moment a moderator reads a
 * listing and the moment they press Approve, anybody may have changed anything.
 *
 * THE RACE
 *
 * A moderator opens a submitted listing and goes to lunch. A colleague sends it
 * back for changes; the seller edits it and resubmits. The first moderator
 * returns and presses Approve.
 *
 * Nothing in the decision path noticed. The draft was read by id, the
 * transition PENDING_REVIEW -> APPROVED was legal, and whatever the row now
 * held was published. The moderator approved a revision they had never seen,
 * and the audit entry records their name against it.
 *
 * `version` alone cannot close this: it moves on every autosave, so a moderator
 * holding one holds a number that changes while the seller is still typing.
 * `submittedVersion` is the version AS SUBMITTED - stable for exactly as long
 * as the listing sits in the queue, and therefore changing precisely when, and
 * only when, the thing under review stops being the thing that was sent.
 *
 * WHAT ELSE IS PINNED HERE
 *
 *   - **A seller cannot edit what is being reviewed.** PENDING_REVIEW is not
 *     an editable status, so a resubmission is a new revision rather than a
 *     mutation of the one on the moderator's screen.
 *   - **A second decision is refused**, because two moderators opening one
 *     queue is normal rather than exceptional.
 *   - **Approval does not put anything on sale.** It makes the listing
 *     eligible; the seller decides when.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { saveDraft } from '../../src/modules/seller/listing-draft.service.js';
import { decideListing, readListingForReview } from '../../src/modules/seller/moderation.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

const ADMIN_EMAIL = 'review-race-admin@test.local';
const SELLER_SLUG = 'rr-acme';
const CATEGORY_SLUG = 'rr-test-category';

let adminUserId = '';
let sellerId = '';
let categoryId = '';
let membership: SellerMembership;

async function cleanUp(): Promise<void> {
  await prisma.sellerListingIssue.deleteMany({
    where: { draft: { sellerAccount: { slug: { startsWith: 'rr-' } } } },
  });
  await prisma.sellerInventoryMovement.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'rr-' } } },
  });
  await prisma.sellerInventory.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'rr-' } } },
  });
  await prisma.sellerOffer.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'rr-' } } },
  });
  await prisma.sellerListingDraft.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'rr-' } } },
  });
  await prisma.sellerNotification.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'rr-' } } },
  });
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'rr-' } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'rr-' } } });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY_SLUG } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

/**
 * A listing sitting in the queue, with its submitted revision recorded.
 *
 * Written directly rather than pushed through `submitDraft`, because what is
 * under test is what happens to a queued listing rather than how it got there -
 * and `submitDraft` insists on a complete listing, which would make every case
 * here about the completeness checks instead.
 */
async function makeQueuedDraft(): Promise<string> {
  const id = newId();

  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: sellerId,
      status: 'PENDING_REVIEW',
      categoryId,
      sellerSku: `RR-${id.slice(-8)}`,
      attributesJson: {},
      offerJson: { priceMinor: '1000', currency: 'INR', minimumOrderQuantity: 1 },
      stockJson: [],
      packagingJson: {},
      generatedTitle: 'A listing under review',
      submittedAt: new Date(),
      version: 3,
      submittedVersion: 3,
    },
  });

  return id;
}

beforeAll(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: ADMIN_EMAIL,
      emailNormalized: ADMIN_EMAIL,
      passwordHash: 'x',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  adminUserId = admin.id;

  /*
   * A tax class, only if the deployment has none.
   *
   * `publishApprovedListing` puts one on the product it creates, and a
   * neighbouring file in this suite wipes the table - so running alone this is
   * a no-op and running second it is the difference between a passing file and
   * a foreign-key violation. Not removed in cleanup, for the same reason: it is
   * shared furniture, not this file's.
   */
  const existingTaxClass = await prisma.taxClass.findFirst({ select: { id: true } });
  if (existingTaxClass === null) {
    await prisma.taxClass.create({
      data: {
        id: newId(),
        code: 'RR18',
        name: 'GST 18%',
        ratePercent: '18.000000',
        isActive: true,
      },
    });
  }

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Review races', slug: CATEGORY_SLUG, isActive: true },
  });
  categoryId = category.id;

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: 'RR Acme Ltd',
      displayName: 'RR Acme',
      displayNameNormalized: 'rr acme',
      slug: SELLER_SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  membership = {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'RR Acme',
    legalName: 'RR Acme Ltd',
    slug: SELLER_SLUG,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
});

afterAll(async () => {
  await cleanUp();
});

describe('the revision a moderator is deciding on', () => {
  it('tells the review screen which revision it is reading', async () => {
    const draftId = await makeQueuedDraft();

    const view = await readListingForReview(draftId);

    // Not `version`, which is the autosave counter. This is the one that
    // travels back with the decision.
    expect(view.submittedVersion).toBe(3);
  });

  it('approves the revision that was actually submitted', async () => {
    const draftId = await makeQueuedDraft();

    await decideListing({ draftId, to: 'APPROVED', adminUserId, expectedVersion: 3 });

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft.status).toBe('APPROVED');
  });

  it('refuses an approval of a revision the seller has since replaced', async () => {
    const draftId = await makeQueuedDraft();

    /*
     * The colleague, the seller, and the resubmission - compressed into the
     * one state change that matters. The listing is now in the queue at
     * revision 4; the moderator on the other screen is still holding 3.
     */
    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: { version: 4, submittedVersion: 4 },
    });

    await expect(
      decideListing({ draftId, to: 'APPROVED', adminUserId, expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: ErrorCode.SELLER_STALE_VERSION });

    // And nothing happened. Not "it was approved and then complained about" -
    // the whole decision is inside one transaction, so a refused approval
    // leaves no offer, no notification and no status change behind it.
    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft.status).toBe('PENDING_REVIEW');
    expect(await prisma.sellerOffer.count({ where: { sourceDraftId: draftId } })).toBe(0);
  });

  it('refuses the second of two administrators deciding at once', async () => {
    const draftId = await makeQueuedDraft();

    // Both read the same queue and both press a button. The first wins.
    await decideListing({
      draftId,
      to: 'REJECTED',
      comment: 'The photographs are of a different product.',
      adminUserId,
      expectedVersion: 3,
    });

    await expect(
      decideListing({ draftId, to: 'APPROVED', adminUserId, expectedVersion: 3 }),
    ).rejects.toMatchObject({ code: ErrorCode.SELLER_STALE_VERSION });

    // A rejection that quietly became an approval is the outcome this refuses.
    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft.status).toBe('REJECTED');
  });

  it('refuses a seller editing the version that is being reviewed', async () => {
    const draftId = await makeQueuedDraft();

    await expect(
      saveDraft({
        membership,
        draftId,
        patch: { offer: { priceMinor: '1' } },
      }),
    ).rejects.toMatchObject({ code: ErrorCode.LISTING_TRANSITION_NOT_ALLOWED });

    // The moderator is still looking at what was sent.
    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect((draft.offerJson as { priceMinor?: string }).priceMinor).toBe('1000');
  });
});

describe('what an approval does and does not do', () => {
  it('makes the listing eligible to sell, and does not put it on sale', async () => {
    const draftId = await makeQueuedDraft();

    const { offerId } = await decideListing({
      draftId,
      to: 'APPROVED',
      adminUserId,
      expectedVersion: 3,
    });

    expect(offerId).not.toBeNull();

    const offer = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: offerId as string },
    });

    /*
     * INACTIVE. The seller decides when it goes in front of buyers.
     *
     * A listing approved at 2am with no stock allocated would otherwise go
     * straight onto the shelf, and the seller would find out from an order.
     */
    expect(offer.status).toBe('INACTIVE');

    // And it is sold by the PIECE, stated rather than inherited from a column
    // default that a later migration could move.
    expect(offer.orderingUnit).toBe('PIECE');
  });

  it('tells the seller, in a notice waiting for them when they next sign in', async () => {
    const draftId = await makeQueuedDraft();

    await decideListing({ draftId, to: 'APPROVED', adminUserId, expectedVersion: 3 });

    // The seller was not online. An email may never be opened and a screen may
    // never be visited; this is the one that is still there tomorrow.
    const notice = await prisma.sellerNotification.findFirst({
      where: { sellerAccountId: sellerId, subjectId: draftId, kind: 'LISTING_DECISION' },
    });

    expect(notice).not.toBeNull();
    expect(notice?.severity).toBe('SUCCESS');
  });

  it('carries the opening stock onto the offer, so it is not born out of stock', async () => {
    const draftId = await makeQueuedDraft();

    const location = await prisma.sellerLocation.create({
      data: {
        id: newId(),
        sellerAccountId: sellerId,
        code: 'RR-MAIN',
        name: 'Main',
        addressLine1: '1 Test Road',
        city: 'Test',
        countryCode: 'IN',
        postcode: '000000',
      },
    });

    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: { stockJson: [{ locationId: location.id, availableQuantity: 25 }] },
    });

    const { offerId } = await decideListing({
      draftId,
      to: 'APPROVED',
      adminUserId,
      expectedVersion: 3,
    });

    const offer = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: offerId as string },
    });

    /*
     * The denormalised total the buyer's page and the seller's listings table
     * both read - nothing walks the locations at read time.
     *
     * It was left at zero: the location rows were created and never rolled up,
     * so every newly approved listing went live saying out of stock with stock
     * sitting in the ledger underneath it.
     */
    expect(offer.availableQuantity).toBe(25);
  });
});
