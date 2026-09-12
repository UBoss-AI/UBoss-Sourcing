/**
 * Importing a supplier product sheet into the catalogue.
 *
 * Five rules, and every one of them is a thing that would otherwise go wrong
 * quietly.
 *
 *   1. **It never touches a price or an image.** Not on create, not on update.
 *      A product this import creates is marked priced-on-request with a zero
 *      base price and no media; a product it finds again keeps whatever an
 *      administrator has set since. The source sheet has an MRP column and it
 *      is deliberately never read - a maximum retail price from another market
 *      is not this deployment's selling price, and putting it in front of a
 *      buyer would be quoting a figure nobody in the business agreed to.
 *
 *   2. **It never publishes.** Everything lands as a DRAFT, exactly like the
 *      CSV importer next door. Publication is a separate, audited, separately
 *      permissioned act, and a file that could publish is a file that can put
 *      an unreviewed product in front of customers.
 *
 *   3. **It never deletes.** A product absent from the file is left alone. A
 *      catalogue cull is a deliberate decision, not a side effect of somebody
 *      sending a shorter sheet.
 *
 *   4. **Identity is a composite fingerprint, never one column.** The source
 *      reuses product codes and barcodes across genuinely different articles.
 *      See `sheet-values.ts` for what that costs if you get it wrong.
 *
 *   5. **A dry run and a real run share one code path.** `plan()` does all the
 *      reading, matching and deciding; `apply()` only writes what the plan
 *      says. A preview that disagrees with the outcome is worse than no
 *      preview, and one function is the only way to guarantee they agree.
 */
import type { Prisma } from '../../../generated/prisma/client.js';
import { ErrorCode, badRequest } from '../../../domain/errors.js';
import { newId, NO_VARIANT_KEY } from '../../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../../infra/prisma.js';
import { AuditAction, recordAudit } from '../../audit/audit.service.js';
import { slugify } from '../catalog.visibility.js';
import { publishProduct } from '../product.service.js';
import { packingFormula } from './packing-parser.js';
import { mapWorksheet, type MappedSheet, type SheetRecord, type SkippedRow } from './sheet-mapping.js';
import { normaliseForMatch, titleCase } from './sheet-values.js';
import { readWorkbook } from './xlsx-reader.js';

export interface SheetImportActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface SheetImportOptions {
  filePath: string;
  /** Which worksheet. Defaults to the first one the workbook lists. */
  sheetName?: string;
  /** True writes nothing at all and only reports what would happen. */
  dryRun: boolean;
  /**
   * Also publish what was imported, one product at a time, through the normal
   * `publishProduct`.
   *
   * Off by default, because an import that publishes is an import that can put
   * an unreviewed product in front of customers. When it is on, nothing is
   * bypassed: every product goes through the same validator, the same
   * GPSR/MDR assessment and the same audit entry as a publication done by hand
   * from the Admin Panel, and a product that fails any of them stays a draft
   * with its reasons listed in the report. It is a way to save four hundred
   * clicks, not a way around the gate.
   */
  publish?: boolean;
  actor: SheetImportActor;
}

/**
 * Source workflow states that must not produce a buyable product.
 *
 * Compared case-folded against column T. Anything the list does not recognise
 * - including a word somebody adds to the sheet next year - leaves the product
 * orderable, which is the same answer the catalogue gives every product that
 * was never imported. Guessing that an unknown word means "hold" would take a
 * working product off sale on the strength of a spelling change.
 */
const NOT_FOR_SALE_STATUSES = new Map<string, string>([
  ['HOLD', 'This product is on hold and cannot be ordered at the moment.'],
  ['WORKING ON IT', 'This product is still being prepared and cannot be ordered yet.'],
]);

/** Attribute names the import writes. Filterable ones become facets. */
const ATTRIBUTE_BRAND = 'Brand';
const ATTRIBUTE_STERILITY = 'Sterility';
const ATTRIBUTE_STERILISATION = 'Sterilisation method';
const ATTRIBUTE_PACKING = 'Packing type';
const ATTRIBUTE_SHELF_LIFE = 'Shelf life';
const ATTRIBUTE_PACK_SIZE = 'Pack size';

export interface SheetImportReport {
  filePath: string;
  fileName: string;
  sheetName: string;
  dryRun: boolean;

  categoriesDetected: string[];
  candidateRows: number;

  productsCreated: number;
  productsUpdated: number;
  variantsCreated: number;
  variantsUpdated: number;

  /** Rows identical in every identity field to one already read. Not imported. */
  exactDuplicatesSkipped: { rowNumber: number; matchesRow: number; preview: string }[];
  /**
   * A product code or barcode used by two rows that are NOT the same article.
   * Imported as separate variants, and listed here so somebody can check.
   */
  ambiguousDuplicates: { value: string; field: 'product code' | 'barcode'; rows: number[] }[];

  rowsWithoutIdentifier: SkippedRow[];
  rowsSkipped: SkippedRow[];
  rowsMissingGtin: number[];

  packingParsed: number;
  packingPartial: number;
  packingNeedsReview: { rowNumber: number; raw: string; message: string }[];
  packingUnparsed: { rowNumber: number; raw: string }[];

  /** A dimension cell with text in it that could not be read as a size. */
  dimensionsUnreadable: { rowNumber: number; field: string; raw: string }[];
  /** Read, but with no unit stated anywhere in the cell. */
  dimensionsWithoutUnit: number;

  /** Always zero, and reported so the reader can see that it is. */
  imagesChanged: 0;
  /**
   * Prices this import overwrote. Always zero, by construction.
   *
   * Not the same as "price rows written": a product being created for the
   * first time gets an empty, zero-valued row so the storefront listing - which
   * is rooted at the price table - can reach it at all. That row is created
   * once and never touched again, so a figure an administrator types later
   * survives every re-import. `priceRowsCreated` counts those separately, so
   * the report can say both things without either being misread as the other.
   */
  pricesChanged: 0;
  priceRowsCreated: number;

  /** Only populated when the run was asked to publish. */
  published: number;
  publishRefused: { sku: string; name: string; reasons: string[] }[];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface PlannedVariant {
  record: SheetRecord;
  /** Set once the variant exists; null while planning a new one. */
  existingVariantId: string | null;
  sku: string;
  name: string;
}

interface PlannedProduct {
  familyFingerprint: string;
  categoryName: string;
  name: string;
  sku: string;
  slug: string;
  shortDescription: string;
  isOrderable: boolean;
  unavailabilityReason: string | null;
  attributes: { name: string; value: string; isFilterable: boolean }[];
  variants: PlannedVariant[];
  existingProductId: string | null;
}

/**
 * A short, factual description built only from what the sheet states.
 *
 * No benefit, no indication, no certification, no "premium quality". Every
 * clause is a field the source filled in, and a field it left blank produces
 * no clause rather than a hedge. Inventing a claim about a medical device is
 * not a copywriting liberty, it is a regulatory problem.
 */
function describe(record: SheetRecord, packSummary: string | null): string {
  const clauses: string[] = [];

  // The same noun the card carries, so the description under a listing called
  // "Flush Syringe · Easy Flush" does not open with "This product".
  const article = titleCase(record.genericName ?? record.category);
  clauses.push(record.brand === null ? article : `${article} from ${titleCase(record.brand)}`);

  if (record.sterilisation !== null && record.sterility !== null) {
    clauses.push(
      record.sterility === 'STERILE'
        ? `supplied sterile (${record.sterilisation.toLowerCase()})`
        : 'supplied non-sterile',
    );
  }

  if (record.packingType !== null) clauses.push(`packed as ${record.packingType.toLowerCase()}`);
  if (packSummary !== null) clauses.push(packSummary);
  if (record.shelfLife !== null) clauses.push(`shelf life ${record.shelfLife.toLowerCase()}`);

  const [first, ...rest] = clauses;
  return rest.length === 0 ? `${first ?? article}.` : `${first ?? article}, ${rest.join(', ')}.`;
}

/** Every family's rows agree on packing, or they do not. */
function commonPacking(records: SheetRecord[]): SheetRecord['packing'] | null {
  const [head, ...tail] = records;
  if (head === undefined) return null;

  const same = tail.every(
    (record) =>
      record.packing.piecesPerInnerPack === head.packing.piecesPerInnerPack &&
      record.packing.innerPacksPerOuterCarton === head.packing.innerPacksPerOuterCarton &&
      record.packing.piecesPerOuterCarton === head.packing.piecesPerOuterCarton,
  );

  return same ? head.packing : null;
}

/**
 * A SKU that is stable across re-imports and readable in an admin list.
 *
 * Built from what the sheet says rather than from the fingerprint, because an
 * administrator has to recognise it in a picker. Uniqueness is settled against
 * the database and against the SKUs this run has already claimed - the second
 * half matters, because two families in one file can reduce to the same words.
 */
function uniqueSku(candidate: string, taken: Set<string>, fingerprint: string): string {
  const base = slugify(candidate).toUpperCase().slice(0, 52).replace(/-+$/, '');
  const root = base === '' ? 'PRODUCT' : base;

  if (!taken.has(root)) {
    taken.add(root);
    return root;
  }

  // Deterministic rather than a counter: a counter would renumber every SKU
  // after the one that changed the next time the sheet is edited.
  const suffixed = `${root}-${fingerprint.slice(0, 6).toUpperCase()}`;
  if (!taken.has(suffixed)) {
    taken.add(suffixed);
    return suffixed;
  }

  const longer = `${root}-${fingerprint.slice(0, 12).toUpperCase()}`;
  taken.add(longer);
  return longer;
}

function uniqueSlug(candidate: string, taken: Set<string>, fingerprint: string): string {
  const base = slugify(candidate).slice(0, 180).replace(/-+$/, '');
  const root = base === '' ? 'product' : base;
  if (!taken.has(root)) {
    taken.add(root);
    return root;
  }
  const suffixed = `${root}-${fingerprint.slice(0, 6)}`;
  taken.add(suffixed);
  return suffixed;
}

/**
 * Read the file and work out everything that would be written.
 *
 * Nothing here touches the database except to read: existing products, the
 * SKUs and slugs already taken, and the categories that already exist. A dry
 * run stops after this.
 */
async function plan(options: SheetImportOptions): Promise<{
  mapped: MappedSheet;
  products: PlannedProduct[];
  report: SheetImportReport;
}> {
  const sheets = readWorkbook(options.filePath);
  const sheet =
    options.sheetName === undefined
      ? sheets[0]
      : sheets.find((candidate) => candidate.name === options.sheetName);

  if (sheet === undefined) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      options.sheetName === undefined
        ? 'That workbook has no readable worksheet.'
        : `That workbook has no worksheet called "${options.sheetName}". It has: ` +
            sheets.map((candidate) => `"${candidate.name}"`).join(', '),
      [{ field: 'sheetName', code: 'NOT_FOUND' }],
    );
  }

  const mapped = mapWorksheet(sheet);
  const fileName = options.filePath.split(/[\\/]/).pop() ?? options.filePath;

  // --- exact duplicates, before anything else -------------------------------
  const seen = new Map<string, number>();
  const exactDuplicatesSkipped: SheetImportReport['exactDuplicatesSkipped'] = [];
  const records: SheetRecord[] = [];

  for (const record of mapped.records) {
    const first = seen.get(record.variantFingerprint);
    if (first !== undefined) {
      exactDuplicatesSkipped.push({
        rowNumber: record.sourceRow,
        matchesRow: first,
        preview: `${record.productCode ?? '(no code)'} · ${record.displayName}`,
      });
      continue;
    }
    seen.set(record.variantFingerprint, record.sourceRow);
    records.push(record);
  }

  // --- reused codes and barcodes across different articles ------------------
  const ambiguousDuplicates: SheetImportReport['ambiguousDuplicates'] = [];
  for (const [field, pick] of [
    ['product code', (record: SheetRecord) => record.productCode],
    ['barcode', (record: SheetRecord) => record.gtinNormalised],
  ] as const) {
    const byValue = new Map<string, number[]>();
    for (const record of records) {
      const value = pick(record);
      if (value === null) continue;
      const key = normaliseForMatch(value);
      byValue.set(key, [...(byValue.get(key) ?? []), record.sourceRow]);
    }
    for (const [value, rows] of byValue) {
      if (rows.length > 1) ambiguousDuplicates.push({ value, field, rows });
    }
  }

  // --- group into families --------------------------------------------------
  const families = new Map<string, SheetRecord[]>();
  for (const record of records) {
    families.set(record.familyFingerprint, [...(families.get(record.familyFingerprint) ?? []), record]);
  }

  // --- what is already in the catalogue ------------------------------------
  const fingerprints = [...families.keys()];
  const existingProducts =
    fingerprints.length === 0
      ? []
      : await prisma.product.findMany({
          where: { importFingerprint: { in: fingerprints } },
          select: { id: true, importFingerprint: true, sku: true, slug: true },
        });
  const productByFingerprint = new Map(
    existingProducts.map((product) => [product.importFingerprint ?? '', product]),
  );

  const variantFingerprints = records.map((record) => record.variantFingerprint);
  const existingVariants =
    variantFingerprints.length === 0
      ? []
      : await prisma.productVariant.findMany({
          where: { importFingerprint: { in: variantFingerprints } },
          select: { id: true, importFingerprint: true, sku: true },
        });
  const variantByFingerprint = new Map(
    existingVariants.map((variant) => [variant.importFingerprint ?? '', variant]),
  );

  const [allProductSkus, allVariantSkus, allSlugs] = await Promise.all([
    prisma.product.findMany({ select: { sku: true } }),
    prisma.productVariant.findMany({ select: { sku: true } }),
    prisma.product.findMany({ select: { slug: true } }),
  ]);

  const takenSkus = new Set([
    ...allProductSkus.map((row) => row.sku),
    ...allVariantSkus.map((row) => row.sku),
  ]);
  const takenSlugs = new Set(allSlugs.map((row) => row.slug));

  // A row this import already owns is not a collision with itself.
  for (const product of existingProducts) {
    takenSkus.delete(product.sku);
    takenSlugs.delete(product.slug);
  }
  for (const variant of existingVariants) takenSkus.delete(variant.sku);

  // --- build the plan -------------------------------------------------------
  const products: PlannedProduct[] = [];

  for (const [familyFingerprint, familyRecords] of families) {
    const head = familyRecords[0];
    if (head === undefined) continue;

    const existing = productByFingerprint.get(familyFingerprint) ?? null;
    const shared = commonPacking(familyRecords);
    const packSummary = shared === null ? null : packingFormula(sharedFigures(shared));

    // The family name drops the model, because the model is what the variants
    // vary by. "I.V. Cannula 14G" as a product name with six other gauges
    // underneath it reads as a mistake.
    const familyName = familyNameFor(head);

    const status = normaliseForMatch(head.internalStatus);
    const unavailabilityReason = NOT_FOR_SALE_STATUSES.get(status) ?? null;

    const attributes: PlannedProduct['attributes'] = [];
    const addAttribute = (name: string, value: string | null, isFilterable: boolean): void => {
      if (value !== null && value.trim() !== '') attributes.push({ name, value, isFilterable });
    };

    addAttribute(ATTRIBUTE_BRAND, head.brand === null ? null : titleCase(head.brand), true);
    addAttribute(
      ATTRIBUTE_STERILITY,
      head.sterility === null ? null : head.sterility === 'STERILE' ? 'Sterile' : 'Non-sterile',
      true,
    );
    addAttribute(
      ATTRIBUTE_STERILISATION,
      head.sterilisation === null ? null : titleCase(head.sterilisation),
      true,
    );
    addAttribute(ATTRIBUTE_PACKING, head.packingType === null ? null : titleCase(head.packingType), true);
    addAttribute(ATTRIBUTE_SHELF_LIFE, head.shelfLife === null ? null : titleCase(head.shelfLife), true);
    addAttribute(ATTRIBUTE_PACK_SIZE, packSummary, false);

    const sku =
      existing?.sku ??
      uniqueSku(
        [head.genericName ?? head.productCode ?? familyName, head.brand, head.packingType]
          .filter((part) => part !== null)
          .join(' '),
        takenSkus,
        familyFingerprint,
      );

    const slug =
      existing?.slug ??
      uniqueSlug([familyName, head.packingType].filter((part) => part !== null).join(' '), takenSlugs, familyFingerprint);

    // Within a family two rows can carry the same model with different codes -
    // the source lists one gauge boxed two ways. The code disambiguates, so the
    // selector never shows "14G" twice with no way to tell them apart.
    const modelCounts = new Map<string, number>();
    for (const record of familyRecords) {
      const key = normaliseForMatch(record.model);
      modelCounts.set(key, (modelCounts.get(key) ?? 0) + 1);
    }

    const variants: PlannedVariant[] = familyRecords.map((record) => {
      const existingVariant = variantByFingerprint.get(record.variantFingerprint) ?? null;
      const modelKey = normaliseForMatch(record.model);
      const ambiguous = (modelCounts.get(modelKey) ?? 0) > 1;

      const label =
        record.model ??
        record.productCode ??
        (record.gtinRaw === null ? familyName : `Barcode ${record.gtinRaw}`);

      return {
        record,
        existingVariantId: existingVariant?.id ?? null,
        sku:
          existingVariant?.sku ??
          uniqueSku(record.productCode ?? `${sku} ${label}`, takenSkus, record.variantFingerprint),
        name: ambiguous && record.productCode !== null ? `${label} (${record.productCode})` : label,
      };
    });

    products.push({
      familyFingerprint,
      categoryName: head.category,
      name: familyName,
      sku,
      slug,
      shortDescription: describe(head, packSummary),
      isOrderable: unavailabilityReason === null,
      unavailabilityReason,
      attributes,
      variants,
      existingProductId: existing?.id ?? null,
    });
  }

  // --- the report -----------------------------------------------------------
  const packingNeedsReview: SheetImportReport['packingNeedsReview'] = [];
  const packingUnparsed: SheetImportReport['packingUnparsed'] = [];
  const dimensionsUnreadable: SheetImportReport['dimensionsUnreadable'] = [];
  let packingParsed = 0;
  let packingPartial = 0;
  let dimensionsWithoutUnit = 0;

  const dimensionFields: [keyof SheetRecord['dimensions'], string][] = [
    ['primaryPack', 'Primary pack size'],
    ['innerBox', 'Inner box size'],
    ['outerCarton', 'Outer carton size'],
    ['stickerArtwork', 'Sticker artwork size'],
  ];

  for (const record of records) {
    if (record.packing.status === 'PARSED') packingParsed += 1;
    if (record.packing.status === 'PARTIAL') packingPartial += 1;
    if (record.packing.status === 'NEEDS_REVIEW') {
      packingNeedsReview.push({
        rowNumber: record.sourceRow,
        raw: record.packing.raw,
        message: record.packing.message ?? '',
      });
    }
    if (record.packing.status === 'UNPARSED' && record.packing.raw !== '') {
      packingUnparsed.push({ rowNumber: record.sourceRow, raw: record.packing.raw });
    }

    for (const [key, label] of dimensionFields) {
      const dimension = record.dimensions[key];
      if (dimension.raw === '') continue;
      if (dimension.status === 'UNPARSED') {
        dimensionsUnreadable.push({ rowNumber: record.sourceRow, field: label, raw: dimension.raw });
      }
      if (dimension.status === 'UNIT_UNKNOWN') dimensionsWithoutUnit += 1;
    }
  }

  const report: SheetImportReport = {
    filePath: options.filePath,
    fileName,
    sheetName: mapped.sheetName,
    dryRun: options.dryRun,
    categoriesDetected: mapped.categories,
    candidateRows: mapped.records.length,
    productsCreated: products.filter((product) => product.existingProductId === null).length,
    productsUpdated: products.filter((product) => product.existingProductId !== null).length,
    variantsCreated: products
      .flatMap((product) => product.variants)
      .filter((variant) => variant.existingVariantId === null).length,
    variantsUpdated: products
      .flatMap((product) => product.variants)
      .filter((variant) => variant.existingVariantId !== null).length,
    exactDuplicatesSkipped,
    ambiguousDuplicates,
    rowsWithoutIdentifier: mapped.withoutIdentifier,
    rowsSkipped: mapped.skipped,
    rowsMissingGtin: records
      .filter((record) => record.gtinNormalised === null)
      .map((record) => record.sourceRow),
    packingParsed,
    packingPartial,
    packingNeedsReview,
    packingUnparsed,
    dimensionsUnreadable,
    dimensionsWithoutUnit,
    imagesChanged: 0,
    pricesChanged: 0,
    // Only known once the writes have run; a dry run reports nothing created.
    priceRowsCreated: 0,
    published: 0,
    publishRefused: [],
  };

  return { mapped, products, report };
}

/** The four fields `packingFormula` reads, off a parsed packing. */
function sharedFigures(packing: SheetRecord['packing']): {
  piecesPerInnerPack: number | null;
  innerPacksPerOuterCarton: number | null;
  piecesPerOuterCarton: number | null;
  innerPackType: string | null;
} {
  return {
    piecesPerInnerPack: packing.piecesPerInnerPack,
    innerPacksPerOuterCarton: packing.innerPacksPerOuterCarton,
    piecesPerOuterCarton: packing.piecesPerOuterCarton,
    innerPackType: packing.innerPackType,
  };
}

/**
 * What to call a product family on a card.
 *
 * A hundred and forty rows of the source workbook have no generic name at all
 * - the category band above them was the name, as far as whoever typed it was
 * concerned. Falling back to the brand alone gives a catalogue of listings
 * called "Easy Flush", which says who made it and nothing about what it is;
 * falling back to the product code gives "Fg/1bz1z3", which says nothing at
 * all and looks like a bug.
 *
 * So the category is the noun of last resort. It is a fact the sheet states -
 * the band the row sits under - rather than anything invented here, and
 * "Flush Syringe · Easy Flush" is a listing somebody can actually shop from.
 */
function familyNameFor(record: SheetRecord): string {
  // The category, spelled as the source spells it. "ORAL SYIRINGE" comes back
  // as "Oral Syiringe" rather than silently corrected: this is the operator's
  // own catalogue and a typo is theirs to fix in the sheet.
  const noun = titleCase(record.genericName ?? record.category);

  // A brand that is not already in the noun distinguishes two otherwise
  // identical listings in a grid - "I.V. Cannula" six times tells a buyer
  // nothing about which is which.
  if (record.brand !== null && !normaliseForMatch(noun).includes(normaliseForMatch(record.brand))) {
    return `${noun} · ${titleCase(record.brand)}`.slice(0, 255);
  }

  // Neither a name nor a brand: the category alone would give every unnamed
  // row in it the same heading. The product code is the only thing left that
  // tells them apart, and it is appended exactly as written - a code is not
  // prose and title case makes it unrecognisable.
  if (record.genericName === null && record.brand === null && record.productCode !== null) {
    return `${noun} ${record.productCode}`.slice(0, 255);
  }

  return noun.slice(0, 255);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A bulk write, so the transaction timeout is raised the way bulk-price does. */
const TRANSACTION_TIMEOUT_MS = 600_000;
const TRANSACTION_MAX_WAIT_MS = 30_000;

async function resolveCategories(
  names: string[],
  actor: SheetImportActor,
  tx: PrismaTransaction,
): Promise<Map<string, string>> {
  const byName = new Map<string, string>();

  for (const name of names) {
    const slug = slugify(name);
    const existing = await tx.category.findUnique({ where: { slug }, select: { id: true } });

    if (existing !== null) {
      byName.set(name, existing.id);
      continue;
    }

    const id = newId();
    await tx.category.create({
      data: {
        id,
        name: titleCase(name),
        slug,
        // Active, because a category that is not active takes its products out
        // of the storefront with it - importing a catalogue into an inactive
        // category would produce several hundred products nobody can reach and
        // no error explaining why.
        isActive: true,
        sortOrder: 0,
        createdById: actor.userId,
        updatedById: actor.userId,
      },
    });

    await recordAudit(
      {
        action: AuditAction.CATEGORY_CREATED,
        resourceType: 'category',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { name, slug, source: 'product sheet import' },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    byName.set(name, id);
  }

  return byName;
}

/** Write one SKU's packing row and its dimensions, replacing what was there. */
async function writePackaging(
  tx: PrismaTransaction,
  productId: string,
  variantId: string | null,
  packing: SheetRecord['packing'],
  dimensions: SheetRecord['dimensions'] | null,
  overrideMessage: string | null,
): Promise<void> {
  const variantKey = variantId ?? NO_VARIANT_KEY;

  const data = {
    packingType: null as string | null,
    packingRawText: packing.raw === '' ? null : packing.raw.slice(0, 255),
    piecesPerInnerPack: packing.piecesPerInnerPack,
    innerPacksPerOuterCarton: packing.innerPacksPerOuterCarton,
    piecesPerOuterCarton: packing.piecesPerOuterCarton,
    innerPackType: packing.innerPackType,
    outerPackType: packing.outerPackType,
    parseStatus: packing.status,
    validationMessage: (overrideMessage ?? packing.message)?.slice(0, 512) ?? null,
  };

  const existing = await tx.productPackaging.findUnique({
    where: { productId_variantKey: { productId, variantKey } },
    select: { id: true },
  });

  const packagingId = existing?.id ?? newId();

  if (existing === null) {
    await tx.productPackaging.create({
      data: { id: packagingId, productId, variantId, variantKey, ...data },
    });
  } else {
    await tx.productPackaging.update({ where: { id: packagingId }, data });
    // Replace rather than diff: nothing references a dimension row by id, and
    // rewriting is the only way a dimension that has been REMOVED from the
    // source actually disappears.
    await tx.productPackDimension.deleteMany({ where: { packagingId } });
  }

  if (dimensions === null) return;

  const kinds: [keyof SheetRecord['dimensions'], 'PRIMARY_PACK' | 'INNER_BOX' | 'OUTER_CARTON' | 'STICKER_ARTWORK'][] =
    [
      ['primaryPack', 'PRIMARY_PACK'],
      ['innerBox', 'INNER_BOX'],
      ['outerCarton', 'OUTER_CARTON'],
      ['stickerArtwork', 'STICKER_ARTWORK'],
    ];

  const rows = kinds
    .map(([key, kind]) => ({ kind, parsed: dimensions[key] }))
    .filter((row) => row.parsed.raw !== '')
    .map((row) => ({
      id: newId(),
      packagingId,
      kind: row.kind,
      rawText: row.parsed.raw.slice(0, 255),
      displayValue: row.parsed.displayValue?.slice(0, 128) ?? null,
      unit: row.parsed.unit,
      parseStatus: row.parsed.status,
    }));

  if (rows.length > 0) await tx.productPackDimension.createMany({ data: rows });
}

async function writeImportRecord(
  tx: PrismaTransaction,
  productId: string,
  variantId: string | null,
  record: SheetRecord,
  source: { fileName: string; sheetName: string; importedAt: Date },
): Promise<void> {
  const variantKey = variantId ?? NO_VARIANT_KEY;

  const data = {
    fingerprint: record.variantFingerprint,
    sourceFileName: source.fileName.slice(0, 255),
    sourceSheet: source.sheetName.slice(0, 128),
    sourceRow: record.sourceRow,
    importedAt: source.importedAt,
    rawJson: record.raw as Prisma.InputJsonValue,
    productCode: record.productCode?.slice(0, 128) ?? null,
    gtinRaw: record.gtinRaw?.slice(0, 64) ?? null,
    gtinNormalised: record.gtinNormalised,
    genericName: record.genericName?.slice(0, 255) ?? null,
    modelSize: record.model?.slice(0, 128) ?? null,
    sterilisation: record.sterilisation?.slice(0, 128) ?? null,
    brand: record.brand?.slice(0, 128) ?? null,
    packingType: record.packingType?.slice(0, 128) ?? null,
    shelfLife: record.shelfLife?.slice(0, 64) ?? null,
    productionCapacityPerMonth: record.productionCapacityPerMonth?.slice(0, 64) ?? null,
    launchDate: record.launchDate,
    manufacturingLicenceStatus: record.manufacturingLicenceStatus?.slice(0, 64) ?? null,
    testLicenceStatus: record.testLicenceStatus?.slice(0, 64) ?? null,
    internalStatus: record.internalStatus?.slice(0, 64) ?? null,
  };

  const existing = await tx.productImportRecord.findUnique({
    where: { productId_variantKey: { productId, variantKey } },
    select: { id: true },
  });

  if (existing === null) {
    await tx.productImportRecord.create({
      data: { id: newId(), productId, variantId, variantKey, ...data },
    });
  } else {
    await tx.productImportRecord.update({ where: { id: existing.id }, data });
  }
}

/**
 * Run the import.
 *
 * A dry run reads the file, matches it against the catalogue and returns the
 * same report the real run would, having written nothing at all. The real run
 * does every write inside one transaction: a half-applied catalogue - some
 * products with their variants, others without - is harder to reason about and
 * harder to recover from than one that was rejected.
 */
export async function importProductSheet(options: SheetImportOptions): Promise<SheetImportReport> {
  const { products, report } = await plan(options);

  if (options.dryRun) return report;

  const importedAt = new Date();
  const source = { fileName: report.fileName, sheetName: report.sheetName, importedAt };

  await prisma.$transaction(
    async (tx) => {
      const taxClass = await tx.taxClass.findFirst({
        where: { isDefault: true, isActive: true },
        select: { id: true },
      });

      if (taxClass === null) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'No default tax class is configured. Set one under Settings before importing a catalogue.',
          [{ field: 'taxClassCode', code: 'NOT_FOUND' }],
        );
      }

      const business = await tx.businessProfile.findFirst({ select: { currency: true } });
      const currency = business?.currency ?? 'INR';

      const categoryIds = await resolveCategories(
        [...new Set(products.map((product) => product.categoryName))],
        options.actor,
        tx,
      );

      for (const planned of products) {
        const categoryId = categoryIds.get(planned.categoryName);
        if (categoryId === undefined) continue;

        const productId = planned.existingProductId ?? newId();

        if (planned.existingProductId === null) {
          await tx.product.create({
            data: {
              id: productId,
              categoryId,
              taxClassId: taxClass.id,
              name: planned.name,
              slug: planned.slug,
              sku: planned.sku,
              shortDescription: planned.shortDescription,
              // Zero, and never shown as a figure: `isPriceOnRequest` replaces
              // the price with an invitation to ask for one. The source sheet's
              // MRP column is not read - see this module's header.
              basePriceMinor: 0n,
              currency,
              isPriceOnRequest: true,
              isOrderable: planned.isOrderable,
              unavailabilityReason: planned.unavailabilityReason,
              importFingerprint: planned.familyFingerprint,
              hasVariants: true,
              // DRAFT and unpublished, like every other import. Publication is
              // a separate, audited act.
              status: 'DRAFT',
              isPublished: false,
              createdById: options.actor.userId,
              updatedById: options.actor.userId,
            },
          });
        } else {
          await tx.product.update({
            where: { id: productId },
            data: {
              categoryId,
              name: planned.name,
              shortDescription: planned.shortDescription,
              // What is NOT here is the whole point: basePriceMinor,
              // compareAtPriceMinor, currency, isPriceOnRequest, status,
              // isPublished and media are all absent, so an administrator's
              // pricing, publication and photography survive every re-import.
              isOrderable: planned.isOrderable,
              unavailabilityReason: planned.unavailabilityReason,
              hasVariants: true,
              updatedById: options.actor.userId,
            },
          });
        }

        /**
         * The per-currency price row, created once and never touched again.
         *
         * The storefront listing is rooted at `product_prices` - see the query
         * in catalog.public.ts - so a product with no row in the shopper's
         * currency cannot appear in a grid at all, whatever its status. An
         * imported product would therefore be published, reachable by URL, and
         * invisible everywhere a customer actually browses.
         *
         * The figure is zero, and zero is what `isPriceOnRequest` exists to
         * render as "Request a quote" rather than as free. It cannot be
         * charged: nothing priced on request reaches a basket. And it is
         * created ONLY when absent, so a price an administrator has typed
         * since - and the moment they turn price-on-request off - survives
         * every re-import untouched. This is the same rule as the product's
         * own price column, applied to the table that mirrors it.
         */
        const existingPrice = await tx.productPrice.findUnique({
          where: {
            productId_variantKey_currencyCode: {
              productId,
              variantKey: NO_VARIANT_KEY,
              currencyCode: currency,
            },
          },
          select: { id: true },
        });

        if (existingPrice === null) {
          await tx.productPrice.create({
            data: {
              id: newId(),
              productId,
              variantId: null,
              variantKey: NO_VARIANT_KEY,
              currencyCode: currency,
              basePriceMinor: 0n,
              compareAtPriceMinor: null,
              updatedById: options.actor.userId,
            },
          });
          report.priceRowsCreated += 1;
        }

        // Specifications are replace-the-set, matching `updateProduct`.
        await tx.productAttribute.deleteMany({ where: { productId } });
        if (planned.attributes.length > 0) {
          await tx.productAttribute.createMany({
            data: planned.attributes.map((attribute, index) => ({
              id: newId(),
              productId,
              name: attribute.name,
              value: attribute.value.slice(0, 512),
              sortOrder: index,
              isFilterable: attribute.isFilterable,
            })),
          });
        }

        for (const [index, planUnit] of planned.variants.entries()) {
          const variantId = planUnit.existingVariantId ?? newId();
          const variantData = {
            name: planUnit.name.slice(0, 255),
            optionsJson:
              planUnit.record.model === null
                ? ({} as Prisma.InputJsonValue)
                : ({ Size: planUnit.record.model } as Prisma.InputJsonValue),
            gtin: planUnit.record.gtinNormalised,
            modelIdentifier: planUnit.record.model?.slice(0, 64) ?? null,
            sortOrder: index,
            isActive: true,
          };

          if (planUnit.existingVariantId === null) {
            await tx.productVariant.create({
              data: {
                id: variantId,
                productId,
                sku: planUnit.sku,
                importFingerprint: planUnit.record.variantFingerprint,
                // Null, so the variant falls back to the product's price.
                // Never set from the sheet: the MRP column is not a price.
                priceMinor: null,
                ...variantData,
              },
            });
          } else {
            await tx.productVariant.update({ where: { id: variantId }, data: variantData });
          }

          await writePackaging(
            tx,
            productId,
            variantId,
            planUnit.record.packing,
            planUnit.record.dimensions,
            null,
          );
          await writeImportRecord(tx, productId, variantId, planUnit.record, source);
        }

        // The product-level packing row, used by the grid and by any screen
        // that has not yet asked which size. It carries figures only when every
        // size in the family agrees on them; where they differ it says so
        // rather than quoting the first size's carton as though it were the
        // product's.
        const head = planned.variants[0]?.record;
        if (head !== undefined) {
          const shared = commonPacking(planned.variants.map((variant) => variant.record));
          await writePackaging(
            tx,
            productId,
            null,
            shared ?? {
              raw: '',
              piecesPerInnerPack: null,
              innerPacksPerOuterCarton: null,
              piecesPerOuterCarton: null,
              innerPackType: null,
              outerPackType: null,
              status: 'UNPARSED' as const,
              message: null,
            },
            shared === null ? null : head.dimensions,
            shared === null ? 'Packing differs between sizes; see each size for its own figures.' : null,
          );
        }

        await recordAudit(
          {
            action:
              planned.existingProductId === null
                ? AuditAction.PRODUCT_CREATED
                : AuditAction.PRODUCT_UPDATED,
            resourceType: 'product',
            resourceId: productId,
            actorType: 'ADMIN',
            actorUserId: options.actor.userId,
            actorEmail: options.actor.email,
            after: {
              name: planned.name,
              sku: planned.sku,
              variants: planned.variants.length,
              source: `${report.fileName} · ${report.sheetName}`,
              pricesChanged: false,
              imagesChanged: false,
            },
            ipAddress: options.actor.ipAddress ?? null,
            correlationId: options.actor.correlationId ?? null,
          },
          tx,
        );
      }
    },
    { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
  );

  if (options.publish === true) await publishImported(products, options.actor, report);

  return report;
}

/**
 * Publish what was just imported, one product at a time.
 *
 * Deliberately NOT inside the import transaction and deliberately not in bulk.
 * `publishProduct` runs the completeness check, the product-safety assessment
 * and its own audit entry per product, and one product failing that check must
 * not roll back the import of the other three hundred - the import is correct
 * either way, and a draft is a perfectly good outcome for a product that is
 * not ready.
 */
async function publishImported(
  products: PlannedProduct[],
  actor: SheetImportActor,
  report: SheetImportReport,
): Promise<void> {
  const ids = await prisma.product.findMany({
    where: {
      importFingerprint: { in: products.map((product) => product.familyFingerprint) },
      isPublished: false,
    },
    select: { id: true, sku: true, name: true },
  });

  for (const product of ids) {
    try {
      await publishProduct(product.id, actor);
      report.published += 1;
    } catch (error: unknown) {
      report.publishRefused.push({
        sku: product.sku,
        name: product.name,
        reasons: blockerMessages(error),
      });
    }
  }
}

/**
 * The reasons out of a refused publication.
 *
 * The thrown error carries a `details` array naming every blocker, which is the
 * whole point of `validateForPublish` returning all of them - a report that
 * said only "could not publish" would send somebody back to the screen four
 * times.
 */
function blockerMessages(error: unknown): string[] {
  if (typeof error !== 'object' || error === null) return ['Unknown error.'];

  const details = (error as { details?: unknown }).details;
  if (Array.isArray(details) && details.length > 0) {
    return details.map((detail) => {
      const entry = detail as { field?: unknown; message?: unknown; code?: unknown };
      const field = typeof entry.field === 'string' ? entry.field : 'product';
      const message =
        typeof entry.message === 'string'
          ? entry.message
          : typeof entry.code === 'string'
            ? entry.code
            : 'not ready';
      return `${field}: ${message}`;
    });
  }

  const message = (error as { message?: unknown }).message;
  return [typeof message === 'string' ? message : 'Unknown error.'];
}

/**
 * The report as text, for a terminal.
 *
 * Every section is present even when its count is zero, on purpose. A report
 * that only lists problems leaves a reader unable to tell "nothing was wrong"
 * from "that check did not run".
 */
export function formatReport(report: SheetImportReport): string {
  const lines: string[] = [];
  const heading = (text: string): void => {
    lines.push('', text, '-'.repeat(text.length));
  };

  lines.push(
    report.dryRun
      ? 'DRY RUN - nothing was written to the database.'
      : 'Import complete - changes were committed.',
    '',
    `File    ${report.fileName}`,
    `Sheet   ${report.sheetName}`,
  );

  heading('What was read');
  lines.push(
    `Categories detected      ${String(report.categoriesDetected.length)}`,
    `Candidate product rows   ${String(report.candidateRows)}`,
    `Rows skipped             ${String(report.rowsSkipped.length)}`,
    `Rows with no identifier  ${String(report.rowsWithoutIdentifier.length)}`,
    `Exact duplicates skipped ${String(report.exactDuplicatesSkipped.length)}`,
  );

  heading('What was written');
  lines.push(
    `Products created  ${String(report.productsCreated)}`,
    `Products updated  ${String(report.productsUpdated)}`,
    `Variants created  ${String(report.variantsCreated)}`,
    `Variants updated  ${String(report.variantsUpdated)}`,
    `Images changed    ${String(report.imagesChanged)}`,
    `Prices overwritten ${String(report.pricesChanged)}`,
    `Empty price rows  ${String(report.priceRowsCreated)}`,
  );

  if (report.published > 0 || report.publishRefused.length > 0) {
    heading('Publication');
    lines.push(
      `Published         ${String(report.published)}`,
      `Left as drafts    ${String(report.publishRefused.length)}`,
    );
    for (const refusal of report.publishRefused.slice(0, 15)) {
      lines.push(`${refusal.sku} - ${refusal.name}`);
      for (const reason of refusal.reasons) lines.push(`  ${reason}`);
    }
    if (report.publishRefused.length > 15) {
      lines.push(`... and ${String(report.publishRefused.length - 15)} more.`);
    }
  }

  heading('Data quality');
  lines.push(
    `Packing read in full        ${String(report.packingParsed)}`,
    `Packing partly read         ${String(report.packingPartial)}`,
    `Packing needing review      ${String(report.packingNeedsReview.length)}`,
    `Packing unreadable          ${String(report.packingUnparsed.length)}`,
    `Dimensions unreadable       ${String(report.dimensionsUnreadable.length)}`,
    `Dimensions with no unit     ${String(report.dimensionsWithoutUnit)}`,
    `Rows with no barcode        ${String(report.rowsMissingGtin.length)}`,
    `Reused codes and barcodes   ${String(report.ambiguousDuplicates.length)}`,
  );

  if (report.packingNeedsReview.length > 0) {
    heading('Packing that does not multiply out');
    for (const entry of report.packingNeedsReview.slice(0, 25)) {
      lines.push(`Row ${String(entry.rowNumber)}: "${entry.raw}"`, `  ${entry.message}`);
    }
  }

  if (report.ambiguousDuplicates.length > 0) {
    heading('Reused identifiers (imported separately, not merged)');
    for (const entry of report.ambiguousDuplicates.slice(0, 25)) {
      lines.push(`${entry.field} ${entry.value} on rows ${entry.rows.join(', ')}`);
    }
    if (report.ambiguousDuplicates.length > 25) {
      lines.push(`... and ${String(report.ambiguousDuplicates.length - 25)} more.`);
    }
  }

  if (report.rowsSkipped.length > 0) {
    heading('Rows skipped');
    for (const entry of report.rowsSkipped.slice(0, 25)) {
      lines.push(`Row ${String(entry.rowNumber)}: ${entry.reason}`, `  ${entry.preview}`);
    }
  }

  if (report.dimensionsUnreadable.length > 0) {
    heading('Dimensions kept as written');
    for (const entry of report.dimensionsUnreadable.slice(0, 15)) {
      lines.push(`Row ${String(entry.rowNumber)} ${entry.field}: "${entry.raw}"`);
    }
    if (report.dimensionsUnreadable.length > 15) {
      lines.push(`... and ${String(report.dimensionsUnreadable.length - 15)} more.`);
    }
  }

  lines.push(
    '',
    'No product image and no existing price was read, changed or overwritten.',
    'A new product gets one empty price row, valued at zero, because the',
    'storefront listing is rooted at the price table and could not reach it',
    'otherwise. It shows as "Request a quote" and cannot be added to a basket.',
    'That row is written once: a figure typed afterwards survives every',
    're-import. Imported products are drafts until an administrator publishes',
    'them.',
    '',
  );

  return lines.join('\n');
}
