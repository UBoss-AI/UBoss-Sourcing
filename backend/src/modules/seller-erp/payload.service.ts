/**
 * Turning one seller's part of an order into a Tally voucher.
 *
 * THE RULE THIS FILE IS FOR
 *
 * A buyer orders 2 UK pallets. Each pallet holds 50 cartons. Each carton holds
 * 24 units. The voucher posts **2,400**.
 *
 * Not 2. Two is the number of pallets, and Tally does not know what a pallet
 * is - it knows the stock item's base unit, which is what the warehouse
 * counts, what the stock ledger reconciles to and what the seller's accountant
 * will compare against a physical count. Posting 2 would say two units left
 * the building and would leave 2,398 units unaccounted for in a system whose
 * whole job is accounting for them.
 *
 * The packaging is not discarded to achieve that. It goes onto the voucher as
 * narration and onto each line as its own description - "2 UK pallets x 50
 * cartons x 24 units" - so the 2,400 is a figure somebody can check rather
 * than a number they have to trust.
 *
 * THE ONE EXCEPTION, AND WHY IT IS OPT-IN
 *
 * A seller may create a compound unit in Tally ("PLT of 1200 PCS") and map it.
 * Then the line posts in that unit, with Tally's own conversion doing the
 * arithmetic. It requires a CONFIRMED `ALTERNATE_UNIT` mapping, and the
 * factor on it is checked against the packaging's own figure before the
 * voucher is built - a Tally unit declaring 1,000 to a pallet against
 * packaging that says 1,200 posts a quantity that reconciles to neither, so
 * the mismatch refuses rather than picking one.
 *
 * WHAT IS BUILT WHEN
 *
 * The payload is assembled AT ENQUEUE TIME, from the data as it is then, and
 * stored on the job. Not at send time. A job that assembled its payload when
 * the bridge happened to come back online would post whatever the order looks
 * like then, which for an order part-refunded in the meantime is not the event
 * that was recorded.
 */
import { ErrorCode, conflict } from '../../domain/errors.js';
import { currencyExponent } from '../../domain/money.js';
import { describePackaging, type PackageType } from '../../domain/packaging.js';
import { prisma } from '../../infra/prisma.js';

/** The payload shape the bridge receives and turns into XML. */
export interface VoucherPayload {
  kind: 'VOUCHER';
  voucherKind: 'SALES_ORDER' | 'SALES_INVOICE' | 'RECEIPT' | 'CREDIT_NOTE';
  companyName: string;
  voucherTypeName: string;
  remoteId: string;
  voucherNumber: string | null;
  /** `YYYY-MM-DD`. The bridge renders Tally's own `YYYYMMDD`. */
  date: string;
  partyLedgerName: string;
  reference: string | null;
  narration: string | null;
  currency: string;
  currencyExponent: number;
  lines: VoucherPayloadLine[];
  ledgerEntries: VoucherPayloadLedger[];
  isInvoice: boolean;
  /** Everything a person needs to check the quantities by hand. */
  packagingSummary: PackagingSummary | null;
}

export interface VoucherPayloadLine {
  stockItemName: string;
  /** BASE UNITS. See the file header. */
  baseQuantity: number;
  baseUnitName: string;
  alternateUnit: { name: string; quantity: number; factor: number } | null;
  /** Minor units, as strings. Never JS numbers on a money path. */
  amountMinor: string;
  rateMinor: string;
  godownName: string | null;
  batchName: string | null;
  salesLedgerName: string;
  packagingDescription: string | null;
  /** Structured, so a reconciliation can compare figures rather than text. */
  packaging: LinePackaging | null;
}

export interface LinePackaging {
  packageType: PackageType;
  packageQuantity: number;
  unitsPerPackage: number;
  unitsPerCarton: number | null;
  cartonsPerPallet: number | null;
  palletsPerContainer: number | null;
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  totalBaseUnits: number;
}

export interface PackagingSummary {
  totalCartons: number | null;
  totalPallets: number | null;
  totalContainers: number | null;
  totalBaseUnits: number;
  grossWeightGrams: string | null;
  volumeCm3: string | null;
}

export interface VoucherPayloadLedger {
  ledgerName: string;
  isDeemedPositive: boolean;
  /** Minor units, SIGNED as Tally wants: debits positive, credits negative. */
  amountMinor: string;
  costCentreName: string | null;
}

/** A confirmed mapping, keyed for lookup. */
type MappingIndex = Map<string, { tallyName: string; alternateUnitName: string | null; conversionFactor: string | null }>;

async function loadMappings(connectionId: string): Promise<MappingIndex> {
  const rows = await prisma.sellerErpMapping.findMany({
    where: { connectionId, isConfirmed: true },
    select: {
      entity: true,
      localKey: true,
      tallyName: true,
      alternateUnitName: true,
      conversionFactor: true,
    },
  });

  return new Map(
    rows.map((row) => [
      `${row.entity}:${row.localKey}`,
      {
        tallyName: row.tallyName,
        alternateUnitName: row.alternateUnitName,
        // Decimal to STRING, never through Number. This multiplies a quantity.
        conversionFactor: row.conversionFactor === null ? null : String(row.conversionFactor),
      },
    ]),
  );
}

/**
 * A mapping that must exist, or a refusal naming it.
 *
 * Refuses rather than substituting a default, everywhere. There is no safe
 * default for "which ledger does this credit": guessing "Sales" would post a
 * quarter of somebody's revenue into whichever ledger happened to be called
 * that, and the seller would find out at the year end.
 */
function requireMapping(
  mappings: MappingIndex,
  entity: string,
  localKey: string,
  label: string,
): { tallyName: string; alternateUnitName: string | null; conversionFactor: string | null } {
  const found = mappings.get(`${entity}:${localKey}`);

  if (found === undefined) {
    throw conflict(
      ErrorCode.SELLER_ERP_MAPPING_INCOMPLETE,
      `${label} has not been matched to anything in Tally yet.`,
      [{ field: `${entity}.${localKey}`, code: 'MAPPING_MISSING', meta: { entity, localKey } }],
    );
  }

  return found;
}

export type VoucherKind = 'SALES_ORDER' | 'SALES_INVOICE';

/**
 * Build the voucher for one seller's part of one order.
 *
 * Every figure comes off the ORDER, not off the catalogue: the order item's
 * snapshotted unit price, the order item's frozen packaging breakdown, the
 * seller order line's own totals. A seller who re-prices a listing tomorrow
 * does not change what posts for an order placed today, and the voucher is
 * built from exactly the rows the buyer was charged against.
 */
export async function buildOrderVoucher(input: {
  connectionId: string;
  sellerOrderGroupId: string;
  voucherKind: VoucherKind;
}): Promise<VoucherPayload> {
  const connection = await prisma.sellerErpConnection.findUnique({
    where: { id: input.connectionId },
    select: { id: true, companyName: true, sellerAccountId: true, syncPolicy: true },
  });

  if (connection === null || connection.companyName === null) {
    throw conflict(
      ErrorCode.SELLER_ERP_NOT_CONFIGURED,
      'This connection has no Tally company chosen, so nothing can be posted into it.',
    );
  }

  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: input.sellerOrderGroupId },
    include: {
      order: {
        select: {
          id: true,
          orderNumber: true,
          placedAt: true,
          currency: true,
          // The buyer's identity is needed only to find their MAPPED ledger,
          // which is keyed on this id. Their name, company and address are
          // deliberately not selected: the ledger already carries whatever the
          // seller chose to call them in their own books, and pulling a
          // buyer's details into a payload that travels to a third machine
          // would be personal data crossing a boundary for no purpose.
          customerProfileId: true,
        },
      },
      lines: {
        include: {
          offer: { select: { id: true, sellerSku: true } },
        },
      },
    },
  });

  if (group === null) {
    throw conflict(ErrorCode.NOT_FOUND, 'That order group no longer exists.');
  }

  // Tenant isolation at the row, not merely at the route: a connection may
  // only ever build a voucher for its OWN seller's order.
  if (group.sellerAccountId !== connection.sellerAccountId) {
    throw conflict(ErrorCode.RESOURCE_OWNERSHIP_DENIED, 'That order belongs to another seller.');
  }

  const mappings = await loadMappings(input.connectionId);
  const exponent = currencyExponent(group.currency);

  const voucherEntity =
    input.voucherKind === 'SALES_ORDER'
      ? 'SALES_ORDER_VOUCHER_TYPE'
      : 'SALES_INVOICE_VOUCHER_TYPE';

  const voucherType = requireMapping(mappings, voucherEntity, '', 'The voucher type');

  const party = requireMapping(
    mappings,
    'PARTY_LEDGER',
    group.order.customerProfileId,
    'The buyer’s ledger',
  );

  /*
   * The income ledger is required for an INVOICE and not for an ORDER.
   *
   * A Sales Order is a record that an order exists; it credits nothing and
   * recognises no revenue. Demanding an income ledger for one would make a
   * seller who only wants order tracking configure a chart of accounts they
   * are not using - and would quietly imply that placing an order and earning
   * the money are the same event, which is the confusion the sync policy keeps
   * two separate switches to avoid.
   */
  const salesLedger =
    input.voucherKind === 'SALES_INVOICE'
      ? requireMapping(mappings, 'SALES_LEDGER', '', 'The sales ledger').tallyName
      : null;

  // The order items, for the frozen packaging and the snapshotted price.
  const orderItems = await prisma.orderItem.findMany({
    where: { id: { in: group.lines.map((line) => line.orderItemId) } },
    include: { packaging: true },
  });

  const itemById = new Map(orderItems.map((item) => [item.id, item]));

  const godownName =
    group.locationId === null
      ? null
      : (mappings.get(`GODOWN:${group.locationId}`)?.tallyName ?? null);

  const lines: VoucherPayloadLine[] = [];

  let totalCartons = 0;
  let totalPallets = 0;
  let totalContainers = 0;
  let totalBaseUnits = 0;
  let grossWeightGrams = 0n;
  let volumeCm3 = 0n;
  let sawPackaging = false;

  for (const line of group.lines) {
    const item = itemById.get(line.orderItemId);
    if (item === undefined) continue;

    const stockItem = requireMapping(
      mappings,
      'STOCK_ITEM',
      line.offerId,
      `The listing ${line.offer.sellerSku}`,
    );

    const unitMapping = mappings.get(`UNIT:${line.offerId}`);
    // A seller who has not named the stock item's base unit gets Tally's most
    // common one. Safe because it is the NAME of a unit and not a conversion -
    // the quantity is the same number whatever it is called - and the mapping
    // screen offers the real list from their own company.
    const baseUnitName = unitMapping?.tallyName ?? 'Nos';

    const snapshot = item.packaging;

    let packaging: LinePackaging | null = null;
    let packagingDescription: string | null = null;
    let alternateUnit: { name: string; quantity: number; factor: number } | null = null;

    if (snapshot !== null) {
      sawPackaging = true;

      const breakdown = describePackaging({
        packageType: snapshot.packageType,
        packageQuantity: snapshot.packageQuantity,
        unitsPerPackage: snapshot.unitsPerPackage,
        unitsPerCarton: snapshot.unitsPerCarton,
        cartonsPerPallet: snapshot.cartonsPerPallet,
        palletsPerContainer: snapshot.palletsPerContainer,
        cartonsPerContainer: snapshot.cartonsPerContainer,
        grossWeightGrams: snapshot.grossWeightGrams,
        cargoVolumeCm3: snapshot.cargoVolumeCm3,
      });

      packaging = {
        packageType: snapshot.packageType,
        packageQuantity: snapshot.packageQuantity,
        unitsPerPackage: snapshot.unitsPerPackage,
        unitsPerCarton: snapshot.unitsPerCarton,
        cartonsPerPallet: snapshot.cartonsPerPallet,
        palletsPerContainer: snapshot.palletsPerContainer,
        totalCartons: breakdown.totalCartons,
        totalPallets: breakdown.totalPallets,
        totalContainers: breakdown.totalContainers,
        totalBaseUnits: breakdown.totalBaseUnits,
      };

      packagingDescription = describeForNarration(packaging);

      totalCartons += breakdown.totalCartons ?? 0;
      totalPallets += breakdown.totalPallets ?? 0;
      totalContainers += breakdown.totalContainers ?? 0;
      grossWeightGrams += breakdown.grossWeightGrams ?? 0n;
      volumeCm3 += breakdown.volumeCm3 ?? 0n;

      /*
       * The opt-in alternate unit.
       *
       * Used ONLY where the seller has confirmed an ALTERNATE_UNIT mapping for
       * this listing. The factor is checked against the packaging's own
       * figure, and a mismatch REFUSES rather than choosing one: a Tally unit
       * saying 1,000 to a pallet against packaging saying 1,200 would post a
       * quantity that reconciles to neither, and picking either silently makes
       * the seller's stock wrong by 200 a pallet.
       */
      const alternate = mappings.get(`ALTERNATE_UNIT:${line.offerId}`);

      if (
        alternate?.alternateUnitName !== undefined &&
        alternate.alternateUnitName !== null &&
        alternate.conversionFactor !== null
      ) {
        const factor = Number.parseFloat(alternate.conversionFactor);

        if (!Number.isFinite(factor) || factor <= 0) {
          throw conflict(
            ErrorCode.SELLER_ERP_MAPPING_INCOMPLETE,
            `The compound unit mapped for ${line.offer.sellerSku} has no usable conversion factor.`,
            [{ field: `ALTERNATE_UNIT.${line.offerId}`, code: 'FACTOR_INVALID' }],
          );
        }

        if (factor !== snapshot.unitsPerPackage) {
          throw conflict(
            ErrorCode.SELLER_ERP_MAPPING_INCOMPLETE,
            `The Tally unit "${alternate.alternateUnitName}" says ${String(factor)} units to a package, and this order's packaging says ${String(snapshot.unitsPerPackage)}. Correct one of them before this can post.`,
            [
              {
                field: `ALTERNATE_UNIT.${line.offerId}`,
                code: 'FACTOR_MISMATCH',
                meta: { tallyFactor: factor, packagingFactor: snapshot.unitsPerPackage },
              },
            ],
          );
        }

        alternateUnit = {
          name: alternate.alternateUnitName,
          quantity: snapshot.packageQuantity,
          factor,
        };
      }
    }

    // ALWAYS the base-unit count, whatever unit is named beside it. This is
    // the line the file header is about.
    const baseQuantity = line.quantity;
    totalBaseUnits += baseQuantity;

    lines.push({
      stockItemName: stockItem.tallyName,
      baseQuantity,
      baseUnitName,
      alternateUnit,
      amountMinor: line.lineTotalMinor.toString(),
      rateMinor: line.unitPriceMinor.toString(),
      godownName,
      batchName: null,
      // A Sales Order credits nothing, so it carries no income ledger. The
      // field is required by the line shape, and the empty string is what the
      // bridge reads as "no accounting allocation on this line".
      salesLedgerName: salesLedger ?? '',
      packagingDescription,
      packaging,
    });
  }

  const ledgerEntries = buildLedgerEntries({
    voucherKind: input.voucherKind,
    mappings,
    party: party.tallyName,
    salesLedger,
    group,
  });

  const packagingSummary: PackagingSummary | null = sawPackaging
    ? {
        totalCartons: totalCartons > 0 ? totalCartons : null,
        totalPallets: totalPallets > 0 ? totalPallets : null,
        totalContainers: totalContainers > 0 ? totalContainers : null,
        totalBaseUnits,
        grossWeightGrams: grossWeightGrams > 0n ? grossWeightGrams.toString() : null,
        volumeCm3: volumeCm3 > 0n ? volumeCm3.toString() : null,
      }
    : null;

  const includeNarration = connection.syncPolicy?.includePackagingNarration ?? true;

  return {
    kind: 'VOUCHER',
    voucherKind: input.voucherKind,
    companyName: connection.companyName,
    voucherTypeName: voucherType.tallyName,
    /*
     * The duplicate guard on Tally's own side.
     *
     * Deterministic and derived from the same parts as the outbox's
     * idempotency key, so a reply lost AFTER Tally committed cannot produce a
     * second voucher when the job is retried - Tally recognises the REMOTEID
     * and refuses. The third of the three guards described in `job.service.ts`.
     */
    remoteId: `GLOVIA-${input.voucherKind}-${group.id}`,
    voucherNumber: group.sellerOrderNumber,
    date: (group.order.placedAt ?? group.createdAt).toISOString().slice(0, 10),
    partyLedgerName: party.tallyName,
    reference: group.order.orderNumber,
    narration: buildNarration({
      orderNumber: group.order.orderNumber,
      sellerOrderNumber: group.sellerOrderNumber,
      lines,
      includePackaging: includeNarration,
      template: connection.syncPolicy?.narrationTemplate ?? null,
    }),
    currency: group.currency,
    currencyExponent: exponent,
    lines,
    ledgerEntries,
    // A Sales Order is not an invoice in Tally's sense and must not be posted
    // as one: `ISINVOICE=Yes` on an order voucher puts it in the books as a
    // sale, which overstates the seller's turnover by every order later
    // cancelled.
    isInvoice: input.voucherKind === 'SALES_INVOICE',
    packagingSummary,
  };
}

/**
 * The accounting side of the voucher.
 *
 * Tally's sign convention is the opposite of intuition: `isDeemedPositive`
 * means a DEBIT. On a sale the party is debited by the gross and the income,
 * tax and freight ledgers are credited - so the party's amount is positive and
 * the rest are negative, and the whole thing sums to zero.
 *
 * A Sales Order carries no ledger entries at all. It is not an accounting
 * document; it is a record that an order exists, and attaching entries to it
 * would post revenue at the moment somebody placed an order.
 */
function buildLedgerEntries(input: {
  voucherKind: VoucherKind;
  mappings: MappingIndex;
  party: string;
  salesLedger: string | null;
  group: {
    goodsTotalMinor: bigint;
    taxTotalMinor: bigint;
    shippingTotalMinor: bigint;
  };
}): VoucherPayloadLedger[] {
  if (input.voucherKind === 'SALES_ORDER') return [];

  const entries: VoucherPayloadLedger[] = [];

  const gross =
    input.group.goodsTotalMinor + input.group.taxTotalMinor + input.group.shippingTotalMinor;

  entries.push({
    ledgerName: input.party,
    isDeemedPositive: true,
    amountMinor: gross.toString(),
    costCentreName: null,
  });

  if (input.salesLedger !== null && input.group.goodsTotalMinor > 0n) {
    entries.push({
      ledgerName: input.salesLedger,
      isDeemedPositive: false,
      amountMinor: (-input.group.goodsTotalMinor).toString(),
      costCentreName: null,
    });
  }

  /*
   * Freight, only where it is mapped AND there is any.
   *
   * Not defaulted to the sales ledger. Folding shipping into revenue
   * overstates turnover and understates cost, which is a real misstatement in
   * somebody's accounts rather than a tidy-up - so an unmapped freight ledger
   * with a non-zero shipping total is a mapping the seller is asked for rather
   * than a figure quietly moved somewhere else.
   */
  if (input.group.shippingTotalMinor > 0n) {
    const freight = requireMapping(input.mappings, 'FREIGHT_LEDGER', '', 'The freight ledger');
    entries.push({
      ledgerName: freight.tallyName,
      isDeemedPositive: false,
      amountMinor: (-input.group.shippingTotalMinor).toString(),
      costCentreName: null,
    });
  }

  /*
   * Tax.
   *
   * Posted to whichever tax ledgers the seller mapped. The split between CGST,
   * SGST and IGST depends on where the buyer is relative to the seller, which
   * this system does not model as an Indian tax question - so the whole tax
   * amount goes to the ledger the seller nominated for this kind of sale, and
   * a seller who needs the three-way split maps them and their accountant
   * splits the voucher. Inventing a split from a country code would be a tax
   * determination this software is not qualified to make.
   */
  if (input.group.taxTotalMinor > 0n) {
    const taxLedger =
      input.mappings.get('TAX_LEDGER_IGST:') ??
      input.mappings.get('TAX_LEDGER_OTHER:') ??
      input.mappings.get('TAX_LEDGER_CGST:');

    if (taxLedger === undefined) {
      throw conflict(
        ErrorCode.SELLER_ERP_MAPPING_INCOMPLETE,
        'This order carries tax and no tax ledger has been matched to Tally.',
        [{ field: 'TAX_LEDGER_IGST.', code: 'MAPPING_MISSING' }],
      );
    }

    entries.push({
      ledgerName: taxLedger.tallyName,
      isDeemedPositive: false,
      amountMinor: (-input.group.taxTotalMinor).toString(),
      costCentreName: null,
    });
  }

  return entries;
}

/**
 * "2 UK pallets x 50 cartons x 24 units", in English.
 *
 * English on purpose, and it is the one place in this feature where that is
 * right: it is written into a seller's own accounting system, read by their
 * accountant, and printed on their own voucher. It is not a buyer-facing
 * string, so it does not go through the translation catalogues - a narration
 * that changed language because the seller's staff member had a different UI
 * preference would be a voucher whose wording depends on who pressed the
 * button.
 */
function describeForNarration(packaging: LinePackaging): string {
  const noun = packageNoun(packaging.packageType, packaging.packageQuantity);

  const parts = [`${String(packaging.packageQuantity)} ${noun}`];

  if (packaging.packageType !== 'CARTON' && packaging.cartonsPerPallet !== null) {
    parts.push(`${String(packaging.cartonsPerPallet)} cartons`);
  }

  if (packaging.packageType === 'CONTAINER' && packaging.palletsPerContainer !== null) {
    parts.push(`${String(packaging.palletsPerContainer)} pallets`);
  }

  if (packaging.unitsPerCarton !== null) {
    parts.push(`${String(packaging.unitsPerCarton)} units`);
  }

  return `${parts.join(' x ')} = ${packaging.totalBaseUnits.toLocaleString('en-GB')} units`;
}

function packageNoun(packageType: PackageType, quantity: number): string {
  const plural = quantity === 1 ? '' : 's';

  switch (packageType) {
    case 'CARTON':
      return `carton${plural}`;
    case 'UK_PALLET':
      return `UK pallet${plural}`;
    case 'US_PALLET':
      return `US pallet${plural}`;
    case 'CONTAINER':
      return `container${plural}`;
  }
}

/**
 * The voucher's narration.
 *
 * Carries the marketplace order number, the seller's own order number and the
 * packaging. The seller may supply a template with `{{order}}`,
 * `{{sellerOrder}}` and `{{packaging}}` in it; a template is used verbatim
 * apart from those substitutions, because it is going into their books and
 * their wording is the one that matters.
 */
function buildNarration(input: {
  orderNumber: string;
  sellerOrderNumber: string;
  lines: VoucherPayloadLine[];
  includePackaging: boolean;
  template: string | null;
}): string {
  const packagingText = input.includePackaging
    ? input.lines
        .map((line) => line.packagingDescription)
        .filter((text): text is string => text !== null)
        .join('; ')
    : '';

  if (input.template !== null && input.template.trim().length > 0) {
    return input.template
      .replaceAll('{{order}}', input.orderNumber)
      .replaceAll('{{sellerOrder}}', input.sellerOrderNumber)
      .replaceAll('{{packaging}}', packagingText)
      .slice(0, 1000);
  }

  const base = `Glovia order ${input.orderNumber} (seller reference ${input.sellerOrderNumber})`;

  return (packagingText.length === 0 ? base : `${base}. ${packagingText}`).slice(0, 1000);
}
