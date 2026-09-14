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

  const data = {
    id: newId(),
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
  };

  if (input.tx !== undefined) {
    await client.sellerNotification.create({ data });
    return;
  }

  try {
    await client.sellerNotification.create({ data });
  } catch {
    // Swallowed on purpose, and only on the unparented path. The caller has
    // already done the thing this was going to describe.
  }
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

  await notifySeller(input);
}
