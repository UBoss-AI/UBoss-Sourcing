import { describe, expect, it } from 'vitest';
import { applyBasisPoints, deliveryRange, landedCost, percentToBasisPoints } from '@/lib/landed-cost';

describe('landed cost', () => {
  it('adds goods, freight, duty on goods plus freight, tax on that plus duty, inspection and fee', () => {
    const result = landedCost({
      unitPriceMinor: 1000n, // 10.00
      quantity: 100n, // goods 1000.00
      freightMinor: 20000n, // 200.00
      inspectionMinor: 15000n, // 150.00
      dutyBp: 500n, // 5% of 1200.00 = 60.00
      taxBp: 2000n, // 20% of 1260.00 = 252.00
      platformFeeBp: 300n, // 3% of 1000.00 = 30.00
    });
    expect(result.duty).toBe(6000n);
    expect(result.tax).toBe(25200n);
    expect(result.platform).toBe(3000n);
    expect(result.total).toBe(169200n);
    expect(result.perUnit).toBe(1692n);
  });

  it('rounds half up and reads percentages without floats', () => {
    expect(percentToBasisPoints('12.5')).toBe(1250n);
    expect(percentToBasisPoints('abc')).toBeNull();
    expect(applyBasisPoints(1n, 5000n)).toBe(1n);
  });

  it('turns minimum and maximum transit days into an expected delivery range (ENH-006)', () => {
    const from = new Date(2026, 9, 28, 15, 0);
    expect(deliveryRange(from, '5', '12')).toEqual({ earliest: '2026-11-02', latest: '2026-11-09' });
    expect(deliveryRange(from, '0', '0')).toEqual({ earliest: '2026-10-28', latest: '2026-10-28' });
    expect(deliveryRange(from, '9', '3')).toBeNull();
    expect(deliveryRange(from, '2.5', '4')).toBeNull();
    expect(deliveryRange(from, '', '4')).toBeNull();
  });
});
