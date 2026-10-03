/**
 * The facts behind "How assurance works" (checklist Master row 7).
 *
 * The page explains the protections this deployment actually runs, and every
 * number on it is read from the operator's own settings - never a promise the
 * software does not keep. So it says:
 *
 *   - **how many suppliers are verified**, which is the operator's review;
 *   - **whether inspection before dispatch is in use**: only when the operator
 *     has at least one active, in-force inspection rule. The dispatch gate
 *     (`domain/inspection-gate.ts`) enforces it; the page only reports it;
 *   - **the return window** and whether replacements are offered, from the
 *     return settings;
 *   - **the claim timetable** - how long a buyer has to raise one, how long a
 *     seller has to answer, how long a decision takes, how long to appeal -
 *     from the dispute settings;
 *   - **how far delivery reaches**: how many approved marketplace carriers are
 *     active, and in how many countries their declared, active service regions
 *     deliver. Read from the logistics partner records, so "global logistics"
 *     is exactly as wide as the carriers the operator has actually signed.
 *
 * It deliberately says nothing about money being held back from sellers:
 * payouts are not built, and "your money is protected until delivery" would be
 * exactly the kind of claim the checklist forbids ("without overstating").
 */
import { prisma } from '../../infra/prisma.js';
import { readDisputeSettings } from '../disputes/dispute-settings.service.js';
import { getReturnPolicy } from '../returns/return-settings.service.js';
import { verifiedSupplierWhere } from './supplier-directory.service.js';

export interface AssuranceFacts {
  verifiedSuppliers: number;
  inspection: { inUse: boolean; mandatoryRules: number };
  logistics: { activeCarriers: number; deliveryCountries: number };
  returns: { windowDays: number; replacementEnabled: boolean };
  claims: {
    claimWindowDays: number;
    sellerResponseHours: number;
    decisionHours: number;
    appealWindowDays: number;
  };
}

export async function assuranceFacts(now: Date = new Date()): Promise<AssuranceFacts> {
  const inForce = {
    isActive: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
  };

  // A marketplace carrier counts only while it is active and not archived; a
  // seller's own carrier serves that seller alone, so it is no marketplace claim.
  const carrierWhere = { status: 'ACTIVE' as const, archivedAt: null, partnerKind: 'MARKETPLACE_CARRIER' as const };

  const [verifiedSuppliers, activeRules, mandatoryRules, returns, disputes, activeCarriers, regions] = await Promise.all([
    prisma.sellerAccount.count({ where: verifiedSupplierWhere() }),
    prisma.inspectionRule.count({ where: inForce }),
    prisma.inspectionRule.count({ where: { ...inForce, level: 'MANDATORY' } }),
    getReturnPolicy(),
    readDisputeSettings(),
    prisma.logisticsPartner.count({ where: carrierWhere }),
    prisma.logisticsServiceRegion.findMany({
      where: { isActive: true, isExclusion: false, supportsDelivery: true, partner: carrierWhere },
      distinct: ['countryCode'],
      select: { countryCode: true },
    }),
  ]);

  return {
    verifiedSuppliers,
    inspection: { inUse: activeRules > 0, mandatoryRules },
    logistics: { activeCarriers, deliveryCountries: regions.length },
    returns: { windowDays: returns.windowDays, replacementEnabled: returns.replacementEnabled },
    claims: {
      claimWindowDays: disputes.claimWindowDays,
      sellerResponseHours: disputes.sellerResponseHours,
      decisionHours: disputes.decisionHours,
      appealWindowDays: disputes.appealWindowDays,
    },
  };
}
