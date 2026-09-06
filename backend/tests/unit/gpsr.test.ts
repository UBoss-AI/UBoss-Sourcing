/**
 * The GPSR Art. 19 checklist.
 *
 * `assessGpsr` is pure, so the whole rule set is testable without a database.
 * The cases that matter are the conditional ones — an EU manufacturer needs no
 * EU representative, a non-EU one does, and a deployment that does not sell
 * into the Union is not held to any of it.
 *
 * The last of those is the one worth guarding hardest. Getting it wrong in the
 * strict direction would block an Indian catalogue on a European regulation it
 * is not subject to, which is this software inventing law.
 */
import { describe, expect, it } from 'vitest';
import { assessGpsr } from '../../src/modules/catalog/gpsr.service.js';
import { processorReport } from '../../src/modules/settings/processors.service.js';

const EU = new Set(['NL', 'DE', 'FR', 'IT', 'PL', 'IE']);

const DUTCH_MANUFACTURER = {
  legalName: 'Zorgproducten B.V.',
  email: 'compliance@zorgproducten.test',
  countryCode: 'NL',
};

const INDIAN_MANUFACTURER = {
  legalName: 'SPM Medicare Pvt Ltd',
  email: 'exports@spm.test',
  countryCode: 'IN',
};

const EU_REPRESENTATIVE = {
  legalName: 'EU Rep Services GmbH',
  email: 'rep@eurep.test',
  countryCode: 'DE',
};

/** A listing with nothing missing, for the tests that remove one thing. */
const COMPLETE = {
  manufacturer: DUTCH_MANUFACTURER,
  euResponsible: null,
  gtin: '05012345678900',
  modelIdentifier: 'AF-IV-200',
  safetyWarnings: 'Single use only. Do not re-sterilise.',
};

describe('assessGpsr', () => {
  it('passes a complete listing from an EU manufacturer', () => {
    const result = assessGpsr(COMPLETE, EU, true);

    expect(result.compliant).toBe(true);
    expect(result.gaps).toEqual([]);
  });

  it('requires a manufacturer', () => {
    const result = assessGpsr({ ...COMPLETE, manufacturer: null }, EU, true);

    expect(result.compliant).toBe(false);
    expect(result.gaps.map((gap) => gap.code)).toContain('MANUFACTURER_REQUIRED');
    expect(result.gaps[0]?.message).toContain('Art. 19(a)');
  });

  it('requires the manufacturer to have an electronic address', () => {
    const result = assessGpsr(
      { ...COMPLETE, manufacturer: { ...DUTCH_MANUFACTURER, email: '  ' } },
      EU,
      true,
    );

    // Art. 19(a) asks for a postal AND an electronic address. A manufacturer
    // a buyer cannot write to has not really been named.
    expect(result.gaps.map((gap) => gap.code)).toContain('MANUFACTURER_EMAIL_REQUIRED');
  });

  it('requires an EU representative when the manufacturer is outside the Union', () => {
    const result = assessGpsr(
      { ...COMPLETE, manufacturer: INDIAN_MANUFACTURER, euResponsible: null },
      EU,
      true,
    );

    expect(result.gaps.map((gap) => gap.code)).toContain('EU_RESPONSIBLE_REQUIRED');
    expect(result.gaps.find((gap) => gap.code === 'EU_RESPONSIBLE_REQUIRED')?.message).toContain(
      'SPM Medicare',
    );
  });

  it('accepts a non-EU manufacturer that has named one', () => {
    const result = assessGpsr(
      { ...COMPLETE, manufacturer: INDIAN_MANUFACTURER, euResponsible: EU_REPRESENTATIVE },
      EU,
      true,
    );

    expect(result.compliant).toBe(true);
  });

  it('does not ask an EU manufacturer for a representative of their own', () => {
    const result = assessGpsr({ ...COMPLETE, euResponsible: null }, EU, true);

    // A validator that demanded this would be switched off within a week, and
    // rightly - Art. 16 applies only where the manufacturer is outside.
    expect(result.gaps.map((gap) => gap.code)).not.toContain('EU_RESPONSIBLE_REQUIRED');
  });

  it('accepts either identifier, and refuses when neither is present', () => {
    expect(assessGpsr({ ...COMPLETE, gtin: null }, EU, true).compliant).toBe(true);
    expect(assessGpsr({ ...COMPLETE, modelIdentifier: null }, EU, true).compliant).toBe(true);

    const neither = assessGpsr({ ...COMPLETE, gtin: null, modelIdentifier: null }, EU, true);
    expect(neither.gaps.map((gap) => gap.code)).toContain('IDENTIFIER_REQUIRED');
    // Our SKU is not an identifier - it means nothing outside this install.
    expect(neither.gaps.find((gap) => gap.code === 'IDENTIFIER_REQUIRED')?.message).toContain(
      'SKU',
    );
  });

  it('requires safety information, and treats whitespace as absent', () => {
    expect(
      assessGpsr({ ...COMPLETE, safetyWarnings: null }, EU, true).gaps.map((gap) => gap.code),
    ).toContain('SAFETY_INFORMATION_REQUIRED');

    expect(
      assessGpsr({ ...COMPLETE, safetyWarnings: '   \n ' }, EU, true).gaps.map((gap) => gap.code),
    ).toContain('SAFETY_INFORMATION_REQUIRED');
  });

  it('reports every gap at once rather than the first', () => {
    const result = assessGpsr(
      { manufacturer: null, euResponsible: null, gtin: null, modelIdentifier: null, safetyWarnings: null },
      EU,
      true,
    );

    // A catalogue manager fixing one field at a time, learning about the next
    // one only after saving, is how this feature gets abandoned.
    expect(result.gaps.length).toBe(3);
  });

  it('reports the same gaps when enforcement is off, but flags them as non-blocking', () => {
    const result = assessGpsr({ ...COMPLETE, manufacturer: null }, EU, false);

    // The point of the setting: an operator can see what switching it on will
    // cost them before it blocks anything.
    expect(result.enforced).toBe(false);
    expect(result.gaps.length).toBeGreaterThan(0);
    expect(result.compliant).toBe(false);
  });

  it('names the storefront languages a warning has not been translated into', () => {
    const result = assessGpsr(
      { ...COMPLETE, warningLanguages: ['de', 'nl'], storefrontLanguages: ['de', 'nl', 'pl', 'fr'] },
      EU,
      true,
    );

    // Art. 19(d) asks for a language "easily understood". A Polish hospital
    // shown an English-only warning has not been warned.
    expect(result.missingWarningLanguages).toEqual(['pl', 'fr']);
    // But it never blocks publication - eight translations before going live
    // would stop a catalogue existing at all.
    expect(result.compliant).toBe(true);
  });

  it('does not report translation gaps when there is no warning to translate', () => {
    const result = assessGpsr(
      { ...COMPLETE, safetyWarnings: null, storefrontLanguages: ['de', 'pl'] },
      EU,
      true,
    );

    // The missing warning is the finding. Listing two languages it has not
    // been translated into would bury it.
    expect(result.missingWarningLanguages).toEqual([]);
  });
});

describe('processor report', () => {
  it('lists every recipient this codebase can reach, active or not', () => {
    const report = processorReport();
    const keys = report.entries.map((entry) => entry.key);

    expect(keys).toContain('stripe');
    expect(keys).toContain('razorpay');
    expect(keys).toContain('ai-provider');
    expect(keys).toContain('smtp');
    expect(keys).toContain('geocoder');
    expect(keys).toContain('vies');
    expect(keys).toContain('object-storage');
  });

  it('derives the transfer flag from the location rather than asserting it', () => {
    const report = processorReport();

    const razorpay = report.entries.find((entry) => entry.key === 'razorpay');
    const stripe = report.entries.find((entry) => entry.key === 'stripe');

    expect(razorpay?.outsideEea).toBe(true);
    expect(stripe?.outsideEea).toBe(false);
  });

  it('does not count a feed that carries no personal data as a transfer', () => {
    const report = processorReport();
    const fx = report.entries.find((entry) => entry.key === 'fx-rates');

    // Currency codes both ways. Putting it on the Art. 44 list would teach
    // whoever reads that list to skim it.
    expect(fx?.carriesPersonalData).toBe(false);
    expect(report.transfersOutsideEea).toBe(
      report.entries.filter(
        (entry) => entry.active && entry.outsideEea && entry.carriesPersonalData,
      ).length,
    );
  });

  it('says which setting switches each recipient on', () => {
    // The whole value of the report: an entry a reader cannot act on is an
    // entry they will ignore.
    for (const entry of processorReport().entries) {
      expect(entry.configuredBy.length).toBeGreaterThan(0);
      expect(entry.dataShared.length).toBeGreaterThan(0);
    }
  });
});
