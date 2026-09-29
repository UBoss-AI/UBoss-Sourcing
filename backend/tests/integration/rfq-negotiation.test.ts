/**
 * Negotiating a quote and accepting one (checklist Master row 19): immutable
 * versions from either side, who may answer what, expiry, idempotent and
 * race-safe acceptance with one winner, frozen terms and the audit trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { offerTermsHash, type OfferTerms } from '../../src/domain/rfq-quote.js';
import { as, buildRfqWorld, cleanRfqWorld, errorCode, errorDetails, submitted, type RfqWorld, type Seller } from '../support/rfq-fixture.js';

const PREFIX = 'rfqn-';
let world: RfqWorld;

interface QuoteBody {
  id: string;
  status: string;
  currentVersionNumber: number;
  current: { id: string; versionNumber: number; author: string; termsHash: string; state: string } | null;
  versions: { versionNumber: number; state: string; author: string }[];
  acceptedTermsHash: string | null;
}
const quoteOf = (response: LightMyRequestResponse): QuoteBody => response.json<{ quote: QuoteBody }>().quote;

function quoteInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    currency: 'INR',
    unitPriceMinor: '90000',
    quantity: '12000',
    moq: '5000',
    leadTimeDays: 30,
    incoterm: 'CIF',
    paymentTerms: '30% advance',
    inspectionTerms: 'SGS',
    expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
    ...overrides,
  };
}

function counter(expectedVersionNumber: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedVersionNumber,
    unitPriceMinor: '86000',
    quantity: '12000',
    moq: '5000',
    leadTimeDays: 25,
    incoterm: 'CIF',
    incotermPlace: 'Nhava Sheva',
    paymentTerms: '20% advance',
    inspectionTerms: 'SGS',
    comment: 'Can you meet 860?',
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    ...overrides,
  };
}

async function quoted(seller: Seller, rfqId: string, overrides: Record<string, unknown> = {}): Promise<QuoteBody> {
  const response = await as(world, seller.owner, 'POST', `/seller/rfqs/${rfqId}/quotes`, quoteInput(overrides));
  expect(response.statusCode, response.body).toBe(201);
  return quoteOf(response);
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
});

afterAll(async () => {
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('counter-offers', () => {
  it('adds an immutable version from either side, and refuses one answering a version that moved', async () => {
    const sent = await submitted(world);
    const first = await quoted(world.sellers.alpha, sent.id);
    const v1Hash = first.current?.termsHash;

    const buyerCounter = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${first.id}/offers`, counter(1));
    expect(buyerCounter.statusCode, buyerCounter.body).toBe(201);
    const afterBuyer = quoteOf(buyerCounter);
    expect(afterBuyer.currentVersionNumber).toBe(2);
    expect(afterBuyer.current?.author).toBe('BUYER');
    expect(afterBuyer.versions.map((version) => `${String(version.versionNumber)}:${version.state}`)).toEqual(['1:SUPERSEDED', '2:PROPOSED']);

    // Version 1 is untouched: same terms, same hash.
    const v1 = await prisma.rfqQuoteVersion.findFirstOrThrow({ where: { quoteId: first.id, versionNumber: 1 } });
    expect(v1.termsHash).toBe(v1Hash);
    expect(v1.unitPriceMinor).toBe(90000n);

    const stale = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quote/offers`, counter(1, { unitPriceMinor: '88000' }));
    expect(errorCode(stale)).toBe('RFQ_OFFER_NOT_OPEN');
    expect(errorDetails(stale)[0]?.code).toBe('STALE');
    const sellerCounter = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quote/offers`, counter(2, { unitPriceMinor: '88000' }));
    expect(quoteOf(sellerCounter).currentVersionNumber).toBe(3);

    const audit = await prisma.auditLog.findMany({ where: { resourceId: sent.id, action: 'rfq.offer_countered' }, select: { actorUserId: true, afterJson: true } });
    expect(audit.map((row) => row.actorUserId).sort()).toEqual([world.buyer.userId, world.sellers.alpha.owner.userId].sort());
  });

  it('lets only the request’s buyer and that quote’s seller take part', async () => {
    const sent = await submitted(world);
    const quote = await quoted(world.sellers.alpha, sent.id);
    expect((await as(world, world.rival, 'POST', `/rfqs/${sent.id}/quotes/${quote.id}/offers`, counter(1))).statusCode).toBe(404);
    // BETA has no quote of its own on this request, and cannot reach ALPHA's.
    expect((await as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/quote/offers`, counter(1))).statusCode).toBe(404);
    expect((await as(world, world.sellers.gamma.owner, 'POST', `/seller/rfqs/${sent.id}/quote/accept`, { versionId: quote.current?.id, termsHash: quote.current?.termsHash })).statusCode).toBe(404);
  });
});

describe('accepting', () => {
  it('refuses accepting your own offer, a wrong hash, and an expired offer', async () => {
    const sent = await submitted(world);
    const quote = await quoted(world.sellers.alpha, sent.id);
    const current = quote.current;
    const own = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quote/accept`, { versionId: current?.id, termsHash: current?.termsHash });
    expect(errorDetails(own)[0]?.code).toBe('OWN_OFFER');
    const wrongHash = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${quote.id}/accept`, { versionId: current?.id, termsHash: '0'.repeat(64) });
    expect(errorDetails(wrongHash)[0]?.code).toBe('TERMS_CHANGED');

    await prisma.rfqQuoteVersion.update({ where: { id: current?.id ?? '' }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${quote.id}/accept`, { versionId: current?.id, termsHash: current?.termsHash });
    expect(expired.statusCode).toBe(409);
    expect(errorCode(expired)).toBe('RFQ_OFFER_EXPIRED');
    // An expired offer can still be countered.
    expect((await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${quote.id}/offers`, counter(1))).statusCode).toBe(201);
  });

  it('awards the request once, closes the other quotes, freezes the terms and is idempotent', async () => {
    const sent = await submitted(world);
    const alphaQuote = await quoted(world.sellers.alpha, sent.id);
    const betaQuote = await quoted(world.sellers.beta, sent.id, { unitPriceMinor: '95000' });
    const body = { versionId: alphaQuote.current?.id, termsHash: alphaQuote.current?.termsHash };

    const accepted = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${alphaQuote.id}/accept`, body);
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(quoteOf(accepted)).toMatchObject({ status: 'ACCEPTED', acceptedTermsHash: alphaQuote.current?.termsHash });
    const again = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${alphaQuote.id}/accept`, body);
    expect(again.statusCode).toBe(200);
    expect(quoteOf(again).status).toBe('ACCEPTED');

    const rfq = await prisma.rfqRequest.findUniqueOrThrow({ where: { id: sent.id } });
    expect(rfq).toMatchObject({ status: 'AWARDED', awardedQuoteId: alphaQuote.id });
    const beta = await prisma.rfqQuote.findUniqueOrThrow({ where: { id: betaQuote.id } });
    expect(beta).toMatchObject({ status: 'CLOSED', closedReason: 'AWARDED_ELSEWHERE' });
    const betaAccept = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${betaQuote.id}/accept`, {
      versionId: betaQuote.current?.id,
      termsHash: betaQuote.current?.termsHash,
    });
    expect(errorCode(betaAccept)).toBe('RFQ_ALREADY_AWARDED');

    // The frozen terms, the same for both sides, matching their hash.
    const terms = await as(world, world.buyer, 'GET', `/rfqs/${sent.id}/accepted-terms`);
    const agreed = terms.json<{ acceptedTerms: { termsHash: string; terms: OfferTerms; purchaseOrder: { status: string } } }>().acceptedTerms;
    expect(agreed.termsHash).toBe(alphaQuote.current?.termsHash);
    expect(offerTermsHash(agreed.terms)).toBe(agreed.termsHash);
    expect(agreed.purchaseOrder.status).toBe('NOT_BUILT');
    const sellerTerms = await as(world, world.sellers.alpha.owner, 'GET', `/seller/rfqs/${sent.id}/accepted-terms`);
    expect(sellerTerms.json<{ acceptedTerms: { termsHash: string } }>().acceptedTerms.termsHash).toBe(agreed.termsHash);
    expect((await as(world, world.sellers.beta.owner, 'GET', `/seller/rfqs/${sent.id}/accepted-terms`)).statusCode).toBe(404);
    // Nothing moves after acceptance.
    const late = await as(world, world.sellers.alpha.owner, 'POST', `/seller/rfqs/${sent.id}/quote/offers`, counter(1));
    expect(errorCode(late)).toBe('RFQ_OFFER_NOT_OPEN');

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: sent.id, action: 'rfq.offer_accepted' } });
    expect(audit.actorUserId).toBe(world.buyer.userId);
    expect(audit.afterJson).toMatchObject({ versionNumber: 1, termsHash: alphaQuote.current?.termsHash, party: 'BUYER' });
  });

  it('lets exactly one of two concurrent acceptances win', async () => {
    const sent = await submitted(world);
    const alphaQuote = await quoted(world.sellers.alpha, sent.id);
    const betaQuote = await quoted(world.sellers.beta, sent.id);
    // BETA's quote carries a buyer counter, so BETA's seller can accept it while the buyer accepts ALPHA's.
    const countered = quoteOf(await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${betaQuote.id}/offers`, counter(1)));

    const results = await Promise.allSettled([
      as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${alphaQuote.id}/accept`, { versionId: alphaQuote.current?.id, termsHash: alphaQuote.current?.termsHash }),
      as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/quote/accept`, { versionId: countered.current?.id, termsHash: countered.current?.termsHash }),
    ]);
    const codes = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(codes).toEqual([200, 409]);
    const acceptedCount = await prisma.rfqQuote.count({ where: { rfqId: sent.id, status: 'ACCEPTED' } });
    expect(acceptedCount).toBe(1);
    const rfq = await prisma.rfqRequest.findUniqueOrThrow({ where: { id: sent.id } });
    const winner = await prisma.rfqQuote.findFirstOrThrow({ where: { rfqId: sent.id, status: 'ACCEPTED' } });
    expect(rfq.awardedQuoteId).toBe(winner.id);

    // The same acceptance pressed twice at once is one acceptance, and both answers agree.
    const second = await submitted(world);
    const only = await quoted(world.sellers.alpha, second.id);
    const twice = await Promise.allSettled([
      as(world, world.buyer, 'POST', `/rfqs/${second.id}/quotes/${only.id}/accept`, { versionId: only.current?.id, termsHash: only.current?.termsHash }),
      as(world, world.buyer, 'POST', `/rfqs/${second.id}/quotes/${only.id}/accept`, { versionId: only.current?.id, termsHash: only.current?.termsHash }),
    ]);
    expect(twice.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0))).toEqual([200, 200]);
    expect(await prisma.auditLog.count({ where: { resourceId: second.id, action: 'rfq.offer_accepted' } })).toBe(1);
  });
});

describe('rejecting and withdrawing', () => {
  it('closes a rejected quote, and lets a seller withdraw an open one', async () => {
    const sent = await submitted(world);
    const alphaQuote = await quoted(world.sellers.alpha, sent.id);
    const rejected = await as(world, world.buyer, 'POST', `/rfqs/${sent.id}/quotes/${alphaQuote.id}/reject`, { versionId: alphaQuote.current?.id, note: 'Too dear' });
    expect(quoteOf(rejected).status).toBe('REJECTED');

    await quoted(world.sellers.beta, sent.id);
    const withdrawn = await as(world, world.sellers.beta.owner, 'POST', `/seller/rfqs/${sent.id}/quote/withdraw`);
    expect(quoteOf(withdrawn).status).toBe('WITHDRAWN');
    const invitation = await prisma.rfqInvitation.findFirstOrThrow({ where: { rfqId: sent.id, sellerAccountId: world.sellers.beta.id } });
    expect(invitation.status).toBe('WITHDRAWN');
    expect(await prisma.auditLog.count({ where: { resourceId: sent.id, action: { in: ['rfq.offer_rejected', 'rfq.quote_withdrawn'] } } })).toBe(2);
  });
});
