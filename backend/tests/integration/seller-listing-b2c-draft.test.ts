/**
 * A new listing cannot be sent for review without a B2C maximum order
 * quantity - and a bad one is refused rather than corrected.
 *
 * Drafting is never blocked: a draft saves with the box empty. Only
 * submission is, through a BLOCKER issue tied to the field, which is what
 * both the wizard's summary and the server's submit refusal read.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { submitDraft, validateDraft } from '../../src/modules/seller/listing-draft.service.js';

const SELLER_SLUG = 'b2c-draft-seller';
const CATEGORY_SLUG = 'b2c-draft-category';

let sellerId = '';
let categoryId = '';
let membership: SellerMembership;

async function cleanUp(): Promise<void> {
  await prisma.sellerListingIssue.deleteMany({ where: { draft: { sellerAccount: { slug: SELLER_SLUG } } } });
  await prisma.sellerListingDraft.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SELLER_SLUG } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY_SLUG } });
}

async function draftWith(offer: Record<string, unknown>): Promise<string> {
  const id = newId();
  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: sellerId,
      status: 'DRAFT',
      categoryId,
      sellerSku: `B2C-${id.slice(-8)}`,
      attributesJson: {},
      offerJson: { priceMinor: '1000', currency: 'INR', minimumOrderQuantity: 5, ...offer },
      stockJson: [],
      packagingJson: {},
    },
  });
  return id;
}

async function b2cIssue(draftId: string) {
  const view = await validateDraft(membership, draftId);
  return view.issues.find((issue) => issue.attributeKey === 'offer.b2cMaxOrderQuantity') ?? null;
}

beforeAll(async () => {
  await cleanUp();
  categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'B2C drafts', slug: CATEGORY_SLUG, isActive: true } });
  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: 'B2C Draft Ltd',
      displayName: 'B2C Draft',
      displayNameNormalized: 'b2c draft',
      slug: SELLER_SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  membership = {
    sellerAccountId: sellerId,
    displayName: 'B2C Draft',
    legalName: 'B2C Draft Ltd',
    slug: SELLER_SLUG,
    status: 'APPROVED',
    memberId: newId(),
    customerProfileId: newId(),
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

describe('submitting a new listing', () => {
  it('saves a draft with no limit, but blocks submission until one is set', async () => {
    const id = await draftWith({});
    const issue = await b2cIssue(id);
    expect(issue).toMatchObject({
      severity: 'BLOCKER',
      code: 'B2C_MAX_ORDER_QUANTITY_REQUIRED',
      section: 'PRICE_STOCK_SHIPPING',
    });
    await expect(submitDraft(membership, id)).rejects.toMatchObject({
      code: 'LISTING_NOT_SUBMITTABLE',
    });
  });

  it.each([[0], [-1], [2.5], ['100'], [1_000_001], [3]])('refuses %p as invalid', async (value) => {
    // 3 is below this listing's minimum of 5: no individual could buy it.
    const issue = await b2cIssue(await draftWith({ b2cMaxOrderQuantity: value }));
    expect(issue).toMatchObject({ severity: 'BLOCKER', code: 'B2C_MAX_ORDER_QUANTITY_INVALID' });
  });

  it('raises nothing for a valid limit', async () => {
    expect(await b2cIssue(await draftWith({ b2cMaxOrderQuantity: 100 }))).toBeNull();
  });
});
