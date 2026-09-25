/**
 * A product's specifications and description sections: writing them from a
 * seller's content, and choosing which to show a reader.
 *
 * One writer, used by listing approval and by the describing seller's own
 * edit, so "what a seller's content becomes on the product" has one answer.
 * Replacing is whole-set: the seller's list is the list, in their order.
 */
import type { PrismaTransaction } from '../../infra/prisma.js';
import { newId } from '../../infra/ids.js';
import { productRowsFrom, type ListingContent } from '../../domain/product-specifications.js';

export interface DescriptionSectionRow {
  heading: string;
  body: string;
  language: string | null;
  altText: string | null;
  sortOrder: number;
  image: { url: string; altText: string | null; width: number | null; height: number | null } | null;
}

export interface ShownDescriptionSection {
  heading: string;
  body: string;
  image: { url: string; alt: string; width: number | null; height: number | null } | null;
}

/**
 * The reader's language's sections when there are any, otherwise the
 * product's own. Never a mixture: half a description in one language and half
 * in another reads as two products.
 */
export function descriptionSectionsFor(
  rows: readonly DescriptionSectionRow[],
  language: string | null,
): ShownDescriptionSection[] {
  const translated = language === null ? [] : rows.filter((row) => row.language === language);
  const chosen = translated.length > 0 ? translated : rows.filter((row) => row.language === null);
  return [...chosen]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((row) => row.heading.trim() !== '' || row.body.trim() !== '')
    .map((row) => ({
      heading: row.heading,
      body: row.body,
      image:
        row.image === null
          ? null
          : {
              url: row.image.url,
              // A picture with no words for a screen reader says nothing; the
              // heading is the honest fallback, never the file name.
              alt: row.altText ?? row.image.altText ?? row.heading,
              width: row.image.width,
              height: row.image.height,
            },
    }));
}

/**
 * Replace a product's specifications, description sections and variant
 * overrides with a seller's content.
 *
 * `variantIds` maps the listing's option signatures to the product's variant
 * ids; an override for a signature with no variant is dropped rather than
 * attached to the wrong one. `allowedImageIds` are the pictures that belong to
 * this listing - a section cannot point at somebody else's upload.
 */
export async function replaceProductContent(
  tx: PrismaTransaction,
  productId: string,
  content: ListingContent,
  options: { variantIds: ReadonlyMap<string, string>; allowedImageIds: ReadonlySet<string> },
): Promise<void> {
  const rows = productRowsFrom(content);
  await tx.productAttribute.deleteMany({ where: { productId } });
  if (rows.length > 0) {
    await tx.productAttribute.createMany({
      data: rows.map((row) => ({
        id: newId(),
        productId,
        name: row.name,
        value: row.value,
        unit: row.unit,
        groupKey: row.groupKey,
        sortOrder: row.sortOrder,
        isHighlight: row.isHighlight,
      })),
    });
  }

  await tx.productDescriptionSection.deleteMany({ where: { productId, language: null } });
  const sections = content.descriptionSections.filter((section) => section.heading !== '' || section.body !== '');
  if (sections.length > 0) {
    await tx.productDescriptionSection.createMany({
      data: sections.map((section, index) => ({
        id: newId(),
        productId,
        language: null,
        heading: section.heading,
        body: section.body,
        imageMediaId:
          section.imageMediaId !== null && options.allowedImageIds.has(section.imageMediaId)
            ? section.imageMediaId
            : null,
        altText: section.altText,
        sortOrder: index,
      })),
    });
  }

  const variantIds = [...new Set(options.variantIds.values())];
  if (variantIds.length > 0) {
    await tx.productVariantAttribute.deleteMany({ where: { variantId: { in: variantIds } } });
  }
  const seen = new Set<string>();
  const overrides = content.variantOverrides.flatMap((row, index) => {
    const variantId = options.variantIds.get(row.variantSignature);
    const key = `${variantId ?? ''}:${row.label.toLocaleLowerCase('en')}`;
    if (variantId === undefined || row.value === '' || seen.has(key)) return [];
    seen.add(key);
    return [
      {
        id: newId(),
        variantId,
        name: row.label,
        value: row.value,
        unit: row.unit,
        groupKey: row.group,
        sortOrder: index,
      },
    ];
  });
  if (overrides.length > 0) await tx.productVariantAttribute.createMany({ data: overrides });
}
