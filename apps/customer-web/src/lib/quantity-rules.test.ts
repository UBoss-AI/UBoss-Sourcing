/**
 * Purchasing-rule arithmetic.
 *
 * These rules are the most common reason a B2B add-to-cart is rejected, so the
 * storefront meets them while the customer chooses rather than after. The
 * backend enforces the same rules; these tests are about not wasting the
 * customer's time, not about security.
 */
import { describe, expect, it } from 'vitest';
import { clampToRules, describeRules } from './quantity-rules';
import type { PurchaseRules } from './types';

function rules(overrides: Partial<PurchaseRules> = {}): PurchaseRules {
  return {
    minOrderQty: 1,
    maxOrderQty: null,
    qtyIncrement: 1,
    isRecurringEligible: false,
    ...overrides,
  };
}

describe('clampToRules', () => {
  it('leaves an already-valid quantity alone', () => {
    expect(clampToRules(7, rules())).toBe(7);
  });

  it('raises anything below the minimum', () => {
    expect(clampToRules(3, rules({ minOrderQty: 10 }))).toBe(10);
    expect(clampToRules(0, rules({ minOrderQty: 10 }))).toBe(10);
    expect(clampToRules(-5, rules({ minOrderQty: 10 }))).toBe(10);
  });

  it('counts steps from the minimum, not from zero', () => {
    // Minimum 10, step 5 allows 10, 15, 20 — 5 is below the minimum and 12 is
    // not on the ladder. Counting from zero would wrongly allow 5.
    const spec = rules({ minOrderQty: 10, qtyIncrement: 5 });

    expect(clampToRules(10, spec)).toBe(10);
    expect(clampToRules(11, spec)).toBe(15);
    expect(clampToRules(15, spec)).toBe(15);
    expect(clampToRules(16, spec)).toBe(20);
    expect(clampToRules(5, spec)).toBe(10);
  });

  it('never returns more than the maximum', () => {
    const spec = rules({ minOrderQty: 10, qtyIncrement: 5, maxOrderQty: 22 });

    // 25 would be the next step up, but 22 is the cap, so it settles on 20 —
    // the largest valid quantity that fits.
    expect(clampToRules(25, spec)).toBe(20);
    expect(clampToRules(1000, spec)).toBe(20);
  });

  it('handles a maximum that equals the minimum', () => {
    const spec = rules({ minOrderQty: 10, qtyIncrement: 5, maxOrderQty: 10 });

    expect(clampToRules(1, spec)).toBe(10);
    expect(clampToRules(99, spec)).toBe(10);
  });

  it('survives a nonsensical increment rather than dividing by zero', () => {
    // A zero increment should never reach the client, but producing NaN in a
    // quantity box would be a worse failure than treating it as one.
    expect(clampToRules(5, rules({ qtyIncrement: 0 }))).toBe(5);
  });

  it('always produces a quantity that satisfies every rule', () => {
    const spec = rules({ minOrderQty: 4, qtyIncrement: 3, maxOrderQty: 19 });

    for (let desired = -10; desired <= 40; desired += 1) {
      const result = clampToRules(desired, spec);

      expect(result).toBeGreaterThanOrEqual(spec.minOrderQty);
      expect(result).toBeLessThanOrEqual(19);
      expect((result - spec.minOrderQty) % spec.qtyIncrement).toBe(0);
    }
  });
});

describe('describeRules', () => {
  it('says nothing when there is nothing unusual', () => {
    expect(describeRules(rules())).toBeNull();
  });

  it('describes each rule that actually applies', () => {
    expect(describeRules(rules({ minOrderQty: 10 }))).toBe('Ordered minimum 10.');
    expect(describeRules(rules({ qtyIncrement: 5 }))).toBe('Ordered in multiples of 5.');
    expect(describeRules(rules({ maxOrderQty: 100 }))).toBe('Ordered maximum 100.');
  });

  it('combines them in one readable sentence', () => {
    expect(describeRules(rules({ minOrderQty: 10, qtyIncrement: 5, maxOrderQty: 100 }))).toBe(
      'Ordered minimum 10, in multiples of 5, maximum 100.',
    );
  });
});
