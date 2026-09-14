/**
 * A seller's own mark.
 *
 * One image, on the seller's own shop front. Without it that shop renders the
 * seller's initial in a plate, which works — but a business given its own web
 * address and its own catalogue and then denied its own logo has been given
 * half a shop.
 *
 * WHY NOT A `MediaAsset`
 *
 * That table is the OPERATOR's catalogue library: reachable from their media
 * picker, counted in their reports, deletable by their staff. A seller's brand
 * mark is none of those things, and putting it there would be a seller writing
 * into the operator's library. `SellerDocument` already stores a seller's own
 * files as a bare storage key for exactly this reason, and this follows it.
 *
 * WHAT DECIDES THE TYPE
 *
 * The bytes, never the `Content-Type` header and never the filename. A client
 * can claim anything, and an SVG renamed `logo.png` is a script-capable
 * document served inline — which on a seller's own subdomain is stored XSS
 * against their shoppers. `sniffImageType` reads the magic bytes and refuses
 * everything it does not recognise, SVG included.
 *
 * REPLACING DELETES THE OLD ONE
 *
 * A logo is replaced rather than versioned: nothing references an old one, and
 * leaving it behind is an object nobody can reach and nobody will ever remove.
 * The delete is best-effort — a storage failure must not stop the seller's new
 * logo being the one their shop shows.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  assertWithinSizeLimit,
  sniffImageType,
  storage,
} from '../../infra/storage/index.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { SellerPermission } from '../../domain/seller-permissions.js';

export interface SellerLogoView {
  /** Built on read from the key, so moving the store does not break it. */
  url: string | null;
}

/** The public URL of a seller's logo, or null where they have none. */
export function logoUrlFor(storageKey: string | null): string | null {
  return storageKey === null || storageKey.length === 0 ? null : storage.urlFor(storageKey);
}

export async function uploadSellerLogo(input: {
  membership: SellerMembership;
  buffer: Buffer;
  correlationId?: string | null;
}): Promise<SellerLogoView> {
  const { membership, buffer } = input;

  /*
   * `ACCOUNT_WRITE`, not a permission of its own.
   *
   * Changing the mark on the shop front is the same authority as changing the
   * name above it, and inventing a key for it would be one more row in a
   * permission matrix an operator has already configured.
   */
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);

  assertWithinSizeLimit(buffer.byteLength);

  // The bytes decide. A claimed content type is a claim.
  const sniffed = sniffImageType(buffer);

  const account = await prisma.sellerAccount.findUniqueOrThrow({
    where: { id: membership.sellerAccountId },
    select: { logoStorageKey: true },
  });

  const stored = await storage.put(buffer, sniffed.mimeType, sniffed.extension, 'public');

  await prisma.sellerAccount.update({
    where: { id: membership.sellerAccountId },
    data: { logoStorageKey: stored.storageKey },
  });

  // Only after the new one is safely the seller's. Losing the old file while
  // the new one has not been recorded would leave a shop with no logo at all.
  await removeObject(account.logoStorageKey);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.logo.updated',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_account',
    resourceId: membership.sellerAccountId,
    summary: 'The shop logo was changed.',
    correlationId: input.correlationId ?? null,
  });

  return { url: logoUrlFor(stored.storageKey) };
}

export async function removeSellerLogo(input: {
  membership: SellerMembership;
  correlationId?: string | null;
}): Promise<void> {
  const { membership } = input;

  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);

  const account = await prisma.sellerAccount.findUniqueOrThrow({
    where: { id: membership.sellerAccountId },
    select: { logoStorageKey: true },
  });

  if (account.logoStorageKey === null) {
    throw badRequest(ErrorCode.NOT_FOUND, 'There is no logo to remove.', [
      { field: 'logo', code: 'NOT_SET' },
    ]);
  }

  await prisma.sellerAccount.update({
    where: { id: membership.sellerAccountId },
    data: { logoStorageKey: null },
  });

  await removeObject(account.logoStorageKey);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.logo.removed',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_account',
    resourceId: membership.sellerAccountId,
    summary: 'The shop logo was removed.',
    correlationId: input.correlationId ?? null,
  });
}

/**
 * Delete an object, swallowing a storage failure.
 *
 * The row has already been updated, which is the part that decides what the
 * shop shows. A file that outlives its row is litter; a row pointing at a file
 * that was deleted first is a shop with a broken image on it.
 */
async function removeObject(storageKey: string | null): Promise<void> {
  if (storageKey === null || storageKey.length === 0) return;

  try {
    await storage.delete(storageKey);
  } catch {
    // Deliberately ignored. See above.
  }
}
