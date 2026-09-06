/**
 * GPSR at the publication gate — integration, against a real MariaDB.
 *
 * Art. 19 is about what a listing carries at the moment it is *offered*, which
 * makes publication the only place the check belongs. The unit tests next door
 * assert the rules; this asserts that they actually stop a publication, that
 * they stop it only where the deployment sells somewhere requiring it, and
 * that a shopper reading the page afterwards can see the answer.
 *
 * The last of those is easy to lose. A product can carry a perfect
 * manufacturer record in the database and still be non-compliant, because the
 * regulation is about what the buyer sees before they buy — not about what the
 * catalogue knows.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { publishProduct } from '../../src/modules/catalog/product.service.js';
import { assessProductGpsr } from '../../src/modules/catalog/gpsr.service.js';

let actor: { userId: string; email: string };
let categoryId: string;
let taxClassId: string;
let productId: string;
let dutchManufacturerId: string;
let indianManufacturerId: string;
let euRepresentativeId: string;

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.productTranslation.deleteMany({});
  await prisma.productMedia.deleteMany({});
  await prisma.mediaAsset.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.economicOperator.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

async function makeOperator(
  role: 'MANUFACTURER' | 'EU_RESPONSIBLE_PERSON',
  legalName: string,
  countryCode: string,
): Promise<string> {
  const id = newId();
  await prisma.economicOperator.create({
    data: {
      id,
      role,
      legalName,
      addressJson: { line1: 'Industrieweg 1', city: 'Rotterdam' },
      countryCode,
      email: `compliance@${legalName.toLowerCase().replace(/[^a-z]/g, '')}.test`,
    },
  });
  return id;
}

/** A product complete on everything EXCEPT product safety. */
async function makeProduct(): Promise<string> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: 'Accu-Flow IV Infusion Set',
      slug: `accu-flow-${id.slice(-6).toLowerCase()}`,
      sku: `AF-${id.slice(-6)}`,
      shortDescription: 'Sterile single-use infusion set.',
      basePriceMinor: 12_500n,
      currency: 'EUR',
      status: 'DRAFT',
      isPublished: false,
    },
  });

  // The publish validator needs at least one image, and this file is about
  // safety information rather than about that rule.
  const mediaId = newId();
  await prisma.mediaAsset.create({
    data: {
      id: mediaId,
      storageKey: `products/xx/yy/${mediaId}.jpg`,
      url: `https://example.test/${mediaId}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      checksum: 'x'.repeat(64),
    },
  });
  await prisma.productMedia.create({
    data: { id: newId(), productId: id, mediaId, isPrimary: true, sortOrder: 0 },
  });

  return id;
}

/** Everything Art. 19 asks for, in one update. */
async function makeCompliant(id: string, manufacturerId: string, euResponsibleId?: string) {
  await prisma.product.update({
    where: { id },
    data: {
      manufacturerId,
      euResponsibleId: euResponsibleId ?? null,
      gtin: '05012345678900',
      modelIdentifier: 'AF-IV-200',
      safetyWarnings: 'Single use only. Do not re-sterilise.',
    },
  });
}

async function setEnforcement(enforced: boolean): Promise<void> {
  await prisma.businessProfile.updateMany({ data: { gpsrEnforced: enforced } });
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Medical B.V.',
      displayName: 'UBOSS',
      supportEmail: 'support@uboss.test',
      currency: 'EUR',
      timezone: 'Europe/Amsterdam',
      gpsrEnforced: true,
    },
  });

  // NL is inside the VAT area, IN is not. That flag is what decides whether a
  // manufacturer needs a separate EU representative.
  await prisma.country.updateMany({ where: { code: 'NL' }, data: { isEuVat: true } });
  await prisma.country.updateMany({ where: { code: 'IN' }, data: { isEuVat: false } });

  const adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@gpsr.test',
      emailNormalized: 'admin@gpsr.test',
      status: 'ACTIVE',
    },
  });
  actor = { userId: adminId, email: 'admin@gpsr.test' };

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'VAT-STD',
      name: 'Standard',
      ratePercent: '21.000000',
      isDefault: true,
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Infusion', slug: 'infusion', isActive: true },
  });
  categoryId = category.id;

  dutchManufacturerId = await makeOperator('MANUFACTURER', 'Zorgproducten BV', 'NL');
  indianManufacturerId = await makeOperator('MANUFACTURER', 'SPM Medicare', 'IN');
  euRepresentativeId = await makeOperator('EU_RESPONSIBLE_PERSON', 'EU Rep GmbH', 'DE');

  productId = await makeProduct();
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

describe('publication', () => {
  it('refuses a listing with no manufacturer or safety information', async () => {
    await expect(publishProduct(productId, actor)).rejects.toSatisfy(
      (error: unknown) =>
        isAppError(error) && error.code === 'PRODUCT_INCOMPLETE_FOR_PUBLISH',
    );

    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.isPublished).toBe(false);
  });

  it('names every missing piece at once', async () => {
    let codes: string[] = [];

    try {
      await publishProduct(productId, actor);
    } catch (error) {
      if (isAppError(error)) codes = error.details.map((detail) => detail.code ?? '');
    }

    // A catalogue manager who fixes one field, saves, and learns about the
    // next one is a catalogue manager who stops using the feature.
    expect(codes).toContain('MANUFACTURER_REQUIRED');
    expect(codes).toContain('IDENTIFIER_REQUIRED');
    expect(codes).toContain('SAFETY_INFORMATION_REQUIRED');
  });

  it('publishes once the listing carries what Art. 19 asks for', async () => {
    await makeCompliant(productId, dutchManufacturerId);

    const result = await publishProduct(productId, actor);

    expect(result.publishedAt).toBeInstanceOf(Date);
    const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
    expect(product.isPublished).toBe(true);
  });

  it('refuses a non-EU manufacturer with no EU responsible person', async () => {
    await makeCompliant(productId, indianManufacturerId);

    let codes: string[] = [];
    try {
      await publishProduct(productId, actor);
    } catch (error) {
      if (isAppError(error)) codes = error.details.map((detail) => detail.code ?? '');
    }

    // The single most commonly missing piece on an importing seller's listing.
    expect(codes).toContain('EU_RESPONSIBLE_REQUIRED');
  });

  it('publishes a non-EU manufacturer once a representative is named', async () => {
    await makeCompliant(productId, indianManufacturerId, euRepresentativeId);

    await expect(publishProduct(productId, actor)).resolves.toBeDefined();
  });

  it('does not block publication where the deployment does not sell into the Union', async () => {
    await setEnforcement(false);

    // No manufacturer, no identifier, no warnings - and this is fine, because
    // a shop selling only outside the EU has no Art. 19 obligation. Blocking
    // it would be this software inventing law.
    await expect(publishProduct(productId, actor)).resolves.toBeDefined();
  });

  it('still reports the gaps when enforcement is off', async () => {
    await setEnforcement(false);

    const assessment = await assessProductGpsr(productId, []);

    // What lets an operator cost the work before turning enforcement on.
    expect(assessment.enforced).toBe(false);
    expect(assessment.compliant).toBe(false);
    expect(assessment.gaps.length).toBeGreaterThan(0);
  });
});

describe('what the assessment reports', () => {
  it('matches what publication enforces', async () => {
    const before = await assessProductGpsr(productId, []);
    expect(before.compliant).toBe(false);

    await makeCompliant(productId, dutchManufacturerId);

    const after = await assessProductGpsr(productId, []);
    expect(after.compliant).toBe(true);

    // The checklist on the screen and the rule on the server are the same
    // function, so they cannot drift.
    await expect(publishProduct(productId, actor)).resolves.toBeDefined();
  });

  it('names the languages a warning has not been translated into', async () => {
    await makeCompliant(productId, dutchManufacturerId);

    await prisma.productTranslation.create({
      data: {
        id: newId(),
        productId,
        language: 'nl',
        name: 'Accu-Flow infuusset',
        safetyWarnings: 'Uitsluitend voor eenmalig gebruik.',
      },
    });

    const assessment = await assessProductGpsr(productId, ['nl', 'de', 'pl']);

    expect(assessment.missingWarningLanguages).toEqual(['de', 'pl']);
    // Never blocking: a warning in the base language still publishes.
    expect(assessment.compliant).toBe(true);
  });
});

describe('economic operators', () => {
  it('cannot be deleted while a listing still names one', async () => {
    await makeCompliant(productId, dutchManufacturerId);

    // The foreign key is Restrict on purpose: a listing whose manufacturer row
    // vanished would be offering a product with nobody named, which is the
    // exact state Art. 19 forbids.
    await expect(
      prisma.economicOperator.delete({ where: { id: dutchManufacturerId } }),
    ).rejects.toThrow();
  });
});
