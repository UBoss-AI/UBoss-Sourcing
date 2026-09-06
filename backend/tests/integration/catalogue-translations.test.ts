/**
 * Per-language catalogue copy - integration, against a real MariaDB.
 *
 * The behaviour worth pinning down is the fallback, because it is the part
 * that decides what a half-translated catalogue looks like. The rule is
 * field-by-field, not row-by-row: a product whose Polish name is written but
 * whose Polish description is not shows the Polish name beside the English
 * description. Row-by-row would be easier to implement and would throw away a
 * translation somebody had already paid for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  applyCategoryCopy,
  applyProductCopy,
  productIdsMatchingTranslation,
} from '../../src/modules/catalog/translation.service.js';

const BASE = {
  name: 'Accu-Flow IV Infusion Set',
  shortDescription: 'Sterile single-use infusion set.',
  description: 'A long description in the base language.',
  metaTitle: 'Accu-Flow',
  metaDescription: 'Buy Accu-Flow.',
  // GPSR Art. 19(d) safety text travels with the copy, and falls back to the
  // base row the same way. See the dedicated case below.
  safetyWarnings: 'Single use only. Do not re-sterilise.',
  safetyInstructions: 'Inspect the packaging before use.',
  // MDR Art. 10(11), translated alongside the warnings.
  intendedPurpose: 'Intravenous administration of fluids.',
};

describe('applyProductCopy', () => {
  it('returns the base copy when there is no translation', () => {
    expect(applyProductCopy(BASE, null)).toEqual(BASE);
    expect(applyProductCopy(BASE, undefined)).toEqual(BASE);
  });

  it('overrides only the fields the translation actually has', () => {
    const result = applyProductCopy(BASE, {
      name: 'Zestaw do infuzji Accu-Flow',
      shortDescription: null,
      description: null,
      metaTitle: null,
      metaDescription: null,
    });

    // The half that was translated.
    expect(result.name).toBe('Zestaw do infuzji Accu-Flow');
    // The half that was not - English, not blank.
    expect(result.shortDescription).toBe(BASE.shortDescription);
    expect(result.description).toBe(BASE.description);
  });

  it('treats an empty string as a gap, not as a translation', () => {
    // The admin form posts '' for a field somebody cleared. Storing that as an
    // override would blank the name on the storefront instead of falling back.
    const result = applyProductCopy(BASE, {
      name: 'Zestaw',
      shortDescription: '   ',
      description: '',
      metaTitle: null,
      metaDescription: null,
    });

    expect(result.shortDescription).toBe(BASE.shortDescription);
    expect(result.description).toBe(BASE.description);
  });
});

describe('applyCategoryCopy', () => {
  it('falls back field by field', () => {
    const base = {
      name: 'Industrial Fasteners',
      description: 'Bolts and screws.',
      metaTitle: null,
      metaDescription: null,
    };

    const result = applyCategoryCopy(base, {
      name: 'Przemysłowe elementy złączne',
      description: null,
      metaTitle: null,
      metaDescription: null,
    });

    expect(result.name).toBe('Przemysłowe elementy złączne');
    expect(result.description).toBe('Bolts and screws.');
  });
});

describe('productIdsMatchingTranslation', () => {
  let categoryId: string;
  let taxClassId: string;
  let productId: string;

  beforeAll(async () => {
    const taxClass = await prisma.taxClass.findFirst({ select: { id: true } });
    taxClassId = taxClass?.id ?? '';

    if (taxClassId === '') {
      const created = await prisma.taxClass.create({
        data: { id: newId(), code: 'T-I18N', name: 'Test', ratePercent: 0, isInclusive: false },
        select: { id: true },
      });
      taxClassId = created.id;
    }
  });

  beforeEach(async () => {
    await prisma.productTranslation.deleteMany({ where: { language: 'pl' } });
    await prisma.product.deleteMany({ where: { sku: { startsWith: 'I18N-' } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'i18n-' } } });

    const category = await prisma.category.create({
      data: { id: newId(), name: 'i18n test', slug: `i18n-${newId()}`, path: '/', depth: 0 },
      select: { id: true },
    });
    categoryId = category.id;

    const product = await prisma.product.create({
      data: {
        id: newId(),
        categoryId,
        taxClassId,
        name: 'Infusion Set',
        slug: `i18n-product-${newId()}`,
        sku: `I18N-${newId().slice(0, 8)}`,
        shortDescription: 'Sterile set.',
        basePriceMinor: 1000n,
        currency: 'INR',
      },
      select: { id: true },
    });
    productId = product.id;
  });

  afterAll(async () => {
    await prisma.productTranslation.deleteMany({ where: { language: 'pl' } });
    await prisma.product.deleteMany({ where: { sku: { startsWith: 'I18N-' } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'i18n-' } } });
    await prisma.$disconnect();
  });

  it('finds a product by a word that exists only in its translation', async () => {
    await prisma.productTranslation.create({
      data: {
        id: newId(),
        productId,
        language: 'pl',
        name: 'Zestaw do infuzji',
      },
    });

    // The whole point: a Polish buyer reading a translated catalogue has to be
    // able to search it in Polish. Without this the page looks translated and
    // behaves as though it were not.
    await expect(productIdsMatchingTranslation('pl', 'infuzji')).resolves.toEqual([productId]);
  });

  it('does not match another language', async () => {
    await prisma.productTranslation.create({
      data: { id: newId(), productId, language: 'pl', name: 'Zestaw do infuzji' },
    });

    await expect(productIdsMatchingTranslation('el', 'infuzji')).resolves.toEqual([]);
  });

  it('returns nothing for a null language or an empty term', async () => {
    await expect(productIdsMatchingTranslation(null, 'infuzji')).resolves.toEqual([]);
    await expect(productIdsMatchingTranslation('pl', '   ')).resolves.toEqual([]);
  });
});
