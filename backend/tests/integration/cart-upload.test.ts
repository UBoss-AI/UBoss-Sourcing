import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { readRows } from '../../src/modules/cart/upload.service.js';
import { as, buildRfqWorld, cleanRfqWorld, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'cup16-';
let world: RfqWorld;
let sku = '';
let productId = '';

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  await cleanRfqWorld(PREFIX);
  world = await buildRfqWorld(app, PREFIX);
  const product = await prisma.product.findFirstOrThrow({ where: { slug: { startsWith: PREFIX }, status: 'ACTIVE', isPublished: true }, select: { id: true, sku: true } });
  sku = product.sku;
  productId = product.id;
}, 240_000);

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

const send = (fileName: string, text: string) =>
  as(world, world.buyer, 'POST', '/cart/items/upload/preview', { fileName, contentBase64: Buffer.from(text).toString('base64') });

describe('SKU list upload (ENH-016)', () => {
  it('resolves a CSV with headers into lines and reports every unusable row', async () => {
    const csv = `SKU,Qty\n${sku.toLowerCase()},12\nNOPE-1,3\n,4\n${sku},5\nBAD-QTY,0\n`;
    const response = await send('order.csv', csv);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      lines: [expect.objectContaining({ row: 2, productId, variantId: null, quantity: 12 })],
      problems: [
        { row: 3, sku: 'NOPE-1', code: 'SKU_UNKNOWN' },
        { row: 4, sku: null, code: 'SKU_MISSING' },
        { row: 5, sku, code: 'DUPLICATE_SKU' },
        { row: 6, sku: 'BAD-QTY', code: 'QUANTITY_INVALID' },
      ],
    });
  });
  it('reads headerless rows, caps at 50 lines, and refuses other formats and oversize files', async () => {
    const rows = Array.from({ length: 52 }, (_, i) => `X-${String(i)},1`).join('\n');
    const capped = (await send('list.csv', rows)).json<{ problems: { code: string }[] }>();
    expect(capped.problems.filter((p) => p.code === 'TOO_MANY_LINES')).toHaveLength(2);
    expect((await send('list.pdf', 'a,b')).statusCode).toBe(400);
    expect(() => readRows('big.csv', Buffer.alloc(1_000_001))).toThrow();
  });
  it('never touches the cart and needs a signed-in customer', async () => {
    const before = await prisma.cartItem.count();
    await send('order.csv', `${sku},2`);
    expect(await prisma.cartItem.count()).toBe(before);
    expect((await world.app.inject({ method: 'POST', url: '/api/v1/cart/items/upload/preview', payload: { fileName: 'a.csv', contentBase64: '' } })).statusCode).toBeGreaterThanOrEqual(400);
  });
});
