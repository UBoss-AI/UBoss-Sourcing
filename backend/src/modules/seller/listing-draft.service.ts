/**
 * The listing wizard's engine: create a draft, autosave it, validate it,
 * preview its title, submit it for review.
 *
 * A draft is NOT a product. It is the seller's working copy and it is allowed
 * to be invalid, half-finished and contradictory for as long as they need it
 * to be. A `Product` row appears only when a moderator approves, which is what
 * stops an abandoned wizard from leaving an unpublishable product in the
 * catalogue forever.
 *
 * Two rules run through everything here:
 *
 *   1. **Completeness is computed server-side, every save.** The counters the
 *      seller watches ("Product Description 8/8") and the gate on the submit
 *      button come from one call to `evaluateListing`. The browser counts
 *      nothing - it cannot, since the field list is a database row it only ever
 *      sees a filtered copy of.
 *
 *   2. **Every refusal names a field.** A blocked submit that says "validation
 *      failed" is a dead end on a form with sixty inputs across five sections.
 *      Issues carry a section and an attribute key, and the wizard puts each
 *      one beside the input that caused it.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  evaluatePackHierarchy,
  evaluatePriceTiers,
  evaluateListing,
  type ListingIssue,
  type SectionSummary,
} from '../../domain/listing-completeness.js';
import { generateTitle, type TitleResult } from '../../domain/listing-title.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  LISTING_EDITABLE_STATUSES,
  assertListingTransition,
  type ListingDraftStatusName,
} from '../../domain/seller-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import { isBrandApprovedForSeller } from './brand.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  assertSellerTrading,
  type SellerMembership,
} from './account.service.js';
import {
  isRegulatedCategory,
  loadListingSchema,
  titleComponents,
  type ListingSchema,
} from './listing-schema.service.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** The commercial half of a draft. Survives into `SellerOffer` unchanged. */
export interface DraftOffer {
  sellerSku?: string | null;
  priceMinor?: string | null;
  currency?: string | null;
  compareAtPriceMinor?: string | null;
  taxClassId?: string | null;
  orderingUnit?: string | null;
  minimumOrderQuantity?: number | null;
  orderIncrement?: number | null;
  maximumOrderQuantity?: number | null;
  handlingTimeDays?: number | null;
  guaranteedShelfLifeMonths?: number | null;
  warrantyMonths?: number | null;
  sellingRegions?: string[] | null;
  priceTiers?: { minQuantity: number; priceMinor: string }[] | null;
}

export interface DraftStock {
  locationId: string;
  availableQuantity: number;
  reorderThreshold?: number | null;
  batchNumber?: string | null;
  expiresOn?: string | null;
}

export interface DraftPackaging {
  baseUnit?: string | null;
  unitsPerPack?: number | null;
  packsPerBox?: number | null;
  boxesPerCarton?: number | null;
  cartonsPerPallet?: number | null;
  statedTotalUnits?: number | null;
  netWeightGrams?: number | null;
  grossWeightGrams?: number | null;
}

export interface DraftPatch {
  categoryId?: string | null;
  brandId?: string | null;
  matchedProductId?: string | null;
  sellerSku?: string | null;
  attributes?: Record<string, unknown> | null;
  offer?: DraftOffer | null;
  stock?: DraftStock[] | null;
  packaging?: DraftPackaging | null;
  sellerEditedTitle?: string | null;
}

export interface DraftView {
  id: string;
  status: ListingDraftStatusName;
  categoryId: string | null;
  brandId: string | null;
  brandName: string | null;
  matchedProductId: string | null;
  sellerSku: string | null;
  attributes: Record<string, unknown>;
  offer: DraftOffer;
  stock: DraftStock[];
  packaging: DraftPackaging;
  generatedTitle: string | null;
  sellerEditedTitle: string | null;
  sections: SectionSummary[];
  issues: ListingIssue[];
  isSubmittable: boolean;
  /** Whether "Preview title" should be pressable. */
  canPreviewTitle: boolean;
  reviewComment: string | null;
  version: number;
  updatedAt: string;
  media: {
    id: string;
    slot: string;
    altText: string | null;
    isPrimary: boolean;
    uploaded: boolean;
    rejectionCode: string | null;
    sortOrder: number;
  }[];
  schema: ListingSchema | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * A money string from the wire, as minor units.
 *
 * Strings, not numbers, and that is the rule the whole codebase follows: a
 * price in paise crosses JavaScript's safe integer range for figures a
 * wholesaler genuinely quotes, and `JSON.parse` would have already lost the
 * last digits before any validation could catch it.
 */
function parseMinor(value: string | null | undefined, field: string): bigint | null {
  if (value === null || value === undefined || value === '') return null;

  if (!/^-?\d+$/.test(value)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Amounts must be whole minor units.', [
      { field, code: 'NOT_MINOR_UNITS' },
    ]);
  }

  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function loadDraftRow(membership: SellerMembership, draftId: string) {
  const row = await prisma.sellerListingDraft.findUnique({
    where: { id: draftId },
    include: {
      media: { orderBy: { sortOrder: 'asc' } },
      brand: { select: { id: true, name: true, status: true } },
    },
  });

  if (row === null) throw notFound('Listing');

  // Tenant check before anything else is read off the row. Throws 404 rather
  // than 403 - see `assertSellerOwnership`.
  assertSellerOwnership(membership, row.sellerAccountId, 'Listing');

  return row;
}

/**
 * Evaluate a draft against its category schema.
 *
 * Everything the wizard renders below the stepper comes from here: the section
 * counters, the issues, whether submit is live, and whether the title can be
 * previewed yet.
 */
async function evaluateDraft(
  row: Awaited<ReturnType<typeof loadDraftRow>>,
): Promise<{
  schema: ListingSchema | null;
  sections: SectionSummary[];
  issues: ListingIssue[];
  isSubmittable: boolean;
  title: TitleResult | null;
}> {
  if (row.categoryId === null) {
    // No category chosen yet. Not an error - it is step one of the wizard, and
    // the seller is looking at the category picker rather than the form.
    return { schema: null, sections: [], issues: [], isSubmittable: false, title: null };
  }

  const schema = await loadListingSchema(row.categoryId);
  const attributes = asRecord(row.attributesJson);
  const offer = asRecord(row.offerJson) as DraftOffer;
  const stock = asArray<DraftStock>(row.stockJson);
  const packaging = asRecord(row.packagingJson) as DraftPackaging;

  const priceMinor = parseMinor(offer.priceMinor ?? null, 'offer.priceMinor');

  const result = evaluateListing({
    definitions: schema.attributes,
    values: attributes,
    mediaSlots: schema.mediaSlots,
    media: row.media.map((item) => ({
      slot: item.slot,
      uploaded: item.uploadedAt !== null,
      rejectionCode: item.rejectionCode,
    })),
    isRegulatedDevice: isRegulatedCategory(schema),
    hasPrice:
      priceMinor !== null &&
      priceMinor > 0n &&
      typeof offer.currency === 'string' &&
      offer.currency.length === 3,
    hasStock: stock.some((entry) => entry.availableQuantity > 0),
  });

  const issues = [...result.issues];

  // The pack hierarchy and the price bands are checked separately because they
  // are arithmetic over several fields rather than a value against a
  // definition. Both produce issues tied to a field, so they merge straight in.
  issues.push(...evaluatePackHierarchy(packaging).issues);

  if (priceMinor !== null && Array.isArray(offer.priceTiers)) {
    issues.push(
      ...evaluatePriceTiers(
        priceMinor,
        offer.priceTiers.map((tier) => ({
          minQuantity: tier.minQuantity,
          priceMinor: parseMinor(tier.priceMinor, 'offer.priceTiers') ?? 0n,
        })),
      ),
    );
  }

  /*
   * The brand gate, and it asks TWO questions rather than one.
   *
   * "Is this brand in the catalogue" is about the name. "Is this seller allowed
   * to sell it" is about the company, and the two have different answers all
   * the time: a brand approved for one distributor's request is an approved
   * brand, and that says nothing about whether a second business may list under
   * it. Checking only the first is how somebody ends up publishing another
   * company's products under a name nobody authorised them for.
   *
   * Both block publication and neither blocks drafting - a seller waiting on a
   * brand request should be able to finish everything else in the meantime
   * rather than being stopped at step two.
   */
  if (row.brand !== null && row.brand.status !== 'APPROVED') {
    issues.push({
      severity: 'BLOCKER',
      code: 'BRAND_NOT_APPROVED',
      section: 'PRODUCT_DESCRIPTION',
      attributeKey: 'brand',
      message:
        row.brand.status === 'PENDING'
          ? `${row.brand.name} is still being reviewed. You can finish the rest of this listing while you wait.`
          : `${row.brand.name} cannot be used on a published listing.`,
    });
  } else if (row.brand !== null && !(await isBrandApprovedForSeller(row.sellerAccountId, row.brand.id))) {
    issues.push({
      severity: 'BLOCKER',
      code: 'BRAND_NOT_APPROVED',
      section: 'PRODUCT_DESCRIPTION',
      attributeKey: 'brand',
      message:
        `${row.brand.name} is in the catalogue, but your business has not been approved to sell ` +
        'it yet. Ask for it from the brand step and tell us why you are entitled to.',
    });
  }

  const title = generateTitle({
    components: titleComponents(schema),
    values: attributes,
    brandName: row.brand?.name ?? null,
  });

  return {
    schema,
    sections: result.sections,
    issues,
    isSubmittable: !issues.some((issue) => issue.severity === 'BLOCKER'),
    title,
  };
}

/**
 * A moderator's own comments, as the seller must see them.
 *
 * `evaluateDraft` recomputes issues from the schema every time, so it can only
 * ever produce the ones the machine can work out. A moderator's comment is not
 * one of those - it is a sentence somebody wrote about this listing, stored on
 * `SellerListingIssue` with `isFromModerator`, and `refreshDraftState`
 * deliberately refuses to delete it when the seller saves.
 *
 * Kept OUT of `evaluateDraft` on purpose. That function's result is what
 * `refreshDraftState` writes back to the table as the machine's own issues, and
 * merging a moderator's comment into it would re-insert their sentence as the
 * machine's on the seller's next keystroke - duplicated, and then deleted by
 * the save after that.
 */
async function moderatorIssues(draftId: string): Promise<ListingIssue[]> {
  const rows = await prisma.sellerListingIssue.findMany({
    where: { draftId, isFromModerator: true, resolvedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  return rows.map((row) => ({
    severity: row.severity,
    code: row.code,
    section: row.section,
    attributeKey: row.attributeKey,
    message: row.message,
  }));
}

function toView(
  row: Awaited<ReturnType<typeof loadDraftRow>>,
  evaluation: Awaited<ReturnType<typeof evaluateDraft>>,
  /**
   * What the marketplace said, beside the field it said it about.
   *
   * Passed in rather than looked up here, because this function is the one
   * place the whole wizard is assembled and it stays synchronous.
   */
  fromModerator: ListingIssue[] = [],
): DraftView {
  return {
    id: row.id,
    status: row.status,
    categoryId: row.categoryId,
    brandId: row.brandId,
    brandName: row.brand?.name ?? null,
    matchedProductId: row.matchedProductId,
    sellerSku: row.sellerSku,
    attributes: asRecord(row.attributesJson),
    offer: asRecord(row.offerJson),
    stock: asArray<DraftStock>(row.stockJson),
    packaging: asRecord(row.packagingJson),
    generatedTitle: row.generatedTitle,
    sellerEditedTitle: row.sellerEditedTitle,
    sections: evaluation.sections,
    // A moderator's comments first: they are the reason the listing came back,
    // and the machine's own findings are the routine half of the list.
    issues: [...fromModerator, ...evaluation.issues],
    isSubmittable: evaluation.isSubmittable,
    canPreviewTitle: evaluation.title?.ready === true,
    reviewComment: row.reviewComment,
    version: row.version,
    updatedAt: row.updatedAt.toISOString(),
    media: row.media.map((item) => ({
      id: item.id,
      slot: item.slot,
      altText: item.altText,
      isPrimary: item.isPrimary,
      uploaded: item.uploadedAt !== null,
      rejectionCode: item.rejectionCode,
      sortOrder: item.sortOrder,
    })),
    schema: evaluation.schema,
  };
}

export async function readDraft(
  membership: SellerMembership,
  draftId: string,
): Promise<DraftView> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const row = await loadDraftRow(membership, draftId);
  return toView(row, await evaluateDraft(row), await moderatorIssues(draftId));
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export async function createDraft(
  membership: SellerMembership,
  input: { categoryId?: string | null; brandId?: string | null; matchedProductId?: string | null },
  correlationId?: string | null,
): Promise<DraftView> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);
  // Drafting needs an approved account. A seller mid-application can browse the
  // Hub but cannot start describing products, because nothing they wrote could
  // be published and the work would be wasted.
  assertSellerTrading(membership);

  const id = newId();

  await prisma.sellerListingDraft.create({
    data: {
      id,
      sellerAccountId: membership.sellerAccountId,
      status: 'DRAFT',
      categoryId: input.categoryId ?? null,
      brandId: input.brandId ?? null,
      matchedProductId: input.matchedProductId ?? null,
      attributesJson: {},
      offerJson: {},
      stockJson: [],
      packagingJson: {},
      createdByProfileId: membership.customerProfileId,
    },
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.created',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_listing_draft',
    resourceId: id,
    summary: 'A new listing was started.',
    correlationId: correlationId ?? null,
  });

  return readDraft(membership, id);
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export interface SaveDraftInput {
  membership: SellerMembership;
  draftId: string;
  patch: DraftPatch;
  /**
   * The version the client last read.
   *
   * The wizard autosaves from a tab that may have been open for an hour, and
   * sellers routinely have two open. Without this, the second tab's autosave
   * silently reverts the first tab's work, and neither the seller nor the
   * server can tell it happened.
   */
  expectedVersion?: number | null;
  correlationId?: string | null;
}

/**
 * Merge a patch into a draft and re-evaluate it.
 *
 * `attributes` merges key by key rather than replacing wholesale, because the
 * wizard saves one SECTION at a time - the reference screens have an Edit/Save
 * pair per section - and a whole-object replace from the Description section
 * would wipe everything the seller typed under Compliance.
 */
export async function saveDraft(input: SaveDraftInput): Promise<DraftView> {
  const { membership, draftId, patch } = input;

  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const existing = await loadDraftRow(membership, draftId);

  if (!LISTING_EDITABLE_STATUSES.includes(existing.status)) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      existing.status === 'PENDING_REVIEW'
        ? 'This listing is with the marketplace for review and cannot be changed right now.'
        : 'This listing can no longer be edited.',
    );
  }

  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== null &&
    existing.version !== input.expectedVersion
  ) {
    throw conflict(
      ErrorCode.SELLER_STALE_VERSION,
      'This listing was saved in another tab since you opened it. Reload to see the newer version.',
    );
  }

  // A SKU is unique per seller across drafts AND live offers. Checked here
  // rather than only at submission, because a seller who finds out at the last
  // step has already typed everything else against the wrong code.
  const sku = patch.sellerSku?.trim() ?? null;
  if (sku !== null && sku.length > 0 && sku !== existing.sellerSku) {
    const [clashingOffer, clashingDraft] = await Promise.all([
      prisma.sellerOffer.findFirst({
        where: { sellerAccountId: membership.sellerAccountId, sellerSku: sku, archivedAt: null },
        select: { id: true },
      }),
      prisma.sellerListingDraft.findFirst({
        where: {
          sellerAccountId: membership.sellerAccountId,
          sellerSku: sku,
          id: { not: draftId },
          status: { notIn: ['ARCHIVED', 'REJECTED'] },
        },
        select: { id: true },
      }),
    ]);

    if (clashingOffer !== null || clashingDraft !== null) {
      throw conflict(
        ErrorCode.SELLER_SKU_ALREADY_EXISTS,
        `You already use the code ${sku} on another listing.`,
        [{ field: 'sellerSku', code: 'DUPLICATE' }],
      );
    }
  }

  const mergedAttributes = {
    ...asRecord(existing.attributesJson),
    ...(patch.attributes ?? {}),
  };

  const mergedOffer = { ...asRecord(existing.offerJson), ...(patch.offer ?? {}) };
  const mergedPackaging = { ...asRecord(existing.packagingJson), ...(patch.packaging ?? {}) };

  // Changing the category invalidates the attributes, because they were
  // validated against a different schema. Kept rather than cleared - a seller
  // who picked the wrong category and corrected it should not lose the eight
  // fields the two categories have in common - and the re-evaluation below is
  // what flags anything that no longer fits.
  const nextCategoryId = patch.categoryId === undefined ? existing.categoryId : patch.categoryId;

  await prisma.sellerListingDraft.update({
    where: { id: draftId },
    data: {
      categoryId: nextCategoryId,
      ...(patch.brandId === undefined ? {} : { brandId: patch.brandId }),
      ...(patch.matchedProductId === undefined
        ? {}
        : { matchedProductId: patch.matchedProductId }),
      ...(sku === null ? {} : { sellerSku: sku }),
      attributesJson: mergedAttributes as never,
      offerJson: mergedOffer as never,
      packagingJson: mergedPackaging as never,
      ...(patch.stock === undefined || patch.stock === null
        ? {}
        : { stockJson: patch.stock as never }),
      ...(patch.sellerEditedTitle === undefined
        ? {}
        : { sellerEditedTitle: patch.sellerEditedTitle }),
      version: { increment: 1 },
    },
  });

  return refreshDraftState(membership, draftId, input.correlationId ?? null);
}

/**
 * Re-run the checks and move the draft's status to match.
 *
 * The status follows the checks rather than being chosen: DRAFT while it is
 * incomplete, READY_FOR_SUBMISSION once everything passes, VALIDATION_FAILED
 * once a submit attempt has failed. A seller cannot set READY_FOR_SUBMISSION
 * themselves - see `seller-state.ts` - precisely so that the submit button's
 * availability is a fact about the listing rather than a claim about it.
 */
async function refreshDraftState(
  membership: SellerMembership,
  draftId: string,
  correlationId: string | null,
): Promise<DraftView> {
  const row = await loadDraftRow(membership, draftId);
  const evaluation = await evaluateDraft(row);
  const from = row.status;

  // Issues are replaced wholesale on every evaluation, except a moderator's:
  // those are theirs to resolve, and clearing them because the seller changed
  // an unrelated field would lose the reviewer's comment.
  await prisma.$transaction(async (tx) => {
    await tx.sellerListingIssue.deleteMany({ where: { draftId, isFromModerator: false } });

    if (evaluation.issues.length > 0) {
      await tx.sellerListingIssue.createMany({
        data: evaluation.issues.map((issue) => ({
          id: newId(),
          draftId,
          severity: issue.severity,
          code: issue.code,
          section: issue.section,
          attributeKey: issue.attributeKey,
          message: issue.message.slice(0, 512),
        })),
      });
    }

    const sectionState = Object.fromEntries(
      evaluation.sections.map((section) => [
        section.section,
        {
          completed: section.completed,
          total: section.total,
          required: section.required,
          state: section.state,
        },
      ]),
    );

    const to: ListingDraftStatusName = evaluation.isSubmittable
      ? 'READY_FOR_SUBMISSION'
      : from === 'VALIDATION_FAILED'
        ? 'VALIDATION_FAILED'
        : 'DRAFT';

    const title = evaluation.title;

    await tx.sellerListingDraft.update({
      where: { id: draftId },
      data: {
        sectionStateJson: sectionState as never,
        generatedTitle: title?.ready === true ? title.title : null,
        generatedTitleSource:
          title?.ready === true ? (title.contributions as never) : undefined,
        ...(to === from
          ? {}
          : (assertListingTransition({ from, to, actor: 'SYSTEM' }), { status: to })),
      },
    });
  });

  const refreshed = await loadDraftRow(membership, draftId);

  if (correlationId !== null) {
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.listing.saved',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_listing_draft',
      resourceId: draftId,
      summary: 'Listing details were saved.',
      correlationId,
    });
  }

  return toView(refreshed, await evaluateDraft(refreshed), await moderatorIssues(draftId));
}

/** Run the checks without saving. What the "Validate listing" button calls. */
export async function validateDraft(
  membership: SellerMembership,
  draftId: string,
): Promise<DraftView> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);
  return refreshDraftState(membership, draftId, null);
}

// ---------------------------------------------------------------------------
// The title
// ---------------------------------------------------------------------------

export interface TitlePreview {
  ready: boolean;
  title: string | null;
  contributions: { attributeKey: string; label: string; text: string }[];
  blockedBy: { attributeKey: string; label: string; reason: string }[];
  /** Whether this deployment lets sellers type their own. */
  isEditable: boolean;
}

/**
 * What the title will be, and which fields made it.
 *
 * The contributions are the part that matters. A seller who cannot edit the
 * title and cannot see why it says "Medium" has no way to change it; showing
 * which field produced each fragment turns "the title is wrong" into "the size
 * field is wrong", which they can fix.
 */
export async function previewTitle(
  membership: SellerMembership,
  draftId: string,
): Promise<TitlePreview> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const row = await loadDraftRow(membership, draftId);

  if (row.categoryId === null) {
    throw conflict(
      ErrorCode.LISTING_TITLE_NOT_READY,
      'Choose a category before previewing the title.',
    );
  }

  const schema = await loadListingSchema(row.categoryId);
  const result = generateTitle({
    components: titleComponents(schema),
    values: asRecord(row.attributesJson),
    brandName: row.brand?.name ?? null,
  });

  const setting = await prisma.featureFlag.findFirst({
    where: { key: 'seller.allowSellerEditedTitles' },
    select: { enabled: true },
  });

  if (!result.ready) {
    return {
      ready: false,
      title: null,
      contributions: [],
      blockedBy: result.blockedBy,
      isEditable: setting?.enabled ?? false,
    };
  }

  return {
    ready: true,
    title: result.title,
    contributions: result.contributions,
    blockedBy: [],
    isEditable: setting?.enabled ?? false,
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

/**
 * Send a listing to quality review.
 *
 * Refuses with one detail per blocking issue, each carrying its section and
 * attribute key so the wizard can say "three things are stopping this" and
 * scroll to each. Submission creates PENDING_REVIEW and never a public
 * listing - the only path to a buyable offer is a moderator approving it.
 */
export async function submitDraft(
  membership: SellerMembership,
  draftId: string,
  correlationId?: string | null,
): Promise<DraftView> {
  assertSellerPermission(membership, SellerPermission.LISTING_SUBMIT);
  assertSellerTrading(membership);

  // Re-run rather than trusting the stored status: the stored one was computed
  // when the seller last saved, and stock, a brand decision or a certificate
  // may have changed since.
  const evaluated = await refreshDraftState(membership, draftId, null);

  if (!evaluated.isSubmittable) {
    const blockers = evaluated.issues.filter((issue) => issue.severity === 'BLOCKER');

    await prisma.sellerListingDraft.update({
      where: { id: draftId },
      data: { status: 'VALIDATION_FAILED' },
    });

    throw conflict(
      ErrorCode.LISTING_NOT_SUBMITTABLE,
      `${String(blockers.length)} ${blockers.length === 1 ? 'thing needs' : 'things need'} fixing before this can be reviewed.`,
      blockers.slice(0, 25).map((issue) => ({
        field: issue.attributeKey ?? issue.section ?? 'listing',
        code: issue.code,
        message: issue.message,
        meta: { section: issue.section ?? '' },
      })),
    );
  }

  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerListingDraft.findUnique({
      where: { id: draftId },
      select: { status: true, sellerAccountId: true, version: true },
    });

    if (row === null) throw notFound('Listing');
    assertSellerOwnership(membership, row.sellerAccountId, 'Listing');

    assertListingTransition({
      from: row.status,
      to: 'PENDING_REVIEW',
      actor: 'SELLER',
    });

    await tx.sellerListingDraft.update({
      where: { id: draftId },
      data: {
        status: 'PENDING_REVIEW',
        submittedAt: new Date(),
        reviewComment: null,
        /*
         * Which revision the moderator will be deciding on.
         *
         * Read inside the same transaction as the status change, so it is the
         * version that is actually going into the queue rather than one read a
         * moment earlier. It stays put while the listing is in PENDING_REVIEW,
         * because that status is not editable - so a change to it means the
         * listing left the queue and came back, which is exactly the case a
         * moderator's decision must not be allowed to straddle.
         */
        submittedVersion: row.version,
      },
    });
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.submitted',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_listing_draft',
    resourceId: draftId,
    summary: 'Listing submitted for quality review.',
    correlationId: correlationId ?? null,
  });

  return readDraft(membership, draftId);
}

/** Take a listing back out of the review queue before a moderator opens it. */
export async function withdrawDraft(
  membership: SellerMembership,
  draftId: string,
  correlationId?: string | null,
): Promise<DraftView> {
  assertSellerPermission(membership, SellerPermission.LISTING_SUBMIT);

  const row = await loadDraftRow(membership, draftId);

  assertListingTransition({
    from: row.status,
    to: 'DRAFT',
    actor: 'SELLER',
  });

  await prisma.sellerListingDraft.update({
    where: { id: draftId },
    data: { status: 'DRAFT', submittedAt: null },
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.withdrawn',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_listing_draft',
    resourceId: draftId,
    summary: 'Listing withdrawn from review.',
    correlationId: correlationId ?? null,
  });

  return readDraft(membership, draftId);
}

// ---------------------------------------------------------------------------
// Listing the drafts
// ---------------------------------------------------------------------------

export interface DraftListQuery {
  status?: ListingDraftStatusName | null;
  search?: string | null;
  categoryId?: string | null;
  brandId?: string | null;
  page?: number;
  pageSize?: number;
}

export interface DraftListRow {
  id: string;
  status: ListingDraftStatusName;
  title: string | null;
  sellerSku: string | null;
  categoryId: string | null;
  brandName: string | null;
  sections: Record<string, { completed: number; total: number; state: string }>;
  openIssues: number;
  updatedAt: string;
}

/** The Draft / Pending / Needs changes tabs on the listings page. */
export async function listDrafts(
  membership: SellerMembership,
  query: DraftListQuery,
): Promise<{ rows: DraftListRow[]; total: number; counts: Record<string, number> }> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));

  const where = {
    sellerAccountId: membership.sellerAccountId,
    ...(query.status === null || query.status === undefined ? {} : { status: query.status }),
    ...(query.categoryId === null || query.categoryId === undefined ? {} : { categoryId: query.categoryId }),
    ...(query.brandId === null || query.brandId === undefined ? {} : { brandId: query.brandId }),
    ...(query.search === null || query.search === undefined || query.search.trim().length === 0
      ? {}
      : {
          OR: [
            { sellerSku: { contains: query.search.trim() } },
            { generatedTitle: { contains: query.search.trim() } },
          ],
        }),
  };

  const [rows, total, grouped] = await Promise.all([
    prisma.sellerListingDraft.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        brand: { select: { name: true } },
        _count: { select: { issues: { where: { resolvedAt: null, severity: 'BLOCKER' } } } },
      },
    }),
    prisma.sellerListingDraft.count({ where }),
    // Tab counts come from one grouped query rather than one count per tab:
    // seven round trips to render a row of numbers is seven round trips.
    prisma.sellerListingDraft.groupBy({
      by: ['status'],
      where: { sellerAccountId: membership.sellerAccountId },
      _count: { _all: true },
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      status: row.status,
      title: row.sellerEditedTitle ?? row.generatedTitle,
      sellerSku: row.sellerSku,
      categoryId: row.categoryId,
      brandName: row.brand?.name ?? null,
      sections: asRecord(row.sectionStateJson) as DraftListRow['sections'],
      openIssues: row._count.issues,
      updatedAt: row.updatedAt.toISOString(),
    })),
    total,
    counts: Object.fromEntries(grouped.map((entry) => [entry.status, entry._count._all])),
  };
}
