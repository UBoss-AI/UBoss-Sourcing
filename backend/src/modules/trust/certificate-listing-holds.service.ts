/** Certificate expiry policy for the listings that explicitly depend on it. */
import type { PrismaTransaction } from '../../infra/prisma.js';
import { newId } from '../../infra/ids.js';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { syncMarketplacePriceForOffer } from '../catalog/marketplace-price.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';

const HOLD_REASON = 'A linked certificate expired. Renew it and have the marketplace verify it before this listing goes back on sale.';

async function lockOffer(tx: PrismaTransaction, offerId: string): Promise<void> {
  // MariaDB row lock: two certificate decisions cannot create duplicate holds
  // or restore an offer while another certificate is still holding it.
  await tx.$queryRaw`SELECT id FROM seller_offers WHERE id = ${offerId} FOR UPDATE`;
}

export async function holdCertificateListings(tx: PrismaTransaction, certificate: { id: string; sellerAccountId: string }): Promise<void> {
  const settings = await tx.trustSettings.findUnique({ where: { id: 'default' }, select: { certificateExpiryPolicy: true } });
  if (settings?.certificateExpiryPolicy !== 'HOLD_LISTINGS') return;
  const links = await tx.sellerListingCertification.findMany({
    where: { certificationId: certificate.id, listingTrust: { sellerAccountId: certificate.sellerAccountId } },
    select: { listingTrust: { select: { productId: true } } },
  });
  const offers = await tx.sellerOffer.findMany({
    where: { sellerAccountId: certificate.sellerAccountId, productId: { in: links.map(link => link.listingTrust.productId) }, archivedAt: null },
    select: { id: true }, orderBy: { id: 'asc' },
  });
  for (const { id } of offers) {
    await lockOffer(tx, id);
    const offer = await tx.sellerOffer.findUniqueOrThrow({ where: { id }, include: { complianceHolds: { where: { releasedAt: null }, orderBy: { heldAt: 'asc' } } } });
    if (offer.complianceHolds.some(hold => hold.certificationId === certificate.id)) continue;
    // Existing marketplace blocks and unrelated needs-changes reasons stay intact.
    const first = offer.complianceHolds[0];
    if (offer.status !== 'ACTIVE' && first === undefined) continue;
    if (offer.status === 'ARCHIVED' || offer.status === 'BLOCKED') continue;
    await tx.sellerOfferComplianceHold.create({ data: { id: newId(), offerId: id, certificationId: certificate.id, previousStatus: first?.previousStatus ?? offer.status } });
    if (offer.status === 'ACTIVE') {
      await tx.sellerOffer.update({ where: { id }, data: { status: 'NEEDS_CHANGES', statusReason: HOLD_REASON, version: { increment: 1 } } });
      await syncMarketplacePriceForOffer(tx, id);
    }
    await recordSellerAudit({ tx, sellerAccountId: offer.sellerAccountId, action: 'seller.listing.certificate_held', actor: { type: 'SYSTEM', label: 'Certificate expiry check' }, resourceType: 'seller_offer', resourceId: id, before: { status: offer.status }, after: { certificationId: certificate.id, held: true }, summary: HOLD_REASON });
  }
}

/** Also protects an idle listing whose certificate expired before it was resumed. */
async function certificateListingIsClear(tx: PrismaTransaction, offerId: string): Promise<boolean> {
  const offer = await tx.sellerOffer.findUniqueOrThrow({ where: { id: offerId }, select: { sellerAccountId: true, productId: true, complianceHolds: { where: { releasedAt: null }, select: { id: true } } } });
  if (offer.complianceHolds.length > 0) return false;
  const settings = await tx.trustSettings.findUnique({ where: { id: 'default' }, select: { certificateExpiryPolicy: true } });
  if (settings?.certificateExpiryPolicy !== 'HOLD_LISTINGS') return true;
  const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
  const unusable = await tx.sellerListingCertification.count({
    where: { listingTrust: { sellerAccountId: offer.sellerAccountId, productId: offer.productId }, certification: { OR: [{ state: { not: 'VERIFIED' } }, { archivedAt: { not: null } }, { expiresOn: { lt: today } }] } },
  });
  return unusable === 0;
}

export async function assertCertificateListingCanTrade(tx: PrismaTransaction, offerId: string): Promise<void> {
  if (!await certificateListingIsClear(tx, offerId)) throw conflict(ErrorCode.LISTING_TRANSITION_NOT_ALLOWED, HOLD_REASON);
}

/** A verified renewal lifts only this certificate's holds and only our status. */
export async function releaseCertificateListings(tx: PrismaTransaction, certificationId: string): Promise<void> {
  const holds = await tx.sellerOfferComplianceHold.findMany({ where: { certificationId, releasedAt: null }, orderBy: { offerId: 'asc' } });
  for (const hold of holds) {
    await lockOffer(tx, hold.offerId);
    const moved = await tx.sellerOfferComplianceHold.updateMany({ where: { id: hold.id, releasedAt: null }, data: { releasedAt: new Date() } });
    if (moved.count === 0) continue;
    const offer = await tx.sellerOffer.findUniqueOrThrow({ where: { id: hold.offerId } });
    const remaining = await tx.sellerOfferComplianceHold.count({ where: { offerId: offer.id, releasedAt: null } });
    if (remaining === 0 && offer.status === 'NEEDS_CHANGES' && offer.statusReason === HOLD_REASON && offer.archivedAt === null && await certificateListingIsClear(tx, offer.id)) {
      await tx.sellerOffer.update({ where: { id: offer.id }, data: { status: hold.previousStatus, statusReason: null, version: { increment: 1 } } });
      await syncMarketplacePriceForOffer(tx, offer.id);
    }
    await recordSellerAudit({ tx, sellerAccountId: offer.sellerAccountId, action: 'seller.listing.certificate_released', actor: { type: 'SYSTEM', label: 'Certificate renewal check' }, resourceType: 'seller_offer', resourceId: offer.id, after: { certificationId, held: false }, summary: 'The renewed certificate was verified; its listing hold was released.' });
  }
}
