/**
 * Listing moderation tools (JOURNEY-062).
 *
 *   - A prohibited term found in a submitted listing becomes an automated flag
 *     the moderator reads; it never refuses the listing on its own.
 *   - ACTION_REQUIRED carries a structured evidence request the seller reads.
 *   - A refused listing can be appealed; the moderator who refused it cannot
 *     decide the appeal; upheld sends it back to the review queue.
 *   - Approval can block the product in named countries, as PRODUCT-scope
 *     country rules with a history row each.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { readDraft } from '../../src/modules/seller/listing-draft.service.js';
import {
  appealListing,
  decideListingAppeal,
  flagProhibitedTerms,
  saveProhibitedTerm,
} from '../../src/modules/seller/listing-moderation.service.js';
import { decideListing, listReviewQueue, readListingForReview } from '../../src/modules/seller/moderation.service.js';

const MODERATOR = 'lm-moderator@test.local';
const SECOND = 'lm-second@test.local';
const SELLER_SLUG = 'lm-acme';
const CATEGORY_SLUG = 'lm-test-category';
const TERM = 'lmcuresall';

let moderatorId = '';
let secondId = '';
let sellerId = '';
let categoryId = '';
let membership: SellerMembership;

async function cleanUp(): Promise<void> {
  const products = await prisma.product.findMany({ where: { category: { slug: CATEGORY_SLUG } }, select: { id: true } });
  const productIds = products.map((row) => row.id);
  const rules = await prisma.marketRule.findMany({ where: { productId: { in: productIds } }, select: { id: true } });
  await prisma.marketRuleVersion.deleteMany({ where: { ruleId: { in: rules.map((row) => row.id) } } });
  await prisma.marketRule.deleteMany({ where: { productId: { in: productIds } } });
  await prisma.listingProhibitedTerm.deleteMany({ where: { term: TERM } });
  await prisma.sellerListingIssue.deleteMany({ where: { draft: { sellerAccount: { slug: { startsWith: 'lm-' } } } } });
  await prisma.sellerInventoryMovement.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'lm-' } } } });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'lm-' } } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'lm-' } } } });
  await prisma.sellerListingDraft.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'lm-' } } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'lm-' } } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'lm-' } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'lm-' } } });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
  const staff = await prisma.user.findMany({ where: { emailNormalized: { in: [MODERATOR, SECOND] } }, select: { id: true } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: staff.map((row) => row.id) } } });
  await prisma.user.deleteMany({ where: { id: { in: staff.map((row) => row.id) } } });
}

async function makeDraft(status: 'PENDING_REVIEW' | 'REJECTED', title = 'A listing under review'): Promise<string> {
  const id = newId();
  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: sellerId,
      status,
      categoryId,
      sellerSku: `LM-${id.slice(-8)}`,
      attributesJson: { description: `Our gel ${TERM} for everyone.` },
      offerJson: { priceMinor: '1000', currency: 'INR', minimumOrderQuantity: 1 },
      stockJson: [],
      packagingJson: {},
      generatedTitle: title,
      submittedAt: new Date(),
      version: 2,
      submittedVersion: status === 'PENDING_REVIEW' ? 2 : null,
      ...(status === 'REJECTED' ? { reviewedByUserId: moderatorId, reviewComment: 'Claims are not allowed.' } : {}),
    },
  });
  return id;
}

async function staffUser(email: string): Promise<string> {
  const user = await prisma.user.create({
    data: { id: newId(), type: 'ADMIN', email, emailNormalized: email, passwordHash: 'x', status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  return user.id;
}

beforeAll(async () => {
  await cleanUp();
  moderatorId = await staffUser(MODERATOR);
  secondId = await staffUser(SECOND);

  if ((await prisma.taxClass.findFirst({ select: { id: true } })) === null) {
    await prisma.taxClass.create({ data: { id: newId(), code: 'LM18', name: 'GST 18%', ratePercent: '18.000000', isActive: true } });
  }
  categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'Listing moderation', slug: CATEGORY_SLUG, isActive: true } });

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: 'LM Acme Ltd',
      displayName: 'LM Acme',
      displayNameNormalized: 'lm acme',
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
    displayName: 'LM Acme',
    legalName: 'LM Acme Ltd',
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

  await saveProhibitedTerm(null, { term: TERM, reason: 'Medical cure claims are not allowed.', severity: 'BLOCKER', isActive: true }, {
    userId: moderatorId,
    email: MODERATOR,
  });
});

afterAll(async () => {
  await cleanUp();
});

describe('automated flags', () => {
  it('flags a prohibited term for the moderator, matching whole words only', async () => {
    const draftId = await makeDraft('PENDING_REVIEW');
    const hits = await prisma.$transaction((tx) => flagProhibitedTerms(tx, draftId));
    expect(hits).toBe(1);
    const view = await readListingForReview(draftId);
    expect(view.issues).toEqual([expect.objectContaining({ code: 'PROHIBITED_TERM', isFromModerator: false })]);
    expect(view.status).toBe('PENDING_REVIEW');
  });
});

describe('evidence requests', () => {
  it('saves what the seller must send, and shows it to them', async () => {
    const draftId = await makeDraft('PENDING_REVIEW');
    await decideListing({
      draftId,
      to: 'ACTION_REQUIRED',
      comment: 'Send the certificate.',
      evidenceRequest: [{ kind: 'CERTIFICATE', label: 'CE certificate', note: 'Issued by a notified body' }],
      adminUserId: moderatorId,
      expectedVersion: 2,
    });
    const view = await readDraft(membership, draftId);
    expect(view.evidenceRequest).toEqual([{ kind: 'CERTIFICATE', label: 'CE certificate', note: 'Issued by a notified body' }]);
  });
});

describe('appeals', () => {
  it('lets the seller appeal a refusal, and puts it in the appeals queue', async () => {
    const draftId = await makeDraft('REJECTED');
    await appealListing(membership, draftId, 'The claim is backed by our clinical study, attached.');
    const queue = await listReviewQueue({ status: 'APPEALED' });
    expect(queue.rows.map((row) => row.id)).toContain(draftId);
  });

  it('refuses the moderator who refused it, and lets a second one uphold it back into review', async () => {
    const draftId = await makeDraft('REJECTED');
    await appealListing(membership, draftId, 'We have removed the claim from the title and photos.');

    await expect(
      decideListingAppeal({ draftId, outcome: 'UPHELD', comment: 'Fine.', actor: { userId: moderatorId, email: MODERATOR } }),
    ).rejects.toMatchObject({ code: 'LISTING_APPEAL_SAME_MODERATOR' });

    const result = await decideListingAppeal({
      draftId,
      outcome: 'UPHELD',
      comment: 'Looks fixed; review again.',
      actor: { userId: secondId, email: SECOND },
    });
    expect(result.status).toBe('PENDING_REVIEW');
    const row = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(row).toMatchObject({ status: 'PENDING_REVIEW', appealOutcome: 'UPHELD', submittedVersion: 2 });
  });

  it('keeps it refused when the appeal is refused', async () => {
    const draftId = await makeDraft('REJECTED');
    await appealListing(membership, draftId, 'Please look again at the labelling we sent.');
    await decideListingAppeal({ draftId, outcome: 'REFUSED', comment: 'The label still makes the claim.', actor: { userId: secondId, email: SECOND } });
    const row = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    expect(row).toMatchObject({ status: 'REJECTED', appealOutcome: 'REFUSED' });
  });
});

describe('approve but block in countries', () => {
  it('writes a PRODUCT-scope BLOCK rule for each country, with its history', async () => {
    const draftId = await makeDraft('PENDING_REVIEW', 'A listing for some countries');
    await decideListing({
      draftId,
      to: 'APPROVED',
      comment: 'Not registered there.',
      blockedCountries: ['us', 'GB', 'US'],
      adminUserId: moderatorId,
      adminEmail: MODERATOR,
      expectedVersion: 2,
    });
    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId }, select: { publishedProductId: true } });
    const rules = await prisma.marketRule.findMany({ where: { productId: draft.publishedProductId ?? '' }, orderBy: { countryCode: 'asc' } });
    expect(rules.map((rule) => [rule.countryCode, rule.scope, rule.effect])).toEqual([
      ['GB', 'PRODUCT', 'BLOCK'],
      ['US', 'PRODUCT', 'BLOCK'],
    ]);
    expect(await prisma.marketRuleVersion.count({ where: { ruleId: { in: rules.map((rule) => rule.id) } } })).toBe(2);
  });
});
