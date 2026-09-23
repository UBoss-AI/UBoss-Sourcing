/**
 * Reading what Tally actually said.
 *
 * THE ONE THING THIS FILE EXISTS TO PREVENT
 *
 * Tally answers HTTP 200 to a request it rejected completely. Post a voucher
 * naming a ledger that does not exist and the transport is a clean success -
 * status 200, well-formed XML, no error anywhere a naive client would look -
 * and the body says:
 *
 *     <RESPONSE>
 *       <CREATED>0</CREATED><ALTERED>0</ALTERED><IGNORED>0</IGNORED>
 *       <ERRORS>1</ERRORS><EXCEPTIONS>0</EXCEPTIONS>
 *       <LINEERROR>Ledger 'Acme Hospitals' does not exist!</LINEERROR>
 *     </RESPONSE>
 *
 * A client that treats 200 as success marks the job done, never retries, and
 * the seller discovers at the end of the quarter that a month of sales is not
 * in their books. That is the single most common way an ERP integration fails
 * silently, and every function here is shaped to make it impossible: a job is
 * successful only when the counters say something was created or altered AND
 * nothing errored.
 *
 * WHAT IS NEVER KEPT
 *
 * The body. A Tally response to a voucher post contains a customer's name, a
 * delivery address and a complete financial document. None of it is written to
 * a log, an attempt row or an error message. What IS kept is a SHA-256 of the
 * request and of the response - enough to prove two attempts sent the same
 * thing and to match a support question against a timestamp, without a
 * financial record sitting in a diagnostics table. Line errors are kept
 * because a seller has to be told which line failed and why, and they are
 * truncated and stripped of anything that looks like a path first.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, conflict } from '../../../domain/errors.js';
import { findAll, findNode, intOf, parseXml, textOf, type XmlNode } from './xml.js';

/** One rejection Tally reported, safe to show a seller. */
export interface TallyLineError {
  /** Tally's own wording, redacted and capped. */
  message: string;
  /** Which of our lines it was about, where the reply says. */
  lineNumber: number | null;
  /** The master Tally could not find, where the message names one. */
  missingMaster: string | null;
}

/** Everything a job needs to decide whether it worked. */
export interface TallyResponse {
  created: number | null;
  altered: number | null;
  deleted: number | null;
  ignored: number | null;
  errors: number | null;
  exceptions: number | null;
  /** Tally's own id for the last voucher it wrote, where it reported one. */
  lastVoucherId: string | null;
  /** The voucher number it assigned, where the reply carries one. */
  voucherNumber: string | null;
  /** The master name it created or altered, for a master request. */
  masterName: string | null;
  lineErrors: TallyLineError[];
  /** SHA-256 of the raw body. Kept; the body is not. */
  responseHash: string;
  /** The parsed tree, for a caller that needs a report's own shape. */
  root: XmlNode;
}

/**
 * The most of a Tally message we will keep.
 *
 * Long enough for "Ledger 'Acme Hospitals Pvt Ltd' does not exist!" and short
 * enough that a reply designed to fill a column cannot.
 */
const MAX_MESSAGE_CHARS = 300;

/**
 * Strip anything that looks like a path off a message before it is stored.
 *
 * Tally runs on the seller's own machine and its errors happily quote
 * `C:\Users\accounts\Tally\Data\0001\...`. That is the seller's file system,
 * it tells a reader nothing useful about the failure, and it does not belong
 * in a row the marketplace's support desk can read.
 */
function redactMessage(raw: string): string {
  return raw
    .replace(/[A-Za-z]:\\[^\s"'<>]*/g, '[path]')
    .replace(/\\\\[^\s"'<>]+/g, '[path]')
    .replace(/\/(?:home|Users|var|etc|opt)\/[^\s"'<>]*/g, '[path]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
}

/** The ledger, stock item or godown a "does not exist" message names. */
function missingMasterFrom(message: string): string | null {
  // Tally quotes the name in single quotes and then says what is wrong with
  // it. Matching the quotes rather than the words keeps this working across
  // the several phrasings ("does not exist!", "is not found", "Could not find").
  const quoted = /'([^']{1,120})'/.exec(message);
  if (quoted?.[1] === undefined) return null;

  return /does not exist|not found|could not find|unknown/i.test(message) ? quoted[1] : null;
}

/**
 * Parse a response body into the facts a job decides on.
 *
 * Does NOT decide. `assertTallyAccepted` does that, and keeping the two apart
 * matters: a connection test wants the counters without a throw, and a voucher
 * post wants the throw. One function doing both would have to be told which,
 * and the caller that forgot would get the lenient behaviour.
 */
export function readTallyResponse(body: string): TallyResponse {
  const responseHash = createHash('sha256').update(body).digest('hex');
  const root = parseXml(body);

  // Tally puts the counters under <RESPONSE> for an import and scatters them
  // for some reports, so the whole tree is searched rather than one path.
  const scope = findNode(root, 'RESPONSE') ?? root;

  const lineErrors: TallyLineError[] = [];

  // Every shape Tally uses to say "this line was refused". Collected from all
  // of them because which one appears depends on the Tally build, and a client
  // that knew only LINEERROR would report a clean success against a build that
  // says ERRORS.
  for (const tag of ['LINEERROR', 'DESC', 'ERRORMSG', 'EXCEPTIONMSG']) {
    for (const node of findAll(scope, tag)) {
      const text = node.text.trim();
      if (text.length === 0) continue;

      const message = redactMessage(text);
      if (message.length === 0) continue;

      const lineAttribute = node.attributes.LINE ?? node.attributes.line;
      const lineNumber =
        lineAttribute !== undefined && /^\d+$/.test(lineAttribute)
          ? Number.parseInt(lineAttribute, 10)
          : null;

      lineErrors.push({ message, lineNumber, missingMaster: missingMasterFrom(message) });
    }
  }

  return {
    created: intOf(scope, 'CREATED'),
    altered: intOf(scope, 'ALTERED'),
    deleted: intOf(scope, 'DELETED'),
    ignored: intOf(scope, 'IGNORED'),
    errors: intOf(scope, 'ERRORS'),
    exceptions: intOf(scope, 'EXCEPTIONS'),
    lastVoucherId: textOf(scope, 'LASTVCHID'),
    voucherNumber: textOf(root, 'VOUCHERNUMBER'),
    masterName: textOf(root, 'MASTERID') ?? textOf(root, 'NAME'),
    // Capped so a hostile or broken reply cannot fill a JSON column. Twenty is
    // far more than a person will read, and the counters still carry the true
    // total.
    lineErrors: lineErrors.slice(0, 20),
    responseHash,
    root,
  };
}

export interface AcceptanceExpectation {
  /**
   * Whether this request was meant to WRITE something.
   *
   * True for a voucher or a master. A write that reports zero created, zero
   * altered and no error is NOT a success - it is Tally having quietly ignored
   * the request, which happens when the company is closed between the check
   * and the post - so it is refused.
   *
   * False for a read. A report legitimately returns nothing when the seller
   * genuinely has no ledgers yet, and refusing that would make an empty
   * company impossible to set up.
   */
  expectsWrite: boolean;
}

/**
 * Throw unless Tally actually did what was asked.
 *
 * The three refusals, in the order they are checked:
 *
 *   1. It reported errors or exceptions. Whatever else it says, something was
 *      refused, and a partial post is not a success - a voucher missing a tax
 *      line is worse in a seller's books than no voucher at all.
 *   2. It reported per-line failures without a counter to match. Some builds
 *      report one and not the other.
 *   3. It was asked to write and wrote nothing. See `expectsWrite`.
 *
 * `SELLER_ERP_TALLY_REJECTED` carries the line errors as details, so the
 * seller's screen can list them and link each missing master to its mapping
 * row. It is a 409 rather than a 502: the request reached Tally, Tally
 * understood it, and Tally said no. Reporting that as a gateway failure would
 * send a seller looking at their network for a problem in their chart of
 * accounts.
 */
export function assertTallyAccepted(
  response: TallyResponse,
  expectation: AcceptanceExpectation,
): void {
  const details = response.lineErrors.slice(0, 10).map((error, index) => ({
    field: error.lineNumber === null ? `tally.${String(index)}` : `lines.${String(error.lineNumber)}`,
    code: error.missingMaster === null ? 'TALLY_ERROR' : 'MASTER_MISSING',
    message: error.message,
    ...(error.missingMaster === null ? {} : { meta: { master: error.missingMaster } }),
  }));

  if ((response.errors ?? 0) > 0 || (response.exceptions ?? 0) > 0) {
    throw conflict(
      ErrorCode.SELLER_ERP_TALLY_REJECTED,
      'Tally refused this. See the messages it returned.',
      details.length > 0
        ? details
        : [{ code: 'TALLY_ERROR', message: 'Tally reported an error and gave no detail.' }],
    );
  }

  if (response.lineErrors.length > 0) {
    throw conflict(ErrorCode.SELLER_ERP_TALLY_REJECTED, 'Tally refused part of this.', details);
  }

  if (expectation.expectsWrite) {
    const wrote = (response.created ?? 0) + (response.altered ?? 0) + (response.deleted ?? 0);

    if (wrote === 0) {
      throw conflict(
        ErrorCode.SELLER_ERP_TALLY_REJECTED,
        'Tally accepted the request and recorded nothing. The company may have been closed, or the voucher type may not accept it.',
        [
          {
            code: 'NOTHING_WRITTEN',
            meta: {
              created: response.created ?? 0,
              altered: response.altered ?? 0,
              ignored: response.ignored ?? 0,
            },
          },
        ],
      );
    }
  }
}

/** A company as the "List of Companies" report describes it. */
export interface TallyCompanySummary {
  name: string;
  guid: string | null;
  booksFrom: Date | null;
}

/**
 * The open companies, from a company-list reply.
 *
 * Tally reports the companies currently LOADED, not every company on the disk,
 * and that distinction is the whole reason `COMPANY_NOT_LOADED` is a state of
 * its own: a seller whose books are on the machine but not open in Tally is
 * one click from working, and telling them the connection is broken sends them
 * to reinstall an agent that is running perfectly.
 */
export function readCompanies(root: XmlNode): TallyCompanySummary[] {
  const companies: TallyCompanySummary[] = [];

  for (const node of [...findAll(root, 'COMPANY'), ...findAll(root, 'COMPANYNAME')]) {
    const name = (textOf(node, 'NAME') ?? node.text).trim();
    if (name.length === 0) continue;
    if (companies.some((existing) => existing.name === name)) continue;

    companies.push({
      name,
      guid: textOf(node, 'GUID') ?? node.attributes.GUID ?? null,
      booksFrom: parseTallyDate(textOf(node, 'STARTINGFROM') ?? textOf(node, 'BOOKSFROM')),
    });
  }

  return companies;
}

/** A master row from a list report, for the mapping picker. */
export interface TallyMasterSummary {
  name: string;
  guid: string | null;
  parent: string | null;
  extra: Record<string, string>;
}

/**
 * Master rows out of a collection reply.
 *
 * `tag` is the element the collection is made of - LEDGER, STOCKITEM, GODOWN,
 * VOUCHERTYPE, UNIT. The NAME comes off the element's own attribute where
 * Tally put it there and out of a child element otherwise, because it does
 * both depending on the report.
 */
export function readMasters(root: XmlNode, tag: string): TallyMasterSummary[] {
  const masters: TallyMasterSummary[] = [];

  for (const node of findAll(root, tag)) {
    const name = (node.attributes.NAME ?? textOf(node, 'NAME') ?? '').trim();
    if (name.length === 0) continue;

    const extra: Record<string, string> = {};
    for (const key of ['BASEUNITS', 'ADDITIONALUNITS', 'DECIMALPLACES', 'OPENINGBALANCE', 'ISDEEMEDPOSITIVE']) {
      const value = textOf(node, key);
      // A field only worth showing when it is short. A picker hint, not data.
      if (value !== null && value.length <= 64) extra[key] = value;
    }

    masters.push({
      name,
      guid: textOf(node, 'GUID') ?? node.attributes.GUID ?? null,
      parent: textOf(node, 'PARENT'),
      extra,
    });
  }

  return masters;
}

/**
 * Tally's `YYYYMMDD` as a UTC date, or null.
 *
 * UTC deliberately, matching `tallyDate` on the way out. Building it from
 * local parts would shift a books-from date across a day boundary for every
 * seller east of Greenwich, and that date is compared against voucher dates to
 * decide whether a post will be accepted.
 */
export function parseTallyDate(value: string | null): Date | null {
  if (value === null) return null;

  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  if (match === null) return null;

  const [, year, month, day] = match;
  if (year === undefined || month === undefined || day === undefined) return null;

  const date = new Date(
    Date.UTC(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10)),
  );

  return Number.isNaN(date.getTime()) ? null : date;
}

/** SHA-256 of a request body. Kept on the attempt; the body is not. */
export function hashPayload(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
