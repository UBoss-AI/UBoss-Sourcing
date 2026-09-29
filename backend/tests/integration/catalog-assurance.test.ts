/**
 * "How assurance works" reads its facts from settings - checklist Master row 7.
 *
 * The page may only describe what the deployment runs: inspection appears as
 * in use only while an in-force rule exists, and every window is the
 * operator's configured one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getReturnPolicy } from '../../src/modules/returns/return-settings.service.js';
import { readDisputeSettings } from '../../src/modules/disputes/dispute-settings.service.js';

const RULE_NAME = 'assurance-test-rule';
let app: Awaited<ReturnType<typeof buildApp>>;

interface Facts {
  verifiedSuppliers: number;
  inspection: { inUse: boolean; mandatoryRules: number };
  returns: { windowDays: number; replacementEnabled: boolean };
  claims: { claimWindowDays: number; sellerResponseHours: number; decisionHours: number; appealWindowDays: number };
}

async function facts(): Promise<Facts> {
  const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/assurance' });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Facts>();
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.inspectionRule.deleteMany({ where: { name: { startsWith: RULE_NAME } } });
});

afterAll(async () => {
  await prisma.inspectionRule.deleteMany({ where: { name: { startsWith: RULE_NAME } } });
  await app.close();
});

describe('GET /api/v1/catalog/assurance', () => {
  it('reports the configured return and claim windows, not invented ones', async () => {
    const [returns, disputes, body] = await Promise.all([getReturnPolicy(), readDisputeSettings(), facts()]);
    expect(body.returns).toEqual({ windowDays: returns.windowDays, replacementEnabled: returns.replacementEnabled });
    expect(body.claims).toEqual({
      claimWindowDays: disputes.claimWindowDays,
      sellerResponseHours: disputes.sellerResponseHours,
      decisionHours: disputes.decisionHours,
      appealWindowDays: disputes.appealWindowDays,
    });
    expect(typeof body.verifiedSuppliers).toBe('number');
  });

  it('says inspection is in use only while an in-force rule exists', async () => {
    const before = await facts();
    const future = newId();
    await prisma.inspectionRule.create({
      data: { id: future, name: `${RULE_NAME}-future`, level: 'MANDATORY', effectiveFrom: new Date(Date.now() + 86_400_000) },
    });
    const inactive = newId();
    await prisma.inspectionRule.create({
      data: { id: inactive, name: `${RULE_NAME}-inactive`, level: 'MANDATORY', isActive: false, effectiveFrom: new Date(Date.now() - 1000) },
    });
    // Neither a future rule nor a switched-off one counts.
    expect((await facts()).inspection).toEqual(before.inspection);

    await prisma.inspectionRule.create({
      data: { id: newId(), name: `${RULE_NAME}-live`, level: 'MANDATORY', effectiveFrom: new Date(Date.now() - 1000) },
    });
    const after = await facts();
    expect(after.inspection.inUse).toBe(true);
    expect(after.inspection.mandatoryRules).toBe(before.inspection.mandatoryRules + 1);
  });
});
