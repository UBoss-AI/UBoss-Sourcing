import { describe, expect, it } from 'vitest';
import { findMismatches } from '../../src/modules/payments/reconciliation.service.js';

describe('payment reconciliation', () => {
  const orders = [
    { id: 'A', paidMinor: 1000n, refundedMinor: 0n },
    { id: 'B', paidMinor: 500n, refundedMinor: 0n },
    { id: 'C', paidMinor: 0n, refundedMinor: 0n },
    { id: 'D', paidMinor: 300n, refundedMinor: 0n },
  ];
  const captured = new Map([['A', 1000n], ['B', 500n], ['C', 700n]]);
  const refunded = new Map([['B', 200n]]);

  it('lists an order whose recorded paid or refunded total differs from the ledgers', () => {
    expect(findMismatches(orders, captured, refunded).map((order) => order.id)).toEqual(['B', 'C', 'D']);
  });

  it('lists nothing when every order agrees', () => {
    expect(findMismatches([orders[0]!], captured, new Map())).toEqual([]);
  });
});
