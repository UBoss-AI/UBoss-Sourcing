/**
 * The Tally XML layer: what it builds, what it reads, and what it refuses.
 *
 * TWO FAILURES THIS FILE EXISTS TO PIN DOWN
 *
 * 1. **XXE.** The payloads come from a seller's own machine through a bridge.
 *    A general XML parser brings doctype handling and entity expansion with
 *    it, and a response carrying `<!ENTITY e SYSTEM "file:///etc/passwd">`
 *    reads a file off this server and hands it back. The parser here has no
 *    doctype support at all and refuses the whole document rather than
 *    stripping the declaration - and the tests below are what keeps that true
 *    if somebody later swaps in a library.
 *
 * 2. **HTTP 200 as success.** Tally answers 200 to a request it rejected
 *    completely. A client that trusts the status code marks a month of
 *    vouchers posted when none were, and the seller finds out at the quarter
 *    end. `assertTallyAccepted` is the guard and these are its tests.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_XML_BYTES,
  element,
  escapeXml,
  findAll,
  findNode,
  intOf,
  parseXml,
  tallyAmount,
  tallyDate,
  textOf,
  wrap,
} from '../../src/modules/seller-erp/tally/xml.js';
import {
  assertTallyAccepted,
  parseTallyDate,
  readCompanies,
  readMasters,
  readTallyResponse,
} from '../../src/modules/seller-erp/tally/response.js';
import {
  companyListRequest,
  importRequest,
  masterListRequest,
  voucher,
} from '../../src/modules/seller-erp/tally/requests.js';
import { AppError, ErrorCode } from '../../src/domain/errors.js';

describe('escaping', () => {
  it('escapes all five, including the apostrophe', () => {
    // The apostrophe matters because the same function serves attributes, and
    // an unescaped one inside a single-quoted attribute closes it.
    expect(escapeXml(`Acme & Co <Ltd> "the" 'one'`)).toBe(
      'Acme &amp; Co &lt;Ltd&gt; &quot;the&quot; &apos;one&apos;',
    );
  });

  it('drops control characters XML 1.0 cannot represent', () => {
    // `&#x0;` is not valid XML. A numeric escape of it produces a document
    // Tally rejects with a message about the document rather than about the
    // ledger, which is the least useful error a seller can be handed.
    expect(escapeXml('Acme\u0000Ltd')).toBe('AcmeLtd');
    expect(escapeXml('Acme\u0007Ltd')).toBe('AcmeLtd');
  });

  it('leaves a newline and a tab alone', () => {
    expect(escapeXml('a\nb\tc')).toBe('a\nb\tc');
  });

  it('survives a round trip with a ledger name that needs escaping', () => {
    const name = `Smith & Sons <Medical> "Pvt" Ltd`;
    const xml = element('LEDGERNAME', name);
    const parsed = parseXml(xml);

    expect(textOf(parsed, 'LEDGERNAME')).toBe(name);
  });

  it('refuses to write a tag name that is not one', () => {
    // These are constants in this repository, never values from a request. A
    // "tag name" that needed escaping would be somebody having found a way to
    // put a request body where a constant belongs.
    expect(() => element('LEDGER NAME', 'x')).toThrow();
    expect(() => element('<script>', 'x')).toThrow();
    expect(() => wrap('9BAD', 'x')).toThrow();
    expect(() => element('A"B', 'x')).toThrow();
    expect(() => element("A'B", 'x')).toThrow();
  });

  it('allows one namespace colon and no more', () => {
    // Tally's user-defined fields really are called `UDF:GLOVIAPACKAGING`, so
    // banning the colon outright would mean no user-defined field could be
    // written. The relaxation is bounded to exactly one, never leading and
    // never trailing, so it cannot be used to smuggle anything.
    expect(() => element('UDF:GLOVIAPACKAGING', 'x')).not.toThrow();
    expect(() => element(':LEADING', 'x')).toThrow();
    expect(() => element('TRAILING:', 'x')).toThrow();
    expect(() => element('A:B:C', 'x')).toThrow();
  });
});

describe('amounts and dates', () => {
  it('renders minor units without touching a float', () => {
    expect(tallyAmount(1_234_567n, 2)).toBe('12345.67');
    expect(tallyAmount(100n, 2)).toBe('1.00');
    expect(tallyAmount(5n, 2)).toBe('0.05');
    expect(tallyAmount(0n, 2)).toBe('0.00');
  });

  it('keeps a sign on a credit', () => {
    expect(tallyAmount(-1_234_567n, 2)).toBe('-12345.67');
  });

  it('handles a currency with no minor unit at all', () => {
    expect(tallyAmount(1234n, 0)).toBe('1234');
  });

  it('holds a figure far beyond what a JS number would', () => {
    expect(tallyAmount(12_345_678_901_234_567n, 2)).toBe('123456789012345.67');
  });

  it('builds a Tally date from the UTC parts', () => {
    // UTC deliberately: reading local parts would post a voucher a day early
    // for any seller east of Greenwich after their evening cut-off.
    expect(tallyDate(new Date('2026-09-23T00:30:00Z'))).toBe('20260923');
    expect(tallyDate(new Date('2026-01-05T23:59:59Z'))).toBe('20260105');
  });

  it('reads one back the same way', () => {
    const parsed = parseTallyDate('20260401');
    expect(parsed?.toISOString().slice(0, 10)).toBe('2026-04-01');
    expect(parseTallyDate('nonsense')).toBeNull();
    expect(parseTallyDate(null)).toBeNull();
  });
});

describe('the parser refuses what it must', () => {
  it('refuses a document type declaration outright', () => {
    const hostile =
      '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><ENVELOPE><A>&xxe;</A></ENVELOPE>';

    expect(() => parseXml(hostile)).toThrow(AppError);

    try {
      parseXml(hostile);
    } catch (error) {
      expect((error as AppError).code).toBe(ErrorCode.SELLER_ERP_RESPONSE_INVALID);
    }
  });

  it('refuses a lower-case doctype too', () => {
    expect(() => parseXml('<!doctype x><A/>')).toThrow(AppError);
  });

  it('refuses a doctype with whitespace after the bang', () => {
    expect(() => parseXml('<!  DOCTYPE x><A/>')).toThrow(AppError);
  });

  it('refuses a bare entity declaration even without a doctype', () => {
    expect(() => parseXml('<!ENTITY x "y"><A/>')).toThrow(AppError);
  });

  it('refuses the billion-laughs shape, which needs no external access', () => {
    const laughs =
      '<!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><lolz>&lol2;</lolz>';

    expect(() => parseXml(laughs)).toThrow(AppError);
  });

  it('never expands an undeclared entity into anything', () => {
    // Without a declaration there is nothing to expand, and this parser has no
    // mechanism to add one. The reference is left as written.
    const parsed = parseXml('<A>&xxe;</A>');
    expect(textOf(parsed, 'A')).toBe('&xxe;');
  });

  it('refuses a document larger than it will read', () => {
    const huge = `<A>${'x'.repeat(MAX_XML_BYTES + 1)}</A>`;
    expect(() => parseXml(huge)).toThrow(AppError);
  });

  it('refuses nesting engineered to blow the stack', () => {
    const deep = '<A>'.repeat(200) + '</A>'.repeat(200);
    expect(() => parseXml(deep)).toThrow(AppError);
  });

  it('refuses a mismatched close rather than tolerating it', () => {
    // Tolerating it - popping until something matches - is how a truncated
    // response gets read as a complete one with fewer vouchers in it.
    expect(() => parseXml('<A><B></A></B>')).toThrow(AppError);
  });

  it('refuses a truncated document', () => {
    expect(() => parseXml('<ENVELOPE><BODY>')).toThrow(AppError);
  });

  it('refuses unterminated constructs', () => {
    expect(() => parseXml('<A><!-- never closed</A>')).toThrow(AppError);
    expect(() => parseXml('<A><![CDATA[never closed</A>')).toThrow(AppError);
  });
});

describe('the parser reads what it should', () => {
  it('reads nested elements, attributes and text', () => {
    const parsed = parseXml(
      '<?xml version="1.0"?><ENVELOPE><VOUCHER VCHTYPE="Sales"><AMOUNT>120.50</AMOUNT></VOUCHER></ENVELOPE>',
    );

    const voucherNode = findNode(parsed, 'VOUCHER');
    expect(voucherNode?.attributes.VCHTYPE).toBe('Sales');
    expect(textOf(parsed, 'AMOUNT')).toBe('120.50');
  });

  it('finds a tag whatever case Tally used', () => {
    // The same installation answers <LINEERROR> and <LineError> depending on
    // which report produced it. A case-sensitive lookup silently finds nothing
    // and reports a clean success.
    const parsed = parseXml('<R><LineError>Ledger missing</LineError></R>');
    expect(textOf(parsed, 'LINEERROR')).toBe('Ledger missing');
  });

  it('reads CDATA literally, without decoding it again', () => {
    const parsed = parseXml('<A><![CDATA[a & b < c]]></A>');
    expect(textOf(parsed, 'A')).toBe('a & b < c');
  });

  it('decodes numeric references, which Tally emits for accented names', () => {
    const parsed = parseXml('<A>Caf&#233; M&#xE9;dical</A>');
    expect(textOf(parsed, 'A')).toBe('Café Médical');
  });

  it('leaves a lone surrogate alone rather than producing one', () => {
    const parsed = parseXml('<A>&#xD800;</A>');
    expect(textOf(parsed, 'A')).toBe('&#xD800;');
  });

  it('handles self-closing elements', () => {
    const parsed = parseXml('<R><A/><B>x</B></R>');
    expect(findAll(parsed, 'A')).toHaveLength(1);
    expect(textOf(parsed, 'B')).toBe('x');
  });

  it('tells a missing counter apart from a zero one', () => {
    const present = parseXml('<R><CREATED>0</CREATED></R>');
    const absent = parseXml('<R></R>');

    // The difference decides whether a job that created nothing is reported as
    // a success.
    expect(intOf(present, 'CREATED')).toBe(0);
    expect(intOf(absent, 'CREATED')).toBeNull();
  });
});

describe('reading a Tally response', () => {
  const ok = `<RESPONSE><CREATED>1</CREATED><ALTERED>0</ALTERED><IGNORED>0</IGNORED><ERRORS>0</ERRORS><EXCEPTIONS>0</EXCEPTIONS><LASTVCHID>4821</LASTVCHID></RESPONSE>`;

  it('accepts a response that actually created something', () => {
    const response = readTallyResponse(ok);

    expect(response.created).toBe(1);
    expect(response.lastVoucherId).toBe('4821');
    expect(() => {
      assertTallyAccepted(response, { expectsWrite: true });
    }).not.toThrow();
  });

  /*
   * THE ONE THIS FILE IS FOR.
   *
   * HTTP 200, well-formed XML, no exception anywhere a naive client would
   * look - and nothing was written. A client that trusts the status code marks
   * the job done and the seller's sales never reach their books.
   */
  it('refuses a 200 that carries a Tally-level error', () => {
    const refused = `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><IGNORED>0</IGNORED><ERRORS>1</ERRORS><EXCEPTIONS>0</EXCEPTIONS><LINEERROR>Ledger 'Acme Hospitals' does not exist!</LINEERROR></RESPONSE>`;

    const response = readTallyResponse(refused);
    expect(response.errors).toBe(1);
    expect(response.lineErrors[0]?.message).toContain('Acme Hospitals');
    // And it names the master, so the screen can link to the mapping row.
    expect(response.lineErrors[0]?.missingMaster).toBe('Acme Hospitals');

    expect(() => {
      assertTallyAccepted(response, { expectsWrite: true });
    }).toThrow(AppError);
  });

  it('refuses a 200 that wrote nothing at all and reported no error', () => {
    // What Tally does when the company is closed between the check and the
    // post. Accepting it would report a silent no-op as a success.
    const empty = `<RESPONSE><CREATED>0</CREATED><ALTERED>0</ALTERED><IGNORED>1</IGNORED><ERRORS>0</ERRORS></RESPONSE>`;

    expect(() => {
      assertTallyAccepted(readTallyResponse(empty), { expectsWrite: true });
    }).toThrow(AppError);
  });

  it('accepts an empty READ, because an empty company is a real company', () => {
    const empty = `<RESPONSE><CREATED>0</CREATED><ERRORS>0</ERRORS></RESPONSE>`;

    // Refusing this would make a brand new Tally company impossible to set up.
    expect(() => {
      assertTallyAccepted(readTallyResponse(empty), { expectsWrite: false });
    }).not.toThrow();
  });

  it('refuses a per-line failure even without a counter to match', () => {
    // Some builds report one and not the other.
    const partial = `<RESPONSE><CREATED>2</CREATED><ERRORS>0</ERRORS><LINEERROR>Stock item 'Gloves L' not found</LINEERROR></RESPONSE>`;

    expect(() => {
      assertTallyAccepted(readTallyResponse(partial), { expectsWrite: true });
    }).toThrow(AppError);
  });

  it('collects every shape Tally uses to report a rejection', () => {
    const many = `<RESPONSE><ERRORS>3</ERRORS><LINEERROR>one</LINEERROR><ERRORMSG>two</ERRORMSG><EXCEPTIONMSG>three</EXCEPTIONMSG></RESPONSE>`;

    const response = readTallyResponse(many);
    expect(response.lineErrors.map((error) => error.message)).toEqual(['one', 'two', 'three']);
  });

  it('strips the seller own file paths out of a message', () => {
    // Tally quotes `C:\Users\accounts\Tally\Data\0001\…`. That is the seller's
    // file system, it says nothing about the failure, and it does not belong
    // in a row the marketplace support desk reads.
    const withPath = `<RESPONSE><ERRORS>1</ERRORS><LINEERROR>Could not open C:\\Users\\accounts\\Tally\\Data\\0001\\Company.900 for writing</LINEERROR></RESPONSE>`;

    const response = readTallyResponse(withPath);
    expect(response.lineErrors[0]?.message).not.toContain('Users');
    expect(response.lineErrors[0]?.message).toContain('[path]');
  });

  it('caps how many rejections it will keep', () => {
    const errors = Array.from({ length: 60 }, (_, index) => `<LINEERROR>e${String(index)}</LINEERROR>`).join('');
    const response = readTallyResponse(`<RESPONSE><ERRORS>60</ERRORS>${errors}</RESPONSE>`);

    // The COUNT is still honest; the list is capped so a broken reply cannot
    // fill a JSON column.
    expect(response.errors).toBe(60);
    expect(response.lineErrors).toHaveLength(20);
  });

  it('hashes the body rather than keeping it', () => {
    const response = readTallyResponse(ok);

    expect(response.responseHash).toMatch(/^[0-9a-f]{64}$/);
    // Deterministic, so two attempts sending the same thing are provably the
    // same without a financial document sitting in a diagnostics table.
    expect(readTallyResponse(ok).responseHash).toBe(response.responseHash);
  });

  it('refuses a malformed body before any of that', () => {
    expect(() => readTallyResponse('<RESPONSE><CREATED>1')).toThrow(AppError);
  });
});

describe('reading masters and companies', () => {
  it('reads the open companies, deduplicated', () => {
    const xml = `<ENVELOPE><COMPANY><NAME>Acme Medical</NAME><STARTINGFROM>20250401</STARTINGFROM></COMPANY><COMPANY><NAME>Acme Medical</NAME></COMPANY><COMPANY><NAME>Acme Exports</NAME></COMPANY></ENVELOPE>`;

    const companies = readCompanies(parseXml(xml));

    expect(companies.map((company) => company.name)).toEqual(['Acme Medical', 'Acme Exports']);
    expect(companies[0]?.booksFrom?.toISOString().slice(0, 10)).toBe('2025-04-01');
  });

  it('reads ledgers with their group, which is what makes a list of four hundred usable', () => {
    const xml = `<ENVELOPE><LEDGER NAME="Acme Hospitals"><PARENT>Sundry Debtors</PARENT><GUID>abc-123</GUID></LEDGER></ENVELOPE>`;

    const masters = readMasters(parseXml(xml), 'LEDGER');

    expect(masters[0]?.name).toBe('Acme Hospitals');
    expect(masters[0]?.parent).toBe('Sundry Debtors');
    expect(masters[0]?.guid).toBe('abc-123');
  });

  it('takes the name from a child element where the attribute is absent', () => {
    const xml = `<ENVELOPE><STOCKITEM><NAME>Nitrile Gloves L</NAME><BASEUNITS>Nos</BASEUNITS></STOCKITEM></ENVELOPE>`;

    const masters = readMasters(parseXml(xml), 'STOCKITEM');
    expect(masters[0]?.name).toBe('Nitrile Gloves L');
    expect(masters[0]?.extra.BASEUNITS).toBe('Nos');
  });
});

describe('the requests it builds', () => {
  it('asks for the company list without naming a company', () => {
    // It is the request that finds out what the companies ARE.
    const xml = companyListRequest();

    expect(xml).toContain('<TALLYREQUEST>Export</TALLYREQUEST>');
    expect(xml).toContain('List of Companies');
    expect(xml).not.toContain('SVCURRENTCOMPANY');
  });

  it('names the company on every other request', () => {
    // Omitting it makes Tally use whichever company is in front, which on a
    // machine with two open - ordinary at a year boundary - posts a month of
    // sales into the wrong books.
    const xml = masterListRequest('LEDGER', 'Acme Medical');

    expect(xml).toContain('<SVCURRENTCOMPANY>Acme Medical</SVCURRENTCOMPANY>');
  });

  it('escapes a company name that needs it', () => {
    const xml = masterListRequest('LEDGER', 'Smith & Sons <Pvt>');

    expect(xml).toContain('Smith &amp; Sons &lt;Pvt&gt;');
    // And the escaped form parses back to the original.
    expect(textOf(parseXml(xml), 'SVCURRENTCOMPANY')).toBe('Smith & Sons <Pvt>');
  });

  describe('a voucher', () => {
    const line = {
      stockItemName: 'Nitrile Gloves L',
      baseQuantity: 2400,
      baseUnitName: 'Nos',
      alternateUnit: null,
      amountMinor: 1_200_000n,
      rateMinor: 500n,
      currencyExponent: 2,
      godownName: 'Main Godown',
      batchName: null,
      salesLedgerName: 'Sales - Marketplace',
      packagingDescription: '2 UK pallets x 50 cartons x 24 units = 2,400 units',
    };

    it('posts the BASE unit quantity, not the package count', () => {
      const xml = voucher({
        voucherTypeName: 'Sales',
        remoteId: 'GLOVIA-SALES_INVOICE-01ABC',
        voucherNumber: 'SO-00042',
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme Hospitals',
        reference: 'ORD-1001',
        narration: 'Glovia order ORD-1001',
        lines: [line],
        ledgerEntries: [],
        isInvoice: true,
      });

      // THE LINE. 2,400 - the units that leave the warehouse - and never 2.
      expect(xml).toContain('<ACTUALQTY>2400 Nos</ACTUALQTY>');
      expect(xml).toContain('<BILLEDQTY>2400 Nos</BILLEDQTY>');
      expect(xml).not.toContain('>2 Nos<');
    });

    it('carries the packaging as words beside the figure', () => {
      const xml = voucher({
        voucherTypeName: 'Sales',
        remoteId: 'x',
        voucherNumber: null,
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme Hospitals',
        reference: null,
        narration: null,
        lines: [line],
        ledgerEntries: [],
        isInvoice: true,
      });

      // 2,400 on its own is a number. 2,400 with the arithmetic beside it is a
      // figure an accountant can verify.
      expect(xml).toContain('2 UK pallets x 50 cartons x 24 units');
    });

    it('posts in a mapped alternate unit while still stating the base count', () => {
      const xml = voucher({
        voucherTypeName: 'Sales',
        remoteId: 'x',
        voucherNumber: null,
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme Hospitals',
        reference: null,
        narration: null,
        lines: [{ ...line, alternateUnit: { name: 'PLT', quantity: 2, factor: 1200 } }],
        ledgerEntries: [],
        isInvoice: true,
      });

      // Both, always. The base figure never disappears.
      expect(xml).toContain('2 PLT = 2400 Nos');
    });

    it('carries a REMOTEID so Tally itself refuses a second copy', () => {
      const xml = voucher({
        voucherTypeName: 'Sales',
        remoteId: 'GLOVIA-SALES_INVOICE-01ABC',
        voucherNumber: null,
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme Hospitals',
        reference: null,
        narration: null,
        lines: [line],
        ledgerEntries: [],
        isInvoice: true,
      });

      expect(xml).toContain('REMOTEID="GLOVIA-SALES_INVOICE-01ABC"');
    });

    it('sums its ledger entries to zero, with Tally sign convention', () => {
      const xml = voucher({
        voucherTypeName: 'Sales',
        remoteId: 'x',
        voucherNumber: null,
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme Hospitals',
        reference: null,
        narration: null,
        lines: [],
        ledgerEntries: [
          {
            ledgerName: 'Acme Hospitals',
            isDeemedPositive: true,
            amountMinor: 1_416_000n,
            currencyExponent: 2,
          },
          {
            ledgerName: 'Sales - Marketplace',
            isDeemedPositive: false,
            amountMinor: -1_200_000n,
            currencyExponent: 2,
          },
          {
            ledgerName: 'IGST',
            isDeemedPositive: false,
            amountMinor: -216_000n,
            currencyExponent: 2,
          },
        ],
        isInvoice: true,
      });

      // `isDeemedPositive = Yes` means a DEBIT, which is the opposite of
      // intuition and the thing most likely to be got backwards.
      expect(xml).toContain('<ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>');
      expect(xml).toContain('<AMOUNT>14160.00</AMOUNT>');
      expect(xml).toContain('<AMOUNT>-12000.00</AMOUNT>');
      expect(xml).toContain('<AMOUNT>-2160.00</AMOUNT>');
    });

    it('does not mark a Sales Order as an invoice', () => {
      const xml = voucher({
        voucherTypeName: 'Sales Order',
        remoteId: 'x',
        voucherNumber: null,
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme Hospitals',
        reference: null,
        narration: null,
        lines: [line],
        ledgerEntries: [],
        isInvoice: false,
      });

      // `ISINVOICE=Yes` on an order voucher puts it in the books as a sale,
      // which overstates turnover by every order later cancelled.
      expect(xml).toContain('<ISINVOICE>No</ISINVOICE>');
    });

    it('produces a document the parser reads back', () => {
      const inner = voucher({
        voucherTypeName: 'Sales',
        remoteId: 'x',
        voucherNumber: 'SO-1',
        date: new Date('2026-09-23T10:00:00Z'),
        partyLedgerName: 'Acme & Sons',
        reference: null,
        narration: null,
        lines: [line],
        ledgerEntries: [],
        isInvoice: true,
      });

      const xml = importRequest({
        companyName: 'Acme Medical',
        reportName: 'Vouchers',
        messages: inner,
      });

      const parsed = parseXml(xml);
      expect(textOf(parsed, 'PARTYLEDGERNAME')).toBe('Acme & Sons');
      expect(textOf(parsed, 'VOUCHERNUMBER')).toBe('SO-1');
    });
  });
});
