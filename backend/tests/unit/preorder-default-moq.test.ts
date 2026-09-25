/**
 * The platform's bulk minimum: the last step of the preorder MOQ chain.
 *
 * Offer, product and seller-default terms are the seller's and always win
 * (`resolvePolicy`). Only where none exists does `PREORDER_DEFAULT_MOQ` apply,
 * and then as a floor on the listing's own minimum, raised onto its steps.
 */
import { describe, expect, it } from 'vitest';

import {
  defaultMinimumOnGrid,
  platformDefaultPolicy,
} from '../../src/modules/preorders/policy.service.js';
import { quantityRulesFor, resolvePolicy } from '../../src/domain/preorder.js';

describe('defaultMinimumOnGrid', () => {
  it('raises a listing sold one at a time to the platform figure exactly', () => {
    expect(defaultMinimumOnGrid(1, 1, 1000)).toBe(1000);
  });

  it('lands on the listing’s own steps, never between them', () => {
    // Cartons of 48: 1,000 pieces cannot be bought, 21 cartons (1,008) can.
    expect(defaultMinimumOnGrid(48, 48, 1000)).toBe(1008);
  });

  it('keeps a listing minimum that is already higher', () => {
    expect(defaultMinimumOnGrid(5000, 100, 1000)).toBe(5000);
  });
});

describe('platformDefaultPolicy', () => {
  it('uses the central default of 1,000 pieces when the listing says less', () => {
    const policy = platformDefaultPolicy({
      minimum: 1,
      increment: 1,
      listPriceMinor: 2000n,
      currency: 'INR',
      defaultMinimum: 1000,
    });
    expect(policy.scope).toBe('PLATFORM_DEFAULT');
    expect(policy.moqQuantity).toBe(1000);
    expect(quantityRulesFor(policy, { PIECE: 1 }).rules?.minimumBaseUnits).toBe(1000);
    expect(policy.tiers[0]?.minBaseUnits).toBe(1000);
  });

  it('reads the deployment setting when the caller names none', () => {
    const policy = platformDefaultPolicy({
      minimum: null,
      increment: null,
      listPriceMinor: 0n,
      currency: 'INR',
    });
    // PREORDER_DEFAULT_MOQ's default.
    expect(policy.moqQuantity).toBe(1000);
    expect(policy.pricingMode).toBe('QUOTE_REQUIRED');
  });

  it('is never chosen over terms a seller configured', () => {
    const chosen = resolvePolicy([
      { scope: 'SELLER_DEFAULT' as const, moq: 400 },
      { scope: 'PRODUCT' as const, moq: 300 },
    ]);
    expect(chosen?.moq).toBe(300);
  });
});
