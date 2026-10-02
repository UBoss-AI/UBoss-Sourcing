/**
 * The admin exception queues, with their SLAs and owners (LIVE-011).
 *
 * Reads every queue in `exception-queues.definitions.ts` that the caller may
 * see, applies the operator's SLA and owner settings (or the defaults), and
 * reports for each: how many items wait, when the oldest arrived and how many
 * are past the SLA. A queue whose count fails is reported with `error: true`
 * rather than taking the whole screen down.
 *
 * Owners are ROLES. Naming the actual person who holds each role on a given
 * shift is the operator's job and stays outside the software; see
 * docs/INCIDENT-READINESS.md.
 */
import { z } from 'zod';
import { badRequest, ErrorCode, notFound } from '../../domain/errors.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { EXCEPTION_QUEUES } from './exception-queues.definitions.js';
import type { StaffActor } from './pending-action.service.js';

export const exceptionQueueSettingInput = z
  .object({
    slaHours: z.number().int().min(1).max(24 * 90),
    ownerRole: z.string().trim().min(1).max(64),
    escalationRole: z.string().trim().min(1).max(64),
  })
  .strict();
export type ExceptionQueueSettingInput = z.infer<typeof exceptionQueueSettingInput>;

export interface ExceptionQueueView {
  key: string;
  href: string;
  slaHours: number;
  ownerRole: string;
  escalationRole: string;
  /** True when the operator has not changed this queue's settings. */
  isDefault: boolean;
  count: number;
  oldestAt: string | null;
  /** Whole hours the oldest item has waited. */
  oldestAgeHours: number | null;
  breached: number;
  /** The count could not be read this time. */
  error: boolean;
}

export async function readExceptionQueues(viewer: {
  permissions: readonly string[];
}): Promise<{ generatedAt: string; queues: ExceptionQueueView[] }> {
  const granted = new Set(viewer.permissions);
  const visible = EXCEPTION_QUEUES.filter((queue) => granted.has(queue.permission));
  const settings = new Map(
    (await prisma.exceptionQueueSetting.findMany()).map((row) => [row.queueKey, row] as const),
  );
  const now = Date.now();

  const queues = await Promise.all(
    visible.map(async (queue): Promise<ExceptionQueueView> => {
      const setting = settings.get(queue.key);
      const slaHours = setting?.slaHours ?? queue.defaultSlaHours;
      const base = {
        key: queue.key,
        href: queue.href,
        slaHours,
        ownerRole: setting?.ownerRole ?? queue.defaultOwnerRole,
        escalationRole: setting?.escalationRole ?? queue.defaultEscalationRole,
        isDefault: setting === undefined,
      };
      try {
        const measure = await queue.measure(new Date(now - slaHours * 3_600_000));
        return {
          ...base,
          count: measure.count,
          oldestAt: measure.oldest?.toISOString() ?? null,
          oldestAgeHours: measure.oldest === null ? null : Math.floor((now - measure.oldest.getTime()) / 3_600_000),
          breached: measure.breached,
          error: false,
        };
      } catch (error) {
        logger.error({ err: error, queue: queue.key }, 'exception queue count failed');
        return { ...base, count: 0, oldestAt: null, oldestAgeHours: null, breached: 0, error: true };
      }
    }),
  );

  return { generatedAt: new Date(now).toISOString(), queues };
}

/** Change one queue's SLA and owners. Both roles must exist. Audited. */
export async function saveExceptionQueueSetting(
  key: string,
  input: ExceptionQueueSettingInput,
  actor: StaffActor,
): Promise<{ key: string; slaHours: number; ownerRole: string; escalationRole: string }> {
  const queue = EXCEPTION_QUEUES.find((candidate) => candidate.key === key);
  if (queue === undefined) throw notFound('Exception queue');

  const roles = await prisma.role.findMany({
    where: { key: { in: [input.ownerRole, input.escalationRole] } },
    select: { key: true },
  });
  const known = new Set(roles.map((role) => role.key));
  for (const field of ['ownerRole', 'escalationRole'] as const) {
    if (!known.has(input[field])) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose a role that exists.', [{ field, code: 'UNKNOWN_ROLE' }]);
    }
  }

  await prisma.$transaction(async (tx) => {
    const before = await tx.exceptionQueueSetting.findUnique({ where: { queueKey: key } });
    await tx.exceptionQueueSetting.upsert({
      where: { queueKey: key },
      create: { queueKey: key, ...input, updatedById: actor.userId },
      update: { ...input, updatedById: actor.userId },
    });
    await recordAudit(
      {
        action: AuditAction.EXCEPTION_QUEUE_UPDATED,
        resourceType: 'exception_queue',
        resourceId: null,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before:
          before === null
            ? { key, slaHours: queue.defaultSlaHours, ownerRole: queue.defaultOwnerRole, escalationRole: queue.defaultEscalationRole, isDefault: true }
            : { key, slaHours: before.slaHours, ownerRole: before.ownerRole, escalationRole: before.escalationRole },
        after: { key, ...input },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { key, ...input };
}
