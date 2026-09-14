/**
 * Photographs and videos on a seller's listing.
 *
 * The bytes go to the configured object store and the row records where. What
 * the row is NOT is a copy of the file, which matters because a seller
 * uploading forty product shots would otherwise put forty multi-megabyte blobs
 * through the database.
 *
 * Three rules run through the file:
 *
 *   - **The magic bytes decide the type, never the Content-Type header.** A
 *     client can claim anything; `sniffMediaType` reads the first few bytes and
 *     an unrecognised file is refused. SVG is deliberately not in the table -
 *     it is a script-capable document, and serving one inline is stored XSS.
 *
 *   - **Photographs and videos have different size limits.** Five megabytes is
 *     generous for a product photograph and useless for a clip, so a video has
 *     its own ceiling. One shared limit would mean raising the photograph
 *     ceiling to accept a video, and the photograph ceiling is what stops a RAW
 *     file per product.
 *
 *   - **Exactly one primary image, always.** The listings table, the buyer's
 *     search result and the order confirmation all render "the" picture, and
 *     two rows claiming to be it means those three disagree.
 */
import type { ListingMediaSlot, SellerMediaKind } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { LISTING_EDITABLE_STATUSES } from '../../domain/seller-state.js';
import { createHash } from 'node:crypto';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertWithinMediaSizeLimit,
  readImageDimensions,
  sniffMediaType,
  storage,
} from '../../infra/storage/index.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';

/**
 * How many files one listing may carry.
 *
 * Generous rather than tight - a seller photographing a complex instrument
 * from every angle is doing the right thing - but not unbounded, because the
 * gallery is rendered on a product page and four hundred images is a page
 * nobody can load.
 */
const MAX_MEDIA_PER_DRAFT = 24;

/** And videos, separately. Three is already more than a buyer will watch. */
const MAX_VIDEOS_PER_DRAFT = 3;

export interface MediaView {
  id: string;
  slot: string;
  kind: SellerMediaKind;
  url: string;
  altText: string | null;
  isPrimary: boolean;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
  byteSize: number;
  contentType: string;
  rejectionCode: string | null;
  scanState: string;
  sortOrder: number;
}

function toView(row: {
  id: string;
  slot: ListingMediaSlot;
  kind: SellerMediaKind;
  storageKey: string;
  altText: string | null;
  isPrimary: boolean;
  widthPx: number | null;
  heightPx: number | null;
  durationSeconds: number | null;
  byteSize: number;
  contentType: string;
  rejectionCode: string | null;
  scanState: string;
  sortOrder: number;
}): MediaView {
  return {
    id: row.id,
    slot: row.slot,
    kind: row.kind,
    // Built on read rather than stored: the store's public base URL is
    // deployment configuration, and a URL frozen into a row would survive a
    // move from local disk to S3 and point at nothing.
    url: storage.urlFor(row.storageKey),
    altText: row.altText,
    isPrimary: row.isPrimary,
    widthPx: row.widthPx,
    heightPx: row.heightPx,
    durationSeconds: row.durationSeconds,
    byteSize: row.byteSize,
    contentType: row.contentType,
    rejectionCode: row.rejectionCode,
    scanState: row.scanState,
    sortOrder: row.sortOrder,
  };
}

/** Load a draft this seller owns, and refuse if it is not theirs or is locked. */
async function loadEditableDraft(membership: SellerMembership, draftId: string) {
  const draft = await prisma.sellerListingDraft.findUnique({
    where: { id: draftId },
    select: { id: true, sellerAccountId: true, status: true },
  });

  if (draft === null) throw notFound('Listing');
  assertSellerOwnership(membership, draft.sellerAccountId, 'Listing');

  if (!LISTING_EDITABLE_STATUSES.includes(draft.status)) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      draft.status === 'PENDING_REVIEW'
        ? 'This listing is with the marketplace for review, so its photographs cannot be changed.'
        : 'This listing can no longer be edited.',
    );
  }

  return draft;
}

export interface UploadInput {
  membership: SellerMembership;
  draftId: string;
  buffer: Buffer;
  originalFileName: string;
  /** Which named slot this fills. `VIDEO` is inferred when the bytes are one. */
  slot?: string | null;
  altText?: string | null;
  correlationId?: string | null;
}

/**
 * Store one file against a draft.
 *
 * Returns the row the gallery renders. The upload is rejected before a single
 * byte is written whenever the type, the size or the count is wrong, so a
 * refused upload leaves nothing behind in the object store.
 */
export async function uploadListingMedia(input: UploadInput): Promise<MediaView> {
  const { membership } = input;

  assertSellerPermission(membership, SellerPermission.MEDIA_UPLOAD);
  await loadEditableDraft(membership, input.draftId);

  // The bytes decide, not the browser. Order matters: sniff first, because the
  // size limit depends on which kind it turned out to be.
  const sniffed = sniffMediaType(input.buffer);
  assertWithinMediaSizeLimit(input.buffer.length, sniffed.kind);

  const existing = await prisma.sellerListingDraftMedia.findMany({
    where: { draftId: input.draftId },
    select: { id: true, kind: true, slot: true, isPrimary: true, contentHash: true },
  });

  if (existing.length >= MAX_MEDIA_PER_DRAFT) {
    throw conflict(
      ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
      `A listing can carry ${String(MAX_MEDIA_PER_DRAFT)} files. Remove one before adding another.`,
    );
  }

  if (sniffed.kind === 'VIDEO') {
    const videos = existing.filter((row) => row.kind === 'VIDEO').length;

    if (videos >= MAX_VIDEOS_PER_DRAFT) {
      throw conflict(
        ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
        `A listing can carry ${String(MAX_VIDEOS_PER_DRAFT)} videos.`,
      );
    }
  }

  // The same file twice is almost always a seller pressing upload again after a
  // slow response, not a seller who wants two copies. Refused by content hash
  // rather than by file name, because a browser renames on re-download.
  // Hashed here rather than through `sha256Hex`, which takes a string: running
  // binary through a UTF-8 decode first would mangle it and make two different
  // files collide.
  const checksum = createHash('sha256').update(input.buffer).digest('hex');

  if (existing.some((row) => row.contentHash === checksum)) {
    throw conflict(
      ErrorCode.CONFLICT,
      'That exact file is already on this listing.',
      [{ field: 'file', code: 'DUPLICATE_FILE' }],
    );
  }

  const slot: ListingMediaSlot =
    sniffed.kind === 'VIDEO'
      ? 'VIDEO'
      : ((input.slot ?? 'OTHER') as ListingMediaSlot);

  const stored = await storage.put(input.buffer, sniffed.mimeType, sniffed.extension, 'public');

  const dimensions =
    sniffed.kind === 'IMAGE' ? readImageDimensions(input.buffer, sniffed.mimeType) : null;

  // The first PICTURE becomes the primary one. A video never does, whatever
  // order things were uploaded in: the primary is what renders in a search
  // result and in an order confirmation, and neither of those can play a clip.
  const hasPrimary = existing.some((row) => row.isPrimary);
  const isPrimary = sniffed.kind === 'IMAGE' && !hasPrimary;

  const id = newId();

  await prisma.sellerListingDraftMedia.create({
    data: {
      id,
      draftId: input.draftId,
      slot,
      kind: sniffed.kind,
      storageKey: stored.storageKey,
      originalFileName: input.originalFileName.slice(0, 255),
      contentType: sniffed.mimeType,
      byteSize: input.buffer.length,
      contentHash: checksum,
      widthPx: dimensions?.width ?? null,
      heightPx: dimensions?.height ?? null,
      altText: input.altText ?? null,
      isPrimary,
      sortOrder: existing.length,
      uploadedAt: new Date(),
      // No malware scanner is configured on this deployment. The state says so
      // rather than claiming the file is clean - see `SellerDocumentScanState`.
      scanState: 'SCANNER_UNCONFIGURED',
    },
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: sniffed.kind === 'VIDEO' ? 'seller.listing.video_added' : 'seller.listing.photo_added',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_listing_draft_media',
    resourceId: id,
    summary:
      sniffed.kind === 'VIDEO'
        ? `A video was added to a listing (${input.originalFileName}).`
        : `A photograph was added to a listing (${input.originalFileName}).`,
    correlationId: input.correlationId ?? null,
  });

  const row = await prisma.sellerListingDraftMedia.findUniqueOrThrow({ where: { id } });
  return toView(row);
}

/** Everything on one draft, pictures first, in the order the seller set. */
export async function listListingMedia(
  membership: SellerMembership,
  draftId: string,
): Promise<MediaView[]> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const draft = await prisma.sellerListingDraft.findUnique({
    where: { id: draftId },
    select: { sellerAccountId: true },
  });

  if (draft === null) throw notFound('Listing');
  assertSellerOwnership(membership, draft.sellerAccountId, 'Listing');

  const rows = await prisma.sellerListingDraftMedia.findMany({
    where: { draftId },
    orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }],
  });

  return rows.map(toView);
}

/**
 * Remove one file, from the database and from the store.
 *
 * The row goes first. A delete that removed the bytes and then failed to
 * remove the row would leave the gallery pointing at nothing, which is a
 * visible break; the other way round leaves an orphaned object, which is
 * wasted bytes nobody sees.
 */
export async function deleteListingMedia(
  membership: SellerMembership,
  draftId: string,
  mediaId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.MEDIA_UPLOAD);
  await loadEditableDraft(membership, draftId);

  const row = await prisma.sellerListingDraftMedia.findUnique({
    where: { id: mediaId },
    select: { id: true, draftId: true, storageKey: true, isPrimary: true, kind: true },
  });

  if (row === null || row.draftId !== draftId) throw notFound('File');

  await prisma.$transaction(async (tx) => {
    await tx.sellerListingDraftMedia.delete({ where: { id: mediaId } });

    // Deleting the primary picture promotes the next one, so a listing never
    // ends up with pictures and no primary.
    if (row.isPrimary) {
      const next = await tx.sellerListingDraftMedia.findFirst({
        where: { draftId, kind: 'IMAGE' },
        orderBy: { sortOrder: 'asc' },
        select: { id: true },
      });

      if (next !== null) {
        await tx.sellerListingDraftMedia.update({
          where: { id: next.id },
          data: { isPrimary: true },
        });
      }
    }
  });

  // Outside the transaction on purpose: an object store is not transactional,
  // and a failure here must not roll back a delete the seller has already been
  // told succeeded.
  try {
    await storage.delete(row.storageKey);
  } catch {
    // An orphaned object is wasted bytes, not a broken listing. The row is
    // already gone, which is the part the seller can see.
  }

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: row.kind === 'VIDEO' ? 'seller.listing.video_removed' : 'seller.listing.photo_removed',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_listing_draft_media',
    resourceId: mediaId,
    summary: row.kind === 'VIDEO' ? 'A video was removed.' : 'A photograph was removed.',
    correlationId: correlationId ?? null,
  });
}

export interface MediaPatch {
  slot?: string | null;
  altText?: string | null;
  isPrimary?: boolean;
  sortOrder?: number | null;
}

/**
 * Change what a file is, not what it contains.
 *
 * Making one picture primary clears the flag from whatever held it, in the
 * same transaction. Two rows claiming to be the primary image is the bug this
 * prevents, and it is invisible until a search result and an order
 * confirmation show different pictures of the same product.
 */
export async function updateListingMedia(
  membership: SellerMembership,
  draftId: string,
  mediaId: string,
  patch: MediaPatch,
): Promise<MediaView> {
  assertSellerPermission(membership, SellerPermission.MEDIA_UPLOAD);
  await loadEditableDraft(membership, draftId);

  const row = await prisma.sellerListingDraftMedia.findUnique({
    where: { id: mediaId },
    select: { id: true, draftId: true, kind: true },
  });

  if (row === null || row.draftId !== draftId) throw notFound('File');

  if (patch.isPrimary === true && row.kind === 'VIDEO') {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The main image cannot be a video — a search result and an order confirmation cannot play one.',
      [{ field: 'isPrimary', code: 'VIDEO_CANNOT_BE_PRIMARY' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    if (patch.isPrimary === true) {
      await tx.sellerListingDraftMedia.updateMany({
        where: { draftId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    await tx.sellerListingDraftMedia.update({
      where: { id: mediaId },
      data: {
        ...(patch.slot === undefined || patch.slot === null
          ? {}
          : { slot: patch.slot as ListingMediaSlot }),
        ...(patch.altText === undefined ? {} : { altText: patch.altText }),
        ...(patch.isPrimary === undefined ? {} : { isPrimary: patch.isPrimary }),
        ...(patch.sortOrder === undefined || patch.sortOrder === null
          ? {}
          : { sortOrder: patch.sortOrder }),
      },
    });
  });

  const updated = await prisma.sellerListingDraftMedia.findUniqueOrThrow({ where: { id: mediaId } });
  return toView(updated);
}
