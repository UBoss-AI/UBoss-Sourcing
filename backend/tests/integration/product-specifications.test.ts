/**
 * A seller's description and specifications, from the listing to the product
 * page.
 *
 * The claims, in order:
 *
 *   - the seller saves grouped specifications, description sections and
 *     per-variant values on their draft; markup and control characters do not
 *     survive the save;
 *   - another seller cannot read or write it (404), a label twice is refused,
 *     a picture or option that is not this listing's is refused, and nothing
 *     can change while the moderator is reviewing;
 *   - approval puts it on the product: groups, units, highlights, sections,
 *     and the variant's own values;
 *   - the public product page shows the groups in the fixed order, a variant
 *     with its own values replaces the product's for that variant only, and a
 *     product whose rows predate groups still renders, under General;
 *   - the describing seller can change the live page; a seller who matched an
 *     existing page cannot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  readListingContentForSeller,
  saveListingContentForSeller,
} from '../../src/modules/seller/listing-content.service.js';
import { decideListing } from '../../src/modules/seller/moderation.service.js';
import type { buildApp as BuildApp } from '../../src/http/app.js';

const ADMIN_EMAIL = 'prodspec-admin@test.local';
const SELLERS = ['prodspec-acme', 'prodspec-rival'] as const;
const CATEGORY = 'prodspec-test-category';

let app: Awaited<ReturnType<typeof BuildApp>>;
let adminUserId = '';
let categoryId = '';
let parentCategoryId = '';
let createdParent = false;
let taxClassId = '';
let createdTaxClass = false;
let locationId = '';
let acme: SellerMembership;
let rival: SellerMembership;

function membershipFor(sellerAccountId: string, slug: string): SellerMembership {
  return {
    sellerAccountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: slug,
    legalName: slug,
    slug,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

async function cleanUp(): Promise<void> {
  const sellers = { sellerAccount: { slug: { in: [...SELLERS] } } };
  const products = { product: { category: { slug: CATEGORY } } };
  await prisma.sellerInventoryMovement.deleteMany({ where: sellers });
  await prisma.sellerInventory.deleteMany({ where: sellers });
  await prisma.sellerOffer.deleteMany({ where: sellers });
  await prisma.productVariant.deleteMany({ where: products });
  await prisma.productPrice.deleteMany({ where: products });
  await prisma.productMedia.deleteMany({ where: products });
  await prisma.product.deleteMany({ where: { category: { slug: CATEGORY } } });
  await prisma.sellerListingDraftMedia.deleteMany({ where: { draft: sellers } });
  await prisma.sellerListingIssue.deleteMany({ where: { draft: sellers } });
  await prisma.sellerListingDraft.deleteMany({ where: sellers });
  await prisma.sellerNotification.deleteMany({ where: sellers });
  await prisma.sellerAuditLog.deleteMany({ where: sellers });
  await prisma.sellerLocation.deleteMany({ where: sellers });
  await prisma.sellerAccount.deleteMany({ where: { slug: { in: [...SELLERS] } } });
  await prisma.category.deleteMany({ where: { slug: CATEGORY } });
  if (createdParent) {
    await prisma.category.deleteMany({ where: { slug: 'everyday-clothing' } });
    createdParent = false;
  }
  if (createdTaxClass) {
    await prisma.taxClass.deleteMany({ where: { code: 'PRODSPEC-GST' } });
    createdTaxClass = false;
  }
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

async function makeDraft(
  seller: SellerMembership,
  over: { status?: 'DRAFT' | 'PENDING_REVIEW'; matchedProductId?: string; variants?: boolean } = {},
): Promise<string> {
  const id = newId();
  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: seller.sellerAccountId,
      status: over.status ?? 'DRAFT',
      categoryId,
      sellerSku: `PS-${id.slice(-8)}`,
      matchedProductId: over.matchedProductId ?? null,
      attributesJson: {},
      offerJson: { priceMinor: '49900', currency: 'INR', taxClassId },
      stockJson: [{ locationId, availableQuantity: 3 }],
      packagingJson: {},
      generatedTitle: 'Stainless Steel Water Bottle',
      submittedAt: new Date(),
      ...(over.variants === true
        ? {
            variantAxesJson: { axes: [{ axisKey: 'size', values: [{ label: 'S' }, { label: 'M' }] }] },
            variantsJson: [
              { optionSignature: '', options: { size: 'S' }, name: 'S', sku: `PS-S-${id.slice(-6)}`, isActive: true, priceMinor: '49900', stock: [{ locationId, availableQuantity: 5 }] },
              { optionSignature: '', options: { size: 'M' }, name: 'M', sku: `PS-M-${id.slice(-6)}`, isActive: true, priceMinor: '52900', stock: [{ locationId, availableQuantity: 5 }] },
            ],
          }
        : {}),
    },
  });
  return id;
}

async function addDraftImage(draftId: string): Promise<string> {
  const id = newId();
  await prisma.sellerListingDraftMedia.create({
    data: {
      id,
      draftId,
      storageKey: `listing-media/${id}.png`,
      originalFileName: 'bottle-detail.png',
      contentType: 'image/png',
      byteSize: 1024,
      contentHash: id.padEnd(64, '0').slice(0, 64),
      kind: 'IMAGE',
      uploadedAt: new Date(),
      scanState: 'CLEAN',
    },
  });
  return id;
}

const CONTENT = {
  specifications: [
    {
      group: 'TECHNICAL',
      rows: [
        { label: 'Capacity', value: '750', unit: 'ml', highlight: true },
        { label: 'Insulation', value: 'Double wall <script>alert(1)</script>vacuum', unit: null },
      ],
    },
    { group: 'GENERAL', rows: [{ label: 'Model', value: 'SB-750', highlight: true }] },
    { group: 'WARRANTY', rows: [{ label: 'Warranty', value: '2 years against manufacturing defects' }] },
  ],
  descriptionSections: [
    {
      heading: 'Overview',
      body: 'Keeps drinks cold for 24 hours.\n\nLeak-proof lid.<img src=x onerror=alert(1)>',
      imageMediaId: null,
      altText: null,
    },
  ],
  variantOverrides: [] as unknown[],
};

beforeAll(async () => {
  await cleanUp();
  adminUserId = (
    await prisma.user.create({
      data: { id: newId(), email: ADMIN_EMAIL, emailNormalized: ADMIN_EMAIL, passwordHash: 'x', type: 'ADMIN', status: 'ACTIVE' },
    })
  ).id;

  const tax = await prisma.taxClass.findFirst({ select: { id: true } });
  if (tax === null) {
    taxClassId = newId();
    createdTaxClass = true;
    await prisma.taxClass.create({ data: { id: taxClassId, code: 'PRODSPEC-GST', name: 'Prodspec GST', ratePercent: 18 } });
  } else {
    taxClassId = tax.id;
  }

  const parent = await prisma.category.findUnique({ where: { slug: 'everyday-clothing' }, select: { id: true } });
  if (parent === null) {
    parentCategoryId = newId();
    createdParent = true;
    await prisma.category.create({
      data: { id: parentCategoryId, name: 'Everyday Clothing', slug: 'everyday-clothing', isActive: true, path: '' },
    });
  } else {
    parentCategoryId = parent.id;
  }
  categoryId = (
    await prisma.category.create({
      data: { id: newId(), parentId: parentCategoryId, name: 'Prodspec Bottles', slug: CATEGORY, isActive: true, path: `/${parentCategoryId}/` },
    })
  ).id;

  const [acmeId, rivalId] = [newId(), newId()];
  for (const [id, slug] of [[acmeId, SELLERS[0]], [rivalId, SELLERS[1]]] as const) {
    await prisma.sellerAccount.create({
      data: { id, legalName: `${slug} Ltd`, displayName: slug, displayNameNormalized: slug, slug, kind: 'WHOLESALER', registrationCountry: 'IN', status: 'APPROVED' },
    });
  }
  locationId = newId();
  await prisma.sellerLocation.create({
    data: { id: locationId, sellerAccountId: acmeId, code: 'PS1', name: 'Prodspec Warehouse', addressLine1: '1 Road', city: 'Chennai', postcode: '600001', countryCode: 'IN', timezone: 'Asia/Kolkata' },
  });
  acme = membershipFor(acmeId, SELLERS[0]);
  rival = membershipFor(rivalId, SELLERS[1]);

  const { buildApp } = await import('../../src/http/app.js');
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await cleanUp();
});

describe('a seller writing the description and specifications', () => {
  let draftId = '';

  it('saves groups and sections, with markup removed', async () => {
    draftId = await makeDraft(acme);
    const view = await saveListingContentForSeller({ membership: acme, draftId, body: CONTENT });
    expect(view.appliesTo).toBe('draft');
    const technical = view.content.specifications.find((group) => group.group === 'TECHNICAL');
    expect(technical?.rows[1]?.value).toBe('Double wall alert(1) vacuum');
    expect(view.content.descriptionSections[0]?.body).toBe('Keeps drinks cold for 24 hours.\n\nLeak-proof lid.');
    expect(JSON.stringify(view.content)).not.toMatch(/<script|onerror|<img/);
  });

  it('is invisible to another seller', async () => {
    await expect(readListingContentForSeller(rival, draftId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(saveListingContentForSeller({ membership: rival, draftId, body: CONTENT })).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('refuses a label twice, a unit it does not know, and a picture from elsewhere', async () => {
    await expect(
      saveListingContentForSeller({
        membership: acme,
        draftId,
        body: {
          specifications: [
            { group: 'GENERAL', rows: [{ label: 'Weight', value: '1 kg' }] },
            { group: 'TECHNICAL', rows: [{ label: 'weight', value: '2 kg' }] },
          ],
        },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'VALIDATION_FAILED' });
    await expect(
      saveListingContentForSeller({
        membership: acme,
        draftId,
        body: { specifications: [{ group: 'GENERAL', rows: [{ label: 'Weight', value: '1', unit: 'stone' }] }] },
      }),
    ).rejects.toThrow();
    const otherDraft = await makeDraft(rival);
    const foreignImage = await addDraftImage(otherDraft);
    await expect(
      saveListingContentForSeller({
        membership: acme,
        draftId,
        body: { descriptionSections: [{ heading: 'Look', body: 'Nice', imageMediaId: foreignImage }] },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('cannot change while the moderator is reviewing', async () => {
    const reviewing = await makeDraft(acme, { status: 'PENDING_REVIEW' });
    await expect(saveListingContentForSeller({ membership: acme, draftId: reviewing, body: CONTENT })).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe('approval and the product page', () => {
  let productId = '';
  let productSlug = '';
  let draftId = '';
  let signatureM = '';

  it('puts the content on the product, with the variant’s own values', async () => {
    draftId = await makeDraft(acme, { variants: true });
    const image = await addDraftImage(draftId);
    const seen = await readListingContentForSeller(acme, draftId);
    signatureM = seen.variants.find((variant) => variant.name.endsWith('M'))?.signature ?? '';
    expect(signatureM).not.toBe('');
    await saveListingContentForSeller({
      membership: acme,
      draftId,
      body: {
        ...CONTENT,
        descriptionSections: [{ ...CONTENT.descriptionSections[0], imageMediaId: image, altText: 'The lid, closed' }],
        variantOverrides: [
          { variantSignature: signatureM, group: 'TECHNICAL', label: 'Capacity', value: '1000', unit: 'ml' },
          { variantSignature: signatureM, group: 'DIMENSIONS_WEIGHT', label: 'Height', value: '29', unit: 'cm' },
        ],
      },
    });
    await prisma.sellerListingDraft.update({ where: { id: draftId }, data: { status: 'PENDING_REVIEW' } });
    await decideListing({ draftId, to: 'APPROVED', adminUserId });

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });
    productId = draft.publishedProductId ?? '';
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId }, select: { slug: true } });
    productSlug = product.slug;

    const rows = await prisma.productAttribute.findMany({ where: { productId }, orderBy: { sortOrder: 'asc' } });
    expect(rows.map((row) => [row.groupKey, row.name, row.unit, row.isHighlight])).toEqual([
      ['GENERAL', 'Model', null, true],
      ['TECHNICAL', 'Capacity', 'ml', true],
      ['TECHNICAL', 'Insulation', null, false],
      ['WARRANTY', 'Warranty', null, false],
    ]);
    const sections = await prisma.productDescriptionSection.findMany({ where: { productId } });
    expect(sections).toHaveLength(1);
    expect(sections[0]?.imageMediaId).not.toBeNull();
    const overrides = await prisma.productVariantAttribute.findMany({ where: { variant: { productId } } });
    expect(overrides.map((row) => row.name).sort()).toEqual(['Capacity', 'Height']);
  });

  it('shows the groups in order, and a variant’s own values only for that variant', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/products/${productSlug}` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      product?: Record<string, unknown>;
    } & Record<string, unknown>>();
    const product = (body.product ?? body) as {
      specifications: { group: string; rows: { label: string; value: string; unit: string | null }[] }[];
      descriptionSections: { heading: string; body: string; image: { alt: string } | null }[];
      variants: { name: string; specifications: { group: string; rows: { label: string; value: string }[] }[] | null }[];
    };
    expect(product.specifications.map((group) => group.group)).toEqual(['GENERAL', 'TECHNICAL', 'WARRANTY']);
    expect(product.descriptionSections[0]).toMatchObject({ heading: 'Overview', image: { alt: 'The lid, closed' } });

    const small = product.variants.find((variant) => variant.name.endsWith('S'));
    const medium = product.variants.find((variant) => variant.name.endsWith('M'));
    expect(small?.specifications).toBeNull();
    const mediumTechnical = medium?.specifications?.find((group) => group.group === 'TECHNICAL');
    expect(mediumTechnical?.rows.find((row) => row.label === 'Capacity')?.value).toBe('1000');
    expect(medium?.specifications?.map((group) => group.group)).toEqual([
      'GENERAL',
      'TECHNICAL',
      'DIMENSIONS_WEIGHT',
      'WARRANTY',
    ]);
  });

  it('still renders a product whose specifications predate groups, under General', async () => {
    await prisma.productAttribute.updateMany({ where: { productId }, data: { groupKey: null } });
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/products/${productSlug}` });
    const body = response.json<Record<string, unknown>>();
    const product = (body['product'] ?? body) as { specifications: { group: string; rows: unknown[] }[] };
    expect(product.specifications.map((group) => group.group)).toEqual(['GENERAL']);
    expect(product.specifications[0]?.rows).toHaveLength(4);
  });

  it('lets the describing seller change the live page', async () => {
    const view = await saveListingContentForSeller({
      membership: acme,
      draftId,
      body: { specifications: [{ group: 'MATERIAL', rows: [{ label: 'Body', value: '18/8 stainless steel' }] }] },
    });
    expect(view.appliesTo).toBe('live');
    const rows = await prisma.productAttribute.findMany({ where: { productId } });
    expect(rows.map((row) => row.name)).toEqual(['Body']);
  });

  it('does not let a seller who matched the page change it', async () => {
    const matched = await makeDraft(rival, { matchedProductId: productId, status: 'PENDING_REVIEW' });
    await prisma.sellerListingDraft.update({ where: { id: matched }, data: { status: 'APPROVED', publishedProductId: productId } });
    const view = await readListingContentForSeller(rival, matched);
    expect(view.editable).toBe(false);
    await expect(
      saveListingContentForSeller({ membership: rival, draftId: matched, body: CONTENT }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await prisma.productAttribute.findMany({ where: { productId } })).map((row) => row.name)).toEqual(['Body']);
  });
});
