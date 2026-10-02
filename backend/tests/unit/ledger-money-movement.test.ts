/**
 * The transaction ledger as the single source for money movement
 * (checklist JOURNEY-052), without a database:
 *
 *   - every allocation balances, with the order tax, the operator's delivery
 *     and a platform-carried discount on lines of their own, so buyer
 *     clearing nets to zero;
 *   - the operator's own goods, tax and shipping have their own home;
 *   - the per-order summary reads each destination from the journal;
 *   - the grant generator keeps the three ledger tables append-only for the
 *     application account, and takes back a grant an older deployment made.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { operatorParts, sellerLineParts } from '../../src/modules/finance/escrow.service.js';
import { isBalanced, summarise, type LedgerLineInput, type LedgerSumRow } from '../../src/modules/finance/ledger.service.js';

const GRANTS = readFileSync(new URL('../../../deploy/mariadb/post-migrate-grants.sql', import.meta.url), 'utf8');

/** The lines `allocateOrder` writes for one seller order, built the same way. */
function allocationLines(input: {
  goods: bigint;
  sellerDelivery: bigint;
  operatorDelivery: bigint;
  fee: bigint;
  feeTax: bigint;
  items: { lineTotalMinor: bigint; taxAmountMinor: bigint; taxInclusive: boolean; discountMinor: bigint }[];
}): LedgerLineInput[] {
  const gross = input.goods + input.sellerDelivery;
  const share = gross - input.fee - input.feeTax;
  const parts = sellerLineParts(input.items);
  return [
    { code: 'BUYER_FUNDS_CLEARING', amountMinor: gross + parts.exclusiveTaxMinor + input.operatorDelivery - parts.discountMinor },
    { code: 'SELLER_HELD', amountMinor: -share },
    { code: 'PLATFORM_COMMISSION', amountMinor: -input.fee },
    { code: 'PLATFORM_FEE_TAX', amountMinor: -input.feeTax },
    { code: 'ORDER_TAX_COLLECTED', amountMinor: -parts.exclusiveTaxMinor },
    { code: 'PLATFORM_LOGISTICS_REVENUE', amountMinor: -input.operatorDelivery },
    { code: 'PLATFORM_DISCOUNTS_FUNDED', amountMinor: parts.discountMinor },
  ];
}

describe('allocation lines', () => {
  it('balance, and clear exactly what the buyer paid for the seller part', () => {
    // Goods 100,000 less a 5,000 discount, 18% tax on top of 95,000, seller
    // delivery 2,000, operator-arranged delivery 3,000.
    const items = [{ lineTotalMinor: 112_100n, taxAmountMinor: 17_100n, taxInclusive: false, discountMinor: 5_000n }];
    const lines = allocationLines({ goods: 100_000n, sellerDelivery: 2_000n, operatorDelivery: 3_000n, fee: 10_000n, feeTax: 1_800n, items });
    expect(isBalanced(lines)).toBe(true);
    const clearing = lines.find((line) => line.code === 'BUYER_FUNDS_CLEARING')?.amountMinor;
    // lineTotal + seller delivery + operator delivery: the buyer's whole payment.
    expect(clearing).toBe(112_100n + 2_000n + 3_000n);
    expect(lines.find((line) => line.code === 'ORDER_TAX_COLLECTED')?.amountMinor).toBe(-17_100n);
    expect(lines.find((line) => line.code === 'PLATFORM_LOGISTICS_REVENUE')?.amountMinor).toBe(-3_000n);
  });

  it('leave tax inside a tax-inclusive price with the goods', () => {
    expect(sellerLineParts([{ lineTotalMinor: 11_800n, taxAmountMinor: 1_800n, taxInclusive: true, discountMinor: 0n }])).toEqual({
      exclusiveTaxMinor: 0n,
      discountMinor: 0n,
    });
  });

  it("give the operator's own goods, tax and shipping their own lines", () => {
    const own = operatorParts(
      [
        { lineTotalMinor: 11_800n, taxAmountMinor: 1_800n, taxInclusive: false, discountMinor: 0n },
        { lineTotalMinor: 5_900n, taxAmountMinor: 900n, taxInclusive: true, discountMinor: 0n },
      ],
      7_000n,
      4_000n,
    );
    expect(own).toEqual({ goodsMinor: 15_000n, taxMinor: 2_700n, shippingMinor: 3_000n });
    // The legs belong to sellers; shipping never goes negative.
    expect(operatorParts([], 1_000n, 4_000n).shippingMinor).toBe(0n);
  });

  it('refuse an entry that does not sum to zero, or has one line', () => {
    expect(isBalanced([{ code: 'PROVIDER_BALANCE', amountMinor: 10n }, { code: 'BUYER_FUNDS_CLEARING', amountMinor: -9n }])).toBe(false);
    expect(isBalanced([{ code: 'PROVIDER_BALANCE', amountMinor: 0n }, { code: 'BUYER_FUNDS_CLEARING', amountMinor: 0n }])).toBe(false);
  });
});

describe('the order summary', () => {
  it('reads every destination from the journal, and clearing at zero once allocated', () => {
    const row = (kind: LedgerSumRow['kind'], code: LedgerSumRow['code'], total: bigint): LedgerSumRow => ({
      kind,
      code,
      currency: 'INR',
      key: 'O1',
      total,
    });
    const rows = [
      row('PAYMENT_CAPTURED', 'PROVIDER_BALANCE', 117_100n),
      row('PAYMENT_CAPTURED', 'BUYER_FUNDS_CLEARING', -117_100n),
      ...allocationLines({
        goods: 100_000n,
        sellerDelivery: 2_000n,
        operatorDelivery: 3_000n,
        fee: 10_000n,
        feeTax: 1_800n,
        items: [{ lineTotalMinor: 112_100n, taxAmountMinor: 17_100n, taxInclusive: false, discountMinor: 5_000n }],
      }).map((line) => row('SALE_ALLOCATED', line.code, line.amountMinor)),
    ];
    const summary = summarise(rows, 'O1', 'INR');
    expect(summary).toMatchObject({
      grossMinor: 117_100n,
      orderTaxMinor: 17_100n,
      logisticsMinor: 3_000n,
      discountsFundedMinor: 5_000n,
      platformFeeMinor: 10_000n,
      sellerShareMinor: 90_200n,
      unallocatedMinor: 0n,
    });
  });
});

describe('the grant generator keeps the ledger append-only', () => {
  it('grants no UPDATE or DELETE on the three ledger tables', () => {
    expect(GRANTS).toContain(
      "AND TABLE_NAME NOT IN ('audit_logs', '_prisma_migrations', 'ledger_accounts', 'ledger_entries', 'ledger_lines')",
    );
  });

  it('takes back a table-level grant an older deployment made, only where one exists', () => {
    expect(GRANTS).toMatch(/SELECT CONCAT\('REVOKE UPDATE, DELETE ON `', @db, '`\.`', p\.Table_name/);
    expect(GRANTS).toContain('FROM mysql.tables_priv p');
  });

  it('proves all five protected tables, for UPDATE and DELETE alike', () => {
    expect(GRANTS).toContain("''audit_logs'', ''_prisma_migrations'', ''ledger_accounts'', ''ledger_entries'', ''ledger_lines''");
    expect(GRANTS).toContain("FIND_IN_SET(''Delete'', p.Table_priv)");
  });
});
