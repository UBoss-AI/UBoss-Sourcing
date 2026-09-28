/**
 * Checks no automated source may lawfully answer here, stated honestly.
 *
 * Each of these registers either has no public API, or has one that needs
 * credentials a deployment will not have out of the box, or sits behind a
 * CAPTCHA that exists precisely so it is not queried by machines. The answer
 * is not to scrape it. It is a MANUAL_REQUIRED row naming the official
 * register a reviewer should open, so the console says "somebody has to look"
 * rather than implying something was checked that was not.
 *
 *   - India, MCA company and LLP master data: the V3 portal's public lookup
 *     is CAPTCHA-protected; bulk and API access is a paid, contracted service.
 *   - India, GST taxpayer search: public search is CAPTCHA-protected; API
 *     access is through a GST Suvidha Provider under contract.
 *   - India, PAN: verification is an authenticated e-filing or contracted
 *     service.
 *   - India, Udyam and IEC: public verification pages, no API.
 *   - Poland, CEIDG: an API exists but needs a token issued on application.
 *     Adding `CEIDG_API_TOKEN` and a provider here is the upgrade path; until
 *     then a sole trader is checked by hand (and by the VAT register, which
 *     does run).
 *   - Poland, REGON (GUS BIR): an API exists but needs a key issued on
 *     application. Same upgrade path. The VAT register and KRS both return
 *     REGON, so it is usually confirmed indirectly.
 *   - EU business registers through BRIS: BRIS is the interconnection between
 *     national registers, searched through the e-Justice portal; there is no
 *     public machine interface for a marketplace to call.
 *   - EORI: the Commission's validation page, no API for this use.
 */
import { registrationRegisterFor, isEuCountry } from '../../../domain/buyer-company-identifiers.js';
import type { BusinessVerificationProvider, CheckResult, CompanySubject } from './types.js';

interface ManualRule {
  key: string;
  label: string;
  /** The scheme or 'REGISTRATION', and the value it is about. */
  target(subject: CompanySubject): { subject: string; value: string } | null;
  summary: string;
  sourceUrl: string;
}

function identifier(scheme: string) {
  return (subject: CompanySubject): { subject: string; value: string } | null => {
    const value = subject.identifiers.get(scheme);
    return value === undefined ? null : { subject: scheme, value };
  };
}

function registration(match: (subject: CompanySubject) => boolean) {
  return (subject: CompanySubject): { subject: string; value: string } | null =>
    subject.registrationNumber !== null && match(subject)
      ? { subject: 'REGISTRATION', value: subject.registrationNumber }
      : null;
}

const RULES: readonly ManualRule[] = [
  {
    key: 'IN_MCA',
    label: 'India - MCA company / LLP master data',
    target: registration((subject) => {
      const register = registrationRegisterFor(subject.registrationCountry, subject.entityType);
      return register === 'IN_CIN' || register === 'IN_LLPIN';
    }),
    summary:
      'Look up the CIN / LLPIN in MCA master data and compare name, status and registered office. No API is available without an MCA contract.',
    sourceUrl: 'https://www.mca.gov.in/content/mca/global/en/mca/master-data/MDS.html',
  },
  {
    key: 'IN_GST',
    label: 'India - GST taxpayer search',
    target: identifier('IN_GSTIN'),
    summary:
      'Search the GSTIN on the GST portal and compare legal name, trade name, status and state. API access needs a GST Suvidha Provider contract.',
    sourceUrl: 'https://services.gst.gov.in/services/searchtp',
  },
  {
    key: 'IN_PAN',
    label: 'India - PAN',
    target: identifier('IN_PAN'),
    summary:
      'The PAN is well-formed. Confirm it against the GST registration or the incorporation certificate; PAN verification itself is a contracted service.',
    sourceUrl: 'https://www.incometax.gov.in/iec/foportal/',
  },
  {
    key: 'IN_UDYAM',
    label: 'India - Udyam registration',
    target: identifier('IN_UDYAM'),
    summary: 'Verify the Udyam number on the Udyam portal.',
    sourceUrl: 'https://udyamregistration.gov.in/Udyam_Verify.aspx',
  },
  {
    key: 'IN_IEC',
    label: 'India - Importer-Exporter Code',
    target: identifier('IN_IEC'),
    summary: 'Verify the IEC on the DGFT portal.',
    sourceUrl: 'https://www.dgft.gov.in/CP/?opt=view-any-ice',
  },
  {
    key: 'PL_CEIDG',
    label: 'Poland - CEIDG (sole traders)',
    target: registration(
      (subject) =>
        registrationRegisterFor(subject.registrationCountry, subject.entityType) === 'PL_CEIDG',
    ),
    summary:
      'Search CEIDG by NIP and confirm the business is active. The CEIDG API needs a token this deployment does not have.',
    sourceUrl: 'https://aplikacja.ceidg.gov.pl/ceidg/ceidg.public.ui/search.aspx',
  },
  {
    key: 'PL_REGON',
    label: 'Poland - REGON (GUS)',
    target: identifier('PL_REGON'),
    summary:
      'The REGON has a valid check digit. The VAT register and KRS results show the REGON they hold; the GUS BIR API needs a key this deployment does not have.',
    sourceUrl: 'https://wyszukiwarkaregon.stat.gov.pl/appBIR/index.aspx',
  },
  {
    key: 'EU_BRIS',
    label: 'EU business registers (BRIS, via e-Justice)',
    target: registration(
      (subject) => isEuCountry(subject.registrationCountry) && subject.registrationCountry !== 'PL',
    ),
    summary:
      'Search the national register through the e-Justice portal (BRIS) and compare name, status and registered office.',
    sourceUrl:
      'https://e-justice.europa.eu/topics/registers-business-insolvency-land/business-registers-search-company-eu_en',
  },
  {
    key: 'EORI',
    label: 'EU EORI validation',
    target: identifier('EORI'),
    summary: 'Validate the EORI on the Commission’s EORI validation page.',
    sourceUrl: 'https://ec.europa.eu/taxation_customs/dds2/eos/eori_validation.jsp',
  },
  {
    key: 'LOCAL_REGISTER',
    label: 'Local company register',
    target: registration(
      (subject) =>
        registrationRegisterFor(subject.registrationCountry, subject.entityType) === 'LOCAL' &&
        !isEuCountry(subject.registrationCountry),
    ),
    summary:
      'No registry integration exists for this country. Check the registration number against the national company register or the supplied certificate.',
    sourceUrl: '',
  },
];

function toProvider(rule: ManualRule): BusinessVerificationProvider {
  return {
    key: rule.key,
    label: rule.label,
    appliesTo: (subject) => rule.target(subject) !== null,
    check(subject) {
      const target = rule.target(subject);
      if (target === null) return Promise.resolve([]);

      const result: CheckResult = {
        subject: target.subject,
        outcome: 'MANUAL_REQUIRED',
        summary: rule.summary,
        request: { [target.subject]: target.value },
        sourceUrl: rule.sourceUrl.length === 0 ? null : rule.sourceUrl,
      };
      return Promise.resolve([result]);
    },
  };
}

export const MANUAL_PROVIDERS: readonly BusinessVerificationProvider[] = RULES.map(toProvider);
