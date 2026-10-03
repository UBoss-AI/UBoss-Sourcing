import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Permission } from '../../src/domain/permissions.js';
import { readExceptionCentre } from '../../src/modules/notifications/exception-centre.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;
const ALL = Object.values(Permission);

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});
afterAll(async () => { await app.close(); });

describe('exception centre (ENH-019)', () => {
  it('covers all six exception types for a fully granted member, and the items add up', async () => {
    const centre = await readExceptionCentre({ permissions: ALL });
    expect(centre.types.map((row) => row.type).sort()).toEqual(['FAILED_PAYMENT', 'INSPECTION_NCR', 'INTEGRATION_FAILURE', 'LATE_SHIPMENT', 'MISSING_DOCUMENT', 'SETTLEMENT_MISMATCH']);
    expect(centre.items.reduce((sum, item) => sum + item.count, 0)).toBe(centre.total);
    expect(centre.items.every((item) => item.count > 0)).toBe(true);
    const rank = { urgent: 0, attention: 1, info: 2 } as const;
    for (let i = 1; i < centre.items.length; i += 1) expect(rank[centre.items[i - 1]!.severity] <= rank[centre.items[i]!.severity]).toBe(true);
  });
  it('leaves out what the caller may not act on, rather than showing zero', async () => {
    expect((await readExceptionCentre({ permissions: [] })).types).toEqual([]);
    const noLogistics = await readExceptionCentre({ permissions: ALL.filter((p) => p !== Permission.LOGISTICS_READ) });
    expect(noLogistics.types.some((row) => row.type === 'LATE_SHIPMENT')).toBe(false);
  });
  it('refuses an anonymous caller', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/exceptions' })).statusCode).toBe(401);
  });
});
