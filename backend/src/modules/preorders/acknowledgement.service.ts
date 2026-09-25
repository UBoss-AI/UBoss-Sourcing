/**
 * The bulk preorder information a buyer acknowledges before their first
 * preorder.
 *
 * The note says three things: preorder is for large quantities, each product
 * has a minimum, and a request goes to the seller to confirm quantity, price,
 * availability and date - with nothing charged until then. The buyer ticks
 * that they understood it once, per version of the note.
 *
 * The server is the only authority on whether that happened:
 *
 *   - It records only the CURRENT version (`PREORDER_INFO_VERSION`). A page
 *     left open while the operator raised the version cannot record the old
 *     one - it is told the text changed, and shows it again.
 *   - A submission is checked against this table, never against anything in
 *     the request body. The body schema is strict, so "acknowledged: true"
 *     sent by hand is refused before it reaches here.
 *
 * It is not acceptance of legal terms and not consent to be charged; see the
 * `CustomerAcknowledgement` model.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/** The version of the note buyers are asked about today. */
export function currentPreorderInfoVersion(): string {
  return env.PREORDER_INFO_VERSION;
}

/** Has this person acknowledged the current version? */
export async function hasAcknowledgedPreorderInfo(userId: string): Promise<boolean> {
  const row = await prisma.customerAcknowledgement.findUnique({
    where: {
      userId_type_policyVersion: {
        userId,
        type: 'PREORDER_INFO',
        policyVersion: currentPreorderInfoVersion(),
      },
    },
    select: { id: true },
  });
  return row !== null;
}

/** Refuse a submission from somebody who has not read the current note. */
export async function assertPreorderInfoAcknowledged(userId: string): Promise<void> {
  if (await hasAcknowledgedPreorderInfo(userId)) return;
  const policyVersion = currentPreorderInfoVersion();
  throw conflict(
    ErrorCode.PREORDER_ACKNOWLEDGEMENT_REQUIRED,
    'Read and acknowledge how bulk preorders work before sending a request.',
    [{ field: 'acknowledgement', code: 'REQUIRED', meta: { policyVersion } }],
  );
}

/**
 * Record that this person read the note at `policyVersion`.
 *
 * Idempotent: acknowledging the same version twice keeps the first row and
 * its time, and writes one audit entry, not two.
 */
export async function acknowledgePreorderInfo(input: {
  userId: string;
  email: string;
  policyVersion: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}): Promise<{ policyVersion: string; acknowledgedAt: Date }> {
  const current = currentPreorderInfoVersion();
  if (input.policyVersion !== current) {
    throw conflict(
      ErrorCode.PREORDER_INFO_OUTDATED,
      'The preorder information has changed. Read the current version.',
      [{ field: 'policyVersion', code: 'OUTDATED', meta: { policyVersion: current } }],
    );
  }

  const key = { userId: input.userId, type: 'PREORDER_INFO' as const, policyVersion: current };

  try {
    return await recordOnce(key, input);
  } catch (error) {
    // Two tabs pressing Agree at once: the unique index let one row in, and
    // the other request answers with that row.
    if (isUniqueViolation(error)) {
      return prisma.customerAcknowledgement.findUniqueOrThrow({
        where: { userId_type_policyVersion: key },
        select: { policyVersion: true, acknowledgedAt: true },
      });
    }
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}

function recordOnce(
  key: { userId: string; type: 'PREORDER_INFO'; policyVersion: string },
  input: {
    userId: string;
    email: string;
    ipAddress?: string | null;
    correlationId?: string | null;
  },
): Promise<{ policyVersion: string; acknowledgedAt: Date }> {
  const current = key.policyVersion;
  return prisma.$transaction(async (tx) => {
    const existing = await tx.customerAcknowledgement.findUnique({
      where: { userId_type_policyVersion: key },
      select: { policyVersion: true, acknowledgedAt: true },
    });
    if (existing !== null) return existing;

    const created = await tx.customerAcknowledgement.create({
      data: { id: newId(), ...key },
      select: { policyVersion: true, acknowledgedAt: true },
    });

    await recordAudit(
      {
        action: AuditAction.PREORDER_INFO_ACKNOWLEDGED,
        resourceType: 'customer_acknowledgement',
        resourceId: input.userId,
        actorType: 'CUSTOMER',
        actorUserId: input.userId,
        actorEmail: input.email,
        after: { type: 'PREORDER_INFO', policyVersion: current },
        ipAddress: input.ipAddress ?? null,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    return created;
  });
}
