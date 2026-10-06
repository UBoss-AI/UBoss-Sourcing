/**
 * The append-only history of compliance rules, cases and documents.
 *
 * Every decision writes one line here, in the same transaction as the
 * decision. `sellerVisible` lines are what the Seller Hub shows as the case's
 * history; the rest - internal notes, reviewer hand-overs - stay with staff.
 */
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import type { prisma } from '../../infra/prisma.js';

export interface ComplianceActor {
  type: 'SYSTEM' | 'SELLER' | 'AUDIT' | 'ADMIN';
  userId: string | null;
  label: string;
  correlationId?: string | null;
}

export const SYSTEM_COMPLIANCE_ACTOR: ComplianceActor = Object.freeze({ type: 'SYSTEM', userId: null, label: 'The system' });

export async function recordComplianceEvent(
  client: PrismaTransaction | typeof prisma,
  input: {
    subjectType: 'REQUIREMENT' | 'CASE' | 'DOCUMENT';
    subjectId: string;
    sellerAccountId?: string | null;
    kind: string;
    actor: ComplianceActor;
    summary: string;
    sellerVisible?: boolean;
    data?: Record<string, unknown> | null;
  },
): Promise<void> {
  await client.complianceEvent.create({
    data: {
      id: newId(),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      sellerAccountId: input.sellerAccountId ?? null,
      kind: input.kind.slice(0, 48),
      actorType: input.actor.type,
      actorUserId: input.actor.userId,
      actorLabel: input.actor.label.slice(0, 160),
      summary: input.summary.slice(0, 1000),
      sellerVisible: input.sellerVisible ?? false,
      dataJson: (input.data ?? undefined) as never,
    },
  });
}
