import { describe, expect, it } from 'vitest';
import { parseSourcing, rfqHref, searchHref } from './sourcing-parse';

describe('plain-language sourcing (ENH-001)', () => {
  it('turns a description into specifications, filters and a draft link', () => {
    const p = parseSourcing('We need 5,000 boxes of nitrile gloves, CE and ISO 13485, FOB, to Germany within 30 days, under 2.50 EUR each');
    expect(p).toMatchObject({ quantity: '5000', unit: 'boxes', destinationCountry: 'DE', incoterm: 'FOB', certifications: ['CE', 'ISO 13485'], maxLeadTimeDays: 30, targetPrice: { amount: '2.50', currency: 'EUR' } });
    expect(p.product).toBe('nitrile gloves');
    expect(searchHref(p)).toBe('/search?q=nitrile+gloves&certified=true&incoterm=FOB&maxLeadTimeDays=30');
    const url = new URL(rfqHref(p), 'http://x');
    expect(url.pathname).toBe('/account/rfqs/new');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ title: 'nitrile gloves', quantity: '5000', unit: 'boxes', destinationCountry: 'DE', incoterm: 'FOB', certifications: 'CE\nISO 13485', targetPrice: '2.50', targetCurrency: 'EUR', from: 'describe' });
  });
  it('recognises nothing it is not sure of and keeps the whole text as the specification', () => {
    const p = parseSourcing('something nice for the office');
    expect(p).toMatchObject({ quantity: null, destinationCountry: null, incoterm: null, certifications: [], targetPrice: null, maxLeadTimeDays: null });
    expect(new URL(rfqHref(p), 'http://x').searchParams.get('specification')).toBe('something nice for the office');
  });
  it('reads a currency sign and an ISO code destination', () => {
    expect(parseSourcing('1000 pcs steel bolts to IN at $0.40 each')).toMatchObject({ destinationCountry: 'IN', targetPrice: { amount: '0.40', currency: 'USD' }, quantity: '1000', unit: 'pcs', product: 'steel bolts' });
  });
});
