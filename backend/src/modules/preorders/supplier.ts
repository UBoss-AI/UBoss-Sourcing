/**
 * Who answers a preorder: the seller, or - for the operator's own products -
 * the operator's staff in the admin console.
 *
 * Every supplier action (accept, counter, refuse, production started, ready)
 * takes a `Responder`, and the one access rule is that the request's
 * `sellerAccountId` equals the responder's: a seller's id for a seller, NULL
 * for the operator. A seller can therefore never act on the operator's
 * preorders or another seller's, and staff can never answer for a seller.
 */
import { Permission } from '../../domain/permissions.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  AdminNotificationKind,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import type { SellerMembership } from '../seller/account.service.js';
import {
  notifySeller,
  resolveSellerNotifications,
  type NotifyInput,
} from '../seller/notification.service.js';

/**
 * `displayName` is who the BUYER is told answered - the seller's trading name,
 * or the store's own name for staff. `staffEmail` is who actually pressed the
 * button, for the operator's audit log; never shown to the buyer.
 */
export type Responder =
  | { kind: 'SELLER'; sellerAccountId: string; displayName: string; userId: null; staffEmail: null }
  | {
      kind: 'OPERATOR';
      sellerAccountId: null;
      displayName: string;
      userId: string;
      staffEmail: string;
    };

export function sellerResponder(membership: SellerMembership): Responder {
  return {
    kind: 'SELLER',
    sellerAccountId: membership.sellerAccountId,
    displayName: membership.displayName,
    userId: null,
    staffEmail: null,
  };
}

export async function operatorResponder(user: { id: string; email: string }): Promise<Responder> {
  const profile = await prisma.businessProfile.findFirst({ select: { displayName: true } });
  return {
    kind: 'OPERATOR',
    sellerAccountId: null,
    displayName: profile?.displayName ?? 'The store',
    userId: user.id,
    staffEmail: user.email,
  };
}

/**
 * Tell whoever supplies this preorder. A seller gets their Seller Hub
 * notification exactly as before; for the operator's own product the admin
 * bell raises an alert (or a notice), worded by the admin panel in the
 * reader's language from `requestNumber` and `event`.
 */
export async function notifySupplier(
  input: Omit<NotifyInput, 'sellerAccountId'> & {
    sellerAccountId: string | null;
    requestNumber: string;
  },
): Promise<void> {
  const { sellerAccountId, requestNumber, ...rest } = input;
  if (sellerAccountId !== null) {
    await notifySeller({ ...rest, sellerAccountId });
    return;
  }
  const isAlert = (input.class ?? 'INFORMATION') === 'ALERT';
  const subjectId = input.subjectId ?? null;
  await createAdminNotification(
    {
      kind: isAlert
        ? AdminNotificationKind.PREORDER_AWAITING_OPERATOR
        : AdminNotificationKind.PREORDER_UPDATE,
      variables: { requestNumber, event: input.kind },
      linkPath: subjectId === null ? '/preorders' : `/preorders/${subjectId}`,
      requiredPermission: Permission.ORDER_READ,
      relatedType: 'preorder_request',
      ...(subjectId === null ? {} : { relatedId: subjectId }),
      ...(input.dedupeKey === undefined || input.dedupeKey === null
        ? {}
        : { dedupeKey: `operator:${input.dedupeKey}` }),
      ...(isAlert && input.resolutionKey !== undefined && input.resolutionKey !== null
        ? { resolutionKey: input.resolutionKey }
        : {}),
    },
    input.tx,
  );
}

/** Close the supplier's open alerts about this preorder, wherever they were raised. */
export async function resolveSupplierNotifications(
  input: { resolutionKey: string; note: string },
  tx?: PrismaTransaction,
): Promise<void> {
  await resolveSellerNotifications({ resolutionKey: input.resolutionKey, note: input.note }, tx);
  await resolveAdminNotifications(
    { resolutionKey: input.resolutionKey, reason: input.note, source: 'DOMAIN_EVENT' },
    tx,
  );
}
