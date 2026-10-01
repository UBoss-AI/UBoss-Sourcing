/**
 * The operator's cargo insurance settings (JOURNEY-046): the premium rate and
 * the most that may be insured, as basis points. One row, id 'default'; until
 * staff save it the defaults apply - 0, which means insurance is not offered.
 * Every save is audited.
 */
import { z } from 'zod';
import type { InsuranceSettings } from '../../domain/cargo-insurance.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { SettingsActor } from '../settings/settings.service.js';

const ROW_ID = 'default';

export const tradeSettingsInput = z
  .object({
    /** 0 switches insurance off. 1000 is 10% - far above any real cargo rate. */
    insuranceBasisPoints: z.number().int().min(0).max(1000),
    /** Never below 100% of the goods value; at most 200%. */
    maxInsuredBasisPoints: z.number().int().min(10_000).max(20_000),
  })
  .strict();
export type TradeSettingsInput = z.infer<typeof tradeSettingsInput>;

export interface TradeSettingsView extends InsuranceSettings {
  insuranceOffered: boolean;
  updatedAt: string | null;
}

export async function readInsuranceSettings(): Promise<TradeSettingsView> {
  const row = await prisma.logisticsTradeSettings.findUnique({
    where: { id: ROW_ID },
    select: { insuranceBasisPoints: true, maxInsuredBasisPoints: true, updatedAt: true },
  });
  const insuranceBasisPoints = row?.insuranceBasisPoints ?? 0;
  return {
    insuranceBasisPoints,
    maxInsuredBasisPoints: row?.maxInsuredBasisPoints ?? 11_000,
    insuranceOffered: insuranceBasisPoints > 0,
    updatedAt: row?.updatedAt.toISOString() ?? null,
  };
}

export async function saveInsuranceSettings(input: TradeSettingsInput, actor: SettingsActor): Promise<TradeSettingsView> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.logisticsTradeSettings.findUnique({
      where: { id: ROW_ID },
      select: { insuranceBasisPoints: true, maxInsuredBasisPoints: true },
    });
    const data = {
      insuranceBasisPoints: input.insuranceBasisPoints,
      maxInsuredBasisPoints: input.maxInsuredBasisPoints,
      updatedByUserId: actor.userId,
    };
    await tx.logisticsTradeSettings.upsert({ where: { id: ROW_ID }, create: { id: ROW_ID, ...data }, update: data });
    await recordAudit(
      {
        action: AuditAction.LOGISTICS_TRADE_SETTINGS_UPDATED,
        resourceType: 'logistics_trade_settings',
        resourceId: ROW_ID,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before,
        after: { insuranceBasisPoints: data.insuranceBasisPoints, maxInsuredBasisPoints: data.maxInsuredBasisPoints },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
  return readInsuranceSettings();
}
