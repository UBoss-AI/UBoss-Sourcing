/**
 * The facts an owner needs to review who has access (checklist Master row 14).
 *
 * A periodic access review asks, for each person on a team: what can they do,
 * since when, who let them in, and are they still using it? The first three
 * are on the membership row. The last is read here from what the sign-in
 * machinery already records:
 *
 *   - `lastSignInAt` - `users.lastLoginAt`, stamped on every successful
 *     password sign-in.
 *   - `lastActiveAt` - the newest session row for the account. A session is
 *     re-issued every time its access token is refreshed, so this is when the
 *     person was last using the site, to within one access-token lifetime.
 *     Expired sessions are purged, so an old date can become "no record".
 *   - `lastHubActivityAt` (sellers only) - the newest deliberate Seller Hub
 *     activity on a session unlocked for THIS seller.
 *
 * Nothing new is tracked for this: a review screen that needed a new tracker
 * would have nothing to show for everybody who signed in before it shipped.
 *
 * "Access review done" is one row in `team_access_reviews` per confirmation,
 * written together with an audit entry by the team services.
 */
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

type Client = PrismaTransaction | typeof prisma;

export interface AccessActivity {
  lastSignInAt: string | null;
  lastActiveAt: string | null;
}

export interface AccessReviewView {
  id: string;
  reviewedAt: string;
  reviewedByName: string;
  memberCount: number;
  invitationCount: number;
}

export interface AccessReviewSummary {
  /** Newest first, at most five. */
  reviews: AccessReviewView[];
  /** Days between reviews this deployment asks for; 0 means no reminder. */
  intervalDays: number;
  /** When the next review is due, or null when there is no reminder. */
  dueAt: string | null;
  /** True when a review is due now (never reviewed counts as due). */
  due: boolean;
}

export type AccessReviewScope = { sellerAccountId: string } | { buyerCompanyId: string };

const iso = (value: Date | null | undefined): string | null => (value === null || value === undefined ? null : value.toISOString());

function newest(...dates: (Date | null | undefined)[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (date !== null && date !== undefined && (best === null || date.getTime() > best.getTime())) best = date;
  }
  return best;
}

/** Last sign-in and last activity for each account, keyed by user id. */
export async function activityForUsers(userIds: readonly string[], client: Client = prisma): Promise<Map<string, AccessActivity>> {
  const ids = [...new Set(userIds)];
  const result = new Map<string, AccessActivity>();
  if (ids.length === 0) return result;

  const [users, sessions] = await Promise.all([
    client.user.findMany({ where: { id: { in: ids } }, select: { id: true, lastLoginAt: true } }),
    client.session.groupBy({ by: ['userId'], where: { userId: { in: ids } }, _max: { createdAt: true } }),
  ]);
  const sessionAt = new Map(sessions.map((row) => [row.userId, row._max.createdAt]));
  for (const user of users) {
    result.set(user.id, {
      lastSignInAt: iso(user.lastLoginAt),
      lastActiveAt: iso(newest(user.lastLoginAt, sessionAt.get(user.id))),
    });
  }
  return result;
}

/** The newest deliberate Seller Hub activity for this seller, keyed by user id. */
export async function hubActivityForSeller(
  sellerAccountId: string,
  userIds: readonly string[],
  client: Client = prisma,
): Promise<Map<string, string | null>> {
  const ids = [...new Set(userIds)];
  const result = new Map<string, string | null>();
  if (ids.length === 0) return result;
  const rows = await client.session.groupBy({
    by: ['userId'],
    where: { userId: { in: ids }, sellerUnlockedForId: sellerAccountId },
    _max: { sellerLastActivityAt: true, sellerUnlockedAt: true },
  });
  for (const row of rows) result.set(row.userId, iso(newest(row._max.sellerLastActivityAt, row._max.sellerUnlockedAt)));
  return result;
}

/** A display name for each account: the profile's full name, else the email. */
export async function namesForUsers(userIds: readonly (string | null)[], client: Client = prisma): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const users = await client.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true, customerProfile: { select: { fullName: true } } },
  });
  return new Map(users.map((user) => [user.id, nameOf(user.customerProfile?.fullName, user.email)]));
}

/** A display name for each customer profile, keyed by profile id. */
export async function namesForProfiles(profileIds: readonly (string | null)[], client: Client = prisma): Promise<Map<string, string>> {
  const ids = [...new Set(profileIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const profiles = await client.customerProfile.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true, user: { select: { email: true } } },
  });
  return new Map(profiles.map((profile) => [profile.id, nameOf(profile.fullName, profile.user.email)]));
}

function nameOf(fullName: string | null | undefined, email: string): string {
  return fullName !== null && fullName !== undefined && fullName.trim() !== '' ? fullName : email;
}

/** The recent reviews of one team, and whether another is due. */
export async function accessReviewSummary(scope: AccessReviewScope, client: Client = prisma): Promise<AccessReviewSummary> {
  const rows = await client.teamAccessReview.findMany({
    where: scope,
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  const names = await namesForUsers(rows.map((row) => row.reviewedByUserId), client);
  const intervalDays = env.TEAM_ACCESS_REVIEW_INTERVAL_DAYS;
  const last = rows[0]?.createdAt ?? null;
  const dueAt = intervalDays === 0 || last === null ? null : new Date(last.getTime() + intervalDays * 86_400_000);
  return {
    reviews: rows.map((row) => ({
      id: row.id,
      reviewedAt: row.createdAt.toISOString(),
      reviewedByName: names.get(row.reviewedByUserId) ?? '',
      memberCount: row.memberCount,
      invitationCount: row.invitationCount,
    })),
    intervalDays,
    dueAt: iso(dueAt),
    due: intervalDays !== 0 && (dueAt === null || dueAt.getTime() <= Date.now()),
  };
}

/** Write one "I have checked who has access" row. The caller audits it in the same transaction. */
export async function insertAccessReview(
  tx: PrismaTransaction,
  scope: AccessReviewScope,
  input: { reviewedByUserId: string; memberCount: number; invitationCount: number },
): Promise<string> {
  const id = newId();
  await tx.teamAccessReview.create({
    data: {
      id,
      ...('sellerAccountId' in scope ? { sellerAccountId: scope.sellerAccountId } : { buyerCompanyId: scope.buyerCompanyId }),
      reviewedByUserId: input.reviewedByUserId,
      memberCount: input.memberCount,
      invitationCount: input.invitationCount,
    },
  });
  return id;
}
