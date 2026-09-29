/**
 * Support service levels: how quickly the team promises to answer, and to
 * resolve, a request in each category.
 *
 * Every target is a setting. A category the operator has not set uses the
 * defaults below - a starting point any business can change, not a promise
 * this software makes on their behalf.
 *
 * A ticket COPIES its two deadlines when it is sent (`deadlinesFor`), so a
 * target changed later moves no promise already made, and the inbox can sort
 * and filter on plain columns.
 *
 * The clock does not stop while the team waits for the sender. That is a
 * deliberate simplification: a paused clock needs a history of pauses to be
 * explainable later, and the thread already shows when the team was waiting.
 */
import { z } from 'zod';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import {
  SupportTicketCategoryValues,
  type SupportTicketCategoryName,
} from '../../domain/support-ticket-state.js';
import { addHours, isBreached } from '../../domain/dispute-state.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface SupportSlaTarget {
  firstResponseHours: number;
  resolutionHours: number;
}

/** The targets a category has until the operator sets its own. */
export const DEFAULT_SUPPORT_SLA: Readonly<Record<SupportTicketCategoryName, SupportSlaTarget>> =
  Object.freeze({
    ORDERS: { firstResponseHours: 8, resolutionHours: 48 },
    PAYMENTS: { firstResponseHours: 8, resolutionHours: 48 },
    PREORDERS: { firstResponseHours: 24, resolutionHours: 72 },
    PRODUCTS: { firstResponseHours: 24, resolutionHours: 72 },
    SELLER_HUB: { firstResponseHours: 24, resolutionHours: 72 },
    LOGISTICS: { firstResponseHours: 8, resolutionHours: 48 },
    COMPANY_VERIFICATION: { firstResponseHours: 24, resolutionHours: 120 },
    ERP_INTEGRATION: { firstResponseHours: 24, resolutionHours: 120 },
    ACCOUNT_SECURITY: { firstResponseHours: 4, resolutionHours: 24 },
    OTHER: { firstResponseHours: 24, resolutionHours: 72 },
  });

export interface SupportSlaPolicyView extends SupportSlaTarget {
  category: SupportTicketCategoryName;
  /** False when the category is on the defaults. */
  customised: boolean;
  updatedAt: string | null;
}

type Client = Pick<PrismaTransaction, 'supportSlaPolicy'>;

/** Every category's targets: the operator's where set, the defaults elsewhere. */
export async function listSupportSlaPolicies(
  client: Client = prisma,
): Promise<SupportSlaPolicyView[]> {
  const rows = await client.supportSlaPolicy.findMany();
  const byCategory = new Map(rows.map((row) => [row.category, row]));
  return SupportTicketCategoryValues.map((category) => {
    const row = byCategory.get(category);
    return row === undefined
      ? { category, ...DEFAULT_SUPPORT_SLA[category], customised: false, updatedAt: null }
      : {
          category,
          firstResponseHours: row.firstResponseHours,
          resolutionHours: row.resolutionHours,
          customised: true,
          updatedAt: row.updatedAt.toISOString(),
        };
  });
}

/** The two deadlines a request sent now, in this category, is held to. */
export async function deadlinesFor(
  category: SupportTicketCategoryName,
  sentAt: Date,
  client: Client = prisma,
): Promise<{ firstResponseDueAt: Date; resolutionDueAt: Date }> {
  const row = await client.supportSlaPolicy.findUnique({ where: { category } });
  const target = row ?? DEFAULT_SUPPORT_SLA[category];
  return {
    firstResponseDueAt: addHours(sentAt, target.firstResponseHours),
    resolutionDueAt: addHours(sentAt, target.resolutionHours),
  };
}

export interface SupportSlaView {
  firstResponseDueAt: string | null;
  resolutionDueAt: string | null;
  firstRespondedAt: string | null;
  /** The first reply came late, or has not come and is late. */
  firstResponseBreached: boolean;
  /** Resolved late, or not resolved and late. */
  resolutionBreached: boolean;
}

/** A ticket's service level, as staff see it. Breach is worked out, not stored. */
export function slaView(
  row: {
    firstResponseDueAt: Date | null;
    resolutionDueAt: Date | null;
    firstRespondedAt: Date | null;
    resolvedAt: Date | null;
    closedAt: Date | null;
  },
  now: Date = new Date(),
): SupportSlaView {
  return {
    firstResponseDueAt: row.firstResponseDueAt?.toISOString() ?? null,
    resolutionDueAt: row.resolutionDueAt?.toISOString() ?? null,
    firstRespondedAt: row.firstRespondedAt?.toISOString() ?? null,
    firstResponseBreached: isBreached(row.firstResponseDueAt, row.firstRespondedAt, now),
    resolutionBreached: isBreached(row.resolutionDueAt, row.resolvedAt ?? row.closedAt, now),
  };
}

/** The inbox filter for "late": a deadline passed and still waiting on it. */
export function breachedWhere(now: Date = new Date()) {
  return {
    OR: [
      { firstRespondedAt: null, firstResponseDueAt: { lt: now } },
      { resolvedAt: null, closedAt: null, resolutionDueAt: { lt: now } },
    ],
  };
}

const HOURS = z.number().int().min(1).max(8760);

export const slaPoliciesInput = z.object({
  policies: z
    .array(
      z.object({
        category: z.enum(SupportTicketCategoryValues),
        firstResponseHours: HOURS,
        resolutionHours: HOURS,
      }),
    )
    .min(1)
    .max(SupportTicketCategoryValues.length),
});

export interface SlaActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** Save targets for the categories given. Others are left as they are. */
export async function saveSupportSlaPolicies(
  actor: SlaActor,
  input: z.infer<typeof slaPoliciesInput>,
): Promise<SupportSlaPolicyView[]> {
  for (const policy of input.policies) {
    if (policy.resolutionHours < policy.firstResponseHours) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A resolution target cannot be sooner than the first-response target.',
        [{ field: `policies.${policy.category}.resolutionHours`, code: 'BEFORE_FIRST_RESPONSE' }],
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const before = await listSupportSlaPolicies(tx);
    for (const policy of input.policies) {
      await tx.supportSlaPolicy.upsert({
        where: { category: policy.category },
        create: {
          id: newId(),
          category: policy.category,
          firstResponseHours: policy.firstResponseHours,
          resolutionHours: policy.resolutionHours,
          updatedById: actor.userId,
        },
        update: {
          firstResponseHours: policy.firstResponseHours,
          resolutionHours: policy.resolutionHours,
          updatedById: actor.userId,
        },
      });
    }
    const after = await listSupportSlaPolicies(tx);
    await recordAudit(
      {
        action: AuditAction.SUPPORT_TICKET_SLA_POLICY_SAVED,
        resourceType: 'support_sla_policy',
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: Object.fromEntries(
          before.map((row) => [row.category, [row.firstResponseHours, row.resolutionHours]]),
        ),
        after: Object.fromEntries(
          after.map((row) => [row.category, [row.firstResponseHours, row.resolutionHours]]),
        ),
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return after;
  });
}
