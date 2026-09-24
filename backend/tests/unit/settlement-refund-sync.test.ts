/**
 * A confirmed refund reaching the seller's settlement row, once.
 *
 * `syncSettlementRefunds` runs inside the caller's transaction, so it is given
 * a stand-in transaction here: an order with one seller's goods, refunds in
 * given states, and the settlement row it should rewrite. Amounts are
 * fixtures.
 */
import { describe, expect, it } from 'vitest';
import { syncSettlementRefunds } from '../../src/modules/seller/settlement-refund.service.js';

interface Row {
  id: string;
  sellerOrderGroupId: string;
  sellerAccountId: string;
  currency: string;
  grossProceedsMinor: bigint;
  sellerDeliveryProceedsMinor: bigint;
  platformFeeMinor: bigint;
  platformFeeTaxMinor: bigint;
  refundsAdjustmentsMinor: bigint;
  estimatedSettlementMinor: bigint;
  sellerOrderGroup: { sellerOrderNumber: string };
}

function fakeTx(input: { refunds: { status: string; amountMinor: bigint }[]; operatorLines?: number; rows: Row[] }) {
  const notifications: string[] = [];
  const tx = {
    $queryRaw: () => Promise.resolve([]),
    sellerOrderSettlement: {
      findMany: () => Promise.resolve(input.rows.map((row) => ({ ...row }))),
      update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const row = input.rows.find((candidate) => candidate.id === where.id);
        if (row !== undefined) Object.assign(row, data);
        return Promise.resolve(row);
      },
    },
    order: {
      findUniqueOrThrow: () =>
        Promise.resolve({ orderNumber: 'UB-1', currency: 'INR', paidMinor: 118_000n, grandTotalMinor: 118_000n }),
    },
    refund: {
      aggregate: ({ where }: { where: { status: string } }) =>
        Promise.resolve({
          _sum: {
            amountMinor: input.refunds
              .filter((refund) => refund.status === where.status)
              .reduce((sum, refund) => sum + refund.amountMinor, 0n),
          },
        }),
    },
    orderItem: { count: () => Promise.resolve(input.operatorLines ?? 0) },
    sellerNotification: {
      create: ({ data }: { data: { dedupeKey: string } }) => {
        notifications.push(data.dedupeKey);
        return Promise.resolve(data);
      },
    },
  };
  return { tx: tx as never, notifications };
}

function settlementRow(): Row {
  // Goods 1,000.00; fee 100.00; tax on the fee 15.00; nothing refunded yet.
  return {
    id: 'set-1',
    sellerOrderGroupId: 'grp-1',
    sellerAccountId: 'seller-1',
    currency: 'INR',
    grossProceedsMinor: 100_000n,
    sellerDeliveryProceedsMinor: 0n,
    platformFeeMinor: 10_000n,
    platformFeeTaxMinor: 1_500n,
    refundsAdjustmentsMinor: 0n,
    estimatedSettlementMinor: 88_500n,
    sellerOrderGroup: { sellerOrderNumber: 'SO-00001' },
  };
}

describe('syncSettlementRefunds', () => {
  it('subtracts a succeeded refund from the seller’s settlement', async () => {
    const row = settlementRow();
    const { tx } = fakeTx({ refunds: [{ status: 'SUCCEEDED', amountMinor: 59_000n }], rows: [row] });

    const result = await syncSettlementRefunds('order-1', tx);

    expect(result.updated).toBe(1);
    expect(row.refundsAdjustmentsMinor).toBe(50_000n);
    expect(row.estimatedSettlementMinor).toBe(38_500n);
  });

  it('subtracts nothing twice when the same refund is reported again', async () => {
    const row = settlementRow();
    const refunds = [{ status: 'SUCCEEDED', amountMinor: 59_000n }];

    await syncSettlementRefunds('order-1', fakeTx({ refunds, rows: [row] }).tx);
    const again = fakeTx({ refunds, rows: [row] });
    const second = await syncSettlementRefunds('order-1', again.tx);

    expect(second.updated).toBe(0);
    expect(again.notifications).toHaveLength(0);
    expect(row.refundsAdjustmentsMinor).toBe(50_000n);
    expect(row.estimatedSettlementMinor).toBe(38_500n);
  });

  it('ignores a refund that is only requested or still processing', async () => {
    const row = settlementRow();
    const { tx } = fakeTx({
      refunds: [
        { status: 'REQUESTED', amountMinor: 59_000n },
        { status: 'PROCESSING', amountMinor: 10_000n },
      ],
      rows: [row],
    });

    await syncSettlementRefunds('order-1', tx);

    expect(row.refundsAdjustmentsMinor).toBe(0n);
    expect(row.estimatedSettlementMinor).toBe(88_500n);
  });

  it('gives the share back when the provider later reports the refund failed', async () => {
    const row = { ...settlementRow(), refundsAdjustmentsMinor: 50_000n, estimatedSettlementMinor: 38_500n };
    const { tx } = fakeTx({ refunds: [{ status: 'FAILED', amountMinor: 59_000n }], rows: [row] });

    await syncSettlementRefunds('order-1', tx);

    expect(row.refundsAdjustmentsMinor).toBe(0n);
    expect(row.estimatedSettlementMinor).toBe(88_500n);
  });

  it('changes no seller’s settlement when a partial refund cannot be attributed', async () => {
    const row = settlementRow();
    const { tx } = fakeTx({
      refunds: [{ status: 'SUCCEEDED', amountMinor: 10_000n }],
      operatorLines: 1,
      rows: [row],
    });

    const result = await syncSettlementRefunds('order-1', tx);

    expect(result.unattributedMinor).toBe(10_000n);
    expect(row.refundsAdjustmentsMinor).toBe(0n);
  });
});
