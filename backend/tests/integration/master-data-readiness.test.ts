/**
 * Master-data readiness (LIVE-019).
 *
 * The go-live check reads every master list from its own table: each count it
 * reports equals a direct count of that table, a list going from empty to
 * populated moves its check to OK, and anything the demonstration seed leaves
 * behind (accounts on the reserved `.local` domain, the demo catalogue,
 * placeholder terms) is reported and keeps the deployment from being called
 * ready.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { asStaff, cleanUpOrderDesk, staff, type StaffSession } from '../support/order-desk-fixture.js';

const TAG = 'mdr19';
const UNIT_CODE = 'LIVE19U';
const DEMO_EMAIL = 'leftover-demo@readiness19.local';
let app: Awaited<ReturnType<typeof buildApp>>;
let catalog: StaffSession;

interface Readiness {
  ready: boolean;
  missingRequired: number;
  checks: { key: string; required: boolean; status: 'OK' | 'MISSING' | 'WARNING'; count: number }[];
  demo: { key: string; count: number }[];
}

async function read(): Promise<Readiness> {
  const response = await asStaff(app, catalog, 'GET', '/master-data-readiness');
  expect(response.statusCode, response.body).toBe(200);
  return response.json<Readiness>();
}

const checkOf = (body: Readiness, key: string) => {
  const found = body.checks.find((entry) => entry.key === key);
  if (found === undefined) throw new Error(`no check ${key}`);
  return found;
};

async function cleanUp(): Promise<void> {
  await prisma.masterDataEntry.deleteMany({ where: { kind: 'UOM', code: UNIT_CODE } });
  await prisma.user.deleteMany({ where: { emailNormalized: DEMO_EMAIL } });
  await cleanUpOrderDesk(TAG);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  catalog = await staff(app, TAG, 'catalog', Role.CATALOG_MANAGER, '10.92.19.1');
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('master-data readiness', () => {
  it('reports every master list, with counts equal to the tables themselves', async () => {
    const body = await read();
    expect(body.checks.map((entry) => entry.key)).toEqual([
      'categories',
      'currencies',
      'baseCurrency',
      'exchangeRates',
      'taxClasses',
      'countries',
      'marketRules',
      'deliveryRates',
      'inspectionRules',
      'inspectionPlans',
      'inspectionAgencies',
      'platformTerms',
      'privacyPolicy',
      'units',
      'defectCodes',
      'incoterms',
    ]);

    expect(checkOf(body, 'categories').count).toBe(
      await prisma.category.count({ where: { isActive: true, archivedAt: null } }),
    );
    expect(checkOf(body, 'taxClasses').count).toBe(await prisma.taxClass.count({ where: { isActive: true } }));
    expect(checkOf(body, 'countries').count).toBe(await prisma.country.count({ where: { isActive: true } }));
    expect(checkOf(body, 'units').count).toBe(
      await prisma.masterDataEntry.count({ where: { kind: 'UOM', isActive: true } }),
    );
    const baseRows = await prisma.$queryRaw<{ base: bigint | number }[]>`
      SELECT COUNT(*) AS base FROM currencies WHERE isActive = 1 AND isBase = 1`;
    expect(BigInt(checkOf(body, 'baseCurrency').count)).toBe(BigInt(baseRows[0]?.base ?? 0));

    // A required check is MISSING exactly when its count says so, and the
    // headline agrees with the rows.
    for (const entry of body.checks) {
      if (entry.status === 'MISSING') expect(entry.required).toBe(true);
      if (entry.status === 'WARNING') expect(entry.required).toBe(false);
    }
    expect(body.missingRequired).toBe(body.checks.filter((entry) => entry.status === 'MISSING').length);
    expect(body.ready).toBe(body.missingRequired === 0 && body.demo.every((entry) => entry.count === 0));
  });

  it('moves a list from absent to present when an entry is added', async () => {
    const before = checkOf(await read(), 'units');
    await prisma.masterDataEntry.create({
      data: { id: newId(), kind: 'UOM', code: UNIT_CODE, name: 'Readiness test unit', sortOrder: 0, isActive: true },
    });
    const after = checkOf(await read(), 'units');
    expect(after.count).toBe(before.count + 1);
    expect(after.status).toBe('OK');
  });

  it('reports a demonstration account left behind, and is then not ready', async () => {
    const before = (await read()).demo.find((entry) => entry.key === 'localAccounts')?.count ?? 0;
    await prisma.user.create({
      data: { id: newId(), type: 'CUSTOMER', email: DEMO_EMAIL, emailNormalized: DEMO_EMAIL, status: 'ACTIVE' },
    });
    const body = await read();
    expect(body.demo.find((entry) => entry.key === 'localAccounts')?.count).toBe(before + 1);
    expect(body.ready).toBe(false);
    expect(body.demo.map((entry) => entry.key)).toEqual(['demoProducts', 'developmentTerms', 'seedCarrier', 'localAccounts']);
  });

  it('needs a signed-in member of staff', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/master-data-readiness' });
    expect(response.statusCode).toBe(401);
  });
});
