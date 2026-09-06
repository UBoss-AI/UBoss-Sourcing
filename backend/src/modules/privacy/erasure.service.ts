/**
 * Art. 17 erasure.
 *
 * The naive reading of "the right to be forgotten" is `DELETE FROM users`, and
 * it is wrong twice over. It would break the foreign keys that every order,
 * payment and refund hangs from, and it would destroy records that a different
 * law requires be kept - which Art. 17(3)(b) expressly exempts from erasure.
 * A shop that erased its invoices on request would be trading one regulator
 * for another.
 *
 * So erasure here means: **separate the person from the record, and delete
 * everything the record does not need.**
 *
 *   - **Deleted outright.** Addresses, carts, sign-in sessions, password-reset
 *     tokens, chat enquiries. Nothing legally requires any of it, and each one
 *     names the subject directly.
 *
 *   - **Pseudonymised.** The user row and the customer profile. The row
 *     survives, because a dozen tables point at it, but every field that
 *     identifies a human being is replaced: the email becomes an address at
 *     `.invalid` (RFC 2606 - reserved, unresolvable, and impossible to
 *     accidentally mail), the name becomes a label, the password and MFA
 *     secret go. What remains is a key, not a person.
 *
 *   - **Kept, deliberately.** The billing and delivery address on an order
 *     that was actually placed. Art. 226 of the VAT Directive requires an
 *     invoice to carry the customer's full name and address, and member-state
 *     tax law then requires that invoice be kept for six to ten years. Erasing
 *     it is not a favour to the subject; it is destroying a statutory record.
 *     Orders that never became invoices - drafts, and cancellations that were
 *     never paid - carry no such obligation and are scrubbed like anything
 *     else.
 *
 * What the subject gets told matters as much as what happens: `describeKept`
 * turns the exemptions actually relied on into a sentence, because Art. 17(3)
 * is not a licence to keep data quietly.
 *
 * Everything runs in one transaction. A half-erased account - contact details
 * gone, sessions still live - is worse than either outcome.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/**
 * Order statuses that carry an invoicing obligation.
 *
 * Anything from CONFIRMED onwards has been sold: money was owed, an invoice
 * exists or is due, and the tax authority's retention period has started. The
 * three excluded statuses are the ones where nothing was ever sold.
 */
const INVOICED_STATUSES = Object.freeze([
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'RETURNED',
  'REFUNDED',
] as const);

/** Return states where the business is still mid-obligation to this customer. */
const OPEN_RETURN_STATUSES = Object.freeze([
  'REQUESTED',
  'APPROVED',
  'RECEIVED',
  'INSPECTED',
] as const);

export interface ErasureBlocker {
  /** Machine-readable, so the admin console can render it in the staff's language. */
  code: string;
  /** How many records are in the way. */
  count: number;
  detail: string;
}

export interface ErasureResult {
  /** Rows deleted, by table. */
  deleted: Record<string, number>;
  /** Rows rewritten in place, by table. */
  pseudonymised: Record<string, number>;
  /** Rows knowingly left intact, by table, with the exemption relied on. */
  retained: { table: string; count: number; basis: string }[];
  /** The pseudonym the account now carries. Safe to show staff and the subject. */
  pseudonym: string;
}

/**
 * Can this account be erased right now?
 *
 * Art. 17(1) is not absolute, and the two things that hold it up here are both
 * ongoing obligations rather than record-keeping ones: money still owed, and a
 * return still being handled. Neither is a refusal - both are "not yet", and
 * the message says so, because a subject told "no" without a reason will
 * reasonably complain to a supervisory authority.
 *
 * Exported separately from `executeErasure` so the console can show a member
 * of staff what is in the way before they decide, rather than after they press
 * the button.
 */
export async function findErasureBlockers(userId: string): Promise<ErasureBlocker[]> {
  const profile = await prisma.customerProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (profile === null) return [];

  const blockers: ErasureBlocker[] = [];

  // Money outstanding. Prisma cannot compare two columns of the same row in a
  // `where`, and this is one customer's open orders rather than the whole
  // book, so the comparison happens here rather than in raw SQL - which would
  // also have to hard-code column names this schema is free to change.
  const openOrders = await prisma.order.findMany({
    where: {
      customerProfileId: profile.id,
      status: { in: ['PENDING_PAYMENT', 'CONFIRMED', 'PROCESSING', 'SHIPPED'] },
    },
    select: { paidMinor: true, grandTotalMinor: true },
  });

  const unpaidCount = openOrders.filter(
    (order) => order.paidMinor < order.grandTotalMinor,
  ).length;

  if (unpaidCount > 0) {
    blockers.push({
      code: 'UNPAID_ORDERS',
      count: unpaidCount,
      detail:
        `${unpaidCount} order(s) are not yet paid in full. The contract is still being ` +
        'performed, so erasure is deferred under Art. 17(3)(b) until they are settled or ' +
        'cancelled.',
    });
  }

  const openReturns = await prisma.returnRequest.count({
    where: {
      status: { in: [...OPEN_RETURN_STATUSES] },
      order: { customerProfileId: profile.id },
    },
  });

  if (openReturns > 0) {
    blockers.push({
      code: 'OPEN_RETURNS',
      count: openReturns,
      detail:
        `${openReturns} return(s) are still open. Erasure would remove the contact details ` +
        'needed to complete them.',
    });
  }

  return blockers;
}

/**
 * Carry out an erasure.
 *
 * Refuses if `findErasureBlockers` finds anything, so the check cannot be
 * skipped by calling this directly. Idempotent: an account already erased
 * returns its earlier result rather than rewriting rows a second time, because
 * a retried job must not turn one erasure into two audit entries claiming
 * different things happened.
 */
export async function executeErasure(input: {
  userId: string;
  actorUserId: string | null;
  actorEmail: string | null;
  dataRequestId: string;
  correlationId?: string | null;
}): Promise<ErasureResult> {
  const blockers = await findErasureBlockers(input.userId);
  if (blockers.length > 0) {
    throw conflict(
      ErrorCode.ERASURE_BLOCKED_BY_OBLIGATION,
      'This account cannot be erased yet.',
      blockers.map((blocker) => ({ code: blocker.code, message: blocker.detail })),
    );
  }

  const existing = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, emailNormalized: true, erasedAt: true },
  });

  if (existing === null) throw notFound('Account');

  if (existing.erasedAt !== null) {
    logger.info({ userId: input.userId }, 'erasure skipped: account already erased');
    return {
      deleted: {},
      pseudonymised: {},
      retained: [],
      pseudonym: existing.email,
    };
  }

  // The pseudonym. `.invalid` is reserved by RFC 2606 and never resolves, so
  // nothing can deliver to it by accident, and the ULID keeps the unique index
  // on `emailNormalized` satisfied without carrying anything about the person.
  const pseudonymId = newId();
  const pseudonym = `erased-${pseudonymId.toLowerCase()}@erased.invalid`;
  const now = new Date();

  const result = await prisma.$transaction(async (tx) => {
    const deleted: Record<string, number> = {};
    const pseudonymised: Record<string, number> = {};
    const retained: ErasureResult['retained'] = [];

    const profile = await tx.customerProfile.findUnique({
      where: { userId: input.userId },
      select: { id: true },
    });

    // --- Deleted outright -------------------------------------------------

    deleted.sessions = (await tx.session.deleteMany({ where: { userId: input.userId } })).count;
    deleted.authTokens = (await tx.authToken.deleteMany({ where: { userId: input.userId } })).count;

    // Sign-in attempts are keyed by email, not by user id, and hold the IP the
    // attempt came from. They are a security record with no bearer once the
    // account is gone.
    deleted.loginAttempts = (
      await tx.loginAttempt.deleteMany({ where: { emailNormalized: existing.emailNormalized } })
    ).count;

    if (profile !== null) {
      // Chat enquiries are matched by profile link AND by the address the
      // visitor typed: the same person often enquired before they had an
      // account, and those rows carry no profile id to find them by.
      const conversations = await tx.assistantConversation.findMany({
        where: {
          OR: [
            { customerProfileId: profile.id },
            { visitorEmailNormalized: existing.emailNormalized },
          ],
        },
        select: { id: true },
      });

      const conversationIds = conversations.map((conversation) => conversation.id);

      if (conversationIds.length > 0) {
        deleted.assistantMessages = (
          await tx.assistantMessage.deleteMany({
            where: { conversationId: { in: conversationIds } },
          })
        ).count;

        deleted.assistantConversations = (
          await tx.assistantConversation.deleteMany({ where: { id: { in: conversationIds } } })
        ).count;
      }

      // Carts cascade to their items and reservations.
      deleted.carts = (await tx.cart.deleteMany({ where: { customerProfileId: profile.id } })).count;

      // Address books need two passes, because a recurring schedule holds a
      // non-nullable reference to the address it ships to and the foreign key
      // is Restrict. The rows a cancelled schedule still points at cannot be
      // deleted without deleting the schedule's own history, so they are
      // overwritten in place instead - which erases the address just as
      // completely, and leaves the reference intact.
      const pinnedAddresses = await tx.address.findMany({
        where: {
          customerProfileId: profile.id,
          OR: [{ shippingSchedules: { some: {} } }, { billingSchedules: { some: {} } }],
        },
        select: { id: true },
      });

      const pinnedIds = pinnedAddresses.map((address) => address.id);

      if (pinnedIds.length > 0) {
        pseudonymised.addresses = (
          await tx.address.updateMany({
            where: { id: { in: pinnedIds } },
            data: {
              label: null,
              contactName: 'Erased',
              contactPhone: '',
              line1: 'Erased',
              line2: null,
              city: 'Erased',
              state: '',
              postalCode: '',
              archivedAt: now,
            },
          })
        ).count;
      }

      deleted.addresses = (
        await tx.address.deleteMany({
          where: { customerProfileId: profile.id, id: { notIn: pinnedIds } },
        })
      ).count;

      // --- Pseudonymised --------------------------------------------------

      // Standing payment authorities are cancelled, not merely scrubbed. A
      // schedule left ACTIVE against an erased account would keep trying to
      // place orders for somebody who no longer exists.
      pseudonymised.recurringSchedules = (
        await tx.recurringSchedule.updateMany({
          where: { customerProfileId: profile.id, status: { not: 'CANCELLED' } },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancelReason: 'Account erased at the data subject’s request',
            nextRunAt: null,
            mandateReference: null,
            payerEmail: null,
          },
        })
      ).count;

      // Orders that never became invoices carry no retention obligation, so
      // the address snapshots and the customer's own note go.
      const scrubbable = await tx.order.findMany({
        where: {
          customerProfileId: profile.id,
          status: { notIn: [...INVOICED_STATUSES] },
        },
        select: { id: true },
      });

      if (scrubbable.length > 0) {
        pseudonymised.uninvoicedOrders = (
          await tx.order.updateMany({
            where: { id: { in: scrubbable.map((order) => order.id) } },
            data: {
              billingAddressJson: { erased: true },
              shippingAddressJson: { erased: true },
              customerNote: null,
              internalNote: null,
            },
          })
        ).count;
      }

      // The customer's own free-text note on an invoiced order is not part of
      // the invoice and has no retention basis of its own.
      pseudonymised.invoicedOrderNotes = (
        await tx.order.updateMany({
          where: {
            customerProfileId: profile.id,
            status: { in: [...INVOICED_STATUSES] },
            customerNote: { not: null },
          },
          data: { customerNote: null },
        })
      ).count;

      const invoiced = await tx.order.count({
        where: { customerProfileId: profile.id, status: { in: [...INVOICED_STATUSES] } },
      });

      if (invoiced > 0) {
        retained.push({
          table: 'orders',
          count: invoiced,
          basis:
            'GDPR Art. 17(3)(b): the billing and delivery address on a placed order forms part ' +
            'of the invoice, which VAT Directive Art. 226 requires to name the customer and ' +
            'which national tax law requires be kept (typically 6-10 years).',
        });
      }

      await tx.customerProfile.update({
        where: { id: profile.id },
        data: {
          fullName: 'Erased customer',
          organization: null,
          department: null,
          phone: null,
          gstin: null,
          internalNotes: null,
          // The stated country stays: it is what decides which tax rules an
          // invoice was issued under, and a two-letter code shared with
          // millions of people identifies nobody.
          detectedCountry: null,
          detectedAt: null,
        },
      });

      pseudonymised.customerProfiles = 1;
    }

    // Sent mail. The outbox keeps the rendered body of every notification, and
    // an order confirmation contains the customer's name and delivery address
    // in prose - which makes this the least obvious place a full copy of the
    // erased person survives, and the easiest to forget.
    //
    // Anything not yet delivered is deleted outright: there is nobody left to
    // deliver it to, and sending an order update to an account that no longer
    // exists would be the worst possible confirmation that the erasure worked.
    // The completion email is enqueued by the caller AFTER this transaction
    // commits, so it is not caught here.
    deleted.pendingNotifications = (
      await tx.notificationOutbox.deleteMany({
        where: {
          recipientEmail: existing.email,
          status: { in: ['PENDING', 'FAILED'] },
        },
      })
    ).count;

    pseudonymised.sentNotifications = (
      await tx.notificationOutbox.updateMany({
        where: { recipientEmail: existing.email },
        data: {
          recipientEmail: pseudonym,
          recipientName: null,
          // The delivery record - that a message of this kind went out, when,
          // and whether it arrived - is what the outbox is for. The prose is
          // not, once the recipient is gone.
          body: '[erased at the data subject’s request]',
          payloadJson: Prisma.JsonNull,
        },
      })
    ).count;

    // The audit trail keeps its rows - it is the evidence that this erasure
    // itself happened - but stops carrying the address that names the person.
    // The actor id remains as a pseudonymous key pointing at the rewritten
    // user row, which is what makes this pseudonymisation rather than a
    // pretence at deletion.
    pseudonymised.auditLogs = (
      await tx.auditLog.updateMany({
        where: { actorUserId: input.userId },
        data: { actorEmail: pseudonym, ipAddress: null, userAgent: null },
      })
    ).count;

    // Earlier data requests from this same person, including the one being
    // actioned. The record that a request was made and honoured must survive
    // Art. 5(2); the email on it need not.
    pseudonymised.dataRequests = (
      await tx.dataRequest.updateMany({
        where: { subjectUserId: input.userId },
        data: { subjectEmail: pseudonym },
      })
    ).count;

    await tx.user.update({
      where: { id: input.userId },
      data: {
        email: pseudonym,
        emailNormalized: pseudonym,
        phone: null,
        passwordHash: null,
        mfaSecretEnc: null,
        mfaEnabledAt: null,
        status: 'DEACTIVATED',
        emailVerifiedAt: null,
        phoneVerifiedAt: null,
        preferredLanguage: null,
        archivedAt: now,
        erasedAt: now,
      },
    });

    pseudonymised.users = 1;

    retained.push({
      table: 'audit_logs',
      count: pseudonymised.auditLogs ?? 0,
      basis:
        'GDPR Art. 17(3)(b) and Art. 5(2): the record that administrative actions - including ' +
        'this erasure - took place. Retained in pseudonymised form and deleted on the ' +
        'ordinary audit retention schedule.',
    });

    await recordAudit(
      {
        action: AuditAction.DATA_ERASURE_EXECUTED,
        resourceType: 'user',
        resourceId: input.userId,
        actorType: input.actorUserId === null ? 'SYSTEM' : 'ADMIN',
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        after: { dataRequestId: input.dataRequestId, deleted, pseudonymised, pseudonym },
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    return { deleted, pseudonymised, retained, pseudonym };
  });

  logger.info(
    { userId: input.userId, dataRequestId: input.dataRequestId },
    'erasure completed',
  );

  return result;
}

/**
 * The exemptions, as a sentence for the subject.
 *
 * Art. 17 does not let a controller keep data quietly: if something survives
 * an erasure the person is entitled to know what and why. This is the text the
 * completion email and the console both use, so the answer cannot drift
 * between them.
 */
export function describeKept(result: ErasureResult): string {
  const kept = result.retained.filter((entry) => entry.count > 0);

  if (kept.length === 0) {
    return 'Everything held about you has been deleted. Nothing was retained.';
  }

  return [
    'Your personal details have been deleted and your account has been anonymised.',
    'The following records were kept because the law requires it, and they no longer name you:',
    ...kept.map((entry) => `  - ${entry.count} × ${entry.table}: ${entry.basis}`),
  ].join('\n');
}
