/**
 * Data subject requests, end to end.
 *
 * Someone asks for a copy of what is held about them, or asks for it to be
 * erased. Art. 12(3) gives one month to answer, so the request is a record
 * with a due date rather than a task somebody remembers, and the console sorts
 * by that date.
 *
 * The two types are handled differently on purpose.
 *
 *   - **Export fulfils itself.** The person asking is already signed in as the
 *     person being asked about, which is the identity check Art. 12(6) is
 *     concerned with. Making a member of staff press a button before someone
 *     may read their own data adds a queue and a delay without adding a check.
 *     The request is created and the job runs.
 *
 *   - **Erasure waits for a decision.** It cannot be undone, Art. 17(3) has
 *     real exemptions that need a human to weigh, and the account may be in
 *     the middle of a contract. `findErasureBlockers` gives staff the facts
 *     before they decide rather than after.
 *
 * A refusal is a first-class outcome rather than an error path: Art. 12(5)
 * requires the subject be told why and that they may complain to a supervisory
 * authority, so `decisionNote` is mandatory on rejection and travels back to
 * them in the email.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { JobType, queue } from '../../infra/queue/index.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';
import { buildCustomerBundle } from './export-bundle.service.js';
import { describeKept, executeErasure, findErasureBlockers } from './erasure.service.js';

export const DataRequestType = { EXPORT: 'EXPORT', ERASURE: 'ERASURE' } as const;
export type DataRequestTypeValue = (typeof DataRequestType)[keyof typeof DataRequestType];

/** Art. 12(3): "without undue delay and in any event within one month". */
const RESPONSE_WINDOW_DAYS = 30;

export interface CreateDataRequestInput {
  userId: string;
  email: string;
  type: DataRequestTypeValue;
  note?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface DataRequestSummary {
  id: string;
  type: string;
  status: string;
  requestedAt: string;
  dueAt: string;
  completedAt: string | null;
  decisionNote: string | null;
  /** Present only while a finished export is still inside its download window. */
  downloadToken: string | null;
  downloadExpiresAt: string | null;
}

function summarise(row: {
  id: string;
  type: string;
  status: string;
  requestedAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  decisionNote: string | null;
  downloadTokenHash: string | null;
  downloadExpiresAt: Date | null;
}): Omit<DataRequestSummary, 'downloadToken'> {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    decisionNote: row.decisionNote,
    downloadExpiresAt: row.downloadExpiresAt?.toISOString() ?? null,
  };
}

/**
 * Open a request.
 *
 * One open request of each type at a time. A second is not a new request - the
 * one-month clock runs from the first - and letting somebody queue five
 * exports would be a way to make the server build the same large file five
 * times.
 */
export async function createDataRequest(
  input: CreateDataRequestInput,
): Promise<DataRequestSummary> {
  const open = await prisma.dataRequest.findFirst({
    where: {
      subjectUserId: input.userId,
      type: input.type,
      status: { in: ['PENDING', 'IN_PROGRESS'] },
    },
    select: { id: true, dueAt: true },
  });

  if (open !== null) {
    throw conflict(
      ErrorCode.DATA_REQUEST_ALREADY_OPEN,
      input.type === DataRequestType.EXPORT
        ? 'Your copy is already being prepared. You will be emailed when it is ready.'
        : 'Your erasure request has already been received and is being reviewed.',
      [{ code: 'ALREADY_OPEN', meta: { requestId: open.id, dueAt: open.dueAt.toISOString() } }],
    );
  }

  const id = newId();
  const now = new Date();

  const row = await prisma.dataRequest.create({
    data: {
      id,
      subjectUserId: input.userId,
      subjectEmail: input.email,
      type: input.type,
      status: 'PENDING',
      requestedAt: now,
      dueAt: new Date(now.getTime() + RESPONSE_WINDOW_DAYS * 86_400_000),
      subjectNote: input.note?.slice(0, 1024) ?? null,
    },
  });

  await recordAudit({
    action: AuditAction.DATA_REQUEST_CREATED,
    resourceType: 'data_request',
    resourceId: id,
    actorType: 'CUSTOMER',
    actorUserId: input.userId,
    actorEmail: input.email,
    after: { type: input.type, dueAt: row.dueAt.toISOString() },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    correlationId: input.correlationId ?? null,
  });

  if (input.type === DataRequestType.EXPORT) {
    // Nothing to decide - build it.
    await queue.enqueue(
      JobType.DATA_REQUEST_FULFIL,
      { dataRequestId: id },
      {
        dedupeKey: `data_request:${id}`,
        ...(input.correlationId !== null && input.correlationId !== undefined
          ? { correlationId: input.correlationId }
          : {}),
      },
    );
  } else {
    // An erasure needs a person. The bell carries `data_request.read` rather
    // than `customer.read`: knowing that a named individual has asked to be
    // erased is its own piece of information, and not everyone who may look up
    // a customer should receive it unprompted.
    await createAdminNotification({
      kind: AdminNotificationKind.DATA_REQUEST_RAISED,
      variables: {
        email: input.email,
        type: input.type,
        dueAt: row.dueAt.toISOString(),
      },
      requiredPermission: Permission.DATA_REQUEST_READ,
      relatedType: 'data_request',
      relatedId: id,
      dedupeKey: `data_request:${id}`,
    });
  }

  return { ...summarise(row), downloadToken: null };
}

/** The subject's own view of their requests. */
export async function listRequestsForSubject(userId: string): Promise<DataRequestSummary[]> {
  const rows = await prisma.dataRequest.findMany({
    where: { subjectUserId: userId },
    orderBy: { requestedAt: 'desc' },
    take: 20,
  });

  return rows.map((row) => ({
    ...summarise(row),
    downloadToken: downloadTokenIfLive(row),
  }));
}

/**
 * The raw token, but only while it is good for something.
 *
 * Stored hashed, like every other download token here, and handed back to the
 * subject's own authenticated session in the clear. Once the window closes the
 * field goes null rather than returning a token the download endpoint would
 * refuse - a link that looks live and is not is worse than no link.
 */
function downloadTokenIfLive(row: {
  status: string;
  downloadExpiresAt: Date | null;
  resultJson: unknown;
}): string | null {
  if (row.status !== 'COMPLETED') return null;
  if (row.downloadExpiresAt === null || row.downloadExpiresAt.getTime() <= Date.now()) return null;

  const result = row.resultJson as { downloadToken?: string } | null;
  return result?.downloadToken ?? null;
}

export interface AdminRequestFilters {
  status?: string;
  type?: string;
  page?: number;
  limit?: number;
}

/** The console's queue, oldest deadline first. */
export async function listRequests(filters: AdminRequestFilters): Promise<{
  items: unknown[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}> {
  const page = Math.max(1, filters.page ?? 1);
  const limit = Math.min(100, Math.max(1, filters.limit ?? 25));

  const where = {
    ...(filters.status === undefined ? {} : { status: filters.status as never }),
    ...(filters.type === undefined ? {} : { type: filters.type as never }),
  };

  const [rows, total] = await Promise.all([
    prisma.dataRequest.findMany({
      where,
      // Due first: a queue ordered by arrival tells nobody which one is about
      // to breach the one-month deadline.
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.dataRequest.count({ where }),
  ]);

  return {
    items: rows.map((row) => ({
      ...summarise(row),
      subjectEmail: row.subjectEmail,
      subjectUserId: row.subjectUserId,
      subjectNote: row.subjectNote,
      handledAt: row.handledAt?.toISOString() ?? null,
      errorMessage: row.errorMessage,
      overdue: row.completedAt === null && row.dueAt.getTime() < Date.now(),
    })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * One request, with the facts a member of staff needs to decide it.
 *
 * For an erasure that means the blockers: unpaid orders and open returns are
 * the two things that make erasure "not yet" rather than "yes", and finding
 * out afterwards is finding out too late.
 */
export async function getRequestForAdmin(id: string): Promise<Record<string, unknown>> {
  const row = await prisma.dataRequest.findUnique({ where: { id } });
  if (row === null) throw notFound('Data request');

  const blockers =
    row.type === 'ERASURE' && row.status === 'PENDING'
      ? await findErasureBlockers(row.subjectUserId)
      : [];

  return {
    ...summarise(row),
    subjectEmail: row.subjectEmail,
    subjectUserId: row.subjectUserId,
    subjectNote: row.subjectNote,
    handledById: row.handledById,
    handledAt: row.handledAt?.toISOString() ?? null,
    errorMessage: row.errorMessage,
    result: row.resultJson,
    blockers,
    overdue: row.completedAt === null && row.dueAt.getTime() < Date.now(),
  };
}

export interface DecisionInput {
  requestId: string;
  actorUserId: string;
  actorEmail: string;
  note?: string | null;
  correlationId?: string | null;
}

/**
 * Approve an erasure and queue it.
 *
 * The blocker check runs again here even though the console has already shown
 * it: minutes pass between a page load and a click, and an order can be placed
 * in that gap. `executeErasure` checks a third time inside the transaction, on
 * the same reasoning.
 */
export async function approveRequest(input: DecisionInput): Promise<void> {
  const row = await claimPending(input.requestId);

  if (row.type === 'ERASURE') {
    const blockers = await findErasureBlockers(row.subjectUserId);
    if (blockers.length > 0) {
      // Put it back: a request that cannot be actioned today is still pending,
      // not failed, and the deadline has not moved.
      await prisma.dataRequest.update({
        where: { id: row.id },
        data: { status: 'PENDING', handledById: null, handledAt: null },
      });

      throw conflict(
        ErrorCode.ERASURE_BLOCKED_BY_OBLIGATION,
        'This account cannot be erased yet.',
        blockers.map((blocker) => ({ code: blocker.code, message: blocker.detail })),
      );
    }
  }

  await prisma.dataRequest.update({
    where: { id: row.id },
    data: {
      handledById: input.actorUserId,
      handledAt: new Date(),
      decisionNote: input.note?.slice(0, 1024) ?? null,
    },
  });

  await queue.enqueue(
    JobType.DATA_REQUEST_FULFIL,
    { dataRequestId: row.id },
    {
      dedupeKey: `data_request:${row.id}`,
      ...(input.correlationId !== null && input.correlationId !== undefined
        ? { correlationId: input.correlationId }
        : {}),
    },
  );
}

/**
 * Refuse a request.
 *
 * The reason is required, not optional. Art. 12(4) obliges the controller to
 * tell the subject why and that they may complain to a supervisory authority
 * and seek a judicial remedy - a rejection with an empty reason is a rejection
 * that cannot lawfully be sent.
 */
export async function rejectRequest(input: DecisionInput): Promise<void> {
  const reason = input.note?.trim() ?? '';

  if (reason.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A reason is required. The subject has to be told why their request was refused.',
      [{ field: 'note', code: 'REQUIRED' }],
    );
  }

  const row = await claimPending(input.requestId);

  await prisma.dataRequest.update({
    where: { id: row.id },
    data: {
      status: 'REJECTED',
      handledById: input.actorUserId,
      handledAt: new Date(),
      completedAt: new Date(),
      decisionNote: reason.slice(0, 1024),
    },
  });

  await recordAudit({
    action: AuditAction.DATA_REQUEST_REJECTED,
    resourceType: 'data_request',
    resourceId: row.id,
    actorType: 'ADMIN',
    actorUserId: input.actorUserId,
    actorEmail: input.actorEmail,
    after: { type: row.type, reason: reason.slice(0, 1024) },
    correlationId: input.correlationId ?? null,
  });

  await enqueueNotification({
    eventKey: NotificationEvent.DATA_REQUEST_REJECTED,
    recipientEmail: row.subjectEmail,
    variables: { requestType: row.type, reason: reason.slice(0, 1024) },
    dedupeKey: `data_request_rejected:${row.id}`,
    relatedType: 'data_request',
    relatedId: row.id,
  });
}

/**
 * Move a request out of PENDING, or refuse to.
 *
 * The status transition is the lock: two members of staff opening the same
 * request and both pressing Approve must not run two erasures, and
 * `updateMany` filtered on the current status makes the second one a no-op
 * that reports honestly rather than a silent duplicate.
 */
async function claimPending(id: string): Promise<{
  id: string;
  type: string;
  subjectUserId: string;
  subjectEmail: string;
}> {
  const row = await prisma.dataRequest.findUnique({ where: { id } });
  if (row === null) throw notFound('Data request');

  const claimed = await prisma.dataRequest.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'IN_PROGRESS' },
  });

  if (claimed.count === 0) {
    throw conflict(
      ErrorCode.DATA_REQUEST_ALREADY_DECIDED,
      'This request has already been actioned.',
    );
  }

  return {
    id: row.id,
    type: row.type,
    subjectUserId: row.subjectUserId,
    subjectEmail: row.subjectEmail,
  };
}

/**
 * Do the work. Called by the worker, never by a request handler.
 *
 * Both branches end the same way: the request is COMPLETED, the subject is
 * emailed, and an audit row says what happened. A failure is recorded on the
 * request rather than thrown away, because the subject is entitled to an
 * answer either way and a member of staff has to be able to see that the job
 * did not silently vanish.
 */
export async function fulfilRequest(dataRequestId: string): Promise<void> {
  const row = await prisma.dataRequest.findUnique({ where: { id: dataRequestId } });
  if (row === null) {
    logger.warn({ dataRequestId }, 'fulfil skipped: request no longer exists');
    return;
  }

  if (row.status === 'COMPLETED' || row.status === 'REJECTED') {
    logger.info({ dataRequestId, status: row.status }, 'fulfil skipped: already finished');
    return;
  }

  await prisma.dataRequest.updateMany({
    where: { id: dataRequestId, status: 'PENDING' },
    data: { status: 'IN_PROGRESS' },
  });

  try {
    if (row.type === 'EXPORT') {
      await fulfilExport(row.id, row.subjectUserId, row.subjectEmail);
    } else {
      await fulfilErasure(row.id, row.subjectUserId, row.subjectEmail, row.handledById);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    await prisma.dataRequest.update({
      where: { id: dataRequestId },
      data: { status: 'FAILED', errorMessage: message.slice(0, 1000), completedAt: new Date() },
    });

    logger.error({ err: error, dataRequestId }, 'data request fulfilment failed');
    throw error;
  }
}

async function fulfilExport(id: string, userId: string, email: string): Promise<void> {
  const bundle = await buildCustomerBundle({ userId, email });

  const content = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8');
  // Private prefix: the static media route is not mounted over it. This one
  // file is every personal fact the system holds about one person.
  const stored = await storage.put(content, 'application/json', 'json', 'private');

  const { token, tokenHash } = generateToken();
  const expiresAt = new Date(
    Date.now() + env.DATA_REQUEST_DOWNLOAD_TTL_HOURS * 3_600_000,
  );

  await prisma.dataRequest.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      fileKey: stored.storageKey,
      fileName: `personal-data-${id.toLowerCase()}.json`,
      downloadTokenHash: tokenHash,
      downloadExpiresAt: expiresAt,
      // The raw token lives here so the subject's own authenticated session can
      // read it back after a page reload without a second request being
      // needed. It is deleted with the file when the window closes.
      resultJson: { downloadToken: token, sizeBytes: content.byteLength },
    },
  });

  await recordAudit({
    action: AuditAction.DATA_REQUEST_FULFILLED,
    resourceType: 'data_request',
    resourceId: id,
    actorType: 'SYSTEM',
    after: { type: 'EXPORT', sizeBytes: content.byteLength },
  });

  await enqueueNotification({
    eventKey: NotificationEvent.DATA_REQUEST_READY,
    recipientEmail: email,
    variables: {
      expiresAt: expiresAt.toISOString(),
      hours: env.DATA_REQUEST_DOWNLOAD_TTL_HOURS,
      accountUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/profile`,
    },
    dedupeKey: `data_request_ready:${id}`,
    relatedType: 'data_request',
    relatedId: id,
  });
}

async function fulfilErasure(
  id: string,
  userId: string,
  email: string,
  handledById: string | null,
): Promise<void> {
  const result = await executeErasure({
    userId,
    actorUserId: handledById,
    actorEmail: null,
    dataRequestId: id,
  });

  // Sent before the row records the pseudonym, because the erasure has already
  // scrubbed `subjectEmail` on every request belonging to this subject - this
  // one included. The address is held in a local here precisely so the final
  // message can still reach the person who asked for it.
  await enqueueNotification({
    eventKey: NotificationEvent.DATA_REQUEST_ERASED,
    recipientEmail: email,
    variables: { summary: describeKept(result) },
    dedupeKey: `data_request_erased:${id}`,
    relatedType: 'data_request',
    relatedId: id,
  });

  await prisma.dataRequest.update({
    where: { id },
    data: {
      status: 'COMPLETED',
      completedAt: new Date(),
      resultJson: {
        deleted: result.deleted,
        pseudonymised: result.pseudonymised,
        retained: result.retained,
        pseudonym: result.pseudonym,
      },
    },
  });

  await recordAudit({
    action: AuditAction.DATA_REQUEST_FULFILLED,
    resourceType: 'data_request',
    resourceId: id,
    actorType: handledById === null ? 'SYSTEM' : 'ADMIN',
    actorUserId: handledById,
    after: { type: 'ERASURE', pseudonym: result.pseudonym },
  });
}

export interface DownloadableBundle {
  fileName: string;
  content: Buffer;
}

/**
 * Redeem a bundle download token.
 *
 * Deliberately the same shape as `reports/export.service.downloadExport`, and
 * deliberately separate code: that one is scoped to the member of staff who
 * asked for it, this one to a token the subject holds. Merging them would mean
 * one function whose access rule depends on which caller reached it.
 */
export async function downloadBundle(token: string): Promise<DownloadableBundle> {
  const row = await prisma.dataRequest.findUnique({
    where: { downloadTokenHash: sha256Hex(token) },
  });

  if (row === null || row.fileKey === null) {
    throw badRequest(ErrorCode.DATA_REQUEST_NOT_READY, 'This download link is not valid.');
  }

  if (row.downloadExpiresAt === null || row.downloadExpiresAt.getTime() <= Date.now()) {
    throw conflict(
      ErrorCode.DATA_REQUEST_NOT_READY,
      'This download link has expired. Request your data again.',
    );
  }

  const content = await storage.get(row.fileKey);

  await prisma.dataRequest.update({
    where: { id: row.id },
    data: { downloadedAt: new Date() },
  });

  await recordAudit({
    action: AuditAction.DATA_REQUEST_DOWNLOADED,
    resourceType: 'data_request',
    resourceId: row.id,
    actorType: 'CUSTOMER',
    actorUserId: row.subjectUserId,
  });

  return { fileName: row.fileName ?? 'personal-data.json', content };
}

/**
 * Delete bundles past their download window.
 *
 * Runs on the maintenance beat beside `purgeExpiredExports`, for the same
 * reason and more urgently: this file is every personal fact the system holds
 * about one person, in one archive, sitting in object storage. The request row
 * survives as the record that the request was answered.
 */
export async function purgeExpiredBundles(): Promise<number> {
  const expired = await prisma.dataRequest.findMany({
    where: {
      status: 'COMPLETED',
      downloadExpiresAt: { lt: new Date() },
      fileKey: { not: null },
    },
    select: { id: true, fileKey: true, resultJson: true },
    take: 100,
  });

  let purged = 0;

  for (const row of expired) {
    if (row.fileKey !== null) {
      await storage.delete(row.fileKey).catch(() => undefined);
    }

    const result = (row.resultJson ?? {}) as Record<string, unknown>;
    // The token is stripped alongside the file, or it would outlive it.
    delete result.downloadToken;

    await prisma.dataRequest.update({
      where: { id: row.id },
      data: {
        fileKey: null,
        downloadTokenHash: null,
        resultJson: result as never,
      },
    });

    purged += 1;
  }

  if (purged > 0) logger.info({ purged }, 'purged expired data-subject bundles');
  return purged;
}
