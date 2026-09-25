/**
 * A seller's description and specifications for one listing.
 *
 * WHO MAY EDIT WHAT
 *
 *   - The seller who owns the listing, with `seller.listing.write`, and nobody
 *     else: another seller's listing id answers 404, exactly as a missing one
 *     does. The seller is always the signed-in membership's own account -
 *     nothing the browser sends names one.
 *   - Before approval, while the listing is editable: saved on the draft, and
 *     the moderator reviews it with everything else. Approval copies it onto
 *     the product (`publishApprovedListing`).
 *   - After approval, only when this listing DESCRIBED the product: saved on
 *     the draft and applied to the product at once, audited - the same rule
 *     the edit page applies to photographs. A seller who matched their offer
 *     to an existing page cannot change that page's specifications, because
 *     other sellers sell it too.
 *   - While the listing is with the moderator: refused, so what they approve is
 *     what they read.
 */
import {
  contentIssues,
  listingContentSchema,
  readListingContent,
  type ListingContent,
} from '../../domain/product-specifications.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { LISTING_EDITABLE_STATUSES } from '../../domain/seller-state.js';
import { prisma } from '../../infra/prisma.js';
import { replaceProductContent } from '../catalog/product-content.service.js';
import { assertSellerOwnership, assertSellerPermission, type SellerMembership } from './account.service.js';
import { recordSellerAudit } from './audit.service.js';
import { normaliseRows, readDraftVariants, variantNameOf } from './listing-variants.js';

export interface ListingContentView {
  content: ListingContent;
  /** The listing's combinations, for per-variant values. */
  variants: { signature: string; name: string }[];
  /** The listing's own pictures, the only ones a section may show. */
  images: { id: string; fileName: string; altText: string | null }[];
  /** False while the listing is with the moderator, or for a matched listing that is live. */
  editable: boolean;
  /** "draft": reviewed on approval. "live": changes the product page now. */
  appliesTo: 'draft' | 'live';
}

const EMPTY: ListingContent = { specifications: [], descriptionSections: [], variantOverrides: [] };

async function loadOwned(membership: SellerMembership, draftId: string) {
  const draft = await prisma.sellerListingDraft.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      sellerAccountId: true,
      status: true,
      matchedProductId: true,
      publishedProductId: true,
      listingContentJson: true,
      variantAxesJson: true,
      variantsJson: true,
      media: {
        where: { kind: 'IMAGE', uploadedAt: { not: null } },
        orderBy: { sortOrder: 'asc' },
        select: { id: true, originalFileName: true, altText: true, storageKey: true },
      },
    },
  });
  if (draft === null) throw notFound('Listing');
  // Tenant check before anything is read off the row.
  assertSellerOwnership(membership, draft.sellerAccountId, 'Listing');
  return draft;
}

type OwnedDraft = Awaited<ReturnType<typeof loadOwned>>;

/** The matrix as approval will read it: signatures computed here, never taken from the browser. */
function draftRows(draft: OwnedDraft) {
  return normaliseRows(readDraftVariants(draft.variantAxesJson, draft.variantsJson).rows ?? []).rows;
}

function modeOf(draft: OwnedDraft): { editable: boolean; appliesTo: 'draft' | 'live' } {
  if (LISTING_EDITABLE_STATUSES.includes(draft.status)) return { editable: true, appliesTo: 'draft' };
  const live = draft.status === 'APPROVED' && draft.publishedProductId !== null;
  return { editable: live && draft.matchedProductId === null, appliesTo: live ? 'live' : 'draft' };
}

function viewOf(draft: OwnedDraft): ListingContentView {
  const variants = draftRows(draft)
    .filter((row) => row.isActive)
    .map((row) => ({ signature: row.optionSignature, name: variantNameOf(row) }));
  return {
    content: readListingContent(draft.listingContentJson) ?? EMPTY,
    variants,
    images: draft.media.map((item) => ({ id: item.id, fileName: item.originalFileName, altText: item.altText })),
    ...modeOf(draft),
  };
}

export async function readListingContentForSeller(
  membership: SellerMembership,
  draftId: string,
): Promise<ListingContentView> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);
  return viewOf(await loadOwned(membership, draftId));
}

export async function saveListingContentForSeller(input: {
  membership: SellerMembership;
  draftId: string;
  body: unknown;
  correlationId?: string | null;
}): Promise<ListingContentView> {
  const { membership, draftId } = input;
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);
  const draft = await loadOwned(membership, draftId);
  const mode = modeOf(draft);
  if (!mode.editable) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      draft.status === 'PENDING_REVIEW'
        ? 'This listing is with the marketplace for review and cannot be changed right now.'
        : 'This product page is shared with other sellers; its description is changed through the marketplace.',
    );
  }

  const content = listingContentSchema.parse(input.body);
  const issues = contentIssues(content);
  if (issues.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Some of the description or specifications need fixing.', issues);
  }

  // A section may only show one of this listing's own pictures.
  const ownImages = new Map(draft.media.map((item) => [item.id, item.storageKey]));
  for (const [index, section] of content.descriptionSections.entries()) {
    if (section.imageMediaId !== null && !ownImages.has(section.imageMediaId)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That picture is not part of this listing.', [
        { field: `descriptionSections.${index}.imageMediaId`, code: 'NOT_THIS_LISTING' },
      ]);
    }
  }
  const signatures = new Set(draftRows(draft).map((row) => row.optionSignature));
  for (const [index, row] of content.variantOverrides.entries()) {
    if (!signatures.has(row.variantSignature)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That option is not part of this listing.', [
        { field: `variantOverrides.${index}.variantSignature`, code: 'NOT_THIS_LISTING' },
      ]);
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.sellerListingDraft.update({
      where: { id: draftId },
      data: { listingContentJson: content, version: { increment: 1 } },
    });

    const productId = draft.publishedProductId;
    if (mode.appliesTo === 'live' && productId !== null) {
      const [variants, assets] = await Promise.all([
        tx.productVariant.findMany({ where: { productId }, select: { id: true, optionSignature: true } }),
        tx.mediaAsset.findMany({
          where: { storageKey: { in: [...ownImages.values()] } },
          select: { id: true, storageKey: true },
        }),
      ]);
      const assetByKey = new Map(assets.map((asset) => [asset.storageKey, asset.id]));
      await replaceProductContent(
        tx,
        productId,
        {
          ...content,
          descriptionSections: content.descriptionSections.map((section) => ({
            ...section,
            imageMediaId:
              section.imageMediaId === null
                ? null
                : (assetByKey.get(ownImages.get(section.imageMediaId) ?? '') ?? null),
          })),
        },
        {
          variantIds: new Map(
            variants.flatMap((variant) =>
              variant.optionSignature === '' ? [] : [[variant.optionSignature, variant.id] as const],
            ),
          ),
          allowedImageIds: new Set(assetByKey.values()),
        },
      );
    }
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.content_saved',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_listing_draft',
    resourceId: draftId,
    summary:
      mode.appliesTo === 'live'
        ? 'The description and specifications on the live product page were changed.'
        : 'The description and specifications were saved on the listing.',
    correlationId: input.correlationId ?? null,
  });

  return readListingContentForSeller(membership, draftId);
}
