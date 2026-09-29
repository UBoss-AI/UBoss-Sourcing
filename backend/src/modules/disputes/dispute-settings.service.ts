/**
 * The operator's dispute rules: how long a buyer has to raise a claim, how
 * long the seller has to answer, how long the operator has to decide, how
 * long either side may appeal, which reasons the claim form offers, and above
 * what amount a refund decision needs a second member of staff.
 *
 * One row, and every value a setting - this is a product other businesses
 * run, so none of these is a constant in code. With no row saved, the
 * defaults below apply. They are a reasonable starting point, not a policy
 * this software sets for anybody.
 *
 * The approval threshold defaults to ZERO, which means every refund decided on
 * a dispute needs a second member of staff until the operator says otherwise.
 * A control that starts off is a control nobody remembers to turn on.
 */
import { z } from 'zod';
import { DisputeReasonValues, type DisputeReasonName } from '../../domain/dispute-state.js';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface DisputeSettingsView {
  version: number;
  claimWindowDays: number;
  sellerResponseHours: number;
  decisionHours: number;
  appealWindowDays: number;
  /** Minor units, as a string - money never crosses the API as a number. */
  approvalThresholdMinor: string;
  approvalCurrency: string;
  enabledReasons: DisputeReasonName[];
  /** False while nothing has been saved and the defaults apply. */
  saved: boolean;
}

export interface DisputeSettings {
  version: number;
  claimWindowDays: number;
  sellerResponseHours: number;
  decisionHours: number;
  appealWindowDays: number;
  approvalThresholdMinor: bigint;
  approvalCurrency: string;
  enabledReasons: DisputeReasonName[];
  saved: boolean;
}

export const DISPUTE_SETTING_DEFAULTS = Object.freeze({
  claimWindowDays: 30,
  sellerResponseHours: 72,
  decisionHours: 168,
  appealWindowDays: 7,
  approvalThresholdMinor: 0n,
});

type Client = Pick<PrismaTransaction, 'disputeSettings' | 'businessProfile'>;

function reasonsFrom(json: unknown): DisputeReasonName[] {
  if (!Array.isArray(json)) return [...DisputeReasonValues];
  const known = new Set<string>(DisputeReasonValues);
  const picked = json.filter((value): value is DisputeReasonName => typeof value === 'string' && known.has(value));
  return picked.length === 0 ? [...DisputeReasonValues] : picked;
}

export async function readDisputeSettings(client: Client = prisma): Promise<DisputeSettings> {
  const row = await client.disputeSettings.findFirst();
  if (row !== null) {
    return {
      version: row.version,
      claimWindowDays: row.claimWindowDays,
      sellerResponseHours: row.sellerResponseHours,
      decisionHours: row.decisionHours,
      appealWindowDays: row.appealWindowDays,
      approvalThresholdMinor: row.approvalThresholdMinor,
      approvalCurrency: row.approvalCurrency,
      enabledReasons: reasonsFrom(row.enabledReasonsJson),
      saved: true,
    };
  }
  // The threshold is in the business's own currency until somebody says otherwise.
  const profile = await client.businessProfile.findFirst({ select: { currency: true } });
  return {
    version: 0,
    ...DISPUTE_SETTING_DEFAULTS,
    approvalCurrency: profile?.currency ?? 'INR',
    enabledReasons: [...DisputeReasonValues],
    saved: false,
  };
}

export function settingsView(settings: DisputeSettings): DisputeSettingsView {
  return { ...settings, approvalThresholdMinor: settings.approvalThresholdMinor.toString() };
}

export const disputeSettingsInput = z
  .object({
    expectedVersion: z.number().int().min(0),
    claimWindowDays: z.number().int().min(1).max(3650),
    sellerResponseHours: z.number().int().min(1).max(8760),
    decisionHours: z.number().int().min(1).max(8760),
    appealWindowDays: z.number().int().min(0).max(365),
    approvalThresholdMinor: z.string().trim().regex(/^\d{1,18}$/),
    approvalCurrency: z.string().trim().regex(/^[A-Z]{3}$/),
    enabledReasons: z.array(z.enum(DisputeReasonValues)).min(1).max(DisputeReasonValues.length),
  })
  .strict();

export interface DisputeSettingsActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** Save the rules. Versioned: a stale form collides instead of overwriting. */
export async function saveDisputeSettings(
  actor: DisputeSettingsActor,
  input: z.infer<typeof disputeSettingsInput>,
): Promise<DisputeSettingsView> {
  return prisma.$transaction(async (tx) => {
    const before = await readDisputeSettings(tx);
    if (before.version !== input.expectedVersion) {
      throw conflict(
        ErrorCode.DISPUTE_SETTINGS_CONFLICT,
        'Somebody saved the dispute settings a moment ago. Reload them and try again.',
        [{ code: 'VERSION', meta: { expected: input.expectedVersion, actual: before.version } }],
      );
    }
    const data = {
      claimWindowDays: input.claimWindowDays,
      sellerResponseHours: input.sellerResponseHours,
      decisionHours: input.decisionHours,
      appealWindowDays: input.appealWindowDays,
      approvalThresholdMinor: BigInt(input.approvalThresholdMinor),
      approvalCurrency: input.approvalCurrency,
      enabledReasonsJson: [...new Set(input.enabledReasons)],
      updatedById: actor.userId,
    };
    const existing = await tx.disputeSettings.findFirst({ select: { id: true } });
    if (existing === null) {
      await tx.disputeSettings.create({ data: { id: newId(), version: 1, ...data } });
    } else {
      const moved = await tx.disputeSettings.updateMany({
        where: { id: existing.id, version: input.expectedVersion },
        data: { ...data, version: { increment: 1 } },
      });
      if (moved.count === 0) {
        throw conflict(
          ErrorCode.DISPUTE_SETTINGS_CONFLICT,
          'Somebody saved the dispute settings a moment ago. Reload them and try again.',
        );
      }
    }
    const after = await readDisputeSettings(tx);
    await recordAudit(
      {
        action: AuditAction.DISPUTE_SETTINGS_SAVED,
        resourceType: 'dispute_settings',
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: settingsView(before),
        after: settingsView(after),
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return settingsView(after);
  });
}
