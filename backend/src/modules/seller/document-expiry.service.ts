/**
 * An approved seller whose REQUIRED document has expired stops trading until a
 * current one is accepted.
 *
 * Run by the worker (`SELLER_DOCUMENT_EXPIRY_SWEEP`, hourly). A certificate
 * that ran out in March is not evidence in April, and the approval it
 * supported rested on it. The seller is moved to ACTION_REQUIRED by the
 * SYSTEM actor - the state machine allows exactly that move for exactly this
 * reason - with a reason naming the document and the date, and is told in
 * their notifications. Their listings stop being buyable because only
 * APPROVED trades; nothing else is touched, and once a renewal is accepted and
 * they resubmit, a reviewer approves them again.
 *
 * Optional documents never do this. An expired optional certificate only
 * shows as expired on the checklist.
 *
 * Idempotent: a seller already moved is no longer APPROVED, so a second pass
 * finds nothing to do.
 *
 * Email: the seller Hub has no email channel of its own - every seller notice
 * is an in-app notification (`notifySeller`) - so this uses that, like every
 * other application decision.
 */
import { prisma } from '../../infra/prisma.js';
import { logger } from '../../infra/logger.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { transitionApplication } from './account.service.js';
import { notifySeller } from './notification.service.js';
import { markRequirementSteps, requirementsFor } from './onboarding.service.js';

/** How many sellers one pass looks at. The next hour picks up the rest. */
const BATCH = 200;

function day(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Move every approved seller with an expired required document to
 * ACTION_REQUIRED. Returns how many were moved.
 */
export async function sweepExpiredSellerDocuments(now: Date = new Date()): Promise<number> {
  // Sellers with at least one current, accepted document past its date. The
  // requirement check below decides whether that document mattered.
  const candidates = await prisma.sellerAccount.findMany({
    where: {
      status: 'APPROVED',
      archivedAt: null,
      documents: {
        some: { supersededAt: null, approvedAt: { not: null }, expiresOn: { lt: now } },
      },
    },
    select: { id: true, kind: true, registrationCountry: true },
    take: BATCH,
  });

  let moved = 0;

  for (const seller of candidates) {
    try {
      const [requirements, documents] = await Promise.all([
        requirementsFor(seller.registrationCountry, seller.kind),
        prisma.sellerDocument.findMany({
          where: { sellerAccountId: seller.id, supersededAt: null, approvedAt: { not: null } },
          select: { requirementFieldKey: true, expiresOn: true },
        }),
      ]);

      // A required document with an accepted copy, none of them in date.
      const lapsed = requirements
        .filter((requirement) => requirement.isDocument && requirement.isRequired)
        .map((requirement) => {
          const accepted = documents.filter((document) => document.requirementFieldKey === requirement.fieldKey);
          const inDate = accepted.some(
            (document) => document.expiresOn === null || document.expiresOn.getTime() >= now.getTime(),
          );
          const expiredOn = accepted
            .map((document) => document.expiresOn)
            .filter((value): value is Date => value !== null)
            .sort((a, b) => b.getTime() - a.getTime())[0];
          return accepted.length > 0 && !inDate && expiredOn !== undefined
            ? { label: requirement.label, expiredOn }
            : null;
        })
        .filter((entry): entry is { label: string; expiredOn: Date } => entry !== null);

      if (lapsed.length === 0) continue;

      const reason =
        lapsed.map((entry) => `Your ${entry.label} expired on ${day(entry.expiredOn)}.`).join(' ') +
        ' Upload a current one and send your application again to keep selling.';

      await transitionApplication({
        sellerAccountId: seller.id,
        to: 'ACTION_REQUIRED',
        actor: 'SYSTEM',
        actorLabel: 'Document expiry check',
        reason,
      });

      await recordAudit({
        action: AuditAction.SELLER_APPLICATION_LAPSED,
        resourceType: 'seller_account',
        resourceId: seller.id,
        actorType: 'SYSTEM',
        actorUserId: null,
        actorEmail: null,
        before: { status: 'APPROVED' },
        after: { status: 'ACTION_REQUIRED', expiredDocuments: lapsed.map((entry) => entry.label) },
      });

      await markRequirementSteps({ sellerAccountId: seller.id, registrationCountry: seller.registrationCountry });

      await notifySeller({
        sellerAccountId: seller.id,
        kind: 'APPLICATION_STATUS',
        title: 'A document you sell under has expired',
        body: reason,
        linkPath: '/seller/onboarding',
        severity: 'WARNING',
        subjectType: 'seller_account',
        subjectId: seller.id,
      });

      moved += 1;
    } catch (error) {
      // One seller's failure must not stop the rest; the next pass retries it.
      logger.error({ err: error, sellerAccountId: seller.id }, 'seller document expiry check failed');
    }
  }

  return moved;
}
