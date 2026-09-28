/**
 * The registry providers, against a stubbed `fetch`: what each one records
 * when the register answers, says "no such entry", or cannot be reached - and
 * that the fields verification does not need are dropped before storing.
 *
 * Plus the three guards around the rest of the module: the document
 * inspector, the email catalogue, and the append-only audit tables.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { gleifProvider, plKrsProvider, plVatRegisterProvider } from '../../src/modules/buyer-companies/providers/registries.js';
import { MANUAL_PROVIDERS } from '../../src/modules/buyer-companies/providers/manual.js';
import type { CompanySubject } from '../../src/modules/buyer-companies/providers/types.js';
import { riskLevelFor } from '../../src/modules/buyer-companies/checks.service.js';
import { countPdfPages, inspectDocumentBytes } from '../../src/modules/buyer-companies/documents.service.js';
import {
  COMPANY_EMAIL_KINDS,
  COMPANY_EMAIL_LANGUAGES,
  companyApplicationUrl,
  renderCompanyEmail,
} from '../../src/modules/buyer-companies/notifications.js';

const subject = (overrides: Partial<CompanySubject> = {}): CompanySubject => ({
  companyId: '01TESTCOMPANY0000000000000',
  legalName: 'Polskie Koleje Państwowe S.A.',
  tradingName: null,
  entityType: 'PUBLIC_LIMITED_COMPANY',
  registrationCountry: 'PL',
  registrationNumber: '0000019193',
  identifiers: new Map([['PL_NIP', '5250000251'], ['LEI', '5493001KJTIIGC8Y1R12']]),
  ...overrides,
});

function respond(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function withUrls(): void {
  vi.spyOn(env, 'BUYER_COMPANY_PL_VAT_URL', 'get').mockReturnValue('https://vat.test/{nip}?date={date}');
  vi.spyOn(env, 'BUYER_COMPANY_PL_KRS_URL', 'get').mockReturnValue('https://krs.test/{krs}?r={register}');
  vi.spyOn(env, 'BUYER_COMPANY_GLEIF_URL', 'get').mockReturnValue('https://gleif.test/{lei}');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Polish VAT register', () => {
  it('passes an active VAT payer whose name matches, and drops bank accounts and people', async () => {
    withUrls();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(200, {
      result: {
        requestId: 'abc-123',
        subject: {
          name: 'POLSKIE KOLEJE PAŃSTWOWE SPÓŁKA AKCYJNA',
          statusVat: 'Czynny',
          regon: '00012680100000',
          krs: '0000019193',
          workingAddress: 'ALEJE JEROZOLIMSKIE 142A, 02-305 WARSZAWA',
          residenceAddress: 'somebody’s home',
          accountNumbers: ['18101014690032611391200000'],
          representatives: [{ firstName: 'Jan', lastName: 'Kowalski' }],
        },
      },
    }))));

    const [row] = await plVatRegisterProvider.check(subject());
    expect(row?.outcome).toBe('PASS');
    expect(row?.sourceReference).toBe('abc-123');
    const stored = JSON.stringify(row?.result);
    expect(stored).not.toContain('18101014690032611391200000');
    expect(stored).not.toContain('Kowalski');
    expect(stored).not.toContain('home');
  });

  it('calls a NIP absent from the register inconclusive, not failed', async () => {
    withUrls();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(200, { result: { subject: null, requestId: 'x' } }))));
    const [row] = await plVatRegisterProvider.check(subject());
    expect(row?.outcome).toBe('INCONCLUSIVE');
  });

  it('fails a NIP the register itself rejects', async () => {
    withUrls();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(400, { code: 'WL-115', message: 'Nieprawidłowy NIP.' }))));
    const [row] = await plVatRegisterProvider.check(subject());
    expect(row?.outcome).toBe('FAIL');
  });

  it('never fails because the register is down or answers with HTML', async () => {
    withUrls();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('ECONNRESET'))));
    expect((await plVatRegisterProvider.check(subject()))[0]?.outcome).toBe('UNAVAILABLE');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(503, 'Service unavailable'))));
    expect((await plVatRegisterProvider.check(subject()))[0]?.outcome).toBe('UNAVAILABLE');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('<html>proxy</html>', { status: 200 }))));
    expect((await plVatRegisterProvider.check(subject()))[0]?.outcome).toBe('UNAVAILABLE');
  });

  it('becomes a manual check when switched off', async () => {
    vi.spyOn(env, 'BUYER_COMPANY_PL_VAT_URL', 'get').mockReturnValue('');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    expect((await plVatRegisterProvider.check(subject()))[0]?.outcome).toBe('MANUAL_REQUIRED');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('KRS', () => {
  it('tries the entrepreneurs register, then associations, and fails only when neither has it', async () => {
    withUrls();
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('', { status: 404 })));
    vi.stubGlobal('fetch', fetchSpy);
    const [row] = await plKrsProvider.check(subject());
    expect(row?.outcome).toBe('FAIL');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('passes a matching entry and flags a NIP that differs', async () => {
    withUrls();
    const extract = (nip: string): unknown => ({
      odpis: {
        naglowekA: { dataRejestracjiWKRS: '11.06.2001' },
        dane: { dzial1: { danePodmiotu: { nazwa: 'POLSKIE KOLEJE PAŃSTWOWE SPÓŁKA AKCYJNA', formaPrawna: 'SPÓŁKA AKCYJNA', identyfikatory: { nip, regon: '00012680100000' } }, siedzibaIAdres: { adres: { miejscowosc: 'WARSZAWA' } } } },
      },
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(200, extract('5250000251')))));
    expect((await plKrsProvider.check(subject()))[0]?.outcome).toBe('PASS');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(respond(200, extract('1111111111')))));
    expect((await plKrsProvider.check(subject()))[0]?.outcome).toBe('INCONCLUSIVE');
  });

  it('applies only to KRS-registered legal forms', () => {
    expect(plKrsProvider.appliesTo(subject())).toBe(true);
    expect(plKrsProvider.appliesTo(subject({ entityType: 'SOLE_PROPRIETORSHIP' }))).toBe(false);
    expect(plKrsProvider.appliesTo(subject({ registrationCountry: 'DE' }))).toBe(false);
  });
});

describe('GLEIF', () => {
  it('fails an unknown LEI and is unavailable when unreachable', async () => {
    withUrls();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 404 }))));
    expect((await gleifProvider.check(subject()))[0]?.outcome).toBe('FAIL');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('timeout'))));
    expect((await gleifProvider.check(subject()))[0]?.outcome).toBe('UNAVAILABLE');
  });
});

describe('manual-review providers', () => {
  it('say "check by hand" with an official link, and call nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const india = subject({
      registrationCountry: 'IN',
      entityType: 'PRIVATE_LIMITED_COMPANY',
      registrationNumber: 'U12345MH2020PTC123456',
      identifiers: new Map([['IN_GSTIN', '27AAPFU0939F1ZV'], ['IN_PAN', 'AAPFU0939F']]),
    });
    const rows = (await Promise.all(MANUAL_PROVIDERS.filter((provider) => provider.appliesTo(india)).map((provider) => provider.check(india)))).flat();
    expect(rows.map((row) => row.subject).sort()).toEqual(['IN_GSTIN', 'IN_PAN', 'REGISTRATION']);
    for (const row of rows) {
      expect(row.outcome).toBe('MANUAL_REQUIRED');
      expect(row.sourceUrl).toMatch(/^https:\/\/[^/]*gov\.in\//);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('risk level', () => {
  it('is HIGH for a failed check or an approved duplicate, and never approves anything', () => {
    expect(riskLevelFor([{ outcome: 'FAIL', provider: 'PL_KRS', result: null }])).toBe('HIGH');
    expect(riskLevelFor([{ outcome: 'SIGNAL', provider: 'DUPLICATES', result: { matches: [{ status: 'APPROVED' }] } }])).toBe('HIGH');
    expect(riskLevelFor([{ outcome: 'SIGNAL', provider: 'DUPLICATES', result: { matches: [{ status: 'DRAFT' }] } }])).toBe('ELEVATED');
    expect(riskLevelFor([{ outcome: 'UNAVAILABLE', provider: 'VIES', result: null }])).toBe('LOW');
    expect(riskLevelFor([{ outcome: 'PASS', provider: 'VIES', result: null }])).toBe('NONE');
  });
});

describe('document inspection', () => {
  const pdf = (body: string): Buffer => Buffer.from(`%PDF-1.7\n${body}\n%%EOF\n`, 'latin1');
  const png = (extra = ''): Buffer =>
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR....IDAT....'), Buffer.from('IEND'), Buffer.from([0xae, 0x42, 0x60, 0x82]), Buffer.from(extra)]);

  it('accepts a plain PDF and counts its pages', () => {
    expect(inspectDocumentBytes(pdf('1 0 obj << /Type /Page >> 2 0 obj << /Type /Page >> 3 0 obj << /Type /Pages >>'), 'application/pdf').pageCount).toBe(2);
    expect(countPdfPages('<< /Type /Pages /Kids [] >>')).toBeNull();
  });

  it('refuses a PDF with JavaScript, a launch action or an embedded file', () => {
    for (const bad of ['/JavaScript (app.alert(1))', '/Launch << /F (cmd.exe) >>', '/EmbeddedFile', '/OpenAction << /S /JS /JS (x) >>']) {
      expect(() => inspectDocumentBytes(pdf(bad), 'application/pdf'), bad).toThrow();
    }
  });

  it('refuses a PDF with too many pages, and a truncated one', () => {
    const pages = Array.from({ length: env.BUYER_COMPANY_DOCUMENT_MAX_PAGES + 1 }, () => '<< /Type /Page >>').join(' ');
    expect(() => inspectDocumentBytes(pdf(pages), 'application/pdf')).toThrow();
    expect(() => inspectDocumentBytes(Buffer.from('%PDF-1.7 truncated'), 'application/pdf')).toThrow();
  });

  it('refuses an image with a ZIP or markup hidden in it or after it', () => {
    expect(inspectDocumentBytes(png(), 'image/png').pageCount).toBe(1);
    expect(() => inspectDocumentBytes(png('PK\u0003\u0004payload-after-the-image'), 'image/png')).toThrow();
    expect(() => inspectDocumentBytes(png('<script>alert(1)</script>'), 'image/png')).toThrow();
    expect(() => inspectDocumentBytes(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from('<svg onload=x>'), Buffer.from([0xff, 0xd9])]), 'image/jpeg')).toThrow();
  });
});

describe('company emails', () => {
  const words = { name: 'Ada', company: 'Acme', reference: 'BC-TEST0001', url: companyApplicationUrl('01COMPANY'), code: '123456', email: 'a@acme.pl', reason: 'Please send the KRS extract.', canResubmit: true };

  it('exist for every kind in all eight languages', () => {
    expect(COMPANY_EMAIL_LANGUAGES.sort()).toEqual(['de', 'el', 'en', 'es', 'fr', 'it', 'nl', 'pl']);
    for (const language of COMPANY_EMAIL_LANGUAGES) {
      for (const kind of COMPANY_EMAIL_KINDS) {
        const message = renderCompanyEmail(language, kind, words);
        expect(message.subject.length, `${language}/${kind}`).toBeGreaterThan(0);
        expect(message.body, `${language}/${kind}`).toContain(kind === 'EMAIL_CODE' ? '123456' : 'Acme');
      }
    }
  });

  it('link to the signed-in application page by opaque id only', () => {
    expect(words.url).toMatch(/\/account\/companies\/01COMPANY$/);
  });

  it('falls back to English for an unknown language', () => {
    expect(renderCompanyEmail('xx', 'APPROVED', words).subject).toBe('Acme is verified');
  });
});

describe('the audit tables are append-only', () => {
  /** Every .ts file under src, excluding the generated client. */
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (entry === 'generated') return [];
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('has no code that updates or deletes a review event, a status-history row, a check or a consent', () => {
    const offenders: string[] = [];
    const pattern = /\.(buyerCompanyReviewEvent|buyerCompanyStatusHistory|buyerCompanyCheck)\.(update|updateMany|delete|deleteMany|upsert)\(/;
    const consent = /\.consentRecord\.(update|delete|deleteMany|upsert)\(/;
    for (const file of sources(join(__dirname, '../../src'))) {
      const text = readFileSync(file, 'utf8');
      if (pattern.test(text) || consent.test(text)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
