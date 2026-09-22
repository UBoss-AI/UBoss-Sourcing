/**
 * Telling a seller something happened.
 *
 * The Seller Hub has three ways a seller learns of a decision, and only one of
 * them is reliable. An email may never be opened; a screen may never be
 * visited; this is the one that is waiting for them when they next sign in. So
 * every decision the marketplace makes ABOUT a seller writes one, and a
 * decision that writes only an audit entry is a decision the seller finds out
 * about by noticing their listing has stopped working.
 *
 * Two things this is not:
 *
 *   - **Not the record.** The audit log is. A notification expires and is
 *     swept; an audit entry is kept. Nothing may depend on a notification still
 *     existing, which is why nothing reads them back except the seller's own
 *     feed.
 *   - **Not per person.** A notification is addressed to the ORGANISATION,
 *     because most of them concern the business rather than an individual — a
 *     low-stock warning is for whoever is looking. Read state lives in
 *     `readByJson` per member, so twelve staff share one row rather than
 *     generating twelve.
 *
 * `subjectType` / `subjectId` exist for deduplication: one low-stock notice per
 * offer per day rather than one per stock movement. `notifySellerOnce` is the
 * entry point that uses them; `notifySeller` always writes, which is what a
 * decision wants — a listing refused twice is two things the seller must read.
 */
import type { Prisma, SellerNotificationKind } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';

type Client = Prisma.TransactionClient | typeof prisma;

export interface NotifyInput {
  sellerAccountId: string;
  kind: SellerNotificationKind;
  title: string;
  /** Written for the seller, in their language of business, not ours. */
  body: string;
  /** Where pressing it goes, as an in-app path. Never an absolute URL. */
  linkPath?: string | null;
  severity?: 'INFO' | 'SUCCESS' | 'WARNING' | 'CRITICAL';
  subjectType?: string | null;
  subjectId?: string | null;
  /** Swept after this. Omit for a notice that should stay until read. */
  expiresAt?: Date | null;
  tx?: Client;

  /**
   * The identity of the thing being announced. Never a timestamp.
   *
   * Backed by `uq_seller_notification_dedupe`, so a caller retried under the
   * same key writes at most one row however many times it runs and however
   * close together. A timestamp here would make every retry unique, which is
   * the opposite of the point.
   *
   * Optional: omitted, the row's own id is used, which deduplicates against
   * nothing and is the right answer for a decision. Two refusals of the same
   * listing are two things the seller has to read.
   */
  dedupeKey?: string;

  /**
   * News, or a problem.
   *
   * `INFORMATION` is cleared by being read, per person. `ALERT` is cleared by
   * the problem going away, for the whole business - so "your carrier refused
   * this parcel" cannot be dismissed by glancing at it, because the parcel
   * still has nobody.
   *
   * Defaults to news, which is what every existing caller means.
   */
  class?: 'INFORMATION' | 'ALERT';

  /**
   * What problem an ALERT is about, so one domain event closes every
   * occurrence of it. Required for an ALERT and ignored for news.
   *
   * The identity of the PROBLEM, not of the event. A consignment that has
   * lost two carriers in a row has two notifications and one resolution key,
   * and giving it a carrier closes both.
   */
  resolutionKey?: string;
}

/**
 * Write one.
 *
 * Never throws into the caller's path on its own account: a decision that was
 * correctly recorded must not be rolled back because the notice about it could
 * not be written. When a transaction is passed it joins that transaction and
 * shares its fate, which is what a decision wants — but an unparented call is
 * best-effort and says so in the log.
 */
export async function notifySeller(input: NotifyInput): Promise<void> {
  const client = input.tx ?? prisma;
  const id = newId();
  const isAlert = (input.class ?? 'INFORMATION') === 'ALERT';

  if (isAlert && (input.resolutionKey ?? '') === '') {
    throw new Error(
      `seller notification kind "${input.kind}" is an alert and needs a resolutionKey`,
    );
  }

  const data = {
    id,
    sellerAccountId: input.sellerAccountId,
    kind: input.kind,
    title: input.title.slice(0, 200),
    body: input.body,
    linkPath: input.linkPath ?? null,
    severity: input.severity ?? 'INFO',
    subjectType: input.subjectType ?? null,
    subjectId: input.subjectId ?? null,
    readByJson: {},
    expiresAt: input.expiresAt ?? null,
    // Its own id when the caller supplied none: unique by construction, so a
    // decision always writes and deduplicates against nothing.
    dedupeKey: (input.dedupeKey ?? id).slice(0, 120),
    class: input.class ?? 'INFORMATION',
    status: 'ACTIVE' as const,
    resolutionKey: isAlert ? (input.resolutionKey?.slice(0, 120) ?? null) : null,
  };

  if (input.tx !== undefined) {
    // Inside a caller's transaction a duplicate is still a success, but every
    // OTHER failure is theirs to see: swallowing one would leave the
    // transaction marked aborted by MariaDB and the caller committing
    // something that cannot commit.
    try {
      await client.sellerNotification.create({ data });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
    return;
  }

  try {
    await client.sellerNotification.create({ data });
  } catch {
    // Swallowed on purpose, and only on the unparented path. The caller has
    // already done the thing this was going to describe - including the case
    // where it was already described, which is what the unique index reports.
  }
}

/** P2002: the same thing has already been announced. That is a success. */
function isDuplicate(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Close every live alert about one problem.
 *
 * The mirror of `resolveLogisticsNotifications`, deliberately the same shape
 * and called from the same places: a domain event that fixes something closes
 * the alert on the seller's feed and the carrier's, or on neither.
 *
 * Idempotent, because `updateMany` filtered on ACTIVE writes nothing the
 * second time - so a retried worker and a double-pressed button land on one
 * answer, and the first resolution's note is the one that survives.
 *
 * NOTHING IS DELETED. The row stays, with when it was resolved and by what,
 * because "this happened and here is what was done about it" is the record a
 * seller reads after a bad week. It simply stops counting towards the badge.
 */
export async function resolveSellerNotifications(
  input: {
    resolutionKey: string;
    source?: 'DOMAIN_EVENT' | 'MANUAL' | 'SYSTEM_SWEEP' | 'SUPERSEDED';
    note?: string | null;
  },
  tx?: Client,
): Promise<number> {
  const client = tx ?? prisma;

  const result = await client.sellerNotification.updateMany({
    where: { resolutionKey: input.resolutionKey, status: 'ACTIVE' },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      resolutionSource: input.source ?? 'DOMAIN_EVENT',
      resolutionNote: input.note?.slice(0, 512) ?? null,
    },
  });

  return result.count;
}

/**
 * The resolution key for "this consignment has nobody carrying it".
 *
 * One key per consignment, not per refusal, so a parcel that has been turned
 * down by two carriers in a row has two notifications and one problem - and
 * handing it to a third closes both.
 */
export function consignmentUnassignedKey(shipmentId: string): string {
  return `consignment-unassigned:${shipmentId}`;
}

/**
 * Write one unless the same subject already produced one recently.
 *
 * For the repeating, machine-generated notices — low stock, an approaching
 * dispatch deadline — where the event fires on every movement but the seller
 * only needs telling once. A decision should use `notifySeller` instead: two
 * refusals of the same listing are two things to read.
 */
export async function notifySellerOnce(
  input: NotifyInput & { subjectType: string; subjectId: string; withinMs?: number },
): Promise<void> {
  const client = input.tx ?? prisma;
  const within = new Date(Date.now() - (input.withinMs ?? 24 * 60 * 60 * 1000));

  /*
   * TWO MECHANISMS, AND THEY DO DIFFERENT JOBS.
   *
   * The window query below answers "has this been said recently" - one
   * low-stock notice per offer per DAY, which is a policy about how often a
   * repeating condition is worth mentioning, and no index can express it.
   *
   * The `dedupeKey` answers "has this exact thing been said at all", and it is
   * a UNIQUE index precisely because the query cannot be trusted alone: a
   * check-then-insert loses to two workers arriving in the same second, and
   * both would find nothing and both would insert. The window narrows; the
   * constraint decides.
   *
   * Keyed on the subject rather than on the row, so two callers racing over
   * the same offer collide on the index instead of writing two notices.
   */
  const existing = await client.sellerNotification.findFirst({
    where: {
      sellerAccountId: input.sellerAccountId,
      kind: input.kind,
      subjectId: input.subjectId,
      createdAt: { gte: within },
    },
    select: { id: true },
  });

  if (existing !== null) return;

  await notifySeller({
    ...input,
    // The day is part of the key, so tomorrow's notice about the same offer is
    // a different thing and is allowed through - which is the whole behaviour
    // the window above describes, now expressed where it can be enforced.
    dedupeKey: input.dedupeKey ?? `${input.subjectId}:${dayStamp()}`,
  });
}

/** `2026-09-22`, in UTC. The unit `notifySellerOnce` repeats on. */
function dayStamp(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
