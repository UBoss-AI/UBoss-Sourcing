/**
 * Seller Hub rules that are pure arithmetic (JOURNEY-027, 030).
 *
 * - Certificate and factory expiry warnings fall at thirty and seven days,
 *   and each notice's key names its subject, end date and stage, so a renewal
 *   with a new date is warned about again while a repeat beat says nothing.
 * - The RFQ qualification score is points from the matching facts; a flag
 *   never subtracts.
 * - Which company-detail changes re-open verification.
 */
import { describe, expect, it } from 'vitest';
import { expiryDedupeKey, expiryStage } from '../../src/modules/trust/expiry-alerts.service.js';
import { qualificationScore } from '../../src/modules/rfq/matching.service.js';
import { MATERIAL_FIELDS } from '../../src/modules/seller/company-change.service.js';

const DAY = 86_400_000;
const NOW = new Date('2026-10-02T09:00:00.000Z');

describe('expiry warnings', () => {
  it('warns at thirty days and at seven, and not before or after', () => {
    expect(expiryStage(new Date(NOW.getTime() + 31 * DAY), NOW)).toBeNull();
    expect(expiryStage(new Date(NOW.getTime() + 30 * DAY), NOW)).toBe('T30');
    expect(expiryStage(new Date(NOW.getTime() + 8 * DAY), NOW)).toBe('T30');
    expect(expiryStage(new Date(NOW.getTime() + 7 * DAY), NOW)).toBe('T7');
    expect(expiryStage(new Date(NOW.getTime() + 1_000), NOW)).toBe('T7');
    // Already past: that is the lapse, which the sweep announces.
    expect(expiryStage(new Date(NOW.getTime() - 1_000), NOW)).toBeNull();
  });

  it('keys each notice on the subject, the end date and the stage', () => {
    const ends = new Date('2026-10-30T23:59:59.999Z');
    expect(expiryDedupeKey('cert', 'C1', ends, 'T30')).toBe('trust-expiry:cert:C1:2026-10-30:T30');
    expect(expiryDedupeKey('cert', 'C1', ends, 'T7')).not.toBe(expiryDedupeKey('cert', 'C1', ends, 'T30'));
    // A renewal moves the end date, so the warnings start again.
    expect(expiryDedupeKey('cert', 'C1', new Date('2027-10-30T00:00:00Z'), 'T30')).not.toBe(
      expiryDedupeKey('cert', 'C1', ends, 'T30'),
    );
    expect(expiryDedupeKey('factory', 'F1', ends, 'LAPSED')).toBe('trust-expiry:factory:F1:2026-10-30:LAPSED');
    // The column is 120 characters; a ULID-keyed notice is well inside it.
    expect(expiryDedupeKey('factory', 'X'.repeat(26), ends, 'LAPSED').length).toBeLessThanOrEqual(120);
  });
});

describe('RFQ qualification score', () => {
  it('adds 40 for a live listing, 20 for exports, 20 for a certificate and 20 for capacity', () => {
    expect(
      qualificationScore({
        liveInCategory: true,
        reasons: ['LIVE_IN_CATEGORY', 'EXPORTS_TO_DESTINATION', 'VERIFIED_CERTIFICATE'],
        flags: [],
      }),
    ).toBe(100);
    expect(qualificationScore({ liveInCategory: true, reasons: ['LIVE_IN_CATEGORY'], flags: ['CAPACITY_UNKNOWN'] })).toBe(40);
    expect(
      qualificationScore({ liveInCategory: false, reasons: [], flags: ['NOT_LIVE_IN_CATEGORY', 'CAPACITY_BELOW_QUANTITY'] }),
    ).toBe(0);
  });

  it('never takes points away for an open dispute; it is shown as a flag', () => {
    const base = { liveInCategory: true, reasons: ['LIVE_IN_CATEGORY'] as const };
    expect(qualificationScore({ ...base, flags: ['OPEN_DISPUTE'] })).toBe(qualificationScore({ ...base, flags: [] }));
  });
});

describe('company-detail change control', () => {
  it('re-opens the business check for name, registration and country, and the tax check for the tax number', () => {
    expect(MATERIAL_FIELDS.legalName).toBe('BUSINESS_REGISTRATION');
    expect(MATERIAL_FIELDS.companyRegistrationNumber).toBe('BUSINESS_REGISTRATION');
    expect(MATERIAL_FIELDS.registeredCountry).toBe('BUSINESS_REGISTRATION');
    expect(MATERIAL_FIELDS.taxRegistrationNumber).toBe('TAX_REGISTRATION');
    // An address change inside the same country is applied without re-verification.
    expect(MATERIAL_FIELDS.registeredCity).toBeUndefined();
    expect(MATERIAL_FIELDS.registeredPostcode).toBeUndefined();
  });
});
