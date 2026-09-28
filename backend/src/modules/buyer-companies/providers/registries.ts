/**
 * The registry checks that call an official API.
 *
 * Each is a free, public service run by the authority itself, called only at
 * the address the deployment configures, and none needs a credential:
 *
 *   - EU VIES - VAT status of an EU VAT number. Through the existing VIES
 *     client (`tax/vies.service.ts`), so a buyer company and a customer's
 *     invoicing number share one cache and one set of failure rules.
 *     VIES says whether a VAT number is active. It does NOT prove the whole
 *     company is legitimate, and the summary says so.
 *   - GLEIF - the global LEI register.
 *   - Poland, Ministry of Finance - the VAT taxpayer register ("biała lista").
 *   - Poland, Ministry of Justice - the National Court Register (KRS) open API.
 */
import { env } from '../../../config/env.js';
import { normaliseCompanyLegalName } from '../../../domain/buyer-company-requirements.js';
import { registrationRegisterFor } from '../../../domain/buyer-company-identifiers.js';
import { checkVatNumber } from '../../tax/vies.service.js';
import { field, getRegistryJson } from './http.js';
import {
  fillUrl,
  namesAgree,
  type BusinessVerificationProvider,
  type CheckResult,
  type CompanySubject,
} from './types.js';

function applicationName(subject: CompanySubject): string {
  return normaliseCompanyLegalName(subject.legalName ?? subject.tradingName ?? '');
}

function switchedOff(
  subjectKey: string,
  source: string,
  request: Record<string, string | null>,
  sourceUrl: string,
): CheckResult {
  return {
    subject: subjectKey,
    outcome: 'MANUAL_REQUIRED',
    summary: `${source} checking is switched off on this deployment. Check the register by hand.`,
    request,
    sourceUrl,
  };
}

// ---------------------------------------------------------------------------
// VIES
// ---------------------------------------------------------------------------

export const viesProvider: BusinessVerificationProvider = {
  key: 'VIES',
  label: 'EU VIES (VAT status)',
  appliesTo: (subject) => subject.identifiers.has('EU_VAT'),
  async check(subject) {
    const vat = subject.identifiers.get('EU_VAT') ?? '';
    const request = { vatNumber: vat };
    const answer = await checkVatNumber(vat, { force: true });

    if (answer.isValid === null) {
      return [
        {
          subject: 'EU_VAT',
          outcome: 'UNAVAILABLE',
          summary: `VIES could not answer: ${answer.unavailableReason ?? 'no reason given'}. Retry later or check by hand.`,
          request,
          sourceUrl: 'https://ec.europa.eu/taxation_customs/vies/',
        },
      ];
    }

    if (!answer.isValid) {
      return [
        {
          subject: 'EU_VAT',
          outcome: 'FAIL',
          summary: 'VIES says this VAT number is not active for intra-EU trade.',
          request,
          result: { valid: false },
          sourceReference: answer.consultationNumber,
        },
      ];
    }

    const registered =
      answer.registeredName === null ? '' : normaliseCompanyLegalName(answer.registeredName);
    const agrees =
      registered.length === 0 ? null : namesAgree(registered, applicationName(subject));

    return [
      {
        subject: 'EU_VAT',
        outcome: agrees === false ? 'INCONCLUSIVE' : 'PASS',
        summary:
          agrees === false
            ? `VAT number is active, but VIES registers it to "${answer.registeredName ?? ''}". VIES confirms VAT status only, not the whole company.`
            : agrees === null
              ? 'VAT number is active. The member state does not disclose the name. VIES confirms VAT status only, not the whole company.'
              : 'VAT number is active and registered to this name. VIES confirms VAT status only, not the whole company.',
        request,
        result: {
          valid: true,
          registeredName: answer.registeredName,
          registeredAddress: answer.registeredAddress,
        },
        sourceReference: answer.consultationNumber,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// GLEIF
// ---------------------------------------------------------------------------

export const gleifProvider: BusinessVerificationProvider = {
  key: 'GLEIF',
  label: 'GLEIF (LEI register)',
  appliesTo: (subject) => subject.identifiers.has('LEI'),
  async check(subject) {
    const lei = subject.identifiers.get('LEI') ?? '';
    const request = { lei };
    const sourceUrl = `https://search.gleif.org/#/record/${lei}`;
    const template = env.BUYER_COMPANY_GLEIF_URL.trim();
    if (template.length === 0) return [switchedOff('LEI', 'GLEIF', request, sourceUrl)];

    const response = await getRegistryJson(fillUrl(template, { lei }), 'GLEIF');

    if (response.kind === 'unavailable') {
      return [
        { subject: 'LEI', outcome: 'UNAVAILABLE', summary: response.reason, request, sourceUrl },
      ];
    }
    if (response.kind === 'not-found') {
      return [
        {
          subject: 'LEI',
          outcome: 'FAIL',
          summary: 'GLEIF has no record of this LEI.',
          request,
          sourceUrl,
        },
      ];
    }
    if (response.kind === 'rejected') {
      return [
        {
          subject: 'LEI',
          outcome: 'UNAVAILABLE',
          summary: `GLEIF refused the request (${String(response.status)}).`,
          request,
          sourceUrl,
        },
      ];
    }

    const attributes = (response.body as { data?: { attributes?: unknown } } | null)?.data
      ?.attributes;
    const legalName = field(attributes, 'entity', 'legalName', 'name');
    const entityStatus = field(attributes, 'entity', 'status');
    const registrationStatus = field(attributes, 'registration', 'status');
    const country = field(attributes, 'entity', 'legalAddress', 'country');
    const registeredAs = field(attributes, 'entity', 'registeredAs');

    const agrees =
      legalName === null
        ? false
        : namesAgree(normaliseCompanyLegalName(legalName), applicationName(subject));
    const active = entityStatus === 'ACTIVE';
    const countryAgrees =
      country === null ||
      subject.registrationCountry === null ||
      country === subject.registrationCountry;

    return [
      {
        subject: 'LEI',
        outcome: active && agrees && countryAgrees ? 'PASS' : 'INCONCLUSIVE',
        summary: active
          ? agrees && countryAgrees
            ? `LEI is active and registered to "${legalName ?? ''}".`
            : `LEI is active but registered to "${legalName ?? ''}" in ${country ?? '?'}.`
          : `LEI entity status is ${entityStatus ?? 'unknown'}.`,
        request,
        result: { legalName, entityStatus, registrationStatus, country, registeredAs },
        sourceUrl,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Poland: the VAT taxpayer register
// ---------------------------------------------------------------------------

/** What the VAT register says a NIP's status is, in English. */
const PL_VAT_STATUS: Record<string, string> = {
  Czynny: 'an active VAT payer',
  Zwolniony: 'registered but VAT-exempt',
};

export const plVatRegisterProvider: BusinessVerificationProvider = {
  key: 'PL_VAT_REGISTER',
  label: 'Poland - VAT taxpayer register (Ministry of Finance)',
  appliesTo: (subject) => subject.identifiers.has('PL_NIP'),
  async check(subject) {
    const nip = subject.identifiers.get('PL_NIP') ?? '';
    const request = { nip };
    const sourceUrl = 'https://www.podatki.gov.pl/wykaz-podatnikow-vat-wyszukiwarka';
    const template = env.BUYER_COMPANY_PL_VAT_URL.trim();
    if (template.length === 0)
      return [switchedOff('PL_NIP', 'Polish VAT register', request, sourceUrl)];

    const date = new Date().toISOString().slice(0, 10);
    const response = await getRegistryJson(fillUrl(template, { nip, date }), 'Polish VAT register');

    if (response.kind === 'unavailable') {
      return [
        { subject: 'PL_NIP', outcome: 'UNAVAILABLE', summary: response.reason, request, sourceUrl },
      ];
    }
    if (response.kind === 'not-found' || response.kind === 'rejected') {
      // WL-115 and friends: the register refused the number itself.
      const code = response.kind === 'rejected' ? field(response.body, 'code') : null;
      return [
        {
          subject: 'PL_NIP',
          outcome: 'FAIL',
          summary: `The Polish VAT register rejected this NIP${code === null ? '' : ` (${code})`}.`,
          request,
          sourceUrl,
        },
      ];
    }

    const result = (response.body as { result?: { subject?: unknown; requestId?: unknown } } | null)
      ?.result;
    const requestId = typeof result?.requestId === 'string' ? result.requestId.slice(0, 128) : null;
    const record = result?.subject ?? null;

    if (record === null) {
      // Not in the register is not the same as "no such NIP". A business that
      // was never VAT registered is legitimately absent.
      return [
        {
          subject: 'PL_NIP',
          outcome: 'INCONCLUSIVE',
          summary:
            'This NIP is not on the VAT register. That is normal for a business never registered for VAT; check CEIDG, KRS or REGON.',
          request,
          sourceReference: requestId,
          sourceUrl,
        },
      ];
    }

    // Kept: what verification needs. Dropped on purpose: `accountNumbers`
    // (bank accounts), `residenceAddress` (a sole trader's home), and the
    // names in `representatives`, `authorizedClerks` and `partners`.
    const name = field(record, 'name');
    const statusVat = field(record, 'statusVat');
    const kept = {
      name,
      statusVat,
      regon: field(record, 'regon'),
      krs: field(record, 'krs'),
      workingAddress: field(record, 'workingAddress'),
      registrationLegalDate: field(record, 'registrationLegalDate'),
      removalDate: field(record, 'removalDate'),
    };

    const agrees =
      name !== null && namesAgree(normaliseCompanyLegalName(name), applicationName(subject));
    const known = statusVat !== null && PL_VAT_STATUS[statusVat] !== undefined;

    const regonGiven = subject.identifiers.get('PL_REGON');
    const regonAgrees =
      regonGiven === undefined ||
      kept.regon === null ||
      kept.regon === regonGiven ||
      kept.regon.startsWith(regonGiven);

    return [
      {
        subject: 'PL_NIP',
        outcome: known && agrees && regonAgrees ? 'PASS' : 'INCONCLUSIVE',
        summary: known
          ? `NIP belongs to "${name ?? ''}", ${PL_VAT_STATUS[statusVat ?? ''] ?? ''}.${agrees ? '' : ' The name differs from the application.'}${regonAgrees ? '' : ' The REGON differs from the one given.'}`
          : `NIP belongs to "${name ?? ''}" with VAT status "${statusVat ?? 'unknown'}".`,
        request,
        result: kept,
        sourceReference: requestId,
        sourceUrl,
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Poland: the National Court Register
// ---------------------------------------------------------------------------

export const plKrsProvider: BusinessVerificationProvider = {
  key: 'PL_KRS',
  label: 'Poland - National Court Register (KRS)',
  appliesTo: (subject) =>
    subject.registrationNumber !== null &&
    registrationRegisterFor(subject.registrationCountry, subject.entityType) === 'PL_KRS',
  async check(subject) {
    const krs = subject.registrationNumber ?? '';
    const request = { krs };
    const sourceUrl = 'https://wyszukiwarka-krs.ms.gov.pl/';
    const template = env.BUYER_COMPANY_PL_KRS_URL.trim();
    if (template.length === 0) return [switchedOff('REGISTRATION', 'KRS', request, sourceUrl)];

    // Entrepreneurs are in register P; foundations and associations in S.
    let found: { body: unknown; register: string } | null = null;
    for (const register of ['P', 'S']) {
      const response = await getRegistryJson(fillUrl(template, { krs, register }), 'KRS');
      if (response.kind === 'unavailable') {
        return [
          {
            subject: 'REGISTRATION',
            outcome: 'UNAVAILABLE',
            summary: response.reason,
            request,
            sourceUrl,
          },
        ];
      }
      if (response.kind === 'ok') {
        found = { body: response.body, register };
        break;
      }
    }

    if (found === null) {
      return [
        {
          subject: 'REGISTRATION',
          outcome: 'FAIL',
          summary: 'KRS has no entry under this number in either register.',
          request,
          sourceUrl,
        },
      ];
    }

    const section = (
      found.body as { odpis?: { dane?: { dzial1?: unknown }; naglowekA?: unknown } } | null
    )?.odpis;
    const entity = section?.dane?.dzial1;
    const name = field(entity, 'danePodmiotu', 'nazwa');
    const legalForm = field(entity, 'danePodmiotu', 'formaPrawna');
    const nip = field(entity, 'danePodmiotu', 'identyfikatory', 'nip');
    const regon = field(entity, 'danePodmiotu', 'identyfikatory', 'regon');
    const city = field(entity, 'siedzibaIAdres', 'adres', 'miejscowosc');
    const postalCode = field(entity, 'siedzibaIAdres', 'adres', 'kodPocztowy');
    const street = field(entity, 'siedzibaIAdres', 'adres', 'ulica');
    const registeredOn = field(section?.naglowekA, 'dataRejestracjiWKRS');

    const agrees =
      name !== null && namesAgree(normaliseCompanyLegalName(name), applicationName(subject));
    const nipGiven = subject.identifiers.get('PL_NIP');
    const nipAgrees = nipGiven === undefined || nip === null || nip === nipGiven;

    return [
      {
        subject: 'REGISTRATION',
        outcome: agrees && nipAgrees ? 'PASS' : 'INCONCLUSIVE',
        summary: `KRS ${found.register === 'P' ? 'entrepreneurs' : 'associations'} register: "${name ?? ''}" (${legalForm ?? 'form not given'}), registered ${registeredOn ?? 'on an unknown date'}.${agrees ? '' : ' The name differs from the application.'}${nipAgrees ? '' : ' The NIP differs from the one given.'}`,
        request,
        // The extract also names the board and shareholders. Not stored: a
        // reviewer who needs them opens the register, which is where the
        // current version lives anyway.
        result: {
          name,
          legalForm,
          nip,
          regon,
          street,
          city,
          postalCode,
          registeredOn,
          register: found.register,
        },
        sourceUrl,
      },
    ];
  },
};
