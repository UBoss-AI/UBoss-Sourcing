/**
 * Matching what is here to what is in a seller's Tally.
 *
 * Tally keys its masters BY NAME. There is no id to hold onto - a ledger is
 * "Acme Hospitals Pvt Ltd" and that string is the identifier - which has two
 * consequences this whole file is shaped around:
 *
 *   1. A rename in Tally breaks the mapping, and it breaks it at post time
 *      with Tally's own message. That is the right place to find out, and it
 *      is why `SellerErpMasterCache` is named a cache: nothing here is
 *      authoritative about what exists in Tally, only about what the seller
 *      said to use.
 *   2. Nothing may be guessed. A name match that LOOKS right is a suggestion,
 *      never a mapping: posting a month of sales against a ledger nobody
 *      confirmed is the mistake that is found at the year end. So
 *      `isConfirmed` defaults to false and nothing syncs on an unconfirmed row.
 *
 * WHAT COMPLETENESS MEANS
 *
 * Not "every possible mapping is filled in". A seller who posts Sales Orders
 * and nothing else needs a party ledger, stock items and one voucher type;
 * asking them for a credit-note voucher type they will never use is a setup
 * wizard nobody finishes. So completeness is decided FROM THE POLICY - what
 * have they actually switched on - and `requiredMappings` below is the one
 * place that decision is made.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from '../seller/account.service.js';
import { recordErpAudit } from './audit.service.js';

export type MappingEntity =
  | 'PARTY_LEDGER'
  | 'STOCK_ITEM'
  | 'GODOWN'
  | 'UNIT'
  | 'ALTERNATE_UNIT'
  | 'SALES_ORDER_VOUCHER_TYPE'
  | 'SALES_INVOICE_VOUCHER_TYPE'
  | 'RECEIPT_VOUCHER_TYPE'
  | 'CREDIT_NOTE_VOUCHER_TYPE'
  | 'SALES_LEDGER'
  | 'FREIGHT_LEDGER'
  | 'DISCOUNT_LEDGER'
  | 'COMMISSION_LEDGER'
  | 'GATEWAY_FEE_LEDGER'
  | 'ROUNDING_LEDGER'
  | 'TAX_LEDGER_CGST'
  | 'TAX_LEDGER_SGST'
  | 'TAX_LEDGER_IGST'
  | 'TAX_LEDGER_CESS'
  | 'TAX_LEDGER_OTHER'
  | 'COST_CENTRE'
  | 'CURRENCY';

/**
 * The entities there is exactly ONE of per connection.
 *
 * Their `localKey` is the empty string. Everything else is keyed by the thing
 * on our side - an offer id for a stock item, a location id for a godown, a
 * tax class code for a tax ledger.
 *
 * Never null, for the reason the rest of this schema never makes a unique-key
 * column nullable: MariaDB treats every NULL as distinct, so two "the sales
 * ledger" rows would both be accepted and the pipeline would pick between them
 * at random.
 */
const SINGLETON_ENTITIES: ReadonlySet<MappingEntity> = new Set([
  'SALES_ORDER_VOUCHER_TYPE',
  'SALES_INVOICE_VOUCHER_TYPE',
  'RECEIPT_VOUCHER_TYPE',
  'CREDIT_NOTE_VOUCHER_TYPE',
  'SALES_LEDGER',
  'FREIGHT_LEDGER',
  'DISCOUNT_LEDGER',
  'COMMISSION_LEDGER',
  'GATEWAY_FEE_LEDGER',
  'ROUNDING_LEDGER',
  'CURRENCY',
]);

export interface MappingView {
  id: string;
  entity: MappingEntity;
  localKey: string;
  localLabel: string | null;
  tallyName: string;
  tallyGuid: string | null;
  alternateUnitName: string | null;
  conversionFactor: string | null;
  isConfirmed: boolean;
  warning: string | null;
  updatedAt: string;
}

/** Every mapping on one connection. */
export async function listMappings(
  membership: SellerMembership,
  connectionId: string,
): Promise<MappingView[]> {
  assertSellerPermission(membership, SellerPermission.INTEGRATION_READ);
  await assertConnectionOwned(membership, connectionId);

  const rows = await prisma.sellerErpMapping.findMany({
    where: { connectionId },
    orderBy: [{ entity: 'asc' }, { localKey: 'asc' }],
  });

  return rows.map(toMappingView);
}

function toMappingView(row: {
  id: string;
  entity: string;
  localKey: string;
  localLabel: string | null;
  tallyName: string;
  tallyGuid: string | null;
  alternateUnitName: string | null;
  /*
   * Prisma's `Decimal`, typed by what this function actually needs of it.
   *
   * `unknown` was the honest type for "whatever the client hands back", but it
   * is honest in the wrong direction: `String(unknown)` can produce
   * `[object Object]`, and on a field that MULTIPLIES A QUANTITY on an
   * accounting document that is not a stringification anybody would notice
   * until a voucher came out wrong. Naming `toString` is what makes the
   * conversion below provably exact rather than incidentally correct.
   */
  conversionFactor: { toString: () => string } | null;
  isConfirmed: boolean;
  warning: string | null;
  updatedAt: Date;
}): MappingView {
  return {
    id: row.id,
    entity: row.entity as MappingEntity,
    localKey: row.localKey,
    localLabel: row.localLabel,
    tallyName: row.tallyName,
    tallyGuid: row.tallyGuid,
    alternateUnitName: row.alternateUnitName,
    // Decimal out as a STRING. A conversion factor crossing as a JS number is
    // the same class of mistake as money doing it, and this one multiplies a
    // quantity.
    conversionFactor: row.conversionFactor === null ? null : String(row.conversionFactor),
    isConfirmed: row.isConfirmed,
    warning: row.warning,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface SaveMappingInput {
  entity: MappingEntity;
  /** Empty for a singleton. See `SINGLETON_ENTITIES`. */
  localKey?: string;
  localLabel?: string | null;
  tallyName: string;
  tallyGuid?: string | null;
  /** Only for ALTERNATE_UNIT. A compound unit the seller made in Tally. */
  alternateUnitName?: string | null;
  /** Base units per alternate unit, as a decimal STRING. */
  conversionFactor?: string | null;
  isConfirmed?: boolean;
}

/**
 * Save one mapping, or several.
 *
 * Saved as a batch inside one transaction, because a mapping screen is filled
 * in as a whole and a half-saved chart of accounts is worse than an unsaved
 * one: the seller presses "connect", nothing tells them the freight ledger did
 * not land, and the first invoice posts without its shipping line.
 */
export async function saveMappings(input: {
  membership: SellerMembership;
  connectionId: string;
  mappings: SaveMappingInput[];
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<MappingView[]> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_WRITE);
  await assertConnectionOwned(input.membership, input.connectionId);

  if (input.mappings.length === 0 || input.mappings.length > 500) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Send between one and five hundred mappings.', [
      { field: 'mappings', code: 'INVALID_LENGTH' },
    ]);
  }

  const before = await prisma.sellerErpMapping.findMany({
    where: { connectionId: input.connectionId },
    select: { entity: true, localKey: true, tallyName: true },
  });

  await prisma.$transaction(async (tx) => {
    for (const [index, mapping] of input.mappings.entries()) {
      const localKey = normaliseLocalKey(mapping, index);
      const tallyName = mapping.tallyName.trim();

      if (tallyName.length === 0 || tallyName.length > 255) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose the name exactly as Tally holds it.', [
          { field: `mappings.${String(index)}.tallyName`, code: 'INVALID' },
        ]);
      }

      const conversionFactor = parseFactor(mapping, index);

      await tx.sellerErpMapping.upsert({
        where: {
          connectionId_entity_localKey: {
            connectionId: input.connectionId,
            entity: mapping.entity,
            localKey,
          },
        },
        create: {
          id: newId(),
          sellerAccountId: input.membership.sellerAccountId,
          connectionId: input.connectionId,
          entity: mapping.entity,
          localKey,
          localLabel: mapping.localLabel?.slice(0, 255) ?? null,
          tallyName,
          tallyGuid: mapping.tallyGuid?.slice(0, 96) ?? null,
          alternateUnitName: mapping.alternateUnitName?.slice(0, 64) ?? null,
          conversionFactor,
          isConfirmed: mapping.isConfirmed ?? false,
          updatedByProfileId: input.membership.customerProfileId,
        },
        update: {
          localLabel: mapping.localLabel?.slice(0, 255) ?? null,
          tallyName,
          tallyGuid: mapping.tallyGuid?.slice(0, 96) ?? null,
          alternateUnitName: mapping.alternateUnitName?.slice(0, 64) ?? null,
          conversionFactor,
          isConfirmed: mapping.isConfirmed ?? false,
          updatedByProfileId: input.membership.customerProfileId,
          // Any warning from a previous validation is cleared: it described
          // the row that was here, and this is a different row.
          warning: null,
        },
      });
    }
  });

  /*
   * Audited per CHANGED row, not per submitted row.
   *
   * A mapping screen resubmits everything on every save, and writing forty
   * audit rows because somebody changed one would make the trail useless for
   * exactly the question it exists to answer: who pointed the IGST ledger
   * somewhere else, and when.
   */
  const previous = new Map(before.map((row) => [`${row.entity}:${row.localKey}`, row.tallyName]));

  for (const mapping of input.mappings) {
    const localKey = SINGLETON_ENTITIES.has(mapping.entity) ? '' : (mapping.localKey ?? '');
    const was = previous.get(`${mapping.entity}:${localKey}`);
    if (was === mapping.tallyName.trim()) continue;

    await recordErpAudit({
      sellerAccountId: input.membership.sellerAccountId,
      connectionId: input.connectionId,
      action: 'seller_erp.mapping_changed',
      actor: { type: 'CUSTOMER', userId: input.actorUserId, label: input.membership.displayName },
      summary:
        was === undefined
          ? `${mapping.entity} mapped to "${mapping.tallyName.trim()}".`
          : `${mapping.entity} changed from "${was}" to "${mapping.tallyName.trim()}".`,
      meta: {
        entity: mapping.entity,
        localKey,
        tallyName: mapping.tallyName.trim(),
        previousTallyName: was ?? null,
      },
      correlationId: input.correlationId,
    });
  }

  await refreshMappingCompleteness(input.connectionId);

  return listMappings(input.membership, input.connectionId);
}

function normaliseLocalKey(mapping: SaveMappingInput, index: number): string {
  if (SINGLETON_ENTITIES.has(mapping.entity)) return '';

  const key = (mapping.localKey ?? '').trim();

  if (key.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'This mapping has to say what on our side it is for.',
      [{ field: `mappings.${String(index)}.localKey`, code: 'REQUIRED' }],
    );
  }

  return key.slice(0, 64);
}

/**
 * The conversion factor, parsed exactly.
 *
 * A STRING in and a string out, handed to Prisma as a Decimal. Never through
 * `Number`: this figure multiplies a quantity on an accounting document, and a
 * factor of 1200 arriving as 1199.9999999999998 posts a quantity that
 * reconciles to nothing.
 */
function parseFactor(mapping: SaveMappingInput, index: number): string | null {
  const raw = mapping.conversionFactor ?? null;
  if (raw === null || raw === '') return null;

  if (!/^\d{1,11}(\.\d{1,6})?$/.test(raw)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A conversion factor is a positive number.', [
      { field: `mappings.${String(index)}.conversionFactor`, code: 'INVALID' },
    ]);
  }

  if (Number.parseFloat(raw) <= 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A conversion factor is a positive number.', [
      { field: `mappings.${String(index)}.conversionFactor`, code: 'INVALID' },
    ]);
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

export interface MissingMapping {
  entity: MappingEntity;
  localKey: string;
  localLabel: string | null;
  /** Why the seller's own choices make this one necessary. */
  because: string;
}

/**
 * What THIS seller's policy actually requires.
 *
 * Read from the policy rather than from a fixed list, because a seller who
 * posts Sales Orders and nothing else genuinely does not need a credit-note
 * voucher type, and a wizard that insists on one is a wizard nobody finishes.
 *
 * Stock items and party ledgers are the two that scale: one per live offer and
 * one per buyer who has ordered. Both are bounded here - see the note on each -
 * because a seller with twelve hundred listings must not be shown twelve
 * hundred blocking rows on the day they connect.
 */
export async function missingMappings(connectionId: string): Promise<MissingMapping[]> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      sellerAccountId: true,
      syncPolicy: true,
      mappings: { select: { entity: true, localKey: true, isConfirmed: true } },
    },
  });

  if (connection === null) return [];

  const policy = connection.syncPolicy;
  if (policy === null) return [];

  const confirmed = new Set(
    connection.mappings
      .filter((mapping) => mapping.isConfirmed)
      .map((mapping) => `${mapping.entity}:${mapping.localKey}`),
  );

  const missing: MissingMapping[] = [];

  const requireSingleton = (entity: MappingEntity, because: string): void => {
    if (confirmed.has(`${entity}:`)) return;
    missing.push({ entity, localKey: '', localLabel: null, because });
  };

  // --- The voucher types, one per thing the seller chose to post ------------

  if (policy.postSalesOrder) {
    requireSingleton('SALES_ORDER_VOUCHER_TYPE', 'You have chosen to post confirmed orders.');
  }

  if (policy.postSalesInvoice) {
    requireSingleton('SALES_INVOICE_VOUCHER_TYPE', 'You have chosen to post invoices.');
    // The income ledger is required only with the invoice, not with the order:
    // a Sales Order is not a revenue event and credits nothing.
    requireSingleton('SALES_LEDGER', 'An invoice has to credit an income ledger.');
  }

  if (policy.postReceipt) {
    requireSingleton('RECEIPT_VOUCHER_TYPE', 'You have chosen to post settlements.');
  }

  if (policy.postCreditNote) {
    requireSingleton('CREDIT_NOTE_VOUCHER_TYPE', 'You have chosen to post refunds.');
  }

  /*
   * Stock items, one per LIVE offer.
   *
   * Only live ones: an archived listing will never appear on a new voucher,
   * and requiring a mapping for it would make a seller who has ever retired a
   * product permanently incomplete.
   *
   * Capped at 200 in the response. The COUNT is honest - the screen says how
   * many there are - but listing twelve hundred blocking rows is a screen
   * nobody can use, and the bulk-match tool is the answer to that scale rather
   * than a longer list.
   */
  if (policy.postSalesInvoice || policy.postSalesOrder) {
    const offers = await prisma.sellerOffer.findMany({
      where: {
        sellerAccountId: connection.sellerAccountId,
        status: 'ACTIVE',
        archivedAt: null,
      },
      select: { id: true, sellerSku: true },
      take: 1000,
    });

    for (const offer of offers) {
      if (confirmed.has(`STOCK_ITEM:${offer.id}`)) continue;
      if (missing.filter((row) => row.entity === 'STOCK_ITEM').length >= 200) break;

      missing.push({
        entity: 'STOCK_ITEM',
        localKey: offer.id,
        localLabel: offer.sellerSku,
        because: 'A voucher line needs a stock item in Tally.',
      });
    }
  }

  // --- Godowns, one per location the seller actually ships from -------------

  if (policy.syncGodowns || policy.inventoryAuthority !== 'DISABLED') {
    const locations = await prisma.sellerLocation.findMany({
      where: { sellerAccountId: connection.sellerAccountId, archivedAt: null },
      select: { id: true, name: true },
      take: 100,
    });

    for (const location of locations) {
      if (confirmed.has(`GODOWN:${location.id}`)) continue;
      missing.push({
        entity: 'GODOWN',
        localKey: location.id,
        localLabel: location.name,
        because: 'Stock has to be attributed to a godown.',
      });
    }
  }

  return missing;
}

/**
 * Recompute and store whether the mappings are complete.
 *
 * Stored on the connection so the status screen does not run the whole check
 * on every render, and recomputed on every save and every policy change - the
 * two things that can move it. The stored value is a CACHE of the answer;
 * `missingMappings` is the answer.
 */
export async function refreshMappingCompleteness(
  connectionId: string,
  tx?: PrismaTransaction,
): Promise<boolean> {
  const missing = await missingMappings(connectionId);
  const complete = missing.length === 0;

  await (tx ?? prisma).sellerErpConnection.update({
    where: { id: connectionId },
    data: { mappingCompleteAt: complete ? new Date() : null },
  });

  return complete;
}

/**
 * Refuse to proceed when a mapping a sync would need is missing.
 *
 * `details` names each one, so the screen can list them and link straight to
 * the row. Called before an initial sync and before a manual post - not on
 * every enqueue, because an event must still be RECORDED while a seller
 * finishes their setup; it simply will not dispatch.
 */
export async function assertMappingsComplete(connectionId: string): Promise<void> {
  const missing = await missingMappings(connectionId);
  if (missing.length === 0) return;

  throw conflict(
    ErrorCode.SELLER_ERP_MAPPING_INCOMPLETE,
    'Some things still need matching to Tally before this can run.',
    missing.slice(0, 25).map((row) => ({
      field: `${row.entity}.${row.localKey}`,
      code: 'MAPPING_MISSING',
      message: row.because,
      meta: { entity: row.entity, localKey: row.localKey, label: row.localLabel },
    })),
  );
}

// ---------------------------------------------------------------------------
// The master cache
// ---------------------------------------------------------------------------

/**
 * Store what a master pull found, so the mapping picker has rows.
 *
 * Upserted rather than replaced, and `lastSeenAt` is what makes a stale entry
 * visible: a ledger that has disappeared from Tally keeps its row with an
 * ageing timestamp, which is how the screen can say "this was here yesterday
 * and is not now" instead of silently dropping a mapping target.
 */
export async function storeMasters(input: {
  connectionId: string;
  entity: MappingEntity;
  masters: { name: string; guid: string | null; parent: string | null; extra: Record<string, string> }[];
}): Promise<number> {
  const seenAt = new Date();
  let stored = 0;

  for (const master of input.masters.slice(0, 5000)) {
    const name = master.name.trim().slice(0, 255);
    if (name.length === 0) continue;

    await prisma.sellerErpMasterCache.upsert({
      where: {
        connectionId_entity_tallyName: {
          connectionId: input.connectionId,
          entity: input.entity,
          tallyName: name,
        },
      },
      create: {
        id: newId(),
        connectionId: input.connectionId,
        entity: input.entity,
        tallyName: name,
        tallyGuid: master.guid?.slice(0, 96) ?? null,
        parentName: master.parent?.slice(0, 255) ?? null,
        extraJson: Object.keys(master.extra).length === 0 ? undefined : (master.extra as never),
        lastSeenAt: seenAt,
      },
      update: {
        tallyGuid: master.guid?.slice(0, 96) ?? null,
        parentName: master.parent?.slice(0, 255) ?? null,
        extraJson: Object.keys(master.extra).length === 0 ? undefined : (master.extra as never),
        lastSeenAt: seenAt,
      },
    });

    stored += 1;
  }

  return stored;
}

export interface MasterOption {
  tallyName: string;
  tallyGuid: string | null;
  parentName: string | null;
  extra: Record<string, string>;
  lastSeenAt: string;
  /** True when this has not been reported by the last few pulls. */
  isStale: boolean;
}

/** What the picker offers for one kind of master. */
export async function listMasters(input: {
  membership: SellerMembership;
  connectionId: string;
  entity: MappingEntity;
  search?: string | null;
  limit?: number;
}): Promise<MasterOption[]> {
  assertSellerPermission(input.membership, SellerPermission.INTEGRATION_READ);
  await assertConnectionOwned(input.membership, input.connectionId);

  const search = input.search?.trim() ?? '';

  const rows = await prisma.sellerErpMasterCache.findMany({
    where: {
      connectionId: input.connectionId,
      entity: input.entity,
      ...(search.length === 0 ? {} : { tallyName: { contains: search } }),
    },
    orderBy: { tallyName: 'asc' },
    take: Math.min(500, Math.max(1, input.limit ?? 200)),
  });

  // A day. Long enough that a pull run this morning is fresh all day; short
  // enough that a master deleted last week is visibly stale.
  const staleBefore = Date.now() - 24 * 60 * 60 * 1000;

  return rows.map((row) => ({
    tallyName: row.tallyName,
    tallyGuid: row.tallyGuid,
    parentName: row.parentName,
    extra: (row.extraJson as Record<string, string> | null) ?? {},
    lastSeenAt: row.lastSeenAt.toISOString(),
    isStale: row.lastSeenAt.getTime() < staleBefore,
  }));
}

/**
 * Suggestions, by name, for a mapping screen to offer.
 *
 * SUGGESTIONS. Nothing here writes a mapping and nothing here sets
 * `isConfirmed`. A name match is a hint a person accepts or rejects, and the
 * difference between that and a mapping is the difference between a setup
 * wizard and a month of sales posted against a ledger nobody looked at.
 */
export async function suggestMasterFor(input: {
  connectionId: string;
  entity: MappingEntity;
  localLabel: string;
}): Promise<MasterOption | null> {
  const needle = input.localLabel.trim().toLowerCase();
  if (needle.length === 0) return null;

  const candidates = await prisma.sellerErpMasterCache.findMany({
    where: { connectionId: input.connectionId, entity: input.entity },
    take: 2000,
  });

  const exact = candidates.find((row) => row.tallyName.trim().toLowerCase() === needle);
  const chosen =
    exact ??
    candidates.find((row) => {
      const name = row.tallyName.trim().toLowerCase();
      return name.includes(needle) || needle.includes(name);
    });

  if (chosen === undefined) return null;

  return {
    tallyName: chosen.tallyName,
    tallyGuid: chosen.tallyGuid,
    parentName: chosen.parentName,
    extra: (chosen.extraJson as Record<string, string> | null) ?? {},
    lastSeenAt: chosen.lastSeenAt.toISOString(),
    isStale: false,
  };
}

// ---------------------------------------------------------------------------

async function assertConnectionOwned(
  membership: SellerMembership,
  connectionId: string,
): Promise<void> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: connectionId },
    select: { sellerAccountId: true },
  });

  assertSellerOwnership(membership, connection?.sellerAccountId ?? null, 'ERP connection');
  if (connection === null) throw notFound('ERP connection');
}
