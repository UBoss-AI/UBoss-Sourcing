import { describe, expect, it } from 'vitest';
import { compareCellId, summarise } from './compare-summary';
import type { ComparisonRow } from './rfq-quote';

const m = (minor: string, currency = 'EUR') => ({ minor, formatted: `${currency} ${minor}`, currency });
const row = (quoteId: string, name: string, total: string, lead: number | null, moq: string | null, currency = 'EUR', landed: string | null = null): ComparisonRow => ({
  quoteId, supplier: { sellerAccountId: quoteId, displayName: name, registrationCountry: 'IN', verifiedAt: null, verified: true },
  quoted: { currency, unitPrice: m('1', currency), applicableUnitPrice: m('1', currency), total: m(total, currency), tooling: null, sampleCost: null, shippingEstimate: null, landedEstimate: landed === null ? null : m(landed, currency) },
  converted: null, conversionUnavailable: currency !== 'EUR', leadTimeDays: lead, moq,
} as unknown as ComparisonRow);
const fmt = (money: { formatted: string }) => money.formatted;

describe('quote comparison summary (ENH-002)', () => {
  it('draws conclusions only from stated fields, with exact money, ties and unstated counts', () => {
    const out = summarise([
      row('a', 'Alpha', '9007199254740993', 10, '500'),
      row('b', 'Beta', '9007199254740992', null, '100'),
      row('c', 'Gamma', '9007199254740992', 20, '100'),
    ], fmt);
    expect(out.comparablePrices).toBe(true);
    expect(out.conclusions).toEqual([
      { field: 'total', quoteIds: ['b', 'c'], suppliers: ['Beta', 'Gamma'], value: 'EUR 9007199254740992', unstated: 0 },
      { field: 'leadTime', quoteIds: ['a'], suppliers: ['Alpha'], value: '10', unstated: 1 },
      { field: 'moq', quoteIds: ['b', 'c'], suppliers: ['Beta', 'Gamma'], value: '100', unstated: 0 },
    ]);
  });
  it('compares no price across currencies without a rate, and reports no difference where all agree', () => {
    const out = summarise([row('a', 'Alpha', '100', 5, '1'), row('b', 'Beta', '50', 5, '1', 'USD')], fmt);
    expect(out.comparablePrices).toBe(false);
    expect(out.conclusions).toEqual([]);
  });
  it('builds stable, safe cell ids', () => {
    expect(compareCellId('Lead time (days)', 'Q1')).toBe('cmp-lead-time-days--Q1');
  });
});
