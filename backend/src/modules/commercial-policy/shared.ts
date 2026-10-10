/**
 * What every service in the commercial-policy module shares: who is acting,
 * the separation-of-duties refusal, audit recording and money serialising.
 */
import { ErrorCode, AppError } from '../../domain/errors.js';
import type { prisma, PrismaTransaction } from '../../infra/prisma.js';
import { recordAudit, type AuditActionKey, type AuditActorType } from '../audit/audit.service.js';

export type Client = PrismaTransaction | typeof prisma;

export interface StaffActor {
  userId: string;
  email?: string | null;
  actorType?: AuditActorType;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export function separationRefusal(step: string, message: string): AppError {
  return new AppError({ statusCode: 403, code: ErrorCode.SEPARATION_OF_DUTIES_REQUIRED, message, details: [{ code: step }] });
}

export async function audit(client: Client, actor: StaffActor, action: AuditActionKey, resourceType: string, resourceId: string, before: unknown, after: unknown): Promise<void> {
  await recordAudit(
    {
      action,
      resourceType,
      resourceId,
      actorType: actor.actorType ?? 'ADMIN',
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
      before,
      after,
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    },
    client,
  );
}

/** BigInt-safe JSON for API responses: every bigint becomes a string. */
export function serialise<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
}

export function minor(value: string | number | bigint): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('money must be an integer number of minor units');
    return BigInt(value);
  }
  if (!/^-?\d{1,19}$/.test(value)) throw new RangeError('money must be an integer number of minor units');
  return BigInt(value);
}
