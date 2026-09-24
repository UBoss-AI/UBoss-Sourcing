/**
 * Which seller a refund comes out of, and how much. Amounts are fixtures.
 */
import { describe, expect, it } from 'vitest';
import { attributeRefundsToSellers } from '../../src/domain/settlement-refunds.js';

describe('attributing refunds to seller settlements', () => {
  it('charges nothing when nothing has been refunded', () => {
    const result = attributeRefundsToSellers({
      succeededRefundsMinor: 0n,
      paidMinor: 118_000n,
      grandTotalMinor: 118_000n,
      operatorLineCount: 0,
      groups: [{ id: 'a', proceedsMinor: 100_000n }],
    });
    expect(result.byGroup.get('a')).toBe(0n);
    expect(result.basis).toBe('NONE');
  });

  it('takes back every seller’s whole proceeds on a full refund', () => {
    const result = attributeRefundsToSellers({
      succeededRefundsMinor: 236_000n,
      paidMinor: 236_000n,
      grandTotalMinor: 236_000n,
      operatorLineCount: 1,
      groups: [
        { id: 'a', proceedsMinor: 100_000n },
        { id: 'b', proceedsMinor: 50_000n },
      ],
    });
    expect(result.byGroup.get('a')).toBe(100_000n);
    expect(result.byGroup.get('b')).toBe(50_000n);
    expect(result.unattributedMinor).toBe(0n);
  });

  it('takes a partial refund on a one-seller order in proportion, leaving the tax out', () => {
    // Goods 1,000.00 + tax 180.00; half of it refunded.
    const result = attributeRefundsToSellers({
      succeededRefundsMinor: 59_000n,
      paidMinor: 118_000n,
      grandTotalMinor: 118_000n,
      operatorLineCount: 0,
      groups: [{ id: 'a', proceedsMinor: 100_000n }],
    });
    expect(result.byGroup.get('a')).toBe(50_000n);
    expect(result.basis).toBe('SINGLE_SELLER');
  });

  it('rounds the proportional share half-up and never beyond the proceeds', () => {
    const result = attributeRefundsToSellers({
      succeededRefundsMinor: 1n,
      paidMinor: 3n,
      grandTotalMinor: 3n,
      operatorLineCount: 0,
      groups: [{ id: 'a', proceedsMinor: 2n }],
    });
    // 1 * 2 / 3 = 0.67 -> 1.
    expect(result.byGroup.get('a')).toBe(1n);
  });

  it('is the same figure however often it is worked out', () => {
    const input = {
      succeededRefundsMinor: 59_000n,
      paidMinor: 118_000n,
      grandTotalMinor: 118_000n,
      operatorLineCount: 0,
      groups: [{ id: 'a', proceedsMinor: 100_000n }],
    };
    expect(attributeRefundsToSellers(input).byGroup.get('a')).toBe(
      attributeRefundsToSellers(input).byGroup.get('a'),
    );
  });

  it('refuses to guess on a partial refund of a shared order', () => {
    const shared = attributeRefundsToSellers({
      succeededRefundsMinor: 10_000n,
      paidMinor: 236_000n,
      grandTotalMinor: 236_000n,
      operatorLineCount: 0,
      groups: [
        { id: 'a', proceedsMinor: 100_000n },
        { id: 'b', proceedsMinor: 100_000n },
      ],
    });
    expect(shared.basis).toBe('AMBIGUOUS');
    expect(shared.unattributedMinor).toBe(10_000n);
    expect(shared.byGroup.get('a')).toBe(0n);

    const withOperatorStock = attributeRefundsToSellers({
      succeededRefundsMinor: 10_000n,
      paidMinor: 236_000n,
      grandTotalMinor: 236_000n,
      operatorLineCount: 1,
      groups: [{ id: 'a', proceedsMinor: 100_000n }],
    });
    expect(withOperatorStock.basis).toBe('AMBIGUOUS');
  });
});
