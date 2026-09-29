/**
 * Shared pieces of the inspection module: who is acting, the timeline, the
 * order's audit trail, the policy row and the job/NCR numbering.
 *
 * Every inspection decision is written twice, on purpose. `inspection_events`
 * is the inspection's own timeline - what the buyer, the seller and the agency
 * are shown. `audit_logs` (resourceType `order`, the buyer order's id) is the
 * order's audit trail, which is where an operator looks after something went
 * wrong and which nobody but the maintenance account can edit (FLOW-006).
 */
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { newId } from '../../infra/ids.js';
import { AuditAction, recordAudit, type AuditActionKey } from '../audit/audit.service.js';

export type InspectionPartyName = 'SYSTEM' | 'SELLER' | 'BUYER' | 'OPERATOR' | 'AGENCY';

/** Somebody acting on an inspection, in the one shape every service takes. */
export interface InspectionActor {
  party: InspectionPartyName;
  /** users.id of the person, or null for the system. */
  userId: string | null;
  /** A name for the timeline: "Priya Shah (Acme Inspection)". */
  label: string;
  email?: string | null;
  correlationId?: string | null;
}

export const SYSTEM_ACTOR: InspectionActor = Object.freeze({
  party: 'SYSTEM',
  userId: null,
  label: 'The system',
});

export interface EventInput {
  requirementId: string;
  orderId: string;
  jobId?: string | null;
  kind: string;
  actor: InspectionActor;
  summary: string;
  data?: Record<string, unknown> | null;
  visibleToBuyer?: boolean;
  visibleToSeller?: boolean;
  /** Also write an audit row on the order. */
  audit?: AuditActionKey;
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) => (typeof entry === 'bigint' ? entry.toString() : entry)),
  );
}

/** Append to the timeline, and to the order's audit trail when asked. */
export async function recordInspectionEvent(tx: PrismaTransaction, input: EventInput): Promise<void> {
  await tx.inspectionEvent.create({
    data: {
      id: newId(),
      requirementId: input.requirementId,
      orderId: input.orderId,
      jobId: input.jobId ?? null,
      kind: input.kind.slice(0, 48),
      actorParty: input.actor.party,
      actorId: input.actor.userId,
      actorLabel: input.actor.label.slice(0, 160),
      summary: input.summary.slice(0, 512),
      dataJson: input.data === undefined || input.data === null ? undefined : (jsonSafe(input.data) as never),
      visibleToBuyer: input.visibleToBuyer ?? true,
      visibleToSeller: input.visibleToSeller ?? true,
    },
  });

  if (input.audit !== undefined) {
    await recordAudit(
      {
        action: input.audit,
        resourceType: 'order',
        resourceId: input.orderId,
        actorType: auditActorType(input.actor.party),
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email ?? null,
        after: {
          requirementId: input.requirementId,
          jobId: input.jobId ?? null,
          kind: input.kind,
          summary: input.summary,
          by: input.actor.label,
          ...(input.data ?? {}),
        },
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  }
}

function auditActorType(party: InspectionPartyName): 'SYSTEM' | 'ADMIN' | 'CUSTOMER' {
  if (party === 'OPERATOR') return 'ADMIN';
  if (party === 'SYSTEM') return 'SYSTEM';
  // Sellers, buyers and agency people all sign in with storefront accounts.
  return 'CUSTOMER';
}

export { AuditAction };

// ---------------------------------------------------------------------------
// The policy row
// ---------------------------------------------------------------------------

export const POLICY_ID = 'default';

export type InspectionPolicyRow = Awaited<ReturnType<typeof prisma.inspectionPolicy.findUniqueOrThrow>>;

type PolicyClient = Pick<typeof prisma, 'inspectionPolicy'>;

/**
 * The operator's settings, created with the schema's defaults the first time
 * anything asks. The defaults are the only place a number lives until the
 * operator changes it.
 */
export async function readPolicy(client: PolicyClient = prisma): Promise<InspectionPolicyRow> {
  const existing = await client.inspectionPolicy.findUnique({ where: { id: POLICY_ID } });
  if (existing !== null) return existing;

  try {
    return await client.inspectionPolicy.create({ data: { id: POLICY_ID } });
  } catch {
    // Two first requests at once; the other one made it.
    return client.inspectionPolicy.findUniqueOrThrow({ where: { id: POLICY_ID } });
  }
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/** `INS-2026-000042`. Same counter pattern as order numbers. */
export async function nextJobNumber(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `inspection-job:${String(year)}`;

  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'INS', padding: 6 },
  });

  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

/** Nth NCR on a job: `INS-2026-000042-NCR-03`. */
export function ncrNumberFor(jobNumber: string, index: number): string {
  return `${jobNumber}-NCR-${String(index).padStart(2, '0')}`;
}
