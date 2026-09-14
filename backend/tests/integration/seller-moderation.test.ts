/**
 * The operator deciding things about a seller.
 *
 * Three decisions — on an application, on a brand, on a listing — and they all
 * share the property that makes them worth testing: each one changes what a
 * business is allowed to sell, and each one has to reach the seller in words
 * they can act on. A decision that is recorded correctly and never surfaces is
 * a listing that quietly stops working, which is the failure the whole Seller
 * Hub is arranged to avoid.
 *
 * What each case is really checking:
 *
 *   - **The state actually moved**, and the guard refused where it should.
 *   - **The seller was told**, in the in-app feed, with the reason attached.
 *   - **The seller-visible reason and the operator's private note stay apart.**
 *   - **A field comment lands on the field**, not in a paragraph — that is the
 *     difference between a review a seller can act on and one they cannot.
 *   - **A second decision on the same thing is refused**, because two
 *     moderators opening the same queue is normal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { readDraft } from '../../src/modules/seller/listing-draft.service.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  decideApplication,
  decideBrandRequest,
  decideListing,
} from '../../src/modules/seller/moderation.service.js';

const ADMIN_EMAIL = 'moderation-admin@test.local';

let adminUserId = '';
let sellerId = '';
let otherSellerId = '';
let categoryId = '';
let membership: SellerMembership;

async function cleanUp(): Promise<void> {
  await prisma.sellerListingIssue.deleteMany({});
  await prisma.sellerListingDraft.deleteMany({});
  await prisma.brandRequest.deleteMany({});
  await prisma.brand.deleteMany({});
  await prisma.sellerNotification.deleteMany({});
  await prisma.sellerAuditLog.deleteMany({});
  // By prefix rather than by an exact list: the application cases make sellers
  // of their own and delete them inline, and a case that fails before its
  // delete would otherwise leave one behind to break the next run.
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'mod-' } } });
  await prisma.category.deleteMany({ where: { slug: 'mod-test-category' } });
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
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
      status: 'APPROVED',
    },
  });

  return id;
}

/** A brand nobody has decided yet, and one seller's request for it. */
async function makeBrandRequest(
  name: string,
  forSellerId: string,
): Promise<{ brandId: string; requestId: string }> {
  const brandId = newId();
  const requestId = newId();
  const normalised = name.toLowerCase().replace(/[^a-z0-9]+/g, '');

  await prisma.brand.create({
    data: {
      id: brandId,
      name,
      nameNormalized: normalised,
      slug: normalised,
      status: 'PENDING',
    },
  });

  await prisma.brandRequest.create({
    data: {
      id: requestId,
      sellerAccountId: forSellerId,
      brandId,
      requestedName: name,
      status: 'PENDING',
    },
  });

  return { brandId, requestId };
}

async function makeDraft(status: 'PENDING_REVIEW' | 'DRAFT'): Promise<string> {
  const id = newId();

  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: sellerId,
      status,
      categoryId,
      attributesJson: {},
      offerJson: {},
      stockJson: [],
      packagingJson: {},
      submittedAt: status === 'PENDING_REVIEW' ? new Date() : null,
    },
  });

  return id;
}

beforeAll(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      email: ADMIN_EMAIL,
      emailNormalized: ADMIN_EMAIL,
      passwordHash: 'x',
      type: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  adminUserId = admin.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Moderation', slug: 'mod-test-category', isActive: true },
  });
  categoryId = category.id;

  sellerId = await makeSeller('mod-acme', 'Acme Supplies');

  // Built by hand: what is under test is the service, not the login path.
  membership = {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Acme Supplies',
    legalName: 'Acme Supplies Ltd',
    slug: 'mod-acme',
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
  };
  otherSellerId = await makeSeller('mod-rival', 'Rival Supplies');
});

afterAll(async () => {
  await cleanUp();
});

describe('decideBrandRequest', () => {
  it('approves the brand and tells the seller it is ready', async () => {
    const { brandId, requestId } = await makeBrandRequest('Approvable', sellerId);

    await decideBrandRequest({ requestId, decision: 'APPROVED', adminUserId });

    const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
    expect(brand.status).toBe('APPROVED');

    const request = await prisma.brandRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.status).toBe('APPROVED');
    expect(request.decidedByUserId).toBe(adminUserId);
    expect(request.decidedAt).not.toBeNull();

    const notice = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: sellerId, subjectId: requestId },
    });
    expect(notice.kind).toBe('BRAND_REQUEST_DECISION');
    expect(notice.severity).toBe('SUCCESS');
    // The link is what makes the notice actionable rather than an announcement.
    expect(notice.linkPath).toBe('/seller/brands');
  });

  it('approves under a corrected spelling and keeps what was asked for', async () => {
    const { brandId, requestId } = await makeBrandRequest('Brawn', sellerId);

    await decideBrandRequest({
      requestId,
      decision: 'APPROVED',
      correctedName: 'B. Braun',
      adminUserId,
    });

    const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
    expect(brand.name).toBe('B. Braun');
    // Normalised alongside, or the duplicate check would miss the next seller
    // asking for "b braun".
    expect(brand.nameNormalized).toBe('bbraun');

    // What the seller typed survives. "We approved 'B. Braun' when they asked
    // for 'Brawn'" is a thing somebody needs to be able to see later.
    const request = await prisma.brandRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(request.requestedName).toBe('Brawn');
  });

  it('retires the brand on a refusal when nobody else is waiting for it', async () => {
    const { brandId, requestId } = await makeBrandRequest('Refusable', sellerId);

    await decideBrandRequest({
      requestId,
      decision: 'REJECTED',
      reason: 'This is a product range, not a brand.',
      adminUserId,
    });

    const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
    expect(brand.status).toBe('REJECTED');
    expect(brand.rejectedReason).toBe('This is a product range, not a brand.');

    const notice = await prisma.sellerNotification.findFirstOrThrow({
      where: { subjectId: requestId },
    });
    // The reason IS the notice. A refusal with nothing beside it is a dead end.
    expect(notice.body).toBe('This is a product range, not a brand.');
    expect(notice.severity).toBe('WARNING');
  });

  it('leaves the brand alone when another seller is still waiting on it', async () => {
    const { brandId, requestId } = await makeBrandRequest('Shared', sellerId);

    // A second seller attaches to the SAME brand row, which is the whole point
    // of brands being marketplace-wide.
    await prisma.brandRequest.create({
      data: {
        id: newId(),
        sellerAccountId: otherSellerId,
        brandId,
        requestedName: 'Shared',
        status: 'PENDING',
      },
    });

    await decideBrandRequest({
      requestId,
      decision: 'REJECTED',
      reason: 'You have not shown you may sell it.',
      adminUserId,
    });

    // Refusing one seller must not retire the name out from under the other,
    // whose request has not been decided.
    const brand = await prisma.brand.findUniqueOrThrow({ where: { id: brandId } });
    expect(brand.status).toBe('PENDING');
  });

  it('refuses a second decision on the same request', async () => {
    const { requestId } = await makeBrandRequest('Twice', sellerId);

    await decideBrandRequest({ requestId, decision: 'APPROVED', adminUserId });

    // Two moderators opening the same queue is normal, and the second must be
    // told rather than silently overwriting the first.
    await expect(
      decideBrandRequest({ requestId, decision: 'REJECTED', reason: 'no', adminUserId }),
    ).rejects.toThrow(/already been decided/i);
  });
});

describe('decideListing', () => {
  it('sends a listing back with the comment on the seller record', async () => {
    const draftId = await makeDraft('PENDING_REVIEW');

    await decideListing({
      draftId,
      to: 'ACTION_REQUIRED',
      comment: 'Two things need fixing before this can go on sale.',
      adminUserId,
    });

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(draft.status).toBe('ACTION_REQUIRED');
    expect(draft.reviewComment).toBe('Two things need fixing before this can go on sale.');
    expect(draft.reviewedByUserId).toBe(adminUserId);
  });

  it('attaches a field comment to the field it belongs to', async () => {
    const draftId = await makeDraft('PENDING_REVIEW');

    await decideListing({
      draftId,
      to: 'ACTION_REQUIRED',
      comment: 'See the notes on the fields.',
      fieldComments: [
        {
          section: 'ADDITIONAL_INFORMATION',
          attributeKey: 'country_of_origin',
          message: 'Required for anything sold into the EU.',
        },
      ],
      adminUserId,
    });

    const issue = await prisma.sellerListingIssue.findFirstOrThrow({
      where: { draftId, code: 'MODERATOR_COMMENT' },
    });

    // The section and the key are the whole point: they put the sentence beside
    // the input in the seller's own wizard rather than in a paragraph at the
    // top that names no field.
    expect(issue.section).toBe('ADDITIONAL_INFORMATION');
    expect(issue.attributeKey).toBe('country_of_origin');
    // Marked as ours, so the seller's next save does not clear it - see
    // `refreshDraftState`, which only deletes issues it raised itself.
    expect(issue.isFromModerator).toBe(true);
  });

  it('refuses to send a listing back with no comment', async () => {
    const draftId = await makeDraft('PENDING_REVIEW');

    // The state machine's own rule, not the screen's. A seller told "changes
    // needed" and nothing else has been sent to guess.
    await expect(
      decideListing({ draftId, to: 'ACTION_REQUIRED', comment: null, adminUserId }),
    ).rejects.toThrow(/comment the seller can act on/i);
  });

  it('refuses to decide a listing that was never submitted', async () => {
    const draftId = await makeDraft('DRAFT');

    await expect(
      decideListing({ draftId, to: 'ACTION_REQUIRED', comment: 'no', adminUserId }),
    ).rejects.toThrow(/cannot move from DRAFT to ACTION_REQUIRED/i);
  });

  it('tells the seller a listing was sent back', async () => {
    const draftId = await makeDraft('PENDING_REVIEW');

    await decideListing({
      draftId,
      to: 'ACTION_REQUIRED',
      comment: 'The packaging photograph is a screenshot.',
      adminUserId,
    });

    const notice = await prisma.sellerNotification.findFirstOrThrow({
      where: { subjectId: draftId, kind: 'LISTING_DECISION' },
    });

    expect(notice.body).toBe('The packaging photograph is a screenshot.');
    expect(notice.linkPath).toBe('/seller/listings');
  });
});

describe('decideApplication', () => {
  it('approves a seller and tells them they can start', async () => {
    const applicantId = await makeSeller('mod-applicant', 'Applicant');

    await prisma.sellerAccount.update({
      where: { id: applicantId },
      data: { status: 'UNDER_REVIEW' },
    });

    await decideApplication({ sellerAccountId: applicantId, to: 'APPROVED', adminUserId });

    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: applicantId } });
    expect(account.status).toBe('APPROVED');

    const notice = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: applicantId, kind: 'APPLICATION_STATUS' },
    });
    expect(notice.title).toBe('You can start selling');
    expect(notice.severity).toBe('SUCCESS');

    await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: applicantId } });
    await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: applicantId } });
    await prisma.sellerAccount.delete({ where: { id: applicantId } });
  });

  it('keeps the private note off the seller-visible reason', async () => {
    const applicantId = await makeSeller('mod-noted', 'Noted');

    await prisma.sellerAccount.update({
      where: { id: applicantId },
      data: { status: 'UNDER_REVIEW' },
    });

    await decideApplication({
      sellerAccountId: applicantId,
      to: 'ACTION_REQUIRED',
      reason: 'The registration document names a different company.',
      internalNote: 'Third attempt. Escalate if it happens again.',
      adminUserId,
    });

    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: applicantId } });

    // Two columns, and only the first is ever serialised to a seller route. An
    // operator's private assessment reaching a seller's screen is a
    // one-directional, silent failure.
    expect(account.statusReason).toBe('The registration document names a different company.');
    expect(account.internalNotes).toContain('Escalate if it happens again.');

    const notice = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: applicantId, kind: 'APPLICATION_STATUS' },
    });
    expect(notice.body).toBe('The registration document names a different company.');
    expect(notice.body).not.toContain('Escalate');

    await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: applicantId } });
    await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: applicantId } });
    await prisma.sellerAccount.delete({ where: { id: applicantId } });
  });
});

describe('what the seller is shown afterwards', () => {
  it("puts a moderator's field comment back into the seller's own wizard", async () => {
    const draftId = await makeDraft('PENDING_REVIEW');

    await decideListing({
      draftId,
      to: 'ACTION_REQUIRED',
      comment: 'See the note on the field.',
      fieldComments: [
        {
          section: 'MEDICAL_COMPLIANCE',
          attributeKey: 'ce_marking',
          message: 'You have given a device class, so this needs a CE marking answer too.',
        },
      ],
      adminUserId,
    });

    const view = await readDraft(membership, draftId);

    /*
     * The whole point of a per-field comment.
     *
     * `evaluateDraft` recomputes issues from the schema on every read, so it can
     * only ever produce what the machine works out. A moderator's sentence lives
     * on `SellerListingIssue` and has to be merged back in, or it is written,
     * stored, and never seen by the one person it was written for.
     */
    const note = view.issues.find((issue) => issue.code === 'MODERATOR_COMMENT');

    expect(note).toBeDefined();
    expect(note?.section).toBe('MEDICAL_COMPLIANCE');
    expect(note?.attributeKey).toBe('ce_marking');
    expect(note?.message).toContain('CE marking answer');
  });
});
