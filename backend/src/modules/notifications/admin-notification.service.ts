/**
 * Console notifications - the bell in the Admin Panel's top bar.
 *
 * Deliberately not the outbox next door. `notification.service.ts` is mail
 * leaving the building: a template, a recipient address, a delivery worker and
 * a retry schedule. This is the opposite direction - something happened inside
 * the system and the people running it should see it the next time they look
 * at any screen, without an email arriving and without opening the dashboard.
 *
 * Three decisions worth keeping from the original design:
 *
 *   - **Written inside the caller's transaction**, like the audit trail. An
 *     order that rolls back must not leave a notification claiming somebody
 *     bought something, and an order that commits must not lose its one.
 *   - **No stored prose.** A row carries its `kind` and the values that fill
 *     it; the panel renders the sentence from its own catalogue in whatever
 *     language the reader chose. Rendering English at write time would leave
 *     every non-English console permanently half-translated.
 *   - **Permission carried per row.** An order notification names a customer
 *     and a total, so only staff holding `order.read` see it. Putting the
 *     grant on the row rather than on the endpoint keeps the bell inside the
 *     permission model as further kinds are added.
 *
 * ===========================================================================
 * NEWS AND PROBLEMS ARE NOT THE SAME THING
 * ===========================================================================
 *
 * The bell used to hold one piece of state per row: whether you had opened it.
 * That made "I have seen this" and "this has been dealt with" the same fact.
 * They are not, and conflating them fails in both directions - a temperature
 * excursion cleared itself the moment somebody glanced at the bell, and an
 * exception that was genuinely closed at nine o'clock sat in the feed until
 * the ninety-day prune took it.
 *
 * So every row is one of two things, and they clear in opposite ways:
 *
 *   - **INFORMATION.** A customer placed an order. True forever, nobody can
 *     fix it, and the reader is the only one who can decide they are done with
 *     it. Cleared by being read, **per reader**.
 *   - **ALERT.** A consignment went warm. Stays worth acting on until the
 *     underlying problem reaches a terminal state, whether or not anybody has
 *     looked. Cleared by the problem being fixed, **for everybody**.
 *
 * THE ACTIVE-ALERT RULE, WRITTEN DOWN ONCE
 *
 * A row contributes to the badge when the caller may see it, the caller has
 * not dismissed it, and either
 *
 *   * it is INFORMATION the caller has not read, or
 *   * it is an ALERT whose `status` is ACTIVE.
 *
 * `activeAlertClause` below is that sentence in Prisma, and the feed, the
 * badge and the mark-all all read it rather than each writing their own - so
 * they cannot disagree about what is waiting.
 *
 * FIVE STATES, TWO PLACES
 *
 * Where a piece of state lives is decided by whose fact it is:
 *
 *   | State        | Stored on                    | Whose fact |
 *   |--------------|------------------------------|------------|
 *   | Unread       | absence of a read row        | one reader |
 *   | Read         | `AdminNotificationRead`      | one reader |
 *   | Dismissed    | `AdminNotificationRead`      | one reader |
 *   | Resolved     | `AdminNotification.status`   | the world  |
 *   | Archived     | `AdminNotification.status`   | the world  |
 *
 * There is no separate ACKNOWLEDGED state, and that is a decision rather than
 * an omission: the bell has no "I am on it" action to write one, and a column
 * nothing ever writes is a column that lies to whoever reads it next. Reading
 * is the acknowledgement this product has.
 *
 * READING IS NOT RESOLVING, AND DISMISSING IS NOT EITHER
 *
 * `dismiss` is the escape hatch for an alert that is somebody else's job. It
 * takes the row out of ONE person's bell and changes nothing about the
 * problem. That separation is the whole point: an operator tidying their own
 * view must not be able to make a temperature excursion look dealt with.
 *
 * RECURRENCE, AND WHY NOTHING IS EVER REOPENED
 *
 * A resolved alert is history, and history is not edited. A problem that comes
 * back gets a NEW row with the next occurrence number and its own dedupe key.
 * The resolution that was recorded stays recorded - "it was closed at nine and
 * came back at eleven" is readable, where a reopened row would have quietly
 * overwritten the first answer.
 */
import { Permission, type PermissionKey } from '../../domain/permissions.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import type {
  AdminNotificationClass,
  AdminNotificationResolutionPolicy,
  AdminNotificationResolutionSource,
  AdminNotificationStatus,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/** Console notification kinds. Each one the panel knows how to phrase. */
export const AdminNotificationKind = {
  /// A customer completed checkout. The variables are customerName,
  /// orderNumber, itemCount and orderTotal.
  ORDER_PLACED: 'order.placed',
  /// A member of staff opened the console, and where from. The variables are
  /// email, place, latitude, longitude, accuracyM and ipAddress. Carries
  /// `staff.read`, because it names a colleague and says where they were.
  ADMIN_SIGNED_IN: 'admin.signed_in',
  /// Somebody signed themselves up on the storefront and confirmed their email.
  /// The variables are fullName, email, phone, country and requiresApproval.
  /// Carries `customer.read`, because it names a person and their contact
  /// details. Raised at confirmation rather than at sign-up: an address nobody
  /// has proved they can read is not yet worth a colleague's attention.
  CUSTOMER_REGISTERED: 'customer.registered',
  /// Somebody has exercised a data subject right and it needs a decision. The
  /// variables are email, type and dueAt. Carries `data_request.read` rather
  /// than `customer.read`: that a named individual has asked to be erased is
  /// its own piece of information, and not everyone who may look a customer up
  /// should be told it unprompted.
  ///
  /// An ALERT. A statutory clock is running on it, and a badge that cleared
  /// because somebody read the row would be a badge that hid a deadline.
  DATA_REQUEST_RAISED: 'data_request.raised',
  /// A carrier reported something serious about a consignment. The variables
  /// are shipmentReference, receivingCompany, exceptionType and severity.
  ///
  /// Raised ONLY for CRITICAL severity - a temperature excursion or a lost
  /// consignment - and never for the ordinary run of address corrections and
  /// missed pickups, which the carrier works in its own portal. A bell that
  /// rings for everything is a bell nobody reads, and the one that gets
  /// ignored is the batch of reagents that went warm.
  ///
  /// Carries `logistics.read`, because it names a customer's company and what
  /// went wrong with their delivery. An ALERT, resolved by the exception
  /// itself reaching RESOLVED or CLOSED and by nothing else.
  LOGISTICS_EXCEPTION_RAISED: 'logistics.exception.raised',
  /// A seller uploaded a certificate or a licence for the marketplace to
  /// accept. The variables are sellerName, documentKind and fileName.
  ///
  /// Raised because nobody is watching that table: evidence uploaded on a
  /// Friday would otherwise sit until somebody happened to open that seller's
  /// screen, and the seller is meanwhile blocked from finishing an application.
  ///
  /// Carries `customer.read`, the same grant the seller queue itself is behind:
  /// the row names a business and what it is trying to prove about itself. An
  /// ALERT, resolved when the document is accepted, refused or superseded.
  SELLER_DOCUMENT_UPLOADED: 'seller.document.uploaded',
  /// A consignment could not be delivered. The variables are
  /// shipmentReference, receivingCompany, attemptCount and reason.
  ///
  /// An ALERT, and the one that most needed this lifecycle: a failed delivery
  /// is resolved by the parcel moving again - re-attempted, delivered, or sent
  /// back - and never by somebody reading about it. Carries `logistics.read`.
  LOGISTICS_DELIVERY_FAILED: 'logistics.delivery_failed',
  /// A consignment has been sitting with no carrier for longer than the desk
  /// should allow. The variables are shipmentReference, receivingCompany and
  /// waitingHours.
  ///
  /// An ALERT resolved the moment a carrier accepts it. Carries
  /// `logistics.read`.
  LOGISTICS_SHIPMENT_UNASSIGNED: 'logistics.shipment.unassigned',
  /// A seller's policy puts a delivery level under UBOSS and UBOSS has no
  /// published price for it, so the seller's route cannot be sold. The
  /// variables are sellerName and level. An ALERT, closed by a price being
  /// published for that level. Carries `logistics.read`.
  LOGISTICS_LEVEL_PRICE_REQUIRED: 'logistics.level.price_required',
  /// A UBOSS-controlled leg of a confirmed order has no carrier. The variables
  /// are orderNumber, sellerOrderNumber and level. An ALERT, closed by a
  /// carrier being named. Carries `logistics.read`.
  LOGISTICS_LEG_NEEDS_ASSIGNMENT: 'logistics.leg.needs_assignment',
  /// Something happened on a leg: accepted, refused, handed over, or an
  /// exception. The variables are orderNumber, level and event.
  LOGISTICS_LEG_UPDATE: 'logistics.leg.update',
  /// A published platform-fee policy charges a tax nobody has verified is the
  /// legally correct one. The variables are policyName and taxRate. An ALERT,
  /// closed by verification or by the policy being retired. Carries
  /// `finance.policy.read`.
  PLATFORM_FEE_TAX_UNVERIFIED: 'finance.fee_tax.unverified',
  /// A preorder on one of the OPERATOR's own products needs staff to act:
  /// answer a new request, start production once it is paid, or deal with a
  /// delivery at risk. The variables are requestNumber and event (the seller
  /// notification kind it stands in for). An ALERT, closed by staff acting on
  /// the preorder or by it closing. Carries `order.read`.
  PREORDER_AWAITING_OPERATOR: 'preorder.awaiting_operator',
  /// Something happened on a preorder for the operator's own product that
  /// needs no action: the buyer confirmed or declined, or it closed. The
  /// variables are requestNumber and event.
  PREORDER_UPDATE: 'preorder.update',
} as const;

export type AdminNotificationKindKey =
  (typeof AdminNotificationKind)[keyof typeof AdminNotificationKind];

// ---------------------------------------------------------------------------
// The resolution matrix
// ---------------------------------------------------------------------------

/**
 * How one kind behaves for its whole life.
 *
 * Declared here rather than passed in by every caller, so that "is a failed
 * delivery an alert?" has exactly one answer in this codebase. A caller that
 * raises a kind is describing what happened; it does not get an opinion about
 * how the bell should treat it.
 */
interface KindPolicy {
  /** News or problem. See the header. */
  class: AdminNotificationClass;
  /**
   * Whether a member of staff may close it from the bell.
   *
   * DOMAIN_ONLY for everything whose truth lives in another table. The refusal
   * is the point: the quickest way to make a compliance problem disappear must
   * not be to click past it.
   */
  resolutionPolicy: AdminNotificationResolutionPolicy;
  /**
   * The grant a manual resolution needs, where one is allowed at all.
   *
   * Deliberately not the grant that makes the row VISIBLE. Reading about a
   * consignment and deciding its alert is finished with are different pieces
   * of authority, and the role matrix already separates them.
   */
  resolvePermission?: PermissionKey;
  /** Where the panel should send somebody who must fix it properly. */
  resolvedInstead?: string;
}

const INFORMATION: KindPolicy = Object.freeze({
  class: 'INFORMATION',
  resolutionPolicy: 'DOMAIN_ONLY',
});

/**
 * Kind -> lifecycle. The resolution matrix, in the only place it exists.
 *
 * A kind that is not listed falls back to INFORMATION, which is the safe
 * default in both directions: a panel one deploy ahead of the API cannot turn
 * an unknown row into a permanent badge, and an unknown row still gets read
 * and cleared like every other piece of news.
 */
const KIND_POLICY: Readonly<Record<string, KindPolicy>> = Object.freeze({
  [AdminNotificationKind.ORDER_PLACED]: INFORMATION,
  [AdminNotificationKind.ADMIN_SIGNED_IN]: INFORMATION,
  [AdminNotificationKind.CUSTOMER_REGISTERED]: INFORMATION,

  [AdminNotificationKind.DATA_REQUEST_RAISED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the data request itself',
  }),

  [AdminNotificationKind.LOGISTICS_EXCEPTION_RAISED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the exception on the consignment',
  }),

  [AdminNotificationKind.SELLER_DOCUMENT_UPLOADED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: "the seller's documents",
  }),

  [AdminNotificationKind.LOGISTICS_DELIVERY_FAILED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the consignment',
  }),

  /*
   * The one alert a human may close from the bell, and it is worth saying why.
   *
   * "Nobody has picked this up yet" is a judgement about the desk's own
   * workload rather than a fact about an entity: an operator who has telephoned
   * a haulier and arranged collection by hand has genuinely dealt with it, and
   * there is no row anywhere that will ever say so. Every other alert here
   * describes something with its own terminal state, and closing those from a
   * bell would be hiding them.
   */
  [AdminNotificationKind.LOGISTICS_SHIPMENT_UNASSIGNED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'MANUAL_ALLOWED',
    resolvePermission: Permission.LOGISTICS_ASSIGN,
  }),

  [AdminNotificationKind.LOGISTICS_LEVEL_PRICE_REQUIRED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the managed level price',
  }),

  [AdminNotificationKind.LOGISTICS_LEG_NEEDS_ASSIGNMENT]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the leg',
  }),

  [AdminNotificationKind.LOGISTICS_LEG_UPDATE]: INFORMATION,

  [AdminNotificationKind.PLATFORM_FEE_TAX_UNVERIFIED]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the platform fee policy',
  }),

  [AdminNotificationKind.PREORDER_AWAITING_OPERATOR]: Object.freeze({
    class: 'ALERT',
    resolutionPolicy: 'DOMAIN_ONLY',
    resolvedInstead: 'the preorder',
  }),

  [AdminNotificationKind.PREORDER_UPDATE]: INFORMATION,
});

function policyFor(kind: string): KindPolicy {
  return KIND_POLICY[kind] ?? INFORMATION;
}

// ---------------------------------------------------------------------------
// Resolution keys
// ---------------------------------------------------------------------------

/**
 * The identity of a PROBLEM, as opposed to the identity of one telling of it.
 *
 * Built here rather than spelled out at every call site, because the two ends
 * have to agree exactly: the service that raises an alert and the service that
 * closes it are in different modules, written months apart, and a resolution
 * key that is assembled by hand in both places is a resolution key that will
 * one day be assembled differently in one of them.
 */
export const ResolutionKey = {
  logisticsException: (exceptionId: string): string => `logistics-exception:${exceptionId}`,
  /** Any delivery failure on this consignment, however many attempts. */
  shipmentDelivery: (shipmentId: string): string => `shipment-delivery:${shipmentId}`,
  /** Waiting for a carrier. Closed by any carrier accepting it. */
  shipmentAssignment: (shipmentId: string): string => `shipment-assignment:${shipmentId}`,
  sellerDocument: (documentId: string): string => `seller-document:${documentId}`,
  dataRequest: (requestId: string): string => `data-request:${requestId}`,
  /** A UBOSS-controlled level of one seller with no published price. */
  levelPrice: (sellerAccountId: string, level: string): string =>
    `level-price:${sellerAccountId}:${level}`,
  /** A UBOSS-controlled leg with no carrier. */
  legAssignment: (legId: string): string => `leg-assignment:${legId}`,
  /** A fee policy whose tax rule nobody has verified. */
  feeTaxVerification: (policyId: string): string => `fee-tax:${policyId}`,
} as const;

/**
 * The values that fill a phrase. Primitives only - the same rule the outbox
 * follows, and for the same reason: passing an entity would put personal data
 * or a provider secret into a row that every member of staff with the matching
 * grant can read.
 */
export type AdminNotificationVariables = Record<string, string | number | boolean | null>;

export interface CreateAdminNotificationInput {
  kind: string;
  variables?: AdminNotificationVariables;
  /** Admin Panel path the row opens, e.g. `/orders/<id>`. */
  linkPath?: string | null;
  /** Null shows the row to every member of staff. */
  requiredPermission?: PermissionKey | null;
  relatedType?: string;
  relatedId?: string;
  /** One bell per business event, however many times the operation is retried. */
  dedupeKey?: string;
  /**
   * What problem this alert is about, from `ResolutionKey`.
   *
   * Required for an ALERT and ignored for INFORMATION. Without it an alert
   * could be raised and never closed, which is the failure this whole feature
   * exists to remove - so raising one without a key throws rather than quietly
   * creating a row nothing can ever clear.
   */
  resolutionKey?: string;
}

/** How much of the feed the bell ever asks for. */
export const MAX_FEED_SIZE = 50;

/**
 * Marking everything read is bounded rather than unbounded. A console left
 * unopened for a month should not turn one click into a ten-thousand-row
 * insert; anything past this stays unread, and the next click clears the rest.
 */
const MARK_ALL_LIMIT = 500;

/** Rows older than this are deleted by the worker's maintenance pass. */
const RETENTION_DAYS = 90;

/**
 * How many live alerts one orphan sweep examines.
 *
 * Oldest first, so a backlog is worked through over successive passes rather
 * than one pass reading every alert ever raised. An orphan is rare; a sweep
 * that gets slower for the life of the installation is not.
 */
const ORPHAN_SWEEP_LIMIT = 500;

/** What the panel needs to render one row. */
export interface AdminNotificationView {
  id: string;
  kind: string;
  variables: Record<string, unknown>;
  linkPath: string | null;
  isRead: boolean;
  isDismissed: boolean;
  createdAt: string;

  // --- Lifecycle ----------------------------------------------------------

  /** `INFORMATION` or `ALERT`. Decides everything below it. */
  class: AdminNotificationClass;
  status: AdminNotificationStatus;
  /** Whether the panel should offer this row a Resolve button. */
  canResolveManually: boolean;
  /** Which time round this is, for a problem that has come back. */
  occurrence: number;

  // --- Set only once it is resolved ---------------------------------------

  resolvedAt: string | null;
  /**
   * Whoever closed it, or null for a domain event or a sweep.
   *
   * Their address, because that is how `users` identifies a member of staff -
   * there is no name column on it, and the audit trail beside this one says
   * the same thing the same way.
   */
  resolvedBy: string | null;
  resolutionReason: string | null;
  resolutionSource: AdminNotificationResolutionSource | null;
}

export interface AdminNotificationFeed {
  items: AdminNotificationView[];
  /**
   * Unread rows across the whole visible feed, not only the page returned.
   *
   * Kept because it is what "you have not looked at this" means, and the panel
   * still marks those rows. It is NOT the badge - see `activeCount`.
   */
  unreadCount: number;
  /**
   * The badge. The active-alert rule from the header, counted server-side.
   *
   * A separate number rather than a redefinition of `unreadCount`, because the
   * two answer different questions and a reader needs both: "six things you
   * have not looked at" and "two things still wrong" are not interchangeable.
   */
  activeCount: number;
  /** Live alerts alone, for a panel that wants to say "2 open problems". */
  openAlertCount: number;
}

/** Who is looking, and therefore which rows exist as far as they are concerned. */
export interface NotificationViewer {
  userId: string;
  permissions: readonly string[];
}

/** Which half of the feed to read. */
export type NotificationFeedView = 'active' | 'resolved' | 'all';

/**
 * The visibility clause.
 *
 * Unpermissioned rows are visible to everyone; the rest only to a holder of
 * the named grant. Written once and reused by every query here so the feed,
 * the badge and "mark all as read" can never disagree about what a person can
 * see.
 */
function visibleTo(viewer: NotificationViewer): Prisma.AdminNotificationWhereInput {
  return {
    OR: [{ requiredPermission: null }, { requiredPermission: { in: [...viewer.permissions] } }],
  };
}

/** This reader has taken the row out of their own bell. */
function dismissedByMe(viewer: NotificationViewer): Prisma.AdminNotificationWhereInput {
  return { reads: { some: { userId: viewer.userId, dismissedAt: { not: null } } } };
}

/**
 * The active-alert rule, in Prisma.
 *
 * The one place the sentence in the header is written as a query. Everything
 * that counts or lists live work reads this, so the badge and the feed cannot
 * drift into two different ideas of what is waiting.
 */
function activeAlertClause(viewer: NotificationViewer): Prisma.AdminNotificationWhereInput {
  return {
    AND: [
      visibleTo(viewer),
      { NOT: dismissedByMe(viewer) },
      {
        OR: [
          // News you have not read.
          { class: 'INFORMATION', reads: { none: { userId: viewer.userId } } },
          // A problem that is still a problem, read or not.
          { class: 'ALERT', status: 'ACTIVE' },
        ],
      },
    ],
  };
}

/** Rows the active feed shows: everything live, minus this reader's dismissals. */
function activeFeedClause(viewer: NotificationViewer): Prisma.AdminNotificationWhereInput {
  return {
    AND: [
      visibleTo(viewer),
      { NOT: dismissedByMe(viewer) },
      // An INFORMATION row stays in the feed after it is read - the bell is
      // "what happened lately" and a list that empties as you read it is a
      // list you cannot look back at. Only a CLOSED alert leaves.
      { OR: [{ class: 'INFORMATION' }, { class: 'ALERT', status: 'ACTIVE' }] },
    ],
  };
}

/** The history: alerts that are over, whatever this reader did with them. */
function resolvedFeedClause(viewer: NotificationViewer): Prisma.AdminNotificationWhereInput {
  return {
    AND: [visibleTo(viewer), { class: 'ALERT', status: { in: ['RESOLVED', 'ARCHIVED'] } }],
  };
}

type CreateClient = Pick<typeof prisma, 'adminNotification'>;

/**
 * Record something worth telling the people running the shop.
 *
 * Pass the caller's `tx` whenever there is one - see the note at the top of
 * the file. Without it the write is standalone and best-effort: a bell that
 * cannot be rung must not turn a completed checkout into a 500.
 *
 * THE REOPEN POLICY LIVES HERE
 *
 * An alert whose problem has already been raised and closed does not overwrite
 * the closed row. It becomes the next OCCURRENCE: a new row, a new dedupe key
 * derived from the old one, and the previous resolution left exactly as it was
 * recorded. That is what makes "closed at nine, came back at eleven" readable
 * afterwards.
 */
export async function createAdminNotification(
  input: CreateAdminNotificationInput,
  tx?: unknown,
): Promise<void> {
  const client = (tx as CreateClient | undefined) ?? prisma;
  const policy = policyFor(input.kind);
  const isAlert = policy.class === 'ALERT';

  if (isAlert && (input.resolutionKey ?? '') === '') {
    // Thrown rather than defaulted. An alert with no resolution key is an
    // alert nothing can ever close, which is worse than no alert at all - and
    // a default assembled here would be a second spelling of a key the
    // resolving service has to match exactly.
    throw new Error(
      `admin notification kind "${input.kind}" is an alert and needs a resolutionKey`,
    );
  }

  const write = async (): Promise<void> => {
    let dedupeKey = input.dedupeKey ?? null;
    let occurrence = 1;

    /*
     * Has this problem been here before?
     *
     * One indexed lookup on `ix_admin_notification_resolution`, and only for
     * alerts - news has no problem to recur. A live occurrence means there is
     * nothing to do: the unique dedupe key already stops a retried operation
     * ringing twice, and a second bell for a problem already on the badge is
     * noise. A CLOSED one means this is genuinely new work about an old
     * problem, and it gets its own row.
     */
    if (isAlert) {
      const prior = await client.adminNotification.findFirst({
        where: { resolutionKey: input.resolutionKey },
        orderBy: { occurrence: 'desc' },
        select: { occurrence: true, status: true },
      });

      if (prior !== null) {
        if (prior.status === 'ACTIVE') return;
        occurrence = prior.occurrence + 1;
        if (dedupeKey !== null) dedupeKey = `${dedupeKey}#${String(occurrence)}`;
      }
    }

    const data: Prisma.AdminNotificationCreateManyInput = {
      id: newId(),
      kind: input.kind,
      class: policy.class,
      status: 'ACTIVE',
      variablesJson: input.variables ?? {},
      linkPath: input.linkPath ?? null,
      requiredPermission: input.requiredPermission ?? null,
      relatedType: input.relatedType ?? null,
      relatedId: input.relatedId ?? null,
      dedupeKey,
      resolutionKey: isAlert ? (input.resolutionKey ?? null) : null,
      resolutionPolicy: policy.resolutionPolicy,
      occurrence,
    };

    // `createMany` rather than `create` for the sake of `skipDuplicates`: a
    // repeated dedupe key has to be a no-op, not a unique-constraint error that
    // rolls back the order it was told about. It is also what makes two
    // concurrent raisings of the same recurrence settle on one row.
    await client.adminNotification.createMany({ data: [data], skipDuplicates: true });
  };

  if (tx !== undefined) {
    await write();
    return;
  }

  try {
    await write();
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, 'failed to record console notification');
  }
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveByKeyInput {
  /** From `ResolutionKey`. Every ACTIVE alert carrying it is closed. */
  resolutionKey: string;
  /** Why, in the operator's words or the system's. Shown in the history. */
  reason: string;
  source: AdminNotificationResolutionSource;
  /** Null for a domain event or a sweep - nobody signed those. */
  resolvedByUserId?: string | null;
}

/**
 * Close every live alert about one problem.
 *
 * **The only trustworthy way an alert clears.** Call it from inside the same
 * transaction that moves the domain entity, so the two cannot disagree: an
 * exception that commits as RESOLVED and an alert that stayed ACTIVE because a
 * second write failed afterwards is exactly the drift this replaces.
 *
 * Idempotent by construction. `updateMany` filtered on `status: ACTIVE` writes
 * nothing the second time round, so a retried worker, a double-clicked button
 * and a webhook delivered twice all land on the same state and the first
 * resolution's reason and timestamp survive. Two administrators pressing the
 * same button at the same moment is the same case: one `updateMany` wins the
 * row lock, the other matches nothing.
 *
 * Returns how many rows it closed, which is 0 on every call after the first
 * and is therefore never a failure.
 */
export async function resolveAdminNotifications(
  input: ResolveByKeyInput,
  tx?: unknown,
): Promise<number> {
  const client = (tx as Pick<typeof prisma, 'adminNotification'> | undefined) ?? prisma;

  const run = async (): Promise<number> => {
    const result = await client.adminNotification.updateMany({
      where: { resolutionKey: input.resolutionKey, class: 'ALERT', status: 'ACTIVE' },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedByUserId: input.resolvedByUserId ?? null,
        resolutionReason: input.reason.slice(0, 512),
        resolutionSource: input.source,
      },
    });

    return result.count;
  };

  // Inside a caller's transaction the failure is theirs to handle: an alert
  // that could not be closed must roll back the resolution that claimed to
  // close it, or the bell and the entity disagree. Standalone it is
  // best-effort, for the same reason raising one is.
  if (tx !== undefined) return run();

  try {
    return await run();
  } catch (error) {
    logger.error(
      { err: error, resolutionKey: input.resolutionKey },
      'failed to resolve console notifications',
    );
    return 0;
  }
}

/**
 * Close one alert by hand.
 *
 * Refused unless the kind's policy allows it - see `KIND_POLICY`. The refusal
 * is the feature: an alert about a temperature excursion or a statutory
 * deadline is closed by fixing the thing, and a Resolve button on the bell
 * that could hide it would be the quickest route to a compliance problem
 * nobody can find afterwards.
 *
 * Idempotent: resolving an already-resolved alert returns what is already
 * recorded rather than overwriting it, so a double-clicked button does not
 * replace the first person's reason with the second's.
 */
export async function resolveAdminNotificationById(
  viewer: NotificationViewer,
  notificationId: string,
  reason: string,
): Promise<AdminNotificationView> {
  const row = await prisma.adminNotification.findFirst({
    where: { AND: [visibleTo(viewer), { id: notificationId }] },
    select: { id: true, kind: true, class: true, status: true, linkPath: true },
  });

  // A row the caller cannot see is a row that does not exist, as far as they
  // are concerned. Distinguishing "no such alert" from "not yours" here would
  // turn the endpoint into a way to confirm that an alert exists.
  if (row === null) throw notFound('Notification');

  if (row.class !== 'ALERT') {
    throw conflict(
      ErrorCode.NOTIFICATION_NOT_AN_ALERT,
      'That notification is something that happened, not something to put right.',
    );
  }

  const policy = policyFor(row.kind);

  if (policy.resolutionPolicy !== 'MANUAL_ALLOWED') {
    throw conflict(
      ErrorCode.NOTIFICATION_NOT_MANUALLY_RESOLVABLE,
      `This alert clears itself when ${policy.resolvedInstead ?? 'the underlying problem'} is dealt with. Closing it here would hide it rather than fix it.`,
      [
        {
          code: 'RESOLVE_AT_SOURCE',
          meta: { kind: row.kind, linkPath: row.linkPath },
        },
      ],
    );
  }

  const granted = new Set(viewer.permissions);
  if (policy.resolvePermission !== undefined && !granted.has(policy.resolvePermission)) {
    throw conflict(
      ErrorCode.NOTIFICATION_NOT_MANUALLY_RESOLVABLE,
      'You do not have permission to close this alert.',
      [{ code: 'PERMISSION_REQUIRED', meta: { permission: policy.resolvePermission } }],
    );
  }

  if (row.status === 'ACTIVE') {
    // Conditional on ACTIVE, so the second of two administrators pressing this
    // at the same moment writes nothing and reads back the first one's answer.
    await prisma.adminNotification.updateMany({
      where: { id: row.id, status: 'ACTIVE' },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedByUserId: viewer.userId,
        resolutionReason: reason.slice(0, 512),
        resolutionSource: 'MANUAL',
      },
    });
  }

  const refreshed = await readAdminNotification(viewer, row.id);
  if (refreshed === null) throw notFound('Notification');
  return refreshed;
}

/**
 * Close the live alerts about things that no longer exist.
 *
 * The orphan case, and it is a real one rather than a defensive flourish: a
 * carrier removed takes its consignments with it through the cascade, and any
 * alert about one of those consignments is now asking an operator to act on a
 * screen that will 404. Leaving it ACTIVE is a badge nobody can ever clear.
 *
 * ARCHIVED rather than RESOLVED, because nobody fixed anything - the question
 * stopped existing, and the record should say which of the two happened.
 *
 * Matched on `relatedType`/`relatedId` rather than on the resolution key,
 * because those are what name the ROW: a resolution key is this module's own
 * identifier for a problem, and the sweep is asking a question about somebody
 * else's table.
 *
 * Called by the worker's logistics maintenance pass. Bounded, because a sweep
 * that reads every alert ever raised gets slower for the life of the
 * installation.
 */
export async function archiveOrphanedShipmentAlerts(): Promise<number> {
  const live = await prisma.adminNotification.findMany({
    where: { class: 'ALERT', status: 'ACTIVE', relatedType: 'logistics_shipment' },
    orderBy: { createdAt: 'asc' },
    take: ORPHAN_SWEEP_LIMIT,
    select: { id: true, relatedId: true },
  });

  if (live.length === 0) return 0;

  const ids = live.map((row) => row.relatedId).filter((id): id is string => id !== null);

  const surviving = new Set(
    (
      await prisma.logisticsShipment.findMany({
        where: { id: { in: ids } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );

  const orphaned = live
    .filter((row) => row.relatedId === null || !surviving.has(row.relatedId))
    .map((row) => row.id);

  if (orphaned.length === 0) return 0;

  const result = await prisma.adminNotification.updateMany({
    // Conditional on still being ACTIVE, so a sweep racing a genuine
    // resolution does not overwrite the reason somebody wrote.
    where: { id: { in: orphaned }, status: 'ACTIVE' },
    data: {
      status: 'ARCHIVED',
      resolvedAt: new Date(),
      resolvedByUserId: null,
      resolutionReason: 'The consignment this was about no longer exists.',
      resolutionSource: 'SYSTEM_SWEEP',
    },
  });

  return result.count;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** Everything one row needs, selected once so the two readers cannot drift. */
const ROW_SELECT = {
  id: true,
  kind: true,
  class: true,
  status: true,
  variablesJson: true,
  linkPath: true,
  occurrence: true,
  resolvedAt: true,
  resolutionReason: true,
  resolutionSource: true,
  createdAt: true,
  // `users` carries no name column in this system - a member of staff is
  // identified by their address, exactly as `AuditLog.actorEmail` identifies
  // them. Names live on the profile tables, and none of them applies to
  // operator staff.
  resolvedBy: { select: { email: true } },
} as const;

type RowShape = Prisma.AdminNotificationGetPayload<{ select: typeof ROW_SELECT }> & {
  reads: { readAt: Date; dismissedAt: Date | null }[];
};

function toView(row: RowShape): AdminNotificationView {
  const policy = policyFor(row.kind);

  return {
    id: row.id,
    kind: row.kind,
    variables:
      row.variablesJson === null || typeof row.variablesJson !== 'object'
        ? {}
        : (row.variablesJson as Record<string, unknown>),
    linkPath: row.linkPath,
    isRead: row.reads.length > 0,
    isDismissed: row.reads.some((read) => read.dismissedAt !== null),
    createdAt: row.createdAt.toISOString(),
    class: row.class,
    status: row.status,
    // Computed rather than stored, because it depends on the reader: the same
    // alert offers a button to somebody holding the grant and none to somebody
    // who does not. The endpoint checks it again - a hidden button is not a
    // permission model.
    canResolveManually:
      row.class === 'ALERT' &&
      row.status === 'ACTIVE' &&
      policy.resolutionPolicy === 'MANUAL_ALLOWED',
    occurrence: row.occurrence,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy?.email ?? null,
    resolutionReason: row.resolutionReason,
    resolutionSource: row.resolutionSource,
  };
}

/**
 * One row, as this reader sees it. Null when they may not see it at all.
 */
export async function readAdminNotification(
  viewer: NotificationViewer,
  notificationId: string,
): Promise<AdminNotificationView | null> {
  const row = await prisma.adminNotification.findFirst({
    where: { AND: [visibleTo(viewer), { id: notificationId }] },
    select: {
      ...ROW_SELECT,
      reads: {
        where: { userId: viewer.userId },
        select: { readAt: true, dismissedAt: true },
        take: 1,
      },
    },
  });

  return row === null ? null : toView(row);
}

/**
 * The feed and the badge, in one round trip.
 *
 * The counts describe the whole visible feed rather than the page returned: a
 * bell reading "12" that opens onto ten rows is a bell people stop trusting.
 *
 * `view` picks which half. `active` is what the bell shows and defaults here,
 * because a panel that forgot the parameter must not accidentally show a
 * reader six months of closed problems as though they were open.
 */
export async function listAdminNotifications(
  viewer: NotificationViewer,
  options: { limit?: number; view?: NotificationFeedView } = {},
): Promise<AdminNotificationFeed> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_FEED_SIZE);
  const view = options.view ?? 'active';

  const where =
    view === 'resolved'
      ? resolvedFeedClause(viewer)
      : view === 'all'
        ? visibleTo(viewer)
        : activeFeedClause(viewer);

  const [rows, unreadCount, activeCount, openAlertCount] = await Promise.all([
    prisma.adminNotification.findMany({
      where,
      // The history reads by when things were closed; the live feed by when
      // they happened. Ordering the history by `createdAt` would put an alert
      // raised in March and closed this morning below one raised and closed
      // in April, which is not the order anybody looks for it in.
      orderBy: view === 'resolved' ? { resolvedAt: 'desc' } : { createdAt: 'desc' },
      take: limit,
      select: {
        ...ROW_SELECT,
        // A read row exists only for the person who opened it, so this is
        // "have *I* read it" and not "has anyone".
        reads: {
          where: { userId: viewer.userId },
          select: { readAt: true, dismissedAt: true },
          take: 1,
        },
      },
    }),

    prisma.adminNotification.count({
      where: {
        AND: [
          visibleTo(viewer),
          { NOT: dismissedByMe(viewer) },
          { reads: { none: { userId: viewer.userId } } },
        ],
      },
    }),

    prisma.adminNotification.count({ where: activeAlertClause(viewer) }),

    prisma.adminNotification.count({
      where: {
        AND: [
          visibleTo(viewer),
          { NOT: dismissedByMe(viewer) },
          { class: 'ALERT', status: 'ACTIVE' },
        ],
      },
    }),
  ]);

  return { items: rows.map(toView), unreadCount, activeCount, openAlertCount };
}

// ---------------------------------------------------------------------------
// One reader's own state
// ---------------------------------------------------------------------------

/**
 * Mark specific rows read for one person.
 *
 * Filtered through the same visibility clause as the feed: an id guessed or
 * kept from a revoked grant must not become a way to confirm that a
 * notification exists.
 */
export async function markAdminNotificationsRead(
  viewer: NotificationViewer,
  notificationIds: readonly string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0;

  const visible = await prisma.adminNotification.findMany({
    where: { AND: [visibleTo(viewer), { id: { in: [...notificationIds] } }] },
    select: { id: true },
  });

  if (visible.length === 0) return 0;

  // Already-read rows collide on the composite primary key; skipping them
  // keeps this idempotent, which matters because the panel fires it every
  // time the bell is opened.
  const result = await prisma.adminNotificationRead.createMany({
    data: visible.map((row) => ({ notificationId: row.id, userId: viewer.userId })),
    skipDuplicates: true,
  });

  return result.count;
}

/** Clear the unread marks. Bounded - see MARK_ALL_LIMIT. */
export async function markAllAdminNotificationsRead(viewer: NotificationViewer): Promise<number> {
  const unread = await prisma.adminNotification.findMany({
    where: { AND: [visibleTo(viewer), { reads: { none: { userId: viewer.userId } } }] },
    orderBy: { createdAt: 'desc' },
    take: MARK_ALL_LIMIT,
    select: { id: true },
  });

  if (unread.length === 0) return 0;

  const result = await prisma.adminNotificationRead.createMany({
    data: unread.map((row) => ({ notificationId: row.id, userId: viewer.userId })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Take rows out of ONE person's bell.
 *
 * Not a resolution and never mistaken for one: the notification's `status` is
 * untouched, every other recipient still sees it, and the badge for everybody
 * else is unchanged. This is "that one is not mine to deal with", which is a
 * real thing an operator needs to say and a thing that must not be able to
 * close a problem.
 *
 * Idempotent, and it writes a read row as well - there is no way to dismiss
 * something you have not been shown.
 */
export async function dismissAdminNotifications(
  viewer: NotificationViewer,
  notificationIds: readonly string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0;

  const visible = await prisma.adminNotification.findMany({
    where: { AND: [visibleTo(viewer), { id: { in: [...notificationIds] } }] },
    select: { id: true },
  });

  if (visible.length === 0) return 0;

  const now = new Date();
  const ids = visible.map((row) => row.id);

  /*
   * Two statements rather than one upsert per row, because a reader can arrive
   * at a dismissal from either direction: a row they have never opened has no
   * read row at all, and one they glanced at last week already has one.
   *
   *   1. Create the missing read rows, already dismissed. `readAt` takes its
   *      default - dismissing implies having been shown it.
   *   2. Dismiss the ones that already existed and had not been dismissed.
   *
   * Filtering the second on `dismissedAt: null` is what makes the whole thing
   * idempotent: pressing it twice keeps the first timestamp, because when
   * somebody stopped looking at a row is a fact with one answer.
   */
  const created = await prisma.adminNotificationRead.createMany({
    data: ids.map((notificationId) => ({
      notificationId,
      userId: viewer.userId,
      dismissedAt: now,
    })),
    skipDuplicates: true,
  });

  const updated = await prisma.adminNotificationRead.updateMany({
    where: { userId: viewer.userId, notificationId: { in: ids }, dismissedAt: null },
    data: { dismissedAt: now },
  });

  return created.count + updated.count;
}

/**
 * Retention.
 *
 * The bell is a "what happened lately" feed, not a record - the audit trail
 * and the orders themselves are the record, and both outlive this. Without a
 * sweep the table grows for the life of the installation to hold rows nobody
 * will ever scroll to. Read rows go with their notification through the
 * cascade.
 *
 * **A live alert is never pruned, however old it is.** An unresolved
 * temperature excursion from four months ago is still unresolved, and deleting
 * it would clear a badge by forgetting the problem - which is the one thing
 * this whole feature exists to prevent. It ages out of the table only once
 * somebody has closed it.
 */
export async function pruneAdminNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

  const result = await prisma.adminNotification.deleteMany({
    where: {
      createdAt: { lt: cutoff },
      NOT: { class: 'ALERT', status: 'ACTIVE' },
    },
  });

  return result.count;
}
