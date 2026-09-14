/**
 * "Their code X is our product Y."
 *
 * The last missing piece of this feature, and the one that made the rest of it
 * work on a real connection rather than on a mock.
 *
 * THE PROBLEM, MEASURED
 *
 * A buyer's monday.com board held 708 finished-goods codes (`FG/1BZ1B1-G`).
 * The store's catalogue held 247 products (`EV-CANNULA-WP`). Both carry a
 * barcode column, which would have been the obvious join, and the catalogue's
 * was empty on every row. The two systems shared **no identifier at all**, so a
 * sync read 708 records, recorded one, and that one was an accidental collision
 * between two unrelated code systems.
 *
 * That is not a configuration mistake and no mapping screen fixes it: the
 * information needed to join the two catalogues did not exist anywhere yet.
 * Somebody has to supply it. This module is how, and the reconciliation screen
 * is where - it already produces exactly the two lists a person needs, "codes
 * only in their system" and "products only in ours".
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * **It never guesses.** No case folding, no punctuation stripping, no leading
 * zeroes, no fuzzy match, no "these are 90% similar so they are probably the
 * same product". A wrong mapping is worse than no mapping in a way that takes
 * months to surface: it attaches a real stock figure to the wrong item, and
 * everything downstream believes it. The gap being visible and unfixed is a
 * problem somebody can see; a confident wrong answer is not.
 *
 * `importProductCodes` below is the bulk path, because mapping 708 codes by
 * hand one at a time is not a thing anybody will finish. It takes a two-column
 * file - their code, our SKU - which is what a person already has open in a
 * spreadsheet next to a catalogue export.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { recordOrgAudit, type OrgActor } from './audit.service.js';
import { assertCapability, type Membership } from './organization.service.js';

/**
 * How many mappings one connection may hold.
 *
 * Generous - a real catalogue cross-reference is thousands of rows - and
 * present because this table is written by a file upload, and an upload with no
 * ceiling is a way to fill a disk.
 */
const MAX_MAPPINGS_PER_CONNECTION = 50_000;

/** How many rows one upload may carry. */
const MAX_UPLOAD_ROWS = 20_000;

export interface ProductCodeRow {
  id: string;
  erpCode: string;
  productId: string;
  /** Null when the product has since been removed from the catalogue. */
  sku: string | null;
  productName: string | null;
  variantKey: string;
  note: string | null;
  updatedAt: string;
}

/**
 * Everything mapped on a connection.
 *
 * Joined to the catalogue in one query rather than per row, and tolerant of a
 * product that has gone: there is no foreign key to `products` - see the
 * migration for why - so a mapping can outlive what it points at. Those rows
 * come back with a null `sku`, which is what lets a screen show them as broken
 * instead of hiding them.
 */
export async function listProductCodes(
  membership: Membership,
  connectionId: string,
): Promise<ProductCodeRow[]> {
  assertCapability(membership, 'VIEW');

  const rows = await prisma.customerErpProductCode.findMany({
    where: { connectionId, organizationId: membership.organizationId },
    orderBy: { erpCode: 'asc' },
  });

  if (rows.length === 0) return [];

  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.productId))] } },
    select: { id: true, sku: true, name: true },
  });

  const byId = new Map(products.map((product) => [product.id, product]));

  return rows.map((row) => {
    const product = byId.get(row.productId) ?? null;

    return {
      id: row.id,
      erpCode: row.erpCode,
      productId: row.productId,
      sku: product?.sku ?? null,
      productName: product?.name ?? null,
      variantKey: row.variantKey,
      note: row.note,
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

/**
 * Map one code to one product.
 *
 * Re-mapping an existing code is allowed and is an UPDATE, not a refusal: a
 * buyer who mapped a code to the wrong product needs to fix it, and making them
 * delete first would be ceremony. What is refused is a code that does not
 * resolve to a product that exists, because that is not a decision, it is a
 * typo that would silently match nothing forever.
 */
export async function linkProductCode(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  input: { erpCode: string; productId: string; variantKey?: string; note?: string | null },
): Promise<ProductCodeRow> {
  assertCapability(membership, 'CONFIGURE');

  const connection = await prisma.customerErpConnection.findFirst({
    where: { id: connectionId, organizationId: membership.organizationId, deletedAt: null },
    select: { id: true },
  });

  if (connection === null) throw notFound('Connection');

  // Trimmed of SURROUNDING whitespace only. A code is copied out of a
  // spreadsheet as often as it is typed, and a trailing space from a cell is
  // not a different product - but nothing inside the code is touched, because
  // `FG/1BZ1 B1` and `FG/1BZ1B1` genuinely might be.
  const erpCode = input.erpCode.trim();

  if (erpCode.length === 0) {
    throw badRequest(ErrorCode.CUSTOMER_ERP_PRODUCT_CODE_INVALID, 'The code cannot be blank.');
  }

  if (erpCode.length > 191) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_PRODUCT_CODE_INVALID,
      'That code is longer than 191 characters, which is longer than any real product code.',
    );
  }

  const product = await prisma.product.findUnique({
    where: { id: input.productId },
    select: { id: true, sku: true, name: true },
  });

  if (product === null) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_PRODUCT_CODE_INVALID,
      'That product is not in this catalogue.',
    );
  }

  const existingCount = await prisma.customerErpProductCode.count({ where: { connectionId } });
  const alreadyMapped = await prisma.customerErpProductCode.findUnique({
    where: { connectionId_erpCode: { connectionId, erpCode } },
    select: { id: true },
  });

  if (alreadyMapped === null && existingCount >= MAX_MAPPINGS_PER_CONNECTION) {
    throw conflict(
      ErrorCode.CUSTOMER_ERP_LIMIT_REACHED,
      `This connection already holds ${MAX_MAPPINGS_PER_CONNECTION} product code mappings.`,
    );
  }

  const row = await prisma.customerErpProductCode.upsert({
    where: { connectionId_erpCode: { connectionId, erpCode } },
    create: {
      id: newId(),
      connectionId,
      organizationId: membership.organizationId,
      erpCode,
      productId: product.id,
      variantKey: input.variantKey ?? '',
      note: input.note ?? null,
    },
    update: {
      productId: product.id,
      variantKey: input.variantKey ?? '',
      note: input.note ?? null,
    },
  });

  // Who mapped what. This is why the table itself carries no
  // `createdByProfileId` - recording a person's id twice, once properly and
  // once in a catalogue table, would put personal data where the Art. 15
  // export would then have to account for it.
  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'mapping.linked',
    resourceType: 'product_code',
    resourceId: row.id,
    actor,
    after: { erpCode, productId: product.id, sku: product.sku },
  });

  return {
    id: row.id,
    erpCode: row.erpCode,
    productId: row.productId,
    sku: product.sku,
    productName: product.name,
    variantKey: row.variantKey,
    note: row.note,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Remove one mapping. The code goes back to matching on SKU, or not at all. */
export async function unlinkProductCode(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  id: string,
): Promise<void> {
  assertCapability(membership, 'CONFIGURE');

  const row = await prisma.customerErpProductCode.findFirst({
    where: { id, connectionId, organizationId: membership.organizationId },
  });

  if (row === null) throw notFound('Mapping');

  await prisma.customerErpProductCode.delete({ where: { id: row.id } });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'mapping.unlinked',
    resourceType: 'product_code',
    resourceId: row.id,
    actor,
    before: { erpCode: row.erpCode, productId: row.productId },
  });
}

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

export interface BulkResult {
  created: number;
  updated: number;
  /** Rows that named a product this catalogue does not have. */
  skipped: { line: number; erpCode: string; reason: string }[];
}

/**
 * A two-column file: their code, our SKU.
 *
 * The only realistic way to close a 708-row gap. Hand-mapping is right for the
 * last dozen and hopeless for the first seven hundred.
 *
 * **Matched on SKU rather than on product id**, because the person preparing
 * this file is working in a spreadsheet next to a catalogue export, and a ULID
 * is not something anybody types or recognises. A row naming a SKU this
 * catalogue does not have is SKIPPED with its line number rather than failing
 * the upload: a file of seven hundred rows will have a few stale ones, and
 * refusing all of it because of three is how somebody gives up and does nothing.
 *
 * Delimiters are comma, semicolon or tab, sniffed per line. European
 * spreadsheets export semicolons by default and a buyer in Germany should not
 * have to know that.
 */
export async function importProductCodes(
  membership: Membership,
  actor: OrgActor,
  connectionId: string,
  csv: string,
): Promise<BulkResult> {
  assertCapability(membership, 'CONFIGURE');

  const connection = await prisma.customerErpConnection.findFirst({
    where: { id: connectionId, organizationId: membership.organizationId, deletedAt: null },
    select: { id: true },
  });

  if (connection === null) throw notFound('Connection');

  const lines = csv.split(/\r?\n/);

  if (lines.length > MAX_UPLOAD_ROWS + 1) {
    throw badRequest(
      ErrorCode.CUSTOMER_ERP_PRODUCT_CODE_INVALID,
      `That file has more than ${MAX_UPLOAD_ROWS} rows.`,
    );
  }

  const parsed: { line: number; erpCode: string; sku: string }[] = [];
  const skipped: BulkResult['skipped'] = [];

  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const text = raw.trim();

    if (text.length === 0) continue;
    // A comment, and the header row a spreadsheet writes.
    if (text.startsWith('#')) continue;

    const parts = splitRow(text);

    if (parts.length < 2) {
      skipped.push({ line, erpCode: text, reason: 'needs two columns: their code, then our SKU' });
      continue;
    }

    const erpCode = (parts[0] ?? '').trim();
    const sku = (parts[1] ?? '').trim();

    // The header, whatever it is called. Checked by shape rather than by an
    // exact string so `erp_code,sku` and `Their code;Our SKU` are both caught.
    if (line === 1 && /code/i.test(erpCode) && /sku|product/i.test(sku)) continue;

    if (erpCode.length === 0 || sku.length === 0) {
      skipped.push({ line, erpCode, reason: 'blank code or SKU' });
      continue;
    }

    if (erpCode.length > 191) {
      skipped.push({ line, erpCode: erpCode.slice(0, 40), reason: 'code is too long' });
      continue;
    }

    parsed.push({ line, erpCode, sku });
  }

  if (parsed.length === 0) {
    return { created: 0, updated: 0, skipped };
  }

  // One query for every SKU mentioned, rather than one per row. A 700-row file
  // would otherwise be 700 round trips, and the upload would time out before
  // the first useful thing happened.
  const products = await prisma.product.findMany({
    where: { sku: { in: [...new Set(parsed.map((row) => row.sku))] } },
    select: { id: true, sku: true },
  });

  const productBySku = new Map(products.map((product) => [product.sku, product.id]));

  const existing = await prisma.customerErpProductCode.findMany({
    where: { connectionId },
    select: { erpCode: true },
  });
  const known = new Set(existing.map((row) => row.erpCode));

  let created = 0;
  let updated = 0;

  /** The last write for a code wins; a file that repeats one is not an error. */
  const seen = new Set<string>();

  for (const row of parsed) {
    const productId = productBySku.get(row.sku);

    if (productId === undefined) {
      skipped.push({ line: row.line, erpCode: row.erpCode, reason: `no product with SKU ${row.sku}` });
      continue;
    }

    if (!known.has(row.erpCode) && !seen.has(row.erpCode)) {
      if (known.size + created >= MAX_MAPPINGS_PER_CONNECTION) {
        skipped.push({ line: row.line, erpCode: row.erpCode, reason: 'mapping limit reached' });
        continue;
      }
      created += 1;
    } else if (!seen.has(row.erpCode)) {
      updated += 1;
    }

    seen.add(row.erpCode);

    await prisma.customerErpProductCode.upsert({
      where: { connectionId_erpCode: { connectionId, erpCode: row.erpCode } },
      create: {
        id: newId(),
        connectionId,
        organizationId: membership.organizationId,
        erpCode: row.erpCode,
        productId,
        variantKey: '',
        note: null,
      },
      update: { productId, variantKey: '' },
    });
  }

  await recordOrgAudit({
    organizationId: membership.organizationId,
    connectionId,
    action: 'mapping.imported',
    resourceType: 'connection',
    resourceId: connectionId,
    actor,
    after: { created, updated, skipped: skipped.length },
  });

  /*
   * In line order, which is not the order they were found in.
   *
   * Rows are rejected in two passes - malformed ones while parsing, unknown
   * SKUs afterwards once the catalogue has been read in a single query - so
   * without this a person reading the result sees line 7, then line 2, then
   * line 9. They are going to open the file and work down it; the list should
   * be in the order they will read it.
   */
  skipped.sort((a, b) => a.line - b.line);

  return { created, updated, skipped };
}

/**
 * One row into its columns.
 *
 * The delimiter is sniffed per line rather than declared, because the files
 * this reads are exported by whatever spreadsheet the buyer happens to use and
 * a German or French Excel writes semicolons. Quoted fields are honoured, since
 * a product code containing a comma is rare and not impossible.
 */
function splitRow(line: string): string[] {
  const delimiter = pickDelimiter(line);
  const out: string[] = [];

  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];

    if (quoted) {
      if (ch === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field.length === 0) {
      quoted = true;
      continue;
    }

    if (ch === delimiter) {
      out.push(field);
      field = '';
      continue;
    }

    field += ch;
  }

  out.push(field);

  return out;
}

/** Whichever separator appears outside quotes first. Comma if none does. */
function pickDelimiter(line: string): string {
  let quoted = false;

  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === ',' || ch === ';' || ch === '\t') return ch;
  }

  return ',';
}
