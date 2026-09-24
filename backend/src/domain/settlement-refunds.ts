/**
 * How much of a buyer's refund comes out of each seller's settlement.
 *
 * A refund is recorded against the ORDER - an amount of the buyer's money,
 * with no lines on it. A marketplace order, though, is several sellers' work,
 * and the settlement subtracts refunds seller by seller. This decides the
 * seller's part, and only where the answer is not a guess:
 *
 *   - **Refunded in full.** Every seller's proceeds (their goods plus the
 *     delivery they controlled) went back to the buyer, so each seller's
 *     refund figure is their whole proceeds.
 *   - **One seller, and nothing of the operator's on the order.** Every part of
 *     the refund is about that seller's order. Their share is the refund in
 *     proportion to what they were owed out of the order total: the rest of
 *     that total is tax and marketplace delivery, which never reached them and
 *     so is not taken back from them. Never more than their proceeds.
 *   - **Anything else** - a partial refund on an order shared between sellers,
 *     or between a seller and the operator's own stock - names no line, so
 *     nothing here can say whose goods it was for. It is left unattributed and
 *     reported, rather than spread across sellers on an invented rule.
 *
 * DERIVED, NOT ACCUMULATED. The figure is worked out from every refund on the
 * order that has succeeded, not incremented per event. A provider resending
 * the same webhook, or a refund being reported twice by two paths, lands on
 * the same number; a refund the provider later reports as failed takes its
 * share back out.
 *
 * Money is bigint minor units throughout; the proportional share is rounded
 * half-up, once.
 */
import type { Minor } from './money.js';

export interface SettlementRefundGroup {
  id: string;
  /** Goods plus seller-controlled delivery: what the seller was owed. */
  proceedsMinor: Minor;
}

export interface SettlementRefundInput {
  /** Every succeeded refund on the order, summed. */
  succeededRefundsMinor: Minor;
  paidMinor: Minor;
  grandTotalMinor: Minor;
  /** Order lines that are the operator's own stock. */
  operatorLineCount: number;
  groups: readonly SettlementRefundGroup[];
}

export interface SettlementRefundAttribution {
  /** Seller group id to the refund its settlement carries. */
  byGroup: Map<string, Minor>;
  /** Refunded money that could not be put on any one seller. Zero when all was. */
  unattributedMinor: Minor;
  basis: 'NONE' | 'FULL_REFUND' | 'SINGLE_SELLER' | 'AMBIGUOUS';
}

export function attributeRefundsToSellers(input: SettlementRefundInput): SettlementRefundAttribution {
  const zero = (): Map<string, Minor> => new Map(input.groups.map((group) => [group.id, 0n]));

  if (input.succeededRefundsMinor <= 0n || input.groups.length === 0) {
    return { byGroup: zero(), unattributedMinor: 0n, basis: 'NONE' };
  }

  if (input.paidMinor > 0n && input.succeededRefundsMinor >= input.paidMinor) {
    return {
      byGroup: new Map(input.groups.map((group) => [group.id, positive(group.proceedsMinor)])),
      unattributedMinor: 0n,
      basis: 'FULL_REFUND',
    };
  }

  const only = input.groups.length === 1 ? input.groups[0] : undefined;
  if (only !== undefined && input.operatorLineCount === 0) {
    const proceeds = positive(only.proceedsMinor);
    const total = input.grandTotalMinor > 0n ? input.grandTotalMinor : input.paidMinor;
    let share =
      total > 0n
        ? (input.succeededRefundsMinor * proceeds * 2n + total) / (2n * total)
        : input.succeededRefundsMinor;
    if (share > proceeds) share = proceeds;
    return { byGroup: new Map([[only.id, share]]), unattributedMinor: 0n, basis: 'SINGLE_SELLER' };
  }

  return { byGroup: zero(), unattributedMinor: input.succeededRefundsMinor, basis: 'AMBIGUOUS' };
}

function positive(amount: Minor): Minor {
  return amount > 0n ? amount : 0n;
}
