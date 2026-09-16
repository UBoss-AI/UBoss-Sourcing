/**
 * The operator's side: reviewing applications, listings and brand requests.
 *
 * Everything here runs as the MARKETPLACE, not as a seller, so nothing in this
 * file takes a `SellerMembership`. It takes an admin user and a seller account
 * id from the route, which is the opposite of the rule the seller services
 * follow - and it is safe for the opposite reason: an administrator is supposed
 * to be able to reach any seller, and the guard that decides whether they may
 * is a permission rather than an ownership check.
 *
 * Two things are kept apart throughout, and it matters more here than anywhere
 * else in the Seller Hub:
 *
 *   - **The seller-visible reason** and **the internal note.** A moderator
 *     writes both. Only the first is ever serialised to a seller route.
 *   - **Approving a listing** and **publishing a product.** Approval creates
 *     the `Product` (if it is new) and the `SellerOffer`. Whether that offer is
 *     immediately buyable is the seller's own decision afterwards, because a
 *     seller who has been waiting three days for a review may not want their
 *     listing to go live at 2am with no stock.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { assertListingTransition } from '../../domain/seller-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { syncMarketplacePrice } from '../catalog/marketplace-price.service.js';
import { OPERATOR_LABEL, recordSellerAudit } from './audit.service.js';
import { listDocumentsForReview } from './document.service.js';
import { transitionApplication } from './account.service.js';
import { loadListingSchema } from './listing-schema.service.js';
import { notifySeller } from './notification.service.js';
import type { SellerApplicationStatusName } from '../../domain/seller-state.js';

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

export interface ApplicationQueueQuery {
  status?: SellerApplicationStatusName | null;
  search?: string | null;
  page?: number;
  pageSize?: number;
}

export async function listApplications(query: ApplicationQueueQuery): Promise<{
  rows: {
    id: string;
    legalName: string;
    displayName: string;
    status: string;
    registrationCountry: string;
    kind: string;
    submittedAt: string | null;
    completedSteps: number;
    requiredSteps: number;
    documentCount: number;
  }[];
  total: number;
  counts: Record<string, number>;
}> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const search = query.search?.trim() ?? '';

  const where = {
    archivedAt: null,
    ...(query.status === null || query.status === undefined ? {} : { status: query.status }),
    ...(search.length === 0
      ? {}
      : {
          OR: [{ legalName: { contains: search } }, { displayName: { contains: search } }],
        }),
  };

  const [rows, total, grouped] = await Promise.all([
    prisma.sellerAccount.findMany({
      where,
      // Oldest submission first. A review queue sorted newest-first starves the
      // seller who has been waiting longest, which is the one the queue exists
      // to serve.
      orderBy: [{ submittedAt: 'asc' }, { createdAt: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        legalName: true,
        displayName: true,
        status: true,
        registrationCountry: true,
        kind: true,
        submittedAt: true,
        onboarding: { select: { completedSteps: true, requiredSteps: true } },
        _count: { select: { documents: { where: { supersededAt: null } } } },
      },
    }),
    prisma.sellerAccount.count({ where }),
    prisma.sellerAccount.groupBy({
      by: ['status'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      legalName: row.legalName,
      displayName: row.displayName,
      status: row.status,
      registrationCountry: row.registrationCountry,
      kind: row.kind,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      completedSteps: row.onboarding?.completedSteps ?? 0,
      requiredSteps: row.onboarding?.requiredSteps ?? 0,
      documentCount: row._count.documents,
    })),
    total,
    counts: Object.fromEntries(grouped.map((entry) => [String(entry.status), entry._count._all])),
  };
}

/** One application in full, including what the seller never sees. */
export async function readApplication(sellerAccountId: string) {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    include: {
      businessProfile: true,
      onboarding: true,
      payoutAccount: true,
      locations: { where: { archivedAt: null } },
      agreements: { orderBy: { acceptedAt: 'desc' } },
      verificationCases: { where: { isCurrent: true } },
      members: {
        where: { removedAt: null },
        select: {
          id: true,
          role: true,
          customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
        },
      },
    },
  });

  if (account === null) throw notFound('Seller application');

  /*
   * The documents come through the view rather than out of the include.
   *
   * Two reasons, and the second one is the important one. The first is that the
   * seller's own Hub and this screen render the same three words for "has this
   * been accepted", and deriving that twice is how the two end up disagreeing
   * in front of the business they disagree about. The second is that the raw
   * row carries `storageKey` - the object's address in the store - and there is
   * no reason for that to be in a browser at all.
   */
  const documents = await listDocumentsForReview(account.id);

  return { ...account, documents };
}

export interface SellerCommissionInput {
  sellerAccountId: string;
  /**
   * Basis points, or null to put this seller back on the marketplace's own
   * rate. 250 is 2.50%.
   */
  basisPoints: number | null;
  adminUserId: string;
  correlationId?: string | null;
}

/**
 * Put one seller on their own commission rate, or back on the standard one.
 *
 * The rate is a commercial term, so three things follow from that and none of
 * them is optional.
 *
 * **It changes nothing that has already been sold.** Every seller order group
 * carries the rate that was in force when the order was confirmed
 * (`commissionBasisPointsApplied`), and settlements are computed from that
 * figure rather than from this column. A rate that reached back through
 * finished orders would move money a seller has already been told they earned.
 *
 * **Null is not zero.** Null means "whatever the marketplace charges", and it
 * follows the platform rate when that moves; zero is a deliberate promise to
 * take nothing from this seller and stays at zero whatever the platform does.
 * Collapsing the two would silently re-rate every seller the day somebody set
 * a platform rate.
 *
 * **The seller is told.** A change to what a business is charged that arrives
 * only as a smaller number on next month's statement is the kind of surprise
 * that ends a commercial relationship. It goes to their notifications and to
 * their own audit log, where an operator appears as a role rather than as a
 * named member of staff.
 */
export async function setSellerCommission(input: SellerCommissionInput): Promise<void> {
  const { basisPoints } = input;

  if (
    basisPoints !== null &&
    (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000)
  ) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Commission must be between 0% and 100%.', [
      { field: 'commissionBasisPoints', code: 'OUT_OF_RANGE' },
    ]);
  }

  const account = await prisma.sellerAccount.findUnique({
    where: { id: input.sellerAccountId },
    select: { id: true, displayName: true, commissionBasisPoints: true },
  });

  if (account === null) throw notFound('Seller');
  if (account.commissionBasisPoints === basisPoints) return;

  const platformRate =
    (await prisma.businessProfile.findFirst({ select: { sellerCommissionBasisPoints: true } }))
      ?.sellerCommissionBasisPoints ?? 0;

  await prisma.sellerAccount.update({
    where: { id: account.id },
    data: { commissionBasisPoints: basisPoints },
  });

  await recordAudit({
    action: AuditAction.SETTINGS_UPDATED,
    resourceType: 'seller_account',
    resourceId: account.id,
    actorType: 'ADMIN',
    actorUserId: input.adminUserId,
    actorEmail: null,
    before: { commissionBasisPoints: account.commissionBasisPoints },
    after: { commissionBasisPoints: basisPoints },
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: account.id,
    action: 'seller.commission.changed',
    actor: { type: 'ADMIN', label: OPERATOR_LABEL },
    resourceType: 'seller_account',
    resourceId: account.id,
    before: { commissionBasisPoints: account.commissionBasisPoints },
    after: { commissionBasisPoints: basisPoints },
    summary:
      basisPoints === null
        ? `Commission is now the marketplace's standard rate (${percentOf(platformRate)}).`
        : `Commission is now ${percentOf(basisPoints)}.`,
    correlationId: input.correlationId ?? null,
  });

  await notifySeller({
    sellerAccountId: account.id,
    // The nearest kind that exists: this is a change to the account itself
    // rather than to a listing, an order or a payout. A kind of its own would
    // be a schema migration for a label, and the title says what it is.
    kind: 'APPLICATION_STATUS',
    title: 'Your commission rate has changed',
    body:
      (basisPoints === null
        ? `You are now on the marketplace's standard rate of ${percentOf(platformRate)}.`
        : `Your rate is now ${percentOf(basisPoints)}.`) +
      ' Orders already placed keep the rate that applied when they were confirmed.',
    linkPath: '/seller/payments',
    severity: 'INFO',
    subjectType: 'seller_account',
    subjectId: account.id,
  });
}

/** "2.50%" from 250. Two decimals, because a rate of 12.5% is not 13%. */
function percentOf(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

export interface ApplicationDecisionInput {
  sellerAccountId: string;
  to: SellerApplicationStatusName;
  /** Seller-visible. Required by the state machine on every refusal and stop. */
  reason?: string | null;
  /** Operator-only. */
  internalNote?: string | null;
  adminUserId: string;
  /** Whether a rejected seller may try again. Only meaningful with REJECTED. */
  resubmissionAllowed?: boolean;
  correlationId?: string | null;
  expectedVersion?: number | null;
}

export async function decideApplication(input: ApplicationDecisionInput): Promise<void> {
  await transitionApplication({
    sellerAccountId: input.sellerAccountId,
    to: input.to,
    actor: 'OPERATOR',
    actorUserId: input.adminUserId,
    reason: input.reason ?? null,
    internalNote: input.internalNote ?? null,
    correlationId: input.correlationId ?? null,
    expectedVersion: input.expectedVersion ?? null,
  });

  if (input.to === 'REJECTED' && input.resubmissionAllowed !== undefined) {
    await prisma.sellerAccount.update({
      where: { id: input.sellerAccountId },
      data: { resubmissionAllowed: input.resubmissionAllowed },
    });
  }

  /*
   * Outside the transition, and deliberately.
   *
   * `transitionApplication` owns the state change and its audit entry; this is
   * a message about something that has already happened. If writing it fails,
   * the seller has still been approved — and the notice is best-effort by
   * design, because the audit log is the record and this is not.
   */
  await notifySeller({
    sellerAccountId: input.sellerAccountId,
    kind: 'APPLICATION_STATUS',
    title: APPLICATION_NOTICE_TITLES[input.to],
    body:
      input.reason ??
      (input.to === 'APPROVED'
        ? 'You can start listing straight away. Everything you list goes through quality review before it can be bought.'
        : 'Open your application to see where it stands.'),
    linkPath: '/seller/onboarding',
    severity:
      input.to === 'APPROVED' ? 'SUCCESS' : input.to === 'UNDER_REVIEW' ? 'INFO' : 'WARNING',
    subjectType: 'seller_account',
    subjectId: input.sellerAccountId,
  });
}

const APPLICATION_NOTICE_TITLES: Record<SellerApplicationStatusName, string> = {
  DRAFT: 'Your application was reopened',
  SUBMITTED: 'Your application was received',
  UNDER_REVIEW: 'We are reviewing your application',
  ACTION_REQUIRED: 'Your application needs something from you',
  APPROVED: 'You can start selling',
  REJECTED: 'Your application was not accepted',
  SUSPENDED: 'Your account has been suspended',
};

// ---------------------------------------------------------------------------
// Listings
// ---------------------------------------------------------------------------

export async function listReviewQueue(query: { page?: number; pageSize?: number }): Promise<{
  rows: {
    id: string;
    sellerAccountId: string;
    sellerName: string;
    title: string | null;
    sellerSku: string | null;
    categoryId: string | null;
    brandName: string | null;
    submittedAt: string | null;
    openIssues: number;
  }[];
  total: number;
}> {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));

  const where = { status: 'PENDING_REVIEW' as const };

  const [rows, total] = await Promise.all([
    prisma.sellerListingDraft.findMany({
      where,
      orderBy: { submittedAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        sellerAccount: { select: { displayName: true } },
        brand: { select: { name: true } },
        _count: { select: { issues: { where: { resolvedAt: null } } } },
      },
    }),
    prisma.sellerListingDraft.count({ where }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      sellerAccountId: row.sellerAccountId,
      sellerName: row.sellerAccount.displayName,
      title: row.sellerEditedTitle ?? row.generatedTitle,
      sellerSku: row.sellerSku,
      categoryId: row.categoryId,
      brandName: row.brand?.name ?? null,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      openIssues: row._count.issues,
    })),
    total,
  };
}

/**
 * One submitted listing, in full, for the moderator deciding it.
 *
 * The queue row is a triage line — a title, a seller, a count. It is not enough
 * to decide on, and a review screen built from it would be somebody approving a
 * product they have never seen. This is the read that makes the decision a
 * review: every answer the seller gave, every photograph they uploaded, the
 * price and stock they set, and the schema that says what each of those answers
 * was supposed to be.
 *
 * No ownership check, deliberately — see this file's header. The guard is the
 * route's permission.
 *
 * The schema comes back whole rather than pre-joined onto the values. The
 * seller's wizard already renders exactly this pairing, and two renderings of
 * "what did they answer for this field" drift apart the first time a type is
 * added.
 */
export async function readListingForReview(draftId: string): Promise<{
  id: string;
  status: string;
  sellerAccountId: string;
  sellerName: string;
  sellerSku: string | null;
  title: string | null;
  generatedTitle: string | null;
  sellerEditedTitle: string | null;
  brandName: string | null;
  brandStatus: string | null;
  categoryId: string | null;
  categoryPath: { id: string; name: string }[];
  attributes: Record<string, unknown>;
  offer: Record<string, unknown>;
  stock: unknown[];
  packaging: Record<string, unknown>;
  media: {
    id: string;
    slot: string;
    kind: string;
    url: string | null;
    altText: string | null;
    isPrimary: boolean;
    contentType: string;
    scanState: string;
    rejectionCode: string | null;
    sortOrder: number;
  }[];
  issues: {
    id: string;
    severity: string;
    code: string;
    section: string | null;
    attributeKey: string | null;
    message: string;
    isFromModerator: boolean;
  }[];
  schema: Awaited<ReturnType<typeof loadListingSchema>> | null;
  submittedAt: string | null;
  reviewComment: string | null;
  updatedAt: string;
}> {
  const row = await prisma.sellerListingDraft.findUnique({
    where: { id: draftId },
    include: {
      media: { orderBy: { sortOrder: 'asc' } },
      brand: { select: { name: true, status: true } },
      sellerAccount: { select: { displayName: true } },
      issues: { where: { resolvedAt: null }, orderBy: { createdAt: 'asc' } },
    },
  });

  if (row === null) throw notFound('Listing');

  const schema = row.categoryId === null ? null : await loadListingSchema(row.categoryId);

  return {
    id: row.id,
    status: row.status,
    sellerAccountId: row.sellerAccountId,
    sellerName: row.sellerAccount.displayName,
    sellerSku: row.sellerSku,
    title: row.sellerEditedTitle ?? row.generatedTitle,
    generatedTitle: row.generatedTitle,
    sellerEditedTitle: row.sellerEditedTitle,
    brandName: row.brand?.name ?? null,
    brandStatus: row.brand?.status ?? null,
    categoryId: row.categoryId,
    categoryPath: schema?.categoryPath ?? [],
    attributes: asJsonObject(row.attributesJson),
    offer: asJsonObject(row.offerJson),
    stock: Array.isArray(row.stockJson) ? row.stockJson : [],
    packaging: asJsonObject(row.packagingJson),
    media: row.media.map((item) => ({
      id: item.id,
      slot: item.slot,
      kind: item.kind,
      // Null rather than a URL for an upload that never completed. A broken
      // image on a review screen reads as "the seller sent a bad photograph"
      // when what happened is that no bytes ever arrived.
      url: item.uploadedAt === null ? null : storage.urlFor(item.storageKey),
      altText: item.altText,
      isPrimary: item.isPrimary,
      contentType: item.contentType,
      scanState: item.scanState,
      rejectionCode: item.rejectionCode,
      sortOrder: item.sortOrder,
    })),
    issues: row.issues.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      code: issue.code,
      section: issue.section,
      attributeKey: issue.attributeKey,
      message: issue.message,
      isFromModerator: issue.isFromModerator,
    })),
    schema,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewComment: row.reviewComment,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function asJsonObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export interface ListingDecisionInput {
  draftId: string;
  to: 'APPROVED' | 'ACTION_REQUIRED' | 'REJECTED';
  /** Seller-visible comment. Required for anything but approval. */
  comment?: string | null;
  /**
   * Comments tied to individual fields.
   *
   * The difference between a useful review and a useless one. "Your images are
   * not acceptable" sends the seller to guess; an issue on
   * `PRODUCT_PHOTOS`/`UDI_LABEL` puts the sentence beside the slot.
   */
  fieldComments?: { section?: string | null; attributeKey?: string | null; message: string }[];
  adminUserId: string;
  correlationId?: string | null;
}

/**
 * Decide a listing.
 *
 * Approval is where a `Product` and a `SellerOffer` come into being, in one
 * transaction with the draft's own status change. Splitting them would leave
 * the two able to disagree: an approved draft with no offer is a seller who
 * was told yes and has nothing to sell.
 */
export async function decideListing(input: ListingDecisionInput): Promise<{ offerId: string | null }> {
  let createdOfferId: string | null = null;

  await prisma.$transaction(async (tx) => {
    const draft = await tx.sellerListingDraft.findUnique({
      where: { id: input.draftId },
      include: { media: true, sellerAccount: { select: { displayName: true } } },
    });

    if (draft === null) throw notFound('Listing');

    assertListingTransition({
      from: draft.status,
      to: input.to,
      actor: 'OPERATOR',
      reason: input.comment ?? null,
    });

    if (input.to === 'APPROVED') {
      if (draft.categoryId === null) {
        throw conflict(
          ErrorCode.LISTING_NOT_SUBMITTABLE,
          'This listing has no category and cannot be approved.',
        );
      }

      const offer = await publishApprovedListing(tx, draft.id);
      createdOfferId = offer.offerId;
    }

    const now = new Date();

    await tx.sellerListingDraft.update({
      where: { id: input.draftId },
      data: {
        status: input.to,
        reviewComment: input.comment ?? null,
        reviewedByUserId: input.adminUserId,
        reviewedAt: now,
      },
    });

    // A moderator's issues are marked so the seller's next save does not clear
    // them - see `refreshDraftState`, which only deletes its own.
    if (input.fieldComments !== undefined && input.fieldComments.length > 0) {
      await tx.sellerListingIssue.createMany({
        data: input.fieldComments.slice(0, 50).map((comment) => ({
          id: newId(),
          draftId: input.draftId,
          severity: 'BLOCKER' as const,
          code: 'MODERATOR_COMMENT',
          section: (comment.section ?? null) as never,
          attributeKey: comment.attributeKey ?? null,
          message: comment.message.slice(0, 512),
          isFromModerator: true,
        })),
      });
    }

    /*
     * Tell them, inside the same transaction.
     *
     * A decision the seller is not told about is a listing that silently stops
     * working, and the email path may never be opened. Joining the transaction
     * rather than firing afterwards means a rolled-back decision cannot leave a
     * notice about something that did not happen.
     */
    await notifySeller({
      sellerAccountId: draft.sellerAccountId,
      kind: 'LISTING_DECISION',
      title:
        input.to === 'APPROVED'
          ? 'Your listing passed review'
          : input.to === 'REJECTED'
            ? 'Your listing was refused'
            : 'Your listing needs changes',
      body:
        input.to === 'APPROVED'
          ? 'It is ready to go on sale whenever you are. Nothing is live until you switch it on.'
          : (input.comment ??
            'Open it to see what needs changing — the notes are beside the fields they belong to.'),
      linkPath: '/seller/listings',
      severity: input.to === 'APPROVED' ? 'SUCCESS' : 'WARNING',
      subjectType: 'seller_listing_draft',
      subjectId: input.draftId,
      tx,
    });

    await recordSellerAudit({
      sellerAccountId: draft.sellerAccountId,
      action: `seller.listing.${input.to.toLowerCase()}`,
      // The seller sees a ROLE, never the moderator's name.
      actor: { type: 'ADMIN', userId: input.adminUserId, label: OPERATOR_LABEL },
      resourceType: 'seller_listing_draft',
      resourceId: input.draftId,
      before: { status: draft.status },
      after: { status: input.to },
      summary:
        input.to === 'APPROVED'
          ? 'Your listing passed quality review and is ready to go on sale.'
          : `Quality review: ${input.comment ?? 'changes needed'}`,
      correlationId: input.correlationId ?? null,
      tx,
    });
  });

  return { offerId: createdOfferId };
}

/**
 * Turn an approved draft into a catalogue product and a seller offer.
 *
 * Two cases, and the split is the heart of the marketplace model:
 *
 *   - The seller MATCHED an existing catalogue product. No product is created;
 *     their offer attaches to the one that exists. This is the case that lets
 *     three distributors compete on one product page.
 *
 *   - The seller described a NEW product. One is created, marked
 *     `isMarketplaceProduct`, with the seller recorded as the one who described
 *     it. It is NOT published on its own: a marketplace product becomes visible
 *     because a live offer points at it, not because the product row says so.
 */
async function publishApprovedListing(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  draftId: string,
): Promise<{ productId: string; offerId: string }> {
  const draft = await tx.sellerListingDraft.findUniqueOrThrow({ where: { id: draftId } });

  const offerJson = (draft.offerJson ?? {}) as Record<string, unknown>;
  const stockJson = Array.isArray(draft.stockJson)
    ? (draft.stockJson as { locationId: string; availableQuantity: number }[])
    : [];

  const title = draft.sellerEditedTitle ?? draft.generatedTitle ?? 'Untitled product';
  // Read back out of the draft's JSON, and narrowed rather than stringified.
  // `offerJson` is `unknown` by construction - it is whatever the wizard last
  // saved - and `String()` over an unexpected object would put "[object
  // Object]" into a price or a currency code.
  const text = (key: string): string | null => {
    const value = offerJson[key];
    return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : null;
  };

  const priceMinor = BigInt(/^\d+$/.test(text('priceMinor') ?? '') ? (text('priceMinor') as string) : '0');
  const currency = text('currency') ?? 'EUR';
  const sellerSku = draft.sellerSku ?? `SKU-${draftId.slice(-10)}`;

  let productId = draft.matchedProductId;

  if (productId === null) {
    productId = newId();

    const taxClass = await tx.taxClass.findFirst({ select: { id: true } });

    await tx.product.create({
      data: {
        id: productId,
        categoryId: draft.categoryId ?? '',
        name: title.slice(0, 255),
        // Suffixed with part of the id. Two sellers describing "Nitrile Glove,
        // Medium" would otherwise collide on a UNIQUE slug and the second
        // approval would fail with a database error nobody could act on.
        slug: `${title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 200)}-${productId.toLowerCase().slice(-6)}`,
        sku: `MP-${productId.slice(-16)}`,
        taxClassId: text('taxClassId') ?? taxClass?.id ?? '',
        basePriceMinor: priceMinor,
        currency,
        status: 'ACTIVE',
        // Published as a catalogue entry, and visible only because a live offer
        // points at it. `isMarketplaceProduct` is what tells the storefront to
        // read the price from the offers rather than from this row.
        isPublished: true,
        publishedAt: new Date(),
        isMarketplaceProduct: true,
        createdBySellerAccountId: draft.sellerAccountId,
        isStockTracked: true,
      },
    });
  }

  const offerId = newId();

  await tx.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: draft.sellerAccountId,
      productId,
      variantKey: '',
      sellerSku,
      brandId: draft.brandId,
      // INACTIVE, not ACTIVE. The seller decides when it goes on sale - see the
      // header of this file. A listing approved at 2am with no stock allocated
      // would otherwise go straight in front of buyers.
      status: 'INACTIVE',
      priceMinor,
      currency,
      taxClassId: text('taxClassId'),
      minimumOrderQuantity: Number(offerJson['minimumOrderQuantity'] ?? 1),
      orderIncrement: Number(offerJson['orderIncrement'] ?? 1),
      sourceDraftId: draftId,
      sellingRegionsJson: (offerJson['sellingRegions'] ?? []) as never,
    },
  });

  // The stock the seller typed in the wizard, applied as real balances with a
  // movement each - so the ledger explains where the opening stock came from
  // rather than it simply existing.
  for (const entry of stockJson) {
    if (entry.availableQuantity <= 0) continue;

    await tx.sellerInventory.create({
      data: {
        id: newId(),
        sellerAccountId: draft.sellerAccountId,
        offerId,
        locationId: entry.locationId,
        availableQuantity: entry.availableQuantity,
      },
    });

    await tx.sellerInventoryMovement.create({
      data: {
        id: newId(),
        sellerAccountId: draft.sellerAccountId,
        offerId,
        locationId: entry.locationId,
        type: 'RECEIPT',
        quantityDelta: entry.availableQuantity,
        balanceAfter: entry.availableQuantity,
        reason: 'Opening stock from the approved listing.',
        referenceType: 'seller_listing_draft',
        referenceId: draftId,
        idempotencyKey: `opening:${draftId}:${entry.locationId}`,
      },
    });
  }

  /*
   * Carry the seller's photographs onto the catalogue product.
   *
   * Without this the whole media flow ends in nothing visible: a seller
   * uploads twelve angles, a moderator approves, and the product renders with
   * no picture — which is exactly what a buyer decides not to order.
   *
   * The BYTES are not copied. The draft's media rows and the product's media
   * rows point at the same objects in the store, because they are the same
   * files; duplicating them would double the storage for no reason and leave
   * two copies to keep in step.
   *
   * `MediaAsset.storageKey` is unique, so a re-approval - or the same file
   * reaching the catalogue by two routes - reuses the existing asset rather
   * than colliding.
   *
   * Videos are skipped. `ProductMedia` is the product gallery, and nothing
   * that renders it today can play one; carrying a video across would put a
   * broken image in a buyer's search result. The video stays on the draft,
   * which is where it is readable.
   */
  const draftMedia = await tx.sellerListingDraftMedia.findMany({
    where: { draftId, kind: 'IMAGE', uploadedAt: { not: null } },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
  });

  for (const [index, item] of draftMedia.entries()) {
    const asset = await tx.mediaAsset.upsert({
      where: { storageKey: item.storageKey },
      create: {
        id: newId(),
        storageKey: item.storageKey,
        url: storage.urlFor(item.storageKey),
        mimeType: item.contentType,
        sizeBytes: item.byteSize,
        width: item.widthPx,
        height: item.heightPx,
        altText: item.altText,
        checksum: item.contentHash,
      },
      // Only the alt text is refreshed. The bytes cannot have changed - the key
      // is derived from them - and overwriting the rest would be writing the
      // same values back.
      update: { altText: item.altText },
    });

    await tx.productMedia.upsert({
      where: { productId_mediaId: { productId, mediaId: asset.id } },
      create: {
        id: newId(),
        productId,
        mediaId: asset.id,
        sortOrder: index,
        isPrimary: item.isPrimary,
      },
      update: { sortOrder: index, isPrimary: item.isPrimary },
    });
  }

  const totals = await tx.sellerInventory.aggregate({
    where: { offerId },
    _sum: { availableQuantity: true },
  });

  await tx.sellerOffer.update({
    where: { id: offerId },
    data: { availableQuantity: totals._sum.availableQuantity ?? 0 },
  });

  await tx.sellerListingDraft.update({
    where: { id: draftId },
    data: { publishedProductId: productId, publishedOfferId: offerId },
  });

  /*
   * Put the product on the operator's shelf, if the offer is live.
   *
   * It is not, at this moment - the offer above is created INACTIVE on purpose,
   * because the seller decides when it goes on sale. So this writes nothing
   * today and is here because the alternative is worse: a future change that
   * approves straight to ACTIVE would otherwise create a product no category
   * could show, and the failure is silent.
   */
  await syncMarketplacePrice(tx, productId);

  return { productId, offerId };
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

/**
 * The brand requests waiting on an operator.
 *
 * Oldest first, because a queue sorted newest-first starves the seller who has
 * been waiting longest — the one the queue exists to serve.
 *
 * Four fields beyond what the seller typed, each of which changes the decision:
 *
 *   - `status`, so a request somebody has already gone back to the seller about
 *     does not read identically to one nobody has touched. Without it a
 *     reviewer asks the same question twice and the seller waits another day.
 *   - `informationRequested`, the sentence that was sent — the reviewer needs to
 *     see what was asked before deciding whether the answer arrived.
 *   - `listingsWaiting`, how many drafts are held up behind this brand. Nothing
 *     on an unapproved name can go on sale, so this is the cost of the request
 *     sitting here.
 *   - `alsoRequestedBy`, the other sellers whose open requests point at the SAME
 *     brand row. Approving is not a decision about one seller: a brand is one
 *     row, and approving it here approves the name for all of them.
 */
export async function listBrandQueue(): Promise<
  {
    id: string;
    requestedName: string;
    sellerName: string;
    manufacturerLegalName: string | null;
    websiteUrl: string | null;
    justification: string | null;
    status: 'PENDING' | 'INFORMATION_REQUESTED';
    informationRequested: string | null;
    listingsWaiting: number;
    alsoRequestedBy: string[];
    createdAt: string;
  }[]
> {
  const rows = await prisma.brandRequest.findMany({
    where: { status: { in: ['PENDING', 'INFORMATION_REQUESTED'] } },
    orderBy: { createdAt: 'asc' },
    take: 200,
    include: {
      sellerAccount: { select: { displayName: true } },
      // The drafts held up behind the name, not the offers: an offer only
      // exists once a listing has been approved, by which point the brand was.
      brand: { select: { _count: { select: { drafts: true } } } },
    },
  });

  // Who else is waiting on each brand row, from the rows already in hand. A
  // second query would only tell us what this one already knows.
  const sellersByBrand = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.brandId === null) continue;
    const sellers = sellersByBrand.get(row.brandId) ?? new Set<string>();
    sellers.add(row.sellerAccount.displayName);
    sellersByBrand.set(row.brandId, sellers);
  }

  return rows.map((row) => ({
    id: row.id,
    requestedName: row.requestedName,
    sellerName: row.sellerAccount.displayName,
    manufacturerLegalName: row.manufacturerLegalName,
    websiteUrl: row.websiteUrl,
    justification: row.justification,
    status: row.status === 'INFORMATION_REQUESTED' ? 'INFORMATION_REQUESTED' : 'PENDING',
    // Only meaningful while we are waiting on the seller. On a PENDING row it
    // would be the reason for a decision that was later reopened, which is not
    // what the label beside it says.
    informationRequested: row.status === 'INFORMATION_REQUESTED' ? row.decisionReason : null,
    listingsWaiting: row.brand?._count.drafts ?? 0,
    alsoRequestedBy: [...(sellersByBrand.get(row.brandId ?? '') ?? [])].filter(
      (name) => name !== row.sellerAccount.displayName,
    ),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function decideBrandRequest(input: {
  requestId: string;
  decision: 'APPROVED' | 'REJECTED' | 'INFORMATION_REQUESTED';
  reason?: string | null;
  /** Approve under a corrected name - "B. Braun" for a request saying "Brawn". */
  correctedName?: string | null;
  adminUserId: string;
  correlationId?: string | null;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const request = await tx.brandRequest.findUnique({
      where: { id: input.requestId },
      include: { brand: true },
    });

    if (request === null) throw notFound('Brand request');

    if (request.status !== 'PENDING' && request.status !== 'INFORMATION_REQUESTED') {
      throw conflict(ErrorCode.CONFLICT, 'This brand request has already been decided.');
    }

    if (input.decision === 'APPROVED' && request.brandId !== null) {
      await tx.brand.update({
        where: { id: request.brandId },
        data: {
          status: 'APPROVED',
          ...(input.correctedName === null || input.correctedName === undefined
            ? {}
            : {
                name: input.correctedName.trim(),
                nameNormalized: input.correctedName
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, ''),
              }),
        },
      });
    }

    if (input.decision === 'REJECTED' && request.brandId !== null) {
      // Only retire the brand row if nothing else is using it. A second seller
      // may have attached to the same pending brand while this request sat in
      // the queue, and retiring it would break their draft.
      const otherUsers = await tx.brandRequest.count({
        where: {
          brandId: request.brandId,
          id: { not: request.id },
          status: { in: ['PENDING', 'APPROVED'] },
        },
      });

      if (otherUsers === 0 && request.brand?.status === 'PENDING') {
        await tx.brand.update({
          where: { id: request.brandId },
          data: { status: 'REJECTED', rejectedReason: input.reason ?? null },
        });
      }
    }

    await tx.brandRequest.update({
      where: { id: request.id },
      data: {
        status: input.decision,
        decisionReason: input.reason ?? null,
        decidedByUserId: input.adminUserId,
        decidedAt: new Date(),
      },
    });

    await notifySeller({
      sellerAccountId: request.sellerAccountId,
      kind: 'BRAND_REQUEST_DECISION',
      title:
        input.decision === 'APPROVED'
          ? `${input.correctedName ?? request.requestedName} is ready to use`
          : input.decision === 'REJECTED'
            ? `${request.requestedName} was refused`
            : `We need more about ${request.requestedName}`,
      body:
        input.decision === 'APPROVED'
          ? 'You can choose it in the listing wizard now.'
          : (input.reason ?? 'Open your brand requests to see what we asked for.'),
      linkPath: '/seller/brands',
      severity: input.decision === 'APPROVED' ? 'SUCCESS' : 'WARNING',
      subjectType: 'brand_request',
      subjectId: request.id,
      tx,
    });

    await recordSellerAudit({
      sellerAccountId: request.sellerAccountId,
      action: `seller.brand.${input.decision.toLowerCase()}`,
      actor: { type: 'ADMIN', userId: input.adminUserId, label: OPERATOR_LABEL },
      resourceType: 'brand_request',
      resourceId: request.id,
      summary:
        input.decision === 'APPROVED'
          ? `The brand "${input.correctedName ?? request.requestedName}" was added and is ready to use.`
          : `Your request for "${request.requestedName}" was ${input.decision.toLowerCase().replace(/_/g, ' ')}: ${input.reason ?? 'no reason given'}.`,
      correlationId: input.correlationId ?? null,
      tx,
    });
  });
}
