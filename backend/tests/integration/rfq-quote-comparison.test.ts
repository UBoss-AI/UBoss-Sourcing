/**
 * Quotes and comparing them (checklist Master row 18): one quote per seller,
 * validated terms, the side-by-side comparison with the project's own
 * published exchange rates (source and date shown, figures as quoted always
 * present, missing never zero), sorting, the shortlist, and the CSV export
 * with spreadsheet formulas neutralised.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { as, buildRfqWorld, cleanRfqWorld, errorCode, errorDetails, submitted, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'rfqq-';
let world: RfqWorld;
let snapshotId = '';
let previouslyActive: { id: string; activeProvider: string | null }[] = [];

function quote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: 'INR',
    unitPriceMinor: '90000',
    quantity: '12000',
    moq: '5000',
    leadTimeDays: 30,
    capacityPerMonth: '20000',
    incoterm: 'CIF',
    incotermPlace: 'Nhava Sheva',
    paymentTerms: '30% advance, 70% against documents',
    inspectionTerms: 'SGS pre-shipment',
    warranty: '12 months',
    toolingMinor: null,
    sampleCostMinor: '250000',
    shippingEstimateMinor: null,
    taxesDisclosure: 'Excludes GST and import duty',
    tiers: [{ minQuantity: '10000', unitPriceMinor: '85000' }],
    comment: 'Ready in 30 days',
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    ...overrides,
  };
}

const comparisonOf = (response: LightMyRequestResponse) =>
  response.json<{
    comparison: {
      currency: string;
      rows: {
        supplier: { displayName: string; verified: boolean };
        quoted: { currency: string; unitPrice: { minor: string }; applicableUnitPrice: { minor: string }; total: { minor: string }; tooling: unknown; shippingEstimate: unknown };
        converted: null | { total: { minor: string; currency: string }; tooling: unknown; conversion: { rate: string; rateAsOf: string; provider: string } };
        conversionUnavailable: boolean;
        shortlisted: boolean;
        quoteId: string;
      }[];
    };
  }>().comparison;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
  // The project's own published rates: EUR pivot, 1 EUR = 90 INR = 1.1 USD.
  previouslyActive = await prisma.exchangeRateSnapshot.findMany({
    where: { isActive: true },
    select: { id: true, activeProvider: true },
  });
  await prisma.exchangeRateSnapshot.updateMany({ where: { isActive: true }, data: { isActive: false, activeProvider: null } });
  snapshotId = newId();
  await prisma.exchangeRateSnapshot.create({
    data: {
      id: snapshotId,
      provider: 'ecb',
      pivotCurrency: 'EUR',
      asOf: new Date('2026-09-28T14:00:00.000Z'),
      sourceReference: 'test://rfq-comparison',
      retrievalStatus: 'FETCHED',
      validationStatus: 'VALID',
      isActive: true,
      activeProvider: 'ecb',
      activatedAt: new Date(),
      rateCount: 2,
    },
  });
  await prisma.exchangeRate.createMany({
    data: [
      { id: newId(), snapshotId, baseCurrency: 'EUR', quoteCurrency: 'INR', rate: '90' },
      { id: newId(), snapshotId, baseCurrency: 'EUR', quoteCurrency: 'USD', rate: '1.1' },
    ],
  });
});

afterAll(async () => {
  await prisma.exchangeRate.deleteMany({ where: { snapshotId } });
  await prisma.exchangeRateSnapshot.deleteMany({ where: { id: snapshotId } });
  for (const row of previouslyActive) {
    await prisma.exchangeRateSnapshot.update({ where: { id: row.id }, data: { isActive: true, activeProvider: row.activeProvider } });
  }
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('a seller quotes', () => {
  it('records version 1, marks the invitation QUOTED, tells the buyer and refuses a second quote', async () => {
    const sent = await submitted(world);
    const { alpha } = world.sellers;
    const response = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote());
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{ quote: { status: string; currentVersionNumber: number; current: { termsHash: string; author: string } } }>().quote;
    expect(body).toMatchObject({ status: 'OPEN', currentVersionNumber: 1, current: { author: 'SUPPLIER' } });
    expect(body.current.termsHash).toMatch(/^[0-9a-f]{64}$/);

    const again = await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote());
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('RFQ_QUOTE_EXISTS');

    const invitation = await prisma.rfqInvitation.findFirstOrThrow({ where: { rfqId: sent.id, sellerAccountId: alpha.id } });
    expect(invitation.status).toBe('QUOTED');
    const email = await prisma.notificationOutbox.count({ where: { recipientEmail: world.buyer.email, relatedId: sent.id, eventKey: 'rfq.update_for_buyer' } });
    expect(email).toBe(1);
    const audit = await prisma.auditLog.count({ where: { resourceId: sent.id, action: 'rfq.quote_submitted' } });
    expect(audit).toBe(1);
  });

  it('refuses terms that are not valid, a seller not invited, and a quote after the deadline', async () => {
    const sent = await submitted(world);
    const { beta, gamma } = world.sellers;
    const past = await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ expiresAt: new Date(Date.now() - 1000).toISOString() }));
    expect(errorCode(past)).toBe('RFQ_QUOTE_INVALID');
    const tiers = await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({
      tiers: [
        { minQuantity: '10000', unitPriceMinor: '85000' },
        { minQuantity: '5000', unitPriceMinor: '80000' },
      ],
    }));
    expect(errorDetails(tiers)).toContainEqual(expect.objectContaining({ code: 'NOT_ASCENDING' }));
    const negative = await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ unitPriceMinor: '-5' }));
    expect(negative.statusCode).toBe(400);
    expect((await as(world, gamma.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote())).statusCode).toBe(404);

    await prisma.rfqRequest.update({ where: { id: sent.id }, data: { responseDeadline: new Date(Date.now() - 1000) } });
    const late = await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote());
    expect(errorCode(late)).toBe('RFQ_RESPONSE_CLOSED');
  });

  it('lets a seller read only its own quote', async () => {
    const sent = await submitted(world);
    await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote());
    const own = await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}/quote`);
    expect(own.json<{ quote: { sellerAccountId: string } | null }>().quote?.sellerAccountId).toBe(world.sellers.alpha.id);
    const beta = await as(world, world.sellers.beta.owner, 'GET', `/seller/rfqs/${sent.id}/quote`);
    expect(beta.json<{ quote: unknown }>().quote).toBeNull();
    // The buyer's comparison is the buyer's alone.
    expect((await as(world, world.rival, 'GET', `/rfqs/${sent.id}/comparison`)).statusCode).toBe(404);
  });
});

describe('the comparison', () => {
  it('shows every figure as quoted and, beside it, converted at the published rate with its source and date', async () => {
    const sent = await submitted(world);
    const { alpha, beta, delta } = world.sellers;
    await as(world, alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote());
    // BETA quotes in euro and leaves the sample cost out.
    await as(world, beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ currency: 'EUR', unitPriceMinor: '950', tiers: [], sampleCostMinor: null, toolingMinor: '50000' }));
    // DELTA quotes in a currency no published rate covers.
    await as(world, delta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ currency: 'JPY', unitPriceMinor: '1200', tiers: [] }));

    const response = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/comparison?currency=INR&sort=total`);
    expect(response.statusCode, response.body).toBe(200);
    const comparison = comparisonOf(response);
    expect(comparison.currency).toBe('INR');
    const byName = new Map(comparison.rows.map((row) => [row.supplier.displayName, row]));

    const alphaRow = byName.get(alpha.displayName);
    // 12,000 boxes reach the 10,000 tier: 850.00 x 12,000 = 10,200,000.00 INR.
    expect(alphaRow?.quoted.applicableUnitPrice.minor).toBe('85000');
    expect(alphaRow?.quoted.total.minor).toBe('1020000000');
    expect(alphaRow?.converted).toBeNull();
    // Not given is null, never zero.
    expect(alphaRow?.quoted.tooling).toBeNull();
    expect(alphaRow?.quoted.shippingEstimate).toBeNull();

    const betaRow = byName.get(beta.displayName);
    // 9.50 EUR x 12,000 = 114,000.00 EUR = 10,260,000.00 INR at 90.
    expect(betaRow?.quoted).toMatchObject({ currency: 'EUR', total: { minor: '11400000' } });
    expect(betaRow?.converted?.total).toMatchObject({ minor: '1026000000', currency: 'INR' });
    expect(betaRow?.converted?.conversion).toMatchObject({ provider: 'ecb', rateAsOf: '2026-09-28T14:00:00.000Z' });
    expect(betaRow?.converted?.conversion.rate).toMatch(/^90\.0+$/);

    const deltaRow = byName.get(delta.displayName);
    expect(deltaRow?.converted).toBeNull();
    expect(deltaRow?.conversionUnavailable).toBe(true);

    // Sorted by comparable total, the unconvertible one last.
    expect(comparison.rows.map((row) => row.supplier.displayName)).toEqual([alpha.displayName, beta.displayName, delta.displayName]);
    expect(comparison.rows.every((row) => row.supplier.verified)).toBe(true);
  });

  it('keeps a shortlist for the buyer only and filters by it', async () => {
    const sent = await submitted(world);
    await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote());
    await as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ unitPriceMinor: '95000' }));
    const rows = comparisonOf(await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/comparison`)).rows;
    const chosen = rows.find((row) => row.supplier.displayName === world.sellers.beta.displayName);
    const listed = await as(world, world.buyer, 'PUT', `/rfqs/${sent.id}/quotes/${chosen?.quoteId ?? ''}/shortlist`, { shortlisted: true });
    expect(listed.statusCode, listed.body).toBe(200);
    expect((await as(world, world.rival, 'PUT', `/rfqs/${sent.id}/quotes/${chosen?.quoteId ?? ''}/shortlist`, { shortlisted: true })).statusCode).toBe(404);
    const only = comparisonOf(await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/comparison?shortlisted=true`)).rows;
    expect(only.map((row) => row.supplier.displayName)).toEqual([world.sellers.beta.displayName]);
  });

  it('exports exactly what the buyer sees as CSV, with formulas neutralised and missing terms said', async () => {
    const sent = await submitted(world);
    await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({
      paymentTerms: '=HYPERLINK("http://evil.test","pay")',
      warranty: '+1 year',
      inspectionTerms: '@SUM(A1)',
      taxesDisclosure: '-10% duty',
    }));
    const response = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/comparison.csv?currency=USD`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment');
    const text = response.body;
    expect(text).toContain(`"'=HYPERLINK(""http://evil.test"",""pay"")"`);
    expect(text).toContain("'+1 year");
    expect(text).toContain("'@SUM(A1)");
    expect(text).toContain("'-10% duty");
    expect(text).toContain('not provided');
    expect(text).toContain('Unit price (converted, approximate)');
    expect(text.split('\r\n').filter((line) => line.length > 0)).toHaveLength(2);
    const audit = await prisma.auditLog.count({ where: { resourceId: sent.id, action: 'rfq.comparison_exported' } });
    expect(audit).toBe(1);
  });

  it('adds a landed estimate only where shipping was quoted, names missing terms and export documents, and exports a PDF (JOURNEY-016/017)', async () => {
    const sent = await submitted(world);
    // ALPHA: shipping and tooling quoted, three export documents promised.
    const alpha = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({
      toolingMinor: '1000000',
      shippingEstimateMinor: '500000',
      exportDocuments: ['PACKING_LIST', 'COMMERCIAL_INVOICE', 'CERTIFICATE_OF_ORIGIN', 'PACKING_LIST'],
    }));
    expect(alpha.statusCode, alpha.body).toBe(201);
    // BETA: no shipping, no warranty, no documents.
    expect((await as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ warranty: null }))).statusCode).toBe(201);
    expect((await as(world, world.sellers.gamma.owner, 'POST', `/seller/rfqs/${sent.id}/quotes`, quote({ exportDocuments: ['NOT_A_DOCUMENT'] }))).statusCode).toBeGreaterThanOrEqual(400);

    const rows = (await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/comparison`)).json<{
      comparison: { rows: { supplier: { sellerAccountId: string }; quoted: { total: { minor: string }; landedEstimate: { minor: string } | null }; exportDocuments: string[]; missing: string[] }[] };
    }>().comparison.rows;
    const a = rows.find((row) => row.supplier.sellerAccountId === world.sellers.alpha.id);
    const b = rows.find((row) => row.supplier.sellerAccountId === world.sellers.beta.id);
    // 12,000 at the 10,000 tier of 85,000 = 1,020,000,000; + tooling 1,000,000 + shipping 500,000.
    expect(a?.quoted.total.minor).toBe('1020000000');
    expect(a?.quoted.landedEstimate?.minor).toBe('1021500000');
    expect(a?.exportDocuments).toEqual(['COMMERCIAL_INVOICE', 'PACKING_LIST', 'CERTIFICATE_OF_ORIGIN']);
    expect(a?.missing).toEqual([]);
    expect(b?.quoted.landedEstimate).toBeNull();
    expect(b?.missing).toEqual(['warranty', 'shippingEstimate', 'exportDocuments']);

    const pdf = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/comparison.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await as(world, world.rival, 'GET', `/rfqs/${sent.id}/comparison.pdf`)).statusCode).toBe(404);
  });
});
