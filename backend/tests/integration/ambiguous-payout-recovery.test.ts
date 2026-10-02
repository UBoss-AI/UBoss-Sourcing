/** No HTTP login; 10.98.0.* reserved for this file. All fixtures and cleanup are seller-scoped. */
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { runPayouts } from '../../src/modules/finance/escrow.service.js';
import { postEntry, reverseEntry } from '../../src/modules/finance/ledger.service.js';
import { PayoutProviderRejectedError, setPayoutAdapterForTests, type PayoutProviderAdapter, type PayoutLookupResult } from '../../src/modules/seller/payout.service.js';

const sellers: string[] = [];
const amount = 9_007_199_254_740_993n;
async function fixture() {
  const id = newId(); sellers.push(id);
  await prisma.sellerAccount.create({ data: { id, legalName: `Payout safety ${id}`, displayName: `Payout safety ${id}`, displayNameNormalized: `payout safety ${id.toLowerCase()}`, slug: `payout-safety-${id.toLowerCase()}`, kind: 'MANUFACTURER', registrationCountry: 'IN', status: 'APPROVED' } });
  await prisma.sellerPayoutAccountReference.create({ data: { id: newId(), sellerAccountId: id, provider: 'stripe_connect', providerAccountId: `acct_${id}`, state: 'ENABLED', payoutsEnabled: true } });
  await prisma.$transaction(tx => postEntry(tx, { kind: 'FUNDS_RELEASED', idempotencyKey: `safety-seed:${id}`, sellerAccountId: id, currency: 'INR', memo: 'Isolated payout safety balance fixture', lines: [{ code: 'SELLER_AVAILABLE', amountMinor: -amount }, { code: 'SELLER_HELD', amountMinor: amount }] }));
  return id;
}
async function balance(id: string, code: 'SELLER_AVAILABLE' | 'PAYOUTS_IN_TRANSIT') {
  const sum = await prisma.ledgerLine.aggregate({ where: { account: { sellerAccountId: id, code } }, _sum: { amountMinor: true } });
  return -(sum._sum.amountMinor ?? 0n);
}
function provider() {
  let outcome: PayoutLookupResult = { status: 'UNKNOWN' };
  let definitive = false;
  const created = new Map<string, string>();
  const send = vi.fn((input: Parameters<PayoutProviderAdapter['sendPayout']>[0]) => {
    if (definitive) return Promise.reject(new PayoutProviderRejectedError('The destination lacks transfers capability.'));
    // The provider accepted this exact operation; its response was lost.
    created.set(input.idempotencyKey, `tr_${input.reference}`);
    return Promise.reject(new Error('Socket timeout after provider accepted request'));
  });
  const read = vi.fn(() => Promise.resolve(outcome));
  const adapter = (): PayoutProviderAdapter => ({ name: 'stripe_connect', isConfigured: true,
    startOnboarding: () => Promise.reject(new Error('Not used')), readAccount: () => Promise.reject(new Error('Not used')),
    sendPayout: send, readPayout: read,
  });
  return { adapter, send, read, created, outcome: (value: PayoutLookupResult) => { outcome = value; }, reject: () => { definitive = true; } };
}
async function ambiguous(id: string, p: ReturnType<typeof provider>) {
  setPayoutAdapterForTests(p.adapter());
  expect((await runPayouts('payout-safety', id)).failed).toHaveLength(1);
  return prisma.sellerPayout.findFirstOrThrow({ where: { sellerAccountId: id } });
}
afterEach(() => { setPayoutAdapterForTests(null); });
afterAll(async () => {
  const entries = await prisma.ledgerEntry.findMany({ where: { sellerAccountId: { in: sellers } }, select: { id: true } });
  await prisma.ledgerLine.deleteMany({ where: { entryId: { in: entries.map(row => row.id) } } });
  await prisma.ledgerEntry.deleteMany({ where: { id: { in: entries.map(row => row.id) } } });
  await prisma.ledgerAccount.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
});

describe('ambiguous ledger payout recovery', () => {
  it('reserves BigInt funds when the provider receives a request but the response times out', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    expect(payout).toMatchObject({ status: 'PENDING', providerStatusRaw: 'UNKNOWN', amountMinor: amount });
    expect(await balance(id, 'SELLER_AVAILABLE')).toBe(0n);
    expect(await balance(id, 'PAYOUTS_IN_TRANSIT')).toBe(amount);
    expect(p.created.size).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { sellerAccountId: id, kind: 'REVERSAL' } })).toBe(0);
  });
  it('repeated unknown retries preserve the original reference/key and never submit again', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    for (let attempt = 0; attempt < 3; attempt += 1) expect((await runPayouts('payout-safety', id)).skipped).toHaveLength(1);
    expect(p.read).toHaveBeenCalledWith({ reference: payout.reference, idempotencyKey: payout.idempotencyKey, amountMinor: amount, currency: 'INR' });
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.created.size).toBe(1);
    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: id } })).toBe(1);
  });
  it('settles previous provider success exactly once without another payout', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    p.outcome({ status: 'PAID', providerPayoutId: 'tr_confirmed' });
    expect((await runPayouts('payout-safety', id)).paid[0]?.payoutId).toBe(payout.id);
    await runPayouts('payout-safety', id);
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.created.size).toBe(1);
    expect(await balance(id, 'PAYOUTS_IN_TRANSIT')).toBe(0n);
    expect(await prisma.ledgerEntry.count({ where: { payoutId: payout.id, kind: 'PAYOUT_SETTLED' } })).toBe(1);
  });
  it('reverses only after the provider reports definitive previous failure', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    p.outcome({ status: 'FAILED' });
    expect((await runPayouts('payout-safety', id)).failed[0]?.payoutId).toBe(payout.id);
    expect(await balance(id, 'SELLER_AVAILABLE')).toBe(amount);
    expect(await balance(id, 'PAYOUTS_IN_TRANSIT')).toBe(0n);
    expect(await prisma.ledgerEntry.count({ where: { payoutId: payout.id, kind: 'REVERSAL' } })).toBe(1);
    expect(p.send).toHaveBeenCalledTimes(1);
  });
  it('concurrent retries settle one original payout and cannot create a second provider transfer', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    p.outcome({ status: 'PAID', providerPayoutId: 'tr_concurrent' });
    await Promise.all([runPayouts('payout-safety', id), runPayouts('payout-safety', id)]);
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.created.size).toBe(1);
    expect(await prisma.ledgerEntry.count({ where: { payoutId: payout.id, kind: 'PAYOUT_SETTLED' } })).toBe(1);
  });
  it('survives a process restart using the stored business identity', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    setPayoutAdapterForTests(null); p.outcome({ status: 'PAID', providerPayoutId: 'tr_restart' });
    setPayoutAdapterForTests(p.adapter()); await runPayouts('payout-safety', id);
    expect(p.read).toHaveBeenCalledWith({ reference: payout.reference, idempotencyKey: payout.idempotencyKey, amountMinor: amount, currency: 'INR' });
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.created.size).toBe(1);
  });
  it('returns money on a definitive provider rejection and records proof of the distinction', async () => {
    const id = await fixture(); const p = provider(); p.reject(); setPayoutAdapterForTests(p.adapter());
    expect((await runPayouts('payout-safety', id)).failed).toHaveLength(1);
    expect(await balance(id, 'SELLER_AVAILABLE')).toBe(amount); expect(p.created.size).toBe(0);
    expect(await prisma.sellerPayout.findFirstOrThrow({ where: { sellerAccountId: id } })).toMatchObject({ status: 'FAILED', failureCode: 'DEFINITIVE_REJECTION' });
  });
  it('keeps a crash-window SUBMITTING operation reserved when lookup finds no confirmed outcome', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    await prisma.sellerPayout.update({ where: { id: payout.id }, data: { providerStatusRaw: 'SUBMITTING' } });
    setPayoutAdapterForTests(p.adapter()); await runPayouts('payout-safety', id);
    expect(p.send).toHaveBeenCalledTimes(1); expect(await balance(id, 'SELLER_AVAILABLE')).toBe(0n);
  });
  it('blocks legacy FAILED operations without definitive rejection evidence', async () => {
    const id = await fixture(); const p = provider(); const payout = await ambiguous(id, p);
    await prisma.sellerPayout.update({ where: { id: payout.id }, data: { status: 'FAILED', failureCode: null } });
    const initiated = await prisma.ledgerEntry.findFirstOrThrow({ where: { payoutId: payout.id, kind: 'PAYOUT_INITIATED' } });
    await prisma.$transaction(tx => reverseEntry(tx, initiated.id, 'Simulate the pre-fix ambiguous reversal', 'payout-safety'));
    expect(await balance(id, 'SELLER_AVAILABLE')).toBe(amount);
    expect((await runPayouts('payout-safety', id)).skipped).toHaveLength(1);
    expect(p.send).toHaveBeenCalledTimes(1);
    expect((await prisma.sellerPayout.findUniqueOrThrow({ where: { id: payout.id } })).remediationHint).toContain('Legacy reversal');
  });
  it('concurrent first submissions claim one operation and create only one provider payout', async () => {
    const id = await fixture(); const p = provider(); setPayoutAdapterForTests(p.adapter());
    await Promise.all([runPayouts('payout-safety', id), runPayouts('payout-safety', id)]);
    expect(p.send).toHaveBeenCalledTimes(1); expect(p.created.size).toBe(1);
    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: id } })).toBe(1);
    expect(await balance(id, 'SELLER_AVAILABLE')).toBe(0n);
  });
});
