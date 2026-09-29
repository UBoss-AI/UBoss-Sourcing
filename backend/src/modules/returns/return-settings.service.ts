/**
 * The operator's return policy: how long buyers have, which reasons they may
 * give, which of those need a photograph, and whether replacements are
 * offered.
 *
 * One row, created with `DEFAULT_RETURN_POLICY` the first time anybody reads
 * it, because a fresh installation must have a working policy before staff
 * have opened the settings screen. Every figure is a setting: this product is
 * run by whoever buys it, and a return window is a business decision.
 */
import { z } from 'zod';
import {
  DEFAULT_RETURN_POLICY,
  RETURN_REASON_CODES,
  isReturnReasonCode,
  type ReturnReasonCode,
} from '../../domain/return-state.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface ReturnPolicy {
  windowDays: number;
  reasonCodes: ReturnReasonCode[];
  evidenceRequired: ReturnReasonCode[];
  replacementEnabled: boolean;
  operatorInstructions: string | null;
  /** Every code there is, so the settings screen can offer the ones switched off. */
  catalogue: readonly ReturnReasonCode[];
  updatedAt: string | null;
}

function codes(value: unknown): ReturnReasonCode[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<ReturnReasonCode>();
  for (const entry of value) {
    if (typeof entry === 'string' && isReturnReasonCode(entry)) seen.add(entry);
  }
  return [...seen];
}

async function row() {
  const existing = await prisma.returnSettings.findFirst({ orderBy: { createdAt: 'asc' } });
  if (existing !== null) return existing;
  // Two first reads at once may both insert; the oldest row wins every later
  // read, so the spare is harmless.
  return prisma.returnSettings.create({
    data: {
      id: newId(),
      windowDays: DEFAULT_RETURN_POLICY.windowDays,
      reasonCodesJson: [...DEFAULT_RETURN_POLICY.reasonCodes],
      evidenceRequiredJson: [...DEFAULT_RETURN_POLICY.evidenceRequired],
      replacementEnabled: DEFAULT_RETURN_POLICY.replacementEnabled,
    },
  });
}

export async function getReturnPolicy(): Promise<ReturnPolicy> {
  const settings = await row();
  const reasonCodes = codes(settings.reasonCodesJson);
  return {
    windowDays: settings.windowDays,
    reasonCodes,
    // Only codes that are offered can require anything.
    evidenceRequired: codes(settings.evidenceRequiredJson).filter((code) =>
      reasonCodes.includes(code),
    ),
    replacementEnabled: settings.replacementEnabled,
    operatorInstructions: settings.operatorInstructions,
    catalogue: RETURN_REASON_CODES,
    updatedAt: settings.updatedAt.toISOString(),
  };
}

export const returnPolicyInput = z.object({
  windowDays: z.number().int().min(0).max(365).optional(),
  reasonCodes: z.array(z.enum(RETURN_REASON_CODES)).min(1).max(RETURN_REASON_CODES.length).optional(),
  evidenceRequired: z.array(z.enum(RETURN_REASON_CODES)).max(RETURN_REASON_CODES.length).optional(),
  replacementEnabled: z.boolean().optional(),
  operatorInstructions: z.string().trim().max(4000).nullable().optional(),
});

export async function updateReturnPolicy(
  input: z.infer<typeof returnPolicyInput>,
  actor: { userId: string; email: string; ipAddress?: string | null; correlationId?: string | null },
): Promise<ReturnPolicy> {
  const before = await getReturnPolicy();
  const settings = await row();

  await prisma.$transaction(async (tx) => {
    await tx.returnSettings.update({
      where: { id: settings.id },
      data: {
        ...(input.windowDays !== undefined ? { windowDays: input.windowDays } : {}),
        ...(input.reasonCodes !== undefined ? { reasonCodesJson: [...new Set(input.reasonCodes)] } : {}),
        ...(input.evidenceRequired !== undefined
          ? { evidenceRequiredJson: [...new Set(input.evidenceRequired)] }
          : {}),
        ...(input.replacementEnabled !== undefined
          ? { replacementEnabled: input.replacementEnabled }
          : {}),
        ...(input.operatorInstructions !== undefined
          ? {
              operatorInstructions:
                input.operatorInstructions === null || input.operatorInstructions.length === 0
                  ? null
                  : input.operatorInstructions,
            }
          : {}),
        updatedById: actor.userId,
      },
    });
    await recordAudit(
      {
        action: AuditAction.RETURN_SETTINGS_CHANGED,
        resourceType: 'return_settings',
        resourceId: settings.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          windowDays: before.windowDays,
          reasonCodes: before.reasonCodes,
          evidenceRequired: before.evidenceRequired,
          replacementEnabled: before.replacementEnabled,
        },
        after: {
          windowDays: input.windowDays ?? before.windowDays,
          reasonCodes: input.reasonCodes ?? before.reasonCodes,
          evidenceRequired: input.evidenceRequired ?? before.evidenceRequired,
          replacementEnabled: input.replacementEnabled ?? before.replacementEnabled,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return getReturnPolicy();
}
