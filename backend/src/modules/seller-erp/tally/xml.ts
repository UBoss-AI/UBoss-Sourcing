/**
 * Tally's XML, built and read safely.
 *
 * TallyPrime's HTTP interface speaks XML. It is an old, forgiving dialect: no
 * namespaces, no schema, tag names in capitals, and a habit of answering HTTP
 * 200 to a request it rejected outright. Everything in this file exists
 * because one of those facts can cost a seller their books.
 *
 * WHY THIS IS A HAND-WRITTEN PARSER AND NOT A LIBRARY
 *
 * Not to avoid a dependency. Because the threat here is a specific one and the
 * safest answer is a parser that CANNOT do the dangerous thing rather than one
 * configured not to.
 *
 * The payloads travel from a seller's own machine, over a bridge, into this
 * server. A general XML parser asked to read them brings with it doctype
 * handling, entity expansion and, in several popular ones, external entity
 * resolution - which is XXE: a response containing
 *
 *     <!DOCTYPE x [ <!ENTITY e SYSTEM "file:///etc/passwd"> ]> <a>&e;</a>
 *
 * reads a file off this server and hands it back to whoever sent the response.
 * The billion-laughs variant needs no external access at all and exhausts
 * memory from a few hundred bytes. Both are configuration flags away in every
 * library, and a flag is something a future upgrade can reset.
 *
 * So: this parser has no doctype support, no entity declarations, and no
 * general entity table. It knows five predefined entities and nothing else.
 * `<!DOCTYPE` and `<!ENTITY` are not ignored - they are a hard refusal of the
 * whole document, because a Tally response has no reason to contain either and
 * one that does is not a Tally response.
 *
 * WHAT ELSE IS REFUSED
 *
 *   - Anything over `MAX_XML_BYTES`. A response is a voucher acknowledgement,
 *     not a database dump.
 *   - Nesting deeper than `MAX_DEPTH`. A deep document is a stack exhaustion
 *     dressed as data.
 *   - Processing instructions other than the XML declaration.
 *   - CDATA containing a nested close, and unterminated constructs generally.
 *
 * ON THE WRITING SIDE
 *
 * Every value is escaped, including inside attributes, and a tag name is built
 * only from a closed set this module owns - never from anything that came off
 * a request. A ledger called `Acme & Co <Ltd>` is a real ledger name and it
 * has to survive the round trip intact.
 */
import { ErrorCode, badRequest } from '../../../domain/errors.js';

/**
 * The most XML this will read.
 *
 * A master list pulled from a large company is the biggest legitimate payload
 * and runs to a few megabytes; a voucher acknowledgement is a few kilobytes.
 * Eight is generous for both and small enough that a hostile response cannot
 * be used to exhaust the process.
 */
export const MAX_XML_BYTES = 8 * 1024 * 1024;

/**
 * The deepest element nesting this will read.
 *
 * Tally's own envelopes run to about eight. Sixty-four leaves room for a
 * format nobody has met yet and still refuses a document engineered to blow
 * the stack.
 */
export const MAX_DEPTH = 64;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Escape a value for XML text or an attribute.
 *
 * All five, always, and `'` as `&apos;` rather than left alone: the same
 * function serves attributes, and an unescaped apostrophe inside a
 * single-quoted attribute closes it. Being right for both is worth more than
 * the four characters saved.
 *
 * Control characters that XML 1.0 cannot represent at all are dropped rather
 * than escaped. `&#x0;` is not valid XML; a numeric escape of it produces a
 * document Tally will reject with a message about the document rather than
 * about the ledger, which is the least useful error a seller can be handed.
 */
export function escapeXml(value: string): string {
  return value
    // eslint-disable-next-line no-control-regex -- exactly the point: these cannot be represented
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A tag name this module is willing to write.
 *
 * Letters, digits, dots, underscores and hyphens, optionally with ONE colon in
 * the middle. The colon is there because Tally's user-defined fields are
 * genuinely named `UDF:GLOVIAPACKAGING` - it is how that dialect spells a
 * namespace prefix, and refusing it would mean no user-defined field could be
 * written at all.
 *
 * Exactly one colon, never leading and never trailing, so the relaxation
 * cannot be used to smuggle anything: `a:b` passes and `:x`, `x:`, `a:b:c` and
 * anything with a space, a quote or an angle bracket do not.
 *
 * Anything else is a programming mistake in this repository - the names are
 * constants here, never values from a request - and it throws rather than
 * being escaped, because a "tag name" that needed escaping would be somebody
 * having found a way to put a request body where a constant belongs.
 */
function assertTagName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9._-]*(:[A-Za-z][A-Za-z0-9._-]*)?$/.test(name)) {
    throw new Error(`Refusing to write an XML tag named ${JSON.stringify(name)}`);
  }
}

export type XmlAttributes = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** `<TAG a="b">text</TAG>`, with everything escaped. */
export function element(
  name: string,
  children: string | number | null | undefined,
  attributes: XmlAttributes = {},
): string {
  assertTagName(name);

  const attrs = renderAttributes(attributes);

  if (children === null || children === undefined || children === '') {
    return `<${name}${attrs}/>`;
  }

  return `<${name}${attrs}>${escapeXml(String(children))}</${name}>`;
}

/** `<TAG>...raw children...</TAG>`. The children must already be XML. */
export function wrap(name: string, inner: string, attributes: XmlAttributes = {}): string {
  assertTagName(name);
  return `<${name}${renderAttributes(attributes)}>${inner}</${name}>`;
}

function renderAttributes(attributes: XmlAttributes): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined) continue;
    assertTagName(key);
    parts.push(` ${key}="${escapeXml(String(value))}"`);
  }

  return parts.join('');
}

/**
 * A date as Tally wants it: `YYYYMMDD`, no separators.
 *
 * Built from the UTC parts deliberately. Every instant in this system is UTC
 * (see the schema header), and reading local parts would post a voucher a day
 * early for any seller east of Greenwich after their evening cut-off.
 */
export function tallyDate(date: Date): string {
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

/**
 * Minor units as the decimal string Tally expects.
 *
 * `bigint` in, string out, and no float in between. 1234567 paise at exponent
 * 2 is "12345.67" - produced by splitting the integer, never by dividing it.
 * A division here would be the one place in this whole system where money
 * touched a float, and it would be in the file that writes the accounts.
 */
export function tallyAmount(minor: bigint, exponent: number): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;

  if (exponent <= 0) return `${negative ? '-' : ''}${absolute.toString()}`;

  const divisor = 10n ** BigInt(exponent);
  const whole = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(exponent, '0');

  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A parsed element. Attributes are kept: Tally puts meaning in them. */
export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  /** The element's own text, with its children's text excluded. */
  text: string;
}

/**
 * The five entities XML predefines, and the ONLY ones this parser knows.
 *
 * There is no mechanism to add to this. A document that declares an entity is
 * refused before parsing begins - see `assertNoDoctype` - so there is nothing
 * a payload can say that puts a sixth key in here.
 */
const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * Turn the five entities, plus numeric character references, back into text.
 *
 * Numeric references are allowed because Tally emits them for accented
 * characters in a company or party name, and refusing them would break every
 * European seller. They are bounded to the Unicode range and rejected outside
 * it; a reference has no expansion of its own, so there is no recursion to
 * bound and no billion-laughs shape available through this path.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, body: string) => {
    if (body.startsWith('#')) {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const digits = isHex ? body.slice(2) : body.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);

      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      // Surrogate halves are not characters. Returning one produces a lone
      // surrogate in a JS string, which then cannot be written back out.
      if (code >= 0xd800 && code <= 0xdfff) return match;

      return String.fromCodePoint(code);
    }

    return PREDEFINED_ENTITIES[body] ?? match;
  });
}

/**
 * The refusal that makes XXE structurally impossible here.
 *
 * Not a sanitisation and not a strip - a hard refusal of the whole document.
 * A legitimate Tally response contains no document type declaration and no
 * entity declaration, ever, so a payload carrying one is not a Tally response
 * and there is nothing in it worth recovering. Stripping the declaration and
 * parsing the rest would be the worse choice: it treats a hostile document as
 * a slightly malformed one and keeps going.
 *
 * The check is on the RAW text, before any parsing, so nothing has been
 * interpreted at the point the decision is made.
 */
function assertNoDoctype(xml: string): void {
  // Case-insensitive: `<!doctype` is as valid as `<!DOCTYPE`.
  if (/<!\s*doctype/i.test(xml) || /<!\s*entity/i.test(xml)) {
    throw badRequest(
      ErrorCode.SELLER_ERP_RESPONSE_INVALID,
      'The reply contained a document-type declaration and was refused.',
      [{ field: 'response', code: 'DOCTYPE_REFUSED' }],
    );
  }
}

/**
 * Parse a Tally response.
 *
 * Throws `SELLER_ERP_RESPONSE_INVALID` for anything it will not read, and the
 * message is deliberately the same for all of them - a caller does not get to
 * learn which of the refusals it tripped, because that is a probe answering
 * itself.
 */
export function parseXml(xml: string): XmlNode {
  if (xml.length > MAX_XML_BYTES) {
    throw badRequest(
      ErrorCode.SELLER_ERP_RESPONSE_INVALID,
      'The reply was larger than we will read.',
      [{ field: 'response', code: 'TOO_LARGE' }],
    );
  }

  assertNoDoctype(xml);

  const root: XmlNode = { name: '#document', attributes: {}, children: [], text: '' };
  const stack: XmlNode[] = [root];

  let index = 0;

  while (index < xml.length) {
    const open = xml.indexOf('<', index);

    if (open === -1) {
      appendText(stack, xml.slice(index));
      break;
    }

    if (open > index) appendText(stack, xml.slice(index, open));

    // --- Comments, CDATA and the declaration -------------------------------

    if (xml.startsWith('<!--', open)) {
      const end = xml.indexOf('-->', open + 4);
      if (end === -1) throw malformed();
      index = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', open)) {
      const end = xml.indexOf(']]>', open + 9);
      if (end === -1) throw malformed();
      // CDATA is literal by definition: NOT entity-decoded. Decoding it would
      // re-introduce the one thing CDATA exists to prevent.
      appendRawText(stack, xml.slice(open + 9, end));
      index = end + 3;
      continue;
    }

    if (xml.startsWith('<?', open)) {
      const end = xml.indexOf('?>', open + 2);
      if (end === -1) throw malformed();
      index = end + 2;
      continue;
    }

    // Any other `<!` construct. Doctype and entity are already refused above;
    // anything else here is a conditional section or a notation, neither of
    // which belongs in a Tally reply.
    if (xml.startsWith('<!', open)) throw malformed();

    // --- A tag --------------------------------------------------------------

    const close = xml.indexOf('>', open);
    if (close === -1) throw malformed();

    const raw = xml.slice(open + 1, close).trim();

    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const current = stack[stack.length - 1];

      // A mismatched close means the document is not what it claims to be.
      // Tolerating it - popping until a match, say - is how a truncated
      // response gets read as a complete one with fewer vouchers in it.
      if (current === undefined || stack.length === 1 || current.name !== name) throw malformed();

      stack.pop();
      index = close + 1;
      continue;
    }

    const selfClosing = raw.endsWith('/');
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;

    const spaceAt = body.search(/\s/);
    const name = spaceAt === -1 ? body : body.slice(0, spaceAt);

    if (!/^[A-Za-z_][A-Za-z0-9._:-]*$/.test(name)) throw malformed();

    const node: XmlNode = {
      name,
      attributes: spaceAt === -1 ? {} : parseAttributes(body.slice(spaceAt + 1)),
      children: [],
      text: '',
    };

    const parent = stack[stack.length - 1];
    if (parent === undefined) throw malformed();
    parent.children.push(node);

    if (!selfClosing) {
      if (stack.length >= MAX_DEPTH) {
        throw badRequest(
          ErrorCode.SELLER_ERP_RESPONSE_INVALID,
          'The reply was nested more deeply than we will read.',
          [{ field: 'response', code: 'TOO_DEEP' }],
        );
      }
      stack.push(node);
    }

    index = close + 1;
  }

  // Anything still open is a truncated document. Returning what was read would
  // hand a caller a half-response that looks complete.
  if (stack.length !== 1) throw malformed();

  return root;
}

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9._:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const key = match[1];
    const value = match[3] ?? match[4] ?? '';
    if (key !== undefined) attributes[key] = decodeEntities(value);
  }

  return attributes;
}

function appendText(stack: XmlNode[], raw: string): void {
  appendRawText(stack, decodeEntities(raw));
}

function appendRawText(stack: XmlNode[], value: string): void {
  const current = stack[stack.length - 1];
  if (current !== undefined) current.text += value;
}

function malformed(): ReturnType<typeof badRequest> {
  return badRequest(
    ErrorCode.SELLER_ERP_RESPONSE_INVALID,
    'The reply was not valid XML.',
    [{ field: 'response', code: 'MALFORMED' }],
  );
}

// ---------------------------------------------------------------------------
// Getting at what was read
// ---------------------------------------------------------------------------

/**
 * The first descendant with this tag name, at any depth.
 *
 * Case-insensitive, because Tally is not consistent about it: the same
 * installation answers `<LINEERROR>` and `<LineError>` depending on which
 * report produced it, and a case-sensitive lookup silently finds nothing and
 * reports a clean success.
 */
export function findNode(node: XmlNode, name: string): XmlNode | null {
  const target = name.toUpperCase();

  for (const child of node.children) {
    if (child.name.toUpperCase() === target) return child;
    const nested = findNode(child, name);
    if (nested !== null) return nested;
  }

  return null;
}

/** Every descendant with this tag name, in document order. */
export function findAll(node: XmlNode, name: string): XmlNode[] {
  const target = name.toUpperCase();
  const found: XmlNode[] = [];

  const walk = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name.toUpperCase() === target) found.push(child);
      walk(child);
    }
  };

  walk(node);
  return found;
}

/** The trimmed text of the first matching descendant, or null. */
export function textOf(node: XmlNode, name: string): string | null {
  const found = findNode(node, name);
  if (found === null) return null;
  const value = found.text.trim();
  return value.length === 0 ? null : value;
}

/**
 * The integer in the first matching descendant, or null.
 *
 * Null for a tag that is absent AND for one whose contents are not a number,
 * and the caller has to decide what each means. `readResponse` treats a
 * missing counter as "Tally did not say", which is not the same as zero - and
 * the difference is whether a job that created nothing is reported as a
 * success.
 */
export function intOf(node: XmlNode, name: string): number | null {
  const value = textOf(node, name);
  if (value === null) return null;
  if (!/^-?\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
